/**
 * Testy czystej składanki promptu startowego (S32 Z1a).
 *
 * Modal (DOM) świadomie bez testu — cała logika siedzi tutaj. `translate` wstrzykujemy jako
 * atrapę, żeby asercje nie zależały od treści słowników (te pilnuje `parity.test.js`).
 */
import test from 'ava';
import { buildStartPrompt, getToneOption, TONE_OPTIONS } from './startPromptGenerator.js';
import { t as realT } from '../../../core/i18n/index.js';

/** Atrapa i18n: zwraca klucz + wstawia parametry, więc widać KTÓRY szablon i CO w nim wylądowało. */
function fakeT(key: string, params?: Record<string, string>) {
    if (!params) return `<${key}>`;
    const args = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',');
    return `<${key}:${args}>`;
}

test('buildStartPrompt: komplet pól daje trzy sekcje w kolejności kim/jak/zasady', t => {
    const text = buildStartPrompt(
        { role: 'archiwistą vaulta', tone: 'mentor', rules: 'nie kasuj plików\npytaj o zgodę' },
        fakeT
    );
    const blocks = text.split('\n\n');
    t.is(blocks.length, 3);
    t.is(blocks[0], '<profile.start_prompt.tpl_who:role=archiwistą vaulta>');
    t.is(blocks[1], '<profile.start_prompt.tpl_tone:tone=<profile.start_prompt.tone_mentor_phrase>>');
    t.is(blocks[2], '<profile.start_prompt.tpl_rules>\n- nie kasuj plików\n- pytaj o zgodę');
});

test('buildStartPrompt: puste pola są pomijane, nie zostawiają pustych zdań', t => {
    t.is(buildStartPrompt({}, fakeT), '');
    t.is(buildStartPrompt({ role: '   ' }, fakeT), '');
    t.is(buildStartPrompt({ role: 'kucharzem', tone: '', rules: '' }, fakeT),
        '<profile.start_prompt.tpl_who:role=kucharzem>');
    t.is(buildStartPrompt({ tone: 'concise' }, fakeT),
        '<profile.start_prompt.tpl_tone:tone=<profile.start_prompt.tone_concise_phrase>>');
    // Same zasady, bez roli i tonu — nadal sensowny tekst.
    t.is(buildStartPrompt({ rules: 'bądź krótki' }, fakeT),
        '<profile.start_prompt.tpl_rules>\n- bądź krótki');
});

test('buildStartPrompt: nieznany ton wypada z tekstu (nie wstawia śmieci)', t => {
    t.is(buildStartPrompt({ role: 'X', tone: 'nie-ma-takiego' }, fakeT),
        '<profile.start_prompt.tpl_who:role=X>');
    t.is(getToneOption('nie-ma-takiego'), null);
});

test('buildStartPrompt: zasady — puste linie out, wiodące myślniki i numery zdjęte', t => {
    const text = buildStartPrompt({ rules: '- pierwsza\n\n* druga\n2) trzecia\n   \n• czwarta' }, fakeT);
    t.is(text, '<profile.start_prompt.tpl_rules>\n- pierwsza\n- druga\n- trzecia\n- czwarta');
});

test('buildStartPrompt: kropka na końcu roli nie dubluje się z szablonem', t => {
    // Szablon sam kończy zdanie kropką — user, który ją napisał, nie dostaje „..".
    t.is(buildStartPrompt({ role: 'archiwistą.' }, realT).endsWith('..'), false);
    t.true(buildStartPrompt({ role: 'archiwistą.' }, realT).includes('archiwistą'));
});

test('buildStartPrompt: bez wstrzykniętego translate nie wybucha (zwraca same klucze szablonów)', t => {
    const text = buildStartPrompt({ role: 'X', tone: 'friendly', rules: 'a' });
    t.deepEqual(text.split('\n\n'), [
        'profile.start_prompt.tpl_who',
        'profile.start_prompt.tpl_tone',
        'profile.start_prompt.tpl_rules\n- a',
    ]);
});

test('TONE_OPTIONS: 5 tonów, unikalne id, każdy z etykietą i frazą w słownikach', t => {
    t.is(TONE_OPTIONS.length, 5);
    t.is(new Set(TONE_OPTIONS.map(o => o.id)).size, 5);
    for (const opt of TONE_OPTIONS) {
        t.not(realT(opt.labelKey), opt.labelKey, `brak tłumaczenia: ${opt.labelKey}`);
        t.not(realT(opt.phraseKey), opt.phraseKey, `brak tłumaczenia: ${opt.phraseKey}`);
    }
});

test('buildStartPrompt: wynik jest markdown-light — zero nagłówków #', t => {
    const text = buildStartPrompt(
        { role: 'archiwistą', tone: 'mentor', rules: 'nie kasuj' },
        realT
    );
    t.false(/^#/m.test(text));
});
