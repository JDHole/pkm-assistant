/**
 * ServerManager — Orkiestruje ServerLoader dla wbudowanych serwerów MCP.
 *
 * Zarządza podłączonymi built-in serwerami:
 * - connectServer(name) → rejestruje toole built-in serwera w ToolRegistry, zwraca listę nazw
 * - disconnectServer(name) → zdejmuje serwer z aktywnych (built-in toole zostają w ToolRegistry)
 * - disconnectAll() → przy zmianie agenta
 * - getActiveToolDefinitions() → dla chat_view (OpenAI format)
 *
 * E3.1 faza C: sandbox custom-JS + user/standalone serwery wycięte.
 * Zewnętrzne serwery MCP obsługuje ExternalMcpManager (prawdziwy klient stdio/HTTP).
 */
import { ServerLoader } from './ServerLoader.js';
import type { LoadedServerConfig } from './ServerLoader.js';
import { log } from '../../core/utils/Logger.js';
import type { ToolDefinition } from './ToolRegistry.js';

/** Definicja narzędzia w formacie OpenAI function-calling (to, co idzie do modelu). */
export interface OpenAiToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/** Agent w zakresie, w jakim decyduje o widoczności serwerów (pola z YAML-a usera). */
export interface ServerVisibilityAgent {
    name?: string;
    mcp_servers?: unknown;
    effective_mcp_servers?: unknown;
    permissions?: { mcp?: boolean } | null;
    default_permissions?: { mcp?: boolean } | null;
}

/** Plugin widziany przez managera: wersja manifestu + rejestr narzędzi. */
export interface ServerManagerPluginLike {
    manifest?: { version?: string };
    toolRegistry?: { getTool(name: string): ToolDefinition | null } | null;
}

/** Opcje konstruktora managera. */
export interface ServerManagerOptions {
    /** E1.2 kill-switch, forwarded to ServerLoader. */
    komunikatorEnabled?: boolean;
}

export class ServerManager {
    declare app: { vault: unknown };
    declare plugin: ServerManagerPluginLike;
    declare serverLoader: ServerLoader;
    /** Connected server configs */
    declare _activeServers: Map<string, LoadedServerConfig>;
    /** Connected server tool definitions (OpenAI format) */
    declare _activeTools: Map<string, OpenAiToolDefinition[]>;

    /**
     * @param app - Obsidian App instance
     * @param plugin - Plugin instance
     */
    constructor(app: { vault: unknown }, plugin: ServerManagerPluginLike, options: ServerManagerOptions = {}) {
        this.app = app;
        this.plugin = plugin;
        const pluginVersion = plugin?.manifest?.version || '1.0.0';
        this.serverLoader = new ServerLoader(app.vault, { pluginVersion, komunikatorEnabled: options.komunikatorEnabled });

        this._activeServers = new Map();
        this._activeTools = new Map();
    }

    /**
     * Initialize: load all built-in server configs.
     */
    async initialize(): Promise<void> {
        await this.serverLoader.loadAllServers();
        const servers = this.serverLoader.getAllServers().length;
        log.info('ServerManager', `Initialized: ${servers} built-in serwerów`);
    }

    _toolDefinitionFromRegisteredTool(tool: ToolDefinition): OpenAiToolDefinition {
        return {
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            },
        };
    }

    _getAgentMcpServers(agent: ServerVisibilityAgent | null | undefined): unknown[] | null | undefined {
        if (!agent) return null;
        // E2.8 A3: rola rozpuszczona — oś to sam mcp_servers (effective_mcp_servers = jego lustro).
        if (Array.isArray(agent.effective_mcp_servers)) return agent.effective_mcp_servers as unknown[];
        return agent.mcp_servers as unknown[] | null | undefined;
    }

    getAllowedServerNamesForAgent(agent: ServerVisibilityAgent | null | undefined): string[] {
        const allServers = this.serverLoader.getAllServers() || [];
        if (!agent) return allServers.map(s => s.name);

        const permissions = agent.permissions || agent.default_permissions;
        if (permissions?.mcp === false) return ['core'];

        const mcpServers = this._getAgentMcpServers(agent);
        if (!Array.isArray(mcpServers)) return allServers.map(s => s.name);
        if (mcpServers.includes('*')) return allServers.map(s => s.name);

        const allowed = new Set(['core', ...mcpServers]);
        return allServers.filter(s => allowed.has(s.name)).map(s => s.name);
    }

    getAllowedBuiltinServerNamesForAgent(agent: ServerVisibilityAgent | null | undefined): string[] {
        const allowed = new Set(this.getAllowedServerNamesForAgent(agent));
        return (this.serverLoader.getBuiltinServers() || [])
            .filter(s => allowed.has(s.name))
            .map(s => s.name);
    }

    connectBuiltInServersForAgent(agent: ServerVisibilityAgent | null | undefined): { connected: string[]; errors: Array<{ name: string; error?: string }> } {
        const connected: string[] = [];
        const errors: Array<{ name: string; error?: string }> = [];
        if (!agent) return { connected, errors };
        for (const name of this.getAllowedBuiltinServerNamesForAgent(agent)) {
            const result = this.connectServer(name);
            if (result.success) connected.push(name);
            else errors.push({ name, error: result.error });
        }
        return { connected, errors };
    }

    syncBuiltInServersForAgent(agent: ServerVisibilityAgent | null | undefined): { connected: string[]; errors: Array<{ name: string; error?: string }> } {
        this.disconnectAll();
        return this.connectBuiltInServersForAgent(agent);
    }

    /**
     * Connect a built-in server — resolve its tool names in ToolRegistry and mark it active.
     * @param name - Server name
     */
    connectServer(name: string): { success: boolean; tools?: string[]; knowledge?: string; error?: string; already_connected?: boolean; description?: string } {
        const config = this.serverLoader.getServer(name);
        if (!config) {
            return { success: false, error: `Serwer "${name}" nie znaleziony.` };
        }

        if (this._activeServers.has(name)) {
            const toolNames = this._activeTools.get(name)?.map(t => t.function?.name) || [];
            return { success: true, tools: toolNames, already_connected: true };
        }

        const registry = this.plugin.toolRegistry;
        if (!registry) {
            return { success: false, error: 'ToolRegistry niedostępny' };
        }

        const registeredTools: string[] = [];
        const toolDefs: OpenAiToolDefinition[] = [];

        // Asercja opisuje DEFENSYWNY odczyt poniżej: manifesty niosą same stringi, ale kod od
        // zawsze przepuszcza też wpis obiektowy `{name}` (kształt z ery user-serwerów).
        for (const toolEntry of (config.tools || []) as Array<string | { name?: string }>) {
            const toolName = typeof toolEntry === 'string' ? toolEntry : toolEntry?.name;
            const tool = toolName ? registry.getTool(toolName) : null;
            if (!tool) {
                log.warn('ServerManager', `Built-in serwer ${name}: narzędzie ${toolName || '(brak nazwy)'} nie jest zarejestrowane w ToolRegistry`);
                continue;
            }

            registeredTools.push(toolName!);
            toolDefs.push(this._toolDefinitionFromRegisteredTool(tool));
        }

        this._activeServers.set(name, config);
        this._activeTools.set(name, toolDefs);

        log.info('ServerManager', `Połączono serwer: ${name} (${registeredTools.length} narzędzi)`);

        return {
            success: true,
            tools: registeredTools,
            knowledge: config.knowledge ? config.knowledge.slice(0, 2000) : '',
            description: config.description,
        };
    }

    /**
     * Disconnect a server — drop it from the active set.
     * Built-in tools stay registered in ToolRegistry (owned by main.js); we only stop
     * advertising the server in getActiveToolDefinitions.
     */
    disconnectServer(name: string): void {
        this._activeServers.delete(name);
        this._activeTools.delete(name);
        log.info('ServerManager', `Rozłączono serwer: ${name}`);
    }

    /**
     * Disconnect all servers (e.g. on agent switch).
     */
    disconnectAll(): void {
        const serverNames = [...this._activeServers.keys()];
        for (const name of serverNames) {
            this.disconnectServer(name);
        }
        if (serverNames.length > 0) {
            log.info('ServerManager', `Rozłączono ${serverNames.length} serwerów`);
        }
    }

    /**
     * Get tool definitions for active (built-in) servers (OpenAI format).
     * @param filterServers — if provided, only return tools from these servers
     */
    getActiveToolDefinitions(filterServers?: string[]): OpenAiToolDefinition[] {
        const all: OpenAiToolDefinition[] = [];
        for (const [serverName, defs] of this._activeTools.entries()) {
            if (filterServers && !filterServers.includes(serverName)) continue;
            all.push(...defs);
        }
        return all;
    }

    /**
     * Check if a server is connected.
     */
    isConnected(name: string): boolean {
        return this._activeServers.has(name);
    }

    /**
     * Get names of active servers.
     */
    getActiveServerNames(): string[] {
        return [...this._activeServers.keys()];
    }

    /**
     * Reload built-in server configs.
     * Does NOT auto-reconnect — connected servers stay connected.
     */
    async reload(): Promise<void> {
        await this.serverLoader.reloadServers();
        const servers = this.serverLoader.getAllServers().length;
        log.info('ServerManager', `Reloaded: ${servers} built-in serwerów`);
    }
}
