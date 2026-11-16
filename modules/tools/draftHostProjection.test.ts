import test from 'ava';
import { createHash } from 'node:crypto';
import { DraftError, DraftPersistence, DraftStore, DraftView, parseDraftId, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftStorageIO, DraftViewIO, FrozenDraftView } from '../vault-drafts/index.js';
import { createDraftFileIndex } from './draftFileIndex.js';
import { createDraftToolHost } from './draftToolHost.js';

const source = { tool: 'write', callId: 'projection-test' };
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
type Host = Awaited<ReturnType<typeof createDraftToolHost>>;
type Operation = { kind: 'create' | 'replace' | 'patch' | 'delete' | 'mkdir'; path: string; text?: string };

// Independent oracle: the stat-per-child list from f5f13b6, deliberately not DraftView.list.
function legacyList(view: DraftView, io: DraftViewIO): DraftView['list'] {
    return async (input = '') => {
        const path = input === '/' ? '' : input;
        if (path) parseVaultPath(path);
        const base = !path || (await io.stat(parseVaultPath(path))).kind === 'folder'
            ? await io.list(path) : { files: [], folders: [] };
        const prefix = path ? `${path}/` : '';
        const names = new Set([...base.files, ...base.folders]);
        for (const changed of view.changedPaths()) if (changed.startsWith(prefix)) names.add(prefix + changed.slice(prefix.length).split('/')[0]);
        const result = { files: [] as string[], folders: [] as string[], ambiguous: [] as string[] };
        for (const name of [...names].sort()) {
            if (/^\.pkm-assistant\/subagent-drafts(?:\/|$)/i.test(name)) continue;
            parseVaultPath(name);
            if (!name.startsWith(prefix) || name.slice(prefix.length).includes('/')) throw new DraftError('invalid-path', 'Listing returned a non-child path');
            if (view.resolve(name).kind === 'ambiguous-input') { result.ambiguous.push(name); continue; }
            const stat = await view.stat(name);
            if (stat.kind === 'file') result.files.push(name);
            if (stat.kind === 'folder') result.folders.push(name);
        }
        return result;
    };
}

function fixture(initial: Record<string, string>, folderPaths: string[] = []) {
    const bytes = new Map(Object.entries(initial).map(([path, text]) => [path, new TextEncoder().encode(text)]));
    type Entry = { path: string; stat: { size: number; mtime: number }; children?: Entry[] };
    const entries = new Map<string, Entry>([['', { path: '', stat: { size: 0, mtime: 0 }, children: [] }]]);
    const folder = (path: string): Entry => {
        const found = entries.get(path);
        if (found) return found;
        const entry: Entry = { path, stat: { size: 0, mtime: 0 }, children: [] };
        entries.set(path, entry); folder(parentOf(path)).children!.push(entry);
        return entry;
    };
    for (const path of folderPaths) folder(path);
    for (const [path, value] of bytes) {
        const entry: Entry = { path, stat: { size: value.length, mtime: 7 } };
        entries.set(path, entry); folder(parentOf(path)).children!.push(entry);
    }
    const counts = { stat: 0, list: 0, read: 0 };
    const io: DraftViewIO = {
        stat: async path => {
            counts.stat++;
            const entry = entries.get(path);
            return !entry ? { kind: 'missing' } : entry.children ? { kind: 'folder' }
                : { kind: 'file', bytes: entry.stat.size, mtime: entry.stat.mtime };
        },
        read: async path => { counts.read++; const value = bytes.get(path); if (!value) throw new Error('ENOENT'); return value.slice(); },
        list: async path => {
            counts.list++;
            const children = entries.get(path)?.children ?? [];
            return { files: children.filter(entry => !entry.children).map(entry => entry.path),
                folders: children.filter(entry => entry.children).map(entry => entry.path) };
        },
    };
    const index = createDraftFileIndex({ vault: {
        getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
        getRoot: () => entries.get(''), getFiles: () => [...entries.values()].filter(entry => !entry.children),
    } } as never);
    const stored = new Map<string, Uint8Array>();
    const storage: DraftStorageIO = {
        list: async path => [...new Set([...stored.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1).split('/')[0]))],
        read: async path => { const value = stored.get(path); if (!value) throw new Error('ENOENT'); return value.slice(); },
        writeBlob: async (path, value) => { stored.set(path, value.slice()); },
        publish: async (path, value, allowed) => { if (!allowed()) return 'cancelled'; stored.set(path, value.slice()); return 'published'; },
    };
    const persistence = new DraftPersistence(storage, { sha256: async value => createHash('sha256').update(value).digest('hex') });
    const store = new DraftStore(persistence, io, { now: () => 100 });
    const view = async (name: string, indexed: boolean, predecessors: readonly FrozenDraftView[] = []) => {
        const id = parseDraftId(`draft-${name}`);
        await store.create({ draftId: id, owner: { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, runId: name, threadId: name });
        const result = new DraftView(store, persistence, indexed ? { ...io, index } : io, id, predecessors);
        if (!indexed) result.list = legacyList(result, io);
        return result;
    };
    // Fresh oracle observes the EXACT same store, draft ID and frozen layers as the indexed view.
    const oracle = (view: DraftView) => {
        const result = new DraftView(store, persistence, io, view.draftId, view.predecessors);
        result.list = legacyList(result, io);
        return result;
    };
    return { io, index, entries, counts, store, view, oracle };
}
const options = { writable: true, source, explicitFolderPath: 'Explicit/deep',
    requestedPaths: ['.hidden', '.hidden/data.md', '.hidden/deep', '.hidden/deep/new.md'] };
async function perform(host: Host, operation: Operation) {
    switch (operation.kind) {
        case 'create': await host.vault.create(operation.path, operation.text ?? 'New'); break;
        case 'replace': await host.vault.modify({ path: operation.path }, operation.text ?? 'Replaced'); break;
        case 'patch': await host.vault.process({ path: operation.path }, text => `${text} patched`); break;
        case 'delete': await host.vault.delete({ path: operation.path }); break;
        case 'mkdir': await host.vault.createFolder(operation.path); break;
    }
    return 'ok';
}
async function outcome(action: () => unknown) {
    try { return { ok: await action() }; }
    catch (error) { if (error instanceof DraftError) return { error: error.code }; throw error; }
}
async function snapshot(host: Host, paths: readonly string[]) {
    const entries = [];
    for (const path of paths) entries.push({ path,
        get: await outcome(() => host.vault.getAbstractFileByPath(path)),
        exists: await outcome(() => host.vault.adapter.exists(path)),
        stat: await outcome(() => host.vault.adapter.stat(path)),
        list: await outcome(() => host.vault.adapter.list(path)),
    });
    return { entries, root: host.vault.getRoot(), files: host.vault.getFiles(), markdown: host.vault.getMarkdownFiles() };
}
const root = (host: Host) => host.vault.getRoot().children!.map(entry => entry.path);
const children = (host: Host, path: string) => host.vault.getAbstractFileByPath(path)?.children?.map(entry => entry.path) ?? null;

// Each literal is also executed with the legacy walker AND independent legacy list.
// Replayed separately on the complete f5f13b6 export with its original DraftView.list: 5 PASS.
for (const indexed of [false, true]) {
    test(`F2i mkdir on an implicit parent preserves the whole tree indexed=${indexed}`, async t => {
        const f = fixture({ 'B/file.md': 'Base' }), view = await f.view('implicit', indexed);
        const host = await createDraftToolHost(view, options);
        await host.vault.create('C/deep/x.md', 'Child');
        await host.vault.createFolder('C/deep');
        for (const h of [host, await createDraftToolHost(view, options)]) {
            t.deepEqual(root(h), ['B', 'C']);
            t.deepEqual(children(h, 'C'), ['C/deep']);
            t.deepEqual(children(h, 'C/deep'), ['C/deep/x.md']);
            t.deepEqual(h.vault.getFiles().map(entry => entry.path), ['B/file.md', 'C/deep/x.md']);
            t.is(await h.vault.read({ path: 'C/deep/x.md' }), 'Child');
        }
    });
    test(`F2i failed mkdir parents appear only on the next successful refresh indexed=${indexed}`, async t => {
        const f = fixture({ A: 'Base', 'B/file.md': 'Other' }), view = await f.view('deferred', indexed);
        const host = await createDraftToolHost(view, options);
        await host.vault.delete({ path: 'A' }); await host.vault.create('A/child.md', 'child');
        await t.throwsAsync(host.vault.createFolder('A/child.md'), { code: 'invalid-transition' });
        t.deepEqual(root(host), ['B']); t.is(host.vault.getAbstractFileByPath('A'), null);
        await host.vault.create('B/new.md', 'New');
        t.deepEqual(root(host), ['B', 'A']); t.deepEqual(children(host, 'A'), []);
        t.deepEqual(host.vault.getFiles().map(entry => entry.path), ['B/file.md', 'B/new.md']);
        t.deepEqual(root(await createDraftToolHost(view, options)), ['B']);
    });
    for (const descendant of [false, true]) test(`F2i technical descendants below tombstone indexed=${indexed} descendant=${descendant}`, async t => {
        const f = fixture({ A: 'Base', 'B/file.md': 'Other' }), view = await f.view('technical', indexed);
        const host = await createDraftToolHost(view, options);
        await host.vault.delete({ path: 'A' });
        if (descendant) await host.vault.create('A/child.md', 'child');
        await host.vault.createFolder('A/deep');
        t.deepEqual(root(host), ['B', 'A']); t.deepEqual(children(host, 'A'), ['A/deep']);
        t.deepEqual(children(host, 'A/deep'), []);
        t.deepEqual(host.vault.getFiles().map(entry => entry.path), ['B/file.md']);
        t.is(host.vault.getAbstractFileByPath('A/child.md'), null);
        t.true(await host.vault.adapter.exists('A/deep'));
    });
    test(`F2i rejected mkdir keeps the previous snapshot indexed=${indexed}`, async t => {
        const f = fixture({ A: 'Base' }), view = await f.view('rejected', indexed);
        const host = await createDraftToolHost(view, options);
        await host.vault.delete({ path: 'A' }); await host.vault.create('A/child.md', 'child');
        await t.throwsAsync(host.vault.createFolder('A/child.md'), { code: 'invalid-transition' });
        t.deepEqual(root(host), []); t.is(host.vault.getAbstractFileByPath('A'), null);
        t.is(await host.vault.adapter.read('A/child.md'), 'child');
        t.true(await host.vault.adapter.exists('A'));
    });
}

// LCG with explicit per-sequence seeds; failures include the complete reproducible prefix.
function random(seed: number) {
    let state = seed >>> 0;
    return (max: number) => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state % max; };
}
for (let batch = 0; batch < 20; batch++) test.serial(`F2i generated sequences ${batch * 25}-${batch * 25 + 24}: independent legacy oracle after every operation and recreation`, async t => {
    t.timeout(60000);
    const initial = { A: 'Base', 'B/file.md': 'Other', 'B/nested/note.md': 'Nested', 'top.txt': 'Text', '.hidden/data.md': 'Hidden' };
    const targets = ['A', 'A/child.md', 'A/deep/x.md', 'B/file.md', 'B/new.md', 'B/nested/note.md', 'C/deep/x.md',
        'C/deep', 'Explicit/deep', 'Empty', 'Empty/new.md', 'missing.md', 'top.txt', '.hidden/data.md', '.hidden/deep/new.md'];
    const paths = new Set(['', ...Object.keys(initial), ...targets]);
    for (const path of [...paths]) for (let parent = parentOf(path); parent; parent = parentOf(parent)) paths.add(parent);
    const known = [...paths];
    const kinds: Operation['kind'][] = ['create', 'replace', 'patch', 'delete', 'mkdir'];
    for (let sequence = batch * 25; sequence < (batch + 1) * 25; sequence++) {
        const seed = 0xf2_1000 + sequence, next = random(seed), history: Operation[] = [];
        const fixtures = [fixture(initial, ['Empty']), fixture(initial, ['Empty'])];
        const views: DraftView[] = [];
        for (const [i, f] of fixtures.entries()) {
            const predecessors: FrozenDraftView[] = [];
            if (sequence % 3 === 0) {
                const parent = await f.view('parent', i === 0);
                await parent.mutate('A', source, { kind: 'deleted', disposition: 'permanent' });
                await parent.mutate('C/deep/x.md', source, { kind: 'text', text: 'Inherited' });
                await f.store.seal(parent.draftId!, 'finished'); predecessors.push(parent.freeze());
                if (sequence % 6 === 0) {
                    const sibling = await f.view('sibling', i === 0);
                    await sibling.mutate('C/deep/x.md', source, { kind: 'text', text: 'Different' });
                    await f.store.seal(sibling.draftId!, 'finished'); predecessors.push(sibling.freeze());
                }
            }
            views.push(await f.view('current', i === 0, predecessors));
        }
        const hosts = await Promise.all(views.map(view => createDraftToolHost(view, options)));
        const length = 6 + next(7);
        for (let step = 0; step < length; step++) {
            const operation = { kind: kinds[next(kinds.length)], path: targets[next(targets.length)], text: `Value ${step}` };
            history.push(operation);
            const context = `seed=${seed} sequence=${JSON.stringify(history)}`;
            t.deepEqual(await outcome(() => perform(hosts[0], operation)), await outcome(() => perform(hosts[1], operation)), context);
            t.deepEqual(await snapshot(hosts[0], known), await snapshot(hosts[1], known), context);
            // Same DraftView data, not an independently generated expected snapshot.
            const fresh = await createDraftToolHost(views[0], options);
            const oracle = await createDraftToolHost(fixtures[0].oracle(views[0]), options);
            t.deepEqual(await snapshot(fresh, known), await snapshot(oracle, known), `fresh ${context}`);
        }
    }
});

test('F2i base and other-host mutations stay invisible until a successful local refresh', async t => {
    const f = fixture({ 'B/file.md': 'Base' }), view = await f.view('snapshot', true);
    const host = await createDraftToolHost(view, { writable: true, source });
    f.entries.get('B/file.md')!.stat = { size: 99, mtime: 42 };
    await view.mutate('new.md', source, { kind: 'text', text: 'Other host' });
    await t.throwsAsync(host.vault.create('B/file.md', 'Rejected'), { code: 'invalid-transition' });
    t.deepEqual(host.vault.getFiles().map(entry => [entry.path, entry.stat.size]), [['B/file.md', 4]]);
    await host.vault.create('local.md', 'Local');
    t.deepEqual(host.vault.getFiles().map(entry => [entry.path, entry.stat.size]), [['local.md', 5], ['new.md', 10], ['B/file.md', 99]]);
});

test('F2i CPU measurement: 20000 files in 3700 folders, no adapter I/O for projection', async t => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 20000; i++) initial[`Folder${i % 3700}/note${i}.md`] = 'Synthetic';
    const f = fixture(initial), view = await f.view('large', true);
    const start = performance.now();
    const host = await createDraftToolHost(view, { writable: true, source });
    const createdMs = performance.now() - start;
    t.deepEqual(f.counts, { stat: 0, list: 0, read: 0 });
    t.is(host.vault.getFiles().length, 20000); t.is(root(host).length, 3700);
    // Start timing after mutation completes, so this measures host refresh, not persistence/hash work.
    const mutate = view.mutate.bind(view);
    let refreshStart = 0;
    view.mutate = async (...args) => { await mutate(...args); refreshStart = performance.now(); };
    await host.vault.create('Folder0/new.md', 'New');
    const refreshedMs = performance.now() - refreshStart;
    t.deepEqual(f.counts, { stat: 4, list: 0, read: 0 });
    t.is(host.vault.getFiles().length, 20001);
    t.is(host.vault.getAbstractFileByPath('Folder0/new.md')?.stat.size, 3);
    t.log(`20000 files / 3700 folders: create=${createdMs.toFixed(2)}ms refresh=${refreshedMs.toFixed(2)}ms`);
});
