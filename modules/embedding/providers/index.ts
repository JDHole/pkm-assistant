/**
 * modules/embedding/providers/index.ts — instancje dostawców + mapa rejestru (§5 kontraktu).
 * Zwykła rejestracja, bez stuba — `info` na każdej instancji jest już PRAWDZIWE (nie rzuca),
 * bo na nim stoją testy dropdownu (C-21) i placeholdera (D-16 w planie klastra).
 */
import { OpenAiEmbeddingProvider } from './openai.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { LmStudioEmbeddingProvider } from './lm_studio.js';
import { GeminiEmbeddingProvider } from './gemini.js';
import type { EmbeddingProvider, EmbeddingProviderId } from '../contracts.js';

export const openAiEmbeddingProvider = new OpenAiEmbeddingProvider();
export const ollamaEmbeddingProvider = new OllamaEmbeddingProvider();
export const lmStudioEmbeddingProvider = new LmStudioEmbeddingProvider();
export const geminiEmbeddingProvider = new GeminiEmbeddingProvider();

export const EMBEDDING_PROVIDERS: Record<EmbeddingProviderId, EmbeddingProvider> = {
    openai: openAiEmbeddingProvider,
    ollama: ollamaEmbeddingProvider,
    lm_studio: lmStudioEmbeddingProvider,
    gemini: geminiEmbeddingProvider,
};

export { OpenAiEmbeddingProvider, OllamaEmbeddingProvider, LmStudioEmbeddingProvider, GeminiEmbeddingProvider };
