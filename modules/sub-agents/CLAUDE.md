# modules/sub-agents/

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
├── framePrompt.js              # DEFAULT_SUBAGENT_FRAME_PROMPT (fabryczny szkielet ramy suba, placeholdery)
├── BackstageTab.js             # register tab + lazy-load renderSubAgentsTab
├── SubAgentsBackstageTab.js    # render Sub-Agents tab w Backstage sidebar
├── SubAgentDetailView.js       # render single sub-agent detail view
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

**Publiczne drzwi modułu:** klasy runtime + helpery widoczności/migracji.

| Export | Po co |
|---|---|
| `SubAgentLoader` | Klasa - skanowanie `.pkm-assistant/sub-agents/`, parse YAML + KNOWLEDGE.md, cache, save/delete, ensureStarter, createPrepSubAgent |
| `SubAgentRunner` | Klasa - wykonanie sub-agent (`runTask()`), ujednolicony system prompt builder (`framePrompt.js`, NIE zależy od roli - patrz „Model delegacji" niżej), tool-calling loop przez `runAgentLoop` (`modules/agent-loop`, wspólna pętla z czatem) |
| `SubTaskRegistry` | Księga biegów subów + szyna zdarzeń (`task:created` / `task:step` / `task:finished`). Stawia go composition root (`plugin.subTaskRegistry`), konsumują trace.log i pasek biegów w czacie. Pure - zero `obsidian`, zero I/O. Dodatkowo skrzynka kontaktowa do biegu - `attachAbort(id, fn)` / `requestStop(id)`. Ta sama skrzynka przyjmuje WIADOMOŚCI - `postMessage(id, text)` / `takeMessages(id)`. |
| `SubRunResult`, `SubRunStoppedBy` (typy) | Kształt zwrotki `runTask` - `stoppedBy` (`natural`/`backstop`/`abort`/`error`) + `failed?: true`. Czyta je `DelegateTool`. |
| `buildStripModel`, `formatDuration` (+ typy `StripRow`/`StripStep`/`BuildStripModelInput`) | Czysta arytmetyka **paska biegów w oknie czatu**: filtr per zakładka, kolejność, liczniki, skróty. Konsumentem jest `modules/chat` (`chat/subTaskStrip.ts`), stąd eksport; plik zostaje pure, więc barrel dalej jest obsidian-free. |
| `SubTaskNotifier` | Skrzynka wyników subów odpalonych W TLE. Siedzi na `task:finished`, bierze WYŁĄCZNIE taski z `background === true`, trzyma je w kolejce (sufit 200, najstarsze wypadają) aż dostawca je skonsumuje. API: `setDeliverer(fn\|null)` (`true` = skonsumowane; `false`/wyjątek = zostaje), `drain()`, `pending()`, `pendingFor(agentName)`, `dispose()`. Stawia go composition root jako `plugin.subTaskNotifier`; dostawcę wstrzykuje czat. Pure - nigdy nie rzuca. **Dostawcą jest `ChatView`** - patrz gotcha niżej. |
| `SubTask`, `SubTaskStatus`, `SubTaskStep`, `SubTaskBudget`, `SubTaskResult`, `SubTaskOrigin`, `SubTaskDeliverer` (typy) | Kształt bytu biegu suba + adres zwrotny zlecenia + kontrakt dostawcy, dla konsumentów zdarzeń. |
| `getVisibleSubAgentsForAgent` | Filtr: **tylko** custom suby z prefiksem `<agent-slug>-` (brak ról systemowych; legacy standalone bez prefiksu ukryty) |
| `DEFAULT_SUB_AGENT_TOOLS` | Jednolity domyślny zestaw workera: `search/list/read/web_search/web_read` (`connect_to_server` wyłączony). Przecięcie z rodzicem robi `_getTools`. |
| `PKM_SUB_NAME` | Nazwa syntetycznego workera (`'pkm-sub'`) dla `delegate` bez `aspect`. |
| `SubAgentTemplateStore` | Magazyn szablonów subów (Zaplecze). Owner: `AgentManager.subAgentTemplateStore`. |
| `registerBackstage` / `renderSubAgentDetailView` | Rejestracja zakładki Zaplecza + widok detalu (lazy-load, barrel zostaje obsidian-free). |
| `DEFAULT_SUBAGENT_FRAME_PROMPT` | Fabryczny szkielet ramy suba (`framePrompt.js`, pure/obsidian-free). Wystawiony w Settings→Prompt, rozwiązywany łańcuchem agent>global>factory przez `resolveWorkPrompt`. |

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
- `createPrepSubAgent(agentName)` - factory `<agent>-prep` per agent
- `reloadSubAgents()` - hot reload (clear cache + re-load)

**`SubAgentRunner` ma TYLKO 1 metodę publiczną:**
- `runTask(taskPrompt, agent, config, model, options)` - wywoływana z `DelegateTool._executeSubAgent`

---

## Model delegacji

**Brak ról systemowych.** Plugin NIE wnosi żadnych wbudowanych subów. Są dwa sposoby delegacji:

1. **Generyczny worker** - `delegate(task:"...")` bez `aspect`. `DelegateTool.buildGenericWorkerConfig()` tworzy syntetyczny config `{ name:'worker', tools: DEFAULT_SUB_AGENT_TOOLS }` (bez `config.prompt`, bez roli). Działa **nawet gdy agent nie ma żadnych subów**. Model = slot sub-agentów.
2. **Custom sub usera** - `delegate(task:"...", aspect:"<nazwa>")`. Rozpoznawany po nazwie (exact → fuzzy po nazwie; **brak fallbacku po roli**). Widoczny tylko dla swojego agenta (prefiks `<agent-slug>-`).

Stary YAML agenta z przypisaniem nieistniejącej roli systemowej (np. dawne `prep-memory`) sprawia, że `delegate` zwraca czysty błąd „konfiguracja sub-agenta X nie znaleziona" - te nazwy nie istnieją jako suby. Nowy agent dostaje własny `<slug>-prep` (`createPrepSubAgent`), nie role systemowe.

**Jednolite defaulty (rola nie steruje wyborem narzędzi/promptu/limitów):** `DEFAULT_SUB_AGENT_TOOLS = search/list/read/web_search/web_read` (`connect_to_server` wyłączony), `max_iterations` = worker (`subagent_max_iterations_worker` w `config/limits.ts`, **default 25**, sufit 100; zob. gotcha „Limity iteracji/timeout/długości" niżej), `min_iterations` = 1, `max_tool_result_length` = 15000, cap kontekstu delegata = **`delegation_context_max_chars`, default 48000**. **Precedencja config-vs-default:** `config.max_iterations || limits.subagent_max_iterations_worker` - pole z YAML custom suba wygrywa, gdy jest ustawione na wartość prawdziwą (0/brak/undefined spadają na default z `config/limits.ts`); ta sama zasada dotyczy `config.tools` (wygrywa nad `DEFAULT_SUB_AGENT_TOOLS`), a przecięcie z uprawnieniami rodzica robi `SubAgentRunner._getTools` DOPIERO PO tym wyborze.

**Thin prompt (`_buildTaskPrompt`) - „piecz metodę, pulluj dane":** nagłówek + `config.description` + `config.prompt` (miękki cap **`subagent_prompt_max_chars`, default 24000**) + jedna linia wskazówki pull do pamięci (`scope=memory`) + SCOPE (jeśli custom sub go ma) + BUDŻET + jedna wspólna lista ZASAD. Brak zbiorczego wstrzykiwania pamięci na starcie (żadnego katalogu `brain/` ani listy lokalizacji w promptcie) - sub REALNIE czyta pamięć rodzica przez `read/search/list scope=memory` (`MCPClient` przekazuje `agentName` rodzica → `_invocationAgentName` → `readMemory` czyta pamięć wołającego agenta; bramka `permissions.memory` fail-closed, default true; blokada `.pkm-assistant/**` dotyczy tylko `scope=vault`). Dlatego zostaje linia pull, a nie martwe ścieżki plików.

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

Baza jest gotowa: user buduje N hyperfocused per agent. Convention: `<role>-<context>-<action>` (np. `prep-x-post-finder`, `strateg-li-brief-creator`). Klikalne w chacie identycznie jak skille (slim bar + popup `/@` + sidebar tab Triggery).

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

- **`PKM_SUB_NAME = 'pkm-sub'`** (`SubAgentLoader.js`, eksport w barrelu). Syntetyczny worker `delegate` BEZ `aspect` nazywa się `pkm-sub`. Byt istnieje tylko w kodzie (nie na dysku), więc jest niezniszczalny bez żadnego mechanizmu ochrony. Zero twardych porównań `=== 'worker'` w produkcji (tylko asercje testów).
- **Kopia, nie link:** `instantiate(slug, agentName, {subAgentLoader})` odlewa kopię pod nazwą `<agent-slug>-<slug szablonu>` (konwencja widoczności `getVisibleSubAgentsForAgent`), kolizja → sufiks `-2`. Kopia niesie `from_template: "<nazwa> vN"`; wersja szablonu NIE wchodzi do żywego YAML-a. `SubAgentLoader` czyta i zapisuje `from_template` (pole przelotowe).
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
- `modules/tools/DelegateTool.js` - `SubAgentRunner` (jedyny tool który wywołuje sub-agentów, lazy-init singleton)
- `modules/agents/profile/profile_team.js` - „od zera" bierze `loadSubAgentEditorModal()`
  z barrela (leniwy `import()` w handlerze kliknięcia). Sam `SubAgentEditorModal.js` mieszka
  TUTAJ, nie w `modules/shell/` - wewnątrz modułu wołany wprost, na zewnątrz przez leniwy
  akcesor, bo statycznie importuje `obsidian`, a barrel subów musi zostać obsidian-free
  (`DelegateTool`/`TriggerPopup` mają testy w AVA).
- `modules/shell/sidebar/{BackstageViews,DetailViews,HomeView}.js` - listing + counter (DI)
- `modules/agents/profile/{profile_prompt,profile_team}.js` - profil agenta (DI)
- `modules/onboarding/PlaybookManager.js` - `generateDelegowanieSection`

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
- ⚠️ **Etykieta trace suba: `sub/<nazwa|rola|sub>#<nr wywołania>`.** Numer to licznik wywołań w
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
  - `requestStop(id)` zwraca `true` tylko gdy bieg istnieje, ma status `running` i ma podpięty
    uchwyt. Ustawia znacznik `stopRequested` na karcie (panel rysuje „zatrzymywanie…") i zapisuje
    krok `stop.requested {by:'panel'}` - nowy TYP zdarzenia w trace.log.
  - **Status zmienia się dopiero, gdy pętla naprawdę stanie** i domknie byt przez `finish`/`fail`
    (zwykle `aborted`). `stopRequested === true` przy `status === 'running'` to normalny stan
    przejściowy, nie awaria.
  - Uchwyt jest kasowany przy `task:finished` (subskrypcja BEZWARUNKOWA, w odróżnieniu od
    konsumenta trace), przy retencji i w `dispose()` - inaczej byłby wyciek domknięć.
- ⚠️ **Demontaż NAJPIERW zatrzymuje, POTEM odpina.** `dispose()` NICZEGO NIE ZATRZYMUJE - puszcza
  uchwyty, nie woła ich (i zostaje best-effort + idempotentny). Od zatrzymania jest
  `stopAll(reason)`: woła KAŻDY uchwyt (osobny try/catch, uchwyt który rzucił nie blokuje reszty),
  znaczy karty `stopRequested` i zapisuje `stop.requested {by:reason}`. `onunload` woła
  `stopAll('unload')` PRZED `subTaskNotifier.dispose()` / `dispose()` / `closeAll()` MCP -
  odwrotna kolejność zrywałaby kanały raportowania, ale zostawiałaby bieg mielący na vaultcie.
- ⚠️ **UI wysyłania wiadomości do biegnącego suba nie istnieje.** Komunikacja z biegnącym subem
  należy do AGENTA, nie do usera - user może bieg wyłącznie PRZERWAĆ (Stop). **Sam kanał ZOSTAJE
  i jest świadomie utrzymywany, nie jest martwym kodem:** `registry.postMessage` / `takeMessages`
  + hook `beforeContinue` w `SubAgentRunner` + ich testy czekają na przyszłe narzędzie agentowe
  (agent pisze do własnego suba).
- ⚠️ **Widok czyta rejestr, nie odwrotnie - i mieszka w CZACIE.** Biegi pokazuje pasek pod
  zakładkami czatu (`modules/chat/chat/subTaskStrip.ts`), bo należą do agenta i sesji, nie do
  globalnego sidebara. Pasek bierze `plugin.subTaskRegistry.list()` + `plugin.subTaskNotifier.pending()`
  i oddaje je czystemu `buildStripModel`. Wszystko, co da się policzyć źle po cichu (bieg z
  cudzej zakładki, duplikat wiersza, licznik z sufitu `maxStepsPerTask`), siedzi w modelu i ma
  testy AVA; sam widok jest głupi, więc testów nie ma. ⚠️ **`subTaskPanelModel.ts` NIE MOŻE
  zacząć importować `obsidian` ani i18n** - idzie do barrela zwykłym re-eksportem, a barrel modułu
  musi zostać obsidian-free (wiszą na nim testy AVA `DelegateTool`/`TriggerPopup` i sam moduł
  chat). Etykiety dobiera widok.
- ⚠️ **`runTask` mówi, JAK sub zszedł - i czy w ogóle dojechał.** Zwrotka niesie `stoppedBy`
  (`natural` = model domknął sam, `backstop` = skończyły się iteracje, `abort` = ubity z
  zewnątrz, `error` = wyjątek) oraz `failed: true` **wyłącznie** w gałęzi `catch`. Tekst błędu
  ZOSTAJE w polu `result` (kompatybilność), ale to `failed` decyduje, że `DelegateTool` odda
  modelowi `{success:false}` - patrz `modules/tools/CLAUDE.md`.
  - **`'error'` powstaje w runnerze, nie w pętli.** `runAgentLoop` przy wyjątku po prostu rzuca
    dalej i nie zna takiej wartości; runner ją nadaje w `catch`.
  - **Backstop nie jest błędem.** Sub, któremu skończyły się iteracje, wraca jako `success:true`
    + `stopped_by:'backstop'` - jego wynik może być niepełny albo być zaślepką, ale bieg się
    odbył. Rozróżnienie „zaślepka czy dorobek" widać w trace pętli (`loop.end … fallback=1`,
    patrz `modules/agent-loop/CLAUDE.md`).
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
  + „pull pamięć" + ZASADY) żyje w `DEFAULT_SUBAGENT_FRAME_PROMPT` z placeholderami;
  `_buildTaskPrompt` rozwiązuje go przez `resolveWorkPrompt(agent, 'subagent_frame_prompt',
  settings, factory)` (łańcuch agent>global>factory) i wstrzykuje mechaniczne sekcje (METHOD
  z `config.prompt`, SCOPE z `config.scope`, BUDŻET z limits). Treść nadal PL inline, ale
  **user-editowalna** globalnie (Settings→Prompt) i per agent rodzic (nie przez template z
  `modules/prompts/`).
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
- ⚠️ **`deleteSubAgent`/`store.delete` zwracają `false` i TĘ wartość trzeba przeczytać.** Decyzja
  o komunikacie mieszka w czystym `deleteOutcome.ts` (`resolveDeleteOutcome`): tylko `true`
  znaczy „Usunięto", cokolwiek innego (w tym `undefined` z opcjonalnego łańcucha) to
  `modal.sub_agent.delete_failed` - modal zostaje otwarty, kafel Zaplecza nie znika. `rmdir` jest
  NIEREKURENCYJNE, więc jeden dodatkowy plik w folderze suba wystarczy, żeby kasowanie padło.
- ⚠️ **Handler kafla Zaplecza NIE MOŻE zniknąć po cichu.** `renderUseAtAgentButton`
  (`ui-components/backstage_helpers.ts`) woła `onPick(agent.name)` i PORZUCA zwróconą obietnicę,
  a `useTemplateAtAgent` robi dwa zapisy pod rząd (`store.instantiate` → kopia suba na dysku,
  `agentManager.updateAgent` → przypisanie). Rzut z drugiego zostawia półstan: kopia
  `<agent>-<szablon>` w `.pkm-assistant/sub-agents/` bez wpisu w `sub_agents`, zero `Notice`,
  zero `nav.refresh()` - a ponowne kliknięcie odlewa DRUGĄ kopię z sufiksem `-2`. Bezpiecznik:
  czysty `templateUseOutcome.ts` (`guardTemplateUse`) - ten sam wzór co `deleteOutcome.ts`, zero
  DOM/obsidian/i18n, oddaje klucz `backstage.template_use_failed` + surowy rzut do `log.error`.
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

## TODO

Najważniejsze:
- 🟠 4 role rdzeniowe systemowe (`prep-memory`, `prep-whitelist`, `strateg-planer`, `strateg-sumarizer`)
- 🟠 YAML schema custom sub-agentów - whitelist tools (już jest) + whitelist scope (foldery + frontmatter + sekcje + pinned notes)
- 🟠 Parallel execution w `DelegateTool` - `args.tasks` już jest, doszlifować (per-task instance vs singleton)
- 🟠 Hyperfocused per-akcja + klikalność w chacie

---

## Powiązane

- `modules/agent-loop/CLAUDE.md` - stamtąd przychodzi `runAgentLoop` (wspólna pętla tool-callingu z czatem; `streamToCompleteWithTools` w `modules/memory` zostało usunięte tym samym zadaniem)
