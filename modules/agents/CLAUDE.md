# modules/agents/

**Infrastruktura agentów.** `AgentManager` (CRUD per agent, profil, przełączanie aktywnego agenta), `AgentLoader` (ładowanie z vault + wbudowanego agenta), `AgentProfileView` (panel profilu, 8 zakładek), `toolAxis.ts` (jedna oś narzędziowa `disabled_tools`).

**Agent = Persona (osobowość) + Umiejętności (skille + konektory) + Uprawnienia + Ekipa (suby) + Pamięć.** Sterowanie wbudowanymi narzędziami idzie przez negatywną oś `disabled_tools`, nie przez `enabled_tools`/`permissions`; `mcp_servers[]` jest dodatkowym opt-inem wyłącznie dla serwerów userowych.

**W kodzie pluginu jest tylko jeden wbudowany agent: Jaskier** (systemowy agent onboardingowy, `archetypes/HumanVibe.ts` / `createJaskier`). Pozostali agenci to agenci użytkownika (własne pliki YAML) i żyją poza kodem pluginu. Plugin daje im runtime + UI do produkcji.

Kod fizycznie w `modules/agents/`. Pomocnicze modale (Delete/Presentation/SendTo/AgentSidebar) są w `modules/shell/`.

---

## Co tu jest

```
modules/agents/
├── Agent.ts                        # base klasa Agent (disabled_tools + language/default_autonomy/*_prompt/memory_rescue)
├── AgentLoader.ts                  # load wbudowanego agenta + scan vault YAML (+ zapis po migracji osi narzędziowej)
├── AgentManager.ts                 # CRUD, switch active, lifecycle, _buildBaseContext
├── accessPolicy.ts                 # migracja polityki dostępu (focus_folders/guidance_mode)
├── renameAgentFlow.ts              # dyskowa logika zmiany nazwy agenta (kolizja/YAML/folder pamięci), czysta (zero obsidian), testowalna; renameAgentOnDisk() wołane z AgentManager.renameAgent
├── renameAgentFlow.test.ts
├── toolAxis.ts                     # JEDNA oś: BUILTIN_TOOL_GROUPS + disabled_tools + migracja + etykiety (pure, testowalny) + helpery przełączników uprawnień (eksportowane też z barrela)
├── toolAxis.test.ts
├── permission_switches.test.ts
├── VaultMap.ts                     # globalna mapa vaulta (klasa) + migracja legacy ścieżki pliku
├── VaultMap.test.ts
├── AgentProfileView.ts             # hub panelu - 8 zakładek
├── MigrationModal.ts               # migracja Memory v2→v3 + starego komunikatora → Komunikator; WEWNĘTRZNY (nie w barrelu), jedyny wołacz to AgentManager
├── migrationReviewFlow.ts          # czysta logika decyzji modala migracji (testowalna bez obsidiana); Cancel/X = zero migracji, migracja wraca przy następnym starcie
├── migrationReviewFlow.test.ts
├── factoryTemplates.ts             # seeduje fabryczne szablony (sub-agent + skille Deep Research); pure, DI, testowalny
├── factoryTemplates.test.ts
├── agent_yaml_roundtrip.test.ts
├── AgentAccessPolicy.test.ts
├── archetypes/
│   ├── HumanVibe.ts                # config Jaskra (HUMAN_VIBE_CONFIG) - config wbudowanego agenta, nie osobny byt-archetyp
│   └── index.ts                    # barrel: createJaskier
├── profile/                        # 8 zakładek panelu + helpery
│   ├── HiddenFileEditorModal.ts
│   ├── profile_overview.ts         # Przegląd (hero: nazwa/opis inline, kryształ+kolor, statsy)
│   ├── profile_persona.ts          # Persona (jedno okienko: personality)
│   ├── profile_skills.ts           # Umiejętności (skille per kategoria + badge dodatki + konektory)
│   ├── profile_skills_overrides.ts # override'y skilli per agent
│   ├── profile_permissions.ts      # Uprawnienia (jedna oś narzędziowa + miejsce pracy + kiedy pyta)
│   ├── profile_team.ts             # Ekipa (kafelki subów, edycja przez SubAgentEditorModal)
│   ├── profile_memory.ts           # Pamięć (Brain notatki + Na teraz + Sesje + Streszczenia; Memory v3)
│   ├── profile_prompt.ts           # Prompt (Inspektor + Edytor: rdzeń CORE_RULES + prompty robocze)
│   ├── profile_advanced.ts         # Zaawansowane (model / temperatura / język / automaty pamięci / akcje serwisowe) + handleSave
│   ├── profile_artifacts.ts
│   ├── profile_helpers.ts          # renderShard, openHiddenFile, renderToggle
│   ├── modelFieldSync.ts           # kanon `models.main` (patrz „Rozstrzyganie modelu" niżej)
│   ├── modelFieldSync.test.ts
│   ├── modelFieldSync.wiring.test.ts
│   ├── startPromptGenerator.ts     # generator promptu startowego (pure: buildStartPrompt + TONE_OPTIONS)
│   ├── startPromptGenerator.test.ts
│   └── StartPromptGeneratorModal.ts
├── index.ts                        # Public API barrel
└── CLAUDE.md
```

⚠️ **`AgentManager.ts` jest monolitem >1000 linii.** Świadomie nierozbity; zmiana w nim wymaga przeczytania całości przed edycją.

**Pomocnicze modale ZOSTAJĄ w `modules/shell/`:**
- `AgentDeleteModal.ts` (guard Jaskra - nie da się go usunąć)
- `AgentPresentationModal.ts`
- `SendToAgentModal.ts`
- `AgentSidebar.ts` + `AgentSidebar.css`
- `SubAgentEditorModal.ts` mieszka w `modules/sub-agents/` - zakładka Ekipa bierze go leniwym `loadSubAgentEditorModal()` z barrela subów (kierunek zależności agents→sub-agents, w dół, legalny)
- `MigrationModal.ts` mieszka TUTAJ (nie w shell) - jedyny wołacz to `AgentManager`

---

## Public API (`modules/agents/index.ts`)

| Eksport | Rola |
|---|---|
| `Agent` | Base klasa. Pola: `disabled_tools[]` (jedna oś wbudowanych narzędzi), `mcp_servers[]` (opt-in serwerów userowych), `access_policy_version`, `admin_access`, `language` (`'auto'`/`'pl'`/`'en'`), `default_autonomy`, `compression_prompt`/`save_session_prompt`/`archive_prompt`/`summary_prompt`/`subagent_frame_prompt` (puste = resolver global/factory), `memory_rescue`, `komunikator_visible`. Pola-widma (`archetype`/`role`/`persona_drift`/`can_message`/`playbook_overrides`/`enabled_tools`/`type`/`minion*`/`master*`/`default_mode`/`sub_agent_enabled`) są celowo czytane ze starych YAML-i i ignorowane - nie sterują niczym; silnik nie robi generycznego passthrough nieznanych pól (patrz „Kluczowe decyzje"). |
| `AgentManager` | CRUD + switch active + owner loaderów/magazynów szablonów + bramka widoczności komunikatora + `getInboxPing`. |
| `PERMISSION_PRESET_SWITCHES`, `isPermissionSwitchOn`, `applyPermissionSwitch`, `applyPermissionPreset` | Cztery pure helpery osi uprawnień z `toolAxis.ts`, w barrelu bo konsument (popover uprawnień w czacie) jest poza modułem. Mapują cztery etykiety („Odczyt notatek"/„Modyfikacja notatek"/„Tworzenie plików"/„Usuwanie plików") i trzy presety (Bezpieczny/Standard/Pełny) na `disabled_tools` - jedyną oś, którą ktokolwiek egzekwuje. |
| `renderAgentProfileView(container, plugin, nav, params)` | Hub `profile_*` (panel, 8 zakładek). |
| `resolveMainModelForForm` | Kanon „model główny" (`agent.models.main`, legacy `agent.model` gaśnie po migracji) - dla czytelników poza modułem (`modules/shell/AgentPresentationModal.ts`). |

Reszta wewnętrznych symboli (loadery, `VaultMap`, fabryki szablonów, archetypy, `HiddenFileEditorModal`...) świadomie NIE jest w barrelu - zero konsumentów spoza modułu. Definicje żyją w bebechach: `AgentManager` instancjuje `AgentLoader`/`VaultMap`, woła `ensureFactoryTemplates()` w `initialize()`, `AgentLoader` woła `createJaskier()`, `HiddenFileEditorModal` otwiera `profile_helpers.openHiddenFile`. Chcesz coś z tej listy na zewnątrz? Dopisz eksport razem z realnym konsumentem.

**Oś narzędziowa (`toolAxis.ts`, import wewnątrz-modułowy):** `BUILTIN_TOOL_GROUPS`, `ALL_BUILTIN_TOOLS`, `DEFAULT_DISABLED_GROUPS`, `defaultDisabledTools`, `computeDisabledToolsFromLegacy` (migracja), `normalizeDisabledTools`, `hasLegacyToolAxis`, `getPermissionToolLabel`/`getGroupLabel`.

> Uwaga nazewnicza: `getPermissionToolLabel` (tu, czyta `tools.label.*`, przestrzeń osi uprawnień) i `getToolCallLabel` w `modules/ui-components/ToolCallDisplay.ts` (etykieta chipa tool-calla, i18n `tool.*`) to dwie różne funkcje o podobnej nazwie - nie mylić.

---

## Model osobowości agenta

Agent to 5 filarów, każdy = zakładka panelu:

| Filar | Zakładka | Co to |
|---|---|---|
| **Persona** | Persona | `personality` (jedno pole tekstowe), czytane wprost - bez mechanizmu dryfu w czasie. |
| **Umiejętności** | Umiejętności | skille (przepisy, per kategoria) + konektory (userowe serwery MCP przypięte) |
| **Uprawnienia** | Uprawnienia | jedna oś `disabled_tools` (co może) + miejsce pracy (`guidance_mode`/focus) + kiedy pyta (autonomia + approval per-tool) |
| **Ekipa** | Ekipa | custom sub-agenci (rola = etykieta); edycja przez `SubAgentEditorModal` |
| **Pamięć** | Pamięć | Memory v3: brain notatki + Na teraz + sesje + streszczenia |

Archetyp i Rola nie istnieją jako osobne byty - nie sterują niczym, nawet jeśli stare YAML-e wciąż niosą te pola.

---

## Zależności

**Importuje z:**
- `core` (Logger, AccessGuard, i18n, sanitizePath)
- `modules/prompts/` (PromptBuilder dla system prompta)
- `modules/memory/` (AgentMemory per agent)
- `modules/skills/` (SkillLoader per agent)
- `modules/tools/` (`ToolRegistry.filterByAgent` po osi `disabled_tools`)
- `modules/sub-agents/` (nowy agent dostaje jeden `<slug>-prep` sub-agent przez `createPrepSubAgent`)
- `obsidian` (Vault.adapter dla scan agentów)

**Importowany przez:**
- `main.ts` (rejestracja, restore active agent)
- `ChatView` (active agent dispatch)
- Większość MCP tools (np. `memory_save` dostaje nazwę agenta)
- `KomunikatorManager` (otrzymuje `agentManager` w konstruktorze dla emit `communicator:project_updated`)

---

## Kluczowe decyzje

- **Tylko Jaskier jest wbudowany.** Onboarding wymaga, żeby nowy user od razu dostał gotowego agenta; reszta agentów to produktywność usera. Trzyma plugin szczupłym.
- **Panel = 8 zakładek `AgentProfileView`.** Przegląd / Persona / Umiejętności / Ekipa / Uprawnienia / Pamięć / Prompt / Zaawansowane. Guzik „+" tworzy agenta od razu (czysta kartka) i otwiera panel w normalnym trybie edycji - nie ma osobnego trybu tworzenia.
- **`AgentLoader` skanuje `.pkm-assistant/agents/*.yaml`.** Scan na starcie + watch (live update przy edycji YAML z zewnątrz). Przy pierwszym załadowaniu starego YAML-a migruje oś narzędziową (`computeDisabledToolsFromLegacy`) i zapisuje `disabled_tools` raz.
- **Persona to jedno pole.** `personality` czytane wprost, bez mechanizmu dryfu w czasie.
- **Jedna oś narzędziowa (`toolAxis.ts`).** `disabled_tools` to negatywna lista; grupy wbudowane opisane jako manifesty; migracja `computeDisabledToolsFromLegacy` ze starych `mcp_servers`×`enabled_tools`×`permissions`. `DEFAULT_PERMISSIONS` ma dziś tylko 2 żywe pola (`memory`+`guidance_mode`) - reszta jest odfiltrowywana. Grupa `artifacts` (`artifact_create/read/update/list` + `todo`) jest domyślnie wyłączona, ale `DEFAULT_ENABLED_EXCEPTIONS = ['todo']` odfiltrowuje z niej `todo` - świeży agent ma więc `todo` włączone (pisze tylko do ukrytego magazynu pluginu), a `artifact_*` wyłączone konserwatywnie (piszą widoczne notatki).
- **`AgentManager` owneruje dwa magazyny szablonów** (`skillTemplateStore`, `subAgentTemplateStore`), ładowane równolegle w `initialize()`. Przypięcie szablonu do agenta (skill albo sub-agent, „+ z szablonu" w profilu) zawsze tworzy NIEZALEŻNĄ kopię - edycja szablonu w magazynie nie zmienia bytów już odlanych u agentów, którzy z niego skorzystali.
- **Silnik nie robi generycznego passthrough nieznanych pól YAML.** Pola świadomie skasowanych bytów (`can_message`, `playbook_overrides`, `archetype`/`role`, `enabled_tools`, `type`, `minion*`/`master*`, `persona_drift`, `default_mode`, `sub_agent_enabled`...) są celowo czytane-i-porzucane albo usuwane w migracji, nie zachowywane jako „extra". Generyczne „zachowaj wszystko nieznane" wskrzesiłoby je z każdego starego YAML-a, który jeszcze je niesie - sprzeczne z kontraktem pól-widm. Nowe pole = jawna gałąź w konstruktorze/serialize/allowedFields, ze strażnikiem testowym, jak każde inne.
- **Prompty robocze idą przez resolver.** `save_session_prompt`/`archive_prompt`/`summary_prompt`/`compression_prompt`/`subagent_frame_prompt` mają domyślnie `''` - konsument rozstrzyga agent→global→factory. Świeży agent ma więc działającą ścieżkę LLM od razu (np. `/save session`), bez pustych promptów.

### Polityka dostępu (`accessPolicy.ts`, `access_policy_version`)

- `Agent` niesie `access_policy_version` (aktualnie `2`) i `admin_access` (boolean, domyślnie `false`; serializowany tylko gdy `true`). Przełącznik jest w profilu → Zaawansowane → Dostęp administracyjny → Totalna wolność, z ostrzeżeniem o możliwym uszkodzeniu konfiguracji i wycieku danych.
- `accessPolicy.ts` robi jednorazową migrację starszych profili: puste `focus_folders` dostają `guidance_mode:true` (bo wcześniej efektywnie widziały cały vault). Od wersji 2 tryb przypisany + pusta lista znaczy zero dostępu.
- Jaskier ma jawne `access_policy_version:2` i `guidance_mode:true`, ale `admin_access` zostaje OFF - admina włącza user konkretnemu agentowi ręcznie.
- `mcp_servers[]` jest jedynym realnym opt-inem serwerów userowych per agent.
- Zakładka Uprawnienia pokazuje światła ryzyka: toggle są tylko dla żółtych; czerwone (nadpisanie, delete, wysyłka, zewnętrzny serwer) nie mają wyłącznika w UI.

### Rozstrzyganie modelu (`models.main`)

Kanon to `agent.models.main`; legacy top-level `agent.model` istnieje wyłącznie dla wstecznej kompatybilności i nigdy nie jest kopiowany z powrotem z `models.main`.

- `modelFieldSync.ts` (`resolveMainModelForForm`/`applyMainModelChange`) jest jedynym miejscem, które wolno mu ruszać w warstwie UI: gdy `models.main` istnieje, select go pokazuje i `model` zostaje nietknięty; gdy jest tylko legacy `model` (bez `models.main`), jednorazowa migracja przenosi wartość i gasi `model` (`null`) - trafia na dysk przy najbliższym zapisie profilu.
- `Agent._modelFromSource` bramkuje `serialize()`: legacy `model:` jest pisane do YAML-a tylko wtedy, gdy wartość faktycznie przyszła z zewnątrz (konstruktor czytający YAML z dysku, albo `update()` z jawnym kluczem `model`) - nie przy każdym truthy `this.model`. Bezpośrednie przypisanie `agent.model = x` z pominięciem `update()` nie ustawia flagi i `serialize()` takiej wartości nie wypisze.
- `modules/models/modelResolver.ts` (Step 4b) zna oba pola dla roli `main`; dla ról sub (researcher/strategist) próbuje najpierw legacy `agent.model`, potem znormalizowany `agent.models.main` jako ostatnią deskę ratunku - `models` nie importuje z `agents` (odwrotny kierunek by się zapętlił), więc normalizacja `{platform,model}`→`"platforma/model"` jest lokalną kopią w `modelResolver.ts`, nie importem współdzielonego helpera.
- `Agent._normalizeModelOverrides` kopiuje legacy `models.minion`→`researcher` i `models.master`→`strategist` i kasuje stare klucze - żywy most dla starego YAML-a, wołany w konstruktorze i `update()`.

### Zapis nadpisań wbudowanego agenta (`AgentLoader.saveBuiltInOverrides`)

Zapis do `<nazwa>_overrides.yaml` jest **diffem** względem fabrycznej konfiguracji agenta, nie pełną serializacją - inaczej każdy zapis profilu (dowolnej zakładki) dopisywałby do pliku całą konfigurację, nawet pola nietknięte przez usera.

- `diffAgentConfig(current, baseline)` (pure, deep-equal order-independent dla obiektów / order-sensitive dla tablic) zostawia tylko klucze różne od baseline'u. Odczyt (`_mergeBuiltInOverrides` → `agent.update(data)` na świeżej instancji) jest z natury kompatybilny - pominięte pole zostaje na wartości fabrycznej.
- `ALWAYS_WRITTEN_META_FIELDS` (dziś: `access_policy_version`) omijają diff i są dopisywane zawsze - bo `Agent.serialize()` pisze je bezwarunkowo z bieżącą wartością, więc baseline i agent mają zawsze tę samą wartość i diff by je wyciął jako „bez zmiany"; bez tej listy plik nadpisań nigdy nie niósłby wersji polityki dostępu, a każdy load próbowałby migrować ją od nowa.
- `BUILT_IN_BASELINES: Record<string, () => Agent>` (dziś: `{ Jaskier: createJaskier }`) mapuje nazwę wbudowanego agenta na jego fabrykę - diff liczy się względem WŁASNEGO baseline'u agenta, nie jednego hardcode'owanego. Wbudowany agent bez wpisu w rejestrze dostaje fallback na pełny `serialize()` (bez diffowania) + ostrzeżenie w logu - bezpieczniej niż zgadywać cudzy baseline. Dopisz nowego wbudowanego agenta do tego rejestru razem z jego fabryką.

### Zmiana nazwy agenta (`AgentManager.renameAgent`)

`renameAgent(oldName, newName)` jest jedynym właścicielem operacji; dyskowa logika (kolizja/kopiowanie/zapis/rollback) żyje w czystym `renameAgentFlow.ts` (`renameAgentOnDisk`, zero `obsidian`, testowalny w izolacji - `AgentManager.ts` importuje `Notice` i transytywnie ciągnie `obsidian`, więc test runnera go nie wstawia).

- **Kolizja = twarda odmowa, zero zapisu.** Nazwa zajęta w pamięci (wbudowany LUB custom agent) albo plik/folder pamięci pod nowym slugiem już istnieje na dysku (nawet po dawno skasowanym agencie) - obie sprawdzane, obie blokują.
- **Zmiana wyłącznie wielkości liter** (slug się nie zmienia) jest osobną gałęzią: zapis YAML pod niezmienioną ścieżką, zero ruszania folderu pamięci, zero sprawdzania kolizji - inaczej `newFilePath`/`newMemoryDir` wyszłyby identyczne ze starymi i kolizja fałszywie odmawiałaby własnego pliku.
- **Fail-closed na błędach dysku.** Pad sprawdzenia `exists()` (dysk niedostępny, timeout) na pliku YAML lub folderze pamięci = twarda odmowa, nie ciche przepuszczenie.
- **Folder pamięci i skrzynka komunikatora** przenoszą się create-before-delete (kopia → kasacja starego), przed zapisem YAML-a; pad kopiowania przerywa cały rename, agent/dysk/mapy zostają nietknięte. Przenosiny skrzynki są best-effort po potwierdzonym sukcesie YAML+pamięci - pad nie cofa rename'u (agent i pamięć są już bezpieczne), zwrotka niesie `inboxMoveFailed: true`.
- **Po sukcesie:** przekluczowanie map runtime (`agents`/`agentMemories`) + reinicjalizacja `AgentMemory` pod nowym kluczem + event `agent:renamed` (dziś bez konsumentów).
- **Świadomie nie przenosi się:** prefiksy sub-agentów (`<agent>-<slug>` w Ekipie zostają „stare"), reguły „Zawsze zezwalaj" w `ApprovalManager` (kluczowane starą nazwą), zakładki otwarte w czacie (trzymają starą nazwę do ręcznego odświeżenia).
- `updateAgent(name, updates)` wydziela `updates.name` przed resztą pól: gdy nazwa się zmienia, najpierw woła `renameAgent` - odmowa/pad przerywa cały zapis (żadne inne pole z tego samego „Zapisz profil" też nie ląduje), nie tylko pomija `name`.

---

## Gotchas

- ⚠️ **Jaskier nie może być usunięty** (systemowy). UI ukrywa „delete agent" dla niego.
- ⚠️ **`AgentLoader` watch może triggerować podwójne load** - jest debounce, ale uważaj przy zmianach w tej ścieżce.
- ⚠️ **`activeAgent` w `agentManager` musi być persistowany** - restart Obsidiana = restore z `data.json`.
- ⚠️ **Sub-agents 20 max per agent** - nie zmieniaj bez powodu (UI nie skaluje się dobrze powyżej).
- ⚠️ **`AgentManager.dispose()` musi być wołane przy demontażu pluginu.** `AgentLoader.watchAgents` wiesza trzy nasłuchy na vaulcie (`modify`/`create`/`delete`) poza `plugin.registerEvent`; jeśli uchwyt `_unwatchAgents` nie ma wołacza, po `onunload` każdy zapis YAML-a agenta odpala `reload()` → `initialize()` martwej instancji, która dopisuje pliki do vaulta i emituje `agents:reloaded`. Wołacz stoi w `main.ts:onunload`; dokładasz nowy nasłuch w managerze → odpinasz go w `dispose()`.
- ⚠️ **Konstruktor `AgentManager` woła `komunikatorManager?.attachVaultEvents?.(...)` zaraz PO utworzeniu `komunikatorManager`, zanim cokolwiek inne go dotknie.** Kesz nagłówków skrzynki w `KomunikatorManager` widzi tylko mutacje przez metody managera - zapisy z zewnątrz (proces piszący wprost na dysk, synchronizacja, `git pull`) go omijają. `KomunikatorManager` sam nie ma dostępu do `plugin.registerEvent` (potrzebnego do sprzątania nasłuchu przy unload) - `AgentManager` jest jedynym miejscem w łańcuchu konstrukcji, które go ma. Bez `this.plugin` (np. testy konstruujące `AgentManager` bez pełnego pluginu) `attachVaultEvents` dostaje `undefined` i po prostu nie podpina zewnętrznego sprzątania - TTL wewnętrzny w `KomunikatorManager` zostaje jedyną siatką. Nie przenoś tego wołania przed przypisanie `this.komunikatorManager` - trafiłoby w `undefined`.
- ⚠️ **Kontekst pamięci w prompcie ma jedno ogrodzenie, nie dwa.** Sekcja `memory` idzie przez `addDynamicSection` → `fenceUntrusted` → `<vault_content source="memory">`, które escapuje treść - nie da się zamknąć go od środka. Nie owijaj tego dodatkowym ręcznym markerem tekstowym (`---`/`===`) - to tworzy drugi, podrabialny płot wewnątrz prawdziwego, dokładnie ten kształt, którym złośliwy ładunek w danych vaulta mógłby udawać koniec sekcji pamięci.
- ⚠️ **Prompt tury jest budowany dla PODANEGO agenta, nie dla `activeAgent` w locie.** `getActiveSystemPromptWithMemory(context, agent?)` przyjmuje agenta drugim argumentem; czat go podaje zawsze (właściciel tury zamrożony przed pierwszym awaitem). Budowa promptu potrafi trwać sekundy (pamięć, mapa vaulta, ping skrzynki) - w tym oknie user może przełączyć zakładkę czatu i przestawić `activeAgent`; bez tego parametru tura zaczęta u agenta A kończyłaby się promptem złożonym częściowo z persony/pamięci agenta B. W środku wszystkie odczyty idą przez lokalny `target`, nie `this.activeAgent` - łącznie z pamięcią adresowaną po nazwie (`getAgentMemory(target.name)`), fail-closed zamiast `getActiveMemory()`. Wyjątek: `getVaultMapDescriptions()` jest globalne (jedna mapa vaulta na plugin) i celowo nie zależy od agenta - bramkuje je `target.focusFolders`.
- ⚠️ **Lista agentów wstrzykiwana do promptu (`agentList`) idzie przez `listKomunikatorAgents()`, nie `getAllAgents()`.** Blok komunikacji w prompcie jest bramkowany po `kom_send`/`agent_delegate`; bez tego filtra agent z `komunikator_visible:false` pokazywałby swoją nazwę i opis każdemu agentowi z pocztą, mimo że wysyłka do niego i tak się odbija.
- ⚠️ **Przełącznik uprawnień w popoverze: stan mieszany = OFF.** Przełącznik świeci tylko wtedy, gdy żadne z jego narzędzi nie jest wyłączone (np. `search` wyłączony w profilu → „Odczyt notatek" pokazuje OFF, mimo że reszta grupy jest ON) - UI nie ma prawa obiecywać więcej, niż agent faktycznie ma.
- ⚠️ **Popover uprawnień musi zapisywać przez `agentManager.updateAgent`, nigdy bezpośrednio przez loader.** `AgentLoader.saveAgent` ma guard: dla wbudowanego agenta zapis idzie zawsze do `<nazwa>_overrides.yaml`, niezależnie od wołacza - pisanie wprost do `<nazwa>.yaml` dla wbudowanego agenta tworzy plik, który loader odfiltrowuje przy starcie (custom agent o nazwie wbudowanego), więc ustawienie znika po restarcie bez ostrzeżenia.
- ⚠️ **Przełącznik „Narzędzia MCP" nie istnieje w presetach uprawnień.** Dostęp do serwera zewnętrznego to opt-in per serwer (`mcp_servers[]`, zakładka Umiejętności → Konektory) - jeden globalny boolean nie miałby czego włączać.

---

## TODO

- 🟡 Per-agent kolejność w `AgentSidebar` - sortowanie/grupowanie.

## Powiązane

- `modules/sub-agents/CLAUDE.md` - agenci dziedziczą konfigurację sub-agents
- `modules/memory/CLAUDE.md` - każdy agent ma swój `AgentMemory`
- `modules/komunikator/CLAUDE.md` - widoczność agenta w komunikatorze, kesz nagłówków skrzynki
