/**
 * SubAgentLoader
 * Loads, validates, and caches sub-agent configurations from .pkm-assistant/sub-agents/
 * Each sub-agent is a folder with SUB_AGENT.yaml + optional KNOWLEDGE.md.
 * Replaces MinionLoader + MasterLoader (unified).
 */
import { parseYaml, stringifyYaml, slugify } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import type { ScopeData, SubAgentData, SubAgentInput, SubAgentYaml, VaultLike } from './types.js';
// TS-any: YAML parser input is a dynamic, backward-compatible user file format.
type YamlData = Record<string, any>;

const SUB_AGENTS_PATH = '.pkm-assistant/sub-agents';
// JEDNO źródło prawdy jest `config/limits.ts` (DEFAULT_LIMITS) — ta stała
// go tylko odzwierciedla pod historyczną nazwą. `export` nie jest potrzebny:
// zero importerów spoza pliku, jedyne użycie jest lokalne (patrz niżej).
const DEFAULT_RESEARCHER_MAX_TOOL_RESULT_LENGTH = DEFAULT_LIMITS.max_tool_result_length;
// JEDEN generyczny worker — brak podziału research/strateg. Wszystkie suby dostają
// ten sam domyślny zestaw narzędzi (rola w YAML to już tylko etykieta opisowa, nie steruje).
// Przecięcie z uprawnieniami rodzica robi SubAgentRunner._getTools (parent∩sub).
export const DEFAULT_SUB_AGENT_TOOLS = ['search', 'list', 'read', 'web_search', 'web_read'];
/**
 * Nazwa FABRYCZNEGO generycznego workera (`delegate` bez `aspect`).
 * Byt syntetyczny — nie istnieje na dysku, więc jest niezniszczalny bez żadnego mechanizmu
 * ochrony. Zaplecze → Suby pokazuje go jako pierwszą, read-only kartę („wbudowany").
 */
export const PKM_SUB_NAME = 'pkm-sub';
export const DEPRECATED_TOOL_RENAMES = {
    // 10 narzędzi retrieval → jedno `search` (whitelist sub-agenta rozpoznaje
    // starą nazwę już przy budowie — bez tego sub z vault_grep dostałby pustą whitelistę).
    'vault_search': 'search',
    'vault_grep': 'search',
    'vault_semantic': 'search',
    'vault_glob': 'search',
    'vault_filter_yaml': 'search',
    'vault_links': 'search',
    'memory_grep': 'search',
    'memory_semantic': 'search',
    'memory_filter_yaml': 'search',
    'memory_links': 'search',
    // Prymitywy plikowe bez prefixów. Mapujemy PROSTO na finalną nazwę (single-pass,
    // bez łańcuchów) — dlatego dawne memory_sessions/summaries celują od razu w list/read.
    'vault_read': 'read',
    'vault_list': 'list',
    'vault_write': 'write',
    'vault_delete': 'delete',
    'vault_create_folder': 'create_folder',
    'memory_read': 'read',
    'memory_read_summary': 'read',
    'memory_list_summaries': 'list',
    'memory_sessions': 'list',
    'memory_summaries': 'read',
};

export function migrateDeprecatedTools(yamlData: YamlData = {}): { changed: boolean; renamed: number; deduped: number; mappings: Array<{ from: string; to: string; count: number }> } {
    const result: { changed: boolean; renamed: number; deduped: number; mappings: Array<{ from: string; to: string; count: number }> } = { changed: false, renamed: 0, deduped: 0, mappings: [] };
    if (!Array.isArray(yamlData.tools)) return result;

    const seen = new Set();
    const mappingCounts = new Map();
    const nextTools = [];

    for (const tool of yamlData.tools) {
        const nextTool = DEPRECATED_TOOL_RENAMES[tool as keyof typeof DEPRECATED_TOOL_RENAMES] || tool;
        if (nextTool !== tool) {
            result.changed = true;
            result.renamed++;
            const key = `${tool}\u0000${nextTool}`;
            mappingCounts.set(key, (mappingCounts.get(key) || 0) + 1);
        }

        if (seen.has(nextTool)) {
            result.changed = true;
            result.deduped++;
            continue;
        }
        seen.add(nextTool);
        nextTools.push(nextTool);
    }

    if (result.changed) yamlData.tools = nextTools;
    result.mappings = Array.from(mappingCounts.entries()).map(([key, count]) => {
        const [from, to] = key.split('\u0000');
        return { from, to, count };
    });
    return result;
}

function normalizeScope(scope: unknown): ScopeData | null {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
        return null;
    }
    const normalizeArray = (value: unknown): string[] => Array.isArray(value)
        ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
        : [];
    return {
        folders: normalizeArray((scope as Record<string, unknown>).folders),
        frontmatter: ((scope as Record<string, unknown>).frontmatter
            && typeof (scope as Record<string, unknown>).frontmatter === 'object'
            && !Array.isArray((scope as Record<string, unknown>).frontmatter))
            ? { ...(scope as Record<string, unknown>).frontmatter as Record<string, unknown> }
            : {},
        sections: normalizeArray((scope as Record<string, unknown>).sections),
        pinned_notes: normalizeArray((scope as Record<string, unknown>).pinned_notes),
    };
}

// Jednolite defaulty dla WSZYSTKICH subów (rola = etykieta, nie steruje).
function defaultSubAgentTools() {
    return [...DEFAULT_SUB_AGENT_TOOLS];
}

function defaultMaxIterations() {
    return DEFAULT_LIMITS.subagent_max_iterations_worker;
}

function defaultMinIterations() {
    return 1;
}

function defaultMaxToolResultLength() {
    return DEFAULT_RESEARCHER_MAX_TOOL_RESULT_LENGTH;
}

function normalizeAgentPrefix(agent: string | { name?: string } | null | undefined) {
    const raw = typeof agent === 'string' ? agent : agent?.name;
    return slugify(raw || '').toLowerCase();
}

/**
 * Visible sub-agents for one active agent (brak ról systemowych).
 * Zwraca WYŁĄCZNIE custom suby usera zaczynające się od slugu agenta, np. jaskier-prep.
 * Legacy standalone (bez prefiksu, np. "prep") jest celowo ukryty.
 *
 * @param {Object|string} activeAgent
 * @param {Object[]} allSubAgents
 * @returns {Object[]}
 */
export function getVisibleSubAgentsForAgent(activeAgent: string | { name?: string } | null | undefined, allSubAgents: SubAgentData[] = []): SubAgentData[] {
    const agentPrefix = normalizeAgentPrefix(activeAgent);
    if (!agentPrefix) return [];
    const seen = new Set();
    const visible = [];
    for (const sa of allSubAgents) {
        const name = String(sa?.name || '');
        if (!name || seen.has(name)) continue;
        if (name.toLowerCase().startsWith(`${agentPrefix}-`)) {
            seen.add(name);
            visible.push({ ...sa });
        }
    }
    return visible;
}

export class SubAgentLoader {
    declare vault: VaultLike;
    declare cache: Map<string, SubAgentData>;
    /**
     * @param {Object} vault - Obsidian Vault object
     */
    constructor(vault: VaultLike) {
        this.vault = vault;
        /** @type {Map<string, Object>} sub-agent name -> config */
        this.cache = new Map();
    }

    /**
     * Load all sub-agents from .pkm-assistant/sub-agents/ (custom suby usera).
     * Brak ról systemowych — plugin nie wnosi żadnych wbudowanych subów.
     * @returns {Promise<void>}
     */
    async loadAllSubAgents() {
        this.cache.clear();

        try {
            const newPathExists = await this.vault.adapter.exists(SUB_AGENTS_PATH);

            if (newPathExists) {
                await this._loadFromPath(SUB_AGENTS_PATH, 'SUB_AGENT.yaml');
            }

            log.debug('SubAgentLoader', `Loaded ${this.cache.size} sub-agents`);
        } catch (e) {
            log.error('SubAgentLoader', 'Error loading sub-agents:', e);
        }
    }

    /**
     * Load sub-agents from new format path (SUB_AGENT.yaml + KNOWLEDGE.md)
     */
    async _loadFromPath(basePath: string, configFileName: string): Promise<void> {
        const listed = await this.vault.adapter.list(basePath);
        if (!listed?.folders) return;

        for (const folderPath of listed.folders) {
            try {
                const config = await this._loadSubAgentFromFolder(folderPath, configFileName);
                if (config && config.enabled !== false) {
                    this.cache.set(config.name, config);
                }
            } catch (e) {
                log.warn('SubAgentLoader', 'Error loading sub-agent from', folderPath, e);
            }
        }
    }

    /**
     * Load a sub-agent from new format folder (SUB_AGENT.yaml + KNOWLEDGE.md)
     */
    async _loadSubAgentFromFolder(folderPath: string, configFileName: string): Promise<SubAgentData | null> {
        const yamlPath = `${folderPath}/${configFileName}`;
        const knowledgePath = `${folderPath}/KNOWLEDGE.md`;

        const yamlExists = await this.vault.adapter.exists(yamlPath);
        if (!yamlExists) return null;

        const raw = await this.vault.adapter.read(yamlPath);
        if (!raw?.trim()) return null;

        const config = parseYaml(raw) as YamlData;
        if (!config?.name || !config?.description) {
            log.warn('SubAgentLoader', 'Sub-agent missing name or description:', yamlPath);
            return null;
        }

        const toolMigration = migrateDeprecatedTools(config);
        if (toolMigration.changed) {
            await this._saveMigratedSubAgentYaml(yamlPath, config, toolMigration);
        }

        // Read KNOWLEDGE.md if exists
        let knowledge = '';
        try {
            if (await this.vault.adapter.exists(knowledgePath)) {
                knowledge = await this.vault.adapter.read(knowledgePath);
            }
        } catch { /* no knowledge file — that's ok */ }

        return {
            name: config.name,
            // Rola to opisowa etykieta z YAML (może być pusta) — nie steruje zachowaniem.
            description: config.description,
            role: config.role || null,
            model: config.model || null,
            tools: config.tools || defaultSubAgentTools(),
            scope: normalizeScope(config.scope),
            scope_type: config.scope_type || 'custom',
            max_iterations: config.max_iterations || defaultMaxIterations(),
            min_iterations: config.min_iterations || defaultMinIterations(),
            max_tool_result_length: config.max_tool_result_length ?? defaultMaxToolResultLength(),
            enabled: config.enabled !== false,
            prompt: (knowledge || '').trim(),
            // Ślad pochodzenia kopii („z szablonu: X vN"); brak = sub zrobiony od zera.
            from_template: typeof config.from_template === 'string' ? config.from_template : null,
            path: yamlPath,
            format: 'sub_agent',
        };
    }

    async _saveMigratedSubAgentYaml(yamlPath: string, config: YamlData, migration: ReturnType<typeof migrateDeprecatedTools>): Promise<void> {
        await this.vault.adapter.write(yamlPath, stringifyYaml(config));
        for (const item of migration.mappings) {
            log.info('SubAgentLoader', `Migrated tools for ${config.name}: ${item.from} -> ${item.to}`);
        }
        if (migration.deduped > 0 && migration.mappings.length === 0) {
            log.info('SubAgentLoader', `Migrated tools for ${config.name}: deduplicated ${migration.deduped} duplicate tool(s)`);
        }
    }

    /**
     * Get a sub-agent config by name
     * @param {string} name
     * @returns {Object|null}
     */
    getSubAgent(name: string): SubAgentData | null {
        return this.cache.get(name) || null;
    }

    /**
     * Get all loaded sub-agents
     * @returns {Object[]}
     */
    getAllSubAgents(): SubAgentData[] {
        return Array.from(this.cache.values());
    }

    /**
     * Reload all sub-agents from disk
     * @returns {Promise<void>}
     */
    async reloadSubAgents() {
        await this.loadAllSubAgents();
    }

    /**
     * Save sub-agent to disk (create or update).
     * @param {Object} data - { name, description, role, model, tools, scope, max_iterations, min_iterations, enabled, prompt }
     * @returns {Promise<string>} Folder path
     */
    async saveSubAgent(data: SubAgentInput): Promise<string> {
        const slug = slugify(data.name);
        const folderPath = `${SUB_AGENTS_PATH}/${slug}`;
        const yamlPath = `${folderPath}/SUB_AGENT.yaml`;
        const knowledgePath = `${folderPath}/KNOWLEDGE.md`;
        const role = data.role || 'researcher';

        // Build YAML config (without prompt — that goes to KNOWLEDGE.md)
        const yamlConfig: SubAgentYaml = {
            name: data.name,
            description: data.description,
            role,
        };
        if (data.model) yamlConfig.model = data.model;
        if ((data.tools?.length as number) > 0) yamlConfig.tools = data.tools;
        const scope = normalizeScope(data.scope);
        if (scope) yamlConfig.scope = scope;
        yamlConfig.max_iterations = data.max_iterations || defaultMaxIterations();
        yamlConfig.min_iterations = data.min_iterations || defaultMinIterations();
        if (data.max_tool_result_length != null) yamlConfig.max_tool_result_length = data.max_tool_result_length;
        if (data.from_template) yamlConfig.from_template = data.from_template;
        yamlConfig.enabled = data.enabled !== false;

        // Ensure directories
        if (!await this.vault.adapter.exists(SUB_AGENTS_PATH)) {
            await this.vault.adapter.mkdir(SUB_AGENTS_PATH);
        }
        if (!await this.vault.adapter.exists(folderPath)) {
            await this.vault.adapter.mkdir(folderPath);
        }

        // Write YAML
        const yamlStr = stringifyYaml(yamlConfig);
        await this.vault.adapter.write(yamlPath, yamlStr);

        // Instrukcja idzie na dysk W OBIE STRONY. Gdyby zapis stał pod samym
        // `if (data.prompt)`, wyczyszczenie instrukcji zostawiałoby starą
        // treść w KNOWLEDGE.md: cache mówiłby „pusto", user dostawałby „zapisany", a przy
        // najbliższym `loadAllSubAgents()` skasowana metoda wracałaby do biegów suba.
        // Pusto = tak samo jak przy odczycie (`prompt: (knowledge || '').trim()`).
        if (data.prompt?.trim()) {
            await this.vault.adapter.write(knowledgePath, data.prompt);
        } else if (await this.vault.adapter.exists(knowledgePath)) {
            await this.vault.adapter.remove(knowledgePath);
        }

        // Update cache
        this.cache.set(data.name, {
            name: data.name,
            description: data.description,
            role,
            model: data.model || null,
            tools: data.tools || [],
            scope,
            scope_type: data.scope_type || 'custom',
            max_iterations: yamlConfig.max_iterations,
            min_iterations: yamlConfig.min_iterations,
            max_tool_result_length: data.max_tool_result_length ?? defaultMaxToolResultLength(),
            enabled: data.enabled !== false,
            prompt: (data.prompt || '').trim(),
            from_template: data.from_template || null,
            path: yamlPath,
            format: 'sub_agent',
        });

        return folderPath;
    }

    /**
     * Delete sub-agent from disk and cache.
     * @param {string} name
     * @returns {Promise<boolean>}
     */
    async deleteSubAgent(name: string): Promise<boolean> {
        const config = this.cache.get(name);
        if (!config) return false;

        const slug = slugify(name);
        const folderPath = `${SUB_AGENTS_PATH}/${slug}`;

        try {
            if (await this.vault.adapter.exists(folderPath)) {
                // Delete files in folder
                for (const fileName of ['SUB_AGENT.yaml', 'KNOWLEDGE.md']) {
                    const filePath = `${folderPath}/${fileName}`;
                    if (await this.vault.adapter.exists(filePath)) {
                        await this.vault.adapter.remove(filePath);
                    }
                }
                await this.vault.adapter.rmdir(folderPath, false);
            }
            this.cache.delete(name);
            return true;
        } catch (e) {
            log.warn('SubAgentLoader', 'Cannot delete:', e);
            return false;
        }
    }

    /**
     * Ensure the sub-agents folder exists. Brak ról systemowych do zasiania —
     * plugin nie tworzy żadnych domyślnych subów (user buduje własne / używa generycznego workera).
     * @returns {Promise<void>}
     */
    async ensureStarterSubAgents() {
        try {
            if (!await this.vault.adapter.exists(SUB_AGENTS_PATH)) {
                await this.vault.adapter.mkdir(SUB_AGENTS_PATH);
            }
        } catch (e) {
            log.error('SubAgentLoader', 'Error creating sub-agents folder:', e);
        }
    }

    /**
     * Create a prep sub-agent for a specific agent. Idempotent.
     * @param {string} agentName
     * @returns {Promise<string>} Sub-agent name
     */
    async createPrepSubAgent(agentName: string): Promise<string> {
        const slug = slugify(agentName);
        const name = `${slug}-prep`;

        if (this.cache.has(name)) return name;

        await this.saveSubAgent({
            name,
            description: t('starter.sub_agent.prep_for_agent.desc', { agent: agentName }),
            role: 'researcher',
            tools: ['search', 'list', 'read'],
            max_iterations: defaultMaxIterations(),
            min_iterations: defaultMinIterations(),
            max_tool_result_length: defaultMaxToolResultLength(),
            enabled: true,
            prompt: t('starter.sub_agent.prep_for_agent.knowledge', { agent: agentName }),
        });

        return name;
    }
}
