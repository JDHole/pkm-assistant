import { countTokens } from '../../../core/index.js';

type ToolDefinition = { function?: { name?: string }; name?: string };
type ToolTokenCache = { systemKey?: string; systemTokens?: number; mcpKey?: string; mcpTokens?: number };
export type CacheAgent = { name?: string; _toolDefinitionsTokenCache?: ToolTokenCache };
type ToolGroups = { systemTools?: ToolDefinition[]; mcpToolsActive?: ToolDefinition[] };

function toolName(definition: ToolDefinition): string {
    return definition?.function?.name || definition?.name || '';
}

function cacheKeyFor(definitions: ToolDefinition[] = []): string {
    return definitions
        .map(toolName)
        .filter(Boolean)
        .sort()
        .join('|');
}

function countDefinitions(definitions: ToolDefinition[] = []): number {
    if (!definitions.length) return 0;
    return countTokens(JSON.stringify(definitions));
}

export function getCachedToolTokenBreakdown(
    agent: CacheAgent | null | undefined,
    { systemTools = [], mcpToolsActive = [] }: ToolGroups = {},
): { system_tools: number; mcp_tools_active: number } {
    if (!agent) {
        return {
            system_tools: countDefinitions(systemTools),
            mcp_tools_active: countDefinitions(mcpToolsActive),
        };
    }

    const cache = agent._toolDefinitionsTokenCache || (agent._toolDefinitionsTokenCache = {});
    const systemKey = cacheKeyFor(systemTools);
    const mcpKey = cacheKeyFor(mcpToolsActive);

    if (cache.systemKey !== systemKey) {
        cache.systemKey = systemKey;
        cache.systemTokens = countDefinitions(systemTools);
    }
    if (cache.mcpKey !== mcpKey) {
        cache.mcpKey = mcpKey;
        cache.mcpTokens = countDefinitions(mcpToolsActive);
    }

    return {
        system_tools: cache.systemTokens || 0,
        mcp_tools_active: cache.mcpTokens || 0,
    };
}

export function clearToolTokenCache(agent: CacheAgent | null | undefined): void {
    if (agent?._toolDefinitionsTokenCache) delete agent._toolDefinitionsTokenCache;
}
