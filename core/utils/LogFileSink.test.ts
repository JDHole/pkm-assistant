import test from 'ava';
import { LogFileSink, formatLogLine, serializeArg, truncate } from './LogFileSink.js';

const fixedNow = () => new Date('2026-07-21T10:00:00.000Z');

/**
 * Mapa ścieżka→treść. Wartość `string | undefined`, bo testy sprawdzają wprost, że
 * pliku JESZCZE nie ma (`t.is(files['x.log'], undefined)`); stąd `!` przy odczytach,
 * które następują po sprawdzeniu obecności klucza.
 */
type FakeFiles = Record<string, string | undefined>;

type FakeAdapter = {
    files: FakeFiles;
    exists(p: string): Promise<boolean>;
    mkdir(): Promise<void>;
    read(p: string): Promise<string>;
    write(p: string, content: string): Promise<void>;
    stat(p: string): Promise<{ size: number } | undefined>;
    append?: (p: string, text: string) => Promise<void>;
};

/** In-memory fake vault adapter (path -> string). */
function fakeAdapter(initial: FakeFiles = {}): FakeAdapter {
    const files: FakeFiles = { ...initial };
    return {
        files,
        async exists(p) { return Object.prototype.hasOwnProperty.call(files, p); },
        async mkdir() { /* noop */ },
        async read(p) { if (!(p in files)) throw new Error('ENOENT: ' + p); return files[p]!; },
        async write(p, content) { files[p] = content; },
        async stat(p) { return p in files ? { size: files[p]!.length } : undefined; },
    };
}

// ─────────────────────────── formatLogLine / serializeArg / truncate ───────────────────────────

test('formatLogLine renders [ts] [LEVEL] [Tag] message', (t) => {
    const line = formatLogLine({ timestamp: '2026-07-21T10:00:00.000Z', level: 'info', tag: 'Plugin', message: 'ready' });
    t.is(line, '[2026-07-21T10:00:00.000Z] [INFO] [Plugin] ready');
});

test('formatLogLine serializes string/number/object args inline', (t) => {
    const line = formatLogLine({ timestamp: 'T', level: 'warn', tag: 'X', message: 'm', args: ['s', 3, { a: 1 }] });
    t.is(line, '[T] [WARN] [X] m s 3 {"a":1}');
});

test('formatLogLine tolerates missing tag and empty message', (t) => {
    const line = formatLogLine({ timestamp: 'T', level: 'error', message: '', args: ['only-arg'] });
    t.is(line, '[T] [ERROR] [?] only-arg');
});

test('serializeArg extracts Error name + message + first stack line', (t) => {
    const err = new Error('boom');
    const out = serializeArg(err);
    t.true(out.startsWith('Error: boom'));
    t.true(out.includes('|')); // stack first line appended
});

test('serializeArg falls back to String on circular JSON (never throws)', (t) => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const out = serializeArg(circ);
    t.is(typeof out, 'string');
});

test('truncate caps length and appends ellipsis', (t) => {
    const out = truncate('a'.repeat(600), 500);
    t.is(out.length, 501); // 500 + single ellipsis char
    t.true(out.endsWith('…'));
});

test('serializeArg truncates long strings to maxLen', (t) => {
    const out = serializeArg('x'.repeat(999), 500);
    t.is(out.length, 501);
});

// ─────────────────────────── buffer / flush ───────────────────────────

test('buffers writes and only touches disk on flush', async (t) => {
    const adapter = fakeAdapter();
    const sink = new LogFileSink({ adapter, path: 'logs/x.log', now: fixedNow });
    sink.write('info', 'Mod', 'hello', []);
    sink.write('warn', 'Mod', 'world', []);
    t.is(adapter.files['logs/x.log'], undefined); // still buffered
    await sink.flush();
    const content = adapter.files['logs/x.log']!;
    t.true(content.includes('hello'));
    t.true(content.includes('world'));
    t.is(content.split('\n').filter(Boolean).length, 2);
    sink.dispose();
});

test('auto-flushes once buffer reaches flushEveryN', async (t) => {
    const adapter = fakeAdapter();
    const sink = new LogFileSink({ adapter, path: 'l.log', flushEveryN: 3, now: fixedNow });
    sink.write('info', 'M', 'a');
    sink.write('info', 'M', 'b');
    t.is(adapter.files['l.log'], undefined); // 2 < 3, not yet
    sink.write('info', 'M', 'c'); // hits threshold → flush
    await sink.flush(); // await drained chain
    const content = adapter.files['l.log']!;
    t.is(content.split('\n').filter(Boolean).length, 3);
    sink.dispose();
});

test('uses adapter.append when available', async (t) => {
    const adapter = fakeAdapter();
    const appended: string[] = [];
    adapter.append = async (p, text) => { appended.push(text); adapter.files[p] = (adapter.files[p] || '') + text; };
    const sink = new LogFileSink({ adapter, path: 'a.log', now: fixedNow });
    sink.write('info', 'M', 'one');
    await sink.flush();
    t.is(appended.length, 1);
    t.true(adapter.files['a.log']!.includes('one'));
    sink.dispose();
});

test('read+write fallback appends when adapter has no append()', async (t) => {
    const adapter = fakeAdapter({ 'a.log': 'existing\n' });
    const sink = new LogFileSink({ adapter, path: 'a.log', now: fixedNow });
    sink.write('info', 'M', 'added');
    await sink.flush();
    t.true(adapter.files['a.log']!.startsWith('existing\n'));
    t.true(adapter.files['a.log']!.includes('added'));
    sink.dispose();
});

test('drops entries below configured level', async (t) => {
    const adapter = fakeAdapter();
    const sink = new LogFileSink({ adapter, path: 'lv.log', level: 'info', now: fixedNow });
    sink.write('debug', 'M', 'shh');   // below info → dropped
    sink.write('info', 'M', 'shown');
    await sink.flush();
    const content = adapter.files['lv.log'] || '';
    t.false(content.includes('shh'));
    t.true(content.includes('shown'));
    sink.dispose();
});

test('setLevel(debug) lets debug entries through', async (t) => {
    const adapter = fakeAdapter();
    const sink = new LogFileSink({ adapter, path: 'lv2.log', level: 'info', now: fixedNow });
    sink.setLevel('debug');
    sink.write('debug', 'M', 'now-visible');
    await sink.flush();
    t.true((adapter.files['lv2.log'] || '').includes('now-visible'));
    sink.dispose();
});

// ─────────────────────────── rotation ───────────────────────────

test('rotates oversized file to .old on init, starts fresh', async (t) => {
    const big = 'X'.repeat(50);
    const adapter = fakeAdapter({ 'logs/o.log': big });
    const sink = new LogFileSink({ adapter, path: 'logs/o.log', maxBytes: 10, now: fixedNow });
    await sink.init();
    t.is(adapter.files['logs/o.log.old'], big); // old content preserved
    t.is(adapter.files['logs/o.log'], '');      // fresh
    sink.dispose();
});

test('does not rotate when file is under maxBytes', async (t) => {
    const small = 'ok\n';
    const adapter = fakeAdapter({ 'logs/o.log': small });
    const sink = new LogFileSink({ adapter, path: 'logs/o.log', maxBytes: 1000, now: fixedNow });
    await sink.init();
    t.is(adapter.files['logs/o.log.old'], undefined);
    t.is(adapter.files['logs/o.log'], small);
    sink.dispose();
});

test('flush waits for init (rotation) before appending', async (t) => {
    const big = 'OLD'.repeat(20); // len 60 > maxBytes
    const adapter = fakeAdapter({ 'r.log': big });
    const sink = new LogFileSink({ adapter, path: 'r.log', maxBytes: 10, now: fixedNow });
    sink.init();                 // not awaited — rotation in flight
    sink.write('info', 'M', 'fresh-line');
    await sink.flush();
    // Rotation must have moved old content to .old BEFORE the new line landed.
    t.is(adapter.files['r.log.old'], big);
    t.true(adapter.files['r.log']!.includes('fresh-line'));
    t.false(adapter.files['r.log']!.includes('OLD'));
    sink.dispose();
});

test('write is a no-op without an adapter (node-safe)', (t) => {
    const sink = new LogFileSink({ adapter: null });
    t.notThrows(() => sink.write('info', 'M', 'nothing'));
    sink.dispose();
});

// ─────────────────────────── dispose: zamknięcie sinka (piny nocy 2026-08-14) ───────────────────────────
//
// Kontrast, od którego zaczęło się znalezisko: `TraceLog.dispose()` robi
// `await sink.flush()` PRZED `sink.dispose()` i jest wołany z `PKMPlugin.onunload`.
// Naprawa (2026-09-04): `LogFileSink.dispose()` sam zrzuca resztę bufora (fire-and-forget —
// `dispose()` musi zostać synchroniczne, bo `onunload` jest synchroniczne) i ustawia
// `_disposed`, więc kolejny `write()` po dispose jest no-opem — stara ścieżka nie ożywa.
// `Logger.disposeFileSink()` (wołane z `src/main.ts` `onunload`, patrz gotcha 6a w
// `core/CLAUDE.md`) dodatkowo awaituje `flush()` przed `dispose()`, tak jak `TraceLog`.

test('dispose() zrzuca bufor na dysk — linie sprzed unloadem nie giną', async (t) => {
    const adapter = fakeAdapter();
    const sink = new LogFileSink({ adapter, path: 'd.log', now: fixedNow });
    await sink.init();
    sink.write('error', 'Plugin', 'ostatnia linia przed unloadem');
    sink.dispose();               // dziś: clearTimeout i tyle — bufor na podłodze
    // Świadomie BEZ `await sink.flush()` — przy unloadzie nikt go nie woła. Okno niżej
    // daje szansę zapisowi, gdyby to `dispose()` sam go zaplanował (adapter jest w pamięci).
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.true(String(adapter.files['d.log'] ?? '').includes('ostatnia linia przed unloadem'));
});

test('po dispose() sink jest zamknięty — write nie wskrzesza starej ścieżki', async (t) => {
    const adapter = fakeAdapter();
    const sink = new LogFileSink({ adapter, path: 'z.log', now: fixedNow });
    await sink.init();
    sink.dispose();               // plugin wyładowany, katalog docelowy już skasowany
    sink.write('info', 'Plugin', '=== PKM Assistant START ===');
    await sink.flush();
    t.is(adapter.files['z.log'], undefined);
});
