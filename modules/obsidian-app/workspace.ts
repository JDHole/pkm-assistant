import type { App, TFile } from 'obsidian';
import type { LeafIdentity, LeafInfo, WorkspacePort } from './index.js';

// Extend only after proving that a renderer cannot disclose external content.
const SAFE_RENDERERS = new Set<string>();
const RENDERER_SELECTORS = '[class*="block-language-"], .internal-query, .cm-lang-query, .cm-preview-code-block, .dataview, .dataview-container';
const OVERLAY_SELECTORS = ['.modal-container', '.hover-popover', '.popover', '.menu', '.suggestion-container', '.tooltip', '.prompt'];
const EMBED_SELECTORS = '.internal-embed, .markdown-embed, .file-embed, .image-embed, .pdf-embed, .media-embed, .cm-embed-block';

/** Obsidian API boundary. File identity is supplied by the composition root. */
export function createWorkspacePort(app: App, isFile: (value: unknown) => value is TFile): WorkspacePort {
    const { workspace, vault } = app;
    const pending = new Set<() => void>();
    let disposed = false;
    const port: WorkspacePort = {
        dispose: () => { disposed = true; for (const cancel of pending) cancel(); },
        observeRender: async (path, waitMs, signal) => {
            const leaf = workspace.getMostRecentLeaf();
            const valid = () => {
                const info = port.listLeaves().find(item => item.active);
                return leaf === workspace.getMostRecentLeaf() && info?.identity.kind === 'file'
                    && info.identity.path === path && 'viewType' in info && info.viewType === 'markdown'
                    && workspace.getActiveFile()?.path === path;
            };
            if (disposed || !leaf || !valid()) throw new Error('View unavailable');
            const state = leaf.getViewState();
            try { await leaf.setViewState({ ...state, state: { ...state.state, mode: 'preview' } }); } catch { /* Inspect the current mode. */ }
            if (disposed || signal.aborted || !valid()) throw new Error('View unavailable');
            const view = leaf.view;
            const preview: unknown = 'previewMode' in view ? view.previewMode : null;
            const content: unknown = preview && typeof preview === 'object' && 'containerEl' in preview ? preview.containerEl : null;
            if (!(content instanceof HTMLElement)) throw new Error('Reading view unavailable');
            const sameView = () => leaf.view === view && 'previewMode' in view && view.previewMode === preview
                && preview !== null && typeof preview === 'object' && 'containerEl' in preview && preview.containerEl === content
                && leaf.getViewState().state?.mode === 'preview';
            const viewState = leaf.getViewState().state;
            const mode = viewState && typeof viewState === 'object' && 'mode' in viewState && viewState.mode === 'preview' ? 'preview' : 'other';
            if (mode !== 'preview') throw new Error('Reading mode unavailable');
            const win = content.ownerDocument.defaultView;
            if (!win || !win.MutationObserver) throw new Error('Observer unavailable');
            const start = Date.now();
            let errors: string[] = [];
            let errorsTruncated = false;
            let active = true;
            const safe = (value: unknown): string => {
                try { return String(value).slice(0, 1000); } catch { return '[unprintable]'; }
            };
            const add = (values: unknown[]) => {
                if (!active) return;
                try {
                    if (errors.length >= 20) { errorsTruncated = true; return; }
                    let message = '';
                    for (const value of values) {
                        if (message.length >= 1000) { errorsTruncated = true; break; }
                        const part = safe(value);
                        const available = 1000 - message.length;
                        const next = (message ? ' ' : '') + part;
                        if (next.length > available || part.length === 1000) errorsTruncated = true;
                        message += next.slice(0, available);
                    }
                    errors.push(message);
                } catch { errorsTruncated = true; }
            };
            const original = win.console.error;
            const wrapped: typeof console.error = function (this: Console, ...args: unknown[]) {
                try { add(args); } finally { original.apply(this, args); }
            };
            const onError = (event: ErrorEvent) => { try { add([event.error instanceof Error ? event.error.stack ?? event.error.message : event.message]); } catch { /* Ignore hostile events. */ } };
            const onRejection = (event: PromiseRejectionEvent) => { try { add([event.reason instanceof Error ? event.reason.stack ?? event.reason.message : event.reason]); } catch { /* Ignore hostile events. */ } };
            return await new Promise((resolve, reject) => {
                let quiet: number | undefined;
                let deadline: number | undefined;
                let done = false;
                const cleanup = () => {
                    active = false; errors = [];
                    observer.disconnect(); win.clearTimeout(quiet); win.clearTimeout(deadline);
                    win.removeEventListener('error', onError); win.removeEventListener('unhandledrejection', onRejection);
                    if (win.console.error === wrapped) win.console.error = original;
                    signal.removeEventListener('abort', cancel); pending.delete(cancel);
                };
                const finish = (stabilized: boolean) => {
                    if (done) return; done = true;
                    try {
                        if (!valid() || !sameView()) throw new Error('View changed');
                        const blocks = Array.from(content.querySelectorAll<HTMLElement>('[class*="block-language-"]')).map(el => ({
                            language: Array.from(el.classList).find(name => name.startsWith('block-language-'))?.slice(15) ?? 'unknown',
                            text: el.textContent ?? '', error: el.querySelector('.dataview-error')?.textContent ?? null,
                        }));
                        resolve({ blocks, errors: [...errors], errorsTruncated, stabilized, elapsedMs: Date.now() - start, mode, verify: () => valid() && sameView() });
                    } catch (error) { reject(error instanceof Error ? error : new Error('View unavailable')); } finally { cleanup(); }
                };
                const cancel = () => { if (done) return; done = true; cleanup(); reject(new Error('Cancelled')); };
                const reset = () => { win.clearTimeout(quiet); quiet = win.setTimeout(() => finish(true), 500); };
                const observer = new win.MutationObserver(reset);
                try {
                    pending.add(cancel); signal.addEventListener('abort', cancel, { once: true });
                    win.addEventListener('error', onError); win.addEventListener('unhandledrejection', onRejection);
                    win.console.error = wrapped;
                    observer.observe(content, { subtree: true, childList: true, characterData: true, attributes: true });
                    deadline = win.setTimeout(() => finish(false), waitMs); reset();
                } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error('Observer unavailable')); return; }
                if (signal.aborted) cancel();
            });
        },
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
        describeCaptureTarget: () => {
            try {
                const leaf = workspace.getMostRecentLeaf();
                if (!leaf || leaf !== workspace.getMostRecentLeaf(workspace.rootSplit) || leaf.isDeferred) return { kind: 'none' };
                const info = port.listLeaves().find(item => item.active);
                const content: unknown = 'contentEl' in leaf.view ? leaf.view.contentEl : null;
                if (!info || !(content instanceof HTMLElement) || !content.isShown() || !leaf.view.containerEl.isShown()) return { kind: 'none' };
                const doc = content.ownerDocument;
                const win = doc.defaultView;
                if (!win) return { kind: 'none' };
                const bounds = content.getBoundingClientRect();
                const x = Math.max(0, bounds.left);
                const y = Math.max(0, bounds.top);
                const right = Math.min(win.innerWidth, bounds.right);
                const bottom = Math.min(win.innerHeight, bounds.bottom);
                if (![x, y, right, bottom, win.innerWidth, win.innerHeight].every(Number.isFinite) || right <= x || bottom <= y) return { kind: 'none' };
                const overlays = OVERLAY_SELECTORS.filter(selector => doc.querySelectorAll(selector).length > 0);
                const blocked: string[] = [];
                for (const el of Array.from(content.querySelectorAll<HTMLElement>(RENDERER_SELECTORS))) {
                    const classes = Array.from(el.classList).filter(name => name.startsWith('block-language-'));
                    if (classes.length !== 1 || !SAFE_RENDERERS.has(classes[0].slice('block-language-'.length))) blocked.push('renderer');
                }
                for (const el of Array.from(content.querySelectorAll<HTMLElement>('.embedded-backlinks'))) {
                    const display: unknown = win.getComputedStyle(el).display;
                    const height: unknown = el.getBoundingClientRect().height;
                    if (typeof display !== 'string' || !display || typeof height !== 'number' || !Number.isFinite(height) || height < 0) throw new Error('Invalid backlinks');
                    if (display !== 'none' && (el.querySelectorAll('.search-result, .tree-item').length > 0 || height > 0)) blocked.push('backlinks');
                }
                const source = info.identity.kind === 'file' ? info.identity.path : '';
                const embeds = Array.from(content.querySelectorAll<HTMLElement>(EMBED_SELECTORS)).map(el => {
                    const parent = el.parentElement?.closest(EMBED_SELECTORS);
                    if (parent && content.contains(parent)) return null;
                    const src: unknown = el.getAttribute('src');
                    if (typeof src !== 'string' || !src) return null;
                    const linkpath = src.split('#')[0].split('|')[0];
                    if (!linkpath) return null;
                    const dest: unknown = app.metadataCache.getFirstLinkpathDest(linkpath, source);
                    return isFile(dest) && typeof dest.path === 'string' ? dest.path : null;
                });
                return { kind: 'ok', leaf: info, rect: { x, y, width: right - x, height: bottom - y }, embeds, blocked, overlays };
            } catch { return { kind: 'none' }; }
        },
        getActivePath: () => {
            const path: unknown = workspace.getActiveFile()?.path ?? null;
            if (path !== null && typeof path !== 'string') throw new Error('Invalid active file');
            return path;
        },
        readSource: async path => { const file = vault.getAbstractFileByPath(path); if (!isFile(file)) throw new Error('File unavailable'); return vault.read(file); },
        fileExists: path => isFile(vault.getAbstractFileByPath(path)),
        openPath: async (path, { newTab }) => {
            const file: unknown = vault.getAbstractFileByPath(path);
            if (!isFile(file)) throw new Error('File unavailable');
            await workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
        },
    };
    return port;
}
