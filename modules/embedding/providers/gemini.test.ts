/**
 * providers/gemini.test.ts — kształt żądania/odpowiedzi Gemini (`contracts.ts` §5).
 *
 * Reshape z `gemini_adapter.test.ts` (GM-03, GM-04 — błąd nie-429 i katalog limitów są
 * sprawą DOSTAWCY; GM-01/GM-02/GM-05 poszły do `EmbeddingModel.test.ts` — backoff jest
 * dziś wspólny) + nowe testy C-16/C-17/C-18.
 *
 * Napisany przed implementacją (czerwony na stubie — każda metoda `GeminiEmbeddingProvider`
 * rzucała `not implemented`), dziś zielony.
 */
import test from 'ava';
import { GeminiEmbeddingProvider } from './gemini.js';
import { GEMINI_EMBED_BASE_URL } from '../contracts.js';
import { defaultCountTokens } from './_shared.js';
import { EmbedBatchError } from '../embedErrors.js';
import type { EmbeddingProviderContext, HttpResponse } from '../contracts.js';

function makeCtx(overrides: Partial<EmbeddingProviderContext> = {}): EmbeddingProviderContext {
    return {
        modelId: 'gemini-embedding-001',
        apiKey: 'goog-test-dummy',
        endpoint: GEMINI_EMBED_BASE_URL,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        ...overrides,
    };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
    const text = JSON.stringify(body);
    return { status, headers: {}, text, json: <T>() => JSON.parse(text) as T };
}

test('C-16: żądanie: POST {base}/models/{model}:batchEmbedContents, x-goog-api-key, requests[]', t => {
    const provider = new GeminiEmbeddingProvider();
    const spec = provider.buildEmbedRequest(['hello', 'world'], makeCtx());

    t.is(spec.method, 'POST');
    t.is(spec.url, `${GEMINI_EMBED_BASE_URL}/models/gemini-embedding-001:batchEmbedContents`);
    t.is(spec.headers['x-goog-api-key'], 'goog-test-dummy');
    t.falsy(spec.url.includes('key='), 'klucz NIGDY w query-stringu — wyciekałby przez log URL-a (K20)');
    const body = JSON.parse(String(spec.body)) as { requests: Array<{ model: string; content: { parts: Array<{ text: string }> } }> };
    t.is(body.requests.length, 2);
    t.is(body.requests[0].content.parts[0].text, 'hello');
});

test('C-17: odpowiedź embeddings[].values czytana w kolejności', t => {
    const provider = new GeminiEmbeddingProvider();
    const body = { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] };
    const vectors = provider.parseEmbedResponse(body, ['a', 'b'], makeCtx());
    t.deepEqual(vectors, [[1, 2], [3, 4]]);
});

test('parseEmbedResponse: brak pola embeddings -> rzut EmbedBatchError{kind:"shape"}', t => {
    const provider = new GeminiEmbeddingProvider();
    const error = t.throws(() => provider.parseEmbedResponse({}, ['a'], makeCtx()), {
        instanceOf: EmbedBatchError,
    });
    t.is(error?.kind, 'shape');
    t.is(error?.code, 'bad_shape');
});

test('parseEmbedResponse: jeden wpis embeddings[].values nie-tablicą -> rzut, mimo że reszta poprawna', t => {
    const provider = new GeminiEmbeddingProvider();
    const body = { embeddings: [{ values: [1, 2] }, { values: 'nie-tablica' }] };
    const error = t.throws(() => provider.parseEmbedResponse(body, ['a', 'b'], makeCtx()), {
        instanceOf: EmbedBatchError,
    });
    t.is(error?.kind, 'shape');
});

test('GM-03: błąd inny niż 429 leci w górę od razu — komunikat niesie "API key invalid", brak retryAfterMs', t => {
    const provider = new GeminiEmbeddingProvider();
    const res = jsonResponse(400, { error: { code: 400, message: 'API key invalid' } });
    const { error, retryAfterMs } = provider.parseEmbedError(res, makeCtx());
    t.is(error.kind, 'api');
    t.is(error.code, 'http_error', 'status != 429 -> code http_error, nie rate_limited');
    t.regex(error.message, /API key invalid/);
    t.is(retryAfterMs, undefined);
});

test('parseEmbedError: 429 -> code rate_limited (rozróżnienie od http_error)', t => {
    const provider = new GeminiEmbeddingProvider();
    const res = jsonResponse(429, { error: { code: 429, message: 'rate limited' } });
    const { error } = provider.parseEmbedError(res, makeCtx());
    t.is(error.code, 'rate_limited');
    t.is(error.httpStatus, 429);
});

test('parseEmbedError: error.message ma pierwszeństwo nad res.text nawet gdy res.text jest puste', t => {
    const provider = new GeminiEmbeddingProvider();
    const res: HttpResponse = {
        status: 400,
        headers: {},
        text: '',
        json: <T>() => ({ error: { code: 400, message: 'API key invalid' } }) as T,
    };
    const { error } = provider.parseEmbedError(res, makeCtx());
    t.is(error.message, 'API key invalid');
});

test('parseEmbedError: brak error.message -> spada na res.text', t => {
    const provider = new GeminiEmbeddingProvider();
    const res: HttpResponse = {
        status: 500,
        headers: {},
        text: 'internal error text',
        json: <T>() => ({}) as T,
    };
    const { error } = provider.parseEmbedError(res, makeCtx());
    t.is(error.message, 'internal error text');
});

test('GM-04: limity Gemini biorą się z katalogu adaptera — {maxInputTokens:2048, batchSize:50}', t => {
    const provider = new GeminiEmbeddingProvider();
    const spec = provider.modelSpec('gemini-embedding-001');
    t.is(spec?.maxInputTokens, 2048);
    t.is(spec?.batchSize, 50);
});

test('C-18: retryDelay z ciała 429 trafia do retryAfterMs; brak retryDelay -> undefined', t => {
    const provider = new GeminiEmbeddingProvider();
    const ctx = makeCtx();

    const z429ZRetryDelay = jsonResponse(429, {
        error: {
            code: 429,
            message: 'rate limited',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
        },
    });
    const a = provider.parseEmbedError(z429ZRetryDelay, ctx);
    t.is(a.retryAfterMs, 7000);

    const bezRetryDelay = jsonResponse(429, { error: { code: 429, message: 'rate limited' } });
    const b = provider.parseEmbedError(bezRetryDelay, ctx);
    t.is(b.retryAfterMs, undefined);
});

test('countTokens: deleguje do defaultCountTokens (znaki / TOKEN_CHARS_PER_TOKEN)', t => {
    const provider = new GeminiEmbeddingProvider();
    const text = 'x'.repeat(37);
    t.is(provider.countTokens(text), defaultCountTokens(text));
    t.not(provider.countTokens(text), undefined);
});
