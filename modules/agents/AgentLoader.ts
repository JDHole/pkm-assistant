/**
 * AgentLoader
 * Loads and validates agent definitions from YAML files
 */
import { Agent } from './Agent.js';
import type { AgentConfig, AgentSubAgentAssignment } from './Agent.js';
import { migrateAccessPolicy } from './accessPolicy.js';
import { log } from '../../core/utils/Logger.js';
import { parseYaml, stringifyYaml, validateAgentSchema, getAgentSafeName } from '../../core/index.js';
import { createJaskier } from './archetypes/index.js';

interface AgentVaultAdapter {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files?: string[] } | null>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    remove(path: string): Promise<void>;
}

interface AgentVault {
    adapter: AgentVaultAdapter;
    on?(event: string, callback: (file: string | { path?: string }) => void): unknown;
    offref?(ref: unknown): void;
}

interface LegacyAgentConfig extends AgentConfig {
    type?: unknown;
    minion?: unknown;
    minions?: unknown;
    minion_enabled?: unknown;
    master?: unknown;
    masters?: unknown;
    master_enabled?: unknown;
    delegates_per_mode?: unknown;
}

interface AgentMigration {
    changed: boolean;
    messages: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep, order-independent-for-objects / order-sensitive-for-arrays equality over the
 * JSON-safe shapes that `Agent.serialize()` produces (strings, numbers, booleans,
 * arrays, plain objects — no cycles, no Dates/Maps/Sets).
 */
function deepEqualAgentValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => deepEqualAgentValue(v, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        return keysA.every(key => key in b && deepEqualAgentValue(a[key], b[key]));
    }
    return false;
}

/**
 * C1 (risk register 2026-09-02 / S34 z8): keep only the fields of `current` whose value
 * differs (deeply) from the same key in `baseline`. Used so a built-in agent's overrides
 * file carries a DIFF against the factory config, not a full re-serialization — otherwise
 * every save leaks the entire built-in config (emoji, color, personality, disabled_tools…)
 * into the overrides file, even fields the user never touched. A field present in `current`
 * but absent from `baseline` is always kept (its baseline value is `undefined`, which never
 * deep-equals a real value).
 */
function diffAgentConfig(current: Record<string, unknown>, baseline: Record<string, unknown>): Record<string, unknown> {
    const diff: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
        if (!deepEqualAgentValue(value, baseline[key])) {
            diff[key] = value;
        }
    }
    return diff;
}

/**
 * A1 (klaster C4b nit na C1): meta-pola, które MUSZĄ zawsze trafić do diff-only pliku nadpisań,
 * nawet gdy ich wartość jest identyczna z baseline. `access_policy_version` to jedyne pole, które
 * `_mergeBuiltInOverrides` sprawdza PRZED zastosowaniem reszty diffu (`migrateAccessPolicy`
 * short-circuituje na `accessVersion >= ACCESS_POLICY_VERSION`) — `diffAgentConfig` naturalnie
 * je wycina, bo baseline (`createJaskier().serialize()`) ma DOKŁADNIE tę samą, BIEŻĄCĄ wartość
 * (`ACCESS_POLICY_VERSION`, pisaną bezwarunkowo przez `Agent.serialize()`). Bez tego wyjątku
 * KAŻDY zapis produkuje plik bez `access_policy_version` → następny load widzi `accessVersion
 * 0 < 2` → migracja odpala się na nowo (dopisuje `default_permissions` które migracja syntetyzuje,
 * gdy `focus_folders` jest puste) → zapisuje plik → loguje „Migrated built-in override" → PO
 * KAŻDYM zapisie profilu, w nieskończoność. Samo `access_policy_version` wystarcza: dopóki jest
 * obecne i aktualne, `migrateAccessPolicy` wraca natychmiast i nic więcej (w tym
 * `default_permissions`) nie jest dotykane — dopisywanie `default_permissions` do tej listy
 * byłoby rozwiązywaniem objawu, nie przyczyny.
 */
const ALWAYS_WRITTEN_META_FIELDS = ['access_policy_version'] as const;

/**
 * A2 (klaster C4b nit na C1): rejestr fabryk baseline per built-in, kluczowany `agent.name`.
 * `saveBuiltInOverrides` hardcodowało `createJaskier()` jako baseline dla KAŻDEGO
 * `agent.isBuiltIn`, co jest bezpieczne tylko dopóki Jaskier jest jedynym built-inem
 * (`loadBuiltInAgents` dziś zwraca wyłącznie `[jaskier]`). Gdyby ktoś dodał drugi built-in
 * bez dopisania go tutaj, diff liczyłby się względem CUDZEGO baseline'u — pole wyciekałoby
 * (baseline go nie ma) albo znikało (baseline ma inną wartość, przypadkiem równą). Dopisz
 * nowego built-ina razem z jego fabryką configu.
 */
const BUILT_IN_BASELINES: Record<string, () => Agent> = {
    Jaskier: createJaskier,
};

// F2.22 (release 2.2.0/W3): `saveBuiltInOverrides` woła `log.warn` w gałęzi A2 (built-in bez
// zarejestrowanego baseline) — do tej naprawy krzyczało przy KAŻDYM zapisie profilu tego
// agenta, w nieskończoność. Ostrzeżenie ma realną wartość raz („dopisz go do
// BUILT_IN_BASELINES") — powtarzanie go co zapis to szum, nie sygnał. Zbiór nazw modułowy
// (nie per-instancja `AgentLoader`), bo cel to zero powtórki w LOGU, niezależnie od tego, ile
// razy loader jest tworzony na nowo w trakcie życia pluginu.
const _warnedMissingBaseline = new Set<string>();

// `watchAgents` niżej wstaje w gołym Node bez mocka obsidiana (importowany wprost przez testy
// AVA), gdzie `window` nie istnieje. Te dwie stałe trzymają REFERENCJĘ do funkcji (nie wywołanie)
// — `window.setTimeout` w prawdziwym Obsidianie (Electron — popout window compatibility), goły
// global jako fallback w Node. `obsidianmd/prefer-window-timers` łapie tylko WYWOŁANIE gołego
// identyfikatora (`setTimeout(...)`), nie referencję do niego jako wartości — więc call site
// niżej (`timerSet(...)`) nie jest już bare-globalem w oczach reguły.
const timerSet: typeof setTimeout = typeof window !== 'undefined' ? window.setTimeout.bind(window) : setTimeout;
const timerClear: typeof clearTimeout = typeof window !== 'undefined' ? window.clearTimeout.bind(window) : clearTimeout;

/**
 * AgentLoader class - handles loading agents from files and built-in definitions
 */
export class AgentLoader {
    declare vault: AgentVault;
    declare agentsPath: string;
    declare _watchDebounce: ReturnType<typeof setTimeout> | null;
    /**
     * @param {Object} vault - Obsidian Vault object
     */
    constructor(vault: AgentVault) {
        this.vault = vault;
        this.agentsPath = '.pkm-assistant/agents';
        this._watchDebounce = null;
    }

    /**
     * Load all built-in agents (only Jaskier on fresh install)
     * @returns {Promise<Agent[]>} Array of built-in agents
     */
    async loadBuiltInAgents() {
        const jaskier = createJaskier();

        // Load overrides from YAML if they exist
        await this._mergeBuiltInOverrides(jaskier);

        return [jaskier];
    }

    /**
     * Load custom agents from .pkm-assistant/agents/*.yaml
     * @returns {Promise<Agent[]>} Array of custom agents
     */
    async loadCustomAgents() {
        const agents: Agent[] = [];

        try {
            // Check if agents folder exists
            const exists = await this.vault.adapter.exists(this.agentsPath);
            if (!exists) {
                await this.vault.adapter.mkdir(this.agentsPath);
                return agents;
            }

            // List all files in agents folder
            const listed = await this.vault.adapter.list(this.agentsPath);
            if (!listed || !listed.files) {
                return agents;
            }

            // Load each YAML file (skip _overrides files — those are for built-in agents)
            for (const filePath of listed.files) {
                const fileName = filePath.split('/').pop() || '';
                if (fileName.includes('_overrides')) continue;
                if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
                    try {
                        const agent = await this.loadAgentFromFile(filePath);
                        if (agent) {
                            agents.push(agent);
                        }
                    } catch (error) {
                        log.error('AgentLoader', 'Error loading agent from', filePath, error);
                    }
                }
            }
        } catch (error) {
            log.error('AgentLoader', 'Error loading custom agents:', error);
        }

        return agents;
    }

    /**
     * Load a single agent from a YAML file
     * @param {string} filePath - Path to YAML file
     * @returns {Promise<Agent|null>} Agent instance or null on error
     */
    async loadAgentFromFile(filePath: string): Promise<Agent | null> {
        try {
            const content = await this.vault.adapter.read(filePath);
            const data = parseYaml(content) as LegacyAgentConfig;

            if (!data) {
                log.error('AgentLoader', 'Failed to parse YAML:', filePath);
                return null;
            }

            const migration = this._migrateLegacyAgentFormat(data);

            // Validate schema
            const validation = validateAgentSchema(data);
            if (!validation.valid) {
                log.error('AgentLoader', 'Invalid agent schema:', filePath, validation.errors);
                return null;
            }

            // E2.8 A1: migracja archetypów usunięta (byt skasowany). Stare pola `archetype`/`role`
            // w YAML są po prostu ignorowane przez konstruktor Agenta — bez breakage.

            // Add file path reference
            data.filePath = filePath;
            data.isBuiltIn = false;

            if (migration.changed) {
                await this.vault.adapter.write(filePath, stringifyYaml(data));
                log.warn('AgentLoader', `Auto-migrated legacy agent "${data.name}" (${migration.messages.join(', ')})`);
            }

            const agent = new Agent(data);

            // E2.8 C1: migracja osi narzędziowej. Gdy YAML nie miał `disabled_tools` (miał stare
            // mcp_servers/enabled_tools/permissions), konstruktor wyliczył disabled_tools. Zapisz
            // agenta RAZ w formie kanonicznej (disabled_tools + porzucone martwe osie). Kolejny load
            // widzi już `disabled_tools` (tablicę) → `_toolAxisMigrated=false` → brak ponownego zapisu.
            if (agent._toolAxisMigrated) {
                try {
                    await this.vault.adapter.write(filePath, stringifyYaml(agent.serialize()));
                    log.warn('AgentLoader', `Migracja osi narzędziowej (C1) dla "${agent.name}" → disabled_tools`);
                // TS-any: vault adapter errors are legacy untyped values and this path only reports their message.
                } catch (e: any) {
                    log.warn('AgentLoader', `Zapis po migracji osi narzędziowej nie powiódł się dla "${agent.name}": ${e.message}`);
                }
            }

            return agent;
        } catch (error) {
            log.error('AgentLoader', 'Error reading agent file:', filePath, error);
            return null;
        }
    }

    /**
     * Load all agents (built-in + custom)
     * @returns {Promise<Agent[]>} All agents
     */
    async loadAllAgents() {
        const builtIn = await this.loadBuiltInAgents();
        const custom = await this.loadCustomAgents();

        // Filter out custom agents that have the same name as built-in ones
        const builtInNames = new Set(builtIn.map(a => a.name));
        const filteredCustom = custom.filter(a => !builtInNames.has(a.name));

        return [...builtIn, ...filteredCustom];
    }

    /**
     * Save agent definition to YAML file
     *
     * K3 (AUD-security-024): agent WBUDOWANY (Jaskier) nie ma pliku `<nazwa>.yaml` — `loadAllAgents`
     * odfiltrowuje custom agenta o nazwie built-ina, więc taki zapis znikał po restarcie i user
     * tracił ograniczenie, które właśnie ustawił, bez jednego słowa ostrzeżenia. Built-in ma
     * własny plik nadpisań (`<nazwa>_overrides.yaml`) i tam ląduje — niezależnie od tego, kto woła.
     *
     * @param {Agent} agent - Agent to save
     * @param {string} [filename] - Optional filename (defaults to agent name)
     * @returns {Promise<string>} Path to saved file
     */
    async saveAgent(agent: Agent, filename: string | null = null) {
        if (agent?.isBuiltIn) {
            log.debug('AgentLoader', `saveAgent dla built-ina "${agent.name}" → plik nadpisań`);
            return this.saveBuiltInOverrides(agent);
        }

        const safeName = getAgentSafeName(filename || agent.name);
        const filePath = `${this.agentsPath}/${safeName}.yaml`;

        const data = agent.serialize();
        const content = stringifyYaml(data);

        await this.vault.adapter.write(filePath, content);

        return filePath;
    }

    /**
     * Delete agent definition file
     * @param {Agent} agent - Agent to delete (must have filePath)
     * @returns {Promise<boolean>} Success status
     */
    async deleteAgent(agent: Agent) {
        if (!agent.filePath) return false;

        try {
            await this.vault.adapter.remove(agent.filePath);
            return true;
        } catch (error) {
            log.error('AgentLoader', 'Error deleting agent:', error);
            return false;
        }
    }

    /**
     * Merge built-in agent with override YAML (for persisting user edits)
     * @private
     * @param {Agent} agent - Built-in agent to merge overrides into
     */
    async _mergeBuiltInOverrides(agent: Agent) {
        const safeName = getAgentSafeName(agent.name);
        const overridePath = `${this.agentsPath}/${safeName}_overrides.yaml`;

        try {
            const exists = await this.vault.adapter.exists(overridePath);
            if (!exists) return;

            const content = await this.vault.adapter.read(overridePath);
            const data = parseYaml(content) as LegacyAgentConfig;
            if (!data) return;
            const migration = this._migrateLegacyAgentFormat(data);
            if (migration.changed) {
                await this.vault.adapter.write(overridePath, stringifyYaml(data));
                log.info('AgentLoader', `Migrated built-in override "${agent.name}" (${migration.messages.join(', ')})`);
            }
            if (data.default_permissions) {
                data.default_permissions = { ...agent.permissions, ...data.default_permissions };
            }
            agent.update(data);
        // TS-any: vault adapter errors are legacy untyped values and this path only reports their message.
        } catch (e: any) {
            // File not found is expected (no overrides) — only log unexpected errors
            if (e?.message && !e.message.includes('ENOENT') && !e.message.includes('not found')) {
                log.warn('AgentLoader', `Override read error for ${agent.name}:`, e.message);
            }
        }
    }

    /**
     * Save built-in agent overrides to YAML
     * @param {Agent} agent - Built-in agent with modified settings
     * @returns {Promise<string>} Path to override file
     */
    async saveBuiltInOverrides(agent: Agent) {

        const safeName = getAgentSafeName(agent.name);
        const filePath = `${this.agentsPath}/${safeName}_overrides.yaml`;

        const data = agent.serialize();
        delete data.name; // Name stays hardcoded

        const baselineFactory = BUILT_IN_BASELINES[agent.name];

        let diff: Record<string, unknown>;
        if (baselineFactory) {
            // C1 (risk register 2026-09-02 / S34 z8): write only the DIFF against the built-in
            // factory config, not the full serialize(). `_mergeBuiltInOverrides` merges this
            // file over a FRESH built-in instance (`agent.update(data)`), so a diff-only file
            // is compatible with the read side without any change there — omitted fields
            // simply keep their factory value.
            const baseline = baselineFactory().serialize();
            delete baseline.name;
            diff = diffAgentConfig(data, baseline);

            // A1 (klaster C4b nit na C1): meta-pola, które `_mergeBuiltInOverrides` czyta PRZED
            // zastosowaniem reszty diffu, muszą przetrwać nawet gdy diff je wycina jako
            // „identyczne z baseline" — patrz komentarz przy `ALWAYS_WRITTEN_META_FIELDS`.
            for (const field of ALWAYS_WRITTEN_META_FIELDS) {
                if (field in data) diff[field] = data[field];
            }
        } else {
            // A2 (klaster C4b nit na C1): agent.isBuiltIn, ale bez zarejestrowanego baseline —
            // diffowanie względem configu Jaskra byłoby diffem względem CUDZEGO built-ina
            // (wyciek albo zniknięcie pól po przypadkowej zbieżności wartości). Fallback na
            // zachowanie sprzed C1 (pełny serialize) zamiast zgadywać.
            if (!_warnedMissingBaseline.has(agent.name)) {
                _warnedMissingBaseline.add(agent.name);
                log.warn('AgentLoader', `saveBuiltInOverrides: brak zarejestrowanego baseline dla built-ina "${agent.name}" — zapisuję pełny serialize() zamiast diffu (dopisz go do BUILT_IN_BASELINES).`);
            }
            diff = data;
        }

        const content = stringifyYaml(diff);
        await this.vault.adapter.write(filePath, content);

        return filePath;
    }

    _migrateLegacyAgentFormat(data: LegacyAgentConfig): AgentMigration {
        const migration: AgentMigration = { changed: false, messages: [] };

        // A2 (2026-07-24): wcześniej brak/puste focus_folders oznaczały pełny vault.
        // Nowy kontrakt oznacza zero dostępu w trybie "Tylko przypisane". Jednorazowo
        // zachowujemy realne zachowanie starych profili przez guidance_mode=true i
        // znacznik wersji. Nowy YAML (także tworzony skillem Niki) niesie wersję 2.
        const accessMigration = migrateAccessPolicy(data);
        if (accessMigration.changed) {
            migration.changed = true;
            migration.messages.push(...accessMigration.messages);
        }

        // E2.8 A1: legacy `type: minion/master` — pole martwe po kasacji archetypu. Zostaje tylko
        // sprzątnięcie pola; migracja starych minion/master → sub_agents leci niżej.
        if (data.type === 'minion' || data.type === 'master') {
            migration.messages.push(`type:${data.type}(legacy, removed)`);
            delete data.type;
            migration.changed = true;
        }

        if (!Array.isArray(data.sub_agents)) {
            const migrated: AgentSubAgentAssignment[] = [];
            const pushLegacy = (value: unknown, role: string) => {
                if (typeof value === 'string' && value.trim()) migrated.push({ name: value.trim(), role, default: true });
                if (Array.isArray(value)) {
                    for (const item of value) {
                        if (typeof item === 'string') migrated.push({ name: item, role });
                        else if (item?.name) migrated.push({ ...item, role: role === 'strategist' ? 'strategist' : (item.role || role) });
                    }
                }
            };
            pushLegacy(data.minion, 'researcher');
            pushLegacy(data.minions, 'researcher');
            pushLegacy(data.master, 'strategist');
            pushLegacy(data.masters, 'strategist');
            if (migrated.length > 0) {
                data.sub_agents = migrated;
                migration.changed = true;
                migration.messages.push(`minion/master->sub_agents:${migrated.length}`);
            }
        }

        for (const key of ['minion', 'minions', 'minion_enabled', 'master', 'masters', 'master_enabled', 'delegates_per_mode']) {
            if (data[key] !== undefined) {
                delete data[key];
                migration.changed = true;
            }
        }

        return migration;
    }

    /**
     * Watch for changes in agents folder (for hot-reload)
     * @param {Function} callback - Called when agents change
     * @returns {Function} Unsubscribe function
     */
    watchAgents(callback: (change: { path: string }) => void) {
        if (!this.vault?.on || typeof callback !== 'function') return () => { };
        const schedule = (file: string | { path?: string }) => {
            const path = typeof file === 'string' ? file : file?.path;
            if (!path || !path.startsWith(`${this.agentsPath}/`)) return;
            if (!path.endsWith('.yaml') && !path.endsWith('.yml')) return;
            if (this._watchDebounce) timerClear(this._watchDebounce);
            this._watchDebounce = timerSet(() => callback({ path }), 300);
        };
        const refs = [
            this.vault.on('modify', schedule),
            this.vault.on('create', schedule),
            this.vault.on('delete', schedule),
        ].filter(Boolean);
        return () => {
            if (this._watchDebounce) timerClear(this._watchDebounce);
            for (const ref of refs) this.vault.offref?.(ref);
        };
    }
}
