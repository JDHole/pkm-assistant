import { CHAT_VIEW_TYPE, sanitizePath } from '../../core/index.js';
import { OBSIDIAN_APP_OPERATION_TIMEOUT_MS } from '../../config/limits.js';
export { createWorkspacePort } from './workspace.js';
export { createCapturePort } from './capture.js';
import { encodeCapture } from './capture.js';
import type { CapturePort } from './capture.js';
export type { CapturePort, CapturedFrame } from './capture.js';

export type LeafIdentity = { kind: 'file'; path: string } | { kind: 'none' } | { kind: 'unknown' };
export type LeafInfo = { visible: boolean | 'unknown'; active: boolean; identity: { kind: 'unknown' } } | { visible: boolean | 'unknown'; active: boolean; identity: { kind: 'file'; path: string } | { kind: 'none' }; title: string; viewType: string };
export interface WorkspacePort {
    listLeaves(): LeafInfo[];
    describeCaptureTarget?(): CaptureTarget;
    getActivePath(): string | null;
    fileExists(path: string): boolean;
    openPath(path: string, options: { newTab: boolean }): Promise<void>;
}
export type CaptureRect = { x: number; y: number; width: number; height: number };
export type CaptureTarget = { kind: 'none' } | { kind: 'ok'; leaf: LeafInfo; rect: CaptureRect; embeds: (string | null)[]; blocked: string[]; overlays: string[] };
export type AppAction = { action: 'state' } | { action: 'screenshot' } | { action: 'open'; path: string; newTab: boolean };
export type AppErrorCode = 'invalid_args' | 'not_found' | 'access_denied' | 'sub_agent_denied' | 'aborted' | 'unavailable' | 'timeout' | 'busy' | 'capture_unavailable' | 'restricted_content_visible' | 'too_large' | 'no_capturable_view' | 'overlay_visible' | 'screenshot_disabled';
export type AppResult = { ok: false; success: false; error: { code: AppErrorCode; message: string } } | { ok: true; success: true; verified: boolean; effect: 'changed' | 'unchanged' | 'unknown'; data: unknown } | { ok: true; success: true; verified: true; effect: 'unchanged'; kind: 'media'; summary: string; images: { mime: 'image/jpeg'; base64: string; width: number; height: number }[] };
export function isObsidianAppEnabled(settings: { pkmAssistant?: { obsidianAppEnabled?: boolean } }): boolean {
    return settings.pkmAssistant?.obsidianAppEnabled === true;
}
export function parseAction(input: unknown): AppAction | null {
    if (!input || typeof input !== 'object') return null;
    if (!('action' in input)) return null;
    if (input.action === 'state' || input.action === 'screenshot') return { action: input.action };
    if (input.action !== 'open' || !('path' in input) || typeof input.path !== 'string' || !input.path.trim()) return null;
    if ('new_tab' in input && typeof input.new_tab !== 'boolean') return null;
    return { action: 'open', path: input.path, newTab: 'new_tab' in input && input.new_tab === true };
}
export interface AppContext { authorizeFileRead?: (path: string) => { allowed: boolean }; abortSignal?: AbortSignal; shouldAbort?: () => boolean }
const fail = (code: AppErrorCode): AppResult => ({ ok: false, success: false, error: { code, message: code } });
const FILELESS_VIEWS = new Set(['graph', 'search', 'file-explorer', 'bookmarks', 'tag', 'empty', 'all-properties', CHAT_VIEW_TYPE, 'pkm-agent-sidebar', 'pkm-release-notes-view']);
function authorizedPath(path: string | null, authorize?: AppContext['authorizeFileRead']): path is string {
    try { return path !== null && sanitizePath(path) === path && authorize?.(path).allowed === true; } catch { return false; }
}
export function discloseLeaf(leaf: Omit<LeafInfo, 'visible'> | LeafInfo, authorize?: AppContext['authorizeFileRead']) {
    const restricted = { restricted: true as const, active: leaf.active };
    try {
        if (leaf.identity.kind === 'unknown' || !('title' in leaf)) return restricted;
        if (leaf.identity.kind === 'file') {
            const path = leaf.identity.path;
            if (!authorizedPath(path, authorize)) return restricted;
            const filename = path.split('/').pop() ?? '';
            const title = filename.replace(/\.[^.]+$/, '');
            return { title, view_type: leaf.viewType, path, active: leaf.active };
        }
        if (!FILELESS_VIEWS.has(leaf.viewType)) return restricted;
        return { title: leaf.title, view_type: leaf.viewType, path: null, active: leaf.active };
    } catch { return restricted; }
}
export function decideCapture(target: CaptureTarget, authorize?: AppContext['authorizeFileRead']): { kind: 'ok'; rect: CaptureRect } | { kind: 'error'; code: AppErrorCode } {
    if (target.kind === 'none') return { kind: 'error', code: 'no_capturable_view' };
    const leaf = discloseLeaf(target.leaf, authorize);
    const rect = target.rect;
    if (!target.leaf.active || target.leaf.visible !== true || !('path' in leaf) || !leaf.path || !['markdown', 'pdf', 'image'].includes(leaf.view_type) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) return { kind: 'error', code: 'no_capturable_view' };
    if (target.overlays.length) return { kind: 'error', code: 'overlay_visible' };
    if (target.blocked.length || target.embeds.some(path => !authorizedPath(path, authorize))) return { kind: 'error', code: 'restricted_content_visible' };
    return { kind: 'ok', rect };
}
export type AppExecutorOptions = { screenshot?: 'disabled' | 'enabled' };
export function createAppExecutor(port: WorkspacePort, timeoutMs = OBSIDIAN_APP_OPERATION_TIMEOUT_MS, capturePort: CapturePort | null = null, options: AppExecutorOptions = {}) {
    const screenshotEnabled = options.screenshot === 'enabled';
    let queue: Promise<void> = Promise.resolve();
    let suspended = false;
    let capturing = false;
    return (args: Record<string, unknown>, context?: AppContext): Promise<AppResult> => {
        if ('_invocationToolNames' in args || '_invocationSubRunContext' in args) return Promise.resolve(fail('sub_agent_denied'));
        const action = parseAction(args);
        if (!action) return Promise.resolve(fail('invalid_args'));
        if (action.action === 'screenshot' && !screenshotEnabled) return Promise.resolve(fail('screenshot_disabled'));
        const aborted = () => context?.abortSignal?.aborted === true || context?.shouldAbort?.() === true;
        if (aborted()) return Promise.resolve(fail('aborted'));
        if ((action.action === 'open' && suspended) || (action.action === 'screenshot' && capturing)) return Promise.resolve(fail('busy'));
        const run = async (expired: () => boolean): Promise<AppResult> => {
            if (aborted()) return fail('aborted');
            try {
                if (action.action === 'state') {
                    const tabs = port.listLeaves().map(leaf => discloseLeaf(leaf, context?.authorizeFileRead));
                    const activeTab = tabs.find(tab => tab.active);
                    const activeFile = port.getActivePath();
                    return { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: activeTab && 'path' in activeTab ? activeTab.path : null, active_file: authorizedPath(activeFile, context?.authorizeFileRead) ? activeFile : null, tabs } };
                }
                if (action.action === 'screenshot') {
                    const decision = decideCapture(port.describeCaptureTarget?.() ?? { kind: 'none' }, context?.authorizeFileRead);
                    if (decision.kind === 'error') return fail(decision.code);
                    if (aborted()) return fail('aborted');
                    if (!capturePort) return fail('capture_unavailable');
                    capturing = true;
                    let frame: unknown;
                    try { frame = await capturePort.capture(decision.rect); } finally { capturing = false; }
                    if (expired() || aborted()) return fail(aborted() ? 'aborted' : 'timeout');
                    const image = await encodeCapture(frame);
                    if (!image) return fail('too_large');
                    return { ok: true, success: true, verified: true, effect: 'unchanged', kind: 'media', summary: `Obsidian active note screenshot ${image.width}x${image.height}`, images: [image] };
                }
                if (!port.fileExists(action.path)) return fail('not_found');
                const before = port.getActivePath();
                if (aborted()) return fail('aborted');
                await port.openPath(action.path, { newTab: action.newTab });
                const verified = port.getActivePath() === action.path;
                return { ok: true, success: true, verified, effect: verified ? (before === action.path ? 'unchanged' : 'changed') : 'unknown', data: { path: action.path } };
            } catch { return fail(action.action === 'screenshot' ? 'capture_unavailable' : 'unavailable'); }
        };
        const scheduled = queue.then(async () => {
            if (aborted()) return fail('aborted');
            if ((action.action === 'open' && suspended) || (action.action === 'screenshot' && capturing)) return fail('busy');
            let timer: number | undefined;
            let settled = false;
            let expired = false;
            const operation = run(() => expired).finally(() => { settled = true; if (action.action === 'open') suspended = false; });
            const timeout = new Promise<AppResult>(resolve => { timer = window.setTimeout(() => {
                expired = true;
                if (action.action === 'open' && !settled) suspended = true;
                resolve(fail('timeout'));
            }, timeoutMs); });
            try { return await Promise.race([operation, timeout]); } finally { window.clearTimeout(timer); }
        });
        queue = scheduled.then(() => undefined, () => undefined);
        const signal = context?.abortSignal;
        if (!signal) return scheduled;
        return new Promise<AppResult>(resolve => {
            const onAbort = () => resolve(fail('aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
            void scheduled.then(result => { signal.removeEventListener('abort', onAbort); resolve(result); });
        });
    };
}
