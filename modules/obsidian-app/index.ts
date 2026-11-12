import { sanitizePath } from '../../core/index.js';
import { OBSIDIAN_APP_OPERATION_TIMEOUT_MS } from '../../config/limits.js';
export { createWorkspacePort } from './workspace.js';

export type LeafIdentity = { kind: 'file'; path: string } | { kind: 'none' } | { kind: 'unknown' };
export type LeafInfo = { active: boolean; identity: { kind: 'unknown' } } | { active: boolean; identity: { kind: 'file'; path: string } | { kind: 'none' }; title: string; viewType: string };
export interface WorkspacePort {
    listLeaves(): LeafInfo[];
    getActivePath(): string | null;
    fileExists(path: string): boolean;
    openPath(path: string, options: { newTab: boolean }): Promise<void>;
}
export type AppAction = { action: 'state' } | { action: 'open'; path: string; newTab: boolean };
export type AppErrorCode = 'invalid_args' | 'not_found' | 'access_denied' | 'sub_agent_denied' | 'aborted' | 'unavailable' | 'timeout';
export type AppResult = { ok: false; success: false; error: { code: AppErrorCode; message: string } } | { ok: true; success: true; verified: boolean; effect: 'changed' | 'unchanged' | 'unknown'; data: unknown };
export function isObsidianAppEnabled(settings: { pkmAssistant?: { obsidianAppEnabled?: boolean } }): boolean {
    return settings.pkmAssistant?.obsidianAppEnabled === true;
}
export function parseAction(input: unknown): AppAction | null {
    if (!input || typeof input !== 'object') return null;
    if (!('action' in input)) return null;
    if (input.action === 'state') return { action: 'state' };
    if (input.action !== 'open' || !('path' in input) || typeof input.path !== 'string' || !input.path.trim()) return null;
    if ('new_tab' in input && typeof input.new_tab !== 'boolean') return null;
    return { action: 'open', path: input.path, newTab: 'new_tab' in input && input.new_tab === true };
}
export interface AppContext { authorizeFileRead?: (path: string) => { allowed: boolean }; abortSignal?: AbortSignal; shouldAbort?: () => boolean }
const fail = (code: AppErrorCode): AppResult => ({ ok: false, success: false, error: { code, message: code } });
export function createAppExecutor(port: WorkspacePort, timeoutMs = OBSIDIAN_APP_OPERATION_TIMEOUT_MS) {
    let queue: Promise<void> = Promise.resolve();
    return (args: Record<string, unknown>, context?: AppContext): Promise<AppResult> => {
        if ('_invocationToolNames' in args || '_invocationSubRunContext' in args) return Promise.resolve(fail('sub_agent_denied'));
        const action = parseAction(args);
        if (!action) return Promise.resolve(fail('invalid_args'));
        const aborted = () => context?.abortSignal?.aborted === true || context?.shouldAbort?.() === true;
        if (aborted()) return Promise.resolve(fail('aborted'));
        const run = async (): Promise<AppResult> => {
            if (aborted()) return fail('aborted');
            try {
                if (action.action === 'state') {
                    const tabs = port.listLeaves().map(leaf => {
                        let allowed = leaf.identity.kind === 'none';
                        if (leaf.identity.kind === 'file') {
                            try { allowed = sanitizePath(leaf.identity.path) === leaf.identity.path && context?.authorizeFileRead?.(leaf.identity.path).allowed === true; } catch { /* fail closed */ }
                        }
                        if (!allowed || leaf.identity.kind === 'unknown' || !('title' in leaf)) return { restricted: true as const, active: leaf.active };
                        return { title: leaf.title, view_type: leaf.viewType, path: leaf.identity.kind === 'file' ? leaf.identity.path : null, active: leaf.active };
                    });
                    const activeTab = tabs.find(tab => tab.active);
                    return { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: activeTab && 'path' in activeTab ? activeTab.path : null, tabs } };
                }
                if (!port.fileExists(action.path)) return fail('not_found');
                const before = port.getActivePath();
                if (aborted()) return fail('aborted');
                await port.openPath(action.path, { newTab: action.newTab });
                const verified = port.getActivePath() === action.path;
                return { ok: true, success: true, verified, effect: verified ? (before === action.path ? 'unchanged' : 'changed') : 'unknown', data: { path: action.path } };
            } catch { return fail('unavailable'); }
        };
        const scheduled = queue.then(async () => {
            if (aborted()) return fail('aborted');
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<AppResult>(resolve => { timer = setTimeout(() => resolve(fail('timeout')), timeoutMs); });
            try { return await Promise.race([run(), timeout]); } finally { clearTimeout(timer); }
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
