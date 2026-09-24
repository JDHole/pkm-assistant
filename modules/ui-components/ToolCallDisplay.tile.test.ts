/**
 * Testy na PRAWDZIWYM DOM-ie kafelka (`.cs-tile__title`/`.cs-tile__summary`), nie na
 * wewnętrznych obiektach `describeToolCall`/`formatToolOutput` - B1/B2 fix + uwaga niekrytyczna
 * z recenzji A1-fix ("Brak testu integracyjnego nagłówka prawdziwego kafelka narzędzia").
 * `ToolCallDisplay.ts` nie importuje `obsidian`, więc testy wołają `createCompactToolChip`/
 * `createToolCallDisplay` w gołym Node, podstawiając WŁASNĄ atrapę
 * `globalThis.document.createElement` (wzór `Tile.test.ts`/`ToolCallDisplay.truncate.test.ts`),
 * `test.serial` bo atrapa siedzi na `globalThis.document`, współdzielonym stanem między testami.
 */
import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { createCompactToolChip, createToolCallDisplay } from './ToolCallDisplay.js';

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
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    remove(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    addEventListener(type: string, cb: Listener): void;
    fire(type: string, ev?: unknown): void;
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
        get textContent() { return text + el.children.map(c => c.textContent).join(''); },
        set textContent(v: string) { text = v; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        appendText(t) { text += t; },
        empty() { text = ''; el.children.forEach(c => { c.parent = null; }); el.children = []; },
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

// ── B1: createCompactToolChip nie rzuca na zniekształconym wejściu (repro.log, faza 1) ──

test.serial('B1: createCompactToolChip dla read z tablicą jako path w stanie pending nie rzuca', t => {
    withFakeDocument(() => {
        t.notThrows(() => createCompactToolChip({ name: 'read', input: { path: ['a.md', 'b.md'] }, status: 'pending' }));
    });
});

// ── B2: nagłówek kafelka w stanie pending nigdy nie zawiera surowego JSON-a ──

test.serial('B2: pending chip dla generate_image - .cs-tile__summary bez surowego JSON-a', t => {
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'generate_image',
            input: { prompt: 'kot w kapeluszu', size: '1024x1024' },
            status: 'pending',
        }) as unknown as FakeEl;
        const summary = findByClass(el, 'cs-tile__summary');
        t.true(summary === null || !summary.textContent.includes('{'), 'summary nie moze zawierac { - nierozpoznane narzedzie dostaje pusty hint (formatToolInputHint)');
    });
});

test.serial('B2: pending card dla kom_list - .cs-tile__summary bez surowego JSON-a', t => {
    withFakeDocument(() => {
        const el = createToolCallDisplay({
            name: 'kom_list',
            input: { unread_only: true },
            status: 'pending',
        }) as unknown as FakeEl;
        const summary = findByClass(el, 'cs-tile__summary');
        t.true(summary === null || !summary.textContent.includes('{'), 'kom_list nie ma wpisu w formatToolInputHint - hint pusty, nie JSON');
    });
});

test.serial('B2: pending chip dla narzedzia z zewnetrznego serwera MCP - .cs-tile__summary bez surowego JSON-a', t => {
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'github__create_issue',
            input: { repo: 'a/b', title: 'x' },
            status: 'pending',
        }) as unknown as FakeEl;
        const summary = findByClass(el, 'cs-tile__summary');
        t.true(summary === null || !summary.textContent.includes('{'), 'narzedzie z zewnetrznego serwera MCP nie ma wpisu w formatToolInputHint');
    });
});

// ── Uwaga niekrytyczna: test prawdziwego nagłówka kafelka (nie tylko describeToolCall) ──

test.serial('naglowek prawdziwego kafelka: createCompactToolChip dla read z path Home.md - tytul PL literalnie, summary bez {', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'read',
            input: { path: 'Home.md' },
            status: 'pending',
        }) as unknown as FakeEl;
        const title = findByClass(el, 'cs-tile__title');
        const summary = findByClass(el, 'cs-tile__summary');
        t.is(title?.textContent, 'Przeczytał: Home.md', 'tytul po ludzku, przez i18n pl, literalnie');
        t.true(summary === null || !summary.textContent.includes('{'), 'summary bez surowego JSON-a');
    });
});
