import test from 'ava';
import { createHash } from 'node:crypto';
import type { App } from 'obsidian';
import { Validator } from '@cfworker/json-schema';
import { DraftStore, DraftPersistence, DraftReview, parseDraftId, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftStorageIO, DraftReviewContext, DraftMutation, ChangeSummary, ReviewDecision, DraftManifest } from '../vault-drafts/index.js';
import { PermissionSystem } from '../../core/index.js';
import { createSubagentChangesTool } from './SubagentChangesTool.js';
import { createDraftReviewHost } from './draftReviewHost.js';
import { MCPClient } from './MCPClient.js';
import type { DiffApprovalOptions, ExecuteToolCallOptions } from './MCPClient.js';
import { ToolRegistry } from './ToolRegistry.js';

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const owner = { agentName: 'Lead', sessionPath: 'sessions/one.md', sessionEpoch: 'a'.repeat(32) };
const hasher = { sha256: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex') };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
type Result = ReviewDecision & { message?: string };
type Listed = { kind: 'listed'; changes: ChangeSummary[]; next_cursor: string | null };
async function fixture() {
    const disk = new Map<string, Uint8Array>();
    let failPublish = false;
    let beforePublish: (() => void) | undefined;
    const storage: DraftStorageIO = {
        remove: async path => { disk.delete(path); },
        list: async path => [...new Set([...disk.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1).split('/')[0]))],
        read: async path => { const bytes = disk.get(path); if (!bytes) throw new Error('missing'); return bytes.slice(); },
        writeBlob: async (path, bytes) => { disk.set(path, bytes.slice()); },
        publish: async (path, bytes, allowed) => {
            beforePublish?.();
            if (failPublish) throw new Error('disk full');
            if (!allowed()) return 'cancelled';
            if (disk.has(path)) throw new Error('exists');
            disk.set(path, bytes.slice()); return 'published';
        },
    };
    const events = new Map<string, Set<(entry: { path: string }) => void>>();
    const emit = (name: string, path: string) => { for (const handler of events.get(name) ?? []) handler({ path }); };
    const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
    const trash = new Map<string, Uint8Array>();
    let atDestructiveOperation: (() => Promise<void>) | undefined;
    const folders = new Set<string>();
    const set = (path: string, text: string | Uint8Array, mtime = 7) => { files.set(path, { bytes: typeof text === 'string' ? encode(text) : text.slice(), mtime }); emit('modify', path); };
    set('x.md', 'Baza'); set('y.md', 'Baza-Y');
    let processHook: (() => void) | undefined;
    let writeHook: (() => void) | undefined;
    let failRead = false;
    const writes: string[] = [];
    const read = async (path: string) => { if (failRead) throw new Error('read failed'); const value = files.get(path); if (!value) throw new Error('missing'); return value.bytes.slice(); };
    const entry = (path: string) => files.has(path) ? { path, get stat() { return { mtime: files.get(path)!.mtime }; } } : null;
    const create = async (path: string, data: string | ArrayBuffer) => {
        if (files.has(path) || folders.has(path)) throw new Error('exists');
        writes.push(`create:${path}`); set(path, typeof data === 'string' ? data : new Uint8Array(data), 10); return entry(path);
    };
    const process = async (path: string, transform: (value: string) => string) => {
        processHook?.();
        const next = transform(decode(await read(path)));
        writes.push(`process:${path}`); set(path, next, 10); writeHook?.(); return next;
    };
    const remove = async (path: string) => { writes.push(`delete:${path}`); files.delete(path); emit('delete', path); };
    const app = { vault: {
        on: (name: string, handler: (entry: { path: string }) => void) => {
            if (!events.has(name)) events.set(name, new Set());
            events.get(name)!.add(handler); return { name, handler };
        },
        offref: (ref: { name: string; handler: (entry: { path: string }) => void }) => events.get(ref.name)?.delete(ref.handler),
        getFileByPath: entry, getAbstractFileByPath: entry,
        read: async (file: { path: string }) => decode(await read(file.path)),
        process: (file: { path: string }, transform: (value: string) => string) => process(file.path, transform),
        create, createBinary: create,
        modifyBinary: async (file: { path: string }, bytes: ArrayBuffer) => { await atDestructiveOperation?.(); writes.push(`binary:${file.path}`); set(file.path, new Uint8Array(bytes), 10); writeHook?.(); },
        createFolder: async (path: string) => { if (files.has(path) || folders.has(path)) throw new Error('exists'); writes.push(`folder:${path}`); folders.add(path); },
        trash: async (file: { path: string }) => { await atDestructiveOperation?.(); trash.set(file.path, (await read(file.path)).slice()); writes.push('trash'); await remove(file.path); },
        delete: async (file: { path: string }) => { await atDestructiveOperation?.(); await remove(file.path); },
        adapter: {
            stat: async (path: string) => { const value = files.get(path); return value ? { type: 'file', size: value.bytes.length, mtime: value.mtime }
                : folders.has(path) ? { type: 'folder' } : null; },
            readBinary: async (path: string) => (await read(path)).buffer,
            read: async (path: string) => decode(await read(path)), process,
        },
    } };
    const io = createDraftReviewHost(app as unknown as App);
    const persistence = new DraftPersistence(storage, hasher);
    const store = new DraftStore(persistence, io, { now: () => 100 });
    const review = new DraftReview(store, persistence, io);
    const agent = { name: 'Lead', permissions: { guidance_mode: true }, disabled_tools: [] as string[],
        hasPermission: () => true };
    const other = { ...agent, name: 'Other' };
    const permissionSystem = new PermissionSystem(app.vault, {});
    let approve: (options: DiffApprovalOptions) => Promise<unknown> = async () => 'approve';
    let approveGeneral: () => Promise<{ result: string; rememberForSession?: boolean }> = async () => ({ result: 'approve' });
    const previews: DiffApprovalOptions[] = [];
    const approvals: string[] = [];
    const plugin = { permissionSystem, approvalManager: { requestApproval: async (action: { type: string }) => { approvals.push(action.type); return approveGeneral(); } },
        agentManager: { getAgent: (name: string | null) => name === 'Lead' ? agent : name === 'Other' ? other : null, getActiveAgent: () => agent } };
    const tool = createSubagentChangesTool(review), registry = new ToolRegistry();
    registry.registerTool(tool);
    const client = new MCPClient(app, plugin, registry, { diffModalFactory: (_app, options) => {
        previews.push(options); return { waitForApproval: () => approve(options) };
    } });
    const call = (args: Record<string, unknown>, opts: ExecuteToolCallOptions = {}, name = 'Lead') =>
        client.executeToolCall({ name: 'subagent_changes', arguments: args }, name, { origin: owner, autonomy: 'yolo', ...opts });
    const make = async (id = 'draft-a', changes: [string, DraftMutation['value'], string?][] = [['x.md', { kind: 'text', text: 'Propozycja' }]], identity = owner, seal = true) => {
        const draftId = parseDraftId(id);
        await store.create({ draftId, owner: identity, runId: `run-${id}`, threadId: `thread-${id}` });
        for (const [path, value, toolName] of changes) await store.mutate(draftId, { path: parseVaultPath(path), source: { tool: toolName ?? 'write', callId: 'call-1' }, value });
        if (seal) await store.seal(draftId, 'finished');
        return store.snapshot(draftId);
    };
    const decision = (manifest: DraftManifest, path = 'x.md', action = 'accept') => {
        const change = manifest.changes.find(item => item.path === path)!;
        return { action, draft_id: manifest.draftId, change_id: change.id, revision: change.revision };
    };
    const restart = async () => { const next = new DraftStore(new DraftPersistence(storage, hasher), io, { now: () => 101 }); await next.restore(); return next; };
    return { files, set, folders, writes, trash,
        atDestructive: (fn: () => Promise<void>) => { atDestructiveOperation = fn; }, disk, storage, io, persistence, store, review, client, tool, registry, call, make, decision,
        agent, previews, approvals, restart, text: (path = 'x.md') => decode(files.get(path)!.bytes),
        approval: (fn: typeof approve) => { approve = fn; }, general: (fn: typeof approveGeneral) => { approveGeneral = fn; },
        onProcess: (fn: () => void) => { processHook = fn; }, onWrite: (fn: () => void) => { writeHook = fn; },
        onPublish: (fn: () => void) => { beforePublish = fn; }, failDisk: () => { failPublish = true; }, failRead: () => { failRead = true; },
    };
}

test('P4 public list → accept X → reject Y persists independent decisions', async t => {
    const f = await fixture();
    const draft = await f.make('draft-a', [['x.md', { kind: 'text', text: 'Propozycja' }], ['y.md', { kind: 'text', text: 'Szkic-Y' }]]);
    const listed = await f.call({ action: 'list' }) as Listed;
    t.deepEqual(listed.changes.map(c => [c.path, c.status, c.run_id]), [['x.md', 'pending', 'run-draft-a'], ['y.md', 'pending', 'run-draft-a']]);
    t.is((await f.call(f.decision(draft)) as Result).kind, 'accepted');
    t.is(f.text(), 'Propozycja'); t.is(f.text('y.md'), 'Baza-Y');
    t.is(f.store.snapshot(draft.draftId).changes[1].review.kind, 'pending');
    t.deepEqual(await f.call(f.decision(draft, 'y.md', 'reject')), { kind: 'rejected' });
    const restored = await f.restart();
    t.deepEqual(restored.snapshot(draft.draftId).changes.map(c => c.review.kind), ['accepted', 'rejected']);
    t.is(f.text('y.md'), 'Baza-Y');
});

for (const [label, text, mtime] of [['content and mtime', 'Kuba', 9], ['same mtime', 'Kuba', 7], ['mtime only', 'Baza', 9]] as const) {
    test(`P4 conflict detects ${label} before consent`, async t => {
        const f = await fixture(), draft = await f.make(); f.set('x.md', text, mtime);
        const result = await f.call(f.decision(draft), { autonomy: 'all' }) as Result;
        t.is(result.kind, 'conflict'); t.is(f.text(), text);
        t.deepEqual([f.previews.length, f.approvals.length, f.writes.length], [0, 0, 0]);
        t.is((await f.restart()).snapshot(draft.draftId).changes[0].review.kind, 'conflict');
    });
}

test('P4 edit while diff is open conflicts after approval', async t => {
    const f = await fixture(), draft = await f.make();
    const opened = deferred<void>(), answer = deferred<string>();
    f.approval(async () => { opened.resolve(); return answer.promise; });
    const pending = f.call(f.decision(draft), { autonomy: 'all' });
    await opened.promise;
    t.deepEqual([f.previews[0].oldContent, f.previews[0].newContent], ['Baza', 'Propozycja']);
    f.set('x.md', 'Kuba', 8); answer.resolve('approve');
    t.is((await pending as Result).kind, 'conflict'); t.is(f.text(), 'Kuba');
});

test('P4 two reviewers serialize the same path and preserve an independent file', async t => {
    const f = await fixture(), a = await f.make('draft-a'), b = await f.make('draft-b', [['x.md', { kind: 'text', text: 'B' }]]);
    const y = await f.make('draft-y', [['y.md', { kind: 'text', text: 'Y' }]]);
    const opened = deferred<void>(), answer = deferred<string>();
    f.approval(async () => { opened.resolve(); return answer.promise; });
    const first = f.call(f.decision(a), { autonomy: 'all' }); await opened.promise;
    const context: DraftReviewContext = { kind: 'main', owner, authorize: () => true, approve: async () => true };
    const secondReview = new DraftReview(f.store, f.persistence, f.io);
    const second = secondReview.decide(context, { action: 'accept', draftId: b.draftId, changeId: b.changes[0].id, revision: b.changes[0].revision });
    t.is((await f.call(f.decision(y, 'y.md')) as Result).kind, 'accepted');
    t.is(f.text('y.md'), 'Y'); answer.resolve('approve');
    t.deepEqual([(await first as Result).kind, (await second).kind], ['accepted', 'conflict']);
    t.is(f.text(), 'Propozycja');
});

test('P4 accepted revision is idempotent even after restart and later vault edit', async t => {
    const f = await fixture(), draft = await f.make();
    const accepted = await f.call(f.decision(draft));
    f.set('x.md', 'Kuba', 12);
    t.deepEqual(await f.call(f.decision(draft)), accepted);
    const store = await f.restart(), review = new DraftReview(store, f.persistence, f.io);
    t.deepEqual(await review.decide({ kind: 'main', owner, authorize: () => true, approve: async () => { throw new Error('must not ask'); } },
        { action: 'accept', draftId: draft.draftId, changeId: draft.changes[0].id, revision: draft.changes[0].revision }), accepted);
    t.deepEqual(f.writes, ['process:x.md']); t.is(f.text(), 'Kuba');
});

for (const modal of ['general', 'diff'] as const) test(`P4 denial in ${modal} modal leaves pending`, async t => {
    const f = await fixture(), draft = await f.make();
    if (modal === 'general') f.general(async () => ({ result: 'deny' })); else f.approval(async () => 'deny');
    t.is((await f.call(f.decision(draft), { autonomy: 'all' }) as Result).kind, 'denied');
    t.is(f.store.snapshot(draft.draftId).changes[0].review.kind, 'pending'); t.is(f.text(), 'Baza');
    t.deepEqual(await f.call(f.decision(draft, 'x.md', 'reject')), { kind: 'rejected' });
});

test('P4 yolo skips windows but enforces access and source tool switches', async t => {
    const f = await fixture(), draft = await f.make('draft-a', [['x.md', { kind: 'text', text: 'Propozycja' }, 'artifact_update']]);
    f.agent.disabled_tools = ['artifact_update'];
    t.is((await f.call(f.decision(draft)) as Result).kind, 'denied'); t.is(f.text(), 'Baza');
    f.agent.disabled_tools = []; f.agent.permissions.guidance_mode = false;
    t.is((await f.call(f.decision(draft)) as Result).kind, 'denied'); t.is(f.text(), 'Baza');
    f.agent.permissions.guidance_mode = true;
    t.is((await f.call(f.decision(draft)) as Result).kind, 'accepted'); t.is(f.text(), 'Propozycja');
    t.deepEqual([f.previews.length, f.approvals.length], [0, 0]);
});

test('P4 permissions revoked during diff prevent acceptance', async t => {
    const f = await fixture(), draft = await f.make();
    f.approval(async () => { f.agent.disabled_tools = ['write']; return 'approve'; });
    t.is((await f.call(f.decision(draft), { autonomy: 'all' }) as Result).kind, 'denied');
    t.is(f.text(), 'Baza'); t.is(f.store.snapshot(draft.draftId).changes[0].review.kind, 'pending');
});

test('P4 callback checks fresh text inside vault.process', async t => {
    const f = await fixture(), draft = await f.make(); f.onProcess(() => f.set('x.md', 'Kuba', 7));
    t.is((await f.call(f.decision(draft)) as Result).kind, 'conflict'); t.is(f.text(), 'Kuba');
    t.is((await f.restart()).snapshot(draft.draftId).changes[0].review.kind, 'conflict');
});

test('P4 restart after durable intent requires recovery without replay', async t => {
    const f = await fixture(), draft = await f.make();
    const state = await f.restart();
    await state.setReview(draft.draftId, draft.changes[0].id, draft.changes[0].revision,
        { kind: 'applying', attemptId: 'interrupted', approvedRevision: draft.changes[0].revision });
    const restored = await f.restart();
    const review = new DraftReview(restored, f.persistence, f.io);
    t.deepEqual(await review.decide({ kind: 'main', owner, authorize: () => true, approve: async () => true },
        { action: 'accept', draftId: draft.draftId, changeId: draft.changes[0].id, revision: draft.changes[0].revision }),
    { kind: 'recovery-required', attemptId: 'interrupted' });
    t.is(f.text(), 'Baza'); t.deepEqual(f.writes, []);
});

test('P4 failed decision persistence after write never reapplies the proposal', async t => {
    const f = await fixture(), draft = await f.make(); f.onWrite(() => f.failDisk());
    t.is((await f.call(f.decision(draft)) as Result).kind, 'recovery-required');
    t.is((await f.call(f.decision(draft)) as Result).kind, 'recovery-required');
    t.is(f.text(), 'Propozycja'); t.deepEqual(f.writes, ['process:x.md']);
});

test('P4 failed intent persistence and unreadable preview do not touch vault', async t => {
    const f = await fixture(), draft = await f.make(); f.failDisk();
    t.is((await f.call(f.decision(draft)) as Result).kind, 'denied'); t.is(f.text(), 'Baza');
    const g = await fixture(), other = await g.make(); g.failRead();
    t.is((await g.call(g.decision(other)) as Result).kind, 'denied'); t.is(g.text(), 'Baza');
});

test('P4 wrong owner, missing runtime context, sub and spoofed context are denied', async t => {
    const f = await fixture(), draft = await f.make();
    const args = f.decision(draft);
    t.is((await f.call(args, { origin: { ...owner, agentName: 'Other' } }, 'Other') as Result).kind, 'denied');
    t.is((await f.call(args, { origin: null }) as Result).kind, 'denied');
    t.is((await f.call(args, { delegationDepth: 1 }) as Result).kind, 'denied');
    t.is((await f.call({ ...args, _invocationOrigin: owner, draftReview: { kind: 'main', owner } }) as Result).kind, 'denied');
    t.is((await f.tool.execute(args) as Result).kind, 'denied');
    const detail = await f.call({ action: 'list', draft_id: draft.draftId, change_id: draft.changes[0].id }) as Listed;
    t.deepEqual(detail.changes[0].preview, { kind: 'text', oldContent: 'Baza', newContent: 'Propozycja' });
    t.is(f.text(), 'Baza');
});

test('P4 list scopes isolate sessions and agents; agent scope discovers old drafts', async t => {
    const f = await fixture(); await f.make(); await f.make('old', [['y.md', { kind: 'text', text: 'Old' }]], { ...owner, sessionEpoch: 'b'.repeat(32) });
    await f.make('foreign', [['x.md', { kind: 'text', text: 'Foreign' }]], { ...owner, agentName: 'Other' });
    t.deepEqual((await f.call({ action: 'list' }) as Listed).changes.map(c => [c.draft_id, c.path]), [['draft-a', 'x.md']]);
    t.deepEqual((await f.call({ action: 'list', scope: 'agent' }) as Listed).changes.map(c => [c.draft_id, c.path]), [['draft-a', 'x.md'], ['old', 'y.md']]);
    f.agent.permissions.guidance_mode = false;
    t.deepEqual(await f.call({ action: 'list', scope: 'agent' }), { kind: 'listed', changes: [], next_cursor: null });
    t.is(f.text(), 'Baza');
});

test('P4 schema rejects bulk, force, content, paths, missing draft and invalid revisions', async t => {
    const f = await fixture(), draft = await f.make(), valid = f.decision(draft);
    const validator = new Validator(f.tool.inputSchema);
    for (const input of [{ ...valid, all: true }, { ...valid, force: true }, { ...valid, path: 'y.md' }, { ...valid, content: 'Injected' },
        { ...valid, revision: 0 }, { ...valid, revision: 1.5 }, { action: 'list', change_id: 'change-1' }, { ...valid, draft_id: '../a' }]) {
        t.false(validator.validate(input).valid); t.is((await f.call(input) as Result).kind, 'denied');
    }
    t.is((await f.call({ ...valid, revision: 99 }) as Result).kind, 'stale-revision');
    const open = await f.make('open', [['y.md', { kind: 'text', text: 'Open' }]], owner, false);
    t.is((await f.call(f.decision(open, 'y.md')) as Result).kind, 'not-sealed'); t.is(f.text(), 'Baza');
});

test('P4 detail truncates text explicitly and list pagination preserves paths', async t => {
    const f = await fixture();
    const entries: [string, DraftMutation['value']][] = Array.from({ length: 52 }, (_, i) => [`file-${i}.md`, { kind: 'text', text: 'A'.repeat(3000) }]);
    const draft = await f.make('large', entries);
    const page = await f.call({ action: 'list' }) as Listed;
    const next = await f.call({ action: 'list', cursor: page.next_cursor }) as Listed;
    t.is(page.changes.length, 50); t.is(next.changes.length, 2);
    t.deepEqual([...page.changes, ...next.changes].map(c => c.path).sort(), entries.map(e => e[0]).sort());
    const detail = await f.call({ action: 'list', draft_id: draft.draftId, change_id: draft.changes[0].id }) as Listed;
    t.deepEqual(detail.changes[0].preview, { kind: 'text', oldContent: '', newContent: 'A'.repeat(2000) });
    t.is(detail.changes[0].truncated, true); t.is(f.text(), 'Baza');
});

for (const disposition of ['trash', 'permanent'] as const) test(`P4 deletion ${disposition} previews removal and always uses trash`, async t => {
    const f = await fixture(), draft = await f.make('delete', [['x.md', { kind: 'deleted', disposition }, 'delete']]);
    t.is((await f.call(f.decision(draft), { autonomy: 'all' }) as Result).kind, 'accepted');
    t.deepEqual(f.previews[0].preview, { kind: 'deleted', oldContent: 'Baza', newContent: '' });
    t.is(f.previews[0].rememberAvailable, false);
    t.deepEqual(f.writes, ['trash', 'delete:x.md']);
    t.is(decode(f.trash.get('x.md')!), 'Baza');
    t.deepEqual(await f.io.stat(parseVaultPath('x.md')), { kind: 'missing' }); t.is(f.text('y.md'), 'Baza-Y');
});

test('P4 binary and folder acceptance have typed previews without base64 or session consent', async t => {
    const f = await fixture(); f.set('image.png', new Uint8Array([0, 255, 1]));
    const draft = await f.make('binary', [['image.png', { kind: 'binary', bytes: new Uint8Array([7, 8, 9, 10]) }, 'add_text_to_image'], ['Folder', { kind: 'folder' }, 'create_folder']]);
    const listed = await f.call({ action: 'list', draft_id: draft.draftId, change_id: draft.changes[0].id }) as Listed;
    t.deepEqual(listed.changes[0].preview, { kind: 'binary', operation: 'replace', oldBytes: 3, newBytes: 4 });
    f.client.sessionWriteConsent.grant(owner.sessionPath, 'image.png');
    t.is((await f.call(f.decision(draft, 'image.png'), { autonomy: 'all' }) as Result).kind, 'accepted');
    t.deepEqual([...f.files.get('image.png')!.bytes], [7, 8, 9, 10]);
    t.is(f.previews[0].rememberAvailable, false); t.is(f.previews[0].oldContent, '');
    t.is((await f.call(f.decision(draft, 'Folder'), { autonomy: 'all' }) as Result).kind, 'accepted');
    t.deepEqual(f.previews[1].preview, { kind: 'folder' });
    t.deepEqual(await f.io.stat(parseVaultPath('Folder')), { kind: 'folder' });
});

for (const kind of ['binary', 'deleted'] as const) test(`P4 final hash check blocks ${kind} change during intent publication`, async t => {
    const f = await fixture(); f.set('image.png', new Uint8Array([1, 2]));
    const value: DraftMutation['value'] = kind === 'binary' ? { kind, bytes: new Uint8Array([3, 4]) } : { kind, disposition: 'trash' };
    const draft = await f.make('final', [['image.png', value, kind === 'binary' ? 'add_text_to_image' : 'delete']]);
    f.onPublish(() => f.set('image.png', new Uint8Array([9, 9]), 7));
    t.is((await f.call(f.decision(draft, 'image.png')) as Result).kind, 'conflict');
    t.deepEqual([...f.files.get('image.png')!.bytes], [9, 9]); t.deepEqual(f.writes, []);
});

test('P4 new file creates authorized parents without accepting other proposals', async t => {
    const f = await fixture(), draft = await f.make('new', [['A/B/new.md', { kind: 'text', text: 'New' }]]);
    t.is((await f.call(f.decision(draft, 'A/B/new.md')) as Result).kind, 'accepted');
    t.is(f.text('A/B/new.md'), 'New'); t.deepEqual([...f.folders], ['A', 'A/B']); t.is(f.text(), 'Baza');
});

test('P4 acceptance preserves predecessor conflict base after a later user edit', async t => {
    const f = await fixture(), a = await f.make('a'); f.set('x.md', 'Kuba', 9);
    const id = parseDraftId('c'); await f.store.create({ draftId: id, owner, runId: 'c', threadId: 'c' });
    await f.store.mutate(id, { path: parseVaultPath('x.md'), source: { tool: 'write', callId: 'c' }, value: { kind: 'text', text: 'C' } },
        [{ draftId: a.draftId, revision: a.revision }]);
    const c = await f.store.seal(id, 'finished');
    const result = await f.call(f.decision(c)) as Result;
    t.is(result.kind, 'conflict'); if (result.kind === 'conflict') t.is(result.reason, 'dependency-changed');
    t.is(f.text(), 'Kuba');
});

test('P4 acceptance writes an immutable intent containing exact base and proposal', async t => {
    const f = await fixture(), draft = await f.make();
    t.is((await f.call(f.decision(draft)) as Result).kind, 'accepted');
    const paths = [...f.disk.keys()].filter(path => path.includes('/decisions/'));
    t.is(paths.length, 1);
    const envelope = JSON.parse(decode(f.disk.get(paths[0])!)) as { payload: string; checksum: string };
    const intent = JSON.parse(envelope.payload) as { attemptId: string; path: string; base: { blob: string }; proposed: { blob: string } };
    const base = [...f.disk.entries()].find(([path]) => path.endsWith(`/blobs/${intent.base.blob}`))!;
    const proposed = [...f.disk.entries()].find(([path]) => path.endsWith(`/blobs/${intent.proposed.blob}`))!;
    t.deepEqual([intent.path, decode(base[1]), decode(proposed[1])], ['x.md', 'Baza', 'Propozycja']);
    t.is(envelope.checksum, createHash('sha256').update(envelope.payload).digest('hex'));
    const restored = await f.restart();
    const state = restored.snapshot(draft.draftId).changes[0].review;
    t.is(state.kind, 'accepted'); if (state.kind === 'accepted') t.is(state.attemptId, intent.attemptId);
    t.is(f.text(), 'Propozycja');
});

test('P4 session consent applies to text only and still checks conflict', async t => {
    const f = await fixture(), draft = await f.make();
    f.client.sessionWriteConsent.grant(owner.sessionPath, 'x.md');
    t.is((await f.call(f.decision(draft), { autonomy: 'all' }) as Result).kind, 'accepted');
    t.is(f.text(), 'Propozycja'); t.deepEqual([f.previews.length, f.approvals.length], [0, 0]);
    const next = await f.make('next'); f.set('x.md', 'Kuba', 13);
    t.is((await f.call(f.decision(next), { autonomy: 'all' }) as Result).kind, 'conflict'); t.is(f.text(), 'Kuba');
});

test('P4 permission to create implicit parents is checked before approval', async t => {
    const f = await fixture(), draft = await f.make('parent', [['Parent/new.md', { kind: 'text', text: 'New' }]]);
    f.agent.disabled_tools = ['create_folder'];
    t.is((await f.call(f.decision(draft, 'Parent/new.md'), { autonomy: 'all' }) as Result).kind, 'denied');
    t.deepEqual(await f.io.stat(parseVaultPath('Parent')), { kind: 'missing' });
    t.is(f.store.snapshot(draft.draftId).changes[0].review.kind, 'pending'); t.is(f.text(), 'Baza');
});

test('P4 stopped acceptance cannot apply a late approved diff', async t => {
    const f = await fixture(), draft = await f.make(), controller = new AbortController();
    f.approval(async () => { controller.abort(); return 'approve'; });
    t.is((await f.call(f.decision(draft), { autonomy: 'all', abortSignal: controller.signal }) as Result).kind, 'denied');
    t.is(f.store.snapshot(draft.draftId).changes[0].review.kind, 'pending'); t.is(f.text(), 'Baza');
});

test('P4 parallel denied acceptances share existing denial memory without extra windows', async t => {
    const f = await fixture(), a = await f.make('a'), b = await f.make('b');
    f.approval(async () => 'deny');
    const results = await Promise.all([f.call(f.decision(a), { autonomy: 'all' }), f.call(f.decision(b), { autonomy: 'all' })]);
    t.deepEqual(results.map(result => (result as Result).kind), ['denied', 'denied']);
    t.deepEqual(f.store.list().map(draft => draft.changes[0].review.kind), ['pending', 'pending']);
    t.deepEqual([f.previews.length, f.approvals.length], [1, 1]); t.is(f.text(), 'Baza');
});

for (const kind of ['binary', 'deleted'] as const) test(`F5 host barrier ${kind} preserves recovery bytes and reports uncertainty`, async t => {
    const f = await fixture(); f.set('image.png', new Uint8Array([1, 2]));
    const value: DraftMutation['value'] = kind === 'binary' ? { kind, bytes: new Uint8Array([3, 4]) } : { kind, disposition: 'permanent' };
    const draft = await f.make('race', [['image.png', value]]);
    const entered = deferred<void>(), release = deferred<void>();
    f.atDestructive(async () => { entered.resolve(); await release.promise; });
    const pending = f.call(f.decision(draft, 'image.png'));
    await entered.promise;
    // Receipt and blob already exist BEFORE the host's destructive operation.
    const applying = f.store.snapshot(draft.draftId).changes[0].review;
    const backup = 'recoveryBlob' in applying ? applying.recoveryBlob! : undefined;
    const beforeOperation = backup && [...await f.persistence.readBlob(draft.draftId, backup.blob, backup.hash, backup.bytes)];
    f.set('image.png', new Uint8Array([9, 9]), 8);
    release.resolve();
    const result = await pending as Result;
    t.is(result.kind, 'recovery-required');
    t.is(applying.kind, 'applying');
    t.deepEqual(beforeOperation, [1, 2]);
    t.deepEqual('recoveryBlob' in result ? result.recoveryBlob : undefined, backup);
    const restored = await f.restart();
    const saved = restored.snapshot(draft.draftId).changes[0].review;
    t.is(saved.kind, 'recovery-required');
    t.deepEqual('recoveryBlob' in saved ? saved.recoveryBlob : undefined, backup);
    if (kind === 'deleted') {
        t.deepEqual([...f.trash.get('image.png')!], [9, 9]);
        t.deepEqual(f.writes, ['trash', 'delete:image.png']);
    } else t.deepEqual([...f.files.get('image.png')!.bytes], [3, 4]);
    await restored.collectResolved();
    t.deepEqual([...await f.persistence.readBlob(draft.draftId, backup!.blob, backup!.hash, backup!.bytes)], [1, 2]);
});

for (const kind of ['binary', 'deleted'] as const) test(`F5 ${kind} result mismatch retains readable recovery receipt`, async t => {
    const f = await fixture(); f.set('image.png', new Uint8Array([1, 2]));
    const draft = await f.make('mismatch', [['image.png', kind === 'binary'
        ? { kind, bytes: new Uint8Array([3, 4]) } : { kind, disposition: 'trash' }]]);
    if (kind === 'binary') f.onWrite(() => f.set('image.png', new Uint8Array([7, 7])));
    else {
        const remove = f.io.deleteFile;
        f.io.deleteFile = async (...args) => { await remove(...args); f.set('image.png', new Uint8Array([7, 7])); };
    }
    const result = await f.call(f.decision(draft, 'image.png')) as Result;
    t.is(result.kind, 'recovery-required');
    const blob = 'recoveryBlob' in result ? result.recoveryBlob! : undefined;
    t.deepEqual(blob && [...await f.persistence.readBlob(draft.draftId, blob.blob, blob.hash, blob.bytes)], [1, 2]);
    t.deepEqual([...f.files.get('image.png')!.bytes], [7, 7]);
});

test('F5 permission revoked during durable checkpoint prevents the destructive operation', async t => {
    const f = await fixture(); f.set('image.png', new Uint8Array([1, 2]));
    const draft = await f.make('revoked', [['image.png', { kind: 'binary', bytes: new Uint8Array([3, 4]) }]]);
    const publish = f.storage.publish;
    f.storage.publish = async (path, bytes, allowed) => {
        const envelope = JSON.parse(decode(bytes)) as { payload: string };
        if (envelope.payload.includes('"recoveryBlob"')) f.agent.permissions.guidance_mode = false;
        return publish(path, bytes, allowed);
    };
    const result = await f.call(f.decision(draft, 'image.png')) as Result;
    t.is(result.kind, 'recovery-required');
    t.deepEqual(f.writes, []);
    t.deepEqual([...f.files.get('image.png')!.bytes], [1, 2]);
    const backup = 'recoveryBlob' in result ? result.recoveryBlob! : undefined;
    t.deepEqual(backup && [...await f.persistence.readBlob(draft.draftId, backup.blob, backup.hash, backup.bytes)], [1, 2]);
});

test('F5 accepted binary recovery bytes survive payload GC and restart', async t => {
    const f = await fixture(); f.set('image.png', new Uint8Array([1, 2]));
    const draft = await f.make('receipt', [['image.png', { kind: 'binary', bytes: new Uint8Array([3, 4]) }]]);
    const result = await f.call(f.decision(draft, 'image.png')) as Result;
    t.is(result.kind, 'accepted');
    await f.store.collectResolved();
    const restored = await f.restart();
    t.is(restored.snapshot(draft.draftId).payloadCollected, true);
    const receipt = restored.snapshot(draft.draftId).changes[0].review;
    const blob = 'recoveryBlob' in receipt ? receipt.recoveryBlob! : undefined;
    t.deepEqual(blob && [...await f.persistence.readBlob(draft.draftId, blob.blob, blob.hash, blob.bytes)], [1, 2]);
    t.deepEqual([...f.files.get('image.png')!.bytes], [3, 4]);
});
