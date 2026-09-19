/**
 * Strażnik okablowania na ŹRÓDLE: `SaveSessionModal.ts` ciągnie `obsidian` (Modal), więc AVA
 * go nie zaimportuje wprost (wzór: `modules/shell/ReleaseNotesView.test.ts`). Sam kontrakt
 * `normalizeNaTerazSection`/`naTerazLabel` jest przypięty behawioralnie w
 * `naTerazUpdate.test.ts`; ten plik pilnuje wyłącznie, że modal RZECZYWIŚCIE woła te funkcje
 * zamiast trzymać własną (rozjeżdżającą się) kopię logiki - patrz BUG opisany w
 * `naTerazUpdate.ts`.
 */
import test from 'ava';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./SaveSessionModal.ts', import.meta.url)), 'utf8');

test('importuje normalizeNaTerazSection i naTerazLabel z naTerazUpdate.js', t => {
    t.regex(
        source,
        /import\s*\{\s*naTerazLabel\s*,\s*normalizeNaTerazSection\s*\}\s*from\s*['"]\.\/naTerazUpdate\.js['"]/,
    );
});

test('_normalizeUpdate deleguje "section" do normalizeNaTerazSection - nie ma już fallbacku na nagłówek pliku', t => {
    t.regex(
        source,
        /section:\s*normalizeNaTerazSection\(\s*u\?\.section\s*\)/,
        '_normalizeUpdate musi zapisywać kanoniczny klucz API (user/environment), nie surowy nagłówek brain.md',
    );
    t.notRegex(
        source,
        /## Bieżące/,
        'fallback na nagłówek pliku brain.md ("## Bieżące") powodował cichy drop w applyNaTerazOps - nie ma prawa wrócić',
    );
});

test('render etykiety "Na teraz" woła naTerazLabel(update.section), lokalna metoda _naTerazLabel zniknęła', t => {
    t.regex(source, /naTerazLabel\(update\.section\)/);
    t.notRegex(
        source,
        /_naTerazLabel\s*\(/,
        'modal ma być cienkim wołaczem - własna metoda _naTerazLabel rozjeżdżała się z zapisem',
    );
});
