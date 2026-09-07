/**
 * DiffModal
 * Shows a user-friendly diff before vault_write operations.
 * Non-programmer friendly: strikethrough for removed, highlighted for added.
 */
import { Modal } from 'obsidian';
import { UiIcons, setSvg, setSvgLabel } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import { computeLineDiff, computeDiffStats, selectVisibleDiffLines } from './diffLines.js';
// TS-any: modal interoperuje z dynamicznymi obiektami Obsidiana oraz wynikiem Promise.
type ModalDynamic = any;

export class DiffModal extends Modal {
    declare opts: ModalDynamic;
    declare result: ModalDynamic;
    declare resolvePromise: ModalDynamic;
    /**
     * @param {App} app
     * @param {Object} opts
     * @param {string} opts.path - File path
     * @param {string} opts.oldContent - Original content
     * @param {string} opts.newContent - Proposed new content
     * @param {string} [opts.agentName] - Agent requesting the write
     */
    constructor(app: ModalDynamic, opts: ModalDynamic) {
        super(app);
        this.opts = opts;
        this.result = null;
        this.resolvePromise = null;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('pkm-diff-modal');

        // Header
        const header = contentEl.createDiv('diff-header');
        const h2 = header.createEl('h2');
        setSvgLabel(h2, UiIcons.edit(20), t('modal.diff.title'));

        // Agent + path info
        const info = contentEl.createDiv('diff-info');
        if (this.opts.agentName) {
            info.createSpan({
                text: t('modal.diff.wants_to_change', { name: this.opts.agentName }),
                cls: 'diff-agent'
            });
        }
        const pathEl = info.createDiv('diff-path');
        setSvg(pathEl, UiIcons.file(14));
        pathEl.appendText(' ');
        pathEl.createEl('code', { text: this.opts.path });

        // AUD-wydajnosc-103: diff computed ONCE, shared by stats + render (was computed twice —
        // once per method, full LCS DP table included).
        const ops = computeLineDiff(this.opts.oldContent, this.opts.newContent);

        // Stats
        const stats = computeDiffStats(ops);
        if (stats.added > 0 || stats.removed > 0) {
            const statsEl = contentEl.createDiv('diff-stats');
            if (stats.removed > 0) {
                statsEl.createSpan({
                    text: t('modal.diff.stat_removed', { count: stats.removed }),
                    cls: 'diff-stat-removed'
                });
            }
            if (stats.added > 0) {
                statsEl.createSpan({
                    text: t('modal.diff.stat_added', { count: stats.added }),
                    cls: 'diff-stat-added'
                });
            }
        }

        // Diff body
        const diffBody = contentEl.createDiv('diff-body');
        // Review fix (2026-09-02): oldContent !== newContent as STRINGS doesn't guarantee any
        // line actually differs after split('\n') (e.g. content that differs only outside what
        // split captures) — without this, the modal showed nothing but a single "⋯ N unchanged
        // lines ⋯" placeholder, an approval screen with no visible change to approve.
        if (stats.added === 0 && stats.removed === 0) {
            this._renderNoChanges(diffBody);
        } else {
            this._renderDiff(diffBody, ops);
        }

        // Buttons
        const buttons = contentEl.createDiv('diff-buttons');

        const denyBtn = buttons.createEl('button', { cls: 'mod-warning' });
        setSvgLabel(denyBtn, UiIcons.cross(14), t('modal.diff.deny'));
        denyBtn.onclick = () => this._resolve('deny');

        const approveBtn = buttons.createEl('button', { cls: 'mod-cta' });
        setSvgLabel(approveBtn, UiIcons.check(14), t('modal.diff.approve'));
        approveBtn.onclick = () => this._resolve('approve');
    }

    /**
     * AUD-wydajnosc-102: this used to render a DOM row for EVERY line of the diff, including
     * every unchanged ('equal') one — so opening the modal on a barely-touched 4000-line note
     * built ~4000 rows (~12000 DOM nodes) when only a handful of lines actually changed.
     * `selectVisibleDiffLines` (pure, `diffLines.ts`) picks changed lines plus a small context
     * window; long runs of unchanged lines collapse into a single "N unchanged lines"
     * placeholder row. Nothing about a change itself is ever hidden — only the surrounding noise.
     */
    _renderDiff(container: ModalDynamic, ops: ModalDynamic) {
        for (const segment of selectVisibleDiffLines(ops, 3)) {
            if (segment.kind === 'line') {
                this._renderDiffLine(container, segment.op);
            } else {
                this._renderCollapsedPlaceholder(container, segment.count);
            }
        }
    }

    _renderDiffLine(container: ModalDynamic, op: ModalDynamic) {
        const line = container.createDiv({ cls: `diff-line diff-line--${op.type}` });
        const marker = line.createSpan({ cls: 'diff-marker' });
        if (op.type === 'remove') marker.textContent = '−';
        else if (op.type === 'add') marker.textContent = '+';
        else marker.textContent = ' ';
        line.createSpan({ text: op.text, cls: 'diff-text' });
    }

    _renderCollapsedPlaceholder(container: ModalDynamic, hiddenCount: number) {
        const line = container.createDiv({ cls: 'diff-line diff-line--collapsed' });
        line.createSpan({ cls: 'diff-marker', text: '⋯' });
        line.createSpan({
            cls: 'diff-text diff-text--collapsed',
            text: t('modal.diff.collapsed_lines', { count: hiddenCount }),
        });
    }

    _renderNoChanges(container: ModalDynamic) {
        container.createDiv({ cls: 'diff-no-changes', text: t('modal.diff.no_changes') });
    }

    _resolve(result: ModalDynamic) {
        this.result = result;
        this.resolvePromise?.(result);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
        if (this.result === null) this.resolvePromise?.('deny');
    }

    /**
     * Show modal and wait for user decision.
     * @returns {Promise<'approve'|'deny'>}
     */
    async waitForApproval() {
        return new Promise(resolve => {
            this.resolvePromise = resolve;
            this.open();
        });
    }
}
