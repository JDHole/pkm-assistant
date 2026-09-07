/**
 * Skills tab registration for the Backstage sidebar (Sprint 10 Z6).
 *
 * Render lives in `SkillsBackstageTab.js`, lazy-loaded so importing this
 * file (via `modules/skills/index.js`) doesn't pull `obsidian` into the
 * test runtime through shell barrel deps.
 */
import { UiIcons } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
// TS-any: registry and lazy renderer are untyped Obsidian sidebar boundary.
type SidebarBoundary = any;

export function registerBackstage(registry: SidebarBoundary) {
    registry.register({
        id: 'skills',
        label: t('backstage.skills'),
        iconFn: (size: number) => UiIcons.zap(size),
        order: 10,
        render: async (content: SidebarBoundary, plugin: SidebarBoundary, nav: SidebarBoundary) => {
            const { renderSkillsTab } = await import('./SkillsBackstageTab.js');
            return renderSkillsTab(content, plugin, nav);
        },
    });
}
