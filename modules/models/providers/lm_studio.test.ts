import test from 'ava';
import { lmStudioProvider } from './lm_studio.js';
import { PROVIDER_INFO } from '../registry.js';
import { CapturingHttpClient, collect, collectEvents, makeCtx } from '../testing/harness.js';
import type {
  ChatRequest,
  OpenAiResponseTransformedMessage,
  ProviderContext,
  StreamDecoder,
  StreamEvent,
} from '../contracts.js';

/**
 * Wiadomość, w której treść jest ZAWSZE stringiem - dostawcy kształtu OpenAI nie oddają
 * bloków multimodalnych w odpowiedzi, a testy porównują treść znak w znak.
 */
type TextMessage = OpenAiResponseTransformedMessage & { content: string };


/**
 * Regression guards for the LM Studio <think>-tag parser.
 *
 * Kontekst produkcyjny: lokalne proxy ChatGPT udające LM Studio (na :1234) w trybie
 * think-tags wysyła reasoning inline w `delta.content` - atomowy chunk `<think>`, potem
 * tekst myślenia, potem atomowy `</think>`, potem właściwa odpowiedź.
 *
 * Mechanika siedzi we wspólnym `ReasoningTagFilter` (jeden kod dla LM Studio, Groqa,
 * OpenRoutera i Ollamy). Bliźniaczy zestaw dla Ollamy: `ollama.test.ts`.
 *
 * Niezmienniki parsera:
 *  1. Guard rozpoznający tryb myślenia nie może opierać się na polu, które sam parser
 *     wypełnia - inaczej gaśnie na stałe po pierwszym flushu myślenia, a reszta myślenia
 *     wraz z literalnym `</think>` i odpowiedzią lądują w widocznej treści.
 *  2. Parser zawsze zostawia w rezerwie ostatnie ≤8 znaków (na wypadek tagu rozciętego
 *     między chunki); `decoder.finish()` musi tę rezerwę opróżnić, inaczej ginie ogon
 *     odpowiedzi.
 *  3. `<think>` bez `</think>` (model ucięty na max_tokens albo proxy zgubiło tag
 *     zamykający) nie może wciągnąć całej wypowiedzi w myślenie - niedomknięty tag jest
 *     wycofywany do treści, żeby user widział odpowiedź zamiast pustki.
 *  4. Literalny `<think>` w prozie/bloku kodu (model PISZE o znaczniku, nie generuje go)
 *     nie może otworzyć myślenia w środku zdania - tag uzbraja parser tylko na początku
 *     wiadomości.
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
// Endpoint z metryczki liczony LENIWIE - inaczej pusty rejestr na stubach wywala CAŁY plik
// przy imporcie, zamiast dać każdemu testowi własne, czytelne „not implemented".
const CTX: ProviderContext = makeCtx({ modelId: 'qwen3' });

/** Jeden chunk SSE w formacie OpenAI-compatible. */
const sse = (delta: Record<string, unknown>) => 'data: ' + JSON.stringify({ choices: [{ delta }] });

/**
 * Przepuszcza chunki przez dekoder dostawcy i zwraca finalną wiadomość + surowe zdarzenia.
 * Zamiennik dawnej pary „przetwórz porcję" + „zamień stan adaptera na kształt kanoniczny".
 */
function stream(chunks: string[]) {
  const decoder = lmStudioProvider.createStreamDecoder(REQ, CTX);
  const events = collectEvents(decoder, chunks);
  const message = collect(lmStudioProvider.createStreamDecoder(REQ, CTX), chunks)
    .choices[0].message as TextMessage;
  return { message, events, decoder };
}

/** Widoczna treść wypuszczona przez dekoder (wołacz traktuje ją jak świeży tekst). */
const emitted = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.delta).join('');

/** Seam obserwacyjny parsera tagów myślenia. */
const seam = (decoder: StreamDecoder) => decoder.reasoning!;

/** Odpowiedź non-streaming w kształcie OpenAI (tor `complete()`). */
function completed(content: string): TextMessage {
  return lmStudioProvider.parseCompletion(
    {
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'qwen3',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {},
    },
    REQ,
    CTX,
  ).choices[0].message as TextMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Lokalne proxy happy path - pełna sekwencja think-tagów
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: lokalne proxy happy path rozdziela myślenie od odpowiedzi co do znaku', t => {
  const THINK_1 = '**Confirming backlog execution to Nika**';
  const THINK_2 = '\n\nUser wants the backlog executed. I will start with the first item.';
  const THINK_3 = ' Then I will report back.';
  const ANSWER_1 = 'Jasne, zaczynam robotę. ';
  const ANSWER_2 = 'Lecę po kolei.';

  const { message, events } = stream([
    sse({ content: '<think>' }),
    sse({ content: THINK_1 }),
    sse({ content: THINK_2 }),
    sse({ content: THINK_3 }),
    sse({ content: '</think>' }),
    sse({ content: ANSWER_1 }),
    sse({ content: ANSWER_2 }),
    'data: [DONE]',
  ]);

  t.is(message.reasoning_content, THINK_1 + THINK_2 + THINK_3, 'całe myślenie w reasoning_content');
  t.is(message.content, ANSWER_1 + ANSWER_2, 'widoczna treść = sama odpowiedź');

  // Objawy z produkcji, przed którymi ten parser musi chronić:
  t.false(message.content.includes('</think>'), 'żaden tag nie może zostać w treści');
  t.false(message.content.includes('<think>'), 'żaden tag nie może zostać w treści');
  t.false(message.content.includes('Confirming backlog'), 'nagłówki reasoning nie mogą wyciec');

  // Ogon odpowiedzi (ostatnie ≤7 znaków trzymanych w rezerwie bufora) musi dojechać po flushu na [DONE].
  t.true(message.content.endsWith('po kolei.'), 'ogon odpowiedzi musi dojechać');

  // Zwrotki handle_chunk skladaja sie w dokladnie te sama widoczna tresc (kontrakt streamingu).
  t.is(emitted(events), message.content);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Guard nie gaśnie po pierwszym flushu reasoning
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: parsuje dalej po pierwszym flushu reasoning (regresja guardu)', t => {
  // Pierwszy chunk myślenia jest dłuższy niż rezerwa 8 znaków, więc WYMUSZA flush do
  // reasoning_content już na starcie. Guard nie może przez to przestać parsować kolejne
  // chunki tylko dlatego, że reasoning_content jest już niepuste.
  const THINK = [
    '**Planning the answer for the user**',
    '\n\nFirst I check the backlog file.',
    '\n\nThen I summarise what is left.',
    '\n\nFinally I answer in Polish.',
  ];
  const ANSWER = 'Gotowe — oto podsumowanie backlogu.';

  const { message, decoder } = stream([
    sse({ content: '<think>' }),
    ...THINK.map(chunk => sse({ content: chunk })),
    sse({ content: '</think>' }),
    sse({ content: ANSWER }),
    'data: [DONE]',
  ]);

  t.true(seam(decoder).active, 'parsowanie musi pozostać aktywne po flushach reasoning');
  t.is(message.reasoning_content, THINK.join(''), 'myślenie kompletne, nie urwane na pierwszym flushu');
  t.is(message.content, ANSWER, 'odpowiedź czysta');

  for (const chunk of THINK.slice(1)) {
    t.false(message.content.includes(chunk.trim()), `fragment myślenia wyciekł do treści: ${chunk.trim()}`);
  }
  t.false(message.content.includes('</think>'), 'wiszący </think> to dokładnie objaw zgłoszony z produkcji');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Natywny reasoning (DeepSeek-style) - parser think ma się NIE włączać
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: natywne delta.reasoning_content zostaje nietknięte', t => {
  const { message, events, decoder } = stream([
    sse({ reasoning_content: 'Myślę o tym zadaniu' }),
    sse({ reasoning_content: ' i już kończę myśleć.' }),
    sse({ content: 'Odpowiedź gotowa.' }),
    sse({ content: ' Koniec.' }),
    'data: [DONE]',
  ]);

  t.is(message.reasoning_content, 'Myślę o tym zadaniu i już kończę myśleć.');
  t.is(message.content, 'Odpowiedź gotowa. Koniec.');
  t.falsy(seam(decoder).active, 'bez tagów <think> parser musi zostać wyłączony');
  t.falsy(seam(decoder).buffered, 'bufor think nie może być użyty na ścieżce natywnej');
  t.is(emitted(events), message.content, 'content leci do wołacza bez buforowania');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Stream bez myślenia - czysty content, ogon nie ginie
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: zwykły stream przechodzi nietknięty razem z ogonem', t => {
  const { message, events, decoder } = stream([
    sse({ content: 'Zwykła odpowiedź ' }),
    sse({ content: 'bez żadnego myślenia. ' }),
    sse({ content: 'Ogon!' }),
    'data: [DONE]',
  ]);

  t.is(message.content, 'Zwykła odpowiedź bez żadnego myślenia. Ogon!');
  t.is(message.reasoning_content, undefined, 'brak myślenia = brak pola reasoning_content');
  t.true(message.content.endsWith('Ogon!'), 'ostatnie znaki nie mogą zostać w rezerwie bufora');
  t.falsy(seam(decoder).active);
  t.is(emitted(events), message.content);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Tagi rozcięte między chunki - rezerwa bufora skleja je z powrotem
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: rozcięty <think> na starcie streamu zostaje sklejony', t => {
  const { message } = stream([
    sse({ content: '<th' }),
    sse({ content: 'ink>tekst myślenia dłuższy niż rezerwa bufora' }),
    sse({ content: '</think>' }),
    sse({ content: 'Odpowiedź po myśleniu.' }),
    'data: [DONE]',
  ]);

  t.is(message.reasoning_content, 'tekst myślenia dłuższy niż rezerwa bufora');
  t.is(message.content, 'Odpowiedź po myśleniu.');
  t.false(message.content.includes('<th'), 'kawałek tagu nie może zostać w treści');
});

// `<think>` uzbraja parser TYLKO gdy przed nim nie padł ani jeden widoczny znak - inaczej
// rozcięty `<think>` po zwykłej treści zjadałby tekst sprzed tagu (tag po treści otwierałby
// myślenie, a widoczne zdanie urywałoby się w połowie).
test('lm_studio think parser: <think> po zwykłej treści zostaje zwykłym tekstem', t => {
  const CHUNKS = [
    'Wstęp widoczny. <th',
    'ink>myślenie dłuższe niż rezerwa',
    '</think>Reszta odpowiedzi.',
  ];

  const { message, events } = stream([...CHUNKS.map(c => sse({ content: c })), 'data: [DONE]']);

  // Objaw produkcyjny, przed którym testy chronią: model PISZE o znaczniku (agenci w tym
  // projekcie rozmawiają o własnym parserze) - treść od tagu w dół nie może zniknąć
  // z odpowiedzi do bloku myślenia.
  t.is(message.content, CHUNKS.join(''), 'nic nie może zniknąć z widocznej treści');
  t.is(message.reasoning_content, undefined, 'to nie było myślenie — pole nie może powstać');
  t.is(emitted(events), message.content);
});

test('lm_studio think parser: rozcięty </think> w środku streamu zostaje sklejony', t => {
  const { message } = stream([
    sse({ content: '<think>' }),
    sse({ content: 'myślenie dłuższe niż rezerwa bufora</thi' }),
    sse({ content: 'nk>Odpowiedź właściwa.' }),
    'data: [DONE]',
  ]);

  t.is(message.reasoning_content, 'myślenie dłuższe niż rezerwa bufora');
  t.is(message.content, 'Odpowiedź właściwa.');
  t.false(message.content.includes('nk>'), 'ogon rozciętego tagu nie może zostać w treści');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. <think> który nigdy się nie domknął (model ucięty na max_tokens,
//    proxy zgubiło tag zamykający)
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: niedomknięty <think> wraca w całości do treści', t => {
  // Objaw z produkcji, przed którym testy chronią: user widzi zwinięty blok myślenia
  // i ZERO odpowiedzi - cała wypowiedź ląduje w reasoning_content, a `content` zostaje
  // pustym stringiem.
  const CUT = 'Zaczynam od backlogu. Pierwszy punkt to naprawa parsera, drugi to testy, trzeci';

  const { message, events } = stream([
    sse({ content: '<think>' }),
    sse({ content: CUT }),
    'data: [DONE]',
  ]);

  t.is(message.content, CUT, 'tag się nie domknął → to nie było myślenie, tylko odpowiedź');
  t.is(message.reasoning_content, undefined, 'pusty string nie może wrócić do modelu w kolejnej turze pętli');
  t.is(emitted(events), message.content);
});

test('lm_studio think parser: domknięte myślenie zostaje, urwany ogon wraca do treści', t => {
  const THINK = 'Krótka analiza pytania użytkownika.';
  const ANSWER = 'Odpowiedź właściwa dla użytkownika. ';
  const TAIL = 'urwana kontynuacja bez domknięcia';

  const { message, events } = stream([
    sse({ content: '<think>' }),
    sse({ content: THINK }),
    sse({ content: '</think>' }),
    sse({ content: ANSWER }),
    sse({ content: '<think>' }),
    sse({ content: TAIL }),
    'data: [DONE]',
  ]);

  t.is(message.reasoning_content, THINK, 'domknięte myślenie zostaje myśleniem');
  t.true(message.content.startsWith(ANSWER), 'odpowiedź na miejscu');
  t.true(message.content.endsWith(TAIL), 'ogon po drugim (nieuzbrojonym) tagu nie ginie');
  t.is(emitted(events), message.content, 'nic nie zginęło po drodze');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. model PISZE o znaczniku (proza / blok kodu)
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: literalny <think> w prozie nie zjada zdania', t => {
  const PROSE = 'Usuń znacznik <think> z promptu, bo psuje parser.';

  const { message, events } = stream([
    sse({ content: PROSE }),
    'data: [DONE]',
  ]);

  t.is(message.content, PROSE);
  t.is(message.reasoning_content, undefined);
  t.is(emitted(events), message.content);
});

test('lm_studio think parser: <think> w bloku kodu zostaje w treści', t => {
  const CHUNKS = [
    'Parser wycina bloki myślenia. Przykład wejścia:\n\n```\n',
    '<think>tu model myśli</think>\n',
    '```\n\nTyle w temacie.',
  ];

  const { message } = stream([...CHUNKS.map(c => sse({ content: c })), 'data: [DONE]']);

  t.is(message.content, CHUNKS.join(''), 'cały blok kodu musi przetrwać w nienaruszonym stanie');
  t.is(message.reasoning_content, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Tool calls przy urwanym <think> - narzędzia przechodzą, treść nie ginie
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: urwany <think> nie psuje tool_calls', t => {
  const CUT = 'Sprawdzę plik zanim odpowiem — muszę go najpierw przeczytać.';

  const { message } = stream([
    sse({ content: '<think>' }),
    sse({ content: CUT }),
    sse({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }),
    sse({ tool_calls: [{ id: '', type: 'function', function: { name: '', arguments: '"a.md"}' } }] }),
    'data: [DONE]',
  ]);

  t.is(message.tool_calls![0].id, 'call_1');
  t.is(message.tool_calls![0].function.name, 'read');
  t.is(message.tool_calls![0].function.arguments, '{"path":"a.md"}', 'argumenty sklejone z dwóch chunków');
  t.is(message.content, CUT, 'treść wróciła z myślenia mimo równoległych tool_calls');
  t.is(message.reasoning_content, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Przerwany stream (Stop usera / błąd sieci → brak [DONE]) - rezerwa w to_openai()
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: przerwany stream nie gubi rezerwy, finish() dokłada ogon', t => {
  const ANSWER = 'Odpowiedź urwana Stopem.';
  const CHUNKS = [
    sse({ content: '<think>' }),
    sse({ content: 'krótkie myślenie' }),
    sse({ content: '</think>' }),
    sse({ content: ANSWER }),
  ];

  // Bez sentinela - dokładnie tak wygląda strumień ubity przyciskiem Stop. Karmimy dekoder
  // BEZ `finish()`, żeby zobaczyć stan rezerwy w połowie drogi.
  const midDecoder = lmStudioProvider.createStreamDecoder(REQ, CTX);
  const midEvents = CHUNKS.flatMap(c => midDecoder.feed(c));
  const midText = midEvents
    .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.delta).join('');

  t.true(seam(midDecoder).buffered.length > 0, 'ostatnie ≤8 znaków siedzą w rezerwie na rozcięty tag');
  t.not(midText, ANSWER, 'akumulator sam z siebie nie ma jeszcze ogona');

  // `finish()` domyka rezerwę - ogon nie ginie.
  const { message } = stream(CHUNKS);
  t.is(message.content, ANSWER, 'finish() dokłada rezerwę — ogon nie ginie');
  t.is(message.reasoning_content, 'krótkie myślenie');
  t.not(midText, message.content, 'rezerwa dołożona przy domknięciu, nie w połowie streamu');
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Non-streaming (complete() → to_openai()) - te same reguły co w streamie
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio think parser: non-streaming rozdziela myślenie od odpowiedzi', t => {
  // `complete()` musi parsować `<think>` tak samo jak stream - inaczej surowy tag jedzie
  // dalej (m.in. do wyników sub-agentów na modelach lokalnych).
  const msg = completed('<think>rozumowanie modelu</think>Właściwa odpowiedź.');

  t.is(msg.reasoning_content, 'rozumowanie modelu');
  t.is(msg.content, 'Właściwa odpowiedź.');
});

test('lm_studio think parser: non-streaming — niedomknięty tag zostaje treścią', t => {
  const msg = completed('<think>całe rozumowanie ucięte na max_tokens');

  t.is(msg.content, 'całe rozumowanie ucięte na max_tokens');
  t.is(msg.reasoning_content, undefined);
});

test('lm_studio think parser: non-streaming — tag w środku treści nic nie zmienia', t => {
  const PROSE = 'Napisz `<think>` na początku odpowiedzi, żeby włączyć myślenie.';
  const msg = completed(PROSE);

  t.is(msg.content, PROSE);
  t.is(msg.reasoning_content, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint z hosta ustawień, bez wymogu klucza
// ─────────────────────────────────────────────────────────────────────────────

test('lm_studio — endpoint z hosta ustawień, brak wymogu klucza API', t => {
  const fromSettings = 'http://192.168.0.7:4321';
  const spec = lmStudioProvider.buildRequest(REQ, makeCtx({ modelId: 'qwen3', endpoint: fromSettings }), false);
  t.true(spec.url.startsWith(fromSettings), 'host z `pkmAssistant.chat.hosts.lm_studio` wygrywa nad domyślnym');

  const fallback = lmStudioProvider.buildRequest(REQ, makeCtx({ modelId: 'qwen3', endpoint: undefined }), false);
  t.true(
    fallback.url.startsWith(PROVIDER_INFO.lm_studio.defaultEndpoint),
    'brak hosta w ustawieniach = adres domyślny dostawcy (localhost:1234)',
  );

  t.false(lmStudioProvider.info.needsApiKey, 'platforma lokalna nie wymaga klucza API');
  t.notThrows(
    () => lmStudioProvider.buildRequest(REQ, makeCtx({ modelId: 'qwen3', apiKey: undefined }), false),
    'żądanie bez klucza musi się zbudować',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// `modelsPath` liczy adres listy modeli z HOSTA ustawień, nie z metryczki -
// bez tego custom host z Ustawień jest ignorowany na liście modeli,
// mimo że czat go respektuje.
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio: listModels liczy adres z hosta ustawień (modelsPath), nie z domyślnego endpointu', async t => {
  const fromSettings = 'http://192.168.0.7:4321';
  const http = new CapturingHttpClient({ body: { data: [{ id: 'qwen3' }] } });

  const models = await lmStudioProvider.listModels(makeCtx({ modelId: 'qwen3', endpoint: fromSettings }), http);

  t.is(http.lastSpec?.url, `${fromSettings}/v1/models`, 'adres listy modeli musi liczyć się z hosta ustawień, tak jak adres czatu');
  t.deepEqual(models.map(m => m.id), ['qwen3']);
});

// ─────────────────────────────────────────────────────────────────────────────
// `acceptsModel` - ten sam serwer wystawia modele embeddingowe obok
// modeli czatu; lista w Ustawieniach ma pokazać TYLKO modele czatu.
// ─────────────────────────────────────────────────────────────────────────────
test('lm_studio: listModels filtruje modele embeddingowe, zostawia modele czatu', async t => {
  const http = new CapturingHttpClient({
    body: {
      data: [
        { id: 'qwen3' },
        { id: 'nomic-embed-text', type: 'embeddings' },
        { id: 'llama-3-8b', type: 'llm' },
      ],
    },
  });

  const models = await lmStudioProvider.listModels(makeCtx(), http);

  t.deepEqual(
    models.map(m => m.id),
    ['qwen3', 'llama-3-8b'],
    'model typu embeddings odpada, reszta (w tym bez pola type) zostaje',
  );
});
