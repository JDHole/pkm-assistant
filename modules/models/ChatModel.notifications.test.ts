/**
 * CC §5 X-2 / §6 Y-6 (decyzja R8): `notices` jest OPCJONALNĄ zależnością `ChatModel`,
 * ale klaster NIE POKAZUJE żadnej notki — ani przy budowie modelu, ani przy starcie streamu.
 *
 * Powód decyzji: dawna notka „Loaded model: …" miała ZERO testów, a techniczny komunikat przy
 * każdej zmianie modelu to szum na ekranie usera. Odnotowane jako świadome odstępstwo.
 */
import test from 'ava';
import { createChatModel } from './ChatModel.js';
import { openaiProvider } from './providers/openai.js';
import { acquireSlot } from './requestGate.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeSettings } from './testing/harness.js';
import type { NoticeHandle, NoticeLike } from './contracts.js';

function spyNotices(): NoticeLike & { shown: string[] } {
    const shown: string[] = [];
    return {
        shown,
        show(message: string): NoticeHandle | null {
            shown.push(message);
            return { hide: () => {} };
        },
    };
}

test('CC X-2: ChatModel NIE pokazuje powiadomienia przy budowie ani przy starcie streamu', async t => {
    const notices = spyNotices();
    const transport = new ScriptedTransport();
    const model = createChatModel({
        provider: openaiProvider,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: 'sk-test' }),
        http: new CapturingHttpClient(),
        transport,
        gate: { acquireSlot },
        notices,
        settings: makeSettings({ chat: { platform: 'openai' } }),
    });

    t.deepEqual(notices.shown, [], 'budowa modelu nie pokazuje notki');

    const p = model.stream({ messages: [{ role: 'user', content: 'hej' }] }, {});
    for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
    t.deepEqual(notices.shown, [], 'start streamu też nie pokazuje notki');

    transport.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await p;

    t.deepEqual(notices.shown, [], 'koniec tury również milczy — notka o modelu to szum (R8)');
});
