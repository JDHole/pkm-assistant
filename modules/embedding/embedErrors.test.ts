/**
 * embedErrors.test.ts — pinowanie kontraktu błędu embeddingu (F10 mutacje, `embedErrors.ts`).
 *
 * Zakres: konstruktor `EmbedBatchError` (domyślna wartość `attempts`) + strażnik
 * `isEmbedBatchError` (ścieżka `instanceof` ORAZ ścieżka po kształcie — to druga
 * jest tu kluczowa, bo VaultIndexer opiera się na niej, gdy `instanceof` zawodzi
 * przez granicę modułu — patrz komentarz w `embedErrors.ts`).
 */
import test from 'ava';
import { EmbedBatchError, isEmbedBatchError } from './embedErrors.js';

// --- EmbedBatchError.attempts ------------------------------------------------

test('attempts: brak pola w init -> domyślnie 1 (jedno żądanie)', t => {
    const err = new EmbedBatchError({ kind: 'api', code: 'unknown', message: 'x' });
    t.is(err.attempts, 1);
});

test('attempts: 0 jest wartością znaczącą (nie doszło do żądania — brak klucza API) i NIE jest zamieniane na domyślną', t => {
    const err = new EmbedBatchError({ kind: 'api', code: 'api_key_missing', message: 'x', attempts: 0 });
    t.is(err.attempts, 0);
});

test('attempts: liczba > 1 z init jest zachowywana 1:1, nie nadpisywana domyślną', t => {
    const err = new EmbedBatchError({ kind: 'api', code: 'rate_limited', message: 'x', attempts: 4 });
    t.is(err.attempts, 4);
});

// --- isEmbedBatchError: ścieżka instanceof ------------------------------------

test('isEmbedBatchError: prawdziwa instancja EmbedBatchError jest rozpoznawana', t => {
    const err = new EmbedBatchError({ kind: 'transport', code: 'no_response', message: 'x' });
    t.true(isEmbedBatchError(err));
});

test('isEmbedBatchError: obiekt na łańcuchu prototypów EmbedBatchError, bez własnych pól kind/code, jest rozpoznawany przez instanceof (bez sięgania po kształt)', t => {
    // Symuluje przypadek z komentarza pliku: `instanceof` musi wystarczyć samo w sobie,
    // niezależnie od tego, co niesie kształt obiektu.
    const bezWlasnychPol = Object.create(EmbedBatchError.prototype) as unknown;
    t.true(isEmbedBatchError(bezWlasnychPol));
});

// --- isEmbedBatchError: wejścia odrzucane wcześnie (typeof / null) -----------

test('isEmbedBatchError: null -> false (nie wolno wejść w sprawdzanie kształtu)', t => {
    t.false(isEmbedBatchError(null));
});

test('isEmbedBatchError: undefined -> false', t => {
    t.false(isEmbedBatchError(undefined));
});

test('isEmbedBatchError: prymityw (string) -> false', t => {
    t.false(isEmbedBatchError('boom'));
});

// --- isEmbedBatchError: ścieżka po kształcie (bez instanceof) -----------------

test('isEmbedBatchError: goły obiekt z poprawnym kind (z listy ERROR_KINDS) i code:string -> true (kluczowa ścieżka dla fasady wstrzykiwanej przez granicę modułu)', t => {
    const atrapa = { kind: 'transport', code: 'no_response', message: 'x' };
    t.true(isEmbedBatchError(atrapa));
});

test('isEmbedBatchError: kind spoza ERROR_KINDS (mimo że string) i code:string -> false', t => {
    const atrapa = { kind: 'not-a-real-kind', code: 'http_error' };
    t.false(isEmbedBatchError(atrapa));
});

test('isEmbedBatchError: kind poprawny, ale code NIE jest stringiem -> false', t => {
    const atrapa = { kind: 'shape', code: 42 };
    t.false(isEmbedBatchError(atrapa));
});

test('isEmbedBatchError: kind nie jest stringiem (mimo że code jest poprawnym stringiem) -> false', t => {
    const atrapa = { kind: 123, code: 'http_error' };
    t.false(isEmbedBatchError(atrapa));
});

test('isEmbedBatchError: obiekt bez pól kind/code w ogóle -> false', t => {
    t.false(isEmbedBatchError({}));
});
