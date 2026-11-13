import test from 'ava';
import { FetchStreamTransport } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { CHAT_PROVIDERS } from '../models/index.js';
import { probeConnection } from './connection.js';
import { setLocale } from '../../core/i18n/index.js';

test.beforeEach(() => setLocale('en'));

test('production transport measures two raw chunks with a single short streaming request', async t => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const encoder = new TextEncoder();
    const transport = new FetchStreamTransport(async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
        } }), { status: 200 });
    });
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test-model', apiKey: 'test-secret-123', log }, transport,
        new AbortController().signal);
    t.is(result.status, 'ok');
    if (result.status !== 'ok') return t.fail('Expected a model stream');
    t.is(result.httpStatus, 200); t.is(result.chunks, 2);
    t.true(result.firstChunkMs !== null && result.firstChunkMs >= 0);
    t.true(result.totalMs >= 0);
    t.is(requests.length, 1);
    const body = JSON.parse(String(requests[0].init?.body));
    t.deepEqual(body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
    t.is(body.stream, true); t.is(body.model, 'test-model');
    t.is(body.max_tokens, 16);
});

test('HTTP 429 returns only structured metadata without retry', async t => {
    let requests = 0;
    const transport = new FetchStreamTransport(async () => { requests++; return new Response('quota rejected test-secret-123', { status: 429 }); });
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test-model', apiKey: 'test-secret-123', log }, transport,
        new AbortController().signal);
    t.is(result.status, 'error'); t.is(requests, 1);
    if (result.status !== 'error') return t.fail('Expected HTTP failure');
    t.is(result.kind, 'http'); t.is(result.httpStatus, 429); t.is(result.chunks, 1);
    t.is(result.providerErrorType, null);
});

test('HTTP 200 with provider error is red and cannot leak its key', async t => {
    const transport = new FetchStreamTransport(async () => new Response('data: {"error":{"message":"bad test-secret-123"}}\n\n', { status: 200 }));
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test-model', apiKey: 'test-secret-123', log }, transport,
        new AbortController().signal);
    t.is(result.status, 'error');
    if (result.status !== 'error') return t.fail('Expected provider failure');
    t.is(result.kind, 'provider'); t.is(result.httpStatus, 200); t.is(result.chunks, 1);
    t.is(result.providerErrorType, null);
    t.false(JSON.stringify(result).includes('test-secret'));
});

test('aborted probe sends no request and still returns a diagnostic result', async t => {
    let requests = 0;
    const transport = new FetchStreamTransport(async () => { requests++; return new Response('unused'); });
    const controller = new AbortController(); controller.abort();
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test-model', log }, transport, controller.signal);
    t.is(result.status, 'error'); t.is(requests, 0);
    if (result.status !== 'error') return t.fail('Expected abort');
    t.is(result.kind, 'aborted'); t.is(result.httpStatus, null); t.is(result.chunks, 0);
});

for (const [name, body, expected] of [
    ['HTML login page', '<html>Login required</html>', 'error'],
    ['SSE keepalive only', ': keepalive\n\n', 'error'],
    ['unrecognized JSON frame', 'data: {"login":"required"}\n\n', 'error'],
    ['model content without sentinel', 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', 'ok'],
    ['valid completion only', 'data: [DONE]\n\n', 'ok'],
] as const) {
    test(`HTTP 200 ${name}: success requires a decoded model response`, async t => {
        const transport = new FetchStreamTransport(async () => new Response(body, { status: 200 }));
        const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test', log }, transport,
            new AbortController().signal);
        t.is(result.status, expected);
        if (result.status === 'skipped') return t.fail('Unexpected skip');
        t.is(result.httpStatus, 200); t.is(result.chunks, 1);
        if (result.status === 'error') t.is(result.kind, 'invalid_stream');
    });
}

test('NDJSON completion buffered until EOF is recognized by the provider decoder', async t => {
    const transport = new FetchStreamTransport(async () => new Response('{"done":true}', { status: 200 }));
    const result = await probeConnection(CHAT_PROVIDERS.ollama, { modelId: 'llama3', log }, transport,
        new AbortController().signal);
    t.is(result.status, 'ok');
    if (result.status !== 'ok') return t.fail('Expected completion');
    t.is(result.httpStatus, 200); t.is(result.chunks, 1);
});

for (const [type, expected] of [
    ['authentication_error', 'authentication_error'], ['invalid_api_key', 'invalid_api_key'],
    ['not_found_error', 'not_found_error'], ['rate_limit_error', 'rate_limit_error'],
    ['private type kuba@example.com', null], ['a'.repeat(200), null], ['valid\n', null],
] as const) {
    for (const httpStatus of [401, 200]) test(`provider type ${JSON.stringify(type.slice(0, 24))} in HTTP ${httpStatus}`, async t => {
        const payload = JSON.stringify({ type: 'error', error: { type, message: 'invalid x-api-key sk-ant-secret for kuba@example.com' } });
        const transport = new FetchStreamTransport(async () => new Response(httpStatus === 200 ? `event: error\ndata: ${payload}\n\n` : payload, { status: httpStatus }));
        const result = await probeConnection(CHAT_PROVIDERS.anthropic, { modelId: 'claude-sonnet-5-5', log }, transport, new AbortController().signal);
        if (result.status !== 'error') return t.fail('Expected a structured error');
        t.is(result.httpStatus, httpStatus); t.is(result.chunks, 1);
        t.is(result.kind, httpStatus === 200 ? 'provider' : 'http');
        t.is(result.providerErrorType, expected);
        for (const secret of ['x-api-key', 'sk-ant', 'kuba', 'example.com']) t.false(JSON.stringify(result).includes(secret));
    });
}

test('transport failure reports no exception text or URL', async t => {
    const transport = new FetchStreamTransport(async () => { throw new Error('kuba@example.com https://private.test?token=secret'); });
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test', log }, transport, new AbortController().signal);
    if (result.status !== 'error') return t.fail('Expected transport failure');
    t.is(result.kind, 'transport'); t.is(result.httpStatus, null); t.is(result.chunks, 0);
    t.is(result.providerErrorType, null);
    t.false(JSON.stringify(result).includes('private'));
});

test('timeout comes from production transport outcome, never from exception message', async t => {
    const transport = new FetchStreamTransport(async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
    }));
    let timeoutMs: number | undefined;
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test', log }, {
        open: (spec, sink, signal) => {
            timeoutMs = spec.timeoutMs;
            // Exercise the same timer path with a short test deadline.
            return transport.open({ ...spec, timeoutMs: 5 }, sink, signal);
        },
    }, new AbortController().signal);
    t.is(timeoutMs, 30000);
    if (result.status !== 'error') return t.fail('Expected timeout');
    t.is(result.kind, 'timeout'); t.is(result.httpStatus, null); t.is(result.chunks, 0);
    t.false(JSON.stringify(result).includes('private'));
});

test('provider logs are reduced to a fixed diagnostic event before reaching the logger', async t => {
    const messages: unknown[][] = [];
    const capture = (...args: unknown[]) => { messages.push(args); };
    const provider = {
        ...CHAT_PROVIDERS.openai,
        buildRequest: (...args: Parameters<typeof CHAT_PROVIDERS.openai.buildRequest>) => CHAT_PROVIDERS.openai.buildRequest(...args),
        createStreamDecoder: (request: Parameters<typeof CHAT_PROVIDERS.openai.createStreamDecoder>[0], context: Parameters<typeof CHAT_PROVIDERS.openai.createStreamDecoder>[1]) => {
            context.log.error('private scope', new Error('Cookie: session=abc; kuba@example.com'));
            return CHAT_PROVIDERS.openai.createStreamDecoder(request, context);
        },
    };
    const transport = new FetchStreamTransport(async () => new Response('data: [DONE]\n\n'));
    const result = await probeConnection(provider, { modelId: 'test', log: { debug: capture, info: capture, warn: capture, error: capture, model: capture } }, transport, new AbortController().signal);
    t.is(result.status, 'ok');
    t.deepEqual(messages, [['Diagnostics', 'Provider diagnostic event']]);
});
