import test from 'ava';
import { create, insert, save } from '@orama/orama';
import {
    encodeSegment,
    decodeSegment,
    parseIndexMetaV2,
    parseIndexMetaV1,
    planCompaction,
    extractV1Vectors,
    segmentFileName,
    isSegmentFileName,
} from './indexStore.js';
import type { SegmentRef } from './indexStore.js';

// ─────────────────────────── segmentFileName / isSegmentFileName ───────────────────────────

test('segmentFileName pada zerami do 6 cyfr', t => {
    t.is(segmentFileName(1), 'vault-index.000001.vec');
    t.is(segmentFileName(42), 'vault-index.000042.vec');
    t.is(segmentFileName(123456), 'vault-index.123456.vec');
});

test('isSegmentFileName dopasowuje gołą nazwę i pełną ścieżkę, odrzuca resztę', t => {
    t.true(isSegmentFileName('vault-index.000001.vec'));
    t.true(isSegmentFileName('.pkm-assistant/index/vault-index.000042.vec'));
    t.false(isSegmentFileName('vault-index.meta.json'));
    t.false(isSegmentFileName('vault-index.json'));
    t.false(isSegmentFileName('vault-index.1.vec'));
    t.false(isSegmentFileName('other.vec'));
});

// ─────────────────────────── encodeSegment / decodeSegment ───────────────────────────

test('roundtrip bajt w bajt: encode → decode oddaje te same wartości (Math.fround)', t => {
    const dims = 4;
    const rows = [
        Float32Array.from([1.5, -2.25, 0, 3.125]),
        Float32Array.from([0.1, 0.2, 0.3, 0.4]),
        Float32Array.from([-1, -1, -1, -1]),
    ];
    const buf = encodeSegment(rows, dims);
    t.is(buf.byteLength, 16 + rows.length * dims * 4);

    const decoded = decodeSegment(buf, dims);
    t.truthy(decoded);
    t.is(decoded!.rows, rows.length);
    for (let i = 0; i < rows.length; i++) {
        const got = decoded!.at(i);
        for (let d = 0; d < dims; d++) {
            t.is(got[d], Math.fround(rows[i][d]));
        }
    }
});

test('decodeSegment: segment o 0 wierszach jest poprawny', t => {
    const buf = encodeSegment([], 3);
    t.is(buf.byteLength, 16);
    const decoded = decodeSegment(buf, 3);
    t.truthy(decoded);
    t.is(decoded!.rows, 0);
});

test('decodeSegment odrzuca zły magic', t => {
    const buf = encodeSegment([Float32Array.from([1, 2])], 2);
    const bad = buf.slice(0);
    new DataView(bad).setUint8(0, 0x00);
    t.is(decodeSegment(bad, 2), null);
});

test('decodeSegment odrzuca format != 2', t => {
    const buf = encodeSegment([Float32Array.from([1, 2])], 2);
    const bad = buf.slice(0);
    new DataView(bad).setUint32(4, 1, true);
    t.is(decodeSegment(bad, 2), null);
});

test('decodeSegment odrzuca dims != expected', t => {
    const buf = encodeSegment([Float32Array.from([1, 2])], 2);
    t.is(decodeSegment(buf, 3), null);
});

test('decodeSegment odrzuca ucięty bufor (zły byteLength)', t => {
    const buf = encodeSegment([Float32Array.from([1, 2]), Float32Array.from([3, 4])], 2);
    const truncated = buf.slice(0, buf.byteLength - 4);
    t.is(decodeSegment(truncated, 2), null);
});

test('decodeSegment odrzuca bufor krótszy niż nagłówek', t => {
    t.is(decodeSegment(new ArrayBuffer(8), 2), null);
});

// ─────────────────────────── parseIndexMetaV2 ───────────────────────────

function validMetaV2(): unknown {
    return {
        version: 2,
        model_key: 'ollama:snowflake-arctic-embed2',
        dims: 4,
        updated_at: 1790126191260,
        next_seq: 2,
        segments: [{ file: 'vault-index.000001.vec', rows: 2 }],
        mtimes: { 'a.md': 100, 'b.md': 200 },
        rows: { 'a.md': [0, 0], 'b.md': [0, 1] },
    };
}

test('parseIndexMetaV2 akceptuje kształt poprawny', t => {
    const parsed = parseIndexMetaV2(validMetaV2());
    t.truthy(parsed);
    t.is(parsed!.version, 2);
    t.is(parsed!.dims, 4);
    t.deepEqual(parsed!.rows['b.md'], [0, 1]);
});

test('parseIndexMetaV2 odrzuca literalne wejścia złego kształtu', t => {
    t.is(parseIndexMetaV2(null), null);
    t.is(parseIndexMetaV2(undefined), null);
    t.is(parseIndexMetaV2('string'), null);
    t.is(parseIndexMetaV2([]), null);
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, version: 1 }), null, 'zła wersja');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, dims: 0 }), null, 'dims musi być > 0');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, dims: -4 }), null, 'dims ujemne');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, model_key: 42 }), null, 'model_key nie-string');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, next_seq: -1 }), null, 'next_seq ujemne');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, segments: 'nope' }), null, 'segments nie-tablica');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, segments: [{ file: '', rows: 1 }] }), null, 'pusty file');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, segments: [{ file: 'x.vec', rows: -1 }] }), null, 'rows ujemne');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, mtimes: { a: 'nope' } }), null, 'mtime nie-liczba');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, rows: { 'a.md': [5, 0] } }), null, 'segIdx poza zakresem');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, rows: { 'a.md': [0, 99] } }), null, 'rowIdx poza zakresem segmentu');
    t.is(parseIndexMetaV2({ ...validMetaV2() as object, rows: { 'a.md': [0] } }), null, 'rowRef złej długości');
});

// ─────────────────────────── parseIndexMetaV1 ───────────────────────────

test('parseIndexMetaV1 akceptuje kształt v1 (dawny IndexMeta)', t => {
    const parsed = parseIndexMetaV1({ version: 1, model_key: 'openai:m1', dims: 3, updated_at: 1, mtimes: { 'a.md': 1 } });
    t.deepEqual(parsed, { version: 1, model_key: 'openai:m1', dims: 3, mtimes: { 'a.md': 1 } });
});

test('parseIndexMetaV1 akceptuje mtimes brakujące (pusta mapa) i null model_key/dims', t => {
    const parsed = parseIndexMetaV1({ version: 1 });
    t.deepEqual(parsed, { version: 1, model_key: null, dims: null, mtimes: {} });
});

test('parseIndexMetaV1 odrzuca literalne wejścia złego kształtu', t => {
    t.is(parseIndexMetaV1(null), null);
    t.is(parseIndexMetaV1({ version: 2 }), null);
    t.is(parseIndexMetaV1({ version: 1, model_key: 42 }), null);
    t.is(parseIndexMetaV1({ version: 1, dims: 'nope' }), null);
    t.is(parseIndexMetaV1({ version: 1, mtimes: { a: 'nope' } }), null);
});

// ─────────────────────────── planCompaction ───────────────────────────

test('planCompaction: progi liczby segmentów i martwych wierszy', t => {
    const seg = (n: number, rows: number): SegmentRef[] => Array.from({ length: n }, (_, i) => ({ file: `s${i}`, rows }));

    t.false(planCompaction({ segments: seg(7, 1), liveRows: 7 }), '7 segmentów, 0 dead → false');
    t.true(planCompaction({ segments: seg(9, 1), liveRows: 9 }), '9 segmentów → true niezależnie od dead');
    t.true(planCompaction({ segments: [{ file: 's', rows: 15 }], liveRows: 10 }), '10 live + 5 dead → true (5 >= 10*0.5)');
    t.false(planCompaction({ segments: [{ file: 's', rows: 14 }], liveRows: 10 }), '10 live + 4 dead → false (4 < 10*0.5)');
});

// ─────────────────────────── extractV1Vectors (fixture z prawdziwej Oramy) ───────────────────────────

test('extractV1Vectors czyta prawdziwy dump Oramy 3.1.18 (create + insert 3, jeden bez wektora)', async t => {
    const db = await create({ schema: { id: 'string', path: 'string', title: 'string', mtime: 'number', embedding: 'vector[3]' } });
    await insert(db, { id: 'a.md', path: 'a.md', title: 'a', mtime: 100, embedding: [1, 0, 0] });
    await insert(db, { id: 'b.md', path: 'b.md', title: 'b', mtime: 200, embedding: [0, 1, 0] });
    // c.md to notatka pusta w terminologii VaultIndexer: nigdy nie trafia do Oramy (brak wektora),
    // jej mtime żyje wyłącznie w meta v1 - fixture jej celowo NIE wstawia do bazy.
    await insert(db, { id: 'd.md', path: 'd.md', title: 'd', mtime: 400, embedding: [0, 0, 1] });
    const raw: unknown = JSON.parse(JSON.stringify(save(db)));

    const extracted = extractV1Vectors(raw);
    t.truthy(extracted);
    t.is(extracted!.dims, 3);
    t.is(extracted!.docs.length, 3);
    const byPath = new Map(extracted!.docs.map(d => [d.path, d]));
    t.deepEqual(byPath.get('a.md'), { path: 'a.md', mtime: 100, vector: [1, 0, 0] });
    t.deepEqual(byPath.get('b.md'), { path: 'b.md', mtime: 200, vector: [0, 1, 0] });
    t.deepEqual(byPath.get('d.md'), { path: 'd.md', mtime: 400, vector: [0, 0, 1] });
    t.false(byPath.has('c.md'), 'notatka bez wektora nie ma tu wpisu — jej mtime bierze meta v1');
});

test('extractV1Vectors odrzuca literalne wejścia złego kształtu', t => {
    t.is(extractV1Vectors(null), null);
    t.is(extractV1Vectors({}), null);
    t.is(extractV1Vectors({ index: {} }), null, 'brak vectorIndexes');
    t.is(extractV1Vectors({ index: { vectorIndexes: {} } }), null, 'zero właściwości wektorowych');
    t.is(extractV1Vectors({ index: { vectorIndexes: { a: { size: 3, vectors: [] }, b: { size: 3, vectors: [] } } } }), null, 'więcej niż jedna właściwość wektorowa');
    t.is(extractV1Vectors({ index: { vectorIndexes: { embedding: { size: 0, vectors: [] } } } }), null, 'size <= 0');
    t.is(extractV1Vectors({
        index: { vectorIndexes: { embedding: { size: 3, vectors: [[1, [1, [1, 2]]]] } } },
        docs: { docs: { 1: { path: 'a.md', mtime: 1 } } },
    }), null, 'wektor krótszy niż size');
    t.is(extractV1Vectors({
        index: { vectorIndexes: { embedding: { size: 3, vectors: [[1, [1, [1, 2, 3]]]] } } },
        docs: { docs: {} },
    }), null, 'brak dokumentu dla iid');
    t.is(extractV1Vectors({
        index: { vectorIndexes: { embedding: { size: 3, vectors: [[1, [1, [1, 2, 3]]]] } } },
        docs: { docs: { 1: { path: 'a.md' } } },
    }), null, 'dokument bez mtime');
});

test('extractV1Vectors: zdublowana ścieżka - wygrywa wyższy iid', t => {
    const raw: unknown = {
        index: { vectorIndexes: { embedding: { size: 2, vectors: [[1, [1, [1, 1]]], [2, [1, [2, 2]]]] } } },
        docs: { docs: { 1: { path: 'a.md', mtime: 100 }, 2: { path: 'a.md', mtime: 200 } } },
    };
    const extracted = extractV1Vectors(raw);
    t.truthy(extracted);
    t.is(extracted!.docs.length, 1);
    t.deepEqual(extracted!.docs[0], { path: 'a.md', mtime: 200, vector: [2, 2] });
});
