import test from 'ava';
import { TriggerPopup } from './TriggerPopup.js';

// TS-any: test mock odwzorowuje rozszerzalne API pluginu i DOM bez pełnego runtime Obsidiana.
type TestDynamic = any;

function makePlugin({ agentName = 'TestAgent', skills = [], assignments = [], allSubs = [], tools = [] }: TestDynamic = {}) {
    const agent = {
        name: agentName,
        activeSubAgents: assignments,
    };
    return {
        plugin: {
            agentManager: {
                getActiveAgent: () => agent,
                getActiveAgentSkills: () => skills,
                resolveSubAgentConfig: (name: string) => allSubs.find((sa: TestDynamic) => sa.name === name) || null,
                subAgentLoader: {
                    getAllSubAgents: () => allSubs,
                },
            },
            toolRegistry: {
                filterByAgent: () => tools,
            },
        },
        agent,
    };
}

test('buildItems collects skills, visible custom sub-agents and mcp servers', t => {
    const { plugin, agent } = makePlugin({
        agentName: 'Klara',
        skills: [
            { name: 'daily-review', slug: 'daily-review', description: 'review of the day', userInvocable: true },
            { name: 'hidden', slug: 'hidden', userInvocable: false },
        ],
        assignments: [{ name: 'klara-prep' }],
        allSubs: [
            { name: 'klara-prep', description: 'custom assigned' },
            { name: 'klara-strateg', description: 'another custom for Klara' },
            { name: 'kustosz-prep', description: 'custom for another agent' },
            { name: 'prep-memory', description: 'legacy system name', system: true },
            { name: 'prep', description: 'legacy standalone' },
        ],
        tools: [
            { name: 'vault_search', serverName: 'core', description: 'search' },
            { name: 'demo_tool', serverName: 'demo-server' },
        ],
    });
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    const items = popup.buildItems();

    const skillNames = items.filter(i => i.section === 'skills').map(i => i.name);
    t.deepEqual(skillNames, ['daily-review'], 'skill with userInvocable=false is filtered out');

    const subAgentNames = items.filter(i => i.section === 'sub-agents').map(i => i.name).sort();
    t.deepEqual(subAgentNames, ['klara-prep', 'klara-strateg'], 'only Klara-prefixed custom subs surface');
    t.false(subAgentNames.includes('prep-memory'), 'D18: former system role no longer global');
    t.false(subAgentNames.includes('kustosz-prep'), 'custom sub-agent for another agent is hidden');
    t.false(subAgentNames.includes('prep'), 'legacy standalone prep is hidden');

    // D18: brak dekoracji isSystem/badge na itemach sub-agentów.
    t.true(items.filter(i => i.section === 'sub-agents').every((i: TestDynamic) => i.isSystem === undefined && i.badge === undefined));

    const mcpServers = items.filter(i => i.section === 'mcp').map(i => i.name);
    t.deepEqual(mcpServers.sort(), ['core', 'demo-server'], 'unique server names from filterByAgent');
});

test('buildItems surfaces no sub-agents when none match the agent prefix (D18)', t => {
    const { plugin, agent } = makePlugin({
        agentName: 'Klara',
        assignments: [],
        allSubs: [
            { name: 'prep-memory', system: true },
            { name: 'strateg-planer', system: true },
        ],
    });
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    const items = popup.buildItems();
    const subs = items.filter(i => i.section === 'sub-agents').map(i => i.name);
    t.deepEqual(subs, []);
});

test('setFilter narrows filteredItems by case-insensitive substring match', t => {
    const { plugin, agent } = makePlugin({
        skills: [
            { name: 'daily-review', slug: 'daily-review', userInvocable: true },
            { name: 'weekly-review', slug: 'weekly-review', userInvocable: true },
            { name: 'plan', slug: 'plan', userInvocable: true },
        ],
    });
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    popup.items = popup.buildItems();
    popup._applyFilter();
    t.is(popup.filteredItems.length, 3);

    popup.setFilter('REVIEW');
    t.is(popup.filteredItems.length, 2, 'case-insensitive substring filter');
    t.deepEqual(popup.filteredItems.map(i => i.name).sort(), ['daily-review', 'weekly-review']);

    popup.setFilter('plan');
    t.is(popup.filteredItems.length, 1);
    t.is(popup.filteredItems[0].name, 'plan');

    popup.setFilter('nope');
    t.is(popup.filteredItems.length, 0, 'no-match → empty list');
});

test('setFilter resets selectedIndex to 0', t => {
    const { plugin, agent } = makePlugin({
        skills: [
            { name: 'a', slug: 'a', userInvocable: true },
            { name: 'b', slug: 'b', userInvocable: true },
            { name: 'c', slug: 'c', userInvocable: true },
        ],
    });
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    popup.items = popup.buildItems();
    popup._applyFilter();
    popup.selectedIndex = 2;
    popup.setFilter('');
    t.is(popup.selectedIndex, 0);
});

test('_defaultSelectedIndex jumps to sub-agents section when triggered with @', t => {
    const { plugin, agent } = makePlugin({
        skills: [{ name: 's1', slug: 's1', userInvocable: true }],
        assignments: [{ name: 'testagent-sa1' }],
        allSubs: [{ name: 'testagent-sa1', description: '' }],
    });
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    popup.items = popup.buildItems();
    const idx = popup._defaultSelectedIndex('@');
    t.is(popup.items[idx].section, 'sub-agents');

    const slashIdx = popup._defaultSelectedIndex('/');
    t.is(slashIdx, 0, '/ defaults to first item (skills)');
});

test('buildItems surfaces slash commands for `/` trigger only', t => {
    const { plugin, agent } = makePlugin();
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic, {
        slashCommands: [
            { name: '/save session', description: 'Archive the current Memory v3 live session.' },
            { name: '/clear', description: 'Start a new chat session.' }
        ]
    });
    popup.triggerChar = '/';
    const slashItems = popup.buildItems().filter(it => it.section === 'slash');
    t.deepEqual(slashItems.map(it => it.name).sort(), ['/clear', '/save session']);
});

test('buildItems hides slash commands for `@` trigger', t => {
    const { plugin, agent } = makePlugin();
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic, {
        slashCommands: [{ name: '/save session', description: 'x' }]
    });
    popup.triggerChar = '@';
    const slashItems = popup.buildItems().filter(it => it.section === 'slash');
    t.is(slashItems.length, 0);
});

test('handleKeyDown returns false when popup is closed', t => {
    const { plugin, agent } = makePlugin();
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    t.false(popup.isOpen());
    t.false(popup.handleKeyDown({ key: 'Escape' } as KeyboardEvent));
    t.false(popup.handleKeyDown({ key: 'Enter' } as KeyboardEvent));
});

test('intersection security: only skills the agent has are surfaced', t => {
    // getActiveAgentSkills returns the already-filtered list (whitelist intersection).
    // TriggerPopup must not re-add anything beyond what manager exposes.
    const { plugin, agent } = makePlugin({
        skills: [
            { name: 'allowed-1', slug: 'allowed-1', userInvocable: true },
            { name: 'allowed-2', slug: 'allowed-2', userInvocable: true },
        ],
    });
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    const items = popup.buildItems();
    const skillNames = items.filter(i => i.section === 'skills').map(i => i.name).sort();
    t.deepEqual(skillNames, ['allowed-1', 'allowed-2']);
});
