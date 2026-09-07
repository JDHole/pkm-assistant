/**
 * `modules/models/ChatModel.ts` — model czatu: JEDYNY obiekt, jaki reszta pluginu trzyma
 * w ręku po stronie modeli.
 *
 * Dostawca tłumaczy kształty (żądanie → HTTP, ramki → zdarzenia). Model robi resztę:
 * pilnuje kolejki do platform lokalnych, składa zdarzenia w jedną odpowiedź, rozstrzyga
 * turę na jeden z trzech sposobów, prowadzi politykę 429 i wykonuje Stop tak, żeby nikt
 * po drugiej stronie nie został z wiszącą promisą.
 *
 * ODPOWIEDZIALNOŚCI (kontrakt, nie implementacja):
 *  • bramka równoległości platform lokalnych (B.3 SM-04..SM-06) + priorytet biletu (SM-05),
 *  • odroczone zwolnienie slotu przez statyczny seam `scheduleGateRelease` (SM-12/SM-13),
 *  • trzy wyjścia streamu (B.5 ST-04..ST-07): sentinel / domknięcie bez sentinela / błąd,
 *  • polityka 429: backoff wykładniczy, `Retry-After`, sufit `STREAM_MAX_RETRIES`, budzik
 *    po Stopie (ST-12..ST-15) — transport tylko ujawnia `status` i `headers`,
 *  • tor `complete()` (SM-17) i emulacja streamu dla `streamMode === 'complete'` (XA-03),
 *  • semantyka Stopu (SM-07..SM-15): jednorazowy uchwyt odrzucenia, bezwarunkowe przerwanie
 *    transportu, `StreamAbortError` / `GateCancelledError`,
 *  • `listModels()` (ST-21/ST-22): brak sieci → PUSTA tablica, nigdy wyjątek.
 *
 * CZEGO TU NIE MA: powiadomień. `deps.notices` jest przyjmowane dla zgodności zależności,
 * ale klaster świadomie nie pokazuje ani jednej notki (decyzja R8) — techniczny komunikat
 * przy każdej zmianie modelu to szum na ekranie usera.
 */
import { log } from '../../core/utils/Logger.js';
import { hostWindow, maskSensitiveData, normalizeError, STREAM_TRANSPORT_TIMEOUT_MS } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { STREAM_MAX_RETRIES, STREAM_RETRY_BASE_DELAY_MS, TOOL_CALL_MAX_INDEX } from './contracts.js';
import type {
    ChatModelDeps,
    ChatProvider,
    ChatRequest,
    GateCancelledError,
    GateTicket,
    HttpClient,
    HttpRequestSpec,
    ModelInfo,
    ModelSettingsBag,
    NormalizedError,
    OpenAiCompletion,
    OpenAiToolCall,
    ProviderContext,
    ProviderId,
    RequestGateLike,
    StreamAbortError,
    StreamEvent,
    StreamHandlers,
    StreamSink,
    StreamTransport,
} from './contracts.js';

/** Etykieta modułu w logu — jedna, żeby dało się filtrować po niej cały klaster. */
const LOG_SCOPE = 'ChatModel';

/** Widełki pojemności bramki platform lokalnych (B.3 SM-04). */
const GATE_LIMIT_MIN = 1;
const GATE_LIMIT_MAX = 10;

/** Ile znaków porcji trafia do logu przy nieparsowalnej ramce — po masce sekretów. */
const CHUNK_LOG_HEAD_CHARS = 200;

/** Jak skończyła się JEDNA próba otwarcia strumienia. */
type AttemptOutcome =
    | { kind: 'settled' }
    | { kind: 'retry'; error: NormalizedError; delayMs: number | null };

/** Co zamyka turę od strony dekodera. */
type TurnEnd =
    | { kind: 'done' }
    | { kind: 'error'; error: NormalizedError };

/** Pusty, ale poprawny snapshot. `usage` jest PUSTYM obiektem — sygnał „estymuj" dla pętli. */
function emptyCompletion(): OpenAiCompletion {
    return {
        choices: [{ index: 0, message: { role: 'assistant', content: '' } }],
        usage: {},
    };
}

/**
 * Płytka kopia snapshotu z rozdzielonymi zagnieżdżeniami, których dotyka akumulacja.
 * Potrzebna, bo `decoder.finish()` domyka rezerwę parsera myślenia i nie ma prawa zmutować
 * obiektu, który poszedł już do `handlers.chunk` (B.11 TT-11).
 */
function cloneCompletion(src: OpenAiCompletion): OpenAiCompletion {
    const choice = src.choices[0];
    const message = { ...choice.message };
    if (Array.isArray(message.tool_calls)) {
        message.tool_calls = message.tool_calls.map(call => ({
            ...call,
            function: { ...call.function },
        }));
    }
    return {
        ...src,
        choices: [{ ...choice, message }, ...src.choices.slice(1)],
        usage: { ...src.usage },
    };
}

/** Slot `tool_calls` wybiera INDEKS, nie kolejność; indeks spoza widełek ląduje w slocie 0. */
function toolCallSlot(message: OpenAiCompletion['choices'][number]['message'], index: number): OpenAiToolCall {
    const safe = Number.isInteger(index) && index >= 0 && index < TOOL_CALL_MAX_INDEX ? index : 0;
    if (!Array.isArray(message.tool_calls)) message.tool_calls = [];
    const calls = message.tool_calls;
    let slot = calls[safe];
    if (!slot) {
        slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
        calls[safe] = slot;
    }
    return slot;
}

/**
 * Nazwa narzędzia w slocie po dołożeniu kolejnego fragmentu.
 *
 * Nazwa AKUMULUJE SIĘ tak samo jak argumenty — nie nadpisuje. Powód jest jeden i konkretny:
 * DeepSeek Reasoner potrafi wypchnąć DWA wywołania na TYM SAMYM indeksie (`read` z własnymi
 * argumentami, zaraz po nim `list` z własnymi). Przy nadpisaniu zostaje jedno wywołanie
 * o nazwie DRUGIEGO i sklejonych argumentach obu — pierwsze narzędzie znika po cichu, a to,
 * które zostało, dostaje ciało `{…}{…}`. Przy sklejaniu powstaje `readlist` + `{…}{…}`,
 * czyli DOKŁADNIE kształt, który rozkleja kanon pętli
 * (`splitConcatenatedToolCalls` + `_decomposeToolName` w `modules/agent-loop`), i oba
 * narzędzia wykonują się poprawnie. Strażnik end-to-end: scenariusz harnessa
 * `10_sklejone_tool_calls`.
 *
 * ⚠️ Powtórzenie TEJ SAMEJ nazwy w kolejnej delcie (są serwery kształtu OpenAI, które wysyłają
 * ją przy każdej porcji) NIE dokleja się drugi raz — inaczej `read` + `read` dałoby `readread`.
 */
function mergeToolName(previous: unknown, incoming: string): string {
    const before = typeof previous === 'string' ? previous : '';
    if (before === '' || before === incoming) return incoming;
    return before + incoming;
}

/**
 * Nanosi zdarzenia dekodera na snapshot i mówi, czy tura ma się na nich skończyć.
 * To JEDYNE miejsce, w którym język zdarzeń zamienia się w kształt kanoniczny.
 */
function applyEvents(snapshot: OpenAiCompletion, events: readonly StreamEvent[]): { end: TurnEnd | null; visible: boolean } {
    const choice = snapshot.choices[0];
    const message = choice.message;
    let end: TurnEnd | null = null;
    let visible = false;

    for (const event of events) {
        switch (event.type) {
            case 'text':
                message.content = `${typeof message.content === 'string' ? message.content : ''}${event.delta}`;
                visible = true;
                break;
            case 'reasoning':
                // Pole POWSTAJE dopiero przy pierwszej delcie — brak myślenia to brak pola.
                message.reasoning_content = `${message.reasoning_content ?? ''}${event.delta}`;
                visible = true;
                break;
            case 'tool_call': {
                const slot = toolCallSlot(message, event.index);
                if (event.id !== undefined) slot.id = event.id;
                // Nazwa AKUMULUJE SIĘ (patrz `mergeToolName`) — nadpisanie gubiło wywołanie,
                // gdy dostawca wypchnął dwa narzędzia na tym samym indeksie.
                if (event.name !== undefined) slot.function.name = mergeToolName(slot.function.name, event.name);
                if (event.argumentsDelta !== undefined) {
                    const previous = typeof slot.function.arguments === 'string' ? slot.function.arguments : '';
                    slot.function.arguments = previous + event.argumentsDelta;
                }
                visible = true;
                break;
            }
            case 'usage':
                // MERGE, nigdy nadpisanie całości: Anthropic przysyła usage w dwóch ratach.
                snapshot.usage = { ...snapshot.usage, ...event.usage };
                break;
            case 'done':
                choice.finish_reason = event.finishReason ?? null;
                if (!end) end = { kind: 'done' };
                break;
            case 'error':
                end = { kind: 'error', error: event.error };
                break;
        }
    }

    return { end, visible };
}

/** `Retry-After` w sekundach (RFC 9110 §10.2.3). Data zamiast liczby → ignorujemy. */
function retryAfterMs(headers: Record<string, string> | undefined): number | null {
    if (!headers) return null;
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== 'retry-after') continue;
        const seconds = Number(String(value).trim());
        if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
        return null;
    }
    return null;
}

/**
 * Błąd padu strumienia zbudowany PRZEZ NAS, nie z obiektu transportu.
 *
 * K20: gdy serwer nie odpisał ani bajta, do normalizacji nie wolno podać żądania ani
 * zdarzenia transportu — poszłyby tam nagłówki, a w nich klucz API. Stąd własne, krótkie
 * zdanie i zachowany `http_status`.
 */
function bodilessStreamError(status: number): NormalizedError {
    const reason = status > 0 ? `Stream error (HTTP ${status})` : 'Stream error (no response)';
    return normalizeError(reason, status > 0 ? status : null);
}

/** Ciało błędu od dostawcy → jeden kształt. Nieparsowalne ciało nie może rzucić. */
function errorFromBody(body: string, status: number): NormalizedError {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (!raw) return bodilessStreamError(status);
    try {
        return normalizeError(JSON.parse(raw), status > 0 ? status : null);
    } catch {
        // Ciało, którego nie da się wyparsować, bywa stroną błędu proxy — a te potrafią
        // odbić NASZE nagłówki. Zdanie dostawcy przechodzi bez zmian, kształt sekretu nie.
        return normalizeError(maskSensitiveData(raw.slice(0, 500)), status > 0 ? status : null);
    }
}

/**
 * Czy to jest już rozliczony błąd, którego NIE WOLNO przerabiać.
 *
 * Dwie rodziny: gotowy {@link NormalizedError} (goły obiekt — taki właśnie kształt widzi
 * pętla) oraz znaczniki Stopu (`_aborted`) i anulowania w kolejce (`_queueCancelled`),
 * które niosą sens ponad treścią i po normalizacji przestałyby działać.
 */
function isSettledError(e: unknown): boolean {
    if (!e || typeof e !== 'object') return false;
    const bag = e as { _aborted?: boolean; _queueCancelled?: boolean; message?: unknown };
    if (bag._aborted === true || bag._queueCancelled === true) return true;
    return !(e instanceof Error) && typeof bag.message === 'string';
}

/**
 * Granica normalizacji: cokolwiek wyleci z dostawcy albo z sieci, do konsumenta wychodzi
 * jednym kształtem i BEZ sekretu w treści (komunikat `fetch` potrafi nieść cały adres).
 * Błąd już rozliczony ({@link isSettledError}) przechodzi nietknięty.
 */
function toConsumerError(e: unknown, fallback = 'Stream error (no response)'): NormalizedError {
    if (isSettledError(e)) return e as NormalizedError;
    const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    const safe = maskSensitiveData(text).trim();
    return normalizeError(safe || fallback);
}

export class ChatModel {
    /** B.3 SM-18: tania nazwa modelu do logów/trace. */
    readonly modelKey: string;
    /** Identyfikator modelu u dostawcy. */
    readonly modelId: string;
    readonly providerId: ProviderId;
    /** `'streaming'` między wejściem na slot bramki a rozstrzygnięciem tury. */
    state: 'idle' | 'streaming' = 'idle';

    /**
     * B.3 SM-05: priorytet biletu bramki. BRAK POLA = 1 („to główny czat").
     * `modules/tools/DelegateTool.ts` zbija ŚWIEŻEJ instancji suba `_gatePriority = 0`.
     */
    _gatePriority = 1;

    /**
     * Seam testowy budzika okna backoffu 429 (ST-14). Istnieje tylko wtedy, gdy tura
     * faktycznie czeka na ponowienie.
     */
    _retryWake?: () => void;

    /** B.3 SM-12: produkcyjny cooldown zwolnienia slotu — DOKŁADNIE 150 ms. */
    static GATE_RELEASE_COOLDOWN_MS = 150;

    private readonly _provider: ChatProvider;
    private readonly _ctx: ProviderContext;
    private readonly _http: HttpClient;
    private readonly _transport: StreamTransport;
    private readonly _gate: RequestGateLike;
    private readonly _settings: ModelSettingsBag;

    /**
     * B.3 SM-16: bilet bieżącej tury, ustawiany DOPIERO PO wejściu na slot. Pole jest
     * obserwowane przez testy jako dowód, że stream faktycznie zajął slot — stąd nazwa
     * z podkreśleniem, mimo że w produkcji nikt go nie czyta.
     */
    private _gateTicket: GateTicket | null = null;

    /**
     * Bilet wzięty, ale jeszcze NIEWPUSZCZONY. Osobne pole od {@link _gateTicket}, bo Stop
     * potrzebuje uchwytu do biletu stojącego w kolejce (`cancel()`), a `_gateTicket` ma
     * znaczyć „ten model TRZYMA slot" i nic więcej.
     */
    private _pendingTicket: GateTicket | null = null;

    /**
     * Bilet toru BEZ strumienia. Osobne pole od {@link _gateTicket} i {@link _pendingTicket},
     * bo `complete()` bywa wołane na instancji, na której AKURAT BIEGNIE tura strumienia
     * (`ChatModel` nie jest concurrent-safe, ale nikt tego wołaczom nie zabrania).
     * Wcześniej `complete()` zerowało `_gateTicket` biegnącej tury — a ta zwalnia slot
     * właśnie przez to pole, więc na platformie lokalnej (pojemność 1) slot zostawał
     * zajęty na zawsze i kolejka stawała. Tor bez strumienia rozlicza dziś WYŁĄCZNIE
     * własny bilet i nie dotyka ani jednego pola cudzej tury.
     */
    private _completeTicket: GateTicket | null = null;

    private _abortController: AbortController | null = null;
    /** JEDNORAZOWY uchwyt odrzucenia bieżącej tury — instalowany DOPIERO po wejściu na slot. */
    private _rejectTurn: ((err: unknown) => void) | null = null;
    private _turnSettled = true;
    private _admitted = false;
    private _cancelled = false;
    private _gateReleaseScheduled = false;

    constructor(deps: ChatModelDeps) {
        if (!deps || typeof deps !== 'object') {
            throw new Error('ChatModel: brak zależności — model powstaje wyłącznie z pełnego zestawu deps.');
        }
        if (!deps.provider) throw new Error('ChatModel: brak zależności `provider` (dostawca platformy).');
        if (!deps.http) throw new Error('ChatModel: brak zależności `http` (klient HTTP bez strumienia).');
        if (!deps.transport) throw new Error('ChatModel: brak zależności `transport` (transport strumienia).');
        if (!deps.gate) throw new Error('ChatModel: brak zależności `gate` (bramka równoległości).');

        this._provider = deps.provider;
        this._ctx = deps.ctx;
        this._http = deps.http;
        this._transport = deps.transport;
        this._gate = deps.gate;
        this._settings = deps.settings ?? {};

        this.modelId = String(deps.ctx?.modelId ?? '');
        this.modelKey = this.modelId;
        this.providerId = this._provider.info?.id;
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Powierzchnia publiczna
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Strumień. Rozstrzyga się na trzy sposoby (B.5 ST-04..ST-07):
     * 1. sentinel platformy (zdarzenie `done` dekodera) — pełna treść, zero ostrzeżeń;
     * 2. domknięcie transportu przy HTTP 200 BEZ sentinela — `stream.closed_without_sentinel`
     *    + `handlers.done` + resolve tym, co przyszło; przy ZEROWEJ treści REJECT zdaniem;
     * 3. błąd — `handlers.error` ORAZ odrzucenie promisy TYM SAMYM obiektem.
     *
     * Sentinel przybyły RAZEM z domknięciem połączenia WYGRYWA: decyzja o „zamknięciu bez
     * sentinela" jest odroczona o jedno makrozadanie.
     *
     * @param req Żądanie w kształcie kanonicznym (OpenAI chat).
     * @param handlers Podzbiór handlerów; wszystkie są opcjonalne.
     */
    stream(req: ChatRequest, handlers: StreamHandlers = {}): Promise<OpenAiCompletion> {
        let resolveOuter!: (value: OpenAiCompletion) => void;
        let rejectOuter!: (err: unknown) => void;
        const turn = new Promise<OpenAiCompletion>((resolve, reject) => {
            resolveOuter = resolve;
            rejectOuter = reject;
        });

        // Instancja nie obsługuje dwóch tur naraz (stan tury żyje na polach). Gdy mimo to
        // ktoś odpali drugą, poprzednia MUSI dostać rozstrzygnięcie — inaczej jej `await`
        // nie wróciłby już nigdy. Lepszy jasny błąd niż wieczne wiszenie.
        this._supersedeRunningTurn();

        // Stan tury zeruje się TU, a nie w `finally` poprzedniej — instancja bywa użyta
        // ponownie, a `stopStream()` po zakończonej turze nadal ma prawo przerwać transport.
        this._turnSettled = false;
        this._admitted = false;
        this._cancelled = false;
        this._gateReleaseScheduled = false;
        this._rejectTurn = null;
        this._retryWake = undefined;
        this._abortController = null;

        // Slot bramki zwalniamy PRZED rozstrzygnięciem promisy: konsument, który obudzi się
        // na `await`, ma zastać kolejkę już rozliczoną (a nie zwolnioną mikrozadanie później).
        const settleOk = (value: OpenAiCompletion): void => {
            if (this._turnSettled) return;
            this._turnSettled = true;
            this._rejectTurn = null;
            this.state = 'idle';
            this._releaseGateSlot();
            resolveOuter(value);
        };
        const settleErr = (err: unknown): void => {
            if (this._turnSettled) return;
            this._turnSettled = true;
            this._rejectTurn = null;
            this.state = 'idle';
            this._releaseGateSlot();
            rejectOuter(err);
        };

        // Bilet bierzemy SYNCHRONICZNIE: `stopStream()` wywołany w tej samej turze pętli
        // zdarzeń musi mieć co anulować (bilet stojący w kolejce). Wybuch bramki (albo
        // dostawcy przy liczeniu jej pojemności) NIE MOŻE wylecieć synchronicznie — pętla
        // łapie ten błąd wyłącznie na odrzuceniu promisy i na `handlers.error`.
        let ticket: GateTicket;
        try {
            ticket = this._gate.acquireSlot(this._gateKey(), this._streamGateLimit(), { priority: this._gatePriority });
        } catch (e) {
            const err = toConsumerError(e, 'Nie udało się wejść do kolejki żądań modelu.');
            this._callHandler(() => handlers.error?.(err));
            settleErr(err);
            return turn;
        }
        this._pendingTicket = ticket;
        this._gateTicket = null;

        void this._runTurn(req, handlers, ticket, settleOk, settleErr);
        return turn;
    }

    /**
     * Tor BEZ strumienia (B.3 SM-17). Idzie przez `deps.http`, czyta ciało jako JSON
     * i oddaje kształt kanoniczny. Błąd dostawcy jest NORMALIZOWANY, nie rzucany surowo.
     *
     * Bramka obowiązuje tak samo jak w torze strumieniowym — inaczej most lokalny
     * dostawałby żądania poza kolejką.
     */
    async complete(req: ChatRequest): Promise<OpenAiCompletion> {
        const ticket = this._gate.acquireSlot(this._gateKey(), this._streamGateLimit(), { priority: this._gatePriority });
        this._completeTicket = ticket;
        // Stan wjazdu trzymamy LOKALNIE, nie na polu instancji: dwa równoległe `complete()`
        // mają się rozliczyć każde swoim biletem, a nie ostatnim zapisanym.
        let admitted = false;
        try {
            admitted = await ticket.admitted;
            if (!admitted) throw this._gateCancelledError();
            return await this._completeOnce(req);
        } finally {
            if (this._completeTicket === ticket) this._completeTicket = null;
            // Bilet, który nigdy nie wjechał na slot, nie ma czego zwalniać — jego drogą
            // jest `cancel()`. Zwolnienie idzie z tym samym cooldownem co w torze strumienia.
            if (admitted) {
                const cls = this._class();
                cls.scheduleGateRelease(() => {
                    try { ticket.release(); } catch { /* release jest idempotentne, ale bramka bywa podmieniona */ }
                }, cls.GATE_RELEASE_COOLDOWN_MS);
            }
        }
    }

    /**
     * TWARDY Stop z zewnątrz (B.3 SM-07..SM-15).
     *
     * Kolejność jest kontraktem: najpierw budzimy okno backoffu 429 (po Stopie NIE wolno
     * polecieć kolejnemu, PŁATNEMU żądaniu), potem zwalniamy/anulujemy bilet bramki, potem
     * przerywamy transport, a na końcu zużywamy JEDNORAZOWY uchwyt odrzucenia. Odrzucenie
     * idzie łańcuchem mikrozadań — synchroniczny budzik pętli ma dalej wygrywać swój wyścig.
     */
    stopStream(): void {
        this._cancelled = true;

        // 1. Okno backoffu — obudź, żeby pętla ponowień zobaczyła anulowanie.
        const wake = this._retryWake;
        this._retryWake = undefined;
        if (wake) {
            try { wake(); } catch { /* budzik nie ma prawa wywrócić Stopu */ }
        }

        // 2. Bilet: trzymający slot zwalniamy z cooldownem, czekający w kolejce anulujemy.
        if (this._gateTicket) {
            this._releaseGateSlot();
        } else if (this._pendingTicket) {
            try { this._pendingTicket.cancel(); } catch { /* bilet mógł już zejść */ }
        }

        // 2b. Tor bez strumienia ma własny bilet. `cancel()` rusza WYŁĄCZNIE bilet czekający
        //     w kolejce (kontrakt bramki), więc żądanie już biegnące dokończy i zwolni slot
        //     samo — Stop nie zabiera slotu spod wywołania, które wciąż leci po sieci.
        if (this._completeTicket) {
            try { this._completeTicket.cancel(); } catch { /* bilet mógł już zejść */ }
        }

        // 3. Przerwanie transportu jest BEZWARUNKOWE — także przy powtórnym Stopie.
        this._signalAbort();

        // 4. Uchwyt odrzucenia — jednorazowy. Pusty przy bilecie z kolejki: tamtą ścieżkę
        //    rozstrzyga sam `stream()` błędem „anulowany w kolejce".
        const reject = this._rejectTurn;
        this._rejectTurn = null;
        if (!reject) return;
        const err = this._abortError();
        void Promise.resolve().then(() => { reject(err); });
    }

    /**
     * Lista modeli dostawcy (dropdown Ustawień).
     *
     * B.5 ST-21: brak sieci → PUSTA tablica, nigdy wyjątek. B.5 ST-22: wołanie bez `await`
     * z UI nie może zostawić nieobsłużonego odrzucenia — dlatego cała treść siedzi w `try`.
     *
     * @param _refresh Zachowane dla wołaczy z UI; katalog i tak jest pobierany za każdym razem.
     */
    async listModels(_refresh?: boolean): Promise<ModelInfo[]> {
        try {
            const models = await this._provider.listModels(this._ctx, this._http);
            return Array.isArray(models) ? models : [];
        } catch (e) {
            log.debug(LOG_SCOPE, 'listModels: katalog modeli niedostępny', { provider: this.providerId, reason: maskSensitiveData(String((e as Error)?.message ?? e)) });
            return [];
        }
    }

    /**
     * B.3 SM-06: pojemność bramki platformy tego modelu (0 = brak bramki/chmura).
     * Konsument: `DelegateTool._resolveTaskConcurrency`.
     */
    _streamGateLimit(): number {
        if (!this._provider.info?.local) return 0;
        const raw = this._settings?.pkmAssistant?.limits?.local_platform_max_concurrent;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < GATE_LIMIT_MIN) return GATE_LIMIT_MIN;
        return Math.min(GATE_LIMIT_MAX, Math.floor(value));
    }

    /**
     * B.3 SM-13: seam odroczenia zwolnienia slotu. `ms` MUSI pochodzić ze stałej klasy
     * (podklasa nadpisująca `GATE_RELEASE_COOLDOWN_MS` zmienia planowany odstęp), a dopóki
     * callback nie odpali, następny stream NIE dostaje slotu.
     */
    static scheduleGateRelease(fn: () => void, ms: number): void {
        hostWindow.setTimeout(fn, ms);
    }

    /**
     * Seam odroczenia PONOWIENIA po 429. Dostaje kolejno `STREAM_RETRY_BASE_DELAY_MS`,
     * ×2, ×4 — chyba że odpowiedź niosła `Retry-After`, który wygrywa nad backoffem.
     */
    static scheduleRetry(fn: () => void, ms: number): void {
        hostWindow.setTimeout(fn, ms);
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Tura
    // ───────────────────────────────────────────────────────────────────────────

    /** Klasa TEJ instancji — statyczne seamy i stałe czyta się przez nią, nie przez `ChatModel`. */
    private _class(): typeof ChatModel {
        return this.constructor as typeof ChatModel;
    }

    /** Klucz bramki = nazwa platformy. Różne platformy = różne, niezależne kolejki. */
    private _gateKey(): string {
        return String(this._provider.info?.id ?? 'unknown');
    }

    private _text(key: string): string {
        const language = this._settings?.pkmAssistant?.language;
        return t(key, undefined, typeof language === 'string' ? language : undefined);
    }

    /** Odrzucenie po Stopie użytkownika — instancja `Error` ze znacznikiem `_aborted`. */
    private _abortError(): StreamAbortError {
        const err = new Error(this._text('model.stream_aborted')) as StreamAbortError;
        err._aborted = true;
        return err;
    }

    /** Odrzucenie biletu anulowanego W KOLEJCE — inna ścieżka niż Stop biegnącego streamu. */
    private _gateCancelledError(): GateCancelledError {
        const err = new Error(`Request do platformy ${this._gateKey()} anulowany w kolejce.`) as GateCancelledError;
        err._queueCancelled = true;
        return err;
    }

    private _signalAbort(): void {
        const controller = this._abortController;
        if (!controller) return;
        if (controller.signal.aborted) {
            // Powtórny Stop: sygnał jest już zgaszony, ale przerwanie transportu ma być
            // BEZWARUNKOWE — konsument sygnału musi zobaczyć każde wywołanie.
            try { controller.signal.dispatchEvent(new Event('abort')); } catch { /* środowisko bez dispatchEvent */ }
            return;
        }
        try { controller.abort(); } catch { /* kontroler mógł już zejść */ }
    }

    /**
     * Zwolnienie slotu jest ODROCZONE i wykonywane RAZ na turę (SM-12/SM-13).
     * Bilet, który nigdy nie wjechał na slot, nie ma czego zwalniać — jego drogą jest
     * `cancel()`, nie `release()`.
     */
    private _releaseGateSlot(): void {
        const ticket = this._gateTicket;
        if (!ticket || !this._admitted || this._gateReleaseScheduled) return;
        this._gateReleaseScheduled = true;
        const cls = this._class();
        cls.scheduleGateRelease(() => {
            try { ticket.release(); } catch { /* release jest idempotentne, ale bramka bywa podmieniona */ }
        }, cls.GATE_RELEASE_COOLDOWN_MS);
    }

    /**
     * Domyka turę, która jeszcze biegnie, gdy na TEJ SAMEJ instancji rusza następna.
     *
     * Stan tury (bilet, uchwyt odrzucenia, kontroler przerwania) żyje na polach, więc druga
     * tura i tak by go nadpisała — bez tego pierwsza promisa nie miałaby już kto rozstrzygnąć
     * i konsument wisiałby na `await` do końca świata. Rozliczamy więc starą turę uczciwie:
     * przerwanie transportu, zwolnienie/anulowanie biletu i odrzucenie ZDANIEM.
     *
     * To siatka bezpieczeństwa, nie zaproszenie: właściwą drogą do równoległości są OSOBNE
     * instancje (`modelResolver` pomija cache dla ról sub i na żądanie dla `main`).
     *
     * Ścieżka jest bliźniacza do Stopu: ubijamy turę Z ZEWNĄTRZ, więc rozstrzygamy PROMISĘ,
     * a `handlers.error` starej tury zostawiamy w spokoju (tak samo jak `stopStream()`).
     * Odrzucenie leci SYNCHRONICZNIE — mikrozadanie rozstrzygnęłoby starą turę już po tym,
     * jak `stream()` zainstaluje stan nowej, i zabrałoby jej slot bramki.
     */
    private _supersedeRunningTurn(): void {
        if (this._turnSettled) return;

        const reject = this._rejectTurn;
        this._rejectTurn = null;
        this._retryWake = undefined;

        this._signalAbort();
        if (this._gateTicket) {
            this._releaseGateSlot();
        } else if (this._pendingTicket) {
            try { this._pendingTicket.cancel(); } catch { /* bilet mógł już zejść */ }
        }
        this._pendingTicket = null;

        if (!reject) {
            // Tura stała jeszcze w kolejce bramki: uchwytu odrzucenia nie było, więc
            // rozstrzygnie się sama — anulowanym biletem.
            return;
        }

        const err = normalizeError('Poprzednia tura tego modelu została przerwana przez nowe żądanie na tej samej instancji.');
        log.debug(LOG_SCOPE, 'poprzednia tura przykryta nowym żądaniem', { provider: this.providerId });
        // `reject` to `settleErr` STAREJ tury — sam ustawia `_turnSettled` i zdejmuje stan.
        reject(err);
    }

    /** Handler konsumenta nie ma prawa wywrócić tury — jego wyjątek to jego sprawa. */
    private _callHandler(fn: (() => void) | undefined): void {
        if (!fn) return;
        try { fn(); } catch (e) {
            log.debug(LOG_SCOPE, 'handler konsumenta rzucił — tura leci dalej', String((e as Error)?.message ?? e));
        }
    }

    /** `handlers.done` bywa asynchroniczne i MUSI zostać awaitowane przed resolve. */
    private async _callDone(handlers: StreamHandlers, response: OpenAiCompletion): Promise<void> {
        if (!handlers.done) return;
        try { await handlers.done(response); } catch (e) {
            log.debug(LOG_SCOPE, 'handlers.done rzucił — odpowiedź i tak wraca', String((e as Error)?.message ?? e));
        }
    }

    private async _runTurn(
        req: ChatRequest,
        handlers: StreamHandlers,
        ticket: GateTicket,
        settleOk: (value: OpenAiCompletion) => void,
        settleErr: (err: unknown) => void,
    ): Promise<void> {
        try {
            const admitted = await ticket.admitted;
            if (!admitted) {
                const err = this._gateCancelledError();
                this._callHandler(() => handlers.error?.(err));
                settleErr(err);
                return;
            }

            this._admitted = true;
            this._gateTicket = ticket;
            this.state = 'streaming';
            // Uchwyt odrzucenia instalujemy DOPIERO tutaj: bilet z kolejki rozstrzyga się
            // sam, a podwójne odrzucenie byłoby błędem cichym i trudnym do złapania.
            this._rejectTurn = settleErr;

            if (this._cancelled) {
                const err = this._abortError();
                this._rejectTurn = null;
                this._callHandler(() => handlers.error?.(err));
                settleErr(err);
                return;
            }

            this._callHandler(() => handlers.gate_admitted?.());

            const info = this._provider.info;
            if (info?.streamMode === 'complete' || info?.streaming === false) {
                await this._emulateStream(req, handlers, settleOk, settleErr);
            } else {
                await this._streamWithRetries(req, handlers, settleOk, settleErr);
            }
        } catch (e) {
            const err = toConsumerError(e);
            this._callHandler(() => handlers.error?.(err));
            settleErr(err);
        } finally {
            this._releaseGateSlot();
        }
    }

    /**
     * Emulacja strumienia dla dostawcy bez użytecznego streamu (xAI/CORS): jedno wywołanie
     * bez strumienia, cała treść jako jeden chunk, potem AWAITOWANE `done` i resolve.
     */
    private async _emulateStream(
        req: ChatRequest,
        handlers: StreamHandlers,
        settleOk: (value: OpenAiCompletion) => void,
        settleErr: (err: unknown) => void,
    ): Promise<void> {
        let response: OpenAiCompletion;
        try {
            response = await this._completeOnce(req);
        } catch (e) {
            const err = toConsumerError(e);
            this._callHandler(() => handlers.error?.(err));
            settleErr(err);
            return;
        }

        if (response.error) {
            const err = response.error;
            this._callHandler(() => handlers.error?.(err));
            settleErr(err);
            return;
        }

        this._callHandler(() => handlers.chunk?.(response));
        await this._callDone(handlers, response);
        settleOk(response);
    }

    /**
     * Jedno wywołanie toru bez strumienia — bez bramki, bo bramkę trzyma wołacz.
     *
     * Z tej metody wychodzi WYŁĄCZNIE {@link NormalizedError} (B.3 SM-17): pad sieci,
     * wybuch dostawcy przy składaniu żądania i nieczytelne ciało wyglądają dla konsumenta
     * tak samo jak błąd zwrócony przez API. Surowy `Error` z `fetch` bywa niesie adres,
     * a w nim klucz — stąd maska na granicy.
     */
    private async _completeOnce(req: ChatRequest): Promise<OpenAiCompletion> {
        let spec: HttpRequestSpec;
        try {
            spec = this._provider.buildRequest(req, this._ctx, false);
        } catch (e) {
            throw toConsumerError(e, 'Nie udało się złożyć żądania do modelu.');
        }

        let response: Awaited<ReturnType<HttpClient['send']>>;
        try {
            response = await this._http.send(spec);
        } catch (e) {
            throw toConsumerError(e, 'Model nie odpowiedział (brak połączenia).');
        }

        if (response.status >= 400) throw errorFromBody(response.text, response.status);

        let body: unknown;
        try {
            body = response.json();
        } catch {
            throw normalizeError('Model oddał odpowiedź, której nie da się odczytać jako JSON.', response.status);
        }

        try {
            return this._provider.parseCompletion(body, req, this._ctx);
        } catch (e) {
            throw toConsumerError(e, 'Nie udało się odczytać odpowiedzi modelu.');
        }
    }

    /**
     * Pętla ponowień po 429: próba początkowa + `STREAM_MAX_RETRIES` ponowień, backoff
     * wykładniczy od `STREAM_RETRY_BASE_DELAY_MS`, `Retry-After` ma pierwszeństwo.
     * Po wyczerpaniu sufitu tura ODRZUCA się błędem 429, a nie leci kolejne żądanie.
     */
    private async _streamWithRetries(
        req: ChatRequest,
        handlers: StreamHandlers,
        settleOk: (value: OpenAiCompletion) => void,
        settleErr: (err: unknown) => void,
    ): Promise<void> {
        for (let attempt = 0; attempt <= STREAM_MAX_RETRIES; attempt++) {
            if (this._cancelled || this._turnSettled) return;

            const outcome = await this._streamAttempt(req, handlers, settleOk, settleErr);
            if (outcome.kind === 'settled') return;

            if (attempt === STREAM_MAX_RETRIES) {
                this._failTurn(handlers, settleErr, outcome.error);
                return;
            }

            const backoff = STREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            await this._waitBeforeRetry(outcome.delayMs ?? backoff);
            if (this._cancelled || this._turnSettled) return;
        }
    }

    /** Okno backoffu z hakiem budzenia — po Stopie NIE leci kolejne, płatne żądanie. */
    private _waitBeforeRetry(ms: number): Promise<void> {
        return new Promise<void>(resolve => {
            let fired = false;
            const wake = (): void => {
                if (fired) return;
                fired = true;
                this._retryWake = undefined;
                resolve();
            };
            this._retryWake = wake;
            this._class().scheduleRetry(wake, ms);
        });
    }

    private _failTurn(handlers: StreamHandlers, settleErr: (err: unknown) => void, err: NormalizedError): void {
        this._callHandler(() => handlers.error?.(err));
        settleErr(err);
    }

    /**
     * JEDNA próba otwarcia strumienia.
     *
     * Tura kończy się albo z sinka (sentinel / błąd w paśmie — transport może wtedy nadal
     * wisieć), albo ze zwrotki `open()`. Dlatego obie drogi są tu ścigane, a nie czekane
     * po kolei.
     */
    private async _streamAttempt(
        req: ChatRequest,
        handlers: StreamHandlers,
        settleOk: (value: OpenAiCompletion) => void,
        settleErr: (err: unknown) => void,
    ): Promise<AttemptOutcome> {
        const decoder = this._provider.createStreamDecoder(req, this._ctx);
        const snapshot = emptyCompletion();

        let decided = false;
        let settleEnd!: (end: TurnEnd) => void;
        const ended = new Promise<TurnEnd>(resolve => { settleEnd = resolve; });
        const decide = (end: TurnEnd): void => {
            if (decided) return;
            decided = true;
            settleEnd(end);
        };

        const sink: StreamSink = {
            onChunk: (text: string): void => {
                if (decided || this._turnSettled) return;
                const droppedBefore = decoder.droppedFrames ?? 0;
                let events: StreamEvent[] = [];
                let threw = false;
                try {
                    events = decoder.feed(text) ?? [];
                } catch {
                    threw = true;
                }

                // Ostrzegamy WYŁĄCZNIE o porcji, której dekoder nie umiał przeczytać:
                // rzucił albo zgłosił wyrzuconą ramkę. Sama pustka po `feed()` znaczy tyle,
                // że ramka jeszcze nie dojechała ALBO nie niosła nic widocznego — u OpenAI
                // to pierwsza (`delta:{role}`) i przedostatnia (`finish_reason`) ramka tury,
                // więc dawna heurystyka robiła 2 fałszywe alarmy na turę w logu usera.
                if (threw || (decoder.droppedFrames ?? 0) > droppedBefore) {
                    log.warn(LOG_SCOPE, 'stream.chunk_parse_failed', {
                        provider: this.providerId,
                        head: maskSensitiveData(text.slice(0, CHUNK_LOG_HEAD_CHARS)),
                    });
                }

                if (events.length === 0) return;

                const { end, visible } = applyEvents(snapshot, events);
                if (visible && (!end || end.kind === 'done')) this._callHandler(() => handlers.chunk?.(snapshot));
                if (end) decide(end);
            },
        };

        const controller = new AbortController();
        this._abortController = controller;

        const spec: HttpRequestSpec = {
            ...this._provider.buildRequest(req, this._ctx, true),
        };
        if (spec.timeoutMs === undefined) spec.timeoutMs = STREAM_TRANSPORT_TIMEOUT_MS;

        const opened = this._transport.open(spec, sink, controller.signal).then(
            result => ({ kind: 'open' as const, result }),
            // `unknown`, nie domyślne `any`: transport może odrzucić czymkolwiek, a `toConsumerError`
            // i tak przyjmuje wszystko — bez tej adnotacji `any` przeciekałby dalej po cichu.
            (error: unknown) => ({ kind: 'openError' as const, error }),
        );

        const race = await Promise.race([
            ended.then(end => ({ kind: 'end' as const, end })),
            opened,
        ]);

        if (race.kind === 'end') {
            await this._finishTurn(decoder, snapshot, race.end, handlers, settleOk, settleErr);
            return { kind: 'settled' };
        }

        if (race.kind === 'openError') {
            if (this._turnSettled || this._cancelled) return { kind: 'settled' };
            const err = toConsumerError(race.error);
            this._failTurn(handlers, settleErr, err);
            return { kind: 'settled' };
        }

        const { status, headers, body } = race.result;

        if (status === 429) {
            return { kind: 'retry', error: errorFromBody(body, 429), delayMs: retryAfterMs(headers) };
        }

        if (status !== 200) {
            const err = body && body.trim() ? errorFromBody(body, status) : bodilessStreamError(status);
            this._failTurn(handlers, settleErr, err);
            return { kind: 'settled' };
        }

        // Sentinel przybyły RAZEM z domknięciem ciała WYGRYWA — decyzję o trzecim wyjściu
        // odraczamy o jedno makrozadanie, żeby ostatnia porcja zdążyła przejść przez dekoder.
        await new Promise<void>(resolve => { hostWindow.setTimeout(resolve, 0); });

        if (decided) {
            await this._finishTurn(decoder, snapshot, await ended, handlers, settleOk, settleErr);
            return { kind: 'settled' };
        }
        if (this._turnSettled) return { kind: 'settled' };

        decided = true;
        await this._closeWithoutSentinel(decoder, snapshot, handlers, settleOk, settleErr);
        return { kind: 'settled' };
    }

    /** Zdarzenia domykające dekodera — rezerwa parsera myślenia nie ma prawa rzucić. */
    private _finishDecoder(decoder: { finish(): StreamEvent[] }): StreamEvent[] {
        try {
            return decoder.finish() ?? [];
        } catch (e) {
            log.debug(LOG_SCOPE, 'decoder.finish rzucił — domykamy tym, co jest', String((e as Error)?.message ?? e));
            return [];
        }
    }

    /**
     * Buduje FINALNĄ odpowiedź: kopia snapshotu + zdarzenia z `finish()`.
     * Kopia jest obowiązkowa — `finish()` nie może zmutować obiektu, który poszedł już
     * do `handlers.chunk`.
     */
    private _sealSnapshot(decoder: { finish(): StreamEvent[] }, snapshot: OpenAiCompletion): OpenAiCompletion {
        const final = cloneCompletion(snapshot);
        applyEvents(final, this._finishDecoder(decoder));
        // Rollback niedomkniętego `<think>` kasuje myślenie, a nie zeruje go pustym stringiem.
        if (final.choices[0].message.reasoning_content === '') delete final.choices[0].message.reasoning_content;
        return final;
    }

    private async _finishTurn(
        decoder: { finish(): StreamEvent[] },
        snapshot: OpenAiCompletion,
        end: TurnEnd,
        handlers: StreamHandlers,
        settleOk: (value: OpenAiCompletion) => void,
        settleErr: (err: unknown) => void,
    ): Promise<void> {
        if (end.kind === 'error') {
            this._finishDecoder(decoder);
            this._failTurn(handlers, settleErr, end.error);
            return;
        }
        const final = this._sealSnapshot(decoder, snapshot);
        await this._callDone(handlers, final);
        settleOk(final);
    }

    /**
     * Trzecie wyjście: HTTP 200, ciało domknięte, sentinela nie było.
     *
     * Coś przyszło → oddajemy to, co przyszło (konsumenci rozstrzygają się WYŁĄCZNIE na
     * `handlers.done`, więc milczenie zawiesiłoby ich na zawsze). Nie przyszło nic →
     * odrzucenie ZDANIEM, żeby user zobaczył powód, a nie pustą bańkę.
     */
    private async _closeWithoutSentinel(
        decoder: { finish(): StreamEvent[] },
        snapshot: OpenAiCompletion,
        handlers: StreamHandlers,
        settleOk: (value: OpenAiCompletion) => void,
        settleErr: (err: unknown) => void,
    ): Promise<void> {
        const final = this._sealSnapshot(decoder, snapshot);
        const message = final.choices[0].message;
        const content = typeof message.content === 'string' ? message.content : '';
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

        log.warn(LOG_SCOPE, 'stream.closed_without_sentinel', {
            provider: this.providerId,
            chars: content.length,
            toolCalls: hasToolCalls,
        });

        if (!content && !hasToolCalls) {
            const err = normalizeError('Model zamknął połączenie bez żadnej treści i bez znacznika końca odpowiedzi.');
            this._failTurn(handlers, settleErr, err);
            return;
        }

        await this._callDone(handlers, final);
        settleOk(final);
    }
}

/**
 * Fabryka modelu z zależności — jedyna droga powstania {@link ChatModel}.
 *
 * @param deps Komplet zależności: dostawca, kontekst modelu, transport, bramka, ustawienia.
 */
export function createChatModel(deps: ChatModelDeps): ChatModel {
    return new ChatModel(deps);
}
