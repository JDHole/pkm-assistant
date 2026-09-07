// `release.js` — PRZYGOTOWANIE wydania (`npm run release`). Publikację NIE robi ten
// skrypt — od 2026-09-07 robi ją GitHub Actions (`.github/workflows/release.yml`):
// push taga `X.Y.Z` (bez litery `v`) uruchamia bramki, build na czystym Linuksie,
// atestację provenance (`actions/attest-build-provenance`) i `gh release create`
// z DOKŁADNIE trzema plikami — `main.js`, `manifest.json`, `styles.css`.
//
// Ten skrypt robi WSZYSTKO PRZED tagiem, czyli to, czego workflow nie może zrobić za
// człowieka: sprawdza spójność wersji (5.1), pyta o jej potwierdzenie (5.2), gotuje
// notatki wydania (5.3–5.4) i odpala lokalny rebuild (5.5) — żeby ewentualny błąd
// builda wyszedł na jaw PRZED commitem i tagiem, nie dopiero w logach CI. Na końcu
// wypisuje listę kroków, które człowiek robi już ręcznie (commit, tag, push) — patrz
// `RELEASE_PROCESS.md` Krok 5 i dalej.
//
// Rootowy plik `.js` uruchamiany wprost przez Node, dlatego helpery importuje
// z rozszerzeniem `.ts` — patrz komentarz nagłówkowy w `esbuild.js`.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    RELEASES_DIR_NAME,
    formatReleaseNotesContent,
    latestReleaseFile,
    priorNotes,
    resolveNotesTarget,
    writePluginReleaseNotes,
} from './utils/releaseNotes.ts';
import {
    DEPLOY_ENV_VAR,
    ReleaseError,
    assertVersionsMatch,
    confirmedVersionOf,
    releaseTagName,
} from './utils/releasePrep.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// `.env` wczytuje sam Node (`process.loadEnvFile`) — bez pakietu `dotenv`, patrz esbuild.js.
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

/* ── drobne narzędzia ──────────────────────────────────────────────────────────── */

function say(text) {
    console.log(text);
}

function warn(text) {
    console.warn(text);
}

function fail(text) {
    console.error(text);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ── kroki procesu ─────────────────────────────────────────────────────────────── */

/**
 * Krok 5.2 — potwierdzenie wersji. Sam ENTER bierze gołą wartość z `package.json`.
 * To, co tu wyjdzie, leci ZNAK W ZNAK do nazwy pliku notatek i (dopiero po ręcznym
 * `git tag` człowieka) do taga, który uruchamia workflow.
 */
async function confirmVersion(rl, packageVersion) {
    const answer = await rl.question(`Confirm release version (${packageVersion}): `);
    return releaseTagName(confirmedVersionOf(answer, packageVersion));
}

/**
 * Krok 5.3 — notatki wydania.
 * Gotowy `releases/<wersja>.md` bierzemy 1:1. Gdy go nie ma, sklejamy świeży opis
 * z konsoli z notatkami poprzedniego wydania i zapisujemy pod ścieżką z
 * `resolveNotesTarget` (zawsze-nie-null, nie dotyka dysku — AUD-docs-009).
 *
 * Workflow releasowy sprawdza istnienie tego pliku PRZED buildem (patrz
 * `release.yml`) — bez niego push taga obleje bramkę już na pierwszym kroku.
 */
async function prepareNotes(rl, releasesDir, version) {
    const target = resolveNotesTarget(releasesDir, version);
    if (fs.existsSync(target)) {
        say(`[release] notatki: biore gotowy ${path.relative(ROOT, target)}`);
        return fs.readFileSync(target, 'utf8');
    }

    const previousFile = latestReleaseFile(releasesDir, version);
    if (previousFile) {
        say(`[release] notatki: dokladam historie z ${path.relative(ROOT, previousFile)}`);
    }

    const description = (await rl.question('Opis wydania (jedno zdanie, ENTER konczy): ')).trim();
    const previous = priorNotes(releasesDir, version);
    const composed = [`# ${version}`, description, previous].filter(part => part.length > 0).join('\n\n');

    fs.mkdirSync(releasesDir, { recursive: true });
    fs.writeFileSync(target, `${composed}\n`, 'utf8');
    say(`[release] notatki zapisane w ${path.relative(ROOT, target)}`);
    return composed;
}

/**
 * Krok 5.5 — świeży `dist/` dokładnie pod potwierdzoną wersję. Błąd przerywa wszystko.
 *
 * Lokalny rebuild jest dziś WYŁĄCZNIE kontrolą przed commitem — sam `dist/` z tego
 * przebiegu nigdy nie trafia na wydanie (to robi osobny build na Linuksie w CI).
 * Wart jest mimo to: łapie błąd builda ZANIM człowiek zdąży zacommitować i wypchnąć tag.
 *
 * Build to `node esbuild.js` (dokładnie to, co robi `npm run build`), wołany przez bieżący
 * plik wykonywalny Node'a — NIE przez `npm.cmd`. Na Windows `spawnSync('npm.cmd', …)` bez
 * powłoki kończy się `EINVAL` (Node ≥ 20.12 odmawia uruchamiania plików `.cmd`/`.bat` bez
 * `shell: true`), a `shell: true` z argumentami to z kolei ostrzeżenie DEP0190. Bezpośredni
 * `process.execPath` omija oba problemy i nie zależy od PATH-a powłoki, z której odpalono skrypt.
 */
function rebuild() {
    say('[release] przebudowa dist/ (node esbuild.js)…');
    if (process.env[DEPLOY_ENV_VAR]) {
        say(`[release] uwaga: ${DEPLOY_ENV_VAR} jest ustawione — build wdrozy sie tez do Twoich vaultow`);
    }
    const result = spawnSync(process.execPath, [path.join(ROOT, 'esbuild.js')], { cwd: ROOT, stdio: 'inherit' });
    if (result.error) {
        throw new ReleaseError(`build nie wystartowal (${result.error.code ?? result.error.message}) — wydanie przerwane przed commitem/tagiem`);
    }
    if (result.status !== 0) {
        throw new ReleaseError('build (node esbuild.js) zakonczyl sie bledem — wydanie przerwane przed commitem/tagiem');
    }
}

/** Krok 5.6 — lista kroków, które człowiek robi już ręcznie (skrypt ich nie robi). */
function printNextSteps(version, pluginNotesPath) {
    // Ścieżka do komendy git — zawsze `/`, nawet na Windows (`path.relative` zwraca `\`
    // na Windows, a `git add` woli forward slash niezależnie od platformy, na której się go wklei).
    const notesPath = path.relative(ROOT, pluginNotesPath).split(path.sep).join('/');
    say('');
    say('[release] gotowe. Recznie, w tej kolejnosci:');
    say(`  1. git add releases/${version}.md ${notesPath}`);
    say(`  2. git commit -m "docs(release): notatki ${version}"`);
    say(`  3. git tag ${version}          (BEZ litery "v" — musi byc rowny manifest.json.version)`);
    say('  4. git push origin main && git push origin ' + version);
    say('  5. Patrz zakladke Actions → workflow „Release" (bramki, build, atestacja, publikacja)');
    say(`  6. Po zielonym biegu: strona wydania ${version} ma DOKLADNIE 3 assety`);
    say('     (main.js, manifest.json, styles.css) + atestacje provenance');
}

/* ── główny przebieg ───────────────────────────────────────────────────────────── */

async function main() {
    // 5.1 — spójność wersji. Skrypt sam niczego nie bumpuje.
    const pkg = readJson(path.join(ROOT, 'package.json'));
    const manifest = readJson(path.join(ROOT, 'manifest.json'));
    assertVersionsMatch(pkg.version, manifest.version);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let version;
    let notes;
    try {
        version = await confirmVersion(rl, pkg.version);
        notes = await prepareNotes(rl, path.join(ROOT, RELEASES_DIR_NAME), version);
    } finally {
        rl.close();
    }

    // 5.4 — sformatowana kopia pod widok „co nowego" w pluginie. To JEDYNY plik
    // notatek nadpisywany przy każdym wydaniu; `releases/<wersja>.md` zostaje trwały.
    const pluginNotes = writePluginReleaseNotes(
        path.join(ROOT, RELEASES_DIR_NAME),
        version,
        formatReleaseNotesContent(notes, version),
    );
    say(`[release] widok „co nowego": ${path.relative(ROOT, pluginNotes)}`);

    // 5.5 — świeży dist/ pod potwierdzoną wersję (kontrola lokalna, nie asset wydania).
    rebuild();

    printNextSteps(version, pluginNotes);
}

main().catch(err => {
    const raw = err instanceof ReleaseError ? err.message : String(err?.stack ?? err);
    fail(`[release] BLAD: ${raw}`);
    process.exitCode = 1;
});
