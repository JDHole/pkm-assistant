import test from 'ava';
import { save } from '@orama/orama';
import { VaultIndexer } from './VaultIndexer.js';
import type { EmbedderFacade, IndexerPluginLike, IndexerNotice, VaultFileLike, VaultLike } from './VaultIndexer.js';
import { createEmbeddingDb, insertVectorLean, searchVectorTopK, countDocs } from './orama_engine.js';
import { decodeSegment, isSegmentFileName, planCompaction } from './indexStore.js';
import type { IndexMetaV2 } from './indexStore.js';

/** Plik fake-vaulta: treść + mtime. */
interface FakeFile { content: string; mtime: number }
type FakeFiles = Map<string, FakeFile>;
/** Segmenty (format v2) są binarne, meta jest tekstowa — jeden store, dwa kształty wartości. */
type FakeStore = Map<string, string | ArrayBuffer>;

/** Embedder testowy — liczy wywołania, żeby asertować brak re-embedu. */
interface FakeEmbedder extends EmbedderFacade {
    _calls: { embedBatch: number; texts: string[] };
    embed(text: string): Promise<number[] | null>;
}

/** Odczyt tekstowego wpisu ze store (meta/legacy v1) — rzuca, jeśli wpis jest binarny. */
function readText(store: FakeStore, path: string): string {
    const v = store.get(path);
    if (v === undefined) throw new Error('ENOENT ' + path);
    if (typeof v !== 'string') throw new Error('not a text file: ' + path);
    return v;
}

function readMetaV2(store: FakeStore, indexDir = '.pkm-assistant/index'): IndexMetaV2 {
    return JSON.parse(readText(store, `${indexDir}/vault-index.meta.json`)) as IndexMetaV2;
}

/** Opcje dodatkowe dla `makeVault` - kształt listingu (F4.5) + rejestr wywołań `remove()`. */
interface MakeVaultOpts {
    /** 'full' (domyślnie, jak dziś) - `list()` oddaje pełne ścieżki (klucze store). 'bare' -
     *  same nazwy plików (drugi realny kształt `DataAdapter.list()`, zależnie od implementacji). */
    listShape?: 'full' | 'bare';
    /** Ścieżki, z jakimi realnie wywołano `adapter.remove()` - do asercji F4.5. */
    removedPaths?: string[];
}

// ── Fake vault: content files w `files`, persystencja indeksu w `store` ──
function makeVault(files: FakeFiles, store: FakeStore = new Map(), opts: MakeVaultOpts = {}): { vault: VaultLike; store: FakeStore; files: FakeFiles } {
    const adapter = {
        async read(path: string) {
            if (files.has(path)) return files.get(path)!.content;
            return readText(store, path);
        },
        async write(path: string, data: string) { store.set(path, data); },
        async readBinary(path: string) {
            const v = store.get(path);
            if (v === undefined) throw new Error('ENOENT ' + path);
            if (typeof v === 'string') throw new Error('not binary: ' + path);
            return v;
        },
        async writeBinary(path: string, data: ArrayBuffer) { store.set(path, data); },
        async exists(path: string) { return files.has(path) || store.has(path); },
        async mkdir() { /* noop */ },
        async stat(path: string) { return files.has(path) ? { mtime: files.get(path)!.mtime } : null; },
        async remove(path: string) { opts.removedPaths?.push(path); store.delete(path); },
        async list(path: string) {
            const prefix = path.replace(/\/$/, '') + '/';
            const out: string[] = [];
            for (const key of store.keys()) {
                if (!key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length);
                if (rest.includes('/')) continue;
                out.push(opts.listShape === 'bare' ? rest : key);
            }
            return { files: out, folders: [] };
        },
    };
    const vault: VaultLike = {
        getMarkdownFiles() {
            return [...files.entries()].map(([path, f]) => ({ path, stat: { mtime: f.mtime } }));
        },
        // Treść zwykłych notatek idzie przez Vault API (nie adapter).
        getAbstractFileByPath(path: string) {
            const f = files.get(path);
            return f ? { path, stat: { mtime: f.mtime } } : null;
        },
        async cachedRead(file: VaultFileLike) {
            const f = files.get(file?.path);
            if (!f) throw new Error('ENOENT ' + file?.path);
            return f.content;
        },
        on() { return {}; },
        offref() { /* noop */ },
        adapter,
    };
    return { vault, store, files };
}

// ── Fake embedder: deterministyczne wektory po kategorii słów kluczowych ──
// "auto"/"samochód"/"pojazd"/"drog" → [1,0,0]; "kot"/"pies"/"zwierz"/"płot" → [0,1,0]; reszta → [0,0,1]
function makeEmbedder({ ready = true, modelKey = 'openai:text-embedding-3-small', dims = null }: EmbedderOpts = {}): FakeEmbedder {
    const calls: { embedBatch: number; texts: string[] } = { embedBatch: 0, texts: [] };
    const vecFor = (text: string): number[] | null => {
        const s = String(text || '').toLowerCase();
        if (!s.trim()) return null;
        if (/(samoch|auto|pojazd|drog)/.test(s)) return [1, 0, 0];
        if (/(kot|pies|zwierz|płot)/.test(s)) return [0, 1, 0];
        return [0, 0, 1];
    };
    return {
        _calls: calls,
        isReady: () => ready,
        getModelKey: () => modelKey,
        getDims: () => dims,
        async embed(text: string) { return vecFor(text); },
        async embedBatch(texts: string[]) { calls.embedBatch++; calls.texts.push(...texts); return texts.map(vecFor); },
    };
}

/** Opcje fake-embeddera. */
interface EmbedderOpts { ready?: boolean; modelKey?: string; dims?: number | null }

/** Nadpisania fabryki `newIndexer`. */
interface IndexerOverrides {
    files?: FakeFiles;
    store?: FakeStore;
    embedder?: FakeEmbedder;
    embedderOpts?: EmbedderOpts;
    plugin?: IndexerPluginLike;
    isMobile?: boolean;
    noGoFolders?: string[];
    artifactsExclude?: () => string | null;
    now?: () => number;
    debounceMs?: number;
    persistDebounceMs?: number;
    scanRetryMs?: number;
    batchSize?: number;
    /** Nazwa folderu konfiguracji Obsidiana; pominięta = vault jej NIE zna (fail-closed). */
    configDir?: string;
    /** F4.5: kształt listingu `adapter.list()` - patrz `MakeVaultOpts`. */
    listShape?: 'full' | 'bare';
    /** F4.5: rejestr wywołań `adapter.remove()` (wypełniany przez `makeVault`). */
    removedPaths?: string[];
}

function makePlugin(): IndexerPluginLike {
    return { oramaDb: null, registerEvent() {}, register() {} };
}

function baseFiles(): FakeFiles {
    return new Map<string, FakeFile>([
        ['car.md', { content: 'Szybki samochód mknie po drodze', mtime: 100 }],
        ['notes/cat.md', { content: 'Mały kot siedzi na płocie', mtime: 100 }],
        ['sky.md', { content: 'Bezchmurne błękitne niebo nad górami', mtime: 100 }],
    ]);
}

function newIndexer(overrides: IndexerOverrides = {}) {
    const files = overrides.files || baseFiles();
    const store = overrides.store || new Map();
    const { vault } = makeVault(files, store, { listShape: overrides.listShape, removedPaths: overrides.removedPaths });
    if (overrides.configDir !== undefined) vault.configDir = overrides.configDir;
    const embedder = overrides.embedder || makeEmbedder(overrides.embedderOpts);
    const plugin = overrides.plugin || makePlugin();
    const notices: IndexerNotice[] = [];
    const indexer = new VaultIndexer({
        plugin,
        vault,
        embedder,
        isMobile: !!overrides.isMobile,
        noGoFolders: overrides.noGoFolders || [],
        artifactsExclude: overrides.artifactsExclude,
        debounceMs: overrides.debounceMs ?? 5,
        persistDebounceMs: overrides.persistDebounceMs ?? 5,
        batchSize: overrides.batchSize,
        // Ponowienia porcji natychmiastowe (inaczej każdy test awarii czeka 2 s + 4 s),
        // a automatyczne ponowienie skanu tak dalekie, że nigdy nie wystrzeli w teście
        // (chyba że test jawnie poda krótszy `scanRetryMs`, żeby SAM je zaobserwować).
        embedRetryMs: 1,
        scanRetryMs: overrides.scanRetryMs ?? 60_000,
        now: overrides.now ?? (() => 999),
        notify: (n: IndexerNotice) => notices.push(n),
    });
    return { indexer, files, store, vault, embedder, plugin, notices };
}

/** Zestaw plików dla obu wariantów testu 1 (z configDirem i bez). */
function plikiZUkrytymi(): Map<string, FakeFile> {
    return new Map<string, FakeFile>([
        ['car.md', { content: 'samochód', mtime: 1 }],
        ['notes/cat.md', { content: 'kot', mtime: 1 }],
        ['sky.md', { content: 'niebo', mtime: 1 }],
        ['.pkm-assistant/agents/jaskier/memory/brain.md', { content: 'sekret pamięci', mtime: 1 }],
        ['.obsidian/workspace.md', { content: 'config', mtime: 1 }],
        ['.trash/old.md', { content: 'trash', mtime: 1 }],
        ['Prywatne/dziennik.md', { content: 'prywatne', mtime: 1 }],
    ]);
}

// 1. Pełny skan BEZ znanego configDira: wszystkie .md poza wykluczeniami; .pkm-assistant NIGDY.
// Nazwa folderu konfiguracji nie jest nigdzie wpisana na sztywno (`HARD_EXCLUDES` to
// `.pkm-assistant` + `.trash`), więc gdy vault jej nie poda, `_isExcluded` idzie fail-closed:
// do indeksu nie wchodzi ŻADEN ukryty folder.
test('full scan (configDir nieznany): fail-closed wycina wszystkie ukryte foldery', async t => {
    const { indexer, plugin } = newIndexer({ files: plikiZUkrytymi(), noGoFolders: ['Prywatne'] });
    await indexer.initialize();

    t.is(indexer.getStatus().status, 'ready');
    t.truthy(plugin.oramaDb);

    const indexed = [...indexer._mtimes.keys()].sort();
    t.deepEqual(indexed, ['car.md', 'notes/cat.md', 'sky.md']);
    // Twarda granica bezpieczeństwa: żadna ścieżka .pkm-assistant nie może być w indeksie.
    t.false(indexed.some(p => p.startsWith('.pkm-assistant')));
});

// 1b. Ten sam skan ze ZNANYM, przemianowanym configDirem. Fail-closed się wtedy wyłącza
// i zostaje zachowanie dotychczasowe: `HARD_EXCLUDES` + ten jeden folder. `.obsidian/` staje
// się zwykłym ukrytym folderem - świadomie, bo `Vault#getMarkdownFiles()` ukrytych folderów
// i tak nie zwraca (fake vault w tym teście jest hojniejszy niż Obsidian).
test('full scan (configDir znany): wyklucza configDir, ukrytych folderów nie zgaduje', async t => {
    const files = plikiZUkrytymi();
    files.set('.mojkonfig/workspace.md', { content: 'config', mtime: 1 });
    const { indexer } = newIndexer({ files, noGoFolders: ['Prywatne'], configDir: '.mojkonfig' });
    await indexer.initialize();

    const indexed = [...indexer._mtimes.keys()].sort();
    t.false(indexed.includes('.mojkonfig/workspace.md'), 'przemianowany folder configu wszedł do indeksu');
    t.false(indexed.some(p => p.startsWith('.pkm-assistant')), 'bebechy pluginu weszły do indeksu');
    t.false(indexed.includes('.trash/old.md'), 'kosz wszedł do indeksu');
    t.true(indexed.includes('.obsidian/workspace.md'), 'przy ZNANYM (innym) configDirze `.obsidian` musi być zwykłym folderem — inaczej nazwa siedzi gdzieś na sztywno');
});

// 1a. Wykluczenia to bramka ZAKAZU - bez rozróżniania wielkości liter.
// Wpisy No-Go user pisze ręcznie w ustawieniach, a Windows i macOS wielkości liter nie
// rozróżniają: `Prywatne` w ustawieniach a `prywatne/` na dysku to TEN SAM folder. Case-sensitive
// porównanie wpuściłoby treść z zakazanego folderu do indeksu i do `search mode=semantic`.
test('NoGo i twarde wykluczenia łapią mimo innej wielkości liter', async t => {
    const files = new Map<string, FakeFile>([
        ['car.md', { content: 'samochód', mtime: 1 }],
        ['prywatne/dziennik.md', { content: 'sekret', mtime: 1 }],
        ['PRYWATNE/inny.md', { content: 'sekret', mtime: 1 }],
        ['.Obsidian/workspace.md', { content: 'config', mtime: 1 }],
        ['.TRASH/old.md', { content: 'trash', mtime: 1 }],
        ['.PKM-Assistant/agents/jaskier/memory/brain.md', { content: 'sekret pamięci', mtime: 1 }],
    ]);
    const { indexer } = newIndexer({ files, noGoFolders: ['Prywatne'] });
    await indexer.initialize();

    t.deepEqual([...indexer._mtimes.keys()].sort(), ['car.md']);
});

// 1b. Folder artefaktów wykluczony gdy indexArtifacts OFF, indeksowany gdy ON.
test('excludes the artifacts folder unless indexArtifacts is on', async t => {
    const mk = () => new Map<string, FakeFile>([
        ['notes/cat.md', { content: 'kot', mtime: 1 }],
        ['PKM Assistant/Artefakty/Jaskier/2026-07-23 Plan.md', { content: 'plan porządków', mtime: 1 }],
    ]);

    // OFF: artifactsExclude() zwraca folder → wykluczony.
    const off = newIndexer({ files: mk(), artifactsExclude: () => 'PKM Assistant/Artefakty' });
    await off.indexer.initialize();
    t.true(off.indexer._mtimes.has('notes/cat.md'));
    t.false([...off.indexer._mtimes.keys()].some(p => p.startsWith('PKM Assistant/Artefakty')));

    // ON: artifactsExclude() zwraca null → indeksuj artefakty.
    const on = newIndexer({ files: mk(), artifactsExclude: () => null });
    await on.indexer.initialize();
    t.true([...on.indexer._mtimes.keys()].some(p => p.startsWith('PKM Assistant/Artefakty')));
});

// 2. Semantic smoke (unit): "auto" trafia dokument "samochód" bez wspólnych słów.
test('semantic search finds the vehicle doc for query "auto" (no shared words)', async t => {
    const { indexer, embedder, files } = newIndexer();
    await indexer.initialize();

    const qv = await embedder.embed('auto');
    const res = await searchVectorTopK(indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
    t.false(files.get('car.md')!.content.toLowerCase().includes('auto'));
});

// 3. persist → restore roundtrip: brak re-embedu dla niezmienionych plików.
test('persist then restore does not re-embed unchanged files', async t => {
    const store = new Map();
    const files = baseFiles();

    const a = newIndexer({ files, store });
    await a.indexer.initialize();
    t.true(a.embedder._calls.embedBatch > 0);
    t.true(a.store.has('.pkm-assistant/index/vault-index.000001.vec'), 'pierwszy zapis pisze segment binarny');
    t.true(a.store.has('.pkm-assistant/index/vault-index.meta.json'));
    t.false(a.store.has('.pkm-assistant/index/vault-index.json'), 'v2 nie pisze starego formatu Oramy');

    // Nowy indexer, ten sam store (persystencja) + te same pliki/mtimes, świeży embedder.
    const b = newIndexer({ files: baseFiles(), store });
    await b.indexer.initialize();

    t.is(b.indexer.getStatus().status, 'ready');
    t.is(b.embedder._calls.embedBatch, 0, 'restore powinien pominąć embedding niezmienionych plików');
    t.is(countDocs(b.indexer.db), countDocs(a.indexer.db), 'restore v2 daje ten sam countDocs co przed restartem');

    const qv = await b.embedder.embed('pojazd');
    const res = await searchVectorTopK(b.indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
});

// 4. Resync: zmieniony mtime → re-embed tylko tego pliku; skasowany → znika.
test('resync re-embeds only changed files and drops deleted ones', async t => {
    const store = new Map();
    const a = newIndexer({ files: baseFiles(), store });
    await a.indexer.initialize();

    // Nowy stan vaulta: car.md zmieniony (nowy mtime), sky.md skasowany.
    const changed = new Map<string, FakeFile>([
        ['car.md', { content: 'Nowy samochód elektryczny', mtime: 200 }],
        ['notes/cat.md', { content: 'Mały kot siedzi na płocie', mtime: 100 }],
    ]);
    const b = newIndexer({ files: changed, store });
    await b.indexer.initialize();

    t.is(b.embedder._calls.embedBatch, 1, 'tylko jedna porcja embedowana (zmieniony plik)');
    t.true(b.embedder._calls.texts.some(x => x.includes('Nowy samochód')));
    t.false(b.embedder._calls.texts.some(x => x.includes('kot')), 'niezmieniony plik nie jest re-embedowany');

    t.true(b.indexer._mtimes.has('car.md'));
    t.is(b.indexer._mtimes.get('car.md'), 200);
    t.false(b.indexer._mtimes.has('sky.md'), 'skasowany plik znika z indeksu');

    // Semantycznie sky już nie wypływa jako top dla zapytania "niebo".
    const qv = await b.embedder.embed('niebo bezchmurne');
    const res = await searchVectorTopK(b.indexer.db!, qv!, { k: 5, similarity: 0 });
    t.false(res.hits.map(h => h.document.path).includes('sky.md'));
});

// 5. Zmiana model_key → pełny rebuild (restore odrzucony).
test('changing model_key forces a full rebuild', async t => {
    const store = new Map();
    const a = newIndexer({ files: baseFiles(), store, embedderOpts: { modelKey: 'openai:m1' } });
    await a.indexer.initialize();

    const b = newIndexer({ files: baseFiles(), store, embedderOpts: { modelKey: 'ollama:m2' } });
    await b.indexer.initialize();

    t.true(b.embedder._calls.embedBatch > 0, 'inny model_key → embedujemy od nowa');
    t.is(b.indexer.getStatus().modelKey, 'ollama:m2');
    const meta = readMetaV2(store);
    t.is(meta.model_key, 'ollama:m2');
    t.deepEqual(b.indexer.getStatus().lastNotice, { kind: 'model_changed', from: 'openai:m1', to: 'ollama:m2' });
});

// 6. isMobile → disabled_mobile; brak adaptera → no_provider; w obu oramaDb nie ustawione.
test('mobile disables the indexer and no provider is reported', async t => {
    const mobile = newIndexer({ isMobile: true });
    await mobile.indexer.initialize();
    t.is(mobile.indexer.getStatus().status, 'disabled_mobile');
    t.is(mobile.plugin.oramaDb, null);

    const noProv = newIndexer({ embedder: makeEmbedder({ ready: false }) });
    await noProv.indexer.initialize();
    t.is(noProv.indexer.getStatus().status, 'no_provider');
    t.is(noProv.plugin.oramaDb, null);
});

// 6b. rebuild() na wczesnym wyjściu (no_provider) nie łamie
// istniejącego, żywego indeksu - db/_ready/oramaDb/mtimes zostają NIETKNIĘTE, żeby
// _flushQueue (bramkowane przez _ready) dalej przyjmowało zmiany z hooków po tym,
// jak provider embeddingów wróci.
test('rebuild() bailing out on no_provider leaves the already-ready index intact', async t => {
    const { indexer, embedder, plugin } = newIndexer();
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'ready');
    t.true(indexer._ready);
    const dbBefore = indexer.db;
    const mtimesBefore = indexer._mtimes.size;
    t.truthy(dbBefore);
    t.is(plugin.oramaDb, dbBefore);

    // Provider embeddingów staje się chwilowo niedostępny (np. zmiana klucza).
    embedder.isReady = () => false;
    const status = await indexer.rebuild();

    t.is(status.status, 'no_provider');
    t.is(indexer.db, dbBefore, 'db NIE jest zerowane na wczesnym wyjściu');
    t.true(indexer._ready, '_ready zostaje true — stary indeks nadal żywy dla _flushQueue');
    t.is(indexer._mtimes.size, mtimesBefore, 'mtimes NIE są czyszczone przed udanym rebuildem');
    t.is(plugin.oramaDb, dbBefore, 'plugin.oramaDb dalej wskazuje stary, żywy indeks');

    // Provider wraca — kolejny rebuild działa normalnie (stan nie został połamany na trwałe).
    embedder.isReady = () => true;
    const status2 = await indexer.rebuild();
    t.is(status2.status, 'ready');
    t.true(indexer._ready);
});

// 7. Hooki: create/modify/delete/rename aktualizują indeks (handler wołany bezpośrednio).
test('vault hooks upsert and remove documents', async t => {
    const { indexer, files } = newIndexer();
    await indexer.initialize();

    // create
    files.set('van.md', { content: 'Duży pojazd dostawczy', mtime: 300 });
    indexer._onVaultEvent('create', { path: 'van.md' });
    await indexer._flushQueue();
    t.true(indexer._mtimes.has('van.md'));

    // modify (re-embed)
    files.set('car.md', { content: 'Zupełnie inny samochód', mtime: 301 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    t.is(indexer._mtimes.get('car.md'), 301);

    // delete
    indexer._onVaultEvent('delete', { path: 'sky.md' });
    await indexer._flushQueue();
    t.false(indexer._mtimes.has('sky.md'));

    // rename (remove old, insert new)
    files.set('animals/cat.md', { content: 'Mały kot na płocie', mtime: 302 });
    indexer._onVaultEvent('rename', { path: 'animals/cat.md' }, 'notes/cat.md');
    await indexer._flushQueue();
    t.false(indexer._mtimes.has('notes/cat.md'));
    t.true(indexer._mtimes.has('animals/cat.md'));
});

// 7b. Hooki ignorują .pkm-assistant nawet gdy przyjdzie zdarzenie.
test('vault hooks never index .pkm-assistant paths', async t => {
    const { indexer } = newIndexer();
    await indexer.initialize();
    indexer._onVaultEvent('create', { path: '.pkm-assistant/agents/x/memory/brain.md' });
    await indexer._flushQueue();
    t.false([...indexer._mtimes.keys()].some(p => p.startsWith('.pkm-assistant')));
});

// Zadeklarowany dims kłóci się z realnym wektorem → używamy realnego (bez crasha).
test('mismatched declared dims falls back to actual vector length', async t => {
    // embedder zwraca 3-wymiarowe wektory, ale deklaruje dims=5 (błędnie).
    const { indexer } = newIndexer({ embedderOpts: { dims: 5 } });
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'ready');
    t.is(indexer.dims, 3, 'indeks użył realnej długości wektora, nie zadeklarowanej');

    const qv = [1, 0, 0]; // wektor „pojazdu"
    const res = await searchVectorTopK(indexer.db!, qv, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
});

// Empty vault → pusty, ale gotowy indeks (bez wywrotki).
test('empty vault yields a ready empty index', async t => {
    const { indexer, plugin } = newIndexer({ files: new Map() });
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'ready');
    t.truthy(plugin.oramaDb);
    t.is(indexer._mtimes.size, 0);
});

// ─────────────── KONTRAKT BŁĘDU ───────────────
//
// Padnięty provider (zgaszony demon, 429, brak sieci) NIE MOŻE wyglądać jak „pliki puste".
// Gdyby `embed_batch` oddawał pustą albo jednoelementową tablicę, `EmbeddingHelper` zrobiłby
// z tego N nulli, a `_insertOne` stemplowałby mtime CAŁEJ porcji jako obrobionej. Skan
// kończyłby się statusem `ready` z ZEREM wektorów, a `_resync` po restarcie porównywałby
// mtime i nie robił ani jednego wywołania API - indeks zostawałby pusty NA STAŁE.

/** Embedder, który zachowuje się jak padnięty provider ZA naprawionym kontraktem. */
function makeBrokenEmbedder(mode: 'throw' | 'short' | 'notArray'): FakeEmbedder {
    const calls: { embedBatch: number; texts: string[] } = { embedBatch: 0, texts: [] };
    return {
        _calls: calls,
        isReady: () => true,
        getModelKey: () => 'openai:text-embedding-3-small',
        getDims: () => null,
        async embed() { return null; },
        async embedBatch(texts: string[]) {
            calls.embedBatch++; calls.texts.push(...texts);
            if (mode === 'throw') throw new Error('embedding request failed (transport returned no response)');
            // 1 element na N wejść — dokładny kształt starej zwrotki błędu `[{error}]`.
            if (mode === 'short') return [[0.1, 0.2, 0.3]];
            return null as unknown as Array<number[] | null>;
        },
    };
}

for (const mode of ['throw', 'short', 'notArray'] as const) {
    test(`awaria embeddingu (${mode}) NIE stempluje mtime i kończy skan statusem error`, async t => {
        const store = new Map();
        const { indexer, plugin } = newIndexer({ files: baseFiles(), store, embedder: makeBrokenEmbedder(mode) });
        await indexer.initialize();

        t.is(indexer.getStatus().status, 'error', 'padnięte API musi być GŁOŚNE (kontrakt CLAUDE.md)');
        t.truthy(indexer.getStatus().lastError);
        t.is(plugin.oramaDb, null, 'częściowy/pusty indeks NIE jest publikowany');
        t.is(indexer._mtimes.size, 0, 'ANI JEDEN plik nie może zostać oznaczony jako obrobiony');
        t.false(store.has('.pkm-assistant/index/vault-index.meta.json'), 'stempel mtime nie może trafić na dysk');
        indexer.dispose();
    });
}

// ─────────── Pad resyncu NIE zabiera odzyskanego indeksu ───────────
//
// `_tryRestore()` OK → `_resync()` pada (np. Ollama zgaszona przy starcie, notatki zmienione
// od ostatniego bootu) → wyjątek szedłby do `catch` w `initialize`, `_publish()` nigdy by nie
// poleciało, `_ready` zostawałoby `false`. Skutek: `RetrievalEngine` nie widziałby `oramaDb`
// (semantyka martwa na CAŁĄ sesję), a `_ready=false` blokowałoby `_flushQueue`, czyli zero
// ponowień - mimo że NIEŚWIEŻY, ale kompletny indeks byłby w garści.
test('pad resyncu publikuje odzyskany indeks, a zmienione pliki idą do kolejki', async t => {
    const store = new Map();
    const a = newIndexer({ files: baseFiles(), store });
    await a.indexer.initialize();
    t.is(a.indexer.getStatus().status, 'ready');

    // Restart: dwie notatki zmienione od wczoraj, provider padnięty.
    const zmienione = new Map<string, FakeFile>([
        ['car.md', { content: 'Nowy samochód elektryczny', mtime: 900 }],
        ['notes/cat.md', { content: 'Mały kot siedzi na płocie', mtime: 100 }],
        ['sky.md', { content: 'Inne niebo', mtime: 901 }],
    ]);
    const b = newIndexer({ files: zmienione, store, embedder: makeBrokenEmbedder('throw') });
    await b.indexer.initialize();

    t.truthy(b.plugin.oramaDb, 'odzyskany indeks MUSI być opublikowany — nieświeży > brak');
    t.is(b.indexer.getStatus().status, 'ready');
    t.true(b.indexer._ready, '_ready=false zablokowałoby kolejkę do końca sesji');
    t.truthy(b.indexer.getStatus().lastError, 'user musi wiedzieć, że indeks jest nieświeży');
    t.deepEqual([...b.indexer._queue.keys()].sort(), ['car.md', 'sky.md'], 'zmienione pliki czekają na ponowienie');
    t.is(b.indexer._mtimes.get('car.md'), 100, 'nieodświeżony plik NIE dostaje nowego mtime');

    // Semantyka żyje na starych wektorach.
    const qv = await a.embedder.embed('pojazd');
    const res = await searchVectorTopK(b.indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
    b.indexer.dispose();
});

// ─────────── P2a: zdarzenie z vaulta nie skraca uzbrojonego ponowienia ───────────

test('zdarzenia vaulta po padzie NIE zbijają backoffu do zwykłego debounce', async t => {
    let zegar = 1000;
    const { indexer, files, embedder } = newIndexer({ debounceMs: 100, now: () => zegar });
    await indexer.initialize();

    embedder.embedBatch = async () => { throw new Error('demon zgaszony'); };
    files.set('car.md', { content: 'Nowy samochód', mtime: 900 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();   // pad 1 → uzbrojone 100 ms
    await indexer._flushQueue();   // pad 2 → uzbrojone 200 ms (retryAt = 1200)
    t.is(indexer._flushDelayMs, 200);

    // User dalej pisze: trzy zdarzenia w oknie backoffu.
    zegar = 1050;
    files.set('sky.md', { content: 'Inne niebo', mtime: 901 });
    indexer._onVaultEvent('modify', { path: 'sky.md' });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    indexer._onVaultEvent('modify', { path: 'notes/cat.md' });
    t.is(indexer._flushDelayMs, 150, 'debounce z hooka skrócił uzbrojone ponowienie — API dostaje młocką');

    // Po udanym flushu backoff znika i zwykły debounce znowu rządzi.
    embedder.embedBatch = async (texts: string[]) => texts.map(() => [0, 0, 1]);
    await indexer._flushQueue();
    indexer._onVaultEvent('modify', { path: 'car.md' });
    t.is(indexer._flushDelayMs, 100);
    indexer.dispose();
});

// ─────────── P2b: przejściowa awaria porcji jest ponawiana w miejscu ───────────

test('zimny start providera: porcja ponawiana, skan kończy się ready', async t => {
    let pady = 2; // dwa timeouty, potem provider wstaje
    const embedder = makeEmbedder();
    const zdrowy = embedder.embedBatch;
    embedder.embedBatch = async (texts: string[]) => {
        if (pady-- > 0) throw Object.assign(new Error('embedding request timed out after 60000 ms'), { kind: 'timeout' });
        return zdrowy(texts);
    };
    const { indexer, plugin } = newIndexer({ embedder });
    await indexer.initialize();

    t.is(indexer.getStatus().status, 'ready', 'dwa timeouty na starcie nie mogą zabić indeksu na stałe');
    t.truthy(plugin.oramaDb);
    t.is(indexer._mtimes.size, 3);
    indexer.dispose();
});

test('pad całego skanu uzbraja automatyczne ponowienie (P2b)', async t => {
    const { indexer } = newIndexer({ embedder: makeBrokenEmbedder('throw') });
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'error');
    t.is(indexer['_scanFailures'], 1, 'skan padł, a nikt nie zaplanował ponowienia');
    t.truthy(indexer['_scanRetryTimer']);
    indexer.dispose();
    t.is(indexer['_scanRetryTimer'], null, 'dispose() musi zdjąć timer ponowienia');
});

// ─────────── P2c: zatruta notatka nie blokuje reszty porcji ───────────

test('trwały błąd API na jednej notatce: reszta zaindeksowana, zatruta pominięta', async t => {
    const files = new Map<string, FakeFile>();
    for (let i = 0; i < 15; i++) files.set(`ok/${i}.md`, { content: `notatka ${i} o samochodach`, mtime: 1 });
    files.set('zatruta.md', { content: 'zdecydowanie za długi polski tekst', mtime: 1 });

    let zadania = 0;
    const embedder = makeEmbedder();
    const zdrowy = embedder.embedBatch;
    embedder.embedBatch = async (texts: string[]) => {
        zadania++;
        if (texts.some(x => x.includes('za długi polski'))) {
            throw Object.assign(new Error('400 input exceeds context length'), { kind: 'api', httpStatus: 400 });
        }
        return zdrowy(texts);
    };

    const { indexer, plugin } = newIndexer({ files, embedder });
    await indexer.initialize();

    t.is(indexer.getStatus().status, 'ready', 'jedna zatruta notatka nie może wywalić całego skanu');
    t.truthy(plugin.oramaDb);
    t.is(indexer._mtimes.size, 15, 'pozostałe 15 plików zaindeksowanych');
    t.false(indexer._mtimes.has('zatruta.md'), 'pominięty plik NIE dostaje stempla — wróci przy następnym skanie');
    t.true(indexer.skipped.has('zatruta.md'));
    t.regex(String(indexer.getStatus().lastError), /zatruta\.md/);
    t.true(zadania > 3, 'porcja powinna zostać rozbita na pojedyncze pliki');
    indexer.dispose();
});

// ─────────── rebuild(): pad przywraca CAŁY stan, nie sam db ───────────

test('nieudany rebuild przywraca db, mtimes, dims i _ready', async t => {
    const { indexer, embedder, plugin } = newIndexer();
    await indexer.initialize();
    const dbBefore = indexer.db;
    const mtimesBefore = new Map(indexer._mtimes);
    const dimsBefore = indexer.dims;

    embedder.embedBatch = async () => { throw new Error('demon zgaszony'); };
    const status = await indexer.rebuild();

    t.is(status.status, 'error');
    t.is(indexer.db, dbBefore);
    t.is(plugin.oramaDb, dbBefore, 'stary indeks nadal opublikowany');
    t.deepEqual([...indexer._mtimes.entries()].sort(), [...mtimesBefore.entries()].sort(),
        'puste _mtimes po padzie = resync przy następnym starcie re-embeduje CAŁY vault');
    t.is(indexer.dims, dimsBefore);
    t.true(indexer._ready, '_ready=false zablokowałoby kolejkę zmian do końca sesji');

    // Kolejka zmian nadal działa na przywróconym indeksie.
    embedder.embedBatch = async (texts: string[]) => texts.map(() => [0, 0, 1]);
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    t.is(indexer._queue.size, 0);
    indexer.dispose();
});

// G3 [DROBNE] (runda naprawcza 2): rebuild() z ZEROWYM wynikiem (dostawca odrzuca trwale KAŻDY
// plik, np. zły klucz/model po zmianie ustawień) nie może commitować pustego indeksu i kasować
// segmentów, na które STARA (wciąż nietknięta) meta na dysku dalej wskazuje. `_fullScan()` rzuca,
// gdy `files.length > 0` a `_mtimes` zostaje pusta (KAŻDY plik trwale pominięty) - `rebuild()`'s
// istniejący `catch` przywraca WTEDY cały poprzedni stan (patrz test wyżej) i kod sprzątania
// starych segmentów (wewnątrz `try`, PO `_fullScan()`) nigdy nie zostaje osiągnięty.
test('G3: rebuild() z zerowym wynikiem (wszystkie pliki trwale odrzucone) NIE kasuje starego indeksu', async t => {
    const store: FakeStore = new Map();
    const files = new Map<string, FakeFile>([
        ['n0.md', { content: 't0', mtime: 100 }],
        ['n1.md', { content: 't1', mtime: 100 }],
    ]);
    let reject = false;
    const embedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 3,
        async embed() { return [1, 0, 0]; },
        async embedBatch(texts: string[]) {
            this._calls.embedBatch++; this._calls.texts.push(...texts);
            if (reject) throw Object.assign(new Error('400 bad request'), { kind: 'api', httpStatus: 400 });
            return texts.map((_, i) => [1, i, 0]);
        },
    };
    const { indexer } = newIndexer({ files, store, embedder });
    await indexer.initialize();
    const metaBefore = readMetaV2(store);
    const segBefore = new Map(metaBefore.segments.map(seg => [seg.file, new Uint8Array((store.get(`.pkm-assistant/index/${seg.file}`) as ArrayBuffer).slice(0))]));

    reject = true; // dostawca zaczyna trwale odrzucać KAŻDY plik (np. zły klucz/model po zmianie ustawień)
    const result = await indexer.rebuild();

    t.is(result.status, 'error', 'rebuild z zerowym wynikiem musi zgłosić błąd, nie ready z pustym indeksem');
    const metaAfter = readMetaV2(store);
    t.deepEqual(metaAfter, metaBefore, 'meta na dysku NIETKNIĘTA - stary indeks zostaje jedynym źródłem prawdy');
    for (const [file, bytesBefore] of segBefore) {
        const bytesAfter = new Uint8Array(store.get(`.pkm-assistant/index/${file}`) as ArrayBuffer);
        t.deepEqual(bytesAfter, bytesBefore, `segment ${file} NIETKNIĘTY - nie skasowany, nie nadpisany`);
    }
    t.is(countDocs(indexer.db), 2, 'stary indeks w RAM przywrócony w komplecie');

    // Restart z dostawcą zdrowym: 0 embedów = stary indeks naprawdę odzyskany, nie odbudowany od zera.
    reject = false; // dostawca "naprawiony" - restart NIE MOŻE mimo to re-embedować
    const restartEmbedder: FakeEmbedder = { ...embedder, _calls: { embedBatch: 0, texts: [] } };
    const c = newIndexer({ files, store, embedder: restartEmbedder });
    await c.indexer.initialize();
    t.is(restartEmbedder._calls.embedBatch, 0, 'restart odzyskuje stary indeks bez re-embedu');
    t.is(c.indexer.getStatus().status, 'ready');
    t.false(c.notices.some(n => n.kind === 'index_corrupt'));
    indexer.dispose();
    c.indexer.dispose();
});

// F4.10: bug zastany na main (poza zakresem oryginalnej recenzji, ten sam plik) - skan pada
// W POŁOWIE porcji (nie przy pierwszej), a `initialize()` NIE zeruje `this.db` przed ponowieniem.
// Drugi `_fullScan()` insertowałby do TEJ SAMEJ, częściowo zapełnionej bazy i dostawał "A document
// with id ... already exists" w nieskończoność zamiast policzyć wszystko od zera.
test('F4.10: ponowienie skanu po padzie W POŁOWIE startuje od PUSTEJ bazy, nie od częściowej', async t => {
    const files = new Map<string, FakeFile>();
    for (let i = 0; i < 6; i++) files.set(`n${i}.md`, { content: `tekst ${i}`, mtime: 1 });
    const store: FakeStore = new Map();
    let call = 0;
    const embedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 2,
        async embed() { return null; },
        async embedBatch(t2: string[]) {
            call++;
            // Porcja 2 (druga, PO tym jak porcja 1 już wstawiła coś do `this.db`) pada trwale
            // przez kilka prób, aż `_embedMetas`'s BATCH_TRANSIENT_RETRIES się wyczerpie i skan
            // padnie z częściowo zapełnioną bazą w pamięci.
            if (call >= 2 && call <= 4) throw Object.assign(new Error('timeout'), { kind: 'timeout' });
            return t2.map((_, i) => [1, i]);
        },
    };
    const { indexer } = newIndexer({ files, store, embedder, batchSize: 2, scanRetryMs: 5 });
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'error', 'pierwszy skan pada w połowie porcji 2');

    // Ponowienie uzbrojone przez `_scheduleScanRetry` (scanRetryMs=5) - poczekaj aż wystrzeli
    // i skończy (dostawca teraz zdrowy, `call` już przekroczyło padający zakres).
    await new Promise(r => setTimeout(r, 200));

    const status = indexer.getStatus();
    t.is(status.status, 'ready', 'ponowienie musi się udać, nie utknąć w pętli duplikatów ID');
    t.is(indexer._mtimes.size, 6, 'WSZYSTKIE notatki, nie tylko te sprzed padu');
    t.is(countDocs(indexer.db), 6, 'baza po ponowieniu ma dokładnie 6 dokumentów, nie duplikaty ani niedobór');
    indexer.dispose();
});

test('po awarii skanu następny start NIE uznaje vaulta za zaindeksowany', async t => {
    const store = new Map();
    const files = baseFiles();

    // Bieg 1: provider padnięty (przypadek: Obsidian wstał przed demonem Ollamy).
    const a = newIndexer({ files, store, embedder: makeBrokenEmbedder('short') });
    await a.indexer.initialize();
    t.is(a.indexer.getStatus().status, 'error');

    // Bieg 2: ten sam „dysk", provider zdrowy. Bez naprawy `_resync` nie robiłby NICZEGO,
    // bo mtimes wszystkich plików były zapisane w sidecarze.
    const b = newIndexer({ files: baseFiles(), store });
    await b.indexer.initialize();
    t.is(b.indexer.getStatus().status, 'ready');
    t.is(b.indexer._mtimes.size, 3);
    t.true(b.embedder._calls.embedBatch > 0, 'po powrocie providera vault MUSI zostać zaindeksowany');
    const qv = await b.embedder.embed('pojazd');
    const res = await searchVectorTopK(b.indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
});

test('awaria w kolejce zmian zwraca porcję do kolejki (nic nie ginie)', async t => {
    const { indexer, files, embedder } = newIndexer();
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'ready');

    // Provider pada w trakcie zwykłej edycji notatki.
    let padnij = true;
    const zdrowy = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts: string[]) => {
        if (padnij) throw new Error('429 Rate limit reached');
        return zdrowy(texts);
    };

    files.set('car.md', { content: 'Zupełnie inny samochód', mtime: 999 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();

    t.is(indexer._queue.get('car.md'), 'upsert', 'zmiana MUSI wrócić do kolejki');
    t.is(indexer._mtimes.get('car.md'), 100, 'mtime NIE może zostać przestemplowany po padzie');
    t.truthy(indexer.getStatus().lastError);
    t.is(indexer.getStatus().status, 'ready', 'żywy indeks zostaje żywy — to awaria porcji, nie skanu');

    // Provider wraca — ponowienie dowozi zmianę.
    padnij = false;
    await indexer._flushQueue();
    t.is(indexer._mtimes.get('car.md'), 999);
    t.is(indexer._queue.size, 0);
    t.is(indexer.getStatus().lastError, null, 'udany flush kasuje ślad po awarii');
});

test('ponowienia po padzie mają rosnący odstęp (nie młócą API co debounce)', t => {
    const { indexer } = newIndexer();
    const d1 = indexer._flushRetryDelayMs(1);
    const d2 = indexer._flushRetryDelayMs(2);
    const d3 = indexer._flushRetryDelayMs(3);
    t.is(d1, indexer.debounceMs);
    t.true(d2 > d1 && d3 > d2);
    t.true(indexer._flushRetryDelayMs(99) <= 5 * 60 * 1000, 'odstęp ma sufit');
});

// ─────────── Debounce kolejki nie resetuje się na cudzych plikach ───────────

test('zdarzenie na pliku SPOZA indeksu nie przesuwa timera realnych zmian', async t => {
    const { indexer, files } = newIndexer();
    await indexer.initialize();

    files.set('car.md', { content: 'Nowy samochód', mtime: 500 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    const timerPoZmianie = indexer['_debounceTimer'];
    t.truthy(timerPoZmianie, 'realna zmiana planuje flush');

    // Strumień zdarzeń, które do indeksu NIE wchodzą: załącznik, plik pamięci agentów,
    // notatka w NoGo. Bez filtra każde z nich zresetowałoby clearTimeout + setTimeout od nowa.
    indexer._onVaultEvent('modify', { path: 'zalaczniki/obrazek.png' });
    indexer._onVaultEvent('create', { path: '.pkm-assistant/agents/x/memory/brain.md' });
    indexer._onVaultEvent('delete', { path: 'notatka.canvas' });
    t.is(indexer['_debounceTimer'], timerPoZmianie, 'timer został przestawiony przez zdarzenie spoza indeksu');
    t.is(indexer._queue.size, 1);

    // Kolejna zmiana REALNEGO pliku nadal przestawia debounce (tak ma być).
    files.set('sky.md', { content: 'Inne niebo', mtime: 501 });
    indexer._onVaultEvent('modify', { path: 'sky.md' });
    t.not(indexer['_debounceTimer'], timerPoZmianie);
    t.is(indexer._queue.size, 2);
});

// ─────────── Wektor tylko w vectorIndexes ───────────

// Konwersja z ery Orama `persist()`/`restore()`/`stripStoredVectors()` (usunięte razem z
// formatem v1): `insertVectorLean` sam w sobie zostaje (żywa Orama, D1), tyle że sprawdzany
// jest teraz IN-MEMORY — v2 nie serializuje już całego dumpu Oramy na dysk, więc "druga kopia
// wektora w docs-store" nie jest już kwestią formatu pliku, tylko wyłącznie RAM-u.
test('insertVectorLean nie zostawia DRUGIEJ kopii wektora w docs-store, a wyszukiwanie działa', async t => {
    const { indexer } = newIndexer({ files: baseFiles() });
    await indexer.initialize();

    const db = indexer.db!;
    const docs = db.documentsStore.getAll(db.data.docs) as Record<string, { path: string; embedding: unknown }>;
    const values = Object.values(docs);
    t.is(values.length, 3);
    t.true(values.every(d => d.embedding === null), 'kopia wektora w docs-store nie została wyzerowana');
    t.true(values.every(d => typeof d.path === 'string'), 'reszta dokumentu zostaje nietknięta');

    const qv = await indexer.embedder.embed!('auto');
    const res = await searchVectorTopK(indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
});

test('usunięcie dokumentu po wyzerowaniu kopii realnie kasuje wektor z indeksu', async t => {
    const { indexer, embedder } = newIndexer();
    await indexer.initialize();

    const qv = await embedder.embed('auto');
    const przed = await searchVectorTopK(indexer.db!, qv!, { k: 5, similarity: 0 });
    t.true(przed.hits.some(h => h.document.path === 'car.md'));

    indexer._onVaultEvent('delete', { path: 'car.md' });
    await indexer._flushQueue();

    const po = await searchVectorTopK(indexer.db!, qv!, { k: 5, similarity: 0 });
    t.false(po.hits.some(h => h.document?.path === 'car.md'), 'wektor został w vectorIndexes mimo remove()');
    t.false(indexer._mtimes.has('car.md'));
});

// ═══════════════════ F1: współbieżność `_persistNow` (BLOKER recenzji, R1-R4) ═══════════════════
//
// Każdy `await` w `_persistNewSegment`/`_persistCompact` jest oknem, w którym flush/delete/drugi
// persist mogą zmienić `_pending`/`_mtimes`/`_rows` POD SPODEM. Adapter poniżej daje testowi
// KONTROLĘ nad tym oknem: `writeBinary` zawiesza się na `gate`, dopóki test go nie zwolni -
// dokładnie tak, jak zrobiłby to prawdziwy dysk sieciowy w najgorszym możliwym momencie.

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/** Podpina blokujący hook na `writeBinary` - `open()` zwalnia WSZYSTKIE zawieszone zapisy naraz. */
function armWriteGate(vault: VaultLike): { open: () => void; rearm: () => void } {
    let gate: Promise<void> | null = null;
    let release: () => void = () => {};
    const real = vault.adapter.writeBinary.bind(vault.adapter);
    vault.adapter.writeBinary = async (path: string, data: ArrayBuffer) => {
        if (gate) await gate;
        return real(path, data);
    };
    const rearm = () => { gate = new Promise(r => { release = () => { gate = null; r(); }; }); };
    rearm();
    return { open: () => release(), rearm };
}

// R1: persist w toku (writeBinary trwa) + flush notatki B DOKŁADA się do `_pending` w tym oknie.
// Bug sprzed naprawy: `_persistNewSegment` brał migawkę `_pending`, a PO zapisie wołał gołe
// `_pending.clear()` - to kasowało TEŻ B, mimo że segment na dysku B nie zawierał. B dostawał
// mtime (już zapisany w `_insertOne` przed persistem), ale NIGDY wiersza - `_resync` po restarcie
// widziałby mtime niezmieniony i nigdy by go nie zreembedował: notatka znika z semantyki na stałe.
test('F1/R1: persist w toku + flush B w oknie await - B NIE ginie (migawka + częściowe czyszczenie pending)', async t => {
    const store: FakeStore = new Map();
    const { indexer, files, vault, embedder } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();
    const gate = armWriteGate(vault);

    // A = car.md - flush go embeduje, ląduje w _pending.
    files.set('car.md', { content: 'Nowy samochód A', mtime: 200 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();

    const persistA = indexer._persistNow(); // wejdzie w writeBinary i zawiśnie na gate
    await tick();

    // B = sky.md - zmieniony i sflushowany W OKNIE await pierwszego persistu.
    files.set('sky.md', { content: 'Inne niebo B', mtime: 201 });
    indexer._onVaultEvent('modify', { path: 'sky.md' });
    await indexer._flushQueue();

    gate.open();
    await persistA;

    // B nie mógł trafić do PIERWSZEGO segmentu (persist A zaczął się, zanim B w ogóle istniał) -
    // to jest OK. Kluczowe: B nie może zniknąć BEZ ŚLADU z `_pending`.
    const pendingAfter = (indexer as unknown as { _pending: Map<string, unknown> })._pending;
    t.true(pendingAfter.has('sky.md'), 'B MUSI wciąż czekać w _pending - stary bug go tu kasował');

    await indexer._persistNow(); // drugi persist dowozi B
    const meta = readMetaV2(store);
    t.truthy(meta.rows['sky.md'], 'po drugim persiście B ma wiersz na dysku');
    t.is(meta.mtimes['sky.md'], 201);
    const ref = meta.rows['sky.md'];
    const buf = store.get(`.pkm-assistant/index/${meta.segments[ref[0]].file}`) as ArrayBuffer;
    const onDisk = Array.from(decodeSegment(buf, meta.dims)!.at(ref[1]));
    const expected = (await embedder.embed('Inne niebo B'))!.map(Math.fround);
    t.deepEqual(onDisk, expected, 'wektor B na dysku = wektor z embeddera (nie śmieci, nie stary)');

    // Restart: komplet dokumentów, ZERO embedów.
    const c = newIndexer({ files, store });
    await c.indexer.initialize();
    t.is(c.embedder._calls.embedBatch, 0, 'restart nie re-embeduje - B jest trwale na dysku');
    t.is(countDocs(c.indexer.db), 3);
    indexer.dispose();
    c.indexer.dispose();
});

// R2: kompakcja w toku (czyta segmenty z dysku, potem pisze bazowy) + w oknie await: notatka D
// usunięta, notatka C zmieniona. Bug sprzed naprawy: `_rows`/`_pending` podmieniane CAŁĄ mapą PO
// zapisie - gubiło usunięcia (D wracałby z martwych danych) i zmiany z okna (C zostawałby na
// starym wektorze aż do przypadkowego kolejnego touchu).
test('F1/R2: kompakcja w toku + usunięcie D i zmiana C w oknie - meta bez D, C dostaje świeży wektor po kolejnym persiście', async t => {
    const store: FakeStore = new Map();
    const files = new Map<string, FakeFile>([
        ['a.md', { content: 'A0', mtime: 1 }],
        ['b.md', { content: 'B0', mtime: 1 }],
        ['c.md', { content: 'C0', mtime: 1 }],
        ['d.md', { content: 'D0', mtime: 1 }],
    ]);
    let seq = 0;
    // G2 (round 2): `lastVectorForText` niesie DOKŁADNIE ten wektor, który `embedBatch` zwrócił
    // dla danego tekstu - pozwala porównać bajty na dysku z REALNYM ostatnim wynikiem embeddera
    // (Math.fround) zamiast tylko sprawdzać kształt (4 skończone liczby), co przepuszczało M9.
    const lastVectorForText = new Map<string, number[]>();
    const embedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 4,
        async embed(text: string) { seq++; const v = [Math.sin(seq), Math.cos(seq), seq, 1]; lastVectorForText.set(text, v); return v; },
        async embedBatch(texts: string[]) {
            this._calls.embedBatch++; this._calls.texts.push(...texts);
            return texts.map(t => { seq++; const v = [Math.sin(seq), Math.cos(seq), seq, 1]; lastVectorForText.set(t, v); return v; });
        },
    };
    const { indexer, vault } = newIndexer({ files, store, embedder });
    await indexer.initialize();

    // Zmieniaj a.md w kółko, sprawdzając PRZED każdym persistem (przez samo `planCompaction`,
    // na tych samych danych co produkcyjny `_persistNow`), czy TA konkretna zmiana wepchnie stan
    // nad próg kompakcji - dokładna liczba iteracji zależy od progu rosnącego dead/live, więc
    // liczymy to zamiast zgadywać na sztywno (4 pliki: próg dead>=live*0.5 trafia szybciej niż
    // próg >8 segmentów).
    let mt = 10;
    for (let i = 0; i < 20; i++) {
        const meta = readMetaV2(store);
        const liveNow = new Set([...Object.keys(meta.rows), 'a.md']).size; // a.md zawsze żywe
        const willCompact = planCompaction({ segments: meta.segments, liveRows: liveNow });
        if (willCompact) break;
        files.set('a.md', { content: `A${i}`, mtime: mt++ });
        indexer._onVaultEvent('modify', { path: 'a.md' });
        await indexer._flushQueue();
        await indexer._persistNow();
    }
    files.set('a.md', { content: 'A_final', mtime: mt++ });
    indexer._onVaultEvent('modify', { path: 'a.md' });
    await indexer._flushQueue();
    t.true(planCompaction({ segments: readMetaV2(store).segments, liveRows: 4 }), 'setup: następny persist MUSI pójść przez kompakcję');

    const gate = armWriteGate(vault);
    const compactP = indexer._persistNow(); // _persistCompact: czyta 8 segmentów, potem pisze bazowy (zawiesza się tu)
    await tick(); await tick(); await tick();

    // W OKNIE kompakcji: D usunięty, C zmieniony.
    files.delete('d.md');
    indexer._onVaultEvent('delete', { path: 'd.md' });
    files.set('c.md', { content: 'C_nowy', mtime: 200 });
    indexer._onVaultEvent('modify', { path: 'c.md' });
    await indexer._flushQueue();

    gate.open();
    await compactP;

    let meta = readMetaV2(store);
    t.falsy(meta.rows['d.md'], 'D usunięty w oknie await NIE MOŻE mieć wiersza po kompakcji');
    t.falsy(meta.mtimes['d.md'], 'D usunięty NIE MOŻE mieć mtime po kompakcji');
    t.truthy(meta.rows['a.md'], 'A (żywa, nietknięta w oknie) przeżywa kompakcję');
    t.truthy(meta.rows['b.md'], 'B (żywa, nietknięta w oknie) przeżywa kompakcję');

    // C mógł nie zdążyć wejść do TEJ kompakcji (zależnie od dokładnego momentu okna) - ale NIE
    // MOŻE zniknąć: albo ma już świeży wiersz, albo wciąż czeka w _pending.
    const pendingAfter = (indexer as unknown as { _pending: Map<string, unknown> })._pending;
    t.true(!!meta.rows['c.md'] || pendingAfter.has('c.md'), 'C nie może zniknąć bez śladu');

    await indexer._persistNow(); // dowozi C, jeśli jeszcze czekał
    meta = readMetaV2(store);
    t.truthy(meta.rows['c.md']);
    const refC = meta.rows['c.md'];
    const bufC = store.get(`.pkm-assistant/index/${meta.segments[refC[0]].file}`) as ArrayBuffer;
    const onDiskC = Array.from(decodeSegment(bufC, meta.dims)!.at(refC[1]));
    // G2/M9: porównanie na BAJTACH z dysku wobec OSTATNIEGO wektora, który embedder faktycznie
    // zwrócił dla 'C_nowy' (nie wobec kolejnego, świeżo policzonego wywołania `embed()`, które
    // inkrementowałoby `seq` jeszcze raz i nie dałoby się przewidzieć) - `_persistCompact` z
    // mutantem M9 (`_pending.clear()` gołe po kompakcji) gubi TEN WŁAŚNIE wektor bezpowrotnie, a
    // stary wiersz C w nowym segmencie bazowym zostaje wskazywać na wektor sprzed zmiany.
    const expectedC = lastVectorForText.get('C_nowy')!.map(Math.fround);
    t.deepEqual(onDiskC, expectedC, 'wektor C na dysku = OSTATNI wektor embeddera dla C_nowy (nie stary, nie śmieci)');

    // Restart: zero błędów `index_corrupt`, dane kompletne dla żywych notatek.
    const restartFiles = new Map(files);
    const { indexer: r, notices } = newIndexer({ files: restartFiles, store });
    await r.initialize();
    t.is(r.getStatus().status, 'ready');
    t.false(notices.some(n => n.kind === 'index_corrupt'), 'restart po R2 nie może być index_corrupt');
    indexer.dispose();
    r.dispose();
});

// R3: dwa `_persistNow()` wystrzelone BEZ oczekiwania między nimi (timer debounce + koniec
// skanu/resyncu potrafią to zrobić naprawdę). Serializacja (`_persistChain`) musi zagwarantować,
// że drugi `_persistNowInner` startuje DOPIERO po tym, jak pierwszy (i jego zapisy) się skończy -
// inaczej oba czytałyby ten sam `_nextSeq` i pisały segment o TEJ SAMEJ nazwie.
test('F1/R3: dwa _persistNow() naraz - unikalne nazwy segmentów, meta spójna, restart bez błędów', async t => {
    const store: FakeStore = new Map();
    const { indexer, files, vault } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();
    const gate = armWriteGate(vault);

    files.set('car.md', { content: 'Nowy A', mtime: 300 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    const p1 = indexer._persistNow();
    await tick();

    files.set('sky.md', { content: 'Nowy B', mtime: 301 });
    indexer._onVaultEvent('modify', { path: 'sky.md' });
    await indexer._flushQueue();
    const p2 = indexer._persistNow(); // dołącza się na koniec _persistChain - NIE biegnie równolegle z p1
    await tick();

    gate.open();
    await Promise.all([p1, p2]);

    const meta = readMetaV2(store);
    const names = meta.segments.map(s => s.file);
    t.is(new Set(names).size, names.length, 'zero zdublowanych nazw segmentów');
    t.truthy(meta.rows['car.md']);
    t.truthy(meta.rows['sky.md']);

    const c = newIndexer({ files, store });
    await c.indexer.initialize();
    t.is(c.embedder._calls.embedBatch, 0);
    t.is(c.indexer.getStatus().status, 'ready');
    t.is(c.notices.filter(n => n.kind === 'index_corrupt').length, 0);
    indexer.dispose();
    c.indexer.dispose();
});

// R4: rebuild() (Reindex) w trakcie, a "timer" persistu (debounce 30s po edycji SPRZED Reindex)
// wystrzeliwuje w środku skanu - `rebuild()` musi POCZEKAĆ na persist w toku PRZED resetem stanu,
// a wywołania `_persistNow()` z timera w trakcie skanu nie mogą korumpować świeżo resetowanych
// `_segments`/`_rows`/`_pending`.
test('F1/R4: rebuild() + persisty z timera w trakcie skanu - stan po rebuildzie kompletny i spójny', async t => {
    const N = 10;
    const files = new Map<string, FakeFile>();
    for (let i = 0; i < N; i++) files.set(`f${i}.md`, { content: `tekst ${i}`, mtime: 1 });
    const store: FakeStore = new Map();
    // Fabryka - tak indekser startowy, jak restart po teście, dzielą model_key/dims (inaczej
    // restart odrzuciłby restore jako `model_changed` i re-embed byłby OCZEKIWANY, nie bugiem).
    const makeR4Embedder = (): FakeEmbedder => ({
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 4,
        async embed() { return null; },
        async embedBatch(texts: string[]) {
            this._calls.embedBatch++; this._calls.texts.push(...texts);
            await new Promise(r => setTimeout(r, 5)); // symuluje HTTP - daje oknu na realne przeplatanie
            return texts.map(() => { const n = Math.random(); return [Math.sin(n), Math.cos(n), 3, 1]; });
        },
    });
    const embedder = makeR4Embedder();
    const { indexer, vault } = newIndexer({ files, store, embedder, batchSize: 2 });
    await indexer.initialize();

    // Zwolnij zapisy realnym, krótkim opóźnieniem (nie gate ręcznej blokady) - test odtwarza
    // przeplot z timera bez ręcznego sterowania każdym krokiem (jak w R1-R3).
    const realWriteBinary = vault.adapter.writeBinary.bind(vault.adapter);
    vault.adapter.writeBinary = async (path: string, data: ArrayBuffer) => {
        await new Promise(r => setTimeout(r, 3));
        return realWriteBinary(path, data);
    };

    const rebuildP = indexer.rebuild();
    const timerPersists: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 7));
        timerPersists.push(indexer._persistNow());
    }
    await rebuildP;
    await Promise.all(timerPersists);
    await indexer._persistNow(); // domyka wszystko, co timerowe persisty jeszcze zostawiły w _pending

    const meta = readMetaV2(store);
    const missing = [...files.keys()].filter(p => !(p in meta.rows));
    t.deepEqual(missing, [], 'KAŻDA notatka ma wiersz po rebuildzie - nic nie może zgubić się w przeplocie');
    const names = meta.segments.map(s => s.file);
    t.is(new Set(names).size, names.length, 'zero zdublowanych nazw segmentów mimo timerów w trakcie skanu');

    const c = newIndexer({ files, store, embedder: makeR4Embedder() });
    await c.indexer.initialize();
    t.is(c.embedder._calls.embedBatch, 0, 'restart po R4 nie re-embeduje - stan na dysku jest kompletny');
    t.is(countDocs(c.indexer.db), N);
    t.is(c.notices.filter(n => n.kind === 'index_corrupt').length, 0);
    indexer.dispose();
    c.indexer.dispose();
});

// ═══════════════════ Runda naprawcza 2 (recenzja fixu F1): G1/G2/G6 ═══════════════════
//
// G1 [WAŻNE]: notatka WYCZYSZCZONA (treść pusta) W OKNIE persistu dostawała na dysk STARY wektor.
// Warunek `_mtimes.has(path)` (round 1) przepuszczał ją: upsert z pustą treścią ZOSTAWIA mtime
// (nowy, ze stempla pustej notatki), ale kasuje wpis z `_pending`/`_rows` - `_mtimes.has()` mimo
// to dalej zwraca `true`. Naprawa: `_rows` dostaje wiersz TYLKO gdy referencja w `_pending`
// (albo `_rows`, dla kompakcji) jest WCIĄŻ tą samą co w migawce - jedyny sygnał, że nic nie
// tknęło tej ścieżki w oknie `await`.

test('G1: notatka wyczyszczona W OKNIE zwykłego zapisu nie dostaje na dysk STAREGO wektora', async t => {
    const store: FakeStore = new Map();
    const { indexer, files, vault, embedder } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();
    const gate = armWriteGate(vault);

    const oldVec = (await embedder.embed('Szybki samochód mknie po drodze'))!;
    files.set('car.md', { content: 'Nowy samochód', mtime: 200 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue(); // car.md w _pending (wektor "Nowy samochód")

    const p = indexer._persistNow(); // migawka _pending zawiera car.md - wejdzie w writeBinary i zawiśnie
    await tick();

    // W OKNIE: user CZYŚCI car.md (treść pusta) - upsert z pustą treścią stempluje NOWY mtime,
    // ale kasuje wpis z _pending/_rows (D8: pusta notatka nie ma wiersza).
    files.set('car.md', { content: '', mtime: 500 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();

    gate.open();
    await p;
    await indexer._persistNow(); // domyka to, co flush jeszcze zostawił (meta nie nadążyła w oknie)

    const meta = readMetaV2(store);
    t.falsy(meta.rows['car.md'], 'car.md wyczyszczona w oknie NIE MOŻE mieć wiersza (wskazywałby na STARY wektor "Nowy samochód")');
    t.is(meta.mtimes['car.md'], 500, 'mtime jest nowy (stempel pustej notatki), ale bez wiersza - D8');

    const res = await searchVectorTopK(indexer.db!, oldVec, { k: 1, similarity: 0 });
    t.not(res.hits[0]?.document?.path, 'car.md', 'pusta notatka NIE MOŻE wracać w wynikach semantycznych ze STARĄ treścią');

    const c = newIndexer({ files, store });
    await c.indexer.initialize();
    t.false(c.notices.some(n => n.kind === 'index_corrupt'));
    t.is(countDocs(c.indexer.db), 2, 'car.md pusta - bez wektora; 2 pozostałe notatki zaindeksowane');
    const res2 = await searchVectorTopK(c.indexer.db!, oldVec, { k: 1, similarity: 0 });
    t.not(res2.hits[0]?.document?.path, 'car.md', 'restart: stary wektor car.md też nie wraca');
    indexer.dispose();
    c.indexer.dispose();
});

test('G1: notatka wyczyszczona W OKNIE kompakcji nie dostaje na dysk STAREGO wektora', async t => {
    const store: FakeStore = new Map();
    const files = new Map<string, FakeFile>([
        ['a.md', { content: 'A0', mtime: 1 }],
        ['b.md', { content: 'B0', mtime: 1 }],
        ['c.md', { content: 'C0', mtime: 1 }],
        ['d.md', { content: 'D0', mtime: 1 }],
    ]);
    let seq = 0;
    const lastVectorForText = new Map<string, number[]>();
    const embedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 4,
        async embed(text: string) {
            if (!text.trim()) return null;
            seq++; const v = [Math.sin(seq), Math.cos(seq), seq, 1]; lastVectorForText.set(text, v); return v;
        },
        async embedBatch(texts: string[]) {
            this._calls.embedBatch++; this._calls.texts.push(...texts);
            return texts.map(t => {
                if (!t.trim()) return null; // notatka pusta (D8) - kontrakt embeddera: brak wektora
                seq++; const v = [Math.sin(seq), Math.cos(seq), seq, 1]; lastVectorForText.set(t, v); return v;
            });
        },
    };
    const { indexer, vault } = newIndexer({ files, store, embedder });
    await indexer.initialize();

    // Dopchaj do progu kompakcji (jak w R2) zmieniając a.md, aż `planCompaction` zapali się na TYM
    // konkretnym stanie - c.md/b.md/d.md zostają nietknięte, z wierszem z initial scanu.
    let mt = 10;
    for (let i = 0; i < 20; i++) {
        const meta = readMetaV2(store);
        const liveNow = new Set([...Object.keys(meta.rows), 'a.md']).size;
        if (planCompaction({ segments: meta.segments, liveRows: liveNow })) break;
        files.set('a.md', { content: `A${i}`, mtime: mt++ });
        indexer._onVaultEvent('modify', { path: 'a.md' });
        await indexer._flushQueue();
        await indexer._persistNow();
    }
    files.set('a.md', { content: 'A_final', mtime: mt++ });
    indexer._onVaultEvent('modify', { path: 'a.md' });
    await indexer._flushQueue();
    t.true(planCompaction({ segments: readMetaV2(store).segments, liveRows: 4 }), 'setup: następny persist MUSI pójść przez kompakcję');

    const oldVecC = lastVectorForText.get('C0')!; // c.md nigdy nie była zmieniana - wciąż oryginalny wektor
    const gate = armWriteGate(vault);
    const compactP = indexer._persistNow(); // kompakcja: czyta segmenty z dysku, potem zawiesza się na writeBinary
    await tick(); await tick(); await tick();

    // W OKNIE kompakcji: c.md (żywa notatka Z ISTNIEJĄCYM wierszem od initial scanu) zostaje
    // WYCZYSZCZONA.
    files.set('c.md', { content: '', mtime: 999 });
    indexer._onVaultEvent('modify', { path: 'c.md' });
    await indexer._flushQueue();

    gate.open();
    await compactP;
    await indexer._persistNow(); // domyka resztę, jeśli coś jeszcze czekało

    const meta = readMetaV2(store);
    t.falsy(meta.rows['c.md'], 'c.md wyczyszczona w oknie kompakcji NIE MOŻE mieć wiersza (wskazywałby na STARY wektor C0)');
    t.is(meta.mtimes['c.md'], 999, 'mtime jest nowy (stempel pustej notatki), ale bez wiersza - D8');

    const res = await searchVectorTopK(indexer.db!, oldVecC, { k: 1, similarity: 0 });
    t.not(res.hits[0]?.document?.path, 'c.md', 'pusta notatka NIE MOŻE wracać w wynikach semantycznych ze STARĄ treścią');

    const restartFiles = new Map(files);
    // Restart z embedderem TEGO SAMEGO modelu (model_key='m', dims=4) - `newIndexer()` bez
    // nadpisania `embedder` wraca do domyślnego (dims 3, inny model_key), co wymusiłoby
    // `model_changed` i rebuild zamiast testować odzyskanie z dysku.
    const restartEmbedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 4,
        async embed() { return null; },
        async embedBatch(texts: string[]) { this._calls.embedBatch++; this._calls.texts.push(...texts); return texts.map(() => null); },
    };
    const { indexer: r, notices } = newIndexer({ files: restartFiles, store, embedder: restartEmbedder });
    await r.initialize();
    t.false(notices.some(n => n.kind === 'index_corrupt'));
    const res2 = await searchVectorTopK(r.db!, oldVecC, { k: 1, similarity: 0 });
    t.not(res2.hits[0]?.document?.path, 'c.md', 'restart: stary wektor c.md też nie wraca');
    indexer.dispose();
    r.dispose();
});

// G2/M12: notatka SKASOWANA (hook 'delete') W OKNIE persistu - DOKŁADNIE ta ścieżka, której
// wektor jest w migawce `_pending` w chwili startu zapisu. Mutant M12 (recenzja) usuwa filtr i
// wpisuje wiersz dla KAŻDEJ ścieżki z migawki bezwarunkowo - `rows[path]` bez `mtimes[path]`
// (usunięcie kasuje oba) jest odrzucane przez `parseIndexMetaV2` jako `index_corrupt` na restarcie.
test('G2: notatka usunięta W OKNIE persistu (ta sama ścieżka co w migawce _pending) nie dostaje wiersza (kills M12)', async t => {
    const store: FakeStore = new Map();
    const { indexer, files, vault } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();
    const gate = armWriteGate(vault);

    files.set('car.md', { content: 'Nowy samochód', mtime: 200 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue(); // car.md w _pending

    const p = indexer._persistNow(); // migawka _pending zawiera car.md - wejdzie w writeBinary i zawiśnie
    await tick();

    // W OKNIE: car.md skasowana (hook delete) - DOKŁADNIE ta ścieżka, która jest w migawce.
    files.delete('car.md');
    indexer._onVaultEvent('delete', { path: 'car.md' });
    await indexer._flushQueue();

    gate.open();
    await p;

    const meta = readMetaV2(store);
    t.falsy(meta.rows['car.md'], 'car.md usunięta w oknie NIE MOŻE mieć wiersza mimo że jej wektor był w migawce persistu');
    t.falsy(meta.mtimes['car.md'], 'car.md usunięta w oknie NIE MOŻE mieć mtime');

    const c = newIndexer({ files, store });
    await c.indexer.initialize();
    t.is(c.indexer.getStatus().status, 'ready');
    t.false(c.notices.some(n => n.kind === 'index_corrupt'), 'restart po usunięciu w oknie nie może być index_corrupt');
    t.is(countDocs(c.indexer.db), 2, 'car.md nie wraca do indeksu po restarcie');
    indexer.dispose();
    c.indexer.dispose();
});

// G2/M13: `_metaDirty` musi wykryć mutację, która zaszła W OKNIE `await write(meta)` (licznik
// generacji `_gen` się zmienił) - inaczej (mutant M13: `_writeMetaTracked` zawsze zeruje
// `_metaDirty` po udanym zapisie, bez sprawdzania generacji) usunięcie z tego okna NIGDY nie
// dogania kolejnego persistu, bo `_persistNowInner`'s bramka (`_pending.size===0 && !_metaDirty`)
// zwraca się od razu.
test('G2: _metaDirty po usunięciu notatki W OKNIE zapisu meta - drugi persist zapisuje meta ponownie (kills M13)', async t => {
    const store: FakeStore = new Map();
    const { indexer, files, vault } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();

    files.set('car.md', { content: 'Nowy samochód', mtime: 200 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();

    let gate: Promise<void> | null = null;
    let release: () => void = () => {};
    let metaWriteCalls = 0;
    const metaPath = '.pkm-assistant/index/vault-index.meta.json';
    const realWrite = vault.adapter.write.bind(vault.adapter);
    vault.adapter.write = async (path: string, data: string) => {
        if (path === metaPath) {
            metaWriteCalls++;
            if (gate) await gate;
        }
        return realWrite(path, data);
    };
    gate = new Promise(r => { release = () => { gate = null; r(); }; });

    const p = indexer._persistNow(); // segment (car.md) zapisany bez przeszkód, wchodzi w write(meta) i zawiesza się
    await tick(); await tick(); await tick();
    t.is(metaWriteCalls, 1, 'setup: pierwszy zapis meta zdążył wystartować przed usunięciem');

    // W OKNIE zapisu META: sky.md skasowana.
    files.delete('sky.md');
    indexer._onVaultEvent('delete', { path: 'sky.md' });
    await indexer._flushQueue();

    release();
    await p;

    t.true((indexer as unknown as { _metaDirty: boolean })._metaDirty, '_metaDirty musi zostać true - _gen zmienił się w oknie write(meta)');

    await indexer._persistNow(); // drugi persist - MUSI napisać meta ponownie
    t.is(metaWriteCalls, 2, 'drugi persist faktycznie zapisał meta ponownie - inaczej sky.md nigdy nie zniknie z dysku');

    const meta = readMetaV2(store);
    t.falsy(meta.rows['sky.md']);
    t.falsy(meta.mtimes['sky.md']);

    const c = newIndexer({ files, store });
    await c.indexer.initialize();
    t.false(c.notices.some(n => n.kind === 'index_corrupt'));
    t.is(countDocs(c.indexer.db), 2);
    indexer.dispose();
    c.indexer.dispose();
});

// G2/M14: `rebuild()` wywołany PODCZAS trwającego persistu (stary model, 4D) MUSI poczekać na
// `_persistChain` PRZED resetem stanu - inaczej (mutant M14: `_persistNow` trzyma łańcuch w
// INNYM polu niż `_persistChain`, więc `rebuild()`'s `await this._persistChain` czeka na
// zawsze-rozwiązaną obietnicę) rebuild zapisuje 8D pod nogami niedokończonego zapisu 4D.
test('G2: rebuild() czeka na persist w toku PRZED resetem stanu - żadnego miksu 4D/8D (kills M14)', async t => {
    const store: FakeStore = new Map();
    const files = new Map<string, FakeFile>([
        ['a.md', { content: 'A', mtime: 1 }],
        ['b.md', { content: 'B', mtime: 1 }],
    ]);
    let dims = 4;
    const embedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => dims,
        async embed() { return Array.from({ length: dims }, (_, i) => i); },
        async embedBatch(texts: string[]) {
            this._calls.embedBatch++; this._calls.texts.push(...texts);
            return texts.map(() => Array.from({ length: dims }, (_, i) => Math.random() + i));
        },
    };
    const { indexer, vault } = newIndexer({ files, store, embedder });
    await indexer.initialize();

    files.set('a.md', { content: 'A2', mtime: 2 });
    indexer._onVaultEvent('modify', { path: 'a.md' });
    await indexer._flushQueue(); // a.md w _pending, wektor 4D

    const gate = armWriteGate(vault);
    const persistP = indexer._persistNow(); // wejdzie w writeBinary (4D) i zawiśnie na gate
    await tick();

    dims = 8; // "model się zmienił" - user kliknął Reindex z nowym modelem embeddingu
    const rebuildP = indexer.rebuild(); // MUSI poczekać na persistP (await _persistChain) przed resetem

    await tick(); await tick();
    gate.open();
    await persistP;
    const rebuilt = await rebuildP;

    t.is(rebuilt.status, 'ready');
    const meta = readMetaV2(store);
    t.is(meta.dims, 8, 'meta na dysku odzwierciedla NOWY wymiar po rebuildzie');
    for (const seg of meta.segments) {
        const buf = store.get(`.pkm-assistant/index/${seg.file}`) as ArrayBuffer;
        const decoded = decodeSegment(buf, meta.dims);
        t.truthy(decoded, `segment ${seg.file} musi być czytelny w 8D - żadnego miksu z niedokończonym zapisem 4D`);
    }

    const restartEmbedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 8,
        async embed() { return null; },
        async embedBatch(texts: string[]) { this._calls.embedBatch++; this._calls.texts.push(...texts); return texts.map(() => null); },
    };
    const c = newIndexer({ files, store, embedder: restartEmbedder });
    await c.indexer.initialize();
    t.is(restartEmbedder._calls.embedBatch, 0, 'restart nie re-embeduje - indeks 8D kompletny i spójny na dysku');
    t.is(c.indexer.getStatus().status, 'ready');
    t.false(c.notices.some(n => n.kind === 'index_corrupt'), 'restart po rebuildzie w trakcie persistu nie może być index_corrupt');
    t.is(countDocs(c.indexer.db), 2);
    indexer.dispose();
    c.indexer.dispose();
});

// G6: dispose() W TRAKCIE flusha (embedding trwa) nie może zostawić timer "zombie" - flush, który
// kończy się PO dispose() (unload pluginu w trakcie embeddingu), nie ma prawa uzbroić nowego
// zapisu na dysk.
test('G6: dispose() w trakcie flusha - flush zakończony PO dispose nie uzbraja nowego zapisu', async t => {
    const store: FakeStore = new Map();
    const files = baseFiles();
    const embedder = makeEmbedder();
    const { indexer, vault } = newIndexer({ files, store, embedder, persistDebounceMs: 10 });
    await indexer.initialize(); // skan startowy przez ZDROWY embedder - gate dokładamy DOPIERO teraz

    let resolveEmbed!: () => void;
    const gate = new Promise<void>(r => { resolveEmbed = r; });
    const zdrowy = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts: string[]) => { await gate; return zdrowy(texts); };

    let writeBinaryCalls = 0;
    const realWriteBinary = vault.adapter.writeBinary.bind(vault.adapter);
    vault.adapter.writeBinary = async (path: string, data: ArrayBuffer) => { writeBinaryCalls++; return realWriteBinary(path, data); };

    files.set('car.md', { content: 'Nowy samochód', mtime: 200 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    const flushP = indexer._flushQueue(); // zawiśnie na embedBatch (gate)

    indexer.dispose(); // "unload pluginu" w trakcie embeddingu
    resolveEmbed();
    await flushP; // flush kończy się PO dispose - insertuje car.md, woła _schedulePersist()

    await new Promise(r => setTimeout(r, 50)); // dłużej niż persistDebounceMs (10 ms)
    t.is(writeBinaryCalls, 0, 'zero zapisów segmentu po dispose(), mimo że flush zakończył się PO nim');
    t.is((indexer as unknown as { _persistTimer: unknown })._persistTimer, null, 'żaden nowy timer zapisu nie mógł zostać uzbrojony po dispose()');
    t.is((indexer as unknown as { _pending: Map<string, unknown> })._pending.size, 1, 'wektor car.md zostaje w pending - nic nie ginie, po prostu nie jest jeszcze na dysku');
});

// ═══════════════════ Format v2: segmenty + meta (SPEC B, sekcja 4) ═══════════════════

// a. Po initialize() na vaulcie z N notatkami (w tym 1 pusta): segment i meta liczą się
// zgodnie z D8 - wiersz TYLKO dla notatek z wektorem, mtime dla KAŻDEJ zaindeksowanej.
test('a. initialize(): segment + meta v2 liczą wiersze/mtimes zgodnie z D8', async t => {
    const store: FakeStore = new Map();
    const files = new Map<string, FakeFile>([
        ['car.md', { content: 'Szybki samochód', mtime: 100 }],
        ['notes/cat.md', { content: 'Mały kot', mtime: 100 }],
        ['sky.md', { content: 'Bezchmurne niebo', mtime: 100 }],
        ['empty.md', { content: '   ', mtime: 100 }],
    ]);
    const { indexer } = newIndexer({ files, store });
    await indexer.initialize();

    const meta = readMetaV2(store);
    t.is(meta.segments.length, 1);
    t.is(Object.keys(meta.rows).length, 3, 'tylko notatki z wektorem mają wiersz');
    t.is(Object.keys(meta.mtimes).length, 4, 'mtimes ma wpis dla KAŻDEJ zaindeksowanej notatki, także pustej');

    const buf = store.get(`.pkm-assistant/index/${meta.segments[0].file}`) as ArrayBuffer;
    t.is(buf.byteLength, 16 + 3 * meta.dims * 4);
});

// b. Zmiana jednej notatki po ready: nowy segment osobno, pierwszy segment bajt w bajt
// niezmieniony (niezmienność segmentów, D3).
test('b. zmiana notatki po ready: drugi segment, rows[path]=[1,0], pierwszy segment nietknięty', async t => {
    const store: FakeStore = new Map();
    const { indexer, files } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();

    const meta1 = readMetaV2(store);
    t.is(meta1.segments.length, 1);
    const seg1Path = `.pkm-assistant/index/${meta1.segments[0].file}`;
    const seg1Before = new Uint8Array((store.get(seg1Path) as ArrayBuffer).slice(0));

    files.set('car.md', { content: 'Zupełnie inny samochód', mtime: 555 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    await indexer._persistNow();

    const meta2 = readMetaV2(store);
    t.is(meta2.segments.length, 2);
    t.deepEqual(meta2.rows['car.md'], [1, 0]);
    t.is(meta2.segments[1].rows, 1);

    const seg2Buf = store.get(`.pkm-assistant/index/${meta2.segments[1].file}`) as ArrayBuffer;
    t.is(seg2Buf.byteLength, 16 + meta2.dims * 4);

    const seg1After = new Uint8Array(store.get(seg1Path) as ArrayBuffer);
    t.deepEqual(seg1After, seg1Before, 'pierwszy segment bajt w bajt niezmieniony');
});

// c. Restore v2: drugi indekser na tym samym store nie re-embeduje i daje ten sam wynik -
// pokrywa test 3 wyżej ("persist then restore..."), rozszerzony tam o `countDocs`.

// d. Kompakcja: kolejne persisty osobnych zmian zwijają segmenty do jednego bazowego.
test('d. kompakcja: kolejne osobne persisty zwijają segmenty do jednego', async t => {
    const store: FakeStore = new Map();
    const { indexer, files, embedder } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();

    for (let i = 0; i < 9; i++) {
        files.set('car.md', { content: `Samochód wersja ${i}`, mtime: 200 + i });
        indexer._onVaultEvent('modify', { path: 'car.md' });
        await indexer._flushQueue();
        await indexer._persistNow();
    }

    const meta = readMetaV2(store);
    t.is(meta.segments.length, 1, 'kompakcja zwinęła segmenty do jednego bazowego');
    const segmentEntries = [...store.keys()].filter(isSegmentFileName);
    t.deepEqual(segmentEntries, [`.pkm-assistant/index/${meta.segments[0].file}`], 'stare segmenty usunięte ze store');
    t.deepEqual(meta.rows['car.md'], [0, 0], 'posortowane po ścieżce: car.md < notes/cat.md < sky.md');
    t.is(new Set(Object.values(meta.rows).map(r => r[0])).size, 1, 'wszystkie wiersze w JEDNYM segmencie');

    const buf = store.get(`.pkm-assistant/index/${meta.segments[0].file}`) as ArrayBuffer;
    const decoded = decodeSegment(buf, meta.dims);
    t.truthy(decoded);
    t.is(decoded!.rows, Object.keys(meta.rows).length);

    // F3/M4 (mutant "kompakcja zapisuje wektory zerowe zamiast prawdziwych"): dekoduj KAŻDY
    // żywy wiersz z DYSKU (nie z Oramy w RAM - `insertVectorLean` trzyma osobną, żywą kopię
    // niezależną od tego, co faktycznie wylądowało w pliku) i porównaj z oczekiwanym wektorem
    // kategorii. `searchVectorTopK` niżej sam w sobie by tego NIE złapał - Orama w RAM ma
    // poprawny wektor niezależnie od tego, co zapisał `_persistCompact` na dysk.
    const expected: Record<string, number[]> = { 'car.md': [1, 0, 0], 'notes/cat.md': [0, 1, 0], 'sky.md': [0, 0, 1] };
    for (const [path, vec] of Object.entries(expected)) {
        const ref = meta.rows[path];
        t.truthy(ref, `${path} ma wiersz po kompakcji`);
        const row = decoded!.at(ref[1]);
        t.deepEqual(Array.from(row), vec.map(Math.fround), `${path}: wektor na dysku po kompakcji musi być PRAWDZIWY, nie zerowy`);
    }

    const qv = await embedder.embed('samochód');
    const res = await searchVectorTopK(indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
});

// e. Sierota: segment na dysku spoza meta jest sprzątany po udanym restore; inne pliki zostają.
// Wzmocnione (F3/M6 - mutant "cleanup kasuje też ŻYWE segmenty"): sam fakt, że `embedBatch` nie
// zostało wołane, nie dowodzi że plik przeżył NA DYSKU - `_restoreFromV2` buduje `db` w PAMIĘCI
// z segmentów PRZED sprzątaniem, więc mutant kasujący też żywe pliki nie zmieniłby wyniku TEGO
// restore. Dowodem jest TRZECI indekser, restartowany z tego samego store PO sprzątaniu.
test('e. sierota: segment spoza meta sprzątany po restore, żywy segment PRZEŻYWA na dysku, inne pliki zostają', async t => {
    const store: FakeStore = new Map();
    const a = newIndexer({ files: baseFiles(), store });
    await a.indexer.initialize();
    const liveSegFile = readMetaV2(store).segments[0].file;
    const liveSegPath = `.pkm-assistant/index/${liveSegFile}`;

    store.set('.pkm-assistant/index/vault-index.000099.vec', new ArrayBuffer(16));
    store.set('.pkm-assistant/index/notatka.txt', 'nie jest segmentem, zostaje');

    const b = newIndexer({ files: baseFiles(), store });
    await b.indexer.initialize();

    t.false(store.has('.pkm-assistant/index/vault-index.000099.vec'), 'sierota sprzątnięta');
    t.true(store.has('.pkm-assistant/index/notatka.txt'), 'plik o innej nazwie zostaje nietknięty');
    t.is(b.embedder._calls.embedBatch, 0, 'restore v2 nie re-embeduje');
    // Dowód na DYSKU (nie tylko w RAM tego indeksera) - żywy segment nadal tam jest.
    t.true(store.has(liveSegPath), 'M6: żywy segment MUSI przeżyć sprzątanie sierot');

    const c = newIndexer({ files: baseFiles(), store });
    await c.indexer.initialize();
    t.is(c.embedder._calls.embedBatch, 0, 'trzeci restart z tego samego store dalej nie re-embeduje - segment naprawdę przeżył');
    t.is(c.indexer.getStatus().status, 'ready');
});

// F4.5: `list()` bywa gołymi nazwami, nie tylko pełnymi ścieżkami. Bez naprawy `remove(norm)`
// próbowałby skasować plik w ROOCIE vaulta (błędna ścieżka) zamiast w katalogu indeksu - sierota
// zostawałaby na dysku NA ZAWSZE mimo pozornie udanego sprzątania.
test('F4.5: sprzątanie sierot działa też gdy list() oddaje GOŁE nazwy plików', async t => {
    const store: FakeStore = new Map();
    const removedPaths: string[] = [];
    const a = newIndexer({ files: baseFiles(), store, removedPaths });
    await a.indexer.initialize();
    const liveSegFile = readMetaV2(store).segments[0].file;

    store.set('.pkm-assistant/index/vault-index.000099.vec', new ArrayBuffer(16));

    const b = newIndexer({ files: baseFiles(), store, listShape: 'bare', removedPaths });
    await b.indexer.initialize();

    t.true(removedPaths.includes('.pkm-assistant/index/vault-index.000099.vec'),
        'remove() MUSI dostać ścieżkę z prefiksem katalogu indeksu, nie gołą nazwę');
    t.false(store.has('.pkm-assistant/index/vault-index.000099.vec'), 'sierota faktycznie zniknęła');
    t.true(store.has(`.pkm-assistant/index/${liveSegFile}`), 'żywy segment zostaje');
});

// f. Segment ucięty: restore pada, notify index_corrupt, pełny rebuild naprawia.
test('f. segment ucięty: restore false + notify index_corrupt, pełny rebuild naprawia', async t => {
    const store: FakeStore = new Map();
    const a = newIndexer({ files: baseFiles(), store });
    await a.indexer.initialize();
    const metaBefore = readMetaV2(store);
    const segPath = `.pkm-assistant/index/${metaBefore.segments[0].file}`;
    const original = store.get(segPath) as ArrayBuffer;
    store.set(segPath, original.slice(0, original.byteLength - 4));

    const b = newIndexer({ files: baseFiles(), store });
    await b.indexer.initialize();

    t.is(b.indexer.getStatus().status, 'ready', 'rebuild po korupcji musi się udać');
    t.deepEqual(b.indexer.getStatus().lastNotice, { kind: 'index_corrupt' });
    t.true(b.embedder._calls.embedBatch > 0, 'korupcja wymusza pełny re-embed');

    const metaAfter = readMetaV2(store);
    t.is(Object.keys(metaAfter.rows).length, 3);
});

// F2.5: scenariusz recenzenta (q1_nextseq_reuse) - model A → B → z powrotem do A, z padem
// zapisu meta w środku. Bez naprawy `_nextSeq` startowałoby od domyślnego `1` przy KAŻDYM
// restarcie, więc zapis modelu B nadpisałby PLIK `vault-index.000001.vec`, na który stara
// (nienadpisana, bo meta pada PRZED segmentem w kolejności zapisu... tu celowo PO) meta modelu A
// nadal by wskazywała - powrót do A cicho odczytałby wektory B pod kluczem A. Tu: prostszy,
// deterministyczny równoważnik - po nieudanym restore (inny model) + rebuildzie, ORYGINALNY
// plik `000001.vec` jest bajt w bajt nietknięty, a nowy segment ma WYŻSZY numer.
test('F2.5: po nieudanym restore (inny model) + rebuild, stary segment 000001.vec jest nietknięty, nowy ma wyższy numer', async t => {
    const store: FakeStore = new Map();
    const a = newIndexer({ files: baseFiles(), store, embedderOpts: { modelKey: 'ollama:A' } });
    await a.indexer.initialize();
    const metaA = readMetaV2(store);
    t.is(metaA.segments.length, 1);
    const seg1Path = `.pkm-assistant/index/${metaA.segments[0].file}`;
    t.is(metaA.segments[0].file, 'vault-index.000001.vec');
    const seg1Bytes = new Uint8Array((store.get(seg1Path) as ArrayBuffer).slice(0));

    // Model zmieniony na B - restore odrzuca (model_changed), pełny rebuild pisze NOWY segment.
    // Bez F2 to wołanie próbowałoby (przez domyślne `_nextSeq=1`) NADPISAĆ `vault-index.000001.vec`.
    const b = newIndexer({ files: baseFiles(), store, embedderOpts: { modelKey: 'ollama:B' } });
    await b.indexer.initialize();

    const seg1After = new Uint8Array(store.get(seg1Path) as ArrayBuffer);
    t.deepEqual(seg1After, seg1Bytes, 'oryginalny segment modelu A jest bajt w bajt nietknięty');

    const metaB = readMetaV2(store);
    t.is(metaB.segments.length, 1);
    t.not(metaB.segments[0].file, 'vault-index.000001.vec', 'model B dostaje NOWY numer segmentu, nie ten sam co A');
    t.true(metaB.next_seq > 1);
});

/** Buduje fixture v1: prawdziwy dump Oramy (create+insertVectorLean+save) dla 3 notatek 3D. */
async function buildV1Fixture(): Promise<string> {
    const db = await createEmbeddingDb({ id: 'string', path: 'string', title: 'string', mtime: 'number', embedding: 'vector[3]' });
    await insertVectorLean(db, { id: 'car.md', path: 'car.md', title: 'car', mtime: 100, embedding: [1, 0, 0] });
    await insertVectorLean(db, { id: 'notes/cat.md', path: 'notes/cat.md', title: 'cat', mtime: 100, embedding: [0, 1, 0] });
    await insertVectorLean(db, { id: 'sky.md', path: 'sky.md', title: 'sky', mtime: 100, embedding: [0, 0, 1] });
    return JSON.stringify(save(db));
}

/** Fixture vaulta odpowiadająca dokładnie fixture'owi v1 wyżej (mtimes 100, w tym pusta notatka). */
function migrationFiles(): Map<string, FakeFile> {
    return new Map<string, FakeFile>([
        ['car.md', { content: 'Szybki samochód', mtime: 100 }],
        ['notes/cat.md', { content: 'Mały kot', mtime: 100 }],
        ['sky.md', { content: 'Bezchmurne niebo', mtime: 100 }],
        ['empty.md', { content: '', mtime: 100 }],
    ]);
}

// g. Migracja v1 → v2: zero re-embedu, v1 usunięty, notify migrated, top-1 zachowany.
test('g. migracja v1 → v2: zero re-embedu, v1 usunięty, notify migrated, top-1 zachowany', async t => {
    const dump = await buildV1Fixture();
    const store: FakeStore = new Map();
    store.set('.pkm-assistant/index/vault-index.json', dump);
    store.set('.pkm-assistant/index/vault-index.meta.json', JSON.stringify({
        version: 1,
        model_key: 'openai:text-embedding-3-small',
        dims: 3,
        updated_at: 1,
        mtimes: { 'car.md': 100, 'notes/cat.md': 100, 'sky.md': 100, 'empty.md': 100 },
    }));

    const { indexer, embedder } = newIndexer({ files: migrationFiles(), store });
    await indexer.initialize();

    t.is(indexer.getStatus().status, 'ready');
    t.is(embedder._calls.embedBatch, 0, 'migracja nie re-embeduje - mtimes vaulta pasują do meta v1');
    t.false(store.has('.pkm-assistant/index/vault-index.json'), 'stary plik v1 usunięty po udanej migracji');

    const meta = readMetaV2(store);
    t.is(meta.version, 2);
    t.is(meta.segments.length, 1);
    t.true('empty.md' in meta.mtimes, 'pusta notatka bez wektora ma mtime w v2 (D8)');
    t.is(Object.keys(meta.rows).length, 3);

    const notice: IndexerNotice | null = indexer.getStatus().lastNotice;
    t.truthy(notice);
    t.is(notice?.kind, 'migrated');
    if (notice?.kind === 'migrated') t.true(notice.toBytes < notice.fromBytes);

    const qv = await embedder.embed('auto');
    const res = await searchVectorTopK(indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
});

// h. Migracja pada (zapis segmentu rzuca raz): v1 NADAL w store, notify migration_failed,
// rebuild naprawia, a po udanym persist rebuildu v1 w końcu usunięty.
test('h. migracja pada: v1 zostaje, notify migration_failed, rebuild naprawia i sprząta v1', async t => {
    const dump = await buildV1Fixture();
    const store: FakeStore = new Map();
    store.set('.pkm-assistant/index/vault-index.json', dump);
    store.set('.pkm-assistant/index/vault-index.meta.json', JSON.stringify({
        version: 1,
        model_key: 'openai:text-embedding-3-small',
        dims: 3,
        updated_at: 1,
        mtimes: { 'car.md': 100, 'notes/cat.md': 100, 'sky.md': 100 },
    }));

    const { indexer, embedder, vault } = newIndexer({ files: baseFiles(), store });
    let throwOnce = true;
    const realWriteBinary = vault.adapter.writeBinary.bind(vault.adapter);
    vault.adapter.writeBinary = async (path: string, data: ArrayBuffer) => {
        if (throwOnce) { throwOnce = false; throw new Error('dysk zajęty'); }
        return realWriteBinary(path, data);
    };

    await indexer.initialize();

    t.is(indexer.getStatus().status, 'ready', 'pad migracji musi skończyć się udanym rebuildem');
    t.is(indexer.getStatus().lastNotice?.kind, 'migration_failed');
    t.true(embedder._calls.embedBatch > 0, 'rebuild po padzie migracji re-embeduje od zera');
    t.false(store.has('.pkm-assistant/index/vault-index.json'), 'v1 sprzątnięty po udanym persist rebuildu');
});

// h2 (F3/F4.3, NOWY w rundzie naprawczej): pad WERYFIKACJI po zapisie (nie samego zapisu) -
// meta v2 jest już na dysku, ale odczyt zwrotny segmentu jest uszkodzony (adapter oddaje ucięty
// bufor). Rebuild NASTĘPUJĄCY po tym pad zie TEŻ musi paść (dostawca trwale zgaszony), inaczej
// jego własny udany persist posprząta v1 przez zwykłą, LEGALNĄ ścieżkę i test nie odróżni tego
// od mutantów M1/M2 (kasują v1 przedwcześnie) i M5 (`_verifyMigration` zawsze `true`).
test('h2. weryfikacja migracji pada (odczyt ucięty): v1 NIETKNIĘTY, meta v1 przywrócona, migration_failed(verify_failed); przy padającym rebuildzie v1 zostaje do końca', async t => {
    const dump = await buildV1Fixture();
    const store: FakeStore = new Map();
    const v1MetaText = JSON.stringify({
        version: 1,
        model_key: 'openai:text-embedding-3-small',
        dims: 3,
        updated_at: 1,
        mtimes: { 'car.md': 100, 'notes/cat.md': 100, 'sky.md': 100 },
    });
    store.set('.pkm-assistant/index/vault-index.json', dump);
    store.set('.pkm-assistant/index/vault-index.meta.json', v1MetaText);

    // Dostawca trwale zgaszony - migracja SAMA nie go woła (re-koduje wektory już obecne w v1),
    // ale REBUILD wywołany po jej padzie owszem, więc rebuild też musi paść (żadna legalna
    // ścieżka nie posprząta v1 po drodze i nie zamaskuje mutanta).
    const embedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'openai:text-embedding-3-small', getDims: () => null,
        async embed() { return null; },
        async embedBatch(texts: string[]) { this._calls.embedBatch++; this._calls.texts.push(...texts); throw new Error('dostawca zgaszony'); },
    };
    const { indexer, vault } = newIndexer({ files: baseFiles(), store, embedder });

    const realReadBinary = vault.adapter.readBinary.bind(vault.adapter);
    vault.adapter.readBinary = async (path: string) => {
        const buf = await realReadBinary(path);
        return buf.slice(0, buf.byteLength - 4); // ucięty o 4 bajty - decodeSegment go odrzuci
    };

    await indexer.initialize();

    const notice = indexer.getStatus().lastNotice;
    t.is(notice?.kind, 'migration_failed');
    if (notice?.kind === 'migration_failed') t.is(notice.reason, 'verify_failed');
    t.is(indexer.getStatus().status, 'error', 'rebuild po padzie migracji też pada - dostawca zgaszony');

    // M1/M2: v1 skasowany PRZEDWCZEŚNIE (przed/niezależnie od weryfikacji) - tu MUSI zostać.
    t.true(store.has('.pkm-assistant/index/vault-index.json'), 'v1 NIE MOŻE zniknąć, dopóki migracja nie jest potwierdzona odczytem');
    // F4.3: meta na dysku wraca do formatu v1 (przywrócona best-effort) - migracja może się
    // powtórzyć od zera przy następnym starcie zamiast zastać niespójną, częściową meta v2.
    const metaOnDisk = readText(store, '.pkm-assistant/index/vault-index.meta.json');
    t.is(metaOnDisk, v1MetaText, 'meta na dysku jest z powrotem DOKŁADNIE tekstem v1 sprzed migracji');
    // M5 (`_verifyMigration` zawsze `true`): status byłby 'ready' z notice 'migrated', nie
    // 'error' z 'migration_failed' - powyższe dwie asercje już to łapią, to kontrola dodatkowa.
    t.not(notice?.kind, 'migrated');
});

// G4 (runda naprawcza 2): pad ZAPISU meta v2 samego w sobie (nie tylko weryfikacji, jak w h2)
// zostawiał śmieci na dysku zamiast tekstu v1 - `write()` może przerwać się W TRAKCIE (dysk pełny
// w połowie stringa) i JEDNOCZEŚNIE rzucić, więc `catch` musi przywrócić v1 best-effort tak samo
// jak pad weryfikacji. Dostawca zgaszony na CAŁY test (jak w h2): migracja sama go nie woła, ale
// fallback `_fullScan()` uruchomiony PO padzie migracji owszem - MUSI paść, inaczej jego WŁASNY
// udany persist nadpisałby meta jeszcze raz i zamaskował to, co ten test sprawdza (tekst v1
// przywrócony przez SAM `_migrateV1`, nie przez późniejszy legalny zapis).
test('G4: pad ZAPISU meta v2 w migracji (nie tylko weryfikacji) przywraca tekst v1 - migracja może się powtórzyć', async t => {
    const dump = await buildV1Fixture();
    const store: FakeStore = new Map();
    const v1MetaText = JSON.stringify({
        version: 1,
        model_key: 'openai:text-embedding-3-small',
        dims: 3,
        updated_at: 1,
        mtimes: { 'car.md': 100, 'notes/cat.md': 100, 'sky.md': 100 },
    });
    store.set('.pkm-assistant/index/vault-index.json', dump);
    store.set('.pkm-assistant/index/vault-index.meta.json', v1MetaText);

    const embedder: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'openai:text-embedding-3-small', getDims: () => null,
        async embed() { return null; },
        async embedBatch(texts: string[]) { this._calls.embedBatch++; this._calls.texts.push(...texts); throw new Error('dostawca zgaszony'); },
    };
    const { indexer, vault } = newIndexer({ files: baseFiles(), store, embedder });

    let once = true;
    const realWrite = vault.adapter.write.bind(vault.adapter);
    vault.adapter.write = async (path: string, data: string) => {
        if (once && path.endsWith('meta.json')) {
            once = false;
            await realWrite(path, '{"version":2,"mo'); // zapis PRZERWANY w połowie - śmieci na dysku
            throw new Error('ENOSPC');
        }
        return realWrite(path, data);
    };

    await indexer.initialize();

    const notice = indexer.getStatus().lastNotice;
    t.is(notice?.kind, 'migration_failed');
    if (notice?.kind === 'migration_failed') t.is(notice.reason, 'meta_write');
    t.is(indexer.getStatus().status, 'error', 'fallback full scan po padzie migracji też pada - dostawca zgaszony');

    t.true(store.has('.pkm-assistant/index/vault-index.json'), 'v1 zostaje - migracja nie doszła do potwierdzonego zapisu');
    const metaOnDisk = readText(store, '.pkm-assistant/index/vault-index.meta.json');
    t.is(metaOnDisk, v1MetaText, 'meta na dysku wraca DOKŁADNIE do tekstu v1 - nie zostają śmieci z przerwanego zapisu, migracja może się powtórzyć od zera');
});

// i. Dims zmienione na żywo (po ready): notify dims_changed, DOKŁADNIE jeden rebuild.
test('i. dims zmienione na żywo po ready: notify dims_changed, jeden rebuild, meta.dims aktualne', async t => {
    const store: FakeStore = new Map();
    let liveDims = 3;
    let calls = 0;
    const embedder = makeEmbedder();
    const healthy = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts: string[]) => {
        calls++;
        if (liveDims === 3) return healthy(texts);
        return texts.map(txt => (txt.trim() ? Array.from({ length: liveDims }, (_, i) => (i === 0 ? 1 : 0)) : null));
    };

    const { indexer, files, notices } = newIndexer({ files: baseFiles(), store, embedder });
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'ready');
    t.is(indexer.dims, 3);
    const callsAfterScan = calls;

    liveDims = 8;
    files.set('car.md', { content: 'Nowy samochód', mtime: 999 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();

    t.deepEqual(indexer.getStatus().lastNotice, { kind: 'dims_changed', from: 3, to: 8 });
    // M7 (mutant recenzenta): `_notify` przechwycone tak, żeby `dims_changed` ustawiało TYLKO
    // `lastNotice`, bez wołania callbacku UI wstrzykniętego z zewnątrz (`deps.notify`) - user
    // nigdy nie zobaczyłby Notice. Asercja na `notices` (kanał zewnętrzny), nie tylko na
    // `getStatus().lastNotice` (kanał wewnętrzny), łapie ten mutant.
    t.true(notices.some(n => n.kind === 'dims_changed' && n.from === 3 && n.to === 8),
        'callback notify() z deps MUSI dostać dims_changed, nie tylko getStatus().lastNotice');
    t.is(indexer.getStatus().status, 'ready');
    t.is(indexer.dims, 8);

    const meta = readMetaV2(store);
    t.is(meta.dims, 8);
    // Skan początkowy (1 porcja) + 1 flush (rozjazd, rzuca) + rebuild (1 porcja) = +2, nie więcej.
    t.is(calls, callsAfterScan + 2, 'embedBatch NIE jest wołane w pętli ponowień');
});

// F4.2: dostawca oscylujący między dwoma wymiarami pokazuje UI powiadomienie TYLKO RAZ na
// sesję dla danej (nieuporządkowanej) pary - inaczej flip-flop zasypywałby usera tym samym
// Notice w kółko. Rebuild i log warn nadal lecą za KAŻDYM razem (nie testujemy tu warn - log
// idzie do atrapy loggera przekazanej przez `newIndexer`, nie do `warns` w tym pliku).
test('F4.2: dims flip-flop 3⇄8 pokazuje UI powiadomienie tylko raz na sesję na parę', async t => {
    const store: FakeStore = new Map();
    let liveDims = 3;
    const embedder = makeEmbedder();
    const healthy = embedder.embedBatch.bind(embedder);
    embedder.embedBatch = async (texts: string[]) => {
        if (liveDims === 3) return healthy(texts);
        return texts.map(txt => (txt.trim() ? Array.from({ length: liveDims }, (_, i) => (i === 0 ? 1 : 0)) : null));
    };

    const { indexer, files, notices } = newIndexer({ files: baseFiles(), store, embedder });
    await indexer.initialize();

    // 3 → 8 (pierwsza notyfikacja tej pary)
    liveDims = 8;
    files.set('car.md', { content: 'A', mtime: 900 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    t.is(indexer.dims, 8);

    // 8 → 3 (para {3,8} odwrócona - TA SAMA nieuporządkowana para, druga notyfikacja stłumiona)
    liveDims = 3;
    files.set('car.md', { content: 'B', mtime: 901 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    t.is(indexer.dims, 3);

    // 3 → 8 jeszcze raz (trzecia notyfikacja tej samej pary - dalej stłumiona)
    liveDims = 8;
    files.set('car.md', { content: 'C', mtime: 902 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    t.is(indexer.dims, 8);

    const dimsNotices = notices.filter(n => n.kind === 'dims_changed');
    t.is(dimsNotices.length, 1, 'user widzi Notice o dims_changed dokładnie raz na sesję dla tej pary');
    indexer.dispose();
});

// F4.1: `_resync()` wykrywa rozjazd dims i sam odpala `rebuild()` - ale co, gdy TEN rebuild
// SAM pada (dostawca zgaszony akurat w trakcie)? Bez naprawy `initialize()` bezwarunkowo
// nadpisywał status na 'ready' PO `_resync()`, ukrywając awarię rebuildu na dobre - user widział
// "Aktywne", a indeks nigdy nie dostał ponowienia.
test('F4.1: rozjazd dims w resync + rebuild, który SAM pada → status error, bez cichego "ready", scan retry uzbrojony', async t => {
    const files = new Map<string, FakeFile>();
    for (let i = 0; i < 6; i++) files.set(`n${i}.md`, { content: `tekst ${i}`, mtime: 1 });
    const store: FakeStore = new Map();

    // Bieg 1: indeks 4D zdrowy.
    const e4: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 4,
        async embed() { return null; },
        async embedBatch(t2: string[]) { return t2.map((_, i) => [1, i, 0, 0]); },
    };
    const a = newIndexer({ files, store, embedder: e4, batchSize: 2 });
    await a.indexer.initialize();
    t.is(a.indexer.getStatus().status, 'ready');
    const dimsBefore = a.indexer.dims;

    // Bieg 2: jeden plik zmieniony, dostawca teraz 8D (rozjazd na żywym indeksie w _resync) -
    // resync rzuca DimsRebuildTriggered → rebuild() odpala pełny skan 8D, ale TA porcja
    // embeddingu jest zgaszona (transport padnięty) → rebuild sam kończy się 'error'.
    files.set('n0.md', { content: 'zmiana', mtime: 2 });
    let call = 0;
    const e8: FakeEmbedder = {
        _calls: { embedBatch: 0, texts: [] }, isReady: () => true, getModelKey: () => 'm', getDims: () => 8,
        async embed() { return null; },
        async embedBatch(t2: string[]) {
            call++;
            if (call === 1) return t2.map(() => Array(8).fill(0.1)); // resync: ustala rozjazd
            throw Object.assign(new Error('ECONNREFUSED'), { kind: 'transport' }); // rebuild: dostawca zgaszony
        },
    };
    const b = newIndexer({ files, store, embedder: e8, batchSize: 2, scanRetryMs: 5 });
    await b.indexer.initialize();

    const status = b.indexer.getStatus();
    t.is(status.status, 'error', 'rebuild wywołany przez rozjazd dims sam padł - status MUSI to pokazać');
    t.truthy(status.lastError);
    t.false(b.indexer._ready, '_ready zostaje false - jak przy padzie całego skanu');
    t.is(b.indexer.dims, dimsBefore, 'stary (przywrócony przez rebuild().catch) dims 4D zostaje - rebuild 8D nie doszedł do końca');
    t.true(status.lastNotice?.kind === 'dims_changed', 'notify dims_changed poleciał mimo że rebuild potem padł');
    t.truthy(b.indexer['_scanRetryTimer'], 'ponowienie całego skanu MUSI być uzbrojone, jak przy zwykłym padzie skanu');
    b.indexer.dispose();
});

// j. patrz test „changing model_key forces a full rebuild" wyżej - rozszerzony o asercję `notify`.

// k. Pad zapisu segmentu: pending nie ginie, następny persist dowozi ten sam wiersz.
test('k. pad zapisu segmentu: pending nie ginie, kolejny persist dowozi ten sam wiersz (na DYSKU, przeżywa restart)', async t => {
    const store: FakeStore = new Map();
    const { indexer, files, vault } = newIndexer({ files: baseFiles(), store });
    await indexer.initialize();

    let throwOnce = true;
    const realWriteBinary = vault.adapter.writeBinary.bind(vault.adapter);
    vault.adapter.writeBinary = async (path: string, data: ArrayBuffer) => {
        if (throwOnce) { throwOnce = false; throw new Error('dysk zajęty'); }
        return realWriteBinary(path, data);
    };

    files.set('car.md', { content: 'Nowy samochód', mtime: 500 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();
    await indexer._persistNow(); // zapis segmentu pada - stan nietknięty

    let meta = readMetaV2(store);
    t.not(meta.mtimes['car.md'], 500, 'zapis padł — meta na dysku wciąż sprzed zmiany');

    await indexer._persistNow(); // ponowienie - bez awarii
    meta = readMetaV2(store);
    t.is(meta.mtimes['car.md'], 500, 'ponowiony persist dowozi ten sam wiersz');

    // F3/M3 (mutant "pad writeBinary gubi oczekujące wiersze"): dowód na BAJTACH z dysku, nie
    // tylko na Oramie w RAM (`insertVectorLean` już miał poprawny wektor od chwili _insertOne,
    // niezależnie od tego, czy persist kiedykolwiek doszedł do skutku - `searchVectorTopK` na
    // `indexer.db` NIE odróżniłoby udanego zapisu od zgubionego pendingu).
    const ref = meta.rows['car.md'];
    t.truthy(ref, 'car.md ma wiersz po ponowionym persiście');
    const segBuf = store.get(`.pkm-assistant/index/${meta.segments[ref[0]].file}`) as ArrayBuffer;
    const decoded = decodeSegment(segBuf, meta.dims);
    const onDisk = Array.from(decoded!.at(ref[1]));
    const expected = (await indexer.embedder.embed!('Nowy samochód'))!.map(Math.fround);
    t.deepEqual(onDisk, expected, 'wektor NA DYSKU (nie tylko w RAM) musi być ten, który embedder faktycznie zwrócił');

    const qv = await indexer.embedder.embed!('samochód');
    const res = await searchVectorTopK(indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
    indexer.dispose();

    // Restart z tego samego store I tym samym stanem vaulta (car.md dalej na mtime 500 - inaczej
    // resync widziałby rozjazd i re-embedowałby car.md, maskując dokładnie to, co ten test
    // sprawdza) — jeśli pending zostałby zgubiony (M3), wiersz albo by nie istniał, albo niósłby
    // stary wektor sprzed zmiany; restore v2 czyta WYŁĄCZNIE z dysku.
    const c = newIndexer({ files, store });
    await c.indexer.initialize();
    t.is(c.embedder._calls.embedBatch, 0, 'restore v2 - zero re-embedu');
    const res2 = await searchVectorTopK(c.indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res2.hits[0].document.path, 'car.md');
    c.indexer.dispose();
});
