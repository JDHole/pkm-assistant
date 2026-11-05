import test from 'ava';
import { buildStripModel, buildStripTreeModel } from './subTaskPanelModel.js';
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
    t.deepEqual(collapsed.counts, { running: 5, queued: 1, total: 6 });
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
