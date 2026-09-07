import test from 'ava';
import { groqProvider } from './groq.js';
import { PROVIDER_INFO } from '../registry.js';
import { makeCtx } from '../testing/harness.js';
import type { ChatRequest } from '../contracts.js';

/**
 * `stream_options: { include_usage: true }` jest OPT-IN per dostawca
 * (`ChatProviderInfo.streamUsage`) — wysłanie go do Groqa kończy się 400 (B.6 BA-05).
 */
type ParsedBody = {
    stream_options?: { include_usage?: boolean };
    tools?: Array<{ type?: string; function?: { name?: string } }>;
};

const MESSAGES = [{ role: 'user', content: 'cześć' }];
const CTX = makeCtx({ modelId: 'llama-3.3-70b-versatile', apiKey: 'gsk-test' });

test('platforma BEZ flagi nie dostaje stream_options (opt-in, nie globalny przełącznik)', t => {
    const body = JSON.parse(groqProvider.buildRequest({ messages: MESSAGES }, CTX, true).body ?? '{}') as ParsedBody;
    t.is(body.stream_options, undefined);
    t.false(groqProvider.info.streamUsage, 'metryczka Groqa ma trzymać flagę na false');
});

/**
 * N18 (luka L-07): endpoint i nagłówek z metryczki dostawcy + mapowanie narzędzi;
 * `finish_reason` z odpowiedzi przechodzi do kształtu kanonicznego.
 */
test('L-07: groq — endpoint + nagłówek + mapowanie tools; finish_reason przechodzi', t => {
    const req: ChatRequest = {
        messages: MESSAGES,
        tools: [{ type: 'function', function: { name: 'vault_read', description: 'Read', parameters: { type: 'object' } } }],
    };
    const spec = groqProvider.buildRequest(req, CTX, false);

    t.is(spec.url, PROVIDER_INFO.groq.defaultEndpoint);
    t.is(spec.headers['Authorization'], 'Bearer gsk-test');
    const body = JSON.parse(spec.body ?? '{}') as ParsedBody;
    t.is(body.tools?.[0]?.function?.name, 'vault_read');

    const parsed = groqProvider.parseCompletion(
        { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} },
        req,
        CTX,
    );
    t.is(parsed.choices[0].finish_reason, 'stop');
    t.is(parsed.choices[0].message.content, 'ok');
});
