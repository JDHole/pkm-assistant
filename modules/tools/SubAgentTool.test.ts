import test from 'ava';
import { createDelegateTool, createSubAgentTool } from './DelegateTool.js';
import { SubTaskRegistry } from '../sub-agents/index.js';
import { t as tr } from '../../core/i18n/index.js';
import { countTokens } from '../../core/index.js';

test('sub_agent handles owned thread actions and rejects a different owner', async (t) => {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const origin = { ...owner, tabKey: 'tab-1' };
    const registry = new SubTaskRegistry();
    const thread = registry.createThread({ threadId: 'sub-id-1', name: 'Worker', owner, origin, config: {}, phase: 'running' });
    const run = registry.create({ id: 'run-1', name: 'Worker', agentName: owner.agentName, threadId: thread.threadId, origin });
    run.outcome = { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] };
    registry.attachAbort(run.id, () => undefined);
    const tool = createSubAgentTool({});
    const plugin = { subTaskRegistry: registry } as never;
    const call = (args: Record<string, unknown>) => tool.execute({ ...args, _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin);

    t.deepEqual(await call({ action: 'message', sub_id: 'sub-id-1', text: 'Check this detail.' }), {
        success: true, message: tr('mcp.sub_agent.message_sent', { sub_id: 'sub-id-1' }),
    });
    t.is(registry.takeMessages(run.id).join(''), 'Check this detail.');
    t.deepEqual(await call({ action: 'stop', sub_id: 'sub-id-1' }), {
        success: true, message: tr('mcp.sub_agent.stopped', { sub_id: 'sub-id-1' }),
    });
    t.is(run.stopRequestedBy, 'lead');
    registry.endRun(thread.threadId, { successful: true });
    t.deepEqual(await call({ action: 'list' }), {
        success: true,
        threads: [{ sub_id: 'sub-id-1', name: 'Worker', phase: 'idle', runs: 1, outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed' } }],
    });
    t.deepEqual(await tool.execute({ action: 'close', sub_id: 'sub-id-1', _invocationOrigin: { ...owner, sessionEpoch: 'epoch-2' } }, {}, plugin), {
        success: false, error: tr('mcp.sub_agent.owner_mismatch'),
    });
    t.deepEqual(await call({ action: 'close', sub_id: 'sub-id-1' }), {
        success: true, message: tr('mcp.sub_agent.closed', { sub_id: 'sub-id-1' }),
    });
    t.is(registry.getThread('sub-id-1')?.phase, 'closed');
});
import { __test__ as modelTest } from '../models/index.js';
import type { DelegatePlugin, SubAgentConfigLike } from './DelegateTool.js';

class ModelStub {
    modelId: string;
    providerId: string;
    onStream: (modelId: string) => void;
    constructor(options: { modelId?: string; adapter?: string; onStream?: (modelId: string) => void }) {
        this.modelId = options.modelId || 'worker-model';
        this.providerId = options.adapter || 'ollama';
        this.onStream = options.onStream || (() => undefined);
    }
    stream(_payload: unknown, callbacks: { done(response: unknown): void }) {
        this.onStream(this.modelId);
        callbacks.done({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }
}
const providerIds = ['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'];
function makePlugin(registry: SubTaskRegistry, onStream: (modelId: string) => void = () => undefined): DelegatePlugin {
    const providers = Object.fromEntries(providerIds.map(id => [id, { info: { id }, __testModelClass: ModelStub, __onStream: onStream }]));
    return {
        toolRegistry: {},
        currentAutonomy: 'yolo',
        agentManager: { getActiveAgent: () => ({ name: 'Mira', activeSubAgents: [] }) },
        env: {
            config: { chat: { providers, http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) }, transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
            settings: { pkmAssistant: { chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } }, modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] } } },
        },
        subTaskRegistry: registry,
    } as unknown as DelegatePlugin;
}
modelTest.setChatModelFactory(deps => {
    const provider = deps.provider as unknown as { info: { id: string }; __testModelClass: typeof ModelStub; __onStream: (modelId: string) => void };
    return new provider.__testModelClass({ modelId: deps.ctx.modelId, adapter: provider.info.id, onStream: provider.__onStream }) as never;
});

function seedIdleThread(registry: SubTaskRegistry, userStop = false) {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const thread = registry.createThread({
        threadId: 'sub-id-task', name: 'Worker', owner, origin: { ...owner, tabKey: 'tab-1' }, phase: 'running',
        config: { subConfig: { name: 'Worker', description: 'Worker', tools: [], role: 'researcher' } as SubAgentConfigLike,
            options: { delegationDepth: 1 }, limits: {}, modelId: 'worker-model', providerId: 'ollama' },
    });
    thread.runIds.push('previous-run');
    registry.endRun(thread.threadId, { successful: true, userStop });
    return { owner, thread };
}

function acceptedRunner(registry: SubTaskRegistry) {
    return {
        runTask: async (_task: string, _agent: unknown, _config: unknown, _model: unknown, options: { threadId?: string; origin?: { agentName: string; sessionPath?: string; sessionEpoch?: string }; turnKind?: 'user' | 'machine'; turnStartedSeq?: number; onTaskCreated?: (task: import('../sub-agents/index.js').SubTask) => void }) => {
            const threadId = options.threadId!;
            const owner = options.origin!;
            if (!(registry as SequenceRegistry).beginRun(threadId, owner, { turnKind: options.turnKind, turnStartedSeq: options.turnStartedSeq })) return { result: tr('subagent.thread_refused'), failed: true as const } as never;
            const task = registry.create({ id: 'next-run', name: 'Worker', agentName: owner.agentName, threadId, origin: options.origin });
            registry.attachAbort(task.id, () => undefined);
            options.onTaskCreated?.(task);
            const outcome = { end: { kind: 'finished' as const }, completeness: 'unconfirmed' as const, hasAnswer: true, hasMaterial: true, effects: [] };
            registry.endRun(threadId, { successful: true, answer: 'done' });
            return { result: 'done', outcome, toolsUsed: [], toolCallDetails: [], duration: 1 } as never;
        },
    };
}

// The admission context belongs to this attempt, never to the frozen thread config.
type TurnAdmission = { turnKind?: 'user' | 'machine'; turnStartedSeq?: number };
type SequenceRegistry = SubTaskRegistry & {
    issueTurnStartSequence(): number;
    beginRun(id: string, owner: { agentName: string; sessionPath?: string; sessionEpoch?: string }, turn: TurnAdmission): boolean;
};

function stoppedThread(registry: SequenceRegistry) {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const thread = registry.createThread({
        threadId: 'sub-id-task', name: 'Worker', owner, origin: { ...owner, tabKey: 'tab-1' }, phase: 'running',
        config: { subConfig: { name: 'Worker', description: 'Worker', tools: [], role: 'researcher' } as SubAgentConfigLike,
            options: { delegationDepth: 1 }, limits: {}, modelId: 'worker-model', providerId: 'ollama' },
    });
    const previous = registry.create({ id: 'previous-run', name: 'Worker', agentName: owner.agentName, threadId: thread.threadId, origin: owner });
    registry.attachAbort(previous.id, () => undefined);
    return { owner, thread, previous };
}

function sequenceRunner(registry: SequenceRegistry, id: string, beforeAdmission: () => Promise<void> = async () => undefined) {
    return { runTask: async (_task: string, _agent: unknown, _config: unknown, _model: unknown, options: {
        threadId?: string; origin?: { agentName: string; sessionPath?: string; sessionEpoch?: string };
        turnKind?: 'user' | 'machine'; turnStartedSeq?: number;
        onTaskCreated?: (task: import('../sub-agents/index.js').SubTask) => void;
    }) => {
        await beforeAdmission();
        const owner = options.origin!;
        if (!registry.beginRun(options.threadId!, owner, { turnKind: options.turnKind, turnStartedSeq: options.turnStartedSeq })) {
            return { result: tr('subagent.thread_refused'), failed: true as const } as never;
        }
        const task = registry.create({ id, name: 'Worker', agentName: owner.agentName, threadId: options.threadId!, origin: owner });
        registry.attachAbort(id, () => undefined);
        options.onTaskCreated?.(task);
        return { result: 'done', outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] }, toolsUsed: [], toolCallDetails: [], duration: 1 } as never;
    } };
}

test.serial('A2: old user turn is refused after a real Stop; newer user turn resumes', async t => {
    const registry = new SubTaskRegistry() as SequenceRegistry;
    const old = registry.issueTurnStartSequence();
    const { owner, thread, previous } = stoppedThread(registry);
    t.is(Number(old), 1);
    t.true(registry.requestStop(previous.id, 'user'));
    registry.endRun(thread.threadId, { successful: true });
    const tool = createSubAgentTool({}, { makeRunner: () => sequenceRunner(registry, 'next-run') });
    const call = (seq: number) => tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', _invocationOrigin: owner, _invocationTurnKind: 'user', _invocationTurnStartedSeq: seq }, {}, makePlugin(registry));
    const result = await call(old);
    t.deepEqual(result, { success: false, error: tr('mcp.sub_agent.user_stopped') });
    t.deepEqual(thread.runIds, ['previous-run']);
    t.is(thread.phase, 'idle');
    t.is(thread.userStop, true);
    t.is(Number(thread.lastUserStopSeq), 2);
    const nextSeq = registry.issueTurnStartSequence();
    t.is(Number(nextSeq), 3);
    const next = await call(nextSeq) as Record<string, unknown>;
    t.deepEqual({ success: next.success, started: next.started, sub_id: next.sub_id }, { success: true, started: true, sub_id: 'sub-id-task' });
    t.deepEqual(thread.runIds, ['previous-run', 'next-run']);
    t.is(thread.userStop, false);
    t.is(Number(thread.lastUserStopSeq), 2);
});

test.serial('A2: old user turn remains refused after a newer turn resumed the thread', async t => {
    const registry = new SubTaskRegistry() as SequenceRegistry;
    const old = registry.issueTurnStartSequence();
    const { owner, thread, previous } = stoppedThread(registry);
    t.true(registry.requestStop(previous.id, 'user'));
    registry.endRun(thread.threadId, { successful: true });
    let id = 'next-run';
    const tool = createSubAgentTool({}, { makeRunner: () => sequenceRunner(registry, id) });
    const call = (seq: number) => tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', _invocationOrigin: owner, _invocationTurnKind: 'user', _invocationTurnStartedSeq: seq }, {}, makePlugin(registry));
    const next = await call(registry.issueTurnStartSequence()) as Record<string, unknown>;
    t.is(next.success, true);
    registry.endRun(thread.threadId, { successful: true });
    t.deepEqual(await call(old), { success: false, error: tr('mcp.sub_agent.user_stopped') });
    t.deepEqual(thread.runIds, ['previous-run', 'next-run']);
    id = 'third-run';
    const third = await call(registry.issueTurnStartSequence()) as Record<string, unknown>;
    t.is(third.success, true);
    t.deepEqual(thread.runIds, ['previous-run', 'next-run', 'third-run']);
});

test.serial('A2: Stop between precheck and beginRun rejects the older attempt atomically', async t => {
    const registry = new SubTaskRegistry() as SequenceRegistry;
    const old = registry.issueTurnStartSequence();
    const { owner, thread } = stoppedThread(registry);
    registry.endRun(thread.threadId, { successful: true });
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const atGate = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const tool = createSubAgentTool({}, { makeRunner: () => ++calls === 1
        ? sequenceRunner(registry, 'old-run', async () => { entered(); await paused; })
        : sequenceRunner(registry, 'newer-run') });
    const call = (seq: number) => tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', _invocationOrigin: owner, _invocationTurnKind: 'user', _invocationTurnStartedSeq: seq }, {}, makePlugin(registry));
    const first = call(old);
    await atGate;
    const newer = await call(registry.issueTurnStartSequence()) as Record<string, unknown>;
    t.is(newer.success, true);
    t.true(registry.requestStop('newer-run', 'user'));
    registry.endRun(thread.threadId, { successful: true });
    release();
    const result = await first as Record<string, unknown>;
    t.is(result.success, false);
    t.is(thread.phase, 'idle');
    t.is(thread.userStop, true);
    t.deepEqual(thread.runIds, ['previous-run', 'newer-run']);
});

test('task after user Stop requires a user turn and clears userStop only after registry admission', async (t) => {
    const registry = new SubTaskRegistry() as SequenceRegistry;
    const { owner, thread, previous } = stoppedThread(registry);
    t.true(registry.requestStop(previous.id, 'user'));
    registry.endRun(thread.threadId, { successful: true });
    const seq = registry.issueTurnStartSequence();
    const plugin = makePlugin(registry);
    const tool = createSubAgentTool({}, { makeRunner: () => acceptedRunner(registry) });
    const machine = await tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue the analysis', _invocationOrigin: owner, _invocationTurnKind: 'machine', _invocationTurnStartedSeq: seq }, {}, plugin);
    t.deepEqual(machine, { success: false, error: tr('mcp.sub_agent.user_stopped') });
    t.true(thread.userStop);
    const result = await tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue the analysis', _invocationOrigin: owner, _invocationTurnKind: 'user', _invocationTurnStartedSeq: seq }, {}, plugin) as Record<string, unknown>;
    t.is(result.success, true);
    t.is(result.started, true);
    t.is(result.sub_id, thread.threadId);
    t.false(thread.userStop);
});

test('two concurrent task calls reserve only one run on a thread', async (t) => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    const plugin = makePlugin(registry);
    let release!: () => void;
    let admitted = 0;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const tool = createSubAgentTool({}, { makeRunner: () => ({
        runTask: async (_task: string, _agent: unknown, _config: unknown, _model: unknown, options: { threadId?: string; origin?: { agentName: string; sessionPath?: string; sessionEpoch?: string }; onTaskCreated?: (task: import('../sub-agents/index.js').SubTask) => void }) => {
            t.true(registry.beginRun(options.threadId!, options.origin!));
            admitted++;
            const task = registry.create({ id: `concurrent-${admitted}`, name: 'Worker', agentName: options.origin!.agentName, threadId: options.threadId!, origin: options.origin });
            options.onTaskCreated?.(task);
            await paused;
            registry.endRun(options.threadId!, { successful: true });
            return { result: 'done', outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] }, toolsUsed: [], toolCallDetails: [], duration: 1 } as never;
        },
    }) });
    const call = () => tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false, _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin);
    const first = call();
    await Promise.resolve();
    await Promise.resolve();
    const second = await call();
    t.deepEqual(second, { success: false, error: tr('mcp.sub_agent.task_state') });
    release();
    const firstResult = await first as Record<string, unknown>;
    t.is(firstResult.success, true);
    t.is(firstResult.sub_id, thread.threadId);
    t.is(admitted, 1);
});

test('sub_agent never accepts a model supplied owner and fails closed on incomplete owner keys', async (t) => {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const registry = new SubTaskRegistry();
    const thread = registry.createThread({ threadId: 'owned', name: 'Worker', owner, origin: owner, config: {}, phase: 'idle' });
    const tool = createSubAgentTool({});
    const plugin = { subTaskRegistry: registry } as never;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    t.false(Object.hasOwn(properties, 'owner'));
    const badOwners: Array<Partial<typeof owner>> = [
        { ...owner, agentName: 'Other' },
        { ...owner, sessionPath: 'sessions/two.md' },
        { ...owner, sessionEpoch: 'epoch-2' },
        { agentName: owner.agentName, sessionPath: owner.sessionPath },
    ];
    for (const invocationOwner of badOwners) {
        t.deepEqual(await tool.execute({ action: 'close', sub_id: thread.threadId, _invocationOrigin: invocationOwner }, {}, plugin), {
            success: false, error: tr(invocationOwner.sessionEpoch ? 'mcp.sub_agent.owner_mismatch' : 'mcp.sub_agent.owner_missing'),
        });
    }
    t.deepEqual(await tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', _invocationOrigin: owner }, {}, plugin), {
        success: false, error: tr('mcp.sub_agent.task_not_reusable'),
    });
});

test('approval context contains sub id and the entire task or message with an empty target', (t) => {
    const tool = createSubAgentTool({});
    t.deepEqual(tool.contextExtractor({ action: 'task', sub_id: 'sub-7', task: 'Do all of this exact work' }), {
        targetPath: '', approvalContext: { subAgentId: 'sub-7', subAgentAction: 'task', subAgentText: 'Do all of this exact work' },
    });
    t.deepEqual(tool.contextExtractor({ action: 'message', sub_id: 'sub-7', text: 'Use this new finding' }), {
        targetPath: '', approvalContext: { subAgentId: 'sub-7', subAgentAction: 'message', subAgentText: 'Use this new finding' },
    });
});

test('message, stop and close refuse invalid phases and exhausted message queue', async t => {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const registry = new SubTaskRegistry({ maxMessagesPerTask: 1 });
    const running = registry.createThread({ threadId: 'running', name: 'Worker', owner, origin: owner, config: {}, phase: 'running' });
    const run = registry.create({ id: 'run-active', name: 'Worker', agentName: owner.agentName, threadId: running.threadId, origin: owner });
    const idle = registry.createThread({ threadId: 'idle', name: 'Worker', owner, origin: owner, config: {}, phase: 'running' });
    registry.endRun(idle.threadId, { successful: true });
    const closed = registry.createThread({ threadId: 'closed', name: 'Worker', owner, origin: owner, config: {}, phase: 'idle' });
    registry.closeThread(closed.threadId);
    const tool = createSubAgentTool({});
    const plugin = { subTaskRegistry: registry } as never;
    const call = (action: string, sub_id: string, text?: string) => tool.execute({ action, sub_id, text, _invocationOrigin: owner }, {}, plugin);
    t.deepEqual(await call('message', 'idle', 'text'), { success: false, error: tr('mcp.sub_agent.message_state') });
    t.deepEqual(await call('stop', 'idle'), { success: false, error: tr('mcp.sub_agent.stop_state') });
    t.deepEqual(await call('close', 'running'), { success: false, error: tr('mcp.sub_agent.close_state') });
    t.deepEqual(await call('message', 'closed', 'text'), { success: false, error: tr('mcp.sub_agent.message_state') });
    t.deepEqual(await call('stop', 'closed'), { success: false, error: tr('mcp.sub_agent.stop_state') });
    t.deepEqual(await call('close', 'closed'), { success: false, error: tr('mcp.sub_agent.close_state') });
    t.deepEqual(await call('stop', 'running'), { success: false, error: tr('mcp.sub_agent.stop_unavailable') });
    t.deepEqual(await call('message', 'running', 'first'), { success: true, message: tr('mcp.sub_agent.message_sent', { sub_id: 'running' }) });
    t.deepEqual(await call('message', 'running', 'second'), { success: false, error: tr('mcp.sub_agent.message_rejected') });
    t.is(registry.getTask(run.id)?.status, 'running');
});

test('user Stop blocks machine and unmarked turns, and failed admission preserves userStop', async t => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    t.true(registry.beginRun(thread.threadId, owner));
    const run = registry.create({ id: 'stopped-by-user', name: 'Worker', agentName: owner.agentName, threadId: thread.threadId, origin: owner });
    registry.attachAbort(run.id, () => undefined);
    t.true(registry.requestStop(run.id, 'user'));
    registry.endRun(thread.threadId, { successful: true });
    const plugin = makePlugin(registry);
    let reachedRunner = false;
    const tool = createSubAgentTool({}, { makeRunner: () => ({ runTask: async (_task: string, _agent: unknown, _config: unknown, _model: unknown, options: { threadId?: string; origin?: import('../sub-agents/index.js').SubTaskOrigin }) => {
        reachedRunner = true;
        t.false(registry.beginRun(options.threadId!, { ...options.origin!, sessionEpoch: 'wrong' }));
        return { result: tr('subagent.thread_refused'), failed: true as const } as never;
    } }) });
    const call = (turnKind?: string) => tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', _invocationOrigin: owner,
        ...(turnKind ? { _invocationTurnKind: turnKind } : {}), _invocationTurnStartedSeq: registry.issueTurnStartSequence(), background: false }, {}, plugin);
    t.deepEqual(await call('machine'), { success: false, error: tr('mcp.sub_agent.user_stopped') });
    t.deepEqual(await call(), { success: false, error: tr('mcp.sub_agent.user_stopped') });
    t.true(thread.userStop);
    const refused = await call('user') as Record<string, unknown>;
    t.true(reachedRunner);
    t.is(refused.success, false);
    t.true(thread.userStop);
    t.is(thread.phase, 'idle');
});

test('task directs the lead to delegate after run ceiling, transcript ceiling and failed run', async t => {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const cases = [
        { name: 'runs', options: { maxThreadRuns: 1 }, end: { successful: true } },
        { name: 'transcript', options: { maxThreadTranscriptChars: 1 }, end: { successful: true, answer: 'too many characters' } },
        { name: 'failure', options: {}, end: { successful: false } },
    ];
    for (const row of cases) {
        const registry = new SubTaskRegistry(row.options);
        const thread = registry.createThread({ threadId: row.name, name: 'Worker', owner, origin: owner, config: {}, phase: 'running' });
        registry.create({ id: `${row.name}-run`, name: 'Worker', agentName: owner.agentName, threadId: thread.threadId, origin: owner });
        registry.endRun(thread.threadId, row.end);
        const result = await createSubAgentTool({}).execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, { subTaskRegistry: registry } as never);
        t.deepEqual(result, { success: false, error: tr('mcp.sub_agent.task_not_reusable') });
        t.is(thread.phase, 'closed');
    }
});

test('task directs the lead to delegate after the runner exceeds its model context budget', async t => {
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const registry = new SubTaskRegistry();
    const plugin = makePlugin(registry);
    const thread = registry.createThread({
        threadId: 'context-budget', name: 'Worker', owner, origin: owner, phase: 'running',
        config: {
            subConfig: { name: 'Worker', description: 'Worker', role: 'researcher', tools: [], scope: null,
                model: null, max_iterations: null, min_iterations: null, max_tool_result_length: null,
                enabled: true, prompt: '' },
            options: { delegationDepth: 1 }, toolNames: [],
            limits: { subagent_thread_context_tokens: 12000 }, modelId: 'worker-model', providerId: 'ollama',
        },
    });
    registry.create({ id: 'context-first-run', name: 'Worker', agentName: owner.agentName, threadId: thread.threadId, origin: owner });
    registry.endRun(thread.threadId, { successful: true, transcript: [{ role: 'assistant', content: 'x'.repeat(50000) }] });
    t.is(thread.phase, 'idle');
    t.true(thread.reusable);
    t.true(JSON.stringify(thread.transcript).length < 200000);
    t.true(countTokens(JSON.stringify(thread.transcript)) + 4096 > 12000);

    const tool = createSubAgentTool({});
    const result = await tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin) as Record<string, unknown>;
    t.is(result.success, false);
    t.is(result.error, tr('subagent.thread_refused'));
    t.is(result.stopped_by, 'error');
    t.is(result.note, tr('mcp.sub_agent.task_not_reusable'));
    t.false(Object.hasOwn(result, 'sub_id'));
    t.is(thread.phase, 'closed');
    t.is(thread.runIds.length, 2);
});

test('failed continuation that closes its thread directs the lead to delegate a new sub-agent', async (t) => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    const plugin = makePlugin(registry);
    const tool = createSubAgentTool({}, { makeRunner: () => ({
        runTask: async (_task: string, _agent: unknown, _config: unknown, _model: unknown, options: { threadId?: string; origin?: { agentName: string; sessionPath?: string; sessionEpoch?: string } }) => {
            t.true(registry.beginRun(options.threadId!, options.origin!));
            registry.endRun(options.threadId!, { successful: false });
            return { result: 'thread refused', failed: true as const } as never;
        },
    }) });
    const result = await tool.execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false, _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin) as Record<string, unknown>;
    t.is(result.success, false);
    t.is(result.note, tr('mcp.sub_agent.task_not_reusable'));
    t.false(Object.hasOwn(result, 'sub_id'));
});

test('task keeps the frozen worker model after the library default changes and retains its conversation', async t => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    (thread.config.subConfig as SubAgentConfigLike).role = 'worker';
    const priorTranscript = [{ role: 'user' as const, content: 'Previous task' }, { role: 'assistant' as const, content: 'Previous answer' }];
    thread.transcript = structuredClone(priorTranscript);
    const modelIds: string[] = [];
    const plugin = makePlugin(registry, modelId => modelIds.push(modelId));
    const settings = plugin.env!.settings!.pkmAssistant as unknown as { modelLibrary: { main: Array<{ platform: string; model: string; isDefault: boolean }> }; limits: Record<string, number> };
    settings.modelLibrary.main = [
        { platform: 'ollama', model: 'worker-model', isDefault: false },
        { platform: 'ollama', model: 'new-default-model', isDefault: true },
    ];
    settings.limits = { delegation_timeout_ms: 100 };

    const result = await createSubAgentTool({}).execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin) as Record<string, unknown>;
    t.is(result.success, true);
    t.is(result.sub_id, 'sub-id-task');
    t.deepEqual(modelIds, ['worker-model']);
    t.is(thread.phase, 'idle');
    t.true(thread.reusable);
    t.deepEqual(thread.transcript.slice(0, 2), priorTranscript);
});

test('task refuses a removed frozen model before starting a run', async t => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    const plugin = makePlugin(registry);
    const settings = plugin.env!.settings!.pkmAssistant as unknown as { modelLibrary: { minion: Array<{ platform: string; model: string; isDefault: boolean }> } };
    settings.modelLibrary.minion = [{ platform: 'ollama', model: 'new-default-model', isDefault: true }];

    const result = await createSubAgentTool({}).execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin);
    t.deepEqual(result, { success: false, error: tr('mcp.sub_agent.model_unavailable') });
    t.false(thread.reusable);
    t.is(thread.phase, 'closed');
    t.is(thread.runIds.length, 1);
});

test('task refuses a removed frozen provider before starting a run', async t => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    const plugin = makePlugin(registry);
    const providers = plugin.env!.config!.chat!.providers as Record<string, unknown>;
    delete providers.ollama;

    const result = await createSubAgentTool({}).execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin);
    t.deepEqual(result, { success: false, error: tr('mcp.sub_agent.model_unavailable') });
    t.false(thread.reusable);
    t.is(thread.runIds.length, 1);
});

test('task keeps a frozen model pinned in the sub-agent config outside the library', async t => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    (thread.config.subConfig as SubAgentConfigLike).model = 'ollama/worker-model';
    const modelIds: string[] = [];
    const plugin = makePlugin(registry, modelId => modelIds.push(modelId));
    const settings = plugin.env!.settings!.pkmAssistant as unknown as { modelLibrary: { minion: Array<{ platform: string; model: string; isDefault: boolean }> }; limits: Record<string, number> };
    settings.modelLibrary.minion = [{ platform: 'ollama', model: 'new-default-model', isDefault: true }];
    settings.limits = { delegation_timeout_ms: 100 };

    const result = await createSubAgentTool({}).execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin) as Record<string, unknown>;
    t.is(result.success, true);
    t.deepEqual(modelIds, ['worker-model']);
    t.true(thread.reusable);
});

test('delegate worker with an agent main model outside the library remains reusable for task', async t => {
    const registry = new SubTaskRegistry();
    const owner = { agentName: 'Mira', sessionPath: 'sessions/one.md', sessionEpoch: 'epoch-1' };
    const modelIds: string[] = [];
    const plugin = makePlugin(registry, modelId => modelIds.push(modelId));
    (plugin as unknown as { toolRegistry: { getTool: () => undefined; filterByAgent: () => Array<{ name: string }> } }).toolRegistry = {
        getTool: () => undefined, filterByAgent: () => [{ name: 'read' }],
    };
    plugin.agentManager = {
        getActiveAgent: () => ({ name: 'Mira', activeSubAgents: [], models: { main: { platform: 'ollama', model: 'manual-worker' } } }),
        resolveSubAgentConfig: () => null,
    };
    const settings = plugin.env!.settings!.pkmAssistant as unknown as {
        modelLibrary: Record<string, Array<{ platform: string; model: string; isDefault: boolean }>>;
        limits: Record<string, number>;
    };
    settings.modelLibrary = { main: [{ platform: 'ollama', model: 'another-library-model', isDefault: true }] };
    settings.limits = { delegation_timeout_ms: 2000, max_delegation_depth: 2 };

    const delegated = await createDelegateTool({}).execute({ task: 'First task', aspect: 'worker', background: false,
        _invocationOrigin: owner, _invocationDelegationDepth: 1 }, {}, plugin) as Record<string, unknown>;
    t.is(delegated.success, true);
    t.is(typeof delegated.sub_id, 'string');
    const threadId = delegated.sub_id as string;
    const thread = registry.getThread(threadId);
    t.is(thread?.phase, 'idle');
    t.true(thread?.reusable);
    const priorTranscript = structuredClone(thread?.transcript);
    t.is(priorTranscript?.length, 2);

    const continued = await createSubAgentTool({}).execute({ action: 'task', sub_id: threadId, task: 'Second task', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user', _invocationDelegationDepth: 1 }, {}, plugin) as Record<string, unknown>;
    t.is(continued.success, true);
    t.is(continued.sub_id, threadId);
    t.deepEqual(modelIds, ['manual-worker', 'manual-worker']);
    t.is(thread?.phase, 'idle');
    t.true(thread?.reusable);
    t.deepEqual(thread?.transcript.slice(0, 2), priorTranscript);
});

test('a pre-run refusal keeps a reusable thread conversation', async t => {
    const registry = new SubTaskRegistry();
    const { owner, thread } = seedIdleThread(registry);
    const priorTranscript = [{ role: 'user' as const, content: 'Previous task' }];
    thread.transcript = structuredClone(priorTranscript);
    const plugin = makePlugin(registry);
    plugin.agentManager = null;

    const result = await createSubAgentTool({}).execute({ action: 'task', sub_id: thread.threadId, task: 'Continue', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin) as Record<string, unknown>;
    t.is(result.success, false);
    t.is(result.error, tr('mcp.delegate.no_agent_manager'));
    t.is(thread.phase, 'idle');
    t.true(thread.reusable);
    t.deepEqual(thread.transcript, priorTranscript);
    t.is(thread.runIds.length, 1);
});
