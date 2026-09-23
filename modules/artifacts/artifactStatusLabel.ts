/**
 * artifactStatusLabel.js — etykieta statusu artefaktu DLA OCZU usera.
 *
 * Status (`do-akceptacji`/`uwagi`/`zaakceptowany`/`zamkniety`/`w-trakcie`/`gotowy`/`szkic` w PL,
 * `pending-approval`/`remarks`/`accepted`/`closed`/`in-progress`/`ready`/`draft` w EN - patrz
 * `modules/artifacts/artifactStatuses.ts`) jest IDENTYFIKATOREM SILNIKA: zapisany we
 * frontmatterze notatki, czytany po dokładnym tekście przez `artifactButtons.ts`,
 * `ArtifactStore.archive`, `basesView.ts` i harness, oraz przez MODEL (parametr `status`
 * narzędzia `artifact_list`). W PLIKU, W PROMPCIE i przy KAŻDEJ logice/porównaniu status
 * zostaje surowy — w KAŻDYM języku PLIKU. Ta funkcja NIE tłumaczy tej wartości — daje jej
 * etykietę wyłącznie tam, gdzie status rysuje SAM PLUGIN (blok w notatce, panel profilu agenta,
 * picker artefaktów pod `@` w czacie), żeby user zawsze widział etykietę w BIEŻĄCYM języku
 * interfejsu, niezależnie od tego, w jakim języku jest sam plik typu. Properties i Bases
 * rysuje Obsidian wprost z surowego YAML — poza zasięgiem tej funkcji, świadomie nie ruszane.
 *
 * `statusRole` (oba języki) rozpoznaje literał → rolę → jeden z 7 istniejących kluczy i18n
 * (`artifact.status.*`, nazwanych po literałach PL - to ADRESY słownika, nie proza, zostają
 * bez zmian). Literał nierozpoznany w ŻADNYM z dwóch języków (typ usera z własnym słownictwem)
 * wraca dosłownie.
 *
 * Czysty plik (zero `obsidian`/DOM), zero konsumenta narusza to przez import z barrela.
 */
import { t } from '../../core/i18n/index.js';
import { statusRole } from './artifactStatuses.js';
import type { ArtifactStatusRole } from './artifactStatuses.js';

const ROLE_LABEL_KEY: Readonly<Record<ArtifactStatusRole, string>> = {
    draft: 'artifact.status.szkic',
    pending: 'artifact.status.do_akceptacji',
    remarks: 'artifact.status.uwagi',
    accepted: 'artifact.status.zaakceptowany',
    closed: 'artifact.status.zamkniety',
    in_progress: 'artifact.status.w_trakcie',
    ready: 'artifact.status.gotowy',
};

/**
 * @param {string|null|undefined} status - surowy status z frontmattera instancji
 * @returns {string} etykieta w bieżącym języku interfejsu; nieznany status (w żadnym z dwóch
 *   języków rejestru) wraca dosłownie; pusty/null/undefined -> '—'
 */
export function artifactStatusLabel(status: string | null | undefined): string {
    const s = (status || '').trim();
    if (!s) return '—';
    const role = statusRole(s);
    // Nieznany status (typ artefaktu usera, ręcznie wpisana wartość w frontmatterze) —
    // lepszy surowy identyfikator niż etykieta, która kłamie, czym ten status jest.
    return role ? t(ROLE_LABEL_KEY[role]) : s;
}
