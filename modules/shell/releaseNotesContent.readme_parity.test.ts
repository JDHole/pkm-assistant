/**
 * Kontrakt: "notka autora w pluginie = notka autora w README.md". `withAuthorNote()`
 * (`releaseNotesContent.ts`) niesie treść EN jako literał w `core/i18n/en.ts` - ta sama treść
 * (verbatim z README.md, commit 450c3641) ma być NADAL w README, żeby dwa niezależne miejsca
 * (plugin i strona repo, którą widzi user na GitHubie) nie rozjechały się przy przyszłej
 * edycji jednego z nich. To NIE jest test samoodnoszący: `en['release_notes.author_note']` i
 * `README.md` to dwa osobne pliki - test czyta oba i porównuje, nie wyprowadza jednego z
 * drugiego. Wzór odczytu pliku repo z dysku: `core/vocabulary_guard.test.ts`.
 */
import test from 'ava';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { en } from '../../core/i18n/en.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('README.md zawiera dosłownie release_notes.author_note (en)', t => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const note = en['release_notes.author_note'];

    t.truthy(note, 'core/i18n/en.ts musi mieć klucz release_notes.author_note');
    t.true(
        readme.includes(note),
        'README.md nie zawiera dosłownie treści release_notes.author_note (en) - '
        + 'notka w pluginie i notka w README rozjechały się',
    );
});
