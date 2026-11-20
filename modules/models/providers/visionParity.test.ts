import test from 'ava';
import { isVisionModel } from '../capabilities.js';
import { CHAT_PROVIDERS } from '../registry.js';
import { makeCtx, makeModel } from '../testing/harness.js';
import type { OpenAiRequestMessage } from '../contracts.js';

for (const provider of Object.values(CHAT_PROVIDERS)) {
    for (const [id, multimodal, expected] of [
        ['moj-lokalny-model', true, true],
        ['moj-lokalny-model', false, false],
        ['moj-lokalny-model', undefined, false],
        ['gpt-4o', false, false],
        ['gpt-4o', undefined, true],
    ] as const) {
        test(`${provider.info.id}: czat i adapter ${id}, katalog=${multimodal}`, t => {
            const ctx = makeCtx({ modelId: id, models: multimodal === undefined ? undefined : [{ id, multimodal }] });
            const model = makeModel(provider, { ctx });
            t.is(isVisionModel(model), expected);
            const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } };
            for (const role of ['user', 'tool'] as const) {
                const messages: OpenAiRequestMessage[] = role === 'user'
                    ? [{ role, content: [{ type: 'text', text: 'opis' }, image] }]
                    : [
                        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view_image', arguments: '{}' } }] },
                        { role, name: 'view_image', tool_call_id: 'c1', content: [{ type: 'text', text: 'opis' }, image] },
                    ];
                for (const stream of [false, true]) {
                    const body = provider.buildRequest({ messages }, ctx, stream).body!;
                    t.true(body.includes('opis'));
                    t.is(body.includes('QUJD'), expected, `${role}, stream=${stream}`);
                    if (!expected) t.true(body.includes('Image skipped - the model does not support vision.'));
                }
            }
        });
    }
}
