/**
 * Factory compression prompt skeleton (E2.8 B3) — chat domain.
 *
 * Sama stała mieszka od S31 w `config/default_prompts.js` (razem z jej dokumentacją i kontraktem
 * sentinela `===MEMORY_CANDIDATES===`). Powód przenosin: `modules/shell` (Settings→Prompt) też jej
 * potrzebuje, a nie ma po co ciągnąć w tym celu barrela czatu — to była krawędź cyklu shell↔chat.
 *
 * Ten plik zostaje jako lokalne drzwi dla wnętrza czatu (`Summarizer`, `chat_session`, testy) —
 * ich importy się nie zmieniły.
 */
export { DEFAULT_COMPRESSION_PROMPT } from '../../../config/default_prompts.js';
