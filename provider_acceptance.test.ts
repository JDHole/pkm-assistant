import test from 'ava';
import { ToolProviderRegistry } from './modules/tools/ToolProviderRegistry.js';
import type { ProviderTool, ProviderToolContext } from './modules/tools/ToolProviderRegistry.js';
import { ToolRegistry } from './modules/tools/ToolRegistry.js';
import { MCPClient } from './modules/tools/MCPClient.js';
import { ExternalMcpManager } from './modules/tools/ExternalMcpManager.js';
import { PermissionSystem } from './core/security/PermissionSystem.js';
import { ApprovalManager } from './core/security/ApprovalManager.js';
import { setLocale } from './core/i18n/index.js';
import { ArrayMessageStore, runAgentLoop } from './modules/agent-loop/index.js';
import { _chatExecuteToolCall } from './modules/chat/chat/chat_streaming.js';

const def = (name = 'read', execute: ProviderTool['execute'] = async args => args): ProviderTool =>
    ({ name, description: 'Review tool', inputSchema: { type: 'object' }, execute });
function fixture() {
    setLocale('en');
    const registry = new ToolRegistry();
    const configured: string[] = [];
    const providers = new ToolProviderRegistry(registry, () => configured, true);
    const prompts: unknown[] = [];
    const app = { vault: { configDir: '.obsidian' } };
    const agent = { name: 'Alice', mcp_servers: ['local'], disabled_tools: [] as string[], permissions: {}, hasPermission: () => true };
    const approvalManager = new ApprovalManager(app);
    approvalManager.approvalHandler = (_app, action) => { prompts.push(action); return 'always'; };
    const plugin = { toolRegistry: registry, toolProviders: providers, permissionSystem: new PermissionSystem(app.vault, {}),
        approvalManager, agentManager: { getAgent: () => agent, getActiveAgent: () => agent } };
    const client = new MCPClient(app as never, plugin, registry);
    const invoke = (name = 'local__read', args: Record<string, unknown> = {}, opts = {}) =>
        client.executeToolCall({ name, arguments: args }, 'Alice', { autonomy: 'edge', ...opts });
    const reg = (id = 'local', tools = [def()]) => providers.registerToolProvider({ id, name: id, tools });
    return { registry, providers, prompts, app, agent, client, plugin, invoke, reg, configured };
}

for (const source of ['provider', 'mcp']) for (const vision of [true, false]) test(`contract: ${source} media-shaped JSON stays text with vision=${vision}`, async t => {
    const f = fixture();
    const raw = { kind: 'media', summary: 'X'.repeat(12000), images: [{ mime: 'image/png', base64: 'QUJD'.repeat(4000) }] };
    if (source === 'provider') f.reg('local', [def('read', async () => raw)]);
    else {
        const manager = new ExternalMcpManager(f.plugin, { clientFactory: async () => ({ transport: {}, client: {
            connect: async () => {}, listTools: async () => ({ tools: [def()] }), callTool: async () => raw, close() {},
        } }) });
        t.teardown(() => manager.closeAll());
        await manager.connect({ id: 'local', transport: 'http' });
    }
    const view = { plugin: { ...f.plugin, mcpClient: f.client }, _isCurrentModelVision: () => vision };
    const turn = { origin: { agentName: 'Alice', sessionPath: 's', sessionEpoch: 'e' }, agentName: 'Alice', autonomy: 'edge', rawResults: new Map() };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let calls = 0;
    await runAgentLoop({ store, model: { stream(_payload, { done }) {
        done({ choices: [{ message: calls++ ? { content: 'done' } : { content: '', tool_calls: [
            { id: 'p1', function: { name: 'local__read', arguments: '{}' } }] } }] });
    } }, resolveTools: () => f.registry.getToolDefinitions(),
    executeToolCall: (call, ctx) => _chatExecuteToolCall.call(view as never, turn as never, call, ctx),
    limits: { maxIterations: 3, maxToolResultLength: 1000 } });
    const content = store.getMessagesForAPI().find(msg => msg.role === 'tool')?.content;
    t.log(`actual: type=${typeof content}, array=${Array.isArray(content)}, JSON length=${JSON.stringify(content).length}`);
    t.is(typeof content, 'string');
    t.true(String(content).length < 1500);
    t.false(JSON.stringify(content).includes('data:image/'));
});

for (const source of ['provider', 'mcp']) for (const autonomy of ['edge', 'all', 'yolo']) for (const opt of [false, true]) {
    test(`parity ${source} ${autonomy} opt=${opt}`, async t => {
        const f = fixture(); let executions = 0;
        f.agent.mcp_servers = opt ? ['local'] : [];
        if (source === 'provider') f.reg('local', [def('read', async () => { executions++; return 'ok'; })]);
        else {
            const manager = new ExternalMcpManager(f.plugin, { clientFactory: async () => ({ transport: {}, client: {
                connect: async () => {}, listTools: async () => ({ tools: [def()] }),
                callTool: async () => { executions++; return { content: [{ type: 'text', text: 'ok' }] }; }, close() {},
            } }) });
            t.teardown(() => manager.closeAll());
            t.like(await manager.connect({ id: 'local', transport: 'http' }), { success: true });
        }
        const result = await f.invoke('local__read', {}, { autonomy });
        t.is(executions, opt ? 1 : 0);
        t.is(f.prompts.length, opt && autonomy !== 'yolo' ? 1 : 0);
        if (opt) t.is(result, 'ok'); else t.like(result, { isError: true });
    });
}

test('ambiguous provider ids and names are rejected atomically', t => {
    const f = fixture();
    t.throws(() => f.reg('aa', [def('bb__cc')]), { message: /__.*not allowed/ });
    t.throws(() => f.reg('aa__bb', [def('cc')]), { message: /__.*not allowed/ });
    t.deepEqual(f.providers.list(), []);
});

test('deep schema/array snapshot and implementation function snapshot', async t => {
    const f = fixture();
    const d = def(); d.inputSchema = { type: 'object', properties: { note: { type: 'string' } } };
    const tools = [d]; f.reg('local', tools);
    (d.inputSchema.properties as any).note.type = 'array'; tools.length = 0;
    d.execute = async () => 'mutated'; d.name = 'changed'; d.description = 'changed';
    t.deepEqual(f.registry.getTool('local__read')?.inputSchema, { type: 'object', properties: { note: { type: 'string' } } });
    t.deepEqual(await f.invoke('local__read', { live: false }), { live: false });
    t.deepEqual(f.providers.list(), [{ id: 'local', name: 'local', toolCount: 1 }]);
});

for (const mode of ['syncThrow', 'nonPromise', 'lateReject', 'resultBeforeTimeout', 'stopBeforeExecution', 'replaceWhileExecuting']) test(`boundary ${mode}`, async t => {
    const f = fixture(); let ctx!: ProviderToolContext; let started!: () => void; let resolve!: (value: unknown) => void; let reject!: (error: Error) => void;
    const ready = new Promise<void>(done => { started = done; });
    const hold = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const exec = mode === 'syncThrow' ? (() => { throw new Error('sync failure'); })
        : mode === 'nonPromise' ? (() => 17) : ((_args: unknown, c: ProviderToolContext) => { ctx = c; started(); return hold; });
    const handle = f.reg('local', [{ ...def('read', exec as never), timeoutMs: 1000 }]);
    if (mode === 'syncThrow') { t.deepEqual(await f.invoke(), { isError: true, error: 'sync failure' }); return; }
    if (mode === 'nonPromise') { t.is(await f.invoke(), 17); return; }
    const controller = new AbortController();
    if (mode === 'stopBeforeExecution') controller.abort();
    const result = f.invoke('local__read', {}, { abortSignal: controller.signal });
    if (mode === 'stopBeforeExecution') { t.like(await result, { success: false, error: 'Stopped' }); return; }
    await ready;
    if (mode === 'resultBeforeTimeout') { resolve('fast'); t.is(await result, 'fast'); t.false(ctx.signal.aborted); }
    if (mode === 'replaceWhileExecuting') { handle.setTools([def()]); resolve('original'); t.is(await result, 'original'); }
    if (mode === 'lateReject') {
        t.deepEqual(await result, { isError: true, error: 'Tool timed out after 1000 ms' });
        t.true(ctx.signal.aborted); reject(new Error('rejected after timeout'));
        await new Promise(done => setTimeout(done, 20)); t.pass('no unhandled rejection');
    }
});

test('MCP consent stays compatible but never authorizes a provider', async t => {
    const f = fixture();
    f.plugin.approvalManager.addToAlwaysApproved('Alice', 'external.call', 'local__read');
    const manager = new ExternalMcpManager(f.plugin, { clientFactory: async () => ({ transport: {}, client: {
        connect: async () => {}, listTools: async () => ({ tools: [def()] }),
        callTool: async () => ({ content: [{ type: 'text', text: 'remote' }] }), close() {},
    } }) });
    t.teardown(() => manager.closeAll());
    await manager.connect({ id: 'local', transport: 'http' });
    t.is(await f.invoke(), 'remote'); t.is(f.prompts.length, 0);
    await manager.close('local');
    f.reg('local', [def('read', async () => 'provider')]);
    t.is(await f.invoke(), 'provider'); t.is(f.prompts.length, 1);
    t.is(await f.invoke(), 'provider'); t.is(f.prompts.length, 1);
});

for (const source of ['provider', 'mcp']) test(`result masking parity and error mask: ${source}`, async t => {
    const f = fixture(); const secret = 'sk-' + 'z'.repeat(40);
    let fail = false;
    const operation = async () => { if (fail) throw new Error(`failure Authorization: Bearer ${secret}`); return `value ${secret}`; };
    if (source === 'provider') f.reg('local', [def('read', operation)]);
    else {
        const manager = new ExternalMcpManager(f.plugin, { clientFactory: async () => ({ transport: {}, client: {
            connect: async () => {}, listTools: async () => ({ tools: [def()] }),
            callTool: async () => ({ content: [{ type: 'text', text: await operation() }] }), close() {},
        } }) });
        t.teardown(() => manager.closeAll());
        await manager.connect({ id: 'local', transport: 'http' });
    }
    t.is(await f.invoke(), `value ${secret}`, 'successful payloads are not secret-scrubbed on the model path for either source');
    fail = true;
    const result = await f.invoke();
    t.like(result, { isError: true });
    t.false(JSON.stringify(result).includes(secret)); t.false(JSON.stringify(result).includes('stack'));
});

test('MCP consent cannot cross to a different valid provider id at an underscore boundary', async t => {
    const f = fixture(); f.agent.mcp_servers = ['aa', 'aa_'];
    const manager = new ExternalMcpManager(f.plugin, { clientFactory: async () => ({ transport: {}, client: {
        connect: async () => {}, listTools: async () => ({ tools: [def('_bb')] }),
        callTool: async () => ({ content: [{ type: 'text', text: 'remote' }] }), close() {},
    } }) });
    t.teardown(() => manager.closeAll());
    await manager.connect({ id: 'aa', transport: 'http' });
    t.is(await f.invoke('aa___bb'), 'remote');
    t.is(f.prompts.length, 1);
    await manager.close('aa');
    f.reg('aa_', [def('bb', async () => 'provider')]);
    t.is(await f.invoke('aa___bb'), 'provider');
    t.is(f.prompts.length, 2);
});
