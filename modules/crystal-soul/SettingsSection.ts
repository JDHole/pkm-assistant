import { renderAppearanceSection } from './SettingsContent.js';
import { t } from '../../core/i18n/index.js';
import type { AppearanceSectionContext } from './SettingsContent.js';

type SettingsRegistryLike = {
    register(section: {
        id: string;
        label: string;
        icon: string;
        order: number;
        render: (containerEl: HTMLElement, plugin: unknown, options: {
            owner: { buildSectionContext(): AppearanceSectionContext };
        }) => void;
    }): void;
};

export function registerSettings(registry: SettingsRegistryLike): void {
    registry.register({
        id: 'appearance',
        label: t('settings.appearance_title'),
        icon: '💎',
        order: 70,
        render: (containerEl: HTMLElement, _plugin: unknown, options: {
            owner: { buildSectionContext(): AppearanceSectionContext };
        }) => renderAppearanceSection(containerEl, options.owner.buildSectionContext()),
    });
}
