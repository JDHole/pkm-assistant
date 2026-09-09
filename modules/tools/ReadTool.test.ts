import test from 'ava';
import { createReadTool } from './ReadTool.js';
import type { ReadToolApp, ReadToolArgs, ReadToolPlugin } from './ReadTool.js';
import { AgentMemory } from '../memory/AgentMemory.js';

/** Wynik `read` czytany w asercjach — kształt zależy od gałęzi, więc pola opcjonalne. */
type ReadRes = {
    success?: boolean;
    content?: string;
    path?: string;
    code?: string;
    level?: string;
    filename?: string;
};

// ───────────────────────── vault scope (mock Vault API) ─────────────────────────

/** Minimalny mock Vault API: getAbstractFileByPath + cachedRead + adapter.read. */
function makeVaultApp(files: Record<string, string>, folders: string[] = []): ReadToolApp {
    const folderSet = new Set(folders);
    return {
        vault: {
            getAbstractFileByPath(path: string) {
                if (Object.prototype.hasOwnProperty.call(files, path)) {
                    return { path, name: path.split('/').pop() as string, extension: path.split('.').pop() };
                }
                if (folderSet.has(path)) return { path, name: path.split('/').pop() as string, children: [] };
                return null;
            },
            async cachedRead(file) { return files[file.path]; },
            adapter: {
                async read(p: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
                    return files[p];
                }
            }
        }
    };
}

const runVault = (app: ReadToolApp, args: ReadToolArgs) => createReadTool().execute(args, app, {}) as Promise<ReadRes>;

test('scope=vault: czyta plik przez cachedRead (API-first)', async t => {
    const app = makeVaultApp({ 'Notes/a.md': 'zawartość pliku' });
    const res = await runVault(app, { path: 'Notes/a.md' });
    t.true(res.success);
    t.is(res.content, 'zawartość pliku');
    t.is(res.path, 'Notes/a.md');
});

test('scope=vault: brak pliku w indeksie → fallback adaptera (pliki niezaindeksowane)', async t => {
    const app = makeVaultApp({ 'raw.md': 'z dysku' });
    // getAbstractFileByPath zwróci obiekt (bo raw.md jest w files) — usuńmy z indeksu:
    app.vault.getAbstractFileByPath = () => null;
    const res = await runVault(app, { path: 'raw.md' });
    t.true(res.success);
    t.is(res.content, 'z dysku');
});

test('scope=vault: ścieżka to folder → not_a_file', async t => {
    const app = makeVaultApp({}, ['Projekty']);
    const res = await runVault(app, { path: 'Projekty' });
    t.false(res.success);
});

test('scope=vault: traversal → odmowa (validateVaultPath)', async t => {
    const app = makeVaultApp({ 'a.md': 'x' });
    const res = await runVault(app, { path: '../../etc/passwd' });
    t.false(res.success);
});

test('scope=vault: .pkm-assistant zablokowane nawet gdy istnieje na dysku', async t => {
    const app = makeVaultApp({ '.pkm-assistant/agents/tola/memory/brain.md': 'secret' });
    const res = await runVault(app, { path: '.pkm-assistant/agents/tola/memory/brain.md' });
    t.false(res.success);
});

test('scope=vault: przepis skilla .pkm-assistant/skills/**/SKILL.md CZYTELNY (przez adapter)', async t => {
    const app = makeVaultApp({ '.pkm-assistant/skills/daily-review/SKILL.md': '# Daily review\nkroki...' });
    // Ukryty folder — Obsidian go nie indeksuje → getAbstractFileByPath null, czyta adapter.
    app.vault.getAbstractFileByPath = () => null;
    const res = await runVault(app, { path: '.pkm-assistant/skills/daily-review/SKILL.md' });
    t.true(res.success);
    t.is(res.content, '# Daily review\nkroki...');
});

test('scope=vault: pamięć agenta NIE jest czytelna mimo wyjątku skilli (izolacja)', async t => {
    const app = makeVaultApp({ '.pkm-assistant/agents/tola/memory/brain/user_x.md': 'secret' });
    app.vault.getAbstractFileByPath = () => null;
    const res = await runVault(app, { path: '.pkm-assistant/agents/tola/memory/brain/user_x.md' });
    t.false(res.success);
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
        files,
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

function memPlugin(
    memory: AgentMemory,
    { agent, memories = {} }: { agent?: FakeAgent; memories?: Record<string, AgentMemory> } = {},
): ReadToolPlugin {
    return {
        agentManager: {
            getActiveMemory: () => memory,
            getActiveAgent: () => agent || { name: memory.agentName },
            getAgent: () => agent || { name: memory.agentName },
            getAgentMemory: (name: string) => memories[name] || (name === memory.agentName ? memory : null)
        }
    } as unknown as ReadToolPlugin;
}

const runMem = (plugin: ReadToolPlugin, args: ReadToolArgs) =>
    createReadTool().execute({ ...args, scope: 'memory' }, {} as ReadToolApp, plugin) as Promise<ReadRes>;

test('scope=memory: fail-closed gdy uprawnienie memory=false', async t => {
    const { vault } = makeVault({ '.pkm-assistant/agents/jaskier/memory/brain/user_x.md': 'x' });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory, { agent: { name: 'Jaskier', permissions: { memory: false } } }), { path: 'user_x.md' });
    t.false(res.success);
});

test('scope=memory: brak pamięci agenta → no_agent', async t => {
    const plugin = { agentManager: { getActiveMemory: () => null, getActiveAgent: () => ({ name: 'X' }), getAgent: () => ({ name: 'X' }), getAgentMemory: () => null } } as unknown as ReadToolPlugin;
    const res = await runMem(plugin, { path: 'user_x.md' });
    t.false(res.success);
});

test('scope=memory: czyta notatkę brain/ aktualnego agenta', async t => {
    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_jan.md';
    const { vault } = makeVault({
        '.pkm-assistant/agents/jaskier/memory/brain.md': '# Brain',
        [notePath]: '---\nname: Jan\ntype: user\n---\nUser lubi konkret.'
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory), { path: 'user_jan.md' });
    t.true(res.success);
    t.true(res.content!.includes('User lubi konkret.'));
    t.is(res.path, notePath);
});

test('scope=memory: brak notatki → note_not_found', async t => {
    const { vault } = makeVault({ '.pkm-assistant/agents/jaskier/memory/brain.md': '# Brain' });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory), { path: 'missing.md' });
    t.false(res.success);
    t.is(res.code, 'note_not_found');
});

test('scope=memory: traversal i absolutna ścieżka → invalid_path', async t => {
    const { vault } = makeVault({ '.pkm-assistant/agents/jaskier/memory/brain.md': '# Brain' });
    const memory = new AgentMemory(vault, 'Jaskier');
    const traversal = await runMem(memPlugin(memory), { path: '../../../etc/passwd' });
    const absolute = await runMem(memPlugin(memory), { path: 'C:/Users/x/secret.md' });
    t.is(traversal.code, 'invalid_path');
    t.is(absolute.code, 'invalid_path');
});

test('scope=memory: cross-agent brain path → cross_agent_access_denied', async t => {
    const { vault } = makeVault({
        '.pkm-assistant/agents/tola/memory/brain.md': '# Brain',
        '.pkm-assistant/agents/jaskier/memory/brain/user_secret.md': 'secret'
    });
    const memory = new AgentMemory(vault, 'Tola');
    const res = await runMem(memPlugin(memory, { agent: { name: 'Tola' } }), { path: 'jaskier/brain/user_secret.md' });
    t.false(res.success);
    t.is(res.code, 'cross_agent_access_denied');
});

test('scope=memory: ścieżka summaries/L1/<file> mapuje na odczyt podsumowania (dawny memory_read_summary)', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({
        [`${base}/brain.md`]: '# Brain',
        [`${base}/summaries/L1/l1_tydzien.md`]: '---\ncreated: 2026-01-01\n---\nPodsumowanie L1.'
    });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory), { path: 'summaries/L1/l1_tydzien.md' });
    t.true(res.success);
    t.is(res.level, 'L1');
    t.is(res.filename, 'l1_tydzien.md');
    t.true(res.content!.includes('Podsumowanie L1.'));
});

test('scope=memory: brak podsumowania → note_not_found', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const { vault } = makeVault({ [`${base}/brain.md`]: '# Brain' });
    const memory = new AgentMemory(vault, 'Jaskier');
    const res = await runMem(memPlugin(memory), { path: 'summaries/L2/missing.md' });
    t.false(res.success);
    t.is(res.code, 'note_not_found');
});

test('scope=memory z nieznaną tożsamością NIE czyta pamięci aktywnego agenta', async t => {
    const notePath = '.pkm-assistant/agents/jaskier/memory/brain/user_jan.md';
    const { vault } = makeVault({
        '.pkm-assistant/agents/jaskier/memory/brain.md': '# Brain',
        [notePath]: '---\nname: Jan\ntype: user\n---\nTAJNE-JASKRA',
    });
    const memory = new AgentMemory(vault, 'Jaskier');

    const res = await runMem(memPlugin(memory), { path: 'user_jan.md', _invocationAgentName: 'Skasowany' });

    t.false(res.success, 'brak pamięci dla nazwanej tożsamości = odmowa, nie cudzy katalog');
    t.false(JSON.stringify(res).includes('TAJNE-JASKRA'));
});
