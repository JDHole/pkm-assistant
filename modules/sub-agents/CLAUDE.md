# modules/sub-agents/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Unified delegation system.** Sub-agenci to "minionki" agenta — drugorzędne instancje z własnym system promptem, własnym budżetem tokenów, własnym zestawem narzędzi. Dziedziczą model nadrzędnego agenta (override możliwy w YAML).

**Status:** 🚀 ACTIVE — kod fizycznie w `modules/sub-agents/` (Mapa-11, 2026-04-26).

**Sprint Refaktoru — który mnie dotyka:**
- ✅ [Sprint 05 Sub-agents v2 + Inline Triggers UI](../../Refaktor/Sprinty/SPRINT_05_Sub_Agents_v2_Inline_Triggers.md) **DONE 2026-04-28** — 4 role rdzeniowe systemowe (`prep-archivist` + `prep-whitelist` + `strateg-planer` + `strateg-sumarizer`) + custom YAML schema z scope (folders/frontmatter/sections/pinned) + DelegateTool DI + parallel + timeout 60s + concurrent safety + SubAgentEditorModal scope fields + intersection security + force-trigger `aspect_explicit` + skills BUG-1 + DRY-1
- Removed 2026-05-16 cleanup: `prep-archivist` zastapiony przez `prep-memory`; system roles sa teraz 4: `prep-memory`, `prep-whitelist`, `strateg-planer`, `strateg-sumarizer`.
- ✅ [Sprint 05.5 Hotfix](../../Refaktor/Decyzje_Sesji/2026-04-29_post_sprint_05_HOTFIX.md) **DONE 2026-04-29** — domknięcie Z8 popup `/`/`@` + Z9 sidebar tab "Triggery" + Z12 modal accept jako Plan B + dokumentacja sync
- ✅ [Sprint 07 Archetypes & Roles v2](../../Refaktor/Sprinty/SPRINT_07_Archetypes_Roles_v2.md) — Z6 modelRole rename `minion` → `researcher`, `master` → `strategist` domknięty w smoke-02 finding 06 (DelegateTool używa nowych nazw bez deprecation warning)

**Wersja kodu:** v2.2 (E2.4 — D18/F6). **DUŻA ZMIANA:** kasacja systemowego podziału research/strateg. Plugin daje **JEDEN generyczny worker** (`delegate(task:"...")` bez `aspect` — działa nawet gdy agent nie ma żadnych subów), a każdy asystent buduje **własne custom suby** (po nazwie: `aspect:"klara-prep"`). „Piecz metodę, pulluj dane": brain-injection 12k pushem **USUNIĘTY** — sub sam czyta pamięć (`search/read/list scope=memory`) albo dostaje fragment w `context`. **Kanał main↔sub `runTask` BEZ ZMIAN**, przecięcie uprawnień rodzic∩sub ZOSTAJE. Warsztat/Ekipa (szablony subów w UI) = E2.8.

> ⚠️ **E2.4 (D18/F6) — co zniknęło:** 4 role systemowe (`prep-memory`/`prep-whitelist`/`strateg-planer`/`strateg-sumarizer`), `modules/sub-agents/roles/`, `loadSystemRoles()`, migracje `prep-archivist→prep-memory`, `subagent_max_iterations_strategist`, rozgałęzienia po `config.role === 'strategist'` w Runnerze/DelegateTool/Loaderze, `activeResearchers`/`activeStrategists`. **F6 (2026-07-23):** `role` w YAML sub-agenta to TYLKO opisowa etykieta (nie steruje modelem/narzędziami/promptem). **⚠️ Skorygowane w F4 (2026-08-15, patrz „F4 „model policy v2"" niżej): od F4 `role: 'worker'` STERUJE wyborem modelu** (`createModelForRole(plugin, 'sub_worker', …)` = model rodzica zamiast slotu sub-agentów) — dotyczy wbudowanego aspektu `worker` i custom suba z `role: worker` w YAML. Reszta pól (narzędzia, prompt, limity) nadal nie zależy od roli — tylko wybór modelu jest wyjątkiem. **Degradacja:** stare YAML-e agentów z przypisaniem `prep-memory` itd. → delegate zwróci czysty błąd „konfiguracja sub-agenta X nie znaleziona" (te nazwy już nie istnieją jako suby). Nowy agent dostaje własny `<slug>-prep` (createPrepSubAgent), nie role systemowe.

---

## Co tu jest

```
modules/sub-agents/
├── index.js                    # publiczne drzwi
├── CLAUDE.md                   # ten plik
├── SubAgentLoader.js           # ~430 LOC — skanuje .pkm-assistant/sub-agents/, parsuje YAML, save/delete/starter + migracje tools
├── SubAgentRunner.js           # ~250 LOC — wykonanie sub-agent z tool-calling loop (E2.8: rama z resolvera; F1: zakłada byt w rejestrze)
├── SubTaskRegistry.js          # ~370 LOC (F1 + F2 origin/background + F3 attachAbort/requestStop) — SubTask jako byt (id/status/kroki/wynik/budżet) + szyna zdarzeń + side-channel abortów; pure, obsidian-free
├── SubTaskNotifier.js          # ~150 LOC (F2) — skrzynka wyników subów z tła: kolejka + `setDeliverer`/`drain`; pure, obsidian-free
├── subTaskPanelModel.js        # ~150 LOC — CO pasek biegów ma narysować (per zakładka czatu): filtr, kolejność, liczniki, skróty; pure (zero obsidian/DOM/i18n)
├── SubAgentTemplateStore.js    # ~304 LOC (S27 Z1) — magazyn szablonów subów (.pkm-assistant/templates/sub-agents/)
├── SubAgentEditorModal.js      # ~376 LOC (S31, z shell) — modal tworzenia/edycji suba; importuje `obsidian`, poza barrelem (lazy-load)
├── types.js                    # ~57 LOC (TS-4) — wspólne typy modułu (SubAgentData, ScopeData, …)
├── framePrompt.js              # ~28 LOC (E2.8 B3) — DEFAULT_SUBAGENT_FRAME_PROMPT (fabryczny szkielet ramy suba, placeholdery)
├── BackstageTab.js             # ~22 LOC (S10 hotfix) — register tab + lazy-load renderSubAgentsTab
├── SubAgentsBackstageTab.js    # ~135 LOC (S10 hotfix) — render Sub-Agents tab w Backstage sidebar
├── SubAgentDetailView.js       # ~145 LOC (S10 hotfix) — render single sub-agent detail view
├── deleteOutcome.ts            # ~34 LOC (K3-E, AUD-bledy-012) — resolveDeleteOutcome: co zameldować po
│                                #   próbie skasowania suba/szablonu; woła SubAgentEditorModal + SubAgentsBackstageTab
└── templateUseOutcome.ts       # ~54 LOC (K3-L, AUD-bledy-014) — guardTemplateUse: co zameldować po
                                 #   "Użyj u agenta" w Zapleczu; woła SubAgentsBackstageTab
```

> **E2.4 (D18):** folder `roles/` (4 role systemowe + `loadSystemRoles()`) **SKASOWANY**. Domyślny zestaw narzędzi workera = stała `DEFAULT_SUB_AGENT_TOOLS` w `SubAgentLoader.js`.

Razem **~2,060 LOC** (11 plików z index/CLAUDE.md, bez testów; po E2.4 -roles/ + thin prompt, po E2.8 +framePrompt.js, po S27 +SubAgentTemplateStore.js, po S31 +SubAgentEditorModal.js z shell, po F1 +SubTaskRegistry.js).

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
| `SubAgentLoader` | Klasa — skanowanie `.pkm-assistant/sub-agents/`, parse YAML + KNOWLEDGE.md, cache, save/delete, ensureStarter, createPrepSubAgent |
| `SubAgentRunner` | Klasa — wykonanie sub-agent (`runTask()`), ujednolicony system prompt builder (`framePrompt.js`, NIE zależy od roli — patrz „Model po E2.4" niżej), tool-calling loop przez `runAgentLoop` (`modules/agent-loop`, wspólna pętla od E2.1) |
| `SubTaskRegistry` | F1: księga biegów subów + szyna zdarzeń (`task:created` / `task:step` / `task:finished`). Stawia go composition root (`plugin.subTaskRegistry`), konsumują trace.log i panel F3. Pure — zero `obsidian`, zero I/O. **F3:** dodatkowo skrzynka kontaktowa do biegu — `attachAbort(id, fn)` / `requestStop(id)`. **F5:** ta sama skrzynka przyjmuje WIADOMOŚCI — `postMessage(id, text)` / `takeMessages(id)`. |
| `SubRunResult`, `SubRunStoppedBy` (typy) | F5: kształt zwrotki `runTask` — `stoppedBy` (`natural`/`backstop`/`abort`/`error`) + `failed?: true`. Czyta je `DelegateTool`. |
| `buildStripModel`, `formatDuration` (+ typy `StripRow`/`StripStep`/`BuildStripModelInput`) | Czysta arytmetyka **paska biegów w oknie czatu** (2026-08-15): filtr per zakładka, kolejność, liczniki, skróty. Konsumentem jest `modules/chat` (`chat/subTaskStrip.ts`), stąd eksport; plik zostaje pure, więc barrel dalej jest obsidian-free. |
| `SubTaskNotifier` | F2: skrzynka wyników subów odpalonych W TLE. Siedzi na `task:finished`, bierze WYŁĄCZNIE taski z `background === true`, trzyma je w kolejce (sufit 200, najstarsze wypadają) aż dostawca je skonsumuje. API: `setDeliverer(fn\|null)` (`true` = skonsumowane; `false`/wyjątek = zostaje), `drain()`, `pending()`, `pendingFor(agentName)`, `dispose()`. Stawia go composition root jako `plugin.subTaskNotifier`; dostawcę wstrzykuje **faza B (czat)**. Pure — nigdy nie rzuca. **Dostawcą jest `ChatView`** — patrz gotcha F2 niżej. |
| `SubTask`, `SubTaskStatus`, `SubTaskStep`, `SubTaskBudget`, `SubTaskResult`, `SubTaskOrigin`, `SubTaskDeliverer` (typy) | Kształt bytu biegu suba + adres zwrotny zlecenia + kontrakt dostawcy, dla konsumentów zdarzeń. |
| `getVisibleSubAgentsForAgent` | Filtr: **tylko** custom suby z prefiksem `<agent-slug>-` (D18: brak ról systemowych; legacy standalone bez prefiksu ukryty) |
| `DEFAULT_SUB_AGENT_TOOLS` | Jednolity domyślny zestaw workera: `search/list/read/web_search/web_read` (D18; `connect_to_server` OUT w E3.1 faza C). Przecięcie z rodzicem robi `_getTools`. |
| `PKM_SUB_NAME` | S27: nazwa syntetycznego workera (`'pkm-sub'`) dla `delegate` bez `aspect`. |
| `SubAgentTemplateStore` | S27 Z1: magazyn szablonów subów (Zaplecze). Owner: `AgentManager.subAgentTemplateStore`. |
| `registerBackstage` / `renderSubAgentDetailView` | Rejestracja zakładki Zaplecza + widok detalu (lazy-load, barrel zostaje obsidian-free). |
| `DEFAULT_SUBAGENT_FRAME_PROMPT` | E2.8 B3: fabryczny szkielet ramy suba (`framePrompt.js`, pure/obsidian-free). Wystawiony w Settings→Prompt (B2), rozwiązywany łańcuchem agent>global>factory przez `resolveWorkPrompt`. |

> **S30 Z4 — 3 eksporty WYCIĘTE z barrela** (zero konsumentów spoza modułu):
> `DEPRECATED_TOOL_RENAMES`, `migrateDeprecatedTools`, `SUB_AGENT_TEMPLATES_PATH`.
> **Definicje ŻYJĄ w bebechach** — migrację nazw narzędzi w user YAML odpala `SubAgentLoader`
> przy load (i zapisuje plik z powrotem) oraz `SubAgentRunner._resolveToolNames` jako fail-safe;
> ścieżkę magazynu szablonów zna `SubAgentTemplateStore`. `DEPRECATED_TOOL_RENAMES` i
> `migrateDeprecatedTools` mają realnego deep-importera (`SubAgentRunner.ts` / testy loadera) —
> zdanie „testy deep-importują pliki wprost" jest dla nich prawdziwe. Dla `SUB_AGENT_TEMPLATES_PATH`
> **nie było** — żaden test po nią nie sięgał, sam `export` na stałej w pliku był zbędny (fabryka
> dead-code D7, AUD-dead-code-010/164): słowo `export` zdjęte, stała zostaje prywatna dla
> `SubAgentTemplateStore.ts`. Ta sama poprawka objęła `DEFAULT_RESEARCHER_MAX_TOOL_RESULT_LENGTH`
> w `SubAgentLoader.ts` (nigdy nie był w barrelu, miał jedno użycie w tym samym pliku).

**Ważne metody publiczne `SubAgentLoader`** (używane przez DI):
- `loadAllSubAgents()` — load + cache (AgentManager init)
- `getSubAgent(name)` / `getAllSubAgents()` — read cache (sidebar views)
- `saveSubAgent(data)` / `deleteSubAgent(name)` — UI tworzenia (SubAgentEditorModal)
- `ensureStarterSubAgents()` — **ensure-folder, NIE factory** (zweryfikowane w `SubAgentLoader.ts`): tylko sprawdza/tworzy `.pkm-assistant/sub-agents/` jeśli nie istnieje. Od D18 plugin nie zasiewa żadnych domyślnych subów — opis „4 startery" jest historyczny (sprzed E2.4), patrz też „Czystka E3.6 update" niżej.
- `createPrepSubAgent(agentName)` — factory `<agent>-prep` per agent
- `reloadSubAgents()` — hot reload (clear cache + re-load)

**`SubAgentRunner` ma TYLKO 1 metodę publiczną:**
- `runTask(taskPrompt, agent, config, model, options)` — wywoływana z `DelegateTool._executeSubAgent`

---

## Model po E2.4 (D18/F6)

**Brak ról systemowych.** Plugin NIE wnosi żadnych wbudowanych subów. Są dwa sposoby delegacji:

1. **Generyczny worker** — `delegate(task:"...")` bez `aspect`. `DelegateTool.buildGenericWorkerConfig()` tworzy syntetyczny config `{ name:'worker', tools: DEFAULT_SUB_AGENT_TOOLS }` (bez `config.prompt`, bez roli). Działa **nawet gdy agent nie ma żadnych subów**. Model = slot `researcher`→minion.
2. **Custom sub usera** — `delegate(task:"...", aspect:"<nazwa>")`. Rozpoznawany po nazwie (exact → fuzzy po nazwie; **brak fallbacku po roli**). Widoczny tylko dla swojego agenta (prefiks `<agent-slug>-`).

**Jednolite defaulty (F6 — rola nie steruje):** `DEFAULT_SUB_AGENT_TOOLS = search/list/read/web_search/web_read` (`connect_to_server` wycięty w E3.1 faza C — ta linia kłamała do F5), `max_iterations` = worker (`subagent_max_iterations_worker` w `config/limits.ts`, **default 25** — F4: 8→12, runda 2 z 2026-08-17: 12→25, sufit 100; zob. gotcha „Limity iteracji/timeout/długości" niżej), `min_iterations` = 1, `max_tool_result_length` = 15000, cap kontekstu delegata = **`delegation_context_max_chars`, default 48000** (F4; wcześniej hardcode 16000). **Precedencja config-vs-default** (zweryfikowane w `SubAgentRunner.ts`): `config.max_iterations || limits.subagent_max_iterations_worker` — pole z YAML custom suba wygrywa, gdy jest ustawione na wartość prawdziwą (0/brak/undefined spadają na default 25 z `config/limits.ts`); ta sama zasada dotyczy `config.tools` (wygrywa nad `DEFAULT_SUB_AGENT_TOOLS`), a przecięcie z uprawnieniami rodzica robi `SubAgentRunner._getTools` DOPIERO PO tym wyborze.

**Thin prompt (`_buildTaskPrompt`) — „piecz metodę, pulluj dane":** nagłówek + `config.description` + `config.prompt` (miękki cap **`subagent_prompt_max_chars`, default 24000** — F4; wcześniej hardcode 6000) + jedna linia wskazówki pull do pamięci (`scope=memory`) + SCOPE (jeśli custom sub go ma) + BUDŻET + jedna wspólna lista ZASAD. **Brain-injection 12k + katalog brain/ + LOKALIZACJE — USUNIĘTE.** Weryfikacja E2.4: sub REALNIE czyta pamięć rodzica przez `read/search/list scope=memory` (MCPClient przekazuje `agentName` rodzica → `_invocationAgentName` → `readMemory` czyta pamięć wołającego agenta; bramka `permissions.memory` fail-closed, default true; blokada `.pkm-assistant/**` dotyczy tylko scope=vault). Dlatego zostaje linia pull, a nie martwe ścieżki plików.

### Custom YAML scope schema (S05 Z2)

Custom sub-agenty mogą definiować `scope` w `SUB_AGENT.yaml`:

```yaml
scope:
  folders: ["Projekty/X/"]
  frontmatter: { project: "X" }
  sections: ["## Drafty"]
  pinned_notes: ["Strategia X.md"]
```

Wszystkie pola opcjonalne. Domyślny `max_tool_result_length: 15000` jeśli nie podany. Walidacja **permissive** (forward-compatible — nieznane pola nie są odrzucane).

### Hyperfocused per-akcja (kierunek dalszy)

Po S05 baza jest gotowa: user buduje N hyperfocused per agent. Convention: `<role>-<context>-<action>` (np. `prep-x-post-finder`, `strateg-li-brief-creator`). Klikalne w chacie identycznie jak skille (slim bar + popup `/@` + sidebar tab Triggery — wszystko **w S05+S05.5**).

---

## Po Sprincie 1 post-MAX

> ⚠️ **ZAPIS HISTORYCZNY (plan z ery Mapy, kwiecień 2026).** Kierunek A (role systemowe) został
> ZREALIZOWANY w S05, a następnie **SKASOWANY w E2.4 (D18)** — dziś nie ma żadnych ról
> systemowych, jest 1 generyczny worker + custom suby (patrz „Model po E2.4" wyżej). Sekcja
> zostaje jako kontekst historyczny; nie traktuj jej jako TODO.

**Dwa kierunki rozwoju** (połączone w refaktorze):

### A) Systemowe role rdzeniowe (`MEMORY_v2_RETRIEVAL_v2.md` Blok 4)

```
PREP roles (researchers — zbierają informacje):
├── prep-memory        [factory default systemowy]  — Memory v3 brain + summaries recall
└── prep-whitelist     [factory default systemowy]  — vault z konkretnym scope'em

STRATEG roles (strategists — przerabiają informacje):
├── strateg-planer     [factory default systemowy]  — planowanie
└── strateg-sumarizer  [factory default systemowy]  — synteza, podsumowanie
```

### B) Hyperfocused per-akcja (`SUB_AGENTS_v2_PER_AKCJA.md`)

User buduje N hyperfocused per agent — każdy ekspert od JEDNEJ akcji. Konwencja: `<role>-<context>-<action>`.

Przykłady:
- Klara: `prep-x-post-finder`, `strateg-x-brief-creator`, `prep-li-engagement-scanner`
- Jaskier: `prep-daily-yaml-7d`, `prep-vault-projekty`, `strateg-podsumowanie-tygodnia`

**Klikalne w chacie tak samo jak skille** (sidebar tab + popup `@` + chip CM6 widget). Whitelist sub-agenta = intersection z whitelist agenta głównego.

**Plus parallel execution** — `DelegateTool` ma już `args.tasks` z `Promise.all` (linia 82-95), wymaga doszlifowania (per-task instance vs singleton).

---

## Zależności

**Importuje z:**
- `core/utils/yamlParser` (parseYaml, stringifyYaml)
- `core/utils/slugify`
- `core/utils/Logger`
- `core/i18n/index.js` (`t`)
- `modules/agent-loop/index.js` (`runAgentLoop`, `ArrayMessageStore` — wspólna pętla tool-callingu, E2.1)

**Importowany przez** (część ścieżek `src/` pochodzi sprzed migracji do `modules/`; semantyka aktualna):
- `modules/agents/AgentManager.js` — `SubAgentLoader` (centralny manager agentów, instancjuje per plugin)
- `modules/tools/DelegateTool.js` — `SubAgentRunner` (jedyny tool który wywołuje sub-agentów, lazy-init singleton)
- `modules/agents/profile/profile_team.js` — „od zera" bierze `loadSubAgentEditorModal()`
  z barrela (leniwy `import()` w handlerze kliknięcia). **S31:** sam `SubAgentEditorModal.js`
  (365 LOC) mieszka od tej pory TUTAJ, nie w `modules/shell/` — wewnątrz modułu wołany wprost,
  na zewnątrz przez leniwy akcesor, bo statycznie importuje `obsidian`, a barrel subów musi
  zostać obsidian-free (`DelegateTool`/`TriggerPopup` mają testy w AVA).
- `modules/shell/sidebar/{BackstageViews,DetailViews,HomeView}.js` — listing + counter (DI)
- `modules/agents/profile/{profile_prompt,profile_team}.js` — profil agenta (DI)
- `modules/onboarding/PlaybookManager.js` — `generateDelegowanieSection`

---

## Kluczowe decyzje

- **Role-based zamiast id-based** (sesja 45-46): sub-agent ma `role: researcher | strategist`, nie unique ID. Pozwala wymieniać sub-agenty bez zmian w kodzie. Aspect resolution w `DelegateTool._resolveDelegate` — fuzzy match (`aspect="prep"` matchuje pierwszego researchera).
- **Factory defaults dla każdego agenta** (sesja 83-86): nowy agent automatycznie dostaje prep + strateg. Po Sprincie 1: 4 role rdzeniowe systemowe + hyperfocused per akcja (user-built).
- **Skip cache dla non-main roles** (sesja 125): KRYTYCZNE — `ChatModel.stream()` NIE jest concurrent-safe.
- **Unified runner** (sesja 83-86): `SubAgentRunner` zastąpił `MinionRunner` + `MasterRunner`. Auto-migration `.pkm-assistant/minions/` + `.pkm-assistant/masters/` → `.pkm-assistant/sub-agents/` w `_migrateOldFormats` (do wywałki w Sprincie 0 — patrz znalezisko DEAD-1).
- **Smoke 02 finding 08 (2026-05-17):** `SubAgentLoader` migruje deprecated tools w `SUB_AGENT.yaml` przy load i zapisuje YAML z powrotem: `memory_sessions` → `memory_list_summaries`, `memory_summaries` → `memory_read_summary`, z deduplikacją listy `tools`.

---

## Gotchas

- ⚠️ **K4 (2026-08-22): ZASADA ZAMROŻENIA STANU TURY. Bieg suba NIE CZYTA globalnych luster
  pluginu.** Delegacja z głównego czatu jest od rundy 3 zawsze w tle, więc bieg z definicji
  przeżywa turę i dożywa chwili, w której user przełączył zakładkę. `agentManager.activeAgent`,
  `getActiveMemory()` i `plugin.currentAutonomy` opisują wtedy KOGOŚ INNEGO. Dlatego:
  - **pamięć** → `getAgentMemory(agentName)` po WŁAŚCICIELU biegu (argument `runTask`, ten sam,
    który ląduje w `SubTask.agentName`). Brak instancji dla nazwanej tożsamości = **odmowa
    zapisu**, nigdy zjazd na `getActiveMemory()` (AUD-security-091);
  - **tryb autonomii** → `RunOptions.autonomy`, zamrożony przy zleceniu dokładnie jak
    `scopeFolders` w S33. Wartość jedzie: tura → `MCPClient` (`_invocationAutonomy`, zaufany
    znacznik, zawsze nadpisywany) → `DelegateTool` → `runTask` → `_executeTool`.
    `plugin.currentAutonomy` został **wyłącznie jako fallback** dla starych wołaczy
    (AUD-security-050).
  Dokładasz nową rzecz, której bieg potrzebuje (model, ścieżka sesji, uprawnienie)? **Przekaż ją
  w opcjach zlecenia**, nie sięgaj po nią z pluginu w trakcie biegu. Strażnik end-to-end:
  scenariusz harnessa `43_tlo_po_turze`.
- ⚠️ **K8 (2026-08-22): komunikat błędu suba wychodzi z runnera JUŻ ZAMASKOWANY.** Maskowanie
  siedzi w `_extractSafeErrorMessage` — jednym miejscu, przez które przechodzą WSZYSCY trzej
  odbiorcy: rejestr biegów, plik aktywnej sesji w vaultcie i wynik oddany narzędziu `delegate`
  (czyli kontekst modelu rodzica). Do K8 maskował tylko rejestr, a przy zdarzeniu strumienia
  bez `data` komunikat bywa całym `JSON.stringify(event)` razem z nagłówkiem `Authorization`.
  Dokładasz nową drogę wyjścia błędu? Bierz string z tej funkcji, nie z surowego `error`.
- ⚠️ **AUD-bledy-013 (2026-08-23): padnięte narzędzie suba jest ZNACZONE, choć egzekutor nadal
  nie rzuca.** `_executeTool` mierzy wynik funkcją `toolResultStatus` (`core/index.js`, ta sama
  reguła, co status chipa w czacie): porażka wraca do transkryptu suba linią `subagent.tool_error`
  (po polsku „Błąd narzędzia …", z pełnym payloadem, przez maskę K8) i zapala hak `onFailure`.
  `runTask` opakowuje `trace` pętli i tym hakiem stawia `status:'error'` na kroku `tool.post`
  (parowanie po KOLEJNOŚCI wywołań — jeden `tool.post` na wywołanie, bez dubli i bez zawyżania
  licznika), więc gałąź błędu w `subTaskPanelModel.detailFromPost` przestała być martwa.
  **Kontrakt „egzekutor NIE rzuca" zostaje** — sygnał idzie obok tekstu, nie zamiast niego.
- ⚠️ **Etykieta trace suba: `sub/<nazwa|rola|sub>#<nr wywołania>`** (Poligon F2). Numer to licznik
  wywołań w procesie (base36), bo `delegate` z listą `tasks` odpala N workerów RÓWNOLEGLE — bez
  niego wszystkie pisały pod wspólną etykietą i przebiegów nie dało się rozdzielić. Konwencja jak
  w pętli głównej (`chat/<agent>#<id sesji>`, `harness/<agent>#<runId>`); czas by nie wystarczył,
  bo równoległe suby startują w tej samej sekundzie. **Czytelnicy trace muszą dopasowywać etykietę
  PREFIKSOWO** — `scenarios/_asserts.js` harnessu (`parseTrace(..., {prefix:true})`, używa go
  `subTraceEvents`) kończy dopasowanie na `#`, więc `sub/pkm-sub` nie łapie `sub/pkm-sub-extra`.
- ⚠️ **F1: źródłem śladu suba jest REJESTR, nie plik.** `SubAgentRunner.runTask` zakłada bieg
  w `plugin.subTaskRegistry` (`create`) pod TĄ SAMĄ etykietą co dotąd w trace (`id` taska =
  etykieta), a pętli podaje funkcję-tee `registry.traceFor(task)`. **trace.log jest PIERWSZYM
  KONSUMENTEM** zdarzenia `task:step` (subskrypcja żyje w konstruktorze `SubTaskRegistry`, gdy
  dostanie `traceLog`) — pisze przez `traceLog.scope(task.id)`, więc **format linii nie zmienia
  się o bajt** i scenariusze harnessa (`subTraceEvents`, dopasowanie prefiksowe) działają dalej.
  Panel podglądu (F3) podepnie się jako DRUGI konsument, bez dotykania runnera.
  - **Fallback bez rejestru** (`plugin.subTaskRegistry` puste — testy jednostkowe, stary bootstrap):
    runner woła `traceLog.scope(label)` wprost, dokładnie jak przed F1.
  - **Księgowość nigdy nie zmienia wyniku suba.** Rejestr jest fail-soft w środku (każda metoda
    w try/catch, `EventEmitter.emit` łyka wyjątki handlerów), a runner dodatkowo owija wołania
    w `_safeRegistry`. Wywalony rejestr = brak wpisu, nie wywalony sub.
  - **Maskowanie NA WEJŚCIU:** `step()` przepuszcza stringowe wartości pól przez wstrzykniętą
    maskę (`maskSensitiveData` w produkcji), więc każdy konsument — także przyszły panel —
    dostaje dane już bezpieczne. `fail()` maskuje też treść błędu (API lubi zwrócić w niej klucz).
  - **Sufity pamięci:** `maxStepsPerTask` 500 (kroki ponad limit NIE lądują w tablicy, ale
    zdarzenie leci dalej → plik ma pełny ślad) i `maxDone` 50 (najstarsze ZAKOŃCZONE biegi
    wypadają z mapy; biegi `running` nie są usuwane nigdy). `dispose()` na `onunload`.
- ⚠️ **F2: byt w rejestrze powstaje PRZED budową promptu, nie po niej.** `runTask` liczy etykietę
  (`_subCallSeq` bez zmian!) i woła `registry.create` na samym początku `try`, zanim padnie
  pierwszy `await` — bo delegacja w tle musi oddać modelowi `task_id` biegu, który dopiero
  rusza. Skutek uboczny (pożądany): wyjątek z `_buildTaskPrompt` domyka teraz byt przez `fail`,
  a nie znika bez śladu.
  - **Dostawcą wyników z kolejki notifiera jest `ChatView`** (faza B, `modules/chat`): wpina się
    przez `setDeliverer` w `onOpen` PO odtworzeniu sesji (dopiero wtedy stoją zakładki, do
    których dopasowuje się `origin`) i odpina w `onClose`. **Polityka aktywnej zakładki:** czat
    konsumuje wynik (`true`) wyłącznie wtedy, gdy zakładka adresata jest AKTYWNA i bezczynna —
    wtedy odpala nią auto-turę z powiadomieniem. Zakładka w tle albo trwająca tura = `false`,
    czyli wynik zostaje w kolejce i wraca przy najbliższym `drain()` (koniec tury / przełączenie
    zakładki / otwarcie czatu). Auto-tura na zakładce, której user nie widzi, jest świadomie
    zakazana. ⚠️ Notifier trzyma JEDNEGO dostawcę, a jego kolejka żyje w RAM — restart Obsidiana
    gubi niedostarczone wyniki (i tak nie ma czego wznawiać, biegi subów też giną).
    ⚠️ **Czwarta odmowa: PO STOPIE** (AUD-security-115, 2026-08-24). Notifier woła dostawcę
    WPROST z `_onFinished` (`task:finished`), z pominięciem `set_generating` — a bezpiecznik
    czatu „po Stopie nie sięgamy sami po zaległe wyniki" (`_drainSuppressed`) siedział wtedy
    wyłącznie tam. Sub kończący bieg pół minuty po Stopie startował więc auto-turę z własnym
    raportem. Bramka jest dziś w `_deliverSubTaskResult`, czyli w jedynym wspólnym wąskim gardle;
    **po stronie notifiera nic się nie zmieniło** — `false` znaczy „zostaw w kolejce" i tak też
    działa (test „dostawca zwracający false = wynik ZOSTAJE w kolejce").
  - Nowe pola `options` runnera: `origin` i `background` (lecą **1:1** do `registry.create`,
    runner ich nie interpretuje) oraz `onTaskCreated(task)` — hak wołany ZARAZ po `create`,
    pod tym samym `_safeRegistry` co reszta księgowości. **Bez rejestru hak nie jest wołany**
    (fallback sprzed F1 bez zmian), a wyjątek z haka nie może wywrócić suba.
- ⚠️ **F3: „Stop" z panelu to PROŚBA, nie egzekucja.** Rejestr nie wie, jak się ubija suba —
  trzyma cudzą funkcję. Uchwyt wpina `DelegateTool` w haku `onTaskCreated` (jedyne miejsce,
  gdzie istnieje naraz `task.id` i domknięta kontrolka abortu tego zadania), a ubija dokładnie
  tą samą drogą co timeout delegacji: `abortCtl.aborted = true` (pętla staje między iteracjami)
  + `abortCtl.stop()` (`stop_stream` modelu). Dotyczy WSZYSTKICH trzech ścieżek delegacji —
  multi-task, single w tle i single BLOKUJĄCY (tam hak istnieje wyłącznie po to).
  - `requestStop(id)` zwraca `true` tylko gdy bieg istnieje, ma status `running` i ma podpięty
    uchwyt. Ustawia znacznik `stopRequested` na karcie (panel rysuje „zatrzymywanie…") i zapisuje
    krok `stop.requested {by:'panel'}` — czyli **nowy TYP zdarzenia w trace.log**. Scenariusze
    harnessa liczą konkretne typy, więc są na to odporne.
  - **Status zmienia się dopiero, gdy pętla naprawdę stanie** i domknie byt przez `finish`/`fail`
    (zwykle `aborted`). `stopRequested === true` przy `status === 'running'` to normalny stan
    przejściowy, nie awaria.
  - Uchwyt jest kasowany przy `task:finished` (subskrypcja BEZWARUNKOWA, w odróżnieniu od
    konsumenta trace), przy retencji i w `dispose()` — inaczej byłby wyciek domknięć.
- ⚠️ **Z7 (AUD-bledy-054/056): demontaż NAJPIERW zatrzymuje, POTEM odpina.** `dispose()`
  NICZEGO NIE ZATRZYMUJE — puszcza uchwyty, nie woła ich (i zostaje best-effort + idempotentny).
  Od zatrzymania jest `stopAll(reason)`: woła KAŻDY uchwyt (osobny try/catch, uchwyt który rzucił
  nie blokuje reszty), znaczy karty `stopRequested` i zapisuje `stop.requested {by:reason}`.
  `onunload` woła `stopAll('unload')` PRZED `subTaskNotifier.dispose()` / `dispose()` / `closeAll()`
  MCP — odwrotna kolejność zrywała kanały raportowania, ale zostawiała bieg mielący na vaultcie.
- ⚠️ **UI wysyłania wiadomości do suba WYCIĘTE (decyzja Kuby 2026-08-15).** Komunikacja
  z biegnącym subem należy do AGENTA, nie do usera — user może bieg wyłącznie PRZERWAĆ (Stop).
  **Sam kanał ZOSTAJE nietknięty i jest świadomie utrzymywany, nie jest martwym kodem:**
  `registry.postMessage` / `takeMessages` + hook `beforeContinue` w `SubAgentRunner` + ich testy
  czekają na przyszłe narzędzie agentowe (agent pisze do własnego suba). Razem z UI poszły:
  `SubTaskRunsView.ts`, jego pole „Wiadomość", mapa szkiców `_steerDrafts` i test
  `SubTaskRunsView.steerDraft.test.ts` (mina „szkic musi przeżyć przerysowanie" zniknęła
  wraz z polem — w pasku czatu nie ma już żadnego inputu).
- ⚠️ **Widok czyta rejestr, nie odwrotnie — i mieszka teraz w CZACIE.** Od 2026-08-15 biegi
  pokazuje pasek pod zakładkami czatu (`modules/chat/chat/subTaskStrip.ts`), bo należą do
  agenta i sesji, nie do globalnego sidebara. Pasek bierze `plugin.subTaskRegistry.list()` +
  `plugin.subTaskNotifier.pending()` i oddaje je czystemu `buildStripModel`. Wszystko, co da się
  policzyć źle po cichu (bieg z cudzej zakładki, duplikat wiersza, licznik z sufitu
  `maxStepsPerTask`), siedzi w modelu i ma testy AVA; sam widok jest głupi, więc testów nie ma.
  ⚠️ **`subTaskPanelModel.ts` NIE MOŻE zacząć importować `obsidian` ani i18n** — idzie do barrela
  zwykłym re-eksportem, a barrel modułu musi zostać obsidian-free (wiszą na nim testy AVA
  `DelegateTool`/`TriggerPopup` i sam moduł chat). Etykiety dobiera widok.
- ⚠️ **F5: `runTask` mówi, JAK sub zszedł — i czy w ogóle dojechał.** Zwrotka niesie
  `stoppedBy` (`natural` = model domknął sam, `backstop` = skończyły się iteracje, `abort` =
  ubity z zewnątrz, `error` = wyjątek) oraz `failed: true` **wyłącznie** w gałęzi `catch`.
  Tekst błędu ZOSTAJE w polu `result` (kompatybilność), ale to `failed` decyduje, że
  `DelegateTool` odda modelowi `{success:false}` — patrz `modules/tools/CLAUDE.md`.
  - **`'error'` powstaje w runnerze, nie w pętli.** `runAgentLoop` przy wyjątku po prostu
    rzuca dalej i nie zna takiej wartości; runner ją nadaje w `catch`.
  - **Backstop nie jest błędem.** Sub, któremu skończyły się iteracje, wraca jako
    `success:true` + `stopped_by:'backstop'` — jego wynik może być niepełny albo być
    36-znakową zaślepką, ale bieg się odbył. Rozróżnienie „zaślepka czy dorobek" widać
    w trace pętli (`loop.end … fallback=1`, patrz `modules/agent-loop/CLAUDE.md`).
- ⚠️ **F5: `postMessage` to DORĘCZENIE PRZY NAJBLIŻSZEJ ITERACJI, nie przerwanie.**
  `registry.postMessage(id, tekst)` wrzuca polecenie do kolejki biegu; runner zdejmuje je
  hakiem `beforeContinue` (JEDYNY hook, jaki suby podpinają do pętli) i dopisuje do
  transkryptu jako wiadomość usera z ramką `subagent.steer_prefix`.
  - **Sub w środku długiego strumienia przeczyta ją dopiero po nim** — hak leci między
    wywołaniami modelu, a nie w trakcie. **Sub, który wszedł już w ostatnią iterację
    (backstop), może jej nie przeczytać wcale**: kolejka znika razem z biegiem
    (`task:finished`). Od twardego zatrzymania jest `requestStop`, nie wiadomość.
  - `postMessage` zwraca `true` tylko, gdy bieg istnieje, ma status `running`, tekst nie
    jest pusty i kolejka nie jest pełna. **Sufit (`maxMessagesPerTask`, default 10) ODMAWIA
    zamiast wypychać najstarszą** — cicha utrata polecenia sterującego byłaby gorsza od
    uczciwego „nie zmieściło się".
  - Ślad: `user.message {chars}` — **nowy TYP zdarzenia** w trace.log (harness liczy
    konkretne typy, więc jest na to odporny). Do logu idzie sama DŁUGOŚĆ; treść i tak siedzi
    w transkrypcie suba, a w kolejce jest już przepuszczona przez maskę (`maskSensitiveData`).
  - **Bez rejestru hak NIE jest podpinany** — ścieżka sprzed F5, zero zmian.
- ⚠️ **`options.onGateAdmitted` to PRZELOT, nie logika runnera (Z2, FAIL 4 smoke'a 2026-08-15).**
  Runner podaje go pętli 1:1 (`RunAgentLoopOptions.onGateAdmitted`) i sam nie wie, po co komu
  ten sygnał — czyta go `DelegateTool`, żeby budżet CAŁEGO zadania (`delegation_timeout_ms`)
  liczył czas ROBOTY, a nie stania w kolejce bramki platformy lokalnej. Bez tej opcji nic się
  nie zmienia (jak `shouldAbort`). Szczegóły mechanizmu: `modules/tools/CLAUDE.md`.
- ⚠️ **Dziedziczenie autonomii (E2.3 D21/F12): tryb pytań przychodzi ze ZLECENIA.** `SubAgentRunner._executeTool` woła `mcpClient.executeToolCall(toolCall, agentName, { autonomy: execOptions.autonomy ?? this.plugin?.currentAutonomy })` — sub-agent PYTA (albo nie) tak jak tura, która go odpaliła. **K4 (2026-08-22):** do tej naprawy czytane było wyłącznie plugin-globalne zwierciadło, więc sub odpalony w `all` dokańczał bieg w `yolo`, gdy user przeskoczył na inną zakładkę (AUD-security-050). Zwierciadło zostaje fallbackiem dla wołaczy, którzy trybu nie przekazują. Autonomia nie nadaje uprawnień — sub-agent i tak jest ograniczony przecięciem whitelisty rodzic∩sub.
- ⚠️ **`ChatModel.stream()` NIE concurrent-safe** (sesja 125) — sub-agenci muszą skipować cache. Patrz `SubAgentRunner._executeTool` przez MCPClient + `modules/models/modelResolver.js` skipCache logic.
- ⚠️ **`max_tokens` musi być explicit** w `streamToCompleteWithTools` options (sesja 125) — inaczej `to_openai()` nie wysyła do API → truncated odpowiedzi. Default w runnerze: `maxTokens: 16384`.
- ⚠️ **Limity iteracji/timeout/długości = `config/limits.js`** (E1.5, 2026-07-21; wartości zaktualizowane w F4, Froncie A i rundzie 2 — 2026-08-17) — JEDEN moduł. Dziś: `subagent_max_iterations_worker: 25` (F4: 8→12, runda 2: →25, sufit 100 — worker na żywym smoke zjadał 12/12 na sensownej robocie), `delegation_timeout_ms: 900000` (Front A: 120000→480000, runda 2: →900000, sufit 30 min — zegar ścienny to awaryjny sufit, głównym strażnikiem jest **watchdog ciszy** `subagent_stall_timeout_ms: 180000` przekazywany pętli jako `stallTimeoutMs`; do tego `subagent_salvage_max_chars: 12000` → `salvageMaxChars` — skrót dorobku przy padzie syntezy, oraz `subagent_result_max_chars: 60000` — sufit FINALNEGO wyniku suba przy doręczeniu do maina, 0 = bez limitu), `max_tool_result_length: 15000` (surowe zrzuty narzędzi SUBA — wynik suba dla maina ma własny, większy sufit), `subagent_prompt_max_chars: 24000` (F4), `delegation_context_max_chars: 48000` (F4). `subagent_max_iterations_strategist` nie istnieje od D18. `SubAgentRunner.runTask` czyta je przez `getLimits(this.plugin?.env?.settings)` — per-sub-agent config (`config.max_iterations` itd.) nadal wygrywa; getLimits daje default gdy config nie ma pola. **Fix E1.5 P4:** runtime fallback był `isStrategist ? 5 : 3` (badał researcher=3 wbrew factory role=8 i wbrew promptowi który mówił 8) — teraz spójny 8. User może nadpisać przez Settings → Limity.
- ⚠️ **Validation w `DelegateTool`**: empty task → reject (sesja 106) — wcześniej puste taski wisiały. Patrz `DelegateTool.js:84,98`.
- ✅ **`modelRole = 'researcher' | 'strategist'` w `DelegateTool.js`** — smoke-02 finding 06 zamknął LEGACY-1: DelegateTool nie tłumaczy już roli na `minion/master`, a `modelResolver` mapuje nowe nazwy do legacy slotów biblioteki modeli bez deprecation warning.
- ✅ **`tools_per_mode` SKASOWANY** (E1.6, 2026-07-21) — półumarły feature (ignorowany w runnerze, ale wciąż zapisywany przez Loader) usunięty w całości; już nie występuje w kodzie. Dawne znalezisko DEPR-2 zamknięte.
- ⚠️ **Rama suba = fabryka `framePrompt.js` (E2.8 B3), nie hardcode w runnerze.** Stały szkielet (nagłówek + „pull pamięć" + ZASADY) żyje w `DEFAULT_SUBAGENT_FRAME_PROMPT` z placeholderami; `_buildTaskPrompt` rozwiązuje go przez `resolveWorkPrompt(agent, 'subagent_frame_prompt', settings, factory)` (łańcuch agent>global>factory) i wstrzykuje mechaniczne sekcje (METHOD z `config.prompt`, SCOPE z `config.scope`, BUDŻET z limits). Treść nadal PL inline, ale **user-editowalna** globalnie (Settings→Prompt) i per agent rodzic — dawne znalezisko i18n-1 częściowo zamknięte tą drogą (nie przez template z `modules/prompts/`).

---

## TODO

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md) (znaleziska z sesji przenosin + Backlog v2).

Najważniejsze (Sprint 1 post-MAX):
- 🟠 **4 role rdzeniowe systemowe** (`prep-memory`, `prep-whitelist`, `strateg-planer`, `strateg-sumarizer`) — `MEMORY_v2 Blok 4`; Removed 2026-05-16 cleanup: `prep-archivist` -> `prep-memory`
- 🟠 **YAML schema custom sub-agentów** — whitelist tools (już jest) + whitelist scope (foldery + frontmatter + sekcje + pinned notes)
- 🟠 **Parallel execution** w `DelegateTool` — `args.tasks` już jest, doszlifować (per-task instance vs singleton)
- 🟠 **Hyperfocused per-akcja** + klikalność w chacie — `SUB_AGENTS_v2_PER_AKCJA.md` (Wizja Mapa-11)

---

## Powiązane

- `Tydzień MAX/Wizja/MEMORY_v2_RETRIEVAL_v2.md` — Blok 4 (multi-source retrieval, 4 role rdzeniowe systemowe)
- `Mapa/Wizje/INLINE_TRIGGERS_UI.md` — mechanizm klikalności (CM6 chip + popup `@` + force-delegate + intersection security)
- `Mapa/Wizje/SUB_AGENTS_v2_PER_AKCJA.md` — funkcjonalna wizja użycia hyperfocused (Mapa-11)
- `Mapa/Wizje/PROMPT_CACHING_v1.md` — sub-agenty mają osobne system prompty, cache prefix per sub-agent
- `modules/agent-loop/CLAUDE.md` — stamtąd przychodzi `runAgentLoop` (wspólna pętla tool-callingu z czatem, od E2.1; `streamToCompleteWithTools` w `modules/memory` zostało usunięte tym samym zadaniem)
- `modules/models/Nauka/Concurrent_safety_stream.md` — concurrent-safety lekcja (sesja 125)

## Czystka E3.6 update (2026-07-28) — jeden rodzaj suba też w UI („Sub-agent")

- **`SubAgentEditorModal` (shell) zunifikowany:** parametr `role` ignorowany (zawsze `researcher`),
  jeden tytuł „Nowy Sub-agent"/„Edytuj Sub-agenta", defaulty researcher-owe (tools search/read/list,
  min_iter 1, max_tool_result 15000 — pole widoczne zawsze), model z slotu sub-agentów.
  **Fabryka dead-code D7 (2026-09-02, AUD-dead-code-014/106/208):** parametr `role` wyciachnięty
  z sygnatury konstruktora (był `TS6133` — deklarowany, nigdy czytany, ciało wpisywało stałą
  `this.role = 'researcher'` na sztywno) razem z 4 wołaniami (`profile_team.ts`,
  `SubAgentDetailView.ts`, `SubAgentsBackstageTab.ts` ×2). Pole `this.role` ZOSTAJE — dalej
  zapisywane do YAML-a suba (linia z `formData.role`).
- **`SubAgentDetailView` + `SubAgentsBackstageTab`:** gałęzie `isStrategist` (korona/„ekspert") OUT,
  chipy filtrów ról (Miniony/Stratedzy) OUT, fallback iteracji 3/5 → realne 8. Stary sub z
  `role: strategist` renderuje się jak każdy inny; zapis przez edytor przepisuje rolę na `researcher`.
  **Fabryka dead-code D7:** `SubAgentDetailView` liczyła „Używany przez" też przez
  `a.getMinionNames?.()`/`a.getMasterNames?.()` (AUD-dead-code-084) — metody skasowane z klasy
  `Agent` w Sprincie 07, więc obie gałęzie były trwale `undefined`. Filtr dziś tylko
  `getAllSubAgentNames()` (pokrywa też zmigrowane wpisy legacy). Ten sam martwy wzorzec w
  `modules/ui-components/backstage_helpers.ts` — POZA zakresem tego zadania, inny wykonawca.
- i18n: legacy klucze modal.sub_agent `*_researcher`/`*_strategist` → wspólne `edit`/`new`/
  `name_placeholder`; skasowane martwe `filter_minions`/`filter_strategists`/`role_expert`.
- `ensureStarterSubAgents()` tworzy TYLKO pusty folder (opis „4 startery" wyżej w Public API był
  stale — od D18 plugin nie zasiewa żadnych subów; czystka user-side E3.6 się nie cofa sama).

## Historia

- **Sesja 45-46** — pierwszy unified delegation (role-based)
- **Sesja 83-86** — factory defaults (prep + strateg dla każdego agenta), unifikacja Minion/Master → SubAgent z auto-migration
- **Sesja 106** — validation empty task w DelegateTool
- **Sesja 125** — fix concurrent-safe + max_tokens forwarding + max_iterations 3→8 + max_tool_result_length 6000→15000 (researcher)
- **Sesja 128 D5** (2026-04-25) — placeholder rozbudowany do wzorca (zawierał ściemy: SUB_AGENT_ROLES export i import z modules/prompts — naprawione w Mapa-11)
- **Mapa-11** (2026-04-26) — przenosiny `src/core/SubAgent*.js` → `modules/sub-agents/`, `index.js` (2 re-exports), 10 znalezisk → TODO, 3 Nauka cards (Researcher_vs_Strategist + Tool_calling_loop + SUB_AGENT_yaml_KNOWLEDGE), Wizja SUB_AGENTS_v2_PER_AKCJA, commit `657553a`
- **E1.5 Kagańce** (2026-07-21) — `SubAgentRunner` czyta limity z `config/limits.js` (`getLimits`): iteracje worker 3→8 (fallback wyrównany z factory role + docs, P4), strategist 5, timeout delegacji 60000→120000 (P3), `max_tool_result_length` 15000. Usunięty lokalny `DEFAULT_MAX_TOOL_RESULT_LENGTH`. P5: researcher defaults w `_resolveToolNames` używają nazw Memory v3 (`memory_list_summaries`/`memory_read_summary`) zamiast deprecated `memory_sessions`/`memory_summaries`. Prompt BUDŻET (`_buildTaskPrompt`) pokazuje ten sam limit co runtime. +3 testy P5.
- **E1.6 docs-freshness** (2026-07-21) — `tools_per_mode` skasowany (gotcha zamknięta); struktura uzupełniona o `roles/` (4 role systemowe); LOC ~1,045 → ~1,310; ścieżki importerów `src/` → `modules/`. Kod runnera/loadera bez zmian.
- **E2.4 (D18/F6)** (2026-07-23) — **kasacja systemowego podziału research/strateg.** Usunięte: `roles/` (4 role + `loadSystemRoles`), migracje `prep-archivist→prep-memory` (Agent.js + `agent_migrations.js` + AgentLoader), `subagent_max_iterations_strategist`, wszystkie gałęzie `config.role === 'strategist'` (Runner/Loader/DelegateTool), `activeResearchers`/`activeStrategists`, `_injectBrainContext` (brain 12k push). **F6:** rola = etykieta opisowa. **1 generyczny worker** (`delegate` bez `aspect` → syntetyczny config workera, działa bez subów) + custom suby po nazwie. **Thin prompt** (metoda + pull do pamięci scope=memory zamiast pushu; `config.prompt` cap 6000). Jaskier (HumanVibe) i `AgentManager.createAgent` bez ról systemowych. UI (profile_team/triggers/PlaybookManager) bez `[SYSTEM]`/podziału. Testy przepisane. Część B (D14 drzewo decyzyjne + D17 skille) — osobny agent na tym branchu.
- **F1 „Przebudowa subagentów 2026"** (2026-08-15) — **SubTask jako byt + szyna zdarzeń.** Nowy pure
  `SubTaskRegistry.js` (id/status/kroki/wynik/budżet, zdarzenia `task:created`/`task:step`/`task:finished`,
  retencja 50 zakończonych × 500 kroków, maskowanie pól na wejściu, `dispose()`), eksport w barrelu
  (+ 5 typów). `SubAgentRunner.runTask` zakłada bieg (`create`), podaje pętli `traceFor(task)` zamiast
  `traceLog.scope(label)` i domyka go `finish`/`fail`; bez rejestru ścieżka jak dotąd. `src/main.js`
  stawia rejestr obok `traceLog` (`plugin.subTaskRegistry`) i sprząta go w `onunload` — tą samą drogą
  dostaje go harness (boot idzie przez `main.js`). **Zero zmian UX i zero zmian formatu trace.log** —
  plik jest teraz konsumentem zdarzeń, nie właścicielem śladu. +19 testów (14 rejestr, 5 runner).
- **F2 „delegacja w tle", FAZA A** (2026-08-15) — **rejestr uczy się pochodzenia, runner oddaje
  byt od ręki, dochodzi skrzynka wyników.** `SubTask` dostał opcjonalne `background?: boolean`
  + `origin?: {agentName, sessionPath?, tabKey?}` (rejestr przechowuje 1:1, NIE interpretuje).
  `runTask` zakłada byt na początku `try` (przed `_buildTaskPrompt`) i woła nowy hak
  `options.onTaskCreated(task)`; etykieta i licznik `_subCallSeq` NIETKNIĘTE. Nowy pure
  `SubTaskNotifier.js` — kolejka zakończonych biegów `background:true` z `setDeliverer`/`drain`
  (dostawcę podłącza dopiero FAZA B, czyli czat). Barrel + 2 typy więcej. +17 testów
  (9 notifier, 4 rejestr, 4 runner). Zmiana defaultu `delegate` na tło żyje w `modules/tools`.
- **F3 „panel biegów subów"** (2026-08-15) — **user widzi, co mieli w tle, i umie to ubić.**
  `SubTaskRegistry` dostał side-channel abortów (`attachAbort`/`requestStop`, mapa `_aborts`
  sprzątana przy `task:finished`/retencji/`dispose`) + opcjonalne pole karty `stopRequested`
  i nowy typ kroku `stop.requested`. `DelegateTool` wpina uchwyt w `onTaskCreated` na WSZYSTKICH
  trzech ścieżkach (dla single-taska blokującego hak został dodany właśnie po to). Nowy pure
  `subTaskPanelModel.js` (3 sekcje: W biegu / Wynik czeka na czat / Zakończone, bez duplikatów;
  czas trwania, kroki, `tool.post`, okno ≤20 kroków, skrót wyniku ≤500 znaków, `formatDuration`)
  + obsidian-free `SubTaskRunsView.js` (kryształ statusu z pulsem, guzik Stop, wiersz rozwijany).
  Shell rejestruje widok pod `sub-agent-runs`, dokłada wiersz na Home („Biegi subów" z licznikiem
  w biegu/czeka) i odświeża panel na zdarzeniach rejestru (debounce 200 ms, tylko gdy panel jest
  na wierzchu). +29 testów (8 rejestr, 3 DelegateTool, 16 model, 2 backstage_rows).
  ⚠️ **Panel w sidebarze ŻYŁ 1 DZIEŃ** — 2026-08-15 zastąpiony paskiem w oknie czatu
  (patrz ostatni wpis historii). Rejestr, aborty i `stopRequested` zostają bez zmian.
- **F5 „sterowanie i uczciwość"** (2026-08-15) — **sub mówi, jak zszedł, i da się do niego
  napisać w trakcie.** `runTask` zwraca `stoppedBy` + `failed` (nowe typy `SubRunResult` /
  `SubRunStoppedBy` w barrelu) — sposób zejścia przestał ginąć na granicy runnera (pin (b)
  audytu nocnego 19). `SubTaskRegistry` dostał drugi side-channel: `postMessage(id, text)` /
  `takeMessages(id)` (kolejka per bieg, sufit 10 z ODMOWĄ zamiast wypychania, maska na
  wejściu, nowy typ kroku `user.message {chars}`, sprzątanie przy `task:finished`/retencji/
  `dispose`). `runTask` podpina JEDEN hook pętli — `beforeContinue` — który zdejmuje kolejkę
  i dopisuje polecenie do transkryptu z ramką `subagent.steer_prefix` (pl+en). Panel biegów
  dostał guzik „Wiadomość" z rozwijanym polem (Enter wysyła, Escape chowa, bez modala).
  +10 testów (6 rejestr, 4 runner) + scenariusz harnessa `41_sub_uczciwosc`.
  ⚠️ **UI tego guzika ŻYŁO 1 DZIEŃ** — zdjęte decyzją Kuby 2026-08-15 (patrz niżej);
  mechanizm `postMessage`/`takeMessages`/`beforeContinue` i jego testy zostają.
- **Front B „szyba" (2026-08-17, inicjatywa „Suby: watchdog ciszy i szyba 2026")** — **pasek
  mówi CO KONKRETNIE sub robi i PO CO.** Zgłoszenie Kuby: „widać, że wykonuje toole, ale co
  dokładnie czyta? Nie wiadomo". Trzy zmiany:
  (1) `SubTask.taskPreview` — skrót zadania od maina (≤300 znaków, maskowany w `create`);
  runner podaje `taskPrompt`, panel pokazuje sekcję „Zadanie od agenta" nad krokami,
  a chip niesie skrót w `title`;
  (2) `StripStep.detail` — konkret kroku: dla `tool.pre` najistotniejszy argument
  (`path`/`query`/`folder`/`url`/… — `detailFromArgs`, zły JSON = przycięty surowiec,
  sufit 80 znaków), dla `tool.post` rozmiar wyniku (`4222 zn.`) albo `error`;
  (3) wynik w rozwinięciu dostał RAMKĘ (CSS `pkm-substrip__outcome` — border+tło; błąd
  w kolorze błędu), zadanie cytat z lewym akcentem (`pkm-substrip__task`).
- **Pasek biegów w oknie czatu** (2026-08-15) — **biegi wracają tam, skąd je zlecono.**
  Decyzja Kuby: suby lecą per agent i per sesja, więc podgląd należy do OKNA CZATU (pod
  paskiem zakładek), nie do globalnego sidebara; a wysyłanie wiadomości do suba to sprawa
  agenta, nie usera — z UI wyleciało (Stop zostaje). Zmiany: nowy pure `buildStripModel`
  (filtr `origin.tabKey`, fallback po agencie, kolejność w biegu → czeka na czat →
  zakończone z sufitem 10, skrót wyniku 400 znaków) + nowy widok `modules/chat/chat/
  subTaskStrip.ts` (chipy + jeden rozwinięty szczegół, Stop dla biegnących).
  **Skasowane:** `SubTaskRunsView.ts` (+ test szkiców), `buildPanelModel` z typami,
  rejestracja widoku `sub-agent-runs` i wiersz „Biegi subów" w shellu, klucze
  `sidebar.subruns.*` (nowe: `chat.substrip.*`). Testy modelu przepisane na pasek (11).
- **E2.8 (B3 + C1)** (2026-07-23) — **rama suba z resolvera + intersekcja po nowej osi narzędziowej.** Nowa fabryka `framePrompt.js` (`DEFAULT_SUBAGENT_FRAME_PROMPT`, pure/obsidian-free, eksport w barrelu). `_buildTaskPrompt` rozwiązuje szkielet łańcuchem `resolveWorkPrompt(agent, 'subagent_frame_prompt', settings, factory)` (nowe pole agenta `subagent_frame_prompt`) — user może przekształcić ramę globalnie (Settings→Prompt) lub per agent rodzic; mechaniczne sekcje (METHOD/SCOPE/BUDŻET) nadal składane w kodzie. `_getTools(toolNames, parentAgent)` liczy przecięcie z narzędziami rodzica przez **`toolRegistry.filterByAgent(parentAgent)`** (nowa oś `disabled_tools` z C1) zamiast dawnego `mcp_servers`/`permissions`; `DEFAULT_SUB_AGENT_TOOLS` + `config.tools` custom suba bez zmian. Kanał `runTask` i thin-model z E2.4 nietknięte.

## S27 update (2026-07-28) — pkm-sub, szablony subów, globalny sub

- **`PKM_SUB_NAME = 'pkm-sub'`** (`SubAgentLoader.js`, eksport w barrelu). Syntetyczny worker
  `delegate` BEZ `aspect` nazywa się teraz `pkm-sub` zamiast bezimiennego `worker`. Byt istnieje
  tylko w kodzie (nie na dysku), więc jest niezniszczalny bez żadnego mechanizmu ochrony.
  Grep przed renamem: ZERO twardych porównań `=== 'worker'` w produkcji (tylko asercje testów).
- **Nowy magazyn: `SubAgentTemplateStore.js`** (`.pkm-assistant/templates/sub-agents/<slug>/
  SUB_AGENT.yaml` + opcjonalny `KNOWLEDGE.md` + `version: N`). API jak w skillach.
  Owner = `AgentManager.subAgentTemplateStore`.
- **D3 „kopia, nie link":** `instantiate(slug, agentName, {subAgentLoader})` odlewa kopię pod
  nazwą `<agent-slug>-<slug szablonu>` (konwencja widoczności `getVisibleSubAgentsForAgent`),
  kolizja → sufiks `-2`. Kopia niesie `from_template: "<nazwa> vN"`; wersja szablonu NIE wchodzi
  do żywego YAML-a. `SubAgentLoader` czyta i zapisuje `from_template` (nowe pole przelotowe).
- **D2 — globalny sub:** `settings.pkmAssistant.globalSubTemplate` (slug szablonu albo `null`).
  To konfiguracja, której `DelegateTool` używa dla delegacji BEZ `aspect`, **dla wszystkich
  agentów**. `null` = fabryczny `pkm-sub` (zawsze dostępny jako odwrót). Wybór klika się na
  kartach zakładki „Szablony subów"; zawsze dokładnie jeden globalny. **Fail-soft:**
  brakujący / niekompletny / nieparsowalny szablon → `pkm-sub` + `log.warn`, delegacja nigdy
  nie pada przez złą decyzję usera. Szczegóły w `modules/tools/CLAUDE.md`.
- **Przecięcie narzędzi rodzic∩sub (`SubAgentRunner._getTools`) NIETKNIĘTE** — granica
  bezpieczeństwa zostaje bez zmian, także dla workera z szablonu.
- **Rama suba bez zmian:** dalej `resolveWorkPrompt(agent, 'subagent_frame_prompt', …)`,
  łańcuch agent > global > factory. Szablon NIE ma własnego pola ramy (świadomie).
  Guzik „Rama suba" w Zapleczu WYCIĘTY po smoke (decyzja Kuby 2026-07-28 — mylił ramę
  z szablonem/pkm-sub); rama edytowalna wyłącznie w Ustawieniach → Prompt.
- **UI:** `SubAgentsBackstageTab` pokazuje kartę `pkm-sub` (read-only) + karty szablonów;
  `SubAgentEditorModal` ma tryb `{template:true}` i checkbox `{alsoTemplate:true}`;
  `SubAgentDetailView` obsługuje `params.template` i pokazuje ślad `from_template`.

## E3.5 update (2026-07-29) — fabryczny szablon `researcher`

- `ensureFactoryTemplates()` (`modules/agents/factoryTemplates.js`, seed RAZ przez marker
  `.factory-seeded-v1`) dokłada do magazynu szablonów fabrycznego **`researcher`**:
  `tools: [search, list, read, web_search, web_read]`, `max_iterations: 12` (deep research
  potrzebuje więcej niż default workera 8), `max_tool_result_length: 15000`, KNOWLEDGE
  z ostrym promptem jakości (dosłowne cytaty + URL/wikilink przy każdym; format odpowiedzi
  USTALENIA/LUKI/ŹRÓDŁA; „lepiej nie znalazłem niż zmyślona pewność"). Treść w i18n
  (`factory.template.researcher.*`).
- Odlew per agent = `<agent-slug>-researcher` (standardowe `instantiate`). Przepisy skilli
  deep-research delegują `aspect:"researcher"` — fuzzy match (`endsWith('-researcher')`)
  trafia odlew; brak odlewu → przepis każe powtórzyć bez `aspect` (jedzie `pkm-sub`).
  Kasacja szablonu przez usera SZANOWANA (nie wraca po restarcie).
- Jeden szablon obsługuje OBA tryby researchu (web+vault) — skrzynka pełna, przecięcie
  rodzic∩sub i tak tnie (agent bez web = sub bez web_search).

## F4 „model policy v2" (2026-08-15) — para explorer/worker + budżety zamiast capów

**Rama suba czyta budżety, nie hardcody.** `_buildTaskPrompt` bierze cap instrukcji custom
suba (`config.prompt` z KNOWLEDGE.md) z `config/limits.js` — `subagent_prompt_max_chars`,
default **24000** (było na sztywno 6000). Nota o obcięciu podaje realną liczbę. Limity są
czytane RAZ na budowę promptu i ten sam obiekt karmi cap ORAZ blok BUDŻET, więc prompt nie
może obiecać modelowi innej liczby iteracji niż ta, którą dostanie pętla (pilnuje tego test).

**Nowe wartości domyślne** (wszystkie zmienialne w Ustawieniach → Limity):

| Limit | Było | Jest | Po co |
|---|---|---|---|
| `subagent_max_iterations_worker` | 8 | **12** | worker klasy rodzica robi zadania z zapisem i syntezą, nie sam zwiad (fabryczny szablon `researcher` od E3.5 i tak podnosił sobie 12 własnym polem) |
| `subagent_prompt_max_chars` | — (hardcode 6000) | **24000** | instrukcja to karma dla modelu, nie wynik narzędzia; cap zostaje, przestaje być tajemnicą kodu |
| `delegation_context_max_chars` | — (hardcode 16000 w `DelegateTool`) | **48000** | najważniejszy kanał „rodzic wie coś, czego sub nie wyszuka"; 16k było ciasne dla okien 128k+ |

**Drabinka modelu suba (F4).** Decyduje JEDNO pole — `config.role`:

- `role: 'worker'` → `createModelForRole(plugin, 'sub_worker', …)` = **model rodzica**
  (ta sama drabinka co main: `agent.models` → `agent.model` → biblioteka → legacy), zawsze
  świeża instancja. Dotyczy wbudowanego `aspect:"worker"` **i** custom suba, który ma
  `role: worker` w `SUB_AGENT.yaml`.
- wszystko inne (brak roli, `researcher`, `explorer`, dowolna etykieta) → dotychczasowy slot
  sub-agentów (`researcher`→`minion`). **Zero zmian dla `pkm-sub`, szablonów i istniejących YAML-i.**
- `config.model` z YAML wygrywa w OBU przypadkach — rozstrzyga to `createModelForRole`.

⚠️ **Rola przestała być czysto opisową etykietą (korekta F6).** Od F4 jedna jej wartość —
`worker` — steruje wyborem modelu. Reszta pól (narzędzia, prompt, limity) nadal nie zależy
od roli. Kto pisze migrację ról, musi o tym wiedzieć.

Same wbudowane aspekty (`pkm-explorer` / `pkm-worker`) żyją w `modules/tools/DelegateTool.ts` —
nie mają plików na dysku, nie przechodzą przez `SubAgentLoader` i nie są nazwami z tego modułu.
Szczegóły: `modules/tools/CLAUDE.md`.

## K11 update (2026-08-22) — whitelista wołającego jedzie piętro niżej

Naprawa AUD-security-072 (razem z 008 po stronie `modules/tools`).

- ⚠️ **`_getTools(toolNames, parentAgent, callerToolNames)` ma TRZY składniki przecięcia.**
  Na piętrze >1 `parentAgent` to nadal agent GŁÓWNY (sub chodzi pod jego tożsamością), więc
  `filterByAgent` nie chroni: read-only sub z `tools: [read, delegate]` wystawiał wnukowi pełną
  listę 23 narzędzi agenta przez `delegate {aspect:"worker"}`. Trzeci składnik to whitelista
  suba ZLECAJĄCEGO — `RunOptions.callerToolNames`, podawana przez `DelegateTool` ze znacznika
  `_invocationToolNames`.
- ⚠️ **`_executeTool` przekazuje własną whitelistę suba dalej do `MCPClient`**
  (`callerToolNames: [...allowedToolNames]`) — to ona staje się znacznikiem dla delegacji piętro
  niżej. Lista jest już przecięciem rodzic∩sub, więc łańcuch może się tylko zwężać.
- ⚠️ **`RunOptions.scopeFolders` przychodzi już PO przecięciu** z zakresem wołającego (liczy je
  `DelegateTool` przez `AccessGuard.intersectScopeFolders`). Runner go nie interpretuje na ścieżce
  z `MCPClient` — jak dotąd niesie 1:1 dalej, egzekwuje go `PermissionSystem.checkPermission` po
  drugiej stronie. Zakresy rozłączne kończą się odmową delegacji, więc runner nigdy nie dostaje
  pustej listy „na wszelki wypadek". **Wyjątek F2.13 (release 2.2.0/W3):** na ścieżce fallback
  BEZ `MCPClient` (`_executeTool`, `SubAgentRunner.ts:647-651`) runner NIE umie wyegzekwować
  `scopeFolders` — ta ścieżka woła `tool.execute()` wprost i omija `PermissionSystem` w całości.
  Zamiast fail-open (cicho rozszerzyć suba z „konkretne foldery" na „cały vault"), niepusty
  `scopeFolders` na tej ścieżce = odmowa wykonania KAŻDEGO narzędzia (`subagent.tool_scope_unenforceable`).
  Brak `scopeFolders` w `execOptions` przechodzi bez zmian (dawne zachowanie, testy whitelisty).

## K3-E update (2026-08-23) - zapis i kasowanie meldują STAN, nie zamiar

Naprawa AUD-bledy-010/012.

- ⚠️ **Pusta instrukcja KASUJE `KNOWLEDGE.md`** (`SubAgentLoader.saveSubAgent` i
  `SubAgentTemplateStore._write`). Dawne `if (data.prompt)` zostawiało starą treść na dysku:
  cache mówił "pusto", user dostawał "zapisany", a `loadAllSubAgents()` po restarcie wstrzykiwał
  subowi SKASOWANĄ metodę (a szablon niósł metodę z poprzedniej wersji). Próg jest ten sam co
  przy odczycie - `prompt.trim()`, bo `_loadSubAgentFromFolder` i cache i tak trymują.
- ⚠️ **`deleteSubAgent`/`store.delete` zwracają `false` i TĘ wartość trzeba przeczytać.**
  Decyzja o komunikacie mieszka w czystym `deleteOutcome.ts` (`resolveDeleteOutcome`): tylko
  `true` znaczy "Usunięto", cokolwiek innego (w tym `undefined` z opcjonalnego łańcucha) to
  `modal.sub_agent.delete_failed` - modal zostaje otwarty, kafel Zaplecza nie znika. `rmdir` jest
  NIEREKURENCYJNE, więc jeden dodatkowy plik w folderze suba wystarczy, żeby kasowanie padło.

## K3-L update (2026-08-23) - „Użyj u agenta" i padnięty bieg suba meldują STAN

Naprawa AUD-bledy-014/011.

- ⚠️ **Handler kafla Zaplecza NIE MOŻE zniknąć po cichu** (AUD-bledy-014).
  `renderUseAtAgentButton` (`ui-components/backstage_helpers.ts`) woła `onPick(agent.name)`
  i PORZUCA zwróconą obietnicę, a `useTemplateAtAgent` robi dwa zapisy pod rząd
  (`store.instantiate` → kopia suba na dysku, `agentManager.updateAgent` → przypisanie).
  Rzut z drugiego zostawiał **półstan**: kopia `<agent>-<szablon>` w `.pkm-assistant/sub-agents/`
  bez wpisu w `sub_agents`, zero `Notice`, zero `nav.refresh()` - a ponowne kliknięcie odlewało
  DRUGĄ kopię z sufiksem `-2`. Bezpiecznik: czysty `templateUseOutcome.ts` (`guardTemplateUse`)
  - ten sam wzór co `deleteOutcome.ts`, zero DOM/obsidian/i18n, oddaje klucz `backstage.template_use_failed`
  + surowy rzut do `log.error`. ⚠️ Pas bezpieczeństwa w SAMYM `renderUseAtAgentButton`
  (`Promise.resolve(onPick(...)).catch(...)`) **nie został dołożony** - to plik innego modułu,
  więc każdy nowy handler kafla musi sam się owinąć.
- ⚠️ **`subagent_error` ma TEN SAM kształt bloku co `subagent_call`** (AUD-bledy-011): te same
  pola nagłówka (`role`/`prompt`/`result`/`duration_ms`), status niesie treść `result` - a jest
  nią **to samo zdanie `subagent.error`, które dostaje agent zlecający** (plik sesji i wołacz
  mówią jedno). Odczyt tego bloku zależy od mapowania typu w `roleFromEvent`
  (`modules/memory/activeSessionFormat.ts`) - do naprawy mapowania nie było, więc parser POMIJAŁ
  cały blok i padnięty bieg znikał z odtworzonej sesji, z konsolidacji i (przez
  `archiveActiveSession`) z dysku. **Nowy typ zdarzenia biegu = wpis w `roleFromEvent`**,
  inaczej zapis jest tylko iluzją. Szczegóły: `modules/memory/CLAUDE.md` gotcha 11.

## Fabryka wydajność W9 update (2026-09-02) — AUD-wydajnosc-098: transkrypt suba bez base64

- ⚠️ **`asTranscript` w `_executeTool` tnie base64 z wyniku `generate_image` PRZED
  `JSON.stringify`.** `GenerateImageTool` zwraca w sukcesie pełny base64 zapisanego obrazu (obok
  `path`/`note_path` — obraz JEST już w vaulcie, base64 służy TYLKO ścieżce czatu z modelem
  vision, `chat_streaming.ts:975`). Do tej naprawy transkrypt suba go NIE wycinał, w
  odróżnieniu od czatu (`delete copy.base64`) — medianowy obraz realny (~594 000 znaków
  base64, dane z `Attachments/generated`) zjadał 99% sufitu `max_tool_result_length` transkryptu
  suba (domyślnie 15000 — `config/limits.ts`), wypychając `format`/`revised_prompt`/`message`
  poza limit, i był budowany od nowa (`JSON.stringify`) przy KAŻDEJ kolejnej iteracji pętli.
  Helper `stripImageBase64ForTranscript(toolName, result)` — nowy top-level w
  `SubAgentRunner.ts` — działa WYŁĄCZNIE na `generate_image` z niepustym `base64` (inne
  narzędzia, błędy, `generate_image` bez base64 przechodzą bez zmian); zamiast base64 dokłada
  jednolinijkową adnotację rozmiaru (`[image ~N kB — ...]`, wzór `normalizeMcpResult` w
  `modules/tools/ExternalMcpManager.ts`). Wpięty w JEDNYM miejscu (`asTranscript`), więc
  obejmuje OBIE ścieżki egzekucji (`MCPClient` i fallback bez klienta). **Dokładasz narzędzie,
  które zwraca duży binarny payload w wyniku (base64/podobne)?** Ten sam wzorzec — filtr po
  `toolName` w `asTranscript`, nie osobna kopia w `GenerateImageTool.ts` (jedno miejsce decyzji,
  jak K8 dla maskowania błędów). Naprawa i testy: `modules/tools/CLAUDE.md` sekcja „Fabryka
  wydajność W9".
