/**
 * AUD-wydajnosc-017 / 048 / 049 — licznik tokenów okna liczony PRZYROSTOWO.
 *
 * `addMessage` sprawdza hard limit po KAŻDYM dopisku, a pętla agenta dopisuje wyniki narzędzi
 * po jednym (`store.appendToolResult`), więc pełne przeliczenie okna od zera dawało N przeliczeń
 * na iterację; awaryjny `_trimOldestMessages` przeliczał je dodatkowo po każdej usuniętej grupie
 * (kwadratowo — zmierzone 590 ms zamrożonego UI przy 800 wiadomościach); a jedno
 * `updateTokenCounter` przemiatało historię trzy razy.
 *
 * Dziś okno trzyma STATYSTYKI tekstu (długość + liczba znaków spoza ASCII) per wiadomość
 * i sumuje je. Te testy pilnują DWÓCH rzeczy naraz:
 *   1. wynik jest DOKŁADNIE ten sam co przy dawnym „sklej wszystko i policz raz" (orakuł niżej),
 *   2. praca naprawdę jest przyrostowa (licznik przeskanowanych znaków `_statsScannedChars`).
 *
 * Osobny plik od `RollingWindow.test.ts`, bo to strażnicy WYDAJNOŚCI (mierzą pracę, nie tylko
 * wynik) i mają własny orakuł — trzymamy je razem, żeby nie rozjechały się przy edycji.
 */
import test from 'ava';
import { RollingWindow } from './RollingWindow.js';
import { getTokenCount } from '../../../core/index.js';

// TS-any: testy wstrzykują częściowe payloady transkryptu i sięgają po pola diagnostyczne.
type TestDynamic = any;

/** ORAKUŁ: dawny algorytm — sklej cały materiał w jeden string i policz go raz. */
function legacyTokenCount(rw: TestDynamic): number {
    let textToCount = '';
    let imageTokens = 0;
    const fullPrompt = rw.systemPrompt;
    if (fullPrompt) textToCount += fullPrompt;
    for (const msg of rw.messages) {
        textToCount += rw._contentToTokenText(msg.content);
        imageTokens += rw._contentImageTokens(msg.content);
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                if (tc.function?.arguments) textToCount += tc.function.arguments;
                if (tc.function?.name) textToCount += tc.function.name;
            }
        }
        if (msg.reasoning_content) textToCount += msg.reasoning_content;
    }
    return getTokenCount(textToCount) + imageTokens + rw._toolDefinitionsTokens;
}

/** Deterministyczny LCG — losowe historie bez losowego wyniku testu. */
function lcg(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

test('licznik przyrostowy = pełne przeliczenie (property test na losowych historiach)', async t => {
    const rand = lcg(20260902);
    const alphabets = ['abcdefghij ', 'ąćęłńóśźż ', 'japoński テキスト ', 'mixed ĄŻ text 123 '];

    for (let round = 0; round < 40; round++) {
        const rw: TestDynamic = new RollingWindow({ maxTokens: 10_000_000, systemPrompt: 'System prompt ąćę ' + round });
        const count = 3 + Math.floor(rand() * 25);
        for (let i = 0; i < count; i++) {
            const alpha = alphabets[Math.floor(rand() * alphabets.length)];
            const body = alpha.repeat(1 + Math.floor(rand() * 40));
            const roll = rand();
            if (roll < 0.25) {
                await rw.addMessage('assistant', body, {
                    tool_calls: [{ id: 'c' + i, function: { name: 'read', arguments: '{"path":"' + body.slice(0, 12) + '"}' } }],
                });
                await rw.addMessage('tool', body.repeat(2), { tool_call_id: 'c' + i });
            } else if (roll < 0.4) {
                await rw.addMessage('assistant', body, { reasoning_content: body.repeat(3) });
            } else if (roll < 0.5) {
                await rw.addMessage('user', [
                    { type: 'text', text: body },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'B'.repeat(2000 + i * 137) } },
                ]);
            } else {
                await rw.addMessage(roll < 0.75 ? 'user' : 'assistant', body);
            }
        }
        rw.setContextTokenSources({ system_tools: 40, mcp_tools_active: 17 });

        t.is(rw.getCurrentTokenCount(), legacyTokenCount(rw), 'runda ' + round + ': licznik okna');
        t.is(rw.getBreakdown().total, legacyTokenCount(rw), 'runda ' + round + ': nagłówek Token Viewera');

        // …i po mutacjach, które NIE idą przez addMessage.
        rw.trimOldToolResults(2);
        t.is(rw.getCurrentTokenCount(), legacyTokenCount(rw), 'runda ' + round + ': po skróceniu wyników narzędzi');
        rw.setSystemPrompt('zupełnie nowy prompt ĄŻŹ ' + round);
        t.is(rw.getCurrentTokenCount(), legacyTokenCount(rw), 'runda ' + round + ': po podmianie promptu');
        rw.conversationSummary = 'streszczenie rozmowy ' + round;
        t.is(rw.getCurrentTokenCount(), legacyTokenCount(rw), 'runda ' + round + ': po dopisaniu streszczenia');
        rw.messages.splice(0, Math.min(2, rw.messages.length));
        t.is(rw.getCurrentTokenCount(), legacyTokenCount(rw), 'runda ' + round + ': po wycięciu najstarszych');
    }
});

test('suma tokenów per wiadomość liczona z tej samej pamięci co całe okno', async t => {
    const rw: TestDynamic = new RollingWindow({ maxTokens: 10_000_000, systemPrompt: 'Prompt ąę.' });
    await rw.addMessage('user', 'pytanie o notatkę');
    await rw.addMessage('assistant', 'odpowiadam', {
        tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"A.md"}' } }],
        reasoning_content: 'myślę intensywnie',
    });
    await rw.addMessage('tool', 'treść notatki '.repeat(40), { tool_call_id: 'c1' });

    for (const msg of rw.messages) {
        // Orakuł dla POJEDYNCZEJ wiadomości: dawny kształt `_countMessageTokens`.
        let text = rw._contentToTokenText(msg.content);
        for (const tc of msg.tool_calls || []) {
            if (tc.function?.arguments) text += tc.function.arguments;
            if (tc.function?.name) text += tc.function.name;
        }
        if (msg.reasoning_content) text += msg.reasoning_content;
        const legacy = getTokenCount(text) + rw._contentImageTokens(msg.content);
        t.is(rw._countMessageTokens(msg), legacy);
    }
});

test('dopisanie wyniku narzędzia skanuje TYLKO nową treść, nie całą historię (AUD-wydajnosc-017)', async t => {
    const rw: TestDynamic = new RollingWindow({ maxTokens: 10_000_000, systemPrompt: 'System prompt.' });
    for (let i = 0; i < 200; i++) await rw.addMessage('user', ('stara wiadomość numer ' + i + ' ').repeat(20));
    const historyChars = rw.messages.reduce((sum: number, m: TestDynamic) => sum + String(m.content).length, 0);
    t.true(historyChars > 100_000, 'historia musi być duża, żeby test miał sens');

    // Pętla agenta dopisuje wyniki narzędzi PO JEDNYM (`store.appendToolResult`).
    const before = rw._statsScannedChars;
    const payload = 'wynik narzędzia '.repeat(50);
    await rw.addMessage('assistant', '', {
        tool_calls: [1, 2, 3, 4, 5].map(n => ({ id: 't' + n, function: { name: 'read', arguments: '{}' } })),
    });
    for (let n = 1; n <= 5; n++) await rw.addMessage('tool', payload, { tool_call_id: 't' + n });
    const scanned = rw._statsScannedChars - before;

    // Przed naprawą: 6 dopisków × pełne okno (>600 000 znaków), bo każdy `addMessage` sprawdza
    // hard limit. Dziś skanujemy wyłącznie NOWY materiał.
    t.true(scanned < 5 * payload.length + 2000, 'przeskanowano ' + scanned + ' znaków — to nadal pełne przeliczenia');
    t.true(scanned < historyChars / 10, 'przeskanowano ' + scanned + ' znaków przy historii ' + historyChars);
});

test('Token Viewer: getBreakdown NIE skanuje historii po raz drugi (AUD-wydajnosc-049)', async t => {
    const rw: TestDynamic = new RollingWindow({ maxTokens: 10_000_000, systemPrompt: 'System prompt.' });
    for (let i = 0; i < 100; i++) await rw.addMessage('user', ('wiadomość ' + i + ' ').repeat(30));

    rw.getCurrentTokenCount(); // rozgrzewka: to samo robi wskaźnik pod inputem
    const before = rw._statsScannedChars;
    rw.getBreakdown();
    rw.getCurrentTokenCount();
    rw.getBreakdown();
    t.is(rw._statsScannedChars - before, 0, 'trzy przebiegi po niezmienionym oknie = zero skanowania');
});

test('mutacja W MIEJSCU (Oczko dokłada obraz do ostatniej wiadomości) jest widziana', async t => {
    const rw: TestDynamic = new RollingWindow({ maxTokens: 10_000_000, systemPrompt: 'System prompt.' });
    await rw.addMessage('user', 'co widzisz?');
    const msg = rw.messages[rw.messages.length - 1];
    msg.content = [{ type: 'text', text: msg.content }];
    const beforePush = rw.getCurrentTokenCount();

    msg.content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'B'.repeat(50_000) } });

    t.true(rw.getCurrentTokenCount() > beforePush, 'push do tablicy bloków MUSI unieważnić statystyki wiadomości');
    t.is(rw.getCurrentTokenCount(), legacyTokenCount(rw));
});

test('awaryjne przycinanie okna nie przelicza historii w kółko (AUD-wydajnosc-048)', t => {
    const rw: TestDynamic = new RollingWindow({ maxTokens: 60_000, systemPrompt: 'System prompt.' });
    for (let i = 0; i < 800; i++) {
        rw.messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: ('wiadomość ' + i + ' ').repeat(120) });
    }
    const historyChars = rw.messages.reduce((sum: number, m: TestDynamic) => sum + String(m.content).length, 0);

    rw.getCurrentTokenCount(); // pierwszy przebieg SKANUJE (pamięć jest pusta)
    const before = rw._statsScannedChars;
    rw._trimOldestMessages();
    const scanned = rw._statsScannedChars - before;

    t.true(rw.getCurrentTokenCount() <= rw.maxTokens, 'przycinanie ma dowieźć okno pod limit');
    t.is(scanned, 0, 'przycinanie przeskanowało ' + scanned + ' znaków — kwadrat wrócił (historia: ' + historyChars + ')');
    t.is(rw.getCurrentTokenCount(), legacyTokenCount(rw));
});
