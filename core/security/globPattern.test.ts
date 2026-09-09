import test from 'ava';
import { globPatternToRegex } from './globPattern.js';

// Test równoważności: helper musi produkować DOKŁADNIE ten sam regex (co do wyniku `.test()`)
// jak ten inline łańcuch `.replace()` — referencyjna implementacja, z którą porównujemy wynik.
function legacyGlobToRegex(pattern: string): RegExp {
    const regexStr = pattern
        .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DOUBLESTAR>>>/g, '.*')
        .replace(/\//g, '\\/');
    return new RegExp(`^${regexStr}$`);
}

const CASES: Array<[pattern: string, path: string]> = [
    ['Projects/**', 'Projects/sub/file.md'],
    ['Projects/**', 'Projects/file.md'],
    ['Projects/**', 'Other/file.md'],
    ['Projects/*', 'Projects/file.md'],
    ['Projects/*', 'Projects/sub/file.md'],
    ['Notes/todo.md', 'Notes/todo.md'],
    ['Notes/todo.md', 'Notes/todo2.md'],
    ['*.md', 'file.md'],
    ['*.md', 'sub/file.md'],
    ['a.b.c*', 'a.b.cd'],
];

test('globPatternToRegex jest zgodny wynikowo ze starym inline łańcuchem .replace() (AccessGuard)', t => {
    for (const [pattern, path] of CASES) {
        const got = globPatternToRegex(pattern).test(path);
        const legacy = legacyGlobToRegex(pattern).test(path);
        t.is(got, legacy, `rozjazd dla pattern=${pattern} path=${path}`);
    }
});

test('globPatternToRegex: ** dopasowuje dowolną głębokość, * tylko jeden poziom', t => {
    t.true(globPatternToRegex('Projects/**').test('Projects/a/b/c.md'));
    t.true(globPatternToRegex('Projects/*').test('Projects/c.md'));
    t.false(globPatternToRegex('Projects/*').test('Projects/a/c.md'));
});
