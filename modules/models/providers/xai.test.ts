import test from 'ava';
import { xaiProvider } from './xai.js';
import { MODEL_MAX_TOKENS_DEFAULTS } from '../cache_utils.js';
import { CapturingHttpClient, makeCtx, makeModel } from '../testing/harness.js';
import type { NormalizedError, OpenAiCompletion, StreamHandlers } from '../contracts.js';

/**
 * xAI nie ma użytecznego streamu w Obsidianie: `app://obsidian.md` nie dostaje nagłówków CORS
 * od api.x.ai, więc transport strumieniowy jest blokowany. To WŁAŚCIWOŚĆ dostawcy -
 * `streamMode: 'complete'`.
 */
type ParsedBody = { max_tokens?: number };

const MESSAGES = [{ role: 'user', content: 'hello' }];

test('xAI request sets x-grok-conv-id header', t => {
    const spec = xaiProvider.buildRequest(
        { agentName: 'Klara', messages: MESSAGES },
        makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test', maxOutputTokens: MODEL_MAX_TOKENS_DEFAULTS.xai }),
        false,
    );

    t.regex(spec.headers['x-grok-conv-id'], /^pkm-Klara-\d{4}-\d{2}-\d{2}-[a-z0-9]+$/);
    t.is((JSON.parse(spec.body ?? '{}') as ParsedBody).max_tokens, MODEL_MAX_TOKENS_DEFAULTS.xai);
});

/** Wyciąga ostatni segment nagłówka rozmowy - losowy ogon identyfikatora. */
function tailOf(headerValue: string): string {
    const parts = headerValue.split('-');
    return parts[parts.length - 1];
}

test('x-grok-conv-id: losowy ogon ma DOKŁADNIE 6 znakow (TAIL_LENGTH), nie 5 ani 7, i nigdy "undefined"', t => {
    const spec = xaiProvider.buildRequest(
        { agentName: 'TailAgent', messages: MESSAGES },
        makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' }),
        false,
    );

    const tail = tailOf(spec.headers['x-grok-conv-id']);
    t.regex(tail, /^[a-z0-9]+$/, 'ogon to same male litery/cyfry — nie "undefined" wleciane przez string template');
    t.is(tail.length, 6, 'ogon ma dokladnie TAIL_LENGTH=6 znakow');
});

test('agentSlug: cyfry 2-9 zostaja w nazwie agenta (alfabet nie ogranicza sie do 0-1)', t => {
    const spec = xaiProvider.buildRequest(
        { agentName: 'Agent23456789', messages: MESSAGES },
        makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' }),
        false,
    );

    t.regex(spec.headers['x-grok-conv-id'], /^pkm-Agent23456789-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/);
});

test('agentSlug: podwojny myslnik w nazwie agenta sklada sie w jeden', t => {
    const spec = xaiProvider.buildRequest(
        { agentName: 'Klara--Test', messages: MESSAGES },
        makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' }),
        false,
    );

    t.regex(spec.headers['x-grok-conv-id'], /^pkm-Klara-Test-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/);
});

test('decorateHeaders: pusty string w req.agentName NIE spada na ctx.agentName (nullish, nie or)', t => {
    const spec = xaiProvider.buildRequest(
        { agentName: '', messages: MESSAGES },
        makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test', agentName: 'Fallback' }),
        false,
    );

    // '' nie jest nullish -> agent = agentSlug('') = '' -> falsy -> naglowka NIE MA.
    // Gdyby to byl `||`, '' spadloby na ctx.agentName='Fallback' i naglowek by powstal.
    t.falsy(spec.headers['x-grok-conv-id']);
});

test('conversationId: ten sam agent w tym samym dniu dostaje TEN SAM identyfikator (cache trafia)', t => {
    const ctx = makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' });

    const first = xaiProvider.buildRequest({ agentName: 'Agent', messages: MESSAGES }, ctx, false);
    const second = xaiProvider.buildRequest({ agentName: 'Agent', messages: MESSAGES }, ctx, false);

    t.is(first.headers['x-grok-conv-id'], second.headers['x-grok-conv-id']);
});

test('conversationId: sprzatanie starych wpisow NIE kasuje cache innego agenta z DZISIEJSZYM dniem', t => {
    const ctx = makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' });

    // Agent A dostaje identyfikator na dzis - trafia do wspolnej mapy modulu.
    const alphaFirst = xaiProvider.buildRequest({ agentName: 'Alpha', messages: MESSAGES }, ctx, false);

    // Zapytanie o agenta B odpala petle sprzatania starych wpisow w tej samej mapie.
    xaiProvider.buildRequest({ agentName: 'Beta', messages: MESSAGES }, ctx, false);

    // Gdyby petla kasowala wpisy z DZISIEJSZYM dniem (zamiast starych), cache Alphy by zniknal
    // i ten request dostalby SWIEZY (inny) identyfikator zamiast cache'owanego.
    const alphaSecond = xaiProvider.buildRequest({ agentName: 'Alpha', messages: MESSAGES }, ctx, false);

    t.is(alphaSecond.headers['x-grok-conv-id'], alphaFirst.headers['x-grok-conv-id']);
});

/**
 * `streamMode: 'complete'` - `stream()` emuluje strumień JEDNYM wywołaniem `complete()`:
 * `chunk` z CAŁĄ treścią, potem AWAITOWANE `done`, dopiero potem resolve.
 */
test('xAI streamMode=complete — stream() woła complete() i emituje chunk → done', async t => {
    const http = new CapturingHttpClient({
        body: { choices: [{ index: 0, message: { role: 'assistant', content: 'Cała odpowiedź naraz.' } }], usage: {} },
    });
    const model = makeModel(xaiProvider, { http, ctx: makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' }) });

    const seen: Array<{ kind: string; content: string }> = [];
    const handlers: StreamHandlers = {
        chunk: (r: OpenAiCompletion) => seen.push({ kind: 'chunk', content: String(r.choices[0].message.content ?? '') }),
        done: (r: OpenAiCompletion) => { seen.push({ kind: 'done', content: String(r.choices[0].message.content ?? '') }); },
    };

    const out = await model.stream({ messages: MESSAGES }, handlers);

    t.is(http.sends, 1, 'DOKŁADNIE jedno wywołanie HTTP — nie ma drugiego toru');
    t.deepEqual(seen.map(s => s.kind), ['chunk', 'done'], 'kolejność: chunk, potem done');
    t.is(seen[0].content, 'Cała odpowiedź naraz.', 'chunk niesie CAŁĄ treść, nie deltę');
    t.is(String(out.choices[0].message.content), 'Cała odpowiedź naraz.');
});

/**
 * Błąd idzie DWIEMA drogami - do `handlers.error` i jako odrzucenie promisy, TYM SAMYM
 * obiektem.
 */
test('xAI — odpowiedź z polem error idzie do handlers.error I odrzuca promisę', async t => {
    const http = new CapturingHttpClient({
        status: 400,
        body: { error: { message: 'Grok is grumpy', type: 'invalid_request_error' } },
    });
    const model = makeModel(xaiProvider, { http, ctx: makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' }) });

    let handlerError: unknown = null;
    let rejection: unknown = null;
    try {
        await model.stream({ messages: MESSAGES }, { error: (e) => { handlerError = e; } });
    } catch (e) {
        rejection = e;
    }

    t.truthy(handlerError, 'handlers.error MUSI dostać błąd');
    t.truthy(rejection, 'promisa MUSI zostać odrzucona');
    t.is(handlerError, rejection, 'oba kanały dostają TEN SAM obiekt');
    t.is((rejection as NormalizedError).http_status, 400);
});

/**
 * `handlers.done` bywa asynchroniczne - harness owija je podsłuchem `async`. Brak `await`
 * gubi obserwację i przerywa scenariusze.
 */
test('xAI — handlers.done jest AWAITOWANE (asynchroniczny handler kończy się przed resolve)', async t => {
    const http = new CapturingHttpClient({
        body: { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: {} },
    });
    const model = makeModel(xaiProvider, { http, ctx: makeCtx({ modelId: 'grok-3-mini-beta', apiKey: 'xai-test' }) });

    let doneFinished = 0;
    await model.stream({ messages: MESSAGES }, {
        done: async () => {
            await new Promise<void>(res => setTimeout(res, 10));
            doneFinished += 1;
        },
    });

    t.is(doneFinished, 1, 'asynchroniczny done ma się DOKOŃCZYĆ zanim stream() rozstrzygnie promisę');
});
