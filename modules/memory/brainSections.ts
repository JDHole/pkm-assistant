/**
 * Rejestr nagłówków `brain.md` per JĘZYK PLIKU - jedyne źródło prawdy dla OBU zestawów
 * (PL/EN) nagłówków sekcji indeksu i sekcji „Na teraz" / „Right now".
 *
 * KONTRAKT (decyzja właściciela 19.09): `brain.md` nowego agenta RODZI SIĘ w języku
 * interfejsu (PL albo EN) i zostaje w nim NA ZAWSZE - istniejących plików nigdy nie
 * migrujemy. Wariant „nagłówki za językiem UI na żywo" jest ODRZUCONY. Pisarz
 * (`BrainIndex.buildBrainIndex`) emituje WYŁĄCZNIE zestaw pasujący do wykrytego/wybranego
 * `BrainLocale`; parsery (`BrainIndex.ts`, `MigrationV3.ts`) i prompty robocze
 * (`workPrompts.ts`) znają OBA zestawy jednocześnie.
 *
 * `BrainLocale` (język PLIKU) NIE jest tym samym co `getLocale()` (język interfejsu na
 * żywo) - `uiBrainLocale()` niżej jest jedynym mostem między nimi, wołanym wyłącznie dla
 * NOWEGO pliku albo jako fallback, gdy detekcja z istniejącej treści zawiedzie.
 *
 * Czysty plik (jedyny import to `core/i18n` po `getLocale()`) - node-safe, zero DOM/obsidian.
 */
import { getLocale } from '../../core/i18n/index.js';

/** Język PLIKU `brain.md` - nie mylić z językiem interfejsu na żywo (`getLocale()`). */
export type BrainLocale = 'pl' | 'en';

/** Klucz kategorii indeksu `brain.md` (patrz `BRAIN_SECTION_HEADINGS` niżej). */
export type BrainSectionKey = 'current' | 'user' | 'preferences' | 'workflow' | 'projects';

/** Klucz sekcji „Na teraz" / „Right now" (pamięć krótkoterminowa `brain.md`). */
export type NaTerazKey = 'user' | 'environment';

const SECTION_KEYS: readonly BrainSectionKey[] = ['current', 'user', 'preferences', 'workflow', 'projects'];
const NA_TERAZ_KEYS: readonly NaTerazKey[] = ['user', 'environment'];
const BRAIN_LOCALES: readonly BrainLocale[] = ['pl', 'en'];

/** Nagłówki H2 sekcji indeksu, per klucz i JĘZYK PLIKU. Adresy w pliku, nie proza. */
export const BRAIN_SECTION_HEADINGS: Readonly<Record<BrainLocale, Readonly<Record<BrainSectionKey, string>>>> = {
    pl: {
        current: '## Bieżące',
        user: '## User',
        preferences: '## Preferencje',
        workflow: '## Workflow',
        projects: '## Projekty i referencje',
    },
    en: {
        current: '## Current',
        user: '## User',
        preferences: '## Preferences',
        workflow: '## Workflow',
        projects: '## Projects and references',
    },
};

/** Nagłówki H2 sekcji „Na teraz" / „Right now", per klucz i JĘZYK PLIKU. */
export const NA_TERAZ_HEADINGS: Readonly<Record<BrainLocale, Readonly<Record<NaTerazKey, string>>>> = {
    pl: {
        user: '## Na teraz: User',
        environment: '## Na teraz: Środowisko',
    },
    en: {
        user: '## Right now: User',
        environment: '## Right now: Environment',
    },
};

/** Mapa typu notatki → klucz sekcji indeksu. Język-niezależna - nagłówek dochodzi przez `sectionHeading`. */
export const NOTE_TYPE_TO_SECTION_KEY: Readonly<Record<string, BrainSectionKey>> = {
    user: 'user',
    agent_rule: 'preferences',
    skill_hint: 'workflow',
    project_context: 'projects',
    reference: 'projects',
};

/** Nagłówek indeksu danej kategorii, w podanym języku PLIKU. */
export function sectionHeading(key: BrainSectionKey, locale: BrainLocale): string {
    return BRAIN_SECTION_HEADINGS[locale][key];
}

/** Nagłówek „Na teraz"/„Right now" danej kategorii, w podanym języku PLIKU. */
export function naTerazHeading(key: NaTerazKey, locale: BrainLocale): string {
    return NA_TERAZ_HEADINGS[locale][key];
}

/** Dokładne dopasowanie (po trim) nagłówka indeksu w OBU językach → klucz kategorii, albo `null`. */
export function sectionKeyOf(line: string | null | undefined): BrainSectionKey | null {
    const trimmed = (line ?? '').trim();
    for (const key of SECTION_KEYS) {
        if (BRAIN_SECTION_HEADINGS.pl[key] === trimmed || BRAIN_SECTION_HEADINGS.en[key] === trimmed) return key;
    }
    return null;
}

// PL łagodniejszy niż EN - odzwierciedla ŁAGODNOŚĆ, jaką na main (przed rejestrem
// bilingwalnym) miał `naTerazSectionKey` (dopasowanie fuzzy po słowie, niezależne od
// separatora i diakrytyków): separator między "Na teraz" a słowem kluczowym jest OPCJONALNY
// i dopuszcza dwukropek/myślnik/półpauzę/pauzę (`## Na teraz — User`), a "Środowisko" jest
// rozpoznawane też BEZ ogonków (`## Na teraz: Srodowisko`) - realne stare pliki (recznie
// edytowane, sprzed tego rejestru) miewały oba warianty. Kotwica `$` na końcu (po opcjonalnym
// whitespace) zostaje w OBU językach - to WCIĄŻ nie łapie ręcznej sekcji usera typu
// „## Na teraz coś tam" (bez rozpoznanego słowa kluczowego zaraz po separatorze).
const NA_TERAZ_KEY_RE: Readonly<Record<BrainLocale, RegExp>> = {
    pl: /^##\s+na teraz\s*[:\-–—]?\s*(user|środowisko|srodowisko)\s*$/i,
    en: /^##\s+right now\s*[:\-–—]?\s*(user|environment)\s*$/i,
};

/**
 * Nagłówek „Na teraz"/„Right now" w OBU językach → klucz, albo `null`. Regex wymaga
 * rozpoznanego słowa klucza zaraz po „Na teraz"/„Right now" (separator opcjonalny, patrz
 * komentarz przy `NA_TERAZ_KEY_RE`) - ręcznie dopisana sekcja usera typu „## Na teraz coś tam"
 * (bez rozpoznanego słowa klucza) NIE jest łapana: taka sekcja jest zwykłą sekcją obcą
 * (`BrainIndex.parseForeignSections`), nie zarządzaną zawartością „Na teraz".
 */
export function naTerazKeyOf(line: string | null | undefined): NaTerazKey | null {
    const trimmed = (line ?? '').trim();
    const pl = NA_TERAZ_KEY_RE.pl.exec(trimmed);
    if (pl) return pl[1].toLowerCase() === 'user' ? 'user' : 'environment';
    const en = NA_TERAZ_KEY_RE.en.exec(trimmed);
    if (en) return en[1].toLowerCase() === 'user' ? 'user' : 'environment';
    return null;
}

/** Czy ta (przycięta) linia otwiera sekcję „Na teraz"/„Right now" w KTÓRYMKOLWIEK języku. */
export function isNaTerazHeading(line: string | null | undefined): boolean {
    return naTerazKeyOf(line) !== null;
}

/**
 * PL/EN nagłówki SWOISTE dla danego języka (rozstrzygają `detectBrainLocale`) - `## User`/
 * `## Workflow` są wspólne i celowo pominięte. `## Ustalenia` dołączony do PL jako DRUGA
 * warstwa obrony obok hardkodowanego `locale:'pl'` w `MigrationV3` (patrz tam) - to
 * WYŁĄCZNIE historyczny nagłówek v1/v2 (nigdy nie był żywym nagłówkiem indeksu w żadnym z
 * dwóch bilingwalnych zestawów), ale plik v2 zawierający SAMO `## Ustalenia` (bez `##
 * Bieżące`/innego nagłówka swoistego) miałby inaczej `detectBrainLocale === null` i
 * spadałby na `uiBrainLocale()` - migrując polską treść pod nagłówki EN, gdyby UI było
 * akurat angielskie w chwili migracji.
 */
const LOCALE_SPECIFIC_HEADINGS: Readonly<Record<BrainLocale, ReadonlySet<string>>> = {
    pl: new Set([
        BRAIN_SECTION_HEADINGS.pl.current,
        BRAIN_SECTION_HEADINGS.pl.preferences,
        BRAIN_SECTION_HEADINGS.pl.projects,
        NA_TERAZ_HEADINGS.pl.user,
        NA_TERAZ_HEADINGS.pl.environment,
        '## Ustalenia',
    ]),
    en: new Set([
        BRAIN_SECTION_HEADINGS.en.current,
        BRAIN_SECTION_HEADINGS.en.preferences,
        BRAIN_SECTION_HEADINGS.en.projects,
        NA_TERAZ_HEADINGS.en.user,
        NA_TERAZ_HEADINGS.en.environment,
    ]),
};

/**
 * Wykryj język PLIKU z jego treści: pierwszy napotkany nagłówek SWOISTY dla języka
 * rozstrzyga (kolejność w pliku, od góry). Nagłówki wspólne (`## User`, `## Workflow`) nie
 * rozstrzygają same - brak żadnego swoistego nagłówka (plik pusty, sam szkielet wspólnych
 * nagłówków, albo brak treści) daje `null`.
 */
export function detectBrainLocale(content: string | null | undefined): BrainLocale | null {
    if (!content) return null;
    for (const rawLine of String(content).split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('##')) continue;
        if (LOCALE_SPECIFIC_HEADINGS.pl.has(trimmed)) return 'pl';
        if (LOCALE_SPECIFIC_HEADINGS.en.has(trimmed)) return 'en';
    }
    return null;
}

/**
 * Język, w którym ma być (prze)zapisany `brain.md`: wykryty z ISTNIEJĄCEJ treści, a gdy
 * treść nie rozstrzyga (nowy plik, `content: null`, albo sam szkielet wspólnych nagłówków) -
 * `uiLocale` (język interfejsu w chwili tworzenia). Raz wykryty język pliku NIGDY nie jest
 * nadpisywany bieżącym językiem UI - to jest sedno kontraktu „rodzi się i zostaje".
 */
export function resolveBrainLocale(content: string | null | undefined, uiLocale: BrainLocale): BrainLocale {
    return detectBrainLocale(content) ?? uiLocale;
}

/** Język interfejsu na żywo (`core/i18n`), zwężony do `BrainLocale` - `'pl'` albo `'en'`, nigdy nic innego. */
export function uiBrainLocale(): BrainLocale {
    return getLocale() === 'pl' ? 'pl' : 'en';
}

// Eksport uporządkowanych list kluczy — wołane przez `BrainIndex.ts` (kolejność emisji sekcji)
// i `MigrationV3.ts` (korroboracja `looksLikeV3Index`), żeby kolejność żyła w JEDNYM miejscu.
export { SECTION_KEYS as BRAIN_SECTION_KEYS, NA_TERAZ_KEYS, BRAIN_LOCALES };
