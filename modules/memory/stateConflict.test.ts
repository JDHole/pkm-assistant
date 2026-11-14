import test from 'ava';
import { readFileSync } from 'node:fs';
import { splitGitConflict } from './gitConflict.js';
import { mergeStateConflict } from './stateConflict.js';

for (const keepSecond of [false, true]) test(`D1: real state merge, second active file exists=${keepSecond}`, t => {
    const sides = splitGitConflict(readFileSync(new URL('./__fixtures__/state-conflict.txt', import.meta.url), 'utf8'))!;
    const files = keepSecond ? ['jaskier_2026-11-14_14-25.md', 'jaskier_2026-11-14_15-01.md'] : ['jaskier_2026-11-14_14-25.md'];
    t.deepEqual(mergeStateConflict(sides.ours, sides.theirs, files), {
        active_sessions: keepSecond ? ['jaskier_2026-11-14_14-25.md', 'jaskier_2026-11-14_15-01.md'] : ['jaskier_2026-11-14_14-25.md'],
        archived_since_last_consolidation: 8, last_archive_at: '2026-11-14T15:02:00.000Z',
        notes_count_at_last_check: 13, last_used: 'jaskier_2026-11-14_14-25.md', brain_notes_limit: 15,
    });
});

test('D1: ordered union without listing, ignores non-string session entries', t => {
    t.deepEqual(mergeStateConflict('{"active_sessions":["b.md","a.md","b.md",3]}', '{"active_sessions":["a.md","c.md"]}'), {
        active_sessions: ['b.md', 'a.md', 'c.md'], archived_since_last_consolidation: 0, last_archive_at: null, last_used: 'c.md',
    });
});

for (const [ours, theirs, expected] of [[7, 8, 8], [9, 2, 9], ['99', 4, 4], [5, null, 5], [null, '8', 0], [-2, -1, -1]] as const) {
    test(`D1: archive counter ${ours}/${theirs}`, t => {
        t.is(mergeStateConflict(JSON.stringify({ archived_since_last_consolidation: ours }), JSON.stringify({ archived_since_last_consolidation: theirs }))?.archived_since_last_consolidation, expected);
    });
}

for (const [ours, theirs, expected] of [
    ['2026-11-14T15:00:00Z', '2026-11-14T15:02:00Z', '2026-11-14T15:02:00Z'],
    ['2026-11-14T15:00:00Z', '2026-11-14T16:00:00+02:00', '2026-11-14T15:00:00Z'],
    ['bad', '2026-11-14T15:00:00Z', '2026-11-14T15:00:00Z'],
    ['2026-11-14T15:00:00Z', null, '2026-11-14T15:00:00Z'],
    ['bad', 'worse', null],
]) test(`D1: archive date ${ours}/${theirs}`, t => {
    t.is(mergeStateConflict(JSON.stringify({ last_archive_at: ours }), JSON.stringify({ last_archive_at: theirs }))?.last_archive_at, expected);
});

for (const [ours, theirs, existing, expected] of [
    ['a.md', 'b.md', ['a.md', 'b.md', 'c.md'], 'a.md'],
    ['gone.md', 'a.md', ['a.md', 'b.md', 'c.md'], 'a.md'],
    ['a.md', 'b.md', ['c.md'], 'c.md'],
    ['a.md', 'b.md', [], null],
] as const) test(`D1: last_used ${ours}/${theirs}, files=${existing.join(',')}`, t => {
    t.is(mergeStateConflict(JSON.stringify({ active_sessions: ['a.md', 'b.md', 'c.md'], last_used: ours }), JSON.stringify({ last_used: theirs }), existing)?.last_used, expected);
});

test('D1: user limit never decreases, unknown keys from either side survive including null and __proto__', t => {
    t.deepEqual(mergeStateConflict('{"brain_notes_limit":15,"ours_only":false,"shared":null,"__proto__":{"keep":1}}', '{"brain_notes_limit":20,"theirs_only":{"x":3},"shared":"other"}'), {
        active_sessions: [], archived_since_last_consolidation: 0, last_archive_at: null, last_used: null,
        brain_notes_limit: 20, ours_only: false, theirs_only: { x: 3 }, shared: null, ['__proto__']: { keep: 1 },
    });
    t.is(mergeStateConflict('{"brain_notes_limit":30}', '{"brain_notes_limit":"99"}')?.brain_notes_limit, 30);
    t.is(mergeStateConflict('{"brain_notes_limit":null}', '{}')?.brain_notes_limit, null);
});

for (const invalid of ['{broken', '[]', 'null', '7', '"text"']) test(`D1: both sides must be JSON objects: ${invalid}`, t => {
    t.is(mergeStateConflict(invalid, '{}'), null);
    t.is(mergeStateConflict('{}', invalid), null);
});
