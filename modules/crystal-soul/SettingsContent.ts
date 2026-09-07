import { t, setLocale } from '../../core/i18n/index.js';
import { ensureAdapterFolder } from '../../core/index.js';
import { COLOR_GROUPS, getColorByHex } from './ColorPalette.js';
import { SkinManager } from './SkinManager.js';
import { setSvgLabel } from './domUtils.js';
import type {
    ButtonComponent,
    DropdownComponent,
    Notice,
    Setting,
    ToggleComponent,
    Vault,
} from 'obsidian';
import type { SkinManagerClass } from './SkinManager.js';

type AppearanceSettings = {
    language?: string;
    userColor?: string | null;
    activeSkin?: string;
    enableOczko?: boolean;
    showThinking?: boolean;
    compactToolChips?: boolean;
};

type AppearancePlugin = {
    app?: { vault?: Vault };
    skinManager?: SkinManagerClass;
    applyUserColor(hex: string): void;
    generateCrystalSoulTemplate(): Promise<string>;
    _loadCrystalSoulTheme(): Promise<unknown>;
};

export type AppearanceSectionContext = {
    pkm: AppearanceSettings;
    save: () => Promise<unknown>;
    owner: { render(): void };
    plugin: AppearancePlugin;
    icons?: Record<string, ((size?: number) => string) | undefined>;
    Setting: typeof Setting;
    Notice: typeof Notice;
};

export function renderAppearanceSection(container: HTMLElement, ctx: AppearanceSectionContext): void {
    const { pkm, save, owner, plugin, icons, Setting, Notice } = ctx;
    container.classList.add('cs-root');

    const lookHeading = new Setting(container).setHeading();
    lookHeading.settingEl.addClass('cs-settings-section');
    setSvgLabel(lookHeading.nameEl, icons?.diamond?.(18) || '', t('settings.appearance_title'));

    new Setting(container)
        .setName(t('settings.language'))
        .setDesc(t('settings.language_desc'))
        .addDropdown((dd: DropdownComponent) => dd
            .addOption('en', 'English')
            .addOption('pl', 'Polski')
            .setValue(pkm.language || 'en')
            .onChange(async (value: string) => {
                pkm.language = value;
                setLocale(value);
                await save();
                owner.render();
            })
        );

    {
        const currentColor = pkm.userColor || null;
        const match = currentColor ? getColorByHex(currentColor) : null;

        const s = new Setting(container)
            .setName(t('settings.user_color'))
            .setDesc(t('settings.user_color_desc'));

        const controlEl = s.controlEl;
        controlEl.addClass('pkm-color-control');

        const colorDot = controlEl.createDiv({ cls: 'cs-profile-hero__color-dot cs-dyn-bg' });
        colorDot.style.setProperty('--cs-dyn-bg', currentColor || 'var(--interactive-accent)');
        const colorLabel = controlEl.createSpan({
            cls: 'cs-profile-hero__color-hex',
            text: match?.name || currentColor || t('settings.user_color_default')
        });

        const applyColor = async (hex: string) => {
            colorDot.style.setProperty('--cs-dyn-bg', hex);
            const m = getColorByHex(hex);
            colorLabel.textContent = m?.name || hex;
            pkm.userColor = hex;
            plugin.applyUserColor(hex);
            await save();
        };

        let palettePopup: HTMLDivElement | null = null;
        const togglePalette = () => {
            if (palettePopup) { palettePopup.remove(); palettePopup = null; return; }
            palettePopup = container.createDiv({ cls: 'cs-palette-popup' });
            s.settingEl.after(palettePopup);
            for (const colors of Object.values(COLOR_GROUPS)) {
                const row = palettePopup.createDiv({ cls: 'cs-palette-popup__row' });
                for (const c of colors) {
                    const swatch = row.createDiv({ cls: 'cs-palette-popup__swatch cs-dyn-bg' });
                    swatch.style.setProperty('--cs-dyn-bg', c.hex);
                    swatch.title = c.name;
                    if (currentColor && c.hex.toLowerCase() === currentColor.toLowerCase()) {
                        swatch.classList.add('cs-palette-popup__swatch--active');
                    }
                    swatch.addEventListener('click', () => {
                        void applyColor(c.hex);
                        palettePopup!.remove();
                        palettePopup = null;
                    });
                }
            }
        };
        controlEl.addEventListener('click', togglePalette);
    }

    new Setting(container).setName(t('settings.skin_section')).setHeading();
    container.createEl('p', {
        text: t('settings.skin_section_desc'),
        cls: 'setting-item-description'
    });

    {
        const skinManager = plugin.skinManager || SkinManager;
        const skinOptions = skinManager.listSkins();
        const activeSkin = pkm.activeSkin || 'crystal-soul';

        new Setting(container)
            .setName(t('settings.skin_active'))
            .setDesc(t('settings.skin_active_desc'))
            .addDropdown((dd: DropdownComponent) => {
                for (const skin of skinOptions) {
                    dd.addOption(skin.id, skin.type === 'custom' ? `${skin.name} ${t('settings.skin_custom_suffix')}` : skin.name);
                }
                dd.setValue(activeSkin);
                dd.onChange(async (value: string) => {
                    const changed = await skinManager.setActiveSkin(value, { save: false });
                    if (!changed) {
                        new Notice(t('settings.skin_not_found', { id: value }));
                        return;
                    }
                    pkm.activeSkin = value;
                    await save();
                    new Notice(t('settings.skin_changed_notice', { name: skinManager.getActiveSkin().name }));
                    owner.render();
                });
            });

        new Setting(container)
            .setName(t('settings.skin_reload'))
            .setDesc(t('settings.skin_reload_desc'))
            .addButton((btn: ButtonComponent) => btn
                .setButtonText(t('settings.skin_reload_btn'))
                .onClick(async () => {
                    await skinManager.reloadCustomSkins();
                    skinManager.applyCss();
                    new Notice(t('settings.skin_reloaded_notice'));
                    owner.render();
                })
            );

        new Setting(container)
            .setName(t('settings.skin_sample'))
            .setDesc(t('settings.skin_sample_desc'))
            .addButton((btn: ButtonComponent) => btn
                .setButtonText(t('settings.skin_sample_btn'))
                .onClick(async () => {
                    const path = '.pkm-assistant/skins/moj-skin.yaml';
                    const adapter = plugin.app?.vault?.adapter;
                    // mkdir -p tworzy też rodzica `.pkm-assistant`; guard na brak adaptera w helperze.
                    await ensureAdapterFolder(adapter, '.pkm-assistant/skins');
                    const exists = await adapter?.exists?.(path);
                    if (!exists) {
                        await adapter!.write(path, [
                            `name: "${t('settings.skin_sample_name')}"`,
                            'parent: "crystal-soul"',
                            'colors:',
                            '  agent_default: "#ff6b6b"',
                            '  background_chat: "var(--background-secondary)"',
                            'animations:',
                            '  enabled: false',
                            'css:',
                            '  custom: |',
                            '    .pkm-skin-root { --pkm-skin-agent-default: #ff6b6b; }',
                            '',
                        ].join('\n'));
                    }
                    await skinManager.reloadCustomSkins();
                    new Notice(t('settings.skin_sample_created', { path }));
                    owner.render();
                })
            );
    }

    new Setting(container)
        .setName(t('settings.eye_toggle'))
        .setDesc(t('settings.eye_desc'))
        .addToggle((toggle: ToggleComponent) => toggle
            .setValue(pkm.enableOczko !== false)
            .onChange(async (value: boolean) => {
                pkm.enableOczko = value;
                await save();
            })
        );

    new Setting(container)
        .setName(t('settings.show_thinking'))
        .setDesc(t('settings.show_thinking_desc'))
        .addToggle((toggle: ToggleComponent) => toggle
            .setValue(pkm.showThinking ?? true)
            .onChange(async (value: boolean) => {
                pkm.showThinking = value;
                await save();
            }));

    new Setting(container)
        .setName(t('settings.compact_tool_chips'))
        .setDesc(t('settings.compact_tool_chips_desc'))
        .addToggle((toggle: ToggleComponent) => toggle
            .setValue(pkm.compactToolChips !== false)
            .onChange(async (value: boolean) => {
                pkm.compactToolChips = value;
                await save();
            }));

    new Setting(container).setName(t('settings.crystal_soul')).setHeading();
    container.createEl('p', {
        text: t('settings.crystal_soul_desc'),
        cls: 'setting-item-description'
    });

    new Setting(container)
        .setName(t('settings.generate_theme'))
        .setDesc(t('settings.generate_theme_desc'))
        .addButton((btn: ButtonComponent) => btn
            .setButtonText(t('settings.generate_theme_btn'))
            .onClick(async () => {
                const path = await plugin.generateCrystalSoulTemplate();
                new Notice(`Crystal Soul template: ${path}`);
            })
        );

    new Setting(container)
        .setName(t('settings.reload_theme'))
        .setDesc(t('settings.reload_theme_desc'))
        .addButton((btn: ButtonComponent) => btn
            .setButtonText(t('settings.reload_theme_btn'))
            .onClick(async () => {
                await plugin._loadCrystalSoulTheme();
                new Notice(t('settings.theme_reloaded'));
            })
        );
}
