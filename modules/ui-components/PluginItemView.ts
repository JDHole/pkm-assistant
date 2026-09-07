/**
 * `PluginItemView` — baza widoków workspace'u.
 * Dziedziczą DOKŁADNIE DWIE klasy: widok czatu i widok notatek wydania (V-03).
 *
 * • V-04: widok dostaje `manifest` WŁASNEJ instancji pluginu przez konstruktor.
 * • E-26: `onOpen()` NIE MOŻE blokować na gotowości pluginu (deadlock: Obsidian czeka
 *   na widoki, inicjalizacja na layout) — rysuje placeholder i wraca, resztę robi
 *   przez {@link PluginItemView.whenRuntimeLoaded}.
 * • `renderView` jest OPCJONALNA, NIE `abstract` — widok czatu dostaje ją miksinem.
 */
import { ItemView } from 'obsidian';

import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import type { PluginApi, PluginManifestLike, PluginRuntime } from '../../core/index.js';

export type { PluginItemViewClass } from '../../core/index.js';

const SCOPE = 'PluginItemView';

/** Klasa CSS placeholdera „czekam na gotowość pluginu" (E-26). */
const LOADING_CSS_CLASS = 'pkm-view-loading';

/** Workspace w zakresie, jakiego dotyka otwieranie widoku (V-01/BR-4). */
interface WorkspaceLike {
    getLeaf?(newLeaf?: boolean | 'tab' | 'split' | 'window'): LeafLike | null;
    revealLeaf?(leaf: LeafLike): void;
}

interface LeafLike {
    setViewState(state: { type: string; state?: Record<string, unknown>; active?: boolean }): Promise<unknown>;
}

/**
 * Czego widok potrzebuje od pluginu przy REJESTRACJI. `PluginApi` opisuje powierzchnię
 * dla modułów, a te trzy metody należą do `Plugin` Obsidiana — stąd osobny, wąski kształt.
 */
interface RegistrationHost {
    registerView(type: string, factory: (leaf: unknown) => unknown): void;
    addCommand(command: { id: string; name: string; callback: () => void }): void;
    app?: { workspace?: unknown };
}

/** Statyki tożsamości widoku, których wymaga rejestracja (V-01). */
type ViewIdentity = 'viewType' | 'displayText' | 'iconName';

/**
 * Czyta statykę tożsamości albo rzuca czytelnym błędem.
 *
 * Statyki są w bazie DEKLAROWANE (`declare static`), nie implementowane: gdyby były
 * akcesorami, podklasa nie mogłaby ich podać zwykłym polem (TS2610), a gdyby były polami
 * z wartością — nie mogłaby akcesorem (TS2611). Deklaracja przepuszcza OBIE formy, a cenę
 * (brak wartości w bazie) płacimy tutaj: rzutem zamiast `undefined` w rejestrze Obsidiana.
 */
function requireIdentity(owner: unknown, name: ViewIdentity): string {
    const value = (owner as Record<string, unknown> | null)?.[name];
    if (typeof value !== 'string' || !value) {
        throw new Error(
            `PluginItemView: podklasa musi zadeklarować statyczne \`${name}\` — bez niego Obsidian dostałby widok bez tożsamości`,
        );
    }
    return value;
}

export abstract class PluginItemView extends ItemView {
    declare readonly plugin: PluginApi;
    declare readonly manifest: PluginManifestLike;

    /**
     * Kontener treści widoku — element, w którym podklasa rysuje.
     * ⚠️ Gotowy DOPIERO po `onOpen()` Obsidiana.
     */
    declare readonly container: HTMLElement;

    /** Typ widoku Obsidiana. ⚠️ WARTOŚĆ id się NIE zmienia. */
    declare static readonly viewType: string;

    /** Tytuł zakładki. */
    declare static readonly displayText: string;

    /** Ikona (lucide). */
    declare static readonly iconName: string;

    /**
     * Etykieta komendy „otwórz ten widok". Domyślnie tytuł zakładki — Obsidian sam doklei
     * przed nią nazwę pluginu, więc nazwa NIE może jej powtarzać.
     */
    static get commandName(): string {
        return requireIdentity(this, 'displayText');
    }

    /** V-02: rejestruje widok + komendę „otwórz". */
    static register(plugin: PluginApi): void {
        const type = requireIdentity(this, 'viewType');
        const host = plugin as unknown as RegistrationHost;
        const ViewClass = this as unknown as new (leaf: unknown, plugin: PluginApi) => PluginItemView;

        host.registerView(type, (leaf: unknown) => new ViewClass(leaf, plugin));
        host.addCommand({
            id: `open-${type}`,
            name: this.commandName,
            callback: () => { void this.open(host.app?.workspace); },
        });
    }

    /** V-01/BR-4: otwiera widok; no-op, gdy workspace nie dał liścia. */
    static async open(
        workspace: unknown,
        state?: Record<string, unknown>,
        active = true,
    ): Promise<void> {
        const type = requireIdentity(this, 'viewType');
        const ws = workspace as WorkspaceLike | null | undefined;
        const leaf = typeof ws?.getLeaf === 'function' ? ws.getLeaf('tab') : null;
        if (!leaf) return log.debug(SCOPE, `${type}: workspace nie dał liścia — nie otwieram`);

        await leaf.setViewState({ type, state: state ?? {}, active });
        ws?.revealLeaf?.(leaf);
    }

    constructor(leaf: unknown, plugin: PluginApi) {
        super(leaf as never);
        this.plugin = plugin;
        // V-04: manifest WŁASNEJ instancji pluginu — koniec szukania siebie po id w rejestrze.
        this.manifest = plugin?.manifest;
        // `contentEl` to element treści widoku (`containerEl` niesie jeszcze nagłówek karty).
        this.container = this.contentEl ?? this.containerEl;
    }

    /** Skrót na `plugin.env`. Akcesor, bo runtime powstaje PO konstruktorach widoków. */
    get env(): PluginRuntime | null {
        return this.plugin?.env ?? null;
    }

    getViewType(): string {
        return requireIdentity(this.constructor, 'viewType');
    }

    getDisplayText(): string {
        return requireIdentity(this.constructor, 'displayText');
    }

    getIcon(): string {
        return requireIdentity(this.constructor, 'iconName');
    }

    /**
     * E-26: Obsidian czeka na widoki, a inicjalizacja pluginu czeka na layout — więc ta
     * metoda ma prawo tylko postawić placeholder i wrócić. Dokończenie wisi na `onReady`.
     */
    async onOpen(): Promise<void> {
        if (typeof this.renderView !== 'function') return;

        if (this.plugin?._ready) {
            await this.renderView();
            return;
        }

        this.container.empty();
        this.container.createDiv({ cls: LOADING_CSS_CLASS, text: t('main.loading') });
        this.plugin?.onReady?.(() => {
            this.container.empty();
            void Promise.resolve(this.renderView?.()).catch(e =>
                log.error(SCOPE, `${this.getViewType()}: render po gotowości pluginu padł`, e));
        });
    }

    /** E-26: cukier na `plugin.env?.whenLoaded()` z obsługą braku runtime'u. */
    async whenRuntimeLoaded(): Promise<void> {
        const runtime = this.env;
        if (!runtime) {
            log.debug(SCOPE, `${this.getViewType()}: brak runtime'u — nie ma na co czekać`);
            return;
        }
        await runtime.whenLoaded();
    }

    /** Punkt rozszerzenia podklasy. OPCJONALNA — widok czatu dostaje ją miksinem. */
    renderView?(params?: unknown): void | Promise<void>;
}
