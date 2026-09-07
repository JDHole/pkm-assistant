/**
 * obsidian.ts — atrapa modułu `obsidian` (jedyna w projekcie).
 *
 * DWAJ KONSUMENCI, jedna atrapa:
 *   1. `npm test` (AVA) — preload `register-obsidian-for-ava.mjs` obok podmienia tu bare-specyfier
 *      `obsidian` hakiem ESM Node'a, więc każdy test pliku produkcyjnego dotykającego Obsidiana wstaje.
 *   2. Harness „Szklane Pudło" (OSOBNE repo, https://github.com/JDHole/pkm-assistant-harness) — jego
 *      `esbuild.harness.ts` aliasuje `obsidian` na TEN plik. Atrapa została w repo pluginu, bo bez
 *      niej nie wstaje `npm test`; harness sięga po nią przez alias `@plugin/test-support/…`.
 *
 * Pakiet `obsidian` z npm to tylko typy — poza Obsidianem nie ma runtime'u. Ten plik
 * dostarcza minimalny, DZIAŁAJĄCY runtime tych symboli, których dotyka bootstrap
 * `PKMAssistantPlugin.onload() + initialize()`.
 *
 * ZASADY:
 *   - `TFile`/`TFolder` to PRAWDZIWE klasy — `modules/tools/ToolLoader.js` robi
 *     `instanceof TFolder/TFile`. Vault-atrapa harnessu zwraca ICH instancje.
 *   - `Plugin.loadData/saveData` czytają/piszą realny JSON z
 *     `<vault>/.obsidian/plugins/<manifest.id>/data.json` przez adapter.
 *   - `registerInterval(id)` TRACKUJE timery — `shutdownHarnessRuntime()` czyści je,
 *     żeby proces Node mógł się zamknąć (inaczej wisi np. na interwałach `chat_session`).
 *   - Reszta (Modal/ItemView/Setting/Component/…) to puste klasy/no-opy — muszą się
 *     dać zaimportować i skonstruować, nie muszą działać.
 *
 * Wszystko, czego tu NIE MA, a jest importowane z 'obsidian' w kodzie, wywali build
 * (esbuild rozwiązuje named-importy statycznie) → to jest nasz „test pokrycia symboli".
 *
 * TYPY: atrapa udaje otwarte API hosta, ale NIE jedzie na `any` (do 2026-09-07 jechała) —
 * ten plik idzie razem z pluginem do walidatora katalogu, a `any` zapala mu ~115 błędów
 * `no-unsafe-*`. Kształty niżej są nazwane i minimalne; to SAME adnotacje, zero zmian
 * zachowania. Typy klas UI nie muszą pasować do prawdziwego Obsidiana: kod pluginu
 * typuje się przeciw pakietowi `obsidian` z npm, a ten plik podmieniany jest dopiero
 * w RUNTIME (hak AVA / alias esbuilda).
 */

import { createMockEl } from './dom-shim.js';
import * as YAML from 'yaml';

/** Element-atrapa z `dom-shim.ts` (jego typ jest lokalny — tu wystarczy nam kształt użycia). */
type El = ReturnType<typeof createMockEl>;

/** Uchwyt timera Node'a — to on wraca z `setInterval` i to jego czyścimy przy zamykaniu. */
type TimerId = ReturnType<typeof setInterval>;

/** Adapter vaulta w zakresie, którego dotyka `Plugin.loadData/saveData`. */
interface AdapterLike {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
}

/** `App` w zakresie, którego dotyka ta atrapa (reszta jej nie obchodzi). */
interface AppLike {
    vault?: { adapter?: AdapterLike };
}

/** Wyciąga `message` z byle czego, co przyszło z `catch` — bez `any`. */
function powod(e: unknown): unknown {
    return (e as { message?: unknown } | null)?.message ?? e;
}

// ── Timery pod kontrolą harnessa (żeby proces się zamknął) ──
const _trackedIntervals = new Set<TimerId>();

/** Czyści wszystkie timery zarejestrowane przez Plugin.registerInterval. Wołane z run.js. */
export function shutdownHarnessRuntime() {
    let n = 0;
    for (const id of _trackedIntervals) {
        try { clearInterval(id); n++; } catch { /* best-effort */ }
    }
    _trackedIntervals.clear();
    return n;
}

// ── Platform: bramkuje start środowiska (isMobile ⇒ defer) ──
export const Platform = {
    isMobile: false,
    isMobileApp: false,
    isDesktop: true,
    isDesktopApp: true,
    isPhone: false,
    isTablet: false,
    isMacOS: false,
    isWin: true,
    isLinux: false,
    isIosApp: false,
    isAndroidApp: false,
    isSafari: false,
};

// ── normalizePath: prosta normalizacja slashy ──
export function normalizePath(path: unknown): string {
    if (typeof path !== 'string') return '';
    let p = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    p = p.replace(/^\.\//, '');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p === '' ? '/' : p;
}

// ── setIcon / addIcon: no-op ──
// ── parseYaml / stringifyYaml: silnik `yaml` (devDependency) udaje wbudowany parser Obsidiana ──
//
// `src/main.ts` (composition root, prawdziwy kod pluginu bundlowany przez harness) woła
// `setYamlEngine({ parse: parseYaml, stringify: stringifyYaml })` z modułu `obsidian` — w
// harnessie ten specyfier rozwiązuje się aliasem esbuilda WŁAŚNIE na ten plik. Opcje dumpu
// odzwierciedlają dawne js-yaml (`noRefs: true, lineWidth: 120`): zero zawijania długich linii
// (`lineWidth: 0`) i zero kotwic `&`/`*` na współdzielonych referencjach (`aliasDuplicateObjects:
// false`) — kotwice w yamlu agenta/artefaktu byłyby nieczytelne dla usera edytującego plik ręcznie.
export function parseYaml(yamlText: unknown): unknown {
  return YAML.parse(String(yamlText));
}
export function stringifyYaml(obj: unknown): string {
  return YAML.stringify(obj, { lineWidth: 0, aliasDuplicateObjects: false, indent: 2 });
}
export function setIcon() {}
export function addIcon() {}

// ── Notice: no-op, przyjmuje string LUB DocumentFragment ──
//
// Kształt DOM lustrzany do prawdziwego Obsidiana (zweryfikowane w 1.12.7): `containerEl`
// to element ZEWNĘTRZNY (klasa `notice`), `messageEl` jego dziecko (klasa `notice-message`);
// deprecated `noticeEl` wskazuje na TO SAMO co `messageEl` — nie osobny, trzeci element
// (`this.messageEl = this.noticeEl = …` w realnym kodzie). `src/main.ts` (`showCrystalNotice`)
// stylizuje `containerEl` (ogony-ogA, fala 3, 2026-09-04).
export class Notice {
    message: unknown;
    timeout: number | undefined;
    containerEl: El;
    messageEl: El;
    noticeEl: El;

    constructor(message: unknown, timeout?: number) {
        this.message = message;
        this.timeout = timeout;
        this.containerEl = createMockEl('div');
        this.messageEl = this.containerEl.createDiv();
        this.noticeEl = this.messageEl;
    }
    setMessage(message: unknown) { this.message = message; return this; }
    hide() {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Router `requestUrl` (Poligon F1)
//
// PO CO: `requestUrl` to drugi (obok streamingu) kanał wyjścia pluginu na świat —
// jedzie nim wyszukiwarka webowa (`modules/web/WebSearchProvider`), generowanie obrazów
// i STT (`modules/multimodal`) oraz onboarding. Domyślnie harness blokuje wszystko, na co
// scenariusz nie zarejestrował trasy (599) — do 2026-09-04 był tu jeszcze wyjątek: stub
// GitHuba dla updatera (`check_for_update`), zdjęty tego dnia razem z updaterem przed
// katalogiem (D1). Bez zarejestrowanej trasy scenariusz nie ma jak sprawdzić TYCH ścieżek.
//
// Trasy rejestruje scenariusz PRZED biegiem; handler zwraca GOTOWY obiekt odpowiedzi —
// ŻADEN realny HTTP się nie dzieje (inaczej niż przy fake-serwerach modeli, które muszą
// stać na loopbacku, bo idą przez prawdziwy transport strumienia).
//
// Sprzątanie: runner scenariuszy woła `clearHarnessRequestUrlRoutes()` przed każdym
// scenariuszem i w `finally` po nim — trasa jednego scenariusza nie może przeciec do
// następnego.
// ─────────────────────────────────────────────────────────────────────────────

/** Żądanie w kształcie, w jakim widzi je handler trasy (znormalizowane z `RequestUrlParam`). */
export interface HarnessRequestUrlRequest {
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, unknown>;
}

/**
 * Odpowiedź zwracana przez handler. Wszystkie pola opcjonalne — router dopełnia resztę
 * (patrz `_normalizeRouteResponse`). Kod produkcyjny czyta z odpowiedzi `requestUrl`:
 * `.text` (WebSearchProvider), `.json` (multimodal, http_request),
 * `.arrayBuffer` (pobieranie obrazka w ImageGenAdapter), `.status` i `.headers`.
 */
export interface HarnessRequestUrlResponse {
    status?: number;
    text?: string;
    json?: unknown;
    arrayBuffer?: ArrayBuffer;
    headers?: Record<string, string>;
}

/** Kompletna odpowiedź oddawana wołaczowi — wszystkie pola, które umie czytać kod pluginu. */
interface RequestUrlResult {
    status: number;
    headers: Record<string, string>;
    text: string;
    arrayBuffer: ArrayBuffer;
    json: unknown;
}

/** Argument `requestUrl`: sam adres albo obiekt żądania (tak jak w prawdziwym API). */
type RequestUrlArg = string | {
    url?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, unknown>;
} | null | undefined;

/** Dopasowanie trasy: fragment URL-a (substring, np. host), regexp albo własny predykat. */
export type HarnessRequestUrlMatcher = string | RegExp | ((url: string) => boolean);

export interface HarnessRequestUrlRoute {
    match: HarnessRequestUrlMatcher;
    handler: (req: HarnessRequestUrlRequest) => HarnessRequestUrlResponse | Promise<HarnessRequestUrlResponse>;
}

let _requestUrlRoutes: HarnessRequestUrlRoute[] = [];

/** Rejestruje trasy routera (nadpisuje poprzednie). Kolejność = kolejność sprawdzania. */
export function setHarnessRequestUrlRoutes(routes: HarnessRequestUrlRoute[] | null | undefined): void {
    _requestUrlRoutes = Array.isArray(routes) ? routes.slice() : [];
}

/** Kasuje wszystkie trasy — po tym `requestUrl` wraca do domyślnej blokady (599). */
export function clearHarnessRequestUrlRoutes(): void {
    _requestUrlRoutes = [];
}

function _matchesRoute(match: HarnessRequestUrlMatcher, url: string): boolean {
    if (typeof match === 'function') {
        try { return !!match(url); } catch { return false; }
    }
    if (match instanceof RegExp) return match.test(url);
    return typeof match === 'string' && match.length > 0 && url.includes(match);
}

/**
 * Dopełnia odpowiedź handlera do pełnego kształtu `requestUrl`: `text` z `json` (i odwrotnie),
 * `status` 200, puste `headers`/`arrayBuffer`. Dzięki temu scenariusz podaje tylko to, co go
 * interesuje, a kod produkcyjny i tak dostaje wszystkie pola, które umie czytać.
 */
function _normalizeRouteResponse(out: HarnessRequestUrlResponse | null | undefined): RequestUrlResult {
    const res = out || {};
    let text = typeof res.text === 'string' ? res.text : undefined;
    let json = Object.prototype.hasOwnProperty.call(res, 'json') ? res.json : undefined;
    if (text === undefined && json !== undefined) {
        try { text = JSON.stringify(json); } catch { text = ''; }
    }
    if (json === undefined && typeof text === 'string') {
        try { json = JSON.parse(text); } catch { json = null; }
    }
    return {
        status: typeof res.status === 'number' ? res.status : 200,
        headers: res.headers || {},
        text: text ?? '',
        arrayBuffer: res.arrayBuffer || new ArrayBuffer(0),
        json: json ?? null,
    };
}

// ── requestUrl: ŻADNEGO realnego requestu — trasy scenariusza → 599 ──
// Updater (check_for_update, api.github.com co 3h) wycięty 2026-09-04 przed katalogiem (D1) —
// nic w bootstrapie już nie strzela do sieci samo z siebie. Streaming/model idzie osobnym
// torem (transport strumienia + fake-serwery na loopbacku).
export async function requestUrl(request: RequestUrlArg): Promise<RequestUrlResult> {
    const isStr = typeof request === 'string';
    const url = isStr ? request : (request?.url || '');
    if (_requestUrlRoutes.length > 0) {
        const req: HarnessRequestUrlRequest = {
            url,
            method: String((isStr ? null : request?.method) || 'GET').toUpperCase(),
            body: isStr ? undefined : request?.body,
            headers: (isStr ? {} : request?.headers) || {},
        };
        for (const route of _requestUrlRoutes) {
            if (!route || !_matchesRoute(route.match, url)) continue;
            return _normalizeRouteResponse(await route.handler(req));
        }
    }
    // Cokolwiek innego = brak sieci. Nic w bootstrapie tego nie woła synchronously.
    console.warn(`[harness] requestUrl blocked (brak trasy w routerze, no network): ${url}`);
    return { status: 599, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: null };
}

// ── Vault-prymitywy: PRAWDZIWE klasy (instanceof w ToolLoader) ──
export class TAbstractFile {
    path: string;
    name: string;
    parent: TFolder | null;
    vault: unknown;

    constructor() {
        this.path = '';
        this.name = '';
        this.parent = null;
        this.vault = null;
    }
}

export class TFile extends TAbstractFile {
    basename: string;
    extension: string;
    stat: { ctime: number; mtime: number; size: number };

    constructor() {
        super();
        this.basename = '';
        this.extension = '';
        this.stat = { ctime: 0, mtime: 0, size: 0 };
    }
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[];

    constructor() {
        super();
        this.children = [];
    }
    isRoot() { return this.path === '/' || this.path === ''; }
}

// ── Puste klasy UI (muszą się dać zaimportować i skonstruować, nie działać) ──
export class Component {
    load() {} onload() {} unload() {} onunload() {}
    addChild<T>(c: T): T { return c; } removeChild<T>(c: T): T { return c; }
    register() {} registerEvent() {} registerDomEvent() {} registerInterval(id: TimerId) { return id; }
}

export class Modal {
    app: unknown;
    scope: { register(): void; unregister(): void };
    containerEl: El;
    modalEl: El;
    contentEl: El;
    titleEl: El;

    constructor(app: unknown) {
        this.app = app;
        this.scope = { register() {}, unregister() {} };
        this.containerEl = createMockEl('div');
        this.modalEl = createMockEl('div');
        this.contentEl = createMockEl('div');
        this.titleEl = createMockEl('div');
    }
    open() {} close() {} onOpen() {} onClose() {}
    setTitle() { return this; } setContent() { return this; }
}

export class ItemView extends Component {
    leaf: unknown;
    app: unknown;
    containerEl: El;
    contentEl: El;
    icon: string;

    constructor(leaf: { app?: unknown } | null | undefined) {
        super();
        this.leaf = leaf;
        this.app = leaf?.app;
        this.containerEl = createMockEl('div');
        this.contentEl = createMockEl('div');
        this.icon = '';
    }
    getViewType() { return ''; }
    getDisplayText() { return ''; }
    getIcon() { return this.icon; }
    onOpen() { return Promise.resolve(); }
    onClose() { return Promise.resolve(); }
    addAction() { return createMockEl('div'); }
}

export class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: El;

    constructor(app: unknown, plugin: unknown) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = createMockEl('div');
    }
    display() {} hide() {}
}

/** Kontrolka w `Setting` — wszystkie metody łańcuchowalne, żadna nic nie pamięta. */
interface MockControl {
    setValue(): MockControl;
    getValue(): unknown;
    setPlaceholder(): MockControl;
    setDisabled(): MockControl;
    onChange(): MockControl;
    onClick(): MockControl;
    setButtonText(): MockControl;
    setCta(): MockControl;
    setWarning(): MockControl;
    setIcon(): MockControl;
    setTooltip(): MockControl;
    addOption(): MockControl;
    addOptions(): MockControl;
    selectEl: El;
    inputEl: El;
    buttonEl: El;
    toggleEl: El;
}

export class Setting {
    containerEl: El;
    settingEl: El;
    infoEl: El;
    nameEl: El;
    descEl: El;
    controlEl: El;
    components: MockControl[];

    constructor(containerEl: El) {
        this.containerEl = containerEl;
        this.settingEl = createMockEl('div');
        this.infoEl = createMockEl('div');
        this.nameEl = createMockEl('div');
        this.descEl = createMockEl('div');
        this.controlEl = createMockEl('div');
        this.components = [];
    }
    setName() { return this; }
    setDesc() { return this; }
    setClass() { return this; }
    setHeading() { return this; }
    setTooltip() { return this; }
    setDisabled() { return this; }
    then(cb: (s: this) => void) { if (typeof cb === 'function') cb(this); return this; }
    _control(obj?: Partial<MockControl>): MockControl {
        const ctrl: MockControl = {
            setValue() { return ctrl; }, getValue() { return ''; },
            setPlaceholder() { return ctrl; }, setDisabled() { return ctrl; },
            onChange() { return ctrl; }, onClick() { return ctrl; },
            setButtonText() { return ctrl; }, setCta() { return ctrl; }, setWarning() { return ctrl; },
            setIcon() { return ctrl; }, setTooltip() { return ctrl; },
            addOption() { return ctrl; }, addOptions() { return ctrl; }, selectEl: createMockEl('select'),
            inputEl: createMockEl('input'), buttonEl: createMockEl('button'), toggleEl: createMockEl('div'),
            ...obj,
        };
        this.components.push(ctrl);
        return ctrl;
    }
    addText(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
    addTextArea(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
    addSearch(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
    addToggle(cb?: (c: MockControl) => void) { const c = this._control({ getValue() { return false; } }); if (cb) cb(c); return this; }
    addButton(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
    addExtraButton(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
    addDropdown(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
    addSlider(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
    addMomentFormat(cb?: (c: MockControl) => void) { const c = this._control(); if (cb) cb(c); return this; }
}

export class AbstractInputSuggest {
    app: unknown;
    inputEl: unknown;

    constructor(app: unknown, inputEl: unknown) { this.app = app; this.inputEl = inputEl; }
    setValue() {} getValue() { return ''; }
    onSelect() {} close() {} open() {}
    setSuggestions() {} renderSuggestion() {} selectSuggestion() {}
    getSuggestions() { return []; }
}

export class HoverPopover {
    hoverEl: El;
    constructor() { this.hoverEl = createMockEl('div'); }
    hide() {}
}

export const Keymap = {
    isModifier() { return false; },
    isModEvent() { return false; },
    compileModifiers() { return ''; },
    decompileModifiers() { return []; },
};

export class MarkdownRenderer {
    static async render() {}
    static async renderMarkdown() {}
}

// ── Plugin: działające loadData/saveData + registerInterval tracking + no-opy ──
export class Plugin {
    app: AppLike | undefined;
    manifest: { id?: string };
    _children: unknown[];
    /** Review W5-01: dry-boot ma POKAZAĆ, że komendy i ikony wstążki naprawdę się zarejestrowały. */
    _registeredCommands: unknown[];
    _registeredRibbonIcons: { icon: unknown; title: unknown }[];

    constructor(app: AppLike | undefined, manifest?: { id?: string }) {
        this.app = app;
        this.manifest = manifest || {};
        this._children = [];
        // Wcześniej `addCommand` był czystym no-opem, więc regresja „zero komend, bo env nie wstał"
        // przechodziła przez harness niezauważona. Trzymamy same zarejestrowane definicje.
        this._registeredCommands = [];
        this._registeredRibbonIcons = [];
    }

    _dataPath() {
        const id = this.manifest?.id || 'pkm-assistant';
        return `.obsidian/plugins/${id}/data.json`;
    }

    async loadData(): Promise<unknown> {
        try {
            const adapter = this.app?.vault?.adapter;
            const path = this._dataPath();
            if (!adapter || !(await adapter.exists(path))) return null;
            const raw = await adapter.read(path);
            return JSON.parse(raw);
        } catch (e: unknown) {
            console.warn('[harness] Plugin.loadData failed:', powod(e));
            return null;
        }
    }

    async saveData(data: unknown): Promise<void> {
        try {
            const adapter = this.app?.vault?.adapter;
            const path = this._dataPath();
            await adapter?.write(path, JSON.stringify(data, null, 2));
        } catch (e: unknown) {
            console.warn('[harness] Plugin.saveData failed:', powod(e));
        }
    }

    addCommand<T>(cmd: T): T { this._registeredCommands.push(cmd); return cmd; }
    addRibbonIcon(icon: unknown, title: unknown) {
        this._registeredRibbonIcons.push({ icon, title });
        return createMockEl('div');
    }
    addStatusBarItem() { return createMockEl('div'); }
    addSettingTab() {}
    registerView() {}
    registerHoverLinkSource() {}
    registerExtensions() {}
    registerEvent<T>(ref: T): T { return ref; }
    registerDomEvent() {}
    registerInterval(id: TimerId) { _trackedIntervals.add(id); return id; }
    registerMarkdownCodeBlockProcessor() {}
    registerMarkdownPostProcessor() {}
    registerObsidianProtocolHandler() {}
    registerEditorExtension() {}
    registerEditorSuggest() {}
    addChild<T>(c: T): T { this._children.push(c); return c; }
    removeChild<T>(c: T): T { return c; }
    load() {} onload() {} unload() {} onunload() {}
    register() {}
}

// ── default export: obiekt ze wszystkimi symbolami (src/main.ts: `import Obsidian from "obsidian"`) ──
const obsidian = {
    Platform,
    Notice,
    Plugin,
    Component,
    Modal,
    ItemView,
    PluginSettingTab,
    Setting,
    AbstractInputSuggest,
    HoverPopover,
    Keymap,
    MarkdownRenderer,
    TAbstractFile,
    TFile,
    TFolder,
    requestUrl,
    normalizePath,
    setIcon,
    addIcon,
};

export default obsidian;
