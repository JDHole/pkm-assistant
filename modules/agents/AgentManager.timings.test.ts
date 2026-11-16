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

function fixture(options: { memoryFailure?: boolean; resourceFailure?: 'skills' | 'komunikator' | 'vault-map'; communicator?: boolean; observe?: boolean; clock?: (now: number, call: number) => number } = {}) {
    let now = 100;
    let clockCalls = 0;
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
    const manager = new AgentManager(vault, { pkmAssistant: { komunikatorEnabled: options.communicator !== false } }, null, null, () => {
        clockCalls++;
        return options.clock ? options.clock(now, clockCalls) : now;
    });
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
    return { manager, trace, failure, drain, pending, memories, clockCalls: () => clockCalls };
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

// Literal dependency map for the 17 clock reads in this controlled startup.
const missingByRead: Array<Array<keyof typeof complete>> = [
    ['loadMs'], ['loadMs'], ['memoryMs', 'memoryMaxMs'],
    ['memoryMaxMs'], ['memoryMaxMs'], ['memoryMaxMs'], ['memoryMs'],
    ['resourcesMs', 'skillsMs', 'subAgentsMs', 'templatesMs', 'artifactTypesMs', 'komunikatorMs', 'vaultMapMs'],
    ['komunikatorMs'], ['vaultMapMs'], ['skillsMs'], ['artifactTypesMs'],
    ['subAgentsMs'], ['templatesMs'], ['resourcesMs'], ['playbooksMs'], ['playbooksMs'],
];

for (const fault of ['throw', 'NaN', 'Infinity', '-Infinity'] as const) {
    test.serial(`${fault} at every clock read only removes dependent timings`, async t => {
        const logs: unknown[][] = [];
        const logMocks = (['group', 'debug', 'info', 'warn', 'error', 'timing', 'groupEnd'] as const).map(level =>
            mock.method(log, level, (...args: unknown[]) => {
                // Date.now-based total is deliberately outside the injected sub-stage clock.
                logs.push([level, ...(level === 'timing' ? args.slice(0, 2) : args)]);
            }));
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        t.teardown(() => {
            process.off('unhandledRejection', onUnhandled);
            for (const logger of logMocks) logger.mock.restore();
        });
        for (let failedRead = 0; failedRead <= missingByRead.length; failedRead++) {
            logs.length = 0;
            const f = fixture({ clock: (now, call) => {
                if (call !== failedRead) return now;
                if (fault === 'throw') throw new Error('Synthetic clock failure');
                return Number(fault);
            } });
            const initializing = f.manager.initialize();
            await f.drain(); await initializing; await setImmediate();
            const expected: Partial<typeof complete> = { ...complete };
            for (const key of missingByRead[failedRead - 1] ?? []) delete expected[key];
            t.deepEqual(f.manager.startupTimings, expected, `clock read ${failedRead}`);
            t.is(f.clockCalls(), 17);
            t.deepEqual(f.trace, expectedTrace);
            t.deepEqual([...f.manager.agentMemories].map(([name, memory]) => [name, memory.agentName]), [
                ['Tester A', 'Tester A'], ['Tester C', 'Tester C'], ['Tester B', 'Tester B'],
            ]);
            for (const memory of f.memories) t.is(f.manager.getAgentMemory(memory.agentName), memory);
            t.deepEqual(f.manager.getAllAgents().map(agent => agent.name), ['Tester A', 'Tester B', 'Tester C']);
            t.is(f.manager.getActiveAgent()?.name, 'Tester A');
            t.deepEqual(logs, [
                ['group', 'AgentManager', 'initialize()'],
                ['debug', 'AgentManager', 'Załadowano 3 agentów: Tester A, Tester B, Tester C'],
                ['debug', 'AgentManager', 'Pamięć Tester A: OK'],
                ['debug', 'AgentManager', 'Pamięć Tester C: OK'],
                ['debug', 'AgentManager', 'Pamięć Tester B: OK'],
                ['info', 'AgentManager', 'Aktywny agent: Tester A'],
                ['debug', 'AgentManager', 'Skills: 0 załadowanych'],
                ['debug', 'AgentManager', 'Artifact types: 0 załadowanych'],
                ['debug', 'AgentManager', 'Sub-agents: 0 załadowanych'],
                ['debug', 'AgentManager', 'Szablony: 0 skilli / 0 subów'],
                ['timing', 'AgentManager', 'initialize()'], ['groupEnd'],
            ]);
            t.deepEqual(unhandled, []);
        }
    });
}

for (const resource of ['skills', 'komunikator', 'vault-map'] as const) {
    test.serial(`broken clock preserves the original ${resource} rejection`, async t => {
        const logger = mock.method(log, 'error', () => {});
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        t.teardown(() => { logger.mock.restore(); process.off('unhandledRejection', onUnhandled); });
        const f = fixture({ resourceFailure: resource, clock: () => { throw new Error('Synthetic clock failure'); } });
        const initializing = f.manager.initialize();
        await f.drain(); await initializing; await setImmediate();
        t.deepEqual(f.manager.startupTimings, { memoryCount: 3, memoryFailed: 0 });
        t.deepEqual(logger.mock.calls.map(call => call.arguments), [['AgentManager', 'Initialization FAIL:', f.failure]]);
        t.is(logger.mock.calls[0].arguments[2], f.failure);
        t.deepEqual(f.trace, expectedTrace.slice(0, -4).map(item => item === `${resource}:done` ? `${resource}:failed` : item));
        t.deepEqual([...f.manager.agentMemories.keys()], ['Tester A', 'Tester C', 'Tester B']);
        t.deepEqual(unhandled, []);
    });
}

test.serial('broken clock preserves real memory failures and successful memories', async t => {
    const logger = mock.method(log, 'error', () => {});
    t.teardown(() => logger.mock.restore());
    const f = fixture({ memoryFailure: true, clock: () => { throw new Error('Synthetic clock failure'); } });
    const initializing = f.manager.initialize();
    await f.drain(); await initializing;
    t.deepEqual(f.manager.startupTimings, { memoryCount: 2, memoryFailed: 1 });
    t.deepEqual([...f.manager.agentMemories.keys()], ['Tester A', 'Tester B']);
    t.is(logger.mock.calls.length, 1);
    t.is(logger.mock.calls[0].arguments[2], f.failure);
    t.deepEqual(f.trace, expectedTrace.map(item => item === 'memory-2:done' ? 'memory-2:failed' : item));
});

for (const stage of ['load', 'playbooks'] as const) {
    test.serial(`broken clock preserves the original ${stage} exception`, async t => {
        const logger = mock.method(log, 'error', () => {});
        t.teardown(() => logger.mock.restore());
        const f = fixture({ clock: () => { throw new Error('Synthetic clock failure'); } });
        const fail = () => { f.trace.push(`${stage}:failed`); throw f.failure; };
        if (stage === 'load') f.manager.loader.loadAllAgents = fail;
        else f.manager.playbookManager.ensureStarterFiles = fail;
        const initializing = f.manager.initialize();
        await f.drain(); await initializing;
        t.deepEqual(logger.mock.calls.map(call => call.arguments), [['AgentManager', 'Initialization FAIL:', f.failure]]);
        t.is(logger.mock.calls[0].arguments[2], f.failure);
        t.deepEqual(f.manager.startupTimings, stage === 'load' ? {} : { memoryCount: 3, memoryFailed: 0 });
        t.deepEqual(f.trace, stage === 'load' ? ['load:failed'] : [...expectedTrace.slice(0, -3), 'playbooks:failed']);
    });
}
