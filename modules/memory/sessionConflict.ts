import { splitGitConflict } from './gitConflict.js';
import { SESSION_BLOCK_BOUNDARY, eventTypeFromHeader, parseActiveSession, resolveSessionEpoch } from './activeSessionFormat.js';
import type { ParsedActiveSession } from './activeSessionFormat.js';
import { readSessionDevice } from './sessionOwnership.js';

export type SessionConflict =
    | { kind: 'not-applicable' }
    | { kind: 'unresolved' }
    | { kind: 'merged'; text: string };

export class SessionConflictError extends Error {
    constructor() {
        super('Active session synchronization conflict could not be repaired');
        this.name = 'SessionConflictError';
    }
}

/** Same physical boundaries as the parser, but without normalizing any source bytes. */
export function rawSessionBlocks(text: string): { header: string; blocks: string[] } {
    const starts = [...text.matchAll(new RegExp(SESSION_BLOCK_BOUNDARY.source, 'g'))]
        .map(match => match.index + (match[0].startsWith('\n') ? 1 : 0));
    return {
        header: text.slice(0, starts[0] ?? text.length),
        blocks: starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length)),
    };
}

/** Content-only examples (including fenced ones) must remain ordinary user text.
 * Frontmatter evidence is positional, never a `key: value` inside message content. */
function hasStructuralConflict(text: string): boolean {
    let depth = 0;
    let frontmatter = /^\uFEFF?---\r?\n/.test(text);
    let first = true;
    let beforeEvents = true;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (/^<<<<<<<(?: |$)/.test(line)) depth++;
        else if (/^>>>>>>>(?: |$)/.test(line)) depth = Math.max(0, depth - 1);
        else if (depth && (SESSION_BLOCK_BOUNDARY.test(line)
            || beforeEvents && line === '---'
            || frontmatter && /^[^\s:]+:.*$/.test(line))) return true;
        if (!first && line === '---' && depth === 0) frontmatter = false;
        if (SESSION_BLOCK_BOUNDARY.test(line)) { frontmatter = false; beforeEvents = false; }
        first = false;
    }
    return false;
}

function headerWithoutDerivedFields(header: string): string {
    const frontmatter = header.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
    if (!frontmatter) return header;
    return frontmatter.replace(/^(?:updated|messageCount):[^\r\n]*(?:\r?\n|$)/gm, '') + header.slice(frontmatter.length);
}

/** Raw union, never seq renumbering. Unknown-time blocks travel with their preceding
 * timed block (leading unknowns stay first); ties preserve ours-before-theirs order. */
export function mergeSessionConflict(text: string): SessionConflict {
    if (!text.includes('<<<<<<<') || !hasStructuralConflict(text)) return { kind: 'not-applicable' };
    const sides = splitGitConflict(text);
    if (!sides) return { kind: 'unresolved' };
    const ours = rawSessionBlocks(sides.ours), theirs = rawSessionBlocks(sides.theirs);
    if (headerWithoutDerivedFields(ours.header) !== headerWithoutDerivedFields(theirs.header)
        || readSessionDevice(sides.ours).kind === 'ambiguous' || readSessionDevice(sides.theirs).kind === 'ambiguous'
        || resolveSessionEpoch(sides.ours) !== resolveSessionEpoch(sides.theirs)) return { kind: 'unresolved' };

    const shared = new Map<string, number>();
    const blocks: Array<{ raw: string; time: number }> = [];
    for (const side of [ours, theirs]) {
        let anchor = -Infinity;
        for (const raw of side.blocks) {
            const header = raw.split('\n', 1)[0].slice(3).trim();
            const time = Date.parse(header.split(/\s[—-]\s/, 1)[0]);
            if (Number.isFinite(time)) anchor = time;
            if (side === ours) shared.set(raw, (shared.get(raw) ?? 0) + 1);
            else if (shared.get(raw)) {
                shared.set(raw, shared.get(raw)! - 1);
                continue;
            }
            // A range can sweep in messages from the other side, and legacy:N changes
            // when blocks interleave. Refuse ambiguous deletion rather than rewrite IDs.
            if (eventTypeFromHeader(header) === 'messages_removed'
                && (/legacy:\d+/.test(raw) || /\*\*removed_ranges:\*\*\s*(?!\[\s*\])\[/.test(raw))) return { kind: 'unresolved' };
            blocks.push({ raw, time: anchor });
        }
    }
    blocks.sort((a, b) => a.time === b.time ? 0 : a.time < b.time ? -1 : 1);
    const output = ours.header + blocks.map(block => block.raw).join('');
    // A block without a terminating newline could swallow the next heading. Do not
    // invent separator bytes or silently drop an event when that happens.
    const resultBlocks = rawSessionBlocks(output).blocks;
    if (resultBlocks.length !== blocks.length || resultBlocks.some((raw, i) => raw !== blocks[i].raw)) return { kind: 'unresolved' };
    try {
        const parsed = parseActiveSession(output);
        if (parsed.metadata.epoch !== resolveSessionEpoch(sides.ours)) return { kind: 'unresolved' };
    } catch { return { kind: 'unresolved' }; }
    return { kind: 'merged', text: output };
}

export type ConflictAwareSession = ParsedActiveSession & { conflict?: 'unresolved' };

export function readConflictAwareSession(text: string): ConflictAwareSession {
    const merged = mergeSessionConflict(text);
    const parsed = parseActiveSession(merged.kind === 'merged' ? merged.text : text);
    return merged.kind === 'unresolved' ? { ...parsed, conflict: 'unresolved' } : parsed;
}
