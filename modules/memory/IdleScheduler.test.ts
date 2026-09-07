import test from 'ava';
import { IdleScheduler } from './IdleScheduler.js';

const MIN = 60 * 1000;

test('IdleScheduler: 0 minutes = off, never fires even when long idle', t => {
    const s = new IdleScheduler({ idleMinutes: 0, minNewEntries: 1 });
    t.false(s.shouldFire({ nowMs: 100 * MIN, lastActivityMs: 0, newEntries: 10 }));
});

test('IdleScheduler: does not fire during activity (idle time below threshold)', t => {
    const s = new IdleScheduler({ idleMinutes: 20, minNewEntries: 1 });
    // Only 5 minutes since last activity.
    t.false(s.shouldFire({ nowMs: 10 * MIN, lastActivityMs: 5 * MIN, newEntries: 5 }));
});

test('IdleScheduler: fires after idle threshold with enough new entries', t => {
    const s = new IdleScheduler({ idleMinutes: 20, minNewEntries: 2 });
    // 25 minutes idle, 3 new entries.
    t.true(s.shouldFire({ nowMs: 30 * MIN, lastActivityMs: 5 * MIN, newEntries: 3 }));
});

test('IdleScheduler: does not fire without enough new entries', t => {
    const s = new IdleScheduler({ idleMinutes: 20, minNewEntries: 2 });
    t.false(s.shouldFire({ nowMs: 30 * MIN, lastActivityMs: 5 * MIN, newEntries: 1 }));
});

test('IdleScheduler: does not fire when no activity has been recorded yet', t => {
    const s = new IdleScheduler({ idleMinutes: 20, minNewEntries: 1 });
    t.false(s.shouldFire({ nowMs: 30 * MIN, lastActivityMs: null, newEntries: 5 }));
});

test('IdleScheduler: fires exactly at the threshold boundary', t => {
    const s = new IdleScheduler({ idleMinutes: 20, minNewEntries: 1 });
    t.true(s.shouldFire({ nowMs: 20 * MIN, lastActivityMs: 0, newEntries: 1 }));
});

test('IdleScheduler: idleMinutes can be updated live (Settings change)', t => {
    const s = new IdleScheduler({ idleMinutes: 20, minNewEntries: 1 });
    // 10 min idle: with 20-min threshold it would not fire...
    t.false(s.shouldFire({ nowMs: 10 * MIN, lastActivityMs: 0, newEntries: 1 }));
    // ...but lowering the threshold to 5 makes the same snapshot fire.
    s.idleMinutes = 5;
    t.true(s.shouldFire({ nowMs: 10 * MIN, lastActivityMs: 0, newEntries: 1 }));
    // And setting it to 0 turns it off again.
    s.idleMinutes = 0;
    t.false(s.shouldFire({ nowMs: 10 * MIN, lastActivityMs: 0, newEntries: 1 }));
});
