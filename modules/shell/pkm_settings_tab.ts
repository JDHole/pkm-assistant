import { PluginSettingsTab } from './PluginSettingsTab.js';
import { Setting, Notice } from "obsidian";
import type { App } from 'obsidian';
import { UiIcons, setSvg, setSvgLabel } from '../../modules/crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import { MCPServerEditorModal } from './MCPServerEditorModal.js';
import { ClaudeImportModal } from './ClaudeImportModal.js';
import { SettingsRegistry } from './SettingsRegistry.js';
import { registerSettings as registerCoreSettings } from '../../core/index.js';
import { registerSettings as registerModelsSettings } from '../models/index.js';
import { registerSettings as registerMemorySettings } from '../memory/index.js';
import { registerSettings as registerMcpSettings } from '../tools/index.js';
import { registerSettings as registerWebSettings } from '../web/index.js';
import { registerSettings as registerCrystalSoulSettings } from '../crystal-soul/index.js';
import { renderVaultSection } from './vault_settings.js';
import { renderPromptSection } from './prompt_settings.js';

// TS-any: settings UI is the composition boundary for plugin-owned registries, persisted settings, and modal services.
type Runtime = any;

interface PlatformOption {
    id: string;
    name: string;
}

export class PkmSettingsTab extends PluginSettingsTab {
    declare readonly plugin: Runtime;
    declare name: string;
    declare private _showKeys: Record<string, boolean>;
    // V-06: DWA kontenery (`pkm-settings-header` / `pkm-settings-main`). Trzeci, dawny
    // kontener „środowiska", zniknął razem z reliktem — sekcja pluginu wchodzi do głównego.
    declare readonly headerContainer: Runtime;
    declare readonly mainContainer: Runtime;
    declare private _settingsSectionsRegistered: boolean;

    constructor(app: App, plugin: Runtime) {
        super(app, plugin);
        this.plugin = plugin;
        this.name = 'PKM Assistant';
        this.icon = 'bot';
        this._showKeys = {}; // track which API keys are visible
    }

    /**
     * V-06: DWA stany ekranu. `state !== 'loaded'` → akapit „ładuję" i render CZEKA na
     * `runtime.whenLoaded()`; `state === 'loaded'` → render od ręki (przy gotowym runtime
     * `whenLoaded()` kosztuje 0 ms, więc gałąź jest optymalizacją, nie wymogiem).
     * Trzeciego stanu ani guzika „uruchom" nie ma — istniały wyłącznie dla `'idle'`.
     */
    async render() {
        this.containerEl.empty();
        if (this.env?.state !== 'loaded') {
            this.containerEl.createEl('p', { text: t('settings.loading') });
            await this.env?.whenLoaded();
        }
        this.prepareLayout();
        await this.render_header(this.headerContainer);
        await this.render_plugin_settings(this.mainContainer);
        await this.render_global_settings(this.mainContainer);
    }

    async render_header(container: Runtime): Promise<void> {
        if (!container) return;
        container.empty();
        container.createEl('h1', { text: t('settings.header_title') });
        container.createEl('p', {
            text: t('settings.header_desc'),
            cls: 'setting-item-description'
        });
    }

    async render_plugin_settings(container: Runtime): Promise<void> {
        if (!container) return;
        container.empty();

        if (!this.env?.settings?.pkmAssistant) {
            if (this.env?.settings) this.env.settings.pkmAssistant = {};
        }
        const pkmSettings = this.env?.settings?.pkmAssistant;
        if (pkmSettings && !pkmSettings.onboardingCompleted) {
            const banner = container.createDiv({ cls: 'pkm-onboarding-banner' });
            banner.createEl('p', {
                text: '⚠️ Wizard onboardingu wyłączony w v2.0 (planowany powrót w v3.0). Skonfiguruj plugin: Klucze API → Modele → Agenci.',
                cls: 'pkm-onboarding-banner__text',
            });
            const skipBtn = banner.createEl('button', { text: 'Skip onboarding', cls: 'mod-cta' });
            skipBtn.addEventListener('click', async () => {
                pkmSettings.onboardingCompleted = true;
                await this.save_settings();
                void this.render();
            });
        }
    }

    async render_global_settings(container: Runtime): Promise<void> {
        if (!container) return;
        this._registerDefaultSettingsSections();
        await (SettingsRegistry.render as Runtime)(container, this.plugin, {
            owner: this,
            defaultId: 'models',
        });
    }

    _registerDefaultSettingsSections() {
        if (this._settingsSectionsRegistered) return;
        SettingsRegistry.clear();
        (registerCoreSettings as Runtime)(SettingsRegistry, this.plugin);
        (registerModelsSettings as Runtime)(SettingsRegistry, this.plugin);
        (registerMemorySettings as Runtime)(SettingsRegistry, this.plugin);
        // E2.8 B1: Settings→Vault (folder groups + vault zone descriptions). Shell-owned (vault
        // entity, not agents); order 35 sits between Pamięć (30) and Web (45).
        SettingsRegistry.register({
            id: 'vault',
            label: t('settings.vault_label'),
            icon: '🗂️',
            order: 35,
            render: (containerEl: Runtime, _plugin: Runtime, options: Runtime) => renderVaultSection(containerEl, options.owner.buildSectionContext()),
        });
        (registerWebSettings as Runtime)(SettingsRegistry, this.plugin);
        // E2.8 B2: Settings→Prompt (global prompt defaults — work prompts + factory sections).
        // Shell-owned; order 50 sits after Web (45), before No-Go (60).
        SettingsRegistry.register({
            id: 'prompt',
            label: t('settings.prompt_label'),
            icon: '📝',
            order: 50,
            render: (containerEl: Runtime, _plugin: Runtime, options: Runtime) => renderPromptSection(containerEl, options.owner.buildSectionContext()),
        });
        (registerMcpSettings as Runtime)(SettingsRegistry, this.plugin);
        // E2.8 A3: sekcja Settings/Agenci (tylko role) usunięta — rola rozpuszczona (D7).
        (registerCrystalSoulSettings as Runtime)(SettingsRegistry, this.plugin);
        this._settingsSectionsRegistered = true;
    }

    buildSectionContext(): Runtime {
        // To jest EKRAN USERA, nie boot — prowizjonowanie idzie świadomie przez proxy.
        const bag: Runtime = this.env?.settings ?? {};
        if (!bag.pkmAssistant) bag.pkmAssistant = {};
        if (!bag.pkmAssistant.chat) bag.pkmAssistant.chat = {};
        if (!bag.pkmAssistant.embedding) bag.pkmAssistant.embedding = {};

        const chat = bag.pkmAssistant.chat;
        const pkm = bag.pkmAssistant;

        return {
            plugin: this.plugin,
            env: this.env,
            chat,
            pkm,
            availablePlatforms: this._getAvailablePlatforms(chat),
            owner: this,
            save: () => this.save_settings(),
            icons: UiIcons,
            // E3.4: core/ nie importuje z modules/ (ADR 003) — bezpieczne wstawianie
            // ikon dostaje przez ctx, tak samo jak samą kolekcję ikon.
            setSvg,
            setSvgLabel,
            Setting,
            Notice,
            MCPServerEditorModal,
            // S32 Z2.3: modal potwierdzenia importu z Claude Desktop — jak MCPServerEditorModal,
            // przez ctx (modules/tools/SettingsContent.js nie może statycznie importować obsidiana).
            ClaudeImportModal,
            openCostTrackingModal: async () => {
                const { CostTrackingModal } = await import('./CostTrackingModal.js');
                new CostTrackingModal(this.app, this.plugin).open();
            },
        };
    }

    /**
     * Sync modelLibrary defaults to legacy settings keys for backward compat.
     * Called after any modelLibrary change.
     */
    _syncLegacyModelKeys(pkm: Runtime, chat: Runtime): void {
        const lib = pkm.modelLibrary || {};
        const mainDef = (lib.main || []).find((m: Runtime) => m.isDefault) || lib.main?.[0];
        if (mainDef) {
            chat.platform = mainDef.platform;
            if (!chat.models) chat.models = {};
            chat.models[mainDef.platform] = mainDef.model;
        }
        const minionDef = (lib.minion || []).find((m: Runtime) => m.isDefault) || lib.minion?.[0];
        pkm.minionPlatform = minionDef?.platform || '';
        pkm.minionModel = minionDef?.model || '';
        // Slot 'master' (rola stratega) skasowany w fabryce kasacji S1 (2026-09-02,
        // AUD-dead-code-173) — pola `masterPlatform`/`masterModel` skasowane z modelResolver.ts
        // (PkmModelSettings) i migracji w src/main.ts; to zerowanie było ostatnim wołaczem.
    }

    _getAvailablePlatforms(chat: Runtime): PlatformOption[] {
        const platforms: PlatformOption[] = [];
        const apiProviders = ['anthropic', 'openai', 'deepseek', 'gemini', 'groq', 'xai', 'open_router'];
        const localProviders = ['ollama', 'lm_studio'];

        for (const p of apiProviders) {
            if (chat?.apiKeys?.[p]) {
                platforms.push({ id: p, name: this.get_platform_name(p) });
            }
        }
        for (const lp of localProviders) {
            if (chat?.hosts?.[lp]) {
                platforms.push({ id: lp, name: this.get_platform_name(lp) });
            }
        }
        return platforms;
    }

    _getEmbedModelKey(provider: string, embedding: Runtime): string {
        if (!provider) return '';
        return embedding?.models?.[provider] || '';
    }

    _setEmbedModelKey(provider: string, value: string, embedding: Runtime): void {
        if (!embedding.models) embedding.models = {};
        embedding.models[provider] = value;
    }

    get_platform_name(platform: string): string {
        const names: Record<string, string> = {
            anthropic: 'Anthropic',
            openai: 'OpenAI',
            open_router: 'OpenRouter',
            ollama: 'Ollama',
            gemini: 'Google Gemini',
            groq: 'Groq',
            deepseek: 'DeepSeek',
            xai: 'xAI (Grok)',
            lm_studio: 'LM Studio',
        };
        return names[platform] || platform;
    }

    async save_settings() {
        await this.env?.settingsStore?.save();
    }
}
