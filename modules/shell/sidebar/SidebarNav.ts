/**
 * SidebarNav - Stack-based navigation controller for the Agent Sidebar.
 * Manages view stack with push/pop and renders views inline.
 */
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';

// TS-any: Obsidian augments HTMLElement with createDiv/empty/addClass at runtime.
type Runtime = any;
type ViewEntry = { viewId: string; params: Runtime; title: string; scrollTop: number };
type ViewRenderer = (container: Runtime, plugin: Runtime, nav: SidebarNav, params: Runtime) => void;

export class SidebarNav {
    declare containerEl: Runtime;
    declare plugin: Runtime;
    declare stack: ViewEntry[];
    declare viewRenderers: Record<string, ViewRenderer>;
    declare _currentCleanup: (() => void) | null;
    declare _rendering: boolean;
    /**
     * @param {HTMLElement} containerEl - The sidebar content container
     * @param {Object} plugin - PKM Assistant plugin instance
     */
    constructor(containerEl: Runtime, plugin: Runtime) {
        this.containerEl = containerEl;
        this.plugin = plugin;
        this.stack = [];
        this.viewRenderers = {};
        this._currentCleanup = null;
        this._rendering = false;
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
    push(viewId: string, params: Runtime = {}, title = ''): void {
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
    replace(viewId: string, params: Runtime = {}, title = ''): void {
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
     * Demontaż nawigacji (AUD-bledy-045) — wołane z `AgentSidebar.onClose()`.
     *
     * Widoki wieszają swoje sprzątanie na `_currentCleanup` (Komunikator: odsubskrybowanie
     * `agentManager.on(...)` + `clearTimeout` budzika renderu). Do naprawy ten uchwyt wołał
     * WYŁĄCZNIE `_render()` przy przejściu na inny widok, więc zamknięcie panelu zostawiało
     * nasłuch na zawsze — a ponowne otwarcie tworzyło NOWY `SidebarNav`. Sprzątanie widoku
     * nie może wywrócić zamykania panelu, stąd try/catch.
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
     * K7/AUD-code-review-042: `_rendering` MUSI wrócić do `false`, cokolwiek się stanie w środku —
     * cały ciało leci w `try/finally`. Wcześniej flaga była zdejmowana tylko w ostatniej linii,
     * więc wyjątek z cudzego `_currentCleanup()` albo `renderFn()` zostawiał ją na `true` NA STAŁE
     * (wszystkie wejścia nawigacji zaczynają się od `if (this._rendering) return;`) i zamrażał
     * cały panel do zamknięcia i ponownego otwarcia sidebara. Oba cudze wywołania mają teraz
     * własny `try/catch` — wzór z `dispose()` (ten sam plik) i gałęzi `sidebar.unknown_view` niżej.
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

            // Render the view
            const renderFn = this.viewRenderers[current.viewId];
            if (renderFn) {
                try {
                    renderFn(content, this.plugin, this, current.params);
                } catch (e) {
                    log.warn('SidebarNav', `render widoku '${current.viewId}' padł:`, e);
                    content.empty();
                    content.createEl('p', {
                        text: t('sidebar.render_error'),
                        cls: 'agent-error'
                    });
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
