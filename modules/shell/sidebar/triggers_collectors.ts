/**
 * Pure collectors for TriggersView.
 *
 * Wydzielone do osobnego pliku żeby test (AVA, pure Node) mógł je załadować
 * bez kosztu ładowania `obsidian` i `modules/crystal-soul/index.js`.
 */

import { getVisibleSubAgentsForAgent } from '../../sub-agents/index.js';
import type { SubAgentData } from '../../sub-agents/index.js';
import type { AgentManager } from '../../agents/index.js';
import type { ToolRegistry, ToolVisibilityAgent } from '../../tools/index.js';

export type TriggerItem = { name: string; label: string; description: string; icon?: string; kind: string; isSystem?: undefined; badge?: undefined };

/** Kształt skilla po rozwiązaniu override'ów (`AgentManager.resolveSkillConfig`) - `skillLoader`
 * jest jeszcze nieotypowanym polem dynamicznym (migracja modules/agents), więc granica jest tu. */
type ResolvedSkillLike = { userInvocable?: boolean; slug?: string; name: string; description?: string; icon_category?: string };

export function collectSkillItems(agentManager: AgentManager | null | undefined): TriggerItem[] {
    // TS-boundary: `getActiveAgentSkills()` przechodzi przez `skillLoader` (jeszcze nieotypowany
    // w AgentManager) - zawężamy do pól realnie czytanych niżej.
    const skills = (agentManager?.getActiveAgentSkills?.() || []) as ResolvedSkillLike[];
    return skills
        .filter((skill: ResolvedSkillLike) => skill?.userInvocable !== false)
        .map((skill: ResolvedSkillLike) => ({
            name: skill.slug || skill.name,
            // TS-boundary: `skill.name` jest wymagane (nigdy puste w praktyce), ale `||`
            // formalnie daje `string | undefined` (fallback na `slug`) - `label` w TriggerItem
            // jest `string`.
            label: (skill.name || skill.slug) as string,
            description: skill.description || '',
            icon: skill.icon_category || 'arcane',
            kind: 'skill',
        }));
}

export function collectSubAgentItems(agentManager: AgentManager | null | undefined, activeAgent: string | { name?: string } | null | undefined): TriggerItem[] {
    // Brak ról systemowych - zwracamy wyłącznie custom suby usera dla aktywnego agenta.
    // TS-boundary: `subAgentLoader` jest jeszcze nieotypowanym polem dynamicznym (migracja
    // modules/agents) - zawężamy do jedynej metody, której tu potrzeba.
    const allSubs = (agentManager?.subAgentLoader as { getAllSubAgents?(): SubAgentData[] } | undefined)?.getAllSubAgents?.() || [];
    return getVisibleSubAgentsForAgent(activeAgent, allSubs)
        .map((sa: SubAgentData) => ({
            name: sa.name,
            label: sa.name,
            description: sa.description || '',
            kind: 'sub-agent',
        }));
}

export function collectMcpServerItems(plugin: { toolRegistry?: ToolRegistry } | null | undefined, activeAgent: ToolVisibilityAgent | null | undefined): TriggerItem[] {
    const registry = plugin?.toolRegistry;
    if (!registry) return [];
    const visibleTools = registry.filterByAgent?.(activeAgent) || registry.getAllTools?.() || [];
    const seen = new Set<string>();
    const items: TriggerItem[] = [];
    for (const tool of visibleTools) {
        const serverName = tool?.serverName || registry.getBuiltinServerForTool?.(tool?.name) || tool?.name;
        if (!serverName || seen.has(serverName)) continue;
        seen.add(serverName);
        items.push({
            name: serverName,
            label: serverName,
            description: tool?.description || 'MCP',
            kind: 'mcp',
        });
    }
    return items;
}
