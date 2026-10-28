import test from 'ava';
import { SubTaskNotifier, SubTaskRegistry } from '../../sub-agents/index.js';
import { QuestionTestClock } from '../../sub-agents/test-support/questionTestClock.js';
import { _chatExecuteToolCall, _deliverSubTaskQuestion, send_message, stop_all_turns, stop_generation, _releaseStreamCtx, _queueOwner, _clearQueuedDrainTimer, set_generating, _finalizeTurn } from './chat_streaming.js';
import { append_message } from './chat_messages.js';
import { _closeActiveTab, _initTabs, _switchTab } from './chat_tabs.js';
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
        showTypingIndicator() {}, hideTypingIndicator() {}, _hideQueuedIndicator() {}, _clearQueuedDrainTimer() {}, stop_generation() {},
        get_chat_model: () => model, _chatResolveTools: () => [{ type: 'function', function: { name: 'list', parameters: {} } }],
        _chatExecuteToolCall, _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
        _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {}, _isTurnActiveTab: () => false,
        _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
        send_message(opts: unknown) { return send_message.call(this as never, opts as never); },
    });
    return { ...f, view, a, b, tabB, memory, saving, release, events, toolOwners, modelCalls: () => modelCalls };
}

test.serial('zamknięcie odtworzonej zakładki anuluje kolejkę utworzoną bez zakładki', async t => {
    const f = concurrentFixture();
    t.teardown(() => { f.release(); f.notifier.dispose(); f.registry.dispose(); });
    const streamWindow = f.view.rollingWindow;
    Object.assign(f.view, {
        chatTabs: [], is_generating: true, input_area: { value: 'W kolejce' },
        _streamCtxMap: new Map([['Jaskier', { rollingWindow: streamWindow, abort: new AbortController() }]]),
        _queueOwner, _clearQueuedDrainTimer, _releaseStreamCtx, stop_generation,
        _showQueuedIndicator() {}, _hideQueuedIndicator() {}, handleInputResize() {},
        _resetPaintTargets() {}, hideTypingIndicator() {}, set_generating(value: boolean) { this.is_generating = value; },
        _createRollingWindow: () => new RollingWindow(), handleSaveSession: async () => {},
        render_messages() {}, add_welcome_message() {}, updateTokenCounter() {}, _updateTokenPanel() {},
    });

    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    t.deepEqual(_queueOwner.call(f.view as never), { agentName: '', tabKey: '' });
    t.is(f.view.input_area.value, '');
    _initTabs.call(f.view as never);
    await _closeActiveTab.call(f.view as never);

    t.deepEqual({ queue: (f.view as unknown as { _queuedMessage: unknown })._queuedMessage, input: f.view.input_area.value },
        { queue: null, input: 'W kolejce' });
});

test.serial('zamknięcie ostatniej zakładki podczas budowy promptu pozwala od razu wysłać kolejną wiadomość', async t => {
    const f = concurrentFixture();
    let resume!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const atPrompt = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    let answer = '';
    const model = { modelKey: 'close-preparing', stream(_payload: unknown, handlers: { done(response: unknown): void }) {
        calls++;
        handlers.done({ choices: [{ message: { role: 'assistant', content: 'Odpowiedź' } }] });
    } };
    Object.assign(f.view, {
        chatTabs: [f.tab],
        handleSaveSession: async () => {},
        _createRollingWindow: () => new RollingWindow(),
        render_messages() {}, add_welcome_message() {}, updateTokenCounter() {}, _updateTokenPanel() {},
        _hideQueuedIndicator() {}, _showQueuedIndicator() {}, _queueOwner: () => ({ agentName: 'Jaskier', tabKey: 'tab' }),
        _releaseStreamCtx, _resetPaintTargets() {}, hideTypingIndicator() {},
        stop_generation,
        get_chat_model: () => model, _chatResolveTools: () => [],
        _finalizeTurn(_turn: unknown, result: { finalText: string }) { answer = result.finalText; f.view.is_generating = false; },
    });
    let promptCalls = 0;
    f.view.plugin.agentManager.getActiveSystemPromptWithMemory = async () => {
        if (++promptCalls === 1) { entered(); await waiting; }
        return 'system';
    };
    t.teardown(() => { resume(); f.notifier.dispose(); f.registry.dispose(); streamingManager.stopStream('question-concurrent::Jaskier'); });
    f.view.input_area.value = 'Pierwsza';
    const first = send_message.call(f.view as never, { meta: { origin: 'human' } });
    await atPrompt;
    f.view.input_area.value = 'W kolejce';
    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    await _closeActiveTab.call(f.view as never);
    resume();
    await first;
    t.false(f.view.is_generating);
    t.is((f.view as unknown as { _queuedMessage: unknown })._queuedMessage, null);
    f.view.input_area.value = 'Nowa';
    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    t.deepEqual({ calls, answer, generating: f.view.is_generating }, { calls: 1, answer: 'Odpowiedź', generating: false });
});

test.serial('zamknięcie przygotowywanej B zachowuje i wysyła kolejkę generującej A', async t => {
    const f = concurrentFixture();
    let finishA!: () => void;
    let modelEntered!: () => void;
    let resumeB!: () => void;
    let promptEntered!: () => void;
    let queuedFinished!: () => void;
    const atModel = new Promise<void>(resolve => { modelEntered = resolve; });
    const atPrompt = new Promise<void>(resolve => { promptEntered = resolve; });
    const queuedDone = new Promise<void>(resolve => { queuedFinished = resolve; });
    const promptWait = new Promise<void>(resolve => { resumeB = resolve; });
    const payloads: unknown[] = [];
    const model = { modelKey: 'queue-owner', stream(payload: unknown, handlers: { done(response: unknown): void }) {
        payloads.push(payload);
        const done = () => handlers.done({ choices: [{ message: { role: 'assistant', content: 'Odpowiedź' } }] });
        if (payloads.length === 1) { finishA = done; modelEntered(); } else done();
    } };
    const oldWindow = globalThis.window;
    const oldDocument = globalThis.document;
    Object.assign(globalThis, { window: globalThis, document: { hasFocus: () => true } });
    Object.assign(f.view, {
        send_button: { addClass() {}, removeClass() {} }, stop_button: { addClass() {}, removeClass() {} },
        _queueOwner, _clearQueuedDrainTimer, set_generating, _finalizeTurn, _releaseStreamCtx,
        _isTurnActiveTab: (turn: { owner: { tab: unknown } }) => turn.owner.tab === f.view.chatTabs.find(tab => tab.isActive),
        _resetPaintTargets() {}, scrollToFinalMessage() {}, _scheduleConnectorRedraw() {},
        _ensureAgentMessageContainer() {}, current_message_text: { empty() {} },
        _updateAutonomyButton() {}, updatePermissionsBadge() {}, renderSkillButtons() {},
        updateTokenCounter() {}, _updateTokenPanel() {}, _getAgentRgb: () => '',
        _getDefaultAutonomy: () => 'supervised', _createRollingWindow: () => f.b, render_messages() {}, add_welcome_message() {},
        _showQueuedIndicator() {}, _drainSubTasks() {}, handleInputResize() {}, handleSaveSession: async () => {},
        _switchTab, get_chat_model: () => model, _chatResolveTools: () => [],
    });
    Object.assign(f.view.plugin, { showCrystalNotice() {} });
    Object.assign(f.view.input_area, { focus() {} });
    f.view.send_message = async opts => { await send_message.call(f.view as never, opts as never); queuedFinished(); };
    Object.assign(f.view.plugin.agentManager, { switchAgent() {} });
    f.view.plugin.agentManager.getActiveSystemPromptWithMemory = async () => {
        if (f.tabB.isActive) { promptEntered(); await promptWait; }
        return 'system';
    };
    let firstFinished = false;
    t.teardown(async () => {
        resumeB();
        f.release();
        if (!firstFinished) finishA?.();
        await first;
        f.notifier.dispose(); f.registry.dispose();
        streamingManager.stopStream('question-concurrent::Jaskier');
        Object.assign(globalThis, { window: oldWindow, document: oldDocument });
    });
    f.view.input_area.value = 'Pierwsza A';
    const first = send_message.call(f.view as never, { meta: { origin: 'human' } });
    await atModel;
    f.view.input_area.value = 'Kolejna A';
    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    await _switchTab.call(f.view as never, 'tab-b');
    f.view.input_area.value = 'Pierwsza B';
    const second = send_message.call(f.view as never, { meta: { origin: 'human' } });
    await atPrompt;
    f.view.input_area.value = 'Szkic B';
    await _closeActiveTab.call(f.view as never);
    t.is((f.view as unknown as { _queuedMessage: { text: string } | null })._queuedMessage?.text, 'Kolejna A');
    t.is(f.view.input_area.value, 'Szkic B');
    resumeB();
    await second;
    f.release();
    finishA();
    firstFinished = true;
    await first;
    await queuedDone;
    t.deepEqual(f.a.messages.filter(message => message.role === 'user').map(message => message.content), ['Pierwsza A', 'Kolejna A']);
    t.is(payloads.length, 2);
});

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

test.serial('zamknięcie przygotowywanej zakładki nie przerywa drugiej sesji agenta', async t => {
    const f = concurrentFixture();
    t.teardown(() => { f.release(); f.notifier.dispose(); f.registry.dispose(); streamingManager.stopStream('question-concurrent::Jaskier'); });
    f.registry.openParentQuestion('r1', 'Jaki zakres?');
    await f.saving;
    let stoppedOther = false;
    const otherStream = { rollingWindow: f.b, abort: { abort() { stoppedOther = true; } } };
    f.view._streamCtxMap.set('Jaskier', otherStream);
    Object.assign(f.view, {
        handleSaveSession: async () => {},
        _switchTab: async () => {
            f.tabB.isActive = true;
            f.memory.activeSessionPath = 'b.md';
            f.memory.sessionEpoch = 'e2';
            f.view.rollingWindow = f.b;
            f.view.is_generating = false;
        },
    });
    await _closeActiveTab.call(f.view as never);
    t.false(stoppedOther);
    t.is(f.view._streamCtxMap.get('Jaskier'), otherStream);
    f.view._streamCtxMap.delete('Jaskier');
    f.release();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.is(f.modelCalls(), 0);
    f.view.input_area.value = 'Wiadomość do B';
    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    t.deepEqual({ calls: f.modelCalls(), message: f.b.messages[0]?.content, owners: f.toolOwners },
        { calls: 2, message: 'Wiadomość do B', owners: [{ agentName: 'Jaskier', sessionPath: 'b.md', sessionEpoch: 'e2', tabKey: 'tab-b' }] });
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
