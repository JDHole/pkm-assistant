# modules/embedding/

**Wektoryzacja tekstu + silnik retrievalu.** Po clean-room/F4 (2026-09-05): rejestr modeli
(`EmbeddingRegistry`) + jeden `EmbeddingModel` (retry/backoff/sufit czasu/przycinanie) +
cztery dostawce bezstanowe (`providers/openai.ts`, `ollama.ts`, `lm_studio.ts`, `gemini.ts`).
Silnik indeksu to **Orama** (BM25 + vector), bez zmian.

**Status:** 🚀 **ACTIVE**. `VaultIndexer` buduje indeks Oramy i publikuje `plugin.oramaDb`.

**Kontrakt klastra:** [`contracts.ts`](contracts.ts) — jedyne źródło prawdy o powierzchni
publicznej. Historia decyzji: `Refaktor/Decyzje_Sesji/2026-09-05_clean_room_F1_architektura.md`
+ `DECYZJE_F1.md` (cross-check architekta).

---

## Co tu jest

```
modules/embedding/
├── index.ts                    # Public API barrel
├── contracts.ts                # Kontrakt klastra — typy, stałe, kształty wywołań konsumentów
├── EmbeddingModel.ts            # Serce: retry 429 + backoff z sufitem, sufit czasu, przycinanie,
│                                #   kontrakt N wejść → N wyników albo rzut
├── EmbeddingModel.test.ts
├── EmbeddingRegistry.ts         # Rozstrzyganie `default` z ustawień usera, cache instancji,
│                                #   `select()`, `providers()` (dropdown Ustawień)
├── EmbeddingRegistry.test.ts
├── embedderFacade.ts            # Most rejestr → `EmbedderFacade` dla `VaultIndexer`
├── embedderFacade.test.ts
├── embedErrors.ts               # `EmbedBatchError` + `isEmbedBatchError` + `UnknownEmbeddingProviderError`
├── tokens.ts                    # estimateTokens (znaki/3,7) + trimToTokenBudget (wewnętrzne)
├── tokens.test.ts
├── providers/
│   ├── openai.ts                 # POST {base}/embeddings, Bearer, katalog limitów (3-small → 8191)
│   ├── ollama.ts                 # /api/embed + /api/tags (filtr embed|embedding|bge) + /api/show
│   ├── lm_studio.ts              # kształt OpenAI + natywny /api/v0/models (type==='embeddings')
│   ├── gemini.ts                 # :batchEmbedContents, x-goog-api-key, retryDelay z ciała 429
│   └── index.ts                  # instancje + EMBEDDING_PROVIDERS (mapa rejestru)
├── orama_engine.ts              # Orama wrapper (insert/remove/search/persist) — bez zmian
├── orama_engine.test.ts
├── VaultIndexer.ts               # E1.4 — żywy indeks semantyczny vaulta → plugin.oramaDb
├── VaultIndexer.test.ts
├── adaMigration.ts               # Meldunek migracji modelu ada-002 → 3-small — bez zmian
├── adaMigration.test.ts
└── CLAUDE.md                    # ten plik
```

**Migrator starego indeksu (v1.x → Orama) SKASOWANY W CAŁOŚCI** (decyzja Kuby 05.09) —
plik migratora i jego test nie istnieją. Jeśli w vaultcie zostały katalogi starego indeksu,
plugin ich nie widzi i nie rusza — user kasuje je ręcznie. Migrator USTAWIEŃ (przenoszący stary
worek ustawień embeddingu do `pkmAssistant.embedding`) mieszka osobno, w
`core/runtime/legacySettingsMigration.ts` — to nie jest ten sam mechanizm.

**Cztery klasy dawnych adapterów (`*_adapter.ts`, `embed_adapter_base.ts`, `model_base.ts`,
`EmbeddingModels.ts`, `standalone_base.ts`) SKASOWANE W CAŁOŚCI.** Zastąpione przez jeden
`EmbeddingModel` (polityka retry/backoff/timeout/przycinania, wspólna dla wszystkich
dostawców) + cztery BEZSTANOWE dostawce (budują żądanie, czytają odpowiedź — nic więcej).

---

## Public API (`index.ts`)

**Orama silnik:** `countDocs(db)`, `searchVectorTopK(db, vector, opts)`.

**VaultIndexer (E1.4 — żywa semantyka):** `VaultIndexer` — buduje indeks Oramy z plików `.md`
vaulta i publikuje `plugin.oramaDb`.

**Rejestr + model + dostawcy (clean-room / F4):**
- `EmbeddingRegistry` — `default` (getter CZYSTY, fail-closed gdy `provider` nie wybrany albo
  nieznany), `isConfigured()`, `select(providerId, modelId?)`, `providers()` (dropdown Ustawień).
- `EmbeddingModel` — `embed(texts)` (N→N albo rzut), `countTokens`, `listModels`.
- `EmbedBatchError`, `isEmbedBatchError`, `UnknownEmbeddingProviderError` — kontrakt błędu.
- `createEmbedderFacade(registry)` — buduje `EmbedderFacade` dla `VaultIndexer` (ta sama droga
  w produkcji i w harnessie — koniec dublowania ręcznej sklejki).
- `EMBEDDING_PROVIDERS`, `openAiEmbeddingProvider`, `ollamaEmbeddingProvider`,
  `lmStudioEmbeddingProvider`, `geminiEmbeddingProvider` — instancje dostawców.
- `EMBEDDING_PROVIDER_IDS`, `DEFAULT_EMBED_MODELS`, `DEFAULT_EMBEDDING_SETTINGS`,
  `DEFAULT_VECTOR_DIM` — stałe kontraktowe.

**Migracja modelu ada-002 → 3-small (AUD-bledy-040, bez zmian):**
- `announceAdaMigration(...)` — melduje przełączenie ZE STANU, woła ją `src/main.ts` przy starcie.

**NIE wychodzi z barrela:** typy HTTP (`HttpClient`, `HttpRequestSpec`, `HttpResponse`) —
konsumenci spoza modułu biorą je z `core/index.js`, żeby nie było dwóch dróg do jednego typu.
Typy wewnątrzmodułowe (`EmbeddingProvider`, kształty prywatne dostawców) też zostają w środku.

---

## Rejestr — jak działa `default` (§8 kontraktu)

`provider = settings.pkmAssistant.embedding.provider`. Pusty albo nieznany → **`default ===
null`**, zero sieci, zero wyjątku (fail-closed, decyzja Kuby Mapa-16 Q3). Dalej: `modelId =
models[p] ?? info.defaultModel`, `apiKey = apiKeys[p]`, `endpoint = hosts[p] ?? info.
defaultEndpoint`. Getter jest CZYSTY: nie mutuje ustawień, nie planuje zapisu, przy
niezmienionym wejściu oddaje TĘ SAMĄ instancję (cache unieważniany zmianą ustawień).

**Mechanizm efemerycznych modeli kolekcji (`<provider>#<Date.now()>`, `default_model_key`)
ZNIKNĄŁ W CAŁOŚCI.** Rejestr NIE ma stanu na dysku — nie ma czego leczyć ani co psuć przy
boocie. Klucz `embedding_models` w starych ustawieniach kasuje migrator ustawień.

---

## Model — kontrakt `embed()` (§6 kontraktu)

1. wejście puste/białe → `{vector:null}` na TEJ pozycji; same puste wejścia → ZERO żądań;
2. `needsApiKey && !apiKey` → rzut `{kind:'api', code:'api_key_missing'}` PRZED żądaniem
   (komunikat zawiera `API key not set`);
3. każde wejście przycięte do `safeMaxTokens` (`floor(maxInputTokens × 0.85)`);
4. DOKŁADNIE JEDNO żądanie HTTP na wywołanie (plus ponowienia 429) — `embed()` NIE dzieli
   wejść na porcje; porcjowanie robi wołacz (`VaultIndexer`);
5. 429 → ponowienie do 3 razy (4 żądania łącznie), potem rzut `{kind:'api', httpStatus:429}`;
   `backoffFactor` rośnie do sufitu `MAX_BACKOFF_FACTOR=6`, wraca do 1 po sukcesie;
6. status ≥ 400 inny niż 429 → rzut od razu, ZERO ponowień;
7. brak odpowiedzi w `timeoutMs` → rzut `{kind:'timeout'}`;
8. liczba wektorów ≠ liczba niepustych wejść → rzut `{kind:'shape'}` — **NIGDY krótsza tablica**
   (to był najdroższy bug w historii modułu, patrz gotcha niżej).

`dims` ŚWIADOMIE zostaje `DEFAULT_VECTOR_DIM=1024`, nie natywny wymiar dostawcy — podniesienie
go przy niezmienionym `modelKey` unieważniłoby indeksy userów bez rebuildu. Realny wymiar
i tak wygrywa — `VaultIndexer` bierze długość pierwszego wektora.

---

## Dostawcy (`providers/`)

Bezstanowi: budują żądanie (`buildEmbedRequest`), czytają odpowiedź (`parseEmbedResponse`),
czytają błąd (`parseEmbedError`). Cała polityka retry/timeout/przycinania żyje w
`EmbeddingModel` — do clean-room była rozsypana po trzech poziomach adapterów.

- **OpenAI** — `POST {base}/embeddings`, `Bearer`, katalog: `text-embedding-3-small` → 8191.
- **Ollama** — `/api/embed`, `listModels` przez `/api/tags` (filtr nazw `embed|embedding|bge`)
  + `context_length` z `/api/show`. Zimny start (ładowanie modelu z dysku) potrafi przekroczyć
  sufit czasu — normalne, `VaultIndexer` ponawia porcję.
- **LM Studio** — warstwa zgodna z OpenAI (`/v1/embeddings`) do embeddingu; `listModels` idzie
  przez NATYWNY `/api/v0/models` (`type === 'embeddings'`, `loaded_context_length`) — warstwa
  OpenAI nie mówi, który model jest embeddingowy. Brak `loaded_context_length` →
  `modelSpec()` `undefined` → limit 512 (świadomy, znany wyjątek).
- **Gemini** — `:batchEmbedContents`, nagłówek `x-goog-api-key` (NIGDY `?key=` w URL-u — K20,
  wyciekłby przez log adresu), `retryDelay` z `error.details[].retryDelay` w ciele 429.

Modele domyślne — JEDNO źródło (`DEFAULT_EMBED_MODELS`): OpenAI `text-embedding-3-small`,
Ollama `nomic-embed-text`, LM Studio `nomic-embed-text-v1.5`, Gemini `gemini-embedding-001`.

---

## VaultIndexer — żywy indeks semantyczny (E1.4, bez zmian architektonicznych)

Patrz nagłówek `VaultIndexer.ts` dla pełnego opisu statusów/skanu/hooków — kontrakt fasady
(`EmbedderFacade`) i pole `IndexerStatusSnapshot.modelKey` (rename z `model_key` — SNAPSHOT,
nie pole na dysku: sidecar `vault-index.meta.json` dalej pisze `model_key`, bo to dane usera).

---

## Zależności

**Importuje z:** `@orama/orama` (silnik), `core/index.js` (typy HTTP, `LoggerLike`,
`EmbeddingSettingsSlice` — `import type`, zero krawędzi modułowej `embedding → models`,
bo oba klastry biorą transport z tego samego fundamentu).

**Importowany przez:** `config/runtimeConfig.ts` (rejestracja providerów w
`RuntimeConfig.embedding`), `src/main.ts` (`VaultIndexer`, `countDocs`, `createEmbedderFacade`,
`announceAdaMigration`), `modules/memory/EmbeddingHelper.ts` (przez `EmbeddingModelLike`),
`modules/models/SettingsContent.ts` (`registry.providers()` do dropdownu), `core/selftest.ts`
(status diagnostyczny), harness 37/39.

---

## Gotchas

### 1. N wejść → N wyników albo RZUT — nigdy krótsza tablica

Krótsza zwrotka to najdroższy bug w historii modułu: indekser stemplował mtime plików bez
wektora, skan kończył się `ready` z zerem wektorów, resync po restarcie nie robił ANI JEDNEGO
żądania, a Ustawienia mówiły „Aktywne". Kontrakt `EmbeddingModel.embed()` to teraz jedyne
miejsce, gdzie ta reguła żyje — provider jej NIE waliduje (to robi model).

### 2. `kind:'shape'` NIE jest rozbijane na pojedyncze pliki

Dla porcji 16 plików krótka zwrotka jest oczywistą awarią, ale dla JEDNEGO wejścia długość 1
jest poprawna — rozbijanie wskrzesiłoby stempel mtime z gotchy 1. `VaultIndexer` polega na tej
klasyfikacji (`transport`/`timeout`/`api+429` → transient, ponów CAŁĄ porcję; `api` inny status
→ permanent, rozbij na pliki; `shape` → fatal, NIE rozbijaj).

### 3. Limity z katalogu, porcja od usera — kolejność jest CELOWO różna

`maxInputTokens`: katalog dostawcy **przed** ustawieniami (twardy limit modelu, `deps.
batchSize` by go nie osłabił). `batchSize`: ustawienia **przed** katalogiem (knob wydajnościowy
usera, wolno mu zejść niżej albo pójść wyżej niż sugeruje katalog).

### 4. `dims` zostaje 1024 — nie podnoś go do natywnego wymiaru providera

Patrz sekcja „Model" wyżej. `_tryRestore` w `VaultIndexer` odtwarza schemat z `meta.dims`;
zmiana wymiaru przy tym samym `modelKey` cichcem psuje odczyt starego indeksu.

### 5. Boot NIE pisze — getter `default` jest czysty

Dawny mechanizm (`<provider>#<Date.now()>` do `settings`) przepisywał userowi plik z kluczami
API przy KAŻDYM starcie. Dziś rejestr nie ma stanu na dysku — nie ma czego zapisać. Strażnik:
`EmbeddingRegistry.test.ts` (test „C-37") + scenariusz harnessu `39_boot_nie_pisze`.

### 6. Fail-closed bez auto-detect

Brak wybranego dostawcy = `null`, koniec. Zero czytania zmiennych środowiskowych, zero
„a może Ollama chodzi na localhoście" (decyzja Kuby Mapa-16 Q3).

### 7. Wykluczenia indeksu NIE rozróżniają wielkości liter (K15)

`VaultIndexer._isExcluded()` to bramka ZAKAZU, więc porównuje po `NFC` + `toLowerCase()` po
obu stronach (spójne z regułą globalną w `core/security/AccessGuard`). Indekser trzyma zero
zależności od `core/` — wszystko wstrzykiwane — więc normalizacja jest liczona LOKALNIE.

### 8. Klucz API nie ma prawa trafić do komunikatu błędu (K20)

`EmbedBatchError.message`/`.cause` nie niosą nagłówków ani wartości klucza. Gemini trzyma
klucz w nagłówku `x-goog-api-key`, nie w `?key=` — inaczej wyciekłby przez log URL-a.

---

## Testy

- `orama_engine.test.ts` — silnik Oramy, bez zmian (17 testów).
- `adaMigration.test.ts` — meldunek migracji modelu, bez zmian (5 testów).
- `VaultIndexer.test.ts` — skan/wykluczenia + K15, semantic smoke, restore, resync, hooki,
  kontrakt błędu (rename `httpStatus`/`modelKey`).
- `EmbeddingModel.test.ts` — kontrakt `embed()`: retry 429, backoff, sufit czasu, przycinanie,
  N→N, brak klucza, maskowanie sekretów.
- `EmbeddingRegistry.test.ts` — rozstrzyganie `default`, cache, `select()`, `providers()`,
  boot nie pisze.
- `embedderFacade.test.ts` — most rejestr → `EmbedderFacade`.
- `providers/{openai,ollama,lm_studio,gemini}.test.ts` — kształt żądania/odpowiedzi per
  dostawca, katalog limitów.
- `tokens.test.ts` — estymata tokenów + przycinanie.

---

## TODO

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md) (historia, sprzed clean-room).

**Świadomie odłożone (parking, F1 architektura):**
- `listModels()` w kontrakcie, pod testami, bez nowego UI (dropdown modeli embeddingu byłby
  nowym feature'em — zakazane do końca refaktoru).
- `pkmAssistant.embedding.timeoutMs`/`batchSize.<p>` bez kontrolki w Ustawieniach.

---

## Historia

- **Sesja 32-34** — embedding system complete (Ollama + snowflake).
- **Sesja 100** — external-deps DELETED (zależności wciągnięte do repo).
- **Sprint 02 Refaktor** (2026-04-27) — Orama, 4 providery, force pick provider, lokalny
  `standalone_base.js`, wywałka starego frameworka bazowego (~10 000 LOC).
- **E1.4** (2026-07-21) — `VaultIndexer` ożywia semantykę, publikuje `plugin.oramaDb`.
- **S31 Z4** (2026-07-30) — `src/embeddings/` wchłonięte fizycznie do modułu.
- **TS-2** (2026-07-31) — cały moduł w TypeScripcie.
- **clean-room / F1 (2026-09-05)** — TA PRZEBUDOWA. Cztery klasy adapterów + kolekcja
  `embedding_models` + migrator starego indeksu SKASOWANE w całości; zastąpione rejestrem +
  jednym modelem + czterema bezstanowymi dostawcami, kontraktem błędu `EmbedBatchError` i
  fasadą `createEmbedderFacade()` dzieloną przez produkcję i harness.
