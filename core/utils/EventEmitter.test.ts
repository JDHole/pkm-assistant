import test from 'ava';
import { EventEmitter } from './EventEmitter.js';

test('on + emit triggers handler with payload', t => {
    const ee = new EventEmitter();
    let captured;
    ee.on('hello', payload => { captured = payload; });
    ee.emit('hello', { msg: 'world' });
    t.deepEqual(captured, { msg: 'world' });
});

test('off via returned unsubscriber stops handler', t => {
    const ee = new EventEmitter();
    let count = 0;
    const off = ee.on('tick', () => { count++; });
    ee.emit('tick');
    off();
    ee.emit('tick');
    t.is(count, 1);
});

test('once: handler fires exactly one time', t => {
    const ee = new EventEmitter();
    let count = 0;
    ee.once('boom', () => { count++; });
    ee.emit('boom');
    ee.emit('boom');
    ee.emit('boom');
    t.is(count, 1);
});

test('multiple handlers all fire on emit', t => {
    const ee = new EventEmitter();
    const log: string[] = [];
    ee.on('x', () => log.push('a'));
    ee.on('x', () => log.push('b'));
    ee.on('x', () => log.push('c'));
    ee.emit('x');
    t.deepEqual(log.sort(), ['a', 'b', 'c']);
});

test('handler throw does not break other handlers', t => {
    const ee = new EventEmitter();
    let okFired = false;
    ee.on('e', () => { throw new Error('boom'); });
    ee.on('e', () => { okFired = true; });
    ee.emit('e');
    t.true(okFired);
});

test('emit without listeners is a no-op', t => {
    const ee = new EventEmitter();
    t.notThrows(() => ee.emit('nobody', { x: 1 }));
});

test('listenerCount reflects state', t => {
    const ee = new EventEmitter();
    t.is(ee.listenerCount('a'), 0);
    const off = ee.on('a', () => {});
    t.is(ee.listenerCount('a'), 1);
    ee.on('a', () => {});
    t.is(ee.listenerCount('a'), 2);
    off();
    t.is(ee.listenerCount('a'), 1);
});

test('removeAllListeners(event) clears that event only', t => {
    const ee = new EventEmitter();
    ee.on('a', () => {});
    ee.on('b', () => {});
    ee.removeAllListeners('a');
    t.is(ee.listenerCount('a'), 0);
    t.is(ee.listenerCount('b'), 1);
});

test('removeAllListeners() (no arg) clears everything', t => {
    const ee = new EventEmitter();
    ee.on('a', () => {});
    ee.on('b', () => {});
    ee.removeAllListeners();
    t.is(ee.listenerCount('a'), 0);
    t.is(ee.listenerCount('b'), 0);
});

test('non-function handler is a no-op', t => {
    const ee = new EventEmitter();
    const off = ee.on('x', null);
    t.is(typeof off, 'function');
    t.is(ee.listenerCount('x'), 0);
});

// ── clean-room / F2: nowy runtime stoi na `once()` i `removeAllListeners(key)` ──
// Do tej pory żadna z tych dwóch metod nie miała testu, a `PluginRuntime` używa obu
// (jednorazowe „poczekaj na loaded" i sprzątanie kanału przy `dispose()`).

test('once: handler leci DOKŁADNIE raz i sam się odpina', t => {
    const ee = new EventEmitter();
    const widziane: unknown[] = [];

    ee.once('loaded', (payload) => { widziane.push(payload); });
    ee.emit('loaded', 1);
    ee.emit('loaded', 2);

    t.deepEqual(widziane, [1], 'jednorazowy handler odpalił się drugi raz');
    t.is(ee.listenerCount('loaded'), 0, 'handler został na liście po odpaleniu');
});

test('once: zwrócony uchwyt odpina handler PRZED pierwszą emisją', t => {
    const ee = new EventEmitter();
    let odpalone = 0;

    const off = ee.once('loaded', () => { odpalone++; });
    off();
    ee.emit('loaded');

    t.is(odpalone, 0);
    t.is(ee.listenerCount('loaded'), 0);
});

test('removeAllListeners(key): czyści JEDEN kanał, reszta zostaje', t => {
    const ee = new EventEmitter();
    ee.on('loaded', () => {});
    ee.on('loaded', () => {});
    ee.on('unloading', () => {});

    ee.removeAllListeners('loaded');

    t.is(ee.listenerCount('loaded'), 0);
    t.is(ee.listenerCount('unloading'), 1, 'sprzątanie jednego kanału zabrało drugi');
});
