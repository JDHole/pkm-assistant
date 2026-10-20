/**
 * SubAgentEditorModal
 * Unified Creator/Editor modal for Sub-Agents (researchers + strategists).
 * Replaces MinionMasterEditorModal.
 */
import { Modal, Setting, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { TOOL_INFO, confirmModal } from '../ui-components/index.js';
import { UiIcons, setSvgLabel } from '../crystal-soul/index.js';
import { getModelsForRole } from '../models/index.js';
import type { PkmModelSettings } from '../models/index.js';
import { t } from '../../core/i18n/index.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import { log } from '../../core/utils/Logger.js';
import { resolveDeleteOutcome, templateCopyNames, templateDeleteConfirmation } from './deleteOutcome.js';
import type { SubAgentData, SubAgentInput, SubAgentsPlugin } from './types.js';
import type { SubAgentTemplateRecord } from './SubAgentTemplateStore.js';
import { EDITOR_DEFAULT_MIN_ITERATIONS, EDITOR_DEFAULT_TOOLS, editorModelOptions, initialAdvancedOpen, maxIterationsBounds, modelListRoleForEditorRole, templateSaveNotice, validateMaxIterations } from './editorDecisions.js';


export class SubAgentEditorModal extends Modal {
    declare plugin: SubAgentsPlugin;
    declare role: string;
    declare existing: SubAgentData | SubAgentTemplateRecord | null;
    declare onSave: ((data?: SubAgentInput) => void) | null;
    declare isEditMode: boolean;
    declare isTemplate: boolean;
    declare offerTemplateCopy: boolean;
    declare _alsoTemplate: boolean;
    declare _maxIterationsRaw: string;
    /**
     * @param {Object} app - Obsidian App
     * @param {Object} plugin - Plugin instance
     * @param {Object|null} existing - Existing config for edit mode, null for create
     * @param {Function} [onSave] - Callback after successful save
     * @param {Object} [options]
     * @param {boolean} [options.template] - tryb SZABLONU (zapis do
     *        `.pkm-assistant/templates/sub-agents/`, wersja podbijana przez store).
     * @param {boolean} [options.alsoTemplate] - checkbox „Zapisz też jako szablon".
     */
    constructor(app: App, plugin: SubAgentsPlugin, existing: SubAgentData | SubAgentTemplateRecord | null = null, onSave: ((data?: SubAgentInput) => void) | null = null, options: { template?: boolean; alsoTemplate?: boolean } = {}) {
        super(app);
        this.plugin = plugin;
        this.role = existing?.role || 'researcher';
        this.existing = existing;
        this.onSave = onSave;
        this.isEditMode = !!existing;
        this.isTemplate = options.template === true;
        this.offerTemplateCopy = options.alsoTemplate === true && !this.isTemplate && !this.isEditMode;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sub-agent-editor-modal');

        let title;
        if (this.isTemplate) {
            title = this.isEditMode
                ? t('modal.sub_agent.edit_template', { name: this.existing!.name })
                : t('modal.sub_agent.new_template');
        } else {
            title = this.isEditMode
                ? t('modal.sub_agent.edit', { name: this.existing!.name })
                : t('modal.sub_agent.new');
        }
        const entityName = 'sub-agent';

        contentEl.createEl('h3', { text: title });
        if (this.isTemplate) {
            contentEl.createEl('p', {
                text: t('modal.sub_agent.template_hint'),
                cls: 'setting-item-description',
            });
        }

        const defaultTools = [...EDITOR_DEFAULT_TOOLS];

        // Form data
        const formData = {
            name: this.existing?.name || '',
            description: this.existing?.description || '',
            role: this.existing?.role || this.role,
            model: this.existing?.model || '',
            tools: [...(this.existing?.tools || defaultTools)],
            scope: {
                folders: [...(this.existing?.scope?.folders || [])],
                frontmatter: { ...(this.existing?.scope?.frontmatter || {}) },
                sections: [...(this.existing?.scope?.sections || [])],
                pinned_notes: [...(this.existing?.scope?.pinned_notes || [])],
            },
            max_iterations: this.existing?.max_iterations ?? DEFAULT_LIMITS.subagent_max_iterations_worker,
            min_iterations: this.existing?.min_iterations ?? EDITOR_DEFAULT_MIN_ITERATIONS,
            max_tool_result_length: this.existing?.max_tool_result_length ?? DEFAULT_LIMITS.max_tool_result_length,
            enabled: this.existing?.enabled !== false,
            prompt: this.existing?.prompt || ''
        };
        let refreshModelOptions: ((role: string) => void) | null = null;
        let saveButton: HTMLButtonElement | null = null;

        // --- Name ---
        new Setting(contentEl)
            .setName(t('modal.sub_agent.name_label'))
            .setDesc(t('modal.sub_agent.name_desc'))
            .addText(text => {
                text.setPlaceholder(t('modal.sub_agent.name_placeholder'))
                    .setValue(formData.name)
                    .onChange(v => formData.name = v.trim());
                if (this.isEditMode && !this.isTemplate) text.inputEl.disabled = true;
            });

        // --- Description ---
        new Setting(contentEl)
            .setName(t('modal.sub_agent.desc_label'))
            .setDesc(t('modal.sub_agent.desc_desc'))
            .addText(text => {
                text.setPlaceholder(t('modal.sub_agent.desc_placeholder', { entity: entityName }))
                    .setValue(formData.description)
                    .onChange(v => formData.description = v.trim());
            });

        new Setting(contentEl)
            .setName(t('modal.sub_agent.role_label'))
            .addDropdown(dd => {
                dd.addOption('researcher', t('modal.sub_agent.role_researcher'));
                dd.addOption('worker', t('modal.sub_agent.role_worker'));
                if (formData.role !== 'researcher' && formData.role !== 'worker') {
                    dd.addOption(formData.role, formData.role);
                }
                dd.setValue(formData.role);
                dd.onChange(value => {
                    formData.role = value;
                    refreshModelOptions?.(value);
                });
            });

        // --- Model override ---
        {
            // TS-boundary: `PkmAssistantSettings.modelLibrary` jest `unknown` w kontrakcie core
            // (core/ nie zna kształtu biblioteki modeli); `modules/models` jest właścicielem
            // realnego kształtu (`PkmModelSettings`) i to on czyta to pole w `getModelsForRole`.
            const pkmM = (this.plugin?.env?.settings?.pkmAssistant || {}) as PkmModelSettings;
            const platformNames = { anthropic: 'Anthropic', openai: 'OpenAI', open_router: 'OpenRouter', ollama: 'Ollama', gemini: 'Gemini', groq: 'Groq', deepseek: 'DeepSeek', lm_studio: 'LM Studio' };
            let modelSelect: HTMLSelectElement | null = null;
            const populateModels = (select: HTMLSelectElement, role: string, preserveMissing = false) => {
                const selected = formData.model;
                select.replaceChildren(new Option(t('modal.sub_agent.model_default'), ''));
                const available = getModelsForRole(pkmM, modelListRoleForEditorRole(role));
                const options = editorModelOptions(available, preserveMissing ? selected : '');
                for (const model of options) {
                    const label = model.platform
                        ? `${(platformNames as Record<string, string>)[model.platform] || model.platform} - ${model.model}${model.isDefault ? ' ★' : ''}`
                        : model.model;
                    const option = new Option(label, model.model);
                    select.add(option);
                }
                formData.model = options.some(option => option.model === selected) ? selected : '';
                select.value = formData.model;
            };
            refreshModelOptions = role => {
                if (modelSelect) populateModels(modelSelect, role);
            };

            new Setting(contentEl)
                .setName(t('modal.sub_agent.model_label'))
                .setDesc(t('modal.sub_agent.model_desc'))
                .addDropdown(dd => {
                    modelSelect = dd.selectEl;
                    populateModels(dd.selectEl, formData.role, true);
                    dd.setValue(formData.model || '');
                    dd.onChange(v => formData.model = (v || null) as string);
                });
        }

        const advanced = contentEl.createEl('details');
        advanced.open = initialAdvancedOpen(this.existing ? {
            tools: formData.tools,
            scope: formData.scope,
            max_iterations: formData.max_iterations,
            min_iterations: formData.min_iterations,
            max_tool_result_length: formData.max_tool_result_length,
            enabled: formData.enabled,
        } : null);
        advanced.createEl('summary', { text: t('subagent.editor.advanced') });

        const advancedContent = advanced.createDiv();
        let maxIterationsError: HTMLElement | null = null;
        const initialMaxIterations = validateMaxIterations(String(formData.max_iterations));
        let maxIterationsValid = initialMaxIterations.ok;
        this._maxIterationsRaw = String(formData.max_iterations);

        // --- Iterations ---
        {
            new Setting(advancedContent)
                .setName(t('modal.sub_agent.max_iter_label'))
                .setDesc(t('modal.sub_agent.max_iter_desc'))
                .addText(text => {
                    text.inputEl.type = 'number';
                    // Widełki z LIMIT_SPECS (przez editorDecisions), nie z lokalnego literału.
                    const bounds = maxIterationsBounds();
                    text.inputEl.min = String(bounds.min);
                    text.inputEl.max = String(bounds.max);
                    text.setValue(String(formData.max_iterations))
                        .onChange(value => {
                            this._maxIterationsRaw = value;
                            const result = validateMaxIterations(value);
                            maxIterationsValid = result.ok;
                            if (result.ok) formData.max_iterations = result.value;
                            if (maxIterationsError) maxIterationsError.setText(result.ok ? '' : t(result.errorKey, result.params));
                            if (saveButton) saveButton.disabled = !result.ok;
                        });
                    maxIterationsError = text.inputEl.parentElement?.createEl('p', { cls: 'setting-item-description pkm-validation-error' }) || null;
                    if (!initialMaxIterations.ok && maxIterationsError) maxIterationsError.setText(t(initialMaxIterations.errorKey, initialMaxIterations.params));
                });
        }

        new Setting(advancedContent)
            .setName(t('modal.sub_agent.min_iter_label'))
            .setDesc(t('modal.sub_agent.min_iter_desc'))
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.max = '10';
                text.setValue(String(formData.min_iterations))
                    .onChange(v => formData.min_iterations = parseInt(v) || 1);
            });

        // --- Max tool result length ---
        {
            new Setting(advancedContent)
                .setName(t('modal.sub_agent.tool_result_label'))
                .setDesc(t('modal.sub_agent.tool_result_desc'))
                .addText(text => {
                    text.inputEl.type = 'number';
                    text.inputEl.min = '0';
                    text.inputEl.max = '50000';
                    text.inputEl.step = '1000';
                    text.setValue(String(formData.max_tool_result_length))
                        .onChange(v => formData.max_tool_result_length = parseInt(v) || 0);
                });
        }

        // --- Enabled toggle ---
        new Setting(advancedContent)
            .setName(t('modal.sub_agent.active_label'))
            .addToggle(toggle => {
                toggle.setValue(formData.enabled).onChange(v => formData.enabled = v);
            });

        // --- Tools ---
        const toolsHeader = advancedContent.createEl('h4');
        setSvgLabel(toolsHeader, UiIcons.wrench(18), t('modal.sub_agent.tools_header'));
        toolsHeader.addClass('pkm-editor-section-head');
        const toolsContainer = advancedContent.createDiv({ cls: 'editor-tools-grid' });

        const activeAgent = this.plugin?.agentManager?.getActiveAgent?.();
        const visibleToolNames = this.plugin?.toolRegistry?.filterByAgent
            ? new Set<string>(this.plugin.toolRegistry.filterByAgent(activeAgent).map((tool) => tool.name))
            : null;
        const allToolNames = Object.keys(TOOL_INFO).filter(name => !visibleToolNames || visibleToolNames.has(name));
        for (const toolName of allToolNames) {
            const info = (TOOL_INFO as Record<string, { label: string }>)[toolName];
            new Setting(toolsContainer)
                .setName(info.label)
                .setDesc(toolName)
                .addToggle(toggle => {
                    toggle
                        .setValue(formData.tools.includes(toolName))
                        .onChange(v => {
                            if (v && !formData.tools.includes(toolName)) {
                                formData.tools.push(toolName);
                            } else if (!v) {
                                formData.tools = formData.tools.filter(t => t !== toolName);
                            }
                        });
                });
        }

        // --- Scope ---
        const scopeHeader = advancedContent.createEl('h4');
        setSvgLabel(scopeHeader, UiIcons.folder(18), t('subagent.editor.scope_header'));
        scopeHeader.addClass('pkm-editor-section-head');

        const scopeToText = (arr: string[]) => (arr || []).join('\n');
        const textToScope = (value: string) => value.split('\n').map((v) => v.trim()).filter(Boolean);

        new Setting(advancedContent)
            .setName(t('subagent.editor.folders_name'))
            .setDesc(t('subagent.editor.folders_desc'))
            .addTextArea(text => {
                text.setValue(scopeToText(formData.scope.folders))
                    .onChange(v => formData.scope.folders = textToScope(v));
                text.inputEl.rows = 3;
            });

        const hintsHeader = advancedContent.createEl('h4', { text: t('subagent.editor.hints_header') });
        hintsHeader.addClass('pkm-editor-section-head');
        advancedContent.createEl('p', { text: t('subagent.editor.hints_desc'), cls: 'setting-item-description' });
        if (Object.keys(formData.scope.frontmatter).length > 0) {
            new Setting(advancedContent)
                .setName(t('subagent.editor.frontmatter_name'))
                .setDesc(JSON.stringify(formData.scope.frontmatter));
        }

        new Setting(advancedContent)
            .setName(t('subagent.editor.sections_name'))
            // Przykład nagłówka jest osobnym kluczem (TREŚĆ notatki usera, nie etykieta UI),
            // wstrzykiwanym przez `{{example}}` - ten sam wzorzec co w SkillEditorModal.ts.
            .setDesc(t('subagent.editor.sections_desc', { example: t('subagent.editor.sections_example') }))
            .addTextArea(text => {
                text.setValue(scopeToText(formData.scope.sections))
                    .onChange(v => formData.scope.sections = textToScope(v));
                text.inputEl.rows = 2;
            });

        new Setting(advancedContent)
            .setName(t('subagent.editor.pinned_notes_name'))
            .setDesc(t('subagent.editor.pinned_notes_desc'))
            .addTextArea(text => {
                text.setValue(scopeToText(formData.scope.pinned_notes))
                    .onChange(v => formData.scope.pinned_notes = textToScope(v));
                text.inputEl.rows = 2;
            });

        // --- Instructions textarea ---
        const promptHeader = contentEl.createEl('h4');
        setSvgLabel(promptHeader, UiIcons.edit(18), t('modal.sub_agent.instructions_header'));
        promptHeader.addClass('pkm-editor-section-head');
        const textarea = contentEl.createEl('textarea', {
            cls: 'pkm-editor-prompt-textarea',
            placeholder: t('modal.sub_agent.instructions_placeholder', { entity: entityName })
        });
        textarea.value = formData.prompt;
        textarea.addEventListener('input', () => formData.prompt = textarea.value);

        // --- „Zapisz też jako szablon w Zapleczu" ---
        if (this.offerTemplateCopy) {
            new Setting(contentEl)
                .setName(t('modal.sub_agent.also_template_label'))
                .setDesc(t('modal.sub_agent.also_template_desc'))
                .addToggle(toggle => {
                    toggle.setValue(false).onChange(v => { this._alsoTemplate = v; });
                });
        }

        // --- Action buttons ---
        const actions = contentEl.createDiv({ cls: 'editor-modal-actions' });

        const saveBtn = actions.createEl('button', { cls: 'mod-cta' });
        saveButton = saveBtn;
        setSvgLabel(saveBtn,
            this.isEditMode ? UiIcons.save(16) : UiIcons.sparkle(16),
            this.isEditMode ? t('modal.sub_agent.save_changes') : t('modal.sub_agent.create'));
        saveBtn.addClass('pkm-editor-btn-icon');
        saveBtn.disabled = !maxIterationsValid;
        saveBtn.addEventListener('click', () => { void this._handleSave(formData); });

        if (this.isEditMode) {
            const deleteBtn = actions.createEl('button', { cls: 'pkm-editor-btn-icon pkm-editor-btn-danger' });
            setSvgLabel(deleteBtn, UiIcons.trash(16), t('modal.sub_agent.delete_btn'));
            deleteBtn.addEventListener('click', () => { void this._handleDelete(); });
        }
    }

    async _handleSave(formData: SubAgentInput) {
        const maxIterations = validateMaxIterations(this._maxIterationsRaw ?? String(formData.max_iterations ?? ''));
        if (!maxIterations.ok) {
            new Notice(t(maxIterations.errorKey, maxIterations.params));
            return;
        }
        formData.max_iterations = maxIterations.value;
        if (!formData.name.trim()) {
            new Notice(t('modal.sub_agent.name_required'));
            return;
        }
        if (!formData.description.trim()) {
            new Notice(t('modal.sub_agent.desc_required'));
            return;
        }

        try {
            // Tryb SZABLONU zapisuje do magazynu Zaplecza, nie do żywych subów.
            if (this.isTemplate) {
                const store = this.plugin.agentManager?.subAgentTemplateStore;
                if (!store) {
                    new Notice(t('modal.sub_agent.loader_unavailable'));
                    return;
                }
                // Adnotacja: `save`/`createFromData` mają RÓŻNE kształty zwrotki (jedna niesie
                // `version`, druga `name`+`renamed`) — oba są strukturalnie zgodne z tym szerszym
                // typem (brakujące pole jest tu opcjonalne), więc przypisanie nie zwęża go z
                // powrotem do unii, na której `result.version`/`result.name` niżej by nie istniały.
                const result: { success: boolean; slug?: string; name?: string; version?: number; renamed?: boolean; error?: string } = this.isEditMode
                    ? await store.save(this.existing!.slug!, formData)
                    : await store.createFromData(formData);
                if (!result?.success || !result.name) {
                    new Notice(t('modal.sub_agent.save_error', { error: result?.error || '?' }));
                    return;
                }
                const notice = templateSaveNotice({ name: result.name, version: result.version });
                new Notice(t(notice.messageKey, notice.params));
                if (this.onSave) this.onSave();
                this.close();
                return;
            }

            const loader = this.plugin.agentManager?.subAgentLoader;
            if (!loader) {
                new Notice(t('modal.sub_agent.loader_unavailable'));
                return;
            }

            await loader.saveSubAgent(formData);

            // Opcjonalna forma odlewnicza obok żywego suba.
            if (this._alsoTemplate) {
                const created = await this.plugin.agentManager?.subAgentTemplateStore?.createFromData(formData);
                if (created?.success) {
                    new Notice(t('modal.sub_agent.template_saved', { name: created.name }));
                }
            }

            new Notice(t('modal.sub_agent.saved', { entity: 'Sub-agent', name: formData.name }));
            if (this.onSave) this.onSave();
            this.close();
        } catch (e) {
            log.error('SubAgentEditorModal', `Save error:`, e);
            new Notice(t('modal.sub_agent.save_error', { error: (e as { message?: string }).message }));
        }
    }

    async _handleDelete() {
        if (!this.existing?.name) return;

        const entityName = 'sub-agent';
        const copyNames = this.isTemplate
            ? templateCopyNames(this.existing.name, this.plugin.agentManager?.subAgentLoader?.getAllSubAgents?.() || [])
            : [];
        const templateConfirmation = templateDeleteConfirmation(this.existing.name, copyNames, t('backstage.no_template_copies'));
        const okToDelete = await confirmModal(this.app, {
            title: t('generic.delete'),
            message: this.isTemplate
                ? t(templateConfirmation.messageKey, templateConfirmation)
                : t('modal.sub_agent.confirm_delete', { entity: entityName, name: this.existing.name }),
            destructive: true,
        });
        if (!okToDelete) return;

        try {
            // Meldunek idzie ze STANU PO operacji. `delete`/`deleteSubAgent`
            // łapią wyjątek adaptera i zwracają `false` (folder suba z dodatkowym plikiem =
            // nierekurencyjny `rmdir` pada) - wtedy modal ZOSTAJE otwarty, a user widzi powód,
            // zamiast „Usunięto" nad pozycją, która dalej jest na liście.
            if (this.isTemplate) {
                const outcome = resolveDeleteOutcome(
                    await this.plugin.agentManager?.subAgentTemplateStore?.delete(this.existing.slug!),
                    this.existing.name);
                new Notice(t(outcome.messageKey, outcome.params));
                if (!outcome.ok) return;
                if (this.onSave) this.onSave();
                this.close();
                return;
            }

            const loader = this.plugin.agentManager?.subAgentLoader;
            if (!loader) {
                new Notice(t('modal.sub_agent.loader_unavailable'));
                return;
            }

            const outcome = resolveDeleteOutcome(
                await loader.deleteSubAgent(this.existing.name), this.existing.name);
            new Notice(t(outcome.messageKey, outcome.params));
            if (!outcome.ok) return;
            if (this.onSave) this.onSave();
            this.close();
        } catch (e) {
            log.error('SubAgentEditorModal', `Delete error:`, e);
            new Notice(t('modal.sub_agent.delete_error', { error: (e as { message?: string }).message }));
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
