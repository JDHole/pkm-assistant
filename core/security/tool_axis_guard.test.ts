/**
 * K3 (AUD-security-052 / 004 / 024 / 025) — UPRAWNIENIE USERA MA EGZEKUCJĘ, NIE TYLKO WIDOK.
 *
 * Oś `disabled_tools` i opt-in `mcp_servers[]` żyły wyłącznie w filtrze WIDOCZNOŚCI
 * (`ToolRegistry.filterByAgent`), a `MCPClient.executeToolCall` brał narzędzie z GLOBALNEGO
 * rejestru. Model, który znał nazwę wyłączonego narzędzia (stara sesja, notatka, transkrypt
 * innego agenta), wołał je po nazwie i przechodził. Te testy pilnują, że:
 *   1. wyłączone narzędzie odbija się PRZED wykonaniem, bez pytania usera, a vault jest nietknięty,
 *   2. stara nazwa (alias) nie jest obejściem wyłączenia,
 *   3. narzędzie serwera zewnętrznego bez opt-inu odbija się, a z opt-inem leci dalej,
 *   4. zbiór „widoczne" i zbiór „wykonywalne" to ten sam zbiór (liczy je jedna metoda).
 */
import test from 'ava';
import { MCPClient } from '../../modules/tools/MCPClient.js';
import { ToolRegistry } from '../../modules/tools/ToolRegistry.js';
import { createWriteTool } from '../../modules/tools/WriteTool.js';
import { createReadTool } from '../../modules/tools/ReadTool.js';
import { AccessGuard } from './AccessGuard.js';
import { PermissionSystem } from './PermissionSystem.js';
/** Kształt wyniku `executeToolCall`, którego pilnują te testy. */
type ToolCallOutcome = { isError?: boolean; error?: string; success?: boolean };

/** Agent-atrapa w kształcie, jakiego dotykają obie bramki (oś narzędziowa + PermissionSystem). */
type TestAgent = {
    name: string;
    permissions: { guidance_mode: boolean };
    focusFolders: unknown[];
    disabled_tools: string[];
    mcp_servers: string[];
};

function makeAgent(over: Partial<TestAgent> = {}): TestAgent {
    return {
        name: 'Tester',
        // Cały zwykły vault — żeby jedyną barierą w teście była oś narzędziowa.
        permissions: { guidance_mode: true },
        focusFolders: [],
        disabled_tools: [],
        mcp_servers: ['vault', 'memory', 'core'],
        ...over,
    };
}

/** Vault-atrapa: liczy KAŻDE dotknięcie, więc odmowa musi zostawić same zera. */
function makeFakeApp(initialFiles: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initialFiles };
    const touched = { create: 0, modify: 0, read: 0 };
    const app = {
        vault: {
            getAbstractFileByPath(path: string) {
                return Object.prototype.hasOwnProperty.call(files, path) ? { path } : null;
            },
            async read(file: { path: string }) { touched.read += 1; return files[file.path]; },
            async cachedRead(file: { path: string }) { touched.read += 1; return files[file.path]; },
            async modify(file: { path: string }, content: string) { touched.modify += 1; files[file.path] = content; },
            async create(path: string, content: string) { touched.create += 1; files[path] = content; return { path }; },
            async createFolder() { /* no-op */ },
            adapter: {
                async read(path: string) { return files[path]; },
                async exists(path: string) { return Object.prototype.hasOwnProperty.call(files, path); },
                async write(path: string, content: string) { files[path] = content; },
                async mkdir() { /* no-op */ },
            },
        },
    };
    return { app, files, touched };
}

/**
 * Pełny łańcuch: prawdziwy `ToolRegistry` + prawdziwy `PermissionSystem` + prawdziwy `MCPClient`.
 * `approvalManager` liczy pytania — odmowa na osi narzędziowej ma NIE pytać usera.
 */
function makeChain(agent: TestAgent | null, files: Record<string, string> = {}) {
    AccessGuard.setNoGoFolders([]);
    const { app, touched } = makeFakeApp(files);
    const registry = new ToolRegistry();
    registry.registerTool(createWriteTool());
    registry.registerTool(createReadTool() as never);

    const approvals: string[] = [];
    const plugin = {
        permissionSystem: new PermissionSystem(null, {}),
        approvalManager: {
            async requestApproval(action: { toolName?: string }) {
                approvals.push(String(action.toolName));
                return { result: 'approve' };
            },
        },
        agentManager: {
            getAgent: () => agent,
            getActiveAgent: () => agent,
        },
        // Bez tego `actionType` narzędzia zewnętrznego zostaje 'unknown' i odbija się o
        // fail-closed w PermissionSystem — czyli o INNĄ bramkę niż ta, której pilnujemy.
        externalMcpManager: {
            isExternalTool: (name: string) => name.includes('__'),
            getToolActionType: (name: string) => (name.includes('__') ? 'external.call' : null),
        },
    };
    const client = new MCPClient(
        app as unknown as ConstructorParameters<typeof MCPClient>[0],
        plugin as unknown as ConstructorParameters<typeof MCPClient>[1],
        registry as unknown as ConstructorParameters<typeof MCPClient>[2],
        // Podgląd diffa NIE jest przedmiotem tych testów, ale `write` po niego sięga —
        // bez wstrzykniętej atrapy klient wołałby prawdziwy modal, który poza Obsidianem
        // nigdy się nie zamknie (test wisiałby do timeoutu). Atrapa zatwierdza od ręki,
        // więc zachowanie bramek zostaje takie samo, jakie było przed atrapą `obsidian`.
        { diffModalFactory: () => ({ waitForApproval: async () => 'approve' }) },
    );
    return { client, registry, approvals, touched, app };
}

// ── AUD-security-052: disabled_tools egzekwowane przy WYWOŁANIU ────────────────

test.serial('K3: wyłączone `write` odbija się przed wykonaniem — vault nietknięty, bez modala', async t2 => {
    const agent = makeAgent({ disabled_tools: ['write'] });
    const { client, approvals, touched } = makeChain(agent);

    const out = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notes/a.md', content: 'X', mode: 'create' } },
        'Tester',
    ) as ToolCallOutcome;

    t2.true(out.isError, 'wyłączone narzędzie musi wrócić błędem');
    t2.regex(String(out.error), /Permission denied/, 'odmowa ma iść tym samym kanałem co reszta bramek');
    t2.is(approvals.length, 0, 'odmowa fail-closed NIE pyta usera');
    t2.is(touched.create, 0, 'żaden plik nie powstał');
    t2.is(touched.modify, 0, 'żaden plik nie został zmieniony');
});

test.serial('K3: alias starej nazwy (`vault_write`) NIE omija wyłączenia', async t2 => {
    const agent = makeAgent({ disabled_tools: ['write'] });
    const { client, approvals, touched } = makeChain(agent);

    const out = await client.executeToolCall(
        { name: 'vault_write', arguments: { path: 'Notes/a.md', content: 'X', mode: 'create' } },
        'Tester',
    ) as ToolCallOutcome;

    t2.true(out.isError, 'alias musi trafić w tę samą bramkę co nazwa kanoniczna');
    t2.regex(String(out.error), /Permission denied/);
    t2.is(approvals.length, 0);
    t2.is(touched.create, 0, 'alias nie może dotknąć vaulta');
});

test.serial('K3: narzędzie NIE wyłączone dalej działa (brak fałszywych alarmów)', async t2 => {
    const agent = makeAgent({ disabled_tools: ['delete'] });
    const { client, touched } = makeChain(agent);

    const out = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notes/a.md', content: 'X', mode: 'create' } },
        'Tester',
    ) as ToolCallOutcome;

    t2.falsy(out.isError, `write miał przejść, a dostał: ${out.error}`);
    t2.is(touched.create, 1, 'plik powstał');
});

test.serial('K3: `ask_user` (grupa core) jest nieusuwalny także przy egzekucji', t2 => {
    const registry = new ToolRegistry();
    const agent = makeAgent({ disabled_tools: ['ask_user'] });
    t2.true(registry.checkToolAxis(agent, 'ask_user').allowed);
});

// ── AUD-security-004: opt-in `mcp_servers[]` egzekwowany przy WYWOŁANIU ────────

/** Narzędzie serwera zewnętrznego tak, jak rejestruje je `ExternalMcpManager`. */
function makeExternalTool(calls: string[]) {
    return {
        name: 'blender__execute_code',
        description: '[blender] wykonaj kod',
        inputSchema: { type: 'object' },
        serverName: 'blender',
        source: 'user',
        async execute() { calls.push('blender__execute_code'); return { success: true }; },
    };
}

test.serial('K3: narzędzie serwera zewnętrznego BEZ opt-inu w mcp_servers = odmowa', async t2 => {
    const agent = makeAgent();                                // mcp_servers bez 'blender'
    const { client, registry, approvals } = makeChain(agent);
    const calls: string[] = [];
    registry.registerTool(makeExternalTool(calls) as never);

    const out = await client.executeToolCall(
        { name: 'blender__execute_code', arguments: { code: 'import os' } },
        'Tester',
    ) as ToolCallOutcome;

    t2.true(out.isError, 'serwer bez opt-inu nie może się wykonać');
    t2.regex(String(out.error), /Permission denied/);
    t2.is(calls.length, 0, 'narzędzie zewnętrzne nie zostało wywołane');
    t2.is(approvals.length, 0, 'brak opt-inu to odmowa, nie pytanie');
});

test.serial('K3: ten sam agent Z opt-inem przechodzi przez oś narzędziową', async t2 => {
    const agent = makeAgent({ mcp_servers: ['vault', 'memory', 'core', 'blender'] });
    const { client, registry } = makeChain(agent);
    const calls: string[] = [];
    registry.registerTool(makeExternalTool(calls) as never);

    const out = await client.executeToolCall(
        { name: 'blender__execute_code', arguments: { code: 'import os' } },
        'Tester',
    ) as ToolCallOutcome;

    t2.falsy(out.isError, `opt-in miał przepuścić, a dostał: ${out.error}`);
    t2.deepEqual(calls, ['blender__execute_code']);
});

test.serial('K3: BRAK listy mcp_servers = brak opt-inu = odmowa (fail-closed)', t2 => {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    registry.registerTool(makeExternalTool(calls) as never);

    // Profil bez pola `mcp_servers` — dawniej `'*'`, czyli przepustka na wszystkie serwery.
    const bezListy = { name: 'Goły', disabled_tools: [] };
    t2.false(registry.checkToolAxis(bezListy, 'blender__execute_code').allowed);
    t2.is(registry.checkToolAxis(bezListy, 'blender__execute_code').reason, 'server_not_opted_in');

    // Built-in w tym samym profilu dalej wolno — opt-in dotyczy TYLKO serwerów zewnętrznych.
    t2.true(registry.checkToolAxis(bezListy, 'read').allowed);
});

// ── Widoczność == egzekucja (jedna funkcja liczy oba zbiory) ──────────────────

test.serial('K3: zbiór WIDOCZNYCH narzędzi == zbiór WYKONYWALNYCH', t2 => {
    const registry = new ToolRegistry();
    registry.registerTool(createWriteTool());
    registry.registerTool(createReadTool() as never);
    registry.registerTool(makeExternalTool([]) as never);
    registry.registerTool({
        name: 'inny__tool', description: 'x', inputSchema: { type: 'object' },
        serverName: 'inny', async execute() { return {}; },
    } as never);

    const agenci = [
        makeAgent(),
        makeAgent({ disabled_tools: ['write'] }),
        makeAgent({ disabled_tools: ['write', 'read'], mcp_servers: ['blender'] }),
        makeAgent({ mcp_servers: ['*'] }),
        makeAgent({ mcp_servers: [] }),
        makeAgent({ disabled_tools: ['blender__execute_code'], mcp_servers: ['blender'] }),
    ];

    for (const agent of agenci) {
        const widoczne = registry.filterByAgent(agent).map(tool => tool.name).sort();
        const wykonywalne = registry.getAllToolNames()
            .filter(name => registry.checkToolAxis(agent, name).allowed)
            .sort();
        t2.deepEqual(wykonywalne, widoczne, `rozjazd widoczność/egzekucja dla ${JSON.stringify(agent.disabled_tools)}/${JSON.stringify(agent.mcp_servers)}`);
    }
});

test.serial('K3: bez agenta klient nie wywraca się na osi (zachowanie jak dotąd)', async t2 => {
    const { client, touched } = makeChain(null);
    const out = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notes/a.md', content: 'X', mode: 'create' } },
        null,
    ) as ToolCallOutcome;
    t2.falsy(out.isError, `bez agenta write miał przejść, a dostał: ${out.error}`);
    t2.is(touched.create, 1);
});
