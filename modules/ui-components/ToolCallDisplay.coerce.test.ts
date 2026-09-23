/**
 * B1 (recenzja A3-fix, evidence-review_a3.md): `_coerceToText`'s contract ("Nigdy
 * `[object Object]`, nigdy wyjątek", `modules/ui-components/CLAUDE.md`) was failing exactly the
 * inputs the recenzja's `probes/probe-tcd.mts` sent through the PUBLIC `createCompactToolChip`:
 * an array of objects (`idea_review`/`plan_review` comments - realistic, a model or external MCP
 * server can legally send this shape), a cyclic object (`kom_send`'s `message`), and a BigInt
 * nested inside an object. Two threw `TypeError`, one rendered the literal string
 * `[object Object]`. This file drives the SAME scenarios through the SAME public entry point
 * (never the private `_coerceToText`/`_safeStringify` directly) and asserts the exact resulting
 * text, not just "did not throw".
 *
 * Fake DOM: same minimal shim as `ToolCallDisplay.truncate.test.ts`/`Tile.test.ts` - Node/AVA has
 * neither `document` nor Obsidian's DOM extensions. Tile's `details` render LAZILY on first
 * expansion, so each test clicks `.cs-tile__head` before reading `.cs-tile__details`.
 */
import test from 'ava';
import { createCompactToolChip } from './ToolCallDisplay.js';
import { setLocale, t } from '../../core/i18n/index.js';

setLocale('pl');

type Listener = (ev: unknown) => void;

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    listeners: Record<string, Listener[]>;
    appendText(t: string): void;
    empty(): void;
    createDiv(opts?: { cls?: string }): FakeEl;
    createSpan(opts?: { cls?: string; text?: string }): FakeEl;
    createEl(tag: string, opts?: { cls?: string; text?: string }): FakeEl;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    remove(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    addEventListener(type: string, cb: Listener): void;
    fire(type: string, ev?: unknown): void;
    addClass(c: string): void;
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        children: [],
        parent: null,
        classList: {
            add: (...c) => { c.forEach(x => classes.add(x)); },
            remove: (...c) => { c.forEach(x => classes.delete(x)); },
            toggle: (c, force) => { const next = force === undefined ? !classes.has(c) : force; if (next) classes.add(c); else classes.delete(c); },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        appendText(t2) { text += t2; },
        empty() { text = ''; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = opts.cls; el.appendChild(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.appendChild(c); return c; },
        createEl(tag2, opts) { const c = makeFakeEl(tag2); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.appendChild(c); return c; },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            child.parent = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        remove() { if (el.parent) { el.parent.children = el.parent.children.filter(c => c !== el); el.parent = null; } },
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        removeAttribute(name) { attrs.delete(name); },
        hasAttribute(name) { return attrs.has(name); },
        listeners: {},
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
        fire(type, ev = {}) { (el.listeners[type] || []).forEach(cb => cb(ev)); },
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

/** Rozwija kafelek (klik w `.cs-tile__head`) i oddaje `.cs-tile__details`. */
function expandAndGetDetails(row: FakeEl): FakeEl | null {
    const head = findByClass(row, 'cs-tile__head');
    head?.fire('click');
    return findByClass(row, 'cs-tile__details');
}

test.serial('createCompactToolChip: tablica obiektow (idea_review.comments) - bez [object Object], tresc czytelna', t2 => {
    withFakeDocument(() => {
        const row = createCompactToolChip({
            name: 'idea_review',
            input: {},
            output: { comments: [{ text: 'popraw A' }, { text: 'popraw B' }] },
            status: 'success',
        }) as unknown as FakeEl;
        const details = expandAndGetDetails(row);
        t2.truthy(details, 'brak .cs-tile__details - render rzucil albo pominal ciało');
        const expected = `${t('tool.out.review')}\n\n{"text":"popraw A"}\n{"text":"popraw B"}`;
        t2.is(details!.textContent, expected);
        t2.false(details!.textContent.includes('[object Object]'));
    });
});

test.serial('createCompactToolChip: tablica obiektow (plan_review.comments) - bez [object Object]', t2 => {
    withFakeDocument(() => {
        const row = createCompactToolChip({
            name: 'plan_review',
            input: {},
            output: { type: 'plan_review_result', comments: [{ line: 1, text: 'x' }] },
            status: 'success',
        }) as unknown as FakeEl;
        const details = expandAndGetDetails(row);
        t2.truthy(details);
        const expected = `${t('tool.out.plan_comments')}\n\n{"line":1,"text":"x"}`;
        t2.is(details!.textContent, expected);
        t2.false(details!.textContent.includes('[object Object]'));
    });
});

test.serial('createCompactToolChip: obiekt cykliczny (kom_send.message) - nie rzuca, cykl zaznaczony "[cykl]"', t2 => {
    withFakeDocument(() => {
        const cyc: Record<string, unknown> = { a: 1 };
        cyc.self = cyc;
        t2.notThrows(() => {
            const row = createCompactToolChip({
                name: 'kom_send',
                input: {},
                output: { success: true, message: cyc },
                status: 'success',
            }) as unknown as FakeEl;
            const details = expandAndGetDetails(row);
            const expected = `${t('tool.out.msg_sent')}\n\n{"a":1,"self":"[cykl]"}`;
            t2.is(details!.textContent, expected);
        });
    });
});

test.serial('createCompactToolChip: tablica z obiektem cyklicznym (idea_review.comments) - nie rzuca', t2 => {
    withFakeDocument(() => {
        const cyc: Record<string, unknown> = { a: 1 };
        cyc.self = cyc;
        t2.notThrows(() => {
            const row = createCompactToolChip({
                name: 'idea_review',
                input: {},
                output: { comments: [cyc] },
                status: 'success',
            }) as unknown as FakeEl;
            const details = expandAndGetDetails(row);
            const expected = `${t('tool.out.review')}\n\n{"a":1,"self":"[cykl]"}`;
            t2.is(details!.textContent, expected);
        });
    });
});

test.serial('createCompactToolChip: BigInt w obiekcie (kom_send.message) - nie rzuca, serializowany jako string', t2 => {
    withFakeDocument(() => {
        t2.notThrows(() => {
            const row = createCompactToolChip({
                name: 'kom_send',
                input: {},
                output: { success: true, message: { n: 10n } },
                status: 'success',
            }) as unknown as FakeEl;
            const details = expandAndGetDetails(row);
            const expected = `${t('tool.out.msg_sent')}\n\n{"n":"10"}`;
            t2.is(details!.textContent, expected);
        });
    });
});

test.serial('createCompactToolChip: BigInt w tablicy (idea_review.comments) - nie rzuca', t2 => {
    withFakeDocument(() => {
        t2.notThrows(() => {
            const row = createCompactToolChip({
                name: 'idea_review',
                input: {},
                output: { comments: [1n, 2n] },
                status: 'success',
            }) as unknown as FakeEl;
            const details = expandAndGetDetails(row);
            const expected = `${t('tool.out.review')}\n\n1\n2`;
            t2.is(details!.textContent, expected);
        });
    });
});
