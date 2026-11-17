import test from 'ava';
import { scanMarkdownFences } from './markdownFences.js';

test('fences preserve source positions, bodies and ambiguous containers', t => {
    t.like(scanMarkdownFences('---\na: 1\n---\n> ```dataviewjs\n> return 1;\n> ```'), [{ language: 'dataviewjs', line: 4, column: 3, body: 'return 1;', columns: [2], unclosed: false, skipped: false }]);
    t.like(scanMarkdownFences('> ```dataviewjs\nreturn 1;\n> ```'), [{ skipped: true, line: 1 }]);
    t.deepEqual(scanMarkdownFences('<!--\n```js\nx\n```\n-->'), []);
});
