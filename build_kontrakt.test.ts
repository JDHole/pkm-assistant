/**
 * Strażnik strukturalny `esbuild.js` / `release.js` / `package.json` / CI — wzorem
 * `docs_kontrakt.test.ts`.
 *
 * DLACZEGO ten plik istnieje: bez niego `esbuild.js` nie miałby ani jednego testu
 * jednostkowego, bramki CI mogłyby rozjechać się z krokami `RELEASE_PROCESS.md` bez
 * żadnego strażnika, a liczba komend w dokumentacji mogłaby przestać zgadzać się
 * z `package.json`.
 *
 * Testy tego pliku czytają `esbuild.js`/`release.js` jako TEKST (nie import) i celowo
 * działają NIEZALEŻNIE od tego, czy ciało jest realne czy stubem — bo strażniki tego pliku
 * pilnują KSZTAŁTU ŹRÓDŁA (literał `external`, rozszerzenia importów, brak zakazanego słownictwa),
 * nie zachowania w runtime. To zamierzone: struktura jest częścią kontraktu od pierwszego
 * commita, treść przybywa później.
 */
import test from 'ava';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { forbiddenVocabulary } from './core/forbiddenVocabulary.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const esbuildSource = read('esbuild.js');
const releaseSource = read('release.js');

/** Wzorzec, którym DWA niezależne testy w `core/` czytają listę `external` z esbuild.js. */
const ESBUILD_EXTERNAL_REGEX = /external:\s*\[([\s\S]*?)\]/;

// ── Literał external: obsidian jest, electron nie wraca ──────────────────────────────

test('esbuild.js ma literal external z obsidian i bez electron', t => {
    const match = ESBUILD_EXTERNAL_REGEX.exec(esbuildSource);
    t.truthy(match, 'esbuild.js nie ma bloku external: [...] jako literal - dwa strażniki w core/ oślepną');

    const list = [...(match ? match[1] : '').matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
    t.true(list.includes('obsidian'), 'lista external musi zawierac "obsidian"');
    t.false(list.includes('electron'), 'electron zszedl z listy razem ze swoim jedynym konsumentem i nie wraca');
});

// ── Helpery importowane z rozszerzeniem .ts (jedyny wyjatek od reguly, ze specifiery importow koncza sie na .js) ─────────────────────

test('esbuild.js i release.js importuja lokalne helpery z rozszerzeniem .ts', t => {
    const localSpecifierRe = /from\s+['"](\.\/[^'"]+)['"]/g;

    for (const [label, source] of [['esbuild.js', esbuildSource], ['release.js', releaseSource]] as const) {
        const specifiers = [...source.matchAll(localSpecifierRe)].map(m => m[1]);
        t.true(specifiers.length > 0, `${label} nie ma ani jednego lokalnego importu do sprawdzenia`);
        for (const specifier of specifiers) {
            t.false(specifier.endsWith('.js'), `${label}: specyfier "${specifier}" konczy sie na .js - Node nie przepisuje rozszerzen, plik na dysku to .ts (ERR_MODULE_NOT_FOUND)`);
            t.true(specifier.endsWith('.ts'), `${label}: specyfier "${specifier}" powinien konczyc sie na .ts`);
        }
    }
});

// ── Dokladnie 7 znanych komend w package.json.scripts ─────────────────────────────────
//
// Komendy `harness:*` nie mieszkaja tutaj: harness zyje w osobnym repo
// (https://github.com/JDHole/pkm-assistant-harness), bo walidator katalogu lintuje CALE repo,
// a harness nie jest czescia pluginu. Bramka harnessu nie znikla — jedzie w CI z tamtego repo
// (patrz test nizej).

const PACKAGE_SCRIPT_NAMES = [
    'build', 'dev', 'release', 'test', 'typecheck', 'lint', 'lint:obsidian',
] as const;

test('package.json.scripts to dokladnie 7 znanych komend', t => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const actual = Object.keys(pkg.scripts ?? {}).sort();

    t.deepEqual(actual, [...PACKAGE_SCRIPT_NAMES].sort());
});

// ── Piec bramek pluginu w CI w tej samej kolejnosci co RELEASE_PROCESS ────────────────

const GATE_COMMANDS = [
    'npm test',
    'npm run typecheck',
    'npm run lint',
    'npm run lint:obsidian',
    'npm run build',
] as const;

/** Repo harnessu — bramka `selftest`/`scenarios` jedzie stamtad, nie z package.json pluginu. */
const HARNESS_REPO = 'JDHole/pkm-assistant-harness';

test('piec bramek pluginu w CI w tej samej kolejnosci co RELEASE_PROCESS', t => {
    const ci = read('.github/workflows/ci.yml');
    const releaseProcess = read('RELEASE_PROCESS.md');

    // ci.yml: wyciagamy kazda linie `run: npm ...` w kolejnosci wystapienia.
    const ciRuns = [...ci.matchAll(/run:\s*(npm\s+(?:test|run\s+[a-z:_-]+))/g)].map(m => m[1].trim());
    const ciGates = ciRuns.filter(cmd => (GATE_COMMANDS as readonly string[]).includes(cmd));
    t.deepEqual(ciGates, [...GATE_COMMANDS], 'ci.yml nie ma pieciu bramek pluginu w oczekiwanej kolejnosci');

    // RELEASE_PROCESS.md Krok 3: blok kodu z tymi samymi piecioma komendami.
    const step3 = releaseProcess.split(/## Krok 3/)[1]?.split(/## Krok 4/)[0] ?? '';
    for (const gate of GATE_COMMANDS) {
        t.true(step3.includes(gate), `RELEASE_PROCESS.md Krok 3 nie wymienia "${gate}"`);
    }
});

// ── Bramka harnessu jedzie z osobnego repo ──────────────────────────────────────────

test('CI klonuje repo harnessu i puszcza jego bramki na tym checkoutcie', t => {
    for (const plik of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
        const src = read(plik);
        t.true(src.includes(HARNESS_REPO), `${plik} nie klonuje ${HARNESS_REPO} — bramka harnessu zniknela bez sladu`);
        t.true(src.includes('npm run selftest'), `${plik} nie uruchamia selftestu harnessu`);
        t.true(src.includes('npm run scenarios'), `${plik} nie uruchamia scenariuszy harnessu`);
        t.true(src.includes('PKM_ASSISTANT_ROOT'), `${plik} nie wskazuje harnessowi tego checkoutu pluginu`);
    }
    t.true(read('RELEASE_PROCESS.md').includes(HARNESS_REPO), 'RELEASE_PROCESS.md nie mowi, skad wziac harness');
});

// ── Zero zakazanego słownictwa w skryptach builda/release'u ──────────────────────────────────

/**
 * Ta sama lista, którą trzyma bramka „grep zero" — wspólna, żeby dwie kopie nie rozjechały się
 * po pierwszej zmianie. Wzorzec zapisany jest w `core/forbiddenVocabulary.ts` tak, żeby zakazane
 * słowa nie występowały w tekście ŻADNEGO pliku repo (ten test też jest przez bramkę skanowany).
 */
const FORBIDDEN_NAME_RE = forbiddenVocabulary();

test('zero zakazanego słownictwa w skryptach builda i release\'u', t => {
    const filesToCheck = [
        'esbuild.js',
        'release.js',
        'utils/releaseNotes.ts',
        'utils/banner.ts',
        'utils/buildManifest.ts',
        'utils/releasePrep.ts',
        'modules/shell/ReleaseNotesView.ts',
    ];

    for (const file of filesToCheck) {
        const source = read(file);
        t.notRegex(source, FORBIDDEN_NAME_RE, `${file} zawiera zakazane slownictwo`);
    }
});

// ── versions.json ma wpis dla manifest.version rowny minAppVersion ────────────

test('versions.json ma wpis dla manifest.version rowny minAppVersion', t => {
    const manifest = JSON.parse(read('manifest.json')) as { version: string; minAppVersion: string };
    const versions = JSON.parse(read('versions.json')) as Record<string, string>;
    const pkg = JSON.parse(read('package.json')) as { version: string };

    t.is(pkg.version, manifest.version, 'package.json.version i manifest.json.version musza sie zgadzac');
    t.true(Object.prototype.hasOwnProperty.call(versions, manifest.version), `versions.json nie ma wpisu dla ${manifest.version}`);
    t.is(versions[manifest.version], manifest.minAppVersion);
});

// ── Kazdy wpis versions.json ma plik releases/X.Y.Z.md ALBO jest na liscie historycznej ──

/** Notatki sprzed wprowadzenia systemu notatek wydania — swiadomie bez pliku, bez fabrykowania. */
const HISTORICAL_VERSIONS_WITHOUT_NOTES = new Set(['1.1.1', '1.2.1', '2.0.0-rc.1', '2.0.0']);

test('kazdy wpis versions.json ma plik releases/X.Y.Z.md albo jest na liscie historycznej', t => {
    const versions = JSON.parse(read('versions.json')) as Record<string, string>;
    const releasesDir = join(ROOT, 'releases');
    const onDisk = new Set(readdirSync(releasesDir).filter(f => f.endsWith('.md')));

    const braki: string[] = [];
    for (const version of Object.keys(versions)) {
        if (HISTORICAL_VERSIONS_WITHOUT_NOTES.has(version)) continue;
        if (!onDisk.has(`${version}.md`)) braki.push(version);
    }

    t.deepEqual(braki, [], `wersje bez pliku notatek i bez wpisu na liscie historycznej: ${braki.join(', ')}`);
});

test('lista historyczna nie zawiera wersji, ktora juz ma plik notatek', t => {
    // Strażnik odwrotny: gdyby ktoś kiedyś dopisał plik dla wersji z listy historycznej,
    // lista powinna się skurczyć, żeby test wyżej dalej coś pilnował.
    const releasesDir = join(ROOT, 'releases');
    const onDisk = new Set(readdirSync(releasesDir).filter(f => f.endsWith('.md')));

    for (const version of HISTORICAL_VERSIONS_WITHOUT_NOTES) {
        t.false(onDisk.has(`${version}.md`), `${version}.md juz istnieje - usun ${version} z listy historycznej`);
    }
});
