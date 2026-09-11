/**
 * modules/chat/ — public API
 *
 * Patrz CLAUDE.md w tym folderze.
 *
 * ChatView to ItemView Obsidiana — główny widget czatu pluginu.
 * Mixinów chat_* NIE eksportujemy — to wewnętrzna struktura modułu
 * (prototype mixin pattern, sesja 107).
 *
 * Przycinka powierzchni: `streamingManager` (default) + `StreamingManager` +
 * `RollingWindow` + `makeInlineTriggerMarker` OUT — zero konsumentów spoza modułu.
 * Singleton `StreamingManager` i `RollingWindow` żyją w `chat/` i tam są używane
 * (`chat_streaming`, `chat_session`); `makeInlineTriggerMarker` woła
 * `insertInlineTriggerMarker` u siebie.
 */
export { ChatView } from './chat_view.js';
// `ChatView` (klasa) mixinów prototype nie widzi statycznie (`input_area`, `send_message`, ...
// - patrz nagłówek wyżej) - `ChatViewLike` to PEŁNY, zmiksowany kształt egzemplarza. Jedyny
// konsument spoza modułu: `src/main.ts` (`sendInlineComment`, rzutowanie leaf.view).
export type { ChatViewLike } from './chat/chatViewShape.js';

// Kanoniczny typ widoku czatu — obsidian-free re-export
// (`chatViewType.js` → `core/index.js`), więc importowalny z barrela BEZ ciągnięcia
// `obsidian` przez `ChatView`/`chat_view.js`. Konsumenci spoza modułu, którym zależy
// na node-testowalności (shell, artifacts), i tak biorą stałą wprost z `core/index.js`
// — patrz `core/utils/viewTypes.ts` dla pełnego uzasadnienia.
export { CHAT_VIEW_TYPE } from './chatViewType.js';

// Wstawianie markera triggera do inputu czatu — woła to
// `modules/shell/sidebar/TriggersView.js` leniwym `import()`.
export { insertInlineTriggerMarker } from './chat/InlineChipPlugin.js';

// `DEFAULT_COMPRESSION_PROMPT` (factory compression skeleton) OUT z barrela — Settings→Prompt
// (`modules/shell/prompt_settings.ts`) bierze ją wprost
// z `config/default_prompts.js`, nie stąd; zero konsumentów spoza modułu. Definicja i lokalne
// drzwi `chat/compressionPrompt.ts` zostają — czyta je Summarizer/turnOwner wewnątrz czatu.

// „Puls pamięci": trigger konsolidacji. Wystawiony, bo woła go też profil agenta
// (`modules/agents/profile/profile_memory.js`) — leniwym `import()`, żeby nie dokładać statycznej
// krawędzi agents→chat do i tak splątanego trójkąta shell↔chat↔agents.
export { startConsolidationRun } from './consolidationRunner.js';
