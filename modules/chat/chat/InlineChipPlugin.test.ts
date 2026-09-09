import test from 'ava';
import {
    parseInlineTriggers,
    stripInlineTriggers,
    buildInlineTriggerInstruction,
    makeInlineTriggerMarker,
} from './InlineChipPlugin.js';

test('parseInlineTriggers supports default marker format', t => {
    const markers = parseInlineTriggers('@@skill:redaktor @sub-agent:prep-x-post @@tool:vault_grep znajdz notki');

    t.deepEqual(markers.map(m => `${m.type}:${m.name}`), [
        'skill:redaktor',
        'sub-agent:prep-x-post',
        'tool:vault_grep',
    ]);
});

test('stripInlineTriggers removes markers and leaves user text', t => {
    t.is(stripInlineTriggers('@@skill:redaktor @sub-agent:prep-x znajdz referencje'), 'znajdz referencje');
});

test('buildInlineTriggerInstruction forces exact sub-agent delegate', t => {
    const instruction = buildInlineTriggerInstruction(parseInlineTriggers('@sub-agent:Klara-prep-x-post znajdz'));

    t.true(instruction.includes('aspect="Klara-prep-x-post"'));
    t.true(instruction.includes('aspect_explicit=true'));
});

test('marker @@skill: wstrzykuje PEŁNY przepis (nie woła skill_execute)', t => {
    const markers = parseInlineTriggers('@@skill:daily-review zrób przegląd');
    const instruction = buildInlineTriggerInstruction(markers, {
        'daily-review': { name: 'daily-review', prompt: 'Krok 1: przejrzyj notatki dnia\nKrok 2: podsumuj' },
    });
    t.false(instruction.includes('skill_execute'));
    t.true(instruction.includes('URUCHOMIŁ SKILL "daily-review"'));
    t.true(instruction.includes('Krok 1: przejrzyj notatki dnia'));
    t.true(instruction.includes('Krok 2: podsumuj'));
});

test('marker @@skill: nieznanego skilla → krótka nota, bez wybuchu', t => {
    const markers = parseInlineTriggers('@@skill:nieistnieje hej');
    const instruction = buildInlineTriggerInstruction(markers, {});
    t.false(instruction.includes('skill_execute'));
    t.true(instruction.includes('nie znaleziony'));
    t.true(instruction.includes('nieistnieje'));
});

test('makeInlineTriggerMarker emits canonical markers', t => {
    t.is(makeInlineTriggerMarker('skill', 'daily-review'), '@@skill:daily-review');
    t.is(makeInlineTriggerMarker('tool', 'vault_grep'), '@@tool:vault_grep');
    t.is(makeInlineTriggerMarker('sub-agent', 'prep-whitelist'), '@sub-agent:prep-whitelist');
});

