import { log } from '../../core/utils/Logger.js';
// AUD-bledy-027: `toolResultStatus` = jedna reguła „co jest porażką narzędzia" (klient, czat, suby).
import { AccessGuard, maskSensitiveData, normalizeAutonomy, sanitizePath, toolResultStatus, getAgentSafeName } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
// E2.1: kanoniczny parser tool_calls żyje w modules/agent-loop. MCPClient tylko deleguje.
import { parseToolCalls as parseToolCallsCanonical } from '../agent-loop/index.js';
// E2.5/E2.6: wsteczna kompatybilność nazw narzędzi — stare nazwy retrieval → search,
// stare prymitywy plikowe (vault_read/write/list/delete/create_folder + memory_read/*) → read/list/write/...
import { resolveToolAlias } from './toolAliases.js';
import { isHiddenVaultPath } from './vault_adapter_io.js';
// K11 (AUD-security-051): nazwa pliku notatki w modalu zgody liczona TA SAMA funkcja,
// ktora liczy ja `MemorySaveTool` przy zapisie — zero drugiej, rozjezdzajacej sie kopii.
import { makeMemoryNoteFilename } from '../memory/index.js';
// S33 Z3: jeden filtr znaczników `_invocation*` dla wysyłki i dla podglądu w approvalu.
import { ExternalMcpManager } from './ExternalMcpManager.js';
import type { PermissionDecision, PermissionedAgent, ScopeFolders } from '../../core/index.js';
import type { ModelResponse, ParsedToolCall } from '../agent-loop/index.js';

/** Złapany błąd — `catch` daje `unknown`, a kod czyta z niego tylko `.message`. */
type ErrLike = { message?: string };

/** Uchwyt pliku z Vault API — klient tylko przekazuje go dalej do `vault.read`. */
type VaultFileHandle = object;

/**
 * Argumenty wywołania narzędzia widziane PRZEZ KLIENTA. Wypisane są wyłącznie pola, które ten
 * plik faktycznie czyta (targetPath do approvalu, tryb zapisu do diffa); resztę niesie index
 * signature, bo worek pochodzi od modelu i każde narzędzie ma własny schemat.
 */
export interface ToolCallArgs {
    path?: string;
    folder?: string;
    file?: string;
    targetPath?: string;
    name?: string;
    fact?: string;
    filename?: string;
    content?: string;
    type?: string;
    section?: string;
    to?: string;
    to_agent?: string;
    subject?: string;
    query?: string;
    url?: string;
    prompt?: string;
    size?: string;
    task?: string;
    aspect?: string;
    mode?: string;
    action?: string;
    old_text?: string;
    new_text?: string;
    [extra: string]: unknown;
}

/** Obsidianowe API w zakresie, w jakim dotyka go klient (podgląd diffa przed zapisem). */
export interface MCPClientApp {
    vault: {
        getAbstractFileByPath(path: string): VaultFileHandle | null;
        read(file: VaultFileHandle): Promise<string>;
        adapter?: {
            exists?(path: string): Promise<boolean>;
            read(path: string): Promise<string>;
        };
    };
}

/** Rejestr narzędzi w zakresie, w jakim dotyka go klient. */
export interface MCPToolRegistryLike {
    getTool(name: string): ClientTool | null;
    getToolDefinitions(): unknown[];
    getAllToolNames?(): string[];
    getBuiltinServerForTool?(name: string): string | null;
    /**
     * K3: oś narzędziowa agenta (disabled_tools + opt-in `mcp_servers[]`). Ta sama metoda liczy
     * listę WIDOCZNYCH narzędzi (`ToolRegistry.filterByAgent`) i bramkuje WYKONANIE tutaj.
     * Opcjonalna, bo testy i harness podstawiają częściowe atrapy rejestru — prawdziwy
     * `ToolRegistry` zawsze ją ma.
     */
    checkToolAxis?(
        agent: unknown,
        toolName: string,
    ): { allowed: boolean; reason?: string; serverName?: string };
}

/**
 * Narzędzie widziane przez KLIENTA — minimum, którego dotyka ten plik. Świadomie NIE jest to
 * `ToolDefinition` z rejestru: `inputSchema` klienta nie interesuje, `execute` dostaje tu jeszcze
 * `app` i `plugin` (DI z runtime'u), a fabryki mogą dołożyć `contextExtractor` (Sprint 04 Z10).
 * `ToolDefinition` pasuje do tego kształtu strukturalnie.
 */
export interface ClientTool {
    name: string;
    description: string;
    execute(args: Record<string, unknown>, app?: unknown, plugin?: unknown): Promise<unknown>;
    serverName?: string;
    source?: string;
    contextExtractor?: (
        args: ToolCallArgs,
        ctx: { agentName: string | null; plugin: MCPClientPlugin },
    ) => { targetPath?: string; approvalContext?: Record<string, unknown> } | null | undefined;
    [extra: string]: unknown;
}

/**
 * Kontekst wywołania wyciągnięty z argumentów: co realnie jest celem akcji + co pokazać
 * w oknie zgody. K1 dokłada dwa pola opisujące KANONIZACJĘ ścieżki (patrz `_canonicalizeToolContext`).
 */
interface ToolContext {
    /** Cel akcji: ścieżka vaultowa (już kanoniczna) albo — dla akcji nie-vaultowych — zapytanie/adresat/prompt. */
    targetPath: string;
    approvalContext: Record<string, unknown>;
    /** Ścieżki nie da się sprowadzić do formy kanonicznej → odmowa fail-closed, bez pytania usera. */
    invalidPath?: boolean;
    /** Pole argumentów, z którego wzięto ścieżkę — wołacz podmienia w nim wartość na kanoniczną. */
    canonicalPathField?: 'path' | 'folder' | 'file' | 'targetPath' | 'output_path';
}

/** Plugin widziany przez klienta — same bramki bezpieczeństwa i rejestry, nic więcej. */
export interface MCPClientPlugin {
    permissionSystem: {
        checkPermission(
            agent: PermissionedAgent,
            action: string,
            targetPath?: string | null,
            opts?: { autonomy?: string | null; scopeFolders?: ScopeFolders | null },
        ): PermissionDecision;
        requiresApproval(
            action: string,
            targetPath: string | null | undefined,
            toolName?: string | null,
            agent?: PermissionedAgent | null,
            autonomy?: string | null,
            riskContext?: { operationMode?: string | null; isExternalTool?: boolean },
        ): boolean;
    };
    approvalManager: {
        // `agentName` bywa `null` (wywołanie bez aktywnego agenta) — core deklaruje `string`,
        // ale to jest realny kształt tego, co ten klient wysyła. `result` jest tu `string`,
        // a nie unią `ApprovalOutcome` z core: klient tylko porównuje go z literałami, a luźniejszy
        // typ przyjmuje zarówno prawdziwego `ApprovalManagera`, jak i atrapy z testów.
        requestApproval(action: Record<string, unknown> & { type: string; agentName: string | null }): Promise<ApprovalResultLike>;
    };
    // Obie metody są WYMAGANE, bo kod woła je raz przez `?.()`, a raz wprost (`getActiveAgent()`),
    // więc opcjonalność samych metod nie odpowiadałaby temu, czego klient faktycznie oczekuje.
    agentManager?: {
        getAgent(name: string | null): PermissionedAgent | null | undefined;
        getActiveAgent(): PermissionedAgent | null | undefined;
    } | null;
    externalMcpManager?: {
        isExternalTool?(name: string): boolean;
        getToolActionType?(name: string): string | null;
    } | null;
}

/** Wynik pytania o zgodę — luźniejszy odpowiednik `ApprovalResult` z core (patrz niżej). */
type ApprovalResultLike = { result: string; reason?: string; instruction?: string };

/** Wywołanie narzędzia tak, jak przychodzi od modelu (parser zwraca ten kształt). */
export interface ToolCall {
    /** Unique ID of the call. */
    id?: string;
    /** Name of the tool to execute. */
    name: string;
    /** Arguments for the tool (JSON string or object). */
    arguments?: unknown;
}

/** Dodatkowe opcje wykonania (autonomia czatu + kaganiec delegacji z S33 Z1 + adres zwrotny F2). */
export interface ExecuteToolCallOptions {
    autonomy?: string | null;
    delegationDepth?: number;
    scopeFolders?: ScopeFolders | null;
    /**
     * F2: adres zwrotny wołającego (kto i z której rozmowy zleca). Klient go NIE BUDUJE —
     * podaje go wołacz (faza B: czat), a tu jest tylko wstrzykiwany do args jako
     * `_invocationOrigin`, tym samym wzorem co `_invocationAgentName`.
     */
    origin?: { agentName: string; sessionPath?: string; tabKey?: string } | null;
    /**
     * K11 (AUD-security-072): whitelista narzędzi WOŁAJĄCEGO (dla biegu suba — jego
     * przecięcie rodzic∩sub). Klient jej nie interpretuje: wstrzykuje ją do args jako
     * `_invocationToolNames`, żeby `delegate` policzył whitelistę wnuka względem suba,
     * który go zlecił, a nie względem agenta głównego. Brak = pole usuwane.
     */
    callerToolNames?: string[] | null;
}

/**
 * Wynik narzędzia w zakresie, w jakim dotyka go klient PO wykonaniu: post-filtr whitelisty
 * (krok 7) i doklejenie noty aliasu. Narzędzia zwracają własne kształty — te pola są opcjonalne.
 */
interface ToolExecutionResult {
    success?: boolean;
    /** AUD-bledy-027: znacznik porażki dopisywany przez normalizację (krok 8b niżej). */
    isError?: boolean;
    error?: string;
    scope?: string;
    files?: unknown[];
    results?: unknown[];
    /** K2: spis `artifact_list` — przechodzi przez ten sam post-filtr whitelisty co `list`/`search`. */
    artifacts?: unknown[];
    count?: number;
    total?: number;
    totalCount?: number;
    alias_note?: string;
}

/**
 * Werdykt uprawnień w `executeToolCall`: albo domyślny „wolno" (bez `reason`), albo pełny
 * `PermissionDecision` z PermissionSystem.
 */
type LocalPermissionResult = { allowed: boolean; requiresApproval: boolean; reason?: string };

/**
 * AUD-bledy-021: ile żyje wpis w pamięci odmów (ms).
 *
 * Pamięć odmów ma jedno zadanie — nie pozwolić modelowi ponawiać w kółko akcji, której user
 * właśnie odmówił. Do tej naprawy nie wygasała NIGDY: `MCPClient` powstaje raz na cykl życia
 * pluginu, `clearDenials()` nie miało w produkcji ani jednego wołacza, a klucz narzędzia bez
 * ścieżki to `<narzędzie>::*`, czyli CAŁE narzędzie. Jedno „Odmów" na serwerze MCP odbijało
 * więc każde następne wywołanie — w nowej zakładce, jutro rano — bez pokazania modala, a
 * jedynym resetem był restart pluginu. Kwadrans pokrywa rozmowę na jeden temat i wygasa,
 * zanim user zdąży zmienić zdanie.
 */
const DENIAL_TTL_MS = 15 * 60 * 1000;

/** Opcje konstruktora (haki testowe / adaptery). */
export interface MCPClientOptions {
    diffModalFactory?: ((app: MCPClientApp, options: DiffApprovalOptions) => { waitForApproval(): Promise<unknown> }) | null;
    /** AUD-bledy-021: nadpisanie TTL pamięci odmów (ms). Domyślnie `DENIAL_TTL_MS`. */
    denialTtlMs?: number;
}

/** Wejście modala diffa (5b) — ten sam kształt dla haka testowego i dla `DiffModal`. */
export interface DiffApprovalOptions {
    path: string;
    oldContent: string;
    newContent: string;
    /** Kontrakt `DiffModal` mówi `string`; runtime bywa bez agenta — stąd asercja u wołacza. */
    agentName: string;
}

const ACTION_TYPE_MAP: Record<string, string> = {
    'ask_user': 'vault.read',
    // E2.6 prymitywy (scope vault|memory dla read/list). Ten sam actionType co dawne vault_*.
    'read': 'vault.read',
    'list': 'vault.read',
    'write': 'vault.write',
    'delete': 'vault.delete',
    'create_folder': 'vault.create_folder',
    // Legacy vault_* names (E2.6 aliases → read/list/write/delete/create_folder). Zachowane w mapie
    // akcji na wypadek wywołania po starej nazwie (alias remapuje name zanim tu trafimy).
    'vault_read': 'vault.read',
    'vault_write': 'vault.write',
    'vault_list': 'vault.read',
    'vault_delete': 'vault.delete',
    'vault_create_folder': 'vault.create_folder',
    'search': 'vault.read', // E2.5 unified search (scope vault/memory)
    // Legacy retrieval names (E2.5 aliases → search). Zachowane w mapie akcji na wypadek
    // wywołania po starej nazwie (alias remapuje name→search zanim tu trafimy, ale mapa
    // pozostaje spójna i chroni przed 'unknown' gdyby alias nie zadziałał).
    'vault_search': 'vault.read',
    'vault_filter_yaml': 'vault.read',
    'vault_grep': 'vault.read',
    'vault_links': 'vault.read',
    'vault_semantic': 'vault.read',
    'vault_glob': 'vault.read',
    'memory_save': 'memory.write',
    'memory_read': 'vault.read',
    'memory_delete': 'memory.write',
    'memory_sessions': 'vault.read',
    'memory_summaries': 'vault.read',
    'memory_list_summaries': 'vault.read',
    'memory_read_summary': 'vault.read',
    'memory_filter_yaml': 'vault.read',
    'memory_grep': 'vault.read',
    'memory_links': 'vault.read',
    'memory_semantic': 'vault.read',
    // skill_list/skill_execute skasowane w E2.4 (D17) — brak wpisu w mapie akcji.
    'delegate': 'delegate',
    // `agent_message` skasowane w S28 (D3) — wpis zostaje jako fail-safe dla starych historii
    // sesji / promptów, żeby wywołanie po nieistniejącej nazwie nie wpadło w 'unknown'.
    'agent_message': 'agent.message',
    // K17 (AUD-security-109): `agent_delegate` → `agent.message`, NIE `delegate`.
    // Akcja opisuje SKUTEK wywołania, a skutkiem delegacji jest list w cudzej skrzynce
    // (`sendAgentMail`, dokładnie ten sam kod co `kom_send`). Sama propozycja przekazania
    // rozmowy niczego w świecie nie zmienia — to guzik, który klika user. Póki akcją był
    // `delegate`, wysyłka jechała pod przełącznikiem delegacji (domyślnie CICHY), a modal
    // opisywał ją jako delegację zamiast powiedzieć, że coś wychodzi do cudzej skrzynki.
    // `delegate` (bieg sub-agenta) zostaje nietknięty — to inna akcja i inny skutek.
    'agent_delegate': 'agent.message',
    // E2.9 gatunek 2 — todo (jednorazówka w .pkm-assistant/; read-side, poza approvalem).
    'todo': 'vault.read',
    // E2.9 artefakty żywe (gatunek 1). create/update = zapis do folderu artefaktów (approval OFF
    // domyślnie, patrz PermissionSystem); read/list = odczyt. Silnik buduje ścieżki (brak targetPath).
    'artifact_create': 'artifact.create',
    'artifact_update': 'artifact.update',
    'artifact_read': 'artifact.read',
    'artifact_list': 'artifact.read',
    'web_search': 'web.search',
    // K11 (AUD-security-069): `web_read` ma WLASNY typ akcji. Wspolny `web.search` znaczyl,
    // ze jeden przelacznik "Wyszukiwanie w internecie" zdejmowal pytanie takze z pobierania
    // adresu wskazanego przez model, a modal oglaszal wyjscie na sieciowy adres jako wyszukiwanie.
    'web_read': 'web.read',
    'add_text_to_image': 'image.generate',
    // Komunikator v3 (S28 D3): trzy prymitywy poczty. `kom_send` = wysyłka (agent.message),
    // `kom_list` / `kom_read` = odczyt własnej skrzynki (read-only).
    'kom_send': 'agent.message',
    'kom_list': 'vault.read',
    'kom_read': 'vault.read',
    'generate_image': 'image.generate',
};

/**
 * Main client for handling MCP tool calls from AI agents.
 */
export class MCPClient {
    declare app: MCPClientApp;
    declare plugin: MCPClientPlugin;
    declare toolRegistry: MCPToolRegistryLike;
    declare diffModalFactory: MCPClientOptions['diffModalFactory'];
    /**
     * agentName → ("toolName::targetPath" → moment wygaśnięcia wpisu, ms epoch).
     * AUD-bledy-021: wpis WYGASA (patrz `DENIAL_TTL_MS`) — wcześniej był to `Set` bez końca życia.
     */
    declare _deniedActions: Map<string, Map<string, number>>;
    /** AUD-bledy-021: TTL pojedynczego wpisu w pamięci odmów (ms). */
    declare _denialTtlMs: number;

    /**
     * @param app - Obsidian App instance.
     * @param plugin - Plugin instance (access to permissionSystem, approvalManager).
     * @param toolRegistry - Instance of ToolRegistry.
     * @param options - Test hooks / optional adapters.
     */
    constructor(app: MCPClientApp, plugin: MCPClientPlugin, toolRegistry: MCPToolRegistryLike, options: MCPClientOptions = {}) {
        this.app = app;
        this.plugin = plugin;
        this.toolRegistry = toolRegistry;
        this.diffModalFactory = options.diffModalFactory || null;
        this._denialTtlMs = Number.isFinite(options.denialTtlMs) && (options.denialTtlMs as number) >= 0
            ? options.denialTtlMs as number
            : DENIAL_TTL_MS;

        this._deniedActions = new Map();
    }

    // ─── Denial memory helpers ─────────────────────────────

    _getDenialKey(toolName: string, targetPath?: string | null): string {
        return `${toolName}::${targetPath || '*'}`;
    }

    /**
     * Czy ta akcja jest jeszcze objęta wcześniejszą odmową usera.
     *
     * AUD-bledy-021: wpis ma TERMIN WAŻNOŚCI. Wygasły jest po drodze usuwany, żeby mapa nie
     * puchła przez cały cykl życia pluginu, a narzędzie wróciło do normalnej ścieżki pytania.
     */
    _isDenied(agentName: string, toolName: string, targetPath?: string | null): boolean {
        const denied = this._deniedActions.get(agentName);
        if (!denied) return false;
        const key = this._getDenialKey(toolName, targetPath);
        const expiresAt = denied.get(key);
        if (expiresAt === undefined) return false;
        if (Date.now() >= expiresAt) {
            denied.delete(key);
            if (denied.size === 0) this._deniedActions.delete(agentName);
            log.debug('MCPClient', `Odmowa wygasła — ${toolName} pyta ponownie`);
            return false;
        }
        return true;
    }

    _recordDenial(agentName: string, toolName: string, targetPath?: string | null): void {
        if (!this._deniedActions.has(agentName)) {
            this._deniedActions.set(agentName, new Map());
        }
        this._deniedActions.get(agentName)!.set(this._getDenialKey(toolName, targetPath), Date.now() + this._denialTtlMs);
    }

    /**
     * Czyści pamięć odmów (całą albo jednego agenta).
     *
     * AUD-bledy-021: to jest droga NATYCHMIASTOWA — do zawołania przy przełączeniu sesji /
     * agenta, gdyby czat kiedyś chciał to robić jawnie (dziś nie woła tego nikt w produkcji).
     * Siatką bezpieczeństwa jest TTL wpisu (`DENIAL_TTL_MS`), żeby brak wołacza nie znaczył
     * „odmowa na zawsze".
     */
    clearDenials(agentName?: string | null): void {
        if (agentName) {
            this._deniedActions.delete(agentName);
        } else {
            this._deniedActions.clear();
        }
    }

    _getActionLabel(toolName: string): string {
        const key = `mcp.action_label.${toolName}`;
        const label = t(key);
        return label !== key ? label : toolName;
    }

    _shouldRequestApproval({ actionType, targetPath, toolName, agent, permRequiresApproval, autonomy, args = {} }: {
        actionType: string;
        targetPath: string;
        toolName: string;
        agent: PermissionedAgent | null | undefined;
        permRequiresApproval: boolean;
        autonomy: string;
        args?: ToolCallArgs;
    }): boolean {
        if (!agent) return permRequiresApproval;

        const tool = this.toolRegistry?.getTool?.(toolName);
        const isExternalTool = !!(
            tool?.source === 'user'
            || (tool?.serverName && !this.toolRegistry.getBuiltinServerForTool?.(toolName))
        );

        // A3: jedna decyzja dla KAŻDEGO narzędzia. PermissionSystem klasyfikuje
        // konkretne wywołanie jako GREEN/YELLOW/RED; cudze serwery są zawsze RED.
        return this.plugin.permissionSystem.requiresApproval(
            actionType,
            targetPath,
            toolName,
            agent,
            autonomy,
            {
                // K11 (AUD-security-020): dla `write` liczy się WYŁĄCZNIE `mode` — to z niego
                // narzędzie wyprowadza skutek (brak = `replace`, czyli nadpisanie = RED).
                // `action` jest tu już przeniesione na `mode` przez `normalizeArgsAliases`;
                // ten warunek to druga warstwa dla wołaczy, którzy normalizację ominęli.
                operationMode: (toolName === 'write' || toolName === 'vault_write')
                    ? (args?.mode || null)
                    : (args?.mode || args?.action || null),
                isExternalTool,
            }
        );
    }

    async _requestDiffApproval(options: DiffApprovalOptions): Promise<unknown> {
        if (this.diffModalFactory) {
            return this.diffModalFactory(this.app, options).waitForApproval();
        }
        const { DiffModal } = await import('../ui-components/index.js');
        return new DiffModal(this.app, options).waitForApproval();
    }

    /**
     * K1 (AUD-security-015/018) — sprowadza ścieżkę vaultową do FORMY KANONICZNEJ, tak żeby
     * bramka uprawnień i samo narzędzie oglądały DOKŁADNIE ten sam ciąg.
     *
     * Rozpoznanie „to jest ścieżka" jest celowo zachowawcze: kanonizujemy tylko wtedy, gdy
     * wyciągnięty `targetPath` jest DOSŁOWNIE wartością jednego z pól-ścieżek w argumentach
     * (`path` / `folder` / `file` / `targetPath`). Dzięki temu gałęzie nie-ścieżkowe zostają
     * nietknięte same z siebie: `web_search` niesie tam `args.query`, `web_read` — `args.url`,
     * `kom_send` — adresata, `generate_image` — prompt, a narzędzia pamięci budują ścieżkę same.
     *
     * @returns `invalidPath` = ścieżki nie da się uratować (traversal, absolutna, null byte) →
     *   wołacz ma odmówić fail-closed. `canonicalPathField` = pole argumentów do podmiany,
     *   żeby `execute` dostał ten sam ciąg, który przeszedł przez bramkę.
     * @private
     */
    _canonicalizeToolContext(args: ToolCallArgs, ctx: ToolContext): ToolContext {
        const raw = ctx.targetPath;
        // Brak celu albo umowny root listingu (`/`) — zachowanie bez zmian.
        if (!raw || raw === '/') return ctx;

        // K2: `output_path` dołącza do pól-ścieżek — `add_text_to_image` oddaje bramce CEL ZAPISU,
        // więc kanonizacja musi objąć też jego (i podmienić wartość w argumentach, żeby narzędzie
        // zapisało dokładnie tam, gdzie pozwoliła bramka).
        const field = (['path', 'folder', 'file', 'targetPath', 'output_path'] as const)
            .find(key => typeof args?.[key] === 'string' && args[key] === raw);
        if (!field) return ctx;

        const canonical = sanitizePath(raw);
        if (!canonical) {
            log.warn('MCPClient', `Ścieżka nie do uratowania (odmowa fail-closed): ${raw}`);
            return { ...ctx, invalidPath: true };
        }
        return { ...ctx, targetPath: canonical, canonicalPathField: field };
    }

    /**
     * Extract targetPath and approval context per tool type.
     * Returns meaningful display info for each tool.
     */
    _extractToolContext(toolName: string, args: ToolCallArgs, agentName: string | null): ToolContext {
        let targetPath = '';
        let approvalContext: Record<string, unknown> = {};

        // Sprint 04 Z10: prefer tool-defined contextExtractor (DRY-2 — moves switch logic into each tool factory).
        // Backward compat: switch below is fallback for tools that haven't migrated yet.
        const tool = this.toolRegistry?.getTool?.(toolName);
        if (tool && typeof tool.contextExtractor === 'function') {
            try {
                const extracted = tool.contextExtractor(args, { agentName, plugin: this.plugin }) || {};
                // K1: kanonizacja obejmuje TAKŻE tę ścieżkę — to nią chodzą dzisiejsze prymitywy
                // (`read`/`write`/`delete`/`list`/`create_folder`), switch niżej jest już tylko zapasem.
                return this._canonicalizeToolContext(args, {
                    targetPath: extracted.targetPath ?? '',
                    approvalContext: extracted.approvalContext ?? {},
                });
            } catch (e) {
                log.warn('MCPClient', `contextExtractor for ${toolName} failed:`, (e as ErrLike).message);
                // fall through to switch fallback
            }
        }

        // E3.1: narzędzia zewnętrznych serwerów MCP (ExternalMcpManager) NIE są operacjami
        // vaultowymi → pusty targetPath = brak path-checków AccessGuard (wzór web/delegate).
        // Rozpoznanie jawnie przez rejestr external managera — user-JS serwery serverManagera
        // (też source:'user') nadal mają własne vault paths i NIE wpadają tutaj.
        if (this.plugin?.externalMcpManager?.isExternalTool?.(toolName)) {
            // R4 (szew): targetPath EMPTY -> checkPermission/AccessGuard bez pseudo-sciezki (agent z
            // focusFolders nie dostaje falszywego deny). approvalTarget = prefiksowana nazwa idzie
            // WYLACZNIE do approvala -> regula "zawsze zezwalaj" per KONKRETNE narzedzie
            // (external.call::<serverId>__<tool>), a nie hurtem po external.call::*.
            // S33 Z3: do approvalu idą też PEŁNE argumenty wywołania — user ma zobaczyć, CO
            // dokładnie leci do cudzego serwera, a nie tylko nazwę narzędzia. Znaczniki
            // wewnętrzne (`_invocation*`) tniemy tym samym filtrem co przy wysyłce, żeby modal
            // nie pokazywał bytów, których serwer i tak nigdy nie zobaczy.
            return {
                targetPath: '',
                approvalContext: {
                    externalServer: tool?.serverName || '',
                    approvalTarget: toolName,
                    externalArgs: ExternalMcpManager.stripInternalArgs(args),
                },
            };
        }

        switch (toolName) {
            // Vault tools — use args.path
            case 'vault_write':
            case 'vault_delete':
            case 'vault_read':
            case 'vault_create_folder':
                targetPath = args.path || '';
                break;

            // Vault tools — use args.folder
            case 'vault_list':
            case 'vault_search':
                targetPath = args.folder || '/';
                break;

            // Memory save/delete — show brain.md path
            case 'memory_save': {
                const safeName = getAgentSafeName(agentName) || 'unknown';
                const noteName = args.name || args.fact || 'note';
                // K11 (AUD-security-051): JEDNA reguła nazewnicza — ta sama, którą `MemorySaveTool`
                // liczy przy zapisie (`makeMemoryNoteFilename`: NFKD + zdjęcie diakrytyków + cięcie
                // do 80 znaków + prefiks typu). Druga, uproszczona kopia pokazywała userowi
                // w modalu inną nazwę pliku niż ta, która realnie powstawała.
                targetPath = `.pkm-assistant/agents/${safeName}/memory/brain/${makeMemoryNoteFilename(args.type, noteName)}`;
                approvalContext.memoryContent = args.content || args.fact || '';
                approvalContext.memorySection = args.type || '';
                break;
            }
            case 'memory_read': {
                const safeName = getAgentSafeName(agentName) || 'unknown';
                targetPath = `.pkm-assistant/agents/${safeName}/memory/brain/${args.filename || ''}`;
                break;
            }
            case 'memory_delete': {
                const safeName = getAgentSafeName(agentName) || 'unknown';
                targetPath = `.pkm-assistant/agents/${safeName}/memory/brain.md`;
                approvalContext.memoryContent = args.fact || '';
                approvalContext.memorySection = args.section || '';
                break;
            }

            // Poczta (S28) — pokaż adresata + temat/treść w approvalu.
            case 'kom_send':
                targetPath = args.to || args.to_agent || 'agent';
                approvalContext.messageSubject = args.subject || '';
                approvalContext.messageContent = args.content || '';
                break;

            // K17 (AUD-security-109): delegacja wysyła list, więc modal ma pokazać to, co
            // pokazuje przy poczcie — DO KOGO i CO wychodzi. Tematu tu nie składamy: buduje
            // go narzędzie z klucza i18n, a druga kopia tej samej reguły rozjechałaby się
            // przy pierwszej zmianie (lekcja K11). Bez tematu modal mówi po prostu
            // „chce wysłać wiadomość do agenta X" i pokazuje podgląd treści.
            case 'agent_delegate':
                targetPath = args.to_agent || 'agent';
                approvalContext.messageContent = typeof args.context_summary === 'string' ? args.context_summary : '';
                break;

            // Web search — show query
            case 'web_search':
                targetPath = args.query || '';
                break;

            // Web read — show URL
            case 'web_read':
                targetPath = args.url || '';
                break;

            // K2 (AUD-security-048): case `generate_image` USUNIĘTY. Oddawał tu `args.prompt`
            // jako „cel", więc AccessGuard i bariera `scope.folders` suba oceniały tekst pisany
            // przez model (wystarczyło zacząć prompt od nazwy własnego folderu, żeby strażnik
            // powiedział „whitelist"), a dwa realne zapisy szły gdzie indziej. Cel liczy dziś
            // `contextExtractor` narzędzia (folder zapisu z ustawień); prompt jedzie osobnym
            // polem do okna zgody. Brak case'a = fallback `default` → pusty cel → odmowa
            // fail-closed w `PermissionSystem` (image.generate jest w TARGET_REQUIRED_ACTIONS).

            // Delegate — sub-agent task is NOT a vault path, skip AccessGuard
            case 'delegate':
                targetPath = '';
                approvalContext.delegateTask = args.task || '';
                approvalContext.delegateAspect = args.aspect || '';
                break;

            // E2.9: idea_review/plan_review/chat_todo skasowane (aliasy remapują name PRZED tym miejscem).

            // skill_execute skasowane w E2.4 (D17) — brak case.

            default:
                targetPath = args.path || args.targetPath || args.file || args.folder || '';
        }

        return this._canonicalizeToolContext(args, { targetPath, approvalContext });
    }

    /**
     * Executes a tool call requested by an AI agent.
     * @param toolCall - The tool call object (`id`, `name`, `arguments` — JSON string albo obiekt).
     * @param agentName - The name of the agent requesting the execution.
     * @param opts.autonomy - Autonomy mode ('yolo'|'edge'|'all') from the chat/turn.
     *   Missing → normalized to 'edge' (≈ dzisiejsze defaulty). E2.3 (D21) — patrz autonomy.js.
     * @param opts.delegationDepth - S33 Z1: piętro delegacji wołającego (0/brak = główny
     *   czat). Wstrzykiwane do args jako `_invocationDelegationDepth`, tak jak `_invocationAgentName` —
     *   model nie poda go sam, bo i tak jest nadpisywane.
     * @param opts.scopeFolders - S33 Z1: foldery `scope.folders` sub-agenta. Dodatkowe,
     *   koniunkcyjne zawężenie ścieżek vaultowych (przecięcie rodzic∩sub) — patrz AccessGuard.
     * @param opts.origin - F2: adres zwrotny wołającego (`{agentName, sessionPath?, tabKey?}`).
     *   Wstrzykiwany do args jako `_invocationOrigin`; brak = pole usuwane. Klient go NIE buduje —
     *   składa go wołacz (faza B: czat), a `delegate` przenosi do rejestru biegów subów.
     *
     * K4 (AUD-security-050): znormalizowana autonomia jedzie też do args jako `_invocationAutonomy`
     * (zawsze nadpisywane). Czyta ją `delegate` i zamraża w biegu suba — patrz `SubAgentRunner`.
     * @returns The result of the tool execution or an error object.
     */
    async executeToolCall(
        toolCall: ToolCall,
        agentName: string | null | undefined,
        opts: ExecuteToolCallOptions = {},
    ): Promise<unknown> {
        const toolStart = Date.now();
        const autonomy = normalizeAutonomy(opts.autonomy);
        // S33 Z1: kaganiec delegacji. Głębokość > 0 znaczy „wołane z wnętrza sub-agenta".
        const delegationDepth = Number(opts.delegationDepth) || 0;
        const scopeFolders = Array.isArray(opts.scopeFolders) && opts.scopeFolders.length > 0
            ? opts.scopeFolders
            : null;
        // F2: klient origin'u NIE buduje — bierze go od wołacza i wstrzykuje do args.
        const origin = opts.origin || null;
        // K11 (AUD-security-072): whitelista wołającego — przelot do args, bez interpretacji.
        const callerToolNames = Array.isArray(opts.callerToolNames) && opts.callerToolNames.length > 0
            ? opts.callerToolNames.filter((n): n is string => typeof n === 'string' && n.length > 0)
            : null;
        log.debug('MCPClient', `executeToolCall: ${toolCall.name} (agent: ${agentName}, autonomy: ${autonomy})`);

        try {
            // 1. Parse arguments
            // Asercja od razu na worek argumentów: gałąź stringowa poniżej i tak go parsuje.
            let args = toolCall.arguments as ToolCallArgs;
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args) as ToolCallArgs;
                } catch (e) {
                    throw new Error(`Failed to parse arguments for tool ${toolCall.name}: ${(e as ErrLike).message}`);
                }
            }
            // Sprint 04 Z9 — args alias resolver (backward compat dla user MCP servers + deprecated tool inputSchemas).
            // image_path/file/filepath → path (canonical Sprint 04 naming standard).
            // Breaking compat planowane na v3.0 — do tego czasu emit deprecation warning + accept obu form.
            args = MCPClient.normalizeArgsAliases(args, toolCall.name);
            // E2.5/E2.6: gdy model/YAML woła starą nazwę (nieznaną w registry) → przemapuj na
            // kanoniczne narzędzie (search / read / list / write / delete / create_folder) z
            // przekształceniem argumentów. Nota o zastąpieniu/przemianowaniu dołączana do wyniku.
            let aliasNote: string | null = null;
            if (!this.toolRegistry.getTool(toolCall.name)) {
                const originalName = toolCall.name;
                const mapped = resolveToolAlias(originalName, args);
                if (mapped) {
                    aliasNote = mapped.name === 'search'
                        ? t('mcp.alias.replaced', { old: originalName })
                        : t('mcp.alias.renamed', { old: originalName, new: mapped.name });
                    log.info('MCPClient', `[alias] ${originalName} → ${mapped.name}`);
                    toolCall = { ...toolCall, name: mapped.name, arguments: mapped.arguments };
                    args = mapped.arguments;
                }
            }
            const invocationAgentName = agentName || this.plugin.agentManager?.getActiveAgent?.()?.name || null;
            const argsWithContext: ToolCallArgs = (args && typeof args === 'object' && !Array.isArray(args))
                ? { ...args, _invocationAgentName: invocationAgentName }
                : { _invocationAgentName: invocationAgentName };
            // S33 Z1: ten sam wzorzec co `_invocationAgentName` — zaufany znacznik od runtime'u,
            // nie od modelu. Poza delegacją pole jest USUWANE (model mógłby podać ujemną
            // wartość i wyzerować licznik głębi u dziecka), w delegacji zawsze nadpisywane.
            if (delegationDepth > 0) {
                argsWithContext._invocationDelegationDepth = delegationDepth;
            } else {
                delete argsWithContext._invocationDelegationDepth;
            }
            // F2: adres zwrotny zlecenia — ten sam wzorzec zaufanego znacznika. Brak opcji =
            // pole USUWANE (model mógłby podać cudzą sesję i tam wysłać powiadomienie).
            if (origin && typeof origin === 'object' && typeof origin.agentName === 'string') {
                argsWithContext._invocationOrigin = origin;
            } else {
                delete argsWithContext._invocationOrigin;
            }
            // K4 (AUD-security-050): tryb autonomii TURY jako zaufany znacznik (ten sam wzorzec).
            // Czyta go `delegate`, żeby zamrozić tryb pytań w biegu suba — bieg z czatu leci
            // zawsze w tle, więc `plugin.currentAutonomy` zmienia się pod nim przy każdym
            // przełączeniu zakładki. Zawsze NADPISYWANE (model nie podniesie sobie uprawnień).
            argsWithContext._invocationAutonomy = autonomy;
            // K11 (AUD-security-008/072): zakres folderów i whitelista narzędzi WOŁAJĄCEGO —
            // ten sam wzorzec zaufanego znacznika. Czyta je `delegate`, żeby dziecko dostało
            // PRZECIĘCIE (nigdy szerzej niż ma sub zlecający). Brak = pole USUWANE, bo model
            // podstawiłby sobie własną, szerszą listę.
            if (scopeFolders) {
                argsWithContext._invocationScopeFolders = scopeFolders;
            } else {
                delete argsWithContext._invocationScopeFolders;
            }
            if (callerToolNames) {
                argsWithContext._invocationToolNames = callerToolNames;
            } else {
                delete argsWithContext._invocationToolNames;
            }
            log.debug('MCPClient', `${toolCall.name} args:`, args);

            // 2. Get Agent object from AgentManager (not just the name!)
            //    K3: agent jest potrzebny PRZED rejestrem — oś narzędziowa to bramka wykonania,
            //    a nie filtr UI, więc musi zapaść zanim cokolwiek pobierzemy i wykonamy.
            const agent = this.plugin.agentManager?.getAgent(invocationAgentName)
                || this.plugin.agentManager?.getActiveAgent();
            if (!agent) {
                log.warn('MCPClient', `Agent nie znaleziony: ${invocationAgentName}, pomijam sprawdzenie uprawnień`);
            }

            // 3. K3 (AUD-security-052 / 004) — OŚ NARZĘDZIOWA AGENTA JAKO BRAMKA.
            //    Ta sama reguła, którą `ToolRegistry.filterByAgent` liczy przy budowie listy
            //    widocznych narzędzi (`checkToolAxis`), decyduje tu o WYKONANIU. Do K3 istniał
            //    tylko filtr widoczności, więc model, który znał nazwę wyłączonego narzędzia
            //    (stara sesja, notatka, transkrypt innego agenta), wołał je i przechodził.
            //    Nazwa jest już KANONICZNA (aliasy rozwiązane wyżej) — inaczej stara nazwa
            //    (`vault_write` → `write`) byłaby obejściem wyłączenia.
            //    Odmowa jest fail-closed i NIE pyta usera: to nie jest ryzyko do zaakceptowania,
            //    tylko narzędzie, którego user agentowi nie dał.
            if (agent && typeof this.toolRegistry.checkToolAxis === 'function') {
                const axis = this.toolRegistry.checkToolAxis(agent, toolCall.name);
                if (!axis.allowed) {
                    const reason = axis.reason === 'server_not_opted_in'
                        ? t('perm.server_not_opted_in', { server: String(axis.serverName || '?') })
                        : t('perm.tool_disabled', { tool: toolCall.name });
                    log.warn('MCPClient', `Oś narzędziowa ODMOWA (${axis.reason}): ${toolCall.name}`);
                    throw new Error(`Permission denied: ${reason}`);
                }
            }

            // 4. Get tool from registry
            const tool = this.toolRegistry.getTool(toolCall.name);
            if (!tool) {
                throw new Error(`Tool not found: ${toolCall.name}`);
            }

            // 5. Check permissions (only if we have an agent)
            let actionType = ACTION_TYPE_MAP[toolCall.name] || 'unknown';
            // E3.1: narzędzia zewnętrznych serwerów MCP (ExternalMcpManager) → akcja `external.call`.
            // Bez tego actionType zostałby 'unknown' → checkPermission zrobiłby fail-closed deny.
            if (actionType === 'unknown' && this.plugin.externalMcpManager) {
                const externalActionType = this.plugin.externalMcpManager.getToolActionType?.(toolCall.name);
                if (externalActionType) actionType = externalActionType;
            }
            // Extract targetPath + build approval context per tool type.
            // K21 (AUD-security-103): worek idzie tu PO nadpisaniu zaufanych znaczników
            // (`argsWithContext`), a nie surowy `args`. Do K21 `contextExtractor` widział
            // `_invocation*` w kształcie, w jakim podał je MODEL — a rodzina `artifact_*`
            // wyprowadza z tożsamości CAŁY cel akcji. Bramka oceniała wtedy inną ścieżkę niż
            // ta, do której pisało `execute` (ono zawsze dostaje worek zaufany).
            const { targetPath, approvalContext, invalidPath, canonicalPathField } =
                this._extractToolContext(toolCall.name, argsWithContext, invocationAgentName);

            // K1 (AUD-security-018): ścieżki nie do uratowania (traversal, absolutna, null byte,
            // zero-width unicode) odbijają się TUTAJ — bez pytania usera i bez wołania narzędzia.
            if (invalidPath) {
                throw new Error('Permission denied: Invalid path');
            }
            // K1 (AUD-security-015): narzędzie ma dostać DOKŁADNIE ten ciąg, który oceniła bramka.
            // Podmiana idzie do OBU worków, bo `argsWithContext` (to on trafia do `execute`)
            // powstał wyżej jako kopia `args`.
            if (canonicalPathField) {
                args[canonicalPathField] = targetPath;
                argsWithContext[canonicalPathField] = targetPath;
            }

            // memory write tools operate on agent's own .pkm-assistant/ files — bypass AccessGuard
            // (they use adapter/AgentMemory directly, not vault paths). E2.6: odczyt pamięci przez
            // read/list scope=memory NIE jest tu — jest bramkowany uprawnieniem memory wewnątrz tooli
            // (wzór SearchTool), żeby agent bez serwera vault nie dostał vaultu tylną furtką.
            const MEMORY_TOOLS = ['memory_save', 'memory_delete'];
            const isMemoryTool = MEMORY_TOOLS.includes(toolCall.name);

            log.debug('MCPClient', `${toolCall.name} permission check: ${actionType} → ${targetPath || '(brak ścieżki)'}`);

            let permResult: LocalPermissionResult = { allowed: true, requiresApproval: false };
            if (agent && !isMemoryTool) {
                // S33 Z1: `scopeFolders` to DODATKOWY warunek (koniunkcja) — wszystkie reguły
                // rodzica (No-Go, protected, focusFolders, admin, .pkm-assistant) działają bez zmian.
                permResult = this.plugin.permissionSystem.checkPermission(agent, actionType, targetPath, { autonomy, scopeFolders });

                if (!permResult.allowed) {
                    log.warn('MCPClient', `Permission DENIED: ${permResult.reason}`);
                    throw new Error(`Permission denied: ${permResult.reason}`);
                }
            }

            permResult.requiresApproval = this._shouldRequestApproval({
                actionType,
                targetPath,
                toolName: toolCall.name,
                agent,
                permRequiresApproval: permResult.requiresApproval,
                autonomy,
                args,
            });

            // 6. Handle approval if required
            if (permResult.requiresApproval) {
                // Check denial memory first — instant block without showing modal
                if (invocationAgentName && this._isDenied(invocationAgentName, toolCall.name, targetPath)) {
                    log.info('MCPClient', `Automatyczny blok (wcześniej odmówione): ${toolCall.name} → ${targetPath}`);
                    throw new Error(
                        `Użytkownik WCZEŚNIEJ odmówił ${this._getActionLabel(toolCall.name)} na "${targetPath}". ` +
                        `NIE ponawiaj tej samej akcji. Zapytaj użytkownika czego potrzebuje lub zaproponuj inną ścieżkę.`
                    );
                }

                log.info('MCPClient', `${toolCall.name} wymaga zatwierdzenia usera...`);
                const approved = await this.plugin.approvalManager.requestApproval({
                    type: actionType,
                    toolName: toolCall.name,
                    description: tool.description,
                    targetPath: targetPath,
                    agentName: invocationAgentName,
                    operationMode: args.mode || null,
                    preview: args.content ? `Długość treści: ${args.content.length} znaków` : null,
                    contentPreview: args.content || null,
                    ...approvalContext
                });

                // E2.3 (D21): trzecia ścieżka — przekieruj + kontekst. User zatrzymuje
                // tę akcję i mówi, co zrobić zamiast niej. NIE wykonujemy narzędzia, NIE
                // zapisujemy denial memory i NIE rzucamy — zwracamy NORMALNY wynik
                // tool-calla (string) z instrukcją. Model dostaje go jako wynik i pętla
                // agenta leci dalej.
                if (approved.result === 'redirect') {
                    log.info('MCPClient', `User PRZEKIEROWAŁ: ${toolCall.name} → ${approved.instruction}`);
                    return t('mcp.redirect_result', { instruction: approved.instruction || '' });
                }

                if (approved.result === 'deny') {
                    log.warn('MCPClient', `User ODMÓWIŁ zatwierdzenia: ${toolCall.name}`);
                    if (invocationAgentName) this._recordDenial(invocationAgentName, toolCall.name, targetPath);
                    const reasonPart = approved.reason ? ` Powód: "${approved.reason}".` : '';
                    throw new Error(
                        `Użytkownik odmówił ${this._getActionLabel(toolCall.name)} na "${targetPath}".${reasonPart} ` +
                        `NIE ponawiaj tej akcji. Zapytaj użytkownika czego potrzebuje.`
                    );
                }
                log.debug('MCPClient', `User ZATWIERDZIŁ: ${toolCall.name}`);
            }

            // 6b. Show diff for write create/replace/patch before touching the vault.
            // E2.6: nazwa narzędzia to teraz `write` (alias remapuje vault_write → write wcześniej;
            // sprawdzamy obie na wypadek bezpośredniego wywołania po starej nazwie).
            // E2.3 (D21): w trybie `yolo` POMIJAMY diff modal — yolo = zero pytań. No-Go /
            // pliki chronione / whitelista dalej blokują (są w checkPermission, nie tutaj).
            const writeMode = args.mode || 'replace';
            if (permResult.requiresApproval && autonomy !== 'yolo'
                && (toolCall.name === 'write' || toolCall.name === 'vault_write')
                && ['create', 'replace', 'patch'].includes(writeMode) && args.path) {
                const existingFile = this.app.vault.getAbstractFileByPath(args.path);
                try {
                    let oldContent = '';
                    if (existingFile) {
                        oldContent = await this.app.vault.read(existingFile);
                    } else if (isHiddenVaultPath(args.path) && await this.app.vault.adapter?.exists?.(args.path)) {
                        oldContent = await this.app.vault.adapter!.read(args.path);
                    }
                    // For patch: compute newContent from old_text/new_text.
                    // AUD-code-review-064: sprawdź unikalność old_text TAK SAMO jak WriteTool.execute
                    // (firstIndex/secondIndex → old_text_multiple) — inaczej podgląd diffa pokazuje
                    // userowi zmianę na PIERWSZYM dopasowaniu, user zatwierdza, a realny zapis w
                    // kroku 7 odmawia jako niejednoznaczny (WriteTool.ts). Wieloznaczne dopasowanie
                    // NIE dostaje tu diffa — ta sama sytuacja co „old_text nie znaleziony" (idx===-1):
                    // newContent zostaje `undefined`, więc krok 6b nic nie pokazuje, a krok 7
                    // (`tool.execute`) zwróci userowi prawdziwy, jednoznaczny błąd.
                    let newContent: string | undefined;
                    if (writeMode === 'patch' && args.old_text && typeof args.new_text === 'string') {
                        const firstIndex = oldContent.indexOf(args.old_text);
                        if (firstIndex !== -1) {
                            const secondIndex = oldContent.indexOf(args.old_text, firstIndex + 1);
                            if (secondIndex === -1) {
                                newContent = oldContent.substring(0, firstIndex) + args.new_text + oldContent.substring(firstIndex + args.old_text.length);
                            }
                        }
                    } else {
                        newContent = args.content;
                    }

                    if (typeof newContent === 'string' && oldContent !== newContent) {
                        const diffResult = await this._requestDiffApproval({
                            path: args.path,
                            oldContent,
                            newContent,
                            agentName: invocationAgentName as string
                        });
                        if (diffResult === 'deny') {
                            log.info('MCPClient', `User ODRZUCIŁ diff: ${args.path}`);
                            if (invocationAgentName) this._recordDenial(invocationAgentName, toolCall.name, targetPath);
                            throw new Error(
                                `Użytkownik odrzucił zmiany w "${args.path}". ` +
                                `Zapytaj co zmienić lub zaproponuj inną wersję.`
                            );
                        }
                    }
                } catch (e) {
                    // Re-throw denial errors, ignore read errors (proceed with write)
                    if ((e as ErrLike).message?.includes('odrzucił')) throw e;
                    log.debug('MCPClient', `Diff read error (ignored): ${(e as ErrLike).message}`);
                }
            }

            // 7. Execute tool (pass plugin as 3rd arg for tools that need it, e.g. memory_save)
            let result = await tool.execute(argsWithContext, this.app, this.plugin) as ToolExecutionResult;

            // 7b/7c. E2.9 FAZA D: modale review (IdeaReviewModal → _planStore) i ArtifactProgressModal
            // (polling chat_todo) SKASOWANE. Artefakty żywe mają approval w notatce (guziki B1) i live-widok
            // `todo` w czacie (D2). Aliasy remapują stare wywołania na artifact_create / todo.

            // 7e. E3.2 (2026-07-25): przechwytywanie wyniku generowania obrazu do modala
            // podglądu SKASOWANE — generate_image zapisuje wynik prosto do vaulta.

            // 8. Whitelist post-filtering for list/search results.
            // E2.5/E2.6: `search` i `list` scope=vault filtrują wyniki whitelistą agenta (jak dawny
            // vault_list/vault_search). scope=memory NIE filtrujemy vault-whitelistą — to własna pamięć
            // agenta (bramkowana osobno uprawnieniem memory), inaczej wyniki znikałyby fałszywie.
            // S33 A1: `scopeFolders` tnie wyniki tak samo jak whitelista rodzica (koniunkcja) —
            // bez tego sub ze zwężonym `scope.folders` nie otworzyłby pliku spoza swojego kąta,
            // ale `search`/`list` i tak podałyby mu jego tytuł i fragment treści.
            const isListVault = toolCall.name === 'list' && result?.scope !== 'memory';
            const isSearchVault = toolCall.name === 'search' && result?.scope !== 'memory';
            if (agent && (isListVault || isSearchVault)) {
                const filterOpts = { scopeFolders };
                if (result?.success && result?.files) {
                    result.files = AccessGuard.filterResults(agent, result.files, undefined, filterOpts);
                    result.count = result.files.length;
                    result.totalCount = result.files.length;
                }
                if (result?.success && result?.results) {
                    result.results = AccessGuard.filterResults(agent, result.results, undefined, filterOpts);
                    result.count = result.results.length;
                    result.total = result.results.length;
                }
            }

            // K2 (AUD-security-075/076): spis artefaktów jedzie tym samym filtrem co `list`/`search`.
            // `artifact_list` zwraca gotowe ścieżki notatek, więc agent ze zwężoną whitelistą (albo
            // sub ze `scope.folders`) nie może dostać nazw i ścieżek artefaktów spoza swojego kąta.
            if (agent && toolCall.name === 'artifact_list' && Array.isArray(result?.artifacts)) {
                result.artifacts = AccessGuard.filterResults(agent, result.artifacts, undefined, { scopeFolders });
                result.count = result.artifacts.length;
            }

            // E2.5: dołącz notę o przekierowaniu ze starej nazwy na `search`.
            if (aliasNote && result && typeof result === 'object' && !Array.isArray(result)) {
                result.alias_note = aliasNote;
            }

            // 8b (AUD-bledy-027/058/025): JEDEN punkt normalizacji porażki. Narzędzia wbudowane
            // mówią `{success:false, error}`, a catch niżej / artefakty / external MCP mówią
            // `{isError:true}`. Czat, historia i telemetria czytają jedną flagę, więc dopisujemy
            // ją tutaj — dla KAŻDEGO narzędzia, raz. Oryginalne pola zostają nietknięte
            // (`success`, `error`, `code`, `matches`, …): to nie jest podmiana kształtu, tylko
            // dołożenie znacznika. Reguła „co jest porażką" ma dokładnie jedną kopię —
            // `core/utils/toolResultStatus.ts` (czytają ją też czat i runner subów).
            if (result && typeof result === 'object' && !Array.isArray(result)
                && result.isError !== true && toolResultStatus(result) === 'error') {
                result.isError = true;
            }

            log.tool(toolCall.name, args, result);
            log.timing('MCPClient', `${toolCall.name} wykonanie`, toolStart);
            return result;

        } catch (error) {
            log.error('MCPClient', `${toolCall.name} BŁĄD:`, error);
            // AUD-security-128 (klasa K8/K20): ten komunikat idzie MODELOWI i do transkryptu
            // tury, a komunikat wyjątku bywa całym zrzutem zdarzenia strumienia razem
            // z nagłówkiem `Authorization`. Ta sama maska, co w `SubAgentRunner` i w
            // `ExternalMcpManager` — jedna granica dla wszystkich odbiorców błędu.
            return {
                isError: true,
                error: maskSensitiveData(String((error as ErrLike).message ?? error))
            };
        }
    }

    /**
     * Helper to return tool definitions for AI.
     */
    formatToolsForAI(): unknown[] {
        return this.toolRegistry.getToolDefinitions();
    }

    /**
     * Parsuje tool_calls z odpowiedzi modelu. E2.1: deleguje do kanonicznego parsera
     * w modules/agent-loop (obsługuje 3 kształty: Anthropic content-blocks, root
     * tool_calls, choices[0].message.tool_calls + odsklejanie DeepSeek). Publiczne API
     * BEZ ZMIAN — wołacze zostają na `mcpClient.parseToolCalls(response)`.
     * @param response - odpowiedź modelu.
     * @returns płaskie tool calls `{id, name, arguments}`.
     */
    parseToolCalls(response: ModelResponse | null | undefined): ParsedToolCall[] {
        const knownToolNames = typeof this.toolRegistry?.getAllToolNames === 'function'
            ? this.toolRegistry.getAllToolNames()
            : [];
        return parseToolCallsCanonical(response, {
            knownToolNames,
            // Zachowaj dotychczasowe zachowanie: „znane" = registry.getTool(name) istnieje.
            isToolKnown: (name: string) => !!this.toolRegistry?.getTool?.(name)
        });
    }

    /**
     * Sprint 04 Z9 — args alias resolver.
     *
     * Standardizes inputSchema property names per MCP_PORZADEK_v1:
     *   - `path`   = single file path (canonical)
     *   - `folder` = directory path (canonical)
     *   - `glob`   = glob pattern (canonical)
     *   - `query`  = search string (canonical)
     *
     * Legacy aliases accepted with deprecation warning (breaking removal v3.0):
     *   - `image_path`, `file`, `filepath` → `path`
     *   - `dir`, `directory` → `folder`
     *   - `pattern` → `glob`
     *
     * @param args - tool call arguments
     * @param toolName - for logging context
     * @returns args with canonical names (legacy fields preserved for backward compat)
     */
    static normalizeArgsAliases(args: ToolCallArgs, toolName: string): ToolCallArgs {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return args;

        const aliasMap = {
            image_path: 'path',
            file: 'path',
            filepath: 'path',
            dir: 'folder',
            directory: 'folder',
            pattern: 'glob',
        };

        const normalized = { ...args };
        for (const [legacy, canonical] of Object.entries(aliasMap)) {
            if (legacy in args && !(canonical in args)) {
                normalized[canonical] = args[legacy];
                log.warn('MCPClient', `[deprecated v3.0] ${toolName}: arg "${legacy}" → "${canonical}". Update tool inputSchema albo przekaz "${canonical}" bezposrednio.`);
            }
        }

        return normalized;
    }
}
