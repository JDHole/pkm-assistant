/**
 * VaultIndexer — żywy indeks semantyczny vaulta (E1.4 · R1, 2026-07-21).
 *
 * PRZED tym plikiem wyszukiwanie semantyczne było MARTWE: nikt nie przypisywał
 * `plugin.oramaDb`, więc `RetrievalEngine._canUseLayer3()` zawsze zwracał false
 * i L3 po cichu spadał do keyword/L2. VaultIndexer buduje indeks Oramy z plików
 * `.md` vaulta i publikuje go jako `plugin.oramaDb` — TEN kontrakt zasila istniejących
 * konsumentów (VaultRetrievalTools, MemoryRetrievalTools, RetrievalEngine) bez
 * zmiany ich API.
 *
 * Stany (getStatus().status):
 *   - 'disabled_mobile' — Platform.isMobile (desktop-first, decyzja D6)
 *   - 'no_provider'     — brak działającego adaptera embeddingów (user nie wybrał providera)
 *   - 'building'        — trwa skan/embedding (progress {indexed, total})
 *   - 'ready'           — indeks zbudowany i opublikowany jako plugin.oramaDb
 *   - 'error'           — embed API padło; częściowy indeks NIE jest publikowany
 *                         (a jeśli był już 'ready', stary oramaDb zostaje żywy)
 *
 * Trade-off E1.4 (świadomy): embedujemy PER PLIK pierwsze ~6000 znaków, BEZ chunkingu.
 * Chunking per sekcja (dokładniejszy, ale droższy) to osobne zadanie E2.5.
 *
 * BEZPIECZEŃSTWO (twarda granica): indeks NIGDY nie zawiera `.pkm-assistant/**`
 * — to pamięć agentów (izolacja). Traktowane jak NoGo. Dlatego semantyka pamięci
 * (scope:'memory') pozostaje niedostępna i degraduje do L2 — patrz RetrievalEngine.
 *
 * Testowalność: wszystkie zależności wstrzykiwane (fake vault, fake embedder,
 * flaga isMobile, in-memory adapter). Handlery hooków wołalne bezpośrednio.
 */

import {
    createEmbeddingDb,
    insertVectorLean,
    stripStoredVectors,
    removeVector,
    persist,
    restore,
    DEFAULT_VECTOR_DIM,
} from './orama_engine.js';
import type { AnyOrama, AnySchema } from '@orama/orama';
import type { EmbeddingDoc } from './orama_engine.js';

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

const INDEX_VERSION = 1;
const DEFAULT_INDEX_DIR = '.pkm-assistant/index';
const MAX_EMBED_CHARS = 6000;     // per-plik treść do embeddingu (E1.4 trade-off)
const DEFAULT_BATCH_SIZE = 16;    // porcja plików na jeden embedBatch
const DEFAULT_DEBOUNCE_MS = 2000; // debounce kolejki zmian z hooków
const DEFAULT_PERSIST_MS = 30000; // debounce zapisu na dysk po zmianach
/** Sufit odczekania po nieudanym flushu (AUD-wydajnosc-090: porcja wraca do kolejki). */
const MAX_FLUSH_RETRY_MS = 5 * 60 * 1000;
/** Ile razy ponawiamy PORCJĘ po awarii przejściowej, zanim uznamy skan za padnięty (P2b). */
const BATCH_TRANSIENT_RETRIES = 2;
/** Ile razy próbujemy POJEDYNCZY plik przy trwałej awarii, zanim go pominiemy (P2c). */
const MAX_FILE_ATTEMPTS = 3;
/** Baza backoffu ponowień porcji (ms). */
const DEFAULT_EMBED_RETRY_MS = 2000;
/** Baza backoffu automatycznego ponowienia całego skanu po padzie (ms). */
const DEFAULT_SCAN_RETRY_MS = 30000;
/** Sufit odczekania przed ponowieniem skanu. */
const MAX_SCAN_RETRY_MS = 5 * 60 * 1000;

/**
 * Plik trwale pominięty w tej rundzie — NIE dostaje stempla mtime, więc wróci przy
 * następnym skanie/restarcie, ale nie blokuje reszty porcji (P2c).
 */
export const EMBED_SKIPPED = 'skipped';
/** Wynik embeddingu jednego pliku: wektor | `null` (pusta treść) | `EMBED_SKIPPED`. */
export type EmbedSlot = number[] | null | typeof EMBED_SKIPPED;

/** Jak indekser traktuje awarię embeddingu. */
type EmbedFailure = 'transient' | 'permanent' | 'fatal';

/**
 * Klasyfikacja awarii embeddingu — kaczo-typowana, bo fasada embeddera jest WSTRZYKIWANA
 * i nie musi rzucać `EmbedBatchError` z tego modułu (harness i testy mają własne atrapy).
 *
 * - `transient` — sieć/timeout/429: ponawiamy CAŁĄ porcję (P2b).
 * - `permanent` — błąd API inny niż 429 (np. 400 za przekroczony kontekst): jeden zatruty
 *   plik nie może blokować pozostałych, więc porcja idzie na pojedynczo (P2c).
 * - `fatal` — adapter oddał inną liczbę wyników niż wejść. NIE rozbijamy takiej porcji:
 *   dla jednego wejścia zwrotka błędu ma długość 1, więc wyglądałaby jak „plik pusty"
 *   i wskrzesiłaby dokładnie ten stempel mtime, który naprawia AUD-wydajnosc-090.
 */
function embedFailureKind(e: unknown): EmbedFailure {
    let cur: unknown = e;
    for (let depth = 0; cur && depth < 5; depth++) {
        const o = cur as { kind?: unknown; httpStatus?: unknown; cause?: unknown };
        if (o.kind === 'shape') return 'fatal';
        if (o.kind === 'api') return o.httpStatus === 429 ? 'transient' : 'permanent';
        if (o.kind === 'transport' || o.kind === 'timeout') return 'transient';
        cur = o.cause;
    }
    return 'transient'; // nie wiemy → zakładamy, że minie (nie kasujemy pracy na zapas)
}

/** Foldery zawsze wykluczone z indeksu (poza NoGo z ustawień). */
const HARD_EXCLUDES = ['.pkm-assistant', '.obsidian', '.trash'];

/** Plik vaulta widziany przez indekser (TFile Obsidiana pasuje strukturalnie). */
export interface VaultFileLike {
    path: string;
    stat?: { mtime?: number };
}

/** Adapter FS vaulta — używany WYŁĄCZNIE do ukrytego pliku indeksu. */
export interface VaultAdapterLike {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    exists?(path: string): Promise<boolean>;
    mkdir?(path: string): Promise<void>;
    stat?(path: string): Promise<{ mtime?: number } | null>;
}

/** Vault Obsidiana widziany przez indekser (podzbiór realnego API). */
export interface VaultLike {
    configDir?: string;
    getMarkdownFiles?(): VaultFileLike[];
    getAbstractFileByPath?(path: string): VaultFileLike | null;
    cachedRead(file: VaultFileLike): Promise<string>;
    on?(name: string, cb: (...args: never[]) => void): unknown;
    offref?(ref: unknown): void;
    adapter: VaultAdapterLike;
}

/** Fasada embeddera wstrzykiwana z `main.js` (opakowuje `EmbeddingHelper`). */
export interface EmbedderFacade {
    isReady?(): boolean;
    embedBatch(texts: string[]): Promise<Array<number[] | null>>;
    embed?(text: string): Promise<number[] | null>;
    getModelKey?(): string;
    getDims?(): number | null | undefined;
}

/** Plugin, na którym indekser publikuje `oramaDb` i wiesza sprzątanie. */
export interface IndexerPluginLike {
    oramaDb?: AnyOrama | null;
    registerEvent?(ref: unknown): void;
    register?(cb: () => void): void;
}

/** Logger indeksera (kompatybilny z `core/utils/Logger`). */
export interface IndexerLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
}

/** Stany indeksera — patrz nagłówek pliku. */
export type IndexerStatus = 'idle' | 'disabled_mobile' | 'no_provider' | 'building' | 'ready' | 'error';

/** Publiczny snapshot stanu (Settings + noty degradacji). */
export interface IndexerStatusSnapshot {
    status: IndexerStatus;
    progress: { indexed: number; total: number };
    modelKey: string | null;
    lastError: string | null;
}

/** Metadane pliku brane do indeksu. */
export interface FileMeta {
    path: string;
    mtime: number;
}

/** Sidecar `vault-index.meta.json`. Nazwa pola na dysku, nie w kodzie — `model_key` zostaje
 *  (dane usera, spec §4); w kodzie snapshotu i wszędzie indziej to `modelKey`. */
export interface IndexMeta {
    version?: number;
    model_key?: string | null;
    dims?: number | null;
    updated_at?: number;
    mtimes?: Record<string, number>;
}

/** Zależności konstruktora — wszystko wstrzykiwane (testowalność). */
export interface VaultIndexerDeps {
    /** ustawia plugin.oramaDb + plugin.registerEvent/register (cleanup) */
    plugin?: IndexerPluginLike | null;
    /** Obsidian Vault: getMarkdownFiles(), getAbstractFileByPath(), cachedRead(), adapter{write,exists,mkdir,stat} (adapter tylko dla ukrytego pliku indeksu), on/offref */
    vault: VaultLike;
    /** fasada: isReady(), embedBatch(texts), embed(text), getModelKey(), getDims() */
    embedder: EmbedderFacade;
    /** Platform.isMobile */
    isMobile?: boolean;
    logger?: IndexerLogger;
    /** lista user NoGo (funkcja zwracająca świeżą listę lub tablica) */
    noGoFolders?: (() => string[]) | string[];
    /** folder artefaktów do wykluczenia albo null (indeksuj) */
    artifactsExclude?: (() => string | null) | string | null;
    indexDir?: string;
    /** testowalny zegar */
    now?: () => number;
    batchSize?: number;
    debounceMs?: number;
    persistDebounceMs?: number;
    /** Baza backoffu ponowień porcji po awarii przejściowej (ms). */
    embedRetryMs?: number;
    /** Baza backoffu automatycznego ponowienia całego skanu po padzie (ms). */
    scanRetryMs?: number;
}

/** Minimalny kształt błędu w `catch` (err jest `unknown`). */
type ErrLike = { message?: string };

function basename(path: string): string {
    const p = String(path || '').replace(/\\/g, '/');
    const last = p.split('/').pop() || p;
    return last.replace(/\.md$/i, '');
}

export class VaultIndexer {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare plugin: IndexerPluginLike | null;
    declare vault: VaultLike;
    declare embedder: EmbedderFacade;
    declare isMobile: boolean;
    declare logger: IndexerLogger;
    declare private _noGoSource: (() => string[]) | string[];
    declare private _artifactsExclude: (() => string | null) | string | null;
    declare indexDir: string;
    declare now: () => number;
    declare batchSize: number;
    declare debounceMs: number;
    declare persistDebounceMs: number;
    declare embedRetryMs: number;
    declare scanRetryMs: number;

    declare status: IndexerStatus;
    declare progress: { indexed: number; total: number };
    declare lastError: string | null;
    declare modelKey: string | null;
    declare dims: number | null;

    declare db: AnyOrama | null;
    declare _mtimes: Map<string, number>;
    declare _queue: Map<string, 'upsert' | 'delete'>;
    declare _ready: boolean;
    declare private _processing: boolean;
    declare private _hooksRegistered: boolean;
    declare private _debounceTimer: ReturnType<typeof setTimeout> | null;
    declare private _persistTimer: ReturnType<typeof setTimeout> | null;
    /** Liczba KOLEJNYCH nieudanych flushów — steruje backoffem ponowienia (AUD-wydajnosc-090). */
    declare private _flushFailures: number;
    /** Kiedy (wg `now()`) ma wystrzelić uzbrojone ponowienie po padzie — `null` = brak (P2a). */
    declare private _flushRetryAt: number | null;
    /** Ostatnio uzbrojone opóźnienie flushu (ms) — diagnostyka + asercja w testach (P2a). */
    declare _flushDelayMs: number;
    /** Licznik prób na plik przy trwałej awarii (P2c). */
    declare private _fileAttempts: Map<string, number>;
    /** Pliki pominięte po wyczerpaniu prób — bez stempla mtime, wrócą przy następnym skanie. */
    declare skipped: Set<string>;
    declare private _scanRetryTimer: ReturnType<typeof setTimeout> | null;
    declare private _scanFailures: number;
    /** memoizowana lista twardych wykluczeń (liczona przy pierwszym użyciu) */
    declare private _hardEx?: string[];

    constructor(deps: VaultIndexerDeps = {} as VaultIndexerDeps) {
        this.plugin = deps.plugin || null;
        this.vault = deps.vault;
        this.embedder = deps.embedder;
        this.isMobile = !!deps.isMobile;
        this.logger = deps.logger || { info() {}, warn() {}, error() {}, debug() {} };
        this._noGoSource = deps.noGoFolders || [];
        // E2.9: folder artefaktów żywych wykluczany z indeksu, dopóki user nie włączy
        // „Indeksuj artefakty" (jednorazówki = szum semantyczny). Funkcja zwraca ścieżkę folderu
        // do wykluczenia albo null (indeksuj). Przewód wzorem noGoFolders.
        this._artifactsExclude = deps.artifactsExclude || null;
        this.indexDir = (deps.indexDir || DEFAULT_INDEX_DIR).replace(/\/$/, '');
        this.now = deps.now || (() => Date.now());
        this.batchSize = deps.batchSize || DEFAULT_BATCH_SIZE;
        this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.persistDebounceMs = deps.persistDebounceMs ?? DEFAULT_PERSIST_MS;
        this.embedRetryMs = deps.embedRetryMs ?? DEFAULT_EMBED_RETRY_MS;
        this.scanRetryMs = deps.scanRetryMs ?? DEFAULT_SCAN_RETRY_MS;

        this.status = 'idle';
        this.progress = { indexed: 0, total: 0 };
        this.lastError = null;
        this.modelKey = null;
        this.dims = null;

        this.db = null;
        this._mtimes = new Map();   // path -> mtime
        this._queue = new Map();    // path -> 'upsert' | 'delete'
        this._ready = false;
        this._processing = false;
        this._hooksRegistered = false;
        this._debounceTimer = null;
        this._persistTimer = null;
        this._flushFailures = 0;
        this._flushRetryAt = null;
        this._flushDelayMs = this.debounceMs;
        this._fileAttempts = new Map();
        this.skipped = new Set();
        this._scanRetryTimer = null;
        this._scanFailures = 0;
    }

    /** Publiczny snapshot stanu dla Settings + not degradacji. */
    getStatus(): IndexerStatusSnapshot {
        return {
            status: this.status,
            progress: { indexed: this.progress.indexed, total: this.progress.total },
            modelKey: this.modelKey,
            lastError: this.lastError,
        };
    }

    /**
     * Wołane z main.js — fire-and-forget (BEZ await), start pluginu nie czeka na skan.
     */
    async initialize(): Promise<void> {
        try {
            if (this.isMobile) { this.status = 'disabled_mobile'; return; }
            if (!this._embedderReady()) { this.status = 'no_provider'; return; }

            this.modelKey = this._safeModelKey();
            this.status = 'building';
            this._registerHooks(); // aktywne, ale kolejka przetwarzana dopiero po 'ready'

            let restored = false;
            try {
                restored = await this._tryRestore();
            } catch (e) {
                this.logger.warn('VaultIndexer', `restore failed → rebuild: ${((e as ErrLike)?.message || e) as string}`);
                restored = false;
            }

            if (restored) {
                // P1 (review W5): odzyskany indeks jest KOMPLETNY sam w sobie — publikujemy go
                // ZANIM ruszy resync. Wcześniej pad resyncu (np. Ollama zgaszona przy starcie,
                // 3 notatki zmienione od wczoraj) leciał do `catch` niżej, `_publish()` nigdy nie
                // szło, a `_ready` zostawało `false`: semantyka martwa na całą sesję i zero
                // ponowień, mimo że NIEŚWIEŻY indeks był w garści. Nieświeży > brak.
                this._publish();
                await this._resync(); // własny catch: nieudane pliki lądują w kolejce
            } else {
                await this._fullScan();
                this._publish();
            }

            this.status = 'ready';
            this._ready = true;
            this._scanFailures = 0;
            await this._flushQueue(); // zmiany zebrane podczas budowy (+ nieudane z resyncu)
            this.logger.info('VaultIndexer', `ready — ${this._mtimes.size} plików, model ${this.modelKey}`);
        } catch (e) {
            this.status = 'error';
            this.lastError = (e as ErrLike)?.message || String(e);
            this.logger.error('VaultIndexer', 'initialize failed:', e);
            // P2b: skan bez indeksu w garści (albo pad poza resyncem) — ponów sam, z backoffem.
            // Bez tego zimny start Ollamy dłuższy niż sufit czasu kończył się `error` NA STAŁE.
            this._scheduleScanRetry();
        }
    }

    /** Automatyczne ponowienie całego skanu po padzie (P2b). Odwoływane przez `dispose()`. */
    _scheduleScanRetry(): void {
        if (this._scanRetryTimer) _nodeSafeClearTimeout(this._scanRetryTimer);
        this._scanFailures++;
        const delay = Math.min(this.scanRetryMs * Math.pow(2, this._scanFailures - 1), MAX_SCAN_RETRY_MS);
        this.logger.info('VaultIndexer', `skan padł (${this._scanFailures}) — ponawiam za ${delay} ms`);
        this._scanRetryTimer = _nodeSafeSetTimeout(() => {
            this._scanRetryTimer = null;
            this.initialize().catch(e => this.logger.warn('VaultIndexer', `scan retry error: ${((e as ErrLike)?.message || e) as string}`));
        }, delay);
        this._scanRetryTimer?.unref?.();
    }

    /**
     * Publiczna: pełny rebuild (przycisk Reindex). Nie unpublikuje starego oramaDb
     * dopóki nowy nie jest gotowy — jeśli rebuild padnie, stary indeks zostaje żywy.
     */
    async rebuild(): Promise<IndexerStatusSnapshot> {
        this.lastError = null;
        // K8/AUD-code-review-101: bramki PRZED mutacją stanu — wcześniej `_ready=false` +
        // `db=null` + kolejka/mtimes wyczyszczone szły PRZED tymi sprawdzeniami, więc wczesny
        // return (isMobile/no_provider) zostawiał indekser połamany na zawsze (żywy `plugin.oramaDb`,
        // ale `_ready=false` blokujące `_flushQueue` do końca sesji). Nic tu nie mutujemy, dopóki
        // nie wiemy, że rebuild faktycznie ruszy — wtedy early return nie ma czego przywracać.
        if (this.isMobile) { this.status = 'disabled_mobile'; return this.getStatus(); }
        if (!this._embedderReady()) { this.status = 'no_provider'; return this.getStatus(); }

        // Review W5: do naprawy `catch` przywracał SAM `db` — `_mtimes` zostawały puste,
        // `dims` z nieudanego skanu, a `_ready` na `false`, czyli przywrócony indeks był żywy
        // dla czytelników, ale martwy dla kolejki zmian. Zdejmujemy pełny snapshot.
        const previousDb = this.db;
        const previousMtimes = this._mtimes;
        const previousDims = this.dims;
        const previousReady = this._ready;
        this._ready = false;
        this._queue.clear();
        this._mtimes = new Map();
        this.db = null;
        try {
            this.modelKey = this._safeModelKey();
            this.status = 'building';
            this._registerHooks();
            await this._fullScan();

            this._publish();
            this.status = 'ready';
            this._ready = true;
            await this._flushQueue();
            this.logger.info('VaultIndexer', `rebuild ready — ${this._mtimes.size} plików`);
        } catch (e) {
            // Rebuild padł: przywróć CAŁY stan sprzed próby (db był opublikowany), zgłoś error.
            this.db = previousDb;
            this._mtimes = previousMtimes;
            this.dims = previousDims;
            this._ready = previousReady;
            this.status = 'error';
            this.lastError = (e as ErrLike)?.message || String(e);
            this.logger.error('VaultIndexer', 'rebuild failed:', e);
        }
        return this.getStatus();
    }

    /** Wyczyść timery (wołane automatycznie przy unload przez plugin.register). */
    dispose(): void {
        if (this._debounceTimer) { _nodeSafeClearTimeout(this._debounceTimer); this._debounceTimer = null; }
        if (this._persistTimer) { _nodeSafeClearTimeout(this._persistTimer); this._persistTimer = null; }
        if (this._scanRetryTimer) { _nodeSafeClearTimeout(this._scanRetryTimer); this._scanRetryTimer = null; }
    }

    // ─────────────────────────── Hooki vaulta ───────────────────────────

    _registerHooks(): void {
        if (this._hooksRegistered) return;
        const vault = this.vault;
        if (!vault?.on) return;
        const handler = (type: VaultEventType) => (file: VaultFileLike | string, oldPath?: VaultFileLike | string) => this._onVaultEvent(type, file, oldPath);
        const refs = [
            vault.on('create', handler('create')),
            vault.on('modify', handler('modify')),
            vault.on('delete', handler('delete')),
            vault.on('rename', handler('rename')),
        ];
        for (const ref of refs) {
            if (ref && this.plugin?.registerEvent) this.plugin.registerEvent(ref);
        }
        // Auto-cleanup timerów przy unload (Obsidian Component.register).
        if (this.plugin?.register) this.plugin.register(() => this.dispose());
        this._hooksRegistered = true;
    }

    /**
     * Handler zdarzeń vaulta — wołalny bezpośrednio w testach.
     * @param file - TFile lub ścieżka
     * @param oldPath - poprzednia ścieżka (rename)
     */
    _onVaultEvent(type: VaultEventType, file: VaultFileLike | string, oldPath?: VaultFileLike | string): void {
        try {
            const path = typeof file === 'string' ? file : file?.path;
            if (!path) return;

            // AUD-wydajnosc-008: `_scheduleFlush()` stało dawniej POZA tymi gałęziami, więc
            // zdarzenie na pliku SPOZA indeksu (załącznik, notatka w NoGo, folder artefaktów)
            // kasowało zaplanowany flush realnych zmian i nastawiało zegar od nowa. Strumień
            // takich zdarzeń odsuwał indeksowanie edytowanej notatki na czas swojego trwania.
            let queued = false;
            if (type === 'rename') {
                const old = typeof oldPath === 'string' ? oldPath : (oldPath?.path || oldPath);
                if (old && this._isIndexable(old)) { this._queue.set(old, 'delete'); queued = true; }
                if (this._isIndexable(path)) { this._queue.set(path, 'upsert'); queued = true; }
            } else if (type === 'delete') {
                if (this._isIndexable(path)) { this._queue.set(path, 'delete'); queued = true; }
            } else {
                // create | modify
                if (this._isIndexable(path)) { this._queue.set(path, 'upsert'); queued = true; }
            }
            if (queued) this._scheduleFlush();
        } catch (e) {
            this.logger.warn('VaultIndexer', `vault event error: ${((e as ErrLike)?.message || e) as string}`);
        }
    }

    /**
     * @param delayMs jawne opóźnienie = UZBROJENIE ponowienia po padzie; bez argumentu
     *   to zwykły debounce z hooka vaulta.
     *
     * P2a (review W5): zwykły debounce NIE MOŻE skrócić uzbrojonego ponowienia. Oba wiszą na
     * tym samym timerze, więc przy trwale zgaszonym demonie i pracującym userze każde zdarzenie
     * z vaulta zbijało 5-minutowy backoff do 2 s — czyli młóciliśmy API co dwie sekundy,
     * dokładnie to, przed czym backoff miał chronić.
     */
    _scheduleFlush(delayMs?: number): void {
        let delay = delayMs ?? this.debounceMs;
        if (delayMs === undefined && this._flushRetryAt !== null) {
            const left = this._flushRetryAt - this.now();
            if (left > delay) delay = left;
        } else if (delayMs !== undefined) {
            this._flushRetryAt = this.now() + delayMs;
        }
        this._flushDelayMs = delay;
        if (this._debounceTimer) _nodeSafeClearTimeout(this._debounceTimer);
        this._debounceTimer = _nodeSafeSetTimeout(() => {
            this._debounceTimer = null;
            this._flushQueue().catch(e => this.logger.warn('VaultIndexer', `flush error: ${((e as ErrLike)?.message || e) as string}`));
        }, delay);
        this._debounceTimer?.unref?.();
    }

    /** Odczekanie przed ponowieniem po `n` kolejnych padach (wykładniczo, z sufitem). */
    _flushRetryDelayMs(n: number): number {
        return Math.min(this.debounceMs * Math.pow(2, Math.max(0, n - 1)), MAX_FLUSH_RETRY_MS);
    }

    /** Przetwarza kolejkę zmian. No-op dopóki indeks nie jest 'ready'. */
    async _flushQueue(): Promise<void> {
        if (!this._ready || this._processing || this._queue.size === 0) return;
        this._processing = true;
        this._flushRetryAt = null; // uzbrojone ponowienie właśnie konsumujemy (P2a)
        const entries = [...this._queue.entries()];
        this._queue.clear();
        let failed = false;
        try {
            const upserts: string[] = [];
            for (const [path, action] of entries) {
                if (action === 'delete') await this._removeDoc(path);
                else upserts.push(path);
            }
            if (upserts.length) {
                const metas: FileMeta[] = [];
                for (const p of upserts) metas.push({ path: p, mtime: await this._statMtime(p) });
                await this._indexMetas(metas);
            }
            this._flushFailures = 0;
            this.lastError = null;
            this._schedulePersist();
        } catch (e) {
            // AUD-wydajnosc-090/045: embed API padło w trakcie kolejki. Porcja NIE dostała
            // stempla mtime (patrz `_embedMetas`), więc wraca do kolejki i pójdzie ponownie.
            // Bez tego `_queue.clear()` wyżej gubił te ścieżki bezpowrotnie: pliki znikały
            // z indeksu (remove-then-insert) i nie wracały aż do pełnego reindeksu.
            failed = true;
            this._flushFailures++;
            this.lastError = (e as ErrLike)?.message || String(e);
            for (const [path, action] of entries) {
                if (!this._queue.has(path)) this._queue.set(path, action);
            }
            this.logger.warn('VaultIndexer', `flush failed (${this._flushFailures}) — ${entries.length} zmian wraca do kolejki: ${this.lastError}`);
        } finally {
            this._processing = false;
        }
        if (this._queue.size > 0) {
            // Pad → ponawiaj z rosnącym odstępem (nie młóć API co 2 s przy trwałej awarii).
            this._scheduleFlush(failed ? this._flushRetryDelayMs(this._flushFailures) : undefined);
        }
    }

    // ─────────────────────────── Skan / indeks ───────────────────────────

    async _fullScan(): Promise<void> {
        const files = this._listVaultMarkdown();
        this.progress = { indexed: 0, total: files.length };
        this._mtimes = new Map();
        let dims = this._normalizeDims(this._safeDims());

        for (let i = 0; i < files.length; i += this.batchSize) {
            const batch = files.slice(i, i + this.batchSize);
            const vectors = await this._embedMetas(batch);
            if (!this.db) {
                // Ustal wymiar: preferuj zadeklarowany przez adapter, ale jeśli kłóci się
                // z realnym wektorem — zaufaj realnemu (inaczej insert do Oramy by padł).
                const actual = this._deriveDims(vectors);
                if (!dims) dims = actual;
                else if (actual && actual !== dims) {
                    this.logger.warn('VaultIndexer', `zadeklarowany dims ${dims} ≠ realny ${actual} — używam realnego`);
                    dims = actual;
                }
                if (dims) {
                    this.db = await createEmbeddingDb(this._schema(dims));
                    this.dims = dims;
                }
            }
            if (this.db) {
                for (let j = 0; j < batch.length; j++) await this._insertOne(batch[j], vectors[j]);
            } else {
                // dims wciąż nieznane (cała porcja pusta) — zapamiętaj mtimes, pomiń insert.
                // Pominięte pliki (P2c) NIE dostają stempla: mają wrócić.
                for (let j = 0; j < batch.length; j++) {
                    if (vectors[j] !== EMBED_SKIPPED) this._mtimes.set(batch[j].path, batch[j].mtime);
                }
            }
            await this._yield();
        }

        if (!this.db) {
            // pusty vault albo zero embeddingów — utwórz pusty indeks z deklarowanym/domyślnym dims
            this.dims = dims || DEFAULT_VECTOR_DIM;
            this.db = await createEmbeddingDb(this._schema(this.dims));
        }
        await this._persistNow();
    }

    /** Re-embed tylko zmienionych/nowych plików; usuń skasowane. */
    async _resync(): Promise<void> {
        const current = this._listVaultMarkdown();
        const currentMap = new Map(current.map(f => [f.path, f.mtime]));
        this.progress = { indexed: this._mtimes.size, total: current.length };

        const toUpsert: FileMeta[] = [];
        for (const f of current) {
            const prev = this._mtimes.get(f.path);
            if (prev === undefined || prev !== f.mtime) toUpsert.push(f);
        }
        const toDelete: string[] = [];
        for (const path of this._mtimes.keys()) {
            if (!currentMap.has(path)) toDelete.push(path);
        }

        for (const p of toDelete) await this._removeDoc(p);
        let upserted = toUpsert.length;
        if (toUpsert.length) {
            try {
                await this._indexMetas(toUpsert);
            } catch (e) {
                // P1: pad odświeżania NIE MOŻE zabrać odzyskanego indeksu. Zmienione pliki
                // wracają do kolejki i idą tym samym mechanizmem ponowień co flush; ich mtime
                // nie został zestemplowany, więc przy następnym starcie i tak wrócą.
                upserted = 0;
                this._flushFailures++;
                this.lastError = (e as ErrLike)?.message || String(e);
                for (const f of toUpsert) {
                    if (!this._queue.has(f.path)) this._queue.set(f.path, 'upsert');
                }
                this.logger.warn('VaultIndexer', `resync failed — ${toUpsert.length} plików do kolejki: ${this.lastError}`);
                this._scheduleFlush(this._flushRetryDelayMs(this._flushFailures));
            }
        }
        if (upserted || toDelete.length) await this._persistNow();
        this.logger.info('VaultIndexer', `resync: +${upserted} zmienionych, -${toDelete.length} skasowanych`);
    }

    /** Upsert porcji plików (remove-then-insert), z metadanymi {path, mtime}. */
    async _indexMetas(metas: FileMeta[]): Promise<void> {
        if (!this.db) return;
        for (let i = 0; i < metas.length; i += this.batchSize) {
            const batch = metas.slice(i, i + this.batchSize);
            const vectors = await this._embedMetas(batch);
            for (let j = 0; j < batch.length; j++) {
                await this._removeDoc(batch[j].path, /*keepMtime*/ true);
                await this._insertOne(batch[j], vectors[j]);
            }
            await this._yield();
        }
    }

    async _insertOne(meta: FileMeta, vec: EmbedSlot): Promise<void> {
        if (!this.db) return;
        if (vec === EMBED_SKIPPED) {
            // P2c: plik trwale odrzucany przez API. BEZ stempla mtime — wróci przy następnym
            // skanie/restarcie, ale nie blokuje reszty porcji ani całego indeksowania.
            return;
        }
        if (Array.isArray(vec) && vec.length) {
            // insertVectorLean: wektor zostaje TYLKO w `index.vectorIndexes` (AUD-wydajnosc-088/041).
            await insertVectorLean(this.db, this._makeDoc(meta, vec));
            this._mtimes.set(meta.path, meta.mtime);
            this.progress.indexed = this._mtimes.size;
        } else {
            // PUSTY PLIK (i tylko pusty): brak wektora dla treści, której nie ma. Awaria
            // providera nigdy tu nie dociera — od naprawy kontraktu błędu
            // (AUD-wydajnosc-090/010/045/068) `_embedMetas` RZUCA zamiast oddawać nulle,
            // więc mtime nie jest stemplowany i porcja wraca do kolejki / kończy skan błędem.
            this._mtimes.set(meta.path, meta.mtime);
        }
    }

    async _removeDoc(path: string, keepMtime = false): Promise<void> {
        if (this.db) {
            try { await removeVector(this.db, path); } catch { /* not present */ }
        }
        if (!keepMtime) this._mtimes.delete(path);
    }

    /** Czyta treść porcji plików (pierwsze `MAX_EMBED_CHARS` znaków każdego). */
    async _readTexts(metas: FileMeta[]): Promise<string[]> {
        const texts: string[] = [];
        for (const m of metas) {
            let content = '';
            // Vault API, not adapter: these are ordinary notes, so they go through
            // Obsidian's own cache/permission path (adapter bypasses it).
            try {
                const file = this.vault.getAbstractFileByPath?.(m.path);
                if (file) content = await this.vault.cachedRead(file);
            } catch { content = ''; }
            texts.push(String(content || '').slice(0, MAX_EMBED_CHARS));
        }
        return texts;
    }

    /**
     * Surowe wołanie embeddera z twardym kontraktem (AUD-wydajnosc-090/010/045/068):
     * N wejść → N wyników albo RZUT. Rzucony błąd niesie `kind`, żeby wołacz wiedział,
     * czy ponawiać (patrz `embedFailureKind`).
     */
    async _embedTexts(texts: string[], expected: number): Promise<Array<number[] | null>> {
        try {
            const vectors = await this.embedder.embedBatch(texts);
            // Dawniej `Array.isArray(vectors) ? vectors : metas.map(() => null)` przepuszczało
            // wszystko, co jest tablicą — a padnięty provider oddawał właśnie tablicę nulli.
            if (!Array.isArray(vectors)) {
                throw Object.assign(new Error('embedder nie zwrócił tablicy wyników'), { kind: 'shape' });
            }
            if (vectors.length !== expected) {
                throw Object.assign(
                    new Error(`embedder zwrócił ${vectors.length} wyników na ${expected} wejść`),
                    { kind: 'shape' },
                );
            }
            return vectors;
        } catch (e) {
            // ŻADEN mtime nie zostaje zestemplowany — `cause` niesie klasyfikację dalej.
            throw new Error(`embed failed: ${((e as ErrLike)?.message || e) as string}`, { cause: e });
        }
    }

    /**
     * Jeden plik z rozliczaniem TRWAŁYCH awarii (P2c). Awarię przejściową propaguje wyżej
     * (tam jest backoff), trwałą liczy: po `MAX_FILE_ATTEMPTS` plik jest pomijany.
     */
    async _embedOne(meta: FileMeta, text: string): Promise<EmbedSlot> {
        for (;;) {
            try {
                const [vec] = await this._embedTexts([text], 1);
                this._fileAttempts.delete(meta.path);
                this.skipped.delete(meta.path);
                return vec;
            } catch (e) {
                if (embedFailureKind(e) !== 'permanent') throw e;
                const n = (this._fileAttempts.get(meta.path) || 0) + 1;
                this._fileAttempts.set(meta.path, n);
                if (n < MAX_FILE_ATTEMPTS) continue;
                this.skipped.add(meta.path);
                this.lastError = `pominięto ${meta.path} po ${n} próbach: ${((e as ErrLike)?.message || e) as string}`;
                this.logger.warn('VaultIndexer', this.lastError);
                return EMBED_SKIPPED;
            }
        }
    }

    /**
     * Porcja: najpierw jednym żądaniem, a przy TRWAŁEJ awarii (np. 400 za jedną zatrutą
     * notatkę) plik po pliku — jeden zatruty plik nie może zabrać pozostałych piętnastu (P2c).
     */
    async _embedBatchSlots(metas: FileMeta[], texts: string[]): Promise<EmbedSlot[]> {
        try {
            const vectors = await this._embedTexts(texts, metas.length);
            for (const m of metas) { this._fileAttempts.delete(m.path); this.skipped.delete(m.path); }
            return vectors;
        } catch (e) {
            if (embedFailureKind(e) !== 'permanent' || metas.length === 1) throw e;
            this.logger.warn('VaultIndexer', `porcja odrzucona trwale — rozbijam ${metas.length} plików na pojedynczo`);
            const out: EmbedSlot[] = [];
            for (let i = 0; i < metas.length; i++) out.push(await this._embedOne(metas[i], texts[i]));
            return out;
        }
    }

    /** Czyta treść porcji i zwraca sloty (wektor / null dla pustych / EMBED_SKIPPED). */
    async _embedMetas(metas: FileMeta[]): Promise<EmbedSlot[]> {
        const texts = await this._readTexts(metas);
        for (let attempt = 0; ; attempt++) {
            try {
                return await this._embedBatchSlots(metas, texts);
            } catch (e) {
                // P2b: zimny start providera (Ollama ładująca model) potrafi przekroczyć sufit
                // czasu POJEDYNCZEGO żądania. Dwa ponowienia porcji, zanim uznamy skan za padnięty.
                if (attempt >= BATCH_TRANSIENT_RETRIES || embedFailureKind(e) !== 'transient') throw e;
                const wait = this.embedRetryMs * Math.pow(2, attempt);
                this.logger.warn('VaultIndexer', `porcja padła przejściowo (${attempt + 1}/${BATCH_TRANSIENT_RETRIES}) — ponawiam za ${wait} ms`);
                await this._sleep(wait);
            }
        }
    }

    /** Odczekanie w pętli ponowień. Timer JEST awaitowany — NIE unref (wzór `_yield`). */
    _sleep(ms: number): Promise<void> {
        return new Promise(resolve => _nodeSafeSetTimeout(resolve, ms));
    }

    _makeDoc(meta: FileMeta, vec: number[]): EmbeddingDoc {
        return {
            id: meta.path,
            path: meta.path,
            title: basename(meta.path),
            mtime: meta.mtime,
            embedding: vec,
        };
    }

    _schema(dims: number): AnySchema {
        return {
            id: 'string',
            path: 'string',
            title: 'string',
            mtime: 'number',
            embedding: `vector[${dims}]`,
        };
    }

    // ─────────────────────────── Persystencja ───────────────────────────

    _dbPath(): string { return `${this.indexDir}/vault-index.json`; }
    _metaPath(): string { return `${this.indexDir}/vault-index.meta.json`; }

    async _tryRestore(): Promise<boolean> {
        const [metaExists, dbExists] = await Promise.all([
            this._exists(this._metaPath()),
            this._exists(this._dbPath()),
        ]);
        if (!metaExists || !dbExists) return false;

        let meta: IndexMeta | undefined;
        try { meta = JSON.parse(await this.vault.adapter.read(this._metaPath())) as IndexMeta; }
        catch { return false; }
        if (!meta || meta.version !== INDEX_VERSION) return false;
        if (meta.model_key !== this.modelKey) {
            this.logger.info('VaultIndexer', `model zmieniony (${meta.model_key} → ${this.modelKey}) — pełny rebuild`);
            return false;
        }
        const dims = this._normalizeDims(meta.dims);
        if (!dims) return false;

        try {
            this.db = await restore((p) => this.vault.adapter.read(p), this._dbPath(), this._schema(dims));
        } catch (e) {
            this.logger.warn('VaultIndexer', `restore db failed: ${((e as ErrLike)?.message || e) as string}`);
            return false;
        }
        this.dims = dims;
        // AUD-wydajnosc-088/041: plik zapisany starszą wersją pluginu niesie kopie wektorów
        // w dokumentach. Zerujemy je od razu, żeby pierwszy zapis po restarcie nie utrwalił
        // dubla; stary (gruby) plik wczytuje się bez zmian i chudnie przy najbliższym zapisie.
        const stripped = stripStoredVectors(this.db);
        if (stripped) this.logger.debug('VaultIndexer', `restore: zdjęto ${stripped} kopii wektorów z docs-store`);
        this._mtimes = new Map(Object.entries(meta.mtimes || {}));
        return true;
    }

    async _persistNow(): Promise<void> {
        if (!this.db) return;
        try {
            await this._ensureDir();
            await persist(this.db, (p, json) => this.vault.adapter.write(p, json), this._dbPath());
            const meta: IndexMeta = {
                version: INDEX_VERSION,
                model_key: this.modelKey,
                dims: this.dims,
                updated_at: this.now(),
                mtimes: Object.fromEntries(this._mtimes),
            };
            await this.vault.adapter.write(this._metaPath(), JSON.stringify(meta));
        } catch (e) {
            this.logger.warn('VaultIndexer', `persist failed: ${((e as ErrLike)?.message || e) as string}`);
        }
    }

    _schedulePersist(): void {
        if (this._persistTimer) _nodeSafeClearTimeout(this._persistTimer);
        this._persistTimer = _nodeSafeSetTimeout(() => {
            this._persistTimer = null;
            this._persistNow().catch(e => this.logger.warn('VaultIndexer', `persist error: ${((e as ErrLike)?.message || e) as string}`));
        }, this.persistDebounceMs);
        this._persistTimer?.unref?.();
    }

    async _ensureDir(): Promise<void> {
        // Twórz każdy segment ścieżki (mkdir Obsidiana bywa nierekurencyjny).
        const parts = this.indexDir.split('/').filter(Boolean);
        let acc = '';
        for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            try {
                if (!(await this._exists(acc))) await this.vault.adapter.mkdir?.(acc);
            } catch { /* best-effort */ }
        }
    }

    // ─────────────────────────── Wykluczenia / helpery ───────────────────

    _publish(): void {
        if (this.plugin) this.plugin.oramaDb = this.db;
    }

    _listVaultMarkdown(): FileMeta[] {
        const files = this.vault.getMarkdownFiles?.() || [];
        const out: FileMeta[] = [];
        for (const f of files) {
            const path = f?.path;
            if (!this._isIndexable(path)) continue;
            out.push({ path, mtime: (f?.stat?.mtime ?? 0) });
        }
        return out;
    }

    /** Predykat typu: przepuszcza wyłącznie stringi (i to `.md` poza wykluczeniami). */
    _isIndexable(path: unknown): path is string {
        if (!path || typeof path !== 'string') return false;
        const norm = path.replace(/\\/g, '/');
        if (!norm.toLowerCase().endsWith('.md')) return false;
        return !this._isExcluded(norm);
    }

    /** HARD_EXCLUDES + the real config dir (user-configurable, not always `.obsidian`). */
    _hardExcludes(): string[] {
        if (!this._hardEx) {
            const cd = String(this.vault?.configDir || '').replace(/\\/g, '/').replace(/\/$/, '');
            this._hardEx = cd && !HARD_EXCLUDES.includes(cd) ? [...HARD_EXCLUDES, cd] : HARD_EXCLUDES;
        }
        return this._hardEx;
    }

    /**
     * K15 (AUD-security-101): to jest bramka ZAKAZU, więc porównuje BEZ rozróżniania
     * wielkości liter — tak samo jak `AccessGuard._isNoGo` i `isProtectedPath`.
     *
     * Wcześniej szło bajt w bajt, a wpisy No-Go i folder artefaktów user wpisuje RĘCZNIE
     * w ustawieniach. Na Windows i macOS wystarczyło, żeby wpisał `Prywatne`, a folder na
     * dysku nazywał się `prywatne` — treść z zakazanego folderu wchodziła do indeksu
     * semantycznego i wracała userowi w wynikach `search mode=semantic`. Zakaz ma łapać
     * za dużo, nie za mało (pełne uzasadnienie: `core/security/AccessGuard.ts`,
     * `_normalizeForDenyCompare`).
     *
     * Świadomie BEZ importu `AccessGuard`: indekser trzyma zero zależności od `core/`,
     * wszystko dostaje wstrzyknięte (patrz nagłówek pliku) — dlatego ta sama reguła jest
     * tu wyliczona lokalnie, a nie zawołana.
     */
    _isExcluded(norm: string): boolean {
        const cel = norm.normalize('NFC').toLowerCase();
        const wpis = (v: string): string =>
            String(v || '').replace(/\\/g, '/').replace(/\/$/, '').normalize('NFC').toLowerCase();

        for (const ex of this._hardExcludes()) {
            const e = wpis(ex);
            if (e && (cel === e || cel.startsWith(e + '/'))) return true;
        }
        for (const ng of this._getNoGoFolders()) {
            const n = wpis(ng);
            if (!n) continue;
            if (cel === n || cel.startsWith(n + '/')) return true;
        }
        // E2.9: folder artefaktów (gdy indeksowanie wyłączone).
        const art = wpis(this._getArtifactsExclude() || '');
        if (art && (cel === art || cel.startsWith(art + '/'))) return true;
        return false;
    }

    _getNoGoFolders(): string[] {
        try {
            const src = typeof this._noGoSource === 'function' ? this._noGoSource() : this._noGoSource;
            return Array.isArray(src) ? src : [];
        } catch { return []; }
    }

    /** @returns folder artefaktów do wykluczenia (znormalizowany) albo null. */
    _getArtifactsExclude(): string | null {
        try {
            const src = typeof this._artifactsExclude === 'function' ? this._artifactsExclude() : this._artifactsExclude;
            if (!src || typeof src !== 'string') return null;
            return src.replace(/\\/g, '/').replace(/\/$/, '');
        } catch { return null; }
    }

    async _statMtime(path: string): Promise<number> {
        // Vault API first (TFile carries .stat.mtime); adapter.stat only as a fallback
        // for paths Obsidian does not expose as files (e.g. hidden ones).
        try {
            const f = this.vault.getAbstractFileByPath?.(path);
            if (f?.stat?.mtime != null) return f.stat.mtime;
        } catch { /* fall through */ }
        try {
            const st = await this.vault.adapter.stat?.(path);
            if (st && typeof st.mtime === 'number') return st.mtime;
        } catch { /* fall through */ }
        return this.now();
    }

    async _exists(path: string): Promise<boolean> {
        try { return !!(await this.vault.adapter.exists?.(path)); }
        catch { return false; }
    }

    _embedderReady(): boolean {
        try { return !!this.embedder?.isReady?.(); } catch { return false; }
    }

    _safeModelKey(): string {
        try { return this.embedder?.getModelKey?.() || ''; } catch { return ''; }
    }

    _safeDims(): number | null | undefined {
        try { return this.embedder?.getDims?.(); } catch { return null; }
    }

    _normalizeDims(d: unknown): number | null {
        return (typeof d === 'number' && Number.isFinite(d) && d > 0) ? Math.floor(d) : null;
    }

    _deriveDims(vectors: EmbedSlot[]): number | null {
        if (!Array.isArray(vectors)) return null;
        const first = vectors.find(v => Array.isArray(v) && v.length > 0);
        return first ? first.length : null;
    }

    _yield(): Promise<void> {
        // Oddaj wątek UI między porcjami. Timer JEST awaitowany — NIE unref (inaczej
        // przy bezczynnej pętli zdarzeń nigdy nie wystrzeli i skan zawiśnie).
        return new Promise(resolve => _nodeSafeSetTimeout(resolve, 0));
    }
}

/** Typy zdarzeń vaulta obsługiwane przez indekser. */
export type VaultEventType = 'create' | 'modify' | 'delete' | 'rename';
