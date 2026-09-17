import test from 'ava';
import { RollingWindow } from './RollingWindow.js';
import { regenerateLastResponse } from './chat_messages.js';

/**
 * BUG C2 — "ponów ostatnią odpowiedź" dla wiadomości usera Z ZAŁĄCZNIKIEM wklejał
 * `[object Object]` do pola wpisywania.
 *
 * `RollingMessage.content` bywa `ContentBlock[]` (załącznik/wzmianka dokłada blok
 * `{type:'image_url', ...}` obok `{type:'text', text}` — patrz `RollingWindow.ts`), a
 * `regenerateLastResponse` wstawiał `messages[lastUserIdx].content` WPROST do
 * `input_area.value` z gołym `as string`. `String(ContentBlock[])` daje
 * `"[object Object],[object Object]"` w przeglądarce - user widział śmieci zamiast
 * swojego pytania.
 *
 * Fix: reużywa `RollingWindow._contentToTokenText` (już wołane w tym samym pliku silnika
 * do liczenia tokenów/podglądu) - łączy TYLKO bloki `type === 'text'`, string zostaje
 * bez zmian.
 */
type TestDynamic = any;

function buildFakeThis(rw: RollingWindow) {
    const fakeThis: TestDynamic = {
        rollingWindow: rw,
        input_area: { value: '' },
        render_messages: async () => {},
        _sentOpts: null as unknown,
    };
    fakeThis.send_message = async (opts: unknown) => { fakeThis._sentOpts = opts; };
    return fakeThis;
}

test('BUG C2: regenerate z content jako tablica bloków wkleja połączony TEKST, nie [object Object]', async t => {
    const rw = new RollingWindow({ maxTokens: 1000, systemPrompt: 'sys' });
    await rw.addMessage('user', [
        { type: 'text', text: 'Podsumuj ten plik: ' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'dzięki' },
    ] as TestDynamic);
    await rw.addMessage('assistant', 'Oto podsumowanie.');

    const fakeThis = buildFakeThis(rw);
    await regenerateLastResponse.call(fakeThis);

    t.is(fakeThis.input_area.value, 'Podsumuj ten plik: dzięki',
        'pole wpisywania dostaje tekst POŁĄCZONYCH bloków text, bez [object Object] i bez base64 obrazu');
});

test('regenerate z content jako string zostaje bez zmian (brak regresji)', async t => {
    const rw = new RollingWindow({ maxTokens: 1000, systemPrompt: 'sys' });
    await rw.addMessage('user', 'zwykłe pytanie tekstowe');
    await rw.addMessage('assistant', 'zwykła odpowiedź');

    const fakeThis = buildFakeThis(rw);
    await regenerateLastResponse.call(fakeThis);

    t.is(fakeThis.input_area.value, 'zwykłe pytanie tekstowe');
});
