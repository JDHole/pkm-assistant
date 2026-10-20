import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { SubTaskNotifier } from './SubTaskNotifier.js';
import { buildStripModel } from './subTaskPanelModel.js';
import { t as tr } from '../../core/i18n/index.js';

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
    const row = buildStripModel({ tasks: [task], threads: registry.listThreads({ agentName: 'Owner A' }), tabKey: 'tab-a', agentName: 'Owner A' })[0];
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
    t.true(typeof result.handoff === 'string' && result.handoff.includes(tr('subagent.handoff.effects')));
    t.is(task.result?.handoff, result.handoff);
    t.deepEqual(delivered, ['error']);
    t.is(calls, 2);
    notifier.dispose(); registry.dispose();
});

test('natural unconfirmed result has no handoff', async t => {
    const registry = new SubTaskRegistry();
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry }, toolRegistry: { filterByAgent: () => [], getTool: () => null } });
    const model = { stream(_payload: unknown, cb: { done(value: unknown): void }) { cb.done({ choices: [{ message: { role: 'assistant', content: 'done' } }] }); } };
    const result = await runner.runTask('task', { name: 'Owner' }, { name: 'worker', tools: [] } as never, model as never, { modelTimeout: 10000 });
    t.is(result.outcome.completeness, 'unconfirmed');
    t.is(result.handoff, undefined);
    registry.dispose();
});

test('iteration limit hands off effect, last speech, and newest tool result first', async t => {
    const registry = new SubTaskRegistry();
    const folder = { name: 'create_folder', description: 'create', inputSchema: {}, execute: async () => 'folder created' };
    const read = { name: 'read', description: 'read', inputSchema: {}, execute: async () => 'read preview' };
    const tools = [folder, read];
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry },
        toolRegistry: { filterByAgent: () => tools, getTool: (name: string) => tools.find(tool => tool.name === name) ?? null },
        effectTargetIo: { exists: async (path: string) => path === 'Notes/new' },
    });
    let calls = 0;
    const model = { stream(_payload: unknown, handlers: { done(value: unknown): void }) {
        calls++;
        handlers.done({ choices: [{ message: calls === 1
            ? { role: 'assistant', content: 'LAST SPEECH', tool_calls: [
                { id: 'folder', type: 'function', function: { name: 'create_folder', arguments: '{"path":"Notes/new"}' } },
                { id: 'read', type: 'function', function: { name: 'read', arguments: '{"path":"Notes/important.md"}' } },
            ] }
            : { role: 'assistant', content: '' } }] });
    } };
    const result = await runner.runTask('work', { name: 'Owner' },
        { name: 'worker', tools: ['create_folder', 'read'], max_iterations: 1 } as never,
        model as never, { modelTimeout: 10000 });
    const handoff = result.handoff ?? '';
    const effectsAt = handoff.indexOf(tr('subagent.handoff.effects'));
    const speechAt = handoff.indexOf(tr('subagent.handoff.last_text'));
    const resultsAt = handoff.indexOf(tr('subagent.handoff.results'));
    t.is(result.stoppedBy, 'backstop');
    t.is(result.outcome.completeness, 'partial');
    t.deepEqual(result.outcome.effects, [{ tool: 'create_folder', action: 'create_folder',
        targets: [{ kind: 'vault-folder', path: 'Notes/new' }], outcome: 'returned', check: 'matches' }]);
    t.true(effectsAt >= 0 && effectsAt < speechAt && speechAt < resultsAt);
    t.true(handoff.includes('create_folder | vault-folder: Notes/new | returned | matches'));
    t.true(handoff.includes('LAST SPEECH'));
    t.true(handoff.indexOf('read | Notes/important.md | read preview') > resultsAt);
    t.true(handoff.indexOf('read | Notes/important.md | read preview') < handoff.indexOf('create_folder | Notes/new | folder created'));
    t.true(handoff.length <= 12000);
    t.is(registry.list()[0].result?.handoff, handoff);
    registry.dispose();
});

test('handoff shortens long search arguments and retains the result preview', async t => {
    const registry = new SubTaskRegistry();
    const read = { name: 'read', description: 'read', inputSchema: {}, execute: async () => 'OLDER READ PREVIEW' };
    const search = { name: 'search', description: 'search', inputSchema: {}, execute: async () => 'LATEST SEARCH PREVIEW' };
    const tools = [read, search];
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry },
        toolRegistry: { filterByAgent: () => tools, getTool: (name: string) => tools.find(tool => tool.name === name) ?? null },
    });
    let calls = 0;
    const model = { stream(_payload: unknown, handlers: { done(value: unknown): void }) {
        calls++;
        handlers.done({ choices: [{ message: calls === 1
            ? { role: 'assistant', content: '', tool_calls: [
                { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"Notes/old.md"}' } },
                { id: 'search-1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'q'.repeat(13000) }) } },
            ] }
            : { role: 'assistant', content: '' } }] });
    } };
    const result = await runner.runTask('search', { name: 'Owner' },
        { name: 'worker', tools: ['read', 'search'], max_iterations: 1 } as never,
        model as never, { modelTimeout: 10000 });
    const handoff = result.handoff ?? '';
    const results = handoff.split(`${tr('subagent.handoff.results')}\n`)[1] ?? '';
    const searchRow = results.split('\n').find(row => row.startsWith('search | ')) ?? '';
    const args = searchRow.split(' | ')[1] ?? '';
    t.is(result.stoppedBy, 'backstop');
    t.true(results.includes('LATEST SEARCH PREVIEW'));
    t.true(results.indexOf('LATEST SEARCH PREVIEW') < results.indexOf('OLDER READ PREVIEW'));
    t.is(args.length, 200);
    t.true(args.endsWith('...'));
    t.true(handoff.length <= 12000);
    registry.dispose();
});

test('synthesis error retains read path in handoff and registry result', async t => {
    const registry = new SubTaskRegistry();
    const read = { name: 'read', description: 'read', inputSchema: {},
        execute: async () => 'preview without file name; Authorization: Bearer sk-Tq1234567890abcdef' };
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry },
        toolRegistry: { filterByAgent: () => [read], getTool: () => read },
    });
    let calls = 0;
    const model = { stream(_payload: unknown, handlers: { done(value: unknown): void; error(error: Error): void }) {
        calls++;
        if (calls === 1) handlers.done({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"Notes/important.md"}' } },
        ] } }] });
        else handlers.error(new Error('synthesis disconnected'));
    } };
    const result = await runner.runTask('read note', { name: 'Owner' },
        { name: 'worker', tools: ['read'], max_iterations: 1 } as never,
        model as never, { modelTimeout: 10000 });
    t.is(result.failed, true);
    t.true(result.handoff?.includes('read | Notes/important.md | preview without file name') ?? false);
    t.false(result.handoff?.includes('sk-Tq1234567890abcdef') ?? true);
    t.is(registry.list()[0].result?.handoff, result.handoff);
    registry.dispose();
});

test('synthesis error masks configured key in handoff before preview is shortened', async t => {
    const secret = 'TESTKEY_DO_NOT_USE_1234567890';
    const registry = new SubTaskRegistry();
    const read = { name: 'read', description: 'read', inputSchema: {},
        execute: async () => `read preview: ${secret} ${'x'.repeat(440)}${secret}` };
    const runner = new SubAgentRunner({ app: {}, plugin: {
        subTaskRegistry: registry,
        env: { settings: { pkmAssistant: { chat: { apiKeys: { test: secret } } } } },
    }, toolRegistry: { filterByAgent: () => [read], getTool: () => read } });
    let calls = 0;
    const model = { stream(_payload: unknown, handlers: { done(value: unknown): void; error(error: Error): void }) {
        calls++;
        if (calls === 1) handlers.done({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"Notes/important.md"}' } },
        ] } }] });
        else handlers.error(new Error('synthesis disconnected'));
    } };
    const result = await runner.runTask('read note', { name: 'Owner' },
        { name: 'worker', tools: ['read'], max_iterations: 1 } as never,
        model as never, { modelTimeout: 10000 });
    t.is(result.failed, true);
    t.true(JSON.stringify(result.partial?.toolCallDetails).includes('[REDACTED]'));
    t.true(result.handoff?.includes('read | Notes/important.md | read preview: [REDACTED]') ?? false);
    t.true(result.handoff?.includes(`${'x'.repeat(20)}[REDACTED]`) ?? false);
    t.false(result.handoff?.includes(secret) ?? true);
    t.false(result.handoff?.includes('TESTKEY_DO') ?? true);
    t.is(registry.list()[0].result?.handoff, result.handoff);
    registry.dispose();
});
