/**
 * SubAgentEditorModal
 * Unified Creator/Editor modal for Sub-Agents (researchers + strategists).
 * Replaces MinionMasterEditorModal.
 */
import { Modal, Setting, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { TOOL_INFO, confirmModal } from '../ui-components/index.js';
import { UiIcons, setSvg, setSvgLabel } from '../crystal-soul/index.js';
import { getModelsForRole } from '../models/index.js';
import type { PkmModelSettings } from '../models/index.js';
import { t } from '../../core/i18n/index.js';
import { DEFAULT_LIMITS, LIMIT_SPECS } from '../../config/limits.js';
import { log } from '../../core/utils/Logger.js';
import { resolveDeleteOutcome } from './deleteOutcome.js';
import type { SubAgentData, SubAgentInput, SubAgentsPlugin } from './types.js';
import type { SubAgentTemplateRecord } from './SubAgentTemplateStore.js';

// Przykładowy nagłówek Markdown pola „Sekcje" — celowo wielka litera (przykład TREŚCI, którą
// user wpisuje w swoich notatkach, nie etykieta UI; ten sam wzorzec co w SkillEditorModal.ts /
// modules/web/SettingsContent.ts), w stałej a nie literale inline.
const SECTION_EXAMPLE = '## Pomysły';

export class SubAgentEditorModal extends Modal {
    declare plugin: SubAgentsPlugin;
    declare role: string;
    declare existing: SubAgentData | SubAgentTemplateRecord | null;
    declare onSave: ((data?: SubAgentInput) => void) | null;
    declare isEditMode: boolean;
    declare isTemplate: boolean;
    declare offerTemplateCopy: boolean;
    declare _alsoTemplate: boolean;
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
        this.role = 'researcher';
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

        const defaultTools = ['search', 'read', 'list'];

        // Form data
        const formData = {
            name: this.existing?.name || '',
            description: this.existing?.description || '',
            role: this.role,
            model: this.existing?.model || '',
            tools: [...(this.existing?.tools || defaultTools)],
            scope: {
                folders: [...(this.existing?.scope?.folders || [])],
                frontmatter: { ...(this.existing?.scope?.frontmatter || {}) },
                sections: [...(this.existing?.scope?.sections || [])],
                pinned_notes: [...(this.existing?.scope?.pinned_notes || [])],
            },
            max_iterations: this.existing?.max_iterations ?? DEFAULT_LIMITS.subagent_max_iterations_worker,
            min_iterations: this.existing?.min_iterations ?? 1,
            max_tool_result_length: this.existing?.max_tool_result_length ?? DEFAULT_LIMITS.max_tool_result_length,
            enabled: this.existing?.enabled !== false,
            prompt: this.existing?.prompt || ''
        };

        // --- Name ---
        new Setting(contentEl)
            .setName(t('modal.sub_agent.name_label'))
            .setDesc(t('modal.sub_agent.name_desc'))
            .addText(text => {
                text.setPlaceholder(t('modal.sub_agent.name_placeholder'))
                    .setValue(formData.name)
                    .onChange(v => formData.name = v.trim());
                if (this.isEditMode) text.inputEl.disabled = true;
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

        // --- Model override ---
        {
            // TS-boundary: `PkmAssistantSettings.modelLibrary` jest `unknown` w kontrakcie core
            // (core/ nie zna kształtu biblioteki modeli); `modules/models` jest właścicielem
            // realnego kształtu (`PkmModelSettings`) i to on czyta to pole w `getModelsForRole`.
            const pkmM = (this.plugin?.env?.settings?.pkmAssistant || {}) as PkmModelSettings;
            const models = getModelsForRole(pkmM, 'researcher');
            const platformNames = { anthropic: 'Anthropic', openai: 'OpenAI', open_router: 'OpenRouter', ollama: 'Ollama', gemini: 'Gemini', groq: 'Groq', deepseek: 'DeepSeek', lm_studio: 'LM Studio' };

            new Setting(contentEl)
                .setName(t('modal.sub_agent.model_label'))
                .setDesc(t('modal.sub_agent.model_desc'))
                .addDropdown(dd => {
                    dd.addOption('', t('modal.sub_agent.model_default'));
                    for (const m of models) {
                        dd.addOption(m.model, `${(platformNames as Record<string, string>)[m.platform] || m.platform} — ${m.model}${m.isDefault ? ' ★' : ''}`);
                    }
                    dd.setValue(formData.model || '');
                    dd.onChange(v => formData.model = (v || null) as string);
                });
        }

        // --- Iterations ---
        // Min/max widełek pola biorą się z LIMIT_SPECS (config/limits.ts),
        // nie z lokalnego literału — inaczej pole renderuje się z wartością (default 25)
        // przekraczającą własny deklarowany sufit ('10'), a spinner po cichu tnie ją do 10.
        {
            const maxIterSpec = LIMIT_SPECS.subagent_max_iterations_worker;
            new Setting(contentEl)
                .setName(t('modal.sub_agent.max_iter_label'))
                .setDesc(t('modal.sub_agent.max_iter_desc'))
                .addText(text => {
                    text.inputEl.type = 'number';
                    text.inputEl.min = String(maxIterSpec.min);
                    text.inputEl.max = String(maxIterSpec.ceiling);
                    text.setValue(String(formData.max_iterations))
                        .onChange(v => formData.max_iterations = parseInt(v) || DEFAULT_LIMITS.subagent_max_iterations_worker);
                });
        }

        new Setting(contentEl)
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
            new Setting(contentEl)
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
        new Setting(contentEl)
            .setName(t('modal.sub_agent.active_label'))
            .addToggle(toggle => {
                toggle.setValue(formData.enabled).onChange(v => formData.enabled = v);
            });

        // --- Tools ---
        const toolsHeader = contentEl.createEl('h4');
        setSvgLabel(toolsHeader, UiIcons.wrench(18), t('modal.sub_agent.tools_header'));
        toolsHeader.addClass('pkm-editor-section-head');
        const toolsContainer = contentEl.createDiv({ cls: 'editor-tools-grid' });

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
        const scopeHeader = contentEl.createEl('h4');
        setSvg(scopeHeader, UiIcons.folder(18));
        scopeHeader.appendText(' Scope');
        scopeHeader.addClass('pkm-editor-section-head');

        const scopeToText = (arr: string[]) => (arr || []).join('\n');
        const textToScope = (value: string) => value.split('\n').map((v) => v.trim()).filter(Boolean);

        new Setting(contentEl)
            .setName('Foldery')
            .setDesc('Jeden folder vaulta na linię. Puste = brak ograniczenia folderów.')
            .addTextArea(text => {
                text.setValue(scopeToText(formData.scope.folders))
                    .onChange(v => formData.scope.folders = textToScope(v));
                text.inputEl.rows = 3;
            });

        new Setting(contentEl)
            .setName('Sekcje')
            .setDesc(`Nagłówki Markdown, np. "${SECTION_EXAMPLE}". Puste = brak ograniczenia sekcji.`)
            .addTextArea(text => {
                text.setValue(scopeToText(formData.scope.sections))
                    .onChange(v => formData.scope.sections = textToScope(v));
                text.inputEl.rows = 2;
            });

        new Setting(contentEl)
            .setName('Przypięte notatki')
            .setDesc('Jedna notatka na linię. Te notatki są zawsze częścią kontekstu sub-agenta.')
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
        setSvgLabel(saveBtn,
            this.isEditMode ? UiIcons.save(16) : UiIcons.sparkle(16),
            this.isEditMode ? t('modal.sub_agent.save_changes') : t('modal.sub_agent.create'));
        saveBtn.addClass('pkm-editor-btn-icon');
        saveBtn.addEventListener('click', () => { void this._handleSave(formData); });

        if (this.isEditMode) {
            const deleteBtn = actions.createEl('button', { cls: 'pkm-editor-btn-icon pkm-editor-btn-danger' });
            setSvgLabel(deleteBtn, UiIcons.trash(16), t('modal.sub_agent.delete_btn'));
            deleteBtn.addEventListener('click', () => { void this._handleDelete(); });
        }
    }

    async _handleSave(formData: SubAgentInput) {
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
                if (!result?.success) {
                    new Notice(t('modal.sub_agent.save_error', { error: result?.error || '?' }));
                    return;
                }
                new Notice(result.version
                    ? t('modal.sub_agent.template_saved_bumped', { name: formData.name, version: result.version })
                    : t('modal.sub_agent.template_saved', { name: result.name || formData.name }));
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
        const okToDelete = await confirmModal(this.app, {
            title: t('generic.delete'),
            message: t('modal.sub_agent.confirm_delete', { entity: entityName, name: this.existing.name }),
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
