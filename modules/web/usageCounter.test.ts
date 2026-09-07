/**
 * usageCounter.test.js — licznik wyszukiwań (E3.3, DEC L13-4).
 * Pure, bez obsidiana: `now` jest wstrzykiwany, więc rollover testujemy bez czekania na północ.
 */
import test from 'ava';
import {
    readUsage,
    bumpUsage,
    sumUsage,
    dayKey,
    monthKey,
    COUNTED_PROVIDERS,
} from './usageCounter.js';
import type { UsageState } from './usageCounter.js';

/** Atrapa ustawień: `bumpUsage` wpisuje tu gotowy `UsageState`, więc tak go czytamy. */
type UsageWs = { usage?: UsageState };

const JULY_25 = new Date(2026, 6, 25, 12, 0, 0);
const JULY_26 = new Date(2026, 6, 26, 0, 30, 0);
const AUG_01 = new Date(2026, 7, 1, 9, 0, 0);

test('dayKey/monthKey liczą w czasie lokalnym usera', t => {
    t.is(dayKey(JULY_25), '2026-07-25');
    t.is(monthKey(JULY_25), '2026-07');
    t.is(dayKey(new Date(2026, 0, 5)), '2026-01-05', 'miesiąc i dzień paddowane do dwóch cyfr');
});

test('readUsage na pustych ustawieniach daje same zera i nie mutuje wejścia', t => {
    const ws: UsageWs = {};
    const usage = readUsage(ws, JULY_25);
    t.is(usage.date, '2026-07-25');
    t.is(usage.month, '2026-07');
    t.deepEqual(usage.day, { tavily: 0, brave: 0, serper: 0 });
    t.deepEqual(usage.monthTotals, { tavily: 0, brave: 0, serper: 0 });
    t.is(ws.usage, undefined, 'odczyt niczego nie zapisuje');
});

test('bumpUsage podbija dzień i miesiąc i podmienia ws.usage', t => {
    const ws: UsageWs = {};
    const state = bumpUsage(ws, 'tavily', JULY_25) as UsageState;
    t.is(state.day.tavily, 1);
    t.is(state.monthTotals.tavily, 1);
    t.is(ws.usage, state, 'stan wraca do ustawień jednym przypisaniem (proxy → autosave)');

    bumpUsage(ws, 'tavily', JULY_25);
    bumpUsage(ws, 'brave', JULY_25);
    t.is(ws.usage!.day.tavily, 2);
    t.is(ws.usage!.day.brave, 1);
    t.is(ws.usage!.monthTotals.tavily, 2);
});

test('rollover dnia zeruje dzień, ale NIE miesiąc', t => {
    const ws: UsageWs = {};
    bumpUsage(ws, 'serper', JULY_25);
    bumpUsage(ws, 'serper', JULY_25);

    const afterMidnight = bumpUsage(ws, 'serper', JULY_26) as UsageState;
    t.is(afterMidnight.date, '2026-07-26');
    t.is(afterMidnight.day.serper, 1, 'nowa doba = licznik dnia od zera');
    t.is(afterMidnight.monthTotals.serper, 3, 'miesiąc leci dalej');
});

test('rollover miesiąca zeruje monthTotals', t => {
    const ws: UsageWs = {};
    bumpUsage(ws, 'brave', JULY_25);
    bumpUsage(ws, 'brave', JULY_25);

    const nextMonth = readUsage(ws, AUG_01);
    t.is(nextMonth.month, '2026-08');
    t.is(nextMonth.monthTotals.brave, 0);
    t.is(nextMonth.day.brave, 0);
});

test('jina i searxng nie są liczone — bumpUsage zwraca null i nic nie zapisuje', t => {
    const ws: UsageWs = {};
    t.is(bumpUsage(ws, 'jina', JULY_25), null);
    t.is(bumpUsage(ws, 'searxng', JULY_25), null);
    t.is(bumpUsage(ws, 'nieznany', JULY_25), null);
    t.is(ws.usage, undefined);
    t.false(COUNTED_PROVIDERS.includes('jina'));
    t.false(COUNTED_PROVIDERS.includes('searxng'));
});

test('brudne dane z data.json są normalizowane, nie wysypują licznika', t => {
    const ws = {
        usage: {
            date: '2026-07-25',
            day: { tavily: 'trzy', brave: -5, serper: 2.7, obcy: 100 },
            month: '2026-07',
            monthTotals: null,
        },
    };
    const usage = readUsage(ws, JULY_25);
    t.deepEqual(usage.day, { tavily: 0, brave: 0, serper: 2 });
    t.deepEqual(usage.monthTotals, { tavily: 0, brave: 0, serper: 0 });
    // Znormalizowane liczniki mają WYŁĄCZNIE znanych dostawców — po `obcy` sięgamy przez
    // rzutowanie, bo typ zwrotki nie przewiduje pustego miejsca.
    t.is((usage.day as Record<string, number | undefined>).obcy, undefined, 'nieznane pola nie przechodzą');
});

test('sumUsage sumuje tylko znanych dostawców', t => {
    t.is(sumUsage({ tavily: 3, brave: 1, serper: 0, obcy: 99 }), 4);
    t.is(sumUsage(null), 0);
});

test('bumpUsage na braku obiektu ustawień nie wybucha', t => {
    t.is(bumpUsage(null, 'tavily', JULY_25), null);
    t.is(bumpUsage(undefined, 'tavily', JULY_25), null);
});
