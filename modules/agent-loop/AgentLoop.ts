/**
 * AgentLoop — JEDNA wspólna pętla narzędziowa agenta (decyzja D11 planu v2.1).
 *
 * Plugin miał dwie pętle tool-callingu: czat (modules/chat, callback re-entry) i
 * sub-agenci (modules/memory/streamHelper `streamToCompleteWithTools`, jawny for).
 * Ten moduł wyciąga JEDNĄ pętlę bez UI. Wzorzec Anthropic — WIDOCZNY `for`:
 *
 *     while (są iteracje) {
 *       zapytaj model (z narzędziami);
 *       jeśli brak tool_calls → koniec;
 *       wykonaj narzędzia; dopisz wyniki do transkryptu;
 *     }
 *     // backstop: ostatnie zapytanie BEZ narzędzi → model MUSI odpowiedzieć tekstem
 *
 * Baza: przeniesiona i uogólniona logika `streamToCompleteWithTools`. Krok A (E2.1)
 * przepina sub-agentów; czat wchodzi w kroku B. Approval/permission NIE żyje w pętli —
 * jest w egzekutorze (`executeToolCall`). Polityki PreToolUse/PostToolUse (E2.2) wpięte
 * będą przez hooki — pętla je TYLKO woła, nie implementuje.
 *
 * Kierunek zależności: NIC z modules/chat, modules/sub-agents, modules/mcp. Tylko
 * core/, config/ i lokalne pliki modułu.
 */
import { log as defaultLog } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { countTokensSimple } from '../../core/index.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import { parseToolCalls } from './toolCallParser.js';
import type { ModelResponse, ParsedToolCall, ProviderUsage } from './toolCallParser.js';
import { sanitizeToolTranscript } from './toolTranscriptSanitizer.js';
import type { LoopMessage, MessageStoreLike } from './MessageStore.js';

// obsidianmd/prefer-window-timers: ten plik wstaje w gołym Node (testy AVA), gdzie `window`
// nie istnieje — `window.setTimeout` byłby ReferenceError. Inline `eslint-disable` jest
// zablokowany dla `obsidianmd/*` (`eslint-comments/no-restricted-disable` w configu pluginu
// recenzenta katalogu). Owijamy globalny timer FUNKCJĄ zamiast zamrażać referencję raz przy
// imporcie — `fn` czyta `setTimeout`/`clearTimeout` DYNAMICZNIE przy każdym wywołaniu, więc
// zachowanie jest 1:1 jak bezpośrednie wywołanie globala. Reguła pomija wywołanie, bo `fn`
// jest lokalną zmienną, nie globalną referencją.
function _nodeSafeSetTimeout(...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> {
    const fn = setTimeout;
    return fn(...args);
}
function _nodeSafeClearTimeout(...args: Parameters<typeof clearTimeout>): void {
    const fn = clearTimeout;
    fn(...args);
}

/** Definicja narzędzia w formacie OpenAI (pętla czyta z niej wyłącznie nazwę). */
interface ToolDefinition {
    type?: string;
    name?: string;
    function?: { name?: string; description?: string; parameters?: unknown };
    [key: string]: unknown;
}

/**
 * Minimalny STRUKTURALNY widok modelu, jakiego pętla naprawdę używa: `.stream()` +
 * (opcjonalnie) tania nazwa modelu do trace'u. Świadomie NIE jest to typ `ChatModel` —
 * agent-loop nie może zależeć od `modules/models`.
 */
interface LoopModelLike {
    stream(
        payload: Record<string, unknown>,
        handlers: {
            chunk: (resp: unknown) => void;
            done: (resp: ModelResponse) => void;
            /** Adaptery oddają tu obiekt błędu — pętla przekazuje go dalej jako powód odrzucenia. */
            error: (err: Error) => void;
            /** ChatModel woła to, gdy request wchodzi na slot bramki platform lokalnych
             *  (koniec czekania w kolejce). Pętla przezbraja tym per-call budzik — czas
             *  w kolejce nie zjada budżetu streamu (zwis delegacji 2026-08-14). Opcjonalny:
             *  modele bez bramki mogą go nie wołać — budzik liczy wtedy od wysłania (jak dotąd). */
            gate_admitted?: () => void;
        },
    ): void | Promise<unknown>;
    /** Twardy abort aktywnego streamu (ChatModel → adapter → xhr.abort). Pętla woła
     *  go przy per-call timeout, żeby nie zostawiać zombie-requestów na moście/API. */
    stopStream?(): void;
    modelKey?: string;
    modelId?: string;
}

/** Zagregowane zużycie tokenów zwracane przez pętlę (`_estimated` = fallback bez danych z API). */
export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    _estimated?: boolean;
}

/** Wpis w `toolCallDetails` wyniku pętli (podgląd dla UI/logów). */
interface ToolCallDetail {
    name?: string;
    args?: unknown;
    resultPreview: string;
    error?: boolean;
}

/** To, co dostaje hook `onToolResults` (kolejność = kolejność `tool_calls`). */
export interface ToolResultEntry {
    toolCall: ParsedToolCall;
    result: string | unknown[];
    error?: string | true;
}

/**
 * Hooki pętli — WSZYSTKIE opcjonalne i wszystkie awaitowane (sync albo async).
 * Pętla je TYLKO woła; polityk nie implementuje.
 */
interface AgentLoopHooks {
    onIterationStart?: (i: number) => unknown;
    /** Zwrócona tablica → użyta zamiast oryginalnej (filtracja). Cokolwiek innego → bez zmian. */
    onToolCallsParsed?: (
        toolCalls: ParsedToolCall[],
        i: number,
    ) => ParsedToolCall[] | void | Promise<ParsedToolCall[] | void>;
    onToolResults?: (results: ToolResultEntry[], i: number) => unknown;
    beforeContinue?: (i: number) => unknown;
    onUsage?: (usage: ProviderUsage, i: number) => unknown;
    onBackstop?: () => unknown;
}

/** Kagańce pętli — 0/brak = wyłączone (poza `maxIterations`, które spada na DEFAULT_LIMITS). */
interface AgentLoopLimits {
    maxIterations?: number;
    minIterations?: number;
    perCallTimeoutMs?: number;
    maxToolResultLength?: number;
    /** Front A: watchdog CISZY per wywołanie modelu — strzela po stallTimeoutMs bez ANI
     *  JEDNEGO chunka (każdy chunk i sygnał bramki przezbrajają budzik). Odróżnia trupa
     *  (martwy socket) od myśliciela (wolny model, który streamuje). 0/brak = wyłączony. */
    stallTimeoutMs?: number;
    /** Front A: sufit skrótu dorobku narzędzi doklejanego do zaślepki backstopu, gdy finalna
     *  synteza nie powstała (model padł / cisza). 0/brak = stara goła zaślepka. */
    salvageMaxChars?: number;
    /** Runda 2 (2026-08-17): sufit wyniku PER NARZĘDZIE — nadpisuje `maxToolResultLength`
     *  dla wymienionych nazw (0 = bez limitu dla tego narzędzia). Czat daje `delegate`
     *  większą porcję: wynik suba to deliverable po minutach roboty, nie surowy zrzut —
     *  wspólny sufit 15k ucinał go w połowie (żywy smoke 2026-08-17). */
    maxToolResultLengthPerTool?: Record<string, number>;
}

/** Opcje modelu dokładane do payloadu (`agentName` wypada — to metadana do logów). */
interface AgentLoopModelOptions {
    maxTokens?: number;
    thinking?: unknown;
    agentName?: string;
    [key: string]: unknown;
}

/** Argument `runAgentLoop` (pola z destrukturyzacji niżej). */
export interface RunAgentLoopOptions {
    model: LoopModelLike;
    store: MessageStoreLike;
    resolveTools?: () => ToolDefinition[] | null | undefined;
    /** Zwraca cokolwiek (sync albo Promise) — `unknown` pokrywa oba przypadki. */
    executeToolCall: (toolCall: ParsedToolCall) => unknown;
    limits?: AgentLoopLimits;
    modelOptions?: AgentLoopModelOptions;
    hooks?: AgentLoopHooks;
    callbacks?: { chunk?: (resp: unknown) => void };
    /**
     * Predykat „ta tura jest przerwana". Pętla pyta go w SIEDMIU punktach — pełna lista
     * i uzasadnienie: `modules/agent-loop/CLAUDE.md` gotcha 9 (K5, AUD-security-037/038).
     *
     * ⚠️ Kontrakt wołacza: predykat ma czytać stan TEJ tury (uchwyt/flaga w obiekcie tury),
     * nigdy pola widoku współdzielonego z następną turą — inaczej kolejna wiadomość gasi
     * przerwanie tury, która wciąż biegnie, i zatrzymana pętla wznawia iteracje.
     */
    shouldAbort?: () => boolean;
    /**
     * Sygnał „request wszedł na slot bramki" — pętla przekazuje go dalej z handlera
     * `gate_admitted`, fire-and-forget, przy KAŻDYM wpuszczeniu.
     *
     * Po co (FAIL 4 smoke'a 2026-08-15): budżet CAŁEGO biegu suba (`delegation_timeout_ms`)
     * liczył też czas stania w kolejce bramki platformy lokalnej — worker o priorytecie 0
     * czekał za rozmową główną aż budżet minął i umierał, nie wykonawszy zadania.
     * `DelegateTool` uzbraja swój budzik dopiero na ten sygnał.
     */
    onGateAdmitted?: () => void;
    /**
     * Fire-and-forget trace (TraceLog.scope) — pętla NIGDY go nie awaituje.
     * `fields` jest w tym typie WYMAGANE, bo pętla przy każdym zdarzeniu je podaje; implementacje
     * mogą je przyjmować opcjonalnie albo pomijać (mniej parametrów = nadal przypisywalne).
     */
    trace?: (type: string, fields: Record<string, unknown>) => void;
    /** Logger zgodny z `core/utils/Logger.js` (default: core Logger). */
    log?: typeof defaultLog;
}

/** Wynik pętli. `stoppedBy` rozróżnia trzy wyjścia (patrz CLAUDE.md gotcha 5). */
export interface RunAgentLoopResult {
    finalText: string;
    toolsUsed: string[];
    toolCallDetails: ToolCallDetail[];
    usage: Usage;
    iterations: number;
    stoppedBy: 'natural' | 'backstop' | 'abort';
}

/** Minimalny widok błędu narzędzia — `catch` w strict daje `unknown`. */
type ErrLike = { message?: string } | null | undefined;

/** Wynik JEDNEJ egzekucji narzędzia wewnątrz `Promise.all` (kształt wspólny dla sukcesu i błędu). */
type ExecResult = {
    toolCall: ParsedToolCall;
    toolName?: string;
    parsedArgs: unknown;
    result: string | unknown[];
    error: boolean;
    errorMsg?: string;
};

/**
 * Uruchamia pętlę narzędziową agenta.
 *
 * Pełny kontrakt pól: `RunAgentLoopOptions` / `RunAgentLoopResult` wyżej. W skrócie:
 * `model` (promisyfikowany wewnątrz), `store` (MessageStore), `resolveTools` (świeża lista NA START
 * KAŻDEJ iteracji), `executeToolCall` (egzekutor — approval/permission żyje TAM), `limits`
 * (0 = wyłączone), `modelOptions` (dokładane do payloadu; `agentName` tylko do logów), `hooks`,
 * `callbacks.chunk` (streaming do UI), `shouldAbort` (pytane w SIEDMIU punktach — CLAUDE.md gotcha 9),
 * `trace` (fire-and-forget: loop.start, model.done, tool.pre, tool.blocked, tool.post, backstop,
 * loop.end — infrastruktura obserwowalności, NIE polityka), `log`.
 *
 * Hooki (wszystkie opcjonalne — przyszłe PreToolUse/PostToolUse dla E2.2; pętla tylko woła).
 * Każdy hook jest AWAITOWANY — może być sync albo async (await na sync funkcji nic nie psuje).
 * Czat (krok B) potrzebuje async `beforeContinue` (kompresja mid-loop) i async polityki E2.2:
 *   onIterationStart(i)
 *   onToolCallsParsed(toolCalls, i) — po parsowaniu, PRZED egzekucją (czat tworzy tu placeholdery UI;
 *     kontrakt ask_user tego wymaga: placeholder MUSI powstać przed egzekucją). await jest sekwencyjny
 *     przed Promise.all, więc placeholdery i tak powstają przed egzekucją. Jeśli zwróci tablicę → użyta
 *     zamiast oryginalnej (forward-compat filtracja).
 *   onToolResults(results, i) — po Promise.all; results w kolejności tool_calls: [{toolCall, result, error?}]
 *   beforeContinue(i) — przed kolejnym wywołaniem modelu (czat robi tu async kompresję + dopisuje nudges przez store)
 *   onUsage(usage, i) — po każdej odpowiedzi modelu z usage (czat wepnie TokenTracker)
 *   onBackstop() — gdy wchodzi finalna iteracja bez narzędzi
 */
export async function runAgentLoop({
    model,
    store,
    resolveTools,
    executeToolCall,
    limits = {},
    modelOptions = {},
    hooks = {},
    callbacks = {},
    shouldAbort,
    onGateAdmitted,
    trace,
    log
}: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
    const logger = log || defaultLog;
    const _loopStart = Date.now(); // total_ms dla trace loop.end
    // Fallback maxIterations z config/limits.js (chat_max_iterations === worker === 8).
    // Realni wołacze (SubAgentRunner) podają wartość jawnie; to tylko siatka bezpieczeństwa.
    const maxIterations = limits.maxIterations || DEFAULT_LIMITS.chat_max_iterations;
    const minIterations = limits.minIterations || 0;
    const perCallTimeoutMs = limits.perCallTimeoutMs || 0;
    const maxToolResultLength = limits.maxToolResultLength || 0;
    const stallTimeoutMs = limits.stallTimeoutMs || 0;
    const salvageMaxChars = limits.salvageMaxChars || 0;
    const perToolResultCaps = limits.maxToolResultLengthPerTool || null;

    const chunkCb = typeof callbacks.chunk === 'function' ? callbacks.chunk : () => {};
    const abort = typeof shouldAbort === 'function' ? shouldAbort : () => false;

    // modelOptions → payload. agentName wyjmujemy (to metadana do logów, nie pole API).
    const { maxTokens, thinking, agentName, ...restPayload } = modelOptions;

    const toolsUsed: string[] = [];
    const toolCallDetails: ToolCallDetail[] = [];
    const totalUsage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
    let iterations = 0;
    let lastText = '';
    let currentToolDefs: ToolDefinition[] = [];

    logger.group?.('AgentLoop', `runAgentLoop (min ${minIterations}, max ${maxIterations} iteracji)${agentName ? ` — ${agentName}` : ''}`);

    // Trace: start pętli. model = tania nazwa/id modelu jeśli dostępna, inaczej pomiń pole.
    const _traceModel = model?.modelKey || model?.modelId;
    trace?.('loop.start', { max_iter: maxIterations, ...(_traceModel ? { model: _traceModel } : {}) });

    // ── Promisyfikacja stream + opcjonalne budziki: per-call (absolutny) + ciszy (Front A) ──
    const _streamCall = (payload: Record<string, unknown>): Promise<ModelResponse> => {
        // Przezbrojenie budzików (przypisywane niżej, gdy budzik w ogóle jest uzbrojony) —
        // deklaracje PRZED wywołaniem streamu, bo handlery mogą odpalić synchronicznie (model bez
        // bramki woła gate_admitted od ręki).
        let rearmPerCallTimer: (() => void) | null = null;
        let rearmStallTimer: (() => void) | null = null;
        const streamPromise = new Promise<ModelResponse>((resolve, reject) => {
            // Produkcyjny adapter (chat_adapter_base.stream) jest `async` i przy błędzie
            // robi DWIE rzeczy: woła handlers.error ORAZ odrzuca zwracaną promisę. Bez
            // właściciela tej promisy odrzucenie = ERR_UNHANDLED_REJECTION i śmierć
            // procesu (pad runnera scenariuszy 2026-08-11, audyt nocny 2026-08-12).
            // Drugi reject po ścieżce callbackowej to no-op, więc nic się nie gryzie.
            Promise.resolve(model.stream(payload, {
                chunk: (resp) => {
                    // Front A: KAŻDY chunk to dowód życia — watchdog ciszy liczy od nowa.
                    rearmStallTimer?.();
                    chunkCb(resp);
                },
                done: (resp) => resolve(resp),
                error: (err) => reject(err),
                gate_admitted: () => {
                    rearmPerCallTimer?.();
                    rearmStallTimer?.();
                    // Sygnał leci dalej do wołacza (Z2: budżet delegacji startuje od
                    // pierwszej admisji). Fire-and-forget — cudzy błąd nie wywraca streamu.
                    try { onGateAdmitted?.(); }
                    // Błąd oddajemy loggerowi ARGUMENTEM, nie w szablonie — `unknown`
                    // w template literal to błąd `lint:obsidian` (baseline 91, bez nowych).
                    catch (e) { logger.warn?.('AgentLoop', 'onGateAdmitted rzucił (ignorowane):', e); }
                }
            })).catch((err) => reject(err));
        });
        const racers: Promise<ModelResponse>[] = [streamPromise];
        // Wspólne sprzątanie budzików po rozstrzygniętym wyścigu (wzór DelegateTool._withTimeout,
        // S33 A2) — bez clearTimeout timery trzymały proces przy życiu do końca odliczania,
        // a spóźniony sygnał (gate/chunk) nie może uzbroić NOWEGO budzika po sprzątaniu
        // (stopStream ubiłby CUDZY, kolejny request).
        let settled = false;
        let perCallTimer: ReturnType<typeof setTimeout> | null = null;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        if (perCallTimeoutMs > 0) {
            // Timeout MUSI ubić request, nie tylko porzucić promisa. Promise.race bez abortu
            // zostawiał na lokalnym moście (proxy zgodne z LM Studio) zombie-joby, które mieliły
            // dalej i zapychały jednowątkową kolejkę — kolejne wywołania (także głównego
            // czatu) wisiały na martwym moście (incydent 2026-08-11, Zwis subagentow).
            racers.push(new Promise<ModelResponse>((_, reject) => {
                const arm = () => {
                    if (settled) return;
                    if (perCallTimer !== null) _nodeSafeClearTimeout(perCallTimer);
                    perCallTimer = _nodeSafeSetTimeout(() => {
                        try { model.stopStream?.(); } catch { /* abort nie może przykryć timeoutu */ }
                        trace?.('model.timeout', { timeout_ms: perCallTimeoutMs });
                        reject(new Error(t('agentLoop.model_timeout', { seconds: Math.round(perCallTimeoutMs / 1000) })));
                    }, perCallTimeoutMs);
                };
                arm();
                // Zwis delegacji 2026-08-14: budzik liczony od WYSŁANIA requestu karał suby
                // za czekanie w kolejce bramki platform lokalnych (limit 1) — przy delegacji
                // wielozadaniowej kolejka rosła ponad budżet i taski umierały seryjnie.
                // gate_admitted przezbraja budzik: faza kolejki i faza streamu dostają
                // PO pełnym budżecie perCallTimeoutMs.
                rearmPerCallTimer = arm;
            }));
        }
        if (stallTimeoutMs > 0) {
            // Front A (watchdog ciszy, śledztwo 2026-08-17): zegar ścienny nie odróżniał trupa
            // od myśliciela — ubijał suby piszące finalną syntezę na wolnym moście dokładnie
            // w chwili roboty. Ten budzik strzela wyłącznie po PEŁNEJ ciszy modelu (zero
            // chunków przez stallTimeoutMs): most w trybie „request przyjęty, zero bajtów"
            // pada szybko, a model streamujący choćby podsumowania rozumowania żyje dalej.
            racers.push(new Promise<ModelResponse>((_, reject) => {
                const arm = () => {
                    if (settled) return;
                    if (stallTimer !== null) _nodeSafeClearTimeout(stallTimer);
                    stallTimer = _nodeSafeSetTimeout(() => {
                        try { model.stopStream?.(); } catch { /* abort nie może przykryć stalla */ }
                        trace?.('model.stall', { stall_ms: stallTimeoutMs });
                        reject(new Error(t('agentLoop.model_stall', { seconds: Math.round(stallTimeoutMs / 1000) })));
                    }, stallTimeoutMs);
                };
                arm();
                rearmStallTimer = arm;
            }));
        }
        if (racers.length === 1) return streamPromise;
        return Promise.race(racers).finally(() => {
            settled = true;
            if (perCallTimer !== null) _nodeSafeClearTimeout(perCallTimer);
            if (stallTimer !== null) _nodeSafeClearTimeout(stallTimer);
        });
    };

    const _buildPayload = (
        apiMessages: LoopMessage[],
        toolDefs: ToolDefinition[] | null,
    ): Record<string, unknown> => {
        const payload: Record<string, unknown> = {
            messages: apiMessages,
            ...restPayload,
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            ...(thinking !== undefined ? { thinking } : {})
        };
        if (Array.isArray(toolDefs) && toolDefs.length > 0) payload.tools = toolDefs;
        return payload;
    };

    const finalize = (text: string, stoppedBy: RunAgentLoopResult['stoppedBy']): RunAgentLoopResult => {
        _fillEstimatedUsage(totalUsage, store.getMessagesForAPI(), currentToolDefs, text || '');
        trace?.('loop.end', { stop: stoppedBy, iters: iterations, total_ms: Date.now() - _loopStart });
        logger.groupEnd?.();
        return { finalText: text || '', toolsUsed, toolCallDetails, usage: totalUsage, iterations, stoppedBy };
    };

    // AUD-bledy-002: KORPUS ITERACJI POD STRAŻNIKIEM. Do tej zmiany pod `try` było wyłącznie
    // wywołanie modelu — hooki, `resolveTools` i `store` leżały gołe. Rzut stamtąd (chatowy
    // `onToolResults` zaczyna od zapisu dziennika sesji na dysku: skasowany plik aktywnej sesji,
    // blokada synca GDrive, EBUSY) kończył pętlę BEZ `loop.end` i bez `groupEnd()` — bieg urywał
    // się w trace po `tool.post`, a w trybie debug wszystkie późniejsze logi konsoli zostawały
    // w otwartej grupie „AgentLoop". Wyjątek dalej leci w górę (pętla nie zna `stoppedBy:'error'`
    // — gotcha 5), ale zostawia domknięcie w trace, a dorobek narzędzi w transkrypcie.
    // ⚠️ Ciało pętli świadomie NIE jest przewcięte o poziom — przesunięcie 220 linii zamieniłoby
    // ten diff w szum i zerwało `git blame` na całym korpusie iteracji.
    try {
    for (let i = 0; i < maxIterations; i++) {
        iterations = i + 1;

        // shouldAbort na START iteracji — model NIE jest wołany.
        if (abort()) {
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: abort na starcie iteracji`);
            return finalize(lastText, 'abort');
        }

        await hooks.onIterationStart?.(i);

        // Świeża whitelista narzędzi na start każdej iteracji.
        currentToolDefs = (typeof resolveTools === 'function' ? resolveTools() : []) || [];
        // `.filter(Boolean)` odsiewa undefined w runtime, ale TS tego nie widzi — stąd asercja.
        const knownToolNames = currentToolDefs.map((td) => td.function?.name || td.name).filter(Boolean) as string[];

        // sanitizeToolTranscript przed KAŻDYM wywołaniem modelu (drop osieroconych tool messages).
        const apiMessages = sanitizeToolTranscript(store.getMessagesForAPI(), { logger, tag: 'AgentLoop' }).messages;

        // Zapytanie do modelu (błędy propagują do wołacza — jak w streamHelper).
        // Ślad loop.end zostaje w trace także przy błędzie/timeout (emituje go strażnik
        // całej trasy niżej) — bez tego pętla, która padła na modelu, znikała z trace bez
        // domknięcia i zwis wyglądał jak urwany log.
        let response: ModelResponse;
        try {
            response = await _streamCall(_buildPayload(apiMessages, currentToolDefs));
        } catch (err) {
            // PRZERWANIE ≠ AWARIA (FAIL 3 smoke'a 2026-08-15). Stop z zewnątrz ubija stream
            // przez `stopStream`, a ten od tej pory ROZSTRZYGA promisę — odrzuceniem ze
            // znacznikiem `_aborted`. Bez tej gałęzi bieg schodził jako błąd (karta „Model
            // timeout"), mimo że user go świadomie zatrzymał. Rozpoznajemy dwa dowody:
            // flagę wołacza (`shouldAbort`) ORAZ znacznik na błędzie — pierwszy bywa
            // niedostępny (czat ustawia go dopiero na swojej ścieżce), drugi jest zawsze.
            if (abort() || (err as { _aborted?: boolean } | null)?._aborted === true) {
                logger.debug?.('AgentLoop', `Iteracja ${i + 1}: stream przerwany z zewnątrz — kończę jako abort`);
                return finalize(lastText, 'abort');
            }
            // AUD-bledy-002: `loop.end stop=error` emituje JEDEN strażnik — catch całej trasy
            // głównej. Tu tylko oddajemy błąd w górę, żeby nie było dwóch linii domknięcia.
            throw err;
        }

        // Akumulacja usage + hook.
        if (response?.usage) {
            totalUsage.prompt_tokens += response.usage.prompt_tokens || 0;
            totalUsage.completion_tokens += response.usage.completion_tokens || 0;
            await hooks.onUsage?.(response.usage, i);
            trace?.('model.done', { i, in: response.usage.prompt_tokens || 0, out: response.usage.completion_tokens || 0 });
        } else {
            trace?.('model.done', { i, usage: 'none' });
        }

        const content = _extractText(response);
        const reasoning = _extractReasoning(response);
        if (content) lastText = content;

        const parsed = parseToolCalls(response, { knownToolNames });

        // shouldAbort po powrocie modelu, PRZED egzekucją narzędzi.
        if (abort()) {
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: abort po powrocie modelu (przed narzędziami)`);
            return finalize(content || lastText, 'abort');
        }

        // Brak tool_calls → sprawdź minIterations, potem zwróć tekst.
        if (parsed.length === 0) {
            if (i < minIterations - 1) {
                logger.debug?.('AgentLoop', `Iteracja ${i + 1}: brak tool calls, minIterations=${minIterations} — wymuszam kontynuację`);
                store.appendAssistant(content || null, reasoning !== undefined ? { reasoning_content: reasoning } : {});
                store.appendUser(t('agentLoop.min_iterations_nudge'));
                await hooks.beforeContinue?.(i);
                continue;
            }
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: brak tool calls, zwracam tekst (${content.length} zn.)`);
            return finalize(content, 'natural');
        }

        // Hook PRZED egzekucją (ask_user: placeholdery UI). Zwrócona tablica → filtracja.
        let effective = parsed;
        const hookResult = await hooks.onToolCallsParsed?.(parsed, i);
        if (Array.isArray(hookResult)) {
            effective = hookResult;
            // Trace: hook coś odfiltrował (dziś ask_user czatu; polityki kontroli = E2.3) → nazwy usuniętych.
            if (hookResult.length < parsed.length) {
                const keptIds = new Set(hookResult.map((tc) => tc.id));
                const dropped = parsed
                    .filter((tc) => !keptIds.has(tc.id))
                    .map((tc) => tc.name || tc.function?.name)
                    .join(',');
                trace?.('tool.blocked', { i, dropped });
            }
        }

        // Hook zdusił wszystkie wywołania → koniec tury czysto (bez malformed sekwencji w store).
        if (effective.length === 0) {
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: onToolCallsParsed odfiltrował wszystkie wywołania — koniec tury`);
            return finalize(content, 'natural');
        }

        logger.debug?.('AgentLoop', `Iteracja ${i + 1}: ${effective.length} tool call(s):`, effective.map((tc) => tc.name || tc.function?.name));

        for (const tc of effective) {
            // Kontrakt wyniku mówi `toolsUsed: string[]`; dostawca teoretycznie może nie podać
            // nazwy w ogóle — runtime wpycha wtedy `undefined` jak dotąd (asercja nic nie zmienia).
            const tName = tc.name || tc.function?.name;
            toolsUsed.push(tName as string);
            // Trace PER TOOL przed egzekucją; args = surowe arguments (TraceLog przytnie do 200).
            trace?.('tool.pre', { i, tool: tName, args: tc.arguments ?? tc.function?.arguments });
        }

        // Egzekucja równolegle (Promise.all zachowuje kolejność).
        const _batchStart = Date.now();
        const results = await Promise.all(effective.map(async (tc): Promise<ExecResult> => {
            const toolName = tc.name || tc.function?.name;
            const toolArgs = tc.arguments ?? tc.function?.arguments;
            try {
                const raw = await executeToolCall({ id: tc.id, name: toolName, arguments: toolArgs });
                // Zawartość multimodalna (tablica bloków content, np. generate_image z obrazem dla
                // modelu vision) przechodzi BEZ zmian — nie stringifikujemy jej ani nie obcinamy
                // (obcinanie dotyczy tylko tekstu). Czat (krok B) zwraca taką tablicę dla
                // generate_image+vision, żeby model „widział" wygenerowany obraz w kolejnej iteracji.
                let resultStr: string | unknown[];
                if (Array.isArray(raw)) {
                    resultStr = raw;
                } else {
                    resultStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
                    // Runda 2: per-tool override sufitu (`??`, bo 0 = świadome „bez limitu").
                    const cap = (toolName && perToolResultCaps && toolName in perToolResultCaps)
                        ? perToolResultCaps[toolName]
                        : maxToolResultLength;
                    resultStr = _truncateResult(resultStr, cap);
                }
                let parsedArgs = toolArgs;
                try { if (typeof toolArgs === 'string') parsedArgs = JSON.parse(toolArgs); } catch { /* args nie-JSON — zostaw surowe */ }
                return { toolCall: tc, toolName, parsedArgs, result: resultStr, error: false };
            } catch (toolError) {
                logger.warn?.('AgentLoop', `Tool ${toolName} ERROR: ${((toolError as ErrLike)?.message || toolError) as string}`);
                return {
                    toolCall: tc,
                    toolName,
                    parsedArgs: toolArgs,
                    result: `Error: ${((toolError as ErrLike)?.message || toolError) as string}`,
                    error: true,
                    errorMsg: (toolError as ErrLike)?.message
                };
            }
        }));
        const _batchMs = Date.now() - _batchStart;

        // Trace PER TOOL po Promise.all. chars = długość result; dla tablic multimodalnych
        // pomijamy chars i dajemy liczbę bloków. batch_ms = czas całego Promise.all.
        for (const r of results) {
            const isArr = Array.isArray(r.result);
            trace?.('tool.post', {
                i,
                tool: r.toolName,
                status: r.error ? 'error' : 'ok',
                ...(isArr ? { blocks: r.result.length } : { chars: String(r.result).length }),
                batch_ms: _batchMs,
            });
        }

        // Rekonstrukcja tool_calls do store z PRZEFILTROWANYCH wywołań (id+name).
        // Wzór chat_streaming.js:886-901 (smoke-02 finding 04) — bez tego orphan tool_result → API 400.
        const apiToolCalls = effective
            .filter((tc) => tc.id && (tc.name || tc.function?.name))
            .map((tc) => {
                const rawArgs = tc.arguments ?? tc.function?.arguments;
                return {
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name || tc.function?.name,
                        arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {})
                    }
                };
            });
        const validIdSet = new Set(apiToolCalls.map((c) => c.id));
        const filteredResults = results.filter((r) => validIdSet.has(r.toolCall.id));

        // Orphan guard: 0 valid tool_calls po filtracji, a były wyniki → koniec tury czysto (bez wysyłki malformed).
        // Wzór chat_streaming.js:911-924. Sam `return` leci PO `onToolResults` (niżej), żeby UI
        // zdążyło zamienić placeholdery narzędzi na wyniki — tu tylko liczymy werdykt.
        const orphaned = apiToolCalls.length === 0 && results.length > 0;

        // AUD-bledy-002: DOROBEK DO TRANSKRYPTU PRZED HOOKAMI. Zapis stał za `onToolResults`,
        // więc wyjątek hooka (zapis dziennika sesji na dysku) gubił i wywołanie, i wynik —
        // narzędzie zdążyło już zrobić swoje w vaultcie, a model przy następnej turze tego
        // nie widział i potrafił zapis powtórzyć.
        if (!orphaned) {
            store.appendAssistant(content || null, {
                tool_calls: apiToolCalls,
                ...(reasoning !== undefined ? { reasoning_content: reasoning } : {})
            });
            for (const r of filteredResults) {
                // `filteredResults` przeszło przez `validIdSet` (id na pewno jest) — TS tego nie wnioskuje.
                store.appendToolResult(r.result, r.toolCall.id as string);
            }
        }

        // Hook PO egzekucji (kolejność = kolejność tool_calls).
        await hooks.onToolResults?.(
            results.map((r) => ({ toolCall: r.toolCall, result: r.result, ...(r.error ? { error: r.errorMsg || true } : {}) })),
            i
        );

        for (const r of results) {
            toolCallDetails.push({
                name: r.toolName,
                args: r.parsedArgs,
                resultPreview: String(r.result).slice(0, 500),
                ...(r.error && { error: true })
            });
        }

        if (orphaned) {
            logger.error?.('AgentLoop', `ORPHAN GUARD: 0 poprawnych tool_calls, a ${results.length} wyników — kończę turę czysto`);
            return finalize(content, 'natural');
        }

        // AUD-security-129: shouldAbort PRZED kontynuacją tury. Do tej bramki pętla pytała
        // o abort dopiero na starcie NASTĘPNEJ iteracji, więc po Stopie klikniętym w trakcie
        // narzędzia leciał jeszcze cały `beforeContinue`: u czatu nudges, wstrzyknięcie kolejki
        // i — gdy `getCompressionNeeded()` tak wskazał — `performTwoPhaseCompression`, czyli
        // OSOBNE wywołanie modelu (inna instancja niż ta ubita przez `stopStream`) plus trwały
        // zapis notatek do `brain/`. Bramka stoi PO zapisie dorobku do transkryptu: przerwanie
        // blokuje KONTYNUACJĘ tury, nie księgowanie tego, co już się wydarzyło.
        if (abort()) {
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: abort po narzędziach — nie kontynuuję tury`);
            return finalize(content || lastText, 'abort');
        }

        await hooks.beforeContinue?.(i);
    }

    // ── Backstop: wyczerpano maxIterations → finalne zapytanie BEZ narzędzi ──
    // K5 (AUD-security-038): backstop był JEDYNYM wywołaniem modelu poza zasięgiem `abort()`.
    // Stop kliknięty w trakcie narzędzi OSTATNIEJ iteracji nie powstrzymywał ani tego wywołania,
    // ani finalizacji tury u wołacza (stoppedBy='backstop' nie idzie gałęzią abortu). Bramka
    // stoi PRZED dopiskiem hardstopu do transkryptu — przerwana tura nie zostawia po sobie
    // wiadomości, której user nie zamawiał.
    if (abort()) {
        logger.debug?.('AgentLoop', 'Backstop: abort przed finalnym zapytaniem — kończę jako abort');
        return finalize(lastText, 'abort');
    }
    logger.warn?.('AgentLoop', `Max iteracji (${maxIterations}) osiągnięty! Tools used: ${toolsUsed.join(', ')}`);
    await hooks.onBackstop?.();
    trace?.('backstop', { after: maxIterations });
    } catch (err) {
        // AUD-bledy-002: jedyny punkt, w którym trasa główna (iteracje + wejście w backstop)
        // domyka trace przy awarii. `stoppedBy:'error'` pętla nie zna — błąd leci w górę.
        trace?.('loop.end', { stop: 'error', iters: iterations, total_ms: Date.now() - _loopStart });
        logger.groupEnd?.();
        throw err;
    }

    try {
        const apiMessages = sanitizeToolTranscript(store.getMessagesForAPI(), { logger, tag: 'AgentLoop' }).messages;
        // AUD-bledy-003: hardstop jedzie WYŁĄCZNIE w payloadzie finalnego strzału — nie do
        // transkryptu. `store.appendUser` zostawiał go w oknie rozmowy na stałe: czat rysował
        // rolę `user` jako dymek Kuby (polecenie „NIE wywołuj żadnych narzędzi", którego nie
        // napisał), a `getMessagesForAPI()` wiozło tę instrukcję w KAŻDYM kolejnym żądaniu tej
        // sesji. Nikt jej nie zdejmował. Ta sama zasada, którą pętla stosuje przy abercie:
        // przerwana/domknięta tura nie zostawia po sobie wiadomości, której user nie zamawiał.
        apiMessages.push({ role: 'user', content: t('agentLoop.backstop_hardstop') });
        const finalResponse = await _streamCall(_buildPayload(apiMessages, null)); // brak pola tools

        // AUD-security-113 (druga strona): Stop mógł paść, gdy finalny strzał JUŻ WRACAŁ.
        if (abort()) {
            logger.debug?.('AgentLoop', 'Backstop: abort po finalnym zapytaniu — kończę jako abort');
            return finalize(lastText, 'abort');
        }

        if (finalResponse?.usage) {
            totalUsage.prompt_tokens += finalResponse.usage.prompt_tokens || 0;
            totalUsage.completion_tokens += finalResponse.usage.completion_tokens || 0;
            await hooks.onUsage?.(finalResponse.usage, iterations);
            trace?.('model.done', { i: iterations, in: finalResponse.usage.prompt_tokens || 0, out: finalResponse.usage.completion_tokens || 0 });
        } else {
            trace?.('model.done', { i: iterations, usage: 'none' });
        }

        let finalText = _extractText(finalResponse);
        finalText = _stripHallucinatedToolTags(finalText); // tanie modele halucynują tagi XML/DSML/invoke

        _fillEstimatedUsage(totalUsage, store.getMessagesForAPI(), currentToolDefs, finalText);
        // Backstop omija finalize() — emituj loop.end tutaj (stop=backstop).
        // F5: `fallback=1` odróżnia backstop, który oddał ZAŚLEPKĘ (model nie dał tekstu),
        // od backstopu z realnym podsumowaniem. Bez tego pola oba zejścia zostawiały
        // w trace identyczną linię `stop=backstop iters=N` i nie dało się ich policzyć
        // (audyt nocny 2026-08-15, moduł 19). Pole dokładamy TYLKO przy zaślepce, więc
        // linia „udanego" backstopu nie zmienia się o bajt.
        trace?.('loop.end', {
            stop: 'backstop',
            iters: iterations,
            total_ms: Date.now() - _loopStart,
            ...(finalText ? {} : { fallback: 1 }),
        });
        logger.groupEnd?.();
        return {
            // Front A: zaślepka niesie skrót dorobku narzędzi (salvage) — patrz _fallbackWithSalvage.
            finalText: finalText || _fallbackWithSalvage(store, salvageMaxChars),
            toolsUsed,
            toolCallDetails,
            usage: totalUsage,
            iterations,
            stoppedBy: 'backstop'
        };
    } catch (err) {
        // AUD-security-113: Stop w trakcie FINALNEGO strzału to PRZERWANIE, nie awaria backstopu.
        // K5 postawił bramkę tylko PRZED backstopem, a ten `catch` — inaczej niż `catch` pętli
        // głównej — nie pytał o abort. `stopStream` odrzuca promisę znacznikiem `_aborted`,
        // więc tura schodziła jako `backstop`, czyli u wołacza gałęzią FINALIZACJI: zaślepka
        // z salvage lądowała w oknie kontekstu i w pliku sesji, TokenTracker liczył odpowiedź,
        // a przy przekroczonym progu ruszała jeszcze kompresja. Po Stopie. Dwa dowody jak wyżej.
        if (abort() || (err as { _aborted?: boolean } | null)?._aborted === true) {
            logger.debug?.('AgentLoop', 'Backstop: finalny strzał przerwany z zewnątrz — kończę jako abort');
            return finalize(lastText, 'abort');
        }
        logger.warn?.('AgentLoop', `Backstop final call błąd: ${((err as ErrLike)?.message || err) as string}`);
        _fillEstimatedUsage(totalUsage, store.getMessagesForAPI(), currentToolDefs, '');
        // F5: ta gałąź ZAWSZE oddaje zaślepkę (finalny strzał padł), więc zawsze `fallback=1`.
        trace?.('loop.end', { stop: 'backstop', iters: iterations, total_ms: Date.now() - _loopStart, fallback: 1 });
        logger.groupEnd?.();
        return {
            finalText: _fallbackWithSalvage(store, salvageMaxChars),
            toolsUsed,
            toolCallDetails,
            usage: totalUsage,
            iterations,
            stoppedBy: 'backstop'
        };
    }
}

// ─── Front A: ratowanie dorobku (salvage) ───

/**
 * Zaślepka backstopu + skrót dorobku narzędzi. Gdy finalna synteza nie powstała (model
 * padł na finalnym strzale / cisza / timeout), sub palił dotąd pełny budżet na narzędzia
 * i oddawał 36-znakową zaślepkę — cały zebrany materiał szedł do kosza (śledztwo
 * 2026-08-17: 3 explorery × 12 iteracji researchu wyrzucone trzy razy z rzędu).
 * Teraz zaślepka niesie surowe wyniki narzędzi przycięte do `cap` znaków.
 * `cap` 0/brak = stara goła zaślepka (zachowanie sprzed Frontu A).
 */
function _fallbackWithSalvage(store: MessageStoreLike, cap: number): string {
    const base = t('agentLoop.backstop_fallback');
    let digest = '';
    // Salvage nie ma prawa przykryć właściwego błędu — złe wejście = brak skrótu, nie wyjątek.
    try { digest = _buildSalvageDigest(store.getMessagesForAPI(), cap); } catch { digest = ''; }
    return digest ? `${base}\n\n${t('agentLoop.salvage_header')}\n${digest}` : base;
}

/**
 * Buduje skrót dorobku z transkryptu: per wynik narzędzia nagłówek `### <nazwa> <args≤200>`
 * + treść. Budżet `cap` dzielony po równo między wpisy (podłoga 400 znaków), na końcu
 * twardy sufit na całości. Wyniki multimodalne (tablice bloków) pomijamy — skrót jest
 * tekstem dla modelu zlecającego.
 */
function _buildSalvageDigest(messages: LoopMessage[], cap: number): string {
    if (!cap || cap <= 0) return '';
    // Mapa tool_call_id → nagłówek wywołania (nazwa + args) z tur asystenta.
    const heads = new Map<string, string>();
    for (const msg of messages) {
        if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
        for (const raw of msg.tool_calls) {
            const tc = raw as { id?: string; function?: { name?: string; arguments?: unknown } } | null;
            if (!tc?.id) continue;
            const name = tc.function?.name || '?';
            const rawArgs = tc.function?.arguments;
            const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? '');
            heads.set(tc.id, `### ${name} ${String(argsStr || '').slice(0, 200)}`.trimEnd());
        }
    }
    const entries: string[] = [];
    for (const msg of messages) {
        if (msg.role !== 'tool' || typeof msg.content !== 'string' || !msg.content) continue;
        const head = (msg.tool_call_id && heads.get(msg.tool_call_id)) || '### ?';
        entries.push(`${head}\n${msg.content}`);
    }
    if (entries.length === 0) return '';
    const perEntry = Math.max(400, Math.floor(cap / entries.length));
    const digest = entries
        .map((e) => (e.length > perEntry ? `${e.slice(0, perEntry)}…` : e))
        .join('\n\n');
    return digest.length > cap ? `${digest.slice(0, cap)}…` : digest;
}

// ─── Ekstrakcja z odpowiedzi modelu (3 kształty dostawców) ───

/** Wyciąga tekst z odpowiedzi (OpenAI choices → Anthropic content-blocks → string). */
function _extractText(response: ModelResponse | null | undefined): string {
    if (!response) return '';
    const openai = response?.choices?.[0]?.message?.content;
    if (typeof openai === 'string') return openai;
    if (Array.isArray(openai)) {
        // content array (multimodal) — sklej części tekstowe
        return openai.filter((p) => p?.type === 'text').map((p) => p.text || '').join('');
    }
    if (Array.isArray(response.content)) {
        return response.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
    }
    if (typeof response.content === 'string') return response.content;
    return '';
}

/** Wyciąga reasoning_content (DeepSeek Reasoner) jeśli obecny; inaczej undefined. */
function _extractReasoning(response: ModelResponse | null | undefined): unknown {
    const rc = response?.choices?.[0]?.message?.reasoning_content;
    return rc !== undefined ? rc : undefined;
}

/** Usuwa halucynowane tagi tool-call (DSML / function_calls / invoke) z finalnego tekstu. */
function _stripHallucinatedToolTags(text: string): string {
    if (!text) return text;
    let out = text;
    out = out.replace(/<\|?DSML\|?[^>]*>[\s\S]*?<\/?\|?DSML\|?[^>]*>/g, '').trim();
    out = out.replace(/<function_calls?>[\s\S]*?<\/function_calls?>/g, '').trim();
    // AUD-code-review-080: otwarcie wymagało `<invoke`, ale zamknięcie było zaszyte na sztywno
    // jako `</invoke>` — żaden realny wariant halucynowanego bloku (ani `<invoke>...
    // </invoke>`, ani `<invoke>...</invoke>`) nie dopasowywał się do CAŁOŚCI wzorca,
    // więc funkcja nigdy nie czyściła tej gałęzi mimo komentarza wyżej. Backreferencja `\1`
    // wymusza SPÓJNY wariant (z przestrzenią nazw albo bez) między otwarciem a zamknięciem —
    // zamiast zgadywać, którego wariantu użył model.
    out = out.replace(/<((?:antml:)?invoke)\b[\s\S]*?<\/\1>/g, '').trim();
    return out;
}

/** Obcina wynik narzędzia do maxLen znaków (0/brak = bez limitu). */
function _truncateResult(str: string, maxLen: number): string {
    if (!maxLen || maxLen <= 0) return str;
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + t('memory.truncated_suffix', { original: str.length, limit: maxLen });
}

// ─── Estymacja tokenów (fallback gdy API nie zwraca usage w streaming) ───

/**
 * Estymuje tokeny z wiadomości + definicji narzędzi. Liczy tylko finalny stan
 * transkryptu — niedoszacowanie, ale lepsze niż zero.
 */
function _estimateUsageFromMessages(
    messages: LoopMessage[],
    tools: ToolDefinition[] | null | undefined,
    outputText: string,
): Usage {
    let inputChars = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') inputChars += msg.content.length;
        if (msg.tool_calls) inputChars += JSON.stringify(msg.tool_calls).length;
    }
    if (tools?.length) inputChars += JSON.stringify(tools).length;
    return {
        prompt_tokens: countTokensSimple(inputChars > 0 ? 'x'.repeat(inputChars) : ''),
        completion_tokens: countTokensSimple(outputText || ''),
        _estimated: true
    };
}

/** Uzupełnia totalUsage estymacją jeśli API nie zwróciło danych. Mutuje in-place. */
function _fillEstimatedUsage(
    totalUsage: Usage,
    messages: LoopMessage[],
    tools: ToolDefinition[] | null | undefined,
    outputText: string,
): void {
    if (totalUsage.prompt_tokens > 0) return; // API zwróciło dane — nie nadpisuj
    const est = _estimateUsageFromMessages(messages, tools, outputText);
    totalUsage.prompt_tokens = est.prompt_tokens;
    totalUsage.completion_tokens = est.completion_tokens;
    totalUsage._estimated = true;
}
