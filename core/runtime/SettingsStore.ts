/**
 * `SettingsStore` — obserwowany worek ustawień.
 *
 * DWA WEJŚCIA, DWIE SEMANTYKI:
 *  • `settings` — głębokie proxy. KAŻDA mutacja (także zagnieżdżona, także `delete`)
 *    planuje zapis CAŁEGO pliku z debounce.
 *  • `raw` — surowy worek, z pominięciem obserwacji. Stan, który NIE jest decyzją usera
 *    (puste kontenery, migracje w RAM), idzie TĘDY. To jest mechanizm reguły „boot nie pisze".
 *
 * PRZYPISANIE TEJ SAMEJ WARTOŚCI NIE PLANUJE ZAPISU.
 */
import { log as globalLog } from '../utils/Logger.js';
import { SETTINGS_SAVE_DEBOUNCE_MS } from './contracts.js';
import { hostWindow, type HostTimer } from '../utils/hostWindow.js';
import type {
    LoggerLike,
    SettingsBag,
    SettingsOwner,
    SettingsStoreOptions,
    Unsubscribe,
} from './contracts.js';

/** Zapisywalny widok worka — dane z dysku są `unknown`, więc każdy dostęp idzie przez ten alias. */
type Worek = Record<string, unknown>;

export class SettingsStore {
    // `declare` = sama deklaracja typu, zero emitu.
    declare private _raw: SettingsBag;
    declare private _proxy: SettingsBag;
    declare private _timer: HostTimer | null;
    declare private _delay: number;
    declare private _owner: SettingsOwner;
    declare private _saveOverride: ((settings: SettingsBag) => Promise<void> | void) | undefined;
    declare private _loadOverride: (() => Promise<SettingsBag> | SettingsBag) | undefined;
    declare private _log: LoggerLike;
    declare private _listeners: Set<(settings: SettingsBag) => void>;
    /** proxy → obserwowany obiekt (rozpakowanie, żeby proxy nie wsiąkło do worka). */
    declare private _zrodla: WeakMap<object, Worek>;
    /** obserwowany obiekt → jego proxy (jedna owijka na obiekt, stabilna tożsamość). */
    declare private _owijki: WeakMap<object, object>;

    constructor(owner: SettingsOwner, options: SettingsStoreOptions = {}) {
        this._owner = owner;
        this._delay = options.saveDelayMs ?? SETTINGS_SAVE_DEBOUNCE_MS;
        this._saveOverride = options.save;
        this._loadOverride = options.load;
        this._log = options.log ?? globalLog;
        this._listeners = new Set();
        this._timer = null;
        this._zrodla = new WeakMap();
        this._owijki = new WeakMap();
        this._raw = {};
        this._proxy = this._obserwuj(this._raw) as SettingsBag;
    }

    /** Obserwowane proxy. Mutacja = zaplanowany zapis. */
    get settings(): SettingsBag {
        return this._proxy;
    }

    /**
     * Podmiana CAŁEGO worka (wynik wczytania z dysku). Sama w sobie NIE planuje zapisu —
     * inaczej każdy boot przepisywałby plik z kluczami API.
     */
    set settings(bag: SettingsBag) {
        this._raw = bag ?? {};
        this._owijki = new WeakMap();
        this._zrodla = new WeakMap();
        this._proxy = this._obserwuj(this._raw) as SettingsBag;
    }

    /** Surowy worek. Mutacja NIE planuje zapisu. */
    get raw(): SettingsBag {
        return this._raw;
    }

    /** Uchwyt zaplanowanego zapisu — czytelny z zewnątrz. `null`, gdy nic nie wisi. */
    get pendingSaveTimer(): HostTimer | null {
        return this._timer;
    }

    /** Fabryka wykonująca wczytanie przed zwróceniem gotowego magazynu. */
    static async create(owner: SettingsOwner, options: SettingsStoreOptions = {}): Promise<SettingsStore> {
        const store = new SettingsStore(owner, options);
        await store._wczytaj();
        return store;
    }

    /** Natychmiastowy zapis; sam podaje worek do `saveSettings(settings)`. */
    async save(): Promise<void> {
        this._anuluj();
        const bag = this._raw;
        if (this._saveOverride) await this._saveOverride(bag);
        else await this._owner.saveSettings(bag);
        for (const handler of [...this._listeners]) {
            try {
                handler(bag);
            } catch (e) {
                this._log.error('SettingsStore', 'słuchacz onChange rzucił:', e);
            }
        }
    }

    /** Planuje zapis z debounce; trzy wywołania pod rząd = JEDEN zapis. */
    scheduleSave(): void {
        this._anuluj();
        // Zapis leci z timera, więc jego pad NIE MA jak wrócić do wołacza —
        // musi zostać złapany tutaj, inaczej wychodzi jako unhandled rejection i wywala AVA.
        this._timer = hostWindow.setTimeout(() => {
            this._timer = null;
            void this.save().catch((e: unknown) => {
                this._log.error('SettingsStore', 'zapis ustawień padł:', e);
            });
        }, this._delay);
    }

    /** Subskrypcja na „worek się zmienił" (po zapisie). Zwraca uchwyt odpięcia. */
    onChange(handler: (settings: SettingsBag) => void): Unsubscribe {
        if (typeof handler !== 'function') return () => {};
        this._listeners.add(handler);
        return () => { this._listeners.delete(handler); };
    }

    /** Kasuje zaplanowany zapis (demontaż runtime'u, natychmiastowy zapis). */
    private _anuluj(): void {
        if (this._timer !== null) {
            hostWindow.clearTimeout(this._timer);
            this._timer = null;
        }
    }

    private async _wczytaj(): Promise<void> {
        const zrodlo = this._loadOverride ?? (() => this._owner.loadSettings());
        const bag = await zrodlo();
        this.settings = bag ?? {};
    }

    /**
     * Owija obiekt w proxy planujące zapis. Owijki są cache'owane per obiekt, więc
     * `store.settings.a === store.settings.a` i porównania tożsamości u konsumentów działają.
     */
    private _obserwuj(cel: Worek): object {
        const gotowa = this._owijki.get(cel);
        if (gotowa) return gotowa;

        const proxy = new Proxy(cel, {
            get: (target, prop, receiver) => {
                const wartosc = Reflect.get(target, prop, receiver) as unknown;
                if (typeof prop === 'symbol') return wartosc;
                // Zagnieżdżone worki też muszą być obserwowane — inaczej `settings.a.b = 1`
                // omijałoby zapis.
                if (this._obserwowalny(wartosc)) return this._obserwuj(wartosc as Worek);
                return wartosc;
            },
            set: (target, prop, wartosc: unknown) => {
                const naga = this._rozpakuj(wartosc);
                // Mostek klucza w harnessie wstrzykuje IDENTYCZNĄ wartość i liczy na ciszę:
                // przypisanie no-op nie ma prawa planować zapisu CAŁEGO pliku.
                if (Object.prototype.hasOwnProperty.call(target, prop)
                    && Object.is(target[prop as string], naga)) {
                    return true;
                }
                const ok = Reflect.set(target, prop, naga);
                if (ok) this.scheduleSave();
                return ok;
            },
            deleteProperty: (target, prop) => {
                if (!Object.prototype.hasOwnProperty.call(target, prop)) return true;
                const ok = Reflect.deleteProperty(target, prop);
                if (ok) this.scheduleSave();
                return ok;
            },
        });

        this._owijki.set(cel, proxy);
        this._zrodla.set(proxy, cel);
        return proxy;
    }

    /** Obserwujemy zwykłe worki i tablice; instancje klas (modele, klienci) zostawiamy w spokoju. */
    private _obserwowalny(wartosc: unknown): boolean {
        if (wartosc === null || typeof wartosc !== 'object') return false;
        if (Array.isArray(wartosc)) return true;
        const proto = Object.getPrototypeOf(wartosc) as object | null;
        return proto === Object.prototype || proto === null;
    }

    /** Wartość przyszła przez proxy (`a.x = b.y`) — do worka wkładamy obiekt, nie owijkę. */
    private _rozpakuj(wartosc: unknown): unknown {
        if (wartosc === null || typeof wartosc !== 'object') return wartosc;
        return this._zrodla.get(wartosc) ?? wartosc;
    }
}
