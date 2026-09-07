/**
 * Sub-Agents tab registration for the Backstage sidebar (Sprint 10 Z6).
 *
 * Render lives in `SubAgentsBackstageTab.js`, lazy-loaded so importing this
 * file (via `modules/sub-agents/index.js`) doesn't pull `obsidian` into the
 * test runtime through shell barrel deps.
 */
import { UiIcons } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
// TS-any: registry and lazy sidebar renderer are runtime Obsidian contracts.
type SidebarBoundary = any;

export function registerBackstage(registry: SidebarBoundary) {
    registry.register({
        id: 'sub-agents',
        label: t('backstage.sub_agents'),
        iconFn: (size: number) => UiIcons.robot(size),
        order: 20,
        render: async (content: SidebarBoundary, plugin: SidebarBoundary, nav: SidebarBoundary) => {
            const { renderSubAgentsTab } = await import('./SubAgentsBackstageTab.js');
            return renderSubAgentsTab(content, plugin, nav);
        },
    });
}
