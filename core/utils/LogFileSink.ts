/**
 * LogFileSink — opcjonalny zapis logów do pliku dla Loggera (E1.8, 2026-07-21).
 *
 * PO CO: `log.info/debug/warn/error` lecą tylko do konsoli devtools. Agent AI
 * testujący plugin z zewnątrz CZYTA PLIKI z dysku, nie konsolę. Ten sink dubluje
 * zdarzenia logu do `.pkm-assistant/logs/pkm-assistant.log`, żeby dało się je odczytać.
 *
 * ZASADY:
 *   - Plik czysty i BEZ ZALEŻNOŚCI (testowalny node'em). Maskowanie sekretów robi
 *     Logger PRZED wywołaniem write() — ten plik nigdy nie widzi surowych kluczy.
 *   - Hot-path (write) NIGDY nie robi I/O: buforuje w pamięci i planuje flush
 *     (debounce ~1s LUB co N wpisów — co pierwsze).
 *   - Append przez `adapter.append` gdy jest, inaczej read+write fallback,
 *     serializowane przez promise-chain, żeby równoległe flushe się nie przeplatały.
 *   - Rotacja przy inicie: jeśli plik > maxBytes, jego treść ląduje w `<path>.old`
 *     (nadpisuje starą kopię), a świeży plik startuje pusty.
 *
 * Wszystkie zależności (adapter, zegar, timery) wstrzykiwane — testy używają fake'ów.
 */

/** Cztery poziomy, które sink rozumie. Cokolwiek innego wpada w fallback 'info'. */
import { hostWindow, type HostTimer } from './hostWindow.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// `Record<string, number>`, bo kod świadomie indeksuje to dowolnym stringiem
// (poziom bywa z ustawień usera) i liczy na `undefined` jako sygnał „nie znam".
const LEVEL_RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_PATH = '.pkm-assistant/logs/pkm-assistant.log';
const DEFAULT_MAX_LEN = 500;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_FLUSH_EVERY_N = 20;

/**
 * Przycina tekst do maxLen znaków (dokleja '…' przy obcięciu).
 * @param text
 * @param maxLen
 */
export function truncate(text: unknown, maxLen: number = DEFAULT_MAX_LEN): string {
    const s = String(text ?? '');
    if (maxLen > 0 && s.length > maxLen) return s.slice(0, maxLen) + '…';
    return s;
}

/**
 * Bezpiecznie serializuje pojedynczy argument logu do jednej linii tekstu.
 * String → jak jest; Error → `Name: message | pierwsza linia stacku`;
 * obiekt/tablica → JSON (fallback String); reszta → String. Zawsze przycięte.
 * @param value
 * @param maxLen
 */
export function serializeArg(value: unknown, maxLen: number = DEFAULT_MAX_LEN): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (value instanceof Error) {
        // V8's stack line 0 is just "Name: message" — the useful info is the first
        // actual frame ("at ..."). Fall back to line 0 if no frame is present.
        const stackLines = String(value.stack || '').split('\n').map((l) => l.trim()).filter(Boolean);
        const frame = stackLines.find((l) => l.startsWith('at ')) || '';
        const base = value.message ? `${value.name || 'Error'}: ${value.message}` : String(value);
        const combined = frame ? `${base} | ${frame}` : base;
        return truncate(combined, maxLen);
    }
    if (typeof value === 'string') return truncate(value, maxLen);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return truncate(String(value), maxLen);
    }
    try {
        return truncate(JSON.stringify(value), maxLen);
    } catch {
        return truncate(String(value), maxLen);
    }
}

/** Wejście `formatLogLine` — wszystko opcjonalne, bo funkcja sama łata braki. */
export interface LogLineEntry {
    timestamp?: string;
    level?: string;
    tag?: string;
    message?: unknown;
    args?: unknown[];
}

/**
 * Buduje jedną linię logu: `[ISO-timestamp] [LEVEL] [Tag] message arg1 arg2`.
 * @param entry
 * @param opts
 */
export function formatLogLine(
    { timestamp, level, tag, message, args = [] }: LogLineEntry = {},
    opts: { maxLen?: number } = {},
): string {
    const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
    const ts = timestamp || new Date().toISOString();
    const lvl = String(level || 'info').toUpperCase();
    const tagStr = `[${tag || '?'}]`;
    const body = [
        truncate(String(message ?? ''), maxLen),
        ...(Array.isArray(args) ? args : []).map((a) => serializeArg(a, maxLen)),
    ].filter((p) => p !== '').join(' ');
    return `[${ts}] [${lvl}] ${tagStr}${body ? ' ' + body : ''}`;
}

/**
 * Adapter plikowy duck-typowany na `vault.adapter` Obsidiana. `read`/`write` są wymagane
 * (bez nich nie ma jak dopisać linii); reszta opcjonalna — kod sam sprawdza obecność.
 */
export interface LogFileSinkAdapter {
    read: (path: string) => Promise<string>;
    write: (path: string, content: string) => Promise<void> | void;
    append?: (path: string, text: string) => Promise<void> | void;
    exists?: (path: string) => Promise<boolean> | boolean;
    mkdir?: (path: string) => Promise<void> | void;
    stat?: (path: string) => Promise<{ size?: number } | null | undefined> | { size?: number } | null | undefined;
}

export interface LogFileSinkOptions {
    /** vault.adapter (potrzebuje write; append/stat/exists/mkdir opcjonalne) */
    adapter?: LogFileSinkAdapter | null;
    path?: string;
    level?: LogLevel;
    maxLen?: number;
    maxBytes?: number;
    flushIntervalMs?: number;
    flushEveryN?: number;
    /** () => Date (testowalny zegar) */
    now?: () => Date;
}

export class LogFileSink {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare adapter: LogFileSinkAdapter | null;
    declare path: string;
    declare oldPath: string;
    declare dir: string;
    /** `string`, a nie `LogLevel`: pole trzyma to, co przeszło rank-check (patrz `setLevel`). */
    declare level: string;
    declare maxLen: number;
    declare maxBytes: number;
    declare flushIntervalMs: number;
    declare flushEveryN: number;
    declare now: () => Date;
    declare private _buffer: string[];
    declare private _timer: HostTimer | null;
    declare private _ready: Promise<void>;
    declare private _writeChain: Promise<void>;
    /** Ustawiane przez dispose() — po tym momencie write() jest no-opem (patrz gotcha 6a w core/CLAUDE.md). */
    declare private _disposed: boolean;

    constructor(opts: LogFileSinkOptions = {}) {
        this.adapter = opts.adapter || null;
        this.path = opts.path || DEFAULT_PATH;
        this.oldPath = `${this.path}.old`;
        this.dir = this.path.split('/').slice(0, -1).join('/');
        // `opts.level` bywa `undefined` — w runtime `LEVEL_RANK[undefined]` to po prostu
        // `undefined` (czyli fallback na 'info'). Asercje wracają z tą wiedzą do typów.
        this.level = LEVEL_RANK[opts.level as LogLevel] ? (opts.level as LogLevel) : 'info';
        this.maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
        this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
        this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
        this.flushEveryN = opts.flushEveryN ?? DEFAULT_FLUSH_EVERY_N;
        this.now = opts.now || (() => new Date());

        this._buffer = [];
        this._timer = null;
        this._ready = Promise.resolve();   // ustawiane przez init() (dir + rotacja)
        this._writeChain = Promise.resolve(); // serializacja appendów
        this._disposed = false;
    }

    /** Zmienia próg poziomu (np. gdy user włączy debug w Settings). */
    setLevel(level: string): void {
        if (LEVEL_RANK[level]) this.level = level;
    }

    /** Czy dany poziom przechodzi próg (tani rank-check, bez maskowania). */
    accepts(level: string): boolean {
        return (LEVEL_RANK[level] || LEVEL_RANK.info) >= (LEVEL_RANK[this.level] || LEVEL_RANK.info);
    }

    /**
     * Jednorazowy setup: utwórz katalog + zrotuj za duży plik.
     * Buforowane write'y czekają na to wewnętrznie (przez _ready).
     */
    init(): Promise<void> {
        this._ready = this._doInit().catch(() => {});
        return this._ready;
    }

    private async _doInit(): Promise<void> {
        if (!this.adapter) return;
        await this._ensureDir();
        await this._rotateIfNeeded();
    }

    // `this.adapter!` w trzech metodach niżej: wszystkie trzy wołane są WYŁĄCZNIE z `_doInit()`,
    // które wychodzi wcześniej przy braku adaptera — TS nie przenosi tego zawężenia przez granicę
    // metody, więc asercja tylko odtwarza istniejący (i otoczony try/catch) warunek.
    private async _ensureDir(): Promise<void> {
        if (!this.dir) return;
        const parts = this.dir.split('/').filter(Boolean);
        let acc = '';
        for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            try {
                if (!(await this._exists(acc))) await this.adapter!.mkdir?.(acc);
            } catch { /* best-effort */ }
        }
    }

    private async _rotateIfNeeded(): Promise<void> {
        try {
            if (!(await this._exists(this.path))) return;
            const st = await this.adapter!.stat?.(this.path);
            const size = st && typeof st.size === 'number' ? st.size : 0;
            if (size <= this.maxBytes) return;
            let content = '';
            try { content = await this.adapter!.read(this.path); } catch { content = ''; }
            await this.adapter!.write(this.oldPath, content); // nadpisz starą kopię
            await this.adapter!.write(this.path, '');         // świeży plik
        } catch { /* rotacja best-effort — nie wywalaj startu */ }
    }

    /**
     * Hot-path — NIGDY nie awaituje I/O. Maskowanie robi Logger wcześniej.
     * @param level
     * @param tag
     * @param message (już zamaskowany)
     * @param args (już zamaskowane)
     */
    write(level: string, tag: string, message: string, args: unknown[] = []): void {
        if (this._disposed || !this.adapter || !this.accepts(level)) return;
        const line = formatLogLine(
            { timestamp: this.now().toISOString(), level, tag, message, args },
            { maxLen: this.maxLen }
        );
        this._buffer.push(line);
        if (this._buffer.length >= this.flushEveryN) {
            void this.flush();
        } else {
            this._scheduleFlush();
        }
    }

    private _scheduleFlush(): void {
        if (this._timer) return;
        // Timery przez `hostWindow` (Obsidian: window, Node: globalThis) — plik node-safe (testy AVA / harness,
        // zero `window`).
        this._timer = hostWindow.setTimeout(() => {
            this._timer = null;
            void this.flush();
        }, this.flushIntervalMs);
        // W Node `hostWindow.setTimeout` zwraca obiekt Timeout (typowany jak w przeglądarce: liczba) —
        // `unref()` istnieje tylko tam i tylko tam ma sens: timer nie ma trzymać procesu testów przy życiu.
        (this._timer as unknown as { unref?: () => void } | null)?.unref?.();
    }

    /**
     * Zrzuca bufor na dysk. Zwraca promise zapisu (awaitowalny w testach).
     */
    flush(): Promise<void> {
        // Timery przez `hostWindow` (Obsidian: window, Node: globalThis) — plik node-safe (testy AVA / harness,
        // zero `window`).
        if (this._timer) { hostWindow.clearTimeout(this._timer); this._timer = null; }
        if (this._buffer.length === 0) return this._writeChain;
        const chunk = this._buffer.join('\n') + '\n';
        this._buffer = [];
        this._writeChain = this._writeChain
            .then(() => this._ready)          // append czeka aż init (rotacja) skończy
            .then(() => this._append(chunk))
            .catch(() => {});                 // logowanie nigdy nie może rzucić
        return this._writeChain;
    }

    private async _append(text: string): Promise<void> {
        if (!this.adapter) return;
        if (typeof this.adapter.append === 'function') {
            await this.adapter.append(this.path, text);
            return;
        }
        let existing = '';
        try { existing = await this.adapter.read(this.path); } catch { existing = ''; }
        await this.adapter.write(this.path, existing + text);
    }

    private async _exists(path: string): Promise<boolean> {
        try { return !!(await this.adapter!.exists?.(path)); }
        catch { return false; }
    }

    /**
     * Zamyka sink: czyści timer, zrzuca resztę bufora na dysk (fire-and-forget — `dispose()`
     * jest synchroniczne, bo `onunload` pluginu też jest) i oznacza `_disposed`, żeby żaden
     * kolejny `write()` nie wskrzesił zapisu na ścieżkę, która mogła już zniknąć spod nóg
     * (patrz gotcha 6a w `core/CLAUDE.md`). Idempotentne — drugie wywołanie jest no-opem.
     */
    dispose(): void {
        // Timery przez `hostWindow` (Obsidian: window, Node: globalThis) — plik node-safe (testy AVA / harness,
        // zero `window`).
        if (this._timer) { hostWindow.clearTimeout(this._timer); this._timer = null; }
        if (this._disposed) return;
        this._disposed = true;
        if (this._buffer.length > 0) {
            // `flush()` już serializuje przez `_writeChain` i łyka błędy — fire-and-forget jest
            // bezpieczny. Nie awaitujemy: `dispose()` musi zostać synchroniczne (wołane z `onunload`).
            void this.flush();
        }
    }
}
