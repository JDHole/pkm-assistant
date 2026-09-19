/**
 * Etykieta UI dla typu notatki pamięci (`brain/`), pokazywana userowi jako badge w review
 * konsolidacji (`archiveReviewRenders.ts`, kolumna scaleń). Surowy `target_type`
 * (`user`/`agent_rule`/`skill_hint`/`project_context`/`reference`) jest ADRESEM dla
 * `modules/memory` (`ArchiveWorkflow`/`makeMemoryNoteFilename`) - w danych zostaje bez zmian,
 * tłumaczona jest wyłącznie wartość, którą widzi oko usera.
 *
 * Czysty plik (zero `obsidian`/DOM): `archiveReviewRenders.ts` woła tę funkcję TYLKO do
 * wyświetlenia (read-only badge, nie input) - wzór `modules/chat/saveSessionSectionLabel.ts`.
 */
import { t } from '../../core/i18n/index.js';

export function memoryNoteTypeLabel(type: string | undefined): string {
    switch ((type || '').trim()) {
        case '': return t('memory.note_type.reference');
        case 'user': return t('memory.note_type.user');
        case 'agent_rule': return t('memory.note_type.agent_rule');
        case 'skill_hint': return t('memory.note_type.skill_hint');
        case 'project_context': return t('memory.note_type.project_context');
        case 'reference': return t('memory.note_type.reference');
        // Nieznany/przyszły typ pokazujemy dosłownie - lepszy surowy napis niż etykieta,
        // która kłamie, jaki to typ notatki.
        default: return (type || '').trim();
    }
}
