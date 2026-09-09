/**
 * `release.js` nigdy nie miał testów jednostkowych na swoją logikę (walidacja wersji,
 * nazwa taga, potwierdzenie interaktywne). Ten plik domyka tę lukę na czystych funkcjach
 * wyjętych do `utils/releasePrep.ts`.
 *
 * Testów dotyczących publikacji przez REST API GitHuba (`buildReleasePayload`,
 * `releaseAssetPaths`, `releaseAssetZipName`, `maskToken`) tu nie ma: publikację robi
 * `.github/workflows/release.yml`, nie `release.js` (patrz `RELEASE_PROCESS.md`).
 */
import test from 'ava';
import {
    ReleaseError,
    assertVersionsMatch,
    confirmedVersionOf,
    releaseTagName,
} from './releasePrep.js';

// ── assertVersionsMatch ───────────────────────────────────────────────────────────────────────

test('assertVersionsMatch: rozjazd przerywa release', t => {
    t.notThrows(() => assertVersionsMatch('2.2.0', '2.2.0'));

    const err = t.throws(() => assertVersionsMatch('2.2.0', '2.1.9'), { instanceOf: ReleaseError });
    t.true(err!.message.includes('2.2.0'));
    t.true(err!.message.includes('2.1.9'));
});

// ── releaseTagName ────────────────────────────────────────────────────────────────────────────

test('releaseTagName: gola wersja, prefiks v to blad', t => {
    t.is(releaseTagName('2.2.0'), '2.2.0');
    t.throws(() => releaseTagName('v2.2.0'));
    t.throws(() => releaseTagName('2.2'));
    t.throws(() => releaseTagName(''));
});

// ── confirmedVersionOf ────────────────────────────────────────────────────────────────────────

test('confirmedVersionOf: sam ENTER bierze wersje z package.json', t => {
    t.is(confirmedVersionOf('', '2.2.0'), '2.2.0');
    t.is(confirmedVersionOf('  \n', '2.2.0'), '2.2.0');
    t.is(confirmedVersionOf('2.3.0', '2.2.0'), '2.3.0');
    t.is(confirmedVersionOf(' 2.3.0 ', '2.2.0'), '2.3.0');
});

test('confirmedVersionOf: jednoznakowa odpowiedz to ODPOWIEDZ, nie fallback na package.json', t => {
    // Granica: kazdy niepusty wpis po trimie wraca ZNAK W ZNAK, takze dlugosci 1.
    // Gdyby jednoznakowy wpis leciał na fallback, literowka usera cicho wydalaby
    // wersje z package.json zamiast oblac walidacje w releaseTagName.
    t.is(confirmedVersionOf('7', '2.2.0'), '7');
    t.is(confirmedVersionOf('  x  ', '2.2.0'), 'x');
    t.throws(() => releaseTagName(confirmedVersionOf('7', '2.2.0')), { instanceOf: ReleaseError });
});
