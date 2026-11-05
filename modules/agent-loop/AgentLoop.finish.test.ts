import test from 'ava';
import { ArrayMessageStore, runAgentLoop } from './index.js';
import type { RunAgentLoopOptions } from './index.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
for (const exit of ['text', 'filtered', 'orphan'] as const) test(`beforeFinish guards natural ${exit} exit in the same loop`, async t => {
    const entered = deferred<void>();
    const barrier = deferred<'finish' | 'continue'>();
    const payloads: unknown[] = [];
    const store = new ArrayMessageStore([{ role: 'user', content: 'task' }]);
    let finishes = 0;
    const run = runAgentLoop({
        model: { stream(payload, handlers) {
            payloads.push(structuredClone(payload));
            if (payloads.length === 1 && exit === 'orphan') {
                handlers.done({ tool_calls: [{ function: { name: 'read', arguments: '{}' } }] });
                return;
            }
            handlers.done({ choices: [{ message: payloads.length === 1 && exit !== 'text'
                ? { content: 'premature', tool_calls: [{ ...(exit === 'filtered' ? { id: 'call' } : {}), function: { name: 'read', arguments: '{}' } }] }
                : { content: payloads.length === 1 ? 'premature' : 'final answer' } }] });
        } }, store, resolveTools: () => [{ name: 'read' }], executeToolCall: () => 'material',
        hooks: {
            ...(exit === 'filtered' ? { onToolCallsParsed: () => [] } : {}),
            beforeFinish: async () => {
                finishes++;
                if (finishes > 1) return 'finish';
                entered.resolve();
                return await barrier.promise;
            },
        }, limits: { maxIterations: 3 },
    });
    await entered.promise;
    t.deepEqual([payloads.length, finishes], [1, 1]);
    store.appendUser('child result');
    barrier.resolve('continue');
    const result = await run;
    t.deepEqual([result.finalText, result.iterations, result.stoppedBy, payloads.length, finishes], ['final answer', 2, 'natural', 2, 2]);
    t.deepEqual((payloads[1] as { messages: unknown }).messages, [{ role: 'user', content: 'task' }, { role: 'user', content: 'child result' }]);
});

test('beforeFinish continuation consumes iteration budget and Stop prevents the next model', async t => {
    for (const stop of [false, true]) {
        const entered = deferred<void>();
        const barrier = deferred<'finish' | 'continue'>();
        const ctl = new AbortController();
        let streams = 0;
        let backstops = 0;
        const run = runAgentLoop({ model: { stream(_payload, handlers: Parameters<RunAgentLoopOptions['model']['stream']>[1]) {
            streams++; handlers.done({ choices: [{ message: { content: 'premature' } }] });
        } }, store: new ArrayMessageStore([{ role: 'user', content: 'task' }]), executeToolCall: () => '',
        abortSignal: ctl.signal,
        hooks: { beforeFinish: () => { entered.resolve(); return barrier.promise; }, onBackstop: () => { backstops++; } },
        limits: { maxIterations: 1, synthesisTimeoutMs: 0 } });
        await entered.promise;
        if (stop) ctl.abort();
        barrier.resolve('continue');
        const result = await run;
        t.deepEqual([result.stoppedBy, streams, backstops, result.iterations], stop ? ['abort', 1, 0, 1] : ['backstop', 1, 1, 1]);
    }
});
