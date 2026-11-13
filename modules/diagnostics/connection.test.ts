import test from 'ava';
import { FetchStreamTransport } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { CHAT_PROVIDERS } from '../models/index.js';
import { probeConnection } from './connection.js';
import { diagnosticRedactor } from './diagnostics.js';
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
        diagnosticRedactor({ apiKey: 'test-secret-123' }), new AbortController().signal);
    t.is(result.status, 'ok');
    t.regex(result.detail, /^HTTP: 200; chunks: 2; first chunk \(ms\): \d+; total \(ms\): \d+; error: None$/);
    t.is(requests.length, 1);
    const body = JSON.parse(String(requests[0].init?.body));
    t.deepEqual(body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
    t.is(body.stream, true); t.is(body.model, 'test-model');
    t.is(body.max_tokens, 16);
});

test('HTTP 429 is reported once with redacted error and no retry', async t => {
    let requests = 0;
    const transport = new FetchStreamTransport(async () => { requests++; return new Response('quota rejected test-secret-123', { status: 429 }); });
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test-model', apiKey: 'test-secret-123', log }, transport,
        diagnosticRedactor({ apiKey: 'test-secret-123' }), new AbortController().signal);
    t.is(result.status, 'error'); t.is(requests, 1);
    t.regex(result.detail, /^HTTP: 429; chunks: 1; first chunk \(ms\): \d+; total \(ms\): \d+; error: quota rejected \[REDACTED\]$/);
});

test('HTTP 200 with provider error is red and cannot leak its key', async t => {
    const transport = new FetchStreamTransport(async () => new Response('data: {"error":{"message":"bad test-secret-123"}}\n\n', { status: 200 }));
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test-model', apiKey: 'test-secret-123', log }, transport,
        diagnosticRedactor({ apiKey: 'test-secret-123' }), new AbortController().signal);
    t.is(result.status, 'error');
    t.regex(result.detail, /HTTP: 200; chunks: 1;/);
    t.regex(result.detail, /error: bad \[REDACTED\]/);
});

test('aborted probe sends no request and still returns a diagnostic result', async t => {
    let requests = 0;
    const transport = new FetchStreamTransport(async () => { requests++; return new Response('unused'); });
    const controller = new AbortController(); controller.abort();
    const result = await probeConnection(CHAT_PROVIDERS.openai, { modelId: 'test-model', log }, transport, text => text, controller.signal);
    t.is(result.status, 'error'); t.is(requests, 0);
    t.regex(result.detail, /HTTP: Unavailable; chunks: 0;/);
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
            diagnosticRedactor({}), new AbortController().signal);
        t.is(result.status, expected);
        t.regex(result.detail, /^HTTP: 200; chunks: 1; first chunk \(ms\): \d+; total \(ms\): \d+; error:/);
        t.true(result.detail.endsWith(expected === 'ok' ? 'error: None' : 'error: The response is not a model stream'));
    });
}

test('NDJSON completion buffered until EOF is recognized by the provider decoder', async t => {
    const transport = new FetchStreamTransport(async () => new Response('{"done":true}', { status: 200 }));
    const result = await probeConnection(CHAT_PROVIDERS.ollama, { modelId: 'llama3', log }, transport,
        diagnosticRedactor({}), new AbortController().signal);
    t.is(result.status, 'ok');
    t.regex(result.detail, /^HTTP: 200; chunks: 1; first chunk \(ms\): \d+; total \(ms\): \d+; error: None$/);
});
