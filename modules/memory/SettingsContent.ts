import { t } from '../../core/i18n/index.js';
import { setSvgLabel } from '../../modules/crystal-soul/index.js';
// `import type` = ZERO emitu — sekcja dostaje `Setting` przez ctx (DI), nie importem wartości.
import type { Setting as ObsidianSetting } from 'obsidian';

/**
 * Slice `settings.pkmAssistant` w zakresie, którego dotyka sekcja „Pamięć i kontekst".
 * Wszystko opcjonalne: to ustawienia usera, których w świeżej instalacji po prostu nie ma
 * (stąd `|| default` i `!== undefined` przy każdym odczycie niżej).
 */
export interface MemoryPkmSlice {
    maxContextTokens?: number;
    enableAutoSummarization?: boolean;
    toolTrimThreshold?: number;
    summarizationThreshold?: number;
    autoSaveInterval?: number;
    archiveRetentionDays?: number;
    archiveRetentionMaxFiles?: number;
    sessionTimeoutMinutes?: number;
    idleConsolidationMinutes?: number;
}

/**
 * Fragment worka DI z `pkm_settings_tab.buildSectionContext()` — TYLKO to, co czyta ta sekcja.
 * Strukturalnie, bez importu z core: pełny `SettingsSectionCtx` niesie pola, których memory
 * nie dotyka, a moduł nie ma powodu ich znać.
 */
export interface MemorySettingsCtx {
    pkm: MemoryPkmSlice;
    save: () => Promise<void> | void;
    icons?: Record<string, ((size?: number) => string) | undefined>;
    Setting: typeof ObsidianSetting;
}

export function renderMemorySection(container: HTMLElement, ctx: MemorySettingsCtx): void {
    const { pkm, save, icons, Setting } = ctx;
    container.classList.add('cs-root');

    const memoryHeading = new Setting(container).setHeading();
    memoryHeading.settingEl.addClass('cs-settings-section');
    setSvgLabel(memoryHeading.nameEl, icons?.brain?.(18) || '', t('settings.memory_title'));

    new Setting(container).setName(t('settings.compression_title')).setHeading();

    new Setting(container)
        .setName(t('settings.context_limit'))
        .setDesc(t('settings.context_limit_desc'))
        .addText(text => {
            text
                .setPlaceholder('100000')
                .setValue(String(pkm.maxContextTokens || 100000))
                .onChange(async (value) => {
                    let val = parseInt(value);
                    if (isNaN(val)) val = 100000;
                    if (val < 10000) val = 10000;
                    if (val > 2000000) val = 2000000;
                    pkm.maxContextTokens = val;
                    await save();
                });
            text.inputEl.type = 'number';
            text.inputEl.addClass('pkm-setting-input--w120');
        });

    new Setting(container)
        .setName(t('settings.auto_summarize'))
        .setDesc(t('settings.auto_summarize_desc'))
        .addToggle(toggle => toggle
            .setValue(pkm.enableAutoSummarization !== false)
            .onChange(async (value) => {
                pkm.enableAutoSummarization = value;
                await save();
            }));

    new Setting(container)
        .setName(t('settings.tool_trim_threshold'))
        .setDesc(t('settings.tool_trim_desc'))
        .addSlider(slider => slider
            .setLimits(0.5, 0.9, 0.05)
            .setValue(pkm.toolTrimThreshold || 0.7)
            .onChange(async (value) => {
                pkm.toolTrimThreshold = value;
                await save();
            }));

    new Setting(container)
        .setName(t('settings.summarize_threshold'))
        .setDesc(t('settings.summarize_threshold_desc'))
        .addSlider(slider => slider
            .setLimits(0.7, 1.0, 0.05)
            .setValue(pkm.summarizationThreshold || 0.9)
            .onChange(async (value) => {
                pkm.summarizationThreshold = value;
                await save();
            }));

    new Setting(container).setName(t('settings.sessions_title')).setHeading();

    new Setting(container)
        .setName(t('settings.auto_save'))
        .setDesc(t('settings.auto_save_desc'))
        .addText(text => {
            text
                .setPlaceholder('5')
                .setValue(String(pkm.autoSaveInterval !== undefined ? pkm.autoSaveInterval : 5))
                .onChange(async (value) => {
                    pkm.autoSaveInterval = parseInt(value);
                    await save();
                });
            text.inputEl.type = 'number';
            text.inputEl.addClass('pkm-setting-input--w80');
        });

    // Z6 (2026-07-30): pole „Zachowaj ostatnich sesji po L1" (`keepRecentSessions`) WYCIĘTE —
    // było duchem: zero konsumentów w kodzie po kasacji starego toru konsolidacji (D6), więc
    // obiecywało zachowanie, którego nie było. NIE zostało przepięte na retencję poniżej:
    // jego domyślne „3" znaczyłoby „skasuj wszystko poza trzema", a domyślną wartością retencji
    // musi być „nic nie kasuj".
    new Setting(container)
        .setName(t('settings.archive_retention_days'))
        .setDesc(t('settings.archive_retention_days_desc'))
        .addText(text => {
            text
                .setPlaceholder('0')
                .setValue(String(pkm.archiveRetentionDays !== undefined ? pkm.archiveRetentionDays : 0))
                .onChange(async (value) => {
                    const val = parseInt(value);
                    pkm.archiveRetentionDays = Number.isFinite(val) && val > 0 ? val : 0;
                    await save();
                });
            text.inputEl.type = 'number';
            text.inputEl.addClass('pkm-setting-input--w80');
        });

    new Setting(container)
        .setName(t('settings.archive_retention_max'))
        .setDesc(t('settings.archive_retention_max_desc'))
        .addText(text => {
            text
                .setPlaceholder('0')
                .setValue(String(pkm.archiveRetentionMaxFiles !== undefined ? pkm.archiveRetentionMaxFiles : 0))
                .onChange(async (value) => {
                    const val = parseInt(value);
                    pkm.archiveRetentionMaxFiles = Number.isFinite(val) && val > 0 ? val : 0;
                    await save();
                });
            text.inputEl.type = 'number';
            text.inputEl.addClass('pkm-setting-input--w80');
        });

    // S32 (2026-07-30): pole „Próg L3" (`l3Threshold`) WYCIĘTE — drugi duch obok keepRecentSessions:
    // zero konsumentów w kodzie (o kadencji L2→L3 decyduje wyłącznie batchSize w buildConsolidationPlan),
    // więc pole obiecywało kontrolę, której nie było. Osierocona wartość w settings usera jest nieszkodliwa.

    // E2.7 K4: session timeout (was read from the wrong settings level with no UI — now wired here).
    new Setting(container)
        .setName(t('settings.session_timeout'))
        .setDesc(t('settings.session_timeout_desc'))
        .addText(text => {
            text
                .setPlaceholder('30')
                .setValue(String(pkm.sessionTimeoutMinutes !== undefined ? pkm.sessionTimeoutMinutes : 30))
                .onChange(async (value) => {
                    const val = parseInt(value);
                    pkm.sessionTimeoutMinutes = (Number.isFinite(val) && val > 0) ? val : 30;
                    await save();
                });
            text.inputEl.type = 'number';
            text.inputEl.addClass('pkm-setting-input--w80');
        });

    // E2.7 W3 (K4): idle consolidation — save the transcript after N minutes of inactivity. 0 = off.
    new Setting(container)
        .setName(t('settings.idle_consolidation'))
        .setDesc(t('settings.idle_consolidation_desc'))
        .addText(text => {
            text
                .setPlaceholder('20')
                .setValue(String(pkm.idleConsolidationMinutes !== undefined ? pkm.idleConsolidationMinutes : 20))
                .onChange(async (value) => {
                    const val = parseInt(value);
                    pkm.idleConsolidationMinutes = Number.isFinite(val) && val >= 0 ? val : 20;
                    await save();
                });
            text.inputEl.type = 'number';
            text.inputEl.addClass('pkm-setting-input--w80');
        });
}
