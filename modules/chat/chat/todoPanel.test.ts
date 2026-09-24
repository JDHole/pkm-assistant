import test from 'ava';
import { buildTodoPanelModel, resolveBottomBarMode, DEFAULT_BOTTOM_BAR_MODE } from './todoPanel.js';
import { _showQueuedIndicator, _hideQueuedIndicator } from './chat_streaming.js';

test('empty / null state → not visible', t => {
    t.false(buildTodoPanelModel(null).visible);
    t.false(buildTodoPanelModel({ items: [] }).visible);
});

test('finished state hides the panel', t => {
    const m = buildTodoPanelModel({ items: [{ text: 'a', checked: true }], finished: true });
    t.false(m.visible);
});

test('counts done vs total and detects allDone', t => {
    const m = buildTodoPanelModel({
        title: 'Robota',
        items: [
            { text: 'a', checked: true },
            { text: 'b', checked: false },
        ],
    });
    t.true(m.visible);
    t.is(m.title, 'Robota');
    t.is(m.total, 2);
    t.is(m.done, 1);
    t.false(m.allDone);
});

test('allDone when every item checked', t => {
    const m = buildTodoPanelModel({ items: [{ text: 'a', done: true }, { text: 'b', checked: true }] });
    t.true(m.allDone);
    t.is(m.done, 2);
});

test('accepts `done` alias for checked', t => {
    const m = buildTodoPanelModel({ items: [{ text: 'x', done: true }] });
    t.true(m.items[0].checked);
});

// ── resolveBottomBarMode: który widok pokazuje pasek dolny ───────────────────

const zywa = () => buildTodoPanelModel({ items: [{ text: 'a', checked: false }] });
const pusta = () => buildTodoPanelModel(null);

test('domyślny widok paska to input', t => {
    t.is(DEFAULT_BOTTOM_BAR_MODE, 'input');
});

test('lista się pojawia (brak → aktywna) → auto-przeskok na todo', t => {
    t.is(resolveBottomBarMode(null, zywa(), 'input'), 'todo');
    t.is(resolveBottomBarMode(pusta(), zywa(), 'input'), 'todo');
});

test('lista znika (finish/pusta) → powrót na input', t => {
    t.is(resolveBottomBarMode(zywa(), pusta(), 'todo'), 'input');
    t.is(resolveBottomBarMode(zywa(), buildTodoPanelModel({ items: [{ text: 'a', checked: true }], finished: true }), 'todo'), 'input');
});

test('update w trakcie życia listy NIE zmienia widoku - wybór usera zostaje', t => {
    const przed = zywa();
    const po = buildTodoPanelModel({ items: [{ text: 'a', checked: true }, { text: 'b', checked: false }] });
    t.is(resolveBottomBarMode(przed, po, 'input'), 'input', 'user wrócił do pisania - check itemu go nie wyrzuca');
    t.is(resolveBottomBarMode(przed, po, 'todo'), 'todo');
});

test('brak listy trzyma pasek na input niezależnie od bieżącego widoku', t => {
    t.is(resolveBottomBarMode(pusta(), pusta(), 'todo'), 'input');
    t.is(resolveBottomBarMode(null, pusta(), 'input'), 'input');
});

// ── auto-przeskok nie chowa szkicu usera ──────────────────────────────────────
// Auto-przeskok dokłada klasę `.is-hidden` całemu wierszowi inputu (reguła w src/styles.css),
// więc bez tego zabezpieczenia niewysłany tekst znikałby userowi z oczu przy tool-callu
// `todo` - wyglądałoby to jak skasowanie szkicu.

test('lista się pojawia, ale user ma szkic → pasek ZOSTAJE na input', t => {
    t.is(resolveBottomBarMode(null, zywa(), 'input', true), 'input');
    t.is(resolveBottomBarMode(pusta(), zywa(), 'input', true), 'input');
});

test('szkic nie blokuje niczego poza AUTO-przeskokiem', t => {
    // Ręczny wybór usera (chip 📋) i powrót po zniknięciu listy działają jak dotąd.
    const przed = zywa();
    const po = buildTodoPanelModel({ items: [{ text: 'a', checked: true }] });
    t.is(resolveBottomBarMode(przed, po, 'todo', true), 'todo', 'user sam wszedł na listę - zostaje');
    t.is(resolveBottomBarMode(zywa(), pusta(), 'todo', true), 'input');
    t.is(resolveBottomBarMode(null, zywa(), 'input', false), 'todo', 'bez szkicu przeskok działa jak dotąd');
});

// ── Wskaźnik zakolejkowanej wiadomości: stałe miejsce NAD paskiem chipów (spec E) ────────────
//
// `_showQueuedIndicator`/`_hideQueuedIndicator` żyją w `chat_streaming.ts` (importowalne w AVA -
// nie ma tam CSS-owego `import ... with { type: 'css' }`, w przeciwieństwie do `chat_ui.ts`,
// patrz `typingIndicator.test.ts`). Globalny atrapowy `createDiv`/`createSpan` z preloadu
// harnessu [measured] NIE śledzi `parentElement`/kolejności `insertBefore`/`classList` (`MockEl`
// w `pkm-assistant-harness/test-support/dom-shim.ts` jest jawnie "atrapa nie renderuje" - dobra
// do smoke-testu bootstrapu, bezużyteczna do sprawdzenia STRUKTURY DOM), więc test podmienia na
// czas wywołania WŁASną, minimalną atrapę tych dwóch globali (ten sam wzorzec co
// `handleError.tile.test.ts`'s `withFakeDocument`, tylko na innych globalach - `_showQueuedIndicator`
// woła gołe `createDiv()`, nie `document.createElement`).

interface FakeEl {
    tagName: string;
    children: FakeEl[];
    parentElement: FakeEl | null;
    classList: { add(...c: string[]): void; contains(c: string): boolean; toggle(c: string, force?: boolean): void };
    className: string;
    textContent: string;
    hidden: boolean;
    createDiv(opts?: { cls?: string; text?: string }): FakeEl;
    createSpan(opts?: { cls?: string; text?: string }): FakeEl;
    appendText(t: string): void;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    remove(): void;
}

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        children: [],
        parentElement: null,
        hidden: false,
        classList: {
            add: (...c) => { c.forEach(x => classes.add(x)); },
            contains: (c) => classes.has(c),
            toggle: (c, force) => { const next = force === undefined ? !classes.has(c) : force; if (next) classes.add(c); else classes.delete(c); },
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; },
        appendText(t) { text += t; },
        createDiv(opts) { return el.appendChild(applyOpts(makeFakeEl('div'), opts)); },
        createSpan(opts) { return el.appendChild(applyOpts(makeFakeEl('span'), opts)); },
        appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            child.parentElement = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        remove() {
            const parent = el.parentElement;
            if (!parent) return;
            const idx = parent.children.indexOf(el);
            if (idx >= 0) parent.children.splice(idx, 1);
            el.parentElement = null;
        },
    } as FakeEl;
    return el;
}

function applyOpts(el: FakeEl, opts?: { cls?: string; text?: string }): FakeEl {
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text != null) el.textContent = opts.text;
    return el;
}

/** Podmienia GLOBALNE `createDiv`/`createSpan` (Obsidianowe pomocniki) na czas `fn()`. */
function withFakeCreateEl<T>(fn: () => T): T {
    const g = globalThis as Record<string, unknown>;
    const prevDiv = g.createDiv;
    const prevSpan = g.createSpan;
    g.createDiv = (opts?: { cls?: string; text?: string }) => applyOpts(makeFakeEl('div'), opts);
    g.createSpan = (opts?: { cls?: string; text?: string }) => applyOpts(makeFakeEl('span'), opts);
    try {
        return fn();
    } finally {
        g.createDiv = prevDiv;
        g.createSpan = prevSpan;
    }
}

test.serial('_showQueuedIndicator montuje wskaźnik NAD _chipBar, w kontenerze widocznym w OBU trybach slotu (input i todo)', t => {
    withFakeCreateEl(() => {
        const bottomPanel = makeFakeEl('div');
        const inputRow = makeFakeEl('div');
        const todoPanelBar = makeFakeEl('div');
        const chipBar = makeFakeEl('div');
        bottomPanel.appendChild(inputRow);
        bottomPanel.appendChild(todoPanelBar);
        bottomPanel.appendChild(chipBar);

        // `_showQueuedIndicator` woła najpierw `this._hideQueuedIndicator()` (dren poprzedniego
        // wskaźnika) - fabrykowany `this` musi mieć tę samą, REALNĄ funkcję pod ręką.
        const fakeThis = { _chipBar: chipBar, _queuedIndicatorEl: null as FakeEl | null, _hideQueuedIndicator };
        // TS-boundary: fabrykowany `this` mixina - sygnatura realna to `ChatViewLike`, ale
        // `_showQueuedIndicator`/`_hideQueuedIndicator` dotykają wyłącznie `_chipBar`/`_queuedIndicatorEl`.
        _showQueuedIndicator.call(fakeThis as never, 'wiadomość dla suba');

        const indicator = fakeThis._queuedIndicatorEl;
        t.truthy(indicator, '_showQueuedIndicator musi ustawić this._queuedIndicatorEl');
        t.is(indicator!.parentElement, bottomPanel,
            'wskaźnik ma wisieć w STAŁYM kontenerze (rodzicu _chipBar), nie w slocie pola/todo');
        t.is(bottomPanel.children[bottomPanel.children.indexOf(chipBar) - 1], indicator!,
            'wskaźnik ma być BEZPOŚREDNIO NAD _chipBar (pierwsze dziecko przed paskiem chipów)');

        // Symulacja trybu 'todo': `_applyBottomBarMode` (chat_ui.ts) chowa TYLKO _inputRow/
        // _todoPanelBar (klasa is-hidden) - patrz modules/chat/CLAUDE.md, "Pasek dolny: input
        // vs todo". Wskaźnik wiszący w bottomPanel (rodzicu _chipBar) nigdy nie jest ich
        // potomkiem, więc przełączenie trybu go nie chowa.
        inputRow.classList.add('is-hidden');
        t.false(inputRow.children.includes(indicator!), 'wskaźnik nie może być potomkiem chowanego _inputRow');
        t.false(todoPanelBar.children.includes(indicator!), 'wskaźnik nie może być potomkiem chowanego _todoPanelBar');
        t.false(indicator!.classList.contains('is-hidden'), 'wskaźnik sam nie dostaje is-hidden');
        t.false(indicator!.hidden, 'wskaźnik nie dostaje atrybutu hidden');

        // `_hideQueuedIndicator` bez zmian semantyki (spec E, "Czego NIE robić").
        _hideQueuedIndicator.call(fakeThis as never);
        t.is(fakeThis._queuedIndicatorEl, null, '_hideQueuedIndicator zeruje uchwyt jak dotąd');
        t.false(bottomPanel.children.includes(indicator!), '_hideQueuedIndicator usuwa element z DOM jak dotąd');
    });
});
