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

test('buildItems collects skills, visible custom sub-agents and ONLY external mcp servers (source:"user")', t => {
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
        // Rejestr MIESZANY, odwzorowuje PRAWDZIWY ToolRegistry: kilka wbudowanych narzędzi bez
        // `source` (built-in NIE ustawia `source` na tool object - zmierzone w
        // `modules/tools/built-in-servers/artifacts/ArtifactCreateTool.ts:25`, `serverName:
        // 'artifacts'` bez `source`), jedno wbudowane z `serverName:'komunikator'` + `source:
        // 'built-in'` jawnie (`modules/tools/KomunikatorTools.ts:316`, `kom_send` - kontrakt typu
        // `ToolDefinition.source` w `ToolRegistry.ts` dopuszcza `'built-in'` jako wartość
        // literalną, więc fikstura pokrywa OBA warianty built-ina, nie tylko brak pola), i dwa
        // narzędzia DWÓCH RÓŻNYCH zewnętrznych serwerów MCP (`source:'user'`, wzór
        // `ExternalMcpManager._wrapTool`, linia ~700: `name` = `<serverId>__<toolName>`,
        // `serverName` = `serverId` serwera). Bez filtra `source !== 'user'` w `buildItems`
        // (regresja punktu 1) `read`/`write`/`artifact_create`/`kom_send` wpadłyby do sekcji mcp
        // jako fałszywe serwery, bo mają `serverName`, tak samo jak prawdziwe external tools.
        tools: [
            { name: 'read', description: 'wbudowany odczyt' },
            { name: 'write', description: 'wbudowany zapis', source: 'built-in' },
            { name: 'artifact_create', serverName: 'artifacts', description: 'tworzy artefakt' },
            { name: 'kom_send', serverName: 'komunikator', source: 'built-in', description: 'wysyła wiadomość' },
            { name: 'core-docs__search_docs', serverName: 'core-docs', source: 'user', description: '[Core Docs] search' },
            { name: 'demo-server__ping', serverName: 'demo-server', source: 'user', description: '[Demo] ping' },
        ],
    });
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic);
    const items = popup.buildItems();

    const skillNames = items.filter(i => i.section === 'skills').map(i => i.name);
    t.deepEqual(skillNames, ['daily-review'], 'skill with userInvocable=false is filtered out');

    const subAgentNames = items.filter(i => i.section === 'sub-agents').map(i => i.name).sort();
    t.deepEqual(subAgentNames, ['klara-prep', 'klara-strateg'], 'only Klara-prefixed custom subs surface');
    t.false(subAgentNames.includes('prep-memory'), 'former system role no longer global');
    t.false(subAgentNames.includes('kustosz-prep'), 'custom sub-agent for another agent is hidden');
    t.false(subAgentNames.includes('prep'), 'legacy standalone prep is hidden');

    // brak dekoracji isSystem/badge na itemach sub-agentów.
    t.true(items.filter(i => i.section === 'sub-agents').every((i: TestDynamic) => i.isSystem === undefined && i.badge === undefined));

    // Sekcja mcp = jeden wpis PER NARZĘDZIE serwera zewnętrznego (source:"user"), `name` = pełna
    // nazwa z rejestru (`<serwer>__<narzędzie>`) - żadna pozycja nie jest samą nazwą serwera.
    const mcpItems = items.filter(i => i.section === 'mcp');
    t.deepEqual(
        mcpItems.map(i => i.name).sort(),
        ['core-docs__search_docs', 'demo-server__ping'],
        'sekcja mcp = DOKŁADNIE pełne nazwy narzędzi serwerów zewnętrznych, literalna lista'
    );
    t.false(
        mcpItems.some(i => ['read', 'write', 'artifact_create', 'kom_send', 'artifacts', 'komunikator', 'core-docs', 'demo-server'].includes(i.name)),
        'żadne wbudowane narzędzie ani gołą nazwę serwera nie udaje pozycji sekcji mcp'
    );
    t.deepEqual(
        mcpItems.map(i => i.label).sort(),
        ['ping', 'search_docs'],
        'label = czytelna część nazwy narzędzia PO `serverId__`'
    );

    // onSelect dla pozycji mcp wstawia marker z PEŁNĄ nazwą narzędzia (@@tool:<serwer>__<narzędzie>),
    // nie z samą nazwą serwera - `_commit` nie potrzebuje realnego DOM (popup nigdy nie był
    // otwarty przez `open()`, więc `close()` wewnątrz `_commit` jest no-opem na `popupEl===null`).
    const onSelectCalls: Array<{ item: TestDynamic; marker: string }> = [];
    const popupForSelect = new TriggerPopup(plugin, agent, null as TestDynamic, {
        onSelect: (item, marker) => { onSelectCalls.push({ item, marker }); },
    });
    const demoServerItem = popupForSelect.buildItems().find(i => i.section === 'mcp' && i.name === 'demo-server__ping')!;
    popupForSelect.filteredItems = [demoServerItem];
    popupForSelect.selectedIndex = 0;
    popupForSelect._commit(0);
    t.deepEqual(
        onSelectCalls.map(c => c.marker),
        ['@@tool:demo-server__ping'],
        'marker wstawiony przez onSelect niesie PEŁNĄ nazwę narzędzia, nie samą nazwę serwera'
    );
});

test('buildItems surfaces no sub-agents when none match the agent prefix', t => {
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

// `_defaultSelectedIndex` (i cała jego gałąź `@` - skok na sekcję sub-agentów) skasowane:
// popup 2.3.0 otwiera WYŁĄCZNIE `/` (chat_ui.ts's `_handleTriggerKeyDown`/`_handleTriggerInput`
// reagują tylko na ten znak), `@` obsługuje odtąd wyłącznie MentionAutocomplete. `open()` zawsze
// startuje z `selectedIndex = 0` - test osobnej metody byłby pinowaniem stałej (CLAUDE.md).

test('buildItems zawsze surfacuje slash-komendy (jedyny trigger tego popupu to `/`)', t => {
    const { plugin, agent } = makePlugin();
    const popup = new TriggerPopup(plugin, agent, null as TestDynamic, {
        slashCommands: [
            { name: '/save session', description: 'Archive the current Memory v3 live session.' },
            { name: '/clear', description: 'Start a new chat session.' }
        ]
    });
    const slashItems = popup.buildItems().filter(it => it.section === 'slash');
    t.deepEqual(slashItems.map(it => it.name).sort(), ['/clear', '/save session']);
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
