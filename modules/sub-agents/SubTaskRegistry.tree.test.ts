import test from 'ava';
import { SubTaskRegistry } from './index.js';
import type { SubTask } from './index.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

const owner = { agentName: 'Mira', sessionPath: 'mira.md', sessionEpoch: 'e1' };
const result = { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null };

for (const queued of [false, true]) {
    test(`retencja chroni cały łańcuch przodków ${queued ? 'rezerwacji' : 'biegu'} i zwalnia go po zakończeniu`, t => {
        const clock = new QuestionTestClock();
        const registry = new SubTaskRegistry({ maxDone: 1, questionClock: clock });
        t.teardown(() => registry.dispose());
        const root = registry.create({ id: 'root', name: 'root-config', agentName: 'Mira', origin: owner, level: 1 });
        const parent = registry.create({ id: 'parent', name: 'parent-config', agentName: 'Mira', origin: owner, parentId: 'root', level: 2 });
        let child: SubTask | undefined;
        if (queued) registry.createThread({ threadId: 'child', name: 'child-config', owner, origin: owner,
            parentId: 'parent', level: 3, config: {}, phase: 'queued' });
        else child = registry.create({ id: 'child', name: 'child-config', agentName: 'Mira', origin: owner, parentId: 'parent', level: 3 });
        registry.finish(root, result);
        registry.finish(parent, result);
        registry.finish(registry.create({ id: 'unrelated', origin: owner }), result);
        t.deepEqual(registry.list().map(task => task.id), queued ? ['root', 'parent'] : ['root', 'parent', 'child']);
        t.is(registry.pruneSession('mira.md'), 0);
        t.deepEqual(registry.list().map(task => task.id), queued ? ['root', 'parent'] : ['root', 'parent', 'child']);
        if (queued) {
            registry.closeThread('child', 'lead');
            registry.finishQueuedStop('child', {});
        } else registry.finish(child!, result);
        t.deepEqual(registry.list().map(task => [task.id, task.parentId, task.level]), [['child', 'parent', 3]]);
        t.is(registry.pruneSession('mira.md'), 1);
        t.deepEqual([registry.list().length, clock.pending], [0, 0]);
    });
}
