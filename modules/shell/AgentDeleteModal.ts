/**
 * AgentDeleteModal
 * Confirmation dialog for deleting an agent with optional memory archiving.
 */
import { Modal, Setting, Notice } from 'obsidian';
import { UiIcons, setSvgLabel } from '../../modules/crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';

// TS-any: agent manager and agent records are plugin-owned runtime integrations.
type Runtime = any;

export class AgentDeleteModal extends Modal {
    declare private plugin: Runtime;
    declare private agent: Runtime;
    declare private onConfirm: Runtime;
    declare private archiveMemory: boolean;
    /**
     * @param {App} app
     * @param {Object} plugin - PKM Assistant plugin instance
     * @param {Agent} agent - Agent to delete
     * @param {Function|null} onConfirm - Callback after deletion
     */
    constructor(app: Runtime, plugin: Runtime, agent: Runtime, onConfirm: Runtime = null) {
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
        // E2.8 A6 (S25): agent wbudowany (Jaskier) jest nieusuwalny — przycisk zablokowany (defense in depth).
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
        } catch (error: Runtime) {
            new Notice(t('modal.agent_delete.error', { error: error.message }));
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
export function openAgentDeleteModal(plugin: Runtime, agent: Runtime, onConfirm: Runtime = null): void {
    new AgentDeleteModal(plugin.app, plugin, agent, onConfirm).open();
}
