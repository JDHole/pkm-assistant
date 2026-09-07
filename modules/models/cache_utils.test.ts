/**
 * `cache_utils.ts` — limity odpowiedzi i metadane cache promptu (luki L-11/L-12).
 *
 * Plik przechodzi clean-room nietknięty poza jednym renamem ścieżki ustawień
 * (`pkmAssistant.chat.maxTokens`), ale do tej pory nie miał WŁASNEGO pliku testów — jedyny
 * przypadek („cache metadata normalizes cached token usage") mieszkał w testach cache promptu
 * po stronie dostawców. Tu jest jego dom.
 */
import test from 'ava';
import { MODEL_MAX_TOKENS_DEFAULTS, buildCacheMetadata, resolveMaxOutputTokens } from './cache_utils.js';

test('cache metadata normalizes cached token usage', t => {
    t.deepEqual(buildCacheMetadata({
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 750 },
    }), {
        cached_tokens: 750,
        cache_creation_tokens: 0,
        total_input_tokens: 1000,
        savings_pct: 75,
        savings_usd: 0,
    });
});

/**
 * N27 (luka L-11, B.12 CU-02): sześć gałęzi po kolei — override per platforma, globalny limit
 * z ustawień czatu, dopasowanie po platformie, dopasowanie po FRAGMENCIE nazwy modelu,
 * metadana modelu, twardy default 4096.
 */
test('L-11: resolveMaxOutputTokens — sześć gałęzi po kolei', t => {
    t.is(
        resolveMaxOutputTokens({
            settings: { pkmAssistant: { maxTokens: { anthropic: 1234 }, chat: { maxTokens: 999 } } },
            platform: 'anthropic',
            modelId: 'claude-sonnet-4-20250514',
        }),
        1234,
        '1. override per platforma wygrywa ze wszystkim',
    );

    t.is(
        resolveMaxOutputTokens({
            settings: { pkmAssistant: { chat: { maxTokens: 999 } } },
            platform: 'anthropic',
            modelId: 'claude-sonnet-4-20250514',
        }),
        999,
        '2. globalny limit z pkmAssistant.chat.maxTokens',
    );

    t.is(
        resolveMaxOutputTokens({ platform: 'anthropic', modelId: 'cokolwiek' }),
        MODEL_MAX_TOKENS_DEFAULTS.anthropic,
        '3. dopasowanie po PLATFORMIE',
    );

    t.is(
        resolveMaxOutputTokens({ platform: '', modelId: 'jakis-gemini-pro' }),
        MODEL_MAX_TOKENS_DEFAULTS.gemini,
        '4. dopasowanie po FRAGMENCIE nazwy modelu',
    );

    t.is(
        resolveMaxOutputTokens({ platform: 'nieznana', modelId: 'nieznany', modelData: { max_output_tokens: 555 } }),
        555,
        '5. metadana modelu z listy dostawcy',
    );

    t.is(resolveMaxOutputTokens(), 4096, '6. twardy default');
    t.is(resolveMaxOutputTokens({ platform: 'nieznana', modelId: 'nieznany' }), 4096, '6. j.w. dla nieznanej pary');
});

/** N28 (luka L-12, B.12 CU-05): zero dzielenia przez zero i brak wywrotki na pustym usage. */
test('L-12: buildCacheMetadata na usage null/undefined i przy prompt_tokens === 0', t => {
    const empty = { cached_tokens: 0, cache_creation_tokens: 0, total_input_tokens: 0, savings_pct: 0, savings_usd: 0 };

    t.deepEqual(buildCacheMetadata(null), empty, 'null nie może rzucić');
    t.deepEqual(buildCacheMetadata(undefined), empty, 'undefined nie może rzucić');
    t.deepEqual(buildCacheMetadata({}), empty, 'pusty obiekt = same zera');

    const zeroPrompt = buildCacheMetadata({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 5 } });
    t.is(zeroPrompt.savings_pct, 0, 'prompt_tokens === 0 → savings_pct 0, NIE Infinity ani NaN');
    t.is(zeroPrompt.cached_tokens, 5, 'licznik cache zostaje, mimo zerowego mianownika');
});

/** N29 (luka L-12, CU-03/CU-04): wariant Anthropica — `input_tokens` i `cache_creation_*`. */
test('L-12: wariant input_tokens i cache_creation_tokens (Anthropic)', t => {
    const meta = buildCacheMetadata({
        input_tokens: 2000,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 600,
    });

    t.is(meta.total_input_tokens, 2000, 'total_input_tokens spada na input_tokens, gdy nie ma prompt_tokens');
    t.is(meta.cached_tokens, 400, 'cached_tokens z cache_read_input_tokens');
    t.is(meta.cache_creation_tokens, 600, 'cache_creation_tokens z pola Anthropica');
    t.is(meta.savings_pct, 20, 'round(400 / 2000 * 100)');

    // Wariant OpenAI-kształtny z zagnieżdżonym detalem — ta sama trójka pól, inne nazwy.
    const nested = buildCacheMetadata({
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 100, cache_creation_tokens: 200 },
    });
    t.is(nested.cached_tokens, 100);
    t.is(nested.cache_creation_tokens, 200);
});
