/**
 * `seededStringHash` jest jedynym publicznym punktem wejścia (`asText`/`scatter`
 * są prywatne), więc te testy pinują dokładne wartości liczbowe wynikające z algorytmu: każda
 * stała bitowa (przesunięcia, `| 0`/`>>> 0`, znak dodawania) i każda gałąź koercji wejścia
 * (string / number / boolean / bigint / „wszystko inne") ma tu przynajmniej jeden test, który
 * zmieniłby wynik, gdyby stała albo gałąź się zepsuła.
 */
import test from 'ava';
import { seededStringHash } from './utils/stableHash.js';

test('kontrakt: wynik jest zawsze nieujemną liczbą całkowitą 32-bitową', t => {
    for (const input of ['x', '', 'Klara', 42, true, false, 10n, null, undefined, {}]) {
        const hash = seededStringHash(input);
        t.true(Number.isInteger(hash), `nie jest integerem dla ${String(input)}`);
        t.true(hash >= 0, `ujemny wynik dla ${String(input)}`);
        t.true(hash < 2 ** 32, `poza zakresem 32 bitów dla ${String(input)}`);
    }
});

test('kontrakt: deterministyczny — to samo wejście, ten sam wynik za każdym razem', t => {
    t.is(seededStringHash('Klara'), seededStringHash('Klara'));
    t.is(seededStringHash(''), seededStringHash(''));
});

test('string: wartości pinowane (L17, L33, L52-59 — bez koercji, string idzie wprost)', t => {
    t.is(seededStringHash(''), 0);
    t.is(seededStringHash('a'), 3392050242);
    t.is(seededStringHash('ab'), 1172708952);
    t.is(seededStringHash('hello'), 3372029979);
});

test('string: „Klara" i „Klara2" dają różne hashe — kontrakt sąsiednich napisów (dokumentacja funkcji)', t => {
    const klara = seededStringHash('Klara');
    const klara2 = seededStringHash('Klara2');
    t.is(klara, 2637994047);
    t.is(klara2, 4080845956);
    t.not(klara, klara2);
});

test('number: koercja przez String() (L18 eq→neq/or→and/negate-cond, L19 return→undefined)', t => {
    // Gdyby gałąź number przestała łapać typ number (L18) albo `String(input)` wróciło
    // `undefined` (L19), poniższe wartości spadłyby do hasha pustego stringa (0) albo rzuciłyby
    // wyjątkiem w pętli (`undefined.length`).
    t.is(seededStringHash(42), seededStringHash('42'));
    t.is(seededStringHash(42), 1942662376);
    t.is(seededStringHash(0), seededStringHash('0'));
    t.is(seededStringHash(0), 1849449579);
    t.is(seededStringHash(-1), seededStringHash('-1'));
});

test('boolean: koercja przez String() (L18 druga klauzula OR)', t => {
    t.is(seededStringHash(true), seededStringHash('true'));
    t.is(seededStringHash(true), 3002293285);
    t.is(seededStringHash(false), seededStringHash('false'));
    t.is(seededStringHash(false), 4263898946);
    t.not(seededStringHash(true), seededStringHash(false));
});

test('bigint: koercja przez String() (L18 trzecia klauzula OR)', t => {
    t.is(seededStringHash(10n), seededStringHash('10'));
    t.is(seededStringHash(10n), 3648256925);
});

test('wejście spoza kontraktu (null/undefined/obiekt/tablica/funkcja/symbol) == pusty string (L21 return→undefined)', t => {
    // Kontrakt funkcji: wszystko, co nie jest string/number/boolean/bigint, dostaje pusty
    // napis (patrz komentarz `asText` w stableHash.ts) — a nie osobną, niezdefiniowaną ścieżkę.
    const pusty = seededStringHash('');
    t.is(pusty, 0);
    t.is(seededStringHash(null), pusty);
    t.is(seededStringHash(undefined), pusty);
    t.is(seededStringHash({}), pusty);
    t.is(seededStringHash([]), pusty);
    t.is(seededStringHash(function f() { /* noop */ }), pusty);
    t.is(seededStringHash(Symbol('x')), pusty);
});

test('nie rzuca wyjątku dla żadnej kategorii wejścia (obrona przed `undefined.length`/`undefined.charCodeAt`)', t => {
    for (const input of ['a', 1, true, 1n, null, undefined, {}, [], () => {}, Symbol('s')]) {
        t.notThrows(() => seededStringHash(input));
    }
});
