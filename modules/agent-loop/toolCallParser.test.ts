import test from 'ava';
import { parseToolCalls, splitConcatenatedToolCalls } from './toolCallParser.js';
import type { ParsedToolCall } from './toolCallParser.js';

// ─── 3 kształty odpowiedzi ───

test('parseToolCalls: Anthropic content-blocks (type tool_use)', (t) => {
    const response = {
        content: [
            { type: 'text', text: 'thinking...' },
            { type: 'tool_use', id: 'toolu_1', name: 'vault_read', input: { path: 'a.md' } }
        ]
    };
    const calls = parseToolCalls(response);
    t.is(calls.length, 1);
    t.deepEqual(calls[0], { id: 'toolu_1', name: 'vault_read', arguments: { path: 'a.md' } });
});

test('parseToolCalls: root tool_calls (OpenAI bez choices)', (t) => {
    const response = {
        tool_calls: [
            { id: 'call_1', function: { name: 'vault_search', arguments: '{"query":"x"}' } }
        ]
    };
    const calls = parseToolCalls(response);
    t.is(calls.length, 1);
    t.is(calls[0].id, 'call_1');
    t.is(calls[0].name, 'vault_search');
    t.is(calls[0].arguments, '{"query":"x"}');
});

test('parseToolCalls: choices[0].message.tool_calls (najczęstsza ścieżka)', (t) => {
    const response = {
        choices: [{ message: { tool_calls: [
            { id: 'call_9', function: { name: 'memory_read', arguments: '{"filename":"user_x.md"}' } }
        ] } }]
    };
    const calls = parseToolCalls(response);
    t.is(calls.length, 1);
    t.is(calls[0].id, 'call_9');
    t.is(calls[0].name, 'memory_read');
});

test('parseToolCalls: brak tool calls → pusta tablica', (t) => {
    t.deepEqual(parseToolCalls({ choices: [{ message: { content: 'hi' } }] }), []);
    t.deepEqual(parseToolCalls({}), []);
    t.deepEqual(parseToolCalls(null), []);
});

test('parseToolCalls: choices bez id nadaje fallback call_*', (t) => {
    const calls = parseToolCalls({ choices: [{ message: { tool_calls: [
        { function: { name: 'vault_list', arguments: '{}' } }
    ] } }] });
    t.is(calls.length, 1);
    t.true((calls[0].id as string).startsWith('call_'));
    t.is(calls[0].name, 'vault_list');
});

test('parseToolCalls: DWA tool_calls bez id w JEDNEJ odpowiedzi dostają RÓŻNE syntetyczne id (AUD-testy-053)', (t) => {
    // Kolizja slotów: dostawca OpenAI-shape z indeksami, ale bez id (typowy artefakt mostu
    // LM Studio/Ollama) — goły `call_${Date.now()}` dawał IDENTYCZNY fallback dla obu wywołań
    // w tej samej milisekundzie (pętla synchroniczna), więc dwa różne wyniki narzędzi lądowały
    // pod tym samym tool_call_id w store i w payloadzie do dostawcy.
    const calls = parseToolCalls({ choices: [{ message: { tool_calls: [
        { function: { name: 'tool_a', arguments: '{}' } },
        { function: { name: 'tool_b', arguments: '{}' } }
    ] } }] });
    t.is(calls.length, 2, 'oba wywołania przeżywają');
    t.true((calls[0].id as string).startsWith('call_'));
    t.true((calls[1].id as string).startsWith('call_'));
    t.not(calls[0].id, calls[1].id, 'syntetyczne id NIE mogą kolidować');
    t.is(calls[0].name, 'tool_a');
    t.is(calls[1].name, 'tool_b');
});

// ─── Odsklejanie DeepSeek ───

test('parseToolCalls: DeepSeek concat — "vault_readvault_read" → 2 wywołania', (t) => {
    const response = {
        choices: [{ message: { tool_calls: [
            { id: 'call_x', function: { name: 'vault_readvault_read', arguments: '{"path":"a.md"}{"path":"b.md"}' } }
        ] } }]
    };
    const calls = parseToolCalls(response, { knownToolNames: ['vault_read', 'vault_search'] });
    t.is(calls.length, 2);
    t.is(calls[0].name, 'vault_read');
    t.is(calls[1].name, 'vault_read');
    t.is(calls[0].arguments, '{"path":"a.md"}');
    t.is(calls[1].arguments, '{"path":"b.md"}');
    t.is(calls[0].id, 'call_x');
    t.is(calls[1].id, 'call_x_split1');
});

test('parseToolCalls: bez knownToolNames nie odskleja (przepuszcza)', (t) => {
    const response = {
        choices: [{ message: { tool_calls: [
            { id: 'c', function: { name: 'foobar', arguments: '{}' } }
        ] } }]
    };
    const calls = parseToolCalls(response);
    t.is(calls.length, 1);
    t.is(calls[0].name, 'foobar');
});

test('parseToolCalls: isToolKnown predykat wygrywa nad listą', (t) => {
    const response = {
        choices: [{ message: { tool_calls: [
            { id: 'c', function: { name: 'weird_tool', arguments: '{}' } }
        ] } }]
    };
    // znane wg predykatu → brak próby dekompozycji
    const calls = parseToolCalls(response, { knownToolNames: [], isToolKnown: (n) => n === 'weird_tool' });
    t.is(calls.length, 1);
    t.is(calls[0].name, 'weird_tool');
});

test('splitConcatenatedToolCalls: znana nazwa przechodzi bez zmian', (t) => {
    const input = [{ id: '1', name: 'vault_read', arguments: '{"path":"a.md"}' }];
    const out = splitConcatenatedToolCalls(input, ['vault_read']);
    t.deepEqual(out, input);
});

test('splitConcatenatedToolCalls: 3× sklejone → 3 wywołania z osobnymi argumentami', (t) => {
    const input = [{ id: 'z', name: 'minion_taskminion_taskminion_task', arguments: '{"a":1}{"b":2}{"c":3}' }];
    // Zwrotka typowana jako `ParsedToolCall[] | null | undefined` (pass-through wejścia na ścieżce
    // fail-safe); tutaj wejściem jest niepusta tablica, więc wynik jest tablicą — stąd asercja.
    const out = splitConcatenatedToolCalls(input, ['minion_task']) as ParsedToolCall[];
    t.is(out.length, 3);
    t.deepEqual(out.map((c) => c.name), ['minion_task', 'minion_task', 'minion_task']);
    t.is(out[0].arguments, '{"a":1}');
    t.is(out[2].arguments, '{"c":3}');
});

test('splitConcatenatedToolCalls: pusta/niepoprawna lista → zwraca wejście', (t) => {
    t.deepEqual(splitConcatenatedToolCalls([], ['x']), []);
    t.is(splitConcatenatedToolCalls(null, ['x']), null);
});
