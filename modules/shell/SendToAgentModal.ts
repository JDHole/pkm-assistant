/**
 * SendToAgentModal
 * Mini-modal for sending selected text to an agent's inbox.
 * Triggered from editor context menu.
 */
import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { UiIcons, setSvgLabel } from '../../modules/crystal-soul/index.js';
import { truncatePreview } from '../../modules/ui-components/index.js';
import { t } from '../../core/i18n/index.js';

interface AgentSummary {
    name: string;
}

interface SendMessageResult {
    success?: boolean;
    error?: string;
}

interface KomunikatorLike {
    sendMessage(from: string, to: string, subject: string, body: string): Promise<SendMessageResult>;
}

interface AgentManagerLike {
    komunikatorManager?: KomunikatorLike;
    listKomunikatorAgents(): AgentSummary[];
    getActiveAgent(): AgentSummary | null | undefined;
    _emit(event: string): void;
}

interface SendToAgentPluginLike {
    agentManager?: AgentManagerLike;
}

export class SendToAgentModal extends Modal {
    declare private plugin: SendToAgentPluginLike;
    declare private selectedText: string;
    declare private filePath: string;
    /**
     * @param {App} app
     * @param {Object} plugin
     * @param {string} selectedText - The text user selected in the editor
     * @param {string} filePath - Path of the file where text was selected
     */
    constructor(app: App, plugin: SendToAgentPluginLike, selectedText: string, filePath: string) {
        super(app);
        this.plugin = plugin;
        this.selectedText = selectedText;
        this.filePath = filePath;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('send-to-agent-modal');

        // Title
        const h3 = contentEl.createEl('h3');
        setSvgLabel(h3, UiIcons.send(18), t('modal.send_to_agent.title'));

        // Selected text preview
        const preview = contentEl.createDiv({
            cls: 'send-to-agent-preview pkm-selection-preview'
        });
        preview.textContent = truncatePreview(this.selectedText);

        // File path hint
        if (this.filePath) {
            contentEl.createEl('p', {
                cls: 'pkm-selection-path-hint',
                text: t('modal.send_to_agent.from_file', { path: this.filePath })
            });
        }

        // Agent dropdown
        const agentRow = contentEl.createDiv({ cls: 'send-to-agent-row' });
        agentRow.createEl('label', { text: t('modal.send_to_agent.to_label'), cls: 'send-to-agent-label' });

        const agentSelect = agentRow.createEl('select', { cls: 'send-to-agent-select' });

        const agentManager = this.plugin.agentManager;
        if (agentManager) {
            // S28 D6: tylko agenci uczestniczący w komunikatorze (duchy nie są adresatami).
            const agents = agentManager.listKomunikatorAgents();
            for (const agent of agents) {
                const opt = agentSelect.createEl('option', {
                    value: agent.name,
                    text: agent.name
                });
                // Pre-select active agent
                if (agent.name === agentManager.getActiveAgent()?.name) {
                    opt.selected = true;
                }
            }
        }

        // Comment textarea
        const commentRow = contentEl.createDiv({ cls: 'send-to-agent-row send-to-agent-row--comment' });
        commentRow.createEl('label', { text: t('modal.send_to_agent.comment_label'), cls: 'send-to-agent-label send-to-agent-label--comment' });

        const commentArea = commentRow.createEl('textarea', {
            cls: 'send-to-agent-comment',
            placeholder: t('modal.send_to_agent.comment_placeholder')
        });
        commentArea.rows = 2;

        // Buttons
        const buttons = contentEl.createDiv({ cls: 'send-to-agent-buttons' });

        const cancelBtn = buttons.createEl('button', { text: t('generic.cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        const sendBtn = buttons.createEl('button', {
            cls: 'mod-cta'
        });
        setSvgLabel(sendBtn, UiIcons.send(14), t('generic.send'));

        sendBtn.addEventListener('click', () => {
            void (async () => {
                const toAgent = agentSelect.value;
                if (!toAgent) {
                    new Notice(t('modal.send_to_agent.select_agent'));
                    return;
                }

                const komunikator = this.plugin.agentManager?.komunikatorManager;
                if (!komunikator) {
                    new Notice(t('modal.send_to_agent.communicator_unavailable'));
                    return;
                }

                try {
                    const comment = commentArea.value.trim();
                    const subject = comment
                        ? comment.slice(0, 60)
                        : t('modal.send_to_agent.fragment_from', { path: this.filePath || 'notatki' });
                    // S28 (D2): wiadomość nie ma osobnego pola `kontekst` — doklejamy je do treści.
                    const context = this.filePath
                        ? `${this.filePath}${comment ? ' | ' + comment : ''}`
                        : comment || '';
                    const body = context
                        ? `${this.selectedText}\n\n${t('communicator.field.context')}: ${context}`
                        : this.selectedText;

                    const res = await komunikator.sendMessage('User', toAgent, subject, body);
                    if (!res?.success) {
                        new Notice(res?.error || t('modal.send_to_agent.error', { error: '' }));
                        return;
                    }
                    this.plugin.agentManager?._emit('communicator:message_sent');
                    new Notice(t('modal.send_to_agent.sent', { agent: toAgent }));
                    this.close();
                } catch (e) {
                    new Notice(t('modal.send_to_agent.error', { error: (e as Error).message }));
                }
            })();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
