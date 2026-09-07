/**
 * modules/embedding/contracts.ts — KONTRAKT KLASTRA EMBEDDING (clean-room, faza F1 → F4).
 *
 * Ten plik wiąże WYŁĄCZNIE powierzchnię publiczną: to, czego dotykają konsumenci
 * (`modules/memory/EmbeddingHelper`, `modules/memory/RetrievalEngine`, `modules/models/SettingsContent`,
 * `src/main.ts`, `core/selftest.ts`, `modules/embedding/VaultIndexer`, harness 37/39) oraz testy.
 * Wnętrze (podział na pliki, klasy bazowe, prywatne pola) projektuje autor implementacji.
 *
 * Odsyłacze `B.x XX-nn` w JSDoc wskazują wiersze katalogu zachowań
 * `Refaktor/Decyzje_Sesji/2026-09-05_clean_room_F1/behaviors_embedding.md`, a `CC §n` — wiersze
 * `behaviors_CROSSCHECK.md`. Każdy członek interfejsu, na którym stoi konsument, ma tu podany
 * kształt wywołania po stronie konsumenta.
 *
 * ZASADY (spec §0):
 *  - kontrakt = to, czego używają konsumenci, nie to, co miał upstream;
 *  - transport wstrzykiwany (`HttpClient` z `core/http/`), zero globali, zero rejestru środowiska;
 *  - żadna ścieżka bootowa nie mutuje ustawień (B.7 SB-03/SB-11, harness 39);
 *  - N wejść → N wyników albo RZUT (B.5, twardy kontrakt `VaultIndexer`).
 *
 * WERSJA PO CROSS-CHECKU (2026-09-05, `DECYZJE_F1.md`). Zmiany wobec pierwszej redakcji:
 *   1. typy HTTP i logger **importowane z `core/index.js`**, nie deklarowane strukturalnie
 *      (transport przeniósł się do `core/http/` — decyzja A6; strukturalne bliźniaki dwóch
 *      klastrów miały tę samą nazwę i różną semantykę pola `timeoutMs`);
 *   2. `EmbeddingSettingsSlice` **importowany z `core/index.js`** (właściciel: `core/runtime/
 *      contracts.ts`, kształt nadrzędny z `hosts`/`batchSize`/`timeoutMs`);
 *   3. **migrator starego indeksu SKASOWANY W CAŁOŚCI** (decyzja Kuby: kasacja, nie rename) —
 *      z kontraktu znika sekcja wykrywania katalogów v1.x, backupu i czyszczenia.
 */

// ════════════════════════════════════════════════════════════════════════════
// 0. Import typów z `core` (właściciel: `core/http/contracts.ts` i `core/runtime/contracts.ts`)
// ════════════════════════════════════════════════════════════════════════════
//
// Composition root podaje TEN SAM obiekt klienta co klastrowi `models`
// (`RuntimeConfig.embedding.http`), więc `embedding` nie tworzy krawędzi modułowej
// `embedding → models` — obie strony biorą typ z fundamentu.
//
// ⚠️ `timeoutMs` ma JEDNĄ semantykę w całym repo: **TWARDY limit egzekwowany przez klienta**.
// To, że `EmbeddingModel` ściga dodatkowo własny zegar (B.5 EB-05/EB-06 — `requestUrl`
// nie przyjmuje sygnału, więc porzuconego żądania nie da się anulować), jest warstwą
// MODELU, a nie osłabieniem tego pola.
// ════════════════════════════════════════════════════════════════════════════

export type { HttpClient, HttpRequestSpec, HttpResponse } from '../../core/index.js';
export type { LoggerLike, EmbeddingSettingsSlice } from '../../core/index.js';

import type { HttpClient, HttpRequestSpec, HttpResponse, LoggerLike, EmbeddingSettingsSlice } from '../../core/index.js';

// ════════════════════════════════════════════════════════════════════════════
// 1. Stałe kontraktowe (pinowane testami — zmiana wartości = zmiana kontraktu)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Domyślny wymiar wektora, gdy ani ustawienia, ani realny wektor nic nie mówią.
 * ⚠️ ŚWIADOMIE NIE jest to natywny wymiar providera (OpenAI 1536/3072): podniesienie go
 * przy niezmienionym `modelKey` unieważniłoby istniejące indeksy userów bez rebuildu
 * (`_tryRestore` odtwarza schemat z `meta.dims`). Realny wymiar i tak wygrywa —
 * `VaultIndexer` bierze długość pierwszego wektora (B.1 VX-12).
 */
export const DEFAULT_VECTOR_DIM = 1024;

/** Sufit czasu jednego żądania embeddingu — obejmuje CAŁY łańcuch razem z ponowieniami 429 (B.5 EB-05/EB-06). */
export const DEFAULT_EMBED_TIMEOUT_MS = 60_000;
/** Widełki, w których test pinuje `DEFAULT_EMBED_TIMEOUT_MS` (B.5 EB-06: „dziesiątki sekund"). */
export const EMBED_TIMEOUT_MIN_MS = 10_000;
export const EMBED_TIMEOUT_MAX_MS = 180_000;

/** Ile RAZY ponawiamy żądanie po 429 (B.5 EB-02: łącznie 4 żądania = 1 + 3 ponowienia). */
export const EMBED_RETRY_ATTEMPTS = 3;
/** Baza backoffu ponowień 429 (ms). Rośnie wykładniczo i jest mnożona przez `backoffFactor`. */
export const EMBED_RETRY_BASE_MS = 1_000;
/** Bazowe odczekanie po WYCZERPANEJ rundzie 429 przed kolejnym wywołaniem (B.6 GM-02). */
export const EMBED_BACKOFF_WAIT_MS = 5_000;
/** Sufit mnożnika backoffu — bez niego jedna próba czekałaby >100 s (B.6 GM-02). */
export const MAX_BACKOFF_FACTOR = 6;

/** Margines na niedoszacowanie estymaty tokenów przy przycinaniu wejścia (B.5 EB-13, B.6 GM-04). */
export const EMBED_TRIM_SAFETY_FACTOR = 0.85;
/** Limit tokenów, gdy model jest spoza katalogu providera (B.5 EB-12: fail-safe fallback). */
export const DEFAULT_MAX_INPUT_TOKENS = 512;
/** Porcja doradcza, gdy katalog providera milczy (B.6 GM-04: „nie fallback 1" dotyczy Gemini, który MA wpis). */
export const DEFAULT_EMBED_BATCH_SIZE = 1;
/** Estymata tokenów: znaki / ta liczba (tiktoken wywalony w E1.7). */
export const TOKEN_CHARS_PER_TOKEN = 3.7;

/** Bazowe adresy dostawców. Provider dokleja ścieżkę; user może nadpisać bazę (`EmbeddingSettingsSlice.hosts`). */
export const OPENAI_EMBED_BASE_URL = 'https://api.openai.com/v1';
export const GEMINI_EMBED_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const OLLAMA_EMBED_BASE_URL = 'http://localhost:11434';
export const LM_STUDIO_EMBED_BASE_URL = 'http://localhost:1234/v1';

/**
 * Modele domyślne per dostawca — JEDNO źródło prawdy.
 * ⚠️ Do clean-room istniały DWA rozjechane komplety: katalog adaptera
 * (`snowflake-arctic-embed2`, `gemini-embedding-001`) i placeholder w Ustawieniach
 * (`nomic-embed-text`, `text-embedding-004`). Nowy `SettingsContent` czyta WYŁĄCZNIE
 * `EmbeddingProviderInfo.defaultModel` (B.12 SET-02).
 */
export const DEFAULT_EMBED_MODELS: Readonly<Record<EmbeddingProviderId, string>> = {
    openai: 'text-embedding-3-small',
    ollama: 'nomic-embed-text',
    lm_studio: 'nomic-embed-text-v1.5',
    gemini: 'gemini-embedding-001',
};

// ════════════════════════════════════════════════════════════════════════════
// 2. Tożsamość dostawcy
// ════════════════════════════════════════════════════════════════════════════

/**
 * Czterech dostawców embeddingów (spec §1.2). Wartość `''` w ustawieniach = „nie skonfigurowano"
 * (B.7 SB-12, B.12 SET-01) i NIE jest częścią tego typu.
 */
export type EmbeddingProviderId = 'openai' | 'ollama' | 'lm_studio' | 'gemini';

/** Kolejność 1:1 z dzisiejszym dropdownem Ustawień — `providers()` jej nie zmienia (B.12 SET-01). */
export const EMBEDDING_PROVIDER_IDS: readonly EmbeddingProviderId[] = ['openai', 'ollama', 'gemini', 'lm_studio'];

/**
 * Metryczka dostawcy — czyta ją UI (dropdown, placeholder modelu) i rejestr.
 * Konsument: `modules/models/SettingsContent.ts` (`registry.providers()` → opcje + placeholder),
 * `core/selftest.ts` (nazwa dostawcy w raporcie, B.14 DG-02).
 */
export interface EmbeddingProviderInfo {
    id: EmbeddingProviderId;
    /** Etykieta dla usera: 'OpenAI' | 'Ollama' | 'LM Studio' | 'Google Gemini' (B.12 SET-01). */
    label: string;
    /** `true` = działa bez sieci publicznej (Ollama, LM Studio) — wtedy `needsApiKey === false` (B.7 SB-07). */
    local: boolean;
    /**
     * `true` = brak klucza to twarda awaria PRZED żądaniem (B.5, harness 39: `error` bez ANI JEDNEGO
     * strzału w sieć). Dla dostawców lokalnych `false` — kończy relikt „api_key: 'na'" (B.7 SB-07).
     */
    needsApiKey: boolean;
    /** Model używany, gdy user nic nie wpisał (B.12 SET-02). Wartość z `DEFAULT_EMBED_MODELS`. */
    defaultModel: string;
    /** Baza adresu (bez ścieżki końcowej) — provider dokleja `/embeddings`, `/api/embed` itd. */
    defaultEndpoint: string;
    /** Czy dostawca umie wystawić listę modeli (`listModels`). Dla OpenAI/Gemini katalog jest statyczny. */
    listsModels: boolean;
}

/**
 * Wpis katalogu modeli dostawcy — twarde limity MODELU, nie preferencje usera.
 * `maxInputTokens` wygrywa nad ustawieniami (B.5 EB-10/EB-11); `batchSize` PRZEGRYWA
 * z wyborem usera (B.6 GM-05) — kolejność jest ODWROTNA i to jest celowe.
 */
export interface EmbeddingModelSpec {
    /** np. `text-embedding-3-small` → 8191 (B.5 EB-10), `gemini-embedding-001` → 2048 (B.6 GM-04). */
    maxInputTokens: number;
    /** np. Gemini → 50 (B.6 GM-04). Brak = `DEFAULT_EMBED_BATCH_SIZE`. */
    batchSize?: number;
    /** Natywny wymiar wektora — INFORMACYJNIE (UI, `listModels`). `EmbeddingModel.dims` go NIE czyta (patrz `DEFAULT_VECTOR_DIM`). */
    dims?: number;
}

/** Pozycja z `listModels()` — dziś bez konsumenta produkcyjnego, pinowana testami providerów (CC §2 E-1: barrel nie wystawia klas adapterów). */
export interface EmbeddingModelInfo {
    id: string;
    label?: string;
    maxInputTokens?: number;
    dims?: number;
}

/**
 * Kontekst jednego modelu, wyliczony przez rejestr z ustawień usera (B.7 SB-02, SB-08).
 * Provider dostaje go przy każdym wywołaniu — jest bezstanowy i współdzielony między modelami.
 */
export interface EmbeddingProviderContext {
    /** Klucz modelu wybrany przez usera albo `info.defaultModel` (B.12 SET-02). */
    modelId: string;
    /** Klucz API z `pkmAssistant.embedding.apiKeys.<provider>`; `undefined`/pusty dla dostawców lokalnych (B.7 SB-07/SB-08). */
    apiKey?: string;
    /** Baza adresu z `pkmAssistant.embedding.hosts.<provider>` albo `info.defaultEndpoint`. */
    endpoint: string;
    log: LoggerLike;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Kontrakt błędu (rdzeń całego klastra)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Klasy awarii embeddingu. `VaultIndexer.embedFailureKind()` czyta te wartości KACZO
 * (fasada embeddera jest wstrzykiwana), więc nazwy są kontraktem między modułami:
 *  - `transport` | `timeout` → awaria przejściowa: ponawiamy CAŁĄ porcję (B.1 VX-17, VX-22),
 *  - `api` + `httpStatus === 429` → też przejściowa,
 *  - `api` + inny status → trwała: porcja rozbijana na pojedyncze pliki (B.1 VX-19),
 *  - `shape` → fatalna: NIE rozbijamy (rozbicie wskrzesza AUD-090 z audytu wydajności).
 */
export type EmbedErrorKind = 'transport' | 'api' | 'timeout' | 'shape';

/** Domena błędu — do i18n/logów; `VaultIndexer` jej NIE czyta (klasyfikuje po `kind`). */
export type EmbedErrorCode =
    | 'api_key_missing'
    | 'rate_limited'
    | 'http_error'
    | 'no_response'
    | 'bad_shape'
    | 'timeout'
    | 'unknown';

/** Pola konstruktora `EmbedBatchError` (autor może dodać własne prywatne). */
export interface EmbedBatchErrorInit {
    kind: EmbedErrorKind;
    code: EmbedErrorCode;
    message: string;
    /** Status HTTP, gdy awaria pochodzi z odpowiedzi. `429` steruje klasyfikacją w `VaultIndexer`. */
    httpStatus?: number;
    providerId?: EmbeddingProviderId;
    modelId?: string;
    /** Ile żądań poszło w sumie (1 + ponowienia) — pinowane testami B.5 EB-01/EB-02/EB-04. */
    attempts?: number;
    cause?: unknown;
}

/**
 * Jedyny typ błędu, jakim `EmbeddingModel.embed()` wychodzi na zewnątrz (B.5 — cała sekcja).
 *
 * ⚠️ RENAME wobec stanu sprzed clean-room: pole `http_status` nazywa się `httpStatus`.
 * Konsument do przepięcia: `modules/embedding/VaultIndexer.ts::embedFailureKind`
 * (`o.http_status === 429` → `o.httpStatus === 429`) + jego test (rzut atrapy).
 */
export declare class EmbedBatchError extends Error {
    constructor(init: EmbedBatchErrorInit);
    readonly kind: EmbedErrorKind;
    readonly code: EmbedErrorCode;
    readonly httpStatus?: number;
    readonly providerId?: EmbeddingProviderId;
    readonly modelId?: string;
    readonly attempts: number;
    /** Oryginalny wyjątek/ciało odpowiedzi. Nie wolno tu wsadzać nagłówków ani klucza API (K20). */
    readonly cause?: unknown;
}

/**
 * Rozpoznanie błędu przez wołacza bez `instanceof` (granice modułów, harness, atrapy).
 * Konsument: testy klastra (`isEmbedBatchError(err) ? err.kind : null`).
 */
export declare function isEmbedBatchError(e: unknown): e is EmbedBatchError;

/** Rzut z `EmbeddingRegistry.select()` dla nieznanego id dostawcy. */
export declare class UnknownEmbeddingProviderError extends Error {
    constructor(providerId: string);
    readonly providerId: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Wynik embeddingu
// ════════════════════════════════════════════════════════════════════════════

/**
 * Jeden wynik, DOKŁADNIE na jedno wejście — indeks w tablicy wyniku odpowiada indeksowi wejścia.
 *
 * `vector === null` znaczy „wejście było puste/białe, nic nie embedowaliśmy" — NIE awaria
 * (B.5 EB-09, B.8 EH-04/EH-05/EH-07). Ta jedna decyzja zabija całą klasę błędów remapowania,
 * którą do clean-room ręcznie odtwarzał `EmbeddingHelper` (`validEntries[j].originalIndex`).
 *
 * ⚠️ RENAME: pole nazywało się `vec`. Konsumenci do przepięcia: `modules/memory/EmbeddingHelper.ts`
 * (+ test), harness 37 (atrapa adaptera).
 */
export interface EmbedResult {
    vector: number[] | null;
    /** Tokeny policzone przez API (`usage.total_tokens`), gdy dostawca je podaje. */
    tokens?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Dostawca (jedna klasa na dostawcę — spec §0 zasada 3)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Dostawca embeddingów: buduje żądanie i czyta odpowiedź. BEZSTANOWY względem retry/timeoutu —
 * całą politykę ponowień, sufit czasu i przycinanie prowadzi `EmbeddingModel`
 * (do clean-room ta logika była rozsypana po trzech poziomach adapterów).
 *
 * Instancje mieszkają w `providers/index.ts` (`openAiEmbeddingProvider`, `ollamaEmbeddingProvider`,
 * `lmStudioEmbeddingProvider`, `geminiEmbeddingProvider`); klasy — w `providers/`.
 */
export interface EmbeddingProvider {
    readonly info: EmbeddingProviderInfo;

    /**
     * Katalog TWARDYCH limitów modelu (B.5 EB-10, B.6 GM-04).
     * Nieznany `modelId` → `undefined`, a model spada na `DEFAULT_MAX_INPUT_TOKENS`
     * BEZ rzutu (B.5 EB-12 — fail-safe).
     */
    modelSpec(modelId: string): EmbeddingModelSpec | undefined;

    /**
     * Lista modeli dostawcy. Ollama: `GET {endpoint}/api/tags` + filtr nazw (`embed|embedding|bge`);
     * LM Studio: wpisy `type === 'embeddings'`; OpenAI/Gemini: katalog statyczny.
     * Dziś BEZ konsumenta produkcyjnego (UI ma pole tekstowe, nie dropdown) — pinowana testami providerów.
     */
    listModels(ctx: EmbeddingProviderContext, http: HttpClient): Promise<EmbeddingModelInfo[]>;

    /**
     * Buduje jedno żądanie embeddingu. Dostaje WYŁĄCZNIE wejścia niepuste i już przycięte
     * do `safeMaxTokens` (B.5 EB-09/EB-11/EB-13) — provider nie filtruje i nie tnie.
     * Nagłówek klucza dokłada provider (Bearer / `x-goog-api-key`); dla `local` dostawców brak.
     */
    buildEmbedRequest(texts: string[], ctx: EmbeddingProviderContext): HttpRequestSpec;

    /**
     * Czyta ciało odpowiedzi 2xx i oddaje wektory w KOLEJNOŚCI wejść.
     * Ciało nierozpoznane (brak spodziewanego pola) → RZUT `EmbedBatchError{kind:'shape'}` (B.5 EB-08).
     * Porównanie liczby wektorów z liczbą wejść robi MODEL, nie provider (B.5 EB-07).
     */
    parseEmbedResponse(body: unknown, texts: string[], ctx: EmbeddingProviderContext): number[][];

    /**
     * Czyta błąd z ciała/statusu odpowiedzi ≥ 400 (albo 200 z polem `error`, jak OpenAI
     * z kodem 429 w ciele — B.5 EB-02) i oddaje gotowy błąd.
     * `retryAfterMs` niesie `Retry-After` / `retryDelay` Google, gdy dostawca je podaje.
     */
    parseEmbedError(
        res: HttpResponse,
        ctx: EmbeddingProviderContext,
    ): { error: EmbedBatchErrorInit; retryAfterMs?: number };

    /** Estymata tokenów (znaki / `TOKEN_CHARS_PER_TOKEN`), nadpisywalna per dostawca. */
    countTokens(text: string): number;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Model embeddingu
// ════════════════════════════════════════════════════════════════════════════

/** Zależności modelu. Wszystko wstrzykiwane — zero globali, zero `env` (spec §0 zasada 5). */
export interface EmbeddingModelDeps {
    provider: EmbeddingProvider;
    ctx: EmbeddingProviderContext;
    http: HttpClient;
    /**
     * Sufit czasu żądania. `undefined`/`0`/śmieć → `DEFAULT_EMBED_TIMEOUT_MS`
     * (B.5 EB-06 — NIGDY „brak limitu").
     */
    timeoutMs?: number;
    /** Porcja doradcza usera. WYGRYWA z katalogiem dostawcy (B.6 GM-05). */
    batchSize?: number;
    /** Szew testowy: baza backoffu 429 (test schodzi na 1 ms). Domyślnie `EMBED_RETRY_BASE_MS`. */
    retryBaseMs?: number;
    /** Szew testowy: bazowe odczekanie po wyczerpanej rundzie 429. Domyślnie `EMBED_BACKOFF_WAIT_MS`. */
    backoffWaitMs?: number;
    /** Szew testowy zegara/uśpienia (testy nie mają czekać sekund). */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Model embeddingu — jedyne miejsce, gdzie żyje polityka ponowień, sufit czasu, przycinanie
 * i kontrakt „N wejść → N wyników albo rzut".
 *
 * KONTRAKT `embed()` (B.5, B.6, gotcha 8/9/11/12 modułu):
 *  1. wejścia puste/białe → wynik `{vector:null}` na TEJ pozycji; gdy WSZYSTKIE są puste,
 *     nie leci ANI JEDNO żądanie (B.5 EB-09);
 *  2. `needsApiKey && !apiKey` → rzut `{kind:'api', code:'api_key_missing'}` PRZED żądaniem
 *     (harness 39: boot kończy się `error` bez strzału w sieć);
 *  3. każde wejście przycięte do `safeMaxTokens` (B.5 EB-11/EB-13);
 *  4. DOKŁADNIE JEDNO żądanie HTTP na wywołanie (plus ponowienia 429) — `embed()` NIE dzieli
 *     wejść na porcje; porcjowanie należy do wołacza (`VaultIndexer`), a `batchSize` jest
 *     wskazówką (B.5 EB-01: 16 wejść = 1 żądanie);
 *  5. 429 (ze statusu albo z ciała) → ponowienie do `EMBED_RETRY_ATTEMPTS`; po wyczerpaniu rzut
 *     `{kind:'api', httpStatus:429}` (B.5 EB-02), a `backoffFactor` rośnie do `MAX_BACKOFF_FACTOR`
 *     (B.6 GM-02); 429, które ustąpi → PEŁNY wynik (B.5 EB-03) i `backoffFactor` wraca do 1 (B.6 GM-01);
 *  6. status ≥ 400 inny niż 429 → rzut od razu, ZERO ponowień (B.5 EB-04, B.6 GM-03);
 *  7. brak odpowiedzi w `timeoutMs` → rzut `{kind:'timeout'}` (B.5 EB-05); porzuconego żądania
 *     nie da się anulować (`requestUrl` nie przyjmuje sygnału) — uwalniamy tylko wołacza;
 *  8. liczba wektorów ≠ liczba NIEPUSTYCH wejść → rzut `{kind:'shape'}` z komunikatem
 *     zawierającym obie liczby w formacie `<got> vectors for <want> inputs` (B.5 EB-07).
 *
 * Konsumenci: `createEmbedderFacade()` → `VaultIndexer` (przez `embedBatch`),
 * `modules/memory/EmbeddingHelper` (`embed`/`embedBatch`).
 */
export declare class EmbeddingModel {
    constructor(deps: EmbeddingModelDeps);

    readonly providerId: EmbeddingProviderId;
    readonly modelId: string;
    /**
     * `'<provider>:<model>'` — zmiana któregokolwiek członu unieważnia indeks i wymusza pełny
     * rebuild (B.1 VX-07). Trafia do `EmbedderFacade.getModelKey()` i do sidecara
     * `vault-index.meta.json` (pole na dysku ZOSTAJE `model_key`).
     */
    readonly modelKey: string;

    /** `DEFAULT_VECTOR_DIM`, chyba że wstrzyknięto inaczej. Patrz komentarz przy stałej. */
    readonly dims: number;
    /** Porcja doradcza: `deps.batchSize` → katalog dostawcy → `DEFAULT_EMBED_BATCH_SIZE` (B.6 GM-04/GM-05). */
    readonly batchSize: number;
    /** Twardy limit modelu: katalog dostawcy → `DEFAULT_MAX_INPUT_TOKENS` (B.5 EB-10/EB-12). */
    readonly maxInputTokens: number;
    /** `Math.floor(maxInputTokens * EMBED_TRIM_SAFETY_FACTOR)` (B.5 EB-13, B.6 GM-04). */
    readonly safeMaxTokens: number;
    /** Rozstrzygnięty sufit czasu żądania (B.5 EB-06). */
    readonly timeoutMs: number;
    /** Mnożnik odczekania po 429: start 1, sufit `MAX_BACKOFF_FACTOR`, reset po sukcesie (B.6 GM-01/GM-02). */
    readonly backoffFactor: number;

    /** N wejść → N wyników (indeks w indeks) albo rzut `EmbedBatchError`. Patrz kontrakt wyżej. */
    embed(texts: string[]): Promise<EmbedResult[]>;

    /** Estymata tokenów pojedynczego tekstu (delegat do dostawcy). */
    countTokens(text: string): number;

    /** Delegat do `provider.listModels(ctx, http)`. */
    listModels(): Promise<EmbeddingModelInfo[]>;
}

/**
 * Minimalny kształt modelu widziany przez konsumentów spoza modułu
 * (`modules/memory/EmbeddingHelper`, atrapy w testach i w harnessie 37).
 * Konsument NIE ma prawa zależeć od niczego poza tymi trzema polami.
 */
export interface EmbeddingModelLike {
    readonly modelKey: string;
    readonly dims: number;
    embed(texts: string[]): Promise<EmbedResult[]>;
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Ustawienia (nowe klucze — spec §4)
// ════════════════════════════════════════════════════════════════════════════
//
// `EmbeddingSettingsSlice` jest importowany z `core/index.js` (sekcja 0 wyżej) — **WŁAŚCICIEL
// TYPU: `core/runtime/contracts.ts`** (decyzja A6). Tam wszystkie pola są opcjonalne i luźno
// typowane (`Record<string, string>`), bo `core` nie zna unii dostawców embeddingu. Ten klaster
// ZAWĘŻA przy odczycie — `EmbeddingRegistry` sprawdza, czy `provider` jest znanym id, i przy
// nieznanym oddaje `default === null` z ostrzeżeniem (B.7 SB-12) — ale typu NIE redeklaruje.
//
// Migrator kwarantannowy (`core/runtime/legacySettingsMigration.ts`) przepisuje tu stary worek;
// `EmbeddingRegistry` czyta WYŁĄCZNIE stąd i NIGDY nie pisze (B.7 SB-03/SB-09/SB-11, harness 39
// „boot nie pisze").
//
// Znaczenie pól w tym klastrze:
//   • `provider` — `''` albo brak = user nie wybrał → `default === null`, zero sieci;
//   • `models.<p>` — klucz modelu per dostawca; brak = `info.defaultModel` (B.12 SET-02);
//   • `apiKeys.<p>` — klucze API; te ścieżki wchodzą do `SECRET_FIELD_PATHS`
//     (`pkmAssistant.embedding.apiKeys.<p>`, spec §4);
//   • `hosts.<p>` — baza adresu dostawców lokalnych; brak = `info.defaultEndpoint`.
//     **Bez dziedziczenia z gałęzi czatu** (decyzja Q1: parytet, adres domyślny);
//   • `batchSize.<p>` — porcja doradcza usera, bez kontrolki w UI (B.6 GM-05);
//   • `timeoutMs` — sufit czasu żądania, bez kontrolki w UI (B.5 EB-06).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fabryczna zawartość wycinka — trafia do `config/defaultSettings.ts`.
 * ⚠️ Prowizjonowane są DOKŁADNIE te cztery klucze (`batchSize`/`timeoutMs` NIE) —
 * pusty kontener `apiKeys` jest warunkiem, żeby hydratacja sekretów przy boocie
 * niczego nie dotwarzała w obserwowanym worku i nie planowała zapisu (decyzja 10).
 */
export const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettingsSlice = {
    provider: '',
    models: {},
    apiKeys: {},
    hosts: {},
};

/**
 * Worek ustawień widziany przez rejestr (wąski wycinek `SettingsBag` z `core`).
 * Konsument: `EmbeddingRegistry`, `core/selftest.ts` (B.14 DG-02:
 * `settings.pkmAssistant?.embedding?.provider` zamiast dawnej ścieżki upstreamowej).
 */
export interface SettingsWithEmbedding {
    pkmAssistant?: { embedding?: EmbeddingSettingsSlice };
}

// ════════════════════════════════════════════════════════════════════════════
// 8. Rejestr
// ════════════════════════════════════════════════════════════════════════════

/** Zależności rejestru — podaje je composition root z `RuntimeConfig.embedding` (spec §2). */
export interface EmbeddingRegistryDeps {
    providers: Record<EmbeddingProviderId, EmbeddingProvider>;
    http: HttpClient;
    /**
     * Ustawienia CZYTANE LENIWIE (funkcja, nie migawka) — user zmienia dostawcę w Ustawieniach
     * i `default` ma to zobaczyć bez restartu (B.12 SET-01 woła `owner.display()` po zmianie).
     */
    settings: () => SettingsWithEmbedding | null | undefined;
    log: LoggerLike;
}

/**
 * Rejestr modeli embeddingu — następca kolekcji `embedding_models` i jej gettera `default`.
 *
 * ZNIKA cały mechanizm efemerycznych itemów kolekcji (`<provider>#<Date.now()>`,
 * `default_model_key` w ustawieniach, leczenie martwego klucza — B.7 SB-02/SB-03/SB-09/SB-10):
 * rejestr NIE ma stanu na dysku, więc nie ma czego leczyć ani co psuć przy boocie.
 * Klucz `embedding_models` w ustawieniach usera kasuje migrator (spec §4).
 *
 * Konsumenci: `src/main.ts` (fasada embeddera + status), `modules/models/SettingsContent.ts`
 * (`providers()` do dropdownu i placeholdera), `modules/memory/EmbeddingHelper` (przez `default`),
 * harness 37 (podmiana `default` na atrapę), harness 39 (`default` nie planuje zapisu).
 */
export declare class EmbeddingRegistry {
    constructor(deps: EmbeddingRegistryDeps);

    /**
     * Model wynikający z ustawień albo `null`, gdy dostawca nie jest wybrany
     * (`provider === ''`) lub nieznany. `null` = fail-closed: ZERO auto-detect z env vars,
     * zero sieci (B.7 SB-12, decyzja Kuby Mapa-16 Q3; `VaultIndexer` → status `no_provider`, B.1 VX-08).
     *
     * Getter jest CZYSTY: nie mutuje ustawień, nie planuje zapisu (B.7 SB-03/SB-11, harness 39)
     * i przy niezmienionych ustawieniach oddaje TĘ SAMĄ instancję (B.7 SB-04) — zmiana dostawcy,
     * modelu, klucza albo hosta w ustawieniach unieważnia cache.
     */
    readonly default: EmbeddingModel | null;

    /** `true` gdy `default !== null` — skrót dla `EmbeddingHelper.isReady()` (B.8 EH-02). */
    isConfigured(): boolean;

    /**
     * Model wskazany wprost (test połączenia, przyszłe UI). Brak `modelId` → `info.defaultModel`.
     * Nieznany dostawca → rzut `UnknownEmbeddingProviderError`.
     */
    select(providerId: EmbeddingProviderId, modelId?: string): EmbeddingModel;

    /** Metryczki wszystkich zarejestrowanych dostawców w kolejności `EMBEDDING_PROVIDER_IDS` (B.12 SET-01/SET-02). */
    providers(): EmbeddingProviderInfo[];
}

// ════════════════════════════════════════════════════════════════════════════
// 9. Most do VaultIndexera (plik zostaje — jego fasada musi pasować do nowego modelu)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fasada embeddera, którą `VaultIndexer` dostaje w konstruktorze. Kształt BEZ ZMIAN
 * (plik indeksera zostaje) — zmienia się tylko to, kto ją buduje.
 *
 * Konsument: `new VaultIndexer({ plugin, vault, embedder, isMobile, logger, noGoFolders, artifactsExclude })`
 * w `src/main.ts` i w harnessie 37.
 */
export interface EmbedderFacade {
    /** `registry.isConfigured()` — `false` → indekser kończy na `no_provider` (B.1 VX-08/VX-09). */
    isReady?(): boolean;
    /**
     * Zwraca tablicę DŁUGOŚCI wejścia: wektor albo `null` (pusta treść).
     * KAŻDA awaria leci RZUTEM `EmbedBatchError` — krótsza tablica jest zakazana
     * (B.1 VX-14: inaczej indekser stempluje mtime plików bez wektora).
     */
    embedBatch(texts: string[]): Promise<Array<number[] | null>>;
    embed?(text: string): Promise<number[] | null>;
    /** `registry.default?.modelKey ?? ''` — steruje unieważnieniem indeksu (B.1 VX-07). */
    getModelKey?(): string;
    /** `registry.default?.dims ?? null` — deklarowany wymiar; realny i tak wygrywa (B.1 VX-12). */
    getDims?(): number | null | undefined;
}

/**
 * Buduje `EmbedderFacade` nad rejestrem. Do clean-room ten kod był ręcznie sklejony
 * w `src/main.ts` i DRUGI RAZ w harnessie 37 — teraz jest jeden, testowalny.
 *
 * Konsument: `src/main.ts` (`embedder: createEmbedderFacade(runtime.embeddings)`),
 * harness 37 (ten sam wiersz nad rejestrem z podmienionym `default`).
 */
export declare function createEmbedderFacade(registry: EmbeddingRegistry): EmbedderFacade;

/**
 * Publiczny snapshot stanu indeksera (`VaultIndexer.getStatus()`).
 * ⚠️ RENAME: `model_key` → `modelKey` (pole SNAPSHOTU; pole w pliku `vault-index.meta.json`
 * na dysku ZOSTAJE `model_key` — to dane usera, spec §4).
 * Konsumenci: `modules/models/SettingsContent.ts` + `semanticStatusText.ts` (CC §2 E-6),
 * `modules/tools/semanticNote.ts` (B.9), `core/selftest.ts` (B.14 DG-01).
 */
export interface IndexerStatusSnapshot {
    status: 'idle' | 'disabled_mobile' | 'no_provider' | 'building' | 'ready' | 'error';
    progress: { indexed: number; total: number };
    modelKey: string | null;
    lastError: string | null;
}

// ════════════════════════════════════════════════════════════════════════════
// 10. Migracja starego indeksu — NIE ISTNIEJE (kasacja, decyzja Kuby 05.09)
// ════════════════════════════════════════════════════════════════════════════
//
// Cały podsystem migracji danych indeksu z wersji v1.x znika z repo, a nie zostaje
// przemianowany: plik migratora i jego test, wykrywanie katalogów starego indeksu, backup
// i czyszczenie, prefiks folderu backupu, komunikaty Notice, guzik w Ustawieniach + klucze
// i18n — wszystko KASACJA (R13). Powód (decyzja Kuby, spec §7): jedynym userem sprzed v2 jest
// on sam, a migrator wnosił do nowego kodu nazwy katalogów z rodowodu upstreamu.
//
// SKUTEK DLA USERA: jeśli w vaultcie zostały katalogi starego indeksu, zostają na dysku
// nietknięte i nieodczytane. Plugin ich nie widzi; user kasuje je ręcznie.
// ⚠️ Ta kasacja NIE dotyczy `adaMigration.ts` (podmiana modelu embeddingu — zostaje, sekcja 11
// niżej) ani migratora USTAWIEŃ w `core/runtime/legacySettingsMigration.ts`.

// ════════════════════════════════════════════════════════════════════════════
// 11. Meldunek migracji modelu (plik zostaje bez zmian — tu dla kompletności drzwi)
// ════════════════════════════════════════════════════════════════════════════

/** Porty `announceAdaMigration` (B.4 AM-01..AM-05). Kształt BEZ ZMIAN. */
export interface AdaMigrationPorts {
    /** Zapis ustawień. Brak funkcji → fail-closed, meldunek padu (B.4 AM-04). */
    save?: (() => Promise<void> | void) | null;
    notify: (message: string, durationMs: number) => void;
    onError?: (error: unknown) => void;
}

/** `true` tylko po POTWIERDZONYM zapisie (B.4 AM-01/AM-02/AM-03). Konsument: `src/main.ts` przy starcie. */
export declare function announceAdaMigration(ports: AdaMigrationPorts): Promise<boolean>;
