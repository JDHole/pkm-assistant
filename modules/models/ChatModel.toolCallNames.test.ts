/**
 * Nazwa narzędzia AKUMULUJE SIĘ z fragmentów — nie nadpisuje.
 *
 * DeepSeek Reasoner potrafi wypchnąć DWA wywołania na TYM SAMYM `index` (`read` z własnymi
 * argumentami, zaraz po nim `list` z własnymi). Nadpisanie nazwy zostawia JEDNO wywołanie
 * o nazwie drugiego i sklejonym ciele `{…}{…}` — pierwsze narzędzie znika po cichu, a to,
 * które zostało, dostaje argumenty, o których nikt nie prosił. Sklejanie daje `readlist`,
 * czyli kształt, który rozkleja kanon pętli (`splitConcatenatedToolCalls` +
 * `_decomposeToolName` w `modules/agent-loop`) na dwa poprawne wywołania.
 *
 * Strażnik end-to-end: scenariusz harnessa `10_sklejone_tool_calls` (ta sama sekwencja delt
 * przechodzi przez fake-serwer, prawdziwy dekoder, model i pętlę agenta).
 *
 * CAŁY plik `test.serial`: bramka `requestGate` jest globalna.
 */
import test from 'ava';
import { ChatModel } from './ChatModel.js';
import { openaiProvider } from './providers/openai.js';
import { acquireSlot } from './requestGate.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeSettings } from './testing/harness.js';
import type { ChatRequest, OpenAiCompletion } from './contracts.js';

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'zrob dwie rzeczy' }] };

/** Jedna ramka SSE z deltą `tool_calls`. */
function ramka(toolCall: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] })}\n\n`;
}

/** Czeka na warunek albo pada — zamiast wieszać cały bieg testów. */
async function czekajNa(predykat: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predykat()) {
        if (Date.now() - start > timeoutMs) throw new Error('czekajNa: przekroczony czas oczekiwania');
        await new Promise<void>(res => setImmediate(res));
    }
}

/** Model na transporcie sterowanym z testu; oddaje odpowiedź po wypchnięciu podanych ramek. */
async function przepusc(ramki: string[]): Promise<OpenAiCompletion> {
    const transport = new ScriptedTransport();
    const model = new ChatModel({
        provider: openaiProvider,
        ctx: makeCtx({ modelId: 'gpt-4o' }),
        http: new CapturingHttpClient(),
        transport,
        gate: { acquireSlot },
        settings: makeSettings(),
    });

    const bieg = model.stream(REQ, {});
    await czekajNa(() => transport.opens === 1);
    for (const r of ramki) transport.push(r);
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    return bieg;
}

test.serial('dwa wywołania na TYM SAMYM indeksie sklejają nazwę, zamiast gubić pierwsze', async t => {
    const odp = await przepusc([
        ramka({ index: 0, id: 'call_A', type: 'function', function: { name: 'read', arguments: '{"path":"a.md"}' } }),
        ramka({ index: 0, function: { name: 'list', arguments: '{"folder":"Notatki"}' } }),
    ]);

    const calls = odp.choices[0].message.tool_calls ?? [];
    t.is(calls.length, 1, 'dostawca podał jeden indeks — model nie wymyśla drugiego slotu');
    t.is(calls[0].function.name, 'readlist',
        'nazwa nadpisana zamiast sklejona — pierwsze narzędzie znika po cichu, a drugie dostaje cudze argumenty');
    t.is(calls[0].function.arguments, '{"path":"a.md"}{"folder":"Notatki"}',
        'argumenty muszą zostać sklejone w tej samej kolejności co nazwy — inaczej pętla nie sparuje ich przy rozklejaniu');
});

test.serial('nazwa rozcięta między porcje skleja się w całość', async t => {
    const odp = await przepusc([
        ramka({ index: 0, id: 'call_A', type: 'function', function: { name: 'web_', arguments: '' } }),
        ramka({ index: 0, function: { name: 'search', arguments: '{"query":"x"}' } }),
    ]);

    const calls = odp.choices[0].message.tool_calls ?? [];
    t.is(calls[0].function.name, 'web_search');
});

test.serial('powtórzona TA SAMA nazwa nie dokleja się drugi raz', async t => {
    const odp = await przepusc([
        ramka({ index: 0, id: 'call_A', type: 'function', function: { name: 'read', arguments: '{"path":' } }),
        ramka({ index: 0, function: { name: 'read', arguments: '"a.md"}' } }),
    ]);

    const calls = odp.choices[0].message.tool_calls ?? [];
    t.is(calls[0].function.name, 'read',
        'serwer powtarzający nazwę w każdej porcji dostałby „readread" i żadne narzędzie by się nie wykonało');
    t.is(calls[0].function.arguments, '{"path":"a.md"}');
});

test.serial('różne indeksy zostają OSOBNYMI wywołaniami — sklejanie ich nie dotyczy', async t => {
    const odp = await przepusc([
        ramka({ index: 0, id: 'call_A', type: 'function', function: { name: 'read', arguments: '{"path":"a.md"}' } }),
        ramka({ index: 1, id: 'call_B', type: 'function', function: { name: 'list', arguments: '{"folder":"N"}' } }),
    ]);

    const calls = odp.choices[0].message.tool_calls ?? [];
    t.is(calls.length, 2);
    t.is(calls[0].function.name, 'read');
    t.is(calls[1].function.name, 'list');
});

/**
 * F10 (mutacje): `id` przychodzi RAZ, w pierwszej delcie wywołania — kolejne porcje go nie
 * niosą. Odwrócenie warunku przechodziło pakiet, a pętla bez `id` nie ma czym sparować
 * wyniku narzędzia z wywołaniem (`tool_call_id` w wiadomości zwrotnej).
 */
test.serial('id wywołania z pierwszej delty zostaje — kolejne porcje go nie kasują', async t => {
    const odp = await przepusc([
        ramka({ index: 0, id: 'call_A', type: 'function', function: { name: 'read', arguments: '{"path":' } }),
        ramka({ index: 0, function: { arguments: '"a.md"}' } }),
    ]);

    const calls = odp.choices[0].message.tool_calls ?? [];
    t.is(calls[0].id, 'call_A', 'bez id pętla nie ma czym sparować wyniku narzędzia z wywołaniem');
    t.is(calls[0].function.arguments, '{"path":"a.md"}', 'argumenty sklejają się dalej normalnie');
});
