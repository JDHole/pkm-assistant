/**
 * K5 (AUD-bledy-004/005/006/007/008/051/052) — strumień zna TRZY wyjścia.
 *
 * Model znał dotąd dwa: sentinel platformy (`data: [DONE]`, `message_stop`, `done_reason`)
 * i błąd transportu. Zamknięcie połączenia przy HTTP 200 BEZ sentinela nie miało jak
 * rozstrzygnąć promisy — a konsumenci, którzy rozstrzygają się WYŁĄCZNIE na `handlers.done`
 * (Summarizer, web/summarize), nie wracali nigdy, a slot bramki platform lokalnych zostawał
 * zajęty. Do tego trzy dziury obok: błąd zgłoszony W PAŚMIE ginął, zepsuta porcja SSE znikała
 * bez logu, a pętla retry 429 nie znała Stopu.
 *
 * ⚠️ Plik testuje TRZY WYJŚCIA MODELU, nie transport. Transportowa połowa (czy `open()` przestaje
 * czytać, czy nie wypuszcza nagłówków) mieszka w `core/http/streamTransport.test.ts`.
 *
 * CAŁY plik `test.serial`: bramka `requestGate` jest globalna.
 */
import test from 'ava';
import { ChatModel } from './ChatModel.js';
import { openaiProvider } from './providers/openai.js';
import { lmStudioProvider } from './providers/lm_studio.js';
import { ollamaProvider } from './providers/ollama.js';
import { __test__ as gateTest, acquireSlot } from './requestGate.js';
import { log } from '../../core/utils/Logger.js';
import { STREAM_TRANSPORT_TIMEOUT_MS } from '../../core/index.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeSettings } from './testing/harness.js';
import type { ChatProvider, ChatRequest, OpenAiCompletion, StreamHandlers, StreamTransport } from './contracts.js';

const SECRET = 'sk-proj-TAJNY0123456789ABCDEFGHIJ';

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'czesc' }], max_tokens: 128 };

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const WISI = Symbol('promisa nie rozstrzygnięta');

/** Czeka na rozstrzygnięcie albo oddaje `WISI` — zamiast wieszać cały bieg testów. */
async function settleOrHang(p: Promise<unknown>, ms = 2000): Promise<unknown> {
    return Promise.race([
        p.then(v => ({ ok: v }), e => ({ err: e })),
        delay(ms).then(() => WISI),
    ]);
}

/** Odpytuje `predicate` co makrozadanie, zamiast realnie spać na sztywno. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor: przekroczony czas oczekiwania');
        await new Promise<void>(res => setImmediate(res));
    }
}

const contentOf = (resp: unknown): string =>
    String((resp as OpenAiCompletion)?.choices?.[0]?.message?.content || '');

/** Model + jego transport skryptowany z testu (zamiennik globalnej atrapy XHR). */
function make(provider: ChatProvider = openaiProvider, platform = 'openai', Cls: typeof ChatModel = ChatModel) {
    const transport = new ScriptedTransport();
    const http = new CapturingHttpClient();
    const model = new Cls({
        provider,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: SECRET }),
        http,
        transport,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform }, limits: { local_platform_max_concurrent: 1 } }),
    });
    return { model, transport, http };
}

// ── Cisza w konsoli ──────────────────────────────────────────────────────────

const REAL_CONSOLE_ERROR = console.error;
const REAL_CONSOLE_WARN = console.warn;

test.before(() => {
    console.error = () => { /* cisza */ };
    console.warn = () => { /* cisza */ };
});
test.after.always(() => {
    console.error = REAL_CONSOLE_ERROR;
    console.warn = REAL_CONSOLE_WARN;
});
test.beforeEach(() => { gateTest.reset(); });

// ── AUD-bledy-004: zamknięcie transportu bez sentinela ───────────────────────

test.serial('004: transport domknięty bez sentinela oddaje to, co przyszło (resolve + handlers.done)', async t => {
    const { model, transport } = make();
    let doneResp: unknown = null;
    const p = model.stream(REQ, { done: (r) => { doneResp = r; } });

    await waitFor(() => transport.opens === 1);
    transport.push('data: {"id":"x1","choices":[{"delta":{"content":"Ala "}}]}\n\n');
    transport.push('data: {"choices":[{"delta":{"content":"ma kota."}}]}\n\n');
    transport.closeOk(); // HTTP 200, połączenie zamknięte, ŻADNEGO `data: [DONE]`

    const out = await settleOrHang(p);
    t.not(out, WISI, 'promisa MUSI się rozstrzygnąć — inaczej Summarizer i web/summarize wiszą bez końca');
    t.is(contentOf((out as { ok?: unknown })?.ok), 'Ala ma kota.', 'treść, która przyszła, nie może przepaść');
    t.truthy(doneResp, 'handlers.done MUSI dojść — konsument rozstrzyga się TYLKO na nim');
    t.is(contentOf(doneResp), 'Ala ma kota.');
});

test.serial('004: zamknięcie bez sentinela i bez treści — odrzucenie z jasnym powodem', async t => {
    const { model, transport } = make();
    let handlerError: unknown = null;
    const p = model.stream(REQ, { error: (e) => { handlerError = e; } });

    await waitFor(() => transport.opens === 1);
    transport.closeOk(); // 200, zero treści, zero sentinela

    const out = await settleOrHang(p);
    t.not(out, WISI, 'pusty pad też musi rozstrzygnąć promisę');
    const err = (out as { err?: { message?: string } })?.err;
    t.truthy(err, 'brak treści = błąd, nie udana tura');
    t.true((err!.message || '').length > 20 && (err!.message || '').includes(' '), `powód ma być zdaniem, było: ${err?.message}`);
    t.truthy(handlerError, 'handlers.error też ma dostać powód');
});

test.serial('004: zamknięcie bez sentinela zwalnia slot bramki (następny stream wjeżdża)', async t => {
    class FastModel extends ChatModel { static override GATE_RELEASE_COOLDOWN_MS = 20; }

    const first = make(lmStudioProvider, 'lm_studio', FastModel);
    const p1 = first.model.stream(REQ, {});
    await waitFor(() => first.transport.opens === 1); // bramka wpuszcza na slot, dopiero potem leci żądanie
    first.transport.push('data: {"choices":[{"delta":{"content":"czesc"}}]}\n\n');
    first.transport.closeOk();
    await settleOrHang(p1);

    const second = make(lmStudioProvider, 'lm_studio', FastModel);
    const p2 = second.model.stream(REQ, {});
    await delay(120); // cooldown zwolnienia slotu = 20 ms

    t.is(second.transport.opens, 1, 'slot bramki wolny — drugi request faktycznie ruszył, nie stoi w kolejce');
    second.model.stopStream();
    await p2.catch(() => { /* sprzątanie */ });
});

test.serial('004: sentinel w OSTATNIEJ porcji wygrywa z zamknięciem transportu (zero skracania)', async t => {
    const warns: string[] = [];
    const realWarn = log.warn;
    (log as unknown as { warn: unknown }).warn = (_mod: string, message: string) => { warns.push(message); };
    try {
        const { model, transport } = make();
        const p = model.stream(REQ, {});
        await waitFor(() => transport.opens === 1);
        transport.push('data: {"choices":[{"delta":{"content":"pelna odpowiedz"}}]}\n\n');
        // Sentinel dochodzi RAZEM z domknięciem połączenia — tak wygląda poprawny koniec streamu.
        transport.push('data: [DONE]\n\n');
        transport.closeOk();

        const out = await settleOrHang(p);
        t.is(contentOf((out as { ok?: unknown })?.ok), 'pelna odpowiedz', 'poprawna odpowiedź nie może zostać ucięta');
        t.false(warns.some(w => w.includes('closed_without_sentinel')), `sentinel przyszedł — trzecia ścieżka ma się NIE odpalić: ${JSON.stringify(warns)}`);
    } finally {
        (log as unknown as { warn: unknown }).warn = realWarn;
    }
});

test.serial('004: własny sentinel platformy (Ollama `done_reason`) też wygrywa z zamknięciem', async t => {
    const warns: string[] = [];
    const realWarn = log.warn;
    (log as unknown as { warn: unknown }).warn = (_mod: string, message: string) => { warns.push(message); };
    try {
        const { model, transport } = make(ollamaProvider, 'ollama');
        const p = model.stream(REQ, {});
        await waitFor(() => transport.opens === 1);
        transport.push('{"model":"llama3","message":{"role":"assistant","content":"hej"},"done":false}\n');
        transport.push('{"model":"llama3","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n');
        transport.closeOk();

        const out = await settleOrHang(p);
        t.is(contentOf((out as { ok?: unknown })?.ok), 'hej', 'sentinel Ollamy rozstrzyga jak dotąd');
        t.false(warns.some(w => w.includes('closed_without_sentinel')), `własny sentinel platformy ma wygrać: ${JSON.stringify(warns)}`);
    } finally {
        (log as unknown as { warn: unknown }).warn = realWarn;
    }
});

// ── AUD-bledy-006: błąd zgłoszony w paśmie ──────────────────────────────────

test.serial('006: pole `error` w chunku przy HTTP 200 — handlers.error dostaje ZDANIE', async t => {
    const { model, transport } = make();
    let handlerError: unknown = null;
    const p = model.stream(REQ, { error: (e) => { handlerError = e; } });

    await waitFor(() => transport.opens === 1);
    transport.push('data: {"choices":[{"delta":{"content":"zaczynam"}}]}\n\n');
    transport.push('data: {"error":{"message":"Upstream provider is overloaded, try again later.","type":"server_error"}}\n\n');

    const out = await settleOrHang(p);
    t.not(out, WISI, 'błąd w paśmie ma rozstrzygnąć promisę, nie zostawić jej w PENDING');
    t.truthy(handlerError, 'handlers.error MUSI zostać wywołany — inaczej user nie widzi ani zdania, ani logu');
    const msg = String((handlerError as { message?: string })?.message || '');
    t.is(msg, 'Upstream provider is overloaded, try again later.', `komunikat ma być zdaniem dostawcy, było: ${msg}`);
    t.false(msg.startsWith('{"0"'), 'komunikat nie może być stringiem rozsypanym na znaki');
});

// ── AUD-bledy-008/052: niesparsowalna porcja SSE ────────────────────────────

test.serial('008/052: zepsuta porcja `data:` zostawia ślad w logu, a strumień jedzie dalej', async t => {
    const warns: Array<{ message: string; data: unknown[] }> = [];
    const realWarn = log.warn;
    (log as unknown as { warn: unknown }).warn = (_mod: string, message: string, ...data: unknown[]) => {
        warns.push({ message, data });
    };

    try {
        const { model, transport } = make();
        const p = model.stream(REQ, {});
        await waitFor(() => transport.opens === 1);
        transport.push('data: {"choices":[{"delta":{"content":"Pierwsza czesc. "}}]}\n\n');
        // Urwana transmisja w środku linii: `data:` jest, JSON-a nie ma. W ciele siedzi coś,
        // co wygląda jak klucz — log nie ma prawa go wypisać.
        transport.push(`data: {"choices":[{"delta":{"content":"${SECRET}\n\n`);
        transport.push('data: {"choices":[{"delta":{"content":"Trzecia czesc."}}]}\n\n');
        transport.push('data: [DONE]\n\n');

        const out = await settleOrHang(p);
        t.not(out, WISI);
        t.is(contentOf((out as { ok?: unknown })?.ok), 'Pierwsza czesc. Trzecia czesc.', 'jedna zła porcja NIE zabija strumienia');

        const hit = warns.find(w => w.message.includes('chunk_parse_failed'));
        t.truthy(hit, `zepsuta porcja ma zostawić log.warn; zebrane: ${JSON.stringify(warns.map(w => w.message))}`);
        const flat = JSON.stringify(hit!.data);
        t.true(flat.includes('openai'), `log ma nieść nazwę platformy: ${flat}`);
        t.false(flat.includes(SECRET), `log nie może wypisać sekretu z porcji: ${flat}`);
    } finally {
        (log as unknown as { warn: unknown }).warn = realWarn;
    }
});

test.serial('008/052: POPRAWNA ramka bez zdarzeń NIE zostawia ostrzeżenia (koniec 2 fałszywych alarmów na turę)', async t => {
    const warns: string[] = [];
    const realWarn = log.warn;
    (log as unknown as { warn: unknown }).warn = (_mod: string, message: string, ...data: unknown[]) => {
        warns.push(message);
        void data;
    };

    try {
        const { model, transport } = make();
        const p = model.stream(REQ, {});
        await waitFor(() => transport.opens === 1);
        // Dokładnie tak wygląda normalna tura OpenAI: pierwsza ramka niesie samą rolę i pustą
        // treść, przedostatnia — sam `finish_reason`. Obie są poprawnym JSON-em i obie
        // wychodzą z dekodera bez ani jednego zdarzenia.
        transport.push('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n');
        transport.push('data: {"choices":[{"delta":{"content":"Odpowiedz."}}]}\n\n');
        transport.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        transport.push('data: [DONE]\n\n');

        const out = await settleOrHang(p);
        t.not(out, WISI);
        t.is(contentOf((out as { ok?: unknown })?.ok), 'Odpowiedz.', 'treść tury bez zmian');
        t.deepEqual(
            warns.filter(m => m.includes('chunk_parse_failed')),
            [],
            `zwykła tura nie ma prawa zostawić ani jednego chunk_parse_failed; zebrane: ${JSON.stringify(warns)}`,
        );
    } finally {
        (log as unknown as { warn: unknown }).warn = realWarn;
    }
});

// ── AUD-bledy-005/051: Stop w oknie backoffu 429 ────────────────────────────

test.serial('005/051: Stop w oknie backoffu 429 — drugie żądanie NIE leci', async t => {
    const { model, transport } = make();
    const p = model.stream(REQ, {});

    await waitFor(() => transport.opens === 1);
    // 429 → pętla retry wchodzi w backoff (1500 ms)
    transport.fail(429, JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } }));

    await delay(20);
    model.stopStream(); // user klika Stop / strzela budzik pętli — DOKŁADNIE w oknie backoffu

    const out = await settleOrHang(p, 1800);
    t.is(transport.opens, 1, 'po Stopie w backoffie NIE wolno wysłać nowego, płatnego żądania');
    t.not(out, WISI, 'promisa ma się rozstrzygnąć jako przerwana, nie wisieć do końca backoffu');
    t.true(Boolean((out as { err?: { _aborted?: boolean } })?.err?._aborted), 'znacznik przerwania (pętla mapuje go na stoppedBy:abort)');
});

// ── AUD-testy-012: polityka odporności strumienia (sufit ponowień, timeout transportu) ──────
//
// `STREAM_MAX_RETRIES = 3` i `STREAM_RETRY_BASE_DELAY_MS = 1500` (kontrakt klastra) oraz twardy
// `STREAM_TRANSPORT_TIMEOUT_MS` (H1 fix, „prevent indefinite hang", kontrakt `core/http`) nie
// miały dotąd ANI pinu wartości, ANI testu zachowania — jedyny istniejący test pętli retry
// (005/051 wyżej) sprawdza Stop w oknie backoffu, nie samą politykę. Test sufitu fast-forwarduje
// okno backoffu przez `_retryWake` — TEN SAM hak, którego używa produkcyjny `stopStream()` do
// budzenia backoffu — więc nie czeka realnie na sumę 1500+3000+6000 ms timerów.
//
// ⚠️ Kształt wykładniczy backoffu (×2 na próbę) pinuje osobny plik: `ChatModel.retry.test.ts`
// (seam `ChatModel.scheduleRetry`, zero realnego czekania). Sufit liczby prób jest przypięty
// BEHAWIORALNIE tutaj (dokładnie 4 żądania).

test.serial('012: sufit ponowień 429 — dokładnie MAX_RETRIES+1 prób, potem odrzucenie błędem 429 (nie kolejne żądanie)', async t => {
    const { model, transport } = make();
    const wakeable = model as ChatModel & { _retryWake?: (() => void) | null };
    const p = model.stream(REQ, {});

    // Cztery rundy: próba początkowa + trzy ponowienia, KAŻDA odpowiada 429.
    for (let round = 0; round < 4; round++) {
        await waitFor(() => transport.opens === round + 1);
        transport.fail(429, JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } }));
        if (round < 3) {
            // Ostatnia (4.) runda NIE otwiera nowego okna backoffu — sufit ma się tu zatrzymać.
            await waitFor(() => Boolean(wakeable._retryWake));
            wakeable._retryWake!();
        }
    }

    const out = await settleOrHang(p, 3000);
    t.not(out, WISI, 'po wyczerpaniu sufitu promisa ma się rozstrzygnąć, nie wisieć');
    t.is(transport.opens, 4, 'sufit: próba początkowa + STREAM_MAX_RETRIES(3) ponowień = 4 żądania, ani jedno więcej');
    const err = (out as { err?: { http_status?: number } })?.err;
    t.truthy(err, 'po wyczerpaniu ponowień promisa ma się ODRZUCIĆ błędem, nie cicho zresolwować kolejnym żądaniem');
    t.is(err!.http_status, 429);
});

test.serial('012: PIN — transport dostaje twardy timeout DOKŁADNIE 600000ms (H1 fix: "prevent indefinite hang")', async t => {
    const { model, transport } = make();
    const p = model.stream(REQ, {});
    await waitFor(() => transport.lastSpec !== null);

    t.is(transport.lastSpec!.timeoutMs, STREAM_TRANSPORT_TIMEOUT_MS, 'żądanie ma nieść dokładnie twardy limit z kontraktu core/http — brak limitu = strumień wisi bez końca');
    t.is(STREAM_TRANSPORT_TIMEOUT_MS, 600000, 'wartość jest faktem kontraktowym, nie liczbą z sufitu');

    // Sprzątanie tury, żeby nie zostawić wiszącej promisy w tle po tym teście.
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await settleOrHang(p);
});

// ── AUD-bledy-007: katalog modeli bez sieci ─────────────────────────────────

test.serial('007: brak sieci przy katalogu modeli — listModels oddaje pustą listę zamiast TypeError', async t => {
    const { model, http } = make();
    http.throwOn(new Error('net down'));

    const models = await settleOrHang(model.listModels(true));
    t.not(models, WISI);
    t.falsy((models as { err?: unknown })?.err, `listModels nie ma rzucać przy braku sieci: ${String((models as { err?: { message?: string } })?.err?.message)}`);
    t.deepEqual((models as { ok?: unknown })?.ok, [], 'pusta LISTA, nie wyjątek i nie mapa');
});

test.serial('007: fire-and-forget listModels() ma właściciela odrzucenia (zero unhandled rejection)', async t => {
    const { model, http } = make();
    http.throwOn(new Error('net down'));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
        void model.listModels(); // dropdown w Ustawieniach — BEZ await
        for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    t.deepEqual(unhandled, [], 'odświeżenie listy w tle nie może zostawić nieobsłużonego odrzucenia');
});

/**
 * N06 (spec §5 „abort w środku ramki", B.3 SM-07): Stop w POŁOWIE ramki nie może wypuścić
 * połowicznej treści do konsumenta. ⚠️ To inny test niż transportowy odpowiednik w
 * `core/http/streamTransport.test.ts`: tam sprawdzamy, że transport przestaje czytać —
 * tu, że MODEL rozstrzyga promisę i nie oddaje śmiecia.
 */
test.serial('abort w ŚRODKU ramki nie oddaje połowicznej treści', async t => {
    const { model, transport } = make();
    const chunks: OpenAiCompletion[] = [];
    const handlers: StreamHandlers = { chunk: (r) => { chunks.push(r); } };
    const p = model.stream(REQ, handlers);

    await waitFor(() => transport.opens === 1);
    transport.push('data: {"choices":[{"delta":{"content":"Ala "}}]}\n\n');
    transport.push('data: {"cho'); // ramka URWANA w połowie
    model.stopStream();

    const out = await settleOrHang(p);
    const err = (out as { err?: { _aborted?: boolean } })?.err;
    t.true(Boolean(err?._aborted), 'Stop rozstrzyga promisę znacznikiem przerwania');

    const seen = chunks.map(c => String(c.choices[0].message.content ?? ''));
    for (const text of seen) {
        t.false(text.includes('{"cho'), `połowiczna ramka nie może wyciec do konsumenta: ${text}`);
    }
});

/**
 * N42 (B.5, harness `errorTurn`): 429 jest retryowalne, 500 nie — twardy błąd HTTP przed
 * ciałem kończy turę od razu, bez ani jednego ponowienia.
 */
test.serial('HTTP 500 przed ciałem: handlers.error + reject, zero prób ponowienia', async t => {
    const { model, transport } = make();
    let handlerError: unknown = null;
    const p = model.stream(REQ, { error: (e) => { handlerError = e; } });

    await waitFor(() => transport.opens === 1);
    transport.fail(500, JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }));

    const out = await settleOrHang(p);
    t.not(out, WISI);
    t.is(transport.opens, 1, '500 NIE jest retryowalne — ani jednego ponowienia');
    t.truthy(handlerError, 'handlers.error MUSI dostać błąd');
    t.is((out as { err?: { http_status?: number } })?.err?.http_status, 500);
});

// ── F10 (mutacje): zachowania, które dotąd nie miały strażnika ───────────────
//
// Poniższe testy powstały z biegu mutacyjnego na `ChatModel.ts`: każdy pinuje zachowanie,
// którego zmiana przechodziła cały pakiet bez ani jednej czerwonej lampki.

test.serial('ramka z SAMYM rozliczeniem tokenów nie odmalowuje bańki (chunk leci tylko za widoczną treścią)', async t => {
    const { model, transport } = make();
    const chunks: OpenAiCompletion[] = [];
    const p = model.stream(REQ, { chunk: (r) => { chunks.push(r); } });

    await waitFor(() => transport.opens === 1);
    transport.push('data: {"choices":[{"delta":{"content":"Odpowiedz."}}]}\n\n');
    // Ostatnia ramka OpenAI z `stream_options.include_usage`: zero treści, samo rozliczenie.
    transport.push('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n');
    transport.push('data: [DONE]\n\n');
    transport.closeOk();

    const out = await settleOrHang(p);
    t.not(out, WISI);
    const resp = (out as { ok?: OpenAiCompletion }).ok!;
    t.is(contentOf(resp), 'Odpowiedz.');
    t.is(chunks.length, 1, 'ani ramka rozliczeniowa, ani sentinel nie niosą treści — nie mają prawa wołać handlers.chunk');
    t.is(resp.usage.prompt_tokens, 11, 'samo rozliczenie ma jednak dojść do odpowiedzi (pętla przestaje estymować)');
});

test.serial('sentinel przeczytany PO domknięciu ciała kończy turę sukcesem — bez handlers.error', async t => {
    // Transport oddaje 200, a ostatnie ramki wypuszcza dopiero w kolejnym makrozadaniu.
    // Dokładnie ten wyścig, dla którego model odracza decyzję o „zamknięciu bez sentinela".
    const lateTransport: StreamTransport = {
        open: (_spec, sink) => {
            setTimeout(() => {
                sink.onChunk('data: {"choices":[{"delta":{"content":"spozniona tresc"}}]}\n\n');
                sink.onChunk('data: [DONE]\n\n');
            }, 0);
            return Promise.resolve({ status: 200, headers: {}, body: '' });
        },
    };
    const model = new ChatModel({
        provider: openaiProvider,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: SECRET }),
        http: new CapturingHttpClient(),
        transport: lateTransport,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'openai' } }),
    });

    const errors: unknown[] = [];
    const out = await settleOrHang(model.stream(REQ, { error: (e) => { errors.push(e); } }));

    t.not(out, WISI);
    t.is(contentOf((out as { ok?: unknown })?.ok), 'spozniona tresc', 'ramka przeczytana po domknięciu ciała nie może przepaść');
    t.deepEqual(errors, [], 'udana tura nie ma prawa zawołać handlers.error — pętla pokazałaby userowi błąd pod gotową odpowiedzią');
});

test.serial('Stop w handlerze gate_admitted nie wypuszcza ANI JEDNEGO żądania', async t => {
    // User klika Stop w tej samej milisekundzie, w której bramka wpuszcza turę na slot.
    // Żądanie jest PŁATNE, więc po Stopie nie ma prawa polecieć — nawet to pierwsze.
    const { model, transport } = make();
    const p = model.stream(REQ, { gate_admitted: () => { model.stopStream(); } });

    const out = await settleOrHang(p, 500);
    t.not(out, WISI, 'Stop w tym oknie MUSI rozstrzygnąć promisę');
    t.true(Boolean((out as { err?: { _aborted?: boolean } })?.err?._aborted), 'znacznik przerwania (pętla mapuje go na stoppedBy:abort)');
    t.is(transport.opens, 0, 'po Stopie NIE wolno otworzyć strumienia — to jest cała stawka tego testu');
});

test.serial('druga tura na TEJ SAMEJ instancji rozstrzyga pierwszą zdaniem (zero wiszących promis)', async t => {
    const { model, transport } = make();
    const p1 = model.stream(REQ, {});
    await waitFor(() => transport.opens === 1);

    const p2 = model.stream(REQ, {}); // ktoś odpalił drugą turę na tej samej instancji

    const out1 = await settleOrHang(p1, 500);
    t.not(out1, WISI, 'przykryta tura MUSI dostać rozstrzygnięcie — inaczej jej konsument wisi na await bez końca');
    const err = (out1 as { err?: { message?: string } })?.err;
    t.truthy(err, 'stara tura kończy się BŁĘDEM, nie cichym resolve');
    t.regex(String(err?.message ?? ''), /Poprzednia tura/, `powód ma nazywać przyczynę, było: ${String(err?.message)}`);

    await waitFor(() => transport.opens === 2);
    transport.push('data: {"choices":[{"delta":{"content":"druga"}}]}\n\n');
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    const out2 = await settleOrHang(p2);
    t.is(contentOf((out2 as { ok?: unknown })?.ok), 'druga', 'nowa tura jedzie normalnie');
});
