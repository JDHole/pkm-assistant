/**
 * VaultIndexer - żywy indeks semantyczny vaulta.
 *
 * VaultIndexer buduje indeks Oramy z plików `.md` vaulta i publikuje go jako `plugin.oramaDb` -
 * ten kontrakt zasila istniejących konsumentów (VaultRetrievalTools, MemoryRetrievalTools,
 * RetrievalEngine) bez zmiany ich API. Bez tego przypisania `RetrievalEngine._canUseLayer3()`
 * zawsze zwracałby false i L3 po cichu spadałby do keyword/L2.
 *
 * Stany (getStatus().status):
 *   - 'disabled_mobile' - Platform.isMobile (desktop-first)
 *   - 'no_provider'     - brak działającego adaptera embeddingów (user nie wybrał providera)
 *   - 'building'        - trwa skan/embedding (progress {indexed, total})
 *   - 'ready'           - indeks zbudowany i opublikowany jako plugin.oramaDb
 *   - 'error'           - embed API padło; częściowy indeks NIE jest publikowany
 *                         (a jeśli był już 'ready', stary oramaDb zostaje żywy)
 *
 * Świadomy trade-off: embedujemy PER PLIK pierwsze ~6000 znaków, BEZ chunkingu.
 * Chunking per sekcja (dokładniejszy, ale droższy) to celowo osobny zakres.
 *
 * BEZPIECZEŃSTWO (twarda granica): indeks NIGDY nie zawiera `.pkm-assistant/**`
 * - to pamięć agentów (izolacja). Traktowane jak NoGo. Dlatego semantyka pamięci
 * (scope:'memory') pozostaje niedostępna i degraduje do L2 - patrz RetrievalEngine.
 *
 * Testowalność: wszystkie zależności wstrzykiwane (fake vault, fake embedder,
 * flaga isMobile, in-memory adapter). Handlery hooków wołalne bezpośrednio.
 */

import {
    createEmbeddingDb,
    insertVectorLean,
    removeVector,
    DEFAULT_VECTOR_DIM,
} from './orama_engine.js';
import type { AnyOrama, AnySchema } from '@orama/orama';
import type { EmbeddingDoc } from './orama_engine.js';
import {
    encodeSegment,
    decodeSegment,
    parseIndexMetaV2,
    parseIndexMetaV1,
    planCompaction,
    extractV1Vectors,
    segmentFileName,
    isSegmentFileName,
    maxSegmentSeq,
} from './indexStore.js';
import type { SegmentRef, RowRef, IndexMetaV2, IndexMetaV1 } from './indexStore.js';

// obsidianmd/prefer-window-timers: ten plik wstaje w gołym Node (testy AVA), gdzie `window`
// nie istnieje — `window.setTimeout` byłby ReferenceError. Inline `eslint-disable` jest
// zablokowany dla `obsidianmd/*` (`eslint-comments/no-restricted-disable` w configu pluginu
// recenzenta katalogu). Owijamy globalny timer FUNKCJĄ zamiast zamrażać referencję raz przy
// imporcie — `fn` czyta `setTimeout`/`clearTimeout` DYNAMICZNIE przy każdym wywołaniu, więc
// zachowanie jest 1:1 jak bezpośrednie wywołanie globala. Reguła pomija wywołanie, bo `fn`
// jest lokalną zmienną, nie globalną referencją.
// Typ bezpieczny pod OBIE strony hosta: Obsidian (przeglądarka) oddaje `setTimeout` jako
// `ReturnType<typeof setTimeout>` BEZ `.unref` (przeglądarkowy timer), a harness AVA w Node
// oddaje `NodeJS.Timeout`, który `.unref` ma naprawdę. Pole intersekcyjne przyjmuje obie
// wartości; `?.()` w miejscach użycia obsługuje brak metody na przeglądarkowym wariancie.
type NodeSafeTimer = ReturnType<typeof setTimeout> & { unref?: () => void };

function _nodeSafeSetTimeout(...args: Parameters<typeof setTimeout>): NodeSafeTimer {
    const fn = setTimeout;
    return fn(...args);
}
function _nodeSafeClearTimeout(...args: Parameters<typeof clearTimeout>): void {
    const fn = clearTimeout;
    fn(...args);
}

const DEFAULT_INDEX_DIR = '.pkm-assistant/index';
const MAX_EMBED_CHARS = 6000;     // per-plik treść do embeddingu (świadomy trade-off, patrz docstring modułu)
const DEFAULT_BATCH_SIZE = 16;    // porcja plików na jeden embedBatch
const DEFAULT_DEBOUNCE_MS = 2000; // debounce kolejki zmian z hooków
const DEFAULT_PERSIST_MS = 30000; // debounce zapisu na dysk po zmianach
/** Sufit odczekania po nieudanym flushu (porcja wraca do kolejki). */
const MAX_FLUSH_RETRY_MS = 5 * 60 * 1000;
/** Ile razy ponawiamy PORCJĘ po awarii przejściowej, zanim uznamy skan za padnięty. */
const BATCH_TRANSIENT_RETRIES = 2;
/** Ile razy próbujemy POJEDYNCZY plik przy trwałej awarii, zanim go pominiemy. */
const MAX_FILE_ATTEMPTS = 3;
/** Baza backoffu ponowień porcji (ms). */
const DEFAULT_EMBED_RETRY_MS = 2000;
/** Baza backoffu automatycznego ponowienia całego skanu po padzie (ms). */
const DEFAULT_SCAN_RETRY_MS = 30000;
/** Sufit odczekania przed ponowieniem skanu. */
const MAX_SCAN_RETRY_MS = 5 * 60 * 1000;

/**
 * Plik trwale pominięty w tej rundzie - NIE dostaje stempla mtime, więc wróci przy
 * następnym skanie/restarcie, ale nie blokuje reszty porcji.
 */
export const EMBED_SKIPPED = 'skipped';
/** Wynik embeddingu jednego pliku: wektor | `null` (pusta treść) | `EMBED_SKIPPED`. */
export type EmbedSlot = number[] | null | typeof EMBED_SKIPPED;

/** Jak indekser traktuje awarię embeddingu. */
type EmbedFailure = 'transient' | 'permanent' | 'fatal';

/**
 * Klasyfikacja awarii embeddingu - kaczo-typowana, bo fasada embeddera jest WSTRZYKIWANA
 * i nie musi rzucać `EmbedBatchError` z tego modułu (harness i testy mają własne atrapy).
 *
 * - `transient` - sieć/timeout/429: ponawiamy CAŁĄ porcję.
 * - `permanent` - błąd API inny niż 429 (np. 400 za przekroczony kontekst): jeden zatruty
 *   plik nie może blokować pozostałych, więc porcja idzie na pojedynczo.
 * - `fatal` - adapter oddał inną liczbę wyników niż wejść. NIE rozbijamy takiej porcji:
 *   dla jednego wejścia zwrotka błędu ma długość 1, więc wyglądałaby jak „plik pusty"
 *   i wskrzesiłaby dokładnie ten stempel mtime, przed którym chroni kontrakt błędu (patrz testy).
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

/**
 * Foldery zawsze wykluczone z indeksu (poza NoGo z ustawień).
 *
 * Folderu konfiguracji Obsidiana TU NIE MA: jego nazwę ustala user (`Vault#configDir`),
 * więc dokłada ją `_hardExcludes()` z żywego odczytu, a gdy jest nieznana, wykluczenie
 * przejmuje fail-closed w `_isExcluded`.
 */
const HARD_EXCLUDES = ['.pkm-assistant', '.trash'];

/** Plik vaulta widziany przez indekser (TFile Obsidiana pasuje strukturalnie). */
export interface VaultFileLike {
    path: string;
    stat?: { mtime?: number };
}

/** Adapter FS vaulta — używany WYŁĄCZNIE do ukrytego pliku indeksu. */
export interface VaultAdapterLike {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    /** Segmenty wektorów (format v2) są binarne — czytane/pisane osobno od meta (JSON). */
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    exists?(path: string): Promise<boolean>;
    mkdir?(path: string): Promise<void>;
    stat?(path: string): Promise<{ mtime?: number } | null>;
    /** Kasowanie starego pliku v1 po udanej migracji + sierot segmentów. Best-effort. */
    remove?(path: string): Promise<void>;
    /** Listing katalogu indeksu — sprzątanie sierot po restore. Ścieżki PEŁNE względem roota vaulta. */
    list?(path: string): Promise<{ files: string[]; folders: string[] }>;
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

/**
 * Powód nieudanej migracji v1→v2 - KOD, nie zdanie po polsku (i18n tłumaczy go przez
 * `embedding.notice.migration_reason.<kod>`, `detail` niesie surowy komunikat błędu
 * dosklejany po dwukropku). Patrz `_migrationFailed`.
 */
export type MigrationFailReason =
    | 'v1_unreadable'
    | 'v1_malformed'
    | 'dims_mismatch'
    | 'segment_write'
    | 'meta_write'
    | 'verify_failed';

/**
 * Wykryty rebuild (D6): model/wymiar wektora się zmienił, albo indeks na dysku jest
 * nieczytelny/niekompletny. Indekser NIGDY nie miesza starych i nowych wektorów po cichu -
 * każdy z tych przypadków kończy się pełnym rebuildem i JEDNYM powiadomieniem UI.
 */
export type IndexerNotice =
    | { kind: 'model_changed'; from: string | null; to: string }
    | { kind: 'dims_changed'; from: number; to: number }
    | { kind: 'index_corrupt' }
    | { kind: 'migration_failed'; reason: MigrationFailReason; detail?: string }
    | { kind: 'migrated'; fromBytes: number; toBytes: number };

/** Publiczny snapshot stanu (Settings + noty degradacji). */
export interface IndexerStatusSnapshot {
    status: IndexerStatus;
    progress: { indexed: number; total: number };
    modelKey: string | null;
    lastError: string | null;
    /** Ostatnie zdarzenie wykrytego rebuildu/migracji, `null` = brak. */
    lastNotice: IndexerNotice | null;
}

/** Metadane pliku brane do indeksu. */
export interface FileMeta {
    path: string;
    mtime: number;
}

/** Zależności konstruktora — wszystko wstrzykiwane (testowalność). */
export interface VaultIndexerDeps {
    /** ustawia plugin.oramaDb + plugin.registerEvent/register (cleanup) */
    plugin?: IndexerPluginLike | null;
    /** Obsidian Vault: getMarkdownFiles(), getAbstractFileByPath(), cachedRead(), adapter{read,write,readBinary,writeBinary,exists,mkdir,stat,remove,list} (adapter tylko dla ukrytego pliku indeksu - format v2, patrz VaultAdapterLike), on/offref */
    vault: VaultLike;
    /** fasada: isReady(), embedBatch(texts), embed(text), getModelKey(), getDims() */
    embedder: EmbedderFacade;
    /** Platform.isMobile */
    isMobile?: boolean;
    logger?: IndexerLogger;
    /** Powiadomienia UI o wykrytym rebuildzie/migracji (D7 - `src/main.ts` mapuje na `new Notice(...)`). */
    notify?: (event: IndexerNotice) => void;
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

function msg(e: unknown): string {
    return String((e as ErrLike)?.message || e);
}

function basename(path: string): string {
    const p = String(path || '').replace(/\\/g, '/');
    const last = p.split('/').pop() || p;
    return last.replace(/\.md$/i, '');
}

/**
 * Sentinel wewnętrzny: rzucany z `_insertOne` gdy wymiar wektora zmienił się NA ŻYWO
 * (indeks już `ready`/po restore), żeby przerwać bieżącą porcję bez ponowień - `rebuild()`
 * jest już uzbrojony i tak zreembeduje wszystko od nowa (D6). Nigdy nie wychodzi poza ten plik.
 */
class DimsRebuildTriggered extends Error {}

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
    declare private _debounceTimer: NodeSafeTimer | null;
    declare private _persistTimer: NodeSafeTimer | null;
    /** Liczba KOLEJNYCH nieudanych flushów - steruje backoffem ponowienia. */
    declare private _flushFailures: number;
    /** Kiedy (wg `now()`) ma wystrzelić uzbrojone ponowienie po padzie - `null` = brak. */
    declare private _flushRetryAt: number | null;
    /** Ostatnio uzbrojone opóźnienie flushu (ms) - diagnostyka + asercja w testach. */
    declare _flushDelayMs: number;
    /** Licznik prób na plik przy trwałej awarii. */
    declare private _fileAttempts: Map<string, number>;
    /** Pliki pominięte po wyczerpaniu prób — bez stempla mtime, wrócą przy następnym skanie. */
    declare skipped: Set<string>;
    declare private _scanRetryTimer: NodeSafeTimer | null;
    declare private _scanFailures: number;
    /** memoizowana lista twardych wykluczeń (liczona przy pierwszym użyciu) */
    declare private _hardEx?: string[];
    /** Czy migawka `_hardEx` zna nazwę folderu konfiguracji. `false` = fail-closed w `_isExcluded`. */
    declare private _configDirKnown?: boolean;

    // ─────────────────────────── Format v2 (segmenty + meta) ───────────────────────────
    /** Segmenty znane z ostatniego udanego restore/persist (kolejność = `next_seq` rosnąco). */
    declare private _segments: SegmentRef[];
    /** path -> [segIdx, rowIdx], TYLKO dla ścieżek z wektorem (D8: puste notatki bez wpisu). */
    declare private _rows: Map<string, RowRef>;
    /** Następny numer sekwencji segmentu — rośnie monotonicznie, nawet po kompakcji. */
    declare private _nextSeq: number;
    /** Wektory zembedowane od ostatniego udanego zapisu; upsert nadpisuje wpis tej samej ścieżki. */
    declare private _pending: Map<string, Float32Array>;
    /** Coś w mtimes/rows się zmieniło (także usunięcia i puste pliki) — meta wymaga zapisu. */
    declare private _metaDirty: boolean;
    /** Ostatnie zdarzenie wykrytego rebuildu/migracji (D6) — część `getStatus()`. */
    declare lastNotice: IndexerNotice | null;
    /** Powiadomienie UI wstrzyknięte z `main.js` (`deps.notify`); brak = no-op. */
    declare private _notifyFn?: (event: IndexerNotice) => void;
    /** Zabezpieczenie przed rekurencją: rebuild po rozjeździe dims odpalany dokładnie raz. */
    declare private _dimsRebuildPending: boolean;
    /** Klucze `min-max` par (from,to) `dims_changed` już pokazanych UI w tej sesji (F4.2). */
    declare private _notifiedDimsPairs: Set<string>;

    // ─────────────────────────── Współbieżność persist (F1) ───────────────────────────
    /**
     * Łańcuch persistów — `_persistNow()` dokłada `_persistNowInner()` na jego koniec zamiast
     * wołać go bezpośrednio, więc dwa równoległe `_persistNow()` (timer + koniec skanu/resyncu,
     * rebuild wołany z flusha itd.) NIGDY nie wykonują `_persistNowInner` naraz - drugi czeka na
     * pierwszy. Bez tego dwa równoległe persisty mogą dać dwa segmenty o TEJ SAMEJ nazwie
     * (oba czytają `_nextSeq` przed inkrementacją drugiego) albo `_pending.clear()` jednego
     * gubi wektory dołożone przez flush w oknie `await` drugiego.
     */
    declare private _persistChain: Promise<void>;
    /**
     * Licznik generacji — inkrementowany przy KAŻDEJ mutacji `_pending`/`_mtimes`/`_rows`
     * (insert, usunięcie, stempel pustej notatki, reset przy skanie/rebuildzie/restore).
     * `_writeMetaTracked` porównuje generację sprzed budowy meta z generacją PO udanym zapisie -
     * różnica znaczy, że coś zmieniło stan w oknie `await write(meta)`, więc meta na dysku może
     * nie nieść najświeższego stanu i `_metaDirty` MUSI zostać `true` (następny persist dogoni).
     */
    declare private _gen: number;

    constructor(deps: VaultIndexerDeps = {} as VaultIndexerDeps) {
        this.plugin = deps.plugin || null;
        this.vault = deps.vault;
        this.embedder = deps.embedder;
        this.isMobile = !!deps.isMobile;
        this.logger = deps.logger || { info() {}, warn() {}, error() {}, debug() {} };
        this._noGoSource = deps.noGoFolders || [];
        // Folder artefaktów żywych wykluczany z indeksu, dopóki user nie włączy
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

        this._segments = [];
        this._rows = new Map();
        this._nextSeq = 1;
        this._pending = new Map();
        this._metaDirty = false;
        this.lastNotice = null;
        this._notifyFn = deps.notify;
        this._dimsRebuildPending = false;
        this._notifiedDimsPairs = new Set();
        this._persistChain = Promise.resolve();
        this._gen = 0;
    }

    /** Mutacja `_pending`/`_mtimes`/`_rows` — patrz komentarz przy polu `_gen`. */
    private _bumpGen(): void { this._gen++; }

    /**
     * Powiadamia UI (jeśli wstrzyknięte) i zapamiętuje jako `lastNotice`. `dims_changed`
     * dostaje osobne traktowanie (F4.2): dostawca, który oscyluje między dwoma wymiarami,
     * wywołuje rebuild za KAŻDYM razem (logika bez zmian), ale user widzi Notice tylko RAZ na
     * sesję na daną (nieuporządkowaną) parę - inaczej flip-flop 4⇄8 zasypywałby go tym samym
     * powiadomieniem w kółko. Log ostrzegawczy leci za każdym razem niezależnie od dedupe.
     */
    private _notify(n: IndexerNotice): void {
        this.lastNotice = n;
        if (n.kind === 'dims_changed') {
            const key = `dims_changed:${Math.min(n.from, n.to)}-${Math.max(n.from, n.to)}`;
            this.logger.warn('VaultIndexer', `wymiar wektora zmienił się (${n.from} → ${n.to})`);
            if (this._notifiedDimsPairs.has(key)) return;
            this._notifiedDimsPairs.add(key);
        }
        try { this._notifyFn?.(n); }
        catch (e) { this.logger.warn('VaultIndexer', `notify handler rzucił: ${msg(e)}`); }
    }

    /** Publiczny snapshot stanu dla Settings + not degradacji. */
    getStatus(): IndexerStatusSnapshot {
        return {
            status: this.status,
            progress: { indexed: this.progress.indexed, total: this.progress.total },
            modelKey: this.modelKey,
            lastNotice: this.lastNotice,
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
                // Odzyskany indeks jest KOMPLETNY sam w sobie - publikujemy go
                // ZANIM ruszy resync. Gdyby pad resyncu (np. Ollama zgaszona przy starcie,
                // notatki zmienione od ostatniego bootu) leciał do `catch` niżej przed tą publikacją,
                // `_publish()` nigdy by nie poszło, a `_ready` zostawałoby `false`: semantyka martwa
                // na całą sesję i zero ponowień, mimo że NIEŚWIEŻY indeks był w garści. Nieświeży > brak.
                this._publish();
                await this._resync(); // własny catch: nieudane pliki lądują w kolejce
            } else {
                await this._fullScan();
                this._publish();
            }

            // `as IndexerStatus`: TS zawęża `this.status` do literału `'building'` z przypisania
            // wyżej i nie wie, że `_resync()`/`rebuild()` wołane pod spodem mogły je zmienić -
            // rzutowanie na deklarowaną unię jest tu poprawną odpowiedzią, nie castem na wiarę.
            if ((this.status as IndexerStatus) === 'error') {
                // F4.1: `_resync()` wykrył rozjazd dims i sam odpalił `rebuild()`, ale TEN rebuild
                // padł (dostawca zgaszony w trakcie) - `rebuild()` już ustawił status/lastError i
                // uzbroił ponowienie skanu. Nadpisanie tego na 'ready' niżej ukrywałoby awarię;
                // stary (przywrócony przez `rebuild()`) indeks zostaje opublikowany i żywy, ale
                // `_ready` NIE przechodzi na `true` - dokładnie jak przy padzie całego skanu.
                return;
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
            // Skan bez indeksu w garści (albo pad poza resyncem) - ponów sam, z backoffem.
            // Bez tego zimny start Ollamy dłuższy niż sufit czasu kończył się `error` NA STAŁE.
            this._scheduleScanRetry();
        }
    }

    /** Automatyczne ponowienie całego skanu po padzie. Odwoływane przez `dispose()`. */
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
        // Bramki PRZED mutacją stanu: gdyby `_ready=false` + `db=null` + kolejka/mtimes
        // wyczyszczone szły PRZED tymi sprawdzeniami, wczesny return (isMobile/no_provider)
        // zostawiałby indekser połamany na zawsze (żywy `plugin.oramaDb`,
        // ale `_ready=false` blokujące `_flushQueue` do końca sesji). Nic tu nie mutujemy, dopóki
        // nie wiemy, że rebuild faktycznie ruszy - wtedy early return nie ma czego przywracać.
        if (this.isMobile) { this.status = 'disabled_mobile'; return this.getStatus(); }
        if (!this._embedderReady()) { this.status = 'no_provider'; return this.getStatus(); }

        // Skasuj timer zaplanowanego zapisu i POCZEKAJ na persist w toku (jeśli jakiś trwa) -
        // rebuild zaraz resetuje `_segments`/`_rows`/`_pending` pod nogami, a `_persistNowInner`
        // w locie czyta te same pola (kompakcja w szczególności trzyma migawki między awaitami).
        if (this._persistTimer) { _nodeSafeClearTimeout(this._persistTimer); this._persistTimer = null; }
        await this._persistChain;

        // Gdyby `catch` przywracał SAM `db`, `_mtimes` zostawałyby puste,
        // `dims` z nieudanego skanu, a `_ready` na `false`, czyli przywrócony indeks byłby żywy
        // dla czytelników, ale martwy dla kolejki zmian. Zdejmujemy pełny snapshot.
        // `_nextSeq` ŚWIADOMIE NIE wchodzi w tę migawkę (F2/D3) - segment, który rebuild zdążył
        // zapisać przed padem, istnieje NAPRAWDĘ na dysku; cofnięcie licznika kazałoby kolejnemu
        // udanemu zapisowi nadpisać ten sam numer inną treścią.
        const previousDb = this.db;
        const previousMtimes = this._mtimes;
        const previousDims = this.dims;
        const previousReady = this._ready;
        const previousSegments = this._segments;
        const previousRows = this._rows;
        const previousPending = this._pending;
        const previousMetaDirty = this._metaDirty;
        // Lista segmentów SPRZED rebuildu — po udanym pierwszym zapisie meta poniżej stają się
        // sierotami (D3: nowy rebuild pisze od zera pod NOWYMI numerami), sprzątamy je od razu
        // zamiast czekać do następnego udanego restore.
        const segmentsBeforeRebuild = this._segments.map(s => ({ ...s }));
        this._ready = false;
        this._queue.clear();
        this._mtimes = new Map();
        this.db = null;
        this._bumpGen();
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

            // Best-effort, tylko gdy meta faktycznie odzwierciedla nowy stan (`!_metaDirty` =
            // ostatni zapis meta się udał I nic nie mutowało `_pending`/`_mtimes`/`_rows` w oknie
            // jego `await` - patrz `_writeMetaTracked`). Inaczej te segmenty zostają sierotami
            // do najbliższego udanego restore (`_cleanupOrphanSegments`), zamiast ryzykować
            // skasowanie czegoś, na co nowa meta jeszcze nie zdążyła przestać wskazywać.
            if (!this._metaDirty) {
                const stillKnown = new Set(this._segments.map(s => s.file));
                for (const seg of segmentsBeforeRebuild) {
                    if (stillKnown.has(seg.file)) continue;
                    try { await this.vault.adapter.remove?.(this._segmentPath(seg.file)); }
                    catch (e) { this.logger.warn('VaultIndexer', `sprzątanie starego segmentu ${seg.file} po rebuildzie padło: ${msg(e)}`); }
                }
            }
        } catch (e) {
            // Rebuild padł: przywróć CAŁY stan sprzed próby (db był opublikowany), zgłoś error.
            this.db = previousDb;
            this._mtimes = previousMtimes;
            this.dims = previousDims;
            this._ready = previousReady;
            this._segments = previousSegments;
            this._rows = previousRows;
            this._pending = previousPending;
            this._metaDirty = previousMetaDirty;
            this._bumpGen();
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

            // Gdyby `_scheduleFlush()` stało POZA tymi gałęziami, zdarzenie na pliku SPOZA
            // indeksu (załącznik, notatka w NoGo, folder artefaktów) kasowałoby zaplanowany
            // flush realnych zmian i nastawiało zegar od nowa. Strumień takich zdarzeń
            // odsuwałby indeksowanie edytowanej notatki na czas swojego trwania.
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
     * Zwykły debounce NIE MOŻE skrócić uzbrojonego ponowienia. Oba wiszą na
     * tym samym timerze, więc przy trwale zgaszonym demonie i pracującym userze każde zdarzenie
     * z vaulta zbijałoby 5-minutowy backoff do 2 s - czyli młócilibyśmy API co dwie sekundy,
     * dokładnie to, przed czym backoff ma chronić.
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
        this._flushRetryAt = null; // uzbrojone ponowienie właśnie konsumujemy
        const entries = [...this._queue.entries()];
        this._queue.clear();
        let failed = false;
        let dimsRebuild = false;
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
            if (e instanceof DimsRebuildTriggered) {
                // Wymiar wektora zmienił się NA ŻYWO (D6) - `rebuild()` niżej zreembeduje
                // wszystko od nowa, więc te wpisy NIE wracają do kolejki (to nie jest awaria).
                dimsRebuild = true;
            } else {
                // Embed API padło w trakcie kolejki. Porcja NIE dostała
                // stempla mtime (patrz `_embedMetas`), więc wraca do kolejki i pójdzie ponownie.
                // Bez tego `_queue.clear()` wyżej gubiłby te ścieżki bezpowrotnie: pliki znikałyby
                // z indeksu (remove-then-insert) i nie wracały aż do pełnego reindeksu.
                failed = true;
                this._flushFailures++;
                this.lastError = msg(e);
                for (const [path, action] of entries) {
                    if (!this._queue.has(path)) this._queue.set(path, action);
                }
                this.logger.warn('VaultIndexer', `flush failed (${this._flushFailures}) — ${entries.length} zmian wraca do kolejki: ${this.lastError}`);
            }
        } finally {
            this._processing = false;
        }
        if (dimsRebuild) {
            await this.rebuild();
            this._dimsRebuildPending = false;
            return;
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
        // Ponowienie po padzie W POŁOWIE poprzedniego skanu (bug zastany na main, poza zakresem
        // recenzji, naprawiony przy okazji - F4.10): `this.db` mógł zostać częściowo zapełniony
        // przed rzutem (embed padł w środku porcji), a `initialize()`'s catch NIE zeruje `db`.
        // Bez tego resetu drugi `_fullScan()` insertowałby do TEJ SAMEJ, częściowej bazy i dostawał
        // "A document with id ... already exists" w nieskończoność zamiast policzyć wszystko od zera.
        this.db = null;
        // Pełny skan re-embeduje WSZYSTKO od zera — format v2 zaczyna też od zera:
        // stare segmenty/wiersze/oczekujące wektory tego indeksera nie mają tu żadnej roli
        // (sieroty na dysku sprząta najbliższy udany restore, D3).
        this._segments = [];
        this._rows = new Map();
        this._pending = new Map();
        this._metaDirty = false;
        this._bumpGen();
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
                // `mode: 'scan'` — rozjazd wymiaru WEWNĄTRZ tego samego skanu jest anomalią
                // dostawcy, nie powodem do pełnego rebuildu (D6): plik jest po prostu pomijany.
                for (let j = 0; j < batch.length; j++) await this._insertOne(batch[j], vectors[j], 'scan');
            } else {
                // dims wciąż nieznane (cała porcja pusta) — zapamiętaj mtimes, pomiń insert.
                // Pominięte pliki NIE dostają stempla: mają wrócić.
                for (let j = 0; j < batch.length; j++) {
                    if (vectors[j] !== EMBED_SKIPPED) {
                        this._mtimes.set(batch[j].path, batch[j].mtime);
                        this._metaDirty = true;
                    }
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
                if (e instanceof DimsRebuildTriggered) {
                    // Wymiar wektora zmienił się od ostatniego bootu (D6) — pełny rebuild
                    // zreembeduje wszystko od nowa, więc te pliki NIE wracają do kolejki.
                    upserted = 0;
                    this.logger.info('VaultIndexer', 'wymiar wektora zmienił się od ostatniego bootu — pełny rebuild');
                    const rebuilt = await this.rebuild();
                    this._dimsRebuildPending = false;
                    if (rebuilt.status !== 'ready') {
                        // F4.1: rebuild wywołany rozjazdem dims SAM padł (np. dostawca zgaszony
                        // w trakcie). `rebuild()` już ustawił status='error'/lastError i przywrócił
                        // poprzedni (stary, ale żywy) stan - `initialize()` sprawdza `this.status`
                        // po powrocie z `_resync()` i NIE nadpisuje go na 'ready'. Tu tylko uzbrajamy
                        // ponowienie całego skanu, dokładnie jak przy padzie skanu w ogóle.
                        this._scheduleScanRetry();
                        return;
                    }
                } else {
                    // Pad odświeżania NIE MOŻE zabrać odzyskanego indeksu. Zmienione pliki
                    // wracają do kolejki i idą tym samym mechanizmem ponowień co flush; ich mtime
                    // nie został zestemplowany, więc przy następnym starcie i tak wrócą.
                    upserted = 0;
                    this._flushFailures++;
                    this.lastError = msg(e);
                    for (const f of toUpsert) {
                        if (!this._queue.has(f.path)) this._queue.set(f.path, 'upsert');
                    }
                    this.logger.warn('VaultIndexer', `resync failed — ${toUpsert.length} plików do kolejki: ${this.lastError}`);
                    this._scheduleFlush(this._flushRetryDelayMs(this._flushFailures));
                }
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

    /**
     * @param mode `'scan'` (wewnątrz `_fullScan`, dims dopiero się ustala w TYM biegu — rozjazd
     *   z już ustalonym `this.dims` to anomalia dostawcy, plik jest po prostu pomijany) albo
     *   `'live'` (domyślny; `_indexMetas` z `_resync`/`_flushQueue` na indeksie, który już ma
     *   ustalone `this.dims` z poprzedniej sesji — rozjazd tu znaczy, że model/wymiar zmienił
     *   się NA ŻYWO, D6: notify + rzut `DimsRebuildTriggered`, wołacz uzbraja `rebuild()`).
     */
    async _insertOne(meta: FileMeta, vec: EmbedSlot, mode: 'scan' | 'live' = 'live'): Promise<void> {
        if (!this.db) return;
        if (vec === EMBED_SKIPPED) {
            // Plik trwale odrzucany przez API. BEZ stempla mtime - wróci przy następnym
            // skanie/restarcie, ale nie blokuje reszty porcji ani całego indeksowania.
            return;
        }
        if (Array.isArray(vec) && vec.length) {
            if (this.dims != null && vec.length !== this.dims) {
                if (mode === 'scan' || this._dimsRebuildPending) {
                    this.logger.warn('VaultIndexer', `${meta.path}: wektor ${vec.length}D w skanie z ustalonym wymiarem ${this.dims}D — pomijam plik`);
                    return;
                }
                this._dimsRebuildPending = true;
                this._notify({ kind: 'dims_changed', from: this.dims, to: vec.length });
                throw new DimsRebuildTriggered(`wymiar wektora zmienił się (${this.dims} → ${vec.length})`);
            }
            // insertVectorLean: wektor zostaje TYLKO w `index.vectorIndexes` (żywa Orama, D1).
            await insertVectorLean(this.db, this._makeDoc(meta, vec));
            // Trwałość v2: wiersz oczekujący na najbliższy `_persistNow()` (D2/D3) — Orama
            // sama w sobie nie jest tu źródłem prawdy o tym, co jest na dysku.
            this._pending.set(meta.path, Float32Array.from(vec));
            this._mtimes.set(meta.path, meta.mtime);
            this._metaDirty = true;
            this._bumpGen();
            this.progress.indexed = this._mtimes.size;
        } else {
            // PUSTY PLIK (i tylko pusty): brak wektora dla treści, której nie ma. Awaria
            // providera nigdy tu nie dociera - kontrakt błędu wymaga, żeby `_embedMetas` RZUCAŁO
            // zamiast oddawać nulle, więc mtime nie jest stemplowany i porcja wraca do kolejki
            // / kończy skan błędem. D8: stempel jest, wiersza (wektora) nie ma.
            this._mtimes.set(meta.path, meta.mtime);
            this._metaDirty = true;
            this._bumpGen();
        }
    }

    async _removeDoc(path: string, keepMtime = false): Promise<void> {
        if (this.db) {
            try { await removeVector(this.db, path); } catch { /* not present */ }
        }
        if (!keepMtime) {
            if (this._mtimes.delete(path)) this._metaDirty = true;
        }
        // Wiersz (jeśli był) staje się martwy/zastąpiony - w obu przypadkach usunięcie z `_rows`
        // jest poprawne: albo notatka naprawdę znika (usunięcie), albo za chwilę dostanie NOWY
        // wpis z `_pending` przy najbliższym `_persistNow()` (upsert, `keepMtime=true`).
        if (this._rows.delete(path)) this._metaDirty = true;
        this._pending.delete(path);
        this._bumpGen();
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
     * Surowe wołanie embeddera z twardym kontraktem:
     * N wejść → N wyników albo RZUT. Rzucony błąd niesie `kind`, żeby wołacz wiedział,
     * czy ponawiać (patrz `embedFailureKind`).
     */
    async _embedTexts(texts: string[], expected: number): Promise<Array<number[] | null>> {
        try {
            const vectors = await this.embedder.embedBatch(texts);
            // Padnięty provider bywa zwraca tablicę (np. samych nulli) - samo `Array.isArray`
            // nie wystarcza, więc długość musi się zgadzać z liczbą wejść (sprawdzenie niżej).
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
     * Jeden plik z rozliczaniem TRWAŁYCH awarii. Awarię przejściową propaguje wyżej
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
     * notatkę) plik po pliku - jeden zatruty plik nie może zabrać pozostałych piętnastu.
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
                // Zimny start providera (Ollama ładująca model) potrafi przekroczyć sufit
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

    // ─────────────────────────── Persystencja (format v2) ───────────────────────────
    //
    // Trwałość jest własnością `VaultIndexer`, nie Oramy (D2): na dysku nie ma nic pochodnego,
    // BM25/docs-store/sorting są odtwarzane w pamięci z trójek (path, mtime, wektor). Segmenty
    // są NIEZMIENNE (D3): zapis przyrostowy = nowy segment, meta jest PUNKTEM COMMITU — kolejność
    // zapisu jest zawsze segment → meta, nigdy odwrotnie.

    _legacyDbPath(): string { return `${this.indexDir}/vault-index.json`; }
    _metaPath(): string { return `${this.indexDir}/vault-index.meta.json`; }
    _segmentPath(file: string): string { return `${this.indexDir}/${file}`; }

    async _tryRestore(): Promise<boolean> {
        if (!(await this._exists(this._metaPath()))) {
            this._nextSeq = await this._resolveNextSeqOnFallback(null);
            return false;
        }

        let metaText: string;
        let raw: unknown;
        try {
            metaText = await this.vault.adapter.read(this._metaPath());
            raw = JSON.parse(metaText);
        } catch (e) {
            // F4.4: meta nieczytelna (I/O albo JSON.parse) NIE jest cichym `false` - user musi
            // wiedzieć, że indeks wraca do pełnego rebuildu.
            this.logger.warn('VaultIndexer', `vault-index.meta.json nieczytelna: ${msg(e)} — pełny rebuild`);
            this._notify({ kind: 'index_corrupt' });
            this._nextSeq = await this._resolveNextSeqOnFallback(null);
            return false;
        }

        const v2 = parseIndexMetaV2(raw);
        if (v2) {
            const ok = await this._restoreFromV2(v2);
            // F2: restore v2 pada z RÓŻNYCH powodów (model/dims/segment uszkodzony) już PO tym,
            // jak `next_seq` z meta jest znany - użyj go jako dolnej granicy zamiast zerować się
            // do domyślnego `1` (co pozwoliłoby kolejnemu zapisowi NADPISAĆ segment, na który ta
            // sama (nieużyta jeszcze) meta nadal formalnie mogłaby wskazywać).
            if (!ok) this._nextSeq = await this._resolveNextSeqOnFallback(v2.next_seq);
            return ok;
        }

        const v1 = parseIndexMetaV1(raw);
        if (v1) {
            const ok = await this._migrateV1(v1, metaText);
            if (!ok) this._nextSeq = await this._resolveNextSeqOnFallback(null);
            return ok;
        }

        this.logger.warn('VaultIndexer', 'vault-index.meta.json nieczytelna — pełny rebuild');
        this._notify({ kind: 'index_corrupt' });
        this._nextSeq = await this._resolveNextSeqOnFallback(null);
        return false;
    }

    /**
     * F2: ustala `_nextSeq` po nieudanym/częściowym restore tak, żeby ŻADEN kolejny zapis nie
     * nadpisał segmentu, który realnie leży na dysku - nawet gdy meta jest nieczytelna/niespójna
     * i jedynym śladem są nazwy plików (`adapter.list()`). `metaNextSeq` to `next_seq` z meta,
     * jeśli udało się ją sparsować mimo że restore i tak padł (np. `model_changed`); `null` gdy
     * meta nie istnieje/jest nieczytelna/to v1.
     */
    private async _resolveNextSeqOnFallback(metaNextSeq: number | null): Promise<number> {
        let maxSeq = metaNextSeq !== null ? metaNextSeq - 1 : 0;
        if (this.vault.adapter.list) {
            try {
                const listing = await this.vault.adapter.list(this.indexDir);
                const fromDisk = maxSegmentSeq(listing.files || []);
                if (fromDisk > maxSeq) maxSeq = fromDisk;
            } catch { /* best effort — brak listingu nie może zablokować startu */ }
        }
        return maxSeq + 1;
    }

    /** Odtwarza `db`/`_mtimes`/`_rows`/`_segments`/`_nextSeq` z meta v2 + segmentów binarnych. */
    private async _restoreFromV2(meta: IndexMetaV2): Promise<boolean> {
        const wantedModelKey = this.modelKey || '';
        if (meta.model_key !== wantedModelKey) {
            this.logger.info('VaultIndexer', `model zmieniony (${meta.model_key} → ${wantedModelKey}) — pełny rebuild`);
            this._notify({ kind: 'model_changed', from: meta.model_key || null, to: wantedModelKey });
            return false;
        }
        const dims = this._normalizeDims(meta.dims);
        if (!dims) return false;

        const segCache = new Map<number, ReturnType<typeof decodeSegment>>();
        for (let i = 0; i < meta.segments.length; i++) {
            const seg = meta.segments[i];
            let buf: ArrayBuffer;
            try {
                buf = await this.vault.adapter.readBinary(this._segmentPath(seg.file));
            } catch (e) {
                this.logger.warn('VaultIndexer', `odczyt segmentu ${seg.file} padł: ${msg(e)}`);
                this._notify({ kind: 'index_corrupt' });
                return false;
            }
            const decoded = decodeSegment(buf, dims);
            if (!decoded || decoded.rows !== seg.rows) {
                this.logger.warn('VaultIndexer', `segment ${seg.file} uszkodzony — pełny rebuild`);
                this._notify({ kind: 'index_corrupt' });
                return false;
            }
            segCache.set(i, decoded);
        }

        const db = await createEmbeddingDb(this._schema(dims));
        for (const [path, [segIdx, rowIdx]] of Object.entries(meta.rows)) {
            const seg = segCache.get(segIdx);
            const mtime = meta.mtimes[path];
            if (!seg || mtime === undefined) {
                // Nie powinno się zdarzyć po `parseIndexMetaV2` (spójność już zweryfikowana),
                // ale segment mógł zniknąć MIĘDZY parsowaniem meta a odczytem z dysku.
                this.logger.warn('VaultIndexer', `wiersz ${path} bez segmentu/mtime — pełny rebuild`);
                this._notify({ kind: 'index_corrupt' });
                return false;
            }
            await insertVectorLean(db, this._makeDoc({ path, mtime }, Array.from(seg.at(rowIdx))));
        }

        this.db = db;
        this.dims = dims;
        this._mtimes = new Map(Object.entries(meta.mtimes));
        this._rows = new Map(Object.entries(meta.rows));
        this._segments = meta.segments.map(s => ({ ...s }));
        this._nextSeq = meta.next_seq;
        this._pending = new Map();
        this._metaDirty = false;
        this._bumpGen();

        await this._cleanupOrphanSegments();
        return true;
    }

    /**
     * Migracja v1 → v2 z pancerzem (D5): stary `vault-index.json` NIE jest kasowany, dopóki
     * nowe pliki nie są zapisane I ODCZYTANE z powrotem z sukcesem. Każdy pad kończy się
     * `notify('migration_failed')` i pełnym rebuildem — stary plik zostaje nietknięty.
     *
     * @param metaV1Text surowy tekst `vault-index.meta.json` PRZED migracją (F4.3) — jeśli
     *   cokolwiek pada PO nadpisaniu meta v2 (dziś: weryfikacja odczytu), przywracamy go na
     *   dysk best-effort, żeby migracja mogła się powtórzyć przy następnym starcie zamiast
     *   zastać na dysku na wpół zapisaną meta v2 obok nietkniętego pliku v1.
     */
    private async _migrateV1(metaV1: IndexMetaV1, metaV1Text: string): Promise<boolean> {
        const wantedModelKey = this.modelKey || '';
        if (metaV1.model_key !== wantedModelKey) {
            this.logger.info('VaultIndexer', `model zmieniony w v1 (${metaV1.model_key} → ${wantedModelKey}) — pełny rebuild`);
            this._notify({ kind: 'model_changed', from: metaV1.model_key, to: wantedModelKey });
            return false;
        }
        const dims = this._normalizeDims(metaV1.dims);
        if (!dims) return false;

        const v1Path = this._legacyDbPath();
        if (!(await this._exists(v1Path))) return false;

        let text: string;
        let raw: unknown;
        try {
            text = await this.vault.adapter.read(v1Path);
            raw = JSON.parse(text);
        } catch (e) {
            this._migrationFailed('v1_unreadable', msg(e));
            return false;
        }

        const extracted = extractV1Vectors(raw);
        if (!extracted) {
            this._migrationFailed('v1_malformed');
            return false;
        }
        if (extracted.dims !== dims) {
            this._migrationFailed('dims_mismatch');
            return false;
        }

        let db: AnyOrama;
        try {
            db = await createEmbeddingDb(this._schema(dims));
            for (const doc of extracted.docs) {
                await insertVectorLean(db, this._makeDoc({ path: doc.path, mtime: doc.mtime }, doc.vector));
            }
        } catch (e) {
            this._migrationFailed('v1_malformed', msg(e));
            return false;
        }

        const sorted = [...extracted.docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const buf = encodeSegment(sorted.map(d => Float32Array.from(d.vector)), dims);
        // F2: retry po częściowo nieudanej migracji nie może reużyć numeru segmentu, który
        // poprzednia próba zdążyła zapisać na dysk (orphan) - `_nextSeq` jest ustalane z
        // dysku, nigdy z zaszytej stałej `1`.
        this._nextSeq = await this._resolveNextSeqOnFallback(null);
        const segName = segmentFileName(this._nextSeq);
        const nextSeqAfter = this._nextSeq + 1;

        await this._ensureDir();
        try {
            await this.vault.adapter.writeBinary(this._segmentPath(segName), buf);
        } catch (e) {
            this._migrationFailed('segment_write', msg(e));
            return false;
        }

        const rows: Record<string, RowRef> = {};
        sorted.forEach((d, i) => { rows[d.path] = [0, i]; });
        // F4.3: dokument z wektorem, którego ścieżki NIE MA w mtimes v1 (niespójność sprzed tej
        // naprawy - "duch" w dumpie Oramy bez odpowiednika w sidecarze), dostaje mtime z SAMEGO
        // dokumentu zamiast zniknąć z `mtimes` - inaczej `rows` bez `mtimes` odrzuciłby tę samą
        // meta jako `index_corrupt` przy najbliższym restarcie (parseIndexMetaV2, F2.4).
        const mtimes: Record<string, number> = { ...metaV1.mtimes };
        for (const d of sorted) if (!(d.path in mtimes)) mtimes[d.path] = d.mtime;
        const meta: IndexMetaV2 = {
            version: 2,
            model_key: wantedModelKey,
            dims,
            updated_at: this.now(),
            next_seq: nextSeqAfter,
            segments: [{ file: segName, rows: sorted.length }],
            mtimes,
            rows,
        };
        try {
            await this.vault.adapter.write(this._metaPath(), JSON.stringify(meta));
        } catch (e) {
            this._migrationFailed('meta_write', msg(e));
            return false;
        }

        if (!(await this._verifyMigration(segName, dims, sorted))) {
            // Meta v2 jest już na dysku, ale nie przeszła odczytu zwrotnego - przywracamy tekst
            // v1 (best effort), żeby migracja mogła się powtórzyć od zera przy następnym starcie
            // zamiast zastać niespójną meta obok wciąż nietkniętego pliku v1.
            try { await this.vault.adapter.write(this._metaPath(), metaV1Text); }
            catch (e) { this.logger.warn('VaultIndexer', `przywrócenie meta v1 po nieudanej weryfikacji padło: ${msg(e)}`); }
            this._migrationFailed('verify_failed');
            return false;
        }

        // Sukces potwierdzony odczytem — dopiero teraz stary plik przestaje być potrzebny.
        try { await this.vault.adapter.remove?.(v1Path); }
        catch (e) { this.logger.warn('VaultIndexer', `usunięcie starego pliku v1 padło (migracja i tak udana): ${msg(e)}`); }

        this.db = db;
        this.dims = dims;
        this._mtimes = new Map(Object.entries(meta.mtimes));
        this._rows = new Map(Object.entries(rows));
        this._segments = meta.segments.map(s => ({ ...s }));
        this._nextSeq = meta.next_seq;
        this._pending = new Map();
        this._metaDirty = false;
        this._bumpGen();

        const toBytes = buf.byteLength + JSON.stringify(meta).length;
        this._notify({ kind: 'migrated', fromBytes: text.length, toBytes });
        this.logger.info('VaultIndexer', `migracja v1→v2: ${text.length} B → ${toBytes} B, ${sorted.length} wektorów`);
        return true;
    }

    /** Krok 6 migracji: odczytaj z powrotem to, co właśnie zapisano, i porównaj z żywym stanem. */
    private async _verifyMigration(
        segName: string,
        dims: number,
        sorted: Array<{ path: string; mtime: number; vector: number[] }>,
    ): Promise<boolean> {
        let buf: ArrayBuffer;
        try { buf = await this.vault.adapter.readBinary(this._segmentPath(segName)); }
        catch { return false; }
        const decoded = decodeSegment(buf, dims);
        if (!decoded || decoded.rows !== sorted.length) return false;

        const checkIdx = new Set([0, Math.floor(sorted.length / 2), sorted.length - 1].filter(i => i >= 0 && i < sorted.length));
        for (const i of checkIdx) {
            const row = decoded.at(i);
            const expected = sorted[i].vector;
            for (let d = 0; d < dims; d++) {
                if (row[d] !== Math.fround(expected[d] ?? 0)) return false;
            }
        }

        let rawMeta: unknown;
        try { rawMeta = JSON.parse(await this.vault.adapter.read(this._metaPath())); }
        catch { return false; }
        const parsed = parseIndexMetaV2(rawMeta);
        if (!parsed) return false;
        return Object.keys(parsed.rows).length === sorted.length;
    }

    private _migrationFailed(reason: MigrationFailReason, detail?: string): void {
        this.logger.warn('VaultIndexer', `migracja v1→v2 nieudana: ${reason}${detail ? ` (${detail})` : ''} — pełny rebuild`);
        this._notify({ kind: 'migration_failed', reason, detail });
    }

    /** Segmenty na dysku spoza `_segments` znane (sierota po przerwanym persist, D3). */
    private async _cleanupOrphanSegments(): Promise<void> {
        if (!this.vault.adapter.list) return;
        let listing: { files: string[]; folders: string[] };
        try { listing = await this.vault.adapter.list(this.indexDir); }
        catch { return; }
        const known = new Set(this._segments.map(s => s.file));
        for (const filePath of listing.files || []) {
            const norm = String(filePath).replace(/\\/g, '/');
            const base = norm.split('/').pop() || norm;
            if (!isSegmentFileName(base) || known.has(base)) continue;
            // F4.5: kasuj ZAWSZE `${indexDir}/${base}`, niezależnie od tego, czy `list()` oddał
            // pełną ścieżkę czy gołą nazwę - `remove(norm)` z gołą nazwą próbowałby skasować
            // plik w ROOCIE vaulta (błędna ścieżka), nie w katalogu indeksu.
            const target = this._segmentPath(base);
            try { await this.vault.adapter.remove?.(target); }
            catch (e) { this.logger.warn('VaultIndexer', `sprzątanie sieroty ${target} padło: ${msg(e)}`); }
        }
    }

    /** Balast po udanej migracji/rebuildzie — usuwany best-effort, nigdy blokująco. */
    private async _cleanupLegacyV1IfPresent(): Promise<void> {
        const path = this._legacyDbPath();
        if (!(await this._exists(path))) return;
        try { await this.vault.adapter.remove?.(path); }
        catch (e) { this.logger.warn('VaultIndexer', `usunięcie starego pliku v1 padło: ${msg(e)}`); }
    }

    /**
     * `mtimes`/`rows` POMIJAJĄ każdą ścieżkę aktualnie w `_pending` (F1.4): jej wektor NIE jest
     * jeszcze na dysku (persist trwa gdzie indziej / dopiero się zaplanuje), więc meta pisana
     * TERAZ nie może udawać, że go ma. Skutek pominięcia mtime jest ZAMIERZONY i bezpieczny:
     * `_resync` po restarcie zobaczy `prev===undefined` dla tej ścieżki i po prostu ją
     * re-embeduje - to tańsze niż ryzyko `rows` bez odpowiadającego `mtimes` (parseIndexMetaV2
     * odrzuciłoby taką meta jako `index_corrupt`, F2.4).
     */
    _buildMetaV2(): IndexMetaV2 {
        const mtimes: Record<string, number> = {};
        for (const [path, mtime] of this._mtimes) {
            if (this._pending.has(path)) continue;
            mtimes[path] = mtime;
        }
        const rows: Record<string, RowRef> = {};
        for (const [path, ref] of this._rows) {
            if (this._pending.has(path)) continue;
            rows[path] = ref;
        }
        return {
            version: 2,
            model_key: this.modelKey || '',
            dims: this.dims as number,
            updated_at: this.now(),
            next_seq: this._nextSeq,
            segments: this._segments.map(s => ({ ...s })),
            mtimes,
            rows,
        };
    }

    private async _writeMeta(): Promise<boolean> {
        try {
            await this.vault.adapter.write(this._metaPath(), JSON.stringify(this._buildMetaV2()));
            return true;
        } catch (e) {
            this.logger.warn('VaultIndexer', `zapis meta padł: ${msg(e)}`);
            return false;
        }
    }

    /**
     * Zapis meta + decyzja o `_metaDirty` (F1.4): `_buildMetaV2()` czyta stan SYNCHRONICZNIE
     * (przed pierwszym `await` w `_writeMeta`), więc generacja sprzed wywołania jest dokładnie
     * generacją w chwili budowy JSON-a. Jeśli po `await write()` generacja się ZMIENIŁA (coś
     * zmutowało `_pending`/`_mtimes`/`_rows` w tym oknie - równoległy flush, delete, kompakcja
     * gdzie indziej) ALBO `_pending` nie jest puste, meta na dysku może nie nieść najświeższego
     * stanu - `_metaDirty` MUSI zostać `true`, żeby następny persist dogonił różnicę.
     */
    private async _writeMetaTracked(): Promise<boolean> {
        const genBefore = this._gen;
        const ok = await this._writeMeta();
        if (!ok) return false; // meta zostaje "dirty" (niezmieniona) - segment (jeśli był) jest sierotą do następnego udanego persist
        this._metaDirty = !(this._gen === genBefore && this._pending.size === 0);
        return true;
    }

    /**
     * Ścieżka zwykła (bez kompakcji): jeden NOWY segment z wierszami oczekującymi + meta.
     *
     * Migawka `_pending` (F1.3) - te same referencje `Float32Array` co w mapie live, nie kopie -
     * jest wzięta PRZED `await writeBinary`, więc flush w oknie zapisu może dołożyć NOWSZY
     * wektor pod tą samą ścieżką bez obawy o wyścig: po sukcesie usuwamy z `_pending` TYLKO
     * wpisy, których referencja wciąż wskazuje na wartość z migawki (`get(path) === vec`) - jeśli
     * ktoś nadpisał ją nowszą w trakcie `await`, ten nowszy wpis ZOSTAJE i pójdzie w NASTĘPNYM
     * persiście. `_rows` dostaje nowy wiersz TYLKO dla ścieżek, które nadal istnieją w `_mtimes`
     * (nie zostały usunięte w tym samym oknie) - inaczej wiersz byłby martwy od chwili zapisu.
     */
    private async _persistNewSegment(): Promise<boolean> {
        const snap = [...this._pending.entries()];
        const buf = encodeSegment(snap.map(([, v]) => v), this.dims as number);
        const name = segmentFileName(this._nextSeq);
        try {
            await this.vault.adapter.writeBinary(this._segmentPath(name), buf);
        } catch (e) {
            this.logger.warn('VaultIndexer', `zapis segmentu ${name} padł: ${msg(e)}`);
            return false; // stan (_pending/_nextSeq) NIETKNIĘTY - następna próba nadpisze ten sam częściowy plik
        }
        const segIdx = this._segments.length;
        this._segments.push({ file: name, rows: snap.length });
        snap.forEach(([path, vec], i) => {
            if (this._mtimes.has(path)) this._rows.set(path, [segIdx, i]);
            if (this._pending.get(path) === vec) this._pending.delete(path);
        });
        this._nextSeq++;
        return true;
    }

    /**
     * Kompakcja (D4): czyta segmenty z dysku (cache per segment na czas wywołania) + wiersze
     * oczekujące, pisze JEDEN nowy segment bazowy, potem meta, potem kasuje stare - w tej
     * kolejności. Segment uszkodzony przy odczycie przerywa kompakcję (warn) i spada na
     * ścieżkę zwykłą zamiast gubić dane.
     *
     * Migawki `_rows`/`_pending` (F1.5) wzięte PRZED pierwszym `await readBinary` - kompakcja
     * może trwać przez wiele odczytów segmentów, a w tym oknie flush/delete gdzie indziej dalej
     * mutuje mapy LIVE. Po zapisie nowego segmentu bazowego: `newRows` budowane z pozycji w
     * zakodowanym buforze (dokładnie to, co naprawdę leży w pliku), ale wpis trafia do `_rows`
     * TYLKO gdy ścieżka nadal istnieje w AKTUALNYCH `_mtimes` (nie została usunięta w oknie
     * odczytu/zapisu) - martwe dane zostają w pliku jako nieszkodliwy balast, po prostu bez
     * referencji. Pending czyszczone jak w `_persistNewSegment` (referencja z migawki, nie
     * cała mapa) - nowe wpisy dołożone w oknie kompakcji ZOSTAJĄ w `_pending` i pójdą do
     * następnego segmentu delta.
     */
    private async _persistCompact(): Promise<void> {
        const segCache = new Map<number, ReturnType<typeof decodeSegment>>();
        const rowsSnap = new Map(this._rows);
        const pendingSnap = new Map(this._pending);
        const liveEntries: Array<[string, Float32Array]> = [];
        try {
            for (const [path, [segIdx, rowIdx]] of rowsSnap) {
                if (pendingSnap.has(path)) continue; // pending wygrywa - świeższa wartość
                let decoded = segCache.get(segIdx);
                if (decoded === undefined) {
                    const seg = this._segments[segIdx];
                    const buf = await this.vault.adapter.readBinary(this._segmentPath(seg.file));
                    decoded = decodeSegment(buf, this.dims as number);
                    segCache.set(segIdx, decoded);
                }
                if (!decoded) throw new Error(`segment ${this._segments[segIdx]?.file ?? segIdx} uszkodzony`);
                // Widok (subarray), bez dodatkowej kopii (F4.6) - `encodeSegment` niżej kopiuje
                // wartości do bufora wyjściowego RAZ; podwójne kopiowanie byłoby zbędne.
                liveEntries.push([path, decoded.at(rowIdx)]);
            }
        } catch (e) {
            this.logger.warn('VaultIndexer', `kompakcja przerwana (${msg(e)}) — zapis zwykły zamiast niej`);
            if (!(await this._persistNewSegment())) return;
            await this._writeMetaTracked();
            await this._cleanupLegacyV1IfPresent();
            return;
        }
        for (const [path, vec] of pendingSnap) liveEntries.push([path, vec]);
        liveEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

        const buf = encodeSegment(liveEntries.map(([, v]) => v), this.dims as number);
        const name = segmentFileName(this._nextSeq);
        try {
            await this.vault.adapter.writeBinary(this._segmentPath(name), buf);
        } catch (e) {
            this.logger.warn('VaultIndexer', `zapis skompaktowanego segmentu padł: ${msg(e)}`);
            return;
        }
        const oldSegments = this._segments;
        this._segments = [{ file: name, rows: liveEntries.length }];
        const newRows = new Map<string, RowRef>();
        liveEntries.forEach(([path], i) => {
            if (this._mtimes.has(path)) newRows.set(path, [0, i]);
        });
        this._rows = newRows;
        this._nextSeq++;
        for (const [path, vec] of pendingSnap) {
            if (this._pending.get(path) === vec) this._pending.delete(path);
        }

        if (!(await this._writeMetaTracked())) return; // orphan sprząta następny udany restore

        for (const seg of oldSegments) {
            try { await this.vault.adapter.remove?.(this._segmentPath(seg.file)); }
            catch (e) { this.logger.warn('VaultIndexer', `usunięcie starego segmentu ${seg.file} padło: ${msg(e)}`); }
        }
        await this._cleanupLegacyV1IfPresent();
    }

    private async _persistNowInner(): Promise<void> {
        if (this._pending.size === 0 && !this._metaDirty) return;
        if (!this.db || this.dims == null) return;
        await this._ensureDir();

        const liveRowPaths = new Set([...this._rows.keys(), ...this._pending.keys()]);
        const compact = planCompaction({ segments: this._segments, liveRows: liveRowPaths.size });
        if (compact) {
            await this._persistCompact();
            return;
        }

        if (this._pending.size > 0) {
            if (!(await this._persistNewSegment())) return; // stan nietknięty, retry przy następnym persist
        }
        if (!(await this._writeMetaTracked())) return; // segment (jeśli był) zostaje sierotą do następnego udanego persist
        await this._cleanupLegacyV1IfPresent();
    }

    /**
     * Punkt wejścia PUBLICZNY (F1.1) - dołącza `_persistNowInner()` na koniec łańcucha
     * `_persistChain` zamiast wołać go bezpośrednio. Dwa równoległe `_persistNow()` (timer +
     * koniec skanu/resyncu, rebuild wołany z flusha...) NIGDY nie wykonują ciała persystu naraz;
     * drugi zaczyna dopiero, gdy pierwszy (i jego `await`y) się skończy. `.catch(() => {})` jest
     * SIATKĄ ASEKURACYJNĄ - `_persistNowInner` i tak łapie każdy błąd I/O u siebie (warn +
     * bezpieczny powrót) i nie powinien nigdy rzucić, ale gdyby jednak rzucił, ma nie zerwać
     * łańcucha dla WSZYSTKICH przyszłych wołających.
     */
    async _persistNow(): Promise<void> {
        const link = this._persistChain.then(() => this._persistNowInner()).catch(() => {});
        this._persistChain = link;
        return link;
    }

    _schedulePersist(): void {
        if (this._persistTimer) _nodeSafeClearTimeout(this._persistTimer);
        this._persistTimer = _nodeSafeSetTimeout(() => {
            this._persistTimer = null;
            this._persistNow().catch(e => this.logger.warn('VaultIndexer', `persist error: ${msg(e)}`));
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

    /**
     * HARD_EXCLUDES + the real config dir from live `Vault#configDir` (user-configurable,
     * nazwa nie jest nigdzie w tym pliku zapisana).
     *
     * Przy okazji zapamiętuje, CZY nazwa była znana - `_isExcluded` robi z tego fail-closed.
     * Obie rzeczy liczą się z tej samej migawki, więc nie da się dostać stanu „fail-closed
     * wyłączony, a configDir mimo to poza listą".
     */
    _hardExcludes(): string[] {
        if (!this._hardEx) {
            const cd = String(this.vault?.configDir || '').replace(/\\/g, '/').replace(/\/$/, '');
            this._configDirKnown = cd.length > 0;
            this._hardEx = cd && !HARD_EXCLUDES.includes(cd) ? [...HARD_EXCLUDES, cd] : HARD_EXCLUDES;
        }
        return this._hardEx;
    }

    /**
     * To jest bramka ZAKAZU, więc porównuje BEZ rozróżniania
     * wielkości liter - tak samo jak `AccessGuard._isNoGo` i `isProtectedPath`.
     *
     * Porównanie bajt w bajt nie wystarcza: wpisy No-Go i folder artefaktów user wpisuje
     * RĘCZNIE w ustawieniach. Na Windows i macOS wystarczyłoby, żeby wpisał `Prywatne`, a
     * folder na dysku nazywał się `prywatne` - treść z zakazanego folderu wchodziłaby do
     * indeksu semantycznego i wracała userowi w wynikach `search mode=semantic`. Zakaz ma
     * łapać za dużo, nie za mało (pełne uzasadnienie: `core/security/AccessGuard.ts`,
     * `_normalizeForDenyCompare`).
     *
     * Świadomie BEZ importu `AccessGuard`: indekser trzyma zero zależności od `core/`,
     * wszystko dostaje wstrzyknięte (patrz nagłówek pliku) - dlatego ta sama reguła jest
     * tu wyliczona lokalnie, a nie zawołana.
     *
     * FAIL-CLOSED przy NIEZNANYM folderze konfiguracji (`vault.configDir` pusty - harness,
     * testy, wstrzyknięty obiekt bez tego pola): nie wiem, gdzie jest konfiguracja Obsidiana,
     * więc do indeksu nie wchodzi ŻADEN ukryty folder (pierwszy segment od kropki).
     *
     * Gdy configDir jest ZNANY, zostaje zachowanie dotychczasowe: wykluczamy `HARD_EXCLUDES`
     * + ten jeden folder, a inne ukryte foldery są zwykłymi folderami. To nie jest furtka -
     * `Vault#getMarkdownFiles()` (jedyne źródło skanu, `_listVaultMarkdown`) ukrytych folderów
     * i tak nie zwraca, a zgadywanie ich nazw kosztowałoby wykluczenia, których user nie prosił.
     */
    _isExcluded(norm: string): boolean {
        const cel = norm.normalize('NFC').toLowerCase();
        const wpis = (v: string): string =>
            String(v || '').replace(/\\/g, '/').replace(/\/$/, '').normalize('NFC').toLowerCase();

        const hard = this._hardExcludes(); // ustawia też `_configDirKnown` (ta sama migawka)
        if (!this._configDirKnown && cel.split('/')[0].startsWith('.')) return true;

        for (const ex of hard) {
            const e = wpis(ex);
            if (e && (cel === e || cel.startsWith(e + '/'))) return true;
        }
        for (const ng of this._getNoGoFolders()) {
            const n = wpis(ng);
            if (!n) continue;
            if (cel === n || cel.startsWith(n + '/')) return true;
        }
        // Folder artefaktów (gdy indeksowanie wyłączone).
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
