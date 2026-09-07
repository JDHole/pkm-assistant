/**
 * modules/komunikator — public API
 *
 * Komunikacja między agentami: skrzynki (inbox per agent), modal, sidebar Crystal Soul.
 * Patrz CLAUDE.md.
 *
 * S30 Z4 (przycinka powierzchni): `KomunikatorCleanupModal`/`KomunikatorBulkDeleteModal`,
 * `CleanupQueue` i `listKomunikatorAgentNames` OUT — zero konsumentów spoza modułu.
 * Modal sprzątania otwiera `registerKomunikatorCleanup` (event `communicator:message_all_read`)
 * i `CommunicatorView` (guzik hurtowy → `KomunikatorBulkDeleteModal`), kolejkę sprzątania
 * trzyma `KomunikatorCleanupModal.js`, a listę nazw składają wołacze z
 * `listKomunikatorAgents()`.
 *
 * AUD-dead-code-073 (2026-09-02): sierocy `KomunikatorModal`/`openKomunikatorModal`
 * (modal pełnoekranowy bez ani jednego wołacza w repo) SKASOWANY razem z
 * `KomunikatorModal.css` — sidebar Crystal Soul (`CommunicatorView`) jest dziś
 * jedynym UI komunikatora. Style sprzątania (`.komunikator-cleanup-*`), które
 * dawniej wisiały na tym sierocym pliku, przeniesione do `KomunikatorCleanupModal.css`.
 */

export { KomunikatorManager } from './KomunikatorManager.js';
export type { AgentManagerLike, CleanupItem, Message, MessageFrontmatter, MessageHeader, VaultLike } from './types.js';
export type { KomunikatorAgentLike, KomunikatorAgentManagerLike } from './visibility.js';
export { renderCommunicatorView } from './CommunicatorView.js';
// S28 D5 — sprzątanie pół-automatem (modal po drugim ptaszku + guzik hurtowy).
export { registerKomunikatorCleanup } from './KomunikatorCleanupModal.js';
// S28 D6 — niewidzialność per agent. `visibility.js` jest PURE (bez obsidian), więc
// `modules/tools/` deep-importuje go bezpośrednio, omijając ten barrel (wzór artifactParser).
export {
    isKomunikatorVisible,
    listKomunikatorAgents,
    findKomunikatorAgent,
} from './visibility.js';

/**
 * Globalny wyłącznik komunikatora — JEDNO źródło prawdy „czy poczta żyje?".
 *
 * Przewód z kill-switcha E1.2, semantyka z S28 D7: flaga `pkmAssistant.komunikatorEnabled`
 * jest teraz domyślnie WŁĄCZONA i wystawiona w Settings → Zaawansowane.
 * `false` = KomunikatorManager nie powstaje, narzędzia `kom_*` nie są rejestrowane,
 * serwer `komunikator` znika z katalogu MCP, sekcja w sidebarze jest schowana.
 * Dane usera nietknięte. Brak pola (stare `data.json`) = WŁĄCZONE, jak default.
 *
 * @param {Object} settings - Plugin settings (env.settings)
 * @returns {boolean}
 */
export function isKomunikatorEnabled(settings: { pkmAssistant?: { komunikatorEnabled?: boolean } } | null | undefined) {
    return settings?.pkmAssistant?.komunikatorEnabled !== false;
}
