import { Validator } from '@cfworker/json-schema';
import type { MemoryState } from './StateManager.js';

// Unknown keys belong to other writers and must survive recovery.
const objectSchema = new Validator({ type: 'object' });
function parseObject(text: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(text);
        return objectSchema.validate(value).valid ? value as Record<string, unknown> : null;
    } catch { return null; }
}

function names(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === 'string') : [];
}

function maximum(a: unknown, b: unknown): number | null {
    const numbers = [a, b].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    return numbers.length ? Math.max(...numbers) : null;
}

function laterDate(a: unknown, b: unknown): string | null {
    const dates = [a, b].filter((d): d is string => typeof d === 'string' && Number.isFinite(Date.parse(d)));
    return dates.reduce<string | null>((latest, date) => latest === null || Date.parse(date) > Date.parse(latest) ? date : latest, null);
}

/** Only called for reconstructed conflict sides; healthy files retain their old semantics. */
export function mergeStateConflict(oursText: string, theirsText: string, existing?: readonly string[]): MemoryState | null {
    const ours = parseObject(oursText), theirs = parseObject(theirsText);
    if (!ours || !theirs) return null;
    const active = [...new Set([...names(ours.active_sessions), ...names(theirs.active_sessions)])]
        .filter(name => existing === undefined || existing.includes(name));
    const state: MemoryState = {
        ...theirs, ...ours,
        active_sessions: active,
        archived_since_last_consolidation: maximum(ours.archived_since_last_consolidation, theirs.archived_since_last_consolidation) ?? 0,
        last_archive_at: laterDate(ours.last_archive_at, theirs.last_archive_at),
        last_used: [ours.last_used, theirs.last_used].find((name): name is string => typeof name === 'string' && active.includes(name)) ?? active.at(-1) ?? null,
    };
    if (Object.hasOwn(ours, 'brain_notes_limit') || Object.hasOwn(theirs, 'brain_notes_limit')) {
        state.brain_notes_limit = maximum(ours.brain_notes_limit, theirs.brain_notes_limit);
    }
    return state;
}
