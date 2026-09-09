/**
 * SessionCloseModal
 *
 * Crystal Soul modal pokazywany gdy user kończy sesję chat (X taba, "Nowy chat",
 * plugin shutdown z aktywną sesją).
 *
 * Opcje:
 *     'archive'  → zapis sesji jako sessionType:'archived' + konsolidacja L0/L1
 *     'discard'  → "Stracisz X wiadomości" (confirm) → sesja ląduje w `.discarded/`
 *     'cancel'   → modal zamknięty (Esc / poza modalem)
 *
 * Result type:
 *   { choice: 'archive' | 'discard' | 'cancel' }
 */
import { Modal, type App } from 'obsidian';
import { SkinManager, UiIcons, setSvgLabel } from '../crystal-soul/index.js';
import { SvgHelper } from '../crystal-soul/index.js';
import { confirmModal } from '../ui-components/index.js';
import { t } from '../../core/i18n/index.js';

type SessionCloseChoice = 'archive' | 'discard' | 'cancel';

interface SessionCloseModalOptions {
    agentName?: string;
    agentColor?: string;
    messageCount?: number;
}

interface SessionCloseResult {
    choice: SessionCloseChoice;
}

type SessionCloseResolver = (result: SessionCloseResult) => void;

export class SessionCloseModal extends Modal {
    declare agentName: string;
    declare agentColor: string;
    declare messageCount: number;
    declare _resolve: SessionCloseResolver | null;

    /**
     * @param {App} app
     * @param {Object} opts - { agentName, agentColor, messageCount }
     */
    constructor(app: App, opts: SessionCloseModalOptions = {}) {
        super(app);
        this.agentName = opts.agentName || '';
        this.agentColor = opts.agentColor || '';
        this.messageCount = opts.messageCount || 0;
        this._resolve = null;
    }

    /**
     * Show modal and return user's choice.
     * @returns {Promise<{choice: 'archive'|'discard'|'cancel'}>}
     */
    prompt(): Promise<SessionCloseResult> {
        return new Promise<SessionCloseResult>((resolve: SessionCloseResolver) => {
            this._resolve = resolve;
            this.open();
        });
    }

    _resolveWith(choice: SessionCloseChoice): void {
        if (!this._resolve) return;
        const r = this._resolve;
        this._resolve = null;
        r({ choice });
        this.close();
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        contentEl.addClass('cs-session-close-modal');

        if (modalEl) {
            modalEl.addClass('cs-session-modal-narrow');
        }

        // Agent color vars
        if (this.agentColor) {
            const target: HTMLElement = modalEl || contentEl;
            target.style.setProperty('--cs-agent-color', this.agentColor);
            const hex = this.agentColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            target.style.setProperty('--cs-agent-color-rgb', `${r},${g},${b}`);
        }

        // Header with crystal
        const header = contentEl.createDiv({ cls: 'cs-session-close__header' });
        if (this.agentName) {
            const svg = SkinManager.getCrystal({ name: this.agentName, color: this.agentColor }, {
                size: 24, color: this.agentColor || 'var(--interactive-accent)', glow: true
            });
            const el = SvgHelper.toElement(svg);
            if (el) header.appendChild(el);
        }
        header.createSpan({ text: t('modal.session_close.title'), cls: 'cs-session-close__title' });

        // Info
        const info = contentEl.createDiv({ cls: 'cs-session-close__info' });
        info.textContent = t('modal.session_close.info', { agent: this.agentName, count: this.messageCount });

        // Buttons: 2 opcje + cancel
        const actions = contentEl.createDiv({ cls: 'cs-session-close__actions' });

        // 1) Archive (primary) — default action, podsumuj + zapisz
        const archiveBtn = actions.createEl('button', {
            cls: 'cs-session-close__btn cs-session-close__btn--primary'
        });
        setSvgLabel(archiveBtn, UiIcons.brain(14),
            t('modal.session_close.archive') || 'Archiwizuj');
        archiveBtn.title = t('modal.session_close.archive_tooltip')
            || 'Skompresuj sesję do pamięci długoterminowej i zostaw historię';
        archiveBtn.addEventListener('click', () => this._resolveWith('archive'));

        // 2) Discard — wyrzuć (z confirm)
        const discardBtn = actions.createEl('button', {
            cls: 'cs-session-close__btn cs-session-close__btn--cancel'
        });
        setSvgLabel(discardBtn, UiIcons.cross(12),
            t('modal.session_close.discard') || 'Wyrzuć');
        discardBtn.title = t('modal.session_close.discard_tooltip')
            || 'Bezpowrotne wyrzucenie wiadomości — wymaga potwierdzenia';
        discardBtn.addEventListener('click', () => {
            void (async () => {
                const msg = t('modal.session_close.discard_confirm', { count: this.messageCount })
                    || `Stracisz ${this.messageCount} wiadomości. Na pewno?`;
                // no-alert (wytyczne katalogu Obsidiana): natywny `window.confirm()` blokuje pętlę
                // zdarzeń i wygląda obco - `confirmModal` z modules/ui-components jest jego
                // promise'owym zamiennikiem.
                const confirmed = this.messageCount === 0 || await confirmModal(this.app, {
                    title: t('modal.session_close.discard_confirm_title'),
                    message: msg,
                    destructive: true,
                });
                if (confirmed) {
                    this._resolveWith('discard');
                }
            })();
        });

        // Cancel (mały, pod główną akcją)
        const cancelRow = contentEl.createDiv({ cls: 'cs-session-close__cancel-row' });
        const cancelBtn = cancelRow.createEl('button', {
            cls: 'cs-session-close__btn cs-session-close__btn--cancel'
        });
        setSvgLabel(cancelBtn, UiIcons.cross(10), t('generic.cancel'));
        cancelBtn.addEventListener('click', () => this._resolveWith('cancel'));
    }

    onClose(): void {
        // If modal closed via Escape or clicking outside
        if (this._resolve) {
            const r = this._resolve;
            this._resolve = null;
            r({ choice: 'cancel' });
        }
    }
}
