import test from 'ava';
import { _isTurnActiveTab, _chatBeforeContinue } from './chat_streaming.js';
import { RollingWindow } from './RollingWindow.js';
import { queueChatMessage } from './queuedMessage.js';

type Dynamic = any;

test('tura starego okna nie jest aktywna po wymianie rozmowy', t => {
    const tab = { agentName: 'A', isActive: true };
    const old = new RollingWindow();
    const view: Dynamic = { chatTabs: [tab], rollingWindow: new RollingWindow(), _streamCtxMap: new Map() };
    t.is(_isTurnActiveTab.call(view, { owner: { tab }, rw: old, origin: { tabKey: 'a' }, agentName: 'A' } as Dynamic), false);
});

test('tura A nie pobiera kolejki zakładki B', async t => {
    const rw = new RollingWindow();
    const events: Dynamic[] = [];
    const view: Dynamic = { _isTurnActiveTab: () => false, _queuedMessage: queueChatMessage('Tylko dla B', { origin: 'human' }, { agentName: 'A', tabKey: 'b.md' }), env: { settings: { pkmAssistant: {} } } };
    const turn: Dynamic = { rw, agentName: 'A', origin: { tabKey: 'a.md', sessionPath: 'a.md' }, owner: { memory: { appendSessionEvent: async (path: string, event: Dynamic) => events.push([path, event]) } }, responseRecorded: true, lastRoundToolResults: [] };
    await _chatBeforeContinue.call(view, turn, 0);
    t.deepEqual([rw.messages.map(m => m.content), view._queuedMessage?.text], [[], 'Tylko dla B']);
});
