import test from 'ava';
import { SubTaskRegistry } from '../../sub-agents/index.js';
import { stop_all_turns, stop_generation } from './chat_streaming.js';
import { _closeActiveTab } from './chat_tabs.js';

function queued(registry: SubTaskRegistry, id: string, tabKey: string, agentName: string) {
    return registry.createThread({ threadId: id, name: 'worker', owner: { agentName },
        origin: { agentName, tabKey }, config: {}, phase: 'queued' });
}

test('stop_generation zamyka queued aktywnej zakładki z nadawcą user', t => {
    const registry = new SubTaskRegistry();
    queued(registry, 'queued-active', 'tab-active', 'Jaskier');
    queued(registry, 'queued-other', 'tab-other', 'Borys');
    let stopRequests = 0;
    const view = {
        plugin: { subTaskRegistry: registry, agentManager: { getActiveAgent: () => ({ name: 'Jaskier' }) } },
        chatTabs: [{ agentName: 'Jaskier', sessionId: 'tab-active', isActive: true }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _drainSuppressed: false,
        input_area: { value: '' }, _queuedMessage: null, _clearQueuedDrainTimer() {}, _hideQueuedIndicator() {},
        _releaseStreamCtx() {}, _resetPaintTargets() {}, hideTypingIndicator() {},
        set_generating() {}, _renderThrottle: null, env: {},
    };
    const original = registry.requestStop.bind(registry);
    registry.requestStop = ((...args: Parameters<typeof registry.requestStop>) => { stopRequests++; return original(...args); }) as typeof registry.requestStop;

    stop_generation.call(view as never);

    t.is(registry.getThread('queued-active')?.phase, 'closed');
    t.is(registry.getThread('queued-active')?.closedBy, 'user');
    t.is(registry.getThread('queued-other')?.phase, 'queued');
    t.is(stopRequests, 0);
});

test('stop_all_turns zamyka queued bez aktywnej tury, ale nie idle innych sesji', t => {
    const registry = new SubTaskRegistry();
    queued(registry, 'queued-tab', 'tab-active', 'Jaskier');
    queued(registry, 'queued-other', 'tab-other', 'Borys');
    const idle = registry.createThread({ threadId: 'idle-other-session', name: 'worker',
        owner: { agentName: 'Borys', sessionPath: 'other.md', sessionEpoch: 'other' },
        origin: { agentName: 'Borys', tabKey: 'tab-other' }, config: {}, phase: 'idle' });
    const view = {
        plugin: { subTaskRegistry: registry }, chatTabs: [{ agentName: 'Jaskier', sessionId: 'tab-active', isActive: true }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _clearQueuedDrainTimer() {}, _queuedMessage: null,
    };

    stop_all_turns.call(view as never);

    t.is(registry.getThread('queued-tab')?.phase, 'closed');
    t.is(registry.getThread('queued-tab')?.closedBy, 'system');
    t.is(registry.getThread('queued-other')?.phase, 'queued');
    t.is(registry.getThread(idle.threadId)?.phase, 'idle');
});

test('stop_all_turns ze Stopem usera dopasowuje brak tabKey po właścicielu zakładki', t => {
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'queued-no-key', name: 'worker', owner: { agentName: 'Jaskier' },
        origin: { agentName: 'Jaskier' }, config: {}, phase: 'queued' });
    const view = { plugin: { subTaskRegistry: registry }, chatTabs: [{ agentName: 'Jaskier', sessionId: 'tab-active' }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _clearQueuedDrainTimer() {}, _queuedMessage: null };

    stop_all_turns.call(view as never, 'stop');

    t.is(registry.getThread('queued-no-key')?.phase, 'closed');
    t.is(registry.getThread('queued-no-key')?.closedBy, 'user');
});

test('watchdog nie zamyka queued, które należą do innej tury', t => {
    const registry = new SubTaskRegistry();
    queued(registry, 'queued-other', 'tab-other', 'Borys');
    const view = {
        plugin: { subTaskRegistry: registry, agentManager: { getActiveAgent: () => ({ name: 'Jaskier' }) } },
        chatTabs: [{ agentName: 'Jaskier', sessionId: 'tab-active', isActive: true }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _drainSuppressed: false,
        input_area: { value: '' }, _queuedMessage: null, _clearQueuedDrainTimer() {}, _hideQueuedIndicator() {},
        _releaseStreamCtx() {}, _resetPaintTargets() {}, hideTypingIndicator() {}, set_generating() {},
        _renderThrottle: null, env: {},
    };

    stop_generation.call(view as never, 'Jaskier', 'stall');

    t.is(registry.getThread('queued-other')?.phase, 'queued');
});

test('zamknięcie zakładki zamyka jej queued z nadawcą system przed usunięciem tożsamości', async t => {
    const registry = new SubTaskRegistry();
    queued(registry, 'queued-closing', 'tab-closing', 'Jaskier');
    queued(registry, 'queued-other', 'tab-other', 'Borys');
    const tab = { agentName: 'Jaskier', sessionId: 'tab-closing', isActive: true };
    const otherTab = { agentName: 'Borys', sessionId: 'tab-other', isActive: false };
    const view = {
        plugin: { subTaskRegistry: registry }, chatTabs: [tab, otherTab], rollingWindow: { messages: [] },
        _agentStates: new Map(), _streamCtxMap: new Map(), _preparingTurns: new Map(),
        _createRollingWindow: () => ({ messages: [] }), render_messages() {}, add_welcome_message() {},
        updateTokenCounter() {}, _updateTokenPanel() {},
        async _switchTab() {}, async handleSaveSession() {},
    };

    await _closeActiveTab.call(view as never);

    t.is(registry.getThread('queued-closing')?.phase, 'closed');
    t.is(registry.getThread('queued-closing')?.closedBy, 'system');
    t.is(registry.getThread('queued-other')?.phase, 'queued');
    t.deepEqual(view.chatTabs, [otherTab]);
});

test('zamknięcie aktywnego strumienia nie anuluje kolejki innej zakładki', async t => {
    const window = { messages: [] };
    const otherQueue = { text: 'Wiadomość B', meta: { origin: 'human' }, owner: { agentName: 'Borys', tabKey: 'tab-b' } };
    const view = {
        plugin: { agentManager: { getActiveAgent: () => ({ name: 'Jaskier' }) } },
        chatTabs: [{ agentName: 'Jaskier', sessionId: 'tab-a', isActive: true }, { agentName: 'Borys', sessionId: 'tab-b', isActive: false }],
        rollingWindow: window, _agentStates: new Map(), _preparingTurns: new Map(),
        _streamCtxMap: new Map([['Jaskier', { rollingWindow: window }]]), _queuedMessage: otherQueue,
        input_area: { value: 'Szkic A' }, _clearQueuedDrainTimer() {}, _hideQueuedIndicator() {},
        _releaseStreamCtx() {}, _resetPaintTargets() {}, hideTypingIndicator() {}, set_generating() {},
        _renderThrottle: null, env: {}, stop_generation, async _switchTab() {},
    };

    await _closeActiveTab.call(view as never);

    t.deepEqual(view._queuedMessage, otherQueue);
    t.is(view.input_area.value, 'Szkic A');
});
