/**
 * artifactStatusLabel.js — etykieta statusu artefaktu DLA OCZU usera.
 *
 * Status (`do-akceptacji`/`uwagi`/`zaakceptowany`/`zamkniety`/`w-trakcie`/`gotowy`/`szkic`, domyślnie
 * `szkic`) jest IDENTYFIKATOREM SILNIKA: zapisany we frontmatterze notatki, czytany po dokładnym
 * tekście przez `artifactButtons.ts`, `ArtifactStore.archive`, `basesView.ts` i harness, oraz przez
 * MODEL (parametr `status` narzędzia `artifact_list`). W PLIKU, W PROMPCIE i przy KAŻDEJ logice/
 * porównaniu status zostaje surowy — w KAŻDYM języku interfejsu. Ta funkcja NIE tłumaczy tej
 * wartości — daje jej etykietę wyłącznie tam, gdzie status rysuje SAM PLUGIN (blok w notatce,
 * panel profilu agenta, picker artefaktów pod `@` w czacie), żeby anglojęzyczny user nie widział polskiego tokenu. Properties i Bases
 * rysuje Obsidian wprost z surowego YAML — poza zasięgiem tej funkcji, świadomie nie ruszane.
 *
 * Czysty plik (zero `obsidian`/DOM), zero konsumenta narusza to przez import z barrela.
 */
import { t } from '../../core/i18n/index.js';

/**
 * @param {string|null|undefined} status - surowy status z frontmattera instancji
 * @returns {string} etykieta w bieżącym języku interfejsu; nieznany status wraca dosłownie;
 *   pusty/null/undefined -> '—'
 */
export function artifactStatusLabel(status: string | null | undefined): string {
    const s = (status || '').trim();
    if (!s) return '—';
    switch (s) {
        case 'do-akceptacji': return t('artifact.status.do_akceptacji');
        case 'uwagi': return t('artifact.status.uwagi');
        case 'zaakceptowany': return t('artifact.status.zaakceptowany');
        case 'zamkniety': return t('artifact.status.zamkniety');
        case 'w-trakcie': return t('artifact.status.w_trakcie');
        case 'gotowy': return t('artifact.status.gotowy');
        case 'szkic': return t('artifact.status.szkic');
        // Nieznany status (typ artefaktu usera, ręcznie wpisana wartość w frontmatterze) —
        // lepszy surowy identyfikator niż etykieta, która kłamie, czym ten status jest.
        default: return s;
    }
}
