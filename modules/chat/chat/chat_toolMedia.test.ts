import test from 'ava';
import { _isCurrentModelVision } from './chat_model.js';
import { lmStudioProvider } from '../../models/providers/lm_studio.js';
import { CapturingHttpClient, makeCtx, makeModel } from '../../models/testing/harness.js';
import type { OpenAiRequestMessage } from '../../models/index.js';
import { _chatExecuteToolCall } from './chat_streaming.js';

test('executor przekazuje media do modelu, zachowując surowy wynik dla UI', async t => {
    const raw = { success: true, path: 'a.png', format: 'png', base64: 'QUJD' };
    let visionCalls = 0;
    const view = { plugin: { toolRegistry: { getTool: () => ({ source: 'built-in' }) }, mcpClient: { executeToolCall: async () => raw } }, _isCurrentModelVision: () => { visionCalls++; return true; } };
    const turn = { origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' }, agentName: 'A', rawResults: new Map() };
    const result = await _chatExecuteToolCall.call(view as never, turn as never, { id: 'c1', name: 'generate_image', arguments: {} });
    t.deepEqual(result, [{ type: 'text', text: '{"success":true,"path":"a.png","format":"png"}' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
    t.is(turn.rawResults.get('c1').result, raw);
    t.is(raw.base64, 'QUJD');
    t.is(visionCalls, 1);
});

test('zwykły wynik nie sprawdza vision', async t => {
    const raw = { content: 'x' };
    let visionCalls = 0;
    const view = { plugin: { toolRegistry: { getTool: () => ({ source: 'built-in' }) }, mcpClient: { executeToolCall: async () => raw } }, _isCurrentModelVision: () => { visionCalls++; return true; } };
    const turn = { origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' }, agentName: 'A', rawResults: new Map() };
    const result = await _chatExecuteToolCall.call(view as never, turn as never, { id: 'c2', name: 'read', arguments: {} });
    t.is(result, '{"content":"x"}');
    t.is(result, JSON.stringify(raw));
    t.is(visionCalls, 0);
});

test('source captured before execution prevents media promotion after provider unregisters', async t => {
    const raw = { kind: 'media', summary: 'provider', images: [{ mime: 'image/png', base64: 'QUJD' }] };
    let source: string | undefined = 'user';
    const view = { plugin: { toolRegistry: { getTool: () => source ? { source } : null },
        mcpClient: { executeToolCall: async () => { source = undefined; return raw; } } }, _isCurrentModelVision: () => true };
    const turn = { origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' }, agentName: 'A', rawResults: new Map() };
    const result = await _chatExecuteToolCall.call(view as never, turn as never, { id: 'c', name: 'local__read', arguments: {} });
    t.is(result, JSON.stringify(raw));
});

for (const [modelId, multimodal, expected] of [
    ['moj-lokalny-model', true, true],
    ['moj-lokalny-model', false, false],
    ['moj-lokalny-model', undefined, false],
    ['gpt-4o', false, false],
] as const) {
    test(`view_image → LM Studio: ${modelId}, katalog=${multimodal}`, async t => {
        const http = new CapturingHttpClient();
        const model = makeModel(lmStudioProvider, { ctx: makeCtx({ modelId }), http });
        if (multimodal !== undefined) {
            http.queue({ body: { data: [{ id: modelId, multimodal }] } });
            await model.listModels();
        }
        const owner = { name: 'A' };
        const raw = { kind: 'media', summary: 'Zdjęcie JPEG', images: [{ mime: 'image/jpeg', base64: 'QUJD' }] };
        const view = {
            plugin: { toolRegistry: { getTool: () => ({ source: 'built-in' }) }, mcpClient: { executeToolCall: async () => raw } },
            get_chat_model: ({ agent }: { agent: unknown }) => {
                t.is(agent, owner);
                return model;
            },
            _isCurrentModelVision,
        };
        // Tak samo pyta ostrzeżenie załącznika i Oczka: właściciel, bez sieci.
        t.is(_isCurrentModelVision.call(view as never, owner as never), expected);
        const turn = { origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' }, agent: owner,
            agentName: 'A', chatModel: model, rawResults: new Map() };
        const result = await _chatExecuteToolCall.call(view as never, turn as never, { id: 'c1', name: 'view_image', arguments: {} });
        const text = '{"kind":"media","summary":"Zdjęcie JPEG","images":[{"mime":"image/jpeg"}]}';
        const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } };
        t.deepEqual(result, expected ? [{ type: 'text', text }, image]
            : '{"kind":"media","summary":"Zdjęcie JPEG","images":[{"mime":"image/jpeg"}],"image_delivery":"not delivered: model without vision"}');
        const sends = http.sends;
        http.queue({ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } });
        await model.complete({ messages: [
            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view_image', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: result },
        ] });
        const sent = JSON.parse(http.lastSpec!.body!) as { messages: OpenAiRequestMessage[] };
        if (expected) {
            t.deepEqual(sent.messages[2], { role: 'user', content: [
                { type: 'text', text: 'Image(s) returned by tool call(s): c1' }, image,
            ] });
        } else {
            t.deepEqual(sent.messages[1], { role: 'tool', tool_call_id: 'c1', content: result });
            t.false(http.lastSpec!.body!.includes('QUJD'));
        }
        t.is(http.sends, sends + 1, 'wysyłka nie pobiera katalogu');
        t.is(turn.rawResults.get('c1').result, raw);
    });
}

test('media używają instancji modelu tury mimo innego katalogu w cache i zmiany aktywnego agenta', async t => {
    const model = makeModel(lmStudioProvider, { ctx: makeCtx({ modelId: 'gpt-4o', models: [{ id: 'gpt-4o', multimodal: false }] }) });
    const cached = makeModel(lmStudioProvider, { ctx: makeCtx({ modelId: 'gpt-4o' }) });
    const raw = { kind: 'media', summary: 'zdjęcie', images: [{ mime: 'image/jpeg', base64: 'QUJD' }] };
    const view = { plugin: { toolRegistry: { getTool: () => ({ source: 'built-in' }) }, mcpClient: { executeToolCall: async () => raw } },
        get_chat_model: () => cached, _isCurrentModelVision };
    const turn = { origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' }, agent: { name: 'A' },
        agentName: 'A', chatModel: model, rawResults: new Map() };
    t.is(await _chatExecuteToolCall.call(view as never, turn as never, { id: 'c1', name: 'view_image', arguments: {} }),
        '{"kind":"media","summary":"zdjęcie","images":[{"mime":"image/jpeg"}],"image_delivery":"not delivered: model without vision"}');
});
