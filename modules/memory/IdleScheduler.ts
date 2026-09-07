/**
 * E2.7 W3 (K4): idle-consolidation decision helper.
 *
 * Pure logic, no Obsidian import → node-testable. The 60s interval and the actual
 * handleSaveSession() call live in chat_session (which owns ChatView + AgentMemory); this class
 * only answers "should we consolidate now?" given the current activity snapshot.
 *
 * W3-lite scope: on idle we only run the mechanical transcript save (handleSaveSession). No
 * background LLM work yet — that needs more trust and is a separate decision after W1+W2 settle.
 */
export interface IdleSchedulerOptions {
    /** Idle threshold in minutes. <= 0 disables (off). */
    idleMinutes?: number;
    /** Min new entries since last save to bother firing. */
    minNewEntries?: number;
}

/** Activity snapshot handed in by the caller (chat_session owns the real clock). */
export interface IdleSnapshot {
    /** current time (Date.now()). */
    nowMs: number;
    /** timestamp of last message/tool-call, or null. */
    lastActivityMs?: number | null;
    /** entries added since the last idle save. */
    newEntries?: number;
}

export class IdleScheduler {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare idleMinutes: number;
    declare minNewEntries: number;

    constructor(options: IdleSchedulerOptions = {}) {
        this.idleMinutes = Number(options.idleMinutes) || 0;
        this.minNewEntries = options.minNewEntries != null ? Number(options.minNewEntries) : 2;
    }

    /** @returns true when an idle consolidation should run now. */
    // Domyślne `{}` jest degenerate case'em: bez `lastActivityMs` funkcja wychodzi
    // przed użyciem `nowMs`, więc asercja tylko odwzorowuje istniejący kontrakt wołacza
    // (chat_session zawsze podaje pełny snapshot). Zero zmiany runtime'u.
    shouldFire({ nowMs, lastActivityMs, newEntries }: IdleSnapshot = {} as IdleSnapshot): boolean {
        if (!(this.idleMinutes > 0)) return false;             // 0 / NaN = off
        if (lastActivityMs == null) return false;              // nothing happened yet
        if ((newEntries || 0) < this.minNewEntries) return false; // nothing new worth saving
        return (nowMs - lastActivityMs) >= this.idleMinutes * 60 * 1000;
    }
}
