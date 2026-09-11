/**
 * STREFA No-Go PORÓWNYWANA BEZ ROZRÓŻNIANIA WIELKOŚCI LITER.
 *
 * Gdyby `AccessGuard._isNoGo` porównywał ścieżkę ze strefą No-Go BAJT W BAJT, na Windows
 * i macOS (system plików wielkości liter NIE rozróżnia) `Projekty/prywatne/tajne.md`
 * przechodziłby bramkę na zielono (bez okna zgody), choć `Projekty/Prywatne/tajne.md` byłby
 * odrzucany — a to JEDEN I TEN SAM PLIK. To samo dotyczyłoby strefy systemowej:
 * `.Obsidian/workspace.json` i `.TRASH/x.md` przechodziłyby, mimo że folder konfiguracji
 * (`Vault#configDir`, tu `.obsidian`) i `.trash/` są zablokowane z definicji.
 *
 * Kontrast: `isProtectedPath` (`keySanitizer.ts`) od zawsze robi `.toLowerCase()`, więc
 * `.PKM-Assistant/settings.json` jest łapany poprawnie.
 *
 * ZASADA (i to jest sedno tego pliku):
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

test.serial('No-Go łapie plik niezależnie od wielkości liter (whitelista)', t2 => {
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

test.serial('No-Go łapie plik niezależnie od wielkości liter (guidance_mode)', t2 => {
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

// ─── 2. Strefa systemowa (`.trash` + folder configu) w przebraniu wielkich liter ───

test.serial('strefa systemowa trzyma mimo wielkich liter — odczyt i zapis', t2 => {
    // configDir ustawiony JAWNIE: od fali B nazwa folderu konfiguracji nie jest nigdzie
    // wpisana na sztywno (`SYSTEM_NO_GO` to samo `['.trash']`), więc `.Obsidian/...` ma tu
    // blokować DLATEGO, że jest configDirem. Bez tej linii test przechodziłby na fail-closed
    // (nieznany configDir = każdy ukryty folder zakazany) i nie mierzyłby normalizacji.
    AccessGuard.setConfigDir('.obsidian');
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

test.serial('wpis No-Go pisany małymi literami blokuje folder pisany wielkimi', t2 => {
    AccessGuard.setNoGoFolders(['prywatne/']);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = agentZCalymVaultem();

    t2.false(ps.checkPermission(agent, 'vault.read', 'Prywatne/x.md').allowed);
    t2.false(ps.checkPermission(agent, 'vault.write', 'PRYWATNE/x.md').allowed);
    t2.true(AccessGuard._isNoGo('Prywatne\\x.md'), 'backslash + inna wielkość liter ominęły No-Go');

    // `Prywatnosc/` to INNY folder, nie podfolder — nie wolno go zjeść prefiksem.
    t2.false(AccessGuard._isNoGo('Prywatnosc/x.md'));
});

test.serial('`Prywatne/` i `prywatne` to JEDEN wpis po normalizacji', t2 => {
    AccessGuard.setNoGoFolders(['Prywatne/', 'prywatne', './PRYWATNE/']);
    const uzytkownika = AccessGuard._noGoFolders.filter(f => f.includes('prywatne'));
    t2.deepEqual(uzytkownika, ['prywatne'], `wpisy No-Go nie zwinęły się do jednego: ${uzytkownika.join(', ')}`);
});

// ─── 4. Bramka ZEZWOLENIA zostaje case-sensitive (świadomie) ───

test.serial('whitelista NADAL rozróżnia wielkość liter — fail-closed', t2 => {
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

test.serial('zakres sub-agenta NADAL rozróżnia wielkość liter', t2 => {
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

test.serial('filterResults wycina No-Go w każdym zapisie wielkości liter', t2 => {
    // Jak w teście 2: configDir jawnie, żeby `.Obsidian/...` odpadał jako folder konfiguracji,
    // a nie przypadkiem na fail-closed dla nieznanego configDira.
    AccessGuard.setConfigDir('.obsidian');
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
