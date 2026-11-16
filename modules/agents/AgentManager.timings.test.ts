import test from 'ava';
import { register } from 'node:module';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Agent } from './Agent.js';
import { AgentMemory } from '../memory/index.js';
import { log } from '../../core/utils/Logger.js';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
const { AgentManager } = await import('./AgentManager.js');

function fixture(options: { memoryFailure?: boolean; resourceFailure?: 'skills' | 'komunikator' | 'vault-map'; communicator?: boolean; observe?: boolean } = {}) {
    let now = 100;
    const trace: string[] = [];
    const pending: Array<{ at: number; finish(): void }> = [];
    const failure = new Error('Synthetic startup failure');
    const delay = <T>(name: string, ms: number, value: T, fails = false): Promise<T> => {
        trace.push(name);
        return new Promise((resolve, reject) => pending.push({ at: now + ms, finish() {
            trace.push(`${name}:${fails ? 'failed' : 'done'}`);
            if (fails) reject(failure); else resolve(value);
        } }));
    };
    const vault = { adapter: {
        exists: () => delay('factory-marker', 25, true),
        read: async () => '', write: async () => {}, mkdir: async () => {},
        remove: async () => {}, rmdir: async () => {},
        list: async () => ({ files: [], folders: [] }),
    } };
    const manager = new AgentManager(vault, { pkmAssistant: { komunikatorEnabled: options.communicator !== false } }, null, null, () => now);
    const agents = [new Agent({ name: 'Tester A' }), new Agent({ name: 'Tester B' }), new Agent({ name: 'Tester C' })];
    const memories = agents.map(agent => new AgentMemory(vault, agent.name, {}));
    manager.loader.loadAllAgents = () => delay('load', 10, agents);
    manager._initializeMemoryForAgent = agent => {
        const i = agents.indexOf(agent);
        return delay(`memory-${i}`, [10, 40, 25][i], memories[i], options.memoryFailure && i === 2);
    };
    manager.skillLoader.loadAllSkills = () => delay('skills', 20, undefined, options.resourceFailure === 'skills');
    manager.subAgentLoader.ensureStarterSubAgents = () => delay('sub-starter', 5, undefined);
    manager.subAgentLoader.loadAllSubAgents = () => delay('sub-load', 25, undefined);
    manager.skillTemplateStore.loadAll = () => delay('skill-templates', 5, []);
    manager.subAgentTemplateStore.loadAll = () => delay('sub-templates', 5, []);
    manager.artifactTypeLoader.ensureBuiltinTypes = () => delay('artifact-starter', 6, undefined);
    manager.artifactTypeLoader.loadAllTypes = () => delay('artifact-load', 19, undefined);
    if (manager.komunikatorManager) manager.komunikatorManager.ensureFolder = () => delay('komunikator', 10, undefined, options.resourceFailure === 'komunikator');
    manager.vaultMap.initialize = () => delay('vault-map', 15, undefined, options.resourceFailure === 'vault-map');
    manager.loader.watchAgents = () => { trace.push('watch'); return () => {}; };
    manager.playbookManager.ensureStarterFiles = () => delay('playbooks', 7, undefined);
    manager.on((event, data) => trace.push(`${event}:${data.count}`));
    const drain = async () => {
        await setImmediate();
        while (pending.length) {
            pending.sort((a, b) => a.at - b.at);
            const next = pending.shift()!;
            now = next.at;
            next.finish();
            await setImmediate();
            if (options.observe) void manager.startupTimings;
        }
    };
    return { manager, trace, failure, drain, pending };
}

const complete = {
    loadMs: 10, memoryMs: 40, memoryMaxMs: 40, memoryCount: 3, memoryFailed: 0,
    resourcesMs: 35, skillsMs: 20, subAgentsMs: 30, templatesMs: 35,
    artifactTypesMs: 25, komunikatorMs: 10, vaultMapMs: 15, playbooksMs: 7,
};
const expectedTrace = [
    'load', 'load:done', 'memory-0', 'memory-1', 'memory-2',
    'memory-0:done', 'memory-2:done', 'memory-1:done',
    'skills', 'sub-starter', 'skill-templates', 'artifact-starter', 'komunikator', 'vault-map',
    'sub-starter:done', 'sub-load', 'skill-templates:done', 'sub-templates',
    'artifact-starter:done', 'artifact-load', 'komunikator:done', 'sub-templates:done',
    'factory-marker', 'vault-map:done', 'skills:done', 'artifact-load:done',
    'sub-load:done', 'factory-marker:done', 'watch', 'playbooks', 'playbooks:done', 'agents:loaded:3',
];

test('initialize measures parallel completions and reading snapshots leaves the dependency trace unchanged', async t => {
    for (const observe of [false, true]) {
        const f = fixture({ observe });
        const initializing = f.manager.initialize();
        await f.drain(); await initializing;
        t.deepEqual(f.manager.startupTimings, complete);
        t.deepEqual(f.trace, expectedTrace);
        t.is(f.manager.getActiveAgent()?.name, 'Tester A');
        t.is(f.manager.agentMemories.size, 3);
        const snapshot = f.manager.startupTimings;
        Object.assign(snapshot, { loadMs: 999 });
        t.deepEqual(f.manager.startupTimings, complete);
    }
});

test.serial('one memory failure is counted while the other memories and startup finish', async t => {
    const logger = mock.method(log, 'error', () => {});
    t.teardown(() => logger.mock.restore());
    const f = fixture({ memoryFailure: true });
    const initializing = f.manager.initialize();
    await f.drain(); await initializing;
    t.deepEqual(f.manager.startupTimings, { ...complete, memoryCount: 2, memoryFailed: 1 });
    t.deepEqual([...f.manager.agentMemories.keys()], ['Tester A', 'Tester B']);
    t.is(f.trace.at(-1), 'agents:loaded:3');
    t.is(logger.mock.calls[0].arguments[2], f.failure);
});

for (const resource of ['skills', 'komunikator', 'vault-map'] as const) test.serial(`${resource} failure reaches the existing catch unchanged and leaves its duration unset`, async t => {
    const logger = mock.method(log, 'error', () => {});
    t.teardown(() => logger.mock.restore());
    const f = fixture({ resourceFailure: resource });
    const initializing = f.manager.initialize();
    await f.drain();
    t.is(await initializing, undefined, 'the existing manager catch consumes the rejection');
    t.deepEqual(logger.mock.calls[0].arguments, ['AgentManager', 'Initialization FAIL:', f.failure]);
    t.is(logger.mock.calls[0].arguments[2], f.failure);
    t.deepEqual(f.manager.startupTimings, {
        loadMs: 10, memoryMs: 40, memoryMaxMs: 40, memoryCount: 3, memoryFailed: 0,
        subAgentsMs: 30, templatesMs: 35, artifactTypesMs: 25,
        ...(resource === 'skills' ? { komunikatorMs: 10, vaultMapMs: 15 }
            : resource === 'komunikator' ? { skillsMs: 20, vaultMapMs: 15 }
                : { skillsMs: 20, komunikatorMs: 10 }),
    });
    t.deepEqual(f.trace, expectedTrace.slice(0, -4).map(item => item === `${resource}:done` ? `${resource}:failed` : item));
});

test('reload replaces the last initialize sample and keeps a single watcher', async t => {
    const f = fixture();
    const first = f.manager.initialize(); await f.drain(); await first;
    const before = f.manager.startupTimings;
    f.manager.loader.loadAllAgents = async () => [];
    f.trace.length = 0;
    const reloading = f.manager.reload();
    t.deepEqual(f.manager.startupTimings, {});
    await f.drain(); await reloading;
    t.deepEqual(f.manager.startupTimings, {
        loadMs: 0, memoryMs: 0, memoryCount: 0, memoryFailed: 0,
        resourcesMs: 35, skillsMs: 20, subAgentsMs: 30, templatesMs: 35,
        artifactTypesMs: 25, komunikatorMs: 10, vaultMapMs: 15, playbooksMs: 7,
    });
    t.deepEqual(before, complete);
    t.deepEqual(f.trace, [...expectedTrace.slice(8, -4), 'playbooks', 'playbooks:done', 'agents:loaded:0', 'agents:reloaded:0']);
});

test('disabled communicator stays absent while other resources complete', async t => {
    const f = fixture({ communicator: false });
    const initializing = f.manager.initialize(); await f.drain(); await initializing;
    t.deepEqual(f.manager.startupTimings, {
        loadMs: 10, memoryMs: 40, memoryMaxMs: 40, memoryCount: 3, memoryFailed: 0,
        resourcesMs: 35, skillsMs: 20, subAgentsMs: 30, templatesMs: 35,
        artifactTypesMs: 25, vaultMapMs: 15, playbooksMs: 7,
    });
    t.deepEqual(f.trace, expectedTrace.filter(item => !item.startsWith('komunikator')));
});
