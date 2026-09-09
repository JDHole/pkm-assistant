/**
 * ListTool — jeden prymityw `list`.
 *
 * Konsoliduje `vault_list` (folder vaulta) + `memory_list_summaries` (podsumowania
 * L1/L2/L3) i dokłada listing pozostałej pamięci (brain/ + sesje). Scope w parametrze.
 *
 *   scope=vault (default): Vault API — TFolder.children (shallow) / getFiles (recursive).
 *     Walidacja przez validateVaultFolder (blokada .pkm-assistant).
 *   scope=memory: listing pamięci AKTUALNEGO agenta (adapter przez AgentMemory).
 *     `folder` = etykieta logiczna (brain | sessions | sessions/active | summaries |
 *     summaries/L1...), filtr na listingu — NIE budujemy ścieżek z inputu.
 *     Bramka uprawnienia memory fail-closed W execute (jak SearchTool).
 *
 * TWARDA GRANICA: Vault API nie widzi `.pkm-assistant/` — scope=memory zostaje na adapterze.
 */
import { validateVaultFolder, invocationHasAdminAccess, getInvocationAgentName } from './vault_path_validator.js';
import type { AgentIdentityLike } from './vault_path_validator.js';
import { t } from '../../core/i18n/index.js';
import { isHiddenVaultPath, listAdapterFolder } from './vault_adapter_io.js';
import type { ListCapableAdapter } from './vault_adapter_io.js';
import { isFolderLike } from './vault_binary_io.js';
import type { VaultFileLike } from './vault_binary_io.js';
import { log } from '../../core/utils/Logger.js';

/**
 * Argumenty `list` wg `inputSchema`. `folder` w scope=memory jest etykietą logiczną
 * (brain / sessions / summaries/L1…), nie ścieżką — filtrem na listingu.
 */
export interface ListToolArgs {
    folder?: string;
    recursive?: boolean;
    scope?: string;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Wpis listingu vaulta. */
interface ListEntry {
    name: string | undefined;
    path: string;
    isFolder: boolean;
    extension?: string | undefined;
}

/** Wpis listingu pamięci — dochodzi etykieta logiczna (brain / sessions/active / summaries/L1…). */
interface MemoryListEntry extends ListEntry {
    logical: string;
}

/** Folder vaulta — TFolder ma `children`, czego duck-typing pilnuje przez `isFolderLike`. */
interface VaultFolderLike extends VaultFileLike {
    children: VaultFileLike[];
}

/** Minimalny widok `App`: Vault API + adapter (ukryte ścieżki poza indeksem Obsidiana). */
export interface ListToolApp {
    vault: {
        adapter: ListCapableAdapter;
        getRoot: () => VaultFileLike;
        getAbstractFileByPath: (path: string) => VaultFileLike | null;
        getFiles: () => VaultFileLike[];
    };
}

/** Pamięć agenta w zakresie, jaki listuje to narzędzie (pełny typ żyje w `modules/memory`). */
interface AgentMemoryLike {
    agentName?: string;
    paths: {
        brain: string;
        brainNotes: string;
        sessionsActive: string;
        sessionsArchive: string;
        l1: string;
        l2: string;
        l3: string;
    };
    vault: {
        adapter: {
            exists: (path: string) => Promise<boolean>;
            list: (path: string) => Promise<{ files?: string[] } | null | undefined>;
        };
    };
    ensureMemoryStructure?: () => Promise<unknown>;
}

/** Agent w zakresie, jaki czyta to narzędzie: tożsamość + bramka pamięci. */
interface ListToolAgent extends AgentIdentityLike {
    permissions?: { memory?: unknown };
}

/** Minimalny widok AgentManagera. Wszystko opcjonalne — wołane defensywnie (`?.`). */
interface ListToolAgentManager {
    getActiveAgent?(): ListToolAgent | null | undefined;
    getAgent?(name: string | null): ListToolAgent | null | undefined;
    getAgentMemory?(name: string): AgentMemoryLike | null | undefined;
    getActiveMemory?(): AgentMemoryLike | null | undefined;
}

/** Minimalny widok pluginu: tylko `agentManager`. */
export interface ListToolPlugin {
    agentManager?: ListToolAgentManager | null;
}

const MAX_RESULTS = 100;

function getInvocationMemory(
    args: ListToolArgs | undefined,
    agentManager: ListToolAgentManager | null | undefined,
): AgentMemoryLike | null | undefined {
    const agentName = getInvocationAgentName(args, agentManager);
    // FAIL-CLOSED: nazwana tożsamość bez wpisu w `agentMemories` (pad inicjalizacji pamięci,
    // agent skasowany w trakcie biegu w tle) kończy się ODMOWĄ, a nie fallbackiem na
    // `getActiveMemory()` — taki fallback po cichu pisałby i czytał katalog `brain/` agenta
    // AKURAT wybranego w UI, bo `_invocationAgentName` rozjeżdża się z aktywnym przy każdym
    // biegu suba w tle i w drugiej zakładce czatu.
    // Brak JAKIEJKOLWIEK tożsamości (ani znacznika, ani aktywnego agenta) = pamięć aktywnego agenta.
    return agentName ? agentManager?.getAgentMemory?.(agentName) : agentManager?.getActiveMemory?.();
}

/**
 * Listing przepisów skilli (.pkm-assistant/skills/**) przez adapter — Vault API nie widzi
 * ukrytego `.pkm-assistant/`, więc getAbstractFileByPath zwraca null. Tanie: jedno adapter.list.
 * Zamykająca linia indeksu skilli podpowiada modelowi `list(".pkm-assistant/skills")`.
 */
async function listViaAdapter(app: ListToolApp, folderPath: string, recursive = false): Promise<Record<string, unknown>> {
    try {
        // Walk zatrzymuje się, jak tylko zbierze MAX_RESULTS wpisów — bez tego
        // `folder:"/" recursive:true` u admina chodziłby po całym drzewie (do 5000 wpisów
        // na dysku sieciowym) tylko po to, żeby i tak oddać pierwsze 100. Pierwsze `MAX_RESULTS`
        // pozycji jest identyczne jak przy pełnym przebiegu (kolejność walku bez zmian) — ale
        // `totalCount` NIŻEJ już nie jest realną liczbą wpisów w drzewie: cięcie wcześniej
        // ogranicza go do max `MAX_RESULTS`, tam gdzie pełny przebieg dawał prawdziwy total
        // (`listed.truncated` sygnalizuje to wprost). Praktyczny wpływ ograniczony — krok
        // klienta (`MCPClient.executeToolCall`) i tak PRZELICZA `totalCount` po odfiltrowaniu
        // whitelistą agenta dla scope=vault, więc ta wartość nie jest tu ostatnim słowem.
        const listed = await listAdapterFolder(app.vault.adapter, folderPath, { recursive, maxFiles: MAX_RESULTS });
        const totalCount = listed.files.length;
        const files = listed.files.length > MAX_RESULTS
            ? listed.files.slice(0, MAX_RESULTS)
            : listed.files;
        return {
            success: true,
            scope: 'vault',
            folder: folderPath,
            files,
            count: files.length,
            totalCount,
            ...(listed.truncated ? { truncated: true } : {}),
        };
    } catch {
        return { success: false, error: t('mcp.list.not_found', { path: folderPath }) };
    }
}

/** scope=vault: API-first listing (TFolder.children / getFiles), 1:1 z dawnym vault_list. */
async function listVault(args: ListToolArgs, app: ListToolApp, plugin: ListToolPlugin): Promise<Record<string, unknown>> {
    const recursive = args?.recursive || false;
    const adminAccess = invocationHasAdminAccess(args, plugin);

    let folderPath = args?.folder;
    if (folderPath === '/' || folderPath === '' || folderPath == null) {
        folderPath = '/';
    } else {
        // `list` wolno wylistować katalog skilli (.pkm-assistant/skills/**) — read wciąga przepis.
        const validation = validateVaultFolder(folderPath, { allowSkillsRead: true, adminAccess });
        if (!validation.ok) {
            const errorKey = validation.code === 'protected'
                ? 'mcp.list.protected_path'
                : 'mcp.list.invalid_path';
            return { success: false, error: t(errorKey) };
        }
        folderPath = validation.safePath;
    }

    // Admin widzi także ukryty root i wszystkie bebechy; zwykły agent ma adapterowy
    // wyjątek wyłącznie dla przepisów skilli.
    const lowerFolder = folderPath.toLowerCase();
    const isSkillsPath = lowerFolder === '.pkm-assistant/skills' || lowerFolder.startsWith('.pkm-assistant/skills/');
    if ((adminAccess && (folderPath === '/' || isHiddenVaultPath(folderPath))) || isSkillsPath) {
        return listViaAdapter(app, folderPath, recursive);
    }

    const targetFolder = (folderPath === '/' || folderPath === '')
        ? app.vault.getRoot()
        : app.vault.getAbstractFileByPath(folderPath);

    if (!targetFolder) {
        return { success: false, error: t('mcp.list.not_found', { path: folderPath }) };
    }
    if (!isFolderLike(targetFolder)) {
        return { success: false, error: t('mcp.list.not_a_folder', { path: folderPath }) };
    }

    let files: ListEntry[];
    if (recursive) {
        const allFiles = app.vault.getFiles();
        const scoped = (folderPath === '/' || folderPath === '')
            ? allFiles
            : allFiles.filter(f => f.path.startsWith(folderPath + '/'));
        files = scoped.map(file => ({
            name: file.name,
            path: file.path,
            isFolder: false,
            extension: file.extension
        }));
    } else {
        files = (targetFolder as VaultFolderLike).children.map(child => {
            const folder = isFolderLike(child);
            return {
                name: child.name,
                path: child.path,
                isFolder: folder,
                extension: folder ? undefined : child.extension
            };
        });
    }

    const totalCount = files.length;
    if (files.length > MAX_RESULTS) files = files.slice(0, MAX_RESULTS);

    return {
        success: true,
        scope: 'vault',
        folder: targetFolder.path,
        files,
        count: files.length,
        totalCount
    };
}

/** scope=memory: listing brain/ + sesje + podsumowania aktualnego agenta (adapter). */
async function listMemory(args: ListToolArgs, plugin: ListToolPlugin): Promise<Record<string, unknown>> {
    const agentManager = plugin?.agentManager;
    const invocationAgentName = getInvocationAgentName(args, agentManager);

    // Bramka pamięci — fail-closed (wzór SearchTool).
    const agent = agentManager?.getAgent?.(invocationAgentName) || agentManager?.getActiveAgent?.();
    if (agent?.permissions?.memory === false) {
        return { success: false, error: t('mcp.list.denied_memory') };
    }

    const memory = getInvocationMemory(args, agentManager);
    if (!memory?.paths) {
        return { success: false, error: t('mcp.list.no_agent') };
    }

    await memory.ensureMemoryStructure?.();
    const adapter = memory.vault.adapter;
    const out: MemoryListEntry[] = [];
    const push = (path: string, logical: string) => out.push({ name: path.split('/').pop(), path, isFolder: false, logical });
    const listDir = async (dir: string, logical: string) => {
        try {
            const listed = await adapter.list(dir);
            for (const p of listed?.files || []) if (p.endsWith('.md')) push(p, logical);
        } catch { /* folder nie istnieje */ }
    };

    try { if (await adapter.exists(memory.paths.brain)) push(memory.paths.brain, 'brain'); } catch { /* skip */ }
    await listDir(memory.paths.brainNotes, 'brain');
    await listDir(memory.paths.sessionsActive, 'sessions/active');
    await listDir(memory.paths.sessionsArchive, 'sessions/archive');
    await listDir(memory.paths.l1, 'summaries/L1');
    await listDir(memory.paths.l2, 'summaries/L2');
    await listDir(memory.paths.l3, 'summaries/L3');

    let files = out;
    const rawFilter = args?.folder ? String(args.folder).replace(/^\/+|\/+$/g, '').toLowerCase() : '';
    if (rawFilter) {
        files = files.filter(e => {
            const logical = e.logical.toLowerCase();
            return logical === rawFilter || logical.startsWith(`${rawFilter}/`);
        });
    }

    const totalCount = files.length;
    if (files.length > MAX_RESULTS) files = files.slice(0, MAX_RESULTS);

    return {
        success: true,
        scope: 'memory',
        agent: memory.agentName,
        folder: args?.folder || 'all',
        files,
        count: files.length,
        totalCount
    };
}

export function createListTool() {
    return {
        name: 'list',
        description: t('mcp.list.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                folder: { type: 'string', description: t('mcp.list.param.folder') },
                recursive: { type: 'boolean', description: t('mcp.list.param.recursive') },
                scope: { type: 'string', enum: ['vault', 'memory'], description: t('mcp.list.param.scope') }
            },
            required: []
        },
        // targetPath dla AccessGuard: vault → folder; memory → '' (bramkuje osobno uprawnienie pamięci).
        contextExtractor: (args: ListToolArgs) => ({
            targetPath: args?.scope === 'memory' ? '' : (args?.folder || '/')
        }),
        execute: async (args: ListToolArgs, app: ListToolApp, plugin: ListToolPlugin) => {
            try {
                const scope = args?.scope === 'memory' ? 'memory' : 'vault';
                return scope === 'memory'
                    ? await listMemory(args, plugin)
                    : await listVault(args, app, plugin);
            } catch (err) {
                log.error('ListTool', 'Error:', err);
                return { success: false, error: (err as Error).message };
            }
        }
    };
}
