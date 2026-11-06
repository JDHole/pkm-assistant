/** Czysty model paska czatu. Wiersz wątku niesie uporządkowaną oś biegów, a bieg bez wątku ma własny wiersz. */
import type { SubTask, SubTaskStep, SubThread, SubThreadEffect } from './SubTaskRegistry.js';
import type { PlanNode, PlanNodeState, PlanStatus } from './SubTaskPlan.js';
import type { SubTaskPlanRuntime } from './SubTaskPlanRuntime.js';
import type { RunEnd, RunOutcome } from './runOutcome.js';
import type { QuestionState } from './ParentQuestions.js';

export type StripState =
    | { kind: 'plan'; status: PlanStatus }
    | { kind: 'dependency'; status: PlanNodeState['kind'] }
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

interface StripRowBase {
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

export type StripRow = StripRowBase & (
    | { kind: 'thread' }
    | { kind: 'plan'; planId: string }
    | { kind: 'plan-node'; planId: string; node: PlanNode; presentationParentId: string; label: StripTreeLabel }
);

/** Counts exactly the rows presented by the strip. */
export function summarizeStripRows(rows: readonly StripRow[]): { running: number; queued: number; waitingDependencies: number; total: number } {
    return {
        running: rows.filter(row => row.state.kind === 'running' || row.state.kind === 'stopping').length,
        queued: rows.filter(row => row.state.kind === 'queued').length,
        waitingDependencies: rows.filter(row => row.kind === 'plan-node' && row.node.state.kind === 'waiting_dependencies').length,
        total: rows.filter(row => row.kind !== 'plan').length,
    };
}

export interface BuildStripModelInput {
    plans?: readonly StripPlan[] | null;
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
export function getStripStateLabelParts(state: StripState): { end: string; completeness?: string } {
    switch (state.kind) {
        case 'plan': return { end: `chat.plan.status.${state.status}` };
        case 'dependency': return { end: `chat.plan.node.${state.status}` };
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
        id, number, available: true, ...(task.parentConversation ? { parentConversation: task.parentConversation } : {}), state: runState(task, shared.state), status: task.status, questionState: task.questionState ?? { kind: 'none' },
        ...(task.outcome ? { endLabelKey: shared.endLabelKey, completenessLabelKey: shared.completenessLabelKey } : {}),
        taskPreview: (task.taskPreview || '').slice(0, MAX_TASK), steps, outcome,
        ...(endReason ? { endReason } : {}),
        durationMs: Math.max(0, (task.endedAt ?? now) - task.createdAt),
        tokenInput, tokenOutput,
        toolCallCount: (task.steps || []).filter(step => step.type === 'tool.post').length,
        effects: shared.effects, missingTargets: shared.missingTargets,
        ...(task.partialStorageError ? { note: 'storage-error' as const }
            : task.status === 'running' && task.partial?.synthesis === 'pending' ? { note: 'synthesis-pending' as const } : {}),
    };
}

function runState(task: SubTask | undefined, classified = resultState(task?.outcome)): StripState {
    if (!task) return { kind: 'empty' };
    if (task.status === 'running') return task.stopRequested ? { kind: 'stopping' } : { kind: 'running' };
    if (!task.outcome) return task.status === 'error' ? { kind: 'partial', reason: 'error' } : { kind: 'empty' };
    return classified;
}

function assertNever(value: never): never { throw new Error(`Nieobsługiwany stan: ${String(value)}`); }

export function buildStripModel({ plans, tasks, pending, threads, tabKey = '', agentName = '', sessionPath = '', sessionEpoch = '', now = Date.now(), getThreadRunLimit }: BuildStripModelInput = {}): StripRow[] {
    const activeTab = typeof tabKey === 'string' ? tabKey : '';
    const activeAgent = typeof agentName === 'string' ? agentName : '';
    const activeSession = typeof sessionPath === 'string' ? sessionPath : '';
    const activeEpoch = typeof sessionEpoch === 'string' ? sessionEpoch : '';
    const allTasks = Array.isArray(tasks) ? tasks : [];
    const pendingTasks = Array.isArray(pending) ? pending : [];
    const taskById = new Map([...pendingTasks, ...allTasks].map(task => [task.id, task]));
    const pendingIds = new Set(pendingTasks.map(task => task.id));
    const visiblePlans = (plans ?? []).filter(plan => plan.owner.agentName === activeAgent
        && plan.owner.sessionPath === activeSession && plan.owner.sessionEpoch === activeEpoch);
    const planRunIds = new Set(visiblePlans.flatMap(plan => plan.nodes.flatMap(node =>
        'execution' in node.state && node.state.execution ? [node.state.execution.runId] : [])));
    const planThreadIds = new Set(visiblePlans.flatMap(plan => plan.nodes.flatMap(node =>
        'execution' in node.state && node.state.execution ? [node.state.execution.threadId] : [])));
    const representedExecution = (thread: SubThread) => thread.phase === 'queued'
        ? planRunIds.has(thread.queuedRunId ?? thread.threadId) : planThreadIds.has(thread.threadId);
    const visibleThreads = (Array.isArray(threads) ? threads : []).filter(thread =>
        !thread.runIds.length || thread.runIds.some(id => !planRunIds.has(id))
        || (!representedExecution(thread) && ['queued', 'running'].includes(thread.phase))
    ).map(thread => ({ ...thread,
        runIds: thread.runIds.filter(id => !planRunIds.has(id)),
    })).filter(thread => (!representedExecution(thread) || thread.runIds.length > 0) &&
        thread.owner.agentName === activeAgent && (thread.owner.sessionPath || '') === activeSession && (thread.owner.sessionEpoch || '') === activeEpoch);
    const queued = visibleThreads.filter(thread => thread.phase === 'queued');
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
        if (thread.phase === 'queued') state = { kind: 'queued', position: queuePosition.get(thread.threadId) || 1 };
        else if (pendingIds.has(lastRun?.id || '')) state = { kind: 'delivery' };
        else if (thread.phase === 'closed') state = { kind: 'closed' };
        else if (thread.phase === 'running') state = runState(activeRun);
        else if (thread.phase === 'idle' && thread.reusable) {
            const lastState = runState(lastRun);
            state = lastState.kind === 'partial' || lastState.kind === 'empty' ? lastState : { kind: 'idle' };
        }
        else state = runState(lastRun);
        const runNumber = thread.runIds.length;
        const maxRuns = getThreadRunLimit?.(thread.threadId);
        const relation = thread.phase === 'queued' ? thread : activeRun ?? lastRun ?? thread;
        return {
            kind: 'thread', id: thread.threadId, threadId: thread.threadId, name: thread.name, state, reusable: thread.reusable, questionState: (activeRun ?? lastRun)?.questionState ?? { kind: 'none' },
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

    const belongsToView = (task: SubTask): boolean => {
        const seen = new Set<string>();
        let ancestor: SubTask | undefined = task;
        while (ancestor && !seen.has(ancestor.id)) {
            if (ancestor.plan || planRunIds.has(ancestor.id)) return task.origin?.agentName === activeAgent
                && task.origin.sessionPath === activeSession && task.origin.sessionEpoch === activeEpoch;
            seen.add(ancestor.id);
            ancestor = ancestor.parentId ? taskById.get(ancestor.parentId) : undefined;
        }
        return belongsToTab(task, activeTab, activeAgent, activeSession);
    };
    const standalone = allTasks.filter(task => !planRunIds.has(task.id) && !threadRunIds.has(task.id)
        && (!task.threadId || task.status === 'running' || task.plan)
        && belongsToView(task));
    const seenDelivery = new Set<string>();
    const deliveryTasks = pendingTasks.filter(task => {
        if (task.plan || planRunIds.has(task.id) || task.threadId || threadRunIds.has(task.id) || !belongsToView(task) || seenDelivery.has(task.id)) return false;
        seenDelivery.add(task.id);
        return true;
    });
    const delivered = new Set(deliveryTasks.map(task => task.id));
    const runningStandalone = standalone.filter(task => task.status === 'running').sort((a, b) => a.createdAt - b.createdAt);
    const waitingStandalone = deliveryTasks;
    const waitingSet = new Set(waitingStandalone.map(task => task.id));
    const finishedStandalone = standalone.filter(task => task.status !== 'running' && !waitingSet.has(task.id))
        .sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt)).slice(0, 10);
    const orderedStandalone = [...runningStandalone, ...waitingStandalone, ...finishedStandalone];
    for (const task of orderedStandalone) {
        const run = runView(task, task.id, 1, now);
        const state = delivered.has(task.id) ? { kind: 'delivery' as const } : runState(task);
        rows.push({ kind: 'thread', ...(task.parentConversation ? { parentConversation: task.parentConversation } : {}), id: task.id, name: task.name || task.id, ...(task.parentId !== undefined ? { parentId: task.parentId } : {}), ...(task.level !== undefined ? { level: task.level } : {}), state, questionState: run.questionState, reusable: false, runs: [run], runNumber: 1, runLimit: null,
            durationMs: run.durationMs, taskPreview: run.taskPreview, outcome: run.outcome });
    }
    for (const plan of visiblePlans) {
        const base = { questionState: { kind: 'none' as const }, reusable: false, runs: [], runNumber: 0,
            runLimit: null, durationMs: 0, taskPreview: '', outcome: '' };
        rows.push({ ...base, kind: 'plan', id: plan.planId, planId: plan.planId, name: '',
            parentId: plan.parentRunId, state: { kind: 'plan', status: plan.status } });
        for (const node of plan.nodes) {
            const execution = 'execution' in node.state ? node.state.execution : undefined;
            const task = execution ? taskById.get(execution.runId) : undefined;
            const run = task ? runView(task, task.id, 1, now) : undefined;
            const state: StripState = node.state.kind === 'running' ? run?.state ?? { kind: 'running' }
                : node.state.kind === 'queued' ? { kind: 'queued', position: 1 }
                    : { kind: 'dependency', status: node.state.kind };
            rows.push({ ...base, kind: 'plan-node', id: `${plan.planId}/${node.id}`, planId: plan.planId,
                presentationParentId: plan.planId, node, label: getPlanNodeLabel(node, plan.nodes), name: node.id, state,
                runs: run ? [run] : [], runNumber: run ? 1 : 0, questionState: run?.questionState ?? base.questionState,
                parentConversation: task?.parentConversation, durationMs: run?.durationMs ?? 0,
                taskPreview: run?.taskPreview ?? '', outcome: ('material' in node.state ? node.state.material : '') ?? '',
            });
        }
    }
    return rows;
}

export type StripPlan = Pick<SubTaskPlanRuntime, 'planId' | 'owner' | 'parentRunId' | 'nodes' | 'status'>;

/** Dependency labels use settled graph state, never a run's preliminary outcome. */
export function getPlanNodeLabel(node: PlanNode, nodes: readonly PlanNode[]): StripTreeLabel {
    const state = node.state;
    if (state.kind === 'blocked') return { key: 'chat.plan.blocked', params: { ids: state.blocked_by.join(', ') } };
    if (state.kind === 'waiting_dependencies') {
        const pending = node.depends_on.filter(id => nodes.find(candidate => candidate.id === id)?.state.kind !== 'done');
        return pending.length ? { key: 'chat.plan.waiting', params: { ids: pending.join(', ') } }
            : { key: 'chat.plan.preparing' };
    }
    return { key: `chat.plan.node.${state.kind}` };
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
    const byId = new Map(rows.map(row => [row.id, row]));
    const parents = new Map<StripRow, StripRow>();
    for (const row of rows) {
        const parent = row.kind === 'plan-node' ? byId.get(row.presentationParentId)
            : row.parentId ? byRun.get(row.parentId) : undefined;
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
    const live = (row: StripRow): boolean => row.kind === 'plan' ? row.state.kind === 'plan' && row.state.status === 'active'
        : ['running', 'stopping', 'queued'].includes(row.state.kind) || (row.kind === 'plan-node' && row.node.state.kind === 'waiting_dependencies');
    const label = (row: StripRow): StripTreeLabel => {
        if (row.state.kind === 'running' && row.questionState.kind === 'waiting') {
            const recipient = row.questionState.question.recipient;
            return recipient.kind === 'lead' ? { key: 'chat.substrip.tree_asks_lead' }
                : { key: 'chat.substrip.tree_asks_parent', params: { name: byRun.get(recipient.runId)?.name ?? recipient.runId } };
        }
        if (row.state.kind === 'running' && row.runs.some(run => run.status === 'running' && askingParents.has(run.id))) {
            return { key: 'chat.substrip.tree_answering' };
        }
        if (row.kind === 'plan-node' && row.state.kind !== 'running' && row.state.kind !== 'stopping') return row.label;
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
        return { key: getStripStateLabelParts(row.state).end };
    };
    const build = (row: StripRow, depth: number): StripTreeNode => {
        const nodes = (children.get(row) ?? []).map(child => build(child, depth + 1));
        const descendantCount = nodes.reduce((sum, node) => sum + 1 + node.descendantCount, 0);
        const stopDescendantCount = nodes.reduce((sum, node) => sum + Number(node.row.kind !== 'plan' && live(node.row)) + node.stopDescendantCount, 0);
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
        summary: { key: rows.some(row => row.kind === 'plan') ? 'chat.plan.summary' : 'chat.substrip.tree_summary', params: counts } };
}
