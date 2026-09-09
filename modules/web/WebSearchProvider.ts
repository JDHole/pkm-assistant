import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';

/**
 * Web Search Provider — multi-provider architecture.
 * Domyślnie: Jina AI (bez klucza API, za darmo).
 * Opcjonalnie: Tavily, Brave, SearXNG (wymagają klucza lub self-host).
 */

/** Pojedynczy wynik wyszukiwania — wspólny kształt dla wszystkich 5 dostawców. */
export interface WebSearchResult {
    title: string;
    url: string;
    content: string;
}

/** Odpowiedź `executeWebSearch` (to samo pudełko wraca też z cache'u). */
export interface WebSearchResponse {
    success: boolean;
    /** dostawca, który REALNIE obsłużył zapytanie */
    provider: string;
    /** ustawiane tylko po zejściu na darmową podłogę */
    fallback_from?: string;
    query: string;
    results: WebSearchResult[];
    count: number;
    /** trafienie w cache — u dostawcy NIC się nie zużyło */
    cached?: boolean;
}

/** Wynik `readWebPage`. */
export interface WebPageRead {
    success: boolean;
    url: string;
    title: string;
    content: string;
}

/** Slice `settings.pkmAssistant.webSearch` w zakresie, który czyta ten plik. */
export interface WebSearchProviderSettings {
    provider?: string;
    /** legacy — należy do AKTUALNIE wybranego dostawcy */
    apiKey?: string;
    apiKeys?: Record<string, string>;
    instanceUrl?: string;
}

/** Implementacja jednego dostawcy. `instanceUrl` czyta wyłącznie SearXNG. */
type ProviderSearchFn = (
    query: string,
    limit: number,
    apiKey: string,
    instanceUrl?: string,
) => Promise<WebSearchResult[]>;

/** Wpis rejestru dostawców — patrz komentarz nad `WEB_SEARCH_PROVIDERS`. */
export interface WebSearchProviderInfo {
    label: string;
    requiresKey: boolean;
    keyOptional?: boolean;
    requiresUrl: boolean;
    fn: ProviderSearchFn;
}

/** Kształt, w jakim CZYTAMY błąd sieci — 5 dostawców rzuca 5 różnymi obiektami. */
type ErrLike = { message?: string; status?: number };

// ═══════════════════════════════════════════
// IN-MEMORY CACHE (5 min TTL)
// ═══════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60 * 1000;
const _searchCache = new Map<string, { data: WebSearchResponse; ts: number }>();

function _getCacheKey(query: string, providerId: string, limit: number): string {
    return `${providerId}::${limit}::${query.toLowerCase().trim()}`;
}

function _getCached(key: string): WebSearchResponse | null {
    const entry = _searchCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _searchCache.delete(key);
        return null;
    }
    return entry.data;
}

function _setCache(key: string, data: WebSearchResponse): void {
    // Cap at 50 entries to prevent memory bloat
    if (_searchCache.size >= 50) {
        // Mapa jest niepusta (rozmiar >= 50), więc pierwszy klucz istnieje.
        const oldest = _searchCache.keys().next().value as string;
        _searchCache.delete(oldest);
    }
    _searchCache.set(key, { data, ts: Date.now() });
}

// ═══════════════════════════════════════════
// PROVIDER IMPLEMENTATIONS
// ═══════════════════════════════════════════

/**
 * Jina AI — domyślny provider.
 * s.jina.ai → search + pełna treść stron (nie snippety!)
 * Działa BEZ klucza API (3 RPM). Z kluczem: 100 RPM + 10M tokenów/mies.
 */
async function jinaSearch(query: string, limit: number, apiKey: string): Promise<WebSearchResult[]> {
    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'X-Return-Format': 'json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    log.debug('WebSearch', `Jina search: ${query}`);

    try {
        const response = await requestUrl({ url, headers, method: 'GET' });
        const data = JSON.parse(response.text) as {
            data?: Array<{ title?: string; url?: string; content?: string; description?: string }>;
        };

        // Jina zwraca { data: [{title, url, content, description}] }
        const results = (data.data || []).slice(0, limit).map(item => ({
            title: item.title || t('websearch.no_title'),
            url: item.url || '',
            content: item.content || item.description || ''
        }));

        return results;
    } catch (err) {
        // 401 = Jina wymaga klucza API
        if ((err as ErrLike).status === 401 || (err as ErrLike).message?.includes('401')) {
            throw new Error(t('websearch.jina_needs_key'));
        }
        throw err;
    }
}

/**
 * Tavily — AI-focused search API.
 * Wymaga klucza API (1000 zapytań/mies. free).
 */
async function tavilySearch(query: string, limit: number, apiKey: string): Promise<WebSearchResult[]> {
    if (!apiKey) throw new Error(t('websearch.tavily_needs_key'));

    const response = await requestUrl({
        url: 'https://api.tavily.com/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: limit,
            include_answer: false
        })
    });
    const data = JSON.parse(response.text) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return (data.results || []).map(item => ({
        title: item.title || '(brak tytułu)',
        url: item.url || '',
        content: item.content || ''
    }));
}

/**
 * Brave Search API.
 * Wymaga klucza API (~1000 zapytań/mies. free z $5 kredytu).
 */
async function braveSearch(query: string, limit: number, apiKey: string): Promise<WebSearchResult[]> {
    if (!apiKey) throw new Error(t('websearch.brave_needs_key'));

    const response = await requestUrl({
        url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey
        }
    });
    const data = JSON.parse(response.text) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    return (data.web?.results || []).map(item => ({
        title: item.title || '(brak tytułu)',
        url: item.url || '',
        content: item.description || ''
    }));
}

/**
 * SearXNG — self-hosted metasearch.
 * User podaje URL swojej instancji. Zero limitów, zero kosztów.
 */
async function searxngSearch(
    query: string,
    limit: number,
    _apiKey: string,
    instanceUrl?: string,
): Promise<WebSearchResult[]> {
    if (!instanceUrl) throw new Error(t('websearch.searxng_needs_url'));

    const url = `${instanceUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing,duckduckgo`;
    const response = await requestUrl({ url, method: 'GET' });
    const data = JSON.parse(response.text) as {
        results?: Array<{ title?: string; url?: string; content?: string; snippet?: string }>;
    };

    return (data.results || []).slice(0, limit).map(item => ({
        title: item.title || '(brak tytułu)',
        url: item.url || '',
        content: item.content || item.snippet || ''
    }));
}

/**
 * Serper.dev — Google Search API wrapper.
 * Wymaga klucza API (2500 zapytań jednorazowo free).
 */
async function serperSearch(query: string, limit: number, apiKey: string): Promise<WebSearchResult[]> {
    if (!apiKey) throw new Error(t('websearch.serper_needs_key'));

    const response = await requestUrl({
        url: 'https://google.serper.dev/search',
        method: 'POST',
        headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, num: limit })
    });
    const data = JSON.parse(response.text) as {
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
    };

    return (data.organic || []).map(item => ({
        title: item.title || '(brak tytułu)',
        url: item.link || '',
        content: item.snippet || ''
    }));
}

// ═══════════════════════════════════════════
// PROVIDER REGISTRY
// ═══════════════════════════════════════════

/**
 * `requiresKey` = bez klucza NIE MA jak strzelić (bramka rzuca przed requestem).
 * `keyOptional` = działa bez klucza, ale z kluczem jest lepiej (wyższy limit) —
 * Ustawienia pokazują wtedy pole klucza z opisem „opcjonalny".
 *
 * DLACZEGO Jina ma `requiresKey: false` + `keyOptional: true`: z `requiresKey: true`
 * bramka rzucałaby zanim cokolwiek poleciało, a obiecany w UI tryb bezkluczowy
 * (3 zapytania/min) byłby NIEOSIĄGALNY.
 */
export const WEB_SEARCH_PROVIDERS: Record<string, WebSearchProviderInfo> = {
    jina:    { get label() { return t('websearch.provider.jina'); }, requiresKey: false, keyOptional: true, requiresUrl: false, fn: jinaSearch },
    tavily:  { label: 'Tavily',            requiresKey: true,  requiresUrl: false, fn: tavilySearch },
    brave:   { label: 'Brave Search',      requiresKey: true,  requiresUrl: false, fn: braveSearch },
    serper:  { label: 'Serper.dev',        requiresKey: true,  requiresUrl: false, fn: serperSearch },
    searxng: { get label() { return t('websearch.provider.searxng'); }, requiresKey: false, requiresUrl: true, fn: searxngSearch },
};

/**
 * Klucz API dla konkretnego dostawcy.
 *
 * DLACZEGO osobna szufladka per dostawca: JEDNO wspólne pole `ws.apiKey` znaczyłoby,
 * że zmiana dostawcy wymaga przeklejenia klucza, a klucz Tavily poleciałby do Jiny
 * (401). Każdy dostawca ma więc własną szufladkę `ws.apiKeys.<id>`; stare pole
 * czytamy jako fallback dla AKTUALNIE wybranego dostawcy i NIE kasujemy go (zero
 * migracji danych na dysku).
 *
 * @param settings - pkmAssistant.webSearch
 * @returns klucz albo pusty string
 */
export function resolveProviderKey(settings: WebSearchProviderSettings = {}, providerId: string): string {
    const perProvider = settings.apiKeys?.[providerId];
    if (perProvider) return perProvider;
    // Legacy `apiKey` należy do dostawcy, który był wtedy wybrany — nie rozdajemy go innym.
    const selected = settings.provider || 'jina';
    if (providerId === selected && settings.apiKey) return settings.apiKey;
    return '';
}

/** Links where user can create free accounts. */
export const PROVIDER_SIGNUP_URLS: Record<string, string> = {
    jina:    'https://jina.ai/reader/',
    tavily:  'https://tavily.com/',
    brave:   'https://brave.com/search/api/',
    serper:  'https://serper.dev/',
    searxng: 'https://docs.searxng.org/',
};

// ═══════════════════════════════════════════
// MAIN SEARCH FUNCTION
// ═══════════════════════════════════════════

/**
 * Execute web search via configured provider.
 *
 * WARSTWY: wybrany dostawca siedzi NA darmowej podłodze. Gdy płatny padnie
 * (401, wyczerpany limit, brak sieci), automatycznie
 * lecimy drugi raz przez Jinę — user dostaje wyniki zamiast błędu, a wynik niesie
 * `fallback_from`, żeby narzędzie mogło to uczciwie napisać modelowi. Gdy padnie
 * też podłoga — rzucamy ORYGINALNY błąd wybranego dostawcy (czytelniejszy: mówi
 * o tym, co user faktycznie skonfigurował).
 *
 * @param query - Search query
 * @param settings - pkmAssistant.webSearch settings
 * @param limit - Max results
 */
export async function executeWebSearch(
    query: string,
    settings: WebSearchProviderSettings = {},
    limit = 5,
): Promise<WebSearchResponse> {
    const providerId = settings.provider || 'jina';
    const provider = WEB_SEARCH_PROVIDERS[providerId];

    if (!provider) {
        throw new Error(t('websearch.unknown_provider', { provider: providerId }));
    }

    const apiKey = resolveProviderKey(settings, providerId);

    if (provider.requiresKey && !apiKey) {
        throw new Error(t('websearch.needs_api_key', { provider: provider.label }));
    }

    if (provider.requiresUrl && !settings.instanceUrl) {
        throw new Error(t('websearch.needs_instance_url', { provider: provider.label }));
    }

    // Check cache first
    const cacheKey = _getCacheKey(query, providerId, limit);
    const cached = _getCached(cacheKey);
    if (cached) {
        log.debug('WebSearch', `Cache hit: "${query}"`);
        // `cached` mówi callerowi, że u dostawcy NIC się nie zużyło (licznik tego nie liczy).
        return { ...cached, cached: true };
    }

    const startTime = Date.now();
    let result: WebSearchResponse;

    try {
        const results = await provider.fn(query, limit, apiKey, settings.instanceUrl);
        const duration = Date.now() - startTime;
        log.info('WebSearch', `${provider.label}: "${query}" → ${results.length} wyników (${duration}ms)`);

        result = {
            success: true,
            provider: providerId,
            query,
            results,
            count: results.length
        };
    } catch (error) {
        log.error('WebSearch', `${provider.label} błąd:`, error);
        if (providerId === 'jina') throw error;

        log.warn('WebSearch', t('websearch.fallback_note', { from: provider.label, to: WEB_SEARCH_PROVIDERS.jina.label }));
        let fallbackResults: WebSearchResult[];
        try {
            // Podłoga bierze WYŁĄCZNIE swój klucz (legacy `apiKey` należy do wybranego dostawcy).
            fallbackResults = await jinaSearch(query, limit, settings.apiKeys?.jina || '');
        } catch (fallbackError) {
            log.error('WebSearch', 'Podłoga Jina też padła:', fallbackError);
            throw error;
        }

        result = {
            success: true,
            provider: 'jina',
            fallback_from: providerId,
            query,
            results: fallbackResults,
            count: fallbackResults.length
        };
    }

    // Cache pod kluczem ŻĄDANEGO dostawcy — to jest odpowiedź na to zapytanie w tej konfiguracji.
    _setCache(cacheKey, result);
    return result;
}

/**
 * Read full content of a single URL via Jina Reader.
 *
 * Reader (r.jina.ai) jest ZAWSZE Jiny, niezależnie od wybranego dostawcy wyszukiwania —
 * więc klucz też bierzemy Jiny (`apiKeys.jina`, legacy `apiKey` tylko gdy Jina jest
 * wybranym dostawcą). Klucz DOWOLNEGO INNEGO dostawcy dawałby przy wybranym
 * Tavily/Brave 401 od readera.
 *
 * PDF: reader sam ekstrahuje tekst z PDF-ów — przekazujemy takie
 * URL-e normalnie, bez żadnej biblioteki po naszej stronie. Binaria, których reader
 * nie umie przeczytać (obrazy, archiwa), dają uczciwy komunikat zamiast pustki albo
 * surowego wyjątku parsera.
 *
 * @param url - URL to read
 * @param settings - pkmAssistant.webSearch settings (for API key)
 */
export async function readWebPage(
    url: string,
    settings: WebSearchProviderSettings = {},
): Promise<WebPageRead> {
    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'X-Return-Format': 'json',
    };
    const jinaKey = resolveProviderKey(settings, 'jina');
    if (jinaKey) {
        headers['Authorization'] = `Bearer ${jinaKey}`;
    }

    const readerUrl = `https://r.jina.ai/${url}`;
    // STRAŻNIK KANONICZNOŚCI. Reader przyjmuje adres doklejony do
    // własnej ścieżki, więc segmenty `..` w adresie zwijają się PO sklejce: filtr domen widzi
    // `good.com`, a request leci na `evil.com`. Jeśli kanoniczny `href` sklejki różni się od
    // tego, co skleiliśmy — adres nie był kanoniczny i nie ruszamy nigdzie.
    if (new URL(readerUrl).href !== readerUrl) {
        throw new Error(t('websearch.read_error', {
            url,
            error: 'URL nie jest kanoniczny — sklejka z readerem zmieniłaby adres docelowy.',
        }));
    }
    log.debug('WebRead', `Reading: ${url}`);

    const startTime = Date.now();
    let response: RequestUrlResponse;
    try {
        response = await requestUrl({ url: readerUrl, headers, method: 'GET' });
    } catch (err) {
        if ((err as ErrLike).status === 401 || (err as ErrLike).message?.includes('401')) {
            throw new Error(t('websearch.jina_reader_needs_key'));
        }
        throw new Error(t('websearch.read_error', { url, error: (err as ErrLike).message }));
    }

    let data: { data?: { url?: string; title?: string; content?: string; description?: string } };
    try {
        data = JSON.parse(response.text) as typeof data;
    } catch {
        // Reader oddał coś, co nie jest JSON-em — praktycznie zawsze binarka, której nie umiał przerobić.
        throw new Error(t('websearch.unreadable_binary', { url }));
    }

    const content = data?.data?.content || data?.data?.description || '';
    if (!content.trim()) {
        // Reader ODDAŁ poprawny JSON, tylko bez treści — to NIE binarka (paywall, pusta
        // strona, treść wyłącznie z JS). Kłamanie „binarka" wysyłało model w złą stronę.
        throw new Error(t('websearch.no_content', { url }));
    }

    log.info('WebRead', `"${url}" → ${content.length} chars (${Date.now() - startTime}ms)`);

    return {
        success: true,
        url: data.data?.url || url,
        title: data.data?.title || t('websearch.no_title'),
        content
    };
}
