import test from 'ava';
import { SubTaskPlan } from './SubTaskPlan.js';

const graph = [{ id: 'A' }, { id: 'B' }, { id: 'C', depends_on: ['A', 'B'] }];
function plan(input: unknown = graph): SubTaskPlan {
    const parsed = SubTaskPlan.create(input, 5);
    if (parsed.kind === 'invalid') throw new Error(parsed.code);
    return parsed.plan;
}
function run(subject: SubTaskPlan, id: string): void {
    if (!subject.queue(id, { runId: `run-${id}`, threadId: `thread-${id}` }) || !subject.start(id))
        throw new Error(`Cannot start ${id}`);
}

test('A and B are ready without reservations; C needs both final results', t => {
    const subject = plan();
    t.deepEqual(subject.ready(), ['A', 'B']);
    t.deepEqual(subject.nodes.map(node => node.state), [
        { kind: 'waiting_dependencies' }, { kind: 'waiting_dependencies' }, { kind: 'waiting_dependencies' },
    ]);
    t.false(subject.queue('C', { runId: 'run-C', threadId: 'thread-C' }));
    run(subject, 'A'); run(subject, 'B');
    t.true(subject.settle('A', { kind: 'done', material: 'result A' }));
    t.deepEqual({ ready: subject.ready(), status: subject.status }, { ready: [], status: 'active' });
    subject.settle('B', { kind: 'done', material: 'result B' });
    t.deepEqual(subject.ready(), ['C']);
    run(subject, 'C');
    subject.settle('C', { kind: 'done', material: 'result C' });
    t.deepEqual({ status: subject.status, revision: subject.revision, results: subject.nodes.map(node => node.state) }, {
        status: 'completed', revision: 9, results: [
            { kind: 'done', material: 'result A', execution: { runId: 'run-A', threadId: 'thread-A' } },
            { kind: 'done', material: 'result B', execution: { runId: 'run-B', threadId: 'thread-B' } },
            { kind: 'done', material: 'result C', execution: { runId: 'run-C', threadId: 'thread-C' } },
        ],
    });
    t.false(subject.settle('A', { kind: 'error', error: 'late error' }));
    subject.stop('user'); subject.interrupt();
    t.deepEqual({ status: subject.status, revision: subject.revision, first: subject.nodes[0].state }, {
        status: 'completed', revision: 9, first: { kind: 'done', material: 'result A', execution: { runId: 'run-A', threadId: 'thread-A' } },
    });
});

test('failure propagates in reverse definitions, preserving direct and original causes', t => {
    const subject = plan([{ id: 'D', depends_on: ['C'] }, graph[2], graph[0], graph[1]]);
    subject.settle('A', { kind: 'error', error: 'timeout', material: 'draft A' });
    t.deepEqual(subject.ready(), ['B']);
    run(subject, 'B');
    subject.settle('B', { kind: 'done', material: 'result B' });
    t.deepEqual({ status: subject.status, states: subject.nodes.map(node => node.state) }, {
        status: 'partial', states: [
            { kind: 'blocked', blocked_by: ['C'], root_causes: ['A'] },
            { kind: 'blocked', blocked_by: ['A'], root_causes: ['A'] },
            { kind: 'error', error: 'timeout', material: 'draft A' },
            { kind: 'done', material: 'result B', execution: { runId: 'run-B', threadId: 'thread-B' } },
        ],
    });
    t.false(subject.settle('C', { kind: 'done', material: 'late result' }));
    t.is(subject.revision, 6);
});

test('invalid graphs have deterministic refusal codes and locations', t => {
    for (const [input, expected] of [
        [[{ id: 'C', depends_on: ['A'] }, { id: 'A', depends_on: ['B'] }, { id: 'B', depends_on: ['A'] }], { code: 'plan_cycle', nodes: ['A', 'B'] }],
        [[{ id: 'A', depends_on: ['A'] }], { code: 'plan_cycle', nodes: ['A'] }],
        [[{ id: 'A' }, { id: 'A' }], { code: 'plan_duplicate_id', nodes: ['A'] }],
        [[{ id: 'A', depends_on: ['a'] }], { code: 'plan_unknown_dependency', nodes: ['A', 'a'] }],
        [[{}], { code: 'plan_invalid_node', nodes: [], index: 0 }],
        [[{ id: '1A' }], { code: 'plan_invalid_node', nodes: [], index: 0 }],
        [[{ id: 'A\n' }], { code: 'plan_invalid_node', nodes: [], index: 0 }],
        [[{ id: 'A', depends_on: 'B' }], { code: 'plan_invalid_node', nodes: [], index: 0 }],
        [[{ id: 'A', dependency_results: 'silent-fallback' }], { code: 'plan_invalid_node', nodes: [], index: 0 }],
        [[], { code: 'plan_invalid_definition', nodes: [] }],
        [null, { code: 'plan_invalid_definition', nodes: [] }],
    ] as const) t.deepEqual(SubTaskPlan.create(input, 5), { kind: 'invalid', ...expected });
    t.deepEqual(SubTaskPlan.create(graph, 2), { kind: 'invalid', code: 'plan_too_many_nodes', nodes: [] });
});

test('duplicate edges warn once, modes default explicitly and definition order is stable', t => {
    const parsed = SubTaskPlan.create([
        { id: 'C', depends_on: ['A', 'A', 'A'], dependency_results: 'full' },
        { id: 'a', dependency_results: 'summary' }, { id: 'A' },
    ], 5);
    if (parsed.kind !== 'valid') return t.fail(parsed.code);
    t.deepEqual(parsed.warnings, [
        { code: 'plan_duplicate_dependency', node_id: 'C', dependency: 'A' },
        { code: 'plan_unused_dependency_results', node_id: 'a' },
    ]);
    t.deepEqual(parsed.plan.nodes.map(({ id, depends_on, dependency_results }) => ({ id, depends_on, dependency_results })), [
        { id: 'C', depends_on: ['A'], dependency_results: 'full' },
        { id: 'a', depends_on: [], dependency_results: 'summary' }, { id: 'A', depends_on: [], dependency_results: 'summary' },
    ]);
    t.deepEqual(parsed.plan.ready(), ['a', 'A']);
    run(parsed.plan, 'A'); parsed.plan.settle('A', { kind: 'done', material: 'A' });
    t.deepEqual(parsed.plan.ready(), ['C', 'a']);
});

test('admission transitions refuse repeats; stop keeps completed material and first actor', t => {
    const subject = plan();
    t.false(subject.start('A'));
    t.false(subject.settle('A', { kind: 'done', material: 'too early' }));
    t.true(subject.queue('A', { runId: 'run-A', threadId: 'thread-A' }));
    t.false(subject.queue('A', { runId: 'other', threadId: 'other' }));
    t.false(subject.queue('B', { runId: 'run-A', threadId: 'other' }));
    t.deepEqual(subject.nodes[0].state, { kind: 'queued', execution: { runId: 'run-A', threadId: 'thread-A' } });
    subject.start('A'); subject.settle('A', { kind: 'done', material: 'result A' });
    subject.stop('user'); subject.stop('system');
    t.false(subject.settle('B', { kind: 'error', error: 'late' }));
    t.deepEqual({ status: subject.status, revision: subject.revision, states: subject.nodes.map(node => node.state) }, {
        status: 'stopped', revision: 5, states: [
            { kind: 'done', material: 'result A', execution: { runId: 'run-A', threadId: 'thread-A' } },
            { kind: 'stopped', by: 'user' }, { kind: 'stopped', by: 'user' },
        ],
    });
});

test('interrupt distinguishes queued and running; snapshots and input cannot rewrite the plan', t => {
    const input = [{ id: 'A', depends_on: [] }, { id: 'B' }, graph[2]];
    const subject = plan(input);
    input[0].id = 'X';
    run(subject, 'A'); subject.queue('B', { runId: 'run-B', threadId: 'thread-B' });
    subject.nodes[0].state = { kind: 'error', error: 'external mutation' };
    subject.interrupt(); subject.interrupt();
    t.deepEqual({ status: subject.status, revision: subject.revision, states: subject.nodes.map(node => node.state) }, {
        status: 'interrupted', revision: 6, states: [
            { kind: 'interrupted', execution: { runId: 'run-A', threadId: 'thread-A' } },
            { kind: 'not_executed', execution: { runId: 'run-B', threadId: 'thread-B' } },
            { kind: 'not_executed' },
        ],
    });
});
