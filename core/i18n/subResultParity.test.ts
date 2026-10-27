import test from 'ava';
import { pl } from './pl.js';
import { en } from './en.js';

const RESULT_KEYS = [
    'chat.subresult.completeness.unconfirmed', 'chat.subresult.completeness.partial',
    'chat.subresult.heading_created', 'chat.subresult.heading_missing',
    'chat.subresult.heading_effects', 'chat.subresult.effect_matches', 'chat.subresult.effect_missing',
    'chat.subresult.effect_mismatch', 'chat.subresult.effect_unchecked', 'chat.subresult.continue_same_thread',
    'chat.subresult.user_stopped_material', 'chat.subresult.user_stopped_next', 'chat.subresult.restart',
    'chat.subresult.unavailable',
    'subagent.stopped_before_start',
] as const;

test('subresult: etykiety końca, kompletności i ramki mają parytet PL/EN', t => {
    for (const key of RESULT_KEYS) {
        t.true(Boolean(pl[key]?.trim()), `PL: ${key}`);
        t.true(Boolean(en[key]?.trim()), `EN: ${key}`);
        t.not(pl[key], key);
        t.not(en[key], key);
    }
    t.is(pl['chat.subresult.restart'], '{{name}} nie dokończył: Obsidian zamknięto w trakcie pracy. Sub nie wróci sam.');
    t.is(pl['subagent.stopped_before_start'], '{{name}} zatrzymany, zanim ruszył.');
});
