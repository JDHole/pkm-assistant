/**
 * `modules/models/providers/gemini.ts` — dostawca `gemini` (WŁASNY kształt żądania).
 *
 * Gemini nie należy do rodziny OpenAI: ma własne role (`user`/`model`), własne części
 * treści (`text` / `inline_data` / `functionCall`), własny licznik zużycia
 * (`usageMetadata`) i własny sposób oznaczania myślenia (`thought: true` na części).
 * Ten plik tłumaczy W OBIE STRONY: kształt kanoniczny → `generateContent` i z powrotem.
 *
 * Trzy rzeczy, które w tym dostawcy zaskakują najczęściej:
 *  1. **Nie ma roli `system`.** Wszystkie wiadomości systemowe są zlepiane i wchodzą jako
 *     PIERWSZA tura `user` (GG-05/GG-06).
 *  2. **Strumień to strumień OBIEKTÓW JSON, nie linie SSE.** Porcje przychodzą jako
 *     `[{…}`, `,{…}`, `,{…}]` (a przez proxy bywa i prefiks `data: `). Rozcinaniem zajmuje
 *     się {@link JsonObjectScanner}, który pamięta ogon między porcjami (GG-18/GG-23/GG-24).
 *  3. **Koniec strumienia rozpoznaje się STRUKTURALNIE.** Liczy się WYPARSOWANE pole
 *     `finishReason` na kandydacie z OSTATNIEGO obiektu porcji — nigdy podciąg w tekście,
 *     bo model potrafi o tym polu po prostu opowiadać (GG-22/GG-24).
 *
 * Nagłówek klucza: `x-goog-api-key` (GG-02). Budżet myślenia:
 * `generationConfig.thinkingConfig.thinkingBudget` (GG-09).
 */
import { normalizeError } from '../../../core/index.js';
import { GEMINI_DEFAULT_THINKING_BUDGET } from '../contracts.js';
import type {
    ChatProvider,
    ChatProviderInfo,
    ChatRequest,
    ChatTool,
    HttpClient,
    HttpRequestSpec,
    ModelInfo,
    OpenAiCompletion,
    OpenAiCompletionChoice,
    OpenAiContent,
    OpenAiRequestMessage,
    OpenAiResponseTransformedMessage,
    OpenAiToolCall,
    ProviderContext,
    StreamDecoder,
    StreamEvent,
    UsageLike,
} from '../contracts.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Stałe protokołu
// ═══════════════════════════════════════════════════════════════════════════════

/** Adres bazowy publicznego API (bez ukośnika na końcu). */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Nazwa nagłówka klucza API — Gemini nie używa `Authorization: Bearer` (GG-02). */
const API_KEY_HEADER = 'x-goog-api-key';

/** Model brany, gdy nikt nie wskazał innego (parytet z `DEFAULT_MODELS`). */
const DEFAULT_MODEL = 'gemini-1.5-pro';

/**
 * Słownik powodów zakończenia (GG-14). Powód spoza słownika NIE jest gubiony —
 * przechodzi zmałymi literami.
 */
const FINISH_REASON_MAP: Readonly<Record<string, string>> = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
};

/** Skrócona forma MIME, której serwer Gemini nie przyjmuje (GG-07). */
const MIME_ALIASES: Readonly<Record<string, string>> = {
    'image/jpg': 'image/jpeg',
};

/** Alfabet ogona lokalnie generowanego identyfikatora wywołania — patrz {@link freshCallId}. */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// ═══════════════════════════════════════════════════════════════════════════════
// Drobne strażniki typu (serwer bywa kapryśny — nic nie zakładamy w ciemno)
// ═══════════════════════════════════════════════════════════════════════════════

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Żądanie: kształt kanoniczny → Gemini
// ═══════════════════════════════════════════════════════════════════════════════

/** Jedna część treści w żądaniu — Gemini przyjmuje formy `snake_case` (GG-03/GG-07). */
type RequestPart =
    | { text: string }
    | { inline_data: { mime_type: string; data: string } }
    | { functionCall: { name: string; args: Json } }
    | { functionResponse: { name: string; response: Json } };

/** Jedna tura rozmowy. */
interface RequestTurn {
    role: string;
    parts: RequestPart[];
}

/**
 * Mapowanie ról (GG-04): `assistant` i `function` stają się `model`, `user` zostaje,
 * a rola nieznana Gemini (np. `tool`) przechodzi BEZ ZMIAN — świadomie, żeby nie zgubić
 * informacji o pochodzeniu tury.
 */
function toGeminiRole(role: string): string {
    return role === 'assistant' || role === 'function' ? 'model' : role;
}

/** Płaski tekst z treści wiadomości — bloki nietekstowe pomijane. */
function flattenText(content: OpenAiContent | undefined): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map(block => (typeof block?.text === 'string' ? block.text : ''))
        .filter(Boolean)
        .join('\n');
}

/** `image/jpg` → `image/jpeg`; reszta bez zmian (GG-07). */
function canonicalMime(mime: string): string {
    return MIME_ALIASES[mime] ?? mime;
}

/**
 * `data:<mime>;base64,<ładunek>` → część `inline_data`. Adres zdalny zwraca `undefined`:
 * Gemini nie pobiera obrazków po URL-u w tym polu, więc lepiej blok pominąć niż wysłać
 * żądanie, które serwer odbije.
 */
function toInlineData(url: string): RequestPart | undefined {
    const match = /^data:([^;,]+)(?:;[^,]*)?,([\s\S]*)$/.exec(url);
    if (!match) return undefined;
    return { inline_data: { mime_type: canonicalMime(match[1]), data: match[2] } };
}

/** Argumenty wywołania narzędzia z transkryptu — string JSON albo gotowy obiekt. */
function toArgsObject(raw: string | Json | undefined): Json {
    if (typeof raw === 'object' && raw !== null) return raw;
    if (typeof raw !== 'string' || raw.trim() === '') return {};
    try {
        return asObject(JSON.parse(raw)) ?? {};
    } catch {
        return {};
    }
}

/** Części jednej wiadomości: tekst, obrazy, a dla asystenta także jego własne wywołania. */
function partsOfMessage(message: OpenAiRequestMessage): RequestPart[] {
    const name = asText(message.name);
    if ((message.role === 'tool' || message.role === 'function') && name) {
        return [{ functionResponse: { name, response: { result: flattenText(message.content) } } }];
    }

    const parts: RequestPart[] = [];
    const content = message.content;
    if (typeof content === 'string') {
        if (content !== '') parts.push({ text: content });
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (!block) continue;
            const imageUrl = asText(block.image_url?.url);
            if (imageUrl) {
                const inline = toInlineData(imageUrl);
                if (inline) parts.push(inline);
                continue;
            }
            if (typeof block.text === 'string' && block.text !== '') parts.push({ text: block.text });
        }
    }

    for (const call of message.tool_calls ?? []) {
        parts.push({
            functionCall: {
                name: call.function?.name ?? '',
                args: toArgsObject(call.function?.arguments),
            },
        });
    }
    return parts;
}

/**
 * Wiadomości `system` → jedna, pierwsza tura `user` (GG-05). Kolejność źródłowa zachowana,
 * sklejenie po `\n`, ogonowe znaki nowej linii przycięte. Brak systemów nie dokłada pustej
 * tury (GG-06).
 */
function buildTurns(messages: OpenAiRequestMessage[]): RequestTurn[] {
    const systemChunks: string[] = [];
    const turns: RequestTurn[] = [];

    for (const message of messages) {
        if (message.role === 'system') {
            const text = flattenText(message.content);
            if (text !== '') systemChunks.push(text);
            continue;
        }
        const parts = partsOfMessage(message);
        if (parts.length === 0) continue;
        turns.push({ role: toGeminiRole(message.role), parts });
    }

    if (systemChunks.length > 0) {
        turns.unshift({ role: 'user', parts: [{ text: systemChunks.join('\n').replace(/\n+$/, '') }] });
    }
    return turns;
}

/** `ChatTool` → `function_declarations[]` (GG-03). Pola puste nie są dokładane. */
function toDeclaration(tool: ChatTool): Json {
    const declaration: Json = { name: tool.function.name };
    if (typeof tool.function.description === 'string') declaration.description = tool.function.description;
    if (tool.function.parameters) declaration.parameters = tool.function.parameters;
    return declaration;
}

/**
 * Budżet myślenia (GG-09): `true` → domyślny, liczba jedzie wprost, brak pola → BRAK
 * `thinkingConfig` w ogóle.
 */
function thinkingBudgetOf(thinking: ChatRequest['thinking']): number | undefined {
    if (typeof thinking === 'number') return thinking;
    return thinking === true ? GEMINI_DEFAULT_THINKING_BUDGET : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Odpowiedź: Gemini → kształt kanoniczny
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Identyfikator wywołania narzędzia wytworzony lokalnie, gdy Gemini go nie podał (GG-13).
 * Pętla narzędzi paruje po nim wynik, więc MUSI być niepusty — stąd własny alfabet zamiast
 * `Math.random().toString(36)`, który przy losie równym zeru oddaje pusty ogon.
 */
function freshCallId(): string {
    let tail = '';
    for (let i = 0; i < 8; i += 1) {
        tail += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    return `call_${Date.now()}_${tail}`;
}

/** `finishReason` → `finish_reason` kształtu kanonicznego (GG-14); brak pola → `null`. */
function toFinishReason(raw: unknown): string | null {
    const reason = asText(raw);
    if (!reason) return null;
    return FINISH_REASON_MAP[reason] ?? reason.toLowerCase();
}

/** Pierwszy kandydat niosący `finishReason`; `null`, gdy żaden go nie ma. */
function finishReasonOfPayload(payload: Json): string | null {
    for (const raw of asArray(payload.candidates)) {
        const reason = toFinishReason(asObject(raw)?.finishReason);
        if (reason !== null) return reason;
    }
    return null;
}

/**
 * `usageMetadata` → liczniki kształtu kanonicznego (GG-15). BRAK metadanych daje trzy
 * `null` (nie zera i nie `undefined`) — pętla odróżnia „nie wiem" od „zero".
 */
function toUsage(raw: unknown): UsageLike {
    const meta = asObject(raw);
    return {
        prompt_tokens: asCount(meta?.promptTokenCount),
        completion_tokens: asCount(meta?.candidatesTokenCount),
        total_tokens: asCount(meta?.totalTokenCount),
    };
}

/** `functionCall` → wywołanie kanoniczne; `arguments` ZAWSZE stringiem (GG-12). */
function toToolCall(call: Json): OpenAiToolCall {
    return {
        id: asText(call.id) || freshCallId(),
        type: 'function',
        function: {
            name: asText(call.name) ?? '',
            arguments: JSON.stringify(asObject(call.args) ?? {}),
        },
    };
}

/** Pusta wiadomość asystenta — jedyna sensowna odpowiedź, gdy kandydata nie ma (GG-16/GG-25). */
function emptyChoice(finishReason: string | null): OpenAiCompletionChoice {
    return { index: 0, message: { role: 'assistant', content: '' }, finish_reason: finishReason };
}

/**
 * Rozdział części kandydata: `thought: true` idzie do myślenia, reszta do widocznej treści
 * (GG-11), a `functionCall` do wywołań narzędzi.
 */
function splitParts(parts: unknown[]): { text: string; reasoning: string; calls: OpenAiToolCall[] } {
    let text = '';
    let reasoning = '';
    const calls: OpenAiToolCall[] = [];

    for (const raw of parts) {
        const part = asObject(raw);
        if (!part) continue;

        const call = asObject(part.functionCall);
        if (call) {
            calls.push(toToolCall(call));
            continue;
        }

        const chunk = asText(part.text);
        if (!chunk) continue;
        if (part.thought === true) reasoning += chunk;
        else text += chunk;
    }
    return { text, reasoning, calls };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Strumień: skaner obiektów JSON
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wyciąga KOMPLETNE obiekty JSON ze strumienia, pamiętając ogon między porcjami.
 *
 * Dlaczego własny skaner, a nie parser linii SSE: Gemini oddaje strumień jako tablicę JSON,
 * więc porcje wyglądają jak `[{…}`, `,{…}`, `,{…}]`. Wszystko poza klamrami (`[`, `]`, `,`,
 * białe znaki, a przez proxy także prefiks `data: `) jest szumem strukturalnym i jest
 * pomijane. Obiekt rozcięty w pół zostaje w buforze do następnej porcji, a fragment, którego
 * nie da się sparsować, jest po prostu przeskakiwany — porcja NIGDY nie rzuca (GG-23).
 */
class JsonObjectScanner {
    private buffer = '';
    /** ST-11/GG-23: ile obiektów w kształcie klamry okazało się nie do przeczytania. */
    dropped = 0;

    /** Dokłada porcję i oddaje wszystkie obiekty, które właśnie się domknęły. */
    push(chunk: string): Json[] {
        this.buffer += chunk;
        const found: Json[] = [];
        let cursor = 0;

        while (cursor < this.buffer.length) {
            const start = this.buffer.indexOf('{', cursor);
            if (start === -1) {
                cursor = this.buffer.length;
                break;
            }
            const end = this.findObjectEnd(start);
            if (end === -1) {
                // Obiekt urwany w pół porcji — czeka na resztę.
                cursor = start;
                break;
            }
            const slice = this.buffer.slice(start, end);
            cursor = end;
            try {
                const parsed = asObject(JSON.parse(slice));
                if (parsed) found.push(parsed);
            } catch {
                // Śmieć w kształcie klamry — pomijamy i jedziemy dalej, ze śladem w logu.
                this.dropped += 1;
            }
        }

        this.buffer = this.buffer.slice(cursor);
        return found;
    }

    /** Indeks ZA klamrą domykającą obiekt zaczynający się na `start`, albo `-1`. */
    private findObjectEnd(start: number): number {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < this.buffer.length; i += 1) {
            const char = this.buffer[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') inString = true;
            else if (char === '{') depth += 1;
            else if (char === '}') {
                depth -= 1;
                if (depth === 0) return i + 1;
            }
        }
        return -1;
    }
}

/** Wywołanie narzędzia składane z kolejnych porcji strumienia. */
interface AssembledCall {
    id: string;
    name: string;
    args: Json;
}

/**
 * Doklejenie argumentów z kolejnej porcji: wartości tekstowe SKLEJAJĄ SIĘ, reszta nadpisuje.
 * Tak `{path:'a'}` + `{path:'.md'}` daje `{path:'a.md'}` (GG-20).
 */
function mergeArgs(target: Json, incoming: Json | undefined): void {
    if (!incoming) return;
    for (const [key, value] of Object.entries(incoming)) {
        const previous = target[key];
        target[key] = typeof previous === 'string' && typeof value === 'string' ? previous + value : value;
    }
}

/**
 * Dekoder jednej tury strumienia Gemini.
 *
 * Wywołania narzędzi są SKŁADANE w środku i wypuszczane dopiero na końcu tury (przy
 * `done` albo `finish()`): argumenty przychodzą jako obiekty do scalenia, a kontrakt
 * `StreamEvent` niesie je jako doklejany fragment tekstu — częściowe wypuszczanie
 * dałoby sklejony śmieć zamiast poprawnego JSON-a.
 */
class GeminiStreamDecoder implements StreamDecoder {
    private readonly scanner = new JsonObjectScanner();
    private readonly calls: Array<AssembledCall | undefined> = [];

    get droppedFrames(): number {
        return this.scanner.dropped;
    }

    feed(chunk: string): StreamEvent[] {
        const payloads = this.scanner.push(chunk);
        const events: StreamEvent[] = [];

        for (const payload of payloads) {
            if (payload.error !== undefined && payload.error !== null) {
                events.push({ type: 'error', error: normalizeError(payload.error) });
                continue;
            }

            const candidate = asObject(asArray(payload.candidates)[0]);
            const parts = asArray(asObject(candidate?.content)?.parts);
            let slot = 0;

            for (const raw of parts) {
                const part = asObject(raw);
                if (!part) continue;

                const call = asObject(part.functionCall);
                if (call) {
                    this.absorbCall(slot, call);
                    slot += 1;
                    continue;
                }

                const text = asText(part.text);
                if (!text) continue;
                events.push(part.thought === true ? { type: 'reasoning', delta: text } : { type: 'text', delta: text });
            }

            if (asObject(payload.usageMetadata)) events.push({ type: 'usage', usage: toUsage(payload.usageMetadata) });
        }

        // Koniec czyta OSTATNI obiekt porcji — sentinel w obiekcie wcześniejszym nie kończy
        // tury, bo po nim przyszła jeszcze treść (GG-22/GG-24).
        const last = payloads[payloads.length - 1];
        const finishReason = last ? finishReasonOfPayload(last) : null;
        if (finishReason !== null) {
            events.push(...this.releaseCalls());
            events.push({ type: 'done', finishReason });
        }
        return events;
    }

    finish(): StreamEvent[] {
        return this.releaseCalls();
    }

    /** N-te wywołanie w porcji dokłada się do n-tego składanego wywołania tury. */
    private absorbCall(slot: number, call: Json): void {
        let assembled = this.calls[slot];
        if (!assembled) {
            assembled = { id: asText(call.id) || freshCallId(), name: '', args: {} };
            this.calls[slot] = assembled;
        }
        const name = asText(call.name);
        if (name) assembled.name = name;
        mergeArgs(assembled.args, asObject(call.args));
    }

    /** Wypuszcza złożone wywołania i czyści stan — wołane raz na turę. */
    private releaseCalls(): StreamEvent[] {
        const events: StreamEvent[] = [];
        for (let index = 0; index < this.calls.length; index += 1) {
            const call = this.calls[index];
            if (!call) continue;
            events.push({
                type: 'tool_call',
                index,
                id: call.id,
                name: call.name,
                argumentsDelta: JSON.stringify(call.args),
            });
        }
        this.calls.length = 0;
        return events;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dostawca
// ═══════════════════════════════════════════════════════════════════════════════

/** Metryczka dostawcy — fakty kontraktowe, na których stoi rejestr i Ustawienia. */
const GEMINI_INFO: ChatProviderInfo = {
    id: 'gemini',
    label: 'Google Gemini',
    local: false,
    needsApiKey: true,
    defaultModel: DEFAULT_MODEL,
    defaultEndpoint: DEFAULT_BASE_URL,
    modelsEndpoint: `${DEFAULT_BASE_URL}/models`,
    apiKeyHeader: API_KEY_HEADER,
    streaming: true,
    streamMode: 'sse',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    // Gemini ma własny kształt żądania — `stream_options` z rodziny OpenAI go nie dotyczy.
    streamUsage: false,
};

/** Dostawca Google Gemini: `generateContent` / `streamGenerateContent?alt=sse`. */
export class GeminiProvider implements ChatProvider {
    get info(): ChatProviderInfo {
        return GEMINI_INFO;
    }

    /**
     * Lista modeli do dropdownu Ustawień. Zostają tylko te, które umieją `generateContent` —
     * reszta (embeddingi, wersjonowanie) zaśmiecałaby listę. Brak sieci albo odpowiedź nie
     * do odczytania → PUSTA lista, nigdy wyjątek.
     */
    async listModels(ctx: ProviderContext, http: HttpClient): Promise<ModelInfo[]> {
        try {
            const response = await http.send({
                url: `${this.baseUrl(ctx)}/models?pageSize=1000`,
                method: 'GET',
                headers: this.headers(ctx),
            });
            if (response.status < 200 || response.status >= 300) return [];

            const payload = asObject(response.json());
            const models: ModelInfo[] = [];
            for (const raw of asArray(payload?.models)) {
                const entry = asObject(raw);
                const name = asText(entry?.name);
                if (!entry || !name) continue;

                const methods = asArray(entry.supportedGenerationMethods);
                if (methods.length > 0 && !methods.includes('generateContent')) continue;

                const info: ModelInfo = { id: name.replace(/^models\//, ''), multimodal: true };
                const displayName = asText(entry.displayName);
                if (displayName) info.name = displayName;
                const inputLimit = asCount(entry.inputTokenLimit);
                if (inputLimit !== null) info.max_input_tokens = inputLimit;
                const outputLimit = asCount(entry.outputTokenLimit);
                if (outputLimit !== null) info.max_output_tokens = outputLimit;
                models.push(info);
            }
            return models;
        } catch {
            return [];
        }
    }

    /** Żądanie kanoniczne → opis HTTP `generateContent` (albo strumieniowego wariantu). */
    buildRequest(req: ChatRequest, ctx: ProviderContext, stream: boolean): HttpRequestSpec {
        const generationConfig: Json = {};

        const maxOutputTokens =
            typeof req.max_tokens === 'number' && req.max_tokens > 0 ? req.max_tokens : ctx.maxOutputTokens;
        if (typeof maxOutputTokens === 'number') generationConfig.maxOutputTokens = maxOutputTokens;

        const temperature = typeof req.temperature === 'number' ? req.temperature : ctx.temperature;
        if (typeof temperature === 'number') generationConfig.temperature = temperature;

        const thinkingBudget = thinkingBudgetOf(req.thinking);
        if (thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget };

        const body: Json = {
            contents: buildTurns(req.messages),
            generationConfig,
        };

        if (req.tools && req.tools.length > 0) {
            body.tools = [{ function_declarations: req.tools.map(toDeclaration) }];
            // Świadoma decyzja: nawet `required` schodzi do AUTO — tryb ANY u Gemini psuje
            // zwykłe odpowiedzi tekstowe. `none` nie dokłada `tool_config`, ale deklaracje
            // narzędzi i tak jadą (GG-08).
            if (req.tool_choice !== 'none') {
                body.tool_config = { function_calling_config: { mode: 'AUTO' } };
            }
        }

        const model = (req.model ?? ctx.modelId ?? DEFAULT_MODEL).replace(/^models\//, '');
        const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';

        return {
            url: `${this.baseUrl(ctx)}/models/${model}:${method}`,
            method: 'POST',
            headers: this.headers(ctx),
            body: JSON.stringify(body),
        };
    }

    /** Odpowiedź `generateContent` → kształt kanoniczny. Nie rzuca na żadnym realnym payloadzie. */
    parseCompletion(body: unknown, _req: ChatRequest, _ctx: ProviderContext): OpenAiCompletion {
        const payload = asObject(body) ?? {};
        const usage = toUsage(payload.usageMetadata);

        // Payload z polem `error` (zły klucz, wyczerpany limit) oddaje błąd, zamiast wywracać
        // się na nieistniejącym kandydacie (GG-17).
        if (payload.error !== undefined && payload.error !== null) {
            return { choices: [emptyChoice(null)], usage, error: normalizeError(payload.error) };
        }

        const candidate = asObject(asArray(payload.candidates)[0]);
        // Pusta lista kandydatów = blokada na PROMPCIE (`promptFeedback.blockReason`) —
        // to odpowiedź, nie awaria (GG-25).
        if (!candidate) return { choices: [emptyChoice(null)], usage };

        const finishReason = toFinishReason(candidate.finishReason);
        const content = asObject(candidate.content);
        // Kandydat bez treści (odcięty filtrem) — oddajemy OBIEKT pustej wiadomości (GG-16).
        if (!content) return { choices: [emptyChoice(finishReason)], usage };

        const { text, reasoning, calls } = splitParts(asArray(content.parts));
        const message: OpenAiResponseTransformedMessage = { role: 'assistant', content: text };
        if (reasoning !== '') message.reasoning_content = reasoning;
        if (calls.length > 0) message.tool_calls = calls;

        return { choices: [{ index: 0, message, finish_reason: finishReason }], usage };
    }

    createStreamDecoder(_req: ChatRequest, _ctx: ProviderContext): StreamDecoder {
        return new GeminiStreamDecoder();
    }

    /** Adres bazowy: nadpisanie z kontekstu (harness, proxy) albo publiczne API. */
    private baseUrl(ctx: ProviderContext): string {
        const base = ctx.endpoint && ctx.endpoint.trim() !== '' ? ctx.endpoint : DEFAULT_BASE_URL;
        return base.replace(/\/+$/, '');
    }

    /** Nagłówki żądania — klucz idzie w `x-goog-api-key`, nigdy w URL-u (GG-02). */
    private headers(ctx: ProviderContext): Record<string, string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (ctx.apiKey) headers[API_KEY_HEADER] = ctx.apiKey;
        return headers;
    }
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const geminiProvider = new GeminiProvider();
