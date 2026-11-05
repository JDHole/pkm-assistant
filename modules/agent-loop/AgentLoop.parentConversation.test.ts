import test from 'ava';
import { runAgentLoop, ArrayMessageStore } from './index.js';
import { ParentConversationProjection } from '../sub-agents/index.js';
import type { ParentConversationSnapshot } from '../sub-agents/index.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test('P1: równoległe delegate dostają bieżący tekst bez reasoning i bez wyników tej rundy; prompt bez zmian', async t => {
    const store = new ArrayMessageStore([{ role: 'user', content: 'Zadanie' }]);
    const held = deferred<string>();
    const captured = deferred<void>();
    const snapshots: ParentConversationSnapshot[] = [];
    const inputs: unknown[] = [];
    let round = 0;
    const run = runAgentLoop({
        model: { stream(payload, handlers) {
            inputs.push(payload.messages);
            handlers.done({ choices: [{ message: round++ === 0 ? {
                role: 'assistant', content: 'Deleguję teraz.', reasoning_content: 'PRYWATNE MYŚLENIE',
                tool_calls: [
                    { id: 'read', function: { name: 'read', arguments: '{}' } },
                    { id: 'd1', function: { name: 'delegate', arguments: '{"task":"A"}' } },
                    { id: 'd2', function: { name: 'delegate', arguments: '{"task":"B"}' } },
                ],
            } : { role: 'assistant', content: 'Gotowe.' } }] });
        } }, store, resolveTools: () => [{ name: 'read' }, { name: 'delegate' }],
        executeToolCall: (call, runtime) => {
            if (call.name === 'read') return 'RÓWNOLEGŁY WYNIK';
            const projection = new ParentConversationProjection();
            for (const message of store.messages) projection.append(message);
            snapshots.push(projection.snapshot(runtime.assistantText));
            if (snapshots.length === 2) captured.resolve();
            return held.promise;
        }, limits: { maxIterations: 2, perCallTimeoutMs: 0, stallTimeoutMs: 0 },
    });
    await captured.promise;
    const expected = { messages: [{ sequence: 1, role: 'user', text: 'Zadanie' },
        { sequence: 2, role: 'assistant', text: 'Deleguję teraz.' }],
        summary: '', keptMessages: 2, summarizedMessages: 0, omittedMessages: 0, truncated: false };
    t.deepEqual(snapshots, [expected, expected]);
    held.resolve('Przyjęto');
    const result = await run;
    t.is(result.finalText, 'Gotowe.');
    t.deepEqual(inputs, [
        [{ role: 'user', content: 'Zadanie' }],
        [
            { role: 'user', content: 'Zadanie' },
            { role: 'assistant', content: 'Deleguję teraz.', reasoning_content: 'PRYWATNE MYŚLENIE', tool_calls: [
                { id: 'read', type: 'function', function: { name: 'read', arguments: '{}' } },
                { id: 'd1', type: 'function', function: { name: 'delegate', arguments: '{"task":"A"}' } },
                { id: 'd2', type: 'function', function: { name: 'delegate', arguments: '{"task":"B"}' } },
            ] },
            { role: 'tool', tool_call_id: 'read', content: 'RÓWNOLEGŁY WYNIK' },
            { role: 'tool', tool_call_id: 'd1', content: 'Przyjęto' },
            { role: 'tool', tool_call_id: 'd2', content: 'Przyjęto' },
        ],
    ]);
    t.deepEqual(snapshots, [expected, expected]);
});
