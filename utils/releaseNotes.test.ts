/**
 * AUD-docs-009: `releaseNotes.ts` gotuje ścieżkę zapisu dla `npm run release`.
 * `latestReleaseFile()` legalnie zwraca `null`, gdy `releases/` nie ma jeszcze żadnego
 * pliku `X.Y.Z.md` (dokładnie stan katalogu na HEAD tego repo) — `release.js` pisał
 * wtedy przez `fs.writeFileSync(prior_file, ...)` na tym `null`-u i cały proces padał
 * PRZED zbudowaniem notatek. Naprawa: `resolveNotesTarget()` daje jawną, zawsze-nie-null
 * ścieżkę zapisu; `latestReleaseFile()` służy odtąd wyłącznie do CZYTANIA poprzednich notatek.
 *
 * `release.js` sam jest skryptem (czyta stdin, woła GitHuba) — nietestowalny w AVA —
 * dlatego bramka dla AUD-docs-009 stoi tutaj, na czystych funkcjach.
 *
 * clean-room / F1 (build-release): reshape mechaniczny dawnego `release_helpers.test.ts`
 * (plik był CZYSTY — żaden test nie jest portem upstreamu) + nowe testy dla `compareSemver` /
 * `priorNotes` / `writePluginReleaseNotes` (luki katalogu §F, napisane przed implementacją —
 * czerwone na stubie, dziś zielone) i AUTOR dla `formatReleaseNotesContent`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'ava';
import {
    compareSemver,
    formatReleaseNotesContent,
    latestReleaseFile,
    priorNotes,
    resolveNotesTarget,
    writePluginReleaseNotes,
} from './releaseNotes.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-release-notes-'));
}

// ── compareSemver ──────────────────────────────────────────────────────────────────────────

test('compareSemver: porzadek numeryczny, nie leksykalny', t => {
    t.true(compareSemver('1.10.0', '1.9.5') > 0);
    t.is(compareSemver('2.0.0', '2.0.0'), 0);
    t.true(compareSemver('1.9.5', '1.10.0') < 0);
    t.true(compareSemver('2.1.0', '2.0.99') > 0);
});

test('compareSemver: rozstrzyga po segmencie GLOWNYM, nie tylko po dalszych', t => {
    // Pin dla petli od i=0: gdyby porownanie zaczynalo sie od segmentu minor (i=1),
    // ten przypadek dalby zly znak (0 < 99 dla minor), mimo ze major 2 > 1.
    t.true(compareSemver('2.0.0', '1.99.99') > 0);
    t.true(compareSemver('1.0.0', '2.0.0') < 0);
});

// ── latestReleaseFile ───────────────────────────────────────────────────────────────────────

test('latestReleaseFile: pusty katalog zwraca null, nie rzuca (AUD-docs-009 - stan releases/ na HEAD)', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    t.notThrows(() => {
        const result = latestReleaseFile(dir, '2.1.0');
        t.is(result, null);
    });
});

test('latestReleaseFile: katalog z samymi nie-wersyjnymi plikami zwraca null', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'latest_release.md'), 'nie jest to plik wersji');
    fs.writeFileSync(path.join(dir, 'README.md'), 'tez nie');

    t.is(latestReleaseFile(dir, '2.1.0'), null);
});

test('latestReleaseFile: nieistniejacy katalog zwraca null, nie rzuca', t => {
    const missing = path.join(os.tmpdir(), `pkm-release-notes-missing-${Date.now()}-a`);

    t.notThrows(() => {
        t.is(latestReleaseFile(missing, '2.1.0'), null);
    });
});

test('latestReleaseFile: wybiera najnowszy semver i pomija plik BIEZACEJ wersji', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '2.0.0.md'), 'v2.0.0 notes');
    fs.writeFileSync(path.join(dir, '2.1.0.md'), 'v2.1.0 notes - biezaca wersja, ma byc pominieta');
    fs.writeFileSync(path.join(dir, '1.9.5.md'), 'v1.9.5 notes');

    const result = latestReleaseFile(dir, '2.1.0');

    t.is(result, path.join(dir, '2.0.0.md'));
});

test('latestReleaseFile: ignoruje pliki, ktore nie pasuja do wzorca X.Y.Z.md', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '2.0.0.md'), 'v2.0.0 notes');
    fs.writeFileSync(path.join(dir, 'v2.0.1.md'), 'prefiks v - nie pasuje do wzorca');
    fs.writeFileSync(path.join(dir, '2.0.md'), 'brak trzeciego segmentu');

    t.is(latestReleaseFile(dir, '9.9.9'), path.join(dir, '2.0.0.md'));
});

test('latestReleaseFile: dwucyfrowy segment glowny bije jednocyfrowy mimo porzadku alfabetycznego nazw', t => {
    // "10.0.0.md" < "9.0.0.md" leksykalnie (readdir jest alfabetyczny), wiec ten test
    // pilnuje, ze wybor najnowszej wersji jedzie po WARTOSCI liczbowej trojki, nie po
    // kolejnosci napotkania plikow.
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '10.0.0.md'), 'najnowsza');
    fs.writeFileSync(path.join(dir, '9.0.0.md'), 'starsza mimo alfabetu');

    t.is(latestReleaseFile(dir, '99.99.99'), path.join(dir, '10.0.0.md'));
});

test('latestReleaseFile: przy remisie trojek wersji wygrywa PIERWSZA napotkana nazwa', t => {
    // "2.01.0.md" i "2.1.0.md" normalizuja sie do tej samej trojki [2,1,0].
    // Kontrakt: przy remisie zostaje ta napotkana jako pierwsza (readdir alfabetyczny
    // stawia "2.01.0.md" przed "2.1.0.md"), pozniejszy remis NIE nadpisuje wyboru.
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '2.01.0.md'), 'A');
    fs.writeFileSync(path.join(dir, '2.1.0.md'), 'B');

    t.is(latestReleaseFile(dir, '9.9.9'), path.join(dir, '2.01.0.md'));
});

// ── priorNotes ──────────────────────────────────────────────────────────────────────────────

test('priorNotes: pusty/nieistniejacy katalog daje pusty string, nie null i nie rzut', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    const missing = path.join(os.tmpdir(), `pkm-release-notes-missing-${Date.now()}-b`);

    t.is(priorNotes(dir, '2.1.0'), '');
    t.is(priorNotes(missing, '2.1.0'), '');
});

test('priorNotes: zwraca tresc pliku najnowszej wczesniejszej wersji', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '2.0.0.md'), 'X');

    t.is(priorNotes(dir, '2.1.0'), 'X');
});

test('priorNotes: blad odczytu pliku (np. sciezka jest katalogiem) daje pusty string, nie rzuca', t => {
    // latestReleaseFile tylko dopasowuje NAZWE do wzorca - nie sprawdza, ze to plik.
    // Katalog o nazwie "2.0.0.md" przechodzi dopasowanie, ale fs.readFileSync na nim
    // rzuca (EISDIR) - to jest sciezka, ktora ma wrocic '', a nie wywalic funkcje.
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, '2.0.0.md'));

    t.notThrows(() => {
        t.is(priorNotes(dir, '9.9.9'), '');
    });
});

// ── resolveNotesTarget ──────────────────────────────────────────────────────────────────────
//
// To jest sedno naprawy AUD-docs-009: w przeciwienstwie do `latestReleaseFile`, ta funkcja
// nie dotyka dysku, wiec fizycznie nie ma jak zwrocic `null` — `fs.writeFileSync(target, ...)`
// w `release.js` nie moze sie juz wywalic tak, jak wywalal sie `writeFileSync(prior_file, ...)`.

test('resolveNotesTarget: zwraca releases/<wersja>.md w pustym katalogu (dokladnie stan HEAD)', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    const target = resolveNotesTarget(dir, '2.1.0');

    t.is(target, path.join(dir, '2.1.0.md'));
    t.not(target, null);
});

test('resolveNotesTarget: nie zalezy od tego, czy releases_dir w ogole istnieje na dysku', t => {
    const missing = path.join(os.tmpdir(), `pkm-release-notes-missing-${Date.now()}-c`);

    t.is(resolveNotesTarget(missing, '3.0.0'), path.join(missing, '3.0.0.md'));
});

test('resolveNotesTarget: wynik jest niezalezny od tego, co lezy w katalogu obok', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '2.0.0.md'), 'stara wersja obok - nie ma wplywu na target');

    t.is(resolveNotesTarget(dir, '2.1.0'), path.join(dir, '2.1.0.md'));
});

// ── formatReleaseNotesContent (AUTOR — kontrakt słaby, treść jest redakcyjna) ────────────────

test('formatReleaseNotesContent: naglowek wersji + wynik niepusty dla niepustego wejscia', t => {
    const result = formatReleaseNotesContent('## Zmiany\n- coś', '2.2.0');

    t.true(result.length > 0);
    t.true(result.includes('2.2.0'));
});

test('formatReleaseNotesContent: puste wejscie nie rzuca', t => {
    t.notThrows(() => formatReleaseNotesContent('', '2.2.0'));
});

test('formatReleaseNotesContent: puste wejscie daje WYLACZNIE tytul, bez pustej sekcji doklejonej obok', t => {
    // Pin dla flush(): sekcja bez tresci (text === '') NIE MA prawa trafic do sections[].
    t.is(formatReleaseNotesContent('', '2.2.0'), '# PKM Assistant 2.2.0\n');
});

test('formatReleaseNotesContent: naglowek H1 (jedna #) tez otwiera sekcje wersji, starsza wersja jest ZWINIETA z realnym numerem, biezaca OTWARTA', t => {
    // Trzy rzeczy naraz w jednym scenariuszu:
    //  - VERSION_HEADING dopuszcza 1-6 '#' -> "# 1.0.0" (H1) musi zostac rozpoznany;
    //  - numer wersji z naglowka bierze sie z GRUPY 1 regexu, nie z nieistniejacej grupy 2;
    //  - starsza sekcja (1.0.0, != biezaca) jedzie do <details>, biezaca (2.0.0) zostaje otwarta.
    const result = formatReleaseNotesContent(
        '# 1.0.0\nStare zmiany',
        '2.0.0',
    );
    const withCurrent = formatReleaseNotesContent(
        '# 1.0.0\nStare zmiany\n\n## 2.0.0\nNowe zmiany',
        '2.0.0',
    );

    t.true(result.includes('<details>\n<summary>1.0.0</summary>\n\nStare zmiany\n\n</details>'));
    t.true(withCurrent.includes('<details>\n<summary>1.0.0</summary>'));
    t.true(withCurrent.includes('## 2.0.0\n\nNowe zmiany'));
    t.false(withCurrent.includes('<summary>2.0.0</summary>'));
    t.false(withCurrent.includes('<summary>undefined</summary>'));
});

// ── writePluginReleaseNotes ───────────────────────────────────────────────────────────────────

test('writePluginReleaseNotes: nadpisuje latest_release.md, nie dotyka <wersja>.md', t => {
    const dir = makeTempDir();
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, '2.1.0.md'), 'A');
    fs.writeFileSync(path.join(dir, 'latest_release.md'), 'stara tresc');

    const result = writePluginReleaseNotes(dir, '2.2.0', 'nowe notatki');

    t.is(result, path.join(dir, 'latest_release.md'));
    t.is(fs.readFileSync(path.join(dir, 'latest_release.md'), 'utf8'), 'nowe notatki');
    t.is(fs.readFileSync(path.join(dir, '2.1.0.md'), 'utf8'), 'A');
});
