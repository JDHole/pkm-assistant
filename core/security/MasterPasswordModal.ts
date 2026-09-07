import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { MASTER_PASSWORD_MIN_LENGTH, validateNewMasterPassword } from './masterPasswordPolicy.js';

/** Opcje modala hasła głównego (wszystkie mają sensowne domyślne). */
export interface MasterPasswordOptions {
    title?: string;
    description?: string;
    /** `false` = pytamy o hasło raz (odblokowanie); domyślnie prosimy o powtórzenie. */
    confirm?: boolean;
    submitLabel?: string;
}

export class MasterPasswordModal extends Modal {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare title: string;
    declare description: string;
    declare confirm: boolean;
    declare submitLabel: string;
    declare password: string;
    declare confirmPassword: string;
    declare errorEl: HTMLElement | null;
    declare _resolved: boolean;
    declare _resolve: ((value: string | null) => void) | null;

    constructor(app: App, options: MasterPasswordOptions = {}) {
        super(app);
        this.title = options.title || 'Master password';
        this.description = options.description || 'Enter the master password used to unlock encrypted API keys.';
        this.confirm = options.confirm !== false;
        this.submitLabel = options.submitLabel || 'OK';
        this.password = '';
        this.confirmPassword = '';
        this.errorEl = null;
        this._resolved = false;
        this._resolve = null;
    }

    static request(app: App, options: MasterPasswordOptions = {}): Promise<string | null> {
        return new Promise<string | null>(resolve => {
            const modal = new MasterPasswordModal(app, options);
            modal._resolve = resolve;
            modal.open();
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: this.title });
        contentEl.createEl('p', { text: this.description, cls: 'setting-item-description' });

        new Setting(contentEl)
            .setName('Password')
            .addText(text => {
                text.inputEl.type = 'password';
                text.setPlaceholder(`minimum ${MASTER_PASSWORD_MIN_LENGTH} characters`);
                text.onChange(value => {
                    this.password = value;
                    this._clearError();
                });
            });

        if (this.confirm) {
            new Setting(contentEl)
                .setName('Confirm password')
                .addText(text => {
                    text.inputEl.type = 'password';
                    text.setPlaceholder('Repeat password');
                    text.onChange(value => {
                        this.confirmPassword = value;
                        this._clearError();
                    });
                });
        }

        this.errorEl = contentEl.createDiv({ cls: 'setting-item-description' });
        this.errorEl.addClass('pkm-master-password__error');

        const buttons = contentEl.createDiv();
        buttons.addClass('pkm-master-password__buttons');

        const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this._finish(null));

        const okBtn = buttons.createEl('button', { text: this.submitLabel, cls: 'mod-cta' });
        okBtn.addEventListener('click', () => this._submit());
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this._resolved) this._finish(null);
    }

    _submit(): void {
        // AUD-testy-009: reguła (długość + zgodność powtórzenia) mieszka w czystej,
        // testowalnej funkcji obok tego pliku — `_submit` tylko woła i podpina wynik pod DOM.
        const result = validateNewMasterPassword(this.password, this.confirmPassword, this.confirm);
        if (!result.ok) {
            if (result.code === 'too_short') {
                this._setError(`Password must have at least ${MASTER_PASSWORD_MIN_LENGTH} characters.`);
            } else if (result.code === 'mismatch') {
                this._setError('Passwords do not match.');
            } else {
                // Unia kodów jest dziś zamknięta (too_short|mismatch) — ten fallback łapie
                // przyszły kod dodany do polityki bez aktualizacji modala (review 02.09).
                this._setError('Invalid password.');
            }
            return;
        }
        this._finish(this.password);
    }

    _finish(value: string | null): void {
        if (this._resolved) return;
        this._resolved = true;
        this._resolve?.(value);
        this.close();
    }

    _setError(message: string): void {
        if (this.errorEl) this.errorEl.setText(message);
    }

    _clearError(): void {
        if (this.errorEl) this.errorEl.setText('');
    }
}
