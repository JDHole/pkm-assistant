import test from 'ava';
import { geminiProvider } from './gemini.js';
import { CapturingHttpClient, collect, makeCtx } from '../testing/harness.js';
import type { ChatRequest, OpenAiCompletion, ProviderContext } from '../contracts.js';

/**
 * Testy charakteryzujące dostawcę Gemini — nocna zmiana audytowa 2026-08-27, moduł 9.
 *
 * Kontekst: to JEDYNY dostawca w repo, który tłumaczy na kształt SPOZA rodziny OpenAI (role,
 * części treści, `functionCall`, `usageMetadata`, własny akumulator myślenia). Do audytu
 * 2026-08-27 nie importował go ANI JEDEN test — pozostali dostawcy mają ich od jednego do
 * trzech, a wspólna baza kształtu OpenAI dziesięć.
 *
 * Ten plik NICZEGO nie naprawia. Spisuje zachowanie tłumaczy w obie strony (żądanie → Gemini,
 * odpowiedź → kształt kanoniczny), żeby przyszła zmiana musiała się przyznać, co psuje.
 *
 * ⚠️ Dwa piny na końcu były do clean-room `test.failing` (zachowanie dziś wadliwe). W nowym
 * kodzie mają być spełnione OD PIERWSZEGO DNIA (B.9 GG-25/GG-26), więc są zwykłymi testami.
 *
 * Fabryka napraw F1 (AUD-testy-011/036, 2026-09-02): sekcje „Żądanie: forwardowanie
 * max_tokens" (AUD-testy-036), „Strumień" (AUD-testy-011 — do tego audytu NIC nie ćwiczyło
 * ścieżki streamingu tego dostawcy) i test strony `error`.
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
const CTX: ProviderContext = makeCtx({ modelId: 'gemini-2.5-pro', apiKey: 'test-key', maxOutputTokens: 4096 });

/** Odpowiedź non-streaming przetłumaczona na kształt kanoniczny. */
function respondTo(payload: unknown): OpenAiCompletion {
  return geminiProvider.parseCompletion(payload, REQ, CTX);
}

/** Body żądania rozpakowane z JSON-a, bo `buildRequest` oddaje je stringiem. */
function geminiBody(req: Record<string, unknown>) {
  const spec = geminiProvider.buildRequest({ model: 'gemini-2.5-pro', ...req } as ChatRequest, CTX, false);
  return JSON.parse(spec.body ?? '{}') as {
    contents: Array<{ role?: string; parts: Array<Record<string, unknown>> }>;
    generationConfig: Record<string, unknown>;
    tools?: Array<{ function_declarations: Array<Record<string, unknown>> }>;
    tool_config?: { function_calling_config: { mode: string } };
  };
}

/** Czy porcja niesie koniec strumienia (zdarzenie `done` dekodera). */
const endsStream = (chunk: string) =>
  geminiProvider.createStreamDecoder(REQ, CTX).feed(chunk).some(e => e.type === 'done');

/**
 * Karmi dekoder porcjami i akumuluje zdarzenia w snapshot — zamiennik dawnej pary
 * „przetwórz porcję" + „zamień stan adaptera na kształt kanoniczny".
 */
function streamSnapshot(chunks: string[]): OpenAiCompletion {
  return collect(geminiProvider.createStreamDecoder(REQ, CTX), chunks);
}

// ─────────────────────────────────────────────────────────────────────────────
// Żądanie: OpenAI -> Gemini
// ─────────────────────────────────────────────────────────────────────────────

test('gemini/request: role assistant staje się model, user zostaje, nieznana rola przechodzi bez zmian', t => {
  const body = geminiBody({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'function', content: 'c' },
      { role: 'tool', content: 'd' },
    ],
  });

  t.deepEqual(body.contents.map(c => c.role), ['user', 'model', 'model', 'tool']);
});

test('gemini/request: wiadomości system są zlepiane i wchodzą JAKO PIERWSZA tura user', t => {
  const body = geminiBody({
    messages: [
      { role: 'system', content: 'reguła 1' },
      { role: 'user', content: 'pytanie' },
      { role: 'system', content: 'reguła 2' },
    ],
  });

  // Gemini nie ma roli `system`, więc adapter robi z niej pierwszą turę użytkownika.
  t.is(body.contents.length, 2);
  t.is(body.contents[0].role, 'user');
  t.deepEqual(body.contents[0].parts, [{ text: 'reguła 1\nreguła 2' }]);
  // Kolejność źródłowa systemów zachowana, ogonowy `\n` przycięty.
  t.deepEqual(body.contents[1].parts, [{ text: 'pytanie' }]);
});

test('gemini/request: brak wiadomości system nie dokłada pustej tury', t => {
  const body = geminiBody({ messages: [{ role: 'user', content: 'samo pytanie' }] });

  t.is(body.contents.length, 1);
  t.is(body.contents[0].role, 'user');
});

test('gemini/request: image_url jpg jest przepisywany na image/jpeg, dane brane zza przecinka', t => {
  const body = geminiBody({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'opisz' },
        { type: 'image_url', image_url: { url: 'data:image/jpg;base64,QUJD' } },
      ],
    }],
  });

  t.deepEqual(body.contents[0].parts[0], { text: 'opisz' });
  // `image/jpg` -> `image/jpeg`: serwer Gemini odrzuca skróconą formę.
  t.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } });
});

test('gemini/request: tool_choice inne niż none daje tryb AUTO, none nie dokłada tool_config', t => {
  const tools = [{ type: 'function', function: { name: 'read', description: 'czyta', parameters: { type: 'object' } } }];

  const auto = geminiBody({ messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'required' });
  // Świadoma decyzja adaptera: ANY łamie zwykłe odpowiedzi, więc nawet `required` schodzi do AUTO.
  t.is(auto.tool_config?.function_calling_config.mode, 'AUTO');
  t.deepEqual(auto.tools?.[0].function_declarations[0], { name: 'read', description: 'czyta', parameters: { type: 'object' } });

  const none = geminiBody({ messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'none' });
  t.is(none.tool_config, undefined);
  t.truthy(none.tools, 'deklaracje narzędzi jadą nawet przy tool_choice=none');
});

test('gemini/request: thinking=true daje budżet 8192, liczba jedzie wprost, brak pola nie dokłada thinkingConfig', t => {
  t.deepEqual(
    geminiBody({ messages: [{ role: 'user', content: 'x' }], thinking: true }).generationConfig.thinkingConfig,
    { thinkingBudget: 8192 },
  );
  t.deepEqual(
    geminiBody({ messages: [{ role: 'user', content: 'x' }], thinking: 2048 }).generationConfig.thinkingConfig,
    { thinkingBudget: 2048 },
  );
  t.is(
    geminiBody({ messages: [{ role: 'user', content: 'x' }] }).generationConfig.thinkingConfig,
    undefined,
  );
});

test('AUD-testy-036: gemini/request: max_tokens jawnie podane trafia do generationConfig.maxOutputTokens', t => {
  const body = geminiBody({ messages: [{ role: 'user', content: 'x' }], max_tokens: 2048 });
  t.is(body.generationConfig.maxOutputTokens, 2048, 'buildRequest() ma forwardować max_tokens — mutacja usuwająca tę linię ma paść');
});

test('AUD-testy-036: gemini/request: max_tokens BEZ jawnej wartości spada na maxOutputTokens kontekstu', t => {
  const body = geminiBody({ messages: [{ role: 'user', content: 'x' }] });
  // `CTX.maxOutputTokens = 4096` (nagłówek tego pliku) — fallback `req.max_tokens
  // || ctx.maxOutputTokens`, druga strona TEJ SAMEJ decyzji.
  t.is(body.generationConfig.maxOutputTokens, 4096, 'brak jawnego max_tokens ma spaść na fallback kontekstu, nie zniknąć z body');
});

// ─────────────────────────────────────────────────────────────────────────────
// Odpowiedź: Gemini -> OpenAI
// ─────────────────────────────────────────────────────────────────────────────

test('gemini/response: części z thought:true idą do reasoning_content, nie do treści', t => {
  const out = respondTo({
    candidates: [{
      content: { role: 'model', parts: [
        { text: 'liczę w głowie', thought: true },
        { text: 'wynik to 42' },
      ] },
      finishReason: 'STOP',
    }],
  });

  const message = out.choices![0].message as { content: string; reasoning_content?: string };
  t.is(message.content, 'wynik to 42', 'myślenie NIE może wyciec do widocznej treści');
  t.is(message.reasoning_content, 'liczę w głowie');
});

test('gemini/response: functionCall staje się tool_calls z argumentami jako STRING', t => {
  const out = respondTo({
    candidates: [{
      content: { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'read', args: { path: 'a.md' } } }] },
      finishReason: 'STOP',
    }],
  });

  const calls = (out.choices![0].message as { tool_calls?: Array<Record<string, never>> }).tool_calls!;
  t.is(calls.length, 1);
  t.deepEqual(calls[0] as unknown, {
    id: 'call_1',
    type: 'function',
    function: { name: 'read', arguments: '{"path":"a.md"}' },
  });
});

test('gemini/response: functionCall bez id dostaje id wygenerowane lokalnie', t => {
  const out = respondTo({
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list' } }] }, finishReason: 'STOP' }],
  });

  const calls = (out.choices![0].message as { tool_calls?: Array<{ id: string }> }).tool_calls!;
  t.regex(calls[0].id, /^call_\d+_[a-z0-9]+$/, 'id musi powstać, bo pętla narzędzi paruje po nim wynik');
});

test('gemini/response: słownik powodów zakończenia', t => {
  const reason = (finishReason: string) =>
    respondTo({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason }] })
      .choices[0].finish_reason;

  t.is(reason('STOP'), 'stop');
  t.is(reason('MAX_TOKENS'), 'length');
  t.is(reason('SAFETY'), 'content_filter');
  t.is(reason('RECITATION'), 'content_filter');
  // Powód spoza słownika przechodzi zmałymi literami — kontrakt „nie gub informacji".
  t.is(reason('MALFORMED_FUNCTION_CALL'), 'malformed_function_call');
});

test('gemini/response: usageMetadata mapuje się na liczniki OpenAI, brak metadanych daje nulle', t => {
  const withUsage = respondTo({
    candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
  });
  t.deepEqual(withUsage.usage as unknown, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });

  const noUsage = respondTo({
    candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
  });
  t.deepEqual(noUsage.usage as unknown, { prompt_tokens: null, completion_tokens: null, total_tokens: null });
});

test('gemini/response: kandydat BEZ content oddaje pustą wiadomość asystenta (fix TS-3 #6)', t => {
  // Kandydat istnieje, ale nie ma treści — strażnik ma oddać obiekt wiadomości, nie pusty string.
  const out = respondTo({ candidates: [{ finishReason: 'SAFETY' }] });

  t.deepEqual(out.choices![0].message as unknown, { role: 'assistant', content: '' });
  t.is(out.choices![0].finish_reason, 'content_filter');
});

test('AUD-testy-011: gemini/response: payload z polem `error` oddaje znormalizowany błąd zamiast rzucać', t => {
  const out = respondTo({ error: { message: 'API key not valid.' } }) as unknown as {
    error?: { message: string; code: string; http_status: number | null };
  };

  t.truthy(out.error, 'gałąź błędu ma dojść jako {error:...}, nie wywalić się wyjątkiem na this._res.candidates[0]');
  t.is(out.error!.message, 'API key not valid.');
  t.is(out.error!.code, 'UNKNOWN', 'payload Gemini nie niesie kodu — normalizeError ma dać jawny fallback, nie undefined');
});

// ─────────────────────────────────────────────────────────────────────────────
// Strumień (AUD-testy-011) — do tego audytu ŻADEN test nie ćwiczył ścieżki streamingu tego
// dostawcy (jedyny w repo, który parsuje TABLICĘ JSON zamiast liniowych ramek SSE).
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-testy-011: gemini/stream: myślenie (thought:true) i tekst w OSOBNYCH porcjach akumulują się do reasoning_content i content', t => {
  const out = streamSnapshot([
    '[' + JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'liczę ', thought: true }] } }],
  }),
    ',' + JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'w głowie', thought: true }] } }],
  }),
    ',' + JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'wynik to 42' }] } }],
  }) + ']',
  ]);
  const message = out.choices![0].message as { content: string; reasoning_content?: string };
  t.is(message.content, 'wynik to 42', 'myślenie ze strumienia NIE może wyciec do widocznej treści');
  t.is(message.reasoning_content, 'liczę w głowie', 'dwie porcje myślenia sklejają się w jedną');
});

test('AUD-testy-011: gemini/stream: functionCall w dwóch kawałkach składa się w jedno wywołanie z pełnymi argumentami', t => {
  const out = streamSnapshot([
    '[' + JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'vault_read', args: { path: 'a' } } }] } }],
  }),
    ',' + JSON.stringify({
    candidates: [{ content: { parts: [{ functionCall: { name: '', args: { path: '.md' } } }] } }],
  }) + ']',
  ]);
  const calls = (out.choices![0].message as {
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  }).tool_calls!;
  t.is(calls.length, 1);
  t.is(calls[0].function.name, 'vault_read', 'imię narzędzia z pierwszego kawałka nie ginie, drugi kawałek ma pusty name');
  t.deepEqual(JSON.parse(calls[0].function.arguments) as unknown, { path: 'a.md' }, 'argument sklejony ze WSZYSTKICH kawałków, nie tylko z ostatniego');
  // Dekoder streamu nie niesie `functionCall.id` (Gemini go w strumieniu nie podaje) — dostaje
  // więc to samo lokalnie wygenerowane id co kształt non-streaming bez id (test wyżej).
  t.regex(calls[0].id, /^call_\d+_[a-z0-9]+$/);
});

test('AUD-testy-011: gemini/stream: usageMetadata z porcji trafia do usage w kształcie kanonicznym', t => {
  const out = streamSnapshot([
    '[' + JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
  }),
    ',' + JSON.stringify({
    candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
  }) + ']',
  ]);
  t.deepEqual(out.usage as unknown, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test('AUD-testy-011: gemini/koniec streamu: rozpoznaje porcję z "finishReason", ignoruje porcję bez', t => {
  const withReason = '{"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}]}';
  const withoutReason = '{"candidates":[{"content":{"parts":[{"text":"czesc"}]}}]}';

  t.true(endsStream(withReason));
  t.false(endsStream(withoutReason));
});

test('F2.14: gemini/koniec streamu: model wypowiadający frazę "finishReason" w treści NIE kończy strumienia przedwcześnie', t => {
  // Porcja NIEFINALNA: model tłumaczy działanie API, tekst zawiera literalnie 'finishReason'.
  // Stary substring-check (`event.data.includes('"finishReason"')`) łapał to jako koniec
  // strumienia po samej treści — dziś sprawdzenie idzie po WYPARSOWANYM polu na kandydacie,
  // które tu nie istnieje, więc porcja poprawnie NIE jest końcem.
  const talksAboutIt = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [
        { text: 'Pole "finishReason" mówi API, dlaczego generacja się zatrzymała.' },
      ] } }],
    });
  t.false(endsStream(talksAboutIt), 'sama treść wspominająca finishReason nie jest sygnałem końca');

  // Ta sama sytuacja, ale porcja JEST finalna (realny kandydat niesie finishReason) — nadal wykryte.
  const genuinelyFinal = JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'Pole "finishReason" mówi API...' }] },
        finishReason: 'STOP',
      }],
    });
  t.true(endsStream(genuinelyFinal));
});

test('F2.14: gemini/koniec streamu: porcja niesparsowalna (rozcięty JSON streamu tablicowego) nie rzuca i nie jest końcem', t => {
  // Realny kształt środkowej porcji strumienia Gemini: prefiks `,` + niedomknięty obiekt.
  const partial = ',{"candidates":[{"content":{"parts":[{"text":"urwa';
  t.notThrows(() => endsStream(partial));
  t.false(endsStream(partial));
});

// ─────────────────────────────────────────────────────────────────────────────
// W4-02 (review fali 2, 2026-09-04): rozpoznanie końca wymagało, żeby POJEDYNCZA porcja
// parsowała się jako JSON — porcja niosąca sentinel, ale sama zlepiona z drugim obiektem albo
// owinięta w prefiks `data:` (proxy udające SSE), traciła koniec strumienia. Dekoder i
// rozpoznanie końca jadą dziś TĄ SAMĄ ścieżką parsowania porcji, więc obie dostają ten sam
// werdykt.
// ─────────────────────────────────────────────────────────────────────────────

test('W4-02: gemini/koniec streamu: dwa obiekty zlepione w jednej porcji (dwie "linie" strumienia w jednym zdarzeniu) — bierze OSTATNI, niesie finishReason', t => {
  const glued = ',' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'kawałek 1' }] } }] })
      + ',' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'kawałek 2' }] }, finishReason: 'STOP' }] });
  t.true(endsStream(glued), 'ostatni obiekt zlepionej porcji niesie finishReason — koniec ma zostać wykryty');

  const gluedNoEnd = ',' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'kawałek 1' }] }, finishReason: 'STOP' }] })
      + ',' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'kawałek 2' }] } }] });
  t.false(endsStream(gluedNoEnd), 'finishReason siedzi w PIERWSZYM obiekcie, ostatni go nie niesie — porcja nie jest końcem');
});

test('W4-02: gemini/koniec streamu: prefiks `data:` (proxy udające SSE) nie przeszkadza w rozpoznaniu finishReason', t => {
  const withPrefix = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] });
  t.true(endsStream(withPrefix));

  const withPrefixNoEnd = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
  t.false(endsStream(withPrefixNoEnd));
});

// ─────────────────────────────────────────────────────────────────────────────
// PINY — nowy kod ma je spełniać OD PIERWSZEGO DNIA (B.9 GG-25/GG-26). Przed clean-room były
// to `test.failing`: zachowanie wywalało się wyjątkiem.
// ─────────────────────────────────────────────────────────────────────────────

test('PIN gemini/response: pusta lista kandydatów (prompt zablokowany) ma dać odpowiedź, nie wyjątek', t => {
  // Realny kształt od Gemini, gdy blokada leci na PROMPCIE, nie na odpowiedzi:
  // `candidates` przychodzi puste, a powód siedzi w `promptFeedback.blockReason`.
  // B.9 GG-25: pusta lista kandydatów MUSI dać pustą wiadomość asystenta, nie wyjątek.
  const out = respondTo({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } });

  t.truthy(out, 'parseCompletion() nie może rzucić na odpowiedzi, którą serwer realnie zwraca');
  t.deepEqual(out.choices![0].message as unknown, { role: 'assistant', content: '' });
});

test('PIN gemini/response: kandydat bez finishReason ma się przetłumaczyć, nie wywalić', t => {
  // B.9 GG-26: Gemini pomija `finishReason` w częściowych odpowiedziach — brak pola nie może
  // wywrócić tłumaczenia na kształt kanoniczny.
  const out = respondTo({
    candidates: [{ content: { role: 'model', parts: [{ text: 'urwane w pół' }] } }],
  });

  t.is((out.choices![0].message as { content: string }).content, 'urwane w pół');
});

// ─────────────────────────────────────────────────────────────────────────────
// F10 (bramka mutacyjna, 2026-09-06): mutanty, które przeżyły pakiet powyżej. Każdy test
// niżej pinuje JEDNO obserwowalne zachowanie, którego mutacja nie umie udawać.
// ─────────────────────────────────────────────────────────────────────────────

test('F10 gemini/request: argumenty wywołania z transkryptu — obiekt jedzie wprost, string JSON jest parsowany, śmieć i brak dają pusty obiekt', t => {
  const argsOf = (call: Record<string, unknown>) => {
    const body = geminiBody({
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: call }] },
      ],
    });
    return (body.contents[1].parts[0] as { functionCall: { name: string; args: unknown } }).functionCall;
  };

  // Gotowy OBIEKT z transkryptu przechodzi bez zmian — nie wolno go zgubić po drodze.
  t.deepEqual(argsOf({ name: 'read', arguments: { path: 'a.md', deep: true } }).args, { path: 'a.md', deep: true });
  // String JSON: parsowany do obiektu, bo Gemini wymaga `args` jako obiektu, nie stringa.
  t.deepEqual(argsOf({ name: 'read', arguments: '{"path":"b.md"}' }).args, { path: 'b.md' });
  // String niesparsowalny → pusty obiekt zamiast wyjątku.
  t.deepEqual(argsOf({ name: 'read', arguments: '{urwane' }).args, {});
  // Pusty string → pusty obiekt.
  t.deepEqual(argsOf({ name: 'read', arguments: '' }).args, {});
  // BRAK pola `arguments` → pusty obiekt; ta gałąź nie może próbować `.trim()` na `undefined`.
  t.deepEqual(argsOf({ name: 'read' }).args, {});
  // String JSON niosący wartość skalarną (nie obiekt) → też pusty obiekt.
  t.deepEqual(argsOf({ name: 'read', arguments: '42' }).args, {});
});

test('F10 gemini/request: wynik narzędzia staje się functionResponse TYLKO dla ról tool/function z nazwą', t => {
  const parts = (message: Record<string, unknown>) =>
    geminiBody({ messages: [{ role: 'user', content: 'x' }, message] }).contents[1].parts;

  // Rola `tool` z nazwą — wynik narzędzia w kształcie Gemini.
  t.deepEqual(parts({ role: 'tool', name: 'read', content: 'treść pliku' }), [
    { functionResponse: { name: 'read', response: { result: 'treść pliku' } } },
  ]);
  // Rola `function` z nazwą — ta sama ścieżka.
  t.deepEqual(parts({ role: 'function', name: 'list', content: 'a\nb' }), [
    { functionResponse: { name: 'list', response: { result: 'a\nb' } } },
  ]);
  // Rola `tool` BEZ nazwy — nie ma czym zaadresować wyniku, więc zwykły tekst.
  t.deepEqual(parts({ role: 'tool', content: 'bez nazwy' }), [{ text: 'bez nazwy' }]);
  // Rola `user` z nazwą (imię rozmówcy) — to NIE jest wynik narzędzia.
  t.deepEqual(parts({ role: 'user', name: 'kuba', content: 'cześć' }), [{ text: 'cześć' }]);
});

test('F10 gemini/request: blok treści bez tekstu i blok z pustym tekstem nie dokładają części', t => {
  const body = geminiBody({
    messages: [{
      role: 'user',
      content: [
        { type: 'text' },
        { type: 'text', text: '' },
        { type: 'text', text: 'widoczny' },
        { type: 'coś_nieznanego', payload: 7 },
      ],
    }],
  });

  // Do żądania idzie WYŁĄCZNIE część z realnym tekstem — ani `{text: undefined}`, ani `{text: ''}`.
  t.deepEqual(body.contents[0].parts, [{ text: 'widoczny' }]);
});

test('F10 gemini/request: adres bazowy z kontekstu wygrywa z publicznym API, endpoint z samych spacji spada na domyślny', t => {
  const custom = geminiProvider.buildRequest(
    REQ,
    makeCtx({ modelId: 'gemini-2.5-pro', endpoint: 'https://proxy.local/v1beta/' }),
    false,
  );
  // Nadpisanie z ustawień (proxy, harness) MUSI trafić do URL-a; ogonowe ukośniki przycięte.
  t.is(custom.url, 'https://proxy.local/v1beta/models/gemini-2.5-pro:generateContent');

  const blank = geminiProvider.buildRequest(REQ, makeCtx({ modelId: 'gemini-2.5-pro', endpoint: '   ' }), false);
  // Endpoint z samych białych znaków to „nic nie ustawiono", nie „adres bazowy równy spacjom".
  t.is(blank.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
});

test('F10 gemini/listModels: odpowiedź 200 mapuje katalog na ModelInfo (prefiks models/ ścięty, limity przepisane)', async t => {
  const http = new CapturingHttpClient({
    status: 200,
    body: {
      models: [{
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
      }],
    },
  });

  const models = await geminiProvider.listModels(makeCtx({ modelId: 'gemini-2.5-pro' }), http);

  t.deepEqual(models as unknown, [{
    id: 'gemini-2.5-pro',
    multimodal: true,
    name: 'Gemini 2.5 Pro',
    max_input_tokens: 1048576,
    max_output_tokens: 65536,
  }]);
  t.is(http.lastSpec?.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  t.is(http.lastSpec?.headers['x-goog-api-key'], 'test-key', 'klucz jedzie nagłówkiem, nigdy w URL-u');
});

test('F10 gemini/listModels: filtr metod — brak listy metod zostawia model, lista bez generateContent go wycina', async t => {
  const http = new CapturingHttpClient({
    status: 200,
    body: {
      models: [
        { name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        // Wpis BEZ pola `supportedGenerationMethods` — nie wiemy, czego nie umie, więc zostaje.
        { name: 'models/gemini-nieznany' },
        // Wpis bez nazwy jest nie do użycia — wypada niezależnie od metod.
        { supportedGenerationMethods: ['generateContent'] },
      ],
    },
  });

  const models = await geminiProvider.listModels(makeCtx(), http);

  t.deepEqual(models.map(m => m.id), ['gemini-flash', 'gemini-nieznany']);
  // Wpis bez limitów NIE dostaje pól limitów (ani `null`, ani zera) — konsument odróżnia „nie wiem".
  t.deepEqual(models[1] as unknown, { id: 'gemini-nieznany', multimodal: true });
});

test('F10 gemini/listModels: status spoza 2xx oddaje pustą listę, awaria transportu też — nigdy wyjątek ani undefined', async t => {
  const odbite = new CapturingHttpClient({ status: 403, body: { error: { message: 'API key not valid.' } } });
  t.deepEqual(await geminiProvider.listModels(makeCtx(), odbite), [], 'odrzucone żądanie katalogu = pusta lista');

  const padniete = new CapturingHttpClient().throwOn(new Error('network down'));
  const zCatcha = await geminiProvider.listModels(makeCtx(), padniete);
  t.deepEqual(zCatcha as unknown, [], 'gałąź catch ma oddać PUSTĄ TABLICĘ — dropdown Ustawień iteruje po wyniku');
  t.true(Array.isArray(zCatcha), 'undefined z catcha wywróciłoby rysowanie listy modeli');

  const smiec = new CapturingHttpClient({ status: 200, text: 'to nie jest JSON' });
  t.deepEqual(await geminiProvider.listModels(makeCtx(), smiec), []);
});
