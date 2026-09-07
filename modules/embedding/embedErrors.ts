/**
 * modules/embedding/embedErrors.ts — kontrakt błędu embeddingu (§3 kontraktu).
 *
 * JEDEN typ błędu wychodzi z całego klastra na zewnątrz. `VaultIndexer` czyta z niego
 * `kind` i `httpStatus` KACZO (fasada embeddera jest wstrzykiwana, więc `instanceof`
 * przez granicę modułu bywa fałszywie ujemny) — stąd osobny strażnik {@link isEmbedBatchError},
 * który patrzy na kształt, a nie na łańcuch prototypów.
 *
 * K20: żadne pole tego błędu nie ma prawa nieść klucza API ani nagłówków żądania.
 * Maskowanie robi wołacz (`EmbeddingModel`) PRZED zbudowaniem błędu — tutaj jest tylko
 * nośnik, więc trzymamy go głupim i przewidywalnym.
 */
import type { EmbedBatchErrorInit, EmbedErrorKind, EmbedErrorCode, EmbeddingProviderId } from './contracts.js';

/** Wartości `kind`, po których wołacz rozpoznaje błąd bez `instanceof`. */
const ERROR_KINDS: ReadonlySet<string> = new Set<EmbedErrorKind>(['transport', 'api', 'timeout', 'shape']);

/**
 * Awaria jednego żądania embeddingu — z klasyfikacją, która steruje reakcją indeksera
 * (`transport`/`timeout` i `api` + 429 = przejściowa; `api` z innym statusem = trwała;
 * `shape` = fatalna, porcji NIE wolno rozbijać na pojedyncze pliki).
 */
export class EmbedBatchError extends Error {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare readonly kind: EmbedErrorKind;
    declare readonly code: EmbedErrorCode;
    declare readonly httpStatus?: number;
    declare readonly providerId?: EmbeddingProviderId;
    declare readonly modelId?: string;
    declare readonly attempts: number;
    declare readonly cause?: unknown;

    constructor(init: EmbedBatchErrorInit) {
        super(init.message);
        this.name = 'EmbedBatchError';
        this.kind = init.kind;
        this.code = init.code;
        this.httpStatus = init.httpStatus;
        this.providerId = init.providerId;
        this.modelId = init.modelId;
        // Brak licznika = jedno żądanie. Zero znaczy „nie doszło do żądania w ogóle"
        // (brak klucza API), i taką wartość wołacz podaje jawnie.
        this.attempts = typeof init.attempts === 'number' ? init.attempts : 1;
        this.cause = init.cause;
    }
}

/**
 * Czy to jest awaria embeddingu — sprawdzane PO KSZTAŁCIE, nie po prototypie.
 * Przez granicę modułu (harness, atrapy w testach, dwa ładowania tego samego pliku)
 * `instanceof` potrafi kłamać, a klasyfikacja porcji w indekserze musi być pewna.
 */
export function isEmbedBatchError(e: unknown): e is EmbedBatchError {
    if (e instanceof EmbedBatchError) return true;
    if (typeof e !== 'object' || e === null) return false;

    const candidate = e as { kind?: unknown; code?: unknown };
    return typeof candidate.kind === 'string'
        && ERROR_KINDS.has(candidate.kind)
        && typeof candidate.code === 'string';
}

/** Rzut z `EmbeddingRegistry.select()` dla identyfikatora spoza czwórki dostawców. */
export class UnknownEmbeddingProviderError extends Error {
    declare readonly providerId: string;

    constructor(providerId: string) {
        super(`Unknown embedding provider: ${String(providerId)}`);
        this.name = 'UnknownEmbeddingProviderError';
        this.providerId = String(providerId);
    }
}
