import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { isVisionModel } from '../capabilities.js';
import type { ChatProvider, OpenAiRequestMessage } from '../contracts.js';
import { makeCtx } from '../testing/harness.js';
import { anthropicProvider } from './anthropic.js';
import { lmStudioProvider } from './lm_studio.js';
import { ollamaProvider } from './ollama.js';
import { openaiProvider } from './openai.js';
import { moveToolImagesToUser } from './toolImages.js';

const image = (data: string) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } });
const transcript = (): OpenAiRequestMessage[] => [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'generate_image', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'ok' }, image('QUJD')] },
];
const body = (provider: ChatProvider, model: string, messages: OpenAiRequestMessage[]) =>
  JSON.parse(provider.buildRequest({ model, messages }, makeCtx({ modelId: model }), false).body ?? '{}') as { messages: OpenAiRequestMessage[] };

test.afterEach(() => { setLocale('en'); });

test('LM Studio przenosi obraz wyniku za blok narzędzi', t => {
  setLocale('en');
  const messages = body(lmStudioProvider, 'gpt-5.6-terra', transcript()).messages;
  t.is(messages.length, 4);
  t.deepEqual(messages[2], { role: 'tool', tool_call_id: 'c1', content: 'ok\n[Image attached in the next message.]' });
  t.deepEqual(messages[3], { role: 'user', content: [{ type: 'text', text: 'Image(s) returned by tool call(s): c1' }, image('QUJD')] });
});

test('ciąg wyników zbiera obrazy i kończy się przed assistant', t => {
  const input = transcript();
  input.push({ role: 'function', tool_call_id: 'c2', content: [image('REVG')] }, { role: 'assistant', content: 'dalej' });
  const messages = body(lmStudioProvider, 'gpt-5.6-terra', input).messages;
  t.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'function', 'user', 'assistant']);
  t.deepEqual(messages[4], { role: 'user', content: [{ type: 'text', text: 'Image(s) returned by tool call(s): c1, c2' }, image('QUJD'), image('REVG')] });
  t.deepEqual(messages[3].content, '[Image attached in the next message.]');
  t.deepEqual(input, [...transcript(), { role: 'function', tool_call_id: 'c2', content: [image('REVG')] }, { role: 'assistant', content: 'dalej' }]);
});

test('dwa wyniki tool tworzą jedną wiadomość z obrazami w kolejności', t => {
  const input = transcript();
  input.push({ role: 'tool', tool_call_id: 'c2', content: [image('REVG')] });
  const messages = body(lmStudioProvider, 'gpt-5.6-terra', input).messages;
  t.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);
  t.deepEqual(messages[4], { role: 'user', content: [{ type: 'text', text: 'Image(s) returned by tool call(s): c1, c2' }, image('QUJD'), image('REVG')] });
  const ollama = JSON.parse(ollamaProvider.buildRequest({ model: 'llava', messages: input }, makeCtx({ modelId: 'llava' }), false).body ?? '{}') as { messages: Array<Record<string, unknown>> };
  t.deepEqual(ollama.messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);
  t.deepEqual(ollama.messages[4], { role: 'user', content: 'Image(s) returned by tool call(s): c1, c2', images: ['QUJD', 'REVG'] });
});

test('bez vision obraz zostaje zastąpiony i nie powstaje user', t => {
  const messages = body(openaiProvider, 'llama3', transcript()).messages;
  t.is(messages.length, 3);
  t.deepEqual(messages[2].content, [{ type: 'text', text: 'ok' }, { type: 'text', text: 'Image skipped - the model does not support vision.' }]);
  t.false(JSON.stringify(messages).includes('QUJD'));
});

test('helper zostawia tablicę bez obrazów narzędzi i załącznik usera', t => {
  const input: OpenAiRequestMessage[] = [{ role: 'user', content: [image('QUJD')] }, { role: 'tool', content: 'ok' }];
  t.is(moveToolImagesToUser(input), input);
  t.deepEqual(moveToolImagesToUser(input)[0], { role: 'user', content: [image('QUJD')] });
});

test('Anthropic zachowuje obrazy i tekstowy wynik', t => {
  const build = (messages: OpenAiRequestMessage[]) => JSON.parse(anthropicProvider.buildRequest({ messages }, makeCtx({ modelId: 'claude-sonnet-4-20250514' }), false).body ?? '{}') as { messages: Array<{ content: Array<{ content: unknown }> }> };
  t.deepEqual(build(transcript()).messages[2].content[0].content, [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }]);
  const input = transcript();
  input[2].content = 'ok';
  t.is(build(input).messages[2].content[0].content, 'ok');
});

test('Ollama przenosi obrazy, a bez vision stosuje zastępnik', t => {
  const build = (model: string) => JSON.parse(ollamaProvider.buildRequest({ model, messages: transcript() }, makeCtx({ modelId: model }), false).body ?? '{}') as { messages: Array<Record<string, unknown>> };
  const vision = build('llava').messages;
  t.deepEqual(vision[2], { role: 'tool', content: 'ok\n[Image attached in the next message.]' });
  t.deepEqual(vision[3], { role: 'user', content: 'Image(s) returned by tool call(s): c1', images: ['QUJD'] });
  const plain = build('llama3').messages;
  t.is(plain.length, 3);
  t.deepEqual(plain[2], { role: 'tool', content: 'ok\nImage skipped - the model does not support vision.' });
});

test('separator nazwy modelu obejmuje dwukropek', t => {
  for (const [id, expected] of [['qwen3-vl:8b', true], ['gpt-6-sol', false], ['revisionist-7b', false]] as const) {
    t.is(isVisionModel({ modelId: id, modelKey: id }), expected);
  }
});

test('polskie tłumaczenia w żądaniu', t => {
  setLocale('pl');
  const messages = body(lmStudioProvider, 'gpt-5.6-terra', transcript()).messages;
  t.deepEqual(messages[2], { role: 'tool', tool_call_id: 'c1', content: 'ok\n[Obraz w następnej wiadomości.]' });
  t.deepEqual(messages[3], { role: 'user', content: [{ type: 'text', text: 'Obraz(y) z wyniku narzędzia: c1' }, image('QUJD')] });
});
