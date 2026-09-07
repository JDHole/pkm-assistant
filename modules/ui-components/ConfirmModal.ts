/**
 * ConfirmModal — zamiennik natywnego `window.confirm()` (wytyczne katalogu Obsidiana:
 * `no-alert`; natywny dialog blokuje pętlę zdarzeń i wygląda obco w aplikacji).
 *
 * Użycie: `if (!(await confirmModal(app, { title, message, destructive: true }))) return;`
 * Rozstrzyga się JEDEN raz: klik „Potwierdź" → `true`, klik „Anuluj", Esc albo klik poza
 * oknem → `false`. Bez wyjątków, bez „trzeciego stanu" — wołacz ma dokładnie ten sam
 * kontrakt co przy `confirm()`, więc migracja to zamiana jednej linii.
 */
import { App, Modal } from 'obsidian';
import { t } from '../../core/i18n/index.js';

export interface ConfirmModalOptions {
    title: string;
    message: string;
    /** Etykieta guzika potwierdzenia (domyślnie i18n `confirm.ok`). */
    confirmText?: string;
    /** Etykieta guzika anulowania (domyślnie i18n `confirm.cancel`). */
    cancelText?: string;
    /** Akcja niszcząca (kasowanie) → guzik `mod-warning` zamiast `mod-cta`. */
    destructive?: boolean;
}

export class ConfirmModal extends Modal {
    declare opts: ConfirmModalOptions;
    declare resolve: (ok: boolean) => void;
    declare settled: boolean;

    constructor(app: App, opts: ConfirmModalOptions, resolve: (ok: boolean) => void) {
        super(app);
        this.opts = opts;
        this.resolve = resolve;
        this.settled = false;
    }

    private settle(ok: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve(ok);
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText(this.opts.title);
        contentEl.createEl('p', { text: this.opts.message });
        const row = contentEl.createDiv({ cls: 'pkm-confirm-btn-row' });
        const cancelBtn = row.createEl('button', { text: this.opts.cancelText ?? t('confirm.cancel') });
        cancelBtn.addEventListener('click', () => { this.settle(false); this.close(); });
        const okBtn = row.createEl('button', {
            text: this.opts.confirmText ?? t('confirm.ok'),
            cls: this.opts.destructive ? 'mod-warning' : 'mod-cta',
        });
        okBtn.addEventListener('click', () => { this.settle(true); this.close(); });
        // Akcja niszcząca (kasowanie) startuje z fokusem na „Anuluj" — Enter/Spacja zaraz po
        // otwarciu nie może skasować sesji/skilla/serwera (review fali 2, W2-02/AR-MK-02).
        (this.opts.destructive ? cancelBtn : okBtn).focus();
    }

    onClose(): void {
        // Esc / klik poza oknem — bez decyzji = odmowa (jak `confirm()` zwracające false).
        this.settle(false);
        this.contentEl.empty();
    }
}

/** Promise'owy odpowiednik `window.confirm()` — patrz nagłówek pliku. */
export function confirmModal(app: App, opts: ConfirmModalOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        new ConfirmModal(app, opts, resolve).open();
    });
}
