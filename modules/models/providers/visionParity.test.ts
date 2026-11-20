import test from 'ava';
import { _isCurrentModelVision } from '../../chat/chat/chat_model.js';
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

// Brzegi przestrzeni nazw: expected non-Gemini przypina zachowanie 99f75cb.
const prefixCases = [
    { id: 'x', other: 'models/x', gemini: false },
    { id: 'models/x', other: 'x', gemini: false },
    { id: 'Models/x', other: 'x', gemini: false },
    { id: 'models/models/x', other: 'models/x', gemini: true },
    { id: 'models/', other: '', gemini: false },
] as const;
for (const provider of Object.values(CHAT_PROVIDERS)) {
    for (const { id, other, gemini } of prefixCases) {
        for (const exactFirst of [false, true]) {
            test(`${provider.info.id}: prefiks ${id}, exactFirst=${exactFirst}`, t => {
                const models = [{ id: other, multimodal: false }, { id, multimodal: true }];
                if (exactFirst) models.reverse();
                const expected = provider.info.id === 'gemini' ? exactFirst || gemini : true;
                const ctx = makeCtx({ modelId: id, models });
                const model = makeModel(provider, { ctx });
                t.is(isVisionModel(model), expected, 'wspólna polityka');
                t.is(_isCurrentModelVision.call({ get_chat_model: () => model } as never), expected, 'czat');
                for (const role of ['user', 'tool'] as const) {
                    for (const stream of [false, true]) {
                        const messages: OpenAiRequestMessage[] = [{ role, tool_call_id: 'c1', name: 'view_image', content: [
                            { type: 'text', text: 'opis' },
                            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
                        ] }];
                        const spec = provider.buildRequest({ messages }, ctx, stream);
                        t.is(spec.body!.includes('QUJD'), expected, `adapter ${role}, stream=${stream}`);
                        if (provider.info.id !== 'gemini') t.is(JSON.parse(spec.body!).model, id);
                    }
                }
            });
        }
    }
    test(`${provider.info.id}: obcy models/gpt-4o nie przesłania gpt-4o`, t => {
        const ctx = makeCtx({ modelId: 'gpt-4o', models: [{ id: 'models/gpt-4o', multimodal: false }] });
        const model = makeModel(provider, { ctx });
        const expected = provider.info.id !== 'gemini';
        t.is(isVisionModel(model), expected);
        t.is(_isCurrentModelVision.call({ get_chat_model: () => model } as never), expected);
        const body = provider.buildRequest({ messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
        ] }] }, ctx, false).body!;
        t.is(body.includes('QUJD'), expected);
    });
}
