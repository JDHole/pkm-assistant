import { commitMessageEdit } from './messageEdit.js';
import test from 'ava';
import { RollingWindow } from './RollingWindow.js';
import { startEditMessage, addMessageActions, regenerateLastResponse } from './chat_messages.js';
import { send_message, _chatExecuteToolCall } from './chat_streaming.js';
import { parseActiveSession, formatSessionEvent } from '../../memory/activeSessionFormat.js';
import type { RollingMessage } from './RollingWindow.js';
import { AttachmentManager, MentionAutocomplete } from '../../ui-components/index.js';
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
        if (operation === 'edit') commitMessageEdit(rw);
        await rw.addMessage('user', 'Bezpieczne pytanie', { parentConversationText: 'Bezpieczne pytanie' });
        const snapshot = rw.parentConversation.snapshot();
        t.is(snapshot.summary, operation === 'edit' ? '[1 user] Zostaje' : '[1 user] Zostaje\n[3 assistant] Stara odpowiedź\n[4 assistant] Dalsza odpowiedź');
        t.deepEqual(snapshot.messages.map(message => message.text), operation === 'edit'
            ? ['Bezpieczne pytanie'] : [...Array<string>(7).fill('Dalsza odpowiedź'), 'Bezpieczne pytanie']);
        t.false(JSON.stringify(snapshot).includes('USUNIĘTY SEKRET'));
    });
}

for (const legacy of [false, true]) for (const edit of [false, true]) for (const kind of (edit && !legacy ? ['pdf', 'text', 'mention', 'image'] as const : ['pdf'] as const)) {
    test.serial(`${edit ? 'F5-2' : 'F4-2'}: ${kind} → ponowienie → edycja=${edit} → wysyłka → delegacja, legacy=${legacy}`, async t => {
        const rw = new RollingWindow();
        await rw.addMessage('user', '📎 Attachment: file.pdf\n```\nTAJNY ZAŁĄCZNIK PDF\n```\n\nPytanie', legacy ? {} : { parentConversationText: 'Pytanie' });
        await rw.addMessage('assistant', 'Stara odpowiedź');
        let captured: ExecuteToolCallOptions | undefined;
        let disk = '';
        let calls = 0;
        const manager = Object.create(AttachmentManager.prototype) as AttachmentManager;
        manager.attachments = [];
        let chips: string[] = [];
        manager._renderChips = () => { chips = manager.attachments.map(attachment => attachment.name); };
        manager.onChange = () => {};
        const mentions = Object.create(MentionAutocomplete.prototype) as MentionAutocomplete;
        mentions.mentions = [];
        let mentionChips: string[] = [];
        mentions.onChange = list => { mentionChips = list.map(mention => mention.name); };
        const source = edit && !legacy ? 'Pytanie @[notatka]' : 'Pytanie';
        const agent = { name: 'Mira' };
        const memory = { activeSessionPath: 'a.md', sessionEpoch: 'epoch-a' };
        const tab = { agentName: 'Mira', sessionId: 'retry', sessionPath: 'a.md', sessionEpoch: 'epoch-a', isActive: true };
        const view = {
            leaf: { id: 'retry' }, rollingWindow: rw, input_area: { value: '', focus() {} }, inputHistory: [],
            tokenTracker: { record() {} }, chatTabs: [tab], _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
            plugin: { agentManager: { getActiveAgent: () => agent, getAgentMemory: () => memory,
                getActiveSystemPromptWithMemory: async () => 'system' },
                mcpClient: { async executeToolCall(_call: unknown, _agent: string, opts: ExecuteToolCallOptions) { captured = opts; return { success: true }; } } },
            env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_max_iterations: 3, chat_stream_stall_timeout_ms: 0 } } } },
            mentionAutocomplete: mentions, attachmentManager: manager, _isCurrentModelVision: () => true,
            render_messages: async () => {}, send_message, is_generating: false,
            set_generating(value: boolean) { this.is_generating = value; }, showTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
            async _resolveMentions(text: string) { return { displayText: text, contextText: mentions.hasMentions() ? 'TAJNA ROZWINIĘTA WZMIANKA' : '' }; },
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
            _finalizeTurn() { this.is_generating = false; }, handle_error(error: unknown) { throw error; },
        };
        if (edit && !legacy) {
            rw.clear();
            manager.attachments = kind === 'mention' ? [] : [{ type: kind, name: 'plik.' + kind,
                content: 'TAJNY ZAŁĄCZNIK', mimeType: kind === 'image' ? 'image/png' : 'text/plain', size: 16 }];
            mentions.mentions = [{ type: 'note', name: 'notatka', path: 'notatka.md', icon: 'file' }];
            view.input_area.value = source;
            await send_message.call(view as never, { meta: { origin: 'human' } });
            t.deepEqual(manager.attachments, []);
            t.true(JSON.stringify(rw.messages[0].content).includes('TAJNA ROZWINIĘTA WZMIANKA'));
            calls = 0;
        }
        await regenerateLastResponse.call(view as never);
        if (edit) {
            startEditMessage.call(view as never, 0, String(rw.messages[0].content));
            t.is(view.input_area.value, legacy ? '' : source);
            t.deepEqual(chips, legacy || kind === 'mention' ? [] : ['plik.' + kind]);
            t.deepEqual(mentionChips, legacy ? [] : ['notatka']);
            view.input_area.value += ' poprawione';
            calls = 0;
            await send_message.call(view as never, { meta: { origin: 'human' } });
            t.deepEqual(captured?.parentConversation?.snapshot.messages.map(message => message.text), [legacy ? 'poprawione' : source + ' poprawione', 'Deleguję']);
            if (!legacy && kind !== 'mention') t.true(JSON.stringify(rw.messages[0].content).includes('TAJNY ZAŁĄCZNIK'));
            return;
        }
        t.deepEqual(captured?.parentConversation?.snapshot.messages.map(message => message.text), legacy ? ['Deleguję'] : ['Pytanie', 'Deleguję']);
        t.deepEqual(parseActiveSession(disk).messages.map(message => message.parentConversationText), [legacy ? undefined : 'Pytanie']);
        t.is(captured?.parentConversation?.snapshot.omittedMessages, legacy ? 1 : 0);
    });
}
