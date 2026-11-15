import { isBrainSectionHeading, parseNaTerazSections, parseManualIndexLines, parseForeignSections } from './BrainIndex.js';
import { isGitConflictStart, splitGitConflict } from './gitConflict.js';
import { log } from '../../core/utils/Logger.js';

export type BrainConflict = { kind: 'not-applicable'; malformed?: true } | { kind: 'merged'; text: string };
type Row = { raw: string; section: string; heading: boolean };
type Section = { key: string; rows: Row[]; additions: Row[]; next?: Section };
type Page = { sections: Section[]; last: Map<string, Section>; values: Map<string, Set<string>>; titles: string[] };
/** Use the rebuild parsers' H2 boundary. Repeated H2s share a
 * value set, but retain every occurrence and byte in the ordered section list. */
function page(text: string): Page {
    const sections: Section[] = [{ key: '', rows: [], additions: [] }];
    const last = new Map<string, Section>([['', sections[0]]]);
    const values = new Map<string, Set<string>>([['', new Set()]]);
    const titles: string[] = [];
    let section = sections[0];
    for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (/^ {0,3}#[ \t]+/.test(raw)) titles.push(raw.trimEnd());
        const heading = isBrainSectionHeading(raw);
        const entry: Row = { raw, section: heading ? raw.trimEnd() : section.key, heading };
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
    const source = text.slice(bom.length);
    if (hasConflictAndFence(source)) return { kind: 'not-applicable' };
    const malformed = (): BrainConflict => ({ kind: 'not-applicable', malformed: true });
    const sides = splitGitConflict(source);
    if (!sides) {
        return /^(?:<<<<<<<|>>>>>>>|\|{7})(?: |\r?$)/m.test(source)
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
    // First invariant: every section/row pair from both complete projections.
    if (/^(?:<<<<<<<(?: |\r?$)|>>>>>>>(?: |\r?$)|\|{7}(?: |\r?$)|=======\r?$)/m.test(merged)) return malformed();
    const actual = page(merged).values;
    for (const source of [sides.ours, sides.theirs]) {
        for (const [key, values] of page(source).values) {
            for (const value of values) if (!actual.get(key)?.has(value)) return malformed();
        }
    }
    // Second invariant: what the real rebuild parsers retain, independently of page().
    const retained = rebuildElements(merged);
    for (const source of [sides.ours, sides.theirs]) {
        for (const [key, values] of rebuildElements(source)) {
            if (!retained.has(key)) return malformed();
            for (const value of values) if (!retained.get(key)!.has(value)) return malformed();
        }
    }
    return { kind: 'merged', text: bom + merged };
}

/** Shared text boundary. No adapter calls, including on a malformed conflict. */
export function readBrainContent(text: string): string {
    const result = mergeBrainConflict(text);
    if (result.kind === 'merged') return result.text;
    if (result.malformed) log.warn('AgentMemory', 'Brain conflict is incomplete or nested; keeping original text');
    return text;
}

/** One scan, no matching/closing fences or Markdown context. */
function hasConflictAndFence(text: string): boolean {
    let opening = false;
    let fence = false;
    let start = 0;
    while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const end = newline < 0 ? text.length : newline;
        const line = text.slice(start, end).replace(/\r$/, '');
        opening ||= isGitConflictStart(line);
        fence ||= /^ {0,3}(?:`{3,}|~{3,})/.test(line);
        if (opening && fence) return true;
        start = end + 1;
    }
    return false;
}

/** No I/O and no new retention policy. Plain rebuild does NOT cap Na teraz;
 * only writeNaTeraz's explicit mutation applies the ten-entry limit. */
function rebuildElements(text: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const bucket = (key: string) => {
        let values = out.get(key);
        if (!values) { values = new Set<string>(); out.set(key, values); }
        return values;
    };
    for (const [key, entries] of Object.entries(parseNaTerazSections(text))) {
        const values = bucket(`now:${key}`);
        for (const entry of entries) values.add(entry.toLowerCase());
    }
    for (const [key, lines] of parseManualIndexLines(text)) {
        const values = bucket(`manual:${key}`);
        for (const line of lines) values.add(line.trimEnd());
    }
    for (const section of parseForeignSections(text)) {
        // Keep the heading even for an empty section, without copying a potentially
        // long heading into a composite string for every body row.
        const values = bucket(`foreign:${section.heading}`);
        for (const line of section.lines) if (line.trimEnd()) values.add(line.trimEnd());
    }
    return out;
}
