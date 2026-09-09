/**
 * providers/openai.test.ts - kształt żądania/odpowiedzi OpenAI (`contracts.ts` §5).
 */
import test from 'ava';
import { OpenAiEmbeddingProvider } from './openai.js';
import { isEmbedBatchError } from '../embedErrors.js';
import { OPENAI_EMBED_BASE_URL } from '../contracts.js';
import type { EmbeddingProviderContext, HttpResponse } from '../contracts.js';

function makeCtx(overrides: Partial<EmbeddingProviderContext> = {}): EmbeddingProviderContext {
    return {
        modelId: 'text-embedding-3-small',
        apiKey: 'sk-test-dummy',
        endpoint: OPENAI_EMBED_BASE_URL,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        ...overrides,
    };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
    const text = JSON.stringify(body);
    return { status, headers: {}, text, json: <T>() => JSON.parse(text) as T };
}

test('żądanie: POST {base}/embeddings, Bearer, {model, input[]}', t => {
    const provider = new OpenAiEmbeddingProvider();
    const spec = provider.buildEmbedRequest(['hello', 'world'], makeCtx());

    t.is(spec.method, 'POST');
    t.is(spec.url, `${OPENAI_EMBED_BASE_URL}/embeddings`);
    t.is(spec.headers.Authorization, 'Bearer sk-test-dummy');
    const body = JSON.parse(String(spec.body)) as { model: string; input: string[] };
    t.is(body.model, 'text-embedding-3-small');
    t.deepEqual(body.input, ['hello', 'world']);
});

test('modelSpec: katalog: text-embedding-3-small → 8191', t => {
    const provider = new OpenAiEmbeddingProvider();
    t.is(provider.modelSpec('text-embedding-3-small')?.maxInputTokens, 8191);
});

test('parseEmbedResponse: ciało bez `data` → EmbedBatchError{kind:\'shape\'}', t => {
    const provider = new OpenAiEmbeddingProvider();
    const ctx = makeCtx();
    const err = t.throws(() => provider.parseEmbedResponse({ nie_ma_data: true }, ['a'], ctx));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) t.is(err.kind, 'shape');
});

test('odpowiedź: data[].embedding w kolejności, usage.total_tokens w tokens', t => {
    const provider = new OpenAiEmbeddingProvider();
    const ctx = makeCtx();
    const body = {
        data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }],
        usage: { total_tokens: 42 },
    };
    const vectors = provider.parseEmbedResponse(body, ['a', 'b'], ctx);
    t.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
});

test('parseEmbedError: status ≥ 400 oddaje EmbedBatchErrorInit z httpStatus', t => {
    const provider = new OpenAiEmbeddingProvider();
    const ctx = makeCtx();
    const res = jsonResponse(429, { error: { message: 'Rate limit exceeded' } });
    const { error } = provider.parseEmbedError(res, ctx);
    t.is(error.httpStatus, 429);
    t.regex(error.message, /Rate limit exceeded/);
});

test('countTokens: estymata znaki/TOKEN_CHARS_PER_TOKEN zaokrąglona w górę, nie undefined', t => {
    const provider = new OpenAiEmbeddingProvider();
    const text = 'hello world, this is a test string';
    t.is(provider.countTokens(text), Math.ceil(text.length / 3.7));
    t.is(provider.countTokens(''), 0);
});

test('parseEmbedError: limit zgłoszony w CIELE (status 200, {error:{code:429}}) podbija httpStatus na 429 mimo statusu HTTP', t => {
    const provider = new OpenAiEmbeddingProvider();
    const ctx = makeCtx();
    const res = jsonResponse(200, { error: { code: 429, message: 'Rate limit reached' } });
    const { error } = provider.parseEmbedError(res, ctx);
    t.is(error.httpStatus, 429, 'kod z ciała ma pierwszeństwo nad statusem HTTP');
    t.is(error.code, 'rate_limited');
    t.regex(error.message, /Rate limit reached/);
});
