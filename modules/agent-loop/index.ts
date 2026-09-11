/**
 * modules/agent-loop — publiczne API wspólnej pętli narzędziowej agenta.
 *
 * JEDYNE drzwi na zewnątrz modułu (złota zasada repo). Szczegóły: CLAUDE.md.
 *
 * Jedna pętla obsługuje zarówno czat, jak i sub-agentów; kanonizuje parser tool_calls.
 */
export { runAgentLoop } from './AgentLoop.js';
export { ArrayMessageStore } from './MessageStore.js';
// `splitConcatenatedToolCalls` nie jest eksportowany z barrela — anty-sklejanie DeepSeek
// jest szczegółem implementacyjnym `parseToolCalls`, zero konsumentów poza modułem.
export { parseToolCalls } from './toolCallParser.js';
// Pure sanitizer transkryptu. Kierunek zależności: sub-agents/tools/chat → agent-loop;
// agent-loop nie zależy od memory. `chat/RollingWindow` importuje stąd wprost.
export { sanitizeToolTranscript } from './toolTranscriptSanitizer.js';

// Moduł jest w TypeScripcie — publiczne TYPY wychodzą tymi samymi drzwiami co wartości.
// `export type` jest kasowany przy transpilacji, więc runtime bez zmian.
export type { ModelResponse, ParsedToolCall } from './toolCallParser.js';
export type { LoopMessage, MessageStoreLike } from './MessageStore.js';
export type { RunAgentLoopOptions, RunAgentLoopResult, ToolResultEntry, Usage } from './AgentLoop.js';
