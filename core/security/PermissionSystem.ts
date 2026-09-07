/**
 * PermissionSystem
 * Central system for managing agent permissions and access control
 */
import { AccessGuard } from './AccessGuard.js';
import type { GuardedAgent, ScopeFolders } from './AccessGuard.js';
import { isProtectedPath, sanitizePath } from './keySanitizer.js';
import {
    normalizeAutonomy,
    classifyToolRisk,
    TOOL_RISK_LEVELS,
    DEFAULT_AUTONOMY
} from './autonomy.js';
import { t } from '../i18n/index.js';
import { log } from '../utils/Logger.js';

/**
 * Agent widziany przez system uprawnień: to, czego potrzebuje strażnik (`GuardedAgent`)
 * + per-agent przełączniki pytań z profilu.
 */
export interface PermissionedAgent extends GuardedAgent {
    approvalToggles?: Record<string, boolean> | null;
}

/** Werdykt: czy wolno, dlaczego i czy trzeba jeszcze zapytać usera. */
export interface PermissionDecision {
    allowed: boolean;
    reason: string;
    requiresApproval: boolean;
}

/** Opcje `checkPermission` (autonomia czatu + scope sub-agenta). */
export interface CheckPermissionOptions {
    autonomy?: string | null;
    scopeFolders?: ScopeFolders | null;
}

/** Kontekst ryzyka doprecyzowany przez wołacza (MCPClient) przy pytaniu o approval. */
export interface ApprovalRiskContext {
    operationMode?: string | null;
    isExternalTool?: boolean;
}

/**
 * Kształt wpisu dziennika dostępu. AUD-dead-code-174 (2026-09-02): sam bufor (`accessLog`,
 * `maxLogSize`, `logAccess`, `getAccessLog`, `getAgentAccessLog`, `clearAccessLog`) skasowany
 * — zero odbiorców w repo (ani UI, ani test). Typ zostaje jako eksport barrela (parking KL-02,
 * wartości TYPÓW nie kasujemy przy sprzątaniu `core/index.ts`).
 */
export interface AccessLogEntry {
    timestamp: number;
    agent: string | undefined;
    action: string;
    targetPath: string | null | undefined;
    allowed: boolean;
    reason: string;
}

/**
 * Permission types enum
 *
 * E2.3 (D21): YOLO_MODE USUNIĘTY jako typ uprawnienia. „Nie pytaj” to teraz tryb
 * autonomii per-czat (patrz core/security/autonomy.js), NIE uprawnienie agenta.
 */
// E2.8 A5: pola-widma agenta (access_outside_vault/execute_commands/building_agents/
// system_settings/skills_crud) usunięte z katalogu. THINKING zostaje jako KATEGORIA AKCJI
// (bezpieczna krawędź w autonomy — patrz core/security/autonomy.js), nie pole agenta.
export const PERMISSION_TYPES = {
    READ_NOTES: 'read_notes',
    EDIT_NOTES: 'edit_notes',
    CREATE_FILES: 'create_files',
    DELETE_FILES: 'delete_files',
    THINKING: 'thinking',
    MCP: 'mcp',
    WEB_SEARCH: 'web_search'
};

/**
 * Action to permission mapping
 * E2.8 A5: martwe akcje (command.execute/agent.create/skill.create/settings.write — 0 dispatchu)
 * usunięte.
 */
/**
 * K13 (2026-08-23) — akcje, których `targetPath` NIE jest ścieżką vaultową.
 *
 * `web.search` niesie zapytanie, `web.read` adres strony, `agent.message` adresata,
 * `delegate` nazwę roli, `external.call` nazwę narzędzia zewnętrznego serwera. Żadnego z tych
 * ciągów nie wolno kanonizować: `sanitizePath` odrzuciłby zapytanie zaczynające się od
 * `„C:\..."`, adres z długim query (segment > 255 znaków) albo frazę mieszającą alfabety.
 *
 * K14 (2026-08-23) domknęło to piętro niżej: `AccessGuard.checkAccess` z `targetIsVaultPath:
 * false` wraca NATYCHMIAST (`non-vault-target`), więc te ciągi nie są już mierzone także
 * whitelistą `focusFolders`, No-Go ani zakresem suba. Do K14 były — i agent w trybie „Tylko
 * przypisane" tracił przez to wyszukiwarkę, pocztę i delegację w całości. Reszta przepływu
 * TUTAJ jest bez zmian: ryzyko, zgody i `disabled_tools` dalej bramkują te akcje normalnie,
 * a właściwe im granice pilnują ich własne warstwy (rejestr URL, widoczność adresata,
 * przecięcie zakresów delegacji).
 *
 * Zestaw jest jawną WHITELISTĄ wyjątków — nowa akcja domyślnie jest traktowana jak ścieżka
 * (fail-closed). Dopisz ją tu tylko, jeśli jej cel naprawdę nie jest ścieżką.
 */
const NON_VAULT_TARGET_ACTIONS = new Set([
    'web.search',
    'web.read',
    'agent.message',
    'delegate',
    'external.call',
]);

// AUD-dead-code-116/177 (2026-09-02): zdjęty `export` — zero konsumentów poza tym plikiem
// (był reeksportowany z core/index.ts, ale nikt spoza core/ po niego nie sięgał; w tym pliku
// zostaje żywy w checkPermission()).
const ACTION_PERMISSIONS: Record<string, string | undefined> = {
    'vault.read': PERMISSION_TYPES.READ_NOTES,
    'vault.write': PERMISSION_TYPES.EDIT_NOTES,
    'vault.create': PERMISSION_TYPES.CREATE_FILES,
    'vault.create_folder': PERMISSION_TYPES.CREATE_FILES,
    'vault.delete': PERMISSION_TYPES.DELETE_FILES,
    'memory.write': PERMISSION_TYPES.EDIT_NOTES,
    'agent.message': PERMISSION_TYPES.EDIT_NOTES,
    'image.generate': PERMISSION_TYPES.EDIT_NOTES,
    // E2.9: artefakty żywe. create/update piszą TYLKO do folderu artefaktów — mapowane na
    // poziom dostępu (create_files/edit_notes) dla AccessGuard, ale approval domyślnie OFF
    // (APPROVAL_DEFAULTS) — bezpiecznik „write pyta zawsze" świadomie NIE obejmuje artifact_*.
    'artifact.create': PERMISSION_TYPES.CREATE_FILES,
    'artifact.update': PERMISSION_TYPES.EDIT_NOTES,
    'artifact.read': PERMISSION_TYPES.READ_NOTES,
    'mcp.call': PERMISSION_TYPES.MCP,
    'mcp.connect': PERMISSION_TYPES.MCP,
    // E3.1 (Prawdziwy klient MCP): narzędzia zewnętrznych serwerów. Akcja nie-vaultowa (bez
    // path-checks AccessGuard, wzór akcji web) — MCPClient nadaje pusty targetPath. Ryzyko RED
    // liczy classifyToolRisk z isExternalTool (autonomy.js NIETKNIĘTE). Wpis MUSI istnieć jawnie,
    // bo nieznana akcja = fail-closed deny w checkPermission.
    'external.call': PERMISSION_TYPES.MCP,
    'web.search': PERMISSION_TYPES.WEB_SEARCH,
    // K11 (AUD-security-069): pobranie strony to osobna akcja od wyszukiwania (osobna zgoda,
    // osobny opis w modalu). Typ uprawnienia zostaje wspolny — po E2.8 C1 i tak nie bramkuje.
    'web.read': PERMISSION_TYPES.WEB_SEARCH,
    'delegate': PERMISSION_TYPES.MCP
};

/**
 * K2 (AUD-security-075/076/016/048) — akcje, które MUSZĄ podać bramce cel.
 *
 * „Brak celu" nie może znaczyć „przepuść": cała reszta `checkPermission` (No-Go, pliki chronione,
 * whitelista `focusFolders`, `scope.folders` suba) stoi za `if (targetPath)`, więc pusty cel
 * przeskakiwał WSZYSTKO. Tak weszła rodzina `artifact_*` (pisała do vaulta bez ani jednego
 * strażnika) i tak `add_text_to_image` zapisywał pod `output_path`, którego bramka nigdy nie
 * widziała. Te akcje fizycznie dotykają plików, więc pusty cel = błąd wołacza = odmowa fail-closed.
 *
 * Świadomie POZA zestawem (te akcje realnie przychodzą bez celu i tak ma zostać):
 *  - `vault.read` — nazwa myli, bo ta jedna akcja obsługuje też `ask_user`, `todo`,
 *    `kom_list`/`kom_read` oraz `read`/`list`/`search` ze `scope:'memory'`, które CELOWO oddają
 *    pusty cel (pamięć bramkuje osobne uprawnienie wewnątrz narzędzia). Listing roota vaulta
 *    ma cel `'/'`, nie pusty — więc zwykły odczyt vaulta i tak zawsze niesie ścieżkę.
 *  - `memory.write` — `memory_save`/`memory_delete` budują ścieżkę same i w MCPClient omijają
 *    tę bramkę w całości (`MEMORY_TOOLS`), więc pusty cel tu nie występuje.
 *  - akcje nie-vaultowe: `web.*` (zapytanie/URL), `agent.message` (adresat), `delegate`,
 *    `mcp.*`, `external.call` — ich `targetPath` nigdy nie był ścieżką.
 */
export const TARGET_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
    'vault.write',
    'vault.create',
    'vault.create_folder',
    'vault.delete',
    'artifact.create',
    'artifact.update',
    'artifact.read',
    'image.generate',
]);

/**
 * Approval toggle defaults — Group A: default ON (ask), Group B: default OFF (don't ask)
 */
export const APPROVAL_DEFAULTS: Record<string, boolean | undefined> = {
    // A3 YELLOW — odwracalne/ograniczone akcje, pytanie konfigurowalne.
    vault_write: true,
    vault_create_folder: true,
    memory_save: true,
    web_search: true,
    // K11 (AUD-security-069): wlasny klucz, domyslnie PYTAJ. Swiadomie NIE dziedziczy
    // ustawienia `web_search` — user, ktory wyciszyl wyszukiwarke, nie zgodzil sie tym samym
    // na wysylanie danych pod adres wybrany przez model.
    web_read: true,
    generate_image: true,
    // S28 (D3): wysyłka poczty do innego agenta — pytamy domyślnie (user widzi, co wychodzi).
    kom_send: true,
    // Żółte, domyślnie ciche.
    delegate: false,
    // E2.9: artefakty żywe piszą tylko do folderu artefaktów — domyślnie bez pytania (świadome).
    artifact_create: false,
    artifact_update: false,
    todo: false,
    // skill_execute skasowane w E2.4 (D17) — brak wpisu.
};

export class PermissionSystem {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3). Pola świadomie
    // BEZ `private`: to zwykłe pola instancji, których dotykają wołacze w .js (nie chcemy
    // zamykać im drzwi typem).
    declare vault: unknown;
    declare settings: unknown;

    /**
     * @param vault - Obsidian Vault
     * @param settings - Plugin settings
     */
    constructor(vault: unknown, settings: unknown) {
        this.vault = vault;
        this.settings = settings;
    }

    /**
     * Check if agent has permission for an action
     *
     * E2.3 (D21): tryb autonomii (`opts.autonomy`) wpływa TYLKO na `requiresApproval`
     * (czy pytać). NIE nadaje uprawnień i NIE omija granic: No-Go, pliki chronione,
     * brak uprawnienia i whitelista (AccessGuard) blokują niezależnie od trybu.
     * Różnica vs stary YOLO_MODE: `yolo` już NIE przeskakuje hasPermission ani
     * AccessGuard — znosi wyłącznie pytania.
     *
     * @param agent - Agent to check
     * @param action - Action name (e.g., 'vault.read', 'vault.write')
     * @param targetPath - Path being accessed (optional)
     * @param opts - Extra options
     * @param opts.autonomy - Autonomy mode ('yolo'|'edge'|'all'), normalized
     * @param opts.scopeFolders - S33 Z1: foldery `scope.folders` sub-agenta. Gdy
     *   podane, ścieżka w ZWYKŁYM vaulcie musi DODATKOWO leżeć w jednym z nich (przecięcie
     *   rodzic∩sub). Brak/pusta lista = zero nowych ograniczeń.
     */
    checkPermission(
        agent: PermissionedAgent,
        action: string,
        targetPath: string | null | undefined = null,
        opts: CheckPermissionOptions = {},
    ): PermissionDecision {
        const autonomy = normalizeAutonomy(opts.autonomy);
        const hasAdminAccess = agent?.admin_access === true;

        // K1 (AUD-security-015): OBRONA W GŁĄB — ścieżka vaultowa idzie do formy kanonicznej
        // ZANIM ocenią ją No-Go, pliki chronione i AccessGuard. Kanonizacja dzieje się już
        // u wołacza (`MCPClient._extractToolContext`, żeby narzędzie dostało ten sam ciąg),
        // ale bramka nie ma prawa temu ufać — wołaczy jest więcej niż jeden.
        //
        // K12 (2026-08-23): dołączyły akcje `image.*`. Komentarz stał tu wcześniej odwrotnie
        // („image.* niesie prompt, nie ścieżkę") i to była prawda WYŁĄCZNIE przed K2. K2
        // (AUD-security-048/016) przestawił oba narzędzia obrazkowe na prawdziwe cele vaultowe:
        // `generate_image` oddaje bramce FOLDER ZAPISU z ustawień, a `add_text_to_image` — CEL
        // ZAPISU (`args.output_path` albo WYLICZONE `<źródło>_text.<ext>`). Cel wyliczany nie
        // jest dosłownie wartością żadnego pola argumentów, więc `_canonicalizeToolContext`
        // u wołacza go pomija — bramka jest dla niego JEDYNĄ warstwą kanonizacji. Bez tego
        // ta sama ścieżka dostawała dwie różne decyzje: `vault.write` + `./.pkm-assistant/x.png`
        // → DENY, `image.generate` + ten sam ciąg → ALLOW (reprodukcja z nocy 2026-08-23).
        //
        // Akcje realnie nie-vaultowe (`web.*` — zapytanie/URL, `agent.message` — adresat,
        // `external.call`, `delegate`) niosą w `targetPath` co innego niż ścieżkę i ich NIE
        // dotykamy. `'/'` to umowny root listingu — zostaje bez zmian (jak dotąd).
        if (targetPath && targetPath !== '/' && (action.startsWith('vault.') || action.startsWith('image.'))) {
            const canonical = sanitizePath(targetPath);
            if (!canonical) {
                return { allowed: false, reason: 'Invalid path', requiresApproval: false };
            }
            targetPath = canonical;
        }

        // K2 (AUD-security-075/016/048): akcja dotykająca pliku BEZ celu = odmowa fail-closed.
        // Bez tego cały blok niżej jest pomijany (stoi za `if (targetPath)`), a narzędzie i tak
        // zapisuje — tyle że pod ścieżką, której nikt nie sprawdził. `admin_access` NIE zwalnia:
        // to nie jest granica dostępu, tylko wymóg podania celu przez wołacza.
        if (TARGET_REQUIRED_ACTIONS.has(action) && !String(targetPath ?? '').trim()) {
            return { allowed: false, reason: t('perm.no_target'), requiresApproval: false };
        }

        // A1: admin_access jest jedynym jawnym wyjątkiem od No-Go/protected.
        // YOLO nadal nie ma z tym nic wspólnego — autonomia tylko usuwa pytania.
        if (!hasAdminAccess && targetPath && AccessGuard._isNoGo(targetPath)) {
            return { allowed: false, reason: t('perm.nogo_zone'), requiresApproval: false };
        }

        if (!hasAdminAccess && targetPath && isProtectedPath(targetPath)) {
            return { allowed: false, reason: t('perm.protected_file'), requiresApproval: false };
        }

        // E2.8 C1: uprawnienia akcji (read_notes/edit_notes/create_files/delete_files/mcp/
        // web_search) już NIE bramkują — o „wolno" decyduje DOSTĘPNOŚĆ narzędzia (agent.disabled_tools,
        // ToolRegistry.filterByAgent). Zostaje: mapowanie akcji na poziom dostępu (AccessGuard) +
        // krawędź (approval/autonomia). Nieznana akcja = fail-closed (nowe narzędzie musi być
        // zmapowane w ACTION_PERMISSIONS, żeby wiedzieć czy pytać o zgodę).
        const requiredPermission = ACTION_PERMISSIONS[action];
        if (!requiredPermission) {
            log.warn('PermissionSystem', 'Unknown action:', action);
            return { allowed: false, reason: 'Unknown action', requiresApproval: false };
        }

        // Check whitelist (focusFolders) — if agent has them, only whitelisted paths allowed.
        // D21: yolo NIE omija whitelisty — znosi pytania, nie uprawnienia.
        if (targetPath) {
            const writePermissions = new Set([
                PERMISSION_TYPES.EDIT_NOTES,
                PERMISSION_TYPES.CREATE_FILES,
                PERMISSION_TYPES.DELETE_FILES,
            ]);
            const accessLevel = writePermissions.has(requiredPermission) ? 'write' : 'read';
            // S33 Z1: scopeFolders sub-agenta idzie do AccessGuard jako dodatkowa, KONIUNKCYJNA
            // bariera. Nie zastępuje żadnej reguły rodzica — dokłada się do nich.
            // K13: strażnik kanonizuje cel sam (obrona w głąb). Dla akcji `vault.*` / `image.*`
            // to no-op — ścieżka jest już punktem stałym po kanonizacji wyżej. Dla `artifact.*`
            // to JEDYNA warstwa, bo tamtej gałęzi ta bramka nie prostuje. Akcje nie-vaultowe
            // wyłączają kanonizację jawnie (ich cel to zapytanie/URL/adresat, nie ścieżka).
            const accessResult = AccessGuard.checkAccess(agent, targetPath, accessLevel, {
                scopeFolders: opts.scopeFolders,
                targetIsVaultPath: !NON_VAULT_TARGET_ACTIONS.has(action),
            });
            if (!accessResult.allowed) {
                return {
                    allowed: false,
                    reason: accessResult.reason,
                    requiresApproval: false
                };
            }
        }

        // Approval gate — TU wchodzi tryb autonomii (yolo → nigdy nie pyta).
        // Uwaga: dla wywołań z MCPClient wynik jest później doprecyzowany per-tool
        // przez _shouldRequestApproval (dokłada toolName + approvalToggles).
        const requiresApproval = this.requiresApproval(action, targetPath, null, null, autonomy);

        return {
            allowed: true,
            reason: 'Permission granted',
            requiresApproval
        };
    }

    /**
     * Check if action on path requires explicit approval.
     *
     * E2.3 (D21): decyduje TRYB AUTONOMII (`autonomy`):
     *   - 'yolo' → nigdy nie pytaj (false zawsze).
     *   - 'all'  → pytaj o KAŻDE narzędzie (ignoruje approvalToggles/APPROVAL_DEFAULTS),
     *              wyjątek: ask_user (pytanie o zgodę na pytanie = absurd).
     *   - 'edge' → światła A3: GREEN nie pyta; YELLOW respektuje toggle;
     *              RED pyta obowiązkowo i ignoruje toggle.
     *
     * @param action - Action name
     * @param _targetPath - Target path (zachowany w sygnaturze dla zgodności wołaczy
     *   pozycyjnych; od wywałki VaultZones 2026-09-03 żadna gałąź go już nie czyta —
     *   AUD-dead-code-031/115/172/216)
     * @param toolName - Original tool name for toggle lookup
     * @param agent - Agent object for per-agent approval settings
     * @param autonomy - Autonomy mode ('yolo'|'edge'|'all'), normalized here
     * @param riskContext - {operationMode,isExternalTool}
     */
    requiresApproval(
        action: string,
        _targetPath: string | null | undefined,
        toolName: string | null = null,
        agent: PermissionedAgent | null = null,
        autonomy: string | null = DEFAULT_AUTONOMY,
        riskContext: ApprovalRiskContext = {},
    ): boolean {
        const mode = normalizeAutonomy(autonomy);

        // yolo — nie pytamy o nic.
        if (mode === 'yolo') return false;

        // ask_user — NIGDY nie wymaga approval (nawet w 'all'): pytanie o zgodę na
        // zadanie pytania to absurd (D21).
        if (toolName === 'ask_user') return false;

        // all — pytaj o każde narzędzie, ignorując toggle i domyślne bramki.
        if (mode === 'all') return true;

        // ── edge (default): światła A3 ────────────────────────
        const risk = classifyToolRisk({
            action,
            permissionType: ACTION_PERMISSIONS[action],
            toolName,
            operationMode: riskContext.operationMode || null,
            isExternalTool: riskContext.isExternalTool === true,
        });

        if (risk === TOOL_RISK_LEVELS.GREEN) return false;
        if (risk === TOOL_RISK_LEVELS.RED) return true;

        // YELLOW: bazowo pytamy, ale user może świadomie zdjąć bramkę per narzędzie.
        if (toolName) {
            const toggleKey = this._getApprovalToggleKey(toolName);
            if (toggleKey) {
                const agentToggles = agent?.approvalToggles || {};
                const defaultVal = APPROVAL_DEFAULTS[toggleKey];
                const isEnabled = agentToggles[toggleKey] ?? defaultVal;
                if (!isEnabled) return false; // user disabled approval for this tool
                return true;
            }
        }

        // YELLOW bez własnego toggla → pytamy.
        return true;
    }

    /**
     * Map tool name to approval toggle key
     * @private
     */
    _getApprovalToggleKey(toolName: string | null): string | null {
        const map: Record<string, string | undefined> = {
            // E2.6 prymitywy — mapują na te same klucze zapisanych ustawień co dawne vault_*,
            // żeby wcześniejsze przełączniki approvalu usera dalej działały po zmianie nazwy.
            'write': 'vault_write',
            'create_folder': 'vault_create_folder',
            'vault_write': 'vault_write',
            'vault_create_folder': 'vault_create_folder',
            'memory_save': 'memory_save',
            'web_search': 'web_search',
            'web_read': 'web_read',
            'generate_image': 'generate_image',
            'add_text_to_image': 'generate_image',
            'delegate': 'delegate',
            // S28: poczta agenta (YELLOW z własnym przełącznikiem w profilu → Uprawnienia).
            'kom_send': 'kom_send',
            // K17 (AUD-security-109): delegacja jedzie pod przełącznikiem POCZTY, nie delegacji.
            // Przełącznik ma odpowiadać skutkowi: `agent_delegate` zostawia list w cudzej
            // skrzynce dokładnie tak jak `kom_send` (ten sam `sendAgentMail`), a przełącznik
            // `delegate` (domyślnie CICHY) opisuje bieg sub-agenta — zupełnie inną czynność.
            // Skutek uboczny jest zamierzony: user, który wyciszył pocztę, wycisza obie drogi.
            'agent_delegate': 'kom_send',
            // E2.9: artefakty żywe (toggle domyślnie OFF w APPROVAL_DEFAULTS). Stare chat_todo/
            // idea_review/plan_review skasowane — aliasy remapują name na todo/artifact_create PRZED
            // approvalem, więc tu docierają już nowe nazwy (artifact_*).
            'artifact_create': 'artifact_create',
            'artifact_update': 'artifact_update',
            // AUD-code-review-057: `todo` NIE jest read-side bez toggla — odczyt (get/list/read) jest
            // GREEN (autonomy.ts classifyToolRisk), ale zapis jest YELLOW i pyta wg WŁASNEGO,
            // działającego przełącznika APPROVAL_DEFAULTS.todo (domyślnie false), wystawionego
            // w profilu agenta → Uprawnienia. Ten wpis mapy jest realny, nie kosmetyczny.
            'todo': 'todo',
            // skill_execute skasowane w E2.4 (D17) — brak wpisu.
        };
        // `toolName` bywa `null` — indeksowanie mapy nullem zwraca w JS `undefined`, więc
        // wyrażenie zostaje bez zmian, a TS potrzebuje tylko asercji na klucz.
        return map[toolName as string] || null;
    }
}
// AUD-dead-code-175 (2026-09-02): `getPermissionDescription` + `getAllPermissionTypes` SKASOWANE
// — zero wołaczy poza sobą nawzajem (getAllPermissionTypes wołało getPermissionDescription
// wewnętrznie). Komentarz "for UI" kłamał: żaden UI po nie nie sięgał — lista uprawnień w
// profilu agenta czyta dziś `modules/agents/profile/profile_permissions.ts`. Razem z nimi
// poszły klucze i18n `perm.read_notes`/`perm.edit_notes`/`perm.delete_files`/`perm.thinking`/
// `perm.mcp_tools`/`perm.web_search`/`perm.agent_memory`/`perm.guidance_mode` (8 kluczy pl+en).
// `perm.create_files` ZOSTAŁ — ma osobnego, żywego konsumenta: `core/i18n/parity.test.ts:144`.
