import type { App, TFile } from 'obsidian';
import type { LeafInfo, WorkspacePort } from './index.js';

/** Obsidian API boundary. File identity is supplied by the composition root. */
export function createWorkspacePort(app: App, isFile: (value: unknown) => value is TFile): WorkspacePort {
    const { workspace, vault } = app;
    return {
        listLeaves: () => {
            const leaves: LeafInfo[] = [];
            workspace.iterateAllLeaves(leaf => {
                const rawFile: unknown = 'file' in leaf.view ? leaf.view.file : null;
                let path: string | null = null;
                if (rawFile !== null && rawFile !== undefined) {
                    if (typeof rawFile !== 'object' || !('path' in rawFile) || typeof rawFile.path !== 'string') throw new Error('Invalid workspace file');
                    path = rawFile.path;
                }
                const title: unknown = leaf.view.getDisplayText();
                const viewType: unknown = leaf.view.getViewType();
                if (typeof title !== 'string' || typeof viewType !== 'string') throw new Error('Invalid workspace view');
                leaves.push({ title, viewType, path, active: leaf === workspace.activeLeaf });
            });
            return leaves;
        },
        getActivePath: () => {
            const path: unknown = workspace.getActiveFile()?.path ?? null;
            if (path !== null && typeof path !== 'string') throw new Error('Invalid active file');
            return path;
        },
        fileExists: path => isFile(vault.getAbstractFileByPath(path)),
        openPath: async (path, { newTab }) => {
            const file: unknown = vault.getAbstractFileByPath(path);
            if (!isFile(file)) throw new Error('File unavailable');
            await workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
        },
    };
}
