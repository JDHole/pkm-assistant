/**
 * promptFence.ts — JEDNO ogrodzenie niezaufanej treści w system prompcie.
 *
 * Problem (audyt 2026-08-22, klaster K9): treść, której nie pisał operator — body notatki,
 * frontmatter, pamięć agenta, wynik `web_read` zapisany do vaulta — trafia do promptu
 * systemowego. Bez ogrodzenia jest nie do odróżnienia od instrukcji; z ogrodzeniem, które
 * da się zamknąć od środka (`</vault_content>` w treści), jest tak samo źle.
 *
 * Kontrakt:
 *  - `fenceUntrusted(content, source)` zwraca blok `<vault_content source="...">…</vault_content>`,
 *    w którym treść jest ZESCAPOWANA — w wyniku stoi DOKŁADNIE jedno otwarcie i jedno zamknięcie.
 *  - Model wie, co ten znacznik znaczy: mówi mu o tym sekcja „Bezpieczeństwo treści"
 *    (`prompt.content_security`) — preambuły NIE dublujemy przy każdym bloku.
 *
 * Pure (zero importów) → node-testowalne i wolne od cykli; dlatego siedzi w `core/security/`,
 * a nie w `modules/prompts/` (konsumenci są w prompts, chat i agents).
 */

/** Nazwa znacznika ogrodzenia. Jedna, dla wszystkich kanałów. */
export const VAULT_CONTENT_TAG = 'vault_content';

/**
 * Zneutralizuj znaczniki sterujące w niezaufanej treści.
 *
 * Zamienia `<vault_content` i `</vault_content` (dowolna wielkość liter, dowolne białe znaki
 * w środku) na formę encji `&lt;…`, więc treść nie ma jak zamknąć ogrodzenia od środka.
 * Idempotentna: `&lt;/vault_content` nie ma już `<`, więc drugi przebieg go nie rusza.
 */
export function escapeUntrusted(content: unknown): string {
    return String(content ?? '')
        .replace(/<\s*\/\s*vault_content/gi, '&lt;/vault_content')
        .replace(/<\s*vault_content/gi, '&lt;vault_content');
}

/**
 * Ogródź niezaufaną treść znacznikiem `<vault_content source="...">`.
 *
 * @param content - treść z vaulta / sieci / pamięci agenta
 * @param source  - skąd (np. `memory`, `active_note`, `artifacts`) — trafia do atrybutu `source`
 * @returns pusty string, gdy treść jest pusta (nie zaśmiecamy promptu pustym blokiem)
 */
export function fenceUntrusted(content: unknown, source: string = 'vault'): string {
    const body = escapeUntrusted(content);
    if (!body.trim()) return '';
    // `source` to klucz sekcji od nas, nie od usera — ale i tak przycinamy do bezpiecznego
    // alfabetu, żeby cudzysłów z przypadkowej wartości nie rozwalił atrybutu.
    const label = String(source ?? 'vault').replace(/[^A-Za-z0-9_.:/-]/g, '_') || 'vault';
    return `<${VAULT_CONTENT_TAG} source="${label}">\n${body}\n</${VAULT_CONTENT_TAG}>`;
}
