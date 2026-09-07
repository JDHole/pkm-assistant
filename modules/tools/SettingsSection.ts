import { renderMcpServersSection, renderMediaToolsSection } from './SettingsContent.js';
import type { ToolsSettingsCtx } from './SettingsContent.js';

/** Trzeci argument renderera z `SettingsRegistry.render(container, plugin, options)`. */
interface SettingsRenderOptions {
    owner: { buildSectionContext: () => ToolsSettingsCtx };
}

/** Jedna sekcja w rejestrze ustawien (`modules/shell/SettingsRegistry`). */
interface SettingsSectionDef {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    render: (containerEl: HTMLElement, plugin: unknown, options: SettingsRenderOptions) => void;
}

/** Rejestr z `modules/shell` — ten modul zna z niego `register` i `registerSubFields`. */
interface SettingsRegistryLike {
    register: (section: SettingsSectionDef) => void;
    registerSubFields: (parentId: string, section: { id: string; order?: number; render: () => void }) => void;
}

export function registerSettings(registry: SettingsRegistryLike): void {
    registry.register({
        id: 'media-tools',
        label: 'Media Tools',
        icon: '🎛️',
        order: 40,
        render: (containerEl, _plugin, options) => renderMediaToolsSection(containerEl, options.owner.buildSectionContext()),
    });
    registry.register({
        id: 'mcp',
        label: 'MCP Servers',
        icon: '🔌',
        order: 100,
        render: (containerEl, _plugin, options) => renderMcpServersSection(containerEl, options.owner.buildSectionContext()),
    });
    registry.registerSubFields('api-keys', {
        id: 'mcp-api-keys',
        order: 40,
        render: () => {},
    });
}
