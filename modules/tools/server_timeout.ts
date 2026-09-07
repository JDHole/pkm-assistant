/**
 * server_timeout.js — Sprint 04 Z6 (MCP_PORZADEK_v1).
 *
 * Pure helper (no obsidian import) — testowalny w izolacji.
 * Resolve effective timeout for a server: 60s default, override via manifest `timeout_ms`,
 * clamped to MAX 180s (defense-in-depth: malicious user MCP server cannot DoS).
 */

// AUD-dead-code-019/108: `export` zdjęty — zero konsumentów poza tym plikiem (nawet w testach),
// czytane wyłącznie przez resolveTimeoutMs() u siebie.
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

/**
 * Wszystko, czego ten helper potrzebuje od configu serwera: opcjonalny `timeout_ms`.
 * `unknown`, bo wartość pochodzi z manifestu / data.json — `Number()` i tak ją sprawdza.
 */
interface TimeoutCarryingConfig {
    timeout_ms?: unknown;
}

/**
 * @returns milliseconds — effective timeout for tool execution
 */
export function resolveTimeoutMs(serverConfig: TimeoutCarryingConfig | undefined | null): number {
    const requested = Number(serverConfig?.timeout_ms);
    if (!Number.isFinite(requested) || requested <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(requested, MAX_TIMEOUT_MS);
}
