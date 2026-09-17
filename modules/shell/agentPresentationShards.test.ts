import test from 'ava';
import { isShardFilled } from './agentPresentationShards.js';

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
