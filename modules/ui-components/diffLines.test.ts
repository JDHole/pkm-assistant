/**
 * diffLines — AUD-wydajnosc-102 + AUD-wydajnosc-103.
 *
 * 102: `DiffModal._renderDiff` built one DOM row for EVERY line of a diff, including every
 * unchanged ('equal') line — a one-line edit in a multi-thousand-line note built thousands of
 * rows, almost all of them noise. `selectVisibleDiffLines` now keeps only changed lines plus a
 * small context window, collapsing long unchanged runs into a single placeholder segment.
 *
 * 103: `onOpen` called `_computeLineDiff()` twice (once for stats, once for render) — same full
 * LCS DP table computed twice for one modal open. `DiffModal.onOpen` now computes `ops` once
 * and passes it to both `computeDiffStats` and `_renderDiff`/`selectVisibleDiffLines` — this
 * file's `computeDiffStats`/`computeLineDiff` are exactly the functions it calls, so testing
 * them here proves the shared computation is correct, and `DiffModal.ts`'s single call site
 * (grepped below) proves it isn't computed twice.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { computeLineDiff, computeDiffStats, selectVisibleDiffLines } from './diffLines.js';

test('computeLineDiff: identical content is all "equal"', t => {
    const ops = computeLineDiff('a\nb\nc', 'a\nb\nc');
    t.deepEqual(ops.map(o => o.type), ['equal', 'equal', 'equal']);
});

test('computeLineDiff: single-line edit in the middle produces remove+add around unchanged context', t => {
    const oldContent = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const newContent = oldContent.replace('line5', 'line5-CHANGED');
    const ops = computeLineDiff(oldContent, newContent);
    t.true(ops.some(o => o.type === 'remove' && o.text === 'line5'));
    t.true(ops.some(o => o.type === 'add' && o.text === 'line5-CHANGED'));
    // everything else stayed 'equal'
    const changed = ops.filter(o => o.type !== 'equal');
    t.is(changed.length, 2);
});

test('computeLineDiff: falls back to positional diff above the m*n cell budget', t => {
    // m*n > 500000 forces _simpleDiff — same public contract, different algorithm internally.
    const oldContent = Array.from({ length: 800 }, (_, i) => `l${i}`).join('\n');
    const newContent = Array.from({ length: 800 }, (_, i) => (i === 400 ? 'CHANGED' : `l${i}`)).join('\n');
    const ops = computeLineDiff(oldContent, newContent);
    t.true(ops.some(o => o.type === 'remove' && o.text === 'l400'));
    t.true(ops.some(o => o.type === 'add' && o.text === 'CHANGED'));
});

test('computeDiffStats: counts add/remove, ignores equal', t => {
    const ops = computeLineDiff('a\nb\nc', 'a\nx\nc\nd');
    const stats = computeDiffStats(ops);
    t.true(stats.removed >= 1);
    t.true(stats.added >= 1);
});

test('selectVisibleDiffLines (AUD-wydajnosc-102): a single change in a long file keeps only context, collapses the rest', t => {
    const oldContent = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n');
    const newContent = oldContent.replace('line500', 'line500-CHANGED');
    const ops = computeLineDiff(oldContent, newContent);
    t.is(ops.length, 1001, 'sanity: diff itself still covers every line (1000 + 1 extra add)');

    const segments = selectVisibleDiffLines(ops, 3);
    const lineSegments = segments.filter(s => s.kind === 'line');
    const collapsedSegments = segments.filter(s => s.kind === 'collapsed');

    // context window (3 before + the changed run + 3 after) is tiny compared to 1000 lines
    t.true(lineSegments.length < 20, `oczekiwano garstki wierszy w oknie kontekstu, dostałem ${lineSegments.length}`);
    t.true(collapsedSegments.length >= 1, 'musi być co najmniej jeden placeholder na resztę pliku');

    // nothing about the CHANGE itself is lost
    const keptOps = lineSegments.map(s => (s as { kind: 'line'; op: { type: string; text: string } }).op);
    t.true(keptOps.some(o => o.type === 'remove' && o.text === 'line500'));
    t.true(keptOps.some(o => o.type === 'add' && o.text === 'line500-CHANGED'));

    // total hidden count matches: everything not in a line segment is accounted for
    const totalHidden = collapsedSegments.reduce((sum, s) => sum + (s as { kind: 'collapsed'; count: number }).count, 0);
    t.is(lineSegments.length + totalHidden, ops.length);
});

test('selectVisibleDiffLines: identical content (all equal) collapses to ONE placeholder covering everything', t => {
    const ops = computeLineDiff('a\nb\nc\nd\ne', 'a\nb\nc\nd\ne');
    const segments = selectVisibleDiffLines(ops, 3);
    t.is(segments.length, 1);
    t.is(segments[0].kind, 'collapsed');
    t.is((segments[0] as { kind: 'collapsed'; count: number }).count, ops.length);
});

test('selectVisibleDiffLines: short diffs (everything within context) render every line, zero placeholders', t => {
    const ops = computeLineDiff('a\nb\nc', 'a\nX\nc');
    const segments = selectVisibleDiffLines(ops, 3);
    t.false(segments.some(s => s.kind === 'collapsed'), 'diff krótszy niż okno kontekstu nie potrzebuje zwijania');
    t.is(segments.filter(s => s.kind === 'line').length, ops.length);
});

test('selectVisibleDiffLines: two separate changes far apart keep TWO separate context windows plus a gap placeholder', t => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    const oldContent = lines.join('\n');
    lines[10] = 'line10-A';
    lines[150] = 'line150-B';
    const newContent = lines.join('\n');
    const ops = computeLineDiff(oldContent, newContent);
    const segments = selectVisibleDiffLines(ops, 3);
    const collapsed = segments.filter(s => s.kind === 'collapsed');
    // before the first change, between the two changes, and after the second — three gaps
    t.is(collapsed.length, 3);
});

// AUD-wydajnosc-103: the diff must be computed exactly ONCE per modal open. DiffModal.ts is a
// Modal subclass (imports 'obsidian', which ships type-only — no runtime JS — so AVA cannot
// load it directly, same reason chat_streaming.ts etc. have no direct tests). Read the source
// instead and pin the wiring: onOpen calls computeLineDiff() exactly once, and its result is
// threaded into computeDiffStats() and _renderDiff() rather than either recomputing it.
test('DiffModal.onOpen wiring: computeLineDiff() is called exactly once and its result is shared', t => {
    const source = readFileSync(fileURLToPath(new URL('./DiffModal.ts', import.meta.url)), 'utf8');
    const onOpenMatch = /onOpen\(\)\s*\{[\s\S]*?\n {4}\}/.exec(source);
    t.truthy(onOpenMatch, 'nie znalazłem metody onOpen w DiffModal.ts');
    const onOpenBody = onOpenMatch![0];

    const computeLineDiffCalls = onOpenBody.match(/computeLineDiff\(/g) || [];
    t.is(computeLineDiffCalls.length, 1, 'onOpen musi liczyć diff RAZ, nie raz na stats i raz na render');

    t.regex(onOpenBody, /const ops = computeLineDiff\(/, 'wynik musi być przechowany w zmiennej');
    t.regex(onOpenBody, /computeDiffStats\(ops\)/, 'computeDiffStats musi dostać już policzone ops');
    t.regex(onOpenBody, /_renderDiff\(diffBody, ops\)/, '_renderDiff musi dostać już policzone ops');
});

// Review fix (2026-09-02): oldContent !== newContent as STRINGS doesn't guarantee any single
// line actually differs after split('\n') — without a dedicated notice, the modal showed nothing
// but a single "⋯ N unchanged lines ⋯" placeholder: an approval screen with no visible change to
// approve. `stats.added === 0 && stats.removed === 0` is the trigger; `computeDiffStats` already
// proves that case returns all-zero for identical content.
test('computeDiffStats: identical content is {added:0, removed:0} — the trigger for the "no changes" notice', t => {
    const ops = computeLineDiff('a\nb\nc', 'a\nb\nc');
    t.deepEqual(computeDiffStats(ops), { added: 0, removed: 0 });
});

test('DiffModal.onOpen wiring: an all-zero diff renders a dedicated "no changes" notice, not just the collapsed placeholder', t => {
    const source = readFileSync(fileURLToPath(new URL('./DiffModal.ts', import.meta.url)), 'utf8');

    t.regex(source, /stats\.added === 0 && stats\.removed === 0/, 'onOpen must special-case the no-op diff');
    t.regex(source, /this\._renderNoChanges\(diffBody\)/, 'must call a dedicated no-changes renderer instead of _renderDiff for that case');

    const rendererMatch = /_renderNoChanges\(container: ModalDynamic\) \{[\s\S]*?\n {4}\}/.exec(source);
    t.truthy(rendererMatch, 'nie znalazłem metody _renderNoChanges w DiffModal.ts');
    t.regex(rendererMatch![0], /t\('modal\.diff\.no_changes'\)/, 'musi użyć nowego klucza i18n modal.diff.no_changes');
});
