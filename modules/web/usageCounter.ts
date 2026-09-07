/**
 * Licznik wyszukiwań webowych (E3.3, DEC L13-4).
 *
 * **INFORMACYJNY, NIGDY BLOKUJĄCY.** User ma WIDZIEĆ ile zapytań zjadł u płatnego
 * dostawcy względem darmowych progów — plugin nie odcina mu wyszukiwania, gdy próg
 * minie. Zero twardych limitów w tym pliku i w jego callerach.
 *
 * Liczymy TYLKO dostawców „lepszych niż Jina" (`COUNTED_PROVIDERS`). Jina jest
 * darmową podłogą (DEC L13-3) i nie ma sensownego progu do pokazania; SearXNG to
 * self-host usera — jego limitem jest jego własna maszyna.
 *
 * Kształt stanu w `settings.pkmAssistant.webSearch.usage`:
 * ```js
 * { date: '2026-07-25', day:   { tavily: 3, brave: 0, serper: 0 },
 *   month: '2026-07',   monthTotals: { tavily: 41, brave: 2, serper: 0 } }
 * ```
 * Rollover (zerowanie dnia/miesiąca) robi się przy ODCZYCIE — nie ma tu żadnego
 * timera ani zadania w tle. Dzień i miesiąc rolują się niezależnie.
 *
 * Pure: zero importów, zero I/O. Zapis do dysku jest odpowiedzialnością callera
 * (`bumpUsage` tylko podmienia `ws.usage`).
 */

/** Liczniki per dostawca. Klucze = `COUNTED_PROVIDERS` (indeks po `string`, bo id idzie z ustawień). */
export type ProviderTotals = Record<string, number>;

/** Stan licznika po rollowerze — dokładnie to, co ląduje w `ws.usage`. */
export interface UsageState {
    date: string;
    day: ProviderTotals;
    month: string;
    monthTotals: ProviderTotals;
}

/**
 * `ws.usage` W POSTACI ZASTANEJ na dysku. Liczniki są `unknown`, bo `data.json` bywa
 * brudny (patrz `normalizeTotals`) — dopiero normalizacja robi z tego `ProviderTotals`.
 */
interface RawUsage {
    date?: string;
    day?: unknown;
    month?: string;
    monthTotals?: unknown;
}

/** Slice `settings.pkmAssistant.webSearch` w zakresie, który dotyka licznik. */
export interface UsageSettingsSlice {
    usage?: RawUsage;
}

/** Dostawcy, których zużycie ma sens pokazywać (mają darmowe progi / kredyty). */
export const COUNTED_PROVIDERS = ['tavily', 'brave', 'serper'];

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/** Klucz dnia `YYYY-MM-DD` w czasie LOKALNYM usera (jego doba, nie UTC). */
export function dayKey(now = new Date()): string {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Klucz miesiąca `YYYY-MM` w czasie lokalnym. */
export function monthKey(now = new Date()): string {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

function zeroTotals(): ProviderTotals {
    const out: ProviderTotals = {};
    for (const id of COUNTED_PROVIDERS) out[id] = 0;
    return out;
}

/** Przepisuje tylko znane pola i tylko sensowne liczby — dane z data.json bywają brudne. */
function normalizeTotals(raw: unknown): ProviderTotals {
    const out = zeroTotals();
    if (!raw || typeof raw !== 'object') return out;
    for (const id of COUNTED_PROVIDERS) {
        const value = Number((raw as Record<string, unknown>)[id]);
        if (Number.isFinite(value) && value > 0) out[id] = Math.floor(value);
    }
    return out;
}

/**
 * Znormalizowany stan licznika Z ROLLOVEREM — bez zapisu i bez mutacji `ws`.
 * @param ws - obiekt `settings.pkmAssistant.webSearch` (dopuszczalny `null` — patrz strażnik)
 * @param now - wstrzykiwalny „teraz" (testy)
 */
export function readUsage(ws: UsageSettingsSlice | null = {}, now = new Date()): UsageState {
    const raw: RawUsage = (ws && typeof ws === 'object' && ws.usage) || {};
    const date = dayKey(now);
    const month = monthKey(now);
    return {
        date,
        day: raw.date === date ? normalizeTotals(raw.day) : zeroTotals(),
        month,
        monthTotals: raw.month === month ? normalizeTotals(raw.monthTotals) : zeroTotals(),
    };
}

/**
 * Podbija licznik o 1 dla dostawcy, który REALNIE obsłużył wyszukiwanie.
 * Woła się TYLKO po sukcesie (nie liczymy błędów ani cache-hitów).
 *
 * Podmienia `ws.usage` jednym przypisaniem — w runtime `ws` jest proxy ustawień
 * (`core/utils/SettingsManager.js`), więc to przypisanie samo planuje zapis na dysk.
 *
 * @param ws - obiekt `settings.pkmAssistant.webSearch` (mutowany)
 * @param providerId - id dostawcy, który odpowiedział
 * @returns nowy stan licznika, albo `null` gdy nie ma czego liczyć
 *          (jina / searxng / nieznany dostawca / brak obiektu ustawień)
 */
export function bumpUsage(
    ws: UsageSettingsSlice | null | undefined,
    providerId: string,
    now = new Date(),
): UsageState | null {
    if (!ws || typeof ws !== 'object') return null;
    if (!COUNTED_PROVIDERS.includes(providerId)) return null;

    const next = readUsage(ws, now);
    next.day[providerId] += 1;
    next.monthTotals[providerId] += 1;
    ws.usage = next;
    return next;
}

/** Suma zapytań w obiekcie liczników (do wyświetlenia „Dziś: N"). */
export function sumUsage(totals: Record<string, unknown> | null | undefined): number {
    if (!totals || typeof totals !== 'object') return 0;
    let sum = 0;
    for (const id of COUNTED_PROVIDERS) {
        const value = Number(totals[id]);
        if (Number.isFinite(value) && value > 0) sum += Math.floor(value);
    }
    return sum;
}
