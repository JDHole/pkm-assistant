import test from 'ava';
import { SubRunCoordinator } from './SubRunCoordinator.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import type { SubTaskNotice } from './SubTaskNotifier.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

const owner = { agentName: 'Mira', sessionPath: 'chat.md', sessionEpoch: 'e1' };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
test('question closed while parent queues for a lease is not delivered; terminal result is delivered once', async t => {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    const parent = registry.create({ id: 'parent', name: 'parent', agentName: 'Mira', origin: owner });
    const child = registry.create({ id: 'child', threadId: 'child-thread', name: 'child', agentName: 'Mira', origin: owner, parentId: parent.id, level: 2 });
    const received: SubTaskNotice[] = [];
    const queued = deferred<void>();
    const resumed = deferred<void>();
    let releases = 0;
    const coordinator = new SubRunCoordinator(registry, parent, new AbortController().signal,
        activity => { if (activity.kind === 'queued') queued.resolve(); }, notices => received.push(...notices),
        { release: () => { releases++; }, resume: () => resumed.promise });
    const waiting = coordinator.beforeFinish();
    const question = registry.openParentQuestion(child.id, 'expired question');
    if (question.kind === 'rejected') throw new Error('Question rejected');
    await queued.promise;
    clock.advance(300000);
    t.deepEqual(await question.resolution, { kind: 'no-answer' });
    registry.finish(child, { text: 'child ended after deadline', toolsUsed: [], durationMs: 0, usage: null });
    resumed.resolve();
    t.is(await waiting, 'continue');
    await coordinator.iterationStart();
    t.deepEqual(received.map(notice => notice.kind === 'result' ? [notice.kind, notice.task.result?.text] : [notice.kind, notice.question.text]),
        [['result', 'child ended after deadline']]);
    t.deepEqual([await coordinator.beforeFinish(), releases, clock.pending], ['finish', 1, 0]);
    coordinator.close(); registry.dispose();
});
