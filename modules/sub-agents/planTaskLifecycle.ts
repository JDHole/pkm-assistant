/** Plan bookkeeping only: no scheduler, model, timers or result copies. */
import { getPlanDependencyState, getPlanReport } from './DelegationPlan.js';
import type { DelegationPlan, PlanNode, PlanNodeId, PlanReport, PlanTaskState } from './DelegationPlan.js';
import { classifyRunEnd } from './runOutcome.js';
import type { RunOutcome } from './runOutcome.js';
import type { SubTaskResult } from './SubTaskRegistry.js';

export type TaskTerminal =
    | { kind: 'result'; result: SubTaskResult }
    | { kind: 'error'; error: string; outcome?: RunOutcome; result?: SubTaskResult }
    | { kind: 'timeout' | 'aborted'; result?: SubTaskResult };

export function terminalPlanState(terminal: TaskTerminal): Extract<PlanTaskState, { kind: 'finished' | 'failed' }> {
    switch (terminal.kind) {
        case 'error': return { kind: 'failed', reason: 'error' };
        case 'timeout': return { kind: 'failed', reason: 'timeout' };
        case 'aborted': return { kind: 'failed', reason: 'aborted' };
        case 'result': {
            const result = terminal.result;
            if (result.question?.resolution.kind === 'no-answer') return { kind: 'failed', reason: 'no-answer' };
            const outcome = result.outcome ?? classifyRunEnd({ ...result, finalText: result.text });
            switch (outcome.end.kind) {
                case 'finished': return outcome.hasAnswer && outcome.completeness === 'unconfirmed'
                    ? { kind: 'finished' } : { kind: 'failed', reason: 'incomplete' };
                case 'timeout': return { kind: 'failed', reason: 'timeout' };
                case 'stopped': return { kind: 'failed', reason: 'aborted' };
                case 'failed': return { kind: 'failed', reason: 'error' };
                case 'limit': case 'uncertain': return { kind: 'failed', reason: 'incomplete' };
                default: { const exhaustive: never = outcome.end; return exhaustive; }
            }
        }
        default: { const exhaustive: never = terminal; return exhaustive; }
    }
}

/** Input is a validated DAG; resolve predecessors even when a successor is listed first. */
export function refreshPlan(plan: DelegationPlan): PlanReport {
    const nodes = new Map(plan.nodes.map(node => [node.nodeId, node]));
    const states = new Map<PlanNodeId, PlanTaskState>();
    const resolve = (node: PlanNode): PlanTaskState => {
        const cached = states.get(node.nodeId);
        if (cached) return cached;
        let state = node.state;
        if (state.kind === 'waiting' || state.kind === 'queued') {
            for (const dependency of node.dependsOn) resolve(nodes.get(dependency.nodeId)!);
            state = getPlanDependencyState(node.dependsOn, states);
        }
        states.set(node.nodeId, state);
        return state;
    };
    return getPlanReport({ planId: plan.planId, nodes: plan.nodes.map(node => ({ ...node, state: resolve(node) })) });
}

/** Selected, unstarted successors are blocked by propagation; other selected nodes abort. */
export function planStopRoots(report: PlanReport, selected: ReadonlySet<string>): readonly string[] {
    const nodes = new Map(report.nodes.map(node => [node.nodeId, node]));
    const hasStoppedPredecessor = (node: PlanNode): boolean => node.dependsOn.some(dependency => {
        const predecessor = nodes.get(dependency.nodeId)!;
        return selected.has(predecessor.runId) || hasStoppedPredecessor(predecessor);
    });
    return report.nodes.filter(node => selected.has(node.runId)
        && (node.state.kind === 'running' || !hasStoppedPredecessor(node))).map(node => node.runId);
}
