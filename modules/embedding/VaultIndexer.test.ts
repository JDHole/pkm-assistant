import test from 'ava';
import { save } from '@orama/orama';
import { VaultIndexer } from './VaultIndexer.js';
import type { EmbedderFacade, IndexerPluginLike, IndexerNotice, VaultFileLike, VaultLike } from './VaultIndexer.js';
import { createEmbeddingDb, insertVectorLean, searchVectorTopK, countDocs } from './orama_engine.js';
import { decodeSegment, isSegmentFileName } from './indexStore.js';
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

// ── Fake vault: content files w `files`, persystencja indeksu w `store` ──
function makeVault(files: FakeFiles, store: FakeStore = new Map()): { vault: VaultLike; store: FakeStore; files: FakeFiles } {
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
        async remove(path: string) { store.delete(path); },
        async list(path: string) {
            const prefix = path.replace(/\/$/, '') + '/';
            const out: string[] = [];
            for (const key of store.keys()) {
                if (!key.startsWith(prefix)) continue;
                if (key.slice(prefix.length).includes('/')) continue;
                out.push(key);
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
    /** Nazwa folderu konfiguracji Obsidiana; pominięta = vault jej NIE zna (fail-closed). */
    configDir?: string;
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
    const { vault } = makeVault(files, store);
    if (overrides.configDir !== undefined) vault.configDir = overrides.configDir;
    const embedder = overrides.embedder || makeEmbedder(overrides.embedderOpts);
    const plugin = overrides.plugin || makePlugin();
    const indexer = new VaultIndexer({
        plugin,
        vault,
        embedder,
        isMobile: !!overrides.isMobile,
        noGoFolders: overrides.noGoFolders || [],
        artifactsExclude: overrides.artifactsExclude,
        debounceMs: overrides.debounceMs ?? 5,
        persistDebounceMs: 5,
        // Ponowienia porcji natychmiastowe (inaczej każdy test awarii czeka 2 s + 4 s),
        // a automatyczne ponowienie skanu tak dalekie, że nigdy nie wystrzeli w teście.
        embedRetryMs: 1,
        scanRetryMs: 60_000,
        now: overrides.now ?? (() => 999),
    });
    return { indexer, files, store, vault, embedder, plugin };
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

    const qv = await embedder.embed('samochód');
    const res = await searchVectorTopK(indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
});

// e. Sierota: segment na dysku spoza meta jest sprzątany po udanym restore; inne pliki zostają.
test('e. sierota: segment spoza meta sprzątany po restore, inne pliki zostają', async t => {
    const store: FakeStore = new Map();
    const a = newIndexer({ files: baseFiles(), store });
    await a.indexer.initialize();

    store.set('.pkm-assistant/index/vault-index.000099.vec', new ArrayBuffer(16));
    store.set('.pkm-assistant/index/notatka.txt', 'nie jest segmentem, zostaje');

    const b = newIndexer({ files: baseFiles(), store });
    await b.indexer.initialize();

    t.false(store.has('.pkm-assistant/index/vault-index.000099.vec'), 'sierota sprzątnięta');
    t.true(store.has('.pkm-assistant/index/notatka.txt'), 'plik o innej nazwie zostaje nietknięty');
    t.is(b.embedder._calls.embedBatch, 0, 'restore v2 nie re-embeduje');
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

    const { indexer, files } = newIndexer({ files: baseFiles(), store, embedder });
    await indexer.initialize();
    t.is(indexer.getStatus().status, 'ready');
    t.is(indexer.dims, 3);
    const callsAfterScan = calls;

    liveDims = 8;
    files.set('car.md', { content: 'Nowy samochód', mtime: 999 });
    indexer._onVaultEvent('modify', { path: 'car.md' });
    await indexer._flushQueue();

    t.deepEqual(indexer.getStatus().lastNotice, { kind: 'dims_changed', from: 3, to: 8 });
    t.is(indexer.getStatus().status, 'ready');
    t.is(indexer.dims, 8);

    const meta = readMetaV2(store);
    t.is(meta.dims, 8);
    // Skan początkowy (1 porcja) + 1 flush (rozjazd, rzuca) + rebuild (1 porcja) = +2, nie więcej.
    t.is(calls, callsAfterScan + 2, 'embedBatch NIE jest wołane w pętli ponowień');
});

// j. patrz test „changing model_key forces a full rebuild" wyżej - rozszerzony o asercję `notify`.

// k. Pad zapisu segmentu: pending nie ginie, następny persist dowozi ten sam wiersz.
test('k. pad zapisu segmentu: pending nie ginie, kolejny persist dowozi ten sam wiersz', async t => {
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

    const qv = await indexer.embedder.embed!('samochód');
    const res = await searchVectorTopK(indexer.db!, qv!, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'car.md');
    indexer.dispose();
});
