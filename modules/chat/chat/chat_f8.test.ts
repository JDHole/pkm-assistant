import { closeSessionDecisions } from '../sessionViewLifecycle.js';
import test from 'ava';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { RollingWindow } from './RollingWindow.js';
import type { RollingMessage } from './RollingWindow.js';
import { startEditMessage } from './chat_messages.js';
import { send_message } from './chat_streaming.js';
import { handleSaveSession, handleNewSession, initSessionManager, _restoreActiveSession } from './chat_session.js';
import { _switchTab } from './chat_tabs.js';
import { hasPendingMessageEdit } from './messageEdit.js';
import * as edit from './messageEdit.js';
import { register } from 'node:module';
import type { ChatViewLike } from './chatViewShape.js';
import { getLocale, setLocale } from '../../../core/i18n/index.js';
import { AgentMemory } from '../../memory/index.js';
import { SessionCloseModal } from '../SessionCloseModal.js';
import { parseActiveSession } from '../../memory/activeSessionFormat.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function fixture(otherAgent = false) {
    const files = new Map<string, string>();
    const writes: string[] = [];
    const adapter = {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        write: async (path: string, text: string) => { files.set(path, text); writes.push(path); },
        remove: async (path: string) => { files.delete(path); }, mkdir: async () => {}, list: async () => ({ files: [] }),
    };
    const memory = new AgentMemory({ adapter }, 'Mira');
    const other = otherAgent ? new AgentMemory({ adapter }, 'Borys') : memory;
    let agent = { name: 'Mira' };
    const memories = new Map([['Mira', memory], ['Borys', other]]);
    const tabs = ['A', 'B', 'C'].map((id, index) => ({ agentName: index && otherAgent ? 'Borys' : 'Mira', sessionId: id,
        sessionPath: (index ? other : memory).paths.sessionsActive + '/' + id + '.md', sessionEpoch: id.repeat(32).toLowerCase(), isActive: index === 0 }));
    const windows = [new RollingWindow(), new RollingWindow(), new RollingWindow()];
    for (const [i, tab] of tabs.entries()) {
        files.set(tab.sessionPath, `---\nepoch: ${tab.sessionEpoch}\n---\n`);
        await windows[i].addMessage('user', `Historia ${tab.sessionId}`);
        await memories.get(tab.agentName)!.saveSession(windows[i].messages, {}, { expectedSession: { path: tab.sessionPath, epoch: tab.sessionEpoch } });
    }
    memory.setActiveSessionIdentity(tabs[0].sessionPath, tabs[0].sessionEpoch);
    const host = createDiv();
    const row = host.createDiv();
    const input = row.createEl('textarea');
    // The shared harness intentionally omits DOM parent links, removal and selectors.
    Object.defineProperty(input, 'parentElement', { value: row });
    Object.defineProperty(row, 'parentElement', { value: host });
    const create = host.createDiv.bind(host);
    host.createDiv = ((options: Parameters<typeof create>[0]) => {
        const child = create(options);
        child.remove = () => { host.removeChild(child); };
        return child;
    }) as typeof host.createDiv;
    host.insertBefore = ((child: Node, before: Node) => {
        const children = host.children as unknown as Node[];
        const existing = children.indexOf(child);
        if (existing >= 0) children.splice(existing, 1);
        children.splice(children.indexOf(before), 0, child);
        return child;
    }) as typeof host.insertBefore;

    const listeners: { type: string; cb: EventListener; capture: boolean }[] = [];
    input.addEventListener = ((type: string, cb: EventListener, capture = false) => {
        listeners.push({ type, cb, capture: capture === true });
    }) as typeof input.addEventListener;
    input.removeEventListener = ((type: string, cb: EventListener, capture = false) => {
        const index = listeners.findIndex(item => item.type === type && item.cb === cb && item.capture === (capture === true));
        if (index >= 0) listeners.splice(index, 1);
    }) as typeof input.removeEventListener;
    const view = {
        leaf: { id: 'f8' }, rollingWindow: windows[0], input_area: input, inputHistory: [] as string[],
        tokenTracker: { record() {}, clear() {} }, chatTabs: tabs,
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(tabs.map((tab, i) => [tab.sessionId, { rollingWindow: windows[i] }])),
        plugin: { agentManager: { getActiveAgent: () => agent, getAgentMemory: (name: string) => memories.get(name), getActiveMemory: () => memories.get(agent.name),
            switchAgent(name: string) { agent = { name }; }, getActiveSystemPromptWithMemory: async () => 'system' } },
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
        render_messages: async () => {}, updateTokenCounter() {}, _updateTokenPanel() {}, add_welcome_message() {},
        _getDefaultAutonomy: () => 'ask', _updateAutonomyButton() {}, updatePermissionsBadge() {}, renderSkillButtons() {}, _getAgentRgb: () => '',
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
    return { files, writes, adapter, memory, view, windows, tabs, host, indicator: () => [...host.children].find(child => child.className === 'cs-message-edit-indicator') ?? null,
        dispatch(type: string, key = '') {
            const event = { key, defaultPrevented: false, stopped: false, immediate: false,
                preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
                stopImmediatePropagation() { this.immediate = true; this.stopped = true; } };
            for (const capture of [true, false]) for (const listener of [...listeners]) {
                if (listener.type === type && listener.capture === capture && !event.immediate) listener.cb(event as unknown as Event);
            }
            if (type === 'keydown' && !event.stopped) uiFunction('handleGlobalKeydown').call(view, event);
        },
    };
}

for (const otherAgent of [false, true]) test.serial(`F8-1: A → B → C podczas zapisu, inny agent=${otherAgent}`, async t => {
    const f = await fixture(otherAgent);
    f.windows[0].removeMessages(0);
    const entered = deferred(); const release = deferred();
    const write = f.adapter.write;
    f.adapter.write = async (path, text) => {
        if (path === f.tabs[0].sessionPath) { entered.resolve(); await release.promise; }
        await write(path, text);
    };
    const first = _switchTab.call(f.view as never, 'B');
    await entered.promise;
    const second = _switchTab.call(f.view as never, 'C');
    release.resolve();
    await Promise.all([first, second]);
    await handleSaveSession.call(f.view as never);
    t.deepEqual(f.tabs.map(tab => parseActiveSession(f.files.get(tab.sessionPath)).messages.map(m => m.content)), [[], ['Historia B'], ['Historia C']]);
    t.is(f.view._agentStates.get('A')!.rollingWindow, f.windows[0]);
    t.is(f.view.rollingWindow, f.windows[2]);
    t.deepEqual(f.tabs.map(tab => tab.isActive), [false, false, true]);
});

for (const otherAgent of [false, true]) test.serial(`F8-2: edytuj A → B → wyślij B → A → zwykła wiadomość, inny agent=${otherAgent}`, async t => {
    const f = await fixture(otherAgent);
    startEditMessage.call(f.view as never, 0, 'Historia A');
    await _switchTab.call(f.view as never, 'B');
    f.view.input_area.value = 'Nowa w B';
    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    await _switchTab.call(f.view as never, 'A');
    t.is(f.view.input_area.value, '');
    f.view.input_area.value = 'Nowa w A';
    await send_message.call(f.view as never, { meta: { origin: 'human' } });
    await handleSaveSession.call(f.view as never);
    t.deepEqual(parseActiveSession(f.files.get(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Historia A', 'Nowa w A']);
    t.deepEqual(parseActiveSession(f.files.get(f.tabs[1].sessionPath)).messages.map(m => m.content), ['Historia B', 'Nowa w B']);
});

for (const action of ['clear', 'empty-enter', 'escape', 'global-escape', 'reset', 'agent-event', 'new-session', 'restart'] as const) test.serial(`F8-2: anulowanie ${action} zachowuje historię`, async t => {
    const f = await fixture();
    startEditMessage.call(f.view as never, 0, 'Historia A');
    if (action === 'clear') { f.view.input_area.value = ''; f.dispatch('input'); }
    if (action === 'empty-enter') { f.view.input_area.value = ''; await send_message.call(f.view as never, { meta: { origin: 'human' } }); }
    if (action === 'escape') f.dispatch('keydown', 'Escape');
    if (action === 'global-escape') uiFunction('handleGlobalKeydown').call(f.view, { key: 'Escape' });
    if (action === 'reset') uiFunction('resetInputArea').call(f.view);
    if (action === 'agent-event') {
        let callback!: (event: string) => void;
        Object.assign(f.view.plugin.agentManager, { on(listener: typeof callback) { callback = listener; return () => {}; } });
        new Function('cancelMessageEdit', `return function() ${methodBody('../chat_view.ts', '_subscribeAgentManagerEvents')}`)(edit.cancelMessageEdit).call(f.view);
        f.view.plugin.agentManager.switchAgent('Borys');
        callback('agent:switched');
        f.view.plugin.agentManager.switchAgent('Mira');
        callback('agent:switched');
    }
    if (action === 'new-session') {
        const prompt = SessionCloseModal.prototype.prompt;
        SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
        try { await handleNewSession.call(f.view as never); } finally { SessionCloseModal.prototype.prompt = prompt; }
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['Historia A']);
    } else if (action === 'restart') {
        await handleSaveSession.call(f.view as never);
        const restored = await fixture();
        restored.view.plugin.agentManager.getAgentMemory = () => f.memory;
        restored.view.plugin.agentManager.getActiveMemory = () => f.memory;
        f.memory.restoreActiveSession = async () => f.tabs[0].sessionPath;
        await _restoreActiveSession.call(restored.view as never);
        t.deepEqual(restored.view.rollingWindow.messages.map(m => m.content), ['Historia A']);
        t.is(hasPendingMessageEdit(restored.view.rollingWindow), false);
        t.is(restored.view.input_area.value, '');
        return;
    } else {
        f.view.input_area.value = 'Zwykła wiadomość';
        await send_message.call(f.view as never, { meta: { origin: 'human' } });
        await handleSaveSession.call(f.view as never);
        t.deepEqual(parseActiveSession(f.files.get(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Historia A', 'Zwykła wiadomość']);
    }
    t.is(hasPendingMessageEdit(f.windows[0]), false);
    t.is(f.indicator(), null);
});

function methodBody(path: string, name: string) {
    const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const cls = source.statements.find(ts.isClassDeclaration)!;
    const method = cls.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === name && m.body) as ts.MethodDeclaration;
    return ts.transpile(method.body!.getText(source), { target: ts.ScriptTarget.ES2022 });
}

test.serial('F8-3: quit → beforeunload → plugin unload → onClose: jedno zdarzenie usunięcia', async t => {
    const f = await fixture();
    f.windows[0].removeMessages(0);
    let quit!: (tasks: { addPromise(promise: Promise<unknown>): void }) => void;
    Object.assign(f.view, {
        app: { workspace: { on(event: string, callback: typeof quit) { if (event === 'quit') quit = callback; return {}; } } },
        registerEvent() {}, registerInterval(id: number) { window.clearInterval(id); },
        _restoreActiveSession: async () => {}, stop_all_turns() {}, _cleanupAskUser() {},
        _phoneSessionMenuGeneration: 0, _phoneSessionMenu: null,
        _dismissPhoneSessionMenu: ChatView.prototype._dismissPhoneSessionMenu,
    });
    await initSessionManager.call(f.view as never);
    const tasks: Promise<unknown>[] = [];
    const entered = deferred(); const release = deferred();
    const write = f.adapter.write;
    f.adapter.write = async (path, text) => {
        if (path === f.tabs[0].sessionPath) { entered.resolve(); await release.promise; }
        await write(path, text);
    };
    f.writes.length = 0;
    quit({ addPromise(promise) { tasks.push(promise); } });
    await entered.promise;
    const ui = readFileSync(new URL('./chat_ui.ts', import.meta.url), 'utf8');
    new Function(`(${ui.match(/this.handleBeforeUnloadBound = (.*);/)![1]})()`).call(f.view);
    const unload = new Function('log', 'stopAllDelegations', 'SkinManager', 'removeAdoptedSheets', 'CHAT_VIEW_TYPE', `return function() ${methodBody('../../../src/main.ts', 'onunload')}`)(
        { debug() {}, warn() {}, disposeFileSink() {} }, () => {}, {}, () => {}, 'chat');
    unload.call({ app: { workspace: { getLeavesOfType: () => [{ view: f.view }] } } });
    tasks.push(new Function('closeSessionDecisions', `return async function() ${methodBody('../chat_view.ts', 'onClose')}`)(closeSessionDecisions).call(f.view));
    release.resolve();
    await Promise.all(tasks);
    t.deepEqual(parseActiveSession(f.files.get(f.tabs[0].sessionPath)).messages.map(m => m.content), []);
    t.is((f.files.get(f.tabs[0].sessionPath)!.match(/— messages removed/g) ?? []).length, 1);
    t.is(f.writes.filter(path => path === f.tabs[0].sessionPath).length, 1);
});

function uiFunction(name: string) {
    const source = ts.createSourceFile('chat_ui.ts', readFileSync(new URL('./chat_ui.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name) as ts.FunctionDeclaration;
    const code = ts.transpile(fn.getText(source).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022 });
    return new Function('cancelMessageEdit', `${code}; return ${name};`)(edit.cancelMessageEdit);
}

for (const locale of ['pl', 'en']) test.serial(`F8-2: znacznik ${locale}, anulowanie i potwierdzenie edycji`, async t => {
    const previous = getLocale();
    setLocale(locale);
    try {
        const f = await fixture();
        startEditMessage.call(f.view as never, 0, 'Historia A');
        t.is(f.indicator()?.textContent,
            locale === 'pl' ? 'Edytujesz wiadomość - Esc anuluje' : 'Editing message - Esc cancels');
        f.dispatch('keydown', 'Escape');
        t.is(f.indicator(), null);
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['Historia A']);
        startEditMessage.call(f.view as never, 0, 'Historia A');
        f.view.input_area.value = 'Poprawka';
        await send_message.call(f.view as never, { meta: { origin: 'human' } });
        await handleSaveSession.call(f.view as never);
        t.deepEqual(parseActiveSession(f.files.get(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Poprawka']);
        t.is(f.indicator(), null);
    } finally { setLocale(previous); }
});

test.serial('F8-3: po błędzie zapisu można ponowić usunięcie', async t => {
    const f = await fixture();
    f.windows[0].removeMessages(0);
    const changes = { removedMessageIds: f.windows[0].removedMessageIds,
        expectedSession: { path: f.tabs[0].sessionPath, epoch: f.tabs[0].sessionEpoch } };
    const write = f.adapter.write;
    f.adapter.write = async () => { throw new Error('disk failure'); };
    await t.throwsAsync(f.memory.saveSession([], {}, changes), { message: 'disk failure' });
    t.deepEqual(parseActiveSession(f.files.get(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Historia A']);
    f.adapter.write = write;
    await f.memory.saveSession([], {}, changes);
    t.deepEqual(parseActiveSession(f.files.get(f.tabs[0].sessionPath)).messages.map(m => m.content), []);
    t.is((f.files.get(f.tabs[0].sessionPath)!.match(/— messages removed/g) ?? []).length, 1);
});

test.serial('F8-3: zmiana historii podczas zapisu nie jest scalana z poprzednim snapshotem', async t => {
    const f = await fixture();
    f.windows[0].removeMessages(0);
    const first = handleSaveSession.call(f.view as never);
    await f.windows[0].addMessage('user', 'Nowa po usunięciu');
    const second = handleSaveSession.call(f.view as never);
    await Promise.all([first, second]);
    t.deepEqual(parseActiveSession(f.files.get(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Nowa po usunięciu']);
});

// The harness DOM has no event dispatch or parent links. Keep listener ordering and
// stopImmediatePropagation native while renderView creates and wires the field.
function browserEvents(el: HTMLElement, parent?: HTMLElement): void {
    const target = new EventTarget();
    el.addEventListener = target.addEventListener.bind(target);
    el.removeEventListener = target.removeEventListener.bind(target);
    el.dispatchEvent = target.dispatchEvent.bind(target);
    if (parent) Object.defineProperty(el, 'parentElement', { value: parent });
    const div = el.createDiv.bind(el), span = el.createSpan.bind(el), create = el.createEl.bind(el);
    el.createDiv = options => { const child = div(options); browserEvents(child, el); child.remove = () => { el.removeChild(child); }; return child; };
    el.createSpan = options => { const child = span(options); browserEvents(child, el); return child; };
    el.createEl = ((tag, options) => { const child = create(tag, options); browserEvents(child, el); return child; }) as typeof el.createEl;
    el.insertBefore = ((child: Node, before: Node) => {
        const children = el.children as unknown as Node[];
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        children.splice(children.indexOf(before), 0, child);
        return child;
    }) as typeof el.insertBefore;
}

register('data:text/javascript,' + encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
const { ChatView } = await import('../chat_view.js');

async function escapeFixture(t: import('ava').ExecutionContext) {
    const f = await fixture();
    const windowEvents = new EventTarget();
    window.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    window.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    const app = { vault: { adapter: f.adapter, getMarkdownFiles: () => [] }, workspace: { getActiveFile: () => null }, metadataCache: { getFirstLinkpathDest: () => null } };
    const agent = { name: 'Mira', model: 'openai/test', color: '#123456', enabled: true };
    const settings = { pkmAssistant: { enableOczko: false, chat: { platform: 'openai', apiKeys: { openai: 'test' } }, limits: { chat_stream_stall_timeout_ms: 0 } } };
    const plugin = { app, settings, manifest: { id: 'pkm-assistant' }, env: { settings, config: { chat: { providers: { openai: {} }, http: {}, transport: {} } } },
        agentManager: { getActiveAgent: () => agent, getActiveAgentSkills: () => [], getAgent: () => agent, getAllAgents: () => [agent], getActiveMemory: () => f.memory, getAgentMemory: () => f.memory, getActiveSystemPromptWithMemory: async () => 'system' }, showCrystalNotice() {} };
    const view = new ChatView({ app, id: 'escape-f8' }, plugin as never) as ChatViewLike;
    browserEvents(view.container);
    await view.renderView();
    // Reuse the established in-memory send/session fixture, keeping the actual rendered field.
    const input = view.input_area;
    const { env: _env, plugin: _plugin, leaf: _leaf, ...sendFixture } = f.view;
    Object.assign(view, sendFixture, { input_area: input });
    t.teardown(() => {
        view.mentionAutocomplete?.destroy();
        view._closeTriggerPopup();
        if (view.handleGlobalKeydownBound) document.removeEventListener('keydown', view.handleGlobalKeydownBound);
        if (view.handleBeforeUnloadBound) window.removeEventListener('beforeunload', view.handleBeforeUnloadBound);
        view._selectionMenuDetach?.();
        view._connectorActivityDetach?.();
    });
    const key = (name: string) => { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: name }); input.dispatchEvent(event); };
    const open = async (kind: '@' | '/') => {
        if (kind === '@') { input.value = '@'; input.selectionStart = 1; input.dispatchEvent(new Event('input')); }
        else { input.value = ''; input.selectionStart = 0; key('/'); input.value = '/'; input.selectionStart = 1; await new Promise<void>(resolve => window.setTimeout(resolve, 5)); }
    };
    return { f, view, input, key, open };
}

for (const kind of ['@', '/'] as const) for (const timing of ['przed edycją', 'po rozpoczęciu edycji', 'po ponownym wejściu'] as const) {
    test.serial(`Escape edycji: ${kind}, podpowiedź ${timing}, drugi Escape`, async t => {
        const { f, view, input, key, open } = await escapeFixture(t);
        if (timing === 'przed edycją') await open(kind);
        if (timing === 'po ponownym wejściu') { startEditMessage.call(view, 0, 'Historia A'); key('Escape'); t.is(hasPendingMessageEdit(f.windows[0]), false); }
        startEditMessage.call(view, 0, 'Historia A');
        if (timing !== 'przed edycją') await open(kind);
        t.is(kind === '@' ? view.mentionAutocomplete!.isOpen : view._triggerPopup!.isOpen(), true);
        key('Escape');
        t.is(view.mentionAutocomplete!.isOpen, false);
        t.is(view._triggerPopup?.isOpen() ?? false, false);
        t.is(hasPendingMessageEdit(f.windows[0]), true, 'pierwszy Escape zachowuje edycję');
        key('Escape');
        t.is(hasPendingMessageEdit(f.windows[0]), false, 'drugi Escape anuluje edycję');
        input.value = 'Poprawka';
        await send_message.call(view, { meta: { origin: 'human' } });
        t.deepEqual(f.windows[0].messages.filter(m => m.role === 'user').map(m => m.content), ['Historia A', 'Poprawka']);
    });
}

test.serial('Escape edycji: bez podpowiedzi anuluje edycję i wysyła nową wiadomość', async t => {
    const { f, view, input, key } = await escapeFixture(t);
    startEditMessage.call(view, 0, 'Historia A');
    key('Escape');
    t.is(hasPendingMessageEdit(f.windows[0]), false);
    input.value = 'Poprawka';
    await send_message.call(view, { meta: { origin: 'human' } });
    t.deepEqual(f.windows[0].messages.filter(m => m.role === 'user').map(m => m.content), ['Historia A', 'Poprawka']);
});

for (const kind of ['@', '/'] as const) test.serial(`Escape edycji: ${kind} i wysłanie poprawki`, async t => {
    const { f, view, input, key, open } = await escapeFixture(t);
    startEditMessage.call(view, 0, 'Historia A');
    await open(kind);
    key('Escape');
    t.is(view.mentionAutocomplete!.isOpen, false);
    t.is(view._triggerPopup?.isOpen() ?? false, false);
    t.is(hasPendingMessageEdit(f.windows[0]), true);
    input.value = 'Poprawka';
    await send_message.call(view, { meta: { origin: 'human' } });
    t.deepEqual(f.windows[0].messages.filter(m => m.role === 'user').map(m => m.content), ['Poprawka']);
});
