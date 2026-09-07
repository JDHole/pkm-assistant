/**
 * PlaybookManager
 * Zarządza vault_map.md per agent (mapa terenu vaulta).
 *
 * E2.8 A4 (S12/S29): Playbook Builder + playbook.md SKASOWANY (wydmuszka — prompt nie czytał
 * skompilowanej ściągi; ideę indeksu przejął chudy rdzeń E2.4). Zostaje kompilacja + starter
 * vault_map (compileVaultMap / ensureStarterFiles).
 */

import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { getAgentSafeName } from '../../core/index.js';
import type { Vault } from 'obsidian';

export type VaultMapFocusFolder = string | {
    path: string;
    access?: string;
} | {
    group: string;
};

/**
 * Ścieżka folderu z wpisu focusFolders (AUD-code-review-041) — jeden kształt czytany w
 * DWÓCH miejscach: string | {path,access} | {group}. Wpis grupowy (Agent._normalizeFocusFolders
 * — grupy z Ustawienia→Vault) nie niesie pojedynczej ścieżki tutaj (rozwiązanie {group}→foldery
 * żyje w AccessGuard/_buildEnvironment), więc oddaje pusty string — wołacz decyduje, co z tym
 * zrobić.
 */
function focusFolderPath(entry: VaultMapFocusFolder): string {
    if (typeof entry === 'string') return entry;
    if ('path' in entry) return entry.path;
    return '';
}

/** Poziom dostępu wpisu focusFolders — domyślnie zawsze `readwrite`, jak string i grupa. */
function focusFolderAccess(entry: VaultMapFocusFolder): string {
    if (typeof entry === 'string') return 'readwrite';
    if ('access' in entry) return entry.access || 'readwrite';
    return 'readwrite';
}

/**
 * Czytelna etykieta wpisu focusFolders na listę w generic starterze vault_map.md
 * (AUD-code-review-041). Rzutowanie `f as string` na obiekcie dawało `[object Object]" —
 * ten helper czyta ten sam kształt co `compileVaultMap`, zamiast udawać, że focusFolders
 * jest zawsze tablicą stringów.
 */
function focusFolderLabel(entry: VaultMapFocusFolder): string {
    if (typeof entry === 'string') return entry;
    if ('group' in entry) return entry.group ? `[${t('playbook.vm.group_label')}: ${entry.group}]` : '';
    return entry.path || '';
}

export type VaultMapAgent = {
    name: string;
    focusFolders?: VaultMapFocusFolder[];
};

export type VaultMapPlugin = {
    agentManager?: {
        getVaultMapDescriptions?: () => Promise<Record<string, string>>;
        readVaultMap?: () => Promise<string>;
    };
};

/** Base path for agent configs */
const AGENTS_BASE = '.pkm-assistant/agents';

// E2.8 A4 (S12/S29): Playbook Builder skasowany. GROUP_LABELS / getSystemGuideContent /
// getStarterPlaybooks + generatory sekcji playbooka + compilePlaybook usunięte.
// ZOSTAJE tylko część vault_map (compileVaultMap + starter vault_maps).

/**
 * Get starter vault_map templates for built-in agents (i18n, called at runtime).
 */
function getStarterVaultMaps(): Record<string, string> {
    return {
        jaskier: t('starter.vault_map.jaskier'),
        borys: t('starter.vault_map.borys'),
        nika: t('starter.vault_map.nika'),
    };
}

export class PlaybookManager {
    declare vault: Vault;

    /**
     * @param {Object} vault - Obsidian Vault object
     */
    constructor(vault: Vault) {
        this.vault = vault;
    }

    /**
     * Get the file path for an agent's vault_map
     * @param {string} agentName - Agent name
     * @returns {string} Path to vault_map.md
     */
    getVaultMapPath(agentName: string): string {
        const safeName = getAgentSafeName(agentName);
        return `${AGENTS_BASE}/${safeName}/vault_map.md`;
    }

    /**
     * Ensure vault_map.md exists for all built-in agents. Creates starter file if missing.
     * (E2.8 A4: playbook.md już nie jest tworzony — Playbook Builder skasowany.)
     * @param {Agent[]} agents - List of agents
     */
    async ensureStarterFiles(agents: VaultMapAgent[]): Promise<void> {
        for (const agent of agents) {
            const safeName = getAgentSafeName(agent.name);
            await this._ensureVaultMap(safeName, agent);
        }
    }

    /**
     * Read vault_map content for an agent (returns empty string if missing)
     * @param {string} agentName - Agent name
     * @returns {Promise<string>} Vault map content
     */
    async readVaultMap(agentName: string): Promise<string> {
        const path = this.getVaultMapPath(agentName);
        try {
            const exists = await this.vault.adapter.exists(path);
            if (!exists) return '';
            return await this.vault.adapter.read(path);
        } catch {
            return '';
        }
    }

    /** @private */
    async _ensureVaultMap(safeName: string, agent: VaultMapAgent): Promise<void> {
        const path = `${AGENTS_BASE}/${safeName}/vault_map.md`;
        try {
            const exists = await this.vault.adapter.exists(path);
            if (exists) return;

            const starterMaps = getStarterVaultMaps();
            const content = starterMaps[safeName] || this._genericVaultMap(agent);
            await this.vault.adapter.write(path, content);
        } catch (e) {
            log.warn('PlaybookManager', `Could not create vault_map for ${safeName}:`, e);
        }
    }

    /** @private */
    _genericVaultMap(agent: VaultMapAgent): string {
        const folders = agent.focusFolders || [];
        return `# Vault Map: ${agent.name}

## ${t('playbook.vm.access')}
${folders.length > 0 ? folders.map(f => `- ${focusFolderLabel(f)}`).join('\n') : t('starter.generic_vaultmap.full_access')}

${t('starter.generic_vaultmap.system_structure')}

## ${t('playbook.vm.user_zones')}
${t('starter.generic_vaultmap.auto_fill_hint')}
`;
    }

    // ═══════════════════════════════════════════
    // VAULT MAP BUILDER — compile from global vault map + focusFolders
    // ═══════════════════════════════════════════

    /**
     * Compile vault_map.md from agent config + global vault map data.
     *
     * Sources:
     * - Global vault map → user zones, agent zones (descriptions)
     * - Agent focusFolders → whitelist (what agent can see)
     * - System zones → always included (hardcoded)
     *
     * Logic:
     * - Empty focusFolders = full access → show ALL zones from global vault map
     * - focusFolders set = whitelist → show ONLY whitelisted folders
     * - No-Go folders are invisible (not mentioned at all)
     *
     * @param {import('../agents/Agent.js').default} agent
     * @param {Object} plugin
     * @returns {Promise<string>} Compiled markdown
     */
    async compileVaultMap(agent: VaultMapAgent, plugin: VaultMapPlugin): Promise<string> {
        const safeName = getAgentSafeName(agent.name);
        const focusFolders = agent.focusFolders || [];
        const isUnrestricted = focusFolders.length === 0;

        // Get global vault map data from AgentManager.
        const agentManager = plugin.agentManager;
        const vaultMapDescriptions = agentManager?.getVaultMapDescriptions ? await agentManager.getVaultMapDescriptions() : {};
        const globalVaultMap = agentManager?.readVaultMap ? await agentManager.readVaultMap() : '';
        const userZones = this._extractVaultMapSection(globalVaultMap, 'Strefy użytkownika');
        const agentZones = this._extractVaultMapSection(globalVaultMap, 'Strefy agentowe');

        const sections: string[] = [];

        // ── Header ──
        sections.push(`# Vault Map: ${agent.name}`);

        // ── Dostęp ──
        if (isUnrestricted) {
            sections.push(`## ${t('playbook.vm.access')}\n${t('playbook.vm.full_access')}`);
        } else {
            sections.push(`## ${t('playbook.vm.access')}\n${t('playbook.vm.restricted_access')}`);
        }

        // ── System structure (always) ──
        sections.push(t('starter.compile_vm.system_structure', { agent: safeName }));

        // ── Zones ──
        if (isUnrestricted) {
            // Full access — show ALL zones from global vault map as orientation
            if (userZones) {
                sections.push(`## ${t('playbook.vm.user_zones')}\n${userZones}`);
            }
            if (agentZones) {
                sections.push(`## ${t('playbook.vm.agent_zones')}\n${agentZones}`);
            }
            if (!userZones && !agentZones) {
                sections.push(`## ${t('playbook.vm.user_zones')}\n> ${t('playbook.vm.add_zones_hint')}`);
            }
        } else {
            // Restricted — show whitelist with access levels + global vault map descriptions
            const lines: string[] = [`## ${t('playbook.vm.whitelist_header')}`];
            for (const folder of focusFolders) {
                // AUD-code-review-041: wpis grupowy ({group}) nie ma pojedynczej ścieżki tutaj —
                // dawniej `folder.path` było wtedy `undefined` (typ nie przewidywał tego kształtu),
                // więc linia wychodziła jako `- **undefined/** [...]`. Pomijamy go w tej sekcji;
                // rozwiązanie grupy → foldery żyje w AccessGuard, nie w kompilacji vault_map.md.
                const path = focusFolderPath(folder);
                if (!path) continue;
                const access = focusFolderAccess(folder);
                const accessLabel = access === 'read' ? t('playbook.vm.read_only') : t('playbook.vm.readwrite');
                // Try to find description from the global vault map (with and without trailing slash)
                const desc = vaultMapDescriptions[path]
                    || vaultMapDescriptions[path.replace(/\/$/, '')]
                    || vaultMapDescriptions[path + '/']
                    || '';
                const descPart = desc ? ` — ${desc}` : '';
                lines.push(`- **${path}/** [${accessLabel}]${descPart}`);
            }
            sections.push(lines.join('\n'));
        }

        const markdown = sections.join('\n\n').trim() + '\n';

        // Write to vault_map.md
        const path = this.getVaultMapPath(agent.name);
        try {
            const dir = path.substring(0, path.lastIndexOf('/'));
            const dirExists = await this.vault.adapter.exists(dir);
            if (!dirExists) await this.vault.adapter.mkdir(dir);
            await this.vault.adapter.write(path, markdown);
        } catch (e) {
            log.warn('PlaybookManager', 'compileVaultMap write error:', e);
        }

        return markdown;
    }

    /**
     * Extract section content from global vault_map markdown.
     * @param {string} vaultMap - Full vault_map.md content
     * @param {string} sectionName - Header name (e.g. "Strefy użytkownika")
     * @returns {string} Section content (trimmed), empty string if not found or placeholder only
     * @private
     */
    _extractVaultMapSection(vaultMap: string, sectionName: string): string {
        if (!vaultMap) return '';
        const regex = new RegExp(`## ${sectionName}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
        const match = vaultMap.match(regex);
        if (!match) return '';
        const content = match[1].trim();
        // Skip placeholder content
        if (!content || content === '> (pusta sekcja)' || content.startsWith('> Ta sekcja') || content.startsWith('> This section')) return '';
        return content;
    }
}
