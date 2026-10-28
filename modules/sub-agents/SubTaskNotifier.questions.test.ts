import test from 'ava';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { SubTaskNotifier } from './SubTaskNotifier.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

test('koniec zastępuje niedostarczone pytanie wynikiem', t => {
    const clock = new QuestionTestClock(); const registry = new SubTaskRegistry({ questionClock: clock });
    const notifier = new SubTaskNotifier({ registry });
    const task = registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' }, background: true });
    registry.openParentQuestion('r1', 'Jaki zakres?');
    const [claim] = notifier.claimNotices(() => true); t.is(claim.notice.kind, 'question');
    clock.advance(300000);
    registry.finish(task, { text: 'dorobek', toolsUsed: [], durationMs: 0, usage: null }); claim.release(); claim.ack();
    t.deepEqual(notifier.pendingNotices().map(n => n.kind === 'result' ? { kind: n.kind, taskId: n.task.id } : { kind: n.kind, taskId: n.question.taskId }), [{ kind: 'result', taskId: 'r1' }]);
    notifier.dispose(); registry.dispose();
});
