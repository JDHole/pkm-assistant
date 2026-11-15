import test from 'ava';
import { scanMemoryConflicts } from './index.js';
import { hasGitConflictStart } from './gitConflict.js';

const root = '.pkm-assistant';
const a = `${root}/agents/tester-a/memory`;
const b = `${root}/agents/tester-b/memory`;
const conflict = '<<<<<<< left\nExample A\n=======\nExample B\n>>>>>>> right\n';
function fixture(entries: Record<string, string>) {
    const files = new Map(Object.entries(entries));
    const folders = new Set<string>();
    const reads: string[] = [], mutations: string[] = [];
    const brokenReads = new Set<string>(), brokenLists = new Set<string>();
    const sizes = new Map<string, number>();
    for (const path of files.keys()) {
        let parent = path.slice(0, path.lastIndexOf('/'));
        while (parent) { folders.add(parent); parent = parent.slice(0, Math.max(0, parent.lastIndexOf('/'))); }
    }
    const adapter = {
        exists: async (path: string) => files.has(path) || folders.has(path),
        stat: async (path: string) => files.has(path)
            ? { type: 'file' as const, size: sizes.get(path) ?? new TextEncoder().encode(files.get(path)!).length, ctime: 0, mtime: 0 } : null,
        list: async (path: string) => {
            if (brokenLists.has(path)) throw new Error('Synthetic listing failure');
            const direct = (p: string) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/');
            return { files: [...files.keys()].filter(direct), folders: [...folders].filter(direct) };
        },
        read: async (path: string) => {
            reads.push(path);
            if (brokenReads.has(path) || !files.has(path)) throw new Error('Synthetic read failure');
            return files.get(path)!;
        },
        write: async () => { mutations.push('write'); }, append: async () => { mutations.push('append'); },
        remove: async () => { mutations.push('remove'); }, rename: async () => { mutations.push('rename'); },
        mkdir: async () => { mutations.push('mkdir'); }, rmdir: async () => { mutations.push('rmdir'); },
    };
    return { adapter, files, folders, reads, mutations, brokenReads, brokenLists, sizes };
}

test('D6 counts traces across two agents and the shared log, including literal message examples, without writes', async t => {
    const f = fixture({
        [`${a}/.state.json`]: conflict, [`${b}/.state.json`]: '{}\n',
        [`${a}/brain.md`]: '# Memory\n', [`${b}/brain.md`]: conflict,
        [`${a}/sessions/active/2026-01-03.md`]: conflict,
        [`${a}/sessions/active/2026-01-02.md`]: '## User\n\nA healthy message.\n',
        [`${b}/sessions/active/2026-01-03.md`]: `## User\n\nA literal example:\n\n\x60\x60\x60text\n${conflict}\x60\x60\x60\n`,
        [`${b}/sessions/active/2026-01-02.md`]: 'Unreadable sample',
        [`${b}/sessions/active/.discarded/old.md`]: conflict,
        [`${b}/sessions/archive/old.md`]: conflict,
        [`${a}/brain/note.md`]: conflict,
        [`${a}/sessions/active/ignored.json`]: conflict,
        [`${root}/cost_log.jsonl`]: conflict + conflict,
    });
    f.brokenReads.add(`${b}/sessions/active/2026-01-02.md`);
    const before = [...f.files];
    t.deepEqual(await scanMemoryConflicts(f.adapter), { state: 1, brain: 1, sessions: 2, costLog: 1, unreadable: 1, skipped: 0 });
    t.is(f.reads.length, 9);
    t.deepEqual(f.mutations, []);
    t.deepEqual([...f.files], before);
});

test('D6 limits each agent independently to 50 descending filenames and checks size before read', async t => {
    const entries: Record<string, string> = {};
    for (const memory of [a, b]) for (let n = 0; n < 52; n++) {
        entries[`${memory}/sessions/active/session-${String(n).padStart(3, '0')}.md`] = conflict;
    }
    entries[`${a}/brain.md`] = conflict;
    entries[`${b}/.state.json`] = conflict;
    entries[`${root}/cost_log.jsonl`] = conflict;
    const f = fixture(entries);
    f.sizes.set(`${a}/sessions/active/session-051.md`, 1048577);
    f.sizes.set(`${a}/brain.md`, 1048577);
    f.sizes.set(`${b}/.state.json`, 1048576);
    f.sizes.set(`${root}/cost_log.jsonl`, 1048577);
    t.deepEqual(await scanMemoryConflicts(f.adapter), { state: 1, brain: 0, sessions: 99, costLog: 0, unreadable: 0, skipped: 7 });
    t.is(f.reads.length, 100);
    t.is(f.reads[0], `${a}/sessions/active/session-050.md`);
    t.is(f.reads[49], `${b}/.state.json`);
    t.is(f.reads[50], `${b}/sessions/active/session-051.md`);
    t.is(f.reads[99], `${b}/sessions/active/session-002.md`);
    t.false(f.reads.some(p => p.endsWith('session-001.md') || p.endsWith('session-000.md')));
    t.deepEqual(f.mutations, []);
});

test('D6 folder failures and unavailable size do not stop other groups or agents', async t => {
    const f = fixture({ [`${a}/sessions/active/a.md`]: conflict, [`${a}/brain.md`]: conflict,
        [`${b}/.state.json`]: conflict, [`${root}/cost_log.jsonl`]: conflict });
    f.brokenLists.add(`${a}/sessions/active`);
    f.sizes.set(`${a}/brain.md`, NaN);
    t.deepEqual(await scanMemoryConflicts(f.adapter), { state: 1, brain: 0, sessions: 0, costLog: 1, unreadable: 2, skipped: 0 });
    f.brokenLists.add(`${root}/agents`);
    t.deepEqual(await scanMemoryConflicts(f.adapter), { state: 0, brain: 0, sessions: 0, costLog: 1, unreadable: 1, skipped: 0 });
    t.deepEqual(f.mutations, []);
});

test('D6 accepts direct basenames, deduplicates listings and excludes nested or foreign paths', async t => {
    const f = fixture({ [`${a}/.state.json`]: conflict, [`${a}/sessions/active/a.md`]: conflict });
    const list = f.adapter.list;
    f.adapter.list = async path => {
        if (path === `${root}/agents`) return { files: [], folders: ['tester-a', `${root}/agents/tester-a`, '../outside', `${root}/agents/nested/child`] };
        if (path === `${a}/sessions/active`) return { files: ['a.md', `${path}/a.md`, 'sub/b.md', '../outside.md', '.discarded/c.md', 'other/root.md'], folders: [] };
        return list(path);
    };
    t.deepEqual(await scanMemoryConflicts(f.adapter), { state: 1, brain: 0, sessions: 1, costLog: 0, unreadable: 0, skipped: 0 });
    t.deepEqual(f.reads, [`${a}/.state.json`, `${a}/sessions/active/a.md`]);
});

test('D6 healthy and absent files produce zero counts', async t => {
    const f = fixture({ [`${a}/.state.json`]: '{}', [`${b}/brain.md`]: '# Memory',
        [`${a}/sessions/active/a.md`]: '## User\n\nHello', [`${root}/cost_log.jsonl`]: '{}\n' });
    t.deepEqual(await scanMemoryConflicts(f.adapter), { state: 0, brain: 0, sessions: 0, costLog: 0, unreadable: 0, skipped: 0 });
    t.is(f.reads.length, 4);
    t.deepEqual(f.mutations, []);
});

for (const [text, expected] of [
    ['<<<<<<<', true], ['<<<<<<< label\n', true], ['text\r\n<<<<<<<\r\n', true],
    ['text\n<<<<<<< label', true], ['<<<<<<<\tlabel', false], ['<<<<<<<< label', false],
    [' <<<<<<< label', false], ['text <<<<<<< label', false], ['=======\n>>>>>>> label', false],
    ['<<<<<<<\r', false], ['', false],
] as const) test(`D6 shared opening-marker definition: ${JSON.stringify(text)}`, t => {
    t.is(hasGitConflictStart(text), expected);
});
