/**
 * toolTranscriptSanitizer — testy strony „odsiewa" (AUD-testy-015/038).
 *
 * Sanitizer jest jedyną bramką między transkryptem a dostawcą — pętla go puszcza przed
 * KAŻDYM wywołaniem modelu (AgentLoop.ts:407 i :647). Do tego pliku dwie z trzech gałęzi
 * nie miały ŻADNEGO dedykowanego testu: filtr poprawności wpisów `tool_calls` (id +
 * function.name, linia 55) i odsiew pustych wiadomości (linia 73). Jedyny istniejący test
 * dotykający tego kodu pośrednio (`modules/chat/chat/RollingWindow.test.ts:88`) karmi
 * sanitizer PUSTĄ tablicą `tool_calls: []`, więc trafia w skrót `validToolCalls.length === 0`
 * i nigdy nie dotyka samego predykatu filtra — podmiana `filter(tc => tc?.id &&
 * tc?.function?.name)` na `filter(tc => true)` nie ruszała ani jednego testu w repo
 * (mutacja potwierdzona dwa razy niezależnie w audycie 2026-09-01).
 */
import test from 'ava';
import { sanitizeToolTranscript } from './toolTranscriptSanitizer.js';
import type { LoopMessage } from './MessageStore.js';

/** Widok wpisu `assistant.tool_calls[]` w kształcie OpenAI — store trzyma je jako `unknown[]`. */
type StoredToolCall = { id?: string; function?: { name?: string } };

test('assistant.tool_calls: wpis BEZ id jest odsiany, poprawny sąsiad w tej samej wiadomości zostaje', (t) => {
    const messages: LoopMessage[] = [
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'call_1', function: { name: 'vault_read', arguments: '{}' } },
                { function: { name: 'vault_search', arguments: '{}' } } // brak id
            ]
        }
    ];

    const result = sanitizeToolTranscript(messages);

    const asst = result.messages.find((m) => m.role === 'assistant');
    const calls = asst?.tool_calls as StoredToolCall[];
    t.is(calls.length, 1, 'wpis bez id nie przeżył sanityzacji');
    t.is(calls[0].id, 'call_1');
    t.is(calls[0].function?.name, 'vault_read');
});

test('assistant.tool_calls: wpis BEZ function.name jest odsiany, poprawny sąsiad w tej samej wiadomości zostaje', (t) => {
    const messages: LoopMessage[] = [
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'call_1', function: { name: 'vault_read', arguments: '{}' } },
                { id: 'call_2', function: { arguments: '{}' } } // brak function.name
            ]
        }
    ];

    const result = sanitizeToolTranscript(messages);

    const asst = result.messages.find((m) => m.role === 'assistant');
    const calls = asst?.tool_calls as StoredToolCall[];
    t.is(calls.length, 1, 'wpis bez function.name nie przeżył sanityzacji');
    t.is(calls[0].id, 'call_1');
});

test('assistant.tool_calls: MIESZANKA poprawny+niepoprawny — poprawny zostaje, niepoprawny wypada, a jego wynik staje się sierotą', (t) => {
    // Kaskadowy skutek: `validToolCallIds` (bramka orphan tool) budowany jest WYŁĄCZNIE
    // z przefiltrowanych `validToolCalls`, więc wynik narzędzia po ODRZUCONYM wpisie
    // (bez `function`, więc bez `function.name`) traci swoje "call_bad" z zestawu poprawnych
    // id i sam pada jako sierota w gałęzi `role === 'tool'` wyżej w pętli.
    const messages: LoopMessage[] = [
        { role: 'user', content: 'go' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'call_ok', function: { name: 'vault_read', arguments: '{}' } },
                { id: 'call_bad' } // brak `function` w ogóle → brak function.name
            ]
        },
        { role: 'tool', content: 'wynik OK', tool_call_id: 'call_ok' },
        { role: 'tool', content: 'sierota po odrzuconym wpisie', tool_call_id: 'call_bad' }
    ];

    const result = sanitizeToolTranscript(messages);

    const asst = result.messages.find((m) => m.role === 'assistant');
    const calls = asst?.tool_calls as StoredToolCall[];
    t.is(calls.length, 1, 'tylko poprawny wpis zostaje w tool_calls tej wiadomości');
    t.is(calls[0].id, 'call_ok');

    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    t.is(toolMsgs.length, 1, 'wynik po odrzuconym wywołaniu staje się sierotą i wypada');
    t.is(toolMsgs[0].tool_call_id, 'call_ok');
    t.is(result.droppedOrphanTools, 1, 'licznik osieroconych narzędzi widzi kaskadowy skutek filtra');
});

test('pusta wiadomość (bez content, bez tool_calls, bez tool_call_id) jest odsiana', (t) => {
    const messages: LoopMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '' }, // pusty string content — brak treści
        { role: 'user', content: 'still here' }
    ];

    const result = sanitizeToolTranscript(messages);

    t.is(result.messages.length, 2, 'pusta wiadomość assistant wypadła');
    t.false(result.messages.some((m) => m.role === 'assistant'));
    t.true(result.changed);
});

test('kontrola pozytywna: wiadomość z treścią, ale bez tool_calls/tool_call_id, PRZEŻYWA sanityzację', (t) => {
    // Bez tej kontroli test wyżej mógłby przejść zwodniczo (np. filtr wywalający WSZYSTKO).
    const messages: LoopMessage[] = [
        { role: 'assistant', content: 'zwykła odpowiedź tekstowa' }
    ];
    const result = sanitizeToolTranscript(messages);
    t.is(result.messages.length, 1);
    t.is(result.messages[0].content, 'zwykła odpowiedź tekstowa');
    t.false(result.changed);
});
