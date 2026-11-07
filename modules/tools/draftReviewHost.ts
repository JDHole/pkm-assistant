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
        async modifyBinary(path, bytes) {
            if (indexed(path)) await vault.modifyBinary(file(path), bytes.slice().buffer);
            else await vault.adapter.writeBinary(path, bytes.slice().buffer);
        },
        async createFolder(path) { await vault.createFolder(path); },
        async deleteFile(path, disposition) {
            if (indexed(path)) {
                if (disposition === 'trash') await vault.trash(file(path), true);
                else await vault.delete(file(path));
            } else if (disposition === 'trash') {
                if (!await vault.adapter.trashSystem(path)) await vault.adapter.trashLocal(path);
            } else await vault.adapter.remove(path);
        },
    };
}
