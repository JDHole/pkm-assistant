import test, { type ExecutionContext } from 'ava';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AdapterDraftStorage, DesktopDraftStorage, DRAFT_ROOT, DraftPersistence, DraftStore, DraftReview, parseDraftId, parseVaultPath } from './index.js';
import type { DraftManifest, DraftStorageIO, DraftReviewIO, DraftReviewContext } from './index.js';
import { MemoryAdapter } from './test-support/MemoryAdapter.js';

const DAY = 86400000;
const owner = { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) };
const context: DraftReviewContext = { kind: 'main', owner, authorize: () => true, approve: async () => true };
const encode = (text: string) => new TextEncoder().encode(text);
const hasher = { sha256: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex') };
const barrier = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};

function fixture(t: ExecutionContext, mobile: boolean) {
    const root = fs.mkdtempSync(`${process.cwd()}/.mobile-test-f2k-gc-`);
    t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
    const adapter = new MemoryAdapter();
    const files = new Map<string, Uint8Array>();
    let now = 100 * DAY;
    const vault: DraftReviewIO = {
        stat: async path => files.has(path) ? { kind: 'file', bytes: files.get(path)!.length, mtime: 1 } : { kind: 'missing' },
        read: async path => { const bytes = files.get(path); if (!bytes) throw new Error('Missing'); return bytes.slice(); },
        processText: async (path, transform) => { files.set(path, encode(transform(new TextDecoder().decode(files.get(path)), 1))); },
        createText: async (path, text) => { files.set(path, encode(text)); },
        createBinary: async (path, bytes) => { files.set(path, bytes.slice()); },
        createFolder: async () => {},
        modifyBinary: async (path, bytes, checkpoint) => { (await checkpoint(files.get(path)!, 1))(); files.set(path, bytes.slice()); },
        deleteFile: async (path, _disposition, checkpoint) => { (await checkpoint(files.get(path)!, 1))(); files.delete(path); },
    };
    const port = () => mobile ? new AdapterDraftStorage(adapter) : new DesktopDraftStorage(fs, root);
    const make = (storage: DraftStorageIO = port(), protectedDraft: (m: DraftManifest) => boolean = () => false) => {
        const persistence = new DraftPersistence(storage, hasher);
        const store = new DraftStore(persistence, vault, { now: () => now }, protectedDraft);
        return { store, persistence, review: new DraftReview(store, persistence, vault), storage };
    };
    const current = make();
    const seed = async (id: string, age: number, kind: 'pending' | 'accepted' | 'rejected' | 'destructive' | 'applying' | 'recovery-required' = 'rejected', collect = true) => {
        now = (100 - age) * DAY;
        const path = parseVaultPath(`${id}.md`);
        if (kind === 'destructive') files.set(path, encode('Original'));
        const draft = await current.store.create({ draftId: id, runId: id, threadId: id, owner });
        const changed = await current.store.mutate(draft.draftId, { path, source: { tool: 'write', callId: 'call' },
            value: kind === 'destructive' ? { kind: 'deleted', disposition: 'trash' } : { kind: 'text', text: 'Proposal' } });
        await current.store.seal(draft.draftId, 'finished');
        const change = changed.changes[0];
        if (kind === 'applying' || kind === 'recovery-required') {
            await current.store.setReview(draft.draftId, change.id, change.revision, { kind: 'applying', attemptId: 'attempt', approvedRevision: change.revision });
            if (kind === 'recovery-required') await current.store.setReview(draft.draftId, change.id, change.revision, { kind: 'recovery-required', attemptId: 'attempt' });
        } else if (kind !== 'pending') {
            const result = await current.review.decide(context, { action: kind === 'rejected' ? 'reject' : 'accept', draftId: draft.draftId, changeId: change.id, revision: change.revision });
            t.is(result.kind, kind === 'rejected' ? 'rejected' : 'accepted');
        }
        if (collect) await current.store.collectResolved();
        now = 100 * DAY;
        return current.store.snapshot(draft.draftId);
    };
    const paths = () => mobile ? [...adapter.files.keys()].filter(p => p.startsWith(`${DRAFT_ROOT}/`)).map(p => p.slice(DRAFT_ROOT.length + 1)).sort()
        : fs.existsSync(`${root}/${DRAFT_ROOT}`) ? fs.readdirSync(`${root}/${DRAFT_ROOT}`, { recursive: true, withFileTypes: true })
            .filter(e => e.isFile()).map(e => `${e.parentPath}/${e.name}`.slice(`${root}/${DRAFT_ROOT}/`.length)).sort() : [];
    return { ...current, port, make, seed, paths, adapter, files, root, setNow: (value: number) => { now = value; } };
}

for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    test(`F2k ${label}: 29/30 days stay, 31 days expires only at startup`, async t => {
        const f = fixture(t, mobile);
        await f.seed('young', 29); await f.seed('boundary', 30); await f.seed('old', 31);
        t.deepEqual(f.paths(), ['boundary/manifests/000004.json', 'old/manifests/000004.json', 'young/manifests/000004.json']);
        await f.store.collectResolved();
        t.deepEqual(f.paths(), ['boundary/manifests/000004.json', 'old/manifests/000004.json', 'young/manifests/000004.json']);
        const fresh = f.make();
        t.deepEqual((await fresh.store.restore()).issues, []);
        await fresh.store.collectResolved();
        t.deepEqual(f.paths(), ['boundary/manifests/000004.json', 'young/manifests/000004.json']);
        t.deepEqual([...await fresh.storage.list(DRAFT_ROOT)].sort(), ['boundary', 'young']);
        t.deepEqual(await fresh.review.decide(context, { action: 'accept', draftId: parseDraftId('old'), changeId: f.store.snapshot(parseDraftId('old')).changes[0].id, revision: f.store.snapshot(parseDraftId('old')).changes[0].revision }), { kind: 'denied' });
        const listed = await fresh.review.list(context, {});
        t.deepEqual(listed.kind === 'listed' ? listed.changes.map(c => [c.draft_id, c.status]) : listed, [['boundary', 'rejected'], ['young', 'rejected']]);
    });

    test(`F2k ${label}: unresolved, live reference, recovery bytes and clock reversal stay`, async t => {
        const f = fixture(t, mobile);
        await f.seed('pending', 100, 'pending');
        await f.seed('applying', 100, 'applying');
        await f.seed('recovery', 100, 'recovery-required');
        await f.seed('protected', 31);
        const destructive = await f.seed('destructive', 31, 'destructive');
        const before = f.paths();
        const fresh = f.make(undefined, m => m.draftId === 'protected');
        await fresh.store.restore(); await fresh.store.collectResolved();
        // Applying gains a recovery-required generation; all original files survive.
        t.deepEqual(f.paths(), [...before, 'applying/manifests/000004.json'].sort());
        t.deepEqual(fresh.store.list().map(m => [m.draftId, m.changes[0].review.kind]).sort(), [
            ['applying', 'recovery-required'], ['destructive', 'accepted'], ['pending', 'pending'], ['protected', 'rejected'], ['recovery', 'recovery-required'],
        ]);
        const review = destructive.changes[0].review;
        if (!('recoveryBlob' in review) || !review.recoveryBlob) return t.fail('Missing recovery bytes');
        t.is(new TextDecoder().decode(await fresh.persistence.readBlob(destructive.draftId, review.recoveryBlob.blob, review.recoveryBlob.hash, review.recoveryBlob.bytes)), 'Original');
        const future = fixture(t, mobile);
        await future.seed('future', -1);
        future.setNow(50 * DAY);
        const reversed = future.make(); await reversed.store.restore(); await reversed.store.collectResolved();
        t.deepEqual(future.paths(), ['future/manifests/000004.json']);
    });

    for (const problem of ['manifest', 'layout', 'orphan']) test(`F2k ${label}: ${problem} blocks unsafe deletion`, async t => {
        const f = fixture(t, mobile);
        await f.seed('old', 31);
        const bad = problem === 'manifest' ? `${DRAFT_ROOT}/broken/manifests/000001.json`
            : problem === 'layout' ? `${DRAFT_ROOT}/old/unknown/file` : `${DRAFT_ROOT}/orphan/blobs/${'a'.repeat(64)}`;
        await f.storage.publish(bad, encode('Unrecognized'), () => true);
        const before = f.paths(), fresh = f.make();
        const recovered = await fresh.store.restore();
        await fresh.store.collectResolved();
        t.deepEqual(f.paths(), before);
        t.is(recovered.issues.length, problem === 'layout' ? 0 : 1);
        t.deepEqual(fresh.store.snapshot(parseDraftId('old')).changes.map(c => c.review.kind), ['rejected']);
    });

    test(`F2k ${label}: payload waits for release and leaves the legacy receipt`, async t => {
        const f = fixture(t, mobile);
        const manifest = await f.seed('sample', 0, 'accepted', false);
        const release = f.store.retain([manifest.draftId]);
        await f.store.collectResolved();
        t.deepEqual(f.paths(), [
            'sample/blobs/5d42766c7ecac46c344f7ed2f8940a0054b00641cb56876ceb30c9eab50159b0',
            'sample/decisions/change-1-3.json', 'sample/manifests/000001.json', 'sample/manifests/000002.json',
            'sample/manifests/000003.json', 'sample/manifests/000004.json',
        ]);
        release(); await f.store.collectResolved();
        // Replayed against 39e588b with the same seed/accept/release sequence.
        t.deepEqual(f.paths(), ['sample/manifests/000005.json']);
        t.is(new TextDecoder().decode(f.files.get('sample.md')), 'Proposal');
        t.deepEqual(f.store.snapshot(manifest.draftId).changes[0].review, {
            kind: 'accepted', attemptId: 'change-1-3', applied: { kind: 'file', mtime: 1, bytes: 8,
                hash: '5d42766c7ecac46c344f7ed2f8940a0054b00641cb56876ceb30c9eab50159b0' },
        });
    });

    for (const boundary of ['file', 'directory']) for (let cut = 1; cut <= (boundary === 'file' ? 7 : 4); cut++) test(`F2k ${label}: expiry interruption after ${boundary} ${cut} survives restart`, async t => {
        const f = fixture(t, mobile);
        const old = await f.seed('old', 31, 'accepted', false);
        // A durable receipt with all its old payload, as after a failed first GC remove.
        await f.persistence.save({ ...old, payloadCollected: true }, () => true);
        await f.seed('other', 0, 'pending', false);
        const other = f.paths().filter(path => path.startsWith('other/'));
        let removed = 0;
        const port = f.port();
        const interrupted = f.make({
            list: p => port.list(p), read: p => port.read(p), writeBlob: (p, b) => port.writeBlob(p, b), publish: (p, b, gate) => port.publish(p, b, gate),
            ...(port instanceof AdapterDraftStorage ? { cleanupTemporary: () => port.cleanupTemporary() } : {}),
            remove: async path => {
                await port.remove!(path);
                const file = /\/(blobs|manifests|decisions)\/[^/]+$/.test(path);
                if (file === (boundary === 'file') && ++removed === cut) throw new Error('Power lost');
            },
        });
        await interrupted.store.restore();
        await t.throwsAsync(interrupted.store.collectResolved(), { message: 'Power lost' });
        t.is(removed, cut);
        const fresh = f.make();
        t.deepEqual((await fresh.store.restore()).issues, []);
        await fresh.store.collectResolved();
        t.deepEqual(f.paths(), other);
        t.deepEqual(await fresh.storage.list(DRAFT_ROOT), ['other']);
        t.deepEqual(fresh.store.list().map(m => [m.draftId, m.changes[0].review.kind]), [['other', 'pending']]);
        const proposed = fresh.store.list()[0].changes[0].proposed;
        if (proposed.kind !== 'text') return t.fail('Expected text');
        t.is(new TextDecoder().decode(await fresh.persistence.readBlob(parseDraftId('other'), proposed.blob, proposed.hash, proposed.bytes)), 'Proposal');
    });

    test(`F2k ${label}: a write after restore invalidates its cached scan`, async t => {
        const f = fixture(t, mobile);
        await f.persistence.putBlob(parseDraftId('before'), encode('Before'));
        const port = f.port();
        let scans = 0;
        const fresh = f.make({ list: path => { if (path === DRAFT_ROOT) scans++; return port.list(path); },
            read: p => port.read(p), writeBlob: (p, b) => port.writeBlob(p, b), publish: (p, b, gate) => port.publish(p, b, gate), remove: p => port.remove!(p) });
        await fresh.store.restore();
        await fresh.persistence.putBlob(parseDraftId('after'), encode('After'));
        await fresh.store.collectResolved();
        t.is(scans, 2);
        t.deepEqual(await port.list(DRAFT_ROOT), []);
        const next = await fresh.store.create({ draftId: 'next', runId: 'next', threadId: 'next', owner });
        const saved = await fresh.store.mutate(next.draftId, { path: parseVaultPath('next.md'), source: { tool: 'write', callId: 'call' }, value: { kind: 'folder' } });
        t.deepEqual(saved.changes.map(c => [c.path, c.proposed.kind]), [['next.md', 'folder']]);
    });

    test(`F2k ${label}: a reference acquired during the scan blocks payload GC`, async t => {
        const f = fixture(t, mobile);
        const pending = await f.seed('sample', 0, 'rejected', false);
        const entered = barrier(), resume = barrier(), port = f.port();
        let armed = false;
        const fresh = f.make({ list: async p => {
            const names = await port.list(p);
            if (armed && p === DRAFT_ROOT) { armed = false; entered.resolve(); await resume.promise; }
            return names;
        }, read: p => port.read(p), writeBlob: (p, b) => port.writeBlob(p, b), publish: (p, b, gate) => port.publish(p, b, gate), remove: p => port.remove!(p) });
        await fresh.store.restore();
        // Invalidate the cached scan with an unrelated, valid orphan write.
        await fresh.persistence.putBlob(parseDraftId('orphan'), encode('Orphan'));
        armed = true;
        const collecting = fresh.store.collectResolved();
        await entered.promise;
        const release = fresh.store.retain([pending.draftId]);
        resume.resolve(); await collecting;
        t.deepEqual(await port.list(`${DRAFT_ROOT}/sample/manifests`), ['000001.json', '000002.json', '000003.json']);
        const proposed = pending.changes[0].proposed;
        if (proposed.kind !== 'text') return t.fail('Expected text');
        t.is(new TextDecoder().decode(await fresh.persistence.readBlob(pending.draftId, proposed.blob, proposed.hash, proposed.bytes)), 'Proposal');
        release(); await fresh.store.collectResolved();
        t.deepEqual(f.paths(), ['sample/manifests/000004.json']);
    });

    test(`F2k ${label}: new live ID during orphan scan protects its bytes`, async t => {
        const f = fixture(t, mobile);
        const entered = barrier(), resume = barrier();
        const port = f.port();
        let armed = false;
        const fresh = f.make({ list: async path => {
            const names = await port.list(path);
            if (armed && path === `${DRAFT_ROOT}/live/manifests`) { armed = false; entered.resolve(); await resume.promise; }
            return names;
        }, read: p => port.read(p), writeBlob: (p, b) => port.writeBlob(p, b), publish: (p, b, gate) => port.publish(p, b, gate), remove: p => port.remove!(p) });
        await fresh.store.restore(); await fresh.store.collectResolved();
        await fresh.persistence.putBlob(parseDraftId('orphan'), encode('Orphan'));
        armed = true;
        const live = await fresh.store.create({ draftId: 'live', runId: 'live', threadId: 'live', owner });
        const writing = fresh.store.mutate(live.draftId, { path: parseVaultPath('live.md'), source: { tool: 'write', callId: 'call' }, value: { kind: 'text', text: 'Live' } });
        await entered.promise;
        await fresh.store.collectResolved();
        resume.resolve();
        const saved = await writing;
        const proposed = saved.changes[0].proposed;
        if (proposed.kind !== 'text') return t.fail('Expected text');
        t.is(new TextDecoder().decode(await fresh.persistence.readBlob(live.draftId, proposed.blob, proposed.hash, proposed.bytes)), 'Live');
        t.deepEqual(await port.list(DRAFT_ROOT), ['live']);
    });
}
