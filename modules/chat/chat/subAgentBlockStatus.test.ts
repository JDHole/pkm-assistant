import test from 'ava';
import { _chatOnToolCallsParsed, _chatOnToolResults } from './chat_streaming.js';
import { createSubAgentBlock } from '../../ui-components/index.js';
import { buildDelegateBlockOptions } from './delegateBlockView.js';

type FakeEl = {
    className: string;
    textContent: string;
    children: FakeEl[];
    listeners: Record<string, Array<() => void>>;
    classList: { add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): void; contains(name: string): boolean };
    appendChild(child: FakeEl): FakeEl;
    empty(): void;
    appendText(value: string): void;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    addEventListener(name: string, listener: () => void): void;
    scrollIntoView(): void;
};

function fakeElement(): FakeEl {
    const names = new Set<string>();
    let content = '';
    const el: FakeEl = {
        children: [],
        listeners: {},
        classList: {
            add: (...values) => { values.forEach(value => names.add(value)); },
            remove: (...values) => { values.forEach(value => names.delete(value)); },
            toggle: (value, force) => { const next = force ?? !names.has(value); if (next) names.add(value); else names.delete(value); },
            contains: value => names.has(value),
        },
        get className() { return [...names].join(' '); },
        set className(value: string) { names.clear(); value.split(/\s+/).filter(Boolean).forEach(name => names.add(name)); },
        get textContent() { return content; },
        set textContent(value: string) { content = value; el.children = []; },
        appendChild(child) { el.children.push(child); return child; },
        empty() { content = ''; el.children = []; },
        appendText(value) { content += value; },
        setAttribute() {}, removeAttribute() {}, addEventListener(name, listener) { (el.listeners[name] ||= []).push(listener); }, scrollIntoView() {},
    };
    return el;
}

function snapshot(el: FakeEl): unknown {
    return { className: el.className, text: el.textContent, children: el.children.map(snapshot) };
}

function deepText(el: FakeEl): string {
    return el.textContent + el.children.map(deepText).join('');
}

function hasClass(el: FakeEl, name: string): boolean {
    return el.className.split(/\s+/).includes(name) || el.children.some(child => hasClass(child, name));
}

function findByClass(el: FakeEl, name: string): FakeEl | null {
    if (el.classList.contains(name)) return el;
    for (const child of el.children) {
        const found = findByClass(child, name);
        if (found) return found;
    }
    return null;
}

async function renderLive(result: unknown, error: Error | null = null, name = 'delegate', args: Record<string, unknown> = { task: 'zapisz' }): Promise<FakeEl> {
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: () => fakeElement() };
    try {
        let block: FakeEl | null = null;
        const toolCall = { id: 'call_1', name, arguments: JSON.stringify(args) };
        const turn = {
            agentName: 'Jaskier', toolCallsContainer: null,
            owner: { memory: null }, origin: { sessionPath: '' },
            rawResults: new Map([['call_1', { result, error }]]),
            pendingEntries: [{ isSubAgent: true, toolDisplay: { replaceWith: (el: FakeEl) => { block = el; } } }],
        };
        const view = { _isTurnActiveTab: () => true, _scheduleConnectorRedraw: () => {}, toolReactors: { run: async () => {} } };
        await _chatOnToolResults.call(view as never, turn as never, [{ toolCall, result }] as never, 0);
        if (!block) throw new Error('Brak kafelka delegate');
        return block;
    } finally {
        (globalThis as Record<string, unknown>).document = previous;
    }
}

test.serial('wynik delegate na żywo odpowiada wspólnym opcjom kafelka', async t => {
    const result = { success: false, error: 'Limit czasu', aspect: 'pkm-sub', partial_result: 'DOROBEK', tools_used: ['write'], tool_call_details: [{ name: 'write' }], usage: { prompt_tokens: 4, completion_tokens: 2 }, duration_ms: 12345 };
    const actual = await renderLive(result);
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: () => fakeElement() };
    try {
        const expected = createSubAgentBlock(buildDelegateBlockOptions(result, { type: 'delegate', query: 'zapisz' })) as unknown as FakeEl;
        t.deepEqual(snapshot(actual), snapshot(expected));
        t.true(actual.classList.contains('cs-tile--error'));
    } finally {
        (globalThis as Record<string, unknown>).document = previous;
    }
});

test.serial('transportowy błąd i pokwitowanie w tle zachowują osobne statusy', async t => {
    const transport = await renderLive(undefined, new Error('sieć'));
    const started = await renderLive({ success: true, started: true, task_id: 'sub/a#1', name: 'pkm-sub' });
    t.true(transport.classList.contains('cs-tile--error'));
    t.true(started.classList.contains('cs-tile--pending'));
});

test.serial('sub_agent task, pokwitowanie, list i odmowa renderują właściwy status na żywo', async t => {
    const partial = await renderLive({ success: false, aspect: 'literal-sub', outcome: { end: 'limit' }, error: 'limit', partial_result: 'dorobek' }, null, 'sub_agent', { action: 'task', task: 'zadanie', aspect: 'wrong-args-name' });
    t.true(partial.classList.contains('cs-tile--error'));
    t.true(deepText(partial).includes('literal-sub'));

    const receipt = await renderLive({ success: true, started: true, task_id: 'sub/id#7', name: 'worker', sub_id: 'sub/worker' }, null, 'sub_agent', { action: 'task', task: 'zadanie' });
    t.true(receipt.classList.contains('cs-tile--pending'));
    t.is(findByClass(receipt, 'cs-tile__title')?.textContent, 'Sent to background: worker');
    t.false(deepText(findByClass(receipt, 'cs-tile__head')!).includes('sub/id#7'));
    findByClass(receipt, 'cs-tile__head')?.listeners.click?.forEach(listener => listener());
    t.is(findByClass(receipt, 'cs-tile__details')?.textContent.trimEnd().split('\n').at(-1), 'Id: sub/id#7');

    const listed = await renderLive({ success: true, threads: [] }, null, 'sub_agent', { action: 'list' });
    t.true(hasClass(listed, 'cs-tile--ok'));
    t.is(findByClass(listed, 'cs-tile__title')?.textContent, 'Action: list | sub_id: ');

    const denied = await renderLive({ success: false, error: 'odmowa' }, null, 'sub_agent', { action: 'task', task: 'zadanie' });
    t.true(hasClass(denied, 'cs-tile--error'));
    t.true(deepText(denied).includes('odmowa'));
    t.false(hasClass(denied, 'cs-tile--agent'));
});

test.serial('_chatOnToolCallsParsed tworzy blok sub_agent task w toku', t => {
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: () => fakeElement() };
    try {
        const container = fakeElement();
        const turn = { agent: {}, pendingEntries: [], toolCallsContainer: null };
        const view = {
            _isTurnActiveTab: () => true,
            current_message_container: container,
            current_message_bubble: container,
            hideTypingIndicator: () => {},
            _scheduleConnectorRedraw: () => {},
        };
        _chatOnToolCallsParsed.call(view as never, turn as never, [{ id: 'call_task', name: 'sub_agent', arguments: JSON.stringify({ action: 'task', task: 'zadanie', sub_id: 'sub/worker' }) }] as never);
        t.is(container.children.length, 1);
        const pending = container.children[0];
        t.true(pending.classList.contains('cs-tile--agent'));
        t.true(pending.classList.contains('cs-tile--pending'));
        t.is(findByClass(pending, 'cs-tile__title')?.textContent, 'Sub-agent sub/worker is working');
    } finally {
        (globalThis as Record<string, unknown>).document = previous;
    }
});
