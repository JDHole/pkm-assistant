/**
 * Proweniencja wiadomości czatu — KTO naprawdę napisał tekst tury.
 *
 * K7 / AUD-security-062, 088, 003 (bieg 2026-08-22). Do tej pory o przywilejach człowieka
 * decydowało to, KTÓRA funkcja UI narysowała dymek: `append_message('user', …)` rejestrowało
 * adresy z tekstu w rejestrze proweniencji (`isUrlKnown` → bramka `web_read`), a `send_message`
 * parsowało z niego markery `@@skill:` i komendy `/`. Każda ścieżka, która wkłada tekst do pola
 * wpisywania i woła `send_message()` Z KODU — guzik artefaktu (`artifactSummon`), propozycja
 * delegacji (`chat_artifacts`), komentarz inline (`src/main.ts`), auto-tura po subie — dostawała
 * więc pieczątkę „to pisał człowiek", choć treść pochodzi od modelu albo z notatki/strony.
 *
 * Od teraz proweniencja jest JAWNA i jest jedna: pole `origin` w `meta` wiadomości.
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
