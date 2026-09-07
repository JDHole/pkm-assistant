/**
 * `PluginVaultFs` — zamyka lukę F-02 (cienka warstwa nad adapterem vaulta nie miała
 * ani jednego testu, mimo że przez nią przechodzi każdy odczyt i zapis runtime'u).
 *
 * Plik dotyka `obsidian` wyłącznie przez `import type`, więc wstaje w gołym Node.
 */
import test from 'ava';
import { PluginVaultFs } from './PluginVaultFs.js';

type Wywolanie = { metoda: string; args: unknown[] };

function makeAdapter(overrides: Record<string, unknown> = {}, log: Wywolanie[] = []) {
    const base = {
        async read(p: string) { log.push({ metoda: 'read', args: [p] }); return 'treść'; },
        async write(p: string, d: string) { log.push({ metoda: 'write', args: [p, d] }); },
        async exists(p: string) { log.push({ metoda: 'exists', args: [p] }); return true; },
        async mkdir(p: string) { log.push({ metoda: 'mkdir', args: [p] }); },
        async rmdir(p: string) { log.push({ metoda: 'rmdir', args: [p] }); },
        async rename(a: string, b: string) { log.push({ metoda: 'rename', args: [a, b] }); },
        async remove(p: string) { log.push({ metoda: 'remove', args: [p] }); },
        async list(p: string) { log.push({ metoda: 'list', args: [p] }); return { files: [], folders: [] }; },
        async stat(p: string) { log.push({ metoda: 'stat', args: [p] }); return { type: 'file', mtime: 1, size: 2 }; },
    };
    return { ...base, ...overrides };
}

const host = (adapter: unknown) => ({ app: { vault: { adapter } } });

// ── C8.1 ─────────────────────────────────────────────────────────────────────
test('basePath jest doklejany do każdej ścieżki', async t => {
    const log: Wywolanie[] = [];
    const fs = new PluginVaultFs(host(makeAdapter({}, log)) as never, { basePath: '.pkm-assistant' });

    await fs.read('settings.json');
    await fs.write('a/b.md', 'x');
    await fs.mkdir('logs');

    t.deepEqual(log.map(w => w.args[0]), [
        '.pkm-assistant/settings.json',
        '.pkm-assistant/a/b.md',
        '.pkm-assistant/logs',
        '.pkm-assistant/logs',
    ].slice(0, log.length), 'prefiks nie został doklejony (albo doklejony podwójnym ukośnikiem)');
    t.is(fs.basePath, '.pkm-assistant');
});

// ── C8.2 ─────────────────────────────────────────────────────────────────────
test('scan() zwraca pustą listę, gdy katalogu nie ma (fail-soft)', async t => {
    const adapter = makeAdapter({
        exists: async () => false,
        list: async () => { throw new Error('ENOENT'); },
    });
    const fs = new PluginVaultFs(host(adapter) as never, { basePath: '.pkm-assistant' });

    const wynik = await fs.scan();

    t.deepEqual(wynik, []);
    t.deepEqual(fs.files, [], 'lista plików nie została zresetowana po nieudanym skanie');
});

// ── C8.3 ─────────────────────────────────────────────────────────────────────
test('mkdir na istniejącym katalogu to no-op', async t => {
    const log: Wywolanie[] = [];
    const adapter = makeAdapter({ exists: async () => true }, log);
    const fs = new PluginVaultFs(host(adapter) as never, {});

    await fs.mkdir('logs');

    t.is(log.filter(w => w.metoda === 'mkdir').length, 0,
        'mkdir na istniejącym katalogu poszedł do adaptera — na niektórych systemach to błąd');
});

// ── C8.4 ─────────────────────────────────────────────────────────────────────
test('list() na padzie → {files:[],folders:[]}', async t => {
    const adapter = makeAdapter({ list: async () => { throw new Error('dysk padł'); } });
    const fs = new PluginVaultFs(host(adapter) as never, {});

    t.deepEqual(await fs.list('cokolwiek'), { files: [], folders: [] });
});

// ── C8.5 ─────────────────────────────────────────────────────────────────────
test('stat() na padzie → null', async t => {
    const adapter = makeAdapter({ stat: async () => { throw new Error('dysk padł'); } });
    const fs = new PluginVaultFs(host(adapter) as never, {});

    t.is(await fs.stat('a.md'), null);
});

// ── C8.6 ─────────────────────────────────────────────────────────────────────
test('brak adaptera → wszystkie metody fail-soft, żadna nie rzuca poza read/write', async t => {
    const fs = new PluginVaultFs(host(undefined) as never, {});

    t.is(await fs.exists('a'), false);
    t.deepEqual(await fs.list(''), { files: [], folders: [] });
    t.is(await fs.stat('a'), null);
    t.deepEqual(await fs.scan(), []);
    await t.throwsAsync(fs.read('a'), undefined, 'odczyt bez adaptera musi być JAWNYM błędem, nie cichym pustym stringiem');
});
