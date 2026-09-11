/**
 * BackstageViews - unified Zaplecze sidebar view (3 taby).
 *
 * Tab implementations live with their owning modules. This file is a thin
 * coordinator: tab bar + active-tab routing.
 *
 *   modules/skills/SkillsBackstageTab.js          → Szablony skilli
 *   modules/sub-agents/SubAgentsBackstageTab.js   → Szablony subów (+ wbudowany pkm-sub)
 *   modules/tools/ConnectorsBackstageTab.js       → Konektory (info-only)
 *
 * Zakładka „Konektory" jest wyłącznie INFORMACYJNA - pokazuje podłączone serwery MCP,
 * ale nie daje sterowania nimi.
 *
 * Crystal Soul styling - `--cs-user-color` for UI accents,
 * `--cs-category-color-rgb` for per-card category coloring (set inside each tab).
 */
import { BackstageRegistry } from '../BackstageRegistry.js';
import { registerBackstage as registerSkillsBackstage } from '../../skills/index.js';
import { registerBackstage as registerSubAgentsBackstage } from '../../sub-agents/index.js';
import { registerBackstage as registerConnectorsBackstage } from '../../tools/index.js';
import { t } from '../../../core/i18n/index.js';
import { setSvgLabel } from '../../../modules/crystal-soul/index.js';
import type { ExternalMcpManager } from '../../tools/index.js';
import type { PluginApi } from '../../../core/index.js';
import type { SidebarNav, ViewParams } from './SidebarNav.js';

/** `AgentManager.skillTemplateStore`/`.subAgentTemplateStore` - jeszcze nieotypowane pola
 * dynamiczne (migracja modules/agents) - zawężamy do jedynej metody, której tu potrzeba. */
type CountableStore = { count(): number };

/** Plugin widziany przez ten widok: managery agentów i zewnętrznych serwerów MCP. */
interface BackstageViewsPlugin extends PluginApi {
    agentManager?: { skillTemplateStore?: unknown; subAgentTemplateStore?: unknown };
    externalMcpManager?: ExternalMcpManager;
}

/**
 * Liczniki zakładek liczą SZABLONY (Zaplecze = katalog form odlewniczych),
 * a nie żywe byty. Zakładka Konektory liczy PODŁĄCZONE serwery MCP.
 */
function getTabCount(plugin: BackstageViewsPlugin, tabId: string): number {
    switch (tabId) {
        case 'skills':     return (plugin.agentManager?.skillTemplateStore as CountableStore | undefined)?.count() || 0;
        // pkm-sub (wbudowany) zawsze jest na liście, stąd +1 do szablonów.
        case 'sub-agents': return ((plugin.agentManager?.subAgentTemplateStore as CountableStore | undefined)?.count() || 0) + 1;
        case 'connectors': return countConnectedServers(plugin);
        // Backward compat for old tab IDs - redirect to sub-agents
        case 'minions':
        case 'masters':    return ((plugin.agentManager?.subAgentTemplateStore as CountableStore | undefined)?.count() || 0) + 1;
        default: return 0;
    }
}

/** Ile zewnętrznych serwerów MCP jest realnie podłączonych. */
export function countConnectedServers(plugin: BackstageViewsPlugin): number {
    try {
        const servers = plugin?.externalMcpManager?.listServersForUi?.() || [];
        return servers.filter(s => s.connected).length;
    } catch {
        return 0;
    }
}

function registerDefaultBackstageTabs() {
    BackstageRegistry.clear();
    registerSkillsBackstage(BackstageRegistry);
    registerSubAgentsBackstage(BackstageRegistry);
    registerConnectorsBackstage(BackstageRegistry as never);
}

/**
 * Main unified Backstage view - tabs registered by their owning modules.
 *
 * TS-boundary: zarejestrowany w `SidebarNav` (`AgentSidebar.ts`) pod wspólnym `ViewRenderer`
 * (`plugin: PluginApi`) - węższy `BackstageViewsPlugin` zostaje WŁASNOŚCIĄ tej funkcji (zawężenie
 * u źródła wiedzy), rejestracja nie potrzebuje castu. `tab?.render(content, plugin, nav)` niżej
 * bierze `plugin` gołe - `BackstageTab.render` jest generyczne (`(...args: unknown[]) => unknown`,
 * patrz `BackstageRegistry.ts`), nie zawęża.
 */
export function renderZapleczeView(container: HTMLElement, plugin: PluginApi, nav: SidebarNav, params: ViewParams): void {
    container.classList.add('cs-root');
    registerDefaultBackstageTabs();

    // TS-boundary: `params` jest workiem kluczy widoku (SidebarNav.ViewParams); `.tab` zawężamy
    // do tego, co ten widok realnie czyta.
    const requestedTab = (params.tab as string | undefined) || 'skills';
    const activeTab = ['minions', 'masters'].includes(requestedTab) ? 'sub-agents' : requestedTab;
    const tabBar = container.createDiv({ cls: 'cs-profile-tabs cs-zaplecze-tabs' });

    for (const tab of BackstageRegistry.getTabs()) {
        const btn = tabBar.createEl('button', {
            cls: `cs-profile-tab ${tab.id === activeTab ? 'cs-profile-tab--active' : ''}`
        });
        setSvgLabel(btn, tab.iconFn(14), tab.label as string);

        const count = getTabCount(plugin as BackstageViewsPlugin, tab.id);
        if (count > 0) {
            btn.createSpan({ cls: 'cs-zaplecze-tab__count', text: `${count}` });
        }

        btn.addEventListener('click', () => {
            nav.replace('zaplecze', { tab: tab.id }, t('sidebar.backstage'));
        });
    }

    const content = container.createDiv({ cls: 'cs-profile-content' });
    const tab = BackstageRegistry.getTab(activeTab) || BackstageRegistry.getTab('skills');
    tab?.render(content, plugin, nav);
}
