/**
 * modules/models/contracts.ts — KONTRAKT PUBLICZNY klastra `models` (clean-room, faza F1).
 *
 * Ten plik wiąże WYŁĄCZNIE powierzchnię publiczną: to, czego dotykają konsumenci
 * (`modules/chat`, `modules/agent-loop`, `modules/tools`, `modules/sub-agents`,
 * `modules/memory`, `modules/web`, `src/main.ts`, `config/**`, harness z osobnego repo) oraz testy
 * klastra. Autorzy clean-room projektują wnętrza sami — kontrakt nie opisuje pól prywatnych,
 * kolejności instrukcji ani struktury plików.
 *
 * Odsyłacze `B.x XX-nn` w JSDoc wskazują wiersze katalogu zachowań
 * `Refaktor/Decyzje_Sesji/2026-09-05_clean_room_F1/behaviors_models.md`, a `CC §n` — pozycje
 * `behaviors_CROSSCHECK.md`. Każdy członek interfejsu ma tu przypisane co najmniej jedno
 * zachowanie; jeśli zachowania nie da się wyrazić przez ten kontrakt, jest to błąd kontraktu.
 *
 * ⚠️ Nazewnictwo: żadnej nazwy z upstreamu. Stare ↔ nowe mapowanie żyje w
 * `plan_models.md` §D (sweep konsumentów), nie tutaj.
 *
 * WERSJA PO CROSS-CHECKU (2026-09-05, `DECYZJE_F1.md`). Trzy zmiany wobec pierwszej
 * redakcji, wszystkie o WŁASNOŚĆ TYPÓW:
 *   1. Ten plik **nie deklaruje już atrap** `LoggerLike`/`NoticeLike`/`SettingsBagLike`
 *      ani `ChatSettingsSlice`/`SettingsRegistryLike` — importuje je z `core/index.js`.
 *   2. Ten plik **nie deklaruje transportu HTTP** — `HttpClient`, `StreamTransport`,
 *      `HttpRequestSpec`, `HttpResponse`, `StreamOpenResult`, `StreamSink`, ramki
 *      i `STREAM_TRANSPORT_TIMEOUT_MS` mieszkają w `core/http/contracts.ts`
 *      (dwa moduły potrzebują tego samego transportu, a moduły nie importują się
 *      nawzajem po bebechach).
 *   3. `NormalizedError` i stałe maskowania sekretów należą do `core/utils/errorUtils.ts`;
 *      tutaj tylko `import type`.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 0. Typy z `core` — jeden właściciel, tu tylko import + wewnątrzmodułowy re-eksport
// ═══════════════════════════════════════════════════════════════════════════════
//
// Re-eksport jest WYGODĄ WEWNĄTRZMODUŁOWĄ: pliki `providers/*.ts`, `ChatModel.ts`
// i `testing/harness.ts` biorą wszystko jednym `from '../contracts.js'`. Barrel
// `modules/models/index.ts` tych typów NIE wystawia — konsumenci spoza modułu biorą
// je z `core/index.js` (druga droga do tego samego typu = pierwszy krok do rozjazdu).

import type {
    LoggerLike,
    NoticeLike,
    NoticeOptions,
    NoticeHandle,
    SettingsBag,
    ChatSettingsSlice,
    SettingsRegistryLike,
    SettingsSubFieldDef,
    HttpClient,
    HttpRequestSpec,
    HttpResponse,
    StreamTransport,
    StreamOpenResult,
    StreamSink,
    FrameParser,
    StreamFrame,
    NormalizedError,
} from '../../core/index.js';
import type { ChatModel } from './ChatModel.js';
import type { GateTicket, GateOptions } from './requestGate.js';

export type {
    LoggerLike,
    NoticeLike,
    NoticeOptions,
    NoticeHandle,
    SettingsBag,
    ChatSettingsSlice,
    SettingsRegistryLike,
    SettingsSubFieldDef,
    HttpClient,
    HttpRequestSpec,
    HttpResponse,
    StreamTransport,
    StreamOpenResult,
    StreamSink,
    FrameParser,
    StreamFrame,
    NormalizedError,
    ChatModel,
    GateTicket,
    GateOptions,
};

/** Alias zgodności dla czytelników tego kontraktu; właścicielem typu jest `core`. */
export type SettingsBagLike = SettingsBag;

/**
 * Logger W ZAKRESIE TEGO KLASTRA: `core`-owy {@link LoggerLike} plus jedna metoda
 * własna — `log.model(...)` (B.1 MR-22: raportowana rola WOŁANA, nie udawana).
 * To jedyne uprawnione rozszerzenie typu z core: dokładamy metodę, nie zmieniamy
 * istniejących sygnatur.
 */
export interface ModelLoggerLike extends LoggerLike {
    model(role: string, providerId: string, modelId: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Identyfikatory dostawców
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dziewięć dostawców czatu. Kolejność w typie NIE ma znaczenia; kolejność wykrywania
 * platformy po kluczach API pinuje `PLATFORM_DETECTION_ORDER` (B.1 MR-14).
 *
 * Wartości `google`/`azure`/`custom` NIE należą do tego typu — leżą jeszcze w cudzych
 * `settings.json` i mają zachowywać się jak nieznane (B.1 MR-11, B.3 SM-02).
 */
export type ProviderId =
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'ollama'
    | 'deepseek'
    | 'groq'
    | 'lm_studio'
    | 'open_router'
    | 'xai';

/**
 * Jak `ChatModel` napędza strumień danego dostawcy.
 *
 * - `sse` — ramki `data: …` (OpenAI-kształtne, Anthropic, Gemini `alt=sse`).
 * - `ndjson` — jeden obiekt JSON na linię, bez prefiksu (Ollama, B.10 OL-01).
 * - `complete` — dostawca NIE MA użytecznego streamu w środowisku Obsidiana; `stream()`
 *   emuluje strumień jednym wywołaniem `complete()`. Tak wyrażamy obejście CORS xAI
 *   (B.10 XA-03): `app://obsidian.md` nie dostaje nagłówków CORS od api.x.ai, więc
 *   transport strumieniowy jest blokowany, a `complete()` idzie przez `HttpClient`
 *   (w Obsidianie `requestUrl`, poza CORS). Dawniej robiła to podklasa w `src/main.ts`;
 *   dziś to WŁAŚCIWOŚĆ dostawcy, nie podmiana klasy w composition root.
 */
export type StreamMode = 'sse' | 'ndjson' | 'complete';

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Kształt kanoniczny wiadomości (OpenAI chat) — to, co widzą WSZYSCY konsumenci
// ═══════════════════════════════════════════════════════════════════════════════

/** Blok treści multimodalnej w żądaniu/odpowiedzi (OpenAI: `text` / `image_url`). */
export interface OpenAiContentBlock {
    type?: string;
    text?: string;
    image_url?: { url?: string; detail?: string };
    [key: string]: unknown;
}

/** Treść wiadomości: goły tekst albo tablica bloków (B.6 BA-15, B.9 GG-07). */
export type OpenAiContent = string | OpenAiContentBlock[] | null;

/**
 * Wywołanie narzędzia w kształcie kanonicznym.
 * `arguments` to zawsze STRING (B.6 BA-13, B.9 GG-12) — nawet gdy dostawca oddał obiekt.
 * Wyjątek udokumentowany: Ollama przepuszcza obiekt (B.10 OL-05) i pętla to znosi.
 */
export interface OpenAiToolCall {
    id?: string;
    type?: 'function';
    function: { name?: string; arguments?: string | Record<string, unknown> };
}

/**
 * „Dowolny string, ale nie zjadaj literałów obok".
 *
 * `'a' | string` TypeScript zwija do gołego `string` — literały znikają z podpowiedzi
 * edytora, a lint zgłasza je jako nadmiarowe składniki unii. Przecięcie z pustym
 * rekordem jest dla kompilatora osobnym typem, więc unia zostaje otwarta (dostawcy
 * dorzucają własne role), a wypisane wartości dalej podpowiadają się w edytorze.
 * Zbiór akceptowanych wartości jest DOKŁADNIE taki sam jak dla `string`.
 */
type OtwartyString = string & Record<never, never>;

/** Rola wiadomości w kształcie kanonicznym; lista otwarta (patrz {@link OtwartyString}). */
export type OpenAiMessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'function' | OtwartyString;

/** Wiadomość WEJŚCIOWA (transkrypt, który konsument wysyła do modelu). */
export interface OpenAiRequestMessage {
    role: OpenAiMessageRole;
    content?: OpenAiContent;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAiToolCall[];
    /** DeepSeek Reasoner wymaga zwrotu myślenia w transkrypcie (B.8 DS-06). */
    reasoning_content?: string;
    [key: string]: unknown;
}

/** Wiadomość WYJŚCIOWA po tłumaczeniu na kształt kanoniczny. */
export interface OpenAiResponseTransformedMessage {
    role: 'assistant' | OtwartyString;
    content: OpenAiContent;
    tool_calls?: OpenAiToolCall[];
    /** Myślenie modelu wydzielone z treści (B.11 TT-01, B.9 GG-11, B.10 OR-01/TT-13). */
    reasoning_content?: string;
    [key: string]: unknown;
}

/** Jedna alternatywa odpowiedzi (plugin czyta wyłącznie `choices[0]`). */
export interface OpenAiCompletionChoice {
    index?: number;
    message: OpenAiResponseTransformedMessage;
    /** Słownik powodów zakończenia — B.9 GG-14 (mapowanie Gemini na kształt kanoniczny). */
    finish_reason?: string | null;
}

/**
 * Zużycie tokenów. Trzy różne nazwy tego samego pojęcia obok siebie, bo każdy dostawca
 * nazywa cache inaczej (B.12 CU-03/CU-04, B.7 AN-05/AN-09/AN-10).
 */
export interface UsageLike {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number } | null;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cached_tokens?: number;
    cache_creation_tokens?: number;
    [key: string]: unknown;
}

/**
 * Odpowiedź modelu w kształcie kanonicznym — to, co dostają `handlers.chunk`,
 * `handlers.done` i promisa `stream()`/`complete()`.
 *
 * Konsumenci czytają dokładnie: `choices[0].message.content` (B.4 LP-01,
 * `modules/memory/streamHelper.ts` `contentOf`), `.tool_calls` (`modules/agent-loop`
 * `parseToolCalls`), `.reasoning_content` (`chat_streaming.ts:637,685`) oraz `usage`
 * (B.4 LP-10).
 *
 * ⚠️ `usage` MUSI być obiektem BEZ pól, gdy dostawca nic nie przysłał (B.6 BA-08) —
 * pusty obiekt jest sygnałem „estymuj", `undefined` łamie `response.usage.prompt_tokens`
 * u konsumenta.
 */
export interface OpenAiCompletion {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices: OpenAiCompletionChoice[];
    usage: UsageLike;
    /** B.9 GG-17: payload z polem `error` oddaje błąd zamiast rzucać na `candidates[0]`. */
    error?: NormalizedError;
    [key: string]: unknown;
}

/** Definicja narzędzia w kształcie kanonicznym (OpenAI function calling). */
export interface ChatTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

/** Wymuszenie narzędzia. `none` u Gemini kasuje `tool_config`, reszta schodzi do AUTO (B.9 GG-08). */
export type ChatToolChoice =
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } };

/**
 * ŻĄDANIE — jedyny kształt, jaki konsument podaje modelowi.
 *
 * Składa je `modules/agent-loop` (B.4 LP-09): `{ messages, ...restPayload, max_tokens?,
 * thinking?, tools? }`. Pole `agentName` jest metadaną (klucz cache promptu u OpenAI/xAI —
 * B.10 OA-02/XA-02) i NIE jest polem API: dostawca ma je zużyć albo pominąć, nigdy wysłać.
 */
export interface ChatRequest {
    messages: OpenAiRequestMessage[];
    /** Nadpisanie modelu na to jedno żądanie (domyślnie `ProviderContext.modelId`). */
    model?: string;
    /** B.6 BA-03: brak → `ProviderContext.maxOutputTokens` (`resolveMaxOutputTokens`). */
    max_tokens?: number;
    /** B.14 SE-12: suwak 0–1, default 0.7. */
    temperature?: number;
    tools?: ChatTool[];
    tool_choice?: ChatToolChoice;
    /** `true` → domyślny budżet myślenia; liczba → budżet wprost (B.9 GG-09). */
    thinking?: boolean | number;
    /** Nazwa agenta — metadana cache promptu, NIE pole API (B.10 OA-02, XA-02). */
    agentName?: string;
    [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Błędy
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Znormalizowany błąd — jeden kształt dla wszystkich dziewięciu dostawców
 * (B.6 BA-22). `code` spada na `'UNKNOWN'`, `http_status` na `null`.
 *
 * ⚠️ **WŁAŚCICIEL: `core/utils/errorUtils.ts`** (decyzja A6, cross-check §2.5).
 * Ten klaster robi `import type { NormalizedError } from '../../core/index.js'`
 * i **nie deklaruje** ani typu, ani funkcji normalizującej, ani jej stałych:
 *   • `normalizeError(raw, httpStatus?)` — rename z wersji sprzed clean-room, plik `core`;
 *   • `MAX_ERROR_MESSAGE_LENGTH` (4000) i `SECRET_BEARING_FIELDS` — dziś PRYWATNE
 *     w `errorUtils.ts`, upublicznienie i rename należą do planu core §A.3
 *     (testy K20 tego klastra na nich stoją, więc muszą wyjść z barrela).
 * Kształt powtórzony niżej wyłącznie dla samowystarczalności składniowej tego pliku.
 *
 * ⚠️ B.4 LP-04: odrzucenie promisy `stream()` przy błędzie dostawcy jest GOŁYM OBIEKTEM
 * tego kształtu, nie instancją `Error` — `modules/agent-loop` na tym stoi.
 * ⚠️ B.5 ST-16/ST-19 (K20): `message` NIE MOŻE nieść klucza API ani słowa `bearer`,
 * nawet gdy strumień padł bez ciała odpowiedzi.
 */
// Kształt `NormalizedError` jest zaimportowany i re-eksportowany w sekcji 0 tego pliku.
// Właściciel typu ORAZ funkcji `normalizeError`: `core/utils/errorUtils.ts`.

/**
 * Odrzucenie po Stopie użytkownika / po budziku pętli.
 *
 * B.3 SM-07: `stopStream()` odrzuca promisę bieżącego streamu TYM błędem —
 * `_aborted === true` i NIEPUSTY `message` z i18n (`model.stream_aborted`).
 * B.4 LP-07: `modules/agent-loop` mapuje `_aborted === true` na `stoppedBy: 'abort'`.
 *
 * MUSI być instancją `Error` (testy AVA używają `t.throwsAsync(..., { message: /…/ })`,
 * które wymaga instancji `Error`).
 */
export interface StreamAbortError extends Error {
    _aborted: true;
}

/**
 * Odrzucenie biletu anulowanego W KOLEJCE bramki (B.3 SM-11).
 * `message` MUSI zawierać frazę „anulowany w kolejce" (pinowane testem), a `_aborted`
 * NIE jest ustawione — to inna ścieżka niż Stop biegnącego streamu.
 * `handlers.error` dostaje ten sam obiekt.
 */
export interface GateCancelledError extends Error {
    _queueCancelled: true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Transport HTTP — WŁAŚCICIEL: `core/http/contracts.ts`
// ═══════════════════════════════════════════════════════════════════════════════
//
// Decyzja A6: transport przenosi się do `core/http/`, bo tego samego klienta i tego
// samego czytnika strumienia potrzebują DWA moduły (`models`, `embedding`), a moduły
// nie mają prawa importować się nawzajem po bebechach. Ten klaster jest KONSUMENTEM:
//
//   import type { HttpClient, HttpRequestSpec, HttpResponse,
//                 StreamTransport, StreamOpenResult, StreamSink,
//                 FrameParser, StreamFrame } from '../../core/index.js';
//   import { STREAM_TRANSPORT_TIMEOUT_MS, SseFrames, NdjsonFrames } from '../../core/index.js';
//
// Co z tego wynika dla autora `models`:
//   • `ChatModelDeps.http` / `.transport` przyjmują instancje zbudowane w
//     `config/runtimeConfig.ts` (`new ObsidianHttpClient(requestUrl)`,
//     `new FetchStreamTransport()`), a w testach — atrapy o tym samym kształcie;
//   • polityka 429 (backoff, `Retry-After`, sufit prób, budzik po Stopie) NADAL
//     należy do `ChatModel` — transport tylko ujawnia `status` i `headers`;
//   • dekodowanie ramek na zdarzenia (`StreamDecoder`) zostaje TUTAJ — `core/http`
//     nie wie, co niesie ramka.
//
// Minimalne kształty poniżej — wyłącznie po to, żeby TEN plik kontraktu był
// samowystarczalny składniowo. W repo ich nie ma; jest import.
// ═══════════════════════════════════════════════════════════════════════════════

// Kształty transportu są zaimportowane i re-eksportowane w sekcji 0 tego pliku.
// Właściciel: `core/http/contracts.ts`. Ten klaster ich NIE redeklaruje.

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Zdarzenia strumienia i dekoder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Zdarzenie wypluwane przez `StreamDecoder`. To JEDYNY język, jakim dostawca mówi do
 * `ChatModel` w torze strumieniowym — akumulację snapshotu prowadzi `ChatModel`.
 */
export type StreamEvent =
    /** Widoczna treść (delta). B.11 TT-02: sklejone delty = dokładnie finalna treść. */
    | { type: 'text'; delta: string }
    /** Myślenie modelu (delta) — z tagów `<think>` albo natywnego pola dostawcy. */
    | { type: 'reasoning'; delta: string }
    /**
     * Fragment wywołania narzędzia. B.6 BA-09/BA-10: slot wybiera `index`, nie kolejność.
     * B.6 BA-11: brak `index` → slot 0. B.6 BA-12: `index < 0`, ułamkowy albo
     * `>= TOOL_CALL_MAX_INDEX` → slot 0, bez rzucania i bez pchania pustych slotów.
     */
    | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
    /** Zużycie tokenów (B.6 BA-07, B.7 AN-07, B.9 GG-21). Merge, nie nadpisanie. */
    | { type: 'usage'; usage: UsageLike }
    /** Sentinel platformy — koniec strumienia (B.5 ST-04/ST-05). */
    | { type: 'done'; finishReason?: string }
    /** Błąd zgłoszony W PAŚMIE przy HTTP 200 (B.5 ST-10). */
    | { type: 'error'; error: NormalizedError };

/**
 * Dekoder strumienia jednego dostawcy: ramki → zdarzenia kanoniczne.
 *
 * Kontrakt:
 * - `feed(chunk)` przyjmuje SUROWĄ porcję transportu (bufory ramek trzyma dekoder).
 * - Porcja niesparsowalna NIE rzuca i NIE kończy strumienia (B.5 ST-11, B.9 GG-23,
 *   B.10 OL-06) — dekoder wyrzuca śmiecia, ZLICZA go w {@link StreamDecoder.droppedFrames}
 *   i na tej podstawie `ChatModel` loguje `stream.chunk_parse_failed` z nazwą dostawcy
 *   i BEZ sekretu z porcji. Ramka POPRAWNA, która nie niosła żadnego zdarzenia, śmieciem
 *   nie jest i ostrzeżenia nie zostawia.
 * - `finish()` domyka rezerwę parsera myślenia (B.11 TT-04: ogon odpowiedzi nie może
 *   zginąć) i wykonuje rollback niedomkniętego `<think>` (B.11 TT-08/TT-09).
 * - Rozpoznanie końca to zdarzenie `done`, nie osobna metoda. Sentinel MUSI być
 *   rozpoznawany STRUKTURALNIE, nie po podciągu w tekście (B.8 DS-03/DS-04,
 *   B.9 GG-22/GG-24, B.10 OL-06/OL-07).
 *
 * Konsument: `ChatModel`; w testach klastra wołany wprost
 * (`decoder.feed(raw)` zamiast dawnego `adapter.handle_chunk(raw)`).
 */
export interface StreamDecoder {
    feed(chunk: string): StreamEvent[];
    finish(): StreamEvent[];
    /**
     * TT-16: seam OBSERWACYJNY dla testów dekoderów, które parsują tagi myślenia
     * (LM Studio, Groq, OpenRouter, Ollama). Dekoder bez parsera tagów go nie ma.
     * To jedyne pole tego interfejsu, którego `ChatModel` NIE czyta.
     */
    readonly reasoning?: { readonly active: boolean; readonly buffered: string };
    /**
     * ST-11: licznik ramek, których dekoder NIE umiał przeczytać i po cichu wyrzucił.
     * `ChatModel` porównuje go przed i po `feed()` — wzrost = jedyny powód, dla którego
     * wolno zapisać `stream.chunk_parse_failed`. Bez tego licznika ostrzeżenie leciało
     * z heurystyki „domknięta ramka bez zdarzeń" i fałszywie alarmowało 2× na turę
     * (kształt OpenAI: pierwsza ramka `delta:{role}` i przedostatnia `finish_reason`
     * są POPRAWNE, a zdarzeń nie niosą). Dekoder bez własnego kosza go nie ma.
     */
    readonly droppedFrames?: number;
}

// `ReasoningTagFilter` — klasa mieszka w `modules/models/ReasoningTagFilter.ts`
// (pełna specyfikacja zachowań: B.11 TT-01..TT-17). Kontrakt nie duplikuje jej kształtu,
// bo plik implementacji jest jej jedynym źródłem prawdy — patrz JSDoc tam.

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Dostawca (`ChatProvider`)
// ═══════════════════════════════════════════════════════════════════════════════

/** Jeden model na liście dostawcy (dropdown Ustawień). */
export interface ModelInfo {
    id: string;
    name?: string;
    /** B.13 VC-02: metadana rozstrzygająca, gdy nazwa jest nieoczywista. */
    multimodal?: boolean;
    max_output_tokens?: number;
    max_input_tokens?: number;
    [key: string]: unknown;
}

/**
 * Metryczka dostawcy — FAKTY KONTRAKTOWE (endpointy, nagłówki, tryb strumienia).
 * Testy pinują je wprost, a `config/runtimeConfig.ts` buduje z nich rejestr.
 */
export interface ChatProviderInfo {
    id: ProviderId;
    /** B.14 SE-11: nazwa w UI (Anthropic, OpenAI, OpenRouter, Ollama, Google Gemini, …). */
    label: string;
    /** B.1 MR-25: `true` tylko dla `ollama` i `lm_studio`. */
    local: boolean;
    /** B.1 MR-16: klucz wymagany zawsze POZA platformami lokalnymi. */
    needsApiKey: boolean;
    /** B.1 MR-10: wartość z `DEFAULT_MODELS`. */
    defaultModel: string;
    /** Adres bazowy (B.8 DS-01, B.10 LS-01, B.10 OL-01). */
    defaultEndpoint: string;
    /** B.10 OL-08 / B.5 ST-21: adres listy modeli (`/api/tags`, `/models`, …). */
    modelsEndpoint?: string;
    /** B.6 BA-02: `x-api-key` (Anthropic), `x-goog-api-key` (Gemini), inaczej Bearer. */
    apiKeyHeader?: string;
    /** Czy API dostawcy w ogóle streamuje. */
    streaming: boolean;
    /** Jak `ChatModel` napędza strumień — patrz `StreamMode`; xAI = `'complete'` (XA-03). */
    streamMode: StreamMode;
    supportsTools: boolean;
    /** `'per-model'` = rozstrzyga `isVisionModel` (B.13 VC-01..03). */
    supportsVision: boolean | 'per-model';
    supportsReasoning: boolean;
    /**
     * B.6 BA-04/BA-05: dokładać `stream_options: { include_usage: true }` do żądania
     * streamingowego. Włączone dla `openai` i `deepseek`, WYŁĄCZONE dla `groq`,
     * `open_router`, `lm_studio` (serwer walidujący nieznane pola odbija 400).
     */
    streamUsage: boolean;
}

/** Kontekst jednego modelu, jaki dostawca dostaje przy każdym wywołaniu. */
export interface ProviderContext {
    modelId: string;
    /** Brak dla platform lokalnych (B.1 MR-16). */
    apiKey?: string;
    /** Nadpisany adres (host Ollamy / LM Studio z ustawień; endpoint harnessu). */
    endpoint?: string;
    /** Metadana cache promptu (B.10 OA-02, XA-02) — nie pole API. */
    agentName?: string;
    /** B.12 CU-02: wynik `resolveMaxOutputTokens` dla tej pary platforma/model. */
    maxOutputTokens?: number;
    temperature?: number;
    /** B.10 OL-03: `pkmAssistant.ollama_keep_alive`, default `'60m'`. */
    keepAlive?: string;
    /** B.13 VC-02: metadane modeli z `listModels()` (rozstrzygają vision). */
    models?: ModelInfo[];
    /** Logger klastra (`core`-owy `LoggerLike` + `log.model(...)` z MR-22). */
    log: ModelLoggerLike;
}

/**
 * Dostawca — JEDNA klasa na platformę (zamiast trójki adapterów).
 * Jest BEZSTANOWY: cały stan tury żyje w dekoderze i w `ChatModel`.
 */
export interface ChatProvider {
    readonly info: ChatProviderInfo;

    /**
     * Lista modeli do dropdownu Ustawień.
     * B.5 ST-21: brak sieci → PUSTA lista, nigdy wyjątek.
     * B.7 AN-18: gałąź `catch` oddaje wynik wzbogacania metadanych, nie listę zaszytą w kodzie.
     * Kształt wywołania: `provider.listModels(ctx, http)`.
     */
    listModels(ctx: ProviderContext, http: HttpClient): Promise<ModelInfo[]>;

    /**
     * Żądanie → opis HTTP. `body` to STRING JSON (B.6 BA-01).
     *
     * Dokłada: `max_tokens`/odpowiednik (BA-03, AN-04, GG-10, OL-03), nagłówek klucza
     * (BA-02), `stream_options` gdy `info.streamUsage && stream` (BA-04/BA-05/BA-06),
     * `prompt_cache_key` (OA-02), `x-grok-conv-id` (XA-02), `cache_control` (AN-03),
     * `thinkingConfig` (GG-09), `keep_alive`/`options.num_predict` (OL-03).
     *
     * B.6 BA-15/BA-16: wiadomość user złożona z SAMEGO obrazu na modelu bez vision jest
     * podmieniana na tekst `t('model.image_stripped')` — nie blokuje wysyłki.
     *
     * Kształt wywołania w testach: `provider.buildRequest(req, ctx, true)` (trzeci argument
     * = tryb strumieniowy).
     */
    buildRequest(req: ChatRequest, ctx: ProviderContext, stream: boolean): HttpRequestSpec;

    /**
     * Ciało odpowiedzi (tor bez strumienia) → kształt kanoniczny.
     * B.9 GG-15/GG-16/GG-17/GG-25/GG-26 i B.7 AN-05 opisują przypadki brzegowe:
     * brak `usage` → trzy `null` u Gemini; kandydat bez treści → `{role:'assistant',content:''}`;
     * payload z polem `error` → `{ error }` zamiast wyjątku; pusta lista kandydatów
     * (prompt zablokowany) → pusta wiadomość, NIE wyjątek.
     */
    parseCompletion(body: unknown, req: ChatRequest, ctx: ProviderContext): OpenAiCompletion;

    /** Świeży dekoder na JEDNĄ turę streamu (stan tagów myślenia jest per tura). */
    createStreamDecoder(req: ChatRequest, ctx: ProviderContext): StreamDecoder;
}

/**
 * Rejestr dostawców — jawna rejestracja z `config/runtimeConfig.ts`.
 *
 * **`Record`, nie `Partial<Record<…>>`** (cross-check §2.2, decyzja A6): rejestr jest
 * KOMPLETNY z konstrukcji (dziewięć wpisów), a harness PODMIENIA wpisy, nigdy ich nie
 * usuwa. `Partial` dawałby wartości `ChatProvider | undefined`, których nie da się
 * przypisać do `RuntimeConfig.chat.providers` bez rzutowania.
 */
export type ChatProviderRegistry = Record<ProviderId, ChatProvider>;

// `CHAT_PROVIDERS` (komplet dziewięciu wpisów) — wartość mieszka w `modules/models/registry.ts`.
// B.3 SM-02: nieznana nazwa platformy (`azure`/`custom`/`google` ze starego `data.json`)
// NIE rzuca i NIE oddaje `undefined` — `resolveProvider` spada na PIERWSZY klucz rejestru.

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Bramka równoległości (logika własna, przeniesiona 1:1)
// ═══════════════════════════════════════════════════════════════════════════════

// Bramka równoległości to logika WŁASNA, przeniesiona 1:1 — `acquireSlot`, `gateSnapshot`
// i seam `__test__` mieszkają w `modules/models/requestGate.ts` (plik nie jest pochodny
// i nie przechodzi clean-roomu). Typy `GateTicket`/`GateOptions` są re-eksportowane
// w sekcji 0; kontrakt użycia (B.2 GT-01..GT-13) opisuje JSDoc w tamtym pliku.

/** Widok bramki, jakiego potrzebuje `ChatModel` (wstrzykiwany, żeby dało się go podmienić). */
export interface RequestGateLike {
    acquireSlot(key: string, limit: number, opts?: GateOptions): GateTicket;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Handlery strumienia — kontrakt widziany przez pętlę i czat
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handlery `stream()`. KSZTAŁT ZOSTAJE BEZ ZMIAN (spec §3.2) — wszystkie opcjonalne,
 * bo konsumenci podają podzbiory (`{}` w harnessie, `{ error }` w testach bramki).
 */
export interface StreamHandlers {
    /**
     * B.4 LP-02: chunk niesie CAŁOŚĆ dotychczasową (snapshot akumulowany), NIE deltę —
     * `modules/memory/streamHelper.ts` sam liczy różnicę z `choices[0].message.content`.
     * Wołany po każdej porcji transportu, która zmieniła snapshot.
     */
    chunk?: (response: OpenAiCompletion) => void;
    /**
     * Koniec tury. MUSI zostać AWAITOWANY zanim `stream()` rozstrzygnie swoją promisę —
     * harness owija ten handler podsłuchem `async` (`HarnessLocalAdapters.tapHandlers`).
     * B.5 ST-06: wołany także przy domknięciu transportu BEZ sentinela, o ile coś przyszło.
     */
    done?: (response: OpenAiCompletion) => void | Promise<void>;
    /**
     * B.4 LP-03: przy błędzie `stream()` robi DWIE rzeczy naraz — woła ten handler
     * ORAZ odrzuca zwróconą promisę TYM SAMYM obiektem. Konsument musi obserwować oba.
     * B.4 LP-04: obiekt jest `NormalizedError` (goły), poza abortem/anulowaniem
     * (`StreamAbortError` / `GateCancelledError`).
     */
    error?: (err: NormalizedError | StreamAbortError | GateCancelledError) => void;
    /**
     * B.4 LP-05: wołane, gdy żądanie WCHODZI NA SLOT bramki. Modele BEZ bramki (chmura)
     * wołają je NATYCHMIAST — pętla przezbraja tym budziki, więc czekanie w kolejce nie
     * zjada budżetu streamu. Nazwa pola zostaje `gate_admitted` (kontrakt konsumentów).
     */
    gate_admitted?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. `ChatModel` — obiekt, który trzymają konsumenci
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * Slice `settings.pkmAssistant.chat` (NOWE nazwy kluczy, spec §4) — typ
 * `ChatSettingsSlice` jest zaimportowany z `core/index.js` (sekcja 0 tego pliku).
 * Migrację ze starych kluczy prowadzi plik kwarantanny w `core/runtime/`.
 * Znaczenie pól w tym klastrze:
 *   • `platform` — wybrana platforma główna (Step 4/5 resolvera, B.1 MR-09/MR-14);
 *   • `apiKeys.<p>` — klucz API per platforma; `ollama`/`lm_studio` nie mają wpisu
 *     (B.1 MR-16, D.4); pełne ścieżki (`pkmAssistant.chat.apiKeys.<p>`) siedzą
 *     w `SECRET_FIELD_PATHS` sejfu;
 *   • `models.<p>` — wybór modelu per platforma (Step 4, B.1 MR-09);
 *   • `hosts.ollama` / `hosts.lm_studio` — adresy platform lokalnych (B.10 LS-01/LS-02, OL-01);
 *   • `temperature` — suwak 0–1, default 0.7 (B.14 SE-12);
 *   • `maxTokens` — globalny limit legacy, default 4096 (B.14 SE-13 / B.12 CU-02).
 */

/** Wpis w bibliotece modeli (Ustawienia → Modele). B.14 SE-07/SE-09. */
export interface ModelLibraryEntry {
    platform: string;
    model: string;
    isDefault?: boolean;
}

/**
 * Slice `settings.pkmAssistant` w zakresie, jaki czyta ten klaster.
 * ⚠️ Klucz slotu sub-agentów zostaje `minion` (B.1 MR-01, B.14 SE-04) — ZERO migracji danych.
 * ⚠️ `modelLibrary.master`, `masterPlatform`, `masterModel` mogą leżeć na dysku i MUSZĄ być
 * ignorowane bez błędu (B.1 MR-02/MR-03).
 */
export interface PkmModelSettings {
    chat?: ChatSettingsSlice;
    modelLibrary?: Record<string, ModelLibraryEntry[] | undefined>;
    /** Legacy slot sub-agentów (B.1 MR-09 Step 4). */
    minionModel?: string;
    minionPlatform?: string;
    /** B.12 CU-01/CU-02, B.14 SE-14: override limitu wyjścia per platforma. */
    maxTokens?: Partial<Record<string, number>>;
    /** B.10 OL-03, B.14 SE-15: default `'60m'`. */
    ollama_keep_alive?: string;
    /** B.12 CU-06: steruje liczeniem `buildCacheMetadata` per tura. */
    cacheTelemetryEnabled?: boolean;
    /** B.3 SM-04: pojemność bramki platform lokalnych (default 1, min 1, sufit 10). */
    limits?: { local_platform_max_concurrent?: number };
    [key: string]: unknown;
}

/**
 * Worek ustawień, jaki klaster dostaje z runtime'u.
 *
 * PRZECIĘCIE, nie `extends`: właścicielem `SettingsBag` (i całego `pkmAssistant`) jest
 * `core/runtime/contracts.ts`, a ten klaster tylko ZAWĘŻA odczyt do pól, które czyta
 * ({@link PkmModelSettings}). `extends` wymagałby, żeby zawężenie było nadtypem cudzego
 * kształtu — czyli żeby models dyktowało core'owi jego własny typ.
 */
export type ModelSettingsBag = SettingsBagLike & {
    pkmAssistant?: PkmModelSettings;
};

/** Zależności `ChatModel` — wszystko wstrzykiwane, zero globali. */
export interface ChatModelDeps {
    provider: ChatProvider;
    ctx: ProviderContext;
    http: HttpClient;
    transport: StreamTransport;
    /** B.3 SM-04/SM-05: bramka platform lokalnych. */
    gate: RequestGateLike;
    /** CC §5 X-2: opcjonalne; klaster nie ma obowiązku pokazywać notek. */
    notices?: NoticeLike;
    settings: ModelSettingsBag;
}

// `ChatModel` (klasa) i `createChatModel` (fabryka) mieszkają w `modules/models/ChatModel.ts`.
// Pełny kontrakt metod — trzy wyjścia streamu (B.5 ST-04..ST-07), polityka 429 (ST-12..ST-15),
// semantyka Stopu (B.3 SM-07..SM-15), `listModels` (ST-21/ST-22), `_gatePriority` (SM-05),
// `_streamGateLimit` (SM-06), `GATE_RELEASE_COOLDOWN_MS` (SM-12) i `scheduleGateRelease`
// (SM-13) — żyje w JSDoc tamtego pliku. Typ jest re-eksportowany w sekcji 0.

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Fabryka per rola (`modelResolver`) — logika własna, sygnatura ZOSTAJE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * B.1 MR-01/MR-20: `researcher` normalizuje się do slotu biblioteki `minion`;
 * `sub_worker` rozwiązuje się drabinką `main`, ale zawsze dostaje świeżą instancję.
 * `minion` zostaje jako legacy alias (MR-23 loguje deprecation).
 */
export type ModelRole = 'main' | 'researcher' | 'minion' | 'sub_worker';

/** Nadpisanie modelu per agent: `"platforma/model"` albo obiekt (B.1 MR-12/MR-13). */
export type ModelOverride = string | { platform?: string; model?: string };

/** Agent w zakresie, jaki czyta resolver (pełny typ żyje w `modules/agents`). */
export type ResolverAgentLike = {
    name?: string;
    model?: ModelOverride;
    models?: Record<string, ModelOverride | undefined>;
} | null | undefined;

/** Config sub-agenta/delegata — może nadpisać model (B.1 MR-05 Step 0 / MR-07 Step 2). */
export type DelegateConfigLike = { model?: string } | null | undefined;

/** Konfiguracja czatu w runtime (dostawcy + transport). Mapowanie starych ścieżek: plan §D. */
export interface ChatRuntimeConfig {
    providers: ChatProviderRegistry;
    http: HttpClient;
    transport: StreamTransport;
}

/** Runtime w zakresie, jaki czyta resolver (pełny typ żyje w `core/runtime`). */
export interface ResolverRuntimeLike {
    settings?: ModelSettingsBag;
    config?: { chat?: ChatRuntimeConfig };
    /**
     * WSPÓŁDZIELONY slot instancji modelu głównego (stara ścieżka: plan §D).
     * Konsumenci: `chat_model.ts` (podmiana), `chat_streaming.ts` (Stop),
     * `chat_tabs.ts` (ZEROWANIE przy demontażu zakładki — CC §6 Y-1),
     * `DelegateTool.ts` (fallback modelu).
     */
    chatModel?: ChatModel | null;
    notices?: NoticeLike;
}

/** Plugin w zakresie, jaki czyta resolver. */
export type ResolverPluginLike = { env?: ResolverRuntimeLike | null } | null | undefined;

// Fabryka per rola — `getModelsForRole`, `createModelForRole`, `clearModelCache`,
// `isLocalPlatform`, `DEFAULT_MODELS`, `PLATFORM_DETECTION_ORDER`, `LOCAL_PLATFORMS`
// — mieszka w `modules/models/modelResolver.ts` (logika WŁASNA, sygnatura ZOSTAJE
// 5-argumentowa, pinuje ją strażnik po źródle `chatModelSkipCache.test.ts`).
// Drabinka MR-04..MR-22 jest opisana w JSDoc tamtego pliku.

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Limity odpowiedzi i metadane cache promptu
// ═══════════════════════════════════════════════════════════════════════════════

// `MODEL_MAX_TOKENS_DEFAULTS`, `ResolveMaxOutputTokensArgs` i `resolveMaxOutputTokens`
// (B.12 CU-01/CU-02) mieszkają w `modules/models/cache_utils.ts` — plik przechodzi
// clean-room nietknięty poza jednym renamem ścieżki ustawień.

/** B.12 CU-05 — metadane cache promptu składane przez konsumentów promptu. */
export interface CacheMetadata {
    cached_tokens: number;
    cache_creation_tokens: number;
    total_input_tokens: number;
    savings_pct: number;
    /** Zawsze 0 — niezaimplementowane (CU-05). */
    savings_usd: number;
}

// `buildCacheMetadata` (B.12 CU-03/CU-04/CU-05) — `modules/models/cache_utils.ts`.

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Możliwości modelu
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * B.13 VC-04: konsument podaje CAŁĄ instancję modelu (`chat_model._isVisionModel`).
 * Kontrakt akceptuje też goły opis (nazwa + metadane), żeby dostawca mógł go użyć
 * przy decyzji o stripie obrazu (B.6 BA-15).
 */
export interface VisionModelLike {
    modelKey?: string;
    modelId?: string;
    /** Metadane z `listModels()` — rozstrzygają, gdy nazwa jest nieoczywista (VC-02). */
    models?: ModelInfo[];
}

// `isVisionModel` (B.13 VC-01..VC-03, B.6 BA-17: dokładne → rozmyte → regex)
// mieszka w `modules/models/capabilities.ts`.

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Status indeksu semantycznego — powierzchnia WEWNĄTRZMODUŁOWA
// ═══════════════════════════════════════════════════════════════════════════════
//
// `SemanticStatusData` (kształt PŁASKI), `SemanticStatusVariant`, `SemanticStatusResult`
// i `computeSemanticStatusText` (B.15 SS-01..SS-11) mieszkają w
// `modules/models/semanticStatusText.ts` — plik przechodzi clean-room NIETKNIĘTY, a 12 jego
// testów stoi dokładnie na tym kształcie. Barrel modułu tego nie wystawia; rozpakowanie
// `progress.indexed`/`progress.total` ze snapshotu indeksera robi WOŁACZ
// (`modules/models/SettingsContent.ts`).

// ═══════════════════════════════════════════════════════════════════════════════
// 14. Sekcja „Modele" w Ustawieniach
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * B.14 SE-01. Typ rejestru (`SettingsRegistryLike`) jest **importowany z `core/index.js`**
 * (decyzja A6) — rejestrują się w nim trzy klastry naraz, więc ma jednego właściciela.
 * Kształt, którego ten klaster faktycznie używa (cross-check §1.5):
 *
 *   registry.register({
 *       id: 'models', label: 'Modele', icon: '🤖', order: 20,
 *       render: (containerEl, plugin, options) =>
 *           renderModelsSection(containerEl, options.owner.buildSectionContext()),
 *   });
 *   registry.registerSubFields('api-keys', { id: 'models-api-keys', order: 20, render: () => {} });
 *
 * Renderer jest TRZYARGUMENTOWY, a `registerSubFields` jest częścią kontraktu —
 * pierwsza redakcja miała renderer dwuargumentowy i nie znała `registerSubFields`,
 * przez co żywy kod `SettingsSection.ts` nie dałby się wyrazić.
 */

// Typ rejestru (`SettingsRegistryLike`) jest importowany z `core/index.js` (sekcja 0):
// rejestrują się w nim trzy klastry naraz, więc ma jednego właściciela. Renderer jest
// TRZYARGUMENTOWY, a `registerSubFields` jest częścią kontraktu.
//
// `registerSettings(registry)` (B.14 SE-01) mieszka w `modules/models/SettingsSection.ts`.
// Sekcja „Modele” NIE MA już guzika migracji starego indeksu — decyzja Kuby (Q7):
// cały migrator danych v1.x jest skasowany, nie przemianowany.

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Stałe kontraktowe (pinowane testami)
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * `STREAM_TRANSPORT_TIMEOUT_MS` (600000) NIE MIESZKA już tutaj — należy do
 * `core/http/contracts.ts` razem z transportem, który go egzekwuje. Testy tego
 * klastra (pin „transport dostaje twardy timeout DOKŁADNIE 600000 ms") importują
 * go z `core/index.js`.
 */

/** B.5 ST-12 — sufit ponowień po 429 (próba + 3 ponowienia = 4 żądania). */
export const STREAM_MAX_RETRIES = 3;

/** B.5 ST-12 / luka L-01 — baza backoffu wykładniczego (×2 na próbę). */
export const STREAM_RETRY_BASE_DELAY_MS = 1500;

/** B.6 BA-12 — górna granica indeksu slotu `tool_calls` (poza zakresem → slot 0). */
export const TOOL_CALL_MAX_INDEX = 64;

/** B.5 ST-04 / B.6 BA-18 — sentinel kształtu OpenAI. Dopasowanie DOKŁADNE, nie podciąg. */
export const SSE_DONE_SENTINEL = 'data: [DONE]';

/** B.9 GG-09 — domyślny budżet myślenia Gemini przy `thinking: true`. */
export const GEMINI_DEFAULT_THINKING_BUDGET = 8192;

/** B.10 OL-03 / B.14 SE-15 — domyślne `keep_alive` Ollamy. */
export const OLLAMA_DEFAULT_KEEP_ALIVE = '60m';

// `PROVIDER_INFO` — FAKTY KONTRAKTOWE per dostawca (endpointy, nagłówki kluczy, tryb
// strumienia, flaga `stream_options`). Wartość mieszka w `modules/models/registry.ts`,
// a testy pinują ją wprost (`registry.test.ts`).

// ═══════════════════════════════════════════════════════════════════════════════
// 16. i18n — klucze należące do tego klastra
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * B.3 SM-07 — `model.stream_aborted`: „Strumień modelu przerwany (Stop)."
 * B.6 BA-15/BA-16 — `model.image_stripped`: „Obraz pominięty — model nie obsługuje vision."
 * Oba MUSZĄ respektować `settings.language` (test porównuje pl vs en).
 */
export type ModelI18nKey = 'model.stream_aborted' | 'model.image_stripped';
