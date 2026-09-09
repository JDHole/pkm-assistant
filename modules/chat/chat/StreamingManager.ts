/**
 * StreamingManager - singleton zarządzający aktywnymi streamami chat (multi-tab).
 *
 * **Multi-tab tracking** - każdy ChatView (per-tab) rejestruje swój stream
 * przez `startStream(streamId, info)` na początku i `stopStream(streamId)`
 * po zakończeniu. `getActiveStreams()` zwraca live snapshot dla
 * Backstage/Token Viewer oraz karmi `shouldUseFreshModel`
 * (decyzja „świeża instancja modelu czy z cache").
 *
 * StreamingManager jest plugin-global, nie per-ChatView: lokalny licznik streamów w jednym
 * widoku nie widzi streamów z innych zakładek, więc tury z RÓŻNYCH ChatView'ów mogłyby się
 * ścierać, gdyby decyzja opierała się tylko na stanie jednej zakładki.
 *
 * Dziś StreamingManager to thin orchestration/coordination layer - właściwa logika streamu
 * (~1226 LOC) zostaje w `chat_streaming.ts`, pełny split nie jest zrobiony.
 */

/**
 * Czy tura ma dostać ŚWIEŻĄ instancję modelu zamiast tej z cache.
 *
 * `ChatModel` trzyma stan per instancja (bilet bramki, `stopStream`, `_abortSettle`),
 * więc dwie tury na jednej instancji ścierają się o niego: Stop kliknięty w jednej zakładce
 * trafia wtedy w turę drugiej. Funkcja mieszka tutaj, obok stanu (`getActiveStreams`), na
 * którym się opiera.
 *
 * @param localTurns - ile tur trzyma TEN widok (`_streamCtxMap.size`)
 * @param globalActiveStreams - ile streamów żyje w całym pluginie (`getActiveStreams().length`)
 */
export function shouldUseFreshModel(localTurns: number, globalActiveStreams: number): boolean {
    // Lokalny licznik (`size > 1`) sam nie wystarcza: przy czterech zakładkach każdy widok
    // widziałby `size === 1` i brałby instancję z cache, więc tury z RÓŻNYCH widoków ścierałyby
    // się - stąd też `globalActiveStreams`.
    return localTurns > 1 || globalActiveStreams > 0;
}

type StreamInfo = { agent?: string | null; modelId?: string | null; meta?: Record<string, unknown> | null };
type ActiveStream = Required<Pick<StreamInfo, 'agent' | 'modelId' | 'meta'>> & { abortController: AbortController | null; startTime: number };

class StreamingManager {
    declare activeStreams: Map<string, ActiveStream>;
    constructor() {
        /** @type {Map<string, {agent?: string, modelId?: string, abortController?: AbortController, startTime: number, meta?: object}>} */
        this.activeStreams = new Map();
    }

    /**
     * Register a new stream. Returns AbortController for cooperative cancellation.
     * @param {string} streamId - Unique id (np. tabId+agent name).
     * @param {{agent?: string, modelId?: string, meta?: object}} info
     * @returns {AbortController}
     */
    startStream(streamId: string, info: StreamInfo = {}) {
        if (this.activeStreams.has(streamId)) {
            // Existing stream pod tym samym ID — abort poprzedni przed start nowego.
            try { this.activeStreams.get(streamId)?.abortController?.abort?.(); } catch { /* ignore */ }
        }
        const abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        this.activeStreams.set(streamId, {
            agent: info.agent || null,
            modelId: info.modelId || null,
            meta: info.meta || null,
            abortController,
            startTime: Date.now()
        });
        return abortController;
    }

    /**
     * Stop streaming for a specific tab/streamId (aborts via AbortController if attached).
     * @returns {boolean} true if a stream was registered+stopped.
     */
    stopStream(streamId: string) {
        const s = this.activeStreams.get(streamId);
        if (!s) return false;
        try { s.abortController?.abort?.(); } catch { /* ignore */ }
        this.activeStreams.delete(streamId);
        return true;
    }

    /**
     * @returns {Array<{streamId: string, agent: ?string, modelId: ?string, durationMs: number}>}
     */
    getActiveStreams() {
        const now = Date.now();
        return Array.from(this.activeStreams.entries()).map(([streamId, s]) => ({
            streamId,
            agent: s.agent,
            modelId: s.modelId,
            durationMs: now - s.startTime
        }));
    }

    /**
     * Hard reset (testing / plugin disable). Aborts all streams.
     */
    reset() {
        for (const [, s] of this.activeStreams) {
            try { s.abortController?.abort?.(); } catch { /* ignore */ }
        }
        this.activeStreams.clear();
    }
}

// Singleton (per JS realm — plugin lifecycle).
const streamingManager = new StreamingManager();

export { StreamingManager };
export default streamingManager;
