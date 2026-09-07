/**
 * `SettingsStore` — magazyn ustawień.
 *
 * Trzy pierwsze testy przyjechały 1:1 z `core/utils/SettingsManager.test.ts` (strażnik
 * AUD-bledy-028: `scheduleSave()` wołał zapis w callbacku timera BEZ `await` i BEZ `catch`,
 * więc pad zapisu wychodził jako unhandled rejection). Reszta zamyka lukę F-16: rozróżnienie
 * `settings` (proxy → planuje zapis) od `raw` (surowy worek → NIE planuje).
 */
import test from 'ava';
import { SettingsStore } from './SettingsStore.js';
import type { SettingsBag, SettingsOwner } from './contracts.js';
import { log } from '../utils/Logger.js';

const owner = (): SettingsOwner => ({
    loadSettings: () => ({}),
    saveSettings: () => { throw new Error('nie ta droga - testy podają opts.save'); },
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * AVA sama nasłuchuje `unhandledRejection` i wywala CAŁY plik, więc na czas testu
 * przejmujemy nasłuch (i oddajemy go w `finally`) - inaczej nie da się o rejekcji
 * ASERTOWAĆ, można tylko na niej polec.
 */
async function zlapUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
    const zlapane: unknown[] = [];
    const wczesniejsi = process.listeners('unhandledRejection');
    const szpieg = (reason: unknown) => { zlapane.push(reason); };
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', szpieg);
    try {
        await fn();
    } finally {
        process.removeAllListeners('unhandledRejection');
        for (const l of wczesniejsi) process.on('unhandledRejection', l as () => void);
    }
    return zlapane;
}

// ── C2.6 (przeniesione) ──────────────────────────────────────────────────────
test.serial('scheduleSave: pad zapisu NIE ucieka z timera jako unhandled rejection', async t => {
    const bledy: string[] = [];
    const originalError = log.error;
    log.error = (module: string, message: string) => { bledy.push(`${module} ${message}`); };

    try {
        const zlapane = await zlapUnhandled(async () => {
            const store = new SettingsStore(owner(), {
                saveDelayMs: 5,
                save: async () => { throw new Error('dysk sieciowy odmówił'); },
            });
            store.settings = { pkmAssistant: { a: 1 } } as SettingsBag;
            store.scheduleSave();
            await wait(80);
        });

        t.deepEqual(zlapane, [], 'timer nie zostawia porzuconej obietnicy');
        t.true(bledy.some(b => b.startsWith('SettingsStore')), 'pad zapisu zostaje zalogowany, nie zjedzony');
    } finally {
        log.error = originalError;
    }
});

// ── C2.5 (przeniesione) ──────────────────────────────────────────────────────
test.serial('udany zapis dostaje CAŁY worek i zeruje pendingSaveTimer', async t => {
    const bledy: string[] = [];
    const originalError = log.error;
    log.error = (module: string, message: string) => { bledy.push(`${module} ${message}`); };

    try {
        const zapisane: SettingsBag[] = [];
        const store = new SettingsStore(owner(), {
            saveDelayMs: 5,
            save: async (s: SettingsBag) => { zapisane.push(s); },
        });
        store.settings = { pkmAssistant: { a: 1 } } as SettingsBag;
        store.scheduleSave();
        await wait(40);

        t.is(zapisane.length, 1);
        t.deepEqual(zapisane[0], { pkmAssistant: { a: 1 } });
        t.deepEqual(bledy, []);
        t.is(store.pendingSaveTimer, null, 'uchwyt timera posprzątany');
    } finally {
        log.error = originalError;
    }
});

// ── C2.4 (przeniesione) ──────────────────────────────────────────────────────
test.serial('trzy scheduleSave pod rząd = jeden zapis', async t => {
    const zapisane: SettingsBag[] = [];
    const store = new SettingsStore(owner(), {
        saveDelayMs: 15,
        save: async (s: SettingsBag) => { zapisane.push(s); },
    });
    store.settings = { a: 1 } as SettingsBag;

    store.scheduleSave();
    store.scheduleSave();
    store.scheduleSave();
    await wait(60);

    t.is(zapisane.length, 1);
});

// ── C2.1 ─────────────────────────────────────────────────────────────────────
test.serial('mutacja przez settings planuje zapis (także zagnieżdżona i delete)', async t => {
    const worek: SettingsBag = { pkmAssistant: { chat: { platform: 'deepseek' }, doKasacji: 1 } };
    const store = await SettingsStore.create(
        { loadSettings: () => worek, saveSettings: () => {} },
        { saveDelayMs: 50, load: () => worek, save: () => {} },
    );

    t.is(store.pendingSaveTimer, null, 'świeży magazyn nie ma nic zaplanowanego');

    (store.settings.pkmAssistant as Record<string, unknown>).nowe = 1;
    t.not(store.pendingSaveTimer, null, 'mutacja płytka planuje zapis');

    const store2 = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: { chat: { platform: 'deepseek' } } }), saveSettings: () => {} },
        { saveDelayMs: 50, save: () => {} },
    );
    ((store2.settings.pkmAssistant as Record<string, Record<string, unknown>>).chat).platform = 'openai';
    t.not(store2.pendingSaveTimer, null, 'mutacja ZAGNIEŻDŻONA planuje zapis');

    const store3 = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: { doKasacji: 1 } }), saveSettings: () => {} },
        { saveDelayMs: 50, save: () => {} },
    );
    delete (store3.settings.pkmAssistant as Record<string, unknown>).doKasacji;
    t.not(store3.pendingSaveTimer, null, '`delete` też planuje zapis');
});

// ── C2.2 ─────────────────────────────────────────────────────────────────────
test.serial('mutacja przez raw NIE planuje zapisu', async t => {
    const zapisy: SettingsBag[] = [];
    const store = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: {} }), saveSettings: (s: SettingsBag) => { zapisy.push(s); } },
        { saveDelayMs: 5, save: (s: SettingsBag) => { zapisy.push(s); } },
    );

    (store.raw.pkmAssistant as Record<string, unknown>).security = {};
    (store.raw as Record<string, unknown>).nowaGalaz = { a: 1 };
    await wait(30);

    t.is(store.pendingSaveTimer, null, 'provisioning bootowy nie planuje zapisu');
    t.is(zapisy.length, 0, 'boot nie zapisał pliku z kluczami API');
});

// ── C2.3 ─────────────────────────────────────────────────────────────────────
test.serial('przypisanie TEJ SAMEJ wartości nie planuje zapisu', async t => {
    const store = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: { chat: { apiKeys: { deepseek: 'sk-abc' } } } }), saveSettings: () => {} },
        { saveDelayMs: 50, save: () => {} },
    );

    const chat = (store.settings.pkmAssistant as Record<string, Record<string, Record<string, string>>>).chat;
    chat.apiKeys.deepseek = 'sk-abc'; // mostek klucza harnessu wstrzykuje IDENTYCZNĄ wartość

    t.is(store.pendingSaveTimer, null, 'no-op nie ma prawa planować zapisu całego pliku');
});

// ── C2.7 (S-18, wtopa 2026-07-28) ────────────────────────────────────────────
test.serial('save() bez argumentu nie istnieje — owner dostaje worek zawsze', async t => {
    const podane: unknown[] = [];
    const store = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: { a: 1 } }), saveSettings: (s: SettingsBag) => { podane.push(s); } },
        {},
    );

    await store.save();

    t.is(podane.length, 1);
    t.not(podane[0], undefined, 'saveSettings NIGDY nie dostaje undefined (JSON.stringify(undefined) kasował plik)');
    t.deepEqual(podane[0], { pkmAssistant: { a: 1 } });
});

// ── C2.9 ─────────────────────────────────────────────────────────────────────
test.serial('raw i settings pokazują TE SAME dane', async t => {
    const store = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: {} }), saveSettings: () => {} },
        { saveDelayMs: 50, save: () => {} },
    );

    (store.raw.pkmAssistant as Record<string, unknown>).zRaw = 1;
    t.is((store.settings.pkmAssistant as Record<string, unknown>).zRaw, 1, 'zapis przez raw widać w settings');

    (store.settings.pkmAssistant as Record<string, unknown>).zProxy = 2;
    t.is((store.raw.pkmAssistant as Record<string, unknown>).zProxy, 2, 'zapis przez settings widać w raw');
});

// ── C2.10 (F10/mutacje: L43) ─────────────────────────────────────────────────
test.serial('saveDelayMs: 0 znaczy „bez zwłoki", a nie „brak wartości"', async t => {
    const zapisy: SettingsBag[] = [];
    const store = new SettingsStore(owner(), {
        saveDelayMs: 0,
        save: (s: SettingsBag) => { zapisy.push(s); },
    });
    store.settings = { a: 1 } as unknown as SettingsBag;

    store.scheduleSave();
    t.not(store.pendingSaveTimer, null, 'zero też idzie przez timer, nie synchronicznie');
    await wait(40);

    t.is(zapisy.length, 1, 'przy zerowym debounce zapis leci od razu, nie po domyślnej sekundzie');
    t.is(store.pendingSaveTimer, null);
});

// ── C2.11 (F10/mutacje: L118) ────────────────────────────────────────────────
test.serial('onChange: funkcja dostaje worek po zapisie, uchwyt ją odpina, nie-funkcja jest ignorowana', async t => {
    const widziane: SettingsBag[] = [];
    const bledy: string[] = [];
    const store = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: { a: 1 } }) as unknown as SettingsBag, saveSettings: () => {} },
        {
            save: () => {},
            log: {
                debug: () => {}, info: () => {}, warn: () => {},
                error: (scope: string, msg: string) => { bledy.push(`${scope} ${msg}`); },
            },
        },
    );

    const odepnij = store.onChange((s: SettingsBag) => { widziane.push(s); });
    await store.save();
    t.is(widziane.length, 1, 'słuchacz podany do onChange NAPRAWDĘ zostaje zapisany i wołany');
    t.deepEqual(widziane[0], { pkmAssistant: { a: 1 } }, 'słuchacz dostaje cały worek');

    odepnij();
    await store.save();
    t.is(widziane.length, 1, 'uchwyt zwrócony przez onChange odpina słuchacza');

    const pusty = store.onChange(null as unknown as (s: SettingsBag) => void);
    t.is(typeof pusty, 'function', 'nie-funkcja dostaje pusty uchwyt zamiast wyjątku');
    await t.notThrowsAsync(store.save());
    t.deepEqual(bledy, [], 'nie-funkcja nigdy nie trafiła na listę słuchaczy, więc nic nie padło przy zapisie');
});

// ── C2.12 (F10/mutacje: L167) ────────────────────────────────────────────────
test.serial('delete nieistniejącego klucza jest bezszkodowy i nic nie planuje', async t => {
    const store = await SettingsStore.create(
        { loadSettings: () => ({ pkmAssistant: {} }), saveSettings: () => {} },
        { saveDelayMs: 50, save: () => {} },
    );

    t.true(
        Reflect.deleteProperty(store.settings as unknown as object, 'niczegoTakiegoNieMa'),
        'proxy potwierdza kasację klucza, którego nie było (odmowa = TypeError w strict mode)',
    );
    t.notThrows(() => { delete (store.settings as unknown as Record<string, unknown>).aniTego; });
    t.is(store.pendingSaveTimer, null, 'kasacja nieistniejącego klucza nie planuje zapisu całego pliku');
});

// ── C2.13 (F10/mutacje: L181, L182) ──────────────────────────────────────────
test.serial('obserwacja: null i prymitywy przechodzą bez szwanku, tablice są obserwowane, instancje klas NIE', async t => {
    class Klient { odpal(): void {} }
    const klient = new Klient();
    const store = await SettingsStore.create(
        {
            loadSettings: () => ({ pusty: null, tekst: 'abc', lista: [1, 2], klient }) as unknown as SettingsBag,
            saveSettings: () => {},
        },
        { saveDelayMs: 50, save: () => {} },
    );
    const s = store.settings as unknown as Record<string, unknown>;
    const raw = store.raw as unknown as Record<string, unknown>;

    t.is(s.pusty, null, 'null czyta się jako null, a nie wysadza obserwatora');
    t.is(s.tekst, 'abc', 'prymityw wraca bez owijki');
    t.is(s.klient, klient, 'instancja klasy zostaje sobą — nie owijamy klientów ani modeli');

    (s.lista as number[]).push(3);
    t.not(store.pendingSaveTimer, null, 'mutacja TABLICY planuje zapis (tablica jest obserwowana)');
    t.deepEqual(raw.lista, [1, 2, 3], 'mutacja tablicy dosięga worka');
});

// ── C2.14 (F10/mutacje: L189, L190) ──────────────────────────────────────────
test.serial('do worka wchodzi goły obiekt, nigdy owijka ani undefined', async t => {
    const store = await SettingsStore.create(
        { loadSettings: () => ({ zrodlo: { a: 1 } }) as unknown as SettingsBag, saveSettings: () => {} },
        { saveDelayMs: 50, save: () => {} },
    );
    const s = store.settings as unknown as Record<string, unknown>;
    const raw = store.raw as unknown as Record<string, unknown>;

    s.kopia = s.zrodlo; // czytane przez proxy = owijka; do worka ma wejść oryginał
    t.is(raw.kopia, raw.zrodlo, 'przepisana wartość to TEN SAM goły obiekt, nie proxy');

    s.nowa = { b: 2 };
    t.deepEqual(raw.nowa, { b: 2 }, 'świeży obiekt wchodzi do worka w całości');
    t.is(typeof raw.nowa, 'object');

    s.liczba = 7;
    s.nic = null;
    t.is(raw.liczba, 7, 'prymityw przechodzi nietknięty');
    t.is(raw.nic, null, 'null przechodzi jako null, nie jako undefined');
});
