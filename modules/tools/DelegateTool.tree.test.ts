import test from 'ava';
import type { ExecutionContext } from 'ava';
import { createDelegateTool, createSubAgentTool, __test__ as delegateTest } from './DelegateTool.js';
import type { SubAgentConfigLike } from './DelegateTool.js';
import { MCPClient } from './MCPClient.js';
import { SubAgentRunner, SubTaskRegistry, buildStripModel } from '../sub-agents/index.js';
import type { SubRunContext, SubTask } from '../sub-agents/index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';
import { __test__ as modelsTest } from '../models/index.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
class Mailbox<T> {
    private values: T[] = [];
    private readers: Array<(value: T) => void> = [];
    push(value: T) { const reader = this.readers.shift(); if (reader) reader(value); else this.values.push(value); }
    next(): Promise<T> { const value = this.values.shift(); return value ? Promise.resolve(value) : new Promise(resolve => this.readers.push(resolve)); }
}
type Request = { payload: unknown; complete(text: string): void; call(name: string, args: Record<string, unknown>): void };
const owner = { agentName: 'Mira', sessionPath: 'sessions/mira.md', sessionEpoch: 'epoch-1', tabKey: 'tab-1' };
const config = (name: string, tools: string[] = []): SubAgentConfigLike => ({ name, description: name, tools });

function fixture(t: ExecutionContext, fallback = false) {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    t.teardown(() => registry.dispose());
    const requests = new Mailbox<Request>();
    let streamCount = 0;
    class Model {
        modelId = 'tree-model';
        providerId = 'ollama';
        _streamGateLimit() { return 1; }
        stream(payload: unknown, handlers: { done(value: unknown): void }) {
            streamCount++;
            requests.push({ payload,
                complete: text => handlers.done({ choices: [{ message: { role: 'assistant', content: text } }] }),
                call: (name, args) => handlers.done({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
                    { id: 'call-tree', type: 'function', function: { name, arguments: JSON.stringify(args) } },
                ] } }] }),
            });
        }
        stopStream() {}
    }
    const configs = new Map([
        ['mira-parent', config('mira-parent', ['delegate', 'sub_agent'])],
        ['mira-child', config('mira-child')],
        ['alias-parent', config('mira-parent', ['delegate'])],
        ['mira-grandparent', config('mira-grandparent', ['delegate'])],
    ]);
    const agent = { name: 'Mira', activeSubAgents: [...configs.keys()].map(name => ({ name })) };
    const delegate = createDelegateTool({});
    const control = createSubAgentTool({});
    const tools = [delegate, control];
    const toolRegistry = { getTool: (name: string) => tools.find(tool => tool.name === name) ?? null, filterByAgent: () => tools };
    modelsTest.setChatModelFactory(() => new Model() as never);
    const plugin = {
        toolRegistry, subTaskRegistry: registry,
        agentManager: { getActiveAgent: () => agent, getAgent: () => agent, resolveSubAgentConfig: (name: string) => configs.get(name) },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
        env: {
            chatModel: new Model(),
            config: { chat: { providers: { ollama: { info: { id: 'ollama' } } },
                http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) },
                transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
            settings: { pkmAssistant: {
                chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                modelLibrary: { minion: [{ platform: 'ollama', model: 'tree-model', isDefault: true }] },
                limits: { max_delegation_depth: 3, max_parallel_delegations: 5 },
            } },
        },
    };
    const client = new MCPClient(null as never, plugin as never, toolRegistry as never);
    const runtime = { ...plugin, mcpClient: fallback ? undefined : client };
    // MCP and fallback must see the same runtime, including the nested runner's MCP client.
    Object.assign(plugin, { mcpClient: runtime.mcpClient });
    const runner = new SubAgentRunner({ app: {} as never, plugin: runtime as never, toolRegistry: toolRegistry as never });
    function start(options: Parameters<SubAgentRunner['runTask']>[4] = {}) {
        return runner.runTask('Zadanie rodzica', agent, configs.get('mira-parent')! as never, new Model() as never,
            { delegationDepth: 1, origin: owner, ...options });
    }
    return { registry, clock, requests, client, runner, plugin, delegate, configs, start, streamCount: () => streamCount };
}

for (const fallback of [false, true]) {
    test.serial(`runner -> ${fallback ? 'fallback' : 'MCP'} -> delegate zachowuje drzewo i queued mimo fałszywych znaczników`, async t => {
        const f = fixture(t, fallback);
        const pending = f.start();
        const rootRequest = await f.requests.next();
        const root = f.registry.list()[0];
        t.deepEqual([root.name, root.parentId, root.level, root.origin], ['mira-parent', undefined, 1, owner]);
        rootRequest.call('delegate', { tasks: [{ task: 'pierwsze', aspect: 'child' }, { task: 'drugie', aspect: 'child' }],
            _invocationSubRunContext: { runId: 'forged', level: 0, origin: { agentName: 'Other' } },
            _invocationOrigin: { agentName: 'Other' }, _invocationDelegationDepth: 0, parentId: 'forged', level: 99 });
        const first = await f.requests.next();
        const rows = buildStripModel({ ...owner, tasks: f.registry.list(), threads: f.registry.listThreads(owner) });
        t.deepEqual(rows.map(row => [row.name, row.parentId === root.id ? 'root-run' : row.parentId, row.level, row.state.kind]),
            [['mira-parent', undefined, 1, 'running'], ['mira-child', 'root-run', 2, 'running'], ['mira-child', 'root-run', 2, 'queued']]);
        t.deepEqual(f.registry.listThreads(owner).map(thread => [thread.name, thread.origin]),
            [['mira-parent', owner], ['mira-child', owner], ['mira-child', owner]]);
        first.complete('pierwszy wynik');
        (await f.requests.next()).complete('drugi wynik');
        (await f.requests.next()).complete('wynik rodzica');
        t.is((await pending).result, 'wynik rodzica');
        t.deepEqual(f.registry.list().map(task => [task.name, task.status, task.parentId === root.id ? 'root-run' : task.parentId, task.level]),
            [['mira-parent', 'done', undefined, 1], ['mira-child', 'done', 'root-run', 2], ['mira-child', 'done', 'root-run', 2]]);
        t.deepEqual([f.clock.pending, delegateTest._liveAbortCount(), f.streamCount()], [0, 0, 4]);
    });
}

test.serial('kontynuacja rodzica deleguje z nowego runId, a wznowione dziecko dostaje relację nowego biegu', async t => {
    const f = fixture(t);
    const first = f.start();
    (await f.requests.next()).call('delegate', { task: 'dziecko', aspect: 'child' });
    (await f.requests.next()).complete('wynik dziecka');
    (await f.requests.next()).complete('pierwszy wynik rodzica');
    await first;
    const [oldRoot, oldChild] = f.registry.list();
    const second = f.start({ threadId: oldRoot.threadId });
    const request = await f.requests.next();
    const newRoot = f.registry.list()[2];
    request.call('sub_agent', { action: 'task', sub_id: oldChild.threadId, task: 'dalej', background: false });
    (await f.requests.next()).complete('kontynuacja dziecka');
    (await f.requests.next()).complete('drugi wynik rodzica');
    t.is((await second).result, 'drugi wynik rodzica');
    const child = f.registry.list()[3];
    t.deepEqual({ parentIsNewRun: child.parentId === newRoot.id, parentIsOldThread: child.parentId === oldRoot.threadId,
        sameChildThread: child.threadId === oldChild.threadId, newChildRun: child.id !== oldChild.id, level: child.level,
        threadParentIsNewRun: f.registry.getThread(child.threadId!)?.parentId === newRoot.id },
    { parentIsNewRun: true, parentIsOldThread: false, sameChildThread: true, newChildRun: true, level: 2, threadParentIsNewRun: true });
    // Lead continuation of a formerly nested thread is a new root run, not a child of its old parent.
    const lead = f.client.executeToolCall({ name: 'sub_agent', arguments: { action: 'task', sub_id: oldChild.threadId, task: 'od prowadzącego', background: false } }, 'Mira', { origin: owner });
    (await f.requests.next()).complete('wynik dla prowadzącego');
    const result = await lead as { success: boolean; result: string };
    const leadRun = f.registry.list()[4];
    t.deepEqual([result.success, result.result, leadRun.parentId, leadRun.level], [true, 'wynik dla prowadzącego', undefined, 1]);
});

const invalidParents = ['missing', 'done', 'stopping', 'session', 'epoch', 'agent', 'incomplete', 'level', 'broken-chain'] as const;
for (const reason of invalidParents) {
    test.serial(`SubRunContext odrzuca rodzica: ${reason}`, async t => {
        const f = fixture(t);
        const parent = f.registry.create({ id: 'parent-run', name: 'mira-parent', agentName: 'Mira', origin: owner, level: 1 });
        if (reason === 'done') f.registry.finish(parent, { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null });
        if (reason === 'stopping') { f.registry.attachAbort(parent.id, () => {}); f.registry.requestStop(parent.id, 'lead'); }
        if (reason === 'broken-chain') parent.parentId = 'absent';
        const origin = { ...owner, ...(reason === 'session' ? { sessionPath: 'other.md' } : {}),
            ...(reason === 'epoch' ? { sessionEpoch: 'other' } : {}), ...(reason === 'agent' ? { agentName: 'Other' } : {}),
            ...(reason === 'incomplete' ? { sessionEpoch: '' } : {}) };
        const context: SubRunContext = { runId: reason === 'missing' ? 'missing' : parent.id, level: reason === 'level' ? 2 : 1, origin };
        const result = await f.client.executeToolCall({ name: 'delegate', arguments: { task: 'dziecko', aspect: 'child' } }, 'Mira', { subRunContext: context });
        t.deepEqual(result, { success: false, isError: true, error: 'Invalid sub-agent parent context.' });
        t.deepEqual([f.registry.list().length, f.streamCount(), delegateTest._liveAbortCount()], [1, 0, 0]);
    });
}

for (const aspect of ['mira-parent', 'parent', 'ALIAS-PARENT', 'grandparent', undefined]) {
    test.serial(`kanoniczna konfiguracja self/fuzzy/alias/ancestor/template odrzucona: ${String(aspect)}`, async t => {
        const f = fixture(t);
        f.registry.create({ id: 'grandparent-run', name: 'mira-grandparent', agentName: 'Mira', origin: owner, level: 1 });
        f.registry.create({ id: 'parent-run', name: 'mira-parent', agentName: 'Mira', origin: owner, parentId: 'grandparent-run', level: 2 });
        if (aspect === undefined) {
            Object.assign(f.plugin.env.settings.pkmAssistant, { globalSubTemplate: 'parent-template' });
            Object.assign(f.plugin.agentManager, { subAgentTemplateStore: { get: () => config('mira-parent') } });
        }
        const result = await f.client.executeToolCall({ name: 'delegate', arguments: { task: 'zakazane', aspect } }, 'Mira',
            { subRunContext: { runId: 'parent-run', level: 2, origin: owner } });
        t.deepEqual(result, { success: false, isError: true, error: 'Cannot delegate to self or ancestor configuration.' });
        t.deepEqual([f.registry.list().length, f.streamCount()], [2, 0]);
    });
}

test.serial('MCP usuwa modelowy SubRunContext w delegacji prowadzącego bez pełnego właściciela', async t => {
    const f = fixture(t);
    const finished = deferred<SubTask>();
    f.registry.events.on('task:finished', (task: unknown) => finished.resolve(task as SubTask));
    const receipt = await f.client.executeToolCall({ name: 'delegate', arguments: { task: 'root', aspect: 'child',
        _invocationSubRunContext: { runId: 'forged', level: 2, origin: owner }, _invocationDelegationDepth: 3,
        _invocationOrigin: owner } }, 'Mira') as { started: boolean };
    (await f.requests.next()).complete('root bez sesji');
    const task = await finished.promise;
    t.deepEqual([receipt.started, task.parentId, task.level, task.origin, task.result?.text], [true, undefined, 1, undefined, 'root bez sesji']);
});

for (const change of ['parent-ended', 'config-changed'] as const) {
    test.serial(`kolejka ponownie waliduje rodzica i konfigurację przed startem: ${change}`, async t => {
        const f = fixture(t);
        const parent = f.registry.create({ id: 'parent', name: 'mira-parent', agentName: 'Mira', origin: owner, level: 1 });
        const pending = f.client.executeToolCall({ name: 'delegate', arguments: { tasks: [
            { task: 'pierwsze', aspect: 'child' }, { task: 'drugie', aspect: 'child' },
        ] } }, 'Mira', { subRunContext: { runId: 'parent', level: 1, origin: owner } });
        const first = await f.requests.next();
        if (change === 'parent-ended') f.registry.finish(parent, { text: 'koniec', toolsUsed: [], durationMs: 1, usage: null });
        else f.configs.set('mira-child', config('mira-parent'));
        first.complete('pierwszy wynik');
        const response = await pending as { results: Array<{ success: boolean; error?: string }> };
        t.deepEqual(response.results.map(item => [item.success, item.error]), [
            [true, undefined], [false, change === 'parent-ended' ? 'Invalid sub-agent parent context.' : 'Cannot delegate to self or ancestor configuration.'],
        ]);
        t.deepEqual(f.registry.list().slice(1).map(task => [task.status, task.parentId, task.level]), [['done', 'parent', 2], ['error', 'parent', 2]]);
        t.deepEqual([f.streamCount(), delegateTest._liveAbortCount(), f.clock.pending], [1, 0, 0]);
    });
}

for (const fallback of [false, true]) {
    test.serial(`P3 Stop through registry cancels parent, active child and queued sibling (${fallback ? 'fallback' : 'MCP'})`, async t => {
        const f = fixture(t, fallback);
        delegateTest._resetBackground();
        const receipt = await f.client.executeToolCall({ name: 'delegate', arguments: { task: 'rodzic', aspect: 'parent' } }, 'Mira', { origin: owner }) as { task_id: string };
        (await f.requests.next()).call('delegate', { tasks: [{ task: 'dziecko', aspect: 'child' }, { task: 'kolejka', aspect: 'child' }] });
        const childRequest = await f.requests.next();
        const finishes: string[] = [];
        f.registry.events.on('task:finished', value => finishes.push((value as SubTask).id));
        t.is(f.registry.requestStop(receipt.task_id), true);
        // A provider may still deliver a tool call after cancellation. It must not run.
        childRequest.call('delegate', { task: 'spóźnione', aspect: 'grandparent' });
        await delegateTest._settleBackground();
        t.deepEqual(f.registry.listThreads(owner).map(thread => [thread.name, thread.phase]),
            [['mira-parent', 'idle'], ['mira-child', 'idle'], ['mira-child', 'closed']]);
        t.deepEqual(f.registry.list().map(task => [task.name, task.outcome?.end]), [
            ['mira-parent', { kind: 'stopped', by: 'user' }],
            ['mira-child', { kind: 'stopped', by: 'user' }],
            ['mira-child', { kind: 'stopped', by: 'user' }],
        ]);
        t.deepEqual([finishes.length, new Set(finishes).size, f.streamCount(), f.clock.pending,
            delegateTest._liveAbortCount(), f.registry.events.listenerCount('thread:closed')], [3, 3, 2, 0, 0, 0]);
        t.deepEqual(f.registry.list().map(task => f.registry.getRunActivity(task.id)), ['inactive', 'inactive', 'inactive']);
    });
}

test.serial('P3 Stop from task:created before runner attachAbort prevents the first model stream', async t => {
    const f = fixture(t);
    delegateTest._resetBackground();
    f.registry.events.on('task:created', value => f.registry.requestStop((value as SubTask).id, 'lead'));
    await f.client.executeToolCall({ name: 'delegate', arguments: { task: 'zatrzymaj przed startem', aspect: 'child' } }, 'Mira', { origin: owner });
    await delegateTest._settleBackground();
    t.deepEqual(f.registry.list().map(task => [task.name, task.outcome?.end]), [['mira-child', { kind: 'stopped', by: 'lead' }]]);
    t.deepEqual([f.streamCount(), delegateTest._liveAbortCount(), f.clock.pending], [0, 0, 0]);
});

test.serial('P3 Stop from thread:created before admission records one queued terminal result without a model', async t => {
    const f = fixture(t);
    delegateTest._resetBackground();
    let finished = 0;
    f.registry.events.on('thread:created', () => f.registry.requestStopForOwner(owner, 'user'));
    f.registry.events.on('task:finished', () => { finished++; });
    await f.client.executeToolCall({ name: 'delegate', arguments: { task: 'rezerwacja', aspect: 'child' } }, 'Mira', { origin: owner });
    await delegateTest._settleBackground();
    t.deepEqual(f.registry.list().map(task => [task.name, task.taskPreview, task.background, task.outcome?.end]),
        [['mira-child', 'rezerwacja', true, { kind: 'stopped', by: 'user' }]]);
    t.deepEqual([finished, f.streamCount(), delegateTest._liveAbortCount(), f.registry.events.listenerCount('thread:closed')], [1, 0, 0, 0]);
});
