/**
 * modules/embedding/tokens.ts — estymacja tokenów + przycinanie do budżetu (B.5 EB-13, B.6 GM-04).
 *
 * DLACZEGO NA PIECHOTĘ: prawdziwy tokenizator (tiktoken) wyleciał z bundla w E1.7 — ważył
 * więcej niż cała reszta pluginu. Zostaje kalibracja „znaki / {@link TOKEN_CHARS_PER_TOKEN}",
 * czyli przybliżenie liczone dla angielszczyzny. Polski tekst ma tokeny KRÓTSZE, więc ta
 * estymata potrafi zaniżyć realną liczbę tokenów — dlatego wołacz nie tnie do samego limitu
 * modelu, tylko do `floor(limit × EMBED_TRIM_SAFETY_FACTOR)`.
 *
 * Funkcje są wewnętrzne dla modułu: nie wychodzą przez barrel.
 */
import { TOKEN_CHARS_PER_TOKEN } from './contracts.js';

/**
 * Estymata tokenów: znaki / {@link TOKEN_CHARS_PER_TOKEN}, zaokrąglona W GÓRĘ.
 * Pusty tekst (i wejście nie-tekstowe) to 0 tokenów.
 */
export function estimateTokens(text: string): number {
    const length = typeof text === 'string' ? text.length : 0;
    if (length === 0) return 0;
    return Math.ceil(length / TOKEN_CHARS_PER_TOKEN);
}

/**
 * Przycina tekst tak, by {@link estimateTokens} wyniku nie przekroczyła `maxTokens`.
 *
 * Nigdy nie tnie do zera: budżet mniejszy od jednego tokenu i tak zostawia garść znaków —
 * pusty string byłby dla dostawcy wejściem nieprawidłowym, a dla indeksera cichą stratą pliku.
 */
export function trimToTokenBudget(text: string, maxTokens: number): string {
    if (typeof text !== 'string' || text.length === 0) return text;

    const budget = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1;
    if (estimateTokens(text) <= budget) return text;

    // Zaokrąglenie w dół po stronie znaków — po przycięciu estymata ma się ZMIEŚCIĆ w budżecie,
    // a nie trafić w niego z góry.
    const maxChars = Math.max(1, Math.floor(budget * TOKEN_CHARS_PER_TOKEN));
    return text.slice(0, maxChars);
}
