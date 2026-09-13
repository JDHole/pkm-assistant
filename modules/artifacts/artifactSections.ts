/**
 * artifactSections — nazwy sekcji artefaktów wbudowanych, JEDNO źródło prawdy dla obu języków.
 *
 * Nagłówek sekcji artefaktu jest ADRESEM patcha (`set_section`/`add_item` trafiają po nazwie
 * nagłówka), więc ten sam napis muszą znać wszyscy, którzy go wypisują. Rozjazd
 * któregokolwiek = `not_found` przy patchu, czyli cicho pusta sekcja w notatce usera.
 *
 * Żywi konsumenci (stan na 2.2.5 - sprawdzone grepem, nie „planowane"):
 *  - `modules/tools/toolAliases.ts` - aliasy `plan_review` (`steps`) i `idea_review` (`content`);
 *  - `modules/prompts/decisionTree.ts` - `fillSectionNames()` wypełnia placeholdery
 *    (`{{user_notes}}` itd.) w regułach drzewa, także nadpisanych przez usera;
 *  - `modules/prompts/artifactIndex.ts` - nazwa chronionej sekcji w `prompt.dt.active_artifact`.
 *
 * Teksty fabryczne typów (`ArtifactTypeLoader`) są statyczne i NIE wołają `artifactSection()` -
 * ich nagłówki pilnuje test porównujący je z tym rejestrem (`ArtifactTypeLoader.test.ts`,
 * „nagłówki tekstów fabrycznych zgadzają się z rejestrem sekcji").
 *
 * ⚠️ Locale czytamy ZAWSZE w środku funkcji (domyślna wartość parametru liczy się przy
 * wywołaniu), nigdy na poziomie modułu: `setLocale()` leci w `src/main.ts` PO załadowaniu
 * modułów, więc stała policzona przy imporcie zamroziłaby angielski dla wszystkich.
 */
import { getLocale } from '../../core/i18n/index.js';

/**
 * Nazwy sekcji per język. Klucz (`goal`, `steps`, …) jest semantyczny i NIE wchodzi nigdzie
 * na dysk - na dysku ląduje wyłącznie wartość (nagłówek `## …` w szablonie typu).
 */
export const ARTIFACT_SECTION_NAMES = {
    pl: {
        goal: 'Cel',
        steps: 'Kroki',
        risks: 'Ryzyka i założenia',
        user_notes: 'Uwagi usera',
        content: 'Treść',
        tldr: 'TL;DR',
        findings: 'Ustalenia',
        blind_spots: 'Białe plamy',
        sources: 'Źródła',
    },
    en: {
        goal: 'Goal',
        steps: 'Steps',
        risks: 'Risks and assumptions',
        user_notes: 'User notes',
        content: 'Content',
        tldr: 'TL;DR',
        findings: 'Findings',
        blind_spots: 'Blind spots',
        sources: 'Sources',
    },
} as const;

/** Klucz semantyczny sekcji (ten sam zestaw w obu językach). */
export type ArtifactSectionKey = keyof typeof ARTIFACT_SECTION_NAMES.pl;

/**
 * Nazwa sekcji w podanym języku (domyślnie: bieżący język interfejsu).
 * Nieznany kod języka = angielski, dokładnie jak `t()` w `core/i18n`.
 */
export function artifactSection(key: ArtifactSectionKey, locale: string = getLocale()): string {
    return ARTIFACT_SECTION_NAMES[locale === 'pl' ? 'pl' : 'en'][key];
}
