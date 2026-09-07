/**
 * Slice ustawień, z którego czytamy limit odpowiedzi. Oba pola opcjonalne — user może nie mieć
 * ani nowego (`pkmAssistant.maxTokens`), ani globalnego (`pkmAssistant.chat.maxTokens`) wpisu.
 */
export type MaxTokensSettingsLike = {
    pkmAssistant?: {
        maxTokens?: Record<string, unknown>;
        chat?: { maxTokens?: unknown } | null;
    } | null;
} | null;

/** Argumenty `resolveMaxOutputTokens` — wszystko opcjonalne, wołacze podają co mają. */
export type ResolveMaxOutputTokensArgs = {
    settings?: MaxTokensSettingsLike;
    platform?: string;
    modelId?: string;
    modelData?: { max_output_tokens?: unknown } | null;
};

/**
 * Kształt `usage` z odpowiedzi modelu. Każda platforma nazywa cache inaczej, stąd trzy warianty
 * tego samego pojęcia obok siebie.
 */
export type UsageLike = {
    prompt_tokens?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number } | null;
    cache_read_input_tokens?: number;
    cached_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation_tokens?: number;
} | null;

/** Metadane cache promptu (S06) — składane przez konsumentów promptu. */
export type CacheMetadata = {
    cached_tokens: number;
    cache_creation_tokens: number;
    total_input_tokens: number;
    savings_pct: number;
    savings_usd: number;
};

export const MODEL_MAX_TOKENS_DEFAULTS = {
    anthropic: 8192,
    openai: 16384,
    xai: 8192,
    ollama: 4096,
    gemini: 8192,
};

export function resolveMaxOutputTokens({ settings = {}, platform = '', modelId = '', modelData = {} }: ResolveMaxOutputTokensArgs = {}): number {
    const pkmMax = settings?.pkmAssistant?.maxTokens || {};
    const globalMax = settings?.pkmAssistant?.chat?.maxTokens;
    const override = Number(pkmMax[platform]);
    if (Number.isFinite(override) && override > 0) return override;
    if (Number.isFinite(Number(globalMax)) && Number(globalMax) > 0) return Number(globalMax);

    const key = String(modelId || '').toLowerCase();
    if (platform === 'anthropic' || key.includes('claude')) return MODEL_MAX_TOKENS_DEFAULTS.anthropic;
    if (platform === 'xai' || key.includes('grok')) return MODEL_MAX_TOKENS_DEFAULTS.xai;
    if (platform === 'ollama') return MODEL_MAX_TOKENS_DEFAULTS.ollama;
    if (platform === 'gemini' || key.includes('gemini')) return MODEL_MAX_TOKENS_DEFAULTS.gemini;
    if (platform === 'openai' || key.includes('gpt-4o') || key.includes('gpt-5')) return MODEL_MAX_TOKENS_DEFAULTS.openai;

    return Number(modelData?.max_output_tokens) || 4096;
}

// AUD-dead-code-214: `export` zdjęty z obu — jedyny wołacz każdej jest w tym pliku
// (`buildCacheMetadata` niżej). Barrel `index.ts` ich i tak nie eksportował (S30 Z4),
// a komentarz tam mylił czytelnika sugerując, że czytają je adaptery u siebie.
function getCachedTokensFromUsage(usage: UsageLike = {}): number {
    return Number(
        usage?.prompt_tokens_details?.cached_tokens
        || usage?.cache_read_input_tokens
        || usage?.cached_tokens
        || 0
    ) || 0;
}

function getCacheCreationTokensFromUsage(usage: UsageLike = {}): number {
    return Number(
        usage?.cache_creation_input_tokens
        || usage?.prompt_tokens_details?.cache_creation_tokens
        || usage?.cache_creation_tokens
        || 0
    ) || 0;
}

export function buildCacheMetadata(usage: UsageLike = {}): CacheMetadata {
    const cachedTokens = getCachedTokensFromUsage(usage);
    const totalInputTokens = Number(usage?.prompt_tokens || usage?.input_tokens || 0) || 0;
    const cacheCreationTokens = getCacheCreationTokensFromUsage(usage);
    const savingsPct = totalInputTokens > 0 ? Math.round((cachedTokens / totalInputTokens) * 100) : 0;
    return {
        cached_tokens: cachedTokens,
        cache_creation_tokens: cacheCreationTokens,
        total_input_tokens: totalInputTokens,
        savings_pct: savingsPct,
        savings_usd: 0,
    };
}
