import { renderWebSearchSection } from './SettingsContent.js';
import type { WebSettingsSectionCtx } from './SettingsContent.js';

/** Trzeci argument renderera z `SettingsRegistry.render(container, plugin, options)`. */
interface SettingsRenderOptions {
    owner: { buildSectionContext: () => WebSettingsSectionCtx };
}

/** Jedna sekcja w rejestrze ustawień (`modules/shell/SettingsRegistry`). */
interface SettingsSectionDef {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    render: (containerEl: HTMLElement, plugin: unknown, options: SettingsRenderOptions) => void;
}

/** Rejestr z `modules/shell` — ten moduł zna z niego wyłącznie `register`. */
interface SettingsRegistryLike {
    register: (section: SettingsSectionDef) => void;
}

export function registerSettings(registry: SettingsRegistryLike): void {
    registry.register({
        id: 'web-search',
        label: 'Web Search',
        icon: '🌐',
        order: 45,
        render: (containerEl, _plugin, options) => renderWebSearchSection(containerEl, options.owner.buildSectionContext()),
    });
}
