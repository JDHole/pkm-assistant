/**
 * AUD-wydajnosc-029 (LOW): `formatToolOutput`'s `catch` branch was the ONLY branch without a
 * ceiling on `detail` — every other branch caps it (read/vault_read 2000, skill_execute 1000,
 * web_read 500, generic strings 1500). A non-JSON tool result — the normal shape for EVERY
 * external MCP server tool, since `normalizeMcpResult` (`modules/tools/ExternalMcpManager.ts`)
 * joins the response into plain text — lands in this `catch` (JSON.parse throws), and the WHOLE
 * string used to go into `detail`, which `createToolCallDisplay` puts into a DOM node eagerly,
 * even in the default compact-chip mode where that node is built and immediately hidden.
 *
 * `formatToolOutput` is not exported, so the test drives it the way a real render does — through
 * `createToolCallDisplay`, which uses Obsidian's `.createDiv`/`.createSpan` extensions. Node/AVA
 * has neither `document` nor those extensions, so this installs the same minimal fake DOM as
 * `SubAgentBlock.test.ts` and calls the REAL function, not a source regex.
 */
import test from 'ava';
import { createToolCallDisplay } from './ToolCallDisplay.js';

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    appendText(t: string): void;
    empty(): void;
    createDiv(opts?: { cls?: string }): FakeEl;
    createSpan(opts?: { cls?: string; text?: string }): FakeEl;
    createEl(tag: string, opts?: { cls?: string; text?: string }): FakeEl;
    appendChild(child: FakeEl): FakeEl;
    addEventListener(): void;
    addClass(c: string): void;
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        children: [],
        classList: {
            add: (c) => { classes.add(c); },
            remove: (c) => { classes.delete(c); },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children = []; },
        appendText(t) { text += t; },
        empty() { text = ''; el.children = []; },
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = opts.cls; el.children.push(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.children.push(c); return c; },
        createEl(tag2, opts) { const c = makeFakeEl(tag2); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.children.push(c); return c; },
        appendChild(child) { el.children.push(child); return child; },
        addEventListener() { /* noop */ },
        addClass(c) { classes.add(c); },
    } as FakeEl;
    return el;
}

function findByClass(root: FakeEl, cls: string): FakeEl | null {
    if (root.classList.contains(cls)) return root;
    for (const child of root.children) {
        const found = findByClass(child, cls);
        if (found) return found;
    }
    return null;
}

function withFakeDocument<T>(fn: () => T): T {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        return fn();
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
    }
}

test.serial('formatToolOutput catch branch: non-JSON output longer than 2000 chars is capped, same ceiling as read/vault_read', t => {
    withFakeDocument(() => {
        // Not valid JSON -> formatToolOutput's JSON.parse throws -> catch branch.
        const longOutput = 'x'.repeat(5000);
        const row = createToolCallDisplay({
            name: 'external_server__some_tool', // unknown to TOOL_INFO — external MCP shape
            status: 'success',
            output: longOutput,
        }) as unknown as FakeEl;

        const detail = findByClass(row, 'cs-action-row__detail');
        t.truthy(detail, 'output dłuższy niż podsumowanie (120 zn.) musi dać węzeł detail');
        t.is(detail!.textContent.length, 2000, 'detail musi być obcięty do 2000 zn., tak jak gałąź read/vault_read');
        t.true(detail!.textContent.endsWith('...'), '_truncate dokleja wielokropek przy obcięciu');
    });
});

test.serial('formatToolOutput catch branch: non-JSON output under 2000 chars is NOT truncated (unchanged behavior)', t => {
    withFakeDocument(() => {
        const mediumOutput = 'y'.repeat(200); // > 120 (summary cap) but < 2000 (new detail cap)
        const row = createToolCallDisplay({
            name: 'external_server__some_tool',
            status: 'success',
            output: mediumOutput,
        }) as unknown as FakeEl;

        const detail = findByClass(row, 'cs-action-row__detail');
        t.truthy(detail);
        t.is(detail!.textContent, mediumOutput, 'poniżej sufitu detail wraca bez zmian — brak regresji dla normalnych wyników');
    });
});

test.serial('formatToolOutput catch branch: short output (<=120 chars) has no detail node at all', t => {
    withFakeDocument(() => {
        const shortOutput = 'krótki wynik narzędzia';
        const row = createToolCallDisplay({
            name: 'external_server__some_tool',
            status: 'success',
            output: shortOutput,
        }) as unknown as FakeEl;

        const detail = findByClass(row, 'cs-action-row__detail');
        t.falsy(detail, 'output mieszczący się w podsumowaniu nie dostaje osobnego węzła detail');
    });
});
