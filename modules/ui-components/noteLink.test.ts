/**
 * `noteLink.ts` - notatki klikalne wszedzie (spec C, "Czat bez scian" 2.3.0). Zero `obsidian`
 * w pliku pod testem, wiec test wola go w golym Node podstawiajac WLASNA, minimalna atrape
 * `document` (wzor `Tile.test.ts`/`ToolCallDisplay.truncate.test.ts` w tym module) - `test.serial`,
 * bo atrapa siedzi na `globalThis.document`, wspoldzielonym stanem miedzy testami.
 */
import test from 'ava';
import { createNoteLink, setNoteOpener, isVaultNotePath } from './noteLink.js';
import type { NoteOpener } from './noteLink.js';

type Listener = (ev: unknown) => void;

interface FakeEl {
    tagName: string;
    className: string;
    textContent: string;
    href: string;
    listeners: Record<string, Listener[]>;
    children: FakeEl[];
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    addEventListener(type: string, cb: Listener): void;
    appendChild(child: FakeEl): FakeEl;
    fire(type: string, ev?: unknown): void;
}

function makeFakeEl(tag: string): FakeEl {
    const attrs = new Map<string, string>();
    const el: FakeEl = {
        tagName: tag,
        className: '',
        textContent: '',
        href: '',
        listeners: {},
        children: [],
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
        appendChild(child) { el.children.push(child); return child; },
        fire(type, ev = {}) { (el.listeners[type] || []).forEach(cb => cb(ev)); },
    };
    return el;
}

function withFakeDocument<T>(fn: () => T): T {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        return fn();
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
        setNoteOpener(null);
    }
}

// ── isVaultNotePath: tabela literalow (spec C) ────────────────────────────────

test('isVaultNotePath: tabela literalow ze spec', t => {
    t.true(isVaultNotePath('Home.md'));
    t.false(isVaultNotePath('https://x'));
    t.false(isVaultNotePath('folder/'));
});

test('isVaultNotePath: .canvas i .base tez licza sie jako notatka', t => {
    t.true(isVaultNotePath('Board.canvas'));
    t.true(isVaultNotePath('Table.base'));
});

test('isVaultNotePath: biale znaki na koncach odrzucone', t => {
    t.false(isVaultNotePath(' Home.md'));
    t.false(isVaultNotePath('Home.md '));
});

test('isVaultNotePath: schemat bez // (obsidian:, mailto:) odrzucony', t => {
    t.false(isVaultNotePath('obsidian://open?file=Home.md'));
    t.false(isVaultNotePath('mailto:x@y.pl'));
});

test('isVaultNotePath: nie-string i pusty string odrzucone', t => {
    t.false(isVaultNotePath(''));
    t.false(isVaultNotePath(null as unknown as string));
    t.false(isVaultNotePath(undefined as unknown as string));
});

test('isVaultNotePath: rozszerzenie spoza listy odrzucone', t => {
    t.false(isVaultNotePath('Zdjecie.png'));
    t.false(isVaultNotePath('Notatka.txt'));
    // Ukryte segmenty (recenzja C): pamiec agenta, konfiguracja Obsidiana - klik dawalby pusta karte.
    t.false(isVaultNotePath('.pkm-assistant/agents/claudzik/memory/brain.md'));
    t.false(isVaultNotePath('.obsidian/plugins/x/notatka.md'));
    t.false(isVaultNotePath('Folder/.ukryty/Notatka.md'));
    t.true(isVaultNotePath('Folder.v2/Notatka.md'));
});

// ── createNoteLink: z zarejestrowanym openerem ────────────────────────────────

test.serial('createNoteLink z openerem: klik woła opener z dokladna sciezka', t => {
    withFakeDocument(() => {
        const calls: Array<{ path: string; ev: unknown }> = [];
        const opener: NoteOpener = (path, ev) => { calls.push({ path, ev }); };
        setNoteOpener(opener);
        const parent = makeFakeEl('div');
        const el = createNoteLink(parent as unknown as HTMLElement, 'Notes/Foo.md') as unknown as FakeEl;

        t.is(el.tagName, 'a');
        t.is(el.className, 'cs-note-link');
        t.is(el.getAttribute('data-path'), 'Notes/Foo.md');
        t.is(el.textContent, 'Foo');
        t.is(el.href, '#');

        let prevented = false;
        const fakeEvent = { type: 'click', preventDefault() { prevented = true; } };
        el.fire('click', fakeEvent);
        t.true(prevented, 'href="#" nie ma skoczyc po stronie');
        t.is(calls.length, 1);
        t.is(calls[0].path, 'Notes/Foo.md');
        t.is(calls[0].ev, fakeEvent);
    });
});

test.serial('createNoteLink: label jawny wygrywa z nazwa pliku', t => {
    withFakeDocument(() => {
        setNoteOpener(() => { /* noop */ });
        const parent = makeFakeEl('div');
        const el = createNoteLink(parent as unknown as HTMLElement, 'Notes/Foo.md', 'Wlasna etykieta') as unknown as FakeEl;
        t.is(el.textContent, 'Wlasna etykieta');
    });
});

test.serial('createNoteLink: nazwa domyslna to basename bez rozszerzenia i bez folderow', t => {
    withFakeDocument(() => {
        setNoteOpener(() => { /* noop */ });
        const parent = makeFakeEl('div');
        const el = createNoteLink(parent as unknown as HTMLElement, 'a/b/Plan porzadkow.md') as unknown as FakeEl;
        t.is(el.textContent, 'Plan porzadkow');
    });
});

// ── createNoteLink: bez openera ───────────────────────────────────────────────

test.serial('createNoteLink bez openera: element bez href i bez obslugi kliku', t => {
    withFakeDocument(() => {
        setNoteOpener(null);
        const parent = makeFakeEl('div');
        const el = createNoteLink(parent as unknown as HTMLElement, 'Notes/Foo.md') as unknown as FakeEl;

        t.is(el.tagName, 'span');
        t.is(el.href, '');
        t.falsy(el.listeners.click);
        t.is(el.getAttribute('data-path'), 'Notes/Foo.md');
        t.is(el.textContent, 'Foo');
    });
});
