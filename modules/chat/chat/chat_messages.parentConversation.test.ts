import test from 'ava';
import { RollingWindow } from './RollingWindow.js';
import { startEditMessage, addMessageActions, regenerateLastResponse } from './chat_messages.js';
import { send_message, _chatExecuteToolCall } from './chat_streaming.js';
import { parseActiveSession, formatSessionEvent } from '../../memory/activeSessionFormat.js';
import type { RollingMessage } from './RollingWindow.js';
import type { ExecuteToolCallOptions } from '../../tools/index.js';

for (const operation of ['edit', 'delete'] as const) {
    test.serial(`F4-1: ${operation} usuwa także wpisy starszego skrótu`, async t => {
        const rw = new RollingWindow();
        await rw.addMessage('user', 'Zostaje', { parentConversationText: 'Zostaje' });
        await rw.addMessage('user', 'USUNIĘTY SEKRET', { parentConversationText: 'USUNIĘTY SEKRET' });
        await rw.addMessage('assistant', 'Stara odpowiedź');
        for (let i = 0; i < 8; i++) await rw.addMessage('assistant', 'Dalsza odpowiedź');
        const view = { rollingWindow: rw, input_area: { value: '', focus() {} }, render_messages: async () => {}, updateTokenCounter() {} };
        if (operation === 'edit') startEditMessage.call(view as never, 1, 'USUNIĘTY SEKRET');
        else {
            const meta = createDiv();
            addMessageActions.call(view as never, meta, 'USUNIĘTY SEKRET', 'user', 1);
            const button = meta.children[1] as HTMLButtonElement;
            button.onclick!({ stopPropagation() {} } as MouseEvent);
        }
        await rw.addMessage('user', 'Bezpieczne pytanie', { parentConversationText: 'Bezpieczne pytanie' });
        const snapshot = rw.parentConversation.snapshot();
        t.is(snapshot.summary, operation === 'edit' ? '[1 user] Zostaje' : '[1 user] Zostaje\n[3 assistant] Stara odpowiedź\n[4 assistant] Dalsza odpowiedź');
        t.deepEqual(snapshot.messages.map(message => message.text), operation === 'edit'
            ? ['Bezpieczne pytanie'] : [...Array<string>(7).fill('Dalsza odpowiedź'), 'Bezpieczne pytanie']);
        t.false(JSON.stringify(snapshot).includes('USUNIĘTY SEKRET'));
    });
}

for (const legacy of [false, true]) {
    test.serial(`F4-2: PDF → ponowienie → prawdziwa wysyłka → delegacja, legacy=${legacy}`, async t => {
        const rw = new RollingWindow();
        await rw.addMessage('user', 'Pytanie\nTAJNY ZAŁĄCZNIK PDF', legacy ? {} : { parentConversationText: 'Pytanie' });
        await rw.addMessage('assistant', 'Stara odpowiedź');
        let captured: ExecuteToolCallOptions | undefined;
        let disk = '';
        let calls = 0;
        const agent = { name: 'Mira' };
        const tab = { agentName: 'Mira', sessionId: 'retry', sessionPath: 'a.md', sessionEpoch: 'epoch-a', isActive: true };
        const view = {
            leaf: { id: 'retry' }, rollingWindow: rw, input_area: { value: '' }, inputHistory: [],
            tokenTracker: { record() {} }, chatTabs: [tab], _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
            plugin: { agentManager: { getActiveAgent: () => agent, getAgentMemory: () => ({ activeSessionPath: 'a.md', sessionEpoch: 'epoch-a' }),
                getActiveSystemPromptWithMemory: async () => 'system' },
                mcpClient: { async executeToolCall(_call: unknown, _agent: string, opts: ExecuteToolCallOptions) { captured = opts; return { success: true }; } } },
            env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_max_iterations: 3, chat_stream_stall_timeout_ms: 0 } } } },
            render_messages: async () => {}, send_message, is_generating: false,
            set_generating(value: boolean) { this.is_generating = value; }, showTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
            async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
            async append_message(role: 'user', content: RollingMessage['content'], _display: unknown, meta: Partial<RollingMessage>) { await rw.addMessage(role, content, meta); },
            async appendToActiveSession(event: Record<string, unknown>) { disk += formatSessionEvent('user_message', event, '2026-11-05T00:00:00Z'); },
            get_chat_model: () => ({ providerId: 'openai', stream(_payload: unknown, cb: { done(value: unknown): void }) {
                cb.done({ choices: [{ message: calls++ === 0 ? { role: 'assistant', content: 'Deleguję', tool_calls: [
                    { id: 'd', function: { name: 'delegate', arguments: '{"task":"A","context_mode":"parent_conversation"}' } },
                ] } : { role: 'assistant', content: 'Gotowe' } }] });
            } }),
            _chatResolveTools: () => [{ type: 'function', function: { name: 'delegate', parameters: {} } }],
            _chatExecuteToolCall, _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
            _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {}, _isTurnActiveTab: () => false,
            _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
        };
        await regenerateLastResponse.call(view as never);
        t.deepEqual(captured?.parentConversation?.snapshot.messages.map(message => message.text), legacy ? ['Deleguję'] : ['Pytanie', 'Deleguję']);
        t.deepEqual(parseActiveSession(disk).messages.map(message => message.parentConversationText), [legacy ? undefined : 'Pytanie']);
        t.is(captured?.parentConversation?.snapshot.omittedMessages, legacy ? 1 : 0);
    });
}
