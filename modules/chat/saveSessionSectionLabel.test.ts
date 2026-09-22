import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { sectionDisplayLabel, noteDisplayName } from './saveSessionSectionLabel.js';

// Okno review `/save session` pokazywało adres sekcji brain.md wprost, więc user z angielskim
// interfejsem widział `→ ## Bieżące`. Adres w pliku zostaje polski (parsery), etykieta w oknie
// idzie za językiem interfejsu.
test.serial('angielski interfejs: adresy sekcji brain.md dostają angielskie etykiety', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(sectionDisplayLabel('## Bieżące'), 'Current');
    t.is(sectionDisplayLabel('## User'), 'User');
    t.is(sectionDisplayLabel('## Preferencje'), 'Preferences');
    t.is(sectionDisplayLabel('## Workflow'), 'Workflow');
    t.is(sectionDisplayLabel('## Projekty i referencje'), 'Projects and references');
});

test.serial('polski interfejs: te same adresy dostają polskie etykiety, bez krzyżyków', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    t.is(sectionDisplayLabel('## Bieżące'), 'Bieżące');
    t.is(sectionDisplayLabel('## Preferencje'), 'Preferencje');
    t.is(sectionDisplayLabel('## Projekty i referencje'), 'Projekty i referencje');
});

// Agent z brain.md w EN (decyzja właściciela 19.09 - plik rodzi się w języku UI i zostaje w nim
// na zawsze) niesie adresy EN ('## Current', ...) - okno review MUSI je rozpoznać tak samo jak
// adresy PL i pokazać etykietę w BIEŻĄCYM języku interfejsu, niezależnie od języka pliku.
test.serial('agent z brain.md w EN: adresy angielskie dostają etykietę w języku interfejsu (PL)', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    t.is(sectionDisplayLabel('## Current'), 'Bieżące');
    t.is(sectionDisplayLabel('## User'), 'User');
    t.is(sectionDisplayLabel('## Preferences'), 'Preferencje');
    t.is(sectionDisplayLabel('## Workflow'), 'Workflow');
    t.is(sectionDisplayLabel('## Projects and references'), 'Projekty i referencje');
});

test.serial('agent z brain.md w EN pod angielskim interfejsem: etykieta angielska jak dotąd', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(sectionDisplayLabel('## Current'), 'Current');
    t.is(sectionDisplayLabel('## Projects and references'), 'Projects and references');
});

test.serial('brak sekcji od modelu = etykieta sekcji bieżącej (tam realnie ląduje notatka)', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(sectionDisplayLabel(undefined), 'Current');
    t.is(sectionDisplayLabel('   '), 'Current');
});

test.serial('nieznany adres pokazuje się dosłownie, nie pod cudzą etykietą', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(sectionDisplayLabel('## AKTYWNY TEST'), 'AKTYWNY TEST');
    t.is(sectionDisplayLabel('  ## AKTYWNY TEST '), 'AKTYWNY TEST');
});

test.serial('nazwa notatki: podana zostaje, pusta dostaje zastępczą w języku interfejsu', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    t.is(noteDisplayName('user_prefers_short_answers'), 'user_prefers_short_answers');
    t.is(noteDisplayName(''), 'Note');
    setLocale('pl');
    t.is(noteDisplayName(undefined), 'Notatka');
});
