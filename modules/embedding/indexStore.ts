/**
 * indexStore - funkcje czyste (bez I/O, bez Oramy) do formatu indeksu v2 na dysku.
 *
 * Format: wektory Float32 w niezmiennych SEGMENTACH binarnych + mały JSON meta
 * (`vault-index.meta.json`). `VaultIndexer` jest jedynym wołaczem - trzyma tu wyłącznie
 * kodowanie/dekodowanie i walidację kształtu, zero odczytu/zapisu z dysku.
 *
 * Segment `vault-index.<seq>.vec` (little-endian):
 *   offset 0  : 4 bajty ASCII magic "PKMV"
 *   offset 4  : u32 format = 2
 *   offset 8  : u32 dims
 *   offset 12 : u32 rows
 *   offset 16 : rows × dims × Float32, wiersz po wierszu
 *
 * Meta v2 jest JEDYNYM źródłem prawdy o tym, co jest w indeksie: `segments[i]` opisuje
 * i-ty segment (nazwa pliku + liczba wierszy), `rows[path] = [segIdx, rowIdx]` wskazuje
 * dokładnie jeden wiersz jednego segmentu, `mtimes` niesie stempel dla KAŻDEJ zaindeksowanej
 * notatki (także tych bez wektora - treść pusta). Wszystko z dysku wchodzi jako `unknown`
 * i przechodzi przez `parseIndexMetaV2`/`parseIndexMetaV1` - żaden kształt nie jest brany na wiarę.
 */

/** Wpis o jednym segmencie w meta. */
export interface SegmentRef {
    file: string;
    rows: number;
}

/** Wskazanie wiersza: [indeks segmentu w `segments`, indeks wiersza w tym segmencie]. */
export type RowRef = [number, number];

/** Sidecar `vault-index.meta.json` w formacie v2. */
export interface IndexMetaV2 {
    version: 2;
    model_key: string;
    dims: number;
    updated_at: number;
    next_seq: number;
    segments: SegmentRef[];
    mtimes: Record<string, number>;
    rows: Record<string, RowRef>;
}

/** Stary sidecar (v1) - Orama `save()` + JSON, tylko na potrzeby migracji. */
export interface IndexMetaV1 {
    version: 1;
    model_key: string | null;
    dims: number | null;
    mtimes: Record<string, number>;
}

/** Jeden zdekodowany dokument z dumpu v1 (`extractV1Vectors`). */
export interface V1ExtractedDoc {
    path: string;
    mtime: number;
    vector: number[];
}

/** Wynik `extractV1Vectors` - wymiar wspólny wszystkim wektorom + lista dokumentów z wektorem. */
export interface V1Extracted {
    dims: number;
    docs: V1ExtractedDoc[];
}

/** Zdekodowany segment - dostęp do wierszy bez kopiowania całego bufora naraz. */
export interface DecodedSegment {
    rows: number;
    at(i: number): Float32Array;
}

const MAGIC = [0x50, 0x4b, 0x4d, 0x56]; // "PKMV"
const SEGMENT_FORMAT = 2;
const HEADER_BYTES = 16;
/** Próg liczby segmentów, powyżej którego kompakcja jest zawsze zasadna (D3/D4). */
const MAX_SEGMENTS = 8;

const SEGMENT_NAME_RE = /^vault-index\.(\d{6})\.vec$/;

/** Nazwa pliku segmentu dla danego numeru sekwencji (`next_seq` w meta). */
export function segmentFileName(seq: number): string {
    return `vault-index.${String(seq).padStart(6, '0')}.vec`;
}

/**
 * Czy nazwa pasuje do wzorca pliku segmentu. Przyjmuje zarówno gołą nazwę, jak i pełną
 * ścieżkę (dopasowanie po OSTATNIM segmencie ścieżki) - `DataAdapter.list()` Obsidiana
 * oddaje ścieżki pełne względem roota vaulta.
 */
export function isSegmentFileName(name: string): boolean {
    const norm = String(name || '').replace(/\\/g, '/');
    const base = norm.split('/').pop() || norm;
    return SEGMENT_NAME_RE.test(base);
}

/** Koduje wiersze (już Float32Array o długości `dims`) w jeden bufor binarny segmentu. */
export function encodeSegment(rows: Float32Array[], dims: number): ArrayBuffer {
    const n = rows.length;
    const buf = new ArrayBuffer(HEADER_BYTES + n * dims * 4);
    const view = new DataView(buf);
    view.setUint8(0, MAGIC[0]);
    view.setUint8(1, MAGIC[1]);
    view.setUint8(2, MAGIC[2]);
    view.setUint8(3, MAGIC[3]);
    view.setUint32(4, SEGMENT_FORMAT, true);
    view.setUint32(8, dims, true);
    view.setUint32(12, n, true);
    let offset = HEADER_BYTES;
    for (let i = 0; i < n; i++) {
        const row = rows[i];
        for (let d = 0; d < dims; d++) {
            view.setFloat32(offset, row[d] ?? 0, true);
            offset += 4;
        }
    }
    return buf;
}

/**
 * Dekoduje bufor segmentu. `null` przy: złym magic, format ≠ 2, dims ≠ `expectedDims`,
 * albo `byteLength` niezgodnym z zadeklarowaną liczbą wierszy.
 *
 * Przyjmuje `ArrayBuffer` ALBO dowolny widok na bajty (`ArrayBufferView` - `Uint8Array`,
 * `DataView`...): `instanceof ArrayBuffer` kłamie między realmami (inny kontekst JS w
 * Electronie potrafi oddać `ArrayBuffer` z INNEGO globala, dla którego `instanceof` jest
 * `false` mimo poprawnych bajtów - fałszywy `index_corrupt`). Payload jest KOPIOWANY do
 * świeżego, wyrównanego bufora - `Float32Array` wymaga `byteOffset` wielokrotności 4,
 * a wejściowy widok (np. `Uint8Array` na niezerowym `byteOffset`) tego nie gwarantuje.
 */
export function decodeSegment(buf: ArrayBuffer | ArrayBufferView, expectedDims: number): DecodedSegment | null {
    if (!buf || typeof buf.byteLength !== 'number') return null;
    const bytes = ArrayBuffer.isView(buf)
        ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        : new Uint8Array(buf);
    if (bytes.byteLength < HEADER_BYTES) return null;
    // DataView na `bytes` nie wymaga wyrównania (w przeciwieństwie do Float32Array) — bezpieczny
    // niezależnie od `byteOffset` wejściowego widoku.
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < 4; i++) if (header.getUint8(i) !== MAGIC[i]) return null;
    const format = header.getUint32(4, true);
    if (format !== SEGMENT_FORMAT) return null;
    const dims = header.getUint32(8, true);
    if (dims !== expectedDims || dims <= 0) return null;
    const rows = header.getUint32(12, true);
    if (bytes.byteLength !== HEADER_BYTES + rows * dims * 4) return null;
    const payload = new Uint8Array(rows * dims * 4);
    payload.set(bytes.subarray(HEADER_BYTES));
    const floats = new Float32Array(payload.buffer);
    return {
        rows,
        at(i: number): Float32Array {
            return floats.subarray(i * dims, i * dims + dims);
        },
    };
}

// ─────────────────────────── Walidacja na granicy (unknown → typ) ───────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegInt(v: unknown): v is number {
    return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
    return isFiniteNumber(v) && Number.isInteger(v) && v > 0;
}

/**
 * Numer sekwencji zaszyty w nazwie segmentu, albo `null` gdy nazwa nie pasuje do wzorca
 * ŚCIŚLE (bez separatorów ścieżki - w meta `segments[].file` ma być gołą nazwą, nigdy
 * ścieżką z `../`; `isSegmentFileName` (tolerancyjna na pełne ścieżki z `list()`) tu
 * ŚWIADOMIE nie jest używana, bo dopasowywałaby się po samym basename i przepuściłaby
 * traversal typu `../../vault-index.000001.vec`).
 */
function segmentSeqOf(file: string): number | null {
    const m = SEGMENT_NAME_RE.exec(file);
    return m ? parseInt(m[1], 10) : null;
}

function parseSegmentsField(v: unknown): SegmentRef[] | null {
    if (!Array.isArray(v)) return null;
    const out: SegmentRef[] = [];
    const seen = new Set<string>();
    for (const item of v) {
        if (!isRecord(item)) return null;
        const { file, rows } = item;
        if (typeof file !== 'string' || segmentSeqOf(file) === null) return null;
        if (seen.has(file)) return null; // zdublowana nazwa segmentu
        seen.add(file);
        if (!isNonNegInt(rows)) return null;
        out.push({ file, rows });
    }
    return out;
}

function parseMtimesField(v: unknown): Record<string, number> | null {
    if (!isRecord(v)) return null;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v)) {
        if (!isFiniteNumber(val)) return null;
        out[k] = val;
    }
    return out;
}

function parseRowsField(v: unknown, segments: SegmentRef[]): Record<string, RowRef> | null {
    if (!isRecord(v)) return null;
    const out: Record<string, RowRef> = {};
    for (const [k, val] of Object.entries(v)) {
        if (!Array.isArray(val) || val.length !== 2) return null;
        const [segIdx, rowIdx] = val as unknown[];
        if (!isNonNegInt(segIdx) || segIdx >= segments.length) return null;
        if (!isNonNegInt(rowIdx) || rowIdx >= segments[segIdx].rows) return null;
        out[k] = [segIdx, rowIdx];
    }
    return out;
}

/**
 * Parsuje meta v2 z `unknown` (odczyt z dysku). Waliduje kształt I spójność: każdy
 * `rows[path]` musi wskazywać istniejący segment i wiersz w jego granicach, mieć
 * odpowiadający wpis w `mtimes`, a `next_seq` musi być WYŻSZY niż każdy numer zaszyty
 * w nazwie istniejącego segmentu (D3 - numery segmentów nigdy nie są ponownie używane).
 * Cokolwiek nie gra → `null` (wołacz robi z tego pełny rebuild, nigdy cichą korupcję).
 */
export function parseIndexMetaV2(raw: unknown): IndexMetaV2 | null {
    if (!isRecord(raw)) return null;
    if (raw.version !== 2) return null;
    if (typeof raw.model_key !== 'string') return null;
    if (!isPositiveInt(raw.dims)) return null;
    if (!isFiniteNumber(raw.updated_at)) return null;
    if (!isNonNegInt(raw.next_seq)) return null;
    const segments = parseSegmentsField(raw.segments);
    if (!segments) return null;
    const maxSegSeq = segments.reduce((m, s) => Math.max(m, segmentSeqOf(s.file) ?? 0), 0);
    if (raw.next_seq <= maxSegSeq) return null;
    const mtimes = parseMtimesField(raw.mtimes);
    if (!mtimes) return null;
    const rows = parseRowsField(raw.rows, segments);
    if (!rows) return null;
    for (const path of Object.keys(rows)) {
        if (!(path in mtimes)) return null; // rows bez mtimes nigdy nie jest poprawne (D8)
    }
    return {
        version: 2,
        model_key: raw.model_key,
        dims: raw.dims,
        updated_at: raw.updated_at,
        next_seq: raw.next_seq,
        segments,
        mtimes,
        rows,
    };
}

/** Parsuje meta v1 (Orama `save()` + JSON) - wyłącznie na potrzeby migracji. */
export function parseIndexMetaV1(raw: unknown): IndexMetaV1 | null {
    if (!isRecord(raw)) return null;
    if (raw.version !== 1) return null;
    const modelKeyRaw = raw.model_key;
    if (modelKeyRaw !== null && modelKeyRaw !== undefined && typeof modelKeyRaw !== 'string') return null;
    const dimsRaw = raw.dims;
    if (dimsRaw !== null && dimsRaw !== undefined && !isFiniteNumber(dimsRaw)) return null;
    const mtimes = parseMtimesField(raw.mtimes ?? {});
    if (!mtimes) return null;
    return {
        version: 1,
        model_key: typeof modelKeyRaw === 'string' ? modelKeyRaw : null,
        dims: isFiniteNumber(dimsRaw) ? dimsRaw : null,
        mtimes,
    };
}

/**
 * Najwyższy numer sekwencji zaszyty w liście nazw plików (np. `adapter.list()` na katalogu
 * indeksu) - `0` gdy żadna nie pasuje. Wejście może być gołą nazwą albo pełną ścieżką
 * (dopasowanie po ostatnim segmencie ścieżki, tak jak `isSegmentFileName`) - w przeciwieństwie
 * do `segmentSeqOf` (ścisłe, dla `segments[].file` w meta), tu tolerujemy oba kształty, bo to
 * jedyne miejsce, gdzie źródłem prawdy o `_nextSeq` jest sam DYSK, nie meta (D3/F2 - numer
 * segmentu nigdy nie jest ponownie użyty, nawet gdy meta jest nieczytelna/niespójna i jedynym
 * śladem są nazwy plików).
 */
export function maxSegmentSeq(listedNames: string[]): number {
    let max = 0;
    for (const raw of listedNames) {
        const norm = String(raw || '').replace(/\\/g, '/');
        const base = norm.split('/').pop() || norm;
        const seq = segmentSeqOf(base);
        if (seq !== null && seq > max) max = seq;
    }
    return max;
}

// ─────────────────────────── Kompakcja ───────────────────────────

/**
 * Czy warto skompaktować segmenty w jeden bazowy plik: albo jest ich za dużo
 * (`> MAX_SEGMENTS`), albo martwych wierszy jest przynajmniej połowa żywych.
 */
export function planCompaction(args: { segments: SegmentRef[]; liveRows: number }): boolean {
    const { segments, liveRows } = args;
    if (segments.length > MAX_SEGMENTS) return true;
    const totalRows = segments.reduce((sum, s) => sum + s.rows, 0);
    const deadRows = totalRows - liveRows;
    return deadRows > 0 && deadRows >= liveRows * 0.5;
}

// ─────────────────────────── Czytnik dumpu Oramy v1 ───────────────────────────

interface V1VectorEntry {
    iid: number;
    vector: number[];
}

function parseV1VectorEntries(vectorsRaw: unknown, size: number): V1VectorEntry[] | null {
    if (!Array.isArray(vectorsRaw)) return null;
    const out: V1VectorEntry[] = [];
    for (const entry of vectorsRaw) {
        // Kształt Oramy 3.1.18: [internalId, [magnitude, [floats...]]]
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [iid, payload] = entry as unknown[];
        if (!isFiniteNumber(iid)) return null;
        if (!Array.isArray(payload) || payload.length !== 2) return null;
        const vector: unknown = payload[1];
        if (!Array.isArray(vector) || vector.length !== size) return null;
        for (const n of vector) if (!isFiniteNumber(n)) return null;
        out.push({ iid, vector: vector as number[] });
    }
    return out;
}

/**
 * Czyta kształt dumpu Oramy 3.1.18 (`save()` + `JSON.stringify`):
 * `raw.index.vectorIndexes.<jedyna właściwość>.{size, vectors:[[iid,[mag,floats]]]}` +
 * `raw.docs.docs[String(iid)].{path, mtime}`. Dokument bez wektora (pusta notatka) jest
 * pomijany - jego mtime siedzi w meta v1, nie tutaj. Zdublowane ścieżki (nie powinny się
 * zdarzyć w realnych danych): ostatni (wyższy iid) wygrywa.
 */
export function extractV1Vectors(raw: unknown): V1Extracted | null {
    if (!isRecord(raw)) return null;
    const index = raw.index;
    if (!isRecord(index)) return null;
    const vectorIndexes = index.vectorIndexes;
    if (!isRecord(vectorIndexes)) return null;
    const keys = Object.keys(vectorIndexes);
    if (keys.length !== 1) return null;
    const vectorField = vectorIndexes[keys[0]];
    if (!isRecord(vectorField)) return null;
    const size = vectorField.size;
    if (!isFiniteNumber(size) || size <= 0) return null;
    const entries = parseV1VectorEntries(vectorField.vectors, size);
    if (!entries) return null;

    const docs = raw.docs;
    if (!isRecord(docs)) return null;
    const docsMap = docs.docs;
    if (!isRecord(docsMap)) return null;

    // Sort po iid rosnąco, żeby "ostatni (wyższy iid) wygrywa" przy zdublowanej ścieżce.
    const sorted = [...entries].sort((a, b) => a.iid - b.iid);
    const byPath = new Map<string, V1ExtractedDoc>();
    for (const { iid, vector } of sorted) {
        const doc = docsMap[String(iid)];
        if (!isRecord(doc)) return null;
        const path = doc.path;
        const mtime = doc.mtime;
        if (typeof path !== 'string' || !path) return null;
        if (!isFiniteNumber(mtime)) return null;
        byPath.set(path, { path, mtime, vector });
    }
    return { dims: size, docs: [...byPath.values()] };
}
