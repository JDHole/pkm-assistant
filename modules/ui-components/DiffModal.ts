/**
 * DiffModal
 * Shows a user-friendly diff before vault_write operations.
 * Non-programmer friendly: strikethrough for removed, highlighted for added.
 */
import { Modal, Platform } from 'obsidian';
import type { App } from 'obsidian';
import { UiIcons, setSvg, setSvgLabel } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import { computeLineDiff, computeDiffStats, selectVisibleDiffLines } from './diffLines.js';
import type { DiffOp } from './diffLines.js';

/** Wejście modala — ten sam kształt, który buduje `modules/tools/MCPClient.ts`
 *  (`DiffApprovalOptions`, jedyny prawdziwy wołacz poza testowym hakiem `diffModalFactory`). */
type DraftDiffPreview =
    | { kind: 'text'; oldContent: string; newContent: string }
    | { kind: 'deleted'; oldContent: string; newContent: '' }
    | { kind: 'binary'; operation: 'create' | 'replace' | 'delete'; oldBytes: number; newBytes: number; image?: Uint8Array }
    | { kind: 'folder' };
interface DiffModalOptions {
    preview?: DraftDiffPreview;
    signal?: AbortSignal;
    path: string;
    oldContent: string;
    newContent: string;
    agentName: string;
    /**
     * Wołacz (`MCPClient`, krok 6b) mówi modalowi „ta sesja MA klucz (`origin.sessionPath`),
     * pokaż checkbox «Nie pytaj więcej w tej sesji»". Brak pola (albo `false`) = checkbox się
     * nie pokazuje — bez klucza sesji `SessionWriteConsent` nie ma czego zapamiętać.
     */
    rememberAvailable?: boolean;
}

type DiffModalResult = 'approve' | 'deny';

export class DiffModal extends Modal {
    declare opts: DiffModalOptions;
    private imageUrl: string | null = null;
    private readonly cancel = () => this._resolve('deny');
    declare result: DiffModalResult | null;
    declare resolvePromise: ((result: DiffModalResult) => void) | null;
    /**
     * Stan checkboxa „Nie pytaj więcej w tej sesji" w chwili rozstrzygnięcia modala.
     * `waitForApproval()` ZOSTAJE `Promise<'approve'|'deny'>` (kontrakt haka testowego
     * `diffModalFactory` w `MCPClient` się nie zmienia) — wołacz czyta to pole z INSTANCJI
     * modala PO rozstrzygnięciu obietnicy, nie z jej wyniku. Zawsze `false` przy Odrzuć.
     */
    declare rememberForSession: boolean;
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
        this.rememberForSession = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('pkm-diff-modal');

        // Header
        const header = contentEl.createDiv('diff-header');
        const h2 = header.createEl('h2');
        setSvgLabel(h2, UiIcons.edit(20), t('modal.diff.title'));

        const body = Platform.isPhone ? contentEl.createDiv('pkm-decision-body') : contentEl;

        // Agent + path info
        const info = body.createDiv('diff-info');
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

        const preview = this.opts.preview;
        if (preview?.kind === 'binary') {
            body.createDiv({ cls: 'diff-operation', text: t(preview.operation === 'create' ? 'modal.diff.binary_create' : preview.operation === 'replace' ? 'modal.diff.binary_replace' : 'modal.diff.binary_delete') });
            body.createDiv({ cls: 'diff-binary-size', text: t('modal.diff.binary_size', {
                before: preview.oldBytes, after: preview.newBytes,
            }) });
            const extension = this.opts.path.split('.').at(-1)?.toLowerCase() ?? '';
            const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
            if (preview.image && mime[extension] && typeof URL.createObjectURL === 'function') {
                this.imageUrl = URL.createObjectURL(new Blob([preview.image], { type: mime[extension] }));
                body.createEl('img', { cls: 'diff-image', attr: { src: this.imageUrl,
                    alt: t('modal.diff.image_preview') } });
            }
        } else if (preview?.kind === 'folder') {
            body.createDiv({ cls: 'diff-operation', text: t('modal.diff.folder') });
        } else {
            if (preview?.kind === 'deleted') body.createDiv({ cls: 'diff-operation', text: t('modal.diff.deleted') });
            // Diff computed ONCE, shared by stats + render — computing the same full LCS DP table
            // twice (once per method) would waste one pass for nothing.
            const ops = computeLineDiff(preview?.oldContent ?? this.opts.oldContent, preview?.newContent ?? this.opts.newContent);

            // Stats
            const stats = computeDiffStats(ops);
            if (stats.added > 0 || stats.removed > 0) {
                const statsEl = body.createDiv('diff-stats');
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
            const diffBody = body.createDiv('diff-body');
            // oldContent !== newContent as STRINGS doesn't guarantee any line actually differs after
            // split('\n') (e.g. content that differs only outside what split captures) — without
            // this check, the modal would show nothing but a single "⋯ N unchanged lines ⋯"
            // placeholder, an approval screen with no visible change to approve.
            if (stats.added === 0 && stats.removed === 0) {
                this._renderNoChanges(diffBody);
            } else {
                this._renderDiff(diffBody, ops);
            }

        }

        // Checkbox „Nie pytaj więcej w tej sesji o zapisy do tego pliku" - TYLKO gdy wołacz
        // podał `rememberAvailable:true` (czyli `origin.sessionPath` jest znany - bez klucza
        // sesji `SessionWriteConsent` nie ma czego zapamiętać, patrz `MCPClient.ts` krok 6b).
        // Checkbox ZAGNIEŻDŻONY w <label>, BEZ `id`/`htmlFor` - z kilkoma otwartymi modalami
        // naraz (np. dwie zakładki czatu z zapisem w tej samej turze) stały `id` kolidowałby
        // między instancjami, a klik w etykietę trafiałby zawsze w PIERWSZY modal w DOM-ie,
        // nigdy w swój własny. Zagnieżdżenie działa natywnie - przeglądarka aktywuje kontrolkę
        // wewnątrz `<label>` niezależnie od `id`.
        let rememberCheckbox: HTMLInputElement | null = null;
        if (this.opts.rememberAvailable && (!preview || preview.kind === 'text')) {
            const rememberRow = contentEl.createDiv('diff-remember');
            const label = rememberRow.createEl('label');
            rememberCheckbox = label.createEl('input', { type: 'checkbox' });
            label.appendText(' ' + t('modal.diff.remember_session'));
        }

        // Buttons
        const buttons = contentEl.createDiv('diff-buttons');

        const renderDenyButton = () => {
            const denyBtn = buttons.createEl('button', { cls: 'mod-warning' });
            setSvgLabel(denyBtn, UiIcons.cross(14), t('modal.diff.deny'));
            denyBtn.onclick = () => {
                // Odrzucenie NIGDY nie pamięta zgody, niezależnie od stanu checkboxa.
                this.rememberForSession = false;
                this._resolve('deny');
            };
        };
        if (!Platform.isPhone) renderDenyButton();

        const approveBtn = buttons.createEl('button', { cls: 'mod-cta' });
        setSvgLabel(approveBtn, UiIcons.check(14), t('modal.diff.approve'));
        approveBtn.onclick = () => {
            this.rememberForSession = !!rememberCheckbox?.checked;
            this._resolve('approve');
        };
        if (Platform.isPhone) renderDenyButton();
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
        this.opts.signal?.removeEventListener('abort', this.cancel);
        if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
        this.imageUrl = null;
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
            if (this.opts.signal?.aborted) { this._resolve('deny'); return; }
            this.opts.signal?.addEventListener('abort', this.cancel, { once: true });
            this.open();
        });
    }
}
