/**
 * AUD-code-review-099: `InlineCommentModal` i `SendToAgentModal` (obie w `modules/shell/`,
 * wywoływane z menu kontekstowego edytora — podgląd zaznaczonego tekstu przed wysłaniem go do
 * agenta) miały wklejony osobno IDENTYCZNY blok obcinania podglądu. Kolejny modal typu
 * "wybierz i wyślij" powieliłby go po raz trzeci — stąd tutaj, dom klocka dla ≥2 modułów.
 *
 * @param text - pełny tekst (np. zaznaczenie usera w edytorze)
 * @param maxLength - maksymalna długość podglądu (default 500 znaków, jak dotychczasowa reguła)
 * @returns `text` bez zmian gdy mieści się w limicie, inaczej obcięty + `...`
 */
export function truncatePreview(text: string, maxLength: number = 500): string {
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}
