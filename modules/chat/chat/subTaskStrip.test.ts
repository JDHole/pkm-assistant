import test from 'ava';
import { renderSubTaskStrip } from './subTaskStrip.js';
import { SubTaskRegistry } from '../../sub-agents/index.js';
import { pl as trPl } from '../../../core/i18n/pl.js';
import { setLocale } from '../../../core/i18n/index.js';
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
        if (selector === '[data-substrip-id]') return all(this).filter(node => Boolean(node.dataset.substripId)) as T[];
        if (selector === '[data-substrip-run-id]') return all(this).filter(node => Boolean(node.dataset.substripRunId)) as T[];
        return [];
    }
    focus() { this.ownerDocument.activeElement = this; }
}

function textTree(node: MockEl): string { return [node.textContent, ...node.children.map(textTree)].join(' '); }
function all(node: MockEl): MockEl[] { return [node, ...node.children.flatMap(all)]; }

const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-1' };

test('subTaskStrip: pusty model nie tworzy dzieci', t => {
    const host = new MockEl();
    const count = renderSubTaskStrip(host as any, { plugin: { subTaskRegistry: { list: () => [] } }, tabKey: 'Klara', agentName: 'Klara', onToggle() {} });
    t.is(count, 0);
    t.is(host.children.length, 0);
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
