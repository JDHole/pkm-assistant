/**
 * `core/runtime/contracts.ts` — kontrakt podłogi runtime'u pluginu PKM Assistant.
 *
 * JEDYNE źródło prawdy o powierzchni publicznej runtime'u. Implementacje powstają
 * pod ten plik; konsumenci (moduły, harness, testy) programują wyłącznie przeciw niemu.
 *
 * WŁAŚCICIELSTWO TYPÓW WSPÓŁDZIELONYCH: ten plik jest właścicielem `SettingsBag`,
 * `ChatSettingsSlice`, `EmbeddingSettingsSlice`, `SettingsRegistryLike`, `NoticeOptions`,
 * `NoticeLike`, `PluginHost`, `PluginApi`, `RuntimeConfig`. `modules/models` i
 * `modules/embedding` robią `import type` z `core/index.js` i NIE redeklarują tych nazw.
 *
 * CZEGO TU NIE MA:
 *   • transportu HTTP — mieszka w `core/http/contracts.ts`;
 *   • `NormalizedError` / `normalizeError` — właściciel to `core/utils/errorUtils.ts`;
 *   • niczego, co dotyczy urządzeń mobilnych (`manifest.isDesktopOnly === true`).
 *
 * @packageDocumentation
 */

import type { HttpClient, StreamTransport } from '../http/contracts.js';
import type { PluginRuntime } from './PluginRuntime.js';

// =============================================================================
// 0. TYPY Z GRANICY KLASTRA
// =============================================================================

/** Logger — w repo `core/utils/Logger.js` (globalny wyjątek złotej zasady). */
export interface LoggerLike {
    debug(scope: string, ...args: unknown[]): void;
    info(scope: string, ...args: unknown[]): void;
    warn(scope: string, ...args: unknown[]): void;
    error(scope: string, ...args: unknown[]): void;
}

/** Model czatu — pełny kontrakt w klastrze `models` (`ChatModel`). */
export interface ChatModelLike {
    readonly modelKey: string;
    stream(req: unknown, handlers: unknown): Promise<unknown>;
    stopStream(): void;
}

/** Model embeddingu widziany przez runtime — pełny kontrakt w klastrze `embedding`. */
export interface EmbeddingModelLike {
    readonly providerId: string;
    readonly modelId: string;
    readonly modelKey: string;
    readonly dims: number;
    embed(texts: string[]): Promise<Array<{ vector: number[] | null; tokens?: number }>>;
}

/** Rejestr embeddingu — pełny kontrakt w klastrze `embedding` (`EmbeddingRegistry`). */
export interface EmbeddingRegistryLike {
    readonly default: EmbeddingModelLike | null;
    /** `true` gdy `default !== null` — skrót dla `EmbeddingHelper.isReady()`. */
    isConfigured(): boolean;
    select(providerId: string, modelId?: string): EmbeddingModelLike;
    providers(): Array<{ readonly id: string; readonly label: string; readonly defaultModel: string }>;
}

/**
 * Dostawca czatu — kształt STRUKTURALNY (`core/` nie importuje z `modules/`).
 * Runtime nie wie, co dostawca robi; potrzebuje wyłącznie jego identyfikatora.
 */
export interface ChatProviderLike {
    readonly info: { readonly id: string };
}

/** Dostawca embeddingu — analogicznie. */
export interface EmbeddingProviderLike {
    readonly info: { readonly id: string };
}

/** Minimalny kształt workspace'u dla `waitForLayoutReady` (`core/layoutReady.ts`). */
export interface LayoutReadySource {
    onLayoutReady?: (callback: () => void) => void;
}

/** `App` Obsidiana w zakresie, jakiego dotyka runtime. */
export interface AppLike {
    vault: {
        adapter: VaultAdapterLike;
        configDir?: string;
        [key: string]: unknown;
    };
    /**
     * `onLayoutReady` MUSI być wołane jako metoda workspace'u
     * (`onLayoutReady.call(workspace, cb)`) — wywołanie przez samą referencję gubi `this`.
     */
    workspace: LayoutReadySource & Record<string, unknown>;
    [key: string]: unknown;
}

/** `DataAdapter` Obsidiana (`app.vault.adapter`) w zakresie używanym przez runtime. */
export interface VaultAdapterLike {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    remove?(path: string): Promise<void>;
    rename?(from: string, to: string): Promise<void>;
    stat?(path: string): Promise<{ type: string; mtime: number; size: number } | null>;
    append?(path: string, data: string): Promise<void>;
    [key: string]: unknown;
}

/** `manifest.json` pluginu. */
export interface PluginManifestLike {
    id: string;
    version: string;
    name?: string;
    minAppVersion?: string;
}

/** Uchwyt zdarzenia Obsidiana (`EventRef`) — runtime tylko go przekazuje. */
export type EventRefLike = object;

// =============================================================================
// 1. ZDARZENIA I STAN
// =============================================================================

/** Uchwyt odsubskrybowania. Każde `on()` MUSI go zwracać. */
export type Unsubscribe = () => void;

/** Handler zdarzenia szyny runtime'u. */
export type EventHandler<T = unknown> = (payload: T) => void;

/** Publiczne klucze zdarzeń środowiska. DOKŁADNIE DWA. */
export type RuntimeEventKey = 'loaded' | 'unloading';

/** Szyna zdarzeń runtime'u (`core/utils/EventEmitter.js` — własna, NIE-pochodna). */
export interface EventEmitterLike<K extends string = string> {
    /** MUSI zwracać uchwyt odsubskrybowania. */
    on(key: K, handler: EventHandler): Unsubscribe;
    once(key: K, handler: EventHandler): Unsubscribe;
    off(key: K, handler: EventHandler): void;
    emit(key: K, payload?: unknown): void;
    listenerCount(key: K): number;
    removeAllListeners(key?: K): void;
}

/**
 * Stan runtime'u — pole `runtime.state`.
 *
 * DOKŁADNIE TRZY WARTOŚCI:
 * • `'loading'`  — od konstruktora do końca `boot()`;
 * • `'loaded'`   — gotowe; DOPIERO PO ustawieniu tej wartości leci zdarzenie `'loaded'`;
 * • `'disposed'` — po `dispose()`.
 */
export type RuntimeState = 'loading' | 'loaded' | 'disposed';

/** Minimalny kształt, którego wymaga `waitForLoaded`. Pole nazywa się `events`. */
export interface RuntimeLoadedSource {
    state: string;
    events?: { on(key: string, callback: () => void): Unsubscribe };
}

// =============================================================================
// 2. BŁĘDY
// =============================================================================

/** Kody błędów runtime'u — stabilna część kontraktu (logi, selftest, testy). */
export type RuntimeErrorCode =
    | 'settings-corrupt'
    | 'settings-unreadable'
    | 'host-unavailable'
    | 'not-loaded'
    | 'disposed';

/** Wspólna baza błędów runtime'u. */
export class PluginRuntimeError extends Error {
    declare readonly code: RuntimeErrorCode;
    declare readonly cause?: unknown;

    constructor(code: RuntimeErrorCode, message: string, cause?: unknown) {
        super(message);
        this.name = 'PluginRuntimeError';
        this.code = code;
        this.cause = cause;
    }
}

/**
 * Rzucane WYŁĄCZNIE z warstwy pancerza do jej własnego wołacza — `boot()` łapie
 * je i degraduje do defaultów. Nigdy nie wychodzi do konsumenta.
 */
export class SettingsCorruptError extends PluginRuntimeError {
    declare readonly path: string;
    declare readonly raw: string;

    constructor(path: string, raw: string, cause?: unknown) {
        super('settings-corrupt', `Nieczytelny plik ustawień: ${path}`, cause);
        this.name = 'SettingsCorruptError';
        this.path = path;
        this.raw = raw;
    }
}

// =============================================================================
// 3. USTAWIENIA — KSZTAŁT (nowe klucze)
// =============================================================================

/** Worek ustawień. Na dysku: `.pkm-assistant/settings.json` (NIE `data.json`). */
export interface SettingsBag {
    pkmAssistant?: PkmAssistantSettings;
    /** Indeks otwarty: moduły dokładają własne gałęzie pod `pkmAssistant`. */
    [key: string]: unknown;
}

/** Namespace pluginu. Poprzedni namespace migrowany przez `migrateNamespace`. */
export interface PkmAssistantSettings {
    chat?: ChatSettingsSlice;
    embedding?: EmbeddingSettingsSlice;
    notices?: NoticesSettingsSlice;
    /** Język UI. Czytany też PRZED bootem przez `readUiLanguage`. */
    language?: string;
    /** Limity pętli agenta — nadpisują `DEFAULT_LIMITS` z `config/limits.ts`. */
    limits?: Record<string, number>;
    /** Foldery No-Go (`AccessGuard`). JEDYNE źródło wykluczeń. */
    no_go_folders?: string[];
    secureStorage?: SecureStorageSlice;
    debugMode?: boolean;
    fileLogEnabled?: boolean;
    traceEnabled?: boolean;
    defaultAutonomy?: string;
    userColor?: string;
    artifactsFolder?: string;
    indexArtifacts?: boolean;
    komunikatorEnabled?: boolean;
    onboardingCompleted?: number | boolean;
    modelLibrary?: unknown;
    vaultGroups?: unknown;
    security?: Record<string, unknown>;
    /** Limit tokenów wyjścia per platforma — ZOSTAJE pod tą nazwą. */
    maxTokens?: Record<string, number>;
    [key: string]: unknown;
}

/**
 * Ustawienia czatu. `platform === ''` znaczy „nie wybrano" — wartości nieobsługiwane
 * migrator zeruje.
 */
export interface ChatSettingsSlice {
    platform?: string;
    /** klucz API per dostawca; ścieżki są w `SECRET_FIELD_PATHS` sejfu */
    apiKeys?: Record<string, string>;
    /** wybrany model per dostawca */
    models?: Record<string, string>;
    /** adresy serwerów lokalnych: `ollama`, `lm_studio` */
    hosts?: Record<string, string>;
    temperature?: number;
    maxTokens?: number;
    [key: string]: unknown;
}

/**
 * Ustawienia embeddingu. `provider === ''` = brak, semantyka wyłączona.
 * KSZTAŁT NADRZĘDNY — `modules/embedding` importuje ten typ i go NIE redeklaruje.
 */
export interface EmbeddingSettingsSlice {
    provider?: string;
    models?: Record<string, string>;
    /** Klucze embeddingu wchodzą do sejfu. */
    apiKeys?: Record<string, string>;
    /** Baza adresu dla dostawców lokalnych; brak = adres domyślny dostawcy. Bez UI. */
    hosts?: Record<string, string>;
    /** Porcja doradcza per dostawca. Bez UI. */
    batchSize?: Record<string, number>;
    /** Sufit czasu jednego żądania embeddingu. Bez UI. */
    timeoutMs?: number;
    [key: string]: unknown;
}

/** Wyciszone powiadomienia per id. */
export interface NoticesSettingsSlice {
    muted?: Record<string, boolean>;
}

/**
 * Sejf sekretów. `refs` mapuje ścieżkę ustawienia → id sekretu; `encrypted` jest
 * kluczowane po tych id. ID SĄ NIEPRZEZROCZYSTE DLA CAŁEGO KODU — jedyny
 * wyjątek to migrator kwarantannowy.
 */
export interface SecureStorageSlice {
    enabled?: boolean;
    backend?: string;
    masterSalt?: string;
    refs?: Record<string, string>;
    encrypted?: Record<string, unknown>;
}

// =============================================================================
// 4. USTAWIENIA — MAGAZYN (`SettingsStore`)
// =============================================================================

/** Właściciel magazynu: dostarcza I/O. Runtime podaje siebie. */
export interface SettingsOwner {
    loadSettings(): Promise<SettingsBag> | SettingsBag;
    /** Argument jest OBOWIĄZKOWY. */
    saveSettings(settings: SettingsBag): Promise<void> | void;
}

export interface SettingsStoreOptions {
    /** Domyślnie {@link SETTINGS_SAVE_DEBOUNCE_MS}. */
    saveDelayMs?: number;
    /** Nadpisanie zapisu (testy podają własny). */
    save?: (settings: SettingsBag) => Promise<void> | void;
    /** Nadpisanie odczytu. */
    load?: () => Promise<SettingsBag> | SettingsBag;
    log?: LoggerLike;
}

/** Debounce zapisu ustawień. */
export const SETTINGS_SAVE_DEBOUNCE_MS = 1000;

// =============================================================================
// 5. USTAWIENIA — PANCERZ
// =============================================================================

/** Katalog danych pluginu w vaultcie. */
export const SETTINGS_DIR = '.pkm-assistant';
/** JEDYNY plik ustawień; klucze API są w środku. */
export const SETTINGS_PATH = '.pkm-assistant/settings.json';
/** Kopia zapasowa; awansuje WYŁĄCZNIE z treści, która się sparsowała. */
export const SETTINGS_LAST_GOOD_PATH = '.pkm-assistant/settings.last-good.json';
/** Katalog backupów dziennych. */
export const SETTINGS_BACKUPS_DIR = '.pkm-assistant/backups';
/** Ile backupów dziennych zostaje po rotacji. */
export const SETTINGS_BACKUP_RETENTION = 7;
/** Wzorzec nazwy odkładki nieczytelnego pliku. Scenariusze 26/27 pinują ten regex. */
export const SETTINGS_CORRUPT_PATH_PATTERN = /^\.pkm-assistant\/settings\.corrupt-\d+\.json$/;
/** Jednorazowa kopia sprzed migracji starych kluczy — zostaje w vaultcie na zawsze. */
export const SETTINGS_PRE_MIGRATION_PATH = '.pkm-assistant/settings.pre-migration.json';

/** Skąd przyjechały ustawienia w tym boocie — obserwowalne przez log i selftest. */
export type SettingsSource = 'primary' | 'last-good' | 'defaults';

/** Wynik wczytania ustawień z pancerzem. */
export interface SettingsLoadResult {
    /** Zmergowany worek: defaulty + to, co się wczytało + migracje w PAMIĘCI. */
    settings: SettingsBag;
    source: SettingsSource;
    /** Ścieżka powstałej odkładki `settings.corrupt-<ts>.json`, gdy powstała. */
    quarantinedPath?: string;
    /** Czy `settings.last-good.json` został ODŚWIEŻONY w tym boocie. */
    lastGoodRefreshed: boolean;
    /** Czy powstał dzienny backup. */
    backupWritten: boolean;
    /** Migracje w pamięci, które zaszły. */
    migrations: {
        namespace: boolean;
        legacyKeys: boolean;
    };
}

/**
 * Minimalne I/O pancerza — wydzielone po to, żeby cały pancerz dał się przetestować
 * bez Obsidiana. Wszystkie metody mogą rzucać; pancerz sam się broni.
 *
 * NIGDY nie ufamy `exists()` — sprawdzamy PRÓBĄ ODCZYTU.
 */
export interface SettingsIo {
    read(path: string): Promise<string | null>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    remove(path: string): Promise<void>;
    /** Do nazwy odkładki i do rotacji backupów. Wstrzykiwane dla determinizmu testu. */
    now(): number;
}

export interface SettingsArmorDeps {
    io: SettingsIo;
    /** Fabryczne ustawienia (`config/defaultSettings.ts`). Kopiowane, nie mutowane. */
    defaults: SettingsBag;
    log?: LoggerLike;
}

/** Wartość zwracana przez `readUiLanguage`, gdy nic nie znaleziono. */
export const DEFAULT_UI_LANGUAGE = 'en';

// =============================================================================
// 6. MIGRACJE DANYCH USERA
// =============================================================================

/** Wynik migracji starych kluczy ustawień. */
export interface LegacySettingsMigrationResult {
    migrated: boolean;
    /** ile gałęzi/kluczy przeniesiono pod nowe adresy */
    movedKeys: number;
    /** ile martwych kluczy skasowano */
    removedKeys: number;
    /**
     * Ile wpisów w `secureStorage` przemianowano — migrator przepina KLUCZE mapy `refs`
     * ORAZ przemianowuje ID SEKRETÓW (wartości `refs` i klucze `encrypted`), bez
     * odszyfrowywania. Licznik obejmuje obie operacje razem.
     */
    secretRefsMigrated: number;
}

// =============================================================================
// 7. POWIADOMIENIA
// =============================================================================

/** Przycisk akcji w powiadomieniu. */
export interface NoticeAction {
    label: string;
    onClick: () => void;
}

export interface NoticeOptions {
    /** Stabilny identyfikator powiadomienia; pozwala je wyciszyć. */
    id?: string;
    /** ms; `0` = nie znika samo. Domyślnie {@link NOTICE_DEFAULT_TIMEOUT_MS}. */
    timeout?: number;
    /** Gdy `true` i podano `id`, powiadomienie dostaje guzik „wycisz". */
    mutable?: boolean;
    /** Guziki akcji; kontener dostaje klasę {@link NOTICE_ACTIONS_CSS_CLASS}. */
    actions?: NoticeAction[];
}

/** Uchwyt do zamknięcia powiadomienia. */
export interface NoticeHandle {
    hide(): void;
}

/** WĄSKI widok centrum powiadomień, wstrzykiwany do modułów. */
export interface NoticeLike {
    show(message: string, options?: NoticeOptions): NoticeHandle | null;
}

/** Domyślny czas życia powiadomienia. */
export const NOTICE_DEFAULT_TIMEOUT_MS = 4000;
/** Klasa kontenera guzików akcji. */
export const NOTICE_ACTIONS_CSS_CLASS = 'pkm-notice-actions';

// =============================================================================
// 8. PASEK STATUSU
// =============================================================================

/** Komponent paska statusu wstrzykiwany configiem. */
export interface StatusBarRenderer {
    /** Zwraca element, który runtime wstawi do paska statusu Obsidiana. */
    render(): HTMLElement;
}

/** Uchwyt paska statusu. */
export interface StatusBarController {
    /** Przerysowanie treści paska (drugi kanał: zdarzenia „pulsu pamięci"). */
    refresh(): void;
    setText(text: string): void;
    /** Przełącza wariant klikalny. */
    setClickable(handler: (() => void) | null): void;
    dispose(): void;
}

/** Klasy CSS paska. */
export const STATUS_BAR_CSS_CLASSES = [
    'pkm-status-bar-item',
    'pkm-status-bar-item--clickable',
    'pkm-status-container',
    'pkm-status-spinner',
] as const;

// =============================================================================
// 9. HOST — CZEGO RUNTIME POTRZEBUJE OD `Plugin` OBSIDIANA
// =============================================================================

/**
 * `PluginHost` — jedyne wejście runtime'u do Obsidiana. Runtime NIE dziedziczy po
 * `Plugin`: dostaje ten interfejs w konstruktorze, dzięki czemu wstaje w gołym Node.
 *
 * ⚠️ ŚWIADOMY BRAK: `isMobile`. Runtime nie pyta o platformę — gałęzi zależnej od niej
 * nie ma. `VaultIndexer` dostaje tę informację wprost z composition roota.
 */
export interface PluginHost {
    readonly app: AppLike;
    readonly manifest: PluginManifestLike;

    /** `data.json` pluginu — TYLKO wersjonowanie, nie ustawienia. */
    loadData(): Promise<PluginVersionData | null>;
    saveData(data: PluginVersionData): Promise<void>;

    /** Kontener paska statusu. */
    addStatusBarItem(): HTMLElement;

    /** Jednorazowe budziki MUSZĄ iść tędy, inaczej przeżywają unload. */
    registerInterval(id: number): number;
    /** Rejestracja nasłuchu vaulta/workspace'u z auto-sprzątaniem. */
    registerEvent(ref: EventRefLike): void;
}

/**
 * Zawartość `.obsidian/plugins/<manifest.id>/data.json`.
 * NAZWY PÓL SĄ ZAMROŻONE — fixture harnessu na nich stoi.
 */
export interface PluginVersionData {
    installed_at?: number;
    last_version?: string;
    [key: string]: unknown;
}

// =============================================================================
// 10. KONFIGURACJA RUNTIME'U
// =============================================================================

/**
 * `RuntimeConfig` — zwykły obiekt budowany w composition roocie
 * (`config/runtimeConfig.ts`, `buildRuntimeConfig()`).
 *
 * KONTRAKT REFERENCJI: obiekt powstaje w KONSTRUKTORZE pluginu
 * (`PluginBase.runtimeConfig`), `onload()` podaje TĘ SAMĄ referencję konstruktorowi
 * runtime'u, a `runtime.config === plugin.runtimeConfig`.
 */
export interface RuntimeConfig {
    chat: {
        providers: Record<string, ChatProviderLike>;
        http: HttpClient;
        transport: StreamTransport;
    };
    embedding: {
        providers: Record<string, EmbeddingProviderLike>;
        http: HttpClient;
    };
    /** Fabryczne ustawienia (`config/defaultSettings.ts`). */
    defaults: SettingsBag;
    /** Override komponentu paska statusu. */
    statusBar?: StatusBarRenderer;
    /** DI loggera — testy podstawiają szpiega. */
    log?: LoggerLike;
}

// =============================================================================
// 11. POWIERZCHNIA `plugin.*` (widok modułów)
// =============================================================================

/** Definicja komendy. Nazwa NIE zawiera nazwy pluginu — Obsidian ją dokleja. */
export interface CommandDef {
    id: string;
    name: string;
    callback: () => void | Promise<void>;
}

/** Definicja ikony wstążki. Kolejność w mapie = kolejność ikon na pasku. */
export interface RibbonIconDef {
    iconName: string;
    description: string;
    callback: () => void | Promise<void>;
}

/** Opcje `showCrystalNotice` — own-code, kształt zamrożony przez 4 konsumentów. */
export interface CrystalNoticeOptions {
    type?: 'info' | 'success' | 'warning' | 'error' | 'agent';
    /** domyślnie 4000; `0` = nie znika samo */
    timeout?: number;
    /** kolor akcentu dla `type: 'agent'` */
    agentColor?: string;
}

/**
 * `PluginApi` — kształt obiektu pluginu widziany przez MODUŁY. Moduły nigdy nie
 * importują klasy pluginu, tylko przyjmują „coś o tym kształcie".
 */
export interface PluginApi {
    readonly app: AppLike;
    readonly manifest: PluginManifestLike;
    /** Dla modułów pole jest TYLKO DO ODCZYTU (zapisuje je wyłącznie composition root). */
    readonly env: PluginRuntime | null;
    /** Ta sama referencja co `runtime.config`; moduły jej nie mutują. */
    readonly runtimeConfig: RuntimeConfig;
    readonly settings: SettingsBag;
    readonly notices: NoticeLike | null;
    readonly _ready: boolean;
    onReady(callback: () => void): void;
    waitForReady(): Promise<void>;
    showCrystalNotice(message: string, options?: CrystalNoticeOptions): NoticeHandle | null;
    applyUserColor(hex?: string): void;
    openChatView(): void;
    openNote(path: string, event?: unknown): Promise<void>;
    registerEvent(ref: EventRefLike): void;
    registerInterval(id: number): number;

    /** Ustawiane w inicjalizacji, PRZED `_ready` — kontrakty w modułach właścicielach. */
    agentManager?: unknown;
    toolRegistry?: unknown;
    mcpClient?: unknown;
    serverManager?: unknown;
    externalMcpManager?: unknown;
    permissionSystem?: unknown;
    approvalManager?: unknown;
    secretsStorage?: unknown;
    artifactStore?: unknown;
    vaultIndexer?: unknown;
    oramaDb?: unknown;
    subTaskRegistry?: unknown;
    subTaskNotifier?: unknown;
    traceLog?: unknown;
    skinManager?: unknown;

    /** Moduły dopinają do pluginu własne, prywatne pola. */
    [key: string]: unknown;
}

// =============================================================================
// 12. KLASY BAZOWE UI — KSZTAŁTY KLAS
// =============================================================================

/**
 * Statyki, których wymaga `PluginItemView.register`.
 *
 * JEDNA SYGNATURA `open` W CAŁYM REPO: `open(workspace, state?, active?)`. Podklasy
 * jej NIE zmieniają; gdy potrzebują skrótu, dokładają WŁASNĄ statykę
 * (np. `openForVersion(workspace, version)`), która woła `open(workspace, { version })`.
 */
export interface PluginItemViewClass {
    /** Typ widoku Obsidiana. ⚠️ WARTOŚĆ id się NIE zmienia — user straciłby otwartą kartę. */
    readonly viewType: string;
    /** Tytuł zakładki. */
    readonly displayText: string;
    /** Ikona. */
    readonly iconName: string;
    /** Rejestruje widok + komendę „otwórz". */
    register(plugin: PluginApi): void;
    /** Otwiera widok; no-op, gdy workspace nie dał liścia. */
    open(workspace: unknown, state?: Record<string, unknown>, active?: boolean): Promise<void>;
    new (leaf: unknown, plugin: PluginApi): object;
}

/** Mapa nazwa→klasa widoku (dziś: notatki wydania + czat). */
export type ItemViewMap = Record<string, PluginItemViewClass>;

/** Kształt klasy zakładki ustawień, jakiego wymaga composition root. */
export interface PluginSettingsTabClass {
    new (app: AppLike, plugin: PluginApi): object;
}

// =============================================================================
// 13. REJESTR SEKCJI USTAWIEŃ
// =============================================================================

/** Jedna sekcja w rejestrze ustawień shella. */
export interface SettingsSectionDef {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    /**
     * Renderer jest TRZYARGUMENTOWY i sięga po kontekst przez `options.owner`.
     * Dwuargumentowy wariant NIE ISTNIEJE.
     */
    render(
        containerEl: HTMLElement,
        plugin: PluginApi,
        options: { owner: { buildSectionContext(): SettingsSectionCtx } },
    ): void | Promise<void>;
}

/** Pod-pole doklejane do CUDZEJ sekcji (np. `models-api-keys` w sekcji `api-keys`). */
export interface SettingsSubFieldDef {
    id: string;
    order?: number;
    render(): void | Promise<void>;
}

/**
 * Rejestr sekcji ustawień. Mieszka w `modules/shell`, ale TYP jest własnością
 * tego pliku — rejestrują się w nim `core`, `modules/models` i `modules/crystal-soul`.
 */
export interface SettingsRegistryLike {
    register(section: SettingsSectionDef): void;
    /** Dokłada pod-pole do sekcji o podanym `parentId`. */
    registerSubFields(parentId: string, sub: SettingsSubFieldDef): void;
}

/**
 * Worek DI budowany przez shell, bo `core/` nie importuje z modułów.
 * `Setting`/`Notice` wchodzą TĘDY, żeby barrel został node-safe.
 */
export interface SettingsSectionCtx {
    /** slice `pkmAssistant.chat` */
    chat: ChatSettingsSlice;
    /** slice `pkmAssistant` */
    pkm: PkmAssistantSettings;
    save(): Promise<void> | void;
    owner: { app: AppLike; display(): void; showKeys: Record<string, boolean> };
    plugin: PluginApi;
    env: PluginRuntime;
    icons?: Record<string, (size?: number) => string>;
    setSvg(el: HTMLElement, svg: string): void;
    setSvgLabel(el: HTMLElement, svg: string, label: string): void;
    Setting: unknown;
    Notice?: unknown;
    openCostTrackingModal(): Promise<void> | void;
}
