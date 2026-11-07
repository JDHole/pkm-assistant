import test from 'ava';
import { createHash } from 'node:crypto';
import { DraftStore, DraftPersistence, DraftError, DRAFT_ROOT, parseDraftId, parseVaultPath,
    parseChangeId, parseBlobId, parseContentHash, parseRevision, parseDraftManifest } from './index.js';
import type { DraftManifest, DraftMutation, DraftStorageIO, DraftVaultIO, VaultPath, VaultStat } from './index.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
const hasher = { sha256: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex') };
const id = parseDraftId('draft-a');
const a = parseVaultPath('a.md');
const source = { tool: 'write', callId: 'call-1' };
const identity = { draftId: id, owner: { agentName: 'Lead', sessionPath: 'sessions/one.md', sessionEpoch: 'a'.repeat(32) },
    runId: '../run/metadata-only', threadId: '../thread/metadata-only' };
function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
class Storage implements DraftStorageIO {
    files = new Map<string, Uint8Array>();
    failPublication = false;
    beforePublish?: () => Promise<void>;
    beforeBlob?: () => Promise<void>;
    async list(path: string): Promise<string[]> {
        return [...new Set([...this.files.keys()].filter(key => key.startsWith(`${path}/`))
            .map(key => key.slice(path.length + 1).split('/')[0]))];
    }
    async read(path: string): Promise<Uint8Array> {
        const bytes = this.files.get(path);
        if (!bytes) throw new Error(`Missing: ${path}`);
        return bytes.slice();
    }
    async writeBlob(path: string, bytes: Uint8Array): Promise<void> {
        await this.beforeBlob?.();
        const existing = this.files.get(path);
        if (existing && decode(existing) !== decode(bytes)) throw new Error('Immutable blob collision');
        this.files.set(path, bytes.slice());
    }
    async publish(path: string, bytes: Uint8Array, mayPublish: () => boolean): Promise<'published' | 'cancelled'> {
        await this.beforePublish?.();
        if (this.failPublication) throw new Error('disk full');
        if (!mayPublish()) return 'cancelled';
        if (this.files.has(path)) throw new Error('Generation already exists');
        this.files.set(path, bytes.slice());
        return 'published';
    }
}
class Vault implements DraftVaultIO {
    files = new Map<string, { bytes: Uint8Array; mtime: number }>([['a.md', { bytes: encode('Baza'), mtime: 7 }]]);
    folders = new Set<string>(['folder']);
    failRead = false;
    afterRead?: () => void;
    async stat(path: VaultPath): Promise<VaultStat> {
        const file = this.files.get(path);
        return file ? { kind: 'file', bytes: file.bytes.byteLength, mtime: file.mtime }
            : this.folders.has(path) ? { kind: 'folder' } : { kind: 'missing' };
    }
    async read(path: VaultPath): Promise<Uint8Array> {
        if (this.failRead) throw new Error('base read failed');
        const file = this.files.get(path);
        if (!file) throw new Error('Missing file');
        const bytes = file.bytes.slice();
        this.afterRead?.();
        return bytes;
    }
}
async function fixture() {
    const storage = new Storage(), vault = new Vault();
    const persistence = new DraftPersistence(storage, hasher);
    const clock = { now: () => 100 };
    const store = new DraftStore(persistence, vault, clock);
    await store.create(identity);
    return { storage, vault, persistence, clock, store,
        restart: () => new DraftStore(new DraftPersistence(storage, hasher), vault, clock) };
}
const write = (store: DraftStore, text: string, path = a) => store.mutate(id, { path, source, value: { kind: 'text', text } });
async function proposal(persistence: DraftPersistence, manifest: DraftManifest, path = a): Promise<string> {
    const change = manifest.changes.find(value => value.path === path);
    if (!change || change.proposed.kind !== 'text') throw new Error('Expected text change');
    const value = change.proposed;
    return decode(await persistence.readBlob(manifest.draftId, value.blob, value.hash, value.bytes));
}
async function base(persistence: DraftPersistence, manifest: DraftManifest, path = a): Promise<string> {
    const value = manifest.changes.find(change => change.path === path)?.base;
    if (value?.kind !== 'file') throw new Error('Expected file base');
    return decode(await persistence.readBlob(manifest.draftId, value.blob, value.version.hash, value.version.bytes));
}

test('two writes retain the first base and publish Druga without changing the vault', async t => {
    const { store, persistence, vault, storage } = await fixture();
    const first = await write(store, 'Pierwsza');
    vault.files.set('a.md', { bytes: encode('Kuba'), mtime: 9 });
    const second = await write(store, 'Druga');
    t.is(await proposal(persistence, second), 'Druga');
    t.is(await base(persistence, second), 'Baza');
    t.is(second.changes[0].id, first.changes[0].id);
    t.is(Number(second.changes[0].revision), 2);
    t.is(second.changes[0].base.kind === 'file' && second.changes[0].base.version.mtime, 7);
    t.is(decode(await vault.read(a)), 'Kuba');
    t.deepEqual([...new Set([...storage.files.keys()].map(path => path.split('/').slice(0, 4).join('/')))],
        ['.pkm-assistant/subagent-drafts/v1/draft-a']);
});

test('restart reads Druga with the same identifiers and pending review, sealing open work', async t => {
    const { store, restart, persistence, vault } = await fixture();
    await write(store, 'Pierwsza');
    const before = await write(store, 'Druga');
    const fresh = restart();
    const result = await fresh.restore();
    t.deepEqual(result.issues, []);
    t.deepEqual(result.drafts.map(value => [value.draftId, value.runId, value.threadId, value.owner]),
        [['draft-a', '../run/metadata-only', '../thread/metadata-only', identity.owner]]);
    t.deepEqual(result.drafts[0].changes, before.changes);
    t.deepEqual(result.drafts[0].changes[0].review, { kind: 'pending' });
    t.deepEqual(result.drafts[0].phase, { kind: 'sealed', reason: 'restart' });
    t.is(await proposal(persistence, fresh.snapshot(id)), 'Druga');
    t.is(await base(persistence, fresh.snapshot(id)), 'Baza');
    t.is(decode(await vault.read(a)), 'Baza');
    t.deepEqual((await restart().restore()).drafts, result.drafts);
});

test('manifest write failure preserves the previous complete content and returns io-error', async t => {
    const { store, storage, persistence, restart } = await fixture();
    await write(store, 'Pierwsza');
    storage.failPublication = true;
    await t.throwsAsync(write(store, 'Druga'), { instanceOf: DraftError, code: 'io-error' });
    t.is(await proposal(persistence, store.snapshot(id)), 'Pierwsza');
    storage.failPublication = false;
    t.is(await proposal(persistence, (await restart().restore()).drafts[0]), 'Pierwsza');
});

test('seal rejects a later write with draft-closed and preserves Druga on disk', async t => {
    const { store, restart, persistence } = await fixture();
    await write(store, 'Pierwsza');
    await write(store, 'Druga');
    t.deepEqual((await store.seal(id, 'stopped')).phase, { kind: 'sealed', reason: 'stopped' });
    t.throws(() => write(store, 'Spóźniona'), { instanceOf: DraftError, code: 'draft-closed' });
    const result = await restart().restore();
    t.is(await proposal(persistence, result.drafts[0]), 'Druga');
    t.deepEqual(result.drafts[0].phase, { kind: 'sealed', reason: 'stopped' });
});

test('invalid brands, traversal, manifest versions and inconsistent changes give validation errors', async t => {
    t.throws(() => parseDraftId('../draft'), { code: 'invalid-id' });
    t.throws(() => parseChangeId('bad/id'), { code: 'invalid-id' });
    t.throws(() => parseBlobId('../blob'), { code: 'invalid-hash' });
    t.throws(() => parseContentHash('hash'), { code: 'invalid-hash' });
    t.throws(() => parseRevision(0), { code: 'invalid-revision' });
    for (const value of ['../a.md', 'a/../b.md', '/a.md', 'a//b.md', 'C:/a.md', 'a\\b.md', 'a\0.md', './a.md', 'a/', '.pkm-assistant/subagent-drafts/v1/draft-a', '.PKM-ASSISTANT/Subagent-Drafts/v1/a'])
        t.throws(() => parseVaultPath(value), { code: 'invalid-path' });
    t.is(String(parseVaultPath('Notatki/Żółć.md')), 'Notatki/Żółć.md');
    const { store } = await fixture();
    const manifest = await write(store, 'Druga');
    t.throws(() => parseDraftManifest({ ...manifest, createdAt: NaN }), { code: 'invalid-manifest' });
    t.throws(() => parseDraftManifest({ ...manifest, version: 2 }), { code: 'invalid-version' });
    t.throws(() => parseDraftManifest({ ...manifest, changes: [...manifest.changes, ...manifest.changes] }), { code: 'invalid-manifest' });
    t.deepEqual(parseDraftManifest(manifest).changes[0].review, { kind: 'pending' });
});

test('create then delete removes the net change and retains other literal bases', async t => {
    const { store, persistence, restart } = await fixture();
    const newPath = parseVaultPath('nowy.md');
    await write(store, 'Druga');
    await write(store, 'Nowa', newPath);
    const result = await store.mutate(id, { path: newPath, source, value: { kind: 'deleted', disposition: 'trash' } });
    t.deepEqual(result.changes.map(change => change.path), ['a.md']);
    t.is(await base(persistence, result), 'Baza');
    t.is(await proposal(persistence, result), 'Druga');
    const restored = (await restart().restore()).drafts[0];
    t.deepEqual(restored.changes.map(change => change.path), ['a.md']);
    t.is(await base(persistence, restored), 'Baza');
    const only = await fixture();
    await write(only.store, 'Nowa', newPath);
    await only.store.mutate(id, { path: newPath, source, value: { kind: 'deleted', disposition: 'permanent' } });
    const empty = (await only.restart().restore()).drafts[0];
    t.deepEqual(empty.changes, []);
    t.deepEqual(empty.firstTouches, [{ id: 'change-1', path: 'nowy.md', base: { kind: 'missing' } }]);
});

test('concurrent writes serialize each path and retain changes to different paths', async t => {
    const { store, persistence } = await fixture();
    const b = parseVaultPath('b.md');
    await Promise.all([write(store, 'Pierwsza'), write(store, 'Druga'), write(store, 'Obok', b)]);
    const snapshot = store.snapshot(id);
    t.is(await proposal(persistence, snapshot), 'Druga');
    t.is(await proposal(persistence, snapshot, b), 'Obok');
    t.is(await base(persistence, snapshot), 'Baza');
    t.is(Number(snapshot.revision), 3);
    t.is(new Set(snapshot.changes.map(change => change.id)).size, 2);
});

test('failed operation does not poison the path queue', async t => {
    const { store, storage, persistence } = await fixture();
    await write(store, 'Pierwsza');
    storage.failPublication = true;
    await t.throwsAsync(write(store, 'Błąd'), { code: 'io-error' });
    storage.failPublication = false;
    t.is(await proposal(persistence, await write(store, 'Druga')), 'Druga');
    t.is(await base(persistence, store.snapshot(id)), 'Baza');
});

test('Stop during blob I/O seals the last complete generation and rejects late publication', async t => {
    const { store, storage, persistence, restart } = await fixture();
    await write(store, 'Gotowe');
    const entered = barrier(), release = barrier();
    storage.beforeBlob = async () => { entered.resolve(); await release.promise; };
    const late = write(store, 'Spóźniona');
    const rejected = t.throwsAsync(late, { code: 'draft-closed' });
    await entered.promise;
    await store.seal(id, 'stopped');
    release.resolve();
    await rejected;
    t.is(await proposal(persistence, (await restart().restore()).drafts[0]), 'Gotowe');
});

test('Stop at the manifest publication boundary cancels the candidate generation', async t => {
    const { store, storage, persistence, restart } = await fixture();
    await write(store, 'Gotowe');
    const entered = barrier(), release = barrier();
    storage.beforePublish = async () => { entered.resolve(); await release.promise; };
    const late = write(store, 'Spóźniona');
    const rejected = t.throwsAsync(late, { code: 'draft-closed' });
    await entered.promise;
    const sealed = store.seal(id, 'timeout');
    storage.beforePublish = undefined;
    release.resolve();
    await rejected;
    t.deepEqual((await sealed).phase, { kind: 'sealed', reason: 'timeout' });
    t.is(await proposal(persistence, (await restart().restore()).drafts[0]), 'Gotowe');
});

test('incomplete manifest recovery reports the error and restores the previous complete generation', async t => {
    const { store, storage, restart, persistence } = await fixture();
    await write(store, 'Pierwsza');
    await write(store, 'Druga');
    const damaged = `${DRAFT_ROOT}/draft-a/manifests/000003.json`;
    storage.files.set(damaged, encode('{"payload":'));
    const result = await restart().restore();
    t.is(result.issues[0].path, damaged);
    t.is(result.issues[0].code, 'invalid-manifest');
    t.is(await proposal(persistence, result.drafts[0]), 'Druga');
    t.is(decode(await storage.read(damaged)), '{"payload":');
    t.is(result.drafts[0].generation, 4);
});

test('blob corruption is reported and cannot become a proposal after restart', async t => {
    const { store, storage, restart, persistence } = await fixture();
    await write(store, 'Pierwsza');
    const manifest = await write(store, 'Druga');
    const value = manifest.changes[0].proposed;
    if (value.kind !== 'text') throw new Error('Expected text');
    storage.files.set(`${DRAFT_ROOT}/draft-a/blobs/${value.blob}`, encode('Kopaa'));
    const result = await restart().restore();
    t.is(result.issues[0].code, 'integrity-error');
    t.is(await proposal(persistence, result.drafts[0]), 'Pierwsza');
});

test('base capture retries changed stat and refuses an unstable or unreadable base', async t => {
    const { store, vault, persistence } = await fixture();
    vault.afterRead = () => { vault.files.set('a.md', { bytes: encode('Nowa baza'), mtime: 8 }); vault.afterRead = undefined; };
    t.is(await base(persistence, await write(store, 'Druga')), 'Nowa baza');
    const unstable = await fixture();
    let mtime = 7;
    unstable.vault.afterRead = () => { unstable.vault.files.set('a.md', { bytes: encode('Baza'), mtime: ++mtime }); };
    await t.throwsAsync(write(unstable.store, 'Druga'), { code: 'base-unstable' });
    unstable.vault.afterRead = undefined;
    t.is(await base(unstable.persistence, await write(unstable.store, 'Druga')), 'Baza');
    const unreadable = await fixture();
    unreadable.vault.failRead = true;
    await t.throwsAsync(write(unreadable.store, 'Druga'), { code: 'io-error' });
    unreadable.vault.failRead = false;
    t.is(await base(unreadable.persistence, await write(unreadable.store, 'Druga')), 'Baza');
});

test('binary, folders and deletion survive restart with their literal values', async t => {
    const { store, restart, persistence, vault } = await fixture();
    await store.mutate(id, { path: parseVaultPath('obrazy/a.png'), source, value: { kind: 'binary', bytes: new Uint8Array([0, 255, 1, 128]) } });
    await store.mutate(id, { path: parseVaultPath('nowy-folder'), source, value: { kind: 'folder' } });
    await store.mutate(id, { path: a, source, value: { kind: 'deleted', disposition: 'permanent' } });
    const result = (await restart().restore()).drafts[0];
    t.deepEqual(result.changes.map(change => [change.path, change.proposed.kind]),
        [['obrazy/a.png', 'binary'], ['nowy-folder', 'folder'], ['a.md', 'deleted']]);
    const value = result.changes[0].proposed;
    if (value.kind !== 'binary') throw new Error('Expected binary');
    t.deepEqual([...await persistence.readBlob(id, value.blob, value.hash, value.bytes)], [0, 255, 1, 128]);
    t.deepEqual(result.changes[2].proposed, { kind: 'deleted', disposition: 'permanent' });
    t.is(await base(persistence, result), 'Baza');
    t.is(decode(await vault.read(a)), 'Baza');
});

test('illegal file/folder transitions fail while existing proposals remain readable', async t => {
    const { store, persistence } = await fixture();
    await write(store, 'Druga');
    await t.throwsAsync(write(store, 'Nie', parseVaultPath('folder')), { code: 'invalid-transition' });
    await t.throwsAsync(store.mutate(id, { path: a, source, value: { kind: 'folder' } }), { code: 'invalid-transition' });
    await t.throwsAsync(store.mutate(id, { path: parseVaultPath('missing.md'), source, value: { kind: 'deleted', disposition: 'trash' } }), { code: 'invalid-transition' });
    t.is(await proposal(persistence, store.snapshot(id)), 'Druga');
});

test('idle drafts create no persisted work and returned snapshots do not mutate the store', async t => {
    const { store, storage, persistence, restart } = await fixture();
    t.deepEqual(await storage.list(DRAFT_ROOT), []);
    t.deepEqual((await store.seal(id, 'finished')).phase, { kind: 'sealed', reason: 'finished' });
    t.deepEqual(await restart().restore(), { drafts: [], issues: [] });
    const secondId = parseDraftId('draft-b');
    await store.create({ ...identity, draftId: secondId });
    const result = await store.mutate(secondId, { path: a, source, value: { kind: 'text', text: 'Osobna' } });
    Object.assign(result, { changes: [] });
    Object.assign(store.snapshot(secondId), { changes: [] });
    t.is(await proposal(persistence, store.snapshot(secondId)), 'Osobna');
});

test('future manifest version is reported without fallback or rewriting its directory', async t => {
    const { store, storage, restart } = await fixture();
    const current = await write(store, 'Druga');
    const payload = JSON.stringify({ ...current, version: 2, generation: 2 });
    const path = `${DRAFT_ROOT}/draft-a/manifests/000002.json`;
    const bytes = encode(JSON.stringify({ payload, checksum: await hasher.sha256(encode(payload)) }));
    storage.files.set(path, bytes);
    const result = await restart().restore();
    t.deepEqual(result.drafts, []);
    t.is(result.issues[0].code, 'invalid-version');
    t.is(decode(await storage.read(path)), decode(bytes));
    t.deepEqual(await storage.list(`${DRAFT_ROOT}/draft-a/manifests`), ['000001.json', '000002.json']);
});

test('restored applying state requires recovery and never accepts the file automatically', async t => {
    const { store, persistence, restart, vault } = await fixture();
    const manifest = await write(store, 'Druga');
    await persistence.save({ ...manifest, phase: { kind: 'sealed', reason: 'finished' },
        changes: manifest.changes.map(change => ({ ...change, review: { kind: 'applying', attemptId: 'attempt-1', approvedRevision: change.revision } })) }, () => true);
    const result = await restart().restore();
    t.deepEqual(result.drafts[0].changes[0].review, { kind: 'recovery-required', attemptId: 'attempt-1' });
    t.is(await proposal(persistence, result.drafts[0]), 'Druga');
    t.is(decode(await vault.read(a)), 'Baza');
});

test('create-delete-create keeps the first missing base even after an external file appears', async t => {
    const { store, vault, persistence } = await fixture();
    const path = parseVaultPath('new.md');
    await write(store, 'Nowa', path);
    await store.mutate(id, { path, source, value: { kind: 'deleted', disposition: 'trash' } });
    vault.files.set(path, { bytes: encode('Kuba'), mtime: 8 });
    const result = await write(store, 'Ponownie', path);
    t.deepEqual(result.changes[0].base, { kind: 'missing' });
    t.is(await proposal(persistence, result, path), 'Ponownie');
    t.is(decode(await vault.read(path)), 'Kuba');
});

test('binary input is captured at admission, before the caller can modify it', async t => {
    const { store, persistence } = await fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    const mutation: DraftMutation = { path: a, source, value: { kind: 'binary', bytes } };
    const pending = store.mutate(id, mutation);
    bytes[0] = 99;
    const value = (await pending).changes[0].proposed;
    if (value.kind !== 'binary') throw new Error('Expected binary');
    t.deepEqual([...await persistence.readBlob(id, value.blob, value.hash, value.bytes)], [1, 2, 3]);
});

test('failed seal keeps mutation rights revoked and retry durably closes the same content', async t => {
    const { store, persistence, storage, restart } = await fixture();
    await write(store, 'Gotowe');
    storage.failPublication = true;
    await t.throwsAsync(store.seal(id, 'failed'), { code: 'io-error' });
    t.throws(() => write(store, 'Później'), { code: 'draft-closed' });
    t.is(await proposal(persistence, store.snapshot(id)), 'Gotowe');
    storage.failPublication = false;
    await store.seal(id, 'failed');
    const recovered = (await restart().restore()).drafts[0];
    t.deepEqual(recovered.phase, { kind: 'sealed', reason: 'failed' });
    t.is(await proposal(persistence, recovered), 'Gotowe');
});

test('manifest checksum prevents a valid-looking tampered proposal from being restored', async t => {
    const { store, storage, persistence, restart } = await fixture();
    await write(store, 'Pierwsza');
    await write(store, 'Druga');
    const path = `${DRAFT_ROOT}/draft-a/manifests/000002.json`;
    const envelope = JSON.parse(decode(await storage.read(path))) as { payload: string; checksum: string };
    envelope.payload = envelope.payload.replace('call-1', 'call-2');
    storage.files.set(path, encode(JSON.stringify(envelope)));
    const result = await restart().restore();
    t.is(result.issues[0].code, 'integrity-error');
    t.is(await proposal(persistence, result.drafts[0]), 'Pierwsza');
    t.deepEqual(result.drafts[0].changes[0].source, { tool: 'write', callId: 'call-1' });
});

test('fractional filesystem timestamps survive base capture and recovery exactly', async t => {
    const { store, vault, restart } = await fixture();
    vault.files.set('a.md', { bytes: encode('Baza'), mtime: 7.125 });
    await write(store, 'Druga');
    const value = (await restart().restore()).drafts[0].changes[0].base;
    t.is(value.kind === 'file' && value.version.mtime, 7.125);
});
