import { planInput, planOwner, planResult, activatePlanTask } from '../../sub-agents/test-support/planFixture.js';
import test from 'ava';
import { register } from 'node:module';
import { renderSubTaskStrip } from './subTaskStrip.js';
import { SubTaskRegistry, SubTaskNotifier, buildStripModel, summarizeStripRows } from '../../sub-agents/index.js';
import { QuestionTestClock } from '../../sub-agents/test-support/questionTestClock.js';
import { DEFAULT_LIMITS } from '../../../config/limits.js';
import { pl as trPl } from '../../../core/i18n/pl.js';
import { pluralCategory, setLocale, t as tr } from '../../../core/i18n/index.js';
import { createDelegateTool } from '../../tools/index.js';
import { __test__ as modelsTest } from '../../models/index.js';

class MockClassList {
    values = new Set<string>();
    add(...items: string[]) { for (const item of items) this.values.add(item); }
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
    ownerDocument = { activeElement: null as MockEl | null };
    parentElement: MockEl | null = null;
    get className() { return [...this.classList.values].join(' '); }
    set className(value: string) { this.classList.values = new Set(value.split(/\s+/).filter(Boolean)); }
    empty() { this.children = []; this.textContent = ''; }
    appendText(text: string) { this.textContent += text; }
    appendChild(child: MockEl) { child.parentElement = this; child.ownerDocument = this.ownerDocument; this.children.push(child); return child; }
    createDiv(opts: any = {}) { return this.make('div', opts); }
    createSpan(opts: any = {}) { return this.make('span', opts); }
    createEl(tag: string, opts: any = {}) { return this.make(tag, opts); }
    make(tag: string, opts: any) {
        const node = new MockEl();
        node.tagName = tag.toUpperCase();
        if (opts.cls) node.className = opts.cls;
        if (opts.text) node.textContent = opts.text;
        for (const [key, value] of Object.entries(opts.attr || {})) node.setAttribute(key, String(value));
        return this.appendChild(node);
    }
    tagName = 'DIV';
    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
        if (name === 'data-substrip-id') this.dataset.substripId = value;
        if (name === 'data-substrip-run-id') this.dataset.substripRunId = value;
    }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    addEventListener(type: string, handler: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
    dispatch(type: string, event: any = {}) { for (const handler of this.listeners.get(type) || []) handler({ stopPropagation() {}, preventDefault() {}, key: '', ...event }); }
    contains(target: unknown): boolean { return target === this || this.children.some(child => child.contains(target)); }
    querySelector<T extends MockEl>(selector: string): T | null {
        const id = selector.match(/data-substrip-id="(.*)"/)?.[1];
        for (const child of this.children) {
            if (id && child.dataset.substripId === id) return child as T;
            if (selector === '.pkm-substrip__stop' && child.classList.values.has('pkm-substrip__stop')) return child as T;
            const nested = child.querySelector<T>(selector); if (nested) return nested;
        }
        return null;
    }
    querySelectorAll<T extends MockEl>(selector: string): T[] {
        if (selector === '[data-substrip-control]') return all(this).filter(node => Boolean(node.attributes['data-substrip-control'])) as T[];
        if (selector === '[data-substrip-id]') return all(this).filter(node => Boolean(node.dataset.substripId)) as T[];
        if (selector === '[data-substrip-run-id]') return all(this).filter(node => Boolean(node.dataset.substripRunId)) as T[];
        return [];
    }
    focus() { this.ownerDocument.activeElement = this; }
}

function textTree(node: MockEl): string { return [node.textContent, ...node.children.map(textTree)].join(' '); }
function all(node: MockEl): MockEl[] { return [node, ...node.children.flatMap(all)]; }

const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-1' };

test.serial('zdarzenia zegara od razu przerysowują pasek', t => {
    setLocale('pl');
    const oldWindow = globalThis.window; const oldObserver = globalThis.MutationObserver;
    (globalThis as Record<string, unknown>).window = { setInterval: () => 1, clearInterval() {} };
    (globalThis as Record<string, unknown>).MutationObserver = class { observe() {} disconnect() {} };
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    try {
        registry.createThread({ threadId: 's-clock', name: 'worker', owner, origin: owner, config: {} });
        registry.create({ id: 'r-clock', threadId: 's-clock', name: 'worker', origin: owner });
        registry.openParentQuestion('r-clock', 'Jaki zakres?');
        const host = new MockEl(); Object.assign(host, { isConnected: true });
        renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
        t.true(textTree(host).includes('pyta prowadzącego'));
        const release = registry.registerUserWait(owner, () => {});
        t.true(textTree(host).includes('czeka na Ciebie'));
        release();
        t.true(textTree(host).includes('pyta prowadzącego'));
    } finally {
        registry.dispose(); globalThis.window = oldWindow; globalThis.MutationObserver = oldObserver; setLocale('en');
    }
});

test('obecny pasek renderuje czekający bieg', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    registry.createThread({ threadId: 's1', name: 'worker', owner, origin: owner, config: {} });
    const task = registry.create({ id: 'r1', threadId: 's1', name: 'worker', agentName: owner.agentName, origin: owner, background: true });
    registry.openParentQuestion('r1', 'Jaki zakres?');
    if (task.questionState?.kind !== 'waiting') throw new Error('Brak pytania');
    task.questionState.clock = { kind: 'ticking', remainingMs: 252000, since: performance.now() };
    const model = buildStripModel({ tasks: registry.list(), threads: registry.listThreads(owner), ...owner });
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: 's1', onToggle() {} });
    t.deepEqual({ chips: all(host).filter(node => node.classList.contains('pkm-substrip__chip')).length,
        running: model.filter(row => row.state.kind === 'running').length,
        stopButtons: all(host).filter(node => node.classList.contains('pkm-substrip__stop')).length },
    { chips: 1, running: 1, stopButtons: 1 });
    t.true(all(host).some(node => node.classList.contains('pkm-substrip__chip--question-ticking')));
    t.true(textTree(host).includes('pyta prowadzącego · 4:12'));
    t.true(textTree(host).includes('zostało 4:12 z 5 min'));
    t.true(textTree(host).includes('Jaki zakres?'));
    t.false(all(host).some(node => ['INPUT', 'TEXTAREA'].includes(node.tagName)));
    task.questionState.clock = { kind: 'paused', remainingMs: 252000 };
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: 's1', onToggle() {} });
    t.true(all(host).some(node => node.classList.contains('pkm-substrip__chip--question-paused')));
    t.true(textTree(host).includes('czeka na Ciebie'));
    t.true(textTree(host).includes('Czeka na Twoją odpowiedź'));
    const question = task.questionState.question;
    registry.finish(task, { text: '', toolsUsed: [], durationMs: 1, usage: null,
        outcome: { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } });
    task.questionState = { kind: 'closed', question, resolution: { kind: 'no-answer' } };
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: 's1', onToggle() {} });
    t.true(all(host).some(node => node.classList.contains('pkm-substrip__chip--no-answer')));
    t.true(textTree(host).includes('bez odpowiedzi · częściowy'));
    t.true(textTree(host).includes('Otwarte pytanie: Jaki zakres?'));
    t.true(textTree(host).includes('brak odpowiedzi'));
    registry.dispose();
    setLocale('en');
});

test('karta pustego biegu pokazuje przyczynę i brak wyniku', t => {
    setLocale('pl');
    const ends = [
        [{ kind: 'stopped', by: 'user' }, 'zatrzymany przez Ciebie'],
        [{ kind: 'stopped', by: 'lead' }, 'zatrzymany przez agenta'],
        [{ kind: 'stopped', by: 'system' }, 'zatrzymany przez system'],
        [{ kind: 'limit', reason: 'iteration-limit' }, 'skończył mu się budżet kroków'],
        [{ kind: 'timeout' }, 'przekroczył czas'],
    ] as const;
    for (const [end, label] of ends) {
        const registry = new SubTaskRegistry();
        const run = registry.create({ id: label, name: 'worker', agentName: owner.agentName, origin: owner });
        registry.finish(run, { text: '', toolsUsed: [], durationMs: 1, usage: null,
            outcome: { end, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } });
        const host = new MockEl();
        renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: label, onToggle() {} });
        const state = all(host).find(node => node.classList.contains('pkm-substrip__run-state'));
        t.true(state?.textContent.includes(label), state?.textContent);
        t.true(state?.textContent.includes('brak wyniku'), state?.textContent);
        registry.dispose();
    }
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'queued-stop', name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    registry.stopThread('queued-stop');
    registry.finishQueuedStop('queued-stop', { background: true });
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: 'queued-stop', onToggle() {} });
    const state = all(host).find(node => node.classList.contains('pkm-substrip__run-state'));
    t.is(state?.textContent, 'zatrzymany przez Ciebie · brak wyniku');
    registry.dispose();
});

test.serial('retencja 60 delegacji zachowuje 50 wierszy i trzy wątki idle', async t => {
    const registry = new SubTaskRegistry({ maxDone: 50 });
    const { SubTaskNotifier } = await import('../../sub-agents/index.js');
    const notifier = new SubTaskNotifier({ registry });
    const delivered: string[] = [];
    notifier.setDeliverer(task => { delivered.push(task.id); return true; });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    class Model {
        modelId = 'worker-model'; providerId = 'ollama';
        stream(_payload: unknown, handlers: { done(value: unknown): void }) { handlers.done({ choices: [{ message: { role: 'assistant', content: 'gotowe' } }] }); }
    }
    modelsTest.setChatModelFactory(() => new Model() as never);
    const providers = Object.fromEntries(['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'].map(id => [id, { info: { id } }]));
    const plugin = {
        subTaskRegistry: registry, toolRegistry: { filterByAgent: () => [], getTool: () => undefined },
        agentManager: { getActiveAgent: () => ({ name: 'Klara', activeSubAgents: [] }) },
        env: { config: { chat: { providers, http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) }, transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
            settings: { pkmAssistant: { chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } }, modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] } } } },
    };
    const tool = createDelegateTool({});
    for (let i = 0; i < 60; i++) {
        const receipt = await tool.execute({ task: `zadanie ${i}`, aspect: 'worker', _invocationOrigin: owner }, {}, plugin as never) as { sub_id: string };
        const deadline = Date.now() + 3000;
        while (registry.getThread(receipt.sub_id)?.phase === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
        t.is(registry.getThread(receipt.sub_id)?.phase, 'idle');
    }
    const threads = registry.listThreads(owner);
    const host = new MockEl();
    const count = renderSubTaskStrip(host as never, { plugin, tabKey: 'Klara', ...owner, onToggle() {} });
    t.is(delivered.length, 60);
    t.is(threads.length, 50);
    t.is(count, 50);
    t.deepEqual(threads.slice(-3).map(thread => thread.phase), ['idle', 'idle', 'idle']);
    registry.closeSessionThreads(owner.agentName, owner.sessionPath);
    registry.pruneSession(owner.sessionPath);
    t.deepEqual(registry.listThreads(owner), []);
});

test('zamknięcie po wyparciu biegu usuwa wątek i wiersz, zachowując aktywne i kolejkę', t => {
    const registry = new SubTaskRegistry({ maxDone: 50 });
    t.teardown(() => registry.dispose());
    const other = { ...owner, sessionPath: 'other.md' };
    registry.createThread({ threadId: 'old', name: 'worker', owner, origin: owner, config: { marker: 'old' }, phase: 'running' });
    const old = registry.create({ id: 'old-run', name: 'worker', agentName: owner.agentName, threadId: 'old', origin: owner });
    registry.finish(old, { text: 'old', toolsUsed: [], durationMs: 1, usage: null });
    registry.endRun('old', { successful: true });
    t.is(registry.getThread('old')?.phase, 'idle');
    for (let i = 0; i < 51; i++) {
        const run = registry.create({ id: `new-${i}`, name: 'worker', agentName: other.agentName, origin: other });
        registry.finish(run, { text: 'new', toolsUsed: [], durationMs: 1, usage: null });
    }
    t.is(registry.getTask('old-run'), undefined);
    registry.createThread({ threadId: 'running', name: 'worker', owner, origin: owner, config: {}, phase: 'running' });
    registry.createThread({ threadId: 'idle', name: 'worker', owner, origin: owner, config: {}, phase: 'running' });
    registry.endRun('idle', { successful: true });
    registry.createThread({ threadId: 'queued', name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    registry.closeThread('queued');
    let oldVisibleAtClose = true;
    registry.events.on('thread:closed', () => { oldVisibleAtClose = Boolean(registry.getThread('old')); });
    t.true(registry.closeThread('old'));
    t.is(registry.getThread('old'), undefined);
    t.false(oldVisibleAtClose);
    t.is(registry.getThread('running')?.phase, 'running');
    t.is(registry.getThread('idle')?.phase, 'idle');
    t.is(registry.getThread('queued')?.phase, 'closed');
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
    t.false(all(host).some(node => node.dataset.substripId === 'old'));
    t.is(registry.finishQueuedStop('queued', {})?.id, 'queued');
});

test.serial('mixin UI: zdarzenie i 250 ms zachowują szkic, fokus, scroll i rozwinięcie', async t => {
    // Node nie ładuje modułu CSS. Hak zastępuje tylko arkusz, nie kod UI.
    const hook = `export async function load(url, context, next) {
        if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' };
        return next(url, context);
    }`;
    register(`data:text/javascript,${encodeURIComponent(hook)}`);
    const ui = await import('./chat_ui.js');
    const registry = new SubTaskRegistry();
    const host = new MockEl();
    const input = Object.assign(new MockEl(), { value: 'Szkic wiadomości', selectionStart: 2, selectionEnd: 8 });
    input.ownerDocument = host.ownerDocument;
    input.focus();
    const messages = { scrollTop: 120 };
    let timer: (() => void) | null = null;
    let delay = 0;
    const oldWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        setTimeout(fn: () => void, ms: number) { timer = fn; delay = ms; return 1; },
        clearTimeout() { timer = null; },
    } });
    const view = {
        _subStripContainer: host, _subStripExpandedId: null as string | null, _subStripUnsubs: [] as Array<() => void>, _subStripTimer: null,
        chatTabs: [{ agentName: owner.agentName, sessionEpoch: owner.sessionEpoch, sessionId: 'tab-a', isActive: true }],
        plugin: { subTaskRegistry: registry, agentManager: { getActiveMemory: () => ({ activeSessionPath: owner.sessionPath }) } },
        input_area: input, messages_container: messages,
        _renderSubTaskStrip() { ui._renderSubTaskStrip.call(view as never); },
    };
    t.teardown(() => { ui._unwireSubTaskStrip.call(view as never); registry.dispose(); Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow }); });
    const run = registry.create({ id: 'timer-run', name: 'worker', agentName: owner.agentName, origin: { ...owner, tabKey: 'tab-a' } });
    ui._wireSubTaskStrip.call(view as never);
    view._renderSubTaskStrip();
    host.querySelector<MockEl>('[data-substrip-id="timer-run"]')!.dispatch('click');
    registry.step(run, 'tool.pre', { tool: 'read', detail: 'plan.md' });
    t.is(delay, 250);
    t.is(typeof timer, 'function');
    (timer as unknown as () => void)();
    t.is(host.querySelector<MockEl>('[data-substrip-id="timer-run"]')!.attributes['aria-expanded'], 'true');
    t.true(textTree(host).includes('plan.md'));
    t.is(input.value, 'Szkic wiadomości');
    t.is(input.selectionStart, 2);
    t.is(input.selectionEnd, 8);
    t.is(host.ownerDocument.activeElement, input);
    t.is(messages.scrollTop, 120);
    host.querySelector<MockEl>('[data-substrip-id="timer-run"]')!.dispatch('click');
    registry.step(run, 'tool.pre', { tool: 'read', detail: 'kolejny.md' });
    (timer as unknown as () => void)();
    t.is(host.querySelector<MockEl>('[data-substrip-id="timer-run"]')!.attributes['aria-expanded'], 'false');
});

test('integracja paska: kolejka przelicza pozycje po starcie i Stopie', t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    const host = new MockEl();
    for (const id of ['q1', 'q2', 'q3']) registry.createThread({ threadId: id, name: id, owner, origin: owner, config: {}, phase: 'queued' });
    const render = (expandedId: string | null = null) => renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId, onToggle() {} });
    const positions = () => buildStripModel({ tasks: registry.list(), threads: registry.listThreads(owner), ...owner })
        .filter(row => row.state.kind === 'queued').map(row => `${row.id}:${row.state.kind === 'queued' ? row.state.position : ''}`);
    const labels = () => all(host).filter(node => node.classList.contains('pkm-substrip__queue')).map(node => node.textContent);
    render();
    t.deepEqual(positions(), ['q1:1', 'q2:2', 'q3:3']);
    t.deepEqual(labels(), [tr('chat.substrip.queue_position', { position: '1' }), tr('chat.substrip.queue_position', { position: '2' }), tr('chat.substrip.queue_position', { position: '3' })]);
    t.true(registry.beginQueuedRun('q1', owner, {}));
    registry.create({ id: 'run-q1', name: 'q1', agentName: owner.agentName, threadId: 'q1' });
    render('q2');
    t.deepEqual(positions(), ['q2:1', 'q3:2']);
    t.deepEqual(labels(), [tr('chat.substrip.queue_position', { position: '1' }), tr('chat.substrip.queue_position', { position: '2' })]);
    all(host).find(node => node.classList.contains('pkm-substrip__stop'))!.dispatch('click');
    render();
    t.is(registry.getThread('q2')?.phase, 'closed');
    t.deepEqual(positions(), ['q3:1']);
    t.deepEqual(labels(), [tr('chat.substrip.queue_position', { position: '1' })]);
    t.deepEqual(host.querySelectorAll('[data-substrip-id]').map(node => node.dataset.substripId), ['q1', 'q2', 'q3']);
});

test('integracja paska: postęp i kolejność trzech wątków po zmianie fazy', t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    const host = new MockEl();
    for (const id of ['alpha', 'beta']) {
        registry.createThread({ threadId: id, name: id, owner, origin: owner, config: {} });
        registry.create({ id: `${id}-run`, name: id, agentName: owner.agentName, threadId: id });
    }
    registry.step(registry.getTask('alpha-run')!, 'tool.pre', { tool: 'read', detail: 'alpha.md' });
    registry.step(registry.getTask('beta-run')!, 'tool.pre', { tool: 'read', detail: 'beta.md' });
    registry.step(registry.getTask('beta-run')!, 'tool.pre', { tool: 'read', detail: 'drugi.md' });
    registry.createThread({ threadId: 'gamma', name: 'gamma', owner, origin: owner, config: {}, phase: 'queued' });
    const render = (id?: string) => renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: id, onToggle() {} });
    const ids = () => host.querySelectorAll('[data-substrip-id]').map(node => node.dataset.substripId);
    const state = () => all(host).filter(node => node.classList.contains('pkm-substrip__state')).map(node => node.textContent);
    render('alpha');
    t.deepEqual(ids(), ['alpha', 'beta', 'gamma']);
    t.deepEqual(state(), [tr('chat.substrip.state_running'), tr('chat.substrip.state_running'), tr('chat.substrip.state_queued')]);
    t.true(textTree(host).includes('alpha.md'));
    t.true(textTree(host).includes(tr('chat.substrip.heading_steps_live')));
    render('beta');
    t.true(textTree(host).includes('beta.md'));
    t.true(textTree(host).includes('drugi.md'));
    registry.finish(registry.getTask('alpha-run')!, { text: 'wynik alpha', toolsUsed: [], durationMs: 1, usage: null, outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
    registry.endRun('alpha', { successful: true });
    render();
    t.deepEqual(ids(), ['alpha', 'beta', 'gamma']);
    t.deepEqual(state(), [tr('chat.substrip.state_idle'), tr('chat.substrip.state_running'), tr('chat.substrip.state_queued')]);
});

test('integracja paska: przełączenie właściciela A B A filtruje chipy', t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    const host = new MockEl();
    const other = { agentName: 'Jan', sessionPath: 'jan.md', sessionEpoch: 'epoch-2' };
    registry.createThread({ threadId: 'a1', name: 'a1', owner, origin: owner, config: {}, phase: 'queued' });
    registry.createThread({ threadId: 'a2', name: 'a2', owner, origin: owner, config: {}, phase: 'queued' });
    registry.createThread({ threadId: 'b1', name: 'b1', owner: other, origin: other, config: {}, phase: 'queued' });
    const show = (active: typeof owner) => {
        renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: active.agentName, ...active, onToggle() {} });
        return host.querySelectorAll('[data-substrip-id]').map(node => node.dataset.substripId);
    };
    t.deepEqual(show(owner), ['a1', 'a2']);
    t.deepEqual(show(other), ['b1']);
    t.deepEqual(show(owner), ['a1', 'a2']);
});

test('integracja paska: klik zachowuje rozwinięcie i zwinięcie po zmianach rejestru', t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    registry.createThread({ threadId: 'open', name: 'worker', owner, origin: owner, config: {} });
    const run = registry.create({ id: 'open-run', name: 'worker', agentName: owner.agentName, threadId: 'open' });
    const host = new MockEl();
    let expanded: string | null = null;
    const render = () => renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: expanded, onToggle(id) { expanded = id; render(); } });
    const chip = () => host.querySelector<MockEl>('[data-substrip-id="open"]')!;
    render();
    chip().dispatch('click');
    t.is(chip().attributes['aria-expanded'], 'true');
    registry.step(run, 'tool.pre', { tool: 'read', detail: 'plik.md' });
    registry.endRun('open', { successful: true });
    render();
    t.is(chip().attributes['aria-expanded'], 'true');
    chip().dispatch('click');
    t.is(chip().attributes['aria-expanded'], 'false');
    registry.closeThread('open');
    render();
    t.is(chip().attributes['aria-expanded'], 'false');
});

test('retencja: 50 ostatnich biegów i wszystkie bieżące, 10 ostatnich na pasku', t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    for (let i = 0; i < 52; i++) {
        const task = registry.create({ id: `done-${i}`, name: 'worker', agentName: owner.agentName, origin: owner });
        registry.finish(task, { text: 'wynik', toolsUsed: [], durationMs: 1, usage: null });
        task.endedAt = i + 1;
    }
    registry.create({ id: 'live-a', name: 'worker', agentName: owner.agentName, origin: owner });
    registry.create({ id: 'live-b', name: 'worker', agentName: owner.agentName, origin: owner });
    t.deepEqual(registry.list().map(task => task.id), ['done-2', 'done-3', 'done-4', 'done-5', 'done-6', 'done-7', 'done-8', 'done-9', 'done-10', 'done-11', 'done-12', 'done-13', 'done-14', 'done-15', 'done-16', 'done-17', 'done-18', 'done-19', 'done-20', 'done-21', 'done-22', 'done-23', 'done-24', 'done-25', 'done-26', 'done-27', 'done-28', 'done-29', 'done-30', 'done-31', 'done-32', 'done-33', 'done-34', 'done-35', 'done-36', 'done-37', 'done-38', 'done-39', 'done-40', 'done-41', 'done-42', 'done-43', 'done-44', 'done-45', 'done-46', 'done-47', 'done-48', 'done-49', 'done-50', 'done-51', 'live-a', 'live-b']);
    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
    t.deepEqual(host.querySelectorAll('[data-substrip-id]').map(node => node.dataset.substripId), ['live-a', 'live-b', 'done-51', 'done-50', 'done-49', 'done-48', 'done-47', 'done-46', 'done-45', 'done-44', 'done-43', 'done-42']);
});

test('retencja paska: z 11 zakończonych samodzielnych widać 10 najnowszych', t => {
    setLocale('en');
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    for (let i = 0; i < 11; i++) {
        const task = registry.create({ id: `single-${i}`, name: 'worker', agentName: owner.agentName, origin: owner });
        registry.finish(task, { text: 'wynik', toolsUsed: [], durationMs: 1, usage: null });
        task.endedAt = i + 1;
    }
    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
    t.deepEqual(host.querySelectorAll('[data-substrip-id]').map(node => node.dataset.substripId), ['single-10', 'single-9', 'single-8', 'single-7', 'single-6', 'single-5', 'single-4', 'single-3', 'single-2', 'single-1']);
    t.deepEqual(all(host).find(node => node.classList.contains('pkm-substrip__summary'))!.children.map(node => node.textContent), [
        `${tr('chat.substrip.count_running_other', { count: 0 })}, ${tr('chat.substrip.count_queued_other', { count: 0 })}`,
        tr('chat.substrip.count_total_other', { count: 10 }),
    ]);
});

test.serial('retencja: limity idle i liczby biegów z konfiguracji', t => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    const registry = new SubTaskRegistry();
    t.teardown(() => { Date.now = originalNow; registry.dispose(); });
    const limits = { subagent_thread_idle_ms: DEFAULT_LIMITS.subagent_thread_idle_ms, subagent_thread_max_idle_per_session: DEFAULT_LIMITS.subagent_thread_max_idle_per_session, subagent_thread_max_runs: DEFAULT_LIMITS.subagent_thread_max_runs };
    for (const id of ['idle-1', 'idle-2', 'idle-3', 'idle-4']) {
        registry.createThread({ threadId: id, name: id, owner, origin: owner, config: { limits } });
        registry.create({ id: `${id}-run`, name: id, agentName: owner.agentName, threadId: id });
        registry.endRun(id, { successful: true });
        now++;
    }
    t.deepEqual(['idle-1', 'idle-2', 'idle-3', 'idle-4'].map(id => [registry.getThread(id)?.phase, registry.getThread(id)?.runIds.length]), [['closed', 1], ['idle', 1], ['idle', 1], ['idle', 1]]);
    now += limits.subagent_thread_idle_ms;
    registry.createThread({ threadId: 'trigger', name: 'trigger', owner, origin: owner, config: {} });
    t.deepEqual(['idle-1', 'idle-2', 'idle-3', 'idle-4'].map(id => [registry.getThread(id)?.phase, registry.getThread(id)?.runIds.length]), [['closed', 1], ['closed', 1], ['closed', 1], ['closed', 1]]);
    registry.createThread({ threadId: 'runs', name: 'runs', owner, origin: owner, config: { limits } });
    for (let i = 0; i < limits.subagent_thread_max_runs; i++) {
        if (i) t.true(registry.beginRun('runs', owner));
        registry.create({ id: `runs-${i}`, name: 'runs', agentName: owner.agentName, threadId: 'runs' });
        registry.endRun('runs', { successful: true });
    }
    t.is(registry.getThread('runs')?.phase, 'closed');
    t.is(registry.getThread('runs')?.runIds.length, limits.subagent_thread_max_runs);
});

test('subTaskStrip: pusty model nie tworzy dzieci', t => {
    const host = new MockEl();
    const count = renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: { list: () => [] } }, tabKey: 'Klara', agentName: 'Klara', onToggle() {} });
    t.is(count, 0);
    t.is(host.children.length, 0);
});

test('subTaskStrip: podsumowanie liczy widoczne wiersze i odmienia liczby', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const host = new MockEl();
    for (let i = 0; i < 3; i++) registry.create({ id: `working-${i}`, name: 'worker', agentName: owner.agentName, origin: owner });
    for (let i = 0; i < 2; i++) registry.createThread({ threadId: `queued-${i}`, name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    const render = () => renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
    render();
    let summary = all(host).find(node => node.classList.contains('pkm-substrip__summary'))!;
    t.deepEqual(summary.children.map(node => node.textContent), ['3 pracują, 2 czekają', '5 zadań']);
    for (let i = 2; i < 11; i++) registry.createThread({ threadId: `queued-${i}`, name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    render();
    summary = all(host).find(node => node.classList.contains('pkm-substrip__summary'))!;
    t.deepEqual(summary.children.map(node => node.textContent), ['3 pracują, 11 czeka', '14 zadań']);
    setLocale('en');
    render();
    summary = all(host).find(node => node.classList.contains('pkm-substrip__summary'))!;
    t.deepEqual(summary.children.map(node => node.textContent), ['3 working, 11 waiting', '14 tasks']);
    registry.dispose();
});

test('subTaskStrip: mniej niż pięć wierszy nie pokazuje podsumowania', t => {
    const registry = new SubTaskRegistry();
    for (let i = 0; i < 3; i++) registry.create({ id: `short-${i}`, name: 'worker', agentName: owner.agentName, origin: owner });
    const host = new MockEl();
    t.is(renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} }), 3);
    t.is(all(host).filter(node => node.classList.contains('pkm-substrip__summary')).length, 0);
    registry.dispose();
});

test('subTaskStrip: formy licznika przy liczbach pojedynczych i nastu', t => {
    const keys = {
        one: ['chat.substrip.count_running_one', 'chat.substrip.count_queued_one', 'chat.substrip.count_total_one'],
        few: ['chat.substrip.count_running_few', 'chat.substrip.count_queued_few', 'chat.substrip.count_total_few'],
        many: ['chat.substrip.count_running_many', 'chat.substrip.count_queued_many', 'chat.substrip.count_total_many'],
        other: ['chat.substrip.count_running_other', 'chat.substrip.count_queued_other', 'chat.substrip.count_total_other'],
    } as const;
    const cases = [
        [0, '0 pracuje', '0 czeka', '0 zadań', '0 working', '0 waiting', '0 tasks'],
        [1, '1 pracuje', '1 czeka', '1 zadanie', '1 working', '1 waiting', '1 task'],
        [2, '2 pracują', '2 czekają', '2 zadania', '2 working', '2 waiting', '2 tasks'],
        [4, '4 pracują', '4 czekają', '4 zadania', '4 working', '4 waiting', '4 tasks'],
        [5, '5 pracuje', '5 czeka', '5 zadań', '5 working', '5 waiting', '5 tasks'],
        [12, '12 pracuje', '12 czeka', '12 zadań', '12 working', '12 waiting', '12 tasks'],
        [14, '14 pracuje', '14 czeka', '14 zadań', '14 working', '14 waiting', '14 tasks'],
        [21, '21 pracuje', '21 czeka', '21 zadań', '21 working', '21 waiting', '21 tasks'],
        [22, '22 pracują', '22 czekają', '22 zadania', '22 working', '22 waiting', '22 tasks'],
        [24, '24 pracują', '24 czekają', '24 zadania', '24 working', '24 waiting', '24 tasks'],
        [25, '25 pracuje', '25 czeka', '25 zadań', '25 working', '25 waiting', '25 tasks'],
    ] as const;
    for (const [count, ...expected] of cases) {
        for (const [locale, offset] of [['pl', 0], ['en', 3]] as const) {
            const actual = keys[pluralCategory(count, locale)].map(key => tr(key, { count }, locale));
            t.deepEqual(actual, expected.slice(offset, offset + 3), `${locale}: ${count}`);
        }
    }
});

test('subTaskStrip: chip ma kryształ oraz dwuwierszową kolumnę nazwa, stan', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'chip-thread', name: 'claudzik-researcher', owner, origin: owner, config: {}, phase: 'queued' });
    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
    const chip = all(host).find(node => node.dataset.substripId === 'chip-thread')!;
    t.deepEqual(chip.children.slice(0, 2).map(node => node.className), ['pkm-substrip__crystal', 'pkm-substrip__chip-copy']);
    t.deepEqual(chip.children[1].children.map(node => node.className), ['pkm-substrip__name', 'pkm-substrip__state']);
    t.deepEqual(chip.children[1].children.map(node => node.textContent), ['claudzik-researcher', 'czeka na miejsce']);
    registry.dispose();
    setLocale('en');
});

test('subTaskStrip: rozwinięcie pokazuje sekcje, oś biegów i Stop zatrzymuje bieżący bieg jako user', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const thread = registry.createThread({ threadId: 'thread-panel', name: 'pkm-worker', owner, origin: owner, config: { limits: { subagent_thread_max_runs: 5 } } });
    const first = registry.create({ id: 'run-1', name: 'pkm-worker', agentName: owner.agentName, threadId: thread.threadId, taskPreview: 'Zrób rzecz' });
    registry.step(first, 'tool.pre', { tool: 'read', detail: 'plik.md' });
    registry.finish(first, { text: 'Wynik', toolsUsed: ['read'], durationMs: 20, usage: { prompt_tokens: 12, completion_tokens: 4 }, outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
    registry.beginRun(thread.threadId, owner);
    const second = registry.create({ id: 'run-2', name: 'pkm-worker', agentName: owner.agentName, threadId: thread.threadId, taskPreview: 'Dokończ rzecz' });
    registry.postMessage(second.id, 'sprawdź ten punkt');
    registry.attachAbort(second.id, () => {});
    const stopArgs: unknown[] = [];
    const requestStop = registry.requestStop.bind(registry);
    registry.requestStop = (id, by) => { stopArgs.push(id, by); return requestStop(id, by); };
    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch, expandedId: thread.threadId, onToggle() {} });
    const text = textTree(host);
    for (const heading of ['ZLECENIE', 'KROKI', 'CO POWSTAŁO', 'EFEKTY']) t.true(text.includes(heading));
    t.true(text.includes(trPl['chat.substrip.agent_message']));
    t.true(text.includes(trPl['chat.substrip.read_only']));
    t.true(text.includes('Bieg 1 · Zrób rzecz'));
    t.true(text.includes('Bieg 2 · Dokończ rzecz'));
    const stop = all(host).find(node => node.classList.values.has('pkm-substrip__stop'))!;
    stop.dispatch('click');
    t.deepEqual(stopArgs, [second.id, 'user']);
    t.is(registry.getTask(second.id)?.stopRequested, true);
    t.is(registry.getTask(second.id)?.stopRequestedBy, 'user');
    registry.dispose();
    setLocale('en');
});

test('subTaskStrip: Stop dla wątku queued zamyka go bez próby zatrzymania nieistniejącego biegu', t => {
    const registry = new SubTaskRegistry();
    const thread = registry.createThread({ threadId: 'queued-stop', name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    const requestCalls: string[] = [];
    const original = registry.requestStop.bind(registry);
    registry.requestStop = (id, by) => { requestCalls.push(`${id}:${by}`); return original(id, by); };
    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch, expandedId: thread.threadId, onToggle() {} });
    all(host).find(node => node.classList.values.has('pkm-substrip__stop'))!.dispatch('click');
    t.is(registry.getThread(thread.threadId)?.phase, 'closed');
    t.deepEqual(requestCalls, []);
    registry.dispose();
});

test.serial('subTaskStrip: stary Stop kolejki zatrzymuje rozpoczęty bieg i odrzuca późne narzędzie', async t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    const requests: Array<{ done(value: unknown): void }> = [];
    let aborts = 0;
    let toolCalls = 0;
    class Model {
        modelId = 'worker-model'; providerId = 'ollama';
        _streamGateLimit() { return 1; }
        stream(_payload: unknown, handlers: { done(value: unknown): void }) { requests.push(handlers); }
        stopStream() { aborts++; }
    }
    modelsTest.setChatModelFactory(() => new Model() as never);
    const providers = Object.fromEntries(['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'].map(id => [id, { info: { id } }]));
    const plugin = {
        subTaskRegistry: registry,
        toolRegistry: { filterByAgent: () => [{ name: 'read' }], getTool: () => ({ name: 'read', description: 'read', inputSchema: {}, execute: async () => { toolCalls++; return 'wynik'; } }) },
        agentManager: { getActiveAgent: () => ({ name: 'Klara', activeSubAgents: [] }) },
        env: { config: { chat: { providers, http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) }, transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
            settings: { pkmAssistant: { chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } }, modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] }, limits: { max_parallel_delegations: 5 } } } },
    };
    const receipt = await createDelegateTool({}).execute({ tasks: [{ task: 'pierwsze', aspect: 'worker' }, { task: 'drugie', aspect: 'worker' }], _invocationOrigin: owner }, {}, plugin as never) as { tasks: Array<{ sub_id: string }> };
    t.is(receipt.tasks.length, 2);
    const secondId = receipt.tasks[1].sub_id;
    t.is(registry.getThread(secondId)?.phase, 'queued');
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin, tabKey: 'Klara', ...owner, expandedId: secondId, onToggle() {} });
    const stop = all(host).find(node => node.classList.values.has('pkm-substrip__stop'))!;
    requests[0].done({ choices: [{ message: { content: 'gotowe' } }] });
    const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 3000; while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); };
    await wait(() => requests.length === 2);
    t.is(registry.getThread(secondId)?.phase, 'running');
    t.deepEqual(registry.getThread(secondId)?.config.toolNames, ['read']);
    stop.dispatch('click');
    const abortsAfterClick = aborts;
    requests[1].done({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'late', function: { name: 'read', arguments: '{}' } }] } }] });
    await wait(() => registry.getTask(secondId)?.status !== 'running');
    if (registry.getTask(secondId)?.status === 'running') {
        registry.requestStop(secondId, 'user');
        if (requests[2]) requests[2].done({ choices: [{ message: { content: 'koniec' } }] });
        await wait(() => registry.getTask(secondId)?.status !== 'running');
    }
    t.is(abortsAfterClick, 1);
    t.deepEqual(registry.getTask(secondId)?.outcome?.end, { kind: 'stopped', by: 'user' });
    t.is(toolCalls, 0);
});

test('subTaskStrip: zamknięcie queued przed startem pokazuje syntetyczny pusty bieg w tym samym wątku', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const thread = registry.createThread({ threadId: 'closed-before-start', name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    registry.closeThread(thread.threadId, 'user');
    registry.finishQueuedStop(thread.threadId, { background: true, taskPreview: 'Drugie zadanie' });

    const host = new MockEl();
    const count = renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner,
        expandedId: thread.threadId, onToggle() {} });
    const cards = all(host).filter(node => node.classList.values.has('pkm-substrip__run-card'));

    t.is(count, 1);
    t.true(all(host).some(node => node.classList.values.has('pkm-substrip__chip--closed')));
    t.is(cards.length, 1);
    t.true(textTree(cards[0]).includes('Drugie zadanie'));
    t.true(all(cards[0]).some(node => node.classList.values.has('pkm-substrip__run-state')));
    registry.dispose();
    setLocale('en');
});

test('subTaskStrip: klawiatura rozwija i Escape zwija, aria-expanded jest literalne', t => {
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'thread-key', name: 'worker', owner, origin: owner, config: {} });
    let expanded: string | null = null;
    const host = new MockEl();
    const input = new MockEl();
    input.ownerDocument = host.ownerDocument;
    input.focus();
    const render = () => renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch, expandedId: expanded, onToggle: id => { expanded = id; render(); } });
    render();
    t.is(host.ownerDocument.activeElement, input);
    let chip = all(host).find(node => node.tagName === 'BUTTON')!;
    chip.focus();
    chip.dispatch('keydown', { key: 'Enter' });
    chip.dispatch('click');
    t.is(String(expanded), 'thread-key');
    chip = all(host).find(node => node.tagName === 'BUTTON')!;
    t.is(chip.attributes['aria-expanded'], 'true');
    chip.dispatch('keydown', { key: 'Escape' });
    t.is(expanded, null);
    t.is(host.ownerDocument.activeElement?.dataset.substripId, 'thread-key');
    chip = all(host).find(node => node.tagName === 'BUTTON')!;
    chip.dispatch('keydown', { key: ' ' });
    chip.dispatch('click');
    t.is(String(expanded), 'thread-key');
    registry.dispose();
});

test('subTaskStrip: pionowa oś pokazuje obie karty, a rozwinięcie kroków trwa po przerysowaniu', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'axis-thread', name: 'worker', owner, origin: owner, config: {} });
    const first = registry.create({ id: 'axis-one', name: 'worker', agentName: owner.agentName, origin: owner, threadId: 'axis-thread', taskPreview: 'Pierwsze zlecenie' });
    registry.step(first, 'tool.pre', { tool: 'read', detail: 'pierwszy.md' });
    const effects = [
        { tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'zgodny.md' }], outcome: 'returned' as const, check: 'matches' as const },
        { tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'brak.md' }], outcome: 'returned' as const, check: 'mismatch' as const },
        { tool: 'delete', action: 'delete', targets: [{ kind: 'vault-file' as const, path: 'nadal-jest.md' }], outcome: 'returned' as const, check: 'mismatch' as const },
        { tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'niesprawdzony.md' }], outcome: 'returned' as const, check: 'not-checked' as const },
    ];
    registry.finish(first, { text: 'Pierwszy wynik', toolsUsed: ['read'], durationMs: 1,
        usage: { prompt_tokens: 31, completion_tokens: 7 },
        outcome: { end: { kind: 'finished' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects } });
    registry.endRun('axis-thread', { successful: true, effects: [
        { ...effects[0], expectedCheck: 'exists' }, { ...effects[1], expectedCheck: 'exists' },
        { ...effects[2], expectedCheck: 'absent' }, { ...effects[3], expectedCheck: 'exists' },
    ] });
    registry.beginRun('axis-thread', owner);
    registry.create({ id: 'axis-two', name: 'worker', agentName: owner.agentName, origin: owner, threadId: 'axis-thread', taskPreview: 'Drugie zlecenie' });
    const host = new MockEl();
    const render = () => renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner,
        expandedId: 'axis-thread', onToggle() {} });
    render();
    const cards = all(host).filter(node => node.classList.values.has('pkm-substrip__run-card'));
    t.is(cards.length, 2);
    t.deepEqual(cards.map(card => card.dataset.substripRunId), ['axis-one', 'axis-two']);
    t.true(cards[0].classList.values.has('pkm-substrip__run-card--collapsed'));
    t.true(cards[1].classList.values.has('pkm-substrip__run-card--expanded'));
    t.is(all(cards[1]).find(node => node.classList.values.has('pkm-substrip__section-title') && node.textContent === tr('chat.substrip.heading_steps_live'))?.textContent, 'KROKI NA ŻYWO');
    t.true(textTree(cards[0]).includes('Bieg 1 · Pierwsze zlecenie'));
    t.true(textTree(cards[1]).includes('Bieg 2 · Drugie zlecenie'));
    t.true(textTree(cards[0]).includes('wynik częściowy'));
    t.true(textTree(cards[1]).includes('pracuje'));
    t.is(all(cards[0]).filter(node => node.classList.values.has('pkm-substrip__stop')).length, 0);
    t.is(all(cards[1]).filter(node => node.classList.values.has('pkm-substrip__stop')).length, 1);
    t.true(textTree(host).includes('Pierwsze zlecenie'));
    t.true(textTree(host).includes('Drugie zlecenie'));
    t.true(textTree(host).includes('brak.md'));
    t.true(textTree(host).includes('CZEGO BRAKUJE'));
    t.true(textTree(host).includes('stan zgodny'));
    t.true(textTree(host).includes('Pierwszy wynik'));
    t.false(textTree(host).includes('pierwszy.md'));
    const expandSteps = all(cards[0]).find(node => node.classList.values.has('pkm-substrip__run-toggle'))!;
    t.is(expandSteps.textContent, 'Rozwiń kroki');
    t.is(expandSteps.attributes['aria-expanded'], 'false');
    expandSteps.dispatch('click');
    t.is(all(cards[0]).find(node => node.textContent === tr('chat.substrip.heading_steps'))?.textContent, 'KROKI');
    t.true(textTree(host).includes('pierwszy.md'));
    t.is(expandSteps.attributes['aria-expanded'], 'true');
    t.true(textTree(host).includes('nie znaleziono'));
    t.true(textTree(host).includes('stan niezgodny'));
    t.true(textTree(host).includes('nie sprawdzono'));
    t.true(textTree(host).includes('tokeny wejściowe: 31 · tokeny wyjściowe: 7 · narzędzia: 0'));
    expandSteps.focus();
    render();
    t.true(textTree(host).includes('Pierwsze zlecenie'));
    t.true(textTree(host).includes('Drugie zlecenie'));
    t.true(textTree(host).includes('pierwszy.md'));
    t.is(host.ownerDocument.activeElement?.dataset.substripRunId, 'axis-one');
    registry.dispose();
    setLocale('en');
});

test('subTaskStrip: bez potwierdzonego brakującego celu nie ma sekcji braków', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'no-missing', name: 'worker', owner, origin: owner, config: {} });
    const run = registry.create({ id: 'no-missing-run', name: 'worker', agentName: owner.agentName, origin: owner, threadId: 'no-missing' });
    const effects = [{ tool: 'delete', action: 'delete', targets: [{ kind: 'vault-file' as const, path: 'plik.md' }], outcome: 'returned' as const, check: 'mismatch' as const }];
    registry.finish(run, { text: 'Wynik', toolsUsed: [], durationMs: 1, usage: null,
        outcome: { end: { kind: 'finished' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects } });
    registry.endRun('no-missing', { successful: true, effects: [{ ...effects[0], expectedCheck: 'absent' }] });
    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner,
        expandedId: 'no-missing', onToggle() {} });
    t.false(textTree(host).includes('CZEGO BRAKUJE'));
    t.true(textTree(host).includes('stan niezgodny'));
    registry.dispose();
    setLocale('en');
});

test('subTaskStrip: Escape z przycisku Stop w szczegółach zwija i przywraca focus chipa', t => {
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'escape-thread', name: 'worker', owner, origin: owner, config: {} });
    registry.create({ id: 'escape-run', name: 'worker', agentName: owner.agentName, origin: owner, threadId: 'escape-thread' });
    const host = new MockEl();
    let expanded: string | null = 'escape-thread';
    const render = () => renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner,
        expandedId: expanded, onToggle: id => { expanded = id; render(); } });
    render();
    const stop = all(host).find(node => node.classList.values.has('pkm-substrip__stop'))!;
    stop.focus();
    render();
    t.true(host.ownerDocument.activeElement?.classList.values.has('pkm-substrip__stop'));
    const detail = all(host).find(node => node.classList.values.has('pkm-substrip__detail'))!;
    detail.dispatch('keydown', { key: 'Escape', target: host.ownerDocument.activeElement });
    t.deepEqual(expanded, null);
    t.is(host.ownerDocument.activeElement?.dataset.substripId, 'escape-thread');
    registry.dispose();
});

test('subTaskStrip: literalne klasy obrysu wszystkich stanów', t => {
    setLocale('pl');
    const outcomes = [
        ['done', { kind: 'finished' }, 'unconfirmed', 'pkm-substrip__chip--done'],
        ['incomplete', { kind: 'finished' }, 'partial', 'pkm-substrip__chip--partial-incomplete'],
        ['limit', { kind: 'limit', reason: 'iteration-limit' }, 'partial', 'pkm-substrip__chip--partial-limit'],
        ['uncertain', { kind: 'uncertain' }, 'partial', 'pkm-substrip__chip--partial-uncertain'],
        ['user', { kind: 'stopped', by: 'user' }, 'partial', 'pkm-substrip__chip--partial-user-stop'],
        ['lead', { kind: 'stopped', by: 'lead' }, 'partial', 'pkm-substrip__chip--partial-lead-stop'],
        ['system', { kind: 'stopped', by: 'system' }, 'partial', 'pkm-substrip__chip--partial-system-stop'],
        ['timeout', { kind: 'timeout' }, 'partial', 'pkm-substrip__chip--partial-timeout'],
        ['error', { kind: 'failed', stage: 'work' }, 'partial', 'pkm-substrip__chip--partial-error'],
        ['empty', { kind: 'finished' }, 'empty', 'pkm-substrip__chip--empty-result'],
    ] as const;
    for (const [id, end, completeness, expectedClass] of outcomes) {
        const registry = new SubTaskRegistry();
        const run = registry.create({ id, name: id, agentName: owner.agentName, origin: owner });
        registry.finish(run, { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null,
            outcome: { end, completeness, hasAnswer: completeness === 'unconfirmed', hasMaterial: completeness !== 'empty', effects: [] } });
        const host = new MockEl();
        renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
        t.true(all(host).some(node => node.classList.values.has(expectedClass)), `${id}: ${expectedClass}`);
        registry.dispose();
    }
    for (const [id, phase, expectedClass] of [
        ['queued', 'queued', 'pkm-substrip__chip--queued'],
        ['running', 'running', 'pkm-substrip__chip--running'],
        ['stopping', 'running', 'pkm-substrip__chip--stopping'],
        ['idle', 'running', 'pkm-substrip__chip--idle'],
        ['closed', 'queued', 'pkm-substrip__chip--closed'],
    ] as const) {
        const registry = new SubTaskRegistry();
        registry.createThread({ threadId: id, name: id, owner, origin: owner, config: {}, phase });
        if (id === 'running' || id === 'stopping' || id === 'idle') {
            const run = registry.create({ id: `${id}-run`, name: id, agentName: owner.agentName, origin: owner, threadId: id });
            if (id === 'stopping') { registry.attachAbort(run.id, () => {}); registry.requestStop(run.id, 'user'); }
            if (id === 'idle') {
                registry.finish(run, { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null,
                    outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
                registry.endRun(id, { successful: true, answer: 'gotowe' });
            }
        }
        if (id === 'closed') registry.closeThread(id);
        const host = new MockEl();
        renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
        t.true(all(host).some(node => node.classList.values.has(expectedClass)), `${id}: ${expectedClass}`);
        registry.dispose();
    }
    const registry = new SubTaskRegistry();
    const delivery = registry.create({ id: 'delivery', name: 'delivery', agentName: owner.agentName, origin: owner });
    registry.finish(delivery, { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null,
        outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry, subTaskNotifier: { pending: () => [delivery] } }, tabKey: 'Klara', ...owner, onToggle() {} });
    t.true(all(host).some(node => node.classList.values.has('pkm-substrip__chip--delivery')));
    registry.dispose();
    setLocale('en');
});

test('subTaskStrip: awaria pokazuje zachowany dorobek pod Co powstało i powód w nagłówku', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const thread = registry.createThread({ threadId: 'failure-thread', name: 'worker', owner, origin: owner, config: {} });
    const run = registry.create({ id: 'failure-run', name: 'worker', agentName: owner.agentName, origin: owner, threadId: thread.threadId });
    const outcome = { end: { kind: 'failed' as const, stage: 'work' as const }, completeness: 'partial' as const,
        hasAnswer: false, hasMaterial: true, effects: [] };
    registry.endRun(thread.threadId, { successful: false });
    registry.fail(run, 'Awaria modelu', outcome, { text: '', toolsUsed: [], durationMs: 1, usage: null, outcome,
        handoff: 'Zachowany dorobek: odczytano Plan.md i ustalono trzy kroki' });

    const host = new MockEl();
    renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner,
        expandedId: thread.threadId, onToggle() {} });
    const reason = all(host).find(node => node.classList.values.has('pkm-substrip__end-reason'));
    const created = all(host).find(node => node.classList.values.has('pkm-substrip__outcome'));
    t.is(reason?.textContent, 'Awaria modelu');
    t.is(created?.textContent, 'Zachowany dorobek: odczytano Plan.md i ustalono trzy kroki');
    t.false(created?.textContent.includes('Awaria modelu'));
    registry.dispose();
    setLocale('en');
});

test('subTaskStrip: rozwinięty bieg pokazuje notkę o podsumowaniu w toku i o padzie zapisu dorobku', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const running = registry.create({ id: 'run-synteza', name: 'pkm-sub', agentName: owner.agentName, origin: owner, taskPreview: 'Zbierz notatki' });
    running.partial = { synthesis: 'pending' } as typeof running.partial;
    const stored = registry.create({ id: 'run-zapis', name: 'pkm-sub', agentName: owner.agentName, origin: owner, taskPreview: 'Zapisz plan' });
    registry.finish(stored, { text: 'Plan', toolsUsed: [], durationMs: 5, usage: null });
    stored.partialStorageError = true;
    const render = (expandedId: string) => {
        const host = new MockEl();
        renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId, onToggle() {} });
        return textTree(host);
    };
    t.true(render('run-synteza').includes(trPl['chat.substrip.synthesis_pending']));
    t.false(render('run-synteza').includes(trPl['chat.streaming.partial_storage_error']));
    t.true(render('run-zapis').includes(trPl['chat.streaming.partial_storage_error']));
    registry.dispose();
    setLocale('en');
});

function treeRegistry() {
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    for (const [id, name, parentId] of [['lena', 'Lena', undefined], ['iga', 'Iga', undefined],
        ['marek', 'Marek', 'lena-run'], ['worker', 'worker', 'marek-run']] as const) {
        registry.createThread({ threadId: id, name, parentId, owner, origin: owner, config: {} });
        registry.create({ id: `${id}-run`, threadId: id, name, parentId, origin: owner });
    }
    registry.createThread({ threadId: 'queued', name: 'Jan', parentId: 'lena-run', owner, origin: owner, config: {}, phase: 'queued' });
    return registry;
}
const byClass = (host: MockEl, name: string) => all(host).filter(node => node.classList.contains(`pkm-substrip__${name}`));
const control = (host: MockEl, id: string) => all(host).find(node => node.attributes['data-substrip-control'] === id)!;

test.serial('tree DOM: branches, independent collapse, stable counters, focus, owner/view isolation and queue tooltip', t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const registry = treeRegistry(); t.teardown(() => registry.dispose());
    const host = new MockEl();
    const ctx = { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} };
    t.is(renderSubTaskStrip(host as never, ctx), 5);
    t.true(host.classList.contains('pkm-substrip--tree'));
    t.deepEqual(byClass(host, 'name').map(n => n.textContent), ['Lena', 'Marek', 'worker', 'Jan', 'Iga']);
    t.deepEqual(byClass(host, 'tree').map(n => n.attributes['data-substrip-depth']), ['0', '1', '2', '1', '0']);
    t.deepEqual(byClass(host, 'branch').map(n => byClass(n, 'name').map(el => el.textContent)), [['Marek', 'worker', 'Jan'], ['worker']]);
    t.is(textTree(byClass(host, 'summary')[0]).trim(), '4 pracuje, 1 w kolejce  · 5 zadań');
    t.is(byClass(host, 'tip')[0].textContent, 'Czeka na wolne miejsce, max 5 naraz.');
    control(host, 'info:queued').dispatch('click');
    t.deepEqual([control(host, 'info:queued').attributes['aria-expanded'], byClass(host, 'tip').length], ['false', 0]);
    control(host, 'info:queued').dispatch('click');
    t.is(byClass(host, 'tip')[0].textContent, 'Czeka na wolne miejsce, max 5 naraz.');
    control(host, 'toggle:marek').dispatch('click');
    control(host, 'toggle:lena').dispatch('click');
    t.deepEqual(byClass(host, 'name').map(n => n.textContent), ['Lena', 'Iga']);
    t.deepEqual(byClass(host, 'count').map(n => n.textContent), ['+3']);
    t.is(host.ownerDocument.activeElement?.attributes['data-substrip-control'], 'toggle:lena');
    t.is(control(host, 'toggle:lena').attributes['aria-expanded'], 'false');
    renderSubTaskStrip(host as never, ctx);
    t.deepEqual(byClass(host, 'count').map(n => n.textContent), ['+3']);
    t.is(textTree(byClass(host, 'summary')[0]).trim(), '4 pracuje, 1 w kolejce  · 5 zadań');
    control(host, 'toggle:lena').dispatch('click');
    t.deepEqual(byClass(host, 'name').map(n => n.textContent), ['Lena', 'Marek', 'Jan', 'Iga']);
    t.deepEqual(byClass(host, 'count').map(n => n.textContent), ['+1']);
    const other = new MockEl(); renderSubTaskStrip(other as never, ctx);
    t.deepEqual(byClass(other, 'name').map(n => n.textContent), ['Lena', 'Marek', 'worker', 'Jan', 'Iga']);
    renderSubTaskStrip(host as never, { ...ctx, agentName: 'Other' });
    t.is(host.children.length, 0);
    renderSubTaskStrip(host as never, ctx);
    t.deepEqual(byClass(host, 'count').map(n => n.textContent), ['+1']);
});

test.serial('tree DOM: asks the actual parent, escalates to lead and Stop reaches the whole subtree through P3', t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const registry = treeRegistry(); t.teardown(() => registry.dispose());
    registry.openParentQuestion('marek-run', 'Jakie źródła?');
    const host = new MockEl();
    const ctx = { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: 'marek', onToggle() {} };
    renderSubTaskStrip(host as never, ctx);
    t.deepEqual(byClass(host, 'state').map(n => n.textContent), ['odpowiada wnukowi', 'pyta Lena', 'pracuje', 'w kolejce', 'pracuje']);
    t.is(byClass(host, 'detail-status')[0].textContent, 'pyta Lena');
    t.is(byClass(host, 'question-note')[0].textContent, 'Tylko podgląd. Odpowiada rodzic, który zlecił to zadanie.');
    registry.openParentQuestion('lena-run', 'Pomóż');
    renderSubTaskStrip(host as never, ctx);
    t.is(byClass(host, 'state')[0].textContent, 'pyta prowadzącego');
    t.deepEqual(byClass(host, 'stop-hint').map(n => n.textContent), ['zatrzyma też 3 suby pod nim', 'zatrzyma też 1 suba pod nim']);
    const stopped: string[] = [];
    for (const id of ['lena-run', 'marek-run', 'worker-run']) registry.attachAbort(id, () => {
        stopped.push(id);
        registry.finish(registry.getTask(id)!, { text: '', toolsUsed: [], durationMs: 0, usage: null,
            outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } });
    });
    control(host, 'toggle:lena').dispatch('click');
    control(host, 'stop:lena').dispatch('click');
    t.deepEqual(stopped, ['worker-run', 'marek-run', 'lena-run']);
    t.deepEqual(['lena-run', 'marek-run', 'worker-run', 'iga-run'].map(id => registry.getTask(id)?.stopRequestedBy), ['user', 'user', 'user', undefined]);
    t.is(registry.getThread('queued')?.phase, 'closed');
    t.deepEqual(byClass(host, 'state').map(n => n.textContent), ['zatrzymany', 'pracuje']);
    t.true(control(host, 'stop:lena').disabled);
    t.is(byClass(host, 'count')[0].textContent, '+3');
});

// Literal DOM output captured from the renderer at 882d8b7, before P7.
test.serial('flat DOM: exact pre-P7 structure, classes, labels and accessibility attributes', t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    registry.create({ id: 'flat-run', name: 'Lena', agentName: 'Klara', origin: { agentName: 'Klara' } }).createdAt = Date.now();
    registry.createThread({ threadId: 'flat-queued', name: 'Jan', owner: { agentName: 'Klara' }, origin: { agentName: 'Klara' }, config: {}, phase: 'queued' });
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', agentName: 'Klara', onToggle() {} });
    t.deepEqual(all(host).map(n => [n.tagName, n.className, n.textContent, n.attributes]), [
        ["DIV", "pkm-substrip", "", {}],
        ["DIV", "pkm-substrip__chips", "", {}],
        ["BUTTON", "pkm-substrip__chip pkm-substrip__chip--queued", "", {"type": "button", "aria-expanded": "false", "aria-label": "Jan: czeka na miejsce", "data-substrip-id": "flat-queued"}],
        ["SPAN", "pkm-substrip__crystal", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 60 100\" width=\"12\" height=\"20\"><g><polygon points=\"30,33 41.8,37.9 52.2,55.9 39.8,74.1 18.2,63.6 11.9,53.7 6.9,28.7\" fill=\"currentColor\" fill-opacity=\"0.25\" stroke=\"currentColor\" stroke-width=\"1.8\"/><line x1=\"30\" y1=\"50\" x2=\"39.8\" y2=\"74.1\" stroke=\"currentColor\" stroke-opacity=\"0.2\" stroke-width=\"1\"/><line x1=\"30\" y1=\"50\" x2=\"41.8\" y2=\"37.9\" stroke=\"currentColor\" stroke-opacity=\"0.2\" stroke-width=\"1\"/><line x1=\"30\" y1=\"50\" x2=\"11.9\" y2=\"53.7\" stroke=\"currentColor\" stroke-opacity=\"0.2\" stroke-width=\"1\"/></g></svg>", {}],
        ["SPAN", "pkm-substrip__chip-copy", "", {}],
        ["SPAN", "pkm-substrip__name", "Jan", {}],
        ["SPAN", "pkm-substrip__state", "czeka na miejsce", {}],
        ["SPAN", "pkm-substrip__queue", "1. w kolejce", {}],
        ["SPAN", "pkm-substrip__time", "0 s", {}],
        ["BUTTON", "pkm-substrip__chip pkm-substrip__chip--running", "", {"type": "button", "aria-expanded": "false", "aria-label": "Lena: pracuje", "data-substrip-id": "flat-run"}],
        ["SPAN", "pkm-substrip__crystal", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 60 100\" width=\"12\" height=\"20\"><g><polygon points=\"30,4.871933228336275 57.390984209254384,29.954387640580535 47.595174764283,61.01037771720439 30,91.84988234564662 12.404825235716999,61.01037771720439 2.609015790745616,29.954387640580535\" fill=\"currentColor\" fill-opacity=\"0.25\" stroke=\"currentColor\" stroke-width=\"1.8\"/><line x1=\"2.609015790745616\" y1=\"29.954387640580535\" x2=\"57.390984209254384\" y2=\"29.954387640580535\" stroke=\"currentColor\" stroke-opacity=\"0.3\" stroke-width=\"1\"/><line x1=\"30\" y1=\"4.871933228336275\" x2=\"12.404825235716999\" y2=\"61.01037771720439\" stroke=\"currentColor\" stroke-opacity=\"0.2\" stroke-width=\"1\"/><line x1=\"30\" y1=\"4.871933228336275\" x2=\"47.595174764283\" y2=\"61.01037771720439\" stroke=\"currentColor\" stroke-opacity=\"0.2\" stroke-width=\"1\"/><line x1=\"30\" y1=\"91.84988234564662\" x2=\"2.609015790745616\" y2=\"29.954387640580535\" stroke=\"currentColor\" stroke-opacity=\"0.15\" stroke-width=\"1\"/><line x1=\"30\" y1=\"91.84988234564662\" x2=\"57.390984209254384\" y2=\"29.954387640580535\" stroke=\"currentColor\" stroke-opacity=\"0.15\" stroke-width=\"1\"/></g></svg>", {}],
        ["SPAN", "pkm-substrip__chip-copy", "", {}],
        ["SPAN", "pkm-substrip__name", "Lena", {}],
        ["SPAN", "pkm-substrip__state", "pracuje", {}],
        ["SPAN", "pkm-substrip__time", "0 s", {}],
    ]);
});

test.serial('tree DOM: naturally finished branches show finished, never a false stopped button', t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    for (const [id, parentId] of [['parent', undefined], ['child', 'parent-run']] as const) {
        registry.createThread({ threadId: id, name: id, parentId, owner, origin: owner, config: { limits: { subagent_thread_max_runs: 1 } } });
        const task = registry.create({ id: `${id}-run`, threadId: id, name: id, parentId, origin: owner });
        registry.finish(task, { text: 'wynik', toolsUsed: [], durationMs: 0, usage: null,
            outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
        registry.endRun(id, { successful: true });
    }
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
    t.deepEqual(byClass(host, 'state').map(n => n.textContent), ['skończył', 'skończył']);
    t.deepEqual(byClass(host, 'tree-stop').map(n => n.textContent), []);
    t.is(control(host, 'toggle:parent').attributes['aria-expanded'], 'true');
    t.is(textTree(byClass(host, 'summary')[0]).trim(), '0 pracuje, 0 w kolejce  · 2 zadania');
});

test.serial('F1 Stop hint plural forms are literal in the DOM and aria label', t => {
    t.teardown(() => setLocale('en'));
    for (const [count, pl, en] of [
        [1, '1 suba', '1 sub'], [2, '2 suby', '2 subs'], [3, '3 suby', '3 subs'], [4, '4 suby', '4 subs'],
        [5, '5 subów', '5 subs'], [12, '12 subów', '12 subs'], [13, '13 subów', '13 subs'], [14, '14 subów', '14 subs'],
        [22, '22 suby', '22 subs'], [23, '23 suby', '23 subs'], [24, '24 suby', '24 subs'],
    ] as const) {
        const registry = new SubTaskRegistry();
        t.teardown(() => registry.dispose());
        registry.createThread({ threadId: 'root', name: 'Root', owner, origin: owner, config: {} });
        registry.create({ id: 'root-run', threadId: 'root', origin: owner });
        for (let i = 0; i < count; i++) {
            registry.createThread({ threadId: `child-${i}`, name: 'Child', owner, origin: owner, config: {}, parentId: 'root-run' });
            registry.create({ id: `child-run-${i}`, threadId: `child-${i}`, parentId: 'root-run', origin: owner });
        }
        for (const [locale, expected] of [['pl', `zatrzyma też ${pl} pod nim`], ['en', `also stops ${en} below it`]]) {
            setLocale(locale);
            const host = new MockEl();
            renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, onToggle() {} });
            t.is(byClass(host, 'stop-hint')[0].textContent, expected);
            t.is(control(host, 'stop:root').attributes['aria-label'], `${tr('chat.substrip.stop_aria', { name: 'Root' })}, ${expected}`);
        }
    }
});

test.serial('P5: pasek odświeża kontekst zdarzeniem i rozróżnia biegi jednego wątku', t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const previousWindow = globalThis.window, previousObserver = globalThis.MutationObserver;
    (globalThis as Record<string, unknown>).window = { setInterval: () => 1, clearInterval() {} };
    (globalThis as Record<string, unknown>).MutationObserver = class { observe() {} disconnect() {} };
    t.teardown(() => { globalThis.window = previousWindow; globalThis.MutationObserver = previousObserver; });
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    t.teardown(() => registry.dispose());
    const pending = { mode: 'parent_conversation', status: 'pending', source: 'lead', sourceId: 8 } as const;
    registry.createThread({ threadId: 'thread-context', name: 'worker', owner, origin: owner, config: {}, parentConversation: pending });
    const first = registry.create({ id: 'run-context', threadId: 'thread-context', name: 'worker', origin: owner });
    const host = new MockEl(); Object.assign(host, { isConnected: true });
    const render = () => renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: 'thread-context', onToggle() {} });
    const badges = () => all(host).filter(node => node.classList.contains('cs-parent-conversation__badge')).map(node => [node.textContent, node.className]);
    render();
    t.deepEqual(badges(), [['z rozmową - oczekuje', 'cs-parent-conversation__badge cs-parent-conversation--pending'], ['z rozmową - oczekuje', 'cs-parent-conversation__badge cs-parent-conversation--pending']]);
    registry.setParentConversation(first.id, { ...pending, status: 'included', truncated: true,
        window: { tokens: 4096, estimated: false, source: 'catalog' }, keptMessages: 2, summarizedMessages: 1,
        omittedMessages: 3, estimatedTokens: 80, inputTokens: 200, maxOutputTokens: 1024, marginTokens: 461 });
    t.deepEqual(badges(), [['z rozmową - rozmowa skrócona', 'cs-parent-conversation__badge cs-parent-conversation--truncated'], ['z rozmową - rozmowa skrócona', 'cs-parent-conversation__badge cs-parent-conversation--truncated']]);
    t.deepEqual(all(host).find(node => node.classList.contains('cs-parent-conversation__details'))?.children.map(node => node.textContent), [
        'Źródło: prowadzący, tura 8.', 'Wiadomości: zachowane 2, streszczone 1, pominięte 3.',
        'Szacowany rozmiar rozmowy: 80 tokenów.', 'Bez załączników i myślenia. Uprawnienia do plików i narzędzi bez zmian.',
    ]);
    registry.finish(first, { text: 'PIERWSZY', toolsUsed: [], durationMs: 0, usage: null });
    registry.endRun('thread-context', { successful: true });
    registry.reserveContinuation('thread-context', owner, 'run-clean');
    registry.beginRun('thread-context', owner, { reservedRunId: 'run-clean' });
    const second = registry.create({ id: 'run-clean', threadId: 'thread-context', name: 'worker', origin: owner });
    registry.finish(second, { text: 'DRUGI', toolsUsed: [], durationMs: 0, usage: null });
    registry.endRun('thread-context', { successful: true });
    render();
    t.deepEqual(badges(), [['z rozmową - rozmowa skrócona', 'cs-parent-conversation__badge cs-parent-conversation--truncated']]);
    t.deepEqual(all(host).filter(node => node.classList.contains('pkm-substrip__run-card')).map(card => ({
        id: card.dataset.substripRunId, badges: all(card).filter(node => node.classList.contains('cs-parent-conversation__badge')).map(node => node.textContent),
    })), [{ id: 'run-context', badges: ['z rozmową - rozmowa skrócona'] }, { id: 'run-clean', badges: [] }]);
});

test.serial('P5: drzewo sub → wnuk pokazuje niezależny zakres i pominięcie rozmowy', t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    t.teardown(() => registry.dispose());
    registry.create({ id: 'parent-ui', name: 'parent', origin: owner, level: 1 });
    registry.create({ id: 'child-ui', name: 'child', origin: owner, parentId: 'parent-ui', level: 2 });
    registry.setParentConversation('parent-ui', { mode: 'parent_conversation', status: 'pending', source: 'lead', sourceId: 3 });
    registry.setParentConversation('child-ui', { mode: 'parent_conversation', status: 'omitted', source: 'sub', sourceId: 'parent-ui',
        truncated: true, keptMessages: 0, summarizedMessages: 0, omittedMessages: 1, estimatedTokens: 0,
        inputTokens: 400, maxOutputTokens: 128, marginTokens: 300, window: { tokens: 512, estimated: false, source: 'override' } });
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'Klara', ...owner, expandedId: 'child-ui', onToggle() {} });
    t.true(host.classList.contains('pkm-substrip--tree'));
    t.deepEqual(all(host).filter(node => node.classList.contains('cs-parent-conversation__badge')).map(node => [node.textContent, node.className]), [
        ['z rozmową - oczekuje', 'cs-parent-conversation__badge cs-parent-conversation--pending'],
        ['rozmowa pominięta', 'cs-parent-conversation__badge cs-parent-conversation--omitted'],
        ['rozmowa pominięta', 'cs-parent-conversation__badge cs-parent-conversation--omitted'],
    ]);
    t.deepEqual(all(host).find(node => node.classList.contains('cs-parent-conversation__details'))?.children.map(node => node.textContent), [
        'Źródło: rodzic-sub, bieg parent-ui.', 'Brak treści lub miejsca w oknie modelu. Zadanie bazowe bez rozmowy rodzica.',
        'Wiadomości: zachowane 0, streszczone 0, pominięte 1.', 'Szacowany rozmiar rozmowy: 0 tokenów.',
        'Bez załączników i myślenia. Uprawnienia do plików i narzędzi bez zmian.',
    ]);
});

for (const locale of ['pl', 'en'] as const) test.serial(`P4 ${locale}: registry events render A/B waiting, B waiting, slot queue and start`, t => {
    setLocale(locale);
    const oldObserver = globalThis.MutationObserver;
    (globalThis as Record<string, unknown>).MutationObserver = class { observe() {} disconnect() {} };
    const registry = new SubTaskRegistry();
    t.teardown(() => { registry.dispose(); globalThis.MutationObserver = oldObserver; setLocale('en'); });
    registry.reservePlan(planInput());
    const host = new MockEl(); Object.assign(host, { isConnected: true });
    const render = (epoch = planOwner.sessionEpoch) => renderSubTaskStrip(host as never, {
        plugin: { subTaskRegistry: registry }, tabKey: 'plan', ...planOwner, sessionEpoch: epoch, expandedId: 'C', onToggle() {},
    });
    t.is(render(), 3);
    const chip = () => all(host).find(el => el.dataset.substripId === 'C')!;
    const states = () => all(chip()).filter(el => el.className === 'pkm-substrip__state').map(el => el.textContent);
    t.deepEqual(states(), [locale === 'pl' ? 'czeka na: A, B' : 'waiting for: A, B']);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__name').map(el => el.textContent), ['C · explorer', 'A · explorer', 'B · explorer']);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__queue').map(el => el.textContent), locale === 'pl' ? ['1. w kolejce', '2. w kolejce'] : ['1 in queue', '2 in queue']);
    t.is(all(chip()).filter(el => el.className === 'pkm-substrip__time').length, 0);
    t.is(all(host).filter(el => el.className === 'pkm-substrip__detail-meta').length, 0);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__stop').map(el => el.disabled), [false]);
    const a = activatePlanTask(registry, 'A'); const b = activatePlanTask(registry, 'B');
    registry.finish(a, planResult());
    t.deepEqual(states(), [locale === 'pl' ? 'czeka na: B' : 'waiting for: B']);
    registry.finish(b, planResult());
    t.deepEqual(states(), [locale === 'pl' ? 'czeka na miejsce' : 'waiting for a slot']);
    t.deepEqual(all(chip()).filter(el => el.className === 'pkm-substrip__queue').map(el => el.textContent), [locale === 'pl' ? '1. w kolejce' : '1 in queue']);
    activatePlanTask(registry, 'C');
    t.deepEqual(states(), [locale === 'pl' ? 'pracuje' : 'working']);
    t.is(all(chip()).filter(el => el.className === 'pkm-substrip__time').length, 1);
    t.is(render('b'.repeat(32)), 0);
    t.is(render(), 3);
    t.deepEqual(states(), [locale === 'pl' ? 'pracuje' : 'working']);
});

test.serial('P4 blocked keeps original A ahead of closed/delivery; waiting Stop stops C only', t => {
    setLocale('en');
    const registry = new SubTaskRegistry(); const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    registry.reservePlan(planInput(planOwner, undefined, [['D', ['C']], ['C', ['A']], ['A', []], ['B', []]]));
    const a = activatePlanTask(registry, 'A'); activatePlanTask(registry, 'B');
    registry.fail(a, 'A failed');
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry, subTaskNotifier: notifier }, tabKey: 'plan', ...planOwner, expandedId: 'D', onToggle() {} });
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__state').map(el => el.textContent),
        ['blocked (failed: A)', 'blocked (failed: A)', 'waiting for delivery', 'working']);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__run-state').map(el => el.textContent), ['blocked (failed: A)']);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__unavailable').map(el => el.textContent), ['task was not started']);
    t.is(all(host).filter(el => el.className === 'pkm-substrip__stop').length, 0);
    const rows = buildStripModel({ tasks: registry.list(), pending: notifier.pending(), threads: registry.listThreads(planOwner), ...planOwner });
    t.deepEqual(summarizeStripRows(rows), { running: 1, queued: 0, total: 4, waiting: 0, blocked: 2 });
    const waiting = new SubTaskRegistry(); t.teardown(() => waiting.dispose());
    waiting.reservePlan(planInput());
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: waiting }, tabKey: 'plan', ...planOwner, expandedId: 'C', onToggle() {} });
    all(host).find(el => el.className === 'pkm-substrip__stop')!.dispatch('click');
    t.deepEqual(waiting.list().map(task => [task.id, task.plan?.state.kind]), [['C', 'failed'], ['A', 'queued'], ['B', 'queued']]);
});

test.serial('P4 nested plan stays among real siblings; waiting has Stop and no slot hint', t => {
    setLocale('en');
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    registry.createThread({ threadId: 'parent', name: 'parent', owner: planOwner, origin: planOwner, config: {} });
    registry.create({ id: 'parent', threadId: 'parent', name: 'parent', agentName: planOwner.agentName, origin: planOwner, level: 1 });
    registry.reservePlan(planInput(planOwner, 'parent'));
    const host = new MockEl();
    const render = () => renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: registry }, tabKey: 'plan', ...planOwner, expandedId: 'C', onToggle() {} });
    t.is(render(), 4);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__tree').map(el => el.attributes['data-substrip-depth']), ['0', '1', '1', '1']);
    const c = all(host).find(el => el.dataset.substripId === 'C')!.parentElement!;
    t.deepEqual(all(c).filter(el => el.className === 'pkm-substrip__state').map(el => el.textContent), ['waiting for: A, B']);
    t.is(all(c).filter(el => el.className === 'pkm-substrip__info' || el.className === 'pkm-substrip__time').length, 0);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__info').map(el => el.attributes['data-substrip-control']), ['info:A', 'info:B']);
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__stop').map(el => el.disabled), [false]);
    registry.fail(activatePlanTask(registry, 'A'), 'A failed'); render();
    t.deepEqual(all(host).filter(el => el.className === 'pkm-substrip__state').map(el => el.textContent), ['working', 'blocked (failed: A)', 'failed', 'queued']);
    t.is(all(host).filter(el => el.className === 'pkm-substrip__stop').length, 0);
});

import { draftFixture, owner as draftOwner } from '../../tools/test-support/vaultDraftFixture.js';

test.serial('P5 draft strip shows review counts, file decisions, conflicts and removes its subscription', async t => {
    setLocale('pl');
    const oldObserver = globalThis.MutationObserver;
    let disconnect: (() => void) | undefined;
    globalThis.MutationObserver = class {
        constructor(callback: () => void) { disconnect = callback; }
        observe() {} disconnect() {}
    } as never;
    t.teardown(() => { globalThis.MutationObserver = oldObserver; setLocale('en'); });
    const f = await draftFixture(t);
    const { task, draft } = await f.run('strip');
    await f.write(draft, 'x.md', 'Propozycja-X'); await f.write(draft, 'y.md', 'Propozycja-Y');
    await draft.close('stopped');
    f.registry.finish(task, { ...f.result, outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } });
    const host = new MockEl(); Object.assign(host, { isConnected: true });
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: f.registry }, ...draftOwner, tabKey: 'Mira', expandedId: 'strip', onToggle() {} });
    t.deepEqual(all(host).filter(n => n.classList.contains('pkm-substrip__draft')).map(n => n.textContent), ['Do przeglądu: 2']);
    const manifest = f.runtime.store.list()[0];
    const [x, y] = manifest.changes;
    await f.runtime.review.decide(f.context, { action: 'accept', draftId: manifest.draftId, changeId: x.id, revision: x.revision });
    await f.runtime.review.decide(f.context, { action: 'reject', draftId: manifest.draftId, changeId: y.id, revision: y.revision });
    t.deepEqual(all(host).filter(n => n.classList.contains('pkm-substrip__draft')).map(n => n.textContent), ['Przyjęto: 1 · Odrzucono: 1']);
    t.is(all(host).find(n => n.classList.contains('pkm-substrip__draft-details'))?.textContent,
        'Zmiany w kopii\nPrzyjęto: 1 · Odrzucono: 1\nx.md: Przyjęto: 1\ny.md: Odrzucono: 1');
    t.true(textTree(host).includes('zatrzymany przez Ciebie'));
    t.deepEqual([...f.files], [['x.md', 'Propozycja-X'], ['y.md', 'Baza-Y']]);
    const subscriptions = f.registry.events.listenerCount('draft:changed');
    Object.assign(host, { isConnected: false }); disconnect?.();
    t.is(f.registry.events.listenerCount('draft:changed'), subscriptions - 1);
});

test.serial('P5 backlog survives RAM retention without exposing another session or agent paths', async t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const f = await draftFixture(t);
    for (const [id, who, path] of [
        ['mine', draftOwner, 'x.md'], ['session', { ...draftOwner, sessionPath: 'other.md' }, 'secret-session.md'],
        ['agent', { ...draftOwner, agentName: 'Borys' }, 'secret-agent.md'],
    ] as const) {
        const { task, draft } = await f.run(id, who);
        await f.write(draft, path, 'Gotowe'); await draft.close('finished'); f.registry.finish(task, f.result);
    }
    f.registry.pruneSession(draftOwner.sessionPath);
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: f.registry }, ...draftOwner, tabKey: 'Mira', onToggle() {} });
    t.deepEqual(host.children.map(n => n.textContent), ['Zaległe zmiany agenta: 2. Użyj subagent_changes z scope: agent.']);
    t.false(textTree(host).includes('secret-session.md')); t.false(textTree(host).includes('secret-agent.md'));
});

test.serial('P5 ordinary read-only delegation keeps the literal strip DOM with activated storage', async t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const f = await draftFixture(t);
    const task = f.registry.create({ id: 'read-only', name: 'Czytelnik', agentName: 'Mira', origin: draftOwner });
    f.registry.finish(task, { ...f.result, text: 'Odczytano Bazę', toolsUsed: ['read'] });
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: f.registry }, ...draftOwner, tabKey: 'Mira', expandedId: 'read-only', onToggle() {} });
    const baseline = new MockEl();
    renderSubTaskStrip(baseline as never, { plugin: { subTaskRegistry: { list: () => [task] } }, ...draftOwner, tabKey: 'Mira', expandedId: 'read-only', onToggle() {} });
    const dom = (el: MockEl): unknown => ({ tag: el.tagName, cls: el.className, text: el.textContent, children: el.children.map(dom) });
    t.deepEqual(dom(host), dom(baseline));
    t.is(all(host).find(n => n.classList.contains('pkm-substrip__outcome'))?.textContent, 'Odczytano Bazę');
});

test.serial('P5 conflicting proposal keeps stopped state and shows Konflikty without accepting the file', async t => {
    setLocale('pl'); t.teardown(() => setLocale('en'));
    const f = await draftFixture(t);
    const { task, draft } = await f.run('conflict');
    await f.write(draft, 'x.md', 'Szkic'); await draft.close('stopped');
    f.registry.finish(task, { ...f.result, outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } });
    f.files.set('x.md', 'Kuba');
    const manifest = f.runtime.store.list()[0], change = manifest.changes[0];
    const decision = await f.runtime.review.decide(f.context, { action: 'accept', draftId: manifest.draftId, changeId: change.id, revision: change.revision });
    t.is(decision.kind, 'conflict');
    const host = new MockEl();
    renderSubTaskStrip(host as never, { plugin: { subTaskRegistry: f.registry }, ...draftOwner, tabKey: 'Mira', expandedId: 'conflict', onToggle() {} });
    t.deepEqual(all(host).filter(n => n.classList.contains('pkm-substrip__draft')).map(n => n.textContent), ['Konflikty: 1']);
    t.is(all(host).find(n => n.classList.contains('pkm-substrip__draft-details'))?.textContent, 'Zmiany w kopii\nKonflikty: 1\nx.md: Konflikty: 1');
    t.is(f.files.get('x.md'), 'Kuba');
});
