import { DraftPersistence, DraftStore, parseVaultPath } from '../../vault-drafts/index.js';
import type { DraftStorageIO, DraftHasher, DraftVaultIO } from '../../vault-drafts/index.js';

export function traceStorage(storage: DraftStorageIO, calls: string[]): DraftStorageIO {
    return {
        list: path => { calls.push(`list ${path}`); return storage.list(path); },
        read: path => { calls.push(`read ${path}`); return storage.read(path); },
        writeBlob: (path, bytes) => { calls.push(`write ${path}`); return storage.writeBlob(path, bytes); },
        publish: (path, bytes, gate) => { calls.push(`publish ${path}`); return storage.publish(path, bytes, gate); },
        remove: path => { calls.push(`remove ${path}`); return storage.remove!(path); },
        ...(storage.cleanupTemporary ? { cleanupTemporary: () => storage.cleanupTemporary!() } : {}),
    };
}

export async function seedReceipts(ports: { storage: DraftStorageIO; vault: DraftVaultIO; hasher: DraftHasher }, count: number, now = Date.now()) {
    const persistence = new DraftPersistence(ports.storage, ports.hasher);
    const store = new DraftStore(persistence, ports.vault, { now: () => now });
    for (let i = 0; i < count; i++) {
        const draft = await store.create({ draftId: `receipt-${i}`, runId: `receipt-${i}`, threadId: `receipt-${i}`,
            owner: { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) } });
        const changed = await store.mutate(draft.draftId, { path: parseVaultPath('new.md'), source: { tool: 'write', callId: 'call' }, value: { kind: 'text', text: 'Proposal' } });
        await store.seal(draft.draftId, 'finished');
        await store.setReview(draft.draftId, changed.changes[0].id, changed.changes[0].revision, { kind: 'rejected' });
    }
    await store.collectResolved();
    return store;
}
