import test from 'ava';
import { anthropicProvider } from './anthropic.js';
import { buildCacheMetadata, MODEL_MAX_TOKENS_DEFAULTS } from '../cache_utils.js';
import { PROVIDER_INFO } from '../registry.js';
import { CapturingHttpClient, collect, collectEvents, makeCtx } from '../testing/harness.js';
import { TOOL_CALL_MAX_INDEX } from '../contracts.js';
import type { ChatRequest, OpenAiCompletion, OpenAiRequestMessage, ProviderContext, StreamEvent } from '../contracts.js';

/**
 * Testy regresji fabryki napraw F03 (klaster models-adaptery-streamu, 2026-08-30).
 *
 * Do tego audytu `modules/models/` nie miał ani jednego testu dostawcy Anthropic — kierunek
 * AUD-code-review-018 to wprost odnotował. Ten plik pilnuje trzech napraw naraz, bo wszystkie
 * dotyczą tej samej pary (dekoder strumienia / budowa żądania):
 *
 * - AUD-code-review-018 (HIGH): domknięcie bloku dopasowywało `tool_use` heurystyką
 *   "pierwszy z pustym input", więc dwa równoległe wywołania w jednej turze mieszały argumenty.
 * - AUD-code-review-078 (MEDIUM): delta tekstu pisała zawsze do PIERWSZEGO bloku text zamiast
 *   do OSTATNIEGO (symetria z deltą myślenia tuż obok).
 * - AUD-code-review-079 (HIGH): budowa żądania NADPISYWAŁA tekst assistant blokami `tool_use`,
 *   zamiast złożyć je w jedną wspólną tablicę `content`, jak wymaga Anthropic.
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
const CTX: ProviderContext = makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: 'sk-ant-test' });

/** Karmi dekoder Anthropica porcjami SSE i oddaje kształt kanoniczny. */
function decode(chunks: string[]): OpenAiCompletion {
  return collect(anthropicProvider.createStreamDecoder(REQ, CTX), chunks);
}

/** Wiadomości po tłumaczeniu na kształt Anthropica (Messages API). */
function transformMessages(messages: OpenAiRequestMessage[]) {
  const spec = anthropicProvider.buildRequest({ messages }, CTX, false);
  return (JSON.parse(spec.body ?? '{}') as { messages: Array<{ role: string; content: unknown }> }).messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUD-code-review-018 — dopasowanie tool_use po indeksie, nie po "pierwszy pusty"
// ─────────────────────────────────────────────────────────────────────────────

test('018: dwa tool_use w jednej turze — ten z PUSTYMI argumentami nie kradnie argumentów drugiego', t => {
  const snapshot = decode([
    // Blok 0: narzędzie bezargumentowe — start i stop bez ŻADNEGO input_json_delta pomiędzy.
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_A","name":"kom_list","input":{}}}',
    'data: {"type":"content_block_stop","index":0}',
    // Blok 1: narzędzie z argumentami.
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_B","name":"vault_read","input":{}}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"tajne.md\\"}"}}',
    'data: {"type":"content_block_stop","index":1}',
  ]);


  const message = snapshot.choices[0].message as {
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
  const calls = message.tool_calls!;
  t.is(calls.length, 2);

  const kom = calls.find(c => c.id === 'toolu_A')!;
  const vault = calls.find(c => c.id === 'toolu_B')!;
  t.is(kom.function.name, 'kom_list');
  t.is(kom.function.arguments, '{}', 'narzędzie bezargumentowe NIE dostaje cudzych argumentów (dawny bug: "pierwszy pusty" heurystyka)');
  t.is(vault.function.name, 'vault_read');
  t.deepEqual(JSON.parse(vault.function.arguments) as unknown, { path: 'tajne.md' }, 'drugie narzędzie zachowuje SWOJE argumenty');
});

test('018: dwa tool_use z PRZEPLECIONYMI deltami (in-flight naraz) — JSON każdego trafia do własnego bloku', t => {
  const snapshot = decode([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_A","name":"a","input":{}}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_B","name":"b","input":{}}}',
    // Deltas przeplecione: 1, 0, 1, 0 — jakby model streamował oba naraz.
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"n\\":"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"2}"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_stop","index":1}',
  ]);


  const message = snapshot.choices[0].message as {
    tool_calls?: Array<{ id: string; function: { arguments: string } }>;
  };
  const calls = message.tool_calls!;
  const a = calls.find(c => c.id === 'toolu_A')!;
  const b = calls.find(c => c.id === 'toolu_B')!;
  t.deepEqual(JSON.parse(a.function.arguments) as unknown, { n: 2 });
  t.deepEqual(JSON.parse(b.function.arguments) as unknown, { q: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUD-code-review-078 — text_delta pisze do OSTATNIEGO bloku text
// ─────────────────────────────────────────────────────────────────────────────

test('078: tekst -> tool_use -> tekst — drugi kawałek dopisuje się do DRUGIEGO bloku, nie do pierwszego', t => {
  const snapshot = decode([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sprawdzę to w vaultcie... "}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"vault_read","input":{}}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Znalazłem."}}',
    'data: {"type":"content_block_stop","index":2}',
  ]);


  const message = snapshot.choices[0].message;
  t.is(message.content, 'Sprawdzę to w vaultcie... \n\nZnalazłem.');
});

// ─────────────────────────────────────────────────────────────────────────────
// AUD-code-review-079 — request adapter: tekst + tool_calls w JEDNEJ wspólnej tablicy content
// ─────────────────────────────────────────────────────────────────────────────

test('079: assistant z tekstem I tool_calls jednocześnie — tekst NIE znika, oba lądują w jednej tablicy content', t => {
  const [msg] = transformMessages([
    {
      role: 'assistant',
      content: 'Sprawdzę to w vaultcie...',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } }],
    },
  ]);

  t.is(msg.role, 'assistant');
  t.true(Array.isArray(msg.content), 'content musi być tablicą bloków, nie samym tool_use');
  const blocks = msg.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  t.is(blocks.length, 2);
  t.deepEqual(blocks[0] as unknown, { type: 'text', text: 'Sprawdzę to w vaultcie...' });
  t.is(blocks[1].type, 'tool_use');
  t.is(blocks[1].name, 'vault_read');
  t.deepEqual(blocks[1].input as unknown, { path: 'a.md' });
});

test('079: assistant z SAMYMI tool_calls (bez tekstu) nie dostaje pustego bloku text — zachowanie bez zmian', t => {
  const [msg] = transformMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  ]);

  const blocks = msg.content as Array<{ type: string }>;
  t.is(blocks.length, 1);
  t.is(blocks[0].type, 'tool_use');
});

test('079: assistant z SAMYM tekstem (bez tool_calls) zostaje zwykłym stringiem — zachowanie bez zmian', t => {
  const [msg] = transformMessages([{ role: 'assistant', content: 'zwykła odpowiedź' }]);
  t.is(msg.content, 'zwykła odpowiedź');
});

// ─────────────────────────────────────────────────────────────────────────────
// AUD-dead-code-213 — `message.usage` z `message_start` musi się MERGE'OWAĆ do snapshotu
// ─────────────────────────────────────────────────────────────────────────────
//
// Anthropic wysyła input_tokens + oba liczniki cache WYŁĄCZNIE w `message.usage` zdarzenia
// `message_start`; `message_delta` niesie później tylko `usage.output_tokens` na POZIOMIE
// GŁÓWNYM. Dekoder czytał z `chunk.message` tylko id/model/role, więc tłumaczenie na kształt
// kanoniczny zawsze oddawało prompt_tokens:0 i cztery zera cache na żywym streamingu (tor
// non-streaming mapował te same pola poprawnie od zawsze — rozjazd widać tylko na czacie).
//
// Drugi commit (review opus) dokłada dwie poprawki do PIERWSZEGO fixu:
// 1. `prompt_tokens`/`total_tokens` muszą SUMOWAĆ input_tokens + oba liczniki cache — u Anthropica
//    te trzy pola są ROZŁĄCZNE (input_tokens = TYLKO tokeny nie-cache'owane), a konwencja OpenAI
//    zakłada, że `cached_tokens` jest PODZBIOREM `prompt_tokens`. Bez sumowania prompt_tokens był
//    zaniżony o cały cache.
// 2. `output_tokens` z `message.usage` (message_start) jest tylko WSTĘPNYM placeholderem — merge
//    go POMIJA, żeby urwany stream (bez `message_delta`) nie zostawił fałszywego `output_tokens:1`
//    zamiast prawdziwego zera.

test('213: pełna sekwencja SSE — prompt_tokens sumuje input_tokens + oba liczniki cache, completion_tokens z message_delta', t => {
  const snapshot = decode([
    'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":800,"output_tokens":1}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Czesc"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":57}}',
    'data: {"type":"message_stop"}',
  ]);


  const { usage } = snapshot as unknown as {
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      prompt_tokens_details: { cached_tokens: number; cache_creation_tokens: number };
    };
  };

  t.is(usage.prompt_tokens, 2300, 'input_tokens (1200) + cache_creation (300) + cache_read (800) — trzy liczniki ROZŁĄCZNE u Anthropica, sumowane do prompt_tokens w konwencji OpenAI');
  t.is(usage.cache_creation_input_tokens, 300);
  t.is(usage.cache_read_input_tokens, 800);
  t.is(usage.completion_tokens, 57, 'output_tokens z message_delta (poziom główny) NADPISUJE placeholder output_tokens:1 z message_start — merge message.usage go teraz świadomie pomija');
  t.is(usage.total_tokens, 2357, 'total spójny: prompt_tokens (2300) + completion_tokens (57)');
  t.deepEqual(usage.prompt_tokens_details, { cached_tokens: 800, cache_creation_tokens: 300 });

  // cache_utils.ts jest node-czyste (zero importów) — buildCacheMetadata wołalne wprost w teście.
  const cacheMeta = buildCacheMetadata(usage);
  t.is(cacheMeta.cached_tokens, 800);
  t.true(cacheMeta.cached_tokens <= usage.prompt_tokens, 'cached_tokens musi być PODZBIOREM prompt_tokens (kontrakt OpenAI) — z zaniżonym prompt_tokens sprzed drugiego commitu savings_pct przekraczałby 100%');
  t.true(cacheMeta.savings_pct <= 100, 'savings_pct = cached/prompt_tokens*100 — nie może przekroczyć 100%');
});

test('213: message_start Z usage, ale BEZ message_delta (Stop usera / urwany transport) — completion_tokens zostaje 0, nie dziedziczy placeholdera', t => {
  const snapshot = decode([
    'data: {"type":"message_start","message":{"id":"msg_02","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":800,"output_tokens":1}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Cze"}}',
    // Stream urwany TUTAJ — brak content_block_stop, brak message_delta, brak message_stop.
  ]);


  const { usage } = snapshot as unknown as {
    usage: { prompt_tokens: number; completion_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  };

  t.is(usage.completion_tokens, 0, 'output_tokens:1 z message_start jest tylko placeholderem — merge go pomija, więc bez message_delta zostaje prawdziwe zero, nie fałszywa jedynka blokująca fallback liczenia tokenów treści');
  t.is(usage.prompt_tokens, 2300, 'input_tokens/cache dochodzą z message_start niezależnie od tego, czy message_delta w ogóle nadejdzie');
  t.is(usage.cache_creation_input_tokens, 300);
  t.is(usage.cache_read_input_tokens, 800);
});

test('213: message_delta z PEŁNYM skumulowanym usage na poziomie głównym (kształt server-tools) NADPISUJE message_start, nie sumuje się z nim', t => {
  const snapshot = decode([
    'data: {"type":"message_start","message":{"id":"msg_03","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":800,"output_tokens":1}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Czesc"}}',
    'data: {"type":"content_block_stop","index":0}',
    // Wariant udokumentowany dla odpowiedzi z narzędziami serwerowymi Anthropica: message_delta
    // niesie PEŁNE skumulowane usage (nie tylko output_tokens) na poziomie głównym chunka.
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10682,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":57}}',
    'data: {"type":"message_stop"}',
  ]);


  const { usage } = snapshot as unknown as {
    usage: { prompt_tokens: number; completion_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  };

  t.is(usage.prompt_tokens, 10682, 'message_delta na poziomie głównym NADPISUJE input_tokens z message_start (1200) — merge istniejący od pierwszego commitu, bez zmian w tym fixie');
  t.is(usage.completion_tokens, 57);
  t.is(usage.cache_creation_input_tokens, 0, 'zera z message_delta też NADPISUJĄ — gdyby to było sumowanie, zostałoby 300 z message_start');
  t.is(usage.cache_read_input_tokens, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// no-deprecated (AUD F02/W4, release 2.2.0): fallback listy modeli przestał czytać
// deprecated getter z zaszytą listą — dziś ponawia wzbogacanie metadanych, które samo
// nie rzuca (błąd sieci katalogu modeli łapany u siebie).
// ─────────────────────────────────────────────────────────────────────────────

test('no-deprecated: listModels() w gałęzi catch nie rzuca i oddaje PUSTĄ listę, nie zaszytą w kodzie', async t => {
  const deadHttp = new CapturingHttpClient().throwOn(new Error('net down'));

  const models = await anthropicProvider.listModels(CTX, deadHttp);

  t.deepEqual(models, [], 'bez sieci i bez modeli w keszu katalogu wynik to PUSTA tablica (B.5 ST-21) — nie lista zaszyta w kodzie (B.7 AN-18)');
  t.true(Array.isArray(models), 'nowy kontrakt to ModelInfo[], nie mapa');
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Caching v1 (S06) + budżety (N21/N22)
// ─────────────────────────────────────────────────────────────────────────────

/** Body żądania po `JSON.parse` — tylko pola, które ten plik sprawdza. */
type CacheBlock = { cache_control?: { type?: string } };
type ParsedBody = {
  system?: CacheBlock[];
  tools?: CacheBlock[];
  messages?: Array<{ content?: CacheBlock[] | string }>;
  max_tokens?: number;
  thinking?: { type?: string; budget_tokens?: number };
};

function bodyOf(req: ChatRequest): ParsedBody {
  return JSON.parse(anthropicProvider.buildRequest(req, CTX, false).body ?? '{}') as ParsedBody;
}

function ephemeralBlocks(body: ParsedBody): CacheBlock[] {
  return [
    ...(Array.isArray(body.system) ? body.system : []),
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(body.messages ?? []).flatMap(m => (Array.isArray(m.content) ? m.content : [])),
  ].filter(block => block.cache_control?.type === 'ephemeral');
}

test('Anthropic request marks up to four cache_control blocks', t => {
  const body = bodyOf({
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'first user' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second user' },
    ],
    tools: [{
      type: 'function',
      function: { name: 'vault_read', description: 'Read file', parameters: { type: 'object' } },
    }],
  });

  t.is(ephemeralBlocks(body).length, 4);
  t.is(body.tools![0].cache_control!.type, 'ephemeral');
});

test('AUD-testy-035: Anthropic request forwards max_tokens (default when not explicit)', t => {
  const body = JSON.parse(
    anthropicProvider.buildRequest(
      { messages: [{ role: 'user', content: 'hello' }] },
      makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: 'sk-ant-test', maxOutputTokens: MODEL_MAX_TOKENS_DEFAULTS.anthropic }),
      false,
    ).body ?? '{}',
  ) as ParsedBody;

  t.is(body.max_tokens, MODEL_MAX_TOKENS_DEFAULTS.anthropic, 'Messages API WYMAGA max_tokens — brak pola = 400 od dostawcy (sesja 125: ten sam kształt buga co po stronie OpenAI)');
  t.is(anthropicProvider.buildRequest(REQ, CTX, false).headers['x-api-key'], 'sk-ant-test');
  t.is(PROVIDER_INFO.anthropic.apiKeyHeader, 'x-api-key');
});

test('Anthropic usage exposes cache read/create tokens in OpenAI-like usage', t => {
  const parsed = anthropicProvider.parseCompletion(
    {
      id: 'msg_1',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 20,
        cache_creation_input_tokens: 600,
        cache_read_input_tokens: 400,
      },
    },
    REQ,
    CTX,
  ) as unknown as { usage: { prompt_tokens_details: { cached_tokens: number; cache_creation_tokens: number } } };

  t.is(parsed.usage.prompt_tokens_details.cached_tokens, 400);
  t.is(parsed.usage.prompt_tokens_details.cache_creation_tokens, 600);
});

/**
 * N21 (luka L-22, B.7 AN-03): przy MNIEJSZEJ liczbie kandydatów ma być MNIEJ znaczników,
 * a nie wyjątek — cztery to SUFIT, nie wymóg.
 */
test('L-22: cache_control przy MNIEJ niż czterech kandydatach i przy braku tools', t => {
  const withoutTools = bodyOf({
    messages: [
      { role: 'system', content: 'stable system' },
      { role: 'user', content: 'jedyne pytanie' },
    ],
  });
  const marks = ephemeralBlocks(withoutTools).length;
  t.true(marks <= 3, `bez tools maksymalnie trzy znaczniki, było ${marks}`);
  t.is(withoutTools.tools, undefined, 'brak narzędzi = brak pola tools, nie pusta tablica ze znacznikiem');

  t.notThrows(() => bodyOf({ messages: [{ role: 'user', content: 'sam user' }] }), 'jeden kandydat nie może rzucić');
});

/**
 * N22 (B.7 AN-19, spec §1.1): `thinking: true` daje blok myślenia z budżetem MNIEJSZYM
 * niż `max_tokens` — inaczej Anthropic odbija żądanie.
 */
test('thinking: true daje blok thinking z budżetem MNIEJSZYM niż max_tokens', t => {
  const body = JSON.parse(
    anthropicProvider.buildRequest(
      { messages: [{ role: 'user', content: 'pomyśl' }], thinking: true },
      makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: 'sk-ant-test', maxOutputTokens: MODEL_MAX_TOKENS_DEFAULTS.anthropic }),
      false,
    ).body ?? '{}',
  ) as ParsedBody;

  t.truthy(body.thinking, 'pole thinking musi powstać');
  t.is(body.thinking?.type, 'enabled');
  t.true((body.thinking?.budget_tokens ?? 0) > 0, 'budżet musi być dodatni');
  t.true(
    (body.thinking?.budget_tokens ?? 0) < (body.max_tokens ?? 0),
    `budżet myślenia (${body.thinking?.budget_tokens}) MUSI być mniejszy niż max_tokens (${body.max_tokens})`,
  );

  const without = bodyOf({ messages: [{ role: 'user', content: 'bez myślenia' }] });
  t.is(without.thinking, undefined, 'brak flagi = BRAK pola thinking');
});

// ─────────────────────────────────────────────────────────────────────────────
// F10 (bramka mutacyjna): zachowania, które przeżywały mutacje operatorów
//
// Każdy test poniżej pinuje obserwowalny efekt (URL żądania, pole ciała, zdarzenie
// dekodera, kształt kanoniczny) w miejscu, w którym drobna zmiana operatora nie
// wywracała ani jednego istniejącego testu.
// ─────────────────────────────────────────────────────────────────────────────

/** Ciało żądania po `JSON.parse` — szerszy widok niż `ParsedBody` wyżej. */
type F10Body = {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  thinking?: { type?: string; budget_tokens?: number };
  tool_choice?: { type?: string; name?: string };
  system?: unknown[];
  tools?: unknown[];
  messages?: Array<{ role?: string; content?: unknown }>;
};

function bodyWith(req: ChatRequest, ctx: ProviderContext): F10Body {
  return JSON.parse(anthropicProvider.buildRequest(req, ctx, false).body ?? '{}') as F10Body;
}

const HEJ = REQ.messages;

// ── katalog modeli ───────────────────────────────────────────────────────────

test('F10: listModels() bierze katalog JEDNYM żądaniem — ścieżka /v1/models i limit 1000', async t => {
  const http = new CapturingHttpClient({ status: 200, body: { data: [] } });

  t.deepEqual(await anthropicProvider.listModels(CTX, http), []);
  t.is(http.sends, 1, 'katalog to jedno żądanie, nie stronicowanie po 20');
  t.is(http.lastSpec?.url, 'https://api.anthropic.com/v1/models?limit=1000');
  t.is(http.lastSpec?.method, 'GET');
  t.is(http.lastSpec?.headers['anthropic-version'], '2023-06-01');
  t.is(http.lastSpec?.headers['x-api-key'], 'sk-ant-test');
});

test('F10: adres z kontekstu — znana ścieżka odcięta, sklejenie oddaje STRING', async t => {
  const ctx = makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: 'k', endpoint: 'https://proxy.local/v1/messages/' });

  t.is(anthropicProvider.buildRequest(REQ, ctx, false).url, 'https://proxy.local/v1/messages');

  const http = new CapturingHttpClient({ status: 200, body: { data: [] } });
  await anthropicProvider.listModels(ctx, http);
  t.is(http.lastSpec?.url, 'https://proxy.local/v1/models?limit=1000', 'katalog mieszka OBOK tury rozmowy, nie pod nią');

  const pusty = makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: 'k', endpoint: '' });
  t.is(anthropicProvider.buildRequest(REQ, pusty, false).url, 'https://api.anthropic.com/v1/messages', 'pusty adres = adres produkcyjny');
});

test('F10: listModels() przy 200 mapuje katalog; niedodatnie limity NIE trafiają do ModelInfo', async t => {
  const http = new CapturingHttpClient({
    status: 200,
    body: {
      data: [
        { id: 'claude-a', display_name: 'Claude A', max_tokens: 8192, max_input_tokens: 200000, capabilities: { image_input: { supported: true } } },
        { id: 'claude-b', max_tokens: 0, max_input_tokens: 0 },
        { id: 'claude-c', max_tokens: -1, max_input_tokens: -1 },
        { id: '' },
        'śmieć',
      ],
    },
  });

  t.deepEqual(await anthropicProvider.listModels(CTX, http), [
    { id: 'claude-a', name: 'Claude A', multimodal: true, max_output_tokens: 8192, max_input_tokens: 200000 },
    { id: 'claude-b', name: 'claude-b' },
    { id: 'claude-c', name: 'claude-c' },
  ], 'zero i wartości ujemne to BRAK metadanej, nie limit zerowy; wpis bez id wypada');
});

test('F10: listModels() przy statusie innym niż 200 oddaje PUSTĄ listę i nie czyta ciała', async t => {
  const http = new CapturingHttpClient({ status: 401, body: { data: [{ id: 'nie-czytamy-tego' }] } });

  t.deepEqual(await anthropicProvider.listModels(CTX, http), [], 'odrzucone żądanie katalogu = pusta lista (ST-21)');
});

// ── budowa żądania ───────────────────────────────────────────────────────────

test('F10: max_tokens — jawne 0 i wartość ujemna NIE są budżetem, kontekstowa jedynka już tak', t => {
  const zKontekstem = makeCtx({ modelId: 'claude-sonnet-4-20250514', maxOutputTokens: 5000 });

  t.is(bodyWith({ messages: HEJ, max_tokens: 0 }, zKontekstem).max_tokens, 5000, 'zero z żądania spada na kontekst, nie jedzie jako limit');
  t.is(bodyWith({ messages: HEJ, max_tokens: -3 }, zKontekstem).max_tokens, 5000);
  t.is(bodyWith({ messages: HEJ, max_tokens: 4096.7 }, zKontekstem).max_tokens, 4096, 'ułamek przycięty w dół');
  t.is(bodyWith({ messages: HEJ }, makeCtx({ modelId: 'claude-sonnet-4-20250514', maxOutputTokens: 1 })).max_tokens, 1, 'każdy DODATNI limit z kontekstu jedzie wprost');
  t.is(
    bodyWith({ messages: HEJ }, makeCtx({ modelId: 'claude-sonnet-4-20250514', maxOutputTokens: 0 })).max_tokens,
    MODEL_MAX_TOKENS_DEFAULTS.anthropic,
    'dopiero brak sensownego limitu spada na domyślny',
  );
});

test('F10: myślenie na granicy 1024 — DOKŁADNIE na minimum jeszcze się nie włącza', t => {
  t.is(bodyWith({ messages: HEJ, thinking: true, max_tokens: 1024 }, CTX).thinking, undefined, 'budżet musi być MNIEJSZY niż max_tokens, więc przy równym minimum myślenia nie ma');

  const owlos = bodyWith({ messages: HEJ, thinking: true, max_tokens: 1025 }, CTX);
  t.is(owlos.thinking?.type, 'enabled');
  t.is(owlos.thinking?.budget_tokens, 1024, 'jeden token nad minimum: budżet = minimum API, czyli max_tokens - 1');

  t.is(bodyWith({ messages: HEJ, thinking: 999999, max_tokens: 8192 }, CTX).thinking?.budget_tokens, 8191, 'żądany budżet przycięty do max_tokens - 1');
});

test('F10: temperature 0 z żądania NIE spada na wartość z kontekstu', t => {
  const ctx = makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: 'k', temperature: 0.7 });

  t.is(bodyWith({ messages: HEJ, temperature: 0 }, ctx).temperature, 0, 'zero to WYBRANA temperatura, nie brak wyboru');
  t.is(bodyWith({ messages: HEJ }, ctx).temperature, 0.7);
  t.is(bodyWith({ messages: HEJ, thinking: true }, ctx).temperature, undefined, 'przy myśleniu temperatury nie wysyłamy w ogóle');
});

test('F10: model z żądania jedzie DOSŁOWNIE; dopiero brak pola spada na kontekst', t => {
  t.is(bodyWith({ messages: HEJ, model: 'claude-opus-4-1' }, CTX).model, 'claude-opus-4-1');
  t.is(bodyWith({ messages: HEJ }, CTX).model, 'claude-sonnet-4-20250514');
  t.is(bodyWith({ messages: HEJ, model: '' }, CTX).model, '', 'pusty string to PODANA wartość, nie brak pola — fallback jest nullish, nie falsy');
});

test('F10: tool_choice — cztery kształty kanoniczne na słownik Anthropica', t => {
  t.deepEqual(bodyWith({ messages: HEJ, tool_choice: 'auto' }, CTX).tool_choice, { type: 'auto' });
  t.deepEqual(bodyWith({ messages: HEJ, tool_choice: 'required' }, CTX).tool_choice, { type: 'any' }, 'required to `any` u Anthropica, nie `auto`');
  t.deepEqual(bodyWith({ messages: HEJ, tool_choice: 'none' }, CTX).tool_choice, { type: 'none' });
  t.deepEqual(
    bodyWith({ messages: HEJ, tool_choice: { type: 'function', function: { name: 'vault_read' } } }, CTX).tool_choice,
    { type: 'tool', name: 'vault_read' },
  );
  t.is(bodyWith({ messages: HEJ }, CTX).tool_choice, undefined, 'brak wyboru = brak pola');
});

test('F10: obraz — data: URI jako base64, https jako url, reszta wypada', t => {
  const dane = bodyWith({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] }] }, CTX);
  t.deepEqual(dane.messages?.[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }]);

  const link = bodyWith({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://vault.local/a.png' } }] }] }, CTX);
  t.deepEqual(link.messages?.[0].content, [{ type: 'image', source: { type: 'url', url: 'https://vault.local/a.png' } }]);

  const smiec = bodyWith({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'ftp://vault.local/a.png' } }] }] }, CTX);
  t.deepEqual(smiec.messages, [], 'obrazu, którego nie da się przenieść, nie zastępujemy pustą wiadomością');
});

test('F10: mieszana treść usera — blok tekstu i blok obrazu trafiają KAŻDY do swojej gałęzi', t => {
  const body = bodyWith({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'co widzisz?' },
        { type: 'image_url', image_url: { url: 'https://vault.local/a.png' } },
      ],
    }],
  }, CTX);

  t.deepEqual(body.messages?.[0].content, [
    { type: 'text', text: 'co widzisz?' },
    { type: 'image', source: { type: 'url', url: 'https://vault.local/a.png' } },
  ]);
});

// ── odpowiedź bez strumienia ─────────────────────────────────────────────────

test('F10: parseCompletion — treść, myślenie, indeks wyboru i słownik stop_reason', t => {
  const gotowe = anthropicProvider.parseCompletion(
    { id: 'msg_9', model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }, { type: 'thinking', thinking: 'hmm' }] },
    REQ,
    CTX,
  );

  t.is(gotowe.choices[0].index, 0, 'kształt kanoniczny ma DOKŁADNIE jeden wybór o indeksie 0');
  t.is(gotowe.choices[0].message.content, 'ok', 'bloki treści są czytane, a nie pomijane');
  t.is(gotowe.choices[0].message.reasoning_content, 'hmm');
  t.is(gotowe.choices[0].finish_reason, 'stop', 'end_turn to kanoniczne `stop`');
  t.deepEqual(gotowe.usage, {}, 'bez usage zostaje PUSTY obiekt (sygnał „estymuj")');

  const powod = (stop?: string): string | null | undefined =>
    anthropicProvider.parseCompletion(stop === undefined ? { content: [] } : { stop_reason: stop, content: [] }, REQ, CTX).choices[0].finish_reason;

  t.is(powod('tool_use'), 'tool_calls');
  t.is(powod('max_tokens'), 'length');
  t.is(powod('refusal'), 'content_filter');
  t.is(powod('stop_sequence'), 'stop');
  t.is(powod(undefined), 'stop', 'brak powodu też jest kanonicznym `stop`, nie pustką');
  t.is(powod('cos_nowego_od_dostawcy'), 'cos_nowego_od_dostawcy', 'nieznany powód przechodzi bez zmian');
});

// ── dekoder strumienia ───────────────────────────────────────────────────────

test('F10: ramka rozcięta między porcjami CZEKA na dalszy ciąg, nie idzie do kosza', t => {
  const decoder = anthropicProvider.createStreamDecoder(REQ, CTX);
  const snapshot = collect(decoder, [
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_de',
    'lta","text":"ciachnięte"}}',
  ]);

  t.is(snapshot.choices[0].message.content, 'ciachnięte', 'ogon porcji bez końca wiersza dojrzewa w buforze, dopóki ładunek się nie sparsuje');
  t.is(decoder.droppedFrames, 0, 'rozcięcie transportu to NIE jest nieczytelna ramka');
});

test('F10: dwie ramki w JEDNEJ porcji — drugi wiersz nie traci pierwszego znaku', t => {
  const snapshot = decode([
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}\n'
    + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"B"}}\n',
  ]);

  t.is(snapshot.choices[0].message.content, 'AB');
});

test('F10: ogon dokładnie 1 MiB bez końca wiersza jeszcze przeżywa — sufit bufora jest OSTRY', t => {
  const sufit = 1024 * 1024;
  const prefiks = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"';
  const wypelniacz = 'x'.repeat(sufit - prefiks.length);

  const snapshot = decode([prefiks + wypelniacz, '"}}']);

  t.is(String(snapshot.choices[0].message.content).length, wypelniacz.length, 'bufor DOKŁADNIE na sufcie nie leci do kosza — dopiero powyżej');
});

test('F10: content_block_start typu thinking oddaje myślenie; nieznany typ bloku jest CICHY', t => {
  const snapshot = decode([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"licze"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" dalej"}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"zaszyfrowane"}}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":"gotowe"}}',
  ]);

  const message = snapshot.choices[0].message;
  t.is(message.reasoning_content, 'licze dalej', 'myślenie z OTWARCIA bloku liczy się tak samo jak z delty');
  t.is(message.content, 'gotowe');
});

test('F10: numeracja slotów narzędzi jest własna i gęsta, a indeks spoza zakresu nie otwiera nowego slotu', t => {
  const malejaco: string[] = [];
  for (let i = TOOL_CALL_MAX_INDEX - 1; i >= 0; i -= 1) {
    malejaco.push(`data: {"type":"content_block_start","index":${i},"content_block":{"type":"tool_use","id":"toolu_${i}","name":"n${i}","input":{}}}`);
  }
  const wywolania = collectEvents(anthropicProvider.createStreamDecoder(REQ, CTX), malejaco)
    .filter((ev): ev is Extract<StreamEvent, { type: 'tool_call' }> => ev.type === 'tool_call');

  t.is(wywolania.length, TOOL_CALL_MAX_INDEX);
  t.deepEqual(wywolania.map(ev => ev.index), wywolania.map((_, i) => i), 'sloty numerujemy po kolei od zera, niezależnie od indeksu bloku');
  t.is(wywolania[wywolania.length - 1].index, TOOL_CALL_MAX_INDEX - 1, 'najwyższy możliwy slot to ostatni dopuszczalny');

  const smiecie = collectEvents(anthropicProvider.createStreamDecoder(REQ, CTX), [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_0","name":"a","input":{}}}',
    `data: {"type":"content_block_start","index":${TOOL_CALL_MAX_INDEX},"content_block":{"type":"tool_use","id":"toolu_X","name":"b","input":{}}}`,
    'data: {"type":"content_block_start","index":-1,"content_block":{"type":"tool_use","id":"toolu_Y","name":"c","input":{}}}',
    'data: {"type":"content_block_start","index":1.5,"content_block":{"type":"tool_use","id":"toolu_Z","name":"d","input":{}}}',
  ]).filter((ev): ev is Extract<StreamEvent, { type: 'tool_call' }> => ev.type === 'tool_call');

  t.deepEqual(smiecie.map(ev => ev.index), [0, 0, 0, 0], 'indeks poza zakresem / ujemny / ułamkowy adresuje blok zerowy, więc liczba slotów nigdy nie przekracza sufitu');
});
