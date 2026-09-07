/**
 * modules/ui-components — public API (barrel).
 *
 * Współdzielone klocki UI (≥2 moduły). Patrz CLAUDE.md.
 *
 * S30 Z4 (przycinka powierzchni): `TOOL_DESCRIPTIONS` OUT — zero konsumentów.
 * Razem z nim poszła martwa mechanika w `ToolCallDisplay.js`: funkcja
 * `getToolDescription()` + proxy `TOOL_DESCRIPTIONS` (klucze i18n `tool.desc.*`
 * skasowane już w S30 Z2, więc proxy zwracało tylko surowe nazwy kluczy).
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
// S31: bazowa klasa widoków (dawniej `modules/shell/ObsekItemView.js`; S35 rename → `PluginItemView`).
// Dziedziczą z niej
// `ChatView` (modules/chat) i `ReleaseNotesView` (modules/shell) — czyli ≥2 moduły, więc
// jej dom jest tutaj. Shell trzyma re-export kompatybilnościowy.
export { PluginItemView } from './PluginItemView.js';
// S31: prymitywy kart Zaplecza (dawniej `modules/shell/sidebar/backstage_helpers.js`) — używają
// ich zakładki z `modules/skills` i `modules/sub-agents`, czyli ≥2 moduły niższe niż shell.
export {
    renderFilterBar,
    getCategoryLabel,
    renderUseAtAgentButton,
    renderTemplateVersionBadge,
    renderCardAction,
} from './backstage_helpers.js';
// S31: podgląd diffa przed `vault_write` (dawniej `modules/shell/DiffModal.js`) — jedyny wołacz
// to `modules/tools/MCPClient.js`, który nie ma po co sięgać do barrela shella.
export { DiffModal } from './DiffModal.js';
// Zamiennik natywnego confirm() (wytyczne katalogu: no-alert) — release 2.2.0, 2026-09-04.
export { ConfirmModal, confirmModal } from './ConfirmModal.js';
export type { ConfirmModalOptions } from './ConfirmModal.js';
// AUD-code-review-099: obcinanie podglądu tekstu zaznaczenia — dzielone przez InlineCommentModal
// i SendToAgentModal (oba `modules/shell/`).
export { truncatePreview } from './textPreview.js';
