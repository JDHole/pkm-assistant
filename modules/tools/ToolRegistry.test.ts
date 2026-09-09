import test from 'ava';
import { ToolRegistry } from './ToolRegistry.js';
import type { ToolDefinition } from './ToolRegistry.js';

function makeTool(name: string, serverName?: string) {
    return {
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object' },
        execute: async () => ({ success: true }),
        ...(serverName ? { serverName } : {})
    };
}

function seedRegistry(registry: ToolRegistry) {
    // Built-in tools (across several logical servers)
    registry.registerTool(makeTool('ask_user'));   // core
    registry.registerTool(makeTool('read'));        // vault
    registry.registerTool(makeTool('write'));       // vault
    registry.registerTool(makeTool('memory_save')); // memory
    registry.registerTool(makeTool('web_search'));  // web
    registry.registerTool(makeTool('generate_image')); // multimodal
    registry.registerTool(makeTool('delegate'));    // delegation
    registry.registerTool(makeTool('chat_todo'));   // artifacts
    // User MCP server tool
    registry.registerTool(makeTool('my_user_tool', 'finance-tracker'));
}

test('filterByAgent: negatywna lista — brak disabled_tools = wszystkie built-in ON', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    // Agent bez user-serwerów (mcp_servers domyślne) — built-in wszystkie widoczne.
    const agent = { name: 'Fresh', disabled_tools: [], mcp_servers: [] };
    const names = r.filterByAgent(agent).map(t => t.name).sort();
    t.deepEqual(names, ['ask_user', 'chat_todo', 'delegate', 'generate_image', 'memory_save', 'read', 'web_search', 'write']);
});

test('filterByAgent: disabled_tools wyłącza konkretne narzędzia built-in', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    const agent = { name: 'Tola', disabled_tools: ['web_search', 'delegate', 'generate_image'], mcp_servers: [] };
    const names = r.filterByAgent(agent).map(t => t.name).sort();
    t.false(names.includes('web_search'));
    t.false(names.includes('delegate'));
    t.false(names.includes('generate_image'));
    t.true(names.includes('read'));
    t.true(names.includes('write'));
    t.true(names.includes('memory_save'));
});

test('filterByAgent: core (ask_user) ZAWSZE ON, nawet gdy w disabled_tools', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    const agent = { name: 'Weird', disabled_tools: ['ask_user', 'read'], mcp_servers: [] };
    const names = r.filterByAgent(agent).map(t => t.name).sort();
    t.true(names.includes('ask_user'), 'ask_user nieusuwalny');
    t.false(names.includes('read'));
});

test('filterByAgent: null agent → nic nie wyłączone (wszystkie tools)', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    const names = r.filterByAgent(null).map(t => t.name).sort();
    t.is(names.length, 9); // 8 built-in + 1 user tool (userServers '*' dla null)
});

test('filterByAgent: user MCP server tool gated pozytywną listą mcp_servers (opt-in)', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    const withServer = { name: 'Igor', disabled_tools: [], mcp_servers: ['finance-tracker'] };
    t.true(r.filterByAgent(withServer).map(t => t.name).includes('my_user_tool'));

    const withoutServer = { name: 'Other', disabled_tools: [], mcp_servers: ['vault'] };
    t.false(r.filterByAgent(withoutServer).map(t => t.name).includes('my_user_tool'));
});

test('filterByAgent: mcp_servers=[*] pokazuje wszystkie user-serwery; disabled_tools dalej działa', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    const agent = { name: 'Admin', disabled_tools: ['my_user_tool'], mcp_servers: ['*'] };
    const names = r.filterByAgent(agent).map(t => t.name);
    t.false(names.includes('my_user_tool'), 'disabled_tools wyłącza także user-tool');
    t.true(names.includes('web_search'));
});

test('filterByAgent: effective_mcp_servers to lustro mcp_servers dla user-connectorów', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    const agent = {
        name: 'Mirror',
        disabled_tools: [],
        mcp_servers: ['vault'],
        effective_mcp_servers: ['finance-tracker'],
    };
    t.true(r.filterByAgent(agent).map(t => t.name).includes('my_user_tool'));
});

test('getBuiltinServerForTool: maps tool to built-in server', t => {
    const r = new ToolRegistry();
    t.is(r.getBuiltinServerForTool('read'), 'vault');
    t.is(r.getBuiltinServerForTool('memory_save'), 'memory');
    t.is(r.getBuiltinServerForTool('web_search'), 'web');
    t.is(r.getBuiltinServerForTool('ask_user'), 'core');
    t.is(r.getBuiltinServerForTool('todo'), 'artifacts');
    t.is(r.getBuiltinServerForTool('artifact_create'), 'artifacts');
    t.is(r.getBuiltinServerForTool('nonexistent_tool'), null);
});

test('getBuiltinServerMap: returns the full map with all expected servers', t => {
    const r = new ToolRegistry();
    const map = r.getBuiltinServerMap();
    t.deepEqual(Object.keys(map).sort(), ['artifacts', 'core', 'delegation', 'komunikator', 'memory', 'multimodal', 'vault', 'web']);
    t.true(map.vault.includes('read'));
    t.true(map.vault.includes('search')); // unified search lives in vault server
    t.true(map.memory.includes('memory_save'));
    t.deepEqual(map.komunikator, ['kom_send', 'kom_list', 'kom_read']);
});

test('registerTool: validates required fields', t => {
    const r = new ToolRegistry();
    // Wejścia-śmieci (niepełne definicje) — dokładnie to, czego broni `registerTool`.
    t.throws(() => r.registerTool({} as unknown as ToolDefinition), { message: /Invalid tool definition/ });
    t.throws(() => r.registerTool({ name: 'x' } as unknown as ToolDefinition), { message: /Invalid tool definition/ });
});

test('getTool: returns null for unknown tool', t => {
    const r = new ToolRegistry();
    t.is(r.getTool('nonexistent'), null);
});

test('getToolDefinitions: returns OpenAI-format definitions', t => {
    const r = new ToolRegistry();
    seedRegistry(r);
    const defs = r.getToolDefinitions();
    t.is(defs.length, 9);
    t.is(defs[0].type, 'function');
    t.truthy(defs[0].function.name);
    t.truthy(defs[0].function.parameters);
});

// public unregisterTool (external MCP servers no longer touch the private tools Map)
test('unregisterTool: removes a tool, returns true, then false (idempotent)', t => {
    const r = new ToolRegistry();
    r.registerTool(makeTool('external__render', 'external'));
    t.truthy(r.getTool('external__render'));
    t.true(r.unregisterTool('external__render'), 'first removal returns true');
    t.is(r.getTool('external__render'), null, 'tool gone from registry');
    t.false(r.unregisterTool('external__render'), 'second removal returns false (idempotent)');
    t.false(r.unregisterTool('never_existed'));
});
