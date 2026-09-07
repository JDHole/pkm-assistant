/**
 * AUD-testy-006 — przemianowany folder konfiguracji Obsidiana (`Vault#configDir`) jako
 * strefa No-Go. `AccessGuard.setConfigDir` (core/security/AccessGuard.ts:112-116) dokłada
 * NAZWĘ przemianowanego folderu do `_noGoFolders`, wpięte w `setNoGoFolders` (linia 130:
 * `const all = [...SYSTEM_NO_GO, AccessGuard._configDir, ...userFolders]`). Ta gałąź nie
 * miała ŻADNEGO testu — `setConfigDir` nie występuje w żadnym `*.test.ts` w repo.
 *
 * PUŁAPKA: domyślna wartość `.obsidian` jest i tak zablokowana przez `SYSTEM_NO_GO`
 * (hardcoded), więc test WYŁĄCZNIE na `.obsidian` nie dowodzi niczego o tej gałęzi — mutacja
 * usuwająca `_configDir` ze scalania i tak by przeszła. Testy niżej dlatego świadomie używają
 * nazwy INNEJ niż `.obsidian` (przemianowany folder), żeby dowód dotyczył realnie gałęzi
 * `_configDir`, nie hardcoded wpisu.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import type { GuardedAgent } from './AccessGuard.js';

const agentZCalymVaultem: GuardedAgent = { name: 'Tester', permissions: { guidance_mode: true }, focusFolders: [] };

// Static state na AccessGuard — testy w tym pliku muszą iść po kolei (test.serial) i
// posprzątać po sobie, inaczej zanieczyszczą się nawzajem (ten sam wzorzec co nogo_case.test.ts).
test.serial.afterEach(() => {
    AccessGuard.setConfigDir('.obsidian');
    AccessGuard.setNoGoFolders([]);
});

test.serial('blokuje (read): przemianowany folder configu (.mojkonfig) trafia do No-Go', t => {
    AccessGuard.setConfigDir('.mojkonfig');
    AccessGuard.setNoGoFolders([]);

    const d = AccessGuard.checkAccess(agentZCalymVaultem, '.mojkonfig/plugins/zly/main.js', 'read');
    t.false(d.allowed, 'przemianowany folder configu przeszedł bramkę No-Go');
    t.regex(d.reason, /No-Go/i, `odmowa przyszła z innej bramki niż No-Go (reason: ${d.reason})`);
});

test.serial('blokuje (write): przemianowany folder configu odmawia też zapisu', t => {
    AccessGuard.setConfigDir('.mojkonfig');
    AccessGuard.setNoGoFolders([]);

    const d = AccessGuard.checkAccess(agentZCalymVaultem, '.mojkonfig/plugins/zly/data.json', 'write');
    t.false(d.allowed);
    t.regex(d.reason, /No-Go/i);
});

test.serial('przepuszcza: zwykła notatka NIE jest dotknięta przemianowaniem folderu configu', t => {
    AccessGuard.setConfigDir('.mojkonfig');
    AccessGuard.setNoGoFolders([]);

    t.true(AccessGuard.checkAccess(agentZCalymVaultem, 'Notatki/dziennik.md', 'read').allowed);
});

test.serial('mechanizm: gałąź działa PRZEZ _configDir, nie tylko dzięki hardcoded SYSTEM_NO_GO', t => {
    // Kontrola (nie dowód na TĘ gałąź — `.obsidian` blokuje TAK CZY OWAK przez SYSTEM_NO_GO):
    AccessGuard.setConfigDir('.obsidian');
    AccessGuard.setNoGoFolders([]);
    t.false(
        AccessGuard.checkAccess(agentZCalymVaultem, '.obsidian/plugins/x/main.js', 'read').allowed,
        'baseline (nazwa domyślna) zepsuty — sam SYSTEM_NO_GO nie działa',
    );

    // Realny dowód na gałąź `_configDir`: nazwa RÓŻNA od `.obsidian` blokuje WYŁĄCZNIE
    // dzięki setConfigDir — SYSTEM_NO_GO jej nie zna.
    AccessGuard.setConfigDir('.workspace-config');
    AccessGuard.setNoGoFolders([]);
    t.false(
        AccessGuard.checkAccess(agentZCalymVaultem, '.workspace-config/plugins/x/main.js', 'read').allowed,
        'przemianowany folder configu NIE zablokował — gałąź _configDir jest martwa albo pominięta w scalaniu',
    );
});

test.serial('kolejność wywołań: setConfigDir PO setNoGoFolders NIE działa wstecz (migawka, nie żywy odczyt)', t => {
    // Dokumentuje realny kontrakt: `_noGoFolders` to migawka policzona W CHWILI wywołania
    // `setNoGoFolders` (linia 130 scala `_configDir` z TEGO momentu). `src/main.ts:568-569`
    // woła setConfigDir PRZED setNoGoFolders celowo — poprawna kolejność jest zdrowa
    // (testy wyżej), ale odwrócona po cichu wypuszcza przemianowany folder configu.
    AccessGuard.setNoGoFolders([]); // configDir w tym momencie to jeszcze '.obsidian' (z afterEach)
    AccessGuard.setConfigDir('.mojkonfig'); // za późno — `_noGoFolders` już policzone bez niego

    // Uwaga review (opus, 02.09): asercja mierzy MECHANIZM (wpis nie wszedł do migawki), a NIE
    // pinuje `allowed === true` — gdyby ktoś kiedyś utwardził `_noGoFolders` na żywy odczyt
    // `_configDir` (czyste ulepszenie), ten test ma pęknąć TYLKO jeśli poniższy inwariant
    // przestanie opisywać rzeczywistość, a nie naciskać na cofnięcie ulepszenia.
    t.false(
        AccessGuard._noGoFolders.some((f: string) => f.includes('mojkonfig')),
        'setConfigDir PO setNoGoFolders MIAŁ nie zdążyć wejść do migawki — jeśli wpis tu jest, ' +
        '_noGoFolders stało się żywym odczytem _configDir i test wyżej ("kolejność") jest już nieaktualny',
    );
});
