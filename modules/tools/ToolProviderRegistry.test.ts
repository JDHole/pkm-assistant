import test from 'ava';
import { mock } from 'node:test';
import { ToolProviderRegistry } from './ToolProviderRegistry.js';
import { ToolRegistry } from './ToolRegistry.js';
import type { ProviderTool, ProviderToolContext, ToolProviderRegistration } from './ToolProviderRegistry.js';
import { MCPClient } from './MCPClient.js';
import { ExternalMcpManager } from './ExternalMcpManager.js';
import { PermissionSystem } from '../../core/security/PermissionSystem.js';
import { ApprovalManager } from '../../core/security/ApprovalManager.js';
import type { ApprovalAction } from '../../core/security/ApprovalManager.js';
import { classifyToolRisk } from '../../core/security/autonomy.js';
import { ApprovalModal } from '../shell/ApprovalModal.js';
import { SubAgentRunner } from '../sub-agents/index.js';
import { ArrayMessageStore, runAgentLoop } from '../agent-loop/index.js';
import { setLocale } from '../../core/i18n/index.js';

test.beforeEach(() => setLocale('en'));
const tool = (name = 'read'): ProviderTool => ({
    name, description: 'Test tool', inputSchema: { type: 'object' }, execute: async args => args,
});
const registration = (tools = [tool()]): ToolProviderRegistration => ({ id: 'local', name: 'Local', tools });
function fixture(mobile = true) {
    const registry = new ToolRegistry();
    const configured = ['remote'];
    const providers = new ToolProviderRegistry(registry, () => configured, mobile);
    const approvals: ApprovalAction[] = [];
    const app = { vault: { configDir: '.obsidian' } };
    const agent = { name: 'Alice', mcp_servers: ['local'], disabled_tools: [] as string[], permissions: {}, hasPermission: () => true };
    const approvalManager = new ApprovalManager(app);
    approvalManager.approvalHandler = (_app, action) => { approvals.push(action); return 'always'; };
    const plugin = {
        toolRegistry: registry, toolProviders: providers,
        permissionSystem: new PermissionSystem(app.vault, {}), approvalManager,
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
    };
    const client = new MCPClient(app as never, plugin, registry);
    const invoke = (name = 'local__read', args: Record<string, unknown> = {}, opts: Parameters<MCPClient['executeToolCall']>[2] = {}) =>
        client.executeToolCall({ name, arguments: args }, 'Alice', { autonomy: 'edge', ...opts });
    return { registry, providers, configured, approvals, agent, plugin, client, invoke, app };
}

test('atomic registration/setTools, duplicate/builtin/configured IDs, opt-in and stale handles', async t => {
    const f = fixture();
    for (const id of ['remote', 'vault']) t.throws(() => f.providers.registerToolProvider({ ...registration(), id }), { message: /already in use/ });
    t.throws(() => f.providers.registerToolProvider(registration([tool(), tool()])), { message: /duplicate/ });
    const handle = f.providers.registerToolProvider(registration());
    t.throws(() => f.providers.registerToolProvider(registration([])), { message: /already in use/ });
    t.deepEqual(f.providers.list(), [{ id: 'local', name: 'Local', toolCount: 1 }]);
    t.deepEqual(f.registry.filterByAgent(f.agent).map(item => item.name), ['local__read']);
    f.agent.mcp_servers = [];
    t.deepEqual(f.registry.filterByAgent(f.agent), []);
    t.like(await f.invoke(), { isError: true });
    t.is(f.approvals.length, 0);
    f.agent.mcp_servers = ['local'];
    t.deepEqual(await f.invoke('local__read', { accepted: 1 }), { accepted: 1 });
    t.throws(() => handle.setTools([tool('write'), tool('bad-name')]), { message: /Invalid/ });
    t.deepEqual(f.registry.getAllToolNames(), ['local__read']);
    const stale = f.registry.getTool('local__read')!;
    handle.setTools([tool('write')]);
    t.deepEqual(f.registry.getAllToolNames(), ['local__write']);
    t.like(await stale.executeProvider!({}, 'Alice'), { isError: true, error: 'This plugin tool is no longer available.' });
    t.deepEqual(await f.invoke('local__write', { replacement: true }), { replacement: true });
    handle.unregister(); handle.unregister(); handle.setTools([tool('invalid-name')]);
    const replacement = f.providers.registerToolProvider(registration());
    handle.unregister();
    t.deepEqual(await f.invoke('local__read', { newOwner: true }), { newOwner: true });
    f.providers.dispose(); f.providers.dispose();
    replacement.setTools([tool('invalid-name')]); replacement.unregister();
    t.deepEqual(f.providers.list(), []);
    t.like(await f.invoke(), { isError: true });
    t.throws(() => f.providers.registerToolProvider(registration()), { message: 'Provider registry is unloaded' });
});

for (const [label, patch] of Object.entries({
    'short id': { id: 'a' }, 'long id': { id: 'a'.repeat(33) }, 'newline id': { id: 'local\n' },
    'punctuation id': { id: 'bad-id' }, 'empty label': { name: '' }, 'long label': { name: 'x'.repeat(61) },
    'long description': { description: 'x'.repeat(301) }, 'too many tools': { tools: Array.from({ length: 65 }, (_, n) => tool(`tool${n}`)) },
    'non-array tools': { tools: {} }, 'sparse tools': { tools: new Array(2) },
})) test(`registration rejects ${label} without publishing partial tools`, t => {
    const f = fixture();
    t.throws(() => f.providers.registerToolProvider({ ...registration(), ...patch } as ToolProviderRegistration), { instanceOf: Error });
    t.deepEqual(f.providers.list(), []);
    f.providers.registerToolProvider(registration());
    t.deepEqual(f.registry.getAllToolNames(), ['local__read']);
});
for (const [label, patch] of Object.entries({
    'short name': { name: 'a' }, 'long name': { name: 'a'.repeat(49) }, 'newline name': { name: 'read\n' },
    'missing description': { description: '' }, 'long description': { description: 'a'.repeat(2001) },
    'schema type': { inputSchema: { type: 'array' } }, 'null schema': { inputSchema: null },
    'schema toJSON changes type': { inputSchema: { type: 'object', toJSON: () => ({ type: 'array' }) } },
    'non-JSON schema': { inputSchema: { type: 'object', extra: () => 1 } },
    'short timeout': { timeoutMs: 999 }, 'long timeout': { timeoutMs: 120001 },
    'NaN timeout': { timeoutMs: NaN }, 'fractional timeout': { timeoutMs: 1000.5 }, 'non-function execute': { execute: null },
})) test(`setTools rejects ${label} and preserves the working definition`, async t => {
    const f = fixture(); const handle = f.providers.registerToolProvider(registration());
    t.throws(() => handle.setTools([tool('valid'), { ...tool(), ...patch } as ProviderTool]), { instanceOf: Error });
    t.deepEqual(f.registry.getAllToolNames(), ['local__read']);
    t.deepEqual(await f.invoke('local__read', { retained: true }), { retained: true });
});

test('zero and 64 tools, boundary lengths/timeouts, and copied schemas', t => {
    const f = fixture(); const handle = f.providers.registerToolProvider({ id: 'a'.repeat(32), name: 'x'.repeat(60), description: 'd'.repeat(300), tools: [] });
    const tools = Array.from({ length: 64 }, (_, n) => ({ ...tool(`tool${n}`), timeoutMs: n ? 1000 : 120000 }));
    tools[0].name = 't'.repeat(48); tools[0].description = 'd'.repeat(2000);
    handle.setTools(tools);
    tools[0].inputSchema.type = 'array';
    t.is(f.registry.getAllTools().length, 64);
    t.deepEqual(f.registry.getAllTools()[0].inputSchema, { type: 'object' });
});

test('no MCP manager: RED, full modal arguments, exact per-tool consent and only public context', async t => {
    const f = fixture(); let received: unknown;
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async (args, context) => {
        received = { args, keys: Object.keys(context).sort(), agent: context.agentName, mobile: context.isMobile, aborted: context.signal.aborted };
        return { ok: true };
    } }, tool('write')]));
    t.is(classifyToolRisk({ toolName: 'local__read', action: 'external.call', isExternalTool: true }), 'red');
    const args = { path: '../external-target', nested: { text: 'full argument'.repeat(500) }, _invocationAgentName: 'forged' };
    t.deepEqual(await f.invoke('local__read', args), { ok: true });
    t.deepEqual(received, { args: { path: args.path, nested: args.nested }, keys: ['agentName', 'isMobile', 'signal'], agent: 'Alice', mobile: true, aborted: false });
    t.like(f.approvals[0], { type: 'external.call', approvalTarget: 'local__read', targetPath: '', externalServer: 'local', externalArgs: { path: args.path, nested: args.nested } });
    t.deepEqual(f.plugin.approvalManager.getAlwaysApprovedRules('Alice'), ['external.call::local__read']);
    const modal = new ApprovalModal(f.app as never, f.approvals[0]);
    modal.onOpen();
    const text = (node: HTMLElement): string => [node.textContent ?? '', ...Array.from(node.children).map(child => text(child as HTMLElement))].join('\n');
    t.true(text(modal.contentEl).includes('full argument'.repeat(500)));
    modal.onClose();
    await f.invoke(); t.is(f.approvals.length, 1);
    await f.invoke('local__write'); t.is(f.approvals.length, 2);
});

test('denied approval and Stop while approval is pending never execute provider code', async t => {
    const f = fixture(); let calls = 0;
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async () => { calls++; return 'executed'; } }]));
    f.plugin.approvalManager.approvalHandler = () => 'deny';
    t.like(await f.invoke(), { isError: true }); t.is(calls, 0);
    f.client.clearDenials();
    const stop = new AbortController();
    f.plugin.approvalManager.approvalHandler = () => { stop.abort(); return 'approve'; };
    t.like(await f.invoke('local__read', {}, { abortSignal: stop.signal, shouldAbort: () => stop.signal.aborted }), { success: false });
    t.is(calls, 0);
});

for (const mode of ['timeout', 'stop', 'unregister', 'unload']) test(`${mode} settles a non-cooperative provider and aborts its signal`, async t => {
    const f = fixture(); let context!: ProviderToolContext; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const handle = f.providers.registerToolProvider(registration([{ ...tool(), timeoutMs: 1000, execute: async (_args, ctx) => {
        context = ctx; started(); return new Promise(() => {});
    } }]));
    const stop = new AbortController();
    const pending = f.invoke('local__read', {}, { abortSignal: stop.signal });
    await ready;
    if (mode === 'stop') stop.abort();
    if (mode === 'unregister') handle.unregister();
    if (mode === 'unload') f.providers.dispose();
    const result = await pending;
    t.true(context.signal.aborted);
    t.deepEqual(result, mode === 'timeout' ? { isError: true, error: 'Tool timed out after 1000 ms' }
        : mode === 'stop' ? { success: false, error: 'Stopped' } : { isError: true, error: 'Stopped' });
});

test('exceptions are masked without stacks and invalid JSON results reach the model as errors', async t => {
    const f = fixture(); const handle = f.providers.registerToolProvider(registration());
    const secret = 'sk-' + 'a'.repeat(40);
    handle.setTools([{ ...tool(), execute: async () => { throw new Error(`failure ${secret}`); } }]);
    const result = await f.invoke();
    t.like(result, { isError: true });
    t.false(JSON.stringify(result).includes(secret));
    t.false(JSON.stringify(result).includes('stack'));
    for (const bad of [undefined, 1n, { self: undefined }, { fn: () => 1 }, NaN]) {
        handle.setTools([{ ...tool(), execute: async () => bad }]);
        t.like(await f.invoke(), { isError: true });
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    handle.setTools([{ ...tool(), execute: async () => cycle }]);
    t.like(await f.invoke(), { isError: true });
    handle.setTools([{ ...tool(), execute: async () => ({ value: [null, 1, true, 'yes'] }) }]);
    t.deepEqual(await f.invoke(), { value: [null, 1, true, 'yes'] });
});

for (const duringHandshake of [false, true]) test(`later MCP collision cannot replace provider (handshake=${duringHandshake})`, async t => {
    const f = fixture(); let handshakes = 0; let closes = 0;
    let release!: () => void; let start!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { start = resolve; });
    const manager = new ExternalMcpManager(f.plugin, { clientFactory: async () => ({ transport: {}, client: {
        connect: async () => { handshakes++; start(); if (duringHandshake) await waiting; },
        listTools: async () => ({ tools: [tool()] }), callTool: async () => ({ content: [] }), close: () => { closes++; },
    } }) });
    if (!duringHandshake) f.providers.registerToolProvider(registration());
    const connecting = manager.connect({ id: 'local', transport: 'http' });
    if (duringHandshake) { await started; f.providers.registerToolProvider(registration()); release(); }
    t.like(await connecting, { success: false, error: 'The ID "local" is already used by a plugin tool provider.' });
    t.is(handshakes, duringHandshake ? 1 : 0); t.is(closes, duringHandshake ? 1 : 0);
    t.deepEqual(await f.invoke('local__read', { owner: 'provider' }), { owner: 'provider' });
    await manager.closeAll();
    t.deepEqual(f.registry.getAllToolNames(), ['local__read']);
});

test('ambiguous double-underscore names never overwrite an existing tool', t => {
    const f = fixture(); f.providers.registerToolProvider({ id: 'local__nested', name: 'One', tools: [tool()] });
    t.throws(() => f.providers.registerToolProvider(registration([tool('nested__read')])), { message: /already registered/ });
    t.deepEqual(f.providers.list(), [{ id: 'local__nested', name: 'One', toolCount: 1 }]);
});

// Exercise the production sub executor: its whitelist, MCP permissions, context and transcript.
test('sub-agent inherits opt-in and whitelist, receives the owning profile and Stop signal', async t => {
    const f = fixture(); let received: ProviderToolContext | undefined;
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async (_args, context) => { received = context; return { sub: 'worked' }; } }]));
    const runner = new SubAgentRunner({ toolRegistry: f.registry, app: f.app, plugin: { ...f.plugin, mcpClient: f.client } });
    t.deepEqual(runner._getTools(['local__read'], f.agent).map(item => item.function.name), ['local__read', 'ask_parent']);
    const stop = new AbortController();
    const result = await runner._executeTool({ name: 'local__read', arguments: '{}' }, 'Alice', new Set(['local__read']),
        { delegationDepth: 1 }, undefined, { resultBudgetChars: 1000, shouldAbort: () => false, abortSignal: stop.signal });
    t.is(result, '{"sub":"worked"}');
    t.is(received?.agentName, 'Alice');
    t.deepEqual(Object.keys(received!).sort(), ['agentName', 'isMobile', 'signal']);
    f.agent.mcp_servers = [];
    t.deepEqual(runner._getTools(['local__read'], f.agent).map(item => item.function.name), ['ask_parent']);
    t.true(String(await runner._executeTool({ name: 'local__read', arguments: '{}' }, 'Alice', new Set(['local__read']), { delegationDepth: 1 })).includes('local'));
    f.agent.mcp_servers = ['local'];
    const denied = await runner._executeTool({ name: 'local__read', arguments: '{}' }, 'Alice', new Set());
    t.true(String(denied).includes('local__read'));
    t.is(f.approvals.length, 1);
});

for (const array of [false, true]) test(`provider JSON ${array ? 'array' : 'object'} uses the AgentLoop budget`, async t => {
    const f = fixture();
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async () => array ? [{ payload: 'x'.repeat(4000) }] : ({ payload: 'x'.repeat(4000) }) }]));
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]); let calls = 0;
    const result = await runAgentLoop({ store, model: { stream: (_payload, { done }) => {
        const message = calls++ ? { content: 'done' } : { content: '', tool_calls: [{ id: 'p1', function: { name: 'local__read', arguments: '{}' } }] };
        done({ choices: [{ message }] });
    } }, resolveTools: () => f.registry.getToolDefinitions(), executeToolCall: (call, context) => f.client.executeToolCall({ ...call, name: call.name! }, 'Alice', context),
    limits: { maxIterations: 3, maxToolResultLength: 1000 } });
    t.is(result.finalText, 'done');
    const content = store.getMessagesForAPI().find(message => message.role === 'tool')?.content;
    t.is(typeof content, 'string');
    t.true(String(content).startsWith(array ? '[{"payload":"' : '{"payload":"'));
    t.true(String(content).length < 1500);
    t.true(String(content).includes('truncat'));
});

for (const optedIn of [false, true]) test(`full sub-agent loop enforces provider opt-in (${optedIn})`, async t => {
    const f = fixture(); let executions = 0; let received: unknown;
    if (!optedIn) f.agent.mcp_servers = [];
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async (_args, context) => {
        executions++; received = { name: context.agentName, keys: Object.keys(context).sort() }; return { from: 'provider' };
    } }]));
    const runner = new SubAgentRunner({ toolRegistry: f.registry, app: f.app, plugin: { ...f.plugin, mcpClient: f.client }, isMobile: true });
    let calls = 0;
    const payloads: Array<{ tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content: unknown }> }> = [];
    const output = await runner.runTask('Call the local tool', f.agent, {
        name: 'child', description: 'Test child', role: 'worker', tools: ['local__read'], model: null,
        enabled: true, prompt: 'Use tools.', scope: null, min_iterations: 1, max_iterations: 4, max_tool_result_length: 1000,
    }, { stream(payload: typeof payloads[number], { done }: { done(value: unknown): void }) {
        payloads.push(payload);
        done({ choices: [{ message: calls++ ? { role: 'assistant', content: 'Child finished' }
            : { role: 'assistant', content: '', tool_calls: [{ id: 'sub1', function: { name: 'local__read', arguments: '{}' } }] } }] });
    } } as never, { autonomy: 'edge', delegationDepth: 1 });
    t.is(output.result, 'Child finished');
    t.deepEqual(payloads[0].tools?.map(tool => tool.function.name), optedIn ? ['local__read', 'ask_parent'] : ['ask_parent']);
    t.is(executions, optedIn ? 1 : 0);
    if (optedIn) {
        t.deepEqual(received, { name: 'Alice', keys: ['agentName', 'isMobile', 'signal'] });
        t.true(JSON.stringify(payloads[1].messages).includes('provider'));
        t.deepEqual(f.plugin.approvalManager.getAlwaysApprovedRules('Alice'), ['external.call::local__read']);
    } else {
        t.is(f.approvals.length, 0);
        t.true(JSON.stringify(payloads[1].messages).includes('local__read'));
    }
});

test('a provider removed while approval is pending cannot execute after approval', async t => {
    const f = fixture(); let executions = 0; let approve!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const consent = new Promise<void>(resolve => { approve = resolve; });
    const handle = f.providers.registerToolProvider(registration([{ ...tool(), execute: async () => { executions++; return 'called'; } }]));
    f.plugin.approvalManager.approvalHandler = async () => { entered(); await consent; return 'approve'; };
    const pending = f.invoke(); await waiting; handle.unregister(); approve();
    t.deepEqual(await pending, { isError: true, error: 'This plugin tool is no longer available.' });
    t.is(executions, 0);
});

test('completed calls are removed from unload cancellation', async t => {
    const f = fixture(); let signal!: AbortSignal;
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async (_args, context) => { signal = context.signal; return 42; } }]));
    t.is(await f.invoke(), 42);
    t.false(signal.aborted);
    f.providers.dispose();
    t.false(signal.aborted, 'completed calls are no longer active or aborted on unload');
});


test.serial('omitted timeout expires at 30000 ms and aborts the provider', async t => {
    mock.timers.enable({ apis: ['setTimeout'] });
    t.teardown(() => mock.timers.reset());
    const f = fixture(); let signal!: AbortSignal; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async (_args, context) => {
        signal = context.signal; entered(); return new Promise(() => {});
    } }]));
    let settled = false;
    const pending = f.invoke().then(result => { settled = true; return result; });
    await ready;
    mock.timers.tick(29999); await Promise.resolve();
    t.false(settled); t.false(signal.aborted);
    mock.timers.tick(1);
    t.deepEqual(await pending, { isError: true, error: 'Tool timed out after 30000 ms' });
    t.true(signal.aborted);
});

test('draft sub-agent execution refuses providers through the shared external-tool gate', async t => {
    const f = fixture(); let executions = 0;
    f.providers.registerToolProvider(registration([{ ...tool(), execute: async () => { executions++; return 'side effect'; } }]));
    t.like(await f.invoke('local__read', {}, { delegationDepth: 1,
        vaultExecution: { kind: 'overlay-read', view: {} } as never }), { isError: true, code: 'mutation-denied' });
    t.is(executions, 0); t.is(f.approvals.length, 0);
    t.deepEqual(await f.invoke(), 'side effect');
    t.is(executions, 1);
});
