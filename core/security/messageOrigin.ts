import { getLocale } from '../i18n/index.js';
/**
 * Proweniencja wiadomości czatu — KTO naprawdę napisał tekst tury.
 *
 * Gdyby o przywilejach człowieka decydowało to, KTÓRA funkcja UI narysowała dymek —
 * `append_message('user', …)` rejestrujące adresy z tekstu w rejestrze proweniencji
 * (`isUrlKnown` → bramka `web_read`), a `send_message` parsujące z niego markery `@@skill:`
 * i komendy `/` — to każda ścieżka, która wkłada tekst do pola wpisywania i woła
 * `send_message()` Z KODU (guzik artefaktu `artifactSummon`, propozycja delegacji
 * `chat_artifacts`, komentarz inline w `src/main.ts`, auto-tura po subie) dostawałaby
 * pieczątkę „to pisał człowiek", choć treść pochodzi od modelu albo z notatki/strony.
 *
 * Dlatego proweniencja jest JAWNA i jest jedna: pole `origin` w `meta` wiadomości.
 *   • `'human'` nadaje WYŁĄCZNIE ścieżka z pola wpisywania (guzik Wyślij, Enter, kolejka).
 *   • wszystko inne — w tym BRAK znacznika — jest maszyną (fail-closed).
 *
 * ⚠️ To NIE jest to samo co `_invocationOrigin` w `MCPClient`/`DelegateTool`. Tamto jest ADRESEM
 * ZWROTNYM zlecenia (zakładka + agent, gdzie wrócić z wynikiem suba) — inny wymiar, inny kształt.
 * Nie łączyć tych dwóch pól.
 */

/** Kto napisał tekst wiadomości. Jedyny enum proweniencji w pluginie. */
export type MessageOrigin = 'human' | 'machine';

/** Meta wiadomości z jawną proweniencją (pola dodatkowe zależą od ścieżki). */
export interface MessageOriginMeta {
    origin: MessageOrigin;
    [key: string]: unknown;
}

/** Znacznik dla tekstu wpisanego ręcznie przez użytkownika (jedyne źródło `'human'`). */
export const HUMAN_MESSAGE_META: MessageOriginMeta = Object.freeze({ origin: 'human' as const });

/** Znacznik dla wysyłki inicjowanej przez kod (guziki, przywołania, auto-tury). */
export const MACHINE_MESSAGE_META: MessageOriginMeta = Object.freeze({ origin: 'machine' as const });

/**
 * Znacznik maszynowy z dodatkowymi polami (np. `_subTaskNotification`, `subTaskId`).
 * `origin` dokładany JAKO OSTATNI — wołający nie podmieni go sobie na `'human'`.
 */
export function machineMeta(extra?: Record<string, unknown>): MessageOriginMeta {
    return { ...(extra || {}), origin: 'machine' };
}

/**
 * Odczytaj proweniencję z meta wiadomości. Fail-closed: cokolwiek innego niż jawne
 * `origin: 'human'` (brak meta, `undefined`, `MouseEvent` wpięty jako listener, literówka
 * `'Human'`/`'user'`) jest maszyną.
 */
export function resolveMessageOrigin(meta?: unknown): MessageOrigin {
    if (meta && typeof meta === 'object' && (meta as { origin?: unknown }).origin === 'human') {
        return 'human';
    }
    return 'machine';
}

/** Skrót do bramek przywilejów: czy ten tekst napisał człowiek. */
export function isHumanMessage(meta?: unknown): boolean {
    return resolveMessageOrigin(meta) === 'human';
}

/** Render once at message creation; the clock can be supplied by callers and tests. */
export function messageTime(clock: () => Date = () => new Date(), locale = getLocale()): string {
    const date = clock();
    const pad = (n: number) => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const zone = `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    const day = new Intl.DateTimeFormat(locale === 'pl' ? 'pl-PL' : 'en-US', { weekday: 'long' }).format(date);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}, ${day}, ${zone}`;
}

export function messageTimeLine(value: string): string { return `[czas wiadomości: ${value}]`; }
