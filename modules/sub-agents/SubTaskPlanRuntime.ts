import { maskSensitiveData } from '../../core/index.js';
import type { SubTaskOrigin } from './SubTaskRegistry.js';
import type { StopBy } from './runOutcome.js';
import { allocateSubTaskId } from './subTaskId.js';
import type { SubTaskPlan, PlanExecution, PlanNodeId, PlanNodeTerminal } from './SubTaskPlan.js';

type PlanOwner = Readonly<SubTaskOrigin & Required<Pick<SubTaskOrigin, 'agentName' | 'sessionPath' | 'sessionEpoch'>>>;
export type PlanReference = Readonly<{ planId: string; nodeId: PlanNodeId }>;
export type PlanSettlement = Extract<PlanNodeTerminal, { kind: 'done' | 'error' | 'stopped' }>;

/** Owns a graph, never a work lease, timer or second admission queue. */
export class SubTaskPlanRuntime {
    private admitted = false;
    admit(): void { this.admitted = true; }
    readonly owner: PlanOwner;
    readonly completion: Promise<void>;
    private complete!: () => void;
    private execute?: (id: PlanNodeId) => Promise<PlanSettlement>;
    private readonly dispatched = new Set<PlanNodeId>();
    private started = false;
    private pending = 0;
    private settledValue = false;
    get settled(): boolean { return this.settledValue; }

    constructor(private readonly graph: SubTaskPlan, owner: PlanOwner,
        readonly parentRunId: string | undefined, private readonly changed: () => void, private readonly finished: () => void, readonly planId = allocateSubTaskId('plan')) {
        this.owner = Object.freeze({ ...owner });
        this.completion = new Promise(resolve => { this.complete = resolve; });
        if (graph.status !== 'active') { this.settledValue = true; this.complete(); }
    }
    get nodes() { return this.graph.nodes; }
    get status() { return this.graph.status; }
    get revision() { return this.graph.revision; }
    reserve(id: PlanNodeId, execution: PlanExecution): boolean { return this.admitted && this.graph.queue(id, execution); }
    startNode(id: PlanNodeId): boolean { return this.admitted && this.graph.start(id); }

    start(execute: (id: PlanNodeId) => Promise<PlanSettlement>): void {
        if (!this.admitted || this.started || this.status !== 'active') return;
        this.started = true;
        this.execute = execute;
        this.dispatch();
    }
    settle(id: PlanNodeId, result: PlanSettlement): void {
        if (!this.admitted || !this.graph.settle(id, result)) return;
        this.publish();
        this.dispatch();
    }
    /** No observers here: the registry latches every plan and run in one Stop transaction. */
    latchStop(by: StopBy): void { this.graph.stop(by); this.execute = undefined; }
    latchInterrupt(): void { this.graph.interrupt(); this.execute = undefined; }
    publish(): void {
        if (!this.admitted) return;
        if (this.status !== 'active') this.execute = undefined;
        this.changed();
        this.finish();
    }
    private finish(): void {
        if (this.status === 'active' || this.pending !== 0 || this.settledValue) return;
        this.settledValue = true;
        try { this.finished(); }
        finally { this.complete(); }
    }
    private dispatch(): void {
        for (const id of this.graph.ready()) {
            if (!this.execute || this.status !== 'active' || this.dispatched.has(id)) continue;
            this.dispatched.add(id);
            this.pending++;
            // Claim before calling user code: preparation and consent may yield or reenter.
            void Promise.resolve().then(() => this.status === 'active' ? this.execute?.(id) : undefined)
                .then(result => { if (result) this.settle(id, result); }, error => {
                    this.settle(id, { kind: 'error', error: maskSensitiveData(String(error)) });
                }).finally(() => { this.pending--; this.finish(); });
        }
    }
}
