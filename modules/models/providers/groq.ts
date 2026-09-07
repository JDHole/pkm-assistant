/**
 * `modules/models/providers/groq.ts` — dostawca `groq`.
 *
 * Kształt czatu OpenAI pod `https://api.groq.com/openai/v1`. Dwie różnice wobec OpenAI:
 *
 *  • prośba o rozliczenie tokenów w streamie jest WYŁĄCZONA — serwer waliduje nieznane
 *    pola żądania i odbija je błędem 400;
 *  • filtr znaczników `<think>` jest WPIĘTY, bo Groq hostuje modele rodziny rozumującej,
 *    które wypuszczają rozumowanie wprost w treści.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { ChatProviderInfo } from '../contracts.js';

/** Metryczka platformy — fakty kontraktowe. */
const GROQ_INFO: ChatProviderInfo = {
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
};

export class GroqProvider extends OpenAiCompatibleProvider {
    override get info(): ChatProviderInfo {
        return GROQ_INFO;
    }

    protected override get parsesThinkTags(): boolean {
        return true;
    }
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const groqProvider = new GroqProvider();
