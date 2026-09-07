/**
 * styleSheets — strażnik AUD-bledy-037.
 *
 * Siedem miejsc w repo dokładało arkusze do `document.adoptedStyleSheets` wzorcem
 * „sprawdź `.includes` → rozwiń tablicę". ZERO miejsc coś z niej zdejmowało: wyłączony plugin
 * dalej nadpisywał zmienne motywu aż do restartu Obsidiana, a każdy cykl wyłącz/włącz dokładał
 * kolejne arkusze (świeży bundle = świeże obiekty `CSSStyleSheet`, więc `.includes` ich nie
 * widzi). Tu pilnujemy drugiej strony kontraktu: co weszło przez `adoptSheet`, wychodzi przy
 * demontażu.
 */
import test from 'ava';
import { adoptSheet, removeSheet, removeAdoptedSheets } from './styleSheets.js';

type Sheet = { id: string };
type Doc = { adoptedStyleSheets: Sheet[] };

const doc = (): Doc => ({ adoptedStyleSheets: [] });
const sheet = (id: string): Sheet => ({ id });

test.serial('adoptSheet dokłada arkusz raz, nawet przy wielokrotnym montażu', t => {
    const d = doc();
    const s = sheet('a');

    adoptSheet(s, d);
    adoptSheet(s, d);

    t.deepEqual(d.adoptedStyleSheets, [s]);
    removeAdoptedSheets(d);
});

test.serial('removeSheet zdejmuje dokładnie swój arkusz i nie rusza cudzych', t => {
    const d = doc();
    const mine = sheet('mine');
    const foreign = sheet('obsidian-theme');
    d.adoptedStyleSheets.push(foreign);
    adoptSheet(mine, d);

    const removed = removeSheet(mine, d);

    t.true(removed);
    t.deepEqual(d.adoptedStyleSheets, [foreign], 'arkusz motywu Obsidiana zostaje nietknięty');
    removeAdoptedSheets(d);
});

test.serial('removeSheet jest idempotentny — drugie zdjęcie nic nie psuje', t => {
    const d = doc();
    const s = sheet('a');
    adoptSheet(s, d);

    t.true(removeSheet(s, d));
    t.false(removeSheet(s, d), 'nie ma czego zdejmować = false, bez wyjątku');
    t.deepEqual(d.adoptedStyleSheets, []);
});

test.serial('removeAdoptedSheets zdejmuje WSZYSTKO, co plugin dołożył', t => {
    const d = doc();
    const foreign = sheet('obsidian-theme');
    d.adoptedStyleSheets.push(foreign);
    const a = sheet('a');
    const b = sheet('b');
    adoptSheet(a, d);
    adoptSheet(b, d);

    const count = removeAdoptedSheets(d);

    t.is(count, 2, 'demontaż melduje, ile arkuszy zdjął');
    t.deepEqual(d.adoptedStyleSheets, [foreign]);
    t.is(removeAdoptedSheets(d), 0, 'po demontażu rejestr jest pusty');
});

test.serial('adoptSheet/removeSheet znoszą brak arkusza i brak dokumentu (fail-soft)', t => {
    const d = doc();

    t.false(adoptSheet(null, d));
    t.false(adoptSheet(undefined, d));
    t.false(removeSheet(null, d));
    t.false(adoptSheet(sheet('a'), null));
    t.deepEqual(d.adoptedStyleSheets, []);
});
