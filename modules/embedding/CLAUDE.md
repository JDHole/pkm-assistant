# modules/embedding/

**Wektoryzacja tekstu + silnik retrievalu.** Rejestr modeli (`EmbeddingRegistry`) + jeden `EmbeddingModel` (retry/backoff/sufit czasu/przycinanie) + cztery dostawcy bezstanowi (`providers/openai.ts`, `ollama.ts`, `lm_studio.ts`, `gemini.ts`). Silnik indeksu to **Orama** (BM25 + vector).

`VaultIndexer` buduje indeks Oramy i publikuje `plugin.oramaDb`.

**Kontrakt klastra:** [`contracts.ts`](contracts.ts) - jedyne źródło prawdy o powierzchni publicznej.

---

## Co tu jest

```
modules/embedding/
├── index.ts                    # Public API barrel
├── contracts.ts                # Kontrakt klastra - typy, stałe, kształty wywołań konsumentów
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
├── orama_engine.ts              # Orama wrapper (insert/remove/search) - silnik W PAMIĘCI, zero trwałości własnej
├── orama_engine.test.ts
├── indexStore.ts                 # Format indeksu v2: segmenty Float32 + meta, walidacja na granicy, kompakcja, czytnik dumpu v1 (funkcje czyste, zero I/O)
├── indexStore.test.ts
├── VaultIndexer.ts               # żywy indeks semantyczny vaulta → plugin.oramaDb; TRWAŁOŚĆ własna (format v2, patrz sekcja niżej)
├── VaultIndexer.test.ts
├── adaMigration.ts               # Meldunek migracji modelu ada-002 → 3-small
├── adaMigration.test.ts
└── CLAUDE.md                    # ten plik
```

Migrator STAREGO indeksu (sprzed Oramy) nie istnieje - jeśli w vaultcie zostały katalogi bardzo starego indeksu, plugin ich nie widzi i nie rusza, user kasuje je ręcznie. Migrator USTAWIEŃ (przenoszący stary worek ustawień embeddingu do `pkmAssistant.embedding`) mieszka osobno, w `core/runtime/legacySettingsMigration.ts` - to nie jest ten sam mechanizm.

Dostawcy są dziś BEZSTANOWI (budują żądanie, czytają odpowiedź - nic więcej), a cała polityka retry/backoff/timeout/przycinania żyje w jednym `EmbeddingModel`, wspólnym dla wszystkich dostawców.

---

## Public API (`index.ts`)

**Orama silnik:** `countDocs(db)`, `searchVectorTopK(db, vector, opts)`.

**VaultIndexer (żywa semantyka):** `VaultIndexer` - buduje indeks Oramy z plików `.md` vaulta i publikuje `plugin.oramaDb`.

**Rejestr + model + dostawcy:**
- `EmbeddingRegistry` - `default` (getter CZYSTY, fail-closed gdy `provider` nie wybrany albo nieznany), `isConfigured()`, `select(providerId, modelId?)`, `providers()` (dropdown Ustawień).
- `EmbeddingModel` - `embed(texts)` (N→N albo rzut), `countTokens`, `listModels`.
- `EmbedBatchError`, `isEmbedBatchError`, `UnknownEmbeddingProviderError` - kontrakt błędu.
- `createEmbedderFacade(registry)` - buduje `EmbedderFacade` dla `VaultIndexer` (ta sama droga w produkcji i w testach - koniec dublowania ręcznej sklejki).
- `EMBEDDING_PROVIDERS`, `openAiEmbeddingProvider`, `ollamaEmbeddingProvider`, `lmStudioEmbeddingProvider`, `geminiEmbeddingProvider` - instancje dostawców.
- `EMBEDDING_PROVIDER_IDS`, `DEFAULT_EMBED_MODELS`, `DEFAULT_EMBEDDING_SETTINGS`, `DEFAULT_VECTOR_DIM` - stałe kontraktowe.

**Migracja modelu ada-002 → 3-small:**
- `announceAdaMigration(...)` - melduje przełączenie ZE STANU, woła ją `src/main.ts` przy starcie.

**NIE wychodzi z barrela:** typy HTTP (`HttpClient`, `HttpRequestSpec`, `HttpResponse`) - konsumenci spoza modułu biorą je z `core/index.js`, żeby nie było dwóch dróg do jednego typu. Typy wewnątrzmodułowe (`EmbeddingProvider`, kształty prywatne dostawców) też zostają w środku.

---

## Rejestr - jak działa `default`

`provider = settings.pkmAssistant.embedding.provider`. Pusty albo nieznany → **`default === null`**, zero sieci, zero wyjątku (fail-closed - świadoma decyzja, żeby plugin nigdy nie zgadywał, którego dostawcy user chciał użyć). Dalej: `modelId = models[p] ?? info.defaultModel`, `apiKey = apiKeys[p]`, `endpoint = hosts[p] ?? info.defaultEndpoint`. Getter jest CZYSTY: nie mutuje ustawień, nie planuje zapisu, przy niezmienionym wejściu oddaje TĘ SAMĄ instancję (cache unieważniany zmianą ustawień).

Rejestr NIE ma stanu na dysku - nie ma czego leczyć ani co psuć przy boocie.

---

## Model - kontrakt `embed()`

1. wejście puste/białe → `{vector:null}` na TEJ pozycji; same puste wejścia → ZERO żądań;
2. `needsApiKey && !apiKey` → rzut `{kind:'api', code:'api_key_missing'}` PRZED żądaniem (komunikat zawiera `API key not set`);
3. każde wejście przycięte do `safeMaxTokens` (`floor(maxInputTokens × 0.85)`);
4. DOKŁADNIE JEDNO żądanie HTTP na wywołanie (plus ponowienia 429) - `embed()` NIE dzieli wejść na porcje; porcjowanie robi wołacz (`VaultIndexer`);
5. 429 → ponowienie do 3 razy (4 żądania łącznie), potem rzut `{kind:'api', httpStatus:429}`; `backoffFactor` rośnie do sufitu `MAX_BACKOFF_FACTOR=6`, wraca do 1 po sukcesie;
6. status ≥ 400 inny niż 429 → rzut od razu, ZERO ponowień;
7. brak odpowiedzi w `timeoutMs` → rzut `{kind:'timeout'}`;
8. liczba wektorów ≠ liczba niepustych wejść → rzut `{kind:'shape'}` - **NIGDY krótsza tablica** (to był najdroższy bug w historii modułu, patrz gotcha niżej).

`dims` ŚWIADOMIE zostaje `DEFAULT_VECTOR_DIM=1024`, nie natywny wymiar dostawcy - podniesienie go przy niezmienionym `modelKey` unieważniłoby indeksy userów bez rebuildu. Realny wymiar i tak wygrywa - `VaultIndexer` bierze długość pierwszego wektora.

---

## Dostawcy (`providers/`)

Bezstanowi: budują żądanie (`buildEmbedRequest`), czytają odpowiedź (`parseEmbedResponse`), czytają błąd (`parseEmbedError`). Cała polityka retry/timeout/przycinania żyje w `EmbeddingModel`.

- **OpenAI** - `POST {base}/embeddings`, `Bearer`, katalog: `text-embedding-3-small` → 8191.
- **Ollama** - `/api/embed`, `listModels` przez `/api/tags` (filtr nazw `embed|embedding|bge`) + `context_length` z `/api/show`. Zimny start (ładowanie modelu z dysku) potrafi przekroczyć sufit czasu - normalne, `VaultIndexer` ponawia porcję.
- **LM Studio** - warstwa zgodna z OpenAI (`/v1/embeddings`) do embeddingu; `listModels` idzie przez NATYWNY `/api/v0/models` (`type === 'embeddings'`, `loaded_context_length`) - warstwa OpenAI nie mówi, który model jest embeddingowy. Brak `loaded_context_length` → `modelSpec()` `undefined` → limit 512 (świadomy, znany wyjątek).
- **Gemini** - `:batchEmbedContents`, nagłówek `x-goog-api-key` (NIGDY `?key=` w URL-u - wyciekłby przez log adresu), `retryDelay` z `error.details[].retryDelay` w ciele 429.

Modele domyślne - JEDNO źródło (`DEFAULT_EMBED_MODELS`): OpenAI `text-embedding-3-small`, Ollama `nomic-embed-text`, LM Studio `nomic-embed-text-v1.5`, Gemini `gemini-embedding-001`.

---

## VaultIndexer - żywy indeks semantyczny

Patrz nagłówek `VaultIndexer.ts` dla pełnego opisu statusów/skanu/hooków - kontrakt fasady (`EmbedderFacade`) i pole `IndexerStatusSnapshot.modelKey` (SNAPSHOT, nie pole na dysku: sidecar `vault-index.meta.json` dalej pisze `model_key`, bo to dane usera). `IndexerStatusSnapshot.lastNotice` niesie ostatnie zdarzenie wykrytego rebuildu/migracji (patrz sekcja niżej) - `null` gdy nic się nie zdarzyło.

---

## Format indeksu v2 (segmenty + meta)

Orama zostaje silnikiem **wyłącznie w pamięci** - BM25, docs-store i sortowanie żyją tylko w RAM i są odtwarzane przy restore. **Trwałość jest własnością `VaultIndexer`, nie Oramy**: na dysku nie ma nic pochodnego, tylko wektory + minimalna meta.

### Na dysku (`.pkm-assistant/index/`)

- **`vault-index.meta.json`** - JEDYNE źródło prawdy o tym, co jest w indeksie: `model_key`, `dims`, `next_seq`, `segments[]` (`{file, rows}` per segment), `mtimes` (KAŻDA zaindeksowana notatka, także pusta) i `rows` (`path → [segIdx, rowIdx]`, TYLKO notatki z wektorem - pusta treść nie ma wiersza).
- **`vault-index.<seq zero-padded 6>.vec`** - segment binarny little-endian: magic `"PKMV"` + `format=2` + `dims` + `rows` + `rows×dims` Float32. `next_seq` rośnie monotonicznie, nawet po kompakcji - żaden numer nie jest nigdy ponownie użyty.
- Wszystko czytane z dysku wchodzi jako `unknown` i przechodzi przez `parseIndexMetaV2`/`parseIndexMetaV1`/`decodeSegment` (`indexStore.ts`) - kształt i spójność (każdy `rows[path]` wskazuje istniejący segment i wiersz w jego granicach) są zwalidowane PRZED użyciem. Cokolwiek nie gra → `null` → rebuild, nigdy cicha korupcja.

### Protokół commitu

Segmenty są pisane raz i traktowane jako **niezmienne z perspektywy meta** - dopóki JAKAŚ meta na dysku na dany numer segmentu wskazuje, ten plik nigdy nie jest dotykany. Nadpisanie tego samego numeru zdarza się TYLKO, gdy poprzednia próba zapisu pod tym numerem padła PRZED zapisem meta (segment-sierota, na który żadna meta nigdy nie zdążyła wskazać) - wtedy kolejny persist retry'uje pod TYM SAMYM numerem, bo `_nextSeq` w pamięci nie został jeszcze inkrementowany. Poza tym jednym przypadkiem numer sekwencji **nigdy nie jest ponownie użyty** (D3/F2) - nawet po restarcie z nieczytelną/niespójną metą, gdzie jedynym śladem są nazwy plików na dysku (`adapter.list()`, `maxSegmentSeq` w `indexStore.ts`) i nawet po nieudanym rebuildzie (`_nextSeq` NIE cofa się w `catch` rebuildu, w przeciwieństwie do `db`/`mtimes`/`rows`/`dims`).

Zapis przyrostowy = nowy segment z wierszami zmienionych notatek. **Meta jest punktem commitu**: kolejność zapisu jest zawsze segment → meta. Pad zapisu segmentu zostawia stan w pamięci nietknięty (następny persist nadpisuje ten sam, jeszcze niecommitowany plik - patrz akapit wyżej). Pad zapisu meta zostawia segment jako sierotę - stara meta (jeszcze niezastąpiona) nadal wskazuje na swoje własne, kompletne segmenty, więc indeks czytany teraz jest spójny; sierota zostaje sprzątnięta przy najbliższym udanym restore (`adapter.list()` na katalogu indeksu, dopasowanie po BASENAME niezależnie od tego, czy `list()` oddał pełną ścieżkę czy gołą nazwę, `remove()` best-effort).

**Kompakcja** (plik-w-plik) odpala się, gdy segmentów jest za dużo (> 8) albo martwych wierszy jest przynajmniej połowa żywych: czyta segmenty z dysku + wiersze oczekujące, pisze JEDEN nowy segment bazowy (posortowany po ścieżce), potem meta, potem kasuje stare pliki (best-effort). Segment uszkodzony w trakcie kompakcji przerywa ją (warn) i spada na zwykłą ścieżkę zapisu zamiast gubić dane.

### Współbieżność (`_persistChain`, licznik generacji)

`_persistNow()` jest bezpieczny do wołania z wielu miejsc naraz (timer zapisu, koniec skanu/resyncu, rebuild wołany z wnętrza flusha) - dokłada swoje ciało (`_persistNowInner`) na koniec `_persistChain`, więc DWA persisty nigdy nie wykonują się jednocześnie; drugi startuje dopiero, gdy pierwszy (razem ze swoimi `await`ami) się skończy. To NIE zwalnia z myślenia o współbieżności: `_flushQueue`/`_indexMetas` (insert/delete pojedynczych notatek) nadal mogą wykonać się W OKNIE `await` jednego trwającego persistu - persist nie blokuje ich, tylko innego persistu.

`_persistNewSegment`/`_persistCompact` biorą więc MIGAWKĘ `_pending` (i `_rows` przy kompakcji) tuż przed pierwszym `await`. Po sukcesie: wpis z `_pending` jest kasowany TYLKO, jeśli jego referencja `Float32Array` wciąż jest DOKŁADNIE TĄ z migawki (`get(path) === vec`) - jeśli flush w oknie `await` nadpisał ją nowszym wektorem, ten nowszy wpis ZOSTAJE i idzie w NASTĘPNYM persiście (bez tego stary kod robił gołe `_pending.clear()` po zapisie i gubił bezpowrotnie wektory dołożone w tym oknie - notatka znikała z semantyki na stałe, bo dostawała mtime, ale nigdy wiersza). Wiersz w `_rows` dostaje nowy numer tylko dla ścieżek, które NADAL istnieją w `_mtimes` (nie zostały usunięte w tym samym oknie).

Licznik generacji `_gen` (inkrementowany przy każdej mutacji `_pending`/`_mtimes`/`_rows`) pilnuje spójności META: `_buildMetaV2()` POMIJA mtimes/rows każdej ścieżki aktualnie w `_pending` (jej wektor nie jest jeszcze na dysku - `_resync` po restarcie ją po prostu zreembeduje, co jest bezpieczne). Po zapisie meta, `_metaDirty` wraca na `false` TYLKO, jeśli generacja się nie zmieniła w oknie `await write()` I `_pending` jest puste - inaczej zostaje `true`, żeby następny persist dogonił różnicę. `rebuild()` czeka na `_persistChain` PRZED resetem stanu, żeby nie startować skanu pod nogami trwającego zapisu.

### Migracja v1 → v2, z pancerzem

Stary sidecar (`{version:1, model_key, dims, mtimes}` + `vault-index.json` = dawny zrzut `Orama.save()`) jest migrowany automatycznie przy pierwszym restore po aktualizacji pluginu. **Stary plik NIE jest kasowany, dopóki nowe pliki nie są zapisane I ODCZYTANE z powrotem z sukcesem** (segment → meta → odczyt segmentu + porównanie próbki wektorów co do `Math.fround` → odczyt meta i porównanie liczby wierszy). Każdy pad na dowolnym z tych kroków = `IndexerNotice{kind:'migration_failed', reason, detail?}` + pełny rebuild; stary plik zostaje nietknięty do czasu, aż jakiś PÓŹNIEJSZY udany zapis v2 (choćby z rebuildu) go usunie jako balast. Jeśli pad zdarza się PO zapisie meta v2 (dziś: krok weryfikacji), tekst starej meta v1 jest przywracany na dysk best-effort - migracja może się powtórzyć od zera przy następnym starcie zamiast zastać niespójną, częściową meta v2 obok nietkniętego pliku v1. Dokument z wektorem, którego ścieżki nie ma w `mtimes` starej meta (niespójność, jaka teoretycznie mogła powstać przed tą naprawą), dostaje mtime z samego dokumentu w dumpie v1 - inaczej meta v2 miałaby wiersz bez odpowiadającego mtime i `parseIndexMetaV2` odrzuciłaby ją jako `index_corrupt` przy następnym starcie.

`reason` w `IndexerNotice{kind:'migration_failed'}` jest KODEM (`MigrationFailReason`: `v1_unreadable` | `v1_malformed` | `dims_mismatch` | `segment_write` | `meta_write` | `verify_failed`), nie zdaniem po polsku - i18n tłumaczy go kluczem `embedding.notice.migration_reason.<kod>`, a opcjonalny `detail` (surowy komunikat błędu) dokleja się po dwukropku. Composition root (`src/main.ts`) składa oba w jeden string dla `Notice`.

Testy migracji pokrywają: sukces bez re-embedu (`g`), zapis segmentu bazowego pada raz - v1 zostaje, rebuild naprawia i sprząta v1 przez zwykłą, legalną ścieżkę (`h`), oraz weryfikacja odczytu po zapisie pada (segment ucięty) - v1 NIE MOŻE zniknąć nawet gdy poprzedzający rebuild TEŻ pada (dostawca zgaszony), meta v1 wraca na dysk tekstowo identyczna (`h2`). Ten ostatni scenariusz jest jedynym, który realnie odróżnia "v1 skasowany za wcześnie" od "v1 skasowany przez legalny, późniejszy rebuild" - bez padającego rebuildu obie ścieżki kończą się tym samym stanem końcowym.

### Wykryty rebuild (nigdy cicha korupcja)

Zmiana modelu embeddingów, zmiana wymiaru wektora, uszkodzona meta/segment albo nieudana migracja - każdy z tych przypadków kończy się `IndexerNotice` (`model_changed` / `dims_changed` / `index_corrupt` / `migration_failed` / `migrated`) i pełnym rebuildem, nigdy cichym pomieszaniem starych i nowych wektorów. `src/main.ts` mapuje powiadomienie na `Notice` z tekstem `embedding.notice.<kind>` (i18n PL/EN). Rozjazd wymiaru wektora ma DWIE różne konsekwencje zależnie od tego, GDZIE się zdarza:
- **wewnątrz pełnego skanu** (`_fullScan`, pierwszy wektor dopiero ustala `dims`) - rozjazd późniejszego pliku to anomalia dostawcy w obrębie jednego biegu, nie powód do pętli: plik jest po prostu pominięty (jak `EMBED_SKIPPED`), skan leci dalej.
- **na żywym indeksie** (`_resync`/`_flushQueue`, `dims` już ustalone z poprzedniej sesji) - rozjazd znaczy, że model faktycznie się zmienił: JEDNO powiadomienie, przerwanie bieżącej porcji bez ponowień, pełny `rebuild()` (nowa baza, `dims` z nowego wektora). Flaga wewnętrzna pilnuje, że taki rebuild odpala się dokładnie raz, nie w pętli.

---

## Zależności

**Importuje z:** `@orama/orama` (silnik), `core/index.js` (typy HTTP, `LoggerLike`, `EmbeddingSettingsSlice` - `import type`, zero krawędzi modułowej `embedding → models`, bo oba klastry biorą transport z tego samego fundamentu).

**Importowany przez:** `config/runtimeConfig.ts` (rejestracja providerów w `RuntimeConfig.embedding`), `src/main.ts` (`VaultIndexer`, `countDocs`, `createEmbedderFacade`, `announceAdaMigration`), `modules/memory/EmbeddingHelper.ts` (przez `EmbeddingModelLike`), `modules/models/SettingsContent.ts` (`registry.providers()` do dropdownu), `core/selftest.ts` (status diagnostyczny).

---

## Gotchas

### 1. N wejść → N wyników albo RZUT - nigdy krótsza tablica

Krótsza zwrotka to najdroższy bug w historii modułu: indekser stemplował mtime plików bez wektora, skan kończył się `ready` z zerem wektorów, resync po restarcie nie robił ANI JEDNEGO żądania, a Ustawienia mówiły „Aktywne". Kontrakt `EmbeddingModel.embed()` to teraz jedyne miejsce, gdzie ta reguła żyje - provider jej NIE waliduje (to robi model).

### 2. `kind:'shape'` NIE jest rozbijane na pojedyncze pliki

Dla porcji 16 plików krótka zwrotka jest oczywistą awarią, ale dla JEDNEGO wejścia długość 1 jest poprawna - rozbijanie wskrzesiłoby stempel mtime z gotchy 1. `VaultIndexer` polega na tej klasyfikacji (`transport`/`timeout`/`api+429` → transient, ponów CAŁĄ porcję; `api` inny status → permanent, rozbij na pliki; `shape` → fatal, NIE rozbijaj).

### 3. Limity z katalogu, porcja od usera - kolejność jest CELOWO różna

`maxInputTokens`: katalog dostawcy **przed** ustawieniami (twardy limit modelu, `deps.batchSize` by go nie osłabił). `batchSize`: ustawienia **przed** katalogiem (knob wydajnościowy usera, wolno mu zejść niżej albo pójść wyżej niż sugeruje katalog).

### 4. `dims` zostaje 1024 - nie podnoś go do natywnego wymiaru providera

Patrz sekcja „Model" wyżej. `_tryRestore` w `VaultIndexer` odtwarza schemat z `meta.dims`. Rozjazd wymiaru NIE jest sprawdzany przy restore (meta v2 jest już zwalidowana na granicy przez `parseIndexMetaV2`) - jest sprawdzany na ŚWIEŻYM wektorze, w miejscu, gdzie wchodzi do indeksu (`_insertOne`, wołane z pełnego skanu i z żywej kolejki zmian). Skutek rozjazdu zależy od tego, gdzie się zdarza - patrz sekcja „Format indeksu v2" niżej, akapit „Wykryty rebuild".

### 5. Boot NIE pisze - getter `default` jest czysty

Dawny mechanizm przepisywał userowi plik z kluczami API przy KAŻDYM starcie. Dziś rejestr nie ma stanu na dysku - nie ma czego zapisać. Strażnik: `EmbeddingRegistry.test.ts`.

### 6. Fail-closed bez auto-detect

Brak wybranego dostawcy = `null`, koniec. Zero czytania zmiennych środowiskowych, zero „a może Ollama chodzi na localhoście" - świadoma decyzja przeciwko zgadywaniu.

### 7. Wykluczenia indeksu NIE rozróżniają wielkości liter

`VaultIndexer._isExcluded()` to bramka ZAKAZU, więc porównuje po `NFC` + `toLowerCase()` po obu stronach (spójne z regułą globalną w `core/security/AccessGuard`). Indekser trzyma zero zależności od `core/` - wszystko wstrzykiwane - więc normalizacja jest liczona LOKALNIE.

**Nazwy folderu konfiguracji NIE MA w `HARD_EXCLUDES`** (zostały tam `.pkm-assistant` i `.trash`, jedyne dwie nazwy stałe). User może ten folder przemianować, więc jego nazwę dokłada `_hardExcludes()` z żywego `Vault#configDir` - jedną migawką, w której zapamiętuje też, czy nazwa w ogóle była znana. Nieznana (harness, testy, wstrzyknięty vault bez tego pola) = `_isExcluded` idzie **fail-closed: do indeksu nie wchodzi żaden ukryty folder** (pierwszy segment od kropki). Znana = zachowanie dotychczasowe, czyli `HARD_EXCLUDES` + ten jeden folder; inne ukryte foldery są zwykłymi folderami, bo `Vault#getMarkdownFiles()` (jedyne źródło skanu) i tak ich nie zwraca. Ten sam wzorzec po stronie uprawnień: `core/security/AccessGuard._isNoGo`.

### 8. Klucz API nie ma prawa trafić do komunikatu błędu

`EmbedBatchError.message`/`.cause` nie niosą nagłówków ani wartości klucza. Gemini trzyma klucz w nagłówku `x-goog-api-key`, nie w `?key=` - inaczej wyciekłby przez log URL-a.

---

## Testy

- `orama_engine.test.ts` - silnik Oramy (insert/remove/search/serialize w pamięci).
- `indexStore.test.ts` - roundtrip segmentu bajt w bajt (w tym widok na niewyrównanym `byteOffset`), odrzuty dekodera/parserów (spójność `rows`↔`mtimes`, `next_seq` vs numery segmentów, traversal/duplikaty w nazwach), progi kompakcji, `maxSegmentSeq` (numer nigdy ponownie użyty nawet z samych nazw plików), czytnik dumpu v1 na fixture z PRAWDZIWEJ Oramy.
- `adaMigration.test.ts` - meldunek migracji modelu.
- `VaultIndexer.test.ts` - skan/wykluczenia, semantic smoke, restore/resync v2, kompakcja, sieroty (oba kształty `list()`), migracja v1→v2 (sukces, pad zapisu, pad weryfikacji z przywróceniem meta v1), wykryty rebuild (dims/model, dedupe powiadomienia przy oscylacji, rebuild wywołany z resyncu który SAM pada), ponowienie skanu po padzie w połowie (świeża baza, nie częściowa), hooki, kontrakt błędu, **współbieżność `_persistNow`** (adapter blokujący `writeBinary` na żądanie - persist w toku + flush/delete/drugi persist/rebuild w oknie `await`, asercje na bajtach z dysku, nie tylko na Oramie w RAM).
- `EmbeddingModel.test.ts` - kontrakt `embed()`: retry 429, backoff, sufit czasu, przycinanie, N→N, brak klucza, maskowanie sekretów.
- `EmbeddingRegistry.test.ts` - rozstrzyganie `default`, cache, `select()`, `providers()`, boot nie pisze.
- `embedderFacade.test.ts` - most rejestr → `EmbedderFacade`.
- `providers/{openai,ollama,lm_studio,gemini}.test.ts` - kształt żądania/odpowiedzi per dostawca, katalog limitów.
- `tokens.test.ts` - estymata tokenów + przycinanie.

---

## Znane ograniczenia

- `listModels()` jest w kontrakcie i pod testami, ale bez UI - dropdown modeli embeddingu w Ustawieniach jeszcze nie istnieje.
- `pkmAssistant.embedding.batchSize.<p>` jest konfigurowalny, ale bez kontrolki w Ustawieniach - dziś zmienia się go tylko ręczną edycją pliku ustawień. `timeoutMs` MA kontrolkę: Ustawienia → Modele → Embedding → „Limit czasu żądania" (pole w sekundach, przelicznik ×1000 przy zapisie - `modules/models/embedTimeoutInput.ts`).
- `dispose()` NIE flushuje zaplanowanego zapisu - tylko zdejmuje timery. Do `persistDebounceMs` (domyślnie 30 s) zmian tuż przed zamknięciem Obsidiana nie trafia na dysk przed unloadem; przy następnym starcie `_resync()` je po prostu re-embeduje, bo ich mtime nie zdążył się zapisać. To NIE jest utrata danych (treść notatek żyje w vaulcie, nie w indeksie) - tylko powtórzony embedding garstki plików.
