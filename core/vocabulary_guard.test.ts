/**
 * Bramka „grep zero" - sprawdza kod pod kątem zakazanego słownictwa/nazewnictwa.
 *
 * DLACZEGO: repo publiczne ma nie nieść ANI JEDNEGO śladu słownictwa frameworka, na którym
 * plugin kiedyś stał - ani w kodzie, ani w komentarzach, ani w dokumentacji, ani w nazwach
 * plików czy symboli. Dotąd pilnował tego skrypt uruchamiany ręcznie; tu ta sama lista wzorców
 * stoi jako TEST, więc regres łapie się w `npm test`, a nie dopiero przy przeglądzie przed
 * wysyłką do katalogu.
 *
 * ŹRÓDŁO PRAWDY: wzorzec mieszka w `core/forbiddenVocabulary.ts` i jest WSPÓLNY z
 * `build_kontrakt.test.ts`. Dwie kopie tej samej listy rozjeżdżają się po pierwszej zmianie,
 * a rozjazd w bramce jest cichy. Sam wzorzec zapisany jest tam tak, żeby zakazane słowa nie
 * występowały w tekście pliku - dzięki temu nie potrzebuje wyjątku.
 *
 * WYJĄTKI (`WYJATKI`): pliki, które MUSZĄ znać stare nazwy kluczy, żeby dane usera przeżyły
 * podniesienie wersji - migrator ustawień i jego dane testowe. Drugi test pilnuje, żeby wyjątek
 * nie przeżył pliku, którego dotyczy (martwy wyjątek = cicha dziura w bramce).
 */
import test from 'ava';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { forbiddenVocabulary } from './forbiddenVocabulary.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WZORZEC = forbiddenVocabulary();

/**
 * Drzewa skanowane w całości — WSZYSTKO, co trafia do publicznego repozytorium, łącznie
 * z notatkami wydania i CI (`.claude/` nie jest śledzone w gicie — skille agentów
 * to prywatne narzędzia właściciela).
 */
const DRZEWA = ['core', 'modules', 'src', 'config', 'utils', 'test-support', 'releases', '.github'];

/** Rozszerzenia plików tekstowych, które w ogóle mogą nieść słownictwo. */
const ROZSZERZENIA = ['.ts', '.js', '.mjs', '.cjs', '.json', '.css', '.md', '.yml', '.yaml', '.html', '.txt', '.example'];

/** Foldery pomijane wszędzie (artefakty budowania, zależności, robocze kopie repo). */
const POMIJANE_FOLDERY = new Set(['node_modules', 'dist', '.git', '.claude', 'worktrees']);

/** Pliki w roocie — skanowane niezależnie od rozszerzenia. */
const PLIKI_ROOT = [
    'esbuild.js',
    'release.js',
    'eslint.config.js',
    'eslint.obsidian.config.js',
    'tsconfig.json',
    'package.json',
    'manifest.json',
    'versions.json',
    '.gitignore',
    '.env.example',
    'README.md',
    'QUICK_START.md',
    'SECURITY.md',
    'CLAUDE.md',
    'CHANGELOG.md',
    'RELEASE_PROCESS.md',
    'THIRD-PARTY-LICENSES.md',
    'LICENSE',
    // Zbudowany bundel — skanowany TYLKO jeśli leży w repo (po `npm run build`).
    'dist/main.js',
];

/**
 * Jedyne pliki, którym wolno znać stare nazwy: migrator ustawień (mapa stary klucz → nowy)
 * i jego dane testowe. Ścieżki względem roota, separator `/`. Wpis kończący się `/` = prefiks
 * folderu.
 */
const WYJATKI = [
    'core/runtime/legacySettingsMigration.ts',
    'core/runtime/legacySettingsMigration.test.ts',
    'core/runtime/__fixtures__/',
    'core/utils/settingsNamespaceMigration.test.ts',
];

function czyWyjatek(sciezka: string): boolean {
    return WYJATKI.some((w) => (w.endsWith('/') ? sciezka.startsWith(w) : sciezka === w));
}

/**
 * Zbudowany bundel niesie SKOMPILOWANY kod całego pluginu — razem z kwarantanną migratora,
 * który z definicji zna stare nazwy kluczy (bez nich ustawienia usera nie przeżyją
 * podniesienia wersji). Nie da się mieć jednocześnie działającej migracji i bundla bez tych
 * nazw, więc bundel dostaje bramkę WĘŻSZĄ — nie żadną.
 */
const PLIKI_BUNDLA = new Set(['dist/main.js']);

/** Produkcyjny plik kwarantanny — jedyny, którego treść realnie wchodzi do bundla. */
const KWARANTANNA_PRODUKCYJNA = 'core/runtime/legacySettingsMigration.ts';

/**
 * Słownictwo, które wolno znaleźć w bundlu: DOKŁADNIE to, które niesie plik kwarantanny,
 * ani jednego słowa więcej. Lista liczy się z pliku przy każdym biegu, więc skasowanie
 * migratora automatycznie zaostrza bramkę, a dopisanie nowej nazwy do niego jest widoczną
 * decyzją w jednym miejscu.
 */
function slownictwoKwarantanny(): Set<string> {
    const sciezka = join(ROOT, KWARANTANNA_PRODUKCYJNA);
    if (!existsSync(sciezka)) return new Set<string>();
    const globalny = new RegExp(WZORZEC.source, 'gi');
    return new Set(
        [...readFileSync(sciezka, 'utf8').matchAll(globalny)].map((m) => m[0].toLowerCase()),
    );
}

function sciezkaWzgledna(pelna: string): string {
    return relative(ROOT, pelna).split(sep).join('/');
}

function zbierzPliki(katalog: string, wynik: string[]): void {
    let wpisy;
    try {
        wpisy = readdirSync(katalog, { withFileTypes: true });
    } catch {
        return;
    }
    for (const wpis of wpisy) {
        if (wpis.name.startsWith('.') && wpis.isDirectory() && POMIJANE_FOLDERY.has(wpis.name)) continue;
        const pelna = join(katalog, wpis.name);
        if (wpis.isDirectory()) {
            if (POMIJANE_FOLDERY.has(wpis.name)) continue;
            zbierzPliki(pelna, wynik);
            continue;
        }
        if (!wpis.isFile()) continue;
        if (!ROZSZERZENIA.some((r) => wpis.name.endsWith(r))) continue;
        wynik.push(pelna);
    }
}

/** Wszystkie pliki objęte bramką, jako ścieżki względne z `/`. */
function plikiPodBramka(): string[] {
    const pelne: string[] = [];
    for (const drzewo of DRZEWA) {
        const sciezka = join(ROOT, drzewo);
        if (existsSync(sciezka) && statSync(sciezka).isDirectory()) zbierzPliki(sciezka, pelne);
    }
    for (const plik of PLIKI_ROOT) {
        const sciezka = join(ROOT, plik);
        if (existsSync(sciezka) && statSync(sciezka).isFile()) pelne.push(sciezka);
    }
    return pelne.map(sciezkaWzgledna).filter((p) => !czyWyjatek(p));
}

test('grep zero: zadne zrodlo ani dokument nie niesie slownictwa starego frameworka', (t) => {
    const trafienia: string[] = [];

    const dozwoloneWBundlu = slownictwoKwarantanny();

    for (const wzgledna of plikiPodBramka()) {
        const tresc = readFileSync(join(ROOT, wzgledna), 'utf8');
        // Tani filtr — dopiero gdy plik w ogóle coś ma, płacimy za podział na linie.
        if (!WZORZEC.test(tresc)) continue;
        const dozwolone = PLIKI_BUNDLA.has(wzgledna) ? dozwoloneWBundlu : null;
        const globalny = new RegExp(WZORZEC.source, 'gi');
        const linie = tresc.split(/\r?\n/);
        for (let i = 0; i < linie.length; i++) {
            const wLinii = [...linie[i].matchAll(globalny)].map((m) => m[0]);
            const zakazane = dozwolone ? wLinii.filter((s) => !dozwolone.has(s.toLowerCase())) : wLinii;
            if (zakazane.length === 0) continue;
            trafienia.push(`${wzgledna}:${i + 1}: [${zakazane.join(', ')}] ${linie[i].trim().slice(0, 160)}`);
        }
    }

    t.deepEqual(
        trafienia,
        [],
        `slownictwo starego frameworka w repo (${trafienia.length} trafien):\n${trafienia.join('\n')}`,
    );
});

test('lista wyjatkow nie zawiera martwych wpisow', (t) => {
    const martwe = WYJATKI.filter((wpis) => !existsSync(join(ROOT, wpis)));
    t.deepEqual(
        martwe,
        [],
        'wyjatek pilnuje pliku, ktorego juz nie ma — skasuj wpis, zeby bramka nie miala cichej dziury',
    );
});
