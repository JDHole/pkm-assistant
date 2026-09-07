import { t } from './i18n/index.js';
import { log } from './utils/Logger.js';
import { maskKey } from './security/keySanitizer.js';
import { SecretsStorage } from './security/SecretsStorage.js';
import type { SecretsSettings, SecureStorageSlice } from './security/SecretsStorage.js';
import { getLimits, DEFAULT_LIMITS, LIMIT_SPECS, type LimitKey } from '../config/limits.js';
import type { ChatSettingsSlice } from './runtime/contracts.js';
// `import type` = ZERO emitu (esbuild i tsx wycinają go w całości) — barrel zostaje
// node-safe. Same wartości `Setting`/`Notice` przychodzą tu dalej przez ctx (DI).
import type { App, Notice as ObsidianNotice, Setting as ObsidianSetting } from 'obsidian';

// S31: `MasterPasswordModal` importuje `obsidian`, a ten plik wisi (przez
// SettingsSection.ts → registerSettings) na node-safe barrelu `core/index.js`.
// Statyczny import wciągałby `obsidian` do barrela i wywalał testy AVA (brak mocka).
// Reszta obsidianowych rzeczy (Setting/Notice) i tak przychodzi tu przez ctx (DI);
// modal ładujemy leniwie w miejscu użycia — jest w tym samym bundlu, więc zero
// różnicy w runtime.

/** Kolekcja ikon (UiIcons z `modules/crystal-soul`) — każda zwraca gotowy SVG. */
type IconSet = Record<string, (size?: number) => string>;

/** Slice `settings.pkmAssistant` w zakresie, w jakim dotykają go sekcje core. */
interface PkmSettingsSlice {
    defaultAutonomy?: string;
    extendedPromptRules?: boolean;
    komunikatorEnabled?: boolean;
    debugMode?: boolean;
    traceEnabled?: boolean;
    cacheTelemetryEnabled?: boolean;
    limits?: Record<string, number>;
    no_go_folders?: string[];
}

/** Fragment `ApprovalManagera` używany przez sekcję No-Go (sygnatury 1:1 z oryginałem). */
interface ApprovalManagerLike {
    getAllAlwaysApprovedRules?: () => Array<{ agentName: string; rule: string }>;
    removeFromAlwaysApproved: (agentName: string, actionType: string, targetPath: string | undefined) => void;
}

/** Plugin widziany przez sekcje core — X-3: bez martwych gałęzi wykluczeń i kolekcji źródeł. */
interface SettingsPluginLike {
    manifest: { version: string };
    secretsStorage?: SecretsStorage;
    approvalManager?: ApprovalManagerLike;
    env?: { settings?: { pkmAssistant?: { no_go_folders?: string[] } } | null } | null;
}

/** Zakładka ustawień, która wywołała render (shell: `pkm_settings_tab`). */
interface SettingsOwnerLike {
    app: App;
    display: () => void;
    /** który klucz API jest chwilowo odsłonięty (ikonka oka) */
    _showKeys: Record<string, boolean>;
}

/**
 * Worek DI budowany przez `pkm_settings_tab.buildSectionContext()`. Core nie importuje
 * z modułów (ADR 003), więc wszystko obsidianowe i modułowe wchodzi tędy.
 */
export interface SettingsSectionCtx {
    /** slice `settings.pkmAssistant.chat` — tu mieszkają klucze API (`apiKeys`) i hosty (`hosts`) */
    chat: ChatSettingsSlice;
    /** slice `settings.pkmAssistant` */
    pkm: PkmSettingsSlice;
    save: () => Promise<void> | void;
    owner: SettingsOwnerLike;
    plugin: SettingsPluginLike;
    env: { settings: SecretsSettings };
    icons?: IconSet;
    setSvg: (el: HTMLElement, svg: string) => void;
    setSvgLabel: (el: HTMLElement, svg: string, label: string) => void;
    Setting: typeof ObsidianSetting;
    Notice?: typeof ObsidianNotice;
    openCostTrackingModal: () => Promise<void> | void;
}

export function renderApiKeysSection(container: HTMLElement, ctx: SettingsSectionCtx): void {
    const { chat, save, owner, plugin, env, icons, setSvgLabel, Setting, Notice } = ctx;
    const apiKeys: Record<string, string> = (chat.apiKeys ??= {});
    const hosts: Record<string, string> = (chat.hosts ??= {});
    container.classList.add('cs-root');

    // Nagłówek sekcji jako Setting().setHeading() (obsidianmd/no-manual-html-headings) —
    // klasa cs-settings-section (flex + border, patrz modules/shell/sidebar/SidebarViews.css:2809)
    // zostaje na settingEl, ikonka+etykieta idą tym samym wzorcem co w innych miejscach tego
    // pliku (setSvgLabel(nameEl,...)).
    const h2Keys = new Setting(container).setHeading();
    h2Keys.settingEl.addClass('cs-settings-section');
    setSvgLabel(h2Keys.nameEl, icons?.key?.(18) || '', t('settings.api_keys_title'));

    const providers = [
        { id: 'anthropic', name: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
        { id: 'openai', name: 'OpenAI (GPT)', placeholder: 'sk-...' },
        { id: 'deepseek', name: 'DeepSeek', placeholder: 'sk-...' },
        { id: 'gemini', name: 'Google Gemini', placeholder: 'AIza...' },
        { id: 'groq', name: 'Groq', placeholder: 'gsk_...' },
        { id: 'xai', name: 'xAI (Grok)', placeholder: 'xai-...' },
        { id: 'open_router', name: 'OpenRouter', placeholder: 'sk-or-...' },
    ];

    const localProviders: Array<{ id: string; name: string; placeholder: string; settingKey: string }> = [
        { id: 'ollama', name: t('settings.local_ollama'), placeholder: 'http://localhost:11434', settingKey: 'ollama' },
        { id: 'lm_studio', name: t('settings.local_lm_studio'), placeholder: 'http://localhost:1234', settingKey: 'lm_studio' },
    ];

    const configuredCloud = providers.filter(p => !!apiKeys[p.id]).length;
    const configuredLocal = localProviders.filter(p => !!hosts[p.settingKey]).length;
    const configuredTotal = configuredCloud + configuredLocal;
    container.createEl('p', {
        text: t('settings.api_keys_configured', { count: configuredTotal, total: providers.length + localProviders.length }),
        cls: 'setting-item-description'
    });

    if (!env?.settings?.pkmAssistant) env.settings.pkmAssistant = {};
    // `!` w domknięciach niżej: gałąź wyżej gwarantuje, że `pkmAssistant` istnieje, ale TS
    // gubi to zawężenie na granicy każdego callbacka.
    const secureStorage: SecureStorageSlice = env.settings.pkmAssistant.secureStorage || {};
    const secrets = plugin?.secretsStorage || new SecretsStorage(owner.app);
    new Setting(container)
        .setName(t('settings.secure_storage_name'))
        .setDesc(t('settings.secure_storage_desc', { backend: secrets.backend }))
        .addToggle(toggle => toggle
            .setValue(secureStorage.enabled === true)
            .onChange(async (value) => {
                env.settings.pkmAssistant!.secureStorage = secureStorage;
                if (!value) {
                    secureStorage.enabled = false;
                    await save();
                    owner.display();
                    return;
                }
                if (secrets.backend === 'master-password') {
                    const { MasterPasswordModal } = await import('./security/MasterPasswordModal.js');
                    // AUD-testy-009 (uwaga review): próg z JEDNEJ stałej — trzecia kopia literału „12" kłamałaby przy zmianie polityki.
                    const { MASTER_PASSWORD_MIN_LENGTH } = await import('./security/masterPasswordPolicy.js');
                    const password = await MasterPasswordModal.request(owner.app, {
                        title: 'Secure storage master password',
                        description: `Create a master password for local encrypted API key storage. Minimum ${MASTER_PASSWORD_MIN_LENGTH} characters.`,
                        confirm: true,
                        submitLabel: 'Enable',
                    });
                    if (!password) {
                        if (Notice) new Notice(t('settings.secure_storage_migration_cancelled'));
                        owner.display();
                        return;
                    }
                    const unlocked = await secrets.unlock(password, secureStorage.masterSalt);
                    secureStorage.masterSalt = unlocked.salt;
                }
                await secrets.migratePlainSettings(env.settings);
                await secrets.hydrateSettings(env.settings);
                await save();
                if (Notice) new Notice(t('settings.secure_storage_migrated'));
                owner.display();
            }));

    // E1.3 P7: when secure storage is off, API keys live as plaintext inside the vault
    // (.pkm-assistant/settings.json — jedyny plik ustawień pluginu, S-19)
    // and get replicated by Obsidian Sync/git/Dropbox. Warn the user and point at the
    // "Secure storage" toggle right above.
    if (secureStorage.enabled !== true) {
        const warn = container.createDiv({ cls: 'cs-secure-storage-warning' });
        warn.setAttr('style', 'margin:8px 0 14px;padding:10px 12px;border-left:3px solid var(--text-warning, #e0a030);'
            + 'background:var(--background-secondary);border-radius:4px;font-size:13px;line-height:1.5;');
        warn.setText(t('settings.secure_storage_warning'));
    }

    new Setting(container).setName(t('settings.cloud_platforms')).setHeading();

    for (const prov of providers) {
        const keyField = prov.id;
        const hasKey = !!apiKeys[keyField];
        const statusDot = hasKey ? icons?.dotGreen?.(12) : icons?.dotGray?.(12);

        const provSetting = new Setting(container);
        setSvgLabel(provSetting.nameEl, statusDot || '', prov.name);
        provSetting
            .setDesc(hasKey ? t('settings.key_label', { key: maskKey(apiKeys[keyField]) }) : t('settings.no_key'))
            .addText(text => {
                text
                    .setPlaceholder(prov.placeholder)
                    .setValue(owner._showKeys[prov.id] ? (apiKeys[keyField] || '') : '')
                    .onChange(async (value) => {
                        if (value.trim()) {
                            apiKeys[keyField] = value.trim();
                        } else {
                            delete apiKeys[keyField];
                        }
                        await save();
                    });
                text.inputEl.type = owner._showKeys[prov.id] ? 'text' : 'password';
                text.inputEl.addClass('pkm-setting-input--w280');
                if (!owner._showKeys[prov.id] && hasKey) {
                    text.inputEl.placeholder = maskKey(apiKeys[keyField]);
                }
            })
            .addExtraButton(btn => {
                btn
                    .setIcon(owner._showKeys[prov.id] ? 'eye-off' : 'eye')
                    .setTooltip(owner._showKeys[prov.id] ? t('settings.hide_key') : t('settings.show_key'))
                    .onClick(() => {
                        owner._showKeys[prov.id] = !owner._showKeys[prov.id];
                        owner.display();
                    });
            });
    }

    new Setting(container).setName(t('settings.local_platforms')).setHeading();

    for (const prov of localProviders) {
        const hostValue = hosts[prov.settingKey] || '';
        const hasHost = !!hostValue;
        const statusDot = hasHost ? icons?.dotGreen?.(12) : icons?.dotGray?.(12);

        const localSetting = new Setting(container);
        setSvgLabel(localSetting.nameEl, statusDot || '', prov.name);
        localSetting
            .setDesc(hasHost ? t('settings.server_label', { host: hostValue }) : t('settings.not_configured'))
            .addText(text => {
                text
                    .setPlaceholder(prov.placeholder)
                    .setValue(hostValue)
                    .onChange(async (value) => {
                        hosts[prov.settingKey] = value.trim();
                        await save();
                    });
                text.inputEl.addClass('pkm-setting-input--w280');
            });
    }
}

export function renderAdvancedSection(container: HTMLElement, ctx: SettingsSectionCtx): void {
    const { pkm, save, icons, setSvgLabel, openCostTrackingModal, Setting } = ctx;
    container.classList.add('cs-root');

    const h2Adv = new Setting(container).setHeading();
    h2Adv.settingEl.addClass('cs-settings-section');
    setSvgLabel(h2Adv.nameEl, icons?.wrench?.(18) || '', t('settings.advanced_title'));

    // E2.3 (D21): default autonomy for new chats (whether the agent asks before acting).
    // Replaces the old „default work mode" dropdown (Gadaj/Rób removed).
    new Setting(container)
        .setName(t('settings.default_autonomy'))
        .setDesc(t('settings.default_autonomy_desc'))
        .addDropdown(dropdown => {
            dropdown.addOption('yolo', t('autonomy.yolo'));
            dropdown.addOption('edge', t('autonomy.edge'));
            dropdown.addOption('all', t('autonomy.all'));
            dropdown.setValue(pkm.defaultAutonomy || 'edge');
            dropdown.onChange(async (value) => {
                pkm.defaultAutonomy = value;
                await save();
            });
        });

    // E2.4 (D14): furtka rozszerzonych reguł promptu dla słabszych modeli.
    new Setting(container)
        .setName(t('settings.extended_prompt_rules'))
        .setDesc(t('settings.extended_prompt_rules_desc'))
        .addToggle(toggle => toggle
            .setValue(pkm.extendedPromptRules === true)
            .onChange(async (value) => {
                pkm.extendedPromptRules = value;
                await save();
            }));

    // S28 (D7): globalny wyłącznik Komunikatora — poczta między agentami. Ten sam przewód
    // co kill-switch z E1.2, tylko domyślnie ON i widoczny dla usera. Rejestracja narzędzi
    // i katalog serwerów czytają flagę PRZY STARCIE, więc zmiana wymaga przeładowania.
    new Setting(container)
        .setName(t('settings.komunikator_enabled'))
        .setDesc(t('settings.komunikator_enabled_desc'))
        .addToggle(toggle => toggle
            .setValue(pkm.komunikatorEnabled !== false)
            .onChange(async (value) => {
                pkm.komunikatorEnabled = value;
                await save();
            }));

    new Setting(container)
        .setName(t('settings.debug_mode'))
        .setDesc(t('settings.debug_mode_desc'))
        .addToggle(toggle => toggle
            .setValue(pkm.debugMode ?? false)
            .onChange(async (value) => {
                pkm.debugMode = value;
                log.setDebug(value);
                await save();
            }));

    new Setting(container)
        .setName(t('settings.trace_log'))
        .setDesc(t('settings.trace_log_desc'))
        .addToggle(toggle => toggle
            .setValue(pkm.traceEnabled !== false)
            .onChange(async (value) => {
                pkm.traceEnabled = value;
                await save();
            }));

    new Setting(container)
        .setName(t('settings.cache_telemetry'))
        .setDesc(t('settings.cache_telemetry_desc'))
        .addToggle(toggle => toggle
            .setValue(pkm.cacheTelemetryEnabled !== false)
            .onChange(async (value) => {
                pkm.cacheTelemetryEnabled = value;
                await save();
            }));

    new Setting(container)
        .setName(t('settings.cost_tracking') || 'Koszty LLM')
        .setDesc(t('settings.cost_tracking_desc')
            || 'Agregacja .pkm-assistant/cost_log.jsonl (archiwista + sub-agenci).')
        .addButton(btn => btn
            .setButtonText(t('settings.cost_tracking_btn') || 'Otwórz cost log')
            .onClick(openCostTrackingModal));
}

/**
 * Agent limits (E1.5 / R3 "Kagańce"). Editable overrides for config/limits.js values,
 * stored under settings.pkmAssistant.limits.*. Empty field = use the default; getLimits()
 * validates/clamps at read time, so garbage or out-of-range input can never break runtime.
 */
export function renderLimitsSection(container: HTMLElement, ctx: SettingsSectionCtx): void {
    const { pkm, save, owner, icons, setSvgLabel, Setting } = ctx;
    container.classList.add('cs-root');

    const h2 = new Setting(container).setHeading();
    h2.settingEl.addClass('cs-settings-section');
    setSvgLabel(h2.nameEl, icons?.wrench?.(18) || '', t('settings.limits_title'));

    container.createEl('p', { text: t('settings.limits_intro'), cls: 'setting-item-description' });

    if (!pkm.limits) pkm.limits = {};
    const limits = pkm.limits;

    // scale = input unit → stored unit. Delegation timeout is entered in seconds, stored in ms.
    const fields: Array<{ key: LimitKey; nameKey: string; descKey: string; scale: number }> = [
        { key: 'chat_max_iterations',                nameKey: 'settings.limits_chat_iter',          descKey: 'settings.limits_chat_iter_desc',          scale: 1 },
        { key: 'subagent_max_iterations_worker',     nameKey: 'settings.limits_worker_iter',        descKey: 'settings.limits_worker_iter_desc',        scale: 1 },
        { key: 'delegation_timeout_ms',              nameKey: 'settings.limits_delegation_timeout', descKey: 'settings.limits_delegation_timeout_desc', scale: 1000 },
        // Front A — watchdog ciszy suba (chunk streamu przezbraja budzik; 0 = wyłączony).
        { key: 'subagent_stall_timeout_ms',          nameKey: 'settings.limits_sub_stall',          descKey: 'settings.limits_sub_stall_desc',          scale: 1000 },
        // F5 — grace-okno na finalne podsumowanie suba (timeout w trakcie backstopu odracza abort).
        { key: 'subagent_final_grace_ms',            nameKey: 'settings.limits_final_grace',        descKey: 'settings.limits_final_grace_desc',        scale: 1000 },
        // Front A — ratowanie dorobku: skrót wyników narzędzi przy padzie syntezy (0 = wyłączone).
        { key: 'subagent_salvage_max_chars',         nameKey: 'settings.limits_sub_salvage',        descKey: 'settings.limits_sub_salvage_desc',        scale: 1 },
        // Runda 2 — wynik suba przy doręczeniu do maina (0 = bez limitu).
        { key: 'subagent_result_max_chars',          nameKey: 'settings.limits_sub_result',         descKey: 'settings.limits_sub_result_desc',         scale: 1 },
        // S33 Z1 — kagańce delegacji (głębokość łańcucha + szerokość jednego wywołania).
        { key: 'max_delegation_depth',               nameKey: 'settings.limits_max_delegation_depth',      descKey: 'settings.limits_max_delegation_depth_desc',      scale: 1 },
        { key: 'max_parallel_delegations',           nameKey: 'settings.limits_max_parallel_delegations',  descKey: 'settings.limits_max_parallel_delegations_desc',  scale: 1 },
        // S33 Z2 — bezpiecznik poczty agentów (strażnik siedzi w `kom_send`, nie w UI).
        { key: 'kom_send_rate_max',                  nameKey: 'settings.limits_kom_send_rate_max',         descKey: 'settings.limits_kom_send_rate_max_desc',         scale: 1 },
        // Werdykt Kuby 16.08 — sufit ŁAŃCUCHA auto-tur po subach z rzędu (bez tego rozmowa
        // potrafi jechać sama, agent zlecający kolejnych pomocników jednego po drugim).
        { key: 'max_consecutive_auto_turns',         nameKey: 'settings.limits_max_consecutive_auto_turns',      descKey: 'settings.limits_max_consecutive_auto_turns_desc',      scale: 1 },
        // K12 — drugi sufit poczty: cała pula wysyłkowa jednego agenta na to samo okno.
        { key: 'kom_send_rate_max_sender',           nameKey: 'settings.limits_kom_send_rate_max_sender',  descKey: 'settings.limits_kom_send_rate_max_sender_desc',  scale: 1 },
        { key: 'max_tool_result_length',             nameKey: 'settings.limits_tool_result',        descKey: 'settings.limits_tool_result_desc',        scale: 1 },
        // F4 — dawne capy jakościowe (hardcode 6000/16000) jako konfigurowalne budżety.
        { key: 'subagent_prompt_max_chars',          nameKey: 'settings.limits_subagent_prompt',    descKey: 'settings.limits_subagent_prompt_desc',    scale: 1 },
        { key: 'delegation_context_max_chars',       nameKey: 'settings.limits_delegation_context', descKey: 'settings.limits_delegation_context_desc', scale: 1 },
        { key: 'chat_stream_stall_timeout_ms',       nameKey: 'settings.limits_stream_stall',       descKey: 'settings.limits_stream_stall_desc',       scale: 1000 },
        // Friendly fire 2026-08-15 — budzik per-wywołanie modelu w czacie (pas ostateczny).
        { key: 'chat_model_call_timeout_ms',         nameKey: 'settings.limits_chat_call_timeout',  descKey: 'settings.limits_chat_call_timeout_desc',  scale: 1000 },
        // Bramka platform lokalnych (Zwis subagentow, lokalny most, 2026) — ile requestów naraz
        // do lm_studio/ollama; chmura bramki nie ma.
        { key: 'local_platform_max_concurrent',      nameKey: 'settings.limits_local_concurrent',   descKey: 'settings.limits_local_concurrent_desc',   scale: 1 },
    ];

    for (const f of fields) {
        const spec = LIMIT_SPECS[f.key];
        const defDisplay = DEFAULT_LIMITS[f.key] / f.scale;
        const minDisplay = spec.min / f.scale;
        const maxDisplay = spec.ceiling / f.scale;
        const hint = t('settings.limits_range_hint', { min: minDisplay, max: maxDisplay, def: defDisplay });

        new Setting(container)
            .setName(t(f.nameKey))
            .setDesc(`${t(f.descKey)} ${hint}`)
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = String(minDisplay);
                text.inputEl.max = String(maxDisplay);
                text.setPlaceholder(String(defDisplay));
                text.setValue(limits[f.key] != null ? String(limits[f.key] / f.scale) : '');
                text.onChange(async (v) => {
                    const trimmed = String(v).trim();
                    if (trimmed === '') {
                        delete limits[f.key];            // empty → use default
                        await save();
                        return;
                    }
                    const raw = Number(trimmed) * f.scale;
                    if (!Number.isFinite(raw)) return;   // ignore garbage, keep previous value
                    // Sanitize exactly like runtime getLimits (clamp to ceiling, below-min → default).
                    const sanitized = getLimits({ pkmAssistant: { limits: { [f.key]: raw } } })[f.key];
                    if (sanitized === DEFAULT_LIMITS[f.key]) delete limits[f.key]; // equals default → no override
                    else limits[f.key] = sanitized;
                    await save();
                });
            });
    }

    new Setting(container)
        .setName(t('settings.limits_restore'))
        .setDesc(t('settings.limits_restore_desc'))
        .addButton(btn => btn
            .setButtonText(t('settings.limits_restore_btn'))
            .onClick(async () => {
                pkm.limits = {};
                await save();
                owner?.display?.();
            }));
}

export function renderNoGoSection(container: HTMLElement, ctx: SettingsSectionCtx): void {
    const { pkm, save, plugin, owner, icons, setSvg, setSvgLabel, Setting } = ctx;
    container.classList.add('cs-root');

    const h2NoGo = new Setting(container).setHeading();
    h2NoGo.settingEl.addClass('cs-settings-section');
    setSvgLabel(h2NoGo.nameEl, icons?.shield?.(18) || '', t('settings.nogo_title'));

    const warningBox = container.createDiv({ cls: 'pkm-nogo-warning' });
    setSvg(warningBox, icons?.warning?.(16) || '');
    warningBox.appendText(' ');
    warningBox.createEl('strong', { text: t('settings.nogo_warning') });
    warningBox.createEl('br');
    warningBox.appendText(t('settings.nogo_warning_detail'));

    new Setting(container)
        .setName(t('settings.nogo_folders'))
        .setDesc(t('settings.nogo_folders_desc'))
        .addTextArea(text => {
            text
                .setPlaceholder('_private\nSecrets\nFinanse')
                .setValue((pkm.no_go_folders || []).join('\n'))
                .onChange(async (value) => {
                    pkm.no_go_folders = value.split('\n').map(s => s.trim()).filter(Boolean);
                    try {
                        const { AccessGuard } = await import('./security/AccessGuard.js');
                        AccessGuard.setNoGoFolders(pkm.no_go_folders);
                    } catch { /* ok */ }
                    await save();
                });
            text.inputEl.rows = 4;
            text.inputEl.addClass('pkm-editor-input-full');
        });

    new Setting(container).setName(t('settings.approved_actions_title')).setHeading();

    const rules = plugin?.approvalManager?.getAllAlwaysApprovedRules?.() || [];
    if (rules.length === 0) {
        container.createEl('p', {
            text: t('settings.approved_actions_empty'),
            cls: 'setting-item-description'
        });
        return;
    }

    for (const row of rules) {
        const [actionType, ...targetParts] = String(row.rule || '').split('::');
        const targetPath = targetParts.join('::') || '*';
        new Setting(container)
            .setName(row.agentName || 'Unknown agent')
            .setDesc(`${actionType || 'unknown'} → ${targetPath}`)
            .addButton(button => {
                button.setButtonText(t('settings.approved_actions_remove'));
                // `setDestructive()` chciałby tu `@typescript-eslint/no-deprecated` (setWarning()
                // deprecated w obsidian.d.ts), ALE jest `@since 1.13.0` (obsidianmd/no-unsupported-api),
                // a manifest deklaruje minAppVersion 1.11.0 — na starszym Obsidianie ta metoda po
                // prostu nie istnieje (realny crash, nie lint nitpick). Zamiast tego dopisujemy
                // ręcznie klasę CSS `mod-warning`, dokładnie to, co `setWarning()` robi pod spodem
                // (styl przycisku ostrzegawczego bez logiki poza dodaniem klasy) — zero zmiany
                // wyglądu/zachowania, zero podbicia minAppVersion, zero deprecated API (ogony-ogA,
                // fala 3, 2026-09-04).
                button.buttonEl.addClass('mod-warning');
                button.onClick(async () => {
                    // `!` — do tej pętli wchodzimy tylko, gdy `getAllAlwaysApprovedRules()`
                    // zwróciło niepustą listę, czyli manager istnieje.
                    plugin.approvalManager!.removeFromAlwaysApproved(row.agentName, actionType, targetPath);
                    await save();
                    owner?.display?.();
                });
                return button;
            });
    }
}

export function renderInfoSection(container: HTMLElement, ctx: SettingsSectionCtx): void {
    const { plugin, icons, setSvgLabel, Setting } = ctx;
    container.classList.add('cs-root');

    const h2Info = new Setting(container).setHeading();
    h2Info.settingEl.addClass('cs-settings-section');
    setSvgLabel(h2Info.nameEl, icons?.info?.(18) || '', t('settings.info_title'));

    const infoDiv = container.createDiv({ cls: 'setting-item' });
    infoDiv.addClass('pkm-info-block');

    infoDiv.createSpan({
        text: t('settings.version', { version: plugin.manifest.version }),
        cls: 'setting-item-description'
    });
    infoDiv.createSpan({
        text: t('settings.author'),
        cls: 'setting-item-description'
    });

    const linkEl = infoDiv.createEl('a', {
        text: 'GitHub: JDHole/pkm-assistant',
        href: 'https://github.com/JDHole/pkm-assistant',
        cls: 'setting-item-description'
    });
    linkEl.addClass('pkm-info-link');
}
