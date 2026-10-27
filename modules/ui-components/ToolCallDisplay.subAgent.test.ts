import test from 'ava';
import { TOOL_INFO, createCompactToolChip, describeToolCall, subAgentNameFromId } from './ToolCallDisplay.js';
import { t as tr } from '../../core/i18n/index.js';

type FakeEl = {
    className: string;
    textContent: string;
    children: FakeEl[];
    classList: { add(...names: string[]): void; remove(...names: string[]): void; contains(name: string): boolean };
    appendChild(child: FakeEl): FakeEl;
    empty(): void;
    appendText(text: string): void;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    addEventListener(name: string, listener: unknown): void;
};

function fakeElement(): FakeEl {
    const names = new Set<string>();
    let content = '';
    const el: FakeEl = {
        children: [],
        classList: {
            add: (...values) => { values.forEach(value => names.add(value)); },
            remove: (...values) => { values.forEach(value => names.delete(value)); },
            contains: value => names.has(value),
        },
        get className() { return [...names].join(' '); },
        set className(value: string) { names.clear(); value.split(/\s+/).filter(Boolean).forEach(name => names.add(name)); },
        get textContent() { return content; },
        set textContent(value: string) { content = value; el.children = []; },
        appendChild(child) { el.children.push(child); return child; },
        empty() { content = ''; el.children = []; },
        appendText(value) { content += value; },
        setAttribute() {}, removeAttribute() {}, addEventListener() {},
    };
    return el;
}

function findByClass(el: FakeEl, name: string): FakeEl | null {
    if (el.classList.contains(name)) return el;
    for (const child of el.children) {
        const found = findByClass(child, name);
        if (found) return found;
    }
    return null;
}

function deepText(el: FakeEl): string {
    return el.textContent + el.children.map(deepText).join('');
}

function renderChip(input: object, output?: object, status: 'pending' | 'success' | 'error' = 'pending'): FakeEl {
    return createCompactToolChip({ name: 'sub_agent', input, output, status }) as unknown as FakeEl;
}

test('TOOL_INFO sub_agent shows human action and name without task or message content', t => {
    const input = { action: 'message', sub_id: 'sub/researcher#deadbeef-9', task: 'SECRET TASK', text: 'SECRET MESSAGE' };
    const description = describeToolCall('sub_agent', input);
    t.is(TOOL_INFO.sub_agent.label, tr('tool.sub_agent'));
    t.truthy(TOOL_INFO.sub_agent.icon());
    t.is(description, `${tr('tool.sub_action.message')}: researcher`);
    t.is(subAgentNameFromId(input.sub_id), 'researcher');
    t.is(subAgentNameFromId('thread-9'), '');
    t.false(description.includes('SECRET TASK'));
    t.false(description.includes('SECRET MESSAGE'));
});

test('tool status translation has Polish and English values', t => {
    t.is(tr('chat.tool_status.sub_agent', undefined, 'pl'), 'Wykonuję akcję sub-agenta...');
    t.is(tr('chat.tool_status.sub_agent', undefined, 'en'), 'Running sub-agent action...');
});

test('akcje sub_agent mają czytelne etykiety, także nieznana akcja', t => {
    const cases = [['task', 'Next task: researcher'], ['message', 'Message: researcher'], ['stop', 'Stop: researcher'], ['close', 'Close: researcher'], ['list', 'Sub-agent list: researcher'], ['unknown', 'Sub-agent action: researcher']] as const;
    for (const [action, expected] of cases) t.is(describeToolCall('sub_agent', { action, sub_id: 'sub/researcher#deadbeef-1' }), expected);
    t.is(describeToolCall('sub_agent', { action: '__proto__', sub_id: 'invalid' }), 'Sub-agent action');
    t.is(tr('tool.sub_action.unknown', undefined, 'pl'), 'Akcja suba');
});

test.serial('chip sub_agent pokazuje akcję i sub_id w toku oraz po wyniku', t => {
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: () => fakeElement() };
    try {
        const input = { action: 'message', sub_id: 'sub/researcher#deadbeef-9', task: 'SECRET TASK', text: 'SECRET MESSAGE' };
        const expectedTitle = `${tr('tool.sub_action.message')}: researcher`;
        for (const chip of [
            renderChip(input),
            renderChip(input, { success: true, message: 'Przyjęto' }, 'success'),
        ]) {
            const title = findByClass(chip, 'cs-tile__title');
            const head = findByClass(chip, 'cs-tile__head');
            t.is(title?.textContent, expectedTitle);
            t.true(deepText(head!).includes('researcher'));
            t.false(deepText(head!).includes('sub/researcher#deadbeef-9'));
            t.false(deepText(head!).includes('SECRET TASK'));
            t.false(deepText(head!).includes('SECRET MESSAGE'));
        }
        t.truthy(findByClass(renderChip(input), 'cs-tile--pending'));
        t.truthy(findByClass(renderChip(input, { success: true, message: 'Przyjęto' }, 'success'), 'cs-tile--ok'));

        const denied = renderChip({ action: 'task', sub_id: 'thread-9', task: 'SECRET TASK' }, { success: false, error: 'odmowa' }, 'error');
        t.truthy(findByClass(denied, 'cs-tile--error'));
        t.is(findByClass(denied, 'cs-tile__title')?.textContent, tr('tool.sub_action.task'));
        t.false(deepText(findByClass(denied, 'cs-tile__head')!).includes('SECRET TASK'));
        for (const [id, expected] of [
            ['sub/klara-research#2#deadbeef-1', 'Message: klara-research#2'],
            ['sub/Żółć badacz-północ#deadbeef-z', 'Message: Żółć badacz-północ'],
            ['', 'Message'],
            ['sub/researcher#1', 'Message'],
        ] as const) {
            t.is(findByClass(renderChip({ action: 'message', sub_id: id }), 'cs-tile__title')?.textContent, expected);
        }
    } finally {
        (globalThis as Record<string, unknown>).document = previous;
    }
});
