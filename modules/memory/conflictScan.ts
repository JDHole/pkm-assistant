import type { DataAdapter } from 'obsidian';
import { hasGitConflictStart } from './gitConflict.js';

type ScanAdapter = Pick<DataAdapter, 'exists' | 'list' | 'stat' | 'read'>;
export interface MemoryConflictCounts {
    state: number;
    brain: number;
    sessions: number;
    costLog: number;
    unreadable: number;
    skipped: number;
}

const SESSION_LIMIT = 50;
const MAX_BYTES = 1024 * 1024;
const ROOT = '.pkm-assistant';

// Adapter listings may contain full paths or basenames, but never traverse children.
function directChildren(parent: string, entries: string[]): string[] {
    const children = entries.flatMap(entry => {
        const name = entry.startsWith(parent + '/') ? entry.slice(parent.length + 1) : entry;
        return name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
            ? [`${parent}/${name}`] : [];
    });
    return [...new Set(children)];
}

/** Read-only, on-demand snapshot. No agent runtime, repair, logging or persistent cache. */
export async function scanMemoryConflicts(adapter: ScanAdapter): Promise<MemoryConflictCounts> {
    const counts: MemoryConflictCounts = { state: 0, brain: 0, sessions: 0, costLog: 0, unreadable: 0, skipped: 0 };
    async function list(path: string): Promise<{ files: string[]; folders: string[] }> {
        try {
            if (!await adapter.exists(path)) return { files: [], folders: [] };
            const listing = await adapter.list(path);
            return { files: directChildren(path, listing.files), folders: directChildren(path, listing.folders) };
        } catch {
            counts.unreadable++;
            return { files: [], folders: [] };
        }
    }
    async function inspect(path: string, group: 'state' | 'brain' | 'sessions' | 'costLog', listed = false): Promise<void> {
        try {
            const stat = await adapter.stat(path);
            if (!stat && !listed && !await adapter.exists(path)) return;
            if (!stat || stat.type !== 'file' || !Number.isFinite(stat.size) || stat.size < 0) {
                counts.unreadable++;
                return;
            }
            if (stat.size > MAX_BYTES) { counts.skipped++; return; }
            if (hasGitConflictStart(await adapter.read(path))) counts[group]++;
        } catch { counts.unreadable++; }
    }

    const agents = await list(`${ROOT}/agents`);
    for (const agent of agents.folders) {
        const memory = `${agent}/memory`;
        await inspect(`${memory}/.state.json`, 'state');
        await inspect(`${memory}/brain.md`, 'brain');
        const active = await list(`${memory}/sessions/active`);
        const sessions = active.files.filter(path => path.endsWith('.md')).sort().reverse();
        counts.skipped += Math.max(0, sessions.length - SESSION_LIMIT);
        for (const path of sessions.slice(0, SESSION_LIMIT)) await inspect(path, 'sessions', true);
    }
    await inspect(`${ROOT}/cost_log.jsonl`, 'costLog');
    return counts;
}
