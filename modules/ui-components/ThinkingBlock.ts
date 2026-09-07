
import { UiIcons, setSvg } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
// TS-any: blok przyjmuje rozszerzane przez chat dane DOM.
type ChatDynamic = any;

/**
 * Creates a Crystal Soul .cs-action-row for AI thinking/reasoning.
 * Expandable: header (brain icon + "Myślenie" + time + status + arrow) → body (reasoning text).
 * @param {string} thinkingText - The reasoning content
 * @param {boolean} isStreaming - Whether still accumulating
 * @param {number|null} startTime - Timestamp when thinking started
 * @returns {HTMLElement}
 */
export function createThinkingBlock(thinkingText: string, isStreaming = false, startTime: number | null = null) {
    const row = createDiv();
    row.className = 'cs-action-row';
    if (isStreaming) row.classList.add('streaming');

    // ── HEAD ──
    const head = row.createDiv({ cls: 'cs-action-row__head' });

    // Icon
    const iconEl = head.createDiv({ cls: 'cs-action-row__icon' });
    setSvg(iconEl, UiIcons.brain(14));

    // Label
    head.createSpan({ cls: 'cs-action-row__label', text: isStreaming ? t('thinking.active') : t('thinking.done') });

    // Time
    if (startTime) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        head.createSpan({ cls: 'cs-action-row__time', text: `${elapsed}s` });
    }

    // Status crystal
    const statusCls = isStreaming ? 'cs-action-row__status--pending' : 'cs-action-row__status--done';
    head.createDiv({ cls: `cs-action-row__status ${statusCls}` });

    // Arrow
    const arrow = head.createDiv({ cls: 'cs-action-row__arrow' });
    setSvg(arrow, UiIcons.chevronDown(12));

    // ── BODY ──
    const body = row.createDiv({ cls: 'cs-action-row__body' });
    const content = body.createDiv({ cls: 'cs-action-row__content' });
    content.textContent = thinkingText || '';
    // AUD-wydajnosc-096: pamięć ostatnio wpisanej treści dla `updateThinkingBlock` (dopisuje
    // deltę zamiast podmieniać całość). Trzymana na elemencie, bo blok bywa długowieczny.
    (content as ChatDynamic)._pkmThinkingText = thinkingText || '';

    // Toggle
    head.addEventListener('click', () => {
        row.classList.toggle('open');
    });

    return row;
}

/**
 * Updates existing thinking block text content.
 * @param {HTMLElement} block - The .cs-action-row element
 * @param {string} text - New reasoning text
 * @param {number|null} startTime - If provided, update elapsed time
 */
export function updateThinkingBlock(block: ChatDynamic, text: string, startTime: number | null = null) {
    const content = block?.querySelector('.cs-action-row__content');
    if (content) {
        // AUD-wydajnosc-096: `text` to ślad rozumowania ZAKUMULOWANY od początku tury, więc
        // podmiana całości przy każdym wywołaniu przepisywała O(K × długość) znaków i wymuszała
        // przeliczenie układu (`scrollHeight`) także wtedy, gdy nic się nie zmieniło. Ostatnio
        // wpisaną treść pamiętamy NA ELEMENCIE (nie czytamy `textContent` — jego getter sam jest
        // O(n) i wracałby ten sam koszt tylnymi drzwiami).
        const prev: string = typeof content._pkmThinkingText === 'string'
            ? content._pkmThinkingText
            : (content.textContent || '');
        if (prev !== text) {
            if (prev && text.startsWith(prev)) {
                content.append(text.slice(prev.length)); // dopisz samą deltę
            } else {
                content.textContent = text; // rollback / podmiana treści — pełne przepisanie
            }
            content._pkmThinkingText = text;
            // Auto-scroll if expanded
            if (block.classList.contains('open')) {
                content.scrollTop = content.scrollHeight;
            }
        }
    }
    if (startTime) {
        const timeEl = block?.querySelector('.cs-action-row__time');
        if (timeEl) {
            timeEl.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        }
    }
}
