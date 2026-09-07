import { Modal } from 'obsidian';
import { t } from '../../core/i18n/index.js';

export interface MigrationPlanNote {
    filename?: string;
    type?: string;
    description?: string;
}

export interface MigrationPlan {
    notes: MigrationPlanNote[];
    keepInBrain: string[];
    deletedSections: string[];
}

export type MigrationAction = 'accept' | 'cancel' | 'fallback';
export type MigrationResult = { action: MigrationAction; plan?: MigrationPlan };

interface MigrationModalOptions {
    agentName?: string;
    plan?: MigrationPlan;
}

export class MigrationModal extends Modal {
    declare agentName: string;
    declare plan: MigrationPlan;
    declare _resolve: ((result: MigrationResult) => void) | null;

    constructor(app: ConstructorParameters<typeof Modal>[0], opts: MigrationModalOptions = {}) {
        super(app);
        this.agentName = opts.agentName || 'Agent';
        this.plan = opts.plan || { notes: [], keepInBrain: [], deletedSections: [] };
        this._resolve = null;
    }

    prompt(): Promise<MigrationResult> {
        return new Promise<MigrationResult>(resolve => {
            this._resolve = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        if (modalEl) {
            modalEl.addClass('cs-migration-modal-wide');
        }

        contentEl.createEl('h2', { text: t('modal.memory_migration.title') || 'Memory v3 migration' });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('modal.memory_migration.info', { agent: this.agentName })
                || `Agent ${this.agentName}: review notes created from old brain.md.`
        });

        const pre = contentEl.createEl('pre', { cls: 'cs-migration-modal__preview' });
        pre.textContent = this._preview();

        const actions = contentEl.createDiv({ cls: 'cs-migration-modal__actions' });
        this._button(actions, t('generic.cancel') || 'Cancel', 'cancel');
        this._button(actions, t('modal.memory_migration.fallback') || 'Fallback dump', 'fallback');
        const accept = this._button(actions, t('generic.save') || 'Save', 'accept');
        accept.addClass('mod-cta');
    }

    _preview() {
        return JSON.stringify({
            notes: this.plan.notes?.map(note => ({
                filename: note.filename,
                type: note.type,
                description: note.description,
            })) || [],
            keepInBrain: this.plan.keepInBrain || [],
            deletedSections: this.plan.deletedSections || [],
        }, null, 2);
    }

    _button(parent: HTMLElement, label: string, action: MigrationAction) {
        const button = parent.createEl('button', { text: label });
        button.addEventListener('click', () => this._resolveWith(action));
        return button;
    }

    _resolveWith(action: MigrationAction) {
        if (!this._resolve) return;
        const resolve = this._resolve;
        this._resolve = null;
        resolve(action === 'accept' ? { action, plan: this.plan } : { action });
        this.close();
    }

    onClose() {
        if (!this._resolve) return;
        const resolve = this._resolve;
        this._resolve = null;
        resolve({ action: 'cancel' });
    }
}
