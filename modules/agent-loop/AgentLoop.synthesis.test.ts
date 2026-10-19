
import test from 'ava';
import { runAgentLoop, ArrayMessageStore, formatAgentLoopPartial } from './index.js';
import type { AgentLoopPartialSnapshot, RunAgentLoopOptions, ModelResponse } from './index.js';
import { ChatModel, CHAT_PROVIDERS } from '../models/index.js';
import type { ChatModelDeps } from '../models/index.js';

type Handlers = Parameters<RunAgentLoopOptions['model']['stream']>[1];
const resultText = (content: string): ModelResponse => ({ choices: [{ message: { content } }] });
const tools: ModelResponse = {
    choices: [{ message: { content: 'work literal', tool_calls: [{ id: 'folder', function: { name: 'create_folder', arguments: '{}' } }] } }],
    usage: { prompt_tokens: 9, completion_tokens: 2 },
};
const store = () => new ArrayMessageStore([{ role: 'user', content: 'go' }]);
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

test('held synthesis publishes literal work before awaited backstop hook and has no tools', async t => {
    const entered = deferred<void>();
    const hook = deferred<void>();
    const synthesis = deferred<Handlers>();
    const snapshots: AgentLoopPartialSnapshot[] = [];
    const events: string[] = [];
    const payloads: Record<string, unknown>[] = [];
    const running = runAgentLoop({
        model: { stream(p, h) { payloads.push(p); if (payloads.length === 1) h.done(tools); else synthesis.resolve(h); } },
        store: store(), resolveTools: () => [{ name: 'create_folder' }],
        executeToolCall: () => 'folder tool returned Notes/literal',
        limits: { maxIterations: 1, synthesisTimeoutMs: 500 },
        hooks: { onBackstop: () => { events.push('hook'); entered.resolve(); return hook.promise; } },
        callbacks: { partial: s => { snapshots.push(s); events.push('partial'); } },
    });
    await entered.promise;
    t.deepEqual(events, ['partial', 'hook']);
    t.deepEqual(snapshots[0].stopReason, { kind: 'iteration-limit' });
    t.is(snapshots[0].synthesis, 'pending');
    t.deepEqual(snapshots[0].toolOutcomes, [{
        invocation: 1, id: 'folder', name: 'create_folder', outcome: 'returned',
        effect: 'unverified', resultPreview: 'folder tool returned Notes/literal',
    }]);
    t.is(payloads.length, 1, 'observer runs before a held backstop hook or synthesis call');
    const firstFrozen = JSON.stringify(snapshots[0]);
    hook.resolve();
    const handlers = await synthesis.promise;
    t.is(payloads[1].tools, undefined);
    t.regex(formatAgentLoopPartial(snapshots[0]), /folder tool returned Notes\/literal/);
    handlers.done(resultText('final literal synthesis'));
    const result = await running;
    t.is(result.finalText, 'final literal synthesis');
    t.deepEqual(result.stopReason, { kind: 'iteration-limit' });
    t.is(result.partial?.synthesis, 'completed');
    t.is(result.partial?.revision, 2);
    t.is(JSON.stringify(snapshots[0]), firstFrozen);
});

test('synthesis total budget expires despite semantic chunks and beats synchronous induced abort', async t => {
    let calls = 0;
    let stopped = 0;
    let held!: Handlers;
    const snapshots: AgentLoopPartialSnapshot[] = [];
    let interval: ReturnType<typeof setInterval> | undefined;
    const result = await runAgentLoop({
        model: {
            stream(_p, h) {
                if (++calls === 1) { h.done(tools); return; }
                held = h;
                // Pierwsza porcja od razu: przed końcem budżetu zawsze jest co najmniej jedna.
                h.chunk(resultText('synthesis is working'));
                interval = setInterval(() => h.chunk(resultText('synthesis is working')), 4);
            },
            stopStream() {
                stopped++;
                clearInterval(interval);
                held.error(Object.assign(new Error('induced Stop'), { _aborted: true }));
            },
        },
        store: store(), executeToolCall: () => 'folder completed response',
        // Strażnik ciszy dłuższy niż budżet: pod obciążeniem porcje z setInterval przychodzą
        // z opóźnieniem i przy 25 ms cisza wygrywała z budżetem 35 ms (test badał budżet, nie ciszę).
        limits: { maxIterations: 1, synthesisTimeoutMs: 35, perCallTimeoutMs: 200, stallTimeoutMs: 1000 },
        callbacks: { partial: s => snapshots.push(s) },
    });
    t.is(result.stoppedBy, 'backstop');
    t.deepEqual(result.stopReason, { kind: 'synthesis-budget', budgetMs: 35, after: 'iteration-limit' });
    t.is(result.partial?.synthesis, 'budget-expired');
    t.is(snapshots[0].toolOutcomes[0].resultPreview, 'folder completed response');
    t.is(stopped, 1);
    t.regex(result.finalText, /folder completed response/);
    t.deepEqual(result.partial?.usage, { prompt_tokens: 9, completion_tokens: 2 });
});

test('synthesis queue admission cannot extend total budget; zero skips optional request', async t => {
    let calls = 0;
    let stops = 0;
    let queueTimer: ReturnType<typeof setTimeout> | undefined;
    const queued = await runAgentLoop({
        model: {
            stream(_p, h) {
                if (++calls === 1) h.done(tools);
                else queueTimer = setTimeout(() => h.gate_admitted?.(), 15);
            },
            stopStream() { stops++; clearTimeout(queueTimer); },
        }, store: store(), executeToolCall: () => 'queue result',
        limits: { maxIterations: 1, synthesisTimeoutMs: 25, perCallTimeoutMs: 100 },
    });
    t.deepEqual(queued.stopReason, { kind: 'synthesis-budget', budgetMs: 25, after: 'iteration-limit' });
    t.deepEqual([calls, stops], [2, 1]);
    calls = 0;
    const skipped = await runAgentLoop({
        model: { stream(_p, h) { calls++; h.done(tools); } }, store: store(), executeToolCall: () => 'skip literal result',
        limits: { maxIterations: 1, synthesisTimeoutMs: 0 },
    });
    t.is(calls, 1);
    t.deepEqual(skipped.stopReason, { kind: 'iteration-limit' });
    t.is(skipped.partial?.synthesis, 'skipped');
    t.regex(skipped.finalText, /skip literal result/);
});

for (const reason of ['manual-stop', 'task-timeout', 'superseded'] as const) {
    for (const phase of ['queue', 'synthesis'] as const) {
        test('signal Stop during ' + phase + ' retains ' + reason + ' and closes callbacks', async t => {
            const controller = new AbortController();
            const entered = deferred<Handlers>();
            const snapshots: AgentLoopPartialSnapshot[] = [];
            let calls = 0;
            let stops = 0;
            let chunks = 0;
            let admits = 0;
            const running = runAgentLoop({
                model: { stream(_p, h) {
                    calls++;
                    if (phase === 'synthesis' && calls === 1) h.done(tools);
                    else entered.resolve(h);
                }, stopStream() { stops++; } },
                store: store(), executeToolCall: () => 'completed before Stop',
                abortSignal: controller.signal, abortReason: () => reason,
                limits: { maxIterations: 1, synthesisTimeoutMs: 500 },
                callbacks: { partial: s => snapshots.push(s), chunk: () => { chunks++; } },
                onGateAdmitted: () => { admits++; },
            });
            const handlers = await entered.promise;
            controller.abort();
            const result = await running;
            t.deepEqual(result.stopReason, { kind: reason });
            t.is(result.stoppedBy, 'abort');
            t.deepEqual(snapshots.at(-1)?.stopReason, { kind: reason });
            if (phase === 'synthesis') t.is(result.partial?.toolOutcomes[0].resultPreview, 'completed before Stop');
            handlers.chunk(resultText('late'));
            handlers.done(resultText('late done'));
            handlers.error(new Error('late error'));
            handlers.gate_admitted?.();
            t.deepEqual([stops, chunks, admits], [1, 0, 0]);
        });
    }
}

test('synthesis provider error rejects with identity and publishes failed retained work', async t => {
    const cause = new Error('synthesis provider refused');
    const snapshots: AgentLoopPartialSnapshot[] = [];
    let calls = 0;
    const error = await t.throwsAsync(runAgentLoop({
        model: { stream(_p, h) { if (++calls === 1) h.done(tools); else h.error(cause); } },
        store: store(), executeToolCall: () => 'tool literal completed',
        limits: { maxIterations: 1 },
        callbacks: { partial: s => { snapshots.push(s); return Promise.reject(new Error('duplicate observer failure')); } },
    }));
    t.is(error, cause);
    t.deepEqual(snapshots.at(-1)?.stopReason, { kind: 'model-error', stage: 'synthesis' });
    t.is(snapshots.at(-1)?.synthesis, 'failed');
    t.is(snapshots.at(-1)?.toolOutcomes[0].resultPreview, 'tool literal completed');
});

test('ordinary healthy slow call outlives synthesis budget and late success callbacks are inert without timers', async t => {
    let held!: Handlers;
    let chunks = 0;
    let admits = 0;
    let stops = 0;
    const result = await runAgentLoop({
        model: { stream(_p, h) { held = h; setTimeout(() => h.done(resultText('ordinary slow literal')), 35); }, stopStream() { stops++; } },
        store: store(), executeToolCall: () => 'unused',
        limits: { synthesisTimeoutMs: 5 },
        callbacks: { chunk: () => { chunks++; } }, onGateAdmitted: () => { admits++; },
    });
    t.is(result.finalText, 'ordinary slow literal');
    t.deepEqual(result.stopReason, { kind: 'natural' });
    held.chunk(resultText('late')); held.done(resultText('late done')); held.error(new Error('late')); held.gate_admitted?.();
    await pause(15);
    t.deepEqual([chunks, admits, stops], [0, 0, 0]);
});

test('deadline and typed silence errors publish distinct reasons; late callbacks cannot rearm timers', async t => {
    for (const limits of [{ perCallTimeoutMs: 15 }, { stallTimeoutMs: 15 }]) {
        let held!: Handlers;
        let stopped = 0;
        let chunks = 0;
        let admits = 0;
        const snapshots: AgentLoopPartialSnapshot[] = [];
        const error = await t.throwsAsync(runAgentLoop({
            model: { stream(_p, h) { held = h; }, stopStream() { stopped++; held.error(Object.assign(new Error('induced abort'), { _aborted: true })); } },
            store: store(), executeToolCall: () => 'unused', limits,
            callbacks: { partial: s => snapshots.push(s), chunk: () => { chunks++; } },
            onGateAdmitted: () => { admits++; },
        }));
        t.regex(error!.message, /timeout|watchdog/i);
        t.deepEqual(snapshots[0].stopReason, { kind: 'perCallTimeoutMs' in limits ? 'model-timeout' : 'silence', stage: 'work' });
        held.chunk(resultText('late')); held.done(resultText('late')); held.error(new Error('late')); held.gate_admitted?.();
        await pause(25);
        t.deepEqual([stopped, chunks, admits], [1, 0, 0]);
    }
});

test('actual ChatModel xAI complete path survives silent work within ordinary deadline', async t => {
    const body = JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'xAI complete literal' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    const deps: ChatModelDeps = {
        provider: CHAT_PROVIDERS.xai,
        settings: {},
        ctx: { modelId: 'fixture', apiKey: 'offline-test-key', log: { debug() {}, info() {}, warn() {}, error() {}, model() {} } },
        http: { async send() { await pause(40); return { status: 200, headers: {}, text: body, json<T>() { return JSON.parse(body) as T; } }; } },
        transport: { open() { throw new Error('complete provider must use HTTP complete path'); } },
        gate: { acquireSlot() { return { admitted: Promise.resolve(true), queued: false, cancel() {}, release() {} }; } },
    };
    const model = new ChatModel(deps);
    const received: string[] = [];
    const result = await runAgentLoop({
        model: model as RunAgentLoopOptions['model'], store: store(), executeToolCall: () => 'unused',
        limits: { stallTimeoutMs: 10, perCallTimeoutMs: 150, synthesisTimeoutMs: 5 },
        callbacks: { chunk: r => received.push(JSON.stringify(r)) },
    });
    t.is(model.providerId, 'xai', 'complete exception reads actual public metadata');
    t.is(result.finalText, 'xAI complete literal');
    t.deepEqual(result.stopReason, { kind: 'natural' });
    t.is(received.length, 1, 'emulated model emits the completed snapshot once');
});

test('heartbeat-only activity stays separate and ordinary deadline is not a transport health verdict', async t => {
    let transportBeats = 0;
    let semanticChunks = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const snapshots: AgentLoopPartialSnapshot[] = [];
    const error = await t.throwsAsync(runAgentLoop({
        model: { stream() { interval = setInterval(() => { transportBeats++; }, 3); }, stopStream() { clearInterval(interval); } },
        store: store(), executeToolCall: () => 'unused',
        limits: { perCallTimeoutMs: 25, stallTimeoutMs: 0 },
        callbacks: { partial: s => snapshots.push(s), chunk: () => { semanticChunks++; } },
    }));
    t.regex(error!.message, /timeout/i);
    t.true(transportBeats > 0);
    t.is(semanticChunks, 0);
    t.deepEqual(snapshots[0].stopReason, { kind: 'model-timeout', stage: 'work' });
});

test('reentrant partial observer starts B after Stop has already stopped owned A', async t => {
    const entered = deferred<void>();
    const controller = new AbortController();
    const stopped: string[] = [];
    let active = '';
    let activeHandlers!: Handlers;
    let bError = false;
    const b = deferred<ModelResponse>();
    const model = {
        stream(p: Record<string, unknown>, h: Handlers) {
            active = String(p.owner ?? 'A');
            activeHandlers = h;
            if (active === 'A') entered.resolve();
        },
        stopStream() {
            stopped.push(active);
            activeHandlers.error(Object.assign(new Error('stopped ' + active), { _aborted: true }));
        },
    };
    const running = runAgentLoop({
        model, store: store(), executeToolCall: () => 'unused', abortSignal: controller.signal,
        callbacks: { partial: () => model.stream({ owner: 'B' }, {
            chunk() {}, done: r => b.resolve(r), error: () => { bError = true; },
        }) },
    });
    await entered.promise;
    controller.abort();
    const result = await running;
    t.deepEqual(result.stopReason, { kind: 'manual-stop' });
    t.deepEqual(stopped, ['A']);
    t.false(bError);
    activeHandlers.done(resultText('B final literal'));
    t.deepEqual(await b.promise, resultText('B final literal'));
});

test('timeout stops owned stream before a reentrant trace callback starts B', async t => {
    const stopped: string[] = [];
    let active = '';
    let handlers!: Handlers;
    let bError = false;
    const b = deferred<ModelResponse>();
    const model = {
        stream(p: Record<string, unknown>, h: Handlers) { active = String(p.owner ?? 'A'); handlers = h; },
        stopStream() { stopped.push(active); handlers.error(Object.assign(new Error('induced abort'), { _aborted: true })); },
    };
    const error = await t.throwsAsync(runAgentLoop({
        model, store: store(), executeToolCall: () => 'unused', limits: { perCallTimeoutMs: 15 },
        trace: type => { if (type === 'model.timeout') model.stream({ owner: 'B' }, {
            chunk() {}, done: r => b.resolve(r), error: () => { bError = true; },
        }); },
    }));
    t.regex(error!.message, /timeout/i);
    t.deepEqual(stopped, ['A']);
    t.false(bError);
    handlers.done(resultText('B after deadline'));
    t.deepEqual(await b.promise, resultText('B after deadline'));
});
