/**
 * Factory compression prompt skeleton - chat domain.
 *
 * Sama stała mieszka w `config/default_prompts.js` (razem z jej dokumentacją i kontraktem
 * sentinela `===MEMORY_CANDIDATES===`), bo `modules/shell` (Settings→Prompt) też jej potrzebuje,
 * a nie ma po co ciągnąć w tym celu barrela czatu - to byłaby krawędź cyklu shell↔chat.
 *
 * Ten plik jest lokalnymi drzwiami dla wnętrza czatu (`Summarizer`, `chat_session`, testy) - ich
 * importy nie muszą znać docelowej lokalizacji stałej.
 */
export { DEFAULT_COMPRESSION_PROMPT } from '../../../config/default_prompts.js';
