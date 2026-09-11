/**
 * Strażnik dryfu `eslint.config.js`.
 *
 * `MODULE_NAMES` tam jest wpisana jako STATYCZNA, posortowana lista (nie
 * `fs.readdirSync` w runtime — patrz komentarz przy stałej w `eslint.config.js`):
 * walidator katalogu Obsidiana lintuje `eslint.config.js` bez typów Node, więc
 * dynamiczny listing katalogu w tym pliku byłby dla niego typem-błędem.
 *
 * Cena statycznej listy to dryf — ten test jest jej jedynym strażnikiem: nowy albo
 * usunięty katalog w `modules/` bez aktualizacji `MODULE_NAMES` wywala go od razu
 * (bez tego strażnika `no-restricted-imports` po cichu przestałby pilnować barrela
 * nowego modułu).
 */
import test from 'ava';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULE_NAMES } from './eslint.config.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

test('MODULE_NAMES w eslint.config.js zgadza sie z realnym listingiem modules/ na dysku', t => {
    const onDisk = readdirSync(join(ROOT, 'modules'), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();

    t.deepEqual([...MODULE_NAMES].sort(), onDisk);
});

test('MODULE_NAMES jest juz posortowana w pliku (kolejnosc czytelna przy review)', t => {
    t.deepEqual([...MODULE_NAMES], [...MODULE_NAMES].sort());
});
