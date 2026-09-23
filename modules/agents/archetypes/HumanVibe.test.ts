/**
 * Persona wbudowanego agenta idzie za językiem interfejsu.
 *
 * `setLocale` to stan globalny procesu testowego, więc oba testy są `test.serial` i oddają
 * domyślne `'en'` w teardownie (reszta repo liczy na ten default).
 */
import test from 'ava';
import { createJaskier } from './HumanVibe.js';
import { setLocale } from '../../../core/i18n/index.js';

/** Litery, które w angielskim tekście nie mają prawa się pojawić. */
const POLSKIE_ZNAKI = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

test.serial('locale en → persona Jaskra po angielsku, bez polskich znaków', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    const personality = createJaskier().personality;
    t.true(personality.startsWith('I am Jaskier'), personality.slice(0, 40));
    t.false(POLSKIE_ZNAKI.test(personality));
    t.true(personality.includes('/save session'));
});

test.serial('locale pl → persona Jaskra po polsku (bez zmian dla vaultów PL)', t => {
    setLocale('pl');
    t.teardown(() => setLocale('en'));

    const personality = createJaskier().personality;
    t.true(personality.startsWith('Jestem Jaskier'), personality.slice(0, 40));
    t.true(personality.includes('Komunikuję się naturalnie, po polsku'));
});

// Persona opisywała brain.md dosłownym wyliczeniem nagłówków SWOJEGO języka (PL: "## Bieżące",
// EN: "current context, user, preferences, workflow, projects and references" - niemal 1:1 z
// realnymi nagłówkami `brainSections.ts`). brain.md agenta rodzi się w języku UI z chwili
// utworzenia i ZOSTAJE w nim na zawsze (modules/memory/CLAUDE.md, "Język brain.md") - user, który
// PÓŹNIEJ przełączy UI, dostawałby personę opisującą nagłówki w INNYM języku niż te, które
// naprawdę są w pliku Jaskra. Persona ma teraz opisywać sekcje TEMATYCZNIE, nie ich nazwami.
// Recenzja niezależna, punkt 13.
test.serial('persona NIE nazywa sekcji brain.md dosłownym nagłówkiem pliku (opis tematyczny, nie adres)', t => {
    setLocale('pl');
    t.teardown(() => setLocale('en'));
    const pl = createJaskier().personality;
    t.false(pl.includes('## Bieżące'), 'stary bug: persona cytowała nagłówek jako markdown, mogła się rozjechać z realnym plikiem po zmianie języka UI');
    t.false(/sekcjami:\s*Bieżące/.test(pl), 'stary bug: wyliczenie nagłówków 1:1 z rejestrem brainSections.ts');

    setLocale('en');
    const en = createJaskier().personality;
    t.false(en.includes('## Current'));
    t.false(/grouped into sections \(current context/.test(en), 'stary bug: wyliczenie nagłówków 1:1 z rejestrem brainSections.ts');
});

test.serial('reszta konfiguracji nie zależy od języka', t => {
    setLocale('pl');
    t.teardown(() => setLocale('en'));
    const pl = createJaskier();
    setLocale('en');
    const en = createJaskier();

    t.is(pl.name, 'Jaskier');
    t.is(en.name, 'Jaskier');
    t.is(en.temperature, pl.temperature);
    // Plugin nie dostarcza skilli: Jaskier startuje bez przypisań w OBU językach.
    t.deepEqual(pl.skills, []);
    t.deepEqual(en.skills, []);
    t.is(en.isBuiltIn, true);
});
