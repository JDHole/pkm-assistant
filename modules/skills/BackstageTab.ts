/**
 * Skills tab registration for the Backstage sidebar.
 *
 * Render lives in `SkillsBackstageTab.js`, lazy-loaded so importing this
 * file (via `modules/skills/index.js`) doesn't pull `obsidian` into the
 * test runtime through shell barrel deps.
 */
import { UiIcons } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import type { SidebarNav } from '../shell/index.js';
import type { SkillsPlugin } from './types.js';

/**
 * Zakładka Zaplecza tak, jak przyjmuje ją rejestr z `modules/shell/BackstageRegistry.ts`
 * (realny `BackstageTab.render: (...args: unknown[]) => unknown`; realny wołacz,
 * `modules/shell/sidebar/BackstageViews.ts`, jest POZA zakresem tej fali i woła
 * `registerSkillsBackstage(BackstageRegistry)` BEZ castu).
 *
 * `render` jest tu METODĄ (`render(...): unknown`, nie `render: (...) => unknown`) celowo —
 * sygnatury metod TS porównuje BIWARIANTNIE, więc literał niżej może dalej deklarować
 * konkretne `(content, plugin, nav)` zamiast `(...args: unknown[])`.
 */
export interface BackstageTabDef {
    id: string;
    label: string;
    iconFn: (size?: number) => string;
    order?: number;
    render(...args: unknown[]): unknown;
}

/** Rejestr Zaplecza — ten moduł zna z niego wyłącznie `register`. */
export interface BackstageRegistryLike {
    register: (tab: BackstageTabDef) => void;
}

export function registerBackstage(registry: BackstageRegistryLike): void {
    registry.register({
        id: 'skills',
        label: t('backstage.skills'),
        iconFn: (size?: number) => UiIcons.zap(size),
        order: 10,
        render: async (content: HTMLElement, plugin: SkillsPlugin, nav: SidebarNav) => {
            const { renderSkillsTab } = await import('./SkillsBackstageTab.js');
            return renderSkillsTab(content, plugin, nav);
        },
    });
}
