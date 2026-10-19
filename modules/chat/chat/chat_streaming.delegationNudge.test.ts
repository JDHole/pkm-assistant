import test from 'ava';
import { send_message, _chatBeforeContinue } from './chat_streaming.js';
import { RollingWindow } from './RollingWindow.js';
import streamingManager from './StreamingManager.js';

test('a real multi-iteration chat turn adds one user-role delegation reminder', async t => {
    const rw = new RollingWindow();
    const agent = { name: 'Jaskier', getActiveDelegates: () => ['researcher'] };
    let calls = 0;
    const model = {
        modelKey: 'synthetic',
        stream(_payload: unknown, handlers: { done(response: unknown): void }) {
            calls++;
            handlers.done({ choices: [{ message: calls <= 4
                ? { role: 'assistant', content: 'Working', tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: 'list', arguments: '{}' } }] }
                : { role: 'assistant', content: 'Done' } }] });
        },
    };
    const view = {
        leaf: { id: 'delegation-nudge-test' }, input_area: { value: '' }, inputHistory: [],
        rollingWindow: rw, tokenTracker: { record() {} },
        chatTabs: [{ agentName: 'Jaskier', sessionId: 'tab', isActive: true }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
        plugin: { agentManager: { getActiveAgent: () => agent, getActiveSystemPromptWithMemory: async () => 'system' } },
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_max_iterations: 8, chat_stream_stall_timeout_ms: 0 } } } },
        is_generating: false,
        set_generating(value: boolean) { this.is_generating = value; },
        showTypingIndicator() {},
        async append_message(role: 'user', content: string) { await rw.addMessage(role, content); },
        async appendToActiveSession() {},
        get_chat_model: () => model,
        _chatResolveTools: () => [{ type: 'function', function: { name: 'list', parameters: {} } }],
        _chatExecuteToolCall: async () => ({ success: true }),
        _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
        _chatBeforeContinue,
        _chatOnUsage() {}, _chatOnBackstop() {},
        _isTurnActiveTab: () => false,
        _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
    };
    try {
        await send_message.call(view as never, { injectedText: 'Find notes' });
        t.is(calls, 5);
        const reminders = rw.messages.filter(message => message.role === 'user' && /delegat|delegat/i.test(String(message.content)));
        t.is(reminders.length, 1);
    } finally {
        streamingManager.stopStream('delegation-nudge-test::Jaskier');
    }
});
