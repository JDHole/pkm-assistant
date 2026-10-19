/**
 * Stan wydania dla workflow "Release" (`.github/scripts/release-state.mjs`): opublikowane
 * wydanie jest niezmienne, przerwana publikacja dostaje tylko brakujące pliki, a nieznany albo
 * nieczytelny stan GitHuba niczego nie publikuje. Dane wydania 2.3.1 to odczyt `gh api`
 * z 2026-10-19.
 */
import test from 'ava';
import { classifyRelease, decideAfterPublish, decideBeforePublish, fetchRelease } from './.github/scripts/release-state.mjs';

const ID_2_3_1 = 397199295;
const ASSETS_2_3_1 = [
    { name: 'main.js', size: 2056136, state: 'uploaded' },
    { name: 'manifest.json', size: 434, state: 'uploaded' },
    { name: 'styles.css', size: 36716, state: 'uploaded' },
];
const RELEASE_2_3_1 = { id: ID_2_3_1, draft: false, assets: ASSETS_2_3_1 };
const notFound = () => { throw Object.assign(new Error('exit 1'), { stderr: 'gh: Not Found (HTTP 404)\n' }); };

test('brak opublikowanego wydania: przed publikacją wolno je utworzyć', t => {
    const verdict = classifyRelease(fetchRelease('JDHole/pkm-assistant', '9.9.9', notFound));
    t.deepEqual(verdict, { state: 'absent', id: null, missing: ['main.js', 'manifest.json', 'styles.css'], broken: [] });
    t.deepEqual(decideBeforePublish('9.9.9', verdict), { code: 0, line: 'absent' });
});

test('wydanie 2.3.1 z GitHuba jest kompletne, więc ponowny push taga jest odrzucany', t => {
    const verdict = classifyRelease(fetchRelease('JDHole/pkm-assistant', '2.3.1', () => JSON.stringify(RELEASE_2_3_1)));
    t.deepEqual(verdict, { state: 'complete', id: ID_2_3_1, missing: [], broken: [] });
    t.deepEqual(decideBeforePublish('2.3.1', verdict), {
        code: 1,
        line: '::error::Wydanie 2.3.1 jest już opublikowane w komplecie i jest niezmienne. Poprawka idzie w nowym numerze patch; nie przesuwaj taga.',
    });
});

test('dodatkowy plik w wydaniu nie zdejmuje ochrony z kompletu', t => {
    const assets = [...ASSETS_2_3_1, { name: 'checksums.txt', size: 120, state: 'uploaded' }];
    t.is(decideBeforePublish('2.3.1', classifyRelease({ id: ID_2_3_1, assets })).code, 1);
});

test('przerwana publikacja: dogranie tylko brakujących plików pod id tego wydania', t => {
    const verdict = classifyRelease({ id: 42, assets: ASSETS_2_3_1.slice(0, 1) });
    t.deepEqual(verdict, { state: 'partial', id: 42, missing: ['manifest.json', 'styles.css'], broken: [] });
    t.deepEqual(decideBeforePublish('2.3.2', verdict), { code: 0, line: 'partial 42 manifest.json styles.css' });
});

test('plik wgrany do połowy albo pusty blokuje publikację zamiast udawać obecny', t => {
    const starter = classifyRelease({ id: 42, assets: [{ name: 'main.js', size: 2056136, state: 'starter' }, ASSETS_2_3_1[1]] });
    t.deepEqual(starter, { state: 'broken', id: 42, missing: ['styles.css'], broken: ['main.js'] });
    t.deepEqual(decideBeforePublish('2.3.2', starter), {
        code: 1,
        line: '::error::Wydanie 2.3.2 ma uszkodzone pliki (main.js: wgrane do połowy albo puste). Workflow niczego nie nadpisuje - usuń je ręcznie na stronie wydania i uruchom bieg ponownie.',
    });
    const empty = classifyRelease({ id: 42, assets: [ASSETS_2_3_1[0], ASSETS_2_3_1[1], { name: 'styles.css', size: 0, state: 'uploaded' }] });
    t.deepEqual(empty, { state: 'broken', id: 42, missing: [], broken: ['styles.css'] });
});

test('błąd odczytu inny niż 404 zatrzymuje publikację', t => {
    const serverError = () => { throw Object.assign(new Error('exit 1'), { stderr: 'gh: Bad Gateway (HTTP 502)\n' }); };
    t.throws(() => fetchRelease('JDHole/pkm-assistant', '2.3.2', serverError), { message: /Nie da się odczytać stanu wydania 2\.3\.2 z GitHuba: gh: Bad Gateway \(HTTP 502\)/ });
});

test('odpowiedź bez id i listy plików nie jest brana za brak wydania', t => {
    for (const body of ['<html>', 'null', '{}', '{"id":1,"assets":"invalid"}', '{"assets":[]}']) {
        t.throws(() => fetchRelease('JDHole/pkm-assistant', '2.3.2', () => body), { message: /GitHub zwrócił (nieczytelny stan|stan wydania 2\.3\.2 bez id)/ }, body);
    }
    t.throws(() => classifyRelease({} as never), { message: 'Stan wydania nie ma oczekiwanego kształtu (id i lista plików).' });
});

test('po publikacji sukces jest tylko przy komplecie plików w opublikowanym wydaniu', t => {
    t.deepEqual(decideAfterPublish('2.3.1', classifyRelease(RELEASE_2_3_1)), { code: 0, line: 'Wydanie 2.3.1 opublikowane w komplecie (main.js, manifest.json, styles.css).' });
    t.deepEqual(decideAfterPublish('2.3.2', classifyRelease({ id: 42, assets: ASSETS_2_3_1.slice(0, 2) })), {
        code: 1,
        line: '::error::Po publikacji wydanie 2.3.2 nie jest kompletne (brakuje: styles.css; uszkodzone: -).',
    });
    t.deepEqual(decideAfterPublish('2.3.2', classifyRelease(null)), {
        code: 1,
        line: '::error::Po publikacji wydanie 2.3.2 nie jest kompletne (GitHub nie widzi opublikowanego wydania).',
    });
});
