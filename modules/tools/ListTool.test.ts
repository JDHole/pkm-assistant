import test from 'ava';
import { createListTool } from './ListTool.js';
import type { ListToolApp, ListToolArgs, ListToolPlugin } from './ListTool.js';
import { AgentMemory } from '../memory/AgentMemory.js';

/** Wpis listingu czytany w asercjach (`logical` tylko w scope=memory). */
type ListEntryRes = { path: string; isFolder: boolean; extension?: string; logical: string };

/** Wynik `list` czytany w asercjach — kształt zależy od gałęzi, więc pola opcjonalne. */
type ListRes = { success?: boolean; scope?: string; count?: number; files: ListEntryRes[] };

// ───────────────────────── vault scope (mock Vault API) ─────────────────────────

type TFileLike = { path: string; name?: string; extension?: string; children?: TFileLike[] };

function tfile(path: string): TFileLike { return { path, name: path.split('/').pop(), extension: path.split('.').pop() }; }
function tfolder(path: string, children: TFileLike[] = []): TFileLike { return { path, name: path.split('/').pop() || '/', children }; }

function makeVaultApp({ tree = {}, allFiles = [] }: { tree?: Record<string, TFileLike>; allFiles?: string[] } = {}): ListToolApp {
    return {
        vault: {
            // Klucz '/' atrapy niesie WYJĄTKOWO listę dzieci roota (reszta kluczy = foldery).
            getRoot: () => tfolder('/', (tree['/'] as unknown as TFileLike[]) || []),
            getAbstractFileByPath: (p: string) => tree[p] || null,
            getFiles: () => allFiles.map(tfile)
        }
    } as unknown as ListToolApp;
}

const runVault = (app: ListToolApp, args: ListToolArgs) => createListTool().execute(args, app, {}) as Promise<ListRes>;

test('scope=vault: shallow listing folderu (children)', async t => {
    const app = makeVaultApp({
        tree: { 'Projekty': tfolder('Projekty', [tfile('Projekty/a.md'), tfolder('Projekty/sub')]) }
    });
    const res = await runVault(app, { folder: 'Projekty' });
    t.true(res.success);
    t.is(res.scope, 'vault');
    t.is(res.count, 2);
    const sub = res.files.find(f => f.path === 'Projekty/sub');
    t.true(sub!.isFolder);
    const file = res.files.find(f => f.path === 'Projekty/a.md');
    t.false(file!.isFolder);
    t.is(file!.extension, 'md');
});

test('scope=vault: recursive listing (getFiles + prefix)', async t => {
    const app = makeVaultApp({
        tree: { 'P': tfolder('P') },
        allFiles: ['P/a.md', 'P/sub/b.md', 'Other/c.md']
    });
    const res = await runVault(app, { folder: 'P', recursive: true });
    t.true(res.success);
    t.deepEqual(res.files.map(f => f.path).sort(), ['P/a.md', 'P/sub/b.md']);
});

test('scope=vault: nieistniejący folder → not_found (brak fallbacku adaptera)', async t => {
    const app = makeVaultApp({ tree: {} });
    const res = await runVault(app, { folder: 'Nope' });
    t.false(res.success);
});

test('scope=vault: traversal → odmowa', async t => {
    const app = makeVaultApp({ tree: {} });
    const res = await runVault(app, { folder: '../../etc' });
    t.false(res.success);
});

test('scope=vault: .pkm-assistant zablokowane (E1.8)', async t => {
    const app = makeVaultApp({ tree: {} });
    const res = await runVault(app, { folder: '.pkm-assistant/agents' });
    t.false(res.success);
});

test('scope=vault: katalog skilli .pkm-assistant/skills listowany przez adapter (D17)', async t => {
    const app = makeVaultApp({ tree: {} });
    app.vault.adapter = {
        list: async (p: string) => {
            if (p === '.pkm-assistant/skills') {
                return { folders: ['.pkm-assistant/skills/daily-review'], files: [] };
            }
            throw new Error(`ENOENT ${p}`);
        }
    };
    const res = await runVault(app, { folder: '.pkm-assistant/skills' });
    t.true(res.success);
    t.is(res.count, 1);
    t.true(res.files[0].isFolder);
    t.is(res.files[0].path, '.pkm-assistant/skills/daily-review');
});

test('scope=vault: .pkm-assistant/agents NIE listowany mimo wyjątku skilli (izolacja)', async t => {
    const app = makeVaultApp({ tree: {} });
    app.vault.adapter = { list: async () => ({ folders: ['.pkm-assistant/agents/jaskier'], files: [] }) };
    const res = await runVault(app, { folder: '.pkm-assistant/agents' });
    t.false(res.success); // blokada w validateVaultFolder (agents nie jest pod skills/)
});

// ─── AUD-wydajnosc-074: `list folder:"/" recursive:true` u admina chodził po CAŁYM drzewie ────
//
// adaptera (do 5000 wpisów na dysku) tylko po to, żeby oddać pierwsze 100. Atrapa niżej ma 50
// podfolderów × 100 plików = 5000 wpisów (liczba z dowodu audytu) i liczy KAŻDE wywołanie
// `adapter.list()` — dowód mutacyjny: naprawa musi ograniczyć liczbę odwiedzonych folderów,
// nie tylko przyciąć wynik PO fakcie (to już robił kod sprzed naprawy).

function makeBigAdminAdapter(folders = 50, filesPerFolder = 100) {
    const listCalls: string[] = [];
    const adapter = {
        list: async (folder: string) => {
            listCalls.push(folder);
            if (folder === '') {
                return {
                    files: [],
                    folders: Array.from({ length: folders }, (_, i) => `f${i}`),
                };
            }
            const m = /^f(\d+)$/.exec(folder);
            if (m) {
                return {
                    files: Array.from({ length: filesPerFolder }, (_, j) => `${folder}/file${j}.md`),
                    folders: [],
                };
            }
            return { files: [], folders: [] };
        },
    };
    return { adapter, listCalls };
}

function makeAdminApp(adapter: { list: (folder: string) => Promise<unknown> }): ListToolApp {
    return {
        vault: {
            getRoot: () => tfolder('/', []),
            getAbstractFileByPath: () => null,
            getFiles: () => [],
            adapter,
        },
    } as unknown as ListToolApp;
}

function adminPlugin(): ListToolPlugin {
    return {
        agentManager: {
            getAgent: () => ({ name: 'Admin', admin_access: true }),
            getActiveAgent: () => ({ name: 'Admin', admin_access: true }),
        },
    } as unknown as ListToolPlugin;
}

test('074: admin + folder:"/" recursive:true — walk zatrzymuje się PO zebraniu MAX_RESULTS, nie po pełnym przebiegu 5000 wpisów', async t => {
    const { adapter, listCalls } = makeBigAdminAdapter(50, 100); // 50 × 100 = 5000 wpisów
    const app = makeAdminApp(adapter);
    const res = await createListTool().execute(
        { folder: '/', recursive: true, _invocationAgentName: 'Admin' },
        app,
        adminPlugin(),
    ) as { success?: boolean; count?: number; truncated?: boolean };

    t.true(res.success);
    t.is(res.count, 100, 'wynik ma dokładnie MAX_RESULTS pozycji — bez regresji na tym, co model dostaje');
    t.true(res.truncated, 'flaga obcięcia MUSI być ustawiona — jest więcej niż zwrócono');
    // Pełny przebieg odwiedziłby 51 folderów (root + 50 podfolderów). Naprawiony walk zatrzymuje
    // się, jak tylko zbierze 100 plików — powinien odwiedzić TYLKO root + PIERWSZY podfolder.
    t.true(listCalls.length <= 3, `walk odwiedził ${listCalls.length} folderów — miał zatrzymać się po ~2 (root + f0), nie dobijać do 51`);
    t.deepEqual(listCalls.slice(0, 2), ['', 'f0'], 'kolejność odwiedzin bez zmian (deterministyczna, jak przy pełnym przebiegu)');
});

test('074: admin + folder:"/" recursive:true — PIERWSZE 100 pozycji jest identyczne jak przy pełnym przebiegu (cięcie nie zmienia WYNIKU)', async t => {
    const { adapter } = makeBigAdminAdapter(50, 100);
    const app = makeAdminApp(adapter);
    const res = await createListTool().execute(
        { folder: '/', recursive: true, _invocationAgentName: 'Admin' },
        app,
        adminPlugin(),
    ) as { files: Array<{ path: string }> };

    // Pierwszy podfolder w kolejności `folders` to 'f0', a jego pliki to 'f0/file0.md'..'f0/file99.md'.
    t.deepEqual(res.files.map(f => f.path), Array.from({ length: 100 }, (_, j) => `f0/file${j}.md`));
});

// ───────────────────────── memory scope (real AgentMemory) ─────────────────────────

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set(initialFolders);
    const parentFoldersFor = (path: string) => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join('/'));
        return result;
    };
    for (const path of Object.keys(files)) for (const folder of parentFoldersFor(path)) folders.add(folder);
    return {
        vault: {
            adapter: {
                async exists(path: string) { return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path); },
                async mkdir(path: string) { folders.add(path); },
                async read(path: string) { if (!(path in files)) throw new Error(`missing: ${path}`); return files[path]; },
                async write(path: string, content: string) { for (const f of parentFoldersFor(path)) folders.add(f); files[path] = content; },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(p => p.startsWith(prefix)),
                        folders: [...folders].filter(p => p.startsWith(prefix) && p !== folder)
                    };
                }
            }
        }
    };
}

/** Atrapa agenta: tożsamość + (opcjonalnie) bramka pamięci. */
type FakeAgent = { name: string; permissions?: { memory?: boolean } };

function memPlugin(memory: AgentMemory, { agent }: { agent?: FakeAgent } = {}): ListToolPlugin {
    return {
        agentManager: {
            getActiveMemory: () => memory,
            getActiveAgent: () => agent || { name: memory.agentName },
            getAgent: () => agent || { name: memory.agentName },
            getAgentMemory: (name: string) => (name === memory.agentName ? memory : null)
        }
    } as unknown as ListToolPlugin;
}

const runMem = (plugin: ListToolPlugin, args: ListToolArgs) =>
    createListTool().execute({ ...args, scope: 'memory' }, {} as ListToolApp, plugin) as Promise<ListRes>;

test('scope=memory: fail-closed gdy uprawnienie memory=false', async t => {
    const { vault } = makeVault({ '.pkm-assistant/agents/jaskier/memory/brain/user_x.md': 'x' });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory, { agent: { name: 'Jaskier', permissions: { memory: false } } }), {});
    t.false(res.success);
});

test('scope=memory: listuje brain + sesje + summaries z etykietą logiczną', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain.md`]: '# Brain',
        [`${base}/brain/user_pref.md`]: 'pref',
        [`${base}/sessions/active/s1.md`]: 'sesja',
        [`${base}/summaries/L1/l1_a.md`]: 'l1'
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory), {});
    t.true(res.success);
    t.is(res.scope, 'memory');
    const paths = res.files.map(f => f.path);
    t.true(paths.includes(`${base}/brain.md`));
    t.true(paths.includes(`${base}/brain/user_pref.md`));
    t.true(paths.includes(`${base}/sessions/active/s1.md`));
    t.true(paths.includes(`${base}/summaries/L1/l1_a.md`));
});

test('scope=memory: folder=summaries/L1 filtruje po etykiecie (dawny memory_list_summaries)', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain/user_pref.md`]: 'pref',
        [`${base}/summaries/L1/l1_a.md`]: 'l1',
        [`${base}/summaries/L2/l2_b.md`]: 'l2'
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory), { folder: 'summaries/L1' });
    t.true(res.success);
    t.deepEqual(res.files.map(f => f.path), [`${base}/summaries/L1/l1_a.md`]);
});

test('scope=memory: folder=summaries łapie wszystkie poziomy', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/summaries/L1/l1_a.md`]: 'l1',
        [`${base}/summaries/L2/l2_b.md`]: 'l2',
        [`${base}/summaries/L3/l3_c.md`]: 'l3',
        [`${base}/brain/user_x.md`]: 'x'
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory), { folder: 'summaries' });
    t.true(res.success);
    t.is(res.files.length, 3);
    t.true(res.files.every(f => f.logical.startsWith('summaries/')));
});
