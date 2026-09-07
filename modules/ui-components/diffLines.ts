/**
 * diffLines — pure line-diff engine for DiffModal, extracted so it can be unit-tested.
 *
 * `DiffModal.ts` extends Obsidian's `Modal`, which the `obsidian` package only ships as
 * type declarations (no runtime JS) — files importing `obsidian` cannot be loaded by AVA
 * (same reason `chat_streaming.ts` etc. have no direct tests, see their CLAUDE.md gotchas).
 * This file has zero `obsidian` import, so the diff algorithm itself — the part that had the
 * actual bugs (AUD-wydajnosc-102/103) — gets real tests instead of a copy-pasted repro script.
 */

export type DiffOp = { type: 'equal' | 'add' | 'remove'; text: string };

/**
 * Line-level diff. Full LCS for reasonably small files; falls back to a simple positional
 * comparison above the `m * n > 500000` cell budget (unchanged from the original algorithm).
 */
export function computeLineDiff(oldContent: string, newContent: string): DiffOp[] {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const m = oldLines.length;
    const n = newLines.length;

    if (m * n > 500000) {
        return _simpleDiff(oldLines, newLines);
    }

    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const result: DiffOp[] = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            result.push({ type: 'equal', text: oldLines[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.push({ type: 'add', text: newLines[j - 1] });
            j--;
        } else {
            result.push({ type: 'remove', text: oldLines[i - 1] });
            i--;
        }
    }

    return result.reverse();
}

function _simpleDiff(oldLines: string[], newLines: string[]): DiffOp[] {
    const ops: DiffOp[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
        const oldLine = i < oldLines.length ? oldLines[i] : null;
        const newLine = i < newLines.length ? newLines[i] : null;
        if (oldLine === newLine) {
            ops.push({ type: 'equal', text: oldLine as string });
        } else {
            if (oldLine !== null) ops.push({ type: 'remove', text: oldLine });
            if (newLine !== null) ops.push({ type: 'add', text: newLine });
        }
    }
    return ops;
}

/** AUD-wydajnosc-103: read once, used by both stats and rendering. */
export function computeDiffStats(ops: DiffOp[]): { added: number; removed: number } {
    let added = 0, removed = 0;
    for (const op of ops) {
        if (op.type === 'add') added++;
        else if (op.type === 'remove') removed++;
    }
    return { added, removed };
}

export type DiffSegment =
    | { kind: 'line'; op: DiffOp }
    | { kind: 'collapsed'; count: number };

/**
 * AUD-wydajnosc-102: DiffModal used to build one DOM row per line of the diff, INCLUDING every
 * unchanged ('equal') line — opening the modal on a barely-touched multi-thousand-line note
 * built thousands of rows for a one-line edit. This picks which ops actually need a row:
 * every changed line plus `context` lines of unchanged text around it. Long unchanged runs
 * collapse into a single `{kind:'collapsed', count}` placeholder — nothing about a CHANGE is
 * ever hidden, only the surrounding noise.
 */
export function selectVisibleDiffLines(ops: DiffOp[], context = 3): DiffSegment[] {
    const keep = new Array(ops.length).fill(false);
    for (let idx = 0; idx < ops.length; idx++) {
        if (ops[idx].type !== 'equal') {
            const from = Math.max(0, idx - context);
            const to = Math.min(ops.length - 1, idx + context);
            for (let k = from; k <= to; k++) keep[k] = true;
        }
    }

    const segments: DiffSegment[] = [];
    let i = 0;
    while (i < ops.length) {
        if (keep[i]) {
            segments.push({ kind: 'line', op: ops[i] });
            i++;
            continue;
        }
        let j = i;
        while (j < ops.length && !keep[j]) j++;
        segments.push({ kind: 'collapsed', count: j - i });
        i = j;
    }
    return segments;
}
