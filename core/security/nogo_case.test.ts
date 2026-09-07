/**
 * K15 (2026-08-23) — STREFA No-Go PORÓWNYWANA BEZ ROZRÓŻNIANIA WIELKOŚCI LITER.
 *
 * Znalezisko AUD-security-101 [HIGH] z drugiego biegu audytu security. Stan przed naprawą:
 *
 *   • `AccessGuard._isNoGo` porównywał ścieżkę ze strefą No-Go BAJT W BAJT — świadomie,
 *     z komentarzem „vault bywa case-sensitive";
 *   • na Windows i macOS system plików wielkości liter NIE rozróżnia, więc
 *     `Projekty/prywatne/tajne.md` przechodził bramkę na zielono (bez okna zgody),
 *     choć `Projekty/Prywatne/tajne.md` był odrzucany — a to JEDEN I TEN SAM PLIK;
 *   • to samo dotyczyło `SYSTEM_NO_GO`: `.Obsidian/workspace.json` i `.TRASH/x.md`
 *     przechodziły, mimo że `.obsidian/` i `.trash/` są zablokowane z definicji.
 *
 * No-Go było JEDYNĄ bramką ścieżkową fail-OPEN na wielkość liter. Kontrast:
 * `isProtectedPath` (`keySanitizer.ts`) od zawsze robi `.toLowerCase()`, więc
 * `.PKM-Assistant/settings.json` był łapany poprawnie.
 *
 * ZASADA PO NAPRAWIE (i to jest sedno tego pliku):
 *
 *   bramka ZAKAZU  (No-Go, SYSTEM_NO_GO)     → porównuje BEZ rozróżniania wielkości liter
 *   bramka ZEZWOLENIA (whitelista, scope suba) → porównuje Z rozróżnianiem
 *
 * Obie strony są wtedy fail-CLOSED. Na vaultcie NAPRAWDĘ case-sensitive (Linux) zakaz
 * obejmie także „sąsiada" różniącego się jedną literą — cena świadomie zaakceptowana:
 * lepiej zakazać za dużo niż za mało. Zezwolenie odwrotnie: rozjazd wielkości liter
 * w whiteliście = odmowa, nie ciche poszerzenie obszaru agenta.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import { PermissionSystem } from './PermissionSystem.js';

/** Agent w trybie „Tylko przypisane" z jednym folderem na whiteliście. */
function agentZWhitelista() {
    return { name: 'Tester', permissions: { guidance_mode: false }, focusFolders: ['Projekty'] };
}

/** Ten sam agent, ale widzący cały zwykły vault — No-Go musi trzymać także jego. */
function agentZCalymVaultem() {
    return { name: 'Tester', permissions: { guidance_mode: true }, focusFolders: [] };
}

/** Trzy zapisy TEGO SAMEGO pliku na Windows/macOS. */
const WARIANTY = [
    'Projekty/Prywatne/tajne.md',
    'Projekty/prywatne/tajne.md',
    'PROJEKTY/PRYWATNE/TAJNE.MD',
];

// ─── 1. No-Go usera: wszystkie warianty zapisu odbijają się z powodem No-Go ───

test.serial('K15: No-Go łapie plik niezależnie od wielkości liter (whitelista)', t2 => {
    AccessGuard.setNoGoFolders(['Projekty/Prywatne']);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = agentZWhitelista();

    for (const wariant of WARIANTY) {
        const d = ps.checkPermission(agent, 'vault.read', wariant);
        t2.false(d.allowed, `${wariant}: plik z No-Go przeszedł bramkę`);
        t2.regex(
            d.reason,
            /No-Go/i,
            `${wariant}: odmowa przyszła z innej bramki niż No-Go (reason: ${d.reason})`,
        );
    }

    // Sąsiad w tym samym obszarze roboczym, który No-Go NIE dotyczy — dalej przechodzi.
    t2.true(
        ps.checkPermission(agent, 'vault.read', 'Projekty/Publiczne/x.md').allowed,
        'No-Go zjadło folder spoza swojej strefy',
    );
});

test.serial('K15: No-Go łapie plik niezależnie od wielkości liter (guidance_mode)', t2 => {
    AccessGuard.setNoGoFolders(['Projekty/Prywatne']);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = agentZCalymVaultem();

    for (const wariant of WARIANTY) {
        const d = ps.checkPermission(agent, 'vault.read', wariant);
        t2.false(d.allowed, `${wariant}: „cały vault" nie znaczy „także No-Go"`);
        t2.regex(d.reason, /No-Go/i, `${wariant}: odmowa nie z bramki No-Go (reason: ${d.reason})`);
    }

    t2.true(ps.checkPermission(agent, 'vault.read', 'Projekty/Publiczne/x.md').allowed);
});

// ─── 2. SYSTEM_NO_GO: `.obsidian` i `.trash` w przebraniu wielkich liter ───

test.serial('K15: SYSTEM_NO_GO trzyma mimo wielkich liter — odczyt i zapis', t2 => {
    AccessGuard.setNoGoFolders([]);
    const agent = agentZCalymVaultem();

    // Sprawdzenie na SAMYM strażniku: `.obsidian/workspace.json` nie jest na liście
    // `PROTECTED_PATHS`, więc gdyby test szedł tylko przez `checkPermission`, odmowa
    // mogłaby przyjść z innej bramki i zamaskować dziurę.
    for (const sciezka of ['.Obsidian/workspace.json', '.TRASH/x.md', '.ObSiDiAn/plugins/x/data.json']) {
        for (const poziom of ['read', 'write'] as const) {
            const d = AccessGuard.checkAccess(agent, sciezka, poziom);
            t2.false(d.allowed, `${sciezka} (${poziom}): systemowa strefa No-Go przepuściła`);
            t2.regex(d.reason, /No-Go/i, `${sciezka} (${poziom}): odmowa nie z No-Go (${d.reason})`);
        }
    }
});

// ─── 3. Wpis w ustawieniach też jest normalizowany ───

test.serial('K15: wpis No-Go pisany małymi literami blokuje folder pisany wielkimi', t2 => {
    AccessGuard.setNoGoFolders(['prywatne/']);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = agentZCalymVaultem();

    t2.false(ps.checkPermission(agent, 'vault.read', 'Prywatne/x.md').allowed);
    t2.false(ps.checkPermission(agent, 'vault.write', 'PRYWATNE/x.md').allowed);
    t2.true(AccessGuard._isNoGo('Prywatne\\x.md'), 'backslash + inna wielkość liter ominęły No-Go');

    // `Prywatnosc/` to INNY folder, nie podfolder — nie wolno go zjeść prefiksem.
    t2.false(AccessGuard._isNoGo('Prywatnosc/x.md'));
});

test.serial('K15: `Prywatne/` i `prywatne` to JEDEN wpis po normalizacji', t2 => {
    AccessGuard.setNoGoFolders(['Prywatne/', 'prywatne', './PRYWATNE/']);
    const uzytkownika = AccessGuard._noGoFolders.filter(f => f.includes('prywatne'));
    t2.deepEqual(uzytkownika, ['prywatne'], `wpisy No-Go nie zwinęły się do jednego: ${uzytkownika.join(', ')}`);
});

// ─── 4. Bramka ZEZWOLENIA zostaje case-sensitive (świadomie) ───

test.serial('K15: whitelista NADAL rozróżnia wielkość liter — fail-closed', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = { name: 'Tester', permissions: { guidance_mode: false }, focusFolders: ['Publiczne'] };

    // To jest CELOWE, nie przeoczenie. Whitelista odpowiada na pytanie „co WOLNO",
    // więc rozjazd wielkości liter musi kończyć się ODMOWĄ — inaczej literówka
    // w ustawieniach po cichu poszerzałaby obszar agenta. Kierunek fail-closed jest
    // ten sam co przy No-Go, tylko skutek odwrotny.
    const poza = ps.checkPermission(agent, 'vault.read', 'publiczne/x.md');
    t2.false(poza.allowed, 'whitelista wpuściła folder o innej wielkości liter');
    t2.regex(poza.reason, /workspace|obszarem roboczym/i);

    t2.true(ps.checkPermission(agent, 'vault.read', 'Publiczne/x.md').allowed);
});

test.serial('K15: zakres sub-agenta NADAL rozróżnia wielkość liter', t2 => {
    AccessGuard.setNoGoFolders([]);
    const agent = agentZCalymVaultem();
    const scopeFolders = ['Projekty/Alfa'];

    t2.true(AccessGuard.checkAccess(agent, 'Projekty/Alfa/x.md', 'read', { scopeFolders }).allowed);
    t2.false(
        AccessGuard.checkAccess(agent, 'Projekty/alfa/x.md', 'read', { scopeFolders }).allowed,
        'zakres suba wpuścił folder o innej wielkości liter',
    );
});

// ─── 5. Wyniki `search`/`list` — ten sam filtr, ta sama normalizacja ───

test.serial('K15: filterResults wycina No-Go w każdym zapisie wielkości liter', t2 => {
    AccessGuard.setNoGoFolders(['Projekty/Prywatne']);
    const agent = agentZCalymVaultem();

    const wyniki = [
        { path: 'Projekty/Prywatne/tajne.md' },
        { path: 'Projekty/prywatne/tajne.md' },
        { path: 'PROJEKTY/PRYWATNE/TAJNE.MD' },
        { path: '.Obsidian/workspace.json' },
        { path: 'Projekty/Publiczne/x.md' },
    ];

    t2.deepEqual(
        AccessGuard.filterResults(agent, wyniki).map(r => r.path),
        ['Projekty/Publiczne/x.md'],
        'do wyników search/list przeciekła ścieżka ze strefy No-Go',
    );
});
