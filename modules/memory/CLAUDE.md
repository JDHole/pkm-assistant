# modules/memory/

**Pamiec agenta w Memory v3: per-agent, plikowa, jawna dla usera i niedestrukcyjna.**

Kazdy agent ma osobny folder:

```text
.pkm-assistant/agents/<safeName>/memory/
├── brain.md
├── brain/
│   └── archive/
├── sessions/
│   ├── active/
│   │   └── .discarded/
│   └── archive/
├── summaries/
│   ├── L1/
│   ├── L2/
│   └── L3/
└── .state.json
```

Najwazniejsza zmiana po Memory Index Rework 2026-05-24: `brain.md` nie jest juz monolitem ani miejscem na fakty. To kategoryzowany indeks do `brain/*.md`. Trwale fakty ida do osobnych notatek, a `## Biezace` pokazuje max 2-3 aktywne projekty jako link + jedno zdanie opisu. Agent nie dopisuje faktow bezposrednio do `brain.md` w `/save session`.

**Status:** Memory v3 stable (Sprint M3, 2026-05-15). Ostatnie zmiany: S29 Puls pamięci (2026-07-29).

---

## Co Tu Jest

```text
modules/memory/
├── index.ts                    # publiczne drzwi (barrel) — jedyny legalny import z zewnatrz modulu
├── AgentMemory.ts              # struktura folderow, brain.md, sesje active/archive, summaries
├── BrainIndex.ts               # buildBrainIndex(): kategoryzowany indeks brain.md z metadanych brain/*.md
├── MemoryAccessGuard.ts        # strict per-agent path guard dla brain/
├── collisionSuffix.ts          # F5 (2026-09-01): findFreeCollisionPath() — JEDNA wspólna pętla „wolna nazwa przy kolizji", wołana z sześciu miejsc w AgentMemory.ts. NIE w barrelu (wewnetrzny)
├── SaveSessionWorkflow.ts      # /save session: propozycje notatek + archiwizacja aktywnej sesji
├── ArchiveWorkflow.ts          # dedup brain/ + L1/L2/L3 user-reviewed consolidation (JEDEN tor: runWithRun + applyStepDecision)
├── ConsolidationRun.ts         # S29: stan przebiegu konsolidacji (plan krokow, statusy, retry, koszt) — czysty node
├── MemoryOpsCenter.ts          # S29: rejestr JEDNEGO aktywnego przebiegu + subskrypcja dla UI (wzorzec StreamingManager)
├── consolidationLabels.ts      # S29 Z4/Z5: etykiety/ikony/czas/koszt/podsumowanie przebiegu (czyste, dzielone przez pasek statusu i modal)
├── ConsolidationSnapshot.ts    # D6: zostal sam prune() — sprzatanie kopii po starej wersji pluginu
├── MigrationV3.ts              # backup-first migracja brain.md v2 -> v3
├── StateManager.ts             # .state.json: aktywne sesje + liczniki (E2.7 K1: kolejka RMW)
├── IdleScheduler.ts            # E2.7 W3: pure decyzja „czy zapisac po bezczynnosci" (wpinany w modules/chat)
├── RetrievalEngine.ts          # silnik narzedzia `search` (E2.5): runSearch() z RRF keyword+semantic
├── EmbeddingHelper.ts          # helper wektoryzacji dla retrieval semantycznego
├── CostLog.ts                  # koszt operacji memory/sub-agent
├── activeSessionFormat.ts      # S36 Faza 1+2: JEDNO zrodlo kontraktu pliku sessions/active — formatSessionEvent (pisarz A, z `**seq:**`) + parseActiveSession (czytnik A/B/mieszany, wiadomosci niosa `seq`) + maxSeq + EVENT_FIELDS + escape/unescape `## ` i etykiet pol + KNOWN_ROLES + parseFrontmatter. Czysty node, zero importow z obsidian. NIE w barrelu (wewnetrzny)
├── sessionParser.ts            # markdown session parse/format (transkrypt „format B"; escape/unescape i KNOWN_ROLES re-eksportuje z activeSessionFormat.js)
├── streamHelper.ts             # helper stream -> complete / tools loop
├── workPrompts.ts              # fabryczne prompty robocze (save_session/archive/summary/brief) — B3
├── SettingsContent.ts          # render sekcji Pamiec w Settings
└── SettingsSection.ts          # rejestracja sekcji memory
```

⚠️ **Monolit >800 LOC** (stan 2026-09-02, po fabryce wydajności W4): `AgentMemory.ts` — 2535 linii. Świadomie nierozbity; zmiana w nim = przeczytaj całość przed edycją.

⚠️ **Monolit >800 LOC** (stan 2026-07-30, po D6 / TS-2): `ArchiveWorkflow.ts` — 1253 linie. Świadomie nierozbity; zmiana w nim = przeczytaj całość przed edycją.

> **RollingWindow wyprowadzony** do `modules/chat/` w E1.6 B4 (2026-07-21) — token window to domena chatu, nie pamieci. Memory juz go NIE eksportuje.
>
> **`toolTranscriptSanitizer.js` mieszka w `modules/agent-loop/`** — memory GO NIE eksportuje (re-eksport `sanitizeToolTranscript` skasowany w S30 Z4, patrz sekcja „S30 Z4" niżej); jedyny wołacz, `modules/chat/chat/RollingWindow.ts`, importuje go dziś wprost z `modules/agent-loop/index.js`. **`ContextSessionGenerator.js` SKASOWANY** w E2.9 faza D (artefakt „Kontekst sesji" zastapiony przez artefakty zywe).

---

## Public API

Import z zewnatrz tylko przez `modules/memory/index.js`.

| Export | Rola |
|---|---|
| `AgentMemory` | Glowny runtime pamieci agenta. Tworzy v3 foldery per-folder, odswieza indeks `brain.md`, zapisuje aktywne sesje, listuje notatki (`listBrainNotes`/`listActiveSessions`/`listArchiveSessions` to jego METODY). Metoda `pruneArchive({days, maxFiles})` (S32 Z6): retencja `sessions/archive` — kasuje TYLKO sesje ze stemplem `covered_by_l1`, oba limity default 0 = OFF, best-effort. |
| `parseBrainLog(text, limit=50)` | S32 Z1b: czysty parser `brain.log` (TSV → `{ts, op, target, detail}`, od najnowszego). Pisze go `AgentMemory.appendBrainLog`; czyta karta „Log wpisów" w profilu agenta (jedyny zewnętrzny konsument — dlatego jest w barrelu po przycince S30). |
| `MemoryAccessGuard`, `MEMORY_V3_ERROR_CODES`, `isValidNoteType`, `makeMemoryNoteFilename()` | Waliduje sciezki Memory v3 (brak traversal / absolutnych / cross-agent) + kanoniczne nazwy notatek `type_slug.md`. |
| `listUncoveredArchiveSessions(agentMemory)` | Sesje z `sessions/archive` BEZ stempla `covered_by_l1`, sortowane rosnąco po nazwie — jedyny poprawny materiał na nową paczkę L1. |
| `AgentMemory.listUncoveredL1s()` / `listUncoveredL2s()` (METODY, nie w barrelu) | 2026-09-04: pliki L1, których nie wymienia żadne L2 (`l1_files`) / pliki L2, których nie wymienia żadne L3 (`l2_files`). Materiał na paczkę L2 / L3, sortowany rosnąco po nazwie. Patrz gotcha 17. |
| `IdleScheduler` | E2.7 W3: pure decyzja „czy zapisac po bezczynnosci" (wpinany w `modules/chat`). |
| `SaveSessionWorkflow` | `/save session`: user-review, tworzenie notatek, archiwizacja sesji. |
| `ArchiveWorkflow` | Automatyczna konsolidacja po progach: brain/ dedup, L1, L2, L3. **Jeden tor** (D6, 2026-07-30): `runWithRun(consolidationRun)` + `applyStepDecision()` + `generateGatedSteps()` — generacja oddzielona od zapisu (S29). Stary, blokujacy `run()` + `createLevel1/2/3` SKASOWANE. |
| `parseNaTerazSections`, `naTerazSectionKey` | E2.8 D2: pure helpery sekcji „Na teraz" brain.md, czytane przez UI panelu Pamiec i `MemorySaveTool`. |
| `ConsolidationRun`, `buildConsolidationPlan`, `STEP_STATUS`, `STEP_KIND`, `normalizeUsage` | S29 Z2: stan jednego przebiegu konsolidacji — plan paczek z licznikow, maszyna stanow kroku. Zero UI, zero Obsidiana. `normalizeUsage` byl wyciety w S30 Z4, wrocil do barrela po merge S30+S32 (zweryfikowane w `index.ts:46-54`) — konsumuje go `modules/chat/slash-commands/save_session.js` (wpis kosztu Z4.3). |
| `memoryOpsCenter` (singleton), `OPS_EVENT` | S29 Z2: rejestr jednego aktywnego przebiegu. `startRun/getActiveRun/finishRun/subscribe/requestOpenModal`. Drugi trigger przy aktywnym przebiegu NIE startuje drugiego — zwraca biezacy i prosi o modal. |
| `stepLabel`, `stepDetail`, `stepStatusIcon`, `stepStatusLabel`, `stepDurationMs`, `isFallbackStep`, `formatDuration`, `formatUsageLine`, `statusBarLine`, `buildRunSummary`, `summaryToText`, `planToText` | S29 Z4/Z5 (`consolidationLabels.js`): warstwa OPISOWA przebiegu — jedno zrodlo etykiet dla paska statusu (`core/runtime/PluginRuntime.ts`) i modalu przebiegu (`modules/shell`). Czyste funkcje, zero DOM. |
| `MigrationV3` | Migracja v2 -> v3: najpierw `memory.v2.backup/`, potem notatki `brain/`. |
| `streamToComplete` | S29 Z1: stream → complete z opcjonalnym `{onChunk, signal, watchdog}`. |
| `RetrievalEngine` | Silnik narzedzia `search` (E2.5) — patrz wiersz nizej. |
| `CostLog`, `EmbeddingHelper` | Koszt operacji memory/sub-agent + helper wektoryzacji. |
| `DEFAULT_SAVE_SESSION_PROMPT`, `DEFAULT_ARCHIVE_PROMPT`, `DEFAULT_SUMMARY_PROMPT` | E2.8 B3: fabryczne prompty robocze (`workPrompts.js`). Czwarty, `DEFAULT_BRIEF_PROMPT`, WYCIĘTY w AUD-dead-code-124 (2026-09-02) — patrz sekcja niżej. |
| `registerSettings` | Rejestracja sekcji „Pamiec i kontekst" w Settings. |

> ### S30 Z4 — 24 eksporty WYCIĘTE z barrela (+1 re-eksport)
>
> Zero konsumentow spoza modulu (weryfikacja: grep po calym repo + skan wszystkich importow
> barrela). **Definicje ZOSTAJA w bebechach — zmienily sie tylko DRZWI.**
>
> `listBrainNotes` · `listActiveSessions` · `listArchiveSessions` (byly cienkimi wrapperami
> `agentMemory?.listX?.()` — UI wola metody `AgentMemory` wprost) · `getSafeAgentName` ·
> `StateManager` (owner: `AgentMemory`) · `buildBrainIndex` · `formatIndexLine` ·
> `INDEX_SECTIONS` · `NOTE_TYPE_TO_SECTION` · `applyNaTerazOps` · `NA_TERAZ_SECTIONS` ·
> `NA_TERAZ_MAX_ENTRIES` (indeks przebudowuje `AgentMemory.rebuildBrainIndex`, sekcje muta
> `writeNaTeraz`) · `ConsolidationSnapshot` (po D6 zostal sam `prune()`, wolany wewnatrz
> `runWithRun`) · `MAX_STALL_RETRIES` · **`MemoryOpsCenter` (KLASA — singleton
> `memoryOpsCenter` ZOSTAJE)** · `stepErrorText` · `runDurationMs` · `formatTokens` ·
> `formatCostUsd` · `estimateCostUsd` · `STREAM_ERROR_CODES` (czyta je `ArchiveWorkflow`
> u siebie) · `formatToMarkdown` · `parseSessionFile` (jeden czytnik/pisarz plikow sesji
> zyje w `AgentMemory` + `SaveSessionWorkflow`).
>
> **`normalizeUsage` NIE jest już wśród wyciętych wyżej** — wrócił do barrela po merge
> S30+S32 (zweryfikowane w `index.ts:46-54`, komentarz przy eksporcie). Patrz wiersz
> `ConsolidationRun` w tabeli Public API wyżej.
>
> **`sanitizeToolTranscript` — re-eksport SKASOWANY.** Byl pass-throughem z `modules/agent-loop`
> „dla wstecznej kompatybilnosci" (E2.1). Jedyny wolacz, `modules/chat/chat/RollingWindow.js`,
> importuje go teraz **wprost z domu** (`modules/agent-loop/index.js`). Skutek uboczny:
> `RollingWindow` nie ma juz statycznej krawedzi na memory.

**`RetrievalEngine` w szczegolach (E2.5/E2.6):** `runSearch({query, scope, where, mode, limit})` —
kandydaci wg `where`, hybryda keyword+semantic przez RRF (k=60), excerpt z dysku. DI
(app/vault/embeddingHelper/oramaDb/agentMemory/vectorSearch). Opcjonalne `app` → scope=vault
API-first (getMarkdownFiles + metadataCache: frontmatter z cache, linki z resolvedLinks,
cachedRead); bez `app` fallback walker/parser/regex; scope=memory zawsze adapter. Konsument:
`modules/tools/SearchTool.js`.

> **Sufit skanu keyword — `MAX_KEYWORD_SCAN_CANDIDATES=300` (2026-09-02, fabryka wydajnosc W3,
> AUD-wydajnosc-024/055/075/025/056).** Bez `where` `_gatherCandidates` moze zwrocic CALY vault —
> bez sufitu `_keywordRank` czytal i lowercase'owal trescn KAZDEJ notatki, sekwencyjnie, PRZED
> zastosowaniem `limit` (ktory tnie dopiero wynik, nie prace). Naprawa w `_scanKeywordCandidates`:
> - **Sufit PRZED czytaniem**, nie po: kandydaci powyzej 300 sa ciecia przed odczytem tresci, nie
>   po zliczeniu. Kandydaci, ktorych nazwa pasuje do slowa zapytania, maja pierwszenstwo skanu
>   (`_prioritizeForScan`, tania heurystyka bez I/O) — trafienia po nazwie nie gina przy obcieciu.
>   Wynik niesie `scan: {candidates, scanned, truncated}` w `SearchOutcome` — **TYLKO gdy
>   `truncated`** (ponizej sufitu kontrakt identyczny jak przed naprawa, pole nieobecne).
>   ⚠️ `SearchTool.ts` (inny modul, nietykany w tej naprawie) dzis NIE przekazuje `r.scan` dalej
>   do modelu — zeby user/model widzial note o obcieciu, ktos musi dopisac ta linie w `execute()`.
> - **`contentCache` nie trzyma tresci po zliczeniu** (AUD-025): `_scanKeywordCandidates` robi
>   `contentCache.delete(c.path)` zaraz po policzeniu trafien dla kandydata. Skutek: budowa
>   excerptu dla `top` (<=`limit`<=50) CZYTA PONOWNIE — tani re-read zamiast trzymania N pelnych
>   tresci (kiedys caly zeskanowany zbior) do konca `runSearch`.
> - **Dedup w locie rownoleglych identycznych skanow** (AUD-075): `delegate` odpala do
>   `max_parallel_delegations` (5) sub-agentow rownolegle, kazdy z WLASNA instancja
>   `RetrievalEngine` (`SearchTool.buildEngine` tworzy nowa per tool call) ale nad TYM SAMYM
>   `plugin.app.vault`. Modul-level `WeakMap<vault, Map<klucz, Promise>>` (`_inFlightKeywordScans`)
>   dzieli JEDEN skan miedzy rownolegle wywolania o identycznym kluczu. Wpis zyje TYLKO na czas
>   skanu (czyszczony w `finally`) — to dedup w locie, nie trwaly cache; w testach kazdy
>   `vaultOf()` to nowy obiekt, wiec testy sie nie mieszaja.
>   🔴 **BLOKER naprawiony w review rundy 2 (2026-09-02).** Pierwsza wersja kluczowala TYLKO
>   `scope::where::query` — dla scope='memory' to NIE odroznia agentow (dwaj suby moga
>   rownolegle zapytac identyczny `{scope:'memory', query:'projekt'}`, majac RÓŻNE `agentMemory`).
>   Reviewer odtworzyl realnym biegiem: sub B dostawal sciezki i excerpt z `brain/` suba A —
>   zlamanie strict cross-agent isolation (gotcha 3 wyzej). Klucz dzis niesie: `agentMemory.
>   paths.brain` (root pamieci — pusty dla scope='vault'), `includeHiddenVault` (admin widzi
>   INNY zbior plikow), i jako ostateczny, niezalezny dowod — `_candidateFingerprint(candidates)`
>   (odcisk POSORTOWANYCH sciezek kandydatow PO filtrze scope/where — hash dwoma niezaleznymi
>   akumulatorami FNV-1a-podobnymi, nie kryptograficzny, ale odrozniajacy KAZDY realnie inny
>   zbior plikow, nawet gdyby ktos wymyslil kolejny wymiar roznicujacy kandydatow, ktorego dzis
>   nie znamy). Test `BLOKER AUD-review-2` w `RetrievalEngine.test.ts`: dwaj agenci, wspolny
>   `vault`, rownolegly `search(scope:'memory')` → kazdy widzi TYLKO swoje (mutacyjnie zweryfikowane:
>   cofniecie klucza do samego `scope::where::query` → test czerwony).
> - **`_excerptStart`** (AUD-056, LOW): normalizowal kiedys `\s+` na CALYM pliku dla 200 znakow
>   wyniku. Dzis tnie PRZED normalizacja, normalizuje juz tylko wycinek. Widoczny excerpt bez
>   zmian (dowod: test rownowaznosci).
>   🟠 **Regresja naprawiona w review rundy 2.** Pierwsza wersja miala STALY zapas `max*4` —
>   `\s+` zwija DOWOLNIE DUZO bialych znakow, wiec plik z 1000 pustymi liniami na poczatku dawal
>   `rawSlice` zlozony w calosci z whitespace'u (widoczny excerpt = sam „…", tresc zgubiona), a
>   krotka tresc + setki bialych znakow NA KONCU dawala falszywe „…" (nic nie zostalo obciete,
>   zapas po prostu skonczyl sie w ogonie spacji). Dzis zapas ROSNIE: `max*4` → `max*16` → cala
>   tresc, dopoki normalizacja nie da `max` znakow albo zapas nie obejmie calego pliku. Typowa
>   notatka konczy na pierwszej probie (bez regresji wydajnosciowej); patologiczny plik placi
>   pelna normalizacje, swiadomie. Dwa testy adwersarialne w `RetrievalEngine.test.ts`
>   (`REGRESJA (korekta review) AUD-056: ...`) pilnuja obu przypadkow z osobna.
>
> Mikrobench (atrapa 4348 plikow w RAM, mediana z 5, scratchpad sesji fabryki): skan bez sufitu
> 4348 odczytow/5,0ms → z sufitem 300 odczytow/0,54ms (93% mniej odczytow, 89% szybciej, CPU-only);
> `_excerptStart` na 50 duzych plikach (~1,3MB kazdy) 2080ms → 0,43ms (~4800x). Testy mutacyjne w
> `RetrievalEngine.test.ts` (sekcje „AUD-wydajnosc-...” i „review rundy 2") lapia kazda naprawe
> z osobna (usuniecie sufitu / `contentCache.delete` / dedupu / fingerprintu klucza / rosnacego
> zapasu excerptu → test czerwony, zweryfikowane recznie per naprawa).
>
> ⚠️ **Sufit dziala TYLKO dla scope='vault'.** Dla scope='memory' jest calkowicie WYLACZONY
> (`capApplies = scope !== 'memory'` w `_scanKeywordCandidates`) — druga korekta review rundy 2.
> `_listMemoryFiles` listuje brain → brain/ → sessions/active → sessions/**ARCHIVE** → dopiero
> L1 → L2 → L3; u agenta z dlugim archiwum (>300 plikow) sufit 300 zjadalby cale archiwum i L1-L3
> (najcenniejsza, skondensowana warstwa pamieci) nigdy nie trafialyby do skanu — `_prioritizeForScan`
> tu nie ratuje, bo nazwy L1/L2/L3 sa datowane, nie niosa slow zapytania. Pamiec JEDNEGO agenta
> jest z natury ograniczona (jego wlasne dane, nie caly vault) — ryzyko O(rozmiar vaulta) po prostu
> nie wystepuje. Test `POWAZNE (korekta review)`: 400 plikow archiwum + 1 trafienie w L2 → trafienie
> ZNALEZIONE, `r.scan` nieobecne (nie tylko podniesiony sufit — calkowicie wylaczony).

**Historyczne kasacje eksportow (przed S30):** `ContextSessionGenerator` (E2.9 faza D),
`RollingWindow` (E1.6 B4 → `modules/chat/`), `getMemoryBase`/`searchDocs`/`SearchHelper.js`
(E2.5), `AuditLog` (E2.2 — wydmuszka bez call-site'ow, zastapiona przez trace petli),
`streamToCompleteWithTools` (E2.1 → `runAgentLoop`).

---

## Kontrakty Memory V3

### `memory_save`

`memory_save` tworzy nowy plik w `brain/` aktualnego agenta i odswieza `brain.md` jako indeks.

- create-only: istniejący filename zwraca `note_already_exists`,
- nie zapisuje faktow bezposrednio do `brain.md`,
- przyjmuje typy: `user`, `agent_rule`, `skill_hint`, `project_context`, `reference`,
- zapis poza aktualnym agentem jest niedozwolony.

### Legacy write guards

- `brain_update` NIE jest juz rejestrowany jako narzedzie MCP (E1.1, 2026-07-21) — zzeral tokeny i mylil model. Pliki `BrainUpdateTool.js` + `BrainUpdateHistory.js` (guard + `undoLastBrainUpdate`) oraz alias reaktora w `ToolReactorRegistry` skasowane w E1.6 (2026-07-21). Direct brain.md writes wylaczone; runtime pisze przez `memory_save` / `/save session`.
- `memory_delete` usuwa dokladnie jedna pasujaca notatke z `brain/`, odswieza indeks i odmawia wieloznacznych trafien.
- `memory_delete` nie kasuje `project_context`; zakonczone projekty musza przejsc archiwizacje z review lekcji.
- Stare `memoryWrite()` nie dopisuje juz faktow do `brain.md`; moze zapisac tylko `active_context.md` i audyt ignorowanych legacy updates. Batchowy `MemoryExtractor` + `Archivist` + rodzina `applyBrainUpdates` skasowane w E1.1 (2026-07-21) — `brain.md` nie jest juz mutowany przy zamknieciu sesji.

### `brain.md` jako indeks

Od E2.8 (D2) `brain.md` zaczyna się od dwoch sekcji „Na teraz" (pamiec krotkoterminowa, plain-text bullety stanu biezacego — patrz nizej), a POD nimi jest kategoryzowany indeks:

- `## Bieżące` — max 3 najnowsze aktywne `project_context`,
- `## User` — notatki `user`,
- `## Preferencje` — notatki `agent_rule`,
- `## Workflow` — notatki `skill_hint`,
- `## Projekty i referencje` — starsze `project_context` + `reference`.

Kazdy wpis ma format:

```md
- [[brain/project_context_memory_v3.md]] — Przebudowa systemu zapisywania i indeksowania faktow w brain.md i brain/.
```

`/save session` tworzy zaakceptowane notatki w `brain/`, archiwizuje sesje i przebudowuje indeks. Nie aplikuje juz `brain_updates` jako surowych dopiskow do sekcji.

**Sekcje H2 spoza katalogu zarzadzanych** (recznie dopisane, np. `## AKTYWNY TEST` trybu testowego) sa od 2026-08-15 **ZACHOWYWANE przy przebudowie** — `parseForeignSections` wyciaga je ze starego pliku, a `buildBrainIndex` emituje verbatim NA KONCU nowego (kolejnosc wzgledna zachowana). Wczesniej rebuild wycinal je z pliku, a ratowal tylko cichy `brain.md.bak` (incydent — patrz sekcja 2026-08-15 na dole). Reczne linie WEWNATRZ sekcji zarzadzanych (`## User` itd.) nadal sa wycinane i nadal laduja w `.bak`.

### `brain/archive/`

`brain/archive/` to cmentarzysko zakonczonych projektow. Pliki z tego folderu nie wchodza do `brain.md` ani do domyslnego `listBrainNotes()`.

Projekt `project_context` moze trafic do `brain/archive/` dopiero po review lekcji (`lessonsReviewed=true`). Workflow archiwizacji przenosi zakonczone projekty do `brain/archive/` zamiast kasowac je bez sladu.

### `brain/pending_rescue/` (D8, 2026-08-27 — AUD-docs-065)

Poczekalnia kandydatow z `memory_rescue` (kompresja okna czatu). Ten sam mechanizm wykluczenia co `brain/archive/` — JEDEN filtr podfolderow w `listBrainNotes()`, wiec pending nie wchodzi do `brain.md`, konsolidacji ani retrievalu. Kontrakt Memory v3 „user zatwierdza" jest odtad egzekwowany takze dla rescue: kandydat czeka tu na review w modalu zapisu sesji (`SaveSessionWorkflow.prepareProposals` doklada go do listy z prefiksem pochodzenia; accept → notatka w `brain/` istniejaca sciezka `writeBrainNote`, reject → kasacja pliku; anulowanie modala NIE rusza poczekalni).

Cztery metody publiczne `AgentMemory`: `writePendingRescue(note, {source})` (create-with-suffix, kolejka K1, RAW body — stopka Why/How dokleja sie dopiero przy accept), `listPendingRescue()` (pad → `[]`, sesja zapisuje sie dalej), `acceptPendingRescue(filename, note?)` (readIfExists fail-closed, create-before-delete), `rejectPendingRescue(filename)` (probeFile fail-closed na `unknown` — nie kasuje przy sprzecznych sygnalach). Walidacja filename przed konkatenacja sciezki (regex, odpada `../`).

**Dlaczego NIE przez konsolidacje** (sledztwo D8): `MemoryOpsCenter` to globalny singleton „jeden przebieg na caly plugin" (nie per-agent), `ConsolidationRun` trzyma propozycje wylacznie w RAM (D6 swiadomie skasowal trwalosc — bezpieczne dla idempotentnej konsolidacji, zabojcze dla rescue chroniacego jednorazowy wynik LLM), a ksztalt krokow (merges/deletions, body+sources) nie miesci pojedynczej notatki. `STEP_KIND.SAVE_PROPOSALS` byla martwa rezerwacja od S29 (zero implementacji, zero konsumentow) — **skasowana w dead-code sweepie 2026-09-02** (AUD-dead-code-047/180) razem z parą osieroconych kluczy i18n `memory.consolidation.step.save_proposals` (pl+en).

### Odczyt pamieci: `read`/`list` (scope=memory)

Od E2.6 odczyt pamieci idzie przez prymitywy `read`/`list` (`modules/tools/`) z `scope:"memory"` — dawne `memory_read`/`memory_read_summary`/`memory_list_summaries` zostaly wchloniete (stare nazwy dzialaja przez aliasy). Reguly bezpieczenstwa (MemoryAccessGuard) bez zmian:

`read(path:"<filename>", scope:"memory")` czyta tylko plik `.md` z `brain/` aktualnego agenta:

- `../../../x.md` -> `invalid_path`,
- `/absolute/path.md` -> `invalid_path`,
- `jaskier/brain/x.md` z innego agenta -> `cross_agent_access_denied`,
- brak pliku -> `note_not_found`.

`read(path:"summaries/L1/<file>.md", scope:"memory")` czyta podsumowanie L1/L2/L3; `list(folder:"summaries", scope:"memory")` listuje je. Bramka uprawnienia `memory` jest fail-closed wewnatrz narzedzia (jak `search`).

### Sesje aktywne

Kazda wiadomosc usera, odpowiedz agenta, tool result i sub-agent result dopisywane sa do `sessions/active/<agent>_YYYY-MM-DD_HH-mm.md`. `.state.json` trzyma liste aktywnych sesji do restore po restarcie Obsidiana.

**Od S36 Fazy 2 (2026-07-30) plik active ma JEDNEGO pisarza:** `appendToActiveSession` (event-log,
append-only, z numeracja `**seq:**`). `saveSession` NIE nadpisuje juz pliku transkryptem — dopisuje
tylko ogon, ktorego czytnik w pliku nie widzi. Transkrypt (`## User`/`## Assistant`) to widok
POCHODNY: powstaje przy `archiveActiveSession` (konwersja event-log → format B). Od S36b to
JEDYNY producent transkryptu w pamieci — rodzina draftow (drugi producent) jest skasowana.
Format `sessions/archive/` bez zmian, wiec konsolidacja L1/L2/L3 i `parseSessionFile` sa nietkniete.

### Konsolidacja

`ArchiveWorkflow` odpala flow user-review:

- dedup `brain/`: trigger po 20 notatkach, auto-bump +10 gdy user odrzuci merge,
- L1: po 5 zarchiwizowanych sesjach; sesje zostaja,
- L2: po 5 L1; usuwa pokryte sesje z archive, L1 zostaja,
- L3: po 5 L2; usuwa pokryte L1, L2 zostaja,
- materialem na L1 sa TYLKO sesje bez stempla `covered_by_l1` (`listUncoveredArchiveSessions`),
- materialem na L2 sa TYLKO pliki L1, ktorych nie wymienia zadne L2 (`listUncoveredL1s`),
  a materialem na L3 — TYLKO L2 niewymienione w zadnym L3 (`listUncoveredL2s`) — patrz gotcha 17,
- **retencja archiwum** (Z6): `runWithRun` na starcie woła `AgentMemory.pruneArchive({days, maxFiles})`
  z ustawien (`pkmAssistant.archiveRetentionDays` / `pkmAssistant.archiveRetentionMaxFiles`, oba default 0 = OFF).
  Kasuje WYLACZNIE sesje ze stemplem `covered_by_l1`; sesja bez stempla jest nietykalna,
- pole ustawien `keepRecentSessions` SKASOWANE (D6/Z6) — bylo duchem bez konsumentow,
- **snapshotu NIE MA** (patrz sekcja „kubełek 2" nizej — swiadoma decyzja); `runWithRun` na starcie
  sprzata tylko stare kopie przez `snapshot.prune()`.

### Migracja (kontrakt po naprawie 2026-08-28)

`MigrationV3` wykrywa stare memory, gdy istnieje `brain.md`, nie istnieje folder `brain/` **i tresc
nie wyglada na juz zmigrowany indeks v3** (`looksLikeV3Index`: kanoniczny wikilink
`- [[brain/<typ>_*.md` wystarcza sam; naglowek „Na teraz" liczy sie TYLKO razem z >=2 naglowkami
`INDEX_SECTIONS` — pojedynczy slaby sygnal, np. reczny `- [[brain/mapa]]` w brainie v2, NIE wygasza
migracji). Brain w formacie v3 bez folderu `brain/` (swiezy klon, desync) nie jest migrowany:
`run()` robi backup, dosztukowuje strukture (`ensureMemoryStructure` moze dokleic brakujace
naglowki indeksu i domigrowac plaski `sessions/`) i wraca `{skipped, reason:'already_v3_format',
backupPath}` — round-trip na wlasnym wyjsciu (audyt nocny 27/28.08) jest zamkniety.

Flow (znaleziska #1-#2 audytu + runda 2 po adwersaryjnej weryfikacji opus):

1. backup calego `memory/` do `memory.v2.backup/` — TAKZE na sciezce skip `already_v3_format`,
2. jednostka migracji to AKAPIT/BULLET (blok), nie linia: pusta linia i `---` rozdzielaja bloki,
   wciety sub-bullet zostaje przy rodzicu, naglowek `###`-`######` staje sie prefiksem nastepnego
   bloku (`Finanse: Konto w ING.`), znacznik ``` jest pomijany,
3. `## User` -> `user_*.md`; `## Preferencje` -> `agent_rule_*.md`; `## Ustalenia` ->
   `project_context_*.md`; `## Bieżące` -> `project_context_*`; `## Workflow` -> `skill_hint_*`;
   `## Projekty i referencje` -> `reference_*` (naglowki kolidujace z `INDEX_SECTIONS` ida
   w notatki, NIE w keepInBrain — sekcja verbatim pod takim naglowkiem zostalaby wycieta przy
   nastepnym `rebuildBrainIndex`),
4. sekcja NIEROZPOZNANA z trescia -> `keepInBrain` i przezywa w nowym `brain.md` VERBATIM na koncu
   pliku (mechanizm sekcji obcych z incydentu 2026-08-15); sekcja pusta (takze rozpoznana pusta)
   -> `deletedSections`. **Kazda sekcja jest policzona w planie** (notes / keepInBrain /
   deletedSections) — user nie zatwierdza juz planu, w ktorym czegos nie widac,
5. tresc przed pierwszym `##` (wstep pod H1) -> notatki `reference`, ale TYLKO obok prawdziwych
   sekcji; plik bez zadnego `##` idzie w calosci w dump (pkt 8),
6. zombie sekcje typu `System`, `Agora`, `vault-builder` sa proponowane do usuniecia,
7. kolizja nazwy notatki (identyczne pierwsze 6 slow dwoch blokow) -> sufiks `_2`/`_3` w filename;
   zadna tresc nie znika z planu po cichu,
8. plik bez sekcji z realna trescia -> `reference_legacy_brain_dump.md` (kopia 1:1); sam szkielet
   naglowkow -> zero notatek i ZERO smieciowego dumpu.

`applyPlan(plan, originalBrain)` jest fail-closed: plan z niepustym `keepInBrain` bez podanego
`originalBrain` rzuca (sekcje zachowywane odtwarza sie z oryginalnej tresci). Straznicy:
`MigrationV3_rozdrabnianie.test.ts` (20 testow, w tym false-positive'y heurystyki) +
`MigrationV3.test.ts` (8, nietkniete).

---

## Gotchas

1. **User authority absolute.** Agent proponuje, user zatwierdza. `brain.md` i sesje nie sa niszczone bez jawnego flow.
2. **Plik sesji jest zrodlem prawdy.** L1/L2/L3 sa pochodne. Nie kasuj nizszego poziomu zanim wyzszy poziom ma zapas opisany w designie.
3. **Cross-agent isolation jest twarde.** Tola nie czyta `jaskier/brain/*.md`. Ma uzyc wlasnej pamieci albo komunikacji miedzy agentami.
   - **K4 (2026-08-22): `AgentManager.getActiveMemory()` NIE JEST na sciezce tla.** Zwraca pamiec agenta
     AKTUALNIE wybranego w UI, a bieg suba i kompresja konca tury dozywaja chwili, w ktorej user
     przelaczyl zakladke — wiec ten sam odczyt oznaczal wtedy KOGOS INNEGO (AUD-security-064/065/091/036).
     Wszystko, co pisze albo czyta pamiec z biegu w tle, adresuje ja przez `getAgentMemory(<wlasciciel>)`,
     a brak instancji dla nazwanej tozsamosci konczy sie **odmowa**, nie podstawieniem cudzego katalogu.
     `getActiveMemory()` zostaje dla akcji usera na aktywnej zakladce (zapis reczny, `/save session`, UI).
4. **Nie przywracaj `_archiveOverflow` jako normalnej drogi v3.** To legacy fallback z v2, do usuniecia w cleanupie M3.
5. **Nie ruszaj modeli ani OnboardingModal przy memory.** To prywatne domeny decyzji Kuby.
6. **Nowe user-facing stringi ida do `core/i18n/pl.js` i `core/i18n/en.js`.**
7. **Stopka notatki `brain/` (`**Dlaczego:**` / `**Jak stosowac:**` + zdania domyslne) idzie z i18n**
   (`memory.note.why_label` / `how_label` / `why_unspecified` / `how_default`, Poligon F2) — wczesniej
   byla wpisana po angielsku na sztywno w DWOCH miejscach: `AgentMemory._buildBrainNoteContent`
   i `modules/tools/MemorySaveTool.buildNoteContent`. Oba musza wyjsc IDENTYCZNIE (AgentMemory
   dokłada tylko pole `source`). Nic tego ksztaltu nie parsuje — to opis dla czlowieka.
   ⚠️ **Trzeci pisarz, `ArchiveWorkflow._buildNoteContent` (scalenia dedup), zostal PO ANGIELSKU**
   — silnik konsolidacji jest swiadomie i18n-free (patrz S29 Z4/Z5). Skutek: notatka powstala ze
   scalenia ma angielskie etykiety, reszta polskie. Do decyzji Kuby.
   ✅ **Czwarty pisarz, `SaveSessionWorkflow._createBrainNote`, NAPRAWIONY (2026-08-30,
   AUD-code-review-067/068).** Reimplementowal zapis notatki obok kanonu — bez stopki Why/How
   (LLM w `/save session` generuje `why`/`how_to_apply`, workPrompts.ts, ale nigdy nie trafialy
   na dysk ta droga) i z wlasnym escapowaniem frontmattera `replace(':', ' -')` zamiast
   `JSON.stringify` (dwukropek w tresci usera ginal trwale — „spotkanie 14:30" → „spotkanie
   14 -30"). Dzis `_createBrainNote` DELEGUJE wprost do `AgentMemory.writeBrainNote` — trzeci
   pisarz zniknal, zostaly dwa: kanon (`_buildBrainNoteContent`/`MemorySaveTool.buildNoteContent`)
   i swiadomie angielski `ArchiveWorkflow._buildNoteContent` wyzej.
8. **`description` notatki `brain/` MUSI byc jednolinijkowy w drodze do promptu** (K9,
   AUD-security-035). Pisarze frontmatteru escapuja opis przez `JSON.stringify`, wiec w PLIKU
   to jedna linia — ale czytnik (`parseFrontmatterScalar` -> `JSON.parse`) przywraca prawdziwe
   znaki nowej linii. `getMemoryContext` wstawialo go do indeksu niesklejonego, wiec opis
   z wlasnymi liniami `=== KONIEC PAMIECI ===` i `## INSTRUKCJE` otwieral w prompcie nowy
   naglowek zaraz obok pozycji indeksu. Kazdy
   emiter opisu do promptu idzie teraz przez `oneLineDescription` (`BrainIndex.ts`, eksportowana
   od K9) — ten sam, ktorego uzywa `formatIndexLine`. Caly indeks + `brain.md` jada dodatkowo
   w ogrodzeniu `<vault_content source="memory">` (`PromptBuilder.addDynamicSection`).
9. **Odczyt, ktory PADL, nie jest „pusto"** (K4, AUD-bledy-061/043/044). `adapter.exists()` klamie
   na dyskach sieciowych i na Dysku Google (incydent 2026-07-28) — dlatego kazde miejsce, gdzie od
   odpowiedzi zalezy NADPISANIE pliku, pyta przez `probeFile` z `core/index.js` (`'exists' |
   'missing' | 'unknown'`; `false` jest POTWIERDZANE proba `read`). Swiezy `brain.md`, nowy plik
   sesji i bootstrap `.state.json` powstaja WYLACZNIE na `'missing'`; `'unknown'` = fail-closed
   (zero nadpisania, `log.warn`, blad w gore). Konsekwencje kontraktu: **`getBrain()` i
   `listBrainNotes()` RZUCAJA** zamiast oddawac `''`/`[]` (wolacz decyduje — `getMemoryContext`
   wstawia do promptu `memory.long_term_unavailable`, `ensureMemoryStructure` tylko warnuje),
   `rebuildBrainIndex` robi `.bak` takze przy `'unknown'`, a w `StateManager` **`read()` moze
   zdegradowac sie do defaultow W PAMIECI (z logiem), ale mutatory (`update`/`addActiveSession`/
   `markArchived`) rzucaja** — utrwalenie defaultow kasowalo liczniki i `brain_notes_limit`.
   ⚠️ Nie „naprawiaj" tego z powrotem na gole `exists()` i nie potwierdzaj `false` odczytem
   w petlach listujacych (migracje, `listBrainNotes`) — tam to tylko koszt.
10. **Nieostemplowana sesja jest WYNIKIEM kroku, nie szumem w logu** (AUD-bledy-047).
   `_cleanupAfterL1` zwraca `{marked, skipped: [{session, reason, detail?}]}` (`reason`:
   `'not_found'` = nie ma pliku ani w `sessions/archive/`, ani w plaskim `sessions/`;
   `'write_failed'` = read-modify-write rzucil), loguje `warn` przy niepustym `skipped`,
   a `ArchiveWorkflow._writeLevel1` przenosi te liste do zwrotki kroku jako **`unstamped`**
   (pole POWSTAJE tylko przy niepustej liscie — czysty przebieg zwrotki nie zasmieca).
   Do naprawy pady byly liczone lokalnie i raportowane WYLACZNIE w `log.debug`, a krok
   szedl jako `done` — sesje bez stempla wracaly przez `listUncoveredArchiveSessions()`
   do NASTEPNEJ paczki, czyli drugie streszczenie tych samych rozmow za kolejny strzal
   do modelu (ta sama klasa wtopy co „12 zduplikowanych L1", tyle ze po cichu i tylko przy
   bledzie IO). ⚠️ To jest **„zapisane, nie ostemplowane"** — plik L1 ISTNIEJE, wiec krok
   NIE ma prawa wywrocic calej konsolidacji; stemplowanie jest idempotentne
   (`fm.covered_by_l1 === l1Name`), wiec ponowienie jest bezpieczne.
11. **`roleFromEvent` musi znac KAZDY typ zdarzenia biegu suba** (AUD-bledy-011). Oba zdarzenia
   (`subagent_call` i `subagent_error`) nios w polu `**role:**` **etykiete SUBA**
   (`researcher`/`strategist`, czasem `system` z YAML-a), a nie role wiadomosci. `subagent_call`
   mial mapowanie z typu, wiec kolizja byla niewidoczna; `subagent_error` go NIE MIAL, spadal
   do galezi `**role:**` i przy etykiecie spoza `KNOWN_ROLES` dawal `null` — parser POMIJAL caly
   blok. Skutek: padniety bieg suba znikal z odtworzonej rozmowy, z konsolidacji (karmi sie
   `parsed.messages`) i przez `archiveActiveSession` (transkrypt z `parsed.messages` + kasacja
   oryginalu) takze Z DYSKU. Przy etykiecie `system` bylo gorzej — tresc bledu wracala jako
   wiadomosc SYSTEMOWA. ⚠️ Nowy typ zdarzenia = nowe mapowanie w `roleFromEvent` + test
   round-tripu w `activeSessionFormat.test.ts`. Pole `**role:**` w tych blokach zostaje takie,
   jakie jest (kszalt wspolny obu zdarzen) — o roli wiadomosci decyduje TYP.
12. **Self-append (dopisanie do WLASNEGO pliku) to siostrzana wada gotchy 9, naprawiona osobno**
   (2026-08-27). Gotcha 9 pilnuje „czy zalozyc pusty plik od zera" (`probeFile`); tu chodzi
   o piec miejsc, ktore czytaly stary log/sesje/archiwum PRZED dopisaniem NOWEGO wpisu wzorcem
   `if (await exists()) { read() }` — na Dysku Google klamiace `exists()===false` sprawialo, ze
   kod nigdy nie probowal `read()` i NADPISYWAL cala dotychczasowa tresc jednym nowym wpisem.
   `readIfExists` (`core/utils/vaultFs.ts`, eksport z barrela) czyta NAJPIERW, wiec `exists()`
   nie ma szans skłamac. Polityka przy `'unreadable'` (sygnaly sprzeczne) jest per-miejsce:
   `saveSession` i `_archiveOverflow` (legacy, wolany wylacznie przez `updateBrain` — funkcje
   bez zadnego callera w produkcji ani testach, ale to wciaz TA sama klasa bledu) RZUCAJA i
   przerywaja operacje (transkrypt/kompresja sa zbyt cenne, zeby zgadywac); `_appendAuditLog`,
   `appendBrainLog` i `CostLog.append` (kroniki best-effort) tylko `log.warn` + pomijaja TEN
   wpis, kontrakt „nigdy nie rzuca" zostaje. Testy: `AgentMemory_self_append.test.ts` +
   `modules/memory/CostLog.test.ts`.
13. **`appendToActiveSession` dokleja ogon, nie przepisuje pliku (AUD-wydajnosc-094, fabryka W4,
   2026-09-02; poprawione review'em opusa tego samego dnia — P2).** Do naprawy KAZDE zdarzenie
   tury (wiadomosc, tool call, wynik narzedzia) robilo pelny `read()` + pelny `write()` calego
   pliku sesji — 200 zdarzen = 110 MB zapisu na plik 1,1 MB (kwadratowy koszt wzgledem dlugosci
   sesji), a kazdy taki zapis to tez jedno zdarzenie synchronizacji na vaultach na Dysku Google.
   Dzis pisze przez `_appendSessionFile` (`adapter.append`, ten sam kontrakt co
   `core/utils/LogFileSink.ts`); pelny odczyt placi sie **raz na sciezke**
   (`_sessionSeqCache`/`_sessionEndsWithNewline`, inicjalizowane na pierwszym zdarzeniu sesji
   albo pierwszym po restarcie Obsidiana) — nie na kazde zdarzenie. Maskowanie
   (`maskSensitiveData`) obejmuje TYLKO nowo doklejany fragment, nie caly plik — bezpieczne, bo
   wzorce sekretow dzialaja w granicach jednego, kompletnego bloku zdarzenia, nigdy w poprzek
   dwoch osobnych zapisow. Adapter bez natywnego `append` (atrapa testowa, ewentualny inny
   adapter) dostaje fallback — ale przez `readIfExists` (K4/gotcha 12), **NIE** goly
   `exists()+read()` jak w `LogFileSink`: ten plik juz raz zaplacil za self-append na klamiacym
   `exists()` i fallback append nie ma prawa cofnac tej ochrony.
   ⚠️ **P2 (review opusa, ten sam dzien): plik skasowany Z ZEWNATRZ MIEDZY zdarzeniami, na
   CIEPLYM cache, jest realnym ryzykiem** — natywny `adapter.append` na brakujacym pliku wedlug
   wielu implementacji NIE rzuca, tylko cicho zaklada plik OD NOWA (jak `fs` z flaga `a`), wiec
   bez dodatkowej ochrony taki plik wracal BEZ frontmattera (`archiveActiveSession`/restore go
   nie rozpoznawaly). Dwie warstwy obrony: (1) jesli `adapter.append` SAM rzuci, `_appendSessionFile`
   odroznia to przez `probeFile` — potwierdzone `'missing'` → `SessionFileMissingError` (nie zwykly
   `Error`), inny blad (uprawnienia, pelny dysk) leci dalej NIEZMIENIONY; (2) gdy adapter cicho
   zaklada od nowa (nie rzuca), co `APPEND_VERIFY_EVERY_N` (=20) zdarzen na ciepłym cache leci
   JEDEN tani `exists()` (metadane, bez odczytu tresci — O(1) wzgledem rozmiaru pliku) — jesli
   plik zniknal, sesja zaklada sie od nowa Z FRONTMATTEREM zamiast dokladac goly fragment.
   ⚠️ **Znane ograniczenie warstwy (2):** okno trafienia jest 1/N — jesli miedzy skasowaniem
   a najblizszym punktem weryfikacji zdazy przejsc CHOC JEDEN append, adapter cicho odtworzy
   headerless plik i weryfikacja go juz nie zlapie (plik znow „istnieje"). Nie ma taniego sposobu
   to zamknac bez pelnego `exists()` na kazde zdarzenie (co zniwelowalby caly zysk tej naprawy) —
   swiadomy kompromis, udokumentowany w komentarzu przy `APPEND_VERIFY_EVERY_N`.
   Zarowno wykrycie martwej sciezki na zimnym cache, jak i sygnal `SessionFileMissingError`,
   leca przez **PETLE LOKALNA wewnatrz JEDNEGO `_enqueuePathWrite`**, NIE przez rekurencje do
   samej `appendToActiveSession` — rekurencja wracalaby do kolejki TEJ SAMEJ sciezki, gdy
   odtworzona sesja dostanie IDENTYCZNA nazwe (normalne przy rozdzielczosci minutowej
   `_generateActiveSessionFilename` — nie egzotyczny przypadek), co jest **samo-zakleszczeniem**
   (zlapane testem podczas pisania tej poprawki — `Promise returned by test never resolved`).
   Golden test (bajtowa rownowaznosc ze starym read+write, w tym plik bez koncowego `\n` i plik
   PUSTY) + P1/P2 scenariusze: `AgentMemory_append_perf.test.ts`.
14. **`ensureMemoryStructure()` jest memoizowana per instancja (AUD-wydajnosc-095, fabryka W4,
   2026-09-02; poprawione review'em opusa tego samego dnia — P1 BLOKER).** Bootstrap (11× `exists`
   + `list` migracji legacy + odczyt `brain.md` + odczyt `.state.json`) lecial bezwarunkowo na
   KAZDE wywolanie — a `appendToActiveSession` (przez `startActiveSession`) wola go na kazde
   zdarzenie sesji. Flaga `_structureEnsured` (pole instancji, `true` dopiero PO udanym przejsciu
   calej funkcji — pad w srodku, np. `mkdir`, NIE oznacza „zrobione", nastepna proba robi pelny
   bootstrap od nowa) sprawia, ze druga i kolejne wolanie sa no-opem. Bezpieczne, bo
   `basePath`/`paths` sa ustawiane raz w konstruktorze i nigdy sie nie zmieniaja pod ta sama
   instancja (nowy agent = nowa instancja `AgentMemory`).
   ⚠️ **P1 BLOKER (review opusa, ten sam dzien): „ufam ścieżce" ≠ „ścieżka niepusta".**
   Pierwsza wersja tej naprawy ufala samemu faktowi `this.activeSessionPath` truthy — ale to pole
   ma TRZECH ZEWNĘTRZNYCH pisarzy poza `AgentMemory` (patrz komentarz P3 przy deklaracji pola
   `activeSessionPath` w AgentMemory.ts — `chat_tabs.ts:126` przy przełączeniu zakładki,
   `chat_session.ts:237`/`244` przy restore wielu zakładek), którzy podstawiają ścieżkę WPROST,
   z pominięciem `startActiveSession`, bez sprawdzenia czy plik wciąż istnieje. Sekwencja
   „/save_session archive → archiveActiveSession kasuje plik i zeruje pole u siebie →
   przełączenie zakładki tam i z powrotem WSKRZESZA już-martwą ścieżkę" kończyła się ENOENT
   na pierwszym appendzie i utratą wiadomości usera (na main ta sama sekwencja po prostu zakłada
   nową sesję — reviewer odtworzył różnicę testem). Dziś `startActiveSession` ufa TYLKO ŻYWEMU
   CACHE dla tej ścieżki (`_sessionSeqCache.has(path)` — dowód, że TA instancja realnie do niej
   pisała): cache ciepły = zero I/O (zysk 095 zostaje, ~99% zdarzeń); cache zimny (pierwsze
   użycie ścieżki przez tę instancję — świeżo stworzona ALBO wskrzeszona z zewnątrz) = jeden tani
   `probeFile`, a potwierdzone `'missing'` zeruje wskaźnik i zakłada NOWĄ sesję (jak main), zamiast
   wywracać turę. Druga, niezależna warstwa obrony żyje w `appendToActiveSession` samej — patrz
   gotcha 13 (P2) — więc nawet mutacja JEDNEJ warstwy nie od razu psuje scenariusz end-to-end
   (potwierdzone mutacyjnie: wyłączenie obu naraz odtwarza dokładnie zgłoszony crash).
   Testy: `AgentMemory_append_perf.test.ts` (memoizacja `ensureMemoryStructure`, zimny/ciepły
   cache w `startActiveSession`, scenariusz „archiwizacja → wisząca ścieżka → append" 1:1 z
   opisu reviewera, mierzone licznikiem operacji adaptera).
15. **`writeBrainNote` samo-naprawia się PO padzie, dokładnie raz (P4, review opusa, 2026-09-02).**
   Memoizacja `_structureEnsured` (gotcha 14) kończy samonaprawę struktury W TRAKCIE sesji — jeśli
   user ręcznie skasuje `brain/` (albo cokolwiek innego z bootstrapu) po tym, jak instancja już
   raz przeszła `ensureMemoryStructure()`, kolejny zapis notatki rzucałby NA ZAWSZE, mimo że jedno
   odtworzenie folderów by go uzdrowiło. `writeBrainNote` łapie pad pierwszej próby, resetuje
   `_structureEnsured = false`, wola `ensureMemoryStructure()` (realnie odtwarza foldery) i
   próbuje DOKŁADNIE RAZ jeszcze — nie w kółko, więc trwały błąd (uprawnienia, pełny dysk) i tak
   dochodzi do wołacza jako wyjątek, zamiast zawisnąć w retry-loopie. Furtka jest WĄSKA:
   dotyczy tylko `writeBrainNote` (nazwany wprost w reviewie) — inne pisarze `brain/`
   (`MemorySaveTool`, `MemoryDeleteTool`, konsolidacja w `ArchiveWorkflow`) NIE mają jeszcze tej
   samoobrony, mimo że wołają `ensureMemoryStructure()` na tej samej memoizowanej ścieżce.
   Testy: `AgentMemory.test.ts` (pad → reset → 11+ `exists` na ponownym `ensureMemoryStructure`
   → udany retry; oraz: dwa pady pod rząd → błąd dochodzi do wołacza, zero nieskończonej pętli).
16. **`_sessionEndsWithNewline` — znane, udokumentowane ryzyko bez taniej naprawy (P5, review
   opusa, 2026-09-02).** Cache stanu „plik kończy się `\n`" (gotcha 13) jest ustawiany PO każdym
   udanym zapisie tej instancji i inwalidowany WYŁĄCZNIE przez `_forgetSessionWriterState`
   (koniec sesji — archiwizacja/odłożenie/martwa ścieżka). Jeśli plik zostanie zmieniony Z
   ZEWNĄTRZ tak, że traci końcowy `\n` (np. user otworzy go w Obsidianie i zapisze ręcznie, edytor
   przytnie białe znaki), a cache TEJ instancji wciąż mówi „kończy się `\n`" (bo była to ostatnia
   RZECZYWIŚCIE ZNANA prawda), kolejny append dokleja się BEZ wiodącego `\n` do ostatniej linii
   pliku — blok zdarzenia zlewa się z poprzednią linią i parser (`parseActiveSession`,
   `maxSeq`) może go nie rozpoznać (oczekuje nagłówka `## …` na POCZĄTKU linii). Nie ma taniego
   sposobu wykrycia tego bez pełnego odczytu treści (dokładnie to, czego AUD-wydajnosc-094 miało
   uniknąć) — periodyczna weryfikacja P2 (gotcha 13) sprawdza WYŁĄCZNIE `exists()`, nie kształt
   ostatniej linii. Świadomie NIE naprawione — zapisane tu jako znane ryzyko dla przyszłego
   czytelnika/reviewera, nie jako TODO.
17. **Znacznikiem pokrycia na szczeblach L1→L2 i L2→L3 jest PLIK NADRZĘDNY, nie stempel w źródle**
   (2026-09-04, P1 health checku 29.07 „duplikaty L1"). Do tej naprawy materiał na paczkę L2 szedł
   z gołego `_listMarkdown(paths.l1)`, a `_writeLevel2` nie kasowało plików L1 ani nie zostawiało
   na nich śladu — więc KAŻDY kolejny przebieg brał `slice(0, batchSize)` z tej samej, nigdy
   niekurczącej się listy i robił kolejne L2 z tych samych pięciu najstarszych L1 (u Borysa trzy
   L2 z identycznym `l1_files`, nowsze L1 nigdy nie awansowały). To samo piętro wyżej: L2 nie
   ubywają NIGDY (`_cleanupAfterL3` kasuje L1, L2 zostawia), więc L3 mielił w kółko tę samą piątkę.
   Dziś kandydatów odsiewają `AgentMemory.listUncoveredL1s()` / `listUncoveredL2s()` — L1, których
   nie wymienia żadne L2 we frontmatterze `l1_files:`, i L2 niewymienione w żadnym L3 (`l2_files:`).
   ⚠️ **Świadomie NIE ma stempla `covered_by_l2` w plikach L1** (mimo symetrii z `covered_by_l1`
   szczebel niżej — patrz gotcha 10). Trzy powody: (a) **crash-safety** — stempel byłby DRUGIM
   zapisem po zapisie L2, więc pad między nimi zostawiałby L2 na dysku i nieostemplowane L1, czyli
   dokładnie duplikat, który ta naprawa likwiduje; przy backlinku „zapis L2" I „oznaczenie L1" to
   JEDNA operacja atomowa (jeden `adapter.write`); (b) **zero migracji** — L2 sprzed naprawy też
   mają `l1_files`, więc stare dyski leczą się same, bez jednorazowego przeliczenia; (c) **zero
   nowych zapisów do plików pamięci usera** (lekcja incydentu 2026-07-28). Znacznik był w danych
   od zawsze — brakowało wyłącznie czytacza, dokładnie jak przy `covered_by_l1` przed 29.07.
   ⚠️ **Granica:** L2 z pustym/brakującym `l1_files` (plik ręczny albo z bardzo starej wersji) nie
   pokrywa NICZEGO — jego L1 wrócą do puli i dostaną drugie streszczenie. Pojedyncze przeliczenie
   jest tańsze niż zgadywanie pokrycia po dacie; świeże L2 wypisuje `l1_files`, więc trzeciego razu
   nie będzie. Tak samo nieczytelny plik L2/L3 nie liczy się jako pokrycie (`_getUnconsolidatedItems`
   loguje `warn` i leci dalej — plik mógł właśnie zniknąć pod kaskadą) — świadomie non-blocking,
   bo trwałe zablokowanie konsolidacji jednym uszkodzonym plikiem byłoby gorsze niż jeden duplikat.
   Strażnik: `ArchiveWorkflow_kaskada_szczeble.test.ts` (10 testów, w tym „crash w połowie" z obu
   stron zapisu i „stary dysk z duplikatami").

---

## Testy

Memory v3 critical path ma testy w:

- `modules/memory/AgentMemory.test.ts`
- `modules/tools/MemoryV3Tools.test.js`
- `modules/memory/SaveSessionWorkflow.test.ts`
- `modules/memory/ArchiveWorkflow.test.ts`
- `modules/memory/MigrationV3.test.ts`
- `modules/memory/RetrievalEngine.test.ts` (E2.6: app-first getMarkdownFiles/metadataCache + fallback)
- `modules/memory/AgentMemory_self_append.test.ts` (2026-08-27: gotcha 12 — self-append na `readIfExists`, 5 miejsc)
- `modules/memory/CostLog.test.ts` (2026-08-27: pierwszy plik testowy tej klasy, w tym self-append)
- `modules/memory/ArchiveWorkflow_kaskada_szczeble.test.ts` (2026-08-29 charakteryzacja → 2026-09-04
  naprawa: gotcha 17 — pokrycie L1→L2 i L2→L3 backlinkiem, crash z obu stron zapisu L2, stary dysk
  z duplikatami, L2 bez `l1_files`)
- `modules/memory/AgentMemory_append_perf.test.ts` (2026-09-02, fabryka wydajnosc W4 + review opusa
  tego samego dnia: gotcha 13/14/15/16 — append zamiast read+write [licznik operacji + golden
  bajtowy vs stary algorytm, w tym plik bez końcowego `\n` i plik pusty, adapter z i bez natywnego
  `append`], memoizacja `ensureMemoryStructure`, zimny/ciepły cache w `startActiveSession` (P1),
  scenariusz „archiwizacja → wisząca ścieżka → append" 1:1 z opisu reviewera (P1 BLOKER), plik
  skasowany między zdarzeniami — adapter cichy i adapter rzucający (P2). P4 (writeBrainNote
  samonaprawa) ma testy w `AgentMemory.test.ts` obok istniejących testów tej metody.

Aktualny stan (po fabryce napraw F01 runda 2, 2026-08-30): `npm test` -> `2315 tests passed` (caly
projekt, na branchu `fix/cr-F01-memory-sesje`) — liczba zweryfikowana biegiem calego `npm test`, nie
z pamieci; stara wartosc `2280` (po fali docs, 2026-08-27) byla juz nieaktualna, a `2311` (runda 1)
zostala wyprzedzona przez 4 nowe testy z rundy 2 (`save_session.noteFailures.test.ts` w
`modules/chat/` + gałąź wyczerpania sufiksów w `ArchiveWorkflow.test.ts`). E2.8 dodalo
`BrainIndex.test.ts` (Na teraz), rozszerzylo `AgentMemory.test.ts`/`SaveSessionWorkflow.test.ts`.

---

## E2.8 update (2026-07-23) — brain.md „Na teraz" + fabryki promptow roboczych

- **Sekcje „Na teraz" w brain.md (D1-D4, S22).** `brain.md` niesie teraz na GORZE dwie sekcje krotkoterminowe: `## Na teraz: User` (nad czym user pracuje DZIS) + `## Na teraz: Środowisko` (biezacy stan projektu/vaulta). To plain-text bullety zmiennego stanu, NIE linki i NIE trwale fakty. Stale w `BrainIndex.js`: `NA_TERAZ_SECTIONS`, `NA_TERAZ_MAX_ENTRIES=10` (twardy trim najstarszych + log), pure helpery `parseNaTerazSections`/`applyNaTerazOps`/`isNaTerazHeading`/`naTerazSectionKey` (eksportowane z barrela).
- **`rebuildBrainIndex` NIE gubi sekcji „Na teraz".** Parser wyciaga je ze starego pliku i przenosi na gore nowego indeksu (koniec z ladowaniem w `.bak`); `_brainHasManualContent` rozpoznaje ich naglowki + bullety jako WLASNE (nie triggeruja backupu ryzyka-A). `BRAIN_MAX_TOKENS` 350 → **600** (indeks + Na teraz musza sie zmiescic).
- **Writer `AgentMemory.writeNaTeraz(ops)`** — queued (kolejka K1), muta sekcje „Na teraz" i przebudowuje indeks. Wyjatek create-only: to JEDYNE miejsce, gdzie zapis moze dopisac/USUNAC tresc w brain.md (sekcje ulotne); notatki `brain/` pozostaja create-only. Wolane przez `MemorySaveTool` (`{ephemeral:true, section}`) + `SaveSessionWorkflow`.
- **`SaveSessionWorkflow` proponuje „Na teraz".** LLM w `/save session` moze zwrocic `na_teraz: {user:{add,remove}, environment:{add,remove}}` — modal renderuje to jako diff, zaakceptowane ops ida przez `writeNaTeraz`. `_parseNaTerazUpdates` splaszcza blok do `{section, add, remove}`.
- **`workPrompts.js` — fabryczne prompty robocze OWNED przez memory (B3).** `DEFAULT_SAVE_SESSION_PROMPT` / `DEFAULT_ARCHIVE_PROMPT` / `DEFAULT_SUMMARY_PROMPT` przeniesione tu z `modules/agents/archetypes/savePrompts.js` (zeby workflow mial wlasne defaulty bez cyklu memory→agents). Konsumowane przez resolver `resolveWorkPrompt(agent, key, settings, factory)` z `core/` — lancuch **per-agent > global (Settings→Prompt) > factory**. Swiezy agent (puste pole) dostaje dzialajaca sciezke LLM przez factory. KONTRAKT: override musi zachowac ksztalt outputu (JSON `new_notes`, `{{LEVEL}}`, `merges`/`deletions`) — parsery workflow na tym stoja. `DEFAULT_SAVE_SESSION_PROMPT` niesie tez instrukcje sekcji „Na teraz". **Czwarty prompt tej rodziny, `DEFAULT_BRIEF_PROMPT`, WYCIĘTY 2026-09-02** — patrz sekcja niżej.
- **`active_context.md` wydmuszka OUT (A4).** `AgentMemory.saveActiveContext`/`loadActiveContext` skasowane (0 wywolan) + karta `active_context` w panelu Pamiec OUT. Pliki na dysku NIE kasowane (martwe dane usera zostaja); stala sciezki `activeContext` (`this.paths.activeContext`, `AgentMemory.ts` — sciezka pliku `active_context.md`, pisana wylacznie przez `memoryWrite`) + legacy `memoryWrite`/`_appendAuditLog` (audyt ignorowanych legacy brain_update) ZOSTAJA — to osobny, zywy mechanizm.
  ⚠️ **Nie mylic z `Agent.activeContext`** (`modules/agents/Agent.ts`, pole `unknown[]` na klasie runtime agenta) — to INNY byt o tej samej nazwie, bez zwiazku z pamiecia. `Agent.activeContext` jest martwy (zapisywany raz w konstruktorze, nigdy nie czytany) i skasowany osobnym zadaniem dead-code (AUD-dead-code-064); ten wpis dotyczy WYLACZNIE sciezki pliku w `AgentMemory`.

---

## Historia

- 2026-04-23: migracja `src/memory/` -> `modules/memory/`.
- 2026-04-28: Sprint 03 Memory v2 + Retrieval v2.
- 2026-05-14: Smoke Test 01 ujawnil FIND-01, Memory v2 broken-by-design.
- 2026-05-14: Memory v3 design zalockowany.
- 2026-05-15: Sprint M3 implementuje Memory v3 przed stable v2.0.0.
- 2026-07-21: E1.1 (R0) — kasacja martwej sciezki v2. Usuniete `Archivist.js`, `MemoryExtractor.js` oraz rodzina `applyBrainUpdates` (`_applyAppend`/`_applyUpdate`/`_applyDelete`) z `AgentMemory`. `consolidateSession` (chat) nie pali juz LLM przy zamknieciu sesji; usuniete martwe UI (checkbox archiwisty w SessionCloseModal, kolumny "Legacy (ignored)" w SaveSessionModal). Wspoldzielone helpery (`_parseBrainSections`/`_buildBrainFromSections`/`_extractKeywords`/`_keywordsOverlap`/`_archiveOverflow`) zostawione — zywe (cleanupBrain/updateBrain). `BrainUpdateHistory.js` NIE skasowane: ma zywy lancuch `undoLastBrainUpdate` <- `ToolReactorRegistry` (kasacja razem z `BrainUpdateTool` w E1.6). `brain_update` wyrejestrowany z built-in serverow. Bezpieczniki: `rebuildBrainIndex` robi jednorazowy backup `brain.md.bak` gdy w brain.md sa recznie dopisane linie usera (ryzyko A); `memory_delete` matchuje juz tylko po filename/name/description, nie po calym body (ryzyko B).
  ⚠️ **Nieaktualne od dead-code sweep 2026-09-02 (AUD-dead-code-039/178/225):** `cleanupBrain` byl JEDYNYM zewnetrznym wolaczem `_extractKeywords`/`_keywordsOverlap` i mial zero wolaczy sam — grep po calym repo (produkcja + testy + harness) nie znalazl ani jednego. Skasowane razem z nim: `cleanupBrain`, `_extractKeywords`, `_keywordsOverlap` i osobno martwy `compressBrain` (jedyny wolacz zero, w trybie indeksu i tak tylko wolal `rebuildBrainIndex()`). **ZOSTAJA zywe:** `_parseBrainSections`/`_buildBrainFromSections`/`_archiveOverflow`/`updateBrain`/`memoryWrite` — wolane wprost przez `AgentMemory_self_append.test.ts` (gotcha 12, straznik klasy bledu „self-append" z incydentu 2026-07-28/2026-08-27), kasacja zabralaby pokrycie realnego bezpiecznika.
- 2026-07-21: E1.6 (R4) — rodzina `brain_update` domknieta: `BrainUpdateTool.js` + `BrainUpdateHistory.js` skasowane, alias reaktora usuniety z `ToolReactorRegistry`. `RollingWindow.js` wyprowadzony do `modules/chat/` (B4); `toolTranscriptSanitizer.js` przyszedl (B2, wspoldzielony z chat). Docs-freshness: `Co Tu Jest` + Public API zsynchronizowane ze stanem na dysku.
- 2026-07-22: E2.5 (v2.2) — `RetrievalEngine` przerobiony na silnik jednego narzedzia `search` (`runSearch()` z RRF keyword+semantic, excerpt z dysku, scope vault/memory). Skasowana dawna kaskada L1/L2/L3 + hybrid. `SearchHelper.js` (`getMemoryBase`/`searchDocs`) usuniety — zero konsumentow po kasacji `memory_sessions`/`memory_summaries`. `RetrievalEngine.test.js` (pierwsze testy silnika). Narzedzie `search` zyje w `modules/mcp/SearchTool.js`.
- 2026-07-22: E2.6 (v2.2) — `RetrievalEngine` dostal opcjonalne `app` DI: scope=vault jest API-first (`getMarkdownFiles`, `metadataCache.getFileCache` dla frontmatteru, `metadataCache.resolvedLinks` + `getFirstLinkpathDest` dla linkow, `cachedRead` dla tresci). Bez `app` — dawny walker adapterowy + reczny parser + regexy (testy mockowe bez zmian). scope=memory ZAWSZE adapter (metadataCache nie widzi `.pkm-assistant/`). `MemorySearchTools.js` skasowany — `memory_list_summaries`/`memory_read_summary` wchloniete przez narzedzia `list`/`read` (scope=memory) w `modules/mcp/`. `SearchTool` przekazuje `plugin.app` do silnika.
- 2026-07-22: E2.7 K1 (v2.2) — kolejka zapisu na `brain/`. Wszystkie zapisy `brain/*.md` + `rebuildBrainIndex()` ida teraz przez `_enqueuePathWrite` (per-sciezka, E1.3): `rebuildBrainIndex` (klucz `brain.md`), `MemorySaveTool` (create-only exists+write), `MemoryDeleteTool`, `SaveSessionWorkflow._createBrainNote` (klucz base path — suffix-safe), `ArchiveWorkflow.applyDedup` (merge + deletion), `AgentMemory.archiveBrainNote`. `StateManager` dostal wlasna kolejke RMW (`write`/`addActiveSession`/`removeActiveSession`/`markArchived` serializowane) — parallel `markArchived` nie gubi juz inkrementow. Warunek F3: kolejka PRZED zwiekszeniem czestotliwosci zapisow (K2/K3).
- 2026-07-22: E2.7 K3 (v2.2) — nowy `AgentMemory.writeBrainNote(note, {source})`: queued create-with-suffix (append `_2`/`_3` na kolizji nazwy zamiast odmowy), NIE przebudowuje indeksu (caller robi batch rebuild). Uzywany przez `chat_session._saveMemoryCandidates` (ratunek pamieci przed kompaktowaniem — modules/chat, W2).
- 2026-07-22: E2.2 (v2.2) — **`AuditLog.js` skasowany** (wydmuszka: zero call-site'ow w produkcji, eksport z `index.js` usuniety). Toggle `pkmAssistant.auditLogEnabled` w Settings zastapiony toggle'em `pkmAssistant.traceEnabled` (trace petli agenta → `.pkm-assistant/logs/trace.log`, `core/utils/TraceLog.js`). UWAGA: `AgentMemory._appendAuditLog` (pisze `audit.log` przy ignorowanych legacy brain_update) to OSOBNY, ZYWY mechanizm — NIE ruszany; `profile.memory.audit_log` (karta w profilu) tez zostaje.
- 2026-07-22: E2.7 K4 (v2.2) — **KANONICZNA SCIEZKA KONSOLIDACJI = `ArchiveWorkflow` (B).** Skasowana rownolegla sciezka (A) w `AgentMemory` (~490 LOC): `createL1/L2/L3Summary` (+ inline prompty), `consolidateLevel1/2/3`, `consolidateAll`, `_cleanupAfterL2`, `getUnconsolidatedL1s/L2s`, `_markIncludedIn`, `_wikilink`. **ZOSTAJA** (wbrew liscie w spec): `_cleanupAfterL1` + `_cleanupAfterL3` — wolane przez `ArchiveWorkflow.createLevel1/createLevel3` (kasacja by je zepsula). Zostaja tez `getUnconsolidatedSessions` (chat_ui + SlashCommandsRegistry), `_isGarbageSession`, `_getUnconsolidatedItems`, sweepy. `chat_session.consolidateSession()` (🧠 / `/memory` / SessionCloseModal „archive") **przepiete na `runSaveSessionFlow`** (SaveSessionWorkflow → SaveSessionModal → applyDecision → prog → ArchiveWorkflow) — teraz otwiera modal review zamiast cichej konsolidacji (zmiana widoczna dla usera). Sweepy `cleanupGarbageSessions`/`enforceSessionLimit` przeniesione do `ArchiveWorkflow.run()` finalu (no-op na pustym flat `sessions/` w v3). `cleanupOrphanedSummaries` **NIE** wpiety (jego orphan-check czyta flat `sessions/`, a L1/L2 (B) referencuja `sessions/archive/` → skasowalby wlasne swieze summary; „do decyzji"). Fix: `sessionTimeoutMinutes` czytany z `settings.pkmAssistant.*` (byl zly poziom) + kontrolka w Settings → Pamiec. Nowy `IdleScheduler` (W3-lite): po `idleConsolidationMinutes` (default 20, 0=off) bezczynnosci → `handleSaveSession` (bez LLM w tle na start).

## 2026-07-29 — `listArchiveSessions` niesie prawdziwą datę sesji + `covered_by_l1`

Konsolidacja L1 stempluje pliki w `sessions/archive/` (`covered_by_l1` we frontmatterze), co przestawia mtime — stare sesje pokazywały się w profilu z datą konsolidacji. `listArchiveSessions()` zwraca teraz dodatkowo `sessionTime` (ms; `created` z frontmattera, dla sesji z Claude Code składane z `date`+`time`, fallback mtime) i `covered_by_l1` (string, '' gdy brak), a sortuje po `sessionTime` zamiast mtime. UI (`profile_memory.js`) wyświetla i filtruje po `sessionTime`; badge „✓ w L1" przy pokrytych sesjach wreszcie się renderuje (wcześniej pole nie było przekazywane — wydmuszka od Sprint 03).

## A1 update (2026-07-24) — search dla admina

- `RetrievalEngine` przyjmuje `includeHiddenVault`. Zwykłe `scope:vault` pozostaje
  API-first i nie widzi dotfolderów. `SearchTool` ustawia flagę wyłącznie po
  zweryfikowanym `agent.admin_access`, wtedy kandydaci Markdown są zbierani
  adapterowym walkerem także z `.pkm-assistant`/`.obsidian`.
- Semantyczny indeks vaulta nadal nie indeksuje bebechów. Admin-search ukrytych
  plików korzysta z keyword/walkera; nie rozszerza globalnej Oramy.

## 2026-07-29 — sieroty sesji: restore czyta oba formaty + `.discarded/`

**Plik w `sessions/active/` ma DWÓCH pisarzy o różnych formatach.** `appendToActiveSession` dopisuje
event-log („format A": `## <ts> — <event_type>` + pola `**content:**`), a `saveSession` (autozapis,
idle, 💾, zamknięcie zakładki) **NADPISUJE cały plik** transkryptem `## User`/`## Assistant`
(„format B", `formatToMarkdown`). Restore rozumiał tylko A → po pierwszym autozapisie parser zwracał
0 wiadomości, `_pruneEmptyActiveSessionFromState` (modules/chat) wypisywał sesję z `.state.json` i
robiła się „sierota": pełnoprawna rozmowa, której restore już nigdy nie przywracał.

- `_parseActiveSessionFile` ma fallback: 0 wiadomości z formatu A + nagłówki transkryptu w treści →
  parsuje `parseSessionFile` (ten sam parser co `loadSession`). Plik pusty / sam frontmatter nadal
  daje 0 wiadomości — pruning naprawdę pustych wpisów zostaje.
  ⚠️ **Nieaktualne od kubełka 2 (niżej): fallback wycięty, parser jest scalony.** Fallback ratował
  tylko plik CZYSTO w formacie B — plik MIESZANY (produkcyjny) dalej gubił transkrypt.
- ⚠️ Unifikacja pisarzy (jeden format zapisu) to osobna, przyszła decyzja — tu naprawiony jest tylko
  czytnik.
- **Nowy `AgentMemory.discardActiveSession(path?)`** — odkłada aktywną sesję do
  `sessions/active/.discarded/` (kolizja nazwy → suffix `_2`) i wypisuje ją z `active_sessions`.
  Bez twardej kasacji (user authority) i **bez** podbijania licznika konsolidacji (odłożona sesja to
  nie materiał na L1). Woła to `handleNewSession` w gałęzi „odrzuć" — wcześniej zostawiała
  zombie-wpis do najbliższego restore. (⚠️ Wchodziła tędy też gałąź „draft" — **skasowana
  w S36b** razem z całą rodziną draftów, patrz sekcja na końcu pliku.)
- `listActiveSessions` bierze tylko bezpośrednie dzieci `active/` — podfolder `.discarded/` nie
  wchodzi do listy niezależnie od implementacji adaptera.

## 2026-07-29 — S29 Z1-Z3: silnik „Pulsu pamięci" (widoczność operacji w tle)

Problem: jeden cykl zapisu sesji + konsolidacji strzelał do 5× do LLM, z czego 4 strzały leciały
BEZ żadnego UI, `streamToComplete` nie miał timeoutu (zdechły stream wisiał do twardego XHR 600 s,
po czym workflow po cichu spadał na fallback regex), a `createLevel1` robił JEDNĄ paczkę na przebieg
(60 zaległych sesji = 12 ręcznych przebiegów). Spec: `Refaktor/Sprinty/S29_Puls_Pamieci_SPEC.md`.
UI (modal przebiegu, pasek statusu, notice) to osobne zadania Z4-Z6.

- **`streamToComplete(model, messages, options?)`** — trzeci argument, w pełni opcjonalny (wszystkie
  stare wywołania działają bez zmian): `onChunk(delta, response)` (znak życia; delta liczona z
  treści skumulowanej, bo chunk niesie CAŁOŚĆ), `signal` (AbortSignal), `watchdog {timeoutMs,
  onStall}`. Przerwanie idzie tą samą drogą co Stop w czacie (`chatModel.stop_stream()`), a Promise
  odrzuca się błędem z `code`: **`stream_stalled`** albo **`aborted`** (`STREAM_ERROR_CODES`).
  Dodatkowo odrzucona Promise z `.stream()` (retry-pętla adaptera potrafi odrzucić BEZ wołania
  `handlers.error`) nie wisi już w nieskończoność.
- **`StreamWatchdog` przeprowadził się `modules/chat/chat/` → `core/utils/`.** Memory nie może
  importować z modules/chat (złota zasada + realny cykl: chat importuje z memory), a klasa nie ma
  żadnych zależności. `chat_streaming.js` importuje ją z nowej ścieżki; zachowanie czatu bez zmian.
- **`ConsolidationRun.js`** — plan kroków z liczników (`buildPlan`: dedup gdy ≥2 notatki,
  `l1_batch_k` × floor(archiveCount/batchSize), L2/L3 planowane TYLKO gdy osiągalne i startujące
  z kłódką `gated`), maszyna stanów kroku (`pending → running → awaiting_review → applying → done`
  + `failed`/`skipped`/`gated`; nielegalne przejście rzuca), **retry-polityka zwisu** (`markStalled`:
  pierwszy raz `{retry:true}`, drugi → `failed`), `usage` per krok, `onChange`. Czysty node.
- **`MemoryOpsCenter.js`** — rejestr JEDNEGO aktywnego przebiegu (wzorzec `StreamingManager`).
  `startRun()` przy zajętym centrum **nie rzuca**: zwraca przebieg, który już leci, i emituje prośbę
  o modal (focus zamiast drugiego przebiegu). Rozpoznanie po tożsamości: `startRun(mój) === mój`.
- **`ArchiveWorkflow` jest dwutorowy.** Stary `run()` — BEZ ZMIAN (te same testy, ten sam modal per
  faza). Nowy tor: `runWithRun(run, {onStall, onChunk, stallTimeoutMs})` generuje propozycje
  WSZYSTKICH paczek (pętla okien po `batchSize` w posortowanym `sessions/archive`) i NIC nie
  zapisuje; `applyStepDecision(run, stepId, decision)` zapisuje po decyzji usera (odrzucenie =
  `skipped`, nie błąd); `generateGatedSteps(run)` zdejmuje kłódkę z L2 dopiero, gdy WSZYSTKIE L1 są
  rozstrzygnięte (failed ≠ rozstrzygnięty — L2 czeka na „Ponów"/„Pomiń"), a przy <`batchSize` plików
  L1 na dysku pomija L2 i L3. Fail jednej paczki nie zatrzymuje pozostałych.
- **Zapisywacze wspólne dla obu torów** (`_writeLevel1/2/3`): idą przez kolejkę per-ścieżka (E2.7 K1)
  i **odkolizjonowują nazwę** (`..._l1.md` → `..._l1_2.md`). Bez tego 12 paczek zaakceptowanych w tej
  samej sekundzie dostałoby tę samą nazwę `RRRR-MM-DD_GG-mm-ss_l1.md` i zjadłoby się nawzajem.
- **Koszt przestał być wyrzucany.** `usage` z każdego strzału idzie do kroku (`addUsage`);
  `run.totalUsage()` sumuje przebieg. `_emptyCostReport()` zostaje tylko w starym torze.
- **Timeout zwisu wspólny z czatem**: `chat_stream_stall_timeout_ms` (`config/limits.js`, default
  120 s, 0 = wyłączony). `_stallTimeoutMs()` rozumie OBA kształty settings, bo callerzy
  (`save_session.js`, `profile_memory.js`) wstrzykują podgałąź `settings.pkmAssistant`, a `getLimits()`
  czeka na pełny obiekt.
- ⚠️ **Fallback bez LLM przestał być cichy** w nowym torze: propozycja L1/L2/L3 niesie
  `llmDriven: false`, gdy poleciał deterministyczny raw-concat. Zwis i abort NIE spadają już cicho
  na fallback — lecą w górę jako błąd kroku.
### S29 Z4-Z7: UI Pulsu pamięci (2026-07-29) — czym to jest wpięte

Silnik z Z1-Z3 dostał twarz. **Produkcyjny trigger konsolidacji (próg po `/save session`) idzie
teraz NOWYM torem** — `modules/chat/consolidationRunner.js` (kontroler) buduje plan z liczników,
rejestruje przebieg w `MemoryOpsCenter`, otwiera `ConsolidationProgressModal` (modules/chat — do S31 w modules/shell) i
odpala `runWithRun` w tle. Stary `run()` NIE jest martwy: stoją na nim guziki „Podsumuj rozmowy" /
„Sumaryzuj streszczenia" w profilu agenta (`modules/agents/profile/profile_memory.js`) + testy.

- **`consolidationLabels.js` (NOWY, czysty)** — warstwa OPISOWA przebiegu: `stepLabel` (składana
  z `kind`+`index`+`total`), `stepDetail` (zakres sesji z `meta.offset`, `skipReason`, przyczyna
  padu), `stepStatusIcon`, `formatDuration`/`formatTokens`/`formatUsageLine` (koszt przez
  `estimateCostUsd` z `CostLog`), `statusBarLine`, `buildRunSummary`/`summaryToText`/`planToText`.
  Zero DOM, zero `obsidian` — test `consolidationLabels.test.js`.
  **Dlaczego w memory, a nie w UI:** ten sam przebieg opisują DWA miejsca (pasek statusu w
  `core/runtime/PluginRuntime.ts` + modal w `modules/shell`), a `core/` nie może importować z shell (cykl przez
  barrel chatu). Silnik (`ConsolidationRun`/`ArchiveWorkflow`) pozostaje **i18n-free** — to osobny,
  opcjonalny plik prezentacyjny.
- **`ConsolidationRun.beginApply` przyjmuje też `failed`** (jedyna zmiana w silniku, świadoma):
  gdy padnie SAM ZAPIS, „Ponów" w modalu powtarza ten sam zapis z tą samą decyzją usera. Bez tego
  jedyną drogą byłaby ponowna GENERACJA — kolejny strzał do LLM i edycje usera do kosza.
- **`SaveSessionWorkflow.prepareProposals(activeSession, options)`** — `options` (`onChunk`,
  `signal`, `watchdog`) idą prosto do `streamToComplete`. Dzięki temu „Anuluj" w `SaveSessionModal`
  naprawdę przerywa strzał (AbortController), modal ma znak życia z chunków, a zwis nie wisi do
  twardego XHR 600 s. ⚠️ **Zwis/abort NIE spada już cicho na regexy** — leci w górę jako błąd,
  a modal pokazuje przyczynę + „Ponów analizę". Zwykła awaria modelu (HTTP 500) nadal cicho spada
  na fallback regexowy, jak dotąd.
- **Koszt przestał być fikcją.** Na koniec przebiegu kontroler dopisuje wpis do `CostLog`
  (`role: 'memory-consolidation'`, tokeny z `run.totalUsage()`). ⚠️ Do S29 `CostLog.append` **nie
  miał ANI JEDNEGO wołacza w produkcji** — `CostTrackingModal` czytał plik, którego nikt nie pisał.
- **Pasek statusu (`core/runtime/PluginRuntime.ts`)** ma drugi kanał: „🧠 L1 — paczka 2/4 (3/7) · 38s", klik →
  `memoryOpsCenter.requestOpenModal()`. Wskaźnik gaśnie po `run_finished` (kontroler woła
  `finishRun()`, gdy `isSettled()`).

- 🔴 **Znaleziona przy okazji, NIETKNIĘTA wtopa:** `AgentMemory._cleanupAfterL1` stempluje
  `covered_by_l1` pod `paths.sessions` (płaskie `sessions/`, relikt v2), a zarchiwizowane sesje leżą
  w `sessions/archive/`. Plik nie istnieje → `continue` → stempel NIGDY nie powstaje, więc badge
  „✓ w L1" w profilu agenta nie ma z czego się wyrenderować (mimo wpisu z 2026-07-29 wyżej). Poprawka
  poza zakresem S29 (zmieniłaby zachowanie starego `run()`) — do osobnego zadania.
  ✅ **NAPRAWIONE 2026-07-29 (kubełek 2)** — patrz sekcja niżej.

## 2026-07-29 — kubełek 2 health checku: parser sesji, stempel L1, snapshot, liczniki

Pięć osobnych wtop z jednego obszaru. Wspólny mianownik: mechanizm istniał, ale nikt nie sprawdził,
czy naprawdę działa od końca do końca.

### Jeden scalony parser pliku sesji (P1 — utrata rozmowy)

Plik w `sessions/active/` ma DWÓCH pisarzy (`appendToActiveSession` = event-log „format A",
`saveSession` = transkrypt „format B", który NADPISUJE cały plik). Produkcyjna sekwencja
(append × N → autozapis → dalsze appendy) robi z pliku **mieszankę B + ogon A**. Stary
`_parseActiveSessionFile` parsował format A, a na format B spadał **dopiero przy ZERZE wiadomości**
— z pliku mieszanego zwracał sam ogon eventów, po czym pierwszy autozapis po restore nadpisywał
plik tą okrojoną wersją. **Rozmowa ginęła na stałe.**

- `_parseActiveSessionFile` robi teraz JEDEN przebieg i klasyfikuje KAŻDY blok `## …` osobno:
  (a) nagłówek ze znanej roli (`user`/`assistant`/`system`/`tool`, sprawdzany na SUROWYM nagłówku
  PRZED `_eventTypeFromHeader`) → wiadomość transkryptowa z unescape `\## `; (b) blok z polem
  eventowym (`**content:**`/`**result:**`/`**prompt:**`) → wiadomość eventowa (bez unescape);
  (c) reszta → **doklejka do treści poprzedniej wiadomości** (np. `## Wyniki` w środku odpowiedzi
  agenta; wcześniej taki blok był po cichu gubiony). Kolejność wiadomości = kolejność w pliku.
- Sklejanie dwóch parserów NIE działa: parser B wciąga bloki eventowe do treści ostatniej
  wiadomości, więc te same zdania wracałyby podwójnie. Stąd jeden przebieg.
- Kontrakt bez zmian: pusty plik / sam frontmatter → 0 wiadomości (na tym stoi pruning sierot
  w `modules/chat`). `TRANSCRIPT_ROLE_HEADER_RE` zastąpiony przez `KNOWN_ROLES` eksportowane
  z `sessionParser.js` — jedno źródło ról dla obu czytników.

### `saveSession` przez kolejkę + `created` przestało dryfować

- Cały read-modify-write idzie przez `_enqueuePathWrite` (ta sama kolejka co appendy). Wcześniej
  autozapis pisał POZA kolejką i mógł zjeść dopisane zdarzenia (albo zostać przez nie zjedzony).
- `created` we frontmatterze to znów data POWSTANIA sesji: bierzemy ją z istniejącego pliku,
  `new Date()` zostaje tylko dla nowego. Doszło pole `updated`. Wcześniej KAŻDY autozapis
  przestawiał `created` na „teraz", więc po archiwizacji sesje sortowały się datą konsolidacji.

### Stempel `covered_by_l1` wreszcie powstaje — i ktoś go czyta (P1 — duplikaty L1)

- `_cleanupAfterL1` szuka sesji najpierw w `sessions/archive/`, potem w płaskim `sessions/`
  (pozostałości v2). Zapis idzie przez kolejkę per-ścieżka, a `log.debug` leci ZAWSZE (cisza przy
  zerze była powodem, dla którego wtopa przeżyła trzy miesiące).
- `_setFrontmatterField` toleruje CRLF i BOM. Na pliku z CRLF regex frontmattera nie trafiał
  i **doklejał DRUGI blok `---`** = uszkodzony plik usera. Pliki bez frontmattera dostają go
  w całości (plik sesji to artefakt pluginu — pomijanie ich = wieczne duplikaty).
- **`AgentMemory.listUncoveredArchiveSessions()`** (nowe, w barrelu) — sesje bez stempla,
  posortowane rosnąco po nazwie. `ArchiveWorkflow` bierze z niego materiał na paczki L1 w OBU
  torach (`runWithRun`, `retryStep`, `createLevel1`) zamiast gołego listingu archiwum. Bez tego
  drugiego kroku sam stempel niczego by nie zatrzymał — nikt go nie czytał.
- ✅ **NAPRAWIONE (kubełek 2 + S30 Z7):** `modules/chat/consolidationRunner.js` liczy `archiveCount`
  z `listUncoveredArchiveSessions()` — z tej samej listy sesji NIEPOKRYTYCH, z której bierze
  materiał generator. Plan i generator patrzą na jedno źródło, więc plan nie obiecuje już paczek,
  które potem lecą jako `not_enough_sessions`. (Dawna nota o liczeniu po WSZYSTKICH plikach
  archiwum jest nieaktualna.)

### Nowy tor konsolidacji NIE robi snapshotu + retencja kopii

- `runWithRun` nie tworzy już snapshotu (`outcome.snapshotPath` i `run.meta.snapshotPath` zniknęły).
  Powód: snapshot powstawał na starcie generacji, a zapisy dzieją się po decyzjach usera — czasem
  godziny później; odtworzenie cofnęłoby bieżącą rozmowę. Operacje konsolidacji są
  create-before-delete, więc pad w połowie i tak nie gubi danych, a kopia CAŁEJ pamięci w jednym
  JSON-ie to własny punkt awarii. **Stary, blokujący `run()` snapshot + rollback ZACHOWUJE** —
  tam zapis leci od razu po propozycji.
- **`ConsolidationSnapshot.prune(keep = 3)`** — zostawia N najnowszych kopii (nazwa zaczyna się od
  ISO, więc sortowanie leksykalne = chronologiczne). Wołane na starcie `runWithRun` i po
  `snapshot.create` w `run()`, zawsze w cichym try/catch.

### Drobne, ale bolesne

- **`_generateL2Step` / `_generateL3Step` w try/catch od `startStep` do `stepProposalReady`.**
  `_collectFrontmatterList` czyta pliki POZA polityką zwisu (kaskada `_cleanupAfterL3` potrafi
  skasować L1 pod nogami) — rzut zostawiał krok w `running` na zawsze, a `memoryOpsCenter` był
  „zajęty" aż do restartu Obsidiana.
- **`_resetArchiveCounter` / `_autoBumpBrainNoteLimit` przepięte na `StateManager.update`.**
  Wołały `read()` → mutacja → `write()`, czyli odczyt poza kolejką + pełne nadpisanie; równoległy
  `markArchived`/`addActiveSession` z autozapisu czatu był cofany. `_resetArchiveCounter` odpala
  się przy KAŻDEJ zaakceptowanej paczce L1 — 12 paczek = 12 okien wyścigu.
- **`ConsolidationRun.endedAt` odmarza** przy `startStep`/`beginApply`/`ungate`. Po „Ponów"
  podsumowanie przebiegu pokazywało czas z PIERWSZEGO domknięcia.

## 2026-07-30 — D6: kasacja martwego STAREGO toru konsolidacji

Po S29 produkcja chodziła wyłącznie nowym torem, ale stary stał obok w całości — utrzymywany
przez własne testy. Klasyczna pułapka: czytający kod widział DWIE drogi i musiał zgadywać, która
jest prawdziwa. Zero produkcyjnych wołaczy potwierdzone grepem przed kasacją każdego symbolu.

**Skasowane:**

- `ArchiveWorkflow.run()` (jeden przebieg = jedna paczka L1, modal per faza, snapshot+rollback)
  + `createLevel1/2/3` + `_prompt` + opcja `modalFactory` + `_emptyCostReport` (sierota po `run()`).
- `ConsolidationSnapshot.create()` / `restore()` + prywatne `_collect` / `_ensureParent`.
  **`prune()` ZOSTAJE** — sprząta kopie zostawione przez starą wersję pluginu, woła go
  `runWithRun` na starcie.
- `AgentMemory.cleanupGarbageSessions()` / `enforceSessionLimit()` + prywatny `_isGarbageSession`.
  Wołał je wyłącznie finał `run()`, w dodatku po PUSTYM, płaskim `sessions/` (relikt v2 — w v3
  sesje żyją w `sessions/active` + `sessions/archive`). Były więc no-opem, który przy pierwszej
  zmianie ścieżki zacząłby kasować pliki usera bez pytania.
- `modules/shell/ArchiveModal.js` (cały plik + eksport z barrela + klucze i18n `modal.archive.`
  `title_*`/`subtitle_*`/`skip`/`cost_line`, pl+en). **`archiveReviewRenders.js` ZOSTAJE** —
  rendery review dzieli z `ConsolidationProgressModal`, razem z resztą kluczy `modal.archive.*`.

**Testy:** przypadki testujące sam stary tor usunięte; te, które używały `createLevelN` tylko jako
WEHIKUŁU do logiki wspólnej (`_summaryFromFiles`: `{{LEVEL}}`, ogrodzenia ```, fallback
raw-concat; kaskada `_writeLevel2/3`; auto-bump progu po odrzuceniu scaleń) — **przepisane na
wejście przez logikę wspólną albo nowy tor, z tymi samymi asercjami.** Nic z pokrycia nie zginęło.

**D6b (2026-07-30):** `cleanupOrphanedSummaries` SKASOWANY tą samą kuracją (werdykt Kuby:
znaleziska naprawiamy od razu) — zero wołaczy, a orphan-check czytał płaskie `sessions/`
(w v3 puste), więc wpięty skasowałby wszystkie świeże L1. Ewentualne przyszłe sprzątanie
sierot L1/L2 = nowy kod na `sessions/archive/` + stemplach, nie wskrzeszanie tego.

## 2026-07-30 — Z6/Z4.3: retencja archiwum sesji + koszt `/save session`

### `AgentMemory.pruneArchive({days, maxFiles})` — jedyna droga kasowania sesji z archiwum

- **Kandydaci = WYŁĄCZNIE sesje z niepustym `covered_by_l1`.** Sesja bez stempla to jedyny materiał
  na przyszłe paczki L1 (`listUncoveredArchiveSessions`) i jedyna pełna kopia rozmowy — nie ginie
  ani po limicie dni, ani po limicie plików. Stempel powstaje dopiero PO zapisaniu L1 na dysku
  (`_cleanupAfterL1`), więc kasowanie nigdy nie wyprzedza streszczenia (create-before-delete).
- `days > 0` — kasuje kandydatów starszych niż N dni po **realnej dacie sesji** (`sessionTime`
  z frontmattera, nie mtime — mtime przestawia sam stempel). Sesja o dacie nieustalonej (brak
  `created`, brak `stat`) NIE jest uznawana za starą.
- `maxFiles > 0` — limit liczy WSZYSTKIE pliki archiwum, ale kasuje tylko kandydatów, od
  najstarszego. Gdy samych niepokrytych jest więcej niż limit, limit zostaje przekroczony
  (świadomie — dane usera > liczba w ustawieniach).
- `0`/brak dla obu = natychmiastowy `{removed: 0}`. Best-effort per plik, **nigdy nie rzuca**
  (wzór `ConsolidationSnapshot.prune`). Wpięte w `ArchiveWorkflow.runWithRun` obok
  `snapshot.prune()`, w cichym try/catch; konfig z `_retentionConfig()` (rozumie oba kształty
  settings — płaski `pkmAssistant` i pełny obiekt, jak `_stallTimeoutMs`).
- UI: Settings → Pamięć → „Retencja archiwum: dni" / „…: max plików" (default 0).
  🔴 **Pole „Zachowaj ostatnich sesji po L1" (`keepRecentSessions`) WYCIĘTE** — po kasacji starego
  toru (D6) nie miało ANI JEDNEGO konsumenta, czyli obiecywało zachowanie, którego nie było.
  Świadomie NIE przepięte na retencję: jego default `3` znaczyłby „skasuj wszystko poza trzema"
  przy pierwszym przebiegu. Klucze i18n `settings.keep_sessions*` skasowane (pl+en).
  🔴 Tym samym cięciem poszedł DRUGI duch: pole „Próg L3" (`l3Threshold`) — zero konsumentów
  (o kadencji L2→L3 decyduje wyłącznie `batchSize` w `buildConsolidationPlan`); pole obiecywało
  kontrolę, której nie było. Osierocona wartość w settings userów jest nieszkodliwa.

### `/save session` wreszcie widoczny w koszcie (Z4.3)

`streamToComplete` w `proposeBrainUpdatesViaAgent` oddawał `usage` do kosza. Teraz propozycja niesie
pole `usage` (surowe, `null` na ścieżce regexowej), `prepareProposals` przekazuje je dalej, a
`modules/chat/slash-commands/save_session.js` dopisuje JEDEN wpis do `CostLog`
(`role: 'save-session'`) zaraz po udanej analizie — tokeny spalają się niezależnie od tego, czy user
zatwierdzi notatki. Bez delty (jedno wywołanie LLM ≠ przebieg konsolidacji, który domyka się kilka
razy). ⚠️ Nieudane próby w pętli „Ponów analizę" nie mają `usage` (strzał padł), więc do dziennika
trafia tylko ostatnia, udana — świadome zaniżenie zamiast infrastruktury do liczenia padów.

## 2026-07-30 — S32 Z1b: `brain.log`, kronika zapisów do pamięci trwałej

Zapis do pamięci był NIEWIDZIALNY: notatka pojawiała się w `brain/`, ale user nie miał jak
sprawdzić kiedy powstała ani kto ją tam wsadził (agent sam? `/save session`? konsolidacja?).

- **`AgentMemory.appendBrainLog(op, target, detail='')`** — dopisuje jedną linię TSV
  (`ISO \t op \t target \t detail`) do `<basePath>/brain.log`, przez kolejkę per-ścieżka
  (E2.7 K1). Tabulatory i złamania linii w polach → spacje, żeby jeden wpis nie rozjechał się
  na dwa wiersze. **BEST-EFFORT: nigdy nie rzuca** (zwraca `false` przy padzie adaptera) —
  kronika nie ma prawa wywalić zapisu notatki, który właśnie się udał.
- **`parseBrainLog(text, limit=50)`** — czysta funkcja (eksport z `AgentMemory.js` + barrel),
  zwraca `{ts, op, target, detail}` OD NAJNOWSZEGO. Linia w nieznanym kształcie NIE jest
  wyrzucana (brakujące pola = puste stringi) — log jest append-only przez różne wersje pluginu.
- ⚠️ **To NIE `audit.log`.** Tamten to osobny, żywy mechanizm legacy (`_appendAuditLog` loguje
  IGNOROWANE stare `brain_update`) i został **nietknięty**. W profilu agenta są teraz dwie karty
  i muszą znaczyć różne rzeczy.
- **Wpięte tam, gdzie pamięć trwała REALNIE się zmienia** (`op`):
  - `create` — `AgentMemory.writeBrainNote` (ratunek pamięci z czatu), `SaveSessionWorkflow._createBrainNote`
    (detail `save_session` — od AUD-code-review-067/068, 2026-08-30: metoda deleguje do
    `writeBrainNote(note, { source: 'save_session' })` zamiast reimplementować zapis, patrz gotcha 7),
    `modules/tools/MemorySaveTool` (detail `memory_save`). ⚠️ **Nie ma jednej wspólnej metody tworzącej
    notatkę** — trzy ścieżki piszą adapterem wprost, więc są trzy wpięcia.
  - `na-teraz` — `writeNaTeraz`, po jednym wpisie na ruszoną sekcję i **tylko gdy plik się zmienił**
    (`result.changed`; „usuń wpis, którego nie ma" nie jest zdarzeniem).
  - `merge` / `delete` — `ArchiveWorkflow.applyDedup` (dedup pisze bezpośrednio, nie przez metody
    `AgentMemory`, więc wpis powstaje tam).
  - `archive` — `AgentMemory.archiveBrainNote` (z powodem archiwizacji w `detail`).
  - **Odczytów NIE logujemy.** Log ma pokazywać zmiany, nie ruch.
- Testy: 8 nowych w `AgentMemory.test.js` (roundtrip, limity/puste linie/wpis-kaleka, brak rzutu
  przy padzie adaptera, wpięcia w `writeBrainNote`/`writeNaTeraz`/`archiveBrainNote`).

## 2026-07-30 — S36 Faza 1: kontrakt pliku `sessions/active` w JEDNYM pliku + escapowanie pisarza A

Kroki **1+5+6** z `Refaktor/Decyzje_Sesji/2026-07-30_d6_raport.md` §6 — bezpieczna baza pod
przełączenie pisarzy (Faza 2). Zachowanie NIETKNIĘTE poza jedną rzeczą: escapowaniem `## `.

- **`activeSessionFormat.js` (NOWY, czysty node, NIE w barrelu)** — kontrakt pliku aktywnej sesji
  przestał być rozsmarowany po trzech miejscach. Eksporty: `ACTIVE_SESSION_FORMAT_VERSION = 1`,
  `escapeActiveText`/`unescapeActiveText`, `formatSessionEvent` (pisarz A, event-log),
  `parseActiveSession` (czytnik formatu A + B + plików MIESZANYCH — logika przeniesiona 1:1
  z `AgentMemory._parseActiveSessionFile`), `KNOWN_ROLES`, `parseFrontmatter`.
  `AgentMemory._formatSessionEvent` / `_parseActiveSessionFile` / `_parseFrontmatter` **zostają
  jako delegacje** (wołacze i testy bez zmian; ⚠️ `_formatSessionEvent` skasowana w Fazie 2 —
  patrz sekcja niżej); prywatne `_eventTypeFromHeader`,
  `_extractActiveEventField`, `_roleFromActiveEvent`, `_parseFrontmatterScalar` **usunięte
  z AgentMemory** (zero innych wołaczy, potwierdzone grepem) — mieszkają w nowym pliku.
- 🔴 **Pisarz A wreszcie escapuje.** `formatSessionEvent` przepuszcza treść KAŻDEGO pola (po
  ewentualnym `JSON.stringify`) przez `escapeActiveText`. Dotąd nie escapował NICZEGO, więc
  `## User` w cytowanym tekście (albo markdown `## ` w `**result:**` narzędzia) rozbijał
  wiadomość na dwie przy odczycie. Lustrzanie: gałąź (b) czytnika (pola `**content:**` /
  `**result:**` / `**prompt:**`) robi teraz `unescapeActiveText`. Na legacy blokach (nigdy nie
  escapowanych) unescape jest no-opem — wsteczna zgodność pilnowana testem.
  Nagłówek bloku (`## <ISO> — <typ>`) NIE jest escapowany: to nasza własna linia, `type` idzie
  z kodu. Gałęzie (a) transkrypt i (c) doklejka — BEZ ZMIAN.
- **Jedno źródło pary regexów.** `sessionParser.js` nie ma już własnej kopii escape/unescape ani
  własnego `KNOWN_ROLES` — importuje je z `activeSessionFormat.js` i re-eksportuje `KNOWN_ROLES`
  (konsumenci nie zauważyli przeprowadzki). Kierunek: `sessionParser → activeSessionFormat`,
  bez cyklu.
- **`activeSessionFormat.test.js` (NOWY, 15 testów; po Fazie 2 — 22)** — test kontraktowy, którego brak pozwolił
  przeżyć wtopie z `71a4ffe`: round-trip `formatSessionEvent × N → parseActiveSession` na
  mieszance typów zdarzeń (treść z `## User`/`## Wyniki`, `mcp_call` z pustym wynikiem,
  `tool_result` z markdownem, `subagent_call` prompt+result), plik MIESZANY
  (`formatToMarkdown` + ogon eventów), LEGACY event-log bez escapów, CRLF, kontrakt
  „pusty plik → 0 wiadomości", para escape/unescape, strażnik round-tripu `sessionParser`.
- ⚠️ **ZNANA, ŚWIADOMA STRATA (dziedziczona po pisarzu B, nie wprowadzona tutaj):** schemat nie
  escapuje samego backslasha, więc treść z LITERALNYM `\## ` na początku linii wraca z odczytu
  jako `## `. `formatToMarkdown` ma to od zawsze; teraz dotyczy też pisarza A. Przypięte osobnym
  testem, żeby nikt nie odkrył tego przypadkiem. Naprawa = zmiana formatu po stronie B
  (i odczytu starych plików), więc świadomie POZA zakresem Fazy 1.
  Skutek: istniejąca asercja w `AgentMemory.test.js` („event zostawia treść surową") była
  utrwaleniem starej wady i **została przepisana** na to, co naprawdę ma działać — treść
  z `## ` w środku wraca verbatim z OBU formatów.

## 2026-07-30 — S36 Faza 2: event-log JEDYNYM pisarzem pliku active

Kroki **2+3** z `Refaktor/Decyzje_Sesji/2026-07-30_d6_raport.md` §6 (+ domknięcie znaleziska
Fazy 1). Sedno: `saveSession` (autozapis co N minut, idle, 💾, zamknięcie zakładki) NADPISYWAŁ cały
plik aktywnej sesji transkryptem z `rollingWindow.messages` — ścinał telemetrię narzędzi dopisaną
przez `appendToActiveSession`, a **po kompresji okna czatu (która ZMNIEJSZA `messages`) niszczył
pełną historię rozmowy**. Teraz plik jest append-only event-logiem, a transkrypt to widok pochodny.

### `**seq:**` — numeracja zdarzeń w pliku

- `formatSessionEvent` dopisuje pole `**seq:**` (tylko dla liczby; NIE przechodzi przez escape —
  to nasza liczba, nie treść). `parseActiveSession` niesie ją dalej: **każda wiadomość ma teraz
  pole `seq`** (liczba dla bloku eventowego, `null` dla transkryptu i bloków legacy). Rozszerzenie
  ADDYTYWNE — `_restoreActiveSession` (modules/chat) robi `addMessage(role, content)` i nie
  wymagał zmian.
- ⚠️ **`seq` numeruje ZDARZENIA, nie wiadomości.** Blok bez treści (np. `mcp_call`, którego
  narzędzie zwróciło pustkę) zjada numer, ale nie jest wiadomością — w widocznych wiadomościach
  są więc dziury. Tak ma być.
- Numer nadawany jest **WEWNĄTRZ kolejki per-ścieżka** (`_nextSeq(path, existingContent)`) na
  treści właśnie odczytanej z dysku — inaczej dwa równoległe appendy (sub-agenci przez
  `Promise.all`) dostałyby ten sam numer. Cache `_sessionSeqCache` (Map po ścieżce) trzyma ostatni
  numer w pamięci; cache-miss (pierwszy zapis albo restart Obsidiana) inicjalizuje licznik skanem
  pliku przez `maxSeq()`. `archiveActiveSession`/`discardActiveSession` czyszczą stan
  (`_forgetSessionWriterState`).
- `maxSeq()` wymaga BLOKOWEGO kształtu pola (etykieta sama w linii, wartość niżej), więc linia
  `**seq:** 999` wklejona w treść wiadomości nie podbija licznika.

### `saveSession` DOPISUJE, nie nadpisuje

1. Czyta plik, `K = parseActiveSession(...).messages.length`.
2. Ogon = `messages.slice(base)` **tylko gdy `messages.length > base`**; każda wiadomość ogona idzie
   jako EVENT formatu A (`user→user_message`, `assistant→agent_message`, `tool→tool_result`,
   `system→system_message`, treść zawsze w `**content:**`). Niepusty ogon = `log.warn` z liczbą —
   znaczy, że pisarz zdarzeń coś przegapił, i ma to być widoczne.
3. `messages.length <= base` → **treści nie ruszamy w ogóle**. Kompresja okna zmniejsza `messages`;
   plik jest nadzbiorem i ma nim zostać.
4. Frontmatter: ruszamy WYŁĄCZNIE `updated` (=teraz) i `messageCount` (=K+ogon), przez
   `_setFrontmatterField` (CRLF/BOM-safe; plik bez frontmattera dostaje go w całości).
   `created` — nietknięte (data POWSTANIA sesji, kubełek 2).
5. Nowy plik dostaje frontmatter + nagłówek jak w `startActiveSession`, a wiadomości od razu jako
   eventy; `metadata.created` od wołacza wygrywa z „teraz" (przypięte testem — wcześniej klucz stał
   PO spreadzie `...metadata` i data przepadała). ⚠️ Przykładem był tu `promoteDraft` — **skasowany
   w S36b**; żywy wołacz podający `created` to `handleSaveSession` (modules/chat).
- ⚠️ **`base = max(K, _sessionSavedCounts[path])` — świadome odstępstwo od spec.** Event-log jest
  tylko CZĘŚCIOWO wyrównany z okienkiem czatu: odpowiedź modelu będąca samym wywołaniem narzędzia
  ma pustą treść, a **blok bez treści nie jest dla czytnika wiadomością** (`## <ISO>` bez
  `**content:**` jest pomijany). Samo `slice(K)` dopisałoby więc te same zdania drugi raz przy
  następnym autozapisie. Licznik pokrycia idzie tylko w górę i woli POMINĄĆ dopisek (pisarz A i tak
  zapisuje wszystko) niż zdublować treść. `messageCount` liczy się dalej od `K`, nie od `base` —
  frontmatter ma mówić prawdę o pliku.
- ⚠️ Mapowanie indeksowe `slice` jest z natury przybliżone (po kompresji pierwszą pozycją okna jest
  streszczenie, nie wiadomość #1) — dlatego to SIATKA BEZPIECZEŃSTWA, nie źródło prawdy. Źródłem
  prawdy jest event-log.

### `archiveActiveSession` konwertuje event-log → transkrypt

- Czyta plik, `parseActiveSession`, i zapisuje do `sessions/archive/` wynik
  `formatToMarkdown(messages, meta, summary)`. `meta` = frontmatter z pliku (skalary 1:1 —
  `agent`/`created`/`type`/`sessionType`...), `updated`=teraz, `messageCount`=liczba wiadomości.
  Wartości nie-skalarne są pomijane: `formatToMarkdown` serializuje przez `${value}`, więc tablica
  rozjechałaby YAML.
- Plik, z którego czytnik nie wyciągnął ANI JEDNEJ wiadomości (pusty, sam frontmatter, nieznany
  kształt) → **kopia surowa 1:1**, jak dotąd. Nie tracimy bajtów, których nie rozumiemy.
- ⚠️ **Telemetria (`**tool:**`/`**args:**`/`**model:**`) NIE wchodzi do archiwum** — transkrypt
  ma role i treści. Wyniki narzędzi zostają (jako wiadomości `## Tool`), sam fakt wywołania nie.
  Świadome: archiwum to materiał dla konsolidacji, a jej format ma zostać nietknięty.
- Format `sessions/archive/` bez zmian → konsolidacja L1/L2/L3, `parseSessionFile`, `loadSession`
  i retencja (`pruneArchive`) NIETKNIĘTE.

### Domknięcie dziury separatora pól (znalezisko Fazy 1)

Treść zawierająca linię `**result:**` UCINAŁA pole przy odczycie — ta sama klasa błędu co `## `.

- `EVENT_FIELDS` jest teraz EKSPORTOWANE i służy trzem rzeczom: kolejność pól w
  `formatSessionEvent`, escape linii treści udających etykietę, lookahead kończący pole
  w `extractEventField`. Żadnej kopii — rozjazd = ucięta treść.
- Pisarz: `escapeEventFieldText` = `escapeActiveText` (`## `) + escape linii będącej DOKŁADNIE
  etykietą znanego pola (`**result:**` → `\**result:**`). Czytnik odkręca w odwrotnej kolejności:
  `extractEventField` robi `unescapeEventFieldLabels`, a `parseActiveSession` na końcu
  `unescapeActiveText`.
- ✅ **Skutek uboczny — poprawa dla plików legacy:** lookahead był `\n\*\*[^*]+:\*\*`, czyli KAŻDA
  bold-etykieta kończyła pole. `**Uwaga:**` w odpowiedzi modelu obcinało resztę wiadomości. Teraz
  kończą tylko ZNANE etykiety stojące same w linii, więc stare pliki czytają się PEŁNIEJ.
- `ACTIVE_SESSION_FORMAT_VERSION` → **2** (doszło pole + nowa reguła escapowania). v2 czyta v1
  i legacy identycznie jak dotąd — pliki usera muszą się czytać na zawsze.
- ⚠️ Nowy escape dziedziczy ZNANĄ STRATĘ schematu (nie escapujemy samego backslasha): treść
  z literalnym `\**result:**` wraca z odczytu jako `**result:**`, dokładnie jak `\## ` → `## `.
  Przypięte testem, żeby nikt nie odkrył tego przypadkiem.

### Przy okazji

- **`_restoreActiveSession` (modules/chat) — gałąź awaryjna przepięta na `loadActiveSession`.**
  Gdy `listActiveSessions` nic nie zwróci, fallback bierze ścieżkę z `restoreActiveSession()`
  (plik z `sessions/active/`!) i czytał ją `loadSession` → `parseSessionFile`, czyli parserem
  TRANSKRYPTU. Po Fazie 2 wyciągnąłby z event-logu ZERO wiadomości i restore po cichu by się nie
  odbył. `loadSession` w pozostałych wołaniach (`handleLoadSession`) zostaje — tam naprawdę lecą
  pliki transkryptowe. (Drugim takim wołaczem był `loadDraft` — **skasowany w S36b**.)
- **`AgentMemory._formatSessionEvent` SKASOWANA** — delegacja do `formatSessionEvent` została po
  Fazie 1 z zerem wołaczy (numeracja przeniosła wywołanie do wnętrza kolejki). Grep po repo
  potwierdzony przed kasacją. `_parseActiveSessionFile` i `_parseFrontmatter` ZOSTAJĄ (mają
  wołaczy).
- **Test, który utrwalał starą wadę, przepisany:** `loadActiveSession reads a session overwritten
  by saveSession (transcript format)` asertował, że autozapis NADPISUJE plik (`## Assistant`
  w pliku active) — czyli dokładnie zachowanie, które gubiło rozmowy. Zastąpiony przez
  `saveSession NIE nadpisuje pliku transkryptem — dopisuje tylko brakujący ogon`. Pokrycie
  czytnika plików MIESZANYCH nie zginęło: stoi na osobnym teście z plikiem pisanym ręcznie
  (`loadActiveSession czyta plik MIESZANY...`) — i tak ma zostać na zawsze.

## 2026-07-30 — S36b: kasacja martwej rodziny draftów (`.draft/`)

Faza 2b handoffu S36. Rodzina draftów była martwa **od Memory v3 (Sprint M3)**: obie drogi powrotne
z draftu — `_checkRecoverableDrafts` przy starcie pluginu i slash `/drafts` — nigdy nie powstały
(zweryfikowane w S30 Z4). Zostało zaplecze, które **pisało pliki, których NIC nie czytało**, i guzik
w `SessionCloseModal` obiecujący userowi, że szkic da się odzyskać. Zero produkcyjnych wołaczy
potwierdzone grepem per symbol przed kasacją (wzór D6).

**Skasowane z `AgentMemory`** (~118 LOC): `saveDraft` · `listDrafts` · `loadDraft` · `discardDraft` ·
`promoteDraft` + ścieżka `paths.draft` (`<basePath>/.draft`, zero innych czytelników; NIE była
w `ensureMemoryStructure` — folder powstawał leniwym mkdir w `saveDraft`).

**Dowody braku wołaczy:** `promoteDraft` — tylko własna definicja + 1 test; `loadDraft`/
`discardDraft` — wołane WYŁĄCZNIE przez `promoteDraft`; `listDrafts` — zero wołaczy w ogóle
(`DraftsListModal` dostawał gotową listę w `opts` i nikt go nie tworzył); `saveDraft` — jeden
produkcyjny wołacz, gałąź „draft" w `chat_session.handleNewSession`, skasowana tym samym cięciem.

**Poza pamięcią** (patrz `modules/shell/CLAUDE.md` + `modules/chat/CLAUDE.md`): `DraftsListModal.js`
w całości, opcja `'draft'` w `SessionCloseModal`, gałąź „draft" w `handleNewSession`, klucze i18n
`modal.drafts_list.*` / `modal.session_close.draft*` / `chat.session.draft_saved` (pl+en) i blok CSS
`.cs-drafts-list*`.

**Test przepisany, nie skasowany.** `AgentMemory.promoteDraft zachowuje date POWSTANIA draftu`
(S30 Z7) asertował ŻYWĄ logikę `saveSession` — że `created` podane przez wołacza wygrywa z „teraz"
przy zakładaniu NOWEGO pliku (klucz stoi PO spreadzie `...metadata`). Draft był tylko WEHIKUŁEM,
więc test wchodzi teraz przez `saveSession` wprost, z tą samą asercją.

⚠️ **Pliki draftów leżące u userów w `.draft/` NIE są kasowane** (dane usera — user authority).
Po prostu nie powstają nowe. Flow `.discarded/` (`discardActiveSession`, gałąź „odrzuć") NIETKNIĘTY.

## 2026-07-31 — TS-2: caly `modules/memory/` na TypeScripcie

Fala TS-2 kampanii TypeScript (kontrakt: `Refaktor/Decyzje_Sesji/2026-07-30_ts0_raport.md`).
W module nie zostal ani jeden plik `.js` — 34 pliki (17 zrodel + 17 testow) sa w `.ts`, `strict`,
**zero `any`**. Zero zmian runtime'u: bundle zminifikowany ma ten sam rozmiar co przed fala,
a diff bundla NIEZMINIFIKOWANEGO to wylacznie komentarze i banery sciezek modulow.

Co trzeba wiedziec przy edycji:

- **Specifiery importow ZOSTAJA z `.js`** (`from './AgentMemory.js'` wskazuje `AgentMemory.ts`).
  Nie „naprawiac" ich na `.ts` — esbuild i tsx podstawiaja rozszerzenie same, a `no-restricted-imports`
  w `eslint.config.js` jest przypiety do `.../index.js`.
- **Pola klas bez inicjalizatora deklarujemy `declare`** (`declare vault: MemoryVaultLike;`).
  Zwykla deklaracja przy `useDefineForClassFields: true` kazalaby esbuildowi wyemitowac realne
  puste pole — czyli ZMIENIC runtime.
- **Typ opisuje kod, nie poprawia go.** W blokach `catch` zostaje `(e as ErrLike).message` — bez
  dokladania `?.`; `String(...)`, `|| null` i zmienne posrednie sa zakazane, bo zmieniaja emit.
  Kontrakty modulow, ktore sa jeszcze w JS (chat, shell, tools), typujemy strukturalnie (`type XLike`).
- **Barrel eksportuje typy.** `index.ts` ma obok listy wartosci (bez zmian) blok `export type { … }`
  — znika przy transpilacji, wiec zero wplywu na bundle. Konsumenci biora typy stad, nie z bebechow.
  Kontrakt pliku `sessions/active/*.md` (`activeSessionFormat.ts`) swiadomie NIE wychodzi — jest wewnetrzny.
- **`RetrievalEngine._defaultParseFrontmatter` ma `this: void`** — uczciwa deklaracja, ze metoda nie
  dotyka `this` (konstruktor podaje ja jako goly callback). Parametr `this` znika przy transpilacji.

## 2026-08-15 — incydent „AKTYWNY TEST": rebuild zachowuje sekcje spoza katalogu zarzadzanych

Recznie dopisana sekcja `## AKTYWNY TEST` w brain.md Kustosza (kontrakt trybu testowego CC↔plugin)
zniknela po `memory_save` z sesji pluginowej (~17:11). Mechanizm: KAZDY `rebuildBrainIndex`
(wolany przez `memory_save`, `writeNaTeraz`, `memory_delete`, `/save session`, archiwizacje notatki)
odtwarzal brain.md WYLACZNIE z „Na teraz" + metadanych `brain/*.md` — nieznana sekcja byla wycinana,
a bezpiecznik E1.1 odkladal ja do `brain.md.bak` **po cichu** (user nie wie, ze .bak istnieje).
Obietnica „brain.md niedestrukcyjny" byla wiec spelniona tylko w polowie: dane nie ginely, ale
znikaly z pliku, ktory user swiadomie edytowal.

- **`parseForeignSections(content)` (BrainIndex, czysty)** — wyciaga kazda sekcje H2, ktorej
  naglowek nie jest ani sekcja indeksu (`INDEX_SECTIONS`, exact match), ani „Na teraz"
  (`isNaTerazHeading`). Body verbatim (surowe linie az do nastepnego H2, w tym `###` podsekcje;
  koncowe puste linie uciete dla idempotencji). NIE w barrelu — konsument to `rebuildBrainIndex`.
- **`buildBrainIndex({ ..., foreign })`** emituje te sekcje verbatim NA KONCU pliku (pod indeksem),
  z zachowaniem kolejnosci wzglednej. Skutek uboczny: reczna sekcja dopisana na gorze pliku
  po pierwszej przebudowie WEDRUJE na dol — swiadomy koszt minimalnego fixa.
- **`_brainHasManualContent` przestrojony strefowo** (`managed`/`na_teraz`/`foreign`): linie sekcji
  obcych NIE triggeruja juz `.bak` (nic nie ginie), ale reczne linie w sekcjach ZARZADZANYCH
  (np. goly bullet w `## User`) nadal sa wycinane i nadal robia `.bak` — ta czesc kontraktu
  bez zmian.
- Testy: 3 nowe pure w `BrainIndex.test.ts` + 4 w `AgentMemory.test.ts` (rebuild zachowuje sekcje
  bez `.bak`; sciezka incydentu `writeNaTeraz`; idempotencja drugiej przebudowy; wspolistnienie
  sekcji obcej z reczna linia w zarzadzanej → `.bak` nadal dziala).
- Raport incydentu: `Refaktor/Decyzje_Sesji/2026-08-15_incydent_brain_aktywny_test.md`.
  Dane Kustosza NIE zginely — `brain.md.bak` z 17:11 trzyma oryginalna sekcje.

## K12 update (2026-08-23) — pliki sesji maskowane PRZY ZAPISIE

**Gotcha:** pliki sesji są maskowane przy zapisie; sekret, który trafił do transkryptu,
nie ląduje na dysku w czystej postaci.

- **Jeden pisarz: `AgentMemory._writeSessionFile(path, content)`.** Przez niego idzie
  KAŻDY zapis pliku sesji: `startActiveSession`, `appendToActiveSession` (event-log),
  `saveSession` (siatka bezpieczeństwa), `archiveActiveSession`, `discardActiveSession`
  i migracja płaskiego `sessions/` → `sessions/archive`. Writer robi jedno:
  `adapter.write(path, maskSensitiveData(content))`.
- **Maskujemy WYŁĄCZNIE string idący na dysk.** Obiekty wiadomości w pamięci zostają
  nietknięte — model w tej samej turze ma dalej widzieć to, co naprawdę wróciło z narzędzia.
  Maska ma zmieniać ZAPIS rozmowy, nie jej przebieg.
- **Zakres jest świadomie WĄSKI:** `brain*`, `summaries/L1..L3` i `.state.json` mają
  własnych pisarzy i przez ten writer NIE przechodzą.
- **Dlaczego:** K8 (AUD-security-029) wypchnął `.pkm-assistant/agents/*/memory/sessions/`
  do `.gitignore` vaulta, bo transkrypt potrafi nieść sekret wpleciony w treść błędu
  (padnięty strumień wypisuje nagłówki żądania). Skutek uboczny: pamięć agentów przestała
  podróżować między urządzeniami (laptop ↔ chmura ↔ telefon, przez repo vaulta). Decyzją Kuby
  (2026-08-23) sesje WRACAJĄ do gita, a ryzyko zdejmujemy u źródła. `maskSensitiveData` jest
  idempotentna (K8), więc wielokrotne przepisywanie tego samego pliku niczego nie psuje.
- ⚠️ Plugin **nie usuwa** wpisu `.gitignore`, który już dopisał — kto ma go po K8, kasuje
  linię `.pkm-assistant/agents/*/memory/sessions/` ręcznie.

Strażnicy: `modules/memory/AgentMemory.test.ts` — 4 testy K12 (zapis sesji, dopisek do
event-logu, archiwizacja, brak rozlania maski na `brain.md`).

## 2026-08-30 — fabryka napraw F01 (klaster code-review): sesje aktywne + pisarze notatek

Osiem znalezisk z biegu code-review 2026-08-30 (`AUD-code-review-007/008/009/010/051/067/068/069`),
wszystkie w `activeSessionFormat.ts`, `AgentMemory.ts`, `SaveSessionWorkflow.ts`, `ArchiveWorkflow.ts`.

- **007 (CRITICAL, dwie części).** `extractEventField` (`activeSessionFormat.ts`) szukał etykiety
  pola BEZ kotwicy `^`/`\n` i z flagą `i` — etykieta pola WCZEŚNIEJSZEGO w `EVENT_FIELDS` (np.
  `content`) osadzona w treści pola PÓŹNIEJSZEGO (np. `result`) wygrywała wyścig o pierwszeństwo,
  a wielkość liter inna niż kanoniczna etykieta w ogóle nie chroniła treści (pisarz escapuje tylko
  dokładny, małoliterowy kształt). Naprawa: kotwica `(?:^|\n)` + brak flagi `i` — TA SAMA reguła
  co `FIELD_LABEL_LINE_RE` (escape pisarza). Część 2: `archiveActiveSession` kasowała źródło zaraz
  po `write()` archiwum, bez potwierdzenia, że bajty realnie doszły (torn write na dyskach
  sieciowych/Dysku Google) — dziś odczyt przez `readIfExists` porównuje treść PO
  `maskSensitiveData` z zapisanym `output`; niezgodność = throw, źródło ZOSTAJE.
- **008 (HIGH → potencjalnie CRITICAL na kolizji).** `ArchiveWorkflow.applyDedup` pisał scalenie
  pod `targetPath` bez sprawdzenia kolizji — notatka SPOZA `sources` o tej samej (albo po 80-znakowym
  obcięciu tej samej) nazwie ginęła bez `.bak` i bez wpisu `delete` w `brain.log`. Dziś: kolejne
  sufiksy `_2`/`_3`… przez `probeFile`, ale TYLKO gdy kolidujący plik nie jest jednym ze `sources`
  (wtedy to legalne — scalenie zajmuje miejsce własnego źródła, jak dotąd).
- **009 (HIGH).** `saveSession` bez ustawionej `activeSessionPath` (np. po `handleLoadSession`,
  który świadomie NIE ustawia wskaźnika) zakładała plik pod płaskim `paths.sessions` — relikt v2,
  który `_migrateLegacyRootSessionsToArchive` natychmiast przenosił do `sessions/archive/` jako
  sesję ZAMKNIĘTĄ. Dziś ta gałąź rezerwuje ścieżkę w `sessions/active/` (ten sam
  `_generateActiveSessionFilename` + pętla `probeFile` co `startActiveSession`, plus rejestracja
  w `.state.json`), a resztę zapisu (frontmatter z `metadata`, `sessionType`) robi bez zmian kod
  niżej — nie wołamy `startActiveSession()` wprost, żeby nie stracić `metadata.created` wołacza.
- **010 (MEDIUM).** `writeBrainNote`/`writePendingRescue`: pętla create-with-suffix doklejała
  sufiks do TEKSTU wchodzącego w `makeMemoryNoteFilename`, a ten i tak ucina slug do 80 znaków —
  dla nazw ≥80 znaków (typowe dla `memory_rescue`) każda iteracja dawała IDENTYCZNĄ nazwę i po 50
  próbach leciał throw zamiast sufiksu. Naprawa: sufiks dokleja się do GOTOWEJ nazwy pliku
  (`baseFilename.replace(/\.md$/, '_N.md')`), jak już robił `archiveBrainNote`.
- **051 (HIGH → MEDIUM po korekcie).** `SaveSessionWorkflow.applyDecision`: pętla po notatkach
  usera nie miała try/catch — pad JEDNEJ (np. `write()` na dysku sieciowym) przerywał metodę
  PRZED `rebuildBrainIndex`/`writeNaTeraz`/`archiveActiveSession`, więc notatki, które się udały,
  zostawały POZA indeksem, a sesja NIEzarchiwizowana. Dziś każda notatka ma własny try/catch
  (wzorem sąsiedniego `_rejectPendingRescue`); pad wraca w nowym, opcjonalnym polu wyniku
  `SaveSessionOutcome.noteFailures` (`{name, error}[]`, POWSTAJE tylko przy niepustej liście —
  wzór gotchy 10), reszta metody dochodzi do końca.
- **067+068 (HIGH → MEDIUM po korekcie).** Patrz gotcha 7 wyżej — `_createBrainNote` przeszła na
  kanoniczną ścieżkę `AgentMemory.writeBrainNote` zamiast reimplementować zapis notatki.
- **069 (MEDIUM).** `pruneArchive`: gałąź `keepMax` iterowała po `candidates` (posortowanych
  ROSNĄCO po `sessionTime`) bez pytania o `sessionTime>0` — sesja o NIEUSTALONEJ dacie (zły/pusty
  frontmatter + `stat()` bez `mtime`) ma `sessionTime=0`, więc zawsze ląduje na początku listy
  i ginie jako rzekomo „najstarsza", choć może być najnowsza. Gałąź wieku (`maxAgeDays`) osiem
  linii wyżej już miała tę ochronę („zero znaczy nie wiem, nie kasujemy") — `keepMax` dostał teraz
  DOKŁADNIE tę samą regułę.

Bramki (30.08, branch `fix/cr-F01-memory-sesje`): `npm test` 2311/2311, `npm run typecheck` czysto,
`npm run lint` 0/0, `npm run lint:obsidian` 0 błędów (12236 warningów — baseline TS-any z kampanii,
bez zmiany klasy), `npm run build` 2,2 MB, selftest harnessu GREEN,
scenariusze harnessu 34/34 GREEN (od 2026-09-07 harness ma osobne repo, https://github.com/JDHole/pkm-assistant-harness). Testy regresji: `activeSessionFormat.test.ts` (007 część 1),
`AgentMemory.test.ts` (007 część 2, 009, 069), `AgentMemory_kolizja_nazw.test.ts` (010),
`ArchiveWorkflow.test.ts` (008), `SaveSessionWorkflow.test.ts` (051, 067, 068).

### Runda 2 (30.08, po recenzji opusowej): okno wyścigu 008 domknięte + trzy ciche zmiany zachowania

Recenzent zablokował merge na jednym brakującym konsumencie (`result.noteFailures` w
`modules/chat/slash-commands/save_session.ts` — patrz `modules/chat/CLAUDE.md`) i wskazał SHOULD:
okno wyścigu w naprawie 008 było domknięte tylko częściowo.

- **`ArchiveWorkflow.applyDedup`: pętla probe+sufiks przeniesiona DO WNĘTRZA `_enqueuePathWrite`,
  kluczowana BAZOWĄ (nie-sufiksowaną) ścieżką** — wzorzec `AgentMemory.writeBrainNote`. Naprawa
  008 (wyżej) zamykała kolizję z notatką ISTNIEJĄCĄ w chwili wołania, ale sama pętla szukania
  wolnej nazwy biegła PRZED `enqueue()`, na gołym `targetPath` spoza kolejki — między „nazwa
  wolna" a realnym zapisem zostawało okno na równoległy `memory_save` piszący POD TĄ SAMĄ
  bazową nazwą (dwa zapisy tej samej nazwy nie serializowały się względem siebie, bo trzymały
  się różnych kluczy kolejki: `memory_save`/`writeBrainNote` klucza bazowego, dedup — finalnego,
  już-z-sufiksem). Dziś oba wpisy kolejki dzielą TEN SAM klucz (`baseTargetPath`), więc realnie
  się serializują.
- **Wyczerpanie 50 prób POMIJA merge z `log.warn`, zamiast (jak dawniej) `break`-iem zostawiać
  `targetFilename` na `_50` i pisać tam mimo to.** Pętla wchodzi w iterację TYLKO gdy właśnie
  sprawdzona nazwa ISTNIEJE (`probeFile(...) !== 'missing'` jest warunkiem wejścia) — stary
  `break` przy `suffix > 50` zostawiał zmienne na nazwie, o której ta sama pętla przed chwilą
  orzekła „zajęta", i kod niżej i tak tam pisał: cichy zapis nad cudzą notatką, ta sama klasa
  błędu co CRITICAL naprawiony w 008. Test na gałąź wyczerpania (`ArchiveWorkflow.test.ts`,
  atrapa z 50 „wiecznie zajętymi" nazwami _2.._50 + bazową) pilnuje: zero zapisu, źródła
  scalenia NIETKNIĘTE (`result.merged === 0`), żadna z 50 cudzych notatek nie rusza się z
  miejsca.

**Dwie ciche zmiany zachowania — skutek uboczny przejścia `_createBrainNote` (067/068) na
kanoniczną ścieżkę `writeBrainNote`, żadna nie jest regresją funkcjonalną, obie warto znać:**

1. **`created` notatki powstałej z `/save session` to teraz sama data `YYYY-MM-DD`, nie pełny
   znacznik ISO z godziną.** Stara, reimplementowana ścieżka pisała
   `new Date().toISOString()` (pełny czas); `writeBrainNote` → `_buildBrainNoteContent` pisze
   `new Date().toISOString().slice(0, 10)` (sam dzień) — tak samo jak `memory_save` i accept
   z poczekalni rescue od zawsze. Skutek: `BrainIndex.noteTimestamp` (`Date.parse(created)`)
   dla dwóch notatek `project_context` utworzonych TEGO SAMEGO DNIA dostaje IDENTYCZNY
   timestamp (północ UTC), więc `compareNotesNewestFirst` w `## Bieżące` rozstrzyga remis
   alfabetycznie po nazwie pliku (`compareNotesByFilename`), nie po realnej kolejności
   powstania. Dla trzech-najnowszych-z-dnia to nieszkodliwe (wszystkie i tak trafiają do
   sekcji), ale przy WIĘCEJ niż 3 świeżych `project_context` z jednego dnia który konkretnie
   z nich odpadnie z limitu `CURRENT_PROJECT_LIMIT` zależy od nazwy pliku, nie od tego, który
   user zapisał jako ostatni.
2. **Typ notatki przechodzi teraz przez `isValidNoteType`** (`writeBrainNote`: `note?.type`
   nieznany dla `VALID_NOTE_TYPES` → cichy fallback na `reference`). Stara ścieżka pisała
   `note.type || 'reference'` bez walidacji — dowolny string z modalu/LLM trafiał wprost do
   frontmattera `type:`, co potrafiło zepsuć przypisanie notatki do sekcji indeksu
   (`NOTE_TYPE_TO_SECTION` nie zna nieznanych typów → notatka nigdy nie trafiała do żadnej
   sekcji `## …`, tylko wisiała w `brain/` bez wpisu w indeksie). Dziś taka notatka ląduje
   w `## Projekty i referencje` zamiast znikać z indeksu po cichu.

**Trzy noty z recenzji — świadome, nietknięte w tej rundzie:**

- **Gałąź `verify.content !== expected` w `archiveActiveSession` (007 część 2) nie ma
  DEDYKOWANEGO testu.** Istniejący test (`AUD-code-review-007 (część 2)`) symuluje `write()`
  archiwum jako no-op (torn write, `verify.state` wraca `'missing'`) — pokrywa pierwszą połowę
  warunku (`verify.state !== 'content'`). Druga połowa (write zwraca sukces, plik ISTNIEJE, ale
  odczytana treść RÓŻNI SIĘ od zapisanej — częściowy/uszkodzony zapis, nie jego całkowity brak)
  nie ma osobnego przypadku. Zachowanie kodu jest identyczne (throw, źródło zostaje) — brak
  testu jest świadomą luką pokrycia, nie podejrzeniem buga.
- **Ogon plików legacy sprzed S36 przy naprawie 007 część 1.** Kontrakt (`activeSessionFormat.ts`
  nagłówek pliku) mówi wprost: pliki zrobione starą sekwencją (event-log bez escapowania,
  sprzed S36 Fazy 1) muszą czytać się „do końca świata" i nigdy nie miały escapowania treści.
  Zakotwiczenie regexu w 007 (`(?:^|\n)` + brak flagi `i`) chroni NOWE zapisy (pisarz escapuje
  linię udającą etykietę), ale dla LEGACY bloku, w którym user napisał linię wyglądającą jak
  `**result:**` na początku linii ZANIM escapowanie w ogóle istniało, zachowanie jest identyczne
  jak przed naprawą — bo taki plik nigdy nie był escapowany i naprawa tego nie zmienia
  retroaktywnie (przepisanie cudzych historycznych plików sesji było i jest poza zakresem).
  Znany, zaakceptowany ogon — nie regresja, bo ten sam plik miał dokładnie to samo zachowanie
  przed 007.
- **Tryb awarii `archiveActiveSession` na kapryśnym dysku jest świadomie TWARDY (fail-closed).**
  Na dysku, który przejściowo nie potwierdza zapisów (sieciowy, Dysk Google), naprawa 007
  część 2 rzuca zamiast ciszej degradacji — sesja ZOSTAJE w `sessions/active/` (nigdy nie trafia
  do archiwum), a przy powtarzających się awariach ten folder rośnie zamiast czyścić się przy
  każdym `/save session`. To świadomy koszt: priorytetem jest nigdy nie skasować jedynej kopii
  rozmowy, nawet kosztem rosnącego zaległego `active/`. User na trwale kapryśnym dysku zobaczy
  powtarzające się błędy archiwizacji zamiast cichej utraty danych — to zamierzone, nie do
  „naprawienia" cichym retry/silent-continue bez zmiany całej filozofii tej ścieżki.

## Fabryka napraw F5 (2026-09-01) — testy audytu + `findFreeCollisionPath`

Cztery znaleziska audytu testów bez zmian produkcyjnych + jedna wydzielona funkcja pomocnicza.

- **AUD-testy-023 (HIGH; kanon dla duplikatu AUD-testy-057).** `MemoryAccessGuard` nie miał
  własnego pliku testowego — jedyny dotyk w testach był pośredni (`ReadTool.test.ts`, asercje na
  samym `code`), co gubiło rozróżnienie między `invalid_path` i `cross_agent_access_denied` dla
  sąsiednich gałęzi, a strażnik kształtu nazwy (regex `:107-109`) nie miał ŻADNEJ asercji odmowy
  w całym repo. Nowy `MemoryAccessGuard.test.ts` (23 testy) bije bezpośrednio w `validateNoteFilename`:
  po jednej asercji na każdy z sześciu warunków odmowy, z OBU stron (przepuszcza dobre / blokuje
  złe), z jawnym rozróżnieniem kodu błędu tam, gdzie kod go rozróżnia (m.in. test „ten sam kształt
  wejścia, inny właściciel segmentu → inny kod" — `jaskier/brain/x.md` własne vs `tola/brain/x.md`
  cudze).
- **AUD-testy-042 (HIGH; jedyna zmiana produkcyjna tej rundy).** Sześć identycznych kopii pętli
  „szukaj wolnej nazwy przy kolizji" w `AgentMemory.ts` (`startActiveSession`,
  `discardActiveSession`, `saveSession`, `writeBrainNote`, `writePendingRescue`,
  `archiveBrainNote`) miały test strony „blokuje po wyczerpaniu 50 prób" TYLKO dla
  `archiveBrainNote` — pięć sióstr było ślepe na dokładnie ten kształt buga, jaki kiedyś naprawiono
  w `ArchiveWorkflow.applyDedup` (`break` zamiast `throw`, cichy zapis nad zajętą nazwą; patrz
  „Runda 2" wyżej). Wydzielone do `collisionSuffix.ts` → `findFreeCollisionPath(adapter, dir,
  baseFilename, errorPrefix)`, wołane identycznie z tych sześciu miejsc — zachowanie przy sukcesie
  BEZ ZMIAN (te same nazwy sufiksów `_2`.._50`, te same komunikaty błędów, zweryfikowane pełnym
  `npm test` przed i po: 2465 → 2506, zero czerwieni). Pokrycie: `collisionSuffix.test.ts` (8 testów
  na samej funkcji, obie strony) + dwa testy WIĄZANIA w `AgentMemory_kolizja_nazw.test.ts`
  (`startActiveSession` — kształt „throw wprost"; `discardActiveSession` — JEDYNY z sześciu, gdzie
  throw jest złapany WEWNĄTRZ metody i zwraca `null`, fail-soft). Świadomie NIE dopisano pięciu
  bliźniaczych testów wyczerpania do pięciu bywszych kopii — to właśnie ten wzorzec audyt odradzał.
- **AUD-testy-022 (MEDIUM).** `KomunikatorManager.resolveHopFor` liczy hop z DWÓCH źródeł (rejestr
  w pamięci + świeży odczyt własnej skrzynki z dysku), ale kanał dyskowy (pętla po
  `_listMessagesStrict`, `KomunikatorManager.ts:349-355`) nie miał ani jednej asercji — wszystkie
  istniejące testy karmiły albo padnięty I/O, albo pustą skrzynkę, albo (w `KomunikatorTools.test.ts`)
  budowały łańcuch WYŁĄCZNIE przez kanał pamięciowy (`kom_read` w tej samej turze). Bez kanału
  dyskowego łańcuch odbić nie przeżywa restartu pluginu. Dwa nowe testy w
  `modules/komunikator/KomunikatorManager.test.ts`: świeża wiadomość `ai_read:true, hop:2` na
  dysku (bez wołania `noteRead` — symulacja restartu) → `resolveHopFor` zwraca 3; ta sama
  wiadomość, ale starsza niż `KOM_HOP_TTL_MS` → 0.
- **AUD-testy-043 (MEDIUM).** `ArchiveWorkflow._applyStep` podbija `brain_notes_limit` o +10 TYLKO
  gdy user odrzucił WSZYSTKIE scalenia (`applied.merged === 0 && applied.deleted === 0`) — testowana
  była tylko ta strona. Nowy test w `ArchiveWorkflow.test.ts` sprawdza stronę przeciwną: scalenie
  zaakceptowane i realnie wykonane (`merged === 1`) → `autoBumpedBrainNoteLimit` zostaje `false`,
  próg nie skacze do wartości po bumpie.
- **AUD-testy-058 (MEDIUM).** `EmbeddingHelper.embedBatch()` (jedyna droga batch-embeddingu wpięta
  w żywe indeksowanie semantyczne, `VaultIndexer`) nigdy nie była wołana z prawdziwym adapterem w
  żadnym teście — jedyny test na poziomie indeksera podstawiał własny `FakeEmbedder`, omijając
  całą logikę remapowania `originalIndex` (`EmbeddingHelper.ts:102-106`). Nowy
  `EmbeddingHelper.test.ts` (5 testów) woła klasę bezpośrednio z atrapą samego adaptera i
  mieszanką pustych/niepustych tekstów W ŚRODKU listy — dowodzi, że `output[i]` odpowiada
  `texts[i]`, nie sąsiadowi przesuniętemu o liczbę odfiltrowanych pozycji.

Bramki (2026-09-01, branch `refactor/v2.2-testy-f5-pamiec`): `npm test` 2506/2506 (baseline 2465 +
41 nowych), `npm run typecheck` czysto, `eslint modules/memory modules/komunikator` 0/0,
`npm run build` 2,2 MB bez zmiany rozmiaru.

## Fabryka napraw dead-code — AUD-dead-code-124 (2026-09-02): `DEFAULT_BRIEF_PROMPT` WYCIĘTY

Slot promptu `brief_prompt` był renderowany w Ustawienia → Prompt (`modules/shell/prompt_settings.ts`)
jako pełnoprawna kontrolka — z opisem i18n w czasie teraźniejszym obiecującym „Generuje krótki
brief sesji do odczytu przez innego agenta" — mimo że jego wartości nic w produkcji nie czytało.
Dawny konsument, `ContextSessionGenerator` (artefakt „Kontekst sesji"), został skasowany w E2.9
fazie D; ruch przejęły propozycje „Na teraz" w `brain.md` (patrz sekcja E2.8 wyżej). Od tamtej
chwili slot był duchem: user go konfigurował, plugin zapisywał wartość do
`promptDefaults.brief_prompt`, a `resolveWorkPrompt` nigdy nie był wołany z tym kluczem.

**Ta sama klasa wtopy co `keepRecentSessions`/`l3Threshold` (S32 Z6/Z1b)** — „pole obiecywało
kontrolę, której nie było" — z obciążeniem na niekorzyść: tamte dwa były liczbami bez skutku,
ten slot zjadał userowi czas na napisanie własnego promptu.

**Skasowane:**

- `DEFAULT_BRIEF_PROMPT` — sama stała, z `workPrompts.ts` (definicja) i z barrela (`index.ts`).
- Slot `{ key: 'brief_prompt', ... }` z tablicy `WORK_PROMPTS` (`modules/shell/prompt_settings.ts`)
  — kontrolka (textarea + Wstaw fabryczny/Przywróć domyślny) znika z ekranu.
- `'brief_prompt'` z `WORK_PROMPT_KEYS` (`core/utils/workPromptResolver.ts`) — lista kluczy, które
  resolver rozumie, teraz pięć zamiast sześciu.

**Świadomie NIE skasowane:** klucze i18n `settings.prompt_item.brief_prompt.*` (`core/i18n/pl.ts`,
`core/i18n/en.ts`) — poza zakresem tego zadania (`core/i18n/` nie jest modułem naprawiającego),
zgłoszone do osobnego sweepu kluczy osieroconych.

**Bez migratora — świadomie.** Stara wartość `settings.pkmAssistant.promptDefaults.brief_prompt`
u usera, który kiedyś coś tam wpisał, zostaje w `settings.json` nietknięta i nieszkodliwa: nic jej
już nie czyta ani nie renderuje (`renderPromptSection` iteruje wyłącznie po `WORK_PROMPTS`, liście
stałej — nie po kluczach obiektu `promptDefaults`), więc wczytanie ustawień i render listy slotów
przechodzą bez błędu niezależnie od tego, czy klucz w pliku istnieje.

Strażnicy: `modules/memory/workPrompts.test.ts` (barrel i moduł nie eksportują już
`DEFAULT_BRIEF_PROMPT`), `modules/shell/prompt_settings.test.ts` (lista slotów promptu nie
zawiera `brief_prompt`), `core/utils/workPromptResolver.test.ts` (`WORK_PROMPT_KEYS` — pięć
kluczy, `brief_prompt` nieobecny).
