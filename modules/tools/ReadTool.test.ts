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
                    if (!Object.prototype.hasOwnProperty.call(files, p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
                    return files[p];
                }
            }
        }
    };
}

const runVault = (app: ReadToolApp, args: ReadToolArgs) => createReadTool().execute(args, app, {}) as Promise<ReadRes>;
const readContext = (cap = 12000, decorate: (result: unknown) => unknown = result => result) => ({
    resultBudgetChars: cap,
    effectiveResultBudgetChars: cap,
    shouldAbort: () => false,
    authorizeFileRead: () => ({ allowed: true }),
    serializeFinalResult: (result: unknown) => JSON.stringify(decorate(result)),
});
const runVaultWith = (app: ReadToolApp, args: ReadToolArgs, cap = 12000, decorate?: (result: unknown) => unknown) =>
    createReadTool().execute(args, app, {}, readContext(cap, decorate)) as Promise<Record<string, unknown>>;

test('scope=vault: czyta plik przez cachedRead (API-first)', async t => {
    const app = makeVaultApp({ 'Notes/a.md': 'zawartość pliku' });
    const res = await runVault(app, { path: 'Notes/a.md' });
    t.true(res.success);
    t.is(res.content, 'zawartość pliku');
    t.is(res.path, 'Notes/a.md');
});

test('długi odczyt domyślny stronicuje się, a strony odtwarzają dokładny plik', async t => {
    const source = `${'nagłówek \"quoted\"\t\r\n'.repeat(2200)}KONIEC-POLE-55K`;
    const app = makeVaultApp({ 'Notes/long.md': source });
    const read = createReadTool();
    let page = await read.execute({ path: 'Notes/long.md' }, app, {}, readContext()) as Record<string, unknown>;
    t.true(page.success as boolean);
    t.true(page.has_more as boolean);
    t.true(JSON.stringify(page).length <= 12000);
    const chunks = [page.content as string];
    let calls = 1;
    while (page.next_offset !== null && calls < 30) {
        page = await read.execute({
            path: page.path,
            offset: page.next_offset,
            source_version: page.source_version,
        }, app, {}, readContext()) as Record<string, unknown>;
        t.true(page.success as boolean);
        t.true(JSON.stringify(page).length <= 12000);
        chunks.push(page.content as string);
        calls++;
    }
    t.true(calls < 30, 'page continuation must terminate');
    t.is(chunks.join(''), source);
    t.is((page.next_offset as unknown), null);
    t.is(page.source_length, source.length);
    t.is(page.metadata_in_content, false);
});

test('explicit pages clamp limits and account for MCP decorations and JSON escaping', async t => {
    const source = `${'"\\\n\t'.repeat(6000)}end`;
    const app = makeVaultApp({ 'escape.md': source });
    const decorate = (result: unknown) => ({ ...(result as Record<string, unknown>), alias_note: 'vault_read → read', isError: false });
    let page = await runVaultWith(app, { path: 'escape.md', offset: 0, limit: 10000 }, 600, decorate);
    t.true(page.success as boolean);
    t.true((page.effective_limit as number) > 0 && (page.effective_limit as number) <= 8192,
        'requested source limit is capped at 8192 before JSON budget fitting');
    t.true(JSON.stringify(decorate(page)).length <= 600);
    const originalVersion = page.source_version;
    page = await runVaultWith(app, {
        path: 'escape.md', offset: page.next_offset as number, limit: 10000,
        source_version: originalVersion,
    }, 600, decorate);
    t.true(page.success as boolean);
    t.true(JSON.stringify(decorate(page)).length <= 600);
});

test('continuation rejects changed source and offsets inside surrogate pairs', async t => {
    const files = { 'changed.md': `${'a'.repeat(5000)}😀tail` };
    const app = makeVaultApp(files);
    const first = await runVaultWith(app, { path: 'changed.md', offset: 0, limit: 2 }, 600);
    t.true(first.success as boolean);
    t.is(first.content, 'aa');
    files['changed.md'] += '!';
    const stale = await runVaultWith(app, {
        path: 'changed.md', offset: first.next_offset as number,
        source_version: first.source_version,
    }, 600);
    t.is(stale.code, 'file_changed');
    t.is(stale.restart_offset, 0);

    const shrinking = { 'shortened.md': 'abcdefghijklmnopqrstuvwxyz' };
    const shrinkingApp = makeVaultApp(shrinking);
    const beforeShrink = await runVaultWith(shrinkingApp, { path: 'shortened.md', offset: 0, limit: 8 }, 600);
    t.is(beforeShrink.next_offset, 8);
    shrinking['shortened.md'] = 'abc';
    const afterShrink = await runVaultWith(shrinkingApp, {
        path: 'shortened.md', offset: beforeShrink.next_offset, source_version: beforeShrink.source_version,
    }, 600);
    t.deepEqual(afterShrink, { success: false, code: 'file_changed', isError: true, restart_offset: 0 });

    const unicodeChanged = { 'changed-unicode.md': 'ab😀z' };
    const unicodeChangedApp = makeVaultApp(unicodeChanged);
    const beforeUnicodeChange = await runVaultWith(unicodeChangedApp, { path: 'changed-unicode.md', offset: 0, limit: 2 }, 600);
    t.is(beforeUnicodeChange.next_offset, 2);
    unicodeChanged['changed-unicode.md'] = 'x😀z';
    const afterUnicodeChange = await runVaultWith(unicodeChangedApp, {
        path: 'changed-unicode.md', offset: beforeUnicodeChange.next_offset,
        source_version: beforeUnicodeChange.source_version,
    }, 600);
    t.deepEqual(afterUnicodeChange, { success: false, code: 'file_changed', isError: true, restart_offset: 0 });

    const unicode = makeVaultApp({ 'unicode.md': 'x😀y' });
    const unicodeStart = await runVaultWith(unicode, { path: 'unicode.md', offset: 0, limit: 2 }, 600);
    const split = await runVaultWith(unicode, {
        path: 'unicode.md', offset: 2, limit: 1, source_version: unicodeStart.source_version,
    });
    t.is(split.code, 'invalid_offset');
    const firstUnicodePage = await runVaultWith(unicode, { path: 'unicode.md', offset: 0, limit: 2 });
    t.is(firstUnicodePage.content, 'x');
    const noProgress = await runVaultWith(unicode, {
        path: 'unicode.md', offset: firstUnicodePage.next_offset as number,
        limit: 1, source_version: firstUnicodePage.source_version,
    });
    t.is(noProgress.code, 'budget_too_small');
});

test('source versions bind the canonical scope and path; missing or denied pages return bounded codes', async t => {
    const app = makeVaultApp({ 'a.md': 'same content', 'b.md': 'same content' });
    const a = await runVaultWith(app, { path: 'a.md', offset: 0, limit: 2 });
    const b = await runVaultWith(app, { path: 'b.md', offset: 0, limit: 2 });
    t.not(a.source_version, b.source_version, 'identical content at another canonical path must have another version');

    const missing = await runVaultWith(app, {
        path: 'missing.md', offset: 2, source_version: a.source_version,
    });
    t.deepEqual(missing, { success: false, code: 'file_missing', isError: true });
    const denied = await runVaultWith(app, {
        path: '.pkm-assistant/agents/jaskier/memory/brain.md', offset: 2,
        source_version: a.source_version,
    });
    t.deepEqual(denied, { success: false, code: 'access_denied', isError: true });
    const invalidVersion = await runVaultWith(app, {
        path: 'a.md', offset: 2, source_version: 'sha256:not-a-hash',
    });
    t.deepEqual(invalidVersion, { success: false, code: 'invalid_version', isError: true });
});

test('small runtime budget fails before reading and emits a bounded no-progress token', async t => {
    let reads = 0;
    const app = makeVaultApp({ 'tiny.md': 'secret' });
    app.vault.cachedRead = async file => { reads++; return `secret:${file.path}`; };
    const result = await createReadTool().execute(
        { path: 'tiny.md' }, app, {}, readContext(1),
    );
    t.is(result, 'B');
    t.is(reads, 0, 'an envelope that cannot fit must fail before source I/O');
});

test('runtime vault authorization is rechecked before each page I/O', async t => {
    const source = 'secret '.repeat(2000);
    const app = makeVaultApp({ 'scope.md': source });
    let reads = 0;
    app.vault.cachedRead = async () => { reads++; return source; };
    let allowed = false;
    const context = {
        ...readContext(600),
        authorizeFileRead: () => ({ allowed }),
    };
    const read = createReadTool();
    const denied = await read.execute({ path: 'scope.md' }, app, {}, context) as Record<string, unknown>;
    t.deepEqual(denied, { success: false, code: 'access_denied', isError: true });
    t.is(reads, 0);

    allowed = true;
    const first = await read.execute({ path: 'scope.md' }, app, {}, context) as Record<string, unknown>;
    t.true(first.success as boolean);
    t.true(first.has_more as boolean);
    t.is(reads, 1);

    allowed = false;
    const next = await read.execute({
        path: 'scope.md', offset: first.next_offset, source_version: first.source_version,
    }, app, {}, context) as Record<string, unknown>;
    t.deepEqual(next, { success: false, code: 'access_denied', isError: true });
    t.is(reads, 1, 'a revoked permission must stop before reading the next page');
});

test('memory continuation uses logical path and keeps frontmatter inside page content', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const source = `---\nname: Kuba\n${'detail: x\n'.repeat(1200)}---\n${'notatka '.repeat(1000)}`;
    const { vault } = makeVault({ [`${base}/brain/user_kuba.md`]: source });
    const memory = new AgentMemory(vault, 'Jaskier');
    const result = await createReadTool().execute(
        { path: 'user_kuba.md', scope: 'memory' }, {} as ReadToolApp, memPlugin(memory), readContext(600),
    ) as Record<string, unknown>;
    t.true(result.success as boolean);
    t.is(result.path, 'user_kuba.md');
    t.is(result.metadata_in_content, true);
    t.false(Object.prototype.hasOwnProperty.call(result, 'frontmatter'));
    t.true((result.content as string).startsWith('---\nname: Kuba'));
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


test('paged read classifies an indexed source disappearing and adapter access errors', async t => {
    const app = makeVaultApp({ 'a.md': 'abcdefgh' });
    const first = await runVaultWith(app, { path: 'a.md', offset: 0, limit: 2 }, 600);
    app.vault.cachedRead = async () => { throw Object.assign(new Error('raw source failure'), { code: 'ENOENT' }); };
    const missing = await runVaultWith(app, { path: 'a.md', offset: first.next_offset, source_version: first.source_version }, 600);
    t.deepEqual(missing, { success: false, code: 'file_missing', isError: true });
    app.vault.getAbstractFileByPath = () => null;
    app.vault.adapter.read = async () => { throw Object.assign(new Error('raw private path'), { code: 'EACCES' }); };
    t.deepEqual(await runVaultWith(app, { path: 'a.md', offset: 0 }, 600), { success: false, code: 'access_denied', isError: true });
    app.vault.adapter.read = async () => { throw new Error('Authorization: Bearer SECRET_VALUE_123456'); };
    t.deepEqual(await runVaultWith(app, { path: 'a.md', offset: 0 }, 600), { success: false, code: 'read_error', isError: true });
});
