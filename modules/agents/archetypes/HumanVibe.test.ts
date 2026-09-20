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
