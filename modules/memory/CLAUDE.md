# modules/memory/

`formatSessionEvent` redaguje obrazowe data-URL (`data:image/<mime>;base64,<b64>`) we wszystkich polach zdarzeń po serializacji, także w zagnieżdżonych stringach JSON, `tool_calls` i `content` wyników narzędzi. Wyjątek: `content` zdarzeń `user_message` i `agent_message` pozostaje bajt w bajt nietknięte. `seq` pozostaje bez zmian. Replacer serializacji dodatkowo redaguje klucze obiektowe `base64` ze stringiem długości co najmniej 16 (z MIME lub jako binary), w tym surowy wynik `generate_image` w `mcp_call.result`, także po `toJSON`. Nie rozpoznaje pól `base64` ukrytych w stringu JSON: to świadome ograniczenie, nie heurystyka. Obraz narzędzia dla modelu musi przejść przez kontrakt mediów opisany w `modules/tools/CLAUDE.md`; surowe pole `base64` w innym wyniku nie jest obrazem dla modelu i nie podlega tej gwarancji.

Zdarzenie `agent_loop_partial` zapisuje opcjonalne `question`; przy odczycie jego treść i rozstrzygnięcie są dodawane jako oznaczona część wiadomości dla modelu. Dorobek snapshotu pozostaje osobny.

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

Terminalne pytanie wyniku suba (`question`: tekst i `no-answer` lub `cancelled`) jest opcjonalnym polem eventu aktywnej sesji. Odczyt przywraca wyłącznie dane historii, bez oczekiwania, zegara ani możliwości odpowiedzi. Stare bloki bez tego pola pozostają bez zmian; niepoprawne pole jest pomijane.

## Co tu jest

```text
modules/memory/
├── index.ts                # publiczne drzwi (barrel) - jedyny legalny import z zewnątrz modułu
├── AgentMemory.ts           # struktura folderów, brain.md, sesje active/archive, summaries
├── brainSections.ts         # rejestr nagłówków brain.md w OBU językach (PL/EN) - BrainLocale, sectionHeading/naTerazHeading (pisarz), sectionKeyOf/naTerazKeyOf/isNaTerazHeading (czytnik, rozpoznaje oba zestawy), detectBrainLocale/resolveBrainLocale/uiBrainLocale (język PLIKU vs język UI). Jedyne źródło prawdy dla BrainIndex.ts i MigrationV3.ts - zobacz sekcję "Język brain.md" niżej
├── BrainIndex.ts            # buildBrainIndex(): kategoryzowany indeks brain.md z metadanych brain/*.md, w języku PLIKU (`locale` WYMAGANY - patrz brainSections.ts)
├── MemoryAccessGuard.ts      # strict per-agent path guard dla brain/
├── collisionSuffix.ts       # findFreeCollisionPath() - jedna wspólna pętla "wolna nazwa przy kolizji", wołana z kilku miejsc w AgentMemory.ts. Wewnętrzny, nie w barrelu
├── SaveSessionWorkflow.ts    # /save session: propozycje notatek + archiwizacja aktywnej sesji
├── consolidationStatus.ts    # JEDNO liczydło progów konsolidacji - `resolveConsolidationThresholds`/`shouldTriggerConsolidation` (sygnatury zamrożone, importuje je przy buildzie prywatna wtyczka deweloperska w repo `pkm-assistant-harness` - patrz gotcha niżej), plus (od auto-konsolidacji opcjonalnej, 2.2.9) `CONSOLIDATION_DEFAULTS`, `resolveAutoConsolidationPolicy`, `planAutoConsolidation` - polityka DWÓCH wyłączników usera i plan auto-triggera po zapisie sesji. Wołane przez `SaveSessionWorkflow.applyDecision` (wewnątrz modułu, deep-import) i przez `consolidationRunner.ts` w `modules/chat` (przez barrel - patrz Public API). Status konsolidacji dla CLI Obsidiana mieszka od 2026-09-20 poza tym repo
├── ArchiveWorkflow.ts        # dedup brain/ + L1/L2/L3 user-reviewed consolidation
├── ConsolidationRun.ts       # stan przebiegu konsolidacji (plan kroków, statusy, retry, koszt) - czysty node
├── MemoryOpsCenter.ts        # rejestr JEDNEGO aktywnego przebiegu + subskrypcja dla UI
├── consolidationLabels.ts    # etykiety/ikony/czas/koszt/podsumowanie przebiegu (czyste, dzielone przez pasek statusu i modal)
├── ConsolidationSnapshot.ts   # prune() - sprząta kopie snapshotu po starszej wersji pluginu
├── MigrationV3.ts            # backup-first migracja brain.md v2 -> v3
├── StateManager.ts           # .state.json: aktywne sesje + liczniki, kolejka RMW
├── gitConflict.ts            # splitGitConflict: tekst -> dwie pełne strony, dla D1 i kolejnych paczek M2
├── brainConflict.ts          # M2 D3: scalanie w RAM, bezpiecznik ogrodzeń i dwie samokontrole
├── brainConflictWrite.ts     # M2 D3: zweryfikowana kopia oryginału przed zapisem naprawy
├── stateConflict.ts          # czyste mergeStateConflict, opcjonalny spis istniejących sesji
├── sessionOwnership.ts      # DeviceId, parseDeviceId, sessionOwnership, ForeignSessionError (publiczny barrel)
├── StateCorruptionError.ts   # publiczny typ błędu nienaprawialnego JSON-a, bez treści pliku
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
| `readBrainContent(text)` | Projekcja indeksu po konflikcie gita w RAM; bez I/O, używana również przez profil agenta. |
| `StateCorruptionError` | Błąd nienaprawialnego JSON-a; niesie `agentName` z nazwy katalogu agenta, bez ścieżki i treści. Czat rozpoznaje go w `safeErrorText`. |
| `IdleScheduler` | Pure decyzja "czy zapisać po bezczynności" (wpinany w `modules/chat`). |
| `SaveSessionWorkflow` | `/save session`: user-review, tworzenie notatek, archiwizacja sesji. |
| `ArchiveWorkflow` | Automatyczna konsolidacja po progach: brain/ dedup, L1, L2, L3. Jeden tor: `runWithRun(consolidationRun)` (generuje propozycje wszystkich paczek, nic nie zapisuje) + `applyStepDecision()` (zapisuje po decyzji usera) + `generateGatedSteps()` (zdejmuje kłódkę z L2/L3 dopiero gdy L1 są rozstrzygnięte) - generacja oddzielona od zapisu. |
| `parseNaTerazSections`, `naTerazSectionKey` | Pure helpery sekcji "Na teraz" brain.md, czytane przez UI panelu Pamięć, `MemorySaveTool` i `modules/chat/naTerazUpdate.ts` (normalizacja sekcji `BrainUpdate` w oknie review `/save session`). |
| `sectionKeyOf` (z `brainSections.ts`) | Dokładne dopasowanie nagłówka indeksu w OBU językach → `BrainSectionKey`, albo `null`. Konsument spoza modułu: `modules/chat/saveSessionSectionLabel.ts` (etykieta sekcji w oknie review, w BIEŻĄCYM języku interfejsu, niezależnie od języka pliku). |
| `ConsolidationRun`, `buildConsolidationPlan`, `STEP_STATUS`, `STEP_KIND`, `normalizeUsage` | Stan jednego przebiegu konsolidacji - plan paczek z liczników, maszyna stanów kroku. Zero UI, zero Obsidiana. `buildConsolidationPlan(counts, {include})` - drugi parametr OPCJONALNY (`{sessions, dedup}`, domyślnie oba `true` = zachowanie sprzed konsolidacji opcjonalnej): `include.dedup:false` wycina krok DEDUP, `include.sessions:false` wycina L1 i przez to (kaskada) też L2/L3. |
| `resolveConsolidationThresholds`, `planAutoConsolidation` | Progi + plan auto-triggera konsolidacji (`consolidationStatus.ts`) - jedyne dwa eksporty tego pliku w barrelu. Konsument obu: `consolidationRunner.ts` w `modules/chat` (liczy próg dedupu jednym liczydłem; `planAutoConsolidation` też jako obrona w głąb, gdy `source:'auto'` przyjdzie bez `include`). `CONSOLIDATION_DEFAULTS`/`resolveAutoConsolidationPolicy` ZOSTAJĄ wewnątrz modułu (zero czytelnika spoza `modules/memory/`, sprawdzone grepem) - patrz gotcha „Jedno liczydło progów konsolidacji". |
| `memoryOpsCenter` (singleton), `OPS_EVENT` | Rejestr jednego aktywnego przebiegu. `startRun/getActiveRun/finishRun/subscribe/requestOpenModal`. Drugi trigger przy aktywnym przebiegu NIE startuje drugiego - zwraca bieżący i prosi o modal. |
| `stepLabel`, `stepDetail`, `stepStatusIcon`, `stepStatusLabel`, `stepDurationMs`, `isFallbackStep`, `formatDuration`, `formatUsageLine`, `statusBarLine`, `buildRunSummary`, `summaryToText`, `planToText` | Warstwa OPISOWA przebiegu (`consolidationLabels.ts`) - jedno źródło etykiet dla paska statusu i modalu przebiegu. Czyste funkcje, zero DOM. |
| `MigrationV3` | Migracja v2 -> v3: najpierw `memory.v2.backup/`, potem notatki `brain/`. |
| `streamToComplete` | Stream -> complete z opcjonalnym `{onChunk, signal, watchdog}`. |
| `RetrievalEngine` | Silnik narzędzia `search` - patrz sekcja "Odczyt pamięci" niżej. |
| `CostLog`, `EmbeddingHelper` | Koszt operacji memory/sub-agent + helper wektoryzacji. |
| `factoryWorkPrompt(kind, locale?, brainLocale?)` + typ `WorkPromptKind` | Fabryczne prompty robocze (`workPrompts.ts`), owned przez memory. FUNKCJA, nie stałe - patrz gotcha "prompty robocze idą za językiem interfejsu". `locale` wybiera PROZĘ (PL/EN), `brainLocale` (domyślnie `uiBrainLocale()`) wybiera, jakimi nagłówkami wypełnić placeholdery `{{sec_*}}`/`{{na_teraz_*}}` w tekście `save_session` - dwa NIEZALEŻNE wymiary. |
| `factoryWorkPromptRaw(kind, locale?)` | Ten sam tekst fabryczny, BEZ podstawienia placeholderów `{{sec_*}}`/`{{na_teraz_*}}` (dla `archive`/`summary` identyczny z `factoryWorkPrompt`, bo ich nie mają). Jedyny wołacz: Ustawienia → Prompt, guzik „Wstaw fabryczny" (`modules/shell/prompt_settings.ts`) - pisze do GLOBALNEGO nadpisania dzielonego przez wszystkich agentów, więc MUSI zostawić placeholdery surowe; podstawienie nagłówkami WŁAŚCIWEGO agenta należy do miejsca użycia (`resolveWorkPrompt` + `fillBrainSectionPlaceholders`), nie do chwili kliknięcia guzika z językiem UI z tamtej chwili (recenzja niezależna, 2026-09-23). |
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

### Język brain.md - rodzi się w języku UI, zostaje w nim NA ZAWSZE

**Decyzja właściciela (19.09):** `brain.md` NOWEGO agenta rodzi się w języku interfejsu (PL
albo EN) i zostaje w nim do końca życia pliku - nawet gdy user PÓŹNIEJ przełączy język UI.
Istniejących plików NIGDY nie migrujemy (żadnej podmiany nagłówków w istniejącej treści).
Wariant "nagłówki za językiem UI na żywo" jest ODRZUCONY - user, który przełącza UI, nie budzi
się z przepisanym plikiem.

Jedyne źródło prawdy: `modules/memory/brainSections.ts` (`BrainLocale = 'pl' | 'en'`, NIE mylić
z językiem interfejsu na żywo, `getLocale()`):

- `BRAIN_SECTION_HEADINGS`/`NA_TERAZ_HEADINGS` - oba zestawy nagłówków (PL i EN) dla obu
  rodzajów sekcji, per klucz (`BrainSectionKey`/`NaTerazKey`).
- `sectionHeading(key, locale)`/`naTerazHeading(key, locale)` - PISARZ: nagłówek w podanym
  języku PLIKU.
- `sectionKeyOf(line)` - CZYTNIK: dokładne dopasowanie nagłówka indeksu w OBU językach na raz
  → klucz kategorii, albo `null`. Sekcja o nagłówku z DOWOLNEGO z dwóch zestawów jest
  "zarządzana" (nie foreign) - używają tego `parseForeignSections`/`parseManualIndexLines`/
  `AgentMemory._brainHasManualContent`.
- `naTerazKeyOf(line)`/`isNaTerazHeading(line)` - to samo dla sekcji "Na teraz"/"Right now".
  Separator między "Na teraz"/"Right now" a słowem klucza jest OPCJONALNY (dwukropek/myślnik/
  półpauza/pauza, albo w ogóle nic), a kotwica PO rozpoznanym słowie klucza jest LUŹNA (`\b`,
  nie koniec linii) - dopuszcza dowolny ogon, np. "## Na teraz: User (Kuba)" nadal rozpoznaje
  `user`. Ręcznie dopisana sekcja usera bez rozpoznanego słowa klucza zaraz PO separatorze
  ("## Na teraz coś tam", "## Na teraz: Vault") NIE jest łapana, jest zwykłą sekcją obcą.
- `detectBrainLocale(content)` - pierwszy napotkany nagłówek SWOISTY dla języka (np. `##
  Bieżące`/`## Current`, `## Preferencje`/`## Preferences`) rozstrzyga; nagłówki WSPÓLNE
  (`## User`, `## Workflow`) same nie rozstrzygają; brak sygnału → `null`.
- `resolveBrainLocale(content, uiLocale)` = `detectBrainLocale(content) ?? uiLocale` - JEDYNE
  miejsce, gdzie treść pliku decyduje o języku zapisu DLA NOWEGO/SAMONAPRAWIANEGO pliku.
  Wołane przez `AgentMemory.getBrain()` (samonaprawa brakujących sekcji) i
  `AgentMemory.rebuildBrainIndex()` (KAŻDY rebuild). **`MigrationV3` NIE woła tej funkcji** -
  `applyPlan` liczy `detectBrainLocale(originalBrain) ?? 'pl'` WPROST (fallback `'pl'` na
  sztywno, nie `uiBrainLocale()`): prawdziwy v2 istniał wyłącznie sprzed dwujęzycznego UI, więc
  jego treść jest ZAWSZE polska niezależnie od bieżącego języka interfejsu w chwili migracji -
  `resolveBrainLocale`'owy fallback na UI dałby angielskie nagłówki nad polską treścią, gdyby
  user akurat miał UI po angielsku. Wykryty język ma i tak pierwszeństwo przed `'pl'` - inaczej
  plik w KSZTAŁCIE v3, którego `looksLikeV3Index` nie rozpoznał (bez folderu `brain/`, bez
  sekcji "Right now", bez linków `[[brain/...]]` - świeży klon/desync), trafiałby w tę samą
  ścieżkę migracji i zostawał przepisany na polskie nagłówki mimo poprawnie rozpoznanej EN
  treści (naprawione w dogrywce rundy 2 recenzji niezależnej).
- `uiBrainLocale()` - `getLocale()` zwężone do `BrainLocale` (`'pl'` → `'pl'`, wszystko inne →
  `'en'`), most między światem UI a światem pliku. Woła się go WYŁĄCZNIE jako fallback dla
  nowego pliku albo treści nierozstrzygającej - nigdy jako pierwszeństwo nad wykrytym językiem
  istniejącej treści.

`BrainIndex.buildBrainIndex({..., locale})` ma `locale: BrainLocale` **WYMAGANY** (świadomie
bez domyślnej wartości - jak `resolveWorkPrompt`/`factoryWorkPrompt`, żeby żaden wołacz nie
dostał po cichu PL tam, gdzie miał na myśli EN) i emituje WYŁĄCZNIE nagłówki tego jednego
języka. `indexSectionHeadings(locale)` zastępuje dawną stałą `INDEX_SECTIONS` (była PL-only) -
lista nagłówków indeksu w kolejności emisji, dla podanego języka.

**Plik mieszany (nie powinien powstać, ale gdyby)** - dwie sekcje tej samej kategorii w OBU
językach naraz - `parseManualIndexLines` kluczuje ręczne linie po `BrainSectionKey`, NIE po
literale nagłówka, więc obie sekcje scalają się pod JEDNYM kluczem i wychodzą jako JEDNA sekcja
w wykrytym języku przy najbliższym rebuildzie.

### `brain.md` jako indeks

`brain.md` zaczyna się od dwóch sekcji krótkoterminowych - `## Na teraz: User`/`## Right now:
User` (nad czym user pracuje teraz) i `## Na teraz: Środowisko`/`## Right now: Environment`
(bieżący stan projektu/vaulta), plain-text bullety zmiennego stanu, NIE linki i NIE trwałe
fakty (`NA_TERAZ_MAX_ENTRIES=10` w `BrainIndex.ts` - twardy trim najstarszych + log). Pod nimi
jest kategoryzowany indeks (nagłówki w tabeli niżej są ADRESY PL - plik EN niesie ich angielskie
odpowiedniki, `brainSections.ts`, sekcja wyżej):

- `## Bieżące` / `## Current` - kilka najnowszych aktywnych `project_context`,
- `## User` - notatki `user` (nagłówek wspólny dla obu języków),
- `## Preferencje` / `## Preferences` - notatki `agent_rule`,
- `## Workflow` - notatki `skill_hint` (nagłówek wspólny dla obu języków),
- `## Projekty i referencje` / `## Projects and references` - starsze `project_context` + `reference`.

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
(`BrainIndex.ts`) wyciąga z KAŻDEJ sekcji zarządzanej (dowolny z dwóch zestawów nagłówków,
`sectionKeyOf` w `brainSections.ts`) jej niepuste linie,
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

M2 D5: kopia nadal powstaje obok indeksu jako
`.pkm-assistant/agents/<safeName>/memory/brain.md.bak`; start pluginu dopisuje do
istniejącego `.gitignore` regułę `.pkm-assistant/agents/*/memory/brain.md.bak`.
Nie zmienia to zapisu kopii ani formatu pamięci. Plik już śledzony nadal pozostaje
w indeksie gita - zdjęcie go ze śledzenia należy do właściciela vaulta, plugin nie wykonuje gita.

**Fabryczne prompty robocze** (`workPrompts.ts`, owned przez memory, żeby workflow miał własne
defaulty bez cyklu memory→agents): `factoryWorkPrompt('save_session' | 'archive' | 'summary')`.
Konsumowane przez `resolveWorkPrompt(agent, key, settings, factory)` (`core/`) - łańcuch
**per-agent > global (Settings→Prompt) > factory**. Override musi zachować kształt outputu
(JSON `new_notes`, `{{LEVEL}}`, `merges`/`deletions`) - parsery workflow na tym stoją.

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

**Zdarzenia active dopisuje `_appendEventUnderLock`**, pod kolejką adaptera, z numeracją
`**seq:**`: przez `appendToActiveSession`, `appendSessionEvent` i `ensureActiveSessionEpoch`.
`saveSession` dopisuje brakujący ogon jako eventy, ale aktualizacja metadanych nadal wykonuje
pełny zapis pliku; nie zamienia go na transkrypt.
Transkrypt (`## User`/`## Assistant`) to widok POCHODNY: powstaje przy `archiveActiveSession`
(konwersja event-log -> format transkryptu, `formatToMarkdown`). Format `sessions/archive/`
jest transkryptem od zawsze - konsolidacja L1/L2/L3 i `parseSessionFile` go czytają bez zmian.

Kontrakt pliku żyje w JEDNYM miejscu, `activeSessionFormat.ts`: `ACTIVE_SESSION_FORMAT_VERSION`,
`escapeActiveText`/`unescapeActiveText`, `formatSessionEvent` (pisarz, event-log),
`parseActiveSession` (czytnik formatu event-log + transkryptu + plików MIESZANYCH - w
produkcji plik po pierwszym autozapisie bywał mieszanką obu), `KNOWN_ROLES`, `EVENT_FIELDS`,
`parseFrontmatter`, `parseSessionEpoch` i `resolveSessionEpoch`. `sessionParser.ts` re-eksportuje `KNOWN_ROLES` i importuje
escape/unescape stąd - jedno źródło pary regexów, kierunek `sessionParser -> activeSessionFormat`,
bez cyklu.

Nowy plik `sessions/active/` zapisuje `epoch` jako 32 znaki hex z 16 losowych bajtów
`crypto.getRandomValues`. `parseFrontmatter` czyta tylko frontmatter; `parseActiveSession`
używa resolvera opisanego niżej (format v4). Brak poprawnej epoki daje `null`. Odczyt
starych plików nie dopisuje pola ani nie migruje treści. Jawne `ensureActiveSessionEpoch`
dopisuje epokę jako event, bez zmiany istniejących bajtów (kontrakt P3 poniżej). `AgentMemory.sessionEpoch` jest
zsynchronizowane z `activeSessionPath`; bezpośrednia zmiana ścieżki zeruje epokę, a
`setActiveSessionIdentity(path, epoch)` wiąże ścieżkę z wartością potwierdzoną z pliku.
`appendSessionEvent` wewnątrz kolejki zapisu odczytuje efektywną epokę resolverem i porównuje ją z przekazaną oczekiwaną epoką; niezgodność przerywa zapis.
Tworzenie przez `startActiveSession`, samonaprawa i osobna droga `saveSession` zapisują epokę.
Jeśli `saveSession` czeka na odczyt lub zapis, późniejsza zmiana tożsamości pamięci
blokuje przypisanie epoki zapisywanego pliku do innej sesji, także przy ponownym użyciu
tej samej ścieżki.

**Format v3 (2026-09): pola `**tool_call_id:**`/`**tool_calls:**` - round-trip narzędzi
przez restart Obsidiana.** Bug: po restarcie pluginu odtworzona sesja gubiła
`tool_call_id` KAŻDEGO wyniku narzędzia (log `sanitizeToolTranscript`:
`drop orphan tool message (tool_call_id="undefined")`), bo event-log (v2) nie miał gdzie
zapisać ani `tool_call_id` (event `tool_result`), ani `tool_calls[]` asystenta (event
`agent_message`, gdy odpowiedź wołała narzędzia). `EVENT_FIELDS` dostało dwa nowe,
OPCJONALNE pola:
- `**tool_call_id:**` - string, na evencie `tool_result` (`chat_streaming._chatBeforeContinue`
  podaje `tool_call_id: tr.id`, gdzie `tr.id` = `toolCall.id` z rundy narzędzi, NIE nazwę
  narzędzia - starsza wersja pisała tu błędnie `tool: tr.id`, czyli id pod złą etykietą).
- `**tool_calls:**` - JSON (kształt OpenAI: `{id, type, function:{name, arguments}}[]`), na
  evencie `agent_message`, TYLKO gdy runda faktycznie wołała narzędzia (`asstMsg.tool_calls`
  niepuste - pusta tablica jest truthy, więc bramka jest jawna, inaczej pole leciałoby na
  KAŻDEJ odpowiedzi jako `[]`).

`ActiveSessionMessage.toolCallId?: string` / `toolCalls?: SessionToolCall[]` są OPCJONALNE -
klucz jest NIEOBECNY (nie `null`) na wiadomości bez tych pól (legacy/v1/v2, albo zwykła
wiadomość tekstowa), więc stare porównania `{role, content, seq}` (`t.deepEqual`) nie widzą
zmiany kształtu. `SessionToolCall` żyje w `activeSessionFormat.ts` jako minimalny kształt
STRUKTURALNY (nie import z `modules/chat` - kierunek zależności zostaje: memory nie zna
chatu), z index signature (`[key: string]: unknown`) lustrzaną do `ToolCall`
(`modules/chat/chat/RollingWindow.ts`) - bez niej TS odmawia przypisania na granicy modułów
(typ z index signature wymaga jej też po stronie źródła).

⚠️ **Downgrade NIE jest bezpieczny - plik v3 czytany starszym pluginem trwale się psuje.**
Starszy parser (sprzed v3) nie zna etykiet `**tool_call_id:**`/`**tool_calls:**` - jego
`FIELD_END_LOOKAHEAD` rozpoznaje koniec pola WYŁĄCZNIE po znanych etykietach ze SWOJEJ,
starszej listy `EVENT_FIELDS`. Blok `tool_result` zapisany przez v3 (`**result:**` + zaraz
potem `**tool_call_id:**`) czyta się starym parserem jako JEDNO pole `result`, które
POŁYKA cały ogon `**tool_call_id:**\n\ncall_1` jako część swojej TREŚCI - zweryfikowane
bezpośrednio (stary parser na pliku v3): `content` wychodzi jako
`"tresc\n\n**tool_call_id:**\n\ncall_1"` zamiast `"tresc"` + osobnego pola id. To samo
dotyczy `**tool_calls:**` w evencie `agent_message`. Ponieważ `archiveActiveSession`
PRZEPISUJE archiwum z `parsed.messages` i KASUJE oryginał, downgrade + dowolna archiwizacja
tej sesji (ręczna, `/save session`, próg konsolidacji) zamraża tę pomyłkę na stałe w
`sessions/archive/` - nie ma już z czego odtworzyć czystej treści. Release notes MUSZĄ
ostrzec: nie instaluj starszej wersji pluginu na vaultcie, w którym są aktywne sesje zapisane
nowszą wersją (v3+); jeśli trzeba się cofnąć, zrób to na kopii vaulta albo dokończ/zarchiwizuj
najpierw wszystkie aktywne sesje na nowej wersji.

⚠️ **`agent_message` z PUSTĄ `content` (typowa odpowiedź tool-calling: sam `tool_calls`, zero
tekstu) liczy się jako wiadomość TYLKO odkąd `parseActiveSession` sprawdza też
`**tool_calls:**`, nie tylko `content`/`result`/`prompt`.** Bez tej gałęzi CAŁY blok assistant
(razem z jego `tool_calls`) znikał z restore - nie tylko `tool_call_id` samego wyniku
narzędzia, tak jak w logu z 2026-08-09 ("every tool call ... was cut"). Ta sama gałąź NIE
obejmuje `tool_result` bez treści - pusty wynik narzędzia bez dowodu w logach zostaje jak
dotąd (pomijany), żeby nie zmieniać zachowania bez ewidencji.

Restore w `modules/chat/chat/chat_session.ts` (`_restoreActiveSession`) MUSI przekazać
`{tool_call_id, tool_calls}` jako TRZECI argument `RollingWindow.addMessage()` - samo
odzyskanie pól przez `parseActiveSession` nie wystarcza, bo `addMessage(role, content)` bez
metadanych je odrzuca (`chat/chat_session.test.ts`, `BUG C1`).

### Konsolidacja

`ArchiveWorkflow` odpala flow user-review, JEDEN tor: `runWithRun(consolidationRun)` generuje
propozycje wszystkich paczek (pętla okien po `batchSize` w posortowanym `sessions/archive`) i
nic nie zapisuje; `applyStepDecision(run, stepId, decision)` zapisuje po decyzji usera
(odrzucenie = `skipped`, nie błąd); `generateGatedSteps(run)` zdejmuje kłódkę z L2 dopiero, gdy
WSZYSTKIE L1 są rozstrzygnięte (`failed` ≠ rozstrzygnięty - L2 czeka na "Ponów"/"Pomiń"), a przy
mniej niż `batchSize` plików L1 na dysku pomija L2 i L3. Fail jednej paczki nie zatrzymuje
pozostałych.

- dedup `brain/`: trigger po `brainNotesLimit` (domyślnie 20, `CONSOLIDATION_DEFAULTS.brainNotesLimit`) notatkach, auto-bump +10 gdy user odrzuci merge,
- L1: po `sessionThreshold` (domyślnie 10, `CONSOLIDATION_DEFAULTS.sessionThreshold`) zarchiwizowanych sesjach; sesje zostają,
- L2: po `batchSize` (domyślnie 5) L1; usuwa pokryte sesje z archive, L1 zostają,
- L3: po `batchSize` L2; usuwa pokryte L1, L2 zostają,
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

#### Auto-konsolidacja opcjonalna (2.2.9)

Auto-trigger konsolidacji po `/save session` (`SaveSessionWorkflow.applyDecision` →
`save_session.ts` → `startConsolidationRun({source:'auto'})`) jest OPCJONALNY na DWÓCH
niezależnych wyłącznikach usera (Ustawienia → Pamięć i kontekst → „Konsolidacja pamięci"),
**oba domyślnie WYŁĄCZONE**: `memoryV3AutoConsolidateSessions` (gałąź sesje/L1-L3) i
`memoryV3AutoConsolidateBrain` (gałąź notatek brain/, dedup). Ręczna konsolidacja (guzik
„Podsumuj rozmowy" w profilu agenta, `source:'manual'`) NIE czyta tej polityki - działa zawsze,
pełny plan, jak przed tą zmianą.

- `planAutoConsolidation(state, brainNotesCount, settings)` (`consolidationStatus.ts`) łączy
  progi (`resolveConsolidationThresholds`) z polityką (`resolveAutoConsolidationPolicy`).
  ⚠️ **DECYZJA recenzji niezależnej (2026-09-22): `include.sessions`/`include.dedup` wymagają
  OBU warunków - wyłącznik WŁĄCZONY *I* próg PRZEBITY** (`includeSessions = policy.sessions &&
  sessionsDue`, `includeDedup = policy.brain && brainDue`, `trigger = includeSessions ||
  includeDedup`). Pierwsza wersja tej funkcji (ten sam dzień, wcześniejszy commit) dawała
  `include = {sessions: policy.sessions, dedup: policy.brain}` bez względu na „due" - przy OBU
  wyłącznikach włączonych i triggerze z gałęzi sesji, `dedup:true` wchodziło do planu, CHOĆBY
  próg notatek brain/ wcale nie był przebity, i odwrotnie: przy triggerze z gałęzi brain,
  `sessions:true` wchodziło do planu mimo że sesje NIE były due - user, który WŁAŚNIE odrzucił
  propozycję L1 (licznik wyzerowany), dostawał ją z powrotem przy najbliższym zapisie, gdy tylko
  próg DRUGIEJ gałęzi się przebił. Łamało to obietnicę UI „odrzucona propozycja nie wraca przy
  następnym zapisie". Regresja pokryta testem `consolidationStatus.test.ts` („oba ON, L1 świeżo
  odrzucony (licznik 0) + brain due (25 notatek) -> include BEZ sesji").
- `SaveSessionWorkflow.applyDecision` zwraca `shouldTriggerArchive` (= `plan.trigger`) ORAZ
  `consolidationInclude` (= `plan.include`), ZAWSZE (nie tylko przy `shouldTriggerArchive`).
  `save_session.ts` przekazuje `include: result.consolidationInclude` do
  `startConsolidationRun` w bramce `if (result.shouldTriggerArchive)`. Strażnikiem NIE jest już
  test po źródle (usunięty N4 recenzji rundy 3 - przypinał tekst kodu regexem, bez odpalenia
  realnej logiki) - skutek KOŃCOWY jest sprawdzony behawioralnie w
  `modules/chat/consolidationRunner.test.ts`, w tym przez obronę w głąb niżej (runner liczy
  `include` sam, gdyby ten handler przestał je przekazywać).
  `buildConsolidationPlan(counts, {include})` (`ConsolidationRun.ts`) - drugi parametr
  OPCJONALNY, brak = pełny plan (zachowanie ręcznej konsolidacji i sprzed tej zmiany).
  `include.dedup:false` wycina krok DEDUP; `include.sessions:false` wycina L1 i przez kaskadę
  (L2/L3 liczą się z L1) też L2/L3. Typ `include` (`{sessions, dedup}`) jest JEDEN -
  `ConsolidationRun.ts` eksportuje `BuildPlanInclude` jako alias `AutoConsolidationInclude`
  z tego pliku, nie osobną, równoległą deklarację.
- **Obrona w głąb w `consolidationRunner.startConsolidationRun`**: gdy `source:'auto'` przyjdzie
  BEZ jawnego `include` (wołacz zapomniał go przekazać, albo bezpośrednie wywołanie z testu/
  skryptu), runner liczy politykę SAM przez `planAutoConsolidation` (ten sam wynik co
  `SaveSessionWorkflow`) zamiast cicho spaść na pełny plan. `source:'manual'` bez `include`
  zostaje pełnym planem - guzik ręczny NIE czyta wyłączników.
- **Podłoga limitu notatek `brain/`, nie pierwszeństwo** (świadoma zmiana zachowania - patrz
  gotcha „Jedno liczydło progów konsolidacji" niżej): `resolveConsolidationThresholds` liczy
  efektywny `brainNotesLimit` jako `Math.max(state.brain_notes_limit, ustawienie globalne ||
  CONSOLIDATION_DEFAULTS.brainNotesLimit)`, NIE „state ma zawsze pierwszeństwo" jak do 2.2.8
  włącznie. Wartości `<= 0`/`NaN` z ustawień (np. ręcznie uszkodzony `data.json`) liczą się jako
  NIEUSTAWIONE, nie jako realny próg (`firstPositive()` - liczba ujemna jest w JS truthy, więc
  goły `Number(x) || fallback` przepuszczał `-5` jako próg, a `archived >= -5` jest zawsze
  prawdą - „zawsze due"). Dotyczy `sessionThreshold`, `brainNotesLimit` (obie strony: state I
  ustawienie) i `batchSize`.
- **Wyciszenie propozycji po jawnej decyzji usera „nie teraz"** - `ArchiveWorkflow.onStepRejected(kind, run?)`:
  krok L1 odrzucony w całości zeruje `archived_since_last_consolidation` (`_resetArchiveCounter`,
  TEN SAM gest co po zaakceptowanej paczce) i znaczy `run.meta.consolidationSilenced = true` -
  propozycja NIE wraca przy KOLEJNYM zapisie sesji, dopiero po kolejnych `sessionThreshold`
  sesjach (sesje zostają niepokryte, `covered_by_l1` nietknięte); krok DEDUP odrzucony w całości
  podbija limit notatek (`_autoBumpBrainNoteLimit`, patrz niżej). Trzy haki wołają
  `onStepRejected`, wszystkie w `modules/chat/consolidationRunner.ts` poza pierwszym:
  `ArchiveWorkflow.applyStepDecision` (`decision.accepted === false`, modal review),
  `RunController.skip(stepId)` (guzik „Pomiń"), `RunController.onModalClosed()` (krok L1
  wciąż `awaiting_review`, gdy user zamyka okno przebiegu bez decyzji - `isRunStuck()` z
  `consolidationRunState.ts` świadomie NIE łapie tego stanu, więc bez tego haka próg wracałby
  przy KAŻDYM kolejnym zapisie, dopóki user nie wróci klikiem w 🧠). Automatyczne skipy z braku
  materiału (`not_enough_sessions`/`not_enough_l1`/`not_enough_l2`/`nothing_to_merge`) NIE
  wołają `onStepRejected` - to nie jest decyzja usera. Semantyka licznika sesji od 2.2.9:
  „sesje zarchiwizowane od ostatniej ZAAKCEPTOWANEJ paczki L1 albo ostatniej ODRZUCONEJ
  propozycji" (było: tylko od zaakceptowanej).
  - ⚠️ **Podwójny reset (naprawiony).** `run.meta.consolidationSilenced` (wolne pole
    `ConsolidationRun.meta`) zapobiega temu, żeby `_writeLevel1` zerował licznik DRUGI RAZ, gdy
    user WRACA do tego samego przebiegu i mimo wszystko akceptuje paczkę L1, która już raz
    wyciszyła przebieg (zamknięcie okna/Pomiń) - bez tej flagi drugi reset kasowałby sesje
    zarchiwizowane W MIĘDZYCZASIE (spoza tej paczki). `_applyStep` przekazuje
    `{skipCounterReset: Boolean(run?.meta?.consolidationSilenced)}` do `_writeLevel1` jako
    DRUGI, opcjonalny argument - domyślnie `false` (zachowanie sprzed naprawy dla wywołań
    bezpośrednich, np. testów).
  - ⚠️ **Okno zamknięte W TRAKCIE generowania L1 (nie po fakcie).** `RunController._windowClosed`
    (`modules/chat/consolidationRunner.ts`) pamięta zamknięcie, nawet gdy w danej chwili ŻADEN
    L1 nie jest jeszcze `awaiting_review` (generacja wciąż `running`) - `advance()` (ogon KAŻDEJ
    mutacji: `generate`/`retry`/`applyDecision`/`skip`) sprawdza flagę ponownie i wycisza, gdy L1
    NAPRAWDĘ dojdzie do `awaiting_review`. Bez tego zamknięcie okna zbyt wcześnie (zanim
    propozycja w ogóle powstała) nie wyciszało NICZEGO - przy następnym zapisie sesji leciał
    `notice_busy` i okno wracało, w kółko. `RunController.onModalOpened()` (wołane z
    `ConsolidationProgressModal.onOpen()`) rozbraja flagę - user, który wrócił i PATRZY na okno,
    ma normalną szansę zdecydować.
- `_autoBumpBrainNoteLimit()` podbija limit notatek PO PROGU EFEKTYWNYM
  (`resolveConsolidationThresholds(state, this.settings).brainNotesLimit`), NIE po gołym
  `state.brain_notes_limit` (naprawiony bug: przy globalnym ustawieniu 50 i pustym state, stary
  kod liczył bazę z `state.brain_notes_limit || 20` = 20, więc bump dawał 30 - dalej PONIŻEJ
  efektywnego progu 50, próg nadal by triggerował; przy globalnym ustawieniu 150 bump w ogóle się
  nie odpalał, bo `current >= 100` nigdy nie było prawdą przy pustym state). Limit rośnie BEZ
  GÓRNEJ GRANICY (+10 przy każdym odrzuceniu) - DECYZJA N6 recenzji rundy 3: stary sztywny cap
  100 (i jego następca, cap rosnący razem z bazą, `Math.max(100, baza + 10)`) był martwy kod -
  przy tej formule `base >= cap` nigdy nie było prawdą, więc cap nigdy realnie nie ograniczał -
  usunięty zamiast utrzymywany.
- `CONSOLIDATION_DEFAULTS` (`consolidationStatus.ts`: `sessionThreshold:10`,
  `brainNotesLimit:20`, `batchSize:5`, `autoSessions:false`, `autoBrain:false`) jest JEDNYM
  źródłem tych literałów - silnik (`ArchiveWorkflow`, `ConsolidationRun`) i UI
  (`SettingsContent.ts`) czytają stąd zamiast trzymać osobne kopie. `modules/chat/consolidationRunner.ts`
  NIE importuje tej stałej bezpośrednio (NIE jest w barrelu - zero czytelnika spoza modułu poza
  `resolveConsolidationThresholds`/`planAutoConsolidation`, które ją czytają za niego).
  `autoSessions`/`autoBrain` są od tej naprawy realnie podpięte w `resolveAutoConsolidationPolicy`
  (`(s.memoryV3AutoConsolidateSessions ?? CONSOLIDATION_DEFAULTS.autoSessions) === true`) - wcześniej
  te dwa pola stałej były martwe (nikt ich nie czytał, mimo obietnicy „jedno źródło").
- **UI (`SettingsContent.ts`)**: walidacja pól liczbowych idzie przez `Number(value) +
  Number.isInteger + > 0`, NIE `parseInt` - `parseInt` przyjmował śmieciowe wejścia zamiast je
  odrzucać (`"3.7"` → `3` ucięte, `"1e3"` → `1` bo `parseInt` nie rozumie notacji wykładniczej,
  `"12abc"` → `12` bo `parseInt` ignoruje śmieci na końcu; `Number()` daje odpowiednio `3.7`
  nie-całkowite → default, `1000` poprawnie, `NaN` → default). Pole POKAZUJE wartość EFEKTYWNĄ
  (`pkm.memoryV3X ?? pkm.archiveX ?? CONSOLIDATION_DEFAULTS.x` dla progu sesji i limitu notatek -
  ta sama kolejność fallbacków co silnik), nie zawsze `CONSOLIDATION_DEFAULTS` - user z jeszcze
  starą nazwą ustawienia (`archiveSessionThreshold`/`archiveBrainNotesThreshold`, sprzed tego
  podbloku) widziałby pole kłamiące o tym, co silnik naprawdę liczy. Zapis (`.onChange`) zawsze
  ląduje w `memoryV3X` - dotknięcie pola migruje cicho na nową nazwę, stare pole zostaje
  nietknięte (nie kasujemy cudzej wartości).

### Migracja

`MigrationV3` wykrywa stare memory, gdy istnieje `brain.md`, nie istnieje folder `brain/` i
treść nie wygląda na już zmigrowany indeks v3 (`looksLikeV3Index`: kanoniczny wikilink
`- [[brain/<typ>_*.md` wystarcza sam - filename typu w nazwie pliku jest język-niezależny, więc
ten sygnał działa identycznie dla brain.md PL i EN; nagłówek "Na teraz"/"Right now" liczy się
TYLKO razem z ≥2 nagłówkami `indexSectionHeadings(locale)` TEGO SAMEGO języka - pojedynczy
słaby sygnał nie wygasza migracji, a PL nie koroboruje z EN). Brain w formacie v3 bez folderu
`brain/` (świeży klon, desync) nie jest migrowany: `run()` robi backup, dosztukowuje strukturę
(`ensureMemoryStructure` może dokleić brakujące nagłówki indeksu W JĘZYKU WYKRYTYM z istniejącej
treści i domigrować płaski `sessions/`) i wraca `{skipped, reason:'already_v3_format', backupPath}`.

Flow:

1. backup całego `memory/` do `memory.v2.backup/` - TAKŻE na ścieżce skip `already_v3_format`,
2. jednostka migracji to AKAPIT/BULLET (blok), nie linia: pusta linia i `---` rozdzielają bloki,
   wcięty sub-bullet zostaje przy rodzicu, nagłówek `###`-`######` staje się prefiksem
   następnego bloku, znacznik ``` jest pomijany,
3. `## User` -> `user_*.md`; `## Preferencje` -> `agent_rule_*.md`; `## Ustalenia` ->
   `project_context_*.md`; `## Bieżące` -> `project_context_*`; `## Workflow` -> `skill_hint_*`;
   `## Projekty i referencje` -> `reference_*` (nagłówki kolidujące z `indexSectionHeadings`
   w KTÓRYMKOLWIEK z dwóch języków idą w notatki, NIE w `keepInBrain` - sekcja verbatim pod
   takim nagłówkiem zostałaby wycięta przy następnym `rebuildBrainIndex`; realny v2 brain jest
   zawsze PL, więc te sygnały łapią praktycznie wyłącznie polskie tytuły - `SECTION_TYPES`/
   `LIVE_SECTION_KEYS` w `MigrationV3.ts` są mimo to zbudowane z rejestru w OBU językach,
   plus historyczny synonim `ustalenia` spoza rejestru),
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

- ⚠️ **Zwis rozstrzyga strzał przed zatrzymaniem modelu.** `streamToComplete` odrzuca
  obietnicę z kodem `stream_stalled` przed wywołaniem `stopStream()`, ponieważ adapter
  może synchronicznie zgłosić `done` podczas zatrzymywania. Odwrócenie kolejności
  zamieniłoby zwis w udaną propozycję i ominęło pojedyncze auto-ponowienie kroku.

- ⚠️ **Jedno liczydło progów konsolidacji.** `resolveConsolidationThresholds`/
  `shouldTriggerConsolidation` (`consolidationStatus.ts`) to JEDYNE miejsce, które liczy próg
  sesji (`memoryV3SessionThreshold || archiveSessionThreshold || CONSOLIDATION_DEFAULTS.sessionThreshold`,
  `>=`) i limit notatek `brain/` (`>`). `SaveSessionWorkflow.applyDecision` (przez
  `planAutoConsolidation`) i `consolidationRunner.startConsolidationRun` (`modules/chat`, przez
  barrel) DELEGUJĄ tutaj zamiast trzymać własną kopię - druga implementacja tej samej logiki
  rozjechałaby się przy pierwszej zmianie jednego z dwóch miejsc.

  ⚠️ **Limit notatek `brain/` liczy się od 2.2.9 jako PODŁOGA, nie pierwszeństwo** (świadoma
  zmiana zachowania, patrz sekcja „Auto-konsolidacja opcjonalna" wyżej): efektywny
  `brainNotesLimit = Math.max(state.brain_notes_limit, memoryV3BrainNotesThreshold ||
  archiveBrainNotesThreshold || CONSOLIDATION_DEFAULTS.brainNotesLimit)` - do 2.2.8 włącznie
  `state.brain_notes_limit` wygrywał BEZWARUNKOWO, nawet gdy był NIŻSZY od ustawienia
  globalnego. Powód zmiany: odkąd limit ma suwak w Ustawieniach, podniesienie GLOBALNEJ
  wartości nie może być po cichu przykryte starą, niższą wartością zapisaną per agent (auto-bump
  po odrzuceniu scalenia). Auto-bump per agent nadal tylko PODNOSI `state.brain_notes_limit` -
  nigdy nie obniża efektywnego limitu poniżej tego, co user właśnie ustawił globalnie. Sygnatura
  funkcji jest bez zmian (patrz akapit niżej) - zmienił się WYŁĄCZNIE algorytm w środku.

  Drugi konsument (poza `SaveSessionWorkflow` wewnątrz tego modułu) to prywatna wtyczka
  deweloperska właściciela w repo `pkm-assistant-harness` (katalog `companion/`, plik
  `memoryStatus.ts`) - importuje obie funkcje PRZY BUILDZIE wprost z pliku
  `@plugin/modules/memory/consolidationStatus.js`. Dlatego NAZWA TEGO PLIKU i sygnatury tych
  dwóch funkcji zostają BEZ ZMIAN bez poprawki w harnessie - zmiana = czerwony build harnessu i
  jego CI, którego to repo nie zobaczy we własnym typecheku ani testach. Status konsolidacji dla
  CLI Obsidiana (dawne `getConsolidationStatus`, `resolvePlanDedupThreshold`, `StateManager.peek()`
  i cała diagnostyka wokół nich) mieszka od 2026-09-20 poza tym repo - werdykt właściciela:
  wewnętrzne narzędzia do pracy nad pluginem nie wchodzą do jego repo.

  ⚠️ **Ten drugi konsument dziś KŁAMIE o auto-konsolidacji opcjonalnej.**
  `companion/memoryStatus.ts` liczy `wouldTrigger` przez `shouldTriggerConsolidation` (z
  definicji ignoruje OBA wyłączniki `memoryV3AutoConsolidateSessions`/`Brain`) i ma WŁASNĄ,
  celowo inną formułę progu dedupu (`resolvePlanDedupThreshold`, bez podłogi z tego pliku) -
  diagnostyka CLI hosta pokaże "konsolidacja by się odpaliła" nawet gdy oba wyłączniki są
  WYŁĄCZONE (czyli produkcyjnie NIC by się nie odpaliło). Naprawa (przejście na
  `planAutoConsolidation`/`resolveConsolidationThresholds` z tego pliku) należy do repo
  harnessu, PO zmergowaniu tej gałęzi - to repo nie ma prawa go dotykać. Nowe eksporty
  (`CONSOLIDATION_DEFAULTS`, `resolveAutoConsolidationPolicy`, `planAutoConsolidation`) są
  addytywne (nie psują dzisiejszego builda harnessu), ale dopóki `memoryStatus.ts` po nie nie
  sięgnie, jego `wouldTrigger`/`dedupThreshold` zostają nieaktualne.
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
- ⚠️ **Prompty robocze idą za JĘZYKIEM INTERFEJSU (proza) i liczą się LENIWIE; nagłówki brain.md
  w treści `save_session` idą za JĘZYKIEM PLIKU (osobny wymiar).** Od 2.2.5 każdy z trzech
  promptów (`save_session`/`archive`/`summary`) ma wersję PL i EN w `workPrompts.ts`, a wołacz
  bierze je WYŁĄCZNIE przez `factoryWorkPrompt(kind, locale?, brainLocale?)`. Stałe
  `DEFAULT_*_PROMPT` zostały skasowane celowo: `setLocale()` leci z `src/main.ts` PO załadowaniu
  modułów, więc stała wybrałaby język przy imporcie i zamroziła go na zawsze (domyślna wartość
  parametru liczy się dopiero przy wywołaniu - dlatego funkcja jest bezpieczna).
  **Co NIE tłumaczy się razem z prozą, tylko ma WŁASNY wymiar językowy** (to ADRESY, nie proza):
  nagłówki sekcji indeksu i sekcje "Na teraz"/"Right now" w tekście `save_session` są od 19.09
  placeholderami (`{{sec_current}}`, `{{sec_user}}`, `{{sec_preferences}}`, `{{sec_workflow}}`,
  `{{sec_projects}}`, `{{na_teraz_user}}`, `{{na_teraz_environment}}`), wypełnianymi przez
  `fillBrainSectionPlaceholders(text, brainLocale)` NAGŁÓWKAMI JĘZYKA PLIKU brain.md TEGO
  agenta - NIE językiem prozy promptu (EN proza + PL plik agenta = tekst po angielsku, ale
  mówiący modelowi o polskich nagłówkach, bo to one naprawdę są w tym pliku). `SaveSessionWorkflow`
  liczy `brainLocale` DWA RAZY, NIEZALEŻNIE - RAZ w `prepareProposals` (dla ścieżki regexowej i
  poczekalni rescue, `getBrain()` opakowane w try/catch - pad odczytu spada na `uiBrainLocale()`,
  patrz gotcha „Odczyt PRZED..." niżej) i DRUGI RAZ w `proposeBrainUpdatesViaAgent` (ścieżka LLM,
  potrzebuje też surowej treści `current_brain` do payloadu promptu, nie tylko samego locale).
  Świadomie NIE ujednolicone w jedno przeliczenie - `proposeBrainUpdatesViaAgent` jest metodą
  PUBLICZNĄ, wołaną wprost w kilku testach z samym `messages`, a wątek błędów obu ścieżek (LLM
  kontra regex) jest inny na tyle, że wspólny parametr wymusiłby przekazywanie fallbacku z
  jednej strony na drugą. Koszt: jeden dodatkowy odczyt `brain.md` na strzał LLM - lekki plik,
  raz na `/save session`, nie ścieżka gorąca. Nadpisania promptu (agent/global) przechodzą przez
  `fillBrainSectionPlaceholders` OSOBNO, PO `resolveWorkPrompt` - user, który we własnym
  override też wpisze te placeholdery, dostaje tę samą podmianę (idempotentne na tekście już
  podstawionym). W SAMYM PLIKU nagłówki oczywiście dalej zostają surowe w każdym języku
  interfejsu (okno review `/save session` pokazuje etykietę w języku UI -
  `modules/chat/saveSessionSectionLabel.ts`). Klucze JSON (`new_notes`,
  `na_teraz.*`, `merges`, `deletions`, `target_*`, `merged_content`, `lessons_extracted`),
  wartości `type` i token `{{LEVEL}}` NIE tłumaczą się, bez zmian. Nagłówki `##` W WYNIKU
  promptu `summary` (Kluczowe tematy / Key topics …) nikt nie parsuje - te SIĘ tłumaczą.
  Strażnicy: `workPrompts.test.ts` (kontrakt placeholderów, EN proza + PL/EN brainLocale →
  nagłówki właściwego pliku, strażnik "żaden fabryczny prompt nie niesie już nagłówka na
  sztywno", łańcuch resolvera w obu językach).
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
  defaultów kasowałoby liczniki i limity. M2 D1 dopuszcza tylko scalenie obu pełnych stron
  konfliktu gita po kopii oryginału (kontrakt poniżej). Nie "naprawiaj" tego na gołe `exists()` i
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
  (`saveSession`, log audytu, `brain.log`, fallback `CostLog` bez native append) czyta stary plik przed dopisaniem nowego
  wpisu; na dyskach, gdzie `exists()` potrafi kłamać `false`, naiwny wzorzec `if (await exists())
  { read() }` sprawia, że kod nigdy nie próbuje `read()` i NADPISUJE całą dotychczasową treść
  jednym nowym wpisem. `readIfExists` (`core/utils/vaultFs.ts`) czyta NAJPIERW, więc `exists()`
  nie ma szans skłamać. Polityka przy wyniku `'unreadable'` (sygnały sprzeczne) jest
  per-miejsce: ścieżki, gdzie treść jest zbyt cenna, żeby zgadywać (transkrypt, kompresja)
  RZUCAJĄ i przerywają operację; kroniki best-effort (log audytu, `brain.log`, fallback `CostLog.append`)
  tylko `log.warn` + pomijają TEN wpis, kontrakt "nigdy nie rzuca" zostaje.
- ⚠️ **`appendToActiveSession` dokleja ogon, nie przepisuje pliku.** Pisze przez
  `_appendSessionFile` (`adapter.append`), a pełny odczyt płaci się RAZ na ścieżkę
  (bez id; z id dodatkowo po zmianie metadanych, przy braku wiarygodnego `stat`,
  oraz co 20 ciepłych zdarzeń, także dla sesji niczyjej).
  Cache (`_sessionSeqCache`/`_sessionEndsWithNewline`, inicjalizowane na pierwszym zdarzeniu sesji
  albo pierwszym po restarcie Obsidiana) unika czytania każdego zdarzenia - naiwny read+write całego
  pliku na każde zdarzenie tury jest kwadratowy względem długości sesji i przy każdym zapisie to
  też jedno zdarzenie synchronizacji na vaultach chmurowych. Maskowanie (`maskSensitiveData`)
  obejmuje TYLKO nowo doklejany fragment, nie cały plik - bezpieczne, bo wzorce sekretów
  działają w granicach jednego, kompletnego bloku zdarzenia, nigdy w poprzek dwóch osobnych
  zapisów. Adapter bez natywnego `append` dostaje fallback przez `readIfExists` (nie goły
  `exists()+read()`). Dla `session_epoch` fallback jest zabroniony: wymagany natywny append.
  - Dopisek do niczyjej sesji nie adoptuje jej i nie przepisuje nagłówka. Z id przed
    dopiskiem jest `stat`; co 20 ciepłych zdarzeń dodatkowo pełny odczyt, także dla
    sesji niczyjej (D2e). Bez id pozostaje dotychczasowe `exists`.
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
- ⚠️ **Cache pisarza odświeża każdy świeży odczyt w drodze dopisku.**
  `appendSessionEvent` i `ensureActiveSessionEpoch` ustawiają seq, newline oraz licznik
  okresowej weryfikacji z odczytanego tekstu, nawet na ciepłym cache. Ensure robi to także
  po readbacku. Błąd dopisku/ensure unieważnia te trzy cache, zachowując licznik autosave
  `_sessionSavedCounts`. Bez id ciepły `appendToActiveSession` nadal nie czyta treści.
  Z id jeden `stat` wykrywa zmianę rozmiaru/mtime i wymusza odczyt; także dla sesji
  niczyjej co 20 ciepłych zdarzeń pełny odczyt wymusza
  odświeżenie seq/newline oraz sprawdzenie własności przed dopiskiem (szczegóły niżej).
  Event epoki zawsze zaczyna się dodatkowym newline, także przy ciepłym cache.
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
  już istnieć (`startActiveSession`, `archiveActiveSession`, `discardActiveSession`, `saveSession`, `writeBrainNote`,
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
  pliku niczego nie psuje. Wyjątek D2/D2c: jawne przejęcie zmienia nagłówek
  (`device` i `taken_over`), bez ponownego maskowania zastanej treści
  (kontrakt zachowania bajtów zdarzeń). Kopia ratunkowa zachowuje surowy oryginał 1:1.

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
- `modules/memory/CostLog.append.test.ts` - D4: bajty i liczniki I/O, bootstrap,
  kolejka równoległych dopisków, błędy, niezmieniony fallback, czytnik konfliktów i sklejonych obiektów
- `modules/memory/activeSessionFormat.test.ts` - round-trip pisarz/czytnik, plik MIESZANY, CRLF,
  legacy bez escapów
- `modules/memory/brainSections.test.ts` - rejestr dwujęzyczny: `sectionKeyOf`/`naTerazKeyOf` na
  wszystkich 10+4 nagłówkach, `detectBrainLocale`/`resolveBrainLocale`/`uiBrainLocale`
- `modules/memory/BrainIndex.test.ts` - sekcje "Na teraz" (PL+EN), sekcje obce, plik mieszany
  (dwie sekcje tej samej kategorii scalają się pod jednym kluczem)
- `modules/memory/MemoryAccessGuard.test.ts`
- `modules/memory/collisionSuffix.test.ts`
- `modules/memory/EmbeddingHelper.test.ts`
- `modules/memory/workPrompts.test.ts` - w tym kontrakt `brainLocale` niezależny od `locale`
  prozy i strażnik "żaden fabryczny prompt nie niesie nagłówka na sztywno"
- `modules/memory/consolidationStatus.test.ts` - `resolveConsolidationThresholds` (fallbacki
  ustawień, trzy źródła `limitSource`, podłoga limitu brain/, wartości ujemne/`NaN` = brak),
  `shouldTriggerConsolidation` (granice literalne: sesje `>=`, notatki `>`),
  `resolveAutoConsolidationPolicy`, `planAutoConsolidation` (oba wyłączniki × oba progi,
  DECYZJA „AND z due" + regresja „L1 świeżo odrzucony nie wraca na cudzym triggerze")
- `modules/memory/SettingsContent.consolidation.test.ts` - render behawioralny podbloku
  „Konsolidacja pamięci" (dwa toggle + trzy pola liczbowe, wartości startowe, zapis do slice,
  walidacja liczb `Number`+`isInteger`, wartość EFEKTYWNA z fallbackiem na legacy `archiveX`) -
  `Setting` wstrzyknięty przez DI, NIE zależy od atrapy `obsidian` harnessu
- `modules/chat/ConsolidationProgressModal.test.ts` - okablowanie modalu z `RunController`:
  `onClose()` woła `controller.onModalClosed()`, `onOpen()` woła `controller.onModalOpened()`,
  haki opcjonalne (atrapa starsza nie wywala), pad w haku jest best-effort

---

## Powiązane

- `modules/prompts/CLAUDE.md` - `fenceUntrusted`, ogrodzenie pamięci wstrzykiwanej do promptu
- `modules/chat/CLAUDE.md` - `RollingWindow` (okno tokenów), `ConsolidationProgressModal`,
  `consolidationRunner` (kontroler produkcyjnego triggera konsolidacji), restore aktywnych sesji
- `modules/agent-loop/CLAUDE.md` - `toolTranscriptSanitizer`
- `modules/tools/CLAUDE.md` - `SearchTool`, `MemorySaveTool`, `MemoryDeleteTool`, prymitywy
  `read`/`list`


U3: `appendSessionEvent(path,event): Promise<string>` writes only an explicit file under this memory owner active-sessions root. It shares the existing per-path queue and event format, reads the target even with warm caches, and rejects missing/unreadable targets without creation, redirection or changing activeSessionPath.


P6 - event `sub_task_history` ma osobne pole JSON o tej samej nazwie. `formatSessionEvent`
zapisuje i escapuje je wspólnie z pozostałymi polami; `parseActiveSession` zwraca opcjonalne
`subTaskHistory: unknown[]`, oddzielone od wiadomości modelu. Składnię JSON czyta parser,
a wersję 1, schemat rekordu i relacje drzewa waliduje `SubTaskRegistry.importHistory`.
Parser pamięci nie importuje runtime sub-agentów (zachowuje lekką, bezpieczną dla Node zależność).
Uszkodzony JSON nie trafia do transkryptu; nieznaną wersję odrzuca importer. Stare pliki bez
tego pola mają dokładnie dotychczasowy kształt wyniku. Wpisy używają istniejącego
`appendSessionEvent(path,event,epoch)` z kolejką i sprawdzaniem epoki, bez zmiany aktywnej sesji.
Historia dotyczy plików active; archiwizacja nadal zapisuje transkrypt. Test pełnej drogi:
`modules/sub-agents/SubTaskHistory.test.ts`.

## 2.4.5 P1 - czysty tekst źródłowy wiadomości użytkownika

Opcjonalne pole event-logu `parent_conversation_text` ma JSON `{text: string}` (także pusty
string, zachowuje whitespace). `parseActiveSession` waliduje ten kształt i zwraca
`ActiveSessionMessage.parentConversationText`; brak/uszkodzenie pola nie zmienia starego
obiektu wiadomości. Format zachowuje wersję 3 i dotychczasową treść `content`.
`AgentMemory._appendMessageAsEvent` przenosi pole również podczas dopisywania ogona autosave.
Przechowywany jest osobny tekst użytkownika, nie snapshot rozmowy ani zgoda. Chat restore
używa go do projekcji rodzica oraz tekstu edycji, nigdy nie odtwarza go z nierozdzielalnego legacy content.
Testy round-trip: `../chat/chat/chat_session.test.ts`, `../chat/chat/chat_streaming.parentConversation.test.ts`.

### 2.4.5 F5 — trwałe usunięcie gałęzi

`saveSession(messages, metadata, changes?)` dopisuje event
`changes` niesie usunięte ID/zakresy i opcjonalną oczekiwaną ścieżkę/epokę. Event
`messages_removed` (pola `removed_messages`, `removed_ranges`) zamiast przepisywać dziennik.
Nowe wiadomości mają opcjonalne `message_id`; parser starszym blokom A/B/mieszanym nadaje
stabilną tożsamość według kolejności bloków wiadomości. `sessionMessageId` / `bindSessionMessageId`
przenoszą ją w WeakMap, poza treścią dla modelu. Parser stosuje usunięcia przed restore;
zakres między końcami gałęzi obejmuje także telemetryczne wiadomości spoza okna.
Autozapis wiadomości z ID dopisuje brakujące ID, a dla starych wołaczy bez ID zachowuje
licznik ogona. Kompresja okna nie zgłasza usunięć. Stary format pozostaje czytelny;
starszy plugin nie honoruje nowych zdarzeń usunięcia (downgrade nie zachowuje tej ochrony).
Testy F5-1: `../chat/chat/chat_session.test.ts` — zapis, oba restore, format mieszany i kompresja.

### 2.4.5 F7 — metadane tylko przed treścią eventu

`message_id`, `removed_messages`, `removed_ranges` i `parent_conversation_text` są
rozpoznawane wyłącznie w ciągłym prefiksie pól przed pierwszym polem starego formatu.
Ich literalne etykiety wewnątrz content/result/prompt nie kończą treści, także w legacy.
Archiwum zachowuje osobny tekst użytkownika jako JSON pozycyjny `pkm_user_text_v1`
w frontmatterze transkryptu; `parseSessionFile` waliduje tablicę i długość, a brak pola
pozostawia stary kształt wiadomości. Żadnych nowych delimiterów wewnątrz treści Markdown.
Test F7 w `../chat/chat/chat_f7.test.ts` czyta stare i nowe eventy, archiwizuje i odczytuje
rzeczywiście zapisane archiwum, a potem kontynuuje i edytuje sesję.

### 2.4.5 F8 — scalanie zapisów usunięcia podczas zamykania

`saveSession` współdzieli zapis w locie dla identycznego snapshotu z usunięciami,
kluczowanego ścieżką, epoką, wiadomościami (również ich ID) i usuniętymi ID/zakresami.
Quit/beforeunload/onunload/onClose nie dopisują czterech kopii tego samego zdarzenia.
Zmieniony snapshot ma osobny zapis w dotychczasowej kolejce per plik; sukces i błąd
zwalniają wpis, więc błąd nie blokuje ponowienia. Publiczna sygnatura bez zmian.
Testy: `../chat/chat/chat_f8.test.ts` (cztery callbacki, błąd i kolejna zmiana w locie).

### 2.4.7 — pamięć a kopie subagentów

Dedykowane zapisy pamięci, sesji i logów zachowują dotychczasowy host i nie trafiają
do kopii treści. `RetrievalEngine` pozostaje publicznym silnikiem wyszukiwania; wybór
hosta należy do `tools/SearchTool`: keyword/text widzą warstwy kopii, auto przechodzi
na keyword, a semantic korzysta z bazowego vaulta i nie widzi kopii. `scope: memory`
zachowuje dotychczasowy odczyt. Osobna tożsamość hosta kopii izoluje cache skanów.


### 2.4.7 P3 — epoka starszej sesji przez dopisek

Format v4 dodaje `session_epoch`: nagłówek ISO z tytułem `session epoch`, pole `epoch`
w prefiksie metadanych i dodatni bezpieczny całkowity `seq`. `parseSessionEpoch(unknown)`
waliduje dokładnie 32 małe znaki hex do branded `SessionEpoch`.
`resolveSessionEpoch` wybiera poprawny frontmatter, a przy jego braku pierwszy poprawny
event w fizycznej kolejności pliku (bez sortowania po czasie ani `seq`). Odczyt normalizuje
BOM/CRLF w roboczym tekście. `epoch` nie jest delimiterem treści legacy.
Rozpoznany blok epoki, także uszkodzony lub z polami wiadomości, nigdy nie staje się
wiadomością i nie zmienia ID `legacy:N`, pytań ani historii subów.
Resolver zasila parser, kontrole oczekiwanej epoki append/save i odczyt po tworzeniu
w `saveSession`. Nowe sesje nadal zapisują epokę we frontmatter.
Testy: `activeSessionFormat.test.ts` (format, pierwszeństwo, walidacja, treść i ID)
i `AgentMemory.test.ts` (`frozen append and save accept event epoch and reject another owner`).

`ensureActiveSessionEpoch(path, isCurrent)` pod kolejką sprawdza ścieżkę, agenta,
rewizję właściciela i oczekiwaną epokę. Przyjmuje już istniejącą epokę resolvera bez zapisu.
Przy jej braku wymaga natywnego `append` i dopisuje jeden blok `session_epoch`, zawsze
z początkowym newline. Stary BOM, CRLF, nieznane bloki i treść pozostają bajtowo nietknięte;
maskowany jest tylko nowy fragment. Brak tworzenia kopii, rename, remove i rollbacku.
Pozostałości dawnych `.epoch-*.bak*` nie są czytane, wykrywane ani sprzątane.

Readback musi zachować odczytany prefiks i zawierać poprawną epokę; dodatkowe dopiski są
akceptowane. Cache pisarza jest odświeżany z readbacku przed kontrolą właściciela.
RAM otrzymuje wynik resolvera, więc wcześniejszy poprawny wpis innego pisarza wygrywa
z własnym kandydatem. Błąd nie publikuje epoki; następna próba ponownie czyta plik,
bez zapamiętywania kandydata. `SessionEpochPersistenceError` odróżnia awarie I/O i
weryfikacji od zmiany właściciela. `SessionEpochFailure`, klasa, parser `unknown` oraz
`sessionEpochFailureReason` są eksportowane przez index.ts. Diagnostyka
`getSessionEpochFailure(path)` jest ograniczona ścieżką i rewizją; sukces ją usuwa.
`sessionIdentityRevision` jest tylko do odczytu i pozwala wykryć reset tej samej ścieżki.
Wspólna próba emituje jeden warning Loggera; przyczyna jest normalizowana i maskowana.
P4 pozwala kontynuować rozmowę bez epoki; kopia suba nadal wymaga potwierdzenia.

Migracja, append/save/archive dzielą kolejkę i cache adaptera; `_sessionSavedCounts`
pozostaje per instancja. Wywołania jednej rewizji współdzielą Promise i zbiór właścicieli;
odejście jednego nie anuluje ważnego drugiego. Publikacja RAM wymaga potwierdzenia pliku
i aktualności właściciela, także po A→B→A. Restore samo nie migruje; send robi to przed
startem modelu, na pisarzu zamrożonej sesji, jeśli dostępna jest delegacja (starszy host bez rejestru też próbuje).
`chat_streaming.epochMigration.test.ts` oraz F1 w `AgentMemory.test.ts` i `turnOwner.test.ts`
sprawdzają historię, trwałą tożsamość, dwóch właścicieli i kolejkę. Testy P3 dodatkowo
porównują stare bajty + literalny blok, zakaz write/rename/remove/mkdir/list oraz świeży
cache po zewnętrznym dopisku bez newline, również po błędzie readbacku. Epoka zużywa seq,
ale nie zwiększa liczby wiadomości. Test filesystemowy sendu potwierdza brak nowych plików.

`RetrievalEngine` pomija prywatny namespace kopii również podczas adapterowego skanu
administratora oraz w wynikach starego indeksu semantycznego; nie odczytuje jego
zawartości przy zbieraniu kandydatów ani podglądów. Test F4 w `RetrievalEngine.test.ts`.

P5 migracji: `archiveActiveSession` przenosi efektywną epokę do frontmatter także
przy zerze wiadomości. Wtedy zmienia tylko nagłówek nowego archiwum, zachowując
surowe body (również CRLF i nieznane bloki); źródło usuwa dopiero po readbacku.
Obie projekcje L1 w `ArchiveWorkflow` używają `withoutSessionEpochEvents` z formatu:
normalizują początkowy BOM i CRLF wspólną funkcją parsera wyłącznie w roboczym tekście,
pomijają rozpoznane bloki `session_epoch`, również uszkodzone, zachowują nieznane bloki.
Bajty archiwum pozostają bez zmian. Regresje F1 w `ArchiveWorkflow.test.ts` obejmują
obie drogi L1, BOM/brak BOM i LF/CRLF oraz literalny dokument i zachowanie archiwum.
L2/L3 pozostają bez tego filtrowania. Nie oznacza to zakazu przepisywania sesji przez
`saveSession`: jego istniejący zapis metadanych nadal wykonuje read-modify-write.
Testy P5: `AgentMemory.test.ts` (archiwum, niezależne adaptery, błąd po pełnym
append, świeży restore, A→B→A) i `ArchiveWorkflow.test.ts` (literalne dokumenty L1
oraz odpowiedź modelu). Niezależne adaptery mogą dopisać dwa rekordy; czytelnicy
tych samych końcowych bajtów wybierają pierwszy, bez obietnicy blokady między procesami.


### P1 — niezależny pisarz przyjętej wysyłki

`AgentMemory.createSessionWriter(path, epoch)` zwraca instancję z własnym wskaźnikiem
sesji i rewizją; kolejka pliku, seq i cache adaptera pozostają współdzielone.
Dla przechwyconej ścieżki `appendToActiveSession` najpierw wykonuje
`startActiveSession` (także naprawa brakującego pliku), a następnie
`appendSessionEvent(target, event, writer.sessionEpoch)`. Ten dopisek sprawdza
oczekiwaną epokę z odczytanego pliku w kolejce ścieżki: samo zimne `exists` nie
uprawnia do zapisu do nazwy użytej ponownie przez nową epokę. Pisarz bez ścieżki
tworzy własną nową sesję dotychczasową drogą. Migrację prowadzi
`ensureActiveSessionEpoch`. Nie zapisuje `.active_session.json`: pisarz
pracujący w tle nie wybiera aktywnej sesji. Wołacz publikuje wynik do swojej zakładki
wyłącznie po kontroli sygnału przerwania, obiektu zakładki, jej ID/ścieżki/epoki
z migawki przyjęcia wysyłki, zachowanego okna i instancji pamięci. Zmiana wybranej
zakładki jest dozwolona; wymiana sesji nie. Aktualizacja wskaźnika głównej pamięci
i jego zapis wymagają dodatkowo aktywnego okna
oraz zgodnej rewizji. Nie należy podłączać tej instancji do selekcji w AgentManager.
Kontrola migracji dotyczy właściciela sesji, a nie wybranej zakładki. Diagnostyka
migracji zostaje przy pisarzu i przechwyconej turze. Testy pełnej ścieżki wysyłki:
`../chat/chat/chat_streaming.sendTab.test.ts` (również tworzenie sesji i trzy fazy epoki).


### F6 — trwała granica przyjęcia wiadomości w czacie

Czat przygotowuje poprawkę bez zmian RAM ani zapisów sesji. W nieprzerywalnej
fazie B wywołuje `saveSession` na niezależnym pisarzu: pozostałe wiadomości,
nowa wiadomość ze stałym `message_id` i wszystkie usunięcia tworzą jeden plan.
Istniejące `_saveSession` składa `messages_removed` oraz brakujące wiadomości
przed jednym `_writeSessionFile`. Nie wolno najpierw zapisać samego ucięcia.
Oczekiwana ścieżka/epoka nadal są kontrolowane pod kolejką pliku.
Dopiero udany zapis pozwala czatowi zmienić RAM i potwierdzić odbiór.

Migracja epoki i publikacja tożsamości należą do tej samej fazy B. Stop odracza
przerwanie do jej zakończenia. Czat kolejkuje Zamknij/Nowa/load/restore dla
przechwyconej zakładki i sesji, sprawdza właściciela po oczekiwaniach i odrzuca
nieaktualne decyzje modalu. To bramka czatu, nie blokada aktywnego kursora pamięci;
Discard z tej ścieżki podaje jawny path, również gdy utworzył go dopiero własny
zapis wstępny Nowej sesji po zwykłym Archive albo dla transkryptu bez pliku.
Czat przyjmuje ścieżkę i epokę z niezależnego pisarza po udanym zapisie i kontroli
właściciela; używa ich do odrzucenia, archiwizacji i resetu. Bieżący wspólny kursor
nie jest dowodem tożsamości tego zapisu. Przełączenie zakładki nie blokuje pisarza
starej sesji.
Konflikt epok nie uprawnia do pominięcia zapisu pytania legacy. Błąd samej migracji
zachowuje istniejący kontrakt `SessionEpochPersistenceError`, ale błąd zapisu pytania
zatrzymuje wysyłkę. Nie ma już startu modelu z niezapisanym pytaniem jako fallbacku.

Powiadomienia używają stałych ID dostarczenia. Ich ponowienie zawiera każde ID
raz w planie `saveSession`; wcześniej obecne ID na dysku są pomijane przez
istniejący mechanizm ogona. ACK notifiera wymaga sukcesu tego zapisu, także gdy
wiadomość była już w RAM. Zapis konkretnego okna bierze snapshot po jego B.
Listener quit w czacie najpierw czeka na WSZYSTKIE przyjęcia z rejestrów tur,
także dla okien w tle bez ścieżki, a dopiero potem zbiera zapisy aktywnych sesji.
Zwykły beforeunload/onunload nie daje gwarancji oczekiwania hosta; kolejność
wygaszania pluginu w main.ts nie jest zmieniona. Testy F7 w
`../chat/chat/chat_streaming.sendTab.test.ts` sprawdzają zadania rzeczywistego
nasłuchu quit i świeży odczyt pierwszego pytania z pliku.

API pamięci pozostaje bez zmian. Nie dodano readbacku każdego zapisu ani obsługi
niepewnego/częściowego I/O; to ograniczenie jest odrębne od odraczania Stopu.
Dowody: F6 w `../chat/chat/chat_streaming.sendTab.test.ts`, ze świeżym czytnikiem.


### F4 — kolizje nazw sesji przy archiwizacji

`archiveActiveSession` wybiera wolny cel przez `findFreeCollisionPath` (`_2`…`_50`;
niepewny odczyt oznacza zajęte, wyczerpanie rzuca przed zapisem/usunięciem).
Zwraca rzeczywistą ścieżkę archiwum; nie wolno wyprowadzać jej z basename źródła.
`SaveSessionWorkflow.archivedPath` przekazuje ten wynik. `markArchived` nadal dostaje
nazwę ŹRÓDŁA do usunięcia z `active_sessions`, a licznik rośnie po udanym przeniesieniu.
Nazwa nowej aktywnej sesji (`startActiveSession` ORAZ tworzący `saveSession`) musi być
wolna w OBU katalogach: `active/` i `archive/`. Wewnętrzny helper przyjmuje dodatkowe
katalogi do sprawdzenia, bez zmiany kolejności sufiksów ani publicznego API modułu.

Przeniesienia blokują najpierw źródło, potem katalog docelowy we współdzielonej kolejce
adaptera. Sam lock źródła/basename nie wystarcza: `x.md` po kolizji może wybrać `x_2.md`,
o które konkuruje inne źródło. Archiwizacja trzyma lock katalogu przez probe, write,
readback, remove i bookkeeping stanu/wskaźnika. `.discarded/` serializuje dobór nazwy
oraz kopiowanie/usunięcie. Migracja płaskich `sessions/*.md` dzieli lock archiwum;
zajęty cel nadal POMIJA, zachowując źródło (stare referencje L1 mogą używać jego nazwy).
Restore i „kontynuuj” tylko czytają plik, nie przenoszą archiwum pod stałą nazwę.
Nie jest to blokada między procesami ani różnymi adapterami synchronizacji.

L1 i jego `sessions:`/`covered_by_l1`, retencja, wyszukiwanie oraz profil biorą nazwy
ze spisu rzeczywistych plików archiwum. Indeks brain i notatki nie generują backlinku
archiwum z nazwy aktywnej sesji. `.active_session.json` pozostaje `{path, updated}`;
epoka jest w pliku wskazanym przez `path`, nie w nowym polu wskaźnika czy `.state.json`.
Testy: `AgentMemory.archiveCollision.test.ts` oraz F4 w
`../chat/chat/chat_session.archiveFlow.test.ts` (produkcyjne wejścia i nasłuchy).


### Mobile M1 R2 - zapisy startowe

`StateManager` przed zapisem porównuje wartości JSON ze świeżym odczytem dysku przez
`adapter.read` w try/catch. To wyłącznie optymalizacja pomijania równego zapisu.
Kolejność kluczy obiektów, wcięcia i końcowy newline nie stanowią zmiany;
kolejność tablic i pola spoza schematu są istotne. Równy stan oznacza zero zapisów i
zachowanie oryginalnych bajtów. Faktyczny zapis zawsze kończy się `\n`. Błąd odczytu
porównawczego lub uszkodzony JSON powoduje zwykły zapis dostarczonego stanu, jak przed R2.
Pierwszy odczyt mutacji (`_readRaw`) odrzuca nieczytelny stan przed zmianą, poza wąską naprawą M2 D1;
nie wolno pomylić tej ochrony z opcjonalnym drugim odczytem do porównania.
Kolejka jest nadal lokalna dla instancji, nie zapewnia blokady między urządzeniami.
Testy: `StateManager.test.ts` (pruning pustej sesji, zmiana, równość, zewnętrzny zapis,
bootstrap i zapis awaryjny po błędzie I/O/uszkodzonym JSON porównania).
`AgentMemory.test.ts`: drugi odczyt `.state.json` odrzucony przez adapter - dopisanie
wiadomości daje odczytywalną sesję, a archiwizacja kończy aktualizację licznika i obu
wskaźników (RAM oraz `.active_session.json`).

Migracja `weekly/` do `summaries/L1/` sprawdza teraz cel przez `probeFile` pod kolejką.
Zajęty lub niepewny cel pozostawia oba pliki bez zmiany, jak migracja płaskich sesji.
Nie wybiera nowej nazwy, bo istniejące L2 mogą odwoływać się do starej.
Testy startu w `AgentMemory.test.ts` sprawdzają kolizję, kłamiące exists i wolny cel.


### Mobile M2 D1 - samonaprawa stanu po konflikcie gita

`splitGitConflict` zachowuje bajty wspólnych wierszy i obu stron (także CRLF), pomija
bazę diff3 i obsługuje wiele bloków. Znaczniki otwarcia/zamknięcia/bazy mają dokładnie
siedem znaków oraz spację z dowolną etykietą albo koniec wiersza. `=======` jest
separatorem wyłącznie jako cały wiersz otwartego bloku; poza nim pozostaje treścią.
Zagnieżdżenia, niepełne lub błędnie uporządkowane bloki oraz brak znaczników dają `null`.
Helper jest eksportowany z własnego pliku wewnątrz memory, gotowy dla D3/D7.
`splitGitConflict` jest parserem składni znaczników i rozcina także przykład konfliktu
w bloku kodu Markdown; D3/D7 muszą osobno zdecydować, co robią z tekstem podejrzanym.

`mergeStateConflict` wymaga dwóch obiektów JSON. `active_sessions` to unia stringów
w kolejności nasze/potem nowe ich, ograniczona do bezpośrednich plików `sessions/active`.
Opcjonalne `adapter.list`/`mkdir` są już dostarczane przez vault AgentMemory; brak lub
błąd listingu zostawia unię bez filtrowania. Licznik i `brain_notes_limit` biorą większą
skończoną liczbę, bez konwersji stringów; brak obu liczb daje licznik 0, a obecny lecz
niepoprawny limit null (nie wprowadzamy limitu, jeśli klucza nie było). Data to późniejsza
parsowalna data, obie złe dają null. `last_used` wybiera nasze wskazanie obecne w wynikowej
liście, potem ich, potem ostatnią sesję lub null. Pozostałe klucze zachowują nasze wartości,
także null; klucze tylko po ich stronie też przeżywają. Nie zmieniamy schematu ani ścieżki stanu.
Filtr listingu przyjmuje zarówno pełne ścieżki bezpośrednich dzieci katalogu aktywnego,
jak i same nazwy bez `/`; wpisy z podfolderów lub innego katalogu pomija (D1b).

Mutacja naprawia we własnej kolejce StateManager: najpierw oryginalny tekst 1:1 do
`.pkm-assistant/backups/state-<agent>-<timestamp>[-<sufiks>].json.bak`, potem weryfikacja
kopii i niezmienności źródła, następnie dotychczasowy format JSON (2 spacje i newline),
jeden warning ze ścieżkami i właściwa mutacja. Nazwa nie nadpisuje wcześniejszej kopii.
Końcówka `.json.bak` chroni przed istniejącą rotacją ustawień, która wybiera wszystkie
`*.json` w backups. Wzorzec kopii pochodzi z `core/runtime/settingsArmor`; tutaj bez rotacji.
Błąd kopii lub niepewny wolny cel blokuje naprawę. Kolejna mutacja po sukcesie czyta już
czysty stan i nie tworzy drugiej kopii. Nie ma blokady między urządzeniami/instancjami:
sprawdzenie źródła ogranicza wyścig z pullem, ale nie stanowi atomowego compare-and-swap.

D1b: naprawa przekazuje do `_writeRaw` oczekiwany oryginalny tekst. OSTATNI odczyt przed
zapisem musi zwrócić dokładnie ten tekst; w tej ścieżce porównanie R2 zastępuje ścisła
kontrola bajtów, a błąd odczytu blokuje zapis. Zmiana wykryta w którymkolwiek z dwóch
odczytów źródła po kopii powoduje dokładnie jeden ponowny odczyt mutacyjny, bez pętli,
bootstrapu ani kolejnej naprawy konfliktu. D1c: podstawą mutacji staje się tylko obiekt JSON
(nie null ani tablica), sprawdzany wspólnym `parseObject` z `stateConflict.ts`, eksportowanym
wyłącznie wewnątrz modułu. Inna wartość, pusty plik, błąd parsowania, brak lub błąd odczytu
oznacza brak naprawy (`null`), a dla mutacji `StateCorruptionError`, bez zapisu
źródła. Kopia oryginalnego konfliktu zostaje także po odmowie. Między ostatnim odczytem
a `adapter.write` nadal istnieje pojedyncze okno wyścigu, bez dodatkowego odczytu pośrodku:
adapter nie udostępnia compare-and-swap. Zewnętrznej zmiany w tym oknie nie da się wykluczyć.
Znane ograniczenie poza D1c: pierwszy odczyt mutacyjny `_readRaw` nadal przyjmuje tablice,
skalary i null jak przed M2, bez nowej walidacji kształtu.

`read()` istniejącego konfliktu zwraca scalony stan tylko w RAM, bez kopii i zapisów.
Nienaprawialne uszkodzenie nadal daje defaulty tylko w RAM, zgodnie z kontraktem
`consolidationRunner`; mutacja rzuca `StateCorruptionError`. Historyczny bootstrap
potwierdzonego braku pliku przez `read()` nadal zapisuje defaulty. Jawne `write(state)`
i odczyt porównawczy R2 poza naprawą pozostają bez zmian. Zdrowy plik nie uruchamia listingu ani
dodatkowego I/O. Testy: `gitConflict.test.ts`, `stateConflict.test.ts`,
`StateManager.conflict.test.ts` oraz D1 w `../chat/chat/chat_streaming.sendTab.test.ts`.
Testy D1b w `StateManager.conflict.test.ts` obejmują zewnętrzny poprawny/zepsuty zapis
i błąd obu odczytów kontrolnych, pojedyncze ponowienie z najnowszym JSON-em lub awarią,
zachowanie kopii oraz oba kształty listingu z wykluczeniem obcych katalogów i podfolderów.
Testy D1c w tym samym pliku podstawiają przy obu odczytach kontrolnych literalne `null`,
`42`, `[]`, `["external.md"]`, `"tekst"`, pusty plik, `true` i błędny JSON; sprawdzają typ
błędu, jeden świeży odczyt, nietknięte bajty źródła, zero zapisów źródła i jedną wierną kopię.
Istniejące testy D1b nadal sprawdzają sukces mutacji na świeżym poprawnym obiekcie.


## Mobile M2 D2/D2b/D2c/D2d/D2e - własność aktywnej rozmowy

`src/main.ts` przed budową `AgentManager` odczytuje raz identyfikator z publicznego
`app.loadLocalStorage('pkm-assistant.device-id')`; brak/zła wartość oznacza wygenerowanie
8 losowych bajtów przez Web Crypto i `app.saveLocalStorage`. Branded `DeviceId` powstaje
na granicy przez `parseDeviceId` (dokładnie 16 małych znaków hex). Brak API lub wyjątek
odczytu/zapisu daje `null`. Manager przekazuje ten sam identyfikator każdej pamięci,
także po reload/rename, a `createSessionWriter` swoim prywatnym pisarzom. Nie ma wpisu
w ustawieniach ani pliku identyfikatora w vaulcie.

Nowe nagłówki `startActiveSession`, `saveSession` i samonaprawy zawierają `device`
wyłącznie z identyfikatorem. `readSessionDevice` sprawdza SUROWY nagłówek przed
parserem scalającym klucze; listowanie, restore i wszyscy pisarze używają tej samej
reguły przez `sessionOwnershipFromText` / `ownershipOfSessionDevice`. Stany to
`mine`, `foreign`, `unowned`, `ambiguous`. Duplikat `device`, znaczniki konfliktu
w nagłówku lub niezamknięty nagłówek dają `ambiguous`; zapis i przejęcie odmawiają.
Pojedyncze obecne, lecz niepoprawne pole jest `foreign`. Brak pola albo lokalnego
id to `unowned`. BOM/CRLF są obsługiwane. Archiwum pozostaje wspólne, bez `device` i `taken_over`.

Odczyt/restore i dopisywanie zdarzeń nie adoptują pliku. Sesja bez `device` pozostaje
niczyja do pierwszego zapisu metadanych przez `saveSession`: zastany zapis
`updated`/`messageCount` dodaje wtedy `device`, także bez brakującego ogona wiadomości.
Nie ma osobnego zapisu adopcji ani kopii; pełny zapis metadanych zachowuje zastaną
politykę maskowania i tę samą klasę ryzyka częściowego zapisu co przed D2.
Zwykły natywny append i migracja P3 zachowują cały stary prefiks bajt w bajt,
również BOM/CRLF, nieznane bloki i sekrety. Plik bez frontmattera pozostaje bezgłowy
przy appendzie. `sessionHeaderWrite.ts` służy jawnemu przejęciu oraz naprawie konfliktu D7 opisanej niżej.

`listActiveSessions` i `loadActiveSession` dodają opcjonalne `ownership` tylko dla id.
`restoreActiveSession` ma jedną kolejność z id i bez: wspólne `state.last_used`,
potem `state.active_sessions`, na końcu lokalny `.active_session.json`.
Z id pomija `foreign` i `ambiguous` bez usuwania wpisów. Wspólna implementacja
zachowuje dawne I/O bez id, w tym zapis lokalnego wskaźnika po wyborze ze stanu.

`ForeignSessionError` (barrel, bez treści użytkownika) blokuje dopisek, zapis,
migrację epoki, archiwizację, odrzucenie i przejęcie niejednoznacznego nagłówka.
Dla id `appendToActiveSession` sprawdza `stat` przed dopiskiem. Porównuje rozmiar
UTF-8 (po maskowaniu nowych bajtów) ORAZ `mtime`: rozmiar wykrywa dopisek także
przy niezmienionym czasie, czas wykrywa zamianę identyfikatora tej samej długości.
Natywny `append` otrzymuje publiczne `DataWriteOptions.mtime`; dzięki temu znany
jest oczekiwany czas własnego zapisu bez drugiego `stat`. Niezmieniony ciepły plik:
jeden `stat` na zdarzenie i pełny odczyt co
`APPEND_VERIFY_EVERY_N` (=20) ciepłych zdarzeń, niezależnie od wyniku `stat`.
D2e obejmuje tym odczytem również cache `unowned`: drugie urządzenie mogło już
adoptować sesję bez zmiany rozmiaru/mtime (normalizacja BOM/CRLF przy zapisie
metadanych może zrównoważyć dodanie pola `device`). 20 ciepłych zdarzeń niczyjej
sesji przy wiarygodnym, niezmienionym `stat` to 20 appendów, 20 statów, 1 odczyt
treści, 0 exists, 0 write i 0 kopii. Koszt ochrony to jeden pełny odczyt na 20
zdarzeń zamiast dotychczasowego exists. Wynik `mine` lub `unowned` odświeża cache
i pozwala dopisać. Cudza albo niejednoznaczna własność odmawia
przed dopiskiem. Zmiana metadanych wymusza wcześniejszy odczyt i odświeżenie właściciela,
seq oraz newline przed appendem. Brak `stat`, wyjątek, brak pełnych metadanych lub
adapter ignorujący/zaokrąglający przekazany czas powoduje świeży odczyt. Zdrowa
własna sesja nadal działa; błąd odczytu blokuje zapis. Przy `null` nadal zero `stat`
i dotychczasowe okresowe `exists`. Pełny zapis unieważnia cache pisarza dla id.

`takeOverActiveSession(path)` wymaga id, pliku bezpośrednio w `sessions/active/`
tego agenta i jednoznacznego nagłówka. Pod kolejką zmienia tylko nagłówek, zachowuje
body bajt w bajt i odświeża cache. Dodaje `taken_over: <ISO>`, a przy kolejnych
przejęciach dopisuje `,<ISO>` do wartości. Zachowuje BOM/CRLF i szerokość zapisu
identyfikatora, więc także A -> B -> A -> B przy stałym `mtime` zwiększa rozmiar
po każdym przejęciu; stary ciepły pisarz odmawia już pierwszego dopisku. Starszy
czytnik ignoruje nieznane pole (parser `activeSessionFormat.ts` identyczny z 558d888).
Naprawa splecionych plików pozostaje zakresem D7.

Jawne przejęcie używa `sessionHeaderWrite.ts`: przed przepisaniem kopia 1:1
w `.pkm-assistant/backups/session-<agent>-<nazwa bez .md>-<czas>[-<sufiks>].md.bak`,
wybór wolnej nazwy przez `probeFile` i odczyt kontrolny. Ten sam wzorzec co D1/settingsArmor,
bez rotacji i bez usuwania kopii po sukcesie. Tuż przed zapisem sprawdzamy również,
czy źródło nadal równa się oryginałowi. Brak pewnej kopii oznacza brak próby przepisania.
Po zapisie nagłówka wymagany odczyt równy oczekiwanej treści. Wyjątek lub rozbieżność
powodują jedną próbę `write` oryginału + odczyt kontrolny. Gdy kopia zawiodła albo
odtworzenie się udało, helper loguje jeden `warn`, a przejęcie odmawia
(nie deklaruje zmiany właściciela). Nieudane odtworzenie rzuca
`SessionHeaderWriteError` i loguje `error` ze ścieżką zachowanej kopii, bez treści pliku.
Komunikat korzysta z istniejącego klucza PL/EN `chat.session.autosave_failed`.

To nie jest blokada między urządzeniami: starszy plugin i skrypty mogą nadal pisać.
Jeśli aplikacja zostanie ubita po dopiskach do starszej sesji, ale przed zapisem
metadanych, sesja pozostaje niczyja i drugie urządzenie nadal może do niej dopisać.
Ochrona z konstrukcji dotyczy sesji utworzonych po D2 oraz starszych po pierwszym
zapisie metadanych. D2d świadomie przywraca tę granicę, aby zachować kontrakt P3.
Zmiana w starym formacie zachowująca rozmiar i dokładnie ten sam `mtime` jest
niewidoczna dla `stat`, ale z id okresowy odczyt ogranicza okno do najwyżej 19 dopisków
po przejęciu lub adopcji, także dla cache sesji niczyjej (zwykle zero dzięki metadanym).
Pozostaje wyścig między sprawdzeniem
a zapisem/odtworzeniem: adapter nie oferuje atomowego porównania i zapisu. Rzeczywiste zachowanie
mtime/rozdzielczość na Capacitorze i desktopie wymaga próby na urządzeniach.

`sessionOwnership.test.ts` sprawdza odmowy, przejęcie, restore, adopcję/P3, stary
czytnik, samonaprawę i archiwum. Fixture `fixtures/device-session-baseline.json`
z 558d888 pozostaje niezmieniony: dla null pełne bajty i wszystkie liczniki;
dla id te same read/write/exists/append oraz dodatkowy stat na dopisek.
D2d odtwarza scenariusz 74 z id: last_used wygrywa z inną istniejącą sesją lokalną,
wiadomość i epoka zachowują literalny prefiks, epoka tylko w dopisku, brak nowych
plików active, a dopiero metadata-only `saveSession` dodaje właściciela bez kopii.
Pozostałe testy D2d sprawdzają wszystkie poziomy wyboru, pomijanie foreign/ambiguous
oraz adopcję przy metadanych po różnych typach zdarzeń.

`sessionOwnership.review.test.ts` używa OSOBNYCH adapterów nad wspólnym dyskiem:
pierwszy dopisek po przejęciu, zewnętrzny własny dopisek bez newline, UTF-8 i koszt
ciepłego zapisu, brak/błąd/niewiarygodny stat oraz odmowy wszystkich pisarzy dla
konfliktów i duplikatów. D2d sprawdza dokładne bajty dopisków live/frozen/bezgłowych,
możliwość dopisku drugiego
urządzenia przed zapisem metadanych i odmowę pierwszego po tym zapisie.
D2e aktualizuje dokładne liczniki i zachowanie bajtów dla 20 zdarzeń niczyjej sesji
z id (jeden read) i bez (zastany exists). Sonda na osobnych adapterach odtwarza
adopcję przez `saveSession` B przy BOM, CRLF, istniejących updated/messageCount
i równych rozmiarze/mtime: 19 dopisków A, odmowa dwudziestego przez
`ForeignSessionError`, nietknięte bajty po odmowie i historia ze świeżego czytnika.
Osobny test sprawdza tę samą granicę dla niejednoznacznego nagłówka.
D2c nadal sprawdza 40 dopisków własnej sesji, kolizje rozmiaru/mtime (odmowa zdarzenia
20), A -> B -> A -> B, archiwum, BOM/CRLF i szerokie identyfikatory. Macierz kopii
została wyłącznie dla przejęcia: sukces, brak/błędna kopia, wyjątek po 20 bajtach,
cichy częściowy zapis, błąd odczytu kontrolnego i dwie awarie odtworzenia.

## Mobile M2 D7 - naprawa rozmowy ze znacznikami konfliktu

`sessionConflict.ts` jest czystą warstwą rozpoznawania konfliktów nad istniejącym
`parseActiveSession`. Wynik `mergeSessionConflict` ma `kind`: `not-applicable`,
`unresolved` albo `merged` z tekstem. Granice surowych bloków używają tego samego
`SESSION_BLOCK_BOUNDARY` z `activeSessionFormat.ts`, co parser (również bloki legacy
bez poprawnego czasu). Escapowanie `## ` przez pisarza chroni treść pól.

**D7e:** kompletność dosłownych bloków nie dowodzi braku konfliktu: zdiff3 przy
remisie czasu może wyciągnąć wspólny nagłówek i końcowe seq poza blok konfliktu.
Świadek nie jest wdrożony; 18 kontrprzykładów w `sessionConflict.strict.test.ts`
pozostaje strażnikami `unresolved`.

W skanerze zmieniono tylko porzucenie oczekującego otwarcia na końcu pliku:
ustawia `malformed`, ale nie `malformedStructural`. Bez innego dowodu struktury
wynik to `not-applicable`; przy innym poprawnym bloku strukturalnym nadal odmowa.
Prawdziwy git zamyka blok wierszem zamknięcia; otwarcie z pytania użytkownika
może natomiast czekać do EOF także po kolejnych pełnych zdarzeniach. Minimalna
reprodukcja z samym `<<<<<<< HEAD`, odpowiedzią, dwiema dalszymi turami, save i
archive przechodzi z zachowaniem bajtów i uporządkowanego I/O względem kontroli.

**Punkt 2 propozycji D7e odrzucony na pomiarze, zgodnie z warunkiem paczki.**
Nie ograniczamy `malformedStructural` przy nowym otwarciu do bloków, które już
widziały separator. Pełny przykład po naszej stronie rzeczywistego scalenia
zmieniał wtedy `unresolved` na `not-applicable`: 6/48 reprodukcji literalnych
znaczników (merge/diff3/zdiff3, LF/CRLF, obie strony), zero zmian na `merged`.
Układ: prawdziwe otwarcie, nagłówek zdarzenia A, content z pełnym przykładem,
prawdziwy separator, nagłówek zdarzenia B, prawdziwe zamknięcie, wspólne seq.
Literalne otwarcie porzuca prawdziwy blok PRZED jego separatorem, mimo że ten
blok widział już nagłówek A. Literalny przykład jest niestrukturalny, prawdziwe
zamknięcie zostaje luźne; bez zapamiętanej struktury skaner uznałby konflikt za
zwykłą treść. Oryginalny warunek przy nowym otwarciu pozostaje nietknięty.

`sessionConflict.healthy.test.ts` buduje 30 syntetycznych wariantów: native/fallback,
live/frozen, z id/bez, LF/CRLF (nagłówek i payload; pisarz dopisuje własne LF).
Z 480 przebiegów 352 kończą trzy tury, save i archive, a 128 odmawia bez zmiany
pliku. Każdy dopisek ma niezależny literalny wzorzec bajtów, odczyt potwierdza
wiadomości, a kontrola z neutralnymi znakami tej samej długości porównuje wszystkie
pliki i uporządkowane operacje, także argumenty write/append i mtime. Osobny pomiar
z pisarzem kontrolnym z `3b0a672` potwierdza zgodność tego I/O i bajtów. Archive
zachowuje dotychczasową konwersję do transkryptu LF. To pomiar w Node, nie na telefonie.

Osiem nadal odmawianych zdrowych wariantów (każdy w 16 konfiguracjach) ma poniższe
payloady pierwszych zdarzeń. `O` = `<<<<<<< HEAD`, `S` = `=======`, `C` =
`>>>>>>> branch`, `E` = `O\nLeft\nS\nRight\nC`, `fence(x)` = ogrodzenie diff.
Kolejne tury zawierają zwykłe pytania i odpowiedzi.

| Wariant | User | Assistant | Tool |
|---|---|---|---|
| opening then example | O | E | Wynik |
| opening then tool example | O | Odpowiedź | E |
| opening then closing | O | C | Wynik |
| opening then tool closing | O | Odpowiedź | C |
| three-message pseudo-block | O | S | C |
| separator then new opening | O\nLeft\nS | O | Wynik |
| fenced pseudo-block | fence(O) | fence(S) | fence(C) |
| two openings | O | O | Wynik |

Legacy bez seq: pełny przykład w jednym zdarzeniu nadal daje `not-applicable`;
samo otwarcie i następne zdarzenie teraz także daje `not-applicable` dzięki EOF;
otwarcie i zamknięcie w różnych zdarzeniach nadal daje `unresolved`.
Nie zmieniamy formatu, pisarzy, I/O ani zasad kopii. Nie proponujemy kolejnego świadka.

D7c zastępuje heurystykę pól/ID z D7b następującymi regułami:

- Jeden przebieg wierszy zapisuje granice rozłącznych bloków. Otwarcie `<<<<<<<`,
  baza `|||||||` i zamknięcie `>>>>>>>` mają siedem znaków, samych albo ze spacją
  i etykietą. Separator to dokładnie `=======`. Poprawny blok ma jedno otwarcie,
  opcjonalnie jedną bazę przed separatorem, jeden separator i jedno zamknięcie.
  Separator i baza poza blokiem są treścią; luźne otwarcia/zamknięcia są zapamiętane.
- Struktura to granica `SESSION_BLOCK_BOUNDARY` wewnątrz bloku albo frontmatter
  rozpoznany pozycyjnie (nie `key: value` w wiadomości). Bez struktury wynik jest
  `not-applicable`, także dla niepełnych/zagnieżdżonych przykładów w jednym polu.
- W obecności struktury luźne znaczniki, zagnieżdżenia, dodatkowy separator lub
  zła kolejność bazy oznaczają `unresolved`.
- Para surowych etykiet pierwszego bloku strukturalnego obowiązuje wszystkie
  bloki strukturalne, również w nagłówku pliku. Blok bez struktury o tej samej
  parze przed pierwszym blokiem strukturalnym zdarzeń jest niejednoznaczny:
  odmowa. Po nim jest rozcinany. Inna para przed nim oznacza literalny przykład,
  zachowany bajt w bajt; po nim oznacza odmowę. Brak konfliktu zdarzeń ustawia
  tę granicę na koniec pliku. ID i nazwy pól nie rozstrzygają już przykładów.
- Strony powstają tylko z rozcięcia bloków rozpoznanych jako rzeczywiste. Każda
  jest sprawdzana osobno przed unią. Wszystkie bloki, których nagłówki poprzedzały
  pierwszy strukturalny blok zdarzeń, muszą być identyczne po obu stronach,
  razem z białymi znakami. Dotyczy to też bloku uciętego otwarciem pseudo-konfliktu
  wewnątrz wiadomości: nie wystarcza identyczny fragment przed znacznikiem.
- Dopiero po walidacji działa dotychczasowa unia surowych bloków, sortowanie czasu
  i sprawdzenie granic/epoki wyniku. Ani bloki, ani `seq` nie są przepisywane.
- Skan nie parsuje narastającego prefiksu, nie buduje regexów w pętli i nie
  przechowuje kopii każdej linii. Rozpoznawanie i walidacja są liniowe w rozmiarze
  tekstu; istniejące sortowanie unii pozostaje O(liczba zdarzeń log liczba zdarzeń).
  Bez ciągu `<<<<<<<` rozpoznawanie kończy się na `includes`, jak przed D7c.

**Uzasadnione odstępstwo od B z paczki:** niepoprawny blok zawierający strukturę
również daje `unresolved`, nawet bez innego, poprawnego bloku strukturalnego,
z wyjątkiem porzucenia oczekującego otwarcia na EOF opisanego w D7e.
Pomiar `sessionConflict.strict.test.ts`: prawdziwy `git merge-file` z dopiskiem
`before`, literalnym otwarciem/separatorem/pełnym przykładem i `after`, dla
merge/diff3/zdiff3 oraz LF/CRLF, daje 18 takich przypadków. Dosłowne B zwracało
`not-applicable`, pozwalając pisać do konfliktu wbrew wymaganiu tej samej paczki.
To rozszerza tylko odmowę, nigdy automatyczne scalanie. Przykłady bez nagłówków
zdarzeń/frontmattera pozostają zwykłą treścią.

**Dowód kompletności strony:** `_nextSeq` przy zapisie w AgentMemory zwiększa
maksymalny numer ze świeżego odczytu (`_refreshSessionWriterState` ustawia
`maxSeq(content)`, `_nextSeq` zwraca licznik + 1), a `formatSessionEvent` emituje `seq` jako ostatnie pole dla
każdego typu, także nieznanego, pustego wyniku narzędzia, `messages_removed`,
`sub_task_history` i `session_epoch`. Wymagamy pojedynczego końcowego pola z dodatnią
bezpieczną liczbą całkowitą. D7d wymaga ściśle rosnących numerów tylko w części
rozbieżnej każdej strony (indeks bloku >= `prefixEvents`), a jej pierwszy numer
musi przekraczać maksimum całego wspólnego prefiksu (0 przy braku numerów).
W bajtowo identycznym prefiksie dopuszczamy powtórzenia i spadki numerów po
wcześniejszych naprawach; pozostałe reguły kompletności pozostają bez zmian.
Luki są dozwolone. Nie wymagamy `content`, `result`, ID ani pól specyficznych
dla typu: pisarz pomija puste wartości. Starszy format v1 i transkrypt nie miały
`seq`; takie bloki dopuszczamy wyłącznie we wspólnym, bajtowo identycznym prefiksie.
Rozbieżny blok bez dowodu zakończenia odmawia zamiast udawać, że jest kompletny.
Zdrowe pliki nadal czyta zwykły parser, bez tych wymagań. Wcześniej scalony log
może mieć powtórzone lub malejące `seq`: kolejny konflikt dopisków ponad maksimum
takiego wspólnego prefiksu może być naprawiony bez zmiany historycznych numerów.

Gwarancja `maxSeq + 1` dotyczy odczytanego pliku: frozen append i ensure odświeżają
licznik przy odczycie, live append przy zimnym cache/weryfikacji, a naprawa zawsze
ustawia go z wyniku unii. Zastane wyjątki: ciepły live append może nie zauważyć
zewnętrznego zapisu; `saveSession` i fallback append bez naprawy mogą użyć ciepłego
licznika zamiast maksimum świeżego pliku. Kolejka nie chroni przed innym adapterem.
Tak powstały rozbieżny numer <= maksimum prefiksu nadal daje odmowę: nie ma dowodu
bezpiecznej kontynuacji, a rozluźnienie tej granicy osłabiłoby rozpoznawanie D7c.
D7d nie zmienia pisarzy, cache ani I/O zdrowych plików.

**Granice odmowy:** literalny znacznik lub `=======` w strukturalnym konflikcie
rozchodzących się wiadomości,
zagnieżdżony przykład, wspólny przykład o tych samych etykietach co merge,
przykład o innych etykietach po rozbieżności, niepełne zdarzenie i niezgodny
prefiks dają `unresolved`. Remis czasu może zostawić wspólny nagłówek przed
pierwszym hunkiem: wtedy odmawiamy, jeśli nie da się dowieść wspólnego bloku.
Sam remis w kompletnych blokach nadal ma stabilny porządek. Konflikt wyłącznie
wartości pól, bez żadnej struktury, pozostaje `not-applicable` według B: nie można
go odróżnić od zdrowej rozmowy o gicie. Odmowa zostawia plik nietknięty i blokuje
dalszy zapis; użytkownik zaczyna nową rozmowę. Oryginalny przykład o INNYCH
etykietach we wspólnej wiadomości, również bez ID, jest teraz zachowany przy
prawdziwym konflikcie późniejszych dopisków. Zdrowe pseudo-bloki obejmujące kilka
wiadomości nadal odmawiają: otwarcie/separator/zamknięcie, otwarcie/późniejsze
zamknięcie oraz otwarcie/separator/kolejne otwarcie. Pozostawienie punktu 2 bez
zmiany utrzymuje także odmowę otwarcie/późniejszy pełny przykład i dwóch otwarć.
Znane przepuszczenie jak przed D7: remis czasu i literalne otwarcie po naszej
stronie, bez innego bloku strukturalnego, może dać `not-applicable` (zmierzone
merge i zdiff3, LF/CRLF; diff3 w tej reprodukcji nadal odmawia). Również rzeczywiście
ucięty plik bez końcowego zamknięcia i bez innego dowodu struktury może zostać
uznany za treść; EOF nie jest dowodem zdrowia ani pełnej synchronizacji.

Unia bloków usuwa tylko bajtowo identyczne kopie po przeciwnych stronach; powtórzenia
wewnątrz jednej strony zostają (maksimum liczności z obu stron). Bloki nie są
przepisywane ani maskowane podczas samej naprawy, CRLF i seq zostają. Sortowanie
po czasie jest stabilne, przy remisie nasze bloki są pierwsze. Blok bez parsowalnego
czasu zachowuje kotwicę poprzedniego datowanego bloku swojej strony; początkowe
niedatowane bloki zostają na początku. Nagłówek bierze nasze bajty, jeśli oba są
identyczne albo różnią się wyłącznie liniami `updated`/`messageCount` we frontmatterze.
Każda inna różnica (także nieznane pole/tytuł), niejednoznaczny `device` lub różna
efektywna epoka odmawia. Ponowne rozbicie wyniku musi zachować każdy blok i jego
nagłówek, a istniejący parser musi zwrócić tę samą epokę. Brak newline, który skleiłby
dwa nagłówki, oznacza odmowę, nie dopisanie wymyślonych bajtów.

`seq` nie identyfikuje wiadomości: parser nie sortuje po nim ani nie usuwa duplikatów,
a następny zapis zaczyna od `maxSeq + 1`. `legacy:N` zależy od pozycji wiadomości,
nie od seq; `session_epoch` nie zwiększa N. `messages_removed` działa po ID i zakresach
pozycyjnych. D7 zachowuje usunięcia po jawnych ID, ale odmawia automatycznego scalenia
z kontrolnym blokiem odwołującym się do `legacy:N` lub niepustym `removed_ranges`:
przeplatanie mogłoby zmienić cel albo objąć wiadomości drugiej strony. Nie zmieniamy
ID ani seq w surowych blokach. Resolver epoki musi zgadzać się na obu stronach i po
sortowaniu, również gdy epoka pochodzi z eventu zamiast frontmattera.

D7b chroni również usunięcia oczekujące w starym oknie. `sessionRemovals.ts`
porównuje zakresy z widocznymi ID z aktualnego odczytu w kolejce `saveSession`.
Jeżeli zakres objąłby ID spoza jawnej listy usuwanej przez okno, zapisuje tylko
listę ID i usuwa ten zakres. Zdrowy zakres zachowuje bajty i dotychczasowe I/O.
Decyduje treść, więc działa to również po naprawie wykonanej wcześniej przez inny
adapter. Dla `legacy:N` potrzebny jest dowód, że odczytany przez okno event-log
nadal jest prefiksem bieżącego logu (frontmatter pomijamy, dopiski na końcu są
dozwolone). D7c rejestruje w WeakMap wyniku i tablicy wiadomości wyłącznie długość
części zdarzeń w jednostkach UTF-16 i 32-bitowy FNV-1a po tych jednostkach.
D7e dodaje drugi 32-bitowy skrót multiply-add (ziarno 5381, mnożnik 33), liczony
w tym samym przebiegu; `SessionRemovalContext` niesie `length`, `hash` i `hash2`.
`sessionRemovalContext` przekazuje ten mały odcisk do okna/pisarza; klucz zapisu
usunięcia nie serializuje już pełnego źródła. Odczyt liczy skrót raz, liniowo;
sprawdzenie legacy liczy skrót prefiksu nowego źródła o starej długości. Brak odcisku,
skrócenie lub różnica któregokolwiek skrótu odmawiają. To nie jest dowód
kryptograficzny: wspólna kolizja obu skrótów jest nadal możliwa. Brak nowych pól
danych użytkownika. Test D7e w `sessionConflict.strict.test.ts` używa syntetycznej
kolizji pierwszego skrótu całego logu: niezmieniony odczyt pozwala usuwać, ale
podmiana na drugą treść blokuje zapis i pozostawia nową wiadomość widoczną.
Bez dowodu lub bez jawnych ID usunięcie rzuca `SessionRemovalConflictError` przed
zapisaniem usunięcia/ogona; wcześniejsza naprawa z kopią może już pozostać na dysku.
Ślad jest wyłącznie w RAM i nie trafia do modelu ani loga. Zmiana wcześniejszych
bajtów logu może odmówić nawet semantycznie bezpiecznej operacji legacy: użytkownik
ponownie otwiera rozmowę zamiast ryzykować usunięcie innej wiadomości.

`loadActiveSession` używa jednego wyniku `mergeSessionConflict` do parsowania,
unieważnienia cache i ustalenia własności. Bez `<<<<<<<` analiza nadal kończy się
na sprawdzeniu obecności tego ciągu. Rejestracja odcisku odczytu D7c ma liniowy
koszt CPU i stały koszt przechowywania, bez dodatkowego I/O.

Testy D7b w `sessionConflict.review.test.ts`: zachowanie surowych pól i kopii,
odmowa dla metadanych oraz niejednoznacznych przykładów, 72 rzeczywiste wywołania
`git merge-file` (normal/diff3/zdiff3, 0/1, 1/3, 3/3 tur, narzędzia, remisy czasu),
także zdarzenia legacy bez ID i dowód identycznych bajtów prefiksu różnych historii,
usunięcia na osobnych adapterach nad wspólnym dyskiem przed/po wcześniejszej naprawie,
odmowa legacy, dokładne bajty zdarzenia i I/O zdrowego usunięcia.

Testy D7c/D7e w `sessionConflict.strict.test.ts`: 48 rzeczywistych konfliktów z literalnymi
znacznikami po obu stronach i odmową pierwszego zapisu (w tym pierwotne 18
uszkodzonych bloków ze strukturą), 6 wariantów par etykiet, pseudo-blok między
wiadomościami, zdrowe przykłady z dokładnymi bajtami/I/O, błędne znaczniki,
kompletność/seq/prefiks, odcisk usunięcia i pomiary odczytu 1/5 MB (bez przykładów,
20 przykładów, gęste przykłady) oraz prawdziwego konfliktu 1 MB, z progiem 2 s.
Pięć istniejących fixture'ów ma wyniki jak przed D7c, także identyczne bajty obu napraw.
W dawnej macierzy 72 wejść zmieniają się 44 wyniki: 40 `merged -> unresolved`
z powodu powtarzanego/malejącego `seq` w syntetycznym generatorze oraz 4
`unresolved -> not-applicable` (merge, 3/3 tur, remisy: brak strukturalnego bloku,
reguła B). Nie zmieniono tych wejść; asercje są teraz dokładne, bez `t.pass()`.
Dodatkowe 72 warianty używają numeracji gwarantowanej przez pisarza, obejmując
udane unie, odmowy niejednoznacznych remisów i nieoznaczalne konflikty samych pól.
Istniejące testy D7 świadomie zmieniły oczekiwania dla rozbieżnych bloków bez seq,
powtórzeń seq, drugiego scalenia takiej historii, różnych par etykiet nagłówka
oraz wspólnych przykładów legacy o innych etykietach; mają także pozytywne
przypadki wspólnego legacy prefiksu, stabilnego remisu i rosnących numerów.

Testy D7d w `sessionConflict.repeated.test.ts`: dwa pełne cykle dopisków A/B,
prawdziwego `git merge-file` i naprawy pierwszym zapisem, w merge/diff3/zdiff3,
z native append oraz fallbackiem. Osobne adaptery i identyfikatory nad wspólnym
dyskiem pracują na starszej niczyjej sesji; literalne bajty i odczyt rozmowy
potwierdzają kolejność, zachowane numery, brak znaczników oraz dwie wierne kopie.
Osiem odmów sprawdza na obu stronach numery poniżej/równe maksimum prefiksu
(większemu od jego ostatniego numeru), spadek i powtórzenie w części rozbieżnej.
Pozytywny przypadek obejmuje legacy bez seq, powtórzenia/spadki prefiksu i luki.
Test trzech stron w `sessionConflict.test.ts` rozszerzono o udane kolejne scalenie
ze wspólnym powtórzonym seq. Dawna odmowa powtórzeń wewnątrz rozbieżnego hunka
pozostaje; przypadki odmowy i pseudo-bloku z `sessionConflict.strict.test.ts`
nie zmieniają asercji.

Czytelnicy: `loadActiveSession`, `_parseActiveSessionFile`, lista sesji i restore;
`SaveSessionWorkflow` czyta przez `loadActiveSession`, a archiwizacja używa tekstu
po przygotowaniu zapisu. Konsolidacja L1 czyta dopiero pochodne archiwum, bez nowego
formatu. Sam odczyt nie zapisuje pliku ani kopii. Opcjonalne diagnostyczne pole
`conflict: 'unresolved'` istnieje tylko w wynikach odczytu/listingu, nigdy w danych
vaulta. Nienaprawialny plik jest parsowany dotychczasową drogą. Jego wpis stanu nie
jest usuwany przez pruning czatu tylko dlatego, że parser nie odzyskał wiadomości.

Wszyscy pisarze active używają `_prepareSessionWrite` pod istniejącą kolejką pliku:
append live/frozen (także fallback bez native append), save, archive, discard,
ensure epoki i takeover. Tekst pochodzi z odczytu, który już wykonywali.
Naprawa jest dozwolona dla `mine`/`unowned`, także bez lokalnego id. Konflikt wyłącznie
metadanych pochodnych ocenia własność po rekonstrukcji nagłówka; różnice tożsamości
pozostają niejednoznaczne. Cudzy konflikt blokuje nawet jawne przejęcie; zdrowe
przejęcie zachowuje D2. Nienaprawialne uszkodzenie daje publiczny `SessionConflictError`,
a odmowy własności z id nadal `ForeignSessionError`.

Przed pierwszą zmianą `sessionHeaderWrite.ts` zapisuje i odczytuje wierną kopię
`.pkm-assistant/backups/session-<agent>-<sesja>-<czas>[-<sufiks>].md.bak`, bez nadpisania
wcześniejszej kopii i bez rotacji ustawień. Potem sprawdza źródło, zapisuje scalone
bajty i sprawdza je odczytem. Sukces loguje jeden warn ze ścieżkami, bez treści.
Dopiero wtedy biegnie właściwa operacja. Błąd kopii blokuje zapis; błąd zapisu/readbacku
wywołuje jedną próbę odtworzenia oryginału i odmowę, także po udanym odtworzeniu.
Jeżeli odtworzenie zawiedzie, zostaje zweryfikowana kopia oraz error w logu.
Zmiana źródła podczas kopii daje jeden świeży odczyt i ponowną ocenę (również własności).
Druga zmiana odmawia. Kopie zostają także po odmowie. Nie ma atomowego compare-and-swap
ani blokady synchronizatora; pozostaje okno między ostatnim porównaniem a zapisem,
również podczas przywracania po awarii, jak w D2.

Wykrycie konfliktu unieważnia wspólny cache pisarzy adaptera, także w list/load, readbacku epoki i przy
odmowie. Sukces odświeża seq/newline/własność/rozmiar, unieważnia mtime oraz licznik
pokrycia autosave. Native append ustala własne mtime jak w D2. Zdrowy plik zachowuje
bajty, kolejność i liczbę operacji adaptera; odczyty nie podgrzewają cache naprawionym
tekstem z RAM. Ciepły native append bez odczytu pozostaje bez odczytu: z id konflikt
wykrywa zmieniony stat lub odczyt co 20 zdarzeń, bez id dopiero następny rzeczywisty
odczyt (sam okresowy exists nie wykrywa konfliktu). Do tego czasu istnieje okno
niewidocznej zmiany zewnętrznej. Pisarz zamrożonej sesji czyta przed każdym dopiskiem.

Testy D7: `sessionConflict.test.ts` (13) i `AgentMemory.conflict.test.ts` (33),
próbki z libgit2 w `fixtures/session-conflict/` (w tym baza, obie strony,
konflikt i powielenie z 313df88; układ konfliktu z prawdziwego scalenia, wyniki narzędzi
we wspólnej części zastąpione danymi syntetycznymi - próbki nie mogą zawierać treści
z niczyjego vaulta). Obejmują literalną rozmowę, surowe bloki, diff3/CRLF,
metadane, przykłady, trzy strony, seq/ID/usunięcia/epoki, wszystkich pisarzy, błędy
kopii/zapisu/readbacku/odtworzenia, pull podczas kopii, współdzieloną kolejkę i cache.
Istniejące golden testy D2 oraz append/P3 nadal sprawdzają dokładne zdrowe bajty i I/O.
D7e rozszerza macierz review do 288 wejść przez CRLF, a repeated o 24 przebiegi
po trzy cykle (72 scalenia) z native/fallback i live/frozen. Bez osłabienia odmów
prawdziwego gita, w tym wszystkich 18 kontrprzykładów świadka. Sześć nowych prób
gita zaczyna konflikt od pierwszego zdarzenia. Pięć fixture'ów zachowuje wyniki.
Pomiar porównawczy D7e z kodem sprzed zmiany na tych samych wynikach gita:
466 wywołań, 162 `merged`, 188 `unresolved`, 116 `not-applicable`, zero zmian
wyniku (także bajtów każdego `merged`). Review: 288 = 64/112/112; repeated:
93 = 85/8/0; strict: 85 = 13/68/4, w kolejności merged/unresolved/not-applicable.
Część `not-applicable` to bezkonfliktowe scalenia 0/1. Wszystkie pięć fixture'ów
ma także identyczny wynik i bajty jak przed D7e. Mutacje: cofnięcie wyjątku EOF
wywraca 115 testów; zastosowanie odrzuconego punktu 2 wywraca 55 (w tym 6
prawdziwych konfliktów); pominięcie porównania drugiego skrótu wywraca 1 test.
Każdą mutację cofnięto przed bramkami. Punkt 2 nie jest wdrożony, więc nie ma
osobnej mutacji jego „cofnięcia”.
Jedyna świadoma zmiana istniejącej asercji w `sessionConflict.test.ts` dotyczy
ręcznie uciętego bloku bez zamknięcia: `unresolved -> not-applicable`, zgodnie
z regułą EOF; pozostałe odmowy w tym teście pozostają bez zmian.


## Mobile M2 D4 - dziennik kosztów dopisywany natywnie

`CostLog.append` na obu platformach preferuje opcjonalny `adapter.append`:
jeden rekord z końcowym `\n`, bez odczytu, exists ani write na udanej ścieżce.
Ścieżka `.pkm-assistant/cost_log.jsonl`, normalizacja, kolejność pól i bajty rekordów
pozostają bez zmian. Istniejący prefiks (także bez newline) pozostaje nietknięty.
Wykrycie metody i rozróżnienie błędu przez `probeFile` pochodzą ze wzorca
`AgentMemory._appendSessionFile`; `brain.log` nadal używa read-modify-write.
Jeśli append rzuci, tylko potwierdzone `missing` pozwala utworzyć plik przez write
z jednym rekordem, po `ensureAdapterFolder` dla rodzica. Adapter potrafiący sam
utworzyć plik nie wymaga tej ścieżki. Istniejący lub niepewny plik nie jest
przepisywany po błędzie; kłamiące `exists=false` potwierdza próba odczytu.
Błędy pozostają best-effort: warn, zwrot znormalizowanego rekordu, bez rzutu.

Bez native append pozostaje dokładnie `readIfExists` + `write(existing + line)`:
nieczytelny plik pomija wpis. Zdrowy istniejący plik to 1 read + 1 write;
brak pliku to read + exists + read + write, jak przed D4. Nie dodajemy do tego
fallbacku nowych zapisów folderów ani kopii, nie interpretujemy starej treści.
Kolejka obietnic według wzorca AgentMemory obejmuje obie ścieżki, współdzielona
przez instancje dla tej samej pary adapter/ścieżka (`WeakMap`). Jest potrzebna,
bo wołacze tworzą krótkotrwałe instancje CostLog. Błąd nie blokuje kolejnych wpisów.

`readAll` jest jedynym czytnikiem pliku, także dla agregacji `CostTrackingModal`.
Pomija znaczniki gita, puste i uszkodzone wiersze; rekordy obu stron zwraca
w kolejności pliku, bez deduplikacji. Gdy wiersz nie parsuje się jako JSON,
skaner granic obiektów uwzględniający stringi, escape i zagnieżdżenia próbuje
rozdzielić bezpośrednie `}{`. Wszystkie części muszą osobno parsować się jako JSON;
uszkodzona część, obcy separator lub niepełny obiekt oznacza pominięcie CAŁEGO
wiersza. Poprawne pojedyncze wiersze mają dotychczasową interpretację.
Odzysk istnieje tylko w RAM, bez zapisu ani kopii źródła.

Ograniczenia: kolejka nie blokuje synchronizatora ani innych adapterów/urządzeń;
pozostaje wyścig tworzenia brakującego pliku między probe a write. Starszy plugin
i fallback nadal przepisują cały plik, więc mogą zgubić równoległy dopisek.
Przegląd repo nie wykazał innej rotacji, przycinania, migracji ani eksportu
nadpisującego ten dziennik. Częściowo wykonany append nie jest cofany ani ponawiany
na istniejącym pliku. Nie obiecujemy atomowości I/O urządzenia ani naprawy gita;
odczyt nadal ładuje całość dziennika do RAM i zachowuje dotychczasowy wstępny exists.

## Mobile M2 D3 - brain.md po konflikcie gita

`brainConflict.ts` rozpoznaje kompletne, niezagnieżdżone bloki merge/diff3/zdiff3.
`mergeBrainConflict` jest czysty: wynik `merged` z tekstem albo `not-applicable`
(z `malformed:true` dla złej struktury lub niespełnionego niezmiennika).
D3c scala dwie pełne strony, a D3d usuwa całą obsługę ogrodzeń kodu:

- Bez ciągu `<<<<<<<` kończymy na jednym `includes`. W przeciwnym razie jeden
  liniowy przebieg szuka wiersza otwarcia według `isGitConflictStart` oraz
  dowolnego wiersza z 0-3 spacjami i co najmniej trzema backtickami lub tyldami.
  Ich kolejność, sekcja, poprawność informacji po ogrodzeniu i zamknięcie nie mają
  znaczenia. Oba sygnały dają `not-applicable` BEZ `malformed` i bez warningu.
  Również prawdziwy konflikt obok kodu NIE jest automatycznie naprawiany.
- Plik z ogrodzeniem wraca do zachowania sprzed D3 (`5fe75ee`): odczyt granicy
  tekstowej zwraca oryginalne bajty, przebudowa używa zwykłych parserów. Nie ma
  dodatkowych kopii w `backups/`. Dotychczasowy `brain.md.bak`, dosztukowanie
  nagłówków przez `getBrain` i interpretowanie H2 wewnątrz kodu zostają.
  To nie jest gwarancja zachowania całego bloku kodu przy przebudowie: stary parser
  może usunąć jego niewypunktowany tekst w sekcji "Na teraz". D3d świadomie nie
  rozszerza ochrony tego wyjątkowego formatu indeksu.
- Bez ogrodzeń odtwarzamy obie pełne projekcje konfliktu, pomijając bazę diff3.
  Sekcja to preambuła (razem z H1) lub H2 z treścią do następnego H2. Rozpoznawanie
  H2 korzysta z `isBrainSectionHeading` w `BrainIndex.ts`, tej samej funkcji co
  `parseManualIndexLines` i `parseForeignSections`: pełny `trim()` i `##` z białym
  znakiem oraz niepustym tytułem. Dawny wzorzec scalania ograniczony do trzech
  spacji pomijał tabulatory, większe wcięcia i białe znaki Unicode; teraz je widzi.
  Klucz sekcji nadal stanowi cały surowy nagłówek po `trimEnd`, bez zmiany bajtów.
- Klasyfikacja zarządzanych/obcych i "Na teraz" w drugiej samokontroli należy
  wyłącznie do istniejących parserów, z ich `sectionKeyOf` i `isNaTerazHeading`.
  Zastana subtelność: `parseNaTerazSections` wymaga dopasowania całego tytułu przez
  `(.+)`, więc U+2028/U+2029 wewnątrz H2 może nie zamknąć poprzedniej sekcji
  "Na teraz", choć zamyka sekcję ręczną/obcą. Nie zmieniamy zdrowego parsera;
  druga samokontrola odmawia, jeśli taka różnica spowodowałaby stratę.
- Różne H1 (także brak po jednej stronie) dają `malformed`; końcowe białe znaki
  H1 nie stanowią różnicy. Nasza strona zachowuje bajty, kolejność i powtórzenia.
  Brakujące niepuste wiersze ich sekcji dopisujemy za ostatnim niepustym wierszem
  ostatniego naszego wystąpienia tego nagłówka, przed końcowe puste wiersze.
  Deduplikacja używa `trimEnd` w obrębie całej sekcji, także preambuły.
- Całe sekcje obecne tylko po ich stronie, również puste i powtórzone, trafiają
  za ostatnie wystąpienie poprzedzającej je sekcji ich wersji, albo na koniec.
  Scalanie nigdy nie usuwa: może przywrócić wiersz skasowany po jednej stronie.
  Każdy dopisek zaczyna się osobnym wierszem: brakujący EOL uzupełniamy CRLF,
  jeśli występuje w pliku, inaczej LF. BOM pozostaje w projekcji odczytu.
- Pierwsza samokontrola sprawdza brak znaczników oraz każdą parę (sekcja,
  niepusty wiersz po `trimEnd`) z obu pełnych projekcji w wyemitowanym wyniku.
- Druga samokontrola uruchamia rzeczywiste czyste `parseNaTerazSections`,
  `parseManualIndexLines` i `parseForeignSections` na obu stronach i wyniku.
  Każdy zachowywany element strony musi być zachowywany w wyniku: wypunktowanie
  per klucz "Na teraz", ręczny wiersz per klucz zarządzany, obcy nagłówek nawet
  pustej sekcji oraz jego niepuste wiersze. "Na teraz" porównujemy po normalizacji
  parsera i bez rozróżniania wielkości liter; pozostałe wiersze po `trimEnd`.
  Liczność duplikatów i puste separatory nie są nowym kontraktem zachowania.
  Każde naruszenie daje `not-applicable` z `malformed`, oryginał i jeden istniejący
  warning na odczyt, bez treści pliku.
- Zwykły `rebuildBrainIndex` NIE ogranicza liczby wpisów "Na teraz", więc druga
  samokontrola także nie przycina do dziesięciu. Limit należy do jawnej mutacji
  `writeNaTeraz`/`applyNaTerazOps`; dopiero ona może usunąć najstarsze wpisy.
  Deduplikacja parsera i normalizacji używa teraz zbiorów zamiast liniowych
  wyszukiwań w rosnącej tablicy, zachowując pierwszą pisownię i kolejność.
- Mapy zbiorów, ostatnich wystąpień i połączona lista sekcji zapewniają liniowy
  koszt. Samokontrola nie powiela długiego nagłówka w kluczu każdego wiersza.

Wspólna granica tekstowa `readBrainContent` jest eksportowana przez barrel dla
profilu agenta. Korzystają z niej `getBrain`, `_parseBrainSections`, przebudowa,
legacy `updateBrain`, migracja oraz oba odczyty RetrievalEngine (skan/podgląd
oraz linki wychodzące). `getMemoryContext`, AgentManager, czat i SaveSessionWorkflow
biorą indeks przez `getBrain`; narzędzia zapisu i konsolidacja przebudowują go
przez `rebuildBrainIndex`. `read(scope:memory)` czyta notatki brain/ i podsumowania,
nie indeks. Surowe kopiowanie folderu migracji zachowuje oryginał, nie projekcję.
Odczyt naprawialnego konfliktu nie zapisuje nawet brakujących nagłówków przy
bootstrapie. Zdrowy plik zachowuje dotychczasowe tworzenie/dosztukowanie nagłówków.

`brainConflictWrite.ts` przy zapisie naprawionego tekstu odkłada oryginał 1:1 do
`.pkm-assistant/backups/brain-<agent>-<czas>[-<sufiks>].md.bak` (poza rotacją ustawień).
Wzorzec D1/D7: wolny cel przez `probeFile`, kontrolny odczyt kopii, sprawdzenie
niezmienności źródła, zapis i readback, jeden warn ze ścieżkami. Błąd kopii lub
zmiana źródła blokuje nadpisanie; błąd zapisu/readbacku daje jedną próbę odtworzenia
oryginału. Nieudane odtworzenie zostawia kopię i error. `BrainWriteError` ma
wewnętrzny kod przyczyny i istniejący komunikat i18n "Save failed".
`brain.md.bak` zachowuje osobną rolę, otrzymuje tekst po scaleniu. Indeks nadal
buduje `buildBrainIndex` z realnych notatek, w dotychczasowym formacie LF;
BOM/CRLF pozostają w oryginalnej kopii i projekcji odczytu, przebudowa ma własny
historyczny format. Zdrowe ścieżki nie dostają dodatkowych odczytów ani kopii.

Świadome ograniczenie D3 (rozstrzygnięcie prowadzącego): legacy `updateBrain(content)`
pisze treść przekazaną przez wołacza (obecnie bez wywołań produkcyjnych), a bezpośrednie
`MigrationV3.applyPlan(plan)` bez oryginału buduje indeks z przekazanego planu i utworzonych
notatek. Obie drogi historycznie nie czytają celu przed zapisem i zachowują to I/O;
produkcyjne `run` przekazuje do `applyPlan` wcześniej odczytany oryginał. Konflikt
przekazany w argumencie jest chroniony kopią, lecz zdrowy argument nie wykrywa konfliktu
wyłącznie na dysku. Zewnętrzna zmiana lub konflikt dostarczony po wcześniejszym odczycie
może zostać nadpisany wraz z ręcznymi wierszami obu stron, bez kopii tej nowszej wersji.
To zastane okno utraconej aktualizacji, nie rozszerzamy I/O zdrowych ścieżek.

Pozostałe ograniczenia: brak atomowego compare-and-swap i blokady synchronizatora.
Nie zmieniamy nieoznaczonych splotów, notatek brain/, formatu danych,
limitów "Na teraz", skryptów chmury ani starszego pluginu.

Testy `brainConflict.test.ts`: literalne unie, deduplikacja, błędne znaczniki,
BOM/CRLF i prawdziwy git. Przykłady w kodzie, także obok prawdziwego konfliktu,
wymagają teraz nienaruszonego oryginału i `not-applicable`.
`brainConflict.integration.test.ts`: czytnicy/prompt, pisarze, migracja,
wyszukiwanie, kopie, awarie I/O, kolejki i literalne zdrowe bajty oraz I/O.
Usunięto test mechanizmu zastępczych znaczników; dawne oczekiwanie ochrony
ogrodzonego H2 przy przebudowie zastępuje jawny kontrakt zgodności sprzed D3.

`brainConflict.fences.test.ts` (D3d): 36 rzeczywistych scaleń trzech syntetycznych
reprodukcji (zamknięte/niedomknięte ogrodzenia oraz wspólny przykład po konflikcie
nagłówka), merge/diff3/zdiff3, LF/CRLF, BOM; 8 zdrowych plików z kodem; patologiczne
160 KiB; granice składni ogrodzeń; H2 z tabulatorem, większym wcięciem i Unicode;
odmowa drugiej samokontroli dla U+2028; zachowanie 12 wpisów po zwykłej przebudowie
oraz przycięcie po jawnej edycji. Oczekiwania bajtów i pełnego uporządkowanego I/O
są literalne i zostały także uruchomione z `AgentMemory`/`BrainIndex` z `5fe75ee`.
Dla ogrodzeń zero warningów i kopii naprawczych; istniejący `.bak` zgodny z bazą.

`brainConflict.sections.test.ts` zachowuje reprodukcje D3b/D3c i rozszerza próbę
własnościową: 720 par, 2160 wywołań gita, 2025 konfliktów i 2025 `merged`, zero
`malformed` (H1/składnia/pierwsza samokontrola/druga samokontrola: 0/0/0/0), zero
naruszeń. Edycje obejmują dodawanie/usuwanie/przenoszenie wierszy i sekcji, zmianę
nagłówka i kolejności, powtórzenia, whitespace, puste sekcje, brak końcowego EOL,
LF/CRLF. Oczekiwania zachowania liczymy przez prawdziwy `rebuildBrainIndex` każdej
pełnej projekcji gita osobno na adapterze w pamięci. Wynik konfliktu przechodzi
DWIE prawdziwe przebudowy: zachowuje unię elementów obu osobnych przebudów, druga
jest bajtowo bez zmian. To kontrola scalania względem przebudowy, nie względem
samego scalania. H1 i odmowę drugiej samokontroli sprawdzają osobne testy.

Pomiar D3d na syntetycznym pliku 163977 bajtów z wieloma wierszami ogrodzeń:
4,739 ms w Node (próg testu 100 ms). Mutacje na 138 testach D3: wyłączenie
bezpiecznika ogrodzeń wywraca 57, drugiej samokontroli 1, zastąpienie wspólnego
rozpoznawania H2 dawnym własnym regexem 4. Wszystkie mutacje cofnięto przed bramkami.
Nie jest to pomiar na telefonie ani próba synchronizacji GitSync/obsidian-git.

## Mobile M2 D6 - przegląd śladów konfliktu na żądanie

Publiczny `scanMemoryConflicts(adapter)` i typ `MemoryConflictCounts` z barrela
zwracają wyłącznie sześć liczb: `state`, `brain`, `sessions`, `costLog`, `unreadable`,
`skipped`. Funkcja nie tworzy AgentMemory, nie zapisuje, nie loguje, nie naprawia
ani nie zmienia cache. I/O to tylko wstrzyknięte `exists/list/stat/read`.
Composition root wywołuje ją wyłącznie w komendzie diagnostyki, po jawnym wyborze
zapisu raportu w oknie zgody; start pluginu nie uruchamia przeglądu.

Katalogi agentów są odkrywane przez adapter w `.pkm-assistant/agents`, niezależnie
od załadowanych profili. Sprawdzane są `.state.json`, `brain.md`, bezpośrednie
`sessions/active/*.md` i jeden wspólny `.pkm-assistant/cost_log.jsonl`. Brak rekurencji:
archiwum, `.discarded`, notatki brain i inne podfoldery pozostają poza zakresem.
Listing przyjmuje pełne ścieżki lub basenames, odrzuca obce/zagnieżdżone wpisy
oraz deduplikuje bezpośrednie dzieci.

Limit to 50 sesji na agenta malejąco po nazwie (przy typowych nazwach z datą daje
pierwszeństwo nowszym, nie jest sortowaniem po mtime). Daje ograniczony koszt bez
statowania wszystkich sesji. `stat` przed każdym odczytem dopuszcza do 1 MiB
włącznie; większe pliki oraz sesje poza limitem zwiększają `skipped`. Brak lub
niewiarygodny rozmiar nie pozwala na odczyt, zwiększa `unreadable`. Błąd odczytu,
stat, exists lub list zwiększa `unreadable` raz na dany plik/folder i nie przerywa
innych grup ani agentów. Brak oczekiwanego pliku/folderu nie jest konfliktem ani
błędem; zniknięcie sesji znanej z listingu jest nieodczytanym plikiem. Metadane
adaptera są migawką: fałszywe exists=false może pominąć folder, a wzrost pliku
między stat i read może przekroczyć próg. Bez API częściowego odczytu nie da się
zagwarantować twardego limitu zaalokowanych bajtów w takim wyścigu.

`gitConflict.ts` udostępnia wspólny `isGitConflictStart` używany również przez
`splitGitConflict` oraz liniowy `hasGitConflictStart`, bez rekonstrukcji stron.
Ślad to wiersz zaczynający się od siedmiu `<` i spacji lub równy siedmiu `<`;
CRLF działa tak jak w dotychczasowym splitterze. Jeden plik liczy się raz, również
przy niepełnym konflikcie i przy literalnym przykładzie w zdrowej wiadomości lub
ogrodzeniu kodu. To świadomie licznik śladów, nie dowód uszkodzenia.

Nie klasyfikujemy naprawialności sesji ani indeksów: nie budujemy pełnych projekcji
scalania do pomiaru liczbowego. D7c usunęło kwadratową heurystykę przykładów,
ale diagnostyka nadal wymaga tylko taniego licznika śladów. Wszystkie cztery grupy mają tę samą tanią definicję.
Koszt: listing katalogów, sortowanie nazw sesji O(S log S) oraz do 52 odczytów
na agenta i jeden wspólny, każdy po stat; skan tekstu liniowy, pliki sekwencyjnie,
bez przechowywania ich treści w wyniku. Nie ma limitu liczby agentów ani liczby
wpisów zwracanych przez pojedynczy listing. Zero zapisów oznacza też zero kopii.
D6 nie naprawia nieoznaczonych splotów i nie ustala stanu indeksu gita.

`conflictScan.test.ts`: dwa syntetyczne katalogi agentów, wszystkie grupy, przykład
w treści, zero mutacji, 50 sesji niezależnie dla każdego agenta, granica 1 MiB,
awarie folderów i odczytu, nieznany rozmiar, basenames/pełne ścieżki, deduplikacja,
wykluczenia i definicja znacznika. `src/main.mobile.test.ts` sprawdza produkcyjny
start oraz jeden odczyt obu plików kontrolnych dopiero po zgodzie na lokalny raport.
