import { renderMemorySection } from './SettingsContent.js';
import type { MemorySettingsCtx } from './SettingsContent.js';
import { t } from '../../core/i18n/index.js';

/** Trzeci argument renderera z `SettingsRegistry.render(container, plugin, options)`. */
interface SettingsRenderOptions {
    owner: { buildSectionContext: () => MemorySettingsCtx };
}

/** Jedna sekcja w rejestrze ustawień (`modules/shell/SettingsRegistry`). */
interface SettingsSectionDef {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    render: (containerEl: HTMLElement, plugin: unknown, options: SettingsRenderOptions) => void;
}

/** Rejestr z `modules/shell` — memory zna z niego wyłącznie `register`. */
interface SettingsRegistryLike {
    register: (section: SettingsSectionDef) => void;
}

export function registerSettings(registry: SettingsRegistryLike): void {
    registry.register({
        id: 'memory',
        label: t('settings.nav.memory'),
        icon: '🧠',
        order: 30,
        render: (containerEl, _plugin, options) => renderMemorySection(containerEl, options.owner.buildSectionContext()),
    });
}
