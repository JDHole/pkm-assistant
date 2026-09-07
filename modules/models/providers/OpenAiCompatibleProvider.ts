/**
 * `modules/models/providers/OpenAiCompatibleProvider.ts` — wspólna baza dostawców, którzy
 * mówią kształtem czatu OpenAI (`POST …/chat/completions`, `messages[]`, `choices[0]`).
 *
 * Baza robi cztery rzeczy i nic więcej:
 *  • składa opis żądania HTTP (adres, nagłówek klucza, ciało jako STRING JSON),
 *  • tłumaczy odpowiedź bez strumienia na kształt kanoniczny,
 *  • produkuje dekoder JEDNEJ tury strumienia (ramki `data: …` → zdarzenia),
 *  • ściąga listę modeli do rozwijanego pola w Ustawieniach.
 *
 * Baza jest BEZSTANOWA. Cały stan tury żyje w dekoderze, który powstaje na każde
 * wywołanie, więc jedna instancja dostawcy obsługuje dowolnie wiele równoległych tur.
 *
 * Różnice między platformami schodzą do wąskich haków (`chatPath`, `parsesThinkTags`,
 * `decorateBody`, `decorateHeaders`, `acceptsModel`), a nie do kopiowania całej klasy.
 */
import { t } from '../../../core/i18n/index.js';
import { normalizeError } from '../../../core/index.js';
import { isVisionModel } from '../capabilities.js';
import { resolveMaxOutputTokens } from '../cache_utils.js';
import { ReasoningTagFilter } from '../ReasoningTagFilter.js';
import { SSE_DONE_SENTINEL } from '../contracts.js';
import type {
    ChatProvider,
    ChatProviderInfo,
    ChatRequest,
    HttpClient,
    HttpRequestSpec,
    ModelInfo,
    OpenAiCompletion,
    OpenAiCompletionChoice,
    OpenAiContent,
    OpenAiContentBlock,
    OpenAiRequestMessage,
    OpenAiResponseTransformedMessage,
    OpenAiToolCall,
    ProviderContext,
    StreamDecoder,
    StreamEvent,
} from '../contracts.js';

/** Ładunek ramki oznaczającej koniec strumienia (po zdjęciu prefiksu `data:`). */
const DONE_PAYLOAD = '[DONE]';

/**
 * Pola żądania, którymi baza zarządza sama. Wszystko poza tą listą przechodzi z
 * {@link ChatRequest} do ciała bez zmian — dzięki temu pętla agenta może dołożyć pole,
 * którego ta klasa jeszcze nie zna, bez dotykania dostawcy.
 *
 * `agentName` i `thinking` są METADANYMI wołacza, nie polami API: dostawca ma je zużyć
 * albo pominąć, nigdy wysłać.
 */
const MANAGED_REQUEST_FIELDS = new Set([
    'messages',
    'model',
    'max_tokens',
    'temperature',
    'tools',
    'tool_choice',
    'stream',
    'stream_options',
    'agentName',
    'thinking',
]);

/** Lekki kształt bloku treści, jaki widzimy w wiadomości wejściowej. */
type ContentBlock = OpenAiContentBlock;

export abstract class OpenAiCompatibleProvider implements ChatProvider {
    /** Metryczka platformy — fakty kontraktowe (adresy, nagłówki, tryb strumienia). */
    abstract get info(): ChatProviderInfo;

    // ── Haki dla podklas ─────────────────────────────────────────────────────

    /**
     * Ścieżka czatu doklejana do adresu bazowego. Puste = {@link ChatProviderInfo.defaultEndpoint}
     * jest już pełnym adresem (platformy chmurowe). Niepuste = adres pochodzi z hosta
     * z ustawień (platformy lokalne).
     */
    protected get chatPath(): string {
        return '';
    }

    /** Ścieżka listy modeli, gdy adres bazowy bierze się z hosta z ustawień. */
    protected get modelsPath(): string {
        return '';
    }

    /**
     * Czy widoczną treść przepuszczać przez {@link ReasoningTagFilter}. Włączone tam, gdzie
     * modele wpychają rozumowanie w znaczniki `<think>` (LM Studio, Groq, OpenRouter);
     * wyłączone tam, gdzie dostawca ma na to osobne pole.
     */
    protected get parsesThinkTags(): boolean {
        return false;
    }

    /** Dokładanie pól specyficznych dla platformy (klucz cache promptu itp.). */
    protected decorateBody(
        _body: Record<string, unknown>,
        _req: ChatRequest,
        _ctx: ProviderContext,
        _stream: boolean,
    ): void {
        /* domyślnie nic — podklasa dokłada swoje */
    }

    /** Dokładanie nagłówków specyficznych dla platformy. */
    protected decorateHeaders(
        _headers: Record<string, string>,
        _req: ChatRequest,
        _ctx: ProviderContext,
    ): void {
        /* domyślnie nic — podklasa dokłada swoje */
    }

    /** Filtr listy modeli (część platform wystawia obok czatu także inne rodzaje modeli). */
    protected acceptsModel(_entry: Record<string, unknown>): boolean {
        return true;
    }

    // ── Powierzchnia `ChatProvider` ──────────────────────────────────────────

    /**
     * Lista modeli do Ustawień. Brak sieci, błędny status albo śmieć w odpowiedzi oddają
     * PUSTĄ tablicę — rozwijane pole ma się narysować także wtedy, gdy demon jest zgaszony.
     */
    async listModels(ctx: ProviderContext, http: HttpClient): Promise<ModelInfo[]> {
        const url = this.modelsUrl(ctx);
        if (!url || !http) return [];
        try {
            const res = await http.send({ url, method: 'GET', headers: this.buildHeaders({ messages: [] }, ctx) });
            if (res.status < 200 || res.status >= 300) return [];
            return this.parseModelList(res.json());
        } catch {
            return [];
        }
    }

    /** Żądanie → opis HTTP. `body` jest STRINGIEM JSON, nigdy obiektem. */
    buildRequest(req: ChatRequest, ctx: ProviderContext, stream: boolean): HttpRequestSpec {
        return {
            url: this.chatUrl(ctx),
            method: 'POST',
            headers: this.buildHeaders(req, ctx),
            body: JSON.stringify(this.buildBody(req, ctx, stream)),
        };
    }

    /** Odpowiedź bez strumienia → kształt kanoniczny. */
    parseCompletion(body: unknown, _req: ChatRequest, _ctx: ProviderContext): OpenAiCompletion {
        const raw = isRecord(body) ? body : {};
        const out: OpenAiCompletion = {
            choices: [],
            usage: isRecord(raw.usage) ? raw.usage : {},
        };
        if (typeof raw.id === 'string') out.id = raw.id;
        if (typeof raw.object === 'string') out.object = raw.object;
        if (typeof raw.created === 'number') out.created = raw.created;
        if (typeof raw.model === 'string') out.model = raw.model;
        if (raw.error !== undefined && raw.error !== null) out.error = normalizeError(raw.error);

        const choices = Array.isArray(raw.choices) ? raw.choices : [];
        if (choices.length === 0) {
            // Zablokowany prompt albo pusta odpowiedź dostawcy: pusta wiadomość asystenta,
            // nigdy wyjątek — pętla agenta ma dostać kształt, na którym umie stanąć.
            out.choices = [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }];
            return out;
        }
        out.choices = choices.map((choice, index) => this.parseChoice(choice, index));
        return out;
    }

    /** Świeży dekoder na JEDNĄ turę — stan znaczników myślenia jest per tura. */
    createStreamDecoder(_req: ChatRequest, _ctx: ProviderContext): StreamDecoder {
        return new OpenAiShapeDecoder(this.parsesThinkTags);
    }

    // ── Wnętrze ──────────────────────────────────────────────────────────────

    /** Adres bazowy: host z ustawień wygrywa nad adresem z metryczki. */
    protected baseUrl(ctx: ProviderContext): string {
        const override = (ctx.endpoint ?? '').trim();
        return override || this.info.defaultEndpoint;
    }

    /** Pełny adres czatu. */
    protected chatUrl(ctx: ProviderContext): string {
        return joinUrl(this.baseUrl(ctx), this.chatPath);
    }

    /** Pełny adres listy modeli (pusty = platforma jej nie wystawia). */
    protected modelsUrl(ctx: ProviderContext): string {
        if (this.modelsPath) return joinUrl(this.baseUrl(ctx), this.modelsPath);
        return this.info.modelsEndpoint ?? '';
    }

    /** Nagłówki żądania. Klucz idzie pod nazwą z metryczki; brak klucza = brak nagłówka. */
    protected buildHeaders(req: ChatRequest, ctx: ProviderContext): Record<string, string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const key = (ctx.apiKey ?? '').trim();
        if (key) {
            const name = this.info.apiKeyHeader ?? 'Authorization';
            headers[name] = name.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
        }
        this.decorateHeaders(headers, req, ctx);
        return headers;
    }

    /** Ciało żądania jako obiekt (serializację robi {@link buildRequest}). */
    protected buildBody(req: ChatRequest, ctx: ProviderContext, stream: boolean): Record<string, unknown> {
        const modelId = (req.model ?? ctx.modelId ?? '').trim() || this.info.defaultModel;
        const body: Record<string, unknown> = {
            ...passthroughFields(req),
            model: modelId,
            messages: this.prepareMessages(req.messages ?? [], modelId, ctx),
            stream,
            max_tokens: this.resolveMaxTokens(req, ctx, modelId),
        };

        const temperature = req.temperature ?? ctx.temperature;
        if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature;
        if (Array.isArray(req.tools) && req.tools.length > 0) body.tools = req.tools;
        if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;

        // Prośba o rozliczenie tokenów w streamie jest OPT-IN: serwer walidujący nieznane
        // pola odbija żądanie z tym polem błędem 400.
        if (stream && this.info.streamUsage) body.stream_options = { include_usage: true };

        this.decorateBody(body, req, ctx, stream);
        return body;
    }

    /** Limit odpowiedzi: żądanie → kontekst → wyliczenie z platformy i nazwy modelu. */
    protected resolveMaxTokens(req: ChatRequest, ctx: ProviderContext, modelId: string): number {
        const explicit = Number(req.max_tokens);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const fromContext = Number(ctx.maxOutputTokens);
        if (Number.isFinite(fromContext) && fromContext > 0) return fromContext;
        return resolveMaxOutputTokens({ platform: this.info.id, modelId });
    }

    /**
     * Przygotowanie transkryptu przed wysyłką. Jedyna zmiana, jaką robimy, to wycięcie
     * obrazów z wiadomości kierowanych do modelu bez obsługi obrazu — w miejsce obrazu
     * wchodzi komunikat z tłumaczeń, żeby model wiedział, czego nie dostał, a wysyłka
     * nie została zablokowana.
     */
    protected prepareMessages(
        messages: OpenAiRequestMessage[],
        modelId: string,
        ctx: ProviderContext,
    ): OpenAiRequestMessage[] {
        if (!messages.some(hasImageBlock)) return messages;
        if (this.acceptsImages(modelId, ctx)) return messages;

        ctx.log?.warn?.('models.image_stripped', { provider: this.info.id, model: modelId });
        const placeholder = t('model.image_stripped');
        return messages.map(message => {
            if (!hasImageBlock(message)) return message;
            const blocks = message.content as ContentBlock[];
            const onlyImages = blocks.every(isImageBlock);
            if (onlyImages) return { ...message, content: placeholder };
            return {
                ...message,
                content: blocks.map(block => (isImageBlock(block) ? { type: 'text', text: placeholder } : block)),
            };
        });
    }

    /** Czy ten model przyjmie obraz. */
    protected acceptsImages(modelId: string, ctx: ProviderContext): boolean {
        if (this.info.supportsVision === true) return true;
        if (this.info.supportsVision === false) return false;
        return isVisionModel({ modelId, modelKey: modelId, models: ctx.models });
    }

    /** Jedna alternatywa odpowiedzi → kształt kanoniczny. */
    protected parseChoice(choice: unknown, index: number): OpenAiCompletionChoice {
        const raw = isRecord(choice) ? choice : {};
        const rawMessage = isRecord(raw.message) ? raw.message : {};
        const content: OpenAiContent = typeof rawMessage.content === 'string'
            ? rawMessage.content
            : Array.isArray(rawMessage.content)
                ? (rawMessage.content as ContentBlock[])
                : '';
        const message: OpenAiResponseTransformedMessage = {
            role: typeof rawMessage.role === 'string' ? rawMessage.role : 'assistant',
            content,
        };

        const nativeReasoning = firstString(rawMessage.reasoning_content, rawMessage.reasoning);
        if (nativeReasoning) {
            message.reasoning_content = nativeReasoning;
        } else if (this.parsesThinkTags && typeof message.content === 'string') {
            const split = ReasoningTagFilter.apply(message.content);
            message.content = split.content;
            if (split.reasoning_content) message.reasoning_content = split.reasoning_content;
        }

        const toolCalls = Array.isArray(rawMessage.tool_calls) ? rawMessage.tool_calls : [];
        if (toolCalls.length > 0) message.tool_calls = toolCalls.map(normalizeToolCall);

        const out: OpenAiCompletionChoice = {
            index: typeof raw.index === 'number' ? raw.index : index,
            message,
        };
        if (raw.finish_reason !== undefined) out.finish_reason = raw.finish_reason as string | null;
        return out;
    }

    /** Lista modeli z odpowiedzi `/models` (albo z gołej tablicy, gdy serwer ją tak podaje). */
    protected parseModelList(body: unknown): ModelInfo[] {
        const rows = Array.isArray(body)
            ? body
            : isRecord(body) && Array.isArray(body.data)
                ? body.data
                : [];
        const out: ModelInfo[] = [];
        for (const row of rows) {
            if (!isRecord(row)) continue;
            const id = typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : '';
            if (!id || !this.acceptsModel(row)) continue;
            out.push({ ...row, id });
        }
        return out;
    }
}

/**
 * Dekoder jednej tury strumienia kształtu OpenAI.
 *
 * Ramki przychodzą jako `data: <JSON>`, ale sieć nie gwarantuje, że porcja transportu
 * kończy się na granicy ramki. Dlatego dekoder buforuje ogon porcji: wypuszcza go od razu,
 * gdy sam w sobie jest kompletną ramką, a w przeciwnym razie czeka na resztę bajtów.
 * Ramka niesparsowalna nie rzuca i nie kończy strumienia.
 */
class OpenAiShapeDecoder implements StreamDecoder {
    private buffer = '';
    private finishReason: string | undefined;
    /** ST-11: ile ramek poszło do kosza jako nieczytelne — `ChatModel` z tego robi ostrzeżenie. */
    private dropped = 0;
    private readonly filter: ReasoningTagFilter | null;

    constructor(parseThinkTags: boolean) {
        this.filter = parseThinkTags ? new ReasoningTagFilter() : null;
    }

    /** Seam obserwacyjny — istnieje tylko na dostawcach z filtrem znaczników. */
    get reasoning(): { readonly active: boolean; readonly buffered: string } | undefined {
        return this.filter ?? undefined;
    }

    get droppedFrames(): number {
        return this.dropped;
    }

    feed(chunk: string): StreamEvent[] {
        const events: StreamEvent[] = [];
        this.buffer += chunk ?? '';
        const lines = this.buffer.split('\n');
        const tail = lines.pop() ?? '';
        for (const line of lines) this.consumeLine(line, events);

        if (tail === '' || this.isCompleteFrame(tail)) {
            this.consumeLine(tail, events);
            this.buffer = '';
        } else {
            this.buffer = tail;
        }
        return events;
    }

    finish(): StreamEvent[] {
        const events: StreamEvent[] = [];
        const tail = this.buffer;
        this.buffer = '';
        if (tail && this.isCompleteFrame(tail)) this.consumeLine(tail, events);
        this.flushFilter(events);
        return events;
    }

    /** Ładunek ramki albo `null`, gdy linia nie niesie danych (pusta, komentarz, `event:`). */
    private payloadOf(line: string): string | null {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) return null;
        if (!trimmed.startsWith('data:')) return null;
        return trimmed.slice('data:'.length).trim();
    }

    /** Czy linia jest już kompletną ramką (JSON się domyka albo to sentinel). */
    private isCompleteFrame(line: string): boolean {
        const payload = this.payloadOf(line);
        if (payload === null || payload === '') return false;
        if (payload === DONE_PAYLOAD) return true;
        try {
            JSON.parse(payload);
            return true;
        } catch {
            return false;
        }
    }

    private consumeLine(line: string, events: StreamEvent[]): void {
        const payload = this.payloadOf(line);
        if (payload === null || payload === '') return;

        // Sentinel dopasowywany DOKŁADNIE: model piszący „[DONE]" w zdaniu nie kończy tury.
        if (line.trim() === SSE_DONE_SENTINEL || payload === DONE_PAYLOAD) {
            this.flushFilter(events);
            events.push({ type: 'done', finishReason: this.finishReason });
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            // Porcja nie do sparsowania nie rzuca i nie jest końcem — strumień jedzie dalej,
            // ale ramka ląduje w koszu i musi zostawić ślad w logu (ST-11).
            this.dropped += 1;
            return;
        }
        this.consumePayload(parsed, events);
    }

    private consumePayload(payload: unknown, events: StreamEvent[]): void {
        if (!isRecord(payload)) return;

        if (payload.error !== undefined && payload.error !== null) {
            events.push({ type: 'error', error: normalizeError(payload.error) });
            return;
        }

        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const choice = isRecord(choices[0]) ? choices[0] : undefined;
        const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;

        if (delta) {
            const native = firstString(delta.reasoning_content, delta.reasoning);
            if (native) {
                // Dostawca ma własne pole na myślenie — znaczniki w treści są od teraz tekstem.
                this.filter?.disable();
                events.push({ type: 'reasoning', delta: native });
            }

            const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
            for (const call of toolCalls) this.pushToolCall(call, events);

            if (typeof delta.content === 'string' && delta.content !== '') {
                this.pushContent(delta.content, events);
            }
        }

        if (choice && typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
        if (isRecord(payload.usage)) events.push({ type: 'usage', usage: payload.usage });
    }

    private pushContent(content: string, events: StreamEvent[]): void {
        if (!this.filter) {
            events.push({ type: 'text', delta: content });
            return;
        }
        const split = this.filter.feed(content);
        if (split.reasoning) events.push({ type: 'reasoning', delta: split.reasoning });
        if (split.text) events.push({ type: 'text', delta: split.text });
    }

    private pushToolCall(call: unknown, events: StreamEvent[]): void {
        if (!isRecord(call)) return;
        const fn = isRecord(call.function) ? call.function : {};
        const rawIndex = Number(call.index);
        const event: Extract<StreamEvent, { type: 'tool_call' }> = {
            type: 'tool_call',
            // Slot wybiera indeks od dostawcy; wołacz trzyma bramkę zakresu.
            index: Number.isFinite(rawIndex) ? rawIndex : 0,
        };
        if (typeof call.id === 'string' && call.id !== '') event.id = call.id;
        if (typeof fn.name === 'string' && fn.name !== '') event.name = fn.name;
        if (typeof fn.arguments === 'string') event.argumentsDelta = fn.arguments;
        events.push(event);
    }

    /** Dopchnięcie rezerwy filtra (i ewentualne wycofanie niedomkniętego bloku myślenia). */
    private flushFilter(events: StreamEvent[]): void {
        if (!this.filter) return;
        const flushed = this.filter.finish();
        if (flushed.reasoning) events.push({ type: 'reasoning', delta: flushed.reasoning });
        if (flushed.text) events.push({ type: 'text', delta: flushed.text });
    }
}

// ── Drobiazgi wspólne ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...candidates: unknown[]): string {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
    return '';
}

/**
 * Sklejenie adresu bazowego ze ścieżką bez podwójnych ukośników i bez dublowania ścieżki.
 *
 * User wpisuje host tak, jak go widzi w dokumentacji dostawcy — najczęściej RAZEM z `/v1`.
 * Ścieżka z metryczki zaczyna się tym samym kawałkiem, więc sklejenie na ślepo dawało
 * `…/v1/v1/chat/completions` i 404 „model nie odpowiada" bez śladu, że winny jest adres.
 * Wspólny kawałek zdejmujemy CAŁYMI SEGMENTAMI (host `https://v1.example.com` nie ma
 * nic wspólnego ze ścieżką `/v1/…`, choć kończy się tymi samymi znakami).
 */
function joinUrl(base: string, path: string): string {
    if (!path) return base;
    const trimmed = base.replace(/\/+$/, '');
    if (trimmed.endsWith(path)) return trimmed;

    const baseSegs = trimmed.split('/');
    const pathSegs = path.split('/').filter(s => s !== '');
    // Od najdłuższego pokrycia do najkrótszego: ogon bazy ma być początkiem ścieżki.
    for (let n = Math.min(baseSegs.length, pathSegs.length); n > 0; n--) {
        const ogon = baseSegs.slice(baseSegs.length - n);
        if (!ogon.every((seg, i) => seg === pathSegs[i])) continue;
        const reszta = pathSegs.slice(n);
        return reszta.length > 0 ? `${trimmed}/${reszta.join('/')}` : trimmed;
    }
    return trimmed + path;
}

/** Pola żądania, których baza nie zna — jadą do ciała bez zmian. */
function passthroughFields(req: ChatRequest): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req)) {
        if (MANAGED_REQUEST_FIELDS.has(key)) continue;
        if (value === undefined) continue;
        out[key] = value;
    }
    return out;
}

function isImageBlock(block: unknown): boolean {
    if (!isRecord(block)) return false;
    if (block.type === 'image_url' || block.type === 'image' || block.type === 'input_image') return true;
    return block.image_url !== undefined && block.image_url !== null;
}

function hasImageBlock(message: OpenAiRequestMessage): boolean {
    return Array.isArray(message?.content) && message.content.some(isImageBlock);
}

/** Wywołanie narzędzia z odpowiedzi bez strumienia w kształcie kanonicznym. */
function normalizeToolCall(call: unknown): OpenAiToolCall {
    const raw = isRecord(call) ? call : {};
    const fn = isRecord(raw.function) ? raw.function : {};
    const out: OpenAiToolCall = {
        type: 'function',
        function: {
            name: typeof fn.name === 'string' ? fn.name : '',
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
    };
    if (typeof raw.id === 'string') out.id = raw.id;
    return out;
}
