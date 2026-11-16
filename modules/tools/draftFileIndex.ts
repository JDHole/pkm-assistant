import type { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { DraftError } from '../vault-drafts/index.js';
import type { DraftFileIndex, DraftIndexEntry } from '../vault-drafts/index.js';
import { isHiddenVaultPath } from './vault_adapter_io.js';

/** No adapter access and no traversal at construction. Never expose a live TFile to a tool. */
export function createDraftFileIndex(app: Pick<App, 'vault'>): DraftFileIndex {
    const isFolder = (value: TAbstractFile): value is TFolder => 'children' in value;
    const isFile = (value: TAbstractFile): value is TFile => 'stat' in value;
    const entry = (value: TAbstractFile): DraftIndexEntry => {
        if (isFolder(value)) return { kind: 'folder', path: value.path === '/' ? '' : value.path,
            children: () => value.children.filter(child => !isHiddenVaultPath(child.path)).map(entry) };
        if (isFile(value)) return { kind: 'file', path: value.path, bytes: value.stat.size, mtime: value.stat.mtime };
        throw new DraftError('io-error', 'Unsupported indexed entry');
    };
    return {
        get(path) {
            if (isHiddenVaultPath(path)) return null;
            const value = path ? app.vault.getAbstractFileByPath(path) : app.vault.getRoot();
            return value ? entry(value) : null;
        },
        files: () => app.vault.getFiles().filter(file => !isHiddenVaultPath(file.path))
            .map(file => ({ kind: 'file', path: file.path, bytes: file.stat.size, mtime: file.stat.mtime })),
    };
}
