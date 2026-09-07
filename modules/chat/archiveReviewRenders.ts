/**
 * @module archiveReviewRenders
 * S29 Z4 (2026-07-29) — RENDERY REVIEW konsolidacji, wspólne dla dwóch modali.
 *
 * Skąd się wzięły: te funkcje mieszkały w `ArchiveModal.js` i były do niego przyklejone
 * (`this.merges`, `this.summaryBody`, `this.payload`). Nowy `ConsolidationProgressModal`
 * (checklista całego przebiegu z review W ŚRODKU) potrzebuje DOKŁADNIE tych samych ekranów,
 * a kopiuj-wklej gwarantowałby rozjazd przy pierwszej poprawce. Więc: wyciągnięte tu, oba
 * modale wołają to samo.
 *
 * Kontrakt: funkcje przyjmują element-rodzica i MUTOWALNE obiekty propozycji (te same, które
 * caller potem odda do `applyStepDecision`). Checkboxy/inputy zapisują wprost do tych obiektów —
 * dokładnie tak, jak robił to `ArchiveModal` od Sprintu M3. Klasy CSS i klucze i18n nietknięte,
 * żeby stary tor wyglądał identycznie jak wczoraj.
 */
import { t } from '../../core/i18n/index.js';

export type MergeReview = {
    accepted?: boolean;
    target_name?: string;
    target_type?: string;
    sources?: string[];
    merged_content?: string;
    why?: string;
};

export type DeletionReview = {
    accepted?: boolean;
    filename: string;
    why?: string;
};

/** Kopia propozycji scaleń z domyślnym `accepted: true` (user odznacza to, czego nie chce). */
export function normalizeMerges<T extends { accepted?: boolean }>(merges: T[] = []): Array<T & { accepted: boolean }> {
    return (merges || []).map(m => ({ ...m, accepted: m.accepted !== false }));
}

/** Kopia propozycji usunięć z domyślnym `accepted: true`. */
export function normalizeDeletions<T extends { accepted?: boolean }>(deletions: T[] = []): Array<T & { accepted: boolean }> {
    return (deletions || []).map(d => ({ ...d, accepted: d.accepted !== false }));
}

// AUD-dead-code-055/231 (2026-09-02): `export` zdjęty — drugi konsument (`ArchiveModal`) zniknął
// w kasacji starego toru konsolidacji (D6); dziś te trzy prymitywy służą tylko
// `renderMergesColumn`/`renderDeletionsColumn` w TYM pliku.

/** Nagłówek kolumny: ikona + etykieta + licznik. */
function renderReviewColumn(parent: HTMLElement, icon: string, label: string, count: number): HTMLDivElement {
    const wrap = parent.createDiv({ cls: 'pkm-review__group' });
    const header = wrap.createDiv({ cls: 'pkm-review__group-header' });
    header.createSpan({ text: icon });
    header.createSpan({ text: label });
    header.createSpan({ text: `(${count})`, cls: 'pkm-review__counter' });
    return wrap;
}

function renderReviewItem(parent: HTMLElement): HTMLDivElement {
    return parent.createDiv({ cls: 'pkm-review__item' });
}

function renderReviewEmpty(parent: HTMLElement, message: string): void {
    parent.createDiv({ text: message, cls: 'pkm-review__empty' });
}

export function renderReviewBanner(parent: HTMLElement, text: string): HTMLDivElement {
    const banner = parent.createDiv({ cls: 'pkm-review__banner' });
    banner.textContent = text;
    return banner;
}

/**
 * Faza dedup: dwie kolumny (scalenia / usunięcia) z edytowalną nazwą i treścią wynikową.
 * Mutuje przekazane tablice — caller oddaje je 1:1 jako decyzję.
 */
export function renderDedupReview(
    parent: HTMLElement,
    { merges = [], deletions = [], llmDriven = false }: {
        merges?: MergeReview[];
        deletions?: DeletionReview[];
        llmDriven?: boolean;
    } = {},
): void {
    if (llmDriven) {
        renderReviewBanner(parent, t('modal.archive.llm_driven'));
    }

    renderMergesColumn(parent, merges);
    renderDeletionsColumn(parent, deletions);

    if (merges.length === 0 && deletions.length === 0) {
        const empty = parent.createDiv({ cls: 'cs-archive-modal__dedup-empty' });
        empty.textContent = t('modal.archive.dedup_empty');
    }
}

function renderMergesColumn(parent: HTMLElement, merges: MergeReview[]): void {
    const wrap = renderReviewColumn(parent, '🔀', t('modal.archive.col_merges'), merges.length);
    if (merges.length === 0) {
        renderReviewEmpty(wrap, t('modal.archive.no_merges'));
        return;
    }
    for (const merge of merges) {
        const item = renderReviewItem(wrap);

        // Nagłówek: checkbox + edytowalna nazwa wynikowa + badge typu
        const head = item.createEl('label', { cls: 'pkm-review__item-header' });
        const checkbox = head.createEl('input', { type: 'checkbox' });
        checkbox.checked = merge.accepted !== false;
        checkbox.addEventListener('change', () => { merge.accepted = checkbox.checked; });
        const nameInput = head.createEl('input', { type: 'text', value: merge.target_name || '' });
        nameInput.placeholder = t('modal.archive.target_name_placeholder');
        nameInput.addClass('cs-archive-modal__name-input');
        nameInput.addEventListener('input', () => { merge.target_name = nameInput.value; });
        head.createSpan({ text: merge.target_type || 'reference', cls: 'pkm-review__badge' });

        // Źródła (chipsy)
        const sources = item.createDiv({ cls: 'cs-archive-modal__sources' });
        sources.createSpan({ text: t('modal.archive.sources_label'), cls: 'cs-archive-modal__sources-label' });
        for (const src of merge.sources || []) {
            sources.createSpan({ text: src, cls: 'pkm-review__chip' });
        }

        // Edytowalna treść scalona
        const content = item.createEl('textarea', { cls: 'cs-archive-modal__merge-content' });
        content.value = merge.merged_content || '';
        content.rows = 4;
        content.placeholder = t('modal.archive.merged_content_placeholder');
        content.addEventListener('input', () => { merge.merged_content = content.value; });

        if (merge.why) {
            item.createDiv({ text: `↳ ${merge.why}`, cls: 'cs-archive-modal__why' });
        }
    }
}

function renderDeletionsColumn(parent: HTMLElement, deletions: DeletionReview[]): void {
    const wrap = renderReviewColumn(parent, '🗑️', t('modal.archive.col_deletions'), deletions.length);
    if (deletions.length === 0) {
        renderReviewEmpty(wrap, t('modal.archive.no_deletions'));
        return;
    }
    for (const del of deletions) {
        const item = renderReviewItem(wrap);
        const head = item.createEl('label', { cls: 'pkm-review__row' });
        const checkbox = head.createEl('input', { type: 'checkbox' });
        checkbox.checked = del.accepted !== false;
        checkbox.addEventListener('change', () => { del.accepted = checkbox.checked; });
        head.createSpan({ text: del.filename, cls: 'cs-archive-modal__del-name' });
        if (del.why) {
            item.createDiv({ text: `↳ ${del.why}`, cls: 'cs-archive-modal__why' });
        }
    }
}

/**
 * Faza L1/L2/L3: lista źródeł + edytowalna treść podsumowania.
 *
 * `onChange` (opcjonalny, default no-op) dostaje każdą zmianę treści — `ConsolidationProgressModal`
 * zapisuje ją do szkicu kroku, żeby edycje usera przeżyły zwinięcie panelu. `ArchiveModal` (stary,
 * blokujący tor) go nie podaje i działa dokładnie jak dotąd: czyta treść przez `getBody()`.
 *
 * @returns {{ getBody: () => string, textarea: HTMLTextAreaElement }} caller czyta treść przy zapisie
 */
export function renderSummaryReview(
    parent: HTMLElement,
    { sources = [], body = '', rows = 14, readOnly = false, onChange = null }: {
        sources?: string[];
        body?: unknown;
        rows?: number;
        readOnly?: boolean;
        onChange?: ((value: string) => void) | null;
    } = {},
): { getBody: () => string; textarea: HTMLTextAreaElement } {
    if (sources.length > 0) {
        const sourcesEl = parent.createDiv({ cls: 'cs-archive-modal__sources cs-archive-modal__sources--summary' });
        sourcesEl.createSpan({
            text: t('modal.archive.sources_label'),
            cls: 'cs-archive-modal__sources-label cs-archive-modal__sources-label--summary',
        });
        for (const src of sources) {
            sourcesEl.createSpan({ text: src, cls: 'pkm-review__chip' });
        }
    }

    let current = String(body || '');
    const textarea = parent.createEl('textarea', { cls: 'cs-archive-modal__summary-body' });
    textarea.value = current;
    textarea.rows = rows;
    if (readOnly) textarea.readOnly = true;
    textarea.addEventListener('input', () => {
        current = textarea.value;
        try { onChange?.(current); } catch { /* callback nie może zepsuć wpisywania */ }
    });

    return { getBody: () => current, textarea };
}
