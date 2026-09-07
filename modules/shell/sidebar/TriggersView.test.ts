import test from 'ava';
import {
    collectSkillItems,
    collectSubAgentItems,
    collectMcpServerItems,
} from './triggers_collectors.js';

test('collectSkillItems filters out userInvocable=false', t => {
    const agentManager = {
        getActiveAgentSkills: () => [
            { name: 'daily-review', slug: 'daily-review', description: 'd', userInvocable: true },
            { name: 'hidden', slug: 'hidden', userInvocable: false },
            { name: 'plan', slug: 'plan' },
        ],
    };
    const items = collectSkillItems(agentManager);
    t.deepEqual(items.map((i: { name: string }) => i.name).sort(), ['daily-review', 'plan']);
    t.is(items[0].kind, 'skill');
});

test('collectSkillItems handles missing agentManager gracefully', t => {
    t.deepEqual(collectSkillItems(null), []);
    t.deepEqual(collectSkillItems({}), []);
    t.deepEqual(collectSkillItems({ getActiveAgentSkills: () => null }), []);
});

test('collectSubAgentItems returns ONLY active-agent custom subs (D18: no system roles)', t => {
    const activeAgent = { name: 'Klara', activeSubAgents: [{ name: 'klara-prep' }] };
    const agentManager = {
        subAgentLoader: {
            getAllSubAgents: () => [
                { name: 'klara-prep', description: 'custom assigned' },
                { name: 'klara-strateg', description: 'another custom for Klara' },
                { name: 'kustosz-prep', description: 'custom for another agent' },
                { name: 'prep-memory', description: 'legacy system name', system: true },
                { name: 'prep', description: 'legacy standalone' },
            ],
        },
    };
    const items = collectSubAgentItems(agentManager, activeAgent);
    const names = items.map(i => i.name);
    t.deepEqual(names, ['klara-prep', 'klara-strateg'], 'only Klara-prefixed custom subs, no system roles');
    // D18: brak dekoracji isSystem/badge — wszystkie widoczne suby są custom.
    t.true(items.every(i => i.isSystem === undefined && i.badge === undefined));
    t.false(names.includes('kustosz-prep'));
    t.false(names.includes('prep-memory'));
    t.false(names.includes('prep'));
    t.is(items[0].kind, 'sub-agent');
});

test('collectSubAgentItems returns empty when no sub matches the agent prefix (D18)', t => {
    const activeAgent = { activeSubAgents: [] };
    const agentManager = {
        subAgentLoader: {
            getAllSubAgents: () => [
                { name: 'prep-memory', system: true },
                { name: 'prep-whitelist', scope_type: 'system' },
            ],
        },
    };
    const items = collectSubAgentItems(agentManager, activeAgent);
    t.deepEqual(items, []);
});

test('collectMcpServerItems deduplicates by serverName', t => {
    const plugin = {
        toolRegistry: {
            filterByAgent: () => [
                { name: 'vault_search', serverName: 'core' },
                { name: 'vault_read', serverName: 'core' },
                { name: 'demo_tool', serverName: 'demo-server' },
            ],
        },
    };
    const items = collectMcpServerItems(plugin, null);
    t.deepEqual(items.map(i => i.name).sort(), ['core', 'demo-server']);
});

test('collectMcpServerItems returns empty when registry missing', t => {
    t.deepEqual(collectMcpServerItems({}, null), []);
    t.deepEqual(collectMcpServerItems({ toolRegistry: null }, null), []);
});

test('collectMcpServerItems falls back to getBuiltinServerForTool when serverName missing', t => {
    const plugin = {
        toolRegistry: {
            filterByAgent: () => [
                { name: 'memory_save' },
                { name: 'vault_read' },
            ],
            getBuiltinServerForTool: (toolName: string) => {
                if (toolName === 'memory_save') return 'memory';
                if (toolName === 'vault_read') return 'core';
                return null;
            },
        },
    };
    const items = collectMcpServerItems(plugin, null);
    t.deepEqual(items.map(i => i.name).sort(), ['core', 'memory']);
});
