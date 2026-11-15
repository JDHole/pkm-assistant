import { isGitConflictStart } from './gitConflict.js';
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

interface ConflictBlock {
    start: number;
    oursStart: number;
    oursEnd: number;
    theirsStart: number;
    end: number;
    closeStart: number;
    opening: string;
    closing: string;
    structural: boolean;
    events: boolean;
    precedingEvents: number;
}

type SessionSplit =
    | { kind: 'not-applicable' | 'unresolved' }
    | { kind: 'split'; ours: string; theirs: string; prefixEvents: number };

/** One line scan records disjoint hunks. No field/content heuristics or prefix reparsing. */
function splitSessionConflict(text: string): SessionSplit {
    const blocks: ConflictBlock[] = [];
    let pending: ConflictBlock | undefined;
    let malformed = false, invalid = false, malformedStructural = false;
    let abandonedStructural = false;
    let frontmatter = /^\uFEFF?---\r?\n/.test(text), beforeEvents = true;
    let events = 0;
    for (let start = 0; start < text.length;) {
        const newline = text.indexOf('\n', start);
        const end = newline < 0 ? text.length : newline + 1;
        const line = text.slice(start, newline < 0 ? end : newline).replace(/\r$/, '');
        if (isGitConflictStart(line)) {
            if (pending) {
                malformed = true;
                if (pending.theirsStart >= 0) malformedStructural ||= pending.structural;
                else abandonedStructural ||= pending.structural;
            }
            pending = { start, oursStart: end, oursEnd: -1, theirsStart: -1, end: -1,
                closeStart: -1, opening: line.slice(7), closing: '', structural: false,
                events: false, precedingEvents: events };
            invalid = false;
        } else if (/^>>>>>>>(?: |$)/.test(line)) {
            // A literal example can displace a real opening before its separator.
            // The real hunk's loose close proves the abandoned structure still matters.
            if (!pending && abandonedStructural) malformedStructural = true;
            if (!pending || invalid || pending.theirsStart < 0) {
                malformed = true;
                malformedStructural ||= pending?.structural ?? false;
            }
            else blocks.push({ ...pending, closeStart: start, end, closing: line.slice(7) });
            pending = undefined;
        } else if (pending && /^\|{7}(?: |$)/.test(line)) {
            if (pending.oursEnd >= 0) invalid = true;
            else pending.oursEnd = start;
        } else if (pending && line === '=======') {
            if (pending.theirsStart >= 0) invalid = true;
            else {
                if (pending.oursEnd < 0) pending.oursEnd = start;
                pending.theirsStart = end;
            }
        } else {
            const boundary = SESSION_BLOCK_BOUNDARY.test(line);
            if (pending && (boundary || beforeEvents && line === '---'
                || frontmatter && /^[^\s:]+:.*$/.test(line))) pending.structural = true;
            if (boundary) {
                if (pending) pending.events = true;
                events++;
                frontmatter = false;
                beforeEvents = false;
            }
            if (start > 0 && line === '---' && !pending) frontmatter = false;
        }
        start = end;
    }
    // Git closes its hunks. An opening left at EOF alone can be conversation text.
    if (pending) malformed = true;
    const first = blocks.find(block => block.structural);
    // Real merge-file can wrap event headings and a literal marker in a single
    // malformed hunk. Treating that as healthy would allow destructive appends.
    if (!first) return { kind: malformedStructural ? 'unresolved' : 'not-applicable' };
    if (malformed) return { kind: 'unresolved' };
    const firstEvent = blocks.find(block => block.events);
    const eventStart = firstEvent?.start ?? Infinity;
    const ours: string[] = [], theirs: string[] = [];
    let copied = 0;
    for (const block of blocks) {
        const sameLabels = block.opening === first.opening && block.closing === first.closing;
        if (block.structural ? !sameLabels : sameLabels === (block.start < eventStart)) {
            return { kind: 'unresolved' };
        }
        if (!block.structural && !sameLabels) continue;
        const common = text.slice(copied, block.start);
        ours.push(common, text.slice(block.oursStart, block.oursEnd));
        theirs.push(common, text.slice(block.theirsStart, block.closeStart));
        copied = block.end;
    }
    const tail = text.slice(copied);
    return { kind: 'split', ours: ours.join('') + tail, theirs: theirs.join('') + tail,
        prefixEvents: firstEvent?.precedingEvents ?? events };
}

/** seq is the writer's terminal field, for every event type. Pre-v2/transcript
 * blocks have no completion witness: accept those only in the identical prefix.
 * That prefix can contain seq repetitions from prior repairs. Divergent seq must
 * increase from its maximum, matching a writer refreshed from the common file.
 * No content field is required: the writer legitimately omits empty values. */
function validSide(blocks: readonly string[], prefixEvents: number): boolean {
    let previous = 0;
    for (let i = 0; i < blocks.length; i++) {
        const raw = blocks[i];
        const seq = raw.match(/\n\*\*seq:\*\*[ \t]*\r?\n\s*(\d+)\s*$/);
        if (!seq) {
            if (i >= prefixEvents || /(?:^|\n)\*\*seq:\*\*[ \t]*(?:\r?\n|$)/.test(raw)) return false;
            continue;
        }
        if (raw.search(/(?:^|\n)\*\*seq:\*\*[ \t]*(?:\r?\n|$)/) !== seq.index) return false;
        const value = Number(seq[1]);
        if (!Number.isSafeInteger(value) || value <= 0) return false;
        if (i >= prefixEvents && value <= previous) return false;
        previous = Math.max(previous, value);
    }
    return true;
}

function headerWithoutDerivedFields(header: string): string {
    const frontmatter = header.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
    if (!frontmatter) return header;
    return frontmatter.replace(/^(?:updated|messageCount):[^\r\n]*(?:\r?\n|$)/gm, '') + header.slice(frontmatter.length);
}

/** Raw union, never seq renumbering. Unknown-time blocks travel with their preceding
 * timed block (leading unknowns stay first); ties preserve ours-before-theirs order. */
export function mergeSessionConflict(text: string): SessionConflict {
    if (!text.includes('<<<<<<<')) return { kind: 'not-applicable' };
    const sides = splitSessionConflict(text);
    if (sides.kind !== 'split') return sides;
    const ours = rawSessionBlocks(sides.ours), theirs = rawSessionBlocks(sides.theirs);
    if (!validSide(ours.blocks, sides.prefixEvents) || !validSide(theirs.blocks, sides.prefixEvents)
        || ours.blocks.slice(0, sides.prefixEvents).some((raw, i) => raw !== theirs.blocks[i])
        || headerWithoutDerivedFields(ours.header) !== headerWithoutDerivedFields(theirs.header)
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
