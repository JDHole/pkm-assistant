/**
 * Rejestr nagłówków brain.md w OBU językach (`brainSections.ts`) - kontrakt „rodzi się w
 * języku UI i zostaje w nim na zawsze" (decyzja właściciela 19.09) stoi na tych funkcjach.
 * Testy językowe (`uiBrainLocale`) są `serial` i wracają do `'en'` - `getLocale()` czyta stan
 * globalny modułu i18n.
 */
import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import {
    BRAIN_SECTION_HEADINGS,
    NA_TERAZ_HEADINGS,
    sectionHeading,
    naTerazHeading,
    sectionKeyOf,
    naTerazKeyOf,
    isNaTerazHeading,
    detectBrainLocale,
    resolveBrainLocale,
    uiBrainLocale,
    NOTE_TYPE_TO_SECTION_KEY,
} from './brainSections.js';
import type { BrainSectionKey, NaTerazKey } from './brainSections.js';

const SECTION_KEYS: BrainSectionKey[] = ['current', 'user', 'preferences', 'workflow', 'projects'];
const NA_TERAZ_KEYS: NaTerazKey[] = ['user', 'environment'];

// ─── sectionHeading / naTerazHeading (pisarz) ───

test('sectionHeading zwraca właściwy nagłówek dla każdego klucza i języka', t => {
    t.is(sectionHeading('current', 'pl'), '## Bieżące');
    t.is(sectionHeading('current', 'en'), '## Current');
    t.is(sectionHeading('user', 'pl'), '## User');
    t.is(sectionHeading('user', 'en'), '## User');
    t.is(sectionHeading('preferences', 'pl'), '## Preferencje');
    t.is(sectionHeading('preferences', 'en'), '## Preferences');
    t.is(sectionHeading('workflow', 'pl'), '## Workflow');
    t.is(sectionHeading('workflow', 'en'), '## Workflow');
    t.is(sectionHeading('projects', 'pl'), '## Projekty i referencje');
    t.is(sectionHeading('projects', 'en'), '## Projects and references');
});

test('naTerazHeading zwraca właściwy nagłówek „Na teraz"/„Right now" dla każdego klucza i języka', t => {
    t.is(naTerazHeading('user', 'pl'), '## Na teraz: User');
    t.is(naTerazHeading('user', 'en'), '## Right now: User');
    t.is(naTerazHeading('environment', 'pl'), '## Na teraz: Środowisko');
    t.is(naTerazHeading('environment', 'en'), '## Right now: Environment');
});

// ─── sectionKeyOf (czytnik, dokładne dopasowanie, OBA języki) ───

test('sectionKeyOf rozpoznaje dokładnie wszystkie 10 nagłówków (5 kluczy × 2 języki)', t => {
    for (const key of SECTION_KEYS) {
        t.is(sectionKeyOf(BRAIN_SECTION_HEADINGS.pl[key]), key, `PL ${BRAIN_SECTION_HEADINGS.pl[key]}`);
        t.is(sectionKeyOf(BRAIN_SECTION_HEADINGS.en[key]), key, `EN ${BRAIN_SECTION_HEADINGS.en[key]}`);
    }
});

test('sectionKeyOf przycina whitespace, ale wymaga dokładnego tekstu poza tym', t => {
    t.is(sectionKeyOf('  ## Bieżące  '), 'current');
    t.is(sectionKeyOf('## bieżące'), null, 'wielkość liter ma znaczenie (jak dotąd dla sekcji indeksu)');
    t.is(sectionKeyOf('## AKTYWNY TEST'), null);
    t.is(sectionKeyOf(''), null);
    t.is(sectionKeyOf(undefined), null);
    t.is(sectionKeyOf(null), null);
});

// ─── naTerazKeyOf (czytnik „Na teraz"/„Right now", OBA języki, wymaga dwukropka + klucza) ───

test('naTerazKeyOf rozpoznaje nagłówki „Na teraz" (PL) i „Right now" (EN)', t => {
    t.is(naTerazKeyOf('## Na teraz: User'), 'user');
    t.is(naTerazKeyOf('## Na teraz: Środowisko'), 'environment');
    t.is(naTerazKeyOf('## Right now: User'), 'user');
    t.is(naTerazKeyOf('## Right now: Environment'), 'environment');
});

test('naTerazKeyOf jest case-insensitive na słowie klucza i etykiecie sekcji', t => {
    t.is(naTerazKeyOf('## na teraz: środowisko'), 'environment');
    t.is(naTerazKeyOf('## RIGHT NOW: USER'), 'user');
});

test('naTerazKeyOf NIE łapie ręcznej sekcji usera bez dwukropka i rozpoznanego klucza', t => {
    t.is(naTerazKeyOf('## Na teraz coś tam'), null, 'brak dwukropka + klucza = zwykła sekcja obca, nie „Na teraz"');
    t.is(naTerazKeyOf('## Right now what I do'), null, 'to samo po angielsku');
    t.is(naTerazKeyOf('## Na teraz'), null, 'sam nagłówek bez dwukropka i klucza');
    t.is(naTerazKeyOf('## User'), null);
    t.is(naTerazKeyOf(''), null);
});

// Recenzja niezależna (item 7): main (przed rejestrem bilingwalnym) rozpoznawał "Na teraz" przez
// dopasowanie fuzzy niezależne od separatora i diakrytyków - separator myślnikiem/półpauzą i
// "Środowisko" bez ogonków muszą nadal trafiać do sekcji ZARZĄDZANEJ, nie stawać się foreign.
test('naTerazKeyOf rozpoznaje separator myślnikiem/pauzą/półpauzą, nie tylko dwukropek', t => {
    t.is(naTerazKeyOf('## Na teraz — User'), 'user', 'em dash');
    t.is(naTerazKeyOf('## Na teraz – Środowisko'), 'environment', 'en dash');
    t.is(naTerazKeyOf('## Na teraz - User'), 'user', 'zwykły myślnik');
    t.is(naTerazKeyOf('## Right now — User'), 'user', 'to samo po angielsku');
});

test('naTerazKeyOf rozpoznaje "Srodowisko" BEZ ogonków (stare/ręcznie edytowane pliki)', t => {
    t.is(naTerazKeyOf('## Na teraz: Srodowisko'), 'environment');
    t.is(naTerazKeyOf('## Na teraz Srodowisko'), 'environment', 'separator całkiem opcjonalny');
});

test('naTerazKeyOf: mimo poszerzenia, „## Na teraz coś tam" (dash + śmieć zamiast klucza) nadal wraca null', t => {
    t.is(naTerazKeyOf('## Na teraz - coś zupełnie innego'), null);
    t.is(naTerazKeyOf('## Right now - something else'), null);
});

test('isNaTerazHeading = naTerazKeyOf(line) !== null, w obu językach', t => {
    t.true(isNaTerazHeading('## Na teraz: User'));
    t.true(isNaTerazHeading('## Right now: Environment'));
    t.false(isNaTerazHeading('## Na teraz coś tam'), 'bez dwukropka+klucza NIE jest zarządzaną sekcją Na teraz');
    t.false(isNaTerazHeading('## User'));
    t.false(isNaTerazHeading(''));
});

// ─── detectBrainLocale (pierwszy nagłówek SWOISTY rozstrzyga; wspólne nie rozstrzygają) ───

test('detectBrainLocale: plik PL (nagłówek swoisty) -> "pl"', t => {
    const content = '# X brain\n\n## Bieżące\n\n## User\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n';
    t.is(detectBrainLocale(content), 'pl');
});

test('detectBrainLocale: plik EN (nagłówek swoisty) -> "en"', t => {
    const content = '# X brain\n\n## Current\n\n## User\n\n## Preferences\n\n## Workflow\n\n## Projects and references\n';
    t.is(detectBrainLocale(content), 'en');
});

test('detectBrainLocale: tylko nagłówki WSPÓLNE (## User / ## Workflow) -> null (nie rozstrzygają same)', t => {
    t.is(detectBrainLocale('# X brain\n\n## User\n\n## Workflow\n'), null);
});

test('detectBrainLocale: brak treści -> null', t => {
    t.is(detectBrainLocale(''), null);
    t.is(detectBrainLocale(null), null);
    t.is(detectBrainLocale(undefined), null);
});

test('detectBrainLocale: pierwszy napotkany nagłówek swoisty rozstrzyga (kolejność w pliku)', t => {
    // „## Preferences" (EN) występuje PRZED „## Bieżące" (PL) w tym (celowo sztucznym) pliku.
    const mixed = '# X brain\n\n## Preferences\n\n## Bieżące\n';
    t.is(detectBrainLocale(mixed), 'en', 'pierwszy napotkany nagłówek swoisty (EN) wygrywa');
});

test('detectBrainLocale: „## Preferencje" BEZ „## Bieżące" nadal rozstrzyga -> "pl" (regresja recenzji niezależnej)', t => {
    const content = '# X brain\n\n## Preferencje\n\n## User\n';
    t.is(detectBrainLocale(content), 'pl');
});

test('detectBrainLocale: „## Ustalenia" (historyczny nagłówek v1/v2, bez żadnego innego sygnału) -> "pl"', t => {
    // Druga warstwa obrony obok hardkodowanego locale='pl' w MigrationV3 (patrz jego CLAUDE.md/
    // komentarz) - plik v2 z SAMĄ sekcją "Ustalenia" (bez "Bieżące") nie ma inaczej żadnego
    // nagłówka swoistego i detectBrainLocale zwróciłby null -> uiBrainLocale() (mogło być EN).
    const content = '# X brain\n\n## User\n\n## Ustalenia\n- fakt\n';
    t.is(detectBrainLocale(content), 'pl');
});

// ─── resolveBrainLocale / uiBrainLocale (most między locale pliku a UI) ───

test('resolveBrainLocale: treść rozstrzyga, gdy da się wykryć', t => {
    t.is(resolveBrainLocale('## Bieżące', 'en'), 'pl', 'istniejący PL plik zostaje PL, nawet pod EN UI');
    t.is(resolveBrainLocale('## Current', 'pl'), 'en', 'istniejący EN plik zostaje EN, nawet pod PL UI');
});

test('resolveBrainLocale: brak treści / treść nierozstrzygająca -> UI locale', t => {
    t.is(resolveBrainLocale(null, 'en'), 'en');
    t.is(resolveBrainLocale(null, 'pl'), 'pl');
    t.is(resolveBrainLocale('## User', 'en'), 'en', 'sam wspólny nagłówek nie rozstrzyga -> spada na UI');
});

test.serial('uiBrainLocale odzwierciedla getLocale(), nieznane/inne -> "en"', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    t.is(uiBrainLocale(), 'pl');
    setLocale('en');
    t.is(uiBrainLocale(), 'en');
});

// ─── NOTE_TYPE_TO_SECTION_KEY (mapa typ notatki -> klucz sekcji, język-niezależna) ───

test('NOTE_TYPE_TO_SECTION_KEY: każdy typ notatki wskazuje istniejący klucz sekcji', t => {
    for (const [type, key] of Object.entries(NOTE_TYPE_TO_SECTION_KEY)) {
        t.true(SECTION_KEYS.includes(key), `typ "${type}" wskazuje nieznany klucz "${key}"`);
    }
    t.is(NOTE_TYPE_TO_SECTION_KEY.user, 'user');
    t.is(NOTE_TYPE_TO_SECTION_KEY.agent_rule, 'preferences');
    t.is(NOTE_TYPE_TO_SECTION_KEY.skill_hint, 'workflow');
    t.is(NOTE_TYPE_TO_SECTION_KEY.project_context, 'projects');
    t.is(NOTE_TYPE_TO_SECTION_KEY.reference, 'projects');
});

// ─── Rejestr sam ze sobą: nagłówki „Na teraz" nigdy nie kolidują z nagłówkami indeksu ───

test('rejestr: żaden nagłówek „Na teraz"/„Right now" nie pokrywa się z nagłówkiem indeksu (w żadnym z dwóch języków)', t => {
    const indexHeadings = new Set(SECTION_KEYS.flatMap(key => [BRAIN_SECTION_HEADINGS.pl[key], BRAIN_SECTION_HEADINGS.en[key]]));
    for (const key of NA_TERAZ_KEYS) {
        t.false(indexHeadings.has(NA_TERAZ_HEADINGS.pl[key]));
        t.false(indexHeadings.has(NA_TERAZ_HEADINGS.en[key]));
    }
});
