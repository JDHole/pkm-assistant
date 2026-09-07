/**
 * `core/runtime/configMerge.ts` — testy behawioralne dla `isPlainObject`, `cloneConfig`
 * i `deepMergeMissing`.
 *
 * Zakres: rozróżnienie zwykłego obiektu od tablicy / `null` / instancji klasy, głęboka
 * kopia (identyczność referencji musi się ZŁAMAĆ dla worka i tablicy, wartość musi zostać
 * TA SAMA dla prymitywów), oraz merge „tylko brakujące" — zarówno ścieżka happy-path
 * (rekurencja w głąb, klucz jawnie ustawiony na `undefined` traktowany jak brak), jak
 * i ścieżki obronne (target/source nie są workiem — funkcja ma nic nie zrobić, fail-soft).
 */
import test from 'ava';

import { cloneConfig, deepMergeMissing, isPlainObject } from './configMerge.js';

// ---------------------------------------------------------------------------
// isPlainObject
// ---------------------------------------------------------------------------

test('isPlainObject: literał {} i Object.create(null) to worek', (t) => {
    t.true(isPlainObject({}));
    t.true(isPlainObject(Object.create(null) as unknown));
});

test('isPlainObject: tablica, null i instancja klasy to NIE worek', (t) => {
    class Foo {
        x = 1;
    }
    t.false(isPlainObject([]));
    t.false(isPlainObject(null));
    t.false(isPlainObject(new Foo()));
    t.false(isPlainObject(new Date()));
    t.false(isPlainObject('worek'));
});

// ---------------------------------------------------------------------------
// cloneConfig
// ---------------------------------------------------------------------------

test('cloneConfig: prymitywy wracają BEZ ZMIAN (ta sama wartość, nie kopiowanie)', (t) => {
    t.is(cloneConfig(42), 42);
    t.is(cloneConfig('tekst'), 'tekst');
    t.is(cloneConfig(null), null);
    t.is(cloneConfig(undefined), undefined);
    t.is(cloneConfig(true), true);
});

test('cloneConfig: worek i tablica są PRZEPISANE — nowa referencja na każdym poziomie', (t) => {
    const original = { list: [1, { a: 1 }], nested: { b: 2 } };
    const clone = cloneConfig(original);

    t.deepEqual(clone, original);
    t.not(clone, original, 'korzeń musi być nową referencją');
    t.not(clone.list, original.list, 'tablica musi być nową referencją');
    t.not(clone.list[1], original.list[1], 'obiekt zagnieżdżony w tablicy musi być nową referencją');
    t.not(clone.nested, original.nested, 'obiekt zagnieżdżony musi być nową referencją');

    // Mutacja kopii nie ma prawa dotknąć oryginału — to jest sens klonowania.
    (clone.nested as { b: number }).b = 999;
    t.is(original.nested.b, 2);
});

// ---------------------------------------------------------------------------
// deepMergeMissing — ścieżka główna
// ---------------------------------------------------------------------------

test('deepMergeMissing: dokłada WYŁĄCZNIE brakujące klucze, rekurencyjnie w głąb', (t) => {
    const target: Record<string, unknown> = { a: 1, b: { x: 1 } };
    const source: Record<string, unknown> = { b: { x: 99, y: 2 }, c: 3 };

    const result = deepMergeMissing(target, source);

    t.is(result, target, 'merge mutuje i zwraca ten sam target');
    t.is(result.a, 1, 'istniejący klucz top-level zostaje nietknięty');
    const b = result.b as Record<string, unknown>;
    t.is(b.x, 1, 'istniejący klucz zagnieżdżony zostaje nietknięty (source nie nadpisuje)');
    t.is(b.y, 2, 'brakujący klucz zagnieżdżony zostaje dołożony przez rekurencję');
    t.is(result.c, 3, 'brakujący klucz top-level zostaje dołożony');
});

test('deepMergeMissing: dokładana gałąź jest KOPIĄ — nie współdzieli referencji z source', (t) => {
    const target: Record<string, unknown> = {};
    const sourceBranch = { deep: { value: 1 } };
    const source: Record<string, unknown> = { branch: sourceBranch };

    const result = deepMergeMissing(target, source);

    t.deepEqual(result.branch, sourceBranch);
    t.not(result.branch, sourceBranch, 'dołożona gałąź musi być kopią, nie tą samą referencją');
});

test('deepMergeMissing: klucz jawnie ustawiony na undefined liczy się jak brak — source go wypełnia', (t) => {
    interface Foo {
        a?: number;
    }
    const target: Foo = { a: undefined };
    const source: Foo = { a: 5 };

    const result = deepMergeMissing(target, source);

    t.is(result.a, 5);
});

// ---------------------------------------------------------------------------
// deepMergeMissing — ścieżki obronne (target/source nie są workiem)
// ---------------------------------------------------------------------------

test('deepMergeMissing: target nie-worek (tablica) — zwraca target BEZ ZMIAN', (t) => {
    const target = [] as unknown as Record<string, unknown>;
    const source: Record<string, unknown> = { a: 1 };

    const result = deepMergeMissing(target, source);

    t.deepEqual(result, []);
    t.is(Object.keys(result).length, 0, 'zero kluczy dołożonych do tablicy');
});

test('deepMergeMissing: source nie-worek (tablica) — zwraca target BEZ ZMIAN', (t) => {
    const target: Record<string, unknown> = { a: 1 };
    const source = [1, 2, 3] as unknown as Record<string, unknown>;

    const result = deepMergeMissing(target, source);

    t.deepEqual(result, { a: 1 });
});
