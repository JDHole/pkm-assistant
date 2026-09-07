import test from 'ava';
import { ollamaProvider } from './ollama.js';
import { OLLAMA_DEFAULT_KEEP_ALIVE } from '../contracts.js';

/**
 * Wiadomość, w której treść jest ZAWSZE stringiem — dostawcy kształtu OpenAI nie oddają
 * bloków multimodalnych w odpowiedzi, a testy porównują treść znak w znak.
 */
type TextMessage = OpenAiResponseTransformedMessage & { content: string };

import { MODEL_MAX_TOKENS_DEFAULTS } from '../cache_utils.js';
import { CapturingHttpClient, collect, collectEvents, makeCtx, makeLog } from '../testing/harness.js';
import type {
  ChatRequest,
  OpenAiResponseTransformedMessage,
  ProviderContext,
  StreamDecoder,
  StreamEvent,
} from '../contracts.js';

/**
 * Regression guards for the Ollama <think>-tag parser (v2.2).
 *
 * Ollama gada INACZEJ niż LM Studio: porcje to gołe obiekty JSON, jeden na linię (NDJSON,
 * bez prefiksu `data: `), a koniec strumienia sygnalizuje STRUKTURALNIE — `done_reason`
 * albo `done: true`, nie sentinel tekstowy. Mechanika rozdzielania myślenia od treści jest
 * jednak WSPÓLNA (`ReasoningTagFilter`) — bliźniaczy zestaw dla LM Studio: `lm_studio.test.ts`.
 *
 * Bugi, które ten plik zabija (oba były w Ollamie i LM Studio jednocześnie — bo kopia kodu):
 *  1. `<think>` bez `</think>` (model ucięty na `num_predict`, proxy zgubiło tag) wrzucał CAŁĄ
 *     wypowiedź do myślenia → user widzi zwinięte myślenie i pustą odpowiedź.
 *  2. Literalny `<think>` w prozie / bloku kodu (model PISZE o znaczniku) otwierał myślenie
 *     w środku zdania → widoczna treść urywała się w połowie.
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
const CTX: ProviderContext = makeCtx({ modelId: 'qwen3' });

/** Jedna linia strumienia Ollamy (surowy JSON, bez SSE). */
const say = (content: string) => JSON.stringify({
  model: 'qwen3',
  created_at: '2026-07-29T10:00:00Z',
  message: { role: 'assistant', content },
  done: false,
}) + '\n';

/** Ostatnia linia — Ollama zamiast sentinela tekstowego wysyła `done_reason`. */
const DONE = JSON.stringify({
  model: 'qwen3',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 10,
  eval_count: 20,
}) + '\n';

/** Przepuszcza porcje przez dekoder dostawcy i zwraca finalną wiadomość + surowe zdarzenia. */
function stream(chunks: string[]) {
  const decoder = ollamaProvider.createStreamDecoder(REQ, CTX);
  const events = collectEvents(decoder, chunks);
  const message = collect(ollamaProvider.createStreamDecoder(REQ, CTX), chunks)
    .choices[0].message as TextMessage;
  return { message, events, decoder };
}

/** Widoczna treść wypuszczona przez dekoder (wołacz traktuje ją jak świeży tekst). */
const emitted = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.delta).join('');

/** Seam obserwacyjny parsera tagów myślenia (TT-16). */
const seam = (decoder: StreamDecoder) => decoder.reasoning!;

/** Czy porcja niesie koniec strumienia (zdarzenie `done` dekodera). */
const endsStream = (chunk: string) =>
  ollamaProvider.createStreamDecoder(REQ, CTX).feed(chunk).some(e => e.type === 'done');

/** Porcja z NATYWNYM myśleniem Ollamy (`/api/chat` z `think: true` → `message.thinking`). */
const ponder = (thinking: string) => JSON.stringify({
  model: 'qwen3',
  created_at: '2026-07-29T10:00:00Z',
  message: { role: 'assistant', thinking, content: '' },
  done: false,
}) + '\n';

/** Odpowiedź non-streaming w kształcie Ollamy (tor `complete()`). */
function completed(content: string, thinking?: string): TextMessage {
  return ollamaProvider.parseCompletion(
    {
      model: 'qwen3',
      created_at: '2026-07-29T10:00:00Z',
      message: { role: 'assistant', content, ...(thinking ? { thinking } : {}) },
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 20,
    },
    REQ,
    CTX,
  ).choices[0].message as TextMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — myślenie osobno, odpowiedź osobno, ogon nie ginie
// ─────────────────────────────────────────────────────────────────────────────
test('ollama think parser: rozdziela myślenie od odpowiedzi co do znaku', t => {
  const THINK = 'Sprawdzam czego dokładnie chce użytkownik, potem odpowiadam po polsku.';
  const ANSWER_1 = 'Jasne, robi się. ';
  const ANSWER_2 = 'Lecę po kolei.';

  const { message, events } = stream([
    say('<think>'),
    say(THINK),
    say('</think>'),
    say(ANSWER_1),
    say(ANSWER_2),
    DONE,
  ]);

  t.is(message.reasoning_content, THINK);
  t.is(message.content, ANSWER_1 + ANSWER_2);
  t.false(message.content.includes('think>'), 'żaden tag nie może zostać w treści');
  // Rezerwa (ostatnie ≤7 znaków trzymane na wypadek rozciętego tagu) musi dojechać na done_reason.
  t.true(message.content.endsWith('po kolei.'), 'ogon odpowiedzi musi dojechać');
  t.is(emitted(events), message.content, 'zdarzenia tekstowe = widoczna treść');
});

test('ollama think parser: zwykły stream bez <think> przechodzi nietknięty razem z ogonem', t => {
  const { message, events, decoder } = stream([
    say('Zwykła odpowiedź '),
    say('bez żadnego myślenia. '),
    say('Ogon!'),
    DONE,
  ]);

  t.is(message.content, 'Zwykła odpowiedź bez żadnego myślenia. Ogon!');
  t.is(message.reasoning_content, undefined, 'brak myślenia = brak pola reasoning_content');
  t.falsy(seam(decoder).buffered, 'bufor pusty po domknięciu strumienia');
  t.is(emitted(events), message.content);
});

test('ollama think parser: tagi rozcięte między chunki zostają sklejone', t => {
  const { message } = stream([
    say('<th'),
    say('ink>myślenie dłuższe niż rezerwa bufora</thi'),
    say('nk>Odpowiedź właściwa.'),
    DONE,
  ]);

  t.is(message.reasoning_content, 'myślenie dłuższe niż rezerwa bufora');
  t.is(message.content, 'Odpowiedź właściwa.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BUG 1 — <think> który nigdy się nie domknął
// ─────────────────────────────────────────────────────────────────────────────
test('ollama think parser: niedomknięty <think> wraca w całości do treści (BUG 1)', t => {
  const CUT = 'Zaczynam od backlogu. Pierwszy punkt to naprawa parsera, drugi to testy, trzeci';

  const { message, events } = stream([
    say('<think>'),
    say(CUT),
    DONE,
  ]);

  t.is(message.content, CUT, 'tag się nie domknął → to nie było myślenie, tylko odpowiedź');
  t.is(message.reasoning_content, undefined, 'pusty string nie może wrócić do modelu w kolejnej turze pętli');
  t.is(emitted(events), message.content);
});

test('ollama think parser: domknięte myślenie zostaje, urwany ogon wraca do treści', t => {
  const THINK = 'Krótka analiza pytania użytkownika.';
  const ANSWER = 'Odpowiedź właściwa dla użytkownika. ';
  const TAIL = 'urwana kontynuacja bez domknięcia';

  const { message } = stream([
    say('<think>'),
    say(THINK),
    say('</think>'),
    say(ANSWER),
    say('<think>'),
    say(TAIL),
    DONE,
  ]);

  t.is(message.reasoning_content, THINK, 'domknięte myślenie zostaje myśleniem');
  t.true(message.content.startsWith(ANSWER));
  t.true(message.content.endsWith(TAIL), 'ogon po drugim (nieuzbrojonym) tagu nie ginie');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BUG 2 — model PISZE o znaczniku (proza / blok kodu)
// ─────────────────────────────────────────────────────────────────────────────
test('ollama think parser: literalny <think> w prozie nie zjada zdania (BUG 2)', t => {
  const PROSE = 'Usuń znacznik <think> z promptu, bo psuje parser.';

  const { message, events } = stream([say(PROSE), DONE]);

  t.is(message.content, PROSE);
  t.is(message.reasoning_content, undefined);
  t.is(emitted(events), message.content);
});

test('ollama think parser: <think> w bloku kodu zostaje w treści (BUG 2)', t => {
  const CHUNKS = [
    'Parser wycina bloki myślenia. Przykład wejścia:\n\n```\n',
    '<think>tu model myśli</think>\n',
    '```\n\nTyle w temacie.',
  ];

  const { message } = stream([...CHUNKS.map(say), DONE]);

  t.is(message.content, CHUNKS.join(''), 'cały blok kodu musi przetrwać w nienaruszonym stanie');
  t.is(message.reasoning_content, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Przerwany stream (Stop usera / błąd sieci → brak chunka z done_reason)
// ─────────────────────────────────────────────────────────────────────────────
test('ollama think parser: przerwany stream nie gubi rezerwy, finish() dokłada ogon', t => {
  const ANSWER = 'Odpowiedź urwana Stopem.';
  const CHUNKS = [
    say('<think>'),
    say('krótkie myślenie'),
    say('</think>'),
    say(ANSWER),
  ];

  // Bez porcji z `done_reason` — dokładnie tak wygląda strumień ubity Stopem. Karmimy dekoder
  // BEZ `finish()`, żeby zobaczyć stan rezerwy w połowie drogi.
  const midDecoder = ollamaProvider.createStreamDecoder(REQ, CTX);
  const midEvents = CHUNKS.flatMap(c => midDecoder.feed(c));
  const midText = midEvents
    .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.delta).join('');

  t.true(seam(midDecoder).buffered.length > 0, 'ostatnie ≤8 znaków siedzą w rezerwie na rozcięty tag');

  const { message } = stream(CHUNKS);
  t.is(message.content, ANSWER, 'finish() dokłada rezerwę — ogon nie ginie');
  t.is(message.reasoning_content, 'krótkie myślenie');
  t.not(midText, message.content, 'rezerwa dołożona przy domknięciu, nie w połowie streamu');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Non-streaming (complete() → to_openai()) — te same reguły co w streamie
// ─────────────────────────────────────────────────────────────────────────────
test('ollama think parser: non-streaming rozdziela myślenie od odpowiedzi', t => {
  // Przed fixem `complete()` w ogóle nie parsował <think> — surowy tag jechał dalej
  // (m.in. do wyników sub-agentów na modelach lokalnych).
  const msg = completed('<think>rozumowanie modelu</think>Właściwa odpowiedź.');

  t.is(msg.reasoning_content, 'rozumowanie modelu');
  t.is(msg.content, 'Właściwa odpowiedź.');
});

test('ollama think parser: non-streaming — niedomknięty tag zostaje treścią', t => {
  const msg = completed('<think>całe rozumowanie ucięte na num_predict');

  t.is(msg.content, 'całe rozumowanie ucięte na num_predict');
  t.is(msg.reasoning_content, undefined);
});

test('ollama think parser: non-streaming — tag w środku treści nic nie zmienia', t => {
  const PROSE = 'Napisz `<think>` na początku odpowiedzi, żeby włączyć myślenie.';
  const msg = completed(PROSE);

  t.is(msg.content, PROSE);
  t.is(msg.reasoning_content, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Natywne myślenie Ollamy (`message.thinking`) — osobne pole, nie tagi w treści
// ─────────────────────────────────────────────────────────────────────────────
test('ollama native thinking: message.thinking ląduje w reasoning_content, treść czysta', t => {
  // Przed fixem pole `thinking` było IGNOROWANE — myślenie modeli z `think: true`
  // (qwen3, deepseek-r1) przepadało w całości, user nie widział bloku myślenia.
  const { message, events, decoder } = stream([
    ponder('Sprawdzam, o co pyta user. '),
    ponder('Odpowiem po polsku.'),
    say('Gotowe — oto odpowiedź.'),
    DONE,
  ]);

  t.is(message.reasoning_content, 'Sprawdzam, o co pyta user. Odpowiem po polsku.');
  t.is(message.content, 'Gotowe — oto odpowiedź.');
  t.falsy(seam(decoder).active, 'natywne myślenie nie uzbraja parsera tagów');
  t.is(emitted(events), message.content, 'zdarzenia tekstowe = widoczna treść');
});

test('ollama native thinking: literalny <think> w treści nie uzbraja parsera (guard)', t => {
  const PROSE = 'Napisz <think> w prompcie, żeby włączyć myślenie.';

  const { message, decoder } = stream([
    ponder('User pyta o znacznik.'),
    say(PROSE),
    DONE,
  ]);

  t.is(message.content, PROSE, 'przy natywnym myśleniu treść leci 1:1, bez parsowania tagów');
  t.is(message.reasoning_content, 'User pyta o znacznik.');
  t.falsy(seam(decoder).active);
});

test('ollama native thinking: non-streaming — pole thinking z JSON trafia do reasoning_content', t => {
  const msg = completed('Właściwa odpowiedź.', 'rozumowanie modelu');

  t.is(msg.reasoning_content, 'rozumowanie modelu');
  t.is(msg.content, 'Właściwa odpowiedź.');
});

test('ollama native thinking: non-streaming — natywne myślenie wyłącza parser tagów', t => {
  const PROSE = 'Usuń <think> z promptu.';
  const msg = completed(PROSE, 'krótkie rozumowanie');

  t.is(msg.content, PROSE, 'tag w treści zostaje tekstem — myślenie przyszło osobnym polem');
  t.is(msg.reasoning_content, 'krótkie rozumowanie');
});

test('ollama think parser: tool_calls przechodzą przy urwanym <think>', t => {
  const CUT = 'Sprawdzę plik zanim odpowiem — muszę go najpierw przeczytać.';

  const { message } = stream([
    say('<think>'),
    say(CUT),
    JSON.stringify({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: { path: 'a.md' } } }],
      },
      done: false,
    }),
    DONE,
  ]);

  t.is(message.tool_calls![0].function.name, 'read');
  // OL-05: Ollama niesie `arguments` OBIEKTEM i dostawca ma go przepuścić bez gubienia pól.
  // W torze STRUMIENIOWYM językiem dostawcy są zdarzenia, a te niosą argumenty wyłącznie
  // tekstem (`StreamEvent.tool_call.argumentsDelta?: string`; akumulacja w `ChatModel` skleja
  // delty stringiem) — obiekt jedzie więc dosłownym zapisem JSON i wraca obiektem po
  // sparsowaniu. Ta sama idiomatyka co u Gemini (`gemini.test.ts` „arg sklejony ze WSZYSTKICH
  // kawałków”). Przepuszczenie 1:1 pinuje test non-streaming zaraz pod spodem.
  t.deepEqual(JSON.parse(String(message.tool_calls![0].function.arguments)) as unknown, { path: 'a.md' });
  t.is(message.content, CUT, 'treść wróciła z myślenia mimo tool_calls');
  t.is(message.reasoning_content, undefined);
});

test('OL-05: non-streaming — `arguments` przychodzące OBIEKTEM przechodzą bez przepakowania', t => {
  const msg = ollamaProvider.parseCompletion(
    {
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read', arguments: { path: 'a.md', linie: 12 } } }],
      },
      done: true,
      done_reason: 'stop',
    },
    REQ,
    CTX,
  ).choices[0].message;

  t.deepEqual(
    msg.tool_calls![0].function.arguments,
    { path: 'a.md', linie: 12 } as unknown as string,
    'obiekt idzie dalej takim, jaki przyszedł — przepakowanie przez string gubiłoby typy liczb',
  );
  t.is(msg.tool_calls![0].function.name, 'read');
});

// ─────────────────────────────────────────────────────────────────────────────
// F2.14: rozpoznanie konca streamu sprawdza pola STRUKTURALNE (done_reason/done), nie substring
// na surowym tekście porcji — patrz to samo znalezisko po stronie google.ts.
// ─────────────────────────────────────────────────────────────────────────────

test('F2.14: ollama/koniec streamu: model wypowiadający frazę "done_reason" w treści NIE kończy strumienia przedwcześnie', t => {
  const talksAboutIt = JSON.stringify({
      model: 'qwen3',
      message: { role: 'assistant', content: 'Pole "done_reason" mówi, dlaczego Ollama zakończyła generację.' },
      done: false,
    });
  t.false(endsStream(talksAboutIt), 'sama treść wspominająca done_reason nie jest sygnałem końca');

  const genuinelyFinal = JSON.stringify({
      model: 'qwen3',
      message: { role: 'assistant', content: 'Pole "done_reason" mówi...' },
      done: true,
      done_reason: 'stop',
    });
  t.true(endsStream(genuinelyFinal));
});

test('F2.14: ollama/koniec streamu: rozpoznaje koniec przez samo "done":true, nawet bez done_reason', t => {
  const doneNoReason = JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: '' }, done: true });
  t.true(endsStream(doneNoReason), 'handle_chunk traktuje done_reason ORAZ done===true jako sygnał końca — rozpoznanie końca ma być spójne');
});

test('F2.14: ollama/koniec streamu: porcja niesparsowalna (rozcięty JSON) nie rzuca i nie jest końcem', t => {
  const partial = '{"model":"qwen3","message":{"role":"assistant","content":"urwa';
  t.notThrows(() => endsStream(partial));
  t.false(endsStream(partial));
});

// ─────────────────────────────────────────────────────────────────────────────
// W4-02 (review fali 2, 2026-09-04): rozpoznanie końca parsowało CAŁĄ porcję jako JEDEN
// obiekt JSON — dwie linie NDJSON zlepione w jedno zdarzenie (proxy buforujący, sklejony `\n`)
// gubiły sentinel, nawet gdy druga linia niosła `done_reason`. Dziś dzieli porcję po liniach
// i bierze OSTATNIĄ PARSOWALNĄ — ta sama ścieżka co `handle_chunk`.
// ─────────────────────────────────────────────────────────────────────────────

test('W4-02: ollama/koniec streamu: dwie linie NDJSON zlepione w jednym zdarzeniu — bierze OSTATNIĄ, rozpoznaje done_reason', t => {
  const line1 = JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: 'kawałek 1' }, done: false });
  const line2 = JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' });
  const glued = `${line1}\n${line2}`;
  t.true(endsStream(glued), 'ostatnia linia zlepionej porcji niesie done_reason — koniec ma zostać wykryty');

  // Odwrotna kolejność: PIERWSZA linia niesie sentinel, OSTATNIA nie — porcja nie jest końcem,
  // bo liczy się stan z KOŃCA porcji, nie obecność sentinela GDZIEKOLWIEK w niej.
  const gluedNoEnd = `${line2}\n${line1}`;
  t.false(endsStream(gluedNoEnd));
});

test('W4-02: ollama/koniec streamu: ostatnia linia urwana (niesparsowalna), przedostatnia parsowalna z done_reason — przeskakuje do niej', t => {
  const line1 = JSON.stringify({ model: 'qwen3', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' });
  const glued = `${line1}\n{"model":"qwen3","message":{"role":"assistant","content":"urwa`;
  t.true(endsStream(glued), 'ostatnia linia jest śmieciem transportowym — poprzednia parsowalna linia ma rozstrzygać');
});


// ─────────────────────────────────────────────────────────────────────────────
// N35 (luka L-24, B.10 OL-03): keep_alive i limit wyjścia w żądaniu
// ─────────────────────────────────────────────────────────────────────────────

test('Ollama request uses keep_alive setting and max_tokens default', t => {
  type ParsedBody = { keep_alive?: string; options?: { num_predict?: number } };
  const spec = ollamaProvider.buildRequest(
    { messages: [{ role: 'user', content: 'hello' }] },
    makeCtx({ modelId: 'llama3.2', keepAlive: '60m', maxOutputTokens: MODEL_MAX_TOKENS_DEFAULTS.ollama }),
    false,
  );
  const body = JSON.parse(spec.body ?? '{}') as ParsedBody;

  t.is(body.keep_alive, '60m');
  t.is(body.options?.num_predict, MODEL_MAX_TOKENS_DEFAULTS.ollama);
});

test('L-24: pusta/nieprawidłowa wartość keep_alive spada na OLLAMA_DEFAULT_KEEP_ALIVE', t => {
  type ParsedBody = { keep_alive?: string };
  for (const bad of ['', undefined]) {
    const spec = ollamaProvider.buildRequest(
      { messages: [{ role: 'user', content: 'hello' }] },
      makeCtx({ modelId: 'llama3.2', keepAlive: bad }),
      false,
    );
    const body = JSON.parse(spec.body ?? '{}') as ParsedBody;
    t.is(body.keep_alive, OLLAMA_DEFAULT_KEEP_ALIVE, `keepAlive=${JSON.stringify(bad)} ma spaść na default`);
  }
  t.is(OLLAMA_DEFAULT_KEEP_ALIVE, '60m', 'wartość domyślna jest faktem kontraktowym');
});

// ────────────────────────────────────────────────────────────────────────────
// B.10 OL-08: katalog modeli ściągniętych na dysk — `GET <host>/api/tags`, wołany wyłącznie
// przez Ustawienia. Wiersz jest must-keep w katalogu zachowań, a nie miał w klastrze żadnego
// testu (jedyny test `/api/tags` w repo należy do `modules/embedding`, czyli innego modułu).
// ────────────────────────────────────────────────────────────────────────────

test('OL-08: katalog modeli to GET <host>/api/tags i wraca TABLICĄ ModelInfo[]', async t => {
  const http = new CapturingHttpClient({
    body: {
      models: [
        { name: 'qwen3:8b', model: 'qwen3:8b', details: { families: ['qwen3'] } },
        { name: 'llava:13b', model: 'llava:13b', details: { families: ['llama', 'clip'] } },
        { size: 42 },
      ],
    },
  });

  const models = await ollamaProvider.listModels(makeCtx({ endpoint: 'http://localhost:11434/' }), http);

  t.is(http.lastSpec!.method, 'GET', 'katalog czyta się, nie wysyła');
  t.is(http.lastSpec!.url, 'http://localhost:11434/api/tags', 'ścieżkę dokleja dostawca, host przychodzi z ustawień');
  t.deepEqual(models.map(m => m.id), ['qwen3:8b', 'llava:13b'], 'wpis bez identyfikatora wypada z listy');
  t.true(models[1].multimodal, 'rodzina "clip" rozstrzyga vision lepiej niż zgadywanie po nazwie (VC-02)');
  t.falsy(models[0].multimodal);
});

test('OL-08: zgaszony demon albo błąd statusu — katalog to PUSTA lista, nie wyjątek', async t => {
  const padniety = new CapturingHttpClient().throwOn(new Error('ECONNREFUSED'));
  t.deepEqual(await ollamaProvider.listModels(makeCtx(), padniety), [], 'rozwijane pole Ustawień ma się narysować także bez demona');

  const zly = new CapturingHttpClient({ status: 500, text: 'boom' });
  t.deepEqual(await ollamaProvider.listModels(makeCtx(), zly), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// F10 (bramka mutacyjna): zachowania kontraktowe dostawcy, których nie pinował żaden
// test — sklejanie adresu, tłumaczenie transkryptu (role, bloki treści, obrazy,
// `tool_calls`, myślenie), liczniki tokenów, powód końca i limit odpowiedzi.
// Każdy przypadek stoi na obserwowalnym wyniku: ciele żądania, kształcie odpowiedzi,
// zdarzeniach dekodera albo wywołaniach na wstrzykniętym logu.
// ─────────────────────────────────────────────────────────────────────────────

/** Ciało `POST /api/chat` po stronie testu (dostawca oddaje je STRINGIEM — BA-01). */
type BodyOllamy = {
  model?: string;
  think?: boolean;
  keep_alive?: string;
  messages?: Array<Record<string, unknown>>;
  options?: { num_predict?: number; temperature?: number };
  tools?: unknown[];
};

/** Rozpakowane ciało żądania zbudowanego przez dostawcę. */
const bodyOf = (req: ChatRequest, ctx: ProviderContext = CTX): BodyOllamy =>
  JSON.parse(ollamaProvider.buildRequest(req, ctx, false).body ?? '{}') as BodyOllamy;

/** Kontekst modelu, który UMIE czytać obrazy (metadana katalogu rozstrzyga — VC-02). */
const ctxVision = (): ProviderContext =>
  makeCtx({ modelId: 'llava:13b', models: [{ id: 'llava:13b', multimodal: true }] });

test('F10: host sprowadzony do samego ukośnika spada na demona domyślnego', t => {
  t.is(
    ollamaProvider.buildRequest(REQ, makeCtx({ modelId: 'qwen3', endpoint: '/' }), false).url,
    'http://localhost:11434/api/chat',
    'pusty pień po obcięciu ukośników = adres domyślny + ścieżka czatu',
  );
  t.is(
    ollamaProvider.buildRequest(REQ, makeCtx({ modelId: 'qwen3', endpoint: 'http://dom:11434/api/chat' }), false).url,
    'http://dom:11434/api/chat',
    'wklejona ścieżka API znika z hosta, zanim dostawca doklei własną (BA-21)',
  );
});

test('F10: model bierze się z żądania, a pusty spada na model domyślny', t => {
  t.is(bodyOf({ ...REQ, model: 'qwen3:8b' }, makeCtx({ modelId: 'inny' })).model, 'qwen3:8b');
  t.is(bodyOf(REQ, makeCtx({ modelId: '' })).model, 'llama3', 'brak wskazania = model domyślny');
});

test('F10: role spoza słownika demona schodzą do `user`, znane przechodzą bez zmian', t => {
  const msgs = bodyOf({
    messages: [
      { role: 'system', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'tool', content: 'c', name: 'read' },
      { role: 'function', content: 'd', name: 'read' },
      { role: 'kapitan', content: 'e' },
    ],
  }).messages ?? [];

  t.deepEqual(msgs.map(m => m.role), ['system', 'assistant', 'tool', 'tool', 'user']);
  t.is(msgs[2].tool_name, 'read', 'wynik narzędzia niesie nazwę narzędzia');
  t.false('tool_name' in msgs[4], 'zwykły głos rozmówcy nie dostaje pola narzędzia');
});

test('F10: bloki treści — tekst sklejony nową linią, obrazy osobno jako goły base64', t => {
  const msgs = bodyOf({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'ala' },
        { type: 'text', text: 'ma kota' },
        { image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'image', data: 'REVG' },
      ],
    }],
  }, ctxVision()).messages ?? [];

  t.is(msgs[0].content, 'ala\nma kota', 'bloki tekstowe zostają tekstem i zachowują kolejność');
  t.deepEqual(msgs[0].images, ['QUJD', 'REVG'], 'nagłówek data: znika, ładunek podany wprost idzie jak stoi');
  t.false('tool_calls' in msgs[0], 'wiadomość bez wywołań narzędzi nie dostaje pustej tablicy');
});

test('F10: obraz-odsyłacz http(s) nie jedzie do demona — zostaje po nim komunikat w treści', t => {
  const msgs = bodyOf({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'co tu widac?' },
        { type: 'image_url', image_url: { url: 'https://przyklad.test/kot.png' } },
      ],
    }],
  }, ctxVision()).messages ?? [];

  t.false('images' in msgs[0], 'pobranie pliku spod adresu nie jest zadaniem dostawcy');
  t.true(String(msgs[0].content).startsWith('co tu widac?\n'), 'tekst usera zostaje, obraz zamienia się w komunikat');
  t.false(String(msgs[0].content).includes('przyklad.test'), 'adres obrazu nie wchodzi do transkryptu');
});

test('F10: ostrzeżenie o pominiętym obrazie leci RAZ na turę, nie raz na obraz', t => {
  const log = makeLog();
  const obrazek = (ladunek: string) => ({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + ladunek } }],
  });

  bodyOf(
    { messages: [obrazek('QUJD'), obrazek('REVG')] },
    makeCtx({ modelId: 'llama3', log }),
  );

  const ostrzezenia = log.calls.filter(c => c.level === 'warn' && c.scope === 'models.image_stripped');
  t.is(ostrzezenia.length, 1, 'album zdjęć nie może zalać logu');
});

test('F10: reasoning_content z transkryptu jedzie jako `thinking`, brak nie tworzy pola', t => {
  const msgs = bodyOf({
    messages: [
      { role: 'assistant', content: 'a', reasoning_content: 'bo tak' },
      { role: 'assistant', content: 'b' },
    ],
  }).messages ?? [];

  t.is(msgs[0].thinking, 'bo tak');
  t.false('thinking' in msgs[1], 'puste myślenie nie dokłada pola do żądania');
});

test('F10: tool_calls w transkrypcie — argumenty OBIEKTEM, wpis bez nazwy wypada', t => {
  const msgs = bodyOf({
    messages: [{
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: { path: 'a.md', linie: 12 } } },
        { id: 'call_2', type: 'function', function: { name: 'write', arguments: '{"path":"b.md"}' } },
        { id: 'call_3', type: 'function', function: { name: 'grep', arguments: '{"wzorzec": ' } },
        { id: 'call_4', type: 'function', function: { name: 'ile', arguments: '42' } },
        { function: { name: '' } },
      ],
    }],
  }).messages ?? [];

  const wywolania = msgs[0].tool_calls as Array<{ id?: string; function: { name: string; arguments: unknown } }>;
  t.is(wywolania.length, 4, 'wywołanie bez nazwy funkcji nie ma czego wołać');
  t.deepEqual(wywolania.map(w => w.id), ['call_1', 'call_2', 'call_3', 'call_4']);
  t.deepEqual(wywolania[0].function.arguments, { path: 'a.md', linie: 12 }, 'obiekt idzie obiektem');
  t.deepEqual(wywolania[1].function.arguments, { path: 'b.md' }, 'tekst czytelny jako obiekt JSON zostaje rozpakowany');
  t.is(wywolania[2].function.arguments, '{"wzorzec": ',
    'urwany JSON idzie DALEJ takim, jaki przyszedł — nic nie może zniknąć po cichu');
  t.is(wywolania[3].function.arguments, '42',
    'tekst czytelny jako JSON, ale nie jako OBIEKT, też zostaje tekstem');
});

test('F10: tryb myślenia to FLAGA, a bez niego pole `think` w ogóle nie wchodzi', t => {
  t.is(bodyOf({ ...REQ, thinking: true }).think, true);
  t.is(bodyOf({ ...REQ, thinking: 2048 }).think, true, 'budżet w tokenach znaczy dla demona tyle co true');
  t.false('think' in bodyOf(REQ));
});

test('F10: limit odpowiedzi — żądanie, potem kontekst, na końcu wyliczenie z platformy', t => {
  t.is(bodyOf({ ...REQ, max_tokens: 1 }, makeCtx({ modelId: 'qwen3' })).options?.num_predict, 1,
    'jedynka z żądania też jest wartością dodatnią');
  t.is(bodyOf(REQ, makeCtx({ modelId: 'qwen3', maxOutputTokens: 777 })).options?.num_predict, 777);
  t.is(bodyOf(REQ, makeCtx({ modelId: 'qwen3' })).options?.num_predict, MODEL_MAX_TOKENS_DEFAULTS.ollama);
});

test('F10: liczniki tokenów — liczby, liczby w stringu, brak jednego z nich', t => {
  const usage = (liczniki: Record<string, unknown>) => ollamaProvider.parseCompletion(
    { model: 'qwen3', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', ...liczniki },
    REQ,
    CTX,
  ).usage;

  t.deepEqual(usage({ prompt_eval_count: 10, eval_count: 20 }), { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  t.deepEqual(usage({ prompt_eval_count: '10', eval_count: '20' }), { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    'demon bywa kapryśny i podaje licznik stringiem — to nadal liczba');
  t.deepEqual(usage({ prompt_eval_count: 7 }), { prompt_tokens: 7 }, 'jeden licznik wystarczy, sumy wtedy nie ma');
  t.deepEqual(usage({ eval_count: 9 }), { completion_tokens: 9 });
  t.deepEqual(usage({}), {}, 'brak obu liczników to sygnał estymacji (BA-08)');
  t.deepEqual(usage({ prompt_eval_count: '', eval_count: 'nie-liczba' }), {},
    'pusty string i śmieć to BRAK licznika, nie zero');
});

test('F10: powód końca — własny wygrywa, samo done spada na stop, brak końca to null', t => {
  const powod = (koniec: Record<string, unknown>) => ollamaProvider.parseCompletion(
    { model: 'qwen3', message: { role: 'assistant', content: 'x' }, ...koniec },
    REQ,
    CTX,
  ).choices[0].finish_reason;

  t.is(powod({ done: true, done_reason: 'length' }), 'length');
  t.is(powod({ done: true }), 'stop');
  t.is(powod({ done: false }), null);
});

test('F10: ładunek z polem error oddaje błąd zamiast rzucać (BA-22)', t => {
  const odpowiedz = ollamaProvider.parseCompletion({ error: 'model "qwen9" not found' }, REQ, CTX);

  t.truthy(odpowiedz.error, 'pętla ma dostać kształt, na którym umie stanąć');
  t.is(odpowiedz.choices[0].message.content, '');
  t.is(odpowiedz.choices[0].finish_reason, null);
});

test('F10: tool_calls w odpowiedzi bez strumienia — string i obiekt przechodzą, śmieć spada na {}', t => {
  const msg = ollamaProvider.parseCompletion({
    model: 'qwen3',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', function: { name: 'read', arguments: '{"path":"a.md"}' } },
        { function: { name: 'ile', arguments: 42 } },
      ],
    },
    done: true,
    done_reason: 'stop',
  }, REQ, CTX).choices[0].message;

  t.is(msg.tool_calls![0].function.arguments, '{"path":"a.md"}', 'string idzie stringiem (OL-05)');
  t.is(msg.tool_calls![1].function.arguments, '{}', 'ani string, ani obiekt = pusty obiekt argumentów');

  const zwykla = ollamaProvider.parseCompletion(
    { model: 'qwen3', message: { role: 'assistant', content: 'ok' }, done: true },
    REQ,
    CTX,
  ).choices[0].message;
  t.is(zwykla.tool_calls, undefined, 'odpowiedź bez narzędzi nie dostaje pustej tablicy');
});

test('F10: strumień oddaje zużycie i identyfikator wywołania narzędzia', t => {
  const linia = JSON.stringify({
    model: 'qwen3',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: { path: 'a.md' } } }],
    },
    done: false,
  }) + '\n';

  const events = collectEvents(ollamaProvider.createStreamDecoder(REQ, CTX), [linia, DONE]);
  const wywolanie = events.find((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');
  const zuzycie = events.find((e): e is Extract<StreamEvent, { type: 'usage' }> => e.type === 'usage');

  t.is(wywolanie?.id, 'call_1');
  t.is(wywolanie?.name, 'read');
  t.is(wywolanie?.index, 0, 'slot wskazuje pozycja w tablicy — demon nie skleja fragmentów');
  t.deepEqual(zuzycie?.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
});

test('F10: urwany ogon porcji czeka na resztę bajtów, nie ląduje w koszu', t => {
  const decoder = ollamaProvider.createStreamDecoder(REQ, CTX);

  t.deepEqual(decoder.feed('{"model":"qwen3","message":{"role":"assistant","content":"urwa'), [],
    'niekompletny JSON nie daje jeszcze żadnego zdarzenia');

  const reszta = decoder.feed('ne"},"done":true,"done_reason":"stop"}');
  t.is(emitted(reszta), 'urwane', 'sklejona linia wychodzi w całości');
  t.true(reszta.some(e => e.type === 'done'), 'ostatnia linia bez znaku nowej linii też kończy turę');
  t.is(decoder.droppedFrames, 0, 'nic nie poszło do kosza jako nieczytelne (ST-11)');
});

test('F10: katalog przy błędnym statusie jest PUSTY, nawet gdy ciało jest poprawnym JSON-em', async t => {
  const zly = new CapturingHttpClient({ status: 404, body: { models: [{ model: 'qwen3:8b' }] } });
  t.deepEqual(await ollamaProvider.listModels(makeCtx(), zly), [], 'status spoza 2xx nie ma treści do czytania');

  const dobry = new CapturingHttpClient({ status: 200, body: { models: [{ model: 'qwen3:8b' }] } });
  t.deepEqual((await ollamaProvider.listModels(makeCtx(), dobry)).map(m => m.id), ['qwen3:8b']);
});
