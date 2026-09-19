/**
 * `normalizeNaTerazSection`/`naTerazLabel` - kontrakt sekcji `BrainUpdate` ("Na teraz").
 *
 * UTWARDZENIE KONTRAKTU, nie naprawa żywej utraty danych: stary fallback w
 * `SaveSessionModal._normalizeUpdate` (`'## Bieżące'`, nagłówek pliku `brain.md`) był
 * martwą gałęzią - jedyny producent `BrainUpdate`
 * (`modules/memory/SaveSessionWorkflow._parseNaTerazUpdates`) zawsze podaje `'user'` albo
 * `'environment'`. Naprawa robi fallback poprawnym na przyszłość (klucz API, nie nagłówek
 * pliku) i sprowadza etykietę + zapis do JEDNEJ funkcji - patrz nagłówek `naTerazUpdate.ts`.
 * Czysty plik (zero `obsidian`/DOM).
 */
import test from 'ava';

import { setLocale } from '../../core/i18n/index.js';
import { naTerazLabel, normalizeNaTerazSection } from './naTerazUpdate.js';

test('normalizeNaTerazSection: brak/pusta/nieznana sekcja -> user', t => {
    t.is(normalizeNaTerazSection(undefined), 'user');
    t.is(normalizeNaTerazSection(null), 'user');
    t.is(normalizeNaTerazSection(''), 'user');
    // Nagłówek pliku brain.md - dawny (martwy) fallback, teraz jawnie mapowany na 'user'.
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

test.serial('naTerazLabel: literalne teksty en', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    t.is(naTerazLabel(undefined), 'Right now: User');
    t.is(naTerazLabel('## Bieżące'), 'Right now: User');
    t.is(naTerazLabel('environment'), 'Right now: Environment');
    t.is(naTerazLabel('Środowisko'), 'Right now: Environment');
});

test.serial('naTerazLabel: literalne teksty pl', t => {
    setLocale('pl');
    t.teardown(() => setLocale('en'));

    t.is(naTerazLabel(undefined), 'Na teraz: User');
    t.is(naTerazLabel('## Bieżące'), 'Na teraz: User');
    t.is(naTerazLabel('environment'), 'Na teraz: Środowisko');
});
