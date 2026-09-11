/**
 * SkillEditorModal
 * Creator/Editor modal for Skills (v2 format, agentskills.io compatible).
 * Pattern: same as MinionMasterEditorModal.
 *
 * Siatka „Dozwolone narzędzia" (pole-fasada `allowed-tools`) jest WYCIĘTA — nic jej
 *   nie egzekwowało, a pokazywała martwe nazwy narzędzi z TOOL_INFO.
 */
import { Modal, Setting, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { UiIcons, setSvgLabel } from '../crystal-soul/index.js';
import { confirmModal } from '../ui-components/index.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import type { SkillData, SkillInput, SkillQuestion, SkillsPlugin } from './types.js';
import type { SkillTemplateRecord } from './SkillTemplateStore.js';

/** Suggested categories (user can type anything) */
const CATEGORY_SUGGESTIONS = ['productivity', 'writing', 'organization', 'analysis', 'system', 'creative'];

// Przykładowe wartości placeholderów pól tekstowych — celowo małe litery (format faktycznych
// danych: slug kategorii z CATEGORY_SUGGESTIONS / lista tagów), w stałej a nie literale inline.
const CATEGORY_PLACEHOLDER = 'productivity';
const TAGS_PLACEHOLDER = 'weekly, review, planning';

export class SkillEditorModal extends Modal {
    declare plugin: SkillsPlugin;
    declare existing: SkillData | SkillTemplateRecord | null;
    declare onSave: ((data?: SkillInput) => void) | null;
    declare isEditMode: boolean;
    declare isTemplate: boolean;
    declare offerTemplateCopy: boolean;
    declare _alsoTemplate: boolean;
    /**
     * @param {Object} app - Obsidian App
     * @param {Object} plugin - Plugin instance
     * @param {Object|null} existing - Existing skill object for edit mode, null for create
     * @param {Function} [onSave] - Callback after successful save/delete
     * @param {Object} [options]
     * @param {boolean} [options.template] - tryb SZABLONU (zapis do
     *        `.pkm-assistant/templates/skills/`, wersja podbijana przez store, nie przez usera).
     * @param {boolean} [options.alsoTemplate] - pokaż checkbox „Zapisz też jako szablon"
     *        (tworzenie żywego skilla u agenta — pętla szablonów domknięta).
     */
    constructor(app: App, plugin: SkillsPlugin, existing: SkillData | SkillTemplateRecord | null = null, onSave: ((data?: SkillInput) => void) | null = null, options: { template?: boolean; alsoTemplate?: boolean } = {}) {
        super(app);
        this.plugin = plugin;
        this.existing = existing;
        this.onSave = onSave;
        this.isEditMode = !!existing;
        this.isTemplate = options.template === true;
        this.offerTemplateCopy = options.alsoTemplate === true && !this.isTemplate && !this.isEditMode;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('skill-editor-modal');

        let title;
        if (this.isTemplate) {
            title = this.isEditMode
                ? t('modal.skill_editor.edit_template_title', { name: this.existing!.name })
                : t('modal.skill_editor.new_template_title');
        } else {
            title = this.isEditMode
                ? t('modal.skill_editor.edit_title', { name: this.existing!.name })
                : t('modal.skill_editor.new_title');
        }

        contentEl.createEl('h3', { text: title });
        if (this.isTemplate) {
            contentEl.createEl('p', {
                text: t('modal.skill_editor.template_hint'),
                cls: 'setting-item-description',
            });
        }

        // Form data
        // `slug` niesie identyfikator na cache/folder z `existing` — w
        // trybie edycji `SkillLoader.saveSkill` musi pisać do folderu, z którego skill NAPRAWDĘ
        // został wczytany, a nie przeliczać go z (możliwie ręcznie zmienionej) nazwy.
        const formData = {
            slug: this.existing?.slug,
            name: this.existing?.name || '',
            description: this.existing?.description || '',
            icon: this.existing?.icon || '🎯',
            category: this.existing?.category || 'general',
            tags: [...(this.existing?.tags || [])],
            version: this.existing?.version ?? 1,
            enabled: this.existing?.enabled !== false,
            model: this.existing?.model || '',
            disableModelInvocation: this.existing?.disableModelInvocation ?? false,
            userInvocable: this.existing?.userInvocable !== false,
            preQuestions: JSON.parse(JSON.stringify(this.existing?.preQuestions || [])) as SkillQuestion[],
            prompt: this.existing?.prompt || ''
        };

        // ─── BASIC INFO ───

        // Name
        new Setting(contentEl)
            .setName(t('modal.skill_editor.name_label'))
            .setDesc(t('modal.skill_editor.name_desc'))
            .addText(text => {
                text.setPlaceholder(t('modal.skill_editor.name_placeholder'))
                    .setValue(formData.name)
                    .onChange(v => formData.name = v.trim());
                if (this.isEditMode) text.inputEl.disabled = true;
            });

        // Description
        new Setting(contentEl)
            .setName(t('modal.skill_editor.desc_label'))
            .setDesc(t('modal.skill_editor.desc_desc'))
            .addTextArea(text => {
                text.setPlaceholder(t('modal.skill_editor.desc_placeholder'))
                    .setValue(formData.description)
                    .onChange(v => formData.description = v.trim());
                text.inputEl.rows = 3;
                text.inputEl.addClass('pkm-editor-input-full');
            });

        // Icon + Category row
        new Setting(contentEl)
            .setName(t('modal.skill_editor.icon_label'))
            .setDesc(t('modal.skill_editor.icon_desc'))
            .addText(text => {
                text.setPlaceholder('🎯')
                    .setValue(formData.icon)
                    .onChange(v => formData.icon = v.trim() || '🎯');
                text.inputEl.addClass('pkm-editor-input-icon');
            });

        // Category with suggestions
        new Setting(contentEl)
            .setName(t('modal.skill_editor.category_label'))
            .setDesc(t('modal.skill_editor.category_desc'))
            .addText(text => {
                // Przykładowa wartość sluga — celowo małe litery, zgodne z CATEGORY_SUGGESTIONS
                // (wartość w stałej, nie literał inline — obsidianmd/ui/sentence-case bada
                // literały string przekazane wprost do setPlaceholder/setName/setDesc).
                text.setPlaceholder(CATEGORY_PLACEHOLDER)
                    .setValue(formData.category)
                    .onChange(v => formData.category = v.trim() || 'general');
                // Add datalist for suggestions
                const dl = contentEl.createEl('datalist', { attr: { id: 'skill-cat-list' } });
                for (const cat of CATEGORY_SUGGESTIONS) {
                    dl.createEl('option', { attr: { value: cat } });
                }
                text.inputEl.setAttribute('list', 'skill-cat-list');
            });

        // Tags
        new Setting(contentEl)
            .setName(t('modal.skill_editor.tags_label'))
            .setDesc(t('modal.skill_editor.tags_desc'))
            .addText(text => {
                text.setPlaceholder(TAGS_PLACEHOLDER)
                    .setValue((formData.tags || []).join(', '))
                    .onChange(v => {
                        formData.tags = v.split(',').map(t => t.trim()).filter(Boolean);
                    });
            });

        // ─── ADVANCED SETTINGS ───

        const advHeader = contentEl.createEl('h4', { cls: 'skill-section-header' });
        setSvgLabel(advHeader, UiIcons.settings(18), t('modal.skill_editor.advanced_header'));

        // Version — w trybie szablonu wersją steruje store (bump przy każdej edycji),
        // więc pole jest tylko do odczytu jako informacja.
        if (this.isTemplate) {
            new Setting(contentEl)
                .setName(t('modal.skill_editor.version_label'))
                .setDesc(t('modal.skill_editor.template_version_desc'))
                .addText(text => {
                    text.inputEl.disabled = true;
                    text.inputEl.addClass('pkm-editor-input-narrow');
                    text.setValue(`v${formData.version}`);
                });
        } else {
            new Setting(contentEl)
                .setName(t('modal.skill_editor.version_label'))
                .addText(text => {
                    text.inputEl.type = 'number';
                    text.inputEl.min = '1';
                    text.inputEl.addClass('pkm-editor-input-narrow');
                    text.setValue(String(formData.version))
                        .onChange(v => formData.version = parseInt(v) || 1);
                });
        }

        // Enabled
        new Setting(contentEl)
            .setName(t('modal.skill_editor.active_label'))
            .setDesc(t('modal.skill_editor.enabled_desc'))
            .addToggle(toggle => {
                toggle.setValue(formData.enabled).onChange(v => formData.enabled = v);
            });

        // Model override
        new Setting(contentEl)
            .setName(t('modal.skill_editor.model_label'))
            .setDesc(t('modal.skill_editor.model_desc'))
            .addText(text => {
                text.setPlaceholder(t('modal.skill_editor.model_placeholder'))
                    .setValue(formData.model || '')
                    .onChange(v => formData.model = (v.trim() || null) as string);
            });

        // Auto-invoke (inverted disable-model-invocation)
        new Setting(contentEl)
            .setName(t('modal.skill_editor.auto_invoke_label'))
            .setDesc(t('modal.skill_editor.auto_invoke_desc'))
            .addToggle(toggle => {
                toggle.setValue(!formData.disableModelInvocation)
                    .onChange(v => formData.disableModelInvocation = !v);
            });

        // User-invocable (visible in UI)
        new Setting(contentEl)
            .setName(t('modal.skill_editor.visible_label'))
            .setDesc(t('modal.skill_editor.visible_desc'))
            .addToggle(toggle => {
                toggle.setValue(formData.userInvocable)
                    .onChange(v => formData.userInvocable = v);
            });

        // ─── PRE-QUESTIONS ───

        const pqHeader = contentEl.createEl('h4', { cls: 'skill-section-header' });
        setSvgLabel(pqHeader, UiIcons.question(18), t('modal.skill_editor.pre_questions_header'));
        const pqNote = contentEl.createEl('p', {
            text: t('modal.skill_editor.pre_questions_desc'),
            cls: 'setting-item-description'
        });
        pqNote.addClass('pkm-editor-note');

        const pqContainer = contentEl.createDiv({ cls: 'skill-prequestions-list' });

        const renderPreQuestions = () => {
            pqContainer.empty();

            for (let i = 0; i < formData.preQuestions.length; i++) {
                const pq = formData.preQuestions[i];
                const row = pqContainer.createDiv({ cls: 'skill-pq-row' });

                // Key (variable name)
                const keyInput = row.createEl('input', {
                    type: 'text', placeholder: t('modal.skill_editor.pq_key_placeholder'),
                    value: pq.key || '',
                    cls: 'skill-pq-input skill-pq-input--key'
                });
                keyInput.addEventListener('input', () => pq.key = keyInput.value.trim());

                // Question text
                const qInput = row.createEl('input', {
                    type: 'text', placeholder: t('modal.skill_editor.pq_question_placeholder'),
                    value: pq.question || '',
                    cls: 'skill-pq-input skill-pq-input--question'
                });
                qInput.addEventListener('input', () => pq.question = qInput.value);

                // Default value
                const defInput = row.createEl('input', {
                    type: 'text', placeholder: t('modal.skill_editor.pq_default_placeholder'),
                    value: pq.default || '',
                    cls: 'skill-pq-input skill-pq-input--default'
                });
                defInput.addEventListener('input', () => pq.default = defInput.value);

                // Delete button
                const delBtn = row.createEl('button', { text: '✕', cls: 'skill-pq-delete' });
                delBtn.addEventListener('click', () => {
                    formData.preQuestions.splice(i, 1);
                    renderPreQuestions();
                });
            }
        };

        renderPreQuestions();

        // Add question button
        const addPqBtn = contentEl.createEl('button', {
            text: t('modal.skill_editor.add_question'),
            cls: 'skill-pq-add-btn'
        });
        addPqBtn.addEventListener('click', () => {
            formData.preQuestions.push({ key: '', question: '', default: '' });
            renderPreQuestions();
        });

        // ─── PROMPT ───

        const promptHeader = contentEl.createEl('h4', { cls: 'skill-section-header' });
        setSvgLabel(promptHeader, UiIcons.edit(18), t('modal.skill_editor.prompt_header'));
        const promptNote = contentEl.createEl('p', {
            text: t('modal.skill_editor.prompt_desc'),
            cls: 'setting-item-description'
        });
        promptNote.addClass('pkm-editor-note');

        const textarea = contentEl.createEl('textarea', {
            cls: 'skill-prompt-textarea',
            placeholder: t('modal.skill_editor.prompt_placeholder')
        });
        textarea.value = formData.prompt;
        textarea.addEventListener('input', () => formData.prompt = textarea.value);

        // ─── „Zapisz też jako szablon w Zapleczu" ───
        // Tworzenie żywego skilla u agenta może od razu dołożyć formę odlewniczą do Zaplecza.
        if (this.offerTemplateCopy) {
            new Setting(contentEl)
                .setName(t('modal.skill_editor.also_template_label'))
                .setDesc(t('modal.skill_editor.also_template_desc'))
                .addToggle(toggle => {
                    toggle.setValue(false).onChange(v => { this._alsoTemplate = v; });
                });
        }

        // ─── ACTIONS ───

        const actions = contentEl.createDiv({ cls: 'editor-modal-actions' });

        // Save
        const saveBtn = actions.createEl('button', { cls: 'mod-cta' });
        setSvgLabel(saveBtn,
            this.isEditMode ? UiIcons.save(16) : UiIcons.sparkle(16),
            this.isEditMode
                ? t('modal.skill_editor.save_changes')
                : (this.isTemplate ? t('modal.skill_editor.create_template') : t('modal.skill_editor.create_skill')));
        saveBtn.addEventListener('click', () => { void this._handleSave(formData); });

        // Delete (edit mode only)
        if (this.isEditMode) {
            const deleteBtn = actions.createEl('button', { cls: 'skill-delete-btn' });
            setSvgLabel(deleteBtn, UiIcons.trash(16), t('modal.skill_editor.delete_btn'));
            deleteBtn.addEventListener('click', () => { void this._handleDelete(); });
        }
    }

    async _handleSave(formData: SkillInput) {
        if (!formData.name.trim()) {
            new Notice(t('modal.skill_editor.name_required'));
            return;
        }
        if (!formData.description.trim()) {
            new Notice(t('modal.skill_editor.desc_required'));
            return;
        }

        // Clean pre-questions: remove entries with empty key or question
        formData.preQuestions = (formData.preQuestions || []).filter((pq) => pq.key && pq.question);

        try {
            // Tryb SZABLONU zapisuje do magazynu Zaplecza, nie do żywych skilli.
            if (this.isTemplate) {
                const store = this.plugin.agentManager?.skillTemplateStore;
                if (!store) {
                    new Notice(t('modal.skill_editor.loader_unavailable'));
                    return;
                }
                // Adnotacja: `save`/`createFromData` mają RÓŻNE kształty zwrotki (jedna niesie
                // `version`, druga `name`+`renamed`) — oba są strukturalnie zgodne z tym szerszym
                // typem (brakujące pole jest tu opcjonalne), więc przypisanie nie zwęża go z
                // powrotem do unii, na której `result.version`/`result.name` niżej by nie istniały.
                const result: { success: boolean; slug?: string; name?: string; version?: number; renamed?: boolean; error?: string } = this.isEditMode
                    ? await store.save(this.existing!.slug, formData)
                    : await store.createFromData(formData);
                if (!result?.success) {
                    new Notice(t('modal.skill_editor.save_error', { error: result?.error || '?' }));
                    return;
                }
                new Notice(result.version
                    ? t('modal.skill_editor.template_saved_bumped', { name: formData.name, version: result.version })
                    : t('modal.skill_editor.template_saved', { name: result.name || formData.name }));
                if (this.onSave) this.onSave();
                this.close();
                return;
            }

            const skillLoader = this.plugin.agentManager?.skillLoader;

            if (!skillLoader) {
                new Notice(t('modal.skill_editor.loader_unavailable'));
                return;
            }

            await skillLoader.saveSkill(formData);

            // Opcjonalna forma odlewnicza obok żywego skilla.
            if (this._alsoTemplate) {
                const store = this.plugin.agentManager?.skillTemplateStore;
                const created = await store?.createFromData({ ...formData, fromTemplate: null });
                if (created?.success) {
                    new Notice(t('modal.skill_editor.template_saved', { name: created.name }));
                }
            }

            new Notice(t('modal.skill_editor.saved', { name: formData.name }));
            if (this.onSave) this.onSave(formData);
            this.close();
        } catch (e) {
            log.error('SkillEditorModal', 'Save error:', e);
            new Notice(t('modal.skill_editor.save_error', { error: (e as { message?: string }).message }));
        }
    }

    async _handleDelete() {
        if (!this.existing?.name) return;

        const okToDelete = await confirmModal(this.app, {
            title: t('generic.delete'),
            message: t('modal.skill_editor.confirm_delete', { name: this.existing.name }),
            destructive: true,
        });
        if (!okToDelete) return;

        try {
            if (this.isTemplate) {
                await this.plugin.agentManager?.skillTemplateStore?.delete(this.existing.slug);
            } else {
                const skillLoader = this.plugin.agentManager?.skillLoader;
                if (!skillLoader) {
                    new Notice(t('modal.skill_editor.loader_unavailable'));
                    return;
                }
                // Sukces pokazujemy tylko gdy loader potwierdzi kasację
                const deleted = await skillLoader.deleteSkill(this.existing.name);
                if (!deleted) {
                    new Notice(t('modal.skill_editor.delete_not_found'));
                    return;
                }
            }

            new Notice(t('modal.skill_editor.deleted', { name: this.existing.name }));
            if (this.onSave) this.onSave();
            this.close();
        } catch (e) {
            log.error('SkillEditorModal', 'Delete error:', e);
            new Notice(t('modal.skill_editor.delete_error', { error: (e as { message?: string }).message }));
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
