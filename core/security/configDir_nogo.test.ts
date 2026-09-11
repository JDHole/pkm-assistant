/**
 * Folder konfiguracji Obsidiana (`Vault#configDir`) jako strefa No-Go — i co się dzieje,
 * zanim strażnik pozna jego nazwę.
 *
 * KONTRAKT (od fali B): `SYSTEM_NO_GO` to WYŁĄCZNIE `['.trash']`. Nazwy folderu konfiguracji
 * nie ma nigdzie na sztywno — przychodzi z żywego `Vault#configDir` przez `setConfigDir`,
 * a `setNoGoFolders` dokłada ją do migawki `_noGoFolders`. Dlatego `.obsidian` blokuje się
 * DOKŁADNIE tak samo jak `.mojkonfig`: bo akurat jest configDirem, nie bo jest `.obsidian`.
 *
 * Druga połowa kontraktu to fail-closed: dopóki `_configDir === null` (przed `setConfigDir`),
 * `_isNoGo` blokuje KAŻDY ukryty folder (pierwszy segment od kropki) poza `.pkm-assistant`,
 * bo nie wiadomo, który z nich jest konfiguracją. Wyjątek `.pkm-assistant` jest konieczny:
 * bebechy pluginu mają własną bramkę `_checkPkmPath` sprawdzaną PO No-Go, więc bez wyjątku
 * agent straciłby dostęp do własnej pamięci.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import type { GuardedAgent } from './AccessGuard.js';

const agentZCalymVaultem: GuardedAgent = { name: 'Tester', permissions: { guidance_mode: true }, focusFolders: [] };

// Static state na AccessGuard — testy w tym pliku muszą iść po kolei (test.serial) i
// posprzątać po sobie, inaczej zanieczyszczą się nawzajem (ten sam wzorzec co nogo_case.test.ts).
// Sprzątanie wraca do stanu STARTOWEGO procesu: configDir nieznany (`null`), pusta migawka.
// `setConfigDir` nie umie cofnąć do `null` (ignoruje puste wejście), więc idzie to polem.
test.serial.afterEach(() => {
    AccessGuard._configDir = null;
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

test.serial('mechanizm: `.obsidian` blokuje JAKO configDir, a nie z listy SYSTEM_NO_GO', t => {
    // Ten test pilnuje właśnie tego, że nazwa domyślna NIE jest już nigdzie wpisana na sztywno.
    t.deepEqual(AccessGuard.SYSTEM_NO_GO, ['.trash'], 'do SYSTEM_NO_GO wróciła nazwa folderu configu');

    AccessGuard.setConfigDir('.obsidian');
    AccessGuard.setNoGoFolders([]);
    t.true(AccessGuard._noGoFolders.includes('.obsidian'), 'configDir nie wszedł do migawki No-Go');
    t.false(
        AccessGuard.checkAccess(agentZCalymVaultem, '.obsidian/plugins/x/main.js', 'read').allowed,
        'folder konfiguracji (tu: nazwa domyślna) przeszedł bramkę No-Go',
    );

    // Dowód, że decyduje gałąź `_configDir`, a nie sama nazwa: po przemianowaniu blokuje
    // nazwa NOWA, a stara `.obsidian` staje się zwykłym ukrytym folderem.
    AccessGuard.setConfigDir('.workspace-config');
    AccessGuard.setNoGoFolders([]);
    t.false(
        AccessGuard.checkAccess(agentZCalymVaultem, '.workspace-config/plugins/x/main.js', 'read').allowed,
        'przemianowany folder configu NIE zablokował — gałąź _configDir jest martwa albo pominięta w scalaniu',
    );
    t.true(
        AccessGuard.checkAccess(agentZCalymVaultem, '.obsidian/plugins/x/main.js', 'read').allowed,
        'przy ZNANYM (innym) configDirze `.obsidian` musi być zwykłym folderem — inaczej nazwa siedzi gdzieś na sztywno',
    );
});

test.serial('kolejność wywołań: setConfigDir PO setNoGoFolders NIE działa wstecz (migawka, nie żywy odczyt)', t => {
    // Dokumentuje realny kontrakt: `_noGoFolders` to migawka policzona W CHWILI wywołania
    // `setNoGoFolders` (scala `_configDir` z TEGO momentu). `src/main.ts:542-543` woła
    // setConfigDir PRZED setNoGoFolders celowo — poprawna kolejność jest zdrowa (testy wyżej),
    // a przy odwróconej ratuje fail-closed, nie migawka.
    AccessGuard.setNoGoFolders([]); // configDir w tym momencie jeszcze NIEZNANY (null, z afterEach)
    AccessGuard.setConfigDir('.mojkonfig'); // za późno — `_noGoFolders` już policzone bez niego

    // Asercja mierzy MECHANIZM (wpis nie wszedł do migawki), a NIE pinuje `allowed === true`
    // — gdyby ktoś kiedyś utwardził `_noGoFolders` na żywy odczyt `_configDir` (czyste
    // ulepszenie), ten test ma pęknąć TYLKO jeśli poniższy inwariant przestanie opisywać
    // rzeczywistość, a nie naciskać na cofnięcie ulepszenia.
    t.false(
        AccessGuard._noGoFolders.some((f: string) => f.includes('mojkonfig')),
        'setConfigDir PO setNoGoFolders MIAŁ nie zdążyć wejść do migawki — jeśli wpis tu jest, ' +
        '_noGoFolders stało się żywym odczytem _configDir i test wyżej ("kolejność") jest już nieaktualny',
    );
});

// ─── FAIL-CLOSED: configDir jeszcze nieznany ───────────────────────────────────────────

test.serial('fail-closed: nieznany configDir blokuje KAŻDY ukryty folder', t => {
    AccessGuard.setNoGoFolders([]); // configDir = null (stan startowy procesu / po afterEach)

    const d = AccessGuard.checkAccess(agentZCalymVaultem, '.cokolwiek/x.md', 'read');
    t.false(d.allowed, 'ukryty folder przeszedł, choć nie wiadomo jeszcze, który z nich jest configiem');
    t.regex(d.reason, /No-Go/i, `odmowa przyszła z innej bramki niż No-Go (reason: ${d.reason})`);

    // Zwykła notatka fail-closed NIE dotyczy — blokada jest wąska, tylko na ukryte foldery.
    t.true(AccessGuard.checkAccess(agentZCalymVaultem, 'Notatki/a.md', 'read').allowed);
});

test.serial('fail-closed: `.pkm-assistant` zostaje przy swojej bramce (_checkPkmPath), nie przy No-Go', t => {
    AccessGuard.setNoGoFolders([]); // configDir = null

    // Cudzy folder agenta ma odpaść — ale z bramki pluginu, nie z No-Go. Gdyby fail-closed
    // zjadał `.pkm-assistant`, agent straciłby też WŁASNĄ pamięć (asercja niżej).
    const cudzy = AccessGuard.checkAccess(agentZCalymVaultem, '.pkm-assistant/agents/inny/memory/brain.md', 'read');
    t.false(cudzy.allowed);
    t.notRegex(cudzy.reason, /No-Go/i, `bebechy pluginu wpadły do No-Go zamiast do _checkPkmPath (reason: ${cudzy.reason})`);

    // Własny folder agenta („Tester" → safeName „tester") przechodzi mimo fail-closed.
    const wlasny = AccessGuard.checkAccess(agentZCalymVaultem, '.pkm-assistant/agents/tester/memory/brain.md', 'read');
    t.true(wlasny.allowed, 'fail-closed odciął agenta od jego własnej pamięci');
    t.is(wlasny.reason, 'own-agent-folder');
});

test.serial('configDir znany = fail-closed się wyłącza: inne ukryte foldery przechodzą', t => {
    AccessGuard.setConfigDir('.mojkonfig');
    AccessGuard.setNoGoFolders([]);

    t.true(
        AccessGuard.checkAccess(agentZCalymVaultem, '.inny-ukryty/x.md', 'read').allowed,
        'fail-closed nie wyłączył się mimo znanego configDira — blokuje ukryte foldery na zapas',
    );
    t.false(
        AccessGuard.checkAccess(agentZCalymVaultem, '.mojkonfig/x', 'read').allowed,
        'sam configDir przestał blokować',
    );
});

test.serial('filterResults: fail-closed wycina ukryte foldery z listingów (poza .pkm-assistant)', t => {
    AccessGuard.setNoGoFolders([]); // configDir = null, migawka pusta

    const wyniki = [
        { path: '.ukryty/a.md' },
        { path: '.trash/b.md' },
        { path: '.pkm-assistant/skills/s.md' },
        { path: 'Notatki/c.md' },
    ];

    t.deepEqual(
        AccessGuard.filterResults(agentZCalymVaultem, wyniki).map(r => r.path),
        ['.pkm-assistant/skills/s.md', 'Notatki/c.md'],
        'do wyników search/list przeciekł ukryty folder przy nieznanym configDirze',
    );
});
