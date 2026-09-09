/**
 * `InlineCommentModal.ts` i `SendToAgentModal.ts` importują `obsidian`
 * (Modal, Notice), więc AVA nie może ich zaimportować wprost (wzór `turnOwner.test.ts` w
 * modules/chat) - strażnik czyta ŹRÓDŁO. Strażnik pilnuje, żeby oba modale wołały wspólny
 * `truncatePreview` z `modules/ui-components` do obcinania podglądu zaznaczonego tekstu,
 * zamiast duplikować identyczny blok (`text.length > 500 ? slice(0,500)+'...' : text`).
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const files: Array<[name: string, path: string]> = [
    ['InlineCommentModal.ts', './InlineCommentModal.ts'],
    ['SendToAgentModal.ts', './SendToAgentModal.ts'],
];

for (const [name, path] of files) {
    test(`${name}: importuje i woła truncatePreview z modules/ui-components, nie liczy podglądu inline`, t => {
        const src = readSource(path);
        t.regex(src, /import \{ truncatePreview \} from '\.\.\/\.\.\/modules\/ui-components\/index\.js';/,
            `${name} ma importować kanoniczny helper z ui-components`);
        t.regex(src, /truncatePreview\(this\.selectedText\)/,
            `${name} ma wołać truncatePreview(this.selectedText)`);
        t.notRegex(src, /\.selectedText\.length > 500/,
            `${name} nie powinien już liczyć obcięcia inline — to duplikat, który miał zniknąć`);
        t.notRegex(src, /\.slice\(0, 500\) \+ '\.\.\.'/,
            `${name} nie powinien już mieć skopiowanego wyrażenia slice(0,500)+'...'`);
    });
}
