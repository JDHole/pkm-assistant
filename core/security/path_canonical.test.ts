/**
 * K1 (AUD-security-014 / 015 / 018) — RÓWNOWAŻNOŚĆ ZAPISU ŚCIEŻKI.
 *
 * Model potrafi zapisać tę samą ścieżkę na kilkanaście sposobów (`./`, `//`, `\`, `%XX`,
 * wiodący `/`). Bramka MUSI podjąć dla wszystkich tę samą decyzję — inaczej No-Go
 * i lista plików chronionych są tylko dekoracją.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import { PermissionSystem } from './PermissionSystem.js';
import { sanitizePath } from './keySanitizer.js';
import { t } from '../i18n/index.js';
import { MCPClient } from '../../modules/tools/MCPClient.js';
import { ToolRegistry } from '../../modules/tools/ToolRegistry.js';
import { createWriteTool } from '../../modules/tools/WriteTool.js';

/** Wszystkie te ciągi oznaczają DOKŁADNIE ten sam plik w No-Go `Prywatne/`. */
const WARIANTY_NOGO = [
    'Prywatne/d.md',
    '/Prywatne/d.md',
    './Prywatne/./d.md',
    'Prywatne//d.md',
    'Prywatne\\d.md',
    '%50rywatne/d.md',
    'Pryw%61tne/d.md',
];

/** Wszystkie te ciągi oznaczają plik chroniony `.pkm-assistant/settings.json`. */
const WARIANTY_PROTECTED = [
    '.pkm-assistant/settings.json',
    '/.pkm-assistant/settings.json',
    './.pkm-assistant/./settings.json',
    '.pkm-assistant//settings.json',
    '.pkm-assistant\\settings.json',
    '.pkm-assistant/%73ettings.json',
];

/** Agent bez admina, widzący cały zwykły vault — jedyną barierą zostaje No-Go / protected. */
function makeAgent() {
    return { name: 'Tester', permissions: { guidance_mode: true }, focusFolders: [] };
}

test.serial('K1: No-Go blokuje KAŻDY wariant zapisu tej samej ścieżki', t2 => {
    AccessGuard.setNoGoFolders(['Prywatne']);
    const ps = new PermissionSystem(null, {});
    const agent = makeAgent();

    const wzorzec = ps.checkPermission(agent, 'vault.read', WARIANTY_NOGO[0]);
    t2.false(wzorzec.allowed);

    for (const wariant of WARIANTY_NOGO) {
        const decyzja = ps.checkPermission(agent, 'vault.read', wariant);
        t2.false(decyzja.allowed, `wariant "${wariant}" ominął No-Go`);
        t2.deepEqual(decyzja, wzorzec, `wariant "${wariant}" dał INNĄ decyzję niż forma kanoniczna`);
    }
});

test.serial('K1: No-Go blokuje warianty także przy zapisie (vault.write)', t2 => {
    AccessGuard.setNoGoFolders(['Prywatne']);
    const ps = new PermissionSystem(null, {});
    const agent = makeAgent();

    for (const wariant of WARIANTY_NOGO) {
        t2.false(ps.checkPermission(agent, 'vault.write', wariant).allowed, `wariant "${wariant}" ominął No-Go`);
    }
});

test.serial('K1: plik chroniony jest chroniony w KAŻDYM wariancie zapisu', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null, {});
    const agent = makeAgent();

    for (const wariant of WARIANTY_PROTECTED) {
        const decyzja = ps.checkPermission(agent, 'vault.write', wariant);
        t2.false(decyzja.allowed, `wariant "${wariant}" ominął listę plików chronionych`);
        t2.is(decyzja.reason, t('perm.protected_file'), `wariant "${wariant}" odbił się o inną warstwę niż protected`);
    }
});

test.serial('K1: ścieżka nie do uratowania (traversal) = twarda odmowa, nie „nieznana akcja"', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null, {});
    const agent = makeAgent();

    for (const zly of ['../.env', '%2e%2e/.env', 'C:/Windows/system32', 'notes\0.md']) {
        const decyzja = ps.checkPermission(agent, 'vault.read', zly);
        t2.false(decyzja.allowed, `"${zly}" przeszedł bramkę`);
        t2.false(decyzja.requiresApproval);
    }
});

test.serial('K1: zwykła ścieżka w wariantach nadal PRZECHODZI (brak fałszywych alarmów)', t2 => {
    AccessGuard.setNoGoFolders(['Prywatne']);
    const ps = new PermissionSystem(null, {});
    const agent = makeAgent();

    for (const wariant of ['Notes/a.md', './Notes/./a.md', '/Notes/a.md', 'Notes\\a.md', 'Notes//a.md']) {
        t2.true(ps.checkPermission(agent, 'vault.read', wariant).allowed, `wariant "${wariant}" został fałszywie zablokowany`);
    }
});

test.serial('K1: listing roota (`/`) zachowuje dotychczasowe zachowanie', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null, {});
    // guidance_mode = cały zwykły vault → root przechodzi tak samo jak przed zmianą.
    t2.true(ps.checkPermission(makeAgent(), 'vault.read', '/').allowed);
});

test.serial('K1: AccessGuard._isNoGo — wpis i cel w tej samej normalizacji', t2 => {
    // Wpis No-Go podany „brudno" (backslash, `./`, końcowy slash) ma działać tak samo.
    AccessGuard.setNoGoFolders(['./Prywatne/']);
    t2.true(AccessGuard._isNoGo('Prywatne/d.md'));
    t2.true(AccessGuard._isNoGo('Prywatne\\d.md'));
    t2.true(AccessGuard._isNoGo('./Prywatne/./d.md'));
    t2.false(AccessGuard._isNoGo('Prywatnosc/d.md'));
});

// ── K13 (2026-08-23): bramka i zlew widzą JEDEN ciąg ───────────────────────

/**
 * Kontrakt K1 mówi: bramka i zlew oglądają DOKŁADNIE ten sam tekst. Łamała go
 * nie-idempotencja `sanitizePath` (K12): wołacz (`MCPClient._canonicalizeToolContext`)
 * liczył kanonizację RAZ i tę wartość podmieniał w argumentach narzędzia, a bramka
 * (`PermissionSystem.checkPermission`) liczyła ją DRUGI raz i oceniała już inny ciąg.
 * Dla `'./ A/B.md'`: w argumentach lądowało `' A/B.md'` (folder ze spacją z przodu —
 * SĄSIAD folderu `A`), a bramka wydawała werdykt o `'A/B.md'`, gdzie whitelista `A/` mówi ZGÓD.
 * Od K13 `sanitizePath` liczy wynik do punktu stałego, więc obie warstwy trafiają w to samo.
 */

/** Vault-atrapa liczy każdy zapis — chcemy wiedzieć, GDZIE naprawdę ląduje plik. */
function makeWriteApp() {
    const written: string[] = [];
    return {
        written,
        app: {
            vault: {
                adapter: {
                    async exists() { return false; },
                    async read() { return ''; },
                    async write(path: string) { written.push(path); },
                    async mkdir() { /* no-op */ },
                },
                getAbstractFileByPath: () => null,
                async createFolder() { return {}; },
                async create(path: string) { written.push(path); return { path }; },
                async read() { return ''; },
                async modify(file: { path: string }) { written.push(file.path); },
            },
        },
    };
}

/** Agent w trybie „Tylko przypisane” z jednym folderem na whiteleście. */
function makeWaskiAgent() {
    return {
        name: 'Tester',
        permissions: { guidance_mode: false },
        focusFolders: ['A/'],
        disabled_tools: [],
        mcp_servers: ['vault'],
    };
}

test.serial('K13: wołacz podmienia w argumentach DOKŁADNIE ten ciąg, który ocenia bramka', t2 => {
    AccessGuard.setNoGoFolders([]);
    const { app } = makeWriteApp();
    const registry = new ToolRegistry();
    registry.registerTool(createWriteTool() as never);
    const ps = new PermissionSystem(null, {});
    const agent = makeWaskiAgent();
    const plugin = {
        permissionSystem: ps,
        approvalManager: { async requestApproval() { return { result: 'approve' }; } },
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
    };
    const client = new MCPClient(
        app as unknown as ConstructorParameters<typeof MCPClient>[0],
        plugin as unknown as ConstructorParameters<typeof MCPClient>[1],
        registry as unknown as ConstructorParameters<typeof MCPClient>[2],
    );

    const args = { path: './ A/B.md', content: 'treść' };
    const ctx = client._extractToolContext('write', args as never, 'Tester');

    // (a) wartość, którą wołacz wstawi do argumentów narzędzia
    t2.is(ctx.targetPath, 'A/B.md', 'wołacz podmienił ścieżkę na formę SPRZED punktu stałego');
    t2.is(ctx.canonicalPathField, 'path');

    // (b) inwariant K13: to, co wołacz oddał, jest już punktem stałym — bramka nie ma czego poprawić
    t2.is(sanitizePath(ctx.targetPath), ctx.targetPath, 'ciąg od wołacza NIE jest punktem stałym kanonizacji');

    // (c) decyzja bramki dotyczy tego samego tekstu, niezależnie od zapisu wejściowego
    const decyzjaKanoniczna = ps.checkPermission(agent, 'vault.write', ctx.targetPath);
    t2.true(decyzjaKanoniczna.allowed, 'whitelista `A/` nie wpuściła własnego pliku');
    t2.deepEqual(
        ps.checkPermission(agent, 'vault.write', './ A/B.md'),
        decyzjaKanoniczna,
        'surowy zapis i forma kanoniczna dają RÓŻNE werdykty',
    );

    // Folder spoza whitelisty odbija się tak samo w obu zapisach — kanonizacja nie rozluźnia bramki.
    t2.false(ps.checkPermission(agent, 'vault.write', './ Inne/B.md').allowed);
    t2.false(ps.checkPermission(agent, 'vault.write', 'Inne/B.md').allowed);
});

test.serial('K13: pełny łańcuch write — okno zgody i plik pokazują ten sam ciąg', async t2 => {
    AccessGuard.setNoGoFolders([]);
    const { app, written } = makeWriteApp();
    const registry = new ToolRegistry();
    registry.registerTool(createWriteTool() as never);
    const agent = makeWaskiAgent();
    const pokazaneCele: unknown[] = [];
    const plugin = {
        permissionSystem: new PermissionSystem(null, {}),
        approvalManager: {
            async requestApproval(a: { targetPath?: unknown }) { pokazaneCele.push(a.targetPath); return { result: 'approve' }; },
        },
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
    };
    const client = new MCPClient(
        app as unknown as ConstructorParameters<typeof MCPClient>[0],
        plugin as unknown as ConstructorParameters<typeof MCPClient>[1],
        registry as unknown as ConstructorParameters<typeof MCPClient>[2],
        // Podgląd diffa nie jest przedmiotem tego testu, ale `write` po niego sięga — bez
        // atrapy klient otworzyłby prawdziwy modal, który poza Obsidianem nigdy się nie
        // zamyka (test wisiałby do timeoutu). Atrapa zatwierdza od ręki.
        { diffModalFactory: () => ({ waitForApproval: async () => 'approve' }) },
    );

    const out = await client.executeToolCall(
        { name: 'write', arguments: { path: './ A/B.md', content: 'treść' } },
        'Tester',
    ) as { path?: string };

    t2.is(out.path, 'A/B.md');
    t2.deepEqual(written, ['A/B.md'], 'plik wylądował gdzie indziej niż zdecydowała bramka');
    // Przed K13 user widział w oknie zgody `' A/B.md'` — ścieżkę w INNYM folderze niż ta,
    // którą bramka przepuściła i pod którą zapisało narzędzie.
    t2.deepEqual(pokazaneCele, ['A/B.md'], 'okno zgody pokazało inną ścieżkę niż zapisana');
});

test.serial('K13: wiodąca spacja ginie przez `trim()` — świadomy skutek, nie sąsiedni folder', t2 => {
    // `' A/B.md'` NIE jest dziś plikiem w folderze o nazwie „ A” (ze spacją) — kanonizacja
    // zdejmuje białe znaki z BRZEGÓW całego ciągu, więc to ten sam `A/B.md`. Spacja WEWNĄTRZ
    // ścieżki (`'A/ B.md'`) zostaje — to legalna nazwa pliku.
    t2.is(sanitizePath(' A/B.md'), 'A/B.md');
    t2.is(sanitizePath('./ A/B.md'), 'A/B.md');
    t2.is(sanitizePath('A/ B.md'), 'A/ B.md');
});
