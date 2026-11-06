import test from 'ava';
import { buildStripModel, buildStripTreeModel } from './subTaskPanelModel.js';
import { SubTaskPlan } from './SubTaskPlan.js';
import type { SubTaskHistoryRecord } from './SubTaskHistory.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';
import { t as tr } from '../../core/i18n/index.js';

const owner = { agentName: 'Lead', sessionPath: 'session.md', sessionEpoch: 'e1' };
function fixture() {
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    for (const [id, name, parentId] of [
        ['lena', 'Lena', undefined], ['iga', 'Iga', undefined], ['marek', 'Marek', 'lena-run'],
        ['worker', 'worker', 'lena-run'], ['nested', 'Nested', 'marek-run'],
    ] as const) {
        registry.createThread({ threadId: id, name, parentId, owner, origin: owner, config: {} });
        registry.create({ id: `${id}-run`, threadId: id, name, parentId, origin: owner, level: parentId ? 2 : 1 });
    }
    registry.createThread({ threadId: 'queued', name: 'Jan', parentId: 'lena-run', owner, origin: owner, config: {}, phase: 'queued' });
    return registry;
}
const rowsOf = (registry: SubTaskRegistry) => buildStripModel({ tasks: registry.list(), threads: registry.listThreads(owner), ...owner });

test('tree: stable preorder, run-to-thread links, indentation and counts including hidden descendants', t => {
    const registry = fixture(); t.teardown(() => registry.dispose());
    const rows = rowsOf(registry);
    const model = buildStripTreeModel(rows);
    t.true(model.hierarchical);
    t.deepEqual(model.visible.map(n => [n.row.id, n.depth, n.descendantCount, n.hiddenCount, n.stopDescendantCount]), [
        ['lena', 0, 4, 0, 4], ['marek', 1, 1, 0, 1], ['nested', 2, 0, 0, 0],
        ['worker', 1, 0, 0, 0], ['queued', 1, 0, 0, 0], ['iga', 0, 0, 0, 0],
    ]);
    const collapsed = buildStripTreeModel(rows, new Set(['lena', 'marek']));
    t.deepEqual(collapsed.visible.map(n => [n.row.id, n.depth, n.hiddenCount]), [['lena', 0, 4], ['iga', 0, 0]]);
    t.deepEqual(collapsed.counts, { running: 5, queued: 1, waitingDependencies: 0, total: 6 });
    t.is(tr(collapsed.summary.key, collapsed.summary.params, 'pl'), '5 pracuje, 1 w kolejce');
    t.is(tr(collapsed.summary.key, collapsed.summary.params, 'en'), '5 running, 1 queued');
    t.deepEqual(buildStripTreeModel(rows, new Set(['marek'])).visible.map(n => [n.row.id, n.hiddenCount]),
        [['lena', 0], ['marek', 1], ['worker', 0], ['queued', 0], ['iga', 0]]);
    t.deepEqual(rows.map(r => r.id), ['lena', 'iga', 'marek', 'worker', 'nested', 'queued']);
});

test('tree: literal labels in both locales, question recipient and escalation precedence', t => {
    const registry = fixture(); t.teardown(() => registry.dispose());
    registry.openParentQuestion('marek-run', 'Which sources?');
    const worker = registry.getTask('worker-run')!;
    registry.finish(worker, { text: 'done', toolsUsed: [], durationMs: 0, usage: null,
        outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
    registry.endRun('worker', { successful: true });
    const nested = registry.getTask('nested-run')!;
    registry.requestStop(nested.id, 'user');
    registry.finish(nested, { text: '', toolsUsed: [], durationMs: 0, usage: null,
        outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } });
    const model = buildStripTreeModel(rowsOf(registry));
    t.deepEqual(model.visible.map(n => [n.row.name, tr(n.label.key, n.label.params, 'pl'), tr(n.label.key, n.label.params, 'en')]), [
        ['Lena', 'odpowiada wnukowi', 'answering a grandchild'], ['Marek', 'pyta Lena', 'asks Lena'],
        ['Nested', 'zatrzymany', 'stopped'], ['worker', 'skończył', 'finished'], ['Jan', 'w kolejce', 'queued'], ['Iga', 'pracuje', 'working'],
    ]);
    registry.openParentQuestion('lena-run', 'Help?');
    const parent = buildStripTreeModel(rowsOf(registry)).roots[0];
    t.is(tr(parent.label.key, parent.label.params, 'pl'), 'pyta prowadzącego');
    t.deepEqual([parent.stopDescendantCount, parent.stopRunIds, parent.canStop], [2, ['lena-run'], true]);
});

test('tree: finished parent remains stoppable, missing parent and cyclic history never lose rows', t => {
    const registry = fixture(); t.teardown(() => registry.dispose());
    registry.finish(registry.getTask('lena-run')!, { text: 'done', toolsUsed: [], durationMs: 0, usage: null });
    const rows = rowsOf(registry);
    t.deepEqual(buildStripTreeModel(rows).roots[0].stopRunIds, ['lena-run']);
    t.true(buildStripTreeModel(rows).roots[0].canStop);
    const orphan = rows.find(r => r.id === 'marek')!;
    const iga = rows.find(r => r.id === 'iga')!;
    const lone = buildStripTreeModel([orphan, iga]);
    t.deepEqual(lone.visible.map(n => [n.row.id, n.depth]), [['marek', 0], ['iga', 0]]);
    t.false(lone.hierarchical);
    const cycle = buildStripTreeModel([{ ...orphan, parentId: 'iga-run' }, { ...iga, parentId: 'marek-run' }]);
    t.deepEqual(cycle.visible.map(n => [n.row.id, n.depth]), [['iga', 0], ['marek', 1]]);
});

test('tree: plain rows retain input order and times are model data', t => {
    const registry = fixture(); t.teardown(() => registry.dispose());
    const rows = rowsOf(registry).filter(row => !row.parentId).map((row, i) => ({ ...row, durationMs: i ? 42000 : 76000 }));
    const tree = buildStripTreeModel(rows, new Set(['lena']));
    t.deepEqual(tree.visible.map(n => [n.row.id, n.depth, n.collapsed, n.hiddenCount, n.time]),
        [['lena', 0, false, 0, '1:16'], ['iga', 0, false, 0, '0:42']]);
    t.false(tree.hierarchical);
});

test('F1 queued continuation uses the current reservation relation', t => {
    const registry = new SubTaskRegistry(); t.teardown(() => registry.dispose());
    const thread = registry.createThread({ threadId: 'child', name: 'Child', owner, origin: owner, config: {}, parentId: 'old-parent', level: 2 });
    const run = registry.create({ id: 'old-child-run', threadId: thread.threadId, origin: owner, parentId: 'old-parent', level: 2 });
    registry.finish(run, { text: 'done', toolsUsed: [], durationMs: 0, usage: null });
    registry.endRun(thread.threadId, { successful: true });
    for (const relation of [{ level: 1 }, { parentId: 'new-parent', level: 3 }]) {
        registry.reserveContinuation(thread.threadId, owner, 'next-run', undefined, relation);
        const row = rowsOf(registry)[0];
        t.deepEqual([row.state.kind, row.parentId, row.level], ['queued', relation.parentId, relation.level]);
        registry.beginRun(thread.threadId, owner, { reservedRunId: 'next-run' });
        registry.endRun(thread.threadId, { successful: true });
    }
});

async function planFixture(parent = false) {
    const history: SubTaskHistoryRecord[] = [];
    const registry = new SubTaskRegistry({ appendHistory: async record => { history.push(record); } });
    const owner = { agentName: 'Lead', sessionPath: 'session.md', sessionEpoch: '1234567890abcdef1234567890abcdef' };
    if (parent) registry.create({ id: 'parent', name: 'Parent', origin: owner, level: 1 });
    const graph = SubTaskPlan.create([{ id: 'A' }, { id: 'B' }, { id: 'C', depends_on: ['A', 'B'] }], 5);
    if (graph.kind !== 'valid') throw new Error('Invalid fixture');
    const plan = await registry.createPlan(graph.plan, owner, parent ? 'parent' : undefined);
    for (const node of plan.nodes.slice(0, 2)) {
        registry.createThread({ threadId: node.id, name: node.id, owner, origin: owner, config: {}, phase: 'queued',
            parentId: plan.parentRunId, level: parent ? 2 : 1, plan: { planId: plan.planId, nodeId: node.id } });
        registry.beginQueuedRun(node.id, owner, {});
        registry.create({ id: node.id, threadId: node.id, name: node.id, agentName: owner.agentName, origin: owner, parentId: plan.parentRunId, level: parent ? 2 : 1 });
    }
    const tree = (source = registry) => buildStripTreeModel(buildStripModel({ ...owner,
        plans: source.listPlans(), threads: source.listThreads(owner), tasks: source.list() }));
    return { registry, plan, tree, history, owner };
}

test('P5 plan preorder, dependency labels and counts exclude the presentation group', async t => {
    const { registry, plan, tree } = await planFixture(); t.teardown(() => registry.dispose());
    t.deepEqual(tree().visible.map(n => n.row.kind === 'plan' ? 'plan' : n.row.name), ['plan', 'A', 'B', 'C']);
    t.deepEqual(tree().counts, { running: 2, queued: 0, waitingDependencies: 1, total: 3 });
    const waiting = tree().visible[3];
    t.is(tr(waiting.label.key, waiting.label.params, 'pl'), 'czeka na A, B');
    t.deepEqual(waiting.row.runs, []);
    plan.settle(plan.nodes[0].id, { kind: 'error', error: 'A failed', material: 'A draft' });
    plan.settle(plan.nodes[1].id, { kind: 'done', material: 'B result' });
    const failed = tree();
    t.deepEqual(failed.visible.map(n => tr(n.label.key, n.label.params, 'pl')),
        ['wynik częściowy', 'błąd', 'skończył', 'czeka na A (błąd)']);
    t.deepEqual(failed.visible.map(n => n.canStop), [false, false, false, false]);
    t.deepEqual(failed.counts, { running: 0, queued: 0, waitingDependencies: 0, total: 3 });
});

test('P5 plan parentage is presentational; continuation cannot replace a settled node', async t => {
    const { registry, plan, tree } = await planFixture(true); t.teardown(() => registry.dispose());
    t.deepEqual(tree().visible.map(n => [n.row.kind === 'plan' ? 'plan' : n.row.name, n.depth]),
        [['Parent', 0], ['plan', 1], ['A', 2], ['B', 2], ['C', 2]]);
    t.deepEqual(registry.list().filter(task => task.plan).map(task => [task.id, task.parentId, task.level]), [['A', 'parent', 2], ['B', 'parent', 2]]);
    registry.finish(registry.getTask('A')!, { text: 'original', toolsUsed: [], durationMs: 1, usage: null });
    registry.endRun('A', { successful: true });
    plan.settle(plan.nodes[0].id, { kind: 'done', material: 'original' });
    registry.reserveContinuation('A', plan.owner, 'continued', undefined, { parentId: 'parent', level: 2 });
    registry.beginRun('A', plan.owner, { reservedRunId: 'continued' });
    registry.create({ id: 'continued', threadId: 'A', name: 'Continuation', origin: plan.owner, parentId: 'parent', level: 2 });
    const node = tree().visible.find(n => n.row.kind === 'plan-node' && n.row.node.id === 'A')!;
    t.deepEqual([node.row.outcome, node.row.runs.map(run => run.id), tr(node.label.key, node.label.params, 'en')], ['original', ['A'], 'finished']);
    t.deepEqual(tree().visible.filter(n => n.row.kind === 'thread').map(n => n.row.runs.map(run => run.id)), [['parent'], ['continued']]);
    const root = await planFixture(); t.teardown(() => root.registry.dispose());
    root.registry.create({ id: 'grandchild', name: 'Grandchild', origin: root.owner, parentId: 'A', level: 2 });
    t.deepEqual(root.tree().visible.map(n => [n.row.kind === 'plan' ? 'plan' : n.row.name, n.depth]),
        [['plan', 0], ['A', 1], ['Grandchild', 2], ['B', 1], ['C', 1]]);
});

test('P5 restarted strip preserves material and every unexecuted node with exact owner isolation', async t => {
    const { registry, plan, tree, history, owner } = await planFixture(); t.teardown(() => registry.dispose());
    registry.finish(registry.getTask('A')!, { text: 'wynik A', toolsUsed: [], durationMs: 1, usage: null });
    plan.settle(plan.nodes[0].id, { kind: 'done', material: 'wynik A' });
    await registry.flushHistory();
    const restored = new SubTaskRegistry(); t.teardown(() => restored.dispose());
    restored.importHistory(history, owner);
    t.deepEqual(tree(restored).visible.map(n => [tr(n.label.key, n.label.params, 'pl'), n.row.outcome]),
        [['przerwany przez restart', ''], ['skończył', 'wynik A'], ['przerwany przez restart', ''], ['nie wykonano', '']]);
    t.deepEqual(tree(restored).counts, { running: 0, queued: 0, waitingDependencies: 0, total: 3 });
    registry.create({ id: 'descendant', name: 'Descendant', origin: owner, parentId: 'B', level: 2 });
    for (const foreign of [{ ...owner, sessionEpoch: 'other' }, { ...owner, sessionPath: 'other.md' }, { ...owner, agentName: 'Other' }]) {
        t.deepEqual(buildStripModel({ ...foreign, plans: registry.listPlans(), tasks: registry.list(), threads: registry.listThreads(owner) }), []);
    }
});


test('P5 queued nodes have no synthetic run; completed plans retain all materials', async t => {
    const { registry, plan, tree, owner } = await planFixture(); t.teardown(() => registry.dispose());
    for (const id of ['A', 'B']) {
        registry.finish(registry.getTask(id)!, { text: `Result ${id}`, toolsUsed: [], durationMs: 1, usage: null });
        plan.settle(plan.nodes.find(node => node.id === id)!.id, { kind: 'done', material: `Result ${id}` });
    }
    registry.createThread({ threadId: 'C', name: 'C', owner, origin: owner, config: {}, phase: 'queued',
        plan: { planId: plan.planId, nodeId: plan.nodes[2].id } });
    const queued = tree();
    t.deepEqual([queued.visible[3].row.runs, tr(queued.visible[3].label.key, queued.visible[3].label.params, 'pl')], [[], 'w kolejce']);
    t.deepEqual(queued.counts, { running: 0, queued: 1, waitingDependencies: 0, total: 3 });
    registry.beginQueuedRun('C', owner, {});
    const run = registry.create({ id: 'C', threadId: 'C', name: 'C', origin: owner });
    registry.finish(run, { text: 'Result C', toolsUsed: [], durationMs: 1, usage: null });
    plan.settle(plan.nodes[2].id, { kind: 'done', material: 'Result C' });
    t.deepEqual(tree().visible.map(node => [tr(node.label.key, node.label.params, 'pl'), node.row.outcome]),
        [['ukończony', ''], ['skończył', 'Result A'], ['skończył', 'Result B'], ['skończył', 'Result C']]);
    t.deepEqual(tree().visible.map(node => node.canStop), [false, false, false, false]);
});
