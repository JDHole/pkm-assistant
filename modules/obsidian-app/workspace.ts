import type { App, TFile } from 'obsidian';
import type { LeafIdentity, LeafInfo, WorkspacePort } from './index.js';

// Extend only after proving that a renderer cannot disclose external content.
const SAFE_RENDERERS = new Set<string>();
const RENDERER_SELECTORS = '[class*="block-language-"], .internal-query, .cm-lang-query, .cm-preview-code-block, .dataview, .dataview-container';
const OVERLAY_SELECTORS = ['.modal-container', '.hover-popover', '.popover', '.menu', '.suggestion-container', '.tooltip', '.prompt'];
const EMBED_SELECTORS = '.internal-embed, .markdown-embed, .file-embed, .image-embed, .pdf-embed, .media-embed, .cm-embed-block';

/** Obsidian API boundary. File identity is supplied by the composition root. */
export function createWorkspacePort(app: App, isFile: (value: unknown) => value is TFile, options: { renderCheck?: 'enabled' } = {}): WorkspacePort {
    const { workspace, vault } = app;
    const pending = new Set<() => void>();
    let disposed = false;
    const port: WorkspacePort = {
        dispose: () => { disposed = true; for (const cancel of pending) cancel(); },
        isDisposed: () => disposed,
        ...(options.renderCheck === 'enabled' ? { observeRender: async (path: string, waitMs: number, signal: AbortSignal, authorize = () => true) => {
            if (disposed || !authorize()) throw new Error('Unavailable');
            const leaf = workspace.getMostRecentLeaf();
            const valid = () => {
                if (disposed || signal.aborted || !authorize()) return false;
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
            const hasViewFile = 'file' in view;
            const viewFile = 'file' in view ? view.file : undefined;
            const preview: unknown = 'previewMode' in view ? view.previewMode : null;
            const content: unknown = preview && typeof preview === 'object' && 'containerEl' in preview ? preview.containerEl : null;
            if (!(content instanceof HTMLElement)) throw new Error('Reading view unavailable');
            const sameView = () => leaf.view === view && 'previewMode' in view && view.previewMode === preview
                && ('file' in view) === hasViewFile && (!('file' in view) || view.file === viewFile)
                && preview !== null && typeof preview === 'object' && 'containerEl' in preview && preview.containerEl === content
                && leaf.getViewState().state?.mode === 'preview';
            const viewState = leaf.getViewState().state;
            const mode = viewState && typeof viewState === 'object' && 'mode' in viewState && viewState.mode === 'preview' ? 'preview' : 'other';
            if (mode !== 'preview') throw new Error('Reading mode unavailable');
            const win = content.ownerDocument.defaultView;
            if (!win || !win.MutationObserver) throw new Error('Observer unavailable');
            const start = Date.now();
            let errors: { text: string; truncated: boolean }[] = [];
            let errorsTruncated = false;
            let active = true;
            const safe = (value: unknown): string => {
                try { return String(value); } catch { return '[unprintable]'; }
            };
            const add = (values: unknown[]) => {
                if (!active) return;
                try {
                    if (errors.length >= 20) { errorsTruncated = true; return; }
                    const budget = 20000 - errors.reduce((sum, item) => sum + item.text.length, 0);
                    if (budget <= 0) { errorsTruncated = true; return; }
                    let message = '';
                    let truncated = false;
                    for (const value of values) {
                        if (message.length >= budget) { truncated = true; break; }
                        const part = safe(value);
                        const available = budget - message.length;
                        const prefix = message ? ' ' : '';
                        if (prefix.length + part.length > available) truncated = true;
                        message += prefix + Array.from(part.slice(0, Math.max(0, available - prefix.length))).join('');
                    }
                    if (truncated) message = message.replace(/\S+$/, '');
                    errors.push({ text: message, truncated });
                } catch { errorsTruncated = true; }
            };
            const original = win.console.error;
            const wrapped: typeof console.error = function (this: Console, ...args: unknown[]) {
                try { add(args); } finally { original.apply(this, args); }
            };
            const onError = (event: ErrorEvent) => { if (!active) return; try { add([event.error instanceof Error ? event.error.stack ?? event.error.message : event.message]); } catch { /* Ignore hostile events. */ } };
            const onRejection = (event: PromiseRejectionEvent) => { if (!active) return; try { add([event.reason instanceof Error ? event.reason.stack ?? event.reason.message : event.reason]); } catch { /* Ignore hostile events. */ } };
            return await new Promise((resolve, reject) => {
                let quiet: number | undefined;
                let deadline: number | undefined;
                let identityTimer: number | undefined;
                let done = false;
                let changed = false;
                const refs: ReturnType<typeof workspace.on>[] = [];
                const check = () => { if (changed || !valid() || !sameView()) { changed = true; throw new Error('View changed'); } };
                const onWorkspace = () => { if (!active) return; try { check(); } catch { changed = true; } };
                const cleanup = () => {
                    active = false; errors = [];
                    for (const ref of refs) workspace.offref(ref);
                    observer.disconnect(); win.clearTimeout(quiet); win.clearTimeout(deadline); win.clearTimeout(identityTimer);
                    win.removeEventListener('error', onError); win.removeEventListener('unhandledrejection', onRejection);
                    if (win.console.error === wrapped) win.console.error = original;
                    signal.removeEventListener('abort', cancel); pending.delete(cancel);
                };
                const insideEmbed = (el: HTMLElement | null) => {
                    let parent = el;
                    while (parent && parent !== content) {
                        if (Array.from(parent.classList).some(name => EMBED_SELECTORS.split(', ').includes(`.${name}`))) return true;
                        parent = parent.parentElement;
                    }
                    return false;
                };
                const finish = (stabilized: boolean) => {
                    if (done) return; done = true;
                    try {
                        check();
                        const elements = Array.from(content.querySelectorAll<HTMLElement>('[class*="block-language-"]'));
                        check();
                        let remainingText = 20000;
                        const collect = (text: string) => {
                            const clipped = text.length > remainingText;
                            let value = Array.from(text.slice(0, remainingText)).join('');
                            if (clipped) value = value.replace(/\S+$/, '');
                            remainingText -= value.length;
                            return { value, clipped };
                        };
                        const collectText = (el: HTMLElement) => {
                            check();
                            if (!el.childNodes) { const text = el.textContent ?? ''; return { ...collect(text), nonempty: !!text.trim() }; }
                            let value = ''; let clipped = false; let nonempty = false;
                            const walk = (node: Node) => {
                                check();
                                if (node.nodeType === 1 && insideEmbed(node as HTMLElement)) return;
                                if (node.nodeType === 3) {
                                    const part = node.nodeValue ?? '';
                                    if (part.trim()) nonempty = true;
                                    const available = remainingText - value.length;
                                    if (part.length > available) clipped = true;
                                    value += Array.from(part.slice(0, available)).join('');
                                } else for (const child of Array.from(node.childNodes)) walk(child);
                            };
                            walk(el);
                            if (clipped) value = value.replace(/\S+$/, '');
                            remainingText -= value.length;
                            return { value, clipped, nonempty };
                        };
                        const blocks = elements.filter(el => { check(); return !insideEmbed(el); }).map(el => {
                            check();
                            const language = Array.from(el.classList).find(name => name.startsWith('block-language-'))?.slice(15) ?? 'unknown';
                            check();
                            const text = collectText(el);
                            check();
                            const errorEl = el.querySelector<HTMLElement>('.dataview-error');
                            check();
                            const error = errorEl && !insideEmbed(errorEl) ? collectText(errorEl) : null;
                            check();
                            return { language, text: text.value, nonempty: text.nonempty, textClipped: text.clipped, error: error?.value ?? null, errorClipped: error?.clipped === true };
                        });
                        check();
                        resolve({ blocks, errors: [...errors], errorsTruncated, stabilized, elapsedMs: Date.now() - start, mode, verify: () => !changed && valid() && sameView() });
                    } catch (error) { reject(error instanceof Error ? error : new Error('View unavailable')); } finally { cleanup(); }
                };
                const cancel = () => { if (done) return; done = true; cleanup(); reject(new Error('Cancelled')); };
                const reset = (records?: MutationRecord[]) => {
                    if (!active) return;
                    if (records?.length && records.every(record => insideEmbed(record.target.nodeType === 1 ? record.target as HTMLElement : record.target.parentElement))) return;
                    try { check(); } catch { cancel(); return; } win.clearTimeout(quiet); if (active) quiet = win.setTimeout(() => finish(true), 500);
                };
                const pollIdentity = () => {
                    if (!active) return;
                    try { check(); } catch { cancel(); return; }
                    if (active) identityTimer = win.setTimeout(pollIdentity, 50);
                };
                const observer = new win.MutationObserver(reset);
                try {
                    if (typeof workspace.on === 'function') {
                        for (const subscribe of [() => workspace.on('file-open', onWorkspace), () => workspace.on('active-leaf-change', onWorkspace), () => workspace.on('layout-change', onWorkspace)]) {
                            if (!active) break;
                            const ref = subscribe();
                            if (active) refs.push(ref); else workspace.offref(ref);
                        }
                    }
                    if (active) pending.add(cancel);
                    if (active) signal.addEventListener('abort', cancel, { once: true });
                    if (active) win.addEventListener('error', onError);
                    if (active) win.addEventListener('unhandledrejection', onRejection);
                    if (active) win.console.error = wrapped;
                    if (active) observer.observe(content, { subtree: true, childList: true, characterData: true, attributes: true });
                    if (active) deadline = win.setTimeout(() => finish(false), waitMs);
                    if (active) reset();
                    if (active) identityTimer = win.setTimeout(pollIdentity, 50);
                } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error('Observer unavailable')); return; }
                if (signal.aborted) cancel();
            });
        } } : {}),
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
        readSource: async path => { if (disposed) throw new Error('Disposed'); const file = vault.getAbstractFileByPath(path); if (!isFile(file)) throw new Error('File unavailable'); return vault.read(file); },
        fileExists: path => isFile(vault.getAbstractFileByPath(path)),
        openPath: async (path, { newTab }) => {
            const file: unknown = vault.getAbstractFileByPath(path);
            if (!isFile(file)) throw new Error('File unavailable');
            await workspace.getLeaf(newTab ? 'tab' : false).openFile(file);
        },
    };
    return port;
}
