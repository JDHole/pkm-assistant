/**
 * modules/web — public API (barrel).
 *
 * Silnik dostępu do sieci. Kontrakty narzędzi (`web_search`/`web_read`) żyją
 * w `modules/tools/`. Patrz CLAUDE.md.
 *
 * Świadomie poza publicznym API: 9 symboli bez konsumenta spoza modułu —
 * `resolveProviderKey`, `WEB_SEARCH_PROVIDERS`, `PROVIDER_SIGNUP_URLS` (czyta je
 * `SettingsContent.js` TEGO modułu), `readUsage`/`sumUsage`/`COUNTED_PROVIDERS` (licznik
 * renderuje własna sekcja Settings),
 * `parseDomainList` (woła go `checkDomain`) i `_clearReadCache` (hak testowy — test
 * i tak deep-importuje `readCache.js`). Definicje żyją w bebechach.
 */
export { executeWebSearch, readWebPage } from './WebSearchProvider.js';
// Rejestr znanych URL-i (bramka provenance dla web_read).
// `normalizeUrl` wraca na powierzchnię modułu — `web_read` kanonizuje
// adres RAZ, zanim ocenia go provenance, filtr domen, cache i reader.
export { registerKnownUrl, registerUrlsFromText, isUrlKnown, normalizeUrl } from './urlRegistry.js';
// Licznik zużycia (informacyjny), filtr domen, cache odczytów, streszczanie.
export { bumpUsage } from './usageCounter.js';
export { checkDomain } from './domainFilter.js';
export { makeReadCacheKey, getCachedRead, setCachedRead } from './readCache.js';
export { summarizeWebContent } from './summarize.js';
export { registerSettings } from './SettingsSection.js';

// Typy publiczne modułu. `export type` ZNIKA przy transpilacji, więc powierzchnia
// runtime'u zostaje dokładnie taka, jak wyżej.
export type {
    WebSearchResult,
    WebSearchResponse,
    WebPageRead,
    WebSearchProviderSettings,
    WebSearchProviderInfo,
} from './WebSearchProvider.js';
export type { DomainListInput, DomainVerdict, DomainFilterSettings } from './domainFilter.js';
export type { ProviderTotals, UsageState, UsageSettingsSlice } from './usageCounter.js';
export type { CachedReadValue } from './readCache.js';
export type { WebCitation, WebSummary, SummarizerModelLike, SummarizeWebParams } from './summarize.js';
export type { WebSearchSettings, WebSettingsSectionCtx } from './SettingsContent.js';
