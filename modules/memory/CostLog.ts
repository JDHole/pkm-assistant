/**
 * CostLog - append-only JSONL log per LLM call.
 *
 * Path: `.pkm-assistant/cost_log.jsonl` (per-vault, NIE per-agent - global view).
 *
 * Zapisuje minimalne entries dla archivist runs + przyszłych sub-agentów.
 *
 * Entry shape:
 *   {
 *     ts: ISO8601,
 *     agent: "Jaskier",
 *     role: "prep-memory",
 *     model: "claude-haiku-4-5",
 *     input_tokens: 8500,
 *     output_tokens: 220,
 *     cost_usd: 0.0012,
 *     session_id?: "2026-04-27_...",
 *     status: "ok" | "error",
 *     error?: "msg"
 *   }
 */

import { log } from '../../core/utils/Logger.js';
import { readIfExists } from '../../core/index.js';

const COST_LOG_PATH = '.pkm-assistant/cost_log.jsonl';

/**
 * Krótki, czytelny opis `cause` z `readIfExists` - do wklejenia w komunikat
 * warn zamiast suchego „nie mogę odczytać X" bez powodu. Ta sama logika
 * co `causeText` w `AgentMemory.ts` - duplikat świadomy, plik jest celowo bez importów poza
 * `log`/`readIfExists` (patrz styl reszty modułu).
 */
function causeText(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (cause === undefined) return 'brak szczegółów — adapter bez metody read()';
    return String(cause);
}

/**
 * Approximate USD cost per 1M tokens (input/output).
 * Used as fallback when LLM API doesn't return cost. Updated 2026-04 prices.
 */
const PRICE_PER_M: Record<string, { input: number; output: number }> = {
    'claude-haiku-4-5': { input: 1.0, output: 5.0 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-opus-4-7':   { input: 15.0, output: 75.0 },
    'gpt-4o':            { input: 2.5, output: 10.0 },
    'gpt-4o-mini':       { input: 0.15, output: 0.6 },
    'gemini-2.5-flash':  { input: 0.3, output: 2.5 },
    // Local models = $0
    'ollama':            { input: 0, output: 0 },
    'lm-studio':         { input: 0, output: 0 }
};

/** Wejście szacunku kosztu - `model` bywa nieznane/puste i wtedy szacunek to 0. */
export interface CostEstimateInput {
    model?: string | null;
    inputTokens?: number;
    outputTokens?: number;
}

export function estimateCostUsd({ model, inputTokens = 0, outputTokens = 0 }: CostEstimateInput): number {
    if (!model) return 0;
    const key = String(model).toLowerCase();
    let prices = PRICE_PER_M[key];
    if (!prices) {
        // Try fuzzy match (np. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
        const matched = Object.keys(PRICE_PER_M).find(k => key.startsWith(k));
        if (matched) prices = PRICE_PER_M[matched];
    }
    if (!prices) return 0; // unknown model
    return (inputTokens / 1_000_000) * prices.input + (outputTokens / 1_000_000) * prices.output;
}

/** Adapter FS vaulta w zakresie potrzebnym logowi kosztów (typowany strukturalnie). */
export interface CostLogVaultLike {
    adapter: {
        exists(path: string): Promise<boolean>;
        read(path: string): Promise<string>;
        write(path: string, data: string): Promise<void>;
    };
}

/** Wpis podawany przez wołacza - wszystko opcjonalne, `append` normalizuje braki. */
export interface CostLogEntryInput {
    agent?: string;
    role?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    savings_usd?: number;
    cache?: { cached_tokens?: number; savings_usd?: number } | null;
    cost_usd?: number;
    session_id?: string;
    /** w praktyce `'ok'` albo `'error'`; kontrakt zostaje `string` (wołacze są w .js) */
    status?: string;
    error?: unknown;
}

/** Wiersz realnie zapisany do JSONL (wynik normalizacji). */
export interface CostLogRecord {
    ts: string;
    agent: string;
    role: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    savings_usd: number;
    cost_usd: number;
    session_id?: string;
    status: string;
    error?: string;
}

export class CostLog {
    // `declare` = sama deklaracja typu, zero emitu.
    declare vault: CostLogVaultLike;
    declare path: string;

    constructor(vault: CostLogVaultLike) {
        this.vault = vault;
        this.path = COST_LOG_PATH;
    }

    /**
     * Append one cost entry to JSONL.
     * Best-effort - błąd zapisu loguje warn ale NIE rzuca (cost log to nie krytyczna ścieżka).
     */
    async append(entry: CostLogEntryInput = {}): Promise<CostLogRecord> {
        const ts = new Date().toISOString();
        const safe: CostLogRecord = {
            ts,
            agent: entry.agent || '?',
            role: entry.role || '?',
            model: entry.model || '?',
            input_tokens: Number(entry.input_tokens) || 0,
            output_tokens: Number(entry.output_tokens) || 0,
            cached_tokens: Number(entry.cached_tokens) || Number(entry.cache?.cached_tokens) || 0,
            savings_usd: Number(entry.savings_usd) || Number(entry.cache?.savings_usd) || 0,
            cost_usd: typeof entry.cost_usd === 'number'
                ? entry.cost_usd
                : estimateCostUsd({
                    model: entry.model,
                    inputTokens: entry.input_tokens || 0,
                    outputTokens: entry.output_tokens || 0
                }),
            ...(entry.session_id ? { session_id: entry.session_id } : {}),
            status: entry.status || 'ok',
            ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {})
        };
        const line = JSON.stringify(safe) + '\n';
        try {
            // Self-append: jak `AgentMemory.appendBrainLog` - `readIfExists` czyta
            // najpierw, więc kłamiący `exists()` (Dysk Google) nie może przepchnąć kodu w
            // gałąź „pierwszy wpis" i nadpisać dotychczasowego dziennika kosztów jedną linią.
            const probe = await readIfExists(this.vault.adapter, this.path);
            if (probe.state === 'unreadable') {
                // Best-effort, jak reszta klasy: pomijamy TEN wpis zamiast ryzykować nadpisanie.
                log.warn('CostLog', `append: nie mogę odczytać ${this.path}, pomijam ten wpis (${causeText(probe.cause)})`);
                return safe;
            }
            const existing = probe.state === 'content' ? probe.content : '';
            await this.vault.adapter.write(this.path, existing + line);
        } catch (e) {
            log.warn('CostLog', 'append failed (non-fatal):', e);
        }
        return safe;
    }

    /**
     * Read all entries (parsed). Z17 modal użyje do agregacji.
     * Best-effort - corrupt lines skipowane.
     */
    async readAll(): Promise<unknown[]> {
        try {
            if (!(await this.vault.adapter.exists(this.path))) return [];
            const content = await this.vault.adapter.read(this.path);
            const entries: unknown[] = [];
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try { entries.push(JSON.parse(trimmed)); } catch { /* skip corrupt */ }
            }
            return entries;
        } catch (e) {
            log.warn('CostLog', 'readAll failed:', e);
            return [];
        }
    }
}
