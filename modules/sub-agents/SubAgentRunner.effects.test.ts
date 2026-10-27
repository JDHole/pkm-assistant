import test from 'ava';
import { SubAgentRunner, SubTaskRegistry } from './index.js';
import { createMemoryDeleteTool, createWriteTool, MCPClient } from '../tools/index.js';

test('timeout podczas zgody nie pozwala na późny zapis', async t => {
    let content = 'pierwotna treść';
    const file = { path: 'Notes/a.md', extension: 'md' };
    const vault = { adapter: { exists: async () => true, read: async () => content, write: async (_path: string, value: string) => { content = value; } },
        getAbstractFileByPath: () => file, read: async () => content, modify: async (_file: unknown, value: string) => { content = value; } };
    const registry = new SubTaskRegistry();
    const controller = new AbortController();
    let entered!: () => void;
    const approvalEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: { result: string }) => void;
    const approval = new Promise<{ result: string }>(resolve => { release = resolve; });
    let completed!: () => void;
    const callCompleted = new Promise<void>(resolve => { completed = resolve; });
    const tool = { ...createWriteTool(), source: 'built-in' };
    const toolRegistry = { getTool: () => tool, filterByAgent: () => [tool] };
    const owner = { name: 'Owner', permissions: { guidance_mode: true } };
    const plugin = { subTaskRegistry: registry, agentManager: { getAgent: () => owner, getActiveAgent: () => owner },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: true }), requiresApproval: () => true },
        approvalManager: { requestApproval: async () => { entered(); return approval; } } };
    const client = new MCPClient({ vault } as never, plugin as never, toolRegistry as never);
    const runner = new SubAgentRunner({ app: { vault } as never, plugin: { ...plugin, mcpClient: { executeToolCall: async (...args: Parameters<typeof client.executeToolCall>) => {
        try { return await client.executeToolCall(...args); } finally { completed(); }
    } } } as never, toolRegistry: toolRegistry as never });
    let finished = 0;
    registry.events.on('task:finished', () => { finished++; });
    const run = runner.runTask('write', owner, config, modelFor([call('a', 'write', { path, content: 'nowa treść', mode: 'append' } as { path: string; content: string })]) as never,
        { abortSignal: controller.signal, abortReason: () => 'task-timeout' });
    await approvalEntered;
    controller.abort();
    const result = await run;
    release({ result: 'approve' });
    await callCompleted;
    t.is(content, 'pierwotna treść');
    t.deepEqual(result.outcome.end, { kind: 'timeout' });
    t.deepEqual(result.outcome.effects, []);
    t.is(finished, 1);
});

const path = 'Notes/a.md';
const call = (id: string, name = 'write', args = { path, content: 'secret' }) => ({
    id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
function modelFor(calls: ReturnType<typeof call>[]) {
    let count = 0;
    return { stream(_payload: unknown, handlers: { done(response: unknown): void }) {
        handlers.done({ choices: [{ message: count++ === 0
            ? { role: 'assistant', content: null, tool_calls: calls }
            : { role: 'assistant', content: 'done' } }] });
    } };
}
function setup(executeToolCall?: (call: unknown, agent: string, opts: { onExecutionStart?: () => void }, execute: (args: unknown) => Promise<unknown>) => Promise<unknown>,
    exists: (path: string) => Promise<boolean> = async () => true) {
    const registry = new SubTaskRegistry();
    const tool = { name: 'write', description: 'write', inputSchema: {}, execute: async (_args: unknown) => ({ success: true }) };
    const runner = new SubAgentRunner({
        app: { vault: { adapter: { exists } } },
        plugin: { subTaskRegistry: registry, ...(executeToolCall ? { mcpClient: { executeToolCall: (invocation: unknown, agent: string, opts: { onExecutionStart?: () => void }) =>
            executeToolCall(invocation, agent, opts, args => tool.execute(args)) } } : {}) },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
    });
    return { runner, registry };
}
const config = { name: 'worker', role: 'worker', tools: ['write'] } as never;
const agent = { name: 'Owner' };

test('runTask records MCP effect after admission and omits denied call', async t => {
    const { runner, registry } = setup(async (toolCall, _agent, opts, execute) => {
        const invocation = toolCall as { arguments: string };
        if (invocation.arguments.includes('denied')) return { success: false, error: 'denied' };
        opts.onExecutionStart?.();
        return execute(JSON.parse(invocation.arguments));
    });
    let finishedOutcome: unknown;
    registry.events.on('task:finished', (task: unknown) => { finishedOutcome = (task as { outcome?: unknown }).outcome; });
    const result = await runner.runTask('write', agent, config, modelFor([
        call('a'), call('b', 'write', { path: 'Notes/denied.md', content: 'denied' }),
    ]) as never);
    t.deepEqual(result.outcome?.effects, [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }], outcome: 'returned', check: 'matches' }]);
    t.is(result.outcome?.hasMaterial, true);
    t.is(registry.list()[0].outcome, result.outcome);
    t.is(registry.list()[0].result?.outcome, result.outcome);
    t.is(finishedOutcome, result.outcome);
    const checked = registry.list()[0].steps.find(step => step.type === 'effects.checked');
    t.deepEqual(checked?.fields, { matches: 1, mismatch: 0, 'not-checked': 0, unknown: 0 });
    t.false(JSON.stringify(checked).includes(path));
    t.false(JSON.stringify(result.outcome).includes('secret'));
});

test('runTask checks the path returned by a normalized write', async t => {
    const checked: string[] = [];
    const tool = { name: 'write', description: 'write', inputSchema: {}, execute: async (args: unknown) => {
        const actualPath = (args as { path: string }).path.replace('%61', 'a');
        return { success: true, path: actualPath };
    } };
    const runner = new SubAgentRunner({
        app: {}, plugin: { mcpClient: { async executeToolCall(invocation: { arguments: string }, _agent: string, opts: { onExecutionStart?: () => void }) {
            const args = JSON.parse(invocation.arguments) as { path: string; content: string };
            opts.onExecutionStart?.();
            return tool.execute(args);
        } } },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
        effectTargetIo: { async exists(target: string) { checked.push(target); return target === 'Notes/a.md'; } },
    });
    const result = await runner.runTask('write', agent, config,
        modelFor([call('a', 'write', { path: 'Notes/%61.md', content: 'secret' })]) as never);
    t.deepEqual(result.outcome.effects, [{ tool: 'write', action: 'replace',
        targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], outcome: 'returned', check: 'matches' }]);
    t.deepEqual(checked, ['Notes/a.md']);
});

test('runTask leaves an unconfirmed normalized target unchecked', async t => {
    const checked: string[] = [];
    const tool = { name: 'write', description: 'write', inputSchema: {}, execute: async () => ({ success: true }) };
    const runner = new SubAgentRunner({
        app: {}, plugin: { mcpClient: { async executeToolCall(_invocation: unknown, _agent: string, opts: { onExecutionStart?: () => void }) {
            opts.onExecutionStart?.();
            return tool.execute();
        } } },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
        effectTargetIo: { async exists(target: string) { checked.push(target); return true; } },
    });
    const result = await runner.runTask('write', agent, config,
        modelFor([call('a', 'write', { path: 'Notes/%61.md', content: 'secret' })]) as never);
    t.deepEqual(result.outcome.effects, [{ tool: 'write', action: 'replace',
        targets: [{ kind: 'vault-file', path: 'Notes/%61.md' }], outcome: 'returned', check: 'not-checked' }]);
    t.deepEqual(checked, []);
});

test('runTask fallback records returned and error effects', async t => {
    const { runner } = setup();
    const result = await runner.runTask('write', agent, config, modelFor([call('a')]) as never);
    t.deepEqual(result.outcome?.effects, [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }], outcome: 'returned', check: 'matches' }]);
    const failedTool = { name: 'write', description: 'write', inputSchema: {}, execute: async () => ({ success: false, error: 'failed' }) };
    const failedRunner = new SubAgentRunner({
        app: {}, plugin: {}, toolRegistry: { filterByAgent: () => [failedTool], getTool: () => failedTool },
    });
    const failed = await failedRunner.runTask('write', agent, config, modelFor([call('a')]) as never);
    t.deepEqual(failed.outcome.effects, [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }], outcome: 'error', check: 'not-checked' }]);
});

test('fallback starts the effect before execute and preserves unknown after Stop', async t => {
    const registry = new SubTaskRegistry();
    const controller = new AbortController();
    let taskId = '';
    const tool = { name: 'write', description: 'write', inputSchema: {}, execute: async () => {
        registry.requestStop(taskId);
        return new Promise<unknown>(() => {});
    } };
    const runner = new SubAgentRunner({
        app: { vault: { adapter: { exists: async () => false } } }, plugin: { subTaskRegistry: registry },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
    });
    const result = await runner.runTask('write', agent, config, modelFor([call('a')]) as never, {
        abortSignal: controller.signal, abortReason: () => 'manual-stop',
        onTaskCreated(task) { taskId = task.id; registry.attachAbort(task.id, () => controller.abort()); },
    });
    t.deepEqual(result.outcome.effects, [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }], outcome: 'unknown', cause: 'manual-stop', check: 'mismatch' }]);
});

for (const releaseAt of ['task:partial', 'appendSessionEvent'] as const) {
test(`terminal partial closes a held effect before ${releaseAt} releases it`, async t => {
    const registry = new SubTaskRegistry();
    const controller = new AbortController();
    let toolStarted!: () => void;
    const started = new Promise<void>(resolve => { toolStarted = resolve; });
    let returnTool!: (result: unknown) => void;
    const tool = { name: 'write', description: 'write', inputSchema: {}, execute: async () => {
        toolStarted();
        return new Promise<unknown>(resolve => { returnTool = resolve; });
    } };
    const runner = new SubAgentRunner({
        app: { vault: { adapter: { exists: async () => false } } },
        plugin: { subTaskRegistry: registry,
            agentManager: { getAgentMemory: () => ({ async appendSessionEvent() {
                if (releaseAt === 'appendSessionEvent') returnTool({ success: true, path });
            } }) },
            mcpClient: { async executeToolCall(_call: unknown, _agent: string, opts: { onExecutionStart?: () => void }) {
                opts.onExecutionStart?.();
                return tool.execute();
            } },
        },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
    });
    let taskId = '';
    registry.events.on('task:partial', task => {
        if (releaseAt === 'task:partial'
            && (task as { partial?: { stopReason: { kind: string } } }).partial?.stopReason.kind === 'manual-stop') {
            returnTool({ success: true, path });
        }
    });
    const run = runner.runTask('write', agent, config, modelFor([call('a')]) as never, {
        origin: { agentName: 'Owner', sessionPath: 'sessions/active/test.md' },
        abortSignal: controller.signal, abortReason: () => 'manual-stop',
        onTaskCreated(task) { taskId = task.id; registry.attachAbort(task.id, () => controller.abort()); },
    });
    await started;
    registry.requestStop(taskId);
    const result = await run;
    t.deepEqual(registry.getTask(taskId)?.partial?.toolOutcomes.map(item => item.outcome), ['unknown']);
    t.deepEqual(result.outcome, {
        end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false,
        effects: [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }],
            outcome: 'unknown', cause: 'manual-stop', check: 'mismatch' }],
    });
});
}

for (const [sender, expected] of [
    [undefined, 'user'], ['lead', 'lead'], ['system', 'system'],
] as const) {
    test(`runTask marks an in-flight MCP write unknown after ${expected} stop`, async t => {
        const controller = new AbortController();
        let registry!: SubTaskRegistry;
        let taskId = '';
        const fixture = setup(async (_call, _agent, opts) => {
            opts.onExecutionStart?.();
            registry.requestStop(taskId, sender);
            return new Promise<unknown>(() => {});
        });
        registry = fixture.registry;
        const result = await fixture.runner.runTask('write', agent, config, modelFor([call('a')]) as never, {
            abortSignal: controller.signal,
            abortReason: () => 'manual-stop',
            onTaskCreated(task) { taskId = task.id; registry.attachAbort(task.id, () => controller.abort()); },
        });
        t.deepEqual(result.outcome.effects, [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }], outcome: 'unknown', cause: 'manual-stop', check: 'matches' }]);
        t.deepEqual(result.outcome.end, { kind: 'stopped', by: expected });
        t.is(registry.getTask(taskId)?.stopRequestedBy, expected);
    });
}

test('runTask marks an in-flight MCP write unknown after task timeout', async t => {
    const controller = new AbortController();
    let complete!: (value: unknown) => void;
    const { runner } = setup(async (_call, _agent, opts) => {
        opts.onExecutionStart?.();
        controller.abort();
        return new Promise<unknown>(resolve => { complete = resolve; });
    });
    const result = await runner.runTask('write', agent, config, modelFor([call('a')]) as never, {
        abortSignal: controller.signal, abortReason: () => 'task-timeout',
    });
    t.deepEqual(result.outcome, {
        end: { kind: 'timeout' }, completeness: 'empty', hasAnswer: false, hasMaterial: false,
        effects: [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }], outcome: 'unknown', cause: 'task-timeout', check: 'matches' }],
    });
    complete({ success: true });
    await Promise.resolve();
    t.deepEqual(result.outcome.effects, [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }], outcome: 'unknown', cause: 'task-timeout', check: 'matches' }]);
});

for (const reason of ['manual-stop', 'task-timeout'] as const) {
    test(`runTask closes ${reason} effects before partial persistence settles`, async t => {
        const controller = new AbortController();
        const registry = new SubTaskRegistry();
        let releasePersistence!: () => void;
        let persistenceStarted!: () => void;
        const persistence = new Promise<void>(resolve => { releasePersistence = resolve; });
        const started = new Promise<void>(resolve => { persistenceStarted = resolve; });
        let toolStarted!: () => void;
        const startedTool = new Promise<void>(resolve => { toolStarted = resolve; });
        let returnTool!: (result: unknown) => void;
        const tool = { name: 'write', description: 'write', inputSchema: {}, execute: async () => {
            toolStarted();
            return new Promise<unknown>(resolve => { returnTool = resolve; });
        } };
        const runner = new SubAgentRunner({
            app: { vault: { adapter: { exists: async () => false } } },
            plugin: { subTaskRegistry: registry,
                agentManager: { getAgentMemory: () => ({ appendSessionEvent: async () => {
                    persistenceStarted();
                    await persistence;
                    return 'session';
                } }) },
                mcpClient: { async executeToolCall(_invocation: unknown, _agent: string, opts: { onExecutionStart?: () => void }) {
                    opts.onExecutionStart?.();
                    return tool.execute();
                } },
            },
            toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
        });
        let taskId = '';
        const run = runner.runTask('write', agent, config, modelFor([call('a')]) as never, {
            origin: { agentName: 'Owner', sessionPath: 'sessions/active/test.md' },
            abortSignal: controller.signal, abortReason: () => reason,
            onTaskCreated(task) { taskId = task.id; registry.attachAbort(task.id, () => controller.abort()); },
        });
        await startedTool;
        if (reason === 'manual-stop') registry.requestStop(taskId);
        else controller.abort();
        await started;
        returnTool({ success: true, path });
        await Promise.resolve();
        releasePersistence();
        const result = await run;
        t.deepEqual(result.outcome, {
            end: reason === 'manual-stop' ? { kind: 'stopped', by: 'user' } : { kind: 'timeout' },
            completeness: 'empty', hasAnswer: false, hasMaterial: false,
            effects: [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path }],
                outcome: 'unknown', cause: reason, check: 'mismatch' }],
        });
        t.deepEqual(registry.getTask(taskId)?.partial?.toolOutcomes.map(item => item.outcome), ['unknown']);
    });
}

test('parallel MCP calls update their own targets when results reverse', async t => {
    const pending: Array<{ path: string; resolve(result: unknown): void }> = [];
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const { runner } = setup(async (toolCall, _agent, opts) => {
        opts.onExecutionStart?.();
        const target = JSON.parse((toolCall as { arguments: string }).arguments).path as string;
        return new Promise(resolve => {
            pending.push({ path: target, resolve });
            if (pending.length === 2) ready();
        });
    });
    const run = runner.runTask('write twice', agent, config, modelFor([
        call('a', 'write', { path: 'Notes/a.md', content: 'one' }),
        call('b', 'write', { path: 'Notes/b.md', content: 'two' }),
    ]) as never);
    await started;
    pending[1].resolve({ success: false, error: 'failed' });
    pending[0].resolve({ success: true });
    const result = await run;
    t.deepEqual(result.outcome.effects, [
        { tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], outcome: 'returned', check: 'matches' },
        { tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path: 'Notes/b.md' }], outcome: 'error', check: 'not-checked' },
    ]);
});

test('target checks handle matches, mismatch, tool error, and IO error without stopping run', async t => {
    const registry = new SubTaskRegistry();
    const tool = { name: 'write', description: 'write', inputSchema: {}, execute: async () => ({ success: true }) };
    const runner = new SubAgentRunner({
        app: {}, plugin: { subTaskRegistry: registry, mcpClient: { async executeToolCall(invocation: { arguments: string }, _agent: string, opts: { onExecutionStart?: () => void }) {
            opts.onExecutionStart?.();
            return JSON.parse(invocation.arguments).path === 'Notes/error.md'
                ? { success: false, error: 'failed' } : { success: true };
        } } },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
        effectTargetIo: { async exists(target: string) {
            if (target.endsWith('throws.md')) throw new Error('IO');
            return target.endsWith('matches.md');
        } },
    });
    const result = await runner.runTask('write', agent, config, modelFor([
        call('a', 'write', { path: 'Notes/matches.md', content: 'one' }),
        call('b', 'write', { path: 'Notes/mismatch.md', content: 'two' }),
        call('c', 'write', { path: 'Notes/error.md', content: 'three' }),
        call('d', 'write', { path: 'Notes/throws.md', content: 'four' }),
    ]) as never);
    t.deepEqual(result.outcome.effects.map(effect => [effect.targets[0].path, effect.check]), [
        ['Notes/matches.md', 'matches'], ['Notes/mismatch.md', 'mismatch'],
        ['Notes/error.md', 'not-checked'], ['Notes/throws.md', 'not-checked'],
    ]);
    const checked = registry.list()[0].steps.find(step => step.type === 'effects.checked');
    t.deepEqual(checked?.fields, { matches: 1, mismatch: 1, 'not-checked': 2, unknown: 0 });
});

test('memory_save checks the vault-relative path returned by the memory tool', async t => {
    const memoryPath = '.pkm-assistant/agents/Owner/memory/brain/fact.md';
    const observed: string[] = [];
    const tool = { name: 'memory_save', description: 'save', inputSchema: {}, execute: async () => ({ success: true, path: memoryPath }) };
    const runner = new SubAgentRunner({
        app: { vault: { adapter: { async exists(target: string) { observed.push(target); return true; } } } },
        plugin: { agentManager: { getAgentMemory: () => ({ paths: { brainNotes: '.pkm-assistant/agents/Owner/memory/brain' } }) } },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
    });
    const result = await runner.runTask('save', agent, { name: 'worker', role: 'worker', tools: ['memory_save'] } as never,
        modelFor([{ id: 'save', type: 'function', function: { name: 'memory_save', arguments: JSON.stringify({ fact: 'text' }) } }]) as never);
    t.deepEqual(result.outcome.effects, [{ tool: 'memory_save', action: 'save', targets: [{ kind: 'memory-file', path: memoryPath }], outcome: 'returned', check: 'matches' }]);
    t.deepEqual(observed, [memoryPath]);
});

test('memory_delete checks absence at the vault-relative returned path', async t => {
    const memoryPath = '.pkm-assistant/agents/Owner/memory/brain/fact.md';
    const observed: string[] = [];
    const tool = { name: 'memory_delete', description: 'delete', inputSchema: {}, execute: async () => ({ success: true, path: memoryPath }) };
    const runner = new SubAgentRunner({
        app: { vault: { adapter: { async exists(target: string) { observed.push(target); return false; } } } },
        plugin: {}, toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
    });
    const result = await runner.runTask('delete', agent, { name: 'worker', role: 'worker', tools: ['memory_delete'] } as never,
        modelFor([{ id: 'delete', type: 'function', function: { name: 'memory_delete', arguments: JSON.stringify({ fact: 'text' }) } }]) as never);
    t.deepEqual(result.outcome.effects, [{ tool: 'memory_delete', action: 'delete', targets: [{ kind: 'memory-file', path: memoryPath }], outcome: 'returned', check: 'matches' }]);
    t.deepEqual(observed, [memoryPath]);
});

test('real memory_delete checks the removed note despite a conflicting filename', async t => {
    const brain = '.pkm-assistant/agents/Owner/memory/brain';
    const actualPath = `${brain}/real.md`;
    const checked: string[] = [];
    const removed: string[] = [];
    const memory = {
        agentName: 'Owner', paths: { brainNotes: brain },
        vault: { adapter: { async remove(target: string) { removed.push(target); } } },
        async listBrainNotes() { return [{ filename: 'real.md', name: 'real' }]; },
    };
    const tool = createMemoryDeleteTool();
    const runner = new SubAgentRunner({
        app: { vault: { adapter: { async exists(target: string) { checked.push(target); return false; } } } },
        plugin: { agentManager: { getAgentMemory: () => memory } },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
    });
    const result = await runner.runTask('delete', agent,
        { name: 'worker', role: 'worker', tools: ['memory_delete'] } as never,
        modelFor([{ id: 'delete', type: 'function', function: { name: 'memory_delete',
            arguments: JSON.stringify({ fact: 'real', filename: 'wrong.md' }) } }]) as never);
    t.deepEqual(removed, [actualPath]);
    t.deepEqual(checked, [actualPath]);
    t.deepEqual(result.outcome.effects, [{ tool: 'memory_delete', action: 'delete',
        targets: [{ kind: 'memory-file', path: actualPath }], outcome: 'returned', check: 'matches' }]);
});

test('real memory_delete stopped during remove has unknown effect without a target', async t => {
    const brain = '.pkm-assistant/agents/Owner/memory/brain';
    const controller = new AbortController();
    const registry = new SubTaskRegistry();
    let startedRemove!: () => void;
    const removeStarted = new Promise<void>(resolve => { startedRemove = resolve; });
    const checked: string[] = [];
    const memory = {
        agentName: 'Owner', paths: { brainNotes: brain },
        vault: { adapter: { async remove(_target: string) {
            startedRemove();
            return new Promise<void>(() => {});
        } } },
        async listBrainNotes() { return [{ filename: 'real.md', name: 'real' }]; },
    };
    const tool = createMemoryDeleteTool();
    const runner = new SubAgentRunner({
        app: { vault: { adapter: { async exists(target: string) { checked.push(target); return false; } } } },
        plugin: { subTaskRegistry: registry, agentManager: { getAgentMemory: () => memory } },
        toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
    });
    let taskId = '';
    const run = runner.runTask('delete', agent,
        { name: 'worker', role: 'worker', tools: ['memory_delete'] } as never,
        modelFor([{ id: 'delete', type: 'function', function: { name: 'memory_delete',
            arguments: JSON.stringify({ fact: 'real', path: 'wrong.md', filename: 'wrong.md' }) } }]) as never,
        { abortSignal: controller.signal, abortReason: () => 'manual-stop',
            onTaskCreated(task) { taskId = task.id; registry.attachAbort(task.id, () => controller.abort()); } });
    await removeStarted;
    registry.requestStop(taskId);
    const result = await run;
    t.deepEqual(result.outcome.effects, [{ tool: 'memory_delete', action: 'delete',
        targets: [], outcome: 'unknown', cause: 'manual-stop', check: 'not-checked' }]);
    t.deepEqual(checked, []);
});

test('successful read is material after failed synthesis while an erroneous read is empty', async t => {
    async function run(toolResult: unknown) {
        const tool = { name: 'read', description: 'read', inputSchema: {}, execute: async () => toolResult };
        const runner = new SubAgentRunner({
            app: {}, plugin: {}, toolRegistry: { filterByAgent: () => [tool], getTool: () => tool },
        });
        let count = 0;
        const model = { stream(_payload: unknown, handlers: { done(value: unknown): void; error(error: Error): void }) {
            if (count++ === 0) handlers.done({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                { id: 'read', type: 'function', function: { name: 'read', arguments: '{}' } },
            ] } }] });
            else handlers.error(new Error('synthesis failed'));
        } };
        return runner.runTask('read', agent, { name: 'worker', role: 'worker', tools: ['read'], max_iterations: 1 } as never, model as never);
    }
    const success = await run({ success: true, text: 'found' });
    t.deepEqual(success.outcome, { end: { kind: 'failed', stage: 'synthesis' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] });
    const error = await run({ success: false, error: 'missing' });
    t.deepEqual(error.outcome, { end: { kind: 'failed', stage: 'synthesis' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] });
});

test('runner catch publishes failed outcome through task:finished', async t => {
    const { runner, registry } = setup();
    let finished: unknown;
    registry.events.on('task:finished', (task: unknown) => { finished = task; });
    const model = { stream(_payload: unknown, handlers: { error(error: Error): void }) {
        handlers.error(new Error('model failed'));
    } };
    const result = await runner.runTask('write', agent, config, model as never);
    t.deepEqual(result.outcome, { end: { kind: 'failed', stage: 'work' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] });
    t.is(result.failed, true);
    t.is(registry.list()[0].status, 'error');
    t.is(registry.list()[0].outcome, result.outcome);
    t.is((finished as { outcome: unknown }).outcome, result.outcome);
});
