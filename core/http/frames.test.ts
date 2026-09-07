/**
 * Parsery ramek — jedyny element transportu, który pamięta cokolwiek poza jedną porcją.
 *
 * Realny ruch sieciowy tnie odpowiedź w przypadkowych miejscach: porcja potrafi rozciąć
 * `data:` w połowie, a znak wielobajtowy między dwiema porcjami. Te przypadki brzegowe
 * są tu spisane wprost, bo dostawcy nigdy ich nie odtworzą na życzenie.
 */
import test from 'ava';

import { SseFrames } from './SseFrames.js';
import { NdjsonFrames } from './NdjsonFrames.js';

// ── C13.1 ────────────────────────────────────────────────────────────────────
test('SseFrames: porcja rozcinająca "data:" w połowie nie gubi ramki', t => {
    const parser = new SseFrames();

    t.deepEqual(parser.feed('data: {"a":'), [], 'niekompletna ramka została oddana wołaczowi');
    const ramki = parser.feed('1}\n\n');

    t.is(ramki.length, 1);
    t.is(ramki[0].data, '{"a":1}', 'ogon z bufora nie został sklejony z nową porcją');
});

// ── C13.2 ────────────────────────────────────────────────────────────────────
test('SseFrames: puste linie i komentarze ":" są pomijane', t => {
    const parser = new SseFrames();

    const ramki = parser.feed(': ping\n\ndata: pierwsza\n\n\n\nevent: message_stop\ndata: druga\n\n');

    t.is(ramki.length, 2, 'komentarz albo pusta linia weszły jako ramka-śmieć');
    t.is(ramki[0].data, 'pierwsza');
    t.is(ramki[1].data, 'druga');
    t.is(ramki[1].event, 'message_stop', '`event:` przed `data:` nie wypełnił nazwy zdarzenia');
});

// ── C13.3 ────────────────────────────────────────────────────────────────────
test('SseFrames: finish() nie oddaje niekompletnego ogona', t => {
    const parser = new SseFrames();
    parser.feed('data: urwane bez pustej linii');

    t.deepEqual(parser.finish(), [], 'niekompletny ogon wyszedł jako ramka — dekoder dostałby śmieć');
});

// ── C13.4 ────────────────────────────────────────────────────────────────────
test('NdjsonFrames: puste linie pomijane, urwana ostatnia linia zostaje w buforze', t => {
    const parser = new NdjsonFrames();

    const pierwsze = parser.feed('{"a":1}\n\n{"b":2}\n{"c":');
    t.is(pierwsze.length, 2, 'urwana ostatnia linia została wypuszczona (OL-07)');
    t.is(pierwsze[0].data, '{"a":1}');
    t.is(pierwsze[1].data, '{"b":2}');

    const drugie = parser.feed('3}\n');
    t.is(drugie.length, 1);
    t.is(drugie[0].data, '{"c":3}');
});
