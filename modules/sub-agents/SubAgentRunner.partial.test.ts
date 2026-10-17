import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { SubTaskNotifier } from './SubTaskNotifier.js';
import { buildStripModel } from './subTaskPanelModel.js';

function setup() {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    const delivered: string[] = [];
    notifier.setDeliverer(task => { delivered.push(task.status); return true; });
    const tool = { name: 'create_folder', description: 'create', inputSchema: {}, execute: async () => 'created Notes/U3; effects unverified' };
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry }, toolRegistry: {
        filterByAgent: () => [tool], getTool: () => tool,
    } });
    return { runner, registry, notifier, delivered };
}

test('partial stays visible while synthesis is held and failure retains real work', async t => {
    const { runner, registry, notifier, delivered } = setup();
    let synthesis!: { done: (response: unknown) => void; error: (error: Error) => void };
    let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    let calls = 0;
    const cause = new Error('synthesis disconnected');
    const model = { stream(_payload: unknown, handlers: typeof synthesis) {
        calls++;
        if (calls === 1) handlers.done({ choices: [{ message: { content: '', tool_calls: [{ id: 'folder-1', type: 'function', function: { name: 'create_folder', arguments: '{}' } }] } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
        else { synthesis = handlers; ready(); }
    } };
    const run = runner.runTask('create folder', { name: 'Owner A' }, { name: 'worker', tools: ['create_folder'], max_iterations: 1 } as never, model as never, { background: true, origin: { agentName: 'Owner A', tabKey: 'tab-a' } });
    await held;
    t.teardown(() => { synthesis.error(cause); notifier.dispose(); registry.dispose(); });
    const task = registry.list()[0];
    const partial = (task as typeof task & { partial?: { text: string; toolsUsed: readonly string[] } }).partial;
    t.deepEqual(partial?.toolsUsed, ['create_folder']);
    t.true(partial?.text.includes('created Notes/U3; effects unverified'));
    t.is(task.status, 'running');
    t.is(task.endedAt, undefined);
    t.deepEqual(delivered, []);
    const row = buildStripModel({ tasks: [task], tabKey: 'tab-a', agentName: 'Owner A' })[0];
    t.true(row.outcome.includes('created Notes/U3; effects unverified'));
    synthesis.error(cause);
    const result = await run;
    t.is(result.failed, true);
    t.is(result.stoppedBy, 'error');
    t.deepEqual(result.toolsUsed, ['create_folder']);
    t.deepEqual(result.toolCallDetails, [{ name: 'create_folder', resultPreview: 'created Notes/U3; effects unverified' }]);
    t.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 3 });
    t.true(result.result.includes('synthesis disconnected'));
    t.is(task.status, 'error');
    t.deepEqual(delivered, ['error']);
    t.is(calls, 2);
    notifier.dispose(); registry.dispose();
});
