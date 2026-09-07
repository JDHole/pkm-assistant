/**
 * Pancerz ustawień — zamyka luki F-11/F-12 (do clean-room jedynym dowodem na tę warstwę był
 * harness end-to-end).
 *
 * Reguła nadrzędna: pancerz NIGDY nie pisze do `SETTINGS_PATH`. Wolno mu dotknąć wyłącznie
 * odkładki `settings.corrupt-<ts>.json`, kopii `last-good` i katalogu backupów.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

import { createVaultSettingsIo, loadSettingsWithArmor, readUiLanguage } from './settingsArmor.js';
import {
    SETTINGS_BACKUPS_DIR,
    SETTINGS_BACKUP_RETENTION,
    SETTINGS_CORRUPT_PATH_PATTERN,
    SETTINGS_LAST_GOOD_PATH,
    SETTINGS_PATH,
    SETTINGS_PRE_MIGRATION_PATH,
} from './contracts.js';
import type { SettingsBag, SettingsIo } from './contracts.js';

/**
 * Realny worek w STARYM kształcie. Trzymamy go w `__fixtures__/` (kwarantanna), a nie inline —
 * poza plikiem migratora i jego fixture'ami stare nazwy kluczy nie mają prawa wystąpić w repo.
 */
const STARY_WOREK = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'settings_v2.1.json'),
    'utf8',
);

const DEFAULTS: SettingsBag = { pkmAssistant: { language: 'en', chat: { platform: '', apiKeys: {} } } };

interface Fake {
    io: SettingsIo;
    files: Record<string, string>;
    reads: string[];
    writes: Array<{ path: string; data: string }>;
    /** Ścieżki, o których założenie prosił pancerz — pilnują, że dostaje KATALOG, nie plik. */
    mkdirs: string[];
    removed: string[];
}

function makeIo(files: Record<string, string> = {}, now = 1_700_000_000_000): Fake {
    const reads: string[] = [];
    const writes: Array<{ path: string; data: string }> = [];
    const mkdirs: string[] = [];
    const removed: string[] = [];
    const io: SettingsIo = {
        async read(p) {
            reads.push(p);
            return p in files ? files[p] : null;
        },
        async write(p, data) {
            writes.push({ path: p, data });
            files[p] = data;
        },
        async mkdir(p) { mkdirs.push(p); },
        async list(dir) {
            const prefix = dir.endsWith('/') ? dir : `${dir}/`;
            return { files: Object.keys(files).filter(k => k.startsWith(prefix)), folders: [] };
        },
        async remove(p) { removed.push(p); delete files[p]; },
        now: () => now,
    };
    return { io, files, reads, writes, mkdirs, removed };
}

// ── C3.1 ─────────────────────────────────────────────────────────────────────
test('zdrowy plik → source "primary", plik nietknięty, last-good = kopia 1:1', async t => {
    const zdrowy = JSON.stringify({ pkmAssistant: { language: 'pl' } });
    const fake = makeIo({ [SETTINGS_PATH]: zdrowy });

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.source, 'primary');
    t.false(fake.writes.some(w => w.path === SETTINGS_PATH), 'pancerz dotknął pliku ustawień');
    const lastGood = fake.writes.find(w => w.path === SETTINGS_LAST_GOOD_PATH);
    t.truthy(lastGood, 'kopia last-good nie powstała');
    t.is(lastGood!.data, zdrowy, 'kopia nie jest bajt w bajt tym, co się sparsowało');
    t.is(wynik.lastGoodRefreshed, true);
});

// ── C3.2 ─────────────────────────────────────────────────────────────────────
test('zdrowy plik → odkładka corrupt NIE powstaje', async t => {
    const fake = makeIo({ [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: {} }) });
    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.quarantinedPath, undefined);
    t.false(fake.writes.some(w => SETTINGS_CORRUPT_PATH_PATTERN.test(w.path)));
});

// ── C3.3 ─────────────────────────────────────────────────────────────────────
test('urwany JSON bez kopii → defaulty, oryginał nietknięty, DOKŁADNIE jedna odkładka 1:1', async t => {
    const urwany = '{"pkmAssistant": {"language": "pl", "chat": {"apiKeys": {"openai": "sk-';
    const fake = makeIo({ [SETTINGS_PATH]: urwany });

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.source, 'defaults');
    t.is(fake.files[SETTINGS_PATH], urwany, 'uszkodzony oryginał został nadpisany');
    const odkladki = fake.writes.filter(w => SETTINGS_CORRUPT_PATH_PATTERN.test(w.path));
    t.is(odkladki.length, 1, 'liczba odkładek musi być DOKŁADNIE jedna');
    t.is(odkladki[0].data, urwany, 'odkładka nie jest kopią 1:1');
    t.false(fake.writes.some(w => w.path === SETTINGS_LAST_GOOD_PATH), 'last-good awansował z uszkodzonej treści');
    t.false(fake.writes.some(w => w.path.startsWith(SETTINGS_BACKUPS_DIR)), 'backup dzienny powstał z uszkodzonego pliku');
});

// ── C3.4 ─────────────────────────────────────────────────────────────────────
test('urwany JSON → parser odrzuca CAŁOŚĆ, nie skleja strzępów', async t => {
    const urwany = '{"pkmAssistant": {"language": "pl"}, "sekret": "sk-abc';
    const fake = makeIo({ [SETTINGS_PATH]: urwany });

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.settings.sekret, undefined, 'strzęp z uszkodzonego pliku przeciekł do wyniku');
    t.is((wynik.settings.pkmAssistant as Record<string, unknown>).language, 'en',
        'język z uszkodzonego pliku przeciekł — parser wydłubał klucz zamiast odrzucić całość');
});

// ── C3.5 (regresja `parsedFromRaw`) ──────────────────────────────────────────
test('urwany JSON + zdrowy last-good → source "last-good", kopia NIETKNIĘTA', async t => {
    const kopia = JSON.stringify({ pkmAssistant: { language: 'pl', userColor: '#abc' } });
    const fake = makeIo({ [SETTINGS_PATH]: '{"urwane', [SETTINGS_LAST_GOOD_PATH]: kopia });

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.source, 'last-good');
    t.is((wynik.settings.pkmAssistant as Record<string, unknown>).userColor, '#abc');
    t.is(fake.files[SETTINGS_LAST_GOOD_PATH], kopia, 'JEDYNA kopia zapasowa usera została nadpisana');
    t.false(fake.writes.some(w => w.path === SETTINGS_LAST_GOOD_PATH), 'kopia awansowała z uszkodzonej treści');
});

// ── C3.6 ─────────────────────────────────────────────────────────────────────
test('pusty obiekt {} nie awansuje na last-good', async t => {
    const fake = makeIo({ [SETTINGS_PATH]: '{}' });
    await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.false(fake.writes.some(w => w.path === SETTINGS_LAST_GOOD_PATH),
        'pusty worek awansował na kopię — user straciłby ostatnie dobre ustawienia');
});

// ── C3.7 (luka F-12) ─────────────────────────────────────────────────────────
test('backup dzienny POWSTAJE przy zdrowym pliku', async t => {
    const zdrowy = JSON.stringify({ pkmAssistant: { language: 'pl' } });
    const fake = makeIo({ [SETTINGS_PATH]: zdrowy });

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    const backupy = fake.writes.filter(w => w.path.startsWith(SETTINGS_BACKUPS_DIR));
    t.is(backupy.length, 1);
    t.regex(backupy[0].path, /\d{4}-\d{2}-\d{2}/, 'nazwa backupu nie niesie daty');
    t.is(wynik.backupWritten, true);
});

// ── C3.8 (luka F-12) ─────────────────────────────────────────────────────────
test('rotacja backupów tnie do 7', async t => {
    const files: Record<string, string> = { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: {} }) };
    for (let i = 1; i <= 9; i++) {
        files[`${SETTINGS_BACKUPS_DIR}/settings.2026-08-0${i}.json`] = '{}';
    }
    const fake = makeIo(files);

    await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    const zostalo = Object.keys(fake.files).filter(k => k.startsWith(SETTINGS_BACKUPS_DIR));
    t.is(zostalo.length, SETTINGS_BACKUP_RETENTION, 'rotacja nie przycięła katalogu backupów do 7');
    t.true(fake.removed.some(p => p.includes('2026-08-01')), 'rotacja skasowała nie najstarsze pliki');
    t.false(fake.removed.some(p => p.includes('2026-08-09')), 'rotacja skasowała najświeższy backup');
});

// ── C3.10 (S-15 po kasacji importu) ──────────────────────────────────────────
test('brak settings.json i brak kopii → DEFAULTY, zero prób czytania czegokolwiek innego', async t => {
    const fake = makeIo({});

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.source, 'defaults');
    t.deepEqual(wynik.settings, DEFAULTS);
    t.deepEqual(fake.reads, [SETTINGS_PATH, SETTINGS_LAST_GOOD_PATH],
        'pancerz sięgnął po ścieżkę spoza `.pkm-assistant/` — import z cudzego katalogu został SKASOWANY');
    t.deepEqual(fake.writes, [], 'pancerz założył marker albo cokolwiek innego zapisał');
});

// ── C3.11 (S-16, incydent 2026-07-28) ────────────────────────────────────────
test('pancerz NIGDY nie woła exists()', async t => {
    const fake = makeIo({ [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: {} }) });
    // `SettingsIo` w ogóle nie ma metody `exists` — gdyby pancerz jej szukał, poleci TypeError.
    (fake.io as unknown as Record<string, unknown>).exists = () => {
        throw new Error('exists() KŁAMIE na dysku sieciowym — pancerz nie ma prawa go wołać');
    };

    await t.notThrowsAsync(loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS }));
});

// ── C3.12 ────────────────────────────────────────────────────────────────────
test('nazwa odkładki pasuje do SETTINGS_CORRUPT_PATH_PATTERN', async t => {
    const fake = makeIo({ [SETTINGS_PATH]: 'to nie jest json' });
    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.truthy(wynik.quarantinedPath);
    t.regex(wynik.quarantinedPath!, SETTINGS_CORRUPT_PATH_PATTERN,
        'scenariusze 26/27 pinują DOKŁADNIE ten wzorzec nazwy');
});

// ── C3.13 (spec §6 zasada 6) ─────────────────────────────────────────────────
test('migracje biegną w PAMIĘCI — wynik ma nowe klucze, dysk stary', async t => {
    const stary = STARY_WOREK;
    const fake = makeIo({ [SETTINGS_PATH]: stary });

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.migrations.legacyKeys, true);
    t.is(wynik.migrations.namespace, true);
    t.is(((wynik.settings.pkmAssistant as Record<string, Record<string, string>>).chat).platform, 'deepseek');
    t.is(fake.files[SETTINGS_PATH], stary, 'migracja poszła na dysk w trakcie bootu — boot NIE PISZE');
    t.false(fake.writes.some(w => w.path === SETTINGS_PATH));
});

// ── C3.14 ────────────────────────────────────────────────────────────────────
test('pierwszy zapis po migracji poprzedza kopia settings.pre-clean-room.json', async t => {
    const fake = makeIo({ [SETTINGS_PATH]: STARY_WOREK });

    await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });
    t.false(fake.writes.some(w => w.path === SETTINGS_PRE_MIGRATION_PATH), 'kopia powstała już przy boocie');

    // drugi boot na tym samym worku (migracja już przeprowadzona) nie powtarza kopii
    const przedDrugim = fake.writes.length;
    await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });
    const kopie = fake.writes.slice(przedDrugim).filter(w => w.path === SETTINGS_PRE_MIGRATION_PATH);
    t.is(kopie.length, 0, 'kopia sprzed migracji jest JEDNORAZOWA');
});

// ── C7.9 / E-22 — `readUiLanguage` (funkcja żyje w tym pliku) ────────────────
test('readUiLanguage: kolejność kandydatów + brak exists() + fallback "en"', async t => {
    const odczyty: string[] = [];
    const adapter = {
        read: async (p: string) => {
            odczyty.push(p);
            if (p === SETTINGS_LAST_GOOD_PATH) return JSON.stringify({ pkmAssistant: { language: 'pl' } });
            throw new Error('ENOENT');
        },
        exists: async () => { throw new Error('exists() KŁAMIE — nie wolno go wołać'); },
    } as unknown as Parameters<typeof readUiLanguage>[0];

    t.is(await readUiLanguage(adapter), 'pl');
    t.deepEqual(odczyty, [SETTINGS_PATH, SETTINGS_LAST_GOOD_PATH],
        'zła kolejność kandydatów albo sięgnięcie po plik spoza `.pkm-assistant/`');

    t.is(await readUiLanguage(null), 'en', 'brak adaptera musi dawać fallback, nie wyjątek');
    t.is(await readUiLanguage({ read: async () => 'to nie jest json' } as never), 'en',
        'nieczytelny plik musi dawać fallback — rejestracja komend nie ma prawa wywalić onload()');
});

// ── C3.16 ────────────────────────────────────────────────────────────────────
test('brak czytelnych ustawień → RAPORT migracji jest wyzerowany', async t => {
    const fake = makeIo({});

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.deepEqual(wynik.migrations, { namespace: false, legacyKeys: false },
        'start na defaultach zameldował migrację, której nikt nie przeprowadził');
    t.is(wynik.lastGoodRefreshed, false);
    t.is(wynik.backupWritten, false);
});

// ── C3.17 ────────────────────────────────────────────────────────────────────
test('mkdir dostaje KATALOG kopii, nie ścieżkę pliku', async t => {
    const fake = makeIo({ [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) });

    await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.deepEqual(fake.mkdirs, ['.pkm-assistant', '.pkm-assistant/backups'],
        'pancerz zakłada katalog wyliczony ze ścieżki — inaczej zapis kopii pada na dysku bez katalogu');
});

// ── C3.18 ────────────────────────────────────────────────────────────────────
test('dysk tylko-do-odczytu → degradacja, a raport MÓWI, że kopii nie ma', async t => {
    const zdrowy = JSON.stringify({ pkmAssistant: { language: 'pl' } });
    const fake = makeIo({ [SETTINGS_PATH]: zdrowy });
    fake.io.write = async () => { throw new Error('EROFS'); };

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.source, 'primary', 'nieudany zapis kopii nie ma prawa zepsuć wczytania');
    t.is((wynik.settings.pkmAssistant as Record<string, unknown>).language, 'pl');
    t.is(wynik.lastGoodRefreshed, false, 'raport kłamie: kopia last-good nie powstała');
    t.is(wynik.backupWritten, false, 'raport kłamie: backup dzienny nie powstał');
});

// ── C3.19 ────────────────────────────────────────────────────────────────────
test('dysk tylko-do-odczytu + nieczytelny plik → BRAK ścieżki odkładki w raporcie', async t => {
    const fake = makeIo({ [SETTINGS_PATH]: '{"urwane' });
    fake.io.write = async () => { throw new Error('EROFS'); };

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.source, 'defaults');
    t.is(wynik.quarantinedPath, undefined,
        'raport wskazuje odkładkę, której na dysku nie ma — user szukałby nieistniejącego pliku');
});

// ── C3.20 ────────────────────────────────────────────────────────────────────
test('backup na dziś już jest → drugi boot go NIE nadpisuje i nie rotuje', async t => {
    // `makeIo` wstrzykuje zegar 1_700_000_000_000 ms = 2023-11-14 UTC.
    const dzisiejszy = `${SETTINGS_BACKUPS_DIR}/settings.2023-11-14.json`;
    const fake = makeIo({
        [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }),
        [dzisiejszy]: '{"stary":"backup"}',
    });

    const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

    t.is(wynik.backupWritten, false, 'raport mówi o backupie, którego ten boot nie zrobił');
    t.false(fake.writes.some(w => w.path.startsWith(SETTINGS_BACKUPS_DIR)),
        'drugi boot tego samego dnia nadpisał backup — dobowa migawka przestałaby być dobowa');
    t.is(fake.files[dzisiejszy], '{"stary":"backup"}');
    t.deepEqual(fake.removed, [], 'rotacja ruszyła mimo braku nowego backupu');
});

// ── C3.21 ────────────────────────────────────────────────────────────────────
test('poprawny JSON, ale nie obiekt (liczba / tekst / tablica) → to NIE są ustawienia', async t => {
    for (const tresc of ['42', '"pl"', 'true', '[]']) {
        const fake = makeIo({ [SETTINGS_PATH]: tresc });

        const wynik = await loadSettingsWithArmor({ io: fake.io, defaults: DEFAULTS });

        t.is(wynik.source, 'defaults', `treść ${tresc} awansowała na ustawienia`);
        t.deepEqual(wynik.settings, DEFAULTS, `treść ${tresc} przeciekła do worka ustawień`);
        t.truthy(wynik.quarantinedPath, `treść ${tresc} nie trafiła do kwarantanny`);
        t.false(fake.writes.some(w => w.path === SETTINGS_LAST_GOOD_PATH));
    }
});

// ── C3.22 ────────────────────────────────────────────────────────────────────
test('createVaultSettingsIo: każda metoda idzie do adaptera vaulta', async t => {
    const wolania: unknown[][] = [];
    const adapter = {
        read: async (p: string) => { wolania.push(['read', p]); return 'tresc'; },
        write: async (p: string, d: string) => { wolania.push(['write', p, d]); },
        mkdir: async (p: string) => { wolania.push(['mkdir', p]); },
        list: async (p: string) => {
            wolania.push(['list', p]);
            return { files: ['.pkm-assistant/backups/a.json'], folders: ['.pkm-assistant/backups/x'] };
        },
        remove: async (p: string) => { wolania.push(['remove', p]); },
    } as unknown as Parameters<typeof createVaultSettingsIo>[0];

    const io = createVaultSettingsIo(adapter);
    t.is(await io.read('.pkm-assistant/settings.json'), 'tresc');
    await io.write('.pkm-assistant/settings.last-good.json', '{}');
    await io.mkdir('.pkm-assistant/backups');
    t.deepEqual(await io.list('.pkm-assistant/backups'), {
        files: ['.pkm-assistant/backups/a.json'],
        folders: ['.pkm-assistant/backups/x'],
    }, 'lista katalogu nie wróciła z adaptera — rotacja backupów nie miałaby czego kasować');
    await io.remove('.pkm-assistant/backups/a.json');

    t.deepEqual(wolania, [
        ['read', '.pkm-assistant/settings.json'],
        ['write', '.pkm-assistant/settings.last-good.json', '{}'],
        ['mkdir', '.pkm-assistant/backups'],
        ['list', '.pkm-assistant/backups'],
        ['remove', '.pkm-assistant/backups/a.json'],
    ], 'któraś metoda nie doszła do adaptera albo doszła w złej kolejności');
});

// ── C3.23 ────────────────────────────────────────────────────────────────────
test('createVaultSettingsIo: kaleki adapter degraduje, nie wywala bootu', async t => {
    const io = createVaultSettingsIo({} as unknown as Parameters<typeof createVaultSettingsIo>[0]);

    t.is(await io.read('x'), null);
    await t.notThrowsAsync(io.mkdir('x'), 'brak mkdir w adapterze wywalił zakładanie katalogu');
    t.deepEqual(await io.list('x'), { files: [], folders: [] });
    await t.notThrowsAsync(io.remove('x'), 'brak remove w adapterze wywalił rotację backupów');
    await t.throwsAsync(io.write('x', '{}'), { message: /nie umie pisać/ },
        'zapis bez adaptera musi być głośny — cichy no-op udawałby udaną kopię');
});

// ── C3.24 ────────────────────────────────────────────────────────────────────
test('createVaultSettingsIo: pad adaptera w read/mkdir/list wygląda jak brak pliku', async t => {
    const buch = async (): Promise<never> => { throw new Error('pad dysku'); };
    const io = createVaultSettingsIo({
        read: buch,
        mkdir: buch,
        list: buch,
        remove: buch,
    } as unknown as Parameters<typeof createVaultSettingsIo>[0]);

    t.is(await io.read('x'), null);
    await t.notThrowsAsync(io.mkdir('x'), 'istniejący katalog nie ma prawa zatrzymać zapisu kopii');
    t.deepEqual(await io.list('x'), { files: [], folders: [] });
    await t.throwsAsync(io.remove('x'), { message: 'pad dysku' },
        'kasowanie idzie do adaptera bez tłumika — rotacja sama łapie swoje błędy');
});

// ── C3.25 ────────────────────────────────────────────────────────────────────
test('createVaultSettingsIo: adapter zwracający śmieci z list nie wywraca rotacji', async t => {
    const io = createVaultSettingsIo({
        list: async () => undefined,
    } as unknown as Parameters<typeof createVaultSettingsIo>[0]);

    t.deepEqual(await io.list('x'), { files: [], folders: [] });
});
