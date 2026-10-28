import test from 'ava';
import { append_message, render_messages } from './chat_messages.js';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { createDelegateTool, createSubAgentTool, __test__ } from '../../tools/DelegateTool.js';
import type { DelegatePlugin } from '../../tools/DelegateTool.js';
import { __test__ as modelsTest } from '../../models/index.js';
import { buildDelegateBlockOptions } from './delegateBlockView.js';
import { setLocale, t as tr } from '../../../core/i18n/index.js';
import { buildSubTaskNotificationText } from './subTaskNotification.js';
import { buildSubTaskResultDelivery } from './subTaskResultDelivery.js';
import type { SubTask } from '../../sub-agents/index.js';
import { _chatOnToolResults, _deliverSubTaskResult } from './chat_streaming.js';
import { renderNotificationWithReceipt } from './backgroundReceipt.js';
import { buildMachineView } from './machineMessage.js';

setLocale('pl');

type El = {
    children: El[]; parent: El | null; classList: { add(...v: string[]): void; remove(...v: string[]): void; toggle(v: string, force?: boolean): void; contains(v: string): boolean };
    className: string; textContent: string; listeners: Record<string, Array<(ev: unknown) => void>>;
    style: { setProperty(name: string, value: string): void; getPropertyValue(name: string): string }; appendText(text: string): void;
    createDiv(opts?: { cls?: string | string[] }): El; createSpan(opts?: { cls?: string | string[]; text?: string }): El;
    createEl(tag: string, opts?: { cls?: string | string[]; text?: string }): El; appendChild(child: El): El; empty(): void;
    setAttribute(name: string, value: string): void; getAttribute(name: string): string | null; removeAttribute(name: string): void; hasAttribute(name: string): boolean; remove(): void;
    addEventListener(name: string, cb: (ev: unknown) => void): void; scrollIntoView(): void; querySelectorAll(selector: string): El[];
    firstChild: El | null; firstElementChild: El | null; scrollTop: number; scrollHeight: number; clientHeight: number; height: number;
    getBoundingClientRect(): { top: number; bottom: number }; contains(child: El): boolean;
    replaceWith(...children: El[]): void;
    querySelector(selector: string): El | null; focus(options?: FocusOptions): void;
};

function el(): El {
    const classes = new Set<string>(), attrs = new Map<string, string>();
    const node: El = {
        children: [], parent: null, listeners: {}, className: '', textContent: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, height: 0,
        get firstChild() { return this.children[0] ?? null; }, get firstElementChild() { return this.firstChild; },
        classList: { add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)), toggle: (v, force) => force ?? !classes.has(v) ? classes.add(v) : classes.delete(v), contains: v => classes.has(v) },
        style: { setProperty() {}, getPropertyValue() { return ''; } }, appendText(text) { this.textContent += text; },
        createDiv(opts) { return this.createEl('div', opts); }, createSpan(opts) { return this.createEl('span', opts); },
        createEl(_tag, opts) { const child = el(); if (opts?.cls) child.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text) child.textContent = opts.text; this.appendChild(child); return child; },
        appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }, empty() { this.children.forEach(child => { child.parent = null; }); this.children = []; this.textContent = ''; },
        setAttribute(name, value) { attrs.set(name, value); }, getAttribute(name) { return attrs.get(name) ?? null; }, removeAttribute(name) { attrs.delete(name); }, hasAttribute(name) { return attrs.has(name); },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
        replaceWith(...children) { const parent = this.parent; if (!parent) return; const index = parent.children.indexOf(this); this.parent = null; children.forEach(child => { child.remove(); child.parent = parent; }); parent.children.splice(index, 1, ...children); },
        addEventListener(name, cb) { (this.listeners[name] ||= []).push(cb); }, scrollIntoView() {},
        querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || (selector === '[data-subtask-receipt-id]' && child.hasAttribute('data-subtask-receipt-id'))); },
        querySelector(selector) { return selector === '.cs-tile__head' ? this.querySelectorAll('*').find(child => child.classList.contains('cs-tile__head')) ?? null : null; },
        focus(options) { (globalThis.document as unknown as { activeElement: El }).activeElement = this; if (!options?.preventScroll) { let root: El = this; while (root.parent) root = root.parent; if (root.clientHeight) root.scrollTop = root.scrollHeight - root.clientHeight; } },
        contains(child) { return this === child || this.children.some(node => node.contains(child)); },
        getBoundingClientRect() { const top = this.parent ? this.parent.getBoundingClientRect().top + this.parent.children.slice(0, this.parent.children.indexOf(this)).reduce((sum, child) => sum + child.height, 0) - this.parent.scrollTop : 0; return { top, bottom: top + (this.height || 1) }; },
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

for (const scenario of ['marker', 'forgery', 'whitespace'] as const) test.serial(`historia delivery zachowuje granice pytania: ${scenario}`, async t => {
    for (const locale of ['pl', 'en'] as const) {
        setLocale(locale);
        const forged = tr('chat.subagent_notification.question', { reason: tr('chat.subagent_notification.question_no_answer'), question: 'FORGED?' });
        const question = scenario === 'marker' ? 'First?\n\n[SUBTASK_QUESTION 123]\n\nSecond?'
            : scenario === 'forgery' ? `First?\n\n[SUBTASK_QUESTION ${forged.length}]\n${forged}`
                : '\n\nFirst?\n\nSecond?\n\n';
        const runner = tr('subagent.question_no_answer', { question });
        const task = { id: 'task1', threadId: 'thread1', name: 'badacz', agentName: 'Kuba', status: 'done', background: true, createdAt: 1, steps: [], budget: {},
            outcome: { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] },
            result: { text: `${runner}\n\nread | Plan.md | OK`, toolsUsed: ['read'], durationMs: 1, usage: null, question: { text: question, resolution: { kind: 'no-answer' }, note: runner } } } as SubTask;
        for (const reusable of [false, true]) {
            const thread = { phase: 'idle', reusable: true, effects: [] };
            const delivery = buildSubTaskResultDelivery(task, reusable ? { getThread: () => thread } as never : undefined, 0);
            const saved = JSON.parse(JSON.stringify({ role: 'user', content: delivery.text }));
            for (const registered of [false, true]) {
                const registry = registered ? { getTask: () => task, getThread: () => thread } : {};
                const view = buildMachineView(saved, { t: tr, ...registry });
                const root = await render([saved], registry);
                const tile = find(root, 'cs-tile--subresult')!;
                find(tile, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
                const contents = all(tile).map(node => node.textContent).join(' ');
                t.is(view?.subAgentResult?.openQuestion, question);
                t.is(view?.subAgentResult?.material, 'read | Plan.md | OK');
                t.true(tile.classList.contains('cs-tile--attention'));
                t.is(find(tile, 'cs-subresult__question')?.textContent, tr('chat.substrip.question_open', { question }));
                t.is(contents.split(question).length - 1, 1);
                t.false(contents.includes(runner));
                if (reusable && registered) t.true(contents.includes(tr('chat.subresult.continue_same_thread')));
            }
        }
    }
    setLocale('pl');
});

test.serial('wynik bez odpowiedzi w streamie i historii pokazuje pytanie', async t => {
    const oldDocument = (globalThis as Record<string, unknown>).document, oldCreateDiv = globalThis.createDiv;
    (globalThis as Record<string, unknown>).document = { createElement: () => el() };
    globalThis.createDiv = (() => el()) as never;
    try {
        for (const hasQuestion of [true, false]) {
            const result = { success: true, aspect: 'badacz', result: 'dorobek',
                outcome: { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] },
                ...(hasQuestion ? { question: { text: 'Jaki zakres?', resolution: { kind: 'no-answer' } } } : {}) };
            const history = await render([{ role: 'assistant', content: '', tool_calls: [{ id: 'call', function: { name: 'delegate', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'call', content: JSON.stringify(result) }]);
            const container = el(), placeholder = el(); container.appendChild(placeholder);
            const turn = { agentName: 'Kuba', owner: { memory: null }, origin: {}, turnId: 1, turnKind: 'user',
                rawResults: new Map([['call', { result, error: null }]]), pendingEntries: [{ toolDisplay: placeholder, args: {} }],
                lastRoundToolResults: [], toolCallsContainer: null, tt: { record() {} } };
            const view = { _isTurnActiveTab: () => true, chatTabs: [], env: {}, _updateTokenPanel() {}, _agentStates: new Map(),
                _renderSubTaskStrip() {}, _scheduleConnectorRedraw() {}, showTypingIndicator() {} };
            await _chatOnToolResults.call(view as never, turn as never, [{ toolCall: { id: 'call', name: 'delegate', arguments: {} }, result: 'done' }] as never, 0);
            for (const root of [history, container]) {
                find(root, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
                const text = all(root).map(node => node.textContent).join(' ');
                t.is(text.includes('brak odpowiedzi'), hasQuestion);
                t.is(text.includes('Otwarte pytanie: Jaki zakres?'), hasQuestion);
            }
        }
    } finally { (globalThis as Record<string, unknown>).document = oldDocument; globalThis.createDiv = oldCreateDiv; }
});

test.serial('powiadomienie i odtworzenie korzystają z pytania zakończonego zadania', async t => {
    const registry = new SubTaskRegistry();
    t.teardown(() => registry.dispose());
    const owner = { agentName: 'Kuba', sessionPath: 's.md', sessionEpoch: 'e1' };
    const task = registry.create({ id: 'question-run', threadId: 'question-thread', name: 'badacz', origin: owner });
    const opened = registry.openParentQuestion(task.id, 'Jaki zakres?');
    if (opened.kind !== 'opened') throw new Error('Brak pytania');
    registry.finish(task, { text: 'dorobek', toolsUsed: [], durationMs: 1, usage: null,
        outcome: { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } });
    task.questionState = { kind: 'closed', question: opened.question, resolution: { kind: 'no-answer' } };
    const root = await render([{ role: 'user', content: buildSubTaskNotificationText(task, {}) }], registry);
    find(root, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
    const text = all(root).map(node => node.textContent).join(' ');
    t.true(text.includes('brak odpowiedzi'));
    t.true(text.includes('Otwarte pytanie: Jaki zakres?'));
});

test.serial('B5: żywe doręczenie usuwa pokwitowanie biegu', async t => {
    const oldDocument = (globalThis as Record<string, unknown>).document;
    const oldCreateDiv = globalThis.createDiv;
    globalThis.createDiv = (() => el()) as never;
    (globalThis as Record<string, unknown>).document = { createElement: () => el() };
    try {
        const container = el();
        const pending = el();
        pending.setAttribute('data-subtask-receipt-id', 'run-a');
        container.appendChild(pending);
        const messages: unknown[] = [];
        const view = { messages_container: container, rollingWindow: { messages, addMessage(role: string, content: unknown, meta: unknown) { messages.push({ role, content, ...meta as object }); } },
            plugin: { agentManager: { getActiveAgent: () => ({ name: 'Kuba' }) } }, updateTokenCounter() {}, scrollToBottom() {}, _contentBlocksToText() { return ''; } };
        await append_message.call(view as never, 'user', 'wynik', undefined, { origin: 'machine', _subTaskNotification: true, subTaskId: 'run-a',
            _subTaskResult: { name: 'badacz', outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] }, result: { text: 'Wynik dla A' }, thread: { kind: 'single' } } } as never);
        t.deepEqual(all(container).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean), []);
        t.is(find(container, 'cs-tile__title')?.textContent, 'badacz skończył sam');
    } finally { globalThis.createDiv = oldCreateDiv; (globalThis as Record<string, unknown>).document = oldDocument; }
});

test.serial('B5: paczka i dwa biegi tego samego wątku rozliczają się osobno i zgodnie z historią', async t => {
    const oldDocument = (globalThis as Record<string, unknown>).document, oldCreateDiv = globalThis.createDiv;
    (globalThis as Record<string, unknown>).document = { createElement: () => el() };
    globalThis.createDiv = (() => el()) as never;
    try {
        const container = el(), placeholder = el(); container.appendChild(placeholder);
        const tasks = ['run-a', 'run-b', 'run-c'].map(task_id => ({ task_id, name: 'badacz', sub_id: 'same-thread' }));
        const turn = { agentName: 'Kuba', owner: { memory: null }, origin: {}, turnId: 1, turnKind: 'user',
            rawResults: new Map([['call', { result: { started: true, tasks }, error: null }]]),
            pendingEntries: [{ toolDisplay: placeholder, args: { action: 'task', task: 'zrób' } }], lastRoundToolResults: [], toolCallsContainer: null, tt: { record() {} } };
        const messages: unknown[] = receipt(tasks);
        const view = { messages_container: container, rollingWindow: { messages, addMessage(role: string, content: unknown, meta: unknown) { messages.push({ role, content, ...meta as object }); } },
            plugin: { agentManager: { getActiveAgent: () => ({ name: 'Kuba' }) } }, _isTurnActiveTab: () => true, chatTabs: [], env: {}, _updateTokenPanel() {},
            _agentStates: new Map(), _renderSubTaskStrip() {}, _scheduleConnectorRedraw() {}, showTypingIndicator() {}, updateTokenCounter() {}, scrollToBottom() {}, _contentBlocksToText() { return ''; } };
        await _chatOnToolResults.call(view as never, turn as never, [{ toolCall: { id: 'call', name: 'sub_agent', arguments: { task: 'zrób' } }, result: 'accepted' }] as never, 0);
        const ids = () => all(container).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean);
        t.deepEqual(ids(), ['run-a', 'run-b', 'run-c']);
        const other = container.children[1], head = find(other, 'cs-tile__head')!;
        head.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
        for (const [index, task] of tasks.entries()) {
            await append_message.call(view as never, 'user', notification(task.task_id).content, undefined, { origin: 'machine', _subTaskNotification: true, subTaskId: task.task_id,
                _subTaskResult: { name: 'badacz', outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] }, result: { text: `Wynik dla ${task.task_id}` }, thread: { kind: 'single' } } } as never);
            t.deepEqual(ids(), tasks.slice(index + 1).map(item => item.task_id));
            if (index === 0) {
                t.is(container.children[0], other); t.is(head.getAttribute('aria-expanded'), 'true');
                const result = all(container).find(node => node.classList.contains('cs-tile--system'))!;
                t.is(find(result, 'cs-tile__title')?.textContent, `badacz ${tr('chat.substrip.state_done')}`);
                find(result, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
                t.true(all(result).some(node => node.textContent === 'Wynik dla run-a'));
            }
        }
        t.is(all(container).filter(node => node.classList.contains('cs-tile--system')).length, 3);
        const history = await render(messages);
        t.deepEqual(all(history).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean), []);
        t.is(all(history).filter(node => node.classList.contains('cs-tile--system')).length, 3);
        const noMeta = await render([...receipt(tasks), ...tasks.map(task => notification(task.task_id))]);
        t.deepEqual(all(noMeta).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean), []);
        t.is(all(noMeta).filter(node => node.classList.contains('cs-tile--system')).length, 3);
    } finally { globalThis.createDiv = oldCreateDiv; (globalThis as Record<string, unknown>).document = oldDocument; }
});

test.serial('B5: kotwica historii i dolna krawędź przeżywają usunięcie receipt', async t => {
    const oldDocument = (globalThis as Record<string, unknown>).document, oldCreateDiv = globalThis.createDiv;
    (globalThis as Record<string, unknown>).document = { createElement: () => el() };
    globalThis.createDiv = (() => el()) as never;
    try {
        for (const atBottom of [false, true]) {
            const container = el(), spacer = el(), pending = el(), anchor = el();
            spacer.height = 344; pending.height = 80; anchor.height = 300;
            pending.setAttribute('data-subtask-receipt-id', 'run-a');
            anchor.setAttribute('aria-expanded', 'true');
            container.appendChild(spacer); container.appendChild(pending); container.appendChild(anchor);
            container.clientHeight = 100;
            Object.defineProperty(container, 'scrollHeight', { get: () => container.children.reduce((sum, child) => sum + child.height, 0) });
            container.scrollTop = atBottom ? 624 : 400;
            const before = anchor.getBoundingClientRect().top;
            const message = { ...notification('run-a'), origin: 'machine' as const, _subTaskNotification: true, subTaskId: 'run-a' };
            const machine = buildMachineView(message, { t: tr })!;
            await renderNotificationWithReceipt(container as never, {} as never, machine, 'run-a', () => {});
            if (atBottom) t.is(container.scrollTop, container.scrollHeight - container.clientHeight);
            else { t.is(before, 24); t.is(container.scrollTop, 320); t.is(anchor.getBoundingClientRect().top, 24); }
            t.is(container.children[1], anchor);
            t.is(anchor.getAttribute('aria-expanded'), 'true');
        }
    } finally { globalThis.createDiv = oldCreateDiv; (globalThis as Record<string, unknown>).document = oldDocument; }
});

test.serial('B5: fokus receipt przechodzi na nagłówek wyniku, a zmiana zakładki anuluje render', async t => {
    const oldDocument = (globalThis as Record<string, unknown>).document, oldCreateDiv = globalThis.createDiv;
    const doc = { createElement: () => el(), activeElement: null as El | null };
    (globalThis as Record<string, unknown>).document = doc;
    globalThis.createDiv = (() => el()) as never;
    try {
        const root = el(), receiptEl = el(), head = el();
        receiptEl.setAttribute('data-subtask-receipt-id', 'run-a'); receiptEl.appendChild(head); root.appendChild(receiptEl); head.focus();
        const view = buildMachineView({ ...notification('run-a'), _subTaskNotification: true, subTaskId: 'run-a' }, { t: tr })!;
        t.false(await renderNotificationWithReceipt(root as never, {} as never, view, 'run-a', () => {}, () => false));
        t.is(root.children[0], receiptEl);
        t.is(doc.activeElement, head);
        t.true(await renderNotificationWithReceipt(root as never, {} as never, view, 'run-a', () => {}));
        t.is(doc.activeElement, find(root, 'cs-tile__head') ?? null);
        t.deepEqual(all(root).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean), []);
    } finally { globalThis.createDiv = oldCreateDiv; (globalThis as Record<string, unknown>).document = oldDocument; }
});

test.serial('B5: fokus wyniku nie przewija poza kotwicę historii', async t => {
    const oldDocument = (globalThis as Record<string, unknown>).document, oldCreateDiv = globalThis.createDiv;
    const doc = { createElement: () => el(), activeElement: null as El | null };
    (globalThis as Record<string, unknown>).document = doc;
    globalThis.createDiv = (() => el()) as never;
    try {
        const root = el(), spacer = el(), pending = el(), head = el(), anchor = el(), later = el();
        spacer.height = 344; pending.height = 80; anchor.height = 300; later.height = 2000;
        pending.setAttribute('data-subtask-receipt-id', 'run-a'); pending.appendChild(head);
        root.appendChild(spacer); root.appendChild(pending); root.appendChild(anchor); root.appendChild(later);
        root.clientHeight = 100;
        Object.defineProperty(root, 'scrollHeight', { get: () => root.children.reduce((sum, child) => sum + child.height, 0) });
        head.focus({ preventScroll: true }); root.scrollTop = 400;
        t.is(anchor.getBoundingClientRect().top, 24);
        const view = buildMachineView({ ...notification('run-a'), _subTaskNotification: true, subTaskId: 'run-a' }, { t: tr })!;
        await renderNotificationWithReceipt(root as never, {} as never, view, 'run-a', () => {});
        t.is(root.scrollTop, 320);
        t.is(anchor.getBoundingClientRect().top, 24);
        t.is(doc.activeElement, find(root, 'cs-tile__head') ?? null);
    } finally { globalThis.createDiv = oldCreateDiv; (globalThis as Record<string, unknown>).document = oldDocument; }
});

test.serial('B5: wynik A nie zmienia DOM B i po powrocie rozlicza tylko A', async t => {
    const oldDocument = (globalThis as Record<string, unknown>).document, oldCreateDiv = globalThis.createDiv;
    (globalThis as Record<string, unknown>).document = { createElement: () => el() };
    globalThis.createDiv = (() => el()) as never;
    const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
    try {
        const a = el(), b = el();
        for (const [root, id] of [[a, 'run-a'], [a, 'run-other'], [b, 'run-b']] as const) { const pending = el(); pending.setAttribute('data-subtask-receipt-id', id); root.appendChild(pending); }
        const origin = { agentName: 'A', sessionPath: 'a.md', sessionEpoch: 'a', tabKey: 'a' };
        const tabs = [{ ...origin, sessionId: 'a', isActive: false }, { agentName: 'B', sessionPath: 'b.md', sessionEpoch: 'b', sessionId: 'b', isActive: true }];
        const messages: unknown[] = [];
        const view = { chatTabs: tabs, messages_container: b, _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
            env: { settings: { pkmAssistant: { limits: {} } } }, plugin: { subTaskRegistry: registry, agentManager: { getActiveAgent: () => ({ name: 'A' }) } },
            rollingWindow: { messages, addMessage(role: string, content: unknown, meta: unknown) { messages.push({ role, content, ...meta as object }); } },
            updateTokenCounter() {}, scrollToBottom() {}, _contentBlocksToText() { return ''; },
            send_message(opts: { injectedText: string; meta: Record<string, unknown> }) { return append_message.call(view as never, 'user', opts.injectedText, undefined, opts.meta as never); } };
        notifier.setDeliverer(task => _deliverSubTaskResult.call(view as never, task));
        const task = registry.create({ id: 'run-a', name: 'worker', agentName: 'A', origin, background: true });
        registry.finish(task, { text: 'Wynik dla A', toolsUsed: [], durationMs: 1000, usage: null });
        t.deepEqual(all(b).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean), ['run-b']);
        t.deepEqual(notifier.pending().map(item => item.id), ['run-a']);
        tabs[1].isActive = false; tabs[0].isActive = true; view.messages_container = a;
        notifier.drain();
        await new Promise(resolve => setTimeout(resolve, 0));
        t.deepEqual(all(a).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean), ['run-other']);
        t.deepEqual(all(b).map(node => node.getAttribute('data-subtask-receipt-id')).filter(Boolean), ['run-b']);
        t.is(all(a).filter(node => node.classList.contains('cs-tile--system')).length, 1);
    } finally { notifier.dispose(); registry.dispose(); globalThis.createDiv = oldCreateDiv; (globalThis as Record<string, unknown>).document = oldDocument; }
});

test.serial('świeża ramka pokazuje kontynuację tylko dostępnego wątku', async t => {
    for (const phase of ['idle', 'closed'] as const) {
        const oldDocument = (globalThis as Record<string, unknown>).document;
        const oldCreateDiv = globalThis.createDiv;
        globalThis.createDiv = (() => el()) as never;
        (globalThis as Record<string, unknown>).document = { createElement: () => el() };
        const registry = new SubTaskRegistry();
        const owner = { agentName: 'Kuba', sessionPath: 'active.md', sessionEpoch: 'epoch' };
        registry.createThread({ threadId: 'thread-fresh', name: 'badacz', owner, origin: owner, config: {} });
        registry.endRun('thread-fresh', { successful: true, answer: 'gotowe' });
        if (phase === 'closed') registry.closeThread('thread-fresh');
        const container = el();
        const messages: unknown[] = [];
        const view = { messages_container: container, rollingWindow: { messages, addMessage(role: string, content: unknown, meta: unknown) { messages.push({ role, content, ...meta as object }); } },
            plugin: { agentManager: { getActiveAgent: () => ({ name: 'Kuba' }) }, subTaskRegistry: registry },
            updateTokenCounter() {}, scrollToBottom() {}, _contentBlocksToText() { return ''; } };
        try {
            await append_message.call(view as never, 'user', 'wynik', undefined, { origin: 'machine', _subTaskNotification: true, subTaskId: 'run-fresh',
                _subTaskResult: { outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] },
                    result: { text: 'gotowe' }, thread: { kind: 'reusable', sub_id: 'thread-fresh' } } } as never);
            const head = find(container, 'cs-tile__head');
            head?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
            t.is(all(container).some(node => node.textContent.includes('Agent może dokończyć tym samym subem')), phase === 'idle');
        } finally { registry.dispose(); globalThis.createDiv = oldCreateDiv; (globalThis as Record<string, unknown>).document = oldDocument; }
    }
});

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

test.serial('B3: zapisane puste powiadomienie zachowuje stop i błąd bez dorobku', async t => {
    for (const end of [{ kind: 'stopped', by: 'user' }, { kind: 'failed', stage: 'work' }] as const) {
        const task = { id: 'task-empty', name: 'badacz', agentName: 'Jaskier', status: 'error', createdAt: 0, steps: [], budget: {}, background: true,
            error: 'awaria dysku', outcome: { end, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } } as SubTask;
        const saved = JSON.parse(JSON.stringify({ role: 'user', content: buildSubTaskNotificationText(task) })) as { role: string; content: string };
        const root = await render([saved], new SubTaskRegistry());
        const tile = find(root, 'cs-tile--system')!;
        find(tile, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
        const contents = all(tile).map(node => node.textContent).join(' ');
        t.true(contents.includes(tr(end.kind === 'stopped' ? 'chat.substrip.state_partial_user' : 'chat.substrip.state_partial_error')));
        t.false(contents.includes(tr('chat.subresult.user_stopped_material')));
        t.false(contents.includes(tr('chat.subagent_notification.empty', { reason: tr(end.kind === 'stopped' ? 'chat.subagent_notification.end_stopped_user' : 'chat.subagent_notification.end_failed_work') })));
        if (end.kind === 'failed') t.true(contents.includes('awaria dysku'));
    }
});

test.serial('B4: wynik wątku po restarcie i po zamknięciu nie obiecuje kontynuacji', async t => {
    const current = makeFixture();
    const notifier = new SubTaskNotifier({ registry: current.registry });
    t.teardown(() => { notifier.dispose(); current.registry.dispose(); });
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1' };
    const run = await current.tool.execute({ task: 'zrób', _invocationOrigin: origin }, {}, current.plugin) as { task_id: string; sub_id: string };
    current.requests[0].complete('Wynik rzeczywistego wątku');
    await waitUntil(() => current.registry.getTask(run.task_id)?.status === 'done');
    const task = current.registry.getTask(run.task_id)!;
    const content = buildSubTaskNotificationText(task, { subId: run.sub_id });
    const saved = { role: 'user', content };
    const live = { ...saved, _subTaskNotification: true, _subTaskResult: { name: task.name, outcome: task.outcome, result: task.result, thread: { kind: 'reusable', sub_id: run.sub_id } } };
    const fresh = new SubTaskRegistry();
    t.teardown(() => fresh.dispose());
    current.registry.closeThread(run.sub_id);
    for (const [message, registry] of [[saved, fresh], [live, current.registry]] as const) {
        const root = await render([message], registry);
        const tile = find(root, 'cs-tile--system')!;
        find(tile, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
        const contents = all(tile).map(node => node.textContent).join(' ');
        t.true(contents.includes('Wynik rzeczywistego wątku'));
        t.false(contents.includes(tr('chat.subresult.continue_same_thread')));
    }
});

test.serial('B5: zatrzymane pokwitowanie pozostaje zakończone podczas kontynuacji', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1' };
    const first = await tool.execute({ task: 'pierwsze', _invocationOrigin: origin }, {}, plugin) as { task_id: string; sub_id: string };
    t.true(registry.requestStop(first.task_id, 'user'));
    requests[0].complete('po stopie');
    await waitUntil(() => registry.getTask(first.task_id)?.status === 'aborted');
    const turnStartedSeq = registry.issueTurnStartSequence();
    const next = await createSubAgentTool({}).execute({ action: 'task', task: 'kontynuuj', sub_id: first.sub_id, _invocationOrigin: origin, _invocationTurnKind: 'user', _invocationTurnStartedSeq: turnStartedSeq }, {}, plugin) as { task_id: string; started: boolean };
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

test.serial('blokujący delegate przekazuje dokładną notkę do widoku i historii', async t => {
    const { registry, plugin } = makeFixture();
    t.teardown(() => registry.dispose());
    const question = 'First? Second?';
    const note = 'Sub n…';
    const tool = createDelegateTool({}, { makeRunner: () => ({ runTask: async () => ({
        result: '', handoff: `${note}\n\nDOROBEK`, toolsUsed: ['read'], toolCallDetails: [], duration: 1, usage: null,
        question: { text: question, resolution: { kind: 'no-answer' as const }, note },
        outcome: { end: { kind: 'timeout' as const }, completeness: 'partial' as const, hasAnswer: false, hasMaterial: true, effects: [] },
    }) }) });
    const result = await tool.execute({ task: 'raport', background: false }, {}, plugin) as Parameters<typeof buildDelegateBlockOptions>[0];
    const view = buildDelegateBlockOptions(result, { type: 'delegate', agentName: 'pkm-sub' }).resultView;
    const history = await render([
        { role: 'assistant', content: '', tool_calls: [{ id: 'blocking', function: { name: 'delegate', arguments: JSON.stringify({ task: 'raport' }) } }] },
        { role: 'tool', tool_call_id: 'blocking', content: JSON.stringify(result) },
    ]);
    const tile = find(history, 'cs-tile--agent')!;
    find(tile, 'cs-tile__head')?.listeners.click?.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }));
    const contents = all(tile).map(node => node.textContent).join(' ');
    t.is(view?.material, 'DOROBEK');
    t.is(view?.openQuestion, question);
    t.true(contents.includes('DOROBEK'));
    t.is(contents.split(question).length - 1, 1);
    t.false(contents.includes(note));
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
