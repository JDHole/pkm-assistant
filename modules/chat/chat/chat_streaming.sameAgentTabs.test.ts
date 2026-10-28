import test from 'ava';
import { _restoreActiveSession, appendToActiveSession } from './chat_session.js';
import { _closeActiveTab, _initTabs, _switchTab } from './chat_tabs.js';
import { send_message, stop_generation, stop_all_turns, set_generating, _queueOwner, _clearQueuedDrainTimer, _isTurnActiveTab, _releaseStreamCtx, _finalizeTurn, _paintStreamFrame, _chatBeforeContinue, handle_error, _onStreamStall } from './chat_streaming.js';
import { queueChatMessage } from './queuedMessage.js';
import { AgentMemory } from '../../memory/index.js';
import streamingManager from './StreamingManager.js';
import { RollingWindow } from './RollingWindow.js';
import { RenderThrottle } from './renderThrottle.js';
import { applyPostArchiveAction } from '../slash-commands/save_session.js';

type Dynamic = any;

async function fixture() {
    (document as Dynamic).hasFocus = () => true;
    const events: Dynamic[] = [];
    const handlers: Dynamic[] = [];
    const stops = [0, 0];
    const agent = { name: 'Owner', emoji: 'O' };
    const memory: Dynamic = {
        activeSessionPath: 'a.md', sessionEpoch: null,
        listActiveSessions: async () => [{ path: 'a.md', name: 'a', mtime: 2 }, { path: 'b.md', name: 'b', mtime: 1 }],
        loadActiveSession: async (session: Dynamic) => ({ metadata: {}, messages: [{ role: 'user', content: `old ${session.name}` }] }),
        setActiveSessionIdentity(path: string) { this.activeSessionPath = path; },
        async _persistActiveSession() {},
        async appendSessionEvent(path: string, event: Dynamic) { events.push({ path, event }); },
    };
    const models = [0, 1].map(i => ({ modelKey: 'fake', stream(_payload: unknown, h: Dynamic) { handlers[i] = h; }, stopStream() { stops[i]++; } }));
    const modelOptions: Dynamic[] = [];
    const ctx: Dynamic = {
        leaf: { id: 'same-agent-test' }, input_area: { value: '' }, inputHistory: [], chatTabs: [],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
        plugin: { agentManager: { getAllAgents: () => [agent], getActiveAgent: () => agent, getAgentMemory: () => memory, switchAgent() {}, getActiveSystemPromptWithMemory: async () => 'system' }, showCrystalNotice() {} },
        env: { settings: { pkmAssistant: { enableOczko: false, enableAutoSummarization: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
        messages_container: { scrollTop: 0 }, is_generating: false,
        _createRollingWindow: () => new RollingWindow(), set_generating(v: boolean) { this.is_generating = v; },
        _getDefaultAutonomy: () => 'ask', _getAgentRgb: () => '', _updateAutonomyButton() {}, updatePermissionsBadge() {}, renderSkillButtons() {},
        updateTokenCounter() {}, _updateTokenPanel() {}, render_messages() {}, add_welcome_message() {},
        resetInputArea() { this.input_area.value = ''; },
        async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
        async append_message(role: 'user', content: string) { await this.rollingWindow.addMessage(role, content); },
        async appendToActiveSession() {}, showTypingIndicator() {}, hideTypingIndicator() {},
        get_chat_model: (options: Dynamic) => { modelOptions.push(options.skipCache); return options.skipCache ? models[1] : models[0]; }, _chatResolveTools: () => [],
        _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {}, _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {},
        handle_chunk(resp: Dynamic) { this.painted.push(resp.choices[0].delta.content); }, painted: [],
        handle_error(error: unknown) { throw error; }, _clearQueuedDrainTimer() {}, _hideQueuedIndicator() {}, _resetPaintTargets() {}, _scheduleConnectorRedraw() {}, scrollToFinalMessage() {},
    };
    ctx._isTurnActiveTab = _isTurnActiveTab.bind(ctx);
    ctx._releaseStreamCtx = _releaseStreamCtx.bind(ctx);
    ctx._finalizeTurn = _finalizeTurn.bind(ctx);
    ctx._switchTab = _switchTab.bind(ctx);
    ctx.stop_generation = stop_generation.bind(ctx);
    ctx.handleSaveSession = async () => {};
    return { ctx, events, handlers, modelOptions, stops, memory };
}

async function setup(differentAgents = false) {
    const { ctx, events, handlers, modelOptions, stops, memory } = await fixture();
    await _restoreActiveSession.call(ctx);
    const a = ctx.rollingWindow;
    ctx.input_area.value = 'question A';
    const runA = send_message.call(ctx);
    await waitFor(() => !!handlers[0]);
    if (differentAgents) {
        const agentB = { name: 'Agent B', emoji: 'B' };
        ctx.chatTabs.find((tab: Dynamic) => tab.sessionPath === 'b.md').agentName = agentB.name;
        ctx.plugin.agentManager.getActiveAgent = () => ctx.chatTabs.find((tab: Dynamic) => tab.isActive)?.agentName === agentB.name ? agentB : { name: 'Owner', emoji: 'O' };
    }
    await _switchTab.call(ctx, 'b.md');
    const b = ctx.rollingWindow;
    ctx.input_area.value = 'question B';
    const runB = send_message.call(ctx);
    await waitFor(() => !!handlers[1]);
    return { ctx, a, b, events, handlers, modelOptions, stops, memory, runA, runB };
}

async function waitFor(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    if (!predicate()) throw new Error('Model did not start');
}

function done(h: Dynamic, text: string) { h.done({ choices: [{ message: { content: text } }] }); }

function cleanupStreams() {
    streamingManager.stopStream('same-agent-test::a.md');
    streamingManager.stopStream('same-agent-test::b.md');
}

test.serial('tura bez zakładki po archive_close jest zatrzymywana po odtworzeniu widoku', async t => {
    for (const closeView of [false, true]) {
        const f = await fixture();
        await _restoreActiveSession.call(f.ctx);
        f.ctx.chatTabs = f.ctx.chatTabs.filter((tab: Dynamic) => tab.isActive);
        f.ctx._queueOwner = _queueOwner.bind(f.ctx);
        f.ctx._showQueuedIndicator = () => {};
        f.ctx.handleInputResize = () => {};
        await applyPostArchiveAction(f.ctx, {} as Dynamic, f.memory, { action: 'archive_close' } as Dynamic, 'a.md');
        t.is(f.ctx.chatTabs.length, 0);
        f.ctx.input_area.value = 'Pierwsza';
        const run = send_message.call(f.ctx, { meta: { origin: 'human' } });
        await waitFor(() => !!f.handlers[0]);
        const turn = f.ctx._streamCtxMap.get('');
        t.truthy(turn);
        t.is(turn.tab, null);
        f.ctx.input_area.value = 'W kolejce';
        await send_message.call(f.ctx, { meta: { origin: 'human' } });
        _initTabs.call(f.ctx);
        if (closeView) stop_all_turns.call(f.ctx, 'close');
        else await _closeActiveTab.call(f.ctx);
        const result = { aborted: turn.abort.isAborted(), generating: f.ctx.is_generating,
            queue: f.ctx._queuedMessage, input: f.ctx.input_area.value };
        done(f.handlers[0], 'przerwana');
        await run;
        streamingManager.stopStream('same-agent-test::Owner');
        t.deepEqual(result, { aborted: true, generating: false, queue: null, input: closeView ? '' : 'W kolejce' });
    }
});

async function prepareTablessTurn(restoreDuringPrompt: boolean) {
    const f = await fixture();
    await _restoreActiveSession.call(f.ctx);
    f.ctx.chatTabs = f.ctx.chatTabs.filter((tab: Dynamic) => tab.isActive);
    f.ctx._queueOwner = _queueOwner.bind(f.ctx);
    f.ctx._showQueuedIndicator = () => {};
    f.ctx.handleInputResize = () => {};
    await applyPostArchiveAction(f.ctx, {} as Dynamic, f.memory, { action: 'archive_close' } as Dynamic, 'a.md');
    let release!: (value: string) => void;
    f.ctx.plugin.agentManager.getActiveSystemPromptWithMemory = () => new Promise<string>(resolve => { release = resolve; });
    f.ctx.input_area.value = 'Pierwsza';
    const run = send_message.call(f.ctx, { meta: { origin: 'human' } });
    await waitFor(() => !!release);
    const pending = f.ctx._preparingTurns.get('');
    f.ctx.input_area.value = 'W kolejce';
    await send_message.call(f.ctx, { meta: { origin: 'human' } });
    if (restoreDuringPrompt) _initTabs.call(f.ctx);
    release('system');
    await waitFor(() => !!f.handlers[0]);
    return { ...f, run, pending, turn: f.ctx._streamCtxMap.get('') };
}

for (const closeView of [false, true]) {
    test.serial(`odtworzenie zakładki podczas budowy promptu: ${closeView ? 'zamknięcie widoku' : 'zamknięcie zakładki'}`, async t => {
        const f = await prepareTablessTurn(true);
        t.is(f.pending.tab, f.ctx.chatTabs[0]);
        t.is(f.turn.abort, f.pending.abort);
        if (closeView) stop_all_turns.call(f.ctx, 'close');
        else await _closeActiveTab.call(f.ctx);
        const actual = { aborted: f.turn.abort.isAborted(), size: f.ctx._streamCtxMap.size,
            generating: f.ctx.is_generating, queue: f.ctx._queuedMessage, input: f.ctx.input_area.value };
        done(f.handlers[0], 'przerwana');
        await f.run;
        streamingManager.stopStream('same-agent-test::Owner');
        t.deepEqual(actual, { aborted: true, size: 0, generating: false, queue: null, input: closeView ? '' : 'W kolejce' });
    });
}

test.serial('zamknięcie widoku z turą bez zakładki gasi generowanie', async t => {
    const f = await prepareTablessTurn(false);
    stop_all_turns.call(f.ctx, 'close');
    const actual = { aborted: f.turn.abort.isAborted(), size: f.ctx._streamCtxMap.size,
        generating: f.ctx.is_generating, queue: f.ctx._queuedMessage };
    done(f.handlers[0], 'przerwana');
    await f.run;
    streamingManager.stopStream('same-agent-test::Owner');
    t.deepEqual(actual, { aborted: true, size: 0, generating: false, queue: null });
});
test.serial('zamknięcie zakładki po archive_new anuluje kolejkę jej dawnej tury', async t => {
    const f = await fixture();
    await _restoreActiveSession.call(f.ctx);
    f.ctx._queueOwner = _queueOwner.bind(f.ctx);
    f.ctx._showQueuedIndicator = () => {};
    f.ctx.handleInputResize = () => {};
    f.memory.agentName = 'Owner';
    f.memory.startActiveSession = async () => 'new.md';
    f.ctx.input_area.value = 'Pierwsza';
    const run = send_message.call(f.ctx, { meta: { origin: 'human' } });
    await waitFor(() => !!f.handlers[0]);
    const turn = f.ctx._streamCtxMap.get('a.md');
    f.ctx.input_area.value = 'W kolejce';
    await send_message.call(f.ctx, { meta: { origin: 'human' } });
    t.is(f.ctx._queuedMessage.owner.tabKey, 'a.md');
    await applyPostArchiveAction(f.ctx, {} as Dynamic, f.memory, { action: 'archive_new' } as Dynamic, 'a.md');
    t.is(f.ctx.chatTabs.find((tab: Dynamic) => tab.isActive).sessionId, 'new.md');
    await _closeActiveTab.call(f.ctx);
    const result = { aborted: turn.abort.isAborted(), queue: f.ctx._queuedMessage, input: f.ctx.input_area.value };
    done(f.handlers[0], 'przerwana');
    await run;
    cleanupStreams();
    t.deepEqual(result, { aborted: true, queue: null, input: 'W kolejce' });
});

test.serial('obydwie odtworzone zakładki zachowują odpowiedzi i kończą generowanie', async t => {
    const f = await setup();
    t.is(f.handlers.length, 2, 'obie tury startują');
    await _switchTab.call(f.ctx, 'a.md');
    f.handlers[0].chunk({ choices: [{ delta: { content: 'chunk A' } }] });
    f.ctx._lastPaintedContent = 'answer A';
    done(f.handlers[0], 'answer A');
    await f.runA;
    await _switchTab.call(f.ctx, 'b.md');
    f.ctx._lastPaintedContent = 'answer B';
    done(f.handlers[1], 'answer B');
    await f.runB;
    cleanupStreams();
    t.deepEqual({ painted: f.ctx.painted, a: f.a.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content),
        events: f.events.filter(e => e.event.type === 'agent_message').map(e => [e.path, e.event.content]),
        b: f.b.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content),
        generatingA: f.ctx._agentStates.get('a.md').isGenerating, generatingB: f.ctx.is_generating },
    { painted: ['chunk A'], a: ['answer A'], events: [['a.md', 'answer A'], ['b.md', 'answer B']], b: ['answer B'], generatingA: false, generatingB: false });
});

test.serial('Stop na zakładce A zatrzymuje A, nie B', async t => {
    const f = await setup();
    await _switchTab.call(f.ctx, 'a.md');
    stop_generation.call(f.ctx);
    done(f.handlers[0], 'answer A');
    done(f.handlers[1], 'answer B');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(f.stops, [1, 0]);
    t.deepEqual(f.b.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer B']);
});

test.serial('Stop na zakładce B zatrzymuje B, nie A', async t => {
    const f = await setup();
    stop_generation.call(f.ctx);
    done(f.handlers[0], 'answer A');
    done(f.handlers[1], 'answer B');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(f.stops, [0, 1]);
    t.deepEqual(f.a.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer A']);
});

test.serial('B kończy przed A, a obie odpowiedzi trafiają do swoich sesji', async t => {
    const f = await setup();
    f.ctx._lastPaintedContent = 'answer B';
    done(f.handlers[1], 'answer B');
    await f.runB;
    done(f.handlers[0], 'answer A');
    await f.runA;
    cleanupStreams();
    t.deepEqual(f.a.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer A']);
    t.deepEqual(f.b.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer B']);
    t.deepEqual(f.events.filter(e => e.event.type === 'agent_message').map(e => [e.path, e.event.content]), [['b.md', 'answer B'], ['a.md', 'answer A']]);
    t.is(f.ctx.is_generating, false);
    t.is(f.ctx._agentStates.get('a.md').isGenerating, false);
});

test.serial('fragmenty malują się tylko w aktywnej zakładce w obu kierunkach', async t => {
    const f = await setup();
    f.handlers[0].chunk({ choices: [{ delta: { content: 'hidden A' } }] });
    f.handlers[1].chunk({ choices: [{ delta: { content: 'visible B' } }] });
    await _switchTab.call(f.ctx, 'a.md');
    f.handlers[1].chunk({ choices: [{ delta: { content: 'hidden B' } }] });
    f.handlers[0].chunk({ choices: [{ delta: { content: 'visible A' } }] });
    f.ctx._lastPaintedContent = 'answer A';
    done(f.handlers[0], 'answer A');
    done(f.handlers[1], 'answer B');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(f.ctx.painted, ['visible B', 'visible A']);
});

test.serial('zamknięcie B zatrzymuje B, a A nadal może zakończyć turę', async t => {
    const f = await setup();
    await _closeActiveTab.call(f.ctx);
    f.ctx._lastPaintedContent = 'answer A';
    done(f.handlers[1], 'answer B');
    done(f.handlers[0], 'answer A');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(f.stops, [0, 1]);
    t.deepEqual(f.ctx.chatTabs.map((tab: Dynamic) => tab.sessionPath), ['a.md']);
    t.deepEqual(f.a.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer A']);
});

test.serial('zmiana klucza zakładki podczas tury nie przekierowuje jej zapisu', async t => {
    const f = await setup();
    const tabA = f.ctx.chatTabs.find((tab: Dynamic) => tab.sessionPath === 'a.md');
    tabA.sessionId = 'new-a';
    tabA.sessionPath = 'new-a.md';
    f.ctx._lastPaintedContent = 'answer B';
    done(f.handlers[0], 'answer A');
    done(f.handlers[1], 'answer B');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(f.events.filter(e => e.event.type === 'agent_message').map(e => [e.path, e.event.content]), [['a.md', 'answer A'], ['b.md', 'answer B']]);
    t.deepEqual(f.a.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer A']);
    t.is(f.ctx._agentStates.get('a.md').isGenerating, false);
});

test.serial('Stop po zmianie klucza B zatrzymuje jej model, a A kończy', async t => {
    const f = await setup();
    const tabB = f.ctx.chatTabs.find((tab: Dynamic) => tab.isActive);
    tabB.sessionId = 'new-b';
    tabB.sessionPath = 'new-b.md';
    stop_generation.call(f.ctx);
    done(f.handlers[1], 'stopped B');
    done(f.handlers[0], 'answer A');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(f.modelOptions, [false, true], 'druga tura omija wspólny cache modelu');
    t.deepEqual(f.stops, [0, 1]);
    t.deepEqual(f.a.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer A']);
    t.deepEqual(f.b.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), []);
    t.deepEqual(f.events.filter(e => e.event.type === 'agent_message').map(e => [e.path, e.event.content]), [['a.md', 'answer A']]);
});

test.serial('stop_all_turns zatrzymuje obie tury i przygotowanie', async t => {
    const f = await setup();
    const { createTurnAbort } = await import('./turnAbort.js');
    const pending = createTurnAbort();
    f.ctx._preparingTurns.set('c.md', { tab: { agentName: 'Owner' }, rollingWindow: new RollingWindow(), abort: pending });
    const keys = stop_all_turns.call(f.ctx);
    done(f.handlers[0], 'A');
    done(f.handlers[1], 'B');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(keys, ['a.md', 'b.md', 'c.md']);
    t.deepEqual(f.stops, [1, 1]);
    t.is(pending.reason(), 'close');
});

test.serial('archive_new wymienia okno i stara tura zapisuje do starej sesji bez malowania', async t => {
    const f = await setup();
    const memory: Dynamic = { agentName: 'Owner', sessionEpoch: null, setActiveSessionIdentity() {}, async _persistActiveSession() {}, async startActiveSession() { return 'q.md'; } };
    await applyPostArchiveAction(f.ctx, {} as Dynamic, memory, { action: 'archive_new' } as Dynamic, 'b.md');
    f.handlers[1].chunk({ choices: [{ delta: { content: 'stary chunk B' } }] });
    done(f.handlers[1], 'odpowiedź B');
    done(f.handlers[0], 'odpowiedź A');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
    t.deepEqual(f.ctx.painted, []);
    t.deepEqual(f.ctx.rollingWindow.messages.map((m: Dynamic) => m.content), []);
    t.deepEqual(f.events.filter(e => e.event.type === 'agent_message').map(e => [e.path, e.event.content]), [['b.md', 'odpowiedź B'], ['a.md', 'odpowiedź A']]);
});

test.serial('tura B kończy w tle po zmianie klucza i nie zostawia generowania', async t => {
    const f = await setup();
    const tabB = f.ctx.chatTabs.find((tab: Dynamic) => tab.isActive);
    tabB.sessionId = 'new-b';
    tabB.sessionPath = 'new-b.md';
    await _switchTab.call(f.ctx, 'a.md');
    done(f.handlers[1], 'answer B');
    await f.runB;
    await _switchTab.call(f.ctx, 'new-b');
    t.is(f.ctx.rollingWindow, f.b);
    t.is(f.ctx.is_generating, false);
    t.deepEqual(f.b.messages.filter((m: Dynamic) => m.role === 'assistant').map((m: Dynamic) => m.content), ['answer B']);
    done(f.handlers[0], 'answer A');
    await f.runA;
    cleanupStreams();
});

test.serial('Stop maluje ostatnią oczekującą klatkę aktywnej zakładki', async t => {
    const f = await setup();
    f.ctx.current_message_container = {};
    f.ctx.current_message_text = { empty() {} };
    f.ctx.scrollToBottom = () => {};
    f.ctx._renderThrottle = new RenderThrottle({
        paint: frame => _paintStreamFrame.call(f.ctx, frame),
        schedule: () => 1,
        cancel: () => {},
    });
    f.ctx._renderThrottle.request({ text: 'ostatni fragment B', reasoning: '', owner: 'b.md' });
    stop_generation.call(f.ctx);
    t.is(f.ctx._lastPaintedContent, 'ostatni fragment B');
    done(f.handlers[1], 'stopped B');
    done(f.handlers[0], 'answer A');
    await Promise.all([f.runA, f.runB]);
    cleanupStreams();
});

test.serial('brakująca sesja zostaje zastąpiona wspólnym plikiem użytkownika i odpowiedzi', async t => {
    const f = await fixture();
    await _restoreActiveSession.call(f.ctx);
    const files: Record<string, string> = {};
    const folders = new Set<string>();
    const adapter = {
        async exists(path: string) { return path in files || folders.has(path); },
        async mkdir(path: string) { folders.add(path); },
        async read(path: string) { if (!(path in files)) throw new Error(`missing: ${path}`); return files[path]; },
        async write(path: string, content: string) { files[path] = content; },
        async remove(path: string) { delete files[path]; },
        async list(path: string) { return { files: Object.keys(files).filter(p => p.startsWith(`${path}/`)), folders: [...folders].filter(p => p.startsWith(`${path}/`)) }; },
        async stat(path: string) { return path in files ? { mtime: 1 } : null; },
    };
    const memory = new AgentMemory({ adapter } as never, 'Owner');
    await memory.appendToActiveSession({ type: 'user_message', content: 'Stara sesja' });
    const oldPath = '.pkm-assistant/agents/owner/memory/sessions/active/nieistniejąca.md';
    memory.setActiveSessionIdentity(oldPath, null);
    const tab = f.ctx.chatTabs.find((item: Dynamic) => item.isActive);
    tab.sessionPath = oldPath;
    tab.sessionEpoch = memory.sessionEpoch;
    f.ctx.plugin.agentManager.getAgentMemory = () => memory;
    f.ctx.appendToActiveSession = appendToActiveSession.bind(f.ctx);
    f.ctx.input_area.value = 'Pytanie do nowej sesji';
    const run = send_message.call(f.ctx);
    await waitFor(() => !!f.handlers[0]);
    f.ctx._lastPaintedContent = 'Odpowiedź w nowej sesji';
    done(f.handlers[0], 'Odpowiedź w nowej sesji');
    await run;
    cleanupStreams();
    const path = memory.activeSessionPath ?? '';
    const content = await adapter.read(path);
    t.not(path, oldPath);
    t.is(content.includes('Pytanie do nowej sesji'), true);
    t.is(content.includes('Odpowiedź w nowej sesji'), true);
    t.deepEqual(Object.entries(files).filter(([p, value]) => p !== path && value.includes('Odpowiedź w nowej sesji')).map(([p]) => p), []);
});

test.serial('restore przerywa przygotowanie przed wymianą zakładki i Stopem', async t => {
    const f = await fixture();
    await _restoreActiveSession.call(f.ctx);
    const oldTab = f.ctx.chatTabs.find((item: Dynamic) => item.isActive);
    let release!: (value: string) => void;
    f.ctx.plugin.agentManager.getActiveSystemPromptWithMemory = () => new Promise<string>(resolve => { release = resolve; });
    f.ctx.input_area.value = 'Pytanie podczas restore';
    const run = send_message.call(f.ctx);
    await waitFor(() => !!release);
    const pending = [...f.ctx._preparingTurns.values()][0] as Dynamic;
    await _restoreActiveSession.call(f.ctx);
    stop_generation.call(f.ctx);
    const aborted = pending.abort.signal.aborted;
    release('system');
    let finished = false;
    void run.then(() => { finished = true; });
    await waitFor(() => finished || !!f.handlers[0]);
    if (f.handlers[0]) done(f.handlers[0], 'Odpowiedź po błędnym Stopie');
    await run;
    cleanupStreams();
    t.not(f.ctx.chatTabs.find((item: Dynamic) => item.isActive), oldTab);
    t.deepEqual({ aborted, modelCalls: f.modelOptions.length, streams: f.ctx._streamCtxMap.size, preparing: f.ctx._preparingTurns.size, generating: f.ctx.is_generating },
        { aborted: true, modelCalls: 0, streams: 0, preparing: 0, generating: false });
});

test.serial('kolejka B dociera do okna i sesji B po zakończeniu jej tury', async t => {
    const f = await setup();
    const button = { addClass() {}, removeClass() {} };
    f.ctx.send_button = button;
    f.ctx.stop_button = button;
    f.ctx.input_area.focus = () => {};
    f.ctx.handleInputResize = () => {};
    f.ctx._clearQueuedDrainTimer = _clearQueuedDrainTimer.bind(f.ctx);
    f.ctx._queueOwner = () => ({ agentName: 'Owner', tabKey: 'b.md' });
    f.ctx._drainSubTasks = () => {};
    f.ctx.send_message = send_message.bind(f.ctx);
    f.ctx.set_generating = set_generating.bind(f.ctx);
    f.ctx.appendToActiveSession = async (event: Dynamic) => { f.events.push({ path: f.ctx.chatTabs.find((tab: Dynamic) => tab.isActive).sessionPath, event }); };
    f.ctx._queuedMessage = queueChatMessage('Tylko dla B', { origin: 'human' }, { agentName: 'Owner', tabKey: 'b.md' });
    await _chatBeforeContinue.call(f.ctx, { rw: f.a, agentName: 'Owner', origin: { tabKey: 'a.md', sessionPath: 'a.md' }, owner: { memory: f.memory }, responseRecorded: true, lastRoundToolResults: [] } as Dynamic, 0);
    t.is(f.ctx._queuedMessage.text, 'Tylko dla B');
    const previous = f.handlers[1];
    f.ctx._lastPaintedContent = 'Pierwsza odpowiedź B';
    done(previous, 'Pierwsza odpowiedź B');
    await f.runB;
    await waitFor(() => f.handlers[1] !== previous);
    t.deepEqual(f.b.messages.filter((m: Dynamic) => m.content === 'Tylko dla B').map((m: Dynamic) => [m.role, m.content]), [['user', 'Tylko dla B']]);
    t.deepEqual(f.a.messages.filter((m: Dynamic) => m.content === 'Tylko dla B').map((m: Dynamic) => m.content), []);
    t.deepEqual(f.events.filter(e => e.event.content === 'Tylko dla B').map(e => [e.path, e.event.type, e.event.content]), [['b.md', 'user_message', 'Tylko dla B']]);
    f.ctx._lastPaintedContent = 'Odpowiedź na kolejkę B';
    done(f.handlers[1], 'Odpowiedź na kolejkę B');
    done(f.handlers[0], 'Odpowiedź A');
    await f.runA;
    await waitFor(() => f.ctx._streamCtxMap.size === 0);
    cleanupStreams();
});

async function archiveNew(f: Dynamic) {
    await applyPostArchiveAction(f.ctx, {} as Dynamic, f.memory, { action: 'archive_new' } as Dynamic, 'b.md');
}

function enableDrain(f: Dynamic) {
    const classes = new Set<string>();
    const button = { addClass(c: string) { classes.add(c); }, removeClass(c: string) { classes.delete(c); } };
    f.ctx.send_button = button; f.ctx.stop_button = button;
    f.ctx.input_area.focus = () => {}; f.ctx.handleInputResize = () => {};
    f.ctx._clearQueuedDrainTimer = _clearQueuedDrainTimer.bind(f.ctx);
    f.ctx._queueOwner = () => { const tab = f.ctx.chatTabs.find((x: Dynamic) => x.isActive); return { agentName: tab.agentName, tabKey: tab.sessionId }; };
    f.ctx._showQueuedIndicator = () => { f.ctx.indicatorVisible = true; };
    f.ctx._hideQueuedIndicator = () => { f.ctx.indicatorVisible = false; };
    f.ctx._drainSubTasks = () => {};
    f.ctx.send_message = send_message.bind(f.ctx); f.ctx.set_generating = set_generating.bind(f.ctx);
    f.ctx.appendToActiveSession = async (event: Dynamic) => { f.events.push({ path: f.ctx.chatTabs.find((tab: Dynamic) => tab.isActive).sessionPath, event }); };
    f.memory.startActiveSession = async () => { f.memory.activeSessionPath = 'q.md'; return 'q.md'; };
    return classes;
}

function stallTurn(f: Dynamic, key: string) {
    const live = f.ctx._streamCtxMap.get(key);
    return { agentName: live.agentName, agent: live.agent, owner: { tab: live.tab }, rw: live.rollingWindow,
        origin: { tabKey: key }, turnId: live.turnId, abort: live.abort };
}

for (const differentAgents of [true, false]) {
    test.serial(`kolejka B po watchdogu A dociera do B i zachowuje szkic: ${differentAgents ? 'różni agenci' : 'ten sam agent'}`, async t => {
        const f = await setup(differentAgents); enableDrain(f);
        _onStreamStall.call(f.ctx, stallTurn(f, 'a.md') as Dynamic, 1000);
        f.ctx.input_area.value = 'Nowe polecenie B po watchdogu A'; await send_message.call(f.ctx);
        f.ctx.input_area.value = 'Szkic użytkownika B';
        const oldHandlers = [...f.handlers];
        f.ctx._lastPaintedContent = 'Pierwsza odpowiedź B'; done(f.handlers[1], 'Pierwsza odpowiedź B');
        await f.runB;
        await new Promise(resolve => setTimeout(resolve, 250));
        const actual = {
            messages: f.b.messages.filter((m: Dynamic) => m.content === 'Nowe polecenie B po watchdogu A').map((m: Dynamic) => [m.role, m.content]),
            events: f.events.filter((e: Dynamic) => e.event.content === 'Nowe polecenie B po watchdogu A').map((e: Dynamic) => [e.path, e.event.type, e.event.content]),
            draft: f.ctx.input_area.value, calls: f.modelOptions.length,
        };
        const newHandler = f.handlers.find((h: Dynamic, i: number) => h !== oldHandlers[i]);
        if (newHandler) { f.ctx._lastPaintedContent = 'Odpowiedź na kolejkę'; done(newHandler, 'Odpowiedź na kolejkę'); await waitFor(() => f.ctx._streamCtxMap.size === 0); }
        await f.runA; cleanupStreams();
        t.deepEqual(actual, { messages: [['user', 'Nowe polecenie B po watchdogu A']],
            events: [['b.md', 'user_message', 'Nowe polecenie B po watchdogu A']], draft: 'Szkic użytkownika B', calls: 3 });
    });
}

for (const draft of ['', 'Szkic']) {
    test.serial(`Stop anuluje kolejkę i zachowuje pole: ${draft || 'puste'}`, async t => {
        const f = await fixture(); await _restoreActiveSession.call(f.ctx); enableDrain(f);
        f.ctx.input_area.value = 'P'; const run = send_message.call(f.ctx); await waitFor(() => !!f.handlers[0]);
        f.ctx.input_area.value = 'Dla Q'; await send_message.call(f.ctx);
        f.ctx.input_area.value = draft;
        let fired = false; f.ctx._queuedDrainTimer = window.setTimeout(() => { fired = true; }, 100);
        stop_generation.call(f.ctx);
        await new Promise(resolve => setTimeout(resolve, 150));
        const actual = { queue: f.ctx._queuedMessage ?? null, input: f.ctx.input_area.value,
            indicator: f.ctx.indicatorVisible, timer: f.ctx._queuedDrainTimer, fired, calls: f.modelOptions.length };
        await run; cleanupStreams();
        t.deepEqual(actual, { queue: null, input: draft || 'Dla Q', indicator: false, timer: null, fired: false, calls: 1 });
    });
}

test.serial('watchdog P po archive_new nie wysyła kolejki Q', async t => {
    const f = await fixture(); await _restoreActiveSession.call(f.ctx); enableDrain(f);
    f.ctx.input_area.value = 'P'; const run = send_message.call(f.ctx); await waitFor(() => !!f.handlers[0]);
    const turn = stallTurn(f, 'a.md'); await archiveNew(f);
    f.ctx.input_area.value = 'Dla Q'; await send_message.call(f.ctx);
    _onStreamStall.call(f.ctx, turn as Dynamic, 1000);
    await new Promise(resolve => setTimeout(resolve, 250));
    const actual = { calls: f.modelOptions.length, queue: f.ctx._queuedMessage ?? null, input: f.ctx.input_area.value,
        suppressed: f.ctx._drainSuppressed, generating: f.ctx.is_generating,
        indicator: f.ctx.indicatorVisible, timer: f.ctx._queuedDrainTimer ?? null };
    if (f.modelOptions.length > 1) {
        f.ctx._lastPaintedContent = 'Q'; done(f.handlers[0], 'Q');
        await waitFor(() => f.ctx._streamCtxMap.size === 0);
    }
    await run; cleanupStreams();
    t.deepEqual(actual, { calls: 1, queue: null, input: 'Dla Q', suppressed: true, generating: false, indicator: false, timer: null });
});

test.serial('watchdog P zachowuje kolejkę żywej Q na tym samym obiekcie zakładki', async t => {
    const f = await fixture(); await _restoreActiveSession.call(f.ctx); enableDrain(f);
    f.ctx.input_area.value = 'P'; const runP = send_message.call(f.ctx); await waitFor(() => !!f.handlers[0]);
    const turn = stallTurn(f, 'a.md'); await archiveNew(f);
    // Stan przejściowy po powrocie z bezczynnej zakładki, przed przywróceniem flagi Q.
    f.ctx.is_generating = false;
    const q = f.ctx.rollingWindow;
    f.ctx.input_area.value = 'Pytanie Q'; const runQ = send_message.call(f.ctx); await waitFor(() => !!f.handlers[1]);
    f.ctx.input_area.value = 'Kolejka żywej Q'; await send_message.call(f.ctx);
    f.ctx.input_area.value = 'Szkic Q';
    _onStreamStall.call(f.ctx, turn as Dynamic, 1000);
    f.ctx._lastPaintedContent = 'Odpowiedź Q'; done(f.handlers[1], 'Odpowiedź Q'); await runQ;
    await new Promise(resolve => setTimeout(resolve, 250));
    const actual = { messages: q.messages.filter((m: Dynamic) => m.content === 'Kolejka żywej Q').map((m: Dynamic) => [m.role, m.content]),
        events: f.events.filter((e: Dynamic) => e.event.content === 'Kolejka żywej Q').map((e: Dynamic) => [e.path, e.event.type, e.event.content]),
        draft: f.ctx.input_area.value, calls: f.modelOptions.length };
    if (f.modelOptions.length === 3) { f.ctx._lastPaintedContent = 'Odpowiedź na kolejkę'; done(f.handlers[0], 'Odpowiedź na kolejkę'); await waitFor(() => f.ctx._streamCtxMap.size === 0); }
    await runP; cleanupStreams();
    t.deepEqual(actual, { messages: [['user', 'Kolejka żywej Q']], events: [['q.md', 'user_message', 'Kolejka żywej Q']], draft: 'Szkic Q', calls: 3 });
});

test.serial('watchdog starego okna nie anuluje kolejki innej zakładki', async t => {
    const f = await fixture(); await _restoreActiveSession.call(f.ctx); enableDrain(f);
    f.ctx.input_area.value = 'P'; const run = send_message.call(f.ctx); await waitFor(() => !!f.handlers[0]);
    const turn = stallTurn(f, 'a.md'); await archiveNew(f);
    f.ctx._queuedMessage = queueChatMessage('Dla B', { origin: 'human' }, { agentName: 'Owner', tabKey: 'b.md' });
    _onStreamStall.call(f.ctx, turn as Dynamic, 1000);
    await new Promise(resolve => setTimeout(resolve, 150));
    const actual = { text: f.ctx._queuedMessage?.text, input: f.ctx.input_area.value, calls: f.modelOptions.length };
    await run; cleanupStreams();
    t.deepEqual(actual, { text: 'Dla B', input: '', calls: 1 });
});

for (const path of ['handle_error', 'watchdog'] as const) {
    test.serial(`${path} w tle zwalnia tylko swoją turę`, async t => {
        const f = await setup(); const liveA = f.ctx._streamCtxMap.get('a.md'); const liveB = f.ctx._streamCtxMap.get('b.md');
        if (path === 'handle_error') handle_error.call(f.ctx, new Error('błąd A'), 'Owner', liveA.turnId, 'a.md');
        else _onStreamStall.call(f.ctx, stallTurn(f, 'a.md') as Dynamic, 1000);
        const registeredA = f.ctx._streamCtxMap.has('a.md'); const registeredB = f.ctx._streamCtxMap.get('b.md') === liveB;
        const generatingB = f.ctx.is_generating;
        await _switchTab.call(f.ctx, 'a.md'); const generatingA = f.ctx.is_generating;
        f.ctx._lastPaintedContent = 'A';
        done(f.handlers[0], 'A'); done(f.handlers[1], 'B'); await Promise.all([f.runA, f.runB]); cleanupStreams();
        t.deepEqual({ registeredA, registeredB, generatingA, generatingB },
            { registeredA: false, registeredB: true, generatingA: false, generatingB: true });
    });
}

test.serial('archive_new i Stop przerywają turę w locie', async t => {
    const f = await setup();
    enableDrain(f);
    const live = f.ctx._streamCtxMap.get('b.md');
    await archiveNew(f);
    stop_generation.call(f.ctx);
    const actual = { aborted: live.abort.signal.aborted, stops: f.stops[1], registered: f.ctx._streamCtxMap.has('b.md'), generating: f.ctx.is_generating };
    done(f.handlers[1], 'B'); done(f.handlers[0], 'A'); await Promise.all([f.runA, f.runB]); cleanupStreams();
    t.deepEqual(actual, { aborted: true, stops: 1, registered: false, generating: false });
});

test.serial('archive_new i Stop przerywają przygotowanie', async t => {
    const f = await fixture(); await _restoreActiveSession.call(f.ctx); enableDrain(f);
    let release!: (value: string) => void;
    f.ctx.plugin.agentManager.getActiveSystemPromptWithMemory = () => new Promise<string>(resolve => { release = resolve; });
    f.ctx.input_area.value = 'Pytanie'; const run = send_message.call(f.ctx); await waitFor(() => !!release);
    const pending = [...f.ctx._preparingTurns.values()][0] as Dynamic;
    await archiveNew(f); stop_generation.call(f.ctx); const aborted = pending.abort.signal.aborted;
    release('system'); let finished = false; void run.then(() => { finished = true; });
    await waitFor(() => finished || !!f.handlers[0]);
    if (f.handlers[0]) done(f.handlers[0], 'Błędna odpowiedź');
    await run; cleanupStreams();
    t.deepEqual({ aborted, modelCalls: f.modelOptions.length, generating: f.ctx.is_generating }, { aborted: true, modelCalls: 0, generating: false });
});

test.serial('błąd przygotowania zwalnia stan po archive_new', async t => {
    const f = await fixture(); await _restoreActiveSession.call(f.ctx); enableDrain(f);
    let reject!: (error: Error) => void;
    f.ctx.plugin.agentManager.getActiveSystemPromptWithMemory = () => new Promise<string>((_resolve, fail) => { reject = fail; });
    f.ctx.input_area.value = 'Pytanie'; const run = send_message.call(f.ctx); await waitFor(() => !!reject);
    await archiveNew(f); reject(new Error('błąd promptu'));
    await t.throwsAsync(run, { message: 'błąd promptu' });
    t.is(f.ctx._preparingTurns.size, 0); t.false(f.ctx.is_generating);
});

test.serial('archive_new drenuje wiadomość Q po końcu obu starych tur', async t => {
    const f = await setup(); enableDrain(f); await archiveNew(f);
    const q = f.ctx.rollingWindow; f.ctx.input_area.value = 'Dla nowej Q'; await send_message.call(f.ctx);
    done(f.handlers[0], 'A'); done(f.handlers[1], 'B'); await Promise.all([f.runA, f.runB]);
    const previous = f.handlers[0];
    await new Promise(resolve => setTimeout(resolve, 250));
    const actual = { messages: q.messages.filter((m: Dynamic) => m.content === 'Dla nowej Q').map((m: Dynamic) => [m.role, m.content]), events: f.events.filter((e: Dynamic) => e.event.content === 'Dla nowej Q').map((e: Dynamic) => [e.path, e.event.type]), queue: f.ctx._queuedMessage ?? null };
    if (f.handlers[0] !== previous) { f.ctx._lastPaintedContent = 'Q'; done(f.handlers[0], 'Q'); await waitFor(() => f.ctx._streamCtxMap.size === 0); }
    cleanupStreams();
    t.deepEqual(actual, { messages: [['user', 'Dla nowej Q']], events: [['q.md', 'user_message']], queue: null });
    t.false(f.ctx.is_generating);
});

test.serial('archive_new po końcu jedynej tury zhasza Stop', async t => {
    const f = await fixture(); await _restoreActiveSession.call(f.ctx); const classes = enableDrain(f);
    f.ctx.input_area.value = 'P'; const run = send_message.call(f.ctx); await waitFor(() => !!f.handlers[0]);
    await archiveNew(f); done(f.handlers[0], 'P'); await run; cleanupStreams();
    t.deepEqual({ generating: f.ctx.is_generating, hidden: classes.has('hidden') }, { generating: false, hidden: true });
});

test.serial('archive_new w tle przywraca stan Q po powrocie', async t => {
    const f = await setup(); enableDrain(f); await archiveNew(f); await _switchTab.call(f.ctx, 'a.md');
    done(f.handlers[1], 'B'); await f.runB; await _switchTab.call(f.ctx, 'q.md');
    const generating = f.ctx.is_generating; done(f.handlers[0], 'A'); await f.runA; cleanupStreams();
    t.false(generating);
});

test.serial('kolejka zgodnego właściciela trafia do jego trwającej tury', async t => {
    const f = await fixture(); await _restoreActiveSession.call(f.ctx);
    const a = f.ctx.rollingWindow; let first: Dynamic; let second: Dynamic; let snapshot: Dynamic;
    f.ctx._chatBeforeContinue = _chatBeforeContinue.bind(f.ctx);
    f.ctx._chatResolveTools = () => [{ type: 'function', function: { name: 'test_tool', parameters: {} } }];
    f.ctx._chatExecuteToolCall = async () => 'wynik';
    f.ctx.get_chat_model = () => ({ modelKey: 'fake', stream(_payload: Dynamic, handlers: Dynamic) {
        if (!first) first = handlers;
        else { second = handlers; snapshot = { messages: a.messages.filter((m: Dynamic) => m.content === 'Wiadomość do tury A').map((m: Dynamic) => [m.role, m.content]), events: f.events.filter((e: Dynamic) => e.event.content === 'Wiadomość do tury A').map((e: Dynamic) => [e.path, e.event.type]), queue: f.ctx._queuedMessage }; }
    }, stopStream() {} });
    f.ctx.input_area.value = 'Pytanie A'; const run = send_message.call(f.ctx); await waitFor(() => !!first);
    f.ctx._queuedMessage = queueChatMessage('Wiadomość do tury A', { origin: 'human' }, { agentName: 'Owner', tabKey: 'a.md' });
    await _switchTab.call(f.ctx, 'b.md');
    first.done({ choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }] } }] });
    await waitFor(() => !!second); done(second, 'A'); await run; cleanupStreams();
    t.deepEqual(snapshot, { messages: [['user', 'Wiadomość do tury A']], events: [['a.md', 'user_message']], queue: null });
});
