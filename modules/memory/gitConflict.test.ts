import test from 'ava';
import { readFileSync } from 'node:fs';
import { splitGitConflict } from './gitConflict.js';

test('D1: two real conflict blocks reconstruct complete literal JSON sides', t => {
    const raw = readFileSync(new URL('./__fixtures__/state-conflict.txt', import.meta.url), 'utf8');
    t.deepEqual(splitGitConflict(raw), {
        ours: '{\n  "active_sessions": [\n    "jaskier_2026-11-14_14-25.md",\n    "jaskier_2026-11-14_15-01.md"\n  ],\n  "archived_since_last_consolidation": 7,\n  "last_archive_at": "2026-11-14T15:00:00.000Z",\n  "notes_count_at_last_check": 13,\n  "last_used": "jaskier_2026-11-14_14-25.md",\n  "brain_notes_limit": 15\n}\n',
        theirs: '{\n  "active_sessions": [\n    "jaskier_2026-11-14_14-25.md"\n  ],\n  "archived_since_last_consolidation": 8,\n  "last_archive_at": "2026-11-14T15:02:00.000Z",\n  "notes_count_at_last_check": 13,\n  "last_used": "jaskier_2026-11-14_14-25.md",\n  "brain_notes_limit": 15\n}\n',
    });
});

test('D1: diff3 discards base, preserves CRLF, labels and missing final newline', t => {
    t.deepEqual(splitGitConflict('intro\r\n<<<<<<< any label / a\r\nours\r\n||||||| base label\r\nbase\r\n=======\r\ntheirs\r\n>>>>>>> other label\r\nend'), {
        ours: 'intro\r\nours\r\nend', theirs: 'intro\r\ntheirs\r\nend',
    });
});

test('D1: separators outside a block and near-markers are ordinary text', t => {
    t.deepEqual(splitGitConflict('=======\n<<<<<<<< x\n<<<<<<<x\n<<<<<<<\na\n=======\nb\n>>>>>>>\n>>>>>>>x\n|||||||| x\n'), {
        ours: '=======\n<<<<<<<< x\n<<<<<<<x\na\n>>>>>>>x\n|||||||| x\n',
        theirs: '=======\n<<<<<<<< x\n<<<<<<<x\nb\n>>>>>>>x\n|||||||| x\n',
    });
});

for (const [label, raw] of [
    ['no markers', 'ordinary\n=======\ntext'],
    ['unclosed', '<<<<<<< a\none\n=======\ntwo'],
    ['nested', '<<<<<<< a\n<<<<<<< b\nx\n=======\ny\n>>>>>>> b\n=======\nz\n>>>>>>> a'],
    ['no separator', '<<<<<<< a\nx\n>>>>>>> b'],
    ['orphan end', '>>>>>>> b\n<<<<<<< a\nx\n=======\ny\n>>>>>>> b'],
    ['repeated separator', '<<<<<<< a\nx\n=======\ny\n=======\nz\n>>>>>>> b'],
    ['repeated base', '<<<<<<< a\nx\n||||||| b\ny\n||||||| c\nz\n=======\nw\n>>>>>>> d'],
    ['indented start', ' <<<<<<< a\nx\n=======\ny\n>>>>>>> b'],
]) test(`D1: refuses ${label}`, t => { t.is(splitGitConflict(raw), null); });
