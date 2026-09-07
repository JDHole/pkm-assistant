/**
 * modules/embedding/providers/_shared.ts — pomoce WSPÓLNE dla dostawców embeddingu.
 *
 * Plik prywatny modułu (nie wychodzi przez `providers/index.ts` ani `modules/embedding/
 * index.ts`) — wewnątrz modułu wolno importować się swobodnie (REGUŁA GŁÓWNA repo).
 *
 * Dwóch dostawców (OpenAI, LM Studio) dzieli DOKŁADNIE ten sam kształt żądania/odpowiedzi
 * embeddingu (`{model, input[]}` → `{data:[{embedding}]}`) — stąd `buildOpenAiShapedEmbedRequest`
 * / `parseOpenAiShapedEmbedResponse` / `parseOpenAiShapedEmbedError`. Ollama i Gemini mają
 * własne kształty i piszą swoją logikę wprost w `ollama.ts` / `gemini.ts`, ale korzystają
 * z tych samych drobiazgów (estymata tokenów, odczyt `Retry-After`, bezpieczny `res.json()`).
 */
import { EmbedBatchError } from '../embedErrors.js';
import { TOKEN_CHARS_PER_TOKEN } from '../contracts.js';
import type { EmbeddingProviderId, HttpRequestSpec, HttpResponse, EmbedBatchErrorInit } from '../contracts.js';

/** Estymata tokenów: znaki / `TOKEN_CHARS_PER_TOKEN`, zaokrąglona w górę (§1 kontraktu). */
export function defaultCountTokens(text: string): number {
    return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN);
}

/**
 * `res.json()` nie ma prawa wywrócić wołającego, gdy ciało błędu nie jest JSON-em
 * (niektóre serwery lokalne odpisują zwykłym tekstem na 4xx/5xx).
 */
export function safeJsonBody<T>(res: HttpResponse): T | undefined {
    try {
        return res.json<T>();
    } catch {
        return undefined;
    }
}

/** Nagłówek `Retry-After` (sekundy, RFC 9110 §10.2.3) → ms. Nazwa nagłówka case-insensitive. */
export function parseRetryAfterHeader(headers: Record<string, string> | undefined): number | undefined {
    if (!headers) return undefined;
    const key = Object.keys(headers).find(k => k.toLowerCase() === 'retry-after');
    if (!key) return undefined;
    const seconds = Number(headers[key]);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return seconds * 1000;
}

// ── Kształt „OpenAI-owy" (OpenAI + LM Studio) ──────────────────────────────────────────

interface OpenAiShapedEmbedBody {
    data?: Array<{ embedding?: unknown }>;
}

interface OpenAiShapedErrorBody {
    error?: { message?: string; code?: number | string };
}

/** `POST {baseUrl}/embeddings`, `Bearer` gdy jest klucz, `{model, input[]}`. */
export function buildOpenAiShapedEmbedRequest(
    baseUrl: string,
    texts: string[],
    modelId: string,
    apiKey: string | undefined,
): HttpRequestSpec {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return {
        url: `${baseUrl}/embeddings`,
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId, input: texts }),
    };
}

/** `data[].embedding` w kolejności wejść. Kształt nierozpoznany → rzut `EmbedBatchError{kind:'shape'}`. */
export function parseOpenAiShapedEmbedResponse(
    body: unknown,
    providerId: EmbeddingProviderId,
    modelId: string,
): number[][] {
    const parsed = body as OpenAiShapedEmbedBody | null | undefined;
    const data = parsed?.data;
    if (!Array.isArray(data) || data.some(item => !Array.isArray(item?.embedding))) {
        throw new EmbedBatchError({
            kind: 'shape',
            code: 'bad_shape',
            message: `${providerId}: odpowiedź embeddingu nie ma rozpoznawalnego pola "data[].embedding"`,
            providerId,
            modelId,
        });
    }
    return data.map(item => item.embedding as number[]);
}

/** Błąd ≥400 (albo 200 z `{error:{code:429}}` w ciele — OpenAI potrafi tak oddać limit, B.5 EB-02). */
export function parseOpenAiShapedEmbedError(
    res: HttpResponse,
    providerId: EmbeddingProviderId,
    modelId: string,
): { error: EmbedBatchErrorInit; retryAfterMs?: number } {
    const body = safeJsonBody<OpenAiShapedErrorBody>(res);
    const bodyCode = body?.error?.code;
    const httpStatus = bodyCode === 429 || bodyCode === '429' ? 429 : res.status;
    const message = body?.error?.message || res.text || `HTTP ${res.status}`;
    return {
        error: {
            kind: 'api',
            code: httpStatus === 429 ? 'rate_limited' : 'http_error',
            message,
            httpStatus,
            providerId,
            modelId,
        },
        retryAfterMs: parseRetryAfterHeader(res.headers),
    };
}
