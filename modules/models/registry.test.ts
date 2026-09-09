import test from 'ava';
import { CHAT_PROVIDERS, PROVIDER_INFO, resolveProvider } from './registry.js';
import type { ChatProvider, ChatProviderInfo, ChatProviderRegistry, ProviderId } from './contracts.js';

/**
 * `azure`/`custom` skreślone z rejestru, `google` skreślony jako osobny klucz dispatchu
 * (gemini dispatchuje dziś sam). Stara wartość `pkmAssistant.chat.platform` w `settings.json`
 * usera może wciąż nieść jedną z tych trzech nazw - plugin nie migruje ustawień wstecz
 * (świadoma decyzja). `resolveProvider` ma fail-safe spaść na PIERWSZY
 * wpis rejestru zamiast rzucić albo zwrócić `undefined`.
 */
function mockProvider(id: string): ChatProvider {
    return { info: { id } as ChatProviderInfo } as ChatProvider;
}

for (const staleKey of ['azure', 'custom', 'google']) {
    test(`resolveProvider: stara platforma "${staleKey}" spada na pierwszy wpis rejestru zamiast rzucić`, t => {
        const registry = { mock: mockProvider('mock') } as unknown as ChatProviderRegistry;

        t.notThrows(() => {
            const provider = resolveProvider(registry, staleKey);
            t.is(provider.info.id as string, 'mock', 'nieznana platforma ma spaść na pierwszy klucz rejestru');
        });
    });
}

/**
 * Metryczki dostawców są FAKTAMI KONTRAKTOWYMI - endpointy, nagłówki kluczy,
 * tryb strumienia i flaga `stream_options`. Te wartości pinują testy adapterów
 * i harness.
 */
test('PROVIDER_INFO pinuje endpointy, nagłówki i tryb strumienia dziewięciu dostawców', t => {
    t.is(PROVIDER_INFO.deepseek.defaultEndpoint, 'https://api.deepseek.com/chat/completions');
    t.true(PROVIDER_INFO.lm_studio.defaultEndpoint.includes('localhost:1234'));
    t.true(PROVIDER_INFO.ollama.defaultEndpoint.includes('localhost:11434'));

    t.is(PROVIDER_INFO.anthropic.apiKeyHeader, 'x-api-key');
    t.is(PROVIDER_INFO.gemini.apiKeyHeader, 'x-goog-api-key');
    for (const id of ['openai', 'deepseek', 'groq', 'lm_studio', 'open_router', 'xai'] as ProviderId[]) {
        t.not(PROVIDER_INFO[id].apiKeyHeader, 'x-api-key', `${id} nie używa nagłówka Anthropica`);
    }

    t.is(PROVIDER_INFO.xai.streamMode, 'complete', 'xAI nie ma użytecznego streamu w Obsidianie (CORS)');
    t.is(PROVIDER_INFO.ollama.streamMode, 'ndjson');
    t.is(PROVIDER_INFO.openai.streamMode, 'sse');

    t.true(PROVIDER_INFO.openai.streamUsage, 'openai prosi o usage w streamie');
    t.true(PROVIDER_INFO.deepseek.streamUsage, 'deepseek prosi o usage w streamie');
    for (const id of ['groq', 'lm_studio', 'open_router', 'anthropic', 'gemini', 'ollama', 'xai'] as ProviderId[]) {
        t.false(PROVIDER_INFO[id].streamUsage, `${id}: stream_options kończy się 400`);
    }

    t.is(PROVIDER_INFO.xai.defaultModel, 'grok-3-mini-beta');
    t.true(PROVIDER_INFO.ollama.local, 'ollama jest platformą lokalną');
    t.true(PROVIDER_INFO.lm_studio.local, 'lm_studio jest platformą lokalną');
    t.false(PROVIDER_INFO.lm_studio.needsApiKey, 'platforma lokalna nie wymaga klucza');
    t.true(PROVIDER_INFO.openai.needsApiKey);
});

/** Zabezpieczenie przed powrotem martwych platform. */
test('CHAT_PROVIDERS ma dokładnie dziewięć kluczy i żadnego google/azure/custom', t => {
    const keys = Object.keys(CHAT_PROVIDERS).sort();
    t.deepEqual(keys, [
        'anthropic', 'deepseek', 'gemini', 'groq', 'lm_studio',
        'ollama', 'open_router', 'openai', 'xai',
    ]);
    for (const dead of ['google', 'azure', 'custom']) {
        t.false(dead in CHAT_PROVIDERS, `martwa platforma "${dead}" nie może wrócić do rejestru`);
    }
    for (const [id, provider] of Object.entries(CHAT_PROVIDERS)) {
        t.is(provider.info.id, id as ProviderId, `wpis "${id}" musi nieść własne id w metryczce`);
    }
});
