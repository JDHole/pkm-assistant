/**
 * K20 (AUD-security-120/132) — REPRODUKCJA: pad strumienia BEZ CIAŁA nie wynosi klucza API.
 *
 * Stary streamer doklejał do KAŻDEGO zdarzenia siebie samego — razem z nagłówkami żądania
 * (`Authorization: Bearer …`, `x-api-key: …`). Gdy połączenie padało zanim serwer cokolwiek
 * odpisał (DNS, zerwane łącze, proxy, status != 200 przed ciałem), ciało zdarzenia było puste,
 * więc normalizacja dostawała CAŁE zdarzenie i wpisywała je — przez `JSON.stringify` — jako
 * tekst do `message`. To `message` idzie do `handlers.error`, do odrzucenia promisy i na
 * ekran usera.
 *
 * Bieg 1 i 2 audytu wykonały dokładnie ten scenariusz z wynikiem „KLUCZ JAWNY: true".
 * Tu ma być `false` — i w błędzie oddanym konsumentowi, i w tym, co poszło do loggera.
 *
 * ⚠️ Podział własności (clean-room): nagłówek klucza W ŻĄDANIU pinuje `providers/authHeaders.test.ts`,
 * a to, że TRANSPORT nie wypuszcza nagłówków — `core/http/streamTransport.test.ts`. Tutaj
 * zostaje strona MODELU: co dostaje konsument i co ląduje w logu.
 */
import test from 'ava';
import { ChatModel } from './ChatModel.js';
import { openaiProvider } from './providers/openai.js';
import { anthropicProvider } from './providers/anthropic.js';
import { __test__ as gateTest, acquireSlot } from './requestGate.js';
import { log } from '../../core/utils/Logger.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeSettings } from './testing/harness.js';
import type { ChatProvider, ChatRequest, NormalizedError } from './contracts.js';

const SECRET = 'TAJNY-TOKEN-XYZ-0123456789';
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'czesc' }], max_tokens: 128 };

// Model loguje pad strumienia przez `log.error` (zawsze widoczny) — w teście to sam szum.
const REAL_CONSOLE_ERROR = console.error;
test.before(() => { console.error = () => { /* cisza */ }; });
test.after.always(() => { console.error = REAL_CONSOLE_ERROR; });
test.beforeEach(() => { gateTest.reset(); });

function make(provider: ChatProvider, modelId: string) {
    const transport = new ScriptedTransport();
    const model = new ChatModel({
        provider,
        ctx: makeCtx({ modelId, apiKey: SECRET }),
        http: new CapturingHttpClient(),
        transport,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: provider.info.id } }),
    });
    return { model, transport };
}

/** Wszystko, co konsument mógłby wyświetlić albo zalogować, jako jeden ciąg. */
function flatten(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') return value;
    const seen = new WeakSet<object>();
    try {
        return JSON.stringify(value, (_k, v) => {
            if (v && typeof v === 'object') {
                if (seen.has(v as object)) return '[circular]';
                seen.add(v as object);
            }
            return v as unknown;
        }) ?? String(value);
    } catch { return String(value); }
}

/**
 * Odpala stream i każe transportowi paść BEZ CIAŁA odpowiedzi.
 * Zwraca to, co dostał konsument (`handlers.error` + odrzucenie promisy).
 */
async function streamFailureWithoutBody(
    provider: ChatProvider,
    modelId: string,
    status = 0,
): Promise<{ handlerError: unknown; rejection: unknown; logged: unknown[] }> {
    const logged: unknown[] = [];
    const realError = log.error;
    (log as unknown as { error: unknown }).error = (...args: unknown[]) => { logged.push(args); };
    try {
        const { model, transport } = make(provider, modelId);
        let handlerError: unknown = null;
        const promise = model.stream(REQ, { error: (e: unknown) => { handlerError = e; } });
        for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
        // Serwer nie zdążył nic odpisać: status bez ciała.
        transport.fail(status, '');
        let rejection: unknown = null;
        try { await promise; } catch (e) { rejection = e; }
        return { handlerError, rejection, logged };
    } finally {
        (log as unknown as { error: unknown }).error = realError;
    }
}

test.serial('K20: pad strumienia bez ciała — klucz NIE wychodzi w błędzie dla konsumenta ani w logu', async t => {
    const { handlerError, rejection, logged } = await streamFailureWithoutBody(openaiProvider, 'gpt-4o');

    t.false(flatten(handlerError).includes(SECRET), `handlers.error: ${flatten(handlerError)}`);
    t.false(flatten(rejection).includes(SECRET), `odrzucenie promisy: ${flatten(rejection)}`);
    t.false(flatten(logged).includes(SECRET), `log.error: ${flatten(logged)}`);
    // To pole czat pokazuje userowi.
    t.false(String((rejection as NormalizedError)?.message ?? '').includes(SECRET));
    t.false(String((rejection as NormalizedError)?.message ?? '').toLowerCase().includes('bearer'));
    t.false(String((rejection as NormalizedError)?.message ?? '').toLowerCase().includes('authorization'));
});

test.serial('K20: pad strumienia bez ciała — nagłówek niestandardowy (Anthropic `x-api-key`) też nie wychodzi', async t => {
    const { handlerError, rejection } = await streamFailureWithoutBody(anthropicProvider, 'claude-sonnet-4-20250514', 503);

    t.false(flatten(handlerError).includes(SECRET), `handlers.error: ${flatten(handlerError)}`);
    t.false(flatten(rejection).includes(SECRET), `odrzucenie promisy: ${flatten(rejection)}`);
    t.false(flatten(rejection).toLowerCase().includes('x-api-key'), 'nazwa nagłówka też nie ma prawa wyjść');
    t.is((rejection as NormalizedError)?.http_status, 503, 'status HTTP zostaje — diagnostyka ma działać');
});

test.serial('K20: pad Z CIAŁEM błędu — treść od dostawcy dociera bez zmian', async t => {
    const { model, transport } = make(openaiProvider, 'gpt-4o');
    const promise = model.stream(REQ, {});
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    transport.fail(401, JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    t.is((rejection as NormalizedError)?.message, 'Incorrect API key provided');
    t.is((rejection as NormalizedError)?.code, 'invalid_request_error');
    t.is((rejection as NormalizedError)?.http_status, 401);
});

test.serial('K20: obiekt żądania NIE trafia do konsumenta jako część błędu (obrona w głąb)', async t => {
    const { handlerError, rejection } = await streamFailureWithoutBody(openaiProvider, 'gpt-4o');

    const flat = flatten(handlerError) + flatten(rejection);
    t.false(flat.toLowerCase().includes('authorization'), `błąd nie może nieść nagłówków żądania: ${flat}`);
    t.false(flat.includes('"headers"'), `błąd nie może nieść całego opisu żądania: ${flat}`);
    t.false(flat.includes('"body"'), `błąd nie może nieść ciała rozmowy: ${flat}`);
});

// ── F10 (mutacje): granica normalizacji ma dwa nieprzypięte brzegi ───────────
//
// Bieg mutacyjny pokazał, że `toConsumerError` i `errorFromBody` dało się zepsuć bez ani
// jednej czerwonej lampki: awaria transportu (a nie status HTTP) i ciało błędu, którego
// nie da się wyparsować, nie miały własnego testu.

test.serial('K20: awaria transportu wychodzi ZNORMALIZOWANA i zamaskowana (nie surowym Error z fetcha)', async t => {
    const { model, transport } = make(openaiProvider, 'gpt-4o');
    let handlerError: unknown = null;
    const promise = model.stream(REQ, { error: (e: unknown) => { handlerError = e; } });
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    // Tak wygląda komunikat `fetch`: niesie CAŁY adres, a w nim klucz w query.
    transport.crash(new Error(`fetch failed: https://api.openai.com/v1/chat/completions?api_key=${SECRET}`));

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    t.truthy(rejection, 'pad transportu MUSI odrzucić promisę konkretnym błędem, nie pustką');
    t.false(rejection instanceof Error, 'do pętli wychodzi kształt kanoniczny, nie surowy obiekt sieci');
    t.is(handlerError, rejection, 'handlers.error i odrzucenie promisy to TEN SAM obiekt');
    const message = String((rejection as NormalizedError)?.message ?? '');
    t.false(message.includes(SECRET), `komunikat fetcha niesie klucz — musi zostać zamaskowany: ${message}`);
    t.true(message.includes('fetch failed'), `powód ma zostać czytelny dla usera: ${message}`);
});

test.serial('K20: nieczytelne ciało błędu (strona proxy) dociera jako zdanie — bez sekretu i bez pustki', async t => {
    const { model, transport } = make(openaiProvider, 'gpt-4o');
    const promise = model.stream(REQ, {});
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    // Proxy odbija NASZE nagłówki w stronie błędu — ciało nie jest JSON-em, a niesie klucz.
    transport.fail(502, `<html><body>Bad Gateway<br>Authorization: Bearer ${SECRET}</body></html>`);

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    t.truthy(rejection, 'ciało, którego nie da się wyparsować, nie może dać pustego odrzucenia');
    const message = String((rejection as NormalizedError)?.message ?? '');
    t.true(message.includes('Bad Gateway'), `treść strony błędu ma dojść do usera: ${message}`);
    t.false(message.includes(SECRET), `odbity nagłówek nie ma prawa wyjść jawnie: ${message}`);
    t.is((rejection as NormalizedError)?.http_status, 502, 'status zostaje — diagnostyka ma działać');
});
