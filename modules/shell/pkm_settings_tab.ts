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
import type { PluginApi, SettingsSectionCtx, ChatSettingsSlice, EmbeddingSettingsSlice, PkmAssistantSettings } from '../../core/index.js';
import type { ModelLibraryEntry } from '../models/index.js';

interface PlatformOption {
    id: string;
    name: string;
}

/**
 * Worek DI z `buildSectionContext()`, węższy niż gołe `SettingsSectionCtx` (core) tam, gdzie core
 * widzi mniej niż realnie istnieje w `bag.pkmAssistant` (`pkm`), i szerszy tam, gdzie core w ogóle
 * nie zna pól, których core NIE CZYTA (`availablePlatforms`/modale) - wzór:
 * `modules/tools/SettingsContent.ts:ToolsSettingsCtx`. `save` zawężone do realnego zwrotu
 * `save_settings()` (zawsze `Promise<void>`, core dopuszcza też goły `void`).
 */
type ShellSectionCtx = Omit<SettingsSectionCtx, 'pkm' | 'save'> & {
    pkm: PkmAssistantSettings;
    save: () => Promise<void>;
    availablePlatforms: PlatformOption[];
    MCPServerEditorModal: typeof MCPServerEditorModal;
    ClaudeImportModal: typeof ClaudeImportModal;
};

/**
 * TS-boundary: wszystkie `registerXSettings` (core/models/memory/tools/web/crystal-soul) mają
 * sygnaturę JEDNOargumentową `(registry: SettingsRegistryLike): void` - drugi argument
 * (`this.plugin`) poniżej jest MARTWY na poziomie typów, żaden z wołanych modułów go nie czyta.
 * Zostaje (to zachowanie runtime, zmiana sygnatury `registerX` w cudzym module jest poza
 * zakresem). `WithDeadArg<typeof fn>` bierze typ registry Z SAMEJ wołanej funkcji
 * (`Parameters<Fn>[0]`, WŁASNY prywatny `SettingsRegistryLike` TEGO modułu - kanoniczny
 * `SettingsRegistryLike` z `core/index.ts` tu nie pasuje, bo core/models/memory/web/tools/
 * crystal-soul mają każdy swoją, niekompatybilną kopię) i formalnie dokłada `...rest: unknown[]`
 * na martwy drugi argument (arity, nie shape) - ten cast jest bezpieczny (jeden `as`) dla
 * WSZYSTKICH sześciu wołań, bo poszerza tylko arity, nie zmienia typu `registry`.
 * Drugi, osobny cast siedzi na SAMYM `SettingsRegistry` w wywołaniu - dla `core` NIE jest
 * potrzebny (rejestr realnie spełnia `core`'s `SettingsSectionCtx` strukturalnie), ale dla
 * pozostałych pięciu tak: każdy ma WŁASNY, SZERSZY niż wspólny `SettingsSectionCtx` kontrakt Ctx
 * (np. `ModelsSectionCtx` dokłada `availablePlatforms`, `ToolsSettingsCtx` dwa modale) -
 * `SettingsRegistry` (typowany generycznie dla WSZYSTKICH wołaczy naraz, patrz `SettingsSection`
 * w `SettingsRegistry.ts`) formalnie obiecuje tylko wspólny, węższy `SettingsSectionCtx`, więc
 * żaden pojedynczy `as` między konkretnym `SettingsRegistryClass` a takim rejestrem nie przechodzi
 * (realny worek z `buildSectionContext()` te pola ma - to jest TA SAMA "kontrawariancja rejestru
 * wielu niezależnie typowanych wołaczy", co przy `SidebarNav`/`BackstageRegistry`, patrz
 * `AgentSidebar.ts`).
 */
type WithDeadArg<Fn extends (registry: never) => void> = (registry: Parameters<Fn>[0], ...rest: unknown[]) => void;

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
        await SettingsRegistry.render(container, this.plugin, {
            owner: this,
            defaultId: 'models',
        });
    }

    _registerDefaultSettingsSections() {
        if (this._settingsSectionsRegistered) return;
        SettingsRegistry.clear();
        (registerCoreSettings as WithDeadArg<typeof registerCoreSettings>)(SettingsRegistry, this.plugin);
        (registerModelsSettings as WithDeadArg<typeof registerModelsSettings>)(SettingsRegistry as unknown as Parameters<typeof registerModelsSettings>[0], this.plugin);
        (registerMemorySettings as WithDeadArg<typeof registerMemorySettings>)(SettingsRegistry as unknown as Parameters<typeof registerMemorySettings>[0], this.plugin);
        // Settings→Vault (folder groups + vault zone descriptions). Shell-owned (vault
        // entity, not agents); order 35 sits between Pamięć (30) and Web (45).
        SettingsRegistry.register({
            id: 'vault',
            label: t('settings.vault_label'),
            icon: '🗂️',
            order: 35,
            render: (containerEl: HTMLElement, _plugin: PluginApi, options: { owner: { buildSectionContext(): ShellSectionCtx } }) => renderVaultSection(containerEl, options.owner.buildSectionContext() as unknown as Parameters<typeof renderVaultSection>[1]),
        });
        (registerWebSettings as WithDeadArg<typeof registerWebSettings>)(SettingsRegistry as unknown as Parameters<typeof registerWebSettings>[0], this.plugin);
        // Settings→Prompt (global prompt defaults - work prompts + factory sections).
        // Shell-owned; order 50 sits after Web (45), before No-Go (60).
        SettingsRegistry.register({
            id: 'prompt',
            label: t('settings.prompt_label'),
            icon: '📝',
            order: 50,
            render: (containerEl: HTMLElement, _plugin: PluginApi, options: { owner: { buildSectionContext(): ShellSectionCtx } }) => renderPromptSection(containerEl, options.owner.buildSectionContext() as unknown as Parameters<typeof renderPromptSection>[1]),
        });
        (registerMcpSettings as WithDeadArg<typeof registerMcpSettings>)(SettingsRegistry as unknown as Parameters<typeof registerMcpSettings>[0], this.plugin);
        (registerCrystalSoulSettings as WithDeadArg<typeof registerCrystalSoulSettings>)(SettingsRegistry as unknown as Parameters<typeof registerCrystalSoulSettings>[0], this.plugin);
        this._settingsSectionsRegistered = true;
    }

    /**
     * TS-boundary: worek DI współdzielony przez WSZYSTKIE sekcje ustawień (core/models/memory/
     * tools/web/vault/prompt/crystal-soul) - każdy owner-modul ma WŁASNY, węższy typ Ctx nad tym
     * samym obiektem (np. `modules/models/SettingsContent.ts:ModelsSectionCtx`). Zwrotka jest
     * `ShellSectionCtx` (patrz definicja niżej), nie gołym `SettingsSectionCtx` z core - core widzi
     * węższy `pkm: PkmSettingsSlice` (nieeksportowany) i nie zna w ogóle `availablePlatforms`/
     * `MCPServerEditorModal`/`ClaudeImportModal` (ADR 003: core nie importuje z modules/), a ten
     * worek je realnie niesie dla sekcji spoza core. Jedna asercja całego zwracanego obiektu
     * zamiast rozbijania pól z osobna, bo żaden pojedynczy typ nie opisuje THIS worka w całości.
     */
    buildSectionContext(): ShellSectionCtx {
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
        } as unknown as ShellSectionCtx;
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
