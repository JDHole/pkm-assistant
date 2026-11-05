import test from 'ava';
import { openaiProvider } from './openai.js';
import { lmStudioProvider } from './lm_studio.js';
import { groqProvider } from './groq.js';
import { deepseekProvider } from './deepseek.js';
import { xaiProvider } from './xai.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { ollamaProvider } from './ollama.js';
import { openRouterProvider } from './open_router.js';
import { makeCtx } from '../testing/harness.js';
import type { ChatProvider, ChatRequest } from '../contracts.js';

function body(provider: ChatProvider, model: string, effort?: ChatRequest['effort']) {
    return JSON.parse(provider.buildRequest({ messages: [{ role: 'user', content: 'x' }], max_tokens: 16384, ...(effort ? { effort } : {}) }, makeCtx({ modelId: model }), false).body || '{}') as Record<string, unknown>;
}

test('effort is translated into provider request fields', t => {
    t.is(body(openaiProvider, 'gpt-5', 'high').reasoning_effort, 'high');
    t.is(body(openaiProvider, 'gpt-4o', 'high').reasoning_effort, undefined);
    t.is(body(lmStudioProvider, 'gpt', 'high').reasoning_effort, 'high');
    t.is(body(anthropicProvider, 'claude-3-5-sonnet-20241022', 'high').thinking, undefined);
    t.deepEqual(body(anthropicProvider, 'claude-sonnet-4-20250514', 'high').thinking, { type: 'enabled', budget_tokens: 8192 });
    t.deepEqual(body(anthropicProvider, 'claude-opus-4-6', 'high').output_config, { effort: 'high' });
    t.deepEqual((body(geminiProvider, 'gemini-2.5-pro', 'high').generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 8192 });
    t.deepEqual(body(openRouterProvider, 'model', 'high').reasoning, { effort: 'high' });
    t.is(body(ollamaProvider, 'gpt-oss', 'high').think, 'high');
    t.is(body(deepseekProvider, 'deepseek-v4-pro', 'medium').reasoning_effort, 'medium');
    t.is(body(xaiProvider, 'grok-4.6', 'high').reasoning_effort, 'high');
    t.is(body(groqProvider, 'llama-3.3-70b-versatile', 'high').reasoning_effort, undefined);
    t.is(body(groqProvider, 'openai/gpt-oss-120b', 'high').reasoning_effort, 'high');
});

test('unset effort preserves the literal OpenAI body', t => {
    t.deepEqual(body(openaiProvider, 'gpt-4o'), { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384 });
});

test('LM Studio preserves complete bodies with and without effort', t => {
    t.deepEqual(body(lmStudioProvider, 'gpt'), { model: 'gpt', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384 });
    t.deepEqual(body(lmStudioProvider, 'gpt', 'high'), { model: 'gpt', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384, reasoning_effort: 'high' });
});

test('Groq preserves complete bodies with and without effort', t => {
    t.deepEqual(body(groqProvider, 'openai/gpt-oss-120b'), { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384 });
    t.deepEqual(body(groqProvider, 'openai/gpt-oss-120b', 'high'), { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384, reasoning_effort: 'high' });
    t.deepEqual(body(groqProvider, 'llama-3.3-70b-versatile', 'high'), { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384 });
});

test('DeepSeek preserves complete bodies with and without effort', t => {
    t.deepEqual(body(deepseekProvider, 'deepseek-v4-pro'), { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384 });
    t.deepEqual(body(deepseekProvider, 'deepseek-v4-pro', 'high'), { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384, reasoning_effort: 'high' });
});

test('xAI preserves complete bodies with and without effort', t => {
    t.deepEqual(body(xaiProvider, 'grok-4.6'), { model: 'grok-4.6', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384 });
    t.deepEqual(body(xaiProvider, 'grok-4.6', 'high'), { model: 'grok-4.6', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384, reasoning_effort: 'high' });
});

test('unset effort preserves complete provider bodies', t => {
    t.deepEqual(body(anthropicProvider, 'claude-sonnet-4'), { model: 'claude-sonnet-4', max_tokens: 16384, messages: [{ role: 'user', content: 'x' }] });
    t.deepEqual(body(geminiProvider, 'gemini-2.5-pro'), { contents: [{ role: 'user', parts: [{ text: 'x' }] }], generationConfig: { maxOutputTokens: 16384 } });
    t.deepEqual(body(ollamaProvider, 'qwen3'), { model: 'qwen3', messages: [{ role: 'user', content: 'x' }], stream: false, keep_alive: '60m', options: { num_predict: 16384 } });
    t.deepEqual(body(openRouterProvider, 'model'), { model: 'model', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384 });
    t.deepEqual(body(openRouterProvider, 'model', 'high'), { model: 'model', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384, reasoning: { effort: 'high' } });
    t.deepEqual(body(ollamaProvider, 'llama3', 'high'), { model: 'llama3', messages: [{ role: 'user', content: 'x' }], stream: false, keep_alive: '60m', options: { num_predict: 16384 } });
    t.is(body(openaiProvider, 'gpt-6.1', 'high').reasoning_effort, 'high');
    t.is(body(openaiProvider, 'gpt-10.1', 'high').reasoning_effort, 'high');
});

test('legacy thinking keeps its literal provider fields', t => {
    const request = { messages: [{ role: 'user' as const, content: 'x' }], max_tokens: 16384, thinking: 4096 };
    const build = (provider: ChatProvider, modelId: string) => JSON.parse(provider.buildRequest(request, makeCtx({ modelId }), false).body || '{}') as Record<string, unknown>;
    t.deepEqual(build(anthropicProvider, 'claude-sonnet-4'), { model: 'claude-sonnet-4', max_tokens: 16384, messages: [{ role: 'user', content: 'x' }], thinking: { type: 'enabled', budget_tokens: 4096 } });
    t.deepEqual(build(geminiProvider, 'gemini-2.5-pro'), { contents: [{ role: 'user', parts: [{ text: 'x' }] }], generationConfig: { maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 4096 } } });
    t.deepEqual(build(ollamaProvider, 'qwen3'), { model: 'qwen3', messages: [{ role: 'user', content: 'x' }], stream: false, keep_alive: '60m', options: { num_predict: 16384 }, think: true });
    t.deepEqual(build(openRouterProvider, 'model'), { model: 'model', messages: [{ role: 'user', content: 'x' }], stream: false, max_tokens: 16384, reasoning: { max_tokens: 4096 } });
});
