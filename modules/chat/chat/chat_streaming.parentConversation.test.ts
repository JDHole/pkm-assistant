import test from 'ava';
import { send_message, _chatExecuteToolCall } from './chat_streaming.js';
import { RollingWindow } from './RollingWindow.js';
import streamingManager from './StreamingManager.js';
import type { ExecuteToolCallOptions } from '../../tools/index.js';
import type { RollingMessage } from './RollingWindow.js';
import { AgentMemory } from '../../memory/index.js';
import { parseActiveSession, formatSessionEvent } from '../../memory/activeSessionFormat.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

for (const image of [false, true]) {
    test.serial(`P1: send_message zachowuje źródło przed PDF/image=${image} i wzmiankami; dwie zakładki i nowa epoka`, async t => {
        const started = deferred<void>();
        const executing = deferred<ExecuteToolCallOptions>();
        const held = deferred<{ success: boolean }>();
        const rw = new RollingWindow();
        const other = new RollingWindow();
        await other.addMessage('user', 'Rozmowa B', { parentConversationText: 'Rozmowa B' });
        const agent = { name: 'Mira' };
        const memory = { activeSessionPath: 'a.md', sessionEpoch: 'epoch-a' };
        const a = { agentName: 'Mira', sessionId: 'tab-a', sessionPath: 'a.md', sessionEpoch: 'epoch-a', isActive: true };
        const b = { agentName: 'Mira', sessionId: 'tab-b', sessionPath: 'b.md', sessionEpoch: 'epoch-b', isActive: false };
        let handlers!: { done(response: unknown): void };
        let calls = 0;
        let disk = '';
        const model = { modelKey: 'worker', providerId: 'ollama', stream(_payload: unknown, cb: typeof handlers) {
            if (calls++ === 0) { handlers = cb; started.resolve(); }
            else cb.done({ choices: [{ message: { role: 'assistant', content: 'Gotowe' } }] });
        } };
        const view = {
            leaf: { id: `p1-${image}` }, input_area: { value: 'Pytanie @notatka' }, inputHistory: [],
            rollingWindow: rw, tokenTracker: { record() {} }, chatTabs: [a, b],
            _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
            plugin: { agentManager: { getActiveAgent: () => agent, getAgentMemory: () => memory,
                getActiveMemory: () => { throw new Error('Nie wolno szukać aktywnej pamięci'); },
                getActiveSystemPromptWithMemory: async () => 'system' },
                mcpClient: { async executeToolCall(_call: unknown, _agent: string, options: ExecuteToolCallOptions) {
                    executing.resolve(options); return held.promise;
                } } },
            env: { settings: { pkmAssistant: { enableOczko: false, chat: { platform: 'global-other-provider' }, limits: { chat_max_iterations: 3, chat_stream_stall_timeout_ms: 0 } } } },
            attachmentManager: { hasAttachments: () => true, clear() {}, buildMessageContent(text: string) { return { content: image
                ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,TAJNY_OBRAZ' } }]
                : text + '\nTAJNY PDF' }; } },
            _isCurrentModelVision: () => true,
            is_generating: false, set_generating(value: boolean) { this.is_generating = value; },
            showTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
            async _resolveMentions() { return { displayText: 'Pytanie @[notatka]', contextText: 'TAJNA TREŚĆ PLIKU' }; },
            async append_message(role: 'user', content: RollingMessage['content'], _display: unknown, meta: Partial<RollingMessage>) { await rw.addMessage(role, content, meta); },
            async appendToActiveSession(event: Record<string, unknown>) { disk += formatSessionEvent('user_message', event, '2026-11-05T00:00:00Z'); },
            get_chat_model: () => model, _chatResolveTools: () => [{ type: 'function', function: { name: 'delegate', parameters: {} } }],
            _chatExecuteToolCall, _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
            _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {}, _isTurnActiveTab: () => false,
            _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
        };
        t.teardown(() => streamingManager.stopStream(`p1-${image}::tab-a`));
        const run = send_message.call(view as never, { meta: { origin: 'human' } });
        await started.promise;
        view.rollingWindow = other; a.isActive = false; b.isActive = true;
        memory.activeSessionPath = 'b.md'; memory.sessionEpoch = 'epoch-b';
        // Same window object can be reset for a new epoch. The turn retains its old projection.
        rw.clear(); a.sessionEpoch = 'new-epoch';
        await rw.addMessage('user', 'Nowa epoka', { parentConversationText: 'Nowa epoka' });
        handlers.done({ choices: [{ message: { role: 'assistant', content: 'Deleguję A.', reasoning_content: 'UKRYTE',
            tool_calls: [{ id: 'd', function: { name: 'delegate', arguments: '{"task":"Zadanie"}' } }] } }] });
        const options = await executing.promise;
        t.deepEqual(options.parentConversation, {
            source: 'lead', owner: { agentName: 'Mira', sessionPath: 'a.md', sessionEpoch: 'epoch-a', tabKey: 'tab-a' },
            turnId: image ? 2 : 1, providerId: 'ollama', snapshot: { messages: [
                { sequence: 1, role: 'user', text: 'Pytanie @notatka' },
                { sequence: 2, role: 'assistant', text: 'Deleguję A.' },
            ], summary: '', keptMessages: 2, summarizedMessages: 0, omittedMessages: 0, truncated: false },
        });
        await other.addMessage('assistant', 'Późna wiadomość B');
        t.deepEqual(parseActiveSession(disk).messages, [{ role: 'user', content: 'Pytanie @[notatka]', seq: null, parentConversationText: 'Pytanie @notatka' }]);
        held.resolve({ success: true });
        await run;
        t.deepEqual(options.parentConversation?.snapshot.messages, [
            { sequence: 1, role: 'user', text: 'Pytanie @notatka' }, { sequence: 2, role: 'assistant', text: 'Deleguję A.' },
        ]);
    });
}

test('P1: ogon autosave zachowuje osobny tekst źródłowy w formacie sesji', t => {
    const disk = AgentMemory.prototype._appendMessageAsEvent.call({ _nextSeq: () => 1 } as never, '', 'a.md',
        { role: 'user', content: 'Pytanie + PDF', parentConversationText: 'Pytanie' }, '2026-11-05T00:00:00Z');
    t.deepEqual(parseActiveSession(disk).messages, [{ role: 'user', content: 'Pytanie + PDF', seq: 1, parentConversationText: 'Pytanie' }]);
});
