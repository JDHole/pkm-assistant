import test from 'ava';
import { __test__ } from './DelegateTool.js';
import type { QuestionId } from '../sub-agents/index.js';

test.serial('czekanie nie zużywa pozostałego budżetu zadania', async t => {
    let now = 0;
    let nextId = 0;
    const timers = new Map<number, { due: number; fn: () => void }>();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
        const id = ++nextId;
        timers.set(id, { due: now + ms, fn });
        return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
    t.teardown(() => {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
    });
    const advance = (ms: number) => {
        now += ms;
        for (const [id, timer] of timers) {
            if (timer.due <= now) { timers.delete(id); timer.fn(); }
        }
    };
    const arm = __test__._makeGateArm();
    let timedOut = false;
    const run = __test__._withTimeout(new Promise<never>(() => {}), 1000, 1000, () => { timedOut = true; }, null, arm);
    arm.signal();
    advance(400);
    arm.activity({ kind: 'waiting', questionId: 'q1' as QuestionId });
    advance(10000);
    t.false(timedOut);
    arm.activity({ kind: 'working' });
    t.deepEqual([...timers.values()].map(timer => timer.due - now), [600]);
    advance(599);
    t.false(timedOut);
    advance(1);
    t.deepEqual(await run, { success: false, error: 'Sub-agent timeout after 1000ms' });
    t.true(timedOut);
    t.is(timers.size, 0);
});
