/**
 * `redactSecretValues`: redakcja PO WARTOŚCI, tam gdzie klucz API jest ZNANY
 * (drugie, osobne od `maskSensitiveData`, źródło prawdy — patrz `core/CLAUDE.md` gotcha 4e).
 *
 * `errorFromBody` (`modules/models/ChatModel.ts`) i normalizacja `payload.error` w
 * dostawcach (`OpenAiCompatibleProvider.ts`, `anthropic.ts`, `gemini.ts`) idą sparsowanym
 * ciałem do `normalizeError`, a klucz NIESTANDARDOWY (bez znanego prefiksu jak `sk-`/`gsk_`)
 * nie łapie się na wzorzec `maskSensitiveData`. Jedyna warstwa, która go złapie, to redakcja
 * PO DOSŁOWNEJ WARTOŚCI klucza użytego w żądaniu.
 *
 * Plik testowy jest CELOWO osobny od `errorUtils.test.ts`, żeby ten eksport nie dzielił
 * modułu z resztą testów `normalizeError` w tamtym pliku.
 */
import test from 'ava';
import { redactSecretsDeep, redactSecretValues } from './errorUtils.js';
import type { NormalizedError } from './errorUtils.js';

const SECRET = 'sk-live-ABCDEFGH1234';

test('redactSecretValues: sekret w message zastąpiony [REDACTED]', t => {
    const err: NormalizedError = {
        message: `Incorrect API key provided: ${SECRET}`,
        code: 'invalid_api_key',
        http_status: 401,
    };

    const out = redactSecretValues(err, [SECRET]);

    t.is(out.message, 'Incorrect API key provided: [REDACTED]');
    t.is(out.code, 'invalid_api_key', 'redakcja dotyczy tylko message/details, reszta kształtu zostaje bez zmian');
    t.is(out.http_status, 401);
});

test('redactSecretValues: sekret zagnieżdżony w details.error.message też zredagowany', t => {
    const err: NormalizedError = {
        message: 'upstream error',
        code: 'ECONN',
        http_status: 500,
        details: { error: { message: `token ${SECRET} wygasł` } },
    };

    const out = redactSecretValues(err, [SECRET]);

    const details = out.details as { error: { message: string } };
    t.is(details.error.message, 'token [REDACTED] wygasł',
        'sekret w tekście zagnieżdżonym głębiej niż message musi zostać zredagowany tą samą funkcją');
});

test('redactSecretValues: sekret krótszy niż 8 znaków jest IGNOROWANY', t => {
    const err: NormalizedError = { message: 'kod błędu: abc123', code: 'X', http_status: null };

    const out = redactSecretValues(err, ['abc123']); // 6 znaków

    t.is(out.message, 'kod błędu: abc123',
        'sekret poniżej progu 8 znaków nie ma prawa nic zmienić — zbyt duże ryzyko fałszywych trafień na zwykły tekst');
});

test('redactSecretValues: pusta lista sekretów — obiekt wraca bez zmian (deepEqual)', t => {
    const err: NormalizedError = {
        message: 'zwykły błąd',
        code: 'X',
        http_status: null,
        details: { a: 1 },
    };

    const out = redactSecretValues(err, []);

    t.deepEqual(out, err);
});

// Klucz potrafi wyjść zakodowany w query stringu adresu (encodeURIComponent) albo owinięty
// nagłówkiem `Bearer` odbitym w treści błędu - patrz core/CLAUDE.md gotcha 4e.

test('redactSecretValues: sekret w formie encodeURIComponent (query string adresu) też zredagowany', t => {
    const URL_SECRET = 'sk_live/AB+CD=99999999';
    const err: NormalizedError = {
        message: `Redirect blocked: token=${encodeURIComponent(URL_SECRET)}`,
        code: 'REDIRECT',
        http_status: 400,
    };

    const out = redactSecretValues(err, [URL_SECRET]);

    t.is(out.message, 'Redirect blocked: token=[REDACTED]',
        'wartość zakodowana do query stringu (/, +, = escapowane) nie jest bajt w bajt tym samym ciągiem co surowy sekret — trzeba jej szukać osobno');
});

test('redactSecretValues: `Bearer <sekret>` redagowany W CAŁOŚCI, nie zostawia "Bearer [REDACTED]"', t => {
    const err: NormalizedError = {
        message: `Auth failed: Bearer ${SECRET}`,
        code: 'UNAUTHORIZED',
        http_status: 401,
    };

    const out = redactSecretValues(err, [SECRET]);

    t.is(out.message, 'Auth failed: [REDACTED]',
        'forma opakowana "Bearer <sekret>" musi zniknąć jako jeden token — dłuższy wariant idzie przed gołym sekretem');
});

// ─── `redactSecretsDeep` - ta sama redakcja, na DOWOLNEJ wartości, PRZED normalizacją ───
//
// `normalizeError` tnie `message` do limitu długości PRZED tym, jak `redactSecretValues`
// dostaje gotowy `NormalizedError` - sekret na granicy cięcia wyszedłby przecięty na pół.
// `redactSecretsDeep` redaguje SUROWĄ wartość (ciało po `JSON.parse`, `payload.error`
// dostawcy) zanim jakiekolwiek cięcie długości jej dotknie.

test('redactSecretsDeep: sekret w zagnieżdżonym polu surowego obiektu zastąpiony [REDACTED]', t => {
    const raw = { error: { message: `bad key: ${SECRET}`, type: 'invalid_request', nested: { hint: `spróbuj bez ${SECRET}` } } };

    const out = redactSecretsDeep(raw, [SECRET]) as typeof raw;

    t.is(out.error.message, 'bad key: [REDACTED]');
    t.is(out.error.nested.hint, 'spróbuj bez [REDACTED]');
    t.is(out.error.type, 'invalid_request', 'pola bez sekretu zostają bez zmian');
});

test('redactSecretsDeep: obiekt z cyklem nie rzuca i cykliczne pole dostaje znacznik [cycle]', t => {
    const raw: Record<string, unknown> = { message: `klucz: ${SECRET}` };
    raw.self = raw; // referencja do samego siebie

    const out = redactSecretsDeep(raw, [SECRET]) as Record<string, unknown>; // rzut przerwałby test, gdyby rekurencja nie miała ochrony przed cyklem

    t.is(out.message, 'klucz: [REDACTED]');
    t.is(out.self, '[cycle]');
});
