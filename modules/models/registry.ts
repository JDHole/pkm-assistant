/**
 * `modules/models/registry.ts` — metryczki dostawców i rejestr instancji.
 *
 * Dwie rzeczy i ani jednej więcej:
 *  • {@link PROVIDER_INFO} — FAKTY KONTRAKTOWE dziewięciu platform (adresy, nagłówek klucza,
 *    tryb strumienia, domyślny model, flagi zdolności). Wartości pochodzą z publicznej
 *    dokumentacji API dostawców — linki przy każdym wpisie;
 *  • {@link CHAT_PROVIDERS} + {@link resolveProvider} — jawny rejestr instancji i fail-safe
 *    na nazwę platformy, której już nie ma.
 *
 * Rejestr jest KOMPLETNY z konstrukcji (dziewięć wpisów). Harness podmienia wpisy,
 * nigdy ich nie usuwa — dlatego typ to `Record`, nie `Partial<Record<…>>`.
 */
import { anthropicProvider } from './providers/anthropic.js';
import { deepseekProvider } from './providers/deepseek.js';
import { geminiProvider } from './providers/gemini.js';
import { groqProvider } from './providers/groq.js';
import { lmStudioProvider } from './providers/lm_studio.js';
import { ollamaProvider } from './providers/ollama.js';
import { openRouterProvider } from './providers/open_router.js';
import { openaiProvider } from './providers/openai.js';
import { xaiProvider } from './providers/xai.js';
import type { ChatProvider, ChatProviderInfo, ChatProviderRegistry, ProviderId } from './contracts.js';

/**
 * Metryczki dziewięciu dostawców.
 *
 * `defaultEndpoint` ma DWA znaczenia, zależnie od tego, czy adres jest stały:
 *  • platformy chmurowe — PEŁNY adres wywołania czatu (dostawca strzela w niego wprost);
 *  • platformy lokalne (`ollama`, `lm_studio`) — sam ADRES BAZOWY, bo user i tak podaje
 *    własny host w ustawieniach, a ścieżkę dokleja dostawca.
 *
 * `streamUsage` jest OPT-IN: `stream_options` rozumieją tylko OpenAI i DeepSeek, reszta
 * serwerów kształtu OpenAI odbija nieznane pole statusem 400.
 *
 * Źródła (publiczna dokumentacja API; adresy i nagłówki sprawdzone 2026-09-06):
 *  • OpenAI — platform.openai.com/docs/api-reference/chat, /models
 *    (dokumentacja odbija roboty statusem 403 — kształt `/v1/chat/completions`,
 *    `/v1/models` i `Authorization: Bearer` potwierdzają opisy zgodności u Groqa
 *    i LM Studio, a w repo pinuje go `providers/openai.test.ts`)
 *  • Anthropic — platform.claude.com/docs/en/api/models-list (stary adres
 *    docs.anthropic.com przekierowuje 301): `GET https://api.anthropic.com/v1/models`,
 *    klucz w nagłówku `x-api-key`
 *  • Google Gemini — ai.google.dev/api/models: baza `generativelanguage.googleapis.com/v1beta`.
 *    Dokumentacja pokazuje klucz jako parametr `?key=`, my WYBIERAMY nagłówek
 *    `x-goog-api-key` — sekret nie ma prawa wylądować w adresie (loguje się i cache'uje)
 *  • Ollama — github.com/ollama/ollama/blob/main/docs/api.md: `http://localhost:11434`,
 *    czat `POST /api/chat`, katalog `GET /api/tags`, strumień = NDJSON z `done`/`done_reason`
 *  • DeepSeek — api-docs.deepseek.com/api/create-chat-completion:
 *    `https://api.deepseek.com/chat/completions`, `stream_options.include_usage` wspierane
 *  • Groq — console.groq.com/docs/openai: baza `https://api.groq.com/openai/v1`
 *  • OpenRouter — openrouter.ai/docs/api-reference/chat-completion:
 *    `https://openrouter.ai/api/v1/chat/completions`, klucz w `Authorization: Bearer`
 *  • LM Studio — lmstudio.ai/docs/app/api/endpoints/openai: `http://localhost:1234/v1`
 *    z `/v1/models` i `/v1/chat/completions`, bez wymogu klucza
 *  • xAI — docs.x.ai/docs/api-reference: baza `https://api.x.ai/v1`,
 *    `Authorization: Bearer`
 */
export const PROVIDER_INFO: Readonly<Record<ProviderId, ChatProviderInfo>> = {
    openai: {
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
        supportsReasoning: true,
        streamUsage: true,
    },
    anthropic: {
        id: 'anthropic',
        label: 'Anthropic',
        local: false,
        needsApiKey: true,
        defaultModel: 'claude-sonnet-4-20250514',
        defaultEndpoint: 'https://api.anthropic.com/v1/messages',
        modelsEndpoint: 'https://api.anthropic.com/v1/models',
        apiKeyHeader: 'x-api-key',
        streaming: true,
        streamMode: 'sse',
        supportsTools: true,
        supportsVision: 'per-model',
        supportsReasoning: true,
        streamUsage: false,
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        local: false,
        needsApiKey: true,
        defaultModel: 'gemini-1.5-pro',
        // Adres BAZOWY: nazwa modelu i akcja (`:generateContent` / `:streamGenerateContent`)
        // są częścią ścieżki, więc pełny URL składa dostawca.
        defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta',
        modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
        apiKeyHeader: 'x-goog-api-key',
        streaming: true,
        streamMode: 'sse',
        supportsTools: true,
        supportsVision: 'per-model',
        supportsReasoning: true,
        streamUsage: false,
    },
    ollama: {
        id: 'ollama',
        label: 'Ollama',
        local: true,
        needsApiKey: false,
        defaultModel: 'llama3',
        defaultEndpoint: 'http://localhost:11434',
        modelsEndpoint: 'http://localhost:11434/api/tags',
        streaming: true,
        streamMode: 'ndjson',
        supportsTools: true,
        supportsVision: 'per-model',
        supportsReasoning: true,
        streamUsage: false,
    },
    deepseek: {
        id: 'deepseek',
        label: 'DeepSeek',
        local: false,
        needsApiKey: true,
        defaultModel: 'deepseek-chat',
        defaultEndpoint: 'https://api.deepseek.com/chat/completions',
        modelsEndpoint: 'https://api.deepseek.com/models',
        apiKeyHeader: 'Authorization',
        streaming: true,
        streamMode: 'sse',
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
        streamUsage: true,
    },
    groq: {
        id: 'groq',
        label: 'Groq',
        local: false,
        needsApiKey: true,
        defaultModel: 'llama-3.3-70b-versatile',
        defaultEndpoint: 'https://api.groq.com/openai/v1/chat/completions',
        modelsEndpoint: 'https://api.groq.com/openai/v1/models',
        apiKeyHeader: 'Authorization',
        streaming: true,
        streamMode: 'sse',
        supportsTools: true,
        supportsVision: 'per-model',
        supportsReasoning: true,
        streamUsage: false,
    },
    lm_studio: {
        id: 'lm_studio',
        label: 'LM Studio',
        local: true,
        needsApiKey: false,
        defaultModel: 'default',
        defaultEndpoint: 'http://localhost:1234',
        modelsEndpoint: 'http://localhost:1234/v1/models',
        apiKeyHeader: 'Authorization',
        streaming: true,
        streamMode: 'sse',
        supportsTools: true,
        supportsVision: 'per-model',
        supportsReasoning: true,
        streamUsage: false,
    },
    open_router: {
        id: 'open_router',
        label: 'OpenRouter',
        local: false,
        needsApiKey: true,
        defaultModel: 'anthropic/claude-sonnet-4-20250514',
        defaultEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
        modelsEndpoint: 'https://openrouter.ai/api/v1/models',
        apiKeyHeader: 'Authorization',
        streaming: true,
        streamMode: 'sse',
        supportsTools: true,
        supportsVision: 'per-model',
        supportsReasoning: true,
        streamUsage: false,
    },
    xai: {
        id: 'xai',
        label: 'xAI',
        local: false,
        needsApiKey: true,
        defaultModel: 'grok-3-mini-beta',
        defaultEndpoint: 'https://api.x.ai/v1/chat/completions',
        modelsEndpoint: 'https://api.x.ai/v1/models',
        apiKeyHeader: 'Authorization',
        // API xAI streamuje, ale `app://obsidian.md` nie dostaje od niego nagłówków CORS,
        // więc w pluginie strumień jest EMULOWANY jednym wywołaniem bez strumienia.
        streaming: true,
        streamMode: 'complete',
        supportsTools: true,
        supportsVision: 'per-model',
        supportsReasoning: true,
        streamUsage: false,
    },
};

/**
 * Komplet dostawców czatu — jawna rejestracja, którą `config/runtimeConfig.ts` wkłada
 * do `RuntimeConfig.chat.providers`. Harness PODMIENIA wpisy, nigdy ich nie usuwa.
 *
 * Dziewięć wpisów, ani jednego więcej: `google`/`azure`/`custom` nie wracają (wycięte
 * 2026-09-03, AUD-dead-code-026/110/112/168).
 */
export const CHAT_PROVIDERS: ChatProviderRegistry = {
    openai: openaiProvider,
    anthropic: anthropicProvider,
    gemini: geminiProvider,
    ollama: ollamaProvider,
    deepseek: deepseekProvider,
    groq: groqProvider,
    lm_studio: lmStudioProvider,
    open_router: openRouterProvider,
    xai: xaiProvider,
};

/**
 * Fail-safe wyboru dostawcy (B.3 SM-02).
 *
 * Nieznana nazwa platformy — `azure`, `custom`, `google` z cudzego, starego `settings.json` —
 * NIE rzuca i NIE oddaje `undefined`: zwracany jest PIERWSZY wpis rejestru. Nikt nie migruje
 * ustawień wstecz, a plugin, który wywala się na starym pliku, jest gorszy niż plugin,
 * który gada z domyślną platformą.
 *
 * @param registry Rejestr dostawców (produkcyjny {@link CHAT_PROVIDERS} albo podmieniony w harnessie).
 * @param id Nazwa platformy z ustawień — dowolny tekst z dysku, nie tylko {@link ProviderId}.
 */
export function resolveProvider(registry: ChatProviderRegistry, id: string): ChatProvider {
    const bag = registry as unknown as Record<string, ChatProvider | undefined>;
    const exact = bag[id];
    if (exact) return exact;

    const [firstKey] = Object.keys(bag);
    const fallback = firstKey === undefined ? undefined : bag[firstKey];
    if (!fallback) {
        throw new Error('Rejestr dostawców czatu jest pusty — nie ma na co spaść z nieznanej platformy.');
    }
    return fallback;
}
