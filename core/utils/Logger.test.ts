/**
 * Logger - maska działa na KAŻDYM poziomie i w KAŻDEJ metodzie.
 *
 * Chodziło o to, że `log.error(...)` wozi do pliku logu obiekty błędów, w których klucz
 * siedzi głębiej niż jedna stringifikacja. Maska widzi finalny string — ale gdy pole `message`
 * niosło już zestringifikowany JSON, nazwa nagłówka była zaescapowana (`\"api-key\":\"…\"`)
 * i żaden filtr nie trafiał. Tu pilnujemy CAŁEJ drogi: co dostaje sink plikowy po
 * `formatLogLine`, czyli dokładnie to, co ląduje w `.pkm-assistant/logs/pkm-assistant.log`.
 */
import test from 'ava';
import { log } from './Logger.js';
import { formatLogLine } from './LogFileSink.js';

type SinkLine = { level: string; module: string; message: string; args: unknown[] };

/** Uchwyt na prywatne pole singletonu — testy podstawiają własny sink zamiast pliku. */
type LoggerInternals = { _fileSink: unknown; _debug: boolean };

function installFakeSink(): SinkLine[] {
    const lines: SinkLine[] = [];
    (log as unknown as LoggerInternals)._fileSink = {
        accepts: () => true,
        write: (level: string, module: string, message: string, args: unknown[] = []) => {
            lines.push({ level, module, message, args });
        },
        dispose: () => { /* noop */ },
    };
    return lines;
}

function removeFakeSink(): void {
    (log as unknown as LoggerInternals)._fileSink = null;
}

/** Dokładnie te linie, które trafiłyby do pliku logu. */
function fileText(lines: SinkLine[]): string {
    return lines.map(l => formatLogLine({ level: l.level, tag: l.module, message: l.message, args: l.args })).join('\n');
}

/** To, co zobaczyłby user w konsoli dev-toolsów (obiekty rozwinięte do JSON-a). */
function consoleText(parts: unknown[]): string {
    return parts.map(p => {
        if (p instanceof Error) {
            const extras = Object.getOwnPropertyNames(p)
                .filter(k => k !== 'stack')
                .map(k => `${k}=${safeJson((p as unknown as Record<string, unknown>)[k])}`);
            return `${p.name}: ${p.message} ${p.stack ?? ''} ${extras.join(' ')} cause=${safeJson((p as { cause?: unknown }).cause)}`;
        }
        return safeJson(p);
    }).join(' ');
}

function safeJson(v: unknown): string {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/** Przechwytuje konsolę na czas jednego wywołania. */
function captureConsole(method: 'log' | 'warn' | 'error', fn: () => void): unknown[][] {
    const calls: unknown[][] = [];
    const original = console[method];
    console[method] = ((...args: unknown[]) => { calls.push(args); }) as typeof original;
    try { fn(); } finally { console[method] = original; }
    return calls;
}

/** Liczniki wywołań per metoda - pod test kontraktu „tylko console.debug, zero groupCollapsed/groupEnd/table". */
type ConsoleCallCounts = { debug: number; warn: number; error: number; groupCollapsed: number; groupEnd: number; table: number };

/** Podmienia WSZYSTKIE sześć metod na liczniki wywołań (nie treść) na czas `fn()`. */
function captureConsoleCounts(fn: () => void): ConsoleCallCounts {
    const counts: ConsoleCallCounts = { debug: 0, warn: 0, error: 0, groupCollapsed: 0, groupEnd: 0, table: 0 };
    const keys = Object.keys(counts) as Array<keyof ConsoleCallCounts>;
    const originals = {} as Record<keyof ConsoleCallCounts, typeof console.log>;
    for (const k of keys) {
        originals[k] = console[k];
        console[k] = (() => { counts[k] += 1; }) as typeof console.log;
    }
    try { fn(); } finally {
        for (const k of keys) console[k] = originals[k];
    }
    return counts;
}

const SECRET = 'SEKRET12345ABCDEF';

/**
 * Walidator katalogu Obsidiana dopuszcza WYŁĄCZNIE `console.warn/error/debug` (nie uznaje
 * per-plikowego override'u w `eslint.obsidian.config.js`) - `tool()`/`group()` kiedyś
 * otwierały grupę przez `console.groupCollapsed()`, dziś logują płasko przez `console.debug`.
 */
test.serial('tool()/group() w trybie debug wołają WYŁĄCZNIE console.debug - zero groupCollapsed/groupEnd/table', t => {
    const internals = log as unknown as LoggerInternals;
    const wasDebug = internals._debug;
    internals._debug = true;
    try {
        const counts = captureConsoleCounts(() => {
            log.tool('fake_tool', { a: 1 }, { b: 2 });
            log.group('Mod', 'label');
        });
        t.is(counts.groupCollapsed, 0, 'console.groupCollapsed nie jest na białej liście walidatora');
        t.is(counts.groupEnd, 0, 'group() już nie otwiera grupy konsoli - nie ma czego zamykać');
        t.is(counts.table, 0, 'metoda table() jest skasowana - nikt jej nie woła');
        t.is(counts.warn, 0);
        t.is(counts.error, 0);
        // tool(): nagłówek + „Args:" + „Result:" = 3 console.debug; group(): 1 console.debug.
        t.is(counts.debug, 4, 'tool() = 3 console.debug, group() = 1 console.debug, razem 4');
    } finally { internals._debug = wasDebug; }
});

test.serial('groupEnd() jest udokumentowanym no-opem - nie woła ŻADNEJ metody console', t => {
    const internals = log as unknown as LoggerInternals;
    const wasDebug = internals._debug;
    internals._debug = true;
    try {
        const counts = captureConsoleCounts(() => { log.groupEnd(); });
        t.deepEqual(counts, { debug: 0, warn: 0, error: 0, groupCollapsed: 0, groupEnd: 0, table: 0 });
    } finally { internals._debug = wasDebug; }
});

test.serial('Obiekt z ZAESCAPOWANYM JSON-em w polu message nie wynosi klucza do pliku logu', t => {
    const lines = installFakeSink();
    try {
        // Dokładnie kształt, jaki produkował `normalize_error` po padzie strumienia:
        // pole `message` niesie CAŁE zdarzenie jako tekst.
        captureConsole('error', () => log.error('ChatAdapter', 'Stream error:', {
            message: JSON.stringify({ source: { headers: { 'api-key': SECRET } } }),
            http_status: 0,
        }));
        const text = fileText(lines);
        t.false(text.includes(SECRET), text);
        t.true(text.includes('api-key'), 'nazwa pola zostaje — diagnostyka ma działać');
    } finally { removeFakeSink(); }
});

test.serial('Error z zaescapowanym JSON-em w message - plik logu czysty', t => {
    const lines = installFakeSink();
    try {
        captureConsole('error', () => log.error('X', 'boom', new Error(JSON.stringify({ message: JSON.stringify({ headers: { 'api-key': SECRET } }) }))));
        t.false(fileText(lines).includes(SECRET), fileText(lines));
    } finally { removeFakeSink(); }
});

test.serial('Error z gołym JSON-em w message - plik logu czysty', t => {
    const lines = installFakeSink();
    try {
        captureConsole('error', () => log.error('X', 'boom', new Error(JSON.stringify({ headers: { 'api-key': SECRET } }))));
        t.false(fileText(lines).includes(SECRET), fileText(lines));
    } finally { removeFakeSink(); }
});

test.serial('Debug i info też maskują (sink bierze je niezależnie od trybu debug)', t => {
    const lines = installFakeSink();
    try {
        const payload = { message: JSON.stringify({ headers: { Authorization: `Bearer ${SECRET}` } }) };
        log.debug('X', 'a', payload);
        log.info('X', 'b', payload);
        captureConsole('warn', () => log.warn('X', 'c', payload));
        t.is(lines.length, 3, 'debug + info + warn = trzy linie w pliku');
        t.false(fileText(lines).includes(SECRET), fileText(lines));
    } finally { removeFakeSink(); }
});

test.serial('Sekret w `cause` błędu nie wychodzi na konsolę', t => {
    const internals = log as unknown as LoggerInternals;
    const wasDebug = internals._debug;
    internals._debug = true;
    try {
        const err = new Error('boom', { cause: { headers: { 'api-key': SECRET } } });
        const calls = captureConsole('error', () => log.error('X', 'padło', err));
        const text = calls.map(consoleText).join('\n');
        t.false(text.includes(SECRET), text);
        // …ale kontekst NIE znika — dawniej klon `Error` gubił `cause` w całości.
        t.true(text.includes('api-key'), text);
    } finally { internals._debug = wasDebug; }
});

test.serial('Sekret w polu dopiętym do błędu (`response`) nie wychodzi na konsolę', t => {
    const internals = log as unknown as LoggerInternals;
    const wasDebug = internals._debug;
    internals._debug = true;
    try {
        const err = new Error('boom') as Error & { response?: unknown };
        err.response = { headers: { 'api-key': SECRET }, status: 401 };
        const calls = captureConsole('error', () => log.error('X', 'padło', err));
        const text = calls.map(consoleText).join('\n');
        t.false(text.includes(SECRET), text);
        t.true(text.includes('401'), `kontekst błędu ma zostać (zamaskowany): ${text}`);
    } finally { internals._debug = wasDebug; }
});

test.serial('Zwykły log nie jest kaleczony przez maskę', t => {
    const lines = installFakeSink();
    try {
        log.info('X', 'gotowe', { model: 'deepseek-chat', max_tokens: 16384 });
        const text = fileText(lines);
        t.true(text.includes('deepseek-chat'), text);
        t.true(text.includes('16384'), text);
    } finally { removeFakeSink(); }
});

/**
 * Plikowy sink Loggera ma drzwi demontażu.
 *
 * `initFileSink()` (main.ts, start pluginu) tworzy prywatny `LogFileSink` na
 * `.pkm-assistant/logs/pkm-assistant.log`. Bez wywołania `dispose()` przy demontażu pluginu
 * ślad demontażu siedziałby w buforze czekając na debounce (1000 ms) — przy zamknięciu
 * Obsidiana tuż po wyłączeniu pluginu ogon logu ginąłby bez ostrzeżenia, a budzik flusha
 * zostawałby uzbrojony na martwym pluginie.
 */
type SinkFiles = Record<string, string | undefined>;

type SinkAdapter = {
    files: SinkFiles;
    exists(p: string): Promise<boolean>;
    mkdir(): Promise<void>;
    read(p: string): Promise<string>;
    write(p: string, content: string): Promise<void>;
    stat(p: string): Promise<{ size: number } | undefined>;
};

function sinkAdapter(): SinkAdapter {
    const files: SinkFiles = {};
    return {
        files,
        async exists(p: string) { return Object.prototype.hasOwnProperty.call(files, p); },
        async mkdir() { /* noop */ },
        async read(p: string) { if (!(p in files)) throw new Error('ENOENT: ' + p); return files[p]!; },
        async write(p: string, content: string) { files[p] = content; },
        async stat(p: string) { return p in files ? { size: files[p]!.length } : undefined; },
    };
}

const SINK_PATH = '.pkm-assistant/logs/pkm-assistant.log';

test.serial('disposeFileSink() wypycha ogon logu na dysk PRZED końcem demontażu', async t => {
    const adapter = sinkAdapter();
    try {
        log.initFileSink({ adapter, enabled: true, level: 'info' });
        log.info('Main', 'Unloading PKM Assistant plugin');

        t.is(adapter.files[SINK_PATH], undefined, 'przed flushem linia siedzi w buforze (debounce 1000 ms)');

        await log.disposeFileSink();

        t.true(String(adapter.files[SINK_PATH] || '').includes('Unloading PKM Assistant plugin'),
            'ostatnia linia sesji ląduje w pliku, nie ginie razem z procesem');
    } finally {
        log.initFileSink({ enabled: false });
    }
});

test.serial('disposeFileSink() gasi sink - po demontażu nic już nie buforuje', async t => {
    const adapter = sinkAdapter();
    try {
        log.initFileSink({ adapter, enabled: true, level: 'info' });
        await log.disposeFileSink();

        t.false(log.fileSinkActive, 'sink zgaszony, budzik flusha zdjęty');

        log.info('Main', 'linia po demontażu');
        await log.disposeFileSink();

        t.false(String(adapter.files[SINK_PATH] || '').includes('linia po demontażu'),
            'martwy plugin nie dopisuje się do logu vaulta');
    } finally {
        log.initFileSink({ enabled: false });
    }
});

test.serial('disposeFileSink() bez sinka jest bezpieczne (fail-soft w onunload)', async t => {
    log.initFileSink({ enabled: false });
    await t.notThrowsAsync(() => log.disposeFileSink());
});
