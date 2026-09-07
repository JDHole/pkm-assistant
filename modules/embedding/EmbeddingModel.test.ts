/**
 * EmbeddingModel.test.ts — kontrakt modelu embeddingu (clean-room / F4, `contracts.ts` §6).
 *
 * Reshape `embed_adapter_base.test.ts` (13 testów, EB-01..EB-13, minus EB-08/EB-10 które
 * poszły do `providers/openai.test.ts` — kształt żądania/odpowiedzi jest sprawą dostawcy,
 * nie modelu) + `gemini_adapter.test.ts` (GM-01, GM-02, GM-05 — backoff jest dziś WSPÓLNY
 * dla wszystkich dostawców, nie tylko Gemini) + nowe testy C-01..C-09 (luki katalogu).
 *
 * Vehicle: `openAiEmbeddingProvider` (prawdziwy provider produkcyjny) + wstrzyknięty `http`.
 * Kształt żądania/odpowiedzi jest tu tylko NOŚNIKIEM — asercje mierzą MODEL (retry, backoff,
 * sufit czasu, przycinanie, kontrakt N→N), nie dostawcę.
 *
 * Napisany przed implementacją (czerwony na stubie — `EmbeddingModel` rzucał `not implemented`
 * w konstruktorze, więc WSZYSTKIE testy tego pliku były czerwone z tego jednego powodu),
 * dziś zielony.
 */
import test from 'ava';
import { EmbeddingModel } from './EmbeddingModel.js';
import { openAiEmbeddingProvider, geminiEmbeddingProvider } from './providers/index.js';
import { isEmbedBatchError } from './embedErrors.js';
import {
    MAX_BACKOFF_FACTOR,
    DEFAULT_EMBED_TIMEOUT_MS,
    EMBED_TIMEOUT_MIN_MS,
    EMBED_TIMEOUT_MAX_MS,
    DEFAULT_MAX_INPUT_TOKENS,
    OPENAI_EMBED_BASE_URL,
} from './contracts.js';
import type {
    EmbeddingModelDeps,
    EmbeddingProvider,
    EmbeddingProviderContext,
    HttpClient,
    HttpRequestSpec,
    HttpResponse,
} from './contracts.js';

// ── Atrapy wspólne ───────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
    const text = JSON.stringify(body);
    return { status, headers, text, json: <T>() => JSON.parse(text) as T };
}

function makeCtx(overrides: Partial<EmbeddingProviderContext> = {}): EmbeddingProviderContext {
    return {
        modelId: 'text-embedding-3-small',
        apiKey: 'sk-test-dummy',
        endpoint: OPENAI_EMBED_BASE_URL,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        ...overrides,
    };
}

/** Http z kolejką odpowiedzi/callbacków po numerze wywołania (1-indexed). */
function fakeHttp(
    responder: (spec: HttpRequestSpec, callIndex: number) => HttpResponse | Promise<HttpResponse>,
): { http: HttpClient; calls: HttpRequestSpec[] } {
    const calls: HttpRequestSpec[] = [];
    const http: HttpClient = {
        async send(spec) {
            calls.push(spec);
            return responder(spec, calls.length);
        },
    };
    return { http, calls };
}

function embeddingOf(text: string, len = 3): number[] {
    return Array.from({ length: len }, (_, i) => text.length + i);
}

function openAiSuccessBody(texts: string[]): unknown {
    return {
        data: texts.map(t => ({ embedding: embeddingOf(t) })),
        usage: { total_tokens: texts.join('').length },
    };
}

function baseDeps(overrides: Partial<EmbeddingModelDeps> = {}): EmbeddingModelDeps {
    const { http } = fakeHttp(() => jsonResponse(200, openAiSuccessBody(['x'])));
    return {
        provider: openAiEmbeddingProvider,
        ctx: makeCtx(),
        http,
        retryBaseMs: 1,
        backoffWaitMs: 1,
        sleep: async () => { /* no-op w testach */ },
        ...overrides,
    };
}

// ── EB-01 ────────────────────────────────────────────────────────────────────

test('padnięty transport RZUCA (kind: transport), jedno żądanie', async t => {
    const calls: HttpRequestSpec[] = [];
    const http: HttpClient = {
        async send(spec) {
            calls.push(spec);
            throw new Error('ECONNREFUSED');
        },
    };
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(['hello']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) t.is(err.kind, 'transport');
    t.is(calls.length, 1, 'transport padnięty raz — brak ponowienia (to nie 429)');
});

// ── EB-02 ────────────────────────────────────────────────────────────────────

test('429 jest ponawiany i po wyczerpaniu prób RZUCA (4 żądania)', async t => {
    const { http, calls } = fakeHttp(() => jsonResponse(429, { error: { message: 'rate limited' } }));
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(['hello']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.is(err.kind, 'api');
        t.is(err.httpStatus, 429);
    }
    t.is(calls.length, 4, '1 próba + 3 ponowienia = 4 żądania (EMBED_RETRY_ATTEMPTS=3)');
});

// ── EB-03 ────────────────────────────────────────────────────────────────────

test('429, które ustępuje, daje N wyników na N wejść', async t => {
    const texts = ['a', 'b', 'c'];
    const { http, calls } = fakeHttp((_spec, i) => (
        i < 2 ? jsonResponse(429, { error: { message: 'rate limited' } }) : jsonResponse(200, openAiSuccessBody(texts))
    ));
    const model = new EmbeddingModel(baseDeps({ http }));

    const results = await model.embed(texts);
    t.is(results.length, texts.length);
    t.true(results.every(r => Array.isArray(r.vector)));
    t.true(calls.length >= 2, 'padło co najmniej raz przed sukcesem');
});

// ── EB-04 ────────────────────────────────────────────────────────────────────

test('status 500 leci w górę od razu (1 żądanie)', async t => {
    const { http, calls } = fakeHttp(() => jsonResponse(500, { error: { message: 'internal error' } }));
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(['hello']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) t.is(err.httpStatus, 500);
    t.is(calls.length, 1, 'błąd inny niż 429 nie jest ponawiany');
});

// ── EB-05 ────────────────────────────────────────────────────────────────────

test('milczący dostawca kończy się kind:\'timeout\' po suficie', async t => {
    const http: HttpClient = {
        send: () => new Promise<HttpResponse>(() => { /* nigdy się nie rozwiązuje */ }),
    };
    const model = new EmbeddingModel(baseDeps({ http, timeoutMs: 20 }));

    const err = await t.throwsAsync(() => model.embed(['hello']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) t.is(err.kind, 'timeout');
});

// ── EB-06 ────────────────────────────────────────────────────────────────────

test('sufit czasu: default w widełkach, deps.timeoutMs nadpisuje, 0 wraca na default', t => {
    const withDefault = new EmbeddingModel(baseDeps());
    t.true(withDefault.timeoutMs >= EMBED_TIMEOUT_MIN_MS && withDefault.timeoutMs <= EMBED_TIMEOUT_MAX_MS);
    t.is(withDefault.timeoutMs, DEFAULT_EMBED_TIMEOUT_MS);

    const withOverride = new EmbeddingModel(baseDeps({ timeoutMs: 40_000 }));
    t.is(withOverride.timeoutMs, 40_000);

    const withZero = new EmbeddingModel(baseDeps({ timeoutMs: 0 }));
    t.is(withZero.timeoutMs, DEFAULT_EMBED_TIMEOUT_MS, '0 NIGDY nie znaczy „brak limitu” (B.5 EB-06)');
});

// ── EB-07 + C-06 ─────────────────────────────────────────────────────────────

test('za mało wektorów → kind:\'shape\' z komunikatem `1 vectors for 16 inputs`', async t => {
    const texts = Array.from({ length: 16 }, (_, i) => `tekst ${i}`);
    const { http } = fakeHttp(() => jsonResponse(200, { data: [{ embedding: embeddingOf('x') }] }));
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(texts));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.is(err.kind, 'shape');
        t.regex(err.message, /1 vectors for 16 inputs/);
    }
});

test('C-06: za DUŻO wektorów też jest awarią kształtu (`4 vectors for 3 inputs`)', async t => {
    const texts = ['a', 'b', 'c'];
    const { http } = fakeHttp(() => jsonResponse(200, {
        data: Array.from({ length: 4 }, () => ({ embedding: embeddingOf('x') })),
    }));
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(texts));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.is(err.kind, 'shape');
        t.regex(err.message, /4 vectors for 3 inputs/);
    }
});

// ── EB-09 ────────────────────────────────────────────────────────────────────

test('N wejść → N wyników; same puste wejścia → same `{vector:null}` i ZERO żądań', async t => {
    const { http, calls } = fakeHttp(() => jsonResponse(200, openAiSuccessBody(['a', 'b'])));
    const model = new EmbeddingModel(baseDeps({ http }));

    const results = await model.embed(['', '   ']);
    t.deepEqual(results, [{ vector: null }, { vector: null }]);
    t.is(calls.length, 0, 'same puste wejścia -> zero żądań HTTP (oszczędność kosztu, B.5 EB-09)');
});

// ── EB-11 ────────────────────────────────────────────────────────────────────

test('6000 znaków notatki idzie do API w całości (limit z katalogu OpenAI: 8191 tokenów)', async t => {
    const dlugiTekst = 'a'.repeat(6000);
    let widzianyInput = '';
    const { http } = fakeHttp((spec) => {
        const body = JSON.parse(String(spec.body)) as { input: string[] };
        widzianyInput = body.input[0];
        return jsonResponse(200, openAiSuccessBody([widzianyInput]));
    });
    const model = new EmbeddingModel(baseDeps({ http }));

    await model.embed([dlugiTekst]);
    t.is(widzianyInput.length, 6000, 'katalog OpenAI (8191 tokenów) nie przycina 6000 znaków');
});

// ── EB-12 ────────────────────────────────────────────────────────────────────

test('model spoza katalogu → maxInputTokens === 512, modelSpec() undefined, bez rzutu', t => {
    const model = new EmbeddingModel(baseDeps({ ctx: makeCtx({ modelId: 'model-nieznany-spoza-katalogu' }) }));
    t.is(model.maxInputTokens, DEFAULT_MAX_INPUT_TOKENS);
    t.is(openAiEmbeddingProvider.modelSpec('model-nieznany-spoza-katalogu'), undefined);
});

// ── EB-13 ────────────────────────────────────────────────────────────────────

test('margines przycinania: safeMaxTokens === floor(512×0,85) dla modelu spoza katalogu', t => {
    const model = new EmbeddingModel(baseDeps({ ctx: makeCtx({ modelId: 'model-nieznany-spoza-katalogu' }) }));
    t.is(model.safeMaxTokens, Math.floor(512 * 0.85));
});

// ── GM-01 ────────────────────────────────────────────────────────────────────

test('backoffFactor === 1 po sukcesie; wynik N→N', async t => {
    const { http } = fakeHttp(() => jsonResponse(200, openAiSuccessBody(['a', 'b'])));
    const model = new EmbeddingModel(baseDeps({ http }));

    const results = await model.embed(['a', 'b']);
    t.is(results.length, 2);
    t.is(model.backoffFactor, 1);
});

// ── GM-02 ────────────────────────────────────────────────────────────────────

test('backoffFactor nie rośnie w nieskończoność — sufit MAX_BACKOFF_FACTOR po 5 paczkach 429', async t => {
    const { http } = fakeHttp(() => jsonResponse(429, { error: { message: 'rate limited' } }));
    const model = new EmbeddingModel(baseDeps({ http }));

    for (let i = 0; i < 5; i++) {
        await t.throwsAsync(() => model.embed(['x']));
    }
    t.true(model.backoffFactor <= MAX_BACKOFF_FACTOR);
});

// ── GM-05 ────────────────────────────────────────────────────────────────────

test('batch_size: wybór usera WYGRYWA nad katalogiem dostawcy (odwrotnie niż maxInputTokens)', t => {
    const model = new EmbeddingModel(baseDeps({
        ctx: makeCtx({ modelId: 'gemini-embedding-001' }),
        provider: geminiEmbeddingProvider,
        batchSize: 8,
    }));
    t.is(model.batchSize, 8);
    t.is(model.maxInputTokens, 2048, 'maxInputTokens dalej z katalogu — kolejność ODWROTNA niż batchSize');
});

// ── C-01 ─────────────────────────────────────────────────────────────────────

test('C-01: brak klucza API kończy się rzutem PRZED żądaniem (`API key not set`)', async t => {
    const { http, calls } = fakeHttp(() => jsonResponse(200, openAiSuccessBody(['a'])));
    const model = new EmbeddingModel(baseDeps({ http, ctx: makeCtx({ apiKey: undefined }) }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.is(err.kind, 'api');
        t.is(err.code, 'api_key_missing');
        t.regex(err.message, /API key not set/);
    }
    t.is(calls.length, 0, 'zero strzałów w sieć — brak klucza sprawdzany PRZED transportem');
});

// ── C-02 ─────────────────────────────────────────────────────────────────────

test('C-02: dostawca lokalny (needsApiKey:false) embeduje bez klucza, bez nagłówka Authorization', async t => {
    // Ciało w kształcie OpenAI, bo parsowanie test deleguje niżej WPROST do dostawcy OpenAI.
    // (Pierwotny fixture niósł `{embeddings:[…]}` — kształt OLLAMY — i przechodził tylko
    // dopóki `parseEmbedResponse` był stubem rzucającym „not implemented".)
    const { http, calls } = fakeHttp(() => jsonResponse(200, openAiSuccessBody(['a'])));
    // Delegat do openAiEmbeddingProvider (kształt żądania/odpowiedzi), z jedną podmienioną
    // flagą — `local`/`needsApiKey: false` udaje dostawcę lokalnego (Ollama/LM Studio) bez
    // powielania kształtu OpenAI. Metody delegowane WPROST (nie spread instancji), żeby
    // zachować faktyczną implementację po stronie providera.
    const localProvider: EmbeddingProvider = {
        info: { ...openAiEmbeddingProvider.info, local: true, needsApiKey: false },
        modelSpec: (id) => openAiEmbeddingProvider.modelSpec(id),
        listModels: (ctx, h) => openAiEmbeddingProvider.listModels(ctx, h),
        buildEmbedRequest: (texts, ctx) => openAiEmbeddingProvider.buildEmbedRequest(texts, ctx),
        parseEmbedResponse: (body, texts, ctx) => openAiEmbeddingProvider.parseEmbedResponse(body, texts, ctx),
        parseEmbedError: (res, ctx) => openAiEmbeddingProvider.parseEmbedError(res, ctx),
        countTokens: (text) => openAiEmbeddingProvider.countTokens(text),
    };
    const model = new EmbeddingModel(baseDeps({
        provider: localProvider,
        http,
        ctx: makeCtx({ apiKey: undefined }),
    }));

    const results = await model.embed(['a']);
    t.is(results.length, 1);
    t.is(calls.length, 1);
    t.falsy(calls[0]?.headers?.Authorization, 'brak klucza -> brak nagłówka Authorization');
});

// ── C-03 ─────────────────────────────────────────────────────────────────────

test('C-03: pusty tekst W ŚRODKU listy nie przesuwa wyników', async t => {
    let widzianyInput: string[] = [];
    const { http } = fakeHttp((spec) => {
        const body = JSON.parse(String(spec.body)) as { input: string[] };
        widzianyInput = body.input;
        return jsonResponse(200, openAiSuccessBody(body.input));
    });
    const model = new EmbeddingModel(baseDeps({ http }));

    const results = await model.embed(['a', '', 'b']);
    t.deepEqual(widzianyInput, ['a', 'b'], 'dostawca dostaje TYLKO niepuste wejścia');
    t.is(results.length, 3);
    t.is(results[1].vector, null);
    t.truthy(results[0].vector);
    t.truthy(results[2].vector);
});

// ── C-04 ─────────────────────────────────────────────────────────────────────

test('C-04: 429 z nagłówkiem Retry-After czeka tyle, ile każe dostawca (nie backoff wykładniczy)', async t => {
    const sleeps: number[] = [];
    const { http } = fakeHttp((_spec, i) => (
        i === 1
            ? jsonResponse(429, { error: { message: 'rate limited' } }, { 'Retry-After': '2' })
            : jsonResponse(200, openAiSuccessBody(['a']))
    ));
    const model = new EmbeddingModel(baseDeps({
        http,
        sleep: async (ms: number) => { sleeps.push(ms); },
    }));

    await model.embed(['a']);
    t.true(sleeps.includes(2000), `Retry-After: 2 (sekundy) -> sleep(2000); dostał: ${sleeps.join(', ')}`);
});

// ── C-05 ─────────────────────────────────────────────────────────────────────

test('C-05: odpowiedź 200 z niepoprawnym JSON-em RZUCA (shape), nie wywala się gołym błędem parsera', async t => {
    const http: HttpClient = {
        async send() {
            // Prawdziwy rzut parsera: `JSON.parse` na urwanym ciele (bez ręcznego konstruowania błędu).
            return { status: 200, headers: {}, text: '{niepoprawny', json: <T>() => JSON.parse('{niepoprawny') as T };
        },
    };
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err), 'błąd musi być EmbedBatchError, nie goły błąd parsera JSON');
    if (isEmbedBatchError(err)) t.is(err.kind, 'shape');
});

// ── C-07 ─────────────────────────────────────────────────────────────────────

test('C-07: komunikat błędu nie niesie klucza API ani nagłówków (K20)', async t => {
    const { http } = fakeHttp(() => jsonResponse(500, { error: { message: 'boom', headers: { Authorization: 'Bearer sk-super-secret-123' } } }));
    const model = new EmbeddingModel(baseDeps({ http, ctx: makeCtx({ apiKey: 'sk-super-secret-123' }) }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.false(String(err).includes('sk-super-secret-123'));
    if (err instanceof Error) t.false((err.message || '').includes('sk-super-secret-123'));
});

// ── C-08 ─────────────────────────────────────────────────────────────────────

test('C-08: modelKey to "<provider>:<model>"', t => {
    const model = new EmbeddingModel(baseDeps());
    t.is(model.modelKey, 'openai:text-embedding-3-small');
});

// ── C-09 ─────────────────────────────────────────────────────────────────────

test('C-09: dims zostaje na DEFAULT_VECTOR_DIM=1024, nawet gdy katalog dostawcy zna inny wymiar', t => {
    const model = new EmbeddingModel(baseDeps({ ctx: makeCtx({ modelId: 'text-embedding-3-small' }) }));
    t.is(model.dims, 1024);
});

// ═══════════════════════════════════════════════════════════════════════════
// C-10..C-23 — bramka mutacyjna F10 (mutanty, które przeżyły zestaw wyżej).
// Każdy test poniżej pinuje ZACHOWANIE OBSERWOWALNE (wynik, rzut, wywołania
// wstrzykniętych atrap), nie kształt kodu.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dostawca delegujący WPROST do produkcyjnego OpenAI, z punktową podmianą jednej metody.
 * Pozwala pinować politykę MODELU na wejściach, których żaden z czterech dostawców
 * produkcyjnych dziś nie produkuje, ale które kontrakt `EmbeddingProvider` dopuszcza.
 */
function delegatingProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
    return {
        info: openAiEmbeddingProvider.info,
        modelSpec: (id) => openAiEmbeddingProvider.modelSpec(id),
        listModels: (ctx, h) => openAiEmbeddingProvider.listModels(ctx, h),
        buildEmbedRequest: (texts, ctx) => openAiEmbeddingProvider.buildEmbedRequest(texts, ctx),
        parseEmbedResponse: (body, texts, ctx) => openAiEmbeddingProvider.parseEmbedResponse(body, texts, ctx),
        parseEmbedError: (res, ctx) => openAiEmbeddingProvider.parseEmbedError(res, ctx),
        countTokens: (text) => openAiEmbeddingProvider.countTokens(text),
        ...overrides,
    };
}

// ── C-10: świeży model ──────────────────────────────────────────────────────

test('C-10: świeży model startuje z backoffFactor === 1 (jeszcze przed pierwszym żądaniem)', t => {
    const model = new EmbeddingModel(baseDeps());
    t.is(model.backoffFactor, 1);
});

// ── C-11: countTokens ───────────────────────────────────────────────────────

test('C-11: countTokens deleguje do dostawcy i oddaje LICZBĘ', t => {
    const model = new EmbeddingModel(baseDeps());
    const tekst = 'notatka o siedmiu krasnoludach';
    t.is(model.countTokens(tekst), openAiEmbeddingProvider.countTokens(tekst));
    t.true(Number.isFinite(model.countTokens(tekst)) && model.countTokens(tekst) > 0);
});

// ── C-12 / C-13: dług backoffu ──────────────────────────────────────────────

test('C-12: świeży model i model po sukcesie NIE odrabiają żadnego długu (zero uśpień)', async t => {
    const sleeps: number[] = [];
    const { http } = fakeHttp(() => jsonResponse(200, openAiSuccessBody(['a'])));
    const model = new EmbeddingModel(baseDeps({ http, sleep: async (ms: number) => { sleeps.push(ms); } }));

    await model.embed(['a']);
    t.deepEqual(sleeps, [], 'świeży model nie ma długu — ani jednego uśpienia (nawet sleep(0))');

    await model.embed(['a']);
    t.deepEqual(sleeps, [], 'sukces wyzerował dług — drugie wywołanie też nie śpi');
});

test('C-13: dług po wyczerpanej rundzie 429 jest odrabiany CO DO MILISEKUNDY (także dług = 1 ms)', async t => {
    const sleeps: number[] = [];
    let limit = true;
    const { http } = fakeHttp(() => (
        limit
            ? jsonResponse(429, { error: { message: 'rate limited' } })
            : jsonResponse(200, openAiSuccessBody(['a']))
    ));
    const model = new EmbeddingModel(baseDeps({
        http,
        retryBaseMs: 1,
        backoffWaitMs: 0.5,
        sleep: async (ms: number) => { sleeps.push(ms); },
    }));

    await t.throwsAsync(() => model.embed(['a']));
    t.is(model.backoffFactor, 2, 'jedna wyczerpana runda podnosi mnożnik o JEDEN');

    limit = false;
    sleeps.length = 0;
    await model.embed(['a']);
    t.deepEqual(sleeps, [1], 'dług = backoffWaitMs (0,5) × factor (2) = 1 ms — odrobiony, nie pominięty');
});

// ── C-14: backoff wykładniczy ───────────────────────────────────────────────

test('C-14: bez Retry-After odczekania rosną wykładniczo: base × 2^runda × factor', async t => {
    const sleeps: number[] = [];
    const { http } = fakeHttp(() => jsonResponse(429, { error: { message: 'rate limited' } }));
    const model = new EmbeddingModel(baseDeps({
        http,
        retryBaseMs: 1,
        sleep: async (ms: number) => { sleeps.push(ms); },
    }));

    await t.throwsAsync(() => model.embed(['a']));
    t.deepEqual(sleeps, [1, 2, 4], 'trzy ponowienia: 1×2^0×1, 1×2^1×1, 1×2^2×1');
});

// ── C-15: licznik żądań ─────────────────────────────────────────────────────

test('C-15: `attempts` liczy ŻĄDANIA — 0 bez klucza, 1 przy 500, 4 po wyczerpanym 429', async t => {
    const bezKlucza = new EmbeddingModel(baseDeps({ ctx: makeCtx({ apiKey: undefined }) }));
    const e0 = await t.throwsAsync(() => bezKlucza.embed(['a']));
    t.true(isEmbedBatchError(e0));
    if (isEmbedBatchError(e0)) t.is(e0.attempts, 0, 'brak klucza — nie doszło do ŻADNEGO żądania');

    const { http: http500 } = fakeHttp(() => jsonResponse(500, { error: { message: 'boom' } }));
    const e1 = await t.throwsAsync(() => new EmbeddingModel(baseDeps({ http: http500 })).embed(['a']));
    t.true(isEmbedBatchError(e1));
    if (isEmbedBatchError(e1)) t.is(e1.attempts, 1, '500 nie jest ponawiane — jedno żądanie');

    const { http: http429 } = fakeHttp(() => jsonResponse(429, { error: { message: 'rate limited' } }));
    const e4 = await t.throwsAsync(() => new EmbeddingModel(baseDeps({ http: http429 })).embed(['a']));
    t.true(isEmbedBatchError(e4));
    if (isEmbedBatchError(e4)) t.is(e4.attempts, 4, '1 próba + 3 ponowienia');
});

// ── C-16 / C-17: skąd bierze się rozstrzygnięcie odpowiedzi ─────────────────

test('C-16: 500 z ciałem BEZ pola `error` to nadal awaria API (status decyduje), nie kształt', async t => {
    const { http, calls } = fakeHttp(() => jsonResponse(500, { detail: 'gateway down' }));
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.is(err.kind, 'api', 'status ≥ 400 rozstrzyga PRZED czytaniem ciała');
        t.is(err.httpStatus, 500);
        t.is(err.code, 'http_error');
    }
    t.is(calls.length, 1);
});

test('C-17: 200 z polem `error` w ciele to awaria API (limit zgłoszony ciałem, B.5 EB-02)', async t => {
    const { http, calls } = fakeHttp(() => jsonResponse(200, { error: { message: 'rate limited', code: 429 } }));
    const model = new EmbeddingModel(baseDeps({ http }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err), 'ciało z `error` NIE trafia do parsera wektorów');
    if (isEmbedBatchError(err)) {
        t.is(err.kind, 'api');
        t.is(err.httpStatus, 429);
    }
    t.is(calls.length, 4, 'limit z ciała włącza tę samą ścieżkę ponowień co status 429');
});

// ── C-18: kod limitu bez statusu 429 ────────────────────────────────────────

test('C-18: dostawca może zgłosić limit KODEM `rate_limited` mimo innego statusu — ponawiamy', async t => {
    const { http, calls } = fakeHttp(() => jsonResponse(503, { error: { message: 'slow down' } }));
    const provider = delegatingProvider({
        parseEmbedError: () => ({
            error: { kind: 'api', code: 'rate_limited', message: 'slow down', httpStatus: 503 },
        }),
    });
    const model = new EmbeddingModel(baseDeps({ provider, http }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.is(calls.length, 4, 'kod `rate_limited` sam w sobie włącza ponowienia');
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.is(err.code, 'rate_limited');
        t.is(err.httpStatus, 503);
    }
});

// ── C-19..C-23: maskowanie klucza (K20) ─────────────────────────────────────

test('C-19: klucz API wpleciony w komunikat dostawcy jest ZAMASKOWANY', async t => {
    const key = 'sk-super-secret-1234567890';
    const { http } = fakeHttp(() => jsonResponse(500, { error: { message: `invalid api key ${key} rejected` } }));
    const model = new EmbeddingModel(baseDeps({ http, ctx: makeCtx({ apiKey: key }) }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.false(err.message.includes(key), 'klucz nie ma prawa wyjść w komunikacie (K20)');
        t.true(err.message.includes('***'), 'w jego miejsce wchodzi zamiennik');
    }
});

test('C-20: maskowanie łapie klucz o GRANICZNEJ długości 8 znaków', async t => {
    const key = 'sk-12345';
    t.is(key.length, 8, 'granica: 8 znaków jest jeszcze maskowane');
    const { http } = fakeHttp(() => jsonResponse(500, { error: { message: `bad key ${key} here` } }));
    const model = new EmbeddingModel(baseDeps({ http, ctx: makeCtx({ apiKey: key }) }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err));
    if (isEmbedBatchError(err)) {
        t.false(err.message.includes(key));
        t.true(err.message.includes('***'));
    }
});

test('C-21: klucz w PRZYCZYNIE (Error) jest maskowany, a cudzy błąd nie jest mutowany', async t => {
    const key = 'sk-cause-secret-999';
    const zKluczem = new Error(`connect ECONNREFUSED https://api.openai.com/v1?key=${key}`);
    const model = new EmbeddingModel(baseDeps({
        http: { async send() { throw zKluczem; } },
        ctx: makeCtx({ apiKey: key }),
    }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err));
    const cause = isEmbedBatchError(err) ? err.cause : undefined;
    t.true(cause instanceof Error, 'przyczyna zostaje błędem');
    if (cause instanceof Error) {
        t.false(cause.message.includes(key), 'klucz wycięty z przyczyny (K20)');
        t.true(cause.message.includes('***'));
        t.is(cause.name, zKluczem.name, 'nazwa oryginału zachowana');
    }
    t.not(cause, zKluczem, 'w miejsce oryginału wchodzi ZAMIENNIK, oryginał nie jest ruszany');
    t.true(zKluczem.message.includes(key), 'cudzy błąd nie został zmutowany');
});

test('C-22: przyczyna BEZ klucza przechodzi tą samą tożsamością (nie ma po co jej podmieniać)', async t => {
    const bezKlucza = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    const model = new EmbeddingModel(baseDeps({
        http: { async send() { throw bezKlucza; } },
        ctx: makeCtx({ apiKey: 'sk-super-secret-1234567890' }),
    }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err));
    const cause = isEmbedBatchError(err) ? err.cause : undefined;
    t.is(cause, bezKlucza, 'przyczyna bez klucza wraca TĄ SAMĄ instancją');
});

test('C-23: przyczyna będąca STRINGIEM z kluczem też jest maskowana', async t => {
    const key = 'sk-string-secret-77';
    const model = new EmbeddingModel(baseDeps({
        http: { async send() { throw `transport blew up with ${key}`; } },
        ctx: makeCtx({ apiKey: key }),
    }));

    const err = await t.throwsAsync(() => model.embed(['a']));
    t.true(isEmbedBatchError(err));
    const cause = isEmbedBatchError(err) ? err.cause : undefined;
    t.is(typeof cause, 'string', 'string zostaje stringiem');
    t.false(String(cause).includes(key));
    t.true(String(cause).includes('***'));
});
