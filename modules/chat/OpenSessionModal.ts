/**
 * OpenSessionModal — Sprint 03 Z16.
 *
 * User otwiera starą sesję — 3 opcje (Wizja Memory v2 Blok 1):
 *   - 'continue' — load pełną sesję (jak pre-Z16)
 *   - 'compress' — załaduj L1 summary który includes tę sesję (mniej tokenów)
 *   - 'fresh'    — nowa sesja z perspektywy agenta (brain + ostatnie 3 L1)
 *
 * Default focus: 'compress' (decyzja Kuby pre-flight — najczęściej best UX).
 */
import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { SkinManager, UiIcons, setSvgLabel } from '../crystal-soul/index.js';
import { SvgHelper } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';

type OpenSessionChoice = 'continue' | 'compress' | 'fresh' | 'cancel';
type OpenSessionOptions = { agentName?: string; agentColor?: string; sessionTitle?: string; sessionDate?: string };

export class OpenSessionModal extends Modal {
    declare agentName: string;
    declare agentColor: string;
    declare sessionTitle: string;
    declare sessionDate: string;
    declare _resolve: ((choice: OpenSessionChoice) => void) | null;
    /**
     * @param {App} app
     * @param {Object} opts - { agentName, agentColor, sessionTitle, sessionDate }
     */
    constructor(app: App, opts: OpenSessionOptions = {}) {
        super(app);
        this.agentName = opts.agentName || '';
        this.agentColor = opts.agentColor || '';
        this.sessionTitle = opts.sessionTitle || '';
        this.sessionDate = opts.sessionDate || '';
        this._resolve = null;
    }

    /**
     * @returns {Promise<'continue'|'compress'|'fresh'|'cancel'>}
     */
    prompt() {
        return new Promise(resolve => {
            this._resolve = resolve;
            this.open();
        });
    }

    _resolveWith(choice: OpenSessionChoice) {
        if (!this._resolve) return;
        const r = this._resolve;
        this._resolve = null;
        r(choice);
        this.close();
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        contentEl.addClass('cs-open-session-modal');
        if (modalEl) {
            modalEl.addClass('cs-session-modal-narrow');
        }
        if (this.agentColor) {
            const target = modalEl || contentEl;
            target.style.setProperty('--cs-agent-color', this.agentColor);
        }

        const header = contentEl.createDiv({ cls: 'cs-open-session__header' });
        if (this.agentName) {
            const svg = SkinManager.getCrystal({ name: this.agentName, color: this.agentColor }, {
                size: 24, color: this.agentColor || 'var(--interactive-accent)', glow: true
            });
            const el = SvgHelper.toElement(svg);
            if (el) header.appendChild(el);
        }
        header.createSpan({
            text: t('modal.open_session.title') || 'Otwierasz starą sesję',
            cls: 'cs-open-session__title'
        });

        const info = contentEl.createDiv({ cls: 'cs-open-session__info' });
        info.textContent = t('modal.open_session.info', {
            title: this.sessionTitle,
            date: this.sessionDate
        }) || `${this.sessionTitle} (${this.sessionDate}). Co zrobić?`;

        const actions = contentEl.createDiv({ cls: 'cs-open-session__actions' });

        // 1) Compress (PRIMARY — default focus)
        const compressBtn = actions.createEl('button', {
            cls: 'cs-open-session__btn cs-open-session__btn--primary'
        });
        setSvgLabel(compressBtn, UiIcons.brain(14),
            t('modal.open_session.compress') || 'Skompresuj kontekst');
        compressBtn.title = t('modal.open_session.compress_tooltip')
            || 'Załaduj L1 summary tej sesji (mniej tokenów)';
        compressBtn.addEventListener('click', () => this._resolveWith('compress'));

        // 2) Continue (full load)
        const continueBtn = actions.createEl('button', { cls: 'cs-open-session__btn' });
        setSvgLabel(continueBtn, UiIcons.chat(14),
            t('modal.open_session.continue') || 'Kontynuuj sesję');
        continueBtn.title = t('modal.open_session.continue_tooltip')
            || 'Załaduj pełną sesję i kontynuuj rozmowę';
        continueBtn.addEventListener('click', () => this._resolveWith('continue'));

        // 3) Fresh (new from agent perspective)
        const freshBtn = actions.createEl('button', { cls: 'cs-open-session__btn' });
        setSvgLabel(freshBtn, UiIcons.brain(14),
            t('modal.open_session.fresh') || 'Nowy chat z perspektywy agenta');
        freshBtn.title = t('modal.open_session.fresh_tooltip')
            || 'Brain + ostatnie 3 L1 jako kontekst, fresh start';
        freshBtn.addEventListener('click', () => this._resolveWith('fresh'));

        // Cancel
        const cancelRow = contentEl.createDiv({ cls: 'cs-open-session__cancel-row' });
        const cancelBtn = cancelRow.createEl('button', {
            cls: 'cs-open-session__btn cs-open-session__btn--cancel'
        });
        setSvgLabel(cancelBtn, UiIcons.cross(10), t('generic.cancel'));
        cancelBtn.addEventListener('click', () => this._resolveWith('cancel'));

        // Default focus → compress (Sprint Notka)
        window.setTimeout(() => compressBtn.focus(), 0);
    }

    onClose() {
        if (this._resolve) {
            const r = this._resolve;
            this._resolve = null;
            r('cancel');
        }
    }
}
