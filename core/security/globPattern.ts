/**
 * Kanoniczna konwersja glob-wzorca (`*` / `**`) na regex.
 *
 * AUD-code-review-033: `core/security/AccessGuard._matchesEntry` i (dawniej, do wywałki
 * 2026-09-03 — AUD-dead-code-031/115/172/216) `src/core/VaultZones.matchesPattern` miały
 * bajt-w-bajt ten sam łańcuch `.replace()`. Ten plik wyciąga WYŁĄCZNIE ten wspólny fragment
 * (podstawienie `**`/`*` na regex + ucieczka `/`) — reszta logiki wołacza (cache, specjalna
 * gałąź dla wzorca bez `*`, `_escapeRegex` w `AccessGuard`) ZOSTAJE w miejscu. Jedynym żywym
 * wołaczem jest dziś `AccessGuard._matchesEntry`.
 */
export function globPatternToRegex(pattern: string): RegExp {
    const regexStr = pattern
        .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DOUBLESTAR>>>/g, '.*')
        .replace(/\//g, '\\/');
    return new RegExp(`^${regexStr}$`);
}
