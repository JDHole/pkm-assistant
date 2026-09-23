/**
 * Tile — testy zachowania (nie implementacji). `Tile.ts` nie importuje `obsidian`, więc testy
 * wołają `createTile` w gołym Node podstawiając WŁASNĄ, minimalną atrapę `document` (wzór
 * `ToolCallDisplay.truncate.test.ts`/`SubAgentBlock.test.ts` w tym module) - `test.serial`, bo
 * atrapa siedzi na `globalThis.document`, współdzielonym stanem między testami.
 */
import test from 'ava';
import { createTile } from './Tile.js';
import type { TileSpec } from './Tile.js';

type Listener = (ev: unknown) => void;

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: {
        add(...c: string[]): void;
        remove(...c: string[]): void;
        toggle(c: string, force?: boolean): void;
        contains(c: string): boolean;
    };
    className: string;
    textContent: string;
    listeners: Record<string, Listener[]>;
    empty(): void;
    appendText(t: string): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    remove(): void;
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
            toggle: (c, force) => {
                const next = force === undefined ? !classes.has(c) : force;
                if (next) classes.add(c); else classes.delete(c);
            },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        empty() { text = ''; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        appendText(t) { text += t; },
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        removeAttribute(name) { attrs.delete(name); },
        hasAttribute(name) { return attrs.has(name); },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            child.parent = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        remove() {
            if (el.parent) {
                el.parent.children = el.parent.children.filter(c => c !== el);
                el.parent = null;
            }
        },
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

function baseSpec(overrides: Partial<TileSpec> = {}): TileSpec {
    return {
        role: 'agent',
        status: 'ok',
        iconSvg: 'icon',
        title: 'Tytul',
        ...overrides,
    };
}

test.serial('role wybiera klase cs-tile--{role}', t => {
    withFakeDocument(() => {
        for (const role of ['system', 'agent', 'agent-muted', 'user'] as const) {
            const handle = createTile(baseSpec({ role }));
            t.true((handle.el as unknown as FakeEl).classList.contains(`cs-tile--${role}`), role);
        }
    });
});

test.serial('status wybiera klase cs-tile--{status}', t => {
    withFakeDocument(() => {
        for (const status of ['ok', 'error', 'pending'] as const) {
            const handle = createTile(baseSpec({ status }));
            t.true((handle.el as unknown as FakeEl).classList.contains(`cs-tile--${status}`), status);
        }
    });
});

test.serial('error bez expanded: body widoczne (brak hidden), is-expanded', t => {
    withFakeDocument(() => {
        const handle = createTile(baseSpec({ status: 'error', details: 'komunikat bledu' }));
        const el = handle.el as unknown as FakeEl;
        t.true(el.classList.contains('is-expanded'));
        const body = findByClass(el, 'cs-tile__body')!;
        t.false(body.hasAttribute('hidden'));
        t.true(handle.isExpanded());
    });
});

test.serial('error z expanded:false: kafelek zostaje zwiniety', t => {
    withFakeDocument(() => {
        const handle = createTile(baseSpec({ status: 'error', details: 'komunikat bledu', expanded: false }));
        const el = handle.el as unknown as FakeEl;
        t.false(el.classList.contains('is-expanded'));
        const body = findByClass(el, 'cs-tile__body')!;
        t.true(body.hasAttribute('hidden'));
        t.false(handle.isExpanded());
    });
});

test.serial('klik w head: toggle rozwiniecia', t => {
    withFakeDocument(() => {
        const handle = createTile(baseSpec({ details: 'szczegoly' }));
        const el = handle.el as unknown as FakeEl;
        const head = findByClass(el, 'cs-tile__head')!;
        t.false(handle.isExpanded());
        head.fire('click');
        t.true(handle.isExpanded());
        t.true(el.classList.contains('is-expanded'));
        head.fire('click');
        t.false(handle.isExpanded());
    });
});

test.serial('details jako funkcja: wywolana DOKLADNIE raz mimo dwoch rozwiniec', t => {
    withFakeDocument(() => {
        let calls = 0;
        const handle = createTile(baseSpec({
            details: (body: HTMLElement) => { calls++; (body as unknown as FakeEl).textContent = 'raz'; },
        }));
        const el = handle.el as unknown as FakeEl;
        const head = findByClass(el, 'cs-tile__head')!;
        head.fire('click'); // expand
        head.fire('click'); // collapse
        head.fire('click'); // expand again
        t.is(calls, 1, 'funkcja details liczy sie tylko przy PIERWSZYM rozwinieciu');
        const details = findByClass(el, 'cs-tile__details')!;
        t.is(details.textContent, 'raz');
    });
});

test.serial("setStatus('error') na kafelku ok: klasa zmieniona i rozwiniety", t => {
    withFakeDocument(() => {
        const handle = createTile(baseSpec({ status: 'ok', details: 'x' }));
        const el = handle.el as unknown as FakeEl;
        t.false(el.classList.contains('is-expanded'));
        handle.setStatus('error');
        t.true(el.classList.contains('cs-tile--error'));
        t.false(el.classList.contains('cs-tile--ok'));
        t.true(el.classList.contains('is-expanded'));
        t.true(handle.isExpanded());
    });
});

test.serial('actions: przycisk z etykieta, klik wywoluje callback raz', t => {
    withFakeDocument(() => {
        let clicks = 0;
        const handle = createTile(baseSpec({
            actions: [{ label: 'Otworz', onClick: () => { clicks++; } }],
        }));
        const el = handle.el as unknown as FakeEl;
        const actionsEl = findByClass(el, 'cs-tile__actions')!;
        const btn = actionsEl.children[0];
        t.is(btn.textContent, 'Otworz');
        btn.fire('click', { type: 'click' });
        t.is(clicks, 1);
        btn.fire('click', { type: 'click' });
        t.is(clicks, 2);
    });
});

test.serial('kafelek bez details/actions: brak aria-expanded, klik nic nie robi', t => {
    withFakeDocument(() => {
        const handle = createTile(baseSpec());
        const el = handle.el as unknown as FakeEl;
        const head = findByClass(el, 'cs-tile__head')!;
        t.false(head.hasAttribute('aria-expanded'));
        t.false(el.classList.contains('is-toggleable'));
        head.fire('click');
        t.false(el.classList.contains('is-expanded'));
        t.false(handle.isExpanded());
    });
});

test.serial('summary dluzsze niz 80 znakow jest przyciete (truncatePreview: 80 zn. + wielokropek)', t => {
    withFakeDocument(() => {
        const long = 'a'.repeat(100);
        const handle = createTile(baseSpec({ summary: long }));
        const el = handle.el as unknown as FakeEl;
        const summaryEl = findByClass(el, 'cs-tile__summary')!;
        const expected = long.slice(0, 80) + '...';
        t.is(summaryEl.textContent, expected);
        t.is(summaryEl.textContent.length, 83);
    });
});
