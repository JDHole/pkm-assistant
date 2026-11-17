export type MarkdownFence = { language: string; line: number; column: number; body: string; columns: number[]; unclosed: boolean; skipped?: boolean };

/** Shared Markdown fence scan, preserving source positions for syntax diagnostics. */
export function scanMarkdownFences(text: string): MarkdownFence[] {
    const lines = text.split(/\r?\n/);
    let start = 0;
    if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
        if (end >= 0) start = end + 1;
    }
    const blocks: MarkdownFence[] = [];
    let listIndent = 0, inComment = false;
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (inComment) { if (line.includes('-->')) inComment = false; continue; }
        const comment = line.indexOf('<!--');
        if (comment >= 0) { if (!line.slice(comment + 4).includes('-->')) inComment = true; continue; }
        const list = /^( *)(?:(?:> ?)+)?(?:[-+*]|\d+[.)]) +/.exec(line);
        if (list) listIndent = list[0].length;
        else if (/^\S/.test(line) && !line.startsWith('>')) listIndent = 0;
        const fenceMatch = /^( *)(?:(> ?)+)?((?:[-+*]|\d+[.)]) +)?( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
        if (!fenceMatch) {
            // A container shape outside the confidently supported grammar is still
            // a source block, but must never be reported as checked.
            const uncertain = /^([ \t>]+)(`{3,}|~{3,})(.*)$/.exec(line);
            if (uncertain && (uncertain[1].includes('>') || (listIndent > 0 && uncertain[1].length >= listIndent))) {
                const marker = uncertain[2];
                let end = i + 1;
                const close = new RegExp(`^[ \t>]*${marker[0]}{${marker.length},}\\s*$`);
                while (end < lines.length && !close.test(lines[end])) end++;
                blocks.push({ language: uncertain[3].trim().toLowerCase(), line: i + 1, column: uncertain[1].length + 1, body: '', columns: [], unclosed: end === lines.length, skipped: true });
                i = end;
            }
            continue;
        }
        const leading = fenceMatch[1].length;
        if (leading >= 4 && (!listIndent || leading < listIndent)) continue;
        const fence = fenceMatch[5];
        const prefix = line.slice(0, line.indexOf(fence));
        const quoteCount = (prefix.match(/>/g) ?? []).length;
        const indent = leading;
        const markerWidth = fenceMatch[3]?.length ?? 0;
        let end = i + 1, skipped = /\t/.test(prefix);
        const body: string[] = [], columns: number[] = [];
        while (end < lines.length) {
            const current = lines[end];
            let cut = 0;
            if (current.trim()) {
                while (cut < indent && current[cut] === ' ') cut++;
                if (cut < indent || current.includes('\t')) skipped = true;
                for (let q = 0; q < quoteCount; q++) {
                    const part = /^ {0,3}> ?/.exec(current.slice(cut));
                    if (!part) { skipped = true; break; }
                    cut += part[0].length;
                }
            }
            if (markerWidth && current.trim()) {
                let n = 0; while (n < markerWidth && current[cut] === ' ') { cut++; n++; }
                if (n < markerWidth) skipped = true;
            }
            const rest = current.slice(cut);
            if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(rest)) break;
            body.push(rest); columns.push(cut); end++;
        }
        blocks.push({ language: fenceMatch[6].trim().toLowerCase(), line: i + 1, column: prefix.length + 1, body: body.join('\n'), columns, unclosed: end === lines.length, skipped });
        i = end;
    }
    return blocks;
}

