/**
 * Pure collectors for TriggersView (Sprint 05.5 H2).
 *
 * Wydzielone do osobnego pliku żeby test (AVA, pure Node) mógł je załadować
 * bez kosztu ładowania `obsidian` i `modules/crystal-soul/index.js`.
 */

import { getVisibleSubAgentsForAgent } from '../../sub-agents/index.js';

// TS-any: manager and registry shapes are runtime plugin contracts.
type Runtime = any;
export type TriggerItem = { name: string; label: string; description: string; icon?: string; kind: string; isSystem?: undefined; badge?: undefined };

export function collectSkillItems(agentManager: Runtime): TriggerItem[] {
    const skills = agentManager?.getActiveAgentSkills?.() || [];
    return skills
        .filter((skill: Runtime) => skill?.userInvocable !== false)
        .map((skill: Runtime) => ({
            name: skill.slug || skill.name,
            label: skill.name || skill.slug,
            description: skill.description || '',
            icon: skill.icon_category || 'arcane',
            kind: 'skill',
        }));
}

export function collectSubAgentItems(agentManager: Runtime, activeAgent: Runtime): TriggerItem[] {
    // D18: brak ról systemowych — zwracamy wyłącznie custom suby usera dla aktywnego agenta.
    const allSubs = agentManager?.subAgentLoader?.getAllSubAgents?.() || [];
    return getVisibleSubAgentsForAgent(activeAgent, allSubs)
        .map((sa: Runtime) => ({
            name: sa.name,
            label: sa.name,
            description: sa.description || '',
            kind: 'sub-agent',
        }));
}

export function collectMcpServerItems(plugin: Runtime, activeAgent: Runtime): TriggerItem[] {
    const registry = plugin?.toolRegistry;
    if (!registry) return [];
    const visibleTools = registry.filterByAgent?.(activeAgent) || registry.getAllTools?.() || [];
    const seen = new Set<string>();
    const items: Runtime[] = [];
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
