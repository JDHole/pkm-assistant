/**
 * Tor BEZ strumienia — `complete()` (luka L-03, B.3 SM-17).
 *
 * Idzie przez `deps.http` (w Obsidianie `requestUrl`, poza CORS; w Node `fetch`), czyta ciało
 * jako JSON i oddaje kształt kanoniczny. Błąd dostawcy MUSI zostać znormalizowany, nie rzucony
 * surowym ciałem — inaczej `modules/agent-loop` dostaje coś, czego nie umie odczytać.
 */
import test from 'ava';
import { createChatModel } from './ChatModel.js';
import { openaiProvider } from './providers/openai.js';
import { acquireSlot } from './requestGate.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeSettings } from './testing/harness.js';
import type { ChatModelDeps, NormalizedError } from './contracts.js';

const MESSAGES = [{ role: 'user', content: 'hej' }];

function deps(overrides: Partial<ChatModelDeps> = {}): ChatModelDeps {
    return {
        provider: openaiProvider,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: 'sk-test' }),
        http: new CapturingHttpClient(),
        transport: new ScriptedTransport(),
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'openai' } }),
        ...overrides,
    };
}

test('L-03: complete() normalizuje błąd dostawcy zamiast rzucać surowym ciałem', async t => {
    const http = new CapturingHttpClient({
        status: 401,
        body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
    });
    const model = createChatModel(deps({ http }));

    const err = await model.complete({ messages: MESSAGES }).then(() => null, (e: unknown) => e) as NormalizedError | null;

    t.truthy(err, 'błąd HTTP MUSI odrzucić promisę');
    t.is(err!.message, 'Incorrect API key provided', 'komunikat dostawcy dociera jako ZDANIE');
    t.is(err!.code, 'invalid_request_error');
    t.is(err!.http_status, 401, 'status zostaje — diagnostyka ma działać');
});

test('L-03: complete() bez odpowiedzi z choices oddaje pustą wiadomość asystenta', async t => {
    const model = createChatModel(deps({ http: new CapturingHttpClient({ body: {} }) }));

    const out = await model.complete({ messages: MESSAGES });

    t.is(out.choices[0].message.content, '', 'pusta treść, nie wyjątek i nie undefined');
    t.is(out.choices[0].message.role, 'assistant');
    t.deepEqual(out.usage, {}, 'usage bez danych zostaje PUSTYM obiektem — sygnał „estymuj" dla pętli');
});

test('L-03: brak HttpClient w zależnościach jest błędem konstrukcji, nie cichym null', t => {
    const broken = deps();
    delete (broken as { http?: unknown }).http;

    const err = t.throws(() => createChatModel(broken));
    t.true(
        /http/i.test(String(err?.message ?? '')),
        `komunikat ma wskazać BRAKUJĄCĄ zależność, było: ${String(err?.message)}`,
    );
});

/**
 * F10 (mutacje): tor bez strumienia MUSI poprosić dostawcę o odpowiedź jednorazową.
 * Przestawienie flagi na `true` przechodziło cały pakiet — a serwer odesłałby wtedy SSE,
 * którego `complete()` nie umie czytać (`response.json()` na strumieniu ramek).
 */
test('L-03: complete() buduje żądanie BEZ streamu (żadnego stream:true, żadnego stream_options)', async t => {
    const http = new CapturingHttpClient({
        body: { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] },
    });
    const model = createChatModel(deps({ http }));

    await model.complete({ messages: MESSAGES });

    const body = JSON.parse(String(http.lastSpec?.body ?? '{}')) as Record<string, unknown>;
    t.is(body.stream, false, 'tor bez strumienia zamawia odpowiedź jednorazową');
    t.false('stream_options' in body, 'prośba o rozliczenie tokenów w streamie nie ma prawa wyjść w żądaniu bez streamu');
});
