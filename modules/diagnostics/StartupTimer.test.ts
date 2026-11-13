import test from 'ava';
import { StartupTimer } from './index.js';

test('startup phases use sequential clock boundaries and sum to the total', t => {
    let now = 100;
    const timer = new StartupTimer(() => now);
    now = 1100; timer.mark('layoutWaitMs');
    now = 1120; timer.mark('runtimeMs');
    now = 1150; timer.mark('secretsMs');
    now = 1190; timer.mark('skinMs');
    now = 1240; timer.mark('agentsMs');
    now = 1300; timer.mark('toolsMs');
    now = 1334; timer.mark('finishMs');
    t.deepEqual(timer.snapshot(), {
        layoutWaitMs: 1000, runtimeMs: 20, secretsMs: 30, skinMs: 40,
        agentsMs: 50, toolsMs: 60, finishMs: 34,
    });
    t.is(Object.values(timer.snapshot()).reduce((sum, ms) => sum + ms, 0), 1234);
});

test('unmarked phases stay absent and the next mark includes the gap', t => {
    let now = 10;
    const timer = new StartupTimer(() => now);
    now = 40; timer.mark('layoutWaitMs');
    now = 90; timer.mark('secretsMs');
    t.deepEqual(timer.snapshot(), { layoutWaitMs: 30, secretsMs: 50 });
    t.is(timer.snapshot().runtimeMs, undefined);
    t.is(timer.snapshot().finishMs, undefined);
});

test('duplicate marks preserve both the first duration and the next boundary', t => {
    let now = 10;
    const timer = new StartupTimer(() => now);
    now = 40; timer.mark('layoutWaitMs');
    now = 70; timer.mark('layoutWaitMs');
    now = 90; timer.mark('runtimeMs');
    t.deepEqual(timer.snapshot(), { layoutWaitMs: 30, runtimeMs: 50 });
});

test('durations round to milliseconds and never go negative', t => {
    let now = 10;
    const timer = new StartupTimer(() => now);
    now = 12.6; timer.mark('layoutWaitMs');
    now = 14.8; timer.mark('runtimeMs');
    now = 14; timer.mark('secretsMs');
    t.deepEqual(timer.snapshot(), { layoutWaitMs: 3, runtimeMs: 2, secretsMs: 0 });
});

test('explicit endpoints share the total clock sample and snapshots cannot mutate the timer', t => {
    const timer = new StartupTimer(() => 999, 100);
    timer.mark('layoutWaitMs', 150);
    const snapshot = timer.snapshot();
    snapshot.layoutWaitMs = 9999;
    timer.mark('finishMs', 210);
    t.deepEqual(timer.snapshot(), { layoutWaitMs: 50, finishMs: 60 });
});
