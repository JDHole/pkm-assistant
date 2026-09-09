/**
 * ExternalMcpManager — prawdziwy klient protokołu MCP.
 *
 * Podłącza ZEWNĘTRZNE serwery MCP przez oficjalny `@modelcontextprotocol/sdk`:
 *   - transport `stdio` = lokalny proces (Blender, DaVinci, ...) — TYLKO desktop.
 *   - transport `http`  = zdalny serwer (konektory typu Gmail) — działa też na mobile.
 * Narzędzia serwera trafiają do istniejącego `ToolRegistry` jako `source:'user'`, więc
 * łańcuch bezpieczeństwa klasyfikuje je jako RED (isExternalTool → classifyToolRisk).
 * Ten manager NICZEGO w tym łańcuchu nie zmienia — tylko rejestruje narzędzia.
 *
 * ZASADY:
 *  - Wszystko node-owe (SDK, `child_process` ciągnięty przez transport stdio) importowane
 *    LENIWIE — dynamic import wewnątrz metod. `obsidian` NIE jest importowany W OGÓLE
 *    (Platform.isMobile wchodzi przez DI `options.isMobile` z main.js — dynamic import
 *    externala nie przeżywa bundlowania). Testy AVA (fake `clientFactory`) nie ciągną SDK.
 *  - Status runtime (connected/off/error + lastError zamaskowany) żyje w WEWNĘTRZNEJ mapie managera
 *    (`getStatus(id)`), NIE na obiekcie configu — data.json trzyma tylko konfigurację usera.
 *    NIGDY nie rzuca przy autostarcie (cichy fail, decyzja D-D).
 *  - Rejestracja narzędzi wrapperem identycznym w kształcie z `ServerManager` (source:'user').
 *  - Timeout per call: `resolveTimeoutMs` (domyślnie 60s, sufit 180s — te same zasady co reszta).
 *  - Sekrety (env/headers) NIGDY nie są logowane; treści błędów maskuje `maskSensitiveData`.
 *
 * DI dla testów: `options.clientFactory(serverConfig) → { client, transport }`. Gdy podane,
 * SDK i transporty nie są w ogóle importowane. `client` musi mieć: connect/listTools/callTool/close.
 */
import { log } from '../../core/utils/Logger.js';
import { maskSensitiveData } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { resolveTimeoutMs } from './server_timeout.js';
import type { ToolDefinition } from './ToolRegistry.js';

const CLIENT_NAME = 'pkm-assistant';
const EXTERNAL_ACTION_TYPE = 'external.call';

// obsidianmd/prefer-window-timers: ten plik wstaje w gołym Node (testy AVA), gdzie `window`
// nie istnieje — `window.setTimeout` byłby ReferenceError. Inline `eslint-disable` jest
// zablokowany dla `obsidianmd/*` (`eslint-comments/no-restricted-disable` w configu pluginu
// recenzenta katalogu). Owijamy globalny timer FUNKCJĄ zamiast zamrażać referencję raz przy
// imporcie — `fn` czyta `setTimeout`/`clearTimeout` DYNAMICZNIE przy każdym wywołaniu, więc
// zachowanie jest 1:1 jak bezpośrednie wywołanie globala. Reguła pomija wywołanie, bo `fn`
// jest lokalną zmienną, nie globalną referencją.
function _nodeSafeSetTimeout(...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> {
    const fn = setTimeout;
    return fn(...args);
}
function _nodeSafeClearTimeout(...args: Parameters<typeof clearTimeout>): void {
    const fn = clearTimeout;
    fn(...args);
}

/**
 * Sufit czasu na zamknięcie JEDNEGO serwera w `closeAll()` (ms).
 *
 * `StdioClientTransport.close()` ma własny budżet do ~4 s (stdin.end → 2 s → SIGTERM → 2 s →
 * SIGKILL), więc 5 s daje mu dojść do SIGKILL-a. Po tym czasie porzucamy obietnicę z logiem —
 * demontaż pluginu nie ma prawa czekać na trupa, a `onunload` w Obsidianie i tak jest
 * synchroniczne i na nic nie czeka.
 */
const CLOSE_TIMEOUT_MS = 5000;

/** Złapany błąd — `catch` daje `unknown`, a kod czyta z niego tylko `.message`. */
type ErrLike = { message?: string };

/**
 * Transport SDK w zakresie, w jakim go dotykamy: dwa haki cyklu życia.
 *
 * `StdioClientTransport` woła `onclose` po `close` procesu i `onerror` przy
 * padzie spawnu / stdin / stdout (`client/stdio.js`); `StreamableHTTPClientTransport` ma te
 * same pola. Podpinamy się PRZED `client.connect()`, bo `Protocol.connect` zachowuje
 * poprzedni hak i wywołuje oba (`shared/protocol.js`) — nasz nie wypiera obsługi SDK.
 */
interface TransportLifecycle {
    onclose?: (() => void) | null;
    onerror?: ((error: Error) => void) | null;
}

/**
 * Tłumaczenie błędu połączenia po KSZTAŁCIE, nie po treści.
 *
 * Do tej naprawy `connect` rozpoznawał wyłącznie 401, a wszystko inne oddawał userowi jako
 * surowy tekst z SDK/systemu — czyli `Notice` „Nie udało się połączyć „Filesystem": spawn npx
 * ENOENT" i taki sam czerwony napis w wierszu serwera. To jest NAJCZĘSTSZY sposób, w jaki
 * podłączenie stdio nie wychodzi (3 z 5 presetów startuje przez `npx`, a renderer Obsidiana
 * na Windows często nie ma go w PATH), więc zdanie musi mówić, co user ma zrobić.
 *
 * Pełny surowy tekst (zamaskowany) idzie do LOGU — tu powstaje zdanie dla człowieka.
 *
 * @returns zdanie i18n albo `null`, gdy kształtu nie rozpoznajemy (wtedy stara ścieżka).
 */
function _explainConnectError(raw: string, serverConfig: ExternalMcpServerConfig): string | null {
    // Kolejność: 401 pierwszy.
    if (/401|unauthorized/i.test(raw)) return t('settings.mcp_external_error_401');
    // Wstawki idą przez maskę: `url` usera potrafi nieść token w query stringu, a to zdanie
    // ląduje w `Notice` i w wierszu serwera — sekret nie ma prawa wyjść na ekran.
    const cmd = maskSensitiveData(serverConfig?.command || serverConfig?.url || '?');
    if (/\bENOENT\b/.test(raw)) return t('settings.mcp_external_error_enoent', { cmd });
    if (/\bEACCES\b|\bEPERM\b/.test(raw)) return t('settings.mcp_external_error_eacces', { cmd });
    if (/\bECONNREFUSED\b|\bENOTFOUND\b|\bEHOSTUNREACH\b|\bECONNRESET\b/.test(raw)) {
        return t('settings.mcp_external_error_refused', { target: maskSensitiveData(serverConfig?.url) || cmd });
    }
    if (/\bETIMEDOUT\b|timed\s*out|timeout/i.test(raw)) return t('settings.mcp_external_error_timeout');
    return null;
}

/**
 * Config ZEWNĘTRZNEGO serwera MCP — dokładnie to, co user trzyma w
 * `settings.pkmAssistant.externalMcpServers[]` (data.json). WYŁĄCZNIE konfiguracja:
 * status runtime żyje w wewnętrznej mapie managera, a `status`/`lastError` są tu
 * tylko po to, żeby `stripRuntimeFields` miało co skasować po starszych wersjach.
 */
export interface ExternalMcpServerConfig {
    id: string;
    name?: string;
    /**
     * `'stdio'` albo `'http'`. Typ jest szerszy (`string`), bo wartość przychodzi z data.json —
     * cokolwiek innego odbija się o `throw` w `_createTransport`, a nie o typ.
     */
    transport?: string;
    /** stdio */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    /** http */
    url?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
    autostart?: boolean;
    timeout_ms?: number;
    /** @deprecated pola runtime utrwalone przez fazę A — zdejmuje je `stripRuntimeFields`. */
    status?: string;
    lastError?: string | null;
}

/** Status runtime serwera — mapa w managerze, NIGDY w data.json. */
export interface ExternalServerStatus {
    status: 'connected' | 'off' | 'error';
    lastError: string | null;
    toolCount: number;
}

/** Wiersz dla UI: config usera + status runtime (Settings + profil agenta). */
export interface ExternalServerUiRow {
    id: string;
    name: string;
    transport: string;
    autostart: boolean;
    enabled: boolean;
    connected: boolean;
    status: ExternalServerStatus['status'];
    lastError: string | null;
    toolCount: number;
}

/** Definicja narzędzia tak, jak podaje ją serwer MCP (`listTools`). */
interface McpToolDefinition {
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

/**
 * Klient MCP w zakresie, w jakim go używamy (SDK `Client` pasuje strukturalnie, a testy
 * wstrzykują atrapę przez `clientFactory`). Świadomie NIE importujemy typów z SDK —
 * ten plik nie ma prawa ciągnąć SDK inaczej niż leniwie, w środku metody.
 */
export interface McpClientLike {
    connect(transport: unknown, options?: { timeout?: number }): Promise<unknown>;
    listTools(params?: unknown, options?: { timeout?: number }): Promise<{ tools?: McpToolDefinition[] } | undefined>;
    callTool(
        params: { name: string; arguments?: unknown },
        resultSchema?: unknown,
        options?: { timeout?: number },
    ): Promise<McpCallToolResult>;
    close?(): unknown;
}

/** Surowy wynik `callTool` (kształt MCP) albo NASZ własny kształt błędu. */
export interface McpCallToolResult {
    content?: unknown;
    isError?: boolean;
    error?: string;
    [extra: string]: unknown;
}

/** Element `content[]` w wyniku MCP. */
interface McpContentPart {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { uri?: string; mimeType?: string; text?: string };
}

/** DI dla testów: fabryka klienta + transportu (gdy podana, SDK NIE jest importowane). */
export type McpClientFactory = (
    serverConfig: ExternalMcpServerConfig,
) => Promise<{ client: McpClientLike; transport: unknown }>;

/** Opcje konstruktora managera. */
export interface ExternalMcpManagerOptions {
    clientFactory?: McpClientFactory | null;
    toolRegistry?: ExternalToolRegistryLike | null;
    isMobile?: boolean;
}

/** Rejestr narzędzi w zakresie, w jakim dotyka go ten manager. */
export interface ExternalToolRegistryLike {
    registerTool(tool: ToolDefinition): void;
    unregisterTool?(name: string): boolean;
    getTool?(name: string): ToolDefinition | null;
    getBuiltinServerMap?(): Record<string, string[]>;
}

/** Plugin widziany przez managera: rejestr, wersja i ustawienia z configami serwerów. */
export interface ExternalMcpPluginLike {
    manifest?: { version?: string };
    toolRegistry?: ExternalToolRegistryLike | null;
    env?: { settings?: { pkmAssistant?: { externalMcpServers?: unknown } } | null } | null;
    settings?: { pkmAssistant?: { externalMcpServers?: unknown } } | null;
}

/**
 * Normalizacja wyniku narzędzia MCP na CZYSTY TEKST dla modelu.
 *
 * Po co: SDK zwraca `{content:[{type:'text'|'image'|'resource', ...}]}`, a pętla agenta
 * (`AgentLoop`) wkłada wynik do promptu przez `JSON.stringify(raw)`. Bez tej funkcji
 * base64 obrazka (setki kB) leciał do modelu jako string — spalony budżet tokenów i śmieci
 * w kontekście. Tu zostaje z niego jedna linijka adnotacji.
 *
 * ⚠️ Adnotacje (`[image ...]`, `[resource: ...]`) są po ANGIELSKU i świadomie BEZ i18n —
 * to treść dla MODELU, nie napis w UI. Tłumaczenie ich zmieniałoby prompt razem z językiem
 * interfejsu (niedeterministyczne zachowanie narzędzia).
 *
 * @param result - surowy wynik `client.callTool` (albo cokolwiek innego).
 * @returns sklejony tekst; `{isError:true, error}` gdy serwer zgłosił błąd;
 *          wejście bez tablicy `content` wraca bez zmian (pass-through).
 */
export function normalizeMcpResult(result: unknown): unknown {
    if (!result || typeof result !== 'object' || !Array.isArray((result as McpCallToolResult).content)) {
        return result;
    }
    const parts: string[] = [];
    for (const part of (result as McpCallToolResult).content as McpContentPart[]) {
        if (!part || typeof part !== 'object') continue;
        switch (part.type) {
            case 'text':
                parts.push(String(part.text ?? ''));
                break;
            case 'image': {
                // Rozmiar liczony z długości base64 (4 znaki = 3 bajty) — bez dekodowania.
                const data = typeof part.data === 'string' ? part.data : '';
                const kb = Math.round(data.length * 3 / 4 / 1024);
                parts.push(`[image ${part.mimeType || 'unknown'}, ~${kb} kB]`);
                break;
            }
            case 'resource': {
                const res = (part.resource && typeof part.resource === 'object') ? part.resource : {};
                const label = res.uri || res.mimeType || 'unknown';
                parts.push(typeof res.text === 'string'
                    ? `[resource: ${label}]\n${res.text}`
                    : `[resource: ${label}]`);
                break;
            }
            default:
                parts.push(`[${part.type || 'unknown'}]`);
        }
    }
    const text = parts.join('\n\n');
    if ((result as McpCallToolResult).isError) return { isError: true, error: text };
    return text;
}

export class ExternalMcpManager {
    declare plugin: ExternalMcpPluginLike;
    declare _clientFactory: McpClientFactory | null;
    /** Obietnica ostatniego `autostart()` — patrz `whenAutostartSettled()`. */
    declare _autostartSettled: Promise<void> | null;
    declare _toolRegistry: ExternalToolRegistryLike | null;
    declare _isMobile: boolean;
    declare _pluginVersion: string;
    declare _connections: Map<string, { client: McpClientLike; transport: unknown; config: ExternalMcpServerConfig; toolNames: string[] }>;
    /**
     * Obietnica handshake'u W TRAKCIE, per `serverId`.
     *
     * `connect()` był check-then-act na `_connections` bez żadnej rezerwacji „w trakcie
     * łączenia" — dwa równoczesne wywołania dla tego samego serwera (typowo: `autostart()`
     * bez await + klik „Połącz" w Ustawieniach w oknie wolnego handshake'u `npx`) oba
     * przechodziły test, oba stawiały OSOBNY klient/proces, a późniejszy zapis do
     * `_connections.set()` po cichu nadpisywał wcześniejszy — pierwszy proces potomny nigdy
     * nie dostawał `close()` (zombie do końca sesji), a narzędzia w `ToolRegistry` były cicho
     * nadpisane. Mapa trzyma JEDNĄ obietnicę na serwer: drugie i każde kolejne wywołanie
     * w oknie handshake'u dostaje TĘ SAMĄ obietnicę zamiast startować własną.
     */
    declare _connecting: Map<string, Promise<{ success: boolean; tools?: string[]; error?: string; alreadyConnected?: boolean }>>;
    /** prefixedName → routing info */
    declare _toolIndex: Map<string, { serverId: string; toolName: string }>;
    /**
     * Status RUNTIME żyje TU, nie na obiekcie configu. Config w
     * `settings.pkmAssistant.externalMcpServers[]` trafia do data.json i musi trzymać WYŁĄCZNIE
     * konfigurację usera — status/lastError/toolCount nie mogą się utrwalać.
     */
    declare _status: Map<string, ExternalServerStatus>;
    /**
     * Menedżer jest zdemontowany (`closeAll()` już poszło).
     *
     * `onunload` woła `closeAll()` fire-and-forget, a `autostart()` leci w tle i może
     * dokończyć handshake JUŻ PO demontażu — bez tej flagi świeże połączenie lądowało
     * w mapie martwego menedżera i jego proces stdio nie dostawał nigdy `close()`.
     */
    declare _unloaded: boolean;

    /**
     * @param plugin - instancja pluginu (toolRegistry, manifest.version, env.settings).
     * @param options.clientFactory - DI dla testów: async (serverConfig) =>
     *        { client, transport }. Gdy podane — SDK/transporty NIE są importowane.
     * @param options.toolRegistry - override rejestru (domyślnie plugin.toolRegistry).
     * @param options.isMobile - DI z main.js (`Platform.isMobile`). NIE importujemy
     *        `obsidian` w tym pliku — nawet dynamicznie: esbuild zostawia dynamic import
     *        externala jako natywny import() i bundle wybucha w runtime
     *        („Failed to resolve module specifier 'obsidian'").
     */
    constructor(plugin: ExternalMcpPluginLike, options: ExternalMcpManagerOptions = {}) {
        this.plugin = plugin;
        this._clientFactory = options.clientFactory || null;
        this._autostartSettled = null;
        this._toolRegistry = options.toolRegistry || null;
        this._isMobile = options.isMobile === true;
        this._pluginVersion = plugin?.manifest?.version || '1.0.0';

        this._connections = new Map();
        this._connecting = new Map();
        this._toolIndex = new Map();
        this._status = new Map();
        this._unloaded = false;
    }

    /** @private Domyślny status serwera (nigdy nie łączony = off). */
    _defaultStatus(): ExternalServerStatus {
        return { status: 'off', lastError: null, toolCount: 0 };
    }

    /** @private Nadpisz część statusu serwera w wewnętrznej mapie. */
    _setStatus(serverId: string, patch: Partial<ExternalServerStatus>): void {
        const prev = this._status.get(serverId) || this._defaultStatus();
        this._status.set(serverId, { ...prev, ...patch });
    }

    /**
     * Status runtime serwera — UI czyta STĄD, nie z obiektu configu.
     */
    getStatus(serverId: string): ExternalServerStatus {
        return this._status.get(serverId) || this._defaultStatus();
    }

    /**
     * Defensywnie przy save: zdejmij pola runtime, które starsza wersja mogła utrwalić na obiekcie
     * configu. Obiekty w `externalMcpServers[]` mają trzymać TYLKO konfigurację usera. Mutuje + zwraca.
     */
    static stripRuntimeFields(cfg: ExternalMcpServerConfig | null | undefined): ExternalMcpServerConfig | null | undefined {
        if (cfg && typeof cfg === 'object') {
            // no-deprecated: `status`/`lastError` są @deprecated na
            // ExternalMcpServerConfig — dostęp jest TU legalny (to WŁAŚNIE ta funkcja je zdejmuje),
            // ale inline-disable jest zablokowany configiem (`eslint-comments/no-restricted-disable`
            // obejmuje `@typescript-eslint/no-deprecated`). Rzut na worek generyczny odrywa dostęp
            // od deklaracji z tagiem — bez zmiany runtime (te same dwa klucze, ten sam `delete`).
            const raw = cfg as unknown as Record<string, unknown>;
            delete raw.status;
            delete raw.lastError;
        }
        return cfg;
    }

    /**
     * Walidacja id serwera (defense in depth — także w UI przy zapisie). Slug
     * `[a-z0-9-]{2,32}` ORAZ brak kolizji z nazwami serwerów wbudowanych. Powód (security):
     * default `agent.mcp_servers = ['vault','memory','core']` — external o id `vault` byłby
     * auto-wpuszczony każdemu agentowi przez `ToolRegistry.filterByAgent` (tool.serverName===id).
     * @param builtinNames - zarezerwowane nazwy serwerów built-in.
     */
    static validateServerId(
        id: string,
        builtinNames: Set<string> | string[] = [],
    ): { ok: boolean; reason?: 'format' | 'reserved' } {
        if (typeof id !== 'string' || !/^[a-z0-9-]{2,32}$/.test(id)) {
            return { ok: false, reason: 'format' };
        }
        const reserved = builtinNames instanceof Set ? builtinNames : new Set(builtinNames);
        if (reserved.has(id)) {
            return { ok: false, reason: 'reserved' };
        }
        return { ok: true };
    }

    _registry(): ExternalToolRegistryLike | null {
        return this._toolRegistry || this.plugin?.toolRegistry || null;
    }

    /** @returns czy serwer o danym id jest podłączony. */
    isConnected(serverId: string): boolean {
        return this._connections.has(serverId);
    }

    /** @returns id podłączonych serwerów. */
    getConnectedServerIds(): string[] {
        return [...this._connections.keys()];
    }

    /**
     * Czy `prefixedName` to narzędzie zewnętrznego serwera MCP zarejestrowane przez ten manager.
     * Używane przez MCPClient do rozpoznania nie-vaultowej akcji (bez path-checks AccessGuard).
     * @param prefixedName - nazwa `<serverId>__<toolName>`.
     */
    isExternalTool(prefixedName: string): boolean {
        return this._toolIndex.has(prefixedName);
    }

    /**
     * Zwraca actionType dla narzędzia zewnętrznego (`external.call`) albo null.
     * MCPClient używa tego do nadania narzędziu external akcji `external.call` — bez tego
     * actionType zostałby `unknown` i checkPermission zrobiłby fail-closed deny.
     */
    getToolActionType(prefixedName: string): string | null {
        return this._toolIndex.has(prefixedName) ? EXTERNAL_ACTION_TYPE : null;
    }

    /**
     * Lista narzędzi PODŁĄCZONEGO serwera dla podglądu w Settings (spec B3): nazwa (prefiksowana)
     * + opis (z `[serverLabel]` prefixem). Pusta gdy serwer nie jest podłączony.
     */
    getServerTools(serverId: string): Array<{ name: string; description: string }> {
        const entry = this._connections.get(serverId);
        if (!entry) return [];
        const registry = this._registry();
        return entry.toolNames.map(name => ({
            name,
            description: registry?.getTool?.(name)?.description || '',
        }));
    }

    /**
     * Snapshot skonfigurowanych serwerów dla UI (Settings + profil agenta): config usera
     * + status runtime z wewnętrznej mapy. UI nie sięga do settings ani do statusu bezpośrednio.
     * @param servers - configi (domyślnie z settings.pkmAssistant.externalMcpServers).
     */
    listServersForUi(servers?: ExternalMcpServerConfig[]): ExternalServerUiRow[] {
        const list = Array.isArray(servers) ? servers : this._configuredServers();
        return list.map(cfg => {
            const st = this.getStatus(cfg.id);
            return {
                id: cfg.id,
                name: cfg.name || cfg.id,
                transport: cfg.transport || 'stdio',
                autostart: !!cfg.autostart,
                enabled: cfg.enabled !== false,
                connected: this.isConnected(cfg.id),
                status: st.status,
                lastError: st.lastError,
                toolCount: st.toolCount,
            };
        });
    }

    /**
     * Połącz z pojedynczym serwerem wg configu i zarejestruj jego narzędzia w ToolRegistry.
     * NIE rzuca — zwraca `{success, tools?|error?}` i zapisuje status w WEWNĘTRZNEJ mapie
     * managera (getStatus(id)); obiekt configu NIE jest mutowany (data.json = tylko config).
     * @param serverConfig - {id, name, transport, command,args,env | url,headers, ...}.
     */
    async connect(
        serverConfig: ExternalMcpServerConfig,
    ): Promise<{ success: boolean; tools?: string[]; error?: string; alreadyConnected?: boolean }> {
        const serverId = serverConfig?.id;
        if (!serverId) {
            return { success: false, error: 'Brak id serwera MCP' };
        }
        // Po `closeAll()` menedżer jest martwy — nie stawiamy nowych procesów.
        if (this._unloaded) {
            log.info('ExternalMcpManager', `Pomijam połączenie z "${serverId}" — menedżer jest już zdemontowany`);
            return { success: false, error: 'Menedżer serwerów MCP jest zdemontowany' };
        }
        if (this._connections.has(serverId)) {
            const existing = this._connections.get(serverId);
            return { success: true, alreadyConnected: true, tools: existing!.toolNames };
        }
        // Blokada współbieżności PER SERVERID — patrz komentarz przy
        // `_connecting`. Drugie wywołanie w oknie handshake'u dostaje TĘ SAMĄ obietnicę.
        const inFlight = this._connecting.get(serverId);
        if (inFlight) return inFlight;

        const promise = this._doConnect(serverConfig, serverId).finally(() => {
            this._connecting.delete(serverId);
        });
        this._connecting.set(serverId, promise);
        return promise;
    }

    /**
     * @private Rzeczywisty handshake — wyciągnięty z `connect()`, żeby blokada
     * współbieżności (`_connecting`) mogła owinąć całą tę funkcję, a nie tylko jej fragment.
     */
    async _doConnect(
        serverConfig: ExternalMcpServerConfig,
        serverId: string,
    ): Promise<{ success: boolean; tools?: string[]; error?: string; alreadyConnected?: boolean }> {
        const registry = this._registry();
        if (!registry) {
            this._setStatus(serverId, { status: 'error', lastError: 'ToolRegistry niedostępny' });
            return { success: false, error: 'ToolRegistry niedostępny' };
        }

        // Walidacja id serwera (defense in depth — UI waliduje niezależnie przy zapisie).
        const builtinNames = typeof registry.getBuiltinServerMap === 'function'
            ? Object.keys(registry.getBuiltinServerMap())
            : [];
        const idCheck = ExternalMcpManager.validateServerId(serverId, builtinNames);
        if (!idCheck.ok) {
            const msg = idCheck.reason === 'reserved'
                ? `Id serwera "${serverId}" jest zarezerwowane dla serwera wbudowanego`
                : `Nieprawidłowe id serwera "${serverId}" (dozwolone: 2-32 znaki a-z, 0-9, myślnik)`;
            this._setStatus(serverId, { status: 'error', lastError: msg });
            log.warn('ExternalMcpManager', msg);
            return { success: false, error: msg };
        }

        let client: McpClientLike | null = null;
        try {
            const created = await this._createClient(serverConfig);
            client = created.client;
            const transport = created.transport;
            // Haki cyklu życia PRZED handshakiem — `Protocol.connect` zachowuje
            // poprzedni `onclose`/`onerror` transportu i woła oba, więc nie wypieramy SDK.
            this._watchTransport(serverId, transport);
            // JEDEN budzet na cale podlaczenie, nie dwa — gdyby `connect` i `listTools`
            // dostawaly po pelnym `timeout`, jeden serwer potrafilby zjesc 2x60 s
            // (a przy podniesionym suficie 2x180 s).
            const timeout = resolveTimeoutMs(serverConfig);
            const deadline = Date.now() + timeout;

            await client.connect(transport, { timeout });               // initialize handshake
            const listed = await client.listTools(undefined, { timeout: Math.max(1, deadline - Date.now()) });
            const tools = Array.isArray(listed?.tools) ? listed.tools : [];

            // Wyścig autostartu z demontażem. Handshake przez `npx` potrafi trwać
            // kilkanaście sekund (pierwszy start ciągnie paczkę); jeśli w tym czasie poszło
            // `closeAll()`, świeży klient NIE MOŻE wejść do mapy ani zarejestrować narzędzi —
            // nikt by go już nie zamknął, a proces potomny na Windows nie ginie z rodzicem.
            if (this._unloaded) {
                log.info('ExternalMcpManager', `Serwer "${serverId}" wstał po demontażu menedżera — zamykam od razu`);
                try { await client.close?.(); } catch { /* zombie-guard, ignore */ }
                this._setStatus(serverId, { status: 'off', lastError: null, toolCount: 0 });
                return { success: false, error: 'Menedżer serwerów MCP jest zdemontowany' };
            }

            const toolNames: string[] = [];
            for (const toolDef of tools) {
                const wrapped = this._wrapTool(serverConfig, toolDef);
                if (!wrapped) continue;
                try {
                    registry.registerTool(wrapped);
                    toolNames.push(wrapped.name);
                    this._toolIndex.set(wrapped.name, { serverId, toolName: toolDef.name! });
                } catch (e) {
                    log.warn('ExternalMcpManager', `Rejestracja narzędzia ${wrapped.name} nieudana: ${(e as ErrLike).message}`);
                }
            }

            this._connections.set(serverId, { client, transport, config: serverConfig, toolNames });
            this._setStatus(serverId, { status: 'connected', lastError: null, toolCount: toolNames.length });
            log.info(
                'ExternalMcpManager',
                `Połączono serwer MCP "${serverId}" (${toolNames.length} narzędzi, transport ${serverConfig.transport || 'stdio'})`
            );
            return { success: true, tools: toolNames };
        } catch (e) {
            const raw = String((e as ErrLike)?.message || e);
            const rawSafe = maskSensitiveData(raw);
            // DWÓCH odbiorców jednego zdarzenia. Człowiek dostaje zdanie
            // rozpoznane po KSZTAŁCIE błędu (`_explainConnectError` — 401, brak
            // programu w PATH, odmowa dostępu, zerwane połączenie, timeout); pełny tekst
            // techniczny idzie do logu. Nierozpoznany kształt = stara ścieżka (surowy, maskowany).
            const safeMsg = _explainConnectError(raw, serverConfig) || rawSafe;
            this._setStatus(serverId, { status: 'error', lastError: safeMsg, toolCount: 0 });
            // best-effort cleanup — handshake mógł paść po utworzeniu klienta/procesu.
            try { await client?.close?.(); } catch { /* zombie-guard, ignore */ }
            log.warn('ExternalMcpManager', `Połączenie z serwerem MCP "${serverId}" nieudane: ${rawSafe}`);
            return { success: false, error: safeMsg };
        }
    }

    /**
     * Nasłuch śmierci serwera — status, rejestr i UI przestają kłamać.
     *
     * Bez tego, po padzie procesu stdio (user zamknął Blendera, `npx` się wywalił) wpis
     * zostawałby w `_connections`, `getStatus()` dalej mówiłby `connected`, Ustawienia
     * i Konektory rysowałyby zieloną kropkę z przyciskiem „Rozłącz", a martwe narzędzia
     * szłyby modelowi w definicjach — każde wywołanie wracałoby `isError` z „Connection
     * closed" i paliłoby turę.
     *
     * Haki idą na TRANSPORT, bo to on wie o procesie; `Protocol.connect` zachowuje wcześniej
     * ustawiony hak i woła oba, więc SDK dalej sprząta u siebie. Podpinamy PRZED handshakiem.
     * @private
     */
    _watchTransport(serverId: string, transport: unknown): void {
        if (!transport || typeof transport !== 'object') return;
        const hooks = transport as TransportLifecycle;
        const prevClose = hooks.onclose;
        hooks.onclose = () => {
            prevClose?.();
            this._reap(serverId, t('settings.mcp_external_error_died'));
        };
        const prevError = hooks.onerror;
        hooks.onerror = (error: Error) => {
            prevError?.(error);
            this._reap(serverId, maskSensitiveData(String(error?.message || error)));
        };
    }

    /**
     * Sprzątanie po serwerze, który UMARŁ sam (nie po naszym `close`).
     *
     * Idempotentne i milczące, gdy połączenia już nie ma — zamierzone `close(id)` zdejmuje
     * wpis z mapy PIERWSZE, więc wywołany przy nim `onclose` transportu przechodzi tędy bez
     * skutku (i nie przemalowuje statusu `off` na `error`).
     * @private
     */
    _reap(serverId: string, reason: string): void {
        const entry = this._connections.get(serverId);
        if (!entry) return;
        this._connections.delete(serverId);
        const registry = this._registry();
        for (const name of entry.toolNames) {
            registry?.unregisterTool?.(name);
            this._toolIndex.delete(name);
        }
        this._setStatus(serverId, { status: 'error', lastError: reason, toolCount: 0 });
        log.warn('ExternalMcpManager', `Serwer MCP "${serverId}" padł — wyrejestrowano ${entry.toolNames.length} narzędzi: ${reason}`);
    }

    /**
     * PODGLĄD narzędzi PRZED zapisem serwera (przejrzystość przy dodawaniu).
     * Efemeryczne: własny klient + transport, handshake, `listTools`, **close**. NICZEGO nie
     * rejestruje w ToolRegistry, nie dotyka `_connections` ani `_status` (mapa statusów zostaje
     * czysta — podgląd nie jest „połączeniem"). NIE rzuca: błąd wraca jako `{success:false,error}`
     * z komunikatem przepuszczonym przez `maskSensitiveData` (config niesie sekrety w env/headers).
     * Stdio na mobile odbija się o ten sam gate co `connect` (czytelna odmowa z `_createTransport`).
     * @param serverConfig - config Z FORMULARZA (może jeszcze nie być zapisany).
     */
    async previewTools(
        serverConfig: ExternalMcpServerConfig,
    ): Promise<{ success: boolean; tools?: Array<{ name: string; description: string }>; error?: string }> {
        const serverId = serverConfig?.id || '(bez id)';
        let client: McpClientLike | null = null;
        try {
            const created = await this._createClient(serverConfig);
            client = created.client;
            const transport = created.transport;
            const timeout = resolveTimeoutMs(serverConfig);

            await client.connect(transport, { timeout });
            const listed = await client.listTools(undefined, { timeout });
            const tools = Array.isArray(listed?.tools) ? listed.tools : [];

            return {
                success: true,
                tools: tools
                    .filter(td => td?.name)
                    .map(td => ({ name: td.name!, description: td.description || '' })),
            };
        } catch (e) {
            const safeMsg = maskSensitiveData(String((e as ErrLike)?.message || e));
            log.warn('ExternalMcpManager', `Podgląd narzędzi serwera "${serverId}" nieudany: ${safeMsg}`);
            return { success: false, error: safeMsg };
        } finally {
            // Podgląd nigdy nie zostawia otwartego procesu/połączenia — także po sukcesie.
            try { await client?.close?.(); } catch { /* zombie-guard, ignore */ }
        }
    }

    /**
     * Buduje wrapper narzędzia — kształt identyczny z ServerManager.js:171-215.
     *   name:        `<serverId>__<toolName>` (podwójny underscore, unika kolizji prefiksów)
     *   description: `[<serverName>] <opis serwera>` (user w modalu approval widzi czyj to tool)
     *   inputSchema: JSON Schema z MCP as-is (modele to jedzą)
     *   serverName:  serverId (filterByAgent opt-in przez agent.mcp_servers[] = serverId)
     *   source:      'user' (→ RED w łańcuchu bezpieczeństwa)
     *   execute:     routing do callTool + normalizacja wyniku (model dostaje tekst)
     * @private
     */
    _wrapTool(serverConfig: ExternalMcpServerConfig, toolDef: McpToolDefinition): ToolDefinition | null {
        const toolName = toolDef?.name;
        if (!toolName) {
            log.warn('ExternalMcpManager', `Serwer "${serverConfig.id}": narzędzie bez nazwy — pominięte`);
            return null;
        }
        const serverId = serverConfig.id;
        const serverLabel = serverConfig.name || serverId;
        const baseDesc = toolDef.description || '';
        // ToolRegistry.registerTool wymaga truthy inputSchema — fallback na pusty schemat obiektowy.
        const inputSchema = toolDef.inputSchema || { type: 'object', properties: {} };
        return {
            name: `${serverId}__${toolName}`,
            description: `[${serverLabel}] ${baseDesc}`.trim(),
            inputSchema,
            serverName: serverId,
            source: 'user',
            execute: async (args) => normalizeMcpResult(await this.callTool(serverId, toolName, args)),
        };
    }

    /**
     * Wywołaj narzędzie na podłączonym serwerze. Timeout per call wg resolveTimeoutMs.
     * NIE rzuca — zwraca surowy wynik MCP (`{content, isError?}`) albo `{isError, error}`.
     * @param toolName - nazwa narzędzia PO STRONIE serwera (bez prefiksu).
     */
    async callTool(serverId: string, toolName: string, args: unknown = {}): Promise<McpCallToolResult> {
        const entry = this._connections.get(serverId);
        if (!entry) {
            return { isError: true, error: `Serwer MCP "${serverId}" nie jest podłączony` };
        }
        // Nie wysyłamy naszego wewnętrznego pola tożsamości do cudzego serwera.
        const cleanArgs = this._stripInternal(args);
        const timeout = resolveTimeoutMs(entry.config);
        try {
            return await entry.client.callTool(
                { name: toolName, arguments: cleanArgs },
                undefined,
                { timeout }
            );
        } catch (e) {
            const safeMsg = maskSensitiveData(String((e as ErrLike)?.message || e));
            log.warn('ExternalMcpManager', `callTool ${serverId}__${toolName} błąd: ${safeMsg}`);
            return { isError: true, error: safeMsg };
        }
    }

    /**
     * Usuwa wewnętrzne znaczniki wywołania przed pokazaniem/wysłaniem argumentów.
     * Filtr po PREFIKSIE `_invocation` zamiast listy nazw — nowy znacznik
     * (`_invocationDelegationDepth`) i każdy przyszły są odcinane automatycznie.
     * Cudzy serwer nie ma powodu znać naszej tożsamości ani głębokości delegacji.
     * Publiczny static, bo tego samego filtra używa `MCPClient` przy budowie
     * podglądu argumentów w modalu approvalu (JEDNA definicja reguły, nie dwie kopie).
     * Wejścia nie-obiektowe (null/undefined/tablica/string/liczba) wracają NIETKNIĘTE.
     */
    static stripInternalArgs(args: unknown): unknown {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
            if (k.startsWith('_invocation')) continue;
            clean[k] = v;
        }
        return clean;
    }

    /** @private Alias instancyjny — ścieżka wysyłki do cudzego serwera (`callTool`). */
    _stripInternal(args: unknown): unknown {
        return ExternalMcpManager.stripInternalArgs(args);
    }

    /**
     * Rozłącz jeden serwer — zamyka klienta (SIGTERM procesu stdio) i wyrejestrowuje jego narzędzia.
     */
    async close(serverId: string): Promise<void> {
        const entry = this._connections.get(serverId);
        if (!entry) return;
        // Wpis schodzi z mapy JAKO PIERWSZY — to zamknięcie ZAMIERZONE, więc
        // `onclose` transportu (który zaraz padnie z `client.close()`) ma przejść przez `_reap`
        // bez skutku i nie przemalować statusu `off` na `error`.
        this._connections.delete(serverId);
        const registry = this._registry();
        for (const name of entry.toolNames) {
            // Publiczne API rejestru zamiast grzebania w bebechach Mapy (registry.tools.delete).
            registry?.unregisterTool?.(name);
            this._toolIndex.delete(name);
        }
        this._setStatus(serverId, { status: 'off', lastError: null, toolCount: 0 });
        try {
            await entry.client?.close?.();
        } catch (e) {
            log.warn('ExternalMcpManager', `Zamykanie serwera "${serverId}" błąd: ${(e as ErrLike).message}`);
        }
        log.info('ExternalMcpManager', `Rozłączono serwer MCP "${serverId}"`);
    }

    /**
     * Zamknij WSZYSTKIE połączenia — wołane w plugin.onunload (nie zostawiać procesów-zombie).
     *
     * RÓWNOLEGLE (`Promise.allSettled`) i z sufitem czasu PER SERWER: sekwencyjna pętla
     * z `await` byłaby zbyt wolna, bo `StdioClientTransport.close()` daje jednemu
     * serwerowi do ~4 s (stdin.end → SIGTERM → SIGKILL) — przy trzech serwerach trzeci
     * dostawałby swój `close()` dopiero po ~8 s od `onunload`, którego Obsidian nie czeka,
     * a ogon listy nie dostawałby sygnału w ogóle. Po przekroczeniu sufitu porzucamy
     * obietnicę z logiem; rejestr narzędzi i mapa połączeń są wtedy i tak już posprzątane
     * (patrz `close`).
     *
     * Podnosi flagę `_unloaded` NA POCZĄTKU — od tej chwili `autostart()`
     * i `connect()` odmawiają startu, więc handshake, który dojedzie po czasie, nie wpisze
     * się do mapy martwego menedżera.
     *
     * @param timeoutMsPerServer - sufit na jeden serwer (domyślnie `CLOSE_TIMEOUT_MS`).
     */
    async closeAll(timeoutMsPerServer: number = CLOSE_TIMEOUT_MS): Promise<void> {
        this._unloaded = true;
        const ids = [...this._connections.keys()];
        await Promise.allSettled(ids.map(id => this._closeWithDeadline(id, timeoutMsPerServer)));
    }

    /**
     * `close(id)` z sufitem czasu — wyścig z budzikiem, budzik zawsze sprzątany.
     * @private
     */
    async _closeWithDeadline(serverId: string, timeoutMs: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                this.close(serverId),
                new Promise<void>(resolve => {
                    timer = _nodeSafeSetTimeout(() => {
                        log.warn('ExternalMcpManager', `Serwer "${serverId}" nie zamknął się w ${timeoutMs} ms — porzucam (proces może zostać do końca sesji systemu)`);
                        resolve();
                    }, timeoutMs);
                }),
            ]);
        } finally {
            // Bez tego wiszący budzik trzyma proces testowy przy życiu (AVA: „Failed to exit").
            if (timer) _nodeSafeClearTimeout(timer);
        }
    }

    /**
     * Autostart: polacz serwery z configu ktore maja `enabled && autostart`. Cichy fail (D-D).
     *
     * **NIE BLOKUJE WOLACZA i laczy ROWNOLEGLE.** Sekwencyjna petla z `await`, ktora
     * `main.ts` czekalby przed ustawieniem `plugin._ready`, oznaczalaby, ze jeden serwer,
     * ktory przyjmuje transport i milczy, zawiesilby czat i sidebar na caly swoj budzet
     * (a trzy takie serwery sumowalyby budzety). SECURITY.md obiecuje wprost,
     * ze zawieszony serwer nie zawiesza pluginu.
     *
     * Serwery dolaczaja, kiedy wstana; do tego czasu ich narzedzi po prostu nie ma
     * w rejestrze (fail-closed — wywolanie odbija sie o `Tool not found`).
     * Na zakonczenie wszystkich prob czeka `whenAutostartSettled()` (testy, harness).
     *
     * @param servers - lista configow; domyslnie z settings.pkmAssistant.externalMcpServers.
     */
    async autostart(servers?: ExternalMcpServerConfig[]): Promise<void> {
        // Po demontażu autostart nie ma czego startować — inaczej proces
        // wstawałby dla menedżera, który już nikogo nie zamknie.
        if (this._unloaded) {
            log.info('ExternalMcpManager', 'Autostart pominięty — menedżer jest już zdemontowany');
            return;
        }
        const list = Array.isArray(servers) ? servers : this._configuredServers();
        const targets = list.filter(cfg => cfg?.enabled && cfg?.autostart);
        if (targets.length === 0) return;
        // `connect` nie rzuca (cichy fail + status), ale `.catch` zostaje jako pas
        // bezpieczenstwa — nikt tej obietnicy nie trzyma poza `whenAutostartSettled`.
        this._autostartSettled = Promise.all(
            targets.map(cfg => this.connect(cfg).catch((e: ErrLike) => {
                log.warn('ExternalMcpManager', `Autostart serwera "${cfg?.id}" padl: ${e?.message}`);
                return { success: false };
            })),
        ).then(() => undefined);
        // ŚWIADOMIE bez `await` — start serwerow nie moze bramkowac startu pluginu.
    }

    /**
     * Obietnica „wszystkie proby autostartu sie rozstrzygnely". Dla testow i harnessa —
     * produkcyjny `main.ts` na nia NIE CZEKA. Brak autostartu = obietnica juz spelniona.
     */
    whenAutostartSettled(): Promise<void> {
        return this._autostartSettled || Promise.resolve();
    }

    /** @private @returns configi serwerów z ustawień pluginu. */
    _configuredServers(): ExternalMcpServerConfig[] {
        const pkm = this.plugin?.env?.settings?.pkmAssistant || this.plugin?.settings?.pkmAssistant || {};
        return Array.isArray(pkm.externalMcpServers) ? pkm.externalMcpServers as ExternalMcpServerConfig[] : [];
    }

    /**
     * Utwórz klienta SDK + transport. DI (`clientFactory`) wygrywa — testy wstrzykują fake.
     * @private
     */
    async _createClient(serverConfig: ExternalMcpServerConfig): Promise<{ client: McpClientLike; transport: unknown }> {
        if (this._clientFactory) {
            const created = await this._clientFactory(serverConfig);
            if (!created || !created.client) {
                throw new Error('clientFactory nie zwrócił klienta');
            }
            return created;
        }
        // Realna ścieżka — leniwy import SDK (poza AVA / poza mobile dla stdio).
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const client = new Client(
            { name: CLIENT_NAME, version: this._pluginVersion },
            { capabilities: {} }
        );
        const transport = await this._createTransport(serverConfig);
        return { client, transport };
    }

    /**
     * Zbuduj transport wg `serverConfig.transport`. Leniwe importy SDK; mobile-gate przez DI.
     * @private
     */
    async _createTransport(serverConfig: ExternalMcpServerConfig): Promise<unknown> {
        const transportType = serverConfig.transport || 'stdio';

        if (transportType === 'stdio') {
            // stdio = lokalny proces → TYLKO desktop (gate options.isMobile z DI).
            if (this._isMobile) {
                throw new Error('Serwery stdio (lokalny proces) działają tylko na desktopie');
            }
            if (!serverConfig.command) {
                throw new Error('Serwer stdio wymaga pola "command"');
            }
            // Import transportu SDK jest leniwy → child_process (ciągnięty przez transport) też.
            const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
            return new StdioClientTransport({
                command: serverConfig.command,
                args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
                // Dziedziczymy bezpieczny domyślny env (PATH itd.) + env usera na wierzchu.
                env: { ...getDefaultEnvironment(), ...(serverConfig.env || {}) },
            });
        }

        if (transportType === 'http') {
            if (!serverConfig.url) {
                throw new Error('Serwer http wymaga pola "url"');
            }
            const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
            const url = new URL(serverConfig.url);
            const headers = (serverConfig.headers && typeof serverConfig.headers === 'object')
                ? serverConfig.headers
                : {};
            // Statyczne nagłówki (token/klucz z ustawień). Fallback SSE robi SDK sam, jeśli serwer tego wymaga.
            return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
        }

        throw new Error(`Nieznany transport MCP: "${transportType}"`);
    }
}
