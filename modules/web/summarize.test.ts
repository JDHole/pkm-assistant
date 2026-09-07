/**
 * summarize.test.js — streszczanie stron tanim modelem (E3.3, DEC L13-5a).
 *
 * Model jest atrapą wg kontraktu `streamToComplete` (`modules/memory/streamHelper.js`):
 * `.stream({messages}, {chunk, done, error})`, gdzie `done` dostaje kształt OpenAI.
 * Nic poza modelem nie jest podmieniane — parser i budowa promptu są prawdziwe.
 */
import test from 'ava';
import {
    summarizeWebContent,
    parseSummaryResponse,
    clipForPrompt,
    SUMMARIZE_INPUT_MAX,
} from './summarize.js';

/** Kształt wołania, jakie robi `streamToComplete` (`modules/memory/streamHelper.js`). */
interface StreamRequest {
    messages: Array<{ role: string; content: string }>;
}
interface StreamHandlers {
    done: (response: unknown) => void;
    error: (err: unknown) => void;
    chunk?: (response: unknown) => void;
}

/** Atrapa modelu: oddaje `reply` i zapamiętuje prompt, z którym ją zawołano. */
function fakeModel(reply: string) {
    const calls: StreamRequest[] = [];
    return {
        calls,
        stream(req: StreamRequest, handlers: StreamHandlers) {
            calls.push(req);
            setTimeout(() => handlers.done({ choices: [{ message: { content: reply } }] }), 0);
        },
    };
}

function failingModel(err: Error) {
    return {
        stream(_req: StreamRequest, handlers: StreamHandlers) {
            setTimeout(() => handlers.error(err), 0);
        },
    };
}

const GOOD_REPLY = [
    'STRESZCZENIE:',
    'Obsidian 1.9 dodaje bases i nowy silnik wyszukiwania. Premiera 2026-03-01.',
    '',
    'CYTATY:',
    '- "Bases zastępują dataview w rdzeniu aplikacji."',
    '- Nowy silnik indeksuje 100k notatek w 4 sekundy.',
].join('\n');

test('parsuje sekcje STRESZCZENIE i CYTATY', async t => {
    const model = fakeModel(GOOD_REPLY);
    const res = await summarizeWebContent({
        title: 'Obsidian 1.9',
        url: 'https://example.com/a',
        content: 'x'.repeat(20000),
        model,
        targetChars: 4000,
    });

    t.regex(res.summary, /^Obsidian 1\.9 dodaje bases/);
    t.notRegex(res.summary, /CYTATY/);
    t.deepEqual(res.citations, [
        { fragment: 'Bases zastępują dataview w rdzeniu aplikacji.' },
        { fragment: 'Nowy silnik indeksuje 100k notatek w 4 sekundy.' },
    ]);
});

test('prompt niesie tytuł, URL, cel długości i treść', t => {
    const model = fakeModel(GOOD_REPLY);
    return summarizeWebContent({
        title: 'Tytuł',
        url: 'https://example.com/b',
        content: 'TRESC-STRONY',
        model,
        targetChars: 1234,
    }).then(() => {
        const prompt = model.calls[0].messages[0].content;
        t.regex(prompt, /Tytuł/);
        t.regex(prompt, /https:\/\/example\.com\/b/);
        t.regex(prompt, /1234/);
        t.regex(prompt, /TRESC-STRONY/);
        t.regex(prompt, /DOSŁOWNYCH/i, 'prompt wymusza dosłowne cytaty');
    });
});

test('brak sekcji CYTATY → citations = [] (to nie jest błąd)', t => {
    const { summary, citations } = parseSummaryResponse('STRESZCZENIE:\nSamo streszczenie.');
    t.is(summary, 'Samo streszczenie.');
    t.deepEqual(citations, []);
});

test('brak nagłówka STRESZCZENIE → streszczeniem jest tekst przed CYTATY', t => {
    const { summary, citations } = parseSummaryResponse('Goła odpowiedź modelu.\n\nCYTATY:\n- cytat');
    t.is(summary, 'Goła odpowiedź modelu.');
    t.deepEqual(citations, [{ fragment: 'cytat' }]);
});

test('parser toleruje markdown i numerowanie cytatów', t => {
    const { summary, citations } = parseSummaryResponse(
        '## **STRESZCZENIE:**\nTreść.\n\n**CYTATY:**\n1) „pierwszy"\n2. drugi\n* trzeci'
    );
    t.is(summary, 'Treść.');
    t.deepEqual(citations, [
        { fragment: 'pierwszy' },
        { fragment: 'drugi' },
        { fragment: 'trzeci' },
    ]);
});

test('clipForPrompt zostawia początek i koniec z markerem [...]', t => {
    const long = 'A'.repeat(30000) + 'B'.repeat(30000) + 'C'.repeat(10000);
    const clipped = clipForPrompt(long);
    t.true(clipped.length < long.length);
    t.true(clipped.length <= SUMMARIZE_INPUT_MAX + 10, 'plus sam marker');
    t.true(clipped.startsWith('A'.repeat(100)));
    t.true(clipped.endsWith('C'.repeat(100)), 'koniec artykułu (wnioski) przetrwał');
    t.regex(clipped, /\[\.\.\.\]/);

    const short = 'krótka treść';
    t.is(clipForPrompt(short), short, 'krótkie wejście idzie w całości');
});

test('błąd modelu leci dalej — o fallbacku decyduje narzędzie', async t => {
    await t.throwsAsync(
        summarizeWebContent({ content: 'x', model: failingModel(new Error('API 500')) }),
        { message: 'API 500' }
    );
});

test('brak modelu i pusta odpowiedź = wyjątek', async t => {
    await t.throwsAsync(summarizeWebContent({ content: 'x', model: null }), { message: /brak modelu/ });
    await t.throwsAsync(
        summarizeWebContent({ content: 'x', model: fakeModel('   ') }),
        { message: /pustą odpowiedź/ }
    );
});
