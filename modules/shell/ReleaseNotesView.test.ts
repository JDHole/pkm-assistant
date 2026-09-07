/**
 * `ReleaseNotesView.ts` importuje `obsidian`, więc AVA go nie zaimportuje wprost — testy
 * czytają ŹRÓDŁO regexem (wzór: `modules/chat/OpenSessionModal.css_coverage.test.ts`,
 * `modules/chat/chat/stopSemantics.test.ts`). Luka katalogu: „ZERO testów jednostkowych na
 * samą klasę widoku".
 *
 * clean-room / F1 (build-release) — napisany przed implementacją (czerwony na stubie),
 * dziś zielony.
 */
import test from 'ava';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sourceExists = (rel: string) => existsSync(fileURLToPath(new URL(rel, import.meta.url)));

const viewSource = readSource('./ReleaseNotesView.ts');
// `open()` NIE jest nadpisywane w ReleaseNotesView (decyzja A4) — guard na leaf==null zyje
// w bazie wspolnej WSZYSTKICH widokow (`modules/ui-components/PluginItemView.ts`, wlasnosc
// klastra core-env/F2). Ten plik go tylko CZYTA, zeby przypiac zachowanie B40/BR-4, ktore
// dotyczy praktycznie tego widoku.
const baseViewSource = readSource('../ui-components/PluginItemView.ts');

test('viewType to pkm-release-notes-view', t => {
    t.regex(viewSource, /viewType\s*[=:].*['"]pkm-release-notes-view['"]/);
});

test('tresc widoku pochodzi z releases/latest_release.md', t => {
    t.regex(
        viewSource,
        /import\s+\w+\s+from\s+['"][^'"]*releases\/latest_release\.md['"]\s+with\s*\{\s*type:\s*['"]markdown['"]\s*\}/,
        'brak importu markdownu z atrybutem { type: "markdown" } wskazujacego releases/latest_release.md',
    );

    // Domkniecie luki katalogu: brak pliku = blad BUILDA, nie runtime. Plik MUSI istniec na
    // dysku, inaczej import statyczny wysadzi build w chwili, gdy ktos go najmniej sie spodziewa.
    t.true(sourceExists('../../releases/latest_release.md'), 'releases/latest_release.md nie istnieje');
    const notes = readSource('../../releases/latest_release.md');
    t.true(notes.trim().length > 0, 'releases/latest_release.md jest puste');
});

test('open() ma guard na null leaf (BR-4)', t => {
    // `open` NIE jest nadpisywane w ReleaseNotesView.ts.
    t.notRegex(viewSource, /static\s+(?:async\s+)?open\s*\(\s*_?workspace/, 'ReleaseNotesView nie ma prawa przedefiniowac open()');

    // Guard mieszka w bazie: `getLeaf(...)` sprawdzone na falszywosc, z wczesniejszym `return`
    // PRZED uzyciem leafa. Napisany przed implementacja (czerwony na stubie) — baza
    // (`PluginItemView.ts`) ma dzis realny guard, test zielony.
    t.regex(
        baseViewSource,
        /getLeaf\([^)]*\)/,
        'baza widokow (PluginItemView.open) musi wolac workspace.getLeaf(...)',
    );
    t.regex(
        baseViewSource,
        /if\s*\(\s*!\s*leaf\s*\)[\s\S]{0,40}return/,
        'brak jawnego guardu "if (!leaf) return" wokol wyniku getLeaf(...)',
    );
});

test('openForVersion deleguje do open ze stanem { version }', t => {
    t.regex(viewSource, /static\s+(?:async\s+)?openForVersion\s*\(/);

    // Statyka `open` NIE jest przedeklarowana z drugim argumentem typowanym jako string —
    // jedna sygnatura open(workspace, state?, active?) w calym repo (decyzja A4).
    t.notRegex(
        viewSource,
        /static\s+(?:async\s+)?open\s*\([^)]*version\s*:\s*string/,
        'open nie moze byc zawezone do drugiego argumentu "version: string"',
    );
});

/**
 * `openForVersion` WYKONUJE swoje ciało (nie tylko dopasowanie tekstu) — plik nie da się
 * zaimportować wprost w AVA (import atrybutowy markdownu, `ERR_UNKNOWN_FILE_EXTENSION` bez
 * dedykowanego loadera), więc ciało metody wycinamy regexem i odpalamy jako prawdziwy kod
 * z podstawionym `this.open`. Pina konkretne zachowanie: `openForVersion` WOLA `this.open`
 * z workspace'em i stanem `{ version }`, i ZWRACA to, co `open` zwrócił — mutant
 * `return this.open(...)` → `return undefined` gubi OBIE te rzeczy naraz (open nigdy
 * niewołane, wynik zawsze `undefined` zamiast Promise).
 */
test('openForVersion faktycznie woła this.open(workspace, { version }) i zwraca jego wynik', t => {
    const match = viewSource.match(
        /static\s+openForVersion\s*\(workspace: unknown, version: string\): Promise<void> \{\r?\n([\s\S]*?)\r?\n {4}\}/,
    );
    t.truthy(match, 'nie znaleziono ciała openForVersion w źródle (dopasuj regex do formatowania pliku)');
    const body = match![1];

    const calls: unknown[][] = [];
    const openStub = (...args: unknown[]): unknown => {
        calls.push(args);
        return 'OPEN_RESULT_SENTINEL';
    };
    // Ciało metody statycznej odwołuje się do `this.open` i parametrów `workspace`/`version` —
    // odtwarzamy dokładnie ten kontekst wywołania, zero importu produkcyjnego modułu.
    const runBody = new Function(`return function(workspace, version) { ${body} };`)() as (
        this: { open: (...args: unknown[]) => unknown },
        workspace: unknown,
        version: string,
    ) => unknown;

    const result = runBody.call({ open: openStub }, 'WORKSPACE_SENTINEL', 'v9.9.9');

    t.is(calls.length, 1, 'openForVersion musi wołać this.open dokładnie raz');
    t.deepEqual(calls[0], ['WORKSPACE_SENTINEL', { version: 'v9.9.9' }], 'open musi dostać workspace i stan { version }');
    t.is(result, 'OPEN_RESULT_SENTINEL', 'openForVersion musi zwrócić to, co zwróciło this.open (nie undefined)');
});
