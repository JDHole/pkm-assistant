import test from 'ava';
import { ArrayMessageStore, runAgentLoop } from './index.js';
import type { AgentLoopPartialSnapshot, ModelResponse, RunAgentLoopOptions } from './index.js';

type Handlers = Parameters<RunAgentLoopOptions['model']['stream']>[1];
const toolResponse = (names: string[]): ModelResponse => ({
    choices: [{ message: { content: 'work started', tool_calls: names.map((name, i) => ({
        id: 'call_' + (i + 1), function: { name, arguments: '{}' },
    })) } }], usage: { prompt_tokens: 11, completion_tokens: 3 },
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}
const tick = () => new Promise<void>(r => setImmediate(r));

test('held tool: Stop publishes unknown before release and late settlement cannot continue either run', async t => {
    const entered = deferred<void>();
    const held = deferred<string>();
    const controller = new AbortController();
    const snapshots: AgentLoopPartialSnapshot[] = [];
    const store = new ArrayMessageStore([{ role: 'user', content: 'A' }]);
    let modelCalls = 0;
    let toolCalls = 0;
    let hooks = 0;
    const model = {
        stream(_payload: Record<string, unknown>, h: Handlers) {
            modelCalls++;
            h.done(toolResponse(['create_folder']));
        },
    };
    const running = runAgentLoop({
        model, store, resolveTools: () => [{ name: 'create_folder' }],
        executeToolCall: () => { toolCalls++; entered.resolve(); return held.promise; },
        limits: { maxIterations: 1 },
        shouldAbort: () => controller.signal.aborted,
        abortSignal: controller.signal,
        abortReason: () => 'manual-stop',
        callbacks: { partial: snapshot => snapshots.push(snapshot) },
        hooks: { onToolResults: () => { hooks++; } },
    });
    try {
        await entered.promise;
        controller.abort();
        t.deepEqual(snapshots[0]?.toolOutcomes, [{
            invocation: 1, id: 'call_1', name: 'create_folder',
            outcome: 'unknown', effect: 'unverified', resultPreview: '',
        }], 'Stop must publish before held executor is released');
        const result = await Promise.race([running, new Promise<null>(r => setTimeout(() => r(null), 80))]);
        t.is(result?.stoppedBy, 'abort', 'Stop settles held loop promptly');
        t.deepEqual(result?.stopReason, { kind: 'manual-stop' });
        const frozen = JSON.stringify(result);
        const bStore = new ArrayMessageStore([{ role: 'user', content: 'B' }]);
        const b = await runAgentLoop({
            model: { stream(_p, h) { h.done({ choices: [{ message: { content: 'B literal final' } }] }); } },
            store: bStore, executeToolCall: () => 'unused',
        });
        held.resolve('folder returned late');
        await tick(); await tick();
        t.is(JSON.stringify(result), frozen);
        t.is(b.finalText, 'B literal final');
        t.deepEqual(bStore.messages, [{ role: 'user', content: 'B' }]);
        t.deepEqual(store.messages, [{ role: 'user', content: 'A' }]);
        t.deepEqual([modelCalls, toolCalls, hooks, snapshots.length], [1, 1, 0, 1]);
    } finally {
        held.resolve('cleanup');
        await running;
    }
});
test('tool return survives subsequent disconnect and throwing partial observer with original cause', async t => {
    const cause = Object.assign(new Error('synthetic disconnect'), { code: 'ECONNRESET' });
    const snapshots: AgentLoopPartialSnapshot[] = [];
    let calls = 0;
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    const error = await t.throwsAsync(runAgentLoop({
        model: { stream(_p, h) { if (++calls === 1) h.done(toolResponse(['create_folder'])); else h.error(cause); } },
        store, executeToolCall: () => 'created: Notes/literal-folder',
        limits: { maxIterations: 3 },
        callbacks: { partial: snapshot => { snapshots.push(snapshot); throw new Error('observer failed'); } },
    }));
    t.is(error, cause);
    t.deepEqual(snapshots[0].stopReason, { kind: 'transport-error', stage: 'work' });
    t.deepEqual(snapshots[0].toolsUsed, ['create_folder']);
    t.deepEqual(snapshots[0].toolCallDetails, [{ name: 'create_folder', resultPreview: 'created: Notes/literal-folder' }]);
    t.deepEqual(snapshots[0].usage, { prompt_tokens: 11, completion_tokens: 3 });
    t.is(snapshots[0].toolOutcomes[0].effect, 'unverified');
    t.is(store.messages.filter(m => m.role === 'tool')[0].content, 'created: Notes/literal-folder');
});

for (const boundary of ['hook', 'store'] as const) {
    test('settled outcome survives ' + boundary + ' failure before rethrow', async t => {
        const cause = new Error(boundary + ' literal failure');
        const snapshots: AgentLoopPartialSnapshot[] = [];
        const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
        if (boundary === 'store') store.appendToolResult = () => { throw cause; };
        const error = await t.throwsAsync(runAgentLoop({
            model: { stream(_p, h) { h.done(toolResponse(['write'])); } },
            store, executeToolCall: () => 'WROTE literal file',
            hooks: boundary === 'hook' ? { onToolResults: () => { throw cause; } } : {},
            callbacks: { partial: snapshot => snapshots.push(snapshot) },
        }));
        t.is(error, cause);
        t.deepEqual(snapshots[0].stopReason, { kind: 'hook-error', stage: 'work' });
        t.is(snapshots[0].toolOutcomes[0].resultPreview, 'WROTE literal file');
        t.deepEqual(snapshots[0].toolCallDetails, [{ name: 'write', resultPreview: 'WROTE literal file' }]);
    });
}

test('parallel settlement order, Stop and accounting failure retain settled peer plus unknown held mutation', async t => {
    const entered = deferred<void>();
    const held = deferred<string>();
    const controller = new AbortController();
    const snapshots: AgentLoopPartialSnapshot[] = [];
    const cause = new Error('accounting rejected after Stop');
    const store = new ArrayMessageStore([{ role: 'user', content: 'A' }]);
    const running = runAgentLoop({
        model: { stream(_p, h) { h.done(toolResponse(['write', 'read'])); } },
        store, abortSignal: controller.signal, abortReason: () => 'task-timeout',
        executeToolCall: tc => tc.name === 'write' ? held.promise : (entered.resolve(), 'read literal result'),
        hooks: { onToolResults: async () => { throw cause; } },
        callbacks: { partial: s => snapshots.push(s) },
    });
    const rejected = t.throwsAsync(running);
    try {
        await entered.promise; await tick();
        controller.abort();
        t.deepEqual(snapshots[0].stopReason, { kind: 'task-timeout' });
        t.deepEqual(snapshots[0].toolOutcomes.map(o => [o.invocation, o.name, o.outcome, o.effect, o.resultPreview]), [
            [1, 'write', 'unknown', 'unverified', ''],
            [2, 'read', 'returned', 'unverified', 'read literal result'],
        ]);
        t.is(await rejected, cause);
        t.deepEqual(snapshots.at(-1)?.stopReason, { kind: 'hook-error', stage: 'work' });
        t.is(snapshots.at(-1)?.toolOutcomes[1].resultPreview, 'read literal result');
        t.is(store.messages.filter(m => m.role === 'tool')[0].content, 'read literal result');
        const frozen = JSON.stringify(snapshots);
        held.resolve('late write result');
        await tick();
        t.is(JSON.stringify(snapshots), frozen);
    } finally { held.resolve('cleanup'); await rejected; }
});

test('structured failure and thrown timeout retain parallel outcomes before stopping', async t => {
    const snapshots: AgentLoopPartialSnapshot[] = [];
    const timeout = Object.assign(new Error('tool deadline'), { code: 'TOOL_TIMEOUT' });
    let calls = 0;
    const result = await runAgentLoop({
        model: { stream(_p, h) {
            if (++calls === 1) h.done(toolResponse(['write', 'external', 'other', 'thrower', 'timeout']));
            else throw new Error('model called after uncertain tool outcome');
        } },
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        executeToolCall: tc => {
            if (tc.name === 'write') return { success: false, error: 'denied' };
            if (tc.name === 'external') return { isError: true, error: 'external failed' };
            if (tc.name === 'other') return { error: 'explicit failure' };
            if (tc.name === 'thrower') throw new Error('tool threw');
            throw timeout;
        },
        callbacks: { partial: s => snapshots.push(s) },
    });
    t.deepEqual(snapshots[0].toolOutcomes.map(o => [o.name, o.outcome, o.effect]), [
        ['write', 'error', 'unverified'], ['external', 'error', 'unverified'],
        ['other', 'error', 'unverified'], ['thrower', 'error', 'unverified'], ['timeout', 'unknown', 'unverified'],
    ]);
    t.deepEqual(snapshots[0].stopReason, { kind: 'tool-uncertain' });
    t.deepEqual(result.stopReason, { kind: 'tool-uncertain' });
    t.is(calls, 1);
});

test('uncertain write timeout blocks a repeated mutation before state verification', async t => {
    const appendArgs = JSON.stringify({ path: 'Notes/log.md', content: 'line\n' });
    const timeout = Object.assign(new Error('tool deadline after committed write'), { code: 'ETIMEDOUT' });
    const store = new ArrayMessageStore([{ role: 'user', content: 'Append one line to Notes/log.md' }]);
    let modelCalls = 0;
    let writeCalls = 0;
    let stateReads = 0;
    let fileContent = '';

    const result = await runAgentLoop({
        model: { stream(_payload, handlers) {
            modelCalls++;
            handlers.done({ choices: [{ message: { content: '', tool_calls: [{
                id: 'call_' + modelCalls,
                function: { name: 'append_to_file', arguments: appendArgs },
            }] } }] });
        } },
        store,
        resolveTools: () => [{ name: 'append_to_file' }, { name: 'read_file' }],
        executeToolCall: tc => {
            if (tc.name === 'read_file') { stateReads++; return fileContent; }
            if (tc.name !== 'append_to_file' || tc.arguments !== appendArgs) throw new Error('unexpected tool call');
            writeCalls++;
            fileContent += 'line\n';
            if (writeCalls === 1) throw timeout;
            return 'appended';
        },
        limits: { maxIterations: 2, synthesisTimeoutMs: 0 },
    });

    t.is(result.partial?.toolOutcomes[0].outcome, 'unknown');
    t.is(stateReads, 0);
    t.is(writeCalls, 1);
    t.is(fileContent, 'line\n');
});

test('uncertain orphaned tool call requires state verification', async t => {
    const timeout = Object.assign(new Error('write may have committed'), { code: 'ETIMEDOUT' });
    let modelCalls = 0;
    let writeCalls = 0;
    const result = await runAgentLoop({
        model: { stream(_payload, handlers) {
            modelCalls++;
            handlers.done({ tool_calls: [{ function: { name: 'append_to_file', arguments: '{}' } }] });
        } },
        store: new ArrayMessageStore([{ role: 'user', content: 'Append once' }]),
        executeToolCall: () => { writeCalls++; throw timeout; },
        limits: { maxIterations: 2, synthesisTimeoutMs: 0 },
    });

    t.is(writeCalls, 1);
    t.is(modelCalls, 1);
    t.is(result.stoppedBy, 'backstop');
    t.deepEqual(result.stopReason, { kind: 'tool-uncertain' });
    if (!result.partial) return t.fail('missing partial report');
    t.deepEqual(result.partial.stopReason, { kind: 'tool-uncertain' });
    t.deepEqual(result.partial.toolOutcomes.map(o => [o.id, o.name, o.outcome]), [
        [undefined, 'append_to_file', 'unknown'],
    ]);
    t.is(result.finalText, result.partial.text);
    t.regex(result.finalText, /verify state|sprawdź stan/);
});

test('snapshot masks known secrets before clipping, omits payloads and keeps identities after preview budget', async t => {
    const secret = 'unique unknown plain secret';
    const snapshots: AgentLoopPartialSnapshot[] = [];
    const result = await runAgentLoop({
        model: { stream(_p, h) { h.done(toolResponse(Array.from({ length: 20 }, (_, i) => 'tool_' + i))); } },
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        knownSecrets: [secret],
        executeToolCall: () => ({
            content: 'readable '.repeat(1400) + secret,
            authorization: 'Bearer PATTERN_SECRET_LITERAL_12345',
            args: 'ARG_SENTINEL', reasoning_content: 'REASON_SENTINEL',
            payload: 'RAW_SENTINEL', binary: 'BINARY_SENTINEL', data: 'BASE64_SENTINEL',
            blocks: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,IMAGE_SENTINEL' } }],
        }),
        limits: { maxIterations: 1, synthesisTimeoutMs: 0 },
        callbacks: { partial: s => {
            snapshots.push(s);
            // A hostile observer cannot modify any object shared with the return value.
            s.toolOutcomes[0].resultPreview = 'observer mutation';
        } },
    });
    const snapshot = result.partial!;
    t.is(snapshot.toolOutcomes.length, 20);
    t.deepEqual(snapshot.toolOutcomes.at(-1), {
        invocation: 20, id: 'call_20', name: 'tool_19', outcome: 'returned', effect: 'unverified', resultPreview: '',
    });
    t.regex(snapshot.toolOutcomes[0].resultPreview, /readable readable/);
    t.is(snapshot.revision, 1, 'same skipped snapshot is idempotent');
    t.is(snapshots.length, 1);
    const visible = JSON.stringify(snapshot);
    for (const sentinel of [secret, 'PATTERN_SECRET_LITERAL_12345', 'ARG_SENTINEL', 'REASON_SENTINEL', 'RAW_SENTINEL', 'BINARY_SENTINEL', 'BASE64_SENTINEL', 'IMAGE_SENTINEL', 'observer mutation']) {
        t.false(visible.includes(sentinel), sentinel);
    }
    const chars = snapshot.lastText.length + snapshot.text.length
        + snapshot.toolOutcomes.reduce((n, o) => n + o.resultPreview.length, 0)
        + snapshot.toolCallDetails.reduce((n, d) => n + d.resultPreview.length, 0);
    t.true(chars <= 12000, 'all displayed strings share the total budget');
});

test.serial('rejected async partial observer is observed and leaves original rejection intact', async t => {
    const cause = new Error('original model error');
    const unhandled: unknown[] = [];
    const observe = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', observe);
    try {
        const error = await t.throwsAsync(runAgentLoop({
            model: { stream(_p, h) { h.error(cause); } },
            store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
            executeToolCall: () => 'unused',
            callbacks: { partial: () => Promise.reject(new Error('observer async failed')) },
        }));
        t.is(error, cause);
        await tick(); await tick();
        t.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', observe); }
});

test('known literal secret crossing clipping boundary is redacted before clipping', async t => {
    const prefix = 'line '.repeat(395);
    const secret = 'plain unusual secret value';
    const result = await runAgentLoop({
        model: { stream(_p, h) { h.done(toolResponse(['read'])); } },
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        knownSecrets: [secret], executeToolCall: () => prefix + secret,
        limits: { maxIterations: 1, synthesisTimeoutMs: 0 },
    });
    t.is(result.partial?.toolOutcomes[0].resultPreview, prefix + '[REDACTED]');
});

test('native consumer supplies a structured silence cause without losing its stage', async t => {
    const controller = new AbortController(); let stops = 0;
    const running = runAgentLoop({
        model: { stream() {}, stopStream() { stops++; } },
        store: new ArrayMessageStore([{ role: 'user', content: 'synthetic' }]), executeToolCall: () => 'unused',
        abortSignal: controller.signal, abortReason: () => ({ kind: 'silence', stage: 'work' }),
    });
    await tick(); controller.abort();
    const result = await running;
    t.deepEqual(result.stopReason, { kind: 'silence', stage: 'work' });
    t.is(stops, 1);
});
