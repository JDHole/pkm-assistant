/**
 * Strażnik: żaden tekst fabryczny w słownikach i18n nie niesie em dash (U+2014 „—")
 * ani en dash (U+2013 „–"). Zwykły dywiz „-" zastępuje oba (właściciel: żadnych tych
 * znaków w tekstach dla niego - patrz `CLAUDE.md` root, sekcja "Priorities"; powód
 * mierzony: prompt-eval pokazywał 14-33 takich znaków na personę, uczone z tekstu
 * fabrycznego pluginu).
 *
 * Komentarze w kodzie (`//`, `/** ... * /`) mogą dalej nosić te znaki - to nie jest
 * tekst dla usera ani dla modelu. Ten test czyta WYŁĄCZNIE wartości słownika (po
 * imporcie modułu, więc widzi dokładnie to, co `t()` odda w runtime), nie źródło pliku.
 */
import test from 'ava';
import { pl } from './pl.js';
import { en } from './en.js';

const EM_DASH = '—';
const EN_DASH = '–';

function offendingKeys(dict: Record<string, string>): string[] {
    return Object.entries(dict)
        .filter(([, value]) => value.includes(EM_DASH) || value.includes(EN_DASH))
        .map(([key]) => key);
}

test('i18n pl: zero wartości z em dash lub en dash', t => {
    t.deepEqual(offendingKeys(pl), [], 'te klucze pl.ts niosą — albo – zamiast zwykłego dywizu');
});

test('i18n en: zero wartości z em dash lub en dash', t => {
    t.deepEqual(offendingKeys(en), [], 'te klucze en.ts niosą — albo – zamiast zwykłego dywizu');
});
