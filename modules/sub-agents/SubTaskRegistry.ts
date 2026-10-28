/**
 * SubTaskRegistry — księga zadań sub-agentów.
 *
 * PO CO: bez tego rejestru jedynym śladem po biegu suba byłaby linia w
 * `.pkm-assistant/logs/trace.log` (funkcja `trace` wstrzykiwana do pętli) — nie istniałby BYT,
 * którego można zapytać „co ten sub robi teraz", „ile mu zostało budżetu", „czym skończył".
 * Ten plik robi z biegu suba obiekt (`SubTask`: id, status, kroki, wynik, budżet) i wystawia
 * szynę zdarzeń.
 *
 * ODWRÓCENIE ZALEŻNOŚCI: trace.log przestaje być JEDYNYM odbiorcą — staje się PIERWSZYM
 * KONSUMENTEM zdarzeń (`task:step` → `traceLog.scope(task.id)(type, fields)`). Format linii
 * jest BIT W BIT ten sam co dotąd (etykieta = dzisiejsza etykieta trace `sub/<nazwa>#<seq>`,
 * formatowanie robi `TraceLog.scope`), bo scenariusze harnessa parsują ten plik prefiksowo.
 * Panel podglądu subów może podpiąć się jako DRUGI konsument, bez dotykania runnera.
 *
 * ZASADY:
 *   - Plik czysty: zero `obsidian`, zero UI, zero I/O. Zależności (traceLog, mask)
 *     WSTRZYKIWANE — barrel modułu musi zostać obsidian-free (wiszą na nim testy AVA).
 *   - Księgowość NIGDY nie zatrzymuje suba: każda metoda jest fail-soft (try/catch + warn).
 *     Rejestr, który się wywala, byłby gorszy od braku rejestru.
 *   - Maskowanie NA WEJŚCIU (`step` przepuszcza stringowe wartości pól przez `mask`),
 *     więc KAŻDY konsument — trace, przyszły panel — dostaje dane już bezpieczne.
 *   - Sufity pamięci: `maxStepsPerTask` (kroki w RAM per task) i `maxDone` (ile zakończonych
 *     tasków trzymamy). Taski `running` nie są usuwane NIGDY.
 *
 * Panel biegów: rejestr jest też SKRZYNKĄ KONTAKTOWĄ do biegu — `attachAbort`
 * przyjmuje uchwyt „ubij mnie" od tego, kto suba odpalił, a `requestStop` pozwala nim
 * pociągnąć komuś, kto zna wyłącznie `id` (panel w sidebarze). Rejestr dalej nic nie wie
 * o tym, JAK się ubija suba — trzyma cudzą funkcję i tyle.
 *
 * Sterowanie w trakcie: ta sama skrzynka przyjmuje też WIADOMOŚCI — `postMessage`
 * wrzuca tekst do kolejki biegu, `takeMessages` opróżnia ją po stronie runnera (hak
 * `beforeContinue` pętli, czyli między wywołaniami modelu). Rejestr nie interpretuje
 * treści i nie doręcza jej sam; jest skrzynką, nie listonoszem.
 */
import type { AgentLoopPartialSnapshot, AgentLoopStopReason } from '../agent-loop/index.js';
import { maskSensitiveData } from '../../core/index.js';
import { EventEmitter } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import type { RunOutcome, StopBy } from './runOutcome.js';
import type { LoopMessage } from '../agent-loop/index.js';
import { ParentQuestions } from './ParentQuestions.js';
import type { Owner, QuestionId, QuestionState, ParentQuestionClock, OpenParentQuestionResult, AnswerResult } from './ParentQuestions.js';

/** Stan biegu suba. `aborted` = ubity z zewnątrz (timeout delegacji), `error` = wyjątek. */
export type SubTaskStatus = 'running' | 'done' | 'error' | 'aborted';

/** Jeden krok pętli (`loop.start`, `tool.pre`, `tool.post`, `backstop`, `loop.end`, …). */
export interface SubTaskStep {
    at: number;
    type: string;
    /** Pola zdarzenia — JUŻ ZMASKOWANE (patrz `SubTaskRegistry.step`). */
    fields: Record<string, unknown>;
}

/** Kagańce, z jakimi sub wystartował (te same liczby, które dostała pętla). */
export interface SubTaskBudget {
    maxIterations?: number;
    perCallTimeoutMs?: number;
    maxToolResultLength?: number;
}

/** Wynik biegu suba — mapowanie 1:1 z tym, co zwraca `runAgentLoop`. */
export interface SubTaskResult {
    text: string;
    toolsUsed: string[];
    durationMs: number;
    usage: unknown;
    stoppedBy?: 'natural' | 'backstop' | 'abort';
    stopReason?: AgentLoopStopReason;
    outcome?: RunOutcome;
    handoff?: string;
    question?: import('./ParentQuestions.js').TerminalQuestion;
}

/**
 * Skąd przyszło zlecenie (delegacja w tle) — adres zwrotny dla wyniku.
 *
 * Rejestr TEGO NIE INTERPRETUJE: przechowuje 1:1 i oddaje konsumentom (`SubTaskNotifier`,
 * a docelowo czat, który po tych polach trafi z powiadomieniem do właściwej zakładki/sesji).
 */
export interface SubTaskOrigin {
    agentName: string;
    sessionPath?: string;
    sessionEpoch?: string;
    tabKey?: string;
}

export interface SubThreadOwner { agentName: string; sessionPath?: string; sessionEpoch?: string }
declare const runtimeSequenceBrand: unique symbol;
export type RuntimeSequence = number & { readonly [runtimeSequenceBrand]: true };
export function isRuntimeSequence(value: unknown): value is RuntimeSequence {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function canContinueAfterUserStop(thread: SubThread, turnKind: unknown, turnStartedSeq: unknown): boolean {
    if (!thread.userStop && thread.lastUserStopSeq === undefined) return true;
    return thread.lastUserStopSeq !== undefined && isRuntimeSequence(turnStartedSeq)
        && turnStartedSeq > thread.lastUserStopSeq && (turnKind === 'user' || turnKind === 'machine')
        && (!thread.userStop || turnKind === 'user');
}
export type SubThreadEffect = RunOutcome['effects'][number] & { expectedCheck?: 'exists' | 'absent' | 'none' };
export interface SubThread {
    threadId: string; name: string; owner: SubThreadOwner; origin: SubTaskOrigin;
    phase: 'queued' | 'running' | 'idle' | 'closed'; reusable: boolean; runIds: string[];
    transcript: LoopMessage[]; config: Record<string, unknown>; userStop: boolean;
    lastUserStopSeq?: RuntimeSequence;
    lastActiveAt: number; closeAfterRun: boolean; effects: SubThreadEffect[]; closedBy?: StopBy;
}

/** Bieg sub-agenta jako byt. `id` = etykieta trace (`sub/<nazwa>#<seq>`), unikalna w procesie. */
export interface SubTask {
    questionState?: QuestionState;
    id: string;
    name: string;
    agentName: string;
    status: SubTaskStatus;
    createdAt: number;
    endedAt?: number;
    steps: SubTaskStep[];
    budget: SubTaskBudget;
    result?: SubTaskResult;
    outcome?: RunOutcome;
    stopRequestedBy?: StopBy;
    userStopSeq?: RuntimeSequence;
    partial?: AgentLoopPartialSnapshot;
    partialStorageError?: boolean;
    error?: string;
    /** Bieg odpalony W TLE (tura wołającego NIE czeka na wynik). */
    background?: boolean;
    /** Adres zwrotny zlecenia — patrz `SubTaskOrigin`. */
    origin?: SubTaskOrigin;
    /**
     * Skrót ZADANIA zleconego przez maina (≤300 znaków,
     * zmaskowany na wejściu). Panel pokazuje go w rozwinięciu chipa — user ma widzieć,
     * PO CO ten bieg w ogóle wystartował, nie tylko co klika.
     */
    taskPreview?: string;
    threadId?: string;
    /**
     * Ktoś (panel) poprosił o zatrzymanie tego biegu. To ZNACZNIK PROŚBY, nie status —
     * bieg gaśnie dopiero, gdy pętla suba dojedzie do najbliższego punktu przerwania i
     * domknie się przez `finish`/`fail`. Panel dzięki temu może pokazać „zatrzymywanie…".
     */
    stopRequested?: boolean;
}

/** Funkcja-tee podawana do pętli — ten sam kształt co `TraceLog.scope(label)`. */
export type SubTaskTrace = (type: string, fields?: Record<string, unknown>) => void;

/**
 * Minimalny widok `TraceLog`, jakiego rejestr naprawdę używa (duck-typing, żeby test mógł
 * podstawić atrapę i żeby moduł nie wisiał na klasie z core).
 */
export interface SubTaskTraceLogLike {
    scope?: (label: string) => SubTaskTrace;
}

export interface SubTaskRegistryOptions {
    questionClock?: ParentQuestionClock;
    /** Gdy podany — rejestr sam subskrybuje domyślnego konsumenta piszącego do trace.log. */
    traceLog?: SubTaskTraceLogLike | null;
    /** W produkcji `maskSensitiveData`; brak = zero maskowania (tylko testy/harness). */
    mask?: ((value: string) => string) | null;
    maxDone?: number;
    maxStepsPerTask?: number;
    /** Sufit kolejki wiadomości do jednego biegu (patrz `postMessage`). */
    maxMessagesPerTask?: number;
    maxThreadRuns?: number;
    maxThreadTranscriptChars?: number;
    threadIdleMs?: number;
    maxIdleThreadsPerSession?: number;
}

/** Ile ZAKOŃCZONYCH biegów trzymamy w pamięci (starsze wypadają). */
const DEFAULT_MAX_DONE = 50;
/** Ile kroków per bieg ląduje w RAM (nadmiar idzie tylko do konsumentów, np. do pliku). */
const DEFAULT_MAX_STEPS_PER_TASK = 500;
/**
 * Ile NIEODEBRANYCH wiadomości do biegu trzymamy w kolejce. Sufit jest niski celowo —
 * kolejka opróżnia się przy najbliższej iteracji pętli, więc dziesięć czekających znaczy,
 * że user sypie poleceniami szybciej, niż sub jest w stanie je przeczytać. Nadmiarowe
 * odrzucamy (`postMessage` → `false`), a nie wypychamy najstarsze: przy sterowaniu biegiem
 * cicha utrata polecenia jest gorsza niż odmowa.
 */
const DEFAULT_MAX_MESSAGES_PER_TASK = 10;
/** Wątek trzyma tylko najnowsze fakty o efektach, niezależnie od retencji SubTask. */
const MAX_THREAD_EFFECTS = 100;

export class SubTaskRegistry {
    private readonly _questions: ParentQuestions;
    private _runtimeSequence = 0;
    private _nextSequence(): RuntimeSequence {
        if (this._runtimeSequence >= Number.MAX_SAFE_INTEGER) throw new Error('Runtime sequence exhausted');
        return ++this._runtimeSequence as RuntimeSequence;
    }
    issueTurnStartSequence(): RuntimeSequence { return this._nextSequence(); }
    openParentQuestion(taskId: string, text: string): OpenParentQuestionResult {
        const task = this._tasks.get(taskId);
        return task ? this._questions.open(task, text) : { kind: 'rejected', reason: 'unavailable' };
    }
    cancelParentQuestion(taskId: string): void {
        const task = this._tasks.get(taskId);
        if (task) this._questions.close(task, { kind: 'cancelled', by: task.stopRequestedBy ?? 'system', reason: 'run-ended' });
    }
    answerParentQuestion(taskId: string, id: QuestionId, owner: Owner, text: string): AnswerResult {
        return this._questions.answer(this._tasks.get(taskId), id, owner, text);
    }
    getQuestionState(taskId: string): QuestionState {
        const task = this._tasks.get(taskId);
        return task ? this._questions.check(task) : { kind: 'none' };
    }
    isQuestionOpen(taskId: string, id: QuestionId): boolean {
        const state = this.getQuestionState(taskId);
        return state.kind === 'waiting' && state.question.id === id;
    }
    registerUserWait(owner: Owner, cancel: () => void): () => void { return this._questions.registerUserWait(owner, cancel); }
    promoteToBackground(taskId: string): boolean {
        const task = this._tasks.get(taskId);
        if (!task || task.status !== 'running' || task.stopRequested) return false;
        task.background = true;
        return true;
    }
    // `declare` = sama deklaracja typu, zero emitu.
    /** Szyna zdarzeń: `task:created` (task), `task:step` ({task, step}), `task:finished` (task). */
    declare events: EventEmitter;
    declare private _tasks: Map<string, SubTask>;
    declare private _threads: Map<string, SubThread>;
    declare private _traceLog: SubTaskTraceLogLike | null;
    /** Cache funkcji `scope` per id taska — jedna na bieg, kasowana przy `task:finished`. */
    declare private _traceScopes: Map<string, SubTaskTrace>;
    /**
     * Uchwyty „ubij ten bieg" per id taska (side-channel abortów). Rejestr NIE WIE,
     * jak się ubija suba — zna tylko funkcję, którą wstrzyknął ten, kto bieg odpalił
     * (`DelegateTool`). Wpis żyje dokładnie tyle co bieg (kasowany przy `task:finished`).
     */
    declare private _aborts: Map<string, () => void>;
    /**
     * Kolejka wiadomości od agenta zlecającego do KONKRETNEGO biegu (side-channel sterowania).
     * Rejestr nie wie, co się z nimi stanie — zdejmuje je runner w haku `beforeContinue`
     * i dopisuje do transkryptu suba. Wpis żyje dokładnie tyle co bieg.
     */
    declare private _messages: Map<string, string[]>;
    declare private _mask: ((value: string) => string) | null;
    declare private _maxDone: number;
    declare private _maxStepsPerTask: number;
    declare private _maxMessagesPerTask: number;
    declare private _threadLimits: { runs: number; chars: number; idleMs: number; perSession: number };

    constructor({
        traceLog = null,
        mask = null,
        maxDone = DEFAULT_MAX_DONE,
        maxStepsPerTask = DEFAULT_MAX_STEPS_PER_TASK,
        maxMessagesPerTask = DEFAULT_MAX_MESSAGES_PER_TASK,
        maxThreadRuns = 5, maxThreadTranscriptChars = 200000, threadIdleMs = 1800000, maxIdleThreadsPerSession = 3,
        questionClock,
    }: SubTaskRegistryOptions = {}) {
        this.events = new EventEmitter();
        this._questions = new ParentQuestions((event, payload) => this.events.emit(event, payload), questionClock);
        this._tasks = new Map();
        this._threads = new Map();
        this._threadLimits = { runs: maxThreadRuns, chars: maxThreadTranscriptChars, idleMs: threadIdleMs, perSession: maxIdleThreadsPerSession };
        this._traceScopes = new Map();
        this._aborts = new Map();
        this._messages = new Map();
        this._traceLog = traceLog || null;
        this._mask = typeof mask === 'function' ? mask : null;
        this._maxDone = Number(maxDone) > 0 ? Number(maxDone) : DEFAULT_MAX_DONE;
        this._maxStepsPerTask = Number(maxStepsPerTask) > 0 ? Number(maxStepsPerTask) : DEFAULT_MAX_STEPS_PER_TASK;
        this._maxMessagesPerTask = Number(maxMessagesPerTask) > 0 ? Number(maxMessagesPerTask) : DEFAULT_MAX_MESSAGES_PER_TASK;
        this._subscribeHousekeeping();
        if (this._traceLog) this._subscribeTraceConsumer();
        if (this._traceLog) this.events.on('thread:created', (x: unknown) => this._traceThread(x, 'thread.created'));
        if (this._traceLog) this.events.on('thread:idle', (x: unknown) => this._traceThread(x, 'thread.idle'));
        if (this._traceLog) this.events.on('thread:closed', (x: unknown) => this._traceThread(x, 'thread.closed'));
    }

    private _traceThread(value: unknown, type: string): void {
        const thread = value as SubThread | undefined;
        if (thread?.threadId) this._traceLog?.scope?.(thread.threadId)?.(type, { threadId: thread.threadId, phase: thread.phase });
    }

    createThread(input: { threadId: string; name: string; owner: SubThreadOwner; origin: SubTaskOrigin; config: Record<string, unknown>; phase?: SubThread['phase'] }): SubThread {
        const now = Date.now();
        const thread: SubThread = { ...input, owner: { ...input.owner }, origin: { ...input.origin }, config: structuredClone(input.config), phase: input.phase ?? 'running', reusable: false, runIds: [], transcript: [], userStop: false, lastActiveAt: now, closeAfterRun: false, effects: [] };
        this._threads.set(thread.threadId, thread);
        this.events.emit('thread:created', thread);
        this._pruneIdleThreads();
        return thread;
    }

    beginRun(threadId: string, owner: SubThreadOwner, turn?: { turnKind?: unknown; turnStartedSeq?: unknown }): boolean {
        const thread = this._threads.get(threadId);
        if (thread?.phase === 'idle') {
            const idleMs = Number((thread.config.limits as Record<string, unknown> | undefined)?.subagent_thread_idle_ms) || this._threadLimits.idleMs;
            if (Date.now() - thread.lastActiveAt >= idleMs) this._closeThreadData(thread);
        }
        if (!thread || thread.phase !== 'idle' || !owner?.agentName || !owner.sessionPath || !owner.sessionEpoch
            || !thread.owner.agentName || !thread.owner.sessionPath || !thread.owner.sessionEpoch
            || thread.owner.agentName !== owner.agentName || thread.owner.sessionPath !== owner.sessionPath || thread.owner.sessionEpoch !== owner.sessionEpoch || !thread.reusable) return false;
        if (!canContinueAfterUserStop(thread, turn?.turnKind, turn?.turnStartedSeq)) return false;
        thread.phase = 'running'; thread.userStop = false; thread.lastActiveAt = Date.now(); return true;
    }

    beginQueuedRun(threadId: string, owner: SubThreadOwner, frozenConfig: Record<string, unknown>): boolean {
        const thread = this._threads.get(threadId);
        if (!thread || thread.phase !== 'queued' || !owner?.agentName || thread.owner.agentName !== owner.agentName
            || thread.owner.sessionPath !== owner.sessionPath || thread.owner.sessionEpoch !== owner.sessionEpoch) return false;
        thread.config = structuredClone(frozenConfig);
        thread.phase = 'running';
        thread.lastActiveAt = Date.now();
        return true;
    }

    endRun(threadId: string, input: { successful: boolean; transcript?: LoopMessage[]; effects?: SubThreadEffect[]; answer?: string; userStop?: boolean } ): void {
        const thread = this._threads.get(threadId); if (!thread || thread.phase !== 'running') return;
        const transcript = (input.transcript ?? thread.transcript).filter(m => m.role !== 'system').map(m => structuredClone(m));
        if (input.answer && !transcript.some(m => m.role === 'assistant' && m.content === input.answer)) transcript.push({ role: 'assistant', content: input.answer });
        thread.transcript = transcript;
        if (input.effects?.length) {
            thread.effects = [...thread.effects, ...input.effects.map(e => structuredClone(e))].slice(-MAX_THREAD_EFFECTS);
        }
        thread.userStop ||= Boolean(input.userStop);
        if (input.userStop && thread.lastUserStopSeq === undefined) thread.lastUserStopSeq = this._nextSequence();
        thread.lastActiveAt = Date.now();
        const threadLimits = thread.config.limits as Record<string, unknown> | undefined;
        const maxRuns = Number(threadLimits?.subagent_thread_max_runs) || this._threadLimits.runs;
        const maxChars = Number(threadLimits?.subagent_thread_transcript_max_chars) || this._threadLimits.chars;
        thread.reusable = Boolean(input.successful && thread.origin.sessionPath && thread.origin.sessionEpoch && thread.runIds.length < maxRuns && JSON.stringify(transcript).length <= maxChars && !thread.closeAfterRun);
        if (thread.reusable) { thread.phase = 'idle'; this.events.emit('thread:idle', thread); }
        else this._closeThreadData(thread);
        this._pruneIdleThreads();
    }

    closeThread(threadId: string, by: StopBy = 'user'): boolean { const t = this._threads.get(threadId); if (!t || t.phase === 'closed') return false; if (t.phase === 'running') t.closeAfterRun = true; else { if (t.phase === 'queued') { t.closedBy ??= by; if (by === 'user') { t.userStop = true; t.lastUserStopSeq = this._nextSequence(); } } this._closeThreadData(t); } return true; }
    /** Stop from the strip resolves the current thread phase at click time. */
    stopThread(threadId: string): boolean {
        const thread = this._threads.get(threadId);
        if (!thread) return false;
        if (thread.phase === 'queued') return this.closeThread(threadId, 'user');
        if (thread.phase === 'running') {
            const runId = thread.runIds[thread.runIds.length - 1];
            return runId ? this.requestStop(runId, 'user') : false;
        }
        return false;
    }
    closeSessionThreads(agentName: string, sessionPath: string): number { let n = 0; for (const t of this._threads.values()) if (t.owner.agentName === agentName && t.owner.sessionPath === sessionPath && this.closeThread(t.threadId, 'system')) n++; return n; }
    closeAll(): void { for (const t of this._threads.values()) this.closeThread(t.threadId, 'system'); }
    closeQueuedForOwners(input: { tabKeys: string[]; agentNames: string[] }, by: StopBy): number {
        const tabKeys = new Set(input.tabKeys.filter(Boolean));
        const agentNames = new Set(input.agentNames.filter(Boolean));
        let count = 0;
        for (const thread of this._threads.values()) {
            if (thread.phase !== 'queued') continue;
            const origin = thread.origin;
            const matches = origin.tabKey ? tabKeys.has(origin.tabKey) : agentNames.has(origin.agentName);
            if (matches && this.closeThread(thread.threadId, by)) count++;
        }
        return count;
    }
    finishQueuedStop(threadId: string, input: { background?: boolean; taskPreview?: string }): SubTask | undefined {
        const thread = this._threads.get(threadId);
        if (!thread || thread.phase !== 'closed' || !thread.closedBy || this._tasks.has(threadId)) return undefined;
        const task: SubTask = { id: threadId, name: thread.name, agentName: thread.owner.agentName, status: 'done', createdAt: Date.now(), endedAt: Date.now(), steps: [], budget: {}, threadId,
            origin: { ...thread.origin }, outcome: { end: { kind: 'stopped', by: thread.closedBy }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } };
        if (thread.lastUserStopSeq !== undefined) task.userStopSeq = thread.lastUserStopSeq;
        if (input.background !== undefined) task.background = input.background;
        if (typeof input.taskPreview === 'string' && input.taskPreview.trim()) task.taskPreview = this._mask ? this._mask(input.taskPreview.trim().slice(0, 300)) : input.taskPreview.trim().slice(0, 300);
        this._tasks.set(task.id, task);
        // Synthetic completion is the queued thread's first run; link it so
        // the chat strip can render the stopped result inside that thread.
        thread.runIds.push(task.id);
        this.events.emit('task:created', task);
        this.events.emit('task:finished', task);
        this._evictOldDone();
        return task;
    }
    finishQueuedFailure(threadId: string, input: { error: string; background?: boolean; taskPreview?: string }): SubTask | undefined {
        const thread = this._threads.get(threadId);
        if (!thread || thread.phase !== 'queued' || this._tasks.has(threadId)) return undefined;
        const error = this._mask ? this._mask(maskSensitiveData(input.error)) : maskSensitiveData(input.error);
        thread.closedBy = 'system';
        this._closeThreadData(thread);
        const now = Date.now();
        const task: SubTask = { id: threadId, name: thread.name, agentName: thread.owner.agentName, status: 'error', createdAt: now, endedAt: now, steps: [], budget: {}, threadId,
            origin: { ...thread.origin }, error,
            outcome: { end: { kind: 'failed', stage: 'work' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } };
        if (input.background !== undefined) task.background = input.background;
        if (typeof input.taskPreview === 'string' && input.taskPreview.trim()) task.taskPreview = this._mask ? this._mask(maskSensitiveData(input.taskPreview.trim().slice(0, 300))) : maskSensitiveData(input.taskPreview.trim().slice(0, 300));
        this._tasks.set(task.id, task);
        thread.runIds.push(task.id);
        this.events.emit('task:created', task);
        this.events.emit('task:finished', task);
        this._evictOldDone();
        return task;
    }
    listThreads(owner: SubThreadOwner): SubThread[] { return [...this._threads.values()].filter(t => t.owner.agentName === owner.agentName && t.owner.sessionPath === owner.sessionPath && t.owner.sessionEpoch === owner.sessionEpoch); }
    getThread(threadId: string): SubThread | undefined { return this._threads.get(threadId); }
    getThreadMaxRuns(threadId: string): number {
        const thread = this._threads.get(threadId);
        const configured = Number((thread?.config.limits as Record<string, unknown> | undefined)?.subagent_thread_max_runs);
        return Number.isFinite(configured) && configured > 0 ? configured : this._threadLimits.runs;
    }
    private _closeThreadData(thread: SubThread): void {
        const queued = thread.phase === 'queued';
        thread.phase = 'closed'; thread.reusable = false; thread.closeAfterRun = false; thread.transcript = []; thread.effects = []; thread.lastActiveAt = Date.now();
        if (!queued && thread.runIds.length > 0 && !thread.runIds.some(id => this._tasks.has(id))) this._threads.delete(thread.threadId);
        this.events.emit('thread:closed', thread);
    }
    private _pruneIdleThreads(): void {
        const now = Date.now(); const idle = [...this._threads.values()].filter(t => t.phase === 'idle');
        for (const t of idle) {
            const idleMs = Number((t.config.limits as Record<string, unknown> | undefined)?.subagent_thread_idle_ms) || this._threadLimits.idleMs;
            if (now - t.lastActiveAt >= idleMs) this._closeThreadData(t);
        }
        const groups = new Map<string, SubThread[]>();
        for (const t of this._threads.values()) if (t.phase === 'idle' && t.owner.sessionPath) { const k = `${t.owner.agentName}\u0000${t.owner.sessionPath}\u0000${t.owner.sessionEpoch ?? ''}`; groups.set(k, [...(groups.get(k) ?? []), t]); }
        for (const rows of groups.values()) {
            rows.sort((a,b) => a.lastActiveAt-b.lastActiveAt);
            const maxIdle = Math.min(...rows.map(t => Number((t.config.limits as Record<string, unknown> | undefined)?.subagent_thread_max_idle_per_session) || this._threadLimits.perSession));
            while (rows.length > maxIdle) this._closeThreadData(rows.shift()!);
        }
    }

    /**
     * Sprzątanie własnych map — subskrypcja BEZWARUNKOWA (w odróżnieniu od konsumenta
     * trace, który wisi na obecności `traceLog`). Bieg skończony → jego uchwyt abortu
     * nie ma już czego ubijać, a trzymanie go byłoby wyciekiem domknięcia.
     */
    private _subscribeHousekeeping(): void {
        this.events.on('task:finished', (payload: unknown) => {
            const task = payload as SubTask | undefined;
            if (!task?.id) return;
            this._aborts.delete(task.id);
            // Niedoręczone wiadomości do zakończonego biegu nie mają już adresata.
            this._messages.delete(task.id);
        });
    }

    /**
     * Domyślny konsument zdarzeń: zapis do trace.log. Plik jest ODBIORCĄ,
     * nie właścicielem śladu. Formatowanie linii (`label | type | k=v`) i maskowanie
     * całej linii robi `TraceLog.scope`, więc format nie zmienia się ani o bajt.
     */
    private _subscribeTraceConsumer(): void {
        this.events.on('task:step', (payload: unknown) => {
            const { task, step } = (payload || {}) as { task?: SubTask; step?: SubTaskStep };
            if (!task?.id || !step) return;
            this._scopeFor(task.id)?.(step.type, step.fields);
        });
        // Bieg skończony → etykieta nigdy więcej nie wróci, więc puszczamy jej funkcję scope.
        this.events.on('task:finished', (payload: unknown) => {
            const task = payload as SubTask | undefined;
            if (task?.id) this._traceScopes.delete(task.id);
        });
    }

    /** Funkcja trace związana z etykietą taska (leniwie tworzona, cache'owana per id). */
    private _scopeFor(id: string): SubTaskTrace | null {
        const cached = this._traceScopes.get(id);
        if (cached) return cached;
        const fn = this._traceLog?.scope?.(id);
        if (typeof fn !== 'function') return null;
        this._traceScopes.set(id, fn);
        return fn;
    }

    /** Maskuje stringowe wartości pól; nie-stringi (liczby, obiekty) przechodzą bez zmian. */
    private _maskFields(fields: Record<string, unknown> | null | undefined): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        if (!fields || typeof fields !== 'object') return out;
        for (const [key, value] of Object.entries(fields)) {
            out[key] = (typeof value === 'string' && this._mask) ? this._mask(value) : value;
        }
        return out;
    }

    /**
     * Zakłada byt dla nowego biegu suba i ogłasza `task:created`.
     * @param id - etykieta trace tego wywołania (`sub/<nazwa>#<seq>`) — jednocześnie klucz rejestru.
     * @param background - bieg w tle (wołający nie czeka). Rejestr tylko przechowuje flagę.
     * @param origin - adres zwrotny zlecenia. Rejestr go NIE interpretuje (patrz `SubTaskOrigin`).
     */
    create({ id, name, agentName, budget, background, origin, taskPreview, threadId }: {
        id: string;
        name?: string;
        agentName?: string;
        budget?: SubTaskBudget;
        background?: boolean;
        origin?: SubTaskOrigin;
        taskPreview?: string;
        threadId?: string;
    }): SubTask {
        const task: SubTask = {
            id,
            name: name || 'sub',
            agentName: agentName || '',
            status: 'running',
            createdAt: Date.now(),
            steps: [],
            budget: budget ? { ...budget } : {},
            questionState: { kind: 'none' },
        };
        // Pola opcjonalne dokładamy tylko gdy podane — kształt bytu bez delegacji w tle
        // zostaje bit w bit ten sam (konsumenci sprawdzają obecność pola).
        if (background !== undefined) task.background = background;
        if (threadId) { task.threadId = threadId; this._threads.get(threadId)?.runIds.push(id); }
        if (origin) task.origin = { ...origin };
        // Skrót zadania przechodzi przez tę samą maskę co kroki (zadanie potrafi
        // nieść sekret z kontekstu rodzica) i ma twardy sufit — to podgląd, nie transkrypt.
        if (typeof taskPreview === 'string' && taskPreview.trim()) {
            const trimmed = taskPreview.trim().slice(0, 300);
            task.taskPreview = this._mask ? this._mask(trimmed) : trimmed;
        }
        this._tasks.set(task.id, task);
        this.events.emit('task:created', task);
        return task;
    }

    /**
     * Dopisuje krok pętli i ogłasza `task:step`.
     *
     * ⚠️ Po przekroczeniu `maxStepsPerTask` krok NIE ląduje w tablicy, ale zdarzenie leci
     * dalej — plik trace ma pełny ślad biegu, RAM ma sufit. Metoda NIGDY nie rzuca:
     * księgowość nie ma prawa ubić sub-agenta w połowie roboty.
     */
    step(task: SubTask, type: string, fields: Record<string, unknown> = {}): void {
        try {
            if (!task) return;
            const step: SubTaskStep = { at: Date.now(), type: String(type), fields: this._maskFields(fields) };
            if (Array.isArray(task.steps) && task.steps.length < this._maxStepsPerTask) {
                task.steps.push(step);
            }
            this.events.emit('task:step', { task, step });
        } catch (e) {
            log.warn('SubTaskRegistry', 'step() padł (bieg suba leci dalej):', e);
        }
    }

    /** Domyka bieg wynikiem. `stoppedBy: 'abort'` → status `aborted`, reszta → `done`. */
    publishPartial(task: SubTask, snapshot: AgentLoopPartialSnapshot): void {
        if (task.status !== 'running' || snapshot.revision <= (task.partial?.revision ?? 0)) return;
        const mask = (value: string) => {
            const safe = maskSensitiveData(value).replace(/\b(https?:\/\/)[^\s/@"\\]+@/gi, '$1[REDACTED]@');
            return this._mask ? this._mask(safe) : safe;
        };
        task.partial = Object.freeze({
            ...snapshot, stopReason: Object.freeze({ ...snapshot.stopReason }),
            toolsUsed: Object.freeze(snapshot.toolsUsed.map(mask)),
            toolOutcomes: Object.freeze(snapshot.toolOutcomes.map(o => Object.freeze({ ...o, name: mask(o.name), ...(o.id ? { id: mask(o.id) } : {}), resultPreview: mask(o.resultPreview) }))),
            toolCallDetails: Object.freeze(snapshot.toolCallDetails.map(d => Object.freeze({ ...d, ...(d.name ? { name: mask(d.name) } : {}), resultPreview: mask(d.resultPreview) }))),
            usage: Object.freeze({ ...snapshot.usage }), lastText: mask(snapshot.lastText), text: mask(snapshot.text),
        });
        this.events.emit('task:partial', task);
    }

    finish(task: SubTask, result: SubTaskResult): void {
        try {
            if (!task) return;
            if (task.status !== 'running') return;
            task.result = result;
            task.outcome = result.outcome;
            task.status = result?.stoppedBy === 'abort' ? 'aborted' : 'done';
            task.endedAt = Date.now();
            this._questions.close(task, { kind: 'cancelled', by: 'system', reason: 'run-ended' });
            this.events.emit('task:finished', task);
            this._evictOldDone();
        } catch (e) {
            log.warn('SubTaskRegistry', 'finish() padł (bieg suba leci dalej):', e);
        }
    }

    /** Domyka bieg błędem. Tekst błędu maskujemy — API zwraca w nim czasem klucz. */
    fail(task: SubTask, error: string, outcome?: RunOutcome, result?: SubTaskResult): void {
        try {
            if (!task) return;
            if (task.status !== 'running') return;
            const message = typeof error === 'string' ? error : String(error);
            task.status = 'error';
            if (outcome) task.outcome = outcome;
            task.error = this._mask ? this._mask(message) : message;
            if (result) task.result = result;
            task.endedAt = Date.now();
            this._questions.close(task, { kind: 'cancelled', by: 'system', reason: 'run-ended' });
            this.events.emit('task:finished', task);
            this._evictOldDone();
        } catch (e) {
            log.warn('SubTaskRegistry', 'fail() padł (bieg suba leci dalej):', e);
        }
    }

    /**
     * Funkcja-tee dla pętli agenta — kształt identyczny z `TraceLog.scope(label)`, więc
     * `runAgentLoop` nie wie, że pisze do rejestru zamiast wprost do pliku.
     */
    traceFor(task: SubTask): SubTaskTrace {
        return (type: string, fields: Record<string, unknown> = {}) => this.step(task, type, fields);
    }

    /**
     * Podepnij uchwyt „zatrzymaj ten bieg". Woła to ten, kto suba odpalił
     * (`DelegateTool`) — tylko on ma jednocześnie `task.id` i domkniętą kontrolkę abortu.
     * Rejestr uchwytu nie interpretuje; jest tylko skrzynką kontaktową dla panelu.
     */
    attachAbort(id: string, fn: () => void): void {
        try {
            if (!id || typeof fn !== 'function') return;
            this._aborts.set(id, fn);
        } catch (e) {
            log.warn('SubTaskRegistry', 'attachAbort() padł (bieg suba leci dalej):', e);
        }
    }

    /**
     * Poproś o zatrzymanie biegu. Zwraca `true` TYLKO gdy prośba miała dokąd pójść —
     * czyli bieg istnieje, jeszcze biegnie i ma podpięty uchwyt.
     *
     * ⚠️ To jest PROŚBA, nie egzekucja: znacznik `stopRequested` i ślad `stop.requested`
     * lądują od razu (panel może pokazać „zatrzymywanie…"), ale status zmieni się dopiero,
     * gdy pętla suba naprawdę stanie i domknie byt przez `finish`/`fail`.
     */
    requestStop(id: string, by: StopBy = 'user'): boolean {
        try {
            const task = this._tasks.get(id);
            const stop = this._aborts.get(id);
            if (!task || !stop || task.status !== 'running') return false;
            task.stopRequested = true;
            task.stopRequestedBy ??= by;
            this._questions.close(task, { kind: 'cancelled', by: task.stopRequestedBy, reason: 'stop' });
            if (by === 'user') {
                const seq = this._nextSequence();
                task.userStopSeq = seq;
                const thread = task.threadId ? this._threads.get(task.threadId) : undefined;
                if (thread) { thread.userStop = true; thread.lastUserStopSeq = seq; }
            }
            // Ślad idzie tą samą drogą co reszta kroków — także do trace.log. Harness liczy
            // KONKRETNE typy zdarzeń, więc dodatkowy typ go nie rusza.
            this.step(task, 'stop.requested', { by: task.stopRequestedBy });
            try {
                stop();
            } catch (e) {
                log.warn('SubTaskRegistry', `uchwyt stop dla ${id} rzucił (prośba i tak zapisana):`, e);
            }
            return true;
        } catch (e) {
            log.warn('SubTaskRegistry', 'requestStop() padł:', e);
            return false;
        }
    }

    /**
     * Zatrzymaj WSZYSTKIE żywe biegi — demontaż pluginu.
     *
     * PO CO: gdyby `dispose()` czyścił mapę uchwytów BEZ ich wywołania, wyłączenie pluginu
     * zrywałoby kanały raportowania, ale nie zatrzymywałoby egzekucji: sub odpalony w tle
     * mieliłby dalej na wciąż żywym `mcpClient` (realny zapis do vaulta) i znikałby z trace.log,
     * bo szyna zdarzeń byłaby już odpięta. Demontaż ma NAJPIERW zatrzymać, POTEM odpiąć — stąd
     * osobna metoda, wołana z `onunload` PRZED `dispose()`.
     *
     * ⚠️ To zbiorcza PROŚBA, nie egzekucja (jak `requestStop`): uchwyt podnosi flagę abortu
     * i przerywa stream modelu, a bieg gaśnie przy najbliższym punkcie przerwania swojej
     * pętli. `onunload` NIE CZEKA na zejście biegów (Obsidian nie czeka na obietnice).
     *
     * @param reason - powód lądujący w śladzie `stop.requested` i w logu (`'unload'`, …)
     * @returns ile uchwytów wykonało się bez wyjątku (uchwyt, który rzucił, nie blokuje reszty)
     */
    stopAll(reason = 'stopAll'): number {
        let stopped = 0;
        for (const task of this._tasks.values()) {
            if (task.questionState?.kind === 'waiting') { task.stopRequested = true; task.stopRequestedBy ??= 'system'; }
        }
        for (const task of this._tasks.values()) {
            this._questions.close(task, { kind: 'cancelled', by: 'system', reason: 'unload' });
        }
        try {
            // Kopia: uchwyt potrafi domknąć bieg synchronicznie, a housekeeping kasuje wtedy
            // wpis z `_aborts` w trakcie iteracji.
            for (const [id, stop] of [...this._aborts]) {
                const task = this._tasks.get(id);
                try {
                    if (task && task.status === 'running' && !task.stopRequested) {
                        task.stopRequested = true;
                        task.stopRequestedBy ??= 'system';
                        // Ślad tą samą drogą co `requestStop` — trace.log jeszcze żyje (zamykamy
                        // go po rejestrze), więc w logu zostaje dowód, że bieg dostał sygnał.
                        this.step(task, 'stop.requested', { by: task.stopRequestedBy, reason });
                    }
                    stop();
                    stopped++;
                    log.info('SubTaskRegistry', `stopAll(${reason}): zatrzymuję bieg ${id} (agent ${task?.agentName || '?'})`);
                } catch (e) {
                    log.warn('SubTaskRegistry', `stopAll(${reason}): uchwyt ${id} (agent ${task?.agentName || '?'}) rzucił — lecę dalej:`, e);
                }
            }
        } catch (e) {
            log.warn('SubTaskRegistry', 'stopAll() padł:', e);
        }
        return stopped;
    }

    /**
     * Wrzuć wiadomość od agenta zlecającego do biegu, który TRWA (side-channel sterowania).
     *
     * Zwraca `true` tylko wtedy, gdy wiadomość ma dokąd pójść: bieg istnieje, ma status
     * `running` i kolejka nie jest pełna. Sam rejestr jej NIE DORĘCZA — leży w kolejce,
     * dopóki runner nie zdejmie jej przez `takeMessages` w haku `beforeContinue` pętli.
     *
     * ⚠️ To jest DORĘCZENIE PRZY NAJBLIŻSZEJ ITERACJI, nie przerwanie. Sub w środku
     * długiego strumienia przeczyta ją dopiero po nim, a sub, który właśnie wszedł
     * w ostatnią iterację (backstop), może jej nie przeczytać wcale — kolejka zniknie
     * razem z biegiem. Od twardego zatrzymania jest `requestStop`.
     *
     * Treść maskujemy tak samo jak pola kroków — user potrafi wkleić w polecenie klucz.
     */
    postMessage(id: string, text: string): boolean {
        try {
            const task = this._tasks.get(id);
            if (!task || task.status !== 'running') return false;
            const raw = typeof text === 'string' ? text.trim() : '';
            if (!raw) return false;
            const queue = this._messages.get(id) || [];
            // Sufit: odmawiamy zamiast wypychać najstarsze — cicha utrata polecenia
            // sterującego byłaby gorsza od uczciwego „nie zmieściło się".
            if (queue.length >= this._maxMessagesPerTask) return false;
            const safe = maskSensitiveData(raw);
            const maskedMessage = this._mask ? this._mask(safe) : safe;
            const preview = maskedMessage.slice(0, 200);
            queue.push(maskedMessage);
            this._messages.set(id, queue);
            // Ślad idzie tą samą drogą co reszta kroków (także do trace.log) — NOWY TYP
            // zdarzenia, nie zmiana formatu linii. Do śladu wchodzi długość oraz
            // krótki, zamaskowany podgląd; pełna treść zostaje w transkrypcie suba.
            this.step(task, 'user.message', { chars: maskedMessage.length, preview });
            return true;
        } catch (e) {
            log.warn('SubTaskRegistry', 'postMessage() padł:', e);
            return false;
        }
    }

    /**
     * Zdejmij wszystkie czekające wiadomości do biegu (woła runner między iteracjami).
     * Zabiera je z kolejki — druga próba na tym samym biegu odda pustą tablicę.
     */
    takeMessages(id: string): string[] {
        try {
            const queue = this._messages.get(id);
            if (!queue || queue.length === 0) return [];
            this._messages.delete(id);
            return queue;
        } catch (e) {
            log.warn('SubTaskRegistry', 'takeMessages() padł:', e);
            return [];
        }
    }

    getTask(id: string): SubTask | undefined {
        return this._tasks.get(id);
    }

    /**
     * Zamknięcie/archiwizacja sesji czatu (biegi subów należą do SESJI): wymiata
     * z rejestru ZAKOŃCZONE biegi tej sesji — nie mają już czego pokazywać
     * w nowej rozmowie. Biegi `running` zostają (sieroty widać na pasku i da się je ubić).
     * Zwraca liczbę usuniętych. Fail-soft jak reszta metod.
     */
    pruneSession(sessionPath: string): number {
        try {
            if (!sessionPath) return 0;
            let removed = 0;
            for (const [id, task] of [...this._tasks]) {
                if (task.status === 'running') continue;
                if ((task.origin?.sessionPath || '') !== sessionPath) continue;
                this._tasks.delete(id);
                this._traceScopes.delete(id);
                this._aborts.delete(id);
                this._messages?.delete?.(id);
                removed++;
            }
            for (const [id, thread] of this._threads) {
                if (thread.owner.sessionPath === sessionPath && thread.phase === 'closed') this._threads.delete(id);
            }
            return removed;
        } catch (e) {
            log.warn('SubTaskRegistry', 'pruneSession() padł (nieszkodliwie):', e);
            return 0;
        }
    }

    /** Wszystkie znane biegi w kolejności powstania (Map trzyma kolejność wstawienia). */
    list(): SubTask[] {
        return [...this._tasks.values()];
    }

    /** Retencja: nadmiarowe ZAKOŃCZONE biegi wylatują od najstarszego; `running` zostaje. */
    private _evictOldDone(): void {
        let done = 0;
        for (const task of this._tasks.values()) {
            if (task.status !== 'running') done++;
        }
        let toDrop = done - this._maxDone;
        if (toDrop <= 0) return;
        for (const [id, task] of this._tasks) {
            if (toDrop <= 0) break;
            if (task.status === 'running') continue;
            this._tasks.delete(id);
            this._traceScopes.delete(id);
            this._aborts.delete(id);
            this._messages.delete(id);
            const thread = task.threadId ? this._threads.get(task.threadId) : undefined;
            if (thread?.phase === 'closed' && !thread.runIds.some(runId => this._tasks.has(runId))) this._threads.delete(thread.threadId);
            toDrop--;
        }
    }

    /**
     * Sprzątanie przy `onunload` pluginu — odpina konsumentów i puszcza pamięć.
     *
     * ⚠️ Z7: `dispose()` NICZEGO NIE ZATRZYMUJE — puszcza uchwyty, nie woła ich. Zatrzymanie
     * biegów to `stopAll()`, wołane PRZED tą metodą (patrz `PKMPlugin.onunload`). Sama metoda
     * zostaje best-effort i idempotentna: wolno ją zawołać dwa razy i nie ma prawa rzucić.
     */
    dispose(): void {
        this._questions.dispose();
        try {
            this.events.removeAllListeners();
            this._tasks.clear();
            this._threads.clear();
            this._traceScopes.clear();
            this._aborts.clear();
            this._messages.clear();
        } catch (e) {
            log.warn('SubTaskRegistry', 'dispose() padł:', e);
        }
    }
}
