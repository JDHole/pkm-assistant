import { renderAdvancedSection, renderApiKeysSection, renderInfoSection, renderNoGoSection, renderLimitsSection } from './SettingsContent.js';
import type { SettingsSectionCtx } from './SettingsContent.js';

/** Trzeci argument renderera z `SettingsRegistry.render(container, plugin, options)`. */
interface SettingsRenderOptions {
    owner: { buildSectionContext: () => SettingsSectionCtx };
}

/** Jedna sekcja w rejestrze ustawień (`modules/shell/SettingsRegistry`). */
interface SettingsSectionDef {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    render: (containerEl: HTMLElement, plugin: unknown, options: SettingsRenderOptions) => void;
}

/** Rejestr z `modules/shell` — core zna z niego wyłącznie `register` (kierunek: shell → core). */
interface SettingsRegistryLike {
    register: (section: SettingsSectionDef) => void;
}

export function registerSettings(registry: SettingsRegistryLike): void {
    registry.register({
        id: 'nogo',
        label: 'No-Go',
        icon: '🛡️',
        order: 60,
        render: (containerEl, _plugin, options) => renderNoGoSection(containerEl, options.owner.buildSectionContext()),
    });
    registry.register({
        id: 'limits',
        label: 'Limity',
        icon: '🎚️',
        order: 75,
        render: (containerEl, _plugin, options) => renderLimitsSection(containerEl, options.owner.buildSectionContext()),
    });
    registry.register({
        id: 'advanced',
        label: 'Zaawansowane',
        icon: '🔧',
        order: 80,
        render: (containerEl, _plugin, options) => renderAdvancedSection(containerEl, options.owner.buildSectionContext()),
    });
    registry.register({
        id: 'api-keys',
        label: 'Klucze API',
        icon: '🔑',
        order: 90,
        render: (containerEl, _plugin, options) => renderApiKeysSection(containerEl, options.owner.buildSectionContext()),
    });
    registry.register({
        id: 'info',
        label: 'Informacje',
        icon: 'ℹ️',
        order: 110,
        render: (containerEl, _plugin, options) => renderInfoSection(containerEl, options.owner.buildSectionContext()),
    });
}
