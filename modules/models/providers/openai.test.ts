import test from 'ava';
import { openaiProvider } from './openai.js';
import { PROVIDER_INFO } from '../registry.js';
import { MODEL_MAX_TOKENS_DEFAULTS } from '../cache_utils.js';
import { CapturingHttpClient, makeCtx, makeModel } from '../testing/harness.js';
import type { ChatRequest } from '../contracts.js';

/**
 * `stream_options: { include_usage: true }` + `prompt_cache_key` per agent.
 *
 * Bez `stream_options` API OpenAI-kształtne NIE zwraca zużycia tokenów w streamingu, więc
 * pętla agenta spada na estymatę i zaniża koszt wielokrotnie. Flaga jest OPT-IN
 * per dostawca (`ChatProviderInfo.streamUsage`).
 */
type ParsedBody = {
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    max_tokens?: number;
    prompt_cache_key?: string;
    temperature?: number;
    tools?: Array<{ type?: string; function?: { name?: string } }>;
    tool_choice?: unknown;
};

const MESSAGES = [{ role: 'user', content: 'cześć' }];

function body(req: ChatRequest, stream: boolean): ParsedBody {
    const spec = openaiProvider.buildRequest(req, makeCtx({ modelId: 'gpt-4o' }), stream);
    return JSON.parse(spec.body ?? '{}') as ParsedBody;
}

test('OpenAI: żądanie streamingowe prosi o usage', t => {
    t.deepEqual(body({ messages: MESSAGES }, true).stream_options, { include_usage: true });
});

/**
 * Metryczka dostawcy to fakt kontraktowy - endpoint, nagłówek klucza,
 * mapowanie narzędzi i temperatura muszą trafić do żądania.
 */
test('openai — endpoint, nagłówek Bearer, tools/tool_choice, temperature w body', t => {
    const req: ChatRequest = {
        messages: MESSAGES,
        temperature: 0.3,
        tools: [{ type: 'function', function: { name: 'vault_read', description: 'Read', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
    };
    const spec = openaiProvider.buildRequest(req, makeCtx({ modelId: 'gpt-4o', apiKey: 'sk-test' }), false);

    t.is(spec.url, PROVIDER_INFO.openai.defaultEndpoint, 'endpoint z metryczki dostawcy');
    t.is(spec.method, 'POST');
    t.is(spec.headers['Authorization'], 'Bearer sk-test');

    const parsed = JSON.parse(spec.body ?? '{}') as ParsedBody;
    t.is(parsed.temperature, 0.3);
    t.is(parsed.tools?.[0]?.function?.name, 'vault_read');
    t.is(parsed.tool_choice, 'auto');
});

/**
 * Klucz cache promptu jest metadaną (`ChatRequest.agentName`), nie polem API - dostawca ma go
 * ZUŻYĆ i zamienić na `prompt_cache_key`, nigdy przepuścić dalej.
 */
test('OpenAI request includes prompt_cache_key per agent', async t => {
    const http = new CapturingHttpClient({ body: { choices: [], usage: {} } });
    const model = makeModel(openaiProvider, {
        http,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: 'sk-test' }),
    });

    await model.complete({ agentName: 'Klara Test', messages: MESSAGES });

    const captured = JSON.parse(http.lastSpec?.body ?? '{}') as ParsedBody;
    t.is(captured.prompt_cache_key, 'pkm-agent-Klara-Test');
    t.is(captured.max_tokens, MODEL_MAX_TOKENS_DEFAULTS.openai);
    t.false(JSON.stringify(captured).includes('agentName'), 'agentName to metadana, nie pole API');
});

/** Pusta nazwa agenta = brak klucza cache (funkcja `promptCacheKey` przez publiczne API). */
test('OpenAI request bez agentName nie ma prompt_cache_key', async t => {
    const http = new CapturingHttpClient({ body: { choices: [], usage: {} } });
    const model = makeModel(openaiProvider, {
        http,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: 'sk-test' }),
    });

    await model.complete({ messages: MESSAGES });

    const captured = JSON.parse(http.lastSpec?.body ?? '{}') as ParsedBody;
    t.false('prompt_cache_key' in captured, 'brak nazwy agenta = brak klucza cache');
});

/**
 * `acceptsModel` filtruje listę `/v1/models` (L64/L65/L71) - dostawca ma odrzucić
 * modele spoza czatu (whisper/tts/dall-e/…) niezależnie od wielkości liter w id, a przyjąć
 * resztę. Zabija mutanta L65 (`return undefined` = wszystko odrzucone, `listModels` pusty).
 */
test('OpenAI: listModels filtruje modele spoza czatu (case-insensitive)', async t => {
    const http = new CapturingHttpClient({
        body: {
            data: [
                { id: 'gpt-4o' },
                { id: 'whisper-1' },
                { id: 'DALL-E-3' },
                { id: 'text-embedding-3-small' },
                { id: 'gpt-4o-mini' },
                { id: 'omni-moderation-latest' },
            ],
        },
    });

    const models = await openaiProvider.listModels(makeCtx({ apiKey: 'sk-test' }), http);

    t.deepEqual(models.map(m => m.id), ['gpt-4o', 'gpt-4o-mini'], 'tylko modele czatu zostają');
});
