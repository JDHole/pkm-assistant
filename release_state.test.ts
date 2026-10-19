/**
 * Stan wydania dla workflow "Release" (`.github/scripts/release-state.mjs`): opublikowane
 * wydanie jest niezmienne, przerwana publikacja dostaje tylko brakujące pliki z tego samego
 * buildu, a nieznany albo nieczytelny stan GitHuba niczego nie publikuje. Dane wydania 2.3.1
 * (id, rozmiary, sumy sha256) to odczyt `gh api` z 2026-10-19.
 */
import test from 'ava';
import { classifyRelease, decideAfterPublish, decideBeforePublish, fetchRelease, localDigestsOf } from './.github/scripts/release-state.mjs';

const ID_2_3_1 = 397199295;
const DIGESTS_2_3_1 = {
    'main.js': 'sha256:c2b31e8322724eadecb36f0d3e1c09aff66e995828271b0a48b41f4869e4a48f',
    'manifest.json': 'sha256:cbb0bb686edee43d48afd8cf8c7efe7280ff27f190aeca8750efffec872d1ba9',
    'styles.css': 'sha256:1b9be0fa803485d4dc9f3234651b82852a4537025d0902ed32291af69f1f092b',
};
const ASSETS_2_3_1 = [
    { name: 'main.js', size: 2056136, state: 'uploaded', digest: DIGESTS_2_3_1['main.js'] },
    { name: 'manifest.json', size: 434, state: 'uploaded', digest: DIGESTS_2_3_1['manifest.json'] },
    { name: 'styles.css', size: 36716, state: 'uploaded', digest: DIGESTS_2_3_1['styles.css'] },
];
const RELEASE_2_3_1 = { id: ID_2_3_1, draft: false, assets: ASSETS_2_3_1 };
const notFound = () => { throw Object.assign(new Error('exit 1'), { stderr: 'gh: Not Found (HTTP 404)\n' }); };

test('brak opublikowanego wydania: przed publikacją wolno je utworzyć', t => {
    const verdict = classifyRelease(fetchRelease('JDHole/pkm-assistant', '9.9.9', notFound));
    t.deepEqual(verdict, { state: 'absent', id: null, missing: ['main.js', 'manifest.json', 'styles.css'], broken: [], foreign: [] });
    t.deepEqual(decideBeforePublish('9.9.9', verdict), { code: 0, line: 'absent' });
});

test('wydanie 2.3.1 z GitHuba jest kompletne, więc ponowny push taga jest odrzucany', t => {
    const verdict = classifyRelease(fetchRelease('JDHole/pkm-assistant', '2.3.1', () => JSON.stringify(RELEASE_2_3_1)));
    t.deepEqual(verdict, { state: 'complete', id: ID_2_3_1, missing: [], broken: [], foreign: [] });
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
    const verdict = classifyRelease({ id: 42, assets: ASSETS_2_3_1.slice(0, 1) }, DIGESTS_2_3_1);
    t.deepEqual(verdict, { state: 'partial', id: 42, missing: ['manifest.json', 'styles.css'], broken: [], foreign: [] });
    t.deepEqual(decideBeforePublish('2.3.2', verdict), { code: 0, line: 'partial 42 manifest.json styles.css' });
});

test('wgrany plik z innego buildu blokuje dogranie reszty', t => {
    const otherBuild = { ...DIGESTS_2_3_1, 'main.js': 'sha256:' + '0'.repeat(64) };
    const verdict = classifyRelease({ id: 42, assets: ASSETS_2_3_1.slice(0, 1) }, otherBuild);
    t.deepEqual(verdict, { state: 'broken', id: 42, missing: ['manifest.json', 'styles.css'], broken: [], foreign: ['main.js'] });
    t.deepEqual(decideBeforePublish('2.3.2', verdict), {
        code: 1,
        line: '::error::Wydanie 2.3.2 ma pliki, których nie wolno uzupełnić (main.js: z innego buildu niż ten bieg). Workflow niczego nie nadpisuje - usuń je ręcznie na stronie wydania i uruchom bieg ponownie.',
    });
});

test('plik wgrany do połowy albo pusty blokuje publikację zamiast udawać obecny', t => {
    const starter = classifyRelease({ id: 42, assets: [{ name: 'main.js', size: 2056136, state: 'starter' }, ASSETS_2_3_1[1]] });
    t.deepEqual(starter, { state: 'broken', id: 42, missing: ['styles.css'], broken: ['main.js'], foreign: [] });
    t.deepEqual(decideBeforePublish('2.3.2', starter), {
        code: 1,
        line: '::error::Wydanie 2.3.2 ma pliki, których nie wolno uzupełnić (main.js: wgrane do połowy albo puste). Workflow niczego nie nadpisuje - usuń je ręcznie na stronie wydania i uruchom bieg ponownie.',
    });
    const empty = classifyRelease({ id: 42, assets: [ASSETS_2_3_1[0], ASSETS_2_3_1[1], { name: 'styles.css', size: 0, state: 'uploaded' }] });
    t.deepEqual(empty, { state: 'broken', id: 42, missing: [], broken: ['styles.css'], foreign: [] });
});

test('błąd odczytu inny niż 404 zatrzymuje publikację', t => {
    const serverError = () => { throw Object.assign(new Error('exit 1'), { stderr: 'gh: Bad Gateway (HTTP 502)\n' }); };
    t.throws(() => fetchRelease('JDHole/pkm-assistant', '2.3.2', serverError), { message: /Nie da się odczytać stanu wydania 2\.3\.2 z GitHuba: gh: Bad Gateway \(HTTP 502\)/ });
});

test('odpowiedź bez id, listy plików albo nazw plików nie jest brana za brak wydania', t => {
    const bodies = ['<html>', 'null', '{}', '{"id":1,"assets":"invalid"}', '{"assets":[]}', '{"id":1,"assets":[null]}', '{"id":1,"assets":[{"size":10}]}'];
    for (const body of bodies) {
        t.throws(() => fetchRelease('JDHole/pkm-assistant', '2.3.2', () => body), { message: /GitHub zwrócił (nieczytelny stan|stan wydania 2\.3\.2 bez id)/ }, body);
    }
    t.throws(() => classifyRelease({} as never), { message: 'Stan wydania nie ma oczekiwanego kształtu (id i lista plików z nazwami).' });
});

test('po publikacji sukces jest tylko przy komplecie plików z tego buildu', t => {
    t.deepEqual(decideAfterPublish('2.3.1', classifyRelease(RELEASE_2_3_1, DIGESTS_2_3_1)), { code: 0, line: 'Wydanie 2.3.1 opublikowane w komplecie (main.js, manifest.json, styles.css).' });
    t.deepEqual(decideAfterPublish('2.3.2', classifyRelease({ id: 42, assets: ASSETS_2_3_1.slice(0, 2) })), {
        code: 1,
        line: '::error::Po publikacji wydanie 2.3.2 nie jest kompletne (brakuje: styles.css).',
    });
    t.deepEqual(decideAfterPublish('2.3.2', classifyRelease(null)), {
        code: 1,
        line: '::error::Po publikacji wydanie 2.3.2 nie jest kompletne (GitHub nie widzi opublikowanego wydania).',
    });
    const starter = classifyRelease({ id: 42, assets: [ASSETS_2_3_1[0], ASSETS_2_3_1[1], { ...ASSETS_2_3_1[2], state: 'starter' }] });
    t.deepEqual(decideAfterPublish('2.3.2', starter), {
        code: 1,
        line: '::error::Po publikacji wydanie 2.3.2 nie jest kompletne (styles.css: wgrane do połowy albo puste).',
    });
    const foreign = classifyRelease(RELEASE_2_3_1, { ...DIGESTS_2_3_1, 'styles.css': 'sha256:' + 'f'.repeat(64) });
    t.deepEqual(decideAfterPublish('2.3.2', foreign), {
        code: 1,
        line: '::error::Po publikacji wydanie 2.3.2 nie jest kompletne (styles.css: z innego buildu niż ten bieg).',
    });
});

test('suma lokalnego pliku ma format pola digest z GitHuba', t => {
    const files: Record<string, string> = { 'main.js': 'a', 'manifest.json': 'b', 'styles.css': '' };
    const digests = localDigestsOf('dist', (p: string) => Buffer.from(files[p.replace(/^dist[\\/]/, '')]));
    t.deepEqual(digests, {
        'main.js': 'sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
        'manifest.json': 'sha256:3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d',
        'styles.css': 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
});
