/**
 * `PluginRuntime` — pierwszy w historii tego kodu BEHAWIORALNY test bootu.
 *
 * Wszystko stoi na atrapie {@link PluginHost} + `SettingsIo` w pamięci: zero Obsidiana,
 * zero dysku. Do clean-room cała ścieżka startu miała wyłącznie testy REGEXOWE PO ŹRÓDLE
 * (luki F-03/F-04/F-10), bo środowisko importowało `obsidian` i nie wstawało w AVA.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

import { PluginRuntime } from './PluginRuntime.js';
import { SETTINGS_LAST_GOOD_PATH, SETTINGS_PATH, SETTINGS_PRE_MIGRATION_PATH } from './contracts.js';
import type {
    AppLike,
    LoggerLike,
    PluginHost,
    PluginVersionData,
    RuntimeConfig,
    SettingsBag,
} from './contracts.js';

// ── atrapy ───────────────────────────────────────────────────────────────────

interface IoSpy {
    reads: string[];
    writes: Array<{ path: string; data: string }>;
}

function makeIo(files: Record<string, string> = {}, spy?: IoSpy) {
    return {
        async read(p: string): Promise<string> {
            spy?.reads.push(p);
            if (!(p in files)) throw new Error(`ENOENT ${p}`);
            return files[p];
        },
        async write(p: string, data: string): Promise<void> {
            spy?.writes.push({ path: p, data });
            files[p] = data;
        },
        async exists(): Promise<boolean> { throw new Error('exists() KŁAMIE — pancerz nie ma prawa go wołać'); },
        async mkdir(): Promise<void> {},
        async list(): Promise<{ files: string[]; folders: string[] }> { return { files: [], folders: [] }; },
        async remove(): Promise<void> {},
    };
}

interface HostOptions {
    files?: Record<string, string>;
    spy?: IoSpy;
    /** Gotowy adapter zamiast domyślnego (testy kopii sprzed migracji podstawiają własny). */
    adapter?: unknown;
    /** Podglądacz kolejności bootu — `addStatusBarItem()` dopisuje tu swój znacznik. */
    slad?: string[];
    /** `null` = brak workspace'u (goły Node). Funkcja = ręcznie zwalniany layout. */
    onLayoutReady?: ((cb: () => void) => void) | null;
    data?: PluginVersionData | null;
    /** Instancja wtyczki Sync Obsidiana (`app.internalPlugins.plugins.sync.instance`). */
    sync?: unknown;
}

function makeHost(opts: HostOptions = {}): PluginHost {
    const workspace: Record<string, unknown> = {};
    if (opts.onLayoutReady !== null) {
        workspace.onLayoutReady = opts.onLayoutReady ?? ((cb: () => void) => { cb(); });
    }
    const app = {
        vault: { adapter: opts.adapter ?? makeIo(opts.files, opts.spy), configDir: '.obsidian' },
        workspace,
        ...(opts.sync === undefined
            ? {}
            : { internalPlugins: { plugins: { sync: { instance: opts.sync } } } }),
    } as unknown as AppLike;

    return {
        app,
        manifest: { id: 'pkm-assistant', version: '2.2.0' },
        loadData: async () => opts.data ?? null,
        saveData: async () => {},
        addStatusBarItem: () => {
            opts.slad?.push('pasek');
            return { empty() {}, createSpan() {} } as unknown as HTMLElement;
        },
        registerInterval: (id: number) => id,
        registerEvent: () => {},
    };
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
    const http = { send: async () => { throw new Error('brak sieci w teście'); } };
    return {
        chat: { providers: {}, http, transport: { open: async () => { throw new Error('brak sieci'); } } },
        embedding: { providers: {}, http },
        defaults: { pkmAssistant: { chat: { platform: '', apiKeys: {}, models: {}, hosts: {} } } } as SettingsBag,
        ...overrides,
    } as RuntimeConfig;
}

// ── C1.1 ─────────────────────────────────────────────────────────────────────
test('konstruktor jest synchroniczny i tani — zero I/O, state "loading"', t => {
    const spy: IoSpy = { reads: [], writes: [] };
    let loadDataCalls = 0;
    const host = makeHost({ spy });
    const wrapped: PluginHost = { ...host, loadData: async () => { loadDataCalls++; return null; } };

    const runtime = new PluginRuntime(wrapped, makeConfig());

    t.is(runtime.state, 'loading');
    t.deepEqual(spy.reads, [], 'konstruktor czytał dysk');
    t.is(loadDataCalls, 0, 'konstruktor wołał loadData()');
});

// ── C1.2 ─────────────────────────────────────────────────────────────────────
test('boot nie robi NIC, dopóki layout nie stoi', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    let release: (() => void) | null = null;
    const host = makeHost({ spy, onLayoutReady: (cb) => { release = cb; } });
    const runtime = new PluginRuntime(host, makeConfig());

    const booting = runtime.boot();
    await new Promise(r => setTimeout(r, 20));

    t.deepEqual(spy.reads, [], 'boot ruszył przed layoutReady');
    t.not(runtime.state, 'loaded');

    release!();
    await booting;
    t.is(runtime.state, 'loaded');
});

// ── C1.3 ─────────────────────────────────────────────────────────────────────
test('brak workspace (goły Node) → boot dochodzi do "loaded"', async t => {
    const runtime = new PluginRuntime(makeHost({ onLayoutReady: null }), makeConfig());
    await runtime.boot();
    t.is(runtime.state, 'loaded');
});

// ── C1.4 ─────────────────────────────────────────────────────────────────────
test('state = "loaded" PRZED emisją zdarzenia "loaded"', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    let stateWidzianyPrzezSluchacza: string | null = null as string | null;
    runtime.events.on('loaded', () => { stateWidzianyPrzezSluchacza = String(runtime.state); });

    await runtime.boot();

    t.is(stateWidzianyPrzezSluchacza, 'loaded', 'słuchacz zobaczył stan sprzed przypisania — klasyczny wyścig E-13');
});

// ── C1.5 ─────────────────────────────────────────────────────────────────────
test('dispose emituje "unloading" i przechodzi w "disposed"', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    await runtime.boot();

    const zdarzenia: string[] = [];
    runtime.events.on('unloading', () => { zdarzenia.push('unloading'); });

    await runtime.dispose();

    t.deepEqual(zdarzenia, ['unloading']);
    t.is(runtime.state, 'disposed');
    t.is(runtime.settingsStore.pendingSaveTimer, null, 'zaplanowany zapis przeżył demontaż');
});

// ── C1.7 ─────────────────────────────────────────────────────────────────────
test('whenLoaded: gotowy runtime → resolve bez timera', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    await runtime.boot();

    const start = Date.now();
    const wynik = await runtime.whenLoaded();

    t.is(wynik, runtime);
    t.true(Date.now() - start < 60, 'ścieżka „już gotowe" kosztowała tick siatki zamiast 0 ms (W-11)');
});

// ── C1.8 ─────────────────────────────────────────────────────────────────────
test('whenLoaded: rozwiązuje się na zdarzenie, nie na tick', async t => {
    let release: (() => void) | null = null;
    const runtime = new PluginRuntime(makeHost({ onLayoutReady: (cb) => { release = cb; } }), makeConfig());
    const czekanie = runtime.whenLoaded();
    void runtime.boot();

    await new Promise(r => setTimeout(r, 20));
    const emittedAt = Date.now();
    release!();

    await czekanie;
    t.true(Date.now() - emittedAt < 50, 'rozwiązanie przyszło z siatki, nie ze zdarzenia');
});

// ── C1.9 (reguła bezpieczeństwa W-08) ────────────────────────────────────────
test('whenLoaded po dispose NIGDY się nie rozwiązuje', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    await runtime.boot();

    let przedRozwiazane = false;
    let poRozwiazane = false;
    void runtime.whenLoaded().then(() => { przedRozwiazane = true; });

    await runtime.dispose();
    void runtime.whenLoaded().then(() => { poRozwiazane = true; });
    await runtime.reload();
    await new Promise(r => setTimeout(r, 60));

    t.false(przedRozwiazane || poRozwiazane === false && przedRozwiazane,
        'obietnica wzięta przed dispose rozwiązała się po demontażu — zombie-inicjalizacja');
    t.false(poRozwiazane, 'obietnica wzięta PO dispose rozwiązała się — runtime jest „disposed" na stałe');
});

// ── C1.10 (luka F-08) ────────────────────────────────────────────────────────
test('reload nie emituje "unloading" — czekający doczekują się', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    await runtime.boot();

    const zdarzenia: string[] = [];
    runtime.events.on('unloading', () => { zdarzenia.push('unloading'); });

    const czekanie = runtime.whenLoaded();
    await runtime.reload();

    t.deepEqual(zdarzenia, [], 'reload wyemitował „unloading" — porzuciłby wszystkich czekających');
    t.is(await czekanie, runtime);
});

// ── C1.11 (luka F-08) ────────────────────────────────────────────────────────
test('reload w trakcie "loading" nie startuje drugiego przebiegu', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    let release: (() => void) | null = null;
    const runtime = new PluginRuntime(makeHost({ spy, onLayoutReady: (cb) => { release = cb; } }), makeConfig());

    const pierwszy = runtime.boot();
    const drugi = runtime.reload();
    release!();
    await Promise.all([pierwszy, drugi]);

    const odczytyUstawien = spy.reads.filter(p => p === SETTINGS_PATH).length;
    t.is(odczytyUstawien, 1, 'reload w trakcie ładowania odpalił DRUGI przebieg bootu');
    t.is(runtime.state, 'loaded');
});

// ── C1.12 (flagowa reguła S-07/S-08) ─────────────────────────────────────────
test('boot NIE ZAPISUJE settings.json i nie planuje zapisu', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    const zdrowy = JSON.stringify({ pkmAssistant: { language: 'pl' } });
    const runtime = new PluginRuntime(makeHost({ spy, files: { [SETTINGS_PATH]: zdrowy } }), makeConfig());

    await runtime.boot();

    t.false(spy.writes.some(w => w.path === SETTINGS_PATH),
        'BOOT ZAPISAŁ settings.json — plik z kluczami API byłby przepisywany przy każdym starcie');
    t.is(runtime.settingsStore.pendingSaveTimer, null, 'boot zaplanował zapis (debounce jest dłuższy niż test)');
});

// ── C1.13 ────────────────────────────────────────────────────────────────────
test('boot nie rzuca, gdy adapter pada na wszystkim', async t => {
    const ostrzezenia: string[] = [];
    const host = makeHost();
    (host.app.vault as unknown as Record<string, unknown>).adapter = {
        read: async () => { throw new Error('dysk padł'); },
        write: async () => { throw new Error('dysk padł'); },
        mkdir: async () => { throw new Error('dysk padł'); },
        list: async () => { throw new Error('dysk padł'); },
        exists: async () => { throw new Error('dysk padł'); },
    };
    const config = makeConfig({
        log: {
            debug: () => {}, info: () => {},
            warn: (_s: string, ...a: unknown[]) => { ostrzezenia.push(String(a[0] ?? '')); },
            error: () => {},
        },
    });

    const runtime = new PluginRuntime(host, config);
    await t.notThrowsAsync(runtime.boot());

    t.is(runtime.state, 'loaded', 'awaria dysku ma degradować do defaultów, nie zatrzymywać startu');
    t.deepEqual(runtime.settings, config.defaults);
    t.true(ostrzezenia.length >= 1, 'degradacja przeszła po cichu — user nie ma jak się dowiedzieć');
});

// ── C1.14 (luka F-10) ────────────────────────────────────────────────────────
test('dispose jest idempotentne, boot po dispose to no-op', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    await runtime.boot();

    let unloadingCount = 0;
    runtime.events.on('unloading', () => { unloadingCount++; });

    await runtime.dispose();
    await runtime.dispose();
    await runtime.boot();

    t.is(unloadingCount, 1, 'drugi dispose wyemitował drugie „unloading"');
    t.is(runtime.state, 'disposed', 'boot po dispose wskrzesił runtime');
});

// ── C1.16 ────────────────────────────────────────────────────────────────────
test('config jest TĄ SAMĄ referencją co podany konstruktorowi', async t => {
    const config = makeConfig();
    const runtime = new PluginRuntime(makeHost(), config);

    t.is(runtime.config, config);

    config.chat.providers.deepseek = { info: { id: 'deepseek-podmieniony' } };
    await runtime.boot();

    t.is(runtime.config.chat.providers.deepseek.info.id, 'deepseek-podmieniony',
        'podmiana providera PRZED bootem nie doszła — harness nie ma jak podstawić atrapy');
});

// ── C1.17 (Y-1) ──────────────────────────────────────────────────────────────
test('chatModel to mutowalny slot — zerowanie z zewnątrz działa', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    await runtime.boot();

    const model = { modelKey: 'deepseek:deepseek-chat', stream: async () => null, stopStream: () => {} };
    runtime.chatModel = model as unknown as typeof runtime.chatModel;
    t.is(runtime.chatModel, model);

    t.notThrows(() => { runtime.chatModel = null; });
    t.is(runtime.chatModel, null, 'runtime odtworzył model po wyzerowaniu — Stop trafiałby w martwą instancję');
});

// ── C1.18 (strażnik po źródle, E-12) ─────────────────────────────────────────
test('zero okien czasowych na ścieżce startu', t => {
    const zrodlo = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'PluginRuntime.ts'),
        'utf8',
    );
    const bezKomentarzy = zrodlo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const zegary = [...bezKomentarzy.matchAll(/setTimeout\s*\(\s*[^,]*,\s*(\d+)/g)].map(m => m[1]);

    t.deepEqual(zegary, [], `ślepy zegar na ścieżce startu wrócił (${zegary.join(', ')} ms) — dwa takie kosztowały 8,09 s bootu`);
});

// ── C1.19 (poprawka po weryfikacji, SB-01) ───────────────────────────────────
test('pasek statusu staje PO layoucie, ale PRZED czytaniem ustawień', async t => {
    const slad: string[] = [];
    const files: Record<string, string> = { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) };
    const adapter = {
        async read(p: string): Promise<string> {
            slad.push(`odczyt:${p}`);
            if (!(p in files)) throw new Error(`ENOENT ${p}`);
            return files[p];
        },
        async write(p: string, data: string): Promise<void> { slad.push(`zapis:${p}`); files[p] = data; },
        async mkdir(): Promise<void> {},
        async list(): Promise<{ files: string[]; folders: string[] }> { return { files: [], folders: [] }; },
        async remove(): Promise<void> {},
    };

    let release: (() => void) | null = null;
    const host = makeHost({ adapter, slad, onLayoutReady: (cb) => { release = cb; } });
    const runtime = new PluginRuntime(host, makeConfig());

    const booting = runtime.boot();
    await new Promise(r => setTimeout(r, 20));
    t.deepEqual(slad, [], 'pasek wyprzedził zdarzenie layoutu — SB-01 mówi „po layoucie"');

    release!();
    await booting;

    t.is(slad[0], 'pasek', `pasek stanął dopiero po I/O ustawień: ${slad.join(' → ')}`);
    t.true(slad.some(k => k.startsWith('odczyt:')), 'test nie dotknął I/O ustawień — nie ma czego porównywać');
    t.truthy(runtime.statusBar, 'boot skończył bez paska');
});

// ── C1.20 (poprawka po weryfikacji) ──────────────────────────────────────────
test('pasek statusu stoi nawet wtedy, gdy ustawienia się nie wczytały', async t => {
    const slad: string[] = [];
    const adapter = {
        async read(): Promise<string> { throw new Error('dysk padł'); },
        async write(): Promise<void> { throw new Error('dysk padł'); },
        async mkdir(): Promise<void> { throw new Error('dysk padł'); },
        async list(): Promise<{ files: string[]; folders: string[] }> { throw new Error('dysk padł'); },
        async remove(): Promise<void> { throw new Error('dysk padł'); },
    };
    const runtime = new PluginRuntime(makeHost({ adapter, slad }), makeConfig());

    await runtime.boot();

    t.is(runtime.state, 'loaded');
    t.truthy(runtime.statusBar, 'degradacja do defaultów zabrała userowi pasek statusu');
});

// ── C1.21 (poprawka po weryfikacji) ──────────────────────────────────────────
test('kopia sprzed migracji: pad pierwszej próby NIE pali jednorazowej szansy', async t => {
    const stary = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'settings_v2.1.json'),
        'utf8',
    );
    const files: Record<string, string> = { [SETTINGS_PATH]: stary };
    const zapisy: Array<{ path: string; data: string }> = [];
    let kopiaPada = true;

    const adapter = {
        async read(p: string): Promise<string> {
            if (!(p in files)) throw new Error(`ENOENT ${p}`);
            return files[p];
        },
        async write(p: string, data: string): Promise<void> {
            if (p === SETTINGS_PRE_MIGRATION_PATH && kopiaPada) throw new Error('dysk zajęty');
            zapisy.push({ path: p, data });
            files[p] = data;
        },
        async mkdir(): Promise<void> {},
        async list(): Promise<{ files: string[]; folders: string[] }> { return { files: [], folders: [] }; },
        async remove(): Promise<void> {},
    };

    const runtime = new PluginRuntime(makeHost({ adapter }), makeConfig());
    await runtime.boot();

    const nowy = { pkmAssistant: { language: 'pl' } } as SettingsBag;
    await runtime.saveSettings(nowy);
    t.false(zapisy.some(w => w.path === SETTINGS_PRE_MIGRATION_PATH), 'kopia jednak przeszła — test nie bada pada');
    t.true(zapisy.some(w => w.path === SETTINGS_PATH), 'pad kopii zablokował zapis ustawień usera');

    kopiaPada = false;
    await runtime.saveSettings(nowy);

    const kopie = zapisy.filter(w => w.path === SETTINGS_PRE_MIGRATION_PATH);
    t.is(kopie.length, 1, 'nieudana kopia sprzed migracji przepadła na zawsze');
    t.is(kopie[0].data, stary, 'kopia „sprzed migracji" utrwaliła worek PO migracji');

    await runtime.saveSettings(nowy);
    t.is(zapisy.filter(w => w.path === SETTINGS_PRE_MIGRATION_PATH).length, 1,
        'po udanej kopii jednorazowość przestała obowiązywać');
});

// ═════════════════════════════════════════════════════════════════════════════
// F10 — dopisane pod bramkę mutacyjną. Każdy test pinuje zachowanie, którego
// zmiana przechodziła dotąd przez zestaw bez jednej czerwonej asercji.
// ═════════════════════════════════════════════════════════════════════════════

const KATALOG_TESTU = path.dirname(fileURLToPath(import.meta.url));

interface LogSpy {
    ostrzezenia: string[];
    bledy: string[];
    log: LoggerLike;
}

function makeLog(): LogSpy {
    const ostrzezenia: string[] = [];
    const bledy: string[] = [];
    return {
        ostrzezenia,
        bledy,
        log: {
            debug: () => {},
            info: () => {},
            warn: (_scope, ...a) => { ostrzezenia.push(a.map(String).join(' ')); },
            error: (_scope, ...a) => { bledy.push(a.map(String).join(' ')); },
        },
    };
}

type Zegar = typeof globalThis.setTimeout;

/**
 * Podmienia globalny `setTimeout` na atrapę: zapisuje ŻĄDANE opóźnienia i odpala
 * wywołanie zwrotne od razu (mikrozadanie). Dzięki temu test widzi ILE razy i NA ILE
 * runtime chciał usnąć, nie płacąc za to sekundami. Testy tego używające są `serial`,
 * bo zegar jest globalny.
 */
async function zPodmienionymZegarem(fn: () => Promise<unknown>): Promise<number[]> {
    const opoznienia: number[] = [];
    const oryginalny: Zegar = globalThis.setTimeout;
    globalThis.setTimeout = ((cb: () => void, ms?: number) => {
        opoznienia.push(Number(ms));
        queueMicrotask(cb);
        return 0 as unknown as ReturnType<Zegar>;
    }) as unknown as Zegar;
    try {
        await fn();
    } finally {
        globalThis.setTimeout = oryginalny;
    }
    return opoznienia;
}

// ── F10.1 ────────────────────────────────────────────────────────────────────
test('F10: pusty rejestr embeddingu — providers() to TABLICA, select() rzuca', t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());

    const lista = runtime.embeddings.providers();
    t.true(Array.isArray(lista),
        'providers() oddało coś, po czym nie da się iterować — ekran ustawień pada, zanim wjedzie prawdziwy rejestr');
    t.deepEqual(lista, []);
    t.is(runtime.embeddings.default, null);
    t.false(runtime.embeddings.isConfigured());
    t.throws(() => runtime.embeddings.select('openai'), { message: /openai/ },
        'brak podłączonego rejestru ma być głośny, nie cichy');
});

// ── F10.2 ────────────────────────────────────────────────────────────────────
test('F10: saveSettings bez bootu nie robi kopii sprzed migracji', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    const files: Record<string, string> = { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) };
    const runtime = new PluginRuntime(makeHost({ spy, files }), makeConfig());

    await runtime.saveSettings({ pkmAssistant: { language: 'en' } } as SettingsBag);

    t.false(spy.writes.some(w => w.path === SETTINGS_PRE_MIGRATION_PATH),
        'świeży runtime uznał, że zaszła migracja — jednorazowa kopia poszłaby na worek, którego nikt nie migrował');
    t.true(spy.writes.some(w => w.path === SETTINGS_PATH), 'zapis ustawień w ogóle nie doszedł');
});

// ── F10.3 ────────────────────────────────────────────────────────────────────
test('F10: reload po skończonym boocie czyta ustawienia OD NOWA', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    const files: Record<string, string> = { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) };
    const runtime = new PluginRuntime(makeHost({ spy, files }), makeConfig());

    await runtime.boot();
    t.is(spy.reads.filter(p => p === SETTINGS_PATH).length, 1, 'boot nie przeczytał ustawień — nie ma czego porównywać');

    files[SETTINGS_PATH] = JSON.stringify({ pkmAssistant: { language: 'en' } });
    await runtime.reload();

    t.is(spy.reads.filter(p => p === SETTINGS_PATH).length, 2,
        'reload oddał starą obietnicę zamiast puścić nowy przebieg — luka F-08 wraca');
    t.is(runtime.settings.pkmAssistant?.language, 'en', 'reload przestawił stan, ale worek został stary');
    t.is(runtime.state, 'loaded');

    await runtime.dispose();
    const poDemontazu = spy.reads.length;
    await runtime.reload();

    t.is(spy.reads.length, poDemontazu, 'reload po dispose ruszył z I/O — wskrzeszenie zdemontowanego runtimeu');
    t.is(runtime.state, 'disposed');
});

// ── F10.4 ────────────────────────────────────────────────────────────────────
test('F10: dispose bez zaplanowanego zapisu nie dotyka settings.json', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    const files: Record<string, string> = { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) };
    const runtime = new PluginRuntime(makeHost({ spy, files }), makeConfig());

    await runtime.boot();
    t.is(runtime.settingsStore.pendingSaveTimer, null,
        'boot zaplanował zapis — ten test bada przypadek BEZ oczekującej zmiany');

    await runtime.dispose();

    t.false(spy.writes.some(w => w.path === SETTINGS_PATH),
        'demontaż BEZ oczekującej zmiany przepisał plik z kluczami API');
});

// ── F10.5 ────────────────────────────────────────────────────────────────────
test('F10: dispose z zaplanowanym zapisem dopisuje zmianę usera', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    const files: Record<string, string> = { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) };
    const runtime = new PluginRuntime(makeHost({ spy, files }), makeConfig());

    await runtime.boot();
    const galaz = runtime.settings.pkmAssistant as unknown as Record<string, unknown>;
    galaz['language'] = 'en';
    t.not(runtime.settingsStore.pendingSaveTimer, null,
        'mutacja przez proxy nie zaplanowała zapisu — test nie ma czego bronić');

    await runtime.dispose();

    const zapis = spy.writes.filter(w => w.path === SETTINGS_PATH).at(-1);
    t.truthy(zapis, 'demontaż zgubił zmianę usera czekającą w debounce');
    t.true(String(zapis?.data).includes('"language": "en"'), 'na dysk poszedł worek sprzed zmiany');
    t.is(runtime.settingsStore.pendingSaveTimer, null, 'zaplanowany zapis przeżył demontaż');
});

// ── F10.6 ────────────────────────────────────────────────────────────────────
test('F10: kopia sprzed migracji leci, gdy zaszła CHOĆ JEDNA migracja', async t => {
    // (a) same stare klucze — przestrzeń nazw jest już nowa
    const stareKlucze = fs.readFileSync(path.join(KATALOG_TESTU, '__fixtures__', 'settings_v2.2_s35.json'), 'utf8');
    const spyA: IoSpy = { reads: [], writes: [] };
    const runtimeA = new PluginRuntime(makeHost({ spy: spyA, files: { [SETTINGS_PATH]: stareKlucze } }), makeConfig());
    await runtimeA.boot();
    await runtimeA.saveSettings({ pkmAssistant: {} } as SettingsBag);

    const kopieA = spyA.writes.filter(w => w.path === SETTINGS_PRE_MIGRATION_PATH);
    t.is(kopieA.length, 1, 'sama migracja starych kluczy nie wywołała kopii — user traci jedyną siatkę na klucze API');
    t.is(kopieA[0].data, stareKlucze, 'kopia „sprzed migracji" utrwaliła worek PO migracji');

    // (b) samo przemianowanie przestrzeni nazw — starych kluczy nie ma
    const staraPrzestrzen = JSON.stringify({ obsek: { language: 'pl' } });
    const spyB: IoSpy = { reads: [], writes: [] };
    const runtimeB = new PluginRuntime(makeHost({ spy: spyB, files: { [SETTINGS_PATH]: staraPrzestrzen } }), makeConfig());
    await runtimeB.boot();
    await runtimeB.saveSettings({ pkmAssistant: {} } as SettingsBag);

    const kopieB = spyB.writes.filter(w => w.path === SETTINGS_PRE_MIGRATION_PATH);
    t.is(kopieB.length, 1, 'samo przemianowanie przestrzeni nazw nie wywołało kopii');
    t.is(kopieB[0].data, staraPrzestrzen);
});

// ── F10.7 ────────────────────────────────────────────────────────────────────
test('F10: źródło inne niż plik główny idzie do ostrzeżenia', async t => {
    const zdrowe = JSON.stringify({ pkmAssistant: { language: 'pl' } });

    const zKopii = makeLog();
    const uszkodzony = new PluginRuntime(
        makeHost({ files: { [SETTINGS_PATH]: '{urwane', [SETTINGS_LAST_GOOD_PATH]: zdrowe } }),
        makeConfig({ log: zKopii.log }),
    );
    await uszkodzony.boot();
    t.true(zKopii.ostrzezenia.some(m => m.includes('źródła') && m.includes('last-good')),
        'wczytanie z kopii przeszło bez śladu — nie ma jak zdiagnozować utraty pliku głównego');

    const zGlownego = makeLog();
    const zdrowy = new PluginRuntime(
        makeHost({ files: { [SETTINGS_PATH]: zdrowe } }),
        makeConfig({ log: zGlownego.log }),
    );
    await zdrowy.boot();
    t.false(zGlownego.ostrzezenia.some(m => m.includes('źródła')),
        'zdrowy start straszy ostrzeżeniem o źródle ustawień');
});

// ── F10.8 ────────────────────────────────────────────────────────────────────
test('F10: saveSettings odrzuca wszystko, co nie jest workiem', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    const runtime = new PluginRuntime(makeHost({ spy }), makeConfig());

    await t.throwsAsync(() => runtime.saveSettings(null as unknown as SettingsBag), { instanceOf: TypeError },
        'null przeszedł walidację — na dysk poszłoby „null" zamiast worka z kluczami API');
    await t.throwsAsync(() => runtime.saveSettings(undefined as unknown as SettingsBag), { instanceOf: TypeError });
    await t.throwsAsync(() => runtime.saveSettings('{}' as unknown as SettingsBag), { instanceOf: TypeError },
        'tekst przeszedł walidację — S-18 pilnuje WORKA, nie samej obecności argumentu');

    t.deepEqual(spy.writes, [], 'odrzucony zapis i tak dotknął dysku');
});

// ── F10.9 ────────────────────────────────────────────────────────────────────
test('F10: dispose w locie zatrzymuje boot — runtime nie wskrzesza się na "loaded"', async t => {
    const spy: IoSpy = { reads: [], writes: [] };
    let release: (() => void) | null = null;
    const runtime = new PluginRuntime(
        makeHost({
            spy,
            files: { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) },
            onLayoutReady: (cb) => { release = cb; },
        }),
        makeConfig(),
    );

    const booting = runtime.boot();
    await runtime.dispose();
    release!();
    await booting;

    t.is(runtime.state, 'disposed', 'boot dokończył się po demontażu — zombie-inicjalizacja na cudzym runtime');
    t.deepEqual(spy.reads, [], 'boot po dispose i tak poszedł czytać ustawienia');
});

// ── F10.10 ───────────────────────────────────────────────────────────────────
test.serial('F10: synchronizacja vaulta — pełny limit odpytań co 100 ms, potem start mimo sync-u', async t => {
    let odczyty = 0;
    const sync = { get syncStatus(): string { odczyty++; return 'Syncing changes'; } };
    const spyLog = makeLog();
    const runtime = new PluginRuntime(
        makeHost({ sync, files: { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) } }),
        makeConfig({ log: spyLog.log }),
    );

    const opoznienia = await zPodmienionymZegarem(() => runtime.boot());

    t.is(opoznienia.length, 30, 'sufit odpytywania synchronizacji się przesunął');
    t.deepEqual([...new Set(opoznienia)], [100], 'odstęp między odpytaniami synchronizacji się zmienił');
    t.is(odczyty, 30, 'liczba sprawdzeń statusu rozjechała się z liczbą przespanych okien');
    t.is(runtime.state, 'loaded', 'trwający sync zablokował start na zawsze');
    t.true(spyLog.ostrzezenia.some(m => m.includes('Synchronizacja')), 'przekroczony limit sync-u przeszedł po cichu');
});

// ── F10.11 ───────────────────────────────────────────────────────────────────
test.serial('F10: synchronizacja vaulta — pętla kończy się, gdy sync odpuści', async t => {
    const statusy = ['Syncing changes', 'syncing', 'Fully synced'];
    let i = 0;
    const sync = { get syncStatus(): string { return statusy[Math.min(i++, statusy.length - 1)]; } };
    const runtime = new PluginRuntime(
        makeHost({ sync, files: { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) } }),
        makeConfig(),
    );

    const opoznienia = await zPodmienionymZegarem(() => runtime.boot());

    t.is(opoznienia.length, 2, 'runtime spał inaczej niż „dokładnie tyle, ile trwał sync"');
    t.is(runtime.settings.pkmAssistant?.language, 'pl', 'po synchronizacji ustawienia nie doczytały się z pliku');
});

// ── F10.12 ───────────────────────────────────────────────────────────────────
test.serial('F10: "Fully synced" to NIE jest trwająca synchronizacja — zero czekania', async t => {
    const runtime = new PluginRuntime(
        makeHost({
            sync: { syncStatus: 'Fully synced' },
            files: { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) },
        }),
        makeConfig(),
    );

    const opoznienia = await zPodmienionymZegarem(() => runtime.boot());

    t.deepEqual(opoznienia, [], 'zakończony sync zatrzymał start na odpytywaniu — trzy sekundy za nic');
    t.is(runtime.state, 'loaded');
});

// ── F10.13 ───────────────────────────────────────────────────────────────────
test.serial('F10: sync bez tekstowego statusu nie wywraca startu', async t => {
    const runtime = new PluginRuntime(
        makeHost({
            sync: { syncStatus: 42 },
            files: { [SETTINGS_PATH]: JSON.stringify({ pkmAssistant: { language: 'pl' } }) },
        }),
        makeConfig(),
    );

    const opoznienia = await zPodmienionymZegarem(() => runtime.boot());

    t.deepEqual(opoznienia, [], 'nietekstowy status wpuścił runtime w odpytywanie');
    t.is(runtime.settings.pkmAssistant?.language, 'pl',
        'nietekstowy status sync-u wywalił start i zdegradował ustawienia do fabrycznych');
});

// ── F10.14 ───────────────────────────────────────────────────────────────────
test('F10: kopia sprzed migracji jest jednorazowa — skasowanie pliku jej nie wskrzesza', async t => {
    const stary = fs.readFileSync(path.join(KATALOG_TESTU, '__fixtures__', 'settings_v2.1.json'), 'utf8');
    const files: Record<string, string> = { [SETTINGS_PATH]: stary };
    const spy: IoSpy = { reads: [], writes: [] };
    const runtime = new PluginRuntime(makeHost({ spy, files }), makeConfig());
    await runtime.boot();

    const nowy = { pkmAssistant: { language: 'pl' } } as SettingsBag;
    await runtime.saveSettings(nowy);
    t.is(spy.writes.filter(w => w.path === SETTINGS_PRE_MIGRATION_PATH).length, 1, 'pierwsza kopia nie powstała');

    delete files[SETTINGS_PRE_MIGRATION_PATH];
    await runtime.saveSettings(nowy);

    t.is(spy.writes.filter(w => w.path === SETTINGS_PRE_MIGRATION_PATH).length, 1,
        'po udanej kopii flaga nie zgasła — drugi zapis utrwalił pod nazwą „sprzed migracji" worek PO migracji');
});

// ── F10.15 ───────────────────────────────────────────────────────────────────
test('F10: powiadomienie poza Obsidianem zwraca żywy uchwyt, nie null', async t => {
    const runtime = new PluginRuntime(makeHost(), makeConfig());
    await runtime.boot();

    const uchwyt = runtime.notices.show('cześć');

    t.truthy(uchwyt, 'poza Obsidianem powiadomienie padło — wołacz dostał null i nie ma czego zamykać');
    t.notThrows(() => uchwyt?.hide(), 'zamknięcie powiadomienia-atrapy rzuciło');
});
