import test from 'ava';
import { _chatOnToolResults } from './chat_streaming.js';
import { createSubAgentBlock } from '../../ui-components/index.js';
import { buildDelegateBlockOptions } from './delegateBlockView.js';

type FakeEl = {
    className: string;
    textContent: string;
    children: FakeEl[];
    classList: { add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): void; contains(name: string): boolean };
    appendChild(child: FakeEl): FakeEl;
    empty(): void;
    appendText(value: string): void;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    addEventListener(name: string, listener: unknown): void;
    scrollIntoView(): void;
};

function fakeElement(): FakeEl {
    const names = new Set<string>();
    let content = '';
    const el: FakeEl = {
        children: [],
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
        setAttribute() {}, removeAttribute() {}, addEventListener() {}, scrollIntoView() {},
    };
    return el;
}

function snapshot(el: FakeEl): unknown {
    return { className: el.className, text: el.textContent, children: el.children.map(snapshot) };
}

async function renderLive(result: unknown, error: Error | null = null): Promise<FakeEl> {
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: () => fakeElement() };
    try {
        let block: FakeEl | null = null;
        const toolCall = { id: 'call_1', name: 'delegate', arguments: JSON.stringify({ task: 'zapisz' }) };
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
