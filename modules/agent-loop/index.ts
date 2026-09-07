/**
 * modules/agent-loop — publiczne API wspólnej pętli narzędziowej agenta.
 *
 * JEDYNE drzwi na zewnątrz modułu (złota zasada repo). Szczegóły: CLAUDE.md.
 *
 * D11 (plan v2.1): jedna pętla dla czatu i sub-agentów. Krok A (E2.1) przepina
 * sub-agentów i kanonizuje parser tool_calls; czat wchodzi w kroku B.
 */
export { runAgentLoop } from './AgentLoop.js';
export { ArrayMessageStore } from './MessageStore.js';
// S30 Z4: `splitConcatenatedToolCalls` OUT z barrela — anty-sklejanie DeepSeek jest
// szczegółem implementacyjnym `parseToolCalls`, zero konsumentów poza modułem.
export { parseToolCalls } from './toolCallParser.js';
// Pure sanitizer transkryptu — przeniesiony z modules/memory w E2.1 (kierunek zależności:
// sub-agents/tools/chat → agent-loop; agent-loop nie zależy od memory). S30 Z4: re-eksport
// przez barrel memory skasowany — `chat/RollingWindow` importuje stąd, wprost.
export { sanitizeToolTranscript } from './toolTranscriptSanitizer.js';

// TS-0 (2026-07-30): moduł jest w TypeScripcie — publiczne TYPY wychodzą tymi samymi drzwiami
// co wartości. `export type` jest kasowany przy transpilacji, więc runtime bez zmian.
export type { ModelResponse, ParsedToolCall } from './toolCallParser.js';
export type { LoopMessage, MessageStoreLike } from './MessageStore.js';
export type { RunAgentLoopOptions, RunAgentLoopResult, Usage } from './AgentLoop.js';
