import { t } from '../../core/i18n/index.js';
import { isLocalPlatform } from './modelResolver.js';
import { setSvg, setSvgLabel } from '../../modules/crystal-soul/index.js';
import { log } from '../../core/utils/Logger.js';
import { computeSemanticStatusText } from './semanticStatusText.js';
// `import type` = ZERO emitu (esbuild i tsx wycinają go w całości). Same wartości
// `Setting`/`Notice` przychodzą tu przez ctx (DI z `modules/shell/pkm_settings_tab`).
import type { App, Notice as ObsidianNotice, Setting as ObsidianSetting } from 'obsidian';
import type { EmbeddingSettingsSlice } from '../../core/index.js';
import type { ChatSettingsSlice, ModelLibraryEntry } from './contracts.js';

/** Błąd złapany w `catch` - `unknown`, więc nazywamy tylko pole, po które sięga kod. */
type ErrLike = { message?: string };

/** Kolekcja ikon (UiIcons z `modules/crystal-soul`) - każda zwraca gotowy SVG. */
type IconSet = Record<string, (size?: number) => string>;

/** Ustawienia embeddingu (slice `settings.pkmAssistant.embedding`) - właściciel typu: `core`. */
type EmbedModelSettings = EmbeddingSettingsSlice;

/** Stan indeksera semantycznego (`plugin.vaultIndexer`). */
type IndexerStatus = {
    status?: string;
    progress?: { indexed?: number; total?: number };
    lastError?: string;
};

/** Indekser wstrzyknięty na pluginie - sekcja czyta status i umie zlecić przebudowę. */
type VaultIndexerLike = {
    getStatus?: () => IndexerStatus | null | undefined;
    rebuild: () => Promise<IndexerStatus>;
    /** Pliki pominięte po wyczerpaniu prób (`modules/embedding` gotcha 12) - realny `Set<string>`. */
    skipped?: { size: number };
};

/** Zakładka ustawień, która wywołała render (shell: `pkm_settings_tab`). */
type ModelsSettingsOwner = {
    app: App;
    display: () => void;
    get_platform_name: (platform: string) => string;
    _syncLegacyModelKeys: (pkm: ModelsSectionCtx['pkm'], chat: ModelsSectionCtx['chat']) => void;
    _getEmbedModelKey: (provider: string, embedding: EmbedModelSettings) => string | undefined;
    _setEmbedModelKey: (provider: string, value: string, embedding: EmbedModelSettings) => void;
};

/**
 * Worek DI budowany przez `pkm_settings_tab.buildSectionContext()`. Ten moduł czyta z niego
 * tylko swój wycinek - obsidianowe klasy (`Setting`, `Notice`) wchodzą tędy, bo sekcja jest
 * ładowana także w środowisku bez Obsidiana.
 */
export type ModelsSectionCtx = {
    /** slice `settings.pkmAssistant.chat` - sekcja Modele rusza z niego temperaturę i limit */
    chat: ChatSettingsSlice;
    /** slice `settings.pkmAssistant` */
    pkm: {
        modelLibrary?: Record<string, ModelLibraryEntry[]>;
        maxTokens?: Record<string, number>;
        ollama_keep_alive?: string;
    };
    /** platformy z wpisanym kluczem API (liczy je shell) */
    availablePlatforms: Array<{ id: string; name: string }>;
    env: { settings: { pkmAssistant: { embedding?: EmbedModelSettings } } };
    owner: ModelsSettingsOwner;
    /** `oramaDb` - publikowany przez `VaultIndexer`; `unknown` bo `AnyOrama` nie jest publicznym typem `models`. */
    plugin?: { vaultIndexer?: VaultIndexerLike | null; oramaDb?: unknown } | null;
    save: () => Promise<void> | void;
    icons: IconSet;
    Setting: typeof ObsidianSetting;
    Notice: typeof ObsidianNotice;
};

export async function renderModelsSection(container: HTMLElement, ctx: ModelsSectionCtx): Promise<void> {
    const { chat, pkm, availablePlatforms, env, owner, plugin, save, icons, Setting, Notice } = ctx;
    container.classList.add('cs-root');
        const h2Models = container.createEl('h2', { cls: 'cs-settings-section' });
        setSvgLabel(h2Models, icons.robot(18), t('settings.models_title'));
        container.createEl('p', { text: t('settings.models_desc'), cls: 'setting-item-description' });

        // Initialize library if missing
        if (!pkm.modelLibrary) pkm.modelLibrary = { main: [], minion: [] };
        const lib = pkm.modelLibrary;

        // Klucz storage 'minion' = historyczna nazwa slotu sub-agenta (zero migracji danych).
        const roles = [
            { key: 'main', label: t('settings.role_main'), desc: t('settings.role_main_desc') },
            { key: 'minion', label: t('settings.role_sub_agent'), desc: t('settings.role_sub_agent_desc') },
        ];

        for (const role of roles) {
            container.createEl('h4', { text: role.label });
            container.createEl('p', { text: role.desc, cls: 'setting-item-description' });

            if (!lib[role.key]) lib[role.key] = [];
            const models = lib[role.key];

            // List existing models for this role
            for (let i = 0; i < models.length; i++) {
                const m = models[i];
                const isDefault = !!m.isDefault;
                const dot = isDefault ? icons.dotGreen(12) : icons.dotGray(12);

                const s = new Setting(container);
                const isLocal = isLocalPlatform(m.platform);
                // Build the name via DOM APIs - the model name (m.model) is typed by the
                // user and MUST NOT be inserted as raw HTML (stored-XSS vector). Only the
                // status dot is a static, plugin-controlled SVG string.
                s.nameEl.empty();
                setSvg(s.nameEl.createSpan(), dot);
                s.nameEl.appendText(` ${owner.get_platform_name(m.platform)} — ${m.model} `);
                s.nameEl.createSpan({
                    text: isLocal ? t('settings.badge_local') : t('settings.badge_cloud'),
                    cls: `pkm-model-badge ${isLocal ? 'pkm-model-badge--local' : 'pkm-model-badge--cloud'}`,
                });
                s.setDesc(isDefault ? t('settings.default_label') : '');

                if (!isDefault) {
                    s.addButton(btn => btn
                        .setButtonText(t('settings.set_default'))
                        .onClick(async () => {
                            models.forEach(x => x.isDefault = false);
                            m.isDefault = true;
                            owner._syncLegacyModelKeys(pkm, chat);
                            await save();
                            owner.display();
                        })
                    );
                }
                s.addExtraButton(btn => btn
                    .setIcon('trash')
                    .setTooltip(t('generic.delete'))
                    .onClick(async () => {
                        models.splice(i, 1);
                        if (models.length > 0 && !models.some(x => x.isDefault)) {
                            models[0].isDefault = true;
                        }
                        owner._syncLegacyModelKeys(pkm, chat);
                        await save();
                        owner.display();
                    })
                );
            }

            if (models.length === 0) {
                container.createEl('p', {
                    text: t('settings.no_models'),
                    cls: ['setting-item-description', 'pkm-model-empty-hint']
                });
            }

            // Add new model form
            {
                const addRow = container.createDiv({ cls: 'pkm-model-add-row' });

                const platformSelect = addRow.createEl('select', { cls: 'pkm-model-select' });
                if (availablePlatforms.length === 0) {
                    platformSelect.createEl('option', { value: '', text: t('settings.no_platforms') });
                } else {
                    for (const ap of availablePlatforms) {
                        platformSelect.createEl('option', { value: ap.id, text: ap.name });
                    }
                }

                const modelInput = addRow.createEl('input', { type: 'text', placeholder: t('settings.model_name_placeholder'), cls: 'pkm-model-name-input' });

                const addBtn = addRow.createEl('button', { text: t('settings.add_model'), cls: 'mod-cta pkm-model-add-btn' });
                addBtn.addEventListener('click', () => {
                    void (async () => {
                        const platform = platformSelect.value;
                        const model = modelInput.value.trim();
                        if (!platform || !model) {
                            new Notice(t('settings.notice_select_platform'));
                            return;
                        }
                        // Avoid duplicates
                        if (models.some(m => m.platform === platform && m.model === model)) {
                            new Notice(t('settings.notice_model_exists'));
                            return;
                        }
                        const isFirst = models.length === 0;
                        models.push({ platform, model, isDefault: isFirst });
                        owner._syncLegacyModelKeys(pkm, chat);
                        await save();
                        owner.display();
                    })();
                });
            }
        }

        // Main-specific settings (temperatura, max tokens)
        new Setting(container)
            .setName(t('settings.temperature'))
            .setDesc(t('settings.temperature_desc'))
            .addSlider(slider => {
                slider
                    .setLimits(0, 1, 0.1)
                    .setValue(chat.temperature ?? 0.7)
                    // no-deprecated: setDynamicTooltip() jest przestarzałe - wartość jest dziś
                    // ZAWSZE pokazywana inline obok suwaka (Obsidian core), więc wywołanie
                    // wygasło jako no-op i po prostu je usuwamy.
                    .onChange(async (value) => {
                        chat.temperature = value;
                        await save();
                    });
            });

        new Setting(container)
            .setName(t('settings.max_tokens'))
            .setDesc(t('settings.max_tokens_desc'))
            .addText(text => {
                text
                    .setPlaceholder('4096')
                    .setValue(String(chat.maxTokens || 4096))
                    .onChange(async (value) => {
                        chat.maxTokens = parseInt(value) || 4096;
                        await save();
                    });
                text.inputEl.addClass('pkm-setting-input--w100');
            });

        pkm.maxTokens = pkm.maxTokens || {};
        const tokenDefaults: Array<[string, number]> = [
            ['anthropic', 8192],
            ['openai', 16384],
            ['xai', 8192],
            ['ollama', 4096],
            ['gemini', 8192],
        ];
        for (const [platform, def] of tokenDefaults) {
            new Setting(container)
                .setName(`max_tokens: ${platform}`)
                .setDesc('Zaawansowane: domyślny limit odpowiedzi dla tej platformy.')
                .addText(text => {
                    text
                        .setPlaceholder(String(def))
                        .setValue(String(pkm.maxTokens![platform] || def))
                        .onChange(async (value) => {
                            pkm.maxTokens![platform] = parseInt(value) || def;
                            await save();
                        });
                    text.inputEl.addClass('pkm-setting-input--w100');
                });
        }

        new Setting(container)
            .setName('Ollama keep_alive')
            .setDesc('Jak długo Ollama ma trzymać model w RAM po odpowiedzi.')
            .addText(text => {
                text
                    .setPlaceholder('60m')
                    .setValue(pkm.ollama_keep_alive || '60m')
                    .onChange(async (value) => {
                        pkm.ollama_keep_alive = value.trim() || '60m';
                        await save();
                    });
                text.inputEl.addClass('pkm-setting-input--w100');
            });

        // Embedding model
        container.createEl('h4', { text: t('settings.embedding_title') });
        container.createEl('p', { text: t('settings.embedding_desc'), cls: 'setting-item-description' });

        const embedSettings: EmbedModelSettings = env.settings.pkmAssistant.embedding || {};
        const currentEmbedProvider = embedSettings.provider || '';

        const embedPlatforms = [
            { id: '', name: t('settings.embed_platform_none') },
            { id: 'openai', name: 'OpenAI' },
            { id: 'ollama', name: 'Ollama' },
            { id: 'gemini', name: 'Google Gemini' },
            { id: 'lm_studio', name: 'LM Studio' },
        ];

        new Setting(container)
            .setName(t('settings.embed_platform'))
            .addDropdown(dropdown => {
                for (const ep of embedPlatforms) {
                    dropdown.addOption(ep.id, ep.name);
                }
                dropdown
                    .setValue(currentEmbedProvider)
                    .onChange(async (value) => {
                        if (!env.settings.pkmAssistant.embedding) {
                            env.settings.pkmAssistant.embedding = {};
                        }
                        env.settings.pkmAssistant.embedding.provider = value;
                        await save();
                        owner.display();
                    });
            });

        const embedModelKey = owner._getEmbedModelKey(currentEmbedProvider, embedSettings);
        const embedDefaults: Record<string, string> = {
            openai: 'text-embedding-3-small',
            ollama: 'nomic-embed-text',
            gemini: 'text-embedding-004',
            lm_studio: 'nomic-embed-text-v1.5',
        };

        new Setting(container)
            .setName(t('settings.embed_model'))
            .setDesc(t('settings.embed_model_desc', { model: embedModelKey || embedDefaults[currentEmbedProvider] || 'default' }))
            .addText(text => {
                text
                    .setPlaceholder(embedDefaults[currentEmbedProvider] || '')
                    .setValue(embedModelKey || '')
                    .onChange(async (value) => {
                        owner._setEmbedModelKey(currentEmbedProvider, value.trim(), env.settings.pkmAssistant.embedding ?? {});
                        await save();
                    });
                text.inputEl.addClass('pkm-setting-input--w250');
            });

        // ─── Status żywej semantyki (VaultIndexer → plugin.oramaDb) ───
        // `progress.total` liczy pliki PRZESKANOWANE, nie wektory faktycznie w indeksie - przy
        // padzie pierwszego skanu (indeks pusty, `_publish()` z zerowym db) status dalej mówił
        // "Aktywne". Prawda o zawartości indeksu to `countDocs(plugin.oramaDb)`. Import dynamiczny
        // - jak `migrateSCToOrama` niżej - `models` nie ma statycznej zależności od `embedding`.
        const semStatus = plugin?.vaultIndexer?.getStatus?.();
        const { countDocs } = await import('../embedding/index.js');
        const semDocsCount = countDocs(plugin?.oramaDb as never);
        const { text: semStatusText } = computeSemanticStatusText(
            semStatus ? {
                status: semStatus.status,
                total: semStatus.progress?.total ?? 0,
                indexed: semStatus.progress?.indexed ?? 0,
                docs: semDocsCount,
                lastError: semStatus.lastError,
                skipped: plugin?.vaultIndexer?.skipped?.size ?? 0,
            } : null,
            t,
        );
        new Setting(container)
            .setName(t('settings.semantic_status'))
            .setDesc(semStatusText);

        const reindexSetting = new Setting(container)
            .setName(t('settings.reindex'))
            .setDesc(t('settings.reindex_desc'));

        reindexSetting.addButton(btn => {
            btn.setButtonText(t('settings.reindex_btn'))
                .setCta()
                .onClick(async () => {
                    const idx = plugin?.vaultIndexer;
                    if (!idx) { new Notice(t('settings.reindex_no_indexer')); return; }
                    btn.setDisabled(true);
                    btn.setButtonText(t('settings.reindex_progress'));
                    // Potwierdzenie kosztów: rebuild embeduje KAŻDĄ notatkę od nowa
                    // (przy chmurowym providerze i dużym vaultcie to realny koszt API + czas).
                    new Notice(t('settings.reindex_confirm'), 9000);
                    try {
                        const status = await idx.rebuild();
                        if (status.status === 'ready') {
                            new Notice(t('settings.reindex_done', { count: status.progress?.total ?? 0 }));
                        } else if (status.status === 'no_provider') {
                            new Notice(t('settings.semantic_status_no_provider'));
                        } else if (status.status === 'disabled_mobile') {
                            new Notice(t('settings.semantic_status_mobile'));
                        } else if (status.status === 'error') {
                            new Notice(t('settings.reindex_error', { error: status.lastError || '?' }));
                        }
                    } catch (e) {
                        log.error('ModelsSettings', 'Re-index error:', e);
                        new Notice(t('settings.reindex_error', { error: (e as ErrLike).message }));
                    } finally {
                        btn.setDisabled(false);
                        btn.setButtonText(t('settings.reindex_btn'));
                        owner.display(); // odśwież linię statusu
                    }
                });
        });

        // Guzik migracji danych starego indeksu WYCIĘTY BEZ ZAMIENNIKA. Cały podsystem
        // migracji indeksu v1.x jest skasowany, nie przemianowany - nie dochodzą też
        // żadne nowe klucze i18n.


        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // SEKCJA 2: PAMIĘĆ I KONTEKST
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // Button „Migracja Agora → Komunikator" USUNIĘTY razem z Project Hubem
        // i migratorem. Zero kodu migracyjnego - plugin nigdy nie był wydany z Agorą.

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // SEKCJA 4: ROLE AGENTÓW
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
}
