/**
 * InlineCommentModal
 * Mini-modal for sending inline edit comments to the active agent.
 * User selects text → right-click → "Komentarz do Asystenta" → writes what to change.
 * Agent receives formatted message and edits the file directly via vault_write.
 */
import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { UiIcons, setSvgLabel } from '../../modules/crystal-soul/index.js';
import { truncatePreview } from '../../modules/ui-components/index.js';
import { t } from '../../core/i18n/index.js';

interface InlineCommentPluginLike {
    sendInlineComment(filePath: string, selectedText: string, comment: string): unknown;
}

export class InlineCommentModal extends Modal {
    declare private plugin: InlineCommentPluginLike;
    declare private selectedText: string;
    declare private filePath: string;
    /**
     * @param {App} app
     * @param {Object} plugin
     * @param {string} selectedText - The text user selected in the editor
     * @param {string} filePath - Path of the file where text was selected
     */
    constructor(app: App, plugin: InlineCommentPluginLike, selectedText: string, filePath: string) {
        super(app);
        this.plugin = plugin;
        this.selectedText = selectedText;
        this.filePath = filePath;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('inline-comment-modal');

        const h3 = contentEl.createEl('h3');
        setSvgLabel(h3, UiIcons.edit(18), t('modal.inline_comment.title'));

        // Selection preview (read-only)
        const preview = contentEl.createDiv({ cls: 'pkm-selection-preview' });
        preview.textContent = truncatePreview(this.selectedText);

        // File path hint
        if (this.filePath) {
            contentEl.createEl('p', {
                cls: 'pkm-selection-path-hint',
                text: t('modal.inline_comment.file_path', { path: this.filePath })
            });
        }

        // Comment textarea
        contentEl.createEl('label', { text: t('modal.inline_comment.what_to_change'), cls: 'inline-comment-label' });

        const commentArea = contentEl.createEl('textarea', {
            cls: 'inline-comment-area',
            placeholder: t('modal.inline_comment.placeholder')
        });
        commentArea.rows = 3;

        // Buttons
        const buttons = contentEl.createDiv({ cls: 'inline-comment-buttons' });

        const cancelBtn = buttons.createEl('button', { text: t('generic.cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        const sendBtn = buttons.createEl('button', {
            cls: 'mod-cta'
        });
        setSvgLabel(sendBtn, UiIcons.edit(14), t('generic.edit'));

        sendBtn.addEventListener('click', () => {
            const comment = commentArea.value.trim();
            if (!comment) {
                new Notice(t('modal.inline_comment.empty_comment'));
                return;
            }
            this.plugin.sendInlineComment(this.filePath, this.selectedText, comment);
            this.close();
        });

        // Focus textarea
        window.setTimeout(() => commentArea.focus(), 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}
