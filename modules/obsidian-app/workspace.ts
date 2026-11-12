import type { App, TFile } from 'obsidian';
import type { LeafIdentity, LeafInfo, WorkspacePort } from './index.js';

/** Obsidian API boundary. File identity is supplied by the composition root. */
export function createWorkspacePort(app: App, isFile: (value: unknown) => value is TFile): WorkspacePort {
    const { workspace, vault } = app;
    return {
        listLeaves: () => {
            const leaves: LeafInfo[] = [];
            workspace.iterateAllLeaves(leaf => {
                const active = leaf === workspace.activeLeaf;
                try {
                    let identity: LeafIdentity;
                    if ('file' in leaf.view) {
                        const viewFile: unknown = leaf.view.file;
                        identity = viewFile !== null && typeof viewFile === 'object' && 'path' in viewFile && typeof viewFile.path === 'string' ? { kind: 'file', path: viewFile.path } : { kind: 'unknown' };
                    } else {
                        const state: unknown = leaf.getViewState().state;
                        if (state !== null && typeof state === 'object' && 'file' in state) {
                            identity = typeof state.file === 'string' ? { kind: 'file', path: state.file } : { kind: 'unknown' };
                        } else identity = { kind: 'none' };
                    }
                    if (identity.kind === 'unknown') { leaves.push({ active, identity }); return; }
                    const title: unknown = leaf.view.getDisplayText();
                    const viewType: unknown = leaf.view.getViewType();
                    if (typeof title !== 'string' || typeof viewType !== 'string') throw new Error('Invalid workspace view');
                    leaves.push({ title, viewType, identity, active });
                } catch { leaves.push({ active, identity: { kind: 'unknown' } }); }
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
