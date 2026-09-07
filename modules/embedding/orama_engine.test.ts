import test from 'ava';
import type { AnySchema } from '@orama/orama';
import {
    createEmbeddingDb,
    insertVector,
    insertVectorLean,
    stripStoredVectors,
    insertBatch,
    removeVector,
    searchVectorTopK,
    searchText,
    serialize,
    deserialize,
    persist,
    restore,
    defaultVaultSchema,
    defaultMemorySchema,
    DEFAULT_VECTOR_DIM,
} from './orama_engine.js';
import type { OramaReader, OramaWriter } from './orama_engine.js';

const tinySchema: AnySchema = {
    id: 'string',
    path: 'string',
    body: 'string',
    embedding: 'vector[3]',
};

// AVA odpala testy concurrent — Orama może mutate doc objects podczas insert.
// Każdy test musi dostać świeże kopie, inaczej race condition (null.length).
const fresh = () => ({
    a: { id: 'a', path: 'note-a.md', body: 'red apple', embedding: [1, 0, 0] },
    b: { id: 'b', path: 'note-b.md', body: 'green apple', embedding: [0.9, 0.1, 0] },
    c: { id: 'c', path: 'note-c.md', body: 'blue sky', embedding: [0, 0, 1] },
});

test('createEmbeddingDb returns Orama db with schema', async t => {
    const db = await createEmbeddingDb(tinySchema);
    t.truthy(db);
    t.is(typeof db.id, 'string');
});

test('insertVector + searchVectorTopK round-trip top-1', async t => {
    const { a, b, c } = fresh();
    const db = await createEmbeddingDb(tinySchema);
    await insertVector(db, a);
    await insertVector(db, b);
    await insertVector(db, c);

    const result = await searchVectorTopK(db, [1, 0, 0], { k: 1, similarity: 0 });
    t.is(result.hits.length, 1);
    t.is(result.hits[0].document.id, 'a');
});

test('insertBatch + searchVectorTopK ranks by similarity', async t => {
    const { a, b, c } = fresh();
    const db = await createEmbeddingDb(tinySchema);
    await insertBatch(db, [a, b, c]);

    const result = await searchVectorTopK(db, [1, 0, 0], { k: 3, similarity: 0 });
    t.is(result.hits.length, 3);
    t.is(result.hits[0].document.id, 'a');
    t.is(result.hits[1].document.id, 'b');
    t.is(result.hits[2].document.id, 'c');
});

test('removeVector deletes a document by id and it disappears from search', async t => {
    const { a, b, c } = fresh();
    const db = await createEmbeddingDb(tinySchema);
    await insertBatch(db, [a, b, c]);

    const removed = await removeVector(db, 'a');
    t.true(removed);

    const result = await searchVectorTopK(db, [1, 0, 0], { k: 3, similarity: 0 });
    const ids = result.hits.map(h => h.document.id);
    t.false(ids.includes('a'));
    t.true(ids.includes('b'));
});

test('removeVector on a missing id is a no-op (returns false)', async t => {
    const db = await createEmbeddingDb(tinySchema);
    const removed = await removeVector(db, 'does-not-exist');
    t.false(removed);
});

test('searchText (BM25) finds docs by body term', async t => {
    const { a, b, c } = fresh();
    const db = await createEmbeddingDb(tinySchema);
    await insertBatch(db, [a, b, c]);

    const result = await searchText(db, 'apple', { limit: 5 });
    t.true(result.hits.length >= 2);
    const ids = result.hits.map(h => h.document.id).sort();
    t.true(ids.includes('a'));
    t.true(ids.includes('b'));
});

test('serialize + deserialize round-trip preserves docs', async t => {
    const { a, b, c } = fresh();
    const db = await createEmbeddingDb(tinySchema);
    await insertBatch(db, [a, b, c]);

    const raw = await serialize(db);
    const restored = await deserialize(raw, tinySchema);

    const result = await searchVectorTopK(restored, [0, 0, 1], { k: 1, similarity: 0 });
    t.is(result.hits.length, 1);
    t.is(result.hits[0].document.id, 'c');
});

test('persist + restore via writer/reader callbacks', async t => {
    const { a, b } = fresh();
    const db = await createEmbeddingDb(tinySchema);
    await insertBatch(db, [a, b]);

    const store = new Map<string, string>();
    const writer: OramaWriter = async (path, json) => store.set(path, json);
    const reader: OramaReader = async path => store.get(path) as string;

    await persist(db, writer, '/orama/vault.json');
    t.true(store.has('/orama/vault.json'));

    const restored = await restore(reader, '/orama/vault.json', tinySchema);
    const result = await searchVectorTopK(restored, [1, 0, 0], { k: 1, similarity: 0 });
    t.is(result.hits[0].document.id, 'a');
});

test('persist throws when writer is not a function', async t => {
    const db = await createEmbeddingDb(tinySchema);
    await t.throwsAsync(() => persist(db, null as unknown as OramaWriter, '/x.json'), { message: /writer must be a function/ });
});

test('restore throws when reader is not a function', async t => {
    await t.throwsAsync(() => restore(null as unknown as OramaReader, '/x.json', tinySchema), { message: /reader must be a function/ });
});

test('defaultVaultSchema has required Layer 1+2+3 fields', t => {
    t.is(typeof defaultVaultSchema.path, 'string');
    t.is(typeof defaultVaultSchema.body, 'string');
    t.is(defaultVaultSchema.embedding, `vector[${DEFAULT_VECTOR_DIM}]`);
    t.is(defaultVaultSchema.yaml_tags, 'string[]');
    t.is(defaultVaultSchema.outgoing_links, 'string[]');
});

test('defaultMemorySchema has memory-specific fields', t => {
    t.is(typeof defaultMemorySchema.agent, 'string');
    t.is(typeof defaultMemorySchema.type, 'string');
    t.is(defaultMemorySchema.embedding, `vector[${DEFAULT_VECTOR_DIM}]`);
});

// ── AUD-wydajnosc-088/041: wektor tylko w `index.vectorIndexes` ──────────────
//
// Orama trzyma każdy wektor DWA RAZY (indeks wektorowy + kopia w dokumencie w docs-store),
// a tej drugiej kopii nie czyta ani plugin, ani sama Orama — przy każdym `searchVector`
// nadpisuje ją `null`. Testy jadą na PRAWDZIWEJ Oramie z `node_modules`.

const bigSchema: AnySchema = { id: 'string', path: 'string', embedding: 'vector[64]' };

/**
 * N syntetycznych dokumentów o 64 wymiarach — deterministyczne, ale z PEŁNĄ precyzją
 * zmiennoprzecinkową, tak jak realne embeddingi. Krótkie wartości typu `0.12` zafałszowałyby
 * pomiar: kopia w docs-store serializuje liczbę wejściową, a `vectorIndexes` — jej odpowiednik
 * po Float32 (0.11999999731779099), więc na „ładnych" liczbach dubel wygląda na tańszy.
 */
function synthetic(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        id: `n/${i}.md`,
        path: `n/${i}.md`,
        embedding: Array.from({ length: 64 }, (_, d) => Math.sin(i * 0.37 + d * 1.11) * 0.5),
    }));
}

/** Kopia wektora do zapytania — `insert` trzyma dokument PRZEZ REFERENCJĘ (gotcha 2). */
function queryVector(i: number): number[] {
    return [...synthetic(i + 1)[i].embedding];
}

test('insertVectorLean nie zostawia drugiej kopii wektora w serializacji', async t => {
    const db = await createEmbeddingDb(bigSchema);
    for (const doc of synthetic(50)) await insertVectorLean(db, doc);

    const raw = await serialize(db) as { docs: { docs: Record<string, { embedding: unknown; path: string }> } };
    const docs = Object.values(raw.docs.docs);
    t.is(docs.length, 50);
    t.true(docs.every(d => d.embedding === null), 'kopia wektora nadal siedzi w docs-store');
    t.true(docs.every(d => typeof d.path === 'string'), 'reszta pól dokumentu nietknięta');
});

test('lean vs gruby: serializacja chudnie ~o połowę, wynik szukania IDENTYCZNY', async t => {
    const query = queryVector(0);

    const gruby = await createEmbeddingDb(bigSchema);
    for (const doc of synthetic(200)) await insertVector(gruby, doc);
    const grubyJson = JSON.stringify(await serialize(gruby));

    const chudy = await createEmbeddingDb(bigSchema);
    for (const doc of synthetic(200)) await insertVectorLean(chudy, doc);
    const chudyJson = JSON.stringify(await serialize(chudy));

    t.true(chudyJson.length < grubyJson.length * 0.6,
        `chudy ${chudyJson.length} B vs gruby ${grubyJson.length} B — kopia nadal jest w pliku`);

    const a = await searchVectorTopK(gruby, query, { k: 3, similarity: 0 });
    const b = await searchVectorTopK(chudy, query, { k: 3, similarity: 0 });
    t.deepEqual(b.hits.map(h => h.document.path), a.hits.map(h => h.document.path));
    t.deepEqual(b.hits.map(h => h.score), a.hits.map(h => h.score));
});

test('remove() po wyzerowaniu kopii nadal kasuje wektor z vectorIndexes', async t => {
    const db = await createEmbeddingDb(bigSchema);
    const query = queryVector(3);
    for (const doc of synthetic(10)) await insertVectorLean(db, doc);

    t.true(await removeVector(db, 'n/3.md'));
    const res = await searchVectorTopK(db, query, { k: 10, similarity: 0 });
    t.false(res.hits.some(h => h.document?.path === 'n/3.md'), 'usunięty dokument dalej wypływa z indeksu wektorowego');
    t.true(res.hits.length > 0, 'reszta indeksu wektorowego przeżyła kasację jednego dokumentu');
});

test('lean przeżywa round-trip przez dysk (persist → restore → search)', async t => {
    const db = await createEmbeddingDb(bigSchema);
    const query = queryVector(5);
    for (const doc of synthetic(20)) await insertVectorLean(db, doc);

    let saved = '';
    await persist(db, (_p, json) => { saved = json; }, '/idx.json');
    const back = await restore(() => saved, '/idx.json', bigSchema);
    const res = await searchVectorTopK(back, query, { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'n/5.md');
});

test('stripStoredVectors odchudza indeks wczytany ze starego, grubego pliku', async t => {
    const db = await createEmbeddingDb(bigSchema);
    for (const doc of synthetic(15)) await insertVector(db, doc); // stara droga = z kopiami

    t.is(stripStoredVectors(db), 15);
    t.is(stripStoredVectors(db), 0, 'drugi przebieg nie ma już czego zdejmować (idempotencja)');
    const raw = await serialize(db) as { docs: { docs: Record<string, { embedding: unknown }> } };
    t.true(Object.values(raw.docs.docs).every(d => d.embedding === null));
    t.is(stripStoredVectors(null), 0, 'brak db nie wywraca wołacza');

    // Semantyka po odchudzeniu działa (wektory żyją w vectorIndexes).
    const res = await searchVectorTopK(db, queryVector(7), { k: 1, similarity: 0 });
    t.is(res.hits[0].document.path, 'n/7.md');
});
