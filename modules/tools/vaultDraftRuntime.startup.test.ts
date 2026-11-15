import test from 'ava';
import { SubTaskRegistry } from '../sub-agents/index.js';
import { AdapterDraftStorage, DraftPersistence, DraftStore, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftStorageIO } from '../vault-drafts/index.js';
import { MemoryAdapter } from '../vault-drafts/test-support/MemoryAdapter.js';
import { initializeVaultDrafts } from './index.js';
import { draftFixture } from './test-support/vaultDraftFixture.js';

for (const mobile of [false, true]) for (const pending of [false, true]) {
    test(`F2e startup I/O ${mobile ? 'mobile' : 'desktop'}, pending=${pending}`, async t => {
        const f = await draftFixture(t);
        const adapter = new MemoryAdapter();
        const storage = mobile ? new AdapterDraftStorage(adapter) : f.storage;
        if (pending) {
            const store = new DraftStore(new DraftPersistence(storage, f.ports.hasher), f.ports.vault, { now: () => 1 });
            const draft = await store.create({ draftId: 'sample', runId: 'sample', threadId: 'sample',
                owner: { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) } });
            await store.mutate(draft.draftId, { path: parseVaultPath('new.md'), source: { tool: 'write', callId: 'call' }, value: { kind: 'text', text: 'Proposal' } });
            await store.seal(draft.draftId, 'finished');
        }
        const trace: string[] = [];
        const traced: DraftStorageIO = {
            list: async path => { trace.push(`list ${path}`); return storage.list(path); },
            read: async path => { trace.push(`read ${path.replace(/[a-f0-9]{64}/g, 'BLOB')}`); return storage.read(path); },
            writeBlob: async (path, bytes) => { trace.push(`writeBlob ${path}`); return storage.writeBlob(path, bytes); },
            publish: async (path, bytes, gate) => { trace.push(`publish ${path}`); return storage.publish(path, bytes, gate); },
            remove: async path => { trace.push(`remove ${path}`); return storage.remove(path); },
            ...(storage instanceof AdapterDraftStorage ? { cleanupTemporary: async () => { trace.push('cleanupTemporary'); return storage.cleanupTemporary(); } } : {}),
        };
        adapter.calls.length = 0;
        const registry = new SubTaskRegistry();
        const boot = await initializeVaultDrafts({ ...f.ports, storage: traced, registry,
            ...(mobile ? { storagePresent: async () => (await adapter.stat('.pkm-assistant/subagent-drafts/v1')) !== null } : {}),
        });
        t.teardown(() => { boot.dispose(); registry.dispose(); });
        t.deepEqual(boot.store.list().map(draft => [draft.draftId, draft.phase, draft.changes.map(change => [change.path, change.review.kind])]),
            pending ? [['sample', { kind: 'sealed', reason: 'finished' }, [['new.md', 'pending']]]] : []);
        // Literal baseline from 6fff56f; blob IDs alone are normalized.
        const storageTrace = pending ? [
            'list .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'read .pkm-assistant/subagent-drafts/v1/sample/manifests/000002.json',
            'read .pkm-assistant/subagent-drafts/v1/sample/blobs/BLOB',
            'list .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'read .pkm-assistant/subagent-drafts/v1/sample/manifests/000002.json',
            'read .pkm-assistant/subagent-drafts/v1/sample/blobs/BLOB',
            'list .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'read .pkm-assistant/subagent-drafts/v1/sample/manifests/000002.json',
            'read .pkm-assistant/subagent-drafts/v1/sample/blobs/BLOB',
            'list .pkm-assistant/subagent-drafts/v1',
        ] : [
            'list .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1',
        ];
        t.deepEqual(trace, mobile ? pending ? ['cleanupTemporary', ...storageTrace] : [] : storageTrace);
        t.deepEqual(adapter.calls.map(call => `${call.operation} ${call.path.replace(/[a-f0-9]{64}/g, 'BLOB')}`),
            mobile ? pending ? [
            'stat .pkm-assistant/subagent-drafts/v1',
            'stat .pkm-assistant/subagent-drafts/v1/.staging',
            'list .pkm-assistant/subagent-drafts/v1/.staging',
            'stat .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1',
            'stat .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'list .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'readBinary .pkm-assistant/subagent-drafts/v1/sample/manifests/000002.json',
            'readBinary .pkm-assistant/subagent-drafts/v1/sample/blobs/BLOB',
            'stat .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1',
            'stat .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'list .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'readBinary .pkm-assistant/subagent-drafts/v1/sample/manifests/000002.json',
            'readBinary .pkm-assistant/subagent-drafts/v1/sample/blobs/BLOB',
            'stat .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1',
            'stat .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'list .pkm-assistant/subagent-drafts/v1/sample/manifests',
            'readBinary .pkm-assistant/subagent-drafts/v1/sample/manifests/000002.json',
            'readBinary .pkm-assistant/subagent-drafts/v1/sample/blobs/BLOB',
            'stat .pkm-assistant/subagent-drafts/v1',
            'list .pkm-assistant/subagent-drafts/v1',
        ] : ['stat .pkm-assistant/subagent-drafts/v1'] : []);
    });
}
