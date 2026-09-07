/**
 * K2 (AUD-security-075 / 076 / 016 / 048 / 021) — BRAK CELU ≠ PRZEPUŚĆ.
 *
 * Cała reszta `checkPermission` (No-Go, pliki chronione, whitelista `focusFolders`, `scope.folders`
 * suba) stoi za `if (targetPath)`. Dopóki akcja dotykająca pliku mogła przyjść z pustym celem,
 * przeskakiwała WSZYSTKO — i tak weszły `artifact_*` oraz zapis `add_text_to_image` pod
 * `output_path`. Te testy pilnują, że pusty cel to odmowa, a nie darmowa przepustka.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import { PermissionSystem, TARGET_REQUIRED_ACTIONS } from './PermissionSystem.js';
import { ApprovalManager } from './ApprovalManager.js';

/** Agent bez admina, widzący cały zwykły vault (whitelista go nie ogranicza). */
function makeAgent() {
    return { name: 'Tester', permissions: { guidance_mode: true }, focusFolders: [] };
}

/** Agent z wąską whitelistą — tryb „Tylko przypisane". */
function makeWhitelistedAgent() {
    return { name: 'Sekretarz', permissions: { guidance_mode: false }, focusFolders: ['Projekty'] };
}

/** Akcje, które MUSZĄ nieść cel — pilnujemy każdej z listy, nie tylko przykładu. */
const AKCJE_Z_CELEM = [
    'vault.write',
    'vault.create',
    'vault.create_folder',
    'vault.delete',
    'artifact.create',
    'artifact.update',
    'artifact.read',
    'image.generate',
];

test.serial('K2: akcja dotykająca pliku BEZ celu = odmowa fail-closed', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null, {});
    const agent = makeAgent();

    for (const akcja of AKCJE_Z_CELEM) {
        for (const pusty of [undefined, null, '', '   ']) {
            const decyzja = ps.checkPermission(agent, akcja, pusty as string | null | undefined);
            t2.false(decyzja.allowed, `${akcja} z celem ${JSON.stringify(pusty)} przeszło bramkę`);
            t2.false(decyzja.requiresApproval, `${akcja}: odmowa ma być twarda, bez pytania usera`);
        }
    }
});

test.serial('K2: lista akcji wymagających celu pokrywa się z tym, czego pilnują testy', t2 => {
    t2.deepEqual([...TARGET_REQUIRED_ACTIONS].sort(), [...AKCJE_Z_CELEM].sort());
});

test.serial('K2: pusty cel jest odmawiany także agentowi z whitelistą i subowi ze scope', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null, {});

    t2.false(ps.checkPermission(makeWhitelistedAgent(), 'vault.write', '').allowed);
    t2.false(
        ps.checkPermission(makeAgent(), 'vault.write', '', { scopeFolders: ['Projekty'] }).allowed,
        'sub ze scope też nie dostaje przepustki za pusty cel',
    );
    t2.false(
        ps.checkPermission({ ...makeAgent(), admin_access: true }, 'vault.write', '').allowed,
        'admin_access otwiera No-Go, ale nie zwalnia z podania celu',
    );
});

test.serial('K2: akcje, które CELOWO nie mają celu, nadal przechodzą', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null, {});
    const agent = makeAgent();

    // `vault.read` obsługuje też ask_user / todo / kom_list / kom_read / scope:memory — one
    // oddają pusty cel z definicji i muszą działać dalej.
    t2.true(ps.checkPermission(agent, 'vault.read', '').allowed);
    t2.true(ps.checkPermission(agent, 'vault.read', '/').allowed, 'root listingu to `/`, nie pusty');
    t2.true(ps.checkPermission(agent, 'delegate', '').allowed);
    t2.true(ps.checkPermission(agent, 'web.search', '').allowed);
    t2.true(ps.checkPermission(agent, 'external.call', '').allowed);
    t2.true(ps.checkPermission(agent, 'memory.write', '.pkm-assistant/agents/tester/memory/brain.md').allowed);
});

test.serial('K2: cel podany = bramka działa jak dotąd (brak fałszywych alarmów)', t2 => {
    AccessGuard.setNoGoFolders(['Prywatne']);
    const ps = new PermissionSystem(null, {});

    t2.true(ps.checkPermission(makeAgent(), 'vault.write', 'Notes/a.md').allowed);
    t2.false(ps.checkPermission(makeAgent(), 'vault.write', 'Prywatne/a.md').allowed, 'No-Go dalej blokuje');
    t2.false(
        ps.checkPermission(makeWhitelistedAgent(), 'artifact.create', 'PKM Assistant/Artefakty/s/x.md').allowed,
        'whitelista obejmuje teraz także artefakty — bo bramka wreszcie widzi ich ścieżkę',
    );
    t2.true(ps.checkPermission(makeWhitelistedAgent(), 'artifact.create', 'Projekty/x.md').allowed);
});

// ── AUD-security-021: „brak celu" to nie „dowolny cel" ────────────────────────

test('K2: pusty cel NIE zapada w wieloznacznik akcja::*', t2 => {
    const am = new ApprovalManager(null, { storage: {} });

    const pusty = am.createPatternKey('vault.write', '');
    t2.not(pusty, 'vault.write::*', 'pusty cel nie może dać klucza wieloznacznego');
    t2.not(pusty, am.createPatternKey('vault.write', 'Notes/a.md'), 'nie może też trafić w konkretną ścieżkę');
    t2.is(pusty, am.createPatternKey('vault.write', undefined), 'brak i pusty to ten sam przypadek');
});

test('K2: reguła „zawsze" z pustego celu nie auto-zatwierdza zapisów po ścieżkach', async t2 => {
    const storage: Record<string, unknown> = {};
    const am = new ApprovalManager(null, { storage });
    am.setApprovalHandler(() => ({ result: 'always' }));

    // Krok 1: user klika „Zawsze zezwalaj" na wywołaniu BEZ celu (takie i tak padnie w narzędziu).
    await am.requestApproval({ type: 'vault.write', agentName: 'Igor', targetPath: '' });
    t2.false(
        am.isAlwaysApproved('Igor', 'vault.write', 'Prywatne/dziennik.md'),
        'jedno kliknięcie na akcji bez celu nie może otworzyć wszystkich zapisów',
    );
    t2.true(am.isAlwaysApproved('Igor', 'vault.write', ''), 'reguła obejmuje dokładnie to, na co user kliknął');
});

test('K2: stara reguła `akcja::*` przestaje pokrywać wywołania BEZ celu', t2 => {
    const am = new ApprovalManager(null, {
        storage: { alwaysApprovedRules: { Igor: ['vault.write::*'] } },
    });

    t2.true(am.isAlwaysApproved('Igor', 'vault.write', 'Notes/a.md'), 'dla konkretnego celu wildcard działa jak dotąd');
    t2.false(am.isAlwaysApproved('Igor', 'vault.write', ''), 'wywołanie bez celu wymaga własnej, jawnej reguły');
});
