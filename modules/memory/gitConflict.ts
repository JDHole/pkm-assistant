/** Shared definition of a conflict trace, including an incomplete opening marker. */
export function isGitConflictStart(line: string): boolean {
    return /^<<<<<<<(?: |$)/.test(line);
}

/** Linear scan without reconstructing sides or allocating an array of all lines. */
export function hasGitConflictStart(text: string): boolean {
    let start = 0;
    while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const end = newline < 0 ? text.length : newline;
        const lineEnd = newline >= 0 && text[end - 1] === '\r' ? end - 1 : end;
        if (isGitConflictStart(text.slice(start, lineEnd))) return true;
        if (newline < 0) break;
        start = newline + 1;
    }
    return false;
}

/** Reconstruct whole sides, preserving every non-marker byte (including CRLF). */
export function splitGitConflict(text: string): { ours: string; theirs: string } | null {
    let section: 'common' | 'ours' | 'base' | 'theirs' = 'common';
    let blocks = 0;
    const ours: string[] = [], theirs: string[] = [];
    for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const line = raw.replace(/\r?\n$/, '');
        if (isGitConflictStart(line)) {
            if (section !== 'common') return null;
            section = 'ours';
        } else if (/^\|{7}(?: |$)/.test(line)) {
            if (section !== 'ours') return null;
            section = 'base';
        } else if (line === '=======' && section !== 'common') {
            if (section !== 'ours' && section !== 'base') return null;
            section = 'theirs';
        } else if (/^>>>>>>>(?: |$)/.test(line)) {
            if (section !== 'theirs') return null;
            section = 'common';
            blocks++;
        } else {
            if (section === 'common' || section === 'ours') ours.push(raw);
            if (section === 'common' || section === 'theirs') theirs.push(raw);
        }
    }
    return section === 'common' && blocks > 0 ? { ours: ours.join(''), theirs: theirs.join('') } : null;
}
