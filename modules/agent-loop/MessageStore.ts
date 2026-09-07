/**
 * MessageStore — cienki interfejs transkryptu rozmowy dla pętli agenta.
 *
 * `runAgentLoop` NIE wie, gdzie żyją wiadomości. Sub-agenci trzymają je w zwykłej
 * tablicy (ArrayMessageStore poniżej), a czat (krok B, Etap 2) wepnie tu adapter na
 * `RollingWindow` bez zmiany pętli. Kontrakt:
 *
 *   getMessagesForAPI()                  → tablica wiadomości do wysyłki (kopia)
 *   appendAssistant(content, meta)       → dopisz turę asystenta (meta: {tool_calls, reasoning_content})
 *   appendToolResult(content, toolCallId)→ dopisz wynik narzędzia (rola 'tool')
 *   appendUser(content, meta)            → dopisz wiadomość usera (nudge / hard-stop)
 *   get messages()                       → surowa referencja (do inspekcji/testów)
 *
 * Wiadomości są w kształcie OpenAI (assistant.tool_calls[], tool.tool_call_id) — tego
 * wymaga `sanitizeToolTranscript`, które pętla puszcza przed KAŻDYM wywołaniem modelu.
 */

/** Role transkryptu w kształcie OpenAI. */
type LoopMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Jedna wiadomość transkryptu (kształt OpenAI).
 *
 * `content` DOPUSZCZA TABLICĘ świadomie: `appendToolResult` dostaje tablicę bloków content przy
 * wynikach multimodalnych (`generate_image` + model vision) — przechodzi bez stringifikacji
 * i bez obcinania (patrz CLAUDE.md, „Wynik narzędzia: string vs tablica multimodalna").
 * Index signature zostaje, bo store czatu (`RollingWindowMessageStore` → `RollingWindow`)
 * dokłada własne pola meta (np. `cache`, `_systemNudge`).
 */
export interface LoopMessage {
    role: LoopMessageRole;
    content?: string | null | unknown[];
    tool_calls?: unknown[];
    tool_call_id?: string;
    reasoning_content?: unknown;
    [key: string]: unknown;
}

/** Meta dopinane do tury asystenta. */
export interface AppendAssistantMeta {
    tool_calls?: unknown[];
    reasoning_content?: unknown;
    [key: string]: unknown;
}

/**
 * STRUKTURALNY kontrakt store'a, którego wymaga `runAgentLoop`. Świadomie NIE jest to typ klasy
 * `ArrayMessageStore` — czat wstrzykuje własny `RollingWindowMessageStore` (inna klasa, ten sam
 * kształt), a pętla nie może o nim wiedzieć (kierunek zależności: chat → agent-loop).
 */
export interface MessageStoreLike {
    getMessagesForAPI(): LoopMessage[];
    appendAssistant(content: string | null, meta?: AppendAssistantMeta): void;
    appendToolResult(content: string | unknown[], toolCallId: string): void;
    appendUser(content: string, meta?: Record<string, unknown>): void;
    readonly messages: LoopMessage[];
}

/**
 * Domyślna implementacja MessageStore oparta o tablicę w pamięci.
 * Używana przez sub-agentów (SubAgentRunner).
 */
export class ArrayMessageStore implements MessageStoreLike {
    // `declare` = deklaracja WYŁĄCZNIE typu, zero emitu. Bez niego (przy `useDefineForClassFields:
    // true` z tsconfig, które esbuild czyta) puste pole `_messages;` zostałoby wyemitowane jako
    // realne pole klasy definiowane PRZED ciałem konstruktora — czyli zmiana emitowanego kodu.
    // Kampania TS trzyma diff runtime'u na zerze, więc pola bez inicjalizatora deklarujemy `declare`.
    declare private _messages: LoopMessage[];

    /**
     * @param initialMessages - startowe wiadomości (np. system + user)
     */
    constructor(initialMessages: LoopMessage[] = []) {
        this._messages = Array.isArray(initialMessages)
            ? initialMessages.map((m) => ({ ...m }))
            : [];
    }

    /**
     * Zwraca kopię wiadomości do wysłania do API (płytka kopia każdej wiadomości).
     */
    getMessagesForAPI(): LoopMessage[] {
        return this._messages.map((m) => ({ ...m }));
    }

    /**
     * Dopisuje turę asystenta.
     * @param content - treść tekstowa (może być null gdy są same tool_calls)
     * @param meta - { tool_calls?, reasoning_content? }
     */
    appendAssistant(content: string | null, meta: AppendAssistantMeta = {}): void {
        const msg: LoopMessage = { role: 'assistant', content: content ?? null };
        if (meta.tool_calls) msg.tool_calls = meta.tool_calls;
        if (meta.reasoning_content !== undefined) msg.reasoning_content = meta.reasoning_content;
        this._messages.push(msg);
    }

    /**
     * Dopisuje wynik narzędzia (rola 'tool', wymaga tool_call_id zgodnego z assistant.tool_calls).
     * @param content - wynik narzędzia: string ALBO tablica bloków content (multimodal —
     *   `generate_image` + model vision; patrz CLAUDE.md). Dawny JSDoc mówił „string", ale pętla
     *   realnie podaje tu też tablicę i test `AgentLoop.test` tego pilnuje.
     * @param toolCallId - id wywołania z assistant.tool_calls[]
     */
    appendToolResult(content: string | unknown[], toolCallId: string): void {
        this._messages.push({ role: 'tool', tool_call_id: toolCallId, content });
    }

    /**
     * Dopisuje wiadomość usera (nudge min_iterations / hard-stop backstopu).
     * @param content - treść
     * @param meta - zarezerwowane na przyszłość (forward-compat; ta implementacja go ignoruje)
     */
    appendUser(content: string, _meta: Record<string, unknown> = {}): void {
        this._messages.push({ role: 'user', content });
    }

    /** Surowa referencja tablicy wiadomości (inspekcja / testy). */
    get messages(): LoopMessage[] {
        return this._messages;
    }
}
