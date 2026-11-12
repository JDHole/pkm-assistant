export { createWorkspacePort } from './workspace.js';
/** Workspace boundary for the built-in app tool. */
export interface LeafInfo { title: string; viewType: string; path: string | null; active: boolean }
export interface WorkspacePort {
    listLeaves(): LeafInfo[];
    getActivePath(): string | null;
    fileExists(path: string): boolean;
    openPath(path: string, options: { newTab: boolean }): Promise<void>;
}
export type AppAction = { action: 'state' } | { action: 'open'; path: string; newTab: boolean };
export type AppErrorCode = 'invalid_args' | 'not_found' | 'access_denied' | 'sub_agent_denied' | 'aborted' | 'unavailable';
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
export function createAppExecutor(port: WorkspacePort) {
    let queue: Promise<void> = Promise.resolve();
    return (args: Record<string, unknown>, context?: AppContext): Promise<AppResult> => {
        const run = async (): Promise<AppResult> => {
            const fail = (code: AppErrorCode): AppResult => ({ ok: false, success: false, error: { code, message: code } });
            if ('_invocationToolNames' in args || '_invocationSubRunContext' in args) return fail('sub_agent_denied');
            const action = parseAction(args);
            if (!action) return fail('invalid_args');
            try {
                if (action.action === 'state') {
                    const tabs = port.listLeaves().map(leaf => {
                        let allowed = false;
                        try { allowed = leaf.path === null || context?.authorizeFileRead?.(leaf.path).allowed === true; } catch { /* fail closed */ }
                        return allowed ? { title: leaf.title, view_type: leaf.viewType, path: leaf.path, active: leaf.active } : { restricted: true as const, active: leaf.active };
                    });
                    const activePath = port.getActivePath();
                    const activeTab = tabs.find(tab => tab.active);
                    let activeAllowed = false;
                    try { activeAllowed = activePath !== null && context?.authorizeFileRead?.(activePath).allowed === true; } catch { /* fail closed */ }
                    return { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: activeTab && 'restricted' in activeTab || !activeAllowed ? null : activePath, tabs } };
                }
                if (!port.fileExists(action.path)) return fail('not_found');
                const before = port.getActivePath();
                if (context?.abortSignal?.aborted || context?.shouldAbort?.()) return fail('aborted');
                await port.openPath(action.path, { newTab: action.newTab });
                const verified = port.getActivePath() === action.path;
                return { ok: true, success: true, verified, effect: verified ? (before === action.path ? 'unchanged' : 'changed') : 'unknown', data: { path: action.path } };
            } catch { return fail('unavailable'); }
        };
        const result = queue.then(run);
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
}
