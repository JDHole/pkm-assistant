/**
 * artifactSections — nazwy sekcji artefaktów wbudowanych, JEDNO źródło prawdy dla obu języków.
 *
 * Nagłówek sekcji artefaktu jest ADRESEM patcha (`set_section`/`add_item` trafiają po nazwie
 * nagłówka), więc ten sam napis musi znać: szablon typu seedowany na dysk
 * (`ArtifactTypeLoader`), alias `plan_review` w `modules/tools/toolAliases.ts` i reguła drzewa
 * decyzyjnego w `modules/prompts/decisionTree.ts`. Rozjazd któregokolwiek z nich = `not_found`
 * przy patchu, czyli cicho pusta sekcja w notatce usera.
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
