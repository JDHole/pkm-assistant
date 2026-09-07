/**
 * K8 (AUD-security-057): jednolinijkowe podsumowanie żądania HTTP do logu.
 *
 * Do K8 adapter w gałęzi błędu wypisywał `JSON.stringify(request_params, null, 2)`, czyli
 * KOMPLET parametrów razem z nagłówkiem `Authorization` / `x-api-key` — jedyną osłoną był
 * kształt wartości w `SensitiveDataGuard`. Diagnostyka potrzebuje adresu, metody, statusu
 * i czasu; treść nagłówków nie jest do niczego potrzebna, więc tu jej po prostu NIE MA
 * (lecą same NAZWY nagłówków). Plik jest node-safe (zero importu `obsidian`) właśnie po to,
 * żeby dało się go objąć testem AVA.
 */

/** Adres bez query i fragmentu — parametry ścieżki bywają nośnikiem tokenów. */
export function stripUrlSecrets(url: unknown): string {
    if (typeof url !== 'string' || !url) return '<brak url>';
    return url.split('#')[0].split('?')[0];
}

export interface HttpLogMeta {
    /** Status odpowiedzi, jeśli zdążyła przyjść. */
    status?: unknown;
    /** Czas od startu żądania w ms. */
    durationMs?: number;
}

/**
 * Buduje bezpieczną linię logu z parametrów żądania.
 * @param params - `unknown`, bo parametry przychodzą z adapterów modeli bez gwarancji typu.
 * @param meta - status + czas trwania (opcjonalne).
 */
export function summarizeHttpRequest(params: unknown, meta: HttpLogMeta = {}): string {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const method = typeof p.method === 'string' && p.method ? p.method.toUpperCase() : 'GET';
    const url = stripUrlSecrets(p.url);

    const rawHeaders = p.headers;
    const headerNames = rawHeaders && typeof rawHeaders === 'object'
        ? Object.keys(rawHeaders as Record<string, unknown>).map(h => h.toLowerCase())
        : [];

    const parts = [`${method} ${url}`];
    if (meta.status !== undefined && meta.status !== null) parts.push(`status: ${String(meta.status)}`);
    if (typeof meta.durationMs === 'number') parts.push(`${meta.durationMs} ms`);
    // WYŁĄCZNIE nazwy nagłówków — wartości nigdy nie wchodzą do logu.
    if (headerNames.length) parts.push(`nagłówki: ${headerNames.join(', ')}`);
    return parts.join(' | ');
}
