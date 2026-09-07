import test from 'ava';
import { TraceLog } from './TraceLog.js';

/** Kształt fake'owego sinka — `disposed` to znacznik dla asercji, nie część kontraktu. */
type FakeSink = {
    lines: { level: string; tag: string; message: string }[];
    write(level: string, tag: string, message: string): void;
    flush(): Promise<void>;
    dispose(): void;
    disposed?: boolean;
};

// Fake sink zbierający zapisane linie (kontrakt LogFileSink: write/flush/dispose).
function makeFakeSink(): FakeSink {
    const lines: FakeSink['lines'] = [];
    return {
        lines,
        write(level, tag, message) { lines.push({ level, tag, message }); },
        flush() { return Promise.resolve(); },
        dispose() { this.disposed = true; },
    };
}

test('scope() zapisuje jedną sformatowaną linię (label | type | k=v ...)', t => {
    const sink = makeFakeSink();
    const trace = new TraceLog({ sink }).scope('chat/Klara#ab12');

    trace('tool.pre', { i: 0, tool: 'search', args: '{}' });

    t.is(sink.lines.length, 1);
    t.is(sink.lines[0].level, 'info');
    t.is(sink.lines[0].tag, 'trace');
    t.is(sink.lines[0].message, 'chat/Klara#ab12 | tool.pre | i=0 tool=search args={}');
});

test('linia bez pól = label | type (bez wiszącego separatora)', t => {
    const sink = makeFakeSink();
    new TraceLog({ sink }).scope('sub/prep-memory')('backstop');
    t.is(sink.lines[0].message, 'sub/prep-memory | backstop');
});

test('długi arg stringowy przycięty do 200 znaków (z wielokropkiem)', t => {
    const sink = makeFakeSink();
    const trace = new TraceLog({ sink }).scope('x');

    trace('e', { v: 'a'.repeat(500) });

    const val = sink.lines[0].message.split('v=')[1];
    t.is(val.length, 201, '200 znaków + wielokropek');
    t.true(val.endsWith('…'));
});

test('obiekt jako wartość pola jest serializowany do JSON', t => {
    const sink = makeFakeSink();
    new TraceLog({ sink }).scope('x')('e', { args: { path: 'a.md' } });
    t.is(sink.lines[0].message, 'x | e | args={"path":"a.md"}');
});

test('no-op gdy enabled=false (active=false, zero zapisów)', t => {
    const sink = makeFakeSink();
    const tl = new TraceLog({ sink, enabled: false });

    t.false(tl.active);
    tl.scope('x')('e', { a: 1 });
    t.is(sink.lines.length, 0);
});

test('no-op i brak wyjątku gdy sink=null', t => {
    const tl = new TraceLog({ sink: null });
    t.false(tl.active);
    t.notThrows(() => tl.scope('x')('e', { a: 1 }));
});

test('fail-soft: sink rzucający w write() nie wywala trace', t => {
    const sink = {
        write() { throw new Error('boom'); },
        flush: () => Promise.resolve(),
        dispose() {},
    };
    const trace = new TraceLog({ sink }).scope('x');
    t.notThrows(() => trace('e', { a: 1 }));
});

test('mask wołany na zbudowanej linii, wynik trafia do sinka', t => {
    const sink = makeFakeSink();
    const seen: string[] = [];
    const mask = (line: string) => { seen.push(line); return line.replace('sk-secret', '***'); };
    const trace = new TraceLog({ sink, mask }).scope('x');

    trace('model.done', { key: 'sk-secret' });

    t.is(seen.length, 1);
    t.is(seen[0], 'x | model.done | key=sk-secret', 'mask dostaje surową linię');
    t.is(sink.lines[0].message, 'x | model.done | key=***', 'zamaskowana linia zapisana');
});

test('dispose() flushuje i sprząta sink (fail-soft)', async t => {
    let flushed = false;
    let disposed = false;
    const sink = {
        write() {},
        flush() { flushed = true; return Promise.resolve(); },
        dispose() { disposed = true; },
    };
    await new TraceLog({ sink }).dispose();
    t.true(flushed);
    t.true(disposed);
});

test('dispose() nie rzuca gdy sink=null', async t => {
    await t.notThrowsAsync(() => new TraceLog({ sink: null }).dispose());
});
