import type { App, TFile } from 'obsidian';
import type { LeafIdentity, LeafInfo, WorkspacePort } from './index.js';

/** Obsidian API boundary. File identity is supplied by the composition root. */
export function createWorkspacePort(app: App, isFile: (value: unknown) => value is TFile): WorkspacePort {
    const { workspace, vault } = app;
    return {
        listLeaves: () => {
            const leaves: LeafInfo[] = [];
            workspace.iterateAllLeaves(leaf => {
                const active = leaf === workspace.getMostRecentLeaf();
                let visible: boolean | 'unknown' = 'unknown';
                try {
                    if (leaf.isDeferred === true) { leaves.push({ active, visible: false, identity: { kind: 'unknown' } }); return; }
                    const container: unknown = leaf.view.containerEl;
                    if (container && typeof container === 'object' && 'isShown' in container && typeof container.isShown === 'function') {
                        const isShown = container.isShown as () => unknown;
                        const shown = isShown.call(container);
                        if (typeof shown === 'boolean') visible = shown;
                    }
                    let identity: LeafIdentity = { kind: 'none' };
                    const state: unknown = leaf.getViewState().state;
                    if (state !== null && typeof state === 'object' && 'file' in state) {
                        identity = typeof state.file === 'string' ? { kind: 'file', path: state.file } : { kind: 'unknown' };
                    }
                    if ('file' in leaf.view) {
                        const viewFile: unknown = leaf.view.file;
                        if (viewFile !== null && typeof viewFile === 'object' && 'path' in viewFile && typeof viewFile.path === 'string') {
                            if (identity.kind === 'unknown' || (identity.kind === 'file' && identity.path !== viewFile.path)) identity = { kind: 'unknown' };
                            else identity = { kind: 'file', path: viewFile.path };
                        } else identity = { kind: 'unknown' };
                    }
                    if (identity.kind === 'unknown') { leaves.push({ active, visible, identity }); return; }
                    const viewType: unknown = leaf.view.getViewType();
                    const title: unknown = identity.kind === 'none' ? leaf.view.getDisplayText() : '';
                    if (typeof title !== 'string' || typeof viewType !== 'string') throw new Error('Invalid workspace view');
                    leaves.push({ title, viewType, identity, active, visible });
                } catch { leaves.push({ active, visible: 'unknown', identity: { kind: 'unknown' } }); }
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
