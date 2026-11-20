import test from 'ava';
import { isVisionModel } from './capabilities.js';
import { lmStudioProvider } from './providers/lm_studio.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeHttpResponse, makeModel } from './testing/harness.js';
import { clearModelCache, createModelForRole } from './modelResolver.js';
import { CHAT_PROVIDERS } from './registry.js';
import type { HttpResponse, ResolverPluginLike } from './contracts.js';

const id = 'moj-lokalny-model';
const catalog = (multimodal: boolean) => ({ body: { data: [{ id, multimodal }] } });

test('katalog początkowy, odświeżenie i awaria: wspólna decyzja czatu i serializacji', async t => {
    const http = new CapturingHttpClient(catalog(false), catalog(true), { status: 503 });
    const model = makeModel(lmStudioProvider, { ctx: makeCtx({ modelId: id, models: [{ id, multimodal: true }] }), http });
    t.true(isVisionModel(model));
    await model.listModels();
    t.false(isVisionModel(model));
    await model.listModels(true);
    t.true(isVisionModel(model));
    t.deepEqual(await model.listModels(true), []);
    t.true(isVisionModel(model), 'niedostępny katalog zachowuje ostatnią wiedzę');
    http.queue({ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } });
    await model.complete({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }] });
    t.deepEqual(JSON.parse(http.lastSpec!.body!).messages, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }]);
    t.is(http.sends, 4);
});

test('trwające listModels nie blokuje wysyłki ani nie uruchamia dodatkowego pobrania', async t => {
    let finishCatalog!: (response: HttpResponse) => void;
    let gets = 0;
    const http = new CapturingHttpClient({ body: { choices: [{ message: { role: 'assistant', content: 'wysłano' } }] } });
    const model = makeModel(lmStudioProvider, { ctx: makeCtx({ modelId: id }), http: {
        send: spec => {
            if (spec.method !== 'GET') return http.send(spec);
            gets++;
            return new Promise(resolve => { finishCatalog = resolve; });
        },
    } });
    const pending = model.listModels();
    try {
        t.false(isVisionModel(model));
        const response = await model.complete({ messages: [{ role: 'user', content: 'hej' }] });
        t.is(response.choices[0].message.content, 'wysłano');
        t.is(gets, 1);
    } finally {
        finishCatalog(makeHttpResponse(catalog(true)));
        await pending;
    }
    t.true(isVisionModel(model));
});

// Próba recenzenta przeniesiona z .tmp/odbior3/regression-prefix.test.ts.
test.serial('Gemini models/: zapis w bibliotece → resolver → complete zachowuje obraz', async t => {
    clearModelCache();
    t.teardown(() => clearModelCache());
    const modelId = 'models/gemini-2.5-pro';
    const http = new CapturingHttpClient({ body: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } });
    const plugin: ResolverPluginLike = { env: {
        settings: { pkmAssistant: {
            modelLibrary: { main: [{ platform: 'gemini', model: modelId, isDefault: true }] },
            chat: { apiKeys: { gemini: 'key' } },
        } },
        config: { chat: { providers: CHAT_PROVIDERS, http, transport: new ScriptedTransport() } },
    } };
    const model = createModelForRole(plugin, 'main')!;
    t.is(model.modelId, modelId);
    await model.complete({ messages: [{ role: 'user', content: [
        { type: 'text', text: 'opisz' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ] }] });
    t.is(http.lastSpec!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    t.deepEqual(JSON.parse(http.lastSpec!.body!).contents[0].parts[1], { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } });
    t.true(isVisionModel(model));
});
