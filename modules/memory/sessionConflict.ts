import { splitGitConflict } from './gitConflict.js';
import { EVENT_FIELDS, HEADER_FIELDS, KNOWN_ROLES, SESSION_BLOCK_BOUNDARY, eventTypeFromHeader, extractEventField, parseActiveSession, resolveSessionEpoch } from './activeSessionFormat.js';
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

/** Preserve examples only in a single free-text field before divergent events.
 * A common event after a divergent hunk is ambiguous: refusing it is safer than
 * manufacturing two different messages from its literal example. */
function splitSessionConflict(text: string, structuralConflict: boolean): ReturnType<typeof splitGitConflict> {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const freeText = new Set(['content', 'args', 'result', 'prompt', 'parent_conversation_text', 'question', 'sub_task_history', 'tool_calls']);
    const labels = new RegExp(`^\\*\\*(${EVENT_FIELDS.join('|')}):\\*\\*[ \\t]*$`);
    let event = false, field = '', divergent = false, commonEvent = false, body = false;
    let transcript = false;
    let eventBody = '';
    let eventOrdinal = 0;
    const unprovenEvents = new Set<number>();
    let ours = '', theirs = '', pending = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r?\n$/, '');
        if (!/^<<<<<<<(?: |$)/.test(line)) {
            pending += lines[i];
            if (SESSION_BLOCK_BOUNDARY.test(line)) {
                event = true; commonEvent = true; body = false;
                eventOrdinal++;
                transcript = KNOWN_ROLES.has(line.slice(3).trim().toLowerCase());
                field = transcript ? 'content' : '';
                eventBody = '';
            } else eventBody += lines[i];
            const label = line.match(labels);
            if (!transcript && label && (!body || !HEADER_FIELDS.has(label[1]))) {
                field = label[1];
                if (!HEADER_FIELDS.has(field)) body = true;
            }
            continue;
        }
        let hunk = lines[i], structural = false, boundary = false, closed = false;
        for (++i; i < lines.length; i++) {
            const inside = lines[i].replace(/\r?\n$/, '');
            hunk += lines[i];
            if (/^<<<<<<<(?: |$)/.test(inside)) {
                return !structuralConflict && event && (!field || freeText.has(field)) ? { ours: text, theirs: text } : null;
            }
            if (SESSION_BLOCK_BOUNDARY.test(inside)) structural = true;
            const label = inside.match(labels);
            if (!transcript && label && (!body || !HEADER_FIELDS.has(label[1]))) boundary = true;
            if (/^>>>>>>>(?: |$)/.test(inside)) { closed = true; break; }
        }
        if (!closed) return !structuralConflict && event && (!field || freeText.has(field)) ? { ours: text, theirs: text } : null;
        if (event && !structural && !divergent) {
            if (!structuralConflict && !field) { pending += hunk; continue; }
            if (!freeText.has(field) || boundary) return null;
            // With equal timestamps Git can leave the new event's heading outside
            // the first hunk. Without a common stable ID it is indistinguishable
            // from a literal example in an old message (see real merge-file tests).
            const normalizedBody = eventBody.replace(/\r\n/g, '\n');
            const id = extractEventField(normalizedBody, 'message_id').trim();
            const precedingText = transcript ? normalizedBody : extractEventField(normalizedBody, field);
            if (!id || /^legacy:\d+$/.test(id)) {
                if (structuralConflict) return null;
                // Several whole-field hunks in different legacy events can be a
                // merge whose timestamps all agree. A single literal example has
                // historically remained ordinary content and must still do so.
                if (!precedingText.trim()) unprovenEvents.add(eventOrdinal);
                if (unprovenEvents.size > 1) return null;
            }
            pending += hunk;
            eventBody += hunk;
            continue;
        }
        if (event && !structural && commonEvent) return null;
        const sides = splitGitConflict(hunk);
        if (!sides) return null;
        ours += pending + sides.ours;
        theirs += pending + sides.theirs;
        pending = '';
        if (structural) { divergent = true; event = true; commonEvent = false; }
    }
    return { ours: ours + pending, theirs: theirs + pending };
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
    const structural = hasStructuralConflict(text);
    const sides = splitSessionConflict(text, structural);
    if (!sides) return { kind: 'unresolved' };
    if (!structural) return { kind: 'not-applicable' };
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
