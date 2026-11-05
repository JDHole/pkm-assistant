import test from 'ava';
import { ContextBudgetResolver } from './index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';
import type { ModelInfo } from './index.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test('P2 resolver: exact final provider/model override precedes catalog and ignores other providers', async t => {
    const clock = new QuestionTestClock();
    const resolver = new ContextBudgetResolver(clock);
    let calls = 0;
    const model = { providerId: 'open_router', modelId: 'chosen', listModels: async () => {
        calls++; return [{ id: 'chosen', max_input_tokens: 8192 }, { id: 'old', max_input_tokens: 999999 }];
    } };
    t.deepEqual(await resolver.resolve(model, { overrides: { open_router: { chosen: 4096 }, openai: { chosen: 16 } } }),
        { tokens: 4096, estimated: false, source: 'override' });
    t.is(calls, 0);
    t.deepEqual(await resolver.resolve(model, { overrides: { openai: { chosen: 16 } } }),
        { tokens: 8192, estimated: false, source: 'catalog' });
    t.deepEqual(await resolver.resolve(model), { tokens: 8192, estimated: false, source: 'catalog' });
    t.is(calls, 1);
    t.is(clock.pending, 0);
});

test('P2 resolver: missing, failed and invalid catalogs use configured or default estimate', async t => {
    const resolver = new ContextBudgetResolver(new QuestionTestClock());
    for (const value of [0, -1, NaN, Infinity, undefined]) {
        const model = { providerId: 'local', modelId: 'small', listModels: async () => [{ id: 'small', max_input_tokens: value }] };
        t.deepEqual(await resolver.resolve(model, { overrides: { local: { small: 0 } }, fallbackTokens: 2048 }),
            { tokens: 2048, estimated: true, source: 'fallback' });
    }
    t.deepEqual(await resolver.resolve({ providerId: 'local', modelId: 'missing' }),
        { tokens: 32768, estimated: true, source: 'fallback' });
    t.deepEqual(await resolver.resolve({ providerId: 'local', modelId: 'failed', listModels: () => Promise.reject(new Error('offline')) }, { fallbackTokens: -1 }),
        { tokens: 32768, estimated: true, source: 'fallback' });
});

test('P2 resolver: one bounded lookup shared by callers; late catalog cannot change frozen result', async t => {
    const clock = new QuestionTestClock();
    const resolver = new ContextBudgetResolver(clock);
    const started = deferred<void>();
    const catalog = deferred<ModelInfo[]>();
    let calls = 0;
    const model = { providerId: 'local', modelId: 'small', listModels: () => { calls++; started.resolve(); return catalog.promise; } };
    const first = resolver.resolve(model);
    const second = resolver.resolve(model, { fallbackTokens: 1024 });
    await started.promise;
    clock.advance(1500);
    t.deepEqual(await first, { tokens: 32768, estimated: true, source: 'fallback' });
    t.deepEqual(await second, { tokens: 1024, estimated: true, source: 'fallback' });
    catalog.resolve([{ id: 'small', max_input_tokens: 65536 }]);
    t.deepEqual(await resolver.resolve(model), { tokens: 32768, estimated: true, source: 'fallback' });
    t.is(calls, 1);
    t.is(clock.pending, 0);
    t.deepEqual(await resolver.resolve({ ...model, listModels: async () => [{ id: 'small', max_input_tokens: 4096 }] }),
        { tokens: 4096, estimated: false, source: 'catalog' });
});
