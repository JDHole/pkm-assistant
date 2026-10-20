import test from 'ava';
import { ArrayMessageStore, runAgentLoop } from '../../agent-loop/index.js';
import { MCPClient, createReadTool } from '../../tools/index.js';
import { _chatExecuteToolCall, _finalizeTurn, _isTurnActiveTab, _releaseStreamCtx, send_message } from './chat_streaming.js';
import { handleNewSession } from './chat_session.js';
import { _tabKey } from './chat_tabs.js';
import { RollingWindow } from './RollingWindow.js';
import streamingManager from './StreamingManager.js';
import { matchTabForOrigin } from './subTaskNotification.js';

type ReadPage = {
    success: boolean; content: string; path: string; source_version: string;
    source_length: number; offset: number; effective_limit: number;
    next_offset: number | null; has_more: boolean; truncated: boolean; code?: string;
};
type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
const TERMINAL_FIELD = 'END-OF-CHAT-FIXTURE-7f3c2a';
const SOURCE = `${'line "quoted" \\ 😀 é\r\n'.repeat(2800)}${TERMINAL_FIELD}`;

function makeReadRuntime(source: string) {
    const file = { path: 'Fixtures/full-read.md', name: 'full-read.md' };
    const app = { vault: {
        getAbstractFileByPath: (path: string) => path === file.path ? file : null,
        cachedRead: async () => source, adapter: { read: async () => source },
    } };
    const agent = { name: 'Reader', permissions: { read_notes: true, guidance_mode: false, mcp: true } };
    const plugin = { agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false } };
    // MCPClient passes its trusted page budget only to registered built-ins.
    const readTool = { ...createReadTool(), source: 'built-in' };
    const mcpClient = new MCPClient(app as never, plugin as never, {
        getTool: (name: string) => name === 'read' ? readTool as never : null,
        getToolDefinitions: () => [],
    } as never);
    const view = { plugin: { mcpClient } } as never;
    const turn = { agentName: 'Reader', autonomy: 'edge', origin: null, rawResults: new Map() };
    return { view, turn, file };
}

for (const cap of [15000, 600]) {
    test(`chat executor and AgentLoop reconstruct every page at cap ${cap}`, async t => {
        t.true(SOURCE.length >= 55000);
        const { view, turn, file } = makeReadRuntime(SOURCE);
        const pages: ReadPage[] = [];
        const resultLengths: number[] = [];
        const linkedIds: string[] = [];
        const failures: string[] = [];
        const store = new ArrayMessageStore([{ role: 'user', content: 'Read every page.' }]);
        const model = {
            stream(payload: { messages?: Message[] }, callbacks: { done(response: unknown): void }) {
                const messages = payload.messages || [];
                const latest = [...messages].reverse().find(message => message.role === 'tool');
                if (!latest) {
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                        { id: 'chat-read-0', type: 'function', function: {
                            name: 'read', arguments: JSON.stringify({ path: file.path }),
                        } },
                    ] } }] });
                    return;
                }
                const id = latest.tool_call_id || '';
                const parent = messages.find(message => message.role === 'assistant'
                    && message.tool_calls?.some(call => call.id === id));
                if (!parent) failures.push(`orphan tool result: ${id}`);
                linkedIds.push(id);
                const text = String(latest.content);
                resultLengths.push(text.length);
                let page: ReadPage;
                try { page = JSON.parse(text) as ReadPage; }
                catch {
                    failures.push(`invalid JSON in page ${pages.length}`);
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: 'READ_FAILED' } }] });
                    return;
                }
                if (!page.success) {
                    failures.push(`page ${pages.length}: ${page.code || 'unknown error'}`);
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: 'READ_FAILED' } }] });
                    return;
                }
                pages.push(page);
                if (page.has_more) {
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                        { id: `chat-read-${pages.length}`, type: 'function', function: {
                            name: 'read', arguments: JSON.stringify({
                                path: page.path, offset: page.next_offset, source_version: page.source_version,
                            }),
                        } },
                    ] } }] });
                    return;
                }
                callbacks.done({ choices: [{ message: {
                    role: 'assistant',
                    content: pages.map(item => item.content).join('') === SOURCE
                        ? `READ_COMPLETE ${TERMINAL_FIELD}` : 'READ_FAILED',
                } }] });
            },
        };
        const outcome = await runAgentLoop({
            model: model as never, store,
            executeToolCall: (call, context) => _chatExecuteToolCall.call(view, turn as never, call, context),
            limits: { maxIterations: 500, maxToolResultLength: cap },
        });
        t.deepEqual(failures, []);
        t.is(outcome.stoppedBy, 'natural');
        t.is(outcome.finalText, `READ_COMPLETE ${TERMINAL_FIELD}`);
        t.true(pages.length > 1 && pages.length < 500);
        t.is(pages.map(page => page.content).join(''), SOURCE);
        t.true(resultLengths.every(length => length <= Math.min(cap, 12000)));
        t.deepEqual(linkedIds, pages.map((_, index) => `chat-read-${index}`));
        t.is(turn.rawResults.size, pages.length);
        let offset = 0;
        const version = pages[0].source_version;
        for (const [index, page] of pages.entries()) {
            t.is(page.path, file.path);
            t.is(page.source_version, version);
            t.is(page.source_length, SOURCE.length);
            t.is(page.offset, offset);
            t.is(page.next_offset, index === pages.length - 1 ? null : offset + page.content.length);
            t.is(page.has_more, index !== pages.length - 1);
            t.is(page.truncated, index !== pages.length - 1);
            t.true(page.effective_limit >= page.content.length);
            offset += page.content.length;
        }
        t.is(offset, SOURCE.length);
    });
}

for (const [name, meta, expectedKind] of [
    ['human', { origin: 'human' }, 'user'],
    ['machine', { origin: 'machine' }, 'machine'],
    ['without meta', undefined, 'machine'],
] as const) {
    test(`send_message passes session epoch and ${expectedKind} turn kind for ${name}`, async t => {
        const path = 'sessions/active/Jaskier.md';
        const epoch = '0123456789abcdef0123456789abcdef';
        const tab = { agentName: 'Jaskier', sessionId: 'fresh', isActive: true,
            sessionPath: undefined as string | undefined, sessionEpoch: null as string | null };
        const memory = {
            activeSessionPath: null as string | null, sessionEpoch: null as string | null,
            async startActiveSession() { return path; },
        };
        const optionsSeen: Array<{ origin?: { agentName: string; sessionPath?: string; sessionEpoch?: string; tabKey?: string }; turnKind?: string }> = [];
        const agent = { name: 'Jaskier' };
        let modelCalls = 0;
        const model = { modelKey: 'fixture', stream(_payload: unknown, handlers: { done(response: unknown): void }) {
            modelCalls++;
            handlers.done({ choices: [{ message: modelCalls === 1
                ? { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list', arguments: '{}' } }] }
                : { role: 'assistant', content: 'Done' } }] });
        } };
        const rw = new RollingWindow();
        const view = {
            leaf: { id: `turn-kind-${name}` }, input_area: { value: String(name) }, inputHistory: [],
            rollingWindow: rw, tokenTracker: { record() {} }, chatTabs: [tab],
            _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
            plugin: {
                agentManager: {
                    getActiveAgent: () => agent, getAgentMemory: () => memory,
                    getActiveSystemPromptWithMemory: async () => 'system',
                },
                mcpClient: { async executeToolCall(_call: unknown, _agent: string, options: typeof optionsSeen[number]) {
                    optionsSeen.push(options);
                    return { success: true };
                } },
            },
            env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_max_iterations: 3, chat_stream_stall_timeout_ms: 0 } } } },
            is_generating: false,
            set_generating(value: boolean) { this.is_generating = value; },
            showTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
            async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
            async append_message(role: 'user', content: string) { rw.addMessage(role, content); },
            async appendToActiveSession() { memory.activeSessionPath = path; memory.sessionEpoch = epoch; },
            get_chat_model: () => model,
            _chatResolveTools: () => [{ type: 'function', function: { name: 'list', parameters: {} } }],
            _chatExecuteToolCall, _chatOnIterationStart() {}, _chatOnToolCallsParsed() {},
            _chatOnToolResults() {}, _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {},
            _isTurnActiveTab: () => false, _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
        };
        try {
            await send_message.call(view as never, meta ? { meta: meta as never } : { injectedText: name });
            t.is(optionsSeen.length, 1);
            t.deepEqual(optionsSeen[0].origin, {
                agentName: 'Jaskier', sessionPath: path, sessionEpoch: epoch, tabKey: 'fresh',
            });
            t.is(optionsSeen[0].turnKind, expectedKind);
            t.is(tab.sessionPath, path);
            t.is(tab.sessionEpoch, epoch);
            t.is(matchTabForOrigin([tab], optionsSeen[0].origin, item => item.sessionId), tab);
        } finally {
            streamingManager.stopStream(`turn-kind-${name}::Jaskier`);
        }
    });
}

test.serial('first response after New Session renders and clears generating state', async t => {
    const path = 'sessions/active/Jaskier.md';
    const epoch = '0123456789abcdef0123456789abcdef';
    const oldPath = 'sessions/active/Jaskier-old.md';
    const tab = { agentName: 'Jaskier', sessionId: oldPath as string | undefined,
        sessionPath: oldPath as string | undefined, sessionEpoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as string | null,
        isActive: true };
    const memory = { activeSessionPath: oldPath as string | null,
        sessionEpoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as string | null,
        async startNewSession() { this.activeSessionPath = null; this.sessionEpoch = null; },
        async appendSessionEvent() { return path; } };
    const agent = { name: 'Jaskier' };
    const rw = new RollingWindow();
    const state = { isGenerating: true };
    const painted = { containers: 0 };
    const message = { createDiv: () => ({ createSpan() {} }) };
    const model = { modelKey: 'fixture', stream(_payload: unknown, handlers: { done(response: unknown): void }) {
        handlers.done({ choices: [{ message: { role: 'assistant', content: 'Odpowiedź po nowej sesji' } }] });
    } };
    const view = {
        leaf: { id: 'new-session-response' }, input_area: { value: 'Pytanie' }, inputHistory: [],
        rollingWindow: rw, tokenTracker: { record() {}, clear() {} }, chatTabs: [tab],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map([[oldPath, state]]),
        plugin: { agentManager: { getActiveAgent: () => agent, getActiveMemory: () => memory, getAgentMemory: () => memory,
            getActiveSystemPromptWithMemory: async () => 'system' }, showCrystalNotice() {} },
        env: { settings: { pkmAssistant: { enableOczko: false, enableAutoSummarization: false,
            limits: { chat_max_iterations: 1, chat_stream_stall_timeout_ms: 0 } } } },
        is_generating: false,
        _createRollingWindow: () => rw, render_messages() {}, add_welcome_message() {},
        set_generating(value: boolean) { this.is_generating = value; },
        showTypingIndicator() {}, hideTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
        async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
        async append_message(role: 'user', content: string) { await rw.addMessage(role, content); },
        async appendToActiveSession() { memory.activeSessionPath = path; memory.sessionEpoch = epoch; },
        get_chat_model: () => model, _chatResolveTools: () => [],
        _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
        _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {},
        _isTurnActiveTab, _finalizeTurn, _releaseStreamCtx,
        _ensureAgentMessageContainer() {
            painted.containers++;
            this.current_message_container = message;
            this.current_message_text = { empty() {} };
        },
        current_message_container: null as typeof message | null,
        current_message_text: null as { empty(): void } | null,
        _lastPaintedContent: null as string | null,
        _renderCacheSavingsBadge() {}, addMessageActions() {}, updateTokenCounter() {}, _updateTokenPanel() {},
        scrollToFinalMessage() {}, _scheduleConnectorRedraw() {},
        _resetPaintTargets() { this.current_message_container = null; this.current_message_text = null; },
        handle_error(error: unknown) { throw error; },
    };
    const hasFocus = document.hasFocus;
    document.hasFocus = () => true;
    try {
        await handleNewSession.call(view as never);
        t.is(tab.sessionId, undefined);
        t.is(_tabKey(tab), 'Jaskier');
        t.is(view._agentStates.get('Jaskier'), state);
        await send_message.call(view as never, { meta: { origin: 'human' } });
        t.is(tab.sessionPath, path);
        t.is(tab.sessionEpoch, epoch);
        t.is(_tabKey(tab), 'Jaskier');
        t.is(painted.containers, 1);
        t.is(view._lastPaintedContent, 'Odpowiedź po nowej sesji');
        t.is(view.is_generating, false);
        t.is(rw.messages.at(-1)?.content, 'Odpowiedź po nowej sesji');
        t.is(view._streamCtxMap.size, 0);
    } finally {
        document.hasFocus = hasFocus;
        streamingManager.stopStream('new-session-response::Jaskier');
    }
});
