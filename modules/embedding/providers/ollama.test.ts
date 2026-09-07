/**
 * providers/ollama.test.ts — nowe testy C-12/C-13 (spec §1.2 — Ollama REST API).
 * Napisany przed implementacją (czerwony na stubie — każda metoda `OllamaEmbeddingProvider`
 * rzucała `not implemented`), dziś zielony.
 */
import test from 'ava';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OLLAMA_EMBED_BASE_URL } from '../contracts.js';
import { defaultCountTokens } from './_shared.js';
import { isEmbedBatchError } from '../embedErrors.js';
import type { EmbeddingProviderContext, HttpClient, HttpRequestSpec, HttpResponse } from '../contracts.js';

function makeCtx(overrides: Partial<EmbeddingProviderContext> = {}): EmbeddingProviderContext {
    return {
        modelId: 'nomic-embed-text',
        apiKey: undefined,
        endpoint: OLLAMA_EMBED_BASE_URL,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        ...overrides,
    };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
    const text = JSON.stringify(body);
    return { status, headers: {}, text, json: <T>() => JSON.parse(text) as T };
}

function fakeHttp(router: (spec: HttpRequestSpec) => HttpResponse): { http: HttpClient; calls: HttpRequestSpec[] } {
    const calls: HttpRequestSpec[] = [];
    return {
        calls,
        http: {
            async send(spec) {
                calls.push(spec);
                return router(spec);
            },
        },
    };
}

test('C-12: listModels filtruje po nazwie (embed/embedding/bge) i czyta context_length z /api/show', async t => {
    const provider = new OllamaEmbeddingProvider();
    const { http } = fakeHttp((spec) => {
        if (spec.url.endsWith('/api/tags')) {
            return jsonResponse(200, {
                models: [
                    { name: 'nomic-embed-text' },
                    { name: 'llama3' },
                    { name: 'mistral' },
                    { name: 'bge-small' },
                ],
            });
        }
        return jsonResponse(200, { model_info: { 'general.context_length': 2048 } });
    });

    const models = await provider.listModels(makeCtx(), http);
    const ids = models.map(m => m.id);
    t.deepEqual(ids.sort(), ['bge-small', 'nomic-embed-text'], '4 modele wejściowe, 2 embeddingowe (embed/bge)');
    t.false(ids.includes('llama3') || ids.includes('mistral'), 'model bez embed/embedding/bge w nazwie nie jest modelem embeddingu');
});

test('C-13: żądanie embeddingu leci na host z ustawień, nie na domyślny', t => {
    const provider = new OllamaEmbeddingProvider();
    const spec = provider.buildEmbedRequest(['a'], makeCtx({ endpoint: 'http://192.168.0.9:11434' }));
    t.true(spec.url.startsWith('http://192.168.0.9:11434'), `URL powinien zawierać host z ustawień: ${spec.url}`);
});

test('listModels: /api/show odpowiada 200 z context_length → wpis niesie maxInputTokens', async t => {
    const provider = new OllamaEmbeddingProvider();
    const { http } = fakeHttp((spec) => {
        if (spec.url.endsWith('/api/tags')) {
            return jsonResponse(200, { models: [{ name: 'nomic-embed-text' }] });
        }
        return jsonResponse(200, { model_info: { 'general.context_length': 2048 } });
    });

    const models = await provider.listModels(makeCtx(), http);
    t.deepEqual(models, [{ id: 'nomic-embed-text', maxInputTokens: 2048 }]);
});

test('listModels: /api/show odpowiada status != 200 → wpis BEZ maxInputTokens (fail-safe)', async t => {
    const provider = new OllamaEmbeddingProvider();
    const { http } = fakeHttp((spec) => {
        if (spec.url.endsWith('/api/tags')) {
            return jsonResponse(200, { models: [{ name: 'nomic-embed-text' }] });
        }
        return jsonResponse(500, { error: 'model unloaded' });
    });

    const models = await provider.listModels(makeCtx(), http);
    t.deepEqual(models, [{ id: 'nomic-embed-text' }], 'brak maxInputTokens gdy /api/show nie odpowiada 200');
});

test('listModels: /api/tags z polem "models" fałszywym-nienullowym (nie tablica) rzuca zamiast cichego fallbacku', async t => {
    const provider = new OllamaEmbeddingProvider();
    const { http } = fakeHttp((spec) => {
        if (spec.url.endsWith('/api/tags')) {
            // Kształt świadomie łamiący kontrakt (models: false zamiast tablicy/undefined) —
            // ?? traktuje `false` jako wartość (nie jest nullish), więc .map() na niej rzuca.
            return jsonResponse(200, { models: false } as never);
        }
        return jsonResponse(200, {});
    });

    await t.throwsAsync(() => provider.listModels(makeCtx(), http));
});

test('parseEmbedResponse: kształt poprawny → oddaje embeddings 1:1', t => {
    const provider = new OllamaEmbeddingProvider();
    const result = provider.parseEmbedResponse({ embeddings: [[1, 2, 3], [4, 5, 6]] }, ['a', 'b'], makeCtx());
    t.deepEqual(result, [[1, 2, 3], [4, 5, 6]]);
});

test('parseEmbedResponse: element "embeddings" nie-tablicowy → rzuca EmbedBatchError{kind:shape}', t => {
    const provider = new OllamaEmbeddingProvider();
    const err = t.throws(() => provider.parseEmbedResponse({ embeddings: [[1, 2], 'zle'] }, ['a', 'b'], makeCtx()));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) t.is(err.kind, 'shape');
});

test('parseEmbedResponse: pole "embeddings" nieobecne → rzuca EmbedBatchError{kind:shape}', t => {
    const provider = new OllamaEmbeddingProvider();
    const err = t.throws(() => provider.parseEmbedResponse({}, ['a'], makeCtx()));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) t.is(err.kind, 'shape');
});

test('parseEmbedError: body.error wygrywa z res.text (nie odwrotnie)', t => {
    const provider = new OllamaEmbeddingProvider();
    const res: HttpResponse = {
        status: 500,
        headers: {},
        text: '',
        json: <T>() => ({ error: 'boom' }) as T,
    };
    const { error } = provider.parseEmbedError(res, makeCtx());
    t.is(error.message, 'boom');
    t.is(error.code, 'http_error');
});

test('parseEmbedError: status 429 → code rate_limited (nie 430, nie http_error)', t => {
    const provider = new OllamaEmbeddingProvider();
    const res = jsonResponse(429, { error: 'too many requests' });
    const { error } = provider.parseEmbedError(res, makeCtx());
    t.is(error.code, 'rate_limited');
    t.is(error.httpStatus, 429);
});

test('countTokens: deleguje do estymaty wspólnej (znaki / TOKEN_CHARS_PER_TOKEN)', t => {
    const provider = new OllamaEmbeddingProvider();
    const text = 'to jest przykładowy tekst do policzenia tokenów';
    t.is(provider.countTokens(text), defaultCountTokens(text));
    t.true(provider.countTokens(text) > 0);
});
