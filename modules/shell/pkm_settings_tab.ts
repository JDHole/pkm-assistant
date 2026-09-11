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
import type { PluginApi, SettingsSectionCtx, ChatSettingsSlice, EmbeddingSettingsSlice } from '../../core/index.js';
import type { ModelLibraryEntry } from '../models/index.js';

interface PlatformOption {
    id: string;
    name: string;
}

/**
 * TS-boundary: każdy owner-modul (core/models/memory/tools/web/crystal-soul) ma WŁASNY,
 * strukturalnie inny `SettingsRegistryLike`/Ctx nad tym samym rejestrem i workerem DI -
 * `SettingsRegistry.register`/`registerXSettings` żyją za generycznym
 * `(...args: unknown[]) => unknown` (patrz `SettingsRegistry.ts`/`BackstageRegistry.ts` - ten
 * sam wzorzec rejestru wielu niezależnie typowanych wołaczy). Zawężenie do jednego precyzyjnego
 * typu współdzielonego przez wszystkich wołaczy nie istnieje bez zmiany ich plików (poza
 * zakresem); wywołania zostają 1:1, tylko z realną (nie `any`) funkcją zamiast `Runtime`.
 */
type GenericFn = (...args: unknown[]) => unknown;

export class PkmSettingsTab extends PluginSettingsTab {
    declare readonly plugin: PluginApi;
    declare name: string;
    declare private _showKeys: Record<string, boolean>;
    // DWA kontenery (`pkm-settings-header` / `pkm-settings-main`). Nie ma trzeciego
    // kontenera „środowiska" - sekcja pluginu wchodzi do głównego.
    declare readonly headerContainer: HTMLElement;
    declare readonly mainContainer: HTMLElement;
    declare private _settingsSectionsRegistered: boolean;

    constructor(app: App, plugin: PluginApi) {
        super(app, plugin);
        this.plugin = plugin;
        this.name = 'PKM Assistant';
        this.icon = 'bot';
        this._showKeys = {}; // track which API keys are visible
    }

    /**
     * DWA stany ekranu. `state !== 'loaded'` → akapit „ładuję" i render CZEKA na
     * `runtime.whenLoaded()`; `state === 'loaded'` → render od ręki (przy gotowym runtime
     * `whenLoaded()` kosztuje 0 ms, więc gałąź jest optymalizacją, nie wymogiem).
     * Nie ma trzeciego stanu ani guzika „uruchom".
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

    async render_header(container: HTMLElement): Promise<void> {
        if (!container) return;
        container.empty();
        container.createEl('h1', { text: t('settings.header_title') });
        container.createEl('p', {
            text: t('settings.header_desc'),
            cls: 'setting-item-description'
        });
    }

    async render_plugin_settings(container: HTMLElement): Promise<void> {
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

    async render_global_settings(container: HTMLElement): Promise<void> {
        if (!container) return;
        this._registerDefaultSettingsSections();
        await (SettingsRegistry.render as unknown as GenericFn)(container, this.plugin, {
            owner: this,
            defaultId: 'models',
        });
    }

    _registerDefaultSettingsSections() {
        if (this._settingsSectionsRegistered) return;
        SettingsRegistry.clear();
        (registerCoreSettings as unknown as GenericFn)(SettingsRegistry, this.plugin);
        (registerModelsSettings as unknown as GenericFn)(SettingsRegistry, this.plugin);
        (registerMemorySettings as unknown as GenericFn)(SettingsRegistry, this.plugin);
        // Settings→Vault (folder groups + vault zone descriptions). Shell-owned (vault
        // entity, not agents); order 35 sits between Pamięć (30) and Web (45).
        SettingsRegistry.register({
            id: 'vault',
            label: t('settings.vault_label'),
            icon: '🗂️',
            order: 35,
            render: (containerEl: HTMLElement, _plugin: unknown, options: { owner: PkmSettingsTab }) => renderVaultSection(containerEl, options.owner.buildSectionContext() as unknown as Parameters<typeof renderVaultSection>[1]),
        } as unknown as Parameters<typeof SettingsRegistry.register>[0]);
        (registerWebSettings as unknown as GenericFn)(SettingsRegistry, this.plugin);
        // Settings→Prompt (global prompt defaults - work prompts + factory sections).
        // Shell-owned; order 50 sits after Web (45), before No-Go (60).
        SettingsRegistry.register({
            id: 'prompt',
            label: t('settings.prompt_label'),
            icon: '📝',
            order: 50,
            render: (containerEl: HTMLElement, _plugin: unknown, options: { owner: PkmSettingsTab }) => renderPromptSection(containerEl, options.owner.buildSectionContext() as unknown as Parameters<typeof renderPromptSection>[1]),
        } as unknown as Parameters<typeof SettingsRegistry.register>[0]);
        (registerMcpSettings as unknown as GenericFn)(SettingsRegistry, this.plugin);
        (registerCrystalSoulSettings as unknown as GenericFn)(SettingsRegistry, this.plugin);
        this._settingsSectionsRegistered = true;
    }

    /**
     * TS-boundary: worek DI współdzielony przez WSZYSTKIE sekcje ustawień (core/models/memory/
     * tools/web/vault/prompt/crystal-soul) - każdy owner-modul ma WŁASNY, węższy typ Ctx nad tym
     * samym obiektem (np. `modules/models/SettingsContent.ts:ModelsSectionCtx`). `SettingsSectionCtx`
     * (core, ten plik jest jego wołaczem referencyjnym) opisuje `pkm` wąsko (`PkmSettingsSlice`,
     * nieeksportowany) - realny `bag.pkmAssistant` ma więcej pól niż ta jedna sekcja czyta,
     * stąd jedna asercja całego zwracanego workera zamiast rozbijania pól z osobna.
     */
    buildSectionContext(): SettingsSectionCtx {
        // To jest EKRAN USERA, nie boot - prowizjonowanie idzie świadomie przez proxy.
        const bag = this.env?.settings ?? {};
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
            // core/ nie importuje z modules/ (ADR 003) - bezpieczne wstawianie
            // ikon dostaje przez ctx, tak samo jak samą kolekcję ikon.
            setSvg,
            setSvgLabel,
            Setting,
            Notice,
            MCPServerEditorModal,
            // Modal potwierdzenia importu z Claude Desktop - jak MCPServerEditorModal,
            // przez ctx (modules/tools/SettingsContent.js nie może statycznie importować obsidiana).
            ClaudeImportModal,
            openCostTrackingModal: async () => {
                const { CostTrackingModal } = await import('./CostTrackingModal.js');
                new CostTrackingModal(this.app, this.plugin).open();
            },
        } as unknown as SettingsSectionCtx;
    }

    /**
     * Sync modelLibrary defaults to legacy settings keys for backward compat.
     * Called after any modelLibrary change.
     */
    _syncLegacyModelKeys(pkm: { modelLibrary?: Record<string, ModelLibraryEntry[]>; minionPlatform?: string; minionModel?: string }, chat: ChatSettingsSlice): void {
        const lib = pkm.modelLibrary || {};
        const mainDef = (lib.main || []).find((m: ModelLibraryEntry) => m.isDefault) || lib.main?.[0];
        if (mainDef) {
            chat.platform = mainDef.platform;
            if (!chat.models) chat.models = {};
            chat.models[mainDef.platform] = mainDef.model;
        }
        const minionDef = (lib.minion || []).find((m: ModelLibraryEntry) => m.isDefault) || lib.minion?.[0];
        pkm.minionPlatform = minionDef?.platform || '';
        pkm.minionModel = minionDef?.model || '';
    }

    _getAvailablePlatforms(chat: ChatSettingsSlice): PlatformOption[] {
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

    _getEmbedModelKey(provider: string, embedding: EmbeddingSettingsSlice): string {
        if (!provider) return '';
        return embedding?.models?.[provider] || '';
    }

    _setEmbedModelKey(provider: string, value: string, embedding: EmbeddingSettingsSlice): void {
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
