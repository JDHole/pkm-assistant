/**
 * `modules/models/testing/harness.ts` — atrapy i pomocniki testów klastra `models`.
 *
 * To NIE jest kod produkcyjny i NIE jest stub: plik ma PEŁNĄ implementację, bo bez niego
 * czerwony pakiet startowy byłby nie „czerwony", tylko niekompilowalny. Nazwa pliku nie
 * kończy się na `.test.ts`, więc AVA go nie odpala.
 *
 * Zawartość:
 *  • {@link collect} — karmi dekoder porcjami i akumuluje zdarzenia w snapshot (zamiennik
 *    dawnej pary „przetwórz porcję + zamień na kształt kanoniczny");
 *  • {@link ScriptedTransport} — sterowany z testu transport strumienia;
 *  • {@link CapturingHttpClient} — klient bez strumienia, który zapamiętuje żądanie;
 *  • {@link makeCtx} / {@link makeModel} — tanie fabryki kontekstu i modelu.
 *
 * ⚠️ Typy transportu (`StreamTransport`, `HttpRequestSpec`, `HttpClient`, …) należą do
 * `core/http` i przychodzą tu przez re-eksport z `../contracts.js` (decyzja A6).
 */
import { acquireSlot } from '../requestGate.js';
import { createChatModel } from '../ChatModel.js';
import { TOOL_CALL_MAX_INDEX } from '../contracts.js';
import type {
    ChatModel,
    ChatModelDeps,
    ChatProvider,
    HttpClient,
    HttpRequestSpec,
    HttpResponse,
    ModelLoggerLike,
    ModelSettingsBag,
    OpenAiCompletion,
    OpenAiToolCall,
    ProviderContext,
    RequestGateLike,
    StreamDecoder,
    StreamOpenResult,
    StreamSink,
    StreamTransport,
} from '../contracts.js';

/** Cichy logger — testy nie chcą hałasu na stdout, ale chcą móc podejrzeć wywołania. */
export function makeLog(): ModelLoggerLike & { calls: Array<{ level: string; scope: string; args: unknown[] }> } {
    const calls: Array<{ level: string; scope: string; args: unknown[] }> = [];
    const push = (level: string) => (scope: string, ...args: unknown[]): void => {
        calls.push({ level, scope, args });
    };
    return {
        calls,
        debug: push('debug'),
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
        model: (role: string, providerId: string, modelId: string): void => {
            calls.push({ level: 'model', scope: role, args: [providerId, modelId] });
        },
    };
}

/** Pusty, ale poprawny snapshot odpowiedzi. `usage` jest PUSTYM obiektem (B.6 BA-08). */
export function emptyCompletion(): OpenAiCompletion {
    return {
        choices: [{ index: 0, message: { role: 'assistant', content: '' } }],
        usage: {},
    };
}

/**
 * Karmi dekoder kolejnymi porcjami transportu i akumuluje zdarzenia DOKŁADNIE wg tabeli
 * mapowania `StreamEvent` → snapshot (plan §0.1), a na końcu domyka `finish()`.
 *
 * Zamiennik dawnej pary „przetwórz surową porcję" + „zamień stan adaptera na kształt
 * kanoniczny": dziś dekoder mówi zdarzeniami, a akumulację robi `ChatModel` — tu jej
 * testowa kopia, żeby dekodery dało się badać w izolacji od modelu.
 */
export function collect(decoder: StreamDecoder, chunks: string[]): OpenAiCompletion {
    const snapshot = emptyCompletion();
    const message = snapshot.choices[0].message;

    const applyToolCall = (index: number, id?: string, name?: string, argumentsDelta?: string): void => {
        const safeIndex = Number.isInteger(index) && index >= 0 && index < TOOL_CALL_MAX_INDEX ? index : 0;
        if (!message.tool_calls) message.tool_calls = [];
        let slot: OpenAiToolCall | undefined = message.tool_calls[safeIndex];
        if (!slot) {
            slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
            message.tool_calls[safeIndex] = slot;
        }
        if (id !== undefined) slot.id = id;
        // Lustro akumulacji z `ChatModel.applyEvents` — nazwa SKLEJA SIĘ z fragmentów, nie
        // nadpisuje (dwa wywołania na jednym indeksie u DeepSeeka; patrz `mergeToolName`).
        if (name !== undefined) {
            const przed = typeof slot.function.name === 'string' ? slot.function.name : '';
            slot.function.name = (przed === '' || przed === name) ? name : przed + name;
        }
        if (argumentsDelta !== undefined) {
            const prev = typeof slot.function.arguments === 'string' ? slot.function.arguments : '';
            slot.function.arguments = prev + argumentsDelta;
        }
    };

    const consume = (events: ReturnType<StreamDecoder['feed']>): void => {
        for (const ev of events) {
            if (ev.type === 'text') {
                message.content = String(message.content ?? '') + ev.delta;
            } else if (ev.type === 'reasoning') {
                message.reasoning_content = (message.reasoning_content ?? '') + ev.delta;
            } else if (ev.type === 'tool_call') {
                applyToolCall(ev.index, ev.id, ev.name, ev.argumentsDelta);
            } else if (ev.type === 'usage') {
                snapshot.usage = { ...snapshot.usage, ...ev.usage };
            } else if (ev.type === 'done') {
                snapshot.choices[0].finish_reason = ev.finishReason ?? null;
            } else if (ev.type === 'error') {
                snapshot.error = ev.error;
            }
        }
    };

    for (const chunk of chunks) consume(decoder.feed(chunk));
    consume(decoder.finish());
    return snapshot;
}

/**
 * Wszystkie zdarzenia dekodera z podanych porcji, w kolejności — do asercji „co dokładnie
 * wyszło", gdy snapshot z {@link collect} jest za grubym sitem.
 */
export function collectEvents(decoder: StreamDecoder, chunks: string[]): ReturnType<StreamDecoder['feed']> {
    const all: ReturnType<StreamDecoder['feed']> = [];
    for (const chunk of chunks) all.push(...decoder.feed(chunk));
    all.push(...decoder.finish());
    return all;
}

/**
 * Transport strumienia sterowany Z TESTU.
 *
 * `open()` nie kończy się, dopóki test nie zawoła {@link ScriptedTransport.closeOk} albo
 * {@link ScriptedTransport.fail} — dokładnie tak, jak prawdziwe połączenie wisi do końca
 * odpowiedzi serwera. `push()` wpycha surową porcję do sinka.
 */
export class ScriptedTransport implements StreamTransport {
    /** Ile razy transport został otwarty (ponowienia po 429 są tu widoczne). */
    opens = 0;
    /** Ostatni opis żądania — nagłówki, ciało, `timeoutMs`. */
    lastSpec: HttpRequestSpec | null = null;
    /** Wszystkie opisy żądań po kolei (retry: pierwsze + ponowienia). */
    specs: HttpRequestSpec[] = [];
    /** Czy wołacz przerwał połączenie (`AbortController.abort()`). */
    aborted = false;

    private sink: StreamSink | null = null;
    private settle: ((result: StreamOpenResult) => void) | null = null;
    private reject: ((err: unknown) => void) | null = null;
    /** Odpowiedzi zaplanowane z góry: n-te otwarcie dostaje n-ty wpis. */
    private scripted: Array<StreamOpenResult | Error> = [];

    /**
     * Planuje wyniki KOLEJNYCH otwarć (dla polityki 429: pierwsze otwarcie 429, drugie 200…).
     * Otwarcie bez zaplanowanego wyniku czeka na `push`/`closeOk`/`fail` z testu.
     */
    script(...results: Array<StreamOpenResult | Error>): this {
        this.scripted.push(...results);
        return this;
    }

    open(spec: HttpRequestSpec, sink: StreamSink, signal: AbortSignal): Promise<StreamOpenResult> {
        this.opens += 1;
        this.lastSpec = spec;
        this.specs.push(spec);
        this.sink = sink;
        signal.addEventListener('abort', () => {
            this.aborted = true;
        });
        const planned = this.scripted.shift();
        if (planned instanceof Error) return Promise.reject(planned);
        if (planned) return Promise.resolve(planned);
        return new Promise<StreamOpenResult>((resolve, reject) => {
            this.settle = resolve;
            this.reject = reject;
        });
    }

    /** Surowa porcja od „serwera" — trafia wprost do dekodera dostawcy. */
    push(text: string): void {
        if (!this.sink) throw new Error('ScriptedTransport.push przed open()');
        this.sink.onChunk(text);
    }

    /** Serwer domknął ciało przy HTTP 200. */
    closeOk(headers: Record<string, string> = {}): void {
        this.settle?.({ status: 200, headers, body: '' });
        this.settle = null;
        this.reject = null;
    }

    /** Serwer odpowiedział błędem — status, ciało i (opcjonalnie) nagłówki (`Retry-After`). */
    fail(status: number, body = '', headers: Record<string, string> = {}): void {
        this.settle?.({ status, headers, body });
        this.settle = null;
        this.reject = null;
    }

    /** Awaria transportu (brak sieci, zgaszony demon) — otwarcie RZUCA. */
    crash(err: unknown): void {
        this.reject?.(err);
        this.settle = null;
        this.reject = null;
    }
}

/** Transport, który nigdy nie odpowiada — do testów Stopu i zwolnienia slotu bramki. */
export class HangingTransport implements StreamTransport {
    opens = 0;
    aborts = 0;
    lastSpec: HttpRequestSpec | null = null;

    open(spec: HttpRequestSpec, _sink: StreamSink, signal: AbortSignal): Promise<StreamOpenResult> {
        this.opens += 1;
        this.lastSpec = spec;
        signal.addEventListener('abort', () => {
            this.aborts += 1;
        });
        return new Promise<StreamOpenResult>(() => {
            /* nigdy nie settluje — to jest cały sens tej atrapy */
        });
    }
}

/** Odpowiedź klienta bez strumienia, jaką test planuje z góry. */
export interface ScriptedHttpResponse {
    status?: number;
    headers?: Record<string, string>;
    text?: string;
    body?: unknown;
}

/** Buduje `HttpResponse` z lekkiego opisu; `json()` rzuca, gdy `text` nie jest JSON-em. */
export function makeHttpResponse(spec: ScriptedHttpResponse = {}): HttpResponse {
    const text = spec.text ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
    return {
        status: spec.status ?? 200,
        headers: spec.headers ?? {},
        text,
        json<T = unknown>(): T {
            return JSON.parse(text) as T;
        },
    };
}

/**
 * Klient HTTP bez strumienia, który zapamiętuje żądania i oddaje zaplanowane odpowiedzi.
 * Zamiennik dawnej atrapy wstrzykiwanej opcją konstruktora modelu — dziś idzie przez
 * `deps.http` (B.5 ST-23).
 */
export class CapturingHttpClient implements HttpClient {
    lastSpec: HttpRequestSpec | null = null;
    specs: HttpRequestSpec[] = [];
    sends = 0;

    private responses: ScriptedHttpResponse[] = [];
    private thrown: unknown = null;

    constructor(...responses: ScriptedHttpResponse[]) {
        this.responses.push(...responses);
    }

    /** Planuje odpowiedzi KOLEJNYCH wywołań. */
    queue(...responses: ScriptedHttpResponse[]): this {
        this.responses.push(...responses);
        return this;
    }

    /** Od tej chwili KAŻDE wywołanie rzuca (awaria transportu, nie status HTTP). */
    throwOn(err: unknown = new Error('network down')): this {
        this.thrown = err;
        return this;
    }

    send(spec: HttpRequestSpec): Promise<HttpResponse> {
        this.sends += 1;
        this.lastSpec = spec;
        this.specs.push(spec);
        if (this.thrown) return Promise.reject(this.thrown);
        return Promise.resolve(makeHttpResponse(this.responses.shift() ?? {}));
    }
}

/** Bramka z prawdziwego `requestGate` — domyślna zależność {@link makeModel}. */
export const realGate: RequestGateLike = { acquireSlot };

/** Bramka-szpieg: zapisuje argumenty i wpuszcza natychmiast. */
export function makeSpyGate(): RequestGateLike & {
    calls: Array<{ key: string; limit: number; priority?: number }>;
    releases: number;
} {
    const calls: Array<{ key: string; limit: number; priority?: number }> = [];
    const spy = {
        calls,
        releases: 0,
        acquireSlot(key: string, limit: number, opts?: { priority?: number }) {
            calls.push({ key, limit, priority: opts?.priority });
            return {
                admitted: Promise.resolve(true),
                queued: false,
                cancel: (): void => {},
                release: (): void => {
                    spy.releases += 1;
                },
            };
        },
    };
    return spy;
}

/** Kontekst dostawcy z sensownymi domyślnymi — testy nadpisują to, co badają. */
export function makeCtx(overrides: Partial<ProviderContext> = {}): ProviderContext {
    return {
        modelId: 'test-model',
        apiKey: 'test-key',
        log: makeLog(),
        ...overrides,
    };
}

/** Worek ustawień w nowym kształcie (spec §4) — punkt startowy dla testów. */
export function makeSettings(overrides: Partial<ModelSettingsBag['pkmAssistant']> = {}): ModelSettingsBag {
    return { pkmAssistant: { chat: {}, ...overrides } };
}

/**
 * Model z atrapami. Podane nadpisania wygrywają nad domyślnymi zależnościami.
 *
 * ⚠️ Na stubach `createChatModel` rzuca `not implemented` — to jest oczekiwane:
 * czerwony pakiet startowy klastra stoi właśnie na tym.
 */
export function makeModel(provider: ChatProvider, overrides: Partial<ChatModelDeps> = {}): ChatModel {
    return createChatModel({
        provider,
        ctx: makeCtx(),
        http: new CapturingHttpClient(),
        transport: new ScriptedTransport(),
        gate: realGate,
        settings: makeSettings(),
        ...overrides,
    });
}
