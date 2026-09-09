/**
 * TraceLog — cienki trace przebiegu pętli agenta.
 *
 * PO CO: `runAgentLoop` (modules/agent-loop) to jedna pętla narzędziowa czatu i
 * sub-agentów. Kiedy coś idzie nie tak (narzędzie się wywala, model kręci się w
 * kółko, pętla wchodzi w backstop), agent testujący plugin z zewnątrz CZYTA PLIKI
 * z dysku, nie konsolę. Ten trace dubluje suchy przebieg pętli — po jednej linii na
 * zdarzenie (start, model.done, tool.pre/post, backstop, koniec) — do
 * `.pkm-assistant/logs/trace.log`, żeby dało się prześledzić turę bez debuggera.
 *
 * ZASADY:
 *   - Plik czysty i BEZ ZALEŻNOŚCI od Obsidiana (testowalny node'em). Wszystkie
 *     zależności (sink, funkcja maskująca) są WSTRZYKIWANE.
 *   - Fire-and-forget: trace NIGDY nie rzuca i NIGDY nie awaituje — cała funkcja
 *     zapisu jest w try/catch, a I/O buforuje sink (LogFileSink). Pętla agenta nie
 *     może się wywalić ani przyblokować przez trace.
 *   - Gdy trace jest wyłączony (brak sinka albo `enabled=false`) → no-op zero-kosztowy.
 *   - Maskowanie sekretów: linia przechodzi przez wstrzykniętą funkcję `mask`
 *     (w produkcji `maskSensitiveData`) ZANIM trafi do sinka.
 *
 * Wzorzec nagłówka i separacja hot-path/I/O — z LogFileSink.js.
 */

import { truncate, serializeArg } from './LogFileSink.js';

// Długość, do której przycinamy wartości pól trace (surowe argumenty narzędzi
// bywają duże — trace ma być suchy, nie ma dublować pełnych wyników).
const TRACE_MAX_LEN = 200;

/**
 * Odbiornik linii trace — duck-typowany na `LogFileSink` (wstrzykiwany, patrz nagłówek).
 * `flush`/`dispose` opcjonalne, bo `dispose()` woła je przez `?.`.
 */
export interface TraceSink {
    write: (level: string, tag: string, message: string) => void;
    flush?: () => Promise<void> | void;
    dispose?: () => void;
}

/** Funkcja trace związana z etykietą — patrz `scope()`. */
export type ScopedTrace = (type: string, fields?: Record<string, unknown>) => void;

export class TraceLog {
    // `declare` = sama deklaracja typu, zero emitu.
    declare sink: TraceSink | null;
    declare enabled: boolean;
    declare mask: ((line: string) => string) | null;

    /**
     * @param opts
     * @param opts.sink - instancja LogFileSink (lub null → trace wyłączony)
     * @param opts.enabled - master switch
     * @param opts.mask - opcjonalna (string)=>string maskująca sekrety w linii
     */
    constructor({ sink = null, enabled = true, mask = null }: {
        sink?: TraceSink | null;
        enabled?: boolean;
        mask?: ((line: string) => string) | null;
    } = {}) {
        this.sink = sink || null;
        this.enabled = enabled !== false;
        this.mask = typeof mask === 'function' ? mask : null;
    }

    /** True gdy trace realnie coś zapisze (włączony i ma sink). */
    get active(): boolean {
        return !!(this.enabled && this.sink);
    }

    /**
     * Zwraca funkcję trace związaną z etykietą kontekstu (np. `chat/Klara#ab12`).
     * Funkcja: `(type, fields = {}) => void` — formatuje i pisze JEDNĄ linię:
     *   `label | type | k1=v1 k2=v2 ...`
     * Pola w kolejności wstawienia; wartości stringowe przycięte do 200 znaków,
     * obiekty serializowane. Cała funkcja fail-soft (błędy połknięte).
     * @param label
     */
    scope(label: string): ScopedTrace {
        // Strzałka (nie `function` + `const self = this`): leksykalnie łapie `this` z chwili
        // wywołania `scope()`, więc zwrócona funkcja działa identycznie, choć bywa wołana
        // gołym wywołaniem (bez odbiornika) daleko od tej klasy.
        return (type: string, fields: Record<string, unknown> = {}): void => {
            if (!this.active) return; // no-op zero-kosztowy gdy trace wyłączony
            try {
                const parts = [];
                for (const [k, v] of Object.entries(fields || {})) {
                    const val = typeof v === 'string'
                        ? truncate(v, TRACE_MAX_LEN)
                        : serializeArg(v, TRACE_MAX_LEN);
                    parts.push(`${k}=${val}`);
                }
                let line = `${label} | ${type}`;
                if (parts.length) line += ` | ${parts.join(' ')}`;
                if (this.mask) line = this.mask(line);
                // Timestamp + poziom + tag dokłada sink (formatLogLine).
                // `sink!` — `this.active` (getter) już to sprawdziło, ale TS nie zawęża przez getter.
                this.sink!.write('info', 'trace', line);
            } catch {
                /* trace NIGDY nie może wywalić pętli agenta */
            }
        };
    }

    /** Flush + dispose sinka. Fail-soft — wołane przy onunload pluginu. */
    async dispose(): Promise<void> {
        try {
            if (this.sink) {
                await this.sink.flush?.();
                this.sink.dispose?.();
            }
        } catch {
            /* sprzątanie best-effort — nie rzucaj przy unloadzie */
        }
    }
}
