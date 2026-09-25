/**
 * Pad strumienia BEZ CIAŁA nie wynosi klucza API.
 *
 * Naiwny streamer mógłby doklejać do KAŻDEGO zdarzenia siebie samego - razem z nagłówkami
 * żądania (`Authorization: Bearer …`, `x-api-key: …`). Gdy połączenie pada zanim serwer
 * cokolwiek odpisał (DNS, zerwane łącze, proxy, status != 200 przed ciałem), ciało zdarzenia
 * jest puste, więc normalizacja dostawałaby CAŁE zdarzenie i wpisywała je - przez
 * `JSON.stringify` - jako tekst do `message`. To `message` idzie do `handlers.error`, do
 * odrzucenia promisy i na ekran usera. Tu ma być `false` - i w błędzie oddanym konsumentowi,
 * i w tym, co poszło do loggera.
 *
 * ⚠️ Podział własności: nagłówek klucza W ŻĄDANIU pinuje `providers/authHeaders.test.ts`,
 * a to, że TRANSPORT nie wypuszcza nagłówków - `core/http/streamTransport.test.ts`. Tutaj
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

// Model loguje pad strumienia przez `log.error` (zawsze widoczny) - w teście to sam szum.
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

test.serial('pad strumienia bez ciała — klucz NIE wychodzi w błędzie dla konsumenta ani w logu', async t => {
    const { handlerError, rejection, logged } = await streamFailureWithoutBody(openaiProvider, 'gpt-4o');

    t.false(flatten(handlerError).includes(SECRET), `handlers.error: ${flatten(handlerError)}`);
    t.false(flatten(rejection).includes(SECRET), `odrzucenie promisy: ${flatten(rejection)}`);
    t.false(flatten(logged).includes(SECRET), `log.error: ${flatten(logged)}`);
    // To pole czat pokazuje userowi.
    t.false(String((rejection as NormalizedError)?.message ?? '').includes(SECRET));
    t.false(String((rejection as NormalizedError)?.message ?? '').toLowerCase().includes('bearer'));
    t.false(String((rejection as NormalizedError)?.message ?? '').toLowerCase().includes('authorization'));
});

test.serial('pad strumienia bez ciała — nagłówek niestandardowy (Anthropic `x-api-key`) też nie wychodzi', async t => {
    const { handlerError, rejection } = await streamFailureWithoutBody(anthropicProvider, 'claude-sonnet-4-20250514', 503);

    t.false(flatten(handlerError).includes(SECRET), `handlers.error: ${flatten(handlerError)}`);
    t.false(flatten(rejection).includes(SECRET), `odrzucenie promisy: ${flatten(rejection)}`);
    t.false(flatten(rejection).toLowerCase().includes('x-api-key'), 'nazwa nagłówka też nie ma prawa wyjść');
    t.is((rejection as NormalizedError)?.http_status, 503, 'status HTTP zostaje — diagnostyka ma działać');
});

test.serial('pad Z CIAŁEM błędu — treść od dostawcy dociera bez zmian', async t => {
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

test.serial('obiekt żądania NIE trafia do konsumenta jako część błędu (obrona w głąb)', async t => {
    const { handlerError, rejection } = await streamFailureWithoutBody(openaiProvider, 'gpt-4o');

    const flat = flatten(handlerError) + flatten(rejection);
    t.false(flat.toLowerCase().includes('authorization'), `błąd nie może nieść nagłówków żądania: ${flat}`);
    t.false(flat.includes('"headers"'), `błąd nie może nieść całego opisu żądania: ${flat}`);
    t.false(flat.includes('"body"'), `błąd nie może nieść ciała rozmowy: ${flat}`);
});

// ── Granica normalizacji ma dwa nieprzypięte brzegi ───────────
//
// Bieg mutacyjny pokazał, że `toConsumerError` i `errorFromBody` dało się zepsuć bez ani
// jednej czerwonej lampki: awaria transportu (a nie status HTTP) i ciało błędu, którego
// nie da się wyparsować, nie miały własnego testu.

test.serial('awaria transportu wychodzi ZNORMALIZOWANA i zamaskowana (nie surowym Error z fetcha)', async t => {
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

// ── Ciało błędu Z KLUCZEM NIESTANDARDOWYM odbitym przez dostawcę/proxy ───
//
// Klucz użyty w TYM żądaniu (`SECRET`, patrz `make()`) nie ma znanego prefiksu (`sk-`/`gsk_`/…),
// więc maska po wzorcu (`maskSensitiveData`) sama go nie złapie — jedyna warstwa, która może,
// to redakcja PO WARTOŚCI klucza z kontekstu żądania (`this._ctx.apiKey`, `errorFromBody`).

test.serial('ciało błędu Z KLUCZEM (odbitym przez dostawcę/proxy w JSON-ie) — klucz NIE wychodzi w komunikacie', async t => {
    const { model, transport } = make(openaiProvider, 'gpt-4o');
    const promise = model.stream(REQ, {});
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    transport.fail(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${SECRET}` } }));

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    const message = String((rejection as NormalizedError)?.message ?? '');
    t.false(message.includes(SECRET), `klucz użyty w żądaniu, odbity przez dostawcę w treści błędu, musi zostać zredagowany: ${message}`);
    t.is(message, 'Incorrect API key provided: [REDACTED]');
});

test.serial('nieczytelne ciało błędu (strona proxy) dociera jako zdanie — bez sekretu i bez pustki', async t => {
    const { model, transport } = make(openaiProvider, 'gpt-4o');
    const promise = model.stream(REQ, {});
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    // Proxy odbija NASZE nagłówki w stronie błędu - ciało nie jest JSON-em, a niesie klucz.
    transport.fail(502, `<html><body>Bad Gateway<br>Authorization: Bearer ${SECRET}</body></html>`);

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    t.truthy(rejection, 'ciało, którego nie da się wyparsować, nie może dać pustego odrzucenia');
    const message = String((rejection as NormalizedError)?.message ?? '');
    t.true(message.includes('Bad Gateway'), `treść strony błędu ma dojść do usera: ${message}`);
    t.false(message.includes(SECRET), `odbity nagłówek nie ma prawa wyjść jawnie: ${message}`);
    t.is((rejection as NormalizedError)?.http_status, 502, 'status zostaje — diagnostyka ma działać');
});

test.serial('ciało nieczytelne z kluczem NA GRANICY ucięcia 500 znaków — klucz nie wychodzi nawet połówką', async t => {
    const { model, transport } = make(openaiProvider, 'gpt-4o');
    const promise = model.stream(REQ, {});
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    // 490 znaków wypełniacza + klucz (27 znaków) siedzi dokładnie w oknie 490-516 — `slice(0,
    // 500)` przecięłoby go w połowie, gdyby redakcja PO WARTOŚCI nie poszła najpierw na CAŁYM,
    // nieuciętym ciele.
    const padding = 'X'.repeat(490);
    transport.fail(502, `${padding}${SECRET} — strona błędu proxy`);

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    const message = String((rejection as NormalizedError)?.message ?? '');
    const head = SECRET.slice(0, 8);
    const tail = SECRET.slice(-8);
    t.false(message.includes(head), `głowa klucza nie ma prawa wyjść nawet ucięta na granicy 500 znaków: ${message}`);
    t.false(message.includes(tail), `ogon klucza nie ma prawa wyjść nawet ucięty na granicy 500 znaków: ${message}`);
    // Asercje pozytywne - test kontrolny: przy pustym `message` albo null-owym odrzuceniu
    // powyższe dwa `t.false` przeszłyby fałszywie zielono (pusty string nie zawiera niczego).
    t.true(message.startsWith(padding), `komunikat ma zaczynać się od wypełniacza sprzed klucza: ${message}`);
    t.true(message.includes('[REDACTED'), `token redakcji ma zostać widoczny: ${message}`);
});

// ── Ciało JSON z kluczem NA GRANICY ucięcia 4000 znaków (`normalizeError`) ───
//
// `errorFromBody` redaguje SUROWY obiekt (`redactSecretsDeep`) PRZED `normalizeError` - klucz
// znika z tekstu, ZANIM `normalizeError` przytnie go do limitu długości. Cięcie przed redakcją
// rozrywałoby klucz siedzący na granicy i połowa wychodziłaby w komunikacie.

test.serial('ciało JSON z kluczem na granicy ucięcia 4000 znaków — żadne okno klucza nie wychodzi', async t => {
    const { model, transport } = make(openaiProvider, 'gpt-4o');
    const promise = model.stream(REQ, {});
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    // 3995 znaków wypełniacza + klucz (26 znaków) siedzi w oknie 3995-4021 — dokładnie na
    // granicy `MAX_ERROR_MESSAGE_LENGTH` (4000). Redakcja musi zdążyć PRZED cięciem.
    const padding = 'Y'.repeat(3995);
    transport.fail(400, JSON.stringify({ error: { message: `${padding}${SECRET} tail` } }));

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    const message = String((rejection as NormalizedError)?.message ?? '');
    for (let i = 0; i <= SECRET.length - 5; i++) {
        const window = SECRET.slice(i, i + 5);
        t.false(message.includes(window), `okno klucza "${window}" nie ma prawa wyjść w żadnym miejscu: ${message}`);
    }
    // Asercja pozytywna - test kontrolny: pusty/null-owy komunikat przeszłyby powyższe `t.false`
    // fałszywie zielono. Token redakcji bywa PRZYCIĘTY razem z resztą (leży na tej samej
    // granicy 4000 znaków, którą właśnie testujemy) - liczy się, że tekst SPRZED klucza dotarł.
    t.true(message.startsWith(padding.slice(0, 100)), `komunikat ma zaczynać się od wypełniacza sprzed klucza: ${message}`);
});

test.serial('klucz z końcową nową linią w ustawieniach redaguje treść błędu bez tej linii (trim przed porównaniem)', async t => {
    const transport = new ScriptedTransport();
    const model = new ChatModel({
        provider: openaiProvider,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: `${SECRET}\n` }),
        http: new CapturingHttpClient(),
        transport,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: openaiProvider.info.id } }),
    });
    const promise = model.stream(REQ, {});
    for (let i = 0; i < 50 && transport.opens === 0; i++) await new Promise(res => setImmediate(res));
    // Nagłówek żądania idzie po `.trim()` (`buildHeaders`), więc treść błędu odbita przez
    // dostawcę/proxy niesie klucz BEZ tej końcowej nowej linii — porównanie po wartości musi
    // widzieć ten sam ciąg co nagłówek, nie surowe ustawienie z `\n` na końcu.
    transport.fail(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${SECRET}` } }));

    let rejection: unknown = null;
    try { await promise; } catch (e) { rejection = e; }

    const message = String((rejection as NormalizedError)?.message ?? '');
    t.false(message.includes(SECRET), `klucz z końcową nową linią w ustawieniach musi zredagować treść błędu bez niej: ${message}`);
    t.is(message, 'Incorrect API key provided: [REDACTED]');
});
