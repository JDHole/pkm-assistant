/**
 * AgentDeleteModal
 * Confirmation dialog for deleting an agent with optional memory archiving.
 */
import { Modal, Setting, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { UiIcons, setSvgLabel } from '../../modules/crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import type { Agent, AgentManager } from '../../modules/agents/index.js';
import type { PluginApi } from '../../core/index.js';

/** Kształt błędu w `catch` bez narzucania typu wyjątku. */
type ErrLike = { message?: string };

/** Plugin widziany przez ten modal: tylko `agentManager` ponad bazowy `PluginApi`. */
interface AgentDeleteModalPlugin extends PluginApi {
    agentManager?: AgentManager;
}

/** Callback po usunięciu agenta. */
type OnConfirmCallback = (() => void) | null;

export class AgentDeleteModal extends Modal {
    declare private plugin: AgentDeleteModalPlugin;
    declare private agent: Agent;
    declare private onConfirm: OnConfirmCallback;
    declare private archiveMemory: boolean;
    /**
     * @param {App} app
     * @param {Object} plugin - PKM Assistant plugin instance
     * @param {Agent} agent - Agent to delete
     * @param {Function|null} onConfirm - Callback after deletion
     */
    constructor(app: App, plugin: AgentDeleteModalPlugin, agent: Agent, onConfirm: OnConfirmCallback = null) {
        super(app);
        this.plugin = plugin;
        this.agent = agent;
        this.onConfirm = onConfirm;
        this.archiveMemory = true; // Default: archive
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('agent-delete-modal');

        // Header
        const h2 = contentEl.createEl('h2');
        setSvgLabel(h2, UiIcons.trash(20), t('modal.agent_delete.title'));

        // Agent info
        const info = contentEl.createDiv({ cls: 'agent-delete-info' });
        info.createEl('p', {
            text: t('modal.agent_delete.confirm', { name: this.agent.name })
        });

        if (this.agent.isBuiltIn) {
            const warnP = info.createEl('p', { cls: 'agent-delete-warning' });
            setSvgLabel(warnP, UiIcons.warning(14), t('modal.agent_delete.builtin_warning'));
        }

        // Archive option
        new Setting(contentEl)
            .setName(t('modal.agent_delete.archive_label'))
            .setDesc(t('modal.agent_delete.archive_desc'))
            .addToggle(toggle => {
                toggle
                    .setValue(this.archiveMemory)
                    .onChange(v => this.archiveMemory = v);
            });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'agent-delete-buttons' });

        const cancelBtn = buttonContainer.createEl('button', { text: t('generic.cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        const deleteBtn = buttonContainer.createEl('button', {
            text: t('modal.agent_delete.delete_btn'),
            cls: 'mod-warning'
        });
        // Agent wbudowany (Jaskier) jest nieusuwalny - przycisk zablokowany (defense in depth).
        if (this.agent.isBuiltIn) {
            deleteBtn.disabled = true;
        } else {
            deleteBtn.addEventListener('click', () => { void this.handleDelete(); });
        }
    }

    async handleDelete() {
        const agentManager = this.plugin.agentManager;
        if (!agentManager) return;

        try {
            // Archive memory if requested
            if (this.archiveMemory) {
                await agentManager.archiveAgentMemory(this.agent.name);
            }

            // Delete agent
            await agentManager.deleteAgent(this.agent.name);

            new Notice(t('modal.agent_delete.deleted', { name: this.agent.name }));

            if (this.onConfirm) this.onConfirm();
            this.close();
        } catch (error) {
            new Notice(t('modal.agent_delete.error', { error: (error as ErrLike).message }));
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Open the agent delete confirmation modal
 * @param {Object} plugin
 * @param {Agent} agent
 * @param {Function|null} onConfirm
 */
export function openAgentDeleteModal(plugin: AgentDeleteModalPlugin, agent: Agent, onConfirm: OnConfirmCallback = null): void {
    new AgentDeleteModal(plugin.app as unknown as App, plugin, agent, onConfirm).open();
}
