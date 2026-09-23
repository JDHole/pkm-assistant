/**
 * Etykieta sekcji brain.md DLA OCZU usera w oknie review `/save session`.
 *
 * Nagłówki sekcji brain.md (`## Bieżące`/`## Current`, `## Preferencje`/`## Preferences`...)
 * to ADRESY: `BrainIndex.ts`, parsery i prompty robocze rozpoznają je po dokładnym tekście, a
 * od decyzji właściciela 19.09 zależą od JĘZYKA PLIKU tego konkretnego agenta (rodzi się w
 * języku UI i zostaje w nim na zawsze - `modules/memory/CLAUDE.md`), nie od bieżącego języka
 * interfejsu. Okno review pokazywało kiedyś ten adres wprost, czyli anglojęzyczny user widział
 * `→ ## Bieżące`. Tutaj adres (w KTÓRYMKOLWIEK z dwóch języków pliku, `sectionKeyOf` z
 * `modules/memory` rozpoznaje oba) dostaje nazwę w BIEŻĄCYM języku interfejsu - do pliku dalej
 * idzie adres, nie etykieta.
 *
 * Czysty plik (zero `obsidian`/DOM): `SaveSessionModal.ts` nie wstaje w AVA.
 */
import { t } from '../../core/i18n/index.js';
import { sectionKeyOf } from '../memory/index.js';

export function sectionDisplayLabel(section: string | undefined): string {
    const trimmed = (section || '').trim();
    if (!trimmed) return t('modal.save_session.section.current');
    switch (sectionKeyOf(trimmed)) {
        case 'current': return t('modal.save_session.section.current');
        case 'user': return t('modal.save_session.section.user');
        case 'preferences': return t('modal.save_session.section.preferences');
        case 'workflow': return t('modal.save_session.section.workflow');
        case 'projects': return t('modal.save_session.section.projects');
        // Nieznany adres (ręczna sekcja usera, przyszły typ) pokazujemy dosłownie - lepszy surowy
        // nagłówek niż etykieta, która kłamie, dokąd trafi notatka.
        default: return trimmed.replace(/^#+\s*/, '');
    }
}

/** Nazwa notatki w nagłówku pozycji; model potrafi jej nie podać. */
export function noteDisplayName(name: string | undefined): string {
    return (name || '').trim() || t('modal.save_session.note_fallback');
}
