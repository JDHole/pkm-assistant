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
 * `debug`/`info`/`model`/`timing`/`tool`/`group` wołają WYŁĄCZNIE `console.debug` (nie
 * `console.log`) — zgodność z wytyczną Obsidiana „Avoid unnecessary logging to console"
 * (dozwolone metody: warn/error/debug; patrz eslint.obsidian.config.js). `console.groupCollapsed`,
 * `console.groupEnd` i `console.table` NIE są na tej białej liście i walidator katalogu je zgłasza
 * bez wyjątków (nie uznaje per-plikowych override'ów configu) — `group()` loguje więc płasko przez
 * `console.debug` zamiast otwierać grupę DevTools, `groupEnd()` jest udokumentowanym no-opem
 * (nic już nie zamyka), a `table()` zniknął (nikt go nie wołał — `grep`em potwierdzone).
 * W Chromium DevTools poziom Verbose jest DOMYŚLNIE UKRYTY, więc po włączeniu debugMode trzeba
 * ręcznie zaznaczyć filtr Verbose w konsoli, inaczej wygląda to jak brak logów — stąd wskazówka
 * dopisana wprost do komunikatu w `setDebug()`.
 */

import { redactImageText } from './imageRedaction.js';
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

/** Ograniczenie rekurencji bez wywoływania cudzych toString/toJSON. */
const MASK_MAX_DEPTH = 6;
const UNREADABLE = '[unreadable log value]';

/**
 * Kopia danych bez wykonywalnych hooków. Cykl i limit zastępujemy stałym tekstem;
 * błędy getterów/proxy nie przerywają logowania ani nie ujawniają ich treści.
 * Error zachowuje także nieenumerowalne message/stack/cause.
 */
function logSnapshot(value: unknown, depth = 0, ancestors = new WeakSet<object>()): unknown {
    try {
        if (value === null || value === undefined || typeof value === 'string'
            || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
        if (typeof value === 'function') return '[function]';
        if (typeof value !== 'object') return UNREADABLE;
        if (ancestors.has(value)) return '[cycle]';
        if (depth >= MASK_MAX_DEPTH) return '[depth limit]';
        ancestors.add(value);
        try {
            if (Array.isArray(value)) {
                const copy: unknown[] = [];
                for (let index = 0; index < value.length; index++) {
                    try { copy.push(logSnapshot(value[index], depth + 1, ancestors)); }
                    catch { copy.push(UNREADABLE); }
                }
                return copy;
            }
            const keys = new Set(Object.keys(value));
            if (value instanceof Error) {
                for (const key of ['name', 'message', 'stack', 'cause']) keys.add(key);
            }
            const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            for (const key of keys) {
                if (key === 'base64') continue;
                try {
                    copy[key] = logSnapshot((value as Record<string, unknown>)[key], depth + 1, ancestors);
                } catch { copy[key] = UNREADABLE; }
            }
            return copy;
        } finally { ancestors.delete(value); }
    } catch { return UNREADABLE; }
}

/** Jedna droga do tekstu dla komunikatu, etykiet i argumentów tool/model/timing. */
function maskLogText(value: unknown): string {
    try {
        const snapshot = logSnapshot(value);
        const text = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot) ?? String(snapshot);
        return maskSensitiveData(redactImageText(text));
    } catch { return UNREADABLE; }
}

/** Konsola zachowuje strukturę danych i Error, ale nigdy surowe obiekty wołającego. */
function maskLogValue(value: unknown): unknown {
    try {
        if (value === undefined || value === null) return value;
        if (typeof value !== 'object') return typeof value === 'number' || typeof value === 'boolean' ? value : maskLogText(value);
        const masked: unknown = JSON.parse(maskLogText(value));
        if (value instanceof Error && masked && typeof masked === 'object') {
            return Object.assign(new Error(), masked);
        }
        return masked;
    } catch { return UNREADABLE; }
}

class Logger {
    // `declare` = sama deklaracja typu, zero emitu.
    // `_debug` NIE jest `private` świadomie: testy security (`core/security/*.test.js`)
    // przestawiają je wprost, żeby sprawdzić maskowanie w trybie debug.
    declare _debug: boolean;
    declare private _fileSink: LogFileSink | null;

    constructor() {
        this._debug = false;
        // Optional file sink — off until initFileSink() is called from main.js.
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
            // console.debug (nie .log) — patrz komentarz klasy na górze pliku.
            this._console('debug',
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
     * Bez jawnego wywołania `dispose()` tutaj, ogon logu z demontażu czekałby na debounce
     * (1000 ms) i przy zamknięciu Obsidiana tuż po wyłączeniu pluginu ginąłby bez ostrzeżenia —
     * akurat ten plik jest po to, żeby agent czytał z niego, co się działo (LogFileSink: „CZYTA
     * PLIKI z dysku"). Fail-soft: demontaż nie ma prawa się wywrócić na logowaniu.
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
        if (!sink) return;
        try {
            if (!sink.accepts(level)) return;
            sink.write(level, maskLogText(module), maskLogText(message), (data || []).map(item => maskLogValue(item)));
        } catch { /* logging must never throw */ }
    }

    /** Odbiornik logu jest best-effort, podobnie jak sink plikowy. */
    private _console(level: 'debug' | 'warn' | 'error', ...args: unknown[]): void {
        try {
            if (level === 'warn') console.warn(...args);
            else if (level === 'error') console.error(...args);
            else console.debug(...args);
        } catch { /* logging must never throw */ }
    }

    /** Debug - console only when debug mode is on; file sink decides independently */
    debug(module: string, message: string, ...data: unknown[]): void {
        this._toSink('debug', module, message, data);
        if (!this._debug) return;
        this._console('debug',
            `%c${ICONS.debug} [PKM:${maskLogText(module)}] ${maskLogText(message)}`,
            COLORS.debug,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Info - console only when debug mode is on; file sink captures it regardless */
    info(module: string, message: string, ...data: unknown[]): void {
        this._toSink('info', module, message, data);
        if (!this._debug) return;
        this._console('debug',
            `%c${ICONS.info} [PKM:${maskLogText(module)}] ${maskLogText(message)}`,
            COLORS.info,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Warn - ALWAYS visible */
    warn(module: string, message: string, ...data: unknown[]): void {
        this._toSink('warn', module, message, data);
        this._console('warn',
            `${ICONS.warn} [PKM:${maskLogText(module)}] ${maskLogText(message)}`,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Error - ALWAYS visible */
    error(module: string, message: string, ...data: unknown[]): void {
        this._toSink('error', module, message, data);
        this._console('error',
            `${ICONS.error} [PKM:${maskLogText(module)}] ${maskLogText(message)}`,
            ...data.map(item => maskLogValue(item))
        );
    }

    /** Tool call log - debug only */
    tool(toolName: string, args: unknown, result: unknown): void {
        if (!this._debug) return;
        const argStr = maskLogText(args);
        const resultStr = maskLogText(result);
        const truncResult = resultStr?.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr;
        // Nagłówek grupy: był `console.groupCollapsed` (poza białą listą walidatora), teraz płaski
        // `console.debug` z tym samym tekstem/stylem — Args/Result i tak lądowały osobnymi liniami.
        this._console('debug',
            `%c${ICONS.tool} [PKM:Tool] ${maskLogText(toolName)}`,
            COLORS.tool
        );
        this._console('debug', 'Args:', argStr);
        this._console('debug', 'Result:', truncResult);
    }

    /** Model selection log - debug only */
    model(role: string, platform: string, modelId: string): void {
        if (!this._debug) return;
        this._console('debug',
            `%c${ICONS.model} [PKM:Model] ${maskLogText(role)} → ${maskLogText(platform)}/${maskLogText(modelId)}`,
            COLORS.model
        );
    }

    /** Timing log - debug only */
    timing(module: string, operation: string, startTime: number): void {
        if (!this._debug) return;
        const elapsed = typeof startTime === 'number' && Number.isFinite(startTime) ? Date.now() - startTime : '[invalid time]';
        this._console('debug',
            `%c${ICONS.timing} [PKM:${maskLogText(module)}] ${maskLogText(operation)}: ${elapsed}ms`,
            COLORS.timing
        );
    }

    /**
     * Group start - debug only. Był `console.groupCollapsed` (poza białą listą walidatora
     * Obsidiana: warn/error/debug), teraz płaski `console.debug` z tym samym tekstem/stylem —
     * bez wizualnego zagnieżdżenia w DevTools, ale caller (AgentManager, SubAgentRunner) nadal
     * woła `group()`/`groupEnd()` w parach, więc API zostaje.
     */
    group(module: string, label: string): void {
        if (!this._debug) return;
        this._console('debug',
            `%c📂 [PKM:${maskLogText(module)}] ${maskLogText(label)}`,
            'color: #90a4ae; font-weight: bold'
        );
    }

    /**
     * Group end - udokumentowany no-op. `console.groupEnd` nie jest na białej liście walidatora
     * i nie ma czego zamykać, skoro `group()` już nie otwiera grupy konsoli. Metoda zostaje dla
     * callerów, którzy nadal wołają `group()`/`groupEnd()` w parach (AgentManager, SubAgentRunner).
     */
    groupEnd(): void {
        if (!this._debug) return;
        // no-op, celowo puste — patrz komentarz metody.
    }
}

/** Singleton instance */
export const log = new Logger();
