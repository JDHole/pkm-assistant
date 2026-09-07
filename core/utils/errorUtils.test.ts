import test from 'ava';
import { normalizeError, MAX_ERROR_MESSAGE_LENGTH, SECRET_BEARING_FIELDS } from './errorUtils.js';

test('null/undefined error → "Unknown error" + kod UNKNOWN', t => {
    t.deepEqual(normalizeError(null), { message: 'Unknown error', code: 'UNKNOWN', http_status: null });
    t.deepEqual(normalizeError(undefined, 503), { message: 'Unknown error', code: 'UNKNOWN', http_status: 503 });
});

test('string error → treść jako message, bez details', t => {
    const out = normalizeError('rate limit exceeded', 429);
    t.is(out.message, 'rate limit exceeded');
    t.is(out.code, 'UNKNOWN');
    t.is(out.http_status, 429);
    t.false('details' in out);
});

test('obiekt z error.code → kod z pola code, details = cały obiekt', t => {
    const err = { message: 'bad key', code: 'invalid_api_key' };
    const out = normalizeError(err);
    t.is(out.message, 'bad key');
    t.is(out.code, 'invalid_api_key');
    t.is(out.details, err);
    t.is(out.http_status, null);
});

test('zagnieżdżony error.error.type → kod z type, message i details z gałęzi error', t => {
    const nested = { type: 'overloaded_error', message: 'Overloaded' };
    const out = normalizeError({ error: nested });
    t.is(out.message, 'Overloaded');
    t.is(out.code, 'overloaded_error');
    t.is(out.details, nested);
});

test('http_status: argument wygrywa, inaczej error.status/error.http_status', t => {
    t.is(normalizeError({ message: 'x', status: 500 }).http_status, 500);
    t.is(normalizeError({ message: 'x', http_status: 502 }).http_status, 502);
    t.is(normalizeError({ message: 'x', status: 500 }, 401).http_status, 401);
});

test('obiekt bez message → JSON.stringify jako message', t => {
    t.is(normalizeError({ foo: 'bar' }).message, '{"foo":"bar"}');
});

// ─── K20 (AUD-security-120): gałąź JSON.stringify wycina pola niosące sekrety ────────────
//
// Zdarzenie błędu streamera niosło `source` = cały streamer Z NAGŁÓWKAMI żądania
// (`Authorization`, `api-key`). Gdy strumień padał bez ciała, `e.data` było puste i do
// `normalizeError` szło CAŁE zdarzenie — a stąd, przez `JSON.stringify`, prosto do
// `message`, czyli do pliku logu i na ekran usera. `message` nie jest miejscem na kontekst
// żądania: pola, które z definicji niosą sekrety, wypadają, a całość ma twardy limit.

test('K20: pola-sekrety (source/headers/request/xhr/config/options) nie wchodzą do message', t => {
    const event = {
        status: 0,
        data: null,
        source: { headers: { Authorization: 'Bearer TAJNY-TOKEN-XYZ' }, url: 'https://api.example.com/v1' },
    };
    const out = normalizeError(event);
    t.false(out.message.includes('TAJNY-TOKEN-XYZ'), out.message);
    t.false(out.message.includes('Bearer'), out.message);
    t.false(out.message.toLowerCase().includes('headers'), out.message);
    t.false(out.message.includes('source'), out.message);
    // Reszta zdarzenia zostaje — diagnostyka bez sekretów.
    t.true(out.message.includes('status'), out.message);
});

test('K20: każde z pól-sekretów wypada niezależnie od zagnieżdżenia', t => {
    for (const field of ['headers', 'source', 'request', 'request_params', 'xhr', 'config', 'options']) {
        const out = normalizeError({ code: 'ECONN', [field]: { 'api-key': 'AZURE123456789SECRET' } });
        t.false(out.message.includes('AZURE123456789SECRET'), `${field}: sekret w message → ${out.message}`);
        const nested = normalizeError({ code: 'ECONN', wrapper: { [field]: { 'api-key': 'AZURE123456789SECRET' } } });
        t.false(nested.message.includes('AZURE123456789SECRET'), `${field} (zagnieżdżony): ${nested.message}`);
    }
});

test('K20: message ma twardy limit długości', t => {
    const out = normalizeError({ blob: 'x'.repeat(50000) });
    t.true(out.message.length <= 4100, `message ma ${out.message.length} znaków`);
    const long_message = normalizeError({ message: 'y'.repeat(50000) });
    t.true(long_message.message.length <= 4100, `message ma ${long_message.message.length} znaków`);
});

test('K20: cykliczny obiekt nie wywala normalizacji', t => {
    const circular: Record<string, unknown> = { code: 'LOOP' };
    circular.self = circular;
    const out = normalizeError(circular);
    t.is(typeof out.message, 'string');
    t.is(out.code, 'LOOP');
});

test('K20: `details` zostaje surowym obiektem (kontrakt adapterów bez zmian)', t => {
    const err = { status: 500, source: { headers: { Authorization: 'Bearer X' } } };
    t.is(normalizeError(err).details, err);
});

// clean-room / F2: obie stałe stały się publiczne (właściciel typu i funkcji to ten plik,
// a stoją na nich testy K20 klastra `models` i transport w `core/http`).
test('MAX_ERROR_MESSAGE_LENGTH to twardy limit 4000 znaków', t => {
    t.is(MAX_ERROR_MESSAGE_LENGTH, 4000);
});

test('SECRET_BEARING_FIELDS zawiera pola kontekstu żądania', t => {
    for (const field of ['headers', 'source', 'request', 'request_params', 'xhr', 'config', 'options']) {
        t.true(SECRET_BEARING_FIELDS.has(field), `brakuje pola ${field}`);
    }
});
