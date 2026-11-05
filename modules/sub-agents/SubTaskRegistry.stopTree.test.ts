import test from 'ava';
import { SubTaskRegistry } from './index.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

const owner = { agentName: 'Mira', sessionPath: 'chat.md', sessionEpoch: 'e1' };
const result = { text: 'zachowany dorobek', toolsUsed: ['read'], durationMs: 0, usage: null, stoppedBy: 'abort' as const };
const signal = () => new AbortController().signal;

function reserve(registry: SubTaskRegistry, id: string, parentId?: string) {
    return registry.createThread({ threadId: id, name: id, owner, origin: owner, config: {}, phase: 'queued', parentId });
}

test('Stop marks the whole tree before observers, cancels FIFO, and aborts leaves before root despite a throwing handle', async t => {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    t.teardown(() => registry.dispose());
    const root = registry.create({ id: 'root', agentName: 'Mira', origin: owner, level: 1 });
    const child = registry.create({ id: 'child', threadId: 'child-thread', parentId: 'root', agentName: 'Mira', origin: owner, level: 2 });
    const leases = await Promise.all(['root', 'child', 'a', 'b', 'c'].map(id => registry.acquire(owner, id, signal())));
    reserve(registry, 'queued', 'child');
    const pending = t.throwsAsync(registry.acquire(owner, 'queued', signal()), { message: 'Sub-agent admission cancelled' });
    const next = registry.acquire(owner, 'next', signal());
    const question = registry.openParentQuestion(child.id, 'Co dalej?');
    if (question.kind !== 'opened') throw new Error('question rejected');
    const observations: unknown[] = [];
    registry.events.on('question:closed', () => {
        leases[0].release();
        observations.push([root.stopRequested, child.stopRequested, registry.getThread('queued')?.closedBy,
            registry.getRunActivity('queued'), registry.getRunActivity('next')]);
    });
    const calls: string[] = [];
    registry.attachAbort(child.id, () => {
        calls.push('child');
        registry.finish(child, result);
        leases[1].release();
        throw new Error('one abort fails');
    });
    registry.attachAbort(root.id, () => {
        calls.push('root');
        t.throws(() => reserve(registry, 'forbidden', 'root'), { message: 'Sub-agent admission cancelled' });
        observations.push(registry.getRunActivity('next'));
        registry.finish(root, result);
    });
    t.is(registry.requestStop('root', 'lead'), true);
    await pending;
    t.deepEqual(calls, ['child', 'root']);
    t.deepEqual(observations, [[true, true, 'lead', 'inactive', 'queued'], 'queued']);
    t.deepEqual(await question.resolution, { kind: 'cancelled', by: 'lead', reason: 'stop' });
    t.deepEqual([root.result?.text, child.result?.text, registry.getThread('queued')?.phase,
        registry.getRunActivity('next'), clock.pending], ['zachowany dorobek', 'zachowany dorobek', 'closed', 'working', 0]);
    (await next).release(); leases.forEach(lease => lease.release());
});

test('Stop accepts a queued run without attachAbort and its terminal record is emitted once', async t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    reserve(registry, 'queued');
    const finished: string[] = [];
    registry.events.on('task:finished', value => finished.push((value as { id: string }).id));
    t.is(registry.requestStop('queued', 'user'), true);
    let calls = 0;
    registry.attachAbort('queued', () => { calls++; });
    registry.finishQueuedStop('queued', { background: true, taskPreview: 'zadanie' });
    registry.finishQueuedStop('queued', { background: true });
    await t.throwsAsync(registry.acquire(owner, 'queued', signal()), { message: 'Sub-agent admission cancelled' });
    t.deepEqual([calls, finished, registry.getTask('queued')?.outcome, registry.getThread('queued')?.runIds],
        [1, ['queued'], { end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] }, ['queued']]);
});

test('owner Stop isolates epoch, path and agent, rejects incomplete owner, blocks reentrant reservations only during Stop', async t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    const root = registry.create({ id: 'root', origin: owner });
    const otherOwners = [{ ...owner, sessionEpoch: 'e2' }, { ...owner, sessionPath: 'other.md' }, { ...owner, agentName: 'Other' }];
    otherOwners.forEach((origin, i) => registry.create({ id: `other-${i}`, origin }));
    registry.attachAbort(root.id, () => {
        t.throws(() => reserve(registry, 'reentrant'), { message: 'Sub-agent admission cancelled' });
        registry.finish(root, result);
    });
    t.is(registry.requestStopForOwner({ agentName: 'Mira' }), 0);
    t.is(registry.requestStopForOwner(owner), 1);
    const fresh = reserve(registry, 'fresh');
    const lease = await registry.acquire(owner, fresh.threadId, signal());
    t.deepEqual(registry.list().map(task => [task.id, task.status]),
        [['root', 'aborted'], ['other-0', 'running'], ['other-1', 'running'], ['other-2', 'running']]);
    t.is(registry.getRunActivity('fresh'), 'working');
    lease.release();
});

test('finished parent retains live descendants for Stop; late attachment preserves first actor and continuation threshold', t => {
    const registry = new SubTaskRegistry({ maxDone: 1 });
    t.teardown(() => registry.dispose());
    const root = registry.create({ id: 'root', origin: owner });
    const thread = registry.createThread({ threadId: 'child-thread', name: 'child', owner, origin: owner, config: {} });
    const child = registry.create({ id: 'child-run', parentId: 'root', threadId: thread.threadId, origin: owner });
    registry.finish(root, result);
    registry.finish(registry.create({ id: 'other' }), result);
    const oldTurn = registry.issueTurnStartSequence();
    t.is(registry.requestStop('root', 'user'), true);
    registry.requestStop('child-run', 'lead');
    let calls = 0;
    registry.attachAbort('child-run', () => { calls++; registry.finish(child, result); });
    registry.endRun(thread.threadId, { successful: true });
    t.deepEqual([calls, child.stopRequestedBy, thread.userStop, registry.beginRun(thread.threadId, owner, { turnKind: 'user', turnStartedSeq: oldTurn })],
        [1, 'user', true, false]);
    t.is(registry.beginRun(thread.threadId, owner, { turnKind: 'user', turnStartedSeq: registry.issueTurnStartSequence() }), true);
});

test('unload closes questions and queue, rejects reentrant work, and late attach still aborts after dispose', async t => {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    const task = registry.create({ id: 'root', threadId: 'root-thread', agentName: 'Mira', origin: owner });
    const question = registry.openParentQuestion(task.id, 'Pytanie');
    if (question.kind !== 'opened') throw new Error('question rejected');
    reserve(registry, 'queued', task.id);
    let calls = 0;
    registry.attachAbort(task.id, () => { calls++; t.throws(() => reserve(registry, 'late'), { message: 'Sub-agent admission cancelled' }); });
    t.is(registry.stopAll('unload'), 1);
    t.deepEqual(await question.resolution, { kind: 'cancelled', by: 'system', reason: 'unload' });
    t.deepEqual([registry.getThread('queued')?.phase, task.stopRequestedBy, clock.pending], ['closed', 'system', 0]);
    registry.dispose();
    registry.attachAbort('queued', () => { calls++; });
    await t.throwsAsync(registry.acquire(owner, 'late', signal()), { message: 'Sub-agent admission cancelled' });
    t.deepEqual([calls, registry.list().length, registry.events.listenerCount('task:finished'), clock.pending], [2, 0, 0, 0]);
});

test('Stop rejects a synchronous answer from another question close observer before abort callbacks', async t => {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    t.teardown(() => registry.dispose());
    const root = registry.create({ id: 'root', threadId: 'root-thread', origin: owner });
    const child = registry.create({ id: 'child', threadId: 'child-thread', parentId: root.id, origin: owner });
    const first = registry.openParentQuestion(root.id, 'Pierwsze');
    const second = registry.openParentQuestion(child.id, 'Drugie');
    if (first.kind !== 'opened' || second.kind !== 'opened') throw new Error('question rejected');
    const answers: unknown[] = [];
    registry.events.on('question:closed', value => {
        if (value === first.question) answers.push(registry.answerParentQuestion(child.id, second.question.id, owner, 'za późno'));
    });
    registry.requestStop(root.id);
    t.deepEqual(answers, [{ kind: 'rejected', reason: 'expired' }]);
    t.deepEqual(await Promise.all([first.resolution, second.resolution]), [
        { kind: 'cancelled', by: 'user', reason: 'stop' }, { kind: 'cancelled', by: 'user', reason: 'stop' },
    ]);
    t.is(clock.pending, 0);
});
