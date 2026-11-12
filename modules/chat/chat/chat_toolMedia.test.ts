import test from 'ava';
import { _chatExecuteToolCall } from './chat_streaming.js';

test('executor przekazuje media do modelu, zachowując surowy wynik dla UI', async t => {
    const raw = { success: true, path: 'a.png', format: 'png', base64: 'QUJD' };
    let visionCalls = 0;
    const view = { plugin: { mcpClient: { executeToolCall: async () => raw } }, _isCurrentModelVision: () => { visionCalls++; return true; } };
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
    const view = { plugin: { mcpClient: { executeToolCall: async () => raw } }, _isCurrentModelVision: () => { visionCalls++; return true; } };
    const turn = { origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' }, agentName: 'A', rawResults: new Map() };
    const result = await _chatExecuteToolCall.call(view as never, turn as never, { id: 'c2', name: 'read', arguments: {} });
    t.is(result, '{"content":"x"}');
    t.is(result, JSON.stringify(raw));
    t.is(visionCalls, 0);
});
