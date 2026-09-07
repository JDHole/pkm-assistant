/**
 * Strażnik polityk katalogu społeczności Obsidiana (2026-09-07).
 *
 * DLACZEGO: walidator katalogu odrzucił zgłoszenie 2.2.0 za martwą metodę, która wyłączała
 * i włączała plugin przez `app.plugins` — Developer policies zakazują tego wprost (tak wygląda
 * podmiana kodu bez wiedzy usera). Kampania dead-code z 2026-09-02 tego nie złapała, bo liczyła
 * odwołania do eksportów, a metoda klasy z własnym testem i samowywołaniem przez `window`
 * wyglądała na „używaną". Ten test pilnuje ZASADY, nie użycia: zakazane wzorce nie mają prawa
 * pojawić się w źródłach pluginu niezależnie od tego, czy ktoś je woła.
 *
 * WZORCE: wyłączanie/włączanie pluginu przez rejestr Obsidiana, dynamiczne wykonywanie kodu
 * (`eval`, `new Function` — walidator zgłasza je jako „Dynamic Code Execution"; jedyne
 * wystąpienie w bundlu pochodzi z biblioteki Ajv wewnątrz MCP SDK, nie z naszych źródeł)
 * oraz `globalThis` w ogóle (reguła `obsidianmd/no-global-this`; jedyny most do gołego Node,
 * `core/utils/hostWindow.ts`, pyta o okno przez `typeof window`, bez globalnego obiektu).
 *
 * ZASIĘG: drzewa źródłowe pluginu. `test-support/` zostaje poza bramką celowo — atrapa `app`
 * i atrapa `obsidian` odwzorowują HOSTA, nie plugin: muszą mieć puste `enablePlugin`/`disablePlugin`
 * i własne globale, bo tak wygląda prawdziwy Obsidian.
 * Pliki testowe sprawdza tylko zakaz wyłączania pluginu: walidator pomija testy, a rigi
 * testowe (atrapa `document` w `globalThis`, `new Function` wykonujące wycinek źródła) są legalne.
 */
import test from 'ava';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRZEWA = ['core', 'modules', 'src', 'config', 'utils'];
const ROZSZERZENIA = new Set(['.ts', '.js', '.mjs', '.cjs']);
const POMIJANE_FOLDERY = new Set(['node_modules', 'dist', '.git', '.claude']);
const PLIK_TESTOWY = /\.test\.(ts|js|mjs|cjs)$/;

/** Ten plik zawiera zakazane wzorce jako tekst — sam siebie wyklucza. */
const TEN_PLIK = 'core/catalog_policy_guard.test.ts';

interface Zakaz {
    nazwa: string;
    wzorzec: RegExp;
    /** Czy sprawdzać także pliki testowe (patrz nagłówek: tylko zakaz wyłączania pluginu). */
    takzeTesty: boolean;
}

const ZAKAZY: Zakaz[] = [
    {
        nazwa: 'plugin wyłącza/włącza sam siebie przez app.plugins (Developer policies: Not allowed)',
        wzorzec: /\.(disablePlugin|enablePlugin)\s*\(/,
        takzeTesty: true,
    },
    {
        nazwa: 'dynamiczne wykonywanie kodu: eval(...)',
        wzorzec: /(^|[^\w.$])eval\s*\(/,
        takzeTesty: false,
    },
    {
        nazwa: 'dynamiczne wykonywanie kodu: new Function(...)',
        wzorzec: /new\s+Function\s*\(/,
        takzeTesty: false,
    },
    {
        nazwa: 'globalThis w kodzie pluginu (obsidianmd/no-global-this)',
        wzorzec: /\bglobalThis\b/,
        takzeTesty: false,
    },
];

function* pliki(folder: string): Generator<string> {
    for (const wpis of readdirSync(folder)) {
        if (POMIJANE_FOLDERY.has(wpis)) continue;
        const pelna = join(folder, wpis);
        if (statSync(pelna).isDirectory()) {
            yield* pliki(pelna);
            continue;
        }
        const kropka = wpis.lastIndexOf('.');
        if (kropka >= 0 && ROZSZERZENIA.has(wpis.slice(kropka))) yield pelna;
    }
}

function sciezkaRepo(pelna: string): string {
    return relative(ROOT, pelna).split(sep).join('/');
}

/**
 * Linia bez komentarza — ESLint patrzy na drzewo składniowe, więc słowo w komentarzu
 * (np. „harness dokłada X do globalThis") nie jest naruszeniem. Przybliżenie liniowe:
 * pomijamy linie zaczynające się od `//`, `*`, `/*` i ucinamy ogon po `//`.
 */
function bezKomentarza(linia: string): string {
    const t = linia.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
    const i = linia.indexOf('//');
    return i >= 0 ? linia.slice(0, i) : linia;
}

for (const zakaz of ZAKAZY) {
    test(`polityki katalogu: ${zakaz.nazwa}`, t => {
        const trafienia: string[] = [];
        for (const drzewo of DRZEWA) {
            for (const plik of pliki(join(ROOT, drzewo))) {
                const wzgledna = sciezkaRepo(plik);
                if (wzgledna === TEN_PLIK) continue;
                if (!zakaz.takzeTesty && PLIK_TESTOWY.test(wzgledna)) continue;
                const linie = readFileSync(plik, 'utf8').split(/\r?\n/);
                linie.forEach((linia, i) => {
                    if (zakaz.wzorzec.test(bezKomentarza(linia))) trafienia.push(`${wzgledna}:${i + 1}: ${linia.trim()}`);
                });
            }
        }
        t.deepEqual(trafienia, [], `zakazany wzorzec w źródłach pluginu:\n${trafienia.join('\n')}`);
    });
}
