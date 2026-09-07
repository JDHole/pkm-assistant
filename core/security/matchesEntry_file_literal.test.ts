/**
 * AUD-testy-007 — `AccessGuard._matchesEntry`, gałąź wpisu whitelisty wskazującego
 * POJEDYNCZY PLIK (ostatni segment wzorca zawiera kropkę → dopasowanie DOSŁOWNE,
 * core/security/AccessGuard.ts:648-655, `return normalizedPath === normalizedPattern;`).
 *
 * Nie miała testu z ŻADNEJ strony (`_matchesEntry` występowało w testach tylko w
 * komentarzach). Ryzyko: gałąź FOLDEROWA tuż nad nią dopasowuje PREFIKSEM — klasyczna
 * regresja to skopiowanie tego wzorca (albo zmiana `===` na `startsWith`) do gałęzi
 * plikowej, co wpuściłoby sąsiadów o tej samej podstawie nazwy (`lista.md.backup`,
 * `lista.md/cokolwiek`) agentowi, który miał dostęp do JEDNEGO konkretnego pliku.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import type { GuardedAgent } from './AccessGuard.js';

const agentZPlikiemWWhitelist: GuardedAgent = {
    name: 'Tester',
    permissions: { guidance_mode: false },
    focusFolders: ['Notatki/lista.md'],
};

test.before(() => {
    AccessGuard.setNoGoFolders([]);
});

test('przepuszcza: dokładna ścieżka pliku z whitelisty', t => {
    const d = AccessGuard.checkAccess(agentZPlikiemWWhitelist, 'Notatki/lista.md', 'read');
    t.true(d.allowed, d.reason);
});

test('blokuje: plik o tym samym prefiksie, ale innym rozszerzeniem/sufiksem (lista.md.backup)', t => {
    const d = AccessGuard.checkAccess(agentZPlikiemWWhitelist, 'Notatki/lista.md.backup', 'read');
    t.false(d.allowed, 'dopasowanie dosłowne wpuściło sąsiada o tym samym prefiksie — startsWith zamiast ===');
});

test('blokuje: ścieżka traktująca plik z whitelisty jak FOLDER (lista.md/x.md)', t => {
    const d = AccessGuard.checkAccess(agentZPlikiemWWhitelist, 'Notatki/lista.md/x.md', 'read');
    t.false(d.allowed, 'wpis plikowy wpuścił "podfolder" nieistniejącego pliku');
});

test('blokuje: nazwa z tym samym prefiksem bez separatora (lista.mdx)', t => {
    const d = AccessGuard.checkAccess(agentZPlikiemWWhitelist, 'Notatki/lista.mdx', 'read');
    t.false(d.allowed);
});

test('blokuje: inny plik w tym samym folderze', t => {
    const d = AccessGuard.checkAccess(agentZPlikiemWWhitelist, 'Notatki/inna.md', 'read');
    t.false(d.allowed);
});

test('_matchesEntry bezpośrednio: dosłowne porównanie całej ścieżki, nie prefiks', t => {
    t.true(AccessGuard._matchesEntry('Notatki/lista.md', 'Notatki/lista.md'));
    t.false(AccessGuard._matchesEntry('Notatki/lista.md.backup', 'Notatki/lista.md'));
    t.false(AccessGuard._matchesEntry('Notatki/lista.md/x', 'Notatki/lista.md'));
    t.false(AccessGuard._matchesEntry('Notatki/lista.mdx', 'Notatki/lista.md'));
});

test('kontrast: wpis FOLDEROWY (bez kropki w ostatnim segmencie) NADAL dopasowuje prefiksem — to nie regresja tej gałęzi', t => {
    // Dowodzi, że test wyżej naprawdę mierzy gałąź PLIKOWĄ: ten sam mechanizm dla folderu
    // ma inny, słuszny kontrakt (JSDoc `_matchesEntry`: "Projects" matches "Projects/file.md").
    t.true(AccessGuard._matchesEntry('Notatki/sub/x.md', 'Notatki'));
    t.true(AccessGuard._matchesEntry('Notatki/x.md', 'Notatki'));
    t.false(AccessGuard._matchesEntry('NotatkiInne/x.md', 'Notatki'), 'folder nie ma zjadać sąsiada z tym samym prefiksem nazwy');
});
