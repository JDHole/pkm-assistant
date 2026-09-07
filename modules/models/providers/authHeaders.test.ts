/**
 * K20 (AUD-security-120/132) — nagłówek klucza API w żądaniu.
 *
 * Ten plik pilnuje POŁOWY kontraktu K20 należącej do dostawców: klucz FAKTYCZNIE idzie
 * w nagłówku (bez tego test wycieku niczego by nie sprawdzał) i idzie pod nazwą z metryczki.
 * Druga połowa — że pad transportu NIE wynosi tego klucza do konsumenta ani do logu — żyje
 * w `ChatModel.errors.test.ts` (strona modelu) i `core/http/streamTransport.test.ts`
 * (strona transportu).
 */
import test from 'ava';
import { openaiProvider } from './openai.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { PROVIDER_INFO } from '../registry.js';
import { makeCtx } from '../testing/harness.js';
import type { ChatRequest } from '../contracts.js';

const SECRET = 'TAJNY-TOKEN-XYZ-0123456789';
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'czesc' }], max_tokens: 128 };

test('K20: pad strumienia bez ciała — Authorization NIE wychodzi w błędzie dla konsumenta', t => {
  // Reprodukcja wycieku jest prawdziwa tylko wtedy, gdy klucz FAKTYCZNIE idzie w nagłówku.
  const spec = openaiProvider.buildRequest(REQ, makeCtx({ modelId: 'gpt-4o', apiKey: SECRET }), true);

  t.is(spec.headers['Authorization'], `Bearer ${SECRET}`, 'żądanie ma nieść klucz — inaczej test wycieku nic nie sprawdza');
  t.is(PROVIDER_INFO.openai.apiKeyHeader ?? 'Authorization', 'Authorization');
  t.false(String(spec.body ?? '').includes(SECRET), 'klucz nie może trafić do CIAŁA żądania');
});

test('K20: pad strumienia bez ciała — nagłówek niestandardowy (Anthropic `x-api-key`) też nie wychodzi', t => {
  // Azure (`api-key`) był tu drugim świadkiem dla nazwy nagłówka SPOZA `Authorization` — wycięty
  // 2026-09-03 (AUD-dead-code-026/110/168, decyzja Kuby). Anthropic pokrywa dokładnie tę samą
  // gałąź (metryczka z własną nazwą nagłówka), więc scenariusz zostaje pokryty jedynym
  // pozostałym dostawcą z niestandardową nazwą — plus Gemini jako trzeci świadek.
  const anthropic = anthropicProvider.buildRequest(REQ, makeCtx({ modelId: 'claude-sonnet-4-20250514', apiKey: SECRET }), true);
  t.is(anthropic.headers['x-api-key'], SECRET, 'Anthropic ma nieść klucz w nagłówku `x-api-key`');
  t.false('Authorization' in anthropic.headers, 'i NIE w Bearerze — inaczej klucz jechałby dwoma drogami');

  const gemini = geminiProvider.buildRequest(REQ, makeCtx({ modelId: 'gemini-2.5-pro', apiKey: SECRET }), true);
  t.is(gemini.headers['x-goog-api-key'], SECRET, 'Gemini ma nieść klucz w nagłówku `x-goog-api-key`');
  t.false(gemini.url.includes(SECRET), 'klucz NIE może wylądować w URL-u (trafiłby do logów proxy)');
});
