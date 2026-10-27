import test from 'ava';
import { render_messages } from './chat_messages.js';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { createDelegateTool, createSubAgentTool, __test__ } from '../../tools/DelegateTool.js';
import type { DelegatePlugin } from '../../tools/DelegateTool.js';
import { __test__ as modelsTest } from '../../models/index.js';
import { buildDelegateBlockOptions } from './delegateBlockView.js';
import { setLocale, t as tr } from '../../../core/i18n/index.js';

setLocale('pl');

type El = {
    children: El[]; parent: El | null; classList: { add(...v: string[]): void; remove(...v: string[]): void; toggle(v: string, force?: boolean): void; contains(v: string): boolean };
    className: string; textContent: string; listeners: Record<string, Array<(ev: unknown) => void>>;
    style: { setProperty(name: string, value: string): void; getPropertyValue(name: string): string }; appendText(text: string): void;
    createDiv(opts?: { cls?: string | string[] }): El; createSpan(opts?: { cls?: string | string[]; text?: string }): El;
    createEl(tag: string, opts?: { cls?: string | string[]; text?: string }): El; appendChild(child: El): El; empty(): void;
    setAttribute(name: string, value: string): void; removeAttribute(name: string): void; hasAttribute(name: string): boolean;
    addEventListener(name: string, cb: (ev: unknown) => void): void; scrollIntoView(): void; querySelectorAll(): El[];
};

function el(): El {
    const classes = new Set<string>(), attrs = new Set<string>();
    const node: El = {
        children: [], parent: null, listeners: {}, className: '', textContent: '',
        classList: { add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)), toggle: (v, force) => force ?? !classes.has(v) ? classes.add(v) : classes.delete(v), contains: v => classes.has(v) },
        style: { setProperty() {}, getPropertyValue() { return ''; } }, appendText(text) { this.textContent += text; },
        createDiv(opts) { return this.createEl('div', opts); }, createSpan(opts) { return this.createEl('span', opts); },
        createEl(_tag, opts) { const child = el(); if (opts?.cls) child.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text) child.textContent = opts.text; this.appendChild(child); return child; },
        appendChild(child) { child.parent = this; this.children.push(child); return child; }, empty() { this.children = []; this.textContent = ''; },
        setAttribute(name) { attrs.add(name); }, removeAttribute(name) { attrs.delete(name); }, hasAttribute(name) { return attrs.has(name); },
        addEventListener(name, cb) { (this.listeners[name] ||= []).push(cb); }, scrollIntoView() {}, querySelectorAll() { return []; },
    };
    Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: (value: string) => { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); } });
    return node;
}

function find(root: El, cls: string): El | undefined {
    if (root.classList.contains(cls)) return root;
    for (const child of root.children) { const found = find(child, cls); if (found) return found; }
    return undefined;
}
function all(root: El): El[] { return [root, ...root.children.flatMap(all)]; }

async function render(messages: unknown[], registry: { getTask?: (id: string) => unknown; getThread?: (id: string) => unknown } = {}) {
    const oldDocument = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: () => el() };
    const container = el();
    const view = {
        messages_container: container, rollingWindow: { messages },
        plugin: { agentManager: { getActiveAgent: () => ({ name: 'Kuba', color: '#fff' }) }, subTaskRegistry: registry },
        env: { settings: { pkmAssistant: {} } }, app: {}, _drawConnectorLines() {}, scrollToBottom() {}, addMessageActions() {},
        _renderMultimodalUserContent() {}, _renderUserText() {}, _renderCacheSavingsBadge() {}, _contentBlocksToText() { return ''; },
    };
    try { await render_messages.call(view as never); return container; }
    finally { (globalThis as Record<string, unknown>).document = oldDocument; }
}

function receipt(tasks: Array<{ task_id: string; name: string; sub_id?: string; queued?: boolean }>, queued?: number) {
    return [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'sub_agent', arguments: JSON.stringify({ action: 'task', task: 'zrób' }) } }] },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ started: true, success: true, outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] }, tasks, queued }) },
    ];
}

function notification(taskId: string) {
    return { role: 'user', content: `${tr('chat.subagent_notification.header', { name: 'badacz', task_id: taskId })}\n\n${tr('chat.subagent_notification.meta', { status: 'zakończone' })}` };
}

test.serial('restart bez rejestru pokazuje zakończoną ramkę, znany queued/running pozostaje w toku', async t => {
    const restarted = await render(receipt([{ task_id: 'task-a', name: 'badacz' }]));
    const ended = find(restarted, 'cs-tile--agent');
    t.truthy(ended);
    t.true(find(ended!, 'cs-tile__title')?.textContent.includes('badacz nie dokończył: Obsidian zamknięto w trakcie pracy. Sub nie wróci sam.') ?? false);
    t.false(ended!.classList.contains('cs-tile--pending'));

    const running = await render(receipt([{ task_id: 'task-a', name: 'badacz' }]), { getTask: id => id === 'task-a' ? { threadId: 'thread-a', status: 'running' } : undefined, getThread: id => id === 'thread-a' ? { phase: 'queued' } : undefined });
    t.is(find(find(running, 'cs-tile--agent')!, 'cs-tile__title')?.textContent, 'Zlecono w tle: badacz');
    t.truthy(find(running, 'cs-tile--pending'));
});

test.serial('historia nie odtwarza zamkniętej rezerwacji jako delegację w toku', async t => {
    const stopped = await render(receipt([{ task_id: 'thread-a', name: 'badacz' }]), {
        getTask: id => id === 'thread-a' ? {
            id, threadId: id, name: 'badacz', status: 'done', result: { text: '' },
            outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] },
        } : undefined,
        getThread: id => id === 'thread-a' ? { phase: 'closed' } : undefined,
    });
    const tile = find(stopped, 'cs-tile--agent');
    t.truthy(tile);
    t.is(find(tile!, 'cs-tile--pending'), undefined);
    t.true(tile!.classList.contains('cs-tile--error'));
    find(tile!, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
    t.false(all(tile!).some(node => node.textContent.includes('Agent może dokończyć tym samym subem')));
});

test.serial('stary wynik pozostaje zakończony, gdy ten sam wątek ma już nowy bieg', async t => {
    const history = await render(receipt([{ task_id: 'task-old', sub_id: 'thread-reused', name: 'badacz' }]), {
        getTask: id => id === 'task-old' ? {
            id, threadId: 'thread-reused', name: 'badacz', status: 'done', result: { text: 'Poprzedni wynik.' },
            outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] },
        } : undefined,
        getThread: id => id === 'thread-reused' ? { phase: 'running', reusable: true } : undefined,
    });
    const tile = find(history, 'cs-tile--agent');
    t.truthy(tile);
    t.false(tile!.classList.contains('cs-tile--pending'));
    find(tile!, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
    t.true(all(tile!).some(node => node.textContent.includes('Poprzedni wynik.')));
});

test.serial('zamknięty wątek bez zachowanego taska nie udaje sukcesu', async t => {
    const history = await render(receipt([{ task_id: 'evicted-task', sub_id: 'thread-evicted', name: 'badacz' }]), {
        getThread: id => id === 'thread-evicted' ? { phase: 'closed', reusable: false } : undefined,
    });
    const tile = find(history, 'cs-tile--agent');
    t.truthy(tile);
    t.true(tile!.classList.contains('cs-tile--error'));
    t.is(find(tile!, 'cs-tile__title')?.textContent, 'Wynik badacz jest niedostępny.');
});

test.serial('historia list receipt rozpoznaje item.sub_id dla rezerwacji running i queued', async t => {
    const registry = new SubTaskRegistry();
    const owner = { agentName: 'Kuba', sessionPath: 'Chats/kuba.md', sessionEpoch: 'epoch-1' };
    registry.createThread({ threadId: 'thread-running', name: 'badacz', owner, origin: owner, config: {}, phase: 'running' });
    registry.createThread({ threadId: 'thread-queued', name: 'czytelnik', owner, origin: owner, config: {}, phase: 'queued' });
    const messages = receipt([
        { task_id: 'task-running', sub_id: 'thread-running', name: 'badacz', queued: false },
        { task_id: 'task-queued', sub_id: 'thread-queued', name: 'czytelnik', queued: true },
    ], 1);
    const container = await render(messages, registry);
    const tiles = all(container).filter(node => node.classList.contains('cs-tile--agent'));

    t.is(tiles.length, 2);
    t.is(tiles.filter(tile => tile.classList.contains('cs-tile--pending')).length, 2);
    t.true(tiles.every(tile => !all(tile).some(node => node.textContent.includes('nie dokończył'))));
    registry.dispose();
});

test.serial('późniejszy wynik usuwa pulsujące duplikaty, paczka mieszana zostawia tylko restart pozostałego suba', async t => {
    const history = await render([...receipt([{ task_id: 'task-a', name: 'badacz' }]), notification('task-a')]);
    t.is(history.children.filter(child => child.classList.contains('cs-tile--agent')).length, 0);
    t.is(history.children.filter(child => child.classList.contains('cs-tile--system')).length, 1);

    const mixed = await render([...receipt([{ task_id: 'task-a', name: 'badacz' }, { task_id: 'task-b', name: 'czytelnik' }]), notification('task-a')]);
    t.is(all(mixed).filter(child => child.classList.contains('cs-tile--agent')).length, 1);
    const restarted = find(mixed, 'cs-tile--agent');
    t.true(find(restarted!, 'cs-tile__title')?.textContent.includes('czytelnik nie dokończył: Obsidian zamknięto w trakcie pracy. Sub nie wróci sam.') ?? false);
    t.is(all(mixed).filter(child => child.classList.contains('cs-tile--system')).length, 1);
});

const PROVIDER_IDS = ['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'];

function makeFixture(maxRuns = 7) {
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    const requests: Array<{ payload: unknown; complete(text: string): void; write(path: string): void }> = [];
    class GatedModel {
        modelId = 'worker-model';
        providerId = 'ollama';
        _streamGateLimit() { return 1; }
        stream(payload: unknown, handlers: { done(value: unknown): void }) {
            requests.push({ payload, complete: text => handlers.done({ choices: [{ message: { content: text } }] }),
                write: path => handlers.done({ choices: [{ message: { content: null, tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path, content: 'treść' }) } }] } }] }) });
        }
        stopStream() {}
    }
    const providers = Object.fromEntries(PROVIDER_IDS.map(id => [id, {
        info: { id },
        __testModelClass: GatedModel,
    }]));
    modelsTest.setChatModelFactory(deps => {
        const provider = deps.provider as unknown as { __testModelClass: new () => unknown };
        return new provider.__testModelClass() as never;
    });
    const agent = { name: 'Jaskier', activeSubAgents: [] };
    const writeTool = { name: 'write', description: 'write', inputSchema: {}, execute: async () => ({ success: true }) };
    const plugin = {
        toolRegistry: { filterByAgent: () => [writeTool], getTool: (name: string) => name === 'write' ? writeTool : null },
        subTaskRegistry: registry,
        agentManager: { getActiveAgent: () => agent },
        env: {
            config: { chat: {
                providers,
                http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) },
                transport: { open: async () => ({ status: 200, headers: {}, body: '' }) },
            } },
            settings: { pkmAssistant: {
                chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                limits: { max_parallel_delegations: 5, subagent_thread_max_runs: maxRuns },
            } },
        },
    } as unknown as DelegatePlugin;
    const tool = createDelegateTool({});
    return { registry, requests, plugin, tool };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
}

test.serial('B5: zatrzymane pokwitowanie pozostaje zakończone podczas kontynuacji', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1' };
    const first = await tool.execute({ task: 'pierwsze', _invocationOrigin: origin }, {}, plugin) as { task_id: string; sub_id: string };
    t.true(registry.requestStop(first.task_id, 'user'));
    requests[0].complete('po stopie');
    await waitUntil(() => registry.getTask(first.task_id)?.status === 'aborted');
    const next = await createSubAgentTool({}).execute({ action: 'task', task: 'kontynuuj', sub_id: first.sub_id, _invocationOrigin: origin, _invocationTurnKind: 'user' }, {}, plugin) as { task_id: string; started: boolean };
    t.is(next.started, true);
    const messages = (id: string, result: unknown) => [
        { role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'sub_agent', arguments: JSON.stringify({ action: 'task', task: 'zrób' }) } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
    ];
    const history = await render([...messages('old', first), ...messages('new', next)], registry);
    const tiles = all(history).filter(node => node.classList.contains('cs-tile--agent'));
    requests[1].complete('gotowe');
    await waitUntil(() => registry.getTask(next.task_id)?.status === 'done');
    t.is(registry.getTask(first.task_id)?.status, 'aborted');
    t.is(notifier.pending().length, 2);
    t.is(tiles.length, 2);
    t.false(tiles[0].classList.contains('cs-tile--pending'));
    t.true(tiles[1].classList.contains('cs-tile--pending'));
});

test.serial('R1: zamknięty limitem wątek zachowuje efekt biegu w historii', async t => {
    const { registry, requests, plugin, tool } = makeFixture(1);
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1' };
    const run = await tool.execute({ task: 'raport', aspect: 'worker', _invocationOrigin: origin }, {}, plugin) as { task_id: string; sub_id: string };
    requests[0].write('Raport.md');
    await waitUntil(() => requests.length >= 2);
    requests[1].complete('gotowe');
    await waitUntil(() => registry.getTask(run.task_id)?.status === 'done');
    t.is(registry.getThread(run.sub_id)?.phase, 'closed');
    t.deepEqual(registry.getThread(run.sub_id)?.effects, []);
    t.is(notifier.pending().length, 1);
    const history = await render(receipt([{ task_id: run.task_id, sub_id: run.sub_id, name: 'pkm-sub' }]), registry);
    const tile = find(history, 'cs-tile--agent')!;
    find(tile, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
    t.true(all(tile).some(node => node.textContent.includes('Raport.md')));
});

test.serial('R1: ramki dwóch biegów pokazują tylko ich własne efekty', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1' };
    const first = await tool.execute({ task: 'A', aspect: 'worker', _invocationOrigin: origin }, {}, plugin) as { task_id: string; sub_id: string };
    requests[0].write('A.md');
    await waitUntil(() => requests.length >= 2);
    requests[1].complete('gotowe A');
    await waitUntil(() => registry.getTask(first.task_id)?.status === 'done');
    const second = await createSubAgentTool({}).execute({ action: 'task', task: 'B', sub_id: first.sub_id, _invocationOrigin: origin, _invocationTurnKind: 'user' }, {}, plugin) as { task_id: string };
    await waitUntil(() => requests.length >= 3);
    requests[2].write('B.md');
    await waitUntil(() => requests.length >= 4);
    requests[3].complete('gotowe B');
    await waitUntil(() => registry.getTask(second.task_id)?.status === 'done');
    t.is(registry.getThread(first.sub_id)?.effects.length, 2);
    t.is(notifier.pending().length, 2);
    const history = await render(receipt([{ task_id: first.task_id, sub_id: first.sub_id, name: 'pkm-sub' }, { task_id: second.task_id, sub_id: first.sub_id, name: 'pkm-sub' }]), registry);
    const tiles = all(history).filter(node => node.classList.contains('cs-tile--agent'));
    t.is(tiles.length, 2);
    for (const tile of tiles) find(tile, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
    t.true(all(tiles[0]).some(node => node.textContent.includes('A.md')));
    t.false(all(tiles[0]).some(node => node.textContent.includes('B.md')));
    t.true(all(tiles[1]).some(node => node.textContent.includes('B.md')));
    t.false(all(tiles[1]).some(node => node.textContent.includes('A.md')));
});

test.serial('B2: rzeczywisty wynik blokującego delegate trafia do adaptera i historii', async t => {
    const { registry, plugin } = makeFixture();
    t.teardown(() => registry.dispose());
    const tool = createDelegateTool({}, { makeRunner: () => ({ runTask: async () => ({
        result: 'Zapisano raport.', toolsUsed: ['write'], toolCallDetails: [], duration: 1, usage: null,
        outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true,
            effects: [{ tool: 'write', action: 'create', targets: [{ kind: 'vault-file', path: 'Raport.md' }], outcome: 'returned', check: 'matches' }] },
    }) }) });
    const result = await tool.execute({ task: 'raport', background: false }, {}, plugin) as Parameters<typeof buildDelegateBlockOptions>[0];
    const view = buildDelegateBlockOptions(result, { type: 'delegate', agentName: 'pkm-sub' }).resultView;
    const history = await render([
        { role: 'assistant', content: '', tool_calls: [{ id: 'blocking', function: { name: 'delegate', arguments: JSON.stringify({ task: 'raport' }) } }] },
        { role: 'tool', tool_call_id: 'blocking', content: JSON.stringify(result) },
    ]);
    const tile = find(history, 'cs-tile--agent');
    find(tile!, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
    t.is(view?.title, 'pkm-sub skończył sam');
    t.is(view?.material, 'Zapisano raport.');
    t.deepEqual(view?.effects, [{ tool: 'write', target: 'Raport.md', statusLabel: 'stan zgodny' }]);
    t.is(find(tile!, 'cs-tile__title')?.textContent, 'pkm-sub skończył sam');
    t.true(all(tile!).some(node => node.textContent.includes('Zapisano raport.')));
    t.true(all(tile!).some(node => node.textContent.includes('Raport.md')));
});

test.serial('B4: restart izoluje pokwitowanie, powiadomienie i sub_id', async t => {
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1' };
    const current = makeFixture();
    const notifier = new SubTaskNotifier({ registry: current.registry });
    t.teardown(() => { notifier.dispose(); current.registry.dispose(); });
    const realWorker = await current.tool.execute({ task: 'nowe', _invocationOrigin: origin }, {}, current.plugin) as { task_id: string; sub_id: string; started: boolean };
    const match = /^sub\/(.+)#([a-f0-9]{8})-([a-z0-9]+)$/.exec(realWorker.task_id);
    t.truthy(match);
    if (!match) return;
    const oldTag = match[2] === '00000000' ? '11111111' : '00000000';
    const oldId = `sub/${match[1]}#${oldTag}-${match[3]}`;
    const old = { success: true, started: true, task_id: oldId, sub_id: oldId, name: match[1] };
    const messages = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'old', function: { name: 'sub_agent', arguments: JSON.stringify({ action: 'task', task: 'stare' }) } }] },
        { role: 'tool', tool_call_id: 'old', content: JSON.stringify(old) },
    ];
    const before = await render(messages, current.registry);
    const rejected = await createSubAgentTool({}).execute({ action: 'message', sub_id: oldId, text: 'dalej', _invocationOrigin: origin }, {}, current.plugin) as { success: boolean; error: string };
    current.requests[0].complete('nowy wynik');
    await waitUntil(() => current.registry.getTask(realWorker.task_id)?.status === 'done');
    const after = await render([...messages, notification(realWorker.task_id)], current.registry);
    t.is(find(find(before, 'cs-tile--agent')!, 'cs-tile__title')?.textContent, 'pkm-sub nie dokończył: Obsidian zamknięto w trakcie pracy. Sub nie wróci sam.');
    t.is(rejected.success, false);
    t.is(rejected.error, 'Nie znaleziono tego suba w Twojej rozmowie. Użyj list albo delegate, aby utworzyć nowego.');
    t.is(realWorker.started, true);
    t.is(current.registry.getTask(realWorker.task_id)?.status, 'done');
    t.is(notifier.pending().length, 1);
    t.is(find(find(after, 'cs-tile--agent')!, 'cs-tile__title')?.textContent, 'pkm-sub nie dokończył: Obsidian zamknięto w trakcie pracy. Sub nie wróci sam.');
    t.is(all(after).filter(node => node.classList.contains('cs-tile--system')).length, 1);
});

test.serial('B4: dawny format pokwitowania nie wskazuje nowego workera', async t => {
    const current = makeFixture();
    const notifier = new SubTaskNotifier({ registry: current.registry });
    t.teardown(() => { notifier.dispose(); current.registry.dispose(); });
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1' };
    const oldId = 'sub/pkm-sub#1';
    const messages = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'old', function: { name: 'sub_agent', arguments: JSON.stringify({ action: 'task', task: 'stare' }) } }] },
        { role: 'tool', tool_call_id: 'old', content: JSON.stringify({ success: true, started: true, task_id: oldId, sub_id: oldId, name: 'pkm-sub' }) },
    ];
    const worker = await current.tool.execute({ task: 'nowe', _invocationOrigin: origin }, {}, current.plugin) as { task_id: string; sub_id: string; started: boolean };
    t.is(worker.started, true);
    t.regex(worker.sub_id, /^sub\/pkm-sub#[a-f0-9]{8}-[a-z0-9]+$/);
    const before = await render(messages, current.registry);
    t.is(find(find(before, 'cs-tile--agent')!, 'cs-tile__title')?.textContent, 'pkm-sub nie dokończył: Obsidian zamknięto w trakcie pracy. Sub nie wróci sam.');
    const rejected = await createSubAgentTool({}).execute({ action: 'message', sub_id: oldId, text: 'dalej', _invocationOrigin: origin }, {}, current.plugin) as { success: boolean; error: string };
    t.is(rejected.success, false);
    t.is(rejected.error, 'Nie znaleziono tego suba w Twojej rozmowie. Użyj list albo delegate, aby utworzyć nowego.');
    t.is(current.registry.getThread(worker.sub_id)?.phase, 'running');
    t.deepEqual(current.registry.takeMessages(worker.task_id), []);
    t.true(current.registry.postMessage(worker.task_id, 'właściwy wątek'));
    t.deepEqual(current.registry.takeMessages(worker.task_id), ['właściwy wątek']);
    current.requests[0].complete('nowy wynik');
    await waitUntil(() => current.registry.getTask(worker.task_id)?.status === 'done');
    t.is(notifier.pending().length, 1);
    const after = await render([...messages, notification(worker.task_id)], current.registry);
    t.is(find(find(after, 'cs-tile--agent')!, 'cs-tile__title')?.textContent, 'pkm-sub nie dokończył: Obsidian zamknięto w trakcie pracy. Sub nie wróci sam.');
    t.is(all(after).filter(node => node.classList.contains('cs-tile--system')).length, 1);
});
