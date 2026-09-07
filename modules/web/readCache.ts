/**
 * Cache odczytów stron dla `web_read` (E3.3, mikro-decyzja 9).
 *
 * DLACZEGO TUTAJ, A NIE W PROVIDERZE: cache'ujemy WYNIK KOŃCOWY narzędzia — czyli
 * już PO ewentualnym streszczeniu tanim modelem. Gdyby cache siedział w
 * `readWebPage`, każdy hit i tak płaciłby za LLM. Dlatego `readWebPage` zostaje
 * bez cache, a finalny kształt (który zna dopiero narzędzie) ląduje tutaj.
 *
 * Cache wyszukiwania (5 min / 50 wpisów) żyje osobno, w `WebSearchProvider.js` —
 * to celowy rozdział: strona zmienia się wolniej niż wyniki wyszukiwarki, więc
 * dostaje dłuższe TTL.
 */
import { normalizeUrl } from './urlRegistry.js';

/**
 * Wynik końcowy narzędzia `web_read`. Cache go tylko PRZECHOWUJE — kształt zna
 * `modules/tools/WebReadTool.js`, nie ten plik.
 */
export type CachedReadValue = Record<string, unknown>;

const READ_CACHE_TTL_MS = 30 * 60 * 1000;
const READ_CACHE_MAX = 20;

const _readCache = new Map<string, { value: CachedReadValue; ts: number }>();

/**
 * Klucz cache. Limit przycięcia i tryb streszczania są CZĘŚCIĄ tożsamości wyniku —
 * ten sam URL przeczytany z innym limitem albo bez streszczenia to inny wynik.
 */
export function makeReadCacheKey(url: string, trimLimit: number, summarize: boolean): string {
    const canonical = normalizeUrl(url) || String(url ?? '');
    return `${canonical}::${trimLimit}::${summarize ? 's' : 'r'}`;
}

/**
 * @param now - wstrzykiwalny „teraz" w ms (testy)
 */
export function getCachedRead(key: string, now = Date.now()): CachedReadValue | null {
    const entry = _readCache.get(key);
    if (!entry) return null;
    if (now - entry.ts > READ_CACHE_TTL_MS) {
        _readCache.delete(key);
        return null;
    }
    return entry.value;
}

/**
 * @param value - finalny wynik narzędzia
 * @returns ta sama wartość (dla wygody: `return setCachedRead(...)`)
 */
export function setCachedRead<T extends CachedReadValue>(key: string, value: T, now = Date.now()): T {
    if (!key) return value;
    if (_readCache.size >= READ_CACHE_MAX && !_readCache.has(key)) {
        // Mapa jest niepusta (rozmiar >= limit), więc pierwszy klucz istnieje.
        const oldest = _readCache.keys().next().value as string;
        _readCache.delete(oldest);
    }
    _readCache.set(key, { value, ts: now });
    return value;
}

/** Test / reset helper — czyści cache. */
export function _clearReadCache(): void {
    _readCache.clear();
}
