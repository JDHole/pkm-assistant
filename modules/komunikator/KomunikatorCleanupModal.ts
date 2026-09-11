/**
 * Sprzątanie skrzynki pół-automatem - BEZ kosza, usuwanie twarde.
 *
 * Reguła: wiadomość, która dostała OBA ptaszki (user ją widział ORAZ agent ją przeczytał),
 * jest już do niczego nikomu potrzebna. Zamiast kasować ją po cichu, plugin pokazuje
 * PEŁNY podgląd (od/do/temat/data/treść) i pyta: usuń czy zostaw. „Zostaw" = wiadomość
 * leży dalej w skrzynce jako przeczytana (sprzątnie ją guzik hurtowy w sidebarze).
 *
 * Kilka wiadomości naraz → kolejka (`cleanupQueue.js`), jeden modal na raz.
 */
import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../../core/i18n/index.js';
// To jedyny plik, który maluje klasy `.komunikator-cleanup-*`.
import komunikator_cleanup_styles from './KomunikatorCleanupModal.css' with { type: 'css' };
import { UiIcons, setSvgLabel, adoptSheet } from '../crystal-soul/index.js';
import { CleanupQueue } from './cleanupQueue.js';
import type { Message } from './types.js';
import type { KomunikatorManager } from './KomunikatorManager.js';

/** Modal podglądu jednej wiadomości z pytaniem „usuń / zostaw". */
export class KomunikatorCleanupModal extends Modal {
    declare message: Partial<Message>;
    declare onDecision: ((remove: boolean) => void | Promise<void>) | null;
    declare _decided: boolean;
    /**
     * @param {App} app
     * @param {Object} message - nagłówek + `body` (z `getMessage`)
     * @param {(remove: boolean) => any} onDecision
     */
    constructor(app: App, message: Partial<Message> | null | undefined, onDecision: ((remove: boolean) => void | Promise<void>) | null) {
        super(app);
        this.message = message || {};
        this.onDecision = onDecision;
        this._decided = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('komunikator-cleanup-modal');

        // Adopt CSS: `adoptSheet` rejestruje arkusz do demontażu w onunload;
        // idempotentne, bezpieczne przy wielokrotnym open.
        adoptSheet(komunikator_cleanup_styles);

        const h2 = contentEl.createEl('h2');
        setSvgLabel(h2, UiIcons.check(18), t('communicator.cleanup.title'));
        contentEl.createEl('p', { text: t('communicator.cleanup.desc'), cls: 'setting-item-description' });

        const meta = contentEl.createDiv({ cls: 'komunikator-cleanup-meta' });
        const row = (label: string, value: unknown) => {
            if (!value) return;
            const line = meta.createDiv({ cls: 'komunikator-cleanup-meta__row' });
            line.createSpan({ cls: 'komunikator-cleanup-meta__label', text: label });
            line.createSpan({ cls: 'komunikator-cleanup-meta__value', text: String(value) });
        };
        row(t('communicator.cleanup.field_from'), this.message.from);
        row(t('communicator.cleanup.field_to'), this.message.to);
        row(t('communicator.cleanup.field_subject'), this.message.subject);
        row(t('communicator.cleanup.field_date'), this.message.date);

        const body = contentEl.createDiv({ cls: 'komunikator-cleanup-body' });
        body.textContent = this.message.body || '';

        const buttons = contentEl.createDiv({ cls: 'komunikator-cleanup-buttons' });

        const keepBtn = buttons.createEl('button', { text: t('communicator.cleanup.keep') });
        keepBtn.addEventListener('click', () => this._decide(false));

        const deleteBtn = buttons.createEl('button', { cls: 'mod-warning' });
        setSvgLabel(deleteBtn, UiIcons.trash(14), t('communicator.cleanup.remove'));
        deleteBtn.addEventListener('click', () => this._decide(true));
    }

    /** Zamknięcie krzyżykiem/Esc = „zostaw" (nic nie kasujemy bez jawnej decyzji). */
    onClose() {
        this.contentEl.empty();
        if (!this._decided) {
            this._decided = true;
            void this.onDecision?.(false);
        }
    }

    _decide(remove: boolean) {
        if (this._decided) return;
        this._decided = true;
        void this.onDecision?.(remove);
        this.close();
    }
}

/** Mały modal potwierdzenia dla guzika hurtowego („usuń N przeczytanych"). */
export class KomunikatorBulkDeleteModal extends Modal {
    declare info: { count?: number; agent?: string };
    declare onDecision: ((confirmed: boolean) => void | Promise<void>) | null;
    declare _decided: boolean;
    /**
     * @param {App} app
     * @param {{count: number, agent: string}} info
     * @param {(confirmed: boolean) => any} onDecision
     */
    constructor(app: App, info: { count?: number; agent?: string } | null | undefined, onDecision: ((confirmed: boolean) => void | Promise<void>) | null) {
        super(app);
        this.info = info || {};
        this.onDecision = onDecision;
        this._decided = false;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('komunikator-cleanup-modal');

        // Adopt CSS - idempotentne, więc bez znaczenia że
        // KomunikatorCleanupModal mógł już wywołać to samo w tej sesji.
        adoptSheet(komunikator_cleanup_styles);

        const h2 = contentEl.createEl('h2');
        setSvgLabel(h2, UiIcons.trash(18), t('communicator.cleanup.bulk_title'));
        contentEl.createEl('p', {
            text: t('communicator.cleanup.bulk_confirm', { count: this.info.count, agent: this.info.agent }),
        });
        contentEl.createEl('p', { text: t('communicator.cleanup.bulk_hint'), cls: 'setting-item-description' });

        const buttons = contentEl.createDiv({ cls: 'komunikator-cleanup-buttons' });
        const cancelBtn = buttons.createEl('button', { text: t('generic.cancel') });
        cancelBtn.addEventListener('click', () => this._decide(false));

        const okBtn = buttons.createEl('button', { cls: 'mod-warning' });
        setSvgLabel(okBtn, UiIcons.trash(14), t('communicator.cleanup.remove'));
        okBtn.addEventListener('click', () => this._decide(true));
    }

    onClose() {
        this.contentEl.empty();
        if (!this._decided) {
            this._decided = true;
            void this.onDecision?.(false);
        }
    }

    _decide(confirmed: boolean) {
        if (this._decided) return;
        this._decided = true;
        void this.onDecision?.(confirmed);
        this.close();
    }
}

/** Manager agentów, jaki potrzebuje ten plik — duck-type lokalny (wzorem `AgentManagerLike`
 *  w `types.ts`), NIE prawdziwa klasa z `modules/agents` (CLAUDE.md „Zależności": kierunek
 *  jest agents → komunikator, nie odwrotnie — moduł jej celowo nie importuje). */
interface CleanupAgentManager {
    komunikatorManager?: KomunikatorManager | null;
    on(callback: (event: string, data: { agent?: string; id?: string }) => void): () => void;
}

interface CleanupPlugin {
    agentManager?: CleanupAgentManager | null;
    app: App;
}

/**
 * Podłącz sprzątanie do zdarzeń komunikatora. Wołane raz z `main.js` (za flagą).
 * Zwraca funkcję odsubskrybowania — plugin woła ją przy unload.
 *
 * @param {Object} plugin
 * @returns {() => void}
 */
export function registerKomunikatorCleanup(plugin: CleanupPlugin): () => void {
    const agentManager = plugin?.agentManager;
    if (!agentManager?.on) return () => {};

    const queue = new CleanupQueue(async ({ agent, id }) => {
        const komunikator = plugin.agentManager?.komunikatorManager;
        if (!komunikator) return;
        const message = await komunikator.getMessage(agent, id);
        // Wiadomość mogła w międzyczasie zniknąć albo stracić ptaszek — nie pytamy o duchy.
        if (!message || !message.allRead) return;

        await new Promise<void>((resolve) => {
            new KomunikatorCleanupModal(plugin.app, message, async (remove) => {
                if (remove) {
                    const ok = await komunikator.deleteMessage(agent, id);
                    new Notice(ok ? t('communicator.message_deleted') : t('communicator.delete_failed'));
                }
                resolve();
            }).open();
        });
    });

    const unsubscribe = agentManager.on((event: string, data: { agent?: string; id?: string }) => {
        if (event !== 'communicator:message_all_read') return;
        queue.enqueue({ agent: data?.agent as string, id: data?.id as string });
    });

    return () => {
        queue.clear();
        unsubscribe();
    };
}
