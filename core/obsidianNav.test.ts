import test from 'ava';
import { Keymap } from 'obsidian';
import { openNote, openSource } from './utils/obsidianNav.js';
import type { AppLike } from './runtime/contracts.js';

/**
 * Adapter minimalny spełniający `VaultAdapterLike` — `openNote`/`openSource` nigdy go
 * nie dotykają (nawigacja idzie przez `workspace`, nie przez `vault`), więc metody są
 * tu wyłącznie po to, żeby TypeScript zaakceptował kształt `AppLike`.
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

/** Atrapa App-a Obsidiana, która rejestruje każde wywołanie `workspace.openLinkText`. */
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

// ── openNote / openSource: ścieżka szczęśliwa ────────────────────────────────

test.serial('openNote: bez zdarzenia otwiera w bieżącej karcie, ścieżka źródłowa pusta (link absolutny od korzenia)', async t => {
    const { app, calls } = fakeApp();
    await openNote(app, 'Notes/Foo.md');
    t.deepEqual(calls, [{ path: 'Notes/Foo.md', sourcePath: '', target: false, viewState: undefined }]);
});

test.serial('openSource: zawsze bieżąca karta, w trybie źródła — niezależnie od zdarzenia (nie przyjmuje event)', async t => {
    const { app, calls } = fakeApp();
    await openSource(app, 'Notes/Foo.md');
    t.deepEqual(calls, [{ path: 'Notes/Foo.md', sourcePath: '', target: false, viewState: { state: { mode: 'source' } } }]);
});

// ── resolveApp: rozpakowanie `{ app }` i błędne kształty źródła ──────────────

test.serial('openNote: rozpakowuje App zagnieżdżone w polu `app` (np. przekazanie instancji pluginu zamiast App)', async t => {
    const { app: innerApp, calls } = fakeApp();
    const pluginLike = { app: innerApp } as unknown as AppLike;
    await openNote(pluginLike, 'X.md');
    t.is(calls.length, 1);
    t.is(calls[0].path, 'X.md');
});

test.serial('openNote: pole `app` obecne ale puste (null) → brak nawigacji, bez wyjątku', async t => {
    const pluginLike = { app: null } as unknown as AppLike;
    await t.notThrowsAsync(openNote(pluginLike, 'X.md'));
});

test.serial('openNote: brak App-a (null/undefined) → brak nawigacji, bez wyjątku', async t => {
    await t.notThrowsAsync(openNote(null as unknown as AppLike, 'X.md'));
    await t.notThrowsAsync(openNote(undefined as unknown as AppLike, 'X.md'));
});

// ── openLink: strażniki wejścia ──────────────────────────────────────────────

test.serial('openNote: workspace bez `openLinkText` → brak nawigacji, bez wyjątku (nawigacja "nieczynna")', async t => {
    const { app, calls } = fakeApp(false);
    await t.notThrowsAsync(openNote(app, 'X.md'));
    t.is(calls.length, 0);
});

test.serial('openNote: ścieżka nie-string (np. z uszkodzonego wywołania) → brak nawigacji, bez wyjątku', async t => {
    const { app, calls } = fakeApp();
    await t.notThrowsAsync(openNote(app, null as unknown as string));
    t.is(calls.length, 0);
});

test.serial('openNote: pusta ścieżka (same białe znaki) → brak nawigacji', async t => {
    const { app, calls } = fakeApp();
    await openNote(app, '   ');
    t.is(calls.length, 0);
});

// ── resolveTarget: modyfikatory ──────────────────────────────────────────────

test.serial('openNote: środkowy przycisk myszy (button 1) → nowa karta, niezależnie od Keymap', async t => {
    const { app, calls } = fakeApp();
    await openNote(app, 'X.md', { button: 1 });
    t.is(calls[0].target, 'tab');
});

test.serial('openNote: zdarzenie null → bieżąca karta, bez wyjątku (nie czyta `.button` z null)', async t => {
    const { app, calls } = fakeApp();
    await t.notThrowsAsync(openNote(app, 'X.md', null));
    t.is(calls[0].target, false);
});

test.serial('openNote: zwykły klik (obiekt zdarzenia, button 0, Keymap bez modyfikatora) → bieżąca karta', async t => {
    const { app, calls } = fakeApp();
    await openNote(app, 'X.md', { button: 0 });
    t.is(calls[0].target, false);
});

test.serial('openNote: Keymap.isModEvent === true (Ctrl/Cmd) → nowa karta', async t => {
    const original = Keymap.isModEvent;
    Keymap.isModEvent = () => true;
    try {
        const { app, calls } = fakeApp();
        await openNote(app, 'X.md', { button: 0 });
        t.is(calls[0].target, 'tab');
    } finally {
        Keymap.isModEvent = original;
    }
});

test.serial('openNote: Keymap.isModEvent zwraca konkretny target (tab/split/window) → przechodzi bez zmian', async t => {
    const original = Keymap.isModEvent;
    try {
        for (const value of ['tab', 'split', 'window'] as const) {
            Keymap.isModEvent = () => value;
            const { app, calls } = fakeApp();
            await openNote(app, 'X.md', { button: 0 });
            t.is(calls[0].target, value);
        }
    } finally {
        Keymap.isModEvent = original;
    }
});
