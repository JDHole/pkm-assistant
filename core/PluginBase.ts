/**
 * `PluginBase` — baza klasy pluginu (`extends Plugin` Obsidiana).
 * Composition root (`src/main.ts`) dziedziczy po niej i nadpisuje gettery.
 *
 * KONTRAKT NAZW: wszystkie metody i pola w `camelCase`.
 *
 * ⚠️ Plik dotyka `obsidian` jako WARTOŚCI — NIE wchodzi do barrela `core/index.ts`
 * (kontrakt node-safe K-01/K-03). Deep-importuje go wyłącznie composition root.
 */
import { Plugin } from 'obsidian';

import { log } from './utils/Logger.js';
import { openNote as openNoteInWorkspace } from './utils/obsidianNav.js';
import { CHAT_VIEW_TYPE } from './utils/viewTypes.js';
import { NOTICE_DEFAULT_TIMEOUT_MS } from './runtime/contracts.js';
import type { PluginRuntime } from './runtime/PluginRuntime.js';
import type { NoticeCenter } from './runtime/NoticeCenter.js';
import type {
    CommandDef,
    CrystalNoticeOptions,
    ItemViewMap,
    NoticeHandle,
    PluginSettingsTabClass,
    PluginVersionData,
    RibbonIconDef,
    RuntimeConfig,
    SettingsBag,
} from './runtime/contracts.js';

export type {
    CommandDef,
    CrystalNoticeOptions,
    ItemViewMap,
    PluginApi,
    PluginVersionData,
    RibbonIconDef,
} from './runtime/contracts.js';

const SCOPE = 'PluginBase';

/** Nazwa pliku, do którego dopisuje {@link PluginBase.addToGitignore}. */
const GITIGNORE_PATH = '.gitignore';

/** Zmienna CSS niosąca kolor usera (C-2). */
const USER_COLOR_VAR = '--cs-user-color';

/** Zmienna CSS niosąca kolor agenta w powiadomieniu (D.5). */
const AGENT_COLOR_VAR = '--cs-notice-agent-color';

/** Klasa bazowa powiadomienia w skórze pluginu (D.5). */
const CRYSTAL_NOTICE_CLASS = 'cs-notice';

/**
 * Kształty kolorów, które wolno wpuścić do zmiennej CSS: hex, `rgb()`/`hsl()`, nazwa CSS
 * albo `var(--…)`. Bramka jest wąska świadomie — wartość idzie do arkusza stylów, więc
 * wpuszczamy tylko to, co da się nazwać kolorem.
 */
const COLOR_SHAPE = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([^()]{1,64}\)|var\(--[a-z0-9-]{1,64}\)|[a-z]{3,24})$/i;

/** Workspace w zakresie, jakiego dotyka {@link PluginBase.openChatView}. */
interface ChatWorkspace {
    getLeavesOfType(type: string): unknown[];
    revealLeaf(leaf: unknown): void;
    getRightLeaf(split: boolean): { setViewState(state: Record<string, unknown>): unknown } | null;
    rightSplit?: { collapsed?: boolean; toggle(): void } | null;
}

/**
 * Porównanie wersji `X.Y.Z` segment po segmencie, NUMERYCZNIE (`1.10.0` > `1.9.5`).
 * Sufiks pre-release jest odcinany — plugin nie wydaje wersji roboczych userom.
 *
 * @returns < 0 gdy `a` starsze, 0 gdy równe, > 0 gdy `a` nowsze.
 */
function compareVersions(a: string, b: string): number {
    const parts = (v: string): number[] =>
        String(v ?? '').split('-')[0].split('.').map(seg => Number.parseInt(seg, 10) || 0);
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export abstract class PluginBase extends Plugin {
    /**
     * Runtime. Pole ZAPISYWALNE: ustawia je composition root w `onload()`
     * (`this.env = new PluginRuntime(this, this.runtimeConfig)`).
     */
    declare env: PluginRuntime | null;

    /**
     * C-02/C-03: konfiguracja runtime'u zbudowana w KONSTRUKTORZE pluginu.
     * `onload()` przekazuje TĘ SAMĄ referencję konstruktorowi runtime'u.
     *
     * Odstępstwo od kontraktu: pole nie jest `readonly`, bo przypisuje je konstruktor
     * PODKLASY (composition root) — tak samo jak `env`. `PluginApi.runtimeConfig`
     * pozostaje `readonly` (widok modułów).
     */
    declare runtimeConfig: RuntimeConfig;

    /** E-24/E-25: gotowość PEŁNEJ inicjalizacji (nie samego runtime'u). */
    declare _ready: boolean;

    /**
     * PL-08: wąskie wejście dla modułów. NIGDY `undefined`.
     *
     * Pole, nie akcesor: `Plugin` Obsidiana deklaruje `settings?: unknown` jako WŁASNOŚĆ,
     * a TS nie pozwala nadpisać własności akcesorem (TS2611). Implementacja podstawia tu
     * widok worka runtime'u — akcesorem doklejonym do PROTOTYPU pod klasą (na dole pliku),
     * a nie w konstruktorze: `plugin.settings` musi działać także na egzemplarzu zbudowanym
     * bez konstruktora.
     */
    declare settings: SettingsBag;

    /** Kolejka `onReady` (E-25). Powstaje leniwie — konstruktor podklasy może jej nie ruszyć. */
    private _readyQueue?: Array<() => void>;

    /** Skrót na `env.notices` (N-01). */
    get notices(): NoticeCenter | null {
        return this.env?.notices ?? null;
    }

    /** PL-02: mapa nazwa→klasa widoku. */
    abstract get itemViews(): ItemViewMap;

    /**
     * PL-03: komendy bazowe. Podklasa rozszerza je przez `...super.commands`, więc
     * getter jest KONKRETNY, nie `abstract` (odstępstwo od kontraktu wymuszone
     * przez `super` — do abstrakcyjnego akcesora nie da się sięgnąć przez `super`).
     *
     * Baza nie wnosi własnych komend: komenda „otwórz" powstaje przy REJESTRACJI widoku
     * (V-02), a reszta należy do composition roota.
     */
    get commands(): Record<string, CommandDef> {
        return {};
    }

    /** PL-04: ikony wstążki. Kolejność w mapie = kolejność ikon na pasku. */
    abstract get ribbonIcons(): Record<string, RibbonIconDef>;

    /** Klasa zakładki ustawień. */
    abstract get settingsTabClass(): PluginSettingsTabClass;

    /** E-17: MUSI biec w `onload()` — Obsidian odtwarza zapisane zakładki przy layoutReady. */
    registerItemViews(): void {
        for (const [name, ViewClass] of Object.entries(this.itemViews ?? {})) {
            try {
                ViewClass.register(this as never);
            } catch (e) {
                // Wywrotka jednego widoku nie ma prawa zabrać pozostałych — user straciłby
                // czat przez błąd w widoku notatek wydania.
                log.error(SCOPE, `Nie udało się zarejestrować widoku "${name}"`, e);
            }
        }
    }

    /** E-18/E-19: w `onload()`, PO `setLocale()`. */
    registerCommands(): void {
        for (const [slug, command] of Object.entries(this.commands ?? {})) {
            try {
                this.addCommand({
                    id: command.id,
                    name: command.name,
                    callback: () => { void command.callback(); },
                });
            } catch (e) {
                log.error(SCOPE, `Nie udało się zarejestrować komendy "${slug}"`, e);
            }
        }
    }

    registerRibbonIcons(): void {
        for (const [slug, icon] of Object.entries(this.ribbonIcons ?? {})) {
            try {
                this.addRibbonIcon(icon.iconName, icon.description, () => { void icon.callback(); });
            } catch (e) {
                log.error(SCOPE, `Nie udało się zarejestrować ikony wstążki "${slug}"`, e);
            }
        }
    }

    /**
     * PL-05: powitanie jednorazowe; stoi na `PluginVersionData`.
     *
     * Pierwszy start STEMPLUJE `installed_at` — bez tego każde uruchomienie wyglądałoby
     * jak pierwsze. Nazwa pola jest zamrożona (BR-1/Y-4), fixture harnessu na niej stoi.
     */
    async isNewUser(): Promise<boolean> {
        const data = await this._readVersionData();
        if (typeof data.installed_at === 'number' && data.installed_at > 0) return false;
        await this._writeVersionData({ ...data, installed_at: Date.now() });
        return true;
    }

    /**
     * PL-06: para sterująca modalem „co nowego".
     *
     * `true` gdy user nie widział jeszcze notatek TEJ wersji. Brak `last_version` = pierwsza
     * instalacja, więc też `true`. Cofnięcie wersji (wersja starsza niż zapamiętana) NIE jest
     * „nową wersją" — user te notatki już widział.
     */
    async isNewPluginVersion(version: string): Promise<boolean> {
        const data = await this._readVersionData();
        const last = typeof data.last_version === 'string' ? data.last_version.trim() : '';
        if (!last) return true;
        return compareVersions(version, last) > 0;
    }

    /** BR-1: dopisuje WYŁĄCZNIE `last_version` — `installed_at` zostaje nietknięte. */
    async setLastKnownVersion(version: string): Promise<void> {
        const data = await this._readVersionData();
        await this._writeVersionData({ ...data, last_version: version });
    }

    /** E-25: odpala natychmiast, gdy już gotowe; inaczej kolejkuje. */
    onReady(callback: () => void): void {
        if (typeof callback !== 'function') return;
        if (this._ready) {
            this._runReadyCallback(callback);
            return;
        }
        (this._readyQueue ??= []).push(callback);
    }

    waitForReady(): Promise<void> {
        if (this._ready) return Promise.resolve();
        return new Promise<void>(resolve => { (this._readyQueue ??= []).push(resolve); });
    }

    /**
     * Podnosi flagę gotowości i opróżnia kolejkę. Woła to inicjalizacja composition roota —
     * jedyne miejsce, które wie, że plugin jest naprawdę złożony.
     */
    protected notifyReady(): void {
        this._ready = true;
        const queue = this._readyQueue ?? [];
        this._readyQueue = [];
        for (const callback of queue) this._runReadyCallback(callback);
    }

    /** Wywrotka jednego konsumenta nie ma prawa zabrać pozostałych (E-25). */
    private _runReadyCallback(callback: () => void): void {
        try {
            callback();
        } catch (e) {
            log.error(SCOPE, 'Konsument onReady rzucił wyjątkiem', e);
        }
    }

    /**
     * N-05/C-1: own-code powiadomienie w stylu skina.
     *
     * Treść i cykl życia należą do centrum powiadomień (dzięki temu działa wyciszanie
     * i zamknięcie wszystkiego przy unload); ten kod dokłada WYŁĄCZNIE warstwę wyglądu:
     * klasę skina, wariant kolorystyczny z `type` i kolor agenta z `agentColor`.
     */
    showCrystalNotice(message: string, options: CrystalNoticeOptions = {}): NoticeHandle | null {
        const center = this.notices;
        if (!center) {
            log.debug(SCOPE, `Brak centrum powiadomień — pomijam: ${message}`);
            return null;
        }
        const handle = center.show(message, {
            timeout: typeof options.timeout === 'number' ? options.timeout : NOTICE_DEFAULT_TIMEOUT_MS,
        });
        if (handle) this._dressNotice(handle, options);
        return handle;
    }

    /**
     * Ubiera powiadomienie w skórę pluginu (klasy CSS z arkusza: `cs-notice`,
     * `cs-notice__body--<wariant>`, zmienna `--cs-notice-agent-color`).
     *
     * Element bierzemy z uchwytu, jeśli centrum go wystawia — nie jest to część kontraktu
     * uchwytu, więc brak elementu jest normalną sytuacją, a nie błędem: powiadomienie
     * zostaje wtedy w wyglądzie natywnym Obsidiana. Treści NIE przebudowujemy — centrum
     * dokleja do niej własne guziki (wyciszenie, akcje) i przemalowanie by je zdjęło.
     */
    private _dressNotice(handle: NoticeHandle, options: CrystalNoticeOptions): void {
        const host = (handle as { containerEl?: HTMLElement }).containerEl;
        if (!host) return;

        host.classList.add(CRYSTAL_NOTICE_CLASS);

        const variant = options.type ?? 'info';
        if (variant !== 'info') {
            const body = host.querySelector<HTMLElement>(`.${CRYSTAL_NOTICE_CLASS}__body`) ?? host;
            body.classList.add(`${CRYSTAL_NOTICE_CLASS}__body--${variant}`);
        }

        const accent = String(options.agentColor ?? '').trim();
        // Zmienna dziedziczy w dół, więc ustawiona na kontenerze zadziała także wtedy,
        // gdy kolorowany element powstanie później.
        if (accent && COLOR_SHAPE.test(accent)) host.style.setProperty(AGENT_COLOR_VAR, accent);
    }

    /** C-2: ustawia kolor usera jako zmienną CSS. */
    applyUserColor(hex?: string): void {
        const raw = typeof hex === 'string' && hex.trim()
            ? hex.trim()
            : String(this.settings?.pkmAssistant?.userColor ?? '').trim();
        // `typeof` zamiast `globalThis`/`window`: metoda bywa wołana w harnessie, gdzie DOM-u nie ma.
        const body = typeof document === 'undefined' ? null : document.body;
        if (!body) return;
        if (!raw) {
            body.style.removeProperty(USER_COLOR_VAR);
            return;
        }
        if (!COLOR_SHAPE.test(raw)) {
            log.warn(SCOPE, `Kolor usera odrzucony — nie wygląda na kolor: ${raw}`);
            return;
        }
        body.style.setProperty(USER_COLOR_VAR, raw);
    }

    /**
     * PL-09: dopisuje TYLKO brakujące wpisy; no-op gdy nie ma pliku. Idempotentne.
     *
     * „Czy plik jest?" sprawdzamy PRÓBĄ ODCZYTU, nie `exists()` — a brak pliku znaczy
     * „user nie prowadzi vaulta w gicie", więc niczego nie tworzymy.
     */
    async addToGitignore(entry: string, message: string | null = null): Promise<void> {
        const wanted = String(entry ?? '').trim();
        const adapter = this.app?.vault?.adapter;
        if (!wanted || !adapter) return;

        let content: string;
        try {
            content = await adapter.read(GITIGNORE_PATH);
        } catch {
            log.debug(SCOPE, 'Vault nie ma .gitignore — nie zakładam go od siebie');
            return;
        }

        const alreadyThere = content
            .split(/\r?\n/)
            .some(line => line.trim() === wanted);
        if (alreadyThere) return;

        const lead = content.length === 0 || content.endsWith('\n') ? '' : '\n';
        const block = message ? `${lead}\n# ${message}\n${wanted}\n` : `${lead}${wanted}\n`;
        try {
            if (typeof adapter.append === 'function') await adapter.append(GITIGNORE_PATH, block);
            else await adapter.write(GITIGNORE_PATH, content + block);
        } catch (e) {
            log.warn(SCOPE, `Nie udało się dopisać "${wanted}" do .gitignore`, e);
        }
    }

    /** PL-10: otwarcie notatki z obsługą modyfikatorów. */
    openNote(path: string, event?: unknown): Promise<void> {
        return openNoteInWorkspace(this.app as never, path, event);
    }

    /**
     * C-3: otwiera (albo ujawnia) widok czatu.
     *
     * Czat mieszka w prawym panelu, więc otwarcie idzie inną drogą niż bazowe
     * `PluginItemView.open` (nowa karta w głównym obszarze).
     */
    openChatView(): void {
        const workspace = this.app?.workspace as unknown as ChatWorkspace | undefined;
        if (!workspace) return;

        const open = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
        if (open.length > 0) {
            workspace.revealLeaf(open[0]);
        } else {
            const leaf = workspace.getRightLeaf(false);
            if (!leaf) return log.debug(SCOPE, 'Workspace nie dał prawego liścia — czat nieotwarty');
            void leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
        }
        if (workspace.rightSplit?.collapsed) workspace.rightSplit.toggle();
    }


    /** `data.json` pluginu — WYŁĄCZNIE wersjonowanie (S-19). */
    private async _readVersionData(): Promise<PluginVersionData> {
        try {
            const data = await this.loadData() as PluginVersionData | null;
            return data && typeof data === 'object' ? data : {};
        } catch (e) {
            log.warn(SCOPE, 'Nie udało się odczytać data.json — zakładam pusty', e);
            return {};
        }
    }

    private async _writeVersionData(data: PluginVersionData): Promise<void> {
        try {
            await this.saveData(data);
        } catch (e) {
            log.error(SCOPE, 'Nie udało się zapisać data.json', e);
        }
    }
}

// PL-08: akcesor na PROTOTYPIE, bo `Plugin.settings` jest w typach Obsidiana WŁASNOŚCIĄ
// (TS2611 blokuje `get settings()` w ciele klasy). Definicja poza klasą omija sprawdzenie
// typów, a runtime dostaje dokładnie to, co obiecuje kontrakt: worek, nigdy `undefined`.
Object.defineProperty(PluginBase.prototype, 'settings', {
    configurable: true,
    enumerable: false,
    get(this: PluginBase): SettingsBag {
        return this.env?.settings ?? {};
    },
});
