import test from 'ava';
import { SubTaskRegistry } from './SubTaskRegistry.js';

test('queued close zachowuje pierwszego nadawcę i tworzy jeden stopped empty', t => {
    const registry = new SubTaskRegistry();
    const thread = registry.createThread({ threadId: 'sub/worker#queued', name: 'worker', owner: { agentName: 'Lead' }, origin: { agentName: 'Lead', tabKey: 'tab-a' }, config: {}, phase: 'queued' });
    t.is(thread.phase, 'queued');
    t.true(registry.closeThread(thread.threadId, 'lead'));
    t.is(registry.getThread(thread.threadId)?.closedBy, 'lead');
    t.deepEqual(registry.finishQueuedStop(thread.threadId, { background: true, taskPreview: 'zadanie' })?.outcome, {
        end: { kind: 'stopped', by: 'lead' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [],
    });
    t.is(registry.finishQueuedStop(thread.threadId, { background: true }), undefined);
    t.is(registry.getTask(thread.threadId)?.threadId, thread.threadId);
    t.deepEqual(registry.getThread(thread.threadId)?.runIds, [thread.threadId]);
});

test('beginQueuedRun atomowo przejmuje queued z właścicielem rezerwacji bez sesji', t => {
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'sub/worker#same', name: 'worker', owner: { agentName: 'Lead' }, origin: { agentName: 'Lead' }, config: {}, phase: 'queued' });
    t.true(registry.beginQueuedRun('sub/worker#same', { agentName: 'Lead' }, { marker: 'frozen-at-start' }));
    t.is(registry.getThread('sub/worker#same')?.phase, 'running');
    t.deepEqual(registry.getThread('sub/worker#same')?.config, { marker: 'frozen-at-start' });
    t.false(registry.beginQueuedRun('sub/worker#same', { agentName: 'Lead' }, {}));
});

test('closeQueuedForOwners dopasowuje tabKey przed agentName i omija idle', t => {
    const registry = new SubTaskRegistry();
    const add = (threadId: string, origin: { agentName: string; tabKey?: string }, phase: 'queued' | 'idle' = 'queued') => registry.createThread({ threadId, name: 'worker', owner: { agentName: 'Lead' }, origin, config: {}, phase });
    add('sub/a#1', { agentName: 'Lead', tabKey: 'tab-a' });
    add('sub/b#1', { agentName: 'Lead', tabKey: 'tab-b' });
    add('sub/c#1', { agentName: 'Other', tabKey: 'tab-a' });
    add('sub/d#1', { agentName: 'Lead' });
    add('sub/e#1', { agentName: 'Lead', tabKey: 'tab-a' }, 'idle');
    t.is(registry.closeQueuedForOwners({ tabKeys: ['tab-a'], agentNames: ['Lead'] }, 'user'), 3);
    t.is(registry.getThread('sub/a#1')?.closedBy, 'user');
    t.is(registry.getThread('sub/b#1')?.phase, 'queued');
    t.is(registry.getThread('sub/d#1')?.closedBy, 'user');
    t.is(registry.getThread('sub/e#1')?.phase, 'idle');
});

test('nadawca queued ma domyślne user, a sprzątanie zapisuje system', t => {
    const registry = new SubTaskRegistry();
    const add = (threadId: string, sessionPath?: string) => registry.createThread({ threadId, name: 'worker', owner: { agentName: 'Lead', sessionPath }, origin: { agentName: 'Lead', sessionPath }, config: {}, phase: 'queued' });
    add('sub/default#1');
    add('sub/unload#1');
    add('sub/session#1', 'session.md');
    registry.closeThread('sub/default#1');
    t.is(registry.closeSessionThreads('Lead', 'session.md'), 1);
    registry.closeAll();
    t.is(registry.getThread('sub/default#1')?.closedBy, 'user');
    t.is(registry.getThread('sub/unload#1')?.closedBy, 'system');
    t.is(registry.getThread('sub/session#1')?.closedBy, 'system');
});
