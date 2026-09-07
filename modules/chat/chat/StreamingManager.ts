/**
 * StreamingManager — singleton zarządzający aktywnymi streamami chat (multi-tab).
 *
 * Sprint 03 Z7 (Wizja MEMORY_v2_RETRIEVAL_v2 → Models hygiene v2):
 *
 * **Multi-tab tracking** — każdy ChatView (per-tab) rejestruje swój stream
 * przez `startStream(streamId, info)` na początku i `stopStream(streamId)`
 * po zakończeniu. `getActiveStreams()` zwraca live snapshot dla
 * Backstage/Token Viewer (Sprint 11) oraz karmi `shouldUseFreshModel`
 * (AUD-testy-027: decyzja „świeża instancja modelu czy z cache").
 *
 * Pre-Z7 chat_streaming.js miał lokalny guard `needsFreshModel = _streamCtxMap.size > 1`,
 * ale to per ChatView — multi-tab z różnych ChatView'ów wciąż mogło się ścierać.
 * StreamingManager jest plugin-global.
 *
 * Pełen split chat_streaming.js → StreamingManager (~1226 LOC streaming logic
 * przeniesione) jest defer do późniejszego sprintu — dziś StreamingManager
 * to thin orchestration/coordination layer.
 *
 * AUD-dead-code-049 (2026-09-02): `acquireModelLock()` + mapa `modelLocks` (per-model
 * concurrent-safety lock, obiecany dla SubAgentRunner w hotfixie S03 z 2026-04-27)
 * skasowane — od hotfixu S03 `chat_streaming.ts` woła singleton wyłącznie po
 * tracking (`startStream`/`stopStream`/`getActiveStreams`), a `modules/sub-agents`
 * nigdy nie zaimportował StreamingManagera. Mapa była trwale pusta w runtime.
 */

/**
 * Czy tura ma dostać ŚWIEŻĄ instancję modelu zamiast tej z cache (AUD-testy-027).
 *
 * `ChatModel` trzyma stan per instancja (bilet bramki, `stopStream`, `_abortSettle`),
 * więc dwie tury na jednej instancji ścierają się o niego: Stop kliknięty w jednej zakładce
 * trafiał wtedy w turę drugiej. Decyzja stała w `chat_streaming.ts` (plik wisi na `obsidian`,
 * AVA go nie zaimportuje) i nie miała ŻADNEGO testu — `getActiveStreams()` zwracające zawsze
 * `[]` zostawiało 259/259 na zielono. Dziś jest tutaj, obok stanu, na którym się opiera.
 *
 * @param localTurns - ile tur trzyma TEN widok (`_streamCtxMap.size`)
 * @param globalActiveStreams - ile streamów żyje w całym pluginie (`getActiveStreams().length`)
 */
export function shouldUseFreshModel(localTurns: number, globalActiveStreams: number): boolean {
    // Pre-Z7 guard był tylko lokalny (`size > 1`) — przy czterech zakładkach każdy widok
    // widział `size === 1` i brał instancję z cache, więc tury z RÓŻNYCH widoków się ścierały.
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
