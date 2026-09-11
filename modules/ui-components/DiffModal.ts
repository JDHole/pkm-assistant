/**
 * DiffModal
 * Shows a user-friendly diff before vault_write operations.
 * Non-programmer friendly: strikethrough for removed, highlighted for added.
 */
import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { UiIcons, setSvg, setSvgLabel } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import { computeLineDiff, computeDiffStats, selectVisibleDiffLines } from './diffLines.js';
import type { DiffOp } from './diffLines.js';

/** Wejście modala — ten sam kształt, który buduje `modules/tools/MCPClient.ts`
 *  (`DiffApprovalOptions`, jedyny prawdziwy wołacz poza testowym hakiem `diffModalFactory`). */
interface DiffModalOptions {
    path: string;
    oldContent: string;
    newContent: string;
    agentName: string;
}

type DiffModalResult = 'approve' | 'deny';

export class DiffModal extends Modal {
    declare opts: DiffModalOptions;
    declare result: DiffModalResult | null;
    declare resolvePromise: ((result: DiffModalResult) => void) | null;
    /**
     * @param {App} app
     * @param {Object} opts
     * @param {string} opts.path - File path
     * @param {string} opts.oldContent - Original content
     * @param {string} opts.newContent - Proposed new content
     * @param {string} [opts.agentName] - Agent requesting the write
     */
    constructor(app: App, opts: DiffModalOptions) {
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

        // Diff computed ONCE, shared by stats + render — computing the same full LCS DP table
        // twice (once per method) would waste one pass for nothing.
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
        // oldContent !== newContent as STRINGS doesn't guarantee any line actually differs after
        // split('\n') (e.g. content that differs only outside what split captures) — without
        // this check, the modal would show nothing but a single "⋯ N unchanged lines ⋯"
        // placeholder, an approval screen with no visible change to approve.
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
     * Rendering a DOM row for EVERY line of the diff, including every unchanged ('equal') one,
     * would turn opening the modal on a barely-touched 4000-line note into ~4000 rows
     * (~12000 DOM nodes) even when only a handful of lines actually changed.
     * `selectVisibleDiffLines` (pure, `diffLines.ts`) picks changed lines plus a small context
     * window; long runs of unchanged lines collapse into a single "N unchanged lines"
     * placeholder row. Nothing about a change itself is ever hidden — only the surrounding noise.
     */
    _renderDiff(container: HTMLElement, ops: DiffOp[]): void {
        for (const segment of selectVisibleDiffLines(ops, 3)) {
            if (segment.kind === 'line') {
                this._renderDiffLine(container, segment.op);
            } else {
                this._renderCollapsedPlaceholder(container, segment.count);
            }
        }
    }

    _renderDiffLine(container: HTMLElement, op: DiffOp): void {
        const line = container.createDiv({ cls: `diff-line diff-line--${op.type}` });
        const marker = line.createSpan({ cls: 'diff-marker' });
        if (op.type === 'remove') marker.textContent = '−';
        else if (op.type === 'add') marker.textContent = '+';
        else marker.textContent = ' ';
        line.createSpan({ text: op.text, cls: 'diff-text' });
    }

    _renderCollapsedPlaceholder(container: HTMLElement, hiddenCount: number): void {
        const line = container.createDiv({ cls: 'diff-line diff-line--collapsed' });
        line.createSpan({ cls: 'diff-marker', text: '⋯' });
        line.createSpan({
            cls: 'diff-text diff-text--collapsed',
            text: t('modal.diff.collapsed_lines', { count: hiddenCount }),
        });
    }

    _renderNoChanges(container: HTMLElement) {
        container.createDiv({ cls: 'diff-no-changes', text: t('modal.diff.no_changes') });
    }

    _resolve(result: DiffModalResult): void {
        this.result = result;
        this.resolvePromise?.(result);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        if (this.result === null) this.resolvePromise?.('deny');
    }

    /**
     * Show modal and wait for user decision.
     * @returns {Promise<'approve'|'deny'>}
     */
    async waitForApproval(): Promise<DiffModalResult> {
        return new Promise(resolve => {
            this.resolvePromise = resolve;
            this.open();
        });
    }
}
