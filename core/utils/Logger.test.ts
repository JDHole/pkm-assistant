/**
 * Logger — K20 (AUD-security-120/133): maska działa na KAŻDYM poziomie i w KAŻDEJ metodzie.
 *
 * Znalezisko 133 mówiło: `log.error(...)` wozi do pliku logu obiekty błędów, w których klucz
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

const SECRET = 'SEKRET12345ABCDEF';

test.serial('K20: obiekt z ZAESCAPOWANYM JSON-em w polu message nie wynosi klucza do pliku logu', t => {
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

test.serial('K20: Error z zaescapowanym JSON-em w message — plik logu czysty', t => {
    const lines = installFakeSink();
    try {
        captureConsole('error', () => log.error('X', 'boom', new Error(JSON.stringify({ message: JSON.stringify({ headers: { 'api-key': SECRET } }) }))));
        t.false(fileText(lines).includes(SECRET), fileText(lines));
    } finally { removeFakeSink(); }
});

test.serial('K20: Error z gołym JSON-em w message — plik logu czysty (regresja K8)', t => {
    const lines = installFakeSink();
    try {
        captureConsole('error', () => log.error('X', 'boom', new Error(JSON.stringify({ headers: { 'api-key': SECRET } }))));
        t.false(fileText(lines).includes(SECRET), fileText(lines));
    } finally { removeFakeSink(); }
});

test.serial('K20: debug i info też maskują (sink bierze je niezależnie od trybu debug)', t => {
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

test.serial('K20: sekret w `cause` błędu nie wychodzi na konsolę', t => {
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

test.serial('K20: sekret w polu dopiętym do błędu (`response`) nie wychodzi na konsolę', t => {
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

test.serial('K20: zwykły log nie jest kaleczony przez maskę', t => {
    const lines = installFakeSink();
    try {
        log.info('X', 'gotowe', { model: 'deepseek-chat', max_tokens: 16384 });
        const text = fileText(lines);
        t.true(text.includes('deepseek-chat'), text);
        t.true(text.includes('16384'), text);
    } finally { removeFakeSink(); }
});

/**
 * AUD-bledy-059 / AUD-bledy-038 — plikowy sink Loggera ma drzwi demontażu.
 *
 * `initFileSink()` (main.ts, start pluginu) tworzy prywatny `LogFileSink` na
 * `.pkm-assistant/logs/pkm-assistant.log`. Do naprawy jego `dispose()` wołał WYŁĄCZNIE sam
 * `initFileSink` przy ponownej inicjalizacji, a `onunload()` zamykał tylko sink trace'u.
 * Skutek: cały ślad demontażu siedział w buforze czekając na debounce (1000 ms) — przy
 * zamknięciu Obsidiana tuż po wyłączeniu pluginu ogon logu ginął bez ostrzeżenia, a budzik
 * flusha zostawał uzbrojony na martwym pluginie.
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

test.serial('AUD-bledy-059: disposeFileSink() wypycha ogon logu na dysk PRZED końcem demontażu', async t => {
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

test.serial('AUD-bledy-038: disposeFileSink() gasi sink — po demontażu nic już nie buforuje', async t => {
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

test.serial('AUD-bledy-059: disposeFileSink() bez sinka jest bezpieczne (fail-soft w onunload)', async t => {
    log.initFileSink({ enabled: false });
    await t.notThrowsAsync(() => log.disposeFileSink());
});
