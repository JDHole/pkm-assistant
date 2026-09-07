/**
 * ReadTool — jeden prymityw `read` (E2.6, decyzja D5).
 *
 * Konsoliduje 3 dawne narzędzia odczytu: `vault_read` (nota usera) +
 * `memory_read` (notatka brain/ aktualnego agenta) + `memory_read_summary`
 * (podsumowanie L1/L2/L3). Scope w parametrze, nie w nazwie (wzór `search`).
 *
 *   scope=vault (default): Vault API — getAbstractFileByPath → cachedRead.
 *     Walidacja przez validateVaultPath (blokada .pkm-assistant z E1.8).
 *   scope=memory: pamięć AKTUALNEGO agenta (adapter przez AgentMemory).
 *     Bramka uprawnienia memory fail-closed W execute (jak SearchTool),
 *     cross-agent niemożliwy (zawsze pamięć wołającego agenta).
 *
 * TWARDA GRANICA: Vault API nie widzi `.pkm-assistant/` — dlatego scope=memory
 * zostaje na adapterze (AgentMemory), a API-first dotyczy tylko ścieżek vault.
 */
import { validateVaultPath, invocationHasAdminAccess, getInvocationAgentName } from './vault_path_validator.js';
import type { AgentIdentityLike } from './vault_path_validator.js';
import { t } from '../../core/i18n/index.js';
import { MemoryAccessGuard, MEMORY_V3_ERROR_CODES } from '../memory/index.js';
import { isFolderLike } from './vault_binary_io.js';
import type { VaultFileLike } from './vault_binary_io.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `read`. `filename` to legacy alias z dawnego `memory_read`. */
export interface ReadToolArgs {
    path?: unknown;
    filename?: unknown;
    scope?: unknown;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Minimalny widok `App`: Vault API + adapter (fallback dla ścieżek spoza indeksu). */
export interface ReadToolApp {
    vault: {
        getAbstractFileByPath: (path: string) => VaultFileLike | null;
        cachedRead: (file: VaultFileLike) => Promise<string>;
        adapter: { read: (path: string) => Promise<string> };
    };
}

/** Pamięć agenta w zakresie, jaki czyta to narzędzie (pełny typ żyje w `modules/memory`). */
interface AgentMemoryLike {
    // SZEW spawany po merge TS-2: `AgentMemory.agentName` to `declare agentName: string`
    // (konstruktor go wymaga) — opcjonalność była zachowawczym strzałem fali równoległej.
    agentName: string;
    basePath: string;
    paths: { l1: string; l2: string; l3: string };
    vault: { adapter: { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string> } };
    ensureMemoryStructure?: () => Promise<unknown>;
    _parseFrontmatter?: (content: string) => Record<string, unknown>;
}

/** Agent w zakresie, jaki czyta to narzędzie: tożsamość + bramka pamięci. */
interface ReadToolAgent extends AgentIdentityLike {
    permissions?: { memory?: unknown };
}

/** Minimalny widok AgentManagera. Wszystko opcjonalne — wołane defensywnie (`?.`). */
interface ReadToolAgentManager {
    getActiveAgent?(): ReadToolAgent | null | undefined;
    getAgent?(name: string | null): ReadToolAgent | null | undefined;
    getAgentMemory?(name: string): AgentMemoryLike | null | undefined;
    getActiveMemory?(): AgentMemoryLike | null | undefined;
}

/** Minimalny widok pluginu: tylko `agentManager`. */
export interface ReadToolPlugin {
    agentManager?: ReadToolAgentManager | null;
}

/**
 * Werdykt `MemoryAccessGuard.validateNoteFilename` zawężony lokalnie (`modules/memory`
 * jest jeszcze w JS — kontrakt spisany tu, u konsumenta, i tylko w używanym zakresie).
 */
type MemoryFilenameCheck =
    | { ok: false; code: string; error: string }
    | { ok: true; filename: string; path: string };

const SUMMARY_LEVELS = new Set(['L1', 'L2', 'L3']);

function getInvocationMemory(
    args: ReadToolArgs | undefined,
    agentManager: ReadToolAgentManager | null | undefined,
): AgentMemoryLike | null | undefined {
    const agentName = getInvocationAgentName(args, agentManager);
    // K4 (AUD-security-036): FAIL-CLOSED. Nazwana tożsamość bez wpisu w `agentMemories`
    // (pad inicjalizacji pamięci, agent skasowany w trakcie biegu w tle) kończy się ODMOWĄ.
    // Do K4 stał tu `|| getActiveMemory()`, więc narzędzie po cichu pisało i czytało katalog
    // `brain/` agenta AKURAT wybranego w UI — a `_invocationAgentName` rozjeżdża się
    // z aktywnym przy każdym biegu suba w tle i w drugiej zakładce czatu.
    // Brak JAKIEJKOLWIEK tożsamości (ani znacznika, ani aktywnego agenta) = ścieżka jak dotąd.
    return agentName ? agentManager?.getAgentMemory?.(agentName) : agentManager?.getActiveMemory?.();
}

function levelPath(memory: AgentMemoryLike, level: string): string {
    if (level === 'L1') return memory.paths.l1;
    if (level === 'L2') return memory.paths.l2;
    return memory.paths.l3;
}

/** Rozpoznaj ścieżkę podsumowania pamięci: `summaries/L{1,2,3}/<file>.md`. */
function parseSummaryPath(rawPath: unknown): { level: string; filename: string } | null {
    const norm = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length === 3 && parts[0].toLowerCase() === 'summaries' && /^L[123]$/i.test(parts[1])) {
        return { level: parts[1].toUpperCase(), filename: parts[2] };
    }
    return null;
}

/** scope=vault: API-first read (getAbstractFileByPath → cachedRead), 1:1 z dawnym vault_read. */
async function readVault(args: ReadToolArgs, app: ReadToolApp, plugin: ReadToolPlugin): Promise<Record<string, unknown>> {
    // D17: read wolno wciągnąć przepis skilla (.pkm-assistant/skills/**) — odkrywalność skilli
    // przez indeks+read. Reszta .pkm-assistant/ (pamięć, indeks semantyczny) pozostaje zablokowana.
    const validation = validateVaultPath(args?.path, {
        allowSkillsRead: true,
        adminAccess: invocationHasAdminAccess(args, plugin),
    });
    if (!validation.ok) {
        const errorKey = validation.code === 'protected'
            ? 'mcp.read.protected_path'
            : 'mcp.read.invalid_path';
        return { success: false, error: t(errorKey) };
    }
    const safePath = validation.safePath;

    const file = app.vault.getAbstractFileByPath(safePath);
    if (!file) {
        // Fallback: pliki vaulta nieznane indeksowi Obsidiana (API ich nie widzi).
        // .pkm-assistant/ jest już zablokowane przez validateVaultPath — to tylko
        // dla legalnych ścieżek vaulta jeszcze nie zaindeksowanych.
        try {
            const content = await app.vault.adapter.read(safePath);
            return { success: true, content, path: safePath };
        } catch {
            return { success: false, error: t('mcp.read.not_found', { path: safePath }) };
        }
    }

    if (isFolderLike(file)) {
        return { success: false, error: t('mcp.read.not_a_file', { path: safePath }) };
    }

    const content = await app.vault.cachedRead(file);
    return { success: true, content, path: file.path };
}

/** scope=memory: odczyt notatki brain/ lub podsumowania L1/L2/L3 aktualnego agenta (adapter). */
async function readMemory(args: ReadToolArgs, plugin: ReadToolPlugin): Promise<Record<string, unknown>> {
    const agentManager = plugin?.agentManager;
    const invocationAgentName = getInvocationAgentName(args, agentManager);

    // Bramka pamięci — fail-closed (wzór SearchTool).
    const agent = agentManager?.getAgent?.(invocationAgentName) || agentManager?.getActiveAgent?.();
    if (agent?.permissions?.memory === false) {
        return { success: false, error: t('mcp.read.denied_memory') };
    }

    const agentMemory = getInvocationMemory(args, agentManager);
    if (!agentMemory) {
        return { success: false, error: t('mcp.read.no_agent') };
    }

    const agentName = invocationAgentName || agentMemory.agentName;
    const guard = new MemoryAccessGuard(agentName);
    const rawPath = args?.path ?? args?.filename;

    // Ścieżka podsumowania: summaries/L1/<file>.md (dawny memory_read_summary).
    const summary = parseSummaryPath(rawPath);
    if (summary) {
        if (!SUMMARY_LEVELS.has(summary.level)) {
            return { success: false, error: t('mcp.read.invalid_level'), code: 'invalid_level' };
        }
        const base = levelPath(agentMemory, summary.level);
        const validation = guard.validateNoteFilename(summary.filename, base) as MemoryFilenameCheck;
        if (!validation.ok) {
            return { success: false, code: validation.code, error: validation.error };
        }
        await agentMemory.ensureMemoryStructure?.();
        const path = `${base}/${validation.filename}`;
        if (!(await agentMemory.vault.adapter.exists(path))) {
            return {
                success: false,
                code: MEMORY_V3_ERROR_CODES.NOTE_NOT_FOUND,
                error: t('mcp.read.summary_not_found', { filename: validation.filename })
            };
        }
        const content = await agentMemory.vault.adapter.read(path);
        return {
            success: true,
            agent: agentMemory.agentName,
            level: summary.level,
            filename: validation.filename,
            path,
            content,
            metadata: agentMemory._parseFrontmatter?.(content) || {}
        };
    }

    // Notatka brain/ (dawny memory_read).
    const validation = guard.validateNoteFilename(rawPath, agentMemory.basePath) as MemoryFilenameCheck;
    if (!validation.ok) {
        return { success: false, code: validation.code, error: validation.error };
    }
    await agentMemory.ensureMemoryStructure?.();
    if (!(await agentMemory.vault.adapter.exists(validation.path))) {
        return {
            success: false,
            code: MEMORY_V3_ERROR_CODES.NOTE_NOT_FOUND,
            error: t('mcp.read.not_found_note', { filename: validation.filename })
        };
    }
    const content = await agentMemory.vault.adapter.read(validation.path);
    const frontmatter = agentMemory._parseFrontmatter?.(content) || {};
    return {
        success: true,
        filename: validation.filename,
        path: validation.path,
        agent: agentMemory.agentName,
        frontmatter,
        content
    };
}

export function createReadTool() {
    return {
        name: 'read',
        description: t('mcp.read.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: t('mcp.read.param.path') },
                scope: { type: 'string', enum: ['vault', 'memory'], description: t('mcp.read.param.scope') }
            },
            required: ['path']
        },
        // targetPath dla AccessGuard: vault → path; memory → '' (bramkuje osobno uprawnienie pamięci).
        contextExtractor: (args: ReadToolArgs) => ({
            targetPath: args?.scope === 'memory' ? '' : (args?.path || '')
        }),
        execute: async (args: ReadToolArgs, app: ReadToolApp, plugin: ReadToolPlugin) => {
            try {
                const scope = args?.scope === 'memory' ? 'memory' : 'vault';
                return scope === 'memory'
                    ? await readMemory(args, plugin)
                    : await readVault(args, app, plugin);
            } catch (err) {
                log.error('ReadTool', 'Error:', err);
                return { success: false, error: (err as Error).message };
            }
        }
    };
}
