import { renderModelsSection } from './SettingsContent.js';
import type { ModelsSectionCtx } from './SettingsContent.js';

/** Trzeci argument renderera z `SettingsRegistry.render(container, plugin, options)`. */
interface SettingsRenderOptions {
    owner: { buildSectionContext: () => ModelsSectionCtx };
}

/** Jedna sekcja w rejestrze ustawień (`modules/shell/SettingsRegistry`). */
interface SettingsSectionDef {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    render: (containerEl: HTMLElement, plugin: unknown, options: SettingsRenderOptions) => void | Promise<void>;
}

/** Rejestr z `modules/shell` — ten moduł zna z niego dwie metody rejestracji. */
interface SettingsRegistryLike {
    register: (section: SettingsSectionDef) => void;
    registerSubFields: (sectionId: string, fields: SettingsSectionDef | SettingsSectionDef[]) => void;
}

export function registerSettings(registry: SettingsRegistryLike): void {
    registry.register({
        id: 'models',
        label: 'Modele',
        icon: '🤖',
        order: 20,
        render: (containerEl, _plugin, options) => renderModelsSection(containerEl, options.owner.buildSectionContext()),
    });
    registry.registerSubFields('api-keys', {
        id: 'models-api-keys',
        order: 20,
        render: () => {},
    });
}
