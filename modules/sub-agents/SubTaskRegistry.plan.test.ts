import test from 'ava';
import { SubTaskRegistry, SubTaskNotifier, parsePlanId, classifyRunEnd } from './index.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';
import { parseDelegatePlan } from '../tools/index.js';
import type { PlanReport, ReservePlanInput, SubTask, SubTaskResult, TaskTerminal } from './index.js';

const owner = { agentName: 'Mira', sessionPath: 'chat.md', sessionEpoch: 'e1' };
const result = (text = 'pełny wynik'): SubTaskResult => ({ text, toolsUsed: [], durationMs: 1, usage: null,
    stoppedBy: 'natural', outcome: classifyRunEnd({ finalText: text }) });
const signal = () => new AbortController().signal;
function input(nodes: Array<[string, string[]]> = [['D', ['C']], ['C', ['A']], ['A', []], ['B', []]], plan = 'plan-1'): ReservePlanInput {
    const parsed = parseDelegatePlan({ tasks: nodes.map(([id, depends_on]) => ({ id, depends_on })) }, 20);
    const planId = parsePlanId(plan);
    if (parsed.kind !== 'plan' || !planId) throw new Error('Invalid test plan');
    return { planId, graph: parsed.graph, owner, origin: owner, background: true,
        tasks: parsed.graph.map(node => ({ nodeId: node.nodeId, runId: `${plan}-${node.nodeId}`, name: 'worker', taskPreview: `Zadanie ${node.nodeId}`,
            preparation: { kind: 'ready', threadId: `${plan}-${node.nodeId}`, config: { prepared: true } } })) };
}
function task(registry: SubTaskRegistry, id: string, plan = 'plan-1'): SubTask {
    const found = registry.getTask(`${plan}-${id}`);
    if (!found) throw new Error(`Missing task ${id}`);
    return found;
}
function activate(registry: SubTaskRegistry, id: string): SubTask {
    const placeholder = task(registry, id);
    if (!registry.beginQueuedRun(placeholder.threadId!, owner, { prepared: true })) throw new Error('Start rejected');
    return registry.create({ id: placeholder.id, threadId: placeholder.threadId, budget: { maxIterations: 9 } });
}
const states = (report: PlanReport) => report.nodes.map(node => [node.nodeId, node.state]);

test('F1 repeated owner Stop keeps trace retention bounded and records every stopped task', t => {
    const writes: Array<[string, string]> = [];
    const registry = new SubTaskRegistry({ traceLog: { scope: id => type => { writes.push([id, type]); } } });
    t.teardown(() => registry.dispose());
    for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 26; i++) registry.reservePlan(input([['A', []], ['C', ['A']]], `trace-${round}-${i}`));
        const lateTrace = registry.traceFor(task(registry, 'A', `trace-${round}-0`));
        t.is(registry.requestStopForOwner(owner), 52);
        t.deepEqual(registry.list().map(task => task.status), Array.from({ length: 25 }, () => ['aborted', 'blocked']).flat());
        t.deepEqual(writes.filter(([, type]) => type === 'stop.requested').slice(round * 52),
            Array.from({ length: 26 }, (_, i) => [[`trace-${round}-${i}-A`, 'stop.requested'], [`trace-${round}-${i}-C`, 'stop.requested']]).flat());
        // Resource lifetime is the behavior under test: removed tasks must not own cached closures.
        lateTrace('effects.checked', { matches: 1 });
        t.deepEqual(writes.at(-1), [`trace-${round}-0-A`, 'effects.checked']);
        const scopes: ReadonlyMap<string, unknown> = Reflect.get(registry, '_traceScopes');
        t.deepEqual([...scopes.keys()], []);
    }
});

test('F1 material capture protects terminal tasks during reentrant settlement and publishes once in order', t => {
    const registry = new SubTaskRegistry({ maxDone: 1 }); t.teardown(() => registry.dispose());
    const handle = registry.reservePlan(input([['C', ['A']], ['A', []], ['B', []]]));
    const a = activate(registry, 'A'); const b = activate(registry, 'B');
    const delivered: unknown[] = [];
    registry.events.on('task:finished', value => {
        const task = value as SubTask;
        delivered.push([task.id, task.planReport?.complete, registry.getTask(a.id)?.plan?.state.kind]);
    });
    registry.settle(a.id, { kind: 'timeout' }, () => {
        registry.finish(b, result('Independent B'));
        t.deepEqual(registry.list().map(task => [task.id, task.status]),
            [['plan-1-C', 'blocked'], ['plan-1-A', 'aborted'], ['plan-1-B', 'done']]);
        t.is(registry.pruneSession(owner.sessionPath), 0);
    });
    t.deepEqual(delivered, [['plan-1-A', false, 'failed'], ['plan-1-C', false, 'failed'], ['plan-1-B', true, 'failed']]);
    t.deepEqual([handle.getReport().complete, registry.list().map(task => [task.id, task.result?.text])],
        [true, [['plan-1-B', 'Independent B']]]);
});

test('P2 all nodes and one axis entry exist before the first event; activation preserves the placeholder', async t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const observed: unknown[] = [];
    registry.events.on('task:created', () => observed.push(registry.list().map(task => [task.id, task.status])));
    const planEvents: unknown[] = [];
    registry.events.on('task:plan', value => planEvents.push(states(value as PlanReport)));
    const handle = registry.reservePlan(input([['C', ['A', 'B']], ['A', []], ['B', []]]));
    const initial = handle.getReport();
    t.deepEqual(observed, Array(3).fill([['plan-1-C', 'waiting'], ['plan-1-A', 'waiting'], ['plan-1-B', 'waiting']]));
    t.deepEqual(states(initial), [['C', { kind: 'waiting', pending: [{ nodeId: 'A', runId: 'plan-1-A' }, { nodeId: 'B', runId: 'plan-1-B' }] }],
        ['A', { kind: 'queued' }], ['B', { kind: 'queued' }]]);
    const placeholder = task(registry, 'A');
    const lease = await registry.acquire(owner, placeholder.id, signal());
    t.is(activate(registry, 'A'), placeholder);
    t.deepEqual([placeholder.status, placeholder.plan?.state, placeholder.budget, registry.getThread(placeholder.threadId!)?.runIds],
        ['running', { kind: 'running' }, { maxIterations: 9 }, ['plan-1-A']]);
    t.is(observed.length, 3);
    t.deepEqual(planEvents[1], [['C', { kind: 'waiting', pending: [{ nodeId: 'A', runId: 'plan-1-A' }, { nodeId: 'B', runId: 'plan-1-B' }] }],
        ['A', { kind: 'running' }], ['B', { kind: 'queued' }]]);
    t.deepEqual(initial.counts, { waiting: 1, queued: 2, running: 0, finished: 0, failed: 0, blocked: 0 });
    lease.release();
});

test('P2 waiting cannot acquire, begin, activate, ask or become a live delegation parent', async t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    registry.reservePlan(input());
    const waiting = task(registry, 'C');
    await t.throwsAsync(registry.acquire(owner, waiting.id, signal()), { message: 'Sub-agent admission cancelled' });
    await t.throwsAsync(registry.acquire({ ...owner, sessionEpoch: 'other' }, task(registry, 'A').id, signal()), { message: 'Sub-agent admission cancelled' });
    t.is(registry.beginQueuedRun(waiting.threadId!, owner, {}), false);
    t.throws(() => registry.create({ id: waiting.id, threadId: waiting.threadId }), { message: 'Sub-agent plan activation cancelled' });
    t.deepEqual(registry.openParentQuestion(waiting.id, 'Pytanie'), { kind: 'rejected', reason: 'unavailable' });
    t.is(registry.getDelegationAncestors({ runId: waiting.id, level: 1, origin: owner }, owner.agentName), undefined);
    t.deepEqual([waiting.status, registry.getRunActivity(waiting.id), registry.getThread(waiting.threadId!)?.phase], ['waiting', 'inactive', 'queued']);
    activate(registry, 'A');
    t.deepEqual(registry.getDelegationAncestors({ runId: 'plan-1-A', level: 1, origin: owner }, owner.agentName)?.map(t => t.id), ['plan-1-A']);
});

test('P2 A error commits transitive C/D blocks and immutable report before notifications; B remains live', t => {
    const registry = new SubTaskRegistry(); const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const handle = registry.reservePlan(input()); activate(registry, 'A'); activate(registry, 'B');
    const observed: unknown[] = [];
    registry.events.on('task:finished', value => {
        const ended = value as SubTask;
        observed.push([ended.id, registry.list().map(task => task.status), ended.planReport?.counts, handle.getReport().complete]);
    });
    registry.fail(task(registry, 'A'), 'awaria A');
    const counts = { waiting: 0, queued: 0, running: 1, finished: 0, failed: 1, blocked: 2 };
    t.deepEqual(observed, ['plan-1-A', 'plan-1-D', 'plan-1-C'].map(id => [id, ['blocked', 'blocked', 'error', 'running'], counts, false]));
    t.deepEqual(states(handle.getReport()), [['D', { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }],
        ['C', { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }], ['A', { kind: 'failed', reason: 'error' }], ['B', { kind: 'running' }]]);
    t.deepEqual(notifier.pending().map(task => [task.id, task.result?.text]), [['plan-1-A', undefined], ['plan-1-D', ''], ['plan-1-C', '']]);
    const failureReport = task(registry, 'A').planReport!;
    t.throws(() => Object.assign(failureReport.nodes[0].state, { kind: 'running' }), { instanceOf: TypeError });
    registry.finish(task(registry, 'B'), result('wynik B'));
    t.deepEqual([handle.getReport().complete, task(registry, 'B').planReport?.complete, failureReport.complete], [true, true, false]);
    t.deepEqual(notifier.pending().map(task => task.id), ['plan-1-A', 'plan-1-D', 'plan-1-C', 'plan-1-B']);
});

test('P2 successful A updates pending to B; only successful B makes C eligible', async t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const handle = registry.reservePlan(input([['C', ['A', 'B']], ['A', []], ['B', []]]));
    activate(registry, 'A'); activate(registry, 'B');
    const observations: unknown[] = [];
    registry.events.on('task:finished', () => observations.push(task(registry, 'C').plan?.state));
    registry.finish(task(registry, 'A'), result('A pełne'));
    registry.finish(task(registry, 'B'), result('B pełne'));
    t.deepEqual(observations, [{ kind: 'waiting', pending: [{ nodeId: 'B', runId: 'plan-1-B' }] }, { kind: 'queued' }]);
    const lease = await registry.acquire(owner, 'plan-1-C', signal());
    activate(registry, 'C'); registry.finish(task(registry, 'C'), result('C pełne'));
    registry.finish(task(registry, 'C'), result('powtórka'));
    t.deepEqual([task(registry, 'C').result?.text, observations.length], ['C pełne', 3]);
    t.deepEqual(handle.getReport().counts, { waiting: 0, queued: 0, running: 0, finished: 3, failed: 0, blocked: 0 });
    lease.release();
});

test('P2 Stop waiting C aborts C and blocks D without stopping A/B; repeated and late callbacks are inert', async t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const handle = registry.reservePlan(input()); activate(registry, 'A'); activate(registry, 'B');
    const finished: string[] = [];
    registry.events.on('task:finished', value => finished.push((value as SubTask).id));
    t.is(registry.stopThread('plan-1-C'), true);
    t.deepEqual(states(handle.getReport()), [['D', { kind: 'blocked', causes: [{ nodeId: 'C', runId: 'plan-1-C' }] }],
        ['C', { kind: 'failed', reason: 'aborted' }], ['A', { kind: 'running' }], ['B', { kind: 'running' }]]);
    t.deepEqual([task(registry, 'C').stopRequestedBy, registry.getThread('plan-1-C')?.userStop,
        registry.getThread('plan-1-C')?.runIds, registry.getThread('plan-1-D')?.phase], ['user', true, ['plan-1-C'], 'closed']);
    t.is(registry.requestStop('plan-1-C'), false);
    t.is(registry.requestStop('plan-1-D'), false);
    let lateAbort = 0; registry.attachAbort('plan-1-C', () => { lateAbort++; });
    await t.throwsAsync(registry.acquire(owner, 'plan-1-C', signal()), { message: 'Sub-agent admission cancelled' });
    registry.finish(task(registry, 'C'), result('spóźnione C'));
    registry.finish(task(registry, 'A'), result()); registry.finish(task(registry, 'B'), result());
    t.deepEqual([lateAbort, finished, handle.getReport().complete], [1, ['plan-1-C', 'plan-1-D', 'plan-1-A', 'plan-1-B'], true]);
});

for (const stop of ['tree', 'owner', 'unload'] as const) test(`P2 Stop ${stop} latches the whole scope before callbacks, blocks unstarted successors and isolates sessions`, async t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const parent = registry.create({ id: 'parent', agentName: owner.agentName, origin: owner, level: 1 });
    const handle = registry.reservePlan({ ...input(), parentId: parent.id, level: 2 });
    const a = activate(registry, 'A');
    const lease = await registry.acquire(owner, a.id, signal());
    const other = registry.create({ id: 'other', origin: { ...owner, sessionEpoch: 'other' } });
    const callbacks: unknown[] = [];
    registry.attachAbort(a.id, () => {
        callbacks.push([a.stopRequested, task(registry, 'B').stopRequested, task(registry, 'C').status,
            handle.getReport().complete, registry.getRunActivity('plan-1-B')]);
        registry.finish(a, result('late success')); lease.release();
    });
    if (stop === 'tree') t.is(registry.requestStop(parent.id), true);
    else if (stop === 'owner') t.is(registry.requestStopForOwner(owner), 5);
    else t.is(registry.stopAll('unload'), 1);
    t.deepEqual(callbacks, [[true, true, 'blocked', true, 'inactive']]);
    t.deepEqual(states(handle.getReport()), [['D', { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }],
        ['C', { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }],
        ['A', { kind: 'failed', reason: 'aborted' }], ['B', { kind: 'failed', reason: 'aborted' }]]);
    t.deepEqual([a.status, a.stopRequestedBy, other.stopRequested ?? false], ['aborted', stop === 'unload' ? 'system' : 'user', stop === 'unload']);
    await t.throwsAsync(registry.acquire(owner, 'plan-1-B', signal()), { message: 'Sub-agent admission cancelled' });
});

test('P2 Stop A includes real children but leaves the independent plan branch B running', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const handle = registry.reservePlan(input()); activate(registry, 'A'); activate(registry, 'B');
    const child = registry.create({ id: 'child', parentId: 'plan-1-A', origin: owner });
    registry.attachAbort(child.id, () => registry.finish(child, { ...result(), stoppedBy: 'abort' }));
    registry.requestStop('plan-1-A', 'lead');
    t.deepEqual([child.status, child.stopRequestedBy, task(registry, 'B').status, handle.getReport().counts], ['aborted', 'lead', 'running',
        { waiting: 0, queued: 0, running: 1, finished: 0, failed: 1, blocked: 2 }]);
});

test('P2 timeout settles once, preserves available material and ignores late success/error', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const handle = registry.reservePlan(input()); const a = activate(registry, 'A');
    const finished: string[] = []; registry.events.on('task:finished', value => finished.push((value as SubTask).id));
    t.is(registry.settle(a.id, { kind: 'timeout', result: result('częściowy dorobek') }), true);
    const firstEnd = a.endedAt;
    registry.finish(a, result('late success')); registry.fail(a, 'late error');
    t.is(registry.settle(a.id, { kind: 'result', result: result('another success') }), false);
    t.deepEqual([finished, a.endedAt, a.result?.text, a.plan?.state, handle.getReport().counts],
        [['plan-1-A', 'plan-1-D', 'plan-1-C'], firstEnd, 'częściowy dorobek', { kind: 'failed', reason: 'timeout' },
            { waiting: 0, queued: 1, running: 0, finished: 0, failed: 1, blocked: 2 }]);
});

const unsuccessful: Array<[string, SubTaskResult]> = [
    ['incomplete', { ...result(), stoppedBy: 'backstop', outcome: classifyRunEnd({ stoppedBy: 'backstop', finalText: 'partial', partial: { synthesis: 'completed' } }) }],
    ['incomplete', result('')],
    ['no-answer', { ...result(), question: { text: 'Co dalej?', resolution: { kind: 'no-answer' } } }],
];
for (const [index, [reason, terminalResult]] of unsuccessful.entries()) test(`P2 non-success ${reason}/${index} never unlocks successors despite done status`, t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    registry.reservePlan(input()); const a = activate(registry, 'A');
    registry.finish(a, terminalResult);
    t.deepEqual([a.status, a.plan?.state, task(registry, 'C').plan?.state], ['done', { kind: 'failed', reason },
        { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }]);
});

test('P2 maxDone 1 and prune retain waiting nodes, full predecessor results and ancestors until plan completion', t => {
    const registry = new SubTaskRegistry({ maxDone: 1 }); t.teardown(() => registry.dispose());
    const parent = registry.create({ id: 'parent', origin: owner });
    const handle = registry.reservePlan({ ...input([['A', []], ['B', []], ['C', ['A', 'B']]]), parentId: parent.id, level: 2 });
    registry.finish(parent, result()); activate(registry, 'A'); activate(registry, 'B');
    const full = 'materiał źródłowy '.repeat(5000);
    registry.finish(task(registry, 'A'), result(full));
    registry.finish(registry.create({ id: 'unrelated', origin: owner }), result());
    t.is(registry.pruneSession(owner.sessionPath), 0);
    t.deepEqual(registry.list().map(task => [task.id, task.status]), [['parent', 'done'], ['plan-1-A', 'done'], ['plan-1-B', 'running'], ['plan-1-C', 'waiting']]);
    t.is(task(registry, 'A').result?.text, full);
    registry.finish(task(registry, 'B'), result('wynik B')); activate(registry, 'C');
    registry.finish(task(registry, 'C'), result('wynik C'));
    t.deepEqual([handle.getReport().complete, registry.list().map(task => [task.id, task.result?.text])], [true, [['plan-1-C', 'wynik C']]]);
    t.is(registry.pruneSession(owner.sessionPath), 1);
    t.deepEqual(handle.getReport().counts, { waiting: 0, queued: 0, running: 0, finished: 3, failed: 0, blocked: 0 });
});

test('P2 rejected preparation creates no executable reservation; other branch can start', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const original = input();
    const handle = registry.reservePlan({ ...original, tasks: original.tasks.map(task => task.nodeId === 'A'
        ? { ...task, preparation: { kind: 'rejected', error: 'Odmowa zgody' } } : task) });
    t.deepEqual(registry.listThreads(owner).map(thread => [thread.threadId, thread.phase]), [['plan-1-D', 'closed'], ['plan-1-C', 'closed'], ['plan-1-B', 'queued']]);
    t.deepEqual([task(registry, 'A').error, task(registry, 'A').threadId, task(registry, 'C').plan?.state], ['Odmowa zgody', undefined,
        { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }]);
    activate(registry, 'B'); registry.finish(task(registry, 'B'), result('B działa'));
    t.deepEqual(handle.getReport().counts, { waiting: 0, queued: 0, running: 0, finished: 1, failed: 1, blocked: 2 });
});

test('P2 preparation failure after reservation settles the existing placeholder and closes its thread once', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    registry.reservePlan(input()); const a = task(registry, 'A');
    t.is(registry.finishQueuedFailure(a.threadId!, { error: 'model unavailable' }), a);
    t.deepEqual([a.error, a.plan?.state, registry.getThread(a.threadId!)?.phase, registry.getThread(a.threadId!)?.runIds],
        ['model unavailable', { kind: 'failed', reason: 'error' }, 'closed', ['plan-1-A']]);
});

test('P2 failed registration publishes nothing and leaves the previous plan usable', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const original = input(); registry.reservePlan(original);
    t.throws(() => registry.reservePlan(original), { message: 'Sub-agent plan reservation cancelled' });
    const bad = input(undefined, 'plan-2');
    t.throws(() => registry.reservePlan({ ...bad, tasks: bad.tasks.map(task => ({ ...task, runId: 'collision' })) }), { message: 'Sub-agent plan identity conflict' });
    t.deepEqual(registry.list().map(task => task.id), ['plan-1-D', 'plan-1-C', 'plan-1-A', 'plan-1-B']);
    t.is(activate(registry, 'A').status, 'running');
});

test('P2 reentrant finish observes committed state and delivers each terminal once', t => {
    const registry = new SubTaskRegistry({ maxDone: 1 }); t.teardown(() => registry.dispose());
    const handle = registry.reservePlan(input()); activate(registry, 'A'); activate(registry, 'B');
    const finished: unknown[] = [];
    registry.events.on('task:finished', value => {
        const task = value as SubTask;
        finished.push([task.id, task.planReport?.complete, registry.list().length]);
        if (task.id === 'plan-1-A') registry.finish(registry.getTask('plan-1-B')!, result());
    });
    registry.fail(task(registry, 'A'), 'error');
    t.deepEqual(finished, [['plan-1-A', false, 4], ['plan-1-D', false, 4], ['plan-1-C', false, 4], ['plan-1-B', true, 4]]);
    t.deepEqual([handle.getReport().complete, registry.list().map(task => task.id)], [true, ['plan-1-B']]);
});

for (const terminal of [{ kind: 'timeout' }, { kind: 'aborted' }] satisfies TaskTerminal[]) test(`P2 legacy settle ${terminal.kind} is idempotent too`, t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const task = registry.create({ id: 'legacy' });
    const finished: string[] = []; registry.events.on('task:finished', value => finished.push((value as SubTask).id));
    registry.settle(task.id, terminal); registry.finish(task, result());
    t.deepEqual([task.status, task.outcome?.end, finished], ['aborted', terminal.kind === 'timeout' ? { kind: 'timeout' } : { kind: 'stopped', by: 'system' }, ['legacy']]);
});

test('P2 whole-plan Stop before dispatch records both failed roots and never acquires a slot', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const handle = registry.reservePlan(input([['D', ['C']], ['C', ['A', 'B']], ['B', []], ['A', []]]));
    const reports: unknown[] = [];
    registry.events.on('task:finished', value => reports.push((value as SubTask).planReport?.counts));
    t.is(registry.requestStopForOwner(owner), 4);
    t.deepEqual(states(handle.getReport()), [
        ['D', { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }, { nodeId: 'B', runId: 'plan-1-B' }] }],
        ['C', { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }, { nodeId: 'B', runId: 'plan-1-B' }] }],
        ['B', { kind: 'failed', reason: 'aborted' }], ['A', { kind: 'failed', reason: 'aborted' }],
    ]);
    t.deepEqual(reports, Array(4).fill({ waiting: 0, queued: 0, running: 0, finished: 0, failed: 2, blocked: 2 }));
    t.deepEqual(registry.list().map(task => [task.status, task.startedAt, registry.getRunActivity(task.id)]),
        [['blocked', undefined, 'inactive'], ['blocked', undefined, 'inactive'], ['aborted', undefined, 'inactive'], ['aborted', undefined, 'inactive']]);
});

test('P2 Stop between admission and placeholder activation closes the unstarted thread and rejects activation', async t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const original = input();
    registry.reservePlan({ ...original, tasks: original.tasks.map(task => ({ ...task,
        preparation: { kind: 'ready', threadId: `thread-${task.nodeId}`, config: {} } })) });
    const a = task(registry, 'A'); const lease = await registry.acquire(owner, a.id, signal());
    t.is(registry.beginQueuedRun('thread-A', owner, {}), true);
    registry.attachAbort(a.id, () => lease.release());
    t.is(registry.requestStop(a.id), true);
    t.throws(() => registry.create({ id: a.id, threadId: 'thread-A' }), { message: 'Sub-agent plan activation cancelled' });
    t.deepEqual([a.status, a.startedAt, registry.getThread('thread-A')?.phase, registry.getThread('thread-A')?.runIds,
        task(registry, 'C').plan?.state, registry.getRunActivity(a.id)],
    ['aborted', undefined, 'closed', ['plan-1-A'], { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }, 'inactive']);
});

test('P2 queued admission is cancelled during Stop before observers can release occupied slots', async t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const slots = await Promise.all(['s1', 's2', 's3', 's4', 's5'].map(id => registry.acquire(owner, id, signal())));
    const handle = registry.reservePlan(input());
    const queued = t.throwsAsync(registry.acquire(owner, 'plan-1-A', signal()), { message: 'Sub-agent admission cancelled' });
    const observations: unknown[] = [];
    registry.events.on('task:finished', () => {
        slots[0].release();
        observations.push([task(registry, 'A').stopRequested, task(registry, 'B').stopRequested, handle.getReport().complete]);
    });
    registry.requestStopForOwner(owner); await queued;
    t.deepEqual(observations, Array(4).fill([true, true, true]));
    t.is(registry.getRunActivity('plan-1-A'), 'inactive');
    slots.forEach(lease => lease.release());
    const fresh = await registry.acquire(owner, 'fresh', signal());
    t.is(registry.getRunActivity('fresh'), 'working'); fresh.release();
});

test('P2 all selected plans commit before the first owner-Stop notification', t => {
    const registry = new SubTaskRegistry({ maxDone: 1 }); t.teardown(() => registry.dispose());
    const first = registry.reservePlan(input()); const second = registry.reservePlan(input(undefined, 'plan-2'));
    const observations: unknown[] = [];
    registry.events.on('task:finished', value => observations.push([(value as SubTask).id, first.getReport().complete, second.getReport().complete]));
    registry.requestStopForOwner(owner);
    t.deepEqual(observations, ['plan-1-A', 'plan-1-B', 'plan-1-D', 'plan-1-C', 'plan-2-A', 'plan-2-B', 'plan-2-D', 'plan-2-C'].map(id => [id, true, true]));
});

test('P2 blocked children and their root failure enter the real parent inbox once with the committed report', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    registry.create({ id: 'parent', origin: owner, agentName: owner.agentName, level: 1 });
    registry.reservePlan({ ...input(), parentId: 'parent', level: 2 });
    const a = activate(registry, 'A'); registry.fail(a, 'awaria'); registry.finish(a, result('late'));
    t.deepEqual(registry.takeChildNotices('parent').map(notice => notice.kind === 'result'
        ? [notice.task.id, notice.task.planReport?.counts, notice.task.result?.text] : notice.kind),
    ['plan-1-A', 'plan-1-D', 'plan-1-C'].map(id => [id,
        { waiting: 0, queued: 1, running: 0, finished: 0, failed: 1, blocked: 2 }, id === 'plan-1-A' ? undefined : '']));
});

test('P2 a cloning failure during reservation leaves no tasks, threads or events; the same IDs can be retried', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const original = input(); const events: string[] = [];
    registry.events.on('task:created', value => events.push((value as SubTask).id));
    t.throws(() => registry.reservePlan({ ...original, tasks: original.tasks.map(task => task.nodeId === 'B'
        ? { ...task, preparation: { kind: 'ready', threadId: task.runId, config: { invalid: () => {} } } } : task) }), { name: 'DataCloneError' });
    t.deepEqual([registry.list().length, registry.listThreads(owner).length, events], [0, 0, []]);
    const handle = registry.reservePlan(original);
    t.deepEqual([events, handle.getReport().counts], [['plan-1-D', 'plan-1-C', 'plan-1-A', 'plan-1-B'],
        { waiting: 2, queued: 2, running: 0, finished: 0, failed: 0, blocked: 0 }]);
});


test('P2 answering a question does not unlock C; stopping A closes its question as Stop', async t => {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock }); t.teardown(() => registry.dispose());
    registry.reservePlan(input()); const a = activate(registry, 'A');
    const first = registry.openParentQuestion(a.id, 'Pierwsze pytanie');
    if (first.kind !== 'opened') throw new Error('Question rejected');
    registry.answerParentQuestion(a.id, first.question.id, owner, 'Odpowiedź');
    t.deepEqual(await first.resolution, { kind: 'answered', text: 'Odpowiedź' });
    t.deepEqual(task(registry, 'C').plan?.state, { kind: 'waiting', pending: [{ nodeId: 'A', runId: 'plan-1-A' }] });
    const second = registry.openParentQuestion(a.id, 'Drugie pytanie');
    if (second.kind !== 'opened') throw new Error('Question rejected');
    registry.requestStop(a.id, 'lead');
    t.deepEqual(await second.resolution, { kind: 'cancelled', by: 'lead', reason: 'stop' });
    t.deepEqual([clock.pending, task(registry, 'C').plan?.state], [0, { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'plan-1-A' }] }]);
});

test('P2 Stop preserves published partial material on A while blocked C has no material', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    registry.reservePlan(input()); const a = activate(registry, 'A');
    registry.publishPartial(a, { kind: 'agent-loop-partial', revision: 1, stopReason: { kind: 'iteration-limit' },
        synthesis: 'pending', toolsUsed: ['read'], toolOutcomes: [], toolCallDetails: [], usage: { prompt_tokens: 0, completion_tokens: 0 }, iterations: 1,
        lastText: 'odczytano notatkę', text: 'Zachowany materiał' });
    registry.requestStop(a.id);
    t.deepEqual([a.partial?.text, a.outcome, task(registry, 'C').result?.text, task(registry, 'C').outcome?.hasMaterial],
        ['Zachowany materiał', { end: { kind: 'stopped', by: 'user' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] }, '', false]);
});
