import test from 'ava';
import { buildTodoPanelModel, resolveBottomBarMode, DEFAULT_BOTTOM_BAR_MODE } from './todoPanel.js';

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

// ── resolveBottomBarMode (N4): który widok pokazuje pasek dolny ──────────────

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

test('update w trakcie życia listy NIE zmienia widoku — wybór usera zostaje', t => {
    const przed = zywa();
    const po = buildTodoPanelModel({ items: [{ text: 'a', checked: true }, { text: 'b', checked: false }] });
    t.is(resolveBottomBarMode(przed, po, 'input'), 'input', 'user wrócił do pisania — check itemu go nie wyrzuca');
    t.is(resolveBottomBarMode(przed, po, 'todo'), 'todo');
});

test('brak listy trzyma pasek na input niezależnie od bieżącego widoku', t => {
    t.is(resolveBottomBarMode(pusta(), pusta(), 'todo'), 'input');
    t.is(resolveBottomBarMode(null, pusta(), 'input'), 'input');
});

// ── Z3 (FAIL 6 smoke'a 2026-08-15): auto-przeskok nie chowa szkicu usera ──────
// Auto-przeskok dokłada klasę `.is-hidden` całemu wierszowi inputu (reguła w src/styles.css),
// więc niewysłany tekst znikał userowi z oczu przy tool-callu `todo` — wyglądało to jak
// skasowanie szkicu.

test('lista się pojawia, ale user ma szkic → pasek ZOSTAJE na input', t => {
    t.is(resolveBottomBarMode(null, zywa(), 'input', true), 'input');
    t.is(resolveBottomBarMode(pusta(), zywa(), 'input', true), 'input');
});

test('szkic nie blokuje niczego poza AUTO-przeskokiem', t => {
    // Ręczny wybór usera (chip 📋) i powrót po zniknięciu listy działają jak dotąd.
    const przed = zywa();
    const po = buildTodoPanelModel({ items: [{ text: 'a', checked: true }] });
    t.is(resolveBottomBarMode(przed, po, 'todo', true), 'todo', 'user sam wszedł na listę — zostaje');
    t.is(resolveBottomBarMode(zywa(), pusta(), 'todo', true), 'input');
    t.is(resolveBottomBarMode(null, zywa(), 'input', false), 'todo', 'bez szkicu przeskok jak przed Z3');
});
