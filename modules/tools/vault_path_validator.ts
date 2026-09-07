/**
 * vault_path_validator.js — Sprint 04 Z8 (MCP_PORZADEK_v1 DRY-1).
 *
 * Centralna walidacja path/folder dla wszystkich vault tools (Read/Write/List/Search/Delete/CreateFolder + 5 retrieval z S03).
 * Wcześniej każdy tool miał własny `sanitizePath() + isProtectedPath()` snippet — DRY-1.
 *
 * Helper łączy:
 * 1. `sanitizePath()` — blokuje `../`, `%2e%2e`, null bytes, zero-width unicode (security 33 testów w core/security)
 * 2. `isProtectedPath()` — blokuje ustawienia i kopie pluginu (`.pkm-assistant/settings.json`,
 *    `.pkm-assistant/settings.last-good.json`, `.pkm-assistant/backups`, `.pkm-assistant/logs`,
 *    `.pkm-assistant/agents/<agent>/memory/sessions`) oraz `.env` i `data.json`
 * 3. Empty/null check
 *
 * Returns shape `{ ok: bool, safePath: string, error: string|null, code: string|null }`.
 * Code = 'invalid_path' | 'protected' | 'empty' — pozwala tool'om mapować na własne i18n keys.
 */
import { isProtectedPath, sanitizePath } from '../../core/index.js';

/** Kod odmowy — tool mapuje go na własny klucz i18n. */
export type VaultPathErrorCode = 'invalid_path' | 'protected' | 'empty';

/** Wynik walidacji ścieżki vaulta. */
interface VaultPathValidation {
    ok: boolean;
    safePath: string;
    error: string | null;
    code: VaultPathErrorCode | null;
}

/** Opcje walidacji — patrz opisy przy `validateVaultPath`. */
interface VaultPathOptions {
    allowEmpty?: boolean;
    allowProtected?: boolean;
    adminAccess?: boolean;
    allowSkillsRead?: boolean;
}

/** Agent w zakresie, jaki czytają helpery tożsamości: nazwa + flaga admina. */
export interface AgentIdentityLike {
    name?: string;
    admin_access?: unknown;
}

/**
 * Minimalny widok AgentManagera, jakiego potrzebują helpery tożsamości niżej.
 * Wszystko opcjonalne — narzędzia wołają te metody defensywnie (`?.`).
 */
interface PathValidatorAgentManager {
    getActiveAgent?: () => AgentIdentityLike | null | undefined;
    getAgent?: (name: string) => AgentIdentityLike | null | undefined;
}

/** Minimalny widok pluginu: tylko `agentManager`. */
export interface PathValidatorPlugin {
    agentManager?: PathValidatorAgentManager | null;
}

/** Argumenty wywołania narzędzia w zakresie, jaki czytają helpery tożsamości. */
interface InvocationArgs {
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/**
 * Validate vault path with full security stack.
 *
 * @param rawPath - Path z user/agent input
 * @param options.allowEmpty - Czy pusty string jest OK (np. dla list root). Default false.
 * @param options.allowProtected - Czy ścieżki chronione (ustawienia, kopie, logi, `.env`, `data.json`) dozwolone (rare exception). Default false.
 * @param options.adminAccess - A1: jawny dostęp administracyjny agenta;
 *   otwiera protected + `.pkm-assistant`, ale NIE omija sanitizePath. Default false.
 * @param options.allowSkillsRead - D17: pozwól CZYTAĆ przepisy skilli pod
 *   `.pkm-assistant/skills/` (tylko read/list). Zapis/kasowanie tam NIE przekazują tej flagi.
 *   Default false.
 */
export function validateVaultPath(rawPath: unknown, options: VaultPathOptions = {}): VaultPathValidation {
    const {
        allowEmpty = false,
        allowProtected = false,
        adminAccess = false,
        allowSkillsRead = false
    } = options;

    if (rawPath == null || rawPath === '') {
        if (allowEmpty) {
            return { ok: true, safePath: '', error: null, code: null };
        }
        return { ok: false, safePath: '', error: 'Path is empty', code: 'empty' };
    }

    if (typeof rawPath !== 'string') {
        return { ok: false, safePath: '', error: 'Path must be a string', code: 'invalid_path' };
    }

    const safePath = sanitizePath(rawPath);
    if (!safePath && safePath !== '') {
        return { ok: false, safePath: '', error: 'Path failed sanitization (../, %2e%2e, null byte, zero-width unicode)', code: 'invalid_path' };
    }

    if (!allowProtected && !adminAccess && isProtectedPath(safePath)) {
        return { ok: false, safePath, error: 'Path is protected (.pkm-assistant/settings.json, .env, data.json, ...)', code: 'protected' };
    }

    // E1.8 (znalezione smoke'iem): `.pkm-assistant/` jest poza zasięgiem narzędzi vaulta.
    // Agent czyta SWOJĄ pamięć przez memory_* (strict per-agent guard) — a vault_read
    // przez fallback adapterowy pozwalał czytać pamięci INNYCH agentów i pliki indeksu
    // semantycznego (wektory + pełny spis ścieżek vaulta). Fail-closed dla całej rodziny
    // vault tools (read/write/delete/list/... — wszystkie walidują tutaj).
    const lower = safePath.toLowerCase();
    if (!allowProtected && !adminAccess && (lower === '.pkm-assistant' || lower.startsWith('.pkm-assistant/'))) {
        // D17 (E2.4): JEDEN wyjątek — przepisy skilli (.pkm-assistant/skills/**) wolno CZYTAĆ.
        // Model odkrywa skille cienkim indeksem w system promptcie (nazwa + opis + ścieżka),
        // a pełny przepis wciąga narzędziem `read` (i listuje `list`). To TYLKO-ODCZYT: `write`/
        // `delete`/`create_folder` nie przekazują allowSkillsRead → ich blokada bez zmian (izolacja
        // pamięci agentów + indeksu semantycznego nietknięta). Cudzy przepis to zwykły markdown —
        // twardy płot jest gdzie indziej (whitelisty narzędzi + indeks per agent).
        const isSkillsPath = lower === '.pkm-assistant/skills' || lower.startsWith('.pkm-assistant/skills/');
        if (!(allowSkillsRead && isSkillsPath)) {
            return { ok: false, safePath, error: 'Path is protected (.pkm-assistant — agent memories & semantic index)', code: 'protected' };
        }
    }

    return { ok: true, safePath, error: null, code: null };
}

/**
 * Convenience: validate folder path (allowEmpty defaults true — list root flow).
 */
export function validateVaultFolder(rawFolder: unknown, options: VaultPathOptions = {}): VaultPathValidation {
    return validateVaultPath(rawFolder, { allowEmpty: true, ...options });
}

/**
 * Tożsamość wołającego: ZAUFANE `_invocationAgentName` wstrzyknięte przez `MCPClient`,
 * a w jego braku aktywny agent. Model nie podrabia tej nazwy sam — to ta sama tożsamość,
 * na której stoi `invocationHasAdminAccess` niżej.
 *
 * S30 Z3: JEDNA kopia (było 3 identyczne — Read/List/SearchTool).
 *
 * @param args - Argumenty wywołania narzędzia.
 * @param agentManager - `plugin.agentManager`.
 */
export function getInvocationAgentName(
    args: InvocationArgs | null | undefined,
    agentManager: PathValidatorAgentManager | null | undefined,
): string | null {
    return (args?._invocationAgentName as string) || agentManager?.getActiveAgent?.()?.name || null;
}

/**
 * Rozwiąż admin_access po ZAUFANEJ tożsamości wstrzykniętej przez MCPClient.
 * Model nie może sam nadać sobie flagi: MCPClient nadpisuje `_invocationAgentName`
 * przed wykonaniem narzędzia, a tu odczytujemy profil z AgentManagera.
 */
export function invocationHasAdminAccess(
    args: InvocationArgs | null | undefined,
    plugin: PathValidatorPlugin | null | undefined,
): boolean {
    const manager = plugin?.agentManager;
    if (!manager) return false;

    const invocationName = args?._invocationAgentName;
    const agent = invocationName
        ? manager.getAgent?.(invocationName as string)
        : manager.getActiveAgent?.();

    return agent?.admin_access === true;
}
