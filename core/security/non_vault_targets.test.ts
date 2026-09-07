/**
 * K14 (2026-08-23) — WHITELISTA FOLDERÓW MIERZY WYŁĄCZNIE CELE-ŚCIEŻKI.
 *
 * Stan przed naprawą (zaszłość, nie regresja — zmierzona także w drzewie sprzed napraw
 * z 22.08):
 *
 *   • `PermissionSystem.checkPermission` woła `AccessGuard.checkAccess(agent, targetPath, …)`
 *     dla KAŻDEJ akcji z niepustym `targetPath`;
 *   • dla akcji z `NON_VAULT_TARGET_ACTIONS` (`web.search` → zapytanie, `web.read` → adres,
 *     `agent.message` → adresat, `delegate` → nazwa roli, `external.call` → nazwa narzędzia)
 *     `targetIsVaultPath: false` wyłączało TYLKO kanonizację (K13);
 *   • No-Go, pliki chronione, whitelista `focusFolders` i bariera `scope.folders` suba
 *     nadal mierzyły ten ciąg JAK ŚCIEŻKĘ.
 *
 * Skutek: agent w trybie „Tylko przypisane" (`guidance_mode: false`) z whitelistą np. `['A/']`
 * dostawał dla `web.search "jak dziala X"` odmowę „Path … is outside the agent's workspace" —
 * czyli tracił wyszukiwarkę, pobieranie stron, pocztę do innych agentów i delegację w całości.
 *
 * Naprawa: `AccessGuard.checkAccess` przy `opts.targetIsVaultPath === false` wraca NATYCHMIAST
 * (`{ allowed: true, reason: 'non-vault-target' }`), przed jakimkolwiek sprawdzeniem ścieżkowym.
 * Reszta przepływu `checkPermission` (klasyfikacja ryzyka, zgody, `disabled_tools`) bez zmian —
 * te akcje mają WŁASNE bramki: web = rejestr znanych adresów + zgoda usera, poczta = widoczność
 * i limity, delegacja = przecięcie zakresów + głębokość z runtime.
 */
import test, { type ExecutionContext } from 'ava';
import { AccessGuard } from './AccessGuard.js';
import { PermissionSystem } from './PermissionSystem.js';

/**
 * Agent w trybie „Tylko przypisane" z jednym folderem na whiteliście — dokładnie ta
 * konfiguracja, w której objaw był widoczny.
 */
function makeAgent() {
    return { name: 'Tester', permissions: { guidance_mode: false }, focusFolders: ['A/'] };
}

/** Adres z długim query i `..` w środku — celowo nie do przełknięcia dla `sanitizePath`. */
const DLUGI_URL = `https://przyklad.pl/a/../b?q=${'x'.repeat(300)}&r=1`;

/**
 * Werdykt „nie-DENY": akcja przeszła bramkę ścieżkową. Może jeszcze wymagać zgody usera
 * (agent bez autonomii `yolo` pyta o `web_search`) — to jest w porządku i NIE jest odmową.
 */
function assertNieOdmowa(
    t2: ExecutionContext,
    decision: { allowed: boolean; reason: string; requiresApproval?: boolean },
    opis: string,
) {
    t2.true(
        decision.allowed === true || decision.requiresApproval === true,
        `${opis}: bramka odmówiła (reason: ${decision.reason})`,
    );
    t2.notRegex(
        decision.reason,
        /workspace|obszarem roboczym/i,
        `${opis}: powód odmowy mówi o whiteliście folderów, choć cel nie jest ścieżką`,
    );
}

test.serial('K14: agent „Tylko przypisane" zachowuje web/pocztę/delegację mimo whitelisty folderów', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = makeAgent();

    // Zapytanie do wyszukiwarki. Przed K14: „Path "jak dziala X" is outside the agent's workspace".
    assertNieOdmowa(t2, ps.checkPermission(agent, 'web.search', 'jak dziala X'), 'web.search');

    // Adres strony — z długim query i `..` w środku (sanitizePath odrzuciłby go jako ścieżkę).
    assertNieOdmowa(t2, ps.checkPermission(agent, 'web.read', DLUGI_URL), 'web.read');

    // Adresat poczty i nazwa roli delegacji — to nazwy, nie foldery.
    assertNieOdmowa(t2, ps.checkPermission(agent, 'agent.message', 'Nika'), 'agent.message');
    assertNieOdmowa(t2, ps.checkPermission(agent, 'delegate', 'worker'), 'delegate');
});

test.serial('K14: whitelista folderów NADAL działa dla celów-ścieżek', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = makeAgent();

    const poza = ps.checkPermission(agent, 'vault.read', 'B/x.md');
    t2.false(poza.allowed, 'plik spoza whitelisty musi się odbić');
    t2.regex(poza.reason, /workspace|obszarem roboczym/i);

    t2.true(ps.checkPermission(agent, 'vault.read', 'A/x.md').allowed, 'plik z whitelisty przechodzi');
});

test.serial('K14: zakres sub-agenta tnie ścieżki, ale nie zapytania', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = makeAgent();
    const scopeFolders = ['A/sub/'];

    // Bariera suba na prawdziwej ścieżce — bez zmian (S33 Z1).
    const poza = ps.checkPermission(agent, 'vault.read', 'A/x.md', { scopeFolders });
    t2.false(poza.allowed, 'plik poza scope suba musi się odbić');

    // Ten sam scope przy zapytaniu do wyszukiwarki nie ma nic do roboty.
    assertNieOdmowa(
        t2,
        ps.checkPermission(agent, 'web.search', 'jak dziala X', { scopeFolders }),
        'web.search w subie ze scope',
    );
});

test.serial('K14: strażnik przepuszcza cel nie-vaultowy, ale bez flagi zostaje fail-closed', t2 => {
    AccessGuard.setNoGoFolders([]);
    const agent = makeAgent();

    t2.deepEqual(
        AccessGuard.checkAccess(agent, 'cokolwiek', 'read', { targetIsVaultPath: false }),
        { allowed: true, reason: 'non-vault-target' },
        'cel jawnie nie-vaultowy ma wracać natychmiast, przed bramkami ścieżkowymi',
    );

    // Domyślka zostaje `true` — nowy wołacz bez flagi dalej dostaje pełną ocenę ścieżki.
    t2.false(
        AccessGuard.checkAccess(agent, 'cokolwiek', 'read', {}).allowed,
        'brak flagi = cel traktowany jak ścieżka (fail-closed dla nowych wołaczy)',
    );
});
