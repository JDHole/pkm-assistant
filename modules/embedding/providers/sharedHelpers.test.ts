/**
 * providers/sharedHelpers.test.ts — testy `providers/_shared.ts`, pomoce współdzielone
 * przez dostawców embeddingu
 * (`defaultCountTokens`, `parseRetryAfterHeader`, `parseOpenAiShapedEmbedError`).
 *
 * `buildOpenAiShapedEmbedRequest` / `parseOpenAiShapedEmbedResponse` mają już pełne
 * pokrycie przez `providers/openai.test.ts` i `providers/lm_studio.test.ts` (kształt
 * jest sprawą dostawcy, nie tego pliku) — tu dobijamy przypadki brzegowe WŁASNE
 * dla `_shared.ts`, których żaden dostawca nie odsłania wprost (§8 kontraktu:
 * `Retry-After` sekundy → ms; §5.3 kolejność `message || text || HTTP status`).
 */
import test from 'ava';
import { defaultCountTokens, parseRetryAfterHeader, parseOpenAiShapedEmbedError } from './_shared.js';
import { TOKEN_CHARS_PER_TOKEN } from '../contracts.js';
import type { HttpResponse } from '../contracts.js';

function res(overrides: { status?: number; text?: string; headers?: Record<string, string>; json?: unknown }): HttpResponse {
    const { json: jsonValue, ...rest } = overrides;
    return {
        status: 500,
        headers: {},
        text: '',
        ...rest,
        json: <T>() => jsonValue as T,
    };
}

// ── defaultCountTokens (L19) ────────────────────────────────────────────────

test('defaultCountTokens: znaki / TOKEN_CHARS_PER_TOKEN, zaokrąglone W GÓRĘ', t => {
    // 4 znaki / 3.7 = 1.081... -> ceil = 2, nie floor (1) ani wartość surowa.
    t.is(defaultCountTokens('abcd'), 2);
    t.is(defaultCountTokens('a'.repeat(37)), Math.ceil(37 / TOKEN_CHARS_PER_TOKEN));
});

test('defaultCountTokens: pusty tekst daje 0, nie undefined', t => {
    t.is(defaultCountTokens(''), 0);
});

// ── parseRetryAfterHeader (L36-L41) ─────────────────────────────────────────

test('parseRetryAfterHeader: brak nagłówków -> undefined', t => {
    t.is(parseRetryAfterHeader(undefined), undefined);
});

test('parseRetryAfterHeader: nazwa nagłówka case-insensitive', t => {
    t.is(parseRetryAfterHeader({ 'RETRY-AFTER': '3' }), 3000);
});

test('parseRetryAfterHeader: brak klucza retry-after -> undefined', t => {
    t.is(parseRetryAfterHeader({ 'Content-Type': 'application/json' }), undefined);
});

test('parseRetryAfterHeader: "0" sekund -> 0 ms, NIE undefined (granica < vs <=, num 0 vs 1)', t => {
    // Zabija: lt->le (0<=0 dałby undefined) ORAZ num 0->1 (0<1 dałby undefined).
    t.is(parseRetryAfterHeader({ 'Retry-After': '0' }), 0);
});

test('parseRetryAfterHeader: wartość ułamkowa < 1s przechodzi (num 0->1 zjadłby ją)', t => {
    // 0.5 < 0 jest fałszywe (poprawne zachowanie: 500 ms). Mutant `seconds < 1`
    // dałby tu undefined, bo 0.5 < 1 jest prawdziwe.
    t.is(parseRetryAfterHeader({ 'Retry-After': '0.5' }), 500);
});

test('parseRetryAfterHeader: wartość ujemna -> undefined', t => {
    t.is(parseRetryAfterHeader({ 'Retry-After': '-1' }), undefined);
});

test('parseRetryAfterHeader: wartość nie-liczbowa (NaN) -> undefined mimo że NaN < 0 jest fałszywe (or->and)', t => {
    // Zabija or->and: `!isFinite(NaN) && NaN<0` = `true && false` = false -> mutant
    // przepuściłby NaN dalej (NaN*1000 = NaN) zamiast oddać undefined.
    t.is(parseRetryAfterHeader({ 'Retry-After': 'not-a-number' }), undefined);
});

test('parseRetryAfterHeader: dodatnia liczba sekund -> ms', t => {
    t.is(parseRetryAfterHeader({ 'Retry-After': '2' }), 2000);
});

// ── parseOpenAiShapedEmbedError: kolejność message || text || HTTP status (L100) ──

test('parseOpenAiShapedEmbedError: body.error.message wygrywa NAWET gdy res.text jest puste (or->and)', t => {
    // Zabija or->and: `(message && text) || HTTP` -> gdy text jest pusty (falsy),
    // `message && ''` daje '' (falsy), więc mutant spadłby na `HTTP {status}`
    // zamiast oddać message dostawcy.
    const response = res({ status: 500, text: '', json: { error: { message: 'Model overloaded' } } });
    const { error } = parseOpenAiShapedEmbedError(response, 'openai', 'text-embedding-3-small');
    t.is(error.message, 'Model overloaded');
});

test('parseOpenAiShapedEmbedError: brak body.error.message -> res.text', t => {
    const response = res({ status: 502, text: 'Bad Gateway', json: undefined });
    const { error } = parseOpenAiShapedEmbedError(response, 'openai', 'text-embedding-3-small');
    t.is(error.message, 'Bad Gateway');
});

test('parseOpenAiShapedEmbedError: brak message i pusty text -> HTTP {status}', t => {
    const response = res({ status: 503, text: '', json: undefined });
    const { error } = parseOpenAiShapedEmbedError(response, 'openai', 'text-embedding-3-small');
    t.is(error.message, 'HTTP 503');
});
