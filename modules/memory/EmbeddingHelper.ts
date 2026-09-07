/**
 * Wrapper na model embeddingu (klaster `embedding`) dla łatwego użycia w RAG.
 * Cienka warstwa nad `EmbeddingModelLike` — wyrównanie wyniku z wejściem oraz porcjowanie
 * pustych tekstów są kontraktem MODELU (`EmbeddingModel.embed`: N wejść → N wyników, `vector:
 * null` dla wejścia pustego/białego), nie tego helpera. Ręczne remapowanie przez
 * `originalIndex`, które ten plik kiedyś robił sam, zniknęło razem z clean-room — kontrakt modelu
 * już trzyma wyrównanie.
 */
import type { EmbedResult, EmbeddingModelLike } from '../embedding/index.js';

export type { EmbedResult, EmbeddingModelLike } from '../embedding/index.js';

/**
 * Środowisko pluginu widziane przez helper — jedyna żywa droga dojścia do modelu embeddingu.
 * Wszystko opcjonalne: helper JEST napisany na to, że env jeszcze nie wstało.
 */
export interface EmbeddingRuntimeLike {
    embeddings?: { default?: EmbeddingModelLike | null } | null;
}

export class EmbeddingHelper {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare env: EmbeddingRuntimeLike | null | undefined;
    declare private _model: EmbeddingModelLike | null;

    constructor(env: EmbeddingRuntimeLike | null | undefined) {
        this.env = env;
        this._model = null;
    }

    /**
     * Znajduje model embeddingu przez `env.embeddings.default` — jedyna droga po clean-room
     * (rejestr `EmbeddingRegistry`, kontrakt w `modules/embedding`).
     */
    private _findModel(): EmbeddingModelLike | null {
        try {
            return this.env?.embeddings?.default ?? null;
        } catch { /* not ready */ }

        return null;
    }

    /**
     * Sprawdza czy model jest gotowy
     */
    isReady(): boolean {
        this._model = this._findModel();
        return !!this._model;
    }

    /**
     * Embeduje pojedynczy tekst.
     * @param text - Tekst do zembedowania
     */
    async embed(text: string): Promise<number[]> {
        if (!this.isReady()) throw new Error('Embed model not ready');

        // `isReady()` dopiero co ustawiło `_model` na niepusty — TS tego nie widzi przez
        // granicę wywołania metody, więc asercja przywraca tę wiedzę.
        const results = await this._model!.embed([text]);

        if (!results?.length || !results[0]?.vector) {
            throw new Error('Embed result is empty');
        }
        return results[0].vector;
    }

    /**
     * Embeduje wiele tekstów (batch). Model oddaje DOKŁADNIE tyle wyników, ile dostał wejść
     * (indeks w indeks) — `null` dla wejścia pustego/białego. Helper już niczego nie remapuje.
     * @param texts - Lista tekstów do zembedowania
     * @returns Lista wektorów (null dla pustych)
     */
    async embedBatch(texts: string[]): Promise<Array<number[] | null>> {
        if (!this.isReady()) throw new Error('Embed model not ready');

        const results: EmbedResult[] = await this._model!.embed(texts);
        return results.map(r => r.vector);
    }

    /**
     * Oblicza podobieństwo cosinusowe
     * @returns Similarity score (-1 to 1)
     */
    cosineSimilarity(vecA: number[] | null | undefined, vecB: number[] | null | undefined): number {
        if (!vecA || !vecB || vecA.length !== vecB.length) {
            return 0; // null vektory to oczekiwana sytuacja (puste snippety)
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        if (normA === 0 || normB === 0) return 0;

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
