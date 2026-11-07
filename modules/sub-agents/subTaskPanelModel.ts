/** Czysty model paska czatu. Wiersz wątku niesie uporządkowaną oś biegów, a bieg bez wątku ma własny wiersz. */
import type { SubTask, SubTaskStep, SubThread, SubThreadEffect } from './SubTaskRegistry.js';
import type { RunEnd, RunOutcome } from './runOutcome.js';
import type { Dependency, NonEmpty } from './DelegationPlan.js';
import type { QuestionState } from './ParentQuestions.js';

export type StripState =
    | { kind: 'waiting'; dependencies: NonEmpty<Dependency> }
    | { kind: 'blocked'; causes: NonEmpty<Dependency> }
    | { kind: 'queued'; position: number }
    | { kind: 'running' }
    | { kind: 'stopping' }
    | { kind: 'idle' }
    | { kind: 'done' }
    | { kind: 'partial'; reason: 'incomplete' | 'limit' | 'timeout' | 'user-stop' | 'lead-stop' | 'system-stop' | 'error' | 'uncertain' }
    | { kind: 'empty' }
    | { kind: 'delivery' }
    | { kind: 'closed' };

export interface StripStep {
    at: number;
    type: string;
    tool?: string;
    detail?: string;
    readOnly?: boolean;
}

export interface StripEffect {
    tool: string;
    action: string;
    targets: Array<{ path?: string; id?: string }>;
    outcome: string;
    check: 'matches' | 'mismatch' | 'not-checked';
    expectedCheck?: 'exists' | 'absent' | 'none';
}

export type SubTaskResultThread = { kind: 'reusable'; sub_id: string } | { kind: 'single' } | { kind: 'unknown' };
export type SubTaskResultEffectState = 'matches' | 'missing' | 'mismatch' | 'unchecked';
export interface SubTaskResultEffect extends StripEffect { state: SubTaskResultEffectState }
export interface BuildSubTaskResultModelInput {
    outcome?: RunOutcome | null;
    text?: string | null;
    handoff?: string | null;
    partialResult?: string | null;
    partialText?: string | null;
    error?: string | null;
    question?: unknown;
    questionState?: QuestionState;
    effects?: Array<{ tool: string; action: string; targets: Array<{ path?: string; id?: string; kind?: string }>; outcome: string; check: StripEffect['check']; expectedCheck?: StripEffect['expectedCheck'] }> | null;
    thread: SubTaskResultThread;
}
export interface SubTaskResultModel {
    state: StripState;
    end?: RunEnd;
    endLabelKey: string;
    completenessLabelKey?: string;
    material: string;
    error: string;
    effects: SubTaskResultEffect[];
    missingTargets: string[];
    userStopped: boolean;
    openQuestion?: string;
    questionResolution?: 'no-answer' | 'cancelled';
    thread: SubTaskResultThread;
}

export interface StripRun {
    draftSummary?: import('../vault-drafts/index.js').DraftSummary;
    notStarted?: true;
    parentConversation?: SubTask['parentConversation'];
    questionState: QuestionState;
    id: string;
    number: number;
    available: boolean;
    state: StripState;
    status?: SubTask['status'];
    endLabelKey?: string;
    completenessLabelKey?: string;
    taskPreview: string;
    steps: StripStep[];
    outcome: string;
    endReason?: string;
    durationMs: number;
    tokenInput: number;
    tokenOutput: number;
    toolCallCount: number;
    effects: StripEffect[];
    missingTargets: string[];
    /** Stan przejściowy biegu, którego nie ma w outcome: trwa podsumowanie albo zapis dorobku do sesji padł. Tekst dobiera widok. */
    note?: 'synthesis-pending' | 'storage-error';
}

export interface StripRow {
    notStarted?: true;
    parentConversation?: SubTask['parentConversation'];
    parentId?: string;
    level?: number;
    questionState: QuestionState;
    id: string;
    name: string;
    state: StripState;
    threadId?: string;
    reusable: boolean;
    runs: StripRun[];
    runNumber: number;
    runLimit: number | null;
    durationMs: number;
    taskPreview: string;
    outcome: string;
}

/** Counts exactly the rows presented by the strip. */
export function summarizeStripRows(rows: readonly StripRow[]): { running: number; queued: number; total: number; waiting?: number; blocked?: number } {
    return {
        running: rows.filter(row => row.state.kind === 'running' || row.state.kind === 'stopping').length,
        queued: rows.filter(row => row.state.kind === 'queued').length,
        total: rows.length,
        ...(rows.some(row => row.state.kind === 'waiting' || row.state.kind === 'blocked') ? {
            waiting: rows.filter(row => row.state.kind === 'waiting').length,
            blocked: rows.filter(row => row.state.kind === 'blocked').length,
        } : {}),
    };
}

export interface BuildStripModelInput {
    tasks?: SubTask[] | null;
    pending?: SubTask[] | null;
    threads?: SubThread[] | null;
    tabKey?: string | null;
    agentName?: string | null;
    sessionPath?: string | null;
    sessionEpoch?: string | null;
    now?: number;
    getThreadRunLimit?: (threadId: string) => number;
}

const MAX_STEPS = 20;
const MAX_CHARS = 400;
const MAX_TASK = 300;

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '0 s';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec} s`;
    const min = Math.floor(sec / 60);
    return sec % 60 ? `${min} min ${sec % 60} s` : `${min} min`;
}

function belongsToTab(task: SubTask, tabKey: string, agentName: string, sessionPath: string): boolean {
    if (!agentName || (task.origin?.agentName || task.agentName) !== agentName) return false;
    const taskSession = task.origin?.sessionPath || '';
    if (taskSession) {
        if (sessionPath && taskSession === sessionPath) return true;
        return task.status === 'running';
    }
    if (task.origin?.tabKey && tabKey) return task.origin.tabKey === tabKey;
    return true;
}

function stepView(step: SubTaskStep): StripStep {
    const fields = step.fields || {};
    const out: StripStep = { at: step.at, type: step.type };
    if (typeof fields.tool === 'string') out.tool = fields.tool;
    if (step.type === 'tool.pre' && typeof fields.detail === 'string') out.detail = fields.detail.slice(0, 80);
    if (step.type === 'tool.post') {
        if (fields.status === 'error') out.detail = 'error';
        else if (typeof fields.chars === 'number') out.detail = `${fields.chars} zn.`;
    }
    if (step.type === 'user.message') {
        out.readOnly = true;
        if (typeof fields.preview === 'string') out.detail = fields.preview.slice(0, 200);
    }
    return out;
}

/**
 * Ordered i18n keys for a strip state. The reason comes first and completeness second,
 * so result frames and the strip use the same source of wording.
 */
export function getStripStateLabelParts(state: StripState): { end: string; completeness?: string; params?: Record<string, string> } {
    switch (state.kind) {
        case 'waiting': return { end: 'chat.substrip.plan_waiting', params: { ids: state.dependencies.map(d => d.nodeId).join(', ') } };
        case 'blocked': return { end: 'chat.substrip.plan_blocked', params: { ids: state.causes.map(d => d.nodeId).join(', ') } };
        case 'queued': return { end: 'chat.substrip.state_queued' };
        case 'running': return { end: 'chat.substrip.state_running' };
        case 'stopping': return { end: 'chat.substrip.state_stopping' };
        case 'idle': return { end: 'chat.substrip.state_idle' };
        case 'done': return { end: 'chat.substrip.state_done', completeness: 'chat.substrip.completeness_unconfirmed' };
        case 'partial': return state.reason === 'incomplete'
            ? { end: 'chat.substrip.state_partial_incomplete' }
            : {
                end: `chat.substrip.state_partial_${state.reason === 'user-stop' ? 'user' : state.reason === 'lead-stop' ? 'lead' : state.reason === 'system-stop' ? 'system' : state.reason}`,
                completeness: 'chat.substrip.completeness_partial',
            };
        case 'empty': return { end: 'chat.substrip.state_empty' };
        case 'delivery': return { end: 'chat.substrip.state_delivery' };
        case 'closed': return { end: 'chat.substrip.state_closed' };
        default: return assertNever(state);
    }
}

function resultState(outcome: RunOutcome | null | undefined): StripState {
    if (!outcome) return { kind: 'empty' };
    if (outcome.completeness === 'empty') return { kind: 'empty' };
    if (outcome.completeness === 'unconfirmed') return { kind: 'done' };
    switch (outcome.end.kind) {
        case 'finished': return { kind: 'partial', reason: 'incomplete' };
        case 'limit': return { kind: 'partial', reason: 'limit' };
        case 'uncertain': return { kind: 'partial', reason: 'uncertain' };
        case 'stopped': return { kind: 'partial', reason: outcome.end.by === 'user' ? 'user-stop' : outcome.end.by === 'lead' ? 'lead-stop' : 'system-stop' };
        case 'timeout': return { kind: 'partial', reason: 'timeout' };
        case 'failed': return { kind: 'partial', reason: 'error' };
        default: return assertNever(outcome.end);
    }
}

function resultEndState(outcome: RunOutcome | null | undefined): StripState {
    if (!outcome) return { kind: 'empty' };
    switch (outcome.end.kind) {
        case 'finished': return outcome.completeness === 'empty' ? { kind: 'empty' }
            : outcome.completeness === 'unconfirmed' ? { kind: 'done' } : { kind: 'partial', reason: 'incomplete' };
        case 'limit': return { kind: 'partial', reason: 'limit' };
        case 'uncertain': return { kind: 'partial', reason: 'uncertain' };
        case 'stopped': return { kind: 'partial', reason: outcome.end.by === 'user' ? 'user-stop' : outcome.end.by === 'lead' ? 'lead-stop' : 'system-stop' };
        case 'timeout': return { kind: 'partial', reason: 'timeout' };
        case 'failed': return { kind: 'partial', reason: 'error' };
        default: return assertNever(outcome.end);
    }
}

/** Pure shared outcome classification and material/effect selection for all result views. */
export function buildSubTaskResultModel(input: BuildSubTaskResultModelInput): SubTaskResultModel {
    if (input.thread.kind === 'reusable' && !input.thread.sub_id.trim()) throw new Error('Reusable sub-agent thread requires a non-empty sub_id');
    const outcome = input.outcome ?? undefined;
    const state = resultState(outcome);
    const effectList = outcome?.effects.map(effect => {
        const recorded = input.effects?.find(candidate => candidate.tool === effect.tool && candidate.action === effect.action
            && candidate.check === effect.check && JSON.stringify(candidate.targets) === JSON.stringify(effect.targets));
        const expectedCheck = recorded?.expectedCheck;
        const targets = effect.targets.map(target => ({ path: target.path, id: target.id }));
        const view: StripEffect = { tool: effect.tool, action: effect.action, targets, outcome: effect.outcome, check: effect.check,
            ...(expectedCheck ? { expectedCheck } : {}) };
        const effectState: SubTaskResultEffectState = effect.check === 'matches' ? 'matches'
            : effect.check === 'not-checked' ? 'unchecked'
                : expectedCheck === 'exists' ? 'missing' : 'mismatch';
        return { ...view, state: effectState };
    }) ?? [];
    const materialCandidates = outcome?.completeness === 'partial'
        ? [input.handoff, input.partialResult, input.partialText, input.text]
        : [input.text, input.handoff, input.partialResult, input.partialText];
    const material = materialCandidates
        .find(value => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
    const missingTargets = effectList.flatMap(effect => effect.check === 'mismatch' && effect.expectedCheck === 'exists'
        ? effect.targets.map(target => target.path || target.id || '').filter(Boolean) : []);
    const stateQuestion = input.questionState?.kind === 'closed'
        ? { text: input.questionState.question.text, resolution: input.questionState.resolution } : undefined;
    const rawQuestion = stateQuestion ?? input.question;
    const question = rawQuestion && typeof rawQuestion === 'object' ? rawQuestion as { text?: unknown; resolution?: { kind?: unknown } } : undefined;
    const questionResolution = question?.resolution?.kind === 'no-answer' || question?.resolution?.kind === 'cancelled' ? question.resolution.kind : undefined;
    const endLabelKey = questionResolution === 'no-answer' ? 'chat.substrip.question_no_answer_partial' : getStripStateLabelParts(resultEndState(outcome)).end;
    return {
        state,
        ...(outcome ? { end: outcome.end } : {}),
        endLabelKey,
        ...(outcome?.completeness ? { completenessLabelKey: outcome.completeness === 'empty'
            ? 'chat.subagent_notification.completeness_empty'
            : `chat.subresult.completeness.${outcome.completeness}` } : {}),
        material,
        error: input.error?.trim() ?? '',
        effects: effectList,
        missingTargets,
        userStopped: outcome?.end.kind === 'stopped' && outcome.end.by === 'user',
        ...(questionResolution ? { questionResolution } : {}),
        ...(questionResolution === 'no-answer' && typeof question?.text === 'string' ? { openQuestion: question.text } : {}),
        thread: input.thread,
    };
}

function runView(task: SubTask | undefined, id: string, number: number, now: number, effects: SubThreadEffect[] = []): StripRun {
    if (!task) return { id, number, available: false, state: { kind: 'empty' }, questionState: { kind: 'none' }, taskPreview: '', steps: [], outcome: '', durationMs: 0, tokenInput: 0, tokenOutput: 0, toolCallCount: 0, effects: [], missingTargets: [] };
    const steps = (task.steps || []).slice(-MAX_STEPS).map(stepView);
    const result = task.result;
    const usage = result?.usage as { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | null | undefined;
    const partialUsage = task.partial?.usage as { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined;
    const modelSteps = (task.steps || []).filter(step => step.type === 'model.done');
    const stepTokens = (field: 'in' | 'out') => modelSteps.reduce((total, step) => {
        const value = step.fields?.[field];
        return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    }, 0);
    const tokenInput = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? partialUsage?.prompt_tokens ?? partialUsage?.input_tokens ?? stepTokens('in')) || 0;
    const tokenOutput = Number(usage?.completion_tokens ?? usage?.output_tokens ?? partialUsage?.completion_tokens ?? partialUsage?.output_tokens ?? stepTokens('out')) || 0;
    const shared = buildSubTaskResultModel({ outcome: task.outcome, text: result?.text, handoff: result?.handoff,
        partialText: task.partial?.text, error: task.error, effects, thread: { kind: 'unknown' } });
    // Keep the strip's historic selection rules independent from the shared result
    // model: the latter is also consumed by chat and may expose more result material.
    const partialOutcome = task.outcome?.completeness === 'partial';
    const stripMaterial = partialOutcome
        ? result?.handoff?.trim() || task.partial?.text?.trim() || (task.status === 'error' ? '' : result?.text?.trim()) || ''
        : result?.text || result?.handoff || task.partial?.text || '';
    const rawOutcome = partialOutcome
        ? stripMaterial || task.error || ''
        : task.status === 'error' && task.error ? task.error : stripMaterial;
    const outcome = rawOutcome.length > MAX_CHARS ? `${rawOutcome.slice(0, MAX_CHARS)}…` : rawOutcome;
    const endReason = partialOutcome && stripMaterial && task.error ? task.error : undefined;
    return {
        ...(task.plan && task.startedAt === undefined ? { notStarted: true as const } : {}),
        ...(task.draftSummary ? { draftSummary: task.draftSummary } : {}),
        id, number, available: true, ...(task.parentConversation ? { parentConversation: task.parentConversation } : {}), state: runState(task, shared.state), status: task.status, questionState: task.questionState ?? { kind: 'none' },
        ...(task.outcome && task.plan?.state.kind !== 'blocked' ? { endLabelKey: shared.endLabelKey, completenessLabelKey: shared.completenessLabelKey } : {}),
        taskPreview: (task.taskPreview || '').slice(0, MAX_TASK), steps, outcome,
        ...(endReason ? { endReason } : {}),
        durationMs: task.plan && task.startedAt === undefined ? 0 : Math.max(0, (task.endedAt ?? now) - (task.startedAt ?? task.createdAt)),
        tokenInput, tokenOutput,
        toolCallCount: (task.steps || []).filter(step => step.type === 'tool.post').length,
        effects: shared.effects, missingTargets: shared.missingTargets,
        ...(task.partialStorageError ? { note: 'storage-error' as const }
            : task.status === 'running' && task.partial?.synthesis === 'pending' ? { note: 'synthesis-pending' as const } : {}),
    };
}

function runState(task: SubTask | undefined, classified = resultState(task?.outcome)): StripState {
    if (!task) return { kind: 'empty' };
    if (task.plan?.state.kind === 'waiting') return { kind: 'waiting', dependencies: task.plan.state.pending };
    if (task.plan?.state.kind === 'blocked') return { kind: 'blocked', causes: task.plan.state.causes };
    if (task.plan?.state.kind === 'queued') return { kind: 'queued', position: 1 };
    if (task.plan && task.interruptedByRestart) return resultEndState(task.outcome);
    if (task.status === 'running') return task.stopRequested ? { kind: 'stopping' } : { kind: 'running' };
    if (!task.outcome) return task.status === 'error' ? { kind: 'partial', reason: 'error' } : { kind: 'empty' };
    return classified;
}

function assertNever(value: never): never { throw new Error(`Nieobsługiwany stan: ${String(value)}`); }

export function buildStripModel({ tasks, pending, threads, tabKey = '', agentName = '', sessionPath = '', sessionEpoch = '', now = Date.now(), getThreadRunLimit }: BuildStripModelInput = {}): StripRow[] {
    const activeTab = typeof tabKey === 'string' ? tabKey : '';
    const activeAgent = typeof agentName === 'string' ? agentName : '';
    const activeSession = typeof sessionPath === 'string' ? sessionPath : '';
    const activeEpoch = typeof sessionEpoch === 'string' ? sessionEpoch : '';
    const allTasks = Array.isArray(tasks) ? tasks : [];
    const pendingTasks = Array.isArray(pending) ? pending : [];
    const taskById = new Map([...pendingTasks, ...allTasks].map(task => [task.id, task]));
    const pendingIds = new Set(pendingTasks.map(task => task.id));
    const visibleThreads = (Array.isArray(threads) ? threads : []).filter(thread =>
        thread.owner.agentName === activeAgent && (thread.owner.sessionPath || '') === activeSession && (thread.owner.sessionEpoch || '') === activeEpoch);
    const queued = visibleThreads.filter(thread => thread.phase === 'queued' && taskById.get(thread.queuedRunId ?? '')?.plan?.state.kind !== 'waiting');
    const queuePosition = new Map(queued.map((thread, index) => [thread.threadId, index + 1]));
    const threadRunIds = new Set<string>();
    const rows: StripRow[] = visibleThreads.map(thread => {
        const runs = thread.runIds.map((id, index) => {
            threadRunIds.add(id);
            return runView(taskById.get(id), id, index + 1, now, thread.effects);
        });
        const activeRun = [...thread.runIds].reverse().map(id => taskById.get(id)).find(task => task?.status === 'running');
        const lastRun = thread.runIds.length ? taskById.get(thread.runIds[thread.runIds.length - 1]) : undefined;
        let state: StripState;
        if (lastRun?.plan?.state.kind === 'blocked' || lastRun?.plan?.state.kind === 'waiting') state = runState(lastRun);
        else if (lastRun?.plan && lastRun.interruptedByRestart) state = runState(lastRun);
        else if (thread.phase === 'queued') state = { kind: 'queued', position: queuePosition.get(thread.threadId) || 1 };
        else if (pendingIds.has(lastRun?.id || '')) state = { kind: 'delivery' };
        else if (thread.phase === 'closed') state = { kind: 'closed' };
        else if (thread.phase === 'running') state = runState(activeRun ?? (lastRun?.plan ? lastRun : undefined));
        else if (thread.phase === 'idle' && thread.reusable) {
            const lastState = runState(lastRun);
            state = lastState.kind === 'partial' || lastState.kind === 'empty' ? lastState : { kind: 'idle' };
        }
        else state = runState(lastRun);
        const runNumber = thread.runIds.length;
        const maxRuns = getThreadRunLimit?.(thread.threadId);
        const relation = thread.phase === 'queued' ? thread : activeRun ?? lastRun ?? thread;
        return {
            ...(runs[runs.length - 1]?.notStarted ? { notStarted: true as const } : {}),
            id: thread.threadId, threadId: thread.threadId, name: lastRun?.plan ? `${lastRun.plan.nodeId} · ${thread.name}` : thread.name, state, reusable: thread.reusable, questionState: (activeRun ?? lastRun)?.questionState ?? { kind: 'none' },
            ...(relation.parentId !== undefined ? { parentId: relation.parentId } : {}),
            ...(relation.level !== undefined ? { level: relation.level } : {}),
            ...((thread.phase === 'queued' ? thread.parentConversation : (activeRun ?? lastRun)?.parentConversation)
                ? { parentConversation: thread.phase === 'queued' ? thread.parentConversation : (activeRun ?? lastRun)?.parentConversation } : {}),
            runs, runNumber, runLimit: Number.isFinite(maxRuns) && Number(maxRuns) > 0 ? Number(maxRuns) : null,
            durationMs: runs[runs.length - 1]?.durationMs || 0,
            taskPreview: runs[runs.length - 1]?.taskPreview || '',
            outcome: runs[runs.length - 1]?.outcome || '',
        };
    });

    const standalone = allTasks.filter(task => !threadRunIds.has(task.id)
        && (!task.threadId || task.status === 'running')
        && (!task.plan || (task.origin?.sessionPath === activeSession && task.origin?.sessionEpoch === activeEpoch))
        && belongsToTab(task, activeTab, activeAgent, activeSession));
    const seenDelivery = new Set<string>();
    const deliveryTasks = pendingTasks.filter(task => {
        if ((task.plan && (task.origin?.sessionPath !== activeSession || task.origin?.sessionEpoch !== activeEpoch))
            || task.threadId || threadRunIds.has(task.id) || !belongsToTab(task, activeTab, activeAgent, activeSession) || seenDelivery.has(task.id)) return false;
        seenDelivery.add(task.id);
        return true;
    });
    const delivered = new Set(deliveryTasks.map(task => task.id));
    const runningStandalone = standalone.filter(task => task.status === 'running').sort((a, b) => a.createdAt - b.createdAt);
    const waitingStandalone = deliveryTasks;
    const waitingSet = new Set(waitingStandalone.map(task => task.id));
    let legacyFinished = 0;
    const finishedStandalone = standalone.filter(task => task.status !== 'running' && !waitingSet.has(task.id))
        .sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt)).filter(task => task.plan || legacyFinished++ < 10);
    const orderedStandalone = [...runningStandalone, ...waitingStandalone, ...finishedStandalone];
    for (const task of orderedStandalone) {
        const run = runView(task, task.id, 1, now);
        const state = task.plan?.state.kind === 'blocked' ? runState(task) : delivered.has(task.id) ? { kind: 'delivery' as const } : runState(task);
        rows.push({ ...(run.notStarted ? { notStarted: true as const } : {}), ...(task.parentConversation ? { parentConversation: task.parentConversation } : {}), id: task.id, name: task.plan ? `${task.plan.nodeId} · ${task.name}` : task.name || task.id, ...(task.parentId !== undefined ? { parentId: task.parentId } : {}), ...(task.level !== undefined ? { level: task.level } : {}), state, questionState: run.questionState, reusable: false, runs: [run], runNumber: 1, runLimit: null,
            durationMs: run.durationMs, taskPreview: run.taskPreview, outcome: run.outcome });
    }
    return rows;
}

/** Presentation data only: no DOM, CSS, locale or view-local state. */
export interface StripTreeLabel { key: string; params?: Record<string, string | number> }
export interface StripTreeNode {
    row: StripRow;
    depth: number;
    children: StripTreeNode[];
    collapsed: boolean;
    descendantCount: number;
    hiddenCount: number;
    stopDescendantCount: number;
    canStop: boolean;
    stopRunIds: string[];
    label: StripTreeLabel;
    time: string;
}
export interface StripTreeModel {
    hierarchical: boolean;
    roots: StripTreeNode[];
    visible: StripTreeNode[];
    counts: ReturnType<typeof summarizeStripRows>;
    summary: StripTreeLabel;
}

/** parentId addresses a RUN, whereas the strip groups runs into thread rows. */
export function buildStripTreeModel(rows: readonly StripRow[], collapsed: ReadonlySet<string> = new Set()): StripTreeModel {
    const byRun = new Map(rows.flatMap(row => row.runs.map(run => [run.id, row] as const)));
    const parents = new Map<StripRow, StripRow>();
    for (const row of rows) {
        const parent = row.parentId ? byRun.get(row.parentId) : undefined;
        if (!parent || parent === row) continue;
        // Retained history can be incomplete. Break cycles without dropping rows.
        let ancestor: StripRow | undefined = parent;
        while (ancestor && ancestor !== row) ancestor = parents.get(ancestor);
        if (ancestor !== row) parents.set(row, parent);
    }
    const children = new Map<StripRow, StripRow[]>();
    for (const row of rows) {
        const parent = parents.get(row);
        if (parent) children.set(parent, [...(children.get(parent) ?? []), row]);
    }
    const askingParents = new Set(rows.flatMap(row => {
        const q = row.questionState;
        return row.state.kind === 'running' && q.kind === 'waiting' && q.question.recipient.kind === 'sub'
            ? [q.question.recipient.runId] : [];
    }));
    const live = (row: StripRow): boolean => ['running', 'stopping', 'queued', 'waiting'].includes(row.state.kind);
    const label = (row: StripRow): StripTreeLabel => {
        if (row.state.kind === 'running' && row.questionState.kind === 'waiting') {
            const recipient = row.questionState.question.recipient;
            return recipient.kind === 'lead' ? { key: 'chat.substrip.tree_asks_lead' }
                : { key: 'chat.substrip.tree_asks_parent', params: { name: byRun.get(recipient.runId)?.name ?? recipient.runId } };
        }
        if (row.state.kind === 'running' && row.runs.some(run => run.status === 'running' && askingParents.has(run.id))) {
            return { key: 'chat.substrip.tree_answering' };
        }
        if (row.state.kind === 'queued') return { key: 'chat.substrip.tree_queued' };
        const last = row.runs[row.runs.length - 1];
        if (!live(row) && (last?.status === 'aborted' || ['chat.substrip.state_partial_user', 'chat.substrip.state_partial_lead', 'chat.substrip.state_partial_system'].includes(last?.endLabelKey ?? ''))) {
            return { key: 'chat.substrip.tree_stopped' };
        }
        if (row.state.kind === 'done' || row.state.kind === 'idle' || (row.state.kind === 'closed' && last?.state.kind === 'done')) {
            return { key: 'chat.substrip.tree_done' };
        }
        if (!live(row) && row.questionState.kind === 'closed' && row.questionState.resolution.kind === 'no-answer') {
            return { key: 'chat.substrip.question_no_answer_partial' };
        }
        const parts = getStripStateLabelParts(row.state);
        return { key: parts.end, ...(parts.params ? { params: parts.params } : {}) };
    };
    const build = (row: StripRow, depth: number): StripTreeNode => {
        const nodes = (children.get(row) ?? []).map(child => build(child, depth + 1));
        const descendantCount = nodes.reduce((sum, node) => sum + 1 + node.descendantCount, 0);
        const stopDescendantCount = nodes.reduce((sum, node) => sum + Number(live(node.row)) + node.stopDescendantCount, 0);
        const seconds = Math.floor(Math.max(0, row.durationMs) / 1000);
        return { row, depth, children: nodes, collapsed: nodes.length > 0 && collapsed.has(row.id), descendantCount,
            hiddenCount: collapsed.has(row.id) ? descendantCount : 0, stopDescendantCount,
            canStop: live(row) || stopDescendantCount > 0,
            stopRunIds: row.runs.map(run => run.id), label: label(row),
            time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` };
    };
    const roots = rows.filter(row => !parents.has(row)).map(row => build(row, 0));
    const visible: StripTreeNode[] = [];
    const visit = (node: StripTreeNode): void => {
        visible.push(node);
        if (!node.collapsed) node.children.forEach(visit);
    };
    roots.forEach(visit);
    const counts = summarizeStripRows(rows);
    return { hierarchical: parents.size > 0, roots, visible, counts,
        summary: { key: 'chat.substrip.tree_summary', params: { running: counts.running, queued: counts.queued, total: counts.total } } };
}
