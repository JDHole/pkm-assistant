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
- `EMBEDDING_PROVIDER_IDS`, `DEFAULT_EMBED_MODELS`, `DEFAULT_EMBEDDING_SETTINGS`, `DEFAULT_VECTOR_DIM`, `DEFAULT_EMBED_TIMEOUT_MS` - stałe kontraktowe (`DEFAULT_EMBED_TIMEOUT_MS`: jedno źródło prawdy, `modules/models/SettingsContent.ts` go importuje zamiast trzymać własny zduplikowany literał w sekundach).

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
- **`vault-index.<seq zero-padded 6>.vec`** - segment binarny little-endian: magic `"PKMV"` + `format=2` + `dims` + `rows` + `rows×dims` Float32. `next_seq` rośnie monotonicznie, nawet po kompakcji - numer sekwencji jest ponownie użyty TYLKO w jednym, wąskim przypadku (patrz akapit „Protokół commitu" niżej), poza nim nigdy.
- Wszystko czytane z dysku wchodzi jako `unknown` i przechodzi przez `parseIndexMetaV2`/`parseIndexMetaV1`/`decodeSegment` (`indexStore.ts`) - kształt i spójność (każdy `rows[path]` wskazuje istniejący segment i wiersz w jego granicach) są zwalidowane PRZED użyciem. Cokolwiek nie gra → `null` → rebuild. To jedna z dwóch gwarancji przeciw cichej korupcji - druga (o tym, KTÓRY wektor trafia do meta, nie o tym, że format jest czytelny) jest opisana w „Współbieżność" niżej.

### Protokół commitu

Segmenty są pisane raz i traktowane jako **niezmienne z perspektywy meta** - dopóki JAKAŚ meta na dysku na dany numer segmentu wskazuje, ten plik nigdy nie jest dotykany. Nadpisanie tego samego numeru zdarza się TYLKO, gdy poprzednia próba zapisu pod tym numerem padła PRZED zapisem meta (segment-sierota, na który żadna meta nigdy nie zdążyła wskazać) - wtedy kolejny persist retry'uje pod TYM SAMYM numerem, bo `_nextSeq` w pamięci nie został jeszcze inkrementowany. Poza tym jednym przypadkiem numer sekwencji **nigdy nie jest ponownie użyty** (D3/F2) - nawet po restarcie z nieczytelną/niespójną metą, gdzie jedynym śladem są nazwy plików na dysku (`adapter.list()`, `maxSegmentSeq` w `indexStore.ts`) i nawet po nieudanym rebuildzie (`_nextSeq` NIE cofa się w `catch` rebuildu, w przeciwieństwie do `db`/`mtimes`/`rows`/`dims`).

Zapis przyrostowy = nowy segment z wierszami zmienionych notatek. **Meta jest punktem commitu**: kolejność zapisu jest zawsze segment → meta. Pad zapisu segmentu zostawia stan w pamięci nietknięty (następny persist nadpisuje ten sam, jeszcze niecommitowany plik - patrz akapit wyżej). Pad zapisu meta zostawia segment jako sierotę - stara meta (jeszcze niezastąpiona) nadal wskazuje na swoje własne, kompletne segmenty, więc indeks czytany teraz jest spójny; sierota zostaje sprzątnięta przy najbliższym udanym restore (`adapter.list()` na katalogu indeksu, dopasowanie po BASENAME niezależnie od tego, czy `list()` oddał pełną ścieżkę czy gołą nazwę, `remove()` best-effort).

`_fullScan()` (wołany z pierwszego `initialize()` i z `rebuild()`) RZUCA (`FullScanNoResultsError`), jeśli po całym skanie `_mtimes` zostaje pusta mimo że plików do zaindeksowania było więcej niż zero - to znaczy, że KAŻDY plik skończył trwale pominięty (np. zły klucz/model dostawcy), nie że vault jest legalnie pusty. Przy Reindeksie rzut trafia do `rebuild()`'s `catch`, który przywraca CAŁY poprzedni stan (`db`/`mtimes`/`dims`/`rows`/`segments`/`pending`) i NIGDY nie dochodzi do kodu sprzątającego stare segmenty (ten kod stoi w `try`, PO `_fullScan()`) - żywy indeks znikałby tylko dlatego, że dostawca akurat odrzucił wszystko. Przy pierwszym biegu (`initialize()`, bez stanu do przywrócenia) ten konkretny typ rzutu kończy status `error` **BEZ** uzbrajania automatycznego ponowienia skanu - to trwała awaria konfiguracji (zły klucz/model), nie usterka, która minie sama; uzbrojenie ponowienia młóciłoby to samo złe żądanie co `scanRetryMs`, bez końca. User poprawia klucz/model i sam odpala Reindex albo restartuje plugin; każdy INNY pad skanu (sieć, timeout, transient) nadal uzbraja zwykłe automatyczne ponowienie.

Zero notatek (`files.length === 0` - wszystkie skasowane, albo wszystkie w NoGo) jest INNYM przypadkiem niż powyższy: `_fullScan()` NIE rzuca (legalnie pusty wynik), więc dochodzi do zwykłej ścieżki sukcesu. Bez dodatkowej ostrożności ta ścieżka byłaby pułapką: `_persistNowInner()` uznaje zapis za zbędny, gdy `_pending` jest puste i nic nie jest "dirty" - a po resecie stanu na początku `_fullScan()` to WŁAŚNIE jest stan przy zerze plików, więc meta na dysku zostałaby STARA (wciąż wskazująca segmenty sprzed czyszczenia), podczas gdy `rebuild()`'s kod sprzątający (`if (!this._metaDirty)`) uznałby - błędnie - że zapis "się udał" i skasowałby te same segmenty spod stopy starej mety: `index_corrupt` przy KAŻDYM kolejnym starcie. Dlatego `_fullScan()` wymusza `_metaDirty = true` tuż przed swoim finałowym `_persistNow()`, NIEZALEŻNIE od tego, czy coś trafiło do `_pending` - meta (możliwie pusta: `segments: []`, `rows: {}`, `mtimes: {}`) MUSI trafić na dysk PRZED czyszczeniem starych segmentów; zapis pada → `_metaDirty` zostaje `true` → `rebuild()` NIE kasuje niczego (ten sam mechanizm ochronny co przy "wszystko odrzucone" wyżej).

**Kompakcja** (plik-w-plik) odpala się, gdy segmentów jest za dużo (> 8) albo martwych wierszy jest przynajmniej połowa żywych: czyta segmenty z dysku + wiersze oczekujące, pisze JEDEN nowy segment bazowy (posortowany po ścieżce), potem meta, potem kasuje stare pliki (best-effort). Segment uszkodzony w trakcie kompakcji przerywa ją (warn) i spada na zwykłą ścieżkę zapisu zamiast gubić dane.

### Współbieżność (`_persistChain`, licznik generacji)

`_persistNow()` jest bezpieczny do wołania z wielu miejsc naraz (timer zapisu, koniec skanu/resyncu, rebuild wołany z wnętrza flusha) - dokłada swoje ciało (`_persistNowInner`) na koniec `_persistChain`, więc DWA persisty nigdy nie wykonują się jednocześnie; drugi startuje dopiero, gdy pierwszy (razem ze swoimi `await`ami) się skończy. To NIE zwalnia z myślenia o współbieżności: `_flushQueue`/`_indexMetas` (insert/delete pojedynczych notatek) nadal mogą wykonać się W OKNIE `await` jednego trwającego persistu - persist nie blokuje ich, tylko innego persistu.

`_persistNewSegment`/`_persistCompact` biorą więc MIGAWKĘ `_pending` (i `_rows` przy kompakcji) tuż przed pierwszym `await`. Po sukcesie zapisu, gwarancja jest jedna i ta sama dla obu ścieżek: **wiersz trafia do `_rows` TYLKO dla wektora, który w chwili zapisu jest NADAL dokładnie tym z migawki** - referencyjnie, nie po wartości. Dla zwykłego segmentu to `this._pending.get(path) === vec` (ta sama migawka służy do kasowania wpisu z `_pending`); dla kompakcji to `this._rows.get(path) === rowsSnap.get(path)` dla wierszy sourced z dysku i `this._pending.get(path) === pendingSnap.get(path)` dla wierszy sourced z pending - w OBU przypadkach ta sama krotka/referencja co w migawce. Jeśli flush w oknie `await` nadpisał wpis nowszym wektorem, ten nowszy wpis ZOSTAJE w `_pending` i idzie w NASTĘPNYM persiście; jeśli notatka w oknie została USUNIĘTA albo WYCZYSZCZONA (treść pusta - upsert z pustą treścią zostawia NOWY mtime, ale kasuje wpis z `_pending`/`_rows`), referencja już nie pasuje i wiersz zostaje martwy OD RAZU, zamiast dostać zapis wskazujący na wektor, który nie jest już aktualny. Samo `_mtimes.has(path)` (wcześniejsza wersja tej naprawy) NIE WYSTARCZAŁO jako test: notatka wyczyszczona w oknie dalej ma wpis w `_mtimes` (nowy stempel), więc ten sam wiersz dostawałby świeży numer wskazujący na STARY, martwy wektor - dokładnie ta klasa cichej korupcji, przed którą ta gwarancja chroni. Dane, które nie przechodzą testu, zostają w PLIKU jako nieszkodliwy balast (już zakodowane bajty bez referencji w `_rows`) - żadna dodatkowa praca I/O, żadne czyszczenie na już zapisanym segmencie.

Licznik generacji `_gen` pilnuje spójności META i jest inkrementowany przy KAŻDEJ mutacji `_pending`/`_mtimes`/`_rows`: w `_insertOne` (wektor i pusty plik), w `_removeDoc`, w gałęzi `_fullScan` która stempluje mtime plików pominiętych zanim `dims` jest znane, oraz w `_persistNewSegment`/`_persistCompact` za każdym razem, gdy faktycznie dopisują wiersz do `_rows` (czyli DOKŁADNIE wtedy, gdy przechodzi test referencji z akapitu wyżej - martwy wpis, który nie trafia do `_rows`, nie bumpuje licznika, bo niczego nie zmienia). `_buildMetaV2()` POMIJA mtimes/rows każdej ścieżki aktualnie w `_pending` (jej wektor nie jest jeszcze na dysku - `_resync` po restarcie ją po prostu zreembeduje, co jest bezpieczne). Po zapisie meta, `_metaDirty` wraca na `false` TYLKO, jeśli generacja się nie zmieniła w oknie `await write()` I `_pending` jest puste - inaczej zostaje `true`, żeby następny persist dogonił różnicę (to jedyny sposób, żeby np. usunięcie notatki W OKNIE zapisu meta nie zgubiło się: `_removeDoc` bumpuje `_gen` niezależnie od tego, czy akurat trwa zapis). `rebuild()` czeka na `_persistChain` PRZED resetem stanu, żeby nie startować skanu pod nogami trwającego zapisu.

`dispose()` uzbraja flagę `_disposed`: zapis w toku (jeśli jakiś trwa) kończy się normalnie, ale żaden `_scheduleFlush`/`_schedulePersist`/`_scheduleScanRetry` wywołany PO tej chwili (np. flush, który dokańcza embedding już PO unloadzie pluginu) nie uzbraja nowego timera - inaczej plugin "wypisany" z Obsidiana mógłby jeszcze pisać na dysk chwilę później.

### Migracja v1 → v2, z pancerzem

Stary sidecar (`{version:1, model_key, dims, mtimes}` + `vault-index.json` = dawny zrzut `Orama.save()`) jest migrowany automatycznie przy pierwszym restore po aktualizacji pluginu. **Stary plik NIE jest kasowany, dopóki nowe pliki nie są zapisane I ODCZYTANE z powrotem z sukcesem** (segment → meta → odczyt segmentu + porównanie próbki wektorów co do `Math.fround` → odczyt meta i porównanie liczby wierszy). Każdy pad na dowolnym z tych kroków = `IndexerNotice{kind:'migration_failed', reason, detail?}` + pełny rebuild; stary plik zostaje nietknięty do czasu, aż jakiś PÓŹNIEJSZY udany zapis v2 (choćby z rebuildu) go usunie jako balast. Jeśli pad zdarza się PO nadpisaniu meta v2 - czy to sam zapis (mógł przerwać się W TRAKCIE, dysk pełny w połowie stringa) czy późniejszy krok weryfikacji - tekst starej meta v1 jest przywracany na dysk best-effort w OBU przypadkach: migracja może się powtórzyć od zera przy następnym starcie zamiast zastać niespójną/uciętą metę v2 obok nietkniętego pliku v1. Dokument z wektorem, którego ścieżki nie ma w `mtimes` starej meta (niespójność, jaka teoretycznie mogła powstać przed tą naprawą), dostaje mtime z samego dokumentu w dumpie v1 - inaczej meta v2 miałaby wiersz bez odpowiadającego mtime i `parseIndexMetaV2` odrzuciłaby ją jako `index_corrupt` przy następnym starcie.

`reason` w `IndexerNotice{kind:'migration_failed'}` jest KODEM (`MigrationFailReason`: `v1_unreadable` | `v1_malformed` | `dims_mismatch` | `segment_write` | `meta_write` | `verify_failed`), nie zdaniem po polsku - i18n tłumaczy go kluczem `embedding.notice.migration_reason.<kod>`, a opcjonalny `detail` (surowy komunikat błędu) dokleja się po dwukropku. Composition root (`src/main.ts`) składa oba w jeden string dla `Notice`.

Testy migracji pokrywają: sukces bez re-embedu (`g`); zapis segmentu bazowego pada raz (`h`) - test sprawdza stan KOŃCOWY (rebuild naprawia i sprząta v1 przez zwykłą, legalną ścieżkę), nie osobno stan v1 w samym momencie tego pierwszego padu; zapis META v2 pada (przerwany W TRAKCIE - śmieci na dysku zamiast v1) z dostawcą trwale zgaszonym, żeby fallback-owy pełny skan PO padzie migracji też musiał paść - inaczej jego własny udany zapis nadpisałby meta jeszcze raz i zamaskowałby to, co ten test faktycznie sprawdza (meta v1 przywrócona przez SAM `_migrateV1`, nie przez późniejszy legalny zapis); oraz weryfikacja odczytu po zapisie pada (segment ucięty) - v1 NIE MOŻE zniknąć nawet gdy poprzedzający rebuild TEŻ pada (dostawca zgaszony), meta v1 wraca na dysk tekstowo identyczna (`h2`). Scenariusz `h2` jest jedynym, który realnie odróżnia "v1 skasowany za wcześnie" od "v1 skasowany przez legalny, późniejszy rebuild" - bez padającego rebuildu obie ścieżki kończą się tym samym stanem końcowym.

### Wykryty rebuild

Zmiana modelu embeddingów, zmiana wymiaru wektora, uszkodzona meta/segment albo nieudana migracja - każdy z tych przypadków kończy się `IndexerNotice` (`model_changed` / `dims_changed` / `index_corrupt` / `migration_failed` / `migrated`) i pełnym rebuildem, NIGDY cichym pomieszaniem starych i nowych wektorów w JEDNYM indeksie. (Ta gwarancja jest o tym, że stare i nowe wektory nie mieszają się w jednej bazie - nie mylić z gwarancją współbieżności z sekcji wyżej, która jest o tym, KTÓRY wektor w obrębie tej samej bazy dostaje wiersz.) `src/main.ts` mapuje powiadomienie na `Notice` z tekstem `embedding.notice.<kind>` (i18n PL/EN). Rozjazd wymiaru wektora ma DWIE różne konsekwencje zależnie od tego, GDZIE się zdarza:
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

Patrz sekcja „Model" wyżej. `_tryRestore` w `VaultIndexer` odtwarza schemat z `meta.dims`. Rozjazd wymiaru NIE jest sprawdzany przy restore (meta v2 jest już zwalidowana na granicy przez `parseIndexMetaV2`) - jest sprawdzany na ŚWIEŻYM wektorze, w miejscu, gdzie wchodzi do indeksu (`_insertOne`, wołane z pełnego skanu i z żywej kolejki zmian). Skutek rozjazdu zależy od tego, gdzie się zdarza - patrz sekcja „Format indeksu v2" wyżej, akapit „Wykryty rebuild".

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
- `VaultIndexer.test.ts` - skan/wykluczenia, semantic smoke, restore/resync v2, kompakcja, sieroty (oba kształty `list()`), migracja v1→v2 (sukces, pad zapisu segmentu - meta v1 nigdy nie została nadpisana, więc BEZ przywracania, nie ma czego przywracać; pad zapisu META v2 i pad weryfikacji - te dwa Z przywróceniem meta v1), rebuild z zerowym wynikiem (wszystkie pliki trwale odrzucone) nie kasuje starego indeksu, rebuild na vaulcie, który spadł do ZERA notatek (pusta meta zapisana PRZED skasowaniem starych segmentów, trzy kolejne restarty bez `index_corrupt`), zły klucz/model = `error` bez automatycznego ponowienia (odróżnione od zwykłego pada skanu, który ponowienie uzbraja), wykryty rebuild (dims/model, dedupe powiadomienia przy oscylacji, rebuild wywołany z resyncu który SAM pada), ponowienie skanu po padzie w połowie (świeża baza, nie częściowa), hooki, kontrakt błędu, dispose() w trakcie flusha bez nowego timera, **współbieżność `_persistNow`** (adapter blokujący `writeBinary`/`write` na żądanie - persist w toku + flush/delete/emptied/drugi persist/rebuild w oknie `await`), crash-restart PO pierwszym persiście BEZ drugiego (notatka, która weszła do `_pending` w oknie zapisu, wraca do kolejki na restarcie zamiast zniknąć po cichu). Asercje na bajtach z dysku (`decodeSegment` + `Math.fround` wobec ostatniego wektora embeddera) TAM, gdzie jest co dekodować - `F1/R1`, `F1/R2`, `k`, `d`; dla notatki, której wiersz po naprawie ma być NIEOBECNY (wyczyszczona/usunięta w oknie) dowód jest inny: brak `rows[path]` w meta + wyszukiwanie semantyczne w RAM na STARYM wektorze nie trafia w tę ścieżkę (nie ma czego dekodować, skoro wiersza celowo nie ma). Fabryka testowa (`newIndexer`) ma DOMYŚLNIE ogromne timery (`debounceMs`/`persistDebounceMs`/`scanRetryMs`) - żaden test nie zależy od tego, że `_scheduleFlush`/`_schedulePersist`/`_scheduleScanRetry` wystrzeli SAM w tle (persist/flush wołane jawnie); krótki timer testuje wprost tylko test, który bada SAM timer.
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
