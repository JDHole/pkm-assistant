import test from 'ava';
import { StreamWatchdog } from './StreamWatchdog.js';

/**
 * Fake zegar + scheduler: advance(ms) przesuwa czas i wykonuje timery, których termin
 * minął (w kolejności terminów). Wstrzykiwany do StreamWatchdog zamiast setTimeout.
 */
/** Wpis fake'owego schedulera. */
type FakeTimer = { fn: () => void; due: number };

function fakeClock() {
    let nowMs = 0;
    let nextId = 1;
    const timers = new Map<number, FakeTimer>(); // id -> { fn, due }
    return {
        now: () => nowMs,
        setTimeoutFn: (fn: () => void, ms: number) => {
            const id = nextId++;
            timers.set(id, { fn, due: nowMs + ms });
            return id;
        },
        // `id: unknown` (a nie `number`) świadomie: `StreamWatchdog` traktuje uchwyt timera
        // jako nieprzezroczysty, a pod `strictFunctionTypes` węższy parametr by nie pasował.
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
                nowMs = dueTimer.due;
                timers.delete(dueId!);
                dueTimer.fn();
            }
            nowMs = target;
        },
    };
}

function makeWatchdog(timeoutMs: number, clock: ReturnType<typeof fakeClock>) {
    const calls: number[] = [];
    const wd = new StreamWatchdog({
        timeoutMs,
        onStall: (silentMs) => calls.push(silentMs),
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        now: clock.now,
    });
    return { wd, calls };
}

test('nie strzela przed timeoutem, strzela po timeoucie z czasem ciszy', t => {
    const clock = fakeClock();
    const { wd, calls } = makeWatchdog(120, clock);
    wd.arm();
    clock.advance(119);
    t.is(calls.length, 0);
    clock.advance(2);
    t.is(calls.length, 1);
    t.is(calls[0], 120);
});

test('feed (chunk) resetuje odliczanie — cisza liczona od ostatniego chunka', t => {
    const clock = fakeClock();
    const { wd, calls } = makeWatchdog(120, clock);
    wd.arm();
    clock.advance(80);
    wd.feed();
    clock.advance(80); // łącznie 160 od arm, ale tylko 80 od feed
    t.is(calls.length, 0);
    clock.advance(50); // 130 od feed → strzela
    t.is(calls.length, 1);
});

test('disarm wyłącza odliczanie', t => {
    const clock = fakeClock();
    const { wd, calls } = makeWatchdog(120, clock);
    wd.arm();
    t.true(wd.isArmed);
    wd.disarm();
    t.false(wd.isArmed);
    clock.advance(10000);
    t.is(calls.length, 0);
});

test('timeoutMs <= 0 = watchdog wyłączony (arm to no-op)', t => {
    const clock = fakeClock();
    const { wd, calls } = makeWatchdog(0, clock);
    wd.arm();
    t.false(wd.isArmed);
    clock.advance(999999);
    t.is(calls.length, 0);
});

test('feed bez arm to no-op (nie zbroi watchdoga)', t => {
    const clock = fakeClock();
    const { wd, calls } = makeWatchdog(120, clock);
    wd.feed();
    t.false(wd.isArmed);
    clock.advance(10000);
    t.is(calls.length, 0);
});

test('ponowny arm resetuje odliczanie (nowa iteracja modelu)', t => {
    const clock = fakeClock();
    const { wd, calls } = makeWatchdog(120, clock);
    wd.arm();
    clock.advance(100);
    wd.arm(); // nowa iteracja — licznik od zera
    clock.advance(100);
    t.is(calls.length, 0);
    clock.advance(30);
    t.is(calls.length, 1);
});

test('strzela raz i sam się rozbraja — bez ponownego arm nie strzeli drugi raz', t => {
    const clock = fakeClock();
    const { wd, calls } = makeWatchdog(120, clock);
    wd.arm();
    clock.advance(130);
    t.is(calls.length, 1);
    t.false(wd.isArmed);
    clock.advance(10000);
    t.is(calls.length, 1);
});

test('disarm jest idempotentny', t => {
    const clock = fakeClock();
    const { wd } = makeWatchdog(120, clock);
    wd.disarm();
    wd.arm();
    wd.disarm();
    wd.disarm();
    t.false(wd.isArmed);
    t.pass();
});
