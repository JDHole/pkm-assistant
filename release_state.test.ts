/**
 * Stan wydania dla workflow "Release" (`.github/scripts/release-state.mjs`): opublikowane
 * wydanie jest niezmienne, przerwana publikacja dostaje tylko brakujące pliki, a nieznany stan
 * GitHuba niczego nie publikuje. Dane wydania 2.3.1 to odczyt `gh api` z 2026-10-19.
 */
import test from 'ava';
import { classifyRelease, fetchRelease } from './.github/scripts/release-state.mjs';

const ASSETS_2_3_1 = [
    { name: 'main.js', size: 2056136, state: 'uploaded' },
    { name: 'manifest.json', size: 434, state: 'uploaded' },
    { name: 'styles.css', size: 36716, state: 'uploaded' },
];

test('brak opublikowanego wydania: trzeba je utworzyć ze wszystkimi plikami', t => {
    t.deepEqual(classifyRelease(null), { state: 'absent', missing: ['main.js', 'manifest.json', 'styles.css'], broken: [] });
});

test('wydanie 2.3.1 z GitHuba jest kompletne, więc ponowny push taga zostanie odrzucony', t => {
    t.deepEqual(classifyRelease({ draft: false, assets: ASSETS_2_3_1 }), { state: 'complete', missing: [], broken: [] });
});

test('dodatkowy plik w wydaniu nie zdejmuje ochrony z kompletu', t => {
    const assets = [...ASSETS_2_3_1, { name: 'checksums.txt', size: 120, state: 'uploaded' }];
    t.deepEqual(classifyRelease({ assets }), { state: 'complete', missing: [], broken: [] });
});

test('przerwana publikacja: dograć wolno tylko brakujące pliki', t => {
    t.deepEqual(classifyRelease({ assets: ASSETS_2_3_1.slice(0, 1) }), { state: 'partial', missing: ['manifest.json', 'styles.css'], broken: [] });
});

test('plik wgrany do połowy albo pusty blokuje publikację zamiast udawać obecny', t => {
    const starter = [{ name: 'main.js', size: 2056136, state: 'starter' }, ASSETS_2_3_1[1]];
    t.deepEqual(classifyRelease({ assets: starter }), { state: 'broken', missing: ['styles.css'], broken: ['main.js'] });
    const empty = [ASSETS_2_3_1[0], ASSETS_2_3_1[1], { name: 'styles.css', size: 0, state: 'uploaded' }];
    t.deepEqual(classifyRelease({ assets: empty }), { state: 'broken', missing: [], broken: ['styles.css'] });
});

test('404 z GitHuba znaczy brak wydania, a odpowiedź trafia do oceny 1:1', t => {
    const notFound = () => { throw Object.assign(new Error('exit 1'), { stderr: 'gh: Not Found (HTTP 404)\n' }); };
    t.is(fetchRelease('JDHole/pkm-assistant', '9.9.9', notFound), null);
    const found = () => JSON.stringify({ draft: false, assets: ASSETS_2_3_1 });
    t.deepEqual(fetchRelease('JDHole/pkm-assistant', '2.3.1', found), { draft: false, assets: ASSETS_2_3_1 });
});

test('błąd odczytu inny niż 404 albo nieczytelna odpowiedź zatrzymują publikację', t => {
    const serverError = () => { throw Object.assign(new Error('exit 1'), { stderr: 'gh: Bad Gateway (HTTP 502)\n' }); };
    t.throws(() => fetchRelease('JDHole/pkm-assistant', '2.3.2', serverError), { message: /Nie da się odczytać stanu wydania 2\.3\.2 z GitHuba: gh: Bad Gateway \(HTTP 502\)/ });
    t.throws(() => fetchRelease('JDHole/pkm-assistant', '2.3.2', () => '<html>'), { message: 'GitHub zwrócił nieczytelny stan wydania 2.3.2.' });
});
