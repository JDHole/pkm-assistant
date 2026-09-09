import test from 'ava';
import { deepseekProvider } from './deepseek.js';
import { groqProvider } from './groq.js';
import { lmStudioProvider } from './lm_studio.js';
import { resolveMaxOutputTokens } from '../cache_utils.js';
import { makeCtx } from '../testing/harness.js';
import type { ChatRequest, ProviderContext } from '../contracts.js';

/**
 * Strażnik regresji na samej bramce `stream_options`: ta sama baza kształtu OpenAI, dwóch
 * dostawców różniących się WYŁĄCZNIE flagą `ChatProviderInfo.streamUsage`.
 *
 * `ChatProviderInfo` jest `readonly`, więc test bada obie gałęzie przez parę dostawców
 * o przeciwnych flagach, zamiast mutować statykę adaptera.
 */
const MESSAGES = [{ role: 'user', content: 'cześć' }];

type ParsedBody = { stream_options?: { include_usage?: boolean } };

test('bazowe żądanie kształtu OpenAI dokłada stream_options TYLKO przy streamUsage', t => {
    t.true(deepseekProvider.info.streamUsage, 'świadek gałęzi ON');
    t.false(groqProvider.info.streamUsage, 'świadek gałęzi OFF');

    const withFlag = JSON.parse(
        deepseekProvider.buildRequest({ messages: MESSAGES }, makeCtx({ modelId: 'deepseek-chat' }), true).body ?? '{}',
    ) as ParsedBody;
    t.deepEqual(withFlag.stream_options, { include_usage: true });

    const withoutFlag = JSON.parse(
        groqProvider.buildRequest({ messages: MESSAGES }, makeCtx({ modelId: 'llama-3.3-70b-versatile' }), true).body ?? '{}',
    ) as ParsedBody;
    t.is(withoutFlag.stream_options, undefined);
});

/**
 * Sklejanie hosta ze ścieżką.
 *
 * User wpisuje w Ustawieniach host tak, jak go widzi w dokumentacji - a dokumentacja
 * LM Studio pokazuje `http://localhost:1234/v1`. Sklejenie na ślepo dawałoby
 * `…/v1/v1/chat/completions`: 404 bez ani jednej wskazówki, że winny jest adres.
 */
const chatUrlFor = (endpoint: string | undefined): string => lmStudioProvider.buildRequest(
    { messages: MESSAGES },
    makeCtx({ modelId: 'default', endpoint }),
    true,
).url;

test('adres czatu: host z ogonem `/v1` nie daje `/v1/v1/...`', t => {
    t.is(chatUrlFor('http://localhost:1234/v1'), 'http://localhost:1234/v1/chat/completions');
    t.is(chatUrlFor('http://localhost:1234/v1/'), 'http://localhost:1234/v1/chat/completions',
        'końcowy ukośnik hosta zmylił sklejanie');
});

test('adres czatu: goły host i host z pełną ścieżką zostają bez zmian', t => {
    t.is(chatUrlFor('http://localhost:1234'), 'http://localhost:1234/v1/chat/completions');
    t.is(chatUrlFor(undefined), 'http://localhost:1234/v1/chat/completions', 'domyślny host z metryczki');
    t.is(chatUrlFor('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1/chat/completions',
        'host podany w całości został podwojony');
});

test('adres czatu: skracamy CAŁYMI segmentami, nie po znakach', t => {
    t.is(chatUrlFor('http://v1.localhost:1234'), 'http://v1.localhost:1234/v1/chat/completions',
        'host kończący się na te same znaki co ścieżka zjadł kawałek adresu');
    t.is(chatUrlFor('http://localhost:1234/v11'), 'http://localhost:1234/v11/v1/chat/completions',
        'segment `v11` został potraktowany jak `v1`');
});

test('adres czatu: pokrycie dłuższe niż jeden segment też się zdejmuje', t => {
    t.is(chatUrlFor('http://localhost:1234/v1/chat'), 'http://localhost:1234/v1/chat/completions');
});

/**
 * Limit odpowiedzi i pola nieznane bazie (mutacje na `resolveMaxTokens`
 * i `passthroughFields`).
 *
 * DeepSeek jest tu świadkiem GOŁEJ bazy: nie nadpisuje ani jednego haka
 * (`chatPath`, `modelsPath`, `acceptsModel`, `decorateBody`), więc to, co widać
 * w jego żądaniu, jest zachowaniem samej klasy bazowej.
 */
const BASE_CTX = (overrides: Partial<ProviderContext> = {}): ProviderContext =>
    makeCtx({ modelId: 'deepseek-chat', ...overrides });

const bodyOf = (req: ChatRequest, ctx: ProviderContext): Record<string, unknown> =>
    JSON.parse(deepseekProvider.buildRequest(req, ctx, false).body ?? '{}') as Record<string, unknown>;

test('limit odpowiedzi: wartość z żądania idzie DOSŁOWNIE, także gdy wynosi 1', t => {
    t.is(bodyOf({ messages: MESSAGES, max_tokens: 1 }, BASE_CTX({ maxOutputTokens: 4096 })).max_tokens, 1,
        'jedynka to poprawny limit, nie „brak wartości"');
    t.is(bodyOf({ messages: MESSAGES, max_tokens: 512 }, BASE_CTX({ maxOutputTokens: 4096 })).max_tokens, 512,
        'żądanie wygrywa nad kontekstem');
});

test('limit odpowiedzi: bez pola w żądaniu decyduje kontekst, także gdy wynosi 1', t => {
    t.is(bodyOf({ messages: MESSAGES }, BASE_CTX({ maxOutputTokens: 1 })).max_tokens, 1);
    t.is(bodyOf({ messages: MESSAGES, max_tokens: 0 }, BASE_CTX({ maxOutputTokens: 777 })).max_tokens, 777,
        'zero z żądania to brak limitu, nie limit zerowy');
});

test('limit odpowiedzi: bez żądania i bez kontekstu wchodzi wyliczenie z platformy', t => {
    t.is(
        bodyOf({ messages: MESSAGES }, BASE_CTX()).max_tokens,
        resolveMaxOutputTokens({ platform: 'deepseek', modelId: 'deepseek-chat' }),
    );
});

test('pola, których baza nie zna, jadą do ciała BEZ ZMIAN', t => {
    const body = bodyOf(
        { messages: MESSAGES, seed: 7, logit_bias: { '50256': -100 }, response_format: { type: 'json_object' } },
        BASE_CTX(),
    );
    t.is(body.seed, 7, 'pętla agenta ma móc dołożyć pole, którego baza jeszcze nie zna');
    t.deepEqual(body.logit_bias, { '50256': -100 });
    t.deepEqual(body.response_format, { type: 'json_object' });
});

test('metadane wołacza (agentName, thinking) nigdy nie wychodzą jako pola API', t => {
    const body = bodyOf({ messages: MESSAGES, agentName: 'Klara Test', thinking: true }, BASE_CTX());
    t.is(body.agentName, undefined);
    t.is(body.thinking, undefined);
    t.is(body.model, 'deepseek-chat', 'pola zarządzane przez bazę zostają na swoim miejscu');
});
