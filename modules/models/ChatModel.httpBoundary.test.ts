import test from 'ava';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChatModel } from './ChatModel.js';
import { OpenAiProvider } from './providers/openai.js';
import { LmStudioProvider } from './providers/lm_studio.js';
import { acquireSlot, gateSnapshot, __test__ as gateTest } from './requestGate.js';
import { FetchStreamTransport } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { CapturingHttpClient, makeCtx, makeSettings } from './testing/harness.js';
import type { ChatRequest, ChatProviderInfo, ModelStreamActivity } from './contracts.js';

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'PROMPT_SENTINEL_U1' }] };

class LocalOpenAiProvider extends OpenAiProvider {
    override get info(): ChatProviderInfo {
        return { ...super.info, id: 'lm_studio', label: 'Local OpenAI compatible', local: true };
    }
}

test.serial('local OpenAI-compatible sentinel settles and closes the actual HTTP socket with request correlation', async t => {
    gateTest.reset();
    const sockets = new Set<import('node:net').Socket>();
    let socketClosed = false;
    let receivedRequestId = '';
    let requestBody = '';
    const diagnosticLines: string[] = [];
    const logger = log as unknown as { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
    const oldDebug = logger.debug;
    const oldWarn = logger.warn;
    logger.debug = (...args) => { diagnosticLines.push(JSON.stringify(args)); };
    logger.warn = (...args) => { diagnosticLines.push(JSON.stringify(args)); };
    const server = createServer((req, res) => {
        const socket = req.socket;
        sockets.add(socket);
        socket.once('close', () => { socketClosed = true; });
        receivedRequestId = String(req.headers['x-pkm-request-id'] ?? '');
        req.on('data', part => { requestBody += String(part); });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'COOKIE_SENTINEL_U1=private' });
        res.write('data: RAW_FRAME_SENTINEL_U1\n\n');
        res.write(': keepalive\n\n');
        setTimeout(() => {
            res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
            const split = Buffer.from('data: {"choices":[{"delta":{"content":"🌍"}}]}\n\n' + 'data: [DONE]\n\n', 'utf8');
            const emoji = split.indexOf(Buffer.from([0xf0, 0x9f]));
            res.write(split.subarray(0, emoji + 2));
            setTimeout(() => res.write(split.subarray(emoji + 2)), 5);
        }, 10);
        // Keep the response open. The model's semantic terminal must abort its own reader.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const model = new ChatModel({
        provider: new LocalOpenAiProvider(),
        ctx: makeCtx({ modelId: 'fixture', apiKey: 'KEY_SENTINEL_U1', endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions` }),
        http: new CapturingHttpClient(),
        transport: new FetchStreamTransport(),
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
    });
    try {
        const activity: Array<{ event: string; requestId: string; counts: Record<string, number>; keys: string[] }> = [];
        const result = await Promise.race([
            model.stream(REQ, { activity: event => activity.push({ event: event.event, requestId: event.requestId, counts: { ...event.counts }, keys: Object.keys(event) }) }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not settle')), 1000)),
        ]);
        t.is(result.choices[0].message.content, 'hello 🌍');
        const until = Date.now() + 1000;
        while (!socketClosed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
        t.true(socketClosed, 'actual server socket closes after the semantic sentinel');
        t.truthy(receivedRequestId, 'local server receives generated request correlation');
        t.false(requestBody.includes(receivedRequestId), 'request correlation is never placed in the provider body');
        t.true(activity.some(event => event.event === 'transport' && event.counts.transportChunks > 0), 'transport bytes are reported as activity');
        t.true(activity.some(event => event.event === 'content' && event.counts.contentChars > 0), 'semantic content has separate counters');
        t.is(activity.find(event => event.event === 'completed')?.counts.contentChars, 'hello 🌍'.length, 'terminal activity has the aggregate content count');
        t.is(activity.find(event => event.event === 'transport')?.counts.contentChars, 0, 'heartbeat activity has no semantic content');
        t.true(activity.every(event => event.requestId === receivedRequestId), 'telemetry and local HTTP share one request id');
        t.true(activity.every(event => event.keys.join(',') === 'event,requestId,attempt,elapsedMs,counts'), 'activity contains only fixed metadata');
        const diagnostics = diagnosticLines.join('\n');
        for (const sentinel of ['PROMPT_SENTINEL_U1', 'KEY_SENTINEL_U1', 'COOKIE_SENTINEL_U1', 'RAW_FRAME_SENTINEL_U1']) {
            t.false(diagnostics.includes(sentinel), 'production diagnostics exclude the unique ' + sentinel);
        }
        const transportEnd = diagnosticLines.find(line => line.includes('stream.activity') && line.includes('"event":"completed"'));
        t.truthy(transportEnd, 'existing Logger records terminal aggregate metadata');
        t.true(diagnosticLines.some(line => line.includes('stream.transport_end') && line.includes('"byteCount":')), 'existing Logger records actual HTTP byte and status metadata');
        t.true(diagnostics.includes(receivedRequestId), 'existing Logger records request correlation');
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        logger.debug = oldDebug;
        logger.warn = oldWarn;
    }
});

test.serial('actual local HTTP empty response and EOF preserve their exact model outcomes', async t => {
    gateTest.reset();
    const server = createServer((req, res) => {
        if (req.url === '/eof') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        } else {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end();
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const makeModelFor = (route: string) => new ChatModel({
        provider: new LocalOpenAiProvider(),
        ctx: makeCtx({ modelId: 'fixture', endpoint: 'http://127.0.0.1:' + address.port + route }),
        http: new CapturingHttpClient(),
        transport: new FetchStreamTransport(),
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
    });
    try {
        const eof = await makeModelFor('/eof').stream(REQ);
        t.is(eof.choices[0].message.content, 'partial');
        const emptyError = await makeModelFor('/empty').stream(REQ).then(() => null, error => error as Error);
        t.truthy(emptyError);
        t.is(emptyError!.message, 'Model zamknął połączenie bez żadnej treści i bez znacznika końca odpowiedzi.');
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test.serial('actual local HTTP request with no terminal frame is cancelled by Stop and closes its socket', async t => {
    gateTest.reset();
    let requestArrived!: () => void;
    const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
    let socketClosed = false;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((_req, res) => {
        sockets.add(_req.socket);
        _req.socket.once('close', () => { socketClosed = true; });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        requestArrived();
        // This is a never-ending response with no body bytes and no semantic terminal.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const model = new ChatModel({
        provider: new LocalOpenAiProvider(),
        ctx: makeCtx({ modelId: 'fixture', endpoint: 'http://127.0.0.1:' + address.port + '/never' }),
        http: new CapturingHttpClient(),
        transport: new FetchStreamTransport(),
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
    });
    try {
        const pending = model.stream(REQ);
        await arrived;
        model.stopStream();
        const error = await pending.then(() => null, value => value as Error & { _aborted?: true });
        t.is(error?._aborted, true);
        const until = Date.now() + 1000;
        while (!socketClosed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
        t.true(socketClosed, 'Stop aborts the actual local reader and closes the server socket');
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test.serial('cloud provider receives no plugin correlation header or request-body metadata', async t => {
    gateTest.reset();
    let outgoing: { headers: Record<string, string>; body?: string } | null = null;
    const model = new ChatModel({
        provider: new OpenAiProvider(),
        ctx: makeCtx({ modelId: 'fixture', endpoint: 'https://api.example.test/v1/chat/completions' }),
        http: new CapturingHttpClient(),
        transport: {
            open: async (spec, sink) => {
                outgoing = spec;
                sink.onChunk('data: {"choices":[{"delta":{"content":"cloud"}}]}\n\ndata: [DONE]\n\n');
                return { status: 200, headers: {}, body: '' };
            },
        },
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'openai' } }),
    });
    let requestId = '';
    const result = await model.stream(REQ, { activity: event => { requestId = event.requestId; } });
    t.is(result.choices[0].message.content, 'cloud');
    t.truthy(requestId);
    t.false(Object.keys(outgoing!.headers).some(name => name.toLowerCase() === 'x-pkm-request-id'));
    t.false(String(outgoing!.body).includes(requestId));
});

test.serial('stop settles internal attempt when transport ignores abort and late events cannot reach callbacks', async t => {
    gateTest.reset();
    let firstSink: { onChunk(text: string): void } | null = null;
    let firstResolve: ((result: { status: number; headers: Record<string, string>; body: string }) => void) | null = null;
    let opens = 0;
    const transport = {
        open: (_spec: unknown, sink: { onChunk(text: string): void }) => {
            opens++;
            if (opens === 1) {
                firstSink = sink;
                return new Promise<{ status: number; headers: Record<string, string>; body: string }>(resolve => { firstResolve = resolve; });
            }
            sink.onChunk('data: {"choices":[{"delta":{"content":"new"}}]}\n\ndata: [DONE]\n\n');
            return Promise.resolve({ status: 200, headers: {}, body: '' });
        },
    };
    class FastModel extends ChatModel { static override GATE_RELEASE_COOLDOWN_MS = 0; }
    const model = new FastModel({
        provider: new LocalOpenAiProvider(),
        ctx: makeCtx({ modelId: 'fixture' }),
        http: new CapturingHttpClient(),
        transport: transport as never,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
    });
    const oldEvents: string[] = [];
    const old = model.stream(REQ, { chunk: () => oldEvents.push('chunk'), done: () => { oldEvents.push('done'); } });
    await new Promise(resolve => setTimeout(resolve, 5));
    model.stopStream();
    await t.throwsAsync(() => old);
    const next = await model.stream(REQ);
    t.is(next.choices[0].message.content, 'new');
    firstSink!.onChunk('data: {"choices":[{"delta":{"content":"stale"}}]}\n\n');
    firstResolve!({ status: 200, headers: {}, body: '' });
    await new Promise(resolve => setTimeout(resolve, 0));
    t.deepEqual(oldEvents, []);
    t.is(opens, 2);
});

test.serial('superseding one model request tags the old result and leaves the new request active', async t => {
    gateTest.reset();
    let oldSink: { onChunk(text: string): void } | null = null;
    let oldResolve!: (result: { status: number; headers: Record<string, string>; body: string }) => void;
    let newSink: { onChunk(text: string): void } | null = null;
    let secondStarted!: () => void;
    const secondOpened = new Promise<void>(resolve => { secondStarted = resolve; });
    let calls = 0;
    const transport = {
        open: (_spec: unknown, sink: { onChunk(text: string): void }) => {
            calls++;
            if (calls === 1) {
                oldSink = sink;
                return new Promise<{ status: number; headers: Record<string, string>; body: string }>(resolve => { oldResolve = resolve; });
            }
            newSink = sink;
            secondStarted();
            return new Promise<{ status: number; headers: Record<string, string>; body: string }>(() => {});
        },
    };
    class FastModel extends ChatModel { static override GATE_RELEASE_COOLDOWN_MS = 0; }
    const model = new FastModel({
        provider: new LocalOpenAiProvider(),
        ctx: makeCtx({ modelId: 'fixture' }),
        http: new CapturingHttpClient(),
        transport: transport as never,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
    });
    const oldEvents: string[] = [];
    const old = model.stream(REQ, { chunk: () => oldEvents.push('chunk'), done: () => { oldEvents.push('done'); } });
    await new Promise(resolve => setTimeout(resolve, 5));
    const nextPromise = model.stream(REQ);
    const oldError = await old.then(() => null, error => error as Error & { _superseded?: true });
    t.is(oldError?._superseded, true);
    await secondOpened;
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 0 });
    oldSink!.onChunk('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n');
    oldResolve({ status: 200, headers: {}, body: '' });
    await new Promise(resolve => setTimeout(resolve, 0));
    t.deepEqual(gateSnapshot('lm_studio'), { active: 1, queued: 0 }, 'old owner cleanup cannot release request B');
    t.deepEqual(oldEvents, []);
    newSink!.onChunk('data: {"choices":[{"delta":{"content":"current"}}]}\n\ndata: [DONE]\n\n');
    const next = await nextPromise;
    t.is(next.choices[0].message.content, 'current');
    t.is(calls, 2);
    await new Promise(resolve => setTimeout(resolve, 0));
    t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
});

test.serial('U1 final repair - actual LM Studio EOF finish counts content before done and sentinel counts it once', async t => {
    gateTest.reset();
    class ImmediateModel extends ChatModel {
        static override scheduleGateRelease(fn: () => void, _ms: number): void { fn(); }
    }
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((request, response) => {
        sockets.add(request.socket);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const sentinel = request.url?.startsWith('/sentinel') ? 'data: [DONE]\n\n' : '';
        response.end('data: {"choices":[{"delta":{"content":"tail 🌍"}}]}\n\n' + sentinel);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    try {
        for (const route of ['eof', 'sentinel']) {
            const activity: ModelStreamActivity[] = [];
            const order: string[] = [];
            const model = new ImmediateModel({
                provider: new LmStudioProvider(),
                ctx: makeCtx({ modelId: 'fixture', endpoint: 'http://127.0.0.1:' + address.port + '/' + route + '/v1/chat/completions' }),
                http: new CapturingHttpClient(), transport: new FetchStreamTransport(), gate: { acquireSlot },
                settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
            });
            const result = await model.stream(REQ, {
                activity(event) { activity.push(event); order.push(event.event); },
                done(final) { t.is(final.choices[0].message.content, 'tail 🌍'); order.push('done'); },
            });
            t.is(result.choices[0].message.content, 'tail 🌍');
            t.deepEqual(order, ['queued', 'admitted', 'transport', 'content', 'done', 'completed']);
            t.deepEqual(activity.find(event => event.event === 'completed')?.counts, {
                transportChunks: 1, transportBytes: route === 'eof' ? 55 : 69,
                contentChars: 7, reasoningChars: 0, toolEvents: 0,
            });
            t.is(activity.find(event => event.event === 'content')?.counts.contentChars, 7);
            await new Promise(resolve => setTimeout(resolve, 0));
            t.deepEqual(gateSnapshot('lm_studio'), { active: 0, queued: 0 });
        }
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
