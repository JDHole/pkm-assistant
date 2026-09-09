/**
 * `PluginRuntime` — podłoga runtime'u pluginu.
 *
 * UMOWA CYKLU ŻYCIA: `new PluginRuntime(host, config)` jest SYNCHRONICZNY i tani —
 * nie czyta dysku, nie czeka na layout, nie rzuca. Composition root tworzy runtime
 * w `onload()`, PRZED jakimkolwiek `await`, więc `plugin.env` jest różne od `null`
 * od pierwszej linijki `onload()`.
 *
 * ZAKAZY:
 *  • ZERO okien czasowych na ścieżce startu — nie ma pola „ile czekać";
 *  • `boot()` NIE ZAPISUJE `SETTINGS_PATH` i nie planuje zapisu;
 *  • `boot()` nie rzuca — każda awaria degraduje do defaultów i loguje.
 */
import { waitForLayoutReady } from '../layoutReady.js';
import { PluginVaultFs } from '../PluginVaultFs.js';
import { log as globalLog } from '../utils/Logger.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { hostWindow } from '../utils/hostWindow.js';
import { cloneConfig } from './configMerge.js';
import { NoticeCenter } from './NoticeCenter.js';
import { SettingsStore } from './SettingsStore.js';
import { createStatusBar } from './StatusBar.js';
import { createVaultSettingsIo, loadSettingsWithArmor } from './settingsArmor.js';
import { SETTINGS_DIR, SETTINGS_PATH, SETTINGS_PRE_MIGRATION_PATH } from './contracts.js';
import type {
    ChatModelLike,
    EmbeddingModelLike,
    EmbeddingRegistryLike,
    EventEmitterLike,
    LoggerLike,
    NoticeHandle,
    PluginHost,
    RuntimeConfig,
    RuntimeEventKey,
    RuntimeLoadedSource,
    RuntimeState,
    SettingsBag,
    SettingsIo,
    SettingsOwner,
    SettingsSource,
    StatusBarController,
} from './contracts.js';

const SCOPE = 'PluginRuntime';

/**
 * Jedyne dopuszczalne czekanie POZA zdarzeniem layoutu: odpytanie flagi synchronizacji
 * Obsidiana. Nie jest to ślepe okno — pętla kończy się, gdy sync odpuści, a poza Obsidianem
 * (goły Node, harness) nie wykonuje ANI JEDNEGO obrotu, bo nie ma czego pytać.
 */
const VAULT_SYNC_POLL_MS = 100;
/** Sufit odpytywania synchronizacji: dalej startujemy mimo trwającego sync-u. */
const VAULT_SYNC_MAX_POLLS = 30;

/** Luźny widok worka — dane z dysku są `unknown`. */
type Worek = Record<string, unknown>;

/** Konstruktor natywnego powiadomienia Obsidiana, wyszukany leniwie (patrz `_zaladujNotice`). */
type NoticeCtor = new (content: string | DocumentFragment, timeout: number) => NoticeHandle;

/**
 * Rejestr embeddingu na czas, zanim composition root wstawi prawdziwy (klaster `embedding`).
 * Fail-closed: brak dostawcy to `null`, nie zgadywanie i nie sieć.
 */
class PustyRejestrEmbeddingu implements EmbeddingRegistryLike {
    readonly default: EmbeddingModelLike | null = null;
    isConfigured(): boolean { return false; }
    select(providerId: string): EmbeddingModelLike {
        throw new Error(`Rejestr embeddingu nie został podłączony (dostawca: ${providerId})`);
    }
    providers(): Array<{ readonly id: string; readonly label: string; readonly defaultModel: string }> {
        return [];
    }
}

export class PluginRuntime implements SettingsOwner, RuntimeLoadedSource {
    // `declare` = sama deklaracja typu, zero emitu.
    /** Szyna zdarzeń runtime'u. Dokładnie dwa klucze. */
    declare readonly events: EventEmitterLike<RuntimeEventKey>;
    /** Magazyn — `raw`, `save()`, `pendingSaveTimer`. */
    declare readonly settingsStore: SettingsStore;
    declare readonly notices: NoticeCenter;
    /** Dostęp do plików vaulta. */
    declare readonly fs: PluginVaultFs;
    /** WSPÓŁDZIELONY SLOT modelu czatu — zapisywalny z zewnątrz, zerowany przy zamykaniu czatu. */
    declare chatModel: ChatModelLike | null;
    /**
     * Rejestr modeli embeddingu. SLOT, nie wytwórnia: sam rejestr mieszka w klastrze
     * `embedding`, a `core/` nie importuje z modułów — wstawia go composition root.
     * Do tego czasu stoi tu pusty rejestr, żeby `runtime.embeddings.default` nigdy nie wybuchło.
     */
    declare embeddings: EmbeddingRegistryLike;
    /** TA SAMA referencja co obiekt podany konstruktorowi. */
    declare readonly config: RuntimeConfig;
    /** Host, którego runtime dostał — czytelny dla `PluginBase` i dla testów. */
    declare readonly host: PluginHost;

    declare private _state: RuntimeState;
    declare private _statusBar: StatusBarController | null;
    declare private _log: LoggerLike;
    /** Ostatni bieg startu (w toku albo zakończony) — `boot()` jest przez to idempotentne. */
    declare private _bieg: Promise<void> | null;
    declare private _wToku: boolean;
    /** Czekający na `'loaded'`; `dispose()` czyści zbiór, więc porzuceni NIE dostaną resolve. */
    declare private _czekajacy: Set<() => void>;
    declare private _noticeCtor: NoticeCtor | null;
    /** Skąd przyjechały ustawienia w tym boocie — do logu i selftestu. */
    declare private _settingsSource: SettingsSource;
    /** Czy pierwszy realny zapis ma poprzedzić kopia sprzed migracji starych kluczy. */
    declare private _kopiaPrzedMigracja: boolean;
    /**
     * Treść worka sprzed migracji, zapamiętana przy pierwszej próbie kopii. Trzymamy ją,
     * bo po nieudanej kopii plik główny bywa już nadpisany nowym kształtem — ponowny
     * odczyt z dysku utrwaliłby pod nazwą „sprzed migracji" worek PO migracji.
     */
    declare private _trescSprzedMigracji: string | null;

    constructor(host: PluginHost, config: RuntimeConfig) {
        this.host = host;
        this.config = config;
        this._log = config?.log ?? globalLog;
        this._state = 'loading';
        this._bieg = null;
        this._wToku = false;
        this._czekajacy = new Set();
        this._noticeCtor = null;
        this._settingsSource = 'defaults';
        this._kopiaPrzedMigracja = false;
        this._trescSprzedMigracji = null;
        this._statusBar = null;
        this.chatModel = null;
        this.embeddings = new PustyRejestrEmbeddingu();

        this.events = new EventEmitter();
        // Magazyn powstaje od razu, ale PUSTY: `new SettingsStore(...)` niczego nie czyta,
        // więc konstruktor runtime'u dalej nie dotyka dysku. Worek wjeżdża w `boot()`.
        this.settingsStore = new SettingsStore(this, { log: this._log });
        this.notices = new NoticeCenter({
            settingsStore: this.settingsStore,
            log: this._log,
            createNotice: (content, timeout) => this._pokazNatywne(content, timeout),
        });
        // Prefiks pusty: runtime widzi cały vault, a wąskie ścieżki mają własne strażniki.
        // `{}` zamiast `null` świadomie — `PluginVaultFs` bez `app` sięgnąłby po `window`,
        // którego w gołym Node nie ma.
        this.fs = new PluginVaultFs({ app: (this.host?.app ?? {}) as never });
    }

    /** `'loading' | 'loaded' | 'disposed'`. */
    get state(): RuntimeState {
        return this._state;
    }

    /** Obserwowany worek (skrót na `settingsStore.settings`). */
    get settings(): SettingsBag {
        return this.settingsStore.settings;
    }

    /** `null` poza Obsidianem albo gdy pasek się nie postawił. */
    get statusBar(): StatusBarController | null {
        return this._statusBar;
    }

    /** Fire-and-forget z `onload()`. Nie rzuca. Wielokrotne wołanie = no-op. */
    boot(): Promise<void> {
        if (this._state === 'disposed') return Promise.resolve();
        if (this._bieg) return this._bieg;
        return this._start();
    }

    /**
     * Obietnica gotowości.
     *
     * Rozwiązuje się na ZDARZENIE (gotowy runtime — na najbliższym mikrozadaniu), nigdy
     * na tick siatki. Po `dispose()` NIE rozwiąże się nigdy: kontynuacja po demontażu
     * byłaby zombie-inicjalizacją na cudzym runtime.
     */
    whenLoaded(): Promise<PluginRuntime> {
        if (this._state === 'disposed') return new Promise<PluginRuntime>(() => {});
        return new Promise<PluginRuntime>(resolve => {
            const czekajacy = (): void => {
                if (this._state !== 'loaded') return;
                this._czekajacy.delete(czekajacy);
                resolve(this);
            };
            this._czekajacy.add(czekajacy);
            // Gotowy runtime też przechodzi przez kolejkę czekających — dzięki temu
            // `dispose()` zdążone jeszcze w tej samej turze porzuca oczekiwanie.
            if (this._state === 'loaded') queueMicrotask(czekajacy);
        });
    }

    /**
     * Wymuszony (re)start ładowania. NIE emituje `'unloading'` — czekający na
     * `whenLoaded()` mają się doczekać nowego bootu, nie zostać porzuceni.
     */
    reload(): Promise<void> {
        if (this._state === 'disposed') return Promise.resolve();
        if (this._wToku && this._bieg) return this._bieg;
        return this._start();
    }

    /** Demontaż. Emituje `'unloading'` i przechodzi w `'disposed'`. */
    async dispose(): Promise<void> {
        if (this._state === 'disposed') return;
        // Kolejność ma znaczenie i jest SYNCHRONICZNA: stan i porzucenie czekających muszą
        // się wydarzyć, zanim cokolwiek odda sterowanie (inaczej ktoś doczeka się demontażu).
        this._state = 'disposed';
        this._czekajacy.clear();

        if (this.settingsStore.pendingSaveTimer !== null) {
            // Zaplanowana zmiana usera jest już w worku — dopisujemy ją, zamiast gubić.
            try {
                await this.settingsStore.save();
            } catch (e) {
                this._log.error(SCOPE, 'zapis ustawień przy demontażu padł:', e);
            }
        }

        try {
            this.notices.unload();
        } catch (e) {
            this._log.error(SCOPE, 'demontaż powiadomień padł:', e);
        }
        this._statusBar?.dispose();
        this._statusBar = null;
        this.chatModel = null;

        this.events.emit('unloading');
        this.events.removeAllListeners();
    }

    /** `SettingsOwner` — implementowane przez runtime dla `SettingsStore`. */
    async loadSettings(): Promise<SettingsBag> {
        const io = this._io();
        const wynik = await loadSettingsWithArmor({
            io,
            defaults: this.config?.defaults ?? {},
            log: this._log,
        });

        this._settingsSource = wynik.source;
        this._kopiaPrzedMigracja = wynik.migrations.legacyKeys || wynik.migrations.namespace;

        if (wynik.source !== 'primary') {
            this._log.warn(SCOPE, `Ustawienia wczytane ze źródła „${wynik.source}" — plik główny nie był czytelny`);
        }
        return wynik.settings;
    }

    /**
     * Argument OBOWIĄZKOWY. Wołanie bez niego robiło `JSON.stringify(undefined)`
     * i próbowało tym nadpisać plik z kluczami API.
     */
    async saveSettings(settings: SettingsBag): Promise<void> {
        if (!settings || typeof settings !== 'object') {
            throw new TypeError('saveSettings wymaga worka ustawień — bez argumentu nie zapisujemy niczego');
        }
        const io = this._io();
        await this._kopiaSprzedMigracji(io);
        await io.mkdir(SETTINGS_DIR);
        await io.write(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    }

    // ── bebechy ──────────────────────────────────────────────────────────────

    private _io(): SettingsIo {
        return createVaultSettingsIo(this.host?.app?.vault?.adapter);
    }

    private _start(): Promise<void> {
        this._state = 'loading';
        this._wToku = true;
        this._bieg = this._przebieg().finally(() => { this._wToku = false; });
        return this._bieg;
    }

    private async _przebieg(): Promise<void> {
        try {
            // Najpierw ZDARZENIE layoutu. Poza Obsidianem workspace'u nie ma
            // wcale i funkcja wraca natychmiast — bez tej gałęzi boot w Node wisiałby wiecznie.
            await waitForLayoutReady(this.host?.app?.workspace);
            if (this._zdemontowany()) return;

            // Pasek staje ZARAZ po layoucie, a PRZED jakimkolwiek I/O ustawień.
            // Czekanie na synchronizację i czytanie worka potrafi potrwać — user ma w tym
            // czasie widzieć żywy pasek, a nie pustkę. `_postawPasek()` łyka własne błędy,
            // więc nie ma prawa zabrać sterowania ładowaniu ustawień.
            this._postawPasek();

            await this._poczekajNaSynchronizacje();
            if (this._zdemontowany()) return;

            const worek = await this.loadSettings();
            if (this._zdemontowany()) return;
            // Podmiana CAŁEGO worka, nie mutacja przez proxy — boot nie planuje zapisu.
            this.settingsStore.settings = worek;
        } catch (e) {
            // Awaria startu degraduje do defaultów; user ma dostać żywy plugin, nie martwy.
            this._log.warn(SCOPE, 'Start runtime\'u padł — degradacja do ustawień fabrycznych:', e);
            this.settingsStore.settings = cloneConfig(this.config?.defaults ?? {});
        }

        if (this._zdemontowany()) return;
        // Stan PRZED emisją — słuchacz musi zobaczyć gotowy runtime.
        this._state = 'loaded';
        this._obudzCzekajacych();
        this.events.emit('loaded');
    }

    /** Osobna metoda, nie goły warunek: `dispose()` bywa w innej turze niż sprawdzenie. */
    private _zdemontowany(): boolean {
        return this._state === 'disposed';
    }

    private _obudzCzekajacych(): void {
        for (const czekajacy of [...this._czekajacy]) czekajacy();
    }

    private _postawPasek(): void {
        if (this._statusBar) return;
        try {
            const kontener = this.host?.addStatusBarItem?.() ?? null;
            this._statusBar = createStatusBar({
                container: kontener,
                renderer: this.config?.statusBar,
                log: this._log,
            });
        } catch (e) {
            this._log.warn(SCOPE, 'Pasek statusu się nie postawił:', e);
            this._statusBar = null;
        }
    }

    /**
     * Jedyne odpytywanie na ścieżce startu — flaga synchronizacji Obsidiana.
     * Poza Obsidianem (albo bez włączonego Sync-u) nie wykonuje żadnego obrotu.
     */
    private async _poczekajNaSynchronizacje(): Promise<void> {
        const sync = this._instancjaSynchronizacji();
        if (!sync) return;
        for (let i = 0; i < VAULT_SYNC_MAX_POLLS; i++) {
            if (!this._synchronizujeSie(sync)) return;
            await new Promise<void>(resolve => { hostWindow.setTimeout(resolve, VAULT_SYNC_POLL_MS); });
        }
        this._log.warn(SCOPE, 'Synchronizacja vaulta trwa dłużej niż limit startu — ruszamy mimo niej');
    }

    private _instancjaSynchronizacji(): Worek | null {
        const app = this.host?.app as unknown as Worek | undefined;
        const wtyczki = (app?.['internalPlugins'] as Worek | undefined)?.['plugins'] as Worek | undefined;
        const sync = wtyczki?.['sync'] as Worek | undefined;
        const instancja = sync?.['instance'] as Worek | undefined;
        return instancja ?? null;
    }

    private _synchronizujeSie(instancja: Worek): boolean {
        const status = instancja['syncStatus'];
        if (typeof status !== 'string') return false;
        const s = status.toLowerCase();
        return s.includes('sync') && !s.includes('fully');
    }

    /**
     * Jednorazowa kopia worka SPRZED przeniesienia starych kluczy — zostaje w vaultcie
     * na zawsze, plugin jej nie kasuje. Robimy ją tuż PRZED pierwszym realnym zapisem,
     * bo dopiero on utrwala nowy kształt; boot z definicji nie pisze niczego.
     */
    private async _kopiaSprzedMigracji(io: SettingsIo): Promise<void> {
        if (!this._kopiaPrzedMigracja) return;
        try {
            // „Czy kopia już jest?" sprawdzamy PRÓBĄ ODCZYTU, nigdy przez `exists()`.
            if (await io.read(SETTINGS_PRE_MIGRATION_PATH) !== null) {
                this._kopiaZamknieta();
                return;
            }
            // Treść czytamy RAZ i trzymamy do skutku — patrz `_trescSprzedMigracji`.
            if (this._trescSprzedMigracji === null) {
                this._trescSprzedMigracji = await io.read(SETTINGS_PATH);
            }
            const stary = this._trescSprzedMigracji;
            if (stary === null) {
                // Nie ma czego kopiować i nigdy nie będzie: plik główny powstanie dopiero
                // za chwilę, już w nowym kształcie.
                this._kopiaZamknieta();
                return;
            }
            await io.mkdir(SETTINGS_DIR);
            await io.write(SETTINGS_PRE_MIGRATION_PATH, stary);
            // Flaga gaśnie DOPIERO po udanej kopii. Gdyby gasła przed próbą, jeden pad
            // dysku kasowałby kopię sprzed migracji NA ZAWSZE — a to jedyna siatka
            // bezpieczeństwa usera na stare klucze.
            this._kopiaZamknieta();
        } catch (e) {
            this._log.warn(SCOPE, 'Kopia ustawień sprzed migracji się nie udała — spróbuję przy następnym zapisie:', e);
        }
    }

    /** Sprawa kopii sprzed migracji zamknięta: flaga gaśnie, zapamiętana treść leci z pamięci. */
    private _kopiaZamknieta(): void {
        this._kopiaPrzedMigracja = false;
        this._trescSprzedMigracji = null;
    }

    /**
     * Natywne powiadomienie Obsidiana. `Notice` jest WARTOŚCIĄ z modułu `obsidian`, więc
     * nie wolno go importować statycznie — ten plik musi wstawać w gołym Node (testy,
     * harness). Konstruktor dojeżdża leniwie, a poza Obsidianem zostaje uchwyt-atrapa.
     */
    private _pokazNatywne(content: string | DocumentFragment, timeout: number): NoticeHandle {
        if (!this._noticeCtor) {
            void this._zaladujNotice();
            this._log.debug(SCOPE, 'Powiadomienie bez UI (brak Obsidiana):', content);
            return { hide: () => {} };
        }
        return new this._noticeCtor(content, timeout);
    }

    private async _zaladujNotice(): Promise<void> {
        if (this._noticeCtor) return;
        try {
            const mod = await import('obsidian');
            this._noticeCtor = mod.Notice;
        } catch {
            // Goły Node — powiadomień po prostu nie ma i nie jest to błąd.
        }
    }
}
