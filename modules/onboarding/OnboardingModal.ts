/**
 * OnboardingModal — 3-step wizard for first-run setup.
 * Step 1: Welcome — choose API (cloud) or Local path
 * Step 2a: Cloud — pick provider, enter API key, test connection
 * Step 2b: Local — auto-detect Ollama/LM Studio
 * Step 3: Done — open chat with Jaskier
 *
 * Saves API key + sets default model in modelLibrary.
 * Triggered from main.js on first run (replaces auto-open chat).
 */
import { Modal, Notice, requestUrl } from 'obsidian';
import { UiIcons, setSvg } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import type { App, RequestUrlParam } from 'obsidian';

type CloudProvider = {
    id: string;
    name: string;
    placeholder: string;
    labelKey?: string;
    signupUrl: string;
    defaultModel: string;
};

type LocalProvider = {
    id: string;
    name: string;
    host: string;
    modelsEndpoint: string;
};

type LocalModel = { name: string; size: string };
type ConnectionResult = { ok: boolean; message: string };
type ModelChoice = { platform: string; model: string; isDefault: boolean };
type OnboardingSettings = {
    pkmAssistant?: {
        chat?: {
            platform?: string;
            apiKeys?: Record<string, string>;
            models?: Record<string, string>;
            hosts?: Record<string, string>;
        };
        modelLibrary?: {
            main?: ModelChoice[];
            minion?: ModelChoice[];
        };
        onboardingCompleted?: number;
    };
};
type OnboardingPlugin = {
    env: {
        settings?: OnboardingSettings;
        settingsStore?: {
            settings?: OnboardingSettings;
            save: () => Promise<unknown>;
        };
    };
    settings?: OnboardingSettings;
    openChatView(): void;
};
type CloudEndpoint = {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
};
type LocalDiscoveryResponse = {
    models?: Array<{ name?: string; model?: string; size?: number }>;
    data?: Array<{ id: string }>;
};
type ErrLike = { message?: string };

/** Cloud providers with signup URLs */
const CLOUD_PROVIDERS: CloudProvider[] = [
    { id: 'deepseek', name: 'DeepSeek', placeholder: 'sk-...', labelKey: 'onboarding.label_cheapest', signupUrl: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-chat' },
    { id: 'open_router', name: 'OpenRouter', placeholder: 'sk-or-...', labelKey: 'onboarding.label_many_models', signupUrl: 'https://openrouter.ai/keys', defaultModel: 'deepseek/deepseek-chat-v3-0324' },
    { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-...', labelKey: 'onboarding.label_most_capable', signupUrl: 'https://console.anthropic.com/settings/keys', defaultModel: 'claude-sonnet-4-20250514' },
];

const OTHER_CLOUD_PROVIDERS: CloudProvider[] = [
    { id: 'openai', name: 'OpenAI', placeholder: 'sk-...', signupUrl: 'https://platform.openai.com/api-keys', defaultModel: 'gpt-4o-mini' },
    { id: 'gemini', name: 'Google Gemini', placeholder: 'AIza...', signupUrl: 'https://aistudio.google.com/apikey', defaultModel: 'gemini-2.0-flash' },
    { id: 'groq', name: 'Groq', placeholder: 'gsk_...', signupUrl: 'https://console.groq.com/keys', defaultModel: 'llama-3.3-70b-versatile' },
    { id: 'xai', name: 'xAI (Grok)', placeholder: 'xai-...', signupUrl: 'https://console.x.ai/', defaultModel: 'grok-3-mini' },
];

/** Local providers */
const LOCAL_PROVIDERS: LocalProvider[] = [
    { id: 'ollama', name: 'Ollama', host: 'http://localhost:11434', modelsEndpoint: '/api/tags' },
    { id: 'lm_studio', name: 'LM Studio', host: 'http://localhost:1234', modelsEndpoint: '/v1/models' },
];

export class OnboardingModal extends Modal {
    declare plugin: OnboardingPlugin;
    declare step: number;
    declare _selectedProvider: CloudProvider | null;
    declare _selectedLocal: LocalProvider | null;
    declare _apiKey: string;
    declare _localModels: LocalModel[];
    declare _selectedLocalModel: string;
    declare _testResult: ConnectionResult | null;
    declare _localDetecting?: boolean;
    declare _localError?: string | null;
    declare _savedPlatform?: string;
    declare _savedPlatformName?: string;
    declare _savedModel?: string;

    /**
     * @param {import('obsidian').App} app
     * @param {Object} plugin - PKM Assistant plugin instance
     */
    constructor(app: App, plugin: OnboardingPlugin) {
        super(app);
        this.plugin = plugin;
        this.step = 1;
        this._selectedProvider = null;
        this._selectedLocal = null;
        this._apiKey = '';
        this._localModels = [];
        this._selectedLocalModel = '';
        this._testResult = null;
    }

    onOpen(): void {
        this.modalEl.addClass('pkm-onboarding-modal');
        this._render();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    // ═══════════════════════════════════════════
    // RENDERING
    // ═══════════════════════════════════════════

    _render(): void {
        const { contentEl } = this;
        contentEl.empty();

        switch (this.step) {
            case 1: this._renderStep1(contentEl); break;
            case 2: this._renderStep2Cloud(contentEl); break;
            case 3: this._renderStep2Local(contentEl); break;
            case 4: this._renderStep3Done(contentEl); break;
        }
    }

    // ── Step 1: Welcome ──
    _renderStep1(el: HTMLElement): void {
        const header = el.createDiv('pkm-onboarding-header');
        header.createEl('h2', { text: t('onboarding.welcome') });
        header.createEl('p', {
            text: t('onboarding.subtitle'),
            cls: 'pkm-onboarding-subtitle'
        });

        const cards = el.createDiv('pkm-onboarding-cards');

        // Cloud card
        const cloudCard = cards.createDiv('pkm-onboarding-card');
        cloudCard.addEventListener('click', () => { this.step = 2; this._render(); });
        const cloudIcon = cloudCard.createDiv('pkm-onboarding-card-icon');
        setSvg(cloudIcon, UiIcons.cloud?.(32) || '☁️');
        cloudCard.createEl('h3', { text: t('onboarding.via_api') });
        cloudCard.createEl('p', { text: t('onboarding.api_desc') });

        // Local card
        const localCard = cards.createDiv('pkm-onboarding-card');
        localCard.addEventListener('click', () => { this.step = 3; this._render(); });
        const localIcon = localCard.createDiv('pkm-onboarding-card-icon');
        setSvg(localIcon, UiIcons.home?.(32) || '🏠');
        localCard.createEl('h3', { text: t('onboarding.locally') });
        localCard.createEl('p', { text: t('onboarding.local_desc') });

        // Skip link
        const skip = el.createDiv('pkm-onboarding-skip');
        const skipLink = skip.createEl('a', { text: t('onboarding.skip'), href: '#' });
        skipLink.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            this._finishAndOpenChat();
        });
    }

    // ── Step 2: Cloud providers ──
    _renderStep2Cloud(el: HTMLElement): void {
        const header = el.createDiv('pkm-onboarding-header');
        header.createEl('h2', { text: t('onboarding.connect_provider') });

        // Recommended providers
        const subtitle = header.createEl('p', { cls: 'pkm-onboarding-subtitle' });
        subtitle.textContent = t('onboarding.recommended');

        const provCards = el.createDiv('pkm-onboarding-provider-cards');
        for (const prov of CLOUD_PROVIDERS) {
            const card = provCards.createDiv({
                cls: `pkm-onboarding-provider-card${this._selectedProvider?.id === prov.id ? ' selected' : ''}`
            });
            card.addEventListener('click', () => {
                this._selectedProvider = prov;
                this._testResult = null;
                this._render();
            });
            card.createEl('strong', { text: prov.name });
            if (prov.labelKey) card.createSpan({ text: t(prov.labelKey), cls: 'pkm-onboarding-provider-label' });
        }

        // Other providers toggle
        const otherToggle = el.createDiv('pkm-onboarding-other-toggle');
        const otherLink = otherToggle.createEl('a', { text: t('onboarding.others'), href: '#' });
        otherLink.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            const existing = el.querySelector('.pkm-onboarding-other-providers');
            if (existing) { existing.remove(); return; }

            const otherCards = el.createDiv('pkm-onboarding-other-providers');
            for (const prov of OTHER_CLOUD_PROVIDERS) {
                const card = otherCards.createDiv({
                    cls: `pkm-onboarding-provider-card${this._selectedProvider?.id === prov.id ? ' selected' : ''}`
                });
                card.addEventListener('click', () => {
                    this._selectedProvider = prov;
                    this._testResult = null;
                    this._render();
                });
                card.createEl('strong', { text: prov.name });
            }
            // Move before footer
            const footer = el.querySelector('.pkm-onboarding-footer');
            if (footer) el.insertBefore(otherCards, footer);
        });

        // API key input (only if provider selected)
        if (this._selectedProvider) {
            const keySection = el.createDiv('pkm-onboarding-key-section');

            const keyLabel = keySection.createEl('label', { text: t('onboarding.api_key') });
            keyLabel.setAttribute('for', 'pkm-onboarding-key-input');

            const keyInput = keySection.createEl('input', {
                type: 'password',
                placeholder: this._selectedProvider.placeholder,
                value: this._apiKey,
            });
            keyInput.id = 'pkm-onboarding-key-input';
            keyInput.addClass('pkm-onboarding-key-input');
            keyInput.addEventListener('input', (e: Event) => { this._apiKey = (e.target as HTMLInputElement).value; });

            // Signup link
            const signupLink = keySection.createEl('a', {
                text: t('onboarding.how_to_get_key'),
                href: this._selectedProvider.signupUrl,
                cls: 'pkm-onboarding-signup-link'
            });
            signupLink.setAttr('target', '_blank');

            // Security note
            const secNote = keySection.createDiv('pkm-onboarding-security-note');
            setSvg(secNote, UiIcons.lock?.(14) || '🔒');
            secNote.appendText(' ');
            secNote.createSpan({ text: t('onboarding.key_privacy') });

            // Test button
            const testRow = keySection.createDiv('pkm-onboarding-test-row');
            const testBtn = testRow.createEl('button', { text: t('onboarding.test_connection'), cls: 'mod-cta' });
            testBtn.addEventListener('click', () => { void this._testCloudConnection(); });

            // Test result
            if (this._testResult) {
                const resultDiv = testRow.createDiv(`pkm-onboarding-test-result ${this._testResult.ok ? 'success' : 'error'}`);
                resultDiv.textContent = this._testResult.message;
            }

            window.setTimeout(() => keyInput.focus(), 50);
        }

        // Footer with navigation
        const footer = el.createDiv('pkm-onboarding-footer');
        const backBtn = footer.createEl('button', { text: t('onboarding.back') });
        backBtn.addEventListener('click', () => { this.step = 1; this._render(); });

        if (this._testResult?.ok) {
            const nextBtn = footer.createEl('button', { text: t('onboarding.next'), cls: 'mod-cta' });
            nextBtn.addEventListener('click', () => { void this._saveCloudAndFinish(); });
        }
    }

    // ── Step 2b: Local providers ──
    _renderStep2Local(el: HTMLElement): void {
        const header = el.createDiv('pkm-onboarding-header');
        header.createEl('h2', { text: t('onboarding.local_models') });

        const provCards = el.createDiv('pkm-onboarding-provider-cards');
        for (const prov of LOCAL_PROVIDERS) {
            const card = provCards.createDiv({
                cls: `pkm-onboarding-provider-card${this._selectedLocal?.id === prov.id ? ' selected' : ''}`
            });
            card.addEventListener('click', () => {
                void (async () => {
                    this._selectedLocal = prov;
                    this._localModels = [];
                    this._selectedLocalModel = '';
                    this._render();
                    await this._detectLocalModels(prov);
                })();
            });
            card.createEl('strong', { text: prov.name });
        }

        // Detection results
        if (this._selectedLocal) {
            const detectSection = el.createDiv('pkm-onboarding-detect-section');

            if (this._localDetecting) {
                detectSection.createEl('p', { text: t('onboarding.searching', { name: this._selectedLocal.name }), cls: 'pkm-onboarding-detecting' });
            } else if (this._localError) {
                const errorDiv = detectSection.createDiv('pkm-onboarding-test-result error');
                errorDiv.textContent = this._localError;

                const hint = detectSection.createDiv('pkm-onboarding-local-hint');
                if (this._selectedLocal.id === 'ollama') {
                    hint.createEl('p', { text: t('onboarding.ollama_not_found') });
                    const ollamaList = hint.createEl('ol');
                    const installLi = ollamaList.createEl('li', { text: `${t('onboarding.ollama_installed')} (` });
                    installLi.createEl('a', { text: 'ollama.ai', href: 'https://ollama.ai' }).setAttr('target', '_blank');
                    installLi.appendText(')');
                    ollamaList.createEl('li', { text: t('onboarding.ollama_running') });
                    ollamaList.createEl('li', { text: t('onboarding.ollama_model') });
                } else {
                    hint.createEl('p', { text: t('onboarding.lm_not_found') });
                    const lmList = hint.createEl('ol');
                    lmList.createEl('li', { text: t('onboarding.lm_running') });
                    lmList.createEl('li', { text: t('onboarding.lm_server') });
                }
            } else if (this._localModels.length > 0) {
                const successDiv = detectSection.createDiv('pkm-onboarding-test-result success');
                successDiv.textContent = t('onboarding.local_works', { name: this._selectedLocal.name });

                detectSection.createEl('p', { text: t('onboarding.available_models'), cls: 'pkm-onboarding-models-label' });

                const modelList = detectSection.createDiv('pkm-onboarding-model-list');
                for (const model of this._localModels) {
                    const modelItem = modelList.createDiv({
                        cls: `pkm-onboarding-model-item${this._selectedLocalModel === model.name ? ' selected' : ''}`
                    });
                    modelItem.addEventListener('click', () => {
                        this._selectedLocalModel = model.name;
                        this._render();
                    });

                    const radio = modelItem.createSpan({ cls: 'pkm-onboarding-radio' });
                    radio.textContent = this._selectedLocalModel === model.name ? '●' : '○';
                    modelItem.createSpan({ text: model.name, cls: 'pkm-onboarding-model-name' });
                    if (model.size) {
                        modelItem.createSpan({ text: model.size, cls: 'pkm-onboarding-model-size' });
                    }
                }
            }
        }

        // Footer
        const footer = el.createDiv('pkm-onboarding-footer');
        const backBtn = footer.createEl('button', { text: t('onboarding.back') });
        backBtn.addEventListener('click', () => { this.step = 1; this._render(); });

        if (this._selectedLocalModel) {
            const nextBtn = footer.createEl('button', { text: t('onboarding.next'), cls: 'mod-cta' });
            nextBtn.addEventListener('click', () => { void this._saveLocalAndFinish(); });
        }
    }

    // ── Step 3: Done ──
    _renderStep3Done(el: HTMLElement): void {
        const header = el.createDiv('pkm-onboarding-header pkm-onboarding-done');
        const checkIcon = header.createDiv('pkm-onboarding-done-icon');
        setSvg(checkIcon, UiIcons.check?.(32) || '✅');
        header.createEl('h2', { text: t('onboarding.all_ready') });

        const info = el.createDiv('pkm-onboarding-done-info');
        if (this._savedPlatform) {
            info.createEl('p', { text: t('onboarding.model_info', { model: this._savedModel }) });
            info.createEl('p', { text: t('onboarding.provider_info', { platform: this._savedPlatformName }) });
        }
        info.createEl('p', { text: t('onboarding.jaskier_ready') });

        const hint = el.createDiv('pkm-onboarding-done-hint');
        hint.createEl('p', { text: t('onboarding.first_message') });

        const footer = el.createDiv('pkm-onboarding-footer');
        const openChat = footer.createEl('button', { text: t('onboarding.open_chat'), cls: 'mod-cta' });
        openChat.addEventListener('click', () => this._finishAndOpenChat());
    }

    // ═══════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════

    async _testCloudConnection(): Promise<void> {
        if (!this._apiKey.trim()) {
            this._testResult = { ok: false, message: t('onboarding.enter_key') };
            this._render();
            return;
        }

        const prov = this._selectedProvider;
        this._testResult = { ok: false, message: t('onboarding.testing') };
        this._render();

        try {
            const result = await this._pingCloudProvider(prov!.id, this._apiKey.trim());
            this._testResult = result;
        } catch (e) {
            this._testResult = { ok: false, message: t('onboarding.error', { error: (e as ErrLike).message }) };
        }
        this._render();
    }

    /**
     * Simple connectivity test per provider — tries to list models or make a tiny request.
     */
    async _pingCloudProvider(platformId: string, apiKey: string): Promise<ConnectionResult> {
        const endpoints: Record<string, CloudEndpoint> = {
            anthropic: { url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) },
            openai: { url: 'https://api.openai.com/v1/models', headers: { 'Authorization': `Bearer ${apiKey}` } },
            deepseek: { url: 'https://api.deepseek.com/v1/models', headers: { 'Authorization': `Bearer ${apiKey}` } },
            gemini: { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}` },
            groq: { url: 'https://api.groq.com/openai/v1/models', headers: { 'Authorization': `Bearer ${apiKey}` } },
            xai: { url: 'https://api.x.ai/v1/models', headers: { 'Authorization': `Bearer ${apiKey}` } },
            open_router: { url: 'https://openrouter.ai/api/v1/models', headers: { 'Authorization': `Bearer ${apiKey}` } },
        };

        const config = endpoints[platformId];
        if (!config) return { ok: false, message: t('onboarding.unknown_platform') };

        const reqOpts: RequestUrlParam = { url: config.url, method: config.method || 'GET', headers: config.headers || {}, throw: false };
        if (config.body) reqOpts.body = config.body;

        try {
            const resp = await Promise.race([
                requestUrl(reqOpts),
                new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Timeout')), 15000))
            ]);

            if (resp.status >= 200 && resp.status < 300) {
                return { ok: true, message: t('onboarding.connected') };
            }
            if (resp.status === 401 || resp.status === 403) {
                return { ok: false, message: t('onboarding.invalid_key') };
            }
            // 400 from Anthropic means auth passed but request was bad — that's OK for a ping
            if (resp.status === 400 && platformId === 'anthropic') {
                return { ok: true, message: t('onboarding.connected') };
            }
            return { ok: false, message: t('onboarding.server_error', { status: resp.status }) };
        } catch (e) {
            if ((e as ErrLike).message === 'Timeout') return { ok: false, message: t('onboarding.timeout') };
            return { ok: false, message: t('onboarding.connection_error', { error: (e as ErrLike).message }) };
        }
    }

    async _detectLocalModels(prov: LocalProvider): Promise<void> {
        this._localDetecting = true;
        this._localError = null;
        this._render();

        try {
            const resp = await Promise.race([
                requestUrl({ url: `${prov.host}${prov.modelsEndpoint}`, method: 'GET', throw: false }),
                new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);

            if (resp.status < 200 || resp.status >= 300) throw new Error(`Status ${resp.status}`);

            const data: LocalDiscoveryResponse = resp.json;

            // Ollama returns { models: [...] }, OpenAI-compatible returns { data: [...] }
            let models: LocalModel[] = [];
            if (data.models) {
                models = data.models.map((m: { name?: string; model?: string; size?: number }) => ({
                    name: (m.name || m.model) as string,
                    size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '',
                }));
            } else if (data.data) {
                models = data.data.map((m: { id: string }) => ({
                    name: m.id,
                    size: '',
                }));
            }

            this._localModels = models;
            this._localDetecting = false;

            // Auto-select first model
            if (models.length > 0 && !this._selectedLocalModel) {
                this._selectedLocalModel = models[0].name;
            }
        } catch {
            this._localDetecting = false;
            this._localError = t('onboarding.local_connect_error', { name: prov.name, host: prov.host });
            this._localModels = [];
        }

        this._render();
    }

    // ═══════════════════════════════════════════
    // SAVE & FINISH
    // ═══════════════════════════════════════════

    async _saveCloudAndFinish(): Promise<void> {
        const prov = this._selectedProvider;
        const key = this._apiKey.trim();
        if (!prov || !key) return;

        try {
            const settings = this.plugin.env?.settings;
            if (!settings) { new Notice(t('onboarding.save_error')); return; }

            // Set default model in library
            const pkm = settings.pkmAssistant || {};
            // Save API key
            const chatSettings = pkm.chat || {};
            chatSettings.apiKeys = { ...(chatSettings.apiKeys || {}), [prov.id]: key };
            chatSettings.platform = prov.id;
            chatSettings.models = { ...(chatSettings.models || {}), [prov.id]: prov.defaultModel };
            pkm.chat = chatSettings;
            pkm.modelLibrary = pkm.modelLibrary || {};
            pkm.modelLibrary.main = [{ platform: prov.id, model: prov.defaultModel, isDefault: true }];
            // Also set minion to the same (user can change later)
            if (!pkm.modelLibrary.minion?.length) {
                pkm.modelLibrary.minion = [{ platform: prov.id, model: prov.defaultModel, isDefault: true }];
            }
            pkm.onboardingCompleted = Date.now();
            settings.pkmAssistant = pkm;

            await this.plugin.env.settingsStore?.save();

            this._savedPlatform = prov.id;
            this._savedPlatformName = prov.name;
            this._savedModel = prov.defaultModel;
            this.step = 4;
            this._render();
        } catch (e) {
            new Notice(t('onboarding.save_write_error', { error: (e as ErrLike).message }));
        }
    }

    async _saveLocalAndFinish(): Promise<void> {
        const prov = this._selectedLocal;
        const model = this._selectedLocalModel;
        if (!prov || !model) return;

        try {
            const settings = this.plugin.env?.settings;
            if (!settings) { new Notice(t('onboarding.save_error')); return; }

            // Set default model in library
            const pkm = settings.pkmAssistant || {};
            // Save host
            const chatSettings = pkm.chat || {};
            chatSettings.hosts = { ...(chatSettings.hosts || {}), [prov.id]: prov.host };
            chatSettings.platform = prov.id;
            chatSettings.models = { ...(chatSettings.models || {}), [prov.id]: model };
            pkm.chat = chatSettings;
            pkm.modelLibrary = pkm.modelLibrary || {};
            pkm.modelLibrary.main = [{ platform: prov.id, model: model, isDefault: true }];
            if (!pkm.modelLibrary.minion?.length) {
                pkm.modelLibrary.minion = [{ platform: prov.id, model: model, isDefault: true }];
            }
            pkm.onboardingCompleted = Date.now();
            settings.pkmAssistant = pkm;

            await this.plugin.env.settingsStore?.save();

            this._savedPlatform = prov.id;
            this._savedPlatformName = prov.name;
            this._savedModel = model;
            this.step = 4;
            this._render();
        } catch (e) {
            new Notice(t('onboarding.save_write_error', { error: (e as ErrLike).message }));
        }
    }

    _finishAndOpenChat(): void {
        // Oznacz onboarding jako ukończony (nawet przy skip)
        const settings = this.plugin.env?.settingsStore?.settings || this.plugin.settings;
        if (settings?.pkmAssistant) {
            settings.pkmAssistant.onboardingCompleted = Date.now();
            void this.plugin.env?.settingsStore?.save?.();
        }
        this.close();
        window.setTimeout(() => {
            this.plugin.openChatView();
        }, 300);
    }
}
