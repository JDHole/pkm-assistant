/**
 * Notatki klikalne w kafelku narzedzia (spec C, "Czat bez scian" 2.3.0): odczyt jednego pliku i
 * wyniki wyszukiwania dostaja `.cs-note-link` w details, przez `createNoteLink`. `ToolCallDisplay.ts`
 * nie importuje `obsidian`, wiec test wola `createCompactToolChip` w golym Node, podstawiajac
 * WLASNA atrape `globalThis.document.createElement` (wzor `ToolCallDisplay.tile.test.ts`/
 * `Tile.test.ts`) - `test.serial`, bo atrapa siedzi na `globalThis.document`, wspoldzielonym
 * stanem miedzy testami. Details renderuja sie LENIWIE przy pierwszym rozwinieciu (patrz
 * `Tile.ts`) - test klika naglowek (`.cs-tile__head`), zamiast liczyc na auto-expand statusu
 * `error`, ktorego tu celowo nie ma (linki notatek pojawiaja sie tylko na SUKCESIE).
 */
import test from 'ava';
import { createCompactToolChip } from './ToolCallDisplay.js';

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

function findAllByClass(root: FakeEl, cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (root.classList.contains(cls)) out.push(root);
    for (const child of root.children) out.push(...findAllByClass(child, cls));
    return out;
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

/** Klik naglowka kafelka rozwija `body` i wywoluje leniwe budowanie `details` (`Tile.ts`). */
function expandTile(el: FakeEl): void {
    const head = findByClass(el, 'cs-tile__head');
    head?.fire('click');
}

test.serial('read: details zawiera 1 .cs-note-link z data-path rownym sciezce odczytu', t => {
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'read',
            input: { path: 'Notes/Foo.md' },
            output: JSON.stringify({ success: true, path: 'Notes/Foo.md', content: 'tresc notatki' }),
            status: 'success',
        }) as unknown as FakeEl;
        expandTile(el);
        const links = findAllByClass(el, 'cs-note-link');
        t.is(links.length, 1);
        t.is(links[0].getAttribute('data-path'), 'Notes/Foo.md');
    });
});

test.serial('search: 3 trafienia daja 3 .cs-note-link z poprawnymi sciezkami', t => {
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'search',
            input: { query: 'projekt' },
            output: JSON.stringify({
                results: [
                    { path: 'A/one.md', score: 0.9 },
                    { path: 'B/two.md', score: 0.5 },
                    { path: 'C/three.md', score: 0.3 },
                ],
                count: 3,
            }),
            status: 'success',
        }) as unknown as FakeEl;
        expandTile(el);
        const links = findAllByClass(el, 'cs-note-link');
        t.is(links.length, 3);
        t.deepEqual(links.map(l => l.getAttribute('data-path')), ['A/one.md', 'B/two.md', 'C/three.md']);
    });
});

test.serial('search: wynik bez sciezki notatki (folder-like albo spoza isVaultNotePath) nie dostaje linku', t => {
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'search',
            input: { query: 'x' },
            output: JSON.stringify({ results: [{ path: 'https://example.com' }, { path: 'Real/Note.md' }] }),
            status: 'success',
        }) as unknown as FakeEl;
        expandTile(el);
        const links = findAllByClass(el, 'cs-note-link');
        t.is(links.length, 1);
        t.is(links[0].getAttribute('data-path'), 'Real/Note.md');
    });
});

test.serial('read: blad narzedzia nie dostaje sekcji linkow', t => {
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'read',
            input: { path: 'Notes/Missing.md' },
            status: 'error',
            error: 'Plik nie istnieje',
        }) as unknown as FakeEl;
        // status:'error' auto-rozwija sie (Tile.ts) - bez klikania.
        const links = findAllByClass(el, 'cs-note-link');
        t.is(links.length, 0);
    });
});

test.serial('list: pozycja bedaca notatka dostaje link, folder zostaje tekstem', t => {
    withFakeDocument(() => {
        const el = createCompactToolChip({
            name: 'list',
            input: { path: 'Projekty' },
            output: JSON.stringify({ files: ['Projekty/Plan.md', 'Projekty/Archiwum'] }),
            status: 'success',
        }) as unknown as FakeEl;
        expandTile(el);
        const links = findAllByClass(el, 'cs-note-link');
        t.is(links.length, 1);
        t.is(links[0].getAttribute('data-path'), 'Projekty/Plan.md');
    });
});
