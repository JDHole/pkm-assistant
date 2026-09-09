/**
 * Base Agent class
 * Represents an AI assistant with unique personality and capabilities.
 *
 * Agent v3: Persona (personality) + Umiejętności (skills) + Uprawnienia (permissions)
 * + Ekipa (sub-agents) + Pamięć (memory). Archetyp i Rola już NIE ISTNIEJĄ jako byty
 * sterujące - pola `archetype`/`role` czytane ze starych YAML-i, ale ignorowane.
 *
 * Sub-agents: Agent can have MULTIPLE sub-agents (max 20).
 * Each assignment: {name, role, default?, active?, overrides?}
 * role: 'researcher' (szuka/prep) or 'strategist' (planuje/analizuje)
 * active: default true, false = assigned but inactive (config preserved, not in prompt)
 * Legacy minions/masters are migrated by AgentLoader before Agent is created.
 */

import { PromptBuilder } from '../../modules/prompts/index.js';
import { pickColor, ALL_COLORS } from '../../modules/crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import { normalizeAutonomy } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import {
    computeDisabledToolsFromLegacy,
    normalizeDisabledTools,
    hasLegacyToolAxis,
} from './toolAxis.js';
import { ACCESS_POLICY_VERSION, normalizeAdminAccess } from './accessPolicy.js';
import type { ToolVisibilityAgent } from '../tools/index.js';

export interface AgentPermissions extends Record<string, boolean> {
    memory: boolean;
    guidance_mode: boolean;
}

export interface AgentFocusFolder {
    path?: string;
    access?: 'read' | 'readwrite';
    group?: string;
}

export interface AgentSubAgentAssignment {
    name: string;
    role?: string;
    default?: boolean;
    active?: boolean;
    overrides?: AgentSubAgentOverrides;
}

export interface AgentSubAgentOverrides extends Record<string, unknown> {
    prompt_append?: string;
    extra_tools?: string[];
    scope?: Record<string, unknown>;
    max_iterations?: number;
    dt_covered_groups?: string[];
    behavior_inject?: string;
}

export interface AgentSkillAssignment {
    name: string;
    overrides?: AgentSkillOverrides;
}

export interface AgentSkillOverrides extends Record<string, unknown> {
    prompt_append?: string;
    model?: string;
    pre_question_defaults?: Record<string, unknown>;
}

export interface AgentPromptContext {
    vaultName?: string;
    disabledPromptSections?: string[];
    memoryContext?: string;
    [extra: string]: unknown;
}

/** YAML-shaped input; all non-name fields are optional because user YAML is permissive. */
export interface AgentConfig {
    name: string;
    access_policy_version?: unknown;
    admin_access?: unknown;
    komunikator_visible?: unknown;
    color?: string | null;
    archetype?: string | null;
    role?: string | null;
    personality?: string;
    description?: string;
    created_at?: string | null;
    model?: string | null;
    temperature?: number;
    language?: string;
    default_autonomy?: string | null;
    focus_folders?: Array<string | AgentFocusFolder>;
    default_permissions?: Partial<AgentPermissions> | Record<string, unknown>;
    approval_toggles?: Record<string, unknown>;
    skills?: Array<string | AgentSkillAssignment>;
    artifact_types?: Array<string | { name?: unknown }>;
    enabled_tools?: string[];
    disabled_tools?: unknown;
    sub_agents?: Array<string | AgentSubAgentAssignment>;
    models?: Record<string, unknown>;
    preferred_servers?: string[];
    preferred_tools?: string[];
    mcp_servers?: unknown;
    isBuiltIn?: boolean;
    filePath?: string | null;
    prompt_overrides?: Record<string, unknown>;
    agent_rules?: string;
    crystal_seed?: string | null;
    save_session_prompt?: string;
    archive_prompt?: string;
    summary_prompt?: string;
    compression_prompt?: string;
    subagent_frame_prompt?: string;
    memory_rescue?: unknown;
    emoji?: string;
    [extra: string]: unknown;
}

// TS-any: update() intentionally accepts permissive user-YAML values before its existing normalizers validate them.
type AgentUpdateValue = any;
export type AgentUpdate = Partial<AgentConfig> & Record<string, AgentUpdateValue>;

/**
 * Max sub-agents per agent
 */
export const MAX_SUB_AGENTS = 20;

/**
 * Default permissions for agents
 *
 * `yolo_mode` nie istnieje w defaultach - "Nie pytaj" to tryb autonomii per-czat
 * (core/security/autonomy.js), NIE uprawnienie agenta.
 *
 * Pola-widma bez sprawdzeń runtime: access_outside_vault, execute_commands, thinking,
 * building_agents, system_settings, skills_crud.
 *
 * `read_notes`/`edit_notes`/`create_files`/`delete_files`/`mcp`/`web_search` przestały
 * bramkować narzędzia (ich funkcję przejął on/off narzędzia, `disabled_tools`). Zostają
 * 2 ŻYWE pola: `memory` (bramka scope=memory w read/search/list + injectMemory) i
 * `guidance_mode` (tryb folderów: false=whitelist, true=cały vault poza No-Go).
 * Nieznane/legacy klucze filtruje `_normalizePermissions` - nie wybuchają, nie propagują.
 */
export const DEFAULT_PERMISSIONS: AgentPermissions = {
    memory: true,
    guidance_mode: false  // false = WHITELIST (strict), true = cały vault except No-Go
};

/**
 * Agent class - base for all AI assistants
 */
export class Agent implements ToolVisibilityAgent {
    [extra: string]: unknown;
    declare name: string;
    declare access_policy_version: number;
    declare admin_access: boolean;
    declare komunikator_visible: boolean;
    declare color: string | null;
    declare emoji: string | null;
    declare archetype: string | null;
    declare role: string | null;
    declare personality: string;
    declare description: string;
    declare createdAt: string | null;
    declare model: string | null;
    /**
     * Czy legacy `model` pochodzi ze ŹRÓDŁA - obecność klucza `model` w danych wejściowych
     * konstruktora (yaml na dysku) - ALBO zostało jawnie ustawione userem przez
     * `update({ model: ... })` (UI). Silnik nie ma żadnego mechanizmu, który sam z siebie
     * wypełnia `model` (żadnego auto-fill z ustawień) - jedyne dwie drogi, którymi `this.model`
     * w ogóle dostaje wartość, to konstruktor i `update()`, więc flaga jest kompletna.
     * Serialize() używa jej jako BRAMKI (obok `this.model` truthy), żeby pole nigdy nie
     * odrodziło się z drogi, która nie jest ani zapisem źródłowym, ani jawną decyzją usera.
     */
    declare _modelFromSource: boolean;
    declare temperature: number;
    declare language: string;
    declare default_autonomy: string | null;
    declare focusFolders: AgentFocusFolder[];
    declare permissions: AgentPermissions;
    declare approvalToggles: Record<string, unknown>;
    declare _skills: AgentSkillAssignment[];
    declare _artifactTypes: string[];
    declare disabled_tools: string[];
    declare _toolAxisMigrated: boolean;
    declare _subAgents: AgentSubAgentAssignment[];
    declare models: Record<string, unknown>;
    declare preferredServers: string[];
    declare preferredTools: string[];
    declare mcp_servers: string[];
    declare effective_mcp_servers: string[];
    declare isBuiltIn: boolean;
    declare filePath: string | null;
    declare promptOverrides: Record<string, unknown>;
    declare agentRules: string;
    declare crystalSeed: string | null;
    declare save_session_prompt: string;
    declare archive_prompt: string;
    declare summary_prompt: string;
    declare compression_prompt: string;
    declare subagent_frame_prompt: string;
    declare memory_rescue: boolean;
    declare lastActivity: unknown;
    /**
     * @param {Object} config - Agent configuration
     * @param {string} config.name - Agent name
     * @param {string} [config.archetype] - DEPRECATED: czytane, ignorowane (byt skasowany)
     * @param {string} [config.role] - DEPRECATED: czytane, ignorowane (rola rozpuszczona)
     * @param {string} [config.personality] - Personality description / system prompt extension
     * @param {string} [config.model] - Preferred AI model
     * @param {number} [config.temperature] - Model temperature (0-2)
     * @param {string[]} [config.focus_folders] - Folders this agent focuses on
     * @param {Object} [config.default_permissions] - Permission overrides (memory, guidance_mode)
     * @param {boolean} [config.admin_access=false] - jawny dostęp do chronionych bebechów vaulta
     * @param {string[]} [config.disabled_tools] - negatywna lista wyłączonych narzędzi built-in
     * @param {string[]} [config.enabled_tools] - DEPRECATED: martwa oś, czytana tylko przez migrację
     * @param {boolean} [config.isBuiltIn] - Whether this is a built-in agent
     * @param {string} [config.filePath] - Path to YAML definition file (for custom agents)
     * @param {Object} [config.prompt_overrides] - Per-agent prompt section overrides {decision_tree, delegate_guide, ...}
     * @param {string} [config.agent_rules] - Domain-specific rules for this agent (e.g. "Grafiki w 16:9")
     * @param {Array} [config.sub_agents] - Assigned sub-agents [{name, role?, default?, active?, overrides?}]
     */
    /**
     * Crystal Soul agent color palette
     */
    static get CRYSTAL_PALETTE() { return ALL_COLORS.map(c => c.hex); }

    /**
     * Derive a deterministic color from agent name (hash → palette index)
     * @param {string} name - Agent name
     * @returns {string} Color name from CRYSTAL_PALETTE
     */
    static deriveColor(name: string) {
        return pickColor(name).hex;
    }

    constructor(config: AgentConfig) {
        this.name = config.name;
        this.access_policy_version = Number(config.access_policy_version) || ACCESS_POLICY_VERSION;
        this.admin_access = normalizeAdminAccess(config.admin_access);
        // "Uczestniczy w komunikatorze" - default TRUE (wzór admin_access, tylko odwrotny
        // domyślny stan). Wyłączony = duch: nie ma go na liście adresatów, skrzynka znika z paneli,
        // ping milczy, a wysyłka do niego zwraca "nieznany adresat". Tylko jawne `false` wyłącza.
        this.komunikator_visible = config.komunikator_visible !== false;
        this.color = config.color || null; // Crystal Soul color (null = auto-derive from name)
        // `emoji` był w `AgentConfig`/`allowedFields` od zawsze, ale konstruktor go nie czytał -
        // nawet Jaskrowe `HUMAN_VIBE_CONFIG.emoji: '🎭'` ginęło w locie. `chat_popovers.ts`/
        // `chat_streaming.ts` czytają `agent.emoji` (fallback `◆`), więc pole ma realnego konsumenta.
        this.emoji = config.emoji || null;

        // Archetyp SKASOWANY jako byt. Pole czytane ze starych YAML-i, ale IGNOROWANE
        // (nie steruje niczym - zero defaultów, zero rozgałęzień). Zostaje tylko po to, żeby
        // stary config się nie wywalił i żeby nie zgubić wartości przy ew. odczycie.
        this.archetype = config.archetype || null;

        // `role` na AGENCIE = pole-etykieta, czytane i IGNOROWANE (rola rozpuszczona).
        // NIE mylić z `config.role` sub-agenta (inny byt).
        this.role = config.role || null;

        this.personality = config.personality || '';
        // personaDrift skasowany (uśpiony mechanizm, 0 writerów). YAML z `persona_drift:`
        // jest ignorowany (nie czytany).
        this.description = config.description || '';
        this.createdAt = config.created_at || null;
        this.model = config.model || null; // null = use default from settings
        // Presence in the SOURCE config, not truthiness of the resulting value - a yaml
        // with `model: ""` is still "the source has an opinion about this field" (edge case,
        // harmless either way since an empty string is falsy and never gets serialized).
        this._modelFromSource = Object.prototype.hasOwnProperty.call(config, 'model');
        this.temperature = config.temperature ?? 0.7;
        // Język odpowiedzi per agent. 'auto' = globalny locale (jak dziś),
        // 'pl'/'en' = wymuszona treść reguły językowej w prompcie (PromptBuilder._buildRules).
        this.language = config.language || 'auto';
        // Domyślna autonomia per agent (wartość startowa sesji). null = użyj
        // globalnego defaultAutonomy z Settings. Per-czat override działa dalej w locie.
        this.default_autonomy = config.default_autonomy ? normalizeAutonomy(config.default_autonomy) : null;
        this.focusFolders = Agent._normalizeFocusFolders(config.focus_folders);
        // Bez merge archetypu; tylko ZNANE klucze uprawnień (nieznane/widma z
        // starych YAML-i - yolo_mode, execute_commands, thinking... - ignorowane, nie propagowane).
        this.permissions = Agent._normalizePermissions(config.default_permissions);
        this.approvalToggles = config.approval_toggles || {};
        this._skills = Agent._normalizeSkillAssignments(config.skills);
        // Podpięte TYPY artefaktów (lista nazw; wzór `skills`). Brak/puste = agent
        // widzi tylko wbudowany typ `plan` (default rozwiązywany w ArtifactTypeLoader.getTypesForAgent).
        this._artifactTypes = Agent._normalizeArtifactTypes(config.artifact_types);
        // `enabled_tools` to martwa oś - czytana ze starych YAML-i przez migrację
        // (computeDisabledToolsFromLegacy czyta config.enabled_tools WPROST, poniżej), IGNOROWANA
        // poza tym (nie filtruje narzędzi; jej rolę przejął `disabled_tools`). Dawne
        // `this.enabledTools` nie miało żadnego czytelnika (migracja czyta surowy `config`,
        // nie `this`) - pole skasowane, migracja niżej działa bez zmian.
        // JEDNA OŚ NARZĘDZIOWA. `disabled_tools` = negatywna lista wyłączonych narzędzi
        // built-in (nowe narzędzie po update pluginu = domyślnie ON). `core` (ask_user) nieusuwalny.
        // - nowy YAML v3 niesie `disabled_tools` wprost.
        // - stary YAML (mcp_servers/enabled_tools/permissions) → MIGRACJA: wylicz efektywny zestaw
        //   dawną logiką i zapisz jako `disabled_tools` (stare osie zostają w YAML, ignorowane).
        //   `_toolAxisMigrated` sygnalizuje AgentLoaderowi "przepisz YAML raz" (czyści stare osie).
        if (Array.isArray(config.disabled_tools)) {
            this.disabled_tools = normalizeDisabledTools(config.disabled_tools);
            this._toolAxisMigrated = false;
        } else {
            this.disabled_tools = computeDisabledToolsFromLegacy(config);
            this._toolAxisMigrated = hasLegacyToolAxis(config);
        }
        this._subAgents = Agent._normalizeSubAgentAssignments(config.sub_agents);

        this.models = Agent._normalizeModelOverrides(config.models); // per-agent model overrides {main, researcher, strategist}
        // default_mode (Gadaj/Rób) nie jest już parsowane - tryby pracy usunięte.
        // Stare YAML-e z polem default_mode nie wybuchają, pole jest po prostu ignorowane.
        this.preferredServers = config.preferred_servers || []; // MCP servers to auto-connect on activation
        this.preferredTools = config.preferred_tools || []; // Standalone MCP tools to auto-connect
        // Server-level isolation: mcp_servers[] = whitelist of MCP servers visible to this agent.
        //   - undefined / missing field (nie-tablica) → security-first default
        //     ['vault','memory','core'].
        //   - ['*'] → wildcard (all tools).
        //   - ['vault', 'memory', 'core'] → security-first default.
        //   - [] → only 'core' (essentials).
        // `can_message[]` USUNIĘTE. Pole zostało skasowane jako byt ("każdy pisze do każdego"),
        //   a od tamtej pory runtime tylko je przepisywał tam i z powrotem - zero egzekwowania.
        //   Zostawało jako wydmuszka udająca uprawnienie. Kto z kim rozmawia, rozstrzyga dziś
        //   `komunikator_visible`. Stare YAML-e z tym polem ładują się bez zmian - nieznane
        //   pola są po prostu ignorowane.
        this.mcp_servers = Array.isArray(config.mcp_servers)
            ? [...config.mcp_servers]
            : ['vault', 'memory', 'core'];
        // Rola rozpuszczona - effective_mcp_servers to teraz zwykłe lustro mcp_servers
        // (roleDefinition skasowane).
        this.effective_mcp_servers = [...this.mcp_servers];
        this.isBuiltIn = config.isBuiltIn || false;
        this.filePath = config.filePath || null;
        this.promptOverrides = config.prompt_overrides || {}; // per-agent prompt section overrides
        this.agentRules = config.agent_rules || ''; // domain-specific rules
        this.crystalSeed = config.crystal_seed || null; // null = use name as seed
        // Memory v3: workflow-instructional prompts (analog system prompt) used when a
        // workflow/tool needs the agent to think/propose in a constrained role - not regular chat.
        // Empty string = "not set" → resolved to global (Settings→Prompt) or factory default via
        // `resolveWorkPrompt` at the consumer (SaveSessionWorkflow/ArchiveWorkflow/Summarizer/SubAgentRunner).
        // A fresh agent still gets a working LLM path (factory fallback).
        // - save_session_prompt: /save session LLM proposal (transcript → brain/ notes; brain.md index rebuilt)
        // - archive_prompt:      ArchiveWorkflow Phase 1 dedup (notes → merges + deletions)
        // - summary_prompt:      ArchiveWorkflow Phase 2/3/4 (L1/L2/L3 synthetic summaries; {{LEVEL}} token)
        // - compression_prompt:  context-window compression skeleton (Summarizer)
        // - subagent_frame_prompt: sub-agent task frame skeleton (SubAgentRunner)
        this.save_session_prompt = config.save_session_prompt || '';
        this.archive_prompt = config.archive_prompt || '';
        this.summary_prompt = config.summary_prompt || '';
        this.compression_prompt = config.compression_prompt || '';
        this.subagent_frame_prompt = config.subagent_frame_prompt || '';
        // Ratunek pamięci przed kompresją okna. Per-agent ON/OFF
        // (default ON). Konsumowane w chat_session._saveMemoryCandidates. `mem_proactive` (auto-zapis)
        // sterowane osobno przez decisionTreeInstructions; idle (zapis po bezczynności) = globalny.
        this.memory_rescue = config.memory_rescue !== false;

        // Runtime state
        this.lastActivity = null;
    }

    /** Crystal Soul color - explicit or auto-derived from name */
    get crystalColor() {
        return this.color || Agent.deriveColor(this.name);
    }

    /** Effective seed for CrystalGenerator - custom or fallback to name */
    get effectiveCrystalSeed() {
        return this.crystalSeed || this.name;
    }

    // ─── Sub-agent getters ───

    /** @returns {Object[]} All active sub-agents (active !== false) */
    get activeSubAgents() { return this._subAgents.filter(s => s.active !== false); }

    /** @returns {Object|null} First active sub-agent with default:true */
    get defaultSubAgent() {
        return this._subAgents.find(s => s.default && s.active !== false) || null;
    }

    /**
     * @returns {Object|null} Preferowany sub-agent "prep" (heurystyka po nazwie / default / pierwszy).
     * Brak podziału research/strateg - szukamy wśród WSZYSTKICH aktywnych subów.
     */
    get prepSubAgent() {
        const subs = this.activeSubAgents;
        if (subs.length === 0) return null;
        return subs.find(s => s.name?.includes('prep'))
            || subs.find(s => s.default)
            || subs[0];
    }

    /** @returns {Object|null} Get sub-agent assignment by name */
    getSubAgentAssignment(name: string) {
        return this._subAgents.find(s => s.name === name) || null;
    }

    /** @returns {string[]} ALL sub-agent names including inactive */
    getAllSubAgentNames() {
        return this._subAgents.map(s => s.name);
    }
    // Delegates (Tryby v2) ───
    /** @returns {Array<{name: string, role: string}>} All active sub-agents */
    getActiveDelegates() {
        return this.activeSubAgents.map(s => ({
            name: s.name,
            role: s.role || 'researcher',
            type: s.role === 'strategist' ? 'strategist' : 'researcher'
        }));
    }

    // ─── Skills multi-format getters ───

    /** @returns {string[]} Skill names (backward compat - returns just names) */
    get skills(): string[] { return this._skills.map(s => s.name); }

    /** Setter - normalizes input (string[] or object[]) into _skills format */
    set skills(value: AgentConfig['skills']) { this._skills = Agent._normalizeSkillAssignments(value); }

    /** @returns {Object|null} Get skill assignment object by name */
    getSkillAssignment(name: string) {
        return this._skills.find(s => s.name === name) || null;
    }

    // ─── Artifact types ───

    /** @returns {string[]} Podpięte nazwy typów artefaktów (puste = default `plan` per loader) */
    get artifact_types(): string[] { return [...this._artifactTypes]; }

    /** Setter - normalizuje wejście (string[] → lista nazw) */
    set artifact_types(value: AgentConfig['artifact_types']) { this._artifactTypes = Agent._normalizeArtifactTypes(value); }

    /**
     * Build + configure a `PromptBuilder` instance for this agent (build + user-disabled
     * sections + dynamic memory section). Wspólne dla `getSystemPrompt` i `getPromptSections` -
     * obie metody dotąd powielały identyczną konfigurację i różniły się TYLKO ostatnią linią
     * zwrotki, co wymuszało ręczne powtórzenie tego samego fixa bezpieczeństwa w dwóch miejscach.
     * @param {Object} [context] - Enriched context from AgentManager
     */
    _buildConfiguredPromptBuilder(context: AgentPromptContext = {}): PromptBuilder {
        const builder = new PromptBuilder();
        builder.build(this, context);

        // Apply user-disabled sections from settings
        if ((context.disabledPromptSections?.length as number) > 0) {
            builder.applyDisabledSections(context.disabledPromptSections);
        }

        // Dynamic sections: memory and project context (passed in context)
        // Treść pamięci idzie WPROST. Dawna owijka `--- === PAMIĘĆ DŁUGOTERMINOWA === ---` /
        // `--- === KONIEC PAMIĘCI === ---` była drugim, podrabialnym płotem WEWNĄTRZ prawdziwego -
        // dokładnie tym kształtem, którym złośliwy ładunek w pamięci mógł udawać koniec sekcji.
        // Prawdziwe ogrodzenie stawia `addDynamicSection` → `fenceUntrusted` →
        // `<vault_content source="memory">`, i ono ESCAPUJE treść, więc nie da się go zamknąć
        // od środka. Nagłówek `## Długoterminowa pamięć` (z `AgentMemory.getMemoryContext`)
        // ZOSTAJE - to etykieta sekcji, nie granica zaufania.
        if (context.memoryContext) {
            builder.addDynamicSection('memory', t('agent.section.memory'), context.memoryContext);
        }
        // Sekcja `project_context` skasowana razem z Project Hubem.
        // Osobna sekcja "Wiadomości" też OUT - ping to JEDNA linijka w drzewie
        // decyzyjnym (PromptBuilder._injectInboxNotification), bez ścieżki pliku i bez treści.

        return builder;
    }

    /**
     * Get the full system prompt for this agent using PromptBuilder.
     * @param {Object} [context] - Enriched context from AgentManager
     * @returns {string} Complete system prompt
     */
    getSystemPrompt(context: AgentPromptContext = {}) {
        return this._buildConfiguredPromptBuilder(context).getPrompt();
    }

    /**
     * Get prompt sections metadata for Prompt Inspector UI.
     * @param {Object} [context] - Same context as getSystemPrompt
     * @returns {{sections: Array, breakdown: Object}}
     */
    getPromptSections(context: AgentPromptContext = {}) {
        const builder = this._buildConfiguredPromptBuilder(context);
        return {
            sections: builder.getSections(),
            breakdown: builder.getTokenBreakdown(),
        };
    }

    /**
     * Get display info for UI
     * @returns {Object} { name, color, description, isBuiltIn }
     */
    getDisplayInfo() {
        return {
            name: this.name,
            color: this.crystalColor,
            description: this.description,
            isBuiltIn: this.isBuiltIn
        };
    }

    /**
     * Serialize agent to object (for saving to YAML)
     * @returns {Object} Serialized agent data
     */
    serialize() {
        const data: Record<string, unknown> = {
            name: this.name,
            access_policy_version: ACCESS_POLICY_VERSION,
        };

        // Default OFF - zapisuj tylko świadomie włączony stan.
        if (this.admin_access === true) data.admin_access = true;
        // Default ON - zapisuj tylko świadomie wyłączony stan (wzór memory_rescue).
        if (this.komunikator_visible === false) data.komunikator_visible = false;
        if (this.color) data.color = this.color;
        // Default OFF - jak `color`; puste pole nie zaśmieca yamla znakiem placeholderu.
        if (this.emoji) data.emoji = this.emoji;
        // `archetype` i `role` na AGENCIE nie są już serializowane (byty skasowane) -
        // stare YAML-e z tymi polami ładują się bez błędu, pola są ignorowane.
        if (this.personality) data.personality = this.personality;
        // persona_drift nie jest już serializowany (mechanizm skasowany, uśpiony).
        if (this.description) data.description = this.description;
        if (this.createdAt) data.created_at = this.createdAt;
        // Pisz `model` TYLKO gdy pochodzi ze źródła (yaml) albo user jawnie je ustawił
        // przez update() - nigdy z drogi, która nie jest jednym z tych dwóch przypadków.
        if (this.model && this._modelFromSource) data.model = this.model;
        if (this.temperature !== 0.7) data.temperature = this.temperature;
        // Nowe pola per-agent - zapisuj tylko gdy różne od defaultu.
        if (this.language && this.language !== 'auto') data.language = this.language;
        if (this.default_autonomy) data.default_autonomy = this.default_autonomy;
        if (this.focusFolders.length > 0) {
            // Backward compat: readwrite entries saved as plain strings; group references round-trip.
            data.focus_folders = this.focusFolders.map(f => {
                if (f.group) return { group: f.group };
                if (f.access === 'readwrite') return f.path;
                return { path: f.path, access: f.access };
            });
        }
        if (this._skills.length > 0) {
            // Save with overrides if any, plain strings otherwise (backward compat)
            const hasOverrides = this._skills.some(s => s.overrides && Object.keys(s.overrides).length > 0);
            if (hasOverrides) {
                data.skills = this._skills.map(s => {
                    if (!s.overrides || Object.keys(s.overrides).length === 0) return s.name;
                    return { name: s.name, overrides: s.overrides };
                });
            } else {
                data.skills = this._skills.map(s => s.name);
            }
        }
        // Podpięte typy artefaktów - zapisuj tylko gdy niepuste (puste = default plan).
        if (this._artifactTypes.length > 0) data.artifact_types = [...this._artifactTypes];
        // `enabled_tools` NIE jest już serializowane (martwa oś). `disabled_tools`
        // to jedyna oś narzędziowa - zapisuj zawsze (jawny stan on/off całego zestawu built-in).
        data.disabled_tools = [...this.disabled_tools];

        // Sub-agents: save as unified array (new format)
        if (this._subAgents.length > 0) {
            data.sub_agents = this._subAgents.map(s => {
                const entry: AgentSubAgentAssignment = { name: s.name, role: s.role || 'researcher' };
                if (s.default) entry.default = true;
                if (s.active === false) entry.active = false;
                if (s.overrides && Object.keys(s.overrides).length > 0) entry.overrides = s.overrides;
                return entry;
            });
        }
        if (Object.keys(this.models).length > 0) data.models = this.models;
        if (this.preferredServers?.length > 0) data.preferred_servers = this.preferredServers;
        if (this.preferredTools?.length > 0) data.preferred_tools = this.preferredTools;
        if (Array.isArray(this.mcp_servers)) {
            data.mcp_servers = [...this.mcp_servers];
        }
        if (Object.keys(this.promptOverrides).length > 0) data.prompt_overrides = this.promptOverrides;
        if (this.agentRules) data.agent_rules = this.agentRules;
        if (this.crystalSeed) data.crystal_seed = this.crystalSeed;
        // Per-agent work-prompt overrides - persist only when set (empty = use global/factory).
        if (this.save_session_prompt) data.save_session_prompt = this.save_session_prompt;
        if (this.archive_prompt) data.archive_prompt = this.archive_prompt;
        if (this.summary_prompt) data.summary_prompt = this.summary_prompt;
        if (this.compression_prompt) data.compression_prompt = this.compression_prompt;
        if (this.subagent_frame_prompt) data.subagent_frame_prompt = this.subagent_frame_prompt;
        // Zapisuj tylko gdy wyłączony (default ON).
        if (this.memory_rescue === false) data.memory_rescue = false;

        // Only save non-default permissions.
        // this.permissions ma już tylko znane klucze (_normalizePermissions filtruje
        // widma/yolo_mode w konstruktorze), więc żaden dodatkowy guard nie jest potrzebny.
        const customPermissions: Partial<AgentPermissions> = {};
        for (const [key, value] of Object.entries(this.permissions) as [keyof AgentPermissions, boolean][]) {
            if (value !== DEFAULT_PERMISSIONS[key]) {
                customPermissions[key] = value;
            }
        }
        if (Object.keys(customPermissions).length > 0) {
            data.default_permissions = customPermissions;
        }

        // Only save non-default approval toggles
        if (Object.keys(this.approvalToggles).length > 0) {
            data.approval_toggles = this.approvalToggles;
        }

        return data;
    }

    /**
     * Update agent configuration
     * @param {Object} updates - Fields to update
     */
    update(updates: AgentUpdate) {
        const allowedFields = [
            'name', 'emoji', 'color', 'crystal_seed', 'personality', 'description', 'model',
            'temperature', 'focus_folders', 'default_permissions', 'approval_toggles', 'skills',
            'admin_access',
            // Uczestnictwo w komunikatorze (default true).
            'komunikator_visible',
            'disabled_tools', 'sub_agents', 'artifact_types',
            'models', 'preferred_servers', 'preferred_tools', 'prompt_overrides', 'agent_rules', 'created_at',
            'mcp_servers',
            // Język odpowiedzi + domyślna autonomia per agent
            'language', 'default_autonomy',
            // Per-agent work-prompt overrides
            'save_session_prompt', 'archive_prompt', 'summary_prompt',
            'compression_prompt', 'subagent_frame_prompt',
            // Ratunek pamięci przed kompresją (per-agent ON/OFF)
            'memory_rescue',
        ];

        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                if (key === 'focus_folders') {
                    this.focusFolders = Agent._normalizeFocusFolders(value);
                } else if (key === 'default_permissions') {
                    this.permissions = Agent._normalizePermissions(value);
                } else if (key === 'approval_toggles') {
                    this.approvalToggles = value || {};
                } else if (key === 'sub_agents') {
                    this._subAgents = Agent._normalizeSubAgentAssignments(value);
                } else if (key === 'disabled_tools') {
                    // Jedyna oś narzędziowa (negatywna lista, core nieusuwalny).
                    this.disabled_tools = normalizeDisabledTools(value);
                } else if (key === 'models') {
                    this.models = Agent._normalizeModelOverrides(value);
                } else if (key === 'preferred_servers') {
                    this.preferredServers = value || [];
                } else if (key === 'preferred_tools') {
                    this.preferredTools = value || [];
                } else if (key === 'mcp_servers') {
                    // Whitelist of MCP servers.
                    // effective_mcp_servers = lustro mcp_servers (roleDefinition skasowane).
                    this.mcp_servers = Array.isArray(value) ? [...value] : ['vault', 'memory', 'core'];
                    this.effective_mcp_servers = [...this.mcp_servers];
                } else if (key === 'prompt_overrides') {
                    this.promptOverrides = value || {};
                } else if (key === 'agent_rules') {
                    this.agentRules = value || '';
                } else if (key === 'created_at') {
                    this.createdAt = value;
                } else if (key === 'crystal_seed') {
                    this.crystalSeed = value || null;
                } else if (key === 'komunikator_visible') {
                    // Tylko jawne `false` robi ducha - śmieć z UI/YAML nie wyłącza poczty.
                    this.komunikator_visible = value !== false;
                } else if (key === 'admin_access') {
                    // Ten sam normalizator co w konstruktorze.
                    // Bez tej gałęzi pole szło przez `this[key] = value` i po `update()` mogło
                    // trzymać wartość nie-boolowską (np. `'yes'` z ręcznie pisanego YAML-a).
                    // Konsumenci porównują ściśle (`=== true`), więc to nie była luka - ale dwa
                    // różne kształty tego samego pola to mina pod pierwszy nie-ścisły odczyt.
                    this.admin_access = normalizeAdminAccess(value);
                } else if (key === 'default_autonomy') {
                    // Normalizuj albo wyzeruj (null = użyj globalnego defaultu).
                    this.default_autonomy = value ? normalizeAutonomy(value) : null;
                } else if (key === 'model') {
                    // `update()` z jawnym kluczem `model` to zawsze albo odczyt z yamla przy
                    // migracji, albo jawna decyzja usera w UI - nigdy auto-fill silnika (którego
                    // nie ma). Flaga zostaje `true` nawet gdy `value` jest puste/null: user, który
                    // ŚWIADOMIE czyści pole, nadal "ma o nim zdanie" - serialize() i tak nic nie
                    // wypisze, bo `this.model` będzie falsy (bramka jest `&&`, nie samo `_modelFromSource`).
                    this.model = value || null;
                    this._modelFromSource = true;
                } else {
                    // covers: language (plain), emoji, and any other allowed scalar field
                    this[key] = value;
                }
            } else if (key !== 'access_policy_version') {
                // Klasa ma otwartą sygnaturę indeksu (`[extra: string]: unknown`), więc
                // `agent.cokolwiek` przechodzi typecheck nawet gdy pole nie istnieje nigdzie -
                // literówka w kluczu `updates` (np. wołacz pisze `defualt_permissions`) ginęła
                // tu po cichu, bez śladu. Pole nadal NIE jest zapisywane (whitelist `allowedFields`
                // bez zmian) - dokładamy tylko log.
                // Wyjątek `access_policy_version`: `serialize()` emituje je ZAWSZE (linia
                // wyżej w pliku), więc KAŻDY zapis nadpisań built-ina odczytany z powrotem
                // przez `AgentLoader._mergeBuiltInOverrides` niósłby to pole do `update()` -
                // to nie literówka, to świadomie pominięte pole schematu (ustawiane wyłącznie
                // przez konstruktor/migrację), więc ostrzegałoby na KAŻDYM starcie Jaskra.
                log.warn('Agent', `update("${this.name}"): pole „${key}" spoza znanego zestawu odrzucone (literówka w wołaczu?).`);
            }
        }
    }

    // personaDrift skasowany - _normalizePersonaDrift/getEffectivePersonality/
    // shouldReviewDrift/applyDriftUpdate usunięte (mechanizm uśpiony, 0 writerów).

    /**
     * Normalize permissions - start from DEFAULT_PERMISSIONS, nadpisz TYLKO znanymi kluczami.
     * Nieznane klucze (widma/legacy: yolo_mode, execute_commands, thinking, access_outside_vault,
     * building_agents, system_settings, skills_crud) są ignorowane - nie wchodzą do obiektu.
     * @param {Object|null|undefined} raw - config.default_permissions z YAML
     * @returns {Object} tylko znane klucze
     */
    static _normalizePermissions(raw: AgentConfig['default_permissions'] | null | undefined): AgentPermissions {
        const perms = { ...DEFAULT_PERMISSIONS };
        if (raw && typeof raw === 'object') {
            for (const key of Object.keys(DEFAULT_PERMISSIONS)) {
                if (key in raw) perms[key as keyof AgentPermissions] = (raw as Record<string, boolean>)[key];
            }
        }
        return perms;
    }

    /**
     * Normalize focusFolders from mixed formats to {path, access}[].
     * Handles: string[], {path,access}[], and mixed arrays.
     * @param {Array} input
     * @returns {Array<{path: string, access: 'read'|'readwrite'}>}
     */
    static _normalizeFocusFolders(input: AgentConfig['focus_folders']): AgentFocusFolder[] {
        if (!input || !Array.isArray(input)) return [];
        const normalized: AgentFocusFolder[] = input
            .filter(f => f)
            .map(f => {
                if (typeof f === 'string') {
                    return { path: f, access: 'readwrite' };
                }
                // Grupa folderów (Settings→Vault) - przechowuj referencję, NIE rozwijaj.
                // Rozwiązanie do konkretnych folderów jest w AccessGuard/_buildEnvironment przy użyciu.
                if (f.group) {
                    return { group: String(f.group) };
                }
                return { path: f.path || String(f), access: f.access || 'readwrite' };
            });
        // Odfiltruj martwe wpisy `.pkm-assistant*` (pamięć/skille mają własne drzwi;
        // nie są przypisanymi folderami roboczymi vaulta). Grupy zostają nietknięte.
        const cleaned = normalized.filter(f => f.group || !String(f.path).startsWith('.pkm-assistant'));
        if (cleaned.length !== normalized.length) {
            const dropped = normalized.filter(f => !f.group && String(f.path).startsWith('.pkm-assistant')).map(f => f.path);
            log.debug('Agent', `focus_folders: odfiltrowano martwe wpisy .pkm-assistant: ${dropped.join(', ')}`);
        }
        return cleaned;
    }

    static _normalizeModelOverrides(input: AgentConfig['models']): Record<string, unknown> {
        const models = { ...(input || {}) };
        if (models.minion && !models.researcher) models.researcher = models.minion;
        if (models.master && !models.strategist) models.strategist = models.master;
        delete models.minion;
        delete models.master;
        return models;
    }

    /**
     * Normalize sub-agent assignments from mixed formats to {name, role, default?, active?, overrides?}[].
     * @param {Array} input - Sub-agent array [{name, role, ...}]
     * @returns {Array<{name: string, role: string, default?: boolean, active?: boolean, overrides?: Object}>}
     */
    static _normalizeSubAgentAssignments(input: AgentConfig['sub_agents']): AgentSubAgentAssignment[] {
        if (!input || !Array.isArray(input)) return [];
        return input
            .filter(a => a)
            .map(a => {
                if (typeof a === 'string') return { name: a, role: 'researcher' };
                const name = a.name || String(a);
                return {
                    name,
                    role: a.role || 'researcher',
                    ...(a.default ? { default: true } : {}),
                    ...(a.active === false ? { active: false } : {}),
                    ...(a.overrides && Object.keys(a.overrides).length > 0 ? { overrides: a.overrides } : {})
                };
            })
            .slice(0, MAX_SUB_AGENTS);
    }
    /**
     * Normalize skill assignments from mixed formats to {name, overrides?}[].
     * Handles: ['name'] (v1 string array), [{name, overrides?}] (v2 objects), mixed.
     * @param {Array|null} input - Skills array or null
     * @returns {Array<{name: string, overrides?: Object}>}
     */
    static _normalizeSkillAssignments(input: AgentConfig['skills']): AgentSkillAssignment[] {
        if (!input || !Array.isArray(input)) return [];
        return input
            .filter(s => s)
            .map(s => {
                if (typeof s === 'string') return { name: s };
                return {
                    name: s.name || String(s),
                    ...(s.overrides && Object.keys(s.overrides).length > 0 ? { overrides: s.overrides } : {})
                };
            });
    }

    /**
     * Normalize artifact type assignments to a clean string[].
     * Accepts ['plan'] (strings) or [{name}] (objects, backward-tolerant).
     * @param {Array|null} input
     * @returns {string[]}
     */
    static _normalizeArtifactTypes(input: AgentConfig['artifact_types']): string[] {
        if (!input || !Array.isArray(input)) return [];
        const out = [];
        const seen = new Set();
        for (const item of input) {
            const name = typeof item === 'string' ? item : (item && item.name);
            if (typeof name !== 'string' || !name.trim()) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            out.push(name);
        }
        return out;
    }

    /**
     * Check if agent has a specific permission
     * @param {string} permission - Permission key
     * @returns {boolean}
     */
    hasPermission(permission: keyof AgentPermissions) {
        return this.permissions[permission] === true;
    }
}
