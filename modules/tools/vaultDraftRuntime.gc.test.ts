import test from 'ava';
import { SubTaskRegistry } from '../sub-agents/index.js';
import { AdapterDraftStorage, DRAFT_ROOT, parseDraftId } from '../vault-drafts/index.js';
import { getLocale, setLocale } from '../../core/i18n/index.js';
import { MemoryAdapter } from '../vault-drafts/test-support/MemoryAdapter.js';
import { initializeVaultDrafts } from './index.js';
import { draftFixture } from './test-support/vaultDraftFixture.js';
import { seedReceipts, traceStorage } from './test-support/draftGCFixture.js';

for (const mobile of [false, true]) for (const count of [1, 20]) {
    test(`F2k receipt startup ${mobile ? 'mobile' : 'desktop'} ${count}`, async t => {
        const f = await draftFixture(t);
        const adapter = new MemoryAdapter();
        const storage = mobile ? new AdapterDraftStorage(adapter) : f.storage;
        await seedReceipts({ ...f.ports, storage }, count, 100);
        const calls: string[] = [];
        adapter.calls.length = 0;
        const registry = new SubTaskRegistry();
        const boot = await initializeVaultDrafts({ ...f.ports, storage: traceStorage(storage, calls), registry, clock: { now: () => 200 },
            ...(mobile ? { storagePresent: async () => (await adapter.stat(DRAFT_ROOT)) !== null } : {}),
        });
        t.teardown(() => { boot.dispose(); registry.dispose(); });
        t.is(calls.length, count === 1 ? 5 : 81);
        t.is(adapter.calls.length, mobile ? count === 1 ? 12 : 145 : 0);
        t.is(boot.store.list().length, count);
        t.deepEqual(await storage.list(`${DRAFT_ROOT}/receipt-0/manifests`), ['000004.json']);
    });
}

test('F2k event burst coalesces into one active cleanup and one pending; flush waits', async t => {
    const f = await draftFixture(t);
    const { draft, task } = await f.run('sample');
    await f.write(draft, 'new.md', 'Proposal'); await draft.close('finished');
    f.registry.finish(task, f.result); await f.runtime.flush();
    const manifest = f.runtime.store.list()[0];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const list = f.storage.list.bind(f.storage);
    let scans = 0, active = 0, maximum = 0, collections = 0;
    f.storage.list = async path => {
        if (path === DRAFT_ROOT) { scans++; entered(); await gate; }
        return list(path);
    };
    const collect = f.runtime.store.collectResolved.bind(f.runtime.store);
    f.runtime.store.collectResolved = async () => {
        collections++; active++; maximum = Math.max(maximum, active);
        try { await collect(); } finally { active--; }
    };
    await f.runtime.review.decide(f.context, { action: 'reject', draftId: manifest.draftId,
        changeId: manifest.changes[0].id, revision: manifest.changes[0].revision });
    await reached;
    for (let i = 0; i < 10; i++) f.registry.events.emit('draft:changed');
    let flushed = false;
    const flushing = f.runtime.flush().then(() => { flushed = true; });
    await Promise.resolve();
    t.false(flushed);
    release(); await flushing;
    t.deepEqual({ scans, maximum, collections, flushed }, { scans: 1, maximum: 1, collections: 2, flushed: true });
    t.deepEqual(await f.storage.list(`${DRAFT_ROOT}/${manifest.draftId}/manifests`), ['000004.json']);
    t.deepEqual(await f.storage.list(`${DRAFT_ROOT}/${manifest.draftId}/blobs`), []);
    t.deepEqual(f.runtime.store.snapshot(manifest.draftId).changes.map(c => c.review.kind), ['rejected']);
});

for (const live of ['thread', 'run', 'none'] as const) test.serial(`F2k startup receipt expiry respects live ${live} and tool unknown response`, async t => {
    const f = await draftFixture(t);
    await seedReceipts(f.ports, 1, 0);
    const registry = new SubTaskRegistry();
    const owner = { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) };
    if (live === 'thread') registry.createThread({ threadId: 'receipt-0', name: 'Tester', owner, origin: owner, config: {} });
    if (live === 'run') registry.create({ id: 'receipt-0', name: 'Tester', agentName: 'Tester', origin: owner, background: true });
    const boot = await initializeVaultDrafts({ ...f.ports, registry, clock: { now: () => 31 * 86400000 } });
    t.teardown(() => { boot.dispose(); registry.dispose(); });
    const locale = getLocale(); setLocale('en'); t.teardown(() => setLocale(locale));
    const context = { draftReview: { ...f.context, owner }, shouldAbort: () => false };
    const call = (action: string) => boot.tool.execute!({ action, draft_id: 'receipt-0', change_id: 'change-1', revision: 1 }, undefined, undefined, context as never);
    if (live !== 'none') {
        t.deepEqual(await call('accept'), { kind: 'rejected' });
        t.deepEqual(await f.storage.list(`${DRAFT_ROOT}/receipt-0/manifests`), ['000004.json']);
        t.is(boot.store.snapshot(parseDraftId('receipt-0')).payloadCollected, true);
    } else {
        for (const action of ['accept', 'reject']) t.deepEqual(await call(action), {
            kind: 'denied', isError: true, message: 'Permission or approval to review this change was denied.',
        });
        t.deepEqual(await boot.tool.execute!({ action: 'list' }, undefined, undefined, context as never), { kind: 'listed', changes: [], next_cursor: null });
        t.deepEqual(await f.storage.list(DRAFT_ROOT), []);
    }
});
