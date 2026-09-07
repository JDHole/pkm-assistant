import test from 'ava';
import { VaultMap, VAULT_MAP_PATH, LEGACY_VAULT_MAP_PATH } from './VaultMap.js';
import type { VaultMapVault } from './VaultMap.js';

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
