/**
 * `PluginItemView` — zamyka lukę F-05 (klasy bazowe UI nie miały testów).
 *
 * ⚠️ OGRANICZENIE ŚRODOWISKA (do rozstrzygnięcia w F7): baza dziedziczy po `ItemView`
 * Obsidiana, a pakiet `obsidian` w `node_modules` to SAME TYPY. AVA nie ma dziś atrapy
 * `obsidian`, więc klasa jest importowana DYNAMICZNIE w środku każdego testu — brak atrapy
 * jest wtedy czerwienią jednego testu z czytelnym powodem, nie wywrotką całego pliku.
 */
import test from 'ava';

type ViewModule = typeof import('./PluginItemView.js');

async function loadBase(): Promise<ViewModule['PluginItemView']> {
    const mod = await import('./PluginItemView.js');
    return mod.PluginItemView;
}

interface WorkspaceSpy {
    leafOrNull: unknown;
    stany: unknown[];
    revealed: number;
}

function makeWorkspace(leafOrNull: unknown = null): WorkspaceSpy {
    const spy: WorkspaceSpy = { leafOrNull, stany: [], revealed: 0 };
    const leaf = leafOrNull === null ? null : {
        setViewState: (s: unknown) => { spy.stany.push(s); return Promise.resolve(); },
    };
    return Object.assign(spy, {
        getLeavesOfType: () => [],
        getRightLeaf: () => leaf,
        getLeaf: () => leaf,
        revealLeaf: () => { spy.revealed++; },
        rightSplit: { collapsed: false, toggle: () => {} },
    });
}

function makePlugin() {
    const zarejestrowane: string[] = [];
    const komendy: Array<{ id: string; name: string }> = [];
    return {
        plugin: {
            app: { workspace: makeWorkspace() },
            manifest: { id: 'pkm-assistant', version: '2.2.0' },
            registerView: (type: string) => { zarejestrowane.push(type); },
            addCommand: (cmd: { id: string; name: string }) => { komendy.push(cmd); },
            register: () => {},
            env: null,
        } as unknown as Parameters<ViewModule['PluginItemView']['register']>[0],
        zarejestrowane,
        komendy,
    };
}

// ── C10.1 ────────────────────────────────────────────────────────────────────
test('register() woła registerView typem viewType i dodaje komendę', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
    }
    const { plugin, zarejestrowane, komendy } = makePlugin();

    TestView.register(plugin);

    t.deepEqual(zarejestrowane, ['pkm-assistant-test']);
    t.is(komendy.length, 1, 'rejestracja widoku nie dołożyła komendy „otwórz"');
    t.true(komendy[0].id.includes('pkm-assistant-test'));
});

// ── C10.2 (BR-4) ─────────────────────────────────────────────────────────────
test('open() jest no-opem, gdy workspace nie dał liścia', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
    }
    const workspace = makeWorkspace(null);

    const wynik = TestView.open(workspace);

    t.true(wynik instanceof Promise, 'open() musi zwracać obietnicę — wołacze robią `return View.open(...)`');
    await t.notThrowsAsync(wynik);
    t.deepEqual(workspace.stany, []);
});

// ── C10.4 ────────────────────────────────────────────────────────────────────
test('open() przekazuje state do setViewState i honoruje active', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-release-notes'; }
        static get displayText() { return 'Notatki wydania'; }
        static get iconName() { return 'scroll'; }
    }
    const workspace = makeWorkspace({});

    await TestView.open(workspace, { version: '2.2.0' }, false);

    t.deepEqual(workspace.stany, [{
        type: 'pkm-assistant-release-notes',
        state: { version: '2.2.0' },
        active: false,
    }]);
});

// ── C10.3 ────────────────────────────────────────────────────────────────────
test('podklasa bez viewType → czytelny błąd, nie undefined w rejestrze', async t => {
    const Base = await loadBase();
    class BezStatyk extends Base {}
    const { plugin, zarejestrowane } = makePlugin();

    t.throws(() => BezStatyk.register(plugin), undefined,
        'rejestracja bez `viewType` przeszła — Obsidian dostałby widok o typie undefined');
    t.deepEqual(zarejestrowane, []);
});

// ── C10.5 (cross-check §1.2 — TS2515) ────────────────────────────────────────
test('renderView jest OPCJONALNA — podklasa bez niej się kompiluje i działa', async t => {
    const Base = await loadBase();
    // Gdyby `renderView` była `abstract`, TA klasa nie przeszłaby `tsc` (TS2515) i zatrzymała
    // bramkę commita stubów. Widok czatu dostaje tę metodę miksinem dopiero w runtime.
    class BezRenderView extends Base {
        static get viewType() { return 'pkm-assistant-bez-render'; }
        static get displayText() { return 'Bez renderView'; }
        static get iconName() { return 'bot'; }
    }

    t.is(typeof BezRenderView, 'function');
    t.is(BezRenderView.prototype.renderView, undefined, 'baza nie ma prawa dokładać własnej implementacji');
});

// ── C10.6 ────────────────────────────────────────────────────────────────────
test('container jest dostępny po onOpen', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
    }
    const { plugin } = makePlugin();
    const widok = new TestView({}, plugin as never);

    await (widok as unknown as { onOpen(): Promise<void> }).onOpen();

    t.truthy(widok.container, 'kontener treści nie powstał po onOpen — cztery pliki konsumentów na nim stoją');
});

// ═════════════════════════════════════════════════════════════════════════════
// F10 (bramka mutacyjna) — przypinki zachowań, które przeżywały mutacje.
// ═════════════════════════════════════════════════════════════════════════════

/** Atrapa runtime'u: liczy wywołania `whenLoaded()`. */
function makeRuntime() {
    const licznik = { whenLoadedCalls: 0 };
    const runtime = {
        whenLoaded: () => { licznik.whenLoadedCalls++; return Promise.resolve(); },
    };
    return { runtime, licznik };
}

/** Atrapa pluginu z kontrolą `_ready`/`onReady`/`env` (E-26). */
function makeLifecyclePlugin(opts: { ready?: boolean; env?: unknown } = {}) {
    const onReadyCallbacks: Array<() => void> = [];
    const plugin = {
        app: { workspace: makeWorkspace() },
        manifest: { id: 'pkm-assistant', version: '2.2.0' },
        registerView: () => {},
        addCommand: () => {},
        register: () => {},
        env: opts.env === undefined ? null : opts.env,
        _ready: opts.ready === true,
        onReady: (cb: () => void) => { onReadyCallbacks.push(cb); },
    } as unknown as Parameters<ViewModule['PluginItemView']['register']>[0];
    return { plugin, onReadyCallbacks };
}

/** Dzieci kontenera widoku — atrapa DOM harnessu trzyma je w zwykłej tablicy. */
function dzieciKontenera(widok: { container: unknown }): Array<{ className: string; textContent: string }> {
    return (widok.container as { children: Array<{ className: string; textContent: string }> }).children;
}

// ── F10.1 (commandName) ──────────────────────────────────────────────────────
test('commandName to tytuł zakładki i trafia do addCommand', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Notatki wydania'; }
        static get iconName() { return 'scroll'; }
    }
    const { plugin, komendy } = makePlugin();

    t.is(TestView.commandName, 'Notatki wydania',
        'komenda „otwórz" bez etykiety — user zobaczyłby pustą pozycję w palecie');

    TestView.register(plugin);

    t.is(komendy[0].name, 'Notatki wydania');
});

// ── F10.2 (pusta statyka = brak tożsamości) ──────────────────────────────────
test('pusty string w statyce tożsamości jest traktowany jak jej brak', async t => {
    const Base = await loadBase();
    class PustyTyp extends Base {
        static get viewType() { return ''; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
    }
    const { plugin, zarejestrowane } = makePlugin();

    t.throws(() => PustyTyp.register(plugin), undefined,
        'pusty `viewType` przeszedł — Obsidian dostałby widok o typie ""');
    t.deepEqual(zarejestrowane, []);

    class PustaIkona extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return ''; }
    }
    const widok = new PustaIkona({}, plugin as never);
    t.throws(() => widok.getIcon(), undefined, 'pusta `iconName` przeszła — zakładka bez ikony');
});

// ── F10.3 (domyślne `active`) ────────────────────────────────────────────────
test('open() bez trzeciego argumentu aktywuje otwartą kartę', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
    }
    const workspace = makeWorkspace({});

    await TestView.open(workspace);

    t.deepEqual(workspace.stany, [{ type: 'pkm-assistant-test', state: {}, active: true }],
        'domyślne otwarcie ma dawać kartę na wierzchu — user właśnie kliknął komendę');
    t.is(workspace.revealed, 1, 'otwarta karta nie została odsłonięta');
});

// ── F10.4 (tożsamość instancji) ──────────────────────────────────────────────
test('getViewType/getDisplayText/getIcon oddają statyki podklasy', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-release-notes'; }
        static get displayText() { return 'Notatki wydania'; }
        static get iconName() { return 'scroll'; }
    }
    const { plugin } = makeLifecyclePlugin();
    const widok = new TestView({}, plugin as never);

    t.is(widok.getViewType(), 'pkm-assistant-release-notes');
    t.is(widok.getDisplayText(), 'Notatki wydania');
    t.is(widok.getIcon(), 'scroll');
});

// ── F10.5 (akcesor env) ──────────────────────────────────────────────────────
test('env oddaje runtime pluginu, a przed jego powstaniem null (nie undefined)', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
    }

    const bezRuntime = makeLifecyclePlugin();
    const widokBez = new TestView({}, bezRuntime.plugin as never);
    t.is(widokBez.env, null, 'akcesor musi dawać null — konsumenci robią `if (!view.env)`');

    const { runtime } = makeRuntime();
    const zRuntime = makeLifecyclePlugin({ env: runtime });
    const widokZ = new TestView({}, zRuntime.plugin as never);
    t.is(widokZ.env as unknown, runtime, 'akcesor zgubił runtime pluginu');
});

// ── F10.6 (E-26: plugin gotowy) ──────────────────────────────────────────────
test('onOpen z gotowym pluginem renderuje od razu, bez placeholdera', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
        rendery = 0;
        renderView(): void { this.rendery++; }
    }
    const { plugin, onReadyCallbacks } = makeLifecyclePlugin({ ready: true });
    const widok = new TestView({}, plugin as never);

    await widok.onOpen();

    t.is(widok.rendery, 1, 'plugin był gotowy, a widok nie narysował treści');
    t.is(onReadyCallbacks.length, 0, 'gotowy plugin nie ma po co dostawać callbacku onReady');
    t.is(dzieciKontenera(widok).length, 0, 'gotowy plugin dostał placeholder „ładowanie" zamiast treści');
});

// ── F10.7 (E-26: plugin jeszcze niegotowy) ───────────────────────────────────
test('onOpen przed gotowością stawia placeholder i dorenderowuje na onReady', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
        rendery = 0;
        renderView(): void { this.rendery++; }
    }
    const { plugin, onReadyCallbacks } = makeLifecyclePlugin({ ready: false });
    const widok = new TestView({}, plugin as never);

    await widok.onOpen();

    t.is(widok.rendery, 0, 'onOpen nie ma prawa renderować przed gotowością pluginu (deadlock E-26)');
    t.is(onReadyCallbacks.length, 1, 'widok nie zapisał się na powiadomienie o gotowości');
    const dzieci = dzieciKontenera(widok);
    t.is(dzieci.length, 1);
    t.is(dzieci[0].className, 'pkm-view-loading');
    t.true(dzieci[0].textContent.length > 0, 'placeholder bez tekstu — user widzi puste okno');

    onReadyCallbacks[0]();

    t.is(widok.rendery, 1, 'po gotowości pluginu widok nie dorenderował treści');
    t.is(dzieciKontenera(widok).length, 0, 'placeholder został pod dorysowaną treścią');
});

// ── F10.8 (widok bez renderView) ─────────────────────────────────────────────
test('onOpen widoku bez renderView nie rusza kontenera ani onReady', async t => {
    const Base = await loadBase();
    class BezRenderView extends Base {
        static get viewType() { return 'pkm-assistant-bez-render'; }
        static get displayText() { return 'Bez renderView'; }
        static get iconName() { return 'bot'; }
    }
    const { plugin, onReadyCallbacks } = makeLifecyclePlugin({ ready: false });
    const widok = new BezRenderView({}, plugin as never);

    await t.notThrowsAsync(widok.onOpen());

    t.is(dzieciKontenera(widok).length, 0, 'widok bez renderView dostał placeholder, którego nikt nie zdejmie');
    t.is(onReadyCallbacks.length, 0, 'widok bez renderView zapisał się na gotowość bez powodu');
});

// ── F10.9 (whenRuntimeLoaded) ────────────────────────────────────────────────
test('whenRuntimeLoaded czeka na runtime, a bez niego wraca bez rzutu', async t => {
    const Base = await loadBase();
    class TestView extends Base {
        static get viewType() { return 'pkm-assistant-test'; }
        static get displayText() { return 'Test'; }
        static get iconName() { return 'bot'; }
    }

    const { runtime, licznik } = makeRuntime();
    const zRuntime = makeLifecyclePlugin({ env: runtime });
    const widokZ = new TestView({}, zRuntime.plugin as never);

    await widokZ.whenRuntimeLoaded();

    t.is(licznik.whenLoadedCalls, 1, 'widok nie doczekał wczytania runtime\'u — czytałby pusty vault');

    const bezRuntime = makeLifecyclePlugin();
    const widokBez = new TestView({}, bezRuntime.plugin as never);

    await t.notThrowsAsync(widokBez.whenRuntimeLoaded());
    t.is(licznik.whenLoadedCalls, 1, 'brak runtime\'u, a widok i tak na coś czekał');
});
