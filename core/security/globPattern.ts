/**
 * Kanoniczna konwersja glob-wzorca (`*` / `**`) na regex.
 *
 * Ten plik wyciąga WYŁĄCZNIE podstawienie `**`/`*` na regex + ucieczkę `/` — reszta logiki
 * wołacza (cache, specjalna gałąź dla wzorca bez `*`, `_escapeRegex`) zostaje w `AccessGuard`.
 * Jedynym żywym wołaczem jest dziś `AccessGuard._matchesEntry`.
 */
export function globPatternToRegex(pattern: string): RegExp {
    const regexStr = pattern
        .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DOUBLESTAR>>>/g, '.*')
        .replace(/\//g, '\\/');
    return new RegExp(`^${regexStr}$`);
}
