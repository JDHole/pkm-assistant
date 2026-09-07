/**
 * modules/embedding/providers/ollama.ts — dostawca Ollamy (`/api/embed`, `/api/tags` + filtr
 * `embed|embedding|bge`, `context_length` z `/api/show`).
 *
 * `modelSpec()` ŚWIADOMIE zawsze oddaje `undefined` — modele Ollamy są instalowane lokalnie
 * przez użytkownika (dowolne nazwy, dowolne konteksty), więc nie ma statycznego katalogu
 * limitów jak u OpenAI/Gemini. Model spada na `DEFAULT_MAX_INPUT_TOKENS` (fail-safe).
 *
 * Zimny start (ładowanie modelu z dysku) potrafi przekroczyć sufit czasu żądania — to
 * normalne, `VaultIndexer` ponawia porcję (gotcha 12 modułu); ta warstwa tego nie leczy.
 *
 * Źródło kształtu: https://github.com/ollama/ollama/blob/main/docs/api.md
 *   (§ Generate Embeddings, § List Local Models, § Show Model Information)
 */
import { DEFAULT_EMBED_MODELS, OLLAMA_EMBED_BASE_URL } from '../contracts.js';
import { defaultCountTokens, parseRetryAfterHeader, safeJsonBody } from './_shared.js';
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

/** Nazwa modelu wygląda jak embedding — dopasowanie po `name`/`model` z `/api/tags` (spec §1.2). */
const EMBED_MODEL_NAME_PATTERN = /embed|embedding|bge/i;

interface OllamaTagsBody {
    models?: Array<{ name?: string; model?: string }>;
}

interface OllamaShowBody {
    model_info?: Record<string, unknown>;
}

interface OllamaEmbedBody {
    embeddings?: unknown;
}

interface OllamaErrorBody {
    error?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
    readonly info: EmbeddingProviderInfo = {
        id: 'ollama',
        label: 'Ollama',
        local: true,
        needsApiKey: false,
        defaultModel: DEFAULT_EMBED_MODELS.ollama,
        defaultEndpoint: OLLAMA_EMBED_BASE_URL,
        listsModels: true,
    };

    modelSpec(_modelId: string): EmbeddingModelSpec | undefined {
        return undefined;
    }

    /**
     * `GET {endpoint}/api/tags` → filtr nazw embeddingowych → `POST {endpoint}/api/show`
     * per model, dla `context_length` (`model_info['general.context_length']`, C-12).
     * Model, dla którego `/api/show` nie odpowie 200, dostaje wpis bez `maxInputTokens`
     * (fail-safe — jeden zawieszony model nie ma prawa wywalić całej listy).
     */
    async listModels(ctx: EmbeddingProviderContext, http: HttpClient): Promise<EmbeddingModelInfo[]> {
        const tagsRes = await http.send({ url: `${ctx.endpoint}/api/tags`, method: 'GET', headers: {} });
        if (tagsRes.status !== 200) return [];
        const tagsBody = tagsRes.json<OllamaTagsBody>();
        const names = (tagsBody.models ?? [])
            .map(m => m.name ?? m.model ?? '')
            .filter(name => EMBED_MODEL_NAME_PATTERN.test(name));

        return Promise.all(
            names.map(async name => {
                const showRes = await http.send({
                    url: `${ctx.endpoint}/api/show`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: name }),
                });
                if (showRes.status !== 200) return { id: name };
                const showBody = safeJsonBody<OllamaShowBody>(showRes);
                const contextLength = showBody?.model_info?.['general.context_length'];
                return {
                    id: name,
                    maxInputTokens: typeof contextLength === 'number' ? contextLength : undefined,
                };
            }),
        );
    }

    /** `POST {endpoint}/api/embed` — host bierze się z ustawień (`ctx.endpoint`), nie z defaultu (C-13). */
    buildEmbedRequest(texts: string[], ctx: EmbeddingProviderContext): HttpRequestSpec {
        return {
            url: `${ctx.endpoint}/api/embed`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: ctx.modelId, input: texts }),
        };
    }

    /** `{embeddings: number[][]}` w kolejności wejść — nierozpoznany kształt → rzut `shape`. */
    parseEmbedResponse(body: unknown, _texts: string[], ctx: EmbeddingProviderContext): number[][] {
        const parsed = body as OllamaEmbedBody | null | undefined;
        const embeddings = parsed?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.some(v => !Array.isArray(v))) {
            throw new EmbedBatchError({
                kind: 'shape',
                code: 'bad_shape',
                message: 'ollama: odpowiedź embeddingu nie ma rozpoznawalnego pola "embeddings"',
                providerId: 'ollama',
                modelId: ctx.modelId,
            });
        }
        return embeddings as number[][];
    }

    /** Ollama oddaje błąd jako `{error: 'komunikat'}` (string, nie zagnieżdżony obiekt). */
    parseEmbedError(
        res: HttpResponse,
        ctx: EmbeddingProviderContext,
    ): { error: EmbedBatchErrorInit; retryAfterMs?: number } {
        const body = safeJsonBody<OllamaErrorBody>(res);
        const message = body?.error || res.text || `HTTP ${res.status}`;
        const httpStatus = res.status;
        return {
            error: {
                kind: 'api',
                code: httpStatus === 429 ? 'rate_limited' : 'http_error',
                message,
                httpStatus,
                providerId: 'ollama',
                modelId: ctx.modelId,
            },
            retryAfterMs: parseRetryAfterHeader(res.headers),
        };
    }

    countTokens(text: string): number {
        return defaultCountTokens(text);
    }
}
