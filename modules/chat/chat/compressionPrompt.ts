/**
 * Factory compression prompt skeleton - chat domain.
 *
 * Sam tekst mieszka w `config/default_prompts.js` (razem z jej dokumentacją i kontraktem
 * sentinela `===MEMORY_CANDIDATES===`), bo `modules/shell` (Settings→Prompt) też jej potrzebuje,
 * a nie ma po co ciągnąć w tym celu barrela czatu - to byłaby krawędź cyklu shell↔chat.
 *
 * Ten plik jest lokalnymi drzwiami dla wnętrza czatu (`Summarizer`, `chat_session`, testy) - ich
 * importy nie muszą znać docelowej lokalizacji tekstu.
 *
 * FUNKCJA, nie stała (2.2.5): szkielet ma wersję PL i EN, a `setLocale()` leci PO załadowaniu
 * modułów - stała wybrana przy imporcie zamroziłaby jeden język.
 */
export { defaultCompressionPrompt } from '../../../config/default_prompts.js';
