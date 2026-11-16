import { syntheticVaultIndex } from './test-support/syntheticVaultIndex.js';
import { createDraftFileIndex } from './draftFileIndex.js';
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
async function fixture(initial: Record<string, string> = { 'a.md': 'Baza' }, indexed = false) {
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
    if (indexed) {
        Object.assign(app.vault, syntheticVaultIndex(files, folders));
        Object.assign(io, { index: createDraftFileIndex(app as never) });
    }
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


for (const indexed of [false, true]) test(`F2g hidden host contract indexed=${indexed}`, async t => {
    const f = await fixture({ 'Notes/a.md': 'Visible', '.hidden/data.md': 'Hidden', '.pkm-assistant/subagent-drafts/v1/private.md': 'Private' }, indexed);
    const view = await f.view('hidden-contract');
    const h = await createDraftToolHost(view, { writable: true, source, requestedPaths: ['.hidden/data.md'] });
    t.deepEqual(h.vault.getAbstractFileByPath('.hidden/data.md'), { path: '.hidden/data.md', name: 'data.md', basename: 'data', extension: 'md', stat: { size: 6, mtime: 7, ctime: 7 } });
    t.deepEqual(h.vault.getAbstractFileByPath('.hidden')?.children, []);
    t.deepEqual(h.vault.getFiles().map(f => f.path), ['Notes/a.md']);
    t.deepEqual(await h.vault.adapter.list('.hidden'), { files: ['.hidden/data.md'], folders: [], ambiguous: [] });
    t.deepEqual(await h.vault.adapter.stat('.hidden/data.md'), { type: 'file', size: 6, mtime: 7, ctime: 0 });
    t.is(await h.vault.adapter.read('.hidden/data.md'), 'Hidden');
    await h.vault.adapter.write('.hidden/new.md', 'Draft');
    t.is(h.vault.getAbstractFileByPath('.hidden/new.md')?.stat.size, 5);
    t.is(await h.vault.adapter.read('.hidden/new.md'), 'Draft');
    t.deepEqual(await h.vault.adapter.list('.pkm-assistant'), { files: [], folders: [], ambiguous: [] });
    t.throws(() => h.vault.getAbstractFileByPath('.pkm-assistant/subagent-drafts/v1/private.md'), { code: 'invalid-path' });
});

// Exercise both compositions on identical synthetic bytes, then pin key results literally.
test('F2g indexed and legacy hosts return the same tool results and proposal bytes', async t => {
    const execute = async (indexed: boolean) => {
        const f = await fixture({ 'Notes/base.md': 'Base', 'Notes/nested/leaf.md': 'Leaf',
            '.pkm-assistant/custom/data.md': 'Hidden' }, indexed);
        const view = await f.view('equivalence');
        const results: unknown[] = [];
        const call = async (name: string, args: Record<string, unknown>) => {
            const h = await f.prepare(view, name, args);
            const tool = { read: createReadTool(), list: createListTool(), search: createSearchTool(), write: createWriteTool(),
                delete: createDeleteTool(), create_folder: createCreateFolderTool(h.app) }[name];
            if (!tool) throw new Error('Unknown test tool');
            const value = await tool.execute(args, h.app, h.plugin, context);
            results.push(value);
            return value;
        };
        await call('read', { path: 'Notes/base.md' });
        await call('list', { folder: 'Notes', scope: 'vault' });
        await call('list', { folder: 'Notes', scope: 'vault', recursive: true });
        await call('write', { path: 'Notes/new.md', mode: 'create', content: 'New' });
        await call('write', { path: 'Notes/base.md', mode: 'replace', content: 'Replacement' });
        await call('write', { path: 'Notes/base.md', mode: 'patch', old_text: 'Replacement', new_text: 'Patched' });
        await call('write', { path: 'Notes/base.md', mode: 'append', content: ' tail' });
        await call('search', { scope: 'vault', mode: 'keyword', query: 'Patched' });
        await call('search', { scope: 'vault', mode: 'text', query: 'Patched', where: { folder: 'Notes', glob: '*.md' } });
        await call('create_folder', { path: 'Created/Nested' });
        await call('delete', { path: 'Notes/nested/leaf.md' });
        // Admin tools take their existing adapter branch after normal validation.
        const admin = { name: 'Tester', admin_access: true };
        Object.assign(f.plugin.agentManager, { getActiveAgent: () => admin, getAgent: () => admin });
        await call('read', { path: '.pkm-assistant/custom/data.md' });
        await call('write', { path: '.pkm-assistant/custom/data.md', content: 'Hidden draft' });
        await call('list', { scope: 'vault', folder: '.pkm-assistant/custom', recursive: true });
        await call('read', { path: '.pkm-assistant/custom' });
        await call('write', { path: '.pkm-assistant/custom/new.md', mode: 'create', content: 'New hidden' });
        await call('read', { path: '.pkm-assistant/subagent-drafts/v1/private.md' });
        const bytes = await Promise.all(['Notes/base.md', 'Notes/new.md', '.pkm-assistant/custom/data.md', '.pkm-assistant/custom/new.md'].map(path => view.read(path)));
        return { results, bytes, manifest: f.store.snapshot(view.draftId!) };
    };
    const legacy = await execute(false), indexed = await execute(true);
    t.deepEqual(indexed, legacy);
    t.deepEqual(indexed.bytes, ['Patched tail', 'New', 'Hidden draft', 'New hidden']);
    t.deepEqual(indexed.results[0], { success: true, path: 'Notes/base.md', content: 'Base' });
    t.like(indexed.results[7], { success: true, results: [{ path: 'Notes/base.md', excerpt: 'Patched tail' }] });
    t.like(indexed.results[8], { success: true, mode_used: 'text', results: [{ path: 'Notes/base.md' }] });
    t.like(indexed.results[14], { success: false });
    t.deepEqual(indexed.manifest.changes.map(change => [change.path, change.proposed.kind]), [
        ['Notes/new.md', 'text'], ['Notes/base.md', 'text'], ['Created/Nested', 'folder'],
        ['Notes/nested/leaf.md', 'deleted'], ['.pkm-assistant/custom/data.md', 'text'], ['.pkm-assistant/custom/new.md', 'text'],
    ]);
});

test('F2g synchronous index updates only the touched path and parents, including technical folders', async t => {
    const exercise = async (indexed: boolean) => {
        const f = await fixture({ 'Notes/base.md': 'Base', 'z.txt': 'Text' }, indexed), view = await f.view('sync');
        const h = await createDraftToolHost(view, { writable: true, source });
        const before = h.vault.getAbstractFileByPath('Notes');
        await h.vault.create('Notes/new.md', 'New');
        const created = h.vault.getAbstractFileByPath('Notes/new.md');
        const children = h.vault.getAbstractFileByPath('Notes')!.children!.map(child => child.path);
        const files = h.vault.getFiles().map(file => file.path), markdown = h.vault.getMarkdownFiles().map(file => file.path);
        await h.vault.createFolder('Technical/Parent');
        await h.vault.create('Technical/Parent/new.md', 'Technical');
        await h.vault.delete({ path: 'Notes/base.md' });
        return { created, children, files, markdown, root: h.vault.getRoot().children!.map(child => child.path),
            after: h.vault.getAbstractFileByPath('Notes')!.children!.map(child => child.path),
            technical: h.vault.getAbstractFileByPath('Technical')!.children!.map(child => child.path),
            changes: f.store.snapshot(view.draftId!).changes.map(change => [change.path, change.proposed.kind]),
            base: before!.path };
    };
    const legacy = await exercise(false), indexed = await exercise(true);
    t.deepEqual(indexed, legacy);
    t.deepEqual(indexed, {
        created: { path: 'Notes/new.md', name: 'new.md', basename: 'new', extension: 'md', stat: { size: 3, mtime: 1, ctime: 1 } },
        children: ['Notes/base.md', 'Notes/new.md'], files: ['z.txt', 'Notes/base.md', 'Notes/new.md'],
        markdown: ['Notes/base.md', 'Notes/new.md'], root: ['z.txt', 'Notes', 'Technical'], after: ['Notes/new.md'],
        technical: ['Technical/Parent'], changes: [['Notes/new.md', 'text'], ['Technical/Parent/new.md', 'text'], ['Notes/base.md', 'deleted']], base: 'Notes',
    });
});

test('F2g predecessor proposals, tombstones and A/B ambiguity retain host results', async t => {
    const exercise = async (indexed: boolean) => {
        const f = await fixture({ 'Notes/base.md': 'Base', 'Notes/remove.md': 'Remove' }, indexed);
        const a = await f.view('a'), b = await f.view('b');
        await a.mutate('Notes/base.md', source, { kind: 'text', text: 'A' });
        await a.mutate('Notes/remove.md', source, { kind: 'deleted', disposition: 'trash' });
        await a.mutate('New/Deep/new.md', source, { kind: 'text', text: 'Ancestor' });
        await b.mutate('Notes/base.md', source, { kind: 'text', text: 'B' });
        await f.store.seal(a.draftId!, 'finished'); await f.store.seal(b.draftId!, 'finished');
        const c = await f.view('c', [a.freeze()]);
        const inherited = await f.prepare(c, 'read', { path: 'New/Deep/new.md' });
        const read = await createReadTool().execute({ path: 'New/Deep/new.md' }, inherited.app, inherited.plugin);
        const paths = inherited.app.vault.getFiles().map(file => file.path);
        const d = await f.view('d', [a.freeze(), b.freeze()]);
        const ambiguous = await f.prepare(d, 'list', { folder: 'Notes', scope: 'vault' });
        const listed = await createListTool().execute({ folder: 'Notes', scope: 'vault' }, ambiguous.app, ambiguous.plugin);
        const adapter = await ambiguous.app.vault.adapter.list('Notes');
        t.throws(() => ambiguous.app.vault.getAbstractFileByPath('Notes/base.md'), { code: 'ambiguous-input' });
        await t.throwsAsync(ambiguous.app.vault.cachedRead({ path: 'Notes/base.md' }), { code: 'ambiguous-input' });
        await t.throwsAsync(ambiguous.app.vault.modify({ path: 'Notes/base.md' }, 'No winner'), { code: 'ambiguous-input' });
        await c.mutate('New/Deep/new.md', source, { kind: 'deleted', disposition: 'trash' });
        const tombstone = await f.prepare(c);
        return { read, paths, listed, adapter, remaining: tombstone.app.vault.getFiles().map(file => file.path) };
    };
    const legacy = await exercise(false), indexed = await exercise(true);
    t.deepEqual(indexed, legacy);
    t.deepEqual(indexed.read, { success: true, path: 'New/Deep/new.md', content: 'Ancestor' });
    t.deepEqual(indexed.paths, ['New/Deep/new.md', 'Notes/base.md']);
    t.deepEqual(indexed.remaining, ['Notes/base.md']);
    t.like(indexed.listed, { success: true, files: [{ path: 'Notes/base.md', status: 'ambiguous-input', sources: [
        { draftId: 'draft-a', revision: 3 }, { draftId: 'draft-b', revision: 1 },
    ] }], count: 1 });
});

test('F2g artifact create, update, read and list are equivalent and metadata stays inside its folder', async t => {
    const execute = async (indexed: boolean) => {
        const f = await fixture({ 'Outside.md': 'Unrelated' }, indexed), view = await f.view('artifacts');
        const createdHost = await f.prepare(view, 'artifact_create');
        const created = await artifact(createArtifactCreateTool(), { typ: 'plan', tytul: 'Example', pola: { cel: 'Base' } }, createdHost);
        if (created === null || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') throw new Error(JSON.stringify(created));
        const updateHost = await f.prepare(view, 'artifact_update');
        const update = await artifact(createArtifactUpdateTool(), { id: created.id, ops: [{ op: 'set_field', key: 'status', value: 'closed' }] }, updateHost);
        const readHost = await f.prepare(view, 'artifact_read');
        const read = await artifact(createArtifactReadTool(), { id: created.id }, readHost);
        const list = await artifact(createArtifactListTool(), {}, readHost);
        return { created, update, read, list, text: await view.read('Artifacts/Tester/2026-11-07 Example.md') };
    };
    const legacy = await execute(false), indexed = await execute(true);
    // Artifact IDs are intentionally random. Normalize only that identifier in all fields and bytes.
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/art-20261107-[a-f0-9]+/g, 'ARTIFACT'));
    t.deepEqual(normalize(indexed), normalize(legacy));
    t.like(indexed.update, { applied: 1, errors: [], artifact: { frontmatter: { status: 'closed' } } });
    t.like(indexed.list, { artifacts: [{ path: 'Artifacts/Tester/2026-11-07 Example.md', status: 'closed' }] });
    t.true(indexed.text.includes('cel: Base'));
});

for (const size of [50, 500]) test(`F2g view listing ${size} files needs one stat and one list`, async t => {
    const initial: Record<string, string> = {};
    const paths = Array.from({ length: size }, (_, i) => `Listed/n${String(i).padStart(3, '0')}.md`);
    for (const path of paths) initial[path] = 'Text';
    const f = await fixture(initial, true), view = await f.view('listing');
    const counts = { stat: 0, list: 0, read: 0 }, original = { ...f.io };
    f.io.stat = path => { counts.stat++; return original.stat(path); };
    f.io.list = path => { counts.list++; return original.list(path); };
    f.io.read = path => { counts.read++; return original.read(path); };
    t.deepEqual(await view.list('Listed'), { files: paths, folders: [], ambiguous: [] });
    t.deepEqual(counts, { stat: 1, list: 1, read: 0 });
    // DraftViewIO requires full logical child paths, unlike private storage's name-only port.
    f.io.list = async () => ({ files: ['n000.md'], folders: [] });
    await t.throwsAsync(view.list('Listed'), { code: 'invalid-path', message: 'Listing returned a non-child path' });
});

for (const size of [30, 3000]) test(`F2g artifact metadata reads only its subtree with ${size} unrelated files`, async t => {
    const initial: Record<string, string> = {
        'Artifacts/Tester/a.md': '---\nstatus: draft\n---\nBody',
        'Artifacts/Tester/b.md': '---\nstatus: closed\n---\nOther',
    };
    for (let i = 0; i < size; i++) initial[`Unrelated/n${i}.md`] = 'Unrelated';
    const f = await fixture(initial, true), view = await f.view('metadata');
    const trace: string[] = [], original = { ...f.io };
    f.io.stat = path => { trace.push(`stat:${path}`); return original.stat(path); };
    f.io.list = path => { trace.push(`list:${path}`); return original.list(path); };
    f.io.read = path => { trace.push(`read:${path}`); return original.read(path); };
    Object.assign(f.io.index!, { files: () => { throw new Error('Metadata must not enumerate the vault'); } });
    const h = await createDraftToolHost(view, { writable: true, source, metadataFolder: 'Artifacts' });
    t.deepEqual(h.metadataCache.getFileCache({ path: 'Artifacts/Tester/a.md' }), { frontmatter: { status: 'draft' } });
    t.deepEqual(trace, ['stat:Artifacts', 'list:Artifacts', 'stat:Artifacts/Tester', 'list:Artifacts/Tester',
        'read:Artifacts/Tester/a.md', 'read:Artifacts/Tester/b.md']);
    await h.vault.modify({ path: 'Artifacts/Tester/a.md' }, '---\nstatus: closed\n---\nChanged');
    t.deepEqual(h.metadataCache.getFileCache({ path: 'Artifacts/Tester/a.md' }), { frontmatter: { status: 'closed' } });
    t.is(await h.vault.cachedRead({ path: 'Artifacts/Tester/a.md' }), '---\nstatus: closed\n---\nChanged');
    t.deepEqual(trace.slice(6), ['stat:Artifacts/Tester/a.md', 'stat:Artifacts', 'stat:Artifacts/Tester',
        'stat:Artifacts/Tester/a.md', 'read:Artifacts/Tester/a.md', 'stat:Artifacts/Tester/a.md']);
});

test('F2g stale index metadata never supplies first-touch bytes or version', async t => {
    const f = await fixture({ 'Notes/base.md': 'Base' }, true), view = await f.view('stale');
    const original = f.io.index!.get;
    Object.assign(f.io.index!, { get: (path: string) => path === 'Notes/base.md'
        ? { kind: 'file', path, bytes: 1, mtime: 0 } : original(path) });
    const h = await createDraftToolHost(view, { writable: true, source });
    t.deepEqual(h.vault.getAbstractFileByPath('Notes/base.md')?.stat, { size: 1, mtime: 0, ctime: 0 });
    t.is(await h.vault.cachedRead({ path: 'Notes/base.md' }), 'Base');
    await h.vault.process({ path: 'Notes/base.md' }, text => `${text} changed`);
    t.is(await h.vault.cachedRead({ path: 'Notes/base.md' }), 'Base changed');
    t.deepEqual(f.store.snapshot(view.draftId!).firstTouches, [{ id: 'change-1', path: 'Notes/base.md', base: {
        kind: 'file', blob: '7b47361aad19bb483aeab081a7df0a55f7cb0fdb3327efe6dd016e6353a17880',
        version: { kind: 'file', hash: '7b47361aad19bb483aeab081a7df0a55f7cb0fdb3327efe6dd016e6353a17880', bytes: 4, mtime: 7 },
    } }]);
});

test('F2g create then delete removes implicit parents in visible and hidden paths', async t => {
    for (const indexed of [false, true]) {
        const f = await fixture({ 'base.md': 'Base' }, indexed), view = await f.view(`net-${indexed}`);
        const h = await createDraftToolHost(view, { writable: true, source });
        for (const path of ['New/Deep/new.md', '.hidden/Deep/new.md']) {
            await h.vault.adapter.write(path, 'Draft');
            t.is(h.vault.getAbstractFileByPath(path)?.stat.size, 5);
            await h.vault.adapter.remove(path);
            t.is(h.vault.getAbstractFileByPath(path), null);
            t.is(h.vault.getAbstractFileByPath(path.slice(0, path.lastIndexOf('/'))), null);
        }
        t.deepEqual(h.vault.getRoot().children!.map(entry => entry.path), ['base.md']);
        t.is(await h.vault.cachedRead({ path: 'base.md' }), 'Base');
    }
});

test('F2g hidden metadata folder keeps historical cache and visibility', async t => {
    const read = async (indexed: boolean) => {
        const f = await fixture({ 'visible.md': 'Visible', '.hidden/artifacts/a.md': '---\nstatus: draft\n---\nBody' }, indexed);
        const view = await f.view('hidden-metadata');
        const h = await createDraftToolHost(view, { writable: true, source, metadataFolder: '.hidden/artifacts' });
        return { cache: h.metadataCache.getFileCache({ path: '.hidden/artifacts/a.md' }),
            files: h.vault.getMarkdownFiles().map(file => file.path),
            hidden: h.vault.getAbstractFileByPath('.hidden/artifacts/a.md') };
    };
    const indexed = await read(true);
    t.deepEqual(indexed, await read(false));
    t.deepEqual(indexed.cache, { frontmatter: { status: 'draft' } });
    t.deepEqual(indexed.files, ['visible.md']);
    t.is(indexed.hidden?.path, '.hidden/artifacts/a.md');
});

test('F2g technical folder ordering survives refresh and promotion to a proposal parent', async t => {
    const exercise = async (indexed: boolean) => {
        const f = await fixture({ 'base.md': 'Base' }, indexed), view = await f.view('technical-order');
        const h = await createDraftToolHost(view, { writable: true, source });
        await h.vault.createFolder('Z/Child');
        await h.vault.createFolder('A/Child');
        const technical = h.vault.getRoot().children!.map(entry => entry.path);
        await h.vault.create('A/Child/new.md', 'New');
        return { technical, proposed: h.vault.getRoot().children!.map(entry => entry.path),
            changes: f.store.snapshot(view.draftId!).changes.map(change => change.path) };
    };
    const indexed = await exercise(true);
    t.deepEqual(indexed, await exercise(false));
    t.deepEqual(indexed, { technical: ['base.md', 'Z', 'A'], proposed: ['base.md', 'A', 'Z'], changes: ['A/Child/new.md'] });
});

for (const root of ['Branch', '.pkm-assistant/custom/Branch']) test(`F2g ancestor file or ambiguity retains descendant visibility: ${root}`, async t => {
    const exercise = async (indexed: boolean) => {
        const f = await fixture({ 'base.md': 'Base' }, indexed), a = await f.view('a'), b = await f.view('b');
        await a.mutate(root, source, { kind: 'text', text: 'File' });
        await b.mutate(`${root}/child.md`, source, { kind: 'text', text: 'Child' });
        await f.store.seal(a.draftId!, 'finished'); await f.store.seal(b.draftId!, 'finished');
        const other = await f.view('other');
        await other.mutate(root, source, { kind: 'text', text: 'Different file' });
        await f.store.seal(other.draftId!, 'finished');
        const ambiguous = await f.view('ambiguous', [a.freeze(), b.freeze(), other.freeze()]);
        const ambiguousHost = await f.prepare(ambiguous, 'read', { path: `${root}/child.md` });
        t.is(ambiguousHost.app.vault.getAbstractFileByPath(`${root}/child.md`), null);
        t.is(await ambiguousHost.app.vault.adapter.read(`${root}/child.md`), 'Child');
        const c = await f.view('c', [a.freeze(), b.freeze()]), h = await f.prepare(c, 'read', { path: `${root}/child.md` });
        return { paths: h.app.vault.getFiles().map(file => file.path), child: h.app.vault.getAbstractFileByPath(`${root}/child.md`),
            adapterRead: await h.app.vault.adapter.read(`${root}/child.md`) };
    };
    const indexed = await exercise(true);
    t.deepEqual(indexed, await exercise(false));
    t.deepEqual(indexed, { paths: root === 'Branch' ? ['Branch', 'base.md'] : ['base.md'], child: null, adapterRead: 'Child' });
});

test('F2g technical folder still follows legacy visibility over a file tombstone', async t => {
    const exercise = async (indexed: boolean) => {
        const f = await fixture({ 'base.md': 'Base' }, indexed), view = await f.view('technical-tombstone');
        const h = await createDraftToolHost(view, { writable: true, source });
        await h.vault.delete({ path: 'base.md' });
        await h.vault.createFolder('base.md');
        await h.vault.create('base.md/child.md', 'Child');
        return { root: h.vault.getRoot().children!.map(file => file.path), children: h.vault.getAbstractFileByPath('base.md')?.children,
            files: h.vault.getFiles().map(file => file.path), child: h.vault.getAbstractFileByPath('base.md/child.md'),
            read: await h.vault.adapter.read('base.md/child.md') };
    };
    const indexed = await exercise(true);
    t.deepEqual(indexed, await exercise(false));
    t.deepEqual(indexed, { root: ['base.md'], children: [], files: [], child: null, read: 'Child' });
});

// Literal results below were replayed against the complete f5f13b6 tree,
// including its DraftView.list, not just today's no-index fallback.
for (const descendant of [false, true]) test(`F2h technical descendants survive a tombstone: proposal=${descendant}`, async t => {
    const exercise = async (indexed: boolean) => {
        const f = await fixture({ A: 'Base', 'B/file.md': 'Other' }, indexed), view = await f.view('technical');
        const h = await createDraftToolHost(view, { writable: true, source });
        await h.vault.delete({ path: 'A' });
        if (descendant) await h.vault.create('A/child.md', 'child');
        await h.vault.createFolder('A/deep');
        return { root: h.vault.getRoot().children!.map(entry => entry.path),
            a: h.vault.getAbstractFileByPath('A'), deep: h.vault.getAbstractFileByPath('A/deep'),
            child: h.vault.getAbstractFileByPath('A/child.md'), files: h.vault.getFiles().map(entry => entry.path),
            exists: await h.vault.adapter.exists('A/deep') };
    };
    const indexed = await exercise(true);
    t.deepEqual(indexed, await exercise(false));
    t.deepEqual(indexed, {
        root: ['B', 'A'],
        a: { path: 'A', name: 'A', basename: 'A', extension: '', stat: { size: 0, mtime: 0, ctime: 0 }, children: [
            { path: 'A/deep', name: 'deep', basename: 'deep', extension: '', stat: { size: 0, mtime: 0, ctime: 0 }, children: [] },
        ] },
        deep: { path: 'A/deep', name: 'deep', basename: 'deep', extension: '', stat: { size: 0, mtime: 0, ctime: 0 }, children: [] },
        child: null, files: ['B/file.md'], exists: true,
    });
});

test('F2h rejected mkdir preserves the synchronous view under a tombstone', async t => {
    for (const indexed of [false, true]) {
        const f = await fixture({ A: 'Base' }, indexed), view = await f.view('failed');
        const h = await createDraftToolHost(view, { writable: true, source });
        await h.vault.delete({ path: 'A' });
        await h.vault.create('A/child.md', 'child');
        const snapshot = () => ({ a: h.vault.getAbstractFileByPath('A'), child: h.vault.getAbstractFileByPath('A/child.md'),
            root: h.vault.getRoot().children!.map(entry => entry.path), files: h.vault.getFiles().map(entry => entry.path) });
        t.deepEqual(snapshot(), { a: null, child: null, root: [], files: [] });
        await t.throwsAsync(h.vault.createFolder('A/child.md'), { code: 'invalid-transition' });
        t.deepEqual(snapshot(), { a: null, child: null, root: [], files: [] });
        t.is(await h.vault.adapter.read('A/child.md'), 'child');
        // Legacy mkdir records technical parents even on failure, but refreshes only on success.
        t.true(await h.vault.adapter.exists('A'));
    }
});

test('F2h root and folder children preserve technical insertion and proposal ordering', async t => {
    const exercise = async (indexed: boolean) => {
        const f = await fixture({ 'base.md': 'Base', 'Notes/z.md': 'Z', 'Notes/a.md': 'A' }, indexed), view = await f.view('ordering');
        const h = await createDraftToolHost(view, { writable: true, source });
        await h.vault.createFolder('Z/Child');
        await h.vault.createFolder('A/Child');
        await h.vault.createFolder('Notes/Z/Child');
        await h.vault.createFolder('Notes/A/Child');
        const snapshot = () => ({ root: h.vault.getRoot().children!.map(entry => entry.path),
            notes: h.vault.getAbstractFileByPath('Notes')!.children!.map(entry => entry.path) });
        const before = snapshot();
        await h.vault.create('A/Child/new.md', 'New');
        await h.vault.create('Notes/A/Child/new.md', 'New');
        await h.vault.create('Notes/m.md', 'M');
        return { before, after: snapshot() };
    };
    const indexed = await exercise(true);
    t.deepEqual(indexed, await exercise(false));
    t.deepEqual(indexed, {
        before: { root: ['base.md', 'Notes', 'Z', 'A'], notes: ['Notes/a.md', 'Notes/z.md', 'Notes/Z', 'Notes/A'] },
        after: { root: ['base.md', 'A', 'Notes', 'Z'], notes: ['Notes/a.md', 'Notes/m.md', 'Notes/z.md', 'Notes/A', 'Notes/Z'] },
    });
});
