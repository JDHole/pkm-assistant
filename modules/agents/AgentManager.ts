/**
 * AgentManager
 * Central manager for all agents - loading, switching, and managing agent state
 */
import { Notice } from 'obsidian';
import { AgentLoader } from './AgentLoader.js';
import { Agent } from './Agent.js';
import type { AgentPromptContext } from './Agent.js';
import { defaultDisabledTools } from './toolAxis.js';
import { AgentMemory, MigrationV3 } from '../../modules/memory/index.js';
import { MigrationModal } from './MigrationModal.js';
import { runMigrationReview } from './migrationReviewFlow.js';
import { SkillLoader, SkillTemplateStore } from '../../modules/skills/index.js';
import { ArtifactTypeLoader } from '../../modules/artifacts/index.js';
import { SubAgentLoader, SubAgentTemplateStore } from '../../modules/sub-agents/index.js';
import { PlaybookManager } from '../../modules/onboarding/index.js';
import {
    KomunikatorManager,
    isKomunikatorEnabled,
    isKomunikatorVisible,
    listKomunikatorAgents,
    findKomunikatorAgent,
} from '../../modules/komunikator/index.js';
import { log } from '../../core/utils/Logger.js';
import { clearModelCache } from '../../modules/models/index.js';
import { getDateLocale, t } from '../../core/i18n/index.js';
import { getAgentSafeName } from '../../core/index.js';
import { createJaskier } from './archetypes/HumanVibe.js';
import { VaultMap } from './VaultMap.js';
import { ensureFactoryTemplates } from './factoryTemplates.js';
import { renameAgentOnDisk } from './renameAgentFlow.js';

// TS-any: manager is the DI boundary for runtime loaders still supplied by JavaScript modules in this migration wave.
type RuntimeDependency = any;
interface PromptRuntimeContext extends AgentPromptContext {
    vaultMapDescriptions?: Record<string, string>;
    inboxPing?: { count: number; senders: string[] } | null;
    activeArtifactId?: string;
    activeArtifact?: RuntimeDependency;
}

/**
 * AgentManager class - manages all agents and their state
 */
export class AgentManager {
    declare vault: RuntimeDependency;
    declare settings: RuntimeDependency;
    declare plugin: RuntimeDependency;
    declare loader: AgentLoader;
    declare skillLoader: RuntimeDependency;
    declare artifactTypeLoader: RuntimeDependency;
    declare subAgentLoader: RuntimeDependency;
    declare skillTemplateStore: RuntimeDependency;
    declare subAgentTemplateStore: RuntimeDependency;
    declare playbookManager: RuntimeDependency;
    declare komunikatorManager: RuntimeDependency;
    declare vaultMap: VaultMap;
    declare agents: Map<string, Agent>;
    declare activeAgent: Agent | null;
    declare agentMemories: Map<string, RuntimeDependency>;
    declare listeners: Array<(event: string, data: RuntimeDependency) => void>;
    declare _unwatchAgents: (() => void) | null;
    /**
     * @param {Object} vault - Obsidian Vault object
     * @param {Object} settings - Plugin settings
     */
    constructor(vault: RuntimeDependency, settings: RuntimeDependency, plugin: RuntimeDependency = null) {
        this.vault = vault;
        this.settings = settings;
        this.plugin = plugin;
        this.loader = new AgentLoader(vault);
        this.skillLoader = new SkillLoader(vault);
        // E2.9 A2: biblioteka typów artefaktów żywych (wzór skillLoader — owner = AgentManager).
        this.artifactTypeLoader = new ArtifactTypeLoader(vault);
        this.subAgentLoader = new SubAgentLoader(vault);
        // S27 Z1: magazyny SZABLONÓW (Zaplecze = katalog form odlewniczych, nie żywych bytów).
        // Owner jak przy skillLoader/subAgentLoader — jedno miejsce instancjonowania.
        this.skillTemplateStore = new SkillTemplateStore(vault);
        this.subAgentTemplateStore = new SubAgentTemplateStore(vault);
        this.playbookManager = new PlaybookManager(vault);
        // E1.2 kill-switch: only instantiate the communicator when enabled (default false).
        // When null, every komunikatorManager callsite below is guarded with optional chaining.
        this.komunikatorManager = isKomunikatorEnabled(settings)
            ? new (KomunikatorManager as unknown as new (...args: RuntimeDependency[]) => RuntimeDependency)(vault, this)
            : null;
        // W8 follow-up (AUD-wydajnosc-028/058/101, review koordynatora 2026-09-02): kesz
        // nagłówków skrzynki w KomunikatorManager widzi TYLKO mutacje przez metody managera —
        // zapisy Z ZEWNĄTRZ (sesja Claude Code piszącą wprost na dysk przez kontrakt /agent,
        // sync Google Drive między urządzeniami, obsidian-git pull) go omijają. `attachVaultEvents`
        // dopina nasłuch create/modify/delete/rename na SKRZYNKACH; `plugin.registerEvent`
        // (Obsidian Component) daje właściwe sprzątanie przy unload — wzór
        // `VaultIndexer._registerHooks` w modules/embedding/VaultIndexer.ts. Bez `plugin`
        // (np. część testów konstruuje AgentManager bez niego) po prostu nie podpinamy —
        // TTL w KomunikatorManager (5s) zostaje jedyną siatką bezpieczeństwa.
        this.komunikatorManager?.attachVaultEvents?.(
            this.plugin?.registerEvent ? (ref: unknown) => this.plugin.registerEvent(ref) : undefined,
        );
        this.vaultMap = new VaultMap(vault);

        /** @type {Map<string, Agent>} */
        this.agents = new Map();

        /** @type {Agent|null} */
        this.activeAgent = null;

        /** @type {Map<string, AgentMemory>} Agent memory instances */
        this.agentMemories = new Map();

        /** @type {Function[]} Event listeners */
        this.listeners = [];
        this._unwatchAgents = null;
    }

    /**
     * Initialize the agent manager - load all agents
     * @returns {Promise<void>}
     */
    async initialize() {
        const initStart = Date.now();
        log.group('AgentManager', 'initialize()');
        try {
            const allAgents = await this.loader.loadAllAgents();
            log.debug('AgentManager', `Załadowano ${allAgents.length} agentów: ${allAgents.map(a => a.name).join(', ')}`);

            // E2: Initialize agent memories in parallel
            await Promise.all(allAgents.map(async (agent) => {
                try {
                    this.agents.set(agent.name, agent);
                    const memory = await this._initializeMemoryForAgent(agent);
                    this.agentMemories.set(agent.name, memory);
                    log.debug('AgentManager', `Pamięć ${agent.name}: OK`);
                } catch (agentError) {
                    log.error('AgentManager', `Błąd inicjalizacji agenta "${agent.name}" — pomijam, reszta się ładuje:`, agentError);
                }
            }));

            // Set default active agent (Jaskier or first available)
            const defaultAgentName = this.settings?.defaultAgent || 'Jaskier';
            this.activeAgent = this.agents.get(defaultAgentName) || allAgents[0] || null;
            log.info('AgentManager', `Aktywny agent: ${this.activeAgent?.name || 'BRAK'}`);

            // E1: Load independent resources in parallel
            await Promise.all([
                (async () => {
                    await this.skillLoader.ensureStarterSkills();
                    await this.skillLoader.loadAllSkills();
                    log.debug('AgentManager', `Skills: ${this.skillLoader.cache?.size || 0} załadowanych`);
                })(),
                (async () => {
                    await this.subAgentLoader.ensureStarterSubAgents();
                    await this.subAgentLoader.loadAllSubAgents();
                    log.debug('AgentManager', `Sub-agents: ${this.subAgentLoader.cache?.size || 0} załadowanych`);
                })(),
                // E3.5: po loadAll seed fabrycznych szablonów Deep Research (RAZ, marker;
                // kasacja usera szanowana — patrz factoryTemplates.js).
                (async () => {
                    await this.skillTemplateStore.loadAll();
                    await this.subAgentTemplateStore.loadAll();
                    await ensureFactoryTemplates({
                        vault: this.vault,
                        skillTemplateStore: this.skillTemplateStore,
                        subAgentTemplateStore: this.subAgentTemplateStore,
                    });
                    log.debug('AgentManager', `Szablony: ${this.skillTemplateStore.count()} skilli / ${this.subAgentTemplateStore.count()} subów`);
                })(),
                (async () => {
                    await this.artifactTypeLoader.ensureBuiltinTypes();
                    await this.artifactTypeLoader.loadAllTypes();
                    log.debug('AgentManager', `Artifact types: ${this.artifactTypeLoader.cache?.size || 0} załadowanych`);
                })(),
                this.komunikatorManager?.ensureFolder(),
                this.vaultMap.initialize(),
            ]);

            if (!this._unwatchAgents) {
                // AUD-dead-code-068 (fabryka kasacji S1, 2026-09-02): emit `agents:changed`
                // skasowany — grep po calym repo (core/modules/src/config/utils/harness, w
                // tym testy) nie znalazl ani jednego sluchacza tej nazwy; wszyscy filtruja po
                // `agents:reloaded`, ktore `reload()` i tak emituje linijke wyzej.
                this._unwatchAgents = this.loader.watchAgents(() => {
                    void this.reload();
                });
            }

            // Playbooks depend on skills + sub-agents being loaded
            await this.playbookManager.ensureStarterFiles(allAgents);

            this._emit('agents:loaded', { count: this.agents.size });

            log.timing('AgentManager', 'initialize()', initStart);
            log.groupEnd();
        } catch (error) {
            log.error('AgentManager', 'Initialization FAIL:', error);
            log.groupEnd();
        }
    }

    /**
     * Get all agents as array
     * @returns {Agent[]}
     */
    getAllAgents() {
        return Array.from(this.agents.values());
    }

    // ─── Komunikator: widoczność per agent (S28 D6) ───
    // AgentManager jest jedyną bramką dla narzędzi i UI — dzięki temu `modules/tools/`
    // nie musi importować komunikatora, a filtr ducha ma JEDNO źródło prawdy
    // (`modules/komunikator/visibility.js`).

    /**
     * Czy agent uczestniczy w komunikatorze (brak pola = tak).
     * @param {Agent|string} agentOrName
     * @returns {boolean}
     */
    isKomunikatorVisible(agentOrName: Agent | string | null | undefined) {
        const agent = typeof agentOrName === 'string' ? this.getAgent(agentOrName) : agentOrName;
        return isKomunikatorVisible(agent);
    }

    /**
     * Agenci widoczni w komunikatorze (adresaci, panele skrzynek, liczniki, ping).
     * @returns {Agent[]}
     */
    listKomunikatorAgents(): Agent[] {
        // Filtr `listKomunikatorAgents` jest strukturalny (`{name, komunikator_visible}`), ale
        // karmimy go WŁASNYM `getAllAgents()`, więc na wyjściu są te same instancje `Agent`.
        return listKomunikatorAgents(this) as Agent[];
    }

    /**
     * Znajdź WIDOCZNEGO adresata po nazwie (dokładnie, potem bez wielkości liter).
     * Agent-duch nigdy się tu nie pojawi — caller nie odróżni go od literówki.
     * @param {string} name
     * @returns {Agent|null}
     */
    findKomunikatorAgent(name: string) {
        return findKomunikatorAgent(this, name);
    }

    /**
     * Ping skrzynki dla promptu (S28 D4): ile nieprzeczytanych przez AI + od kogo.
     * Zwraca `null`, gdy komunikator śpi albo agent w nim nie uczestniczy — wtedy
     * prompt nie dostaje ani jednej linijki więcej.
     * @param {Agent} agent
     * @returns {Promise<{count: number, senders: string[]}|null>}
     */
    async getInboxPing(agent: Agent | null | undefined) {
        if (!agent?.name || !this.komunikatorManager) return null;
        if (!this.isKomunikatorVisible(agent)) return null;
        const ping = await this.komunikatorManager.getInboxPing(agent.name);
        return ping?.count > 0 ? ping : null;
    }

    /**
     * Get agent by name
     * @param {string} name - Agent name
     * @returns {Agent|undefined}
     */
    getAgent(name: string) {
        return this.agents.get(name);
    }

    /**
     * Get currently active agent
     * @returns {Agent|null}
     */
    getActiveAgent() {
        return this.activeAgent;
    }

    /**
     * Switch to a different agent
     * @param {string} name - Agent name to switch to
     * @returns {boolean} Success status
     */
    switchAgent(name: string) {
        const agent = this.agents.get(name);
        if (!agent) {
            log.error('AgentManager', 'Agent not found:', name);
            return false;
        }

        const previousAgent = this.activeAgent;
        this.activeAgent = agent;
        this.activeAgent.lastActivity = Date.now();

        // Invalidate model cache — new agent may use a different model
        clearModelCache();

        log.info('AgentManager', `agent:switched: ${previousAgent?.name ?? '(none)'} → ${agent.name}`);
        this._emit('agent:switched', {
            previous: previousAgent?.name,
            current: agent.name
        });

        return true;
    }

    /**
     * Get memory instance for active agent
     * @returns {AgentMemory|null}
     */
    getActiveMemory() {
        if (!this.activeAgent) return null;
        const memory = this.agentMemories.get(this.activeAgent.name) || null;
        // BUG-007+011 safety: verify memory belongs to active agent
        if (memory && memory.agentName !== this.activeAgent.name) {
            log.warn('AgentManager', `Memory mismatch! agent="${this.activeAgent.name}" memory="${memory.agentName}"`);
        }
        return memory;
    }

    /**
     * Get memory instance for specific agent
     * @param {string} agentName
     * @returns {AgentMemory|null}
     */
    getAgentMemory(agentName: string) {
        return this.agentMemories.get(agentName) || null;
    }

    getMemoryForAgent(agent: Agent | string | null | undefined) {
        const name = typeof agent === 'string' ? agent : agent?.name;
        return name ? (this.agentMemories.get(name) || null) : null;
    }

    async _initializeMemoryForAgent(agent: Agent) {
        const memory = new AgentMemory(this.vault, agent.name, this.settings);
        const migration = new MigrationV3(memory, {
            modalFactory: this.plugin?.app
                ? (opts) => new MigrationModal(this.plugin.app, opts) as never
                : null,
        });

        // Werdykt właściciela 2026-08-27 (AUD-docs-051): Cancel/X/Esc na modalu review
        // ma NAPRAWDĘ anulować — zero automatycznego powtórzenia w trybie non-interactive.
        // Cała logika decyzyjna (needsMigration → run() DOKŁADNIE RAZ → notyfikacja przy
        // odrzuceniu) siedzi w obsidian-free `runMigrationReview`, żeby dało się ją
        // przetestować prawdziwym wykonaniem — patrz `migrationReviewFlow.ts`.
        await runMigrationReview(migration, agent.name, Boolean(this.plugin?.app), (name) => {
            log.warn('AgentManager', `Memory v3 migration deferred for ${name}: user cancelled review modal (no fallback applied; will prompt again at next startup)`);
            new Notice(t('modal.memory_migration.deferred', { agent: name }));
        });

        await memory.initialize();
        return memory;
    }

    /**
     * Get skills assigned to the active agent (with per-agent overrides resolved).
     * @returns {Object[]} Array of skill objects
     */
    getActiveAgentSkills() {
        if (!this.activeAgent) return [];
        const skillNames = this.activeAgent.skills; // backward compat getter returns string[]
        return skillNames
            .map(name => this.resolveSkillConfig(name, this.activeAgent!))
            .filter(Boolean);
    }

    /**
     * Dokleja override `prompt_append` do bazowego prompta skilla/sub-agenta, wspólny separator
     * (AUD-code-review-088) — `resolveSkillConfig` i `resolveSubAgentConfig` miały tu bajt-w-bajt
     * ten sam blok (łącznie z literałem stringa separatora), poza resztą metody, która się
     * realnie różni (skille dostają `model`+`pre_question_defaults`, suby `extra_tools`+`scope`+
     * `max_iterations`).
     * @param {string|undefined} basePrompt - `base.prompt` przed override'em
     * @param {string} agentName - nazwa agenta (do nagłówka separatora)
     * @param {string|undefined} promptAppend - `ovr.prompt_append`
     * @returns {string|undefined} `basePrompt` niezmieniony, gdy `promptAppend` jest puste
     */
    _applyPromptAppend(basePrompt: string | undefined, agentName: string, promptAppend: string | undefined): string | undefined {
        if (!promptAppend) return basePrompt;
        return (basePrompt || '') + '\n\n--- Instrukcje per-agent (' + agentName + ') ---\n' + promptAppend;
    }

    /**
     * Resolve skill config with per-agent overrides merged.
     * @param {string} skillName - Skill name
     * @param {Object} agent - Agent instance
     * @returns {Object|null} Merged skill config or null
     */
    resolveSkillConfig(skillName: string, agent: Agent) {
        const base = this.skillLoader.getSkill(skillName);
        if (!base) return null;

        const assignment = agent?.getSkillAssignment?.(skillName);
        if (!assignment?.overrides) return base;

        const merged = { ...base };
        const ovr = assignment.overrides;

        if (ovr.prompt_append) {
            merged.prompt = this._applyPromptAppend(base.prompt, agent.name, ovr.prompt_append);
        }
        if (ovr.model) merged.model = ovr.model;
        if (ovr.pre_question_defaults && merged.preQuestions?.length > 0) {
            merged.preQuestions = merged.preQuestions.map((pq: RuntimeDependency) => ({
                ...pq,
                default: ovr.pre_question_defaults![pq.key] ?? pq.default
            }));
        }

        return merged;
    }

    /**
     * Typy artefaktów widoczne dla agenta (E2.9 A2). Brak/puste `artifact_types` → tylko `plan`.
     * Wzór `getSkillsForAgent`. Zwraca obiekty typów z `ArtifactTypeLoader`.
     * @param {Object} [targetAgent] - agent (default: aktywny)
     * @returns {Object[]}
     */
    getArtifactTypesForAgent(targetAgent?: Agent | null) {
        const agent = targetAgent || this.activeAgent;
        return this.artifactTypeLoader.getTypesForAgent(agent?.artifact_types);
    }

    /**
     * Reload all skills from disk
     * @returns {Promise<void>}
     */
    async reloadSkills() {
        await this.skillLoader.reloadSkills();
    }

    /**
     * Reload all sub-agents from disk
     * @returns {Promise<void>}
     */
    async reloadSubAgents() {
        await this.subAgentLoader.reloadSubAgents();
    }

    /**
     * Demontaż managera (AUD-bledy-035) — wołane z `onunload` pluginu.
     *
     * `watchAgents` wiesza na vaulcie trzy nasłuchy (`modify`/`create`/`delete`) POZA
     * `plugin.registerEvent`, a uchwyt odpięcia (`_unwatchAgents`) nie miał do tej pory ani
     * jednego wołacza. Po wyłączeniu pluginu każdy zapis pliku agenta odpalał `reload()` →
     * `initialize()` MARTWEJ instancji — a ta dopisuje pliki do vaulta (starter playbooki,
     * wbudowane typy artefaktów, folder skrzynki) i emituje `agents:reloaded`. Cykl
     * wyłącz/włącz mnożył to razy liczba przeładowań. Idempotentne.
     */
    dispose(): void {
        try {
            this._unwatchAgents?.();
        } catch (e) {
            log.warn('AgentManager', 'odpięcie watchera agentów padło (demontaż leci dalej):', e);
        }
        this._unwatchAgents = null;
    }

    /**
     * Resolve sub-agent config with per-agent overrides merged.
     * @param {string} subAgentName - Sub-agent name
     * @param {Object} agent - Agent instance
     * @returns {Object|null} Merged config or null
     */
    resolveSubAgentConfig(subAgentName: string, agent: Agent) {
        const base = this.subAgentLoader.getSubAgent(subAgentName);
        if (!base) return null;

        // Apply per-agent overrides
        const assignment = agent?.getSubAgentAssignment?.(subAgentName);

        if (!assignment?.overrides) return base;

        const merged = { ...base };
        const ovr = assignment.overrides;

        if (ovr.prompt_append) {
            merged.prompt = this._applyPromptAppend(base.prompt, agent.name, ovr.prompt_append);
        }
        if ((ovr.extra_tools?.length as number) > 0) {
            merged.tools = [...new Set([...(base.tools || []), ...ovr.extra_tools!])];
        }
        if (ovr.scope) {
            merged.scope = { ...(base.scope || {}), ...ovr.scope };
        }
        if (ovr.max_iterations) merged.max_iterations = ovr.max_iterations;

        return merged;
    }

    // K12 (2026-08-23, ogon K4): `saveActiveSession()` WYCIĘTA — nie miała ani jednego
    // wołacza. Czat zapisuje sesję wprost przez `memory.saveSession(...)`
    // (`modules/chat/chat/chat_session.ts`), więc ten przelot był martwym pośrednikiem.

    /**
     * Build enriched context for PromptBuilder.
     * Shared logic for both sync and async prompt methods.
     * @private
     * @param {Agent} [targetAgent] - Agent to build context for (defaults to activeAgent)
     * @returns {Object} Base enriched context (without async data like memory/projects)
     */
    _buildBaseContext(targetAgent?: Agent | null): PromptRuntimeContext {
        const agent = targetAgent || this.activeAgent;
        if (!agent) return {};

        // Skills metadata for the prompt index (D17): name/description/category + icon +
        // disableModelInvocation (manual-only skille lądują na osobnej liście) + path/slug
        // (model dostaje gotową ścieżkę SKILL.md do read() — pełny przepis przez narzędzie).
        const skills = this.skillLoader.getSkillsForAgent(agent.skills)
            .filter((s: RuntimeDependency) => s.enabled !== false)
            .map((s: RuntimeDependency) => ({
                name: s.name,
                slug: s.slug,
                description: s.description,
                category: s.category,
                icon: s.icon,
                disableModelInvocation: s.disableModelInvocation === true,
                path: s.path,
            }));

        // E2.9 A2: typy artefaktów podpięte do agenta (brak/puste → tylko `plan`). Dane gotowe
        // dla FAZY B (indeks typów w prompcie); FAZA A tylko je udostępnia w kontekście.
        const artifactTypes = this.getArtifactTypesForAgent(agent);

        // E2.9 FAZA B (B3): artefakty agenta W TOKU (status ≠ zamkniety) — do indeksu w prompcie.
        // Śledzenie po frontmatterze (metadataCache), synchronicznie; brak store'a/cache → pusto.
        let artifactList = [];
        try {
            const store = this.plugin?.artifactStore;
            if (store?.list) {
                artifactList = store.list({ agent: agent.name })
                    .filter((a: RuntimeDependency) => a.status !== 'zamkniety');
            }
        } catch { /* store niegotowy / brak cache → pusta lista */ }

        // Agent list for communicator (name + description for DT injection)
        // K11 (AUD-security-047): TEN SAM filtr duchów, którego używa poczta. Blok `komunikacja`
        // w prompcie jest bramkowany po `kom_send`/`agent_delegate`, a lista szła z `getAllAgents()`,
        // więc agent z `komunikator_visible:false` trafiał tam z nazwą I opisem do każdego agenta
        // z pocztą — mimo że `kom_send` do niego odbija się jak od literówki.
        const agentList = this.listKomunikatorAgents().map((a: Agent) => ({ name: a.name, description: a.description || '' }));

        // Sub-agent lists (unified — from _subAgents)
        const allSubAgentNames = agent.getAllSubAgentNames?.() || [];
        const subAgentList: Array<{ name: string; description: string; role: string }> = allSubAgentNames
            .map(name => {
                const config = this.subAgentLoader.getSubAgent(name);
                return config ? { name: config.name, description: config.description, role: config.role } : null;
            })
            .filter(Boolean) as Array<{ name: string; description: string; role: string }>;

        // Sub-agent lists by role
        const researcherList = subAgentList.filter(s => s.role !== 'strategist');
        const strategistList = subAgentList.filter(s => s.role === 'strategist');

        // Availability flags
        const hasResearcher = researcherList.length > 0;
        const hasStrategist = strategistList.length > 0;
        const defaultPrepName = agent.prepSubAgent?.name || agent.defaultSubAgent?.name || null;

        const pkm = this.settings?.pkmAssistant || {};

        // Disabled prompt sections from settings
        const disabledPromptSections = pkm.disabledPromptSections || [];

        // Global prompt overrides from settings (v2.1 — user-editable sections)
        const promptDefaults = pkm.promptDefaults || {};

        // E2.8 A3: rola rozpuszczona — brak roleData/roleBinding w kontekście promptu.

        // Delegate assignments with DT overrides / behavior_inject (sesja 46c)
        const delegateAssignments = (agent.activeSubAgents || [])
            .filter(s => (s.overrides?.dt_covered_groups?.length as number) > 0 || s.overrides?.behavior_inject)
            .map(s => ({ ...s, delegateType: s.role === 'strategist' ? 'strategist' : 'researcher' }));

        // Unified delegate list (E2.3 D21: tryby pracy usunięte — martwa zmienna workMode wycięta).
        const delegateList = agent.getActiveDelegates().map(d => {
            const config = this.subAgentLoader.getSubAgent(d.name);
            return { ...d, description: config?.description || '' };
        });
        const hasDelegates = delegateList.length > 0;

        // D14: nazwy narzędzi realnie dostępnych agentowi (filterByAgent = built-in wg whitelisty
        // mcp_servers + user serwery). Chudy rdzeń drzewa renderuje instrukcję per-tool TYLKO gdy
        // narzędzie tu jest — prompt przestaje kłamać o kom_*/narzędziach, których agent nie ma.
        // Undefined (brak registry, np. test/preview) → PromptBuilder nie filtruje (pełny podgląd).
        let availableToolNames;
        try {
            const tools = this.plugin?.toolRegistry?.filterByAgent?.(agent);
            if (Array.isArray(tools)) availableToolNames = tools.map(tl => tl.name);
        } catch { /* brak registry → undefined → brak filtrowania */ }

        return {
            app: this.plugin?.app,
            vaultName: this.vault?.getName?.() || 'Unknown Vault',
            currentDate: new Date().toLocaleDateString(getDateLocale()),
            // D14: furtka rozszerzonych reguł (dla słabszych modeli) — domyślnie OFF (chudo).
            extendedPromptRules: pkm.extendedPromptRules === true,
            skills,
            artifactTypes,
            artifactList,
            ...(availableToolNames && { availableToolNames }),
            agentList,
            researcherList,
            strategistList,
            delegateList,
            hasResearcher,
            hasStrategist,
            hasDelegates,
            defaultPrepName,
            promptDefaults,
            // E2.8 B1: named folder groups — PromptBuilder._buildEnvironment expands `{group}`
            // references in focus_folders to their concrete folders at build time.
            vaultGroups: pkm.vaultGroups || [],
            ...(disabledPromptSections.length > 0 && { disabledPromptSections }),
            ...(delegateAssignments.length > 0 && { delegateAssignments }),
        };
    }

    /**
     * Get system prompt with memory context for a GIVEN agent (default: the active one).
     *
     * K18 (AUD-security-112): czat podaje tu agenta-WŁAŚCICIELA tury. Budowa tego promptu
     * potrafi trwać sekundy (brain.md, sesja, mapa vaulta, ping skrzynki) — a przełączenie
     * zakładki w tym oknie przestawia `this.activeAgent`. Dopóki funkcja czytała wyłącznie
     * lustro, prompt zaczynał się u agenta A i kończył u B: persona jednego, pamięć drugiego.
     * Brak argumentu = dotychczasowe zachowanie (aktywny agent).
     *
     * @param {Object} [context] - Additional context
     * @param {Object|string} [agent] - agent (obiekt albo nazwa); brak = aktywny
     * @returns {Promise<string>}
     */
    async getActiveSystemPromptWithMemory(context: PromptRuntimeContext = {}, agent?: Agent | string | null) {
        const target = (typeof agent === 'string' ? this.getAgent(agent) : agent) || this.activeAgent;
        if (!target) {
            return 'You are a helpful AI assistant.';
        }

        const enrichedContext = this._buildBaseContext(target);

        // Memory context (unless disabled in settings OR agent has memory permission off)
        // K18: pamięć adresowana po NAZWIE właściciela (fail-closed), nie przez `getActiveMemory()`.
        const memory = this.getAgentMemory(target.name);
        const agentMemoryEnabled = target?.permissions?.memory !== false;
        const injectMemory = this.settings?.pkmAssistant?.injectMemoryToPrompt !== false && agentMemoryEnabled;
        if (memory && injectMemory) {
            try {
                enrichedContext.memoryContext = await memory.getMemoryContext();
            } catch (e) {
                log.warn('AgentManager', 'Could not load memory context:', e);
            }
        }

        // Vault map lives in AgentManager after S08 Z1 (kontekst projektowy OUT w S28 D1).
        try {
            if (target.focusFolders?.length > 0) {
                enrichedContext.vaultMapDescriptions = await this.getVaultMapDescriptions();
            }
        } catch (e) {
            log.warn('AgentManager', 'Agent prompt context failed:', e);
        }

        // S28 (D4): ping skrzynki — sama liczba nieprzeczytanych przez AI + nadawcy, bez treści.
        try {
            enrichedContext.inboxPing = await this.getInboxPing(target);
        } catch (e) {
            log.debug('AgentManager', 'Could not get inbox ping:', e);
        }

        // Merge caller-provided context (overrides allowed)
        Object.assign(enrichedContext, context);

        // E2.9 FAZA B (B3): AKTYWNY artefakt tej rozmowy (id per-tab z ChatView). Świeży chudy JSON
        // wstrzykiwany do promptu (PromptBuilder → buildActiveArtifactBlock). Brak id / błąd → pomiń.
        if (enrichedContext.activeArtifactId && this.plugin?.artifactStore) {
            try {
                enrichedContext.activeArtifact = await this.plugin.artifactStore.read(enrichedContext.activeArtifactId);
            } catch (e) {
                log.debug('AgentManager', 'Nie udało się wczytać aktywnego artefaktu:', e);
            }
        }

        return target.getSystemPrompt(enrichedContext);
    }

    /**
     * Get system prompt for active agent (sync — no memory/projects/inbox)
     * @param {Object} [context] - Additional context
     * @returns {string}
     */
    getActiveSystemPrompt(context: PromptRuntimeContext = {}) {
        if (!this.activeAgent) {
            return 'You are a helpful AI assistant.';
        }

        const enrichedContext = { ...this._buildBaseContext(), ...context };
        return this.activeAgent.getSystemPrompt(enrichedContext);
    }

    /**
     * Get prompt inspector data for ANY agent (not just active).
     * Used by Prompt Builder panel to preview any agent's prompt.
     * @param {string} agentName - Agent name
     * @param {Object} [context] - Additional context overrides
     * @returns {Promise<{sections: Array, breakdown: Object}>}
     */
    async getPromptInspectorDataForAgent(agentName?: string, context: PromptRuntimeContext = {}) {
        const agent = agentName ? this.getAgent(agentName) : this.activeAgent;
        if (!agent) {
            return { sections: [], breakdown: { total: 0, sections: [] } };
        }

        const enrichedContext = this._buildBaseContext(agent);

        // Include memory + projects for realistic token count
        const memEnabled = agent.permissions?.memory !== false;
        if (memEnabled) {
            try {
                // K18/AUD-code-review-028: pamięć adresowana po NAZWIE oglądanego agenta
                // (fail-closed), NIE `getActiveMemory()` — ten sam wzór co `turnOwner` i
                // `getActiveSystemPromptWithMemory` powyżej. Dawny `|| this.getActiveMemory()`
                // podstawiał pamięć AKTYWNEGO agenta, gdy `agentMemories` nie miało jeszcze
                // wpisu dla oglądanego (np. padnięta inicjalizacja pamięci w `initialize()` —
                // agent jest w `this.agents`, ale bez wpisu w `agentMemories`). Inspektor
                // promptu i guziki „Podgląd" / „Kopiuj" w `profile_prompt.ts` pokazywały wtedy
                // brain.md CUDZEGO agenta. Brak pamięci = brak sekcji pamięci w podglądzie.
                const memory = this.getAgentMemory(agent.name);
                if (memory) {
                    enrichedContext.memoryContext = await memory.getMemoryContext();
                }
            } catch { /* ok */ }
        }
        try {
            enrichedContext.inboxPing = await this.getInboxPing(agent);
        } catch { /* ok */ }

        Object.assign(enrichedContext, context);

        return agent.getPromptSections(enrichedContext);
    }

    /**
     * Create and save a new custom agent
     * @param {Object} config - Agent configuration
     * @returns {Promise<Agent>}
     */
    async createAgent(config: ConstructorParameters<typeof Agent>[0]) {
        // E2.8 C1: świeży agent dostaje CZYSTY default osi narzędziowej (vault+memory+core ON,
        // reszta grup OFF) — bez migracji zawężającej po dawnych uprawnieniach edit_notes itp.
        // Migracja (computeDisabledToolsFromLegacy) dotyczy tylko WCZYTYWANYCH starych YAML-i.
        if (!Array.isArray(config.disabled_tools)) {
            config = { ...config, disabled_tools: defaultDisabledTools() };
        }
        // E2.8 C7: świeży agent startuje w trybie „Pełen dostęp" (guidance_mode:true) — makieta.
        // Global DEFAULT_PERMISSIONS.guidance_mode zostaje false (zero regresji dla istniejących
        // agentów wczytywanych z YAML); nowość dotyczy tylko tworzonych tutaj.
        if (!config.default_permissions || config.default_permissions.guidance_mode === undefined) {
            config = { ...config, default_permissions: { ...(config.default_permissions || {}), guidance_mode: true } };
        }
        const agent = new Agent(config);

        // D18: brak ról systemowych — nowy agent dostaje własny custom prep sub-agent
        // (każdy asystent buduje własnych subów; do delegacji ad-hoc jest generyczny worker).
        if (agent._subAgents.length === 0) {
            try {
                const prepName = await this.subAgentLoader.createPrepSubAgent(agent.name);
                agent._subAgents.push({ name: prepName, role: 'researcher', default: true });
            } catch (e: unknown) {
                log.warn('AgentManager', 'Could not auto-create prep sub-agent:', (e as Error).message);
            }
        }

        // Save to file
        await this.loader.saveAgent(agent);

        // Add to manager
        this.agents.set(agent.name, agent);

        // Create memory folders for the new agent (sessions/, summaries/L1/, L2/, brain.md)
        const memory = await this._initializeMemoryForAgent(agent);
        this.agentMemories.set(agent.name, memory);

        // Create playbook.md + vault_map.md for the new agent
        await this.playbookManager.ensureStarterFiles([agent]);

        this._emit('agent:created', { agent: agent.name });

        return agent;
    }

    /**
     * K5 (AUD-code-review-024, CRITICAL): jedyny właściciel operacji zmiany nazwy agenta.
     * Deleguje kolizję/YAML/folder pamięci do `renameAgentOnDisk` (czysty, testowalny — patrz
     * `renameAgentFlow.ts`), a tutaj żyje TYLKO to, co potrzebuje żywego stanu klasy: przekluczowanie
     * `agents`/`agentMemories` i reinicjalizacja `AgentMemory` pod nowym kluczem
     * (folder na dysku już przeniesiony — świeża instancja po prostu wskazuje nowe ścieżki).
     *
     * @param {string} oldName - obecna nazwa agenta
     * @param {string} newName - żądana nowa nazwa
     * @returns {Promise<boolean>} `false` = ODMOWA (kolizja/built-in/pad) — Notice już pokazany,
     *   zero zmian na dysku i w mapach.
     */
    async renameAgent(oldName: string, newName: string): Promise<boolean> {
        const agent = this.agents.get(oldName);
        if (!agent) {
            log.error('AgentManager', `renameAgent: agent „${oldName}" nie istnieje.`);
            return false;
        }

        const trimmed = (newName || '').trim();
        if (trimmed === agent.name) return true; // no-op — nic się nie zmieniło

        const result = await renameAgentOnDisk(agent, newName, {
            vaultAdapter: this.vault.adapter,
            agentsPath: this.loader.agentsPath,
            hasAgentName: (n) => this.agents.has(n),
            saveAgent: (a) => this.loader.saveAgent(a as Agent),
            copyFolder: (src, dest) => this._copyFolderRecursive(src, dest),
        });

        if (!result.ok) {
            switch (result.reason) {
                case 'built_in':
                    log.warn('AgentManager', `renameAgent: „${oldName}" jest agentem wbudowanym — zmiana nazwy zablokowana.`);
                    break;
                case 'empty_name':
                    // AUD-dead-code-135 (INFO): dziś nieosiągalne przez jedynego wołacza
                    // (`updateAgent` odsiewa `requestedName` puste/samą-białą-spacją PRZED
                    // wywołaniem `renameAgent`, a `renameAgent` sam robi wcześniej `trimmed
                    // === agent.name` no-op). Gałąź zostaje — `reason` to część kontraktu
                    // `renameAgentOnDisk` (patrz `renameAgentFlow.test.ts`), więc pełny switch
                    // jest tańszy niż ryzyko cichej ciszy przy przyszłym drugim wołaczu.
                    new Notice(t('profile.advanced.name_required'));
                    break;
                case 'name_collision':
                    log.warn('AgentManager', `renameAgent: kolizja nazwy „${trimmed}" — odmowa (zero nadpisania cudzego pliku).`);
                    new Notice(t('profile.advanced.rename_name_taken', { name: trimmed }));
                    break;
                case 'collision_check_failed':
                    log.error('AgentManager', `renameAgent: sprawdzenie kolizji dla „${trimmed}" nie powiodło się (fail-closed) — rename przerwany.`);
                    new Notice(t('profile.advanced.rename_collision_check_failed', { name: trimmed }));
                    break;
                case 'memory_move_failed':
                    log.error('AgentManager', `renameAgent: przenosiny pamięci „${oldName}"→„${trimmed}" nie powiodły się — rename przerwany.`);
                    new Notice(t('profile.advanced.rename_memory_failed', { name: oldName }));
                    break;
                case 'save_failed':
                    log.error('AgentManager', `renameAgent: zapis nowego pliku dla „${trimmed}" nie powiódł się — rename przerwany.`);
                    new Notice(t('profile.advanced.rename_save_failed', { name: trimmed }));
                    break;
            }
            return false;
        }

        // Przekluczowanie map runtime'u — `agent` to ta sama instancja, `agent.name` już = nowa nazwa.
        this.agents.delete(oldName);
        this.agents.set(agent.name, agent);

        // Folder pamięci już przeniesiony na dysku — świeża instancja AgentMemory wskazuje
        // od razu nowe ścieżki (wzór `reload()`: zero ręcznego przepinania pól wewnętrznych).
        this.agentMemories.delete(oldName);
        try {
            const memory = await this._initializeMemoryForAgent(agent);
            this.agentMemories.set(agent.name, memory);
        } catch (e) {
            log.error('AgentManager', `renameAgent: reinicjalizacja pamięci dla „${agent.name}" nie powiodła się:`, e);
        }

        // F02 punkt 6a: skrzynka komunikatora jest BEST-EFFORT (patrz `renameAgentFlow.ts`) —
        // pad przenosin nie cofa udanego rename'u, tylko melduje się głośno w logu.
        if (result.inboxMoveFailed) {
            log.warn('AgentManager', `renameAgent: skrzynka komunikatora „${oldName}"→„${agent.name}" nie została w pełni przeniesiona — stara skrzynka może zostać osierocona pod dawnym slugiem.`);
        }

        log.info('AgentManager', `agent:renamed: ${oldName} → ${agent.name}`);
        this._emit('agent:renamed', { from: oldName, to: agent.name });
        return true;
    }

    /**
     * Update agent configuration and persist to file
     * @param {string} name - Agent name
     * @param {Object} updates - Fields to update
     * @returns {Promise<boolean>}
     */
    async updateAgent(name: string, updates: Parameters<Agent['update']>[0]) {
        const agent = this.agents.get(name);
        if (!agent) return false;

        // K5 (AUD-code-review-024): zmiana nazwy ma jednego właściciela (`renameAgent`) —
        // wydzielona z reszty pól, bo kolizja/pad przenosin musi przerwać CAŁY zapis (zero
        // połowicznego stanu), nie tylko pominąć pole `name`.
        const requestedName = typeof updates.name === 'string' ? updates.name.trim() : undefined;
        if (requestedName && requestedName !== agent.name) {
            const renamed = await this.renameAgent(agent.name, requestedName);
            if (!renamed) return false;
        }

        const { name: _renamedName, ...rest } = updates;
        agent.update(rest as Parameters<Agent['update']>[0]);

        // Persist changes (agent.name może już być NOWĄ nazwą po renameAgent powyżej —
        // saveAgent/saveBuiltInOverrides liczą ścieżkę z aktualnej wartości).
        if (agent.isBuiltIn) {
            await this.loader.saveBuiltInOverrides(agent);
        } else {
            await this.loader.saveAgent(agent);
        }

        this._emit('agent:updated', { agent: agent.name, updates });
        return true;
    }

    /**
     * Get statistics for an agent
     * @param {string} name - Agent name
     * @returns {Promise<Object|null>}
     */
    async getAgentStats(name: string) {
        const agent = this.agents.get(name);
        const memory = this.agentMemories.get(name);
        if (!agent) return null;

        // E2.8 C3: liczniki dla zakładki Przegląd (Memory v3: sesje w active/archive, notatki w brain/).
        let activeSessionCount = 0, archiveCount = 0, l1Count = 0, l2Count = 0;
        let brainSize = 0, brainNoteCount = 0;

        const countMd = async (dir: string) => {
            try {
                const listed = await this.vault.adapter.list(dir);
                return listed?.files?.filter((f: string) => f.endsWith('.md')).length || 0;
            } catch { return 0; }
        };

        if (memory) {
            activeSessionCount = await countMd(memory.paths.sessionsActive);
            archiveCount = await countMd(memory.paths.sessionsArchive);
            l1Count = await countMd(memory.paths.l1);
            l2Count = await countMd(memory.paths.l2);
            brainNoteCount = await countMd(memory.paths.brainNotes);
            try {
                const brain = await memory.getBrain();
                brainSize = brain?.length || 0;
            } catch { /* no brain yet */ }
        }

        return {
            // sessionCount = aktywne sesje (Memory v3: sessions/active). Nazwa zachowana dla zgodności.
            sessionCount: activeSessionCount,
            archiveCount,
            l1Count,
            l2Count,
            brainSize,
            brainNoteCount,
            lastActivity: agent.lastActivity || null,
            skillCount: agent.skills?.length || 0,
        };
    }

    /**
     * Archive agent memory before deletion
     * @param {string} name - Agent name
     * @returns {Promise<boolean>}
     */
    async archiveAgentMemory(name: string) {
        const memory = this.agentMemories.get(name);
        if (!memory) return false;

        const safeName = getAgentSafeName(name);
        const srcBase = `.pkm-assistant/agents/${safeName}`;
        const destBase = `.pkm-assistant/archive/${safeName}_${Date.now()}`;

        try {
            // Create archive directory
            await this.vault.adapter.mkdir(destBase);

            // Copy memory folder recursively
            const memoryPath = `${srcBase}/memory`;
            const exists = await this.vault.adapter.exists(memoryPath);
            if (exists) {
                await this._copyFolderRecursive(memoryPath, `${destBase}/memory`);
            }

            // Copy playbook and vault_map
            for (const file of ['playbook.md', 'vault_map.md']) {
                const filePath = `${srcBase}/${file}`;
                if (await this.vault.adapter.exists(filePath)) {
                    const content = await this.vault.adapter.read(filePath);
                    await this.vault.adapter.write(`${destBase}/${file}`, content);
                }
            }

            return true;
        } catch (error) {
            log.error('AgentManager', 'Archive error:', error);
            return false;
        }
    }

    /**
     * Recursively copy a folder via vault adapter
     * @private
     */
    async _copyFolderRecursive(src: string, dest: string) {
        await this.vault.adapter.mkdir(dest);

        const listed = await this.vault.adapter.list(src);
        if (!listed) return;

        // Copy files
        if (listed.files) {
            for (const filePath of listed.files) {
                const content = await this.vault.adapter.read(filePath);
                const relativePath = filePath.substring(src.length);
                await this.vault.adapter.write(`${dest}${relativePath}`, content);
            }
        }

        // Copy subfolders
        if (listed.folders) {
            for (const folderPath of listed.folders) {
                const relativePath = folderPath.substring(src.length);
                await this._copyFolderRecursive(folderPath, `${dest}${relativePath}`);
            }
        }
    }

    /**
     * Delete an agent. Built-in agents (Jaskier) are protected and cannot be deleted.
     * @param {string} name - Agent name
     * @returns {Promise<boolean>}
     */
    async deleteAgent(name: string) {
        const agent = this.agents.get(name);
        if (!agent) return false;
        // E2.8 A6 (S25): twardy guard — agent wbudowany (Jaskier) jest nieusuwalny (defense in depth).
        if (agent.isBuiltIn) {
            log.warn('AgentManager', `deleteAgent odmówiony: „${name}" jest agentem wbudowanym (nieusuwalny).`);
            return false;
        }

        // Delete file (custom YAML) — built-in agents are already rejected above, so no
        // agent reaching here can have an overrides file to clean up.
        if (agent.filePath) {
            await this.loader.deleteAgent(agent);
        }

        this.agents.delete(name);
        this.agentMemories.delete(name);

        // If deleted agent was active, switch to another or recreate Jaskier
        if (this.activeAgent?.name === name) {
            if (this.agents.size > 0) {
                const firstAgent = this.agents.values().next().value;
                this.switchAgent(firstAgent.name);
            } else {
                // No agents left - recreate Jaskier as fallback
                await this._recreateJaskierFallback();
            }
        }

        this._emit('agent:deleted', { agent: name });
        return true;
    }

    /**
     * Recreate Jaskier when all agents have been deleted
     * @private
     */
    async _recreateJaskierFallback() {
        const jaskier = createJaskier();

        this.agents.set(jaskier.name, jaskier);

        const memory = await this._initializeMemoryForAgent(jaskier);
        this.agentMemories.set(jaskier.name, memory);

        await this.playbookManager.ensureStarterFiles([jaskier]);

        this.activeAgent = jaskier;
        this._emit('agent:created', { agent: jaskier.name });
    }

    /**
     * Reload all agents from files
     * @returns {Promise<void>}
     */
    async reload() {
        const activeAgentName = this.activeAgent?.name;

        // Clear and reload
        this.agents.clear();
        await this.initialize();

        // Try to restore active agent
        if (activeAgentName && this.agents.has(activeAgentName)) {
            this.activeAgent = this.agents.get(activeAgentName) as Agent;
        }

        this._emit('agents:reloaded', { count: this.agents.size });
    }

    async readVaultMap() {
        return this.vaultMap.readVaultMap();
    }

    async getVaultMapDescriptions() {
        return this.vaultMap.getVaultMapDescriptions();
    }

    async writeVaultMap(content: string) {
        return this.vaultMap.writeVaultMap(content);
    }

    // S28 (D1): `buildPromptContext` / `buildSubAgentContext` skasowane razem z Project Hubem —
    // wstrzykiwały do promptu listę projektów i zadań z Komunikatora v2. VaultMap NIETKNIĘTY.

    /**
     * Subscribe to events
     * @param {Function} callback - Event handler (event, data) => void
     * @returns {Function} Unsubscribe function
     */
    on(callback: (event: string, data: RuntimeDependency) => void) {
        this.listeners.push(callback);
        return () => {
            const index = this.listeners.indexOf(callback);
            if (index > -1) this.listeners.splice(index, 1);
        };
    }

    /**
     * Emit event to all listeners
     * @private
     */
    _emit(event: string, data: RuntimeDependency) {
        for (const listener of this.listeners) {
            try {
                listener(event, data);
            } catch (error) {
                log.error('AgentManager', 'Listener error:', error);
            }
        }
    }

    /**
     * Get agent display info for UI
     * @returns {Array<{name, color, description, role, isBuiltIn}>}
     */
    getAgentListForUI() {
        return this.getAllAgents().map(agent => agent.getDisplayInfo());
    }
}
