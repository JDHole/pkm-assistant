import test from 'ava';
import {
    resolveMessageOrigin,
    isHumanMessage,
    machineMeta,
    HUMAN_MESSAGE_META,
    MACHINE_MESSAGE_META,
} from './messageOrigin.js';

// ── K7: fail-closed — człowiekiem jest tylko jawne `origin: 'human'` ──

test('resolveMessageOrigin: jawne human => human', t => {
    t.is(resolveMessageOrigin({ origin: 'human' }), 'human');
    t.is(resolveMessageOrigin(HUMAN_MESSAGE_META), 'human');
    t.true(isHumanMessage(HUMAN_MESSAGE_META));
});

test('resolveMessageOrigin: brak meta => machine (fail-closed)', t => {
    t.is(resolveMessageOrigin(undefined), 'machine');
    t.is(resolveMessageOrigin(null), 'machine');
    t.is(resolveMessageOrigin({}), 'machine');
    t.false(isHumanMessage(undefined));
    t.false(isHumanMessage({}));
});

test('resolveMessageOrigin: śmieci i literówki => machine', t => {
    // `send_message` bywa wpięte wprost jako listener kliknięcia — pierwszym argumentem
    // potrafi być MouseEvent. Taki obiekt nie ma prawa dostać przywilejów człowieka.
    t.is(resolveMessageOrigin({ type: 'click', bubbles: true }), 'machine');
    t.is(resolveMessageOrigin('human'), 'machine');
    t.is(resolveMessageOrigin({ origin: 'Human' }), 'machine');
    t.is(resolveMessageOrigin({ origin: 'user' }), 'machine');
    t.is(resolveMessageOrigin({ origin: true }), 'machine');
    t.is(resolveMessageOrigin(MACHINE_MESSAGE_META), 'machine');
});

test('machineMeta: dokłada pola i NIE daje się podmienić na human', t => {
    const meta = machineMeta({ _subTaskNotification: true, subTaskId: 'task-7' });
    t.is(meta.origin, 'machine');
    t.is(meta._subTaskNotification, true);
    t.is(meta.subTaskId, 'task-7');
    t.false(isHumanMessage(meta));
    // Wołający próbuje przemycić proweniencję człowieka w polach dodatkowych:
    t.false(isHumanMessage(machineMeta({ origin: 'human' })));
});

test('stałe meta są zamrożone (nikt nie przestawi globalnego znacznika)', t => {
    t.throws(() => { (HUMAN_MESSAGE_META as { origin: string }).origin = 'machine'; });
    t.throws(() => { (MACHINE_MESSAGE_META as { origin: string }).origin = 'human'; });
});
