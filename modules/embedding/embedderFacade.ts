/**
 * modules/embedding/embedderFacade.ts — most rejestr → `EmbedderFacade` (§9 kontraktu).
 *
 * `VaultIndexer` nie zna rejestru: dostaje w konstruktorze cztery funkcje i tyle. Do clean-room
 * te cztery funkcje były sklejane ręcznie w composition roocie i DRUGI RAZ w harnessie — dwie
 * kopie tej samej sklejki, które potrafiły się rozjechać. Teraz jest jedna, pod testem.
 *
 * Fasada jest CIENKA z rozmysłu: nie łapie błędów modelu i nie normalizuje wyników. Rzut
 * przechodzi NIETKNIĘTY, bo indekser klasyfikuje awarię po `kind` i na tej podstawie decyduje,
 * czy ponowić całą porcję, rozbić ją na pliki, czy przerwać skan.
 */
import { EmbedBatchError } from './embedErrors.js';
import type { EmbedderFacade } from './contracts.js';
import type { EmbeddingRegistry } from './EmbeddingRegistry.js';

export function createEmbedderFacade(registry: EmbeddingRegistry): EmbedderFacade {
    /** Model albo twardy rzut — indekser i tak pyta wcześniej `isReady()`. */
    const activeModel = () => {
        const model = registry.default;
        if (!model) {
            throw new EmbedBatchError({
                kind: 'api',
                code: 'unknown',
                message: 'Embedding provider not configured',
                attempts: 0,
            });
        }
        return model;
    };

    return {
        isReady: () => registry.isConfigured(),

        getModelKey: () => registry.default?.modelKey ?? '',

        getDims: () => registry.default?.dims ?? null,

        async embedBatch(texts: string[]): Promise<Array<number[] | null>> {
            const results = await activeModel().embed(texts);
            return results.map(result => result.vector);
        },

        async embed(text: string): Promise<number[] | null> {
            const [result] = await activeModel().embed([text]);
            return result?.vector ?? null;
        },
    };
}
