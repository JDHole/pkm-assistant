import test from 'ava';
import { ServerManager } from './ServerManager.js';
import { ToolRegistry } from './ToolRegistry.js';
import { Agent } from '../agents/Agent.js';
import type { LoadedServerConfig } from './ServerLoader.js';

function makeTool(name: string) {
    return {
        name,
        description: `${name} description`,
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ success: true }),
    };
}

function makeManager() {
    const toolRegistry = new ToolRegistry();
    const plugin = {
        manifest: { version: 'test' },
        toolRegistry,
        agentManager: {
            getActiveAgent: () => ({ name: 'Jaskier' }),
        },
    };
    const app = {
        vault: {
            adapter: {
                exists: async () => false,
            },
        },
    };
    return { manager: new ServerManager(app, plugin), toolRegistry };
}

function seedBuiltinServers(manager: ServerManager) {
    // Ziarno celowo NIEPEŁNE (bez version/timeout_ms/…) — test sprawdza rozwiązywanie nazw
    // narzędzi, nie kształt manifestu; stąd rzutowanie zamiast dopisywania martwych pól.
    manager.serverLoader.cache.set('core', {
        name: 'core',
        source: 'built-in',
        removable: false,
        description: 'Core',
        icon: 'circle',
        tools: ['ask_user'],
        paths: [],
        knowledge: '',
    } as unknown as LoadedServerConfig);
    manager.serverLoader.cache.set('web', {
        name: 'web',
        source: 'built-in',
        removable: false,
        description: 'Web',
        icon: 'globe',
        tools: ['web_search', 'web_read'],
        paths: [],
        knowledge: '',
    } as unknown as LoadedServerConfig);
}

test('connectServer resolves built-in manifest tool names via ToolRegistry', t => {
    const { manager, toolRegistry } = makeManager();
    seedBuiltinServers(manager);
    toolRegistry.registerTool(makeTool('web_search'));
    toolRegistry.registerTool(makeTool('web_read'));

    const result = manager.connectServer('web');

    t.true(result.success);
    t.deepEqual(result.tools, ['web_search', 'web_read']);
    t.true(manager.isConnected('web'));

    const defs = manager.getActiveToolDefinitions(['web']);
    t.is(defs.length, 2);
    t.deepEqual(defs.map(d => d.function.name).sort(), ['web_read', 'web_search']);
});

test('disconnectServer keeps built-in tools registered in ToolRegistry', t => {
    const { manager, toolRegistry } = makeManager();
    seedBuiltinServers(manager);
    const webSearch = makeTool('web_search');
    toolRegistry.registerTool(webSearch);
    toolRegistry.registerTool(makeTool('web_read'));

    manager.connectServer('web');
    manager.disconnectServer('web');

    t.false(manager.isConnected('web'));
    t.is(toolRegistry.getTool('web_search'), webSearch);
});

test('connectBuiltInServersForAgent auto-connects whitelist built-ins plus core', t => {
    const { manager, toolRegistry } = makeManager();
    seedBuiltinServers(manager);
    toolRegistry.registerTool(makeTool('ask_user'));
    toolRegistry.registerTool(makeTool('web_search'));
    toolRegistry.registerTool(makeTool('web_read'));

    const result = manager.connectBuiltInServersForAgent({
        name: 'Jaskier',
        mcp_servers: ['web'],
    });

    t.deepEqual(result.errors, []);
    t.deepEqual(result.connected.sort(), ['core', 'web']);
    t.deepEqual(manager.getActiveServerNames().sort(), ['core', 'web']);
});

test('getAllowedServerNamesForAgent respects wildcard and server list despite legacy MCP flag', t => {
    const { manager } = makeManager();
    seedBuiltinServers(manager);
    manager.serverLoader.cache.set('vault', {
        name: 'vault',
        source: 'built-in',
        removable: false,
        description: 'Vault',
        icon: 'folder',
        tools: ['read'],
        paths: [],
        knowledge: '',
    } as unknown as LoadedServerConfig);

    t.deepEqual(
        manager.getAllowedServerNamesForAgent({ name: 'Jaskier', mcp_servers: ['*'] }).sort(),
        ['core', 'vault', 'web']
    );
    const profile = { name: 'Quiet', mcp_servers: ['web'], disabled_tools: [] };
    t.deepEqual(manager.getAllowedServerNamesForAgent(profile), ['core', 'web']);

    // Dawny kształt wejścia publicznego API nadal ma respektować mcp_servers.
    const legacyVisibility = { ...profile, permissions: { mcp: false } };
    t.deepEqual(manager.getAllowedServerNamesForAgent(legacyVisibility), ['core', 'web']);

    // Agent z YAML-a usuwa wycofany klucz podczas normalizacji.
    const agent = new Agent({ ...profile, default_permissions: { mcp: false } });
    const baseline = new Agent(profile);
    t.deepEqual(manager.getAllowedServerNamesForAgent(agent), ['core', 'web']);
    t.deepEqual(manager.getAllowedServerNamesForAgent(agent), manager.getAllowedServerNamesForAgent(baseline));
});
