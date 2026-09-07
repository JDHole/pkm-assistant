import test from 'ava';
import { groqProvider } from './groq.js';
import { openRouterProvider } from './open_router.js';
import { PROVIDER_INFO } from '../registry.js';
import { collect, collectEvents, makeCtx } from '../testing/harness.js';
import type {
  ChatProvider,
  ChatRequest,
  OpenAiResponseTransformedMessage,
  ProviderContext,
  StreamDecoder,
  StreamEvent,
} from '../contracts.js';

/**
 * Wiadomość, w której treść jest ZAWSZE stringiem — dostawcy kształtu OpenAI nie oddają
 * bloków multimodalnych w odpowiedzi, a testy porównują treść znak w znak.
 */
type TextMessage = OpenAiResponseTransformedMessage & { content: string };


/**
 * Regression guards dla parsera `<think>` na POZOSTAŁYCH platformach o kształcie OpenAI
 * (Groq, OpenRouter).
 *
 * Kontekst: mechanika mieszka we wspólnym `ReasoningTagFilter`, tym samym co w LM Studio.
 * Wcześniej TYLKO LM Studio i Ollama parsowały tagi myślenia — na Groqu (hostuje
 * Qwen/DeepSeek-R1 distill) i na modelach lokalnych przepuszczanych przez OpenRoutera surowe
 * `<think>…</think>` jechało do widocznej treści odpowiedzi. (Trzeci dostawca tej rodziny,
 * Custom API w trybie „openai", skreślony 2026-09-03 razem z całym adapterem —
 * AUD-dead-code-026/110/168, decyzja Kuby.)
 *
 * Pełne pokrycie reguł parsera (rozcięte tagi, rollback, proza o znaczniku, przerwany stream)
 * siedzi w `lm_studio.test.ts` — ten plik pilnuje, że KAŻDY z pozostałych dwóch dostawców jest
 * do tej mechaniki podłączony i że natywne myślenie nadal ją wyłącza.
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };

/** Jeden chunk SSE w formacie OpenAI-compatible. */
const sse = (delta: Record<string, unknown>) => 'data: ' + JSON.stringify({ choices: [{ delta }] });

/** Widoczna treść wypuszczona przez dekoder (wołacz traktuje ją jak świeży tekst). */
const emitted = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.delta).join('');

/** Seam obserwacyjny parsera tagów myślenia (TT-16). */
const seam = (decoder: StreamDecoder) => decoder.reasoning!;

function ctxFor(provider: ChatProvider): ProviderContext {
  return makeCtx({ modelId: PROVIDER_INFO[provider.info.id].defaultModel });
}

/** Przepuszcza chunki przez dekoder dostawcy i zwraca finalną wiadomość + surowe zdarzenia. */
function stream(provider: ChatProvider, chunks: string[]) {
  const ctx = ctxFor(provider);
  const decoder = provider.createStreamDecoder(REQ, ctx);
  const events = collectEvents(decoder, chunks);
  const message = collect(provider.createStreamDecoder(REQ, ctx), chunks)
    .choices[0].message as TextMessage;
  return { message, events, decoder };
}

/** Odpowiedź non-streaming w kształcie OpenAI (tor `complete()`). */
function completed(provider: ChatProvider, content: string): TextMessage {
  return provider.parseCompletion(
    {
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'qwen3',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {},
    },
    REQ,
    ctxFor(provider),
  ).choices[0].message as TextMessage;
}

/**
 * Tablica dostawców zamiast tablicy klas adapterów — dziś jedna klasa per platforma,
 * a różnicę robi metryczka (`info`), nie hierarchia dziedziczenia.
 */
const PROVIDERS: Array<[string, ChatProvider]> = [
  ['groq', groqProvider],
  ['open_router', openRouterProvider],
];

for (const [name, provider] of PROVIDERS) {
  test(`${name} think parser: inline <think> na starcie idzie do myślenia, nie do treści`, t => {
    const THINK = 'Sprawdzam czego chce user, potem odpowiadam po polsku.';
    const ANSWER_1 = 'Jasne, robi się. ';
    const ANSWER_2 = 'Lecę po kolei.';

    const { message, events } = stream(provider, [
      sse({ content: '<think>' }),
      sse({ content: THINK }),
      sse({ content: '</think>' }),
      sse({ content: ANSWER_1 }),
      sse({ content: ANSWER_2 }),
      'data: [DONE]',
    ]);

    t.is(message.reasoning_content, THINK);
    t.is(message.content, ANSWER_1 + ANSWER_2);
    t.false(message.content.includes('think>'), 'żaden tag nie może zostać w treści');
    // Rezerwa (ostatnie ≤8 znaków na wypadek rozciętego tagu) musi dojechać przy domknięciu.
    t.true(message.content.endsWith('po kolei.'), 'ogon odpowiedzi musi dojechać');
    t.is(emitted(events), message.content, 'zdarzenia tekstowe = widoczna treść');
  });

  test(`${name} think parser: stream bez <think> przechodzi 1:1 razem z ogonem`, t => {
    const { message, events, decoder } = stream(provider, [
      sse({ content: 'Zwykła odpowiedź ' }),
      sse({ content: 'bez żadnego myślenia. ' }),
      sse({ content: 'Ogon!' }),
      'data: [DONE]',
    ]);

    t.is(message.content, 'Zwykła odpowiedź bez żadnego myślenia. Ogon!');
    t.is(message.reasoning_content, undefined, 'brak myślenia = brak pola reasoning_content');
    t.falsy(seam(decoder).active);
    t.is(emitted(events), message.content);
  });

  test(`${name} think parser: niedomknięty <think> wraca w całości do treści`, t => {
    // Objaw z produkcji: model ucięty na max_tokens → user widzi zwinięte myślenie i ZERO odpowiedzi.
    const CUT = 'Zaczynam od backlogu. Pierwszy punkt to naprawa parsera, drugi to testy, trzeci';

    const { message } = stream(provider, [
      sse({ content: '<think>' }),
      sse({ content: CUT }),
      'data: [DONE]',
    ]);

    t.is(message.content, CUT, 'tag się nie domknął → to nie było myślenie, tylko odpowiedź');
    t.is(message.reasoning_content, undefined, 'pusty string nie może wrócić do modelu w kolejnej turze');
  });

  test(`${name} think parser: non-streaming rozdziela myślenie od odpowiedzi`, t => {
    // Bez tego surowy `<think>` jechał gołym tekstem m.in. do wyników sub-agentów.
    const msg = completed(provider, '<think>rozumowanie modelu</think>Właściwa odpowiedź.');

    t.is(msg.reasoning_content, 'rozumowanie modelu');
    t.is(msg.content, 'Właściwa odpowiedź.');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter: natywne myślenie (`delta.reasoning`) MUSI wyłączać parser tagów
// ─────────────────────────────────────────────────────────────────────────────
test('open_router: natywne delta.reasoning wyłącza parser tagów inline (guard)', t => {
  const PROSE = 'Usuń <think> z promptu, bo psuje parser.';

  const { message, decoder } = stream(openRouterProvider, [
    sse({ reasoning: 'Myślę o tym zadaniu' }),
    sse({ reasoning: ' i już kończę.' }),
    sse({ content: PROSE }),
    'data: [DONE]',
  ]);

  t.is(message.reasoning_content, 'Myślę o tym zadaniu i już kończę.', 'natywne myślenie zebrane');
  t.is(message.content, PROSE, 'treść leci 1:1 — myślenie przyszło osobnym polem');
  t.falsy(seam(decoder).active, 'parser tagów nie może się uzbroić przy natywnym myśleniu');
});
