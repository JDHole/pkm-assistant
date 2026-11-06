/** Pure DAG bookkeeping. Admission, ownership, persistence and delivery belong to the runtime. */
import { Validator } from '@cfworker/json-schema';
import type { TerminalQuestion } from './ParentQuestions.js';
import type { RunOutcome, StopBy } from './runOutcome.js';

export type PlanNodeId = string & { readonly __planNodeId: unique symbol };
export interface PlanNodeDefinition {
    readonly id: PlanNodeId;
    readonly depends_on: readonly PlanNodeId[];
    readonly dependency_results: 'summary' | 'full';
}
export type PlanExecution = Readonly<{ runId: string; threadId: string }>;
type Material = Readonly<{ material?: string; outcome?: RunOutcome; question?: TerminalQuestion; truncated?: boolean }>;
export type PlanNodeTerminal = Material & (
    | { kind: 'done'; material: string }
    | { kind: 'error'; error: string }
    | { kind: 'blocked'; blocked_by: readonly PlanNodeId[]; root_causes: readonly PlanNodeId[] }
    | { kind: 'stopped'; by: StopBy }
    | { kind: 'not_executed' }
    | { kind: 'interrupted' }
);
export type PlanNodeState =
    | { kind: 'waiting_dependencies' }
    | { kind: 'queued' | 'running'; execution: PlanExecution }
    | (PlanNodeTerminal & { execution?: PlanExecution });
export type PlanNode = PlanNodeDefinition & { state: PlanNodeState };
export type PlanStatus = 'active' | 'completed' | 'partial' | 'stopped' | 'interrupted';
export type PlanWarning = { code: 'plan_duplicate_dependency' | 'plan_unused_dependency_results'; node_id: PlanNodeId; dependency?: PlanNodeId };
export type PlanValidation =
    | { kind: 'valid'; plan: SubTaskPlan; warnings: PlanWarning[] }
    | { kind: 'invalid'; code: 'plan_invalid_definition' | 'plan_invalid_node' | 'plan_too_many_nodes'
        | 'plan_duplicate_id' | 'plan_unknown_dependency' | 'plan_cycle'; nodes: readonly string[]; index?: number };
/** Delivery formatting is separate; success cannot describe a partial or interrupted plan. */
export type PlanResult = {
    kind: 'plan_result'; plan_id: string; result: string;
    nodes: readonly (PlanNodeDefinition & { state: PlanNodeTerminal & { execution?: PlanExecution } })[];
    blocked: readonly { id: PlanNodeId; blocked_by: readonly PlanNodeId[] }[];
    counts: Record<PlanNodeTerminal['kind'], number>;
} & ({ success: true; status: 'completed' } | { success: false; status: 'partial' | 'stopped' | 'interrupted'; error: string });

const nodeSchema = new Validator({
    type: 'object', required: ['id'],
    properties: {
        id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
        depends_on: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' } },
        dependency_results: { enum: ['summary', 'full'] },
    },
});
const isTerminal = (state: PlanNodeState): state is PlanNodeTerminal & { execution?: PlanExecution } =>
    state.kind !== 'waiting_dependencies' && state.kind !== 'queued' && state.kind !== 'running';

export class SubTaskPlan {
    private revisionValue = 0;
    private statusValue: PlanStatus = 'active';
    private constructor(private readonly entries: PlanNode[], private readonly topological: PlanNode[]) {}

    /** maxNodes comes from the existing delegation limit, never a second plan setting. */
    static create(input: unknown, maxNodes: number): PlanValidation {
        if (!Array.isArray(input) || input.length === 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 1)
            return { kind: 'invalid', code: 'plan_invalid_definition', nodes: [] };
        if (input.length > maxNodes) return { kind: 'invalid', code: 'plan_too_many_nodes', nodes: [] };
        const entries: PlanNode[] = [];
        const warnings: PlanWarning[] = [];
        const byId = new Map<string, PlanNode>();
        for (const [index, value] of input.entries()) {
            if (!nodeSchema.validate(value).valid) return { kind: 'invalid', code: 'plan_invalid_node', nodes: [], index };
            // The schema validates and brands only graph fields; execution payload stays with the caller.
            const node = value as { id: PlanNodeId; depends_on?: PlanNodeId[]; dependency_results?: 'summary' | 'full' };
            if (byId.has(node.id)) return { kind: 'invalid', code: 'plan_duplicate_id', nodes: [node.id] };
            const dependencies = [...new Set(node.depends_on ?? [])];
            for (const dependency of dependencies) {
                if (node.depends_on!.filter(id => id === dependency).length > 1)
                    warnings.push({ code: 'plan_duplicate_dependency', node_id: node.id, dependency });
            }
            if (node.dependency_results !== undefined && dependencies.length === 0)
                warnings.push({ code: 'plan_unused_dependency_results', node_id: node.id });
            const entry: PlanNode = { id: node.id, depends_on: dependencies,
                dependency_results: node.dependency_results ?? 'summary', state: { kind: 'waiting_dependencies' } };
            entries.push(entry);
            byId.set(node.id, entry);
        }
        for (const node of entries) for (const dependency of node.depends_on) {
            if (!byId.has(dependency)) return { kind: 'invalid', code: 'plan_unknown_dependency', nodes: [node.id, dependency] };
        }
        const remaining = new Set(entries);
        const topological: PlanNode[] = [];
        while (remaining.size) {
            const next = entries.find(node => remaining.has(node) && node.depends_on.every(id => !remaining.has(byId.get(id)!)));
            if (!next) {
                // Follow unresolved predecessors to report an actual cycle, excluding downstream nodes.
                const path: PlanNodeId[] = [];
                let node = [...remaining][0];
                while (!path.includes(node.id)) {
                    path.push(node.id);
                    node = byId.get(node.depends_on.find(id => remaining.has(byId.get(id)!))!)!;
                }
                return { kind: 'invalid', code: 'plan_cycle', nodes: path.slice(path.indexOf(node.id)) };
            }
            remaining.delete(next);
            topological.push(next);
        }
        return { kind: 'valid', plan: new SubTaskPlan(entries, topological), warnings };
    }

    get nodes(): readonly PlanNode[] { return structuredClone(this.entries); }
    get revision(): number { return this.revisionValue; }
    get status(): PlanStatus { return this.statusValue; }

    ready(): PlanNodeId[] {
        return this.entries.filter(node => node.state.kind === 'waiting_dependencies'
            && node.depends_on.every(id => this.entries.find(entry => entry.id === id)!.state.kind === 'done')).map(node => node.id);
    }

    queue(id: string, execution: PlanExecution): boolean {
        const node = this.entries.find(entry => entry.id === id);
        if (!node || !this.ready().includes(node.id) || !execution.runId || !execution.threadId
            || this.entries.some(entry => 'execution' in entry.state && entry.state.execution?.runId === execution.runId)) return false;
        this.replace(node, { kind: 'queued', execution: { ...execution } });
        return true;
    }

    start(id: string): boolean {
        const node = this.entries.find(entry => entry.id === id);
        if (!node || node.state.kind !== 'queued') return false;
        this.replace(node, { kind: 'running', execution: node.state.execution });
        return true;
    }

    /** Only the final delegation mapper may grant done; preflight failures need no execution. */
    settle(id: string, result: Extract<PlanNodeTerminal, { kind: 'done' | 'error' | 'stopped' }>): boolean {
        const node = this.entries.find(entry => entry.id === id);
        if (!node || isTerminal(node.state) || (result.kind === 'done' && node.state.kind !== 'running')) return false;
        const execution = 'execution' in node.state ? { execution: node.state.execution } : {};
        this.replace(node, { ...structuredClone(result), ...execution });
        for (const successor of this.topological) {
            if (successor.state.kind !== 'waiting_dependencies') continue;
            const failed = successor.depends_on.map(dependency => this.entries.find(entry => entry.id === dependency)!)
                .filter(entry => isTerminal(entry.state) && entry.state.kind !== 'done');
            if (failed.length) this.replace(successor, { kind: 'blocked', blocked_by: failed.map(entry => entry.id),
                root_causes: [...new Set(failed.flatMap(entry => entry.state.kind === 'blocked' ? entry.state.root_causes : [entry.id]))] });
        }
        this.finish();
        return true;
    }

    /** Pure group latch: the runtime must apply it before emitting callbacks or aborting runs. */
    stop(by: StopBy): void {
        this.close('stopped', state => ({ kind: 'stopped', by, ...('execution' in state ? { execution: state.execution } : {}) }));
    }

    interrupt(): void {
        this.close('interrupted', state => ({ kind: state.kind === 'running' ? 'interrupted' : 'not_executed',
            ...('execution' in state ? { execution: state.execution } : {}) }));
    }

    private close(status: 'stopped' | 'interrupted', terminal: (state: PlanNodeState) => PlanNodeState): void {
        if (this.statusValue !== 'active') return;
        for (const node of this.entries) if (!isTerminal(node.state)) this.replace(node, terminal(node.state));
        this.statusValue = status;
    }

    private replace(node: PlanNode, state: PlanNodeState): void {
        // Internal entries are shared with the topological view; public reads are detached snapshots.
        node.state = state;
        this.revisionValue++;
    }

    private finish(): void {
        if (this.entries.every(node => isTerminal(node.state)))
            this.statusValue = this.entries.every(node => node.state.kind === 'done') ? 'completed' : 'partial';
    }
}
