/**
 * @module safeErrorText
 * Bezpieczny tekst błędu dla okna rozmowy i loga czatu (K20b, AUD-security-132 — ZLEW).
 *
 * `handle_error` wstawiał `error.message` wprost do DOM-u czatu. Na ścieżce sieciowego padu
 * strumienia ta wiadomość bywa `JSON.stringify` całego zdarzenia streamera — razem z
 * `source.headers.Authorization`, czyli SUROWYM kluczem API. Wystarczy zrzut ekranu albo
 * skopiowanie „błędu" do zgłoszenia, żeby klucz wyszedł z maszyny.
 *
 * ŹRÓDŁO tej wady (adapter / normalizacja błędu / maska po stronie modelu) domyka osobna
 * naprawa. To jest **obrona w głąb na zlewie**: nawet gdy źródło kiedyś znów wpuści nagłówek,
 * okno rozmowy pokaże `Bear***3f8a`, a nie klucz.
 *
 * Plik jest CELOWO wolny od `obsidian` i DOM-u — dzięki temu ma testy jednostkowe
 * (`safeErrorText.test.ts`), a `chat_streaming.ts` tylko go wywołuje.
 */
import { maskSensitiveData } from '../../../core/index.js';

/** Sufit długości tekstu błędu w dymku. Zrzut zdarzenia streamera potrafi mieć kilobajty. */
export const CHAT_ERROR_TEXT_LIMIT = 800;

/** Wyłuskaj czytelny opis z czegokolwiek, co przyszło jako „błąd". */
function normalizeError(error: unknown): string {
    if (error === null || error === undefined) return '';
    if (typeof error === 'string') return error;
    if (typeof error !== 'object') return String(error);

    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;

    try {
        const json = JSON.stringify(error);
        // `{}` po serializacji Errora bez własnych pól to nie jest opis błędu.
        return json && json !== '{}' && json !== '""' ? json : '';
    } catch {
        return String(error);
    }
}

/**
 * Zamień dowolny błąd na tekst, który wolno pokazać userowi i zapisać w logu:
 * **normalizacja → `maskSensitiveData` → obcięcie do sufitu**.
 *
 * @param error - `Error`, string, obiekt zdarzenia streamera, cokolwiek
 * @param opts.limit - własny sufit długości (domyślnie `CHAT_ERROR_TEXT_LIMIT`)
 * @returns zamaskowany tekst; pusty string, gdy nie ma czego pokazać (wołający daje fallback)
 */
export function safeErrorText(error: unknown, opts: { limit?: number } = {}): string {
    const raw = normalizeError(error);
    if (!raw) return '';
    const masked = String(maskSensitiveData(raw));
    const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : CHAT_ERROR_TEXT_LIMIT;
    return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
}
