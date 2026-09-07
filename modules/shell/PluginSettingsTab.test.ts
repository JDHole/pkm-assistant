/**
 * `PluginSettingsTab` — zamyka lukę F-05.
 *
 * V-06: DWA stany ekranu („ładuję" vs „gotowe"). Trzeci stan i guzik „uruchom" zeszły razem
 * z gałęzią mobile-defer, więc nie ma tu ani funkcji `resolveSettingsGate`, ani jej testu —
 * cała decyzja mieści się w `render()`.
 *
 * ⚠️ OGRANICZENIE ŚRODOWISKA (do rozstrzygnięcia w F7): baza dziedziczy po `PluginSettingTab`
 * Obsidiana, a pakiet `obsidian` w `node_modules` to SAME TYPY. AVA nie ma dziś atrapy
 * `obsidian`, więc klasa jest importowana DYNAMICZNIE w środku każdego testu.
 */
import test from 'ava';

type TabModule = typeof import('./PluginSettingsTab.js');

async function loadBase(): Promise<TabModule['PluginSettingsTab']> {
    const mod = await import('./PluginSettingsTab.js');
    return mod.PluginSettingsTab;
}

/** Najmniejszy węzeł, jaki wystarcza zakładce: dzieci, tekst i dwie fabryki Obsidiana. */
interface FakeEl {
    tag: string;
    cls: string;
    text: string;
    children: FakeEl[];
    empty(): void;
    createEl(tag: string, opts?: { text?: string; cls?: string }): FakeEl;
    createDiv(opts?: { cls?: string }): FakeEl;
}

function fakeEl(tag = 'div', cls = ''): FakeEl {
    const el: FakeEl = {
        tag, cls, text: '', children: [],
        empty() { el.children.length = 0; el.text = ''; },
        createEl(t2, opts) {
            const child = fakeEl(t2, opts?.cls ?? '');
            child.text = opts?.text ?? '';
            el.children.push(child);
            return child;
        },
        createDiv(opts) { return el.createEl('div', opts); },
    };
    return el;
}

const wszystkieTeksty = (el: FakeEl): string[] =>
    [el.text, ...el.children.flatMap(wszystkieTeksty)].filter(Boolean);

interface FakeRuntime {
    state: string;
    whenLoaded(): Promise<unknown>;
    settingsStore: { save(): Promise<void> };
    settings: Record<string, unknown>;
}

function makeRuntime(state: string, release?: { fn?: () => void }): FakeRuntime {
    const zapisy: Promise<void>[] = [];
    return {
        state,
        whenLoaded: () => (release
            ? new Promise<void>(res => { release.fn = res; })
            : Promise.resolve()),
        settingsStore: { save: async () => { zapisy.push(Promise.resolve()); } },
        settings: { pkmAssistant: {} },
    };
}

async function makeTab(runtime: FakeRuntime | null) {
    const Base = await loadBase();
    const sekcje: string[] = [];
    class TestTab extends Base {
        async render(): Promise<void> {
            this.containerEl.empty();
            if (this.env?.state !== 'loaded') {
                this.containerEl.createEl('p', { text: 'settings.loading' });
                await this.env?.whenLoaded();
            }
            this.prepareLayout();
            this.mainContainer.createDiv({ cls: 'sekcja' });
            sekcje.push('sekcja');
        }
    }
    const tab = Object.create(TestTab.prototype) as InstanceType<typeof TestTab>;
    Object.assign(tab, { containerEl: fakeEl(), plugin: { env: runtime } });
    Object.defineProperty(tab, 'env', { get: () => runtime, configurable: true });
    return { tab, sekcje };
}

// ── C9.1 ─────────────────────────────────────────────────────────────────────
test('runtime w "loading" → akapit settings.loading, render czeka', async t => {
    const release: { fn?: () => void } = {};
    const { tab, sekcje } = await makeTab(makeRuntime('loading', release));

    const rendering = tab.render();
    await new Promise(r => setTimeout(r, 10));

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.true(wszystkieTeksty(el).includes('settings.loading'), 'user nie widzi, że zakładka czeka na runtime');
    t.deepEqual(sekcje, [], 'sekcje wyrenderowały się przed gotowością runtime\'u');

    release.fn!();
    await rendering;
    t.deepEqual(sekcje, ['sekcja']);
});

// ── C9.2 ─────────────────────────────────────────────────────────────────────
test('po whenLoaded() zakładka renderuje sekcje', async t => {
    const release: { fn?: () => void } = {};
    const { tab, sekcje } = await makeTab(makeRuntime('loading', release));

    const rendering = tab.render();
    await new Promise(r => setTimeout(r, 5));
    release.fn!();
    await rendering;

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.false(wszystkieTeksty(el).includes('settings.loading'), 'akapit „ładuję" został na ekranie po renderze');
    t.deepEqual(sekcje, ['sekcja']);
});

// ── C9.3 ─────────────────────────────────────────────────────────────────────
test('runtime w "loaded" → render bez czekania', async t => {
    const { tab, sekcje } = await makeTab(makeRuntime('loaded'));

    await tab.render();

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.false(wszystkieTeksty(el).includes('settings.loading'));
    t.deepEqual(sekcje, ['sekcja']);
});

// ── C9.4 ─────────────────────────────────────────────────────────────────────
test('brak runtime\'u (null) nie wywala zakładki', async t => {
    const { tab } = await makeTab(null);

    await t.notThrowsAsync(tab.render());

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.true(wszystkieTeksty(el).includes('settings.loading'));
});

// ── C9.5 (V-07) ──────────────────────────────────────────────────────────────
test('saveSettings() zakładki idzie przez settingsStore.save()', async t => {
    const zapisy: string[] = [];
    const runtime = makeRuntime('loaded');
    runtime.settingsStore.save = async () => { zapisy.push('save'); };
    const { tab } = await makeTab(runtime);

    await tab.saveSettings();

    t.deepEqual(zapisy, ['save'], 'zakładka zapisuje inną drogą niż magazyn ustawień');
});

// ── C9.6-C9.8 (dopisane przez autora bazy) ───────────────────────────────────
// C9.1-C9.4 sprawdzają bramę stanu napisaną w PODKLASIE testowej, więc same w sobie nie
// pilnują, czy ma ją BAZA (A13: „dwa kontenery + DWA stany ekranu"). Te trzy testy biorą
// podklasę, która NIE zna pojęcia „ładuję" — cała brama musi przyjść z klasy bazowej.

async function makePlainTab(runtime: FakeRuntime | null) {
    const Base = await loadBase();
    const sekcje: string[] = [];
    /** Podklasa „naga": rysuje sekcje i nic nie wie o stanie runtime'u. */
    class PlainTab extends Base {
        async render(): Promise<void> {
            this.prepareLayout();
            this.mainContainer.createDiv({ cls: 'sekcja' });
            sekcje.push('sekcja');
        }
    }
    const tab = Object.create(PlainTab.prototype) as InstanceType<typeof PlainTab>;
    Object.assign(tab, { containerEl: fakeEl(), plugin: { env: runtime } });
    return { tab, sekcje };
}

test('BAZA: runtime w "loading" → akapit ładowania i czekanie przed treścią', async t => {
    const { t: tr } = await import('../../core/i18n/index.js');
    const release: { fn?: () => void } = {};
    const { tab, sekcje } = await makePlainTab(makeRuntime('loading', release));

    const screen = tab.showScreen();
    await new Promise(r => setTimeout(r, 10));

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.true(wszystkieTeksty(el).includes(tr('settings.loading')), 'baza nie pokazuje akapitu „ładuję"');
    t.deepEqual(sekcje, [], 'baza puściła treść przed gotowością runtime\'u');

    release.fn!();
    await screen;
    t.deepEqual(sekcje, ['sekcja']);
});

test('BAZA: runtime w "loaded" → treść bez akapitu ładowania', async t => {
    const { t: tr } = await import('../../core/i18n/index.js');
    const { tab, sekcje } = await makePlainTab(makeRuntime('loaded'));

    await tab.showScreen();

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.false(wszystkieTeksty(el).includes(tr('settings.loading')));
    t.deepEqual(sekcje, ['sekcja']);
});

test('BAZA: display() — wejście Obsidiana — odpala pełny przebieg ekranu', async t => {
    const { tab, sekcje } = await makePlainTab(makeRuntime('loaded'));

    tab.display();
    await new Promise(r => setTimeout(r, 10));

    t.deepEqual(sekcje, ['sekcja'], 'display() nie doprowadził do renderu — Obsidian woła TYLKO display()');
});

test('BAZA: display() nie rzuca, gdy render podklasy pada', async t => {
    const Base = await loadBase();
    class BrokenTab extends Base {
        async render(): Promise<void> { throw new Error('bum'); }
    }
    const tab = Object.create(BrokenTab.prototype) as InstanceType<typeof BrokenTab>;
    Object.assign(tab, { containerEl: fakeEl(), plugin: { env: makeRuntime('loaded') } });

    t.notThrows(() => tab.display());
    await new Promise(r => setTimeout(r, 10));
    t.pass();
});

// ── F10 (mutacje) ────────────────────────────────────────────────────────────
// Getter `env`, szkielet dwóch kontenerów i pusty magazyn ustawień — trzy zachowania,
// których poprzednie testy dotykały tylko mimochodem, przez podklasę.

/** Zakładka bez podklasowej bramy stanu — do sprawdzania samego gettera i szkieletu. */
async function makeBareTab(plugin: unknown) {
    const Base = await loadBase();
    class BareTab extends Base {
        async render(): Promise<void> { /* treść nieistotna dla tych testów */ }
    }
    const tab = Object.create(BareTab.prototype) as InstanceType<typeof BareTab>;
    Object.assign(tab, { containerEl: fakeEl(), plugin });
    return tab;
}

test('BAZA: env oddaje ten sam obiekt runtime\'u, co wisi na pluginie', async t => {
    const runtime = makeRuntime('loaded');
    const tab = await makeBareTab({ env: runtime });

    t.is(tab.env as unknown, runtime, 'zakładka pracuje na innym runtimie niż plugin');
});

test('BAZA: bez runtime\'u env oddaje null, nigdy undefined', async t => {
    const bezPola = await makeBareTab({});
    const zNullem = await makeBareTab({ env: null });
    const bezPluginu = await makeBareTab(undefined);

    t.is(bezPola.env, null, 'brak pola env przecieka jako undefined zamiast null');
    t.is(zNullem.env, null);
    t.is(bezPluginu.env, null, 'brak pluginu wywala się albo przecieka jako undefined');
});

test('BAZA: prepareLayout() stawia dwa kontenery — nagłówek i główną część', async t => {
    const tab = await makeBareTab({ env: makeRuntime('loaded') });

    tab.prepareLayout();

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.deepEqual(el.children.map(c => c.cls), ['pkm-settings-header', 'pkm-settings-main']);
    t.is(tab.headerContainer as unknown as FakeEl, el.children[0], 'headerContainer wskazuje nie ten kontener');
    t.is(tab.mainContainer as unknown as FakeEl, el.children[1], 'mainContainer wskazuje nie ten kontener');
});

test('BAZA: prepareLayout() czyści ekran przy runtimie, a bez runtime\'u zostawia „ładuję"', async t => {
    const zRuntimem = await makeBareTab({ env: makeRuntime('loaded') });
    const elZ = (zRuntimem as unknown as { containerEl: FakeEl }).containerEl;
    elZ.createEl('p', { text: 'stara treść' });

    zRuntimem.prepareLayout();
    t.false(wszystkieTeksty(elZ).includes('stara treść'), 'stara treść została pod nowym szkieletem');

    const bezRuntimu = await makeBareTab({ env: null });
    const elBez = (bezRuntimu as unknown as { containerEl: FakeEl }).containerEl;
    elBez.createEl('p', { text: 'settings.loading' });

    bezRuntimu.prepareLayout();
    t.true(wszystkieTeksty(elBez).includes('settings.loading'), 'wytarliśmy komunikat „ładuję" i zakładka zaniemówiła');
    t.is(elBez.children.length, 3, 'szkielet nie powstał mimo braku runtime\'u');
});

test('BAZA: saveSettings() bez magazynu ustawień nie rzuca i nic nie zapisuje', async t => {
    const runtime = makeRuntime('loaded') as unknown as { settingsStore: unknown };
    runtime.settingsStore = undefined;
    const tab = await makeBareTab({ env: runtime });

    await t.notThrowsAsync(tab.saveSettings());

    const bezRuntimu = await makeBareTab({ env: null });
    await t.notThrowsAsync(bezRuntimu.saveSettings(), 'zapis bez runtime\'u wywala zakładkę');
});

test('BAZA: showScreen() przy braku runtime\'u pokazuje „ładuję" i mimo to renderuje', async t => {
    const { t: tr } = await import('../../core/i18n/index.js');
    const Base = await loadBase();
    const slady: string[] = [];
    class BareTab extends Base {
        async render(): Promise<void> { slady.push('render'); }
    }
    const tab = Object.create(BareTab.prototype) as InstanceType<typeof BareTab>;
    Object.assign(tab, { containerEl: fakeEl(), plugin: { env: null } });

    await tab.showScreen();

    const el = (tab as unknown as { containerEl: FakeEl }).containerEl;
    t.true(wszystkieTeksty(el).includes(tr('settings.loading')));
    t.deepEqual(slady, ['render'], 'brak runtime\'u zawiesił zakładkę zamiast puścić render');
});
