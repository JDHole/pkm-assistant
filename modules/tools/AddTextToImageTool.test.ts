/**
 * `add_text_to_image` dotyka DWÓCH plików — i każdy ma mieć własną, pełną bramkę.
 *
 * CEL ZAPISU. Narzędzie renderuje napis na obrazku i zapisuje wynik pod `output_path`.
 * Bramka uprawnień ocenia właśnie tę ścieżkę zapisu przez `validateVaultPath` — czyli
 * przez blokadę `.pkm-assistant/`, No-Go i whitelistę — a nie ścieżkę ŹRÓDŁOWĄ.
 *
 * OBRAZ ŹRÓDŁOWY. Bramka `MCPClienta` widzi WYŁĄCZNIE cel (`image.generate` + `output_path`);
 * gdyby źródło szło tylko przez `validateVaultPath`, które nie zna whitelisty `focusFolders`,
 * strefy No-Go ani `scope.folders` suba, agent z whitelistą `Publiczne` i No-Go `Prywatne`
 * mógłby wywołać
 * `add_text_to_image {path:'Prywatne/skan.png', output_path:'Publiczne/kopia.png'}` — bramka
 * widziałaby sam legalny cel, a plik z `Prywatne/` lądowałby przepisany tam, gdzie agent sięga.
 * Dlatego źródło przechodzi przez PEŁNĄ bramkę (`PermissionSystem.checkPermission(agent,
 * 'vault.read', ...)`) PRZED odczytem, a brak tożsamości/bramki = odmowa fail-closed.
 *
 * Render (`renderTextOverlay`) potrzebuje canvasu, więc „przeszło" poznajemy po LICZNIKU
 * odczytów vaulta, a nie po sukcesie narzędzia. Wszystkie testy są `serial`, bo No-Go
 * (`AccessGuard._noGoFolders`) jest stanem statycznym całego procesu.
 */
import test from 'ava';
import { AccessGuard, PermissionSystem } from '../../core/index.js';
import { createAddTextToImageTool } from './AddTextToImageTool.js';

/** Wynik narzędzia w zakresie, którego dotykają asercje. */
type OverlayRes = { success?: boolean; error?: string };

/**
 * Vault-atrapa. `files` = obrazy, które „istnieją"; `reads` i `written` mówią, dokąd
 * narzędzie NAPRAWDĘ doszło — odmowa musi zostawić oba puste.
 */
function makeApp(files: string[] = ['Attachments/ok.png']) {
    const written: string[] = [];
    const reads: string[] = [];
    const app = {
        vault: {
            getAbstractFileByPath: (p: string) => (files.includes(p) ? { path: p } : null),
            async readBinary(file: { path: string }) { reads.push(file.path); return new ArrayBuffer(8); },
            async createBinary(path: string) { written.push(path); },
            async modifyBinary(path: string) { written.push(path); },
            async createFolder() { /* no-op */ },
            adapter: {
                async exists() { return false; },
                async readBinary(path: string) { reads.push(path); return new ArrayBuffer(8); },
                async writeBinary(path: string) { written.push(path); },
                async mkdir() { /* no-op */ },
            },
        },
    };
    return { app, written, reads };
}

/** Agent-atrapa w kształcie, jakiego dotyka bramka uprawnień. */
type TestAgent = {
    name: string;
    permissions: { guidance_mode: boolean };
    focusFolders: unknown[];
};

function makeAgent(over: Partial<TestAgent> = {}): TestAgent {
    return { name: 'Tester', permissions: { guidance_mode: false }, focusFolders: [], ...over };
}

/** Plugin-atrapa: PRAWDZIWA bramka uprawnień + rejestr agentów (tak jak w runtime). */
function makePlugin(agent: TestAgent | null) {
    return {
        permissionSystem: new PermissionSystem(null as never, {} as never),
        agentManager: {
            getAgent: (name: string) => (agent && agent.name === name ? agent : null),
            getActiveAgent: () => agent,
        },
    };
}

const BAZA = { path: 'Attachments/ok.png', text: 'napis' };
/** Zaufany znacznik tożsamości — w runtime wstrzykuje go `MCPClient`, model go nie podrobi. */
const WOLAJACY = { _invocationAgentName: 'Tester' };

test.serial('contextExtractor oddaje CEL ZAPISU, nie ścieżkę źródłową', t => {
    const tool = createAddTextToImageTool();

    t.is(
        tool.contextExtractor({ ...BAZA, output_path: 'Grafiki/podpisany.png' }).targetPath,
        'Grafiki/podpisany.png',
        'jawny output_path jest celem',
    );
    t.is(
        tool.contextExtractor(BAZA).targetPath,
        'Attachments/ok_text.png',
        'domyślny cel liczony tak samo jak w execute',
    );
    t.is(
        tool.contextExtractor({ ...BAZA, output_path: '.pkm-assistant/agents/inny/memory/brain.md' }).targetPath,
        '.pkm-assistant/agents/inny/memory/brain.md',
        'bramka ma zobaczyć ścieżkę, o którą narzędzie naprawdę prosi',
    );
    t.is(
        tool.contextExtractor(BAZA).approvalContext.sourcePath,
        'Attachments/ok.png',
        'okno zgody dostaje też ŹRÓDŁO — user zatwierdza całą operację, nie połowę',
    );
});

test.serial('output_path z traversalem = odmowa przed jakimkolwiek zapisem', async t => {
    const { app, written } = makeApp();
    const tool = createAddTextToImageTool();

    const res = await tool.execute({ ...BAZA, output_path: '../x.png' }, app as never, null) as OverlayRes;
    t.false(res.success);
    t.regex(res.error!, /output path/i);
    t.deepEqual(written, [], 'nic nie poleciało do vaulta');
});

test.serial('output_path w .pkm-assistant (pamięć innego agenta / kod pluginu) = odmowa', async t => {
    const { app, written } = makeApp();
    const tool = createAddTextToImageTool();

    for (const cel of [
        '.pkm-assistant/agents/inny/memory/brain.md',
        '.pkm-assistant/settings.json',
        '.pkm-assistant/logs/trace.log',
    ]) {
        const res = await tool.execute({ ...BAZA, output_path: cel }, app as never, null) as OverlayRes;
        t.false(res.success, `cel "${cel}" przeszedł`);
        t.regex(res.error!, /output path/i, `cel "${cel}" odbił się o inną warstwę niż walidacja celu`);
    }
    t.deepEqual(written, []);
});

test.serial('legalny cel przechodzi walidację (odbija się dopiero o brak canvasu/obrazka)', async t => {
    AccessGuard.setNoGoFolders([]);
    const { app } = makeApp();
    const tool = createAddTextToImageTool();
    const plugin = makePlugin(makeAgent({ permissions: { guidance_mode: true } }));

    const res = await tool.execute(
        { ...WOLAJACY, ...BAZA, output_path: 'Grafiki/podpisany.png' },
        app as never,
        plugin as never,
    ) as OverlayRes;
    t.false(res.success, 'render bez canvasu i tak padnie — chodzi o POWÓD');
    t.notRegex(res.error!, /output path/i, 'walidacja celu nie może być tym, co blokuje legalny zapis');
});

test.serial('źródło spoza whitelisty / w No-Go = odmowa PRZED odczytem obrazu', async t => {
    AccessGuard.setNoGoFolders(['Prywatne']);
    const { app, written, reads } = makeApp(['Prywatne/sekret.png', 'Publiczne/a.png']);
    const tool = createAddTextToImageTool();
    const plugin = makePlugin(makeAgent({ focusFolders: ['Publiczne'] }));

    const res = await tool.execute(
        { ...WOLAJACY, path: 'Prywatne/sekret.png', output_path: 'Publiczne/kopia.png', text: 'x' },
        app as never,
        plugin as never,
    ) as OverlayRes;

    t.false(res.success, 'kopiowanie pliku z No-Go do folderu agenta musi się odbić');
    t.true(res.error!.includes('Prywatne/sekret.png'), 'komunikat ma wskazywać ŹRÓDŁO, nie cel');
    t.deepEqual(reads, [], 'odmowa zapada PRZED readBinary — plik nie może zostać dotknięty');
    t.deepEqual(written, [], 'nic nie poleciało do vaulta');
});

test.serial('źródło wewnątrz whitelisty przechodzi bramkę jak dotąd', async t => {
    AccessGuard.setNoGoFolders(['Prywatne']);
    const { app, reads } = makeApp(['Publiczne/a.png']);
    const tool = createAddTextToImageTool();
    const plugin = makePlugin(makeAgent({ focusFolders: ['Publiczne'] }));

    const res = await tool.execute(
        { ...WOLAJACY, path: 'Publiczne/a.png', output_path: 'Publiczne/kopia.png', text: 'x' },
        app as never,
        plugin as never,
    ) as OverlayRes;

    t.deepEqual(reads, ['Publiczne/a.png'], 'legalne źródło ma przejść bramkę i zostać odczytane');
    t.false(res.success, 'render bez canvasu i tak padnie — liczy się, GDZIE bieg się zatrzymał');
});

test.serial('zakres sub-agenta (scope.folders) obowiązuje także źródło', async t => {
    AccessGuard.setNoGoFolders([]);
    // Agent widzi CAŁY zwykły vault — jedyną barierą zostaje zakres suba.
    const agent = makeAgent({ permissions: { guidance_mode: true } });

    const poza = makeApp(['Publiczne/Inny/a.png']);
    const toolPoza = createAddTextToImageTool();
    const resPoza = await toolPoza.execute(
        {
            ...WOLAJACY,
            _invocationScopeFolders: ['Publiczne/Sub'],
            path: 'Publiczne/Inny/a.png',
            output_path: 'Publiczne/Sub/kopia.png',
            text: 'x',
        },
        poza.app as never,
        makePlugin(agent) as never,
    ) as OverlayRes;
    t.false(resPoza.success, 'sub nie może wyciągnąć obrazu spoza swojego zakresu');
    t.deepEqual(poza.reads, [], 'odmowa PRZED odczytem');

    const wewnatrz = makeApp(['Publiczne/Sub/a.png']);
    const toolW = createAddTextToImageTool();
    await toolW.execute(
        {
            ...WOLAJACY,
            _invocationScopeFolders: ['Publiczne/Sub'],
            path: 'Publiczne/Sub/a.png',
            output_path: 'Publiczne/Sub/kopia.png',
            text: 'x',
        },
        wewnatrz.app as never,
        makePlugin(agent) as never,
    );
    t.deepEqual(wewnatrz.reads, ['Publiczne/Sub/a.png'], 'źródło w zakresie suba przechodzi');
});

test.serial('brak tożsamości albo bramki w kontekście = odmowa fail-closed', async t => {
    AccessGuard.setNoGoFolders([]);
    const pelnoprawny = makeAgent({ permissions: { guidance_mode: true } });

    const konteksty: Array<[string, unknown]> = [
        ['brak pluginu (bieg poza MCPClient)', null],
        ['agenta nie da się ustalić', {
            permissionSystem: new PermissionSystem(null as never, {} as never),
            agentManager: { getAgent: () => null, getActiveAgent: () => null },
        }],
        ['brak PermissionSystem', {
            agentManager: { getAgent: () => pelnoprawny, getActiveAgent: () => pelnoprawny },
        }],
    ];

    for (const [opis, plugin] of konteksty) {
        const { app, reads, written } = makeApp();
        const tool = createAddTextToImageTool();
        const res = await tool.execute(
            { ...WOLAJACY, ...BAZA, output_path: 'Grafiki/podpisany.png' },
            app as never,
            plugin as never,
        ) as OverlayRes;

        t.false(res.success, `"${opis}": narzędzie przepuściło odczyt bez bramki`);
        t.true(res.error!.includes('Attachments/ok.png'), `"${opis}": komunikat ma wskazywać źródło`);
        t.deepEqual(reads, [], `"${opis}": obraz został odczytany mimo braku bramki`);
        t.deepEqual(written, [], `"${opis}": coś poleciało do vaulta`);
    }
});

test.serial('`.pkm-assistant` jako źródło nadal odbija się o validateVaultPath', async t => {
    AccessGuard.setNoGoFolders([]);
    const { app, reads } = makeApp(['.pkm-assistant/agents/inny/memory/x.png']);
    const tool = createAddTextToImageTool();
    // Agent widzi cały zwykły vault — dowód, że blokuje granica `.pkm-assistant/`, nie whitelista.
    const plugin = makePlugin(makeAgent({ permissions: { guidance_mode: true } }));

    const res = await tool.execute(
        { ...WOLAJACY, path: '.pkm-assistant/agents/inny/memory/x.png', output_path: 'Grafiki/kopia.png', text: 'x' },
        app as never,
        plugin as never,
    ) as OverlayRes;

    t.false(res.success);
    t.true(res.error!.includes('.pkm-assistant/agents/inny/memory/x.png'), 'komunikat ma wskazywać źródło');
    t.deepEqual(reads, [], 'pamięć innego agenta nie może zostać odczytana');
});
