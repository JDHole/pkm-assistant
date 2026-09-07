/**
 * @module messagePrivileges
 * Bramki przywilejów tury czatu — co wolno zrobić z TREŚCIĄ wiadomości.
 *
 * K7 (AUD-security-062 / 088 / 003): trzy rzeczy w turze czytają tekst jako POLECENIE, nie jako
 * dane — rejestr proweniencji adresów (odblokowuje `web_read`), markery inline (`@@skill:`
 * wstrzykuje pełny przepis do promptu systemowego z ramką „użytkownik uruchomił") i komendy `/`.
 * Wszystkie trzy przysługują wyłącznie tekstowi, który NAPISAŁ CZŁOWIEK.
 *
 * Źródłem prawdy o pochodzeniu jest `meta.origin` (`core/security/messageOrigin.ts`), nie to,
 * z jaką rolą dymek zostanie narysowany. Brak znacznika = maszyna (fail-closed).
 */
import { isHumanMessage } from '../../../core/index.js';
import { parseInlineTriggers } from './InlineChipPlugin.js';
import type { InlineTrigger } from './InlineChipPlugin.js';

/**
 * Markery `@@skill:` / `@@tool:` / `@sub-agent:` — parsujemy TYLKO z tekstu człowieka.
 * Tekst od maszyny (treść artefaktu, `context_summary` z propozycji delegacji, wynik suba)
 * to dane: markery w nim mają zostać zwykłym tekstem.
 */
export function parseTriggersIfHuman(text: string, meta?: unknown): InlineTrigger[] {
    if (!isHumanMessage(meta)) return [];
    return parseInlineTriggers(text);
}

/** Czy tura może wykonać komendę `/…` z tego tekstu. */
export function mayRunSlashCommand(meta?: unknown): boolean {
    return isHumanMessage(meta);
}

/**
 * Zasil rejestr proweniencji adresami z tekstu — tylko dla tekstu człowieka.
 *
 * `register` wstrzykiwane, a nie importowane: `modules/web/index.js` ciągnie `obsidian`
 * (`requestUrl`), którego nie ma w gołym Node, więc test tej bramki nie mógłby wtedy
 * zaimportować tego pliku. Produkcja podaje tu prawdziwe `registerUrlsFromText`.
 *
 * @returns liczba zarejestrowanych adresów (0 = maszyna, nic nie weszło do rejestru)
 */
export function registerUrlsIfHuman(
    text: string,
    meta: unknown,
    register: (text: string) => number,
): number {
    if (!isHumanMessage(meta)) return 0;
    return register(text);
}
