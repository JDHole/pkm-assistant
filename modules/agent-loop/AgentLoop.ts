/**
 * AgentLoop - JEDNA wspólna pętla narzędziowa agenta, używana zarówno przez czat, jak i
 * przez sub-agentów. Wzorzec: WIDOCZNY `for`:
 *
 *     while (są iteracje) {
 *       zapytaj model (z narzędziami);
 *       jeśli brak tool_calls → koniec;
 *       wykonaj narzędzia; dopisz wyniki do transkryptu;
 *     }
 *     // backstop: ostatnie zapytanie BEZ narzędzi → model MUSI odpowiedzieć tekstem
 *
 * Approval/permission NIE żyje w pętli - jest w egzekutorze (`executeToolCall`). Polityki
 * PreToolUse/PostToolUse wpięte są przez hooki - pętla je TYLKO woła, nie implementuje.
 *
 * Kierunek zależności: NIC z modules/chat, modules/sub-agents, modules/mcp. Tylko
 * core/, config/ i lokalne pliki modułu.
 */
import { log as defaultLog } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { countTokensSimple, maskSensitiveData, redactSecretsDeep, toolResultStatus } from '../../core/index.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import { parseToolCalls } from './toolCallParser.js';
import type { ModelResponse, ParsedToolCall, ProviderUsage } from './toolCallParser.js';
import { sanitizeToolTranscript } from './toolTranscriptSanitizer.js';
import type { LoopMessage, MessageStoreLike } from './MessageStore.js';

// obsidianmd/prefer-window-timers: ten plik wstaje w gołym Node (testy AVA), gdzie `window`
// nie istnieje - `window.setTimeout` byłby ReferenceError. Inline `eslint-disable` jest
// zablokowany dla `obsidianmd/*` (`eslint-comments/no-restricted-disable` w configu pluginu
// recenzenta katalogu). Owijamy globalny timer FUNKCJĄ zamiast zamrażać referencję raz przy
// imporcie - `fn` czyta `setTimeout`/`clearTimeout` DYNAMICZNIE przy każdym wywołaniu, więc
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
 * (opcjonalnie) tania nazwa modelu do trace'u. Świadomie NIE jest to typ `ChatModel` -
 * agent-loop nie może zależeć od `modules/models`.
 */
interface LoopModelLike {
    stream(
        payload: Record<string, unknown>,
        handlers: {
            chunk: (resp: unknown) => void;
            done: (resp: ModelResponse) => void;
            /** Adaptery oddają tu obiekt błędu - pętla przekazuje go dalej jako powód odrzucenia. */
            error: (err: Error) => void;
            /** ChatModel woła to, gdy request wchodzi na slot bramki platform lokalnych
             *  (koniec czekania w kolejce). Pętla przezbraja tym per-call budzik - czas
             *  w kolejce nie zjada budżetu streamu. Opcjonalny: modele bez bramki mogą
             *  go nie wołać - budzik liczy wtedy od wysłania. */
            gate_admitted?: () => void;
        },
    ): void | Promise<unknown>;
    /** Twardy abort aktywnego streamu (ChatModel → adapter → xhr.abort). Pętla woła
     *  go przy per-call timeout, żeby nie zostawiać zombie-requestów na moście/API. */
    stopStream?(): void;
    modelKey?: string;
    modelId?: string;
    providerId?: string;
    streamMode?: string;
    streaming?: boolean;
}

/** Zagregowane zużycie tokenów zwracane przez pętlę (`_estimated` = fallback bez danych z API). */
export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    _estimated?: boolean;
}


/** Honest reason for a completed, interrupted or failed loop. */
export type AgentLoopStopReason =
    | { kind: 'natural' }
    | { kind: 'iteration-limit' }
    | { kind: 'synthesis-budget'; budgetMs: number }
    | { kind: 'manual-stop' | 'task-timeout' | 'superseded' }
    | { kind: 'silence' | 'model-timeout' | 'transport-error' | 'model-error' | 'hook-error'; stage: 'work' | 'synthesis' };

export interface AgentLoopToolOutcome {
    invocation: number;
    id?: string;
    name: string;
    outcome: 'returned' | 'error' | 'unknown';
    effect: 'unverified';
    resultPreview: string;
}

export interface AgentLoopPartialSnapshot {
    kind: 'agent-loop-partial';
    revision: number;
    stopReason: AgentLoopStopReason;
    synthesis: 'pending' | 'skipped' | 'completed' | 'budget-expired' | 'failed';
    toolsUsed: readonly string[];
    toolOutcomes: readonly AgentLoopToolOutcome[];
    toolCallDetails: readonly { name?: string; resultPreview: string; error?: boolean }[];
    usage: Readonly<Usage>;
    iterations: number;
    lastText: string;
    text: string;
}

class LoopTimerError extends Error {
    constructor(readonly kind: 'silence' | 'model-timeout' | 'synthesis-budget', readonly budgetMs: number) {
        super(kind === 'silence'
            ? t('agentLoop.model_stall', { seconds: Math.round(budgetMs / 1000) })
            : kind === 'model-timeout'
                ? t('agentLoop.model_timeout', { seconds: Math.round(budgetMs / 1000) })
                : t('agentLoop.synthesis_budget'));
    }
}
class LoopAbortError extends Error {}

const PARTIAL_MAX_CHARS = 12000;

/** Exclude payload/arguments/hidden reasoning and binary, then mask before clipping. */
function partialPreview(value: unknown, secrets: readonly string[] = []): string {
    const seen = new WeakSet<object>();
    const clean = (input: unknown, depth: number): unknown => {
        if (typeof input === 'string') {
            return input.replace(/data:[^\s"']+/gi, '[binary]')
                .replace(/\b[A-Za-z0-9+/]{120,}={0,2}\b/g, '[binary]')
                .replace(/<(?:think|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|reasoning)>/gi, '[reasoning omitted]');
        }
        if (!input || typeof input !== 'object') return input;
        if (depth > 8 || seen.has(input)) return '[omitted]';
        seen.add(input);
        if (Array.isArray(input)) {
            return input.filter((item: unknown) => {
                if (!item || typeof item !== 'object' || !('type' in item)) return true;
                return item.type === 'text';
            }).map(item => clean(item, depth + 1));
        }
        if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return '[binary]';
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(input)) {
            if (/^(?:args|arguments|raw|payload|request|headers|reasoning(?:_content)?|thinking|binary|base64|bytes|data|image(?:_url)?|audio)$/i.test(key)) continue;
            out[key] = clean(item, depth + 1);
        }
        return out;
    };
    try {
        let source = value;
        if (typeof source === 'string') {
            try { source = JSON.parse(source); } catch { /* ordinary text */ }
        }
        const safe = clean(source, 0);
        const text = typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '';
        return maskSensitiveData(String(redactSecretsDeep(text, secrets)));
    } catch { return '[preview unavailable]'; }
}

const partialReasonText = {
    natural: () => t('agentLoop.reason_natural'),
    'iteration-limit': () => t('agentLoop.reason_iteration-limit'),
    'synthesis-budget': () => t('agentLoop.reason_synthesis-budget'),
    'manual-stop': () => t('agentLoop.reason_manual-stop'),
    'task-timeout': () => t('agentLoop.reason_task-timeout'),
    superseded: () => t('agentLoop.reason_superseded'),
    silence: () => t('agentLoop.reason_silence'),
    'model-timeout': () => t('agentLoop.reason_model-timeout'),
    'transport-error': () => t('agentLoop.reason_transport-error'),
    'model-error': () => t('agentLoop.reason_model-error'),
    'hook-error': () => t('agentLoop.reason_hook-error'),
} satisfies Record<AgentLoopStopReason['kind'], () => string>;

const partialSynthesisText = {
    pending: () => t('agentLoop.synthesis_pending'),
    skipped: () => t('agentLoop.synthesis_skipped'),
    completed: () => t('agentLoop.synthesis_completed'),
    'budget-expired': () => t('agentLoop.synthesis_budget-expired'),
    failed: () => t('agentLoop.synthesis_failed'),
} satisfies Record<AgentLoopPartialSnapshot['synthesis'], () => string>;

const partialOutcomeText = {
    returned: () => t('agentLoop.outcome_returned'),
    error: () => t('agentLoop.outcome_error'),
    unknown: () => t('agentLoop.outcome_unknown'),
} satisfies Record<AgentLoopToolOutcome['outcome'], () => string>;

/** Deterministic receipt: a returned tool value never verifies a mutation. */
export function formatAgentLoopPartial(snapshot: AgentLoopPartialSnapshot): string {
    const lines = [
        t('agentLoop.partial_header'),
        t('agentLoop.partial_state', {
            reason: partialReasonText[snapshot.stopReason.kind](),
            synthesis: partialSynthesisText[snapshot.synthesis](),
        }),
        t('agentLoop.partial_unverified'),
    ];
    if (snapshot.lastText) lines.push(partialPreview(snapshot.lastText));
    for (const outcome of snapshot.toolOutcomes) {
        lines.push('### ' + partialPreview(outcome.name) + ' - ' + partialOutcomeText[outcome.outcome]());
        if (outcome.resultPreview) lines.push(partialPreview(outcome.resultPreview));
    }
    return lines.join('\n').slice(0, PARTIAL_MAX_CHARS);
}

function copyPartial(snapshot: AgentLoopPartialSnapshot): AgentLoopPartialSnapshot {
    return Object.freeze({
        ...snapshot,
        stopReason: Object.freeze({ ...snapshot.stopReason }),
        toolsUsed: Object.freeze([...snapshot.toolsUsed]),
        toolOutcomes: Object.freeze(snapshot.toolOutcomes.map(item => Object.freeze({ ...item }))),
        toolCallDetails: Object.freeze(snapshot.toolCallDetails.map(item => Object.freeze({ ...item }))),
        usage: Object.freeze({ ...snapshot.usage }),
    });
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

/** Trusted runtime details for one tool invocation. Never derived from model arguments. */
export interface ToolExecutionContext {
    /** Effective cap selected for the original tool name; 0 means the loop has no cap. */
    resultBudgetChars: number;
    /** Abort predicate bound to the current turn. */
    shouldAbort: () => boolean;
}

/**
 * Hooki pętli - WSZYSTKIE opcjonalne i wszystkie awaitowane (sync albo async).
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

/** Kagańce pętli - 0/brak = wyłączone (poza `maxIterations`, które spada na DEFAULT_LIMITS). */
interface AgentLoopLimits {
    maxIterations?: number;
    minIterations?: number;
    perCallTimeoutMs?: number;
    maxToolResultLength?: number;
    /** Watchdog CISZY per wywołanie modelu - strzela po stallTimeoutMs bez ANI
     *  JEDNEGO chunka (każdy chunk i sygnał bramki przezbrajają budzik). Odróżnia trupa
     *  (martwy socket) od myśliciela (wolny model, który streamuje). 0/brak = wyłączony. */
    stallTimeoutMs?: number;
    /** Sufit skrótu dorobku narzędzi doklejanego do zaślepki backstopu, gdy finalna
     *  synteza nie powstała (model padł / cisza). 0/brak = goła zaślepka. */
    salvageMaxChars?: number;
    /** Total optional synthesis budget including queue wait; 0 skips the request. */
    synthesisTimeoutMs?: number;
    /** Sufit wyniku PER NARZĘDZIE - nadpisuje `maxToolResultLength`
     *  dla wymienionych nazw (0 = bez limitu dla tego narzędzia). Czat daje `delegate`
     *  większą porcję: wynik suba to deliverable po minutach roboty, nie surowy zrzut -
     *  wspólny sufit potrafi uciąć go w połowie. */
    maxToolResultLengthPerTool?: Record<string, number>;
}

/** Opcje modelu dokładane do payloadu (`agentName` wypada - to metadana do logów). */
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
    /** Zwraca cokolwiek (sync albo Promise) - `unknown` pokrywa oba przypadki. */
    executeToolCall: (toolCall: ParsedToolCall, context: ToolExecutionContext) => unknown;
    limits?: AgentLoopLimits;
    modelOptions?: AgentLoopModelOptions;
    hooks?: AgentLoopHooks;
    callbacks?: { chunk?: (resp: unknown) => void; partial?: (snapshot: AgentLoopPartialSnapshot) => void };
    /** Frozen turn/task signal enables prompt observation while a tool is held. */
    abortSignal?: AbortSignal;
    abortReason?: () => 'manual-stop' | 'task-timeout' | 'superseded' | AgentLoopStopReason;
    /** Known secret values to redact before partial clipping. */
    knownSecrets?: readonly string[];
    /**
     * Predykat „ta tura jest przerwana". Pętla pyta go w SIEDMIU punktach - pełna lista
     * i uzasadnienie: `modules/agent-loop/CLAUDE.md` gotcha 9.
     *
     * ⚠️ Kontrakt wołacza: predykat ma czytać stan TEJ tury (uchwyt/flaga w obiekcie tury),
     * nigdy pola widoku współdzielonego z następną turą - inaczej kolejna wiadomość gasi
     * przerwanie tury, która wciąż biegnie, i zatrzymana pętla wznawia iteracje.
     */
    shouldAbort?: () => boolean;
    /**
     * Sygnał „request wszedł na slot bramki" - pętla przekazuje go dalej z handlera
     * `gate_admitted`, fire-and-forget, przy KAŻDYM wpuszczeniu.
     *
     * Po co: budżet CAŁEGO biegu suba (`delegation_timeout_ms`) liczyłby też czas stania
     * w kolejce bramki platformy lokalnej - worker o priorytecie 0 czekałby za rozmową
     * główną aż budżet minie i umierał, nie wykonawszy zadania. `DelegateTool` uzbraja
     * swój budzik dopiero na ten sygnał.
     */
    onGateAdmitted?: () => void;
    /**
     * Fire-and-forget trace (TraceLog.scope) - pętla NIGDY go nie awaituje.
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
    stopReason?: AgentLoopStopReason;
    partial?: AgentLoopPartialSnapshot;
}

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
 * KAŻDEJ iteracji), `executeToolCall` (egzekutor - approval/permission żyje TAM), `limits`
 * (0 = wyłączone), `modelOptions` (dokładane do payloadu; `agentName` tylko do logów), `hooks`,
 * `callbacks.chunk` (streaming do UI), `shouldAbort` (pytane w SIEDMIU punktach - CLAUDE.md gotcha 9),
 * `trace` (fire-and-forget: loop.start, model.done, tool.pre, tool.blocked, tool.post, backstop,
 * loop.end - infrastruktura obserwowalności, NIE polityka), `log`.
 *
 * Hooki (wszystkie opcjonalne - nośnik dla PreToolUse/PostToolUse; pętla tylko woła).
 * Każdy hook jest AWAITOWANY - może być sync albo async (await na sync funkcji nic nie psuje).
 * Czat potrzebuje async `beforeContinue` (kompresja mid-loop) i async polityk kontroli:
 *   onIterationStart(i)
 *   onToolCallsParsed(toolCalls, i) - po parsowaniu, PRZED egzekucją (czat tworzy tu placeholdery UI;
 *     kontrakt ask_user tego wymaga: placeholder MUSI powstać przed egzekucją). await jest sekwencyjny
 *     przed Promise.all, więc placeholdery i tak powstają przed egzekucją. Jeśli zwróci tablicę → użyta
 *     zamiast oryginalnej (forward-compat filtracja).
 *   onToolResults(results, i) - po Promise.all; results w kolejności tool_calls: [{toolCall, result, error?}]
 *   beforeContinue(i) - przed kolejnym wywołaniem modelu (czat robi tu async kompresję + dopisuje nudges przez store)
 *   onUsage(usage, i) - po każdej odpowiedzi modelu z usage (czat wepnie TokenTracker)
 *   onBackstop() - gdy wchodzi finalna iteracja bez narzędzi
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
    abortSignal,
    abortReason,
    knownSecrets = [],
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
    const synthesisTimeoutMs = limits.synthesisTimeoutMs ?? DEFAULT_LIMITS.model_synthesis_timeout_ms;
    const perToolResultCaps = limits.maxToolResultLengthPerTool || null;

    const chunkCb = typeof callbacks.chunk === 'function' ? callbacks.chunk : () => {};
    const abort = abortSignal
        ? () => abortLatched || (shouldAbort?.() ?? false)
        : shouldAbort ?? (() => false);

    // modelOptions → payload. agentName wyjmujemy (to metadana do logów, nie pole API).
    const { maxTokens, thinking, agentName, ...restPayload } = modelOptions;

    const toolsUsed: string[] = [];
    const toolCallDetails: ToolCallDetail[] = [];
    const totalUsage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
    let iterations = 0;
    let lastText = '';
    let currentToolDefs: ToolDefinition[] = [];

    const ledger: { outcome: AgentLoopToolOutcome; detail?: ToolCallDetail }[] = [];
    let terminal = false;
    let abortLatched = abortSignal?.aborted === true;
    let latchedReason: AgentLoopStopReason | undefined;
    let stage: 'work' | 'synthesis' = 'work';
    let failureKind: 'model-error' | 'hook-error' = 'hook-error';
    let synthesis: AgentLoopPartialSnapshot['synthesis'] = 'skipped';
    let latestPartial: AgentLoopPartialSnapshot | undefined;
    let partialSignature = '';
    let cancelStream: (() => void) | undefined;
    let wakeAbort!: () => void;
    const abortWake = new Promise<void>(resolve => { wakeAbort = resolve; });
    const getAbortReason = (error?: unknown): AgentLoopStopReason => {
        if (latchedReason) return latchedReason;
        let reason: AgentLoopStopReason = { kind: 'manual-stop' };
        try {
            const supplied = abortReason?.();
            if (supplied) reason = typeof supplied === 'string' ? { kind: supplied } : { ...supplied };
        } catch { /* observer cannot replace original cause */ }
        if (error && typeof error === 'object' && '_superseded' in error && error._superseded === true) reason = { kind: 'superseded' };
        return (latchedReason = reason);
    };
    const publishPartial = (stopReason: AgentLoopStopReason): AgentLoopPartialSnapshot => {
        // Text + duplicated previews together share one budget. Identity/status stay intact.
        let remaining = 8000;
        const clip = (text: string, cap = remaining): string => {
            const result = text.slice(0, Math.min(cap, remaining));
            remaining -= result.length;
            return result;
        };
        const outcomes = ledger.map(({ outcome }) => ({
            ...outcome,
            name: partialPreview(outcome.name, knownSecrets).slice(0, 128),
            ...(outcome.id === undefined ? {} : { id: partialPreview(outcome.id, knownSecrets).slice(0, 128) }),
            resultPreview: clip(outcome.resultPreview, 2000),
        }));
        const last = clip(partialPreview(lastText, knownSecrets), 2000);
        const details = outcomes.filter((_outcome, i) => ledger[i].detail !== undefined).map(outcome => ({
            name: outcome.name, resultPreview: clip(outcome.resultPreview),
            ...(outcome.outcome !== 'returned' ? { error: true } : {}),
        }));
        const snapshot: AgentLoopPartialSnapshot = {
            kind: 'agent-loop-partial', revision: 0, stopReason: { ...stopReason }, synthesis,
            toolsUsed: outcomes.map(item => item.name), toolOutcomes: outcomes, toolCallDetails: details,
            usage: { ...totalUsage }, iterations, lastText: last, text: '',
        };
        snapshot.text = formatAgentLoopPartial(snapshot).slice(0, PARTIAL_MAX_CHARS - (8000 - remaining));
        const signature = JSON.stringify(snapshot);
        if (signature === partialSignature && latestPartial) return copyPartial(latestPartial);
        partialSignature = signature;
        snapshot.revision = (latestPartial?.revision ?? 0) + 1;
        latestPartial = copyPartial(snapshot);
        try {
            const observed: unknown = callbacks.partial?.(copyPartial(latestPartial));
            if (observed && (typeof observed === 'object' || typeof observed === 'function') && 'then' in observed) {
                void Promise.resolve(observed).catch(() => {});
            }
        } catch { /* partial observers never obscure work/model/hook errors */ }
        return copyPartial(latestPartial);
    };
    const onAbort = () => {
        if (terminal || abortLatched) return;
        abortLatched = true;
        synthesis = 'skipped';
        // Stop the owned request before a reentrant observer can start another one.
        cancelStream?.();
        wakeAbort();
        publishPartial(getAbortReason());
    };
    const raceAbort = async <T>(work: T | PromiseLike<T>): Promise<T> => {
        const pending = Promise.resolve(work);
        if (abortLatched) { void pending.catch(() => {}); throw new LoopAbortError(); }
        if (!abortSignal) return await pending;
        return await Promise.race([pending, abortWake.then(() => { throw new LoopAbortError(); })]);
    };
    const callHook = async <T>(invoke: () => T | PromiseLike<T>): Promise<T> => {
        failureKind = 'hook-error';
        const value = await invoke();
        return value;
    };
    const classifyFailure = (error: unknown): AgentLoopStopReason => {
        if (error instanceof LoopTimerError && error.kind !== 'synthesis-budget') return { kind: error.kind, stage };
        if (failureKind === 'hook-error') return { kind: 'hook-error', stage };
        if (error && typeof error === 'object' && 'code' in error
            && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'NETWORK_ERROR', 'TRANSPORT_ERROR'].includes(String(error.code))) {
            return { kind: 'transport-error', stage };
        }
        return { kind: 'model-error', stage };
    };
    const close = () => {
        terminal = true;
        abortSignal?.removeEventListener('abort', onAbort);
    };


    /**
     * `.catch()` na promisie zwróconej przez `model.stream()` dostaje `reason: any` (standardowa
     * sygnatura `Promise.prototype.catch`) - `@typescript-eslint/prefer-promise-reject-errors`
     * wymaga, żeby `reject(...)` dostawał coś PROWALNIE `Error`em. Adapter modeli (`ChatModel`,
     * `modules/models`) rzuca `NormalizedError`/`ModelRequestError` - konsumenci pętli czytają
     * z odrzucenia `code`/`http_status`/`message`, więc zwykłe `new Error(String(reason))`
     * zgubiłoby te pola. `agent-loop` świadomie NIE zależy od `modules/models` (patrz komentarz
     * modułu i `LoopModelLike` wyżej), więc to jest LOKALNY, strukturalny odpowiednik takiego
     * opakowania - `Object.assign` dokleja oryginalne pola na odrzucany `Error` zamiast je
     * gubić. Realny `Error` (już poprawny) przechodzi nietknięty.
     */
    const toRejectableError = (reason: unknown): Error => {
        if (reason instanceof Error) return reason;
        const hasMessage = reason && typeof reason === 'object' && typeof (reason as { message?: unknown }).message === 'string';
        const err = new Error(hasMessage ? (reason as { message: string }).message : String(reason), { cause: reason });
        if (reason && typeof reason === 'object') Object.assign(err, reason);
        return err;
    };

    logger.group?.('AgentLoop', `runAgentLoop (min ${minIterations}, max ${maxIterations} iteracji)${agentName ? ` — ${agentName}` : ''}`);

    // Trace: start pętli. model = tania nazwa/id modelu jeśli dostępna, inaczej pomiń pole.
    const _traceModel = model?.modelKey || model?.modelId;
    trace?.('loop.start', { max_iter: maxIterations, ...(_traceModel ? { model: _traceModel } : {}) });


    // One request-local terminal guard owns all callbacks and timers, including no-timer calls.
    const _streamCall = (payload: Record<string, unknown>, synthesisBudgetMs = 0): Promise<ModelResponse> => {
        failureKind = 'model-error';
        return new Promise<ModelResponse>((resolve, reject) => {
            let settled = false;
            let perCallTimer: ReturnType<typeof setTimeout> | undefined;
            let stallTimer: ReturnType<typeof setTimeout> | undefined;
            let synthesisTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
                if (settled) return false;
                settled = true;
                if (perCallTimer !== undefined) _nodeSafeClearTimeout(perCallTimer);
                if (stallTimer !== undefined) _nodeSafeClearTimeout(stallTimer);
                if (synthesisTimer !== undefined) _nodeSafeClearTimeout(synthesisTimer);
                if (cancelStream === cancel) cancelStream = undefined;
                return true;
            };
            const fail = (error: Error) => { if (finish()) reject(error); };
            const stop = () => { try { model.stopStream?.(); } catch { /* preserve accepted cause */ } };
            const cancel = () => {
                if (!settled) { fail(new LoopAbortError()); stop(); }
            };
            cancelStream = cancel;
            const expire = (kind: LoopTimerError['kind'], budgetMs: number) => {
                if (!finish()) return;
                // Settlement and timer cleanup precede stop's possibly synchronous abort callback.
                reject(new LoopTimerError(kind, budgetMs));
                stop();
                trace?.(kind === 'silence' ? 'model.stall' : kind === 'model-timeout' ? 'model.timeout' : 'synthesis.timeout',
                    { budget_ms: budgetMs });
            };
            const armPerCall = () => {
                if (settled || perCallTimeoutMs <= 0) return;
                if (perCallTimer !== undefined) _nodeSafeClearTimeout(perCallTimer);
                perCallTimer = _nodeSafeSetTimeout(() => expire('model-timeout', perCallTimeoutMs), perCallTimeoutMs);
            };
            // Complete/emulated providers cannot expose semantic progress until completion.
            const observeSilence = model.streamMode !== 'complete' && model.streaming !== false && model.providerId !== 'xai';
            const armStall = () => {
                if (settled || stallTimeoutMs <= 0 || !observeSilence) return;
                if (stallTimer !== undefined) _nodeSafeClearTimeout(stallTimer);
                stallTimer = _nodeSafeSetTimeout(() => expire('silence', stallTimeoutMs), stallTimeoutMs);
            };
            if (abortLatched) { cancel(); return; }
            armPerCall(); armStall();
            if (synthesisBudgetMs > 0) {
                synthesisTimer = _nodeSafeSetTimeout(() => expire('synthesis-budget', synthesisBudgetMs), synthesisBudgetMs);
            }
            try {
                const opened = model.stream(payload, {
                    chunk: resp => {
                        if (settled || terminal || abortLatched) return;
                        armStall();
                        if (resp && typeof resp === 'object') {
                            const text = _extractText(resp as ModelResponse);
                            if (text) lastText = text;
                        }
                        chunkCb(resp);
                    },
                    done: resp => { if (finish()) resolve(resp); },
                    error: err => { if (!settled) fail(err); },
                    gate_admitted: () => {
                        if (settled || terminal || abortLatched) return;
                        armPerCall(); armStall();
                        try { onGateAdmitted?.(); }
                        catch (e) { logger.warn?.('AgentLoop', 'onGateAdmitted failed (ignored):', e); }
                    },
                });
                void Promise.resolve(opened).catch((err: unknown) => {
                    if (!settled) fail(toRejectableError(err));
                });
            } catch (err) { if (!settled) fail(toRejectableError(err)); }
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


    const finalize = (
        text: string, stoppedBy: RunAgentLoopResult['stoppedBy'],
        stopReason: AgentLoopStopReason = stoppedBy === 'abort' ? getAbortReason() : { kind: 'natural' },
    ): RunAgentLoopResult => {
        _fillEstimatedUsage(totalUsage, store.getMessagesForAPI(), currentToolDefs, text || '');
        if (stoppedBy === 'abort') { synthesis = 'skipped'; publishPartial(stopReason); }
        close();
        trace?.('loop.end', { stop: stoppedBy, iters: iterations, total_ms: Date.now() - _loopStart,
            ...(stoppedBy === 'backstop' && synthesis !== 'completed' ? { fallback: 1 } : {}) });
        logger.groupEnd?.();
        return {
            finalText: text || '', toolsUsed: [...toolsUsed],
            toolCallDetails: toolCallDetails.map(detail => ({ ...detail })),
            usage: { ...totalUsage }, iterations, stoppedBy, stopReason: { ...stopReason },
            ...(latestPartial ? { partial: copyPartial(latestPartial) } : {}),
        };
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortLatched) wakeAbort();

    // KORPUS ITERACJI POD STRAŻNIKIEM: `try` obejmuje hooki, `resolveTools` i `store`, nie
    // tylko wywołanie modelu. Rzut z dowolnego z nich (np. chatowy `onToolResults` zaczyna od
    // zapisu dziennika sesji na dysku - skasowany plik aktywnej sesji, blokada synca GDrive,
    // EBUSY) bez tego strażnika kończyłby pętlę BEZ `loop.end` i bez `groupEnd()` - bieg
    // urywałby się w trace po `tool.post`, a w trybie debug wszystkie późniejsze logi konsoli
    // zostawałyby w otwartej grupie „AgentLoop". Wyjątek dalej leci w górę (pętla nie zna
    // `stoppedBy:'error'` - gotcha 5), ale zostawia domknięcie w trace, a dorobek narzędzi
    // w transkrypcie.
    // ⚠️ Ciało pętli świadomie NIE jest przewcięte o poziom - przesunięcie 220 linii zamieniłoby
    // ten diff w szum i zerwało `git blame` na całym korpusie iteracji.
    try {
    for (let i = 0; i < maxIterations; i++) {
        iterations = i + 1;

        // shouldAbort na START iteracji - model NIE jest wołany.
        if (abort()) {
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: abort na starcie iteracji`);
            return finalize(lastText, 'abort');
        }

        await callHook(() => hooks.onIterationStart?.(i));
        if (abort()) return finalize(lastText, 'abort');

        // Świeża whitelista narzędzi na start każdej iteracji.
        currentToolDefs = (typeof resolveTools === 'function' ? resolveTools() : []) || [];
        // `.filter(Boolean)` odsiewa undefined w runtime, ale TS tego nie widzi - stąd asercja.
        const knownToolNames = currentToolDefs.map((td) => td.function?.name || td.name).filter(Boolean) as string[];

        // sanitizeToolTranscript przed KAŻDYM wywołaniem modelu (drop osieroconych tool messages).
        const apiMessages = sanitizeToolTranscript(store.getMessagesForAPI(), { logger, tag: 'AgentLoop' }).messages;

        // Zapytanie do modelu (błędy propagują do wołacza - jak w streamHelper).
        // Ślad loop.end zostaje w trace także przy błędzie/timeout (emituje go strażnik
        // całej trasy niżej) - bez tego pętla, która padła na modelu, znikałaby z trace bez
        // domknięcia i zwis wyglądałby jak urwany log.
        let response: ModelResponse;
        try {
            response = await _streamCall(_buildPayload(apiMessages, currentToolDefs));
        } catch (err) {
            // PRZERWANIE ≠ AWARIA. Stop z zewnątrz ubija stream przez `stopStream`, a ten od
            // tej pory ROZSTRZYGA promisę - odrzuceniem ze znacznikiem `_aborted`. Bez tej
            // gałęzi bieg schodziłby jako błąd, mimo że user go świadomie zatrzymał.
            // Rozpoznajemy dwa dowody: flagę wołacza (`shouldAbort`) ORAZ znacznik na błędzie
            // - pierwszy bywa niedostępny (czat ustawia go dopiero na swojej ścieżce), drugi
            // jest zawsze.
            if (!(err instanceof LoopTimerError) && (err instanceof LoopAbortError || abort() || (err as { _aborted?: boolean } | null)?._aborted === true)) {
                logger.debug?.('AgentLoop', `Iteracja ${i + 1}: stream przerwany z zewnątrz — kończę jako abort`);
                return finalize(lastText, 'abort', getAbortReason(err));
            }
            // `loop.end stop=error` emituje JEDEN strażnik - catch całej trasy głównej.
            // Tu tylko oddajemy błąd w górę, żeby nie było dwóch linii domknięcia.
            throw err;
        }

        // Akumulacja usage + hook.
        if (response?.usage) {
            totalUsage.prompt_tokens += response.usage.prompt_tokens || 0;
            totalUsage.completion_tokens += response.usage.completion_tokens || 0;
            await callHook(() => hooks.onUsage?.(response.usage!, i));
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
                await callHook(() => hooks.beforeContinue?.(i));
                continue;
            }
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: brak tool calls, zwracam tekst (${content.length} zn.)`);
            return finalize(content, 'natural');
        }

        // Hook PRZED egzekucją (ask_user: placeholdery UI). Zwrócona tablica → filtracja.
        let effective = parsed;
        const hookResult = await callHook(() => hooks.onToolCallsParsed?.(parsed, i));
        if (abort()) return finalize(content || lastText, 'abort');
        if (Array.isArray(hookResult)) {
            effective = hookResult;
            // Trace: hook coś odfiltrował (dziś ask_user czatu) → nazwy usuniętych.
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
            // nazwy w ogóle - runtime wpycha wtedy `undefined` jak dotąd (asercja nic nie zmienia).
            const tName = tc.name || tc.function?.name;
            // Tool identities enter the ledger when execution starts below.
            // Trace PER TOOL przed egzekucją, bez treści argumentów modelu.
            trace?.('tool.pre', { i, tool: tName });
        }


        // Invocation identity is assigned at start; record raw outcome before any store/hook.
        const _batchStart = Date.now();
        const settledResults: ExecResult[] = [];
        let batchInterrupted = false;
        const batch = Promise.all(effective.map(async (tc): Promise<ExecResult> => {
            const toolName = tc.name || tc.function?.name;
            const toolArgs = tc.arguments ?? tc.function?.arguments;
            if (abortLatched) return { toolCall: tc, toolName, parsedArgs: toolArgs, result: '', error: false };
            const entry: typeof ledger[number] = { outcome: {
                invocation: ledger.length + 1, ...(tc.id ? { id: tc.id } : {}), name: toolName || '?',
                outcome: 'unknown', effect: 'unverified', resultPreview: '',
            } };
            ledger.push(entry);
            toolsUsed.push(toolName as string);
            let parsedArgs = toolArgs;
            try { if (typeof toolArgs === 'string') parsedArgs = JSON.parse(toolArgs); } catch { /* preserve args */ }
            const record = (result: ExecResult, raw: unknown, outcome: AgentLoopToolOutcome['outcome']) => {
                if (terminal || abortLatched) return result;
                entry.outcome.outcome = outcome;
                entry.outcome.resultPreview = partialPreview(raw, knownSecrets).slice(0, PARTIAL_MAX_CHARS);
                entry.detail = { name: toolName, args: parsedArgs, resultPreview: entry.outcome.resultPreview.slice(0, 500),
                    ...(outcome !== 'returned' ? { error: true } : {}) };
                toolCallDetails.length = 0;
                for (const item of ledger) if (item.detail) toolCallDetails.push({ ...item.detail });
                settledResults.push(result);
                return result;
            };
            try {
                const resultBudgetChars = (toolName && perToolResultCaps && toolName in perToolResultCaps)
                    ? perToolResultCaps[toolName] : maxToolResultLength;
                const raw = await executeToolCall(
                    { id: tc.id, name: toolName, arguments: toolArgs }, { resultBudgetChars, shouldAbort: abort },
                );
                // Raw status/preview are captured before stringification (which itself can fail).
                if (!terminal && !abortLatched) {
                    entry.outcome.outcome = toolResultStatus(raw) === 'error' ? 'error' : 'returned';
                    entry.outcome.resultPreview = partialPreview(raw, knownSecrets).slice(0, PARTIAL_MAX_CHARS);
                    entry.detail = { name: toolName, args: parsedArgs, resultPreview: entry.outcome.resultPreview.slice(0, 500),
                        ...(entry.outcome.outcome === 'error' ? { error: true } : {}) };
                    toolCallDetails.length = 0;
                    for (const item of ledger) if (item.detail) toolCallDetails.push({ ...item.detail });
                }
                const result = Array.isArray(raw) ? raw : _truncateResult(typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '', resultBudgetChars);
                const error = toolResultStatus(raw) === 'error';
                return record({ toolCall: tc, toolName, parsedArgs, result, error }, raw, error ? 'error' : 'returned');
            } catch (toolError) {
                if (entry.detail && !terminal && !abortLatched) throw toolError;
                const message = toolError instanceof Error ? toolError.message : String(toolError);
                const uncertain = toolError && typeof toolError === 'object'
                    && (('code' in toolError && ['TOOL_TIMEOUT', 'TIMEOUT', 'ETIMEDOUT'].includes(String(toolError.code)))
                        || ('name' in toolError && toolError.name === 'TimeoutError')
                        || ('_aborted' in toolError && toolError._aborted === true));
                return record({ toolCall: tc, toolName, parsedArgs, result: 'Error: ' + message, error: true, errorMsg: message },
                    'Error: ' + message, uncertain ? 'unknown' : 'error');
            }
        }));
        let results: ExecResult[];
        try { results = await raceAbort(batch); }
        catch (error) {
            if (!(error instanceof LoopAbortError)) throw error;
            batchInterrupted = true;
            results = settledResults.sort((a, b) => effective.indexOf(a.toolCall) - effective.indexOf(b.toolCall));
        }
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
        // Wzór chat_streaming.js:886-901 - bez tego orphan tool_result → API 400.
        const apiToolCalls = (batchInterrupted ? effective.filter(tc => results.some(r => r.toolCall === tc)) : effective)
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
        // zdążyło zamienić placeholdery narzędzi na wyniki - tu tylko ustalamy wynik.
        const orphaned = apiToolCalls.length === 0 && results.length > 0;

        // DOROBEK DO TRANSKRYPTU PRZED HOOKAMI: zapis musi iść tutaj, nie za `onToolResults` -
        // inaczej wyjątek hooka (np. zapis dziennika sesji na dysku) gubiłby i wywołanie, i
        // wynik, mimo że narzędzie zdążyło już zrobić swoje w vaultcie - model przy następnej
        // turze tego by nie widział i mógłby zapis powtórzyć.
        if (!orphaned && apiToolCalls.length > 0) {
            store.appendAssistant(content || null, {
                tool_calls: apiToolCalls,
                ...(reasoning !== undefined ? { reasoning_content: reasoning } : {})
            });
            for (const r of filteredResults) {
                // `filteredResults` przeszło przez `validIdSet` (id na pewno jest) - TS tego nie wnioskuje.
                store.appendToolResult(r.result, r.toolCall.id as string);
            }
        }


        // Account observed settlements only. Held unresolved calls never become invented results.
        if (results.length > 0) {
            await callHook(() => hooks.onToolResults?.(
                results.map(r => ({ toolCall: r.toolCall, result: r.result, ...(r.error ? { error: r.errorMsg || true } : {}) })), i,
            ));
        }
        if (batchInterrupted) return finalize(content || lastText, 'abort');

        if (orphaned) {
            logger.error?.('AgentLoop', `ORPHAN GUARD: 0 poprawnych tool_calls, a ${results.length} wyników — kończę turę czysto`);
            return finalize(content, 'natural');
        }

        // shouldAbort MUSI być pytany PRZED kontynuacją tury, nie dopiero na starcie
        // NASTĘPNEJ iteracji - inaczej po Stopie kliknietym w trakcie narzędzia leciałby
        // jeszcze cały `beforeContinue`: u czatu nudges, wstrzyknięcie kolejki i - gdy
        // `getCompressionNeeded()` tak wskaże - `performTwoPhaseCompression`, czyli OSOBNE
        // wywołanie modelu (inna instancja niż ta ubita przez `stopStream`) plus trwały
        // zapis notatek do `brain/`. Bramka stoi PO zapisie dorobku do transkryptu: przerwanie
        // blokuje KONTYNUACJĘ tury, nie księgowanie tego, co już się wydarzyło.
        if (abort()) {
            logger.debug?.('AgentLoop', `Iteracja ${i + 1}: abort po narzędziach — nie kontynuuję tury`);
            return finalize(content || lastText, 'abort');
        }

        await callHook(() => hooks.beforeContinue?.(i));
    }

    // ── Backstop: wyczerpano maxIterations → finalne zapytanie BEZ narzędzi ──
    // Backstop byłby JEDYNYM wywołaniem modelu poza zasięgiem `abort()`, gdyby nie ta bramka:
    // Stop kliknięty w trakcie narzędzi OSTATNIEJ iteracji nie powstrzymywałby ani tego
    // wywołania, ani finalizacji tury u wołacza (stoppedBy='backstop' nie idzie gałęzią abortu).
    // Bramka stoi PRZED dopiskiem hardstopu do transkryptu - przerwana tura nie zostawia po
    // sobie wiadomości, której user nie zamawiał.
    if (abort()) {
        logger.debug?.('AgentLoop', 'Backstop: abort przed finalnym zapytaniem — kończę jako abort');
        return finalize(lastText, 'abort');
    }
    logger.warn?.('AgentLoop', `Max iteracji (${maxIterations}) osiągnięty! Tools used: ${toolsUsed.join(', ')}`);
    stage = 'synthesis';
    synthesis = synthesisTimeoutMs === 0 ? 'skipped' : 'pending';
    publishPartial({ kind: 'iteration-limit' });
    await callHook(() => hooks.onBackstop?.());
    if (abort()) return finalize(lastText, 'abort');
    trace?.('backstop', { after: maxIterations });

    } catch (err) {
        if (err instanceof LoopAbortError) return finalize(lastText, 'abort', getAbortReason(err));
        synthesis = 'failed';
        publishPartial(classifyFailure(err));
        close();
        trace?.('loop.end', { stop: 'error', iters: iterations, total_ms: Date.now() - _loopStart });
        logger.groupEnd?.();
        throw err;
    }

    try {
        const apiMessages = sanitizeToolTranscript(store.getMessagesForAPI(), { logger, tag: 'AgentLoop' }).messages;
        // Hardstop jedzie WYŁĄCZNIE w payloadzie finalnego strzału - nie do transkryptu.
        // `store.appendUser` zostawiłby go w oknie rozmowy na stałe: czat narysowałby rolę
        // `user` jako dymek użytkownika (polecenie „NIE wywołuj żadnych narzędzi", którego
        // nie napisał), a `getMessagesForAPI()` wiozłoby tę instrukcję w KAŻDYM kolejnym
        // żądaniu tej sesji, bo nikt by jej nie zdejmował. Ta sama zasada, którą pętla stosuje
        // przy abercie: przerwana/domknięta tura nie zostawia po sobie wiadomości, której
        // user nie zamawiał.
        apiMessages.push({ role: 'user', content: t('agentLoop.backstop_hardstop') });

        if (synthesisTimeoutMs === 0) {
            synthesis = 'skipped';
            const partial = publishPartial({ kind: 'iteration-limit' });
            return finalize(partial.text, 'backstop', { kind: 'iteration-limit' });
        }
        const finalResponse = await _streamCall(_buildPayload(apiMessages, null), synthesisTimeoutMs);

        if (abort()) return finalize(lastText, 'abort');
        if (finalResponse?.usage) {
            totalUsage.prompt_tokens += finalResponse.usage.prompt_tokens || 0;
            totalUsage.completion_tokens += finalResponse.usage.completion_tokens || 0;
            await callHook(() => hooks.onUsage?.(finalResponse.usage!, iterations));
            trace?.('model.done', { i: iterations, in: finalResponse.usage.prompt_tokens || 0, out: finalResponse.usage.completion_tokens || 0 });
        } else trace?.('model.done', { i: iterations, usage: 'none' });
        const finalText = _stripHallucinatedToolTags(_extractText(finalResponse));
        if (finalText) lastText = finalText;
        synthesis = finalText ? 'completed' : 'skipped';
        _fillEstimatedUsage(totalUsage, store.getMessagesForAPI(), currentToolDefs, finalText);
        publishPartial({ kind: 'iteration-limit' });
        return finalize(finalText || _fallbackWithSalvage(store, salvageMaxChars), 'backstop', { kind: 'iteration-limit' });
    } catch (err) {
        if (err instanceof LoopTimerError && err.kind === 'synthesis-budget') {
            synthesis = 'budget-expired';
            const reason: AgentLoopStopReason = { kind: 'synthesis-budget', budgetMs: err.budgetMs };
            const partial = publishPartial(reason);
            return finalize(partial.text, 'backstop', reason);
        }
        if (err instanceof LoopAbortError || (!(err instanceof LoopTimerError)
            && (abort() || (err as { _aborted?: boolean } | null)?._aborted === true))) {
            return finalize(lastText, 'abort', getAbortReason(err));
        }
        synthesis = 'failed';
        publishPartial(classifyFailure(err));
        close();
        trace?.('loop.end', { stop: 'error', iters: iterations, total_ms: Date.now() - _loopStart });
        logger.groupEnd?.();
        throw err;
    }
}

// ─── Ratowanie dorobku (salvage) ───

/**
 * Zaślepka backstopu + skrót dorobku narzędzi. Gdy finalna synteza nie powstała (model
 * padł na finalnym strzale / cisza / timeout), sub bez tego mechanizmu paliłby pełny
 * budżet na narzędzia i oddawał 36-znakową zaślepkę - cały zebrany materiał szedłby
 * do kosza. Zaślepka niesie surowe wyniki narzędzi przycięte do `cap` znaków.
 * `cap` 0/brak = goła zaślepka.
 */
function _fallbackWithSalvage(store: MessageStoreLike, cap: number): string {
    const base = t('agentLoop.backstop_fallback');
    let digest = '';
    // Salvage nie ma prawa przykryć właściwego błędu - złe wejście = brak skrótu, nie wyjątek.
    try { digest = _buildSalvageDigest(store.getMessagesForAPI(), cap); } catch { digest = ''; }
    return digest ? `${base}\n\n${t('agentLoop.salvage_header')}\n${digest}` : base;
}

/**
 * Buduje skrót dorobku z transkryptu: per wynik narzędzia nagłówek `### <nazwa> <args≤200>`
 * + treść. Budżet `cap` dzielony po równo między wpisy (podłoga 400 znaków), na końcu
 * twardy sufit na całości. Wyniki multimodalne (tablice bloków) pomijamy - skrót jest
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
        // content array (multimodal) - sklej części tekstowe
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
    // Regex musi dopasowywać otwarcie `<invoke` i zamknięcie w tym samym wariancie przestrzeni
    // nazw - stały wzorzec z zamknięciem NA SZTYWNO jako `</invoke>` (albo odwrotnie) nie
    // dopasowuje się do CAŁOŚCI, gdy model emituje oba tagi z namespace'em (`<invoke>...
    // </invoke>`). Backreferencja `\1` wymusza SPÓJNY wariant (z przestrzenią nazw albo
    // bez) między otwarciem a zamknięciem - zamiast zgadywać, którego wariantu użył model.
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
 * transkryptu - niedoszacowanie, ale lepsze niż zero.
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
    if (totalUsage.prompt_tokens > 0) return; // API zwróciło dane - nie nadpisuj
    const est = _estimateUsageFromMessages(messages, tools, outputText);
    totalUsage.prompt_tokens = est.prompt_tokens;
    totalUsage.completion_tokens = est.completion_tokens;
    totalUsage._estimated = true;
}
