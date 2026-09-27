/**
 * ReadTool — jeden prymityw `read`.
 *
 * Konsoliduje 3 dawne narzędzia odczytu: `vault_read` (nota usera) +
 * `memory_read` (notatka brain/ aktualnego agenta) + `memory_read_summary`
 * (podsumowanie L1/L2/L3). Scope w parametrze, nie w nazwie (wzór `search`).
 *
 *   scope=vault (default): Vault API — getAbstractFileByPath → cachedRead.
 *     Walidacja przez validateVaultPath (blokada .pkm-assistant).
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
import { hostWindow } from '../../core/index.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';
import { MemoryAccessGuard, MEMORY_V3_ERROR_CODES } from '../memory/index.js';
import { isFolderLike } from './vault_binary_io.js';
import type { VaultFileLike } from './vault_binary_io.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `read`. `filename` to legacy alias z dawnego `memory_read`. */
export interface ReadToolArgs {
    path?: unknown;
    filename?: unknown;
    scope?: unknown;
    offset?: unknown;
    limit?: unknown;
    source_version?: unknown;
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
    // `AgentMemory.agentName` to `declare agentName: string`
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
const MAX_PAGE_UNITS = 8192;
const DEFAULT_RESULT_BUDGET = 12000;
const SMALL_ERROR_TOKEN = 'B';

type ReadPage = {
    success: true;
    scope: 'vault' | 'memory';
    path: string;
    source_version: string;
    source_length: number;
    offset: number;
    effective_limit: number;
    next_offset: number | null;
    has_more: boolean;
    truncated: boolean;
    metadata_in_content: boolean;
    content: string;
};

function finalJson(result: unknown, context?: BuiltinToolExecutionContext): string {
    return context?.serializeFinalResult ? context.serializeFinalResult(result) : JSON.stringify(result);
}

function resultBudget(context?: BuiltinToolExecutionContext): number {
    const requested = context?.effectiveResultBudgetChars;
    return typeof requested === 'number' && Number.isInteger(requested) && requested > 0
        ? Math.min(DEFAULT_RESULT_BUDGET, requested)
        : DEFAULT_RESULT_BUDGET;
}

function budgetError(context: BuiltinToolExecutionContext | undefined, budget: number): string | Record<string, unknown> {
    const result = { success: false, code: 'budget_too_small', isError: true };
    return finalJson(result, context).length <= budget ? result : SMALL_ERROR_TOKEN.slice(0, budget);
}

function isHighSurrogate(code: number): boolean { return code >= 0xD800 && code <= 0xDBFF; }
function isLowSurrogate(code: number): boolean { return code >= 0xDC00 && code <= 0xDFFF; }
function splitsSurrogatePair(text: string, offset: number): boolean {
    return offset > 0 && offset < text.length
        && isHighSurrogate(text.charCodeAt(offset - 1))
        && isLowSurrogate(text.charCodeAt(offset));
}

async function sourceVersion(scope: 'vault' | 'memory', identity: string, content: string): Promise<string> {
    const subtle = hostWindow?.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto is unavailable');
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`${scope}\0${identity}\0${content}`));
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function logicalMemoryPath(args: ReadToolArgs, result: Record<string, unknown>): string {
    const summary = parseSummaryPath(args?.path ?? args?.filename);
    if (summary && typeof result.filename === 'string') return `summaries/${summary.level}/${result.filename}`;
    return typeof result.filename === 'string' ? result.filename : '';
}

function paginationArgs(args: ReadToolArgs): { explicit: boolean; offset: number; requestedLimit: number; sourceVersion?: string; error?: string } {
    const hasOffset = Object.prototype.hasOwnProperty.call(args, 'offset');
    const hasLimit = Object.prototype.hasOwnProperty.call(args, 'limit');
    const hasVersion = Object.prototype.hasOwnProperty.call(args, 'source_version');
    if (hasVersion && !hasOffset) return { explicit: true, offset: 0, requestedLimit: MAX_PAGE_UNITS, error: 'invalid_args' };
    const offset = hasOffset ? args.offset : 0;
    const limit = hasLimit ? args.limit : MAX_PAGE_UNITS;
    if (!Number.isInteger(offset) || (offset as number) < 0
        || !Number.isInteger(limit) || (limit as number) < 1
        || (hasVersion && (typeof args.source_version !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(args.source_version)))
        || ((offset as number) > 0 && !hasVersion)) {
        return { explicit: hasOffset || hasLimit || hasVersion, offset: 0, requestedLimit: MAX_PAGE_UNITS, error: hasVersion ? 'invalid_version' : 'invalid_args' };
    }
    return {
        explicit: hasOffset || hasLimit || hasVersion,
        offset: offset as number,
        requestedLimit: Math.min(limit as number, MAX_PAGE_UNITS),
        ...(hasVersion ? { sourceVersion: args.source_version as string } : {}),
    };
}

function selectFittingPage(
    base: Omit<ReadPage, 'effective_limit' | 'next_offset' | 'has_more' | 'truncated' | 'content'>,
    content: string,
    requestedLimit: number,
    budget: number,
    context?: BuiltinToolExecutionContext,
): ReadPage | null {
    let low = 0;
    let high = requestedLimit;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        let end = Math.min(base.offset + middle, content.length);
        if (end < content.length && splitsSurrogatePair(content, end)) end--;
        const piece = content.slice(base.offset, end);
        const nextOffset = end < content.length ? end : null;
        const candidate: ReadPage = {
            ...base,
            effective_limit: middle,
            next_offset: nextOffset,
            has_more: nextOffset !== null,
            truncated: nextOffset !== null,
            content: piece,
        };
        if (finalJson(candidate, context).length <= budget) low = middle;
        else high = middle - 1;
    }
    let end = Math.min(base.offset + low, content.length);
    if (end < content.length && splitsSurrogatePair(content, end)) end--;
    if (end === base.offset && base.offset < content.length) return null;
    const piece = content.slice(base.offset, end);
    const nextOffset = end < content.length ? end : null;
    const result: ReadPage = {
        ...base,
        effective_limit: low,
        next_offset: nextOffset,
        has_more: nextOffset !== null,
        truncated: nextOffset !== null,
        content: piece,
    };
    return finalJson(result, context).length <= budget ? result : null;
}

function invalidPage(code: string): Record<string, unknown> {
    return { success: false, code, isError: true };
}

function pageReadError(
    result: Record<string, unknown>,
    scope: 'vault' | 'memory',
    args: ReadToolArgs,
): Record<string, unknown> {
    if (scope === 'memory') {
        if (result.code === MEMORY_V3_ERROR_CODES.NOTE_NOT_FOUND) return invalidPage('file_missing');
        if (result.code === 'invalid_level') return invalidPage('invalid_args');
        // Memory authorization and path guards intentionally share one opaque bounded denial.
        return invalidPage('access_denied');
    }
    const path = _toPathText(args?.path);
    if (result.error === t('mcp.read.not_found', { path })) return invalidPage('file_missing');
    if (result.error === t('mcp.read.not_a_file', { path })) return invalidPage('invalid_args');
    if (result.error === t('mcp.read.invalid_path') || result.error === t('mcp.read.protected_path')) return invalidPage('access_denied');
    return invalidPage('file_missing');
}

function canFitPageEnvelope(
    scope: 'vault' | 'memory',
    path: string,
    budget: number,
    context?: BuiltinToolExecutionContext,
): boolean {
    const envelope: ReadPage = {
        success: true,
        scope,
        path,
        source_version: `sha256:${'0'.repeat(64)}`,
        source_length: 0,
        offset: 0,
        effective_limit: 0,
        next_offset: null,
        has_more: false,
        truncated: false,
        metadata_in_content: scope === 'memory',
        content: '',
    };
    return finalJson(envelope, context).length <= budget;
}

async function executeRead(
    args: ReadToolArgs,
    app: ReadToolApp,
    plugin: ReadToolPlugin,
    context?: BuiltinToolExecutionContext,
): Promise<unknown> {
    const scope = args?.scope === 'memory' ? 'memory' : 'vault';
    const budget = resultBudget(context);
    const pagination = paginationArgs(args || {});
    if (pagination.error) return invalidPage(pagination.error);
    // The smallest possible decorated page cannot fit, so do not touch the source.
    const requestedPath = _toPathText(args?.path ?? args?.filename);
    if (!canFitPageEnvelope(scope, requestedPath, budget, context)) return budgetError(context, budget);
    const legacy = scope === 'memory'
        ? await readMemory(args, plugin)
        : await readVault(args, app, plugin, context);
    if (legacy.success !== true || typeof legacy.content !== 'string') {
        if (legacy.code === 'access_denied') return legacy;
        return pagination.offset > 0 || pagination.sourceVersion || pagination.explicit
            ? pageReadError(legacy, scope, args)
            : legacy;
    }

    const source = legacy.content;
    const logicalPath = scope === 'memory'
        ? logicalMemoryPath(args, legacy)
        : (typeof legacy.path === 'string' ? legacy.path : '');
    if (!logicalPath) return invalidPage('invalid_path');

    const explicit = pagination.explicit;
    if (!explicit && finalJson(legacy, context).length <= budget) return legacy;

    let version: string;
    try {
        const sourcePath = typeof legacy.path === 'string' ? legacy.path : '';
        const identity = scope === 'memory'
            ? `${typeof legacy.agent === 'string' ? legacy.agent : ''}\0${sourcePath}`
            : sourcePath;
        version = await sourceVersion(scope, identity, source);
    } catch {
        return invalidPage('read_error');
    }
    if (pagination.sourceVersion && pagination.sourceVersion !== version) {
        return { ...invalidPage('file_changed'), restart_offset: 0 };
    }
    if (pagination.offset > source.length || splitsSurrogatePair(source, pagination.offset)) return invalidPage('invalid_offset');

    const page = selectFittingPage({
        success: true,
        scope,
        path: logicalPath,
        source_version: version,
        source_length: source.length,
        offset: pagination.offset,
        metadata_in_content: scope === 'memory',
    }, source, pagination.requestedLimit, budget, context);
    return page || invalidPage('budget_too_small');
}

function getInvocationMemory(
    args: ReadToolArgs | undefined,
    agentManager: ReadToolAgentManager | null | undefined,
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

function levelPath(memory: AgentMemoryLike, level: string): string {
    if (level === 'L1') return memory.paths.l1;
    if (level === 'L2') return memory.paths.l2;
    return memory.paths.l3;
}

/**
 * `rawPath` to `args.path`/`args.filename` od modelu - `unknown` bez walidacji schematem.
 * Osobna funkcja graniczna: dopiero jej wywołanie resetuje zawężenie TS z powrotem do gołego
 * `unknown`, więc `String()` tutaj nie zgłasza no-base-to-string (ten sam wzorzec co
 * `_safeStringify` w `core/utils/errorUtils.ts`).
 */
function _toPathText(value: unknown): string {
    return value ? _rawToString(value) : '';
}

function _rawToString(value: unknown): string {
    return String(value);
}

/** Rozpoznaj ścieżkę podsumowania pamięci: `summaries/L{1,2,3}/<file>.md`. */
function parseSummaryPath(rawPath: unknown): { level: string; filename: string } | null {
    const norm = _toPathText(rawPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length === 3 && parts[0].toLowerCase() === 'summaries' && /^L[123]$/i.test(parts[1])) {
        return { level: parts[1].toUpperCase(), filename: parts[2] };
    }
    return null;
}

/** scope=vault: API-first read (getAbstractFileByPath → cachedRead), 1:1 z dawnym vault_read. */
async function readVault(
    args: ReadToolArgs,
    app: ReadToolApp,
    plugin: ReadToolPlugin,
    context?: BuiltinToolExecutionContext,
): Promise<Record<string, unknown>> {
    // `read` wolno wciągnąć przepis skilla (.pkm-assistant/skills/**) — odkrywalność skilli
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
    // The MCP context closes over the current caller and scope. Recheck the canonical
    // path on every page before either Vault API or adapter reads it. Direct legacy
    // callers without a runtime context keep their existing behavior.
    if (context) {
        let allowed = false;
        try { allowed = context.authorizeFileRead?.(safePath)?.allowed === true; }
        catch { /* A broken permission service cannot authorize a read. */ }
        if (!allowed) return invalidPage('access_denied');
    }

    const file = app.vault.getAbstractFileByPath(safePath);
    if (!file) {
        // Fallback: pliki vaulta nieznane indeksowi Obsidiana (API ich nie widzi).
        // .pkm-assistant/ jest już zablokowane przez validateVaultPath — to tylko
        // dla legalnych ścieżek vaulta jeszcze nie zaindeksowanych.
        try {
            const content = await app.vault.adapter.read(safePath);
            return { success: true, content, path: safePath };
        } catch (error) {
            if (paginationArgs(args).explicit) throw error;
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
                scope: { type: 'string', enum: ['vault', 'memory'], description: t('mcp.read.param.scope') },
                offset: { type: 'integer', minimum: 0, description: t('mcp.read.param.offset') },
                limit: { type: 'integer', minimum: 1, description: t('mcp.read.param.limit') },
                source_version: { type: 'string', description: t('mcp.read.param.source_version') },
            },
            required: ['path']
        },
        // targetPath dla AccessGuard: vault → path; memory → '' (bramkuje osobno uprawnienie pamięci).
        contextExtractor: (args: ReadToolArgs) => ({
            targetPath: args?.scope === 'memory' ? '' : (args?.path || '')
        }),
        execute: async (args: ReadToolArgs, app: ReadToolApp, plugin: ReadToolPlugin, context?: BuiltinToolExecutionContext) => {
            try {
                return await executeRead(args || {}, app, plugin, context);
            } catch (err) {
                log.error('ReadTool', 'Error:', err);
                if (paginationArgs(args || {}).explicit) {
                    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
                    const failure = invalidPage(code === 'ENOENT' ? 'file_missing'
                        : code === 'EACCES' || code === 'EPERM' ? 'access_denied' : 'read_error');
                    const budget = resultBudget(context);
                    return finalJson(failure, context).length <= budget ? failure : budgetError(context, budget);
                }
                return { success: false, error: (err as Error).message };
            }
        }
    };
}
