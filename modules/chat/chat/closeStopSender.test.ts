import test from 'ava';
import { _closeActiveTab } from './chat_tabs.js';
import { stop_all_turns } from './chat_streaming.js';

const task = (id: string, tabKey: string, agentName: string) => ({ id, status: 'running', origin: { tabKey, agentName } });

test('zamknięcie zakładki zgłasza Stop suba jako system', async t => {
    const calls: Array<[string, string | undefined]> = [];
    const view = {
        chatTabs: [{ agentName: 'Jaskier', sessionId: 'sesja-A', isActive: true }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(),
        _agentStates: new Map(),
        plugin: { subTaskRegistry: {
            list: () => [task('sub/a#1', 'sesja-A', 'Jaskier'), task('sub/b#2', 'sesja-B', 'Jaskier')],
            requestStop: (id: string, by?: string) => { calls.push([id, by]); },
        } },
        rollingWindow: { messages: [] },
        _createRollingWindow: () => ({ messages: [] }),
        render_messages: () => {}, add_welcome_message: () => {}, updateTokenCounter: () => {}, _updateTokenPanel: () => {},
    };
    await _closeActiveTab.call(view as never);
    t.deepEqual(calls, [['sub/a#1', 'system']]);
});

test('zamknięcie czatu zgłasza Stop subów jako system', t => {
    const calls: Array<[string, string | undefined]> = [];
    const view = {
        chatTabs: [{ agentName: 'Jaskier', sessionId: 'sesja-A', isActive: true }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(),
        _clearQueuedDrainTimer: () => {},
        plugin: { subTaskRegistry: {
            list: () => [task('sub/a#1', 'sesja-A', 'Jaskier'), task('sub/b#2', 'sesja-B', 'Borys')],
            requestStop: (id: string, by?: string) => { calls.push([id, by]); },
        } },
    };
    t.deepEqual(stop_all_turns.call(view as never), []);
    t.deepEqual(calls, [['sub/a#1', 'system']]);
});
