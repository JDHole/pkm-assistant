# modules/sub-agents/

Zegar pytania po zbyt wczesnym wywołaniu timera uzbraja go ponownie na
pozostały czas; termin nadal rozstrzyga zegar monotoniczny.

Model paska `summarizeStripRows` zlicza widoczne wiersze: pracujące i zatrzymujące się, oczekujące w kolejce oraz wszystkie wiersze.

> Fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej to specyfikatory
> importów, które celowo zostają `.js`.

**Unified delegation system.** Sub-agenci to "minionki" agenta - drugorzędne instancje z własnym system promptem, własnym budżetem tokenów, własnym zestawem narzędzi. Dziedziczą model nadrzędnego agenta (override możliwy w YAML).

**Status:** 🚀 ACTIVE - kod fizycznie w `modules/sub-agents/`.

Plugin daje **jeden generyczny worker** (`delegate(task:"...")` bez `aspect` - działa nawet gdy agent nie ma żadnych subów), a każdy asystent buduje **własne custom suby** (po nazwie: `aspect:"klara-prep"`). Sub sam czyta pamięć (`search/read/list scope=memory`) albo dostaje fragment w `context` - nie ma zbiorczego wstrzykiwania pamięci na starcie. Kanał main↔sub `runTask` i przecięcie uprawnień rodzic∩sub są niezmiennikami modułu. Szablony subów w UI opisane niżej ("Szablony sub-agentów").

---

## Co tu jest

```
modules/sub-agents/
├── index.js                    # publiczne drzwi
├── CLAUDE.md                   # ten plik
├── SubAgentLoader.js           # skanuje .pkm-assistant/sub-agents/, parsuje YAML, save/delete/starter + migracje tools
├── SubAgentRunner.js           # wykonanie sub-agent z tool-calling loop
├── SubTaskRegistry.js          # SubTask jako byt (id/status/kroki/wynik/budżet) + szyna zdarzeń + side-channel abortów; pure, obsidian-free
├── SubTaskNotifier.js          # skrzynka wyników subów z tła: kolejka + `setDeliverer`/`drain`; pure, obsidian-free
├── subTaskPanelModel.js        # CO pasek biegów ma narysować (per zakładka czatu): filtr, kolejność, liczniki, skróty; pure (zero obsidian/DOM/i18n)
├── SubAgentTemplateStore.js    # magazyn szablonów subów (.pkm-assistant/templates/sub-agents/)
├── SubAgentEditorModal.js      # modal tworzenia/edycji suba; importuje `obsidian`, poza barrelem (lazy-load)
├── types.js                    # wspólne typy modułu (SubAgentData, ScopeData, …)
├── framePrompt.js              # defaultSubAgentFramePrompt() - fabryczna rama suba PL+EN (placeholdery), leniwa
├── BackstageTab.js             # register tab + lazy-load renderSubAgentsTab
├── SubAgentsBackstageTab.js    # render Sub-Agents tab w Backstage sidebar
├── SubAgentDetailView.js       # render single sub-agent detail view
├── editorDecisions.ts          # pure decisions for template editor roles, validation, and advanced section
├── deleteOutcome.ts            # resolveDeleteOutcome: co zameldować po
│                                #   próbie skasowania suba/szablonu; woła SubAgentEditorModal + SubAgentsBackstageTab
└── templateUseOutcome.ts       # guardTemplateUse: co zameldować po
                                 #   "Użyj u agenta" w Zapleczu; woła SubAgentsBackstageTab
```

> Brak osobnego folderu `roles/` i wbudowanych ról systemowych - domyślny zestaw narzędzi
> workera to stała `DEFAULT_SUB_AGENT_TOOLS` w `SubAgentLoader.js`.

**Plus YAML files w vaulcie:**
```
.pkm-assistant/sub-agents/<slug>/
├── SUB_AGENT.yaml          # config (name, description, role, tools, max_iterations, ...)
└── KNOWLEDGE.md            # specjalistyczna wiedza dla sub-agenta (body promptu)
```

---

## Public API (`index.js`)

Protokół pytań rodzica jest częścią `SubTaskRegistry`: `openParentQuestion(taskId, text)` zwraca pytanie i Promise rozstrzygnięcia albo odmowę; `answerParentQuestion(taskId, questionId, owner, text)`, `getQuestionState`, `isQuestionOpen`, `promoteToBackground` i `registerUserWait(owner, cancel)` obsługują odpowiedź, stan i pauzę. Funkcja zwolnienia kanału użytkownika jest idempotentna; `dispose` anuluje otwarte kanały. Zegar pytania mierzy monotonicznie 300000 ms, pauzuje tylko dla pełnego właściciela i nie resetuje pozostałego czasu. Stop, koniec biegu i unload zamykają oczekiwanie przed powiadomieniem obserwatorów. `SubTask.questionState` jest opcjonalne dla starszych danych, a model paska normalizuje brak do `none`.

Zmiana zegara oczekującego pytania emituje `question:clock` po zapisaniu pauzy lub wznowienia, z pytaniem jako payloadem. Model wyniku przyjmuje stan pytania oraz pytanie z wyniku; zamknięty stan ma pierwszeństwo. Dla `no-answer` udostępnia treść otwartego pytania, a `cancelled` zachowuje jako osobne rozstrzygnięcie.

`SubTaskNotifier` udostępnia dodatkowo `setNoticeDeliverer`, `pendingNotices` i `claimNotices` dla unii `SubTaskNotice` (pytanie albo wynik). Zamknięcie pytania usuwa także zajęty wpis, więc późne `ack` lub `release` nie przywróci go. Starsze metody pozostają adapterami samych wyników. Typy protokołu i zegara są eksportowane przez barrel.

Runner dodaje lokalne `ask_parent` subowi pierwszego piętra (głębokość 1, a 0 dla starszych wywołań), również przy pustej konfiguracji narzędzi. Głębszy sub nie dostaje definicji ani instrukcji w fabrycznej ramie, a jego wywołanie jest odrzucane bez otwarcia pytania. Runner odmawia `ask_user`. Odpowiedź trafia do tego samego transkryptu. Brak odpowiedzi lub anulowanie przerywa pętlę bez syntezy; partial, wynik i handoff zachowują treść pytania i rozstrzygnięcie. Hooki `onActivity` i `onQuestion` informują o otwarciu i zamknięciu. `cancelParentQuestion` zamyka oczekiwanie przy zewnętrznym abort przed publikacją partial. `DelegateTool` pauzuje budżet biegu podczas oczekiwania. Pierwsze pytanie biegu blokującego wraca bezpośrednio w pokwitowaniu i promuje bieg do tła; notifier pomija je, a kolejne pytania i wynik doręcza normalnie. Terminalne `question` zachowuje treść i rozstrzygnięcie `no-answer` lub `cancelled` w wyniku runnera, rejestru i zwrotce delegacji.

Opcjonalne `question.note` to dokładny prefiks dodany przez runnera do handoffu, po maskowaniu i przycięciu, bez separatora. Pole nie występuje, gdy nie dodano notki; typ `TerminalQuestion` eksportuje barrel. Snapshot przechowuje pytanie strukturalnie, bez dopisywania zdania o nim do `partial.text`, które może być użyte jako dorobek przy pustym handoffie.

**Publiczne drzwi modułu:** klasy runtime + helpery widoczności/migracji.

| Export | Po co |
|---|---|
| `SubAgentLoader` | Klasa - skanowanie `.pkm-assistant/sub-agents/`, parse YAML + KNOWLEDGE.md, cache, save/delete, ensureStarter |
| `SubAgentRunner` | Klasa - wykonanie sub-agent (`runTask()`), ujednolicony system prompt builder (`framePrompt.js`, NIE zależy od roli - patrz „Model delegacji" niżej), tool-calling loop przez `runAgentLoop` (`modules/agent-loop`, wspólna pętla z czatem) |
| `SubTaskRegistry` | Księga biegów subów + szyna zdarzeń (`task:*`, `thread:*`). `issueTurnStartSequence()` wydaje znacznik startu tury ze wspólnego licznika runtime. API wątków: `createThread`, synchroniczne `beginRun` z kontekstem rodzaju i znacznika bieżącej tury, `endRun`, `closeThread`, `closeSessionThreads`, `closeAll`, `listThreads`. Pure - zero `obsidian`, zero I/O. Skrzynka biegu: `attachAbort` / `requestStop` oraz `postMessage` / `takeMessages`. |
| `SubThread`, `SubThreadOwner` (typy) | Czysty byt rozmowy suba i wymagany klucz właściciela przy kontynuacji. |
| `SubRunResult`, `SubRunStoppedBy` (typy) | Kształt zwrotki `runTask` - zgodnościowe `stoppedBy` (`natural`/`backstop`/`abort`/`error`) i `failed?: true` oraz nowe `outcome`. Czyta je `DelegateTool`. |
| `buildStripModel`, `formatDuration` (+ typy `StripRow`/`StripStep`/`BuildStripModelInput`) | Czysta arytmetyka **paska biegów w oknie czatu**: filtr per zakładka, kolejność, liczniki, skróty. Konsumentem jest `modules/chat` (`chat/subTaskStrip.ts`), stąd eksport; plik zostaje pure, więc barrel dalej jest obsidian-free. |
| `SubTaskNotifier` | Skrzynka wyników subów odpalonych W TLE. Siedzi na `task:finished`, bierze WYŁĄCZNIE taski z `background === true`, trzyma je w kolejce (sufit 200, najstarsze niezajęte wypadają) aż dostawca je skonsumuje. API: `setDeliverer(fn\|null)` (`true` = skonsumowane; `false`/wyjątek = zostaje), `drain()`, `pending()`, `pendingFor(agentName)`, `claimPending(predicate)`, `dispose()`. Claim wyłącznie zajmuje wynik: `ack()` usuwa wpis, `release()` pozostawia go w kolejce; `pending()` pokazuje go do potwierdzenia, a `dispose()` unieważnia uchwyty. Stawia go composition root jako `plugin.subTaskNotifier`; dostawcę wstrzykuje czat. Pure - nigdy nie rzuca. **Dostawcą jest `ChatView`** - patrz gotcha niżej. |
| `SubTask`, `SubTaskStatus`, `SubTaskStep`, `SubTaskBudget`, `SubTaskResult`, `SubTaskOrigin`, `SubTaskDeliverer` (typy) | Kształt bytu biegu suba + adres zwrotny zlecenia + kontrakt dostawcy, dla konsumentów zdarzeń. |
| `getVisibleSubAgentsForAgent` | Filtr: **tylko** custom suby z prefiksem `<agent-slug>-` (brak ról systemowych; legacy standalone bez prefiksu ukryty) |
| `DEFAULT_SUB_AGENT_TOOLS` | Jednolity domyślny zestaw workera: `search/list/read/web_search/web_read` (`connect_to_server` wyłączony). Przecięcie z rodzicem robi `_getTools`. |
| `PKM_SUB_NAME` | Nazwa syntetycznego workera (`'pkm-sub'`) dla `delegate` bez `aspect`. |
| `SubAgentTemplateStore` | Magazyn szablonów subów (Zaplecze). Owner: `AgentManager.subAgentTemplateStore`. |
| `registerBackstage` / `renderSubAgentDetailView` | Rejestracja zakładki Zaplecza + widok detalu (lazy-load, barrel zostaje obsidian-free). |
| `defaultSubAgentFramePrompt(locale?)` | Fabryczna rama suba (`framePrompt.js`, pure/obsidian-free), w JĘZYKU INTERFEJSU. Wystawiona w Settings→Prompt, rozwiązywana łańcuchem agent>global>factory przez `resolveWorkPrompt`. **Funkcja, nie stała** - patrz gotcha „Rama suba idzie za językiem interfejsu". |

> Kilka eksportów nie wchodzi do barrela (zero konsumentów spoza modułu):
> `DEPRECATED_TOOL_RENAMES`, `migrateDeprecatedTools`, `SUB_AGENT_TEMPLATES_PATH`.
> **Definicje ŻYJĄ w bebechach** - migrację nazw narzędzi w user YAML odpala `SubAgentLoader`
> przy load (i zapisuje plik z powrotem) oraz `SubAgentRunner._resolveToolNames` jako fail-safe;
> ścieżkę magazynu szablonów zna `SubAgentTemplateStore`. `DEPRECATED_TOOL_RENAMES` i
> `migrateDeprecatedTools` mają realnego deep-importera (`SubAgentRunner.ts` / testy loadera).
> Dla `SUB_AGENT_TEMPLATES_PATH` żaden test po nią nie sięgał - sam `export` na stałej w pliku
> był zbędny: słowo `export` zdjęte, stała zostaje prywatna dla `SubAgentTemplateStore.ts`. Ta
> sama poprawka objęła `DEFAULT_RESEARCHER_MAX_TOOL_RESULT_LENGTH` w `SubAgentLoader.ts` (nigdy
> nie był w barrelu, miał jedno użycie w tym samym pliku).

**Ważne metody publiczne `SubAgentLoader`** (używane przez DI):
- `loadAllSubAgents()` - load + cache (AgentManager init)
- `getSubAgent(name)` / `getAllSubAgents()` - read cache (sidebar views)
- `saveSubAgent(data)` / `deleteSubAgent(name)` - UI tworzenia (SubAgentEditorModal)
- `ensureStarterSubAgents()` - **ensure-folder, NIE factory:** tylko sprawdza/tworzy `.pkm-assistant/sub-agents/` jeśli nie istnieje. Plugin nie zasiewa żadnych domyślnych subów.
- `reloadSubAgents()` - hot reload (clear cache + re-load)

**`SubAgentRunner` ma TYLKO 1 metodę publiczną:**
- `runTask(taskPrompt, agent, config, model, options)` - wywoływana z `DelegateTool._executeSubAgent`

---

## Klasyfikacja końca biegu

Publiczne API eksportuje `StopBy`, `RunEnd`, `RunEffect`, `RunOutcome` oraz czystą funkcję `classifyRunEnd`. Wynik opisuje rodzaj końca, kompletność, odpowiedź, materiał i efekty. `hasAnswer` jest prawdziwe wyłącznie dla niepustego `finalText` z naturalnego końca albo z ukończonej syntezy (`partial.synthesis === 'completed'`); treść odpowiedzi nie jest analizowana.

Wpisy efektów tworzy runner przy rozpoczęciu właściwego wykonania narzędzia po bramkach MCPClient albo bezpośrednio przed wykonaniem w ścieżce zapasowej. Opis celu pochodzi z `describeToolEffect` w module narzędzi; dla `memory_delete` cel pojawia się dopiero w wyniku narzędzia. Gdy celu nie da się pewnie sprawdzić, runner ustawia `not-checked`. Ledger zamyka się przed publikacją częściowego wyniku, aby odbiorca `task:partial` nie mógł zmienić opublikowanego `unknown` późnym zwrotem narzędzia. `matches` oznacza, że stan sprawdzonego celu odpowiada oczekiwanemu stanowi po operacji; nie dowodzi, że to konkretne wywołanie dokonało zapisu. Wynik `runTask` oraz `SubTask` niosą `outcome`; ślad `effects.checked` zawiera wyłącznie liczniki sprawdzeń. `requestStop(id, by)` zapisuje pierwszego nadawcę, a `stopAll` zapisuje `system`.

## Model delegacji

**Brak ról systemowych.** Plugin NIE wnosi żadnych wbudowanych subów. Są dwa sposoby delegacji:

1. **Generyczny worker** - `delegate(task:"...")` bez `aspect`. `DelegateTool.buildGenericWorkerConfig()` tworzy syntetyczny config `{ name: PKM_SUB_NAME /* 'pkm-sub' */, tools: DEFAULT_SUB_AGENT_TOOLS }` (bez `config.prompt`, bez roli). Działa **nawet gdy agent nie ma żadnych subów**. Model = slot sub-agentów.
2. **Custom sub usera** - `delegate(task:"...", aspect:"<nazwa>")`. Rozpoznawany po nazwie (exact → fuzzy po nazwie; **brak fallbacku po roli**). Widoczny tylko dla swojego agenta (prefiks `<agent-slug>-`).

Stary YAML agenta z przypisaniem nieistniejącej roli systemowej (np. dawne `prep-memory`) sprawia, że `delegate` zwraca czysty błąd „konfiguracja sub-agenta X nie znaleziona" - te nazwy nie istnieją jako suby. Nowy agent (od wersji po 2.2.6) startuje bez żadnych subów - zero auto-tworzenia na dysku. Suby `<slug>-prep`, które istnieją u userów z wcześniejszych wersji, to pozostałość po wyciętym automacie i działają dalej jak każdy custom sub - nikt ich nie kasuje ani nie migruje.

**Jednolite defaulty (rola nie steruje wyborem narzędzi/promptu/limitów):** `DEFAULT_SUB_AGENT_TOOLS = search/list/read/web_search/web_read` (`connect_to_server` wyłączony), `max_iterations` = worker (`subagent_max_iterations_worker` w `config/limits.ts`, **default 25**, sufit 100; zob. gotcha „Limity iteracji/timeout/długości" niżej), `min_iterations` = 1, `max_tool_result_length` = 15000, cap kontekstu delegata = **`delegation_context_max_chars`, default 48000**. **Precedencja config-vs-default:** `sanitizeLimit` przyjmuje poprawne pole z YAML custom suba w granicach `LIMIT_SPECS`; 0 iteracji i brak pola spadają na default z `config/limits.ts`, a 0 długości wyniku oznacza brak limitu. `config.tools` wygrywa nad `DEFAULT_SUB_AGENT_TOOLS`, a przecięcie z uprawnieniami rodzica robi `SubAgentRunner._getTools` DOPIERO PO tym wyborze.

**Lista narzędzi i dysk:** brak `tools` w YAML suba oznacza pięć domyślnych nazw, `tools: []` oznacza brak narzędzi, a lista określa wybrane nazwy. Dawne aliasy suba są migrowane i deduplikowane. Zapis zachowuje to rozróżnienie, a cache zawiera konkretną tablicę zgodną z ponownym odczytem, także przed dodaniem `extra_tools`. Szablon zachowuje swój dotychczasowy odczyt: brak pola i pusta lista dają w jego cache `[]`, lista zachowuje nazwy. Przy odlewie pusty szablon pomija pole, więc sub dostaje defaulty; niepusta lista przechodzi do suba.

**Thin prompt (`_buildTaskPrompt`) - „piecz metodę, pulluj dane":** nagłówek + `config.description` + `config.prompt` (miękki cap **`subagent_prompt_max_chars`, default 24000**) + jedna linia wskazówki pull do pamięci (`scope=memory`) + SCOPE (jeśli custom sub go ma) + BUDŻET + jedna wspólna lista ZASAD. Brak zbiorczego wstrzykiwania pamięci na starcie (żadnego katalogu `brain/` ani listy lokalizacji w promptcie) - sub REALNIE czyta pamięć rodzica przez `read/search/list scope=memory` (`MCPClient` przekazuje `agentName` rodzica → `_invocationAgentName` → `readMemory` czyta pamięć wołającego agenta; bramka `permissions.memory` fail-closed, default true; blokada `.pkm-assistant/**` dotyczy tylko `scope=vault`). Dlatego zostaje linia pull, a nie martwe ścieżki plików.

`max_iterations` i `max_tool_result_length` z YAML są sanityzowane przez `sanitizeLimit` i sufity `LIMIT_SPECS`; 0 iteracji spada do defaultu, a 0 znaków pozostaje legalnym brakiem limitu. Jeden pomocnik wylicza efektywne limity dla pętli i ramy. Głębokość rozstrzyga jedna funkcja dla widoczności narzędzi i ramy: na limicie `delegate` oraz `agent_delegate` są ukryte, a rama każe wykonać zadanie samodzielnie. Bramka w `DelegateTool` nadal odrzuca próbę wywołania na limicie.

Dla wyniku innego niż `unconfirmed` runner tworzy `handoff` w kolejności: efekty ze stanem sprawdzenia, ostatnia wypowiedź suba, wyniki narzędzi od najnowszego. Przed przycięciem podglądu i całego tekstu runner maskuje klucze z ustawień oraz stosuje `maskSensitiveData` także do argumentów i treści handoff. Limit całości to `subagent_salvage_max_chars`. Runner zachowuje argumenty wykonanych wywołań na wypadek błędu syntezy, ponieważ migawka `partial` ich nie zawiera. Handoff trafia do `SubRunResult` i `SubTaskResult`, także w ścieżce błędu.

Przy terminalnym pytaniu handoff zaczyna się od zamaskowanego pytania, które może zająć do połowy jego limitu. Snapshot przechowuje skrót pytania do 2000 znaków i uwzględnia jego rozmiar przy formatowaniu tekstu w łącznym limicie 12000 znaków wyświetlanych pól; nazwy i stany narzędzi mają pierwszeństwo przed ostatnią wypowiedzią i podglądami. Osobne `question` wyniku zachowuje pełną zamaskowaną treść.

### Custom YAML scope schema

Custom sub-agenty mogą definiować `scope` w `SUB_AGENT.yaml`:

```yaml
scope:
  folders: ["Projekty/X/"]
  frontmatter: { project: "X" }
  sections: ["## Drafty"]
  pinned_notes: ["Strategia X.md"]
```

Wszystkie pola opcjonalne. Domyślny `max_tool_result_length: 15000` jeśli nie podany. Walidacja **permissive** (forward-compatible - nieznane pola nie są odrzucane).

### Hyperfocused per-akcja (kierunek dalszy)

Baza jest gotowa: user buduje N hyperfocused per agent. Convention: `<role>-<context>-<action>` (np. `prep-x-post-finder`, `strateg-li-brief-creator`). Klikalne w chacie identycznie jak skille (slim bar + popup `/` + sidebar tab Triggery; `@` to wylacznie MentionAutocomplete z notatkami).

### Model suba

Rama suba czyta budżety z `config/limits.js`, nie hardcody - `_buildTaskPrompt` bierze cap instrukcji custom suba (`config.prompt` z `KNOWLEDGE.md`) z `subagent_prompt_max_chars`. Nota o obcięciu podaje realną liczbę. Limity są czytane RAZ na budowę promptu i ten sam obiekt karmi cap ORAZ blok BUDŻET, więc prompt nie może obiecać modelowi innej liczby iteracji niż ta, którą dostanie pętla (pilnuje tego test).

**Drabinka modelu suba.** Decyduje JEDNO pole - `config.role`:

- `role: 'worker'` → `createModelForRole(plugin, 'sub_worker', …)` = **model rodzica** (ta sama drabinka co main: `agent.models` → `agent.model` → biblioteka → legacy), zawsze świeża instancja. Dotyczy wbudowanego `aspect:"worker"` **i** custom suba, który ma `role: worker` w `SUB_AGENT.yaml`.
- wszystko inne (brak roli, `researcher`, `explorer`, dowolna etykieta) → dotychczasowy slot sub-agentów. Zero zmian dla `pkm-sub`, szablonów i istniejących YAML-i.
- `config.model` z YAML wygrywa w OBU przypadkach - rozstrzyga to `createModelForRole`.

⚠️ **Rola przestała być czysto opisową etykietą.** Jedna jej wartość - `worker` - steruje wyborem modelu. Reszta pól (narzędzia, prompt, limity) nadal nie zależy od roli. Kto pisze migrację ról, musi o tym wiedzieć.

Same wbudowane aspekty (`pkm-explorer` / `pkm-worker`) żyją w `modules/tools/DelegateTool.ts` - nie mają plików na dysku, nie przechodzą przez `SubAgentLoader` i nie są nazwami z tego modułu. Szczegóły: `modules/tools/CLAUDE.md`.

---

## Szablony sub-agentów

Magazyn: `SubAgentTemplateStore.js` (`.pkm-assistant/templates/sub-agents/<slug>/SUB_AGENT.yaml` + opcjonalny `KNOWLEDGE.md` + `version: N`). API jak w skillach. Owner = `AgentManager.subAgentTemplateStore`.

- **`PKM_SUB_NAME = 'pkm-sub'`** (`SubAgentLoader.js`, eksport w barrelu). Syntetyczny worker `delegate` BEZ `aspect` nazywa się `pkm-sub`. Byt istnieje tylko w kodzie (nie na dysku), więc jest niezniszczalny bez żadnego mechanizmu ochrony. Syntetycznego suba identyfikuje się po nazwie `PKM_SUB_NAME`, nie przez porównanie z rolą `worker`; porównanie `role === 'worker'` jest poprawne przy wyborze listy modeli w edytorze.
- **Kopia, nie link:** `instantiate(slug, agentName, {subAgentLoader})` odlewa kopię pod nazwą `<agent-slug>-<slug szablonu>` (konwencja widoczności `getVisibleSubAgentsForAgent`), kolizja → sufiks `-2`. Kopia niesie `from_template: "<nazwa> vN"`; osobne pole `version` nie wchodzi do żywego YAML-a. `SubAgentLoader` czyta i zapisuje `from_template` (pole przelotowe).
- **Edycja szablonu:** zmienia wyświetlaną `name` w YAML i cache, a slug oraz folder pozostają stałe. Komunikat sukcesu używa nazwy zwróconej przez zapis.
- **Formularz:** dla roli `worker` lista modeli pochodzi ze slotu `sub_worker`; pozostałe role używają slotu `researcher`. Zmiana roli aktualizuje listę. Przy otwarciu zachowany jest model spoza obecnej biblioteki, aby sama edycja opisu go nie usuwała. `max_iterations` przyjmuje tylko liczbę całkowitą w widełkach `LIMIT_SPECS.subagent_max_iterations_worker` (dziś 1..100); widełki pola, walidacja i komunikat biorą je z jednego miejsca (`editorDecisions.maxIterationsBounds`), a błąd pokazuje się przy polu i blokuje zapis. Domyślne narzędzia nowego suba w edytorze (`EDITOR_DEFAULT_TOOLS`: `search`, `read`, `list`) to co innego niż `DEFAULT_SUB_AGENT_TOOLS` workera `delegate`; decyzja o rozwinięciu „Zaawansowanych” porównuje z tą pierwszą listą i z `DEFAULT_LIMITS`. Narzędzia, zakres, limity i przełącznik aktywności są w sekcji „Zaawansowane”; sekcja otwiera się dla istniejących niestandardowych wartości, w tym wyłączonego szablonu. Foldery są twardą granicą, natomiast frontmatter, sekcje i przypięte notatki są tylko wskazówkami i nie blokują dostępu. Odznaczenie w edytorze wszystkich narzędzi zapisuje jawne `tools: []`, czyli sub bez narzędzi, tak samo przed i po ponownym odczycie z dysku; edycja istniejącego suba zachowuje jego listę.
- **Kasowanie szablonu:** potwierdzenie mówi, że odlane kopie pozostają i działają dalej. Nazwy rozpoznaje po pełnym zapisie `from_template` jako `<nazwa> vN`, dzięki czemu szablon `Raport` nie przejmuje kopii szablonu `Raport v2`. Po zmianie nazwy starsze kopie mogą być nierozpoznawalne. Potwierdzenie subów używa własnego klucza i18n, aby wspólny tekst skilli nie dostał placeholdera `copies`.
- **Globalny sub:** `settings.pkmAssistant.globalSubTemplate` (slug szablonu albo `null`). To konfiguracja, której `DelegateTool` używa dla delegacji BEZ `aspect`, **dla wszystkich agentów**. `null` = fabryczny `pkm-sub` (zawsze dostępny jako odwrót). Wybór klika się na kartach zakładki „Szablony subów"; zawsze dokładnie jeden globalny. **Fail-soft:** brakujący / niekompletny / nieparsowalny szablon → `pkm-sub` + `log.warn`, delegacja nigdy nie pada przez złą decyzję usera.
- **Przecięcie narzędzi rodzic∩sub (`SubAgentRunner._getTools`) NIETKNIĘTE** - granica bezpieczeństwa zostaje bez zmian, także dla workera z szablonu.
- **Rama suba wspólna dla wszystkich:** `resolveWorkPrompt(agent, 'subagent_frame_prompt', …)`, łańcuch agent > global > factory. Szablon NIE ma własnego pola ramy - rama edytowalna wyłącznie w Ustawieniach → Prompt.
- **UI:** `SubAgentsBackstageTab` pokazuje kartę `pkm-sub` (read-only) + karty szablonów; `SubAgentEditorModal` ma tryb `{template:true}` i checkbox `{alsoTemplate:true}`; `SubAgentDetailView` obsługuje `params.template` i pokazuje ślad `from_template`.

### Szablon fabryczny `researcher`

`ensureFactoryTemplates()` (`modules/agents/factoryTemplates.js`, seed RAZ przez marker `.factory-seeded-v1`) dokłada do magazynu szablonów fabrycznego **`researcher`**: `tools: [search, list, read, web_search, web_read]`, `max_iterations: 12` (deep research potrzebuje więcej niż default workera), `max_tool_result_length: 15000`, KNOWLEDGE z ostrym promptem jakości (dosłowne cytaty + URL/wikilink przy każdym; format odpowiedzi USTALENIA/LUKI/ŹRÓDŁA; „lepiej nie znalazłem niż zmyślona pewność"). Treść w i18n (`factory.template.researcher.*`).

Odlew per agent = `<agent-slug>-researcher` (standardowe `instantiate`). Przepisy skilli deep-research delegują `aspect:"researcher"` - fuzzy match (`endsWith('-researcher')`) trafia odlew; brak odlewu → przepis każe powtórzyć bez `aspect` (jedzie `pkm-sub`). Kasacja szablonu przez usera SZANOWANA (nie wraca po restarcie). Jeden szablon obsługuje OBA tryby researchu (web+vault) - skrzynka pełna, przecięcie rodzic∩sub i tak tnie (agent bez web = sub bez web_search).

---

## Zależności

**Importuje z:**
- `core/utils/yamlParser` (parseYaml, stringifyYaml)
- `core/utils/slugify`
- `core/utils/Logger`
- `core/i18n/index.js` (`t`)
- `modules/agent-loop/index.js` (`runAgentLoop`, `ArrayMessageStore` - wspólna pętla tool-callingu z czatem)

**Importowany przez:**
- `modules/agents/AgentManager.js` - `SubAgentLoader` (centralny manager agentów, instancjuje per plugin)
- `modules/tools/DelegateTool.js` - `SubAgentRunner` tworzony dla delegacji.
- `modules/agents/profile/profile_team.js` - „od zera" bierze `loadSubAgentEditorModal()`
  z barrela (leniwy `import()` w handlerze kliknięcia). Sam `SubAgentEditorModal.js` mieszka
  TUTAJ, nie w `modules/shell/` - wewnątrz modułu wołany wprost, na zewnątrz przez leniwy
  akcesor, bo statycznie importuje `obsidian`, a barrel subów musi zostać obsidian-free
  (`DelegateTool`/`TriggerPopup` mają testy w AVA).
- `modules/shell/sidebar/{BackstageViews,DetailViews,HomeView}.js` - listing + counter (DI)
- `modules/agents/profile/{profile_prompt,profile_team}.js` - profil agenta (DI)

---

## Gotchas

- ⚠️ **Zasada zamrożenia stanu tury: bieg suba NIE CZYTA globalnych luster pluginu.**
  Delegacja z głównego czatu jest zawsze w tle, więc bieg z definicji przeżywa turę i dożywa
  chwili, w której user przełączył zakładkę. `agentManager.activeAgent`, `getActiveMemory()` i
  `plugin.currentAutonomy` opisują wtedy KOGOŚ INNEGO. Dlatego:
  - **pamięć** → `getAgentMemory(agentName)` po WŁAŚCICIELU biegu (argument `runTask`, ten sam,
    który ląduje w `SubTask.agentName`). Brak instancji dla nazwanej tożsamości = **odmowa
    zapisu**, nigdy zjazd na `getActiveMemory()`;
  - **tryb autonomii** → `RunOptions.autonomy`, zamrożony przy zleceniu dokładnie jak
    `scopeFolders`. Wartość jedzie: tura → `MCPClient` (`_invocationAutonomy`, zaufany
    znacznik, zawsze nadpisywany) → `DelegateTool` → `runTask` → `_executeTool`.
    `plugin.currentAutonomy` został **wyłącznie jako fallback** dla starych wołaczy.
  Dokładasz nową rzecz, której bieg potrzebuje (model, ścieżka sesji, uprawnienie)? **Przekaż ją
  w opcjach zlecenia**, nie sięgaj po nią z pluginu w trakcie biegu.
- ⚠️ **Komunikat błędu suba wychodzi z runnera JUŻ ZAMASKOWANY.** Maskowanie siedzi w
  `_extractSafeErrorMessage` - jednym miejscu, przez które przechodzą WSZYSCY trzej odbiorcy:
  rejestr biegów, plik aktywnej sesji w vaultcie i wynik oddany narzędziu `delegate` (czyli
  kontekst modelu rodzica). Zdarzenie strumienia bez `data` bez tej maski potrafi ujawnić
  komunikat będący całym `JSON.stringify(event)` razem z nagłówkiem `Authorization`. Dokładasz
  nową drogę wyjścia błędu? Bierz string z tej funkcji, nie z surowego `error`.
- ⚠️ **Padnięte narzędzie suba jest ZNACZONE, choć egzekutor nadal nie rzuca.** `_executeTool`
  mierzy wynik funkcją `toolResultStatus` (`core/index.js`, ta sama reguła co status chipa w
  czacie): porażka wraca do transkryptu suba linią `subagent.tool_error` (po polsku „Błąd
  narzędzia …", z pełnym payloadem, przez maskę wyżej) i zapala hak `onFailure`. `runTask`
  opakowuje `trace` pętli i tym hakiem stawia `status:'error'` na kroku `tool.post` (parowanie po
  KOLEJNOŚCI wywołań - jeden `tool.post` na wywołanie, bez dubli i bez zawyżania licznika), więc
  gałąź błędu w `subTaskPanelModel.detailFromPost` nie jest martwa. **Kontrakt „egzekutor NIE
  rzuca" zostaje** - sygnał idzie obok tekstu, nie zamiast niego.
- ⚠️ **Etykieta trace suba: `sub/<nazwa|rola|sub>#<znacznik 8 hex>-<licznik>`.** Licznik wywołań w
  procesie (base36), bo `delegate` z listą `tasks` odpala N workerów RÓWNOLEGLE - bez niego
  wszystkie pisałyby pod wspólną etykietą i przebiegów nie dałoby się rozdzielić. Konwencja jak
  w pętli głównej (`chat/<agent>#<id sesji>`); czas by nie wystarczył, bo równoległe suby startują
  w tej samej sekundzie. **Dopasowanie etykiety musi być PREFIKSOWE** (`<label>#`, nie goły
  `startsWith(label)`) - `sub/pkm-sub` nie może łapać `sub/pkm-sub-extra` (pokryte testem w
  `SubAgentRunner.test.ts`).
- ⚠️ **Źródłem śladu suba jest REJESTR, nie plik.** `SubAgentRunner.runTask` zakłada bieg
  w `plugin.subTaskRegistry` (`create`) pod TĄ SAMĄ etykietą co w trace (`id` taska = etykieta),
  a pętli podaje funkcję-tee `registry.traceFor(task)`. **trace.log jest PIERWSZYM KONSUMENTEM**
  zdarzenia `task:step` (subskrypcja żyje w konstruktorze `SubTaskRegistry`, gdy dostanie
  `traceLog`) - pisze przez `traceLog.scope(task.id)`, więc **format linii nie zmienia się o
  bajt**. Panel podglądu (pasek biegów w oknie czatu) jest DRUGIM konsumentem, bez dotykania
  runnera.
  - **Fallback bez rejestru** (`plugin.subTaskRegistry` puste - testy jednostkowe, stary bootstrap):
    runner woła `traceLog.scope(label)` wprost.
  - **Księgowość nigdy nie zmienia wyniku suba.** Rejestr jest fail-soft w środku (każda metoda
    w try/catch, `EventEmitter.emit` łyka wyjątki handlerów), a runner dodatkowo owija wołania
    w `_safeRegistry`. Wywalony rejestr = brak wpisu, nie wywalony sub.
  - **Maskowanie NA WEJŚCIU:** `step()` przepuszcza stringowe wartości pól przez wstrzykniętą
    maskę (`maskSensitiveData` w produkcji), więc każdy konsument dostaje dane już bezpieczne.
    `fail()` maskuje też treść błędu (API lubi zwrócić w niej klucz).
  - **Konkret `tool.pre` pochodzi z `fields.detail`.** Pętla wybiera dozwolone pole, pomija
    wartości `data:`, maskuje i tnie do 80 znaków przed emisją. Panel nie czyta surowych `args`.
  - **Sufity pamięci:** `maxStepsPerTask` 500 (kroki ponad limit NIE lądują w tablicy, ale
    zdarzenie leci dalej → plik ma pełny ślad) i `maxDone` 50 (najstarsze ZAKOŃCZONE biegi
    wypadają z mapy; biegi `running` nie są usuwane nigdy). `dispose()` na `onunload`.
- ⚠️ **Byt w rejestrze powstaje PRZED budową promptu, nie po niej.** `runTask` liczy etykietę i
  woła `registry.create` na samym początku `try`, zanim padnie pierwszy `await` - bo delegacja
  w tle musi oddać modelowi `task_id` biegu, który dopiero rusza. Skutek uboczny (pożądany):
  wyjątek z `_buildTaskPrompt` domyka byt przez `fail`, a nie znika bez śladu.
  - **Dostawcą wyników z kolejki notifiera jest `ChatView`** (`modules/chat`): wpina się przez
    `setDeliverer` w `onOpen` PO odtworzeniu sesji (dopiero wtedy stoją zakładki, do których
    dopasowuje się `origin`) i odpina w `onClose`. **Polityka aktywnej zakładki:** czat konsumuje
    wynik (`true`) wyłącznie wtedy, gdy zakładka adresata jest AKTYWNA i bezczynna - wtedy odpala
    nią auto-turę z powiadomieniem. Zakładka w tle albo trwająca tura = `false`, czyli wynik
    zostaje w kolejce i wraca przy najbliższym `drain()` (koniec tury / przełączenie zakładki /
    otwarcie czatu). Auto-tura na zakładce, której user nie widzi, jest świadomie zakazana.
    ⚠️ Notifier trzyma JEDNEGO dostawcę, a jego kolejka żyje w RAM - restart Obsidiana gubi
    niedostarczone wyniki (i tak nie ma czego wznawiać, biegi subów też giną).
    **Po Stopie czat nie odpala automatycznie zaległych wyników.** Notifier woła dostawcę WPROST
    z `_onFinished` (`task:finished`), z pominięciem `set_generating` - a bezpiecznik czatu „po
    Stopie nie sięgamy sami po zaległe wyniki" (`_drainSuppressed`) musi więc siedzieć w jednym
    wspólnym wąskim gardle: `_deliverSubTaskResult`. Inaczej sub kończący bieg tuż po Stopie
    startowałby auto-turę z własnym raportem. Po stronie notifiera nic się nie zmienia - `false`
    znaczy „zostaw w kolejce".
  - Pola `options` runnera: `origin` i `background` (lecą **1:1** do `registry.create`, runner ich
    nie interpretuje) oraz `onTaskCreated(task)` - hak wołany ZARAZ po `create`, pod tym samym
    `_safeRegistry` co reszta księgowości. **Bez rejestru hak nie jest wołany** (fallback bez
    zmian), a wyjątek z haka nie może wywrócić suba.
- ⚠️ **„Stop" z panelu to PROŚBA, nie egzekucja.** Rejestr nie wie, jak się ubija suba - trzyma
  cudzą funkcję. Uchwyt wpina `DelegateTool` w haku `onTaskCreated` (jedyne miejsce, gdzie
  istnieje naraz `task.id` i domknięta kontrolka abortu tego zadania), a ubija dokładnie tą samą
  drogą co timeout delegacji: `abortCtl.aborted = true` (pętla staje między iteracjami) +
  `abortCtl.stop()` (`stop_stream` modelu). Dotyczy WSZYSTKICH trzech ścieżek delegacji -
  multi-task, single w tle i single BLOKUJĄCY (tam hak istnieje wyłącznie po to).
  - `requestStop(id, by = 'user')` zwraca `true` tylko gdy bieg istnieje, ma status `running` i ma podpięty
    uchwyt. Ustawia znacznik `stopRequested` na karcie (panel rysuje „zatrzymywanie…") i zapisuje
    krok `stop.requested {by}` - nowy TYP zdarzenia w trace.log. `by` to nadawca (`user` z paska
    i domyślnie, `lead` z narzędzia prowadzącego, `system` z zamknięcia i demontażu); pierwszy
    zapisany nadawca wygrywa i trafia do `outcome.end.by` zatrzymanego biegu.
  - **Status zmienia się dopiero, gdy pętla naprawdę stanie** i domknie byt przez `finish`/`fail`
    (zwykle `aborted`). `stopRequested === true` przy `status === 'running'` to normalny stan
    przejściowy, nie awaria.
  - Uchwyt jest kasowany przy `task:finished` (subskrypcja BEZWARUNKOWA, w odróżnieniu od
    konsumenta trace), przy retencji i w `dispose()` - inaczej byłby wyciek domknięć.
- ⚠️ **Demontaż NAJPIERW zatrzymuje, POTEM odpina.** `dispose()` NICZEGO NIE ZATRZYMUJE - puszcza
  uchwyty, nie woła ich (i zostaje best-effort + idempotentny). Od zatrzymania jest
  `stopAll(reason)`: woła KAŻDY uchwyt (osobny try/catch, uchwyt który rzucił nie blokuje reszty),
  znaczy karty `stopRequested` i nadawcę `system` oraz zapisuje `stop.requested {by:'system', reason}`. `onunload` woła
  `stopAll('unload')` PRZED `subTaskNotifier.dispose()` / `dispose()` / `closeAll()` MCP -
  odwrotna kolejność zrywałaby kanały raportowania, ale zostawiałaby bieg mielący na vaultcie.
- ⚠️ **UI wysyłania wiadomości do biegnącego suba nie istnieje.** Komunikacja z biegnącym subem
  należy do AGENTA, nie do usera - user może bieg wyłącznie PRZERWAĆ (Stop). **Sam kanał ZOSTAJE
  i jest świadomie utrzymywany, nie jest martwym kodem:** `registry.postMessage` / `takeMessages`
  + hook `beforeContinue` w `SubAgentRunner` obsługują wiadomości agenta: `sub_agent message`
  sprawdza właściciela i fazę wątku, po czym wywołuje `postMessage` dla bieżącego biegu.
- ⚠️ **Widok czyta rejestr, nie odwrotnie - i mieszka w CZACIE.** Biegi pokazuje pasek pod
  zakładkami czatu (`modules/chat/chat/subTaskStrip.ts`), bo należą do agenta i sesji, nie do
  globalnego sidebara. Pasek bierze `plugin.subTaskRegistry.list()` + `plugin.subTaskNotifier.pending()`
  i oddaje je czystemu `buildStripModel`. Wszystko, co da się policzyć źle po cichu (bieg z
  cudzej zakładki, duplikat wiersza, licznik z sufitu `maxStepsPerTask`), siedzi w modelu i ma
  testy AVA modelu oraz renderu w `modules/chat/chat/subTaskStrip.test.ts`; widok robi DOM. ⚠️ **`subTaskPanelModel.ts` NIE MOŻE
  zacząć importować `obsidian` ani i18n** - idzie do barrela zwykłym re-eksportem, a barrel modułu
  musi zostać obsidian-free (wiszą na nim testy AVA `DelegateTool`/`TriggerPopup` i sam moduł
  chat). Etykiety dobiera widok.
- `buildStripModel` grupuje biegi według `SubThread.runIds` i filtruje wątki po pełnym właścicielu: agent, ścieżka sesji i epoka. Biegnący bieg z wątku starej sesji pozostaje widoczny jako osobny wiersz. `StripRow.state` jest unią z `kind`; zawiera kolejkę z numerem miejsca, fazę wątku, `stopRequested`, outcome ostatniego biegu albo oczekiwanie notifiera. Częściowy wynik ostatniego biegu pozostaje oznaczony na chipie także po przejściu wątku do `idle`. Każdy bieg ma własny stan w osi, a zamknięty wątek zachowuje oś biegów.
- Samodzielny i osierocony bieg musi należeć do aktywnego agenta także wtedy, gdy jego `origin.sessionPath` pasuje do sesji. Wynik nadal oczekujący w notifierze uzupełnia dane biegu po retencji rejestru; ten sam bieg pozostaje jednym wierszem wątku. Liczniki tokenów biegu w toku czytają sumę zapisanych pól `in` i `out` z kroków `model.done`, gdy wynik biegu nie ma jeszcze `usage`.
- Limit `bieg N z M` pochodzi z `SubTaskRegistry.getThreadMaxRuns()`, który czyta zamrożony config albo domyślny limit rejestru. `postMessage` zachowuje w kroku `user.message` liczbę znaków i zmaskowany podgląd do 200 znaków.
- Szczegóły wiersza obejmują maksymalnie 20 ostatnich kroków, liczniki biegu liczone z pełnych zachowanych danych rejestru, efekty z wynikiem sprawdzenia oraz potwierdzone cele, które miały istnieć, lecz ich stan jest niezgodny z oczekiwaniem. Sprawdzenie efektu jest kojarzone z biegiem po narzędziu, akcji, stanie i celu; przy identycznych efektach w kilku biegach rejestr nie przechowuje osobnego identyfikatora sprawdzenia. Brak treści kroku lub treści odpowiedzi pośredniej nie jest uzupełniany przez model.
- Efekty w szczegółach pochodzą wyłącznie z `outcome` wybranego biegu. Zbiorcze `SubThread.effects` może uzupełnić stan sprawdzenia jego efektu, lecz bieg bez `outcome` pokazuje pustą listę efektów i brakujących celów, nawet gdy wątek pamięta dorobek wcześniejszego biegu.
- Przy częściowym końcu `StripRun.outcome` pokazuje najpierw `result.handoff`, potem `partial.text`, a dopiero dla biegu bez awarii `result.text`. Jeśli istnieje dorobek i błąd, `StripRun.endReason` niesie błąd osobno. Bez dorobku pozostaje sam komunikat błędu.
- Model przekazuje karcie biegu osobno klucze etykiet przyczyny końca i kompletności.
- ⚠️ **`runTask` mówi, JAK sub zszedł - i czy w ogóle dojechał.** Zwrotka niesie `stoppedBy`
  (`natural` = model domknął sam, `backstop` = skończyły się iteracje, `abort` = ubity z
  zewnątrz, `error` = wyjątek) oraz `failed: true` **wyłącznie** w gałęzi `catch`. Tekst błędu
  ZOSTAJE w polu `result` (kompatybilność), ale to `failed` decyduje, że `DelegateTool` odda
  modelowi `{success:false}` - patrz `modules/tools/CLAUDE.md`.
  - **`'error'` powstaje w runnerze, nie w pętli.** `runAgentLoop` przy wyjątku po prostu rzuca
    dalej i nie zna takiej wartości; runner ją nadaje w `catch`.
  - **Backstop nie jest wyjątkiem, ale nie jest też sukcesem.** Sub, któremu skończyły się
    iteracje, ma `stoppedBy:'backstop'` i `outcome.end.kind:'limit'`, więc `completeness` nigdy
    nie jest `unconfirmed`. `DelegateTool` oddaje wtedy `success:false` z `partial_result`
    (dorobek zachowany), a nie sukces (reguła 6.1, `modules/tools/CLAUDE.md`). Rozróżnienie
    „zaślepka czy dorobek" widać w `outcome.hasAnswer`/`hasMaterial` i w trace pętli
    (`loop.end … fallback=1`, patrz `modules/agent-loop/CLAUDE.md`).
- ⚠️ **`postMessage` to DORĘCZENIE PRZY NAJBLIŻSZEJ ITERACJI, nie przerwanie.**
  `registry.postMessage(id, tekst)` wrzuca polecenie do kolejki biegu; runner zdejmuje je hakiem
  `beforeContinue` (JEDYNY hook, jaki suby podpinają do pętli) i dopisuje do transkryptu jako
  wiadomość usera z ramką `subagent.steer_prefix`.
  - **Sub w środku długiego strumienia przeczyta ją dopiero po nim** - hak leci między
    wywołaniami modelu, a nie w trakcie. **Sub, który wszedł już w ostatnią iterację (backstop),
    może jej nie przeczytać wcale**: kolejka znika razem z biegiem (`task:finished`). Od twardego
    zatrzymania jest `requestStop`, nie wiadomość.
  - `postMessage` zwraca `true` tylko, gdy bieg istnieje, ma status `running`, tekst nie jest
    pusty i kolejka nie jest pełna. **Sufit (`maxMessagesPerTask`, default 10) ODMAWIA zamiast
    wypychać najstarszą** - cicha utrata polecenia sterującego byłaby gorsza od uczciwego „nie
    zmieściło się".
  - Ślad: `user.message {chars}` - nowy TYP zdarzenia w trace.log. Do logu idzie sama DŁUGOŚĆ;
    treść i tak siedzi w transkrypcie suba, a w kolejce jest już przepuszczona przez maskę
    (`maskSensitiveData`).
  - **Bez rejestru hak NIE jest podpinany.**
- ⚠️ **`options.onGateAdmitted` to PRZELOT, nie logika runnera.** Runner podaje go pętli 1:1
  (`RunAgentLoopOptions.onGateAdmitted`) i sam nie wie, po co komu ten sygnał - czyta go
  `DelegateTool`, żeby budżet CAŁEGO zadania (`delegation_timeout_ms`) liczył czas ROBOTY, a nie
  stania w kolejce bramki platformy lokalnej. Bez tej opcji nic się nie zmienia (jak
  `shouldAbort`). Szczegóły mechanizmu: `modules/tools/CLAUDE.md`.
- ⚠️ **Dziedziczenie autonomii: tryb pytań przychodzi ze ZLECENIA.** `SubAgentRunner._executeTool`
  woła `mcpClient.executeToolCall(toolCall, agentName, { autonomy: execOptions.autonomy ??
  this.plugin?.currentAutonomy })` - sub-agent PYTA (albo nie) tak jak tura, która go odpaliła.
  Czytanie wyłącznie plugin-globalnego zwierciadła zamiast przekazanej wartości sprawiłoby, że
  sub odpalony w trybie `all` dokańczałby bieg w `yolo`, gdyby user przeskoczył na inną zakładkę
  w trakcie. Zwierciadło zostaje fallbackiem dla wołaczy, którzy trybu nie przekazują. Autonomia
  nie nadaje uprawnień - sub-agent i tak jest ograniczony przecięciem whitelisty rodzic∩sub.
- ⚠️ **Budżet i Stop narzędzia są kontekstem runtime.** `runAgentLoop` przekazuje do callbacku
  `executeToolCall` drugi argument `ToolExecutionContext` `{resultBudgetChars, shouldAbort}`;
  cap jest wyliczony dla pierwotnej nazwy narzędzia. `_executeTool` przenosi oba pola do
  `MCPClient`, który przekazuje built-inom czwarty argument `BuiltinToolExecutionContext`.
  Ten zawiera `resultBudgetChars`, `effectiveResultBudgetChars` (sufit read/text 12000),
  `shouldAbort`, `authorizeFileRead(canonicalPath)` i `serializeFinalResult(result)`. Runtime
  nigdy nie bierze limitu ani tożsamości z argumentów modelu. Przy błędzie bounded read/text
  runner maskuje sekrety i zachowuje JSON oraz limit. Maska uszkadzająca znak ucieczki
  powoduje zwrot bezpiecznego kodu z opcjonalnym `restart_offset`; za mały budżet daje
  `budget_too_small` albo `B`. Zwykłe błędy nadal dostają `subagent.tool_error`.
  `read` sprawdza `authorizeFileRead` na każdej stronie przed I/O. Bez `MCPClient`
  bezpośredni fallback runnera nie ma pełnego kontekstu uprawnień i przekazuje
  callback odmawiający, więc odczyt vaulta kończy się `access_denied`.
- ⚠️ **`ChatModel.stream()` NIE concurrent-safe** - sub-agenci muszą skipować cache. Patrz
  `SubAgentRunner._executeTool` przez MCPClient + `modules/models/modelResolver.js` skipCache logic.
- ⚠️ **`max_tokens` musi być explicit** w `streamToCompleteWithTools` options - inaczej
  `to_openai()` nie wysyła do API → truncated odpowiedzi. Default w runnerze: `maxTokens: 16384`.
- ⚠️ **Limity iteracji/timeout/długości = `config/limits.js`, JEDEN moduł.**
  `subagent_max_iterations_worker: 25` (worker na sensownej robocie potrafi zjeść dużo iteracji,
  sufit 100), `delegation_timeout_ms: 900000` (sufit 30 min - zegar ścienny to awaryjny sufit,
  głównym strażnikiem jest **watchdog ciszy** `subagent_stall_timeout_ms: 180000` przekazywany
  pętli jako `stallTimeoutMs`; do tego `subagent_salvage_max_chars: 12000` → `salvageMaxChars` -
  skrót dorobku przy padzie syntezy, oraz `subagent_result_max_chars: 60000` - sufit FINALNEGO
  wyniku suba przy doręczeniu do maina, 0 = bez limitu), `max_tool_result_length: 15000` (surowe
  zrzuty narzędzi SUBA - wynik suba dla maina ma własny, większy sufit), `subagent_prompt_max_chars: 24000`,
  `delegation_context_max_chars: 48000`. `subagent_max_iterations_strategist` nie istnieje - nie
  ma roli strategist. `SubAgentRunner.runTask` czyta limity przez `getLimits(this.plugin?.env?.settings)` -
  per-sub-agent config (`config.max_iterations` itd.) nadal wygrywa; `getLimits` daje default gdy
  config nie ma pola. User może nadpisać przez Settings → Limity.
- ⚠️ **Walidacja w `DelegateTool`: pusty task → odmowa.** Patrz `DelegateTool.js:84,98`.
- ✅ **`modelRole = 'researcher' | 'strategist'` w `DelegateTool.js`** - `DelegateTool` nie
  tłumaczy roli na `minion/master`, a `modelResolver` mapuje nazwy do legacy slotów biblioteki
  modeli bez deprecation warning.
- ⚠️ **Rama suba = fabryka `framePrompt.js`, nie hardcode w runnerze.** Stały szkielet (nagłówek
  + „pull pamięć" + ZASADY) żyje w `framePrompt.js` z placeholderami; `_buildTaskPrompt`
  rozwiązuje go przez `resolveWorkPrompt(agent, 'subagent_frame_prompt', settings, factory)`
  (łańcuch agent>global>factory) i wstrzykuje mechaniczne sekcje (METHOD z `config.prompt`,
  SCOPE z `config.scope`, BUDŻET z limits). **User-editowalna** globalnie (Settings→Prompt)
  i per agent rodzic (nie przez template z `modules/prompts/`).
- ⚠️ **Rama suba idzie za JĘZYKIEM INTERFEJSU i liczy się RAZ NA BIEG.** Od 2.2.5 szkielet ma
  wersję PL i EN (`framePrompt.js`), a wołacz bierze go przez `defaultSubAgentFramePrompt()`.
  Stała `DEFAULT_SUBAGENT_FRAME_PROMPT` została SKASOWANA celowo: `setLocale()` leci z
  `src/main.ts` PO załadowaniu modułów, więc stała wybrałaby język przy imporcie i zamroziła go.
  Bloki składane w kodzie (METHOD/SCOPE/BUDGET + domyślny opis suba) idą przez klucze
  `subagent.frame.*` w i18n; `_buildTaskPrompt` skleja je przy każdym biegu, więc zmiana języka
  w sesji działa bez restartu.
  **ADRESY zostają identyczne w obu językach** (to nie proza): literal `scope="memory"`, nazwy
  narzędzi `search`/`read`/`list` i `delegate`/`agent_delegate`, nagłówek `SCOPE:`. `BUDŻET:` →
  `BUDGET:` SIĘ tłumaczy - nic go nie parsuje.
  **Nic w kodzie nie parsuje tej ramy ani odpowiedzi suba po tekście:** status biegu liczy
  `toolResultStatus` (flagi `isError`/`success`, `core/utils/toolResultStatus.ts`), a `stoppedBy`
  nadaje runner - żadnych markerów tekstowych. Dlatego tłumaczenie jest bezpieczne; scenariusze
  harnessu subów (40/41/43) też nie pinują treści ramy.
  Strażnicy: `SubAgentRunner.test.ts` - render EN bez ani jednego polskiego znaku, render PL,
  lista ADRESÓW obecna w obu, literalna lista placeholderów `[AGENT_NAME, BUDGET, DESCRIPTION,
  METHOD, SCOPE, SUB_NAME]` w obu i zero placeholderów w gotowym prompcie, override
  agent > global > fabryka w obu językach. Testy pinujące polskie napisy jadą pod
  `setLocale('pl')` i wracają do `'en'`.
- ⚠️ **`_getTools(toolNames, parentAgent, callerToolNames)` ma TRZY składniki przecięcia.** Na
  piętrze >1 `parentAgent` to nadal agent GŁÓWNY (sub chodzi pod jego tożsamością), więc
  `filterByAgent` sam nie chroni: read-only sub z `tools: [read, delegate]` mógłby wystawić
  wnukowi pełną listę narzędzi agenta przez `delegate {aspect:"worker"}`. Trzeci składnik to
  whitelista suba ZLECAJĄCEGO - `RunOptions.callerToolNames`, podawana przez `DelegateTool` ze
  znacznika `_invocationToolNames`.
  - **`_executeTool` przekazuje własną whitelistę suba dalej do `MCPClient`**
    (`callerToolNames: [...allowedToolNames]`) - to ona staje się znacznikiem dla delegacji
    piętro niżej. Lista jest już przecięciem rodzic∩sub, więc łańcuch może się tylko zwężać.
  - **`RunOptions.scopeFolders` przychodzi już PO przecięciu** z zakresem wołającego (liczy je
    `DelegateTool` przez `AccessGuard.intersectScopeFolders`). Runner go nie interpretuje na
    ścieżce z `MCPClient` - niesie 1:1 dalej, egzekwuje go `PermissionSystem.checkPermission` po
    drugiej stronie. Zakresy rozłączne kończą się odmową delegacji, więc runner nigdy nie dostaje
    pustej listy „na wszelki wypadek". **Wyjątek - ścieżka fallback BEZ `MCPClient`**
    (`_executeTool`, `SubAgentRunner.ts`): runner NIE umie wyegzekwować `scopeFolders` na tej
    ścieżce, bo woła `tool.execute()` wprost i omija `PermissionSystem` w całości. Zamiast
    fail-open (cicho rozszerzyć suba z „konkretne foldery" na „cały vault"), niepusty
    `scopeFolders` na tej ścieżce = odmowa wykonania KAŻDEGO narzędzia
    (`subagent.tool_scope_unenforceable`). Brak `scopeFolders` w `execOptions` przechodzi bez
    zmian.
- ⚠️ **Pusta instrukcja KASUJE `KNOWLEDGE.md`** (`SubAgentLoader.saveSubAgent` i
  `SubAgentTemplateStore._write`). Naiwne `if (data.prompt)` zostawiłoby starą treść na dysku:
  cache mówiłby „pusto", user dostawałby „zapisany", a `loadAllSubAgents()` po restarcie
  wstrzykiwałby subowi SKASOWANĄ metodę (a szablon niósłby metodę z poprzedniej wersji). Próg
  jest ten sam co przy odczycie - `prompt.trim()`, bo `_loadSubAgentFromFolder` i cache i tak
  trymują.
- ⚠️ **`deleteSubAgent`/`store.delete` mogą zwrócić `false` i TĘ wartość trzeba przeczytać.** Decyzja
  o komunikacie mieszka w czystym `deleteOutcome.ts` (`resolveDeleteOutcome`): tylko `true`
  znaczy „Usunięto", cokolwiek innego (w tym `undefined` z opcjonalnego łańcucha) to
  `modal.sub_agent.delete_failed` - modal zostaje otwarty, kafel Zaplecza nie znika. Dla żywego
  suba `deleteSubAgent` usuwa pusty folder, a dodatkowe pliki zachowuje i wymienia w ostrzeżeniu;
  w obu przypadkach usuwa wpis z cache i zwraca `true`. Błąd sprzątania pustego folderu daje
  `false`. `SubAgentTemplateStore.delete` ignoruje błędy sprzątania folderu: po usunięciu plików
  szablonu zwraca `true` i usuwa wpis z cache, a dodatkowe pliki pozostają na dysku.
  Gdy usunięcie któregoś pliku szablonu (`SUB_AGENT.yaml`, `KNOWLEDGE.md`) rzuci, zwraca `false`,
  a wpis zostaje w cache.
- ⚠️ **Handler kafla Zaplecza przechwytuje odrzuconą obietnicę.** `renderUseAtAgentButton`
  (`ui-components/backstage_helpers.ts`) porzuca obietnicę z `onPick(agent.name)`, więc handler
  owija operację przez `guardTemplateUse`. Czyste `useTemplateWithCompensation` wykonuje odlew i
  przypisanie; jeśli przypisanie rzuci, próbuje usunąć kopię pod dokładną nazwą zwróconą przez
  `instantiate`. Nieudane sprzątanie trafia osobno do `log.error`, a użytkownik dostaje klucz
  `backstage.template_use_failed`.
  ⚠️ Pas bezpieczeństwa w SAMYM `renderUseAtAgentButton` (`Promise.resolve(onPick(...)).catch(...)`)
  **nie jest dołożony** - to plik innego modułu, więc każdy nowy handler kafla musi sam się
  owinąć.
- ⚠️ **`subagent_error` ma TEN SAM kształt bloku co `subagent_call`.** Te same pola nagłówka
  (`role`/`prompt`/`result`/`duration_ms`), status niesie treść `result` - a jest nią to samo
  zdanie `subagent.error`, które dostaje agent zlecający (plik sesji i wołacz mówią jedno). Odczyt
  tego bloku zależy od mapowania typu w `roleFromEvent` (`modules/memory/activeSessionFormat.ts`) -
  bez wpisu tam parser POMIJA cały blok i padnięty bieg znika z odtworzonej sesji, z konsolidacji
  i (przez `archiveActiveSession`) z dysku. **Nowy typ zdarzenia biegu = wpis w `roleFromEvent`,
  inaczej zapis jest tylko iluzją.** Szczegóły: `modules/memory/CLAUDE.md` gotcha 11.
- ⚠️ **`asTranscript` w `_executeTool` tnie base64 z wyniku `generate_image` PRZED
  `JSON.stringify`.** `GenerateImageTool` zwraca w sukcesie pełny base64 zapisanego obrazu (obok
  `path`/`note_path` - obraz JEST już w vaulcie, base64 służy TYLKO ścieżce czatu z modelem
  vision). Bez cięcia transkrypt suba różni się tu od czatu (który obcina `copy.base64`) - realny
  obraz (rzędu setek tysięcy znaków base64) zjadałby niemal cały sufit `max_tool_result_length`
  transkryptu suba (domyślnie 15000 - `config/limits.ts`), wypychając
  `format`/`revised_prompt`/`message` poza limit, i byłby budowany od nowa (`JSON.stringify`) przy
  KAŻDEJ kolejnej iteracji pętli. Helper `stripImageBase64ForTranscript(toolName, result)`
  (top-level w `SubAgentRunner.ts`) działa WYŁĄCZNIE na `generate_image` z niepustym `base64`
  (inne narzędzia, błędy, `generate_image` bez base64 przechodzą bez zmian); zamiast base64
  dokłada jednolinijkową adnotację rozmiaru (`[image ~N kB - ...]`, wzór `normalizeMcpResult` w
  `modules/tools/ExternalMcpManager.ts`). Wpięty w JEDNYM miejscu (`asTranscript`), więc obejmuje
  OBIE ścieżki egzekucji (`MCPClient` i fallback bez klienta). **Dokładasz narzędzie, które
  zwraca duży binarny payload w wyniku (base64/podobne)?** Ten sam wzorzec - filtr po `toolName`
  w `asTranscript`, nie osobna kopia w `GenerateImageTool.ts` (jedno miejsce decyzji).

---

## Wątki sub-agentów

`SubTask` nadal opisuje pojedynczy bieg. `SubThread` z rejestru przechowuje właściciela
(`agentName`, `sessionPath`, `sessionEpoch`), konfigurację, rozmowę, efekty, listę biegów
i fazę `queued`, `running`, `idle` albo `closed`. Klucz właściciela musi być kompletny
i zgodny przy `beginRun`, który rezerwuje wątek synchronicznie. Wątki bez ścieżki lub epoki
sesji są jednorazowe. Wyjątek runnera, limit pięciu biegów, limit rozmowy 200000 znaków,
zamknięcie albo sprzątanie wyłącza ponowne użycie. Zamknięcie zwalnia rozmowę i zapis efektów.

Stop użytkownika zapisuje kolejność na biegu i wątku; `beginRun` atomowo wymaga odpowiednio
nowszej tury, a historyczny próg pozostaje po zdjęciu `userStop`.

Każdy kolejny bieg dostaje świeży prompt systemowy z konfiguracji pierwszego biegu,
zachowaną głęboką kopię rozmowy oraz wiadomość z ramką agenta zlecającego. Zestaw narzędzi,
zakres i limity pozostają zamrożone, także liczby zapisane w nowym prompcie systemowym.
Tożsamość modelu obejmuje `providerId` i `modelId`; zmiana platformy odmawia kontynuacji.
Wątek zachowuje do 100 najnowszych efektów ze wszystkich biegów i ponownie sprawdza ich cele
według zapisanego `ToolEffect.check` oraz tej samej ścieżki sprawdzania co po biegu.
Efekty z `check: none`, w tym ulotny `memory_save`, pozostają niesprawdzone bez I/O.
Potwierdzone usunięcie jest opisane jako usunięcie, a stan nieznany każe sprawdzić cel przed
powtórzeniem. Przed kontynuacją `countTokens` szacuje całą serializowaną wiadomość, w tym
`tool_calls` i `reasoning_content`. `modules/models/cache_utils.ts` zna limity odpowiedzi, ale
nie okna kontekstu modeli, więc limit zastępczy wynosi 128000 tokenów z marginesem 16384 tokenów
na odpowiedź.

Idle wątki są sprzątane przy `createThread` i `endRun`, bez timerów: po 30 minutach
bez aktywności oraz ponad trzy wątki w sesji, od najstarszego. Rejestr emituje
`thread:created`, `thread:idle` i `thread:closed`, które zapisują `thread.created`,
`thread.idle` i `thread.closed` do trace.
Retencja usuwa zamknięty wątek wraz z konfiguracją, gdy usunięto jego ostatni przechowywany bieg, także gdy zamknięcie nastąpiło po wyparciu tego biegu. Zamknięta rezerwacja kolejki czeka na `finishQueuedStop`. `pruneSession` usuwa też zamknięte wątki tej sesji.

Skrzynka `postMessage` dostarcza wiadomość w ramce od agenta zlecającego przez hak
`beforeContinue`, między wywołaniami modelu.

### Rezerwacja z kolejki

Zadanie z listy `tasks` dostaje `SubThread` w fazie `queued` przed wejściem do puli.
Runner dostaje `queuedThreadId` i przejmuje rezerwację przez synchroniczne
`beginQueuedRun(threadId, owner, frozenConfig)`. Przejście do `running` sprawdza
właściciela i fazę bez `await`; runner używa tego samego identyfikatora jako id biegu
i nie tworzy drugiego wątku. Konfiguracja pełna, w tym limity i model, jest kopiowana
przy starcie. `beginRun` pozostaje osobną operacją kontynuacji wątku `idle` i nadal
wymaga kompletnego klucza sesji oraz epoki.

`allocateSubTaskId(name)` z publicznego barrela przydziela identyfikatory w formacie
`sub/<nazwa>#<znacznik>-<licznik-base36>`. Wątek zamknięty przed startem nie wywołuje modelu.
`finishQueuedStop(threadId, { background, taskPreview })` dopisuje syntetyczny bieg do
`thread.runIds` przed emisją `task:created` i `task:finished`, z wynikiem stopped/empty,
więc pasek zachowuje oś wątku, a zwykły notifier dostarcza wynik.
Jeśli rezerwacja nie wystartuje z powodu błędu konfiguracji/modelu/runnera, `finishQueuedFailure`
zapisuje zamiast tego syntetyczny bieg error z zachowanym komunikatem błędu i również wiąże go
z `thread.runIds`; tylko jawne zatrzymanie i unload używają `finishQueuedStop`.
`closeThread(threadId)` domyślnie zapisuje `closedBy: 'user'`; jawne `by` zachowuje
pierwszego nadawcę zamknięcia queued. `closeSessionThreads` i `closeAll` używają
`system`. `closeQueuedForOwners({ tabKeys, agentNames }, by)` zamyka wyłącznie queued:
jeśli origin ma `tabKey`, dopasowuje tylko zakładkę; `agentName` jest fallbackiem
wyłącznie dla origin bez `tabKey`. Wątki idle zostają bez zmian.

Przy osiągniętej głębokości runner ukrywa `delegate`, `agent_delegate` i `sub_agent`
w definicjach narzędzi. Backendowa bramka delegacji nadal obowiązuje.

### Model wyniku współdzielony z czatem

Barrel eksportuje `getStripStateLabelParts` oraz `buildSubTaskResultModel` z
`subTaskPanelModel.ts`, a także typy modelu wyniku. Model wyniku dostaje
`SubTaskResultThread`: `{ kind: 'reusable'; sub_id: string }` dla wątku wielokrotnego
albo wariant bez `sub_id`. Czat używa `thread.kind` i `sub_id` do wspólnej etykiety
stanu, sekcji efektów i informacji o kontynuacji. Logika etykiet i sekcji pozostaje
w jednym czystym modelu, współdzielonym z paskiem.
Naturalny koniec `finished` o kompletności `empty` dostaje etykietę „pusty wynik”.

## TODO

Najważniejsze:
- 🟠 YAML schema custom sub-agentów - doprecyzować schemat zakresu: foldery wyznaczają twardą granicę dostępu; frontmatter, sekcje i przypięte notatki pozostają wskazówkami bez egzekwowania
- 🟠 Hyperfocused per-akcja + klikalność w chacie

---

## Powiązane

- `modules/agent-loop/CLAUDE.md` - stamtąd przychodzi `runAgentLoop` (wspólna pętla tool-callingu z czatem; `streamToCompleteWithTools` w `modules/memory` zostało usunięte tym samym zadaniem)


U3: `SubTask.partial` and `publishPartial` expose a copied, masked snapshot via `task:partial` without completing the task. Runner failure retains actual tools, details, usage and partial; partial and terminal journaling use captured origin memory/path. Storage failure is explicit on the task, while notifier delivery still starts only at the terminal event.

## Identyfikatory biegów i wątków

Identyfikator biegu i wątku ma postać `sub/<nazwa>#<znacznik>-<licznik>`: znacznik to 8 znaków szesnastkowych losowanych przy załadowaniu modułu, licznik rośnie w danym uruchomieniu. Osiem znaków wystarcza do rozróżnienia uruchomień, a krótkie ID ułatwia modelowi przepisanie `sub_id` do narzędzia. Dawny format bez znacznika nie jest generowany w nowym uruchomieniu i niezakończone pokwitowanie jest pokazywane jako przerwane przez restart.

## Stop z paska

`SubTaskRegistry.stopThread(threadId)` synchronicznie sprawdza bieżącą fazę wątku: zamyka rezerwację `queued` jako user albo wysyła `requestStop` jako user do aktualnego biegu `running`. Dla pozostałych faz zwraca `false`.
Stop użytkownika zapisuje znacznik kolejności na wątku i biegu przed przerwaniem pracy; dla rezerwacji znacznik przechodzi do jej syntetycznego biegu. Kontynuację przyjmuje atomowo `beginRun` według progu ostatniego Stopu, który pozostaje także po zdjęciu `userStop`.
