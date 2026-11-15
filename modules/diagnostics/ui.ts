import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import type { DiagnosticReport } from './diagnostics.js';

export class DiagnosticsConsentModal extends Modal {
    private resolve: ((value: boolean | null) => void) | null = null;
    readonly decision = new Promise<boolean | null>(resolve => { this.resolve = resolve; });
    constructor(app: App, private readonly signal?: AbortSignal) { super(app); }
    private readonly abort = () => { this.finish(null); };
    private finish(value: boolean | null): void {
        if (!this.resolve) return;
        this.resolve?.(value);
        this.resolve = null;
        this.close();
    }
    onOpen(): void {
        if (this.signal?.aborted) { this.finish(null); return; }
        this.signal?.addEventListener('abort', this.abort, { once: true });
        this.titleEl.setText(t('diagnostics.title'));
        this.contentEl.createEl('p', { text: t('diagnostics.consent') });
        this.contentEl.createEl('p', { text: t('diagnostics.memory_notice') });
        const buttons = this.contentEl.createDiv({ cls: 'pkm-diagnostics-actions' });
        const decline = buttons.createEl('button', { text: t('diagnostics.without_connection') });
        decline.onclick = () => this.finish(false);
        const accept = buttons.createEl('button', { text: t('diagnostics.with_connection'), cls: 'mod-cta' });
        accept.onclick = () => this.finish(true);
    }
    onClose(): void {
        this.signal?.removeEventListener('abort', this.abort);
        this.resolve?.(null);
        this.resolve = null;
        this.contentEl.empty();
    }
}

export function showDiagnosticReport(app: App, report: DiagnosticReport): void {
    const summary = t('diagnostics.summary', { ok: report.ok, errors: report.errors, path: report.path });
    new Notice(summary, 15000);
    const modal = new Modal(app);
    modal.titleEl.setText(t('diagnostics.title'));
    modal.contentEl.createEl('p', { text: summary });
    if (navigator.clipboard?.writeText) {
        new Setting(modal.contentEl).addButton(button => button.setButtonText(t('diagnostics.copy')).onClick(async () => {
            try { await navigator.clipboard.writeText(report.markdown); new Notice(t('diagnostics.copied')); }
            catch { log.warn('Diagnostics', 'Clipboard write failed'); new Notice(t('diagnostics.copy_failed')); }
        }));
    }
    modal.open();
}
