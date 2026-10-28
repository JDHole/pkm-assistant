import test from 'ava';
import { SubTaskNotifier, SubTaskRegistry } from '../../sub-agents/index.js';
import { QuestionTestClock } from '../../sub-agents/test-support/questionTestClock.js';
import { _chatExecuteToolCall, _deliverSubTaskQuestion, send_message, stop_all_turns } from './chat_streaming.js';
import { append_message } from './chat_messages.js';
import { RollingWindow } from './RollingWindow.js';
import streamingManager from './StreamingManager.js';
import { buildSubTaskResultDelivery } from './subTaskResultDelivery.js';
import { formatSessionEvent, parseActiveSession } from '../../memory/activeSessionFormat.js';

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

test('błąd renderowania po dopisaniu pytania nie dostarcza go drugi raz', async t => {
    const f = fixture();
    t.teardown(() => { f.notifier.dispose(); f.registry.dispose(); });
    const window = new RollingWindow();
    Object.assign(f.view, {
        rollingWindow: window,
        _preparingTurns: new Map(),
        append_message: (role: string, content: string, display: string | undefined, meta: unknown) =>
            append_message.call(f.view as never, role as never, content, display, meta as never),
        updateTokenCounter: () => { throw new Error('błąd renderowania'); },
        send_message: (opts: unknown) => send_message.call(f.view as never, opts as never),
    });
    f.registry.openParentQuestion('r1', 'Jaki zakres?');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    f.notifier.drain();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    t.is(window.messages.filter(message => message.questionId).length, 1);
    t.is(f.notifier.pendingNotices().length, 0);
    t.is(f.view._subTaskTurnPending, false);
});

function concurrentFixture() {
    const f = fixture();
    const a = new RollingWindow();
    const b = new RollingWindow();
    const tabB = { agentName: 'Jaskier', sessionPath: 'b.md', sessionEpoch: 'e2', sessionId: 'tab-b', isActive: false };
    const memory = { activeSessionPath: 's.md', sessionEpoch: 'e1', appendSessionEvent: async () => {} };
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const events: Array<{ path: string; event: unknown }> = [];
    memory.appendSessionEvent = async (path?: string, event?: unknown) => {
        events.push({ path: path || '', event });
        if (path === 's.md') { entered(); await waiting; }
    };
    let modelCalls = 0;
    const toolOwners: unknown[] = [];
    const model = { modelKey: 'fixture', stream(_payload: unknown, handlers: { done(response: unknown): void }) {
        modelCalls++;
        handlers.done({ choices: [{ message: modelCalls === 1
            ? { role: 'assistant', content: '', tool_calls: [{ id: 'b1', type: 'function', function: { name: 'list', arguments: '{}' } }] }
            : { role: 'assistant', content: 'Gotowe' } }] });
    } };
    const view = Object.assign(f.view, {
        leaf: { id: 'question-concurrent' }, chatTabs: [f.tab, tabB], rollingWindow: a,
        input_area: { value: '' }, inputHistory: [] as string[], tokenTracker: { record() {} },
        _preparingTurns: new Map(), _streamCtxMap: new Map(), _agentStates: new Map(),
        _questionAutoTurn: { kind: 'idle' } as { kind: string },
        plugin: { ...f.view.plugin, agentManager: { getActiveAgent: () => ({ name: 'Jaskier' }),
            getAgentMemory: () => memory, getActiveSystemPromptWithMemory: async () => 'system' },
            mcpClient: { async executeToolCall(_call: unknown, _agent: string, options: { origin: unknown }) { toolOwners.push(options.origin); return { success: true }; } } },
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
        append_message(role: 'user', content: string, _display: unknown, meta: object) { return this.rollingWindow.addMessage(role, content, meta); },
        async appendToActiveSession(event: unknown) { events.push({ path: memory.activeSessionPath, event }); },
        async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
        resetInputArea() { this.input_area.value = ''; }, set_generating(value: boolean) { f.view.is_generating = value; },
        showTypingIndicator() {}, _clearQueuedDrainTimer() {}, stop_generation() {},
        get_chat_model: () => model, _chatResolveTools: () => [{ type: 'function', function: { name: 'list', parameters: {} } }],
        _chatExecuteToolCall, _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
        _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {}, _isTurnActiveTab: () => false,
        _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
        send_message(opts: unknown) { return send_message.call(this as never, opts as never); },
    });
    return { ...f, view, a, b, tabB, memory, saving, release, events, toolOwners, modelCalls: () => modelCalls };
}

test.serial('zamknięcie podczas zapisu przyjętego pytania nie uruchamia modelu', async t => {
    const f = concurrentFixture();
    t.teardown(() => { f.release(); f.notifier.dispose(); f.registry.dispose(); streamingManager.stopStream('question-concurrent::Jaskier'); });
    f.registry.openParentQuestion('r1', 'Jaki zakres?');
    await f.saving;
    t.is(f.a.messages.filter(message => message.questionId).length, 1);
    stop_all_turns.call(f.view as never);
    f.release();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.deepEqual({ modelCalls: f.modelCalls(), toolCalls: f.toolOwners.length, preparing: f.view._preparingTurns.size,
        reservation: f.view._questionAutoTurn, pending: f.view._subTaskTurnPending },
    { modelCalls: 0, toolCalls: 0, preparing: 0, reservation: { kind: 'idle' }, pending: false });
});

test.serial('druga sesja tego samego agenta działa, gdy zapis pytania pierwszej czeka', async t => {
    const f = concurrentFixture();
    t.teardown(() => { f.release(); f.notifier.dispose(); f.registry.dispose(); streamingManager.stopStream('question-concurrent::Jaskier'); });
    f.registry.openParentQuestion('r1', 'Jaki zakres?');
    await f.saving;
    f.tab.isActive = false;
    f.tabB.isActive = true;
    f.memory.activeSessionPath = 'b.md';
    f.memory.sessionEpoch = 'e2';
    f.view.rollingWindow = f.b;
    f.view.input_area.value = 'Wiadomość do B';
    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    t.deepEqual({ calls: f.modelCalls(), toolOwners: f.toolOwners, b: f.b.messages[0]?.content,
        paths: f.events.map(item => item.path), preparing: [...f.view._preparingTurns.keys()] },
    { calls: 2, toolOwners: [{ agentName: 'Jaskier', sessionPath: 'b.md', sessionEpoch: 'e2', tabKey: 'tab-b' }],
        b: 'Wiadomość do B', paths: ['s.md', 'b.md'], preparing: ['tab'] });
    stop_all_turns.call(f.view as never);
    f.release();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.is(f.view._preparingTurns.size, 0);
});

test.serial('wynik z tła zapisuje terminalne pytanie czytelne bez rejestru', async t => {
    const f = concurrentFixture();
    t.teardown(() => { f.release(); f.notifier.dispose(); f.registry.dispose(); streamingManager.stopStream('question-concurrent::Jaskier'); });
    f.task.result = { text: 'Dorobek', toolsUsed: [], durationMs: 1, usage: null,
        question: { text: 'Jaki zakres?', resolution: { kind: 'no-answer' } } };
    const delivery = buildSubTaskResultDelivery(f.task, f.registry, 60000);
    await send_message.call(f.view as never, { injectedText: delivery.text, meta: delivery.meta });
    const event = f.events[0].event as Record<string, unknown>;
    const file = formatSessionEvent('user_message', event, '2026-10-28T12:00:00.000Z');
    const emptyRegistry = new SubTaskRegistry();
    t.teardown(() => emptyRegistry.dispose());
    t.deepEqual({ question: parseActiveSession(file).messages[0]?.question, tasks: emptyRegistry.list() },
        { question: { text: 'Jaki zakres?', resolution: { kind: 'no-answer' } }, tasks: [] });
});
