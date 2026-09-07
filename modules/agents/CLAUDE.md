# modules/agents/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Infrastruktura agentów.** AgentManager (CRUD per agent, profil, switch active), AgentLoader (ładowanie z vault + built-in), `AgentProfileView` (panel v3 — 8 zakładek), `toolAxis.js` (jedna oś narzędziowa `disabled_tools`).

**Agent v3 (E2.8):** agent = **Persona (osobowość) + Umiejętności (skille+konektory) + Uprawnienia + Ekipa (suby) + Pamięć**. **Archetyp i Rola PRZESTAŁY ISTNIEĆ jako byty** (S17/D7) — pola `archetype`/`role` czytane ze starych YAML-i, ale IGNOROWANE (nie sterują niczym). `personaDrift` skasowany (uśpiony mechanizm bez writerów). Sterowanie built-inami = negatywna oś `disabled_tools`, nie `enabled_tools`/`permissions`; `mcp_servers[]` jest dodatkowym opt-inem wyłącznie dla serwerów userowych.

**WAŻNE:** **W kodzie pluginu jest TYLKO Jaskier** (hardcoded systemowy onboarding agent, `HumanVibe.js` / `createJaskier`). Pozostali agenci to agenci użytkownika (własne pliki YAML w `.pkm-assistant/agents/`) i żyją TYLKO w vaulcie usera. Plugin daje runtime + UI do produkcji agentów.

**Status:** 🚀 **ACTIVE** (Mapa-13, 2026-04-26; przebudowa v3 w E2.8, 2026-07-23). Kod fizycznie w `modules/agents/`. Pomocnicze modale (Delete/Presentation/SendTo/AgentSidebar) są w `modules/shell/`.

**Sprint Refaktoru — który mnie dotyka:**
- ✅ [Sprint 04 MCP_PORZADEK_v1](../../Refaktor/Sprinty/SPRINT_04_MCP_Porzadek_v1.md) **DONE (2026-04-28)** — Z4 dodał DWA NOWE FIELD'y do agent.yaml schema:
  - `mcp_servers: string[]` — server-level whitelist (default `['vault','memory','core']`, '*' = wildcard, [] = tylko core). `ToolRegistry.filterByAgent()` filtruje tools.
  - `can_message: string[]` — incoming message whitelist (default `['*']`, lub konkretni agenci). `AgentMessageTool` blokuje send jeśli sender NIE w whitelist.
  - YAML schema validation w `core/utils/yamlParser.js`. UI w `profile_skills.js` MCP sub-tab — checkboxy per server (built-in + user) + can_message wybór agentów. Migration: agenci bez field auto-default `['vault','memory','core']` (security-first decyzja Kuby).
  - Backend: Codex (`afe7e21`), UI: Claude (`1da8739`).
- ✅ [Sprint 07 Archetypes & Roles v2](../../Refaktor/Sprinty/SPRINT_07_Archetypes_Roles_v2.md) **DONE (2026-04-29)** — 4 archetypy v2 (`glowny_asystent`/`orkiestrator`/`specjalista`/`singleton`) + user-defined Roles registry YAML + Personality jako ton/charakter + MCP servers per role + migracja legacy `minion/master` do `sub_agents` + watchAgents hot reload + AgentCreatorModal stub wywalony + workMode DI fix. Testy 176/176, build 8.2MB.
- ✅ [Sprint 08 Komunikator v2 + Agora wywałka](../../Refaktor/Sprinty/SPRINT_08_Komunikator_v2_Agora_Wywalka.md) **DONE (2026-04-30)** — Z1: globalny `VaultMap` (klasa, migracja `.pkm-assistant/agora/vault_map.md` → `.pkm-assistant/agents/vault_map.md`). Z2: `PromptContextBuilder.js` slim project-only (Profile + Activity wycofane z hot path decyzją Mapa-3.5). AgentManager jest nowym ownerem kontekstu promptu, deleguje do PromptContextBuilder. Po Z7 wywałce Agory `KomunikatorManager` jest jedynym project hub'em (fallback do legacy agora wycofany). Tests 190/190, build 8.1MB.
- ✅ [Sprint 10 Settings v2 + Backstage v2](../../Refaktor/Sprinty/SPRINT_10_Settings_v2_Backstage_v2.md) **DONE (2026-05-02 + hotfix)** — `modules/agents/SettingsContent.js` renderuje sekcję Agenci/Role; `SettingsSection.js` rejestruje realny render. `RoleEditorModal` zostaje w shell jako modal. Z10: `profile/profile_skills.js` częściowy split.
- ✅ [Sprint 12 Skiny pluginu](../../Refaktor/Sprinty/SPRINT_12_Skiny_Pluginu.md) — migracja crystal/avatar/color callsite'ow na SkinManager API.

**Historyczny backlog:** `Wizje/ARCHETYPES_ROLES_v2.md` — nieaktualny. Zamiast redesignu hierarchii archetyp/rola, E2.8 (D7/S17) **skasował oba byty** — pozostała czysta separacja Persona + Uprawnienia (oś narzędziowa) + Ekipa + Pamięć.

---

## Co tu jest (po E2.8)

```
modules/agents/
├── Agent.js                        # base klasa Agent v3 (disabled_tools + language/default_autonomy/*_prompt/memory_rescue)
├── AgentLoader.js                  # load built-in + scan vault YAML (+ zapis po migracji osi narzędziowej)
├── AgentManager.js                 # CRUD, switch active, lifecycle, _buildBaseContext (był w src/core/)
├── renameAgentFlow.js              # K19 — logika dyskowa zmiany nazwy agenta (kolizja/YAML/folder pamięci), czysty (zero obsidian), testowalny; renameAgentOnDisk() wołane z AgentManager.renameAgent
├── renameAgentFlow.test.js
├── toolAxis.js                     # E2.8 C1 — JEDNA oś: BUILTIN_TOOL_GROUPS + disabled_tools + migracja + etykiety (pure, testowalny) + K3 helpery przełączników uprawnień (eksportowane też z barrela)
├── toolAxis.test.js
├── VaultMap.js                     # S08 — global vault map (klasa) + migracja legacy agora path
├── AgentProfileView.js             # hub v3 — 8 zakładek (był w src/views/sidebar/)
├── MigrationModal.js               # S31 — migracja Memory v2→v3 + Agora→Komunikator; WEWNĘTRZNY (nie w barrelu), jedyny wołacz to AgentManager
├── migrationReviewFlow.js          # D7 2026-08-27 — czysta logika decyzji modala migracji (testowalna bez obsidiana); Cancel/X = ZERO migracji (fallback usunięty), migracja wraca przy następnym starcie
├── archetypes/
│   ├── HumanVibe.js                # Jaskier config (HUMAN_VIBE_CONFIG) — to config wbudowanego agenta, NIE archetyp
│   └── index.js                    # barrel: createJaskier + HUMAN_VIBE_CONFIG
├── profile/                        # 8 zakładek panelu v3 + helpery
│   ├── HiddenFileEditorModal.js    # E2.8 A4 — wyodrębniony z zombie AgentProfileModal
│   ├── profile_overview.js         # Przegląd (hero: nazwa/opis inline, kryształ+kolor, statsy; BEZ badge archetypu)
│   ├── profile_persona.js          # Persona (jedno okienko: personality)
│   ├── profile_skills.js           # Umiejętności (skille per kategoria + badge 📎 dodatki + konektory)
│   ├── profile_skills_overrides.js # override'y skilli per agent
│   ├── profile_permissions.js      # Uprawnienia (3 sekcje na jednej osi narzędziowej + miejsce pracy + kiedy pyta)
│   ├── profile_team.js             # Ekipa (kafelki subów, edycja na cały sidebar przez SubAgentEditorModal)
│   ├── profile_memory.js           # Pamięć (Brain notatki + Na teraz + Sesje + Streszczenia; zgodne z Memory v3)
│   ├── profile_prompt.js           # Prompt (Inspektor + Edytor: rdzeń CORE_RULES + prompty robocze)
│   ├── profile_advanced.js         # Zaawansowane (model / temperatura / język / automaty pamięci / akcje serwisowe) + handleSave
│   └── profile_helpers.js          # renderShard, openHiddenFile, renderToggle
├── index.js                        # Public API barrel
└── CLAUDE.md
```

**Razem (policzone 2026-07-30):** 23 pliki produkcji, **6,254 LOC** + 4 pliki testów, **353 LOC**. (Po E2.8 skasowane: `AgentProfileModal.js` (765 LOC, zombie), `archetypes/v2/*` + `Archetypes.js` + `AIExpert.js`/`ObsidianExpert.js`, `roles/*`, `SettingsContent.js`/`SettingsSection.js`, `profile_skills_picker.js`/`profile_skills_playbook.js`; `savePrompts.js` przeniesiony do `modules/memory/workPrompts.js`.)

⚠️ **Monolit >800 LOC** (stan 2026-07-30): `AgentManager.js` — 1058 linii. Świadomie nierozbity; zmiana w nim = przeczytaj całość przed edycją.

**Pomocnicze modale ZOSTAJĄ w `modules/shell/`** (⚠️ `MigrationModal.js` **już nie** — od S31 mieszka tutaj, bo wołał go wyłącznie `AgentManager`; to była statyczna krawędź agents→shell w cyklu):
- `AgentDeleteModal.js` (E2.8: guard Jaskra)
- `AgentPresentationModal.js`
- `SendToAgentModal.js`
- ~~`SubAgentEditorModal.js`~~ — **S31: mieszka w `modules/sub-agents/`.** Zakładka Ekipa bierze go
  leniwym `loadSubAgentEditorModal()` z barrela subów (agents→sub-agents to kierunek w dół, legalny)
- `AgentSidebar.js` + `AgentSidebar.css`

---

## Public API (`modules/agents/index.js`) — 8 eksportów (zmierzone 2026-08-27 z bloków `export { ... } from` w index.ts, bez `export type`)

| Eksport | Rola |
|---|---|
| `Agent` | Base klasa v3. Pola E2.8+: `disabled_tools[]` (jedna oś built-in), `mcp_servers[]` (opt-in serwerów userowych), `access_policy_version`, `admin_access`, `language` ('auto'/'pl'/'en'), `default_autonomy`, `compression_prompt`/`save_session_prompt`/`archive_prompt`/`summary_prompt`/`subagent_frame_prompt` (puste = resolver global/factory), `memory_rescue`, `komunikator_visible`. Pola-widma (`archetype`/`role`/`persona_drift`/6 martwych permissions) czytane i ignorowane. |
| `AgentManager` | CRUD + switch active + owner loaderów/magazynów szablonów + bramka widoczności komunikatora + `getInboxPing`. |
| `PERMISSION_PRESET_SWITCHES`, `isPermissionSwitchOn`, `applyPermissionSwitch`, `applyPermissionPreset` | K3 (2026-08-22): 4 pure helpery osi uprawnień z `toolAxis.js`, w barrelu bo konsument (popover uprawnień w czacie) jest POZA modułem. Mapują cztery etykiety („Odczyt notatek"/„Modyfikacja notatek"/„Tworzenie plików"/„Usuwanie plików") i trzy presety (Bezpieczny/Standard/Pełny) na `disabled_tools` — jedyną oś, którą ktokolwiek egzekwuje. Patrz sekcja „K3 update" niżej. **`PERMISSION_SWITCH_TOOLS` (piąty, dawny) skasowany z barrela AUD-dead-code-066 (2026-09-02)** — konsument (`chat_popovers.ts`) bierze tylko te cztery; stała zostaje `export`owana wewnątrz `toolAxis.js` dla `permission_switches.test.ts`. |
| `renderAgentProfileView(container, plugin, nav, params)` | Hub `profile_*` (panel v3, 8 zakładek). |
| `resolveMainModelForForm` | B6-2 (2026-09-02): kanon „model główny" (`agent.models.main`, legacy `agent.model` gaśnie po migracji) — dla czytelników poza modułem (`modules/shell/AgentPresentationModal.ts`). |

> **S30 Z4 — 16 eksportów WYCIĘTYCH z barrela** (zero konsumentów spoza modułu, weryfikacja
> grepem po całym repo): `DEFAULT_PERMISSIONS`, `SUB_AGENT_ROLES`, `MAX_SUB_AGENTS`,
> `createAgentManager`, `AgentLoader`, `VaultMap`/`VAULT_MAP_PATH`/`LEGACY_VAULT_MAP_PATH`/
> `starterVaultMap`, `createJaskier`, `HUMAN_VIBE_CONFIG`, `HiddenFileEditorModal`,
> `ensureFactoryTemplates`/`getFactorySkillTemplates`/`getFactorySubAgentTemplates`/
> `FACTORY_TEMPLATES_MARKER`.
> **Definicje ŻYJĄ w bebechach** — `AgentManager` instancjuje `AgentLoader`/`VaultMap`,
> woła `ensureFactoryTemplates()` w `initialize()`, `AgentLoader` woła `createJaskier()`,
> a `HiddenFileEditorModal` otwiera `profile_helpers.openHiddenFile`. Wcześniejsza nota
> w `modules/shell/CLAUDE.md` („shell importuje HiddenFileEditorModal z agents") była
> **nieprawdziwa** — grep nie znalazł ani jednego takiego importu.
> Chcesz coś z tej listy na zewnątrz? Dopisz eksport razem z realnym konsumentem.
>
> **AUD-dead-code D2 (2026-09-02) — cztery z tej listy przestały „żyć w bebechach", bo ktoś je
> naprawdę skasował:** `createAgentManager` (zero wołaczy w CAŁYM repo, nie tylko poza barrelem —
> `src/main.ts` buduje managera przez `new AgentManager(...)`), `SUB_AGENT_ROLES` (Agent.ts —
> zero konsumentów, migracja legacy `minion`/`master` w `AgentLoader` wpisuje literały `'researcher'`/
> `'strategist'` z palca, nie przez tę stałą), `starterVaultMap` (zdjęty tylko `export` — funkcja
> zostaje, używana wewnątrz `VaultMap.ts`), `HUMAN_VIBE_CONFIG` (zdjęty tylko `export` w
> `archetypes/HumanVibe.ts` — konsument, `createJaskier`, jest w tym samym pliku). Reszta 12
> symboli z listy wyżej nietknięta.

> **E2.8: usunięte z barrela wcześniej** (byty skasowane) — wszystkie eksporty archetypów (`ARCHETYPES`/`getArchetype*`/`normalizeArchetypeId`/`ARCHETYPE_*`/`OLD_*`), ról (`RoleLoader`/`BUILT_IN_ROLES`/`getBuiltInRole*`), `getHumanVibeDefaults`, `OBSIDIAN_EXPERT_CONFIG`/`getObsidianExpertDefaults`, `AI_EXPERT_CONFIG`/`getAIExpertDefaults`, `AgentProfileModal`/`openAgentProfile`. Nie importuj ich — nie istnieją. **S28:** `buildPromptContext`/`buildSubAgentContext` skasowane razem z `PromptContextBuilder.js`.

**Oś narzędziowa (`toolAxis.js`, import wewnątrz-modułowy `./` — nie w barrelu):** `BUILTIN_TOOL_GROUPS`, `ALL_BUILTIN_TOOLS`, `DEFAULT_DISABLED_GROUPS`, `defaultDisabledTools`, `computeDisabledToolsFromLegacy` (migracja), `normalizeDisabledTools`, `hasLegacyToolAxis`, `getPermissionToolLabel`/`getGroupLabel`. (`TOOL_TO_GROUP`/`isBuiltinTool` skasowane AUD-dead-code-065, 2026-09-02 — zero konsumentów.)

> **S30 Z3 rename:** `getToolLabel` → **`getPermissionToolLabel`**. Powód: pod tą samą nazwą żyła
> druga funkcja o INNEJ semantyce — `getToolCallLabel` w `modules/ui-components/ToolCallDisplay.js`
> (etykieta chipa tool-calla, przestrzeń i18n `tool.*`). Tutejsza czyta `tools.label.*` (oś uprawnień).
> Żadna z nich nie jest w barrelu, więc rename nie dotknął `index.js`.

---

## Model osobowości agenta v3 (E2.8)

Archetyp i Rola SKASOWANE (D7/S17). Agent to 5 filarów, każdy = zakładka panelu:

| Filar | Zakładka | Co to |
|---|---|---|
| **Persona** | Persona | `personality` (jedno pole tekstowe). Drift skasowany — czytane wprost. |
| **Umiejętności** | Umiejętności | skille (przepisy, per kategoria) + konektory (userowe serwery MCP przypięte) |
| **Uprawnienia** | Uprawnienia | jedna oś `disabled_tools` (co może) + miejsce pracy (`guidance_mode`/focus) + kiedy pyta (autonomia + approval per-tool) |
| **Ekipa** | Ekipa | custom suby (F6: rola = etykieta); edycja przez `SubAgentEditorModal` |
| **Pamięć** | Pamięć | Memory v3: brain notatki + Na teraz + sesje + streszczenia |

---

## Zależności

**Importuje z:**
- `core` (Logger, AccessGuard, i18n, sanitizePath)
- `modules/prompts/` (PromptBuilder dla system prompta)
- `modules/memory/` (AgentMemory per agent)
- `modules/skills/` (SkillLoader per agent)
- `modules/tools/` (`ToolRegistry.filterByAgent` po osi `disabled_tools`)
- `modules/sub-agents/` (E2.4: brak ról systemowych — nowy agent dostaje jeden `<slug>-prep` przez `createPrepSubAgent`, nie prep+strateg)
- `obsidian` (Vault.adapter dla scan agentów)

**Importowany przez:**
- `main.js` (rejestracja, restore active agent)
- `ChatView` (active agent dispatch)
- Większość MCP tools (np. memory_save dostaje agent name)
- `KomunikatorManager` (otrzymuje `agentManager` w constructorze dla emit `communicator:project_updated`, S08 hotfix)

---

## Kluczowe decyzje

- **Tylko Jaskier hardcoded** (sesja 47-54): onboarding wymaga że nowy user dostaje gotowego agenta. Reszta agentów = produktywność user'a, w vaulcie. Keeps plugin slim.
- **Panel v3 = 8 zakładek `AgentProfileView`** (E2.8): Przegląd / Persona / Umiejętności / Ekipa / Uprawnienia / Pamięć / Prompt / Zaawansowane. `AgentProfileModal` (stary modal, 9 zakładek, sesja 107) był zombie (0 wołaczy) — SKASOWANY w A4. **Create-mode OUT (C2):** guzik „+" tworzy agenta od razu (czysta kartka S8) i otwiera panel w normalnym trybie edycji.
- **AgentLoader ścieżka skanowania** (sesja 84): `.pkm-assistant/agents/*.yaml`. Scan na startup + watch (live update jak user edytuje YAML). E2.8: przy pierwszym load starego YAML-a migruje oś narzędziową (`computeDisabledToolsFromLegacy`) i zapisuje `disabled_tools` raz.
- **Persona = jedno pole** (E2.8 A4): `personality` czytane wprost. Drift (plan Sprint 2) skasowany jako uśpiony mechanizm bez writerów; zamysł spisany w `Nauka/2026-07-23_sesja_projektowa_E2.8.md` (S7).

---

## Gotchas

- ⚠️ **Jaskier nie może być usunięty** (systemowy). UI ukrywa "delete agent" dla Jaskra.
- ⚠️ **`AgentLoader` watch może triggerować podwójne load** — sesja 84 dodała debounce, ale uważaj.
- ⚠️ **`activeAgent` w `agentManager` musi być persistowany** — restart Obsidiana = restore z `data.json`.
- ⚠️ **Sub-agents 20 max per agent** — nie zmieniaj bez powodu (UI nie skaluje się dobrze powyżej).
- ⚠️ **`AgentManager.dispose()` MUSI być wołane przy demontażu pluginu** (AUD-bledy-035). `AgentLoader.watchAgents` wiesza trzy nasłuchy na vaulcie (`modify`/`create`/`delete`) POZA `plugin.registerEvent`, a uchwyt `_unwatchAgents` nie miał do tej pory ani jednego wołacza: po `onunload` każdy zapis yamla agenta odpalał `reload()` → `initialize()` MARTWEJ instancji, która dopisuje pliki do vaulta (starter playbooki, wbudowane typy artefaktów, folder skrzynki) i emituje `agents:reloaded`. Wołacz stoi w `src/main.ts:onunload`; dokładasz nowy nasłuch w managerze → odpinasz go w `dispose()`.
- ⚠️ **W8 follow-up (2026-09-02, AUD-wydajnosc-028/058/101): konstruktor woła
  `this.komunikatorManager?.attachVaultEvents?.(this.plugin?.registerEvent ? (ref) =>
  this.plugin.registerEvent(ref) : undefined)` zaraz PO utworzeniu `komunikatorManager`.**
  Powód: kesz nagłówków skrzynki w `KomunikatorManager` (patrz `modules/komunikator/CLAUDE.md`)
  widzi tylko mutacje przez metody managera — zapisy Z ZEWNĄTRZ (sesja Claude Code piszącą
  wprost na dysk, sync Google Drive, `obsidian-git pull`) go omijają. `KomunikatorManager` sam
  NIE MA dostępu do `plugin.registerEvent` (Obsidian `Component`, potrzebny do właściwego
  sprzątania nasłuchu przy unload) — `AgentManager` jest jedynym miejscem w tej linii
  konstrukcji, które go ma. Wzorem `VaultIndexer._registerHooks`
  (`modules/embedding/VaultIndexer.ts`). Bez `this.plugin` (np. testy konstruujące
  `AgentManager` bez pełnego pluginu) `attachVaultEvents` dostaje `undefined` zamiast
  callbacku i po prostu nie podpina zewnętrznego sprzątania — TTL w `KomunikatorManager`
  (5s) zostaje jedyną siatką. **Nie przenoś tego wołania przed `this.komunikatorManager =
  ...`** — trafiłoby w `undefined` (guardowane `?.`, więc nie wybuchnie, ale nasłuch nigdy
  by nie ruszył). Strażnik: `AgentManager.test.ts` (test po źródle — plik importuje
  `obsidian`, AVA go nie wstawi jako klasy).

---

## TODO

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md)

- ✅ **Persona drift** — ODRZUCONE w E2.8 A4 (uśpiony mechanizm bez writerów, skasowany; zamysł w Nauka/2026-07-23).
- ✅ **Modal tworzenia custom sub-agentów** — ZROBIONE: zakładka Ekipa (`profile_team.js` + `SubAgentEditorModal`, E2.8 C6).
- 🟡 **Per-agent kolejność w `AgentSidebar`** — sortowanie/grupowanie (post-MAX).

## Powiązane

- `Tydzień MAX/Wizja/MEMORY_v2_RETRIEVAL_v2.md` — Blok 2 (persona drift), Blok 4 (4 role rdzeniowe sub-agentów + custom modal)
- `modules/sub-agents/CLAUDE.md` — agenci dziedziczą sub-agents config
- `modules/memory/CLAUDE.md` — każdy agent ma swój AgentMemory

## Historia

- **Sesja 22** — pierwszy AgentProfileView (8 zakładek)
- **Sesja 47-54** — Crystal Soul v2 + tylko Jaskier hardcoded
- **Sesja 84-86** — Sub-agents factory defaults
- **Sesja 107** — Modularyzacja AgentProfileView (9 submodułów)
- **Sesja 119** — Tola pattern (specialist + 2 sub-agenty + 3 skille)
- **Sesja 128 D6** (2026-04-25) — placeholder rozbudowany do wzorca
- **Mapa-13 (2026-04-26)** — przenosiny modułu z 4 lokalizacji `src/` do `modules/agents/` (23 pliki, ~6,000 LOC). Public API barrel z 25 eksportami. 6 importerów zewnętrznych + reverse dep w PromptBuilder zaktualizowane. 10 znalezisk w TODO (5×🟠 incl. backward compat balast minions/masters ~100 LOC + Tryby v1-v2 dead path). 3 atomic Nauka cards w Hogwarcie. **NOWA Wizja `ARCHETYPES_ROLES_v2.md`** — fundamentalny redesign hierarchii (archetype = bucket uprawnień + Singleton, role = user-defined zawód+narzędzia framework, personality = czysto charakter, MCP→Role binding przez `manifest.decision_tree_inject`). Sync z Wizją `MCP_PORZADEK_v1.md` Kuby. Build 8.1MB, testy 58/58 PASS, commit `f89ede5`.
- **Sprint 04 Z4 (2026-04-28)** — dodano `mcp_servers[]` + `can_message[]` field'y do `Agent.js` schema (Codex `afe7e21` backend) + UI w `profile_skills.js` MCP sub-tab + i18n PL/EN entries (`profile.skills.mcp_whitelist_*` + `profile.skills.can_message_*`) + AgentProfileModal formData + create/update handlers (Claude `1da8739`). YAML schema validation w `core/utils/yamlParser.js` (Codex). Migration: agenci bez field auto-default `['vault','memory','core']` (security-first). Daje infrastrukturę dla S07 ARCHETYPES_ROLES_v2.
- **E1.6 docs-freshness** (2026-07-21) — struktura zsynchronizowana ze stanem na dysku: dopisane `agent_migrations.js`, `archetypes/v2/*` (realne implementacje 4 archetypów z S07), `archetypes/savePrompts.js`, split `profile_skills` → `_picker`/`_overrides`/`_playbook` (usunięto zdezaktualizowaną notkę „815 LOC MONOLIT"). Liczby (**historyczne, stan na 2026-07-21**): 23 plików/~6,000 LOC → ~37 plików/~8,100 LOC — nieaktualne, E2.8 skasowało pół modułu; **stan bieżący na 2026-07-30: 23 pliki produkcji / 6,254 LOC** (patrz „Co tu jest"). **Uwaga:** `minion`/`master` NIE są martwe — żyją jako legacy aliasy (mapowane na researcher/strategist w `modelResolver`); brak osobnych „minion/master DetailViews" (`shell/sidebar/DetailViews.js` jest ogólny). E1.6 nie zmieniało kodu tego modułu.
- **E2.3 (K4/K5)** (2026-07-22) — model kontroli: tryby pracy i YOLO out. `Agent.default_mode` USUNIĘTE — constructor ignoruje pole (stare YAML-e nie wybuchają), `serialize()` go pomija, brak w `allowedFields`/`update()`; shard „domyślny tryb pracy" (`profile_advanced.js`) + `AgentProfileView` formData + i18n `profile.default_mode`/`profile.advanced.mode_*` out. `agent.permissions.yolo_mode` już wcześniej ignorowane (część A E2.3) — „nie pytaj" to teraz tryb autonomii per-czat (`ChatView.currentAutonomy`), nie uprawnienie ani property agenta. `context.workMode` (martwa zmienna w `_buildBaseContext`) + Prompt Inspector `extraContext.workMode` (`profile_prompt.js`) out.
- **E2.8 „Agenci v3"** (2026-07-23, fazy A-D) — **archetyp + rola + personaDrift + can_message SKASOWANE jako byty** (pola czytane, ignorowane; wzór F6). Kasacje plików: `AgentProfileModal.js` (765 LOC zombie → `HiddenFileEditorModal` wyodrębniony do `profile/`), `archetypes/v2/*` + `Archetypes.js` + `AIExpert.js`/`ObsidianExpert.js` (+ martwe fabryki `createNika`/`createBorys`), `roles/*` (BuiltInRoles/RoleLoader), `SettingsContent.js`+`SettingsSection.js` (sekcja Settings „Agenci/Role" out), `profile_skills_picker.js`+`profile_skills_playbook.js` (Playbook Builder). `savePrompts.js` → `modules/memory/workPrompts.js`.
  - **A5/C1 — jedna oś narzędziowa.** Nowy `toolAxis.js` (`disabled_tools` = negatywna lista; grupy built-in = manifesty; migracja `computeDisabledToolsFromLegacy` ze starych `mcp_servers`×`enabled_tools`×`permissions`; etykiety i18n). `DEFAULT_PERMISSIONS` z 14 → 2 pól (`memory`+`guidance_mode`); pozostałe (6 widm A5 + 6 osi-akcji C1) filtrowane przez `_normalizePermissions`. `AgentManager.filterByAgent`/`_buildBaseContext` niosą `availableToolNames`.
  - **A6 — pola per-agent:** `language` (auto/pl/en → reguła językowa w PromptBuilder), `default_autonomy` (`chat_model._getDefaultAutonomy(agent)`), ochrona Jaskra ×3 (`deleteAgent` throw + `HomeView` kosz ukryty + `AgentDeleteModal` disabled), higiena `focus_folders` (odfiltrowanie `.pkm-assistant`).
  - **B3 — prompty robocze przez resolver.** `save_session_prompt`/`archive_prompt`/`summary_prompt`/`compression_prompt`/`subagent_frame_prompt` (default '' = resolver agent>global>factory u konsumenta). Świeży agent ma działającą ścieżkę LLM przy `/save session` (factory fallback).
  - **C — panel v3 przebudowany:** `AgentProfileView` 8 zakładek, create-mode OUT (czysta kartka S8), `HiddenFileEditorModal` w `profile/`, Persona jedno okienko, Uprawnienia na jednej osi, Ekipa przez `SubAgentEditorModal`, Pamięć zgodna z Memory v3 (Na teraz), Prompt z rdzeniem CORE_RULES + promptami roboczymi. `memory_rescue` (C9).
  - Testy: `toolAxis.test.js` (migracja/grupy) + rozszerzone `Agent`/loader. Współpracujące moduły: `modules/mcp` (filterByAgent na disabled_tools), `core` (permissions/vaultGroups/resolver), `modules/memory`/`chat`/`sub-agents` (fabryki promptów).

## E2.9 FAZA D update (2026-07-23) — todo default ON + artefakty w Uprawnieniach
- **`toolAxis`: grupa `artifacts` = `artifact_create/read/update/list` + `todo`.** Nowa stała `DEFAULT_ENABLED_EXCEPTIONS = ['todo']` — `defaultDisabledTools()` odfiltrowuje `todo` z domyślnie-wyłączonej grupy `artifacts`, więc świeży agent ma `todo` ON (pisze tylko do ukrytego `.pkm-assistant/`), a `artifact_*` OFF konserwatywnie (piszą notatki do widocznego vaultu). Sub-agenty todo NIE dostają (`DEFAULT_SUB_AGENT_TOOLS` bez zmian).
- **`profile_permissions`:** toggle `chat_todo_save` (groupA) usunięty; groupB `idea_review`/`plan_review` → `artifact_create`/`artifact_update` (default OFF, piszą tylko do folderu artefaktów). `profile_prompt` inspektor nie czyta już `_chatTodoStore`/`_planStore`.

## A1–A4 security update (2026-07-24)

- `Agent` ma dwa nowe pola kontraktu: `access_policy_version: 2` i
  `admin_access` (boolean, default `false`; serializowany tylko gdy `true`).
  Przełącznik jest w profilu → **Zaawansowane → Dostęp administracyjny →
  Totalna wolność**, z ostrzeżeniem o uszkodzeniu konfiguracji i wycieku danych.
- `accessPolicy.js` robi jednorazową migrację dawnych profili: stare puste
  `focus_folders` dostają `guidance_mode:true`, bo wcześniej efektywnie widziały
  cały vault. Od wersji 2 tryb przypisany + pusta lista znaczy zero dostępu.
- Jaskier ma jawne `access_policy_version:2` i `guidance_mode:true`, ale
  `admin_access` pozostaje OFF. Admina włącza user konkretnemu agentowi.
- `mcp_servers[]` jest jedynym realnym opt-inem serwerów userowych per agent.
  Martwe `default_roles`/„allowed agents” w kreatorze serwera zostały usunięte.
- Zakładka Uprawnienia pokazuje światła ryzyka. Toggle są tylko dla YELLOW;
  RED (nadpisanie, delete, wysyłka, zewnętrzny serwer) nie ma wyłącznika w `edge`.

## S27 update (2026-07-28) — magazyny szablonów + flow „z szablonu" w profilu

- **`AgentManager` owneruje dwa nowe magazyny szablonów** (wzór `skillLoader`/`subAgentLoader`):
  `skillTemplateStore` (`modules/skills`) i `subAgentTemplateStore` (`modules/sub-agents`).
  Ładowane równolegle w `initialize()`. ~~Przeładowanie przez `reloadTemplates()`~~ **— metoda
  skasowana AUD-dead-code-060/235 (2026-09-02): nie miała żadnego wołacza; magazyny odświeżają
  się dziś wyłącznie przy `initialize()`/reload managera.**
  ~~Zaplecze startuje PUSTE — żadnego seedowania fabrycznych szablonów~~ **(zmienione w E3.5:
  decyzja Kuby D1 — 3 fabryczne szablony Deep Research seedowane RAZ, patrz sekcja E3.5 niżej).**
- **Profil → Umiejętności (`profile_skills.js`):** doszło „+ nowy skill od zera" (miejsce
  NARODZIN żywego skilla — po S27 Z2 Zaplecze pokazuje już tylko szablony) z auto-przypisaniem
  do agenta i checkboxem „Zapisz też jako szablon w Zapleczu", oraz „+ z szablonu"
  (`instantiate` → kopia + przypisanie). Kafelek skilla niesie badge „Z szablonu: X vN".
- **Profil → Ekipa (`profile_team.js`):** „+ od zera" otwiera modal z checkboxem
  „Zapisz też jako szablon"; doszło „+ z szablonu" (`instantiate` → kopia `<agent>-<slug>`
  + wpis do Ekipy). Kafelek członka niesie badge „Z szablonu: X vN" (`cfg.from_template`).
- **D3 „kopia, nie link":** wszystkie te ścieżki tworzą NIEZALEŻNE kopie. Edycja szablonu
  w Zapleczu nie zmienia bytów już odlanych u agentów.
- Zapis przypisań idzie przez `AgentManager.updateAgent(name, {skills|sub_agents})` — jedyny
  owner zapisu profilu, żeby YAML nie rozjechał się z cache.

## S28 update (2026-07-29) — komunikator: widoczność per agent + ping skrzynki

- **Nowe pole kontraktu `Agent.komunikator_visible`** (boolean, default `true`; serializowane
  TYLKO gdy `false` — wzór `admin_access`, tylko odwrotny domyślny stan; w `allowedFields`,
  a `update()` przyjmuje wyłącznie jawne `false` jako wyłączenie). Toggle „Uczestniczy
  w komunikatorze" w profilu → **Uprawnienia** (grupa Komunikator), zapis przez
  `profile_advanced.handleSave`.
- **`AgentManager` jest bramką widoczności** — `isKomunikatorVisible(agentOrName)`,
  `listKomunikatorAgents()`, `findKomunikatorAgent(name)` delegują do pure
  `modules/komunikator/visibility.js`. Dzięki temu `modules/tools/` czyta filtr przez
  wstrzyknięty `agentManager`, bez deep-importu i bez wciągania obsidiana.
- **`AgentManager.getInboxPing(agent)`** → `{count, senders}` albo `null` (komunikator
  wyłączony / agent-duch / zero nieprzeczytanych). Kontekst promptu niesie `inboxPing`;
  dawne `unreadInbox` USUNIĘTE. `Agent.getSystemPrompt` nie dokłada już sekcji „Wiadomości"
  ze ścieżką `inbox_<agent>.md` — ping to jedna linijka w drzewie (patrz `modules/prompts`).
- **`PromptContextBuilder.js` SKASOWANY** razem z Project Hubem (D1): `buildPromptContext` /
  `buildSubAgentContext` wstrzykiwały do promptu listę projektów i zadań z Komunikatora v2.
  `projectContext` zniknął z `_buildBaseContext` i z `Agent.getSystemPrompt`/`getPromptSections`.
  **`VaultMap` NIETKNIĘTY** — to osobny byt.
- **`toolAxis`:** grupa `delegation` = `delegate` + `agent_delegate` (`agent_message` OUT),
  grupa `komunikator` = `kom_send` / `kom_list` / `kom_read`. `DEFAULT_DISABLED_GROUPS`
  i `DEFAULT_SUB_AGENT_TOOLS` **bez zmian** — komunikator dalej OFF u świeżego agenta
  (user włącza w Uprawnieniach), suby poczty nie dostają.

## Kubełek 2 update (2026-07-29) — guziki pamięci w profilu na torze S29

- **`profile_memory._runArchiveWorkflow` przepięty na `startConsolidationRun`** (S29 „Puls
  pamięci", `modules/chat`). Guziki „Podsumuj rozmowy" i „Sumaryzuj streszczenia" wołały dotąd
  STARY, blokujący `ArchiveWorkflow.run()` + `ArchiveModal`: bez paska statusu, bez kosztu
  w CostLog, bez „Ponów" i — najgorsze — **bez blokady równoległości**. User mógł kliknąć guzik
  w trakcie trwającego przebiegu S29 i dwa procesy mieliły te same pliki. Teraz oba wejścia
  przechodzą przez `MemoryOpsCenter` (jeden przebieg na raz; drugi trigger tylko otwiera okno).
- **Import chatu jest LENIWY** (`await import('../../chat/index.js')` w handlerze kliknięcia) —
  statycznej krawędzi agents→chat nie ma i nie dokładamy jej do trójkąta shell↔chat↔agents.
- **Rerender po zdarzeniu, nie po `await`.** Nowy tor wraca od razu, więc panel odświeża się
  dopiero na `OPS_EVENT.RUN_FINISHED` z `memoryOpsCenter` (jednorazowa subskrypcja + wyścig
  na wypadek przebiegu, który domknął się przed podpięciem).
- ⚠️ **Zmiana UX:** guziki nie blokują już UI; przy pustym planie leci „nie ma czego konsolidować"
  zamiast dawnego „gotowe"; postęp widać w oknie przebiegu i na pasku statusu. Klucz i18n
  `profile.memory.consolidation_done` skasowany (podsumowanie daje teraz kontroler przebiegu),
  opisy pod guzikami przepisane. `ArchiveWorkflow`/`ArchiveModal` **nie są już importowane** w tym
  module — stary tor został bez produkcyjnego wołacza (żyją go tylko testy `ArchiveWorkflow.test.js`).

## D6 update (2026-07-30) — JEDEN guzik konsolidacji zamiast dwóch

- **„Sumaryzuj streszczenia" WYCIĘTY** (`profile_memory.js`, sekcja Streszczenia). Wołał
  DOKŁADNIE tę samą funkcję co „Podsumuj rozmowy" w sekcji Sesje — `_runArchiveWorkflow`, czyli
  pełny plan konsolidacji, w którym L2/L3 i tak ruszają dopiero po rozstrzygnięciu paczek L1
  (bramka `generateGatedSteps`). Dwa guziki obiecywały wybór, którego nigdy nie było.
  Klucze i18n `profile.memory.consolidate_summaries` + `_desc` skasowane (pl+en); opis pod
  guzikiem, który został, mówi teraz prawdę o zakresie (brain/ → L1 → L2 → L3).
- `_renderMemorySummaries` nie potrzebuje już `memory` ani `rerender` — sekcja Streszczenia jest
  czystym podglądem plików L1/L2/L3.
- Powiązane w tym samym zadaniu: skasowany cały stary tor konsolidacji w `modules/memory`
  i `modules/shell` (patrz ich CLAUDE.md).

## E3.5 update (2026-07-29) — fabryczne szablony Deep Research (`factoryTemplates.js`)

- **Nowy plik `factoryTemplates.js`** (pure, DI, testowalny w AVA; eksport w barrelu:
  `ensureFactoryTemplates` / `getFactorySkillTemplates` / `getFactorySubAgentTemplates` /
  `FACTORY_TEMPLATES_MARKER`). Seeduje 3 fabryczne szablony: sub `researcher` + skille
  `deep-research-web` / `deep-research-vault` (treści w i18n `factory.template.*`, pl+en).
- **Seed RAZ** — marker `.pkm-assistant/templates/.factory-seeded-v1` (wzór migratora E2.9).
  Kasacja usera SZANOWANA (nie wraca po restarcie — inaczej niż builtin typy artefaktów:
  typ to infrastruktura silnika, szablon to oferta w Zapleczu). Userowy szablon pod fabryczną
  nazwą wygrywa (skip, zero sufiksowania). Podbicie treści fabrycznych w przyszłości = nowy
  sufiks markera (`-v2`), świadoma decyzja.
- Wołane z `initialize()` PO `loadAll()` obu magazynów (kolizje sprawdzane po cache,
  `createFromData` wpisuje do cache — bez re-loadu). Wynik researchu = artefakt typu `raport`
  (trzeci builtin, `modules/artifacts`).

## S32 Z1 + Z4.2 update (2026-07-30) — faza E domknięta minimalnie + kasacja martwych override'ów

Spec E2.8 zostawił trzy feature'y „na fazę E" bez definicji. Zrobione w minimalnym zakresie
(decyzja orkiestratora S32 — bez rozbudowy):

- **Generator promptu startowego (Z1a).** Nowy `profile/startPromptGenerator.js` (PURE:
  `buildStartPrompt({role, tone, rules}, t)` + `TONE_OPTIONS` (5 tonów) + `getToneOption`;
  test `startPromptGenerator.test.js`) i `profile/StartPromptGeneratorModal.js` (formularz +
  live podgląd + akcent `pickColor(agentName)` zmienną CSS `--cs-startprompt-accent`).
  Wejście: baner na górze **Prompt → Inspektor** (`_renderStartPromptBanner`) — tam user
  pierwszy raz widzi, że sekcja „KIM JESTEM" jest pusta. `onInsert` ustawia
  `ctx.formData.personality` (BUFOR panelu, nie YAML) + Notice + `renderActiveTab()`, więc
  nadpisanie nie pyta o potwierdzenie — bez „Zapisz profil" nic nie ląduje na dysku.
  Wynik jest markdown-light (akapity + lista zasad, **zero nagłówków `#`**) — `personality`
  wchodzi w sekcję promptu, która ma własne nagłówki.
- **Panel „Aktywne sesje" w Personie (Z1c).** `renderProfileTab` jest teraz **async**
  (`AgentProfileView` go awaituje) i pod polem Osobowość dokłada listę z
  `agentManager.getAgentMemory(name).listActiveSessions()`. Klik = `openHiddenFile`
  (helper z `profile_helpers.js`, read-only) — zero duplikatu kodu z zakładką Pamięć.
  Zakładka Pamięć pokazuje TYLKO archiwum, więc żywe sesje nie miały gdzie się pokazać.
  Brak pamięci agenta = sekcji po prostu nie ma (pusty panel > kłamliwe „Brak sesji").
- **Karta „Log wpisów" w Pamięć → Brain (Z1b).** Read-only lista 50 ostatnich zdarzeń
  z `brain.log` przez `parseBrainLog` (`modules/memory`). ⚠️ To **NIE** `audit.log` — tamta
  karta zostaje obok, to osobny legacy mechanizm (ignorowane `brain_update`).
- 🔴 **`minion_guide` + `master_guide` WYCIĘTE z `profile_prompt.overrideDefs` (Z4.2).**
  Były wydmuszkami: od unifikacji trybów `PromptBuilder` renderuje wyłącznie `delegate_guide`
  (komentarze `PromptBuilder.js:176,577`), więc tekst wpisany w te dwa okienka NIE trafiał
  do promptu. Klucze i18n `profile.prompt.subagent_guide` + `.strategist_guide` skasowane
  (pl+en; grep potwierdził zero innych użyć). Zapisane wartości w YAML-ach userów zostają
  nieszkodliwie — **bez migratora**, nikt ich nie czyta. Razem z nimi wypadła jedyna
  produkcyjna czytelniczka `subAgentLoader.getAllSubAgents()` w tym pliku.
## S33 Z2 update (2026-07-30) — `can_message` wycięte do zera (B3)

Pole zostało skasowane jako byt już w **E2.8 A4/F7** („każdy pisze do każdego"), ale runtime dalej
je czytał, trzymał, serializował i przyjmował w `update()` — wydmuszka udająca uprawnienie.
S33 usuwa ostatnie ślady: konstruktor `Agent`, `serialize()`, `allowedFields`/gałąź `update()`,
walidacja w `core/utils/yamlParser.js`, `AgentProfileView.formData` i `profile_advanced.handleSave`.

- **Zero nowej logiki egzekwowania** — kto z kim rozmawia, rozstrzyga dziś `komunikator_visible`
  (S28 D6) plus strażnicy `kom_send` (S33 Z2).
- **Stary YAML usera z `can_message` ładuje się bez błędu** — `validateAgentSchema` sprawdza tylko
  znane pola (nie odrzuca nieznanych), więc pole ląduje w ignorowanej reszcie configu i znika przy
  najbliższym zapisie profilu. Pilnuje tego `modules/agents/Agent.test.js` (nowy plik).


## K3 update (2026-08-22) — popover uprawnień przestaje kłamać (AUD-security-024 / 025)

- **`AgentLoader.saveAgent` ma twardy guard na built-ina.** `agent.isBuiltIn` → zapis idzie do
  `<nazwa>_overrides.yaml` (`saveBuiltInOverrides`), niezależnie od tego, kto woła. Do K3 popover
  uprawnień w czacie wołał `loader.saveAgent(jaskier)` wprost, czyli pisał do `jaskier.yaml` —
  pliku, który `loadAllAgents` **odfiltrowuje** (custom agent o nazwie built-ina). Ograniczenie
  ustawione przez usera znikało po restarcie Obsidiana, bez słowa ostrzeżenia.
- **Popover chodzi teraz przez `agentManager.updateAgent`** (jedyny owner zapisu profilu; ma
  poprawną gałąź built-ina i rozgłasza `agent:updated`). Guard w loaderze zostaje jako druga
  warstwa — na przyszłych wołaczy.
- **Nowe pure-helpery w `toolAxis.js`** (eksportowane też z barrela, bo konsument — popover —
  jest poza modułem): `PERMISSION_SWITCH_TOOLS`, `PERMISSION_PRESET_SWITCHES`,
  `isPermissionSwitchOn`, `applyPermissionSwitch`, `applyPermissionPreset`. Mapują etykiety
  „Odczyt notatek / Modyfikacja notatek / Tworzenie plików / Usuwanie plików" na nazwy narzędzi
  (`read`+`list`+`search`, `write`, `create_folder`, `delete`), czyli na `disabled_tools` —
  jedyną oś, którą ktokolwiek egzekwuje (od K3 także przy WYWOŁANIU, patrz `modules/tools`).
  Dotąd popover pisał w `default_permissions.{read_notes,edit_notes,create_files,delete_files,mcp}`,
  a `Agent._normalizePermissions` te klucze cicho kasuje (żywe zostały tylko `memory`
  i `guidance_mode`) — kropka przesuwała się na ekranie i nic z tego nie wynikało.
- **Przełącznik „Narzędzia MCP" WYCIĘTY.** Po E3.1 dostęp do serwera zewnętrznego to opt-in
  per serwer (`mcp_servers[]`, profil → Umiejętności → Konektory), więc jeden boolean nie miał
  czego włączać. Świadomie NIE ma go w `PERMISSION_SWITCH_TOOLS`.
- **Presety (Bezpieczny / Standard / Pełny) ruszają wyłącznie te cztery przełączniki** i nie
  dotykają już `memory` ani `guidance_mode`. Dotąd KAŻDY preset ustawiał `guidance_mode:false`,
  więc kliknięcie „Pełny" zawężało agenta do whitelisty folderów — odwrotnie niż mówi etykieta.
  Obie osie mają w popoverze własne wiersze.
- **Stan mieszany = OFF.** Przełącznik świeci tylko wtedy, gdy ŻADNE z jego narzędzi nie jest
  wyłączone (np. `search` wyłączony w profilu → „Odczyt notatek" pokazuje OFF). UI nie ma prawa
  obiecywać więcej, niż agent faktycznie ma.
- Strażnik: `modules/agents/permission_switches.test.ts` (11 testów — mapa, presety, zapis
  built-ina do pliku nadpisań, przeżycie „restartu" przez `loadAllAgents`).

## K11 update (2026-08-22) — duchy poza promptem, `admin_access` znormalizowany

- **`_buildBaseContext().agentList` idzie z `listKomunikatorAgents()`, nie z `getAllAgents()`**
  (AUD-security-047). Blok `komunikacja` w prompcie jest bramkowany po `kom_send`/`agent_delegate`,
  a lista szła bez filtra widoczności — agent z `komunikator_visible: false` pokazywał każdemu
  agentowi z pocztą swoją nazwę I OPIS, mimo że `kom_send` do niego odbija się jak od literówki.
  Jeden filtr obsługuje dziś obie drogi. `listKomunikatorAgents()` deklaruje `Agent[]` (karmimy
  go własnym `getAllAgents()`, więc na wyjściu są te same instancje).
  Strażnik: scenariusz harnessa `12_poczta_petla` (asercja na PRAWDZIWYM prompcie systemowym).
- **`Agent.update()` normalizuje `admin_access`** przez `normalizeAdminAccess` — ten sam wzorzec
  co `komunikator_visible` i `default_autonomy` (AUD-security-080, twardnienie). Dotąd pole szło
  przez `this[key] = value`, więc po `update()` mogło trzymać wartość nie-boolowską z ręcznie
  pisanego YAML-a. Luki nie było (wszyscy konsumenci porównują `=== true`), ale dwa kształty
  jednego pola to mina pod pierwszy nie-ścisły odczyt.

## K12 update (2026-08-23) — ogony po audycie security

- **`AgentManager.saveActiveSession()` WYCIĘTA (ogon K4).** Metoda nie miała ani jednego
  wołacza — czat zapisuje sesję wprost przez `memory.saveSession(...)`
  (`modules/chat/chat/chat_session.ts`). Był to martwy pośrednik nad `getActiveMemory()`.
- **Stary „płot" pamięci w `Agent.getSystemPrompt`/`getPromptSections` WYCIĘTY (ogon K9).**
  Oba miejsca owijały `context.memoryContext` w `--- ${t('agent.memory_start')} ---` /
  `--- ${t('agent.memory_end')} ---` (`=== PAMIĘĆ DŁUGOTERMINOWA (z brain.md) ===` /
  `=== KONIEC PAMIĘCI ===`). Od K9 sekcja `memory` i tak idzie przez `addDynamicSection` →
  `fenceUntrusted` → `<vault_content source="memory">`, które ESCAPUJE treść i nie da się go
  zamknąć od środka. Stare markery były drugim, **podrabialnym** płotem wewnątrz prawdziwego —
  dokładnie tym kształtem, którym ładunek z AUD-035 udawał koniec sekcji.
  Nagłówek `## Długoterminowa pamięć` (`memory.long_term` w `AgentMemory.getMemoryContext`)
  ZOSTAJE — to etykieta, nie granica zaufania. Klucze i18n `agent.memory_start`/`agent.memory_end`
  skasowane (pl+en).
  Strażnik: `modules/agents/Agent.test.ts` → „K12: wewnątrz ogrodzenia pamięci nie ma DRUGIEGO
  płotu". Asercja jest KSZTAŁTOWA (linia-linijka `---`/`===`/`═══`), nie tekstowa — markery szły
  przez i18n, więc test na konkretnym napisie łapałby tylko jeden język.

## K18 update (2026-08-23) — prompt budowany dla PODANEGO agenta (AUD-security-112)

- **`getActiveSystemPromptWithMemory(context, agent?)` przyjmuje agenta drugim argumentem.**
  Brak argumentu = dotychczasowe zachowanie (aktywny agent), więc nikt się nie wywraca; ale
  **czat podaje go ZAWSZE**, bo to on ma właściciela tury zamrożonego przed pierwszym awaitem
  (`modules/chat/chat/turnOwner.ts` → `freezeTurnOwner`). Argument może być obiektem albo nazwą.
- **Dlaczego to jest luka, a nie kosmetyka.** Budowa tego promptu potrafi trwać sekundy
  (`memory.getMemoryContext()` → brain.md + sesja, mapa vaulta, ping skrzynki). W tym oknie
  `ChatView._switchTab` **nie jest blokowany** i przestawia `this.activeAgent`. Dopóki funkcja
  czytała wyłącznie lustro, tura zaczęta u agenta A kończyła z promptem złożonym częściowo
  z persony/pamięci agenta B — a dalej szła już całkiem jako tura B.
- **W środku wszystkie odczyty idą przez lokalne `target`**, nie `this.activeAgent`: kontekst
  bazowy (`_buildBaseContext(target)` — parametr istniał od dawna, po prostu nikt go nie podawał),
  bramka `permissions.memory`, `focusFolders`, `getInboxPing(target)` i finalne
  `target.getSystemPrompt(...)`. **Pamięć adresowana po NAZWIE** (`getAgentMemory(target.name)`)
  zamiast `getActiveMemory()` — ten sam wzór fail-closed co K4 w `turnOwner`.
- ⚠️ **`getVaultMapDescriptions()` jest globalne** (jedna mapa vaulta na plugin) — nie zależy od
  agenta i celowo nie dostało parametru; bramkuje je `target.focusFolders`.
- Strażniki (po źródle, bo `send_message` ciągnie `obsidian`): `modules/chat/chat/turnOwner.test.ts`
  — „AgentManager przyjmuje agenta argumentem" + „prompt tury budowany dla agenta-właściciela".

## K19 update (2026-08-30) — rename agenta ma jednego właściciela (AUD-code-review-024/025/030)

Fabryka napraw code-review 2026-08-30, klaster F02. Trzy niezależne wtopy w panelu profilu,
wszystkie w tej samej rodzinie plików (`AgentManager` + `profile_advanced`/`profile_permissions`).

- 🔴 **024 (CRITICAL) — zmiana nazwy agenta.** `updateAgent` przepuszczało `name` prosto do
  `agent.update()`, a `AgentLoader.saveAgent` liczyło nową ścieżkę z NOWEJ nazwy i pisało
  BEZWARUNKOWO — literówka w polu nazwy cicho nadpisywała cudzy `<nazwa>.yaml`, stary plik i
  folder pamięci (`.pkm-assistant/agents/<safeName>/`) zostawały osierocone, a mapy runtime'u
  (`agents`/`agentMemories`/`agentHistories`, kluczowane STARĄ nazwą) rozjeżdżały się z dyskiem.
  **Nowy `AgentManager.renameAgent(oldName, newName)`** jest jedynym właścicielem operacji:
  - kolizja (nazwa zajęta w pamięci — built-in LUB custom — albo plik pod nowym slugiem już
    istnieje na dysku) = **twarda odmowa z Notice**, zero zapisu;
  - folder pamięci przenosi się **create-before-delete** (kopia → kasacja starego), PRZED
    YAML-em — pad kopiowania przerywa cały rename z komunikatem, agent/dysk/mapy NIETKNIĘTE;
  - YAML: zapis pod nową ścieżką, kasacja starego DOPIERO po potwierdzonym zapisie; pad zapisu
    cofa `agent.name` i sprząta świeżo skopiowaną pamięć (best-effort rollback);
  - po sukcesie: przekluczowanie `agents`/`agentHistories`/`agentMemories` + reinicjalizacja
    `AgentMemory` pod nowym kluczem (`_initializeMemoryForAgent`, folder już przeniesiony) +
    event `agent:renamed`.
  - Dysk-owa logika (kolizja/kopiowanie/zapis/rollback) żyje w **`renameAgentFlow.ts`**
    (NOWY plik, `renameAgentOnDisk` — czysty, zero `obsidian`, wzór `migrationReviewFlow.ts`).
    `AgentManager.ts` importuje `Notice` na starcie pliku i transytywnie ciągnie `obsidian`, więc
    AVA nie ma jak go zaimportować — bez tej ekstrakcji dyskowa logika renamea byłaby
    NIETESTOWALNA. Przekluczowanie map zostaje w `AgentManager` (potrzebuje żywego stanu klasy).
  - `updateAgent(name, updates)` wydziela `updates.name` PRZED resztą pól: gdy zmienia się
    nazwa, najpierw woła `renameAgent` — odmowa/pad przerywa **CAŁY** zapis (żadne inne pole z
    tego samego „Zapisz profil" też nie ląduje), nie tylko pomija `name`. `profile_advanced.
    handleSave` sprawdza teraz zwrotkę `updateAgent` (dotąd IGNOROWANĄ) — odmowa nie pokazuje
    już kłamliwego „Zapisano", cofa bufor `formData.name` do prawdziwej nazwy i re-renderuje.
  - Testy: `renameAgentFlow.test.ts` (9 — happy path, kolizja w pamięci, kolizja przez osierocony
    plik, pad kopiowania pamięci [rollback kopii], pad zapisu YAML [cofnięcie nazwy + rollback],
    built-in guard, pusta nazwa, no-op, agent bez folderu pamięci).
  - ⚠️ `AgentManager.renameAgent`/`updateAgent` (cienki wrapper z `Notice`) NIE mają testu AVA —
    ten sam powód co reszta pliku (import `obsidian`). Pokrycie behawioralne = harness/smoke.
- 🟠 **025 — bufor Uprawnień resetował się przy każdym renderze.** `renderPermissionsTab`
  bezwarunkowo nadpisywało `formData.permissions` kopią z `agent.permissions` — jedyne miejsce
  w panelu bez guardu „inicjalizuj tylko gdy pusty" (wzór ma linia niżej, `disabled_tools`, i
  `approval_toggles`). Efekt: tryb dostępu i „Pamięć agenta (odczyt)" ustawione, ale
  niezapisane, znikały przy powrocie na zakładkę z innej. Fix: `if (agent && !formData.permissions)`
  — bufor powstaje raz w `AgentProfileView.ts` (linia 92) przy otwarciu panelu, kolejne wejścia
  na zakładkę go NIE dotykają.
- 🟡 **030 — komunikat po zapisie zawsze kłamał o uprawnieniach.** `profile_advanced.handleSave`
  porównywało `agent.defaultPermissions` (pole, które NIE ISTNIEJE — żywe pole to `permissions`)
  — otwarta sygnatura indeksu klasy (`[extra: string]: unknown`) przepuszczała to przez
  typecheck, `JSON.stringify(undefined)` nigdy nie było równe zserializowanemu obiektowi, więc
  notice „Zapisano: …, Uprawnienia" pokazywał się przy KAŻDYM zapisie, niezależnie od tego, czy
  cokolwiek w Uprawnieniach się zmieniło. Fix: porównanie na `agent.permissions`. Dołożony też
  `log.warn` w `Agent.update()` dla pól spoza `allowedFields` (poza `access_policy_version` —
  `serialize()` emituje je ZAWSZE, więc ostrzegałoby na każdym starcie Jaskra z override'em;
  nie jest literówką, jest świadomie pominięte) — literówka w kluczu `updates` wołacza jest teraz
  widoczna w logu zamiast ginąć po cichu. Testy: `Agent.test.ts` (3 nowe — literówka loguje,
  znane pole nie loguje, `access_policy_version` z realnego `serialize()` jest ciche).

## F02 druga runda (2026-08-30) — recenzent obalił K19 na atrapie vaulta: trzy dziury domknięte

Opusowy recenzent zablokował merge K19 udowadniając trzy konkretne dziury w `renameAgentFlow.ts`
na atrapie vault adaptera. Wszystkie trzy naprawione w tej samej funkcji `renameAgentOnDisk`:

- 🔴 **Ten sam slug kasował pamięć / fałszywie odmawiał.** Rename „badacz"→„Badacz" (różnica
  TYLKO w wielkości liter — `toSafeName` je zlewa) liczył `newFilePath`/`newMemoryDir`
  IDENTYCZNE ze starymi. Bramka kolizji widziała WŁASNY plik/folder i fałszywie odmawiała
  (self-collision) — a gdyby ktoś kiedyś złagodził tę bramkę, `copyFolder(src→src)` +
  `rmdir(src)` skasowałoby właśnie skopiowaną pamięć, bo źródło i cel to ta sama ścieżka.
  Fix: **jawna wcześniejsza gałąź** — `newSafeName === oldSafeName` zapisuje YAML pod
  NIEZMIENIONĄ ścieżką (tylko treść pliku się zmienia — nowa wartość `name`) i wraca, ZERO
  ruszania folderu pamięci, ZERO wołania `hasAgentName`/sprawdzania kolizji.
- 🔴 **Bramka kolizji była fail-OPEN.** Pad `vaultAdapter.exists()` (dysk niedostępny, timeout)
  szedł przez pusty `catch {}` i był cicho czytany jako „pliku nie ma" — czyli PRZEPUSZCZAŁ
  rename dokładnie wtedy, gdy nie dało się stwierdzić, czy jest kolizja. Fix: pad na
  KTÓRYMKOLWIEK z dwóch sprawdzeń dyskowych (plik YAML / folder pamięci) = nowy powód
  `collision_check_failed`, twarda odmowa, zero zapisu. Notice: `profile.advanced.
  rename_collision_check_failed` (pl+en).
- 🟠 **Osierocony folder pamięci pod nowym slugiem nie był sprawdzany.** Bramka kolizji patrzyła
  TYLKO na plik YAML — folder pamięci po dawno skasowanym agencie pod tym samym slugiem (np.
  ktoś skasował „Klara", potem próbuje przemianować innego agenta na „Klara") byłby cicho
  wchłonięty przez `copyFolder`: cudze notatki wymieszane z nowymi pod jedną ścieżką. Fix:
  `deps.vaultAdapter.exists(newMemoryDir)` dołączony do tej samej bramki kolizji (fail-closed
  razem z powyższym). Druga warstwa: `newMemoryDirTouched` (flaga) pilnuje, żeby rollback na
  padzie kopiowania/zapisu kasował WYŁĄCZNIE folder, który TA operacja sama założyła — nie
  cudzy folder, który mógł tam leżeć (dziś nieosiągalne dzięki bramce kolizji, ale to druga
  linia obrony, gdyby ktoś ją kiedyś rozluźnił).
- 🟡 **6a — skrzynka komunikatora teraz wędruje z agentem.** Rename nie przenosił
  `.pkm-assistant/komunikator/inbox/<slug>/` — po zmianie nazwy agent tracił dostęp do własnej
  historii poczty (`kom_list`/`kom_read` liczą folder z AKTUALNEJ nazwy). `renameAgentOnDisk`
  liczy tę ścieżkę wprost (`komunikatorInboxDirFor`, ten sam wzór slugowania co
  `KomunikatorManager._getSafeName` — zweryfikowane identyczne) i przenosi ją
  create-before-delete, PO potwierdzonym sukcesie YAML+pamięci. **BEST-EFFORT**: pad przenosin
  NIE cofa rename'u (agent i pamięć są już bezpieczne) — zwrotka niesie `inboxMoveFailed: true`,
  `AgentManager.renameAgent` loguje to `log.warn` (bez Notice — rename i tak się powiódł).
  Stara skrzynka zostaje NIETKNIĘTA na padzie (create-before-delete: kasacja starej dopiero po
  potwierdzonym skopiowaniu). **Bramka na CEL (re-review):** istniejąca skrzynka pod NOWYM
  slugiem (np. po skasowanym agencie — `deleteAgent` kasuje tylko YAML) = zero kopiowania,
  `inboxMoveFailed: true`; cudza poczta nigdy nie jest wchłaniana (test F02.7).
- **Czego rename WCIĄŻ nie przenosi (świadomie, poza zakresem tej naprawy):** prefiksy
  sub-agentów (`<agent>-<slug>` w Ekipie — nazwa suba zostaje „stara"), reguły „Zawsze zezwalaj"
  w `ApprovalManager` (kluczowane starą nazwą agenta), zakładki otwarte w czacie (trzymają starą
  nazwę do ręcznego odświeżenia), oraz zdarzenie `agent:renamed` — dziś **nie ma ani jednego
  konsumenta** (grep po repo, zero nasłuchów). Ktoś dodający pierwszego słuchacza tego eventu
  powinien wiedzieć, że dostanie go PO przekluczowaniu map, ale PRZED tymi czterema lukami.
- Testy: `renameAgentFlow.test.ts` +7 (`F02.1`–`F02.7`):
  same-slug zachowuje pamięć i omija bramkę kolizji, fail-closed na padzie `exists()`, osierocony
  folder pamięci = odmowa (cudza pamięć nietknięta), rollback nie kasuje folderu którego sam nie
  stworzył, skrzynka przeniesiona (create-before-delete), pad przenosin skrzynki nie wywala
  rename (stara skrzynka zostaje, `inboxMoveFailed: true`).
- **Punkty z tej samej rundy recenzji, poza `renameAgentFlow.ts`:**
  - `profile_advanced.handleSave` robi teraz **snapshot pól agenta PRZED `updateAgent`** (stała
    `before`). Do tej naprawy `agent` w domknięciu `handleSave` to ta sama ŻYWA instancja, którą
    `agentManager.updateAgent` mutuje w miejscu (`agent.update(rest)`) — porównanie `updates.x`
    kontra `agent.x` PO `await` widziało już zmutowane pole, więc CAŁY blok „co się zmieniło"
    (`details`) był martwy niezależnie od poprawki nazwy pola z K19/030. Notice „Zapisano: …"
    teraz naprawdę wymienia zmienione sekcje. ⚠️ BEZ testu AVA — `profile_advanced.ts` importuje
    `obsidian` (Notice) i nie wstaje w AVA; pokrycie = odczyt kodu w re-review + smoke.
  - **`sub_agent_enabled` WYCIĘTY z payloadu `updates`** (`profile_advanced.ts`). Pole nigdy nie
    było w `Agent.allowedFields` — `AgentProfileView.ts:91` czyta `agent.subAgentEnabled`
    (camelCase), które nie istnieje NIGDZIE w klasie (zawsze `undefined`). Toggle „Deleguj do
    sub-agentów" w Ekipie (`profile_team.ts:65`) jest więc UI bez żadnego czytelnika w runtime —
    delegację steruje wyłącznie oś narzędziowa (`disabled_tools`, grupa `delegation`). Świadomie
    NIE ożywiony (poza zakresem tej naprawy — decyzja UI osobna); wycięty z `updates` wyłącznie
    po to, żeby `log.warn` na nieznanych polach (dodany w K19/030) nie krzyczał przy KAŻDYM
    zapisie profilu.

## B6 update (2026-09-02) — dwie rundy: `emoji` naprawiony, potem znaleziona PRAWDZIWA ścieżka `model`

Klaster B6 fabryki napraw (werdykt Kuby 30.08, zgłoszenie Niki): „po użyciu agenta runtime
dopisuje do yamla twardy `model` i gubi `language`". Dwie rundy — pierwsza NIE złapała
prawdziwej przyczyny, druga (recenzja koordynatora, czytanie kodu, nie testów) ją znalazła.

### Runda 1 — co sprawdzono i co naprawiono (`emoji`)

Statyczny grep całego `saveAgent(`/`updateAgent(`/`agent.update(`/`.model =` w
`modules/agents`, `modules/chat`, `modules/models`, `modules/tools`, `modules/sub-agents`,
`modules/shell` + dynamiczne testy na atrapie vaulta symulujące obie automatyczne ścieżki
zapisu (migracja osi narzędziowej i access-policy w `AgentLoader.loadAgentFromFile`) oraz zapis
profilu przez `AgentManager.updateAgent` **z patchem BEZ przechodzenia przez `AgentProfileView`
(formData budowany ręcznie w teście)** — wyszło zielono, bo ominęło DOKŁADNIE tę ścieżkę, w
której siedział bug (patrz runda 2). Skutek uboczny tej rundy, wciąż aktualny: `emoji` był w
`AgentConfig`/`allowedFields` od zawsze, ale **konstruktor go nie czytał** — `this.emoji` był
zawsze `undefined`, NAWET dla Jaskra (`HUMAN_VIBE_CONFIG.emoji: '🎭'` ginęło w locie). Dwóch
realnych konsumentów w `modules/chat` (`chat_popovers.ts`, `chat_streaming.ts`) czyta
`agent?.emoji || '◆'` na komunikaty „czeka…"/„skończył" — naprawione: `declare emoji`,
`this.emoji = config.emoji || null` w konstruktorze (wzór `color`), `if (this.emoji) data.emoji
= this.emoji` w `serialize()` (Default OFF). Testy: `agent_yaml_roundtrip.test.ts` (8, w tym
`emoji` RED→GREEN, `git stash` potwierdził).

`language` **nie jest i nigdy nie był tym objawem** — ma jawną obsługę (konstruktor + serialize)
od **E2.8 A6, 2026-07-23**, sprzed zgłoszenia Niki o ponad miesiąc. To ustalenie stoi.

### Runda 2 — PRAWDZIWA przyczyna `model`: żywa ścieżka UI, nie szkoda historyczna

`modules/agents/AgentProfileView.ts` budował `formData` blokiem „Sync model ↔ models.main",
który — gdy `agent.models.main` był ustawiony — **KOPIOWAŁ jego wartość do `formData.model`**
(legacy top-level pole) PRZY KAŻDYM otwarciu/renderze profilu. `profile_advanced.ts`'s onChange
selecta robił to samo w drugą stronę (`formData.model = v; formData.models.main = v;` —
oba naraz). `profile_advanced.handleSave` zawsze wysyła `updates.model = formData.model ||
null`. Skutek: **każdy zapis profilu — dowolna zakładka, nie tylko „Zaawansowane" — dla agenta
z ustawionym `models.main` dopisywał do yamla `model:` = kopię `models.main`.** U Kuby wszyscy
agenci mają ten sam `models.main` (lokalny model przez LM Studio) → „ta sama twarda wartość
u wszystkich agentów, 7/13 yamli" — dokładnie objaw Niki. Runda 1 tego nie złapała, bo testowała
`AgentManager.updateAgent` z ręcznym patchem, omijając akurat ten fragment `AgentProfileView.ts`.

**Naprawa — KANON to `models.main`; `model` (legacy) nigdy nie jest kopiowany Z `models.main`
z powrotem:**
- Nowy plik `modules/agents/profile/modelFieldSync.ts` (CZYSTY, bez `obsidian` — wzór
  `startPromptGenerator.ts`): `resolveMainModelForForm(config)` — gdy `models.main` istnieje,
  select go pokazuje, `model` zostaje NIETKNIĘTY (nie kopiowany); gdy jest TYLKO legacy `model`
  (bez `models.main`), jednorazowa migracja: `models.main` przejmuje wartość, `model` gaśnie
  (`null`) — efekt trafia na dysk przy najbliższym „Zapisz profil". `applyMainModelChange(models,
  v)` — onChange selecta pisze TYLKO `models.main`; czyszczenie pola USUWA klucz `main`
  (nie zostawia `main: undefined`, bo `Object.keys(this.models).length > 0` w `Agent.serialize()`
  zostawiłoby osierocone `models: {}`).
- `AgentProfileView.ts`: `formData.model` inicjalizowany jako `agent.model || null` (nie `''`);
  stary blok sync zastąpiony wołaniem `resolveMainModelForForm`.
- `profile_advanced.ts`: select „Model główny" pokazuje `formData.models?.main` (nie
  `formData.model`); onChange woła `applyMainModelChange`.
- ⚠️ **Zdanie „identyczny wynik, tylko inna linia w łańcuchu" (poniższy akapit w wersji sprzed
  review Opusa) było PRAWDĄ TYLKO DLA ROLI `main`.** Dla ról SUB (researcher/strategist) było
  fałszywe — patrz Runda 3 niżej, `modelResolver.ts` MUSIAŁ zostać ruszony. Historia zdania
  zostaje jako dowód, co dokładnie recenzent obalił: „dla agenta z `models.main` Step 1
  (`agent?.models?.[role]`) i tak wygrywał przed legacy `agent?.model`" — **prawda dla `main`**
  (Step 1 sprawdza `agent.model` jako fallback WYŁĄCZNIE gdy `effectiveRole === 'main'`), ale
  dla ról sub Step 1 w OGÓLE nie zaglądał do `agent.models.main` (sprawdzał tylko
  `agent.models.researcher`/`agent.models.minion` itp.) — jedyną drogą do `models.main` dla ról
  sub była Step 4b, a ta do Rundy 3 znała tylko `agent.model`. Po migracji legacy→`models.main`
  (ta naprawa) agent BEZ `models.researcher` i bez `pkm.minionModel` tracił model dla ról sub
  całkowicie (`createModelForRole(...,'researcher') === null`). Naprawione w Rundzie 3.
- **Testy:** `modules/agents/profile/modelFieldSync.test.ts` (9 po Rundzie 3) — pierwszy test
  niesie KOPIĘ starego algorytmu `AgentProfileView.ts` (diagnostyczną, nie produkcyjną) i dowodzi
  na tym samym wejściu: stary algorytm pisze `model:` (CZERWONY dowód), nowy helper — nie
  (GREEN); jednorazowa migracja legacy→`models.main`; onChange pisze tylko `models.main`;
  czyszczenie usuwa oba; normalizacja formy obiektowej `{platform,model}`; end-to-end na atrapie
  vaulta (agent z `models.main` w yamlu, zapis niezwiązanego pola nie dopisuje `model:`); Rundą 3
  dołożone: agent z OBOMA polami naraz (resztki starego buga) doczyszcza się do samego
  `models.main` przy pierwszym zapisie. Plus `modelFieldSync.wiring.test.ts` (4, Runda 3, p.4)
  — strażnik po ŹRÓDLE `AgentProfileView.ts`/`profile_advanced.ts` (obie importują `obsidian`,
  AVA ich nie wstawi): pilnuje, że stary sync-blok nie wróci i że oba pliki realnie wołają
  helpery, nie tylko mają je w komentarzu.

### Runda 3 (2026-09-02, review Opusa) — trzy dziury w Rundzie 2: blocker w `models/`, martwe czytniki, niespójna migracja

Recenzent OBALIŁ Rundę 2 w tym kształcie (diagnoza dobra, implementacja niekompletna). Cztery
naprawy + jedna nota do rejestru:

1. 🔴 **BLOKER — `modules/models/modelResolver.ts` Step 4b nie znał `agent.models.main`.**
   Opisane wyżej — po migracji legacy→`models.main` agent bez wpisu roli w bibliotece i bez
   `pkm.minionModel` dostawał `null` dla ról sub, więc `DelegateTool.ts`, `WebReadTool.ts`,
   `chat_model.ts` zostawały bez modelu. Naprawa: Step 4b próbuje `agent.model` (legacy, bez
   zmian) ALBO znormalizowany `agent.models.main` jako ostatnia deska ratunku. `models` NIE
   MOŻE importować z `agents` (agents już importuje `models` — odwrotny kierunek zapętliłby
   zależności), więc normalizacja `{platform,model}`→`"platforma/model"` jest LOKALNĄ kopią w
   `modelResolver.ts` (`normalizeAgentModelOverride`), nie importem współdzielonego helpera.
   Osobny commit `fix(models)`. Testy: `modelResolver.test.ts` +2 (agent z samym `models.main`
   dostaje model dla roli sub — czerwony przed fixem; agent z legacy `model` bez regresji).
2. 🔴 **BLOKER — dwaj martwi czytelnicy legacy `agent.model`.** `profile_overview.ts` (zakładka
   Przegląd, „Podstawowe info") i `modules/shell/AgentPresentationModal.ts` (wizytówka
   read-only) czytały `formData.model`/`agent.model` BEZPOŚREDNIO — po migracji te pola są
   `null`, więc obie karty pokazywałyby „globalny" dla KAŻDEGO agenta ze zmigrowanym modelem,
   mimo że ma jawnie ustawiony. Naprawa: `profile_overview.ts` czyta `formData.models?.main`
   (formData już przeszło przez `resolveMainModelForForm` w `AgentProfileView.ts`, więc jest
   aktualne); `AgentPresentationModal.ts` woła `resolveMainModelForForm({model, models})`
   bezpośrednio na żywym `agent` (modal nie ma dostępu do `formData` panelu). **Barrel
   `modules/agents/index.ts` zyskał nowy eksport `resolveMainModelForForm` + typy** (node-safe,
   bez `obsidian`) właśnie dla tego drugiego przypadku — pierwszy cross-module czytelnik poza
   `modules/shell`. Grep po `\.model\b` w `modules/shell`/`modules/chat`/`modules/sub-agents`/
   `modules/tools`/`harness` — pozostałe trafienia to INNE domeny, nie agent: `chat_model.ts:55`
   już sprawdza `activeAgent?.models?.main || activeAgent?.model` (OR, bezpieczne od zawsze),
   `SubAgentEditorModal.ts`/`SkillEditorModal.ts` mają WŁASNE pole `model` (sub-agent/skill,
   zero związku z `models.main` agenta) — nietknięte.
3. 🟠 **Niespójna reguła w `modelFieldSync.ts`.** Gałąź „`models.main` już istnieje" zwracała
   `model: legacyModel` NIEZMIENIONY zamiast `null` — agent z resztkami starego buga (OBA pola
   ustawione, po Rundzie 2 identyczną wartością) nigdy by się nie doczyścił: KAŻDY kolejny zapis
   profilu wciąż pisałby `model:` do yamla. Naprawa: `model` w wyniku `resolveMainModelForForm`
   jest teraz ZAWSZE `null`, bez wyjątku — bezpieczne dopiero PO naprawie p.1 (rozstrzyganie
   modelu dla ról sub nie zależy już wyłącznie od `agent.model`).
4. 🟡 **Strażnik na REALNYM miejscu buga (nie na kopii).** `modelFieldSync.test.ts`'s pierwszy
   test niesie kopię starego algorytmu jako DOWÓD DIAGNOZY — ale kopia nie łapie regresji, gdyby
   ktoś przywrócił stary sync-blok w prawdziwym `AgentProfileView.ts` (kopia w teście zawsze
   zostanie stara). Nowy `modelFieldSync.wiring.test.ts` czyta oba pliki przez `fs.readFileSync`
   (obie importują `obsidian`, AVA ich nie wstawi — wzór `chat_streaming.limits.test.ts`) i
   pilnuje: stary wzorzec `formData.models.main = formData.model` nie wrócił,
   `AgentProfileView.ts` realnie woła `resolveMainModelForForm(`, `profile_advanced.ts` realnie
   woła `applyMainModelChange(` i onChange selecta NIE pisze `formData.model =` (usunięta
   zbędna linia `formData.model = next.model;` — zawsze była `null`, nie trzeba jej przypisywać
   ponownie).
5. 🗒️ **Nota do rejestru, NIE naprawiona w tej fabryce:** `emoji` Jaskra (Runda 1) wycieka do
   `jaskier_overrides.yaml`, bo `AgentLoader.saveBuiltInOverrides` serializuje CAŁEGO agenta,
   nie diff względem `HUMAN_VIBE_CONFIG` — ta sama klasa problemu co `color`/`personality` od
   dawna (built-in override plik rośnie o każde pole, które ma wartość różną od pustej, nawet
   gdy ta wartość jest fabryczna, nie userowa). Osobne zadanie: `saveBuiltInOverrides` powinien
   pisać diff względem `HUMAN_VIBE_CONFIG`, nie pełen `serialize()`.

**Co NIE zostało zrobione (świadomie, poza zakresem):** generyczny „raw passthrough" nieznanych
pól YAML (opcja z briefu rundy 1) był ROZWAŻONY i ODRZUCONY — złamałby istniejący kontrakt
pól-widm (`Agent.test.ts` „B3: serialize NIE wypisuje can_message" i bracia: `archetype`/`role`/
`enabled_tools`/`type`/`minion*`/`master*`/`persona_drift` są CELOWO czytane-i-porzucane albo
usuwane w migracji — generyczny passthrough by je wskrzesił dla każdego starego YAML-a, który
jeszcze je niesie). Wybrana droga to pole po polu, jawnie, ze strażnikiem testowym — zgodnie ze
stylem modułu.

**Lekcja dla przyszłych sesji:** reprodukcja bugu w UI musi przechodzić przez WARSTWĘ UI (albo
jej wierną kopię w teście), nie tylko przez warstwę pod spodem (`AgentManager`/`Agent`) —
warstwa pod spodem była tu poprawna, bug siedział w kodzie budującym `formData` PRZED nią.

## AUD-dead-code klaster D2 update (2026-09-02) — sprzątanie po biegu dead-code 2026-09-02

Fabryka kasacji martwego kodu, klaster D2 (`fix/dc-D2-agents`). 24 znaleziska z biegu
`2026-09-02_dead-code` dotykające `modules/agents/` (kilka duplikatów w opisie tego samego
symbolu — np. `updateVaultMap` 059/233, `createAgentManager` 190/236, `getMemoryPath`+
`getSubAgentNames` 061/238, `SUB_AGENT_ROLES` 065/237, `HUMAN_VIBE_CONFIG` 069/191/239).

- **`AgentManager.ts` (monolit, przeczytany w całości przed edycją):**
  - Cała warstwa historii rozmów wycięta (AUD-dead-code-058): mapa `agentHistories` +
    `getActiveHistory`/`setActiveHistory`/`addToActiveHistory`/`clearActiveHistory` + event
    `agent:history_cleared` + wszystkie 6 miejsc utrzymania mapy (init/create/rename/delete/
    fallback Jaskra). Historia rozmowy żyje w `modules/chat` (rolling window), nie tu.
  - Łańcuch `updateVaultMap` → `VaultMap.updateVaultMap` → `VaultMap._escapeRegex` wycięty
    w całości (059/233) — sekcyjna edycja mapy vaulta została zastąpiona nadpisaniem całości
    (`writeVaultMap`, żywe, `modules/shell/vault_settings.ts`) po E2.8 B1. Klucze i18n
    `vault_map.updated` (pl+en) osierocone razem z metodą — skasowane.
  - Pięć martwych publicznych metod skasowanych (060/234/235): `getBuiltInAgents`,
    `getCustomAgents`, `reloadTemplates`, `getPromptInspectorData` (wrapper nad
    `getPromptInspectorDataForAgent`, który żyje), `getActiveModelSettings` (razem z jedyną
    ofiarą `Agent.getModelSettings()`). `reloadTemplates()` była opisana w tym pliku i w
    `modules/skills/CLAUDE.md` jako droga przeładowania magazynów szablonów — oba miejsca
    poprawione (magazyny odświeżają się tylko przy `initialize()`).
  - `deleteAgent`: strukturalnie nieosiągalna gałąź `if (agent.isBuiltIn) { deleteBuiltInOverrides }`
    wycięta razem z `AgentLoader.deleteBuiltInOverrides` (132) — wcześniejszy guard w tej samej
    metodzie zwraca `false` dla każdego agenta wbudowanego, więc druga gałąź nigdy się nie
    wykonywała; plik `<nazwa>_overrides.yaml` nigdy nie był kasowany mimo komentarza „Also
    remove override file". Decyzja: kasacja, nie ożywienie — nie było dowodu na zamierzoną
    funkcję „przywróć ustawienia fabryczne".
  - `renameAgent`: gałąź `case 'empty_name'` (135, INFO) ZOSTAJE — `reason` to część kontraktu
    zwrotki `renameAgentOnDisk` (pinowana przez `renameAgentFlow.test.ts`), a jedyny wołacz
    (`updateAgent`) odsiewa pustą nazwę wcześniej. Dopisany tylko komentarz wyjaśniający.
  - `createAgentManager()` skasowana w całości (190/236) — zero wołaczy w repo, `src/main.ts`
    buduje managera przez `new AgentManager(...)`. Nie tylko wypięta z barrela (S30 Z4) —
    usunięta z pliku; komentarz S30 Z4 w `index.ts` i wyżej w tym pliku poprawiony.
- **`Agent.ts` (przeczytany w całości):**
  - `SUB_AGENT_ROLES` (065/237) skasowana — balast „minion/master" z Mapy-13, zero konsumentów;
    migracja legacy w `AgentLoader._migrateLegacyAgentFormat` wpisuje literały `'researcher'`/
    `'strategist'` z palca i tej stałej nie potrzebuje. **Sam most odczytu ZOSTAJE**:
    `Agent._normalizeModelOverrides` (kopiuje `models.minion`→`researcher`/`models.master`→
    `strategist` i kasuje stare klucze) to żywa migracja dla starego YAML-a, nietknięta.
  - Martwy import `getDateLocale` usunięty (070) — plik nie formatuje dat.
  - `enabledTools` pole skasowane (063) — komentarz obok kłamał: migracja
    (`computeDisabledToolsFromLegacy`) czyta `enabled_tools` z SUROWEGO `config`, nie z
    `this.enabledTools`. Komentarz przy migracji poprawiony, żeby nie powtórzyć błędu.
  - `activeContext` pole skasowane (064) — pozostałość po wyciętym mechanizmie `active_context.md`
    (A4). **Nie mylić** z `AgentMemory.paths.activeContext` w `modules/memory` — to inny byt
    (ścieżka pliku, nie tablica na agencie), już odróżniony w `modules/memory/CLAUDE.md`.
  - `playbookOverrides` pole + `AgentConfig.playbook_overrides` typ + serializacja + wpis w
    `allowedFields` + gałąź `update()` + nieosiągalna gałąź „co się zmieniło" w
    `profile_advanced.handleSave` skasowane w komplecie (062, wzór `can_message` z S33 Z2) —
    `PlaybookManager` nigdy nie znał tej nazwy pola. Stary YAML z `playbook_overrides:` nadal
    ładuje się bez błędu (pole ląduje w ignorowanej reszcie configu, znika przy najbliższym
    zapisie) — kontrakt przypięty trzema nowymi testami w `Agent.test.ts` (wzór B3/`can_message`).
    Klucze i18n `profile.advanced.playbook_label` (pl+en) skasowane razem z gałęzią.
  - Trzy metody bez wołacza skasowane (061/238): `static fromObject`, `getMemoryPath` (drugi,
    nieutrzymywany wzór ścieżki folderu pamięci — żywy wzór jest w `AgentMemory.ts:301` i
    `renameAgentFlow.ts`), `getSubAgentNames` (bliźniak `getAllSubAgentNames` żyje i jest
    używany).
  - `getModelSettings()` skasowana (234) razem z jedyną ofiarą `AgentManager.getActiveModelSettings()`
    — dobór modelu robi dziś `modules/models` + resolver, ta para była nieaktualnym lustrem.
- **`toolAxis.ts`:** `TOOL_TO_GROUP` + `isBuiltinTool` skasowane (065) — zero konsumentów (UI
  Uprawnień iteruje wprost po `BUILTIN_TOOL_GROUPS`). Wpis-widmo `agent_message: 'edit_notes'`
  w `PERMISSION_TOOL_GATES` skasowany (133) — narzędzie wypadło z `BUILTIN_TOOL_GROUPS` w S28 D3
  (pocztę przejęła grupa `komunikator`), a `permissionAllowsTool` jest wołane wyłącznie dla
  narzędzi z tej mapy, więc wpis nigdy nie był czytany. **Bliźniaczy wpis w
  `core/security/autonomy.ts:158` to INNY przypadek — zostaje, świadomie fail-closed, nietknięty.**
- **`VaultMap.ts`:** `updateVaultMap`/`_escapeRegex` skasowane (patrz AgentManager wyżej).
  `starterVaultMap` i `VaultMapAdapter` przestały być `export`owane (239) — definicje zostają
  (używane wewnątrz pliku), zero eksportu bez odbiorcy. `VaultMapVault` zostaje eksportowany —
  ma żywego importera w `VaultMap.test.ts`.
- **`archetypes/index.ts` + `archetypes/HumanVibe.ts`:** re-eksport `HUMAN_VIBE_CONFIG` skasowany
  z barrela `archetypes/`, a sama stała przestała być `export`owana w `HumanVibe.ts` (069/191/239)
  — jedyny konsument (`createJaskier`) jest w tym samym pliku. `createJaskier` zostaje
  eksportowany (dwaj żywi wołacze: `AgentLoader.ts` przez barrel, `AgentManager.ts` deep-importem
  wewnątrz-modułowym).
- **`index.ts` (barrel):** `PERMISSION_SWITCH_TOOLS` skasowany z eksportu (066) — jedyny
  konsument poza modułem (`chat_popovers.ts`) bierze tylko cztery pozostałe helpery K3; stała
  zostaje `export`owana WEWNĄTRZ `toolAxis.js` dla `permission_switches.test.ts` (importuje ją
  bezpośrednio, nie przez barrel). 7 typów z tego samego bloku (`AgentConfig` i in.) świadomie
  NIE ruszone (parking, decyzja poza tym biegiem).
- **JSDoc:** `AgentProfileView.ts` `@param {import('./SidebarNav.js').SidebarNav}` naprawiony na
  `../shell/sidebar/SidebarNav.js` (006/071/087) — plik `SidebarNav` mieszka w `modules/shell/
  sidebar/`, nigdy nie mieszkał w `modules/agents/`.
- **Cztery martwe parametry** (095 część agents + 148): `showDeleteConfirmation(ctx, tabContent,
  ~~tabBar~~)` (profile_advanced.ts, wołacz AgentProfileView.ts), `showSkillOverrideForm(~~ctx~~,
  container, baseSkill, assignment, onDone)` (profile_skills_overrides.ts, wołacz
  profile_skills.ts), `_renderBrainLogCard(~~ctx~~, el, adapter, logPath)` i
  `_renderMemorySessions(ctx, el, adapter, ~~basePath~~, memory, rerender)` (oba
  profile_memory.ts) — parametry usunięte z sygnatur i wywołań, żadna nie jest wymuszona
  kontraktem interfejsu.
- **Martwy import** `openHiddenFile` w `profile_advanced.ts:7` skasowany (147) — funkcja żyje
  (`profile_memory.ts`, `profile_persona.ts`), martwy był tylko ten jeden import.
- **Cross-module (`modules/chat/chat/TokenViewerWidget.ts`, 134):** martwy fallback
  `agent?.models?.[legacyKey]` w `resolveRoleMax` skasowany — `Agent._normalizeModelOverrides`
  kasuje `models.minion`/`models.master` przy KAŻDEJ konstrukcji/aktualizacji, więc ten człon
  zawsze zwracał `undefined`. Bliźniaczy `pkm?.modelLibrary?.[legacyKey]` (biblioteka modeli
  w ustawieniach) ZOSTAJE — inny, żywy slot (potwierdzone `modelResolver.test.ts`).
- **076 — bez zmian.** Dowód finding-u wskazuje `modules/agents/toolAxis.ts` (`BUILTIN_TOOL_GROUPS`)
  jako ŻYWY licznik, wobec którego rozjechała się martwa `modules/prompts/PromptBuilder.TOOL_GROUPS`
  — nic do skasowania po stronie `agents`; naprawa (jeśli będzie) należy do `modules/prompts`.

**Parking (nie ruszone w tym biegu, decyzja poza D2):** 173 (`modelLibrary.master`), 119, 068
(`agents:changed`), typy z barrela (066-typy/015/107), `modelFieldSync.ts`/`AgentProfileView.ts`
budowa `formData.model`/`models`/`profile_advanced.ts` select modelu (świeżo naprawione w B6,
strażnik `modelFieldSync.wiring.test.ts` zostaje zielony — nie dotknięty).

## Klaster C4 update (2026-09-03) — C1: diff-only override built-ina; C2: `model` pisany tylko ze źródła

Dwie naprawy z risk registeru 2026-09-02 / S34 z8, jeden commit `fix(agents)`.

- ⚠️ **C1 — `AgentLoader.saveBuiltInOverrides` pisze DIFF względem `createJaskier()`, nie pełen
  `serialize()`.** Do tej naprawy KAŻDY zapis profilu Jaskra wpisywał do `jaskier_overrides.yaml`
  całą serializowaną konfigurację (emoji, color, personality, disabled_tools…), nawet gdy user
  zmienił jedno pole — nota do rejestru z B6 Rundy 3 (punkt 5). Nowy `diffAgentConfig(current,
  baseline)` (`AgentLoader.ts`, pure, deep-equal order-independent dla obiektów / order-sensitive
  dla tablic) zostawia tylko klucze różniące się od `createJaskier().serialize()`. Odczyt
  (`_mergeBuiltInOverrides` → `agent.update(data)` na ŚWIEŻEJ instancji Jaskra) jest z natury
  kompatybilny — pominięte pole po prostu zostaje na wartości fabrycznej. Pole nieobecne
  w baseline, a ustawione na agencie (np. `agent_rules`), jest zawsze zapisywane (baseline[key]
  jest `undefined`, nigdy nie jest deep-equal realnej wartości). Strażnik:
  `AgentLoader.builtInOverrides.test.ts` (8 testów, w tym round-trip przez `loadBuiltInAgents`).
- ⚠️ **C2 — `Agent._modelFromSource` bramkuje zapis legacy `model`.** `serialize()` pisało
  `model:` zawsze, gdy `this.model` było prawdziwe — bez względu na to, SKĄD ta wartość
  przyszła. Nowa flaga `_modelFromSource` (ustawiana w konstruktorze na obecność klucza `model`
  w danych wejściowych, i w `update()` przy jawnym kluczu `model`) jest DRUGIM warunkiem obok
  `this.model` truthy. Silnik nie ma żadnego mechanizmu auto-fill dla `model` — jedyne dwie
  drogi, którymi `this.model` w ogóle dostaje wartość, to konstruktor (yaml na dysku) i
  `update()` (UI albo migracja nadpisań built-ina); bezpośrednie przypisanie `agent.model = x`
  z pominięciem `update()` NIE ustawia flagi i serialize() takiej wartości nie wypisze — bramka
  jest zaporą na przyszłość, nie tylko łatą na dziś (grep repo w trakcie tej naprawy nie znalazł
  ŻADNEGO produkcyjnego wołacza, który obecnie pisze `agent.model` z pominięciem `update()`;
  konkretny historyczny bug — auto-kopiowanie `models.main` → `model` przy KAŻDYM zapisie
  profilu — był w warstwie UI i został naprawiony wcześniej, w B6 Rundach 1-3, patrz
  `modelFieldSync.ts`). `models.main` NIE dostało analogicznej flagi — silnik nie ma żadnej
  ścieżki, która wypełnia `models{}` automatycznie (jedyne writery to konstruktor i `update()`
  z jawnym kluczem `models`), więc kryterium „ze źródła albo jawnie" jest tam już spełnione
  strukturalnie. `language` i inne ZNANE pola Agenta (temperature, personality, disabled_tools…)
  przeżywały round-trip load→save już wcześniej (E2.8 A6, sprzed zgłoszenia Niki) — regres
  zamknięty testem, nie nową logiką. Strażnik: `Agent.test.ts` (6 testów „C2:", w tym dowód
  mutacyjny na bramkę i test na obejście `update()`).
- 🟡 **Świadomie NIE zrobione (open point, decyzja produktowa poza tym zadaniem):** werdykt Kuby
  mówił też „nieznane pola z yamla mają przeżyć round-trip (zachowaj je w Agent jako extra i
  emituj w serialize)". Sprawdzone i ODRZUCONE — dokładnie ten pomysł (generyczny raw-passthrough
  nieznanych pól YAML na `this`) był już „ROZWAŻONY i ODRZUCONY" w B6 Rundzie 3 punkt 5, z
  udokumentowanym powodem: złamałby kontrakt pól-widm, które projekt CELOWO czyta-i-porzuca
  (`can_message`, `playbook_overrides`, `archetype`/`role`, `enabled_tools`, `type`, `minion*`/
  `master*`, `persona_drift`, `default_mode`, `sub_agent_enabled`) — `Agent.test.ts` ma na to
  wprost testy asercji `agent.can_message === undefined` / `agent.playbook_overrides ===
  undefined` po load, które generyczny passthrough by cofnął (zweryfikowane: implementacja
  „zachowaj wszystko nieznane jako extra" psuje te testy). Silnik nie ma sposobu odróżnić
  „pole naprawdę nowe/przyszłe" od „pole świadomie skasowanego bytu" bez ręcznie utrzymywanej
  listy wyjątków — a taka lista duplikowałaby wiedzę, która już żyje (i bywa zmieniana) w
  konstruktorze i migracjach `AgentLoader`, z realnym ryzykiem rozjazdu. Zamiast zgadywać,
  zostawione jako pytanie do Kuby: czy chodziło o konkretne, nazwane pole (wtedy: jedna gałąź
  wzorem `language`, dopisana jawnie i przetestowana — styl modułu), czy o coś innego niż
  literalny „nieznane pola" (może chodziło wyłącznie o `model`+`language`, oba już pokryte wyżej
  bez potrzeby generycznego mechanizmu).

## Klaster C4b update (2026-09-03) — nity na recenzję C4: diff-only miał dwie dziury

Recenzja C4 (opus) znalazła dwie dziury w `AgentLoader.saveBuiltInOverrides` (C1 wyżej) — jeden
commit `fix(agents)`.

- ⚠️ **A1 — meta-pola, które `_mergeBuiltInOverrides` sprawdza PRZED zastosowaniem diffu, muszą
  być zapisywane ZAWSZE, nawet gdy `diffAgentConfig` uznałby je za identyczne z baseline.**
  `access_policy_version` jest jedynym takim polem: `Agent.serialize()` pisze je BEZWARUNKOWO
  (zawsze BIEŻĄCA `ACCESS_POLICY_VERSION`), więc baseline (`createJaskier().serialize()`) ma
  DOKŁADNIE tę samą wartość co zapisywany agent — `diffAgentConfig` je wycinał jako
  „bez zmiany". Efekt: diff-only plik nadpisań nigdy nie niósł `access_policy_version`, więc
  KAŻDY kolejny load widział `accessVersion 0 < 2`, odpalał `migrateAccessPolicy` (dopisując
  `default_permissions.guidance_mode:true`, gdy `focus_folders` puste — co u Jaskra jest
  domyślne), przepisywał plik i logował „Migrated built-in override" — **po każdym zapisie
  profilu, w nieskończoność**, dokładnie odwrotność tego, co C1 miało osiągnąć. Naprawa: nowa
  stała `ALWAYS_WRITTEN_META_FIELDS = ['access_policy_version']` w `AgentLoader.ts` — po
  policzeniu diffu `saveBuiltInOverrides` dopisuje te pola z `data` (bieżący serialize) na
  wierzch, bezwarunkowo. `default_permissions` NIE trafiło na tę listę — samo
  `access_policy_version` wystarcza, bo `migrateAccessPolicy` short-circuituje na nim jako
  PIERWSZYM sprawdzeniu (`accessVersion >= ACCESS_POLICY_VERSION` → `return` natychmiast, zero
  dotykania `default_permissions`). Strażnik: `AgentLoader.builtInOverrides.test.ts` „A1:" —
  zapis na nietkniętym Jaskrze niesie `access_policy_version`, a kolejny `loadBuiltInAgents()`
  wywołuje ZERO zapisów i zostawia treść pliku bit-w-bit identyczną.
- ⚠️ **A2 — baseline diffu był hardcode'owany na `createJaskier()` dla KAŻDEGO
  `agent.isBuiltIn`, nie tylko dla Jaskra.** Dziś nieszkodliwe (Jaskier to jedyny built-in —
  `loadBuiltInAgents()` zwraca wyłącznie `[jaskier]`), ale bomba zegarowa: drugi built-in
  policzyłby diff względem CUDZEGO baseline'u — pola identyczne przypadkiem z configiem Jaskra
  znikałyby z pliku nadpisań (mimo że to celowa wartość drugiego agenta), pola różne od Jaskra
  ale zgodne z WŁASNYM baseline'em wyciekałyby jako rzekoma zmiana. Naprawa: rejestr
  `BUILT_IN_BASELINES: Record<string, () => Agent>` (dziś: `{ Jaskier: createJaskier }`) —
  `saveBuiltInOverrides` szuka fabryki po `agent.name`. Trafienie → diff jak w C1 (+ whitelist
  A1). Brak trafienia (built-in bez zarejestrowanego baseline) → **fallback na zachowanie
  sprzed C1** (pełny `serialize()`, bez diffowania) + `log.warn` z podpowiedzią, żeby dopisać
  agenta do rejestru — bezpieczniejsze niż zgadywanie, kosztem chwilowego powrotu do „C1 leaku"
  dla TEGO JEDNEGO nowego built-ina, dopóki ktoś nie doda go do `BUILT_IN_BASELINES`. Strażnik:
  `AgentLoader.builtInOverrides.test.ts` „A2:" — atrapa drugiego built-ina (`isBuiltIn:true`,
  nazwa spoza rejestru) dostaje plik równy jej własnemu pełnemu `serialize()`.
- 🟡 **Dopisz nowego built-ina razem z jego fabryką w `BUILT_IN_BASELINES`** — to teraz jedyne
  miejsce, które trzeba zaktualizować przy dodaniu drugiego agenta wbudowanego (poza samym
  `loadBuiltInAgents()`, które dziś i tak zwraca statyczną listę `[jaskier]`).
