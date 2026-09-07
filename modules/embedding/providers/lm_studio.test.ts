/**
 * providers/lm_studio.test.ts — nowe testy C-14 (napisany przed implementacją, czerwony na
 * stubie, dziś zielony) i C-15 (AUTOR). Każda metoda `LmStudioEmbeddingProvider` rzucała
 * `not implemented` na stubie.
 */
import test from 'ava';
import { LmStudioEmbeddingProvider } from './lm_studio.js';
import { isEmbedBatchError } from '../embedErrors.js';
import { LM_STUDIO_EMBED_BASE_URL, DEFAULT_MAX_INPUT_TOKENS } from '../contracts.js';
import type { EmbeddingProviderContext, HttpClient, HttpRequestSpec, HttpResponse } from '../contracts.js';

function makeCtx(overrides: Partial<EmbeddingProviderContext> = {}): EmbeddingProviderContext {
    return {
        modelId: 'nomic-embed-text-v1.5',
        apiKey: undefined,
        endpoint: LM_STUDIO_EMBED_BASE_URL,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        ...overrides,
    };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
    const text = JSON.stringify(body);
    return { status, headers: {}, text, json: <T>() => JSON.parse(text) as T };
}

function fakeHttp(router: (spec: HttpRequestSpec) => HttpResponse): HttpClient {
    return { async send(spec) { return router(spec); } };
}

test('C-14: listModels bierze WYŁĄCZNIE wpisy type === \'embeddings\' (natywny /api/v0/models)', async t => {
    const provider = new LmStudioEmbeddingProvider();
    const http = fakeHttp(() => jsonResponse(200, {
        data: [
            { id: 'nomic-embed-text-v1.5', type: 'embeddings', loaded_context_length: 2048 },
            { id: 'llama-3-8b', type: 'llm' },
            { id: 'bge-large', type: 'embeddings', loaded_context_length: 512 },
        ],
    }));

    const models = await provider.listModels(makeCtx(), http);
    t.deepEqual(models.map(m => m.id).sort(), ['bge-large', 'nomic-embed-text-v1.5']);
});

test('listModels: GET trafia w {nativeBase}/api/v0/models — /v1 zdjęte z {base} (warstwa OpenAI vs natywny REST)', async t => {
    const provider = new LmStudioEmbeddingProvider();
    let capturedUrl: string | undefined;
    const http = fakeHttp(spec => {
        capturedUrl = spec.url;
        return jsonResponse(200, { data: [] });
    });

    await provider.listModels(makeCtx({ endpoint: 'http://localhost:1234/v1' }), http);
    t.is(capturedUrl, 'http://localhost:1234/api/v0/models', '/v1 musi zniknąć — inaczej trafiamy w nieistniejący adres');
});

test('listModels: {base} bez końcowego /v1 (np. już pozbawiony sufiksu) zostaje bez zmian', async t => {
    const provider = new LmStudioEmbeddingProvider();
    let capturedUrl: string | undefined;
    const http = fakeHttp(spec => {
        capturedUrl = spec.url;
        return jsonResponse(200, { data: [] });
    });

    await provider.listModels(makeCtx({ endpoint: 'http://localhost:1234' }), http);
    t.is(capturedUrl, 'http://localhost:1234/api/v0/models');
});

test('buildEmbedRequest: POST {endpoint}/embeddings, {model, input[]} (kształt OpenAI)', t => {
    const provider = new LmStudioEmbeddingProvider();
    const spec = provider.buildEmbedRequest(['hello', 'world'], makeCtx());

    t.is(spec.method, 'POST');
    t.is(spec.url, `${LM_STUDIO_EMBED_BASE_URL}/embeddings`);
    const body = JSON.parse(String(spec.body)) as { model: string; input: string[] };
    t.is(body.model, 'nomic-embed-text-v1.5');
    t.deepEqual(body.input, ['hello', 'world']);
});

test('parseEmbedResponse: data[].embedding w kolejności wejść', t => {
    const provider = new LmStudioEmbeddingProvider();
    const ctx = makeCtx();
    const body = { data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }] };
    const vectors = provider.parseEmbedResponse(body, ['a', 'b'], ctx);
    t.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
});

test('parseEmbedResponse: ciało bez `data` -> EmbedBatchError{kind:\'shape\'}', t => {
    const provider = new LmStudioEmbeddingProvider();
    const ctx = makeCtx();
    const err = t.throws(() => provider.parseEmbedResponse({ nie_ma_data: true }, ['a'], ctx));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) t.is(err.kind, 'shape');
});

test('parseEmbedError: status >= 400 oddaje EmbedBatchErrorInit z httpStatus i wiadomością', t => {
    const provider = new LmStudioEmbeddingProvider();
    const ctx = makeCtx();
    const res = jsonResponse(500, { error: { message: 'model not loaded' } });
    const { error } = provider.parseEmbedError(res, ctx);
    t.is(error.httpStatus, 500);
    t.regex(error.message, /model not loaded/);
});

test('countTokens: estymata znaki/TOKEN_CHARS_PER_TOKEN zaokrąglona w górę, nigdy undefined', t => {
    const provider = new LmStudioEmbeddingProvider();
    const text = 'hello world, this is a test string';
    t.is(provider.countTokens(text), Math.ceil(text.length / 3.7));
    t.is(provider.countTokens(''), 0);
});

test('C-15: brak loaded_context_length -> modelSpec() undefined (model spada na 512)', t => {
    const provider = new LmStudioEmbeddingProvider();
    // Katalog LM Studio jest budowany dynamicznie z /api/v0/models — bez ANI JEDNEGO wywołania
    // listModels() dla nieznanego modelu, modelSpec() musi fail-safe oddać undefined (gotcha 11
    // modułu), a EmbeddingModel spada wtedy na DEFAULT_MAX_INPUT_TOKENS.
    const spec = provider.modelSpec('model-nigdy-nie-widziany-przez-listModels');
    t.is(spec, undefined);
    t.is(DEFAULT_MAX_INPUT_TOKENS, 512);
});
