/**
 * `NoticeCenter` — zamyka lukę F-04 (powiadomienia nie miały ani jednego testu).
 *
 * Kluczowe rozróżnienie S-17: PROWIZJONOWANIE gałęzi ustawień idzie SUROWYM workiem
 * (`settingsStore.raw`, boot nie pisze), ale WYCISZENIE przez usera to prawdziwa decyzja
 * i MA planować zapis.
 */
import test from 'ava';

import { NoticeCenter } from './NoticeCenter.js';
import { SettingsStore } from './SettingsStore.js';
import { NOTICE_ACTIONS_CSS_CLASS, NOTICE_DEFAULT_TIMEOUT_MS } from './contracts.js';
import type { NoticeHandle, SettingsBag } from './contracts.js';

interface Wywolanie {
    content: string | DocumentFragment;
    timeout: number;
    handle: NoticeHandle & { containerEl?: HTMLElement; hidden: boolean };
}

function makeFactory(wywolania: Wywolanie[]) {
    return (content: string | DocumentFragment, timeout: number) => {
        const handle = { hidden: false, hide() { this.hidden = true; } };
        wywolania.push({ content, timeout, handle });
        return handle;
    };
}

async function makeStore(bag: SettingsBag): Promise<SettingsStore> {
    return SettingsStore.create(
        { loadSettings: () => bag, saveSettings: () => {} },
        { saveDelayMs: 500, load: () => bag, save: () => {} },
    );
}

// ── C5.1 ─────────────────────────────────────────────────────────────────────
test('show() woła fabrykę powiadomienia i zwraca uchwyt', async t => {
    const wywolania: Wywolanie[] = [];
    const store = await makeStore({ pkmAssistant: {} });
    const notices = new NoticeCenter({ createNotice: makeFactory(wywolania), settingsStore: store });

    const uchwyt = notices.show('Indeks gotowy');

    t.is(wywolania.length, 1);
    t.truthy(uchwyt);
    uchwyt!.hide();
    t.true(wywolania[0].handle.hidden);
});

// ── C5.2 ─────────────────────────────────────────────────────────────────────
test('wyciszony id → show() zwraca null i NIC nie pokazuje', async t => {
    const wywolania: Wywolanie[] = [];
    const store = await makeStore({ pkmAssistant: { notices: { muted: { reindex: true } } } });
    const notices = new NoticeCenter({ createNotice: makeFactory(wywolania), settingsStore: store });

    const uchwyt = notices.show('Reindeks', { id: 'reindex' });

    t.is(uchwyt, null);
    t.is(wywolania.length, 0, 'wyciszone powiadomienie i tak trafiło na ekran');
    t.true(notices.isMuted('reindex'));
});

// ── C5.3 (S-17, pierwsza połowa) ─────────────────────────────────────────────
test('mute() planuje zapis (mutacja PRZEZ PROXY)', async t => {
    const store = await makeStore({ pkmAssistant: {} });
    const notices = new NoticeCenter({ createNotice: makeFactory([]), settingsStore: store });

    notices.mute('reindex');

    t.not(store.pendingSaveTimer, null, 'wyciszenie przez usera nie zaplanowało zapisu — decyzja przepadnie');
    t.true(notices.isMuted('reindex'));
});

// ── C5.4 (S-17, druga połowa) ────────────────────────────────────────────────
test('prowizjonowanie pustej gałęzi notices NIE planuje zapisu', async t => {
    const store = await makeStore({ pkmAssistant: {} });
    const notices = new NoticeCenter({ createNotice: makeFactory([]), settingsStore: store });

    notices.show('cokolwiek', { id: 'x', mutable: true });

    t.is(store.pendingSaveTimer, null,
        'samo pokazanie powiadomienia zaplanowało zapis CAŁEGO pliku z kluczami API');
});

// ── C5.4b (decyzja 10) ───────────────────────────────────────────────────────
test('hydratacja sekretów nie planuje zapisu', async t => {
    // `config/defaultSettings.ts` prowizjonuje `chat.apiKeys` i `embedding.apiKeys`, więc
    // czterosegmentowa ścieżka sekretu (`pkmAssistant.chat.apiKeys.openai`) NIE dotwarza
    // kontenerów. Warstwa sekretów pracuje na SUROWYM worku, nigdy na proxy.
    const zapisy: SettingsBag[] = [];
    const bag: SettingsBag = {
        pkmAssistant: {
            chat: { platform: '', apiKeys: {}, models: {}, hosts: {} },
            embedding: { provider: '', models: {}, apiKeys: {}, hosts: {} },
        },
    };
    const store = await SettingsStore.create(
        { loadSettings: () => bag, saveSettings: (s: SettingsBag) => { zapisy.push(s); } },
        { saveDelayMs: 5, load: () => bag, save: (s: SettingsBag) => { zapisy.push(s); } },
    );

    const raw = store.raw.pkmAssistant as Record<string, Record<string, Record<string, string>>>;
    raw.chat.apiKeys.openai = 'sk-hydratowany';
    raw.embedding.apiKeys.gemini = 'AIza-hydratowany';

    await new Promise(r => setTimeout(r, 30));

    t.is(store.pendingSaveTimer, null, 'hydratacja sekretów zaplanowała zapis — S-07 i scenariusz 39 padają cicho');
    t.is(zapisy.length, 0);
});

// ── C5.5 (N-03) ──────────────────────────────────────────────────────────────
test('guziki akcji dostają klasę pkm-notice-actions', async t => {
    const wywolania: Wywolanie[] = [];
    const store = await makeStore({ pkmAssistant: {} });
    const notices = new NoticeCenter({ createNotice: makeFactory(wywolania), settingsStore: store });

    notices.show('Zrobione', { actions: [{ label: 'Otwórz', onClick: () => {} }] });

    t.is(wywolania.length, 1);
    const content = wywolania[0].content;
    const html = typeof content === 'string'
        ? content
        : (content as unknown as { innerHTML?: string }).innerHTML
            ?? [...(content as DocumentFragment).childNodes].map(n => (n as HTMLElement).className ?? '').join(' ');
    t.true(String(html).includes(NOTICE_ACTIONS_CSS_CLASS),
        'kontener guzików nie dostał jedynej żywej klasy powiadomień');
});

// ── C5.6 (N-01) ──────────────────────────────────────────────────────────────
test('unload() zamyka wszystkie żywe powiadomienia', async t => {
    const wywolania: Wywolanie[] = [];
    const store = await makeStore({ pkmAssistant: {} });
    const notices = new NoticeCenter({ createNotice: makeFactory(wywolania), settingsStore: store });

    notices.show('pierwsze');
    notices.show('drugie');
    notices.unload();

    t.is(wywolania.length, 2);
    t.true(wywolania.every(w => w.handle.hidden), 'powiadomienie przeżyło demontaż pluginu');
});

// ── C5.7 ─────────────────────────────────────────────────────────────────────
test('timeout domyślny = NOTICE_DEFAULT_TIMEOUT_MS', async t => {
    const wywolania: Wywolanie[] = [];
    const store = await makeStore({ pkmAssistant: {} });
    const notices = new NoticeCenter({ createNotice: makeFactory(wywolania), settingsStore: store });

    notices.show('bez opcji');
    t.is(wywolania[0].timeout, NOTICE_DEFAULT_TIMEOUT_MS);

    notices.show('z zerem', { timeout: 0 });
    t.is(wywolania[1].timeout, 0, '`0` znaczy „nie znika samo" i nie może zostać podmienione na default');
});

// ── C5.8 (N-02, druga strona bramki) ─────────────────────────────────────────
test('NIEwyciszony id przechodzi — show() pokazuje i zwraca uchwyt', async t => {
    const wywolania: Wywolanie[] = [];
    const store = await makeStore({ pkmAssistant: { notices: { muted: { inny: true } } } });
    const notices = new NoticeCenter({ createNotice: makeFactory(wywolania), settingsStore: store });

    const uchwyt = notices.show('Reindeks', { id: 'reindex' });

    t.truthy(uchwyt, 'samo podanie id zdusiło powiadomienie, choć nikt go nie wyciszył');
    t.is(wywolania.length, 1);
    t.is(wywolania[0].content, 'Reindeks',
        'powiadomienie bez `mutable` dostało guzik — treść przestała być gołym tekstem');
});

// ── C5.9 (N-02 + N-03: guzik „wycisz" wymaga OBU warunków) ───────────────────
test('guzik „wycisz" pojawia się TYLKO przy mutable + id', async t => {
    const wywolania: Wywolanie[] = [];
    const store = await makeStore({ pkmAssistant: {} });
    const notices = new NoticeCenter({ createNotice: makeFactory(wywolania), settingsStore: store });

    notices.show('bez id', { mutable: true });
    t.is(wywolania[0].content, 'bez id',
        '`mutable` bez id dorobiło guzik wyciszający nieistniejący identyfikator');

    notices.show('bez mutable', { id: 'reindex' });
    t.is(wywolania[1].content, 'bez mutable', 'samo id wystarczyło, żeby dorobić guzik „wycisz"');

    notices.show('oba', { id: 'reindex', mutable: true });
    t.not(wywolania[2].content, 'oba', 'mutable + id NIE dostało guzika „wycisz"');
    t.true(String(wywolania[2].content).includes(NOTICE_ACTIONS_CSS_CLASS));
});

// ── C5.10 (fabryka pada) ─────────────────────────────────────────────────────
test('padnięta fabryka → show() zwraca null i melduje wstrzykniętym logiem', async t => {
    const store = await makeStore({ pkmAssistant: {} });
    const bledy: unknown[][] = [];
    const log = {
        debug: () => {}, info: () => {}, warn: () => {},
        error: (...args: unknown[]) => { bledy.push(args); },
    };
    const notices = new NoticeCenter({
        createNotice: () => { throw new Error('Obsidian padł'); },
        settingsStore: store,
        log,
    });

    t.is(notices.show('cokolwiek'), null, 'padnięta fabryka wypuściła uchwyt donikąd');
    t.is(bledy.length, 1, 'awaria powiadomienia poszła w kosmos zamiast do wstrzykniętego loga');
});
