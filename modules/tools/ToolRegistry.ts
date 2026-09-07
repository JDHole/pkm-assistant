/**
 * Central registry for all available MCP tools.
 *
 * Tool visibility (E2.8 C1 — JEDNA OŚ NARZĘDZIOWA, po Sprint 04 MCP_PORZADEK_v1):
 * - Built-in servers map (BUILTIN_TOOL_MAP) defines which tools belong to which "logical server"
 *   (grupy w UI Uprawnień). Źródło prawdy nazw = manifesty `built-in-servers/*.manifest.js`.
 * - `core` is always-available (ask_user). Agent cannot remove it.
 * - `filterByAgent(agent)` = all built-in − `agent.disabled_tools[]` (negatywna lista). User MCP
 *   server tools (`tool.serverName`) dodatkowo gated pozytywną listą `mcp_servers` (opt-in, E3.1).
 * - K3: regułę liczy JEDNA metoda — `checkToolAxis(agent, toolName)`. `filterByAgent` to jej
 *   przelot po rejestrze, a `MCPClient.executeToolCall` woła ją jako BRAMKĘ przed wykonaniem.
 *   Widoczność i egzekucja nie mogą się rozjechać, bo liczy je ten sam kod.
 */
import { log } from '../../core/utils/Logger.js';

/**
 * Kanoniczny kształt narzędzia w rejestrze (TS-3). Właścicielem typu jest ToolRegistry —
 * fabryki `create*Tool()` i wrappery external MCP rejestrują obiekty tego kształtu.
 *
 * `execute` celowo jako METODA (nie pole funkcyjne): parametry metod są biwariantne nawet pod
 * `strictFunctionTypes`, więc narzędzie z konkretnym typem argumentów przypisuje się do rejestru
 * bez rzutowań, a wołacze (MCPClient) mogą podać `Record<string, unknown>`.
 * Index signature: narzędzia niosą pola dodatkowe (np. `contextExtractor` z S04 Z10).
 */
export interface ToolDefinition {
    /** Unique name of the tool. */
    name: string;
    /** Description of what the tool does. */
    description: string;
    /** JSON Schema for the tool's input. */
    inputSchema: Record<string, unknown>;
    /**
     * Async function to execute the tool. Narzędzia built-in mają sygnaturę
     * `execute(args, app, plugin)` (tak woła je MCPClient); wrappery external MCP biorą tylko
     * `args`. Parametry 2-3 są tu opcjonalne, żeby OBJĄĆ obie arności — implementacja może
     * deklarować je jako wymagane i konkretne (biwariancja metod), wołacz 1-argumentowy przejdzie.
     */
    execute(args: Record<string, unknown>, app?: unknown, plugin?: unknown): Promise<unknown>;
    /** Logical server this tool belongs to (for filterByAgent). */
    serverName?: string;
    /** 'built-in' | 'user' — narzędzia external MCP dostają 'user' (→ RED w classifyToolRisk). */
    source?: string;
    [extra: string]: unknown;
}

/**
 * Minimalny widok agenta, jakiego potrzebuje filtr widoczności. Pola są `unknown`, bo pochodzą
 * z YAML-a usera — istniejące `Array.isArray` w kodzie zawężają je same (kontrakt TS-0 §4).
 */
export interface ToolVisibilityAgent {
    disabled_tools?: unknown;
    mcp_servers?: unknown;
    effective_mcp_servers?: unknown;
}

/** Powód odmowy na osi narzędziowej agenta (K3). */
export type ToolAxisDenialReason = 'disabled_tool' | 'server_not_opted_in';

/**
 * Werdykt osi narzędziowej agenta. Ten sam obiekt odpowiada na dwa pytania:
 * „czy pokazać narzędzie modelowi" (widoczność) i „czy wolno je wykonać" (egzekucja).
 */
interface ToolAxisDecision {
    allowed: boolean;
    /** Wypełniony tylko przy odmowie. */
    reason?: ToolAxisDenialReason;
    /** Serwer zewnętrzny, którego dotyczy odmowa `server_not_opted_in`. */
    serverName?: string;
}

const BUILTIN_TOOL_MAP: Record<string, string[]> = {
    core: ['ask_user'],
    // E2.9: artifact_* (żywe artefakty, gatunek 1) + todo (gatunek 2). Stare chat_todo/idea_review/plan_review skasowane (aliasy w toolAliases.js).
    artifacts: ['artifact_create', 'artifact_read', 'artifact_update', 'artifact_list', 'todo'],
    // E2.5: 12 narzędzi retrieval skonsolidowane w JEDNO `search` (scope vault/memory).
    // `search` żyje w serwerze `vault` — scope=memory bramkowane osobno uprawnieniem memory
    // (SearchTool), więc agent bez serwera `vault` nie dostaje dostępu do vaultu przez tylną furtkę.
    vault: [
        'read', 'write', 'list',
        'delete', 'create_folder', 'search'
    ],
    memory: [
        'memory_save', 'memory_delete'
    ],
    web: ['web_search', 'web_read'],
    multimodal: ['generate_image', 'add_text_to_image'],
    // S28 (D3): `agent_message` OUT — poczta ma własny serwer `komunikator`.
    delegation: [
        'delegate', 'agent_delegate'
    ],
    // Serwer `skills` skasowany w E2.4 (D17): skill_list/skill_execute nie istnieją.
    // Odkrywalność skilli = indeks w prompcie, przepis czytany przez `read`.
    // S28 (D3): Komunikator v3 = trzy prymitywy poczty (Project Hub skasowany).
    komunikator: [
        'kom_send', 'kom_list', 'kom_read'
    ]
};

const ALWAYS_AVAILABLE_SERVER = 'core';

export class ToolRegistry {
    declare tools: Map<string, ToolDefinition>;

    constructor() {
        this.tools = new Map();
    }

    /**
     * Registers a new tool.
     * @param tool - The tool definition ({name, description, inputSchema, execute, [serverName]}).
     */
    registerTool(tool: ToolDefinition) {
        if (!tool.name || !tool.description || !tool.inputSchema || !tool.execute) {
            log.error('ToolRegistry', 'Invalid tool definition:', tool);
            throw new Error(`Invalid tool definition for ${tool.name || 'unknown tool'}`);
        }

        if (this.tools.has(tool.name)) {
            log.warn('ToolRegistry', `Tool ${tool.name} is already registered. Overwriting.`);
        }

        this.tools.set(tool.name, tool);
    }

    /**
     * Unregisters a tool by name (E3.1 R1 — public API so external managers stop reaching into
     * the private `this.tools` Map from Mapa-era code). Idempotent.
     * @returns true if a tool was present and removed, false otherwise.
     */
    unregisterTool(name: string): boolean {
        return this.tools.delete(name);
    }

    /**
     * Retrieves a tool by name.
     */
    getTool(name: string): ToolDefinition | null {
        return this.tools.get(name) || null;
    }

    /**
     * Returns all registered tools.
     */
    getAllTools(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    /**
     * Returns all registered tool names.
     */
    getAllToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Returns tool definitions formatted for OpenAI function calling / AI consumption.
     */
    getToolDefinitions() {
        return this.getAllTools().map(tool => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema
            }
        }));
    }

    /**
     * Filters tools to those visible for the given agent (E2.8 C1 — JEDNA OŚ NARZĘDZIOWA).
     *
     * Model:
     * - Narzędzia BUILT-IN: włączone, chyba że nazwa w `agent.disabled_tools[]` (negatywna lista;
     *   nowe narzędzie po update pluginu = domyślnie ON). `core` (ask_user) ZAWSZE ON, nieusuwalny.
     * - Narzędzia USEROWYCH serwerów MCP (tool.serverName spoza built-in): gated `disabled_tools`
     *   ORAZ pozytywną listą `mcp_servers` (opt-in per agent — connector przypięty do agenta).
     *   To oś TRANSITIONAL do E3.1 („prawdziwy klient MCP"); built-in jej NIE używa.
     * - Brak agenta / brak `disabled_tools` → nic nie wyłączone (semantyka negatywnej listy).
     *
     * To filtr WIDOCZNOŚCI (co model dostaje w definicjach narzędzi), ale od K3 liczy go ta sama
     * metoda `checkToolAxis`, którą `MCPClient.executeToolCall` woła jako BRAMKĘ przed wykonaniem.
     * Dawny komentarz mówił tu „to nie granica bezpieczeństwa, granicą jest checkPermission",
     * a `checkPermission` odsyłał z powrotem do `disabled_tools` — i nikt nie bramkował.
     *
     * @param agent - Agent profile (`disabled_tools[]`, `mcp_servers[]`).
     */
    filterByAgent(agent: ToolVisibilityAgent | null | undefined): ToolDefinition[] {
        return this.getAllTools().filter(tool => this.checkToolAxis(agent, tool.name, tool).allowed);
    }

    /**
     * K3 (AUD-security-052 / 004) — JEDNA REGUŁA OSI NARZĘDZIOWEJ.
     *
     * Ta metoda jest jedynym miejscem, w którym zapada decyzja „to narzędzie należy do agenta".
     * Woła ją `filterByAgent` (co model WIDZI w definicjach narzędzi) i woła ją
     * `MCPClient.executeToolCall` (co agentowi wolno WYKONAĆ). Do K3 istniała tylko pierwsza
     * droga, więc model, który znał nazwę wyłączonego narzędzia (ze starej sesji, z notatki,
     * z transkryptu innego agenta), wołał je po nazwie i nikt go nie zatrzymywał.
     *
     * Reguła (bez zmian merytorycznych względem dawnego `filterByAgent`, poza opt-inem niżej):
     * - `core` (ask_user) — zawsze wolno, nieusuwalny;
     * - built-in — wolno, dopóki nazwy nie ma w `agent.disabled_tools[]` (negatywna lista);
     * - narzędzie serwera USEROWEGO / zewnętrznego (`tool.serverName`) — dodatkowo musi mieć
     *   opt-in: serwer w `agent.mcp_servers[]` (albo `effective_mcp_servers[]`, albo `*`).
     *
     * @param toolName - nazwa KANONICZNA (po rozwiązaniu aliasów) — inaczej alias byłby obejściem.
     * @param tool - narzędzie z rejestru, jeśli wołacz już je ma (oszczędza `getTool`); `undefined`
     *   = dociągnij z rejestru. Narzędzie nieznane rejestrowi nie jest tu odrzucane — o tym mówi
     *   osobny błąd „Tool not found" u wołacza.
     */
    checkToolAxis(
        agent: ToolVisibilityAgent | null | undefined,
        toolName: string,
        tool?: ToolDefinition | null,
    ): ToolAxisDecision {
        const disabled = new Set(Array.isArray(agent?.disabled_tools) ? agent.disabled_tools : []);
        const builtinServer = this.getBuiltinServerForTool(toolName);

        if (builtinServer === ALWAYS_AVAILABLE_SERVER) return { allowed: true }; // ask_user always on
        if (builtinServer) {
            return disabled.has(toolName)
                ? { allowed: false, reason: 'disabled_tool' }
                : { allowed: true };
        }

        // User MCP server tool (or orphan registered tool).
        if (disabled.has(toolName)) return { allowed: false, reason: 'disabled_tool' };
        const resolved = tool === undefined ? this.getTool(toolName) : tool;
        const serverName = resolved?.serverName;
        if (!serverName) return { allowed: true };

        const userServers = this._userConnectorWhitelist(agent);
        if (userServers === '*' || userServers.has(serverName)) return { allowed: true };
        return { allowed: false, reason: 'server_not_opted_in', serverName };
    }

    /** Skrót do `checkToolAxis(...).allowed` — dla wołaczy, których nie interesuje powód. */
    isToolAllowedForAgent(
        agent: ToolVisibilityAgent | null | undefined,
        toolName: string,
        tool?: ToolDefinition | null,
    ): boolean {
        return this.checkToolAxis(agent, toolName, tool).allowed;
    }

    /**
     * User-connector positive whitelist (E3.1-transitional). Built-in servers ignored here.
     * @private
     * @returns '*' = all user servers visible (no whitelist / wildcard).
     */
    _userConnectorWhitelist(agent: ToolVisibilityAgent | null | undefined): Set<unknown> | '*' {
        if (!agent) return '*';
        const servers = Array.isArray(agent.effective_mcp_servers)
            ? agent.effective_mcp_servers
            : (Array.isArray(agent.mcp_servers) ? agent.mcp_servers : null);
        // K3 (AUD-security-004): opt-in znaczy opt-in. Agent BEZ listy serwerów nie przypiął
        // żadnego konektora, więc nie dostaje żadnego — dawne `'*'` w tym miejscu robiło
        // z braku listy przepustkę na wszystkie serwery zewnętrzne.
        if (!Array.isArray(servers)) return new Set();
        if (servers.includes('*')) return '*';
        return new Set(servers);
    }

    /**
     * Returns the built-in server name for a built-in tool, or null if not built-in.
     * Used for UI badges + manifest validation.
     */
    getBuiltinServerForTool(toolName: string): string | null {
        for (const [server, tools] of Object.entries(BUILTIN_TOOL_MAP)) {
            if (tools.includes(toolName)) return server;
        }
        return null;
    }

    /**
     * Returns the BUILTIN_TOOL_MAP (read-only). Useful for manifest generation + UI.
     */
    getBuiltinServerMap(): Record<string, string[]> {
        return BUILTIN_TOOL_MAP;
    }
}
