/**
 * BUG (silent drop w "Na teraz"): `_normalizeUpdate` w `SaveSessionModal.ts` domyślał
 * `section` na `'## Bieżące'` (nagłówek pliku `brain.md`), a poprawne klucze API to
 * `'user'` / `'environment'`. Modal pokazywał taki wpis jako „Na teraz: User"
 * (`_naTerazLabel`), user go zatwierdzał, ale `naTerazSectionKey('## Bieżące')`
 * (`modules/memory/BrainIndex.ts`) zwraca `null`, więc `applyNaTerazOps` po cichu
 * odrzucał operację (`if (!key) continue;`) - zatwierdzony wpis nigdy się nie zapisywał.
 *
 * Fix: zapis ma trafić tam, gdzie pokazuje etykieta - brak/nieznana sekcja -> 'user'.
 * Czysty plik (zero `obsidian`/DOM): `SaveSessionModal.ts` nie wstaje w AVA.
 */
import test from 'ava';

import { naTerazLabel, normalizeNaTerazSection } from './naTerazUpdate.js';

test('normalizeNaTerazSection: brak/pusta/nieznana sekcja -> user', t => {
    t.is(normalizeNaTerazSection(undefined), 'user');
    t.is(normalizeNaTerazSection(null), 'user');
    t.is(normalizeNaTerazSection(''), 'user');
    // Dokładnie ten fallback, który powodował cichy drop w BUG-u wyżej.
    t.is(normalizeNaTerazSection('## Bieżące'), 'user');
    t.is(normalizeNaTerazSection('coś zupełnie nieznanego'), 'user');
});

test('normalizeNaTerazSection: rozpoznane warianty "environment" -> environment', t => {
    t.is(normalizeNaTerazSection('environment'), 'environment');
    t.is(normalizeNaTerazSection('Środowisko'), 'environment');
});

test('normalizeNaTerazSection: rozpoznane warianty "user" -> user', t => {
    t.is(normalizeNaTerazSection('user'), 'user');
    t.is(normalizeNaTerazSection('User'), 'user');
});

test('naTerazLabel i normalizeNaTerazSection zgadzają się co do tego, gdzie wpis trafi', t => {
    const inputs: Array<string | undefined | null> = [
        undefined, null, '', '## Bieżące', 'user', 'User', 'environment', 'Środowisko', 'bogus',
    ];
    for (const section of inputs) {
        const key = normalizeNaTerazSection(section);
        const label = naTerazLabel(section);
        const labelSaysEnv = /environment|środowisko/i.test(label);
        t.is(
            key === 'environment',
            labelSaysEnv,
            `rozjazd dla section=${JSON.stringify(section)}: klucz="${key}", etykieta="${label}"`,
        );
    }
});
