/**
 * modules/embedding/providers/lm_studio.ts — dostawca LM Studio (kształt OpenAI, host lokalny,
 * `listModels` po `type === 'embeddings'` z natywnego `/api/v0/models`).
 *
 * DWA API współistnieją (gotcha 13 modułu): warstwa zgodna z OpenAI (`{base}/embeddings`, ten
 * sam kształt co `openai.ts`) SŁUŻY do samego embeddingu, ale nie mówi, który model jest
 * embeddingowy — tę informację (`type`, `loaded_context_length`) daje WYŁĄCZNIE natywny REST
 * pod `/api/v0/models`, na innym prefiksie niż `{base}` (`{base}` kończy się na `/v1`).
 *
 * `modelSpec()` ŚWIADOMIE zawsze oddaje `undefined` — katalog LM Studio nie jest statyczny
 * (użytkownik ładuje dowolne modele), a `listModels()` dziś nie ma konsumenta produkcyjnego,
 * więc nie ma skąd wziąć cache'u kontekstu. Model spada wtedy na `DEFAULT_MAX_INPUT_TOKENS`
 * (512) — to świadomy, udokumentowany wyjątek (C-15).
 *
 * Źródła kształtu: https://lmstudio.ai/docs/app/api/endpoints/openai (embedding),
 * natywny `/api/v0/models` z polem `type` (kontrakt pinowany testem C-14).
 */
import { DEFAULT_EMBED_MODELS, LM_STUDIO_EMBED_BASE_URL } from '../contracts.js';
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

interface LmStudioNativeModelEntry {
    id: string;
    type?: string;
    loaded_context_length?: number;
}

interface LmStudioNativeModelsBody {
    data?: LmStudioNativeModelEntry[];
}

/** `{base}` kończy się na `/v1` (warstwa zgodna z OpenAI) — natywny REST żyje jeden poziom wyżej. */
function nativeBase(endpoint: string): string {
    return endpoint.replace(/\/v1\/?$/, '');
}

export class LmStudioEmbeddingProvider implements EmbeddingProvider {
    readonly info: EmbeddingProviderInfo = {
        id: 'lm_studio',
        label: 'LM Studio',
        local: true,
        needsApiKey: false,
        defaultModel: DEFAULT_EMBED_MODELS.lm_studio,
        defaultEndpoint: LM_STUDIO_EMBED_BASE_URL,
        listsModels: true,
    };

    modelSpec(_modelId: string): EmbeddingModelSpec | undefined {
        return undefined;
    }

    /** `GET {nativeBase}/api/v0/models`, tylko wpisy `type === 'embeddings'` (C-14). */
    async listModels(ctx: EmbeddingProviderContext, http: HttpClient): Promise<EmbeddingModelInfo[]> {
        const res = await http.send({
            url: `${nativeBase(ctx.endpoint)}/api/v0/models`,
            method: 'GET',
            headers: {},
        });
        if (res.status !== 200) return [];
        const body = res.json<LmStudioNativeModelsBody>();
        const entries = Array.isArray(body?.data) ? body.data : [];
        return entries
            .filter(entry => entry.type === 'embeddings')
            .map(entry => ({ id: entry.id, maxInputTokens: entry.loaded_context_length }));
    }

    buildEmbedRequest(texts: string[], ctx: EmbeddingProviderContext): HttpRequestSpec {
        return buildOpenAiShapedEmbedRequest(ctx.endpoint, texts, ctx.modelId, ctx.apiKey);
    }

    parseEmbedResponse(body: unknown, _texts: string[], ctx: EmbeddingProviderContext): number[][] {
        return parseOpenAiShapedEmbedResponse(body, 'lm_studio', ctx.modelId);
    }

    parseEmbedError(
        res: HttpResponse,
        ctx: EmbeddingProviderContext,
    ): { error: EmbedBatchErrorInit; retryAfterMs?: number } {
        return parseOpenAiShapedEmbedError(res, 'lm_studio', ctx.modelId);
    }

    countTokens(text: string): number {
        return defaultCountTokens(text);
    }
}
