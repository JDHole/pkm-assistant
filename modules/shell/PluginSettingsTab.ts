/**
 * `PluginSettingsTab` — baza zakładki ustawień (V-05..V-07).
 *
 * Szkielet DWÓCH kontenerów: klasy CSS `pkm-settings-header` i `pkm-settings-main`.
 *
 * V-06 DWA STANY EKRANU — decyduje o nich BAZA, w {@link PluginSettingsTab.showScreen}:
 *  • `state !== 'loaded'` → akapit `settings.loading` i czekanie na `runtime.whenLoaded()`;
 *  • `state === 'loaded'` → treść od ręki.
 *
 * ⚠️ NIE MA guzika „uruchom" ani trzeciego stanu — istniały wyłącznie dla stanu `'idle'`
 * (gałąź mobile-defer, skasowana).
 *
 * WEJŚCIE: Obsidian woła WYŁĄCZNIE `display()`; sekcje ustawień odświeżają ekran tą samą
 * metodą (`owner.display()` z kontraktu `SettingsSectionCtx`). Podklasa dostarcza `render()`
 * i sama go z siebie nie odpala — inaczej pominęłaby bramę stanu.
 *
 * V-07: `saveSettings()` zakładki = `runtime.settingsStore.save()`.
 */
import { PluginSettingTab } from 'obsidian';
import type { App } from 'obsidian';

import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import type { PluginApi, PluginRuntime } from '../../core/index.js';

export type { PluginSettingsTabClass } from '../../core/index.js';

const SCOPE = 'PluginSettingsTab';

/** Nagłówek zakładki (tytuł + jednozdaniowy opis). */
const HEADER_CSS_CLASS = 'pkm-settings-header';
/** Główna część zakładki — tu wchodzą sekcje z rejestru. */
const MAIN_CSS_CLASS = 'pkm-settings-main';
/** Akapit „ładuję" — jedyna treść ekranu, dopóki runtime nie wstanie. */
const LOADING_CSS_CLASS = 'pkm-settings-loading';
/** Stan runtime'u, przy którym zakładka rysuje treść bez czekania. */
const READY_STATE = 'loaded';

export abstract class PluginSettingsTab extends PluginSettingTab {
    declare readonly plugin: PluginApi;

    /**
     * Górny pas zakładki (tytuł + opis). Stawia go {@link PluginSettingsTab.prepareLayout}.
     *
     * Pola, nie akcesory: podklasa (`PkmSettingsTab`) przedeklarowuje oba jako własności,
     * a TS nie pozwala nadpisać akcesora własnością (TS2610).
     */
    declare readonly headerContainer: HTMLElement;

    /** Główna część zakładki — tu wchodzą sekcje z rejestru. */
    declare readonly mainContainer: HTMLElement;

    constructor(app: App, plugin: PluginApi) {
        super(app, plugin as never);
        this.plugin = plugin;
    }

    get env(): PluginRuntime | null {
        return this.plugin?.env ?? null;
    }

    /**
     * Stawia szkielet DWÓCH kontenerów.
     *
     * Kontener czyścimy TYLKO wtedy, gdy jest czym go zapełnić — czyli gdy runtime stoi.
     * Bez runtime'u jedyną treścią ekranu jest komunikat „ładuję" postawiony przez `render()`;
     * wytarcie go zamieniłoby czekanie w niemą, pustą zakładkę. Szkielet powstaje mimo to,
     * żeby wołacz zawsze dostał element do rysowania, a nie `undefined`.
     */
    prepareLayout(): void {
        if (this.env) this.containerEl.empty();
        else log.debug(SCOPE, 'Brak runtime\'u — zostawiam na ekranie komunikat „ładuję"');

        const self = this as { headerContainer: HTMLElement; mainContainer: HTMLElement };
        self.headerContainer = this.containerEl.createDiv({ cls: HEADER_CSS_CLASS });
        self.mainContainer = this.containerEl.createDiv({ cls: MAIN_CSS_CLASS });
    }

    /**
     * Wejście Obsidiana w zakładkę — i zarazem odświeżenie, bo sekcje wołają
     * `owner.display()`. Obsidian tej metody nie awaituje, więc pełny przebieg jedzie
     * obok, a jego pad ląduje w logu, nie w nieobsłużonym odrzuceniu obietnicy.
     */
    display(): void {
        void this.showScreen().catch(e => log.error(SCOPE, 'Render zakładki ustawień padł', e));
    }

    /**
     * V-06: brama DWÓCH stanów ekranu. Runtime niegotowy → user widzi akapit „ładuję",
     * a treść czeka na `whenLoaded()`. Runtime gotowy → od razu treść (przy gotowym
     * runtimie `whenLoaded()` kosztuje 0 ms, więc gałąź jest skrótem, nie wymogiem).
     *
     * Brak runtime'u w ogóle traktujemy jak „jeszcze nie wstał": pokazujemy akapit
     * i idziemy dalej, bo nie ma na czym czekać ani czym zapełnić ekranu.
     */
    async showScreen(): Promise<void> {
        const runtime = this.env;
        if (runtime?.state !== READY_STATE) {
            this.showLoading();
            await runtime?.whenLoaded();
        }
        await this.render();
    }

    /** Jedyna treść ekranu na czas czekania na runtime. Wyciera to dopiero `render()`. */
    protected showLoading(): void {
        this.containerEl.empty();
        this.containerEl.createEl('p', { text: t('settings.loading'), cls: LOADING_CSS_CLASS });
    }

    /**
     * Treść zakładki. Woła ją {@link PluginSettingsTab.showScreen} — już PO bramie stanu,
     * więc implementacja może zakładać, że runtime miał swoją szansę wstać.
     */
    abstract render(): Promise<void>;

    /** V-07: zapis idzie JEDNĄ drogą — przez magazyn ustawień runtime'u. */
    async saveSettings(): Promise<void> {
        const store = this.env?.settingsStore;
        if (!store) {
            log.warn(SCOPE, 'Brak magazynu ustawień — zapis pominięty');
            return;
        }
        await store.save();
    }
}
