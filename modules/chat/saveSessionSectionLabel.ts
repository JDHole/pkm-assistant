/**
 * Etykieta sekcji brain.md DLA OCZU usera w oknie review `/save session`.
 *
 * Nagłówki sekcji brain.md (`## Bieżące`, `## Preferencje`...) to ADRESY: `BrainIndex.ts`,
 * parsery i prompty robocze rozpoznają je po dokładnym tekście, więc w pliku zostają takie same
 * w każdym języku interfejsu (`modules/memory/CLAUDE.md`). Okno review pokazywało ten adres
 * wprost, czyli anglojęzyczny user widział `→ ## Bieżące`. Tutaj adres dostaje nazwę w języku
 * interfejsu - do pliku dalej idzie adres, nie etykieta.
 *
 * Czysty plik (zero `obsidian`/DOM): `SaveSessionModal.ts` nie wstaje w AVA.
 */
import { t } from '../../core/i18n/index.js';

export function sectionDisplayLabel(section: string | undefined): string {
    switch ((section || '').trim()) {
        case '': return t('modal.save_session.section.current');
        case '## Bieżące': return t('modal.save_session.section.current');
        case '## User': return t('modal.save_session.section.user');
        case '## Preferencje': return t('modal.save_session.section.preferences');
        case '## Workflow': return t('modal.save_session.section.workflow');
        case '## Projekty i referencje': return t('modal.save_session.section.projects');
        // Nieznany adres (ręczna sekcja usera, przyszły typ) pokazujemy dosłownie - lepszy surowy
        // nagłówek niż etykieta, która kłamie, dokąd trafi notatka.
        default: return (section || '').replace(/^#+\s*/, '');
    }
}

/** Nazwa notatki w nagłówku pozycji; model potrafi jej nie podać. */
export function noteDisplayName(name: string | undefined): string {
    return (name || '').trim() || t('modal.save_session.note_fallback');
}
