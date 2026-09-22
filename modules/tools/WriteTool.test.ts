import test from 'ava';
import { createWriteTool } from './WriteTool.js';

/**
 * obsidianmd: `Vault.modify` → `Vault.process` (zapis atomowy,
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

// ─── Lost update: patch/append/prepend liczą finalContent WEWNĄTRZ callbacku `vault.process`,
// na ŚWIEŻEJ treści w chwili zapisu — nie na treści przeczytanej wcześniej. Bez tego N
// równoległych patchy (Promise.all w `modules/agent-loop/AgentLoop.ts` wykonuje tool-calle jednej
// tury równolegle) czyta TEN SAM stary stan, każdy liczy swoją zmianę z osobna, i wygrywa
// WYŁĄCZNIE ten, który zapisze OSTATNI — reszta ginie po cichu mimo `success:true`. ───

test('3 RÓWNOLEGŁE patche na RÓŻNE old_text (Promise.all) — wszystkie trzy zaaplikowane, żaden nie ginie', async t => {
    const { app, files } = makeVaultApp({ 'Notes/a.md': 'A\nB\nC' });
    const writeTool = createWriteTool();

    const [r1, r2, r3] = await Promise.all([
        writeTool.execute({ path: 'Notes/a.md', mode: 'patch', old_text: 'A', new_text: 'a' }, app, plugin) as Promise<ToolRes>,
        writeTool.execute({ path: 'Notes/a.md', mode: 'patch', old_text: 'B', new_text: 'b' }, app, plugin) as Promise<ToolRes>,
        writeTool.execute({ path: 'Notes/a.md', mode: 'patch', old_text: 'C', new_text: 'c' }, app, plugin) as Promise<ToolRes>,
    ]);

    t.true(r1.success, 'patch A->a ma się udać');
    t.true(r2.success, 'patch B->b ma się udać');
    t.true(r3.success, 'patch C->c ma się udać');
    t.is(
        files['Notes/a.md'],
        'a\nb\nc',
        'wszystkie trzy patche mają być zaaplikowane - lost update nadpisywałby dwa z nich, zostawiając np. "A\\nB\\nc"',
    );
});

test('3 RÓWNOLEGŁE append + 2 RÓWNOLEGŁE prepend (Promise.all) na TYM SAMYM pliku — wszystkie pięć fragmentów obecne w końcowej treści, żaden nie ginie', async t => {
    const { app, files } = makeVaultApp({ 'Notes/a.md': 'MID' });
    const writeTool = createWriteTool();

    const [r1, r2, r3, r4, r5] = await Promise.all([
        writeTool.execute({ path: 'Notes/a.md', mode: 'append', content: '-A1' }, app, plugin) as Promise<ToolRes>,
        writeTool.execute({ path: 'Notes/a.md', mode: 'append', content: '-A2' }, app, plugin) as Promise<ToolRes>,
        writeTool.execute({ path: 'Notes/a.md', mode: 'append', content: '-A3' }, app, plugin) as Promise<ToolRes>,
        writeTool.execute({ path: 'Notes/a.md', mode: 'prepend', content: 'P1-' }, app, plugin) as Promise<ToolRes>,
        writeTool.execute({ path: 'Notes/a.md', mode: 'prepend', content: 'P2-' }, app, plugin) as Promise<ToolRes>,
    ]);

    for (const [i, r] of [r1, r2, r3, r4, r5].entries()) {
        t.true(r.success, `wywołanie #${i + 1} ma się udać`);
    }

    const final = files['Notes/a.md'];
    for (const fragment of ['MID', '-A1', '-A2', '-A3', 'P1-', 'P2-']) {
        t.is(
            final.split(fragment).length - 1,
            1,
            `fragment "${fragment}" ma wystąpić DOKŁADNIE RAZ w końcowej treści "${final}" - append/prepend na nieaktualnym odczycie gubiłby część fragmentów po cichu`,
        );
    }
    t.is(
        final.length,
        'MID'.length + '-A1'.length + '-A2'.length + '-A3'.length + 'P1-'.length + 'P2-'.length,
        'długość końcowej treści musi być sumą WSZYSTKICH pięciu operacji - krótsza długość zdradza lost update',
    );
});

test('2 RÓWNOLEGŁE patche TEGO SAMEGO old_text — DRUGI dostaje błąd „nie znaleziono", nie nadpisuje pierwszego po cichu', async t => {
    const { app, files } = makeVaultApp({ 'Notes/a.md': 'AAA-BBB-CCC' });
    const writeTool = createWriteTool();

    const [r1, r2] = await Promise.all([
        writeTool.execute({ path: 'Notes/a.md', mode: 'patch', old_text: 'BBB', new_text: 'XXX' }, app, plugin) as Promise<ToolRes>,
        writeTool.execute({ path: 'Notes/a.md', mode: 'patch', old_text: 'BBB', new_text: 'YYY' }, app, plugin) as Promise<ToolRes>,
    ]);

    const successes = [r1, r2].filter(r => r.success);
    const failures = [r1, r2].filter(r => !r.success);
    t.is(successes.length, 1, 'dokładnie JEDEN z dwóch patchy na ten sam old_text ma się udać');
    t.is(failures.length, 1, 'drugi ma dostać błąd (old_text zniknął po pierwszym zapisie na ŚWIEŻEJ treści), nie cichą nadpisankę');
    t.regex(
        failures[0].error ?? '',
        /nie znaleziono|not found/i,
        'drugi patch ma dostać konkretnie błąd "nie znaleziono old_text", nie inny wyjątek',
    );
    t.true(
        files['Notes/a.md'] === 'AAA-XXX-CCC' || files['Notes/a.md'] === 'AAA-YYY-CCC',
        'plik ma treść DOKŁADNIE JEDNEGO z dwóch patchy, nigdy oba naraz ani żadnego',
    );
});
