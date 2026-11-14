/** Reconstruct whole sides, preserving every non-marker byte (including CRLF). */
export function splitGitConflict(text: string): { ours: string; theirs: string } | null {
    let section: 'common' | 'ours' | 'base' | 'theirs' = 'common';
    let blocks = 0;
    const ours: string[] = [], theirs: string[] = [];
    for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const line = raw.replace(/\r?\n$/, '');
        if (/^<<<<<<<(?: |$)/.test(line)) {
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
