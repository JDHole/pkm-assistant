import { t } from '../../core/i18n/index.js';
import { WEB_SEARCH_PROVIDERS, PROVIDER_SIGNUP_URLS, resolveProviderKey } from './WebSearchProvider.js';
import type { WebSearchProviderSettings } from './WebSearchProvider.js';
import { readUsage, COUNTED_PROVIDERS } from './usageCounter.js';
import type { UsageSettingsSlice } from './usageCounter.js';
import { parseDomainList } from './domainFilter.js';
import type { DomainFilterSettings } from './domainFilter.js';
import { setSvgLabel } from '../../modules/crystal-soul/index.js';
import type { SettingsSectionCtx } from '../../core/index.js';

/**
 * CAŁY slice `settings.pkmAssistant.webSearch`, poskładany z kawałków, które trzymają
 * ich właściciele (dostawcy / filtr domen / licznik). Sekcja Ustawień jest jedynym
 * miejscem, które dotyka go w całości.
 */
export type WebSearchSettings = WebSearchProviderSettings & DomainFilterSettings & UsageSettingsSlice & {
    enabled?: boolean;
    summarizeLongPages?: boolean;
};

// Przykładowy URL instancji SearXNG — schemat `http://` zostaje małymi literami (kapitalizacja
// byłaby błędnym adresem), w stałej a nie literale inline.
const SEARXNG_URL_PLACEHOLDER = 'http://localhost:8888';

/**
 * Worek DI z `pkm_settings_tab.buildSectionContext()`, zawężony do tego, czego używa TA
 * sekcja. Dwie rzeczy dokładamy do publicznego `SettingsSectionCtx`: slice `webSearch`
 * (core nie zna ustawień tego modułu) i `owner.render()` — przerysowanie zakładki po
 * zmianie dostawcy. `render` jest w shellu metodą `async`, ale jej zwrotki nikt tu nie
 * czyta, więc kontraktem jest `unknown` (tak samo jak w JS przed konwersją).
 */
export type WebSettingsSectionCtx = Pick<SettingsSectionCtx, 'save' | 'icons' | 'Setting'> & {
    pkm: SettingsSectionCtx['pkm'] & { webSearch?: WebSearchSettings };
    owner: { render: () => unknown };
};

export function renderWebSearchSection(container: HTMLElement, ctx: WebSettingsSectionCtx): void {
    const { pkm, save, owner, icons, Setting } = ctx;
    container.classList.add('cs-root');

    const webHeading = new Setting(container).setHeading();
    webHeading.settingEl.addClass('cs-settings-section');
    setSvgLabel(webHeading.nameEl, icons?.globe?.(18) || '', t('settings.web_search_title'));
    container.createEl('p', {
        text: t('settings.web_search_desc'),
        cls: 'setting-item-description'
    });

    if (!pkm.webSearch) pkm.webSearch = {};
    const ws = pkm.webSearch;

    new Setting(container)
        .setName(t('settings.web_search_enable'))
        .setDesc(t('settings.web_search_enable_desc'))
        .addToggle(toggle => toggle
            .setValue(ws.enabled !== false)
            .onChange(async (value) => {
                ws.enabled = value;
                await save();
                owner.render();
            }));

    if (ws.enabled === false) return;

    new Setting(container)
        .setName(t('settings.web_provider'))
        .setDesc(t('settings.web_provider_desc'))
        .addDropdown(dd => {
            for (const [id, info] of Object.entries(WEB_SEARCH_PROVIDERS)) {
                dd.addOption(id, info.label);
            }
            dd.setValue(ws.provider || 'jina');
            dd.onChange(async (value) => {
                ws.provider = value;
                await save();
                owner.render();
            });
        });

    const providerId = ws.provider || 'jina';
    const provider = WEB_SEARCH_PROVIDERS[providerId];

    // ── Licznik zużycia (E3.3, DEC L13-4) — INFORMACJA, nie limit ──
    // Jina (darmowa podłoga) i SearXNG (self-host) nie mają progu, który dałoby się pokazać.
    if (COUNTED_PROVIDERS.includes(providerId)) {
        const usage = readUsage(ws);
        const today = t('settings.web_search_usage_today', { count: usage.day[providerId] ?? 0 });
        const month = t('settings.web_search_usage_month', { count: usage.monthTotals[providerId] ?? 0 });
        new Setting(container)
            .setName(`${today}  ·  ${month}`)
            .setDesc(t('settings.web_search_usage_hint'));
    }

    // ── Klucz API per dostawca (E3.3, mikro-decyzja 2) ──
    // Pole widoczne, gdy klucz jest wymagany, opcjonalny albo już wpisany.
    // Legacy `ws.apiKey` pokazujemy jako wartość startową dla WYBRANEGO dostawcy
    // (resolveProviderKey), ale zapisujemy już wyłącznie do `ws.apiKeys[id]` —
    // starego pola nie kasujemy, więc nic się userowi nie gubi.
    const currentKey = resolveProviderKey(ws, providerId);
    if (provider?.requiresKey || provider?.keyOptional || currentKey) {
        const keySetting = new Setting(container)
            .setName(provider?.keyOptional
                ? t('settings.web_search_key_optional')
                : t('settings.web_api_key'))
            .setDesc(provider?.keyOptional
                ? t('websearch.key_optional_desc')
                : t('settings.web_api_key_desc', { provider: provider?.label || providerId }));

        keySetting.addText(text => {
            text
                .setPlaceholder(t('settings.web_api_key_placeholder'))
                .setValue(currentKey)
                .onChange(async (value) => {
                    if (!ws.apiKeys) ws.apiKeys = {};
                    ws.apiKeys[providerId] = value.trim();
                    await save();
                });
            text.inputEl.type = 'password';
            text.inputEl.addClass('pkm-setting-input--w300');
        });
    }

    if (provider?.requiresUrl) {
        new Setting(container)
            .setName(t('settings.web_searxng_url'))
            .setDesc(t('settings.web_searxng_desc'))
            .addText(text => {
                text
                    .setPlaceholder(SEARXNG_URL_PLACEHOLDER)
                    .setValue(ws.instanceUrl || '')
                    .onChange(async (value) => {
                        ws.instanceUrl = value.trim();
                        await save();
                    });
                text.inputEl.addClass('pkm-setting-input--w300');
            });
    }

    const signupUrl = PROVIDER_SIGNUP_URLS[providerId];
    if (signupUrl) {
        const linkSetting = new Setting(container)
            .setName(t('settings.web_signup'))
            .setDesc(t('settings.web_signup_desc'));
        const linkBtn = linkSetting.controlEl.createEl('a', {
            text: t('settings.web_signup_link', { provider: provider?.label || providerId }),
            href: signupUrl,
            cls: 'external-link'
        });
        linkBtn.addClass('pkm-link-btn');
    }

    // ── Streszczanie długich stron (E3.3, DEC L13-5a) ──
    new Setting(container)
        .setName(t('settings.web_search_summarize'))
        .setDesc(t('settings.web_search_summarize_desc'))
        .addToggle(toggle => toggle
            .setValue(ws.summarizeLongPages !== false)
            .onChange(async (value) => {
                ws.summarizeLongPages = value;
                await save();
            }));

    // ── Filtr domen (E3.3, DEC L13-5c) ──
    _renderDomainList(container, ctx, ws, 'blockedDomains', 'blocked');
    _renderDomainList(container, ctx, ws, 'allowedDomains', 'allowed');
}

/**
 * Pole listy domen. W ustawieniach trzymamy TABLICĘ hostów (parseDomainList przy
 * zapisie), a userowi pokazujemy je po przecinku — może wklejać całe URL-e,
 * rozdzielać przecinkami albo nowymi liniami.
 * @private
 */
function _renderDomainList(
    container: HTMLElement,
    ctx: WebSettingsSectionCtx,
    ws: WebSearchSettings,
    field: 'blockedDomains' | 'allowedDomains',
    i18nKey: 'blocked' | 'allowed',
): void {
    const { save, Setting } = ctx;
    new Setting(container)
        .setName(t(`settings.web_search_${i18nKey}_domains`))
        .setDesc(t(`settings.web_search_${i18nKey}_domains_desc`))
        .addTextArea(area => {
            area
                .setPlaceholder('example.com, tracker.pl')
                .setValue(parseDomainList(ws[field]).join(', '))
                .onChange(async (value) => {
                    ws[field] = parseDomainList(value);
                    await save();
                });
            area.inputEl.rows = 2;
            area.inputEl.addClass('pkm-setting-input--w300');
        });
}
