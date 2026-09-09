/**
 * streamHelper.test.js - opcje `streamToComplete` (onChunk / signal / watchdog).
 *
 * Atrapy modelu wg tego samego kontraktu, co reszta testów pamięci
 * (`ArchiveWorkflow.test.js`, `modules/web/summarize.test.js`): `.stream({messages},
 * {chunk, done, error})`, gdzie `done` dostaje kształt OpenAI. Nic poza modelem nie jest
 * podmieniane - cała logika helpera jest prawdziwa.
 */
import test from 'ava';
import { streamToComplete, STREAM_ERROR_CODES } from './streamHelper.js';
import type {
    StreamChatModelLike,
    StreamError,
    StreamHandlers,
    StreamMessage,
} from './streamHelper.js';

/** Timer fake'owego zegara. */
interface FakeTimer { fn: () => void; due: number }

/**
 * Fake zegar + scheduler (ten sam wzorzec co core/utils/StreamWatchdog.test.ts):
 * advance(ms) przesuwa czas i odpala timery, których termin minął.
 */
function fakeClock() {
    let nowMs = 0;
    let nextId = 1;
    const timers = new Map<number, FakeTimer>();
    return {
        now: () => nowMs,
        setTimeoutFn: (fn: () => void, ms: number) => {
            const id = nextId++;
            timers.set(id, { fn, due: nowMs + ms });
            return id;
        },
        clearTimeoutFn: (id: unknown) => { timers.delete(id as number); },
        advance(ms: number) {
            const target = nowMs + ms;
            for (;;) {
                let dueId: number | null = null;
                let dueTimer: FakeTimer | null = null;
                for (const [id, tm] of timers) {
                    if (tm.due <= target && (!dueTimer || tm.due < dueTimer.due)) {
                        dueId = id;
                        dueTimer = tm;
                    }
                }
                if (!dueTimer) break;
                nowMs = (dueTimer as FakeTimer).due;
                timers.delete(dueId as number);
                (dueTimer as FakeTimer).fn();
            }
            nowMs = target;
        },
    };
}

/** Model oddający `reply` w done(); zapamiętuje request. */
function fakeModel(reply: string, usage: Record<string, number> | null = null) {
    const calls: Array<{ messages: StreamMessage[] }> = [];
    return {
        calls,
        stream(req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            calls.push(req);
            setTimeout(() => handlers.done({
                choices: [{ message: { content: reply } }],
                ...(usage ? { usage } : {})
            }), 0);
        },
    };
}

/** Model emitujący chunki (treść SKUMULOWANA, jak prawdziwy adapter) i kończący done(). */
function chunkingModel(pieces: string[]): StreamChatModelLike {
    return {
        stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            let acc = '';
            let i = 0;
            const tick = () => {
                if (i < pieces.length) {
                    acc += pieces[i++];
                    handlers.chunk({ choices: [{ message: { content: acc } }] });
                    setTimeout(tick, 0);
                    return;
                }
                handlers.done({ choices: [{ message: { content: acc } }] });
            };
            setTimeout(tick, 0);
        },
    };
}

/** Model, który przyjmuje request i milczy - nigdy nie woła done/chunk/error. */
function silentModel() {
    const state = { stopped: 0 };
    return {
        state,
        stream(_req: { messages: StreamMessage[] }, _handlers: StreamHandlers) { /* cisza jak zdechły lokalny most */ },
        stopStream() { state.stopped++; },
    };
}

// ── Ścieżka bez options: zero regresji ──

test('bez options działa jak dotąd — zwraca { text, usage }', async t => {
    const model = fakeModel('gotowe', { prompt_tokens: 10, completion_tokens: 3 });
    const res = await streamToComplete(model, [{ role: 'user', content: 'hej' }]);
    t.is(res.text, 'gotowe');
    t.deepEqual(res.usage, { prompt_tokens: 10, completion_tokens: 3 });
    t.is(model.calls.length, 1);
    t.deepEqual(model.calls[0].messages, [{ role: 'user', content: 'hej' }]);
});

test('bez options błąd modelu odrzuca Promise (bez kodu)', async t => {
    const model: StreamChatModelLike = {
        stream(_req, handlers) { setTimeout(() => handlers.error(new Error('LLM down')), 0); }
    };
    const err = await t.throwsAsync<StreamError>(() => streamToComplete(model, []));
    t.is(err.message, 'LLM down');
    t.is(err.code, undefined);
});

test('usage null gdy model go nie zwrócił', async t => {
    const res = await streamToComplete(fakeModel('bez usage'), []);
    t.is(res.usage, null);
});

// ── onChunk ──

test('onChunk dostaje DELTY (chunk niesie treść skumulowaną)', async t => {
    const deltas: string[] = [];
    const res = await streamToComplete(chunkingModel(['Ala ', 'ma ', 'kota']), [], {
        onChunk: (delta) => deltas.push(delta),
    });
    t.deepEqual(deltas, ['Ala ', 'ma ', 'kota']);
    t.is(res.text, 'Ala ma kota');
});

test('wyjątek w onChunk nie wywala streamu', async t => {
    const res = await streamToComplete(chunkingModel(['a', 'b']), [], {
        onChunk: () => { throw new Error('UI padło'); },
    });
    t.is(res.text, 'ab');
});

// ── watchdog ──

test('cisza dłuższa niż timeout → onStall + reject stream_stalled + stopStream', async t => {
    const clock = fakeClock();
    const model = silentModel();
    const stalls: number[] = [];

    const promise = streamToComplete(model, [], {
        watchdog: {
            timeoutMs: 120,
            onStall: (silentMs) => stalls.push(silentMs),
            setTimeoutFn: clock.setTimeoutFn,
            clearTimeoutFn: clock.clearTimeoutFn,
            now: clock.now,
        },
    });

    clock.advance(119);
    t.is(stalls.length, 0, 'przed timeoutem cicho');
    clock.advance(2);

    const err = await t.throwsAsync<StreamError>(promise);
    t.is(err.code, STREAM_ERROR_CODES.STALLED);
    t.is(err.silentMs, 120);
    t.deepEqual(stalls, [120]);
    t.is(model.state.stopped, 1, 'stream przerwany tą samą drogą co Stop w czacie');
});

test('chunki karmią watchdoga — żywy stream nie jest przerywany', async t => {
    const clock = fakeClock();
    let stalled = false;
    // Model, który oddaje chunk PO 100ms fake-czasu, potem kończy.
    const model: StreamChatModelLike = {
        stream(_req, handlers) {
            clock.setTimeoutFn(() => {
                handlers.chunk({ choices: [{ message: { content: 'ping' } }] });
                clock.setTimeoutFn(() => handlers.done({ choices: [{ message: { content: 'ping pong' } }] }), 100);
            }, 100);
        },
    };

    const promise = streamToComplete(model, [], {
        watchdog: {
            timeoutMs: 120,
            onStall: () => { stalled = true; },
            setTimeoutFn: clock.setTimeoutFn,
            clearTimeoutFn: clock.clearTimeoutFn,
            now: clock.now,
        },
    });
    clock.advance(250); // 2× po 100ms - nigdy 120ms ciszy pod rząd

    const res = await promise;
    t.false(stalled);
    t.is(res.text, 'ping pong');
});

test('timeoutMs = 0 wyłącza watchdoga (cisza nie przerywa)', async t => {
    const clock = fakeClock();
    const model = fakeModel('ok');
    const res = await streamToComplete(model, [], {
        watchdog: {
            timeoutMs: 0,
            onStall: () => t.fail('watchdog wyłączony nie może strzelić'),
            setTimeoutFn: clock.setTimeoutFn,
            clearTimeoutFn: clock.clearTimeoutFn,
            now: clock.now,
        },
    });
    clock.advance(999999);
    t.is(res.text, 'ok');
});

test('watchdog rozbrojony po done — nie strzela po zakończeniu', async t => {
    const clock = fakeClock();
    let stalled = false;
    const res = await streamToComplete(fakeModel('koniec'), [], {
        watchdog: {
            timeoutMs: 50,
            onStall: () => { stalled = true; },
            setTimeoutFn: clock.setTimeoutFn,
            clearTimeoutFn: clock.clearTimeoutFn,
            now: clock.now,
        },
    });
    t.is(res.text, 'koniec');
    clock.advance(10000);
    t.false(stalled);
});

test('błąd modelu po stallu nie nadpisuje kodu stream_stalled', async t => {
    const clock = fakeClock();
    let errorHandler: ((err: unknown) => void) | null = null;
    const model: StreamChatModelLike = {
        stream(_req, handlers) { errorHandler = handlers.error; },
        stopStream() {},
    };
    const promise = streamToComplete(model, [], {
        watchdog: {
            timeoutMs: 10,
            setTimeoutFn: clock.setTimeoutFn,
            clearTimeoutFn: clock.clearTimeoutFn,
            now: clock.now,
        },
    });
    clock.advance(20);
    errorHandler!(new Error('spóźniony błąd adaptera'));

    const err = await t.throwsAsync<StreamError>(promise);
    t.is(err.code, STREAM_ERROR_CODES.STALLED);
});

// ── signal (AbortSignal) ──

test('abort w trakcie streamu → reject aborted + stopStream', async t => {
    const controller = new AbortController();
    const model = silentModel();
    const promise = streamToComplete(model, [], { signal: controller.signal });

    controller.abort();
    const err = await t.throwsAsync<StreamError>(promise);
    t.is(err.code, STREAM_ERROR_CODES.ABORTED);
    t.is(model.state.stopped, 1);
});

test('signal już przerwany → reject bez odpalania modelu (zero spalonych tokenów)', async t => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const model: StreamChatModelLike = { stream() { called = true; } };

    const err = await t.throwsAsync<StreamError>(() => streamToComplete(model, [], { signal: controller.signal }));
    t.is(err.code, STREAM_ERROR_CODES.ABORTED);
    t.false(called);
});

test('abort po zakończeniu nie zmienia wyniku', async t => {
    const controller = new AbortController();
    const res = await streamToComplete(fakeModel('zdążyło'), [], { signal: controller.signal });
    controller.abort();
    t.is(res.text, 'zdążyło');
});

// ── odmowa Promise z adaptera bez handlers.error ──

test('odrzucona Promise z .stream() (bez handlers.error) też odrzuca wynik', async t => {
    const model: StreamChatModelLike = {
        stream() { return Promise.reject(new Error('429 po retry')); }
    };
    const err = await t.throwsAsync<StreamError>(() => streamToComplete(model, []));
    t.is(err.message, '429 po retry');
});

test('synchroniczny wybuch .stream() odrzuca Promise', async t => {
    const model: StreamChatModelLike = { stream() { throw new Error('brak adaptera'); } };
    const err = await t.throwsAsync<StreamError>(() => streamToComplete(model, []));
    t.is(err.message, 'brak adaptera');
});
