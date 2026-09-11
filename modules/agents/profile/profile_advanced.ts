/**
 * Advanced tab - models, behavior, utility actions + Save/Delete logic.
 */
import { Setting, Notice } from 'obsidian';
import { UiIcons, setSvg, setSvgLabel } from '../../crystal-soul/index.js';
import { getModelsForRole } from '../../models/index.js';
import { renderShard, renderToggle } from './profile_helpers.js';
import { applyMainModelChange } from './modelFieldSync.js';
import { t } from '../../../core/i18n/index.js';
import type { ProfileCtx, DTInstrValue } from './profile_types.js';
import type { AgentUpdate } from '../Agent.js';
import type { VaultMapAgent } from '../../onboarding/index.js';

/** Automaty pamięci per agent (mem_proactive / ratunek / idle-global). */
function _renderMemoryAutomation(ctx: ProfileCtx, el: HTMLElement) {
    const { formData, plugin } = ctx;
    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.brain ? UiIcons.brain(14) : UiIcons.zap(14));
    head.createSpan({ text: t('profile.advanced.memory_automation') });

    // mem_proactive - auto-zapis faktów pod koniec tury (steruje decisionTreeInstructions.mem_proactive).
    if (!formData.prompt_overrides) formData.prompt_overrides = {};
    if (!formData.prompt_overrides.decisionTreeInstructions) formData.prompt_overrides.decisionTreeInstructions = {};
    const dt = formData.prompt_overrides.decisionTreeInstructions as Record<string, DTInstrValue>;
    renderToggle(el, t('profile.advanced.mem_proactive'), t('profile.advanced.mem_proactive_hint'),
        dt.mem_proactive !== false, (v) => { if (v) delete dt.mem_proactive; else dt.mem_proactive = false; });

    // ratunek przy kompresji - per-agent pole memory_rescue.
    renderToggle(el, t('profile.advanced.mem_rescue'), t('profile.advanced.mem_rescue_hint'),
        formData.memory_rescue !== false, (v) => { formData.memory_rescue = v; });

    // zapis po bezczynności - GLOBALNY (read-only; per-agent za drogie).
    // TS-boundary: idleConsolidationMinutes is not a declared PkmAssistantSettings field (open
    // index signature -> unknown); cast avoids `{}` landing in the template below.
    const idleMin = (plugin?.env?.settings?.pkmAssistant?.idleConsolidationMinutes as number | undefined) ?? 20;
    el.createDiv({
        text: t('profile.advanced.idle_global', { minutes: idleMin === 0 ? t('profile.advanced.idle_off') : `${idleMin} min` }),
        cls: 'setting-item-description'
    });
}

const SVG_TRASH = '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M3,4 V12 A1,1 0 0,0 4,13 H10 A1,1 0 0,0 11,12 V4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2,4 H12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5,4 V2.5 A0.5,0.5 0 0,1 5.5,2 H8.5 A0.5,0.5 0 0,1 9,2.5 V4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export async function renderAdvancedTab(ctx: ProfileCtx, el: HTMLElement) {
    const { agent, plugin, formData } = ctx;
    if (!agent) return;

    // Models section
    const headModels = el.createDiv({ cls: 'cs-section-head' });
    setSvg(headModels, UiIcons.settings(14));
    headModels.createSpan({ text: t('profile.models') });

    const modelsGrid = el.createDiv({ cls: 'cs-shards' });
    const pkmM = (plugin.env?.settings?.pkmAssistant || {}) as Parameters<typeof getModelsForRole>[0];
    const platformNames: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', open_router: 'OpenRouter', ollama: 'Ollama', gemini: 'Gemini', groq: 'Groq', deepseek: 'DeepSeek', lm_studio: 'LM Studio' };
    const buildModelOptions = (role: Parameters<typeof getModelsForRole>[1]) => {
        const models = getModelsForRole(pkmM, role);
        return [
            { value: '', label: t('profile.advanced.default_from_settings') },
            ...models.map(m => ({ value: `${m.platform}/${m.model}`, label: `${platformNames[m.platform] || m.platform} — ${m.model}${m.isDefault ? ' ★' : ''}` }))
        ];
    };
    // Tylko model GŁÓWNY - selecty subów (researcher/strateg) wywalone (model ustawiasz per
    // członek Ekipy; „model stratega" i tak był martwy).
    // KANON to `models.main` - select go pokazuje i go ZMIENIA; legacy `model` się nie odradza
    // (patrz modelFieldSync.ts).
    // onChange NIE dotyka formData.model - resolveMainModelForForm (AgentProfileView.ts) już je
    // wyzerowało przy otwarciu profilu, a legacy pole nigdy nie wraca do życia (patrz
    // modelFieldSync.ts), więc nie ma czego tu przypisywać ponownie.
    renderShard(modelsGrid, t('profile.advanced.main_model'), t('profile.advanced.main_model_hint'), formData.models?.main || '', 'select',
        v => {
            formData.models = applyMainModelChange(formData.models, v as string).models;
        }, { options: buildModelOptions('main') });

    // Behavior tuning
    const headBehavior = el.createDiv({ cls: 'cs-section-head' });
    setSvg(headBehavior, UiIcons.zap(14));
    headBehavior.createSpan({ text: t('profile.behavior') });

    const behaviorGrid = el.createDiv({ cls: 'cs-shards' });
    // Temperatura - JEDYNE miejsce (wyprowadzka z Persony).
    renderShard(behaviorGrid, t('profile.temperature'), t('profile.advanced.temperature_hint'), formData.temperature, 'slider',
        v => formData.temperature = v as number, { min: 0, max: 1, step: 0.1 });
    // Język odpowiedzi agenta (auto = globalny locale).
    renderShard(behaviorGrid, t('profile.advanced.language'), t('profile.advanced.language_hint'), formData.language || 'auto', 'select',
        v => formData.language = v as string, {
            options: [
                { value: 'auto', label: t('profile.advanced.language_auto') },
                { value: 'pl', label: 'Polski' },
                { value: 'en', label: 'English' },
            ]
        });

    // Jedyny jawny escape hatch do `.pkm-assistant`, `.obsidian`, `.trash`
    // i chronionych plików vaulta. Default OFF; autonomia/YOLO pozostaje osobną osią.
    const headAdmin = el.createDiv({ cls: 'cs-section-head' });
    setSvg(headAdmin, UiIcons.shield(14));
    headAdmin.createSpan({ text: t('profile.advanced.admin_access_section') });
    const adminRow = renderToggle(
        el,
        t('profile.advanced.admin_access'),
        t('profile.advanced.admin_access_hint'),
        formData.admin_access === true,
        v => { formData.admin_access = v; }
    );
    adminRow.addClass?.('cs-perm-row--danger');
    el.createDiv({
        text: t('profile.advanced.admin_access_warning'),
        cls: 'setting-item-description cs-admin-access-warning'
    });

    // Automaty pamięci - sterowanie ON/OFF wyprowadzone z Pamięci
    _renderMemoryAutomation(ctx, el);

    // Tools section - utility actions
    const headTools = el.createDiv({ cls: 'cs-section-head' });
    setSvg(headTools, UiIcons.zap(14));
    headTools.createSpan({ text: t('profile.tools') });

    const toolsGrid = el.createDiv({ cls: 'cs-adv-tools' });

    // Reset prompt overrides
    const resetBtn = toolsGrid.createEl('button', { cls: 'cs-adv-tools__btn cs-adv-tools__btn--warn' });
    setSvg(resetBtn, UiIcons.trash(14));
    resetBtn.appendText(t('profile.advanced.reset_overrides'));
    resetBtn.addEventListener('click', () => {
        const keys = Object.keys(formData.prompt_overrides);
        if (keys.length === 0) { new Notice(t('profile.advanced.no_overrides')); return; }
        formData.prompt_overrides = {};
        formData.agent_rules = '';
        new Notice(t('profile.advanced.overrides_cleared'));
    });

    // Export profile
    const exportBtn = toolsGrid.createEl('button', { cls: 'cs-adv-tools__btn' });
    setSvg(exportBtn, UiIcons.clipboard(14));
    exportBtn.appendText(t('profile.advanced.export_profile'));
    exportBtn.addEventListener('click', () => {
        void (async () => {
            const ag = ctx.agentManager.getAgent(formData.name);
            if (!ag) { new Notice(t('profile.advanced.save_first')); return; }
            try {
                const yaml = ag.serialize ? ag.serialize() : JSON.stringify(ag, null, 2);
                // TS-boundary: ZASTANE - serialize() zwraca obiekt, writeText dostaje [object Object];
                // naprawa (stringifyYaml) = runtime, poza falą.
                await navigator.clipboard.writeText(yaml as string);
                new Notice(t('profile.advanced.profile_copied'));
            } catch (e: unknown) {
                new Notice(t('profile.advanced.export_error') + (e as Error).message);
            }
        })();
    });
}

/**
 * Handle save (create or update agent).
 * @param {Object} ctx - shared context
 */
export async function handleSave(ctx: ProfileCtx) {
    const { formData, agent, agentManager, plugin } = ctx;

    if (!formData.name.trim()) {
        new Notice(t('profile.advanced.name_required'));
        return;
    }

    // Create-mode skasowany - agent zawsze istnieje (tworzony od razu przy „+").
    // Zapis to WYŁĄCZNIE update istniejącego agenta.
    try {
        const updates: AgentUpdate = {
            color: formData.color,
            personality: formData.personality,
            description: formData.description,
            created_at: formData.createdAt,
            temperature: formData.temperature,
            // Język + domyślna autonomia per agent ('' → null = globalna).
            language: formData.language || 'auto',
            default_autonomy: formData.default_autonomy || null,
            admin_access: formData.admin_access === true,
            // Uczestnictwo w komunikatorze (default ON, zapisywane tylko gdy false).
            komunikator_visible: formData.komunikator_visible !== false,
            focus_folders: formData.focus_folders,
            model: formData.model || null,
            skills: formData.skills,
            // Typy artefaktów podpięte per agent.
            artifact_types: formData.artifact_types,
            // Jedna oś narzędziowa (disabled_tools) zamiast enabled_tools.
            disabled_tools: formData.disabled_tools,
            preferred_servers: formData.preferred_servers,
            preferred_tools: formData.preferred_tools,
            mcp_servers: formData.mcp_servers,
            sub_agents: formData.sub_agents,
            // `sub_agent_enabled` WYCIĘTY z payloadu: `Agent.allowedFields` nigdy go nie miało -
            // `AgentProfileView.ts:91` czyta `agent.subAgentEnabled`, pole które nie istnieje
            // NIGDZIE w klasie (zawsze `undefined`), więc toggle „Deleguj do sub-agentów"
            // (`profile_team.ts:65`) jest martwym UI bez żadnego czytelnika w runtime -
            // delegację steruje wyłącznie oś narzędziowa (`disabled_tools`, grupa `delegation`).
            // Zostawienie pola w `updates` krzyczałoby przy KAŻDYM zapisie profilu, bo nieznane
            // klucze w payloadzie są logowane jako ostrzeżenie. Świadomie NIE ożywiamy toggle'a -
            // to osobna decyzja UI.
            default_permissions: formData.permissions,
            approval_toggles: formData.approval_toggles || {},
            models: formData.models,
            prompt_overrides: formData.prompt_overrides,
            agent_rules: formData.agent_rules || '',
            crystal_seed: formData.crystal_seed || null,
            // Prompty robocze per agent (puste = resolver global/factory).
            compression_prompt: formData.compression_prompt || '',
            save_session_prompt: formData.save_session_prompt || '',
            archive_prompt: formData.archive_prompt || '',
            summary_prompt: formData.summary_prompt || '',
            subagent_frame_prompt: formData.subagent_frame_prompt || '',
            memory_rescue: formData.memory_rescue !== false
        };
        if (!agent.isBuiltIn && formData.name !== agent.name) {
            updates.name = formData.name;
        }
        // Snapshot PRZED zapisem: `agent` jest ŻYWĄ instancją, którą `agentManager.updateAgent`
        // mutuje w miejscu (`agent.update(rest)`) - porównanie PO `await` niżej widziałoby
        // `updates.x` kontra już-zmutowane `agent.x`, czyli zawsze równe. Bez snapshotu blok
        // „co się zmieniło" jest martwy: notice „Zapisano: …, Uprawnienia" wyświetla się (albo
        // nie) niezależnie od tego, co user faktycznie zmienił.
        const before = {
            personality: agent.personality,
            focusFolders: agent.focusFolders,
            skills: agent.skills,
            subAgents: agent._subAgents || [],
            preferredServers: agent.preferredServers || [],
            preferredTools: agent.preferredTools || [],
            promptOverrides: agent.promptOverrides,
            agentRules: agent.agentRules || '',
            temperature: agent.temperature,
            adminAccess: agent.admin_access,
            komunikatorVisible: agent.komunikator_visible !== false,
            models: agent.models || {},
            permissions: agent.permissions,
        };
        const saved = await agentManager.updateAgent(agent.name, updates);
        if (!saved) {
            // Odmowa (kolizja nazwy / pad przenosin pamięci / built-in) już pokazała swój
            // własny Notice z AgentManager. Nic nie wylądowało na dysku - cofamy bufor nazwy do
            // tego, co NAPRAWDĘ jest zapisane, żeby panel nie kłamał „Zapisano" nad odrzuconą
            // zmianą.
            formData.name = agent.name;
            void ctx.renderActiveTab();
            return;
        }
        const updatedAgent = agentManager.getAgent(formData.name);
        if (updatedAgent && plugin.agentManager?.playbookManager) {
            // TS-boundary: Agent.focusFolders (AgentFocusFolder - path/access/group all optional
            // on one shape) vs VaultMapFocusFolder (string | {path,access} | {group}, path
            // required in the object branch) - same runtime entries, stricter union on this side.
            await plugin.agentManager.playbookManager.compileVaultMap(updatedAgent as VaultMapAgent, plugin);
        }
        const details = [];
        if (updates.personality !== before.personality) details.push(t('profile.advanced.personality'));
        if (JSON.stringify(updates.focus_folders) !== JSON.stringify(before.focusFolders)) details.push(t('profile.advanced.folders'));
        if (JSON.stringify(updates.skills) !== JSON.stringify(before.skills)) details.push(t('profile.advanced.skills_label'));
        if (JSON.stringify(updates.sub_agents) !== JSON.stringify(before.subAgents)) details.push(t('profile.advanced.sub_agents_label'));
        if (JSON.stringify(updates.preferred_servers) !== JSON.stringify(before.preferredServers)) details.push(t('profile.advanced.mcp_servers'));
        if (JSON.stringify(updates.preferred_tools) !== JSON.stringify(before.preferredTools)) details.push(t('profile.advanced.standalone_tools'));
        if (JSON.stringify(updates.prompt_overrides) !== JSON.stringify(before.promptOverrides)) details.push(t('profile.advanced.prompt_label'));
        if (updates.agent_rules !== before.agentRules) details.push(t('profile.advanced.rules_label'));
        if (updates.temperature !== before.temperature) details.push(t('profile.advanced.temperature_label'));
        if (updates.admin_access !== before.adminAccess) details.push(t('profile.advanced.admin_access'));
        if (updates.komunikator_visible !== before.komunikatorVisible) details.push(t('profile.perm.komunikator_visible'));
        if (JSON.stringify(updates.models) !== JSON.stringify(before.models)) details.push(t('profile.advanced.models_label'));
        // `agent.defaultPermissions` nie istnieje - żywe pole nazywa się `permissions`
        // (Agent.ts:178). Literówka przechodzi przez otwartą sygnaturę indeksu klasy Agent bez
        // błędu typecheck, a warunek byłby PRAWDZIWY przy każdym zapisie (JSON.stringify(undefined)
        // === undefined, nigdy nie równe stringowi z updates).
        if (JSON.stringify(updates.default_permissions) !== JSON.stringify(before.permissions)) details.push(t('profile.advanced.permissions_label'));

        const what = details.length > 0 ? details.join(', ') : t('profile.advanced.config');
        plugin.showCrystalNotice(t('profile.advanced.saved_msg', { name: formData.name, what }), { type: 'success', timeout: 4000 });
    } catch (error: unknown) {
        plugin.showCrystalNotice(t('profile.advanced.save_error') + (error as Error).message, { type: 'error' });
        return;
    }

    void ctx.renderActiveTab();
}

/**
 * Show delete confirmation UI.
 * @param {Object} ctx - shared context
 * @param {HTMLElement} tabContent
 */
export function showDeleteConfirmation(ctx: ProfileCtx, tabContent: HTMLElement) {
    const { agent, agentManager, nav } = ctx;
    tabContent.empty();

    const el = tabContent;
    const deleteHeading = new Setting(el).setHeading();
    setSvgLabel(deleteHeading.nameEl, SVG_TRASH, t('profile.advanced.delete_agent'));
    el.createEl('p', { text: t('profile.advanced.delete_confirm', { name: agent.name }) });

    if (agent.isBuiltIn) {
        el.createEl('p', {
            text: t('profile.advanced.builtin_warning'),
            cls: 'agent-delete-warning'
        });
    }

    let archiveMemory = true;
    new Setting(el)
        .setName(t('profile.advanced.archive_memory'))
        .setDesc(t('profile.advanced.archive_memory_desc'))
        .addToggle(toggle => {
            toggle.setValue(true).onChange(v => archiveMemory = v);
        });

    const btnRow = el.createDiv({ cls: 'sidebar-delete-actions' });

    const cancelDeleteBtn = btnRow.createEl('button', { text: t('profile.cancel') });
    cancelDeleteBtn.addEventListener('click', () => { void ctx.renderActiveTab(); });

    const confirmBtn = btnRow.createEl('button', { text: t('profile.delete'), cls: 'mod-warning' });
    confirmBtn.addEventListener('click', () => {
        void (async () => {
            try {
                if (archiveMemory) await agentManager.archiveAgentMemory(agent.name);
                await agentManager.deleteAgent(agent.name);
                new Notice(t('profile.advanced.agent_deleted', { name: agent.name }));
                nav.goHome();
            } catch (error: unknown) {
                new Notice(t('profile.advanced.delete_error') + (error as Error).message);
            }
        })();
    });
}
