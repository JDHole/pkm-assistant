import {
    readWebPage,
    isUrlKnown,
    checkDomain,
    makeReadCacheKey,
    getCachedRead,
    setCachedRead,
    summarizeWebContent,
    normalizeUrl,
} from '../web/index.js';
import type { WebCitation, SummarizerModelLike } from '../web/index.js';
import { createModelForRole } from '../models/index.js';
import type { ResolverAgentLike, ResolverPluginLike } from '../models/index.js';
import type { WebToolSettings } from './WebSearchTool.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `web_read` wg `inputSchema`. */
interface WebReadToolArgs {
    url?: unknown;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Agent wołania: tożsamość dla resolvera modeli + jego własny wyłącznik Badacza. */
type WebReadAgent = NonNullable<ResolverAgentLike> & { minionEnabled?: boolean };

/**
 * Minimalny widok pluginu. Przecięcie z `ResolverPluginLike`: TEN SAM obiekt idzie do
 * `createModelForRole` (`modules/models`), więc kontrakt resolvera bierzemy z jego barrela.
 */
export type WebReadPlugin = NonNullable<ResolverPluginLike> & {
    agentManager?: {
        getAgent?(name: string): WebReadAgent | null | undefined;
        getActiveAgent?(): WebReadAgent | null | undefined;
    } | null;
    env?: { settings?: { pkmAssistant?: { webSearch?: WebToolSettings } } } | null;
};

/**
 * web_read — MCP tool for reading full content of a web page.
 * Uses Jina Reader API (r.jina.ai) to extract clean text from any URL.
 *
 * E3.3 — STRESZCZANIE ZAMIAST UCINANIA (DEC L13-5a). Do E3.2 strona dłuższa niż
 * limit była ucinana na twardo w połowie zdania — model dostawał przypadkowy
 * początek i nie wiedział, co przepadło. Teraz długa strona idzie do TANIEGO modelu
 * (slot `researcher` = Badacz), który zwraca streszczenie + dosłowne cytaty.
 * Brak modelu / toggle OFF / błąd LLM → stare, twarde cięcie + nota, co zrobić,
 * żeby dostawać streszczenia. ŚWIADOMIE bez fallbacku na model główny: narzędzie
 * nie ma prawa po cichu palić drogiego modelu.
 */
export function createWebReadTool() {
    return {
        name: 'web_read',
        description: t('mcp.web_read.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: t('mcp.web_read.param.url')
                }
            },
            required: ['url']
        },
        execute: async (args: WebReadToolArgs, _app: unknown, plugin: WebReadPlugin | null | undefined) => {
            try {
                const { url } = args;
                if (!url || typeof url !== 'string') {
                    throw new Error(t('mcp.web_read.error.url_required'));
                }

                // Basic URL validation
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    throw new Error(t('mcp.web_read.error.url_invalid'));
                }

                // K1 / znalezisko 001: adres kanonizujemy RAZ, na samym wejsciu. Od tej chwili
                // provenance, filtr domen, klucz cache i reader ogladaja DOKLADNIE ten sam ciag.
                // Bez tego `https://good.com/a/../../../../evil.com/x` przechodzil filtr jako
                // `good.com`, a po sklejce z readerem zwijal sie do `evil.com`.
                const canonical = normalizeUrl(url);
                if (!canonical) {
                    throw new Error(t('mcp.web_read.error.url_invalid'));
                }

                const webSearchSettings = plugin?.env?.settings?.pkmAssistant?.webSearch || {};

                if (webSearchSettings.enabled === false) {
                    return {
                        success: false,
                        error: t('mcp.web.disabled')
                    };
                }

                // E1.3 P6 (L13-11): only fetch URLs of known provenance — returned by a
                // prior web_search or present in a user message. This blocks the
                // prompt-injection exfiltration vector where the model is tricked into
                // reading https://evil.com/?q=<vault-data>. Fail-closed: unknown → refuse.
                if (!isUrlKnown(canonical)) {
                    return {
                        success: false,
                        error: t('mcp.web_read.error.unknown_url')
                    };
                }

                // E3.3: filtr domen — odmowa PRZED requestem, fail-closed jak bramka provenance.
                if (checkDomain(canonical, webSearchSettings) !== 'allowed') {
                    return {
                        success: false,
                        error: t('mcp.web_read.error.domain_blocked', { url: canonical })
                    };
                }

                const maxChars = webSearchSettings.readTrimLimit || 8000;
                // Sam ZAMIAR streszczania (ustawienie + agent) — bez budowania modelu.
                // Model powstaje dopiero, gdy strona faktycznie jest za długa, więc krótka
                // strona i trafienie w cache nie kosztują nic.
                const agent = _resolveInvocationAgent(plugin, args);
                const summarizeEnabled = webSearchSettings.summarizeLongPages !== false
                    && agent?.minionEnabled !== false;

                // Cache trzyma WYNIK KOŃCOWY (po streszczeniu) — inaczej każdy hit
                // płaciłby jeszcze raz za LLM. Tryb i limit są częścią tożsamości wyniku.
                const cacheKey = makeReadCacheKey(canonical, maxChars, summarizeEnabled);
                const cachedResult = getCachedRead(cacheKey);
                if (cachedResult) {
                    log.debug('WebRead', `Cache hit: ${canonical}`);
                    return cachedResult;
                }

                const result = await readWebPage(canonical, webSearchSettings);

                let content = result.content || '';
                let citations: WebCitation[] = [];
                let summarized = false;
                let note: string | null = null;

                if (content.length > maxChars) {
                    const model = summarizeEnabled ? _createResearcherModel(plugin, agent) : null;
                    if (model) {
                        try {
                            const summary = await summarizeWebContent({
                                title: result.title,
                                url: result.url,
                                content,
                                model,
                                targetChars: maxChars
                            });
                            note = t('mcp.web_read.summarized_note', {
                                original: content.length,
                                length: summary.summary.length
                            });
                            content = summary.summary;
                            citations = summary.citations;
                            summarized = true;
                        } catch (error) {
                            log.warn('WebRead', 'Streszczanie nie wyszło — tnę treść:', error);
                        }
                    }

                    if (!summarized) {
                        content = content.slice(0, maxChars) + '\n\n' + t('mcp.web_read.trimmed', { limit: maxChars });
                        note = t('mcp.web_read.no_summarizer_note');
                    }
                }

                const payload = {
                    success: true,
                    url: result.url,
                    title: result.title,
                    content,
                    citations,
                    summarized,
                    charCount: content.length,
                    ...(note ? { note } : {})
                };

                return setCachedRead(cacheKey, payload);

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
 * Agent, który zawołał narzędzie. `_invocationAgentName` wstrzykuje `MCPClient` —
 * model nie może tego pola podrobić.
 * @private
 */
function _resolveInvocationAgent(
    plugin: WebReadPlugin | null | undefined,
    args: WebReadToolArgs | undefined,
): WebReadAgent | null {
    try {
        const agentManager = plugin?.agentManager;
        return (args?._invocationAgentName
            ? agentManager?.getAgent?.(args._invocationAgentName as string)
            : null) || agentManager?.getActiveAgent?.() || null;
    } catch (error) {
        log.debug('WebRead', 'Nie udało się ustalić agenta wywołania:', error);
        return null;
    }
}

/**
 * Tani model do streszczania: slot `researcher` (Badacz) agenta wywołania.
 * Brak modelu NIE jest błędem — narzędzie leci wtedy starą ścieżką cięcia.
 * @private
 */
function _createResearcherModel(
    plugin: WebReadPlugin | null | undefined,
    agent: WebReadAgent | null,
): SummarizerModelLike | null {
    try {
        return createModelForRole(plugin, 'researcher', agent) || null;
    } catch (error) {
        log.debug('WebRead', 'Brak modelu Badacza do streszczania:', error);
        return null;
    }
}
