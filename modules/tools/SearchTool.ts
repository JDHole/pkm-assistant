/**
 * SearchTool — jedno narzędzie `search`.
 *
 * Konsoliduje 12 dawnych narzędzi retrieval (vault_search/grep/semantic/glob/
 * filter_yaml/links + memory_* analogi + memory_sessions/summaries) w JEDNO.
 *
 * Silnik: `RetrievalEngine.runSearch()` z modules/memory (RRF keyword+semantic,
 * excerpt z dysku, scope vault/memory). Tool = thin wrapper: buduje engine z
 * kontekstu pluginu, sanityzuje folder, bramkuje uprawnienie pamięci (fail-closed),
 * dokłada uczciwą notę degradacji semantyki.
 */

import { t } from '../../core/i18n/index.js';
import { RetrievalEngine, EmbeddingHelper } from '../memory/index.js';
import { buildSemanticNote } from './semanticNote.js';
import type { SemanticNotePlugin, SemanticScope } from './semanticNote.js';
import { validateVaultFolder, invocationHasAdminAccess, getInvocationAgentName } from './vault_path_validator.js';
import type { AgentIdentityLike } from './vault_path_validator.js';
import { log } from '../../core/utils/Logger.js';

/** Filtry kandydatów (`where`) wg `inputSchema`.
 * `export` zdjęty — homonim z `modules/memory/RetrievalEngine.ts:120`
 * (ten sam identyfikator, inny kształt); zero konsumentów tej lokalnej definicji poza plikiem. */
interface SearchWhere {
    folder?: string;
    glob?: string;
    yaml?: Record<string, unknown>;
    links_to?: string;
    links_from?: string;
}

/** Argumenty `search` wg `inputSchema`. */
export interface SearchToolArgs {
    query?: unknown;
    scope?: string;
    where?: unknown;
    mode?: string;
    limit?: number;
    _invocationAgentName?: unknown;
    /** Zaufany znacznik z `MCPClient`/`SubAgentRunner` — patrz `resolveSearchScope`. */
    _invocationDelegationDepth?: unknown;
    [extra: string]: unknown;
}

/** Agent w zakresie, jaki czyta to narzędzie: tożsamość + bramka pamięci. */
interface SearchToolAgent extends AgentIdentityLike {
    permissions?: { memory?: unknown };
}

/** Minimalny widok AgentManagera. Wszystko opcjonalne — wołane defensywnie (`?.`). */
interface SearchToolAgentManager {
    getActiveAgent?(): SearchToolAgent | null | undefined;
    getAgent?(name: string | null): SearchToolAgent | null | undefined;
    getAgentMemory?(name: string): unknown;
    getActiveMemory?(): unknown;
}

/**
 * Minimalny widok pluginu. `oramaDb` publikuje `VaultIndexer` — `null` = tylko keyword.
 * Rozszerza `SemanticNotePlugin`, bo ten sam obiekt idzie do `buildSemanticNote`.
 */
export interface SearchToolPlugin extends SemanticNotePlugin {
    app?: { vault?: unknown } | null;
    env?: unknown;
    oramaDb?: unknown;
    agentManager?: SearchToolAgentManager | null;
}

function resolveAgentMemory(plugin: SearchToolPlugin | null | undefined, agentName: string | null): unknown {
    const am = plugin?.agentManager;
    if (!am) return null;
    // FAIL-CLOSED — patrz komentarz w ReadTool.getInvocationMemory.
    return (agentName ? am.getAgentMemory?.(agentName) : am.getActiveMemory?.()) || null;
}

/**
 * Decyzja o ZAKRESIE `search`, w tej samej formie dla bramki (`contextExtractor`) i dla
 * wykonania (`execute`) — JEDNA funkcja, DWÓCH wołaczy, żeby obie strony nigdy nie oceniły
 * innego zakresu dla tego samego wywołania (patrz gotcha "bramka i zlew oglądają jeden ciąg",
 * `modules/tools/CLAUDE.md`).
 *
 * `source` mówi DLACZEGO padł dany zakres:
 * - `'explicit'` — model podał `scope:"vault"` albo `scope:"memory"` wprost. Zachowanie
 *   BEZ ZMIAN (włącznie z bramkami fail-closed dla `scope:"memory"` — `denied_memory`/`no_agent`
 *   liczą się dalej w `execute`, ta funkcja ich nie powiela).
 * - `'default'` — brak `scope` (albo nierozpoznana wartość, np. literówka `"Vault"`) i wołający
 *   ma czynną pamięć → **nowy default: pamięć wołającego agenta**, nie notatki usera.
 * - `'default_fallback'` — brak `scope`, ale domyślna pamięć nie ma sensu dla TEGO wywołania →
 *   spadek na `vault`, z powodem:
 *   - `'sub_agent'` — wywołanie z wnętrza sub-agenta (`_invocationDelegationDepth > 0`, zaufany
 *     znacznik wstrzykiwany przez `MCPClient.ts`/`SubAgentRunner.ts`). Sub nie ma własnej
 *     szuflady pamięci — jego robota to notatki usera; rama suba każe mu podać `scope="memory"`
 *     jawnie, gdy naprawdę chce pamięć rodzica (`modules/sub-agents/framePrompt.ts`).
 *   - `'memory_off'` — agent (ta sama tożsamość i ten sam warunek, co bramka `denied_memory`
 *     w `execute`) ma `permissions.memory === false`. Fallback na `vault` zamiast odmowy —
 *     domyślne wywołanie bez `scope` ma dalej znaleźć notatki usera, nie zwrócić błąd.
 *   - `'no_memory'` — `resolveAgentMemory` nie znalazła pamięci (brak `agentManagera` albo brak
 *     wpisu dla tożsamości). Bez tego domyślne `search` kończyłoby się `no_agent`.
 *
 * Tożsamość wołającego liczy WYŁĄCZNIE `getInvocationAgentName` (ten sam kanon co reszta
 * modułu) — zero nowego zjazdu na "aktywnego agenta".
 */
export type SearchScopeDecision =
    | { scope: 'vault' | 'memory'; source: 'explicit' }
    | { scope: 'memory'; source: 'default' }
    | { scope: 'vault'; source: 'default_fallback'; reason: 'sub_agent' | 'memory_off' | 'no_memory' };

export function resolveSearchScope(
    args: SearchToolArgs | null | undefined,
    plugin: SearchToolPlugin | null | undefined,
): SearchScopeDecision {
    if (args?.scope === 'vault' || args?.scope === 'memory') {
        return { scope: args.scope, source: 'explicit' };
    }

    const delegationDepth = args?._invocationDelegationDepth;
    if (typeof delegationDepth === 'number' && delegationDepth > 0) {
        return { scope: 'vault', source: 'default_fallback', reason: 'sub_agent' };
    }

    const agentManager = plugin?.agentManager;
    const invocationAgentName = getInvocationAgentName(args, agentManager);
    // Tożsamość i bramka `permissions.memory` — DOKŁADNIE ten sam warunek, co `denied_memory`
    // w `execute` (jawne `scope:"memory"`), żeby default i jawne wywołanie zgadzały się co do
    // tego, komu wolno dostać pamięć.
    const agent = agentManager?.getAgent?.(invocationAgentName) || agentManager?.getActiveAgent?.();
    if (agent?.permissions?.memory === false) {
        return { scope: 'vault', source: 'default_fallback', reason: 'memory_off' };
    }

    if (!resolveAgentMemory(plugin, invocationAgentName)) {
        return { scope: 'vault', source: 'default_fallback', reason: 'no_memory' };
    }

    return { scope: 'memory', source: 'default' };
}

/** Buduje RetrievalEngine podpięty pod kontekst pluginu dla danego scope. */
function buildEngine(plugin: SearchToolPlugin, scope: SemanticScope, agentName: string | null, includeHiddenVault = false) {
    const app = plugin?.app || null;
    const vault = app?.vault;
    if (!vault) throw new Error('Vault unavailable');
    const embeddingHelper = plugin?.env ? new EmbeddingHelper(plugin.env) : null;
    const oramaDb = plugin?.oramaDb || null; // publikowany przez VaultIndexer; null → keyword only
    const agentMemory = scope === 'memory' ? resolveAgentMemory(plugin, agentName) : null;
    // app przekazujemy zawsze — scope=vault jest API-first (getMarkdownFiles/metadataCache),
    // scope=memory i tak spada na adapter (pamięć poza indeksem Obsidiana).
    // `RetrievalEngine` mieszka jeszcze w JS — argumenty przechodzą przez asercję do jego
    // luźnego kontraktu; kształt jest sprawdzony po stronie silnika.
    return new RetrievalEngine({ app, vault, embeddingHelper, oramaDb, agentMemory, includeHiddenVault } as never);
}

export function createSearchTool() {
    return {
        name: 'search',
        description: t('mcp.search.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: t('mcp.search.param.query') },
                scope: { type: 'string', enum: ['vault', 'memory'], description: t('mcp.search.param.scope') },
                where: {
                    type: 'object',
                    description: t('mcp.search.param.where'),
                    properties: {
                        folder: { type: 'string', description: t('mcp.search.param.where.folder') },
                        glob: { type: 'string', description: t('mcp.search.param.where.glob') },
                        yaml: { type: 'object', description: t('mcp.search.param.where.yaml') },
                        links_to: { type: 'string', description: t('mcp.search.param.where.links_to') },
                        links_from: { type: 'string', description: t('mcp.search.param.where.links_from') }
                    }
                },
                mode: { type: 'string', enum: ['auto', 'keyword', 'semantic'], description: t('mcp.search.param.mode') },
                limit: { type: 'number', description: t('mcp.search.param.limit') }
            }
        },
        // targetPath dla AccessGuard: memory (jawne albo domyślne) → '' (bramkuje osobno
        // permission pamięci); vault → folder. `resolveSearchScope` jest TĄ SAMĄ funkcją, którą
        // woła `execute` — bramka i egzekucja nie mogą ocenić różny zakres dla tego samego
        // wywołania. Args docierają tu już PO nadpisaniu zaufanych znaczników przez `MCPClient`
        // (`_extractToolContext` woła `contextExtractor` na `argsWithContext`), więc
        // `_invocationDelegationDepth`/`_invocationAgentName` w worku są zaufane.
        contextExtractor: (args: SearchToolArgs, ctx: { plugin?: SearchToolPlugin | null }) => ({
            targetPath: resolveSearchScope(args, ctx?.plugin).scope === 'memory'
                ? ''
                : ((args?.where as SearchWhere)?.folder || '')
        }),
        execute: async (args: SearchToolArgs, _app: unknown, plugin: SearchToolPlugin) => {
            try {
                const decision = resolveSearchScope(args, plugin);
                const scope: SemanticScope = decision.scope;
                const where: SearchWhere = (args?.where && typeof args.where === 'object' && !Array.isArray(args.where)) ? { ...args.where } : {};
                const agentManager = plugin?.agentManager;
                const invocationAgentName = getInvocationAgentName(args, agentManager);
                const adminAccess = invocationHasAdminAccess(args, plugin);

                // Bramka pamięci — fail-closed: scope=memory wymaga uprawnienia memory agenta.
                // Dla domyślnego memory (`decision.source === 'default'`) ten warunek jest z
                // KONSTRUKCJI zawsze fałszywy — `resolveSearchScope` już sprawdziła to samo
                // uprawnienie i spadłaby na `vault`, gdyby było wyłączone. Bramka zostaje mimo
                // to JEDNYM miejscem tej reguły (nie dwiema kopiami), więc jawne
                // `scope:"memory"` z wyłączonym uprawnieniem dalej kończy się `denied_memory`.
                if (scope === 'memory') {
                    const agent = agentManager?.getAgent?.(invocationAgentName) || agentManager?.getActiveAgent?.();
                    if (agent?.permissions?.memory === false) {
                        return { success: false, error: t('mcp.search.denied_memory') };
                    }
                }

                // Sanityzacja folderu (tylko vault).
                if (scope === 'vault' && where.folder) {
                    const validation = validateVaultFolder(where.folder, { adminAccess });
                    if (!validation.ok) return { success: false, error: t('mcp.search.invalid_folder') };
                    where.folder = validation.safePath;
                }

                const engine = buildEngine(plugin, scope, invocationAgentName, adminAccess);
                if (scope === 'memory' && !engine.agentMemory) {
                    return { success: false, error: t('mcp.search.no_agent') };
                }

                const r = await engine.runSearch({
                    query: args?.query,
                    scope,
                    where,
                    mode: args?.mode,
                    limit: args?.limit
                } as never);

                // Nota degradacji: semantyka była oczekiwana ale niedostępna/pusta.
                const note = (r.semantic.requested && !r.semantic.used)
                    ? buildSemanticNote({ plugin, scope })
                    : undefined;

                // `runSearch` niesie opcjonalne `scan: {candidates, scanned, truncated}`
                // WYŁĄCZNIE gdy skan keyword był obcięty sufitem 300 kandydatów — bez
                // przekazania tego dalej agent nie wie, że nie widział całego vaulta. Odczyt
                // przez bezpieczny rzut, bo `SearchOutcome` nie deklaruje tego pola jako zawsze
                // obecnego. Pole dopisywane TYLKO gdy obecne — brak `scan` (skan nieobcięty)
                // daje wynik bajtowo identyczny jak bez tego pola.
                const scan = (r as { scan?: { candidates: number; scanned: number; truncated: boolean } }).scan;

                return {
                    success: true,
                    query: typeof args?.query === 'string' ? args.query : '',
                    scope,
                    mode_used: r.mode_used,
                    results: r.results,
                    total: r.total,
                    // Model ma dostać wprost, że domyślne (bez `scope`) wywołanie przeszukało
                    // TYLKO pamięć — pusty wynik stąd nie znaczy "notatki nie ma w vaultcie".
                    // Jawne `scope` (memory albo vault) tego pola NIE dostaje — wynik zostaje
                    // bajtowo identyczny jak dziś.
                    ...(decision.source === 'default' ? { scope_hint: t('mcp.search.scope_hint_default_memory') } : {}),
                    ...(note ? { note } : {}),
                    ...(scan ? { scan } : {})
                };
            } catch (e) {
                log.error('SearchTool', 'Error:', e);
                return { success: false, error: (e as Error).message };
            }
        }
    };
}
