/**
 * Bramka `vault.read` dla Oczka i @-wzmianek ma test ZACHOWANIA, nie napisu w źródle.
 *
 * Granica, o którą chodzi: to jedyna bariera między plikiem, którego agent nie ma prawa
 * czytać, a bajtami wychodzącymi z maszyny do zewnętrznego dostawcy modelu (osadzone
 * `![[…]]` obrazy z aktywnej notatki + pliki wskazane wzmianką `@`). Test regexem po tekście
 * `chat_model.ts` przechodziłby na zielono także wtedy, gdy predykat przepuszcza KAŻDĄ ścieżkę
 * (`checkPermission(…); return true;`) — stąd test na ZACHOWANIE.
 *
 * Atrapa systemu uprawnień odtwarza trzy zachowania prawdziwego: strefę No-Go, whitelistę
 * folderów agenta (`focusFolders`) i zgodę.
 */
import test from 'ava';
import { evaluateVaultRead, createVaultReadPredicate } from './vaultReadGate.js';

type Wywolanie = { agent: unknown; action: string; path: string };

/** Atrapa `plugin.permissionSystem` — pilnuje też, CO dostała w argumentach. */
function fakePermissionSystem() {
    const wywolania: Wywolanie[] = [];
    return {
        wywolania,
        checkPermission(agent: any, action: string, path: string) {
            wywolania.push({ agent, action, path });
            if (action !== 'vault.read') return { allowed: false, reason: 'zła oś uprawnień' };
            if (path.startsWith('Prywatne/')) return { allowed: false, reason: 'no-go' };
            const white = agent?.focusFolders as string[] | undefined;
            if (white && !white.some((f) => path.startsWith(f))) return { allowed: false, reason: 'poza whitelistą agenta' };
            return { allowed: true };
        },
    };
}

const borys = { name: 'Borys', focusFolders: ['Projekty/'] };

// ── Trzy przypadki z werdyktu: dozwolona / No-Go / poza whitelistą ──

test('ścieżka dozwolona przechodzi', t => {
    const ps = fakePermissionSystem();
    const d = evaluateVaultRead({ permissionSystem: ps, agent: borys }, 'Projekty/plan.md');
    t.deepEqual(d, { allowed: true, reason: 'ok' });
    t.deepEqual(ps.wywolania, [{ agent: borys, action: 'vault.read', path: 'Projekty/plan.md' }],
        'bramka musi pytać o TĘ ścieżkę, o oś `vault.read` i o agenta tury');
});

test('strefa No-Go = odmowa (nawet gdy leży w whiteliście agenta)', t => {
    const ps = fakePermissionSystem();
    const wszedzie = { name: 'Admin' };
    t.deepEqual(evaluateVaultRead({ permissionSystem: ps, agent: wszedzie }, 'Prywatne/dziennik.md'),
        { allowed: false, reason: 'denied' });
});

test('ścieżka spoza whitelisty agenta = odmowa', t => {
    const ps = fakePermissionSystem();
    t.deepEqual(evaluateVaultRead({ permissionSystem: ps, agent: borys }, 'Finanse/wyciag.png'),
        { allowed: false, reason: 'denied' });
});

// ── Fail-closed: brak systemu, zepsuty werdykt, rzut bramki ──

test('brak permissionSystem = fail-closed (boot, testy, kontekst bez pluginu)', t => {
    t.deepEqual(evaluateVaultRead({ permissionSystem: null }, 'Projekty/plan.md'),
        { allowed: false, reason: 'no_permission_system' });
    t.deepEqual(evaluateVaultRead({}, 'Projekty/plan.md'), { allowed: false, reason: 'no_permission_system' });
    t.deepEqual(evaluateVaultRead(null, 'Projekty/plan.md'), { allowed: false, reason: 'no_permission_system' });
    t.deepEqual(evaluateVaultRead({ permissionSystem: {} }, 'Projekty/plan.md'),
        { allowed: false, reason: 'no_permission_system' }, 'obiekt bez checkPermission to też brak bramki');
});

test('werdykt bez jawnego allowed === true = odmowa (nie „prawdziwe" wartości)', t => {
    for (const verdict of [{ allowed: 'true' }, { allowed: 1 }, { allowed: false }, {}]) {
        const ps = { checkPermission: () => verdict as any };
        t.false(evaluateVaultRead({ permissionSystem: ps, agent: borys }, 'Projekty/plan.md').allowed,
            `werdykt ${JSON.stringify(verdict)} nie może otwierać bramki`);
    }
});

test('rzut bramki = odmowa + zgłoszenie do logu (fail-closed, nie fail-open)', t => {
    const bledy: unknown[] = [];
    const ps = { checkPermission: () => { throw new Error('permissions boom'); } };
    const d = evaluateVaultRead({ permissionSystem: ps, agent: borys, onError: (e) => bledy.push(e) }, 'Projekty/plan.md');
    t.deepEqual(d, { allowed: false, reason: 'gate_threw' });
    t.is(bledy.length, 1, 'cicha odmowa bez śladu w logu = ślepa diagnoza „czemu Oczko nic nie widzi"');
});

test('zepsuty werdykt (null) wpada w gałąź rzutu, nie udaje zwykłej odmowy', t => {
    const ps = { checkPermission: () => null as any };
    t.is(evaluateVaultRead({ permissionSystem: ps, agent: borys }, 'Projekty/plan.md').reason, 'gate_threw');
});

// ── Predykat dla Oczka i @-wzmianek ──

test('predykat: przepuszcza dozwolone, odmawia No-Go i spoza whitelisty', t => {
    const ps = fakePermissionSystem();
    const canRead = createVaultReadPredicate({ permissionSystem: ps, resolveAgent: () => borys });
    t.true(canRead('Projekty/plan.md'));
    t.false(canRead('Prywatne/dziennik.md'));
    t.false(canRead('Finanse/wyciag.png'));
});

test('predykat bez systemu uprawnień odmawia WSZYSTKIEGO i nie pyta o agenta', t => {
    let pytanoOAgenta = false;
    const canRead = createVaultReadPredicate({
        permissionSystem: undefined,
        resolveAgent: () => { pytanoOAgenta = true; return borys; },
    });
    t.false(canRead('Projekty/plan.md'));
    t.false(canRead('cokolwiek.png'));
    t.false(pytanoOAgenta, 'bez bramki nie ma po co ruszać AgentManagera (kolejność jak w dawnym predykacie)');
});

test('predykat rozwiązuje agenta RAZ, nie przy każdej ścieżce', t => {
    const ps = fakePermissionSystem();
    let ile = 0;
    const canRead = createVaultReadPredicate({ permissionSystem: ps, resolveAgent: () => { ile++; return borys; } });
    canRead('Projekty/a.md');
    canRead('Projekty/b.md');
    t.is(ile, 1, 'przełączenie zakładki w trakcie tury nie ma podmieniać bramki pod ręką');
    t.is(ps.wywolania.length, 2);
    t.deepEqual(ps.wywolania.map((w) => w.agent), [borys, borys]);
});
