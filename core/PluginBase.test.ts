/**
 * `PluginBase` - testy pokrywają wersjonowanie usera i `plugin.settings` (od nich zależy,
 * czy user dostanie powitanie „nowy użytkownik" i modal „co nowego").
 *
 * ⚠️ OGRANICZENIE ŚRODOWISKA: `core/PluginBase.ts` dziedziczy po
 * `Plugin` Obsidiana, a pakiet `obsidian` w `node_modules` to SAME TYPY - nie ma runtime'u.
 * AVA nie ma atrapy `obsidian`, więc import klasy jest zrobiony DYNAMICZNIE, w środku
 * każdego testu: dzięki temu brak atrapy jest czerwienią JEDNEGO testu z czytelnym powodem,
 * a nie wywrotką całego pliku. Gdy atrapa się pojawi (jest w `test-support/obsidian.ts`, wpinana
 * preloadem AVA), testy zaczną trafiać w rzuty stubów bez żadnej zmiany w treści asercji.
 */
import test from 'ava';

import { NOTICE_DEFAULT_TIMEOUT_MS } from './runtime/contracts.js';
import { CHAT_VIEW_TYPE } from './utils/viewTypes.js';
import type { NoticeHandle, PluginVersionData, SettingsBag } from './runtime/contracts.js';

type BaseClass = typeof import('./PluginBase.js')['PluginBase'];

async function loadBase(): Promise<BaseClass> {
    const mod = await import('./PluginBase.js');
    return mod.PluginBase;
}

interface HostSpy {
    data: PluginVersionData | null;
    zapisy: PluginVersionData[];
}

/** Buduje podklasę spełniającą abstrakcyjny kontrakt bazy i stawia ją na atrapie hosta. */
async function makePlugin(spy: HostSpy, manifestVersion = '2.2.0', gitignore?: { content: string | null; appended: string[] }) {
    const PluginBase = await loadBase();
    class TestPlugin extends PluginBase {
        get itemViews() { return {}; }
        get ribbonIcons() { return {}; }
        get settingsTabClass() { return class {} as never; }
    }
    const plugin = Object.create(TestPlugin.prototype) as InstanceType<typeof TestPlugin>;
    Object.assign(plugin, {
        manifest: { id: 'pkm-assistant', version: manifestVersion },
        loadData: async () => spy.data,
        saveData: async (d: PluginVersionData) => { spy.zapisy.push(d); spy.data = d; },
        app: {
            vault: {
                adapter: {
                    read: async () => {
                        if (gitignore?.content == null) throw new Error('ENOENT');
                        return gitignore.content;
                    },
                    append: async (_p: string, data: string) => { gitignore?.appended.push(data); },
                    write: async (_p: string, data: string) => { gitignore?.appended.push(data); },
                    exists: async () => gitignore?.content != null,
                },
            },
        },
    });
    return plugin;
}

test('isNewUser: brak data.json → true', async t => {
    const plugin = await makePlugin({ data: null, zapisy: [] });
    t.is(await plugin.isNewUser(), true);
});

test('isNewUser: data.json z installed_at → false', async t => {
    const plugin = await makePlugin({ data: { installed_at: 1_700_000_000_000 }, zapisy: [] });
    t.is(await plugin.isNewUser(), false);
});

test('isNewPluginVersion: last_version starsze → true, równe → false', async t => {
    const starsze = await makePlugin({ data: { last_version: '2.1.0' }, zapisy: [] });
    t.is(await starsze.isNewPluginVersion('2.2.0'), true);

    const rowne = await makePlugin({ data: { last_version: '2.2.0' }, zapisy: [] });
    t.is(await rowne.isNewPluginVersion('2.2.0'), false);

    const nowsze = await makePlugin({ data: { last_version: '2.3.0' }, zapisy: [] });
    t.is(await nowsze.isNewPluginVersion('2.2.0'), false, 'cofnięcie wersji nie jest „nową wersją"');
});

test('setLastKnownVersion pisze last_version, NIE rusza installed_at', async t => {
    const spy: HostSpy = { data: { installed_at: 1_700_000_000_000, last_version: '2.1.0' }, zapisy: [] };
    const plugin = await makePlugin(spy);

    await plugin.setLastKnownVersion('2.2.0');

    t.is(spy.zapisy.length, 1);
    t.is(spy.zapisy[0].last_version, '2.2.0');
    t.is(spy.zapisy[0].installed_at, 1_700_000_000_000,
        'installed_at został nadpisany — user dostałby powitanie „nowy użytkownik" po każdej aktualizacji');
});

// ── dziś zero pokrycia ─────────────────────────────────────────────────
test('fixture harnessu (installed_at + last_version 2.1.0) → NIE nowy user I NIE nowa wersja dla 2.1.0', async t => {
    // Dosłownie ten obiekt z fixture harnessu (`vault-fixture/.obsidian/plugins/pkm-assistant/data.json`
    // w https://github.com/JDHole/pkm-assistant-harness).
    const fixture: PluginVersionData = { installed_at: 1753000000000, last_version: '2.1.0' };
    const plugin = await makePlugin({ data: fixture, zapisy: [] }, '2.1.0');

    t.is(await plugin.isNewUser(), false, 'harness zacząłby każdy scenariusz od wizarda nowego usera');
    t.is(await plugin.isNewPluginVersion('2.1.0'), false, 'harness otwierałby modal „co nowego" w każdym scenariuszu');
});

test('plugin.settings NIGDY nie zwraca undefined', async t => {
    const plugin = await makePlugin({ data: null, zapisy: [] });

    t.deepEqual(plugin.settings, {} as SettingsBag, 'bez runtime\'u getter musi oddać pusty worek, nie undefined');

    const worek: SettingsBag = { pkmAssistant: { language: 'pl' } };
    (plugin as unknown as { env: unknown }).env = { settings: worek };
    t.is(plugin.settings, worek);
});

test('onReady odpala natychmiast, gdy już gotowe', async t => {
    const plugin = await makePlugin({ data: null, zapisy: [] });
    plugin._ready = true;

    let odpalone = false;
    plugin.onReady(() => { odpalone = true; });

    t.true(odpalone, 'callback po `_ready` został zakolejkowany zamiast odpalić od razu');
});

test('błąd w jednym callbacku onReady nie przerywa pętli', async t => {
    const plugin = await makePlugin({ data: null, zapisy: [] });
    plugin._ready = true;

    const kolejnosc: string[] = [];
    t.notThrows(() => {
        plugin.onReady(() => { kolejnosc.push('pierwszy'); throw new Error('bum'); });
    });
    plugin.onReady(() => { kolejnosc.push('drugi'); });

    t.deepEqual(kolejnosc, ['pierwszy', 'drugi'], 'wywrotka jednego konsumenta zabrała pozostałych');
});

test('waitForReady rozwiązuje się dokładnie raz', async t => {
    const plugin = await makePlugin({ data: null, zapisy: [] });
    plugin._ready = true;

    let ile = 0;
    const p = plugin.waitForReady().then(() => { ile++; });
    await p;
    await new Promise(r => setTimeout(r, 10));

    t.is(ile, 1);
});

test('addToGitignore: no-op bez pliku, dopisuje TYLKO brakujące, idempotentne', async t => {
    const brak = { content: null as string | null, appended: [] as string[] };
    const bezPliku = await makePlugin({ data: null, zapisy: [] }, '2.2.0', brak);
    await bezPliku.addToGitignore('.pkm-assistant/');
    t.deepEqual(brak.appended, [], 'plugin STWORZYŁ .gitignore w vaultcie, którego user nie prowadzi w gicie');

    const zPlikiem = { content: 'node_modules\n.pkm-assistant/\n', appended: [] as string[] };
    const plugin = await makePlugin({ data: null, zapisy: [] }, '2.2.0', zPlikiem);
    await plugin.addToGitignore('.pkm-assistant/');
    t.deepEqual(zPlikiem.appended, [], 'wpis już był — dopisanie duplikatu');

    await plugin.addToGitignore('.pkm-assistant/logs/');
    t.is(zPlikiem.appended.length, 1, 'brakujący wpis nie został dopisany');
    t.true(zPlikiem.appended[0].includes('.pkm-assistant/logs/'));
});

// ═════════════════════════════════════════════════════════════════════════════
// Bramka mutacyjna. Poniższe testy przypinają zachowania, które przeżywały
// podmianę operatorów w `core/PluginBase.ts`: kształt bazowych getterów, bramkę
// „nowy user / nowa wersja", flagę gotowości, ubieranie powiadomień w skórę,
// bramkę kolorów, dopisywanie do `.gitignore`, otwieranie czatu i restart.
// ═════════════════════════════════════════════════════════════════════════════

/** Gniazdo `style`, na którym widać KAŻDE dotknięcie zmiennej CSS. */
interface StyleSink {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
}

function makeStyleSpy(): { set: Array<[string, string]>; removed: string[]; style: StyleSink } {
    const set: Array<[string, string]> = [];
    const removed: string[] = [];
    return {
        set,
        removed,
        style: {
            setProperty(name: string, value: string) { set.push([name, value]); },
            removeProperty(name: string) { removed.push(name); },
        },
    };
}

/**
 * `applyUserColor` czyta GLOBALNY `document`, a AVA biega w gołym Node.
 * Podstawiamy atrapę na czas jednego SYNCHRONICZNEGO wywołania i sprzątamy po sobie
 * (testy korzystające z tego pomocnika idą `test.serial`, żeby nie deptać się nawzajem).
 */
function withFakeDocument(body: { style: StyleSink } | null, fn: () => void): void {
    const scope = globalThis as unknown as { document?: unknown };
    const had = 'document' in scope;
    const previous = scope.document;
    scope.document = { body };
    try {
        fn();
    } finally {
        if (had) scope.document = previous;
        else delete scope.document;
    }
}

/** Podklasa bez atrapy hosta — do testów, które nie tykają `data.json`. */
async function makeBarePlugin(extra: Record<string, unknown> = {}) {
    const PluginBase = await loadBase();
    class TestPlugin extends PluginBase {
        get itemViews() { return {}; }
        get ribbonIcons() { return {}; }
        get settingsTabClass() { return class {} as never; }
        /** `notifyReady` jest `protected` — podklasa (composition root) ma do niego prawo. */
        fireReady(): void { this.notifyReady(); }
    }
    const plugin = Object.create(TestPlugin.prototype) as InstanceType<typeof TestPlugin>;
    Object.assign(plugin, extra);
    return plugin;
}

/** Atrapa kontenera powiadomienia: widać dopięte klasy i ustawione zmienne CSS. */
function makeNoticeHost() {
    const hostClasses: string[] = [];
    const bodyClasses: string[] = [];
    const props: Array<[string, string]> = [];
    const body = { classList: { add: (c: string) => { bodyClasses.push(c); } } };
    const host = {
        classList: { add: (c: string) => { hostClasses.push(c); } },
        querySelector: () => body,
        style: { setProperty: (name: string, value: string) => { props.push([name, value]); } },
    };
    return { host, hostClasses, bodyClasses, props };
}

/** Atrapa centrum powiadomień oddająca podany uchwyt. */
function makeNoticeCenter(handle: NoticeHandle | null) {
    const calls: Array<{ message: string; options: Record<string, unknown> }> = [];
    const center = {
        show(message: string, options: Record<string, unknown> = {}) {
            calls.push({ message, options });
            return handle;
        },
    };
    return { center, calls };
}

/** Atrapa adaptera vaulta pod `.gitignore`: osobno `append`, osobno `write`. */
function makeGitignoreAdapter(content: string | null, options: { withAppend?: boolean } = {}) {
    const appended: string[] = [];
    const written: unknown[] = [];
    const adapter: Record<string, unknown> = {
        read: async () => {
            if (content == null) throw new Error('ENOENT');
            return content;
        },
        write: async (_path: string, data: unknown) => { written.push(data); },
    };
    if (options.withAppend !== false) {
        adapter.append = async (_path: string, data: string) => { appended.push(data); };
    }
    return { adapter, appended, written };
}

test('commands: baza oddaje PUSTY OBIEKT, nie undefined (podklasa rozlewa `...super.commands`)', async t => {
    const plugin = await makeBarePlugin();
    t.deepEqual(plugin.commands, {},
        'baza musi oddać worek — podklasa robi `{ ...super.commands, ... }` i na undefined straciłaby czytelny kontrakt');
});

test('isNewUser: installed_at === 0 NIE jest znacznikiem instalacji', async t => {
    const spy: HostSpy = { data: { installed_at: 0 }, zapisy: [] };
    const plugin = await makePlugin(spy);

    t.is(await plugin.isNewUser(), true, 'zerowy stempel to śmieć w data.json, a nie „user już był"');
    t.is(spy.zapisy.length, 1, 'pierwszy start musi ostemplować installed_at');
    t.true((spy.zapisy[0].installed_at ?? 0) > 0);
});

test('isNewPluginVersion: brak last_version → true (pierwsza instalacja widzi notatki wydania)', async t => {
    const plugin = await makePlugin({ data: { installed_at: 1_700_000_000_000 }, zapisy: [] });
    t.is(await plugin.isNewPluginVersion('2.2.0'), true);

    const pusty = await makePlugin({ data: { last_version: '   ' }, zapisy: [] });
    t.is(await pusty.isNewPluginVersion('2.2.0'), true, 'biały znak to brak wersji, nie wersja');
});

test('notifyReady podnosi flagę: konsument zapisany PO nim odpala natychmiast', async t => {
    const plugin = await makeBarePlugin();
    const kolejnosc: string[] = [];

    plugin.onReady(() => { kolejnosc.push('przed'); });
    t.deepEqual(kolejnosc, [], 'przed gotowością nic nie ma prawa odpalić');

    plugin.fireReady();
    t.deepEqual(kolejnosc, ['przed'], 'kolejka nie została opróżniona');

    plugin.onReady(() => { kolejnosc.push('po'); });
    t.deepEqual(kolejnosc, ['przed', 'po'],
        'po notifyReady konsument został zakolejkowany zamiast odpalić — czekałby na drugie notifyReady, które nigdy nie przyjdzie');

    await plugin.waitForReady();
    t.pass('waitForReady po gotowości musi się rozwiązać od razu');
});

test('showCrystalNotice: oddaje uchwyt centrum i ubiera kontener w skórę pluginu', async t => {
    const { host, hostClasses } = makeNoticeHost();
    const handle = { hide() {}, containerEl: host } as unknown as NoticeHandle;
    const { center, calls } = makeNoticeCenter(handle);
    const plugin = await makeBarePlugin({ env: { notices: center } });

    const wynik = plugin.showCrystalNotice('siema');

    t.is(wynik, handle, 'uchwyt centrum musi wrócić do wołającego — inaczej nie da się zamknąć powiadomienia');
    t.is(calls.length, 1);
    t.is(calls[0].message, 'siema');
    t.is(calls[0].options.timeout, NOTICE_DEFAULT_TIMEOUT_MS, 'bez `timeout` obowiązuje domyślny czas życia');
    t.deepEqual(hostClasses, ['cs-notice'], 'kontener nie dostał klasy skina — powiadomienie zostało w wyglądzie natywnym');
});

test('showCrystalNotice: wariant inny niż „info" maluje ciało, „info" zostaje gołe', async t => {
    const zly = makeNoticeHost();
    const handleZly = { hide() {}, containerEl: zly.host } as unknown as NoticeHandle;
    const bledny = await makeBarePlugin({ env: { notices: makeNoticeCenter(handleZly).center } });
    bledny.showCrystalNotice('padło', { type: 'error' });
    t.deepEqual(zly.bodyClasses, ['cs-notice__body--error'],
        'wariant „error" nie pomalował ciała — user nie odróżni błędu od zwykłej informacji');

    const info = makeNoticeHost();
    const handleInfo = { hide() {}, containerEl: info.host } as unknown as NoticeHandle;
    const zwykly = await makeBarePlugin({ env: { notices: makeNoticeCenter(handleInfo).center } });
    zwykly.showCrystalNotice('siema');
    t.deepEqual(info.bodyClasses, [], 'domyślny wariant „info" nie dokłada klasy wariantu');
});

test('showCrystalNotice: kolor agenta o kształcie koloru wchodzi, śmieć NIE wchodzi', async t => {
    const dobry = makeNoticeHost();
    const handleDobry = { hide() {}, containerEl: dobry.host } as unknown as NoticeHandle;
    const zKolorem = await makeBarePlugin({ env: { notices: makeNoticeCenter(handleDobry).center } });
    zKolorem.showCrystalNotice('agent', { type: 'agent', agentColor: '#0af' });
    t.deepEqual(dobry.props, [['--cs-notice-agent-color', '#0af']]);

    const smiec = makeNoticeHost();
    const handleSmiec = { hide() {}, containerEl: smiec.host } as unknown as NoticeHandle;
    const zeSmieciem = await makeBarePlugin({ env: { notices: makeNoticeCenter(handleSmiec).center } });
    zeSmieciem.showCrystalNotice('agent', { type: 'agent', agentColor: 'red; content: url(x)' });
    t.deepEqual(smiec.props, [],
        'wartość spoza kształtu koloru trafiła do arkusza stylów — bramka `accent && COLOR_SHAPE` przestała bramkować');
});

test.serial('applyUserColor: kolor z argumentu trafia do zmiennej CSS (hex z zerem też jest kolorem)', async t => {
    const spy = makeStyleSpy();
    const plugin = await makeBarePlugin();

    withFakeDocument({ style: spy.style }, () => { plugin.applyUserColor('  #0af  '); });

    t.deepEqual(spy.set, [['--cs-user-color', '#0af']], 'argument ma wygrywać z ustawieniami i być przycięty');
    t.deepEqual(spy.removed, []);
});

test.serial('applyUserColor: bez argumentu bierze kolor z ustawień', async t => {
    const spy = makeStyleSpy();
    const plugin = await makeBarePlugin({ env: { settings: { pkmAssistant: { userColor: '#102030' } } } });

    withFakeDocument({ style: spy.style }, () => { plugin.applyUserColor(); });

    t.deepEqual(spy.set, [['--cs-user-color', '#102030']]);
});

test.serial('applyUserColor: pusty kolor ZDEJMUJE zmienną, śmieć nie rusza arkusza', async t => {
    const pusty = makeStyleSpy();
    const bezKoloru = await makeBarePlugin();
    withFakeDocument({ style: pusty.style }, () => { bezKoloru.applyUserColor(); });
    t.deepEqual(pusty.removed, ['--cs-user-color'], 'brak koloru musi wrócić do domyślnego wyglądu, a nie zostawić stary');
    t.deepEqual(pusty.set, []);

    const smiec = makeStyleSpy();
    const zeSmieciem = await makeBarePlugin();
    withFakeDocument({ style: smiec.style }, () => { zeSmieciem.applyUserColor('nie ma takiego koloru'); });
    t.deepEqual(smiec.set, [], 'wartość spoza kształtu koloru trafiła do arkusza stylów');
    t.deepEqual(smiec.removed, [], 'odrzucony kolor nie ma prawa zdjąć obowiązującego');
});

test('addToGitignore: treść kończąca się nową linią nie dostaje pustej linii wiodącej', async t => {
    const zNowaLinia = makeGitignoreAdapter('node_modules\n');
    const a = await makeBarePlugin({ app: { vault: { adapter: zNowaLinia.adapter } } });
    await a.addToGitignore('.pkm-assistant/');
    t.deepEqual(zNowaLinia.appended, ['.pkm-assistant/\n'], 'doklejona pusta linia zaśmieca .gitignore usera');
    t.deepEqual(zNowaLinia.written, [], 'adapter ma `append` — `write` nadpisałby cały plik');

    const pusty = makeGitignoreAdapter('');
    const b = await makeBarePlugin({ app: { vault: { adapter: pusty.adapter } } });
    await b.addToGitignore('.pkm-assistant/');
    t.deepEqual(pusty.appended, ['.pkm-assistant/\n'], 'pusty plik nie potrzebuje linii wiodącej');
});

test('addToGitignore: adapter bez `append` dostaje SKLEJONĄ treść przez `write`', async t => {
    const bezAppend = makeGitignoreAdapter('node_modules', { withAppend: false });
    const plugin = await makeBarePlugin({ app: { vault: { adapter: bezAppend.adapter } } });

    await plugin.addToGitignore('.pkm-assistant/', 'PKM Assistant');

    t.deepEqual(bezAppend.written, ['node_modules\n\n# PKM Assistant\n.pkm-assistant/\n'],
        'ścieżka bez `append` musi dopisać do ISTNIEJĄCEJ treści, nie zgubić jej');
});

test('openChatView: bez otwartego czatu bierze PRAWY liść i ustawia go aktywnym', async t => {
    const pytaniaOTyp: string[] = [];
    const splity: boolean[] = [];
    const stany: Array<Record<string, unknown>> = [];
    const ujawnione: unknown[] = [];
    const przelaczenia: string[] = [];
    const workspace = {
        getLeavesOfType: (type: string) => { pytaniaOTyp.push(type); return []; },
        revealLeaf: (leaf: unknown) => { ujawnione.push(leaf); },
        getRightLeaf: (split: boolean) => {
            splity.push(split);
            return { setViewState: (state: Record<string, unknown>) => { stany.push(state); } };
        },
        rightSplit: { collapsed: true, toggle: () => { przelaczenia.push('toggle'); } },
    };
    const plugin = await makeBarePlugin({ app: { workspace } });

    plugin.openChatView();

    t.deepEqual(pytaniaOTyp, [CHAT_VIEW_TYPE]);
    t.deepEqual(splity, [false], 'czat ma wejść w ISTNIEJĄCY prawy panel, a nie rozbić go na nowy');
    t.deepEqual(stany, [{ type: CHAT_VIEW_TYPE, active: true }], 'czat otwarty w tle byłby dla usera „nic się nie stało"');
    t.deepEqual(ujawnione, [], 'nie było czego ujawniać');
    t.deepEqual(przelaczenia, ['toggle'], 'zwinięty prawy panel nie został rozwinięty');
});

test('openChatView: istniejący czat jest UJAWNIANY, a nie otwierany drugi raz', async t => {
    const lisc = { id: 'czat' };
    const ujawnione: unknown[] = [];
    let pytanoOPrawyLisc = false;
    const workspace = {
        getLeavesOfType: () => [lisc],
        revealLeaf: (leaf: unknown) => { ujawnione.push(leaf); },
        getRightLeaf: () => { pytanoOPrawyLisc = true; return null; },
        rightSplit: { collapsed: false, toggle: () => { t.fail('rozwinięty panel został zwinięty'); } },
    };
    const plugin = await makeBarePlugin({ app: { workspace } });

    plugin.openChatView();

    t.deepEqual(ujawnione, [lisc]);
    t.false(pytanoOPrawyLisc, 'user dostałby DRUGĄ zakładkę czatu obok już otwartej');
});

