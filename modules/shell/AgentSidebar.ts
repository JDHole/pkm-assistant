/**
 * AgentSidebar - Rich panel for managing agents.
 * Thin shell: initializes SidebarNav and registers all views.
 * All rendering logic is in modules/shell/sidebar/ modules.
 */
import { ItemView } from 'obsidian';
import type { WorkspaceLeaf, View, App } from 'obsidian';
import { t } from '../../core/i18n/index.js';
import agent_sidebar_styles from './AgentSidebar.css' with { type: 'css' };
import sidebar_view_styles from './sidebar/SidebarViews.css' with { type: 'css' };
import { SidebarNav } from './sidebar/SidebarNav.js';
import type { ViewRenderer } from './sidebar/SidebarNav.js';
import { renderHomeView } from './sidebar/HomeView.js';
import { renderAgentProfileView } from '../../modules/agents/index.js';
import type { AgentManager } from '../../modules/agents/index.js';
import { renderCommunicatorView } from '../../modules/komunikator/index.js';
import { renderZapleczeView } from './sidebar/BackstageViews.js';
import { renderSkillDetailView, renderSubAgentDetailView } from './sidebar/DetailViews.js';
import { renderTriggersView } from './sidebar/TriggersView.js';
import { SkinManager, adoptSheet } from '../crystal-soul/index.js';
import type { PluginApi } from '../../core/index.js';

/**
 * Plugin widziany przez sidebar: `agentManager` ponad bazowy `PluginApi`, plus `registerView`
 * (prawdziwa metoda Obsidian `Plugin`, spoza `PluginApi` - moduły nie rejestrują widoków,
 * robi to composition root; sidebar jest wyjątkiem, bo SAM jest widokiem).
 */
interface AgentSidebarPlugin extends PluginApi {
    agentManager?: AgentManager;
    registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => View): void;
}

export const AGENT_SIDEBAR_VIEW_TYPE = 'pkm-agent-sidebar';

export class AgentSidebar extends ItemView {
    declare private plugin: AgentSidebarPlugin;
    declare private unsubscribe: (() => void) | null;
    // `number`, nie `ReturnType<typeof window.setTimeout>` - z `@types/node` w tym samym projekcie
    // (harness/testy), `globalThis`/`window` mieszają przeciążenia Node+DOM i ReturnType<> łapie
    // wtedy `NodeJS.Timeout` zamiast liczby, którą naprawdę zwraca `window.setTimeout` w Obsidianie.
    declare private _renderTimer: number | null;
    declare private nav: SidebarNav | null;
    declare private _unsubscribeSkinEvents: (() => void) | null;

    constructor(leaf: WorkspaceLeaf, plugin: AgentSidebarPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.unsubscribe = null;
        this._renderTimer = null;
        this.nav = null;
    }

    getViewType() {
        return AGENT_SIDEBAR_VIEW_TYPE;
    }

    getDisplayText() {
        // obsidianmd/ui/sentence-case: 'PKM' zostaje (skrót nazwy pluginu, jak 'PKM Assistant'
        // gdzie indziej), 'agents' schodzi na małą - sam ESLint proponowałby 'Pkm agents',
        // co psułoby markę.
        return 'PKM agents';
    }

    getIcon() {
        return 'users';
    }

    async onOpen() {
        // Adopt CSS (fix: was imported but never applied) przez `adoptSheet`,
        // żeby `onunload` miał co zdjąć - arkusze zostawałyby w dokumencie po wyłączeniu pluginu.
        adoptSheet(agent_sidebar_styles);
        adoptSheet(sidebar_view_styles);

        const container = this.containerEl.children[1] as HTMLElement;

        // If plugin not ready yet, show loading placeholder, DON'T block onOpen
        // (blocking onOpen causes deadlock: Obsidian waits for views, initialize() waits for layout)
        if (!this.plugin._ready) {
            const loadingDiv = container.createDiv({ cls: 'pkm-sidebar-loading cs-root' });
            // Static layout in styles.css; only the skin accent colour stays inline (dynamic).
            loadingDiv.createDiv({ cls: 'cs-breathing pkm-sidebar-loading__diamond', text: '◆' })
                .style.color = SkinManager.getColor('accent', 'var(--interactive-accent)');
            loadingDiv.createDiv({ cls: 'pkm-sidebar-loading__label', text: t('generic.loading') });

            // Non-blocking: register callback and return immediately
            this.plugin.onReady(() => {
                loadingDiv.remove();
                this._initSidebar(container);
            });
            return;
        }

        this._initSidebar(container);
    }

    _initSidebar(container: HTMLElement): void {
        // Initialize navigation
        this.nav = new SidebarNav(container, this.plugin);
        // `home`/`zaplecze`/`triggers` są shell-owned - `plugin: PluginApi` siedzi wprost w ICH
        // WŁASNEJ sygnaturze (zawężenie do HomeViewPlugin/BackstageViewsPlugin/TriggersViewPlugin
        // przeniesione do wnętrza rendererów, patrz TS-boundary nad każdym z nich), więc rejestracja
        // nie potrzebuje castu.
        this.nav.register('home', renderHomeView);
        // TS-boundary: `agent-profile`/`communicator`/`skill-detail`/`sub-agent-detail` są CUDZE
        // (modules/agents, modules/komunikator, modules/skills, modules/sub-agents) - każdy ma
        // WŁASNY, węższy typ pluginu (np. `AgentsPlugin`/`CommunicatorPlugin`), bo zawęża go do
        // pól, które faktycznie czyta. Sidebar przekazuje KOMPLETNY obiekt pluginu; `ViewRenderer`
        // (`plugin: PluginApi`) nie może być jednocześnie kontrawariantny względem wszystkich tych
        // węższych typów naraz, więc cast w miejscu rejestracji jest jedyną uczciwą granicą.
        this.nav.register('agent-profile', renderAgentProfileView as ViewRenderer);
        this.nav.register('communicator', renderCommunicatorView as ViewRenderer);
        this.nav.register('zaplecze', renderZapleczeView);
        this.nav.register('skill-detail', renderSkillDetailView as ViewRenderer);
        this.nav.register('sub-agent-detail', renderSubAgentDetailView as ViewRenderer);
        this.nav.register('triggers', renderTriggersView);
        // Widoku `sub-agent-runs` już tu nie ma - biegi subów pokazuje pasek w OKNIE CZATU
        // (per agent i per sesja), patrz `modules/chat/chat/subTaskStrip.ts`.

        this.nav.push('home', {}, 'Agenci');
        this._unsubscribeSkinEvents = SkinManager.on('skin_changed', () => this.nav?.refresh?.());

        // Subscribe to agent changes
        if (this.plugin.agentManager) {
            this.unsubscribe = this.plugin.agentManager.on((event: string) => {
                if (['agents:loaded', 'agents:reloaded',
                     'agent:created', 'agent:deleted', 'agent:updated'].includes(event)) {
                    this.nav!.refresh();
                }
                // Communicator events: debounce to prevent duplicate renders
                if (event === 'communicator:message_sent' || event === 'communicator:message_read' || event === 'communicator:project_updated') {
                    if (this._renderTimer) window.clearTimeout(this._renderTimer);
                    this._renderTimer = window.setTimeout(() => {
                        this._renderTimer = null;
                        this.nav!.refresh();
                    }, 200);
                }
            });
        }
    }

    // FLAGGED (nie "wersja czysto typowa" - do przeglądu Fable): `View.onClose()` (obsidian.d.ts)
    // jest `protected onClose(): Promise<void>`; ciało poniżej nie ma `await` (synchroniczne
    // sprzątanie), więc `async` jest tu wyłącznie adnotacją zgodności z bazą - bez `await`
    // efekty uboczne (unsubscribe/dispose/clearTimeout) wykonują się w tym samym ticku co
    // przed zmianą, a wołający i tak `await`-uje zwrotkę. Bez `async` `void` nie satysfakcjonuje
    // kontraktu bazy (TS2416) i nie ma czysto-typowej adnotacji, która by to obeszła (sprawdzone:
    // `Promise<void>` bez `async` daje TS2355 - funkcja musi zwrócić wartość). Ten sam konflikt
    // czeka na `modules/chat/chat_view.ts` (`onClose(): Runtime` - jeszcze niemigrowany).
    async onClose() {
        this._unsubscribeSkinEvents?.();
        this._unsubscribeSkinEvents = null;
        // Sprzątanie BIEŻĄCEGO widoku woła wyłącznie `SidebarNav._render` przy przełączeniu
        // widoku - bez wywołania dispose() tutaj zamknięcie panelu zostawiłoby nasłuch
        // Komunikatora i jego budzik renderu na całą sesję Obsidiana (ponowne otwarcie
        // tworzy NOWY SidebarNav).
        this.nav?.dispose?.();
        if (this.unsubscribe) {
            this.unsubscribe();
        }
        if (this._renderTimer) {
            window.clearTimeout(this._renderTimer);
        }
    }
}

/**
 * Register the sidebar view
 * @param {Plugin} plugin
 */
export function registerAgentSidebar(plugin: AgentSidebarPlugin): void {
    plugin.registerView(
        AGENT_SIDEBAR_VIEW_TYPE,
        (leaf: WorkspaceLeaf) => new AgentSidebar(leaf, plugin)
    );
}

/**
 * Open or reveal the agent sidebar
 * @param {Plugin} plugin
 */
export async function openAgentSidebar(plugin: AgentSidebarPlugin): Promise<void> {
    // TS-boundary: `AppLike` (core, node-safe) nie modeluje `Workspace` - shell już importuje
    // obsidian wprost gdzie indziej (patrz HomeView.ts).
    const { workspace } = plugin.app as unknown as App;

    let leaf: WorkspaceLeaf | null | undefined = workspace.getLeavesOfType(AGENT_SIDEBAR_VIEW_TYPE)[0];

    if (!leaf) {
        leaf = workspace.getRightLeaf(false);
        // zastane: `getRightLeaf` zwraca `WorkspaceLeaf | null`, oryginał nie sprawdzał `null` -
        // naprawa (guard/Notice na brak leafa) byłaby zmianą runtime, poza zakresem tej migracji.
        await leaf!.setViewState({
            type: AGENT_SIDEBAR_VIEW_TYPE,
            active: true
        });
    }

    // zastane: jak wyżej - `leaf` może być `null` gdy oba kroki powyżej go nie dały; oryginał
    // i tak woła `revealLeaf` bez sprawdzenia.
    workspace.revealLeaf(leaf!);
}
