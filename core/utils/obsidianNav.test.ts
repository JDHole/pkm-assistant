import test from 'ava';
import { Keymap } from 'obsidian';
import { openNoteInMainTab } from './obsidianNav.js';
import type { AppLike } from '../runtime/contracts.js';

/**
 * `openNoteInMainTab` (spec C, "Czat bez scian" 2.3.0) - wariant `openNote` ktory NIGDY nie
 * zostaje w biezacej karcie. Osobny plik od `core/obsidianNav.test.ts` (istniejacy, poza scope
 * tego zadania - pokrywa `openNote`/`openSource` bez zmian zachowania), wiec atrapy sa TU
 * zduplikowane celowo zamiast reuzywac plik, ktorego nie wolno dotykac.
 */

function fakeAdapter() {
    return {
        async read() { return ''; },
        async write() {},
        async exists() { return false; },
        async mkdir() {},
        async list() { return { files: [], folders: [] }; },
    };
}

type NavCall = { path: string; sourcePath: string; target: unknown; viewState: unknown };

function fakeApp(withOpenLinkText = true): { app: AppLike; calls: NavCall[] } {
    const calls: NavCall[] = [];
    const workspace: Record<string, unknown> = {};
    if (withOpenLinkText) {
        workspace.openLinkText = async (path: string, sourcePath: string, target: unknown, viewState: unknown) => {
            calls.push({ path, sourcePath, target, viewState });
        };
    }
    const app = { vault: { adapter: fakeAdapter() }, workspace } as unknown as AppLike;
    return { app, calls };
}

test.serial('openNoteInMainTab: bez zdarzenia (np. klik programowy) -> nowa karta, nie biezaca', async t => {
    const { app, calls } = fakeApp();
    await openNoteInMainTab(app, 'Notes/Foo.md');
    t.is(calls.length, 1);
    t.is(calls[0].target, 'tab');
});

test.serial('openNoteInMainTab: zwykly klik (button 0, Keymap bez modyfikatora) -> nowa karta, nie biezaca', async t => {
    const { app, calls } = fakeApp();
    await openNoteInMainTab(app, 'Notes/Foo.md', { button: 0 });
    t.is(calls[0].target, 'tab');
});

test.serial('openNoteInMainTab: Ctrl/Cmd (Keymap.isModEvent===true) -> nowa karta, jak w Obsidianie', async t => {
    const original = Keymap.isModEvent;
    Keymap.isModEvent = () => true;
    try {
        const { app, calls } = fakeApp();
        await openNoteInMainTab(app, 'Notes/Foo.md', { button: 0 });
        t.is(calls[0].target, 'tab');
    } finally {
        Keymap.isModEvent = original;
    }
});

test.serial('openNoteInMainTab: srodkowy klik (button 1) -> nowa karta', async t => {
    const { app, calls } = fakeApp();
    await openNoteInMainTab(app, 'Notes/Foo.md', { button: 1 });
    t.is(calls[0].target, 'tab');
});

test.serial('openNoteInMainTab: Keymap zwraca split/window -> przechodzi bez zmian (nie nadpisane na tab)', async t => {
    const original = Keymap.isModEvent;
    try {
        for (const value of ['split', 'window'] as const) {
            Keymap.isModEvent = () => value;
            const { app, calls } = fakeApp();
            await openNoteInMainTab(app, 'Notes/Foo.md', { button: 0 });
            t.is(calls[0].target, value);
        }
    } finally {
        Keymap.isModEvent = original;
    }
});

test.serial('openNoteInMainTab: brak App-a -> brak nawigacji, bez wyjatku', async t => {
    await t.notThrowsAsync(openNoteInMainTab(null as unknown as AppLike, 'X.md'));
});

test.serial('openNoteInMainTab: pusta sciezka -> brak nawigacji', async t => {
    const { app, calls } = fakeApp();
    await openNoteInMainTab(app, '   ');
    t.is(calls.length, 0);
});
