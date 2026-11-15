import { isNaTerazHeading, sectionKeyOf } from './brainSections.js';
import { splitGitConflict } from './gitConflict.js';
import { log } from '../../core/utils/Logger.js';

export type BrainConflict = { kind: 'not-applicable'; malformed?: true } | { kind: 'merged'; text: string };
type Row = { raw: string; section: string; heading: boolean };
type Context = { section: string; foreign: boolean; fence: string };
const lineText = (raw: string) => raw.replace(/\r?\n$/, '');
const opening = (line: string) => /^<<<<<<<(?: |$)/.test(line);
const closing = (line: string) => /^>>>>>>>(?: |$)/.test(line);
const base = (line: string) => /^\|{7}(?: |$)/.test(line);
const fenceStart = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
function fenceEnd(line: string, fence: string): boolean {
    const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return !!match && match[1][0] === fence[0] && match[1].length >= fence.length;
}
function row(raw: string, context: Context): Row {
    const line = lineText(raw);
    let heading = false;
    if (context.fence) {
        if (fenceEnd(line, context.fence)) context.fence = '';
    } else {
        const fence = fenceStart(line);
        if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) context.fence = fence[1];
        else if (/^ {0,3}#{1,2}[ \t]+/.test(line)) {
            context.section = line.trimEnd();
            context.foreign = /^ {0,3}##[ \t]+/.test(line) && !isNaTerazHeading(line.trim()) && sectionKeyOf(line.trim()) === null;
            heading = true;
        }
    }
    return { raw, section: context.section, heading };
}

/** Pure union of conflict lines, scoped to their H1/H2 section. Original lines retain
 * their bytes. Only additions from the other side are deduplicated (trimEnd). */
export function mergeBrainConflict(text: string): BrainConflict {
    if (!text.includes('<<<<<<<')) return { kind: 'not-applicable' };
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const lines = text.slice(bom.length).match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const ours: Row[] = [];
    const hunks: { start: number; end: number; section: string; theirs: Row[] }[] = [];
    const context: Context = { section: '', foreign: false, fence: '' };
    const malformed = (): BrainConflict => ({ kind: 'not-applicable', malformed: true });
    for (let i = 0; i < lines.length; i++) {
        const line = lineText(lines[i]);
        // A complete example inside a closed foreign code fence is opaque user text.
        if (context.foreign && context.fence && opening(line)) {
            let end = i;
            while (end < lines.length && !fenceEnd(lineText(lines[end]), context.fence)) end++;
            const example = lines.slice(i, end).join('');
            if (end === lines.length || !splitGitConflict(example)) return malformed();
            for (; i < end; i++) ours.push(row(lines[i], context));
            ours.push(row(lines[i], context));
            continue;
        }
        if (!opening(line)) {
            if (closing(line) || base(line)) return malformed();
            ours.push(row(lines[i], context));
            continue;
        }
        const start = ours.length;
        const section = context.section;
        const theirContext = { ...context };
        const theirs: Row[] = [];
        let mode: 'ours' | 'base' | 'theirs' = 'ours';
        let complete = false;
        for (i++; i < lines.length; i++) {
            const current = lineText(lines[i]);
            if (opening(current)) return malformed();
            if (base(current)) {
                if (mode !== 'ours') return malformed();
                mode = 'base';
            } else if (current === '=======') {
                if (mode === 'theirs') return malformed();
                mode = 'theirs';
            } else if (closing(current)) {
                if (mode !== 'theirs') return malformed();
                complete = true;
                break;
            } else if (mode === 'ours') ours.push(row(lines[i], context));
            else if (mode === 'theirs') theirs.push(row(lines[i], theirContext));
        }
        if (!complete) return malformed();
        hunks.push({ start, end: ours.length, section, theirs });
    }
    if (!hunks.length) return { kind: 'not-applicable' };
    const seen = new Map<string, Set<string>>();
    const headings = new Set<string>();
    const sectionEnds = new Map<string, number>();
    const remember = (entry: Row) => {
        let bucket = seen.get(entry.section);
        if (!bucket) { bucket = new Set(); seen.set(entry.section, bucket); }
        bucket.add(entry.raw.trimEnd());
        if (entry.heading) headings.add(entry.raw.trimEnd());
    };
    ours.forEach((entry, index) => { remember(entry); if (entry.raw.trim()) sectionEnds.set(entry.section, index + 1); });
    const additions = new Map<number, string[]>();
    for (const hunk of hunks) {
        const localEnds = new Map<string, number>([[hunk.section, hunk.start]]);
        for (let i = hunk.start; i < hunk.end; i++) {
            if (ours[i].raw.trim()) localEnds.set(ours[i].section, i + 1);
        }
        for (const entry of hunk.theirs) {
            const value = entry.raw.trimEnd();
            if (entry.heading ? headings.has(value) : seen.get(entry.section)?.has(value)) continue;
            const anchor = localEnds.get(entry.section) ?? sectionEnds.get(entry.section) ?? hunk.end;
            const bucket = additions.get(anchor) ?? [];
            bucket.push(entry.raw);
            additions.set(anchor, bucket);
            remember(entry);
        }
    }
    const output: string[] = [bom, ...(additions.get(0) ?? [])];
    ours.forEach((entry, index) => { output.push(entry.raw, ...(additions.get(index + 1) ?? [])); });
    return { kind: 'merged', text: output.join('') };
}

/** Shared text boundary. No adapter calls, including on a malformed conflict. */
export function readBrainContent(text: string): string {
    const result = mergeBrainConflict(text);
    if (result.kind === 'merged') return result.text;
    if (result.malformed) log.warn('AgentMemory', 'Brain conflict is incomplete or nested; keeping original text');
    return text;
}

/** Existing index parsers treat every H2 as a section, even inside code. Hide only
 * foreign fences containing complete conflict examples, then restore their bytes. */
export function protectForeignBrainFences(text: string): { text: string; restore: (output: string) => string } {
    let prefix = 'PKM_BRAIN_FENCE_';
    while (text.includes(prefix)) prefix += '_';
    const saved: string[] = [];
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const output: string[] = [];
    const context: Context = { section: '', foreign: false, fence: '' };
    for (let i = 0; i < lines.length; i++) {
        const fence = !context.fence && context.foreign ? fenceStart(lineText(lines[i])) : null;
        if (fence) {
            let end = i + 1;
            while (end < lines.length && !fenceEnd(lineText(lines[end]), fence[1])) end++;
            if (end < lines.length && splitGitConflict(lines.slice(i + 1, end).join(''))) {
                const raw = lines.slice(i, end + 1).join('').replace(/\r?\n$/, '');
                const token = `${prefix}${saved.length}`;
                saved.push(raw);
                output.push(token + '\n');
                i = end;
                continue;
            }
        }
        row(lines[i], context);
        output.push(lines[i]);
    }
    return {
        text: output.join(''),
        restore: output => output.replace(new RegExp(`^${prefix}(\\d+)$`, 'gm'), (whole, index: string) => saved[Number(index)] ?? whole),
    };
}
