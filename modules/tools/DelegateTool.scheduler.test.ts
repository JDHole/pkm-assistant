import test from 'ava';
import type { ExecutionContext } from 'ava';
import { createDelegateTool, createSubAgentTool, __test__, stopAllDelegations } from './DelegateTool.js';
import type { DelegatePlugin } from './DelegateTool.js';
import { SubTaskRegistry } from '../sub-agents/index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';
import { __test__ as modelsTest } from '../models/index.js';

class Mailbox<T> {
    private values: T[] = [];
    private readers: Array<(value: T) => void> = [];
    push(value: T) { const reader = this.readers.shift(); if (reader) reader(value); else this.values.push(value); }
    next(): Promise<T> {
        const value = this.values.shift();
        return value ? Promise.resolve(value) : new Promise(resolve => this.readers.push(resolve));
    }
}
type Request = { task: string; complete(text: string): void };
type Receipt = { success: boolean; task_id: string; sub_id: string; queued?: boolean; tasks: Receipt[] };
const owner = { agentName: 'Mira', sessionPath: 'chat.md', sessionEpoch: 'e1', tabKey: 'tab' };
function fixture(t: ExecutionContext, local = false) {
    __test__._resetBackground();
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    const requests = new Mailbox<Request>();
    const starts: string[] = [];
    class Model {
        modelId = 'worker-model'; providerId = 'ollama';
        _streamGateLimit() { return local ? 1 : 0; }
        stream(payload: { messages: Array<{ role: string; content: string }> }, handlers: { done(value: unknown): void }) {
            const task = payload.messages.filter(message => message.role === 'user').at(-1)!.content;
            starts.push(task);
            requests.push({ task, complete: text => handlers.done({ choices: [{ message: { role: 'assistant', content: text } }] }) });
        }
        stopStream() {}
    }
    modelsTest.setChatModelFactory(() => new Model() as never);
    const plugin = {
        subTaskRegistry: registry,
        toolRegistry: { filterByAgent: () => [], getTool: () => null },
        agentManager: { getActiveAgent: () => ({ name: 'Mira', activeSubAgents: [] }) },
        env: {
            chatModel: new Model(),
            config: { chat: { providers: { ollama: { info: { id: 'ollama' } } },
                http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) },
                transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
            settings: { pkmAssistant: {
                chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                limits: { max_parallel_delegations: 5, delegation_timeout_ms: 1000, subagent_stall_timeout_ms: 0 },
            } },
        },
    } as unknown as DelegatePlugin;
    const delegate = createDelegateTool({});
    const control = createSubAgentTool({});
    const submit = (task: string, origin = owner) => delegate.execute({ task, _invocationOrigin: origin }, {}, plugin) as Promise<Receipt>;
    const batch = (tasks: string[]) => delegate.execute({ tasks: tasks.map(task => ({ task })), _invocationOrigin: owner }, {}, plugin) as Promise<Receipt>;
    t.teardown(async () => {
        stopAllDelegations('test');
        await __test__._settleBackground();
        registry.dispose(); __test__._resetModuleUnloaded();
    });
    return { clock, registry, requests, starts, plugin, delegate, control, submit, batch };
}

async function fill(f: ReturnType<typeof fixture>) {
    const receipt = await f.batch(['a', 'b', 'c', 'd', 'e']);
    const running = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(() => f.requests.next()));
    return { receipt, running };
}

test.serial('single and batch beyond five are accepted FIFO; no task disappears and a second session runs independently', async t => {
    const f = fixture(t);
    const { receipt, running } = await fill(f);
    const sixth = await f.submit('f');
    const batch = await f.batch(['g', 'h']);
    t.deepEqual([sixth.success, sixth.queued, batch.success, batch.queued], [true, true, true, 2]);
    t.deepEqual(f.starts, ['a', 'b', 'c', 'd', 'e']);
    t.deepEqual(batch.tasks.map(item => [item.queued, f.registry.getThread(item.sub_id)?.phase]), [[true, 'queued'], [true, 'queued']]);
    const other = await f.submit('other', { ...owner, sessionEpoch: 'e2' });
    const otherRequest = await f.requests.next();
    t.deepEqual([other.success, otherRequest.task], [true, 'other']);
    running[0].complete('result-a');
    const next = await f.requests.next();
    t.deepEqual([next.task, f.registry.getRunActivity(batch.tasks[0].task_id), f.registry.getRunActivity(batch.tasks[1].task_id)], ['f', 'queued', 'queued']);
    next.complete('result-f');
    const seventh = await f.requests.next(); t.is(seventh.task, 'g'); seventh.complete('result-g');
    const eighth = await f.requests.next(); t.is(eighth.task, 'h'); eighth.complete('result-h');
    running.slice(1).forEach(request => request.complete(`result-${request.task}`));
    otherRequest.complete('result-other');
    await __test__._settleBackground();
    t.deepEqual(f.registry.list().map(task => [task.taskPreview, task.status, task.result?.text]), [
        ['a', 'done', 'result-a'], ['b', 'done', 'result-b'], ['c', 'done', 'result-c'], ['d', 'done', 'result-d'], ['e', 'done', 'result-e'],
        ['other', 'done', 'result-other'], ['f', 'done', 'result-f'], ['g', 'done', 'result-g'], ['h', 'done', 'result-h'],
    ]);
    t.deepEqual([...receipt.tasks, sixth, ...batch.tasks, other].map(item => f.registry.getRunActivity(item.task_id)),
        ['inactive', 'inactive', 'inactive', 'inactive', 'inactive', 'inactive', 'inactive', 'inactive', 'inactive']);
    t.deepEqual([__test__._backgroundCount(), __test__._liveAbortCount(), f.registry.events.listenerCount('thread:closed')], [0, 0, 0]);
});

test.serial('batch size over max_parallel_delegations is rejected before reservation', async t => {
    const f = fixture(t);
    const result = await f.batch(['a', 'b', 'c', 'd', 'e', 'f']);
    t.deepEqual([result.success, f.registry.listThreads(owner).length, f.starts.length], [false, 0, 0]);
    const accepted = await f.submit('accepted');
    (await f.requests.next()).complete('ok');
    await __test__._settleBackground();
    t.deepEqual([accepted.success, f.registry.getTask(accepted.task_id)?.result?.text], [true, 'ok']);
});

test.serial('continuation reserves a new run before admission and cannot be accepted twice', async t => {
    const f = fixture(t);
    const first = await f.submit('initial');
    (await f.requests.next()).complete('initial result');
    await __test__._settleBackground();
    const { running } = await fill(f);
    const pending = await f.control.execute({ action: 'task', sub_id: first.sub_id, task: 'continue', _invocationOrigin: owner }, {}, f.plugin) as Receipt;
    const duplicate = await f.control.execute({ action: 'task', sub_id: first.sub_id, task: 'duplicate', _invocationOrigin: owner }, {}, f.plugin) as Receipt;
    t.deepEqual([pending.success, pending.queued, pending.sub_id === first.sub_id, pending.task_id === first.task_id,
        duplicate.success, f.registry.getThread(first.sub_id)?.phase], [true, true, true, false, false, 'queued']);
    running[0].complete('a result');
    const continuation = await f.requests.next();
    t.is(continuation.task.includes('continue'), true);
    continuation.complete('continued result');
    running.slice(1).forEach(request => request.complete('done'));
    await __test__._settleBackground();
    t.deepEqual([f.registry.getTask(first.task_id)?.result?.text, f.registry.getTask(pending.task_id)?.result?.text,
        f.registry.getTask(pending.task_id)?.threadId === first.sub_id, f.registry.getThread(first.sub_id)?.runIds.length],
    ['initial result', 'continued result', true, 2]);
});

test.serial('closing queued continuation records its own terminal run once and never starts a model', async t => {
    const f = fixture(t);
    const first = await f.submit('initial');
    (await f.requests.next()).complete('initial result');
    await __test__._settleBackground();
    const { running } = await fill(f);
    const next = await f.control.execute({ action: 'task', sub_id: first.sub_id, task: 'cancelled', _invocationOrigin: owner }, {}, f.plugin) as Receipt;
    const ended: string[] = [];
    f.registry.events.on('task:finished', task => { ended.push((task as { id: string }).id); });
    await f.control.execute({ action: 'close', sub_id: first.sub_id, _invocationOrigin: owner }, {}, f.plugin);
    running.forEach(request => request.complete('done'));
    await __test__._settleBackground();
    t.deepEqual([f.registry.getTask(first.task_id)?.result?.text, f.registry.getTask(next.task_id)?.outcome?.end,
        ended.filter(id => id === next.task_id).length, f.registry.getThread(first.sub_id)?.runIds.length, f.starts.length],
    ['initial result', { kind: 'stopped', by: 'lead' }, 1, 2, 6]);
});

test.serial('queued work has no timeout until admission even after more than its task budget', async t => {
    const f = fixture(t);
    const clock = f.clock;
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const originalNow = performance.now;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => clock.clearTimeout(handle)) as typeof clearTimeout;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.now() });
    t.teardown(() => {
        globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
        Object.defineProperty(performance, 'now', { configurable: true, value: originalNow });
    });
    // Hold real scheduler leases, so only the queued task would own a task timer.
    const held = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => f.registry.acquire(owner, id, new AbortController().signal)));
    const queued = await f.submit('waited');
    clock.advance(5000);
    t.deepEqual([queued.success, queued.queued, clock.pending, f.starts.length, f.registry.getRunActivity(queued.task_id)],
        [true, true, 0, 0, 'queued']);
    held[0].release();
    const request = await f.requests.next();
    request.complete('full budget survived');
    await __test__._settleBackground();
    t.deepEqual([f.registry.getTask(queued.task_id)?.status, f.registry.getTask(queued.task_id)?.result?.text, clock.pending],
        ['done', 'full budget survived', 0]);
    held.forEach(lease => lease.release());
});

test.serial('local batch width queues its next member without blocking an eligible later call', async t => {
    const f = fixture(t, true);
    const batch = await f.batch(['a', 'b']);
    const first = await f.requests.next();
    const later = await f.submit('c');
    t.deepEqual([batch.queued, later.success, f.registry.getRunActivity(later.task_id),
        f.registry.getRunActivity(batch.tasks[1].task_id), f.starts], [1, true, 'working', 'queued', ['a', 'c']]);
    const independent = await f.requests.next();
    t.is(independent.task, 'c');
    first.complete('a result');
    const second = await f.requests.next();
    t.deepEqual([second.task, f.starts], ['b', ['a', 'c', 'b']]);
    second.complete('b result'); independent.complete('c result');
    await __test__._settleBackground();
    t.deepEqual(f.registry.list().map(task => task.result?.text), ['a result', 'c result', 'b result']);
});

test.serial('Stop after slot assignment but before runner start cancels exactly that queued single', async t => {
    const f = fixture(t);
    const held = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => f.registry.acquire(owner, id, new AbortController().signal)));
    const queued = await f.submit('cancel before start');
    held[0].release();
    f.registry.closeThread(queued.sub_id, 'user');
    await __test__._settleBackground();
    t.deepEqual([f.starts.length, f.registry.getTask(queued.task_id)?.outcome?.end, f.registry.getRunActivity(queued.task_id),
        f.registry.events.listenerCount('thread:closed'), __test__._liveAbortCount()],
    [0, { kind: 'stopped', by: 'user' }, 'inactive', 0, 0]);
    const next = await f.submit('replacement');
    (await f.requests.next()).complete('replacement result');
    await __test__._settleBackground();
    t.is(f.registry.getTask(next.task_id)?.result?.text, 'replacement result');
    held.forEach(lease => lease.release());
});

test.serial('model refusal after queued continuation settles the new run and releases admission', async t => {
    const f = fixture(t);
    const first = await f.submit('initial');
    (await f.requests.next()).complete('initial result');
    await __test__._settleBackground();
    const held = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => f.registry.acquire(owner, id, new AbortController().signal)));
    const queued = await f.control.execute({ action: 'task', sub_id: first.sub_id, task: 'model removed', _invocationOrigin: owner }, {}, f.plugin) as Receipt;
    f.plugin.env!.settings!.pkmAssistant!.modelLibrary = { minion: [] };
    held[0].release();
    await __test__._settleBackground();
    t.deepEqual([f.registry.getTask(first.task_id)?.result?.text, f.registry.getTask(queued.task_id)?.status,
        f.registry.getTask(queued.task_id)?.outcome?.end, f.registry.getRunActivity(queued.task_id), f.starts.length],
    ['initial result', 'error', { kind: 'failed', stage: 'work' }, 'inactive', 1]);
    held.forEach(lease => lease.release());
});

test.serial('timeout receipt does not release a lease while the underlying runner is still settling', async t => {
    const f = fixture(t);
    const clock = f.clock;
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const originalNow = performance.now;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => clock.clearTimeout(handle)) as typeof clearTimeout;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.now() });
    t.teardown(() => {
        globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
        Object.defineProperty(performance, 'now', { configurable: true, value: originalNow });
    });
    f.plugin.env!.settings!.pkmAssistant!.limits!.subagent_salvage_max_chars = 0;
    const held = await Promise.all(['a', 'b', 'c', 'd'].map(id => f.registry.acquire(owner, id, new AbortController().signal)));
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const tool = createDelegateTool({}, { makeRunner: () => ({
        runTask: async (prompt, _agent, config, _model, options) => {
            const id = options.queuedThreadId!;
            f.registry.beginQueuedRun(id, owner, {});
            const task = f.registry.create({ id, name: config.name, agentName: owner.agentName, origin: owner, threadId: id, taskPreview: prompt });
            options.onTaskCreated?.(task);
            await done;
            f.registry.finish(task, { text: 'settled', toolsUsed: [], durationMs: 0, usage: null, stoppedBy: 'abort' });
            return { result: 'settled', stoppedBy: 'abort' };
        },
    }) });
    const working = await tool.execute({ task: 'slow abort', _invocationOrigin: owner }, {}, f.plugin) as Receipt;
    const timed = __test__._settleBackground();
    const queued = await f.submit('next');
    clock.advance(1000);
    await timed;
    t.deepEqual([f.registry.getRunActivity(working.task_id), f.registry.getRunActivity(queued.task_id), f.starts.length],
        ['working', 'queued', 0]);
    finish();
    (await f.requests.next()).complete('next result');
    await __test__._settleBackground();
    t.deepEqual([f.registry.getRunActivity(working.task_id), f.registry.getTask(queued.task_id)?.result?.text, clock.pending],
        ['inactive', 'next result', 0]);
    held.forEach(lease => lease.release());
});
