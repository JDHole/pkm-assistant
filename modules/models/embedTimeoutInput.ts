/**
 * modules/models/embedTimeoutInput.ts — parsowanie pola „Limit czasu żądania" (Ustawienia →
 * Modele → Embedding). User wpisuje SEKUNDY; magazyn (`EmbeddingSettingsSlice.timeoutMs`,
 * `core/runtime/contracts.ts`) trzyma MILISEKUNDY — przeliczenie (×1000 przy zapisie) robi
 * wołacz (`SettingsContent.ts`), ta funkcja jest czysta i zwraca wynik już w SEKUNDACH.
 *
 * Semantyka: puste / zero / nie-liczba / ujemne → `null` (usuń klucz `timeoutMs` z ustawień —
 * model spada na domyślny sufit `DEFAULT_EMBED_TIMEOUT_MS` z `modules/embedding/contracts.ts`,
 * NIGDY „bez limitu"). Wartość dodatnia jest zaokrąglana do pełnej sekundy i przycinana do
 * górnych widełek pola (`EMBED_TIMEOUT_INPUT_MAX_SECONDS`).
 */

/** Górny sufit pola w sekundach (godzina) — dłuższe żądanie user przycina, nie odrzuca. */
export const EMBED_TIMEOUT_INPUT_MAX_SECONDS = 3600;

/**
 * `raw` — surowa wartość pola tekstowego. `null` = brak sensownej liczby dodatniej; wołacz ma
 * USUNĄĆ klucz `timeoutMs` (= domyślne), nie zapisywać śmiecia.
 */
export function parseEmbedTimeoutSeconds(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;

    const rounded = Math.round(parsed);
    if (rounded <= 0) return null;

    return Math.min(rounded, EMBED_TIMEOUT_INPUT_MAX_SECONDS);
}
