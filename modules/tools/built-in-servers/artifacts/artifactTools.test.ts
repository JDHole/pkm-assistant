import test from 'ava';
import { createArtifactCreateTool } from './ArtifactCreateTool.js';
import { createArtifactReadTool } from './ArtifactReadTool.js';
import { createArtifactUpdateTool } from './ArtifactUpdateTool.js';
import { createArtifactListTool } from './ArtifactListTool.js';
import { ArtifactStore } from '../../../artifacts/ArtifactStore.js';
import { parseArtifact } from '../../../artifacts/artifactParser.js';
import { parseYaml, stringifyYaml } from '../../../../core/utils/yamlParser.js';
import type { ArtifactToolPlugin } from './ArtifactReadTool.js';
import { MCPClient } from '../../MCPClient.js';
import { PermissionSystem } from '../../../../core/security/PermissionSystem.js';
import { AccessGuard } from '../../../../core/security/AccessGuard.js';

/** Plik vaulta w atrapie (Vault API + metadataCache duck-typowane). */
type FileLike = { path: string; name?: string; basename?: string; children?: unknown[] };

/** Wynik narzedzia artefaktow czytany w asercjach — pola typowane POD UZYCIE. */
type ArtifactRes = {
    isError?: boolean;
    ok?: boolean;
    id: string;
    typ?: string;
    status?: string;
    applied?: number;
    artifact?: { status?: string };
    count?: number;
    artifacts: Array<{ id: string }>;
    errors: Array<{ code?: string }>;
};

const PLAN_TYPE = {
    name: 'plan',
    statusy: ['do-akceptacji', 'uwagi', 'zaakceptowany', 'zamkniety'],
    sprzatanie: 30,
    pola: { cel: { opis: 'po co' } },
    template: '## Cel\n{{cel}}\n\n## Kroki\n\n## Uwagi usera\n',
};

// Mock App + prawdziwy ArtifactStore → test end-to-end na granicy narzędzia.
function makePlugin() {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const fileObj = (p: string): FileLike => ({ path: p, name: p.split('/').pop(), basename: (p.split('/').pop() as string).replace(/\.md$/i, '') });
    const app = {
        vault: {
            getMarkdownFiles: () => [...files.keys()].filter(p => /\.md$/i.test(p)).map(fileObj),
            getAbstractFileByPath: (p: string) => (files.has(p) ? fileObj(p) : (folders.has(p) ? { path: p, children: [] } : null)),
            create: async (path: string, content: string) => { files.set(path, content); return fileObj(path); },
            createFolder: async (p: string) => { folders.add(p); },
            cachedRead: async (file: FileLike) => files.get(file.path),
            process: async (file: FileLike, fn: (md: string) => string) => { const next = fn(files.get(file.path) as string); files.set(file.path, next); return next; },
        },
        metadataCache: { getFileCache: (file: FileLike) => { const c = files.get(file.path); return c == null ? null : { frontmatter: parseArtifact(c).frontmatter }; } },
        fileManager: {
            processFrontMatter: async (file: FileLike, fn: (fm: Record<string, unknown>) => void) => {
                const content = files.get(file.path) as string;
                const m = content.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
                const fm: Record<string, unknown> = m ? ((parseYaml(m[2]) as Record<string, unknown> | null) || {}) : {};
                fn(fm);
                files.set(file.path, `---\n${stringifyYaml(fm)}---\n${m ? content.slice(m[0].length) : content}`);
            },
        },
    };
    const store = new ArtifactStore({ app, typeLoader: { getType: (n: string) => (n === 'plan' ? PLAN_TYPE : null) }, now: () => new Date('2026-07-23') });
    const plugin = { artifactStore: store, agentManager: { getActiveAgent: () => ({ name: 'Jaskier' }) } } as unknown as ArtifactToolPlugin;
    return { plugin, app, files };
}

test('artifact_create → read → update → list flow works through the tools', async t => {
    const { plugin, app } = makePlugin();
    const create = createArtifactCreateTool();
    const read = createArtifactReadTool();
    const update = createArtifactUpdateTool();
    const listTool = createArtifactListTool();

    const created = await create.execute(
        { typ: 'plan', tytul: 'Plan A', pola: { cel: 'zrobić coś' }, sekcje: [{ op: 'add_item', heading: 'Kroki', text: 'krok jeden' }], _invocationAgentName: 'Jaskier' },
        app, plugin,
    ) as unknown as ArtifactRes;
    t.true(created.ok);
    t.regex(created.id, /^art-\d{8}-[0-9a-f]{4}$/);

    const readRes = await read.execute({ id: created.id }, app, plugin) as unknown as ArtifactRes;
    t.is(readRes.typ, 'plan');
    t.is(readRes.status, 'do-akceptacji');

    const upd = await update.execute(
        { id: created.id, ops: [{ op: 'check_item', blockId: 'k1' }, { op: 'set_field', key: 'status', value: 'zaakceptowany' }] },
        app, plugin,
    ) as unknown as ArtifactRes;
    t.is(upd.applied, 2);
    t.is(upd.artifact!.status, 'zaakceptowany');

    const listed = await listTool.execute({ _invocationAgentName: 'Jaskier' }, app, plugin) as unknown as ArtifactRes;
    t.is(listed.count, 1);
    t.is(listed.artifacts[0].id, created.id);
});

test('tools guard missing store and missing args', async t => {
    const { app } = makePlugin();
    const create = createArtifactCreateTool();
    const read = createArtifactReadTool();

    // brak store
    t.true(((await create.execute({ typ: 'plan', tytul: 'x' }, app, {})) as unknown as ArtifactRes).isError);
    // brak wymaganych argów
    const { plugin } = makePlugin();
    t.true(((await create.execute({ typ: 'plan' }, app, plugin)) as unknown as ArtifactRes).isError);
    // nieistniejący id
    t.true(((await read.execute({ id: 'art-00000000-dead' }, app, plugin)) as unknown as ArtifactRes).isError);
});

test('artifact_update on a missing id returns not_found in errors', async t => {
    const { plugin, app } = makePlugin();
    const update = createArtifactUpdateTool();
    const r = await update.execute({ id: 'art-00000000-dead', ops: [{ op: 'check_item', blockId: 'k1' }] }, app, plugin) as unknown as ArtifactRes;
    t.is(r.applied, 0);
    t.is(r.errors[0].code, 'not_found');
});

test('every tool declares serverName "artifacts" and an i18n description', t => {
    for (const factory of [createArtifactCreateTool, createArtifactReadTool, createArtifactUpdateTool, createArtifactListTool]) {
        const tool = factory();
        t.is(tool.serverName, 'artifacts');
        t.truthy(tool.description);
        t.false(tool.description!.startsWith('mcp.artifact'), 'description must be resolved, not a raw i18n key');
    }
});

// ── K2 (AUD-security-075/076): bramka dostaje PRAWDZIWĄ ścieżkę ──────────────

test('K2: contextExtractor artefaktów oddaje ścieżkę, nie pusty string', async t => {
    const { plugin, app } = makePlugin();
    const create = createArtifactCreateTool();
    const read = createArtifactReadTool();
    const update = createArtifactUpdateTool();
    const listTool = createArtifactListTool();
    const ctx = { agentName: 'Jaskier', plugin };

    const createTarget = create.contextExtractor({ typ: 'plan', tytul: 'Plan A' }, ctx).targetPath;
    t.true(createTarget.startsWith('PKM Assistant/Artefakty/Jaskier/'), `create: ${createTarget}`);
    t.true(createTarget.endsWith('.md'));

    const created = await create.execute(
        { typ: 'plan', tytul: 'Plan A', _invocationAgentName: 'Jaskier' }, app, plugin,
    ) as unknown as ArtifactRes;

    t.is(read.contextExtractor({ id: created.id }, ctx).targetPath, (created as unknown as { path: string }).path);
    t.is(update.contextExtractor({ id: created.id }, ctx).targetPath, (created as unknown as { path: string }).path);
    t.is(listTool.contextExtractor({}, ctx).targetPath, 'PKM Assistant/Artefakty');
});

test('K2: nieznane id daje PUSTY cel — bramka odmawia fail-closed zamiast przepuścić', t => {
    const { plugin } = makePlugin();
    const ctx = { agentName: 'Jaskier', plugin };
    t.is(createArtifactReadTool().contextExtractor({ id: 'art-00000000-dead' }, ctx).targetPath, '');
    t.is(createArtifactUpdateTool().contextExtractor({ id: undefined }, ctx).targetPath, '');
});

test('K2: notatka z frontmatterem pkm-artefakt POZA folderem artefaktów jest niewidoczna', async t => {
    const { plugin, app, files } = makePlugin();
    const read = createArtifactReadTool();
    const update = createArtifactUpdateTool();
    const listTool = createArtifactListTool();

    // Podrzucona notatka w zwykłym (albo No-Go) folderze vaulta — ten sam kształt co artefakt.
    files.set('Prywatne/dziennik.md', [
        '---',
        'pkm-artefakt: art-20260723-beef',
        'typ: plan',
        'agent: Jaskier',
        'status: do-akceptacji',
        '---',
        '',
        '## Kroki',
        '',
    ].join('\n'));

    t.true(((await read.execute({ id: 'art-20260723-beef' }, app, plugin)) as unknown as ArtifactRes).isError,
        'artifact_read nie sięga poza folder artefaktów');
    const upd = await update.execute({ id: 'art-20260723-beef', ops: [{ op: 'add_item', heading: 'Kroki', text: 'x' }] }, app, plugin) as unknown as ArtifactRes;
    t.is(upd.errors[0].code, 'not_found', 'artifact_update też nie');
    const listed = await listTool.execute({ _invocationAgentName: 'Jaskier' }, app, plugin) as unknown as ArtifactRes;
    t.is(listed.count, 0, 'spis nie pokazuje cudzej notatki');
    // Plik usera nietknięty.
    t.true(files.get('Prywatne/dziennik.md')!.includes('pkm-artefakt: art-20260723-beef'));
});

// ── K2: pełny łańcuch (MCPClient → PermissionSystem → AccessGuard) ────────────

/** Klient MCP na PRAWDZIWEJ bramce uprawnień + prawdziwym silniku artefaktów. */
function makeClient(plugin: ArtifactToolPlugin, app: unknown, agent: Record<string, unknown>) {
    const tools: Record<string, unknown> = {
        artifact_create: createArtifactCreateTool(),
        artifact_read: createArtifactReadTool(),
        artifact_update: createArtifactUpdateTool(),
        artifact_list: createArtifactListTool(),
    };
    const fullPlugin = {
        ...plugin,
        permissionSystem: new PermissionSystem(null, {}),
        approvalManager: { requestApproval: async () => ({ result: 'approve' }) },
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
    };
    return new MCPClient(
        app as never,
        fullPlugin as never,
        { getTool: (n: string) => tools[n] || null, getToolDefinitions: () => [] } as never,
    );
}

test.serial('K2: artifact_update na artefakcie w No-Go = odmowa przez pełny łańcuch', async t => {
    AccessGuard.setNoGoFolders([]);
    const { plugin, app, files } = makePlugin();
    const agent = { name: 'Jaskier', permissions: { guidance_mode: true }, focusFolders: [] };
    const client = makeClient(plugin, app, agent);

    const created = await client.executeToolCall(
        { name: 'artifact_create', arguments: { typ: 'plan', tytul: 'Plan A', sekcje: [{ op: 'add_item', heading: 'Kroki', text: 'krok' }] } },
        'Jaskier',
    ) as unknown as ArtifactRes & { path: string };
    t.true(created.ok, 'kontrola dodatnia: bez No-Go artefakt powstaje');
    const przed = files.get(created.path)!;

    // User obejmuje folder artefaktów strefą No-Go — od tej chwili agent nie ma tam wstępu.
    AccessGuard.setNoGoFolders(['PKM Assistant/Artefakty']);
    const upd = await client.executeToolCall(
        { name: 'artifact_update', arguments: { id: created.id, ops: [{ op: 'add_item', heading: 'Kroki', text: 'wcisk' }] } },
        'Jaskier',
    ) as unknown as { isError?: boolean; error?: string };

    t.true(upd.isError, 'update ma się odbić o bramkę');
    t.regex(upd.error!, /Permission denied/);
    t.is(files.get(created.path), przed, 'notatka nietknięta');

    const rd = await client.executeToolCall({ name: 'artifact_read', arguments: { id: created.id } }, 'Jaskier') as unknown as { isError?: boolean };
    t.true(rd.isError, 'odczyt też');
    const cr = await client.executeToolCall({ name: 'artifact_create', arguments: { typ: 'plan', tytul: 'Drugi' } }, 'Jaskier') as unknown as { isError?: boolean };
    t.true(cr.isError, 'tworzenie też');

    AccessGuard.setNoGoFolders([]);
});

test.serial('K2: agent bez dostępu do zwykłego vaultu nie tworzy artefaktów po cichu', async t => {
    AccessGuard.setNoGoFolders([]);
    const { plugin, app, files } = makePlugin();
    // Profil „Tylko przypisane" bez przypisanych folderów = wg SECURITY.md zero dostępu do vaulta.
    const agent = { name: 'Sekretarz', permissions: { guidance_mode: false }, focusFolders: [] };
    const client = makeClient(plugin, app, agent);

    const res = await client.executeToolCall(
        { name: 'artifact_create', arguments: { typ: 'plan', tytul: 'Cichy zapis' } },
        'Sekretarz',
    ) as unknown as { isError?: boolean; error?: string };

    t.true(res.isError);
    t.regex(res.error!, /Permission denied/);
    t.is([...files.keys()].filter(p => p.startsWith('PKM Assistant/Artefakty')).length, 0, 'nic nie powstało w vaulcie');
});

// ── K21 (AUD-security-121): CEL DLA BRAMKI Z TOŻSAMOŚCI RUNTIME, NIE Z ARGUMENTÓW ────────────
//
// `contextExtractor` narzędzia `artifact_create` liczył folder z `args._invocationAgentName`.
// Znacznik jest zaufany dopiero PO nadpisaniu przez `MCPClient` — a bramka dostawała worek
// sprzed nadpisania, więc czytała nazwę wpisaną przez MODEL. Skutek: AccessGuard i modal zgody
// oglądały `…/Artefakty/<nazwa od modelu>/…`, a `store.create` pisał do
// `…/Artefakty/<prawdziwy agent>/…`. Dwa różne pliki = whitelista i zakres suba obchodzone.

/** Klient jak `makeClient`, ale zapamiętuje CEL, który realnie oceniła bramka uprawnień. */
function makeSpyClient(plugin: ArtifactToolPlugin, app: unknown, agent: Record<string, unknown>) {
    const tools: Record<string, unknown> = {
        artifact_create: createArtifactCreateTool(),
        artifact_read: createArtifactReadTool(),
        artifact_update: createArtifactUpdateTool(),
        artifact_list: createArtifactListTool(),
    };
    const ps = new PermissionSystem(null, {});
    const ocenione: string[] = [];
    const fullPlugin = {
        ...plugin,
        permissionSystem: {
            checkPermission: (a: never, action: string, target: string, opts: never) => {
                ocenione.push(String(target ?? ''));
                return ps.checkPermission(a, action, target, opts);
            },
            requiresApproval: () => false,
        },
        approvalManager: { requestApproval: async () => ({ result: 'approve' }) },
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
    };
    const client = new MCPClient(
        app as never,
        fullPlugin as never,
        { getTool: (n: string) => tools[n] || null, getToolDefinitions: () => [] } as never,
    );
    return { client, ocenione };
}

test('K21: contextExtractor bierze tożsamość z runtime, a nie z worka argumentów', t => {
    const { plugin } = makePlugin();
    const create = createArtifactCreateTool();

    const cel = create.contextExtractor(
        { typ: 'plan', tytul: 'Plan A', _invocationAgentName: 'Wspolne' },
        { agentName: 'Klara', plugin },
    ).targetPath;

    t.true(cel.startsWith('PKM Assistant/Artefakty/Klara/'), `bramka dostała: ${cel}`);
});

test.serial('K21: whitelista mierzy folder PRAWDZIWEGO agenta — nazwa z argumentów nie otwiera zapisu', async t => {
    AccessGuard.setNoGoFolders([]);
    const { plugin, app, files } = makePlugin();
    // „Tylko przypisane" z whitelistą na CUDZY folder artefaktów. Model podaje w argumentach
    // dokładnie tę nazwę, żeby bramka zobaczyła ścieżkę, którą wolno mu tknąć.
    const agent = { name: 'Klara', permissions: { guidance_mode: false }, focusFolders: ['PKM Assistant/Artefakty/Wspolne'] };
    const { client, ocenione } = makeSpyClient(plugin, app, agent);

    const res = await client.executeToolCall(
        { name: 'artifact_create', arguments: { typ: 'plan', tytul: 'Podszywka', _invocationAgentName: 'Wspolne' } },
        'Klara',
    ) as unknown as { isError?: boolean; error?: string };

    t.true(res.isError, 'zapis idzie do folderu Klary, a tego whitelista nie obejmuje');
    t.regex(res.error!, /Permission denied/);
    t.true(ocenione[0].startsWith('PKM Assistant/Artefakty/Klara/'), `bramka oceniła: ${ocenione[0]}`);
    t.is(files.size, 0, 'żaden plik nie powstał');
});

test.serial('K21: cel oceniony przez bramkę to DOKŁADNIE ścieżka zapisu', async t => {
    AccessGuard.setNoGoFolders([]);
    const { plugin, app } = makePlugin();
    const agent = { name: 'Klara', permissions: { guidance_mode: false }, focusFolders: ['PKM Assistant/Artefakty/Klara'] };
    const { client, ocenione } = makeSpyClient(plugin, app, agent);

    const res = await client.executeToolCall(
        { name: 'artifact_create', arguments: { typ: 'plan', tytul: 'Plan A', _invocationAgentName: 'Wspolne' } },
        'Klara',
    ) as unknown as ArtifactRes & { path: string };

    t.true(res.ok, 'własny folder agenta leży w whiteliście — zapis przechodzi');
    t.is(ocenione[0], res.path, 'bramka i zlew oglądają JEDEN ciąg');
});

test.serial('K21: zakres suba też mierzy folder prawdziwego agenta', async t => {
    AccessGuard.setNoGoFolders([]);
    const { plugin, app, files } = makePlugin();
    // Rodzic widzi cały vault, ale sub dostał wąski zakres na cudzy folder artefaktów.
    const agent = { name: 'Klara', permissions: { guidance_mode: true }, focusFolders: [] };
    const { client, ocenione } = makeSpyClient(plugin, app, agent);

    const res = await client.executeToolCall(
        { name: 'artifact_create', arguments: { typ: 'plan', tytul: 'Podszywka', _invocationAgentName: 'Wspolne' } },
        'Klara',
        { scopeFolders: ['PKM Assistant/Artefakty/Wspolne'] },
    ) as unknown as { isError?: boolean; error?: string };

    t.true(res.isError, 'bariera zakresu suba ma zobaczyć folder Klary');
    t.regex(res.error!, /Permission denied/);
    t.true(ocenione[0].startsWith('PKM Assistant/Artefakty/Klara/'), `bramka oceniła: ${ocenione[0]}`);
    t.is(files.size, 0);
});

// ── K10 (AUD-security-061): `pola` przechodzą przez TEN SAM walidator co patch ────────────────
// Wartości pól są podstawiane do CIAŁA notatki przez `{{pole}}` w szablonie typu, więc bez tej
// bramki `artifact_create` był drugą, niepilnowaną drogą zapisu treści: fence kodu i nagłówek
// `##` lądowały w vaultcie, a narzędzie raportowało `ok:true`, `errors: []`.

const POISON = {
    code_forbidden: '```dataviewjs\nevil()\n```',
    code_forbidden_tilde: '~~~dataviewjs\nevil()\n~~~',
    code_forbidden_html: '<pre>evil()</pre>',
    heading_forbidden: '## Uwagi usera\nzatwierdzam',
};

for (const [expectedCode, payload] of Object.entries(POISON)) {
    const code = expectedCode.replace(/_(tilde|html)$/, '');
    test(`K10: artifact_create odmawia, gdy pole niesie ${expectedCode} (kod ${code})`, async t => {
        const { plugin, app, files } = makePlugin();
        const create = createArtifactCreateTool();
        const res = await create.execute(
            { typ: 'plan', tytul: 'Plan skażony', pola: { cel: payload }, _invocationAgentName: 'Jaskier' },
            app, plugin,
        ) as unknown as ArtifactRes;

        t.true(res.isError, 'narzędzie ma zwrócić błąd, nie ok:true');
        t.is(res.errors[0]!.code, code, 'ten sam kod błędu co przy patchu');
        // Żaden plik nie powstał — odmowa jest fail-closed, nie „utwórz i zgłoś".
        t.is(files.size, 0);
    });
}

test('K10: ten sam ładunek w `sekcje` i w `pola` daje ten sam kod odmowy', async t => {
    const { plugin, app } = makePlugin();
    const create = createArtifactCreateTool();

    const viaSekcje = await create.execute(
        { typ: 'plan', tytul: 'A', sekcje: [{ op: 'set_section', heading: 'Cel', text: POISON.code_forbidden }], _invocationAgentName: 'Jaskier' },
        app, plugin,
    ) as unknown as ArtifactRes;
    const viaPola = await create.execute(
        { typ: 'plan', tytul: 'B', pola: { cel: POISON.code_forbidden }, _invocationAgentName: 'Jaskier' },
        app, plugin,
    ) as unknown as ArtifactRes;

    t.is(viaSekcje.errors[0]!.code, 'code_forbidden');
    t.is(viaPola.errors[0]!.code, 'code_forbidden');
});

test('K10: czyste `pola` nadal tworzą artefakt (bramka nie blokuje normalnej pracy)', async t => {
    const { plugin, app, files } = makePlugin();
    const create = createArtifactCreateTool();
    const res = await create.execute(
        { typ: 'plan', tytul: 'Plan czysty', pola: { cel: 'ogarnąć porządki' }, _invocationAgentName: 'Jaskier' },
        app, plugin,
    ) as unknown as ArtifactRes;
    t.true(res.ok);
    t.is(res.errors.length, 0);
    t.is(files.size, 1);
    t.true([...files.values()][0]!.includes('ogarnąć porządki'));
});
