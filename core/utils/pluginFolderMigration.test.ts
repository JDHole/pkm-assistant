import test from 'ava';
import { migrateOldPluginFolder } from './pluginFolderMigration.js';

/** Przełączniki awarii dysku dla poszczególnych testów. */
type AdapterOverrides = { readThrows?: boolean; writeThrows?: boolean; mkdirThrows?: boolean };

/**
 * `mkdir` jest OPCJONALNE, bo jeden z testów kasuje je z adaptera
 * (`delete adapter.mkdir`) — sprawdza ścieżkę „adapter bez mkdir".
 */
type FakeAdapter = {
    calls: { read: string[]; write: [string, string][]; mkdir: string[] };
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    mkdir?(path: string): Promise<void>;
};

/** Fałszywy adapter: mapa ścieżka→treść + licznik wywołań. */
function makeAdapter(files: Record<string, string> = {}, overrides: AdapterOverrides = {}): FakeAdapter {
    const calls: FakeAdapter['calls'] = { read: [], write: [], mkdir: [] };
    const adapter: FakeAdapter = {
        calls,
        async read(path) {
            calls.read.push(path);
            if (overrides.readThrows) throw new Error('disk hiccup');
            if (!(path in files)) throw new Error(`ENOENT ${path}`);
            return files[path];
        },
        async write(path, content) {
            calls.write.push([path, content]);
            if (overrides.writeThrows) throw new Error('read-only volume');
            files[path] = content;
        },
        async mkdir(path) {
            calls.mkdir.push(path);
            if (overrides.mkdirThrows) throw new Error('exists');
        },
    };
    return adapter;
}

const OLD = '.obsidian/plugins/obsek/data.json';
const NEW = '.obsidian/plugins/pkm-assistant/data.json';
const BASE: { adapter: FakeAdapter | null; configDir: string; manifestId: string } =
    { adapter: null, configDir: '.obsidian', manifestId: 'pkm-assistant' };

test('manifestId nadal "obsek" → zero wywołań adaptera (wpięcie jest inertne)', async t => {
    const adapter = makeAdapter({ [OLD]: '{"installed_at":1}' });
    const res = await migrateOldPluginFolder({ ...BASE, adapter, manifestId: 'obsek' });
    t.false(res.migrated);
    t.is(res.reason, 'same-id');
    t.is(adapter.calls.read.length, 0);
    t.is(adapter.calls.write.length, 0);
});

test('brak adaptera → no-op', async t => {
    t.false((await migrateOldPluginFolder({ ...BASE, adapter: null })).migrated);
    t.false((await migrateOldPluginFolder()).migrated);
    t.false((await migrateOldPluginFolder({ ...BASE, adapter: {} })).migrated);
});

test('nowy plik czytelny → zero zapisu (nie nadpisujemy niczego)', async t => {
    const adapter = makeAdapter({ [OLD]: '{"installed_at":1}', [NEW]: '{"installed_at":2}' });
    const res = await migrateOldPluginFolder({ ...BASE, adapter });
    t.false(res.migrated);
    t.is(res.reason, 'new-exists');
    t.is(adapter.calls.write.length, 0);
});

test('starego brak → zero zapisu', async t => {
    const adapter = makeAdapter({});
    const res = await migrateOldPluginFolder({ ...BASE, adapter });
    t.false(res.migrated);
    t.is(res.reason, 'no-old');
    t.is(adapter.calls.write.length, 0);
});

test('stary jest, nowego brak → zapis treści starego pod nowy adres', async t => {
    const adapter = makeAdapter({ [OLD]: '{"installed_at":1700000000000,"last_version":"2.1.0"}' });
    const logged: string[][] = [];
    const res = await migrateOldPluginFolder({ ...BASE, adapter, log: { info: (...a) => logged.push(a) } });
    t.true(res.migrated);
    t.is(adapter.calls.write.length, 1);
    t.is(adapter.calls.write[0][0], NEW);
    t.is(adapter.calls.write[0][1], '{"installed_at":1700000000000,"last_version":"2.1.0"}');
    t.deepEqual(adapter.calls.mkdir, ['.obsidian/plugins/pkm-assistant']);
    t.is(logged.length, 1);
});

test('stary pusty → traktowany jak brak', async t => {
    const adapter = makeAdapter({ [OLD]: '   ' });
    const res = await migrateOldPluginFolder({ ...BASE, adapter });
    t.false(res.migrated);
    t.is(res.reason, 'no-old');
    t.is(adapter.calls.write.length, 0);
});

test('read rzuca na wszystkim → brak crasha, zero zapisu', async t => {
    const adapter = makeAdapter({ [OLD]: '{}' }, { readThrows: true });
    const res = await migrateOldPluginFolder({ ...BASE, adapter });
    t.false(res.migrated);
    t.is(res.reason, 'no-old');
    t.is(adapter.calls.write.length, 0);
});

test('write rzuca → brak crasha, migrated=false', async t => {
    const adapter = makeAdapter({ [OLD]: '{"installed_at":1}' }, { writeThrows: true });
    const warns: string[][] = [];
    const res = await migrateOldPluginFolder({ ...BASE, adapter, log: { warn: (...a) => warns.push(a) } });
    t.false(res.migrated);
    t.is(res.reason, 'error');
    t.is(warns.length, 1);
});

test('mkdir rzuca → migracja i tak przechodzi (best-effort)', async t => {
    const adapter = makeAdapter({ [OLD]: '{"installed_at":1}' }, { mkdirThrows: true });
    const res = await migrateOldPluginFolder({ ...BASE, adapter });
    t.true(res.migrated);
    t.is(adapter.calls.write.length, 1);
});

test('brak mkdir w adapterze → nie wywala się', async t => {
    const adapter = makeAdapter({ [OLD]: '{"installed_at":1}' });
    delete adapter.mkdir;
    const res = await migrateOldPluginFolder({ ...BASE, adapter });
    t.true(res.migrated);
});

test('configDir domyślnie .obsidian gdy nie podany', async t => {
    const adapter = makeAdapter({ [OLD]: '{"installed_at":1}' });
    const res = await migrateOldPluginFolder({ adapter, manifestId: 'pkm-assistant' });
    t.true(res.migrated);
    t.is(adapter.calls.write[0][0], NEW);
});
