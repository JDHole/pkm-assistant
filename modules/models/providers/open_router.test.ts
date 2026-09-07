import test from 'ava';
import { openRouterProvider } from './open_router.js';
import { PROVIDER_INFO } from '../registry.js';
import { CapturingHttpClient, collect, makeCtx } from '../testing/harness.js';
import type { ChatRequest, ProviderContext } from '../contracts.js';

/**
 * N19 (luka L-07/L-08): metryczka OpenRoutera to fakt kontraktowy — endpoint i nagłówek
 * klucza; natywne `delta.reasoning` mapuje się na `reasoning_content` (B.10 OR-01).
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
const CTX: ProviderContext = makeCtx({ modelId: 'anthropic/claude-sonnet-4-20250514', apiKey: 'or-test' });

const sse = (delta: Record<string, unknown>) => 'data: ' + JSON.stringify({ choices: [{ delta }] });

test('L-07/L-08: open_router — endpoint, nagłówki dostawcy, delta.reasoning → reasoning_content', t => {
  const spec = openRouterProvider.buildRequest(REQ, CTX, false);

  t.is(spec.url, PROVIDER_INFO.open_router.defaultEndpoint);
  t.is(spec.method, 'POST');
  t.is(spec.headers['Authorization'], 'Bearer or-test', 'OpenRouter jedzie na standardowym Bearerze');
  t.is(
    PROVIDER_INFO.open_router.apiKeyHeader ?? 'Authorization',
    'Authorization',
    'metryczka i żądanie muszą mówić o tym samym nagłówku',
  );

  const snapshot = collect(openRouterProvider.createStreamDecoder(REQ, CTX), [
    sse({ reasoning: 'krótkie rozumowanie' }),
    sse({ content: 'odpowiedź' }),
    'data: [DONE]',
  ]);
  t.is(snapshot.choices[0].message.reasoning_content, 'krótkie rozumowanie');
  t.is(snapshot.choices[0].message.content, 'odpowiedź');
});

// ── F10: `decorateBody` / `reasoningOption` — prośba o rozumowanie ──────────────────────

test('decorateBody: brak `thinking` -> ciało BEZ pola `reasoning` (nie samo `null`)', t => {
  const spec = openRouterProvider.buildRequest(REQ, CTX, false);
  const body = JSON.parse(spec.body as string) as Record<string, unknown>;

  t.false(Object.prototype.hasOwnProperty.call(body, 'reasoning'),
    'zero prośby o rozumowanie = zero dodatkowego pola, nie klucz z wartością null/undefined');
});

test('decorateBody: `thinking` liczbowe dodatnie -> `reasoning.max_tokens`', t => {
  const spec = openRouterProvider.buildRequest({ ...REQ, thinking: 5 }, CTX, false);
  const body = JSON.parse(spec.body as string) as Record<string, unknown>;

  t.deepEqual(body.reasoning, { max_tokens: 5 });
});

test('decorateBody: `thinking === 0` NIE jest budżetem (próg jest `> 0`, nie `>= 0`)', t => {
  const spec = openRouterProvider.buildRequest({ ...REQ, thinking: 0 }, CTX, false);
  const body = JSON.parse(spec.body as string) as Record<string, unknown>;

  t.false(Object.prototype.hasOwnProperty.call(body, 'reasoning'), 'zero tokenów budżetu = brak prośby, nie {max_tokens:0}');
});

test('decorateBody: `thinking` niedomknięte do liczby (`NaN`) nie wpada w gałąź liczbową', t => {
  const spec = openRouterProvider.buildRequest({ ...REQ, thinking: NaN }, CTX, false);
  const body = JSON.parse(spec.body as string) as Record<string, unknown>;

  t.false(Object.prototype.hasOwnProperty.call(body, 'reasoning'),
    '`typeof NaN === "number"` jest prawdą — TYLKO `Number.isFinite` odsiewa ten przypadek');
});

test('decorateBody: `thinking === true` -> `reasoning.enabled`', t => {
  const spec = openRouterProvider.buildRequest({ ...REQ, thinking: true }, CTX, false);
  const body = JSON.parse(spec.body as string) as Record<string, unknown>;

  t.deepEqual(body.reasoning, { enabled: true });
});

test('decorateBody: `thinking === false` -> BRAK pola `reasoning` (nie `{enabled:true}`)', t => {
  const spec = openRouterProvider.buildRequest({ ...REQ, thinking: false }, CTX, false);
  const body = JSON.parse(spec.body as string) as Record<string, unknown>;

  t.false(Object.prototype.hasOwnProperty.call(body, 'reasoning'));
});

// ── F10: `parseModelList` / `acceptsImages` — flaga multimodalności z katalogu ──────────

test('katalog modeli: `multimodal` już będące boolean zostaje NIETKNIĘTE, architektura go nie nadpisuje', async t => {
  const http = new CapturingHttpClient({
    status: 200,
    body: {
      data: [
        { id: 'kept-true', multimodal: true, architecture: { modality: 'text->text' } },
        { id: 'kept-false', multimodal: false, architecture: { input_modalities: ['text', 'image'] } },
      ],
    },
  });

  const models = await openRouterProvider.listModels(CTX, http);

  t.is(models.find(m => m.id === 'kept-true')?.multimodal, true,
    'flaga jawna wygrywa mimo architektury, która policzyłaby co innego');
  t.is(models.find(m => m.id === 'kept-false')?.multimodal, false,
    'flaga jawna `false` też nie jest przeliczana na podstawie architektury');
});

test('katalog modeli: wpis bez architektury i bez `multimodal` wychodzi BEZ zmian (klucz nieustawiony)', async t => {
  const http = new CapturingHttpClient({ status: 200, body: { data: [{ id: 'plain', name: 'Plain Model' }] } });

  const models = await openRouterProvider.listModels(CTX, http);
  const entry = models[0];

  t.is(entry.id, 'plain');
  t.false(Object.prototype.hasOwnProperty.call(entry, 'multimodal'),
    'nieznane = nic nie dopisujemy, nie klucz z wartością undefined');
});

test('katalog modeli: `architecture.input_modalities` decyduje o fladze wg obecności "image"', async t => {
  const http = new CapturingHttpClient({
    status: 200,
    body: {
      data: [
        { id: 'with-image', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'without-image', architecture: { input_modalities: ['text', 'audio'] } },
      ],
    },
  });

  const models = await openRouterProvider.listModels(CTX, http);

  t.is(models.find(m => m.id === 'with-image')?.multimodal, true);
  t.is(models.find(m => m.id === 'without-image')?.multimodal, false,
    'lista rodzajów wejścia BEZ "image" musi dać `false`, nie `true`');
});

test('katalog modeli: `architecture === null` nie wywraca całej listy, wpis wychodzi bez flagi', async t => {
  const http = new CapturingHttpClient({ status: 200, body: { data: [{ id: 'null-arch', architecture: null }] } });

  const models = await openRouterProvider.listModels(CTX, http);

  t.is(models.length, 1,
    'architektura `null` nie może wywalić wyjątku, który `listModels` łapie jako PUSTĄ listę');
  t.is(models[0].id, 'null-arch');
  t.false(Object.prototype.hasOwnProperty.call(models[0], 'multimodal'));
});

// F10: mutant L108 `(inputSide ?? '') -> (inputSide || '')` jest RÓWNOWAŻNY, nie do zabicia —
// `inputSide` pochodzi z `modality.split('->')[0]`, `split` zawsze oddaje NAPIS (nigdy
// `null`/`undefined`), więc `??` nigdy się nie uruchamia; jedyny falsy przypadek to `''`,
// a fallback obu operatorów jest TĄ SAMĄ pustą wartością — żaden wejściowy napis nie odróżni
// jednego od drugiego.

test('katalog modeli: `architecture.modality` (napis) czyta stronę WEJŚCIOWĄ przed strzałką', async t => {
  const http = new CapturingHttpClient({
    status: 200,
    body: {
      data: [
        { id: 'text-only', architecture: { modality: 'text->text' } },
        { id: 'text-image', architecture: { modality: 'text+image->text' } },
      ],
    },
  });

  const models = await openRouterProvider.listModels(CTX, http);

  t.is(models.find(m => m.id === 'text-only')?.multimodal, false, 'sam tekst po obu stronach — brak obrazu');
  t.is(models.find(m => m.id === 'text-image')?.multimodal, true, 'strona wejściowa zawiera "image"');
});
