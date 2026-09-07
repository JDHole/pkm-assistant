/**
 * `modules/models/providers/openai.ts` — dostawca `openai`.
 *
 * Kształt czatu OpenAI 1:1, klucz w nagłówku `Authorization: Bearer`, prośba o rozliczenie
 * tokenów w streamie (`stream_options`) i klucz cache promptu budowany z nazwy agenta.
 *
 * Filtra znaczników `<think>` tu NIE MA i mieć nie ma: modele hostowane przez OpenAI nie
 * wypuszczają rozumowania w treści, więc jedyne, co filtr mógłby tu zrobić, to zjeść
 * zdanie, w którym model pisze o takim znaczniku.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { ChatProviderInfo, ChatRequest, ProviderContext } from '../contracts.js';

/** Rodzaje modeli spoza czatu, które lista `/v1/models` zwraca razem z resztą. */
const NON_CHAT_MODEL_PREFIXES = [
    'whisper',
    'tts',
    'dall-e',
    'text-embedding',
    'omni-moderation',
    'text-moderation',
    'babbage',
    'davinci',
];

/** Metryczka platformy — fakty kontraktowe. */
const OPENAI_INFO: ChatProviderInfo = {
    id: 'openai',
    label: 'OpenAI',
    local: false,
    needsApiKey: true,
    defaultModel: 'gpt-4o',
    defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    apiKeyHeader: 'Authorization',
    streaming: true,
    streamMode: 'sse',
    supportsTools: true,
    supportsVision: 'per-model',
    supportsReasoning: false,
    streamUsage: true,
};

export class OpenAiProvider extends OpenAiCompatibleProvider {
    override get info(): ChatProviderInfo {
        return OPENAI_INFO;
    }

    /**
     * Klucz cache promptu. Nazwa agenta jest METADANĄ wołacza — dostawca ją tu zużywa
     * i zamienia na pole API, więc nigdy nie wychodzi w ciele pod własną nazwą.
     */
    protected override decorateBody(
        body: Record<string, unknown>,
        req: ChatRequest,
        _ctx: ProviderContext,
        _stream: boolean,
    ): void {
        const cacheKey = promptCacheKey(req.agentName);
        if (cacheKey) body.prompt_cache_key = cacheKey;
    }

    protected override acceptsModel(entry: Record<string, unknown>): boolean {
        const id = String(entry.id ?? '').toLowerCase();
        return !NON_CHAT_MODEL_PREFIXES.some(prefix => id.startsWith(prefix));
    }
}

/** `'Klara Test'` → `'pkm-agent-Klara-Test'`. Pusta nazwa = brak klucza cache. */
function promptCacheKey(agentName: string | undefined): string {
    const name = (agentName ?? '').trim();
    if (!name) return '';
    return `pkm-agent-${name.replace(/\s+/g, '-')}`;
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const openaiProvider = new OpenAiProvider();
