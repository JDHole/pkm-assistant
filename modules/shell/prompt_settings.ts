import { Setting } from 'obsidian';
import { t } from '../../core/i18n/index.js';
// Factory work-prompts surfaced here for "insert factory" / "restore default". Imported
// through each module's barrel (golden rule - no deep imports). The barrels re-export only the pure
// string constants, so no heavy graph is pulled in beyond what the plugin already loads.
import { DEFAULT_SAVE_SESSION_PROMPT, DEFAULT_ARCHIVE_PROMPT, DEFAULT_SUMMARY_PROMPT } from '../memory/index.js';
// Szkielet kompresji mieszka w `config/` (nie w barrelu czatu) - przecięta krawędź shell→chat.
import { DEFAULT_COMPRESSION_PROMPT } from '../../config/default_prompts.js';
import { DEFAULT_SUBAGENT_FRAME_PROMPT } from '../sub-agents/index.js';
import { FACTORY_DEFAULTS } from '../prompts/index.js';
import { setSvgLabel } from '../../modules/crystal-soul/index.js';

/**
 * Settings → Prompt.
 *
 * Global defaults for the "work prompts" (compression / save-session / archive / summary /
 * sub-agent frame) AND for the factory prompt sections (environment / rules / delegate).
 * Everything is stored under `settings.pkmAssistant.promptDefaults[<key>]` - the SAME map the resolver
 * (resolveWorkPrompt) and PromptBuilder._resolveSection read. Empty = factory default at runtime.
 * Per-agent overrides of these live in the agent panel.
 *
 * There is no `brief_prompt` slot here: it has zero production readers, so rendering a control
 * for it would promise work that never happens. Old `settings.json` values under
 * `promptDefaults.brief_prompt` are silently ignored (no migrator) - the resolver never reads
 * that key.
 */

// key → factory text + whether the prompt has a hard parser contract (warning shown).
const WORK_PROMPTS = [
    { key: 'compression_prompt', factory: () => DEFAULT_COMPRESSION_PROMPT, warn: true },
    { key: 'save_session_prompt', factory: () => DEFAULT_SAVE_SESSION_PROMPT, warn: true },
    { key: 'archive_prompt', factory: () => DEFAULT_ARCHIVE_PROMPT, warn: true },
    { key: 'summary_prompt', factory: () => DEFAULT_SUMMARY_PROMPT, warn: true },
    { key: 'subagent_frame_prompt', factory: () => DEFAULT_SUBAGENT_FRAME_PROMPT, warn: true },
];

// Factory prompt sections - resolved from FACTORY_DEFAULTS (getters → current locale).
const SECTION_PROMPTS = [
    { key: 'environment', factory: () => FACTORY_DEFAULTS.environment, warn: false },
    { key: 'rules', factory: () => FACTORY_DEFAULTS.rules, warn: false },
    { key: 'delegate_guide', factory: () => FACTORY_DEFAULTS.delegate_guide, warn: false },
];

type PromptItem = { key: string; factory: () => string; warn: boolean };
type PromptSettingsContext = {
    pkm: { promptDefaults?: Record<string, string> };
    save: () => Promise<unknown>;
    icons?: { clipboard?: (size: number) => string; edit?: (size: number) => string };
};

export function renderPromptSection(container: HTMLElement, ctx: PromptSettingsContext): void {
    const { pkm, save, icons } = ctx;
    container.classList.add('cs-root');
    if (!pkm.promptDefaults || typeof pkm.promptDefaults !== 'object') pkm.promptDefaults = {};
    const pd = pkm.promptDefaults;

    const h2 = new Setting(container).setHeading();
    h2.settingEl.addClass('cs-settings-section');
    setSvgLabel(h2.nameEl, icons?.clipboard?.(18) || icons?.edit?.(18) || '', t('settings.prompt_title'));
    container.createEl('p', { text: t('settings.prompt_desc'), cls: 'setting-item-description' });

    const renderEditor = (parent: HTMLElement, item: PromptItem) => {
        const key = item.key;
        const block = parent.createDiv({ cls: 'cs-prompt-override cs-prompt-override--settings' });

        const head = block.createDiv({ cls: 'cs-prompt-settings-head' });
        head.createEl('strong', { text: t(`settings.prompt_item.${key}.label`) });
        const badge = head.createSpan({ text: t('settings.prompt_overridden'), cls: 'cs-prompt-badge cs-prompt-badge--global cs-prompt-badge--push' });
        const syncBadge = () => { badge.style.display = (typeof pd[key] === 'string' && pd[key].trim()) ? '' : 'none'; };

        block.createEl('p', { text: t(`settings.prompt_item.${key}.desc`), cls: 'setting-item-description' });

        if (item.warn) {
            block.createEl('p', { text: t(`settings.prompt_item.${key}.warn`), cls: 'cs-prompt-settings-warn' });
        }

        const textarea = block.createEl('textarea', { cls: 'cs-prompt-textarea cs-prompt-textarea--settings' });
        textarea.placeholder = t('settings.prompt_empty_hint');
        textarea.value = typeof pd[key] === 'string' ? pd[key] : '';
        syncBadge();

        textarea.addEventListener('change', () => {
            void (async () => {
                const val = textarea.value.trim();
                if (val) pd[key] = val; else delete pd[key];
                syncBadge();
                await save();
            })();
        });

        const controls = block.createDiv({ cls: 'cs-prompt-settings-controls' });

        const insertBtn = controls.createEl('button', { text: t('settings.prompt_insert_factory') });
        insertBtn.addEventListener('click', () => {
            void (async () => {
                const factoryText = item.factory();
                textarea.value = factoryText;
                pd[key] = factoryText;
                syncBadge();
                await save();
            })();
        });

        const resetBtn = controls.createEl('button', { text: t('settings.prompt_restore_default') });
        resetBtn.addEventListener('click', () => {
            void (async () => {
                textarea.value = '';
                delete pd[key];
                syncBadge();
                await save();
            })();
        });
    };

    // ── Work prompts ──
    container.createEl('h4', { text: t('settings.prompt_work_title') });
    container.createEl('p', { text: t('settings.prompt_work_desc'), cls: 'setting-item-description' });
    for (const item of WORK_PROMPTS) renderEditor(container, item);

    // ── Prompt sections (system prompt) ──
    container.createEl('h4', { text: t('settings.prompt_sections_title') });
    container.createEl('p', { text: t('settings.prompt_sections_desc'), cls: 'setting-item-description' });
    for (const item of SECTION_PROMPTS) renderEditor(container, item);
}
