/**
 * modules/komunikator — public API
 *
 * Komunikacja między agentami: skrzynki (inbox per agent), modal, sidebar Crystal Soul.
 * Patrz CLAUDE.md.
 *
 * Świadomie poza publicznym API: `KomunikatorCleanupModal`/`KomunikatorBulkDeleteModal`,
 * `CleanupQueue` i `listKomunikatorAgentNames` - zero konsumentów spoza modułu.
 * Modal sprzątania otwiera `registerKomunikatorCleanup` (event `communicator:message_all_read`)
 * i `CommunicatorView` (guzik hurtowy → `KomunikatorBulkDeleteModal`), kolejkę sprzątania
 * trzyma `KomunikatorCleanupModal.js`, a listę nazw składają wołacze z
 * `listKomunikatorAgents()`.
 *
 * Sidebar Crystal Soul (`CommunicatorView`) jest jedynym UI komunikatora; style
 * sprzątania (`.komunikator-cleanup-*`) mieszkają w `KomunikatorCleanupModal.css`.
 */

export { KomunikatorManager } from './KomunikatorManager.js';
export type { AgentManagerLike, CleanupItem, Message, MessageFrontmatter, MessageHeader, VaultLike } from './types.js';
export type { KomunikatorAgentLike, KomunikatorAgentManagerLike } from './visibility.js';
export { renderCommunicatorView } from './CommunicatorView.js';
// Sprzątanie pół-automatem (modal po drugim ptaszku + guzik hurtowy).
export { registerKomunikatorCleanup } from './KomunikatorCleanupModal.js';
// Niewidzialność per agent. `visibility.js` jest PURE (bez obsidian), więc
// `modules/tools/` deep-importuje go bezpośrednio, omijając ten barrel (wzór artifactParser).
export {
    isKomunikatorVisible,
    listKomunikatorAgents,
    findKomunikatorAgent,
} from './visibility.js';

/**
 * Globalny wyłącznik komunikatora — JEDNO źródło prawdy „czy poczta żyje?".
 *
 * Flaga `pkmAssistant.komunikatorEnabled` jest domyślnie WŁĄCZONA i wystawiona
 * w Settings → Zaawansowane.
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
