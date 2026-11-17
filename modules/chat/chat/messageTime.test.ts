import test from 'ava';
import { messageTime } from '../../../core/index.js';
import { RollingWindow } from './RollingWindow.js';

test('message times are frozen in the API prefix while stored and summarized text stays clean', async t => {
    let summaryInput: string | null = null;
    const rw = new RollingWindow({ systemPrompt: 'stały prompt', summarizer: { triggerThreshold: 0.9, summarize: async messages => { summaryInput = JSON.stringify(messages); return 'summary'; } } });
    const localTime = (minutes: number) => { const date = new Date(2026, 10, 16, 0, minutes); date.getTimezoneOffset = () => 0; return date; };
    const first = messageTime(() => localTime(0), 'pl');
    await rw.addMessage('user', 'Pierwsza', { messageTime: first });
    const request1 = rw.getMessagesForAPI();
    await rw.addMessage('assistant', 'Odpowiedź');
    await rw.addMessage('user', [{ type: 'text', text: 'Druga' }, { type: 'image_url', image_url: { url: 'image' } }], { messageTime: messageTime(() => localTime(7), 'pl') });
    const request2 = rw.getMessagesForAPI();
    const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
    const firstAdapterInput = JSON.stringify({ tools, system: request1[0], messages: request1.slice(1) });
    const secondAdapterPrefix = JSON.stringify({ tools, system: request2[0], messages: request2.slice(1, 2) });
    t.is(firstAdapterInput, secondAdapterPrefix);
    t.deepEqual(request1, [{ role: 'system', content: 'stały prompt' }, { role: 'user', content: '[czas wiadomości: 2026-11-16 00:00, poniedziałek, UTC+00:00]\nPierwsza' }]);
    t.deepEqual(request2[3]?.content, [{ type: 'text', text: '[czas wiadomości: 2026-11-16 00:07, poniedziałek, UTC+00:00]\nDruga' }, { type: 'image_url', image_url: { url: 'image' } }]);
    t.is(rw.messages[0]?.content, 'Pierwsza');
    await rw.performSummarization(true);
    t.true((summaryInput ?? '').includes('Pierwsza'));
    t.false((summaryInput ?? '').includes('[czas wiadomości:'));
});

test('legacy user messages are unchanged', async t => {
    const rw = new RollingWindow();
    await rw.addMessage('user', 'Stara wiadomość');
    t.deepEqual(rw.getMessagesForAPI(), [{ role: 'user', content: 'Stara wiadomość' }]);
});

test('local midnight and a negative offset with minutes, weekdays in both languages', t => {
    const date = new Date(2026, 10, 16, 0, 0);
    date.getFullYear = () => 2026; date.getMonth = () => 10; date.getDate = () => 16;
    date.getHours = () => 0; date.getMinutes = () => 0; date.getTimezoneOffset = () => 210;
    t.is(messageTime(() => date, 'pl'), '2026-11-16 00:00, poniedziałek, UTC-03:30');
    t.is(messageTime(() => date, 'en'), '2026-11-16 00:00, Monday, UTC-03:30');
});
