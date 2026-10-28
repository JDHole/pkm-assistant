import test from 'ava';
import { SubTaskNotifier, SubTaskRegistry } from '../../sub-agents/index.js';
import { QuestionTestClock } from '../../sub-agents/test-support/questionTestClock.js';
import { _deliverSubTaskQuestion, send_message } from './chat_streaming.js';

function fixture() {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    const notifier = new SubTaskNotifier({ registry });
    const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
    const tab = { ...owner, sessionId: 'tab', isActive: true };
    const window = { messages: [] as Array<Record<string, unknown>> };
    const agentManager = { getActiveAgent: () => ({ name: 'Jaskier' }), getAgentMemory: () => ({ activeSessionPath: 's.md', sessionEpoch: 'e1' }) };
    const sent: Array<Record<string, unknown>> = [];
    const view = {
        chatTabs: [tab], rollingWindow: window, plugin: { subTaskRegistry: registry, subTaskNotifier: notifier, agentManager },
        env: { settings: { pkmAssistant: { limits: {} } } }, _autoTurnChainCounts: new Map<string, number>(),
        _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
        send_message: async (opts: { meta: Record<string, unknown>; questionDelivery: { claim: { ack(): void } } }) => {
            window.messages.push(opts.meta);
            sent.push(opts.meta);
            opts.questionDelivery.claim.ack();
        },
    };
    notifier.setNoticeDeliverer(notice => notice.kind === 'question' ? _deliverSubTaskQuestion.call(view as never, notice.question) : false);
    const task = registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: owner, background: true });
    return { clock, registry, notifier, task, tab, view, sent, window };
}

test('pytanie budzi bezczynnego prowadzącego', async t => {
    const f = fixture();
    t.teardown(() => { f.notifier.dispose(); f.registry.dispose(); });
    const opened = f.registry.openParentQuestion('r1', 'Jaki zakres?');
    t.is(opened.kind, 'opened');
    await Promise.resolve();
    t.deepEqual({ turns: f.sent.length, origin: f.sent[0]?.origin, taskId: f.sent[0]?.taskId,
        name: f.sent[0]?.name, text: f.sent[0]?.question },
    { turns: 1, origin: 'machine', taskId: 'r1', name: 'Klara', text: 'Jaki zakres?' });
    t.is(f.sent[0]?.questionId, opened.kind === 'opened' ? opened.question.id : '');
});

test('pytanie respektuje bramki istniejącej kolejki', t => {
    const results = [];
    for (const gate of ['busy', 'inactive', 'stop', 'limit']) {
        const f = fixture();
        if (gate === 'busy') f.view.is_generating = true;
        if (gate === 'inactive') f.tab.isActive = false;
        if (gate === 'stop') f.view._drainSuppressed = true;
        if (gate === 'limit') f.view._autoTurnChainCounts.set('Jaskier', 1000);
        f.registry.openParentQuestion('r1', 'Jaki zakres?');
        results.push({ turns: f.sent.length, pending: f.notifier.pendingNotices().length });
        f.notifier.dispose();
        f.registry.dispose();
    }
    t.deepEqual(results, [{ turns: 0, pending: 1 }, { turns: 0, pending: 1 }, { turns: 0, pending: 1 }, { turns: 0, pending: 1 }]);
});

test('wygaśnięcie przed claim usuwa pytanie', async t => {
    const f = fixture();
    t.teardown(() => { f.notifier.dispose(); f.registry.dispose(); });
    f.registry.openParentQuestion('r1', 'Jaki zakres?');
    f.clock.advance(300000);
    f.registry.finish(f.task, { text: 'dorobek', toolsUsed: [], durationMs: 0, usage: null });
    await Promise.resolve();
    t.deepEqual({ questionMessages: f.sent.length, pending: f.notifier.pendingNotices().map(n => n.kind === 'result' ? { kind: n.kind, taskId: n.task.id } : { kind: n.kind, taskId: n.question.taskId }) },
        { questionMessages: 0, pending: [{ kind: 'result', taskId: 'r1' }] });
});

test('zmiana sesji podczas przygotowania nie przekierowuje pytania', async t => {
    const f = fixture();
    t.teardown(() => { f.notifier.dispose(); f.registry.dispose(); });
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    f.window.messages.push({ role: 'user', content: 'wcześniej' });
    Object.assign(f.view, {
        lastMessageTimestamp: 1,
        handleSaveSession: () => waiting,
        send_message: (opts: unknown) => send_message.call(f.view as never, opts as never),
    });
    const opened = f.registry.openParentQuestion('r1', 'Jaki zakres?');
    await Promise.resolve();
    f.tab.sessionEpoch = 'e2';
    resume();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const pending = f.notifier.pendingNotices()[0];
    t.deepEqual({ messagesInE2: f.window.messages.filter(m => m.questionId).length,
        pendingQuestionId: pending?.kind === 'question' ? pending.question.id : null },
    { messagesInE2: 0, pendingQuestionId: opened.kind === 'opened' ? opened.question.id : null });
});

test('wygaśnięcie przed przyjęciem usuwa pytanie', async t => {
    const f = fixture();
    t.teardown(() => { f.notifier.dispose(); f.registry.dispose(); });
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    f.window.messages.push({ role: 'user', content: 'wcześniej' });
    Object.assign(f.view, {
        lastMessageTimestamp: 1,
        handleSaveSession: () => waiting,
        send_message: (opts: unknown) => send_message.call(f.view as never, opts as never),
    });
    f.registry.openParentQuestion('r1', 'Jaki zakres?');
    await Promise.resolve();
    f.clock.advance(300000);
    f.registry.finish(f.task, { text: 'dorobek', toolsUsed: [], durationMs: 0, usage: null });
    resume();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    t.deepEqual({ questionMessages: f.window.messages.filter(m => m.questionId).length,
        pending: f.notifier.pendingNotices().map(n => n.kind === 'result' ? { kind: n.kind, taskId: n.task.id } : { kind: n.kind, taskId: n.question.taskId }) },
    { questionMessages: 0, pending: [{ kind: 'result', taskId: 'r1' }] });
});

test('dwa pytania nie uruchamiają równoległych tur', async t => {
    const f = fixture();
    t.teardown(() => { f.notifier.dispose(); f.registry.dispose(); });
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    let concurrent = 0;
    let maximum = 0;
    const delivered: string[] = [];
    Object.assign(f.view, { send_message: async (opts: { meta: Record<string, unknown>; questionDelivery: { claim: { ack(): void } } }) => {
        concurrent++;
        maximum = Math.max(maximum, concurrent);
        delivered.push(opts.meta.taskId as string);
        f.window.messages.push(opts.meta);
        opts.questionDelivery.claim.ack();
        if (delivered.length === 1) await waiting;
        concurrent--;
    } });
    f.registry.create({ id: 'r2', threadId: 's2', name: 'Drugi', origin: { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' }, background: true });
    f.registry.openParentQuestion('r1', 'Pierwsze?');
    f.registry.openParentQuestion('r2', 'Drugie?');
    await Promise.resolve();
    resume();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    f.notifier.drain();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    t.deepEqual({ maxConcurrentTurns: maximum, delivered }, { maxConcurrentTurns: 1, delivered: ['r1', 'r2'] });
});

test('wiadomość użytkownika nie odpowiada subowi', async t => {
    const f = fixture();
    t.teardown(() => { f.notifier.dispose(); f.registry.dispose(); });
    f.view.is_generating = true;
    Object.assign(f.view, {
        input_area: { value: 'Zmień priorytet' },
        _queueOwner: () => ({ agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' }),
        resetInputArea: () => {},
        _showQueuedIndicator: () => {},
    });
    const opened = f.registry.openParentQuestion('r1', 'Jaki zakres?');
    let answer: unknown = null;
    if (opened.kind === 'opened') void opened.resolution.then(result => { answer = result; });
    await send_message.call(f.view as never);
    t.deepEqual({ question: f.registry.getQuestionState('r1').kind, childAborted: Boolean(f.task.stopRequested), childAnswer: answer },
        { question: 'waiting', childAborted: false, childAnswer: null });
});
