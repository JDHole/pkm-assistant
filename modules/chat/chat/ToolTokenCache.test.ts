import test from 'ava';
import { clearToolTokenCache, getCachedToolTokenBreakdown } from './ToolTokenCache.js';
import type { CacheAgent } from './ToolTokenCache.js';

const systemTools = [
    { type: 'function', function: { name: 'vault_read', parameters: { type: 'object' } } },
];
const mcpTools = [
    { type: 'function', function: { name: 'custom_search', parameters: { type: 'object' } } },
];

test('getCachedToolTokenBreakdown caches per agent and category', t => {
    const agent: CacheAgent = { name: 'Klara' };
    const first = getCachedToolTokenBreakdown(agent, { systemTools, mcpToolsActive: mcpTools });
    const cacheAfterFirst = agent._toolDefinitionsTokenCache;
    const second = getCachedToolTokenBreakdown(agent, { systemTools: [...systemTools], mcpToolsActive: [...mcpTools] });

    t.true(first.system_tools > 0);
    t.true(first.mcp_tools_active > 0);
    t.is(second.system_tools, first.system_tools);
    t.is(second.mcp_tools_active, first.mcp_tools_active);
    t.is(agent._toolDefinitionsTokenCache, cacheAfterFirst);
});

test('clearToolTokenCache removes transient cache from agent', t => {
    const agent: CacheAgent = { name: 'Borys' };
    getCachedToolTokenBreakdown(agent, { systemTools, mcpToolsActive: mcpTools });
    t.truthy(agent._toolDefinitionsTokenCache);

    clearToolTokenCache(agent);

    t.falsy(agent._toolDefinitionsTokenCache);
});
