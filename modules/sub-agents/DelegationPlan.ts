/** Pure plan data and decisions. Execution, IDs allocation and result texts live elsewhere. */
declare const planIdBrand: unique symbol;
declare const planNodeIdBrand: unique symbol;
export type PlanId = string & { readonly [planIdBrand]: true };
export type PlanNodeId = string & { readonly [planNodeIdBrand]: true };
export type NonEmpty<T> = readonly [T, ...T[]];
export type Dependency = Readonly<{ nodeId: PlanNodeId; runId: string }>;
export type FailureReason = 'error' | 'timeout' | 'aborted' | 'no-answer' | 'incomplete';
export type PlanTaskState = Readonly<
    | { kind: 'waiting'; pending: NonEmpty<Dependency> }
    | { kind: 'queued' }
    | { kind: 'running' }
    | { kind: 'finished' }
    | { kind: 'failed'; reason: FailureReason }
    | { kind: 'blocked'; causes: NonEmpty<Dependency> }
>;
export type PlanTaskMetadata = Readonly<{
    planId: PlanId;
    nodeId: PlanNodeId;
    dependsOn: readonly Dependency[];
    state: PlanTaskState;
}>;
export type PlanGraphNode = Readonly<{ nodeId: PlanNodeId; dependsOn: readonly PlanNodeId[] }>;
/** Validated DAG, in input order (not topological order). */
export type DelegationGraph = readonly PlanGraphNode[];
export type PlanNode = Omit<PlanTaskMetadata, 'planId'> & Readonly<{ runId: string }>;
export type DelegationPlan = Readonly<{ planId: PlanId; nodes: readonly PlanNode[] }>;
export type PlanReport = DelegationPlan & Readonly<{
    complete: boolean;
    counts: Readonly<Record<PlanTaskState['kind'], number>>;
}>;

export type PlanReadyDriver = Readonly<{
    nextReady(): Promise<number | undefined>;
    /** Recheck after awaiting the index: Stop may have latched in that microtask gap. */
    canDispatch(index: number): boolean;
}>;

/** One queue per plan, shared by all pool workers. The registry commits waiting → queued
 * atomically during settle, before notifications. Claim that queued index synchronously
 * (before any await), so concurrent completions cannot dispatch a successor twice.
 * Only sleeping callers subscribe; no polling, admission, timers or result-text copies.
 */
export function createPlanReadyDriver(
    getReport: () => PlanReport, subscribe: (wake: () => void) => () => void,
): PlanReadyDriver {
    const claimed = new Set<number>();
    return Object.freeze({
        async nextReady(): Promise<number | undefined> {
            for (;;) {
                const report = getReport();
                const index = report.nodes.findIndex((node, i) => node.state.kind === 'queued' && !claimed.has(i));
                if (index !== -1) { claimed.add(index); return index; }
                if (report.complete) return undefined;
                let wake!: () => void;
                const changed = new Promise<void>(resolve => { wake = resolve; });
                const off = subscribe(wake);
                // Covers a synchronous change during subscription, without a lost wakeup.
                if (getReport() === report) await changed;
                off();
            }
        },
        canDispatch: (index: number) => claimed.has(index) && getReport().nodes[index]?.state.kind === 'queued',
    });
}

/** Runtime supplies a unique ID; validation does not allocate one or consult a clock. */
export function parsePlanId(value: unknown): PlanId | undefined {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value as PlanId : undefined;
}

export function parsePlanNodeId(value: unknown): PlanNodeId | undefined {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value as PlanNodeId : undefined;
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Delegation plan invariant: missing node.');
    return value;
}

/** Only finished predecessors unlock work. queued means eligible, not admitted to a slot. */
export function getPlanDependencyState(
    dependencies: readonly Dependency[], states: ReadonlyMap<PlanNodeId, PlanTaskState>,
): Extract<PlanTaskState, { kind: 'waiting' | 'queued' | 'blocked' }> {
    const pending: Dependency[] = [];
    const causes = new Map<PlanNodeId, Dependency>();
    for (const dependency of dependencies) {
        const state = required(states.get(dependency.nodeId));
        switch (state.kind) {
            case 'finished': break;
            case 'failed': causes.set(dependency.nodeId, dependency); break;
            case 'blocked':
                for (const cause of state.causes) causes.set(cause.nodeId, cause);
                break;
            case 'waiting': case 'queued': case 'running': pending.push(dependency); break;
            default: { const exhaustive: never = state; return exhaustive; }
        }
    }
    const [firstCause, ...otherCauses] = causes.values();
    if (firstCause) return { kind: 'blocked', causes: [firstCause, ...otherCauses] };
    const [firstPending, ...otherPending] = pending;
    return firstPending ? { kind: 'waiting', pending: [firstPending, ...otherPending] } : { kind: 'queued' };
}

/** Propagate all currently known root failures, even when successors precede their parents.
 * Terminal states are latched. This never claims ready tasks or changes the input snapshot.
 */
export function propagatePlanBlocks(plan: DelegationPlan): DelegationPlan {
    const nodes = new Map(plan.nodes.map(node => [node.nodeId, node]));
    const states = new Map<PlanNodeId, PlanTaskState>();
    const resolve = (node: PlanNode): PlanTaskState => {
        const cached = states.get(node.nodeId);
        if (cached) return cached;
        let state = node.state;
        if (state.kind === 'waiting') {
            for (const dependency of node.dependsOn) resolve(required(nodes.get(dependency.nodeId)));
            const next = getPlanDependencyState(node.dependsOn, states);
            if (next.kind === 'blocked') state = next;
        }
        states.set(node.nodeId, state);
        return state;
    };
    return { planId: plan.planId, nodes: plan.nodes.map(node => ({ ...node, state: resolve(node) })) };
}

function freezeDependencies(dependencies: readonly Dependency[]): readonly Dependency[] {
    return Object.freeze(dependencies.map(dependency => Object.freeze({ ...dependency })));
}

function freezeNonEmpty([first, ...rest]: NonEmpty<Dependency>): NonEmpty<Dependency> {
    return Object.freeze([Object.freeze({ ...first }), ...freezeDependencies(rest)]);
}

function snapshotState(state: PlanTaskState): PlanTaskState {
    switch (state.kind) {
        case 'waiting': return Object.freeze({ kind: 'waiting', pending: freezeNonEmpty(state.pending) });
        case 'blocked': return Object.freeze({ kind: 'blocked', causes: freezeNonEmpty(state.causes) });
        case 'queued': case 'running': case 'finished': case 'failed': return Object.freeze({ ...state });
        default: { const exhaustive: never = state; return exhaustive; }
    }
}

/** Immutable, text-free report in input order. Failed includes incomplete/partial runs;
 * material-aware finished/partial/failed/blocked response counts belong to the tool adapter.
 */
export function getPlanReport(plan: DelegationPlan): PlanReport {
    const counts = { waiting: 0, queued: 0, running: 0, finished: 0, failed: 0, blocked: 0 };
    const nodes = plan.nodes.map(node => {
        counts[node.state.kind]++;
        return Object.freeze({ ...node, dependsOn: freezeDependencies(node.dependsOn), state: snapshotState(node.state) });
    });
    return Object.freeze({ planId: plan.planId, nodes: Object.freeze(nodes), counts: Object.freeze(counts),
        complete: nodes.length > 0 && counts.waiting + counts.queued + counts.running === 0 });
}
