/**
 * modules/models — publiczne API modułu modeli czatu.
 *
 * To są JEDYNE drzwi na zewnątrz modułu. Reszta pluginu importuje stąd, nie z bebechów.
 * Szczegóły: CLAUDE.md w tym folderze.
 *
 * ── CO SIĘ ZMIENIŁO W CLEAN-ROOM ────────────────────────────────────────────────
 * Barrel wystawia **rejestr dostawców** (`CHAT_PROVIDERS`, `PROVIDER_INFO`) zamiast
 * dziewięciu klas adapterów. Jedna klasa modelu (`ChatModel`) rozmawia z jednym,
 * BEZSTANOWYM dostawcą per platforma; wszystkie zależności są wstrzykiwane.
 * `config/runtimeConfig.ts` składa z tego `RuntimeConfig.chat`.
 *
 * ⚠️ **Barrel NIE re-eksportuje transportu.** `HttpClient`, `HttpRequestSpec`,
 * `HttpResponse`, `StreamTransport`, `ObsidianHttpClient`, `FetchHttpClient`,
 * `FetchStreamTransport`, `SseFrames`, `NdjsonFrames`, `STREAM_TRANSPORT_TIMEOUT_MS`
 * oraz `NormalizedError` i `ChatSettingsSlice` wychodzą z **`core/index.js`** —
 * konsumenci (`config/runtimeConfig.ts`, harness, testy) biorą je STAMTĄD. Re-eksport
 * przez ten barrel byłby drugą drogą do tego samego typu i pierwszym krokiem do rozjazdu.
 */

// ── Wartości ─────────────────────────────────────────────────────────────────

// Fabryka modelu per rola — pięciostopniowa drabinka (logika własna, sygnatura ZOSTAJE).
export {
  createModelForRole,
  getModelsForRole,
  isLocalPlatform,
  clearModelCache,
} from './modelResolver.js';

// Model czatu + jego fabryka z zależności.
export { createChatModel, ChatModel } from './ChatModel.js';

// Rejestr dostawców i ich metryczki (endpointy, nagłówki kluczy, tryb strumienia).
export { CHAT_PROVIDERS, PROVIDER_INFO } from './registry.js';

// Prompt caching v1 (S06) — metadane cache składane przez konsumentów promptu.
export { buildCacheMetadata } from './cache_utils.js';

// Czy model umie w obraz (decyzja 3-warstwowa: dokładne → rozmyte → regex).
export { isVisionModel } from './capabilities.js';

// Sekcja „Modele" w Ustawieniach.
export { registerSettings } from './SettingsSection.js';

/**
 * Seam TESTOWY fabryki instancji modelu.
 *
 * Wychodzi barrelem, bo testy konsumentów spoza modułu (`modules/tools/DelegateTool.test.ts`,
 * `WebReadTool.test.ts`) badają DRABINKĘ resolvera — którą platformę i który model dostał sub —
 * a nie zachowanie modelu; podstawiają więc własną atrapę zamiast budować prawdziwy `ChatModel`
 * z transportem. Deep-import do bebechów jest zakazany (ESLint `no-restricted-imports`), więc
 * jedyna legalna droga to te drzwi. W kodzie produkcyjnym NIKT tego nie woła.
 */
export { __test__ } from './modelResolver.js';

// ── Typy publiczne ───────────────────────────────────────────────────────────
// Kontrakt rozmowy z modelem: co wchodzi (`ChatRequest`), co wychodzi (`OpenAiCompletion`)
// i z czego składa się wiadomość. Na tych kształtach stoją czat, sub-agenci i pętla
// narzędziowa. Wszystko żyje w `contracts.ts` — jednym pliku kontraktu klastra.
export type {
  ChatRequest,
  ChatTool,
  ChatToolChoice,
  OpenAiCompletion,
  OpenAiCompletionChoice,
  OpenAiContent,
  OpenAiContentBlock,
  OpenAiRequestMessage,
  OpenAiResponseTransformedMessage,
  OpenAiToolCall,
  StreamHandlers,
  UsageLike,
  CacheMetadata,
  VisionModelLike,
  ProviderId,
  ChatProvider,
  ChatProviderInfo,
  ProviderContext,
  ModelInfo,
  ChatModelDeps,
  ChatRuntimeConfig,
  StreamEvent,
  StreamDecoder,
  StreamMode,
  StreamAbortError,
  GateCancelledError,
  ModelRole,
  ModelLibraryEntry,
  PkmModelSettings,
  DelegateConfigLike,
  ResolverAgentLike,
  ResolverPluginLike,
} from './contracts.js';
