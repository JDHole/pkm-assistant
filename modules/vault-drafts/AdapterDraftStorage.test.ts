import test from 'ava';
import { createHash } from 'node:crypto';
import { AdapterDraftStorage, DraftStore, DraftPersistence, DRAFT_ROOT, parseDraftId, parseVaultPath } from './index.js';
import { MemoryAdapter } from './test-support/MemoryAdapter.js';

const target = `${DRAFT_ROOT}/sample/manifests/000001.json`;
const blob = `${DRAFT_ROOT}/sample/blobs/abc`;
const staging = `${DRAFT_ROOT}/.staging`;
const bytes = new Uint8Array([1, 2, 255]);
function fixture() {
    const adapter = new MemoryAdapter();
    return { adapter, port: new AdapterDraftStorage(adapter) };
}
function files(adapter: MemoryAdapter) {
    return [...adapter.files].map(([path, value]) => [path, [...value]]);
}
function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

// Every occurrence on the successful publication path, including parent mkdir/stat,
// staging readback, target readback and final cleanup. Expectations are literal states.
const publicationBoundaries = [
    ...Array.from({ length: 12 }, (_, i) => ({ operation: 'stat' as const, occurrence: i + 1,
        expected: i === 10 ? 'uncertain' : i === 11 ? 'published' : 'rejected' })),
    ...Array.from({ length: 6 }, (_, i) => ({ operation: 'mkdir' as const, occurrence: i + 1, expected: 'rejected' })),
    { operation: 'writeBinary' as const, occurrence: 1, expected: 'rejected' },
    { operation: 'readBinary' as const, occurrence: 1, expected: 'rejected' },
    { operation: 'readBinary' as const, occurrence: 2, expected: 'uncertain' },
    { operation: 'rename' as const, occurrence: 1, expected: 'rename' },
];
for (const boundary of publicationBoundaries) for (const moment of ['before', 'after'] as const) {
    test(`publish fault ${boundary.operation} #${boundary.occurrence} ${moment}`, async t => {
        const { adapter, port } = fixture();
        adapter.fault = { ...boundary, moment };
        const succeeds = boundary.expected === 'published' || (boundary.expected === 'rename' && moment === 'after');
        if (succeeds) t.is(await port.publish(target, bytes, () => true), 'published');
        else await t.throwsAsync(port.publish(target, bytes, () => true));
        t.deepEqual(files(adapter), succeeds || boundary.expected === 'uncertain' ? [[target, [1, 2, 255]]] : []);
        // Verify the requested occurrence was reached, so fault cases cannot pass vacuously.
        t.true(adapter.calls.filter(call => call.operation === boundary.operation).length >= boundary.occurrence);
    });
}
const blobBoundaries = [
    ...Array.from({ length: 6 }, (_, i) => ({ operation: 'stat' as const, occurrence: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => ({ operation: 'mkdir' as const, occurrence: i + 1 })),
    { operation: 'writeBinary' as const, occurrence: 1 },
    { operation: 'readBinary' as const, occurrence: 1 },
];
for (const boundary of blobBoundaries) for (const moment of ['before', 'after'] as const) {
    test(`blob fault ${boundary.operation} #${boundary.occurrence} ${moment}`, async t => {
        const { adapter, port } = fixture();
        adapter.fault = { ...boundary, moment };
        await t.throwsAsync(port.writeBlob(blob, bytes));
        t.deepEqual(files(adapter), []);
        adapter.fault = undefined;
        await port.writeBlob(blob, bytes);
        t.deepEqual([...await port.read(blob)], [1, 2, 255]);
    });
}
for (const operation of ['list', 'readBinary', 'remove'] as const) for (const moment of ['before', 'after'] as const) {
    test(`public ${operation} error ${moment} is not swallowed`, async t => {
        const { adapter, port } = fixture();
        await port.writeBlob(blob, bytes);
        adapter.calls.length = 0;
        adapter.fault = { operation, moment };
        await t.throwsAsync(operation === 'list' ? port.list(`${DRAFT_ROOT}/sample/blobs`)
            : operation === 'readBinary' ? port.read(blob) : port.remove(blob));
        t.deepEqual(files(adapter), operation === 'remove' && moment === 'after' ? [] : [[blob, [1, 2, 255]]]);
        adapter.fault = undefined;
        await port.writeBlob(blob, bytes);
        t.deepEqual([...await port.read(blob)], [1, 2, 255]);
    });
}
for (const fullPaths of [true, false]) test(`list returns immediate names with fullPaths=${fullPaths}`, async t => {
    const { adapter, port } = fixture();
    adapter.fullPaths = fullPaths;
    t.deepEqual(await port.list(DRAFT_ROOT), []);
    await port.writeBlob(blob, bytes);
    await port.publish(target, bytes, () => true);
    t.deepEqual(await port.list(DRAFT_ROOT), ['sample']);
    t.deepEqual(await port.list(`${DRAFT_ROOT}/sample`), ['blobs', 'manifests']);
    t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/manifests`), ['000001.json']);
});
for (const size of [0, 1, 2]) for (const kind of ['blob', 'manifest'] as const) {
    test(`${kind} silent truncation to ${size} bytes is rejected and removed`, async t => {
        const { adapter, port } = fixture();
        adapter.truncate = size;
        await t.throwsAsync(kind === 'blob' ? port.writeBlob(blob, bytes) : port.publish(target, bytes, () => true), { code: 'integrity-error' });
        t.deepEqual(files(adapter), []);
        adapter.truncate = undefined;
        await port.writeBlob(blob, bytes);
        t.deepEqual([...await port.read(blob)], [1, 2, 255]);
    });
}
for (const mode of ['noop', 'partial'] as const) test(`rename ${mode} cannot acknowledge publication`, async t => {
    const { adapter, port } = fixture();
    adapter.renameMode = mode;
    await t.throwsAsync(port.publish(target, bytes, () => true), { code: mode === 'noop' ? 'io-error' : 'integrity-error' });
    t.deepEqual(files(adapter), []);
    adapter.renameMode = 'move';
    t.is(await port.publish(target, bytes, () => true), 'published');
    t.deepEqual(files(adapter), [[target, [1, 2, 255]]]);
});
for (const moment of ['before', 'after'] as const) test(`partial rename and failed removal ${moment} exposes mobile limitation`, async t => {
    const { adapter, port } = fixture();
    adapter.renameMode = 'partial';
    adapter.fault = { operation: 'remove', moment };
    await t.throwsAsync(port.publish(target, bytes, () => true), { message: `Injected remove ${moment}` });
    t.deepEqual(files(adapter), moment === 'before' ? [[target, [1]]] : []);
});
for (const moment of ['before', 'after'] as const) test(`cancelled staging cleanup failure ${moment} never exposes a manifest`, async t => {
    const { adapter, port } = fixture();
    adapter.fault = { operation: 'remove', moment };
    t.is(await port.publish(target, bytes, () => false), 'cancelled');
    t.deepEqual([...adapter.files.values()].map(value => [...value]), moment === 'before' ? [[1, 2, 255]] : []);
    t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/manifests`), []);
    adapter.fault = undefined;
    const issues = await new AdapterDraftStorage(adapter).cleanupTemporary();
    t.deepEqual(issues.map(issue => [issue.code, issue.message]), moment === 'before' ? [['io-error', 'Interrupted draft staging found']] : []);
    t.deepEqual(files(adapter), []);
});

test('same-path publications have exactly one winner; distinct paths proceed', async t => {
    const { adapter, port } = fixture();
    const entered = barrier(), release = barrier();
    adapter.before = async operation => { if (operation === 'rename') { entered.resolve(); await release.promise; } };
    const first = port.publish(target, bytes, () => true);
    await entered.promise;
    adapter.before = undefined;
    const second = port.publish(target, new Uint8Array([9]), () => true);
    const refused = t.throwsAsync(second, { code: 'io-error' });
    const other = `${DRAFT_ROOT}/sample/manifests/000002.json`;
    t.is(await port.publish(other, new Uint8Array([8]), () => true), 'published');
    release.resolve();
    t.is(await first, 'published');
    await refused;
    t.deepEqual([...await port.read(target)], [1, 2, 255]);
    t.deepEqual([...await port.read(other)], [8]);
});
test('blob queue keeps first bytes and snapshots input before waiting', async t => {
    const { port } = fixture();
    const input = new Uint8Array([1, 2, 255]);
    const first = port.writeBlob(blob, input);
    input.fill(9);
    const second = t.throwsAsync(port.writeBlob(blob, input), { code: 'integrity-error' });
    await first; await second;
    t.deepEqual([...await port.read(blob)], [1, 2, 255]);
});
test('existing target is refused without staging writes or calling mayPublish', async t => {
    const { adapter, port } = fixture();
    await port.publish(target, bytes, () => true);
    adapter.calls.length = 0;
    await t.throwsAsync(port.publish(target, bytes, () => { throw new Error('Must not be called'); }), { code: 'io-error' });
    t.deepEqual(adapter.calls, [{ operation: 'stat', path: target }]);
    t.deepEqual(files(adapter), [[target, [1, 2, 255]]]);
});
test('matching immutable blob succeeds without any write', async t => {
    const { adapter, port } = fixture();
    await port.writeBlob(blob, bytes);
    adapter.before = async operation => { if (operation === 'writeBinary') throw new Error('Writes forbidden'); };
    await port.writeBlob(blob, bytes);
    t.deepEqual([...await port.read(blob)], [1, 2, 255]);
});
test('Stop before rename cancels, Stop after rename admission cannot revoke completion', async t => {
    const { adapter, port } = fixture();
    let allowed = true;
    adapter.after = async (operation, path) => { if (operation === 'readBinary' && path.startsWith(staging)) allowed = false; };
    t.is(await port.publish(target, bytes, () => allowed), 'cancelled');
    t.deepEqual(files(adapter), []);
    adapter.after = undefined;
    adapter.before = async operation => { if (operation === 'rename') allowed = false; };
    allowed = true;
    t.is(await port.publish(target, bytes, () => allowed), 'published');
    t.is(allowed, false);
    t.deepEqual(files(adapter), [[target, [1, 2, 255]]]);
});
test('callback failure cleans staging and leaves queue usable', async t => {
    const { adapter, port } = fixture();
    await t.throwsAsync(port.publish(target, bytes, () => { throw new Error('Callback failed'); }), { message: 'Callback failed' });
    t.deepEqual(files(adapter), []);
    t.is(await port.publish(target, bytes, () => true), 'published');
    t.deepEqual(files(adapter), [[target, [1, 2, 255]]]);
});

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const hasher = { sha256: async (data: Uint8Array) => createHash('sha256').update(data).digest('hex') };
const draftId = parseDraftId('sample');
const note = parseVaultPath('Notatki/Przyklad.md');
const vault = { stat: async () => ({ kind: 'file' as const, bytes: 4, mtime: 1 }), read: async () => encode('Base') };
function storeOn(adapter: MemoryAdapter) {
    const persistence = new DraftPersistence(new AdapterDraftStorage(adapter), hasher);
    return { persistence, store: new DraftStore(persistence, vault, { now: () => 1 }) };
}
async function initialStore() {
    const adapter = new MemoryAdapter();
    const { store, persistence } = storeOn(adapter);
    await store.create({ draftId, owner: { agentName: 'Tester', sessionPath: 'sessions/sample.md', sessionEpoch: 'a'.repeat(32) }, runId: 'run', threadId: 'thread' });
    await mutate(store, 'Previous');
    return { adapter, store, persistence };
}
function mutate(store: DraftStore, text: string) {
    return store.mutate(draftId, { path: note, source: { tool: 'write', callId: 'call' }, value: { kind: 'text', text } });
}
function diskSnapshot(adapter: MemoryAdapter) {
    const snapshot = new MemoryAdapter();
    for (const [path, data] of adapter.files) snapshot.files.set(path, data.slice());
    for (const path of adapter.folders) snapshot.folders.add(path);
    return snapshot;
}
async function restoredProposal(adapter: MemoryAdapter) {
    const { store, persistence } = storeOn(adapter);
    const restored = await store.restore();
    const value = restored.drafts[0].changes[0].proposed;
    if (value.kind !== 'text') throw new Error('Expected text');
    return { restored, text: decode(await persistence.readBlob(draftId, value.blob, value.hash, value.bytes)) };
}
for (const checkpoint of ['staging', 'truncated-manifest'] as const) test(`process death at ${checkpoint}: fresh store recovers previous complete generation`, async t => {
    const { adapter, store } = await initialStore();
    let disk: MemoryAdapter | undefined;
    adapter.after = async (operation, path) => {
        if (checkpoint === 'staging' && operation === 'writeBinary' && path.startsWith(staging)) disk = diskSnapshot(adapter);
        if (checkpoint === 'truncated-manifest' && operation === 'rename') disk = diskSnapshot(adapter);
    };
    if (checkpoint === 'truncated-manifest') {
        adapter.renameMode = 'partial';
        await t.throwsAsync(mutate(store, 'Next'), { code: 'integrity-error' });
    } else await mutate(store, 'Next');
    if (!disk) throw new Error('Checkpoint not reached');
    const { restored, text } = await restoredProposal(disk);
    t.is(text, 'Previous');
    t.deepEqual(restored.drafts[0].phase, { kind: 'sealed', reason: 'restart' });
    t.deepEqual(restored.issues.map(issue => issue.code), [checkpoint === 'staging' ? 'io-error' : 'invalid-manifest']);
    t.is(decode(await vault.read()), 'Base');
    if (checkpoint === 'staging') {
        t.deepEqual([...disk.files.keys()].filter(path => path.startsWith(staging)), []);
    } else {
        t.deepEqual([...disk.files.get(`${DRAFT_ROOT}/sample/manifests/000002.json`)!], [123]);
        t.is(restored.drafts[0].generation, 3);
    }
});
for (const operation of ['stat', 'list', 'remove'] as const) for (const moment of ['before', 'after'] as const) {
    test(`restart cleanup tolerates ${operation} ${moment} failure and reports it`, async t => {
        const { adapter } = await initialStore();
        const abandoned = `${staging}/abandoned.tmp`;
        adapter.files.set(abandoned, new Uint8Array([7]));
        adapter.calls.length = 0;
        adapter.fault = { operation, moment };
        const { restored, text } = await restoredProposal(adapter);
        t.is(text, 'Previous');
        t.deepEqual(restored.issues.map(issue => [issue.code, issue.message]), [['io-error', operation === 'remove'
            ? 'Interrupted draft staging found' : 'Cannot inspect draft staging']]);
        t.deepEqual([...adapter.files.get(abandoned) ?? []], operation === 'remove' && moment === 'after' ? [] : [7]);
        t.is(decode(await vault.read()), 'Base');
    });
}
test('unacknowledged complete generation is recoverable; vanished generation cannot be detected', async t => {
    const { adapter, store } = await initialStore();
    adapter.before = async (operation, path) => {
        if (operation === 'readBinary' && path.endsWith('/000002.json')) throw new Error('Cannot acknowledge');
    };
    await t.throwsAsync(mutate(store, 'Next'), { code: 'io-error' });
    adapter.before = undefined;
    const completeDisk = diskSnapshot(adapter);
    const complete = await restoredProposal(completeDisk);
    t.is(complete.text, 'Next');
    t.deepEqual(complete.restored.issues, []);
    adapter.files.delete(`${DRAFT_ROOT}/sample/manifests/000002.json`);
    const lost = await restoredProposal(adapter);
    t.is(lost.text, 'Previous');
    t.deepEqual(lost.restored.issues, []);
    t.is(decode(await vault.read()), 'Base');
});
test('staging namespace is inaccessible to callers and malformed listings cannot escape it', async t => {
    const { adapter, port } = fixture();
    for (const path of [staging, `${staging}/file`]) {
        await t.throwsAsync(port.writeBlob(path, bytes), { code: 'invalid-path' });
        await t.throwsAsync(port.publish(path, bytes, () => true), { code: 'invalid-path' });
        await t.throwsAsync(port.read(path), { code: 'invalid-path' });
        await t.throwsAsync(port.remove(path), { code: 'invalid-path' });
        await t.throwsAsync(port.list(path), { code: 'invalid-path' });
    }
    await port.writeBlob(blob, bytes);
    adapter.list = async () => ({ files: ['../../elsewhere'], folders: [] });
    await t.throwsAsync(port.list(DRAFT_ROOT), { code: 'invalid-path' });
    t.deepEqual(files(adapter), [[blob, [1, 2, 255]]]);
});

test('rename throwing after a partial move removes the wrong target and rejects', async t => {
    const { adapter, port } = fixture();
    adapter.renameMode = 'partial';
    adapter.fault = { operation: 'rename', moment: 'after' };
    await t.throwsAsync(port.publish(target, bytes, () => true), { code: 'integrity-error' });
    t.deepEqual(files(adapter), []);
    adapter.renameMode = 'move';
    t.is(await port.publish(target, bytes, () => true), 'published');
    t.deepEqual(files(adapter), [[target, [1, 2, 255]]]);
});
test('in-memory publication registry refuses reuse even when the adapter loses the target', async t => {
    const { adapter, port } = fixture();
    t.is(await port.publish(target, bytes, () => true), 'published');
    adapter.files.delete(target);
    await t.throwsAsync(port.publish(target, new Uint8Array([9]), () => true), { code: 'io-error' });
    t.deepEqual(files(adapter), []);
    const other = `${DRAFT_ROOT}/sample/manifests/000002.json`;
    t.is(await port.publish(other, bytes, () => true), 'published');
    t.deepEqual(files(adapter), [[other, [1, 2, 255]]]);
});
for (const moment of ['before', 'after'] as const) test(`truncated blob with failed cleanup ${moment} is never accepted as immutable data`, async t => {
    const { adapter, port } = fixture();
    adapter.truncate = 1;
    adapter.fault = { operation: 'remove', moment };
    await t.throwsAsync(port.writeBlob(blob, bytes), { code: 'integrity-error' });
    t.deepEqual(files(adapter), moment === 'before' ? [[blob, [1]]] : []);
    adapter.truncate = undefined;
    adapter.fault = undefined;
    if (moment === 'before') await t.throwsAsync(port.writeBlob(blob, bytes), { code: 'integrity-error' });
    await port.remove(blob);
    await port.writeBlob(blob, bytes);
    t.deepEqual([...await port.read(blob)], [1, 2, 255]);
});
