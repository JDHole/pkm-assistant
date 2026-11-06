import test from 'ava';
import { parsePlanId, parsePlanNodeId, getPlanDependencyState, propagatePlanBlocks, getPlanReport } from './index.js';
import type { DelegationPlan, Dependency, PlanNode, PlanTaskState, FailureReason } from './index.js';

function nodeId(value: string) {
    const id = parsePlanNodeId(value);
    if (!id) throw new Error('Invalid fixture node id');
    return id;
}
function planId() {
    const id = parsePlanId('plan-1');
    if (!id) throw new Error('Invalid fixture plan id');
    return id;
}
const dependency = (id: string): Dependency => ({ nodeId: nodeId(id), runId: `run-${id}` });
function node(id: string, state: PlanTaskState, dependsOn: string[] = []): PlanNode {
    return { ...dependency(id), state, dependsOn: dependsOn.map(dependency) };
}
const waiting = (id: string, ...rest: string[]): PlanTaskState => ({ kind: 'waiting', pending: [dependency(id), ...rest.map(dependency)] });

test('plan ID boundaries validate unknown without normalizing identifiers', t => {
    t.deepEqual(['plan-1', '', ' bad ', null, 42, 'A'.repeat(129)].map(parsePlanId),
        ['plan-1', undefined, undefined, undefined, undefined, undefined]);
    t.deepEqual(['A_a-1', 'a', '', null, 'A'.repeat(65), 'A\n', 'A\r'].map(parsePlanNodeId),
        ['A_a-1', 'a', undefined, undefined, undefined, undefined, undefined]);
});

test('readiness: roots are eligible; A/B → C waits for B after A finishes', t => {
    const states = new Map<ReturnType<typeof nodeId>, PlanTaskState>([
        [nodeId('A'), { kind: 'running' }], [nodeId('B'), { kind: 'running' }],
    ]);
    t.deepEqual(getPlanDependencyState([], states), { kind: 'queued' });
    t.deepEqual(getPlanDependencyState([dependency('A'), dependency('B')], states),
        { kind: 'waiting', pending: [{ nodeId: 'A', runId: 'run-A' }, { nodeId: 'B', runId: 'run-B' }] });
    states.set(nodeId('A'), { kind: 'finished' });
    t.deepEqual(getPlanDependencyState([dependency('A'), dependency('B')], states),
        { kind: 'waiting', pending: [{ nodeId: 'B', runId: 'run-B' }] });
    t.deepEqual(getPlanDependencyState([dependency('A')], states), { kind: 'queued' });
    states.set(nodeId('B'), { kind: 'finished' });
    t.deepEqual(getPlanDependencyState([dependency('A'), dependency('B')], states), { kind: 'queued' });
});

test('readiness: waiting or queued predecessor cannot unlock its successor', t => {
    const states = new Map<ReturnType<typeof nodeId>, PlanTaskState>([
        [nodeId('A'), waiting('B')], [nodeId('B'), { kind: 'queued' }],
    ]);
    t.deepEqual(getPlanDependencyState([dependency('A'), dependency('B')], states),
        { kind: 'waiting', pending: [{ nodeId: 'A', runId: 'run-A' }, { nodeId: 'B', runId: 'run-B' }] });
});

for (const reason of ['error', 'timeout', 'aborted', 'no-answer', 'incomplete'] satisfies FailureReason[]) {
    test(`propagation: ${reason} blocks C/D with original A; independent B continues`, t => {
        const plan: DelegationPlan = { planId: planId(), nodes: [
            node('D', waiting('C'), ['C']), node('C', waiting('A'), ['A']),
            node('A', { kind: 'failed', reason }), node('B', { kind: 'running' }),
        ] };
        const result = propagatePlanBlocks(plan);
        t.deepEqual(result.nodes.map(n => ({ id: n.nodeId, state: n.state })), [
            { id: 'D', state: { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'run-A' }] } },
            { id: 'C', state: { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'run-A' }] } },
            { id: 'A', state: { kind: 'failed', reason } }, { id: 'B', state: { kind: 'running' } },
        ]);
        t.deepEqual(plan.nodes.map(n => n.state.kind), ['waiting', 'waiting', 'failed', 'running']);
        t.deepEqual(propagatePlanBlocks(result).nodes.map(n => n.state.kind), ['blocked', 'blocked', 'failed', 'running']);
    });
}

test('propagation: diamond deduplicates root causes and collects both failed branches', t => {
    const result = propagatePlanBlocks({ planId: planId(), nodes: [
        node('D', waiting('C', 'A', 'B'), ['C', 'A', 'B']), node('C', waiting('A', 'B'), ['A', 'B']),
        node('A', { kind: 'failed', reason: 'timeout' }), node('B', { kind: 'failed', reason: 'error' }),
    ] });
    t.deepEqual(result.nodes.slice(0, 2).map(n => n.state), [
        { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'run-A' }, { nodeId: 'B', runId: 'run-B' }] },
        { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'run-A' }, { nodeId: 'B', runId: 'run-B' }] },
    ]);
});

test('propagation never claims work and a blocked terminal state cannot reopen', t => {
    const result = propagatePlanBlocks({ planId: planId(), nodes: [
        node('C', waiting('A'), ['A']), node('A', { kind: 'finished' }),
        node('D', { kind: 'blocked', causes: [dependency('A')] }, ['A']),
        node('B', { kind: 'queued' }),
    ] });
    t.deepEqual(result.nodes.map(n => n.state), [
        { kind: 'waiting', pending: [{ nodeId: 'A', runId: 'run-A' }] }, { kind: 'finished' },
        { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'run-A' }] }, { kind: 'queued' },
    ]);
});

test('report: all states count once, in input order, and snapshot survives input mutation', t => {
    const mutableDependency = { nodeId: nodeId('A'), runId: 'run-A' };
    const plan: DelegationPlan = { planId: planId(), nodes: [
        { ...dependency('C'), state: { kind: 'waiting', pending: [mutableDependency] }, dependsOn: [mutableDependency] },
        node('A', { kind: 'running' }), node('B', { kind: 'finished' }), node('D', { kind: 'queued' }),
        node('E', { kind: 'failed', reason: 'incomplete' }), node('F', { kind: 'blocked', causes: [dependency('E')] }, ['E']),
    ] };
    const report = getPlanReport(plan);
    mutableDependency.runId = 'changed';
    t.deepEqual(report, { planId: 'plan-1', complete: false,
        counts: { waiting: 1, queued: 1, running: 1, finished: 1, failed: 1, blocked: 1 }, nodes: [
            { nodeId: 'C', runId: 'run-C', dependsOn: [{ nodeId: 'A', runId: 'run-A' }],
                state: { kind: 'waiting', pending: [{ nodeId: 'A', runId: 'run-A' }] } },
            { nodeId: 'A', runId: 'run-A', dependsOn: [], state: { kind: 'running' } },
            { nodeId: 'B', runId: 'run-B', dependsOn: [], state: { kind: 'finished' } },
            { nodeId: 'D', runId: 'run-D', dependsOn: [], state: { kind: 'queued' } },
            { nodeId: 'E', runId: 'run-E', dependsOn: [], state: { kind: 'failed', reason: 'incomplete' } },
            { nodeId: 'F', runId: 'run-F', dependsOn: [{ nodeId: 'E', runId: 'run-E' }],
                state: { kind: 'blocked', causes: [{ nodeId: 'E', runId: 'run-E' }] } },
        ] });
    t.throws(() => Object.assign(report.nodes[0].dependsOn[0], { runId: 'overwrite' }), { instanceOf: TypeError });
    t.throws(() => Object.assign(report.nodes[5].state, { kind: 'running' }), { instanceOf: TypeError });
});

test('report completes with failed and blocked nodes; empty or active plan is not complete', t => {
    const report = getPlanReport({ planId: planId(), nodes: [node('A', { kind: 'finished' }),
        node('B', { kind: 'failed', reason: 'error' }), node('C', { kind: 'blocked', causes: [dependency('B')] }, ['B'])] });
    t.deepEqual({ complete: report.complete, counts: report.counts }, { complete: true,
        counts: { waiting: 0, queued: 0, running: 0, finished: 1, failed: 1, blocked: 1 } });
    t.deepEqual(getPlanReport({ planId: planId(), nodes: [] }), { planId: 'plan-1', nodes: [], complete: false,
        counts: { waiting: 0, queued: 0, running: 0, finished: 0, failed: 0, blocked: 0 } });
});
