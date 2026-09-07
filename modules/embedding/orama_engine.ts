import { create, insert, insertMultiple, search, searchVector, remove, save, load, count } from '@orama/orama';
import type { AnyOrama, AnySchema, AnyDocument, PartialSchemaDeep, Results, SearchParamsFullText, SearchParamsVector, TypedDocument, RawData } from '@orama/orama';

/**
 * Dokument wkładany do indeksu. Dokładnie ten typ, którego chce `insert()` Oramy dla
 * nietypowanego `AnyOrama` — dzięki temu wołacze nie przemycają `any` do biblioteki.
 */
export type EmbeddingDoc = PartialSchemaDeep<TypedDocument<AnyOrama>>;

export const DEFAULT_VECTOR_DIM = 1024;

export const defaultVaultSchema: AnySchema = {
    path: 'string',
    basename: 'string',
    folder: 'string',
    yaml_tags: 'string[]',
    yaml_type: 'string',
    yaml_status: 'string',
    yaml_agent: 'string',
    yaml_date: 'string',
    size: 'number',
    mtime: 'number',
    title: 'string',
    headings: 'string[]',
    body: 'string',
    embedding: `vector[${DEFAULT_VECTOR_DIM}]`,
    embedding_model: 'string',
    outgoing_links: 'string[]',
    incoming_links: 'string[]',
};

export const defaultMemorySchema: AnySchema = {
    id: 'string',
    agent: 'string',
    type: 'string',
    path: 'string',
    body: 'string',
    embedding: `vector[${DEFAULT_VECTOR_DIM}]`,
    embedding_model: 'string',
    created_at: 'number',
    updated_at: 'number',
};

/** Opcje `searchVectorTopK` (k / property / similarity + surowy filtr Oramy). */
export interface SearchVectorTopKOptions {
    k?: number;
    property?: string;
    similarity?: number;
    where?: SearchParamsVector<AnyOrama>['where'];
}

/** Opcje `searchText` (BM25). */
export interface SearchTextOptions {
    limit?: number;
    properties?: SearchParamsFullText<AnyOrama>['properties'];
    where?: SearchParamsFullText<AnyOrama>['where'];
}

export async function createEmbeddingDb(schema: AnySchema = defaultVaultSchema): Promise<AnyOrama> {
    return create({ schema });
}

export async function insertVector(db: AnyOrama, doc: EmbeddingDoc): Promise<string> {
    return insert(db, doc);
}

/** Domyślna nazwa pola wektora w dokumencie indeksu (schemat `VaultIndexer._schema()`). */
const DEFAULT_VECTOR_PROPERTY = 'embedding';

/**
 * Insert, po którym wektor zostaje TYLKO w `index.vectorIndexes` (AUD-wydajnosc-088/041).
 *
 * Orama trzyma każdy wektor DWA RAZY: raz w indeksie wektorowym (tam się szuka) i raz jako
 * zwykłą tablicę liczb w kopii dokumentu w docs-store. Tej drugiej kopii NIKT nie czyta —
 * ani plugin (`RetrievalEngine` bierze z trafienia tylko `path`), ani sama Orama, która przy
 * KAŻDYM `searchVector` i tak nadpisuje ją `null` (`methods/search-vector.js`, gałąź
 * `!includeVectors`). Kosztowała połowę bajtów pliku indeksu i połowę rezydentnej sterty.
 *
 * Zerujemy ją zaraz po insercie — dokładnie tak, jak robi to sama Orama. `remove()` dalej
 * działa: dla pola typu `vector[N]` `removeScalar` kasuje wpis po WEWNĘTRZNYM id i wartości
 * w ogóle nie czyta (`components/index.js`), a `null` — w odróżnieniu od skasowania pola —
 * przechodzi bramkę `typeof value === 'undefined'` w `methods/remove.js`, więc wektor jest
 * realnie usuwany z `vectorIndexes`.
 *
 * ⚠️ Orama trzyma dokument PRZEZ REFERENCJĘ (`documents-store.store`), więc wyzerowanie
 * dotyka też obiektu przekazanego przez wołacza — jak `insert()`, które i tak mutuje
 * dokument (patrz gotcha 2 w `CLAUDE.md`). Wołacz produkcyjny (`VaultIndexer._makeDoc`)
 * buduje świeży obiekt na każdy plik, więc go to nie dotyczy; w testach kopiuj wektor
 * ZANIM go wstawisz, jeśli chcesz go potem użyć jako zapytania.
 *
 * @param vectorProperty nazwa pola wektora w dokumencie
 * @returns id wstawionego dokumentu
 */
export async function insertVectorLean(
    db: AnyOrama,
    doc: EmbeddingDoc,
    vectorProperty: string = DEFAULT_VECTOR_PROPERTY,
): Promise<string> {
    const id = await insert(db, doc);
    const stored = db.documentsStore.get(db.data.docs, id) as Record<string, unknown> | undefined;
    if (stored) stored[vectorProperty] = null;
    return id;
}

/**
 * Zeruje kopie wektorów w docs-store CAŁEGO indeksu (AUD-wydajnosc-088/041).
 *
 * Wołane po `restore()`: plik indeksu zapisany starszą wersją pluginu niesie kopie wektorów
 * w dokumentach, więc bez tego pierwszy zapis po restarcie znowu utrwaliłby dubel. Stary
 * (gruby) plik nadal wczytuje się bez zmian — chudnie dopiero przy najbliższym zapisie.
 *
 * @returns liczba dokumentów, w których kopia realnie została wyzerowana
 */
export function stripStoredVectors(
    db: AnyOrama | null | undefined,
    vectorProperty: string = DEFAULT_VECTOR_PROPERTY,
): number {
    if (!db) return 0;
    let stripped = 0;
    try {
        const docs = db.documentsStore.getAll(db.data.docs) as Record<string, Record<string, unknown>>;
        for (const key of Object.keys(docs || {})) {
            const doc = docs[key];
            if (doc && doc[vectorProperty] != null) { doc[vectorProperty] = null; stripped++; }
        }
    } catch { /* nietypowy kształt store'u — indeks działa dalej, tylko bez odchudzenia */ }
    return stripped;
}

export async function insertBatch(db: AnyOrama, docs: EmbeddingDoc[]): Promise<string[]> {
    return insertMultiple(db, docs);
}

/**
 * Remove a document by its Orama id. VaultIndexer uses `id === path`, so this
 * is `removeVector(db, path)`. Missing ids are a no-op (Orama returns false).
 * @returns true if a document was removed
 */
export async function removeVector(db: AnyOrama, id: string): Promise<boolean> {
    return remove(db, id);
}

/**
 * Number of documents currently in the index. Read-only. Returns 0 on any error
 * (null db, unexpected Orama shape) so diagnostic callers (self-test) never throw.
 */
export function countDocs(db: AnyOrama | null | undefined): number {
    try { return db ? count(db) : 0; }
    catch { return 0; }
}

export async function searchVectorTopK(
    db: AnyOrama,
    vector: number[],
    options: SearchVectorTopKOptions = {},
): Promise<Results<AnyDocument>> {
    // similarity 0.2 (E1.8, kalibracja na żywym vaultcie): snowflake-arctic-embed2 daje
    // NISKIE absolutne cosine — zmierzony trafny wynik ≈0.38, szum ≈0.03-0.04. Stary próg
    // 0.5 odcinał nawet idealne trafienia (L3 zwracał pustkę = smoke E1.8 to wykrył).
    const { k = 10, property = 'embedding', similarity = 0.2, where } = options;
    // `mode: 'vector'` jest w typie Oramy WYMAGANE, ale `searchVector()` go nie czyta
    // (tryb wynika z samej funkcji) — dopisanie pola byłoby zmianą runtime'u, więc asercja.
    return searchVector(db, {
        vector: { value: vector, property },
        similarity,
        limit: k,
        ...(where ? { where } : {}),
    } as SearchParamsVector<AnyOrama>);
}

export async function searchText(
    db: AnyOrama,
    term: string,
    options: SearchTextOptions = {},
): Promise<Results<AnyDocument>> {
    const { limit = 10, properties, where } = options;
    return search(db, {
        term,
        ...(properties ? { properties } : {}),
        ...(where ? { where } : {}),
        limit,
    });
}

export async function serialize(db: AnyOrama): Promise<RawData> {
    return save(db);
}

export async function deserialize(rawData: RawData, schema: AnySchema = defaultVaultSchema): Promise<AnyOrama> {
    const db = create({ schema });
    load(db, rawData);
    return db;
}

/** Zapis indeksu na dysk: `writer(path, jsonString)`. Zwrotka jest ignorowana. */
export type OramaWriter = (path: string, json: string) => unknown;
/** Odczyt indeksu z dysku: `reader(path)` → JSON. */
export type OramaReader = (path: string) => Promise<string> | string;

export async function persist(db: AnyOrama, writer: OramaWriter, path: string): Promise<void> {
    if (typeof writer !== 'function') {
        throw new Error('persist: writer must be a function (path, jsonString) => Promise<void>');
    }
    const raw = save(db);
    await writer(path, JSON.stringify(raw));
}

export async function restore(reader: OramaReader, path: string, schema: AnySchema = defaultVaultSchema): Promise<AnyOrama> {
    if (typeof reader !== 'function') {
        throw new Error('restore: reader must be a function (path) => Promise<string>');
    }
    const json = await reader(path);
    const raw = JSON.parse(json) as RawData;
    return deserialize(raw, schema);
}
