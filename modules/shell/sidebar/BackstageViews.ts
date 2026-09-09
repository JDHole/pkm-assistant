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

// TS-any: sidebar tab renderers and plugin managers are dynamic Obsidian integrations.
type Runtime = any;

/**
 * Liczniki zakładek liczą SZABLONY (Zaplecze = katalog form odlewniczych),
 * a nie żywe byty. Zakładka Konektory liczy PODŁĄCZONE serwery MCP.
 */
function getTabCount(plugin: Runtime, tabId: string): number {
    switch (tabId) {
        case 'skills':     return plugin.agentManager?.skillTemplateStore?.count() || 0;
        // pkm-sub (wbudowany) zawsze jest na liście, stąd +1 do szablonów.
        case 'sub-agents': return (plugin.agentManager?.subAgentTemplateStore?.count() || 0) + 1;
        case 'connectors': return countConnectedServers(plugin);
        // Backward compat for old tab IDs - redirect to sub-agents
        case 'minions':
        case 'masters':    return (plugin.agentManager?.subAgentTemplateStore?.count() || 0) + 1;
        default: return 0;
    }
}

/** Ile zewnętrznych serwerów MCP jest realnie podłączonych. */
export function countConnectedServers(plugin: Runtime): number {
    try {
        const servers = plugin?.externalMcpManager?.listServersForUi?.() || [];
        return servers.filter((s: Runtime) => s.connected).length;
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
 */
export function renderZapleczeView(container: Runtime, plugin: Runtime, nav: Runtime, params: Runtime): void {
    container.classList.add('cs-root');
    registerDefaultBackstageTabs();

    const requestedTab = params.tab || 'skills';
    const activeTab = ['minions', 'masters'].includes(requestedTab) ? 'sub-agents' : requestedTab;
    const tabBar = container.createDiv({ cls: 'cs-profile-tabs cs-zaplecze-tabs' });

    for (const tab of BackstageRegistry.getTabs()) {
        const btn = tabBar.createEl('button', {
            cls: `cs-profile-tab ${tab.id === activeTab ? 'cs-profile-tab--active' : ''}`
        });
        setSvgLabel(btn, (tab as Runtime).iconFn(14), tab.label as string);

        const count = getTabCount(plugin, tab.id);
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
