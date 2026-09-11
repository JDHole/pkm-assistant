/**
 * HiddenFileEditorModal - edytor/podgląd pojedynczego pliku (playbook/vault_map/prompt/...).
 *
 * Żywi konsumenci: profile_helpers (openHiddenFile), profile_permissions (podgląd vault_map),
 * profile_prompt (podgląd system promptu). Modal na cały ekran z krysztalowym nagłówkiem agenta.
 */
import { Modal, MarkdownRenderer, Notice, Component } from 'obsidian';
import agent_profile_styles from './HiddenFileEditorModal.css' with { type: 'css' };
import { SkinManager, UiIcons, SvgHelper, setSvgLabel, adoptSheet } from '../../crystal-soul/index.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';

interface HiddenFileEditorOptions {
    agentName?: string;
    agentColor?: string;
    readOnly?: boolean;
}

export class HiddenFileEditorModal extends Modal {
    declare filePath: string;
    declare title: string;
    declare originalContent: string;
    declare agentName: string;
    declare agentColor: string;
    declare readOnly: boolean;
    declare textarea: HTMLTextAreaElement;
    declare _renderChild: Component | null;
    /**
     * @param {App} app
     * @param {string} filePath
     * @param {string} title
     * @param {string} content
     * @param {Object} [opts] - { agentName, agentColor, readOnly }
     */
    constructor(app: ConstructorParameters<typeof Modal>[0], filePath: string, title: string, content: string, opts: HiddenFileEditorOptions = {}) {
        super(app);
        this.filePath = filePath;
        this.title = title;
        this.originalContent = content;
        this.agentName = opts.agentName || '';
        this.agentColor = opts.agentColor || '';
        this.readOnly = opts.readOnly || false;
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();

        // Adopt CSS if not already adopted: adoptSheet zapewnia, że demontaż pluginu zdejmuje
        // arkusz, zamiast zostawiać go w dokumencie do restartu.
        adoptSheet(agent_profile_styles);

        contentEl.addClass('cs-file-editor-modal');

        // Force large modal - rozmiary w HiddenFileEditorModal.css
        if (modalEl) {
            modalEl.addClass('cs-file-editor-modal-container');
        }

        // Set agent color CSS variables
        const agentColor = this.agentColor || '';
        if (agentColor) {
            const target = modalEl || contentEl;
            target.style.setProperty('--cs-agent-color', agentColor);
            const hex = agentColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            target.style.setProperty('--cs-agent-color-rgb', `${r},${g},${b}`);
        }

        // ── Crystal header with agent identity ──
        const header = contentEl.createDiv({ cls: 'cs-file-editor__header' });

        // Agent crystal + title row
        const titleRow = header.createDiv({ cls: 'cs-file-editor__title-row' });
        if (this.agentName) {
            const crystalSvg = SkinManager.getCrystal({ name: this.agentName, color: this.agentColor }, {
                size: 28, color: this.agentColor || 'var(--interactive-accent)', glow: true
            });
            const crystalEl = SvgHelper.toElement(crystalSvg);
            if (crystalEl) titleRow.appendChild(crystalEl);
        }
        const titleInfo = titleRow.createDiv({ cls: 'cs-file-editor__title-info' });
        titleInfo.createDiv({ text: this.title, cls: 'cs-file-editor__title' });
        titleInfo.createDiv({ text: this.filePath, cls: 'cs-file-editor__path' });

        if (this.readOnly) {
            // ── Read-only preview ──
            const previewShard = contentEl.createDiv({ cls: 'cs-file-editor__shard cs-file-editor__shard--preview' });

            // Strip YAML frontmatter
            let displayContent = this.originalContent || '';
            const fmMatch = displayContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
            if (fmMatch) displayContent = displayContent.slice(fmMatch[0].length);

            // Try MarkdownRenderer first, fallback to plain text
            try {
                const renderChild = new Component();
                renderChild.load();
                this._renderChild = renderChild;
                await MarkdownRenderer.render(this.app, displayContent, previewShard, this.filePath || '', renderChild);
                // If render produced nothing, fallback
                if (!(previewShard.textContent ?? '').trim()) {
                    previewShard.empty();
                    previewShard.createEl('pre', { text: displayContent, cls: 'cs-file-editor__plaintext' });
                }
            } catch (e) {
                log.error('HiddenFileEditor', 'MarkdownRenderer failed:', e);
                previewShard.createEl('pre', { text: displayContent, cls: 'cs-file-editor__plaintext' });
            }

            // ── Bottom bar ──
            const bar = contentEl.createDiv({ cls: 'cs-file-editor__bar' });
            const stats = bar.createSpan({ cls: 'cs-file-editor__stats' });
            const lines = this.originalContent.split('\n').length;
            stats.textContent = t('modal.agent_profile.chars_lines_preview', { chars: this.originalContent.length, lines });

            const actions = bar.createDiv({ cls: 'cs-file-editor__actions' });
            const closeBtn = actions.createEl('button', { cls: 'cs-preset-btn' });
            setSvgLabel(closeBtn, UiIcons.cross(12), t('generic.close'));
            closeBtn.addEventListener('click', () => this.close());
        } else {
            // ── Editor shard (textarea) ──
            const editorShard = contentEl.createDiv({ cls: 'cs-file-editor__shard' });
            this.textarea = editorShard.createEl('textarea', {
                cls: 'cs-file-editor__textarea'
            });
            this.textarea.value = this.originalContent;
            this.textarea.spellcheck = false;

            // ── Bottom bar ──
            const bar = contentEl.createDiv({ cls: 'cs-file-editor__bar' });
            const stats = bar.createSpan({ cls: 'cs-file-editor__stats' });
            const updateStats = () => {
                const val = this.textarea.value;
                const lines = val.split('\n').length;
                stats.textContent = t('modal.agent_profile.chars_lines', { chars: val.length, lines });
            };
            updateStats();
            this.textarea.addEventListener('input', updateStats);

            const actions = bar.createDiv({ cls: 'cs-file-editor__actions' });
            const closeBtn = actions.createEl('button', { cls: 'cs-preset-btn' });
            setSvgLabel(closeBtn, UiIcons.cross(12), t('generic.close'));
            closeBtn.addEventListener('click', () => this.close());

            const saveBtn = actions.createEl('button', { cls: 'cs-preset-btn cs-preset-btn--agent' });
            setSvgLabel(saveBtn, UiIcons.save(12), t('generic.save'));
            saveBtn.addEventListener('click', () => {
                void (async () => {
                    try {
                        await this.app.vault.adapter.write(this.filePath, this.textarea.value);
                        new Notice(t('modal.agent_profile.saved'));
                        this.close();
                    } catch (e: unknown) {
                        new Notice(t('modal.agent_profile.save_file_error', { error: (e as Error).message }));
                    }
                })();
            });
        }
    }

    onClose() {
        if (this._renderChild) {
            this._renderChild.unload();
            this._renderChild = null;
        }
        this.contentEl.empty();
    }
}
