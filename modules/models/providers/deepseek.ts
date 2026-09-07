/**
 * `modules/models/providers/deepseek.ts` — dostawca `deepseek`.
 *
 * Kształt czatu OpenAI pod adresem `https://api.deepseek.com/chat/completions` (ścieżka BEZ
 * `/v1`). Rozumowanie przychodzi WŁASNYM polem (`reasoning_content`), więc filtra znaczników
 * `<think>` tu nie ma — obsługuje je baza, gdy dostawca przyśle pole natywne.
 *
 * Koniec strumienia rozpoznaje sentinel platformy dopasowywany DOKŁADNIE. Model, który
 * napisze „[DONE]" w zdaniu albo proxy, które domiesza pole `done` obok `choices`, NIE
 * kończą tury — reszta odpowiedzi ma dojść w całości.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { ChatProviderInfo } from '../contracts.js';

/** Metryczka platformy — fakty kontraktowe. */
const DEEPSEEK_INFO: ChatProviderInfo = {
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
};

export class DeepseekProvider extends OpenAiCompatibleProvider {
    override get info(): ChatProviderInfo {
        return DEEPSEEK_INFO;
    }
}

/** Jedyna instancja — dostawcy są BEZSTANOWI (stan tury żyje w dekoderze i w `ChatModel`). */
export const deepseekProvider = new DeepseekProvider();
