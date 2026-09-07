/**
 * Logger - centralny system logowania dla PKM Assistant.
 *
 * Użycie:
 *   import { log } from '../utils/Logger.js';
 *   log.debug('MojModul', 'Co się dzieje', dane);
 *   log.info('MojModul', 'Ważna informacja');
 *   log.warn('MojModul', 'Uwaga!');
 *   log.error('MojModul', 'Błąd', error);
 *   log.tool('nazwa_toola', args, result);
 *   log.model('main', 'deepseek', 'deepseek-chat');
 *   log.timing('MojModul', 'operacja', startTime);
 *
 * Debug mode: ustawiany przez pkmAssistant.debugMode w settings.
 * Kiedy DEBUG=false: tylko warn/error.
 * Kiedy DEBUG=true: WSZYSTKO (debug, info, tool, model, timing).
 *
 * L1 (2026-08-27): `debug`/`info`/`model`/`timing` oraz etykiety w `tool()`/`table()` wołają
 * `console.debug` (nie `console.log`) — zgodność z wytyczną Obsidiana „Avoid unnecessary
 * logging to console" (dozwolone metody: warn/error/debug; patrz eslint.obsidian.config.js).
 * W Chromium DevTools poziom Verbose jest DOMYŚLNIE UKRYTY, więc po włączeniu debugMode trzeba
 * ręcznie zaznaczyć filtr Verbose w konsoli, inaczej wygląda to jak brak logów — stąd wskazówka
 * dopisana wprost do komunikatu w `setDebug()`.
 */

import { maskSensitiveData } from '../security/SensitiveDataGuard.js';
import { t } from '../i18n/index.js';
import { LogFileSink } from './LogFileSink.js';
import type { LogFileSinkAdapter, LogLevel } from './LogFileSink.js';

const COLORS = {
    debug: 'color: #888',
    info:  'color: #4fc3f7',
    warn:  'color: #ffb74d',
    error: 'color: #ef5350; font-weight: bold',
    tool:  'color: #81c784',
    model: 'color: #ce93d8',
    timing:'color: #fff176',
};

const ICONS = {
    debug: '🔍',
    info:  'ℹ️',
    warn:  '⚠️',
    error: '❌',
    tool:  '🔧',
    model: '🤖',
    timing:'⏱️',
};

function maskLogText(value: string): string {
    return maskSensitiveData(value);
}

/** Ile poziomów zagnieżdżenia przechodzimy, zanim spłaszczymy do tekstu (anty-cykl). */
const MASK_MAX_DEPTH = 6;

/**
 * K20 (AUD-security-133): przez maskę idzie KAŻDY poziom argumentu, także kontekst dopięty
 * do błędu. Dawniej klon `Error` niósł wyłącznie `name`/`message`/`stack`, więc `cause`
 * (ES2022) i pola doklejane przez adaptery (`response`, `data`, `details`) po prostu ZNIKAŁY
 * — sekret nie wyciekał, ale diagnostyka gubiła całą treść. Dziś te pola zostają, przepuszczone
 * przez tę samą maskę.
 *
 * `depth` pilnuje, żeby cykliczna struktura nie zapętliła rekurencji — dlatego wszystkie
 * wywołania `.map()` opakowane są w lambdę (goły `.map(maskLogValue)` podawał INDEKS jako
 * głębokość).
 * @param value
 * @param depth
 */
function maskLogValue(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return maskLogText(value);
    if (depth >= MASK_MAX_DEPTH) return maskLogText(String(value));
    if (value instanceof Error) {
        const clone = new Error(maskLogText(value.message));
        clone.name = value.name;
        if (value.stack) clone.stack = maskLogText(value.stack);
        const source = value as unknown as Record<string, unknown>;
        const target = clone as unknown as Record<string, unknown>;
        // `cause` bywa nieprzeliczalne (konstruktor `new Error(msg, { cause })`), więc osobno.
        if (source.cause !== undefined) target.cause = maskLogValue(source.cause, depth + 1);
        for (const key of Object.keys(source)) {
            if (key === 'cause' || key === 'name' || key === 'message' || key === 'stack') continue;
            target[key] = maskLogValue(source[key], depth + 1);
        }
        return clone;
    }
    if (Array.isArray(value)) return value.map(item => maskLogValue(item, depth + 1));
    if (value && typeof value === 'object') {
        try {
            return JSON.parse(maskLogText(JSON.stringify(value)));
        } catch {
            return maskLogText(String(value));
        }
    }
    return value;
}

class Logger {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    // `_debug` NIE jest `private` świadomie: testy security (`core/security/*.test.js`)
    // przestawiają je wprost, żeby sprawdzić maskowanie w trybie debug.
    declare _debug: boolean;
    declare private _fileSink: LogFileSink | null;

    constructor() {
        this._debug = false;
        // Optional file sink (E1.8) — off until initFileSink() is called from main.js.
        // Node tests never call it, so behaviour stays console-only there.
        this._fileSink = null;
    }

    /**
     * Called from settings or plugin init to enable/disable debug mode.
     * @param enabled - `unknown`, bo wartość przychodzi wprost z ustawień usera; kod i tak
     *   robi `!!enabled`, więc każdy kształt jest legalny.
     */
    setDebug(enabled: unknown): void {
        this._debug = !!enabled;
        // File sink mirrors debug state: info+ normally, everything when debug is on.
        if (this._fileSink) this._fileSink.setLevel(enabled ? 'debug' : 'info');
        if (enabled) {
            // L1 (2026-08-27): console.debug (nie .log) — patrz komentarz klasy na górze pliku.
            console.debug(
                `%c[PKM] 🐛 ${t('logger.debug_enabled')}`,
                'color: #4caf50; font-weight: bold; font-size: 14px'
            );
        }
    }

    get isDebug(): boolean {
        return this._debug;
    }

    /** True when the optional file sink is active (used by self-test). */
    get fileSinkActive(): boolean {
        return !!this._fileSink;
    }

    /**
     * Enable (or disable) the optional log file sink. No-op-safe: without an
     * adapter (node tests) nothing changes and console logging is untouched.
     * @param o
     * @param o.adapter - vault.adapter (needs write; append/stat/exists/mkdir optional)
     * @param o.enabled
     * @param o.level - defaults to debug-mode-derived level
     * @param o.path
     */
    initFileSink({ adapter, enabled = true, level, path }: {
        adapter?: LogFileSinkAdapter | null;
        enabled?: boolean;
        level?: LogLevel;
        path?: string;
    } = {}): void {
        if (this._fileSink) {
            try { this._fileSink.dispose(); } catch { /* ignore */ }
            this._fileSink = null;
        }
        if (!enabled || !adapter) return;
        const effectiveLevel = level || (this._debug ? 'debug' : 'info');
        const sink = new LogFileSink({ adapter, level: effectiveLevel, ...(path ? { path } : {}) });
        void sink.init(); // async dir + rotation; buffered writes wait on it internally
        this._fileSink = sink;
    }

    /**
     * Zamknij sink plikowy: wypchnij bufor na dysk i zdejmij budzik flusha.
     * Wzór `TraceLog.dispose()` — wołane z `onunload` pluginu, MOŻLIWIE PÓŹNO, bo wcześniejsze
     * kroki demontażu jeszcze logują.
     *
     * AUD-bledy-059/038: przedtem jedynym wołaczem `dispose()` był sam `initFileSink` przy
     * PONOWNEJ inicjalizacji. Ogon logu z demontażu czekał na debounce (1000 ms) i przy
     * zamknięciu Obsidiana tuż po wyłączeniu pluginu ginął bez ostrzeżenia — akurat ten plik
     * jest po to, żeby agent czytał z niego, co się działo (LogFileSink: „CZYTA PLIKI z dysku").
     * Fail-soft: demontaż nie ma prawa się wywrócić na logowaniu.
     */
    async disposeFileSink(): Promise<void> {
        const sink = this._fileSink;
        this._fileSink = null;
        if (!sink) return;
        try {
            await sink.flush?.();
        } catch { /* sprzątanie best-effort */ }
        try {
            sink.dispose?.();
        } catch { /* sprzątanie best-effort */ }
    }

    /**
     * Feed a log event to the file sink (masked). Cheap-exits when the sink is
     * off or the level is below threshold — masking only runs for lines we keep.
     */
    private _toSink(level: LogLevel, module: string, message: string, data?: unknown[]): void {
        const sink = this._fileSink;
        if (!sink || !sink.accepts(level)) return;
        try {
            sink.write(level, module, maskLogText(String(message ?? '')), (data || []).map(item => maskLogValue(item)));
        } catch { /* logging must never throw */ }
    }

    /** Debug - console only when debug mode is on; file sink decides independently */
    debug(module: string, message: string, ...data: unknown[]): void {
        this._toSink('debug', module, message, data);
        if (!this._debug) return;
        console.debug(
            `%c${ICONS.debug} [PKM:${module}] ${maskLogText(message)}`,
            COLORS.debug,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Info - console only when debug mode is on; file sink captures it regardless */
    info(module: string, message: string, ...data: unknown[]): void {
        this._toSink('info', module, message, data);
        if (!this._debug) return;
        console.debug(
            `%c${ICONS.info} [PKM:${module}] ${maskLogText(message)}`,
            COLORS.info,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Warn - ALWAYS visible */
    warn(module: string, message: string, ...data: unknown[]): void {
        this._toSink('warn', module, message, data);
        console.warn(
            `${ICONS.warn} [PKM:${module}] ${maskLogText(message)}`,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Error - ALWAYS visible */
    error(module: string, message: string, ...data: unknown[]): void {
        this._toSink('error', module, message, data);
        console.error(
            `${ICONS.error} [PKM:${module}] ${maskLogText(message)}`,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Tool call log - debug only */
    tool(toolName: string, args: unknown, result: unknown): void {
        if (!this._debug) return;
        const argStr = maskSensitiveData(typeof args === 'string' ? args : JSON.stringify(args, null, 2));
        const resultStr = maskSensitiveData(typeof result === 'string' ? result : JSON.stringify(result));
        const truncResult = resultStr?.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
        console.groupCollapsed(
            `%c${ICONS.tool} [PKM:Tool] ${toolName}`,
            COLORS.tool
        );
        console.debug('Args:', argStr);
        console.debug('Result:', truncResult);
        console.groupEnd();
    }

    /** Model selection log - debug only */
    model(role: string, platform: string, modelId: string): void {
        if (!this._debug) return;
        console.debug(
            `%c${ICONS.model} [PKM:Model] ${role} → ${maskSensitiveData(platform)}/${maskSensitiveData(modelId)}`,
            COLORS.model
        );
    }

    /** Timing log - debug only */
    timing(module: string, operation: string, startTime: number): void {
        if (!this._debug) return;
        const elapsed = Date.now() - startTime;
        console.debug(
            `%c${ICONS.timing} [PKM:${module}] ${operation}: ${elapsed}ms`,
            COLORS.timing
        );
    }

    /** Group start - debug only */
    group(module: string, label: string): void {
        if (!this._debug) return;
        console.groupCollapsed(
            `%c📂 [PKM:${module}] ${label}`,
            'color: #90a4ae; font-weight: bold'
        );
    }

    /** Group end - debug only */
    groupEnd(): void {
        if (!this._debug) return;
        console.groupEnd();
    }

    /** Table log - debug only */
    table(module: string, label: string, data: unknown): void {
        if (!this._debug) return;
        console.debug(
            `%c📊 [PKM:${module}] ${label}`,
            'color: #90a4ae'
        );
        console.table(data);
    }
}

/** Singleton instance */
export const log = new Logger();
