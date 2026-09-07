import test from 'ava';
import { createWriteTool } from './WriteTool.js';

/**
 * obsidianmd (release 2.2.0 / W4): `Vault.modify` → `Vault.process` (zapis atomowy,
 * wytyczna katalogu Obsidiana). `WriteTool.execute` woła prywatny helper `writeFileContent`,
 * który feature-detectuje `vault.process` i spada na `vault.modify`, gdy host go nie ma
 * (harness mock ma `process`; ten test pilnuje OBU gałęzi bezpośrednio na atrapie).
 */

type ToolApp = Parameters<ReturnType<typeof createWriteTool>['execute']>[1];
type ToolRes = { success?: boolean; error?: string; path?: string; mode?: string; bytesWritten?: number };

/** Atrapa Vault API. `withProcess=false` usuwa `process` z obiektu (nie tylko undefined —
 *  `typeof vault.process === 'function'` musi widzieć BRAK metody, jak stary host). */
function makeVaultApp(existingFiles: Record<string, string> = {}, withProcess = true) {
    const files = { ...existingFiles };
    const calls: string[] = [];
    const fileObj = (path: string) => ({ path, name: path.split('/').pop() as string });

    const base = {
        adapter: {
            async exists() { return false; },
            async read() { throw new Error('not hidden path in this test'); },
            async write() { throw new Error('not hidden path in this test'); },
        },
        getAbstractFileByPath: (path: string) =>
            Object.prototype.hasOwnProperty.call(files, path) ? fileObj(path) : null,
        createFolder: async () => { /* noop */ },
        create: async (path: string, content: string) => { files[path] = content; return fileObj(path); },
        read: async (file: { path: string }) => files[file.path],
        modify: async (file: { path: string }, content: string) => {
            calls.push('modify');
            files[file.path] = content;
        },
    };
    const vault = withProcess
        ? {
            ...base,
            process: async (file: { path: string }, fn: (data: string) => string) => {
                calls.push('process');
                const next = fn(files[file.path]);
                files[file.path] = next;
                return next;
            },
        }
        : base;

    return { app: { vault } as unknown as ToolApp, files, calls };
}

const plugin = {} as Parameters<ReturnType<typeof createWriteTool>['execute']>[2];

test('replace na istniejącym pliku: gdy host ma vault.process, idzie przez process (nie modify)', async t => {
    const { app, files, calls } = makeVaultApp({ 'Notes/a.md': 'stara treść' });
    const res = await createWriteTool().execute(
        { path: 'Notes/a.md', mode: 'replace', content: 'nowa treść' }, app, plugin
    ) as ToolRes;

    t.true(res.success);
    t.is(files['Notes/a.md'], 'nowa treść');
    t.deepEqual(calls, ['process'], 'zapis atomowy — modify NIE jest wołane, gdy process istnieje');
});

test('replace na istniejącym pliku: bez vault.process (stary/atrapowy host) spada na modify', async t => {
    const { app, files, calls } = makeVaultApp({ 'Notes/a.md': 'stara treść' }, false);
    const res = await createWriteTool().execute(
        { path: 'Notes/a.md', mode: 'replace', content: 'nowa treść' }, app, plugin
    ) as ToolRes;

    t.true(res.success);
    t.is(files['Notes/a.md'], 'nowa treść');
    t.deepEqual(calls, ['modify'], 'fallback zachowuje dawne zachowanie 1:1');
});

test('patch na istniejącym pliku: gdy host ma vault.process, idzie przez process (nie modify)', async t => {
    const { app, files, calls } = makeVaultApp({ 'Notes/a.md': 'AAA-BBB-CCC' });
    const res = await createWriteTool().execute(
        { path: 'Notes/a.md', mode: 'patch', old_text: 'BBB', new_text: 'XXX' }, app, plugin
    ) as ToolRes;

    t.true(res.success);
    t.is(files['Notes/a.md'], 'AAA-XXX-CCC');
    t.deepEqual(calls, ['process'], 'patch idzie tą samą bramką co replace/append/prepend');
});

test('patch na istniejącym pliku: bez vault.process spada na modify, treść identyczna jak z process', async t => {
    const { app, files, calls } = makeVaultApp({ 'Notes/a.md': 'AAA-BBB-CCC' }, false);
    const res = await createWriteTool().execute(
        { path: 'Notes/a.md', mode: 'patch', old_text: 'BBB', new_text: 'XXX' }, app, plugin
    ) as ToolRes;

    t.true(res.success);
    t.is(files['Notes/a.md'], 'AAA-XXX-CCC');
    t.deepEqual(calls, ['modify']);
});

test('append/prepend na istniejącym pliku też idą przez process, gdy dostępny', async t => {
    const { app, files, calls } = makeVaultApp({ 'Notes/a.md': 'srodek' });
    const res1 = await createWriteTool().execute(
        { path: 'Notes/a.md', mode: 'append', content: '-koniec' }, app, plugin
    ) as ToolRes;
    t.true(res1.success);
    t.is(files['Notes/a.md'], 'srodek-koniec');

    const res2 = await createWriteTool().execute(
        { path: 'Notes/a.md', mode: 'prepend', content: 'start-' }, app, plugin
    ) as ToolRes;
    t.true(res2.success);
    t.is(files['Notes/a.md'], 'start-srodek-koniec');

    t.deepEqual(calls, ['process', 'process']);
});

test('create (plik nowy) NIE woła ani process ani modify — idzie przez vault.create', async t => {
    const { app, files, calls } = makeVaultApp({});
    const res = await createWriteTool().execute(
        { path: 'Notes/nowy.md', mode: 'create', content: 'świeża treść' }, app, plugin
    ) as ToolRes;

    t.true(res.success);
    t.is(files['Notes/nowy.md'], 'świeża treść');
    t.deepEqual(calls, [], 'create to Vault.create, nie modify/process');
});
