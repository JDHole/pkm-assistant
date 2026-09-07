/**
 * modules/embedding — public API (barrel).
 *
 * clean-room / F4: rejestr + model + dostawcy zastępują dawną kolekcję `embedding_models` i
 * cztery klasy adapterów. Migrator starego indeksu (v1.x → Orama) SKASOWANY w całości
 * (decyzja Kuby 05.09, R13) — nie ma go już w tym module.
 *
 * **NIE wychodzi stąd:** typy HTTP (`HttpClient`, `HttpRequestSpec`, `HttpResponse`) — konsumenci
 * spoza modułu biorą je z `core/index.js`, żeby nie było dwóch dróg do jednego typu.
 */

// Silnik Oramy — tylko to, co czytają konsumenci (licznik dokumentów + wyszukiwanie wektorowe).
export { countDocs, searchVectorTopK } from './orama_engine.js';

// E1.4 — żywy indeks semantyczny vaulta (publikuje `plugin.oramaDb`).
export { VaultIndexer } from './VaultIndexer.js';

// ── Rejestr + model + dostawcy (clean-room / F4) ──────────────────────────────────
export { EmbeddingRegistry } from './EmbeddingRegistry.js';
export { EmbeddingModel } from './EmbeddingModel.js';
export { EmbedBatchError, isEmbedBatchError, UnknownEmbeddingProviderError } from './embedErrors.js';
export { createEmbedderFacade } from './embedderFacade.js';
export {
    EMBEDDING_PROVIDERS,
    openAiEmbeddingProvider,
    ollamaEmbeddingProvider,
    lmStudioEmbeddingProvider,
    geminiEmbeddingProvider,
} from './providers/index.js';
export {
    EMBEDDING_PROVIDER_IDS,
    DEFAULT_EMBED_MODELS,
    DEFAULT_EMBEDDING_SETTINGS,
    DEFAULT_VECTOR_DIM,
} from './contracts.js';

// AUD-bledy-040 — meldunek z migracji ada-002 → 3-small (composition root woła to przy starcie).
export { announceAdaMigration } from './adaMigration.js';
export type { AdaMigrationPorts } from './adaMigration.js';

// ── Typy publiczne ──────────────────────────────────────────────────────────
//
// Wychodzą tymi samymi drzwiami co wartości, ale przez `export type`, które ZNIKA
// przy transpilacji — zero wpływu na bundle. Typy żyją przy kodzie-właścicielu
// (kontrakt kampanii TS §5), tu są tylko reeksportowane.

export type {
    SearchVectorTopKOptions,
    SearchTextOptions,
    OramaWriter,
    OramaReader,
} from './orama_engine.js';

export type {
    VaultIndexerDeps,
    VaultLike,
    VaultFileLike,
    VaultAdapterLike,
    EmbedderFacade,
    IndexerPluginLike,
    IndexerLogger,
    IndexerStatus,
    IndexerStatusSnapshot,
    VaultEventType,
    FileMeta,
    IndexMeta,
} from './VaultIndexer.js';

export type {
    EmbeddingProviderId,
    EmbeddingProviderInfo,
    EmbeddingModelSpec,
    EmbeddingModelInfo,
    EmbeddingProviderContext,
    EmbeddingProvider,
    EmbeddingModelDeps,
    EmbeddingModelLike,
    EmbeddingRegistryDeps,
    SettingsWithEmbedding,
    EmbedResult,
    EmbedErrorKind,
    EmbedErrorCode,
    EmbedBatchErrorInit,
} from './contracts.js';
