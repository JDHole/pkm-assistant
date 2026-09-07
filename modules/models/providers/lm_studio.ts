/**
 * `modules/models/providers/lm_studio.ts` — dostawca `lm_studio`.
 *
 * Platforma LOKALNA: serwer stoi na maszynie użytkownika, więc adres bierze się z hosta
 * z ustawień, a klucza API nie ma i być nie musi. Adres domyślny to `http://localhost:1234`
 * — sam host, bez ścieżki, bo ten sam host obsługuje czat i listę modeli.
 *
 * Filtr znaczników `<think>` jest WPIĘTY: modele lokalne (i proxy, które ten serwer udają)
 * wypuszczają rozumowanie wprost w treści.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { ChatProviderInfo } from '../contracts.js';

/** Adres domyślny — sam host, ścieżki dokłada baza. */
const DEFAULT_HOST = 'http://localhost:1234';

/** Metryczka platformy — fakty kontraktowe. */
const LM_STUDIO_INFO: ChatProviderInfo = {
    id: 'lm_studio',
    label: 'LM Studio',
    local: true,
    needsApiKey: false,
    defaultModel: 'default',
    defaultEndpoint: DEFAULT_HOST,
    modelsEndpoint: `${DEFAULT_HOST}/v1/models`,
    apiKeyHeader: 'Authorization',
    streaming: true,
    streamMode: 'sse',
    supportsTools: true,
    supportsVision: 'per-model',
    supportsReasoning: true,
    streamUsage: false,
};

export class LmStudioProvider extends OpenAiCompatibleProvider {
    override get info(): ChatProviderInfo {
        return LM_STUDIO_INFO;
    }

    protected override get chatPath(): string {
        return '/v1/chat/completions';
    }

    protected override get modelsPath(): string {
        return '/v1/models';
    }

    protected override get parsesThinkTags(): boolean {
        return true;
    }

    /** Ten sam serwer wystawia obok modeli czatu także modele wektoryzujące. */
    protected override acceptsModel(entry: Record<string, unknown>): boolean {
        return entry.type !== 'embeddings';
    }
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const lmStudioProvider = new LmStudioProvider();
