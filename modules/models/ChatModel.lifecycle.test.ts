/** Request lifecycle regressions: real gate admission and reentrant consumer callbacks. */
import test from 'ava';
import { ChatModel } from './ChatModel.js';
import { OpenAiProvider } from './providers/openai.js';
import { LmStudioProvider } from './providers/lm_studio.js';
import { XaiProvider } from './providers/xai.js';
import { acquireSlot, gateSnapshot, __test__ as gateTest } from './requestGate.js';
import { CapturingHttpClient, makeCtx, makeSettings } from './testing/harness.js';
import type {
    ChatModelDeps, ChatProviderInfo, ChatRequest, HttpRequestSpec, ModelStreamActivity,
    OpenAiCompletion, RequestGateLike, StreamOpenResult, StreamSink, StreamTransport,
} from './contracts.js';

class LocalProvider extends OpenAiProvider {
    override get info(): ChatProviderInfo { return { ...super.info, id: 'lm_studio', local: true }; }
}
class ImmediateModel extends ChatModel {
    static override scheduleGateRelease(fn: () => void, _ms: number): void { fn(); }
}

/** Ignores abort deliberately; an abandoned transport must not hold the owner's inner task. */
class HeldTransport implements StreamTransport {
    sinks: StreamSink[] = [];
    signals: AbortSignal[] = [];
    resolvers: Array<(result: StreamOpenResult) => void> = [];
    open(_spec: HttpRequestSpec, sink: StreamSink, signal: AbortSignal): Promise<StreamOpenResult> {
        this.sinks.push(sink);
        this.signals.push(signal);
        return new Promise(resolve => { this.resolvers.push(resolve); });
    }
}

const req = (text = 'lifecycle'): ChatRequest => ({ messages: [{ role: 'user', content: text }] });
const frame = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';
const CLOSED: StreamOpenResult = { status: 200, headers: {}, body: '' };
const completion = (text: string) => ({ body: { choices: [{ index: 0, message: { role: 'assistant', content: text } }], usage: {} } });
const models: ChatModel[] = [];
const drain = async (): Promise<void> => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

function make(transport: StreamTransport = new HeldTransport(), overrides: Partial<ChatModelDeps> = {}): ChatModel {
    const model = new ImmediateModel({
        provider: new LocalProvider(), ctx: makeCtx(), http: new CapturingHttpClient(), transport,
        gate: { acquireSlot }, settings: makeSettings({ limits: { local_platform_max_concurrent: 1 } }), ...overrides,
    });
    models.push(model);
    return model;
}

function countedGate(): RequestGateLike & { releases: number[] } {
    const releases: number[] = [];
    return { releases, acquireSlot(key, limit, options) {
        const ticket = acquireSlot(key, limit, options);
        const index = releases.push(0) - 1;
        return { ...ticket, release() { releases[index]++; ticket.release(); } };
    } };
}

interface Cancellation extends Error { _aborted?: boolean; _superseded?: boolean; _queueCancelled?: boolean }
type Outcome = { kind: 'ok'; value: OpenAiCompletion } | { kind: 'error'; error: Cancellation } | { kind: 'pending' };
function observe(promise: Promise<OpenAiCompletion>): Promise<Outcome> {
    return promise.then(value => ({ kind: 'ok', value }), (error: Cancellation) => ({ kind: 'error', error }));
}
async function within(promise: Promise<Outcome>): Promise<Outcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<Outcome>(resolve => { timer = setTimeout(() => resolve({ kind: 'pending' }), 100); })]);
    } finally { clearTimeout(timer); }
}
function terminal(events: ModelStreamActivity[]): string[] {
    return events.filter(e => e.event === 'completed' || e.event === 'cancelled' || e.event === 'failed').map(e => e.event);
}

/** Observe the real inner promise without changing product code or replacing its logic. */
function innerExits(model: ChatModel): string[] {
    type Run = (...args: unknown[]) => Promise<void>;
    const observedModel = model as unknown as { _runTurn: Run };
    const original = observedModel._runTurn.bind(model);
    const exited: string[] = [];
    observedModel._runTurn = (owner, ...args) => {
        const promise = original(owner, ...args);
        const requestId = (owner as { requestId: string }).requestId;
        void promise.then(() => exited.push(requestId), () => exited.push(requestId));
        return promise;
    };
    return exited;
}

test.beforeEach(() => { gateTest.reset(); models.length = 0; });
test.afterEach(() => { for (const model of models) model.stopStream(); gateTest.reset(); });

test.serial('same-stack Stop releases the real admitted ticket exactly once before another turn', async t => {
    const transport = new HeldTransport(), gate = countedGate(), model = make(transport, { gate });
    const stopped = observe(model.stream(req('stopped')));
    model.stopStream();
    model.stopStream();
    const out = await within(stopped);
    await drain();
    t.is(out.kind, 'error');
    if (out.kind !== 'error') return;
    t.is(out.error._aborted, true);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
    t.deepEqual(gate.releases, [1]);
    t.is(transport.sinks.length, 0);
    const next = model.stream(req('next'));
    await drain();
    transport.sinks[0].onChunk(frame('next result') + DONE);
    t.is((await next).choices[0].message.content, 'next result');
    t.deepEqual(gate.releases, [1, 1]);
});

test.serial('same-stack supersession admits B and preserves its ticket after old completion', async t => {
    const transport = new HeldTransport(), gate = countedGate(), model = make(transport, { gate });
    const old = observe(model.stream(req('A')));
    const current = observe(model.stream(req('B')));
    const out = await within(old);
    await drain();
    t.is(out.kind, 'error');
    if (out.kind !== 'error') return;
    t.is(out.error._superseded, true);
    t.deepEqual(gate.releases, [1, 0]);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 0 });
    t.is(transport.sinks.length, 1);
    transport.sinks[0].onChunk(frame('B result') + DONE);
    const result = await within(current);
    t.is(result.kind, 'ok');
    if (result.kind === 'ok') t.is(result.value.choices[0].message.content, 'B result');
    t.deepEqual(gate.releases, [1, 1]);
});

test.serial('Stop cancels standalone complete queued without any stream owner', async t => {
    const blocker = acquireSlot('lm_studio', 1);
    const http = new CapturingHttpClient(completion('fresh complete'));
    const model = make(undefined, { http });
    const stopped = observe(model.complete(req()));
    model.stopStream();
    const out = await within(stopped);
    blocker.release();
    await drain();
    t.is(out.kind, 'error');
    if (out.kind !== 'error') return;
    t.is(out.error._queueCancelled, true);
    t.is(out.error._aborted, undefined);
    t.is(http.sends, 0);
    t.is((await model.complete(req('fresh'))).choices[0].message.content, 'fresh complete');
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('queued supersession rejects with its reason and suppresses old handlers', async t => {
    const blocker = acquireSlot('lm_studio', 1), transport = new HeldTransport(), gate = countedGate();
    const model = make(transport, { gate }), oldCallbacks: string[] = [], activity: ModelStreamActivity[] = [];
    const old = observe(model.stream(req('A'), {
        gate_admitted() { oldCallbacks.push('admitted'); }, chunk() { oldCallbacks.push('chunk'); },
        done() { oldCallbacks.push('done'); }, error() { oldCallbacks.push('error'); }, activity(e) { activity.push(e); },
    }));
    const current = observe(model.stream(req('B')));
    const out = await within(old);
    t.is(out.kind, 'error');
    if (out.kind !== 'error') return;
    t.is(out.error._superseded, true);
    t.deepEqual(oldCallbacks, []);
    t.deepEqual(terminal(activity), ['cancelled']);
    blocker.release();
    await drain();
    t.deepEqual(gate.releases, [0, 0]);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 0 });
    transport.sinks[0].onChunk(frame('current') + DONE);
    const result = await within(current);
    t.is(result.kind, 'ok');
    if (result.kind === 'ok') t.is(result.value.choices[0].message.content, 'current');
    t.deepEqual(gate.releases, [0, 1]);
});

for (const callback of ['gate_admitted', 'activity'] as const) {
    for (const action of ['stop', 'supersede'] as const) {
        test.serial(`emulated admission ${callback} ${action} never sends the cancelled request`, async t => {
            const http = new CapturingHttpClient(completion('current'));
            const model = make(undefined, { provider: new XaiProvider(), http });
            let current: Promise<Outcome> | undefined;
            const callbacks: string[] = [], activity: ModelStreamActivity[] = [];
            const cancel = () => {
                callbacks.push('admission');
                if (action === 'stop') model.stopStream();
                else current = observe(model.stream(req('B')));
            };
            const old = observe(model.stream(req('A'), {
                gate_admitted: callback === 'gate_admitted' ? cancel : undefined,
                activity(e) { activity.push(e); if (callback === 'activity' && e.event === 'admitted') cancel(); },
                chunk() { callbacks.push('chunk'); }, done() { callbacks.push('done'); }, error() { callbacks.push('error'); },
            }));
            const out = await within(old);
            await drain();
            t.is(out.kind, 'error');
            if (out.kind !== 'error') return;
            t.is(out.error._aborted, true);
            t.is(out.error._superseded, action === 'supersede' ? true : undefined);
            t.deepEqual(callbacks, ['admission']);
            t.deepEqual(terminal(activity), ['cancelled']);
            t.is(http.sends, action === 'supersede' ? 1 : 0);
            if (current) {
                const result = await within(current);
                t.is(result.kind, 'ok');
                if (result.kind === 'ok') t.is(result.value.choices[0].message.content, 'current');
                t.deepEqual(http.specs.map(spec => JSON.parse(spec.body ?? '{}').messages[0].content), ['B']);
            }
        });
    }
}

test.serial('emulated chunk Stop suppresses done and publishes one terminal event', async t => {
    const http = new CapturingHttpClient(completion('semantic'));
    const model = make(undefined, { provider: new XaiProvider(), http });
    const callbacks: string[] = [], activity: ModelStreamActivity[] = [];
    const old = observe(model.stream(req(), {
        activity(e) { activity.push(e); }, chunk(response) { callbacks.push(String(response.choices[0].message.content)); model.stopStream(); },
        done() { callbacks.push('done'); }, error() { callbacks.push('error'); },
    }));
    const out = await within(old);
    t.is(out.kind, 'error');
    if (out.kind === 'error') t.is(out.error._aborted, true);
    t.deepEqual(callbacks, ['semantic']);
    t.deepEqual(terminal(activity), ['cancelled']);
    t.is(http.sends, 1);
});

test.serial('content activity Stop suppresses later reasoning, tool, chunk and done callbacks', async t => {
    const transport = new HeldTransport(), model = make(transport), callbacks: string[] = [];
    const old = observe(model.stream(req(), {
        activity(e) { if (e.event === 'content') { callbacks.push('content'); model.stopStream(); } else if (e.event === 'reasoning' || e.event === 'tool') callbacks.push(e.event); },
        chunk() { callbacks.push('chunk'); }, done() { callbacks.push('done'); },
    }));
    await drain();
    transport.sinks[0].onChunk(`data: ${JSON.stringify({ choices: [{ delta: {
        content: 'literal', reasoning_content: 'thinking', tool_calls: [{ index: 0, id: 'tool', function: { name: 'read', arguments: '{}' } }],
    } }] })}\n\n${DONE}`);
    const out = await within(old);
    t.is(out.kind, 'error');
    if (out.kind === 'error') t.is(out.error._aborted, true);
    t.deepEqual(callbacks, ['content']);
    t.is(transport.signals[0].aborted, true);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

for (const mode of ['sentinel', 'eof', 'emulated'] as const) {
    for (const action of ['stop', 'supersede'] as const) {
        test.serial(`held done for ${mode} exits its inner owner on ${action} before callback release`, async t => {
            const transport = new HeldTransport(), gate = countedGate();
            const model = make(transport, { gate, ...(mode === 'emulated' ? { provider: new XaiProvider(), http: new CapturingHttpClient(completion('old'), completion('current')) } : {}) });
            const exited = innerExits(model), activity: ModelStreamActivity[] = [];
            let releaseDone!: () => void, doneEntered = false;
            const held = new Promise<void>(resolve => { releaseDone = resolve; });
            const old = observe(model.stream(req('A'), { activity(e) { activity.push(e); }, done() { doneEntered = true; return held; } }));
            await drain();
            if (mode !== 'emulated') {
                transport.sinks[0].onChunk(frame('old') + (mode === 'sentinel' ? DONE : ''));
                if (mode === 'eof') transport.resolvers[0](CLOSED);
            }
            // Let the real completion schedule its EOF macrotask before awaiting that turn.
            await drain();
            if (mode === 'eof') await new Promise(resolve => setTimeout(resolve, 0));
            await drain();
            t.is(doneEntered, true);
            const current = action === 'supersede' ? observe(model.stream(req('B'))) : undefined;
            if (action === 'stop') model.stopStream();
            const out = await within(old);
            await drain();
            t.is(out.kind, 'error');
            if (out.kind === 'error') t.is(out.error._superseded, action === 'supersede' ? true : undefined);
            t.is(exited.filter(id => id === activity[0].requestId).length, 1, 'the old _runTurn promise exits while consumer done is still held');
            t.deepEqual(terminal(activity), ['cancelled']);
            if (current) {
                if (mode !== 'emulated') transport.sinks[1].onChunk(frame('current') + DONE);
                const result = await within(current);
                t.is(result.kind, 'ok');
                if (result.kind === 'ok') t.is(result.value.choices[0].message.content, 'current');
            }
            releaseDone();
            for (const resolve of transport.resolvers) resolve(CLOSED);
            await drain();
            t.deepEqual(gate.releases, current ? [1, 1] : [1]);
            t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
            t.deepEqual(terminal(activity), ['cancelled']);
        });
    }
}

test.serial('emulated completion reports literal semantic counts and still awaits successful done', async t => {
    const http = new CapturingHttpClient({ body: { choices: [{ message: { role: 'assistant', content: 'semantic', reasoning_content: 'think', tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] } }], usage: {} } });
    const model = make(undefined, { provider: new XaiProvider(), http }), activity: ModelStreamActivity[] = [], callbacks: string[] = [];
    let releaseDone!: () => void, resolved = false;
    const held = new Promise<void>(resolve => { releaseDone = resolve; });
    const promise = model.stream(req(), { activity(e) { activity.push(e); }, chunk() { callbacks.push('chunk'); }, done() { callbacks.push('done'); return held; } });
    void promise.then(() => { resolved = true; });
    await drain();
    t.deepEqual(callbacks, ['chunk', 'done']);
    t.is(resolved, false);
    releaseDone();
    const result = await promise;
    t.is(result.choices[0].message.content, 'semantic');
    t.is(result.choices[0].message.reasoning_content, 'think');
    t.is(result.choices[0].message.tool_calls?.[0].function.name, 'read');
    t.deepEqual(activity.map(e => e.event), ['queued', 'admitted', 'content', 'reasoning', 'tool', 'completed']);
    t.deepEqual(activity.at(-1)?.counts, { transportChunks: 0, transportBytes: 0, contentChars: 8, reasoningChars: 5, toolEvents: 1 });
    model.stopStream();
    model.stopStream();
    t.deepEqual(terminal(activity), ['completed']);
});

test.serial('repeated Stop produces one cancellation for one admitted owner', async t => {
    const transport = new HeldTransport(), gate = countedGate(), model = make(transport, { gate }), activity: ModelStreamActivity[] = [];
    const stopped = observe(model.stream(req(), { activity(e) { activity.push(e); } }));
    await drain();
    model.stopStream();
    model.stopStream();
    const out = await within(stopped);
    t.is(out.kind, 'error');
    if (out.kind === 'error') t.is(out.error._aborted, true);
    await drain();
    t.deepEqual(activity.map(e => e.event), ['queued', 'admitted', 'cancelled']);
    t.deepEqual(gate.releases, [1]);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('a cancellation observer starting C supersedes B without losing either owner', async t => {
    const transport = new HeldTransport(), gate = countedGate(), model = make(transport, { gate });
    let newest: Promise<Outcome> | undefined;
    const old = observe(model.stream(req('A'), { activity(e) { if (e.event === 'cancelled') newest = observe(model.stream(req('C'))); } }));
    await drain();
    const replacement = observe(model.stream(req('B')));
    const a = await within(old), b = await within(replacement);
    await drain();
    t.is(a.kind, 'error');
    if (a.kind === 'error') t.is(a.error._superseded, true);
    t.is(b.kind, 'error');
    if (b.kind === 'error') t.is(b.error._superseded, true);
    t.is(transport.sinks.length, 2);
    transport.sinks[1].onChunk(frame('C result') + DONE);
    if (!newest) throw new Error('Cancellation observer did not start C');
    const result = await within(newest);
    t.is(result.kind, 'ok');
    if (result.kind === 'ok') t.is(result.value.choices[0].message.content, 'C result');
    t.deepEqual(gate.releases, [1, 1]);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('U1 final repair - Stop in LM Studio EOF finish content activity suppresses done', async t => {
    const transport = new HeldTransport(), gate = countedGate();
    const model = make(transport, { gate, provider: new LmStudioProvider() });
    const activity: ModelStreamActivity[] = [], callbacks: string[] = [];
    const pending = observe(model.stream(req(), {
        activity(event) { activity.push(event); if (event.event === 'content') model.stopStream(); },
        chunk() { callbacks.push('chunk'); }, done() { callbacks.push('done'); }, error() { callbacks.push('error'); },
    }));
    await drain();
    transport.sinks[0].onChunk(frame('tail 🌍'));
    transport.resolvers[0](CLOSED);
    const out = await within(pending);
    t.is(out.kind, 'error');
    if (out.kind !== 'error') return;
    t.is(out.error._aborted, true);
    t.deepEqual(activity.map(event => event.event), ['queued', 'admitted', 'content', 'cancelled']);
    t.is(activity.at(-1)?.counts.contentChars, 7);
    t.deepEqual(callbacks, []);
    await drain();
    t.deepEqual(gate.releases, [1]);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('U1 final repair - supersession in LM Studio EOF finish content activity preserves B', async t => {
    const transport = new HeldTransport(), gate = countedGate();
    const model = make(transport, { gate, provider: new LmStudioProvider() });
    const oldActivity: ModelStreamActivity[] = [], callbacks: string[] = [], currentActivity: ModelStreamActivity[] = [];
    let current: Promise<Outcome> | undefined;
    const old = observe(model.stream(req('A'), {
        activity(event) {
            oldActivity.push(event);
            if (event.event === 'content') current = observe(model.stream(req('B'), { activity(e) { currentActivity.push(e); } }));
        },
        chunk() { callbacks.push('chunk'); }, done() { callbacks.push('done'); }, error() { callbacks.push('error'); },
    }));
    await drain();
    transport.sinks[0].onChunk(frame('tail 🌍'));
    transport.resolvers[0](CLOSED);
    const out = await within(old);
    t.is(out.kind, 'error');
    if (out.kind !== 'error') return;
    t.is(out.error._superseded, true);
    await drain();
    t.deepEqual(oldActivity.map(event => event.event), ['queued', 'admitted', 'content', 'cancelled']);
    t.deepEqual(callbacks, []);
    t.deepEqual(gate.releases, [1, 0]);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 0 });
    if (!current) return t.fail('content observer did not start B');
    transport.sinks[1].onChunk(frame('CURRENT') + DONE);
    const next = await within(current);
    t.is(next.kind, 'ok');
    if (next.kind === 'ok') t.is(next.value.choices[0].message.content, 'CURRENT');
    await drain();
    t.deepEqual(terminal(currentActivity), ['completed']);
    t.is(currentActivity.at(-1)?.counts.contentChars, 7);
    t.deepEqual(gate.releases, [1, 1]);
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});
