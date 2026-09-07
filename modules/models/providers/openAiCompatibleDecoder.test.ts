import test from 'ava';
import { openaiProvider } from './openai.js';
import { collect, makeCtx } from '../testing/harness.js';
import type { ChatRequest, ProviderContext, StreamEvent } from '../contracts.js';

/**
 * Przechwycenie `usage` ze streamu (opcja `stream_options: { include_usage: true }`).
 * Bez niej API OpenAI-kształtne NIE zwraca zużycia tokenów w streamingu, więc pętla agenta
 * zawsze spadała na estymatę i zaniżała koszt wielokrotnie.
 *
 * ⚠️ `usage` bez danych zostaje PUSTYM OBIEKTEM (B.6 BA-08) — nie `undefined`, nie zera.
 * Pusty obiekt jest sygnałem dla pętli „estymuj".
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
const CTX: ProviderContext = makeCtx({ modelId: 'gpt-4o' });

function decode(chunks: string[]) {
    return collect(openaiProvider.createStreamDecoder(REQ, CTX), chunks);
}

test('parser streamu przechwytuje usage z ostatniego chunka (choices: [])', t => {
    const out = decode([
        'data: {"id":"c1","choices":[{"delta":{"content":"Cześć"}}]}',
        // Chunk zamykający z include_usage: PUSTE choices + usage.
        'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56,"total_tokens":1290}}',
    ]);

    t.is(out.usage.prompt_tokens, 1234);
    t.is(out.usage.completion_tokens, 56);
    // Treść zebrana wcześniej nie ucierpiała.
    t.is(out.choices[0].message.content, 'Cześć');
});

test('bez chunka z usage zwrotka zostaje pusta — czyli pętla wie, że ma estymować', t => {
    const out = decode(['data: {"id":"c1","choices":[{"delta":{"content":"hej"}}]}']);
    t.is(out.usage.prompt_tokens, undefined);
    t.is(out.usage.completion_tokens, undefined);
    t.deepEqual(out.usage, {}, 'pusty obiekt, nie undefined i nie zera (B.6 BA-08)');
});

/**
 * Granice ramek i sentinel końca tury (mutacje F10 na `isCompleteFrame` / `consumeLine`).
 *
 * Sieć nie tnie porcji na granicach ramek, więc dekoder musi umieć trzy rzeczy naraz:
 * domknąć turę ramką, która przyszła BEZ kończącego znaku nowej linii, poczekać na resztę
 * bajtów ramki rozciętej w środku JSON-a i nie pomylić jednego z drugim.
 */
/** Widoczna treść wypuszczona przez dekoder, w kolejności. */
const texts = (events: StreamEvent[]): string[] =>
    events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text').map(e => e.delta);

const DONE_FRAME = 'data: {"choices":[{"delta":{"content":"hej"},"finish_reason":"stop"}]}\ndata: [DONE]';

test('sentinel bez kończącej nowej linii kończy turę JUŻ w tej porcji', t => {
    const decoder = openaiProvider.createStreamDecoder(REQ, CTX);
    const events = decoder.feed(DONE_FRAME);

    t.true(events.some(e => e.type === 'done'), 'ogon porcji jest kompletną ramką — nie ma na co czekać');
    t.is(events.filter(e => e.type === 'done').length, 1, 'koniec tury dokładnie raz');
    t.is(decoder.droppedFrames, 0);
});

test('sentinel bez spacji po `data:` też kończy turę i nie ląduje w koszu', t => {
    const decoder = openaiProvider.createStreamDecoder(REQ, CTX);
    const events = decoder.feed('data:[DONE]\n');

    t.true(events.some(e => e.type === 'done'), 'liczy się ŁADUNEK ramki, nie odstęp po dwukropku');
    t.is(decoder.droppedFrames, 0, '`[DONE]` nie jest JSON-em — bez rozpoznania sentinela poszedłby do kosza');
});

test('ramka rozcięta w środku JSON-a czeka na resztę bajtów zamiast iść do kosza', t => {
    const decoder = openaiProvider.createStreamDecoder(REQ, CTX);
    const first = decoder.feed('data: {"choices":[{"delta":{"content":"he');

    t.deepEqual(first, [], 'niedomknięty JSON nie jest kompletną ramką');
    t.is(decoder.droppedFrames, 0, 'czekanie na resztę porcji to nie jest zgubiona ramka');

    const second = decoder.feed('llo"}}]}\n');
    t.deepEqual(
        texts(second),
        ['hello'],
        'skleiona ramka oddaje CAŁĄ treść',
    );
    t.is(decoder.droppedFrames, 0);
});

test('ramka trwale niesparsowalna ląduje w koszu, ale nie kończy strumienia', t => {
    const decoder = openaiProvider.createStreamDecoder(REQ, CTX);
    const events = decoder.feed('data: {nie-json}\ndata: {"choices":[{"delta":{"content":"dalej"}}]}\n');

    t.is(decoder.droppedFrames, 1, 'ST-11: kosz zostawia ślad, z którego ChatModel robi ostrzeżenie');
    t.deepEqual(
        texts(events),
        ['dalej'],
        'kolejna ramka po śmieciu ma dojść w całości',
    );
});
