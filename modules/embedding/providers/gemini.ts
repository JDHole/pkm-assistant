/**
 * modules/embedding/providers/gemini.ts — dostawca Gemini (`:batchEmbedContents`,
 * `x-goog-api-key`, `retryDelay` z ciała 429, katalog 2048/50).
 *
 * K20: klucz NIGDY w query-stringu (`?key=`) — wyciekałby przez log adresu. Idzie
 * WYŁĄCZNIE w nagłówku `x-goog-api-key` (C-16).
 *
 * Źródła kształtu: https://ai.google.dev/api/embeddings (`:batchEmbedContents`),
 * https://cloud.google.com/apis/design/errors (`RetryInfo.retryDelay` w `error.details[]`).
 */
import { DEFAULT_EMBED_MODELS, GEMINI_EMBED_BASE_URL } from '../contracts.js';
import { defaultCountTokens, safeJsonBody } from './_shared.js';
import { EmbedBatchError } from '../embedErrors.js';
import type {
    EmbeddingProvider,
    EmbeddingProviderInfo,
    EmbeddingProviderContext,
    EmbeddingModelSpec,
    EmbeddingModelInfo,
    HttpClient,
    HttpRequestSpec,
    HttpResponse,
    EmbedBatchErrorInit,
} from '../contracts.js';

/** Katalog TWARDYCH limitów — `batchSize:50` PRZEGRYWA z wyborem usera (B.6 GM-05, odwrotnie niż `maxInputTokens`). */
const MODEL_CATALOG: Readonly<Record<string, EmbeddingModelSpec>> = {
    'gemini-embedding-001': { maxInputTokens: 2048, batchSize: 50, dims: 3072 },
};

interface GeminiEmbedBody {
    embeddings?: Array<{ values?: unknown }>;
}

interface GeminiRetryInfoDetail {
    '@type'?: string;
    retryDelay?: string;
}

interface GeminiErrorBody {
    error?: { code?: number; message?: string; details?: GeminiRetryInfoDetail[] };
}

/** `"7s"` / `"1.5s"` (Google `Duration`, RFC per `RetryInfo.retryDelay`) → ms. Format nierozpoznany → `undefined`. */
function parseGoogleDurationToMs(duration: string | undefined): number | undefined {
    if (!duration) return undefined;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
    if (!match) return undefined;
    return Math.round(Number(match[1]) * 1000);
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
    readonly info: EmbeddingProviderInfo = {
        id: 'gemini',
        label: 'Google Gemini',
        local: false,
        needsApiKey: true,
        defaultModel: DEFAULT_EMBED_MODELS.gemini,
        defaultEndpoint: GEMINI_EMBED_BASE_URL,
        listsModels: false,
    };

    modelSpec(modelId: string): EmbeddingModelSpec | undefined {
        return MODEL_CATALOG[modelId];
    }

    /** Katalog statyczny (`info.listsModels === false`) — bez wywołania sieciowego. */
    async listModels(_ctx: EmbeddingProviderContext, _http: HttpClient): Promise<EmbeddingModelInfo[]> {
        return Object.entries(MODEL_CATALOG).map(([id, spec]) => ({
            id,
            maxInputTokens: spec.maxInputTokens,
            dims: spec.dims,
        }));
    }

    /** `POST {base}/models/{model}:batchEmbedContents`, `x-goog-api-key`, `{requests:[{model,content}]}` (C-16). */
    buildEmbedRequest(texts: string[], ctx: EmbeddingProviderContext): HttpRequestSpec {
        const modelPath = `models/${ctx.modelId}`;
        return {
            url: `${ctx.endpoint}/${modelPath}:batchEmbedContents`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': ctx.apiKey ?? '',
            },
            body: JSON.stringify({
                requests: texts.map(text => ({ model: modelPath, content: { parts: [{ text }] } })),
            }),
        };
    }

    /** `{embeddings:[{values}]}` w kolejności wejść (C-17) — nierozpoznany kształt → rzut `shape`. */
    parseEmbedResponse(body: unknown, _texts: string[], ctx: EmbeddingProviderContext): number[][] {
        const parsed = body as GeminiEmbedBody | null | undefined;
        const embeddings = parsed?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.some(e => !Array.isArray(e?.values))) {
            throw new EmbedBatchError({
                kind: 'shape',
                code: 'bad_shape',
                message: 'gemini: odpowiedź embeddingu nie ma rozpoznawalnego pola "embeddings[].values"',
                providerId: 'gemini',
                modelId: ctx.modelId,
            });
        }
        return embeddings.map(e => e.values as number[]);
    }

    /**
     * Błąd inny niż 429 leci od razu, bez `retryAfterMs` (GM-03). Dla 429 czyta
     * `error.details[].retryDelay` (`RetryInfo`) — brak pola → `retryAfterMs` `undefined`,
     * MUSI działać bez niego (ta gałąź podbijała mnożnik backoffu, C-18).
     */
    parseEmbedError(
        res: HttpResponse,
        ctx: EmbeddingProviderContext,
    ): { error: EmbedBatchErrorInit; retryAfterMs?: number } {
        const body = safeJsonBody<GeminiErrorBody>(res);
        const message = body?.error?.message || res.text || `HTTP ${res.status}`;
        const httpStatus = res.status;
        const retryInfo = body?.error?.details?.find(
            d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo',
        );
        return {
            error: {
                kind: 'api',
                code: httpStatus === 429 ? 'rate_limited' : 'http_error',
                message,
                httpStatus,
                providerId: 'gemini',
                modelId: ctx.modelId,
            },
            retryAfterMs: httpStatus === 429 ? parseGoogleDurationToMs(retryInfo?.retryDelay) : undefined,
        };
    }

    countTokens(text: string): number {
        return defaultCountTokens(text);
    }
}
