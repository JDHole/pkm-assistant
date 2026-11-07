import test from 'ava';
import { create, insert } from '@orama/orama';
import { createHash } from 'node:crypto';
import { DraftStore, DraftPersistence, DraftView, parseDraftId, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftStorageIO, DraftViewIO, VaultStat, FrozenDraftView } from '../vault-drafts/index.js';
import { ArtifactStore, parseArtifact } from '../artifacts/index.js';
import { prepareSubToolExecution } from './subToolExecution.js';
import { createDraftToolHost } from './draftToolHost.js';
import { createWriteTool } from './WriteTool.js';
import { createReadTool } from './ReadTool.js';
import { createListTool } from './ListTool.js';
import { createDeleteTool } from './DeleteTool.js';
import { createCreateFolderTool } from './CreateFolderTool.js';
import { createSearchTool } from './SearchTool.js';
import { createArtifactCreateTool } from './built-in-servers/artifacts/ArtifactCreateTool.js';
import { createArtifactUpdateTool } from './built-in-servers/artifacts/ArtifactUpdateTool.js';
import { createArtifactReadTool } from './built-in-servers/artifacts/ArtifactReadTool.js';
import { createArtifactListTool } from './built-in-servers/artifacts/ArtifactListTool.js';
import { readBinary, writeBinary } from './vault_binary_io.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const source = { tool: 'write', callId: 'call-1' };
function storage(): DraftStorageIO {
    const files = new Map<string, Uint8Array>();
    return {
        list: async path => [...new Set([...files.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1).split('/')[0]))],
        read: async path => { const bytes = files.get(path); if (!bytes) throw new Error('missing'); return bytes.slice(); },
        writeBlob: async (path, bytes) => { files.set(path, bytes.slice()); },
        publish: async (path, bytes, allowed) => { if (!allowed()) return 'cancelled'; files.set(path, bytes.slice()); return 'published'; },
    };
}
async function fixture(initial: Record<string, string> = { 'a.md': 'Baza' }) {
    const files = new Map(Object.entries(initial).map(([path, text]) => [path, encode(text)]));
    const folders = new Set<string>();
    const io: DraftViewIO = {
        async stat(path): Promise<VaultStat> {
            const bytes = files.get(path);
            return bytes ? { kind: 'file', bytes: bytes.length, mtime: 7 }
                : folders.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`)) ? { kind: 'folder' } : { kind: 'missing' };
        },
        async read(path) { const bytes = files.get(path); if (!bytes) throw new Error('ENOENT'); return bytes.slice(); },
        async list(path) {
            const prefix = path ? `${path}/` : '', children = new Set<string>(), dirs = new Set<string>();
            for (const name of [...files.keys(), ...folders]) if (name.startsWith(prefix)) {
                const rest = name.slice(prefix.length), slash = rest.indexOf('/');
                if (slash >= 0) dirs.add(prefix + rest.slice(0, slash));
                else if (folders.has(name)) dirs.add(name); else children.add(name);
            }
            return { files: [...children], folders: [...dirs] };
        },
    };
    const entry = (path: string) => ({ path, name: path.split('/').pop()!, basename: path.split('/').pop()!.replace(/\.md$/, ''), extension: path.split('.').pop()! });
    const read = async (file: { path: string }) => decode(await io.read(parseVaultPath(file.path)));
    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => files.has(path) ? entry(path) : folders.has(path) ? { ...entry(path), children: [] } : null,
            getMarkdownFiles: () => [...files.keys()].filter(path => path.endsWith('.md')).map(entry),
            read, cachedRead: read,
            create: async (path: string, text: string) => { files.set(path, encode(text)); return entry(path); },
            createFolder: async (path: string) => { folders.add(path); },
            process: async (file: { path: string }, fn: (text: string) => string | null) => {
                const old = await read(file), next = fn(old); if (next !== null) files.set(file.path, encode(next)); return next ?? old;
            },
            trash: async (file: { path: string }) => { files.delete(file.path); },
            adapter: {
                read: (path: string) => read({ path }), list: (path: string) => io.list(path === '/' ? '' : path),
                exists: async (path: string) => (await io.stat(parseVaultPath(path))).kind !== 'missing',
            },
        },
        metadataCache: { getFileCache: (file: { path: string }) => {
            const text = decode(files.get(file.path) ?? new Uint8Array());
            return { frontmatter: parseArtifact(text).frontmatter };
        } },
        fileManager: {
            processFrontMatter: async () => { throw new Error('Live frontmatter mutation forbidden in this fixture'); },
            renameFile: async () => { throw new Error('Live rename forbidden'); },
        },
    };
    const persistence = new DraftPersistence(storage(), { sha256: async bytes => createHash('sha256').update(bytes).digest('hex') });
    const store = new DraftStore(persistence, io, { now: () => 100 });
    const artifactStore = new ArtifactStore({ app, getArtifactsFolder: () => 'Artifacts', now: () => new Date('2026-11-07T12:00:00Z'),
        typeLoader: { getType: () => ({ name: 'plan', statusy: ['draft', 'closed'], pola: { cel: {} }, template: '## Cel\n{{cel}}\n' }) } });
    const plugin = { app, artifactStore, agentManager: { getActiveAgent: () => ({ name: 'Tester' }), getAgent: () => ({ name: 'Tester' }) } };
    const view = async (name: string, predecessors: readonly FrozenDraftView[] = []) => {
        const id = parseDraftId(`draft-${name}`);
        await store.create({ draftId: id, owner: { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, runId: name, threadId: name });
        return new DraftView(store, persistence, io, id, predecessors);
    };
    const prepare = async (workspace: DraftView, name = 'write', args: Record<string, unknown> = {}) => {
        const result = await prepareSubToolExecution({ execution: { kind: 'overlay-write', workspace }, tool: { name, source: 'built-in' }, args, callId: 'call-1', app, plugin });
        if (result.kind !== 'overlay') throw new Error('Expected overlay');
        return result;
    };
    return { files, folders, io, app, plugin, persistence, store, view, prepare };
}
const context: BuiltinToolExecutionContext = { resultBudgetChars: 12000, effectiveResultBudgetChars: 12000,
    shouldAbort: () => false, authorizeFileRead: () => ({ allowed: true }), serializeFinalResult: value => JSON.stringify(value) };

test('P2 independent A/B hosts read their own writes; live vault remains Baza', async t => {
    const f = await fixture(), a = await f.view('a'), b = await f.view('b');
    const [ha, hb] = await Promise.all([f.prepare(a), f.prepare(b)]);
    const tool = createWriteTool();
    const results = await Promise.all([tool.execute({ path: 'a.md', content: 'A', mode: 'replace' }, ha.app, ha.plugin), tool.execute({ path: 'a.md', content: 'B', mode: 'replace' }, hb.app, hb.plugin)]);
    t.deepEqual(results.map(result => result.success), [true, true]);
    t.deepEqual(await Promise.all([a.read('a.md'), b.read('a.md'), f.app.vault.read({ path: 'a.md' })]), ['A', 'B', 'Baza']);
    t.deepEqual(await createReadTool().execute({ path: 'a.md', scope: 'vault' }, ha.app, ha.plugin), { success: true, path: 'a.md', content: 'A' });
    t.is(f.plugin.app, f.app);
});

test('P2 tombstone listing contains exactly nowy.md through view, adapter and list tool', async t => {
    const f = await fixture(), view = await f.view('a');
    const h = await f.prepare(view);
    await h.app.vault.create('nowy.md', 'Nowy');
    const deleted = await createDeleteTool().execute({ path: 'a.md' }, h.app, h.plugin);
    t.is(deleted.success, true);
    t.deepEqual(await view.list(), { files: ['nowy.md'], folders: [], ambiguous: [] });
    t.deepEqual((await h.app.vault.adapter.list('')).files, ['nowy.md']);
    const listed = await createListTool().execute({ scope: 'vault' }, h.app, h.plugin);
    t.deepEqual(listed, { success: true, scope: 'vault', folder: '', files: [{ path: 'nowy.md', name: 'nowy.md', isFolder: false, extension: 'md' }], count: 1, totalCount: 1 });
    await t.throwsAsync(view.read('a.md'), { code: 'file-missing' });
    t.is(await f.app.vault.read({ path: 'a.md' }), 'Baza');
});

test('P2 keyword and text find draft-only phrase with logical path and literal excerpt', async t => {
    const f = await fixture(), view = await f.view('a');
    await view.mutate('a.md', source, { kind: 'text', text: 'tylko-w-kopii' });
    const h = await f.prepare(view, 'search', { scope: 'vault' });
    const keyword = await createSearchTool().execute({ scope: 'vault', mode: 'keyword', query: 'tylko-w-kopii' }, h.app, h.plugin);
    t.like(keyword, { success: true, results: [{ path: 'a.md', excerpt: 'tylko-w-kopii' }] });
    const text = await createSearchTool().execute({ scope: 'vault', mode: 'text', query: 'tylko-w-kopii', where: { path: 'a.md' } }, h.app, h.plugin, context);
    t.like(text, { success: true, mode_used: 'text', results: [{ path: 'a.md', excerpt: 'tylko-w-kopii' }] });
});

test('P2 parallel identical queries and later revision never share keyword scan results', async t => {
    const f = await fixture(), a = await f.view('a'), b = await f.view('b');
    await a.mutate('a.md', source, { kind: 'text', text: 'fraza A' });
    await b.mutate('a.md', source, { kind: 'text', text: 'fraza B' });
    const search = async (view: DraftView) => {
        const h = await f.prepare(view, 'search', { scope: 'vault' });
        const r = await createSearchTool().execute({ scope: 'vault', mode: 'keyword', query: 'fraza' }, h.app, h.plugin);
        return r;
    };
    t.like(await Promise.all([search(a), search(b)]), [{ results: [{ excerpt: 'fraza A' }] }, { results: [{ excerpt: 'fraza B' }] }]);
    await a.mutate('a.md', source, { kind: 'text', text: 'fraza Druga' });
    t.like(await search(a), { results: [{ excerpt: 'fraza Druga' }] });
});

test('P2 semantic reads base excerpts; auto explicitly uses overlay keyword', async t => {
    const f = await fixture({ 'a.md': 'fraza Baza' }), view = await f.view('a');
    await view.mutate('a.md', source, { kind: 'text', text: 'fraza Kopia' });
    const db = await create({ schema: { path: 'string', embedding: 'vector[2]' } });
    await insert(db, { path: 'a.md', embedding: [1, 0] });
    const plugin = { ...f.plugin, oramaDb: db, env: { embeddings: { default: { embed: async () => [{ vector: [1, 0] }] } } } };
    const h = await prepareSubToolExecution({ execution: { kind: 'overlay-write', workspace: view }, tool: { name: 'search', source: 'built-in' }, args: { scope: 'vault' }, callId: 'call', app: f.app, plugin });
    const semantic = await createSearchTool().execute({ scope: 'vault', mode: 'semantic', query: 'fraza' }, h.app, h.plugin);
    t.like(semantic, { success: true, mode_used: 'semantic', results: [{ path: 'a.md', excerpt: 'fraza Baza' }], draft_note: 'Semantic search uses only the base vault; draft content is not searched.' });
    const auto = await createSearchTool().execute({ scope: 'vault', mode: 'auto', query: 'fraza' }, h.app, h.plugin);
    t.like(auto, { success: true, mode_used: 'keyword', results: [{ path: 'a.md', excerpt: 'fraza Kopia' }], draft_note: 'Draft view: auto uses keyword search so draft content is included.' });
});

// Built-in dispatch accepts unknown arguments; tool schemas/store validate them.
// Reflect also avoids coupling this integration test to the legacy ArtifactStoreLike typedef.
async function artifact(tool: { execute: (...args: never[]) => unknown }, args: unknown,
    host: { app: unknown; plugin: unknown }): Promise<unknown> {
    return await Reflect.apply(tool.execute, tool, [args, host.app, host.plugin]);
}

test('P2 artifact create/update/read/list uses local frontmatter and independent store', async t => {
    const f = await fixture();
    const base = await f.plugin.artifactStore.create('plan', { tytul: 'Bazowy', agent: 'Tester', pola: { cel: 'Baza' } });
    const view = await f.view('a'), h = await f.prepare(view, 'artifact_create');
    const tool = createArtifactCreateTool(), args = { typ: 'plan', tytul: 'Nowy', pola: { cel: 'Start' }, _invocationAgentName: 'Tester' };
    t.is(tool.contextExtractor(args, { agentName: 'Tester', plugin: h.plugin }).targetPath, 'Artifacts/Tester/2026-11-07 Nowy.md');
    const created = await artifact(tool, args, h);
    if (typeof created !== 'object' || created === null || !('id' in created) || typeof created.id !== 'string') throw new Error(JSON.stringify(created));
    const update = await f.prepare(view, 'artifact_update');
    const result = await artifact(createArtifactUpdateTool(), { id: created.id, ops: [
        { op: 'set_field', key: 'status', value: 'closed' }, { op: 'set_section', heading: 'Cel', text: 'Zmieniona sekcja' },
    ] }, update);
    t.like(result, { applied: 2, errors: [], artifact: { frontmatter: { status: 'closed' }, sections: [{ heading: 'Cel', text: 'Zmieniona sekcja' }] } });
    await artifact(createArtifactUpdateTool(), { id: base.id, ops: [{ op: 'set_field', key: 'cel', value: 'Kopia' }] }, update);
    const read = await f.prepare(view, 'artifact_read');
    t.like(await artifact(createArtifactReadTool(), { id: base.id }, read), { frontmatter: { cel: 'Kopia' } });
    t.like(await artifact(createArtifactListTool(), {}, read), { artifacts: [{ tytul: '2026-11-07 Bazowy' }, { tytul: '2026-11-07 Nowy', status: 'closed' }] });
    t.like(await f.plugin.artifactStore.read(base.id), { frontmatter: { cel: 'Baza' }, sections: [{ heading: 'Cel', text: `Baza\n\n\`\`\`pkm-artefakt\nid: ${base.id}\n\`\`\`` }] });
    t.deepEqual(f.plugin.artifactStore.list().map(item => item.tytul), ['2026-11-07 Bazowy']);
});

test('P2 binary writer reads source from overlay and stores a separate result', async t => {
    const f = await fixture(), view = await f.view('a');
    f.files.set('source.png', new Uint8Array([1, 2, 3]));
    await view.mutate('source.png', source, { kind: 'binary', bytes: new Uint8Array([9, 8, 7]) });
    const h = await f.prepare(view, 'add_text_to_image');
    const input = await readBinary(h.app, 'source.png');
    t.deepEqual([...new Uint8Array(input)], [9, 8, 7]);
    await writeBinary(h.app, 'Images/result.png', new Uint8Array([9, 8, 7, 255]).buffer);
    t.deepEqual([...await view.readBinary('Images/result.png')], [9, 8, 7, 255]);
    t.deepEqual([...f.files.get('source.png')!], [1, 2, 3]);
    t.deepEqual(f.store.snapshot(view.draftId!).changes.map(change => [change.path, change.source.callId]), [['source.png', 'call-1'], ['Images/result.png', 'call-1']]);
});

test('P2 unknown mutations and read-only hosts refuse while base remains Baza', async t => {
    const f = await fixture(), view = await f.view('a'), h = await f.prepare(view);
    for (const target of [h.app, h.app.vault, h.app.vault.adapter, h.app.fileManager]) {
        t.throws(() => Reflect.get(target, 'rename')('a.md', 'evil.md'), { code: 'mutation-denied' });
    }
    const readonly = await createDraftToolHost(view, { writable: false, source });
    await t.throwsAsync(readonly.vault.modify({ path: 'a.md' }, 'Nie'), { code: 'mutation-denied' });
    t.is(await readonly.vault.read({ path: 'a.md' }), 'Baza');
    t.is(await f.app.vault.read({ path: 'a.md' }), 'Baza');
});

test('P2 sealed predecessors layer through chains, mark ambiguity, and retain original conflict base', async t => {
    const f = await fixture(), a = await f.view('a'), b = await f.view('b');
    await a.mutate('a.md', source, { kind: 'text', text: 'A' });
    await b.mutate('a.md', source, { kind: 'text', text: 'B' });
    t.throws(() => a.freeze(), { code: 'invalid-transition' });
    await f.store.seal(a.draftId!, 'finished'); await f.store.seal(b.draftId!, 'finished');
    const ambiguous = await f.view('ambiguous', [a.freeze(), b.freeze()]);
    t.deepEqual(await ambiguous.list(), { files: [], folders: [], ambiguous: ['a.md'] });
    await t.throwsAsync(ambiguous.read('a.md'), { code: 'ambiguous-input', message: 'Ambiguous input a.md: draft-a, draft-b' });
    await t.throwsAsync(ambiguous.mutate('a.md', source, text => text + 'C'), { code: 'ambiguous-input' });
    f.files.set('a.md', encode('Kuba'));
    const c = await f.view('c', [a.freeze()]);
    t.is(await c.read('a.md'), 'A');
    await c.mutate('a.md', source, text => text + 'C');
    const change = f.store.snapshot(c.draftId!).changes[0];
    if (change.base.kind !== 'file') throw new Error('Expected file base');
    t.is(decode(await f.persistence.readBlob(c.draftId!, change.base.blob, change.base.version.hash, change.base.version.bytes)), 'Baza');
    t.deepEqual(change.inheritedFrom, [{ draftId: 'draft-a', revision: 1 }]);
    await f.store.seal(c.draftId!, 'finished');
    const d = await f.view('d', [a.freeze(), c.freeze()]);
    t.is(await d.read('a.md'), 'AC');
    t.is(await f.app.vault.read({ path: 'a.md' }), 'Kuba');
});

test('P2 inherited new-file tombstone survives restart and masks predecessor', async t => {
    const f = await fixture(), a = await f.view('a');
    await a.mutate('nowy.md', source, { kind: 'text', text: 'Nowy' }); await f.store.seal(a.draftId!, 'finished');
    const c = await f.view('c', [a.freeze()]);
    await c.mutate('nowy.md', source, { kind: 'deleted', disposition: 'trash' });
    t.deepEqual((await c.list()).files, ['a.md']);
    const restored = new DraftStore(f.persistence, f.io, { now: () => 101 }); await restored.restore();
    const again = new DraftView(restored, f.persistence, f.io, c.draftId, [a.freeze()]);
    t.deepEqual(await again.list(), { files: ['a.md'], folders: [], ambiguous: [] });
    t.is(await again.read('a.md'), 'Baza');
});

test('P2 process serializes parallel appends across distinct per-call hosts', async t => {
    const f = await fixture(), view = await f.view('a');
    const [a, b] = await Promise.all([f.prepare(view), f.prepare(view)]);
    await Promise.all([a.app.vault.process({ path: 'a.md' }, text => text + ' A'), b.app.vault.process({ path: 'a.md' }, text => text + ' B')]);
    t.is(await view.read('a.md'), 'Baza A B');
    t.is(await f.app.vault.read({ path: 'a.md' }), 'Baza');
});

test('P2 explicit folder is reviewable; technical parents and private storage are not listed as changes', async t => {
    const f = await fixture(), view = await f.view('a');
    const h = await f.prepare(view, 'create_folder', { path: 'Folder' });
    t.like(await createCreateFolderTool(h.app).execute({ path: 'Folder' }, h.app, h.plugin), { success: true, path: 'Folder' });
    const w = await f.prepare(view);
    await w.app.vault.createFolder('Technical/Parent'); await w.app.vault.create('Technical/Parent/a.md', 'Nowa');
    t.deepEqual(f.store.snapshot(view.draftId!).changes.map(change => [change.path, change.proposed.kind]), [['Folder', 'folder'], ['Technical/Parent/a.md', 'text']]);
    f.files.set('.pkm-assistant/subagent-drafts/v1/secret.md', encode('private'));
    t.deepEqual(await view.list('.pkm-assistant'), { files: [], folders: [], ambiguous: [] });
    await t.throwsAsync(view.read('.pkm-assistant/subagent-drafts/v1/secret.md'), { code: 'invalid-path' });
    t.is(await view.read('Technical/Parent/a.md'), 'Nowa');
});

test('P2 live and agent-state tools keep original hosts; external and unknown tools are refused', async t => {
    const f = await fixture(), view = await f.view('a');
    for (const name of ['todo', 'memory_save', 'kom_send', 'read', 'list', 'search']) {
        const result = await prepareSubToolExecution({ execution: { kind: 'overlay-write', workspace: view }, tool: { name, source: 'built-in' }, args: { scope: 'memory' }, callId: 'call', app: f.app, plugin: f.plugin });
        t.is(result.app, f.app); t.is(result.plugin, f.plugin);
    }
    const live = await prepareSubToolExecution({ execution: { kind: 'live' }, tool: { name: 'write', source: 'built-in' }, args: {}, callId: 'call', app: f.app, plugin: f.plugin });
    await live.app.vault.create('live.md', 'Żywy');
    t.is(await f.app.vault.read({ path: 'live.md' }), 'Żywy');
    for (const tool of [{ name: 'write', source: 'user' as const }, { name: 'new_writer', source: 'built-in' as const }]) {
        await t.throwsAsync(prepareSubToolExecution({ execution: { kind: 'overlay-write', workspace: view }, tool, args: {}, callId: 'call', app: f.app, plugin: f.plugin }), { code: 'mutation-denied' });
    }
    t.is(await view.read('a.md'), 'Baza');
});

test('P2 pagination versions track overlay bytes and reject continuation after a draft edit', async t => {
    const f = await fixture(), view = await f.view('a');
    await view.mutate('a.md', source, { kind: 'text', text: 'Kopia druga' });
    const firstHost = await f.prepare(view, 'read');
    const tool = createReadTool();
    const page = await tool.execute({ scope: 'vault', path: 'a.md', offset: 0, limit: 5 }, firstHost.app, firstHost.plugin, context);
    if (typeof page !== 'object' || page === null || !('source_version' in page)) throw new Error(JSON.stringify(page));
    t.like(page, { content: 'Kopia', next_offset: 5, source_length: 11 });
    const second = await tool.execute({ scope: 'vault', path: 'a.md', offset: 5, source_version: page.source_version }, firstHost.app, firstHost.plugin, context);
    t.like(second, { content: ' druga', has_more: false });
    await view.mutate('a.md', source, { kind: 'text', text: 'Kopia nowa' });
    const nextHost = await f.prepare(view, 'read');
    t.deepEqual(await tool.execute({ scope: 'vault', path: 'a.md', offset: 5, source_version: page.source_version }, nextHost.app, nextHost.plugin, context),
        { success: false, code: 'file_changed', isError: true, restart_offset: 0 });
    t.is(await f.app.vault.read({ path: 'a.md' }), 'Baza');
});

test('P2 equal independent proposals keep both sources and subsequent writes preserve provenance', async t => {
    const f = await fixture(), a = await f.view('a'), b = await f.view('b');
    await a.mutate('a.md', source, { kind: 'text', text: 'Wspólna' });
    await b.mutate('a.md', source, { kind: 'text', text: 'Wspólna' });
    await f.store.seal(a.draftId!, 'finished'); await f.store.seal(b.draftId!, 'finished');
    const predecessors = [a.freeze(), b.freeze()], c = await f.view('c', predecessors);
    predecessors.pop(); // Caller mutation cannot change the admitted view.
    t.is(await c.read('a.md'), 'Wspólna');
    await c.mutate('a.md', source, text => text + ' C');
    await c.mutate('a.md', source, text => text + ' Druga');
    t.deepEqual(f.store.snapshot(c.draftId!).changes[0].inheritedFrom, [{ draftId: 'draft-a', revision: 1 }, { draftId: 'draft-b', revision: 1 }]);
    t.is(await c.read('a.md'), 'Wspólna C Druga');
});

test('P2 adapter writes, binary modification and permanent deletion stay in the draft', async t => {
    const f = await fixture({ '.hidden/a.md': 'Ukryta baza' }), view = await f.view('a');
    const h = await f.prepare(view);
    await h.app.vault.adapter.write('.hidden/a.md', 'Ukryta kopia');
    t.is(await h.app.vault.adapter.read('.hidden/a.md'), 'Ukryta kopia');
    await h.app.vault.adapter.writeBinary('.hidden/new.bin', new Uint8Array([4, 5]).buffer);
    await h.app.vault.modifyBinary({ path: '.hidden/new.bin' }, new Uint8Array([6, 7]).buffer);
    t.deepEqual([...new Uint8Array(await h.app.vault.adapter.readBinary('.hidden/new.bin'))], [6, 7]);
    await h.app.vault.adapter.remove('.hidden/a.md');
    t.deepEqual(await h.app.vault.adapter.list('.hidden'), { files: ['.hidden/new.bin'], folders: [], ambiguous: [] });
    t.deepEqual(f.store.snapshot(view.draftId!).changes.find(change => change.path === '.hidden/a.md')?.proposed, { kind: 'deleted', disposition: 'permanent' });
    t.is(decode(f.files.get('.hidden/a.md')!), 'Ukryta baza');
});

test('P2 predecessor tombstones and folders are visible without a writable workspace', async t => {
    const f = await fixture(), a = await f.view('a');
    await a.mutate('a.md', source, { kind: 'deleted', disposition: 'trash' });
    await a.mutate('Nowy', source, { kind: 'folder' });
    await a.mutate('Nowy/b.md', source, { kind: 'text', text: 'Poprzednik' });
    await f.store.seal(a.draftId!, 'finished');
    const view = new DraftView(f.store, f.persistence, f.io, null, [a.freeze()]);
    const h = await prepareSubToolExecution({ execution: { kind: 'overlay-read', view }, tool: { name: 'read', source: 'built-in' }, args: {}, callId: 'call', app: f.app, plugin: f.plugin });
    t.deepEqual(await view.list(), { files: [], folders: ['Nowy'], ambiguous: [] });
    t.is(await h.app.vault.cachedRead({ path: 'Nowy/b.md' }), 'Poprzednik');
    await t.throwsAsync(h.app.vault.create('new.md', 'Nie'), { code: 'mutation-denied' });
    t.is(await f.app.vault.read({ path: 'a.md' }), 'Baza');
});
