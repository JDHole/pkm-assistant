import { isNaTerazHeading, sectionKeyOf } from './brainSections.js';
import { splitGitConflict } from './gitConflict.js';
import { log } from '../../core/utils/Logger.js';

export type BrainConflict = { kind: 'not-applicable'; malformed?: true } | { kind: 'merged'; text: string };
type Row = { raw: string; section: string; heading: boolean };
type Section = { key: string; rows: Row[]; additions: Row[]; next?: Section };
type Page = { sections: Section[]; last: Map<string, Section>; values: Map<string, Set<string>>; titles: string[] };
type Context = { section: string; foreign: boolean; fence: string };
const lineText = (raw: string) => raw.replace(/\r?\n$/, '');
const fenceStart = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
function fenceEnd(line: string, fence: string): boolean {
    const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return !!match && match[1][0] === fence[0] && match[1].length >= fence.length;
}
function row(raw: string, context: Context, includeH1 = false): Row {
    const line = lineText(raw);
    let heading = false;
    if (context.fence) {
        if (fenceEnd(line, context.fence)) context.fence = '';
    } else {
        const fence = fenceStart(line);
        if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) context.fence = fence[1];
        else if (/^ {0,3}##[ \t]+/.test(line) || (includeH1 && /^ {0,3}#[ \t]+/.test(line))) {
            context.section = line.trimEnd();
            context.foreign = /^ {0,3}##[ \t]+/.test(line) && !isNaTerazHeading(line.trim()) && sectionKeyOf(line.trim()) === null;
            heading = true;
        }
    }
    return { raw, section: context.section, heading };
}

/** Parse each full projection with its own fence context. Repeated H2s share a
 * value set, but retain every occurrence and byte in the ordered section list. */
function page(text: string): Page {
    const sections: Section[] = [{ key: '', rows: [], additions: [] }];
    const last = new Map<string, Section>([['', sections[0]]]);
    const values = new Map<string, Set<string>>([['', new Set()]]);
    const titles: string[] = [];
    const context: Context = { section: '', foreign: false, fence: '' };
    let section = sections[0];
    for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (!context.fence && /^ {0,3}#[ \t]+/.test(raw)) titles.push(raw.trimEnd());
        const entry = row(raw, context);
        if (entry.heading) {
            const next: Section = { key: entry.section, rows: [], additions: [] };
            section.next = next;
            section = next;
            sections.push(section);
            last.set(section.key, section);
            if (!values.has(section.key)) values.set(section.key, new Set());
        }
        section.rows.push(entry);
        if (raw.trimEnd()) values.get(section.key)!.add(raw.trimEnd());
    }
    return { sections, last, values, titles };
}

/** Full-page union: our bytes/order plus missing lines in the same H2 and whole
 * sections unique to theirs. A deletion on one side never deletes the other. */
export function mergeBrainConflict(text: string): BrainConflict {
    if (!text.includes('<<<<<<<')) return { kind: 'not-applicable' };
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const protectedText = protectForeignBrainFences(text.slice(bom.length), true);
    const malformed = (): BrainConflict => ({ kind: 'not-applicable', malformed: true });
    const sides = splitGitConflict(protectedText.text);
    if (!sides) {
        return /^(?:<<<<<<<|>>>>>>>|\|{7})(?: |\r?$)/m.test(protectedText.text)
            ? malformed() : { kind: 'not-applicable' };
    }
    const ours = page(sides.ours);
    const theirs = page(sides.theirs);
    if (ours.titles.length !== theirs.titles.length || ours.titles.some((title, i) => title !== theirs.titles[i])) return malformed();

    let tail = ours.sections[ours.sections.length - 1];
    let previous = '';
    for (const section of theirs.sections) {
        if (ours.values.has(section.key)) {
            const target = ours.last.get(section.key)!;
            const seen = ours.values.get(section.key)!;
            for (const entry of section.rows) {
                const value = entry.raw.trimEnd();
                if (!value || seen.has(value)) continue;
                target.additions.push(entry);
                seen.add(value);
            }
        } else {
            // Insert whole occurrences, including whitespace and repetitions.
            // Linked sections avoid rescanning/splicing the growing result.
            const after = ours.last.get(previous) ?? tail;
            const inserted: Section = { key: section.key, rows: section.rows, additions: [], next: after.next };
            after.next = inserted;
            if (tail === after) tail = inserted;
            ours.last.set(section.key, inserted);
        }
        previous = section.key;
    }

    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const output: string[] = [];
    const emit = (raw: string) => {
        if (output.length && !output[output.length - 1].endsWith('\n')) output.push(newline);
        output.push(raw);
    };
    for (let section: Section | undefined = ours.sections[0]; section; section = section.next) {
        let end = section.rows.length;
        while (end && !section.rows[end - 1].raw.trimEnd()) end--;
        for (let i = 0; i < end; i++) emit(section.rows[i].raw);
        for (const entry of section.additions) emit(entry.raw);
        for (let i = end; i < section.rows.length; i++) emit(section.rows[i].raw);
    }
    const merged = output.join('');
    // Check the emitted bytes against BOTH complete projections, including common
    // continuations whose H2 ownership differs between sides. Restore opaque code
    // before checking membership; only its original protected markers are allowed.
    if (/^(?:<<<<<<<(?: |\r?$)|>>>>>>>(?: |\r?$)|\|{7}(?: |\r?$)|=======\r?$)/m.test(merged)) return malformed();
    const restored = protectedText.restore(merged);
    const checkedMarkers = protectForeignBrainFences(restored, true).text;
    if (/^(?:<<<<<<<(?: |\r?$)|>>>>>>>(?: |\r?$)|\|{7}(?: |\r?$)|=======\r?$)/m.test(checkedMarkers)) return malformed();
    const actual = page(restored).values;
    for (const source of [sides.ours, sides.theirs]) {
        for (const [key, values] of page(protectedText.restore(source)).values) {
            for (const value of values) if (!actual.get(key)?.has(value)) return malformed();
        }
    }
    return { kind: 'merged', text: bom + restored };
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
export function protectForeignBrainFences(text: string, preserveEol = false): { text: string; restore: (output: string) => string } {
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
                output.push(token + (preserveEol ? /\r?\n$/.exec(lines[end])?.[0] ?? '' : '\n'));
                i = end;
                continue;
            }
        }
        row(lines[i], context, true);
        output.push(lines[i]);
    }
    return {
        text: output.join(''),
        restore: output => output.replace(new RegExp(`^${prefix}(\\d+)(?=\\r?$)`, 'gm'), (whole, index: string) => saved[Number(index)] ?? whole),
    };
}
