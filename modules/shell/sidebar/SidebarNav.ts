/**
 * SidebarNav - Stack-based navigation controller for the Agent Sidebar.
 * Manages view stack with push/pop and renders views inline.
 */
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import type { PluginApi } from '../../../core/index.js';

/**
 * Dane widoku przekazywane przez `push`/`replace` - kształt zależy od widoku
 * (`{}`, `{agentName}`, `{tab}`, ...), więc kontrakt rejestru zna tylko worek kluczy.
 */
export type ViewParams = Record<string, unknown>;
type ViewEntry = { viewId: string; params: ViewParams; title: string; scrollTop: number };
/**
 * Kontrakt renderera widoku. `plugin` zostaje na `PluginApi` (nie zawężamy tu do
 * managera konkretnego modułu) - ten sam typ rejestruje widoki z modules/agents,
 * modules/komunikator i shell, więc renderFn musi się zgadzać z jednym wspólnym kształtem;
 * właściciel widoku zawęża `plugin.<manager>` do realnego typu lokalnie, w swoim pliku.
 * Zwrotka `void | Promise<void>` - `renderSkillDetailView`/`renderSubAgentDetailView`
 * (modules/skills/index.ts, modules/sub-agents/index.ts - leniwe barrel-wrappery) są `async`;
 * goły `void` dawałby `no-misused-promises` przy ich rejestracji w `AgentSidebar.ts`, mimo że
 * `_render()` (`renderFn(content, this.plugin, this, current.params);` niżej) i tak nie czeka na
 * zwrotkę - to zachowanie runtime bez zmian, tylko typ przestaje kłamać.
 */
export type ViewRenderer = (container: HTMLElement, plugin: PluginApi, nav: SidebarNav, params: ViewParams) => void | Promise<void>;

export class SidebarNav {
    declare containerEl: HTMLElement;
    declare plugin: PluginApi;
    declare stack: ViewEntry[];
    declare viewRenderers: Record<string, ViewRenderer>;
    declare _currentCleanup: (() => void) | null;
    declare _rendering: boolean;
    /**
     * Element `.sidebar-view-content` wypuszczony przez OSTATNIE zakończone `_render()` -
     * identyfikator "czy TA konkretna renderka jest jeszcze aktualna" dla `.catch()` async
     * renderera. `this.stack[this.stack.length-1] === current` (wpis stosu) NIE WYSTARCZA:
     * `refresh()` re-renderuje TEN SAM wpis stosu (nie zmienia `this.stack`), więc po
     * `push('x') -> refresh()` odrzucenie ze STAREGO renderu widziałoby ten sam `current` i
     * pisałoby do JUŻ ODPIĘTEGO (`containerEl.empty()` w drugim `_render()`) diva. Tożsamość
     * `content` jest ZAWSZE świeża po każdym `_render()`, refresh czy nie.
     */
    declare _currentContentEl: HTMLElement | null;
    /**
     * @param {HTMLElement} containerEl - The sidebar content container
     * @param {Object} plugin - PKM Assistant plugin instance
     */
    constructor(containerEl: HTMLElement, plugin: PluginApi) {
        this.containerEl = containerEl;
        this.plugin = plugin;
        this.stack = [];
        this.viewRenderers = {};
        this._currentCleanup = null;
        this._rendering = false;
        this._currentContentEl = null;
    }

    /**
     * Register a view render function.
     * @param {string} viewId - Unique view identifier
     * @param {Function} renderFn - (container, plugin, nav, params) => void
     */
    register(viewId: string, renderFn: ViewRenderer): void {
        this.viewRenderers[viewId] = renderFn;
    }

    /**
     * Push a new view onto the stack.
     * @param {string} viewId
     * @param {Object} params - View-specific data
     * @param {string} title - Label shown in back button of this view
     */
    push(viewId: string, params: ViewParams = {}, title = ''): void {
        if (this._rendering) return;
        // Save scroll position of current view
        if (this.stack.length > 0) {
            const scrollArea = this.containerEl.querySelector('.sidebar-view-content');
            if (scrollArea) {
                this.stack[this.stack.length - 1].scrollTop = scrollArea.scrollTop;
            }
        }
        this.stack.push({ viewId, params, title, scrollTop: 0 });
        this._render();
    }

    /**
     * Pop current view and return to previous.
     */
    pop(): void {
        if (this._rendering || this.stack.length <= 1) return;
        this.stack.pop();
        this._render();
    }

    /**
     * Replace current view without growing the stack.
     */
    replace(viewId: string, params: ViewParams = {}, title = ''): void {
        if (this._rendering) return;
        if (this.stack.length > 0) {
            this.stack[this.stack.length - 1] = { viewId, params, title, scrollTop: 0 };
        } else {
            this.stack.push({ viewId, params, title, scrollTop: 0 });
        }
        this._render();
    }

    /**
     * Reset to home view (clear stack except first entry).
     */
    goHome(): void {
        if (this._rendering) return;
        this.stack = this.stack.length > 0 ? [this.stack[0]] : [];
        this._render();
    }

    /**
     * Podmień parametry we WSZYSTKICH wpisach stosu pasujących do predykatu.
     *
     * Po co: parametry wpisu są zamrożone w chwili `push()`. Gdy byt, który wpis adresuje,
     * zmieni tożsamość (agent przemianowany: `{ agentName: 'Agent1' }` → `'Atlas'`), zwykły
     * `refresh()` przerysowuje widok ze STARYM parametrem i user dostaje „Nie znaleziono
     * agenta" - także po cofnięciu się na dowolny głębszy wpis stosu, nie tylko na wierzchu.
     * Dlatego przelot idzie po CAŁYM stosie, nie po jego szczycie.
     *
     * Czysta operacja na tablicy: zero renderu, zero DOM-u. Wołacz sam decyduje, czy po niej
     * odświeżyć widok (`refresh()`), stąd zwrotka z liczbą zmienionych wpisów.
     *
     * @returns liczba podmienionych wpisów (0 = nic do przerysowania)
     */
    updateParams(predicate: (params: ViewParams) => boolean, patch: ViewParams): number {
        let changed = 0;
        for (const entry of this.stack) {
            if (!predicate(entry.params)) continue;
            entry.params = { ...entry.params, ...patch };
            changed++;
        }
        return changed;
    }

    /**
     * Re-render current top-of-stack view.
     */
    refresh(): void {
        if (this._rendering) return;
        this._render();
    }

    /**
     * Get current view ID.
     * @returns {string|null}
     */
    currentView(): string | null {
        return this.stack.length > 0 ? this.stack[this.stack.length - 1].viewId : null;
    }

    /**
     * Demontaż nawigacji - wołane z `AgentSidebar.onClose()`.
     *
     * Widoki wieszają swoje sprzątanie na `_currentCleanup` (Komunikator: odsubskrybowanie
     * `agentManager.on(...)` + `clearTimeout` budzika renderu). Ten uchwyt MUSI zostać wywołany
     * tutaj explicite - samo wołanie `_render()` przy przejściu na inny widok nie wystarcza,
     * inaczej zamknięcie panelu zostawiłoby nasłuch na zawsze (a ponowne otwarcie tworzy NOWY
     * `SidebarNav`). Sprzątanie widoku nie może wywrócić zamykania panelu, stąd try/catch.
     */
    dispose(): void {
        const cleanup = this._currentCleanup;
        this._currentCleanup = null;
        if (!cleanup) return;
        try {
            cleanup();
        } catch (e) {
            log.warn('SidebarNav', 'sprzątanie widoku padło (zamykanie panelu leci dalej):', e);
        }
    }

    /**
     * @private
     *
     * `_rendering` MUSI wrócić do `false`, cokolwiek się stanie w środku - cały ciało leci w
     * `try/finally`. Gdyby flaga była zdejmowana tylko w ostatniej linii, wyjątek z cudzego
     * `_currentCleanup()` albo `renderFn()` zostawiłby ją na `true` NA STAŁE (wszystkie wejścia
     * nawigacji zaczynają się od `if (this._rendering) return;`) i zamroziłby cały panel do
     * zamknięcia i ponownego otwarcia sidebara. Oba cudze wywołania mają własny `try/catch` -
     * wzór z `dispose()` (ten sam plik) i gałęzi `sidebar.unknown_view` niżej.
     */
    _render(): void {
        this._rendering = true;
        try {
            // Cleanup previous view's subscriptions
            if (this._currentCleanup) {
                const cleanup = this._currentCleanup;
                this._currentCleanup = null;
                try {
                    cleanup();
                } catch (e) {
                    log.warn('SidebarNav', 'sprzątanie poprzedniego widoku padło (render leci dalej):', e);
                }
            }

            this.containerEl.empty();
            this.containerEl.addClass('agent-sidebar');

            const current = this.stack[this.stack.length - 1];
            if (!current) return;

            // Back button (if not home)
            if (this.stack.length > 1) {
                const prev = this.stack[this.stack.length - 2];
                const backBar = this.containerEl.createDiv({ cls: 'sidebar-nav-back' });
                const backBtn = backBar.createEl('button', {
                    cls: 'sidebar-back-btn',
                    text: `← ${prev.title || t('sidebar.back')}`
                });
                backBtn.addEventListener('click', () => this.pop());
            }

            // View content area (scrollable)
            const content = this.containerEl.createDiv({ cls: 'sidebar-view-content' });
            // Znacznik "ten `content` jest jeszcze aktualny" dla `.catch()` async renderera
            // niżej - PORÓWNANIE PO WPISIE STOSU (`current`) NIE WYSTARCZA, bo `refresh()`
            // re-renderuje TEN SAM wpis (nowy `content`, ten sam `current`).
            this._currentContentEl = content;

            // Render the view
            const renderFn = this.viewRenderers[current.viewId];
            if (renderFn) {
                const showRenderError = (e: unknown, when: string) => {
                    log.warn('SidebarNav', `render widoku '${current.viewId}' padł (${when}):`, e);
                    // Nawigacja ODESZŁA z tej renderki, zanim odrzucenie async renderera dotarło
                    // (`_render()` jest synchroniczne, `.catch` niżej nie) - nie nadpisuj treści
                    // widoku, na którym user już jest. Tożsamość `content` (nie wpisu stosu -
                    // `refresh()` zostawia TEN SAM `current`, ale tworzy NOWY `content`).
                    if (this._currentContentEl !== content) return;
                    content.empty();
                    content.createEl('p', {
                        text: t('sidebar.render_error'),
                        cls: 'agent-error'
                    });
                };
                try {
                    // `ViewRenderer` dopuszcza `Promise<void>` (dwa renderery są `async`) - nie
                    // czekamy na nią (`_render()` zostaje synchroniczne, zero zmiany momentu
                    // powrotu), ale JEJ ODRZUCENIE ma trafić do TEGO SAMEGO `render_error` co
                    // throw synchroniczny, zamiast uciec jako unhandled rejection.
                    const result = renderFn(content, this.plugin, this, current.params);
                    if (result && typeof result.then === 'function') {
                        result.catch((e: unknown) => showRenderError(e, 'async'));
                    }
                } catch (e) {
                    showRenderError(e, 'sync');
                }
            } else {
                content.createEl('p', {
                    text: t('sidebar.unknown_view', { viewId: current.viewId }),
                    cls: 'agent-error'
                });
            }

            // Restore scroll position
            if (current.scrollTop > 0) {
                window.requestAnimationFrame(() => {
                    content.scrollTop = current.scrollTop;
                });
            }
        } finally {
            this._rendering = false;
        }
    }
}
