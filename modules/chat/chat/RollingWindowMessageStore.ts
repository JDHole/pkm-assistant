/**
 * RollingWindowMessageStore — adapter `MessageStore` (modules/agent-loop) na `RollingWindow`.
 *
 * Żyje w chat, bo `RollingWindow` jest chatowy; kierunek zależności chat → agent-loop
 * jest poprawny (agent-loop nie importuje chat). `runAgentLoop` woła TYLKO ten cienki
 * kontrakt — nie wie, że pod spodem siedzi okno tokenów z kompresją.
 *
 * Kontrakt (patrz modules/agent-loop/MessageStore.js):
 *   getMessagesForAPI()                    → wiadomości do wysyłki (RollingWindow dokłada system prompt;
 *                                            sanityzacja w pętli jest idempotentna, więc podwójna sanityzacja
 *                                            RollingWindow+pętla jest bezpieczna)
 *   appendAssistant(content, meta = {})    → rw.addMessage('assistant', ...) — meta 1:1 (tool_calls, reasoning_content, cache)
 *   appendToolResult(content, toolCallId)  → rw.addMessage('tool', content, { tool_call_id })
 *   appendUser(content, meta = {})         → rw.addMessage('user', content, meta) (nudge / hard-stop)
 *   get messages()                         → rw.messages (surowa referencja)
 *
 * UWAGA — async addMessage w sync kontrakcie. `RollingWindow.addMessage` jest ASYNC: robi
 * SYNCHRONICZNY push wiadomości, a po nim (rzadko) ASYNC awaryjną kompresję przy przekroczeniu
 * twardego limitu (100%). Kontrakt MessageStore jest sync — pętla NIE awaituje append*. Dawny
 * `chat_streaming` awaitował każdy `addMessage` (serializacja), więc teoretycznie tracimy tę
 * serializację awaryjnej kompresji. Jest to BEZPIECZNE, bo:
 *   1. push jest synchroniczny → kolejność wiadomości zachowana;
 *   2. twardy limit jest praktycznie nieosiągalny w pętli (tool results obcięte do
 *      max_tool_result_length, a `beforeContinue` robi AWAITOWANĄ miękką kompresję co rundę);
 *   3. gdyby wyścig chwilowo rozspójnił `rw.messages`, `sanitizeToolTranscript` (RollingWindow
 *      + pętla) usuwa osierocone tool messages PRZED każdym wywołaniem modelu — API nigdy nie
 *      dostaje malformed transkryptu ani kontekstu > 100%.
 */
export interface RollingWindowLike {
    messages: RollingWindow['messages'];
    addMessage(role: Parameters<RollingWindow['addMessage']>[0], content: MessageContent, meta?: MessageMeta): void | Promise<void>;
    getMessagesForAPI(): ReturnType<RollingWindow['getMessagesForAPI']>;
}

export class RollingWindowMessageStore {
    declare rw: RollingWindowLike;

    /**
     * @param {import('./RollingWindow.js').RollingWindow} rollingWindow - okno tokenów tej tury (przechwycone na starcie)
     */
    constructor(rollingWindow: RollingWindowLike) {
        this.rw = rollingWindow;
    }

    /**
     * Wiadomości gotowe do wysłania do API (z system promptem, po sanityzacji RollingWindow).
     * @returns {Array<Object>}
     */
    getMessagesForAPI(): ReturnType<RollingWindowLike['getMessagesForAPI']> {
        return this.rw.getMessagesForAPI();
    }

    /**
     * Dopisuje turę asystenta. Meta przechodzi 1:1 (tool_calls, reasoning_content, cache).
     * @param {string|null} content - treść (może być null/'' gdy same tool_calls)
     * @param {Object} [meta] - { tool_calls?, reasoning_content?, cache? }
     */
    appendAssistant(content: string | null, meta: MessageMeta = {}): void {
        void this.rw.addMessage('assistant', content || '', meta);
    }

    /**
     * Dopisuje wynik narzędzia (rola 'tool'). tool_call_id musi pasować do assistant.tool_calls[].
     * @param {string|Array} content - wynik (string albo tablica bloków content multimodalnych)
     * @param {string} toolCallId
     */
    appendToolResult(content: string | unknown[], toolCallId: string): void {
        // TS-boundary: `MessageStoreLike` (agent-loop) oddaje wynik narzędzia jako `unknown[]`
        // — bloki treści różnych dostawców. Adapter tylko je PRZEKAZUJE do okna, nie czyta ich
        // pól, więc walidacja kształtu (zmiana runtime) nie należy do tej warstwy.
        void this.rw.addMessage('tool', content as MessageContent, { tool_call_id: toolCallId });
    }

    /**
     * Dopisuje wiadomość usera (nudge min_iterations / hard-stop backstopu).
     * @param {string} content
     * @param {Object} [meta] - przechodzi 1:1 do RollingWindow
     */
    appendUser(content: string, meta: MessageMeta = {}): void {
        void this.rw.addMessage('user', content, meta);
    }

    /** Surowa referencja tablicy wiadomości okna (inspekcja / testy). */
    get messages(): RollingWindowLike['messages'] {
        return this.rw.messages;
    }
}
import type { RollingWindow } from './RollingWindow.js';

type MessageContent = Parameters<RollingWindow['addMessage']>[1];
type MessageMeta = Parameters<RollingWindow['addMessage']>[2];
