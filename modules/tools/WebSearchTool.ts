import { executeWebSearch, registerKnownUrl, checkDomain, bumpUsage } from '../web/index.js';
import type { WebSearchSettings } from '../web/index.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `web_search` wg `inputSchema`. */
interface WebSearchToolArgs {
    query?: unknown;
    limit?: number;
    lang?: string;
    [extra: string]: unknown;
}

/**
 * Ustawienia Web Search widziane przez narzędzia. `WebSearchSettings` z `modules/web`
 * NIE zna limitów przycinania — `trimLimit`/`readTrimLimit` czytają wyłącznie narzędzia
 * (`web_search`/`web_read`), więc kontrakt na nie stoi tutaj, u konsumenta.
 */
export type WebToolSettings = WebSearchSettings & {
    /** ile znaków treści zostaje jako `fragment` w wyniku `web_search` (default 1500) */
    trimLimit?: number;
    /** próg, powyżej którego `web_read` streszcza albo tnie (default 8000) */
    readTrimLimit?: number;
};

/** Minimalny widok pluginu: ustawienia Web Search + zapis licznika zużycia. */
export interface WebSearchPlugin {
    env?: {
        settings?: { pkmAssistant?: { webSearch?: WebToolSettings } };
        settingsStore?: { save?: () => unknown } | null;
    } | null;
}

/** Wynik pojedynczego trafienia oddawany modelowi — bez pełnej treści strony (E3.3). */
interface WebSearchToolHit {
    title: string;
    url: string;
    fragment: string;
}

/**
 * web_search — MCP tool for searching the internet.
 * Uses configured provider (default: Jina AI, free).
 *
 * E3.3 — KSZTAŁT WYNIKU (mikro-decyzja 6). Do E3.2 narzędzie zwracało RÓWNOCZEŚNIE
 * `results` z PEŁNĄ treścią stron i przycięte `formatted`. Cięcie było iluzoryczne:
 * globalny limiter pętli agenta tnie surowy JSON (czyli pełną treść) ZANIM model
 * dojdzie do `formatted`. Teraz `results` niesie wyłącznie `{title, url, fragment}` —
 * pełna treść nie wychodzi z narzędzia. To jest zarazem format cytatów z L13-13:
 * gotowa karma dla Pamięci v3. Po pełną treść jest `web_read`.
 */
export function createWebSearchTool() {
    return {
        name: 'web_search',
        description: t('mcp.web_search.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: t('mcp.web_search.param.query')
                },
                limit: {
                    type: 'number',
                    description: t('mcp.web_search.param.limit')
                },
                lang: {
                    type: 'string',
                    description: t('mcp.web_search.param.lang')
                }
            },
            required: ['query']
        },
        execute: async (args: WebSearchToolArgs, _app: unknown, plugin: WebSearchPlugin | null | undefined) => {
            try {
                const { query } = args;
                if (!query || typeof query !== 'string') {
                    throw new Error(t('mcp.web_search.error.query_required'));
                }

                const limit = Math.min(args.limit || 5, 10);
                const lang = args.lang || '';

                // Get web search settings from plugin
                const webSearchSettings = plugin?.env?.settings?.pkmAssistant?.webSearch || {};

                if (webSearchSettings.enabled === false) {
                    return {
                        success: false,
                        error: t('mcp.web.disabled')
                    };
                }

                // Prepend language hint if specified
                const finalQuery = lang ? `${query} lang:${lang}` : query;

                const result = await executeWebSearch(finalQuery, webSearchSettings, limit);

                // E3.3: filtr domen PO pobraniu — odfiltrowane nie wchodzą ani do wyniku,
                // ani do rejestru znanych URL-i (czyli web_read ich nie odblokuje).
                const kept = (result.results || []).filter(r => checkDomain(r?.url, webSearchSettings) === 'allowed');

                // E1.3 P6: record every result URL as known-provenance so web_read may
                // later fetch it. URLs the model invents (exfiltration vector) stay unknown.
                for (const r of kept) {
                    if (r?.url) registerKnownUrl(r.url);
                }

                // Configurable trim limit (default 1500, settable in webSearch settings)
                const trimLimit = webSearchSettings.trimLimit || 1500;

                const results: WebSearchToolHit[] = kept.map(r => ({
                    title: r.title || t('websearch.no_title'),
                    url: r.url || '',
                    fragment: (r.content || '').slice(0, trimLimit)
                }));

                // E3.3 (DEC L13-4): licznik zużycia — informacyjny, nigdy blokujący.
                // Liczy dostawcę, który REALNIE odpowiedział (po fallbacku: jina, czyli nic).
                // Trafienie w cache nie zjadło limitu u dostawcy, więc go nie liczymy.
                if (!result.cached) {
                    _bumpUsageCounter(plugin, webSearchSettings, result.provider);
                }

                const lines = results.map((r, i) => {
                    let entry = `[${i + 1}] ${r.title}\n    URL: ${r.url}`;
                    if (r.fragment) entry += `\n    ${r.fragment}`;
                    return entry;
                });

                if (result.fallback_from) {
                    lines.unshift(t('mcp.web_search.fallback_note', {
                        from: result.fallback_from,
                        to: result.provider
                    }));
                }

                return {
                    success: true,
                    provider: result.provider,
                    ...(result.fallback_from ? { fallback_from: result.fallback_from } : {}),
                    query: result.query,
                    results,
                    count: results.length,
                    formatted: lines.join('\n\n')
                };

            } catch (error) {
                return {
                    success: false,
                    error: (error as Error).message
                };
            }
        }
    };
}

/**
 * Podbija licznik i prosi o zapis ustawień.
 *
 * `webSearchSettings` w runtime jest proxy z `core/utils/SettingsManager.js` — samo
 * przypisanie `ws.usage` planuje zapis (debounce 1s). Jawne `settingsStore.save()`
 * jest pasem bezpieczeństwa na wypadek ścieżek, które proxy omijają. Błąd zapisu
 * NIE może wywrócić wyszukiwania — licznik jest tylko informacją.
 * @private
 */
function _bumpUsageCounter(
    plugin: WebSearchPlugin | null | undefined,
    webSearchSettings: WebToolSettings,
    providerId: string,
): void {
    try {
        if (!bumpUsage(webSearchSettings, providerId)) return;
        plugin?.env?.settingsStore?.save?.();
    } catch (error) {
        log.debug('WebSearch', 'Nie udało się zapisać licznika zużycia:', error);
    }
}
