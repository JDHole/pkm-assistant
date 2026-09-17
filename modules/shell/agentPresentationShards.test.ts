import test from 'ava';
import { brainShardValue, isShardFilled } from './agentPresentationShards.js';

const GLOBAL_LABEL = 'globalny';

// ── BUG D3a: `Brain` (stats.brainSize) jest LICZBĄ, reszta pól stringiem ──
// `AgentPresentationModal` porównywał `info.value !== '0'` bez `String()` - dla `brainSize`
// liczbowego `0` to porównanie liczby z tekstem, zawsze `true` (`0 !== '0'`), więc pusty mózg
// renderował się jako `cs-shard--filled` NIEZALEŻNIE od realnej wartości.
test('pusty Brain (liczba 0) NIE jest wypełniony', t => {
    t.false(isShardFilled(0, GLOBAL_LABEL), 'liczba 0 ma znaczyć to samo co string "0"');
});

test('niepusty Brain (liczba > 0) JEST wypełniony', t => {
    t.true(isShardFilled(1234, GLOBAL_LABEL));
});

test('string "0" (L1/L2 puste) NIE jest wypełniony', t => {
    t.false(isShardFilled('0', GLOBAL_LABEL));
});

test('string niezerowy JEST wypełniony', t => {
    t.true(isShardFilled('7', GLOBAL_LABEL));
});

test('etykieta "globalny" (model) NIE jest wypełniona', t => {
    t.false(isShardFilled(GLOBAL_LABEL, GLOBAL_LABEL));
});

test('nazwa modelu realna JEST wypełniona', t => {
    t.true(isShardFilled('claude-opus-4', GLOBAL_LABEL));
});

// ── Smoke 2.2.6 (2026-09-17): nowy agent pokazywał Brain "116" i świecił ──
// `stats.brainSize` to liczba ZNAKÓW `brain.md`, a nowy agent ma tam szablon z nagłówkami
// (nigdy 0), więc shard był wypełniony przy pustej pamięci. Shard pokazuje liczbę notatek
// w `brain/` (`brainNoteCount`) - szablon indeksu nie jest wiedzą agenta.
test('nowy agent: szablon brain.md (116 znaków), zero notatek -> Brain "0", shard pusty', t => {
    const value = brainShardValue({ brainSize: 116, brainNoteCount: 0 });
    t.is(value, '0');
    t.false(isShardFilled(value, GLOBAL_LABEL));
});

test('agent z notatkami w brain/ -> Brain pokazuje ich liczbę, shard wypełniony', t => {
    const value = brainShardValue({ brainSize: 8246, brainNoteCount: 42 });
    t.is(value, '42');
    t.true(isShardFilled(value, GLOBAL_LABEL));
});

test('brak statystyk (agent bez pamięci) -> Brain "0"', t => {
    t.is(brainShardValue(null), '0');
    t.is(brainShardValue(undefined), '0');
});
