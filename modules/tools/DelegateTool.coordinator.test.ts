import test from 'ava';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ExecutionContext } from 'ava';
import { createDelegateTool, createSubAgentTool, __test__, stopAllDelegations } from './DelegateTool.js';
import { createAskUserChannels } from './AskUserChannels.js';
import { createAskUserTool } from './AskUserTool.js';
import { MCPClient } from './MCPClient.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';
import { log } from '../../core/utils/Logger.js';
import { SubAgentRunner, SubTaskRegistry, SubTaskNotifier } from '../sub-agents/index.js';
import type { ParentQuestion, RunActivity, SubTask } from '../sub-agents/index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';
import { __test__ as modelsTest } from '../models/index.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
class Mailbox<T> {
    private values: T[] = [];
    private readers: Array<(value: T) => void> = [];
    push(value: T) { const reader = this.readers.shift(); if (reader) reader(value); else this.values.push(value); }
    next(): Promise<T> { return this.values.length ? Promise.resolve(this.values.shift()!) : new Promise(resolve => this.readers.push(resolve)); }
}
type Payload = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
type Request = { payload: Payload; complete(text: string): void; calls(...calls: Array<[string, Record<string, unknown>]>): void; fail(): void };
const owner = { agentName: 'Mira', sessionPath: 'chat.md', sessionEpoch: 'e1', tabKey: 'tab' };

function fixture(t: ExecutionContext, options: { maxIterations?: number; fallback?: boolean; local?: boolean; defaultDepth?: boolean; executorGrace?: number; cooperative?: boolean } = {}) {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock, maxIdleThreadsPerSession: 30 });
    const notifier = new SubTaskNotifier({ registry });
    const requests = new Map<string, Mailbox<Request>>();
    const activities = new Map<string, Mailbox<RunActivity>>();
    const read = deferred<string>();
    const readStarted = deferred<void>();
    const readSignals: Array<AbortSignal | undefined> = [];
    const questions = new Mailbox<ParentQuestion>();
    registry.events.on('question:opened', value => questions.push(value as ParentQuestion));
    let liveExecutors = 0, maxExecutors = 0;
    const enterExecutor = () => { liveExecutors++; maxExecutors = Math.max(maxExecutors, liveExecutors); };
    const leaveExecutor = () => { liveExecutors--; };
    let maxWorking = 0;
    let maxStreamsPerModel = 0;
    let streams = 0;
    const measure = () => { maxWorking = Math.max(maxWorking, registry.list().filter(task => registry.getRunActivity(task.id) === 'working').length); };
    function mailbox<T>(map: Map<string, Mailbox<T>>, key: string): Mailbox<T> {
        let box = map.get(key); if (!box) { box = new Mailbox<T>(); map.set(key, box); } return box;
    }
    class Model {
        modelId = 'tree-model'; providerId = 'ollama'; active = 0; cancel?: () => void;
        _streamGateLimit() { return options.local ? 1 : 0; }
        stream(payload: Payload, handlers: { done(value: unknown): void; error(error: Error): void }) {
            const key = payload.messages.find(message => message.role === 'user')!.content;
            const task = key.match(/(?:parent|child)-\d+/)![0];
            this.active++; streams++; enterExecutor(); measure(); maxStreamsPerModel = Math.max(maxStreamsPerModel, this.active);
            let settled = false;
            const finish = (message: unknown) => { if (!settled) { settled = true; this.active--; leaveExecutor(); } handlers.done({ choices: [{ message }] }); };
            const fail = () => { if (!settled) { settled = true; this.active--; leaveExecutor(); } handlers.error(new Error('controlled failure')); };
            this.cancel = () => { if (!settled) { settled = true; this.active--; leaveExecutor(); } };
            mailbox(requests, task).push({ payload: structuredClone(payload),
                complete: text => finish({ role: 'assistant', content: text }), fail,
                calls: (...calls) => finish({ role: 'assistant', content: '', tool_calls: calls.map(([name, args], i) => ({
                    id: `call-${streams}-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
                })) }),
            });
        }
        stopStream() { this.cancel?.(); }
    }
    const configs = new Map([
        ['mira-parent', { name: 'mira-parent', description: 'parent', tools: ['read', 'delegate'], max_iterations: options.maxIterations ?? 25 }],
        ['mira-child', { name: 'mira-child', description: 'child', tools: ['read'], max_iterations: 25 }],
    ]);
    const agent = { name: 'Mira', activeSubAgents: [...configs.keys()].map(name => ({ name })) };
    const makeRunner = (runtime: unknown) => {
        const runner = new SubAgentRunner({ app: {} as never, plugin: runtime as never, toolRegistry: toolRegistry as never });
        return { runTask: (...args: Parameters<SubAgentRunner['runTask']>) => {
            const key = args[0].match(/(?:parent|child)-\d+/)![0];
            const original = args[4]?.onActivity;
            args[4] = { ...args[4], onActivity: value => { original?.(value); measure(); mailbox(activities, key).push(value); } };
            return runner.runTask(...args);
        } };
    };
    const deps = { makeRunner: makeRunner as never };
    const delegate = createDelegateTool({}, deps);
    const control = createSubAgentTool({}, deps);
    const tools = [delegate, control, createAskUserTool(), { name: 'read', source: 'built-in', description: 'read', inputSchema: {}, execute: (_args: unknown, _app: unknown, _plugin: unknown, context?: BuiltinToolExecutionContext) => {
        enterExecutor(); measure(); readStarted.resolve();
        const signal = context?.abortSignal;
        readSignals.push(signal);
        if (options.cooperative) signal?.addEventListener('abort', () => read.resolve('cancelled'), { once: true });
        return read.promise.finally(leaveExecutor);
    } }];
    const toolRegistry = { getTool: (name: string) => tools.find(tool => tool.name === name) ?? null, filterByAgent: () => tools };
    modelsTest.setChatModelFactory(() => new Model() as never);
    const plugin = {
        toolRegistry, subTaskRegistry: registry, _askUserChannels: createAskUserChannels(registry),
        agentManager: { getActiveAgent: () => agent, getAgent: () => agent, resolveSubAgentConfig: (name: string) => configs.get(name) },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
        env: { chatModel: new Model(), config: { chat: { providers: { ollama: { info: { id: 'ollama' } } },
            http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) },
            transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
        settings: { pkmAssistant: { chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
            modelLibrary: { minion: [{ platform: 'ollama', model: 'tree-model', isDefault: true }] },
            limits: { ...(options.defaultDepth ? {} : { max_delegation_depth: 2 }), max_parallel_delegations: 5, delegation_timeout_ms: 1000, subagent_stall_timeout_ms: 0,
                model_synthesis_timeout_ms: 0, subagent_final_grace_ms: 0,
                ...(options.executorGrace === undefined ? {} : { subagent_executor_abort_grace_ms: options.executorGrace }) },
        } } },
    };
    const client = new MCPClient(null as never, plugin as never, toolRegistry as never);
    if (!options.fallback) Object.assign(plugin, { mcpClient: client });
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalNow = performance.now;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => clock.clearTimeout(handle)) as typeof clearTimeout;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.now() });
    t.teardown(async () => {
        stopAllDelegations('test'); read.resolve('cleanup'); await __test__._settleBackground(true); notifier.dispose(); registry.dispose();
        globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
        Object.defineProperty(performance, 'now', { configurable: true, value: originalNow });
        modelsTest.reset();
    });
    const submit = (task: string) => client.executeToolCall({ name: 'delegate', arguments: { task, aspect: 'parent' } }, 'Mira', { origin: owner });
    return { registry, notifier, clock, submit, read, readStarted, readSignals, questions, configs, client, channels: plugin._askUserChannels,
        batch: () => client.executeToolCall({ name: 'delegate', arguments: { tasks: [1, 2, 3, 4, 5].map(i => ({ task: `parent-${i}`, aspect: 'parent' })) } }, 'Mira', { origin: owner }),
        next: (key: string) => mailbox(requests, key).next(),
        activity: async (key: string, kind: RunActivity['kind']) => {
            let value: RunActivity; do { value = await mailbox(activities, key).next(); } while (value.kind !== kind);
        },
        executors: () => ({ live: liveExecutors, max: maxExecutors }),
        metrics: () => ({ maxWorking, maxStreamsPerModel, streams }),
    };
}
function notices(request: Request): Array<{ kind: string; text?: string; result?: { text: string }; question_id?: string; sub_id?: string }> {
    return request.payload.messages.filter(message => message.content?.startsWith('Child notices:\n'))
        .flatMap(message => JSON.parse(message.content.slice('Child notices:\n'.length)));
}
function answer(request: Request, question: ParentQuestion, text: string) {
    request.calls(['sub_agent', { action: 'message', sub_id: question.subId, question_id: question.id, text }]);
}

for (const fallback of [false, true]) test.serial(`five parents release five slots; five asking children return once (${fallback ? 'fallback' : 'MCP'})`, async t => {
    const f = fixture(t, { fallback });
    for (let i = 1; i <= 5; i++) await f.submit(`parent-${i}`);
    for (let i = 1; i <= 5; i++) {
        (await f.next(`parent-${i}`)).calls(['delegate', { task: `child-${i}`, aspect: 'child', background: false }]);
        const receipt = await f.next(`parent-${i}`);
        const tool = JSON.parse(receipt.payload.messages.find(message => message.role === 'tool')!.content);
        t.deepEqual([tool.success, tool.started, typeof tool.task_id, typeof tool.sub_id], [true, true, 'string', 'string']);
        receipt.complete('premature parent');
        await f.activity(`parent-${i}`, 'waiting-children');
    }
    const children = await Promise.all([1, 2, 3, 4, 5].map(i => f.next(`child-${i}`)));
    t.deepEqual(f.registry.list().filter(task => task.level === 1).map(task => f.registry.getRunActivity(task.id)),
        ['inactive', 'inactive', 'inactive', 'inactive', 'inactive']);
    const qs: ParentQuestion[] = [];
    for (let i = 1; i <= 5; i++) {
        children[i - 1].calls(['ask_parent', { text: `question-${i}` }]);
        qs.push(await f.questions.next());
        await f.activity(`child-${i}`, 'waiting');
    }
    const parents = await Promise.all([1, 2, 3, 4, 5].map(i => f.next(`parent-${i}`)));
    t.deepEqual(parents.map(request => notices(request).map(notice => [notice.kind, notice.text])),
        [[['question', 'question-1']], [['question', 'question-2']], [['question', 'question-3']], [['question', 'question-4']], [['question', 'question-5']]]);
    for (let i = 1; i <= 5; i++) {
        answer(parents[i - 1], qs[i - 1], `answer-${i}`);
        (await f.next(`parent-${i}`)).complete('still premature');
        await f.activity(`parent-${i}`, 'waiting-children');
    }
    for (let i = 1; i <= 5; i++) {
        const child = await f.next(`child-${i}`);
        t.deepEqual(child.payload.messages.filter(message => message.role === 'tool').map(message => message.content), [`answer-${i}`]);
        child.complete(`child-result-${i}`);
        const parent = await f.next(`parent-${i}`);
        t.deepEqual(notices(parent).filter(notice => notice.kind === 'result').map(notice => notice.result?.text), [`child-result-${i}`]);
        parent.complete(`parent-result-${i}`);
    }
    await __test__._settleBackground(true);
    t.deepEqual(f.registry.list().filter(task => task.level === 1).map(task => [task.status, task.result?.text]),
        [['done', 'parent-result-1'], ['done', 'parent-result-2'], ['done', 'parent-result-3'], ['done', 'parent-result-4'], ['done', 'parent-result-5']]);
    t.deepEqual(f.notifier.pending().map(task => task.result?.text), ['parent-result-1', 'parent-result-2', 'parent-result-3', 'parent-result-4', 'parent-result-5']);
    t.deepEqual(f.metrics(), { maxWorking: 5, maxStreamsPerModel: 1, streams: 35 });
    t.deepEqual([f.clock.pending, __test__._liveAbortCount(), f.registry.events.listenerCount('question:closed')], [0, 0, 1]);
});

for (const local of [false, true]) test.serial(`two child questions, escalation and paused work budgets (local=${local})`, async t => {
    const f = fixture(t, { local });
    await f.submit('parent-1');
    (await f.next('parent-1')).calls(['delegate', { task: 'child-1', aspect: 'child' }]);
    (await f.next('parent-1')).complete('premature');
    await f.activity('parent-1', 'waiting-children');
    const child = await f.next('child-1');
    t.deepEqual(child.payload.tools?.map(tool => tool.function.name), ['read', 'ask_parent']);
    child.calls(['ask_parent', { text: 'Qg1' }]);
    const qg1 = await f.questions.next();
    await f.activity('child-1', 'waiting');
    (await f.next('parent-1')).calls(['ask_parent', { text: 'Qp' }]);
    const qp = await f.questions.next();
    await f.activity('parent-1', 'waiting');
    const releaseHuman = f.registry.registerUserWait(owner, () => {});
    f.clock.advance(400000);
    t.deepEqual(f.registry.list().map(task => [task.status, f.registry.getRunActivity(task.id)]), [['running', 'inactive'], ['running', 'inactive']]);
    releaseHuman();
    t.is(f.registry.answerParentQuestion(qp.taskId, qp.id, owner, 'lead answer').kind, 'accepted');
    answer(await f.next('parent-1'), qg1, 'first answer');
    (await f.next('parent-1')).complete('premature again');
    await f.activity('parent-1', 'waiting-children');
    (await f.next('child-1')).calls(['ask_parent', { text: 'Qg2' }]);
    const qg2 = await f.questions.next();
    await f.activity('child-1', 'waiting');
    answer(await f.next('parent-1'), qg2, 'second answer');
    (await f.next('parent-1')).complete('waiting for result');
    await f.activity('parent-1', 'waiting-children');
    const finalChild = await f.next('child-1');
    t.deepEqual(finalChild.payload.messages.filter(message => message.role === 'tool').map(message => message.content), ['first answer', 'second answer']);
    finalChild.complete('child final');
    const finalParent = await f.next('parent-1');
    t.deepEqual(notices(finalParent).map(notice => [notice.kind, notice.text ?? notice.result?.text]),
        [['question', 'Qg1'], ['question', 'Qg2'], ['result', 'child final']]);
    finalParent.complete('parent final');
    await __test__._settleBackground(true);
    t.deepEqual(f.registry.list().map(task => [task.status, task.result?.text]), [['done', 'parent final'], ['done', 'child final']]);
    t.deepEqual([f.clock.pending, f.metrics().maxStreamsPerModel], [0, 1]);
});

for (const askFirst of [false, true]) test.serial(`parallel read + delegate + ask_parent retains work slot until read settles (askFirst=${askFirst})`, async t => {
    const f = fixture(t);
    const held = await Promise.all(['a', 'b', 'c', 'd'].map(id => f.registry.acquire(owner, id, new AbortController().signal)));
    t.teardown(() => held.forEach(lease => lease.release()));
    await f.submit('parent-1');
    const calls: Array<[string, Record<string, unknown>]> = [
        ['read', {}], ['delegate', { task: 'child-1', aspect: 'child' }], ['ask_parent', { text: 'lead question' }],
    ];
    (await f.next('parent-1')).calls(...(askFirst ? calls.reverse() : calls));
    await f.readStarted.promise;
    const qp = await f.questions.next();
    const parent = f.registry.getTask(qp.taskId)!;
    const reservation = f.registry.listThreads(owner).find(thread => thread.parentId === parent.id)!;
    t.deepEqual([f.registry.getRunActivity(parent.id), reservation.phase, f.registry.getRunActivity(reservation.threadId)], ['working', 'queued', 'queued']);
    f.clock.advance(400);
    f.read.resolve('READ MATERIAL');
    await f.activity('parent-1', 'waiting');
    (await f.next('child-1')).calls(['ask_parent', { text: 'child question' }]);
    const qg = await f.questions.next();
    await f.activity('child-1', 'waiting');
    const releaseHuman = f.registry.registerUserWait(owner, () => {});
    f.clock.advance(400000);
    t.deepEqual([f.registry.getRunActivity(parent.id), f.registry.getQuestionState(parent.id).kind], ['inactive', 'waiting']);
    releaseHuman();
    t.is(f.registry.answerParentQuestion(qp.taskId, qp.id, owner, 'lead answer').kind, 'accepted');
    const resumed = await f.next('parent-1');
    t.deepEqual(resumed.payload.messages.filter(message => message.role === 'tool').map(message => {
        if (message.content.startsWith('{')) return JSON.parse(message.content).started;
        return message.content;
    }), askFirst ? ['lead answer', true, 'READ MATERIAL'] : ['READ MATERIAL', true, 'lead answer']);
    t.deepEqual(notices(resumed).map(notice => [notice.kind, notice.text]), [['question', 'child question']]);
    // The 400 ms of parallel read time were charged; the wait did not reset the 1000 ms budget.
    f.clock.advance(599);
    t.deepEqual([parent.status, parent.result?.text], ['running', undefined]);
    f.clock.advance(1);
    await __test__._settleBackground(true);
    t.deepEqual(f.registry.list().map(task => [task.status, task.outcome?.end]),
        [['aborted', { kind: 'timeout' }], ['aborted', { kind: 'stopped', by: 'system' }]]);
    t.is(parent.result?.handoff?.includes('READ MATERIAL'), true);
    t.deepEqual([f.registry.getQuestionState(qg.taskId).kind, f.clock.pending, f.metrics().maxStreamsPerModel], ['closed', 0, 1]);
});

for (const end of ['backstop', 'error', 'stop'] as const) test.serial(`${end} closes descendants; late child result never resumes parent`, async t => {
    const f = fixture(t, { maxIterations: end === 'backstop' ? 1 : 25 });
    await f.submit('parent-1');
    const parent = f.registry.list()[0];
    const terminals: string[] = [];
    f.registry.events.on('task:finished', value => terminals.push((value as SubTask).id));
    (await f.next('parent-1')).calls(['delegate', { task: 'child-1', aspect: 'child' }]);
    if (end === 'backstop') {
        await __test__._settleBackground(true);
        t.deepEqual(f.registry.list().map(task => [task.name, task.outcome?.end]),
            [['mira-parent', { kind: 'limit', reason: 'iteration-limit' }], ['mira-child', { kind: 'stopped', by: 'system' }]]);
    } else {
        const child = await f.next('child-1');
        const request = await f.next('parent-1');
        if (end === 'error') request.fail();
        else { request.complete('premature'); await f.activity('parent-1', 'waiting-children'); f.registry.requestStop(parent.id, 'user'); }
        await __test__._settleBackground(true);
        const snapshot = JSON.stringify(f.registry.list().map(task => task.result));
        child.calls(['read', {}]);
        await Promise.resolve();
        t.is(JSON.stringify(f.registry.list().map(task => task.result)), snapshot);
        t.deepEqual(f.registry.list().map(task => task.outcome?.end), end === 'error'
            ? [{ kind: 'failed', stage: 'work' }, { kind: 'stopped', by: 'system' }]
            : [{ kind: 'stopped', by: 'user' }, { kind: 'stopped', by: 'user' }]);
        t.is(f.metrics().streams, 3);
    }
    t.deepEqual([terminals.length, new Set(terminals).size, f.clock.pending, __test__._liveAbortCount()], [2, 2, 0, 0]);
    t.deepEqual(f.registry.list().map(task => f.registry.getRunActivity(task.id)), ['inactive', 'inactive']);
});

for (const fallback of [false, true]) test.serial(`automatic sub_agent control refuses task and other parent's child (${fallback ? 'fallback' : 'MCP'})`, async t => {
    const f = fixture(t, { fallback });
    await f.submit('parent-1'); await f.submit('parent-2');
    (await f.next('parent-2')).calls(['delegate', { task: 'child-2', aspect: 'child' }]);
    const child = await f.next('child-2');
    const childTask = f.registry.list().find(task => task.level === 2)!;
    (await f.next('parent-1')).calls(['sub_agent', { action: 'task', sub_id: childTask.threadId, task: 'child-3' }],
        ['sub_agent', { action: 'stop', sub_id: childTask.threadId }]);
    const rejected = await f.next('parent-1');
    t.deepEqual(rejected.payload.messages.filter(message => message.role === 'tool').map(message => message.content), [
        'Refused: tool "sub_agent.task" is outside this sub-agent\'s allowed set (parent∩sub whitelist). Use only the tools provided to you.',
        fallback
            ? 'Tool sub_agent error: {"success":false,"error":"This sub-agent belongs to another agent or conversation. Use delegate to create your own sub-agent."}'
            : 'Tool sub_agent error: {"success":false,"error":"This sub-agent belongs to another agent or conversation. Use delegate to create your own sub-agent.","isError":true}',
    ]);
    rejected.complete('parent-1 final');
    (await f.next('parent-2')).complete('premature');
    child.complete('child-2 final');
    (await f.next('parent-2')).complete('parent-2 final');
    await __test__._settleBackground(true);
    t.deepEqual(f.registry.list().map(task => [task.status, task.result?.text]),
        [['done', 'parent-1 final'], ['done', 'parent-2 final'], ['done', 'child-2 final']]);
});

test.serial('Stop while parent reacquires a full lane cancels the wait without a new stream', async t => {
    const f = fixture(t);
    await f.submit('parent-1');
    (await f.next('parent-1')).calls(['delegate', { task: 'child-1', aspect: 'child' }]);
    const child = await f.next('child-1');
    (await f.next('parent-1')).complete('premature');
    await f.activity('parent-1', 'waiting-children');
    const held = ['a', 'b', 'c', 'd', 'e'].map(id => f.registry.acquire(owner, id, new AbortController().signal));
    child.calls(['ask_parent', { text: 'wake parent' }]);
    await f.questions.next();
    await f.activity('parent-1', 'queued');
    const leases = await Promise.all(held);
    const parent = f.registry.list()[0];
    t.deepEqual([f.registry.getRunActivity(parent.id), f.metrics().streams], ['queued', 3]);
    t.is(f.registry.requestStop(parent.id, 'user'), true);
    await __test__._settleBackground(true);
    leases.forEach(lease => lease.release());
    t.deepEqual(f.registry.list().map(task => [task.status, task.outcome?.end]),
        [['aborted', { kind: 'stopped', by: 'user' }], ['aborted', { kind: 'stopped', by: 'user' }]]);
    t.deepEqual([f.metrics().streams, f.clock.pending, __test__._liveAbortCount()], [3, 0, 0]);
});

test.serial('local batch admission group is released by sleeping parents and cannot block grandchildren', async t => {
    const f = fixture(t, { local: true });
    const receipt = await f.batch() as { tasks: Array<{ queued: boolean }> };
    t.deepEqual(receipt.tasks.map(task => task.queued), [false, true, true, true, true]);
    for (let i = 1; i <= 5; i++) {
        (await f.next(`parent-${i}`)).calls(['delegate', { task: `child-${i}`, aspect: 'child' }]);
        (await f.next(`parent-${i}`)).complete('premature');
        await f.activity(`parent-${i}`, 'waiting-children');
    }
    const children = await Promise.all([1, 2, 3, 4, 5].map(i => f.next(`child-${i}`)));
    t.deepEqual(f.registry.list().filter(task => task.level === 1).map(task => f.registry.getRunActivity(task.id)),
        ['inactive', 'inactive', 'inactive', 'inactive', 'inactive']);
    children.forEach((request, i) => request.complete(`child-${i + 1} final`));
    for (let i = 1; i <= 5; i++) {
        const parent = await f.next(`parent-${i}`);
        t.deepEqual(notices(parent).map(notice => notice.result?.text), [`child-${i} final`]);
        parent.complete(`parent-${i} final`);
    }
    await __test__._settleBackground(true);
    t.deepEqual(f.registry.list().filter(task => task.level === 1).map(task => task.result?.text),
        ['parent-1 final', 'parent-2 final', 'parent-3 final', 'parent-4 final', 'parent-5 final']);
    t.deepEqual(f.metrics(), { maxWorking: 5, maxStreamsPerModel: 1, streams: 20 });
    t.deepEqual([f.clock.pending, __test__._liveAbortCount()], [0, 0]);
});

test.serial('waiting for a child result and queued reacquisition both pause the remaining work budget', async t => {
    const f = fixture(t);
    await f.submit('parent-1');
    const first = await f.next('parent-1');
    f.clock.advance(400);
    first.calls(['delegate', { task: 'child-1', aspect: 'child', timeout_ms: 10000 }]);
    const child = await f.next('child-1');
    (await f.next('parent-1')).complete('premature');
    await f.activity('parent-1', 'waiting-children');
    f.clock.advance(1500);
    const parent = f.registry.list()[0];
    t.deepEqual(f.registry.list().map(task => [task.status, f.registry.getRunActivity(task.id)]),
        [['running', 'inactive'], ['running', 'working']]);
    const held = ['a', 'b', 'c', 'd', 'e'].map(id => f.registry.acquire(owner, id, new AbortController().signal));
    child.complete('child after long wait');
    const leases = await Promise.all(held);
    t.teardown(() => leases.forEach(lease => lease.release()));
    await f.activity('parent-1', 'queued');
    f.clock.advance(4000);
    t.deepEqual([parent.status, f.registry.getRunActivity(parent.id), f.registry.list()[1].status], ['running', 'queued', 'done']);
    leases[0].release();
    const resumed = await f.next('parent-1');
    t.deepEqual(notices(resumed).map(notice => notice.result?.text), ['child after long wait']);
    f.clock.advance(599);
    t.is(parent.status, 'running');
    resumed.complete('parent after both waits');
    await __test__._settleBackground(true);
    t.deepEqual([parent.status, parent.result?.text, f.clock.pending, f.metrics().streams], ['done', 'parent after both waits', 0, 4]);
});


test.serial('P6 default 2: grandchild question -> parent -> lead ask_user -> Kuba -> parent -> grandchild', async t => {
    const f = fixture(t, { defaultDepth: true });
    f.configs.get('mira-child')!.tools.push('delegate');
    await f.submit('parent-1');
    const parent = await f.next('parent-1');
    t.deepEqual(parent.payload.tools?.map(tool => tool.function.name), ['read', 'delegate', 'ask_parent', 'sub_agent']);
    parent.calls(['delegate', { task: 'child-1', aspect: 'child' }]);
    (await f.next('parent-1')).complete('waiting');
    await f.activity('parent-1', 'waiting-children');
    const child = await f.next('child-1');
    t.deepEqual(child.payload.tools?.map(tool => tool.function.name), ['read', 'ask_parent']);
    child.calls(['ask_parent', { text: 'Jaki zakres wnuka?' }]);
    const qg = await f.questions.next();
    await f.activity('child-1', 'waiting');
    (await f.next('parent-1')).calls(['ask_parent', { text: 'Kubo, jaki zakres?' }]);
    const qp = await f.questions.next();
    await f.activity('parent-1', 'waiting');
    t.deepEqual([qg.recipient, qp.recipient, qg.id === qp.id], [{ kind: 'sub', runId: qp.taskId }, { kind: 'lead' }, false]);
    const human = f.channels.open(owner);
    f.clock.advance(400000);
    t.deepEqual(f.registry.list().map(task => {
        const state = f.registry.getQuestionState(task.id);
        return state.kind === 'waiting' ? state.clock : state;
    }), [{ kind: 'paused', remainingMs: 300000 }, { kind: 'paused', remainingMs: 300000 }]);
    const asking = f.client.executeToolCall({ name: 'ask_user', arguments: { question: qp.text, question_id: qp.id } }, 'Mira',
        { origin: owner, askUserChannelId: human.id });
    human.answer('Tylko folder Projekty');
    const response = await asking as { success: boolean; answer: string; auto: boolean };
    t.deepEqual([response.success, response.answer, response.auto], [true, 'Tylko folder Projekty', false]);
    const delivered = await f.client.executeToolCall({ name: 'sub_agent', arguments: {
        action: 'message', sub_id: qp.subId, question_id: qp.id, text: response.answer,
    } }, 'Mira', { origin: owner }) as { success: boolean };
    t.is(delivered.success, true);
    const resumed = await f.next('parent-1');
    t.is(resumed.payload.messages.filter(message => message.role === 'tool').at(-1)?.content, 'Tylko folder Projekty');
    answer(resumed, qg, response.answer);
    (await f.next('parent-1')).complete('waiting for child');
    await f.activity('parent-1', 'waiting-children');
    const resumedChild = await f.next('child-1');
    t.is(resumedChild.payload.messages.filter(message => message.role === 'tool').at(-1)?.content, 'Tylko folder Projekty');
    resumedChild.complete('Wynik wnuka');
    const finalParent = await f.next('parent-1');
    t.deepEqual(notices(finalParent).map(n => [n.kind, n.text ?? n.result?.text]), [['question', 'Jaki zakres wnuka?'], ['result', 'Wynik wnuka']]);
    finalParent.complete('Wynik rodzica');
    await __test__._settleBackground(true);
    t.deepEqual(f.registry.list().map(task => [task.status, task.result?.text]), [['done', 'Wynik rodzica'], ['done', 'Wynik wnuka']]);
    t.deepEqual([f.clock.pending, f.metrics().maxStreamsPerModel], [0, 1]);
});

for (const batch of [false, true]) test.serial(`F1 Stop retains lease until real executors settle (batch=${batch})`, async t => {
    const f = fixture(t);
    for (let i = 1; i <= 5; i++) await f.submit(`parent-${i}`);
    const fifth = await f.next('parent-5');
    fifth.calls(...(batch ? [['ask_parent', { text: 'wait' }], ['read', {}]] as Array<[string, Record<string, unknown>]> : [['read', {}]] as Array<[string, Record<string, unknown>]>));
    await f.readStarted.promise;
    const receipt = await f.submit('parent-6') as { task_id: string };
    const stopped = f.registry.list().find(task => task.taskPreview?.includes('parent-5'))!;
    t.deepEqual(f.executors(), { live: 5, max: 5 });
    t.is(f.registry.getRunActivity(receipt.task_id), 'queued');
    t.true(f.registry.requestStop(stopped.id));
    // Drain ready promises, including logical completion and DelegateTool.finally(release).
    await nextTurn();
    t.is(stopped.status, 'aborted');
    t.deepEqual(f.executors(), { live: 5, max: 5 });
    t.is(f.metrics().streams, 5);
    t.is(f.registry.getRunActivity(receipt.task_id), 'queued');
    f.read.resolve('late read');
    (await f.next('parent-6')).complete('sixth done');
    for (let i = 1; i <= 4; i++) (await f.next(`parent-${i}`)).complete(`done-${i}`);
    await __test__._settleBackground(true);
    t.deepEqual(f.executors(), { live: 0, max: 5 });
    t.is(f.metrics().streams, 6);
    t.is(f.clock.pending, 0);
});

for (const fallback of [false, true]) for (const rejected of [false, true]) test.serial(`F2 five hung reads release only at abort grace; late results inert (fallback=${fallback}, rejected=${rejected})`, async t => {
    const grace = fallback ? 2000 : 10000;
    const f = fixture(t, { fallback, ...(fallback ? { executorGrace: grace } : {}) });
    const warnings: unknown[][] = [];
    const warn = log.warn;
    log.warn = (...args) => { warnings.push(args); };
    t.teardown(() => { log.warn = warn; });
    for (let i = 1; i <= 5; i++) {
        await f.submit(`parent-${i}`);
        (await f.next(`parent-${i}`)).calls(['read', {}]);
    }
    await nextTurn();
    t.deepEqual(f.executors(), { live: 5, max: 5 });
    const receipt = await f.submit('parent-6') as { task_id: string };
    const stopped = f.registry.list().slice(0, 5);
    stopped.forEach(task => f.registry.requestStop(task.id));
    await nextTurn();
    t.deepEqual(stopped.map(task => task.status), ['aborted', 'aborted', 'aborted', 'aborted', 'aborted']);
    const snapshot = () => JSON.stringify([f.registry.list(), f.registry.listThreads(owner), f.notifier.pending()]);
    f.clock.advance(grace - 1);
    await nextTurn();
    t.deepEqual([f.registry.getRunActivity(receipt.task_id), f.metrics().streams, f.executors().max], ['queued', 5, 5]);
    f.clock.advance(1);
    await nextTurn();
    t.deepEqual([f.registry.getRunActivity(receipt.task_id), f.metrics().streams], ['working', 6]);
    t.deepEqual(f.readSignals.map(signal => signal?.aborted), [true, true, true, true, true]);
    t.deepEqual(stopped.map(task => f.registry.getRunActivity(task.id)), ['inactive', 'inactive', 'inactive', 'inactive', 'inactive']);
    t.deepEqual(warnings.filter(args => args[1] === 'Executor detached after abort grace').map(args => args[2]),
        stopped.map(task => ({ runId: task.id, tool: 'read' })));
    (await f.next('parent-6')).complete('sixth done');
    await __test__._settleBackground(true);
    const after = snapshot();
    if (rejected) f.read.reject(new Error('LATE DETACHED ERROR'));
    else f.read.resolve('LATE DETACHED RESULT');
    await nextTurn();
    t.is(snapshot(), after);
    t.deepEqual([f.metrics().streams, f.clock.pending, __test__._liveAbortCount()], [6, 0, 0]);
});

test.serial('F2 width-one hung batch does not block independent work before grace', async t => {
    const f = fixture(t, { local: true });
    const batch = await f.batch() as { tasks: Array<{ task_id: string }> };
    (await f.next('parent-1')).calls(['read', {}]);
    await f.readStarted.promise;
    f.registry.requestStop(batch.tasks[0].task_id);
    await nextTurn();
    const independent = await f.submit('parent-6') as { task_id: string };
    await nextTurn();
    t.deepEqual(batch.tasks.map(task => f.registry.getRunActivity(task.task_id)), ['working', 'queued', 'queued', 'queued', 'queued']);
    t.deepEqual([f.registry.getRunActivity(independent.task_id), f.metrics().streams, f.clock.now()], ['working', 2, 0]);
    (await f.next('parent-6')).complete('independent done');
    f.clock.advance(10000);
    for (let i = 2; i <= 5; i++) (await f.next(`parent-${i}`)).complete(`done-${i}`);
    await __test__._settleBackground(true);
    t.deepEqual([f.metrics().streams, f.clock.pending], [6, 0]);
});

for (const fallback of [false, true]) test.serial(`F2 cooperative abort clears grace immediately (fallback=${fallback})`, async t => {
    const f = fixture(t, { fallback, cooperative: true });
    await f.submit('parent-1');
    (await f.next('parent-1')).calls(['read', {}]);
    await f.readStarted.promise;
    const task = f.registry.list()[0];
    f.registry.requestStop(task.id);
    await nextTurn();
    t.deepEqual([task.status, f.registry.getRunActivity(task.id), f.executors().live, f.clock.pending], ['aborted', 'inactive', 0, 0]);
});

for (const cause of ['timeout', 'unload'] as const) test.serial(`F2 ${cause} also bounds executor retention and cleans timers`, async t => {
    const f = fixture(t);
    await f.submit('parent-1');
    (await f.next('parent-1')).calls(['read', {}]);
    await f.readStarted.promise;
    const task = f.registry.list()[0];
    if (cause === 'timeout') f.clock.advance(1000);
    else stopAllDelegations('test');
    await nextTurn();
    t.deepEqual([task.status, f.registry.getRunActivity(task.id), f.readSignals[0]?.aborted], ['aborted', 'working', true]);
    f.clock.fireNextEarly();
    t.is(f.registry.getRunActivity(task.id), 'working');
    f.clock.advance(9999);
    t.is(f.registry.getRunActivity(task.id), 'working');
    f.clock.advance(1);
    await __test__._settleBackground(true);
    t.deepEqual([f.registry.getRunActivity(task.id), f.clock.pending, __test__._liveAbortCount()], ['inactive', 0, 0]);
});
