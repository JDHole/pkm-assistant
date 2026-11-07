import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DesktopDraftStorage, parseVaultPath } from '../../vault-drafts/index.js';
import type { DraftReviewContext, DraftReviewIO, DraftViewIO } from '../../vault-drafts/index.js';
import { SubTaskRegistry } from '../../sub-agents/index.js';
import type { SubTaskHistoryRecord } from '../../sub-agents/index.js';
import { initializeVaultDrafts } from '../vaultDraftRuntime.js';
export const owner = { agentName: 'Mira', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) };
export const encoder = new TextEncoder();
export async function draftFixture(t: { teardown(callback: () => void | Promise<void>): void }, maxDone = 20) {
    const root = fs.mkdtempSync(`${process.cwd()}/.p5-fixture-`);
    const files = new Map([['x.md', 'Baza-X'], ['y.md', 'Baza-Y']]);
    const records: SubTaskHistoryRecord[] = [];
    const registry = new SubTaskRegistry({ maxDone, appendHistory: async record => { records.push(record); } });
    const storage = new DesktopDraftStorage(fs, root);
    const vault: DraftViewIO & DraftReviewIO = {
        stat: async path => files.has(path) ? { kind: 'file', bytes: encoder.encode(files.get(path)).length, mtime: 1 } : { kind: 'missing' },
        read: async path => { const text = files.get(path); if (text === undefined) throw new Error('ENOENT'); return encoder.encode(text); },
        list: async () => ({ files: [...files.keys()], folders: [] }),
        processText: async (path, transform) => { files.set(path, transform(files.get(path)!, 1)); },
        createText: async (path, text) => { if (files.has(path)) throw new Error('EEXIST'); files.set(path, text); },
        createBinary: async () => { throw new Error('unused'); }, modifyBinary: async () => { throw new Error('unused'); },
        createFolder: async () => {}, deleteFile: async path => { files.delete(path); },
    };
    const ports = { storage, vault, hasher: { sha256: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex') } };
    const runtime = await initializeVaultDrafts({ ...ports, registry });
    const context: DraftReviewContext = { kind: 'main', owner, authorize: () => true, approve: async () => true };
    const run = async (id: string, who = owner, threadId = id, continuation = false) => {
        const task = registry.create({ id, name: 'Piszący', agentName: who.agentName, origin: who, background: true, threadId: threadId === id ? undefined : threadId });
        const draft = await runtime.drafts.open({ runId: id, threadId, writable: true, origin: who, continuation });
        if (!draft) throw new Error('Expected writer draft');
        return { task, draft };
    };
    const write = (draft: NonNullable<Awaited<ReturnType<typeof runtime.drafts.open>>>, path: string, text: string) =>
        draft.view.mutate(path, { tool: 'write', callId: 'call' }, { kind: 'text', text }, 'any');
    const result = { text: 'Gotowe', toolsUsed: ['write'], durationMs: 4, usage: null };
    t.teardown(async () => { runtime.dispose(); registry.dispose(); await runtime.flush(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, files, records, registry, storage, ports, runtime, context, run, write, result, read: (path: string) => vault.read(parseVaultPath(path)) };
}
