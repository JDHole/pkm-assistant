/** Plan snapshots contain graph facts only; execution material stays in run records. */
import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';
import { maskSensitiveData } from '../../core/index.js';
import type { Owner } from './ParentQuestions.js';
import { SubTaskPlan } from './SubTaskPlan.js';
import type { PlanNode, PlanNodeDefinition, PlanNodeState, PlanExecution, PlanStatus } from './SubTaskPlan.js';
import { SubTaskPlanRuntime } from './SubTaskPlanRuntime.js';
import type { SubTask } from './SubTaskRegistry.js';
import { parseSubTaskHistoryRecord } from './SubTaskHistory.js';

type StoredState = Exclude<PlanNodeState, { kind: 'done' }> | { kind: 'done'; execution: PlanExecution };
export interface SubTaskPlanHistoryRecord {
    version: 2; kind: 'plan'; planId: string; owner: Owner; parentRunId?: string;
    revision: number; status: PlanStatus;
    nodes: readonly (PlanNodeDefinition & { state: StoredState })[];
}
const id: Schema = { type: 'string', minLength: 1 };
const nodeId: Schema = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' };
const ids: Schema = { type: 'array', items: nodeId, minItems: 1, uniqueItems: true };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
    ({ type: 'object', properties, required, additionalProperties: false });
const execution = object({ runId: id, threadId: id });
const state = (kind: string, fields: Record<string, Schema> = {}, required: string[] = []): Schema =>
    object({ kind: { const: kind }, ...fields }, ['kind', ...required]);
const validator = new Validator(object({
    version: { const: 2 }, kind: { const: 'plan' }, planId: id,
    owner: object({ agentName: id, sessionPath: id, sessionEpoch: { type: 'string', pattern: '^[0-9a-f]{32}$' } }),
    parentRunId: id, revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    status: { enum: ['active', 'completed', 'partial', 'stopped', 'interrupted'] },
    nodes: { type: 'array', minItems: 1, items: object({ id: nodeId,
        depends_on: { type: 'array', items: nodeId, uniqueItems: true }, dependency_results: { enum: ['summary', 'full'] },
        state: { oneOf: [state('waiting_dependencies'), ...['queued', 'running', 'done'].map(kind => state(kind, { execution }, ['execution'])),
            state('error', { execution, error: { type: 'string' }, material: { type: 'string' } }, ['error']),
            state('blocked', { blocked_by: ids, root_causes: ids }, ['blocked_by', 'root_causes']),
            state('stopped', { execution, by: { enum: ['user', 'lead', 'system'] } }, ['by']),
            state('not_executed', { execution }), state('interrupted', { execution })] },
    }) },
}, ['version', 'kind', 'planId', 'owner', 'revision', 'status', 'nodes']));
const terminal = (state: StoredState) => !['waiting_dependencies', 'queued', 'running'].includes(state.kind);
const ownerKey = (owner: Owner) => JSON.stringify([owner.agentName, owner.sessionPath, owner.sessionEpoch]);
const definition = (r: SubTaskPlanHistoryRecord) => JSON.stringify([r.parentRunId,
    r.nodes.map(n => [n.id, n.depends_on, n.dependency_results])]);

export function parseSubTaskPlanHistoryRecord(value: unknown): SubTaskPlanHistoryRecord | undefined {
    if (!validator.validate(value).valid) return undefined;
    const record = value as SubTaskPlanHistoryRecord; // Entire persisted shape checked above.
    if (SubTaskPlan.create(record.nodes, record.nodes.length).kind !== 'valid') return undefined;
    const runs = new Set<string>();
    for (const node of record.nodes) {
        const s = node.state;
        if ('execution' in s && s.execution) {
            if (runs.has(s.execution.runId) || s.execution.runId === record.parentRunId) return undefined;
            runs.add(s.execution.runId);
        }
        if (s.kind === 'blocked' && (s.blocked_by.some(id => !node.depends_on.includes(id))
            || s.root_causes.some(id => !record.nodes.some(n => n.id === id && n.state.kind !== 'done' && terminal(n.state))))) return undefined;
        if (['queued', 'running', 'done'].includes(s.kind)
            && node.depends_on.some(id => record.nodes.find(n => n.id === id)!.state.kind !== 'done')) return undefined;
    }
    const allTerminal = record.nodes.every(n => terminal(n.state));
    const allDone = record.nodes.every(n => n.state.kind === 'done');
    if ((record.status === 'active') === allTerminal || (record.status === 'completed') !== allDone) return undefined;
    return structuredClone(record);
}

export function snapshotPlan(plan: SubTaskPlanRuntime): SubTaskPlanHistoryRecord {
    const value = { version: 2, kind: 'plan', planId: plan.planId,
        owner: { agentName: plan.owner.agentName, sessionPath: plan.owner.sessionPath, sessionEpoch: plan.owner.sessionEpoch },
        parentRunId: plan.parentRunId, revision: plan.revision, status: plan.status,
        nodes: plan.nodes.map(node => ({ ...node, state: Object.fromEntries(Object.entries(node.state)
            .filter(([key]) => !['material', 'outcome', 'question', 'truncated'].includes(key)
                || (key === 'material' && node.state.kind === 'error' && !node.state.execution))
            .map(([key, value]) => [key, typeof value === 'string' && ['error', 'material'].includes(key) ? maskSensitiveData(value) : value])) })),
    };
    const record = parseSubTaskPlanHistoryRecord(JSON.parse(JSON.stringify(value)));
    if (!record) throw new Error('plan_persistence_failed');
    return record;
}

/** Validate references against this import's closed runs, never against live registry work. */
export function restoreSubTaskPlans(input: readonly unknown[], owner: Owner, tasks: readonly SubTask[], occupied: ReadonlySet<string>): SubTaskPlanRuntime[] {
    const records = new Map<string, SubTaskPlanHistoryRecord>();
    const invalid = new Set<string>();
    const snapshots = input.map(parseSubTaskPlanHistoryRecord).filter((r): r is SubTaskPlanHistoryRecord => !!r && ownerKey(r.owner) === ownerKey(owner))
        .sort((a, b) => a.revision - b.revision);
    for (const record of snapshots) {
        const old = records.get(record.planId);
        if (old && (definition(old) !== definition(record) || old.nodes.some((node, i) => {
            const next = record.nodes[i]?.state;
            return !next || (terminal(node.state) && JSON.stringify(node.state) !== JSON.stringify(next))
                || ('execution' in node.state && node.state.execution && (!('execution' in next)
                    || JSON.stringify(node.state.execution) !== JSON.stringify(next.execution)));
        }) || (old.revision === record.revision && JSON.stringify(old) !== JSON.stringify(record)))) invalid.add(record.planId);
        records.set(record.planId, record);
    }
    const unavailable = new Set(occupied);
    const startedRuns = new Set<string>();
    for (const value of input) {
        const run = parseSubTaskHistoryRecord(value);
        if (run?.version === 1 && !tasks.some(task => task.id === run.runId)) unavailable.add(run.runId);
        // task:created is durable before the corresponding plan:changed snapshot.
        if (run?.version === 1 && ownerKey(run.owner) === ownerKey(owner) && run.state === 'running') startedRuns.add(run.runId);
    }
    const restored: SubTaskPlanRuntime[] = [];
    for (const record of records.values()) {
        if (invalid.has(record.planId)) continue;
        const parent = tasks.find(task => task.id === record.parentRunId);
        if (record.parentRunId && !parent) continue;
        let mismatch = false, missing = false;
        const nodes: PlanNode[] = record.nodes.map(node => {
            const s = node.state;
            if (s.kind === 'waiting_dependencies' || s.kind === 'blocked') return { ...node, state: s };
            if (!s.execution) return { ...node, state: s as Exclude<typeof s, { kind: 'done' }> }; // Schema requires execution for done.
            if (unavailable.has(s.execution.runId) || occupied.has(s.execution.threadId)) mismatch = true;
            const task = tasks.find(task => task.id === s.execution!.runId);
            if (task && (task.threadId !== s.execution.threadId || task.parentId !== record.parentRunId
                || task.level !== (parent?.level ?? 0) + 1 || !task.origin || ownerKey({ agentName: task.origin.agentName, sessionPath: task.origin.sessionPath ?? '', sessionEpoch: task.origin.sessionEpoch ?? '' }) !== ownerKey(owner)
                || task.plan?.planId !== record.planId || task.plan.nodeId !== node.id)) mismatch = true;
            if (s.kind === 'done' && (!task?.result || task.status !== 'done' || task.interruptedByRestart)) {
                missing = true;
                return { ...node, state: { kind: 'error', execution: s.execution, error: 'plan_material_unavailable' } };
            }
            const material = task?.result ? { material: task.result.text } : {};
            if (s.kind === 'done') return { ...node, state: { ...s, material: task!.result!.text, ...(task?.outcome ? { outcome: task.outcome } : {}) } };
            const reconciled = s.kind === 'queued' && task && startedRuns.has(task.id) ? { ...s, kind: 'running' as const } : s;
            return { ...node, state: { ...reconciled,
                ...material, ...(task?.outcome ? { outcome: task.outcome } : {}) } };
        });
        if (mismatch) continue;
        const graph = SubTaskPlan.restore(nodes, missing && record.status === 'completed' ? 'partial' : record.status, record.revision);
        restored.push(new SubTaskPlanRuntime(graph, owner, record.parentRunId, () => {}, () => {}, record.planId));
    }
    return restored;
}
