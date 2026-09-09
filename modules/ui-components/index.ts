/**
 * modules/ui-components — public API (barrel).
 *
 * Współdzielone klocki UI (≥2 moduły). Patrz CLAUDE.md.
 *
 * `TOOL_DESCRIPTIONS` nie istnieje — zero konsumentów. Razem z nim nie ma martwej
 * mechaniki w `ToolCallDisplay.js`: funkcji `getToolDescription()` + proxy
 * `TOOL_DESCRIPTIONS` (klucze i18n `tool.desc.*` nie istnieją, więc proxy zwracałoby
 * tylko surowe nazwy kluczy).
 */
export {
    TOOL_INFO,
    getToolIcon,
    createToolCallDisplay,
    createCompactToolChip,
} from './ToolCallDisplay.js';
export { AttachmentManager } from './AttachmentManager.js';
export { MentionAutocomplete } from './MentionAutocomplete.js';
export { createSubAgentBlock, createPendingSubAgentBlock } from './SubAgentBlock.js';
export { createThinkingBlock, updateThinkingBlock } from './ThinkingBlock.js';
// Bazowa klasa widoków. Dziedziczą z niej
// `ChatView` (modules/chat) i `ReleaseNotesView` (modules/shell) — czyli ≥2 moduły, więc
// jej dom jest tutaj. Shell trzyma re-export kompatybilnościowy.
export { PluginItemView } from './PluginItemView.js';
// Prymitywy kart Zaplecza — używają ich zakładki z `modules/skills` i `modules/sub-agents`,
// czyli ≥2 moduły niższe niż shell.
export {
    renderFilterBar,
    getCategoryLabel,
    renderUseAtAgentButton,
    renderTemplateVersionBadge,
    renderCardAction,
} from './backstage_helpers.js';
// Podgląd diffa przed `vault_write` — jedyny wołacz to `modules/tools/MCPClient.js`,
// który nie ma po co sięgać do barrela shella.
export { DiffModal } from './DiffModal.js';
// Zamiennik natywnego confirm() (wytyczne katalogu: no-alert).
export { ConfirmModal, confirmModal } from './ConfirmModal.js';
export type { ConfirmModalOptions } from './ConfirmModal.js';
// Obcinanie podglądu tekstu zaznaczenia — dzielone przez InlineCommentModal
// i SendToAgentModal (oba `modules/shell/`).
export { truncatePreview } from './textPreview.js';
