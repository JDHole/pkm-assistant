import { planInput, planResult, activatePlanTask } from './test-support/planFixture.js';
import test from 'ava';
import { AgentMemory } from '../memory/index.js';
import { formatSessionEvent, parseActiveSession } from '../memory/activeSessionFormat.js';
import { SubTaskRegistry, SubTaskNotifier, buildStripModel, parseSubTaskHistoryRecord } from './index.js';
import type { SubTaskHistoryRecord } from './index.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

const owner = { agentName: 'Mira', sessionPath: '.pkm-assistant/agents/mira/memory/sessions/active/test.md', sessionEpoch: 'a'.repeat(32) };
const header = `---\ntype: active_session\nepoch: ${owner.sessionEpoch}\n---\n`;
function storage() {
    let file = header;
    const memory = new AgentMemory({ adapter: {
        read: async () => file,
        exists: async () => true,
        write: async (_path: string, content: string) => { file = content; },
        append: async (_path: string, content: string) => { file += content; },
    } } as never, 'Mira');
    return { memory, read: () => file, replace: (text: string) => { file = text; },
        appendHistory: (record: SubTaskHistoryRecord) => memory.appendSessionEvent(record.owner.sessionPath,
            { type: 'sub_task_history', sub_task_history: record }, record.owner.sessionEpoch) };
}
function run(registry: SubTaskRegistry, id: string, parentId?: string) {
    registry.createThread({ threadId: id, name: id, owner, origin: owner, config: { secret: 'not persisted' }, phase: 'queued', parentId, level: parentId ? 2 : 1 });
    registry.beginQueuedRun(id, owner, {});
    return registry.create({ id, threadId: id, name: id, agentName: 'Mira', origin: owner, parentId, level: parentId ? 2 : 1, background: true });
}
const finished = { text: 'Gotowe\n## Wynik\n**sub_task_history:**', toolsUsed: [], durationMs: 4, usage: null, stoppedBy: 'natural' as const };
const record = (runId: string, changes: Partial<SubTaskHistoryRecord> = {}): SubTaskHistoryRecord => ({
    version: 1, runId, threadId: runId, name: runId, owner, level: 1, state: 'running', createdAt: 10, ...changes,
});
const rows = (registry: SubTaskRegistry) => buildStripModel({ tasks: registry.list(), threads: registry.listThreads(owner), ...owner, now: 20 })
    .map(row => ({ id: row.id, parentId: row.parentId, level: row.level, reusable: row.reusable, outcome: row.outcome }));

test('appendSessionEvent -> real parser -> new registry -> strip preserves the completed tree silently', async t => {
    const disk = storage();
    const registry = new SubTaskRegistry({ appendHistory: disk.appendHistory });
    const parent = run(registry, 'parent');
    const child = run(registry, 'child', 'parent');
    registry.finish(child, finished);
    registry.finish(parent, { ...finished, text: 'Rodzic gotowy' });
    await registry.flushHistory();
    const parsed = await disk.memory.loadActiveSession(owner.sessionPath);
    t.deepEqual(parsed.subTaskHistory?.map(value => { const r = parseSubTaskHistoryRecord(value)!; return [r.runId, r.state, r.parentId, r.level]; }), [
        ['parent', 'queued', undefined, 1], ['parent', 'running', undefined, 1],
        ['child', 'queued', 'parent', 2], ['child', 'running', 'parent', 2],
        ['child', 'done', 'parent', 2], ['parent', 'done', undefined, 1],
    ]);
    t.deepEqual(parsed.messages, []);
    const clock = new QuestionTestClock();
    const restored = new SubTaskRegistry({ questionClock: clock });
    const notifier = new SubTaskNotifier({ registry: restored });
    const events: string[] = [];
    for (const name of ['task:created', 'task:finished', 'thread:created', 'question:opened']) restored.events.on(name, () => events.push(name));
    t.is(restored.importHistory(parsed.subTaskHistory!, owner), 2);
    t.deepEqual(rows(restored), [
        { id: 'parent', parentId: undefined, level: 1, reusable: false, outcome: 'Rodzic gotowy' },
        { id: 'child', parentId: 'parent', level: 2, reusable: false, outcome: 'Gotowe\n## Wynik\n**sub_task_history:**' },
    ]);
    t.is(restored.importHistory(parsed.subTaskHistory!, owner), 0);
    t.deepEqual([events, notifier.pendingNotices(), restored.takeChildNotices('parent'), clock.pending], [[], [], [], 0]);
    t.deepEqual(restored.listThreads(owner).map(thread => [thread.phase, thread.transcript, thread.config]), [['closed', [], {}], ['closed', [], {}]]);
    t.is(restored.beginRun('parent', owner), false);
    notifier.dispose(); restored.dispose(); registry.dispose();
});

test('restart closes queued runs and questions and rejects late answers', async t => {
    const disk = storage();
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ appendHistory: disk.appendHistory, questionClock: clock });
    run(registry, 'parent');
    run(registry, 'child', 'parent');
    const q = registry.openParentQuestion('child', 'Jaki zakres?');
    if (q.kind !== 'opened') return t.fail('question must open');
    registry.createThread({ threadId: 'queued', name: 'queued', owner, origin: owner, config: {}, phase: 'queued', parentId: 'parent', level: 2 });
    await registry.flushHistory();
    const records = parseActiveSession(disk.read()).subTaskHistory!;
    const restoredClock = new QuestionTestClock();
    const restored = new SubTaskRegistry({ questionClock: restoredClock });
    t.is(restored.importHistory(records, owner), 3);
    t.deepEqual(restored.list().map(task => [task.id, task.status, task.interruptedByRestart, task.error]), [
        ['parent', 'aborted', true, 'Sub-agent interrupted by restart'],
        ['child', 'aborted', true, 'Sub-agent interrupted by restart'],
        ['queued', 'aborted', true, 'Sub-agent interrupted by restart'],
    ]);
    const state = restored.getQuestionState('child');
    t.deepEqual(state.kind === 'closed' ? [state.question.text, state.question.recipient, state.resolution] : state, [
        'Jaki zakres?', { kind: 'sub', runId: 'parent' }, { kind: 'cancelled', by: 'system', reason: 'run-ended' },
    ]);
    t.deepEqual(restored.answerParentQuestion('child', q.question.id, owner, { kind: 'sub', runId: 'parent' }, 'late'), { kind: 'rejected', reason: 'expired' });
    restoredClock.advance(300000);
    t.deepEqual([restoredClock.pending, restored.getRunActivity('queued'), restored.takeChildNotices('parent')], [0, 'inactive', []]);
    registry.dispose(); restored.dispose();
    t.deepEqual(await q.resolution, { kind: 'cancelled', by: 'system', reason: 'unload' });
    t.is(clock.pending, 0);
});

test('child before parent, duplicate and old running record cannot replace terminal result', t => {
    const registry = new SubTaskRegistry();
    const child = record('child', { parentId: 'parent', level: 2, state: 'done', endedAt: 15, material: 'Wynik dziecka' });
    const data = [child, child, record('parent'), record('child', { parentId: 'parent', level: 2 })];
    t.is(registry.importHistory(data, owner), 2);
    t.deepEqual(registry.list().map(task => [task.id, task.parentId, task.status, task.result?.text]), [
        ['parent', undefined, 'aborted', undefined], ['child', 'parent', 'done', 'Wynik dziecka'],
    ]);
    registry.dispose();
});

test('invalid graph, foreign epoch/owner/path and unknown version do not attach to valid tree', t => {
    const registry = new SubTaskRegistry();
    const data = [record('root'), record('orphan', { parentId: 'missing', level: 2 }),
        record('bad-level', { parentId: 'root', level: 3 }), record('self', { parentId: 'self', level: 2 }),
        record('cycle-a', { parentId: 'cycle-b', level: 2 }), record('cycle-b', { parentId: 'cycle-a', level: 3 }),
        record('foreign', { owner: { ...owner, sessionEpoch: 'b'.repeat(32) } }),
        record('foreign-agent', { owner: { ...owner, agentName: 'Other' } }),
        record('foreign-path', { owner: { ...owner, sessionPath: 'other.md' } }),
        { ...record('future'), version: 2 }, { ...record('bad-number'), createdAt: '10' },
        record('conflict'), record('conflict', { threadId: 'other' }), record('conflict-child', { parentId: 'conflict', level: 2 })];
    t.is(registry.importHistory(data, owner), 1);
    t.deepEqual(registry.list().map(task => [task.id, task.status, task.level]), [['root', 'aborted', 1]]);
    registry.dispose();
});

test('import never replaces a live run, its thread or grafts a historical child onto it', t => {
    const registry = new SubTaskRegistry();
    run(registry, 'root');
    t.is(registry.importHistory([record('root'), record('child', { parentId: 'root', level: 2 }), record('collision', { threadId: 'root' })], owner), 0);
    t.deepEqual(registry.list().map(task => [task.id, task.status]), [['root', 'running']]);
    registry.dispose();
});

test('queued continuation restores new run relation and closes the shared thread', async t => {
    const disk = storage();
    const registry = new SubTaskRegistry({ appendHistory: disk.appendHistory });
    const first = run(registry, 'first');
    registry.finish(first, finished);
    registry.endRun('first', { successful: true, answer: 'Pierwsza odpowiedź' });
    run(registry, 'parent');
    registry.reserveContinuation('first', owner, 'second', undefined, { parentId: 'parent', level: 2 });
    await registry.flushHistory();
    const restored = new SubTaskRegistry();
    t.is(restored.importHistory(parseActiveSession(disk.read()).subTaskHistory!, owner), 3);
    t.deepEqual(restored.getThread('first')?.runIds, ['first', 'second']);
    t.deepEqual([restored.getTask('second')?.parentId, restored.getThread('first')?.parentId, restored.getThread('first')?.level, restored.getThread('first')?.phase], ['parent', 'parent', 2, 'closed']);
    registry.dispose(); restored.dispose();
});

test('failed frozen append cannot redirect to new epoch, later records still persist', async t => {
    const disk = storage();
    const registry = new SubTaskRegistry({ appendHistory: disk.appendHistory });
    disk.replace(header.replace(owner.sessionEpoch, 'b'.repeat(32)));
    const task = run(registry, 'root');
    await registry.flushHistory();
    t.is(disk.read(), '---\ntype: active_session\nepoch: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n');
    disk.replace(header);
    registry.fail(task, 'Controlled failure');
    await registry.flushHistory();
    t.deepEqual(parseActiveSession(disk.read()).subTaskHistory?.map(value => { const r = parseSubTaskHistoryRecord(value)!; return [r.runId, r.state, r.error]; }), [['root', 'error', 'Controlled failure']]);
    registry.dispose();
});

test('legacy conversation survives unknown/corrupt structural records without model messages', t => {
    const parsed = parseActiveSession(formatSessionEvent('user_message', { content: 'Stara sesja' }, '2026-11-05T12:00:00Z')
        + formatSessionEvent('sub_task_history', { sub_task_history: { ...record('future'), version: 2 }, content: 'Do not inject' }, '2026-11-05T12:00:01Z')
        + formatSessionEvent('sub_task_history', { sub_task_history: '{bad json' }, '2026-11-05T12:00:02Z'));
    t.deepEqual(parsed.messages, [{ role: 'user', content: 'Stara sesja', seq: null }]);
    const registry = new SubTaskRegistry();
    t.is(registry.importHistory(parsed.subTaskHistory!, owner), 0);
    t.deepEqual(registry.list(), []);
    registry.dispose();
});


test('partial and failed outcome survive persistence; Stop of a queued run records one terminal event', async t => {
    const disk = storage();
    const registry = new SubTaskRegistry({ appendHistory: disk.appendHistory });
    const task = run(registry, 'root');
    registry.publishPartial(task, { kind: 'agent-loop-partial', revision: 1, stopReason: { kind: 'iteration-limit' },
        synthesis: 'failed', toolsUsed: ['read'], toolOutcomes: [], toolCallDetails: [], usage: { prompt_tokens: 0, completion_tokens: 0 }, iterations: 1,
        lastText: 'Notatki', text: 'Zebrane notatki' });
    registry.fail(task, 'Model failed', { end: { kind: 'failed', stage: 'synthesis' }, completeness: 'partial', hasAnswer: false, hasMaterial: true,
        effects: [{ tool: 'write', action: 'write', targets: [{ kind: 'vault-file', path: 'notatka.md' }], outcome: 'returned', check: 'matches' }] });
    registry.createThread({ threadId: 'queued', name: 'queued', owner, origin: owner, config: {}, phase: 'queued', level: 1 });
    registry.requestStop('queued', 'user');
    registry.finishQueuedStop('queued', {});
    registry.finishQueuedStop('queued', {});
    await registry.flushHistory();
    const parsed = parseActiveSession(disk.read());
    t.deepEqual(parsed.subTaskHistory!.map(value => { const r = parseSubTaskHistoryRecord(value)!; return [r.runId, r.state]; }), [
        ['root', 'queued'], ['root', 'running'], ['root', 'running'], ['root', 'error'], ['queued', 'queued'], ['queued', 'done'],
    ]);
    const restored = new SubTaskRegistry();
    t.is(restored.importHistory(parsed.subTaskHistory!, owner), 2);
    t.deepEqual([restored.getTask('root')?.result?.text, restored.getTask('root')?.error, restored.getTask('root')?.outcome], [
        'Zebrane notatki', 'Model failed', { end: { kind: 'failed', stage: 'synthesis' }, completeness: 'partial', hasAnswer: false, hasMaterial: true,
            effects: [{ tool: 'write', action: 'write', targets: [{ kind: 'vault-file', path: 'notatka.md' }], outcome: 'returned', check: 'matches' }] },
    ]);
    t.deepEqual(restored.getTask('queued')?.outcome?.end, { kind: 'stopped', by: 'user' });
    registry.dispose(); restored.dispose();
});

test('history snapshots cannot change while an earlier append is pending; dispose detaches writers', async t => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const written: SubTaskHistoryRecord[] = [];
    const registry = new SubTaskRegistry({ appendHistory: async record => { await pending; written.push(record); } });
    const task = run(registry, 'root');
    registry.finish(task, { ...finished, text: 'Zapisany wynik' });
    task.result!.text = 'Późniejsza mutacja';
    registry.dispose();
    release();
    await registry.flushHistory();
    t.deepEqual(written.map(r => [r.state, r.material]), [['queued', undefined], ['running', ''], ['done', 'Zapisany wynik']]);
    t.deepEqual(['task:created', 'task:partial', 'task:finished', 'thread:created', 'thread:queued', 'question:opened', 'question:closed']
        .map(event => registry.events.listenerCount(event)), [0, 0, 0, 0, 0, 0, 0]);
});


test('continuation moved from nested to lead keeps chronological runs and the latest relation', t => {
    const registry = new SubTaskRegistry();
    t.is(registry.importHistory([
        record('parent', { state: 'done', createdAt: 1, endedAt: 30 }),
        record('nested', { threadId: 'worker', name: 'worker', parentId: 'parent', level: 2, state: 'done', createdAt: 2, endedAt: 10 }),
        record('lead-continuation', { threadId: 'worker', name: 'worker', state: 'queued', createdAt: 20 }),
    ], owner), 3);
    t.deepEqual(registry.getThread('worker')?.runIds, ['nested', 'lead-continuation']);
    t.deepEqual([registry.getThread('worker')?.parentId, registry.getThread('worker')?.level], [undefined, 1]);
    t.deepEqual([registry.getTask('nested')?.parentId, registry.getTask('lead-continuation')?.parentId], ['parent', undefined]);
    registry.dispose();
});

test('P4 plan round-trip through AgentMemory restores waiting/queued/running as interrupted and blocked unchanged', async t => {
    const disk = storage(); const registry = new SubTaskRegistry({ appendHistory: disk.appendHistory });
    t.teardown(() => registry.dispose());
    registry.reservePlan(planInput(owner));
    activatePlanTask(registry, 'B', owner);
    await registry.flushHistory();
    const snapshot = parseActiveSession(disk.read()).subTaskHistory!;
    const restarted = new SubTaskRegistry(); t.teardown(() => restarted.dispose());
    t.is(restarted.importHistory(snapshot, owner), 3);
    t.deepEqual(restarted.list().map(task => [task.id, task.status, task.plan?.state, task.outcome?.end]), [
        ['C', 'aborted', { kind: 'failed', reason: 'aborted' }, { kind: 'stopped', by: 'system' }],
        ['A', 'aborted', { kind: 'failed', reason: 'aborted' }, { kind: 'stopped', by: 'system' }],
        ['B', 'aborted', { kind: 'failed', reason: 'aborted' }, { kind: 'stopped', by: 'system' }],
    ]);
    t.deepEqual(buildStripModel({ tasks: restarted.list(), threads: restarted.listThreads(owner), ...owner }).map(row => [row.name, row.state]), [
        ['C · explorer', { kind: 'partial', reason: 'system-stop' }], ['A · explorer', { kind: 'partial', reason: 'system-stop' }], ['B · explorer', { kind: 'partial', reason: 'system-stop' }],
    ]);
    registry.fail(activatePlanTask(registry, 'A', owner), 'A failed');
    await registry.flushHistory();
    const clock = new QuestionTestClock(); const restored = new SubTaskRegistry({ questionClock: clock });
    const notifier = new SubTaskNotifier({ registry: restored });
    t.teardown(() => { notifier.dispose(); restored.dispose(); });
    const events: string[] = [];
    for (const event of ['task:created', 'task:plan', 'task:finished', 'thread:created']) restored.events.on(event, () => events.push(event));
    const records = (await disk.memory.loadActiveSession(owner.sessionPath)).subTaskHistory!;
    t.is(restored.importHistory(records, owner), 3);
    t.deepEqual(restored.getTask('C')?.plan, { planId: 'plan-p4', nodeId: 'C', dependsOn: [{ nodeId: 'A', runId: 'A' }, { nodeId: 'B', runId: 'B' }],
        state: { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'A' }] } });
    t.deepEqual(restored.list().map(task => [task.id, task.status, task.result?.text]), [['C', 'blocked', ''], ['A', 'error', ''], ['B', 'aborted', '']]);
    t.deepEqual(buildStripModel({ tasks: restored.list(), threads: restored.listThreads(owner), ...owner })[0].state,
        { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'A' }] });
    t.deepEqual([events, notifier.pendingNotices(), restored.takeChildNotices('A'), clock.pending], [[], [], [], 0]);
    t.is(restored.importHistory(records, owner), 0);
    registry.finish(registry.getTask('B')!, planResult('Independent result'));
    await registry.flushHistory();
    const completed = new SubTaskRegistry(); t.teardown(() => completed.dispose());
    t.is(completed.importHistory((await disk.memory.loadActiveSession(owner.sessionPath)).subTaskHistory!, owner), 3);
    t.deepEqual(completed.getTask('B')?.planReport?.nodes.map(node => [node.nodeId, node.state.kind]), [['C', 'blocked'], ['A', 'failed'], ['B', 'finished']]);
    t.deepEqual([completed.getTask('B')?.planReport?.complete, completed.getTask('B')?.result?.text], [true, 'Independent result']);
});

test('P4 persisted plan schema rejects malformed IDs, states, empty causes and false report counts', async t => {
    const records: SubTaskHistoryRecord[] = [];
    const registry = new SubTaskRegistry({ appendHistory: async record => { records.push(record); } });
    t.teardown(() => registry.dispose());
    registry.reservePlan(planInput(owner)); registry.requestStop('A');
    await registry.flushHistory();
    const blocked = records.find(record => record.state === 'blocked')!;
    t.deepEqual(parseSubTaskHistoryRecord(blocked)?.plan?.state, { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'A' }] });
    const invalid: unknown[] = [
        { ...blocked, plan: { ...blocked.plan, nodeId: 'bad id' } },
        { ...blocked, plan: { ...blocked.plan, state: { kind: 'blocked', causes: [] } } },
        { ...blocked, plan: { ...blocked.plan, state: { kind: 'resuming' } } },
        { ...blocked, planReport: { ...blocked.planReport, counts: { ...blocked.planReport!.counts, blocked: 50 } } },
    ];
    t.deepEqual(invalid.map(parseSubTaskHistoryRecord), [undefined, undefined, undefined, undefined]);
});
