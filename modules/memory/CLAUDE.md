# modules/memory/

**Pamięć agenta w Memory v3: per-agent, plikowa, jawna dla usera i niedestrukcyjna.**

Każdy agent ma osobny folder:

```text
.pkm-assistant/agents/<safeName>/memory/
├── brain.md
├── brain/
│   ├── archive/
│   └── pending_rescue/
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

`brain.md` nie jest monolitem ani miejscem na fakty. To kategoryzowany indeks do `brain/*.md`.
Trwałe fakty idą do osobnych notatek; `## Bieżące` pokazuje kilka aktywnych projektów jako
link + jedno zdanie opisu. Agent nie dopisuje faktów bezpośrednio do `brain.md`.

---

## Co tu jest

```text
modules/memory/
├── index.ts                # publiczne drzwi (barrel) - jedyny legalny import z zewnątrz modułu
├── AgentMemory.ts           # struktura folderów, brain.md, sesje active/archive, summaries
├── BrainIndex.ts            # buildBrainIndex(): kategoryzowany indeks brain.md z metadanych brain/*.md
├── MemoryAccessGuard.ts      # strict per-agent path guard dla brain/
├── collisionSuffix.ts       # findFreeCollisionPath() - jedna wspólna pętla "wolna nazwa przy kolizji", wołana z kilku miejsc w AgentMemory.ts. Wewnętrzny, nie w barrelu
├── SaveSessionWorkflow.ts    # /save session: propozycje notatek + archiwizacja aktywnej sesji
├── ArchiveWorkflow.ts        # dedup brain/ + L1/L2/L3 user-reviewed consolidation
├── ConsolidationRun.ts       # stan przebiegu konsolidacji (plan kroków, statusy, retry, koszt) - czysty node
├── MemoryOpsCenter.ts        # rejestr JEDNEGO aktywnego przebiegu + subskrypcja dla UI
├── consolidationLabels.ts    # etykiety/ikony/czas/koszt/podsumowanie przebiegu (czyste, dzielone przez pasek statusu i modal)
├── ConsolidationSnapshot.ts   # prune() - sprząta kopie snapshotu po starszej wersji pluginu
├── MigrationV3.ts            # backup-first migracja brain.md v2 -> v3
├── StateManager.ts           # .state.json: aktywne sesje + liczniki, kolejka RMW
├── IdleScheduler.ts          # pure decyzja "czy zapisać po bezczynności" (wpinany w modules/chat)
├── RetrievalEngine.ts        # silnik narzędzia `search`: runSearch() z RRF keyword+semantic
├── EmbeddingHelper.ts         # helper wektoryzacji dla retrieval semantycznego
├── CostLog.ts                # koszt operacji memory/sub-agent
├── activeSessionFormat.ts    # JEDNO źródło kontraktu pliku sessions/active - formatSessionEvent (pisarz) + parseActiveSession (czytnik) + maxSeq + EVENT_FIELDS + escape/unescape + KNOWN_ROLES + parseFrontmatter. Czysty node, zero importów z obsidian. Wewnętrzny, nie w barrelu
├── sessionParser.ts          # markdown session parse/format (transkrypt "format B"); escape/unescape i KNOWN_ROLES re-eksportuje z activeSessionFormat.ts
├── streamHelper.ts           # helper stream -> complete / tools loop
├── workPrompts.ts            # fabryczne prompty robocze (save_session/archive/summary)
├── SettingsContent.ts         # render sekcji Pamięć w Settings
└── SettingsSection.ts         # rejestracja sekcji memory
```

`AgentMemory.ts` i `ArchiveWorkflow.ts` są świadomie nierozbitymi monolitami (grubo ponad 800
LOC każdy) - zmiana w którymkolwiek wymaga przeczytania całości przed edycją, nie tylko
fragmentu wokół linii, którą się dotyka.

> `RollingWindow` (okno tokenów czatu) mieszka w `modules/chat/` - to domena chatu, nie
> pamięci; memory go nie eksportuje. `toolTranscriptSanitizer.ts` mieszka w
> `modules/agent-loop/` (memory go nie eksportuje) - jedyny wołacz,
> `modules/chat/chat/RollingWindow.ts`, importuje go wprost z domu.

---

## Public API

Import z zewnątrz tylko przez `modules/memory/index.js`.

| Export | Rola |
|---|---|
| `AgentMemory` | Główny runtime pamięci agenta. Tworzy foldery v3, odświeża indeks `brain.md`, zapisuje aktywne sesje. Listing (`listBrainNotes`/`listActiveSessions`/`listArchiveSessions`), `listUncoveredL1s()`/`listUncoveredL2s()` i `pruneArchive({days, maxFiles})` (retencja archiwum - patrz kontrakt konsolidacji) są jej METODAMI, nie eksportami barrela. |
| `parseBrainLog(text, limit=50)` | Czysty parser `brain.log` (TSV -> `{ts, op, target, detail}`, od najnowszego). Pisze go `AgentMemory.appendBrainLog`; czyta karta "Log wpisów" w profilu agenta. |
| `MemoryAccessGuard`, `MEMORY_V3_ERROR_CODES`, `isValidNoteType`, `makeMemoryNoteFilename()` | Waliduje ścieżki Memory v3 (brak traversal / absolutnych / cross-agent) + kanoniczne nazwy notatek `type_slug.md`. |
| `listUncoveredArchiveSessions(agentMemory)` | Sesje z `sessions/archive` BEZ stempla `covered_by_l1`, sortowane rosnąco po nazwie - jedyny poprawny materiał na nową paczkę L1. |
| `IdleScheduler` | Pure decyzja "czy zapisać po bezczynności" (wpinany w `modules/chat`). |
| `SaveSessionWorkflow` | `/save session`: user-review, tworzenie notatek, archiwizacja sesji. |
| `ArchiveWorkflow` | Automatyczna konsolidacja po progach: brain/ dedup, L1, L2, L3. Jeden tor: `runWithRun(consolidationRun)` (generuje propozycje wszystkich paczek, nic nie zapisuje) + `applyStepDecision()` (zapisuje po decyzji usera) + `generateGatedSteps()` (zdejmuje kłódkę z L2/L3 dopiero gdy L1 są rozstrzygnięte) - generacja oddzielona od zapisu. |
| `parseNaTerazSections`, `naTerazSectionKey` | Pure helpery sekcji "Na teraz" brain.md, czytane przez UI panelu Pamięć i `MemorySaveTool`. |
| `ConsolidationRun`, `buildConsolidationPlan`, `STEP_STATUS`, `STEP_KIND`, `normalizeUsage` | Stan jednego przebiegu konsolidacji - plan paczek z liczników, maszyna stanów kroku. Zero UI, zero Obsidiana. |
| `memoryOpsCenter` (singleton), `OPS_EVENT` | Rejestr jednego aktywnego przebiegu. `startRun/getActiveRun/finishRun/subscribe/requestOpenModal`. Drugi trigger przy aktywnym przebiegu NIE startuje drugiego - zwraca bieżący i prosi o modal. |
| `stepLabel`, `stepDetail`, `stepStatusIcon`, `stepStatusLabel`, `stepDurationMs`, `isFallbackStep`, `formatDuration`, `formatUsageLine`, `statusBarLine`, `buildRunSummary`, `summaryToText`, `planToText` | Warstwa OPISOWA przebiegu (`consolidationLabels.ts`) - jedno źródło etykiet dla paska statusu i modalu przebiegu. Czyste funkcje, zero DOM. |
| `MigrationV3` | Migracja v2 -> v3: najpierw `memory.v2.backup/`, potem notatki `brain/`. |
| `streamToComplete` | Stream -> complete z opcjonalnym `{onChunk, signal, watchdog}`. |
| `RetrievalEngine` | Silnik narzędzia `search` - patrz sekcja "Odczyt pamięci" niżej. |
| `CostLog`, `EmbeddingHelper` | Koszt operacji memory/sub-agent + helper wektoryzacji. |
| `DEFAULT_SAVE_SESSION_PROMPT`, `DEFAULT_ARCHIVE_PROMPT`, `DEFAULT_SUMMARY_PROMPT` | Fabryczne prompty robocze (`workPrompts.ts`), owned przez memory. |
| `registerSettings` | Rejestracja sekcji "Pamięć i kontekst" w Settings. |

Sporo pomocniczych symboli (helpery listujące, `StateManager`, większość `BrainIndex`,
`ConsolidationSnapshot`, część etykiet przebiegu, kody błędów streamu, parsery sesji) żyje
WYŁĄCZNIE w bebechach - moduł woła je u siebie, konsumenci spoza modułu wołają metody
`AgentMemory`/`ArchiveWorkflow` zamiast surowych funkcji. Zanim dodasz coś do barrela, sprawdź,
czy naprawdę ma czytelnika spoza `modules/memory/`.

**`RetrievalEngine` w szczegółach:** `runSearch({query, scope, where, mode, limit})` - kandydaci
wg `where`, hybryda keyword+semantic przez RRF (k=60), excerpt z dysku. DI
(app/vault/embeddingHelper/oramaDb/agentMemory/vectorSearch). Opcjonalne `app` -> scope=vault
API-first (`getMarkdownFiles` + `metadataCache`: frontmatter z cache, linki z
`resolvedLinks`, `cachedRead`); bez `app` fallback walker/parser/regex; scope=memory zawsze
adapter (metadataCache nie widzi `.pkm-assistant/`). Konsument: `modules/tools/SearchTool.js`.
Admin (`agent.admin_access`) może dodać `includeHiddenVault` - wtedy kandydaci Markdown są
zbierani też adapterowym walkerem z `.pkm-assistant`/`.obsidian`; semantyczny indeks vaulta
nadal nie indeksuje bebechów.

> **Sufit skanu keyword - `MAX_KEYWORD_SCAN_CANDIDATES = 300`, WYŁĄCZNIE dla `scope='vault'`.**
> Bez `where` `_gatherCandidates` może zwrócić cały vault. `_scanKeywordCandidates` tnie
> kandydatów PRZED odczytem treści (nie po zliczeniu wyniku): kandydaci powyżej 300 są cięci
> przed odczytem, a ci, których nazwa pasuje do słowa zapytania, mają pierwszeństwo skanu
> (`_prioritizeForScan`, tania heurystyka bez I/O). Wynik niesie `scan: {candidates, scanned,
> truncated}` w `SearchOutcome` TYLKO gdy `truncated` (poniżej sufitu pole nieobecne).
> `contentCache` nie trzyma treści po zliczeniu trafień - budowa excerptu dla `top` czyta
> ponownie (tani re-read zamiast trzymania pełnych treści całego zbioru do końca `runSearch`).
> Równoległe identyczne skany (np. kilku sub-agentów nad tym samym `vault`) dzielą JEDEN skan
> przez moduł-level `WeakMap<vault, Map<klucz, Promise>>` (`_inFlightKeywordScans`), kluczowany
> `scope::where::query` PLUS `agentMemory.paths.brain` (bo dla `scope='memory'` sam
> `scope::where::query` nie odróżnia agentów - dwaj suby mogą zapytać identycznie, mając różną
> `agentMemory`) PLUS `_candidateFingerprint(candidates)` jako niezależny dowód tożsamości
> zbioru kandydatów. Wpis żyje tylko na czas skanu (czyszczony w `finally`).
>
> **Dla `scope='memory'` sufit jest CAŁKOWICIE WYŁĄCZONY.** `_listMemoryFiles` listuje
> brain -> brain/ -> sessions/active -> sessions/archive -> dopiero L1 -> L2 -> L3; sufit
> zjadałby u agenta z długim archiwum całe archiwum, a L1-L3 (najcenniejsza, skondensowana
> warstwa pamięci) nigdy nie trafiałyby do skanu, a `_prioritizeForScan` tu nie ratuje, bo nazwy
> L1/L2/L3 są datowane, nie niosą słów zapytania. Pamięć jednego agenta jest z natury
> ograniczona (jego własne dane, nie cały vault), więc ryzyko O(rozmiar vaulta) nie występuje.
>
> `_excerptStart` tnie PRZED normalizacją `\s+` (nie na całym pliku) - zapas rośnie
> (`max*4` -> `max*16` -> cała treść) dopóki normalizacja nie da `max` znaków albo zapas nie
> obejmie całego pliku; typowa notatka kończy na pierwszej próbie, patologiczny plik (setki
> pustych linii na początku/końcu) płaci pełną normalizację świadomie - bez tego rosnącego
> zapasu excerpt potrafi wyjść jako sam "…" (treść zgubiona w whitespace) albo fałszywie
> obcięty.

---

## Kontrakty Memory V3

### `memory_save`

`memory_save` tworzy nowy plik w `brain/` aktualnego agenta i odświeża `brain.md` jako indeks.

- create-only: istniejący filename zwraca `note_already_exists`,
- nie zapisuje faktów bezpośrednio do `brain.md`,
- przyjmuje typy: `user`, `agent_rule`, `skill_hint`, `project_context`, `reference`,
- zapis poza aktualnym agentem jest niedozwolony.

`memory_delete` usuwa dokładnie jedną pasującą notatkę z `brain/`, odświeża indeks i odmawia
wieloznacznych trafień. Nie kasuje `project_context` - zakończone projekty muszą przejść
archiwizację z review lekcji. Direct writes do `brain.md` nie istnieją jako droga runtime -
zapis idzie wyłącznie przez `memory_save` / `/save session` / konsolidację / sekcje "Na teraz"
(niżej).

### `brain.md` jako indeks

`brain.md` zaczyna się od dwóch sekcji krótkoterminowych - `## Na teraz: User` (nad czym user
pracuje teraz) i `## Na teraz: Środowisko` (bieżący stan projektu/vaulta), plain-text bullety
zmiennego stanu, NIE linki i NIE trwałe fakty (stałe w `BrainIndex.ts`: `NA_TERAZ_SECTIONS`,
`NA_TERAZ_MAX_ENTRIES=10` - twardy trim najstarszych + log). Pod nimi jest kategoryzowany
indeks:

- `## Bieżące` - kilka najnowszych aktywnych `project_context`,
- `## User` - notatki `user`,
- `## Preferencje` - notatki `agent_rule`,
- `## Workflow` - notatki `skill_hint`,
- `## Projekty i referencje` - starsze `project_context` + `reference`.

Każdy wpis ma format:

```md
- [[brain/project_context_memory_v3.md]] - Przebudowa systemu zapisywania i indeksowania faktów w brain.md i brain/.
```

`AgentMemory.writeNaTeraz(ops)` (kolejkowana) muta sekcje "Na teraz" i przebudowuje indeks -
to JEDYNE miejsce, gdzie zapis może dopisać/usunąć treść w `brain.md`; notatki `brain/`
pozostają create-only. Woła ją `MemorySaveTool` (`{ephemeral:true, section}`) i
`SaveSessionWorkflow` (LLM w `/save session` może zwrócić `na_teraz: {user:{add,remove},
environment:{add,remove}}`, modal renderuje diff, zaakceptowane operacje idą przez
`writeNaTeraz`). `BRAIN_MAX_TOKENS = 600` (indeks + Na teraz muszą się zmieścić).

`/save session` tworzy zaakceptowane notatki w `brain/`, archiwizuje sesję i przebudowuje
indeks.

**Sekcje H2 spoza katalogu zarządzanych** (ręcznie dopisane przez usera, np. sekcja trybu
testowego) są ZACHOWYWANE przy przebudowie - `parseForeignSections` wyciąga je ze starego
pliku, a `buildBrainIndex` emituje je verbatim NA KOŃCU nowego pliku (kolejność względna
zachowana; sekcja dopisana na górze po pierwszej przebudowie wędruje na dół - świadomy koszt).

**Od 2026-09-12 ręczne linie WEWNĄTRZ sekcji zarządzanych też przeżywają rebuild.** Praktyczny
przypadek: sesje Claude Code dopisują 3-5 bulletów ręcznie do `## Bieżące` (bieżący kontekst
roboczy), a każdy `memory_save`/`/save session`/konsolidacja wywołuje `rebuildBrainIndex()` -
bez tej naprawy wpisy ginęły przy pierwszym kolejnym zapisie. `parseManualIndexLines(before)`
(`BrainIndex.ts`) wyciąga z KAŻDEJ sekcji zarządzanej (`INDEX_SECTIONS`) jej niepuste linie,
które NIE są linkiem do notatki (`- [[brain/…]]`, niezależnie od tego co po nim - taki link
jest ZAWSZE regenerowany z metadanych notatek i traktowany jako wygenerowany, nie ręczny; stary
link do usuniętej notatki więc dalej znika, to zamierzone). `buildBrainIndex({manual})` emituje
te linie NA POCZĄTKU danej sekcji, PRZED wygenerowanymi linkami, w oryginalnej kolejności;
sekcja z samymi ręcznymi liniami i bez notatek i tak dostaje nagłówek (jak dotąd - puste sekcje
nigdy nie były omijane). `AgentMemory.rebuildBrainIndex()` woła
`manual: parseManualIndexLines(before)` przy każdej przebudowie. Rebuild(rebuild) jest bajtowo
idempotentny - druga przebudowa z tych samych notatek parsuje własne ręczne linie z powrotu i
odtwarza identyczny plik. Bezpiecznik `.bak` (`_brainHasManualContent`) zostaje NIETKNIĘTY -
nadal tworzy kopię przy zmianie pliku z ręczną linią w strefie `managed`, teraz już tylko jako
redundantna siatka bezpieczeństwa, bo treść i tak przeżywa w samym `brain.md`.

**Fabryczne prompty robocze** (`workPrompts.ts`, owned przez memory, żeby workflow miał własne
defaulty bez cyklu memory→agents): `DEFAULT_SAVE_SESSION_PROMPT` / `DEFAULT_ARCHIVE_PROMPT` /
`DEFAULT_SUMMARY_PROMPT`. Konsumowane przez `resolveWorkPrompt(agent, key, settings, factory)`
(`core/`) - łańcuch **per-agent > global (Settings→Prompt) > factory**. Override musi zachować
kształt outputu (JSON `new_notes`, `{{LEVEL}}`, `merges`/`deletions`) - parsery workflow na tym
stoją.

### `brain/archive/`

Cmentarzysko zakończonych projektów. Pliki z tego folderu nie wchodzą do `brain.md` ani do
domyślnego `listBrainNotes()`. Projekt `project_context` może trafić tu dopiero po review
lekcji (`lessonsReviewed=true`) - workflow archiwizacji przenosi zakończone projekty tutaj
zamiast kasować je bez śladu.

### `brain/pending_rescue/`

Poczekalnia kandydatów z `memory_rescue` (kompresja okna czatu). Ten sam mechanizm wykluczenia
co `brain/archive/` - jeden filtr podfolderów w `listBrainNotes()`, więc pending nie wchodzi do
`brain.md`, konsolidacji ani retrievalu. Kontrakt "user zatwierdza" jest egzekwowany też dla
rescue: kandydat czeka tu na review w modalu zapisu sesji (`SaveSessionWorkflow.prepareProposals`
dokłada go do listy z prefiksem pochodzenia; accept -> notatka w `brain/` istniejącą ścieżką
`writeBrainNote`, reject -> kasacja pliku; anulowanie modala nie rusza poczekalni).

Cztery metody publiczne `AgentMemory`: `writePendingRescue(note, {source})` (create-with-suffix,
kolejkowany, RAW body - stopka Why/How dokleja się dopiero przy accept), `listPendingRescue()`
(pad -> `[]`, sesja zapisuje się dalej), `acceptPendingRescue(filename, note?)` (`readIfExists`
fail-closed, create-before-delete), `rejectPendingRescue(filename)` (`probeFile` fail-closed na
`unknown` - nie kasuje przy sprzecznych sygnałach). Filename walidowany przed konkatenacją
ścieżki (regex, odpada `../`).

**Dlaczego NIE przez konsolidację:** `MemoryOpsCenter` to globalny singleton "jeden przebieg na
cały plugin" (nie per-agent), `ConsolidationRun` trzyma propozycje wyłącznie w RAM (świadomie
bez trwałości - bezpieczne dla idempotentnej konsolidacji, zabójcze dla rescue chroniącego
jednorazowy wynik LLM), a kształt kroków (merges/deletions, body+sources) nie mieści
pojedynczej notatki.

### Odczyt pamięci: `read`/`list` (scope=memory)

Odczyt pamięci idzie przez prymitywy `read`/`list` (`modules/tools/`) z `scope:"memory"`.
Reguły bezpieczeństwa (`MemoryAccessGuard`):

`read(path:"<filename>", scope:"memory")` czyta tylko plik `.md` z `brain/` aktualnego agenta:

- `../../../x.md` -> `invalid_path`,
- `/absolute/path.md` -> `invalid_path`,
- `jaskier/brain/x.md` z innego agenta -> `cross_agent_access_denied`,
- brak pliku -> `note_not_found`.

`read(path:"summaries/L1/<file>.md", scope:"memory")` czyta podsumowanie L1/L2/L3;
`list(folder:"summaries", scope:"memory")` listuje je. Bramka uprawnienia `memory` jest
fail-closed wewnątrz narzędzia (jak `search`).

### Sesje aktywne

Każda wiadomość usera, odpowiedź agenta, tool result i sub-agent result dopisywane są do
`sessions/active/<agent>_YYYY-MM-DD_HH-mm.md`. `.state.json` trzyma listę aktywnych sesji do
restore po restarcie Obsidiana.

**Plik active ma JEDNEGO pisarza: `appendToActiveSession`** (event-log, append-only, z
numeracją `**seq:**`). `saveSession` NIE nadpisuje pliku transkryptem - dopisuje tylko ogon,
którego czytnik eventowy nie widzi (patrz gotcha "dopisywanie, nie nadpisywanie" niżej).
Transkrypt (`## User`/`## Assistant`) to widok POCHODNY: powstaje przy `archiveActiveSession`
(konwersja event-log -> format transkryptu, `formatToMarkdown`). Format `sessions/archive/`
jest transkryptem od zawsze - konsolidacja L1/L2/L3 i `parseSessionFile` go czytają bez zmian.

Kontrakt pliku żyje w JEDNYM miejscu, `activeSessionFormat.ts`: `ACTIVE_SESSION_FORMAT_VERSION`,
`escapeActiveText`/`unescapeActiveText`, `formatSessionEvent` (pisarz, event-log),
`parseActiveSession` (czytnik formatu event-log + transkryptu + plików MIESZANYCH - w
produkcji plik po pierwszym autozapisie bywał mieszanką obu), `KNOWN_ROLES`, `EVENT_FIELDS`,
`parseFrontmatter`. `sessionParser.ts` re-eksportuje `KNOWN_ROLES` i importuje
escape/unescape stąd - jedno źródło pary regexów, kierunek `sessionParser -> activeSessionFormat`,
bez cyklu.

### Konsolidacja

`ArchiveWorkflow` odpala flow user-review, JEDEN tor: `runWithRun(consolidationRun)` generuje
propozycje wszystkich paczek (pętla okien po `batchSize` w posortowanym `sessions/archive`) i
nic nie zapisuje; `applyStepDecision(run, stepId, decision)` zapisuje po decyzji usera
(odrzucenie = `skipped`, nie błąd); `generateGatedSteps(run)` zdejmuje kłódkę z L2 dopiero, gdy
WSZYSTKIE L1 są rozstrzygnięte (`failed` ≠ rozstrzygnięty - L2 czeka na "Ponów"/"Pomiń"), a przy
mniej niż `batchSize` plików L1 na dysku pomija L2 i L3. Fail jednej paczki nie zatrzymuje
pozostałych.

- dedup `brain/`: trigger po 20 notatkach, auto-bump +10 gdy user odrzuci merge,
- L1: po 5 zarchiwizowanych sesjach; sesje zostają,
- L2: po 5 L1; usuwa pokryte sesje z archive, L1 zostają,
- L3: po 5 L2; usuwa pokryte L1, L2 zostają,
- materiałem na L1 są TYLKO sesje bez stempla `covered_by_l1` (`listUncoveredArchiveSessions`),
- materiałem na L2 są TYLKO pliki L1, których nie wymienia żadne L2 (`listUncoveredL1s`), a
  materiałem na L3 - TYLKO L2 niewymienione w żadnym L3 (`listUncoveredL2s`) - patrz gotcha
  "znacznik pokrycia to plik nadrzędny" niżej,
- **retencja archiwum**: `runWithRun` na starcie woła `AgentMemory.pruneArchive({days,
  maxFiles})` z ustawień (`pkmAssistant.archiveRetentionDays` / `archiveRetentionMaxFiles`, oba
  default 0 = OFF). Kasuje WYŁĄCZNIE sesje ze stemplem `covered_by_l1` (jedyny materiał na
  przyszłe L1 i jedyna pełna kopia rozmowy nigdy nie ginie po limicie); `days>0` liczy wiek po
  realnej dacie sesji (`sessionTime` z frontmattera, nie mtime - mtime przestawia sam stempel);
  sesja o dacie nieustalonej nie jest uznawana za starą i nie jest kasowana przez `maxFiles`
  (sortowanie po `sessionTime` rosnąco musi traktować `0`/nieznane jako "nie wiem", nie jako
  "najstarsze"). `0`/brak dla obu = natychmiastowy `{removed: 0}`. Best-effort per plik, nigdy
  nie rzuca,
- **snapshotu nowy tor NIE ROBI** - zapisy dzieją się po decyzjach usera, czasem godziny
  później po starcie generacji; odtworzenie snapshotu cofnęłoby bieżącą rozmowę. Operacje
  konsolidacji są create-before-delete, więc pad w połowie i tak nie gubi danych, a kopia całej
  pamięci w jednym pliku byłaby własnym punktem awarii. `ConsolidationSnapshot.prune(keep=3)`
  (zostaje N najnowszych, sortowanie leksykalne = chronologiczne bo nazwa zaczyna się od ISO)
  sprząta jedynie kopie zostawione przez starszą wersję pluginu; wołane na starcie `runWithRun`.

### Migracja

`MigrationV3` wykrywa stare memory, gdy istnieje `brain.md`, nie istnieje folder `brain/` i
treść nie wygląda na już zmigrowany indeks v3 (`looksLikeV3Index`: kanoniczny wikilink
`- [[brain/<typ>_*.md` wystarcza sam; nagłówek "Na teraz" liczy się TYLKO razem z ≥2 nagłówkami
`INDEX_SECTIONS` - pojedynczy słaby sygnał nie wygasza migracji). Brain w formacie v3 bez
folderu `brain/` (świeży klon, desync) nie jest migrowany: `run()` robi backup, dosztukowuje
strukturę (`ensureMemoryStructure` może dokleić brakujące nagłówki indeksu i domigrować płaski
`sessions/`) i wraca `{skipped, reason:'already_v3_format', backupPath}`.

Flow:

1. backup całego `memory/` do `memory.v2.backup/` - TAKŻE na ścieżce skip `already_v3_format`,
2. jednostka migracji to AKAPIT/BULLET (blok), nie linia: pusta linia i `---` rozdzielają bloki,
   wcięty sub-bullet zostaje przy rodzicu, nagłówek `###`-`######` staje się prefiksem
   następnego bloku, znacznik ``` jest pomijany,
3. `## User` -> `user_*.md`; `## Preferencje` -> `agent_rule_*.md`; `## Ustalenia` ->
   `project_context_*.md`; `## Bieżące` -> `project_context_*`; `## Workflow` -> `skill_hint_*`;
   `## Projekty i referencje` -> `reference_*` (nagłówki kolidujące z `INDEX_SECTIONS` idą w
   notatki, NIE w `keepInBrain` - sekcja verbatim pod takim nagłówkiem zostałaby wycięta przy
   następnym `rebuildBrainIndex`),
4. sekcja NIEROZPOZNANA z treścią -> `keepInBrain` i przeżywa w nowym `brain.md` verbatim na
   końcu pliku; sekcja pusta (także rozpoznana pusta) -> `deletedSections`. Każda sekcja jest
   policzona w planie (notes / keepInBrain / deletedSections),
5. treść przed pierwszym `##` (wstęp pod H1) -> notatki `reference`, ale tylko obok prawdziwych
   sekcji; plik bez żadnego `##` idzie w całości w dump (pkt 8),
6. zombie sekcje (nazwy narzędzi/procesów z poprzedniej wersji pluginu) są proponowane do
   usunięcia,
7. kolizja nazwy notatki (identyczne pierwsze 6 słów dwóch bloków) -> sufiks `_2`/`_3` w
   filename; żadna treść nie znika z planu po cichu,
8. plik bez sekcji z realną treścią -> `reference_legacy_brain_dump.md` (kopia 1:1); sam
   szkielet nagłówków -> zero notatek i zero śmieciowego dumpu.

`applyPlan(plan, originalBrain)` jest fail-closed: plan z niepustym `keepInBrain` bez podanego
`originalBrain` rzuca (sekcje zachowywane odtwarza się z oryginalnej treści). Strażnicy:
`MigrationV3_rozdrabnianie.test.ts` (w tym false-positive'y heurystyki) + `MigrationV3.test.ts`.

---

## Gotchas

- ⚠️ **User authority absolute.** Agent proponuje, user zatwierdza. `brain.md` i sesje nie są
  niszczone bez jawnego flow.
- ⚠️ **Plik sesji jest źródłem prawdy.** L1/L2/L3 są pochodne. Nie kasuj niższego poziomu, zanim
  wyższy poziom naprawdę go pokrywa (patrz "znacznik pokrycia" niżej).
- ⚠️ **Cross-agent isolation jest twarde.** Jeden agent nie czyta pamięci drugiego - ma użyć
  własnej pamięci albo komunikacji między agentami.
  - **`AgentManager.getActiveMemory()` NIE JEST na ścieżce tła.** Zwraca pamięć agenta AKTUALNIE
    wybranego w UI, a bieg suba i kompresja końca tury dożywają chwili, w której user przełączył
    zakładkę - więc ten sam odczyt oznaczałby wtedy KOGOŚ INNEGO. Wszystko, co pisze albo czyta
    pamięć z biegu w tle, adresuje ją przez `getAgentMemory(<właściciel>)`, a brak instancji dla
    nazwanej tożsamości kończy się ODMOWĄ, nigdy podstawieniem cudzego katalogu.
    `getActiveMemory()` zostaje dla akcji usera na aktywnej zakładce (zapis ręczny, `/save
    session`, UI).
- ⚠️ **Nowe user-facing stringi idą do `core/i18n/pl.ts` i `core/i18n/en.ts`.**
- ⚠️ **Stopka notatki `brain/` (`**Dlaczego:**` / `**Jak stosować:**` + zdania domyślne) idzie z
  i18n** (`memory.note.why_label` / `how_label` / `why_unspecified` / `how_default`). Kanoniczny
  pisarz to `AgentMemory._buildBrainNoteContent` / `MemorySaveTool.buildNoteContent` (oba muszą
  wyjść identycznie - `AgentMemory` dokłada tylko pole `source`); `SaveSessionWorkflow`
  (`/save session`) i accept z poczekalni rescue delegują do tego samego kanonu przez
  `AgentMemory.writeBrainNote`. Nic tego kształtu nie parsuje - to opis dla człowieka.
  `ArchiveWorkflow._buildNoteContent` (notatki ze scaleń dedup) jest ŚWIADOMIE po angielsku -
  silnik konsolidacji jest i18n-free; notatka powstała ze scalenia ma więc angielskie etykiety,
  reszta polskie.
- ⚠️ **`description` notatki `brain/` musi być jednolinijkowy w drodze do promptu.** Pisarze
  frontmatteru escapują opis przez `JSON.stringify`, więc w PLIKU to jedna linia - ale czytnik
  (`parseFrontmatterScalar` -> `JSON.parse`) przywraca prawdziwe znaki nowej linii. Opis z
  własnymi liniami udającymi nagłówek promptu potrafiłby otworzyć w prompcie fałszywą sekcję
  zaraz obok pozycji indeksu. Każdy emiter opisu do promptu idzie przez `oneLineDescription`
  (`BrainIndex.ts`), ten sam, którego używa `formatIndexLine`. Cały indeks + `brain.md` jadą
  dodatkowo w ogrodzeniu `<vault_content source="memory">` (`PromptBuilder.addDynamicSection` -
  patrz `modules/prompts/CLAUDE.md`).
- ⚠️ **Odczyt, który PADŁ, nie jest "pusto".** `adapter.exists()` potrafi kłamać na dyskach
  sieciowych i chmurowych - dlatego każde miejsce, gdzie od odpowiedzi zależy NADPISANIE pliku,
  pyta przez `probeFile` z `core/index.js` (`'exists' | 'missing' | 'unknown'`; `false` jest
  POTWIERDZANE próbą `read`). Świeży `brain.md`, nowy plik sesji i bootstrap `.state.json`
  powstają WYŁĄCZNIE na `'missing'`; `'unknown'` = fail-closed (zero nadpisania, `log.warn`,
  błąd w górę). Konsekwencje kontraktu: `getBrain()` i `listBrainNotes()` RZUCAJĄ zamiast oddawać
  `''`/`[]` (wołacz decyduje - `getMemoryContext` wstawia do promptu komunikat o
  niedostępności, `ensureMemoryStructure` tylko warnuje), `rebuildBrainIndex` robi `.bak` także
  przy `'unknown'`, a w `StateManager` `read()` może zdegradować się do defaultów w pamięci (z
  logiem), ale mutatory (`update`/`addActiveSession`/`markArchived`) rzucają - utrwalenie
  defaultów kasowałoby liczniki i limity. Nie "naprawiaj" tego z powrotem na gołe `exists()` i
  nie potwierdzaj `false` odczytem w pętlach listujących (migracje, `listBrainNotes`) - tam to
  tylko koszt.
- ⚠️ **Nieostemplowana sesja jest WYNIKIEM kroku, nie szumem w logu.** `_cleanupAfterL1` zwraca
  `{marked, skipped: [{session, reason, detail?}]}` (`reason`: `'not_found'` = nie ma pliku ani
  w `sessions/archive/`, ani w płaskim `sessions/`; `'write_failed'` = read-modify-write rzucił),
  loguje `warn` przy niepustym `skipped`, a `ArchiveWorkflow._writeLevel1` przenosi tę listę do
  zwrotki kroku jako `unstamped` (pole powstaje tylko przy niepustej liście). To jest "zapisane,
  nie ostemplowane" - plik L1 ISTNIEJE, więc krok nie ma prawa wywrócić całej konsolidacji;
  stemplowanie jest idempotentne (`fm.covered_by_l1 === l1Name`), więc ponowienie jest bezpieczne.
  Bez tego sesje bez stempla wracają przez `listUncoveredArchiveSessions()` do NASTĘPNEJ paczki -
  drugie streszczenie tych samych rozmów za kolejny strzał do modelu.
- ⚠️ **`roleFromEvent` musi znać KAŻDY typ zdarzenia biegu suba.** Zdarzenia biegu suba niosą w
  polu `**role:**` etykietę SUBA (`researcher`/`strategist`, czasem `system` z YAML-a), nie rolę
  wiadomości - o roli wiadomości decyduje TYP zdarzenia. Nowy typ zdarzenia bez wpisu w
  `roleFromEvent` sprawia, że przy etykiecie spoza `KNOWN_ROLES` parser dostaje `null` i POMIJA
  cały blok: padnięty bieg suba znika z odtworzonej rozmowy, z konsolidacji (karmi się
  `parsed.messages`) i przez `archiveActiveSession` (transkrypt z `parsed.messages` + kasacja
  oryginału) także z dysku. Przy etykiecie `system` jest gorzej - treść błędu wraca jako
  wiadomość SYSTEMOWA. Nowy typ zdarzenia = nowe mapowanie w `roleFromEvent` + test round-tripu
  w `activeSessionFormat.test.ts`.
- ⚠️ **Odczyt PRZED dopisaniem nowego wpisu - nie ufaj samemu `exists()`.** Kilka miejsc
  (`saveSession`, log audytu, `brain.log`, `CostLog`) czyta stary plik przed dopisaniem nowego
  wpisu; na dyskach, gdzie `exists()` potrafi kłamać `false`, naiwny wzorzec `if (await exists())
  { read() }` sprawia, że kod nigdy nie próbuje `read()` i NADPISUJE całą dotychczasową treść
  jednym nowym wpisem. `readIfExists` (`core/utils/vaultFs.ts`) czyta NAJPIERW, więc `exists()`
  nie ma szans skłamać. Polityka przy wyniku `'unreadable'` (sygnały sprzeczne) jest
  per-miejsce: ścieżki, gdzie treść jest zbyt cenna, żeby zgadywać (transkrypt, kompresja)
  RZUCAJĄ i przerywają operację; kroniki best-effort (log audytu, `brain.log`, `CostLog.append`)
  tylko `log.warn` + pomijają TEN wpis, kontrakt "nigdy nie rzuca" zostaje.
- ⚠️ **`appendToActiveSession` dokleja ogon, nie przepisuje pliku.** Pisze przez
  `_appendSessionFile` (`adapter.append`), a pełny odczyt płaci się RAZ na ścieżkę
  (`_sessionSeqCache`/`_sessionEndsWithNewline`, inicjalizowane na pierwszym zdarzeniu sesji
  albo pierwszym po restarcie Obsidiana), nie na każde zdarzenie - naiwny read+write całego
  pliku na każde zdarzenie tury jest kwadratowy względem długości sesji i przy każdym zapisie to
  też jedno zdarzenie synchronizacji na vaultach chmurowych. Maskowanie (`maskSensitiveData`)
  obejmuje TYLKO nowo doklejany fragment, nie cały plik - bezpieczne, bo wzorce sekretów
  działają w granicach jednego, kompletnego bloku zdarzenia, nigdy w poprzek dwóch osobnych
  zapisów. Adapter bez natywnego `append` dostaje fallback przez `readIfExists` (nie goły
  `exists()+read()`).
  - **Plik skasowany Z ZEWNĄTRZ między zdarzeniami, na ciepłym cache, jest realnym ryzykiem** -
    natywny `adapter.append` na brakującym pliku wg wielu implementacji nie rzuca, tylko cicho
    zakłada plik OD NOWA (jak `fs` z flagą `a`), więc bez dodatkowej ochrony taki plik wracał
    BEZ frontmattera. Dwie warstwy obrony: (1) jeśli `adapter.append` SAM rzuci,
    `_appendSessionFile` odróżnia to przez `probeFile` - potwierdzone `'missing'` ->
    `SessionFileMissingError` (nie zwykły `Error`), inny błąd leci dalej niezmieniony; (2) gdy
    adapter cicho zakłada od nowa (nie rzuca), co `APPEND_VERIFY_EVERY_N` (=20) zdarzeń na
    ciepłym cache leci JEDEN tani `exists()` (metadane, bez odczytu treści) - jeśli plik zniknął,
    sesja zakłada się od nowa Z FRONTMATTEREM. Znane ograniczenie warstwy (2): okno trafienia
    jest 1/N - jeśli między skasowaniem a najbliższym punktem weryfikacji zdąży przejść choć
    jeden append, adapter cicho odtworzy headerless plik i weryfikacja go już nie złapie. Nie ma
    taniego sposobu to zamknąć bez pełnego `exists()` na każde zdarzenie (co zniwelowałby cały
    zysk append-only) - świadomy kompromis.
  - Wykrycie martwej ścieżki na zimnym cache i sygnał `SessionFileMissingError` lecą przez pętlę
    LOKALNĄ wewnątrz jednego `_enqueuePathWrite`, NIE przez rekurencję do
    `appendToActiveSession` - rekurencja wracałaby do kolejki TEJ SAMEJ ścieżki, gdy odtworzona
    sesja dostanie identyczną nazwę (normalne przy rozdzielczości minutowej nazw sesji), co
    byłoby samo-zakleszczeniem.
  - Golden test (bajtowa równoważność ze starym read+write, w tym plik bez końcowego `\n` i plik
    pusty) + scenariusze: `AgentMemory_append_perf.test.ts`.
- ⚠️ **`ensureMemoryStructure()` jest memoizowana per instancja.** Bootstrap (kilkanaście
  `exists` + `list` migracji legacy + odczyt `brain.md` + odczyt `.state.json`) leciałby
  bezwarunkowo na KAŻDE wywołanie, a `appendToActiveSession` (przez `startActiveSession`) woła
  go na każde zdarzenie sesji. Flaga `_structureEnsured` (pole instancji, `true` dopiero PO
  udanym przejściu całej funkcji - pad w środku nie oznacza "zrobione") sprawia, że druga i
  kolejne wołanie są no-opem. Bezpieczne, bo `basePath`/`paths` są ustawiane raz w konstruktorze
  i nigdy się nie zmieniają pod tą samą instancją.
  - **"Ufam ścieżce" ≠ "ścieżka niepusta".** Pole `activeSessionPath` ma zewnętrznych pisarzy
    poza `AgentMemory` (przełączenie zakładki, restore wielu zakładek), którzy podstawiają
    ścieżkę wprost, z pominięciem `startActiveSession`, bez sprawdzenia czy plik wciąż istnieje.
    Sekwencja "archiwizacja kasuje plik i zeruje pole u siebie -> przełączenie zakładki tam i z
    powrotem WSKRZESZA już-martwą ścieżkę" kończyłaby się błędem na pierwszym appendzie i utratą
    wiadomości usera. `startActiveSession` ufa TYLKO żywemu cache dla tej ścieżki
    (`_sessionSeqCache.has(path)` - dowód, że TA instancja realnie do niej pisała): cache
    ciepły = zero I/O; cache zimny (pierwsze użycie ścieżki przez tę instancję - świeżo
    stworzona albo wskrzeszona z zewnątrz) = jeden tani `probeFile`, a potwierdzone `'missing'`
    zeruje wskaźnik i zakłada NOWĄ sesję zamiast wywracać turę. Druga, niezależna warstwa obrony
    żyje w `appendToActiveSession` samej (gotcha wyżej) - nawet mutacja jednej warstwy nie od
    razu psuje scenariusz end-to-end.
- ⚠️ **`writeBrainNote` samo-naprawia się po padzie, dokładnie raz.** Memoizacja
  `_structureEnsured` kończy samonaprawę struktury W TRAKCIE sesji - jeśli user ręcznie skasuje
  `brain/` po tym, jak instancja już raz przeszła `ensureMemoryStructure()`, kolejny zapis
  notatki rzucałby na zawsze, mimo że jedno odtworzenie folderów by go uzdrowiło.
  `writeBrainNote` łapie pad pierwszej próby, resetuje `_structureEnsured = false`, woła
  `ensureMemoryStructure()` (realnie odtwarza foldery) i próbuje DOKŁADNIE RAZ jeszcze - nie w
  kółko, więc trwały błąd (uprawnienia, pełny dysk) i tak dochodzi do wołacza jako wyjątek,
  zamiast zawisnąć w retry-loopie. Furtka jest wąska: dotyczy tylko `writeBrainNote` - inne
  pisarze `brain/` (`MemorySaveTool`, `MemoryDeleteTool`, konsolidacja w `ArchiveWorkflow`) nie
  mają jeszcze tej samoobrony, mimo że wołają tę samą memoizowaną ścieżkę.
- ⚠️ **`_sessionEndsWithNewline` - znane ryzyko bez taniej naprawy.** Cache stanu "plik kończy
  się `\n`" jest ustawiany po każdym udanym zapisie tej instancji i inwalidowany wyłącznie przez
  koniec sesji (archiwizacja/odłożenie/martwa ścieżka). Jeśli plik zostanie zmieniony z zewnątrz
  tak, że traci końcowy `\n` (np. user otworzy go w Obsidianie i zapisze ręcznie), a cache tej
  instancji wciąż mówi "kończy się `\n`", kolejny append dokleja się bez wiodącego `\n` do
  ostatniej linii - blok zdarzenia zlewa się z poprzednią linią i parser może go nie rozpoznać
  (oczekuje nagłówka na POCZĄTKU linii). Nie ma taniego sposobu wykrycia tego bez pełnego
  odczytu treści (dokładnie tego, czego append-only miało uniknąć) - periodyczna weryfikacja
  sprawdza wyłącznie `exists()`, nie kształt ostatniej linii. Świadomie nienaprawione - zapisane
  jako znane ryzyko dla przyszłego czytelnika, nie jako TODO.
- ⚠️ **Znacznikiem pokrycia na szczeblach L1→L2 i L2→L3 jest PLIK NADRZĘDNY, nie stempel w
  źródle.** Kandydatów na paczkę L2 odsiewa `AgentMemory.listUncoveredL1s()` - L1, których nie
  wymienia żadne L2 we frontmatterze `l1_files:`; analogicznie `listUncoveredL2s()` po
  `l2_files:` w L3. **Świadomie NIE ma stempla `covered_by_l2` w plikach L1** (mimo symetrii z
  `covered_by_l1` szczebel niżej). Trzy powody: (a) crash-safety - stempel byłby DRUGIM zapisem
  po zapisie L2, więc pad między nimi zostawiałby L2 na dysku i nieostemplowane L1, czyli
  dokładnie duplikat, który to podejście likwiduje; przy backlinku "zapis L2" i "oznaczenie L1"
  to JEDNA operacja atomowa; (b) zero migracji - L2 sprzed tej naprawy też mają `l1_files`, więc
  stare dyski leczą się same; (c) zero nowych zapisów do plików pamięci usera. Znacznik był w
  danych od zawsze - brakowało wyłącznie czytacza.
  - **Granica:** L2 z pustym/brakującym `l1_files` (plik ręczny albo z bardzo starej wersji) nie
    pokrywa NICZEGO - jego L1 wrócą do puli i dostaną drugie streszczenie. Pojedyncze
    przeliczenie jest tańsze niż zgadywanie pokrycia po dacie. Nieczytelny plik L2/L3 nie liczy
    się jako pokrycie (`_getUnconsolidatedItems` loguje `warn` i leci dalej) - świadomie
    non-blocking, bo trwałe zablokowanie konsolidacji jednym uszkodzonym plikiem byłoby gorsze
    niż jeden duplikat.
  - Strażnik: `ArchiveWorkflow_kaskada_szczeble.test.ts` (w tym "crash w połowie" z obu stron
    zapisu i "stary dysk z duplikatami").
- ⚠️ **Kolizja nazw notatek/sesji korzysta z jednej wspólnej pętli.** `findFreeCollisionPath`
  (`collisionSuffix.ts`) jest wołana z każdego miejsca, które tworzy plik pod nazwą, jaka może
  już istnieć (`startActiveSession`, `discardActiveSession`, `saveSession`, `writeBrainNote`,
  `writePendingRescue`, `archiveBrainNote`, dedup w `ArchiveWorkflow`) - dokłada sufiks
  `_2`.._50` przy kolizji i BLOKUJE (rzuca, nie zapisuje) po wyczerpaniu prób, zamiast ciszej
  zapisać nad nazwą, o której właśnie stwierdzono "zajęta". Pętla wchodzi w kolejną iterację
  TYLKO gdy sprawdzona nazwa realnie istnieje (`probeFile(...) !== 'missing'`) - nie zostawia
  zmiennych na nazwie, którą przed chwilą uznała za zajętą. `ArchiveWorkflow.applyDedup` woła
  pętlę wewnątrz kolejki per-ścieżka (`_enqueuePathWrite`), kluczowanej BAZOWĄ (nie-sufiksowaną)
  nazwą - dwa równoległe zapisy pod tę samą bazową nazwę realnie się serializują, zamiast
  szukać wolnej nazwy poza kolejką i zostawiać okno wyścigu między "nazwa wolna" a zapisem.
- ⚠️ **Pliki sesji są maskowane PRZY ZAPISIE, jednym pisarzem.** `AgentMemory._writeSessionFile
  (path, content)` to jedyna droga zapisu pliku sesji (`startActiveSession`,
  `appendToActiveSession`, `saveSession`, `archiveActiveSession`, `discardActiveSession`,
  migracja płaskiego `sessions/` -> `sessions/archive`) - `adapter.write(path,
  maskSensitiveData(content))`. Maskujemy WYŁĄCZNIE string idący na dysk; obiekty wiadomości w
  pamięci zostają nietknięte, żeby model w tej samej turze dalej widział, co naprawdę wróciło z
  narzędzia - maska zmienia ZAPIS rozmowy, nie jej przebieg. Zakres jest świadomie wąski:
  `brain*`, `summaries/L1..L3` i `.state.json` mają własnych pisarzy i przez ten writer nie
  przechodzą. `maskSensitiveData` jest idempotentna, więc wielokrotne przepisywanie tego samego
  pliku niczego nie psuje.

---

## Testy

Memory v3 critical path ma testy w:

- `modules/memory/AgentMemory.test.ts`
- `modules/tools/MemoryV3Tools.test.ts`
- `modules/memory/SaveSessionWorkflow.test.ts`
- `modules/memory/ArchiveWorkflow.test.ts`
- `modules/memory/ArchiveWorkflow_kaskada_szczeble.test.ts` - pokrycie L1→L2 i L2→L3 backlinkiem,
  crash z obu stron zapisu, stary dysk z duplikatami, L2 bez `l1_files`
- `modules/memory/MigrationV3.test.ts` + `MigrationV3_rozdrabnianie.test.ts`
- `modules/memory/RetrievalEngine.test.ts` - app-first `getMarkdownFiles`/`metadataCache` +
  fallback, sufit skanu keyword, dedup skanów równoległych
- `modules/memory/AgentMemory_self_append.test.ts` - self-append na `readIfExists`
- `modules/memory/AgentMemory_append_perf.test.ts` - append zamiast read+write (licznik operacji
  + golden bajtowy), memoizacja `ensureMemoryStructure`, zimny/ciepły cache w
  `startActiveSession`, plik skasowany między zdarzeniami
- `modules/memory/AgentMemory_kolizja_nazw.test.ts` - `findFreeCollisionPath` przy każdym z
  wołaczy
- `modules/memory/CostLog.test.ts`
- `modules/memory/activeSessionFormat.test.ts` - round-trip pisarz/czytnik, plik MIESZANY, CRLF,
  legacy bez escapów
- `modules/memory/BrainIndex.test.ts` - sekcje "Na teraz", sekcje obce
- `modules/memory/MemoryAccessGuard.test.ts`
- `modules/memory/collisionSuffix.test.ts`
- `modules/memory/EmbeddingHelper.test.ts`
- `modules/memory/workPrompts.test.ts`

---

## Powiązane

- `modules/prompts/CLAUDE.md` - `fenceUntrusted`, ogrodzenie pamięci wstrzykiwanej do promptu
- `modules/chat/CLAUDE.md` - `RollingWindow` (okno tokenów), `ConsolidationProgressModal`,
  `consolidationRunner` (kontroler produkcyjnego triggera konsolidacji), restore aktywnych sesji
- `modules/agent-loop/CLAUDE.md` - `toolTranscriptSanitizer`
- `modules/tools/CLAUDE.md` - `SearchTool`, `MemorySaveTool`, `MemoryDeleteTool`, prymitywy
  `read`/`list`
