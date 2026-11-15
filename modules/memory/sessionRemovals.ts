import { SESSION_BLOCK_BOUNDARY } from './activeSessionFormat.js';

/** RAM-only read receipt. Never serialized into vault files or model messages. */
export interface SessionRemovalContext { readonly source: string }
const reads = new WeakMap<object, SessionRemovalContext>();

export function rememberSessionRead(result: object, messages: readonly object[], source: string): void {
    const context = { source };
    reads.set(result, context);
    reads.set(messages, context);
}

export function sessionRemovalContext(result: object): SessionRemovalContext | undefined {
    return reads.get(result);
}

export class SessionRemovalConflictError extends Error {
    constructor() {
        super('Session changed since the removal snapshot; reopen before removing messages');
        this.name = 'SessionRemovalConflictError';
    }
}

function eventBody(source: string): string {
    const start = source.search(SESSION_BLOCK_BOUNDARY);
    return start < 0 ? '' : source.slice(start);
}

/** Positional identities are safe only while the entire observed log is still a
 * prefix. Header timestamps/counts may change; append-only events may follow it.
 * Explicit identities allow dropping a range that would sweep in unknown IDs. */
export function safeRemovalRanges(source: string, visibleIds: readonly string[], removed: ReadonlySet<string>,
    ranges: readonly { from: string; to: string }[], context?: SessionRemovalContext): { from: string; to: string }[] {
    if (!removed.size && !ranges.length) return [];
    if (!removed.size) throw new SessionRemovalConflictError();
    const references = [...removed, ...ranges.flatMap(range => [range.from, range.to])];
    if (references.some(id => /^legacy:\d+$/.test(id))) {
        const observed = context && eventBody(context.source);
        if (!observed || !eventBody(source).startsWith(observed)) throw new SessionRemovalConflictError();
    }
    return ranges.filter(range => {
        const from = visibleIds.indexOf(range.from), to = visibleIds.lastIndexOf(range.to);
        if (from < 0 || to < from) return false;
        const unknown = visibleIds.slice(from, to + 1).some(id => !removed.has(id));
        return !unknown;
    });
}
