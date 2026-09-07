/**
 * Lekki estymator tokenów — ZERO zależności (js-tiktoken RIP, decyzja D23/E1.7).
 *
 * Dlaczego estymator zamiast prawdziwego tokenizera:
 * - Realne zużycie tokenów bierzemy z API usage (adaptery modeli zwracają usage).
 * - Ten moduł liczy tokeny TYLKO tam, gdzie szacujemy PRZED wysłaniem do API:
 *   okno kontekstu (RollingWindow) i koszt definicji narzędzi (ToolTokenCache).
 *   Dokładność co do tokena jest tu zbędna — ważne, żeby raczej PRZESZACOWAĆ
 *   (nigdy nie przepełnić okna kontekstu).
 * - js-tiktoken woził ~MB tablic BPE OpenAI, a i tak dawał tylko oszacowanie dla
 *   11 z 12 platform (stary komentarz sam to przyznawał). Wywałka: bundle 8,3 → ~2-3 MB.
 *
 * Wzór:   tokeny = ceil( znaki / chars_per_token_efektywne ) * MARGINES
 *   - chars_per_token bazowo 4.0 (angielski), KALIBROWANE z realnego usage (EMA per platforma),
 *   - korekta non-ASCII: tekst z diakrytykami / CJK ma mniej znaków na token → więcej tokenów,
 *   - MARGINES ×1,2: okno kontekstu celowo przeszacowuje (bezpieczniejsza strona).
 */
import { log } from './Logger.js';

// Bazowy stosunek znaki/token (angielski tekst ~4). Świeży start = ten default.
const DEFAULT_CHARS_PER_TOKEN = 4.0;
// Margines bezpieczeństwa dla okna kontekstu — celowo przeszacowujemy (D23/E1.7).
const SAFETY_MARGIN = 1.2;
// Waga uczenia EMA przy kalibracji z realnego usage (0..1, wyżej = szybciej zapomina).
const EMA_ALPHA = 0.2;
// Jak mocno udział znaków spoza ASCII skraca chars-per-token (0..1).
const NON_ASCII_WEIGHT = 0.3;
// Dolny bezpiecznik efektywnego chars-per-token (nie dzielimy przez <1.5).
const MIN_EFFECTIVE_CPT = 1.5;
// Realistyczny zakres chars-per-token przy kalibracji (odsiew śmieciowego usage).
const MIN_OBSERVED_CPT = 1.0;
const MAX_OBSERVED_CPT = 20.0;

// Kalibrowane chars-per-token per platforma. In-memory (brak persystencji =
// świeży start po restarcie Obsidiana daje default 4.0 — świadomie, patrz E1.7).
const _cptByPlatform = new Map<string, number>();

// Globalny kalibrowany chars-per-token — używany przez estymaty BEZ platformy.
// Kluczowe: okno kontekstu (RollingWindow) i koszt narzędzi (ToolTokenCache) wołają
// getTokenCount/countTokens BEZ { platform }, więc bez tego kanału kalibracja z API
// nigdy nie dotarłaby do liczb okna kontekstu. Konwerguje do platformy, z którą user
// aktualnie rozmawia (w praktyce jedna naraz).
let _globalCpt = DEFAULT_CHARS_PER_TOKEN;

/**
 * Drugi argument publicznych funkcji: nazwa modelu (string, zaszłość po tiktoken — ignorowana)
 * ALBO obiekt opcji. Historyczna unia, patrz `countTokens`.
 */
export type TokenCountOpts = string | { model?: string; platform?: string };

function _asString(text: unknown): string {
    return typeof text === 'string' ? text : String(text);
}

function _resolvePlatform(modelOrOpts: TokenCountOpts | undefined): string {
    if (modelOrOpts && typeof modelOrOpts === 'object') return modelOrOpts.platform || '';
    return '';
}

function _charsPerTokenFor(platform?: string): number {
    // Platforma nazwana → jej własna kalibracja lub default (izolacja między platformami).
    if (platform) return _cptByPlatform.has(platform) ? _cptByPlatform.get(platform)! : DEFAULT_CHARS_PER_TOKEN;
    // Bez platformy (okno kontekstu / koszt narzędzi) → globalny kalibrowany współczynnik.
    return _globalCpt;
}

/** Ile znaków spoza ASCII — jedyne, czego estymator potrzebuje poza długością. */
export function countNonAsciiChars(str: string): number {
    let nonAscii = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) > 127) nonAscii++;
    }
    return nonAscii;
}

/**
 * Surowa estymata (BEZ marginesu) ze STATYSTYK tekstu, nie z samego tekstu.
 * Wewnętrzna — publiczne API dokłada margines.
 */
function _estimateRawFromStats(charCount: number, nonAsciiCount: number, platform?: string): number {
    if (charCount <= 0) return 0;
    const base = _charsPerTokenFor(platform);
    const ratio = nonAsciiCount / charCount;
    // Więcej non-ASCII → mniejszy efektywny chars-per-token → więcej tokenów.
    const effective = Math.max(MIN_EFFECTIVE_CPT, base * (1 - NON_ASCII_WEIGHT * ratio));
    return Math.ceil(charCount / effective);
}

/**
 * Surowa estymata (BEZ marginesu). Uwzględnia kalibrację per platforma i
 * heurystykę non-ASCII. Wewnętrzna — publiczne API dokłada margines.
 */
function _estimateRaw(str: string, platform?: string): number {
    if (!str.length) return 0;
    return _estimateRawFromStats(str.length, countNonAsciiChars(str), platform);
}

/**
 * Szacuje liczbę tokenów tekstu (Z marginesem bezpieczeństwa).
 * Sygnatura zachowana z wersji tiktoken: drugi arg to model (string) lub
 * opcje ({ model, platform }). Używamy TYLKO `platform` (do kalibracji);
 * `model` jest ignorowany, ale przyjmowany dla wstecznej kompatybilności.
 * @param text - `unknown`, bo funkcja sama robi `_asString` (wołacze podają czasem nie-string)
 * @param modelOrOpts
 */
export function countTokens(text: unknown, modelOrOpts?: TokenCountOpts): number {
    if (!text) return 0;
    const str = _asString(text);
    if (!str.length) return 0;
    const platform = _resolvePlatform(modelOrOpts);
    return Math.ceil(_estimateRaw(str, platform) * SAFETY_MARGIN);
}

/**
 * Ta sama estymata co `countTokens`, ale ze STATYSTYK tekstu (długość + liczba znaków spoza
 * ASCII) zamiast z samego tekstu. Wynik jest IDENTYCZNY z `countTokens(tekst)` dla tekstu
 * o tych statystykach — obie wartości są addytywne po konkatenacji, więc wołacz może je
 * utrzymywać przyrostowo zamiast sklejać cały materiał i skanować go od nowa.
 *
 * Konsument: okno kontekstu czatu (`modules/chat/chat/RollingWindow.ts`, AUD-wydajnosc-017/048)
 * — bez tego KAŻDY dopisek wiadomości przeliczał całą historię od zera.
 * @param charCount - łączna liczba znaków
 * @param nonAsciiCount - ile z nich jest spoza ASCII (patrz `countNonAsciiChars`)
 * @param modelOrOpts
 */
export function countTokensFromStats(charCount: number, nonAsciiCount: number, modelOrOpts?: TokenCountOpts): number {
    if (!(charCount > 0)) return 0;
    const platform = _resolvePlatform(modelOrOpts);
    return Math.ceil(_estimateRawFromStats(charCount, nonAsciiCount, platform) * SAFETY_MARGIN);
}

/**
 * Najprostsza estymata: znaki / 4, bez marginesu i kalibracji.
 * Używana do SYNTEZY usage gdy model lokalny nie zwraca własnego (streamHelper) —
 * tam nie chcemy zawyżać raportowanego kosztu marginesem.
 * @param text
 */
export function countTokensSimple(text: unknown): number {
    if (!text) return 0;
    return Math.ceil(_asString(text).length / DEFAULT_CHARS_PER_TOKEN);
}

/**
 * Bezpieczny wrapper — nigdy nie rzuca. Preferowany przez okno kontekstu.
 * @param text
 * @param modelOrOpts
 */
export function getTokenCount(text: unknown, modelOrOpts?: TokenCountOpts): number {
    try {
        return countTokens(text, modelOrOpts);
    } catch (e) {
        log.warn('tokenCounter', 'estimate failed, using simple counter:', e);
        return countTokensSimple(text);
    }
}

/**
 * Kalibracja: uczy się realnego chars-per-token z usage zwróconego przez API.
 * Wołane przez chat gdy dostaje `usage.prompt_tokens` dla wysłanego kontekstu.
 * EMA per platforma; brak persystencji (świeży start = default 4.0).
 * @param platform - klucz platformy (np. 'anthropic', 'openai', 'ollama')
 * @param realTokens - tokeny z API (np. prompt_tokens)
 * @param charCount - liczba znaków wysłanego tekstu
 */
export function calibrate(platform: string, realTokens: number, charCount: number): void {
    if (!platform) return;
    if (!(realTokens > 0) || !(charCount > 0)) return;
    const observed = charCount / realTokens;
    // Odsiew: realistyczny chars-per-token to ~1..20; poza tym to zły sygnał.
    const clamped = Math.min(MAX_OBSERVED_CPT, Math.max(MIN_OBSERVED_CPT, observed));
    // Per-platforma EMA (dla estymat z { platform }).
    const prev = _cptByPlatform.has(platform) ? _cptByPlatform.get(platform)! : DEFAULT_CHARS_PER_TOKEN;
    _cptByPlatform.set(platform, prev + EMA_ALPHA * (clamped - prev));
    // Globalny EMA (dla estymat bez platformy — okno kontekstu, koszt narzędzi).
    _globalCpt = _globalCpt + EMA_ALPHA * (clamped - _globalCpt);
}

/**
 * Zwraca aktualny kalibrowany chars-per-token dla platformy (diagnostyka/testy).
 * @param platform
 */
export function getCalibratedCharsPerToken(platform?: string): number {
    return _charsPerTokenFor(platform);
}

/**
 * Reset kalibracji (głównie do testów; in-memory i tak znika przy restarcie).
 */
export function resetCalibration(): void {
    _cptByPlatform.clear();
    _globalCpt = DEFAULT_CHARS_PER_TOKEN;
}
