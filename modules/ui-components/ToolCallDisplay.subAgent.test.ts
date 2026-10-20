import test from 'ava';
import { TOOL_INFO, createCompactToolChip, describeToolCall } from './ToolCallDisplay.js';
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

test('TOOL_INFO sub_agent shows action and ID without task or message content', t => {
    const input = { action: 'message', sub_id: 'thread-9', task: 'SECRET TASK', text: 'SECRET MESSAGE' };
    const description = describeToolCall('sub_agent', input);
    t.is(TOOL_INFO.sub_agent.label, tr('tool.sub_agent'));
    t.truthy(TOOL_INFO.sub_agent.icon());
    t.is(description, tr('tool.in.sub_agent', { action: 'message', sub_id: 'thread-9' }));
    t.true(description.includes('message'));
    t.true(description.includes('thread-9'));
    t.false(description.includes('SECRET TASK'));
    t.false(description.includes('SECRET MESSAGE'));
});

test('tool status translation has Polish and English values', t => {
    t.is(tr('chat.tool_status.sub_agent', undefined, 'pl'), 'Wykonuję akcję sub-agenta...');
    t.is(tr('chat.tool_status.sub_agent', undefined, 'en'), 'Running sub-agent action...');
});

test.serial('chip sub_agent pokazuje akcję i sub_id w toku oraz po wyniku', t => {
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: () => fakeElement() };
    try {
        const input = { action: 'message', sub_id: 'thread-9', task: 'SECRET TASK', text: 'SECRET MESSAGE' };
        const expectedTitle = tr('tool.in.sub_agent', { action: 'message', sub_id: 'thread-9' });
        for (const chip of [
            renderChip(input),
            renderChip(input, { success: true, message: 'Przyjęto' }, 'success'),
        ]) {
            const title = findByClass(chip, 'cs-tile__title');
            const head = findByClass(chip, 'cs-tile__head');
            t.is(title?.textContent, expectedTitle);
            t.true(deepText(head!).includes('message'));
            t.true(deepText(head!).includes('thread-9'));
            t.false(deepText(head!).includes('SECRET TASK'));
            t.false(deepText(head!).includes('SECRET MESSAGE'));
        }
        t.truthy(findByClass(renderChip(input), 'cs-tile--pending'));
        t.truthy(findByClass(renderChip(input, { success: true, message: 'Przyjęto' }, 'success'), 'cs-tile--ok'));

        const denied = renderChip({ action: 'task', sub_id: 'thread-9', task: 'SECRET TASK' }, { success: false, error: 'odmowa' }, 'error');
        t.truthy(findByClass(denied, 'cs-tile--error'));
        t.is(findByClass(denied, 'cs-tile__title')?.textContent, tr('tool.in.sub_agent', { action: 'task', sub_id: 'thread-9' }));
        t.false(deepText(findByClass(denied, 'cs-tile__head')!).includes('SECRET TASK'));
    } finally {
        (globalThis as Record<string, unknown>).document = previous;
    }
});
