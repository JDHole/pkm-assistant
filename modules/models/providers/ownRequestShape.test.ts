import test from 'ava';
import { anthropicProvider } from './anthropic.js';
import { ollamaProvider } from './ollama.js';
import { makeCtx } from '../testing/harness.js';

/**
 * `stream_options` to pole kształtu OpenAI. Platformy o WŁASNYM kształcie żądania
 * (Anthropic — Messages API, Ollama — `/api/chat` NDJSON) nie mogą go dostać w ogóle:
 * serwer walidujący nieznane pola odbija 400. (B.6 BA-04/BA-05/BA-06)
 */
const MESSAGES = [{ role: 'user', content: 'cześć' }];

test('platformy o WŁASNYM kształcie żądania (Anthropic, Ollama) nie dostają pola OpenAI', t => {
    const anthropicBody = anthropicProvider.buildRequest(
        { messages: MESSAGES },
        makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: 'sk-ant-test' }),
        true,
    ).body ?? '';
    t.false(anthropicBody.includes('stream_options'));
    t.false(anthropicProvider.info.streamUsage);

    const ollamaBody = ollamaProvider.buildRequest(
        { messages: MESSAGES },
        makeCtx({ modelId: 'llama3.2' }),
        true,
    ).body ?? '';
    t.false(ollamaBody.includes('stream_options'));
    t.false(ollamaProvider.info.streamUsage);
});
