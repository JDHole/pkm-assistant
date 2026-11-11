import type { App, TFile } from 'obsidian';
import { DraftError } from '../vault-drafts/index.js';
import type { DraftReviewIO, VaultPath } from '../vault-drafts/index.js';

/** Narrow, explicit host for review only. P5 supplies this port during runtime assembly. */
export function createDraftReviewHost(app: App): DraftReviewIO {
    const { vault } = app;
    const file = (path: VaultPath): TFile => {
        const entry = vault.getFileByPath(path);
        if (!entry) throw new DraftError('file-missing', 'Indexed file missing');
        return entry;
    };
    const stat: DraftReviewIO['stat'] = async path => {
        const value = await vault.adapter.stat(path);
        return !value ? { kind: 'missing' } : value.type === 'folder' ? { kind: 'folder' }
            : { kind: 'file', bytes: value.size, mtime: value.mtime };
    };
    // Hidden creation/overwrites cannot silently fall back to unchecked adapter.write.
    const indexed = (path: VaultPath) => !!vault.getFileByPath(path);
    /** Checkpoint is durable before entering a destructive host operation. These
     * reads and event observations detect races, but are not compare-and-swap. */
    const destructive = async (path: VaultPath, checkpoint: Parameters<DraftReviewIO['modifyBinary']>[2],
        operation: () => Promise<void>, deleting = false) => {
        let modifications = 0, removals = 0;
        const events = typeof vault.on === 'function' ? [
            vault.on('modify', entry => { if (entry.path === path) modifications++; }),
            vault.on('delete', entry => { if (entry.path === path) removals++; }),
        ] : [];
        try {
            const before = await stat(path);
            if (before.kind !== 'file') throw new Error('Destructive target disappeared');
            const bytes = new Uint8Array(await vault.adapter.readBinary(path));
            const authorize = await checkpoint(bytes, before.mtime);
            const latest = new Uint8Array(await vault.adapter.readBinary(path));
            const after = await stat(path);
            if (after.kind !== 'file' || after.mtime !== before.mtime || after.bytes !== bytes.length
                || latest.length !== bytes.length || latest.some((byte, i) => byte !== bytes[i])) {
                if (after.kind === 'file') await checkpoint(latest, after.mtime);
                throw new Error('Destructive target changed while saving recovery bytes');
            }
            if (modifications || removals) throw new Error('Concurrent vault event before operation');
            authorize();
            await operation();
            if (modifications + removals > 1 || deleting && modifications > 0 || !deleting && removals > 0)
                throw new Error('Concurrent vault event during operation');
        } finally { for (const event of events) vault.offref(event); }
    };
    return {
        stat, read: async path => new Uint8Array(await vault.adapter.readBinary(path)),
        async processText(path, transform) {
            if (indexed(path)) {
                const entry = file(path);
                await vault.process(entry, current => transform(current, entry.stat.mtime));
            } else {
                const before = await stat(path);
                if (before.kind !== 'file') throw new DraftError('file-missing', 'Text file missing');
                // Adapter.process is the host's atomic text operation for hidden files.
                await vault.adapter.process(path, current => transform(current, before.mtime));
            }
        },
        async createText(path, text) { await vault.create(path, text); },
        async createBinary(path, bytes) { await vault.createBinary(path, bytes.slice().buffer); },
        async modifyBinary(path, bytes, checkpoint) {
            await destructive(path, checkpoint, async () => {
                if (indexed(path)) await vault.modifyBinary(file(path), bytes.slice().buffer);
                else await vault.adapter.writeBinary(path, bytes.slice().buffer);
            });
        },
        async createFolder(path) { await vault.createFolder(path); },
        async deleteFile(path, _disposition, checkpoint) {
            await destructive(path, checkpoint, async () => {
                if (indexed(path)) await app.fileManager.trashFile(file(path));
                else if (!await vault.adapter.trashSystem(path)) await vault.adapter.trashLocal(path);
            }, true);
        },
    };
}
