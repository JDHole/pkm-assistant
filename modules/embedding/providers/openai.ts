/**
 * modules/embedding/providers/openai.ts — dostawca OpenAI (`POST {base}/embeddings`,
 * `Bearer`, `{model, input[]}` → `{data:[{embedding}], usage}`) + katalog limitów
 * (`text-embedding-3-small` → 8191). Bezstanowy: buduje żądanie, czyta odpowiedź/błąd —
 * cała polityka retry/timeout/przycinania żyje w `EmbeddingModel` (§5 kontraktu).
 *
 * Źródło kształtu: https://platform.openai.com/docs/api-reference/embeddings/create
 */
import { DEFAULT_EMBED_MODELS, OPENAI_EMBED_BASE_URL } from '../contracts.js';
import { buildOpenAiShapedEmbedRequest, parseOpenAiShapedEmbedError, parseOpenAiShapedEmbedResponse, defaultCountTokens } from './_shared.js';
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

/**
 * Twarde limity modelu — NIE mylić z `model.data.max_tokens=512` (default fail-safe
 * z `EmbeddingModel`, EB-10/EB-12). Wymiary (`dims`) są informacyjne (UI, `listModels`);
 * `EmbeddingModel.dims` ich nie czyta (patrz `DEFAULT_VECTOR_DIM`).
 */
const MODEL_CATALOG: Readonly<Record<string, EmbeddingModelSpec>> = {
    'text-embedding-3-small': { maxInputTokens: 8191, dims: 1536 },
    'text-embedding-3-large': { maxInputTokens: 8191, dims: 3072 },
    'text-embedding-ada-002': { maxInputTokens: 8191, dims: 1536 },
};

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
    readonly info: EmbeddingProviderInfo = {
        id: 'openai',
        label: 'OpenAI',
        local: false,
        needsApiKey: true,
        defaultModel: DEFAULT_EMBED_MODELS.openai,
        defaultEndpoint: OPENAI_EMBED_BASE_URL,
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

    buildEmbedRequest(texts: string[], ctx: EmbeddingProviderContext): HttpRequestSpec {
        return buildOpenAiShapedEmbedRequest(ctx.endpoint, texts, ctx.modelId, ctx.apiKey);
    }

    parseEmbedResponse(body: unknown, _texts: string[], ctx: EmbeddingProviderContext): number[][] {
        return parseOpenAiShapedEmbedResponse(body, 'openai', ctx.modelId);
    }

    parseEmbedError(
        res: HttpResponse,
        ctx: EmbeddingProviderContext,
    ): { error: EmbedBatchErrorInit; retryAfterMs?: number } {
        return parseOpenAiShapedEmbedError(res, 'openai', ctx.modelId);
    }

    countTokens(text: string): number {
        return defaultCountTokens(text);
    }
}
