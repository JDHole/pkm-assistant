import test from 'ava';
import { buildToolPopoverEntries, type ToolPopoverIconLabel } from './toolPopoverEntries.js';

/**
 * Fixture mirroring the real bug shape (AUD-dead-code-205): `TOOL_INFO` carries a dead
 * name (`minion_task` — killed narrative role, kept only so old transcripts render a label)
 * that the registry no longer knows, while the registry carries a live tool (`todo`) that
 * never got a TOOL_INFO entry.
 */
const TOOL_INFO_FIXTURE: Record<string, ToolPopoverIconLabel> = {
    read: { label: 'Czytaj', icon: () => '<svg-read/>' },
    write: { label: 'Pisz', icon: () => '<svg-write/>' },
    minion_task: { label: 'Zadanie miniona (martwe)', icon: () => '<svg-minion/>' },
};

test('buildToolPopoverEntries: result = registry minus disabled, in registry order', t => {
    const registryNames = ['write', 'read', 'search'];
    const entries = buildToolPopoverEntries(registryNames, ['search'], TOOL_INFO_FIXTURE);

    t.deepEqual(entries.map(e => e.name), ['write', 'read'], 'search dropped (disabled), order = registry order');
});

test('buildToolPopoverEntries: TOOL_INFO name absent from the registry never appears (dead tool)', t => {
    const registryNames = ['read', 'write']; // minion_task NOT registered — killed tool
    const entries = buildToolPopoverEntries(registryNames, [], TOOL_INFO_FIXTURE);

    t.false(entries.some(e => e.name === 'minion_task'), 'dead TOOL_INFO-only name must never surface');
    t.deepEqual(entries.map(e => e.name), ['read', 'write']);
});

test('buildToolPopoverEntries: registry name absent from TOOL_INFO gets a fallback entry', t => {
    const registryNames = ['read', 'todo']; // todo IS registered, has no TOOL_INFO entry
    const entries = buildToolPopoverEntries(registryNames, [], TOOL_INFO_FIXTURE);

    const todoEntry = entries.find(e => e.name === 'todo');
    t.truthy(todoEntry, 'registered tool without a catalog entry must still show up');
    t.is(todoEntry?.label, 'todo', 'fallback label = raw tool name');
    t.is(todoEntry?.icon, undefined, 'fallback carries no icon — caller paints a default one');
});

test('buildToolPopoverEntries: known entry keeps its icon/label from the catalog', t => {
    const entries = buildToolPopoverEntries(['read'], [], TOOL_INFO_FIXTURE);
    t.is(entries[0].label, 'Czytaj');
    t.is(typeof entries[0].icon, 'function');
});

test('buildToolPopoverEntries: non-array disabledTools is treated as empty (nothing filtered)', t => {
    const entries = buildToolPopoverEntries(['read', 'write'], undefined, TOOL_INFO_FIXTURE);
    t.deepEqual(entries.map(e => e.name), ['read', 'write']);
});

test('buildToolPopoverEntries: empty registry yields empty entries', t => {
    t.deepEqual(buildToolPopoverEntries([], [], TOOL_INFO_FIXTURE), []);
});
