/**
 * MentionAutocomplete — AUD-wydajnosc-027/047/077 (HIGH, duplikaty) + AUD-wydajnosc-078 (LOW).
 *
 * Wtopa: `_updateSuggestions()` wołało `plugin.app.vault.getMarkdownFiles()` (i czasem
 * `getAllLoadedFiles()` DRUGI raz) na KAŻDY znak wpisany w tokenie `@...` — pełny skan +
 * dwa `.filter()` + `.sort()` z `toLowerCase()` przeliczanym na nowo za każdym razem,
 * czyli praca O(rozmiar vaulta) w ścieżce keystroke (zakazana przez W2). Naprawa: lista
 * notatek/folderów budowana RAZ (`_ensureCaches`, leniwie, basename/path zlowercase'owane
 * z góry), unieważniana WYŁĄCZNIE zdarzeniami vaulta (`create`/`delete`/`rename`), a reakcja
 * na klawisz debounce'owana (~50ms) — burst wielu keystroke'ów w jednym mentionie liczy się
 * raz. Przy okazji: `_open()` woła `_renderItems()` DRUGI raz zbędnie (usunięte — renderuje
 * tylko gdy dropdown jest właśnie tworzony), a `mouseover` (AUD-078) przebudowywał cały
 * dropdown nawet gdy najechany wiersz był już zaznaczony (bąbelkowanie z ikony/nazwy/ścieżki
 * wewnątrz wiersza odpalało to po kilka razy na jedno przejechanie myszą).
 *
 * Test stawia MINIMALNĄ atrapę DOM-u + atrapę `plugin.app.vault` z licznikami wywołań
 * (wzór `SubAgentBlock.test.ts` → `installFakeDom`) i woła PRAWDZIWĄ klasę, nie regex po
 * źródle — bo mechanizm (cache + debounce + event invalidation) nie da się zweryfikować
 * statycznie.
 */
import test from 'ava';
import { MentionAutocomplete } from './MentionAutocomplete.js';

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    emptyCalls: number;
    appendText(t: string): void;
    empty(): void;
    createDiv(opts?: { cls?: string }): FakeEl;
    createSpan(opts?: { cls?: string; text?: string }): FakeEl;
    appendChild(child: FakeEl): FakeEl;
    addEventListener(ev: string, cb: (...args: unknown[]) => void): void;
    addClass(c: string): void;
    removeClass(c: string): void;
    remove(): void;
    querySelector(sel: string): FakeEl | null;
    scrollIntoView(opts?: unknown): void;
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    let text = '';
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
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
        emptyCalls: 0,
        appendText(t) { text += t; },
        empty() { el.emptyCalls++; text = ''; el.children = []; },
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = opts.cls; el.children.push(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.children.push(c); return c; },
        appendChild(child) { el.children.push(child); return child; },
        addEventListener(ev, cb) { (listeners[ev] ||= []).push(cb); },
        addClass(c) { classes.add(c); },
        removeClass(c) { classes.delete(c); },
        remove() { /* detach — no-op for the test tree */ },
        scrollIntoView() { /* jsdom-less test tree has no layout to scroll */ },
        querySelector(sel: string) {
            const wanted = sel.replace(/^\./, '').split('.');
            const matches = (node: FakeEl) => wanted.every(c => node.classList.contains(c));
            const stack = [...el.children];
            while (stack.length) {
                const node = stack.shift()!;
                if (matches(node)) return node;
                stack.push(...node.children);
            }
            return null;
        },
    } as FakeEl;
    // expose listeners for mousedown/mouseover simulation in tests
    (el as unknown as { _listeners: typeof listeners })._listeners = listeners;
    return el;
}

function fireEvent(el: FakeEl, ev: string) {
    const listeners = (el as unknown as { _listeners: Record<string, Array<() => void>> })._listeners;
    (listeners[ev] || []).slice().forEach(cb => cb());
}

type FakeTextarea = {
    value: string;
    selectionStart: number;
    parentElement: FakeEl;
    isConnected: boolean;
    addEventListener(ev: string, cb: (payload?: unknown) => void): void;
    removeEventListener(ev: string, cb: (payload?: unknown) => void): void;
    setSelectionRange(s: number, e: number): void;
    focus(): void;
    dispatchEvent(ev: { type: string }): void;
    _trigger(ev: string, payload?: unknown): void;
};

function makeFakeTextarea(): FakeTextarea {
    const listeners: Record<string, Array<(payload?: unknown) => void>> = {};
    const ta: FakeTextarea = {
        value: '',
        selectionStart: 0,
        parentElement: makeFakeEl('div'),
        isConnected: true,
        addEventListener(ev, cb) { (listeners[ev] ||= []).push(cb); },
        removeEventListener(ev, cb) {
            const arr = listeners[ev]; if (!arr) return;
            const idx = arr.indexOf(cb); if (idx >= 0) arr.splice(idx, 1);
        },
        setSelectionRange(s) { ta.selectionStart = s; },
        focus() { /* no-op */ },
        dispatchEvent(ev) { ta._trigger(ev.type); },
        _trigger(ev, payload) { (listeners[ev] || []).slice().forEach(cb => cb(payload)); },
    };
    return ta;
}

/** Minimal fake KeyboardEvent — tracks whether the handler intercepted it. */
function makeKeydownEvent(key: string) {
    return {
        key,
        _defaultPrevented: false,
        _propagationStopped: false,
        _immediatePropagationStopped: false,
        preventDefault() { this._defaultPrevented = true; },
        stopPropagation() { this._propagationStopped = true; },
        stopImmediatePropagation() { this._immediatePropagationStopped = true; this._propagationStopped = true; },
    };
}

function makeFile(path: string, mtime = 0) {
    const basename = path.split('/').pop()!.replace(/\.md$/, '');
    return { path, basename, stat: { mtime } };
}

function makeFolder(path: string) {
    const name = path.split('/').pop()!;
    return { path, name, children: [] };
}

function makeFakeVault(files: ReturnType<typeof makeFile>[], folders: ReturnType<typeof makeFolder>[]) {
    const listeners: Record<string, Array<() => void>> = { create: [], delete: [], rename: [] };
    let getMarkdownFilesCalls = 0;
    let getAllLoadedFilesCalls = 0;
    return {
        getMarkdownFiles() { getMarkdownFilesCalls++; return files; },
        getAllLoadedFiles() { getAllLoadedFilesCalls++; return [...files, ...folders]; },
        on(evt: string, cb: () => void) { (listeners[evt] ||= []).push(cb); return { evt, cb }; },
        offref(ref: { evt: string; cb: () => void }) {
            const arr = listeners[ref.evt];
            if (!arr) return;
            const idx = arr.indexOf(ref.cb);
            if (idx >= 0) arr.splice(idx, 1);
        },
        _trigger(evt: string) { (listeners[evt] || []).slice().forEach(cb => cb()); },
        get calls() { return { getMarkdownFilesCalls, getAllLoadedFilesCalls }; },
        get listenerCounts() { return { create: listeners.create.length, delete: listeners.delete.length, rename: listeners.rename.length }; },
    };
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

test.serial('_updateSuggestions: 8 keystrokes inside one @mention scan the vault ONCE, not 8 times (AUD-wydajnosc-027/047/077)', async t => {
    await withFakeDocument(async () => {
        const files = Array.from({ length: 20 }, (_, i) => makeFile(`Notes/projekt-${i}.md`, i));
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        // Simulate typing "@projekt" one character at a time — 8 input events.
        const chars = '@projekt'.split('');
        let typed = '';
        for (const c of chars) {
            typed += c;
            textarea.value = typed;
            textarea.selectionStart = typed.length;
            textarea._trigger('input');
        }

        // Debounce window (50ms) hasn't fired yet — no scan should have happened synchronously.
        t.is(vault.calls.getMarkdownFilesCalls, 0, 'skan nie może być synchroniczny — to była pierwotna wada');

        await sleep(120); // let the debounced _updateSuggestions() fire once

        t.is(vault.calls.getMarkdownFilesCalls, 1, '8 keystrokeów w jednym mentionie = JEDEN skan vaulta (przed naprawą: 8+)');
        t.true(mention.items.length > 0, 'lista podpowiedzi faktycznie się wypełniła po debounce');

        mention.destroy();
    });
});

test.serial('vault "create" event invalidates the cache — next query re-scans (AUD-wydajnosc-027/047/077)', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/alpha.md', 1)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        textarea.value = '@a';
        textarea.selectionStart = 2;
        textarea._trigger('input');
        await sleep(120);
        t.is(vault.calls.getMarkdownFilesCalls, 1);

        // A new note lands in the vault — cache must drop, not silently miss it.
        files.push(makeFile('Notes/alpha2.md', 2));
        vault._trigger('create');

        textarea.value = '@al';
        textarea.selectionStart = 3;
        textarea._trigger('input');
        await sleep(120);
        t.is(vault.calls.getMarkdownFilesCalls, 2, 'zdarzenie create musi wymusić ponowny skan');
        t.true(mention.items.some((i: { name: string }) => i.name === 'alpha2'), 'nowy plik jest widoczny w podpowiedziach');

        mention.destroy();
    });
});

test.serial('destroy() unregisters vault listeners and cancels the pending debounce timer', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/alpha.md', 1)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        t.deepEqual(vault.listenerCounts, { create: 1, delete: 1, rename: 1 });

        textarea.value = '@a';
        textarea.selectionStart = 2;
        textarea._trigger('input');
        mention.destroy();

        await sleep(120);
        // Timer was cancelled by destroy() — no scan should have happened after teardown.
        t.is(vault.calls.getMarkdownFilesCalls, 0);
        t.deepEqual(vault.listenerCounts, { create: 0, delete: 0, rename: 0 }, 'destroy() musi odpiąć nasłuchy vaulta (offref)');
    });
});

test.serial('mouseover on an already-selected row skips the dropdown rebuild (AUD-wydajnosc-078)', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/alpha.md', 2), makeFile('Notes/beta.md', 1)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        textarea.value = '@';
        textarea.selectionStart = 1;
        textarea._trigger('input');
        await sleep(120);
        t.true(mention.items.length >= 2, 'trzeba co najmniej 2 wierszy, żeby test cokolwiek sprawdzał');

        const dropdown = mention.dropdown as FakeEl;
        const rowsBefore = dropdown.emptyCalls;

        // Row 0 is already selectedIndex (0) — three "mouseover" events landing on it
        // (icon/name/path bubbling in the real DOM) must NOT trigger three rebuilds.
        const row0 = dropdown.children.find(c => c.classList.contains('mention-item') && c.classList.contains('selected'));
        t.truthy(row0, 'nie znalazłem zaznaczonego wiersza');
        fireEvent(row0!, 'mouseover');
        fireEvent(row0!, 'mouseover');
        fireEvent(row0!, 'mouseover');

        t.is(dropdown.emptyCalls, rowsBefore, 'mouseover na już zaznaczonym wierszu nie może przebudować dropdownu');

        mention.destroy();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Review fix (2026-09-02) — BLOKER: debounce vs Enter/Tab/strzałki race,
// BLOKER: wyciek nasłuchów vaulta, plus DiffModal "brak zmian" (osobny plik).
// ═══════════════════════════════════════════════════════════════════════════

test.serial('Enter picks the suggestion for the LATEST typed query, not a stale debounced one (BLOKER)', async t => {
    await withFakeDocument(async () => {
        // "daniel" matches query 'da' (and has the higher mtime, so it sorts first for 'da').
        // "dailyp-notes" ALSO matches 'da', but is the ONLY match once the query becomes
        // 'dailyp' — the exact repro from the review: type "@da", keep typing "ilyp" within
        // the debounce window, hit Enter before the timer fires.
        const files = [makeFile('Notes/daniel.md', 10), makeFile('Notes/dailyp-notes.md', 5)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        // Type the whole "@dailyp" query keystroke by keystroke, WITHOUT ever awaiting —
        // the 50ms debounce genuinely cannot have fired by the time we reach Enter below.
        for (const typed of ['@', '@d', '@da', '@dai', '@dail', '@daily', '@dailyp']) {
            textarea.value = typed;
            textarea.selectionStart = typed.length;
            textarea._trigger('input');
        }

        const enterEvent = makeKeydownEvent('Enter');
        textarea._trigger('keydown', enterEvent);

        t.true(enterEvent._defaultPrevented, 'Enter must be intercepted by the (flushed) suggestion list');
        t.true(mention.hasMentions(), 'a mention must have been inserted');
        t.is(mention.getMentions()[0].name, 'dailyp-notes', 'must match the LATEST query "dailyp", not the stale "da" result ("daniel")');

        mention.destroy();
    });
});

test.serial('ArrowDown/ArrowUp also flush a pending debounce before navigating (BLOKER, same fix)', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/daniel.md', 10), makeFile('Notes/dailyp-notes.md', 5)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        for (const typed of ['@da', '@dailyp']) {
            textarea.value = typed;
            textarea.selectionStart = typed.length;
            textarea._trigger('input');
        }
        // No sleep — debounce still pending for "dailyp".

        const downEvent = makeKeydownEvent('ArrowDown');
        textarea._trigger('keydown', downEvent);

        t.is(mention.items.length, 1, 'items must reflect the flushed "dailyp" query (single match), not stale "da" results');
        t.is(mention.items[0].name, 'dailyp-notes');

        mention.destroy();
    });
});

test.serial('Enter right after a bare "@" (before the debounce fires) picks the top suggestion instead of falling through to send the message (P2)', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/recent.md', 99)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        textarea.value = '@';
        textarea.selectionStart = 1;
        textarea._trigger('input');
        // No sleep — items is still [] pre-debounce at this point.
        t.is(mention.items.length, 0, 'sanity: nothing scanned yet, pre-flush');

        const enterEvent = makeKeydownEvent('Enter');
        textarea._trigger('keydown', enterEvent);

        t.true(enterEvent._defaultPrevented, 'Enter must be intercepted — before the fix, an empty `items` fell through to the chat, which sent the message');
        t.true(mention.hasMentions(), 'the top suggestion must be picked, not silently dropped');
        t.is(mention.getMentions()[0].name, 'recent');

        mention.destroy();
    });
});

test.serial('regular character keydowns do NOT flush a pending debounce (perf fix must survive the BLOKER fix)', async t => {
    await withFakeDocument(async () => {
        const files = Array.from({ length: 20 }, (_, i) => makeFile(`Notes/projekt-${i}.md`, i));
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        textarea.value = '@p';
        textarea.selectionStart = 2;
        textarea._trigger('input'); // schedules a debounced scan

        // Real typing fires 'keydown' for every letter too, not just Enter/Tab/Arrows. If the
        // BLOKER fix's flush were unconditional (top of _handleKeydown, instead of scoped to
        // the 4 navigation branches), this would resurrect the O(vault)-per-keystroke bug
        // (AUD-wydajnosc-027/047/077) by forcing a synchronous scan on every letter.
        for (const key of ['p', 'r', 'o', 'j']) {
            textarea._trigger('keydown', makeKeydownEvent(key));
        }

        t.is(vault.calls.getMarkdownFilesCalls, 0, 'plain letter keydowns must never flush/force a synchronous scan');

        await sleep(120);
        t.is(vault.calls.getMarkdownFilesCalls, 1, 'the ORIGINAL debounced scan still fires exactly once, undisturbed');

        mention.destroy();
    });
});

test.serial('close() cancels a pending debounce and reopening does not flash the previous mention\'s stale rows', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/alpha.md', 1), makeFile('Notes/beta.md', 2)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        textarea.value = '@a';
        textarea.selectionStart = 2;
        textarea._trigger('input');
        await sleep(120);
        t.true(mention.items.some((i: { name: string }) => i.name === 'alpha'));

        const escEvent = makeKeydownEvent('Escape');
        textarea._trigger('keydown', escEvent);
        t.is(mention.items.length, 0, 'close() must clear items');
        t.false(mention.isOpen);

        // Start a fresh mention for "b" — the dropdown DOM persists across close()/reopen
        // (only destroy() removes it), so without the fix the OLD "alpha" rows would still be
        // sitting in the DOM until the debounce fires ~50ms later.
        textarea.value = '@b';
        textarea.selectionStart = 2;
        textarea._trigger('input');

        function collectText(el: FakeEl): string {
            return (el.textContent || '') + el.children.map(collectText).join('');
        }
        const dropdown = mention.dropdown as FakeEl;
        t.false(collectText(dropdown).includes('alpha'), 'stale "alpha" row must not be visible right after reopening');

        mention.destroy();
    });
});

test.serial('a leaked instance (textarea detached from DOM) self-destroys on the first vault event (skin-change leak)', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/alpha.md', 1)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea();
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});
        t.truthy(mention, 'sanity: the orphan instance was constructed (it tears itself down below, no explicit destroy() call)');

        t.deepEqual(vault.listenerCounts, { create: 1, delete: 1, rename: 1 });

        // Simulate chat_ui.ts (modules/chat, out of scope here) recreating the widget on a
        // skin change WITHOUT calling destroy() on this old instance — its textarea is removed
        // from the live DOM, but this orphaned instance is still listening to the vault.
        textarea.isConnected = false;

        vault._trigger('create'); // first vault event after detachment

        t.deepEqual(vault.listenerCounts, { create: 0, delete: 0, rename: 0 }, 'orphan self-destroys (destroy() offrefs all 3) on the first vault event once detached');

        // Further vault activity must not throw or do anything (listeners are already gone —
        // this just proves the teardown didn't leave anything half-wired).
        t.notThrows(() => { vault._trigger('delete'); vault._trigger('rename'); });
    });
});

test.serial('a normal (still-attached) instance does NOT self-destroy on vault events', async t => {
    await withFakeDocument(async () => {
        const files = [makeFile('Notes/alpha.md', 1)];
        const vault = makeFakeVault(files, []);
        const textarea = makeFakeTextarea(); // isConnected: true by default
        const plugin = { app: { vault } };
        const mention = new MentionAutocomplete(textarea, plugin, {});

        vault._trigger('create');

        t.deepEqual(vault.listenerCounts, { create: 1, delete: 1, rename: 1 }, 'a live instance must keep listening — only detachment triggers self-heal');

        mention.destroy();
    });
});
