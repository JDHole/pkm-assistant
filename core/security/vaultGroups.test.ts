import test from 'ava';
import { expandFocusEntries } from './vaultGroups.js';
import { AccessGuard } from './AccessGuard.js';

const GROUPS = [
    { name: 'Projekty', folders: [{ path: '30_Projekty', access: 'readwrite' }, { path: 'Archiwum', access: 'read' }] },
    { name: 'Tylko-czytaj', folders: ['Referencje'] }, // string folder → readwrite
];

test('expandFocusEntries passes plain string entries through as readwrite', t => {
    t.deepEqual(expandFocusEntries(['Notes', 'Docs']), [
        { path: 'Notes', access: 'readwrite' },
        { path: 'Docs', access: 'readwrite' },
    ]);
});

test('expandFocusEntries preserves {path, access} objects', t => {
    t.deepEqual(expandFocusEntries([{ path: 'A', access: 'read' }, { path: 'B' }]), [
        { path: 'A', access: 'read' },
        { path: 'B', access: 'readwrite' },
    ]);
});

test('expandFocusEntries expands a {group} reference to the group folders', t => {
    const result = expandFocusEntries([{ group: 'Projekty' }], GROUPS);
    t.deepEqual(result, [
        { path: '30_Projekty', access: 'readwrite' },
        { path: 'Archiwum', access: 'read' },
    ]);
});

test('expandFocusEntries normalizes string folders inside a group', t => {
    t.deepEqual(expandFocusEntries([{ group: 'Tylko-czytaj' }], GROUPS), [
        { path: 'Referencje', access: 'readwrite' },
    ]);
});

test('expandFocusEntries mixes direct folders and group references', t => {
    const result = expandFocusEntries([{ path: 'Inbox', access: 'read' }, { group: 'Projekty' }], GROUPS);
    t.deepEqual(result, [
        { path: 'Inbox', access: 'read' },
        { path: '30_Projekty', access: 'readwrite' },
        { path: 'Archiwum', access: 'read' },
    ]);
});

test('expandFocusEntries skips a missing group without crashing', t => {
    const result = expandFocusEntries([{ group: 'NieMa' }, { path: 'Keep' }], GROUPS);
    t.deepEqual(result, [{ path: 'Keep', access: 'readwrite' }]);
});

test('expandFocusEntries tolerates empty/undefined input and groups', t => {
    t.deepEqual(expandFocusEntries(undefined), []);
    t.deepEqual(expandFocusEntries([]), []);
    t.deepEqual(expandFocusEntries([{ group: 'Projekty' }]), []); // no groups provided → skipped
});

test('AccessGuard.checkAccess resolves a {group} reference via setVaultGroups', t => {
    AccessGuard.setNoGoFolders([]);
    AccessGuard.setVaultGroups(GROUPS);
    const agent = { name: 'Klara', focusFolders: [{ group: 'Projekty' }], permissions: { guidance_mode: false } };

    t.true(AccessGuard.checkAccess(agent, '30_Projekty/note.md', 'read').allowed);
    // Archiwum is read-only in the group → write denied
    t.false(AccessGuard.checkAccess(agent, 'Archiwum/x.md', 'write').allowed);
    t.true(AccessGuard.checkAccess(agent, 'Archiwum/x.md', 'read').allowed);
    // Outside the group → blocked
    t.false(AccessGuard.checkAccess(agent, 'Sekrety/x.md', 'read').allowed);

    AccessGuard.setVaultGroups([]);
});

test('AccessGuard.filterResults keeps only files inside the referenced group', t => {
    AccessGuard.setNoGoFolders([]);
    AccessGuard.setVaultGroups(GROUPS);
    const agent = { name: 'Klara', focusFolders: [{ group: 'Projekty' }], permissions: {} };

    const results = [
        { path: '30_Projekty/a.md' },
        { path: 'Archiwum/b.md' },
        { path: 'Poza/c.md' },
    ];
    const filtered = AccessGuard.filterResults(agent, results);
    t.deepEqual(filtered.map(r => r.path), ['30_Projekty/a.md', 'Archiwum/b.md']);

    AccessGuard.setVaultGroups([]);
});
