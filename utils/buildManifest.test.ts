/**
 * `esbuild.js` nigdy nie miał ani jednego testu jednostkowego na swoją logikę
 * (stemplowanie manifestu, rozbiór `DESTINATION_VAULTS`, katalog docelowy deployu).
 * Ten plik domyka tę lukę na czystych funkcjach wyjętych do `utils/buildManifest.ts`.
 */
import test from 'ava';
import path from 'node:path';
import {
    DIST_ARTIFACTS,
    parseDestinationVaults,
    pluginDeployDir,
    stampManifestVersion,
} from './buildManifest.js';

// ── stampManifestVersion — NAJWAŻNIEJSZY test klastra ────────────────────────────────────────

test('stampManifestVersion: serializacja bajt w bajt jak w gicie, bez konczacego \\n', t => {
    const manifest = {
        id: 'pkm-assistant',
        name: 'PKM Assistant',
        author: 'JDHole',
        description: 'opis',
        minAppVersion: '1.11.0',
        authorUrl: 'https://github.com/JDHole',
        isDesktopOnly: true,
        version: '2.1.9',
    };
    // Zamierzone: bez koncowej nowej linii, dokladnie jak plik w gicie.
    const text = JSON.stringify(manifest, null, 2);

    const result = stampManifestVersion(text, '9.9.9');

    const expected = JSON.stringify({ ...manifest, version: '9.9.9' }, null, 2);
    t.is(result, expected);
    t.false(result.endsWith('\n'), 'stemplowanie nie ma prawa dopisac koncowej nowej linii');
});

test('stampManifestVersion: idempotencja - stemplowanie juz aktualnej wersji nie zmienia bajtu', t => {
    const manifest = { id: 'pkm-assistant', version: '2.2.0' };
    const text = JSON.stringify(manifest, null, 2);

    t.is(stampManifestVersion(text, '2.2.0'), text);
});

// ── parseDestinationVaults ────────────────────────────────────────────────────────────────────

test('parseDestinationVaults: pusty env = zero deployu', t => {
    t.deepEqual(parseDestinationVaults(undefined), []);
    t.deepEqual(parseDestinationVaults(''), []);
    t.deepEqual(parseDestinationVaults('   '), []);
});

test('parseDestinationVaults: rozdziela przecinkami i przycina biale znaki', t => {
    t.deepEqual(parseDestinationVaults('a,,b'), ['a', 'b']);
    t.deepEqual(parseDestinationVaults(' a , b '), ['a', 'b']);
    t.deepEqual(parseDestinationVaults('a'), ['a']);
});

// ── pluginDeployDir ───────────────────────────────────────────────────────────────────────────

test('pluginDeployDir: <vault>/<configDir>/plugins/<manifest.id>', t => {
    t.is(
        pluginDeployDir('/v', '.obsidian', 'pkm-assistant', path.join),
        path.join('/v', '.obsidian', 'plugins', 'pkm-assistant'),
    );
});

test('pluginDeployDir: id bierze sie z argumentu, nie z literalu', t => {
    const a = pluginDeployDir('/v', '.obsidian', 'pkm-assistant', path.join);
    const b = pluginDeployDir('/v', '.obsidian', 'inne-id', path.join);

    t.not(a, b);
    t.is(b, path.join('/v', '.obsidian', 'plugins', 'inne-id'));
});

test('pluginDeployDir: nazwa folderu configu tez bierze sie z argumentu, nie z literalu', t => {
    // Nazwe folderu konfiguracji user vaulta docelowego moze przemianowac; build podaje ja
    // ze zmiennej DESTINATION_CONFIG_DIR, a ta funkcja nie zna zadnej nazwy domyslnej.
    t.is(
        pluginDeployDir('/v', '.mojkonfig', 'pkm-assistant', path.join),
        path.join('/v', '.mojkonfig', 'plugins', 'pkm-assistant'),
    );
    t.not(
        pluginDeployDir('/v', '.mojkonfig', 'pkm-assistant', path.join),
        pluginDeployDir('/v', '.obsidian', 'pkm-assistant', path.join),
    );
});

// ── DIST_ARTIFACTS ────────────────────────────────────────────────────────────────────

test('DIST_ARTIFACTS to dokladnie trzy pliki, w kolejnosci', t => {
    t.deepEqual([...DIST_ARTIFACTS], ['main.js', 'manifest.json', 'styles.css']);
});
