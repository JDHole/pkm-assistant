/**
 * SubAgentTemplateStore — magazyn SZABLONÓW sub-agentów (S27 Z1).
 *
 * Szablon: `.pkm-assistant/templates/sub-agents/<slug>/SUB_AGENT.yaml` (+ opcjonalny
 * `KNOWLEDGE.md`) w formacie IDENTYCZNYM z żywym subem + pole `version: N` (int, start 1).
 *
 * Decyzje kanoniczne (S27):
 *  - D2: szablon może zostać wyznaczony GLOBALNYM subem (`settings.pkmAssistant.globalSubTemplate`).
 *    Wtedy `delegate` bez `aspect` używa jego configu zamiast fabrycznego `pkm-sub`.
 *  - D3 „kopia, nie link": `instantiate()` tworzy niezależną kopię w `.pkm-assistant/sub-agents/`
 *    pod nazwą `<agent-slug>-<slug>` (konwencja widoczności `getVisibleSubAgentsForAgent`).
 *    Kopia niesie `from_template: "<nazwa> vN"`; wersja szablonu nie nadpisuje żywego bytu.
 *
 * Pure względem `obsidian` (tylko `vault.adapter`) — testowalny w AVA.
 */
import { parseYaml, stringifyYaml, slugify } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import type { SubAgentData, SubAgentInput, SubAgentYaml, VaultLike } from './types.js';
// TS-any: template YAML is a backwards-compatible user-data boundary.
type TemplateYaml = Record<string, any>;
type StoredTemplate = {
    name: string;
    slug: string;
    description: string;
    role: string | null;
    model?: string | null;
    tools?: string[];
    scope?: SubAgentData['scope'];
    max_iterations?: number | null;
    min_iterations?: number | null;
    max_tool_result_length?: number | null;
    enabled?: boolean;
    version?: number;
    prompt?: string;
    path?: string;
    folderPath: string;
    isTemplate: true;
};

// `export` zdjęty w D7 (AUD-dead-code-010/164): zero importerów spoza pliku (S30 Z4 wyciął
// tę stałą z barrela z uzasadnieniem "testy deep-importują wprost" — dla tej akurat nazwy
// nieprawdziwym, żaden test po nią nie sięga).
const SUB_AGENT_TEMPLATES_PATH = '.pkm-assistant/templates/sub-agents';
const LIVE_SUB_AGENTS_PATH = '.pkm-assistant/sub-agents';

export class SubAgentTemplateStore {
    declare vault: VaultLike;
    declare cache: Map<string, StoredTemplate>;
    /**
     * @param {Object} vault - Obsidian Vault object (używany jest wyłącznie `vault.adapter`)
     */
    constructor(vault: VaultLike) {
        this.vault = vault;
        /** @type {Map<string, Object>} slug → szablon */
        this.cache = new Map();
    }

    // ─── odczyt ─────────────────────────────────────────────────

    /**
     * Wczytaj wszystkie szablony z dysku do cache.
     * @returns {Promise<Object[]>}
     */
    async loadAll() {
        this.cache.clear();
        try {
            if (!await this.vault.adapter.exists(SUB_AGENT_TEMPLATES_PATH)) return [];
            const listed = await this.vault.adapter.list(SUB_AGENT_TEMPLATES_PATH);
            for (const folderPath of listed?.folders || []) {
                try {
                    const tpl = await this._loadFromFolder(folderPath);
                    if (tpl) this.cache.set(tpl.slug, tpl);
                } catch (e) {
                    log.warn('SubAgentTemplateStore', 'Nie udało się wczytać szablonu z', folderPath, e);
                }
            }
        } catch (e) {
            log.error('SubAgentTemplateStore', 'Błąd wczytywania szablonów subów:', e);
        }
        return this.list();
    }

    /** @returns {Object[]} szablony z cache (posortowane po nazwie) */
    list(): StoredTemplate[] {
        return [...this.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** @param {string} slug @returns {Object|null} */
    get(slug: string): StoredTemplate | null {
        if (!slug) return null;
        return this.cache.get(slug)
            || [...this.cache.values()].find(tpl => tpl.name === slug)
            || null;
    }

    /** @returns {number} liczba szablonów (licznik dla Home/Zaplecza) */
    count() {
        return this.cache.size;
    }

    /** @private */
    async _loadFromFolder(folderPath: string): Promise<StoredTemplate | null> {
        const yamlPath = `${folderPath}/SUB_AGENT.yaml`;
        if (!await this.vault.adapter.exists(yamlPath)) return null;
        const raw = await this.vault.adapter.read(yamlPath);
        if (!raw?.trim()) return null;

        const config = parseYaml(raw) as TemplateYaml;
        if (!config?.name || !config?.description) {
            log.warn('SubAgentTemplateStore', 'Szablon suba bez name/description:', yamlPath);
            return null;
        }

        let knowledge = '';
        try {
            const knowledgePath = `${folderPath}/KNOWLEDGE.md`;
            if (await this.vault.adapter.exists(knowledgePath)) {
                knowledge = await this.vault.adapter.read(knowledgePath);
            }
        } catch { /* brak KNOWLEDGE.md jest OK */ }

        return {
            name: config.name,
            slug: folderPath.split('/').pop()!,
            description: config.description,
            role: config.role || null,
            model: config.model || null,
            tools: Array.isArray(config.tools) ? [...config.tools] : [],
            scope: config.scope || null,
            max_iterations: config.max_iterations || null,
            min_iterations: config.min_iterations || null,
            max_tool_result_length: config.max_tool_result_length ?? null,
            enabled: config.enabled !== false,
            version: Number(config.version) || 1,
            prompt: (knowledge || '').trim(),
            path: yamlPath,
            folderPath,
            isTemplate: true,
        };
    }

    // ─── zapis ──────────────────────────────────────────────────

    /**
     * Utwórz NOWY szablon (version = 1). Kolizja slugu → sufiks `-2`, `-3`…
     * @param {Object} data - dane suba (kształt jak z `SubAgentEditorModal`)
     * @returns {Promise<{success: boolean, slug?: string, name?: string, renamed?: boolean, error?: string}>}
     */
    async createFromData(data: SubAgentInput): Promise<{ success: boolean; slug?: string; name?: string; renamed?: boolean; error?: string }> {
        if (!data?.name?.trim() || !data?.description?.trim()) {
            return { success: false, error: 'missing_fields' };
        }
        const resolved = await this._freeName(data.name);
        await this._write(resolved.slug, { ...data, name: resolved.name, version: 1 });
        return { success: true, slug: resolved.slug, name: resolved.name, renamed: resolved.renamed };
    }

    /**
     * Zapisz EDYCJĘ szablonu — podbija `version` o 1.
     * @param {string} slug
     * @param {Object} data
     * @returns {Promise<{success: boolean, slug?: string, version?: number, error?: string}>}
     */
    async save(slug: string, data: SubAgentInput): Promise<{ success: boolean; slug?: string; version?: number; error?: string }> {
        if (!data?.name?.trim() || !data?.description?.trim()) {
            return { success: false, error: 'missing_fields' };
        }
        const existing = this.get(slug);
        if (!existing) return this.createFromData(data);

        const version = (Number(existing.version) || 1) + 1;
        await this._write(existing.slug, { ...data, name: existing.name, version });
        return { success: true, slug: existing.slug, version };
    }

    /**
     * Skasuj szablon (YAML + KNOWLEDGE.md + folder). Kopie u agentów zostają (D3).
     * @param {string} slug
     * @returns {Promise<boolean>}
     */
    async delete(slug: string): Promise<boolean> {
        const tpl = this.get(slug);
        if (!tpl) return false;
        const folderPath = `${SUB_AGENT_TEMPLATES_PATH}/${tpl.slug}`;
        try {
            for (const fileName of ['SUB_AGENT.yaml', 'KNOWLEDGE.md']) {
                const filePath = `${folderPath}/${fileName}`;
                if (await this.vault.adapter.exists(filePath)) await this.vault.adapter.remove(filePath);
            }
            try { await this.vault.adapter.rmdir(folderPath, false); } catch { /* ok */ }
            this.cache.delete(tpl.slug);
            return true;
        } catch (e) {
            log.warn('SubAgentTemplateStore', 'Nie udało się skasować szablonu:', e);
            return false;
        }
    }

    /**
     * Odlej KOPIĘ szablonu jako żywego suba konkretnego agenta (D3).
     * Nazwa kopii = `<agent-slug>-<slug szablonu>` (konwencja `getVisibleSubAgentsForAgent`),
     * kolizja → sufiks `-2`, `-3`…
     *
     * @param {string} slug - slug szablonu
     * @param {string} agentName - agent, do którego Ekipy trafia kopia
     * @param {Object} deps
     * @param {Object} deps.subAgentLoader - `SubAgentLoader` (owner żywych subów)
     * @returns {Promise<{success: boolean, name?: string, renamed?: boolean,
     *                    fromTemplate?: string, error?: string}>}
     */
    async instantiate(slug: string, agentName: string, { subAgentLoader }: { subAgentLoader?: { saveSubAgent: (data: SubAgentInput) => Promise<string> } } = {}): Promise<{ success: boolean; name?: string; renamed?: boolean; fromTemplate?: string; error?: string }> {
        const tpl = this.get(slug);
        if (!tpl) return { success: false, error: 'template_not_found' };
        if (!subAgentLoader?.saveSubAgent) return { success: false, error: 'sub_agent_loader_unavailable' };
        const agentSlug = slugify(agentName || '');
        if (!agentSlug) return { success: false, error: 'agent_required' };

        const resolved = await this._freeSubName(`${agentSlug}-${tpl.slug}`);
        const fromTemplate = `${tpl.name} v${tpl.version || 1}`;
        const copy: SubAgentInput = {
            name: resolved.name,
            description: tpl.description,
            role: tpl.role || 'researcher',
            model: tpl.model || null,
            tools: [...(tpl.tools || [])],
            scope: tpl.scope || null,
            enabled: tpl.enabled !== false,
            prompt: tpl.prompt || '',
            from_template: fromTemplate,
        };
        if (tpl.max_iterations) copy.max_iterations = tpl.max_iterations;
        if (tpl.min_iterations) copy.min_iterations = tpl.min_iterations;
        if (tpl.max_tool_result_length != null) copy.max_tool_result_length = tpl.max_tool_result_length;

        await subAgentLoader.saveSubAgent(copy);
        return { success: true, name: resolved.name, renamed: resolved.renamed, fromTemplate };
    }

    // ─── prywatne ───────────────────────────────────────────────

    /** @private */
    async _write(slug: string, data: SubAgentInput): Promise<void> {
        const folderPath = `${SUB_AGENT_TEMPLATES_PATH}/${slug}`;
        for (const dir of ['.pkm-assistant/templates', SUB_AGENT_TEMPLATES_PATH, folderPath]) {
            if (!await this.vault.adapter.exists(dir)) await this.vault.adapter.mkdir(dir);
        }

        const yamlConfig: SubAgentYaml = {
            name: data.name,
            description: data.description,
            role: data.role || 'researcher',
        };
        if (data.model) yamlConfig.model = data.model;
        if ((data.tools?.length as number) > 0) yamlConfig.tools = [...data.tools!];
        if (data.scope) yamlConfig.scope = data.scope;
        if (data.max_iterations) yamlConfig.max_iterations = data.max_iterations;
        if (data.min_iterations) yamlConfig.min_iterations = data.min_iterations;
        if (data.max_tool_result_length != null) yamlConfig.max_tool_result_length = data.max_tool_result_length;
        yamlConfig.enabled = data.enabled !== false;
        yamlConfig.version = Number(data.version) || 1;

        await this.vault.adapter.write(`${folderPath}/SUB_AGENT.yaml`, stringifyYaml(yamlConfig));
        // AUD-bledy-010: ta sama reguła co w `SubAgentLoader.saveSubAgent` - wyczyszczona
        // metoda MUSI zniknąć z dysku, inaczej „wersja v3" szablonu niesie metodę z v2
        // i taką kopię dostaje każdy sub odlany z tego szablonu.
        const knowledgePath = `${folderPath}/KNOWLEDGE.md`;
        if (data.prompt?.trim()) {
            await this.vault.adapter.write(knowledgePath, data.prompt);
        } else if (await this.vault.adapter.exists(knowledgePath)) {
            await this.vault.adapter.remove(knowledgePath);
        }

        this.cache.set(slug, {
            ...yamlConfig,
            slug,
            tools: yamlConfig.tools || [],
            scope: yamlConfig.scope || null,
            max_iterations: yamlConfig.max_iterations || null,
            min_iterations: yamlConfig.min_iterations || null,
            max_tool_result_length: yamlConfig.max_tool_result_length ?? null,
            prompt: (data.prompt || '').trim(),
            path: `${folderPath}/SUB_AGENT.yaml`,
            folderPath,
            isTemplate: true,
        });
    }

    /** @private wolny slug w magazynie szablonów (sufiks doklejany do nazwy i slugu) */
    async _freeName(baseName: string): Promise<{ name: string; slug: string; renamed: boolean }> {
        let name = baseName;
        let slug = slugify(name);
        let n = 1;
        while (await this.vault.adapter.exists(`${SUB_AGENT_TEMPLATES_PATH}/${slug}`)) {
            n += 1;
            name = `${baseName} ${n}`;
            slug = slugify(name);
            if (n > 99) break;
        }
        return { name, slug, renamed: n > 1 };
    }

    /** @private wolna nazwa żywego suba (nazwa == folder, więc sufiks doklejamy wprost) */
    async _freeSubName(baseName: string): Promise<{ name: string; renamed: boolean }> {
        let name = baseName;
        let n = 1;
        while (await this.vault.adapter.exists(`${LIVE_SUB_AGENTS_PATH}/${slugify(name)}`)) {
            n += 1;
            name = `${baseName}-${n}`;
            if (n > 99) break;
        }
        return { name, renamed: n > 1 };
    }
}
