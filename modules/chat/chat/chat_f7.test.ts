import test from 'ava';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { RollingWindow } from './RollingWindow.js';
import type { RollingMessage } from './RollingWindow.js';
import { startEditMessage, addMessageActions } from './chat_messages.js';
import { send_message } from './chat_streaming.js';
import { handleSaveSession, handleLoadSession, handleNewSession, initSessionManager, _restoreActiveSession } from './chat_session.js';
import { _closeActiveTab } from './chat_tabs.js';
import { OpenSessionModal } from '../OpenSessionModal.js';
import { AgentMemory } from '../../memory/index.js';
import { parseActiveSession, formatSessionEvent } from '../../memory/activeSessionFormat.js';
import { ParentConversationProjection } from '../../sub-agents/index.js';

function fixture() {
    const files = new Map<string, string>();
    const memory = new AgentMemory({ adapter: {
        exists: async path => files.has(path), read: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        write: async (path, text) => { files.set(path, text); }, remove: async path => { files.delete(path); },
        mkdir: async () => {}, list: async () => ({ files: [] }),
    } }, 'Mira');
    const path = memory.paths.sessionsActive + '/f7.md';
    files.set(path, '---\nepoch: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n');
    memory.setActiveSessionIdentity(path, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const agent = { name: 'Mira' };
    const view = {
        leaf: { id: 'f7' }, rollingWindow: new RollingWindow(), input_area: { value: '', focus() {} }, inputHistory: [] as string[],
        tokenTracker: { record() {}, clear() {} }, chatTabs: [{ agentName: 'Mira', sessionId: 'a', sessionPath: path, sessionEpoch: memory.sessionEpoch, isActive: true }],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
        plugin: { agentManager: { getActiveAgent: () => agent, getAgentMemory: () => memory, getActiveMemory: () => memory,
            getActiveSystemPromptWithMemory: async () => 'system' } },
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
        render_messages: async () => {}, updateTokenCounter() {}, _updateTokenPanel() {}, add_welcome_message() {},
        _createRollingWindow: () => new RollingWindow(), handleSaveSession, is_generating: false,
        set_generating(value: boolean) { this.is_generating = value; }, showTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
        async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
        async append_message(role: 'user', content: RollingMessage['content'], _display: unknown, meta: Partial<RollingMessage>) { await this.rollingWindow.addMessage(role, content, meta); },
        get_chat_model: () => ({ providerId: 'openai', stream(_payload: unknown, cb: { done(value: unknown): void }) {
            cb.done({ choices: [{ message: { role: 'assistant', content: 'Gotowe' } }] });
        } }),
        _chatResolveTools: () => [], _chatOnIterationStart() {}, _chatOnUsage() {}, _isTurnActiveTab: () => false,
        _finalizeTurn() { this.is_generating = false; }, handle_error(error: unknown) { throw error; },
    };
    return { files, path, memory, view };
}

for (const storage of ['legacy', 'archive', 'source'] as const) test.serial(`F7-1: ${storage} → Edytuj → zapis bez wysłania → wyślij`, async t => {
    const { view, memory, path } = fixture();
    await view.rollingWindow.addMessage('user', 'Zwykłe pytanie', storage === 'source' || storage === 'archive' ? { parentConversationText: 'Zwykłe pytanie' } : {});
    await view.rollingWindow.addMessage('assistant', 'Dalsza historia');
    await handleSaveSession.call(view as never);
    if (storage === 'archive') {
        const archive = await memory.archiveActiveSession(path);
        view.rollingWindow = new RollingWindow();
        const prompt = OpenSessionModal.prototype.prompt;
        OpenSessionModal.prototype.prompt = async () => 'continue';
        try { await handleLoadSession.call(view as never, archive!); } finally { OpenSessionModal.prototype.prompt = prompt; }
        t.deepEqual(view.rollingWindow.messages.map(m => m.content), ['Zwykłe pytanie', 'Dalsza historia']);
        t.is(view.rollingWindow.messages[0].parentConversationText, 'Zwykłe pytanie');
    }
    startEditMessage.call(view as never, 0, 'Zwykłe pytanie');
    t.is(view.input_area.value, 'Zwykłe pytanie');
    t.deepEqual(view.rollingWindow.messages.map(m => m.content), ['Zwykłe pytanie', 'Dalsza historia']);
    // Closing/autosave while the editor is open must preserve the unconfirmed history.
    await handleSaveSession.call(view as never);
    view.input_area.value = 'Poprawione pytanie';
    await send_message.call(view as never, { meta: { origin: 'human' } });
    t.deepEqual(view.rollingWindow.messages.map(m => m.content), ['Poprawione pytanie']);
});

test.serial('F7-1: nierozdzielalny załącznik → pusty edytor → historia pozostaje do wysłania', async t => {
    const { view } = fixture();
    await view.rollingWindow.addMessage('user', '📎 Attachment: file.txt\n```\nTAJNY PLIK\n```\n\nPytanie');
    await view.rollingWindow.addMessage('assistant', 'Dalsza historia');
    startEditMessage.call(view as never, 0, 'TAJNY PLIK');
    t.is(view.input_area.value, '');
    t.deepEqual(view.rollingWindow.messages.map(m => m.content), ['📎 Attachment: file.txt\n```\nTAJNY PLIK\n```\n\nPytanie', 'Dalsza historia']);
    view.input_area.value = 'Bezpieczna poprawka';
    await send_message.call(view as never, { meta: { origin: 'human' } });
    t.deepEqual(view.rollingWindow.parentConversation.snapshot().messages.map(m => m.text), ['Bezpieczna poprawka']);
});

for (const field of ['message_id', 'removed_messages', 'removed_ranges']) for (const modern of [false, true]) test.serial(`F7-2: literal ${field}, modern=${modern} → odczyt → archiwum`, async t => {
    const { files, path, memory } = fixture();
    const content = `Początek\n**${field}:**\n\n["literalna treść"]\nKoniec`;
    files.set(path, modern ? formatSessionEvent('user_message', { message_id: 'real-id', content }, '2026-11-05T00:00:00Z')
        : `## 2026-11-05T00:00:00Z — user message\n\n**content:**\n\n${content}\n`);
    t.deepEqual(parseActiveSession(files.get(path)).messages.map(m => m.content), [content]);
    const archive = await memory.archiveActiveSession(path);
    t.deepEqual((await memory.loadSession(archive)).messages.map(m => m.content), [content]);
    t.false(files.has(path));
});

for (const close of ['tab', 'new-session', 'view', 'beforeunload', 'plugin-unload', 'background-unload'] as const) test.serial(`F7-3: usuń wszystko → ${close} przed autosave → odczyt`, async t => {
    const { files, path, memory, view } = fixture();
    await view.rollingWindow.addMessage('user', 'USUNIĘTY SEKRET', { parentConversationText: 'USUNIĘTY SEKRET' });
    await handleSaveSession.call(view as never);
    const buttons = createDiv();
    addMessageActions.call(view as never, buttons, 'USUNIĘTY SEKRET', 'user', 0);
    (buttons.children[1] as HTMLButtonElement).onclick!({ stopPropagation() {} } as MouseEvent);
    if (close === 'tab') await _closeActiveTab.call(view as never);
    else if (close === 'new-session') await handleNewSession.call(view as never);
    else if (close === 'beforeunload' || close === 'background-unload') {
        if (close === 'background-unload') {
            view._agentStates.set('a', { rollingWindow: view.rollingWindow });
            view.chatTabs[0].isActive = false;
            const other = memory.paths.sessionsActive + '/other.md';
            files.set(other, '---\nepoch: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n' + formatSessionEvent('user_message', { content: 'Druga rozmowa' }, '2026-11-05T00:00:00Z'));
            memory.setActiveSessionIdentity(other, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
            view.chatTabs.push({ agentName: 'Mira', sessionId: 'b', sessionPath: other, sessionEpoch: memory.sessionEpoch, isActive: true });
            view.rollingWindow = new RollingWindow();
        }
        // Execute the real callback registered by renderView, without loading its CSS.
        const ui = readFileSync(new URL('./chat_ui.ts', import.meta.url), 'utf8');
        const callback = ui.match(/this.handleBeforeUnloadBound = (.*);/)![1];
        new Function(`(${callback})()`).call(view);
    } else if (close === 'plugin-unload') {
        const source = ts.createSourceFile('main.ts', readFileSync(new URL('../../../src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
        const cls = source.statements.find(ts.isClassDeclaration)!;
        const method = cls.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === 'onunload') as ts.MethodDeclaration;
        const body = ts.transpile(method.body!.getText(source), { target: ts.ScriptTarget.ES2022 });
        const run = new Function('log', 'stopAllDelegations', 'SkinManager', 'removeAdoptedSheets', 'CHAT_VIEW_TYPE', `return function() ${body}`)(
            { debug() {}, warn() {}, disposeFileSink() {} }, () => {}, {}, () => {}, 'chat');
        run.call({ app: { workspace: { getLeavesOfType: () => [{ view }] } } });
    } else {
        const source = ts.createSourceFile('view.ts', readFileSync(new URL('../chat_view.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
        const cls = source.statements.find(ts.isClassDeclaration)!;
        const method = cls.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === 'onClose' && m.body) as ts.MethodDeclaration;
        const body = ts.transpile(method.body!.getText(source), { target: ts.ScriptTarget.ES2022 });
        const run = new Function(`return async function() ${body}`)() as (this: unknown) => Promise<void>;
        Object.assign(view, { _cleanupAskUser() {}, stop_all_turns() {} });
        await run.call(view);
    }
    // Drain actual AgentMemory writes, including fire-and-forget lifecycle calls.
    await memory.saveSession([], {}, { expectedSession: { path, epoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    t.deepEqual(parseActiveSession(files.get(path)).messages.map(m => m.content), []);
    t.true(files.get(path)!.includes('messages removed'));
    const restoredView = fixture().view;
    restoredView.plugin.agentManager.getAgentMemory = () => memory;
    restoredView.plugin.agentManager.getActiveMemory = () => memory;
    memory.restoreActiveSession = async () => path;
    await _restoreActiveSession.call(restoredView as never);
    t.deepEqual(restoredView.rollingWindow.messages.map(m => m.content), []);
    if (close === 'background-unload') t.deepEqual(parseActiveSession(files.get(memory.activeSessionPath!)).messages.map(m => m.content), ['Druga rozmowa']);
});

for (const text of ['task-przygotowanie-dokumentacji', 'task-przeprowadzenie-aktualizacji', 'mask-abcdefghijklmnopqrstuvwxyz', 'prefixsk-abcdefghijklmnopqrstuvwxyz123456']) test(`F7-4: eksport tekstu ${text}`, t => {
    const projection = new ParentConversationProjection();
    projection.append({ role: 'user', content: text });
    t.deepEqual(projection.snapshot().messages.map(m => m.text), [text.startsWith('prefix') ? 'prefixsk-a***3456' : text]);
});

for (const prefix of ['sk-proj-', 'sk-ant-', 'sk-or-v1-', 'sk-']) test(`F7-4: sklejony klucz ${prefix} nadal maskowany`, t => {
    const projection = new ParentConversationProjection();
    projection.append({ role: 'user', content: 'prefix' + prefix + 'Abcdefghijklmnopqrstuvwxyz123456' });
    t.is(projection.snapshot().messages[0].text, 'prefixsk-' + (prefix[3] ?? 'A') + '***3456');
});

test.serial('F7-3: Obsidian quit oczekuje zapisu usunięć', async t => {
    const { files, memory, path, view } = fixture();
    await view.rollingWindow.addMessage('user', 'USUNIĘTY SEKRET');
    await handleSaveSession.call(view as never);
    view.rollingWindow.removeMessages(0);
    let quit: ((tasks: { addPromise(promise: Promise<unknown>): void }) => void) | undefined;
    Object.assign(view, {
        app: { workspace: { on(event: string, callback: typeof quit) { if (event === 'quit') quit = callback; return {}; } } },
        registerEvent() {}, registerInterval(id: number) { window.clearInterval(id); },
        _restoreActiveSession: async () => {}, stop_all_turns() {},
    });
    await initSessionManager.call(view as never);
    t.is(typeof quit, 'function');
    const tasks: Promise<unknown>[] = [];
    quit!({ addPromise(promise) { tasks.push(promise); } });
    t.is(tasks.length, 1);
    await Promise.all(tasks);
    t.deepEqual((await memory.loadActiveSession({ path })).messages.map(m => m.content), []);
    t.true(files.get(path)!.includes('messages removed'));
});
