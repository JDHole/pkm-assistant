/**
 * `modules/models/providers/anthropic.ts` — dostawca `anthropic` (Messages API).
 *
 * Anthropic ma WŁASNY kształt żądania, więc ten plik nie dziedziczy po bazie kształtu
 * OpenAI: instrukcja systemowa jedzie osobnym polem `system`, wywołania narzędzi są
 * blokami `tool_use`/`tool_result` wewnątrz `content`, a strumień to nazwane zdarzenia
 * (`message_start` → `content_block_*` → `message_delta` → `message_stop`).
 *
 * Zakres zachowań: B.7 AN-01..AN-19, B.6 BA-02 (nagłówek klucza), BA-22 (jeden kształt
 * błędu), B.12 (cache promptu).
 *
 * Trzy rzeczy, o które najłatwiej się tu potknąć:
 *  1. **Trzy liczniki wejścia są ROZŁĄCZNE.** `input_tokens` NIE zawiera tokenów cache,
 *     więc kanoniczne `prompt_tokens` to ich suma (AN-09) — inaczej `cached_tokens`
 *     wychodzi większe niż `prompt_tokens` i oszczędność przekracza 100%.
 *  2. **`output_tokens` z `message_start` to placeholder.** Merge go pomija (AN-08),
 *     żeby urwany strumień zostawił prawdziwe zero zamiast fałszywej jedynki.
 *  3. **Budżet myślenia musi być MNIEJSZY niż `max_tokens`** (AN-19) — myślenie liczy się
 *     do tego samego limitu wyjścia, a Anthropic odbija żądanie, które tego nie spełnia.
 *
 * Źródła (publiczna dokumentacja API, wrzesień 2026): `docs.anthropic.com/en/api/messages`,
 * `/api/messages-streaming`, `/docs/build-with-claude/prompt-caching`,
 * `/docs/build-with-claude/extended-thinking`, `/api/models-list`, `/api/versioning`.
 */
import { normalizeError } from '../../../core/index.js';
import { MODEL_MAX_TOKENS_DEFAULTS } from '../cache_utils.js';
import { TOOL_CALL_MAX_INDEX } from '../contracts.js';
import type {
    ChatProvider,
    ChatProviderInfo,
    ChatRequest,
    ChatTool,
    ChatToolChoice,
    HttpClient,
    HttpRequestSpec,
    ModelInfo,
    OpenAiCompletion,
    OpenAiContentBlock,
    OpenAiRequestMessage,
    OpenAiToolCall,
    ProviderContext,
    StreamDecoder,
    StreamEvent,
    UsageLike,
} from '../contracts.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Stałe protokołu (FAKT-API — nie nasze do zmiany)
// ═══════════════════════════════════════════════════════════════════════════════

/** Wersja API w nagłówku `anthropic-version` — Anthropic wymaga jej przy każdym żądaniu. */
const API_VERSION = '2023-06-01';

/** Bez tego nagłówka przeglądarkowy `fetch` z `app://obsidian.md` dostaje odmowę CORS. */
const BROWSER_ACCESS_HEADER = 'anthropic-dangerous-direct-browser-access';

/** AN-19: myślenie przeplecione z narzędziami (sekwencja tekst → `tool_use` → tekst). */
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const MESSAGES_PATH = '/v1/messages';
const MODELS_PATH = '/v1/models';

/** Katalog stronicuje po 20 pozycji — jednym żądaniem bierzemy maksimum dozwolone przez API. */
const MODELS_PAGE_SIZE = 1000;

/** Dolna granica budżetu myślenia narzucona przez API. */
const MIN_THINKING_BUDGET = 1024;

/** AN-03: cztery znaczniki `cache_control` to SUFIT całego żądania, nie wymóg. */
const MAX_CACHE_BREAKPOINTS = 4;

/** Ile ostatnich wiadomości dostaje znacznik cache (reszta sufitu idzie na system i narzędzia). */
const CACHED_TAIL_MESSAGES = 2;

/** Nazwa pola SSE, w którym Anthropic wysyła ładunek zdarzenia. */
const DATA_FIELD = 'data:';

/**
 * Sufit ogona bez końca wiersza (1 MiB). Zepsute proxy potrafi lać treść, która nigdy nie
 * dopnie się do ramki — bufor ma wtedy pójść do kosza, a nie rosnąć przez całą turę.
 */
const MAX_BUFFERED_TAIL = 1024 * 1024;

/** AN-15: dwa bloki tekstu tej samej odpowiedzi skleja pusty wiersz. */
const TEXT_BLOCK_SEPARATOR = '\n\n';

/** Metryczka dostawcy — fakty kontraktowe czytane przez rejestr i Ustawienia. */
const ANTHROPIC_INFO: ChatProviderInfo = {
    id: 'anthropic',
    label: 'Anthropic',
    local: false,
    needsApiKey: true,
    defaultModel: 'claude-sonnet-4-20250514',
    defaultEndpoint: `${DEFAULT_BASE_URL}${MESSAGES_PATH}`,
    modelsEndpoint: `${DEFAULT_BASE_URL}${MODELS_PATH}`,
    apiKeyHeader: 'x-api-key',
    streaming: true,
    streamMode: 'sse',
    supportsTools: true,
    supportsVision: 'per-model',
    supportsReasoning: true,
    // BA-06: `stream_options` to pole kształtu OpenAI — Messages API odbiłoby je jako nieznane.
    streamUsage: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Kształty żądania (prywatne — publiczny jest tylko `ChatProvider`)
// ═══════════════════════════════════════════════════════════════════════════════

interface CacheMark {
    type: 'ephemeral';
}

interface Markable {
    cache_control?: CacheMark;
}

type SentBlock = Markable & Record<string, unknown> & { type: string };

interface SentMessage {
    role: 'user' | 'assistant';
    content: string | SentBlock[];
}

interface SentTool extends Markable {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

interface RequestBody {
    model: string;
    max_tokens: number;
    messages: SentMessage[];
    system?: SentBlock[];
    tools?: SentTool[];
    tool_choice?: { type: string; name?: string };
    temperature?: number;
    thinking?: { type: 'enabled'; budget_tokens: number };
    stream?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pomocniki wspólne dla żądania i odpowiedzi
// ═══════════════════════════════════════════════════════════════════════════════

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Klucz bloku strumienia — bramka zakresu `[0, TOOL_CALL_MAX_INDEX)` opisana w kontrakcie
 * przy zdarzeniu `tool_call`. Brak pola, liczba ujemna, ułamkowa albo powyżej sufitu NIE rzuca
 * i nie otwiera osobnego bytu: wszystko takie adresuje blok zerowy, więc zepsuty dostawca nie
 * jest w stanie ani wywrócić tury, ani napchać pustych slotów.
 */
function blockKey(value: unknown): number {
    const ok = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < TOOL_CALL_MAX_INDEX;
    return ok ? value : 0;
}

/**
 * Adres z kontekstu (host harnessu / proxy) albo produkcyjny.
 *
 * W Ustawieniach użytkownik podaje adres TURY ROZMOWY, a katalog modeli mieszka obok niego —
 * dlatego znana ścieżka jest najpierw odcinana, żeby nie skleić `/v1/messages/v1/models`.
 */
function endpointFor(ctx: ProviderContext, path: string, fallback: string): string {
    const raw = (ctx.endpoint ?? '').trim();
    if (!raw) return fallback;
    let base = raw;
    while (base.endsWith('/')) base = base.slice(0, -1);
    for (const known of [MESSAGES_PATH, MODELS_PATH]) {
        if (base.endsWith(known)) {
            base = base.slice(0, -known.length);
            break;
        }
    }
    return base + path;
}

/** BA-02: klucz idzie WYŁĄCZNIE w `x-api-key`, nigdy w Bearerze i nigdy w URL-u. */
function headersFor(ctx: ProviderContext): Record<string, string> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': API_VERSION,
        [BROWSER_ACCESS_HEADER]: 'true',
    };
    const key = (ctx.apiKey ?? '').trim();
    if (key) headers['x-api-key'] = key;
    return headers;
}

/** Nagłówki tury rozmowy — te same plus beta myślenia przeplecionego (AN-19). */
function messagesHeaders(ctx: ProviderContext): Record<string, string> {
    return { ...headersFor(ctx), 'anthropic-beta': INTERLEAVED_THINKING_BETA };
}

/** AN-04: Messages API WYMAGA `max_tokens` — brak pola to 400 od dostawcy. */
function resolveMaxTokens(req: ChatRequest, ctx: ProviderContext): number {
    const explicit = asCount(req.max_tokens);
    if (explicit !== null && explicit > 0) return Math.floor(explicit);
    const fromContext = asCount(ctx.maxOutputTokens);
    if (fromContext !== null && fromContext > 0) return Math.floor(fromContext);
    return MODEL_MAX_TOKENS_DEFAULTS.anthropic;
}

/**
 * AN-19: budżet myślenia MUSI zmieścić się pod `max_tokens` — myślenie zjada ten sam limit.
 * `true` bierze połowę limitu wyjścia (nie mniej niż minimum API), liczba jedzie wprost,
 * a sufit i tak przycina wynik o jeden token poniżej `max_tokens`.
 */
function resolveThinkingBudget(thinking: ChatRequest['thinking'], maxTokens: number): number | null {
    if (thinking === undefined || thinking === false) return null;
    // Pod dolną granicą API myślenia po prostu NIE DA SIĘ włączyć — lepsza zwykła odpowiedź
    // niż 400 na całą turę.
    if (maxTokens <= MIN_THINKING_BUDGET) return null;
    const requested = typeof thinking === 'number' ? Math.floor(thinking) : Math.floor(maxTokens / 2);
    return Math.min(Math.max(requested, MIN_THINKING_BUDGET), maxTokens - 1);
}

/** Argumenty narzędzia zawsze jako OBIEKT — Anthropic nie przyjmuje stringa w `input`. */
function toolInput(call: OpenAiToolCall): Record<string, unknown> {
    const raw = call.function?.arguments;
    if (raw && typeof raw === 'object') return raw;
    const text = asText(raw).trim();
    if (!text) return {};
    try {
        const parsed: unknown = JSON.parse(text);
        return asRecord(parsed) ?? {};
    } catch {
        // Zepsuty JSON od modelu nie może wywrócić wysyłki — pusty obiekt zamiast wyjątku.
        return {};
    }
}

/** Obraz z kształtu kanonicznego (`image_url`) na blok Anthropica; `null` = nie da się przenieść. */
function imageBlock(block: OpenAiContentBlock): SentBlock | null {
    const url = asText(block.image_url?.url).trim();
    if (!url) return null;
    const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (inline) {
        return { type: 'image', source: { type: 'base64', media_type: inline[1], data: inline[2] } };
    }
    if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
    return null;
}

/** Treść wiadomości (string albo tablica bloków) na bloki Anthropica. */
function contentBlocks(content: OpenAiRequestMessage['content']): SentBlock[] {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) return [];
    const blocks: SentBlock[] = [];
    for (const block of content) {
        if (block?.type === 'image_url') {
            const image = imageBlock(block);
            if (image) blocks.push(image);
            continue;
        }
        const text = asText(block?.text);
        if (text) blocks.push({ type: 'text', text });
    }
    return blocks;
}

/** Zwykły tekst wiadomości — do wariantu, w którym `content` zostaje STRINGIEM (AN-17). */
function plainText(content: OpenAiRequestMessage['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map(block => asText(block?.text))
        .filter(Boolean)
        .join(TEXT_BLOCK_SEPARATOR);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transkrypt kanoniczny → `system` + `messages` Anthropica (AN-02, AN-16, AN-17)
// ═══════════════════════════════════════════════════════════════════════════════

interface Transcript {
    system: SentBlock[];
    messages: SentMessage[];
}

/** Wynik narzędzia wraca do Anthropica jako blok `tool_result` w turze USERA. */
function toolResultBlock(message: OpenAiRequestMessage): SentBlock {
    const text = plainText(message.content);
    return {
        type: 'tool_result',
        tool_use_id: asText(message.tool_call_id),
        content: text || '(brak treści)',
    };
}

/**
 * Assistant: tekst i `tool_use` idą JEDNĄ tablicą `content` (AN-16), przy czym sam tekst
 * zostaje zwykłym stringiem, a same narzędzia — tablicą bez pustego bloku tekstu (AN-17).
 */
function assistantMessage(message: OpenAiRequestMessage): SentMessage | null {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
        const text = plainText(message.content);
        return text ? { role: 'assistant', content: text } : null;
    }
    const blocks = contentBlocks(message.content);
    for (const call of calls) {
        blocks.push({
            type: 'tool_use',
            id: asText(call.id),
            name: asText(call.function?.name),
            input: toolInput(call),
        });
    }
    return blocks.length ? { role: 'assistant', content: blocks } : null;
}

function splitTranscript(messages: OpenAiRequestMessage[]): Transcript {
    const transcript: Transcript = { system: [], messages: [] };
    for (const message of messages ?? []) {
        if (!message) continue;
        const role = message.role;

        if (role === 'system') {
            // AN-02: instrukcja systemowa NIE jest wiadomością — ma własne pole żądania.
            for (const block of contentBlocks(message.content)) {
                if (block.type === 'text') transcript.system.push(block);
            }
            continue;
        }

        if (role === 'tool' || role === 'function') {
            const block = toolResultBlock(message);
            const previous = transcript.messages[transcript.messages.length - 1];
            // Wyniki równoległych narzędzi muszą wejść do JEDNEJ tury usera.
            if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every(b => b.type === 'tool_result')) {
                previous.content.push(block);
            } else {
                transcript.messages.push({ role: 'user', content: [block] });
            }
            continue;
        }

        if (role === 'assistant') {
            const assistant = assistantMessage(message);
            if (assistant) transcript.messages.push(assistant);
            continue;
        }

        const blocks = contentBlocks(message.content);
        if (!blocks.length) continue;
        const onlyText = blocks.length === 1 && blocks[0].type === 'text';
        transcript.messages.push({
            role: 'user',
            content: onlyText ? asText(blocks[0].text) : blocks,
        });
    }
    return transcript;
}

function mapTools(tools: ChatTool[] | undefined): SentTool[] | undefined {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    const mapped = tools
        .filter(tool => Boolean(tool?.function?.name))
        .map<SentTool>(tool => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
        }));
    return mapped.length ? mapped : undefined;
}

function mapToolChoice(choice: ChatToolChoice | undefined): RequestBody['tool_choice'] {
    if (!choice) return undefined;
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    const name = choice.function?.name;
    return name ? { type: 'tool', name } : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cache promptu (AN-03, luka L-22)
// ═══════════════════════════════════════════════════════════════════════════════

function mark(target: Markable | undefined): boolean {
    if (!target) return false;
    target.cache_control = { type: 'ephemeral' };
    return true;
}

/** Ostatni blok wiadomości; treść-string zamieniana na jednoblokową tablicę, żeby dało się ją ostemplować. */
function markableTail(message: SentMessage): Markable | undefined {
    if (typeof message.content === 'string') {
        if (!message.content) return undefined;
        message.content = [{ type: 'text', text: message.content }];
    }
    return message.content[message.content.length - 1];
}

/**
 * AN-03: znaczniki `cache_control` w hierarchii narzędzia → system → wiadomości, SUFIT cztery.
 * Przy pełnym układzie wychodzą dokładnie cztery; przy mniejszej liczbie kandydatów po prostu
 * mniej — brak kandydata nie jest błędem (L-22).
 *
 * Ogon rozmowy stempluje się tylko wtedy, gdy są co najmniej dwie wiadomości: przy jednej nie
 * ma jeszcze prefiksu, który dałoby się odczytać z cache w następnej turze.
 */
function applyCacheControl(body: RequestBody): void {
    let budget = MAX_CACHE_BREAKPOINTS;

    if (body.tools?.length && mark(body.tools[0])) budget -= 1;
    if (body.system?.length && mark(body.system[body.system.length - 1])) budget -= 1;

    if (body.messages.length < 2) return;
    const tail = Math.min(CACHED_TAIL_MESSAGES, budget);
    for (let i = 0; i < tail; i += 1) {
        const message = body.messages[body.messages.length - 1 - i];
        if (!message) break;
        mark(markableTail(message));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Zużycie tokenów (AN-05, AN-07..AN-11)
// ═══════════════════════════════════════════════════════════════════════════════

/** Cztery liczniki Anthropica w jednym miejscu; `output` dokłada dopiero `message_delta`. */
interface TokenCounters {
    input: number;
    cacheCreate: number;
    cacheRead: number;
    output: number;
}

/**
 * AN-09: `prompt_tokens` to SUMA trzech rozłącznych liczników wejścia. Konwencja OpenAI
 * zakłada, że cache jest PODZBIOREM promptu, a u Anthropica `input_tokens` liczy wyłącznie
 * tokeny spoza cache — bez sumowania oszczędność wychodziłaby powyżej 100%.
 */
function canonicalUsage(counters: TokenCounters): UsageLike {
    const prompt = counters.input + counters.cacheCreate + counters.cacheRead;
    return {
        prompt_tokens: prompt,
        completion_tokens: counters.output,
        total_tokens: prompt + counters.output,
        // AN-10: oba liczniki zostają w zwrotce jako detal obok `prompt_tokens_details`.
        cache_creation_input_tokens: counters.cacheCreate,
        cache_read_input_tokens: counters.cacheRead,
        prompt_tokens_details: {
            cached_tokens: counters.cacheRead,
            cache_creation_tokens: counters.cacheCreate,
        },
    };
}

/**
 * Wciąga liczniki z jednego ładunku. `skipOutput` obsługuje AN-08: `output_tokens`
 * z `message_start` jest tylko placeholderem, więc urwany strumień ma zostać z zerem.
 * Zwraca `true`, gdy cokolwiek się zmieniło — wtedy warto wypuścić zdarzenie `usage`.
 */
function absorbUsage(counters: TokenCounters, raw: unknown, skipOutput: boolean): boolean {
    const usage = asRecord(raw);
    if (!usage) return false;
    let touched = false;

    const input = asCount(usage.input_tokens);
    if (input !== null) {
        counters.input = input;
        touched = true;
    }
    const created = asCount(usage.cache_creation_input_tokens);
    if (created !== null) {
        counters.cacheCreate = created;
        touched = true;
    }
    const read = asCount(usage.cache_read_input_tokens);
    if (read !== null) {
        counters.cacheRead = read;
        touched = true;
    }
    if (!skipOutput) {
        const output = asCount(usage.output_tokens);
        if (output !== null) {
            counters.output = output;
            touched = true;
        }
    }
    return touched;
}

/** Powód zakończenia Anthropica na słownik kanoniczny (kształt OpenAI). */
function canonicalFinishReason(stopReason: string | undefined): string {
    switch (stopReason) {
        case 'tool_use':
            return 'tool_calls';
        case 'max_tokens':
            return 'length';
        case 'refusal':
            return 'content_filter';
        case undefined:
        case '':
        case 'end_turn':
        case 'stop_sequence':
            return 'stop';
        default:
            return stopReason;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dekoder strumienia (AN-06..AN-15)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ramki SSE Anthropica → zdarzenia kanoniczne.
 *
 * Bufor ramek trzyma dekoder (kontrakt {@link StreamDecoder}), bo porcja transportu może
 * rozciąć wiersz w połowie. Ogon porcji jest konsumowany dopiero wtedy, gdy jego ładunek
 * daje się sparsować — inaczej czeka na dalszy ciąg.
 *
 * Sloty `tool_calls` numerujemy WŁASNYM licznikiem, a nie indeksem bloku: `tool_use` bywa
 * drugim blokiem po tekście, a kształt kanoniczny nie może mieć dziury w tablicy narzędzi.
 * Sam `index` bloku przechodzi przez bramkę zakresu {@link blockKey}, więc śmieć od proxy
 * adresuje blok zerowy zamiast wywracać turę.
 */
class AnthropicStreamDecoder implements StreamDecoder {
    private buffer = '';
    private readonly counters: TokenCounters = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
    /** indeks bloku Anthropica → slot w kanonicznej tablicy `tool_calls` */
    private readonly slots = new Map<number, number>();
    /** slot → czy przyszedł choć jeden `input_json_delta` */
    private readonly slotHasJson = new Map<number, boolean>();
    private nextSlot = 0;
    private lastTextBlock: number | null = null;
    private stopReason: string | undefined;
    /** ST-11: ile ramek poszło do kosza jako nieczytelne — `ChatModel` z tego robi ostrzeżenie. */
    private dropped = 0;

    get droppedFrames(): number {
        return this.dropped;
    }

    feed(chunk: string): StreamEvent[] {
        return this.drain(chunk, false);
    }

    finish(): StreamEvent[] {
        return this.drain('', true);
    }

    // ── ramki ──────────────────────────────────────────────────────────────────

    /**
     * Porcje transportu → wiersze ramek. Wiersz zakończony `\n` idzie od razu; ogon bez
     * końca wiersza rozstrzyga {@link tailVerdict}: kompletna ramka leci dalej (dostawcy
     * bywają skąpi w znaki końca wiersza), urwana czeka na dalszy ciąg, a śmieć jest
     * wycinany, żeby nie zablokował kolejnych ramek (ST-11).
     */
    private drain(chunk: string, flush: boolean): StreamEvent[] {
        const events: StreamEvent[] = [];
        this.buffer += chunk;

        for (;;) {
            const newline = this.buffer.indexOf('\n');
            if (newline !== -1) {
                const line = this.buffer.slice(0, newline);
                this.buffer = this.buffer.slice(newline + 1);
                this.consumeLine(line, events);
                continue;
            }
            if (!this.buffer.trim()) {
                this.buffer = '';
                break;
            }

            const verdict = flush ? 'emit' : tailVerdict(this.buffer);
            if (verdict === 'emit') {
                const tail = this.buffer;
                this.buffer = '';
                this.consumeLine(tail, events);
                break;
            }
            if (verdict === 'drop') {
                // Bufor ZAWSZE się skraca (szukamy od pozycji 1), więc pętla ma koniec.
                this.buffer = afterNoise(this.buffer);
                continue;
            }
            // 'wait' — ogon jest początkiem ramki, która jeszcze nie dojechała.
            if (this.buffer.length > MAX_BUFFERED_TAIL) this.buffer = '';
            break;
        }
        return events;
    }

    /** Wiersz ramki → zdarzenia. Niesparsowalna porcja NIE rzuca i NIE kończy strumienia. */
    private consumeLine(line: string, events: StreamEvent[]): void {
        // Wiersze `event:` / `id:` / komentarze pomijamy — routing idzie po polu `type` ładunku.
        const payload = dataPayload(line);
        if (!payload) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            // Ramka `data:` nie do przeczytania — do kosza, ale ze śladem w logu (ST-11).
            this.dropped += 1;
            return;
        }
        this.handleEvent(parsed, events);
    }

    // ── zdarzenia ──────────────────────────────────────────────────────────────

    private handleEvent(payload: unknown, events: StreamEvent[]): void {
        const event = asRecord(payload);
        if (!event) return;

        switch (event.type) {
            case 'message_start': {
                // AN-07: input i oba liczniki cache przychodzą TYLKO tutaj.
                const message = asRecord(event.message);
                if (message && absorbUsage(this.counters, message.usage, true)) {
                    events.push({ type: 'usage', usage: canonicalUsage(this.counters) });
                }
                return;
            }
            case 'content_block_start':
                this.openBlock(event, events);
                return;
            case 'content_block_delta':
                this.applyDelta(event, events);
                return;
            case 'content_block_stop':
                this.closeBlock(event, events);
                return;
            case 'message_delta': {
                const delta = asRecord(event.delta);
                const stop = asText(delta?.stop_reason);
                if (stop) this.stopReason = stop;
                // AN-11: skumulowane `usage` z poziomu głównego NADPISUJE (zera też).
                if (absorbUsage(this.counters, event.usage, false)) {
                    events.push({ type: 'usage', usage: canonicalUsage(this.counters) });
                }
                return;
            }
            case 'message_stop':
                events.push({ type: 'done', finishReason: canonicalFinishReason(this.stopReason) });
                return;
            case 'error':
                events.push({ type: 'error', error: normalizeError(event.error ?? event) });
                return;
            default:
                // `ping` i wszystko, czego jeszcze nie znamy — cisza, strumień jedzie dalej.
                return;
        }
    }

    private openBlock(event: Record<string, unknown>, events: StreamEvent[]): void {
        const index = blockKey(event.index);
        const block = asRecord(event.content_block);
        if (!block) return;

        if (block.type === 'tool_use') {
            const slot = this.slotFor(index);
            events.push({ type: 'tool_call', index: slot, id: asText(block.id), name: asText(block.name) });
            return;
        }
        if (block.type === 'text') {
            const text = asText(block.text);
            if (text) this.pushText(index, text, events);
            return;
        }
        if (block.type === 'thinking') {
            const thinking = asText(block.thinking);
            if (thinking) events.push({ type: 'reasoning', delta: thinking });
        }
    }

    private applyDelta(event: Record<string, unknown>, events: StreamEvent[]): void {
        const index = blockKey(event.index);
        const delta = asRecord(event.delta);
        if (!delta) return;

        if (delta.type === 'text_delta') {
            const text = asText(delta.text);
            if (text) this.pushText(index, text, events);
            return;
        }
        if (delta.type === 'thinking_delta') {
            const thinking = asText(delta.thinking);
            if (thinking) events.push({ type: 'reasoning', delta: thinking });
            return;
        }
        if (delta.type === 'input_json_delta') {
            // AN-14: przeplecione delty dwóch narzędzi trafiają każda do SWOJEGO slotu.
            const partial = asText(delta.partial_json);
            if (!partial) return;
            const slot = this.slotFor(index);
            this.slotHasJson.set(slot, true);
            events.push({ type: 'tool_call', index: slot, argumentsDelta: partial });
        }
        // `signature_delta` podpisuje blok myślenia — dla kształtu kanonicznego bez znaczenia.
    }

    private closeBlock(event: Record<string, unknown>, events: StreamEvent[]): void {
        const index = blockKey(event.index);
        const slot = this.slots.get(index);
        if (slot === undefined || this.slotHasJson.get(slot)) return;
        // AN-13: narzędzie bezargumentowe domyka się PUSTYM obiektem, nie cudzymi argumentami.
        this.slotHasJson.set(slot, true);
        events.push({ type: 'tool_call', index: slot, argumentsDelta: '{}' });
    }

    /**
     * Blok Anthropica → slot kanonicznej tablicy `tool_calls`. Numeracja jest WŁASNA i gęsta,
     * bo `tool_use` bywa drugim blokiem po tekście, a tablica narzędzi nie może mieć dziury.
     * Powyżej sufitu zakresu numeracja stoi na ostatnim dopuszczalnym slocie — kształt
     * kanoniczny i tak nie unosi wyższych indeksów.
     */
    private slotFor(blockKeyValue: number): number {
        const known = this.slots.get(blockKeyValue);
        if (known !== undefined) return known;
        const slot = Math.min(this.nextSlot, TOOL_CALL_MAX_INDEX - 1);
        this.nextSlot = slot + 1;
        this.slots.set(blockKeyValue, slot);
        if (!this.slotHasJson.has(slot)) this.slotHasJson.set(slot, false);
        return slot;
    }

    /** AN-15: nowy blok tekstu po innym bloku tekstu dostaje separator, żeby zdania się nie zlepiły. */
    private pushText(blockIndex: number, text: string, events: StreamEvent[]): void {
        if (this.lastTextBlock !== null && this.lastTextBlock !== blockIndex) {
            events.push({ type: 'text', delta: TEXT_BLOCK_SEPARATOR });
        }
        this.lastTextBlock = blockIndex;
        events.push({ type: 'text', delta: text });
    }
}

/** Ładunek wiersza `data:` (przycięty) albo `null`, gdy to nie jest wiersz danych. */
function dataPayload(line: string): string | null {
    const trimmed = line.trim();
    return trimmed.startsWith(DATA_FIELD) ? trimmed.slice(DATA_FIELD.length).trim() : null;
}

/**
 * Co zrobić z ogonem porcji, który nie ma jeszcze końca wiersza.
 *
 *  • `emit` — kompletna ramka `data: {…}`; dostawcy potrafią przysłać ją bez `
`.
 *  • `wait` — początek wiersza `data:` (rozcięty w prefiksie albo w środku JSON-a).
 *  • `drop` — cokolwiek innego: wiersz spoza `data:`, ładunek nie-obiektowy (`[DONE]`
 *    dokładany przez proxy), HTML błędu. Czekanie na to nigdy się nie skończy.
 */
function tailVerdict(tail: string): 'emit' | 'wait' | 'drop' {
    const payload = dataPayload(tail);
    if (payload === null) return DATA_FIELD.startsWith(tail.trim()) ? 'wait' : 'drop';
    if (!payload) return 'wait';
    if (!payload.startsWith('{')) return 'drop';
    try {
        JSON.parse(payload);
        return 'emit';
    } catch {
        return 'wait';
    }
}

/** Bufor obcięty do NASTĘPNEGO `data:`; brak takiego = do kosza. Zawsze krótszy niż wejście. */
function afterNoise(buffer: string): string {
    const next = buffer.indexOf(DATA_FIELD, 1);
    return next < 0 ? '' : buffer.slice(next);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Odpowiedź bez strumienia (AN-05, BA-22)
// ═══════════════════════════════════════════════════════════════════════════════

interface ParsedContent {
    text: string;
    reasoning: string;
    toolCalls: OpenAiToolCall[];
}

function readContentBlocks(raw: unknown): ParsedContent {
    const parsed: ParsedContent = { text: '', reasoning: '', toolCalls: [] };
    if (!Array.isArray(raw)) return parsed;

    const texts: string[] = [];
    const thoughts: string[] = [];
    for (const entry of raw) {
        const block = asRecord(entry);
        if (!block) continue;
        if (block.type === 'text') {
            const text = asText(block.text);
            if (text) texts.push(text);
        } else if (block.type === 'thinking') {
            const thinking = asText(block.thinking);
            if (thinking) thoughts.push(thinking);
        } else if (block.type === 'tool_use') {
            parsed.toolCalls.push({
                id: asText(block.id),
                type: 'function',
                function: {
                    name: asText(block.name),
                    // Kształt kanoniczny trzyma argumenty STRINGIEM (BA-13).
                    arguments: JSON.stringify(asRecord(block.input) ?? {}),
                },
            });
        }
    }
    parsed.text = texts.join(TEXT_BLOCK_SEPARATOR);
    parsed.reasoning = thoughts.join(TEXT_BLOCK_SEPARATOR);
    return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lista modeli (AN-18, B.5 ST-21)
// ═══════════════════════════════════════════════════════════════════════════════

function toModelInfo(entry: unknown): ModelInfo | null {
    const model = asRecord(entry);
    const id = asText(model?.id);
    if (!model || !id) return null;

    const info: ModelInfo = { id, name: asText(model.display_name) || id };
    // Metadana rozstrzygająca vision (VC-02) — bierzemy ją z katalogu, nie zgadujemy z nazwy.
    const capabilities = asRecord(model.capabilities);
    const imageInput = asRecord(capabilities?.image_input);
    if (typeof imageInput?.supported === 'boolean') info.multimodal = imageInput.supported;

    const maxOutput = asCount(model.max_tokens);
    if (maxOutput !== null && maxOutput > 0) info.max_output_tokens = maxOutput;
    const maxInput = asCount(model.max_input_tokens);
    if (maxInput !== null && maxInput > 0) info.max_input_tokens = maxInput;
    return info;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dostawca
// ═══════════════════════════════════════════════════════════════════════════════

export class AnthropicProvider implements ChatProvider {
    get info(): ChatProviderInfo {
        return ANTHROPIC_INFO;
    }

    /**
     * Katalog modeli z `/v1/models`. Brak sieci, błędny status albo ciało nie-JSON kończą się
     * PUSTĄ listą (ST-21) — nigdy wyjątkiem i nigdy listą zaszytą w kodzie (AN-18).
     */
    async listModels(ctx: ProviderContext, http: HttpClient): Promise<ModelInfo[]> {
        try {
            const response = await http.send({
                url: `${endpointFor(ctx, MODELS_PATH, ANTHROPIC_INFO.modelsEndpoint ?? `${DEFAULT_BASE_URL}${MODELS_PATH}`)}?limit=${MODELS_PAGE_SIZE}`,
                method: 'GET',
                headers: headersFor(ctx),
            });
            if (response.status !== 200) {
                ctx.log.debug('models.list_rejected', { provider: 'anthropic', status: response.status });
                return [];
            }
            const body = asRecord(response.json());
            const data = Array.isArray(body?.data) ? body.data : [];
            return data.map(toModelInfo).filter((model): model is ModelInfo => model !== null);
        } catch (err) {
            // K20: do logu idzie sam komunikat po normalizacji, nigdy opis żądania z kluczem.
            ctx.log.debug('models.list_failed', { provider: 'anthropic', message: normalizeError(err).message });
            return [];
        }
    }

    /** Żądanie kanoniczne → Messages API (AN-02..AN-04, AN-19). `body` jest STRINGIEM JSON. */
    buildRequest(req: ChatRequest, ctx: ProviderContext, stream: boolean): HttpRequestSpec {
        const maxTokens = resolveMaxTokens(req, ctx);
        const transcript = splitTranscript(req.messages ?? []);

        const body: RequestBody = {
            model: req.model ?? ctx.modelId,
            max_tokens: maxTokens,
            messages: transcript.messages,
        };
        if (transcript.system.length) body.system = transcript.system;

        const tools = mapTools(req.tools);
        if (tools) body.tools = tools;
        const toolChoice = mapToolChoice(req.tool_choice);
        if (toolChoice) body.tool_choice = toolChoice;

        const budget = resolveThinkingBudget(req.thinking, maxTokens);
        if (budget !== null) {
            body.thinking = { type: 'enabled', budget_tokens: budget };
            // Przy włączonym myśleniu API przyjmuje wyłącznie domyślną temperaturę.
        } else {
            const temperature = asCount(req.temperature ?? ctx.temperature);
            if (temperature !== null) body.temperature = temperature;
        }

        if (stream) body.stream = true;
        applyCacheControl(body);

        return {
            url: endpointFor(ctx, MESSAGES_PATH, ANTHROPIC_INFO.defaultEndpoint),
            method: 'POST',
            headers: messagesHeaders(ctx),
            body: JSON.stringify(body),
        };
    }

    /** Odpowiedź Messages API → kształt kanoniczny. Ładunek z polem `error` NIE rzuca (BA-22). */
    parseCompletion(body: unknown, _req: ChatRequest, ctx: ProviderContext): OpenAiCompletion {
        const raw = asRecord(body);
        const completion: OpenAiCompletion = {
            id: asText(raw?.id) || undefined,
            object: 'chat.completion',
            model: asText(raw?.model) || ctx.modelId,
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }],
            usage: {},
        };

        if (!raw) return completion;
        if (raw.error) {
            completion.error = normalizeError(raw.error);
            return completion;
        }

        const content = readContentBlocks(raw.content);
        const message = completion.choices[0].message;
        message.content = content.text;
        if (content.reasoning) message.reasoning_content = content.reasoning;
        if (content.toolCalls.length) message.tool_calls = content.toolCalls;
        completion.choices[0].finish_reason = canonicalFinishReason(asText(raw.stop_reason) || undefined);

        // Tor bez strumienia oddaje `output_tokens` finalne, więc tu NIE pomijamy go jak w AN-08.
        // BA-08: bez danych `usage` zostaje PUSTYM obiektem — sygnał dla pętli „estymuj".
        const counters: TokenCounters = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
        if (absorbUsage(counters, raw.usage, false)) completion.usage = canonicalUsage(counters);
        return completion;
    }

    /** Świeży dekoder na JEDNĄ turę — stan bloków i liczników nie przechodzi między turami. */
    createStreamDecoder(_req: ChatRequest, _ctx: ProviderContext): StreamDecoder {
        return new AnthropicStreamDecoder();
    }
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const anthropicProvider = new AnthropicProvider();
