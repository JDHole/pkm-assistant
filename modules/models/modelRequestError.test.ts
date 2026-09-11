/**
 * `ModelRequestError` - `NormalizedError` throw-owalny jako prawdziwy `Error`.
 *
 * Kontrakt: instancja MUSI wyglądać dla konsumenta identycznie jak dawny goły obiekt
 * `{ message, code, details, http_status }` - `{...err}`, `Object.keys(err)`,
 * `JSON.stringify(err)`. Jedyna różnica ma być widoczna przez `instanceof Error`
 * (po to cała klasa powstała - `@typescript-eslint/only-throw-error`).
 */
import test from 'ava';
import { ModelRequestError } from './ModelRequestError.js';
import type { NormalizedError } from './contracts.js';

const SAMPLE: NormalizedError = {
    message: 'Incorrect API key provided',
    code: 'invalid_request_error',
    details: { status: 401 },
    http_status: 401,
};

test('jest instancją Error (throw-owalna)', t => {
    const err = new ModelRequestError(SAMPLE);
    t.true(err instanceof Error);
    t.true(err instanceof ModelRequestError);
});

test('pola message/code/details/http_status czytelne wprost', t => {
    const err = new ModelRequestError(SAMPLE);
    t.is(err.message, SAMPLE.message);
    t.is(err.code, SAMPLE.code);
    t.deepEqual(err.details, SAMPLE.details);
    t.is(err.http_status, SAMPLE.http_status);
});

test('JSON.stringify daje DOKŁADNIE ten sam tekst co dla gołego NormalizedError', t => {
    const err = new ModelRequestError(SAMPLE);
    t.is(JSON.stringify(err), JSON.stringify(SAMPLE));
});

test('Object.keys zawiera message/code/http_status (message enumerowalny, nie ukryty przez Error)', t => {
    const err = new ModelRequestError(SAMPLE);
    const keys = Object.keys(err);
    t.true(keys.includes('message'), `message ma być enumerowalne — Object.keys: ${keys.join(', ')}`);
    t.true(keys.includes('code'));
    t.true(keys.includes('http_status'));
});

test('spread {...err} oddaje ten sam kształt co spread gołego obiektu', t => {
    const err = new ModelRequestError(SAMPLE);
    t.deepEqual({ ...err }, { ...SAMPLE });
});

test('name NIE jest własną własnością — odziedziczone z Error.prototype, nie wchodzi do JSON-a', t => {
    const err = new ModelRequestError(SAMPLE);
    t.false(Object.prototype.hasOwnProperty.call(err, 'name'));
    t.is(err.name, 'Error');
});

test('from(): instancja przechodzi PRZEZ TĘ SAMĄ referencję, nie podwaja opakowania', t => {
    const err = new ModelRequestError(SAMPLE);
    t.is(ModelRequestError.from(err), err);
});

test('from(): zwykły string daje message == string, kod UNKNOWN', t => {
    const err = ModelRequestError.from('Model timeout (0s)');
    t.true(err instanceof ModelRequestError);
    t.is(err.message, 'Model timeout (0s)');
    t.is(err.code, 'UNKNOWN');
});

test('from(): surowy Error z fetch maskuje sekret w URL zamiast wynieść go dalej', t => {
    const err = ModelRequestError.from(new Error('fetch failed: https://api.openai.com/v1?api_key=sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    t.false(err.message.includes('sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'), err.message);
});
