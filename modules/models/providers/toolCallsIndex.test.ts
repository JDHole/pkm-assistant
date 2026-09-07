import test from 'ava';
import { openaiProvider } from './openai.js';
import { collect, makeCtx } from '../testing/harness.js';
import type { ChatRequest, ProviderContext } from '../contracts.js';

/**
 * Testy regresji fabryki napraw F03 (klaster models-adaptery-streamu, 2026-08-30).
 *
 * AUD-code-review-019 (HIGH): wspólny dekoder kształtu OpenAI (openai/deepseek/groq/
 * open_router/lm_studio, oraz dawniej custom/azure zanim poszły do wywałki 2026-09-03,
 * AUD-dead-code-026/110/168) akumulował delty `tool_calls` ZAWSZE do slotu `[0]`, ignorując
 * `delta.tool_calls[].index`. Dwa równoległe wywołania narzędzia w jednej turze sklejały się
 * w jedno (id/nazwa/argumenty jednego wołania zjadały drugie).
 *
 * AUD-testy-010 (HIGH, fabryka napraw F1 2026-09-02): bramka zakresu `[0, TOOL_CALL_MAX_INDEX)`
 * miała dotąd testy WYŁĄCZNIE strony „przepuszcza" (0/1/2/brak indeksu, testy wyżej) — strona
 * „blokuje" (index spoza zakresu od zepsutego dostawcy/proxy) nie miała ani jednego testu.
 * Bez bramki: index ujemny/ułamkowy rzuca TypeError, a duży dodatni pcha tysiące/miliony
 * pustych slotów (OOM przy indeksie rzędu 1e9 od dostawcy).
 *
 * ⚠️ Test „`_transform_tool_calls_to_openai` daje IDENTYCZNY wynik po stronie żądania
 * i odpowiedzi" SKASOWANY bez następcy (B.6 BA-14 `must-keep = N`): w nowej architekturze
 * nie ma dwóch klas do porównania, więc test stracił przedmiot.
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
const CTX: ProviderContext = makeCtx({ modelId: 'gpt-4o' });

function decode(chunks: string[]) {
    return collect(openaiProvider.createStreamDecoder(REQ, CTX), chunks);
}

test('AUD-code-review-019: dwa równoległe tool_calls w streamie trafiają do OSOBNYCH slotów po delta.tool_calls[].index', t => {
    const snapshot = decode([
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_A","type":"function","function":{"name":"memory_save","arguments":""}}]}}]}',
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_B","type":"function","function":{"name":"web_search","arguments":""}}]}}]}',
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"tajne.md\\"}"}}]}}]}',
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"q\\":\\"pogoda\\"}"}}]}}]}',
    ]);

    const calls = snapshot.choices[0].message.tool_calls!;
    t.is(calls.length, 2, 'dwa wywołania zostają dwoma wpisami, nie sklejają się w jeden');
    t.is(calls[0].id, 'call_A');
    t.is(calls[0].function.name, 'memory_save');
    t.is(calls[0].function.arguments, '{"path":"tajne.md"}');
    t.is(calls[1].id, 'call_B');
    t.is(calls[1].function.name, 'web_search');
    t.is(calls[1].function.arguments, '{"q":"pogoda"}');
});

test('AUD-code-review-019: trzy wywołania, delty przeplecione w dowolnej kolejności, dalej trafiają po indeksie', t => {
    const snapshot = decode([
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":2,"id":"call_C","type":"function","function":{"name":"c","arguments":""}}]}}]}',
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_A","type":"function","function":{"name":"a","arguments":""}}]}}]}',
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_B","type":"function","function":{"name":"b","arguments":""}}]}}]}',
    ]);

    const calls = snapshot.choices[0].message.tool_calls!;
    t.is(calls.length, 3);
    t.deepEqual(calls.map(c => c.id), ['call_A', 'call_B', 'call_C'], 'sloty ułożone po indeksie, nie po kolejności przyjścia chunków');
});

test('AUD-code-review-019: brak delta.tool_calls[].index (dostawca łamiący kontrakt OpenAI) trafia do slotu 0 jak dawniej', t => {
    const snapshot = decode([
        'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"id":"call_A","type":"function","function":{"name":"vault_read","arguments":"{}"}}]}}]}',
    ]);

    const calls = snapshot.choices[0].message.tool_calls!;
    t.is(calls.length, 1);
    t.is(calls[0].id, 'call_A');
});

test('AUD-testy-010: index ujemny/ułamkowy nie rzuca — deltaCall ląduje w slocie 0 (dawny TypeError na indeksie -1)', t => {
    for (const badIndex of [-1, 1.5]) {
        let snapshot!: ReturnType<typeof decode>;
        t.notThrows(() => {
            snapshot = decode([
                `data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":${badIndex},"id":"call_A","type":"function","function":{"name":"vault_read","arguments":"{}"}}]}}]}`,
            ]);
        }, `index ${badIndex} nie może rzucić — bramka ma go potraktować jak brak indeksu`);

        const calls = snapshot.choices[0].message.tool_calls!;
        t.is(calls.length, 1, `index ${badIndex}: jeden slot, nie zawieszenie/wyjątek`);
        t.is(calls[0].id, 'call_A', `index ${badIndex}: wywołanie ląduje w slocie 0`);
    }
});

test('AUD-testy-010: index >= 64 (albo bardzo duży) nie pcha tysięcy pustych slotów — ląduje w slocie 0', t => {
    for (const badIndex of [64, 1000]) {
        const snapshot = decode([
            `data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":${badIndex},"id":"call_A","type":"function","function":{"name":"vault_read","arguments":"{}"}}]}}]}`,
        ]);

        const calls = snapshot.choices[0].message.tool_calls!;
        t.is(calls.length, 1, `index ${badIndex}: dokładnie JEDEN slot — bramka [0,64) ma go złapać, nie pchać ${badIndex}+1 pustych obiektów`);
        t.is(calls[0].id, 'call_A', `index ${badIndex}: wywołanie ląduje w slocie 0`);
    }
});
