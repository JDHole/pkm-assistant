/**
 * RetrievalEngine — silnik jednego narzędzia `search` (E2.5).
 *
 * Zastępuje dawną kaskadę 3-warstwową (L1 struktura → L2 tekst → L3 semantyka) i
 * jej hybryda. Nowy kontrakt: JEDNO wyszukiwanie z filtrem kandydatów (`where`) +
 * fuzją keyword/semantic przez RRF (Reciprocal Rank Fusion, k=60).
 *
 *   1. Kandydaci wg `where` (folder / glob / yaml / links_to / links_from).
 *   2. Ranking keyword (liczba wystąpień frazy) + semantyczny (Orama, tylko vault).
 *   3. Fuzja RRF (mode=auto) albo pojedynczy ranking (mode=keyword|semantic).
 *   4. Excerpt czytany Z DYSKU (naprawa dawnego bugu pustego `body`).
 *
 * Scope:
 *   - 'vault'  — pliki poza `.pkm-assistant/`; semantyka DOSTĘPNA (plugin.oramaDb).
 *   - 'memory' — pamięć AKTUALNEGO agenta (brain.md + brain/ + sessions active/archive
 *                + summaries L1/L2/L3); semantyka NIEDOSTĘPNA (izolacja od indeksu vaulta).
 *
 * Konsument: `modules/mcp/SearchTool.js` (thin wrapper — buduje engine z pluginu,
 * bramkuje uprawnienie pamięci, formatuje wynik). Chat/sub-agenci NIE wołają engine
 * bezpośrednio — idą przez narzędzie `search`. DI (vault/embeddingHelper/oramaDb/
 * agentMemory/vectorSearch/parseFrontmatter) trzyma silnik testowalnym.
 */

import { maskSensitiveData } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { searchVectorTopK } from '../embedding/index.js';

const DEFAULT_LIMIT = 10;
const RRF_K = 60;
const EXCERPT_LEN = 200;

/**
 * AUD-wydajnosc-024/055/075: sufit PRACY (nie tylko wyniku) dla skanu treści w
 * `_keywordRank`. Bez `where`, `_gatherCandidates` może zwrócić CAŁY vault — bez tego
 * sufitu jedno `search` czyta i lowercase'uje treść każdej notatki (sekwencyjnie, przed
 * fuzją), a `delegate` mnoży to przez do 5 równoległych subów. Kandydaci, których
 * nazwa/basename pasuje do słowa zapytania, mają pierwszeństwo skanu (tania heurystyka
 * bez I/O w `_prioritizeForScan`) — realne trafienia po nazwie nie giną przy obcięciu.
 * `where` (folder/glob/yaml/links) nadal zawęża PRZED tym sufitem, więc zawężone
 * wyszukiwanie go w praktyce nie dotyka. Kontrakt niezmieniony poniżej sufitu.
 * ⚠️ Sufit dotyczy TYLKO scope='vault' — dla scope='memory' jest wyłączony w
 * `_scanKeywordCandidates` (patrz komentarz tam): pamięć agenta jest jego własnymi,
 * z natury ograniczonymi danymi, a listing brain→sessions/archive→L1-L3 gubił L1-L3
 * za sufitem u agentów z długim archiwum.
 */
const MAX_KEYWORD_SCAN_CANDIDATES = 300;

type ErrLike = { message?: string };

// ═════════════════════════ Kontrakty wstrzykiwane (DI) ═════════════════════════
//
// Wszystko strukturalnie (`type XLike`): silnik dostaje te obiekty z zewnątrz —
// z Obsidiana (`app`, `vault`), z `AgentMemory` i z testowych atrap — i nigdy ich
// nie tworzy sam.

/** Adapter FS vaulta w zakresie, którego dotyka retrieval. */
export interface RetrievalVaultAdapterLike {
    read(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files?: string[]; folders?: string[] } | null>;
}

export interface RetrievalVaultLike {
    adapter: RetrievalVaultAdapterLike;
}

/** Plik vaulta widziany przez API Obsidiana (TFile) — folder (TFolder) ma `children`. */
export interface VaultFileLike {
    path: string;
    name?: string;
    children?: unknown[];
}

/** Obsidian App w zakresie E2.6 (API-first dla scope=vault). */
export interface RetrievalAppLike {
    vault?: {
        getMarkdownFiles?: () => VaultFileLike[];
        getAbstractFileByPath?: (path: string) => VaultFileLike | null;
        cachedRead?: (file: VaultFileLike) => Promise<string>;
    };
    metadataCache?: {
        getFileCache?: (file: VaultFileLike) => { frontmatter?: Record<string, unknown> | null } | null;
        resolvedLinks?: Record<string, Record<string, number>>;
        getFirstLinkpathDest?: (linkpath: string, sourcePath: string) => { path: string } | null;
    };
}

/** Helper embeddingów — silnik potrzebuje z niego wyłącznie `embed`. */
export interface RetrievalEmbeddingHelperLike {
    embed(text: string): Promise<number[]>;
}

/** Fragment `AgentMemory` używany przez scope=memory (same ścieżki). */
export interface RetrievalAgentMemoryLike {
    paths?: {
        brain: string;
        brainNotes: string;
        sessionsActive: string;
        sessionsArchive: string;
        l1: string;
        l2: string;
        l3: string;
    };
}

/** Trafienie z Oramy w kształcie, który czyta ranking semantyczny. */
export interface VectorHitLike {
    document?: { path?: string };
    score?: number;
}

/** Override `searchVectorTopK` (testy podstawiają własną implementację). */
export type VectorSearchFn = (
    db: unknown,
    vector: number[],
    options: { k?: number },
) => Promise<{ hits?: VectorHitLike[] } | null | undefined>;

/** Parser frontmatteru — domyślny albo wstrzyknięty w testach. */
export type FrontmatterParser = (content: string) => Record<string, unknown>;

export interface RetrievalEngineDeps {
    vault?: RetrievalVaultLike;
    app?: RetrievalAppLike | null;
    embeddingHelper?: RetrievalEmbeddingHelperLike | null;
    oramaDb?: unknown;
    agentMemory?: RetrievalAgentMemoryLike | null;
    vectorSearch?: VectorSearchFn | null;
    parseFrontmatter?: FrontmatterParser | null;
    includeHiddenVault?: boolean;
}

// ═════════════════════════ Kontrakt wejścia/wyjścia `search` ═════════════════════════

/** Filtr kandydatów (`where`) — pola łączone koniunkcją. */
export interface SearchWhere {
    folder?: string;
    glob?: string;
    yaml?: Record<string, unknown>;
    links_to?: string;
    links_from?: string;
}

export interface RunSearchParams {
    query?: string;
    /** 'vault' (default) albo 'memory'; każda inna wartość ląduje na 'vault' */
    scope?: string;
    where?: SearchWhere;
    /** 'auto' (default) | 'keyword' | 'semantic'; nieznana wartość ląduje na 'auto' */
    mode?: string;
    limit?: number;
}

/**
 * Jeden wynik. `score` nie ma przy listingu (brak query = brak rankingu) — dokładnie
 * jak w oryginale, gdzie gałąź listingu po prostu nie dokłada tego pola.
 */
export interface SearchResult {
    path: string;
    title: string;
    score?: number;
    excerpt: string;
    matched: string[];
}

/**
 * Uczciwa nota o obcięciu skanu keyword (AUD-wydajnosc-024/055): ile kandydatów w ogóle
 * spełniało `where`, ile z nich faktycznie przeczytaliśmy przed obcięciem na
 * `MAX_KEYWORD_SCAN_CANDIDATES`. Obecne w wyniku TYLKO gdy `truncated` — poniżej sufitu
 * kontrakt jest identyczny jak przed naprawą (pole nieobecne).
 */
export interface SearchScanInfo {
    candidates: number;
    scanned: number;
    truncated: boolean;
}

export interface SearchOutcome {
    mode_used: string;
    results: SearchResult[];
    total: number;
    semantic: { requested: boolean; used: boolean };
    /** Obecne tylko gdy skan keyword został obcięty sufitem — patrz `SearchScanInfo`. */
    scan?: SearchScanInfo;
}

/** Kandydat po filtrach `where`. */
interface Candidate {
    path: string;
    name: string;
}

/** Kandydat z pamięci niesie dodatkowo etykietę logicznego folderu. */
interface MemoryCandidate extends Candidate {
    logical: string;
}

/** Pozycja rankingu keyword. */
interface KeywordHit {
    path: string;
    name: string;
    count: number;
    pos: number;
}

/** Pozycja po fuzji (albo pojedynczym rankingu). */
interface FusedHit {
    path: string;
    score: number;
    matched: string[];
}

/** Czytnik z cache'em treści, przekazywany w dół z `runSearch`. */
type ReadCached = (path: string) => Promise<string | null>;

/** Wynik skanu keyword: trafienia + uczciwa nota o obcięciu (AUD-wydajnosc-024/055). */
interface KeywordScanResult {
    hits: KeywordHit[];
    scan: SearchScanInfo;
}

/**
 * Dedup równoległych identycznych skanów (AUD-wydajnosc-075): `delegate` może odpalić do
 * `max_parallel_delegations` sub-agentów naraz, każdy z WŁASNĄ instancją `RetrievalEngine`
 * (`SearchTool.buildEngine` tworzy nową per tool call) ale nad TYM SAMYM `plugin.app.vault`.
 * Bez tego pięć identycznych `search({query})` bez `where` czytałoby ten sam skan pięć razy
 * równolegle. Klucz zewnętrzny to identyczność obiektu `vault` (stabilna w Obsidianie na
 * czas życia pluginu; w testach każdy `vaultOf()` to nowy obiekt, więc testy się nie mieszają).
 * Wpis żyje TYLKO na czas trwania skanu (czyszczony w `finally`) — to dedup w locie, nie cache.
 */
const _inFlightKeywordScans = new WeakMap<object, Map<string, Promise<KeywordScanResult>>>();

export class RetrievalEngine {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare vault: RetrievalVaultLike;
    declare app: RetrievalAppLike | null;
    declare embeddingHelper: RetrievalEmbeddingHelperLike | null;
    declare oramaDb: unknown;
    declare agentMemory: RetrievalAgentMemoryLike | null;
    declare includeHiddenVault: boolean;
    declare private _vectorSearch: VectorSearchFn | null;
    declare private _parseFrontmatter: FrontmatterParser;

    /**
     * @param deps.vault - Obsidian Vault (używamy vault.adapter: read/list/exists)
     * @param deps.app - Obsidian App (E2.6). Gdy obecne, scope=vault jest API-first:
     *   getMarkdownFiles/cachedRead/metadataCache (frontmatter + resolvedLinks). Bez app → walker
     *   adapterowy + ręczny parser + regexy (wsteczna zgodność testów). scope=memory ZAWSZE adapter
     *   (metadataCache nie widzi `.pkm-assistant/`).
     * @param deps.embeddingHelper - EmbeddingHelper (embed(query)) dla semantyki vault
     * @param deps.oramaDb - indeks Orama vaulta (VaultIndexer, E1.4)
     * @param deps.agentMemory - AgentMemory aktualnego agenta (scope:'memory')
     * @param deps.vectorSearch - override searchVectorTopK(db, vec, {k}) dla testów
     * @param deps.parseFrontmatter - override parsera frontmatteru dla testów
     * @param deps.includeHiddenVault - A1: admin może przeszukiwać
     *   markdown także w ukrytych folderach vaulta (adapter walker zamiast indeksu Obsidiana)
     */
    constructor(deps: RetrievalEngineDeps = {}) {
        // `!`: bez vaulta silnik i tak nie ma z czego czytać — kod w całości zakłada,
        // że wołacz go podał (tak jest we wszystkich wywołaniach i atrapach testów).
        this.vault = deps.vault!;
        this.app = deps.app || null;
        this.embeddingHelper = deps.embeddingHelper || null;
        this.oramaDb = deps.oramaDb || null;
        this.agentMemory = deps.agentMemory || null;
        this.includeHiddenVault = deps.includeHiddenVault === true;
        this._vectorSearch = deps.vectorSearch || null;
        this._parseFrontmatter = deps.parseFrontmatter || this._defaultParseFrontmatter;
    }

    /** TFolder ma `children`; TFile nie. Duck-typing zamiast importu obsidian. */
    private _isFile(abstractFile: VaultFileLike | null | undefined): boolean {
        return !!abstractFile && !Array.isArray(abstractFile.children);
    }

    /**
     * Główne wejście narzędzia `search`.
     *
     * @param params.query - fraza; brak → listing wg `where`
     * @param params.where - { folder, glob, yaml, links_to, links_from } (AND)
     */
    async runSearch(params: RunSearchParams = {}): Promise<SearchOutcome> {
        const query = typeof params.query === 'string' ? params.query.trim() : '';
        const scope = params.scope === 'memory' ? 'memory' : 'vault';
        const where: SearchWhere = params.where && typeof params.where === 'object' ? params.where : {};
        const mode = ['auto', 'keyword', 'semantic'].includes(params.mode as string) ? params.mode as string : 'auto';
        const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_LIMIT, 1), 50);

        const contentCache = new Map<string, string | null>();
        const readCached = async (path: string): Promise<string | null> => {
            if (contentCache.has(path)) return contentCache.get(path) as string | null;
            let content: string | null = null;
            try {
                // E2.6: pliki vaulta czytamy przez vault.cachedRead (API). Pamięć (.pkm-assistant/)
                // nie jest w indeksie → getAbstractFileByPath zwróci null → adapter.read fallback.
                // Feature-detect metod (testy podają czasem tylko adapter).
                const getFile = this.app?.vault?.getAbstractFileByPath;
                const file = (typeof getFile === 'function') ? getFile.call(this.app!.vault, path) : null;
                content = (file && this._isFile(file) && typeof this.app!.vault!.cachedRead === 'function')
                    ? await this.app!.vault!.cachedRead(file)
                    : await this.vault.adapter.read(path);
            } catch { content = null; }
            contentCache.set(path, content);
            return content;
        };

        // 1. Zbiór kandydatów wg where.
        const candidates = await this._gatherCandidates(scope, where, readCached);

        // 2. Listing (brak query) — zwróć kandydatów bez rankingu.
        if (!query) {
            const sliced = candidates.slice(0, limit);
            const results: SearchResult[] = [];
            for (const c of sliced) {
                const content = await readCached(c.path);
                results.push({
                    path: c.path,
                    title: this._title(content, c.name),
                    excerpt: this._excerptStart(content || ''),
                    matched: []
                });
            }
            return { mode_used: 'listing', results, total: candidates.length, semantic: { requested: false, used: false } };
        }

        // 3. Rankingi.
        const semanticAvailable = this._semanticAvailable(scope);
        const semanticRequested = mode === 'semantic' || mode === 'auto';

        let keywordRanking: KeywordHit[] = [];
        let keywordScan: SearchScanInfo | null = null;
        const needKeyword = mode === 'keyword' || mode === 'auto' || (mode === 'semantic' && !semanticAvailable);
        if (needKeyword) {
            const kr = await this._keywordRank(candidates, query, readCached, contentCache, scope, where);
            keywordRanking = kr.hits;
            keywordScan = kr.scan;
        }

        let semanticRanking: Array<{ path: string; score: number }> = [];
        if (semanticRequested && semanticAvailable) {
            semanticRanking = await this._semanticRank(query, candidates, where, limit);
        }

        // 4. Fuzja.
        let fused: FusedHit[];
        let mode_used: string;
        let semanticUsed = false;
        if (mode === 'keyword') {
            fused = keywordRanking.map(r => ({ path: r.path, score: r.count, matched: ['keyword'] }));
            mode_used = 'keyword';
        } else if (mode === 'semantic') {
            if (semanticAvailable && semanticRanking.length > 0) {
                fused = semanticRanking.map(r => ({ path: r.path, score: r.score, matched: ['semantic'] }));
                mode_used = 'semantic';
                semanticUsed = true;
            } else {
                // Fallback do keyword + nota (jak dawny vault_semantic).
                fused = keywordRanking.map(r => ({ path: r.path, score: r.count, matched: ['keyword'] }));
                mode_used = 'keyword';
            }
        } else { // auto
            if (semanticRanking.length > 0) {
                fused = this._rrfFuse([
                    { name: 'keyword', paths: keywordRanking.map(r => r.path) },
                    { name: 'semantic', paths: semanticRanking.map(r => r.path) }
                ]);
                mode_used = 'hybrid';
                semanticUsed = true;
            } else {
                fused = keywordRanking.map(r => ({ path: r.path, score: r.count, matched: ['keyword'] }));
                mode_used = 'keyword';
            }
        }

        // 5. Wynik + excerpt z dysku.
        const top = fused.slice(0, limit);
        const results: SearchResult[] = [];
        for (const item of top) {
            const content = await readCached(item.path);
            results.push({
                path: item.path,
                title: this._title(content, item.path.split('/').pop()),
                score: Math.round(item.score * 10000) / 10000,
                excerpt: this._excerpt(content || '', query),
                matched: item.matched
            });
        }

        return {
            mode_used,
            results,
            total: fused.length,
            semantic: { requested: semanticRequested, used: semanticUsed },
            // Kontrakt niezmieniony poniżej sufitu: pole obecne TYLKO gdy skan obcięty.
            ...(keywordScan && keywordScan.truncated ? { scan: keywordScan } : {})
        };
    }

    // ───────────────────────── Kandydaci ─────────────────────────

    private async _gatherCandidates(scope: string, where: SearchWhere, readCached: ReadCached): Promise<Candidate[]> {
        let candidates: Candidate[] = scope === 'memory'
            ? await this._listMemoryFiles(where.folder)
            : await this._listVaultFiles({ folder: where.folder, glob: where.glob });

        // Memory: glob stosujemy post (listing pamięci nie zna glob).
        if (scope === 'memory' && where.glob) {
            candidates = candidates.filter(c => this._matchesGlob(c.name, where.glob!) || this._matchesGlob(c.path, where.glob!));
        }

        // E2.6: dla scope=vault z app używamy metadataCache.resolvedLinks (precyzyjne, po ścieżkach).
        // scope=memory (i brak app) → dawna logika basename/regex (metadataCache nie widzi pamięci).
        const useResolvedLinks = scope === 'vault' && this.app?.metadataCache?.resolvedLinks;

        // links_from: pliki, do których linkuje podana notatka (forward).
        if (where.links_from) {
            if (useResolvedLinks) {
                const targets = this._resolvedForwardLinkPaths(where.links_from);
                candidates = candidates.filter(c => targets.has(c.path));
            } else {
                const targets = await this._resolveForwardLinks(where.links_from, scope);
                candidates = candidates.filter(c => targets.has(this._baseName(c.name)));
            }
        }

        // links_to: pliki, które linkują DO podanej notatki (backlinks).
        if (where.links_to) {
            if (useResolvedLinks) {
                const sources = this._resolvedBacklinkPaths(where.links_to);
                candidates = candidates.filter(c => sources.has(c.path));
            } else {
                candidates = await this._filterByBacklink(candidates, where.links_to, readCached);
            }
        }

        // yaml: frontmatter filter (AND wszystkich pól).
        if (where.yaml && typeof where.yaml === 'object' && Object.keys(where.yaml).length > 0) {
            const filtered: Candidate[] = [];
            for (const c of candidates) {
                const fm = await this._frontmatterFor(c.path, readCached);
                if (this._matchesFrontmatter(fm, where.yaml)) filtered.push(c);
            }
            candidates = filtered;
        }

        return candidates;
    }

    private async _listVaultFiles({ folder, glob }: { folder?: string; glob?: string } = {}): Promise<Candidate[]> {
        // E2.6: z app → getMarkdownFiles (indeks Obsidiana). .pkm-assistant/ i tak niewidoczne
        // dla API (podwójny bezpiecznik zostaje). Bez app → dawny walker adapterowy (fallback testów).
        if (this.app?.vault?.getMarkdownFiles && !this.includeHiddenVault) {
            const prefix = (folder && folder !== '/') ? `${String(folder).replace(/\/+$/, '')}/` : '';
            const out: Candidate[] = [];
            for (const f of this.app.vault.getMarkdownFiles()) {
                const p = f.path;
                if (!this.includeHiddenVault && p.startsWith('.pkm-assistant/')) continue;
                if (prefix && !p.startsWith(prefix)) continue;
                if (glob && !this._matchesGlob(p, glob)) continue;
                out.push({ path: p, name: (f.name || p.split('/').pop()) as string });
            }
            return out;
        }
        const acc: Candidate[] = [];
        const root = folder || '/';
        await this._walkVault(root, acc, glob);
        return acc;
    }

    /** Frontmatter kandydata: metadataCache (vault, gdy app) albo ręczny parser (fallback / pamięć). */
    private async _frontmatterFor(path: string, readCached: ReadCached): Promise<Record<string, unknown>> {
        const getFile = this.app?.vault?.getAbstractFileByPath;
        if (this.app?.metadataCache && typeof getFile === 'function') {
            const file = getFile.call(this.app.vault, path);
            if (file && this._isFile(file)) {
                const cache = this.app.metadataCache.getFileCache?.(file);
                if (cache) return cache.frontmatter || {};
            }
        }
        const content = await readCached(path);
        return this._parseFrontmatter(content || '');
    }

    /** Rozwiąż link/nazwę notatki na ścieżkę vaulta (metadataCache.getFirstLinkpathDest). */
    private _resolveLinkPath(ref: unknown): string | null {
        const linkpath = String(ref || '').replace(/\.md$/i, '');
        const dest = this.app?.metadataCache?.getFirstLinkpathDest?.(linkpath, '');
        return dest?.path || null;
    }

    /** Ścieżki, do których linkuje podana notatka (forward) — z resolvedLinks. */
    private _resolvedForwardLinkPaths(ref: unknown): Set<string> {
        const out = new Set<string>();
        const srcPath = this._resolveLinkPath(ref);
        if (!srcPath) return out;
        const links = this.app!.metadataCache!.resolvedLinks![srcPath] || {};
        for (const target of Object.keys(links)) out.add(target);
        return out;
    }

    /** Ścieżki źródeł, które linkują DO podanej notatki (backlinks) — z resolvedLinks. */
    private _resolvedBacklinkPaths(ref: unknown): Set<string> {
        const out = new Set<string>();
        const targetPath = this._resolveLinkPath(ref);
        if (!targetPath) return out;
        const all = this.app!.metadataCache!.resolvedLinks || {};
        for (const [src, targets] of Object.entries(all)) {
            if (targets && targets[targetPath]) out.add(src);
        }
        return out;
    }

    /**
     * Walks the vault through the adapter (not the Vault API) on purpose — it is the only
     * way to reach hidden `.pkm-assistant` paths, which Obsidian never lists as files.
     * Reached only when `includeHiddenVault` is on (SearchTool gates that flag behind
     * `agent.admin_access`, see invocationHasAdminAccess) or when no `app` is injected
     * (test fallback); otherwise `_listVaultFiles` uses `getMarkdownFiles()`.
     * Deliberate admin capability, not a missed Vault API call.
     */
    private async _walkVault(rootPath: string, accumulator: Candidate[], globPattern?: string, depth = 0): Promise<void> {
        if (depth > 8) return; // safety
        try {
            const listed = await this.vault.adapter.list(rootPath);
            for (const p of listed?.files || []) {
                if (!p.endsWith('.md')) continue;
                if (p.startsWith('.pkm-assistant/')) continue; // dane pluginu poza vault scope
                if (globPattern && !this._matchesGlob(p, globPattern)) continue;
                accumulator.push({ path: p, name: p.split('/').pop() as string });
            }
            for (const subFolder of listed?.folders || []) {
                if (!this.includeHiddenVault && subFolder.startsWith('.pkm-assistant')) continue;
                await this._walkVault(subFolder, accumulator, globPattern, depth + 1);
            }
        } catch { /* katalog nie istnieje */ }
    }

    /**
     * Pliki pamięci aktualnego agenta z logiczną etykietą folderu.
     * folderFilter (where.folder): 'brain' | 'sessions' | 'sessions/active' |
     * 'summaries' | 'summaries/L1' ... — prefiksowe dopasowanie po etykiecie.
     */
    private async _listMemoryFiles(folderFilter?: string | null): Promise<MemoryCandidate[]> {
        const m = this.agentMemory;
        if (!m?.paths) return [];
        const out: MemoryCandidate[] = [];
        const push = (path: string, logical: string) => out.push({ path, name: path.split('/').pop() as string, logical });
        const listDir = async (dir: string, logical: string) => {
            try {
                const listed = await this.vault.adapter.list(dir);
                for (const p of listed?.files || []) if (p.endsWith('.md')) push(p, logical);
            } catch { /* folder nie istnieje */ }
        };

        try { if (await this.vault.adapter.exists(m.paths.brain)) push(m.paths.brain, 'brain'); } catch { /* skip */ }
        await listDir(m.paths.brainNotes, 'brain');
        await listDir(m.paths.sessionsActive, 'sessions/active');
        await listDir(m.paths.sessionsArchive, 'sessions/archive');
        await listDir(m.paths.l1, 'summaries/L1');
        await listDir(m.paths.l2, 'summaries/L2');
        await listDir(m.paths.l3, 'summaries/L3');

        if (!folderFilter) return out;
        const f = String(folderFilter).replace(/^\/+|\/+$/g, '').toLowerCase();
        if (!f) return out;
        return out.filter(e => {
            const logical = e.logical.toLowerCase();
            return logical === f || logical.startsWith(`${f}/`);
        });
    }

    // ───────────────────────── Rankingi ─────────────────────────

    /**
     * Ranking keyword po LICZBIE wystąpień frazy (nie boolean match) — z dedupem w locie
     * (AUD-wydajnosc-075): pięć równoległych identycznych `search` (ta sama tożsamość
     * `vault` + scope + where + query) dzieli JEDEN skan zamiast pięciu.
     *
     * ⚠️ BLOKER naprawiony w review rundy 2 (2026-09-02): `plugin.app.vault` jest JEDNYM
     * obiektem dla WSZYSTKICH agentów (`SearchTool.buildEngine` tworzy nową instancję
     * silnika per tool call, ale nad tym samym vaultem) — klucz musi więc identyfikować
     * FAKTYCZNY zbiór kandydatów, nie tylko etykiety `scope`/`where`/`query`, inaczej dwaj
     * suby różnych agentów pytający `{scope:'memory', query:'projekt'}` RÓWNOLEGLE dzielą
     * ten sam skan i jeden dostaje wyniki z `brain/` drugiego (złamanie strict cross-agent
     * isolation Memory v3). Klucz niesie teraz explicit root pamięci agenta (`agentMemory.
     * paths.brain` — pusty dla scope='vault') + `includeHiddenVault` (admin widzi INNY
     * zbiór plików niż zwykły user na tym samym `where`) + odcisk POSORTOWANYCH ścieżek
     * `candidates` PO filtrze scope/where (`_candidateFingerprint`) jako ostateczny,
     * niezależny od powyższych dwóch, dowód identyczności zbioru — fail-closed na
     * wszystko, czego jeszcze nie wymyśliliśmy jako źródła różnicy w kandydatach.
     */
    private async _keywordRank(
        candidates: Candidate[],
        query: string,
        readCached: ReadCached,
        contentCache: Map<string, string | null>,
        scope: string,
        where: SearchWhere,
    ): Promise<KeywordScanResult> {
        const memoryRoot = scope === 'memory' ? (this.agentMemory?.paths?.brain || '') : '';
        const key = [
            scope,
            memoryRoot,
            this.includeHiddenVault ? '1' : '0',
            JSON.stringify(where || {}),
            query.toLowerCase(),
            this._candidateFingerprint(candidates)
        ].join('::');
        let bucket = _inFlightKeywordScans.get(this.vault);
        if (!bucket) {
            bucket = new Map();
            _inFlightKeywordScans.set(this.vault, bucket);
        }
        const pending = bucket.get(key);
        if (pending) return pending;

        const run = this._scanKeywordCandidates(candidates, query, readCached, contentCache, scope);
        bucket.set(key, run);
        try {
            return await run;
        } finally {
            bucket.delete(key);
        }
    }

    /**
     * Odcisk (nie kryptograficzny) POSORTOWANEGO zbioru ścieżek kandydatów — jedyny cel to
     * odróżnić dwa `_keywordRank` wywołania, których `scope`/`where`/`query` wyglądają
     * identycznie, ale kandydaci są RÓŻNI (dwaj agenci, admin vs zwykły user). Liczony raz
     * na wywołanie `runSearch` (nie per plik) — dla typowego zbioru kilkuset-kilku tysięcy
     * ścieżek to ułamek milisekundy, nieporównywalnie tańsze niż sam skan treści.
     */
    private _candidateFingerprint(candidates: Candidate[]): string {
        const sorted = candidates.map(c => c.path).sort();
        const joined = sorted.join('\n');
        let h1 = 0x811c9dc5;
        let h2 = 0x9e3779b9;
        for (let i = 0; i < joined.length; i++) {
            const code = joined.charCodeAt(i);
            h1 = Math.imul(h1 ^ code, 16777619);
            h2 = Math.imul(h2 ^ code, 2654435761);
        }
        return `${sorted.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
    }

    /**
     * Skan właściwy (jedno wykonanie na klucz dedupu z `_keywordRank`).
     *
     * Trzy naprawy naraz:
     *  - AUD-wydajnosc-024/055: kandydaci powyżej `MAX_KEYWORD_SCAN_CANDIDATES` są cięci
     *    PRZED czytaniem treści (nie tylko wynik) — `_prioritizeForScan` daje pierwszeństwo
     *    trafieniom w nazwie, żeby obcięcie nie gubiło oczywistych wyników.
     *  - AUD-wydajnosc-025: `contentCache` NIE ma trzymać treści wszystkich zeskanowanych
     *    plików do końca `runSearch` — po zliczeniu trafień dla kandydata jego treść jest
     *    od razu zwalniana (`contentCache.delete`). Excerpt dla `top` (:327, <= limit<=50)
     *    czyta ponownie — tani re-read, bez trzymania N pełnych treści naraz.
     *  - ⚠️ Korekta review rundy 2 (2026-09-02, POWAŻNE): sufit jest WYŁĄCZONY dla
     *    `scope==='memory'`. `_listMemoryFiles` listuje w kolejności brain → brain/ →
     *    sessions/active → sessions/**ARCHIVE** → dopiero L1 → L2 → L3 — u agenta z długim
     *    archiwum (>300 plików) podsumowania L1-L3 nigdy nie wpadały w pierwsze 300 i
     *    `_prioritizeForScan` nie ratuje (nazwy L1/L2/L3 są datowane, nie niosą słów
     *    zapytania). Pamięć JEDNEGO agenta jest z natury ograniczona (to jego własne dane,
     *    nie cały vault) — ryzyko O(rozmiar vaulta) z 024/055/075 tu nie występuje, więc
     *    sufit zostaje TYLKO dla scope='vault'.
     */
    private async _scanKeywordCandidates(
        candidates: Candidate[],
        query: string,
        readCached: ReadCached,
        contentCache: Map<string, string | null>,
        scope: string,
    ): Promise<KeywordScanResult> {
        const needle = query.toLowerCase();
        const totalCandidates = candidates.length;
        const capApplies = scope !== 'memory';
        const ordered = capApplies ? this._prioritizeForScan(candidates, needle) : candidates;
        const truncated = capApplies && ordered.length > MAX_KEYWORD_SCAN_CANDIDATES;
        const toScan = truncated ? ordered.slice(0, MAX_KEYWORD_SCAN_CANDIDATES) : ordered;

        const scored: KeywordHit[] = [];
        for (const c of toScan) {
            const content = await readCached(c.path);
            contentCache.delete(c.path);
            if (content == null) continue;
            const hay = content.toLowerCase();
            let count = 0;
            let first = -1;
            let idx = hay.indexOf(needle);
            while (idx !== -1) {
                if (first < 0) first = idx;
                count++;
                idx = hay.indexOf(needle, idx + needle.length);
            }
            const nameHit = c.name.toLowerCase().includes(needle);
            if (count > 0 || nameHit) {
                scored.push({
                    path: c.path,
                    name: c.name,
                    count: count + (nameHit ? 1 : 0),
                    pos: first < 0 ? Number.MAX_SAFE_INTEGER : first
                });
            }
        }
        scored.sort((a, b) => (b.count - a.count) || (a.pos - b.pos) || a.path.localeCompare(b.path));
        return {
            hits: scored,
            scan: { candidates: totalCandidates, scanned: toScan.length, truncated }
        };
    }

    /**
     * Tania heurystyka bez I/O (basename), stosowana TYLKO gdy naprawdę trzeba ciąć
     * (candidates > sufit): kandydaci, których nazwa zawiera słowo zapytania, idą na
     * początek listy skanu, żeby obcięcie nie gubiło oczywistych trafień po nazwie.
     */
    private _prioritizeForScan(candidates: Candidate[], needle: string): Candidate[] {
        if (candidates.length <= MAX_KEYWORD_SCAN_CANDIDATES) return candidates;
        const words = needle.split(/\s+/).filter(Boolean);
        if (words.length === 0) return candidates;
        const preferred: Candidate[] = [];
        const rest: Candidate[] = [];
        for (const c of candidates) {
            const name = c.name.toLowerCase();
            (words.some(w => name.includes(w)) ? preferred : rest).push(c);
        }
        return preferred.concat(rest);
    }

    /**
     * Ranking semantyczny przez Orama (tylko vault). Post-filtr do kandydatów gdy where obecne.
     * @returns sorted desc (Orama zwraca po score)
     */
    private async _semanticRank(
        query: string,
        candidates: Candidate[],
        where: SearchWhere,
        limit: number,
    ): Promise<Array<{ path: string; score: number }>> {
        if (!this._semanticAvailable('vault')) return [];
        try {
            const embedding = await this.embeddingHelper!.embed(query);
            if (!embedding || !embedding.length) return [];
            const vectorSearch = this._vectorSearch || (searchVectorTopK as unknown as VectorSearchFn);
            const k = Math.min(Math.max(limit * 3, limit), 100);
            const result = await vectorSearch(this.oramaDb, embedding, { k });
            let hits = (result?.hits || [])
                .map(h => ({ path: h.document?.path as string, score: h.score || 0 }))
                .filter(h => h.path);
            if (this._hasWhere(where)) {
                const set = new Set(candidates.map(c => c.path));
                hits = hits.filter(h => set.has(h.path));
            }
            return hits;
        } catch (e) {
            log.warn('RetrievalEngine', 'semantic rank failed:', (e as ErrLike)?.message || e);
            return [];
        }
    }

    /**
     * Reciprocal Rank Fusion. score(path) = Σ 1/(k + rank) po rankingach, w których path wystąpił.
     * @returns sorted desc
     */
    private _rrfFuse(rankings: Array<{ name: string; paths: string[] }>): FusedHit[] {
        const scores = new Map<string, number>();
        const matched = new Map<string, Set<string>>();
        for (const ranking of rankings) {
            ranking.paths.forEach((path, idx) => {
                const rank = idx + 1;
                scores.set(path, (scores.get(path) || 0) + 1 / (RRF_K + rank));
                const set = matched.get(path) || new Set();
                set.add(ranking.name);
                matched.set(path, set);
            });
        }
        return Array.from(scores.entries())
            .map(([path, score]) => ({ path, score, matched: Array.from(matched.get(path)!) }))
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    }

    private _semanticAvailable(scope: string): boolean {
        // Pamięć agentów jest z założenia poza indeksem vaulta (izolacja) — semantyki brak.
        if (scope === 'memory') return false;
        return !!(this.embeddingHelper?.embed && this.oramaDb);
    }

    private _hasWhere(where: SearchWhere | null | undefined): boolean {
        if (!where) return false;
        return !!(where.folder || where.glob || where.links_to || where.links_from
            || (where.yaml && typeof where.yaml === 'object' && Object.keys(where.yaml).length > 0));
    }

    // ───────────────────────── Linki ─────────────────────────

    private _baseName(nameOrPath: unknown): string {
        return String(nameOrPath).replace(/\.md$/i, '').split('/').pop()!.toLowerCase();
    }

    /** Zbiór basename'ów, do których linkuje podana notatka (forward links). */
    private async _resolveForwardLinks(sourceRef: string, scope: string): Promise<Set<string>> {
        const targets = new Set<string>();
        const files = scope === 'memory'
            ? await this._listMemoryFiles(null)
            : await this._listVaultFiles({});
        const base = this._baseName(sourceRef);
        const src = files.find(f => f.path === sourceRef || this._baseName(f.name) === base);
        if (!src) return targets;
        try {
            const content = await this.vault.adapter.read(src.path);
            for (const m of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
                targets.add(this._baseName(m[1].trim()));
            }
        } catch { /* skip */ }
        return targets;
    }

    /** Kandydaci, których treść linkuje DO podanej notatki (backlinks). */
    private async _filterByBacklink(candidates: Candidate[], targetRef: string, readCached: ReadCached): Promise<Candidate[]> {
        const base = String(targetRef).replace(/\.md$/i, '').split('/').pop()!;
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\[\\[(?:[^\\]|]*\\/)?${escaped}(?:\\|[^\\]]+)?\\]\\]`, 'i');
        const out: Candidate[] = [];
        for (const c of candidates) {
            const content = await readCached(c.path);
            if (content && re.test(content)) out.push(c);
        }
        return out;
    }

    // ───────────────────────── Frontmatter ─────────────────────────

    private _matchesFrontmatter(fm: Record<string, unknown>, filter: Record<string, unknown>): boolean {
        if (!filter || Object.keys(filter).length === 0) return true;
        for (const [key, expected] of Object.entries(filter)) {
            const actual = fm[key];
            if (Array.isArray(actual)) {
                if (!actual.some(v => String(v) === String(expected))) return false;
            } else if (String(actual) !== String(expected)) {
                return false;
            }
        }
        return true;
    }

    // `this: void` = uczciwa deklaracja: metoda NIE dotyka `this`, dlatego konstruktor
    // może podać ją jako goły callback (`deps.parseFrontmatter || this._defaultParseFrontmatter`).
    // Parametr `this` znika przy transpilacji — zero emitu.
    private _defaultParseFrontmatter(this: void, content: string): Record<string, unknown> {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return {};
        const result: Record<string, string | string[]> = {};
        let lastKey: string | null = null;
        for (const line of match[1].split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('- ') && lastKey) {
                if (!Array.isArray(result[lastKey])) result[lastKey] = [];
                (result[lastKey] as string[]).push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
            } else if (trimmed.includes(':')) {
                const idx = trimmed.indexOf(':');
                const key = trimmed.slice(0, idx).trim();
                const val = trimmed.slice(idx + 1).trim();
                result[key] = val ? val.replace(/^["']|["']$/g, '') : [];
                lastKey = key;
            }
        }
        return result;
    }

    // ───────────────────────── Glob / excerpt / title ─────────────────────────

    private _matchesGlob(path: string, pattern: string): boolean {
        const escaped = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '___DOUBLE___')
            .replace(/\*/g, '[^/]*')
            .replace(/___DOUBLE___/g, '.*');
        return new RegExp(`^${escaped}$`).test(path);
    }

    private _title(content: string | null, name: string | undefined): string {
        const fm = this._parseFrontmatter(content || '');
        const title = fm.title;
        if (title && !Array.isArray(title)) return String(title);
        return String(name || '').replace(/\.md$/i, '');
    }

    /** Excerpt: keyword hit → fragment wokół frazy; inaczej początek treści. */
    private _excerpt(content: string, query: string): string {
        if (query) {
            const idx = content.toLowerCase().indexOf(query.toLowerCase());
            if (idx !== -1) {
                const start = Math.max(0, idx - 80);
                const end = Math.min(content.length, idx + query.length + 120);
                let s = maskSensitiveData(content.slice(start, end).replace(/\s+/g, ' ').trim());
                if (start > 0) s = `…${s}`;
                if (end < content.length) s = `${s}…`;
                return s;
            }
        }
        return this._excerptStart(content);
    }

    /**
     * Początek treści po frontmatterze (semantic-only hit / listing).
     *
     * AUD-wydajnosc-056: `\s+` normalizował dawniej CAŁY plik dla 200 znaków wyniku —
     * O(rozmiar pliku) na jeden excerpt. Tniemy PRZED normalizacją — ale zapas STAŁY
     * (`max*4`) był regresją znalezioną w review rundy 2: `\s+` zwija DOWOLNIE DUŻO
     * białych znaków, więc plik z 1000 pustymi liniami na początku dawał `rawSlice`
     * złożony w całości z whitespace'u → widoczny excerpt to sam „…" (treść zgubiona),
     * a krótka treść + setki białych znaków NA KOŃCU dawała fałszywe „…" (nic nie zostało
     * obcięte, tylko zapas się skończył w środku ogona spacji). Naprawa: zapas ROŚNIE —
     * `max*4` → `max*16` → cała treść — dopóki albo normalizacja da już `max` znaków,
     * albo zapas objął już cały plik. Typowa notatka (treść w pierwszych kilkuset
     * znakach) kończy na pierwszej próbie — nie wraca do O(rozmiar pliku) w normalnym
     * przypadku; patologiczny plik (góra pustych linii/spacji) płaci pełną normalizację,
     * świadomie, tak jak prosił review.
     */
    private _excerptStart(content: string, max = EXCERPT_LEN): string {
        const stripped = String(content || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
        const margins = [max * 4, max * 16, stripped.length];
        let normalized = '';
        let sliceLen = 0;
        for (const m of margins) {
            sliceLen = Math.min(m, stripped.length);
            normalized = stripped.slice(0, sliceLen).replace(/\s+/g, ' ').trim();
            if (normalized.length >= max || sliceLen >= stripped.length) break;
        }
        // "…" gdy albo widoczny wycinek już przekracza max, albo za granicą zapasu,
        // na którym się zatrzymaliśmy, wciąż jest surowa treść pliku.
        const truncated = normalized.length > max || sliceLen < stripped.length;
        let s = maskSensitiveData(normalized.slice(0, max));
        if (truncated) s = `${s}…`;
        return s;
    }
}
