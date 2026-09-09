/**
 * KANONIZACJA ŚCIEŻKI DLA AKCJI `image.*`.
 *
 * `generate_image` oddaje bramce FOLDER ZAPISU, a `add_text_to_image` - CEL ZAPISU. Oba są
 * więc prawdziwymi celami vaultowymi (nie „promptem"), i bramka (`PermissionSystem.checkPermission`)
 * musi je kanonizować dokładnie tak jak `vault.*` - inaczej ta sama ścieżka mogłaby dostać dwie
 * różne decyzje w zależności od akcji (`vault.write` + `./.pkm-assistant/x.png` → DENY,
 * `image.generate` + ten sam ciąg → ALLOW), a to WERDYKT bramki, nie sam zapis, ląduje
 * w oknie zgody.
 *
 * Cel `add_text_to_image` bez `output_path` jest WYLICZANY (`<źródło>_text.<ext>`), więc nie
 * jest DOSŁOWNIE wartością żadnego pola argumentów - wołacz (`MCPClient._canonicalizeToolContext`)
 * kanonizuje tylko wtedy, gdy `targetPath` jest dosłowną wartością pola, więc dla celu
 * wyliczanego kanonizację u wołacza pomija.
 *
 * GDZIE MIESZKA KANONIZACJA:
 *   1. `MCPClient._canonicalizeToolContext` - u wołacza, żeby narzędzie dostało ten sam
 *      ciąg, który oceniła bramka (podmiana wartości w argumentach);
 *   2. `PermissionSystem.checkPermission` - obrona w głąb dla `vault.*` ORAZ `image.*`;
 *      dla celu WYLICZANEGO to jedyna warstwa, która go prostuje.
 *   3. `AccessGuard.checkAccess` - TAKŻE kanonizuje, na wejściu, do PUNKTU STAŁEGO (patrz
 *      `sanitizePath`), więc żadna dodatkowa warstwa „poprawek" nie może oddać INNEGO ciągu
 *      niż wołacz i rozjechać bramkę ze zlewem. Cel nie do uratowania = odmowa fail-closed,
 *      nie ciche przepuszczenie surowego ciągu.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import { PermissionSystem } from './PermissionSystem.js';
import { MCPClient } from '../../modules/tools/MCPClient.js';
import { ToolRegistry } from '../../modules/tools/ToolRegistry.js';
import { createAddTextToImageTool } from '../../modules/tools/AddTextToImageTool.js';

/** Agent bez admina, widzący cały zwykły vault — jedyną barierą zostaje granica `.pkm-assistant/`. */
function makeAgent() {
    return { name: 'Tester', permissions: { guidance_mode: true }, focusFolders: [] };
}

/** Ten sam plik w `.pkm-assistant/`, raz kanonicznie, raz z wiodącym `./`. */
const KANONICZNA = '.pkm-assistant/x_text.png';
const Z_KROPKA = './.pkm-assistant/x_text.png';

test.serial('granica `.pkm-assistant/` trzyma dla akcji vault.* w OBU zapisach', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = makeAgent();

    t2.false(ps.checkPermission(agent, 'vault.write', KANONICZNA).allowed);
    t2.false(
        ps.checkPermission(agent, 'vault.write', Z_KROPKA).allowed,
        'wiodące `./` ominęło granicę `.pkm-assistant/` na ścieżce vault.write',
    );
});

test.serial('cel akcji image.* jest ŚCIEŻKĄ VAULTOWĄ, więc bramka go ocenia', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null as never, {} as never);

    // Forma kanoniczna odbija się poprawnie — dowód, że bramka w ogóle patrzy na ten cel
    // (gdyby traktowała go jak prompt, przepuściłaby oba zapisy).
    t2.false(ps.checkPermission(makeAgent(), 'image.generate', KANONICZNA).allowed);
});

test.serial('image.* dostaje TĘ SAMĄ decyzję co vault.* dla tej samej ścieżki', t2 => {
    AccessGuard.setNoGoFolders([]);
    const ps = new PermissionSystem(null as never, {} as never);
    const agent = makeAgent();

    // Bez kanonizacji `image.generate` mógłby dać INNY werdykt niż `vault.write` dla tej
    // samej ścieżki zapisanej z wiodącym `./`.
    t2.false(
        ps.checkPermission(agent, 'image.generate', Z_KROPKA).allowed,
        'wiodące `./` przewraca decyzję bramki dla akcji image.*',
    );
    t2.deepEqual(
        ps.checkPermission(agent, 'image.generate', Z_KROPKA),
        ps.checkPermission(agent, 'image.generate', KANONICZNA),
        'oba zapisy tej samej ścieżki muszą dać IDENTYCZNY werdykt',
    );

    // Ścieżka nie do uratowania (traversal) też odbija się fail-closed, bez pytania usera.
    const traversal = ps.checkPermission(agent, 'image.generate', '../poza/vaultem.png');
    t2.false(traversal.allowed);
    t2.false(traversal.requiresApproval, 'odmowa fail-closed nie może pytać usera');
});

test.serial('AccessGuard kanonizuje sam — `./.pkm-assistant/x_text.png` odbity bez pomocy wołacza', t2 => {
    AccessGuard.setNoGoFolders([]);
    const agent = makeAgent();

    // Granica `.pkm-assistant/` w `checkAccess` stoi na `startsWith`, więc bez kanonizacji tu
    // wiodące `./` mogłoby ją ominąć, gdyby ktokolwiek zawołał strażnika BEZ kanonizacji
    // u wołacza (produkcyjnie robi to `PermissionSystem`, ale kontrakt nie ma polegać na
    // dyscyplinie wołaczy). Strażnik prostuje cel sam: oba zapisy tego samego pliku odbijają
    // się identycznie.
    t2.false(AccessGuard.checkAccess(agent, KANONICZNA, 'write').allowed);
    t2.false(
        AccessGuard.checkAccess(agent, Z_KROPKA, 'write').allowed,
        'wiodące `./` przeszło granicę `.pkm-assistant/` w samym strażniku',
    );
    t2.deepEqual(
        AccessGuard.checkAccess(agent, Z_KROPKA, 'write'),
        AccessGuard.checkAccess(agent, KANONICZNA, 'write'),
        'oba zapisy tej samej ścieżki muszą dać IDENTYCZNY werdykt strażnika',
    );

    // Cel nie do uratowania (traversal) = odmowa, a nie ciche przepuszczenie surowego ciągu.
    const traversal = AccessGuard.checkAccess(agent, '../poza/vaultem.md', 'write');
    t2.false(traversal.allowed);
    t2.is(traversal.reason, 'Invalid path');

    // Zwykła notatka nadal przechodzi — kanonizacja w strażniku niczego nie zacieśnia poza granicami.
    t2.true(AccessGuard.checkAccess(agent, './Notatki/./a.md', 'write').allowed);
});

// ── Pełny łańcuch: MCPClient → PermissionSystem, cel WYLICZANY ────────────────────

/** Vault-atrapa liczy każdy zapis — odmowa musi zostawić zero. */
function makeApp() {
    const written: string[] = [];
    return {
        written,
        app: {
            vault: {
                getAbstractFileByPath: (p: string) => ({ path: p }),
                async readBinary() { return new ArrayBuffer(8); },
                async createBinary(path: string) { written.push(path); },
                async modifyBinary(path: string) { written.push(path); },
                adapter: {
                    async exists() { return false; },
                    async writeBinary(path: string) { written.push(path); },
                    async mkdir() { /* no-op */ },
                },
            },
        },
    };
}

test.serial('`add_text_to_image` bez output_path — WYLICZONY cel z `./` odbija się o bramkę', async t2 => {
    AccessGuard.setNoGoFolders([]);
    const { app, written } = makeApp();

    const registry = new ToolRegistry();
    registry.registerTool(createAddTextToImageTool() as never);

    const approvals: string[] = [];
    const agent = {
        name: 'Tester',
        permissions: { guidance_mode: true },
        focusFolders: [],
        disabled_tools: [],
        mcp_servers: ['multimodal'],
    };
    const plugin = {
        permissionSystem: new PermissionSystem(null as never, {} as never),
        approvalManager: {
            async requestApproval(a: { toolName?: string }) { approvals.push(String(a.toolName)); return { result: 'approve' }; },
        },
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
    };
    const client = new MCPClient(
        app as unknown as ConstructorParameters<typeof MCPClient>[0],
        plugin as unknown as ConstructorParameters<typeof MCPClient>[1],
        registry as unknown as ConstructorParameters<typeof MCPClient>[2],
    );

    // Źródło z wiodącym `./` w bebechach pluginu. Cel jest WYLICZANY (`<źródło>_text.<ext>`),
    // więc nie jest dosłownie wartością żadnego pola argumentów → `_canonicalizeToolContext`
    // go nie prostuje. Jedyną warstwą kanonizacji zostaje bramka.
    const out = await client.executeToolCall(
        { name: 'add_text_to_image', arguments: { path: './.pkm-assistant/x.png', text: 'napis' } },
        'Tester',
    ) as { isError?: boolean; error?: string };

    t2.true(out.isError, 'wyliczony cel w `.pkm-assistant/` musi odbić się o bramkę');
    t2.regex(String(out.error), /Permission denied/);
    t2.is(approvals.length, 0, 'odmowa fail-closed NIE pyta usera');
    t2.is(written.length, 0, 'żaden plik nie powstał');
});
