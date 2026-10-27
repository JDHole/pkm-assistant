import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { SubTaskNotifier, SubTaskRegistry } from '../../sub-agents/index.js';
import { renderSubTaskStrip } from './subTaskStrip.js';
import { _deliverSubTaskResult, send_message } from './chat_streaming.js';
import { RollingWindow } from './RollingWindow.js';
import streamingManager from './StreamingManager.js';
import { createDelegateTool, __test__ as delegateTest } from '../../tools/DelegateTool.js';
import { __test__ as modelsTest } from '../../models/index.js';

class MockClassList {
    values = new Set<string>();
    add(...items: string[]) { for (const item of items) this.values.add(item); }
    remove(...items: string[]) { for (const item of items) this.values.delete(item); }
    contains(name: string) { return this.values.has(name); }
    toggle(name: string, force?: boolean) { if (force ?? !this.values.has(name)) this.values.add(name); else this.values.delete(name); }
}
class MockEl {
    children: MockEl[] = [];
    listeners = new Map<string, Array<(event: any) => void>>();
    classList = new MockClassList();
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    textContent = '';
    disabled = false;
    innerHTML = '';
    style = { setProperty() {}, getPropertyValue() { return ''; } };
    scrollTop = 0;
    scrollHeight = 0;
    clientHeight = 0;
    ownerDocument = { activeElement: null as MockEl | null };
    parentElement: MockEl | null = null;
    tagName = 'DIV';
    get firstChild() { return this.children[0] ?? null; }
    get className() { return [...this.classList.values].join(' '); }
    set className(value: string) { this.classList.values = new Set(value.split(/\s+/).filter(Boolean)); }
    empty() { this.children = []; this.textContent = ''; }
    appendText(text: string) { this.textContent += text; }
    appendChild(child: MockEl) { child.remove(); child.parentElement = this; child.ownerDocument = this.ownerDocument; this.children.push(child); return child; }
    createDiv(opts: any = {}) { return this.make('div', opts); }
    createSpan(opts: any = {}) { return this.make('span', opts); }
    createEl(tag: string, opts: any = {}) { return this.make(tag, opts); }
    make(tag: string, opts: any) {
        const node = new MockEl(); node.tagName = tag.toUpperCase();
        if (opts.cls) node.className = opts.cls;
        if (opts.text) node.textContent = opts.text;
        for (const [key, value] of Object.entries(opts.attr || {})) node.setAttribute(key, String(value));
        return this.appendChild(node);
    }
    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
        if (name === 'data-substrip-id') this.dataset.substripId = value;
        if (name === 'data-substrip-run-id') this.dataset.substripRunId = value;
    }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    removeAttribute(name: string) { delete this.attributes[name]; }
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; }
    scrollIntoView() {}
    addEventListener(type: string, handler: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
    dispatch(type: string) { for (const handler of this.listeners.get(type) || []) handler({ stopPropagation() {}, preventDefault() {} }); }
    contains(target: unknown): boolean { return target === this || this.children.some(child => child.contains(target)); }
    querySelector<T extends MockEl>(selector: string): T | null {
        if (selector.startsWith('.')) return all(this).slice(1).find(node => node.classList.contains(selector.slice(1))) as T | undefined ?? null;
        return null;
    }
    querySelectorAll<T extends MockEl>(selector: string): T[] {
        if (selector === '[data-substrip-id]') return all(this).filter(node => Boolean(node.dataset.substripId)) as T[];
        if (selector === '[data-substrip-run-id]') return all(this).filter(node => Boolean(node.dataset.substripRunId)) as T[];
        if (selector === '[data-subtask-receipt-id]') return all(this).filter(node => node.hasAttribute('data-subtask-receipt-id')) as T[];
        return [];
    }
    focus() { this.ownerDocument.activeElement = this; }
}
function all(node: MockEl): MockEl[] { return [node, ...node.children.flatMap(all)]; }

const origin = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-1', tabKey: 'tab-a' };
const stoppedOutcome = { end: { kind: 'stopped' as const, by: 'user' as const }, completeness: 'partial' as const,
    hasAnswer: false, hasMaterial: true, effects: [] };

function stoppedRun(registry: SubTaskRegistry, id = 'run-stopped', taskOrigin = origin) {
    const task = registry.create({ id, name: 'worker', agentName: taskOrigin.agentName, origin: taskOrigin, background: true });
    registry.attachAbort(task.id, () => {});
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, ...taskOrigin, expandedId: task.id, onToggle() {} });
    const button = all(host).find(node => node.classList.contains('pkm-substrip__stop'));
    if (!button) throw new Error('Brak przycisku Stop');
    button.dispatch('click');
    registry.finish(task, { text: 'ZACHOWANY DOROBEK', toolsUsed: [], durationMs: 1, usage: null,
        stoppedBy: 'abort', outcome: stoppedOutcome });
    return task;
}

function userTurnFixture(registry: SubTaskRegistry, notifier: SubTaskNotifier, taskOrigin = origin, gate?: Promise<void>) {
    const tab = { ...taskOrigin, sessionId: taskOrigin.tabKey, isActive: true };
    const memory = { activeSessionPath: taskOrigin.sessionPath, sessionEpoch: taskOrigin.sessionEpoch,
        async appendSessionEvent() { return taskOrigin.sessionPath; } };
    const rw = new RollingWindow();
    const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const model = { modelKey: 'fixture', stream(payload: typeof payloads[number], handlers: { done(response: unknown): void }) {
        payloads.push(payload); handlers.done({ choices: [{ message: { role: 'assistant', content: 'Gotowe' } }] });
    } };
    const view = {
        leaf: { id: `user-stop-${taskOrigin.tabKey}` }, input_area: { value: 'Kontynuuj' }, inputHistory: [],
        rollingWindow: rw, tokenTracker: { record() {} }, chatTabs: [tab],
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
        plugin: { subTaskRegistry: registry, subTaskNotifier: notifier, agentManager: {
            getActiveAgent: () => ({ name: taskOrigin.agentName }), getAgentMemory: () => memory,
            getActiveSystemPromptWithMemory: async () => 'system',
        } },
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_max_iterations: 1, chat_stream_stall_timeout_ms: 0 } } } },
        is_generating: false, set_generating(value: boolean) { this.is_generating = value; },
        showTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
        async _resolveMentions(text: string) { await gate; return { displayText: text, contextText: '' }; },
        async append_message(role: 'user', content: string, _display: unknown, meta: unknown) { await rw.addMessage(role, content, meta as never); },
        async appendToActiveSession() {}, get_chat_model: () => model, _chatResolveTools: () => [],
        _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
        _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {},
        _isTurnActiveTab: () => false, _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
    };
    return { view, rw, payloads, tab };
}

test('Stop biegnącego suba zachowuje wynik, a zdrowy sub nadal dostarcza automatycznie', async t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const autoSentIds: string[] = [];
    const view = { chatTabs: [{ ...origin, sessionId: 'tab-a', isActive: true }],
        _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
        env: { settings: { pkmAssistant: { limits: {} } } }, plugin: { subTaskRegistry: registry },
        send_message: (opts: { meta: { subTaskId: string } }) => { autoSentIds.push(opts.meta.subTaskId); } };
    notifier.setDeliverer(task => _deliverSubTaskResult.call(view as never, task));
    const task = stoppedRun(registry);
    await Promise.resolve();
    t.deepEqual(task.outcome?.end, { kind: 'stopped', by: 'user' });
    t.deepEqual(notifier.pending().map(item => item.id), ['run-stopped']);
    t.deepEqual(autoSentIds, []);
    const healthy = registry.create({ id: 'run-healthy', name: 'worker', agentName: origin.agentName, origin, background: true });
    registry.finish(healthy, { text: 'Gotowe', toolsUsed: [], durationMs: 1, usage: null });
    await Promise.resolve();
    t.deepEqual(autoSentIds, ['run-healthy']);
    t.deepEqual(notifier.pending().map(item => item.id), ['run-stopped']);
});

test.serial('nowa wiadomość użytkownika odbiera zatrzymany wynik w pierwszym zapytaniu', async t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    const oldDocument = (globalThis as Record<string, unknown>).document;
    const oldCreateDiv = (globalThis as Record<string, unknown>).createDiv;
    (globalThis as Record<string, unknown>).document = { createElement: () => new MockEl() };
    (globalThis as Record<string, unknown>).createDiv = () => new MockEl();
    t.teardown(() => { (globalThis as Record<string, unknown>).document = oldDocument;
        (globalThis as Record<string, unknown>).createDiv = oldCreateDiv;
        notifier.dispose(); registry.dispose(); streamingManager.stopStream('user-stop-delivery::Klara'); });
    stoppedRun(registry);
    const tab = { ...origin, sessionId: 'tab-a', isActive: true };
    const memory = { activeSessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch,
        async appendSessionEvent() { return origin.sessionPath; } };
    const rw = new RollingWindow();
    const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const model = { modelKey: 'fixture', stream(payload: typeof payloads[number], handlers: { done(response: unknown): void }) {
        payloads.push(payload); handlers.done({ choices: [{ message: { role: 'assistant', content: 'Gotowe' } }] });
    } };
    const container = new MockEl();
    const view = {
        leaf: { id: 'user-stop-delivery' }, input_area: { value: 'Kontynuuj' }, inputHistory: [],
        rollingWindow: rw, tokenTracker: { record() {} }, chatTabs: [tab], messages_container: container,
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
        plugin: { subTaskRegistry: registry, subTaskNotifier: notifier, agentManager: {
            getActiveAgent: () => ({ name: 'Klara' }), getAgentMemory: () => memory,
            getActiveSystemPromptWithMemory: async () => 'system',
        } },
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_max_iterations: 1, chat_stream_stall_timeout_ms: 0 } } } },
        is_generating: false, set_generating(value: boolean) { this.is_generating = value; },
        showTypingIndicator() {}, resetInputArea() { this.input_area.value = ''; },
        async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
        async append_message(role: 'user', content: string, _display: unknown, meta: unknown) { rw.addMessage(role, content, meta as never); },
        async appendToActiveSession() {}, get_chat_model: () => model, _chatResolveTools: () => [],
        _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
        _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {},
        _isTurnActiveTab: () => true, _scheduleConnectorRedraw() {}, _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
    };
    await send_message.call(view as never, { meta: { origin: 'human' } });
    t.is(payloads.length, 1);
    t.true(payloads[0].messages.some(message => message.role === 'user' && message.content === 'Kontynuuj'));
    t.true(payloads[0].messages.some(message => message.role === 'user' && String(message.content).includes('ZACHOWANY DOROBEK')));
    const userMessage = rw.messages.find(message => message.content === 'Kontynuuj');
    const resultMessage = rw.messages.find(message => String(message.content).includes('ZACHOWANY DOROBEK'));
    t.is((userMessage as { origin?: string } | undefined)?.origin, 'human');
    t.is((resultMessage as { origin?: string } | undefined)?.origin, 'machine');
    const resultTiles = all(container).filter(node => node.classList.contains('cs-tile--system'));
    t.is(resultTiles.length, 1);
    t.true(all(resultTiles[0]).some(node => node.classList.contains('cs-tile__title') && node.textContent.includes('worker')));
    t.deepEqual(notifier.pending().map(item => item.id), []);
    notifier.drain();
    t.is(rw.messages.filter(message => String(message.content).includes('ZACHOWANY DOROBEK')).length, 1);
});

test('zapis zatrzymanego wyniku przekazuje zamrożoną epokę sesji', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); streamingManager.stopStream('user-stop-tab-a::Klara'); });
    stoppedRun(registry);
    const { view, rw } = userTurnFixture(registry, notifier);
    let currentEpoch = 'epoch-1';
    const attempts: Array<{ path: string; expectedEpoch: string | null | undefined }> = [];
    const persisted: string[] = [];
    const memory = { activeSessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch,
        async appendSessionEvent(path: string, event: { content: string }, expectedEpoch?: string | null) {
            attempts.push({ path, expectedEpoch });
            if (expectedEpoch !== currentEpoch) throw new Error('epoch mismatch');
            persisted.push(event.content);
            return path;
        } };
    Object.assign(view.plugin.agentManager, { getAgentMemory: () => memory });
    view.plugin.agentManager.getActiveSystemPromptWithMemory = async () => { currentEpoch = 'epoch-2'; return 'system'; };
    await send_message.call(view as never, { meta: { origin: 'human' } });
    t.deepEqual(attempts, [{ path: 'active.md', expectedEpoch: 'epoch-1' }]);
    t.deepEqual(persisted, []);
    t.true(rw.messages.some(message => String(message.content).includes('ZACHOWANY DOROBEK')));
    t.deepEqual(notifier.pending(), []);
});

test('Stop użytkownika po wcześniejszym Stopie prowadzącego nadal zatrzymuje auto-doręczenie', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const autoSentIds: string[] = [];
    const view = { chatTabs: [{ ...origin, sessionId: 'tab-a', isActive: true }],
        _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
        env: { settings: { pkmAssistant: { limits: {} } } }, plugin: { subTaskRegistry: registry },
        send_message: (opts: { meta: { subTaskId: string } }) => { autoSentIds.push(opts.meta.subTaskId); } };
    notifier.setDeliverer(task => _deliverSubTaskResult.call(view as never, task));
    const task = registry.create({ id: 'run-stopped', name: 'worker', agentName: origin.agentName, origin, background: true });
    registry.attachAbort(task.id, () => {});
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, ...origin, expandedId: task.id, onToggle() {} });
    const stop = all(host).find(node => node.classList.contains('pkm-substrip__stop'));
    if (!stop) throw new Error('Brak przycisku Stop');
    t.true(registry.requestStop(task.id, 'lead'));
    stop.dispatch('click');
    registry.finish(task, { text: 'ZACHOWANY DOROBEK', toolsUsed: [], durationMs: 1, usage: null,
        stoppedBy: 'abort', outcome: { ...stoppedOutcome, end: { kind: 'stopped', by: 'lead' } } });
    await Promise.resolve();
    t.is(task.stopRequestedBy, 'lead');
    t.deepEqual(notifier.pending().map(item => item.id), ['run-stopped']);
    t.deepEqual(autoSentIds, []);
});

test('Stop rezerwacji queued zachowuje wynik rozliczony po rozpoczęciu następnej tury', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const autoSentIds: string[] = [];
    const view = { chatTabs: [{ ...origin, sessionId: 'tab-a', isActive: true }],
        _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
        env: { settings: { pkmAssistant: { limits: {} } } }, plugin: { subTaskRegistry: registry },
        send_message: (opts: { meta: { subTaskId: string } }) => { autoSentIds.push(opts.meta.subTaskId); } };
    notifier.setDeliverer(task => _deliverSubTaskResult.call(view as never, task));
    const thread = registry.createThread({ threadId: 'queued-stop', name: 'worker', owner: origin, origin, config: {}, phase: 'queued' });
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, ...origin, expandedId: thread.threadId, onToggle() {} });
    const stop = all(host).find(node => node.classList.contains('pkm-substrip__stop'));
    if (!stop) throw new Error('Brak przycisku Stop');
    stop.dispatch('click');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const turn = userTurnFixture(registry, notifier, origin, gate);
    const sending = send_message.call(turn.view as never, { meta: { origin: 'human' } });
    registry.finishQueuedStop(thread.threadId, { background: true });
    await Promise.resolve();
    t.is(thread.phase, 'closed');
    t.deepEqual(registry.getTask('queued-stop')?.outcome?.end, { kind: 'stopped', by: 'user' });
    t.deepEqual(notifier.pending().map(item => item.id), ['queued-stop']);
    t.deepEqual(autoSentIds, []);
    release();
    await sending;
    t.is(turn.payloads.length, 1);
    t.true(turn.rw.messages.some(message => (message as { subTaskId?: string }).subTaskId === 'queued-stop'));
    t.deepEqual(notifier.pending().map(item => item.id), []);
    streamingManager.stopStream('user-stop-tab-a::Klara');
});

test('nowa tura odbiera tylko wyniki swojej sesji i epoki, nie narusza szkicu B', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); streamingManager.stopStream('user-stop-tab-a::Klara'); });
    const bOrigin = { agentName: 'B', sessionPath: 'b.md', sessionEpoch: 'epoch-b', tabKey: 'tab-b' };
    stoppedRun(registry, 'a1');
    stoppedRun(registry, 'a2');
    stoppedRun(registry, 'b1', bOrigin);
    const otherEpoch = userTurnFixture(registry, notifier, { ...origin, sessionEpoch: 'epoch-2' });
    await send_message.call(otherEpoch.view as never, { meta: { origin: 'human' } });
    t.deepEqual(notifier.pending().map(item => item.id), ['a1', 'a2', 'b1']);
    t.deepEqual(otherEpoch.rw.messages.filter(message => (message as { subTaskId?: string }).subTaskId).map(message => (message as { subTaskId?: string }).subTaskId), []);
    const turn = userTurnFixture(registry, notifier);
    const tabB = { ...bOrigin, sessionId: 'tab-b', isActive: false };
    turn.view.chatTabs.push(tabB);
    const viewB = userTurnFixture(registry, notifier, bOrigin).view;
    viewB.input_area.value = 'SZKIC B';
    viewB.chatTabs = turn.view.chatTabs;
    await send_message.call(turn.view as never, { meta: { origin: 'human' } });
    t.deepEqual(turn.rw.messages.filter(message => (message as { subTaskId?: string }).subTaskId).map(message => (message as { subTaskId?: string }).subTaskId), ['a1', 'a2']);
    t.deepEqual(notifier.pending().map(item => item.id), ['b1']);
    t.is(viewB.input_area.value, 'SZKIC B');
});

test('błąd addMessage przed dołączeniem zwalnia wynik do kolejnej tury', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); streamingManager.stopStream('user-stop-tab-a::Klara'); });
    stoppedRun(registry);
    const first = userTurnFixture(registry, notifier);
    const originalAdd = first.rw.addMessage.bind(first.rw);
    first.rw.addMessage = async (role, content, meta = {}) => {
        if ((meta as { subTaskId?: string }).subTaskId === 'run-stopped') throw new Error('addMessage failed');
        await originalAdd(role, content, meta);
    };
    await send_message.call(first.view as never, { meta: { origin: 'human' } });
    t.is(first.payloads.length, 1);
    t.deepEqual(first.rw.messages.filter(message => (message as { subTaskId?: string }).subTaskId).map(message => (message as { subTaskId?: string }).subTaskId), []);
    t.deepEqual(notifier.pending().map(item => item.id), ['run-stopped']);
    const retry = userTurnFixture(registry, notifier);
    await send_message.call(retry.view as never, { meta: { origin: 'human' } });
    t.deepEqual(retry.rw.messages.filter(message => (message as { subTaskId?: string }).subTaskId).map(message => (message as { subTaskId?: string }).subTaskId), ['run-stopped']);
    t.deepEqual(notifier.pending().map(item => item.id), []);
});

test.serial('błąd renderu po dołączeniu nie powiela wyniku i oznacza zakładkę do odświeżenia', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    const oldDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement() { throw new Error('render failed'); } };
    t.teardown(() => { (globalThis as Record<string, unknown>).document = oldDocument;
        notifier.dispose(); registry.dispose(); streamingManager.stopStream('user-stop-tab-a::Klara'); });
    stoppedRun(registry);
    const turn = userTurnFixture(registry, notifier);
    turn.view._isTurnActiveTab = () => true;
    await send_message.call(turn.view as never, { meta: { origin: 'human' } });
    t.is(turn.payloads.length, 1);
    t.true(turn.payloads[0].messages.some(message => String(message.content).includes('ZACHOWANY DOROBEK')));
    t.deepEqual(turn.rw.messages.filter(message => (message as { subTaskId?: string }).subTaskId).map(message => (message as { subTaskId?: string }).subTaskId), ['run-stopped']);
    t.deepEqual(notifier.pending().map(item => item.id), []);
    t.is((turn.tab as { _needsRefresh?: boolean })._needsRefresh, true);
    notifier.drain();
    t.deepEqual(turn.rw.messages.filter(message => (message as { subTaskId?: string }).subTaskId).map(message => (message as { subTaskId?: string }).subTaskId), ['run-stopped']);
});

test.serial('przełączenie zakładki podczas renderu nie dopisuje ramki do B', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    const oldDocument = (globalThis as Record<string, unknown>).document;
    const turn = userTurnFixture(registry, notifier);
    const tabB = { agentName: 'B', sessionPath: 'b.md', sessionEpoch: 'epoch-b', tabKey: 'tab-b', sessionId: 'tab-b', isActive: false };
    turn.view.chatTabs.push(tabB);
    const container = new MockEl();
    Object.assign(turn.view, { messages_container: container, _scheduleConnectorRedraw() {} });
    turn.view._isTurnActiveTab = () => turn.tab.isActive;
    let created = 0;
    (globalThis as Record<string, unknown>).document = { createElement() {
        const node = new MockEl();
        if (created++ === 0) {
            const append = node.appendChild.bind(node);
            node.appendChild = child => {
                const result = append(child);
                turn.tab.isActive = false;
                tabB.isActive = true;
                return result;
            };
        }
        return node;
    } };
    t.teardown(() => { (globalThis as Record<string, unknown>).document = oldDocument;
        notifier.dispose(); registry.dispose(); streamingManager.stopStream('user-stop-tab-a::Klara'); });
    stoppedRun(registry);
    await send_message.call(turn.view as never, { meta: { origin: 'human' } });
    t.is(tabB.isActive, true);
    t.deepEqual(all(container).filter(node => node.classList.contains('cs-tile--system')), []);
    t.deepEqual(turn.rw.messages.filter(message => (message as { subTaskId?: string }).subTaskId).map(message => (message as { subTaskId?: string }).subTaskId), ['run-stopped']);
    t.deepEqual(notifier.pending().map(item => item.id), []);
    t.is((turn.tab as { _needsRefresh?: boolean })._needsRefresh, true);
});

for (const late of ['error', 'done'] as const) {
    test.serial(`Stop w prawdziwej syntezie zachowuje dorobek przy późnym ${late}`, async t => {
        delegateTest._resetBackground();
        const registry = new SubTaskRegistry();
        const notifier = new SubTaskNotifier({ registry });
        t.teardown(() => { notifier.dispose(); registry.dispose(); });
        type Handlers = { done(response: unknown): void; error(error: Error): void };
        const requests: Handlers[] = [];
        class Model {
            modelId = 'worker-model'; providerId = 'ollama';
            _streamGateLimit() { return 1; }
            stream(_payload: unknown, handlers: Handlers) { requests.push(handlers); }
            stopStream() {}
        }
        modelsTest.setChatModelFactory(() => new Model() as never);
        const providerIds = ['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'];
        const providers = Object.fromEntries(providerIds.map(id => [id, { info: { id } }]));
        const read = { name: 'read', description: 'read', inputSchema: {}, execute: async () => 'ZACHOWANY DOROBEK' };
        const autoSentIds: string[] = [];
        const plugin = { subTaskRegistry: registry,
            toolRegistry: { filterByAgent: () => [read], getTool: (name: string) => name === 'read' ? read : null },
            agentManager: { getActiveAgent: () => ({ name: origin.agentName, activeSubAgents: [] }) },
            env: { config: { chat: { providers,
                http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) },
                transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
                settings: { pkmAssistant: { chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                    limits: { max_parallel_delegations: 5, subagent_max_iterations_worker: 1 } } } } };
        const view = { chatTabs: [{ ...origin, sessionId: 'tab-a', isActive: true }],
            _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
            env: { settings: { pkmAssistant: { limits: {} } } }, plugin,
            send_message: (opts: { meta: { subTaskId: string } }) => { autoSentIds.push(opts.meta.subTaskId); } };
        notifier.setDeliverer(task => _deliverSubTaskResult.call(view as never, task));
        const receipt = await createDelegateTool({}).execute({ task: 'Odczytaj', _invocationOrigin: origin }, {}, plugin as never) as { task_id: string; sub_id: string };
        const waitUntil = async (predicate: () => boolean) => {
            const deadline = Date.now() + 3000;
            while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        };
        await waitUntil(() => requests.length === 1);
        t.is(requests.length, 1);
        requests[0].done({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ] } }] });
        await waitUntil(() => requests.length === 2);
        t.is(requests.length, 2);
        const task = registry.getTask(receipt.task_id)!;
        t.is(task.partial?.synthesis, 'pending');
        const host = new MockEl();
        renderSubTaskStrip(host as never, { plugin, ...origin, expandedId: receipt.sub_id, onToggle() {} });
        const stop = all(host).find(node => node.classList.contains('pkm-substrip__stop'));
        if (!stop) throw new Error('Brak przycisku Stop');
        stop.dispatch('click');
        if (late === 'error') requests[1].error(Object.assign(new Error('aborted'), { _aborted: true }));
        else requests[1].done({ choices: [{ message: { role: 'assistant', content: 'ODPOWIEDŹ PO STOPIE' } }] });
        await waitUntil(() => task.status !== 'running');
        t.deepEqual(task.outcome?.end, { kind: 'stopped', by: 'user' });
        t.true(JSON.stringify(task.result).includes('ZACHOWANY DOROBEK') || JSON.stringify(task.partial).includes('ZACHOWANY DOROBEK'));
        t.deepEqual(notifier.pending().map(item => item.id), [receipt.task_id]);
        t.deepEqual(autoSentIds, []);
    });
}
