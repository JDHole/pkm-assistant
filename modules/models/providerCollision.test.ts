import test from 'ava';
import type { ChatRequest, HttpRequestSpec, StreamTransport } from './contracts.js';
import { CHAT_PROVIDERS as currentProviders } from './registry.js';
import { createModelForRole as currentResolver, clearModelCache as clearCurrent } from './modelResolver.js';
import { _isCurrentModelVision } from '../chat/chat/chat_model.js';
import { log } from '../../core/utils/Logger.js';
import { CapturingHttpClient, makeCtx, makeModel } from './testing/harness.js';

const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } };
// Próba recenzenta: resolver → katalog API → czat → rzeczywisty adapter.

for (const platform of ['lm_studio', 'ollama', 'open_router', 'openai'] as const) {
  for (const modelId of ['models/x', 'x']) {
    for (const stream of [false, true]) {
      test.serial(`katalog dwóch różnych id: ${platform}, ${modelId}, stream=${stream}`, async t => {
        clearCurrent();
        t.teardown(() => { clearCurrent(); });
        const other = modelId === 'x' ? 'models/x' : 'x';
        // API returns two distinct models; only the chosen one accepts images.
        const entries = [{ id: other, multimodal: false }, { id: modelId, multimodal: true }];
        const catalog = platform === 'ollama'
          ? { models: entries.map(({ id, multimodal }) => ({ model: id, details: { families: multimodal ? ['clip'] : ['llama'] } })) }
          : platform === 'open_router'
          ? { data: entries.map(({ id, multimodal }) => ({ id, architecture: { input_modalities: multimodal ? ['text', 'image'] : ['text'] } })) }
          : { data: entries };
        const completion = platform === 'ollama'
          ? { message: { role: 'assistant', content: 'ok' }, done: true }
          : { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
        const http = new CapturingHttpClient({ body: catalog }).queue({ body: completion });
        const sent: HttpRequestSpec[] = [];
        const transport: StreamTransport = { open: async (spec, sink) => {
          sent.push(spec);
          sink.onChunk(platform === 'ollama' ? JSON.stringify(completion) + '\n'
            : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
          return { status: 200, headers: {}, body: '' };
        } };
        const plugin = { env: { settings: { pkmAssistant: {
          modelLibrary: { main: [{ platform, model: modelId, isDefault: true }] },
          chat: { apiKeys: { [platform]: 'key' }, hosts: { [platform]: platform === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234' } },
        } }, config: { chat: { providers: currentProviders, http, transport } } } };
        const model = currentResolver(plugin, 'main')!;
        t.truthy(model, 'produkcyjny resolver przyjmuje nazwę');
        const parsed = await model.listModels();
        t.is(parsed.find(entry => entry.id === modelId)?.multimodal, true);
        const decision = _isCurrentModelVision.call({ get_chat_model: () => model } as never);
        const req: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Opisz' }, image] }] };
        let error: unknown;
        try { if (stream) await model.stream(req); else await model.complete(req); } catch (e) { error = e; }
        const spec = stream ? sent[0] : http.specs.find(item => item.method === 'POST');
        if (!spec) { t.fail(error instanceof Error ? error.message : 'Brak żądania POST'); return; }
        const actual = error ? { vision: decision, error: (error as Error).message } : { vision: decision, image: spec.body!.includes('QUJD'), model: JSON.parse(spec.body!).model };
        t.deepEqual(actual, { vision: true, image: true, model: modelId }, 'dokładny dodatni wpis katalogu musi zachować widzenie i obraz');
        model.stopStream();
      });
    }
  }
}

for (const stream of [false, true]) {
    test.serial(`OpenAI-compatible z produkcyjnym loggerem usuwa obraz bez przerwania wysyłki, stream=${stream}`, async t => {
        const http = new CapturingHttpClient({ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } });
        const sent: HttpRequestSpec[] = [];
        const transport: StreamTransport = { open: async (spec, sink) => {
            sent.push(spec);
            sink.onChunk('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
            return { status: 200, headers: {}, body: '' };
        } };
        const model = makeModel(currentProviders.openai, { ctx: makeCtx({ modelId: 'text-only', log }), http, transport });
        const req: ChatRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Opisz' }, image] }] };
        const warnings: unknown[][] = [];
        const original = console.warn;
        console.warn = (...args) => { warnings.push(args); };
        t.teardown(() => { console.warn = original; model.stopStream(); });
        const reply = stream ? await model.stream(req) : await model.complete(req);
        t.is(reply.choices[0].message.content, 'ok');
        const spec = stream ? sent[0] : http.specs[0];
        t.false(spec.body!.includes('QUJD'));
        t.true(spec.body!.includes('Image skipped - the model does not support vision.'));
        t.true(JSON.stringify(warnings).includes('models.image_stripped'));
    });
}
