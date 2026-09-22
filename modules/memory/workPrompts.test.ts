/**
 * `DEFAULT_BRIEF_PROMPT` był fabrycznym tekstem dla slotu promptu `brief_prompt`, którego
 * wartości nic w produkcji nie czytało (dawny konsument, `ContextSessionGenerator`, skasowany).
 * Slot wycięty razem z konsumentem: z `workPrompts.ts` (ta stała), z barrela (`index.ts`) i z
 * listy kluczy resolvera (`core/utils/workPromptResolver.ts` `WORK_PROMPT_KEYS`).
 *
 * `workPrompts.ts` i `modules/memory/index.ts` są node-safe (zero importu `obsidian` — patrz
 * `core/CLAUDE.md` sekcja „Zależności"), więc ten test importuje je BEZPOŚREDNIO zamiast
 * czytać źródło regexem.
 *
 * Od 2.2.5 prompty fabryczne mają wersję PL i EN, a stałe `DEFAULT_*_PROMPT` zastąpiła funkcja
 * `factoryWorkPrompt(kind, locale?)`. Testy językowe są `serial` i wracają do `'en'` — locale
 * jest stanem globalnym modułu i18n.
 */
import test from 'ava';
import * as workPrompts from './workPrompts.js';
import * as memoryBarrel from './index.js';
import { factoryWorkPrompt } from './workPrompts.js';
import type { WorkPromptKind } from './workPrompts.js';
import { resolveWorkPrompt } from '../../core/index.js';
import { setLocale } from '../../core/i18n/index.js';

/** Wszystkie `{{TOKENY}}` z tekstu, posortowane — kontrakt dla wołaczy podstawiających dane. */
function placeholders(text: string): string[] {
    return [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))].sort();
}

test('workPrompts.ts nie eksportuje już DEFAULT_BRIEF_PROMPT', t => {
    t.false('DEFAULT_BRIEF_PROMPT' in workPrompts);
});

test('barrel modules/memory/index.ts nie re-eksportuje DEFAULT_BRIEF_PROMPT', t => {
    t.false('DEFAULT_BRIEF_PROMPT' in memoryBarrel);
});

test('stałe DEFAULT_*_PROMPT zniknęły — zostaje jedno wejście `factoryWorkPrompt`', t => {
    // Stała nie umie być leniwa, a `setLocale()` leci PO imporcie modułów: gdyby ktoś ją
    // przywrócił, angielski user dostałby zamrożony polski tekst (albo odwrotnie).
    for (const dead of ['DEFAULT_SAVE_SESSION_PROMPT', 'DEFAULT_ARCHIVE_PROMPT', 'DEFAULT_SUMMARY_PROMPT']) {
        t.false(dead in workPrompts, `${dead} nie powinno wrócić do workPrompts.ts`);
        t.false(dead in memoryBarrel, `${dead} nie powinno wrócić do barrela`);
    }
    t.is(typeof memoryBarrel.factoryWorkPrompt, 'function');
});

test('factoryWorkPrompt oddaje trzy żywe prompty w obu językach', t => {
    for (const kind of ['save_session', 'archive', 'summary'] as WorkPromptKind[]) {
        for (const locale of ['pl', 'en']) {
            const text = factoryWorkPrompt(kind, locale);
            t.is(typeof text, 'string');
            t.true(text.length > 500, `${kind}/${locale} wygląda na obcięty (${text.length} zn.)`);
        }
        t.not(factoryWorkPrompt(kind, 'pl'), factoryWorkPrompt(kind, 'en'), `${kind}: PL i EN to ten sam tekst?`);
    }
    // Nieznany kod języka = angielski, dokładnie jak `t()` w core/i18n.
    t.is(factoryWorkPrompt('archive', 'de'), factoryWorkPrompt('archive', 'en'));
});

// ── kontrakt placeholderów: {{...}} identyczne w obu językach ──────────────
//
// Wołacz podstawia dane po nazwie tokenu (`ArchiveWorkflow._summaryFromFiles` robi
// `.replace(/\{\{LEVEL\}\}/g, level)`). Token zgubiony w tłumaczeniu = prompt, w którym model
// nigdy nie dowiaduje się, jaki poziom ma streścić. Lista jest LITERALNA, nie liczona z tekstu.

test('save_session: zero placeholderów w obu językach', t => {
    t.deepEqual(placeholders(factoryWorkPrompt('save_session', 'pl')), []);
    t.deepEqual(placeholders(factoryWorkPrompt('save_session', 'en')), []);
});

test('archive: zero placeholderów w obu językach', t => {
    t.deepEqual(placeholders(factoryWorkPrompt('archive', 'pl')), []);
    t.deepEqual(placeholders(factoryWorkPrompt('archive', 'en')), []);
});

test('summary: dokładnie {{LEVEL}} w obu językach', t => {
    t.deepEqual(placeholders(factoryWorkPrompt('summary', 'pl')), ['LEVEL']);
    t.deepEqual(placeholders(factoryWorkPrompt('summary', 'en')), ['LEVEL']);
});

// ── ADRESY, które idą za JĘZYKIEM PLIKU brain.md - NIE za językiem prozy promptu ───────────
//
// Od decyzji właściciela 19.09: brain.md rodzi się w języku UI i zostaje w nim NA ZAWSZE, więc
// nagłówki w treści promptu `save_session` muszą pokazywać model NAPRAWDĘ istniejące w PLIKU
// TEGO agenta nagłówki - niezależnie od tego, w jakim języku jest sama proza instrukcji.
// `factoryWorkPrompt(kind, locale, brainLocale)` rozdziela te dwa wymiary.

test('EN proza + EN brainLocale -> nagłówki angielskie w treści promptu', t => {
    const en = factoryWorkPrompt('save_session', 'en', 'en');
    for (const heading of ['## Current', '## User', '## Preferences', '## Workflow', '## Projects and references']) {
        t.true(en.includes(heading), `brak ${heading} w EN save_session/EN brainLocale`);
    }
    t.true(en.includes('„Right now: User"'));
    t.true(en.includes('„Right now: Environment"'));
    for (const plHeading of ['## Bieżące', '## Preferencje', '## Projekty i referencje', 'Na teraz: User', 'Na teraz: Środowisko']) {
        t.false(en.includes(plHeading), `PL nagłówek ${plHeading} nie powinien wyciec do EN/EN`);
    }
});

test('EN proza + PL brainLocale -> nagłówki polskie w treści promptu (plik TEGO agenta jest PL)', t => {
    const en = factoryWorkPrompt('save_session', 'en', 'pl');
    for (const heading of ['## Bieżące', '## User', '## Preferencje', '## Workflow', '## Projekty i referencje']) {
        t.true(en.includes(heading), `brak ${heading} w EN save_session/PL brainLocale`);
    }
    t.true(en.includes('„Na teraz: User"'));
    t.true(en.includes('„Na teraz: Środowisko"'));
    t.false(en.includes('## Current'), 'EN nagłówek nie powinien wyciec, gdy brainLocale to PL');
});

test('PL proza + PL brainLocale -> nagłówki polskie (dotychczasowe zachowanie)', t => {
    const pl = factoryWorkPrompt('save_session', 'pl', 'pl');
    for (const heading of ['## Bieżące', '## User', '## Preferencje', '## Workflow', '## Projekty i referencje']) {
        t.true(pl.includes(heading), `brak ${heading} w PL save_session/PL brainLocale`);
    }
    t.true(pl.includes('„Na teraz: User"'));
    t.true(pl.includes('„Na teraz: Środowisko"'));
});

test('strażnik: żaden fabryczny prompt save_session nie niesie już nagłówka na sztywno', t => {
    // Kontrola przeciwna do testów wyżej: gdyby ktoś wrócił do wpisania nagłówka literałem
    // zamiast placeholdera, ta sama proza z PRZECIWNYM brainLocale niosłaby OBA nagłówki
    // naraz (stary literał + nowo podstawiony) - test wyżej by tego nie złapał, bo assercja
    // tylko POTWIERDZA obecność oczekiwanego nagłówka, nie ZAPRZECZA drugiemu.
    const plProzaEnBrain = factoryWorkPrompt('save_session', 'pl', 'en');
    t.false(plProzaEnBrain.includes('## Bieżące'), 'PL proza nie powinna nieść PL nagłówka na sztywno, gdy brainLocale to EN');
    t.true(plProzaEnBrain.includes('## Current'));

    const enProzaPlBrain = factoryWorkPrompt('save_session', 'en', 'pl');
    t.false(enProzaPlBrain.includes('## Current'), 'EN proza nie powinna nieść EN nagłówka na sztywno, gdy brainLocale to PL');
    t.true(enProzaPlBrain.includes('## Bieżące'));
});

test('kontrakt JSON jest ten sam w obu językach', t => {
    for (const locale of ['pl', 'en']) {
        const save = factoryWorkPrompt('save_session', locale);
        for (const key of ['"brain_updates"', '"new_notes"', '"na_teraz"', 'how_to_apply']) {
            t.true(save.includes(key), `save_session/${locale}: brak ${key}`);
        }
        const archive = factoryWorkPrompt('archive', locale);
        for (const key of ['"merges"', '"deletions"', 'target_name', 'merged_content', 'lessons_extracted']) {
            t.true(archive.includes(key), `archive/${locale}: brak ${key}`);
        }
    }
});

// ── łańcuch resolvera agent > global > factory ─────────────────────────────

test.serial('bez override resolver oddaje fabrykę W JĘZYKU INTERFEJSU', t => {
    t.teardown(() => setLocale('en'));

    setLocale('en');
    const enText = resolveWorkPrompt(null, 'save_session_prompt', null, factoryWorkPrompt('save_session'));
    t.true(enText.startsWith('You are analysing a conversation transcript'), enText.slice(0, 60));

    setLocale('pl');
    const plText = resolveWorkPrompt(null, 'save_session_prompt', null, factoryWorkPrompt('save_session'));
    t.true(plText.startsWith('Analizujesz transcript rozmowy'), plText.slice(0, 60));

    t.not(enText, plText);
});

test.serial('override agenta i globalny nadal wygrywają nad fabryką — w obu językach', t => {
    t.teardown(() => setLocale('en'));

    for (const locale of ['pl', 'en']) {
        setLocale(locale);
        const factory = factoryWorkPrompt('summary');

        const globalOnly = resolveWorkPrompt(null, 'summary_prompt',
            { pkmAssistant: { promptDefaults: { summary_prompt: 'GLOBALNY SZKIELET {{LEVEL}}' } } }, factory);
        t.is(globalOnly, 'GLOBALNY SZKIELET {{LEVEL}}', `${locale}: global bije fabrykę`);

        const agentWins = resolveWorkPrompt({ summary_prompt: 'AGENTOWY SZKIELET {{LEVEL}}' }, 'summary_prompt',
            { pkmAssistant: { promptDefaults: { summary_prompt: 'GLOBALNY SZKIELET {{LEVEL}}' } } }, factory);
        t.is(agentWins, 'AGENTOWY SZKIELET {{LEVEL}}', `${locale}: agent bije global`);

        // Pusty override = „nie ustawione" → fabryka, dalej w języku interfejsu.
        t.is(resolveWorkPrompt({ summary_prompt: '   ' }, 'summary_prompt', null, factory), factory);
    }
});
