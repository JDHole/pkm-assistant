import test from 'ava';
import { VaultMap, VAULT_MAP_PATH, LEGACY_VAULT_MAP_PATH } from './VaultMap.js';
import type { VaultMapVault } from './VaultMap.js';
import { setLocale } from '../../core/i18n/index.js';

type FakeVault = VaultMapVault & { files: Map<string, string> };

function fakeVault(initial: Record<string, string> = {}): FakeVault {
    const files = new Map(Object.entries(initial));
    const dirs = new Set(['.pkm-assistant']);
    return {
        adapter: {
            async exists(path: string) {
                return files.has(path) || dirs.has(path);
            },
            async read(path: string) {
                if (!files.has(path)) throw new Error(`Missing ${path}`);
                return files.get(path) as string;
            },
            async write(path: string, content: string) {
                files.set(path, content);
            },
            async mkdir(path: string) {
                dirs.add(path);
            },
        },
        files,
    };
}

test('VaultMap migrates legacy Agora map to agents path', async t => {
    const legacy = '# Globalna Mapa Vaulta\n\n## Strefy uzytkownika\n- **Projekty/** - opis\n';
    const vault = fakeVault({ [LEGACY_VAULT_MAP_PATH]: legacy });
    const map = new VaultMap(vault);

    await map.initialize();

    t.is(vault.files.get(VAULT_MAP_PATH), legacy);
    t.is(await map.readVaultMap(), legacy);
});

test.serial('starter mapy vaulta jest w języku interfejsu', async t => {
    t.teardown(() => setLocale('en'));

    setLocale('en');
    const en = fakeVault();
    await new VaultMap(en).initialize();
    const mapaEn = en.files.get(VAULT_MAP_PATH)!;
    t.true(mapaEn.includes('## System zones'));
    t.true(mapaEn.includes('## No-Go'));
    t.false(mapaEn.includes('Strefy'));

    setLocale('pl');
    const pl = fakeVault();
    await new VaultMap(pl).initialize();
    const mapaPl = pl.files.get(VAULT_MAP_PATH)!;
    t.true(mapaPl.includes('## Strefy systemowe'));
    t.true(mapaPl.includes('## Strefy uzytkownika'));
});

test.serial('istniejąca mapa vaulta NIE jest podmieniana przy zmianie języka', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    const vault = fakeVault();
    await new VaultMap(vault).initialize();
    const zasiew = vault.files.get(VAULT_MAP_PATH)!;

    setLocale('en');
    await new VaultMap(vault).initialize();
    t.is(vault.files.get(VAULT_MAP_PATH), zasiew);
});

test('VaultMap extracts folder descriptions from bold and plain list lines', async t => {
    const vault = fakeVault({
        [VAULT_MAP_PATH]: [
            '# Map',
            '- **Projekty/** - glowne projekty',
            '* Inbox: wiadomosci',
        ].join('\n'),
    });
    const map = new VaultMap(vault);

    const descriptions = await map.getVaultMapDescriptions();

    t.is(descriptions.Projekty, 'glowne projekty');
    t.is(descriptions.Inbox, 'wiadomosci');
});
