# modules/tools/

> **Rename E3.1 faza D (2026-07-24):** moduł dawniej `modules/mcp/` — przemianowany na `tools`, bo trzyma i built-in narzędzia agenta, i klient external MCP (`ExternalMcpManager`). Historyczne wpisy niżej (opisy sprintów, changelogi, Historia) świadomie zostawiają starą ścieżkę.

**MCP runtime + 23 built-in narzędzia** (w 8 manifestach; 48 przed E2.5 → 37 po E2.5 → 34 po E2.6 → 32 po E2.4 D17 → 34 po E2.9 artefakty żywe + todo → 33 po E3.1 faza C (kasacja `connect_to_server` razem z sandboxem custom-JS) → **23 po S28 Komunikator v3** (kasacja `agent_message` + 12 `kom_*` Project Hub — patrz „Historia" niżej; zmierzone `tools[]` z 8 manifestów, 2026-08-27)). Plugin uruchamia:
1. **Built-in tools** — wbudowane narzędzia agenta (read, list, write, memory_save, delegate, web_search, ...)
2. **External MCP servers** — zewnętrzne serwery przez prawdziwy klient MCP (`ExternalMcpManager`, stdio/HTTP przez `@modelcontextprotocol/sdk`), konfigurowane w ustawieniach pluginu (`data.json`), NIE w vaulcie.

Plus **8 wbudowanych manifestów built-in** (`core`, `artifacts`, `vault`, `memory`, `web`, `multimodal`, `delegation`, `komunikator`) — patrz `built-in-servers/`. Serwer `skills` został skasowany w E2.4 D17; skille są przepisami czytanymi przez prymityw `read`.

**Status:** 🚀 **ACTIVE.** Kod fizycznie w `modules/tools/` (dawniej `modules/mcp/`, rename E3.1 faza D) od Mapy-12 (2026-04-26). 48 plików bez testów (~6,000 LOC) — narzędzia + 8 manifestów + helpery + klient external.

> **Kampania TS, fala TS-3 (2026-07-31) — infrastruktura modułu na TypeScripcie.** `MCPClient`,
> `ToolRegistry`, `ToolLoader`, `ServerLoader`/`ServerManager`, `ExternalMcpManager`,
> `server_timeout`, `toolAliases`, `mcpServerPresets`, `claudeConfigImport`, 8 manifestów
> `built-in-servers/` + ich `index`, `SettingsContent`/`SettingsSection`,
> `BackstageTab`/`ConnectorsBackstageTab` i barrel — czysta konwersja typów, ZERO zmian
> zachowania. Specifiery importów zostają z `.js` (kontrakt kampanii, raport TS-0).
>
> **Ta sama fala, druga połowa — PLIKI NARZĘDZI na TypeScripcie.** Prymitywy vaultowe
> (`read`/`list`/`write`/`delete`/`create_folder`/`search`), pamięć (`memory_save`/`memory_delete`),
> web, multimodal, delegacja (`delegate`/`agent_delegate`/`ask_user`), poczta (`KomunikatorTools`),
> `built-in-servers/artifacts/` w całości i helpery (`vault_path_validator`, `vault_adapter_io`,
> `vault_binary_io`, `semanticNote`, `text_overlay_helper`) + ich testy. Każdy plik niesie
> LOKALNE typy strukturalne `App`/`plugin` (tylko to, czego dotyka) — `PluginBase` NIE jest
> importowany, bo to deep-import, a barrel `core` go nie eksportuje.

**Sprint Refaktoru — który mnie dotyka:**
- [Sprint 01 Quick Wins + Security](../../Refaktor/Sprinty/SPRINT_01_Quick_Wins_Security.md) ✅ **DONE** (2026-04-27) — Z2 sanitizePath na image_path w `AddTextToImageTool.js` (SEC-1 🔴 → ✅ commit `b3f0297`) + Z3 MCPClient broken dynamic import fix (B-1 🔴 → ✅ commit `fcef7a3`, real plik to `modules/mcp/MCPClient.js` nie shell — Sprint Notka miała błąd ścieżki)
- [Sprint 03 Memory v2 GIGANT](../../Refaktor/Sprinty/SPRINT_03_Memory_v2_Retrieval_v2.md) — Z13-Z14 dodanie 9 nowych tools (5 vault: filter_yaml/grep/links/semantic/glob + 4 memory analogi)
- ✅ [Sprint 04 MCP_PORZADEK_v1](../../Refaktor/Sprinty/SPRINT_04_MCP_Porzadek_v1.md) **DONE (2026-04-28)** — 3 filary wdrożone:
  - **Filar 1 — built-in vs user-added separation:** 7 manifestów w `modules/mcp/built-in-servers/` (core/vault/memory/web/multimodal/delegation/skills) bundled w plugin. User serwery w vault `.pkm-assistant/mcp-servers/`. `ServerLoader` z `source: 'built-in'|'user'` field + built-in name protection (user nie nadpisuje built-in).
  - **Filar 2 — permissions per rola:** `ToolRegistry.filterByAgent(agent)` + `agent.yaml.mcp_servers[]` whitelist (default `['vault','memory','core']`) + sub-agent intersection w `SubAgentRunner._getTools(toolNames, parentAgent)` + `can_message[]` whitelist (Z5).
  - **Filar 3 — extensibility UI:** Settings → SEKCJA 10 MCP Servers + `MCPServerEditorModal` (Add New) + 3 templates (basic/vault-helper/api-call) + `checkSandboxSafety()` regex pre-save.
  - **Plus:** timeout 60s default + 180s ceiling (Z6), reverse dep mcp→comfy fix przez `text_overlay_helper.js` (Z7), `vault_path_validator.js` DRY (Z8), naming standaryzacja + alias resolver `image_path/file/dir/pattern → path/folder/glob` (Z9), `tool.contextExtractor` PoC (Z10), **45 nowych unit tests** (Z11). 8 znalezisk MC + 1 KO + 1 CF skreślone.
- [Sprint 08 Komunikator v2 + Agora wywałka](../../Refaktor/Sprinty/SPRINT_08_Komunikator_v2_Agora_Wywalka.md) — Z4 12 nowych tools `kom_*` (projekty/threads/briefy)
- ✅ [Sprint 09 Artefakty v2 + chat housekeeping](../../Refaktor/Sprinty/SPRINT_09_Artefakty_v2_Chat_Housekeeping.md) **DONE** (2026-05-01) — Z10: artefaktowe narzędzia (`chat_todo`, `idea_review`, `plan_review`) wyniesione z core do `built-in-servers/artifacts/` (nowy 9. manifest) + Z1 `plan_action`/`PlanTool` wywałka + S05.5 hotfix (2026-05-01) z chat_todo pipeline DRY (`createChatTodoFromPlanReview` w `modules/artifacts/`).
- ✅ [Sprint 10 Settings v2 + Backstage v2](../../Refaktor/Sprinty/SPRINT_10_Settings_v2_Backstage_v2.md) **DONE (2026-05-02 + hotfix)** — `modules/mcp/SettingsContent.js` renderuje Web Search, Image Gen, STT i MCP Servers; `SettingsSection.js` rejestruje realne rendery bez legacy delegate. `MCPServerEditorModal` zostaje w shell.

---

## Co tu jest (kod obecnie)

```
modules/tools/ServerManager.ts        # lifecycle built-in serwerów + ToolRegistry rejestr
modules/tools/ServerLoader.ts         # ładowanie built-in manifestów (E3.1: user-folder scan wycięty)
modules/tools/ExternalMcpManager.ts   # E3.1 — prawdziwy klient MCP (stdio/HTTP przez SDK); external tools → source:'user' RED

modules/tools/                        # built-in tools + infrastructure
├── ToolRegistry.ts                   # registry + Sprint 04 filterByAgent() + BUILTIN_TOOL_MAP
├── SettingsContent.ts                # S10 hotfix — Web Search / Image Gen / STT / MCP Servers settings
├── SettingsSection.ts                # S10 — rejestracja Web Search + MCP Servers
├── MCPClient.ts                      # client + Sprint 04 normalizeArgsAliases (Z9)
├── DelegateTool.ts                   # delegacja do sub-agentów
│
├── Prymitywy plikowe (E2.6, API-first):
│   ├── ReadTool.ts, ListTool.ts                       # read/list — scope vault|memory (bramka pamięci fail-closed)
│   ├── WriteTool.ts, DeleteTool.ts, CreateFolderTool.ts  # write/delete/create_folder — vault-only
│   └── SearchTool.ts                                   # search — hybryda keyword+semantic (RRF); silnik RetrievalEngine (modules/memory)
│       # E1.4: semanticNote.ts dokłada notę degradacji gdy L3 (żywy z VaultIndexer) spada do L2.
│       # E2.5/E2.6: search + read/list wchłonęły 15 dawnych narzędzi vault_*/memory_* (patrz changelogi niżej).
│
├── Pamięć (E2.6): MemorySaveTool.ts (create-only + ephemeral „Na teraz"), MemoryDeleteTool.ts
│   # Odczyt / streszczenia / sesje pamięci = read/list/search scope=memory (nie osobne narzędzia).
│
├── Web (2): WebSearchTool.ts, WebReadTool.ts
├── Multimodal (2): GenerateImageTool.ts, AddTextToImageTool.ts (path canonical; E3.2 bez ComfyUI)
├── Delegacja/komunikacja: AgentDelegateTool.ts, KomunikatorTools.ts (kom_send/kom_list/kom_read)
│   # DelegateTool.ts — wyżej (delegacja do sub-agentów). AskUserTool.ts — serwer core.
│   # AgentMessageTool.js + KomunikatorProjectTools.js (12 kom_* Project Hub) SKASOWANE w S28 (2026-07-29).
│
├── built-in-servers/                   # 8 manifestów + index.ts + podfolder artifacts/
│   ├── core.manifest.ts                # ask_user (1) — always-on, removable=false
│   ├── vault.manifest.ts               # read/list/write/delete/create_folder/search (6)
│   ├── memory.manifest.ts              # memory_save/memory_delete (2) — odczyt scope=memory bramkowany uprawnieniem
│   ├── web.manifest.ts                 # web_search/web_read (2)
│   ├── multimodal.manifest.ts          # generate_image/add_text_to_image (2, timeout_ms:180000 deklaratywne — nieegzekwowane, patrz gotcha AUD-code-review-003)
│   ├── delegation.manifest.ts          # delegate/agent_delegate (2) — agent_message OUT w S28 (kom_send zastępuje pocztę), connect_to_server OUT (E3.1 faza C)
│   ├── artifacts.manifest.ts           # artifact_create/read/update/list + todo (5)
│   ├── komunikator.manifest.ts         # kom_send/kom_list/kom_read (3) — S28 Komunikator v3, Project Hub SKASOWANY
│   ├── artifacts/                      # ArtifactCreate/Read/Update/ListTool.ts + TodoTool.ts + index.ts (E2.9)
│   └── index.ts                        # resolveBuiltinManifests({pluginVersion}) + getBuiltinManifest(name)
│
├── Helpery (bez obsidian / testowalne AVA):
│   ├── server_timeout.ts               # resolveTimeoutMs/DEFAULT_TIMEOUT_MS/MAX_TIMEOUT_MS (60s default, 180s ceiling)
│   ├── text_overlay_helper.ts          # renderTextOverlay() Canvas2D (alias renderTextOnImage OUT w E3.2)
│   ├── vault_path_validator.ts         # validateVaultPath/Folder() + wyjątek allowSkillsRead (E2.4 D17)
│   ├── vault_adapter_io.ts             # listAdapterFolder + isHiddenVaultPath dla dotfolderów .pkm-assistant (A1-A4 admin)
│   │                                   #   S30 Z3: ensureAdapterFolder (mkdir -p) przeniesiony do core/utils/vaultFs.js,
│   │                                   #   tu został re-eksport pod tą samą nazwą (Write/CreateFolderTool importują stąd)
│   ├── vault_binary_io.ts              # createBinary/modifyBinary/readBinary (obrazy) + app-aware ensureFolder
│   │                                   #   + isFolderLike — S30 Z3: JEDNA kopia dla modułu (było 5)
│   ├── toolAliases.ts                  # stare nazwy → nowe prymitywy/serwer (backward-compat; remap w MCPClient)
│   └── semanticNote.ts                 # buildSemanticNote — nota degradacji L3→L2
│
└── *.test.ts (28 plików, jako siblings)  # ReadTool/ListTool/SearchTool/MCPClient/ToolRegistry/
                                          #   ExternalMcpManager/AdminVaultTools/... + built-in-servers
# E3.1 faza C: ServerExecutor(.test) + templates/(.test) + skills.manifest SKASOWANE (sandbox custom-JS out)
```

Razem **~6,000 LOC bez testów** (48 plików: narzędzia + infrastruktura + 8 built-in manifestów + helpery; testy jako siblings `*.test.ts`, **28 plików** — zmierzone `git ls-files modules/tools | grep -c '\.test\.ts$'`, 2026-08-27).

---

## Public API

`modules/tools/index.ts` — **30 eksportów RUNTIME, wszystkie WYPISANE Z NAZWY** (zmierzone: nazwane
bindingi przed blokiem `export type`, po AUD-dead-code-016/209 2026-09-02). S30 Z4 skasował `export *`
z tego barrela (patrz niżej). TS-3 dołożył blok `export type` (kontrakty klienta MCP, config serwera
external, manifest built-in, worki DI Ustawień/Zaplecza) — `export type` znika przy transpilacji,
więc powierzchnia runtime'u jest dokładnie ta sama.

**Runtime + registry (4):** `ToolLoader` SKASOWANY (fix TS-3 #10, 2026-07-31) — nie jest już
eksportem. `ServerLoader` zdjęty z barrela w AUD-dead-code-016/209 (2026-09-02) — zero konsumentów
poza modułem; klasa dalej żyje, `ServerManager` ją deep-importuje u siebie (`./ServerLoader.js`),
testy też idą deep-importem.
- `ServerManager` — runtime built-in serwerów
- `ExternalMcpManager` — klient external MCP (E3.1, stdio/HTTP)
- `ToolRegistry` (Sprint 04: + `filterByAgent(agent)` + `getBuiltinServerForTool(name)` + `getBuiltinServerMap()`)
- `MCPClient` (Sprint 04: + static `MCPClient.normalizeArgsAliases(args, toolName)` Z9)

**Presety + import external MCP (2):** `MCP_SERVER_PRESETS`, `getMcpServerPreset` (S32 Z2.2) —
5 gotowych serwerów zaszyte w kodzie, konsumuje `modules/shell/MCPServerEditorModal`.

**Fabryki narzędzi (21)** — `createDelegateTool`, `createAgentDelegateTool`, `createReadTool`,
`createListTool`, `createWriteTool`, `createDeleteTool`, `createCreateFolderTool`,
`createSearchTool`, `createMemorySaveTool`, `createMemoryDeleteTool`, `createArtifactCreateTool`,
`createArtifactReadTool`, `createArtifactUpdateTool`, `createArtifactListTool`, `createTodoTool`,
`createWebSearchTool`, `createWebReadTool`, `createAskUserTool`, `createKomunikatorTools`,
`createGenerateImageTool`, `createAddTextToImageTool`.
> ⚠️ To jedyna lista, z której korzysta `src/main.js` (rejestracja narzędzi). **Dodajesz
> narzędzie → dopisujesz fabrykę TUTAJ**; bez tego `main.js` jej nie zobaczy, a build
> wywali się natychmiast na nieistniejącym eksporcie.
>
> **AUD-dead-code-020/089 (2026-09-02):** 16 z tych fabryk brały `app`, którego nigdy nie
> czytały (realny `app` dociera do narzędzia dopiero jako 2. argument `execute(args, app,
> plugin)` — kontrakt spisany w `ToolRegistry.ts`) — parametr zdjęty z sygnatur
> (`createAddTextToImageTool`, `createAgentDelegateTool`, `createAskUserTool`,
> `createArtifactCreateTool/ListTool/ReadTool/UpdateTool`, `createTodoTool`,
> `createDeleteTool`, `createGenerateImageTool`, `createKomunikatorTools`,
> `createMemoryDeleteTool/SaveTool`, `createWebReadTool/SearchTool`, `createWriteTool`) i
> z wywołań w `src/main.ts` — te dwa rzutowania `as PluginDynamic`, które obchodziły arność
> dla `createReadTool`/`createListTool`, są teraz zbędne i skasowane. `createDelegateTool`,
> `createCreateFolderTool` i `createSearchTool` NIE są w tej fali: pierwsze dwie realnie
> czytają `app`, trzecia już dawno go nie brała.

**Settings + Zaplecze (2):** `registerSettings`, `registerBackstage`.

**Cykl życia (1):** `stopAllDelegations(reason)` — Z7, wołane z `PluginBase.onunload` (patrz Gotchas).

### S30 Z4 — koniec z `export *` (4 przecieki zamknięte)

Barrel miał 23 gwiazdki. Gwiazdka wynosi **wszystko**, co plik eksportuje — więc razem
z fabrykami wyciekały na zewnątrz modułu rzeczy, które nigdy nie miały być publiczne:

| Przeciek | Skąd | Status po Z4 |
|---|---|---|
| `__test__` | `DelegateTool.js` (hak testowy: `_resolveDelegate`, `_withTimeout`, `resolveGenericWorkerConfig`) | poza barrelem; testy deep-importują `./DelegateTool.js`, a `modules/agents/factoryTemplates.test.js` — `'../tools/DelegateTool.js'` |
| `TodoFileStore`, `TODO_FOLDER` | `built-in-servers/artifacts/index.js` (podwójna gwiazdka) | poza barrelem; żyją w `TodoTool.js`, wołane u siebie + w `TodoTool.test.js` |
| `renderTextOverlay` | `AddTextToImageTool.js` — re-eksport dopisany „dla barrela" w S04 Z7 | re-eksport USUNIĘTY; funkcja żyje w `text_overlay_helper.js`, importuje ją `AddTextToImageTool`. Jedynym konsumentem zewnętrznym był modal z wywalonego `modules/comfy` (E3.2) |

### Bebechy — NIE w barrelu (deep-import wewnątrz modułu + w testach)

Poprzednia wersja tej sekcji wymieniała je jako „Public API / Sprint 04 dodatkowe" —
**nigdy nie były eksportowane z `index.js`** (nawet przez gwiazdkę, bo ich plików barrel
nie dotykał). Sprostowane w S30 Z4:

- `validateVaultPath` / `validateVaultFolder` — `vault_path_validator.ts` (tam też
  `invocationHasAdminAccess` + `getInvocationAgentName`; S30 Z3: jedna kopia zamiast 3
  w Read/List/SearchTool)
- `resolveTimeoutMs` — `server_timeout.ts`. `DEFAULT_TIMEOUT_MS` / `MAX_TIMEOUT_MS` NIE są
  exportowane od AUD-dead-code-019 (2026-09-02) — zero konsumentów nawet deep-importem,
  czytane wyłącznie przez `resolveTimeoutMs` u siebie
- `BUILTIN_MANIFESTS` / `resolveBuiltinManifests` / `getBuiltinManifest` — `built-in-servers/index.ts`
  (8 aliasów `coreManifest`…`komunikatorManifest` skasowane w AUD-dead-code-017/210, zero konsumentów)
- `buildSemanticNote` — `semanticNote.ts`; `resolveToolAlias` / `isToolAlias` — `toolAliases.ts`;
  `listAdapterFolder` / `isHiddenVaultPath` / `ensureAdapterFolder` — `vault_adapter_io.ts`;
  `isFolderLike` + I/O binarne — `vault_binary_io.ts`

---

## External MCP (E3.1) — prawdziwy klient MCP

Sandbox custom-JS (`ServerExecutor`, `new Function()`) **wyburzony w E3.1 faza C** — user
nie ładuje już `.js` z vaulta. Zewnętrzne serwery obsługuje `ExternalMcpManager`:

- **Transport:** `stdio` (lokalny proces, TYLKO desktop — gate `Platform.isMobile`) albo
  `http` (`StreamableHTTPClientTransport`, też mobile). SDK + `child_process` importowane leniwie.
- **Rejestracja:** narzędzia serwera wchodzą do `ToolRegistry` jako `<serverId>__<toolName>`
  z `source:'user'` + `serverName` → `MCPClient` liczy `isExternalTool` → `classifyToolRisk`
  daje **RED bezwarunkowo** (kontrakt E3.0, nietknięty).
- **Zaufanie (D-B):** RED = obowiązkowy PIERWSZY approval; modal ma „Zawsze zezwalaj (to
  narzędzie)" → trwała reguła `external.call::<prefixedToolName>` w `ApprovalManager`.
- **Akcja:** `external.call` w `ACTION_PERMISSIONS` (nie-vault, bez path-checków, wzór web).
- **Konfiguracja:** `settings.pkmAssistant.externalMcpServers[]` w `data.json` (komenda+env / URL+headers
  mogą nieść sekrety — NIE synchronizują się z vaultem). Opt-in per agent = `mcp_servers[]`.
- **Wynik → tekst (S32 Z2.1):** `normalizeMcpResult` (pure, eksportowana) skleja `content[]` na
  czysty string; obrazek zostaje jedną adnotacją `[image image/png, ~123 kB]` zamiast base64.
  Wpięta w `execute` wrappera — `callTool` nadal zwraca surowy wynik SDK.
- **Presety + import (S32 Z2.2/Z2.3):** `mcpServerPresets.js` (5 gotowych serwerów, dane w kodzie)
  wypełniają formularz edytora; `claudeConfigImport.js` przenosi serwery z Claude Desktop.
- **401 (S32 Z2.4):** `connect` podmienia `401`/`Unauthorized` na instrukcję i18n
  (`settings.mcp_external_error_401`). Interaktywnego OAuth NIE MA — token wpisuje się w Nagłówkach.

- **Podgląd przed zapisem (S33 Z3):** `previewTools(serverConfig)` — efemeryczna próba
  (własny klient + transport → `connect` → `listTools` → **`close`**), zwraca
  `[{name, description}]` albo `{success:false, error}` z komunikatem przez `maskSensitiveData`.
  **NICZEGO nie rejestruje** w `ToolRegistry` i nie dotyka `_connections`/`_status` — podgląd
  nie jest „połączeniem". Stdio na mobile odbija się o ten sam gate co `connect`. Wołacz:
  `MCPServerEditorModal` (guzik „Sprawdź połączenie i pokaż narzędzia", config z pól formularza,
  bez zapisu).
- **Kill-switch per serwer (S33 Z3):** `cfg.enabled === false` = serwer nie dostarcza narzędzi.
  Przełącznik w Ustawieniach → Serwery MCP robi `persist()` + `close(id)` (narzędzia znikają
  z rejestru od razu), blokuje guzik „Połącz" i pokazuje stan „WYŁĄCZONY". `autostart()` już
  wcześniej respektował `enabled` — nietknięty. `MCPServerEditorModal` **zachowuje** istniejące
  `enabled` przy edycji (default `true` tylko dla NOWEGO serwera; wcześniej wpisywał `true`
  bezwarunkowo, więc edycja po cichu odwracała wyłączenie usera).
- **Argumenty w approvalu (S33 Z3):** `MCPClient._extractToolContext` dokłada do
  `approvalContext` pole `externalArgs` (kopia argumentów bez `_invocation*`), a `ApprovalModal`
  renderuje je jako JSON (indent 2, cięcie ~1500 znaków). `approvalTarget`/`targetPath`
  i mechanika „zawsze zezwalaj" — NIETKNIĘTE.
- **Jeden filtr znaczników:** `ExternalMcpManager.stripInternalArgs(args)` (static, publiczny) —
  używa go i wysyłka (`callTool` przez `_stripInternal`), i podgląd w approvalu. Wejścia
  nie-obiektowe (null/tablica/string) wracają nietknięte.

Bramka `.pkm-assistant/**` + No-Go + `sanitizePath` w prymitywach vaultowych bez zmian.

---

## Zależności

**Importuje z:**
- `core` (AccessGuard, SensitiveDataGuard, sanitizePath, isProtectedPath, Logger, i18n)
- `modules/memory/` (memorySearchHelper potrzebuje EmbeddingHelper)
- `modules/sub-agents/` (DelegateTool wywołuje SubAgentRunner)
- `modules/skills/` (SkillExecuteTool)

**Importowany przez:**
- `main.js` (rejestracja built-in tools)
- `SubAgentRunner` (filter tools per sub-agent)
- ChatView (gdy agent woła tool)
- Większość views (UI dostępu do tooli przez `ToolRegistry.get()`)

---

## Kluczowe decyzje

- **Built-in vs external MCP servers** — built-in kompilowane w `dist/main.js`; zewnętrzne przez `ExternalMcpManager` (prawdziwy protokół MCP, stdio/HTTP). Identyczny shape rejestracji w `ToolRegistry` (`{name, description, inputSchema, serverName, source, execute}`).
- **Sandbox custom-JS (`new Function()` + shadowed globals + `ServerExecutor`) — WYBURZONY w E3.1 faza C.** Nigdy nie był granicą bezpieczeństwa (prototype-chain escape); zastąpiony prawdziwym klientem MCP + kontraktem `source:'user'` → RED.
- **`sanitizePath` w każdym prymitywie vaultowym** który dotyka path (sesja 104, 106) — `../`, URL-decoded traversal, null bytes, zero-width unicode. 33 testy security.
- **`SensitiveDataGuard`** — mask API keys w logach + w results (gdyby tool zwrócił przez błąd).

---

## Gotchas

- ⚠️ **Z7 (AUD-bledy-056): bieg delegacji ma DWÓCH właścicieli — rejestr i moduł.** Uchwyt
  trafia do `SubTaskRegistry` dopiero w `onTaskCreated`, czyli PO rozwiązaniu configu, budowie
  modelu i promptu (dysk!). Dlatego `DelegateTool` trzyma własny zbiór żywych kontrolek abortu
  (`_liveAborts`, stan MODUŁU jak `_backgroundRuns`) i wystawia `stopAllDelegations(reason)`:
  `onunload` woła NAJPIERW `subTaskRegistry.stopAll('unload')` (ślad w trace), potem to —
  inaczej bieg złapany w tym oknie startował pętlę już po wyładowaniu pluginu. Kontrolka schodzi
  ze zbioru w `finally` biegu, więc każda ścieżka delegacji musi to `finally` mieć.
- ⚠️ **AUD-bledy-030: budzik `ask_user` ma DWÓCH właścicieli — `finally` i cykl życia pluginu.**
  `clearTimeout` w `finally` zdejmuje go po rozstrzygnięciu wyścigu, ale w oknie oczekiwania (user
  jeszcze nie odpowiedział) obietnica nie rozstrzyga się nigdy i przy `onunload` budzik tykałby dalej
  na martwym pluginie. Uchwyt idzie więc dodatkowo przez `plugin.registerInterval?.(handle)`
  (`clearInterval` kasuje w JS uchwyty obu rodzajów). Rejestracja jest OPCJONALNA — host bez tej
  metody (testy) działa jak dotąd.
- ⚠️ **`ToolRegistry.filterByAgent(agent)` per agent (E2.8 C1)** — JEDNA oś: wszystkie built-in ON minus `agent.disabled_tools[]` (negatywna lista). Narzędzia zewnętrznych serwerów MCP dodatkowo gated pozytywną listą `mcp_servers`. Dawne bramkowanie po `agent.permissions.{read_notes,edit_notes,mcp,web_search,...}` / `enabled_tools` USUNIĘTE. Sub-agent = przecięcie z narzędziami rodzica (po `filterByAgent`)
- ⚠️ **K3 (2026-08-22): WIDOCZNOŚĆ i EGZEKUCJA to JEDNA funkcja — `ToolRegistry.checkToolAxis(agent, toolName)`.**
  `filterByAgent` to jej przelot po rejestrze (co model dostaje w definicjach narzędzi),
  a `MCPClient.executeToolCall` woła ją jako BRAMKĘ, zanim pobierze narzędzie z rejestru
  i zanim ruszy `checkPermission`. Do K3 istniał tylko filtr widoczności i model, który znał
  nazwę wyłączonego narzędzia (stara sesja, notatka, transkrypt innego agenta), wołał je
  bez żadnego oporu. **Nie dokładaj drugiego miejsca liczenia tej reguły** — dwie kopie
  rozjadą się przy pierwszej zmianie i wrócimy do „lista mówi co innego niż egzekutor".
  Trzy konsekwencje do zapamiętania:
  1. Sprawdzenie idzie na nazwie KANONICZNEJ, czyli PO `resolveToolAlias` — inaczej stara
     nazwa (`vault_write` → `write`) byłaby obejściem wyłączenia.
  2. Odmowa jest fail-closed i **nie pyta usera** (`Permission denied: ...`, bez modala) —
     to nie ryzyko do zaakceptowania, tylko narzędzie, którego user agentowi nie dał.
  3. Dla serwerów zewnętrznych **brak listy `mcp_servers` = brak opt-inu = odmowa**
     (dawniej brak listy znaczył `'*'`). Built-inów to nie dotyczy; `core`/`ask_user`
     jest nieusuwalny w obu drogach.
  Sub-agenci chodzą pod TOŻSAMOŚCIĄ RODZICA (`SubAgentRunner._executeTool` podaje
  `agent.name` rodzica), więc dostają tę bramkę za darmo; ich własna whitelista
  (przecięcie rodzic∩sub) odbija wywołanie jeszcze wcześniej, w `_executeTool`.
- ⚠️ **Zewnętrzne serwery MCP = kod, który uruchamiasz u siebie** — stdio spawnuje proces z Twoimi prawami, http wysyła dane rozmów do zdalnej usługi. Żaden sandbox ich nie ogranicza (custom-JS sandbox wyburzony w E3.1 faza C). Instaluj tylko z zaufanych źródeł; `source:'user'` → RED wymusza pierwszy approval.
- ⚠️ **K1 (2026-08-22): bramka i zlew oglądają JEDEN ciąg** — `MCPClient._extractToolContext` kanonizuje ścieżkę vaultową (`_canonicalizeToolContext` → `sanitizePath`) i **podmienia ją w argumentach**, zanim `checkPermission` cokolwiek oceni. Ścieżka nie do uratowania = odmowa `Permission denied: Invalid path`, bez pytania usera i bez `execute`. **NIE dokładaj własnej normalizacji ścieżek w narzędziach** — `validateVaultPath` w `execute` ma być idempotentnym powtórzeniem, nie drugą, inną interpretacją.
- ⚠️ **M (AUD-security-111): adresat poczty ma JEDEN kanon, liczony przed bramką.**
  `kom_send` toleruje cztery nazwy tego samego pola (`to`/`to_agent`/`agent`/`target`), a switch
  w `MCPClient` czytał dwie i wpadał na literał `'agent'` — modal mówił „wyślij do agenta
  »agent«", a klik „Zawsze zezwalaj" zapisywał regułę `agent.message::agent`, czyli auto-zgodę na
  pocztę do DOWOLNEGO adresata wysłaną tym samym synonimem. Dziś kanon liczy
  `resolveKomSendTarget` (`KomunikatorTools.ts`) i wołają go OBIE strony: `contextExtractor`
  narzędzia (cel bramki, opis w modalu, klucz reguły zgody) oraz `execute` (to, co leci do
  skrzynki). Kanonem jest **nazwa z rejestru** (`sonny` → `Sonny`), a nierozpoznany adresat
  zostaje DOSŁOWNY — cel od wołacza nigdy nie ma prawa zamienić się w wieloznacznik (K22).
  Powtórne rozwiązanie w `sendAgentMail` jest idempotentne, jak `validateVaultPath` przy K1.
  **Narzędzie, które toleruje synonimy argumentu niosącego CEL, sprowadza je do kanonu u siebie
  (`contextExtractor`) — nie licz na switch w kliencie.**
- ⚠️ **K2 (2026-08-22): narzędzie dotykające pliku MUSI podać bramce cel.** `PermissionSystem`
  odmawia fail-closed, gdy akcja z `TARGET_REQUIRED_ACTIONS` (`vault.write/create/create_folder/
  delete`, `artifact.create/update/read`, `image.generate`) przyjdzie z pustym `targetPath` —
  wcześniej pusty cel przeskakiwał No-Go, pliki chronione, whitelistę i `scope.folders` suba.
  Narzędzie bez pola `path` liczy cel w `contextExtractor` (wzór: `artifact_*` → `ArtifactStore.
  pathById`/`instancePathFor`/`artifactsRoot`; `generate_image` → `saveFolder` z ustawień;
  `add_text_to_image` → `output_path`). **Prompt/zapytanie NIE jest celem** — takie rzeczy jadą
  do `approvalContext` (`imagePrompt`), inaczej strażnik ocenia tekst pisany przez model.
  `output_path` należy do pól kanonizowanych przez `_canonicalizeToolContext`.
- ⚠️ **K16 (2026-08-23): `add_text_to_image` dotyka DWÓCH ścieżek — obie fail-closed.** CEL
  ZAPISU idzie przez bramkę `MCPClienta` (`image.generate` + `output_path`, K2 wyżej), a OBRAZ
  ŹRÓDŁOWY przez `PermissionSystem.checkPermission(agent, 'vault.read', ...)` WEWNĄTRZ narzędzia,
  przed `readBinary`. `validateVaultPath` na źródle nie wystarcza: zna `sanitizePath`, pliki
  chronione i granicę `.pkm-assistant/`, ale NIE zna No-Go, whitelisty `focusFolders` ani
  `scope.folders` suba. **Narzędzie, które CZYTA jeden plik i PISZE drugi, musi oddać bramce
  oba** — inaczej `{path:'Prywatne/skan.png', output_path:'Publiczne/kopia.png'}` przepisuje
  cudzy plik tam, gdzie agent sięga, a bramka widzi samą legalną połowę.
- ⚠️ **K4 (2026-08-22): `_invocationAutonomy` = tryb pytań TURY, zaufany znacznik.** `MCPClient`
  wstrzykuje do args znormalizowaną autonomię (zawsze nadpisywaną, jak `_invocationAgentName`);
  czyta ją `delegate` i zamraża w biegu suba, bo bieg z czatu leci w tle i przeżywa przełączenie
  zakładki (AUD-security-050). Nie czytaj `plugin.currentAutonomy` w kodzie, który wykonuje się
  po zakończeniu tury.
- ⚠️ **K4 (2026-08-22): rozwiązywanie pamięci jest FAIL-CLOSED.** `memory_save`, `memory_delete`
  oraz `read`/`list`/`search` ze `scope: memory` biorą `getAgentMemory(<tożsamość z runtime>)`
  i **nie mają już zjazdu** na `getActiveMemory()`, gdy tożsamość jest znana — nietrafiona nazwa
  kończy się `no_agent`, a nie cudzym katalogiem `brain/` (AUD-security-036). Fallback na
  aktywnego został TYLKO na przypadek „nie da się ustalić żadnej tożsamości".
- ⚠️ **K21 (2026-08-23): zaufane znaczniki `_invocation*` — bramka ogląda worek PO nadpisaniu.**
  `executeToolCall` składa `argsWithContext` (worek modelu + znaczniki od runtime'u) i to on idzie
  do `execute`. Do K21 `_extractToolContext` dostawał worek SPRZED nadpisania, więc każdy
  `contextExtractor` czytający `args._invocationAgentName` widział nazwę wpisaną przez MODEL.
  Rodzina `artifact_*` wyprowadza z tożsamości CAŁY cel (`…/Artefakty/<agent>/…`), więc bramka
  oceniała jedną ścieżkę, a `store.create` pisał pod drugą — whitelista `focusFolders` i
  `scope.folders` suba były do obejścia jednym polem w argumentach. Dwie zasady na przyszłość:
  1. `contextExtractor` bierze tożsamość z **`ctx.agentName`** (runtime), nigdy z worka —
     `args._invocation*` może co najwyżej nieść tę samą wartość, więc nie ma czego z niego brać;
  2. `execute` **może** czytać `_invocation*` z args, bo tam worek jest już nadpisany.
  Cel policzony przez bramkę i ścieżka zapisu mają być tym samym ciągiem (siostra reguły K1).
- ⚠️ **K17 (2026-08-23): oś narzędziowa mierzy NAZWĘ WYWOŁANEGO narzędzia, więc skutek trzeba
  bramkować tam, gdzie się dzieje.** `checkToolAxis` w `MCPClient` pyta o `agent_delegate`
  (grupa `delegation`), a to narzędzie robi to samo, co `kom_send` (grupa `komunikator`) —
  zostawia tekst modelu w cudzej skrzynce. Agent z włączoną delegacją i wyłączoną pocztą
  (domyślny stan świeżego profilu po włączeniu jednej grupy) przechodził. Naprawa: **bramka
  siedzi w chokepoincie** — `sendAgentMail` (`KomunikatorTools.ts`) jako PIERWSZY warunek pyta
  `plugin.toolRegistry.checkToolAxis(<agent z runtime>, 'kom_send')`; tożsamość bierze z
  `_invocationAgentName`, nigdy z pola modelu. Druga połowa tej samej naprawy jest w
  `ACTION_TYPE_MAP`: `agent_delegate` → **`agent.message`**, nie `delegate`. Akcja opisuje
  SKUTEK, a przełącznik zgody ma odpowiadać akcji — `delegate` (bieg sub-agenta, domyślnie
  cichy) opisywał zupełnie inną czynność, więc wysyłka szła bez okna zgody. Ryzyko zostaje
  ŻÓŁTE (jawny wyjątek w `classifyToolRisk`, obok `kom_send` — inaczej szeroka reguła
  `action === 'agent.message'` dałaby RED, czyli pytanie mocniejsze niż przy zwykłej poczcie),
  a `_getApprovalToggleKey` mapuje `agent_delegate` na przełącznik **`kom_send`**.
  **Dokładasz narzędzie, które coś wysyła / zapisuje w cudzym obszarze → zadaj sobie pytanie,
  o którą oś i o który przełącznik user naprawdę prosił.** Nazwa narzędzia nie jest odpowiedzią.
- ⚠️ **AUD-bledy-027/058/025 (2026-08-23): porażka narzędzia ma JEDEN kształt, ustawiany
  w JEDNYM miejscu.** `executeToolCall` na wyjściu (krok 8b) dopisuje `isError:true` każdemu
  wynikowi, który `toolResultStatus` uzna za porażkę — **nie kasując** `success`/`error`/`code`
  ani reszty pól. Reguła „co jest porażką" mieszka w `core/utils/toolResultStatus.ts` (czysta,
  w barrelu `core/index.js`: `toolResultStatus` + `shouldLinkWrittenFile`) i czytają ją czat
  (status chipa, link „otwórz zapisany plik", odtwarzanie historii) oraz runner subów.
  **Nie licz statusu drugi raz po swojemu.** W narzędziach dalej wolno zwracać `{success:false,
  error}`; PUSTY WYNIK to `success:true` + puste dane, NIGDY `success:false`.
- ⚠️ **`web_read` kanonizuje adres RAZ** (`normalizeUrl` na wejściu) — provenance, filtr domen, klucz cache i reader dostają ten sam ciąg. `readWebPage` ma dodatkowo strażnika: jeśli `new URL('https://r.jina.ai/' + url).href !== ` sklejce, request nie leci (segmenty `..` zwijały się PO sklejce i wysyłały reader na inną domenę niż ta, którą sprawdził filtr).
- ⚠️ **AUD-bledy-057/031 (2026-08-23): `TodoFileStore` pisze przez KOLEJKĘ per ścieżka.**
  `create`/`patch`/`finish` idą przez `_enqueuePathWrite(path, fn)` (kopia wzorca
  `AgentMemory._enqueuePathWrite`) — `AgentLoop` puszcza tool_calle tury przez `Promise.all`,
  więc dwa `todo` w jednej turze bez kolejki kasowały sobie zmiany i dublowały block-idy.
  Klucz = dokładnie ten string ścieżki, który leci do adaptera. **Nie wołaj `patch`/`create`/
  `finish` z wnętrza zakolejkowanej operacji** (zakleszczenie na tym samym kluczu); `read` jest
  świadomie POZA kolejką (czysty odczyt). Zwrotka `create`/`patch` to stan **odczytany z dysku
  po zapisie** (`_stateAfterWrite`), nie lokalna kopia — model widzi też cudze dopiski.
  `finish` z padniętym `remove` NIE melduje `finished` — oddaje `removeError`, a narzędzie
  zwraca `{isError:true, success:false, cause}` **bez `type:'todo'`**, żeby live-widok został
  na wciąż istniejącej liście.
- ⚠️ **K4 self-append (2026-08-27, za weryfikacją opus): `TodoFileStore.patch` czyta przez
  `readIfExists`, nie `exists()+read()`.** Ten sam wzorzec bugu co `modules/memory` (gotcha 12
  w `modules/memory/CLAUDE.md`): stary `(await adapter.exists(p)) ? await adapter.read(p) :
  emptyMarkdown()` na Dysku Google (`exists()===false` dla PLIKU, KTÓRY JEST) traktował
  ISTNIEJĄCĄ listę jako świeżą — `patch` nadpisywał ją pustym szkieletem + jednym nowym wpisem,
  reszta zadań agenta znikała z dysku. `readIfExists` (`core/index.js`) czyta NAJPIERW, więc
  `exists()` nie ma szans skłamać; stan `'unreadable'` (sygnały sprzeczne) jest **fail-closed**
  — rzut leci istniejącym wzorcem narzędzia (`execute` ma catch → `{isError:true, error}` dla
  modelu), plik NIE jest dotykany. Testy: `TodoTool.test.ts`, sekcja „K4 self-append".
  **Trzy INNE `exists()` w tym pliku są ŚWIADOMIE nietknięte — to inne figury, nie self-append:**
  `_ensureFolder` (guard przed `mkdir`, bez ryzyka danych), `read()` (goły odczyt, nic nie
  pisze — kłamiące `exists()` da fałszywe `missing:true` zamiast utraty danych, osobne
  znalezisko), `finish` i `clearForAgent` (guard przed `remove`/`list` — kłamiące `exists()`
  najwyżej zostawia osierocony plik, który `clearForAgent` i tak posprząta przy najbliższym
  `create` tego agenta, bo TA metoda liczy przez `list()`, nie `exists()`).

---

## TODO

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md)
- 🟠 **5 nowych vault tools** (Sprint 1) — `vault_filter_yaml`, `vault_grep`, `vault_links`, `vault_semantic`, `vault_glob` (architektura 3-warstwowa retrieval)
- 🟠 **4 memory tools analogi** (Sprint 1) — `memory_filter_yaml`, `memory_grep`, `memory_links`, `memory_semantic`
- 🟠 **Parallel execution w DelegateTool** (Sprint 1) — `parallel: true`
- ✅ **Memory v3 `memory_save` / `memory_read` / `memory_delete`** (Sprint M3 + Index Rework) — `memory_save` tworzy wyłącznie nową notatkę w `brain/` aktualnego agenta i odświeża `brain.md` jako indeks; `memory_read` czyta tylko bezpieczny filename `.md` z aktualnego agenta; `memory_delete` usuwa dokładnie jedną pasującą notatkę z `brain/` i odmawia `project_context` bez archiwizacji lekcji. `brain_update` został **całkowicie usunięty jako narzędzie** (wyrejestrowany w E1.1, pliki `BrainUpdateTool.js`/`BrainUpdateHistory.js` skasowane w E1.6) — runtime zapisuje do pamięci wyłącznie przez `memory_save` / `/save session`. Cross-agent path → `cross_agent_access_denied`, traversal/absolute path → `invalid_path`, istniejący filename przy save → `note_already_exists`.
- ✅ **VM2 / Worker isolation** dla custom-JS MCP servers — MOOT: sandbox custom-JS wyburzony w E3.1 faza C (zewnętrzne serwery to osobne procesy/usługi, nie kod w heapie Obsidiana).

## Powiązane

- `Tydzień MAX/Wizja/MEMORY_v2_RETRIEVAL_v2.md` — Bloki 4-5 (sub-agenci specjalizowani + 3-warstwowy retrieval = nowe tools)
- `modules/sub-agents/CLAUDE.md` — DelegateTool używa SubAgentRunner

## Historia

- **Sesja 83-84** — Server runtime + 7 wbudowanych MCP serwerów (Nika, Agora, Borys, ...)
- **Sesja 104** — security hardening (33 testy keySanitizer + SensitiveDataGuard)
- **Sesja 106** — +5 shadowed globals (setTimeout, setInterval, __dirname, __filename, Buffer) + URL-decoded traversal blocked
- **Sesja 125** — DelegateTool routes to SubAgentRunner only (cleanup), validation empty task
- **Sesja 128 D5** (2026-04-25) — placeholder rozbudowany do wzorca
- **Mapa-12 (2026-04-26)** — przenosiny `src/mcp/*.js` (27) + `src/core/Server*.js` (3) → `modules/mcp/`. **30 plików, ~3,965 LOC.** `index.js` z ~30 exports. 2 importerów: `src/main.js` (33 deep imports → 1 barrel) + `modules/comfy/ImageTextOverlayModal.js` (reverse dep). Bugfix podczas: WebSearchTool/WebReadTool ścieżki naprawione (WebSearchProvider zostaje w `src/core/` jako relict — ARCH-6 do `modules/web/`). 16 znalezisk → TODO (2×🔴 SEC-1 + DOC-1, 7×🟠 ARCH-1..6 + SEC-2, 6×🟡, 1×🟢). 3 atomic Nauka cards w Hogwarcie. **NOWA Wizja `MCP_PORZADEK_v1.md`** — 3 filary: built-in vs user-added separation + permissions per rola + UI extensibility. Build 8.1MB + 58/58 PASS.
- **Sprint 03 hotfix (2026-04-28)** — `fix(sprint-03): zarejestruj 9 retrieval tools w main.js` (commit `052aca1`) — Z13+Z14 omission z S03 (9 retrieval tools `vault_filter_yaml/grep/links/semantic/glob` + `memory_filter_yaml/grep/links/semantic` zdefiniowane w `VaultRetrievalTools.js`/`MemoryRetrievalTools.js` ale **nie zarejestrowane** w `src/main.js`). Druga sesja Kuby naprawiła równolegle z S04 Z0 pre-check. Total tools: 25 → **33 built-in registered** w main.js.
- **Sprint 04 (2026-04-28) — MCP_PORZADEK_v1 DONE.** Z0 verify (S03 omission already fixed) + Z1-Z11 wykonane. **3 filary wdrożone:** (1) built-in vs user separation z 7 manifestami (`built-in-servers/`) + ServerLoader source field + built-in name protection, (2) permissions: `ToolRegistry.filterByAgent()` + `agent.yaml.mcp_servers[]` whitelist + sub-agent intersection + `can_message[]` whitelist, (3) Settings → SEKCJA 10 + `MCPServerEditorModal` + 3 templates + sandbox safety. Plus: timeout 60s default + 180s ceiling, reverse dep mcp→comfy lazy fix, vault_path_validator DRY-1, naming standaryzacja + alias resolver, tool.contextExtractor PoC, **45 nowych unit tests**. **+~1770 LOC, 137/137 tests, bundle 8.5MB.** 8 znalezisk MC + 1 KO + 1 CF skreślone. Parallel collaboration z Codex (Z4 backend `afe7e21`).

## E3.1 faza C update (2026-07-24) — wyburzenie sandboxa custom-JS
- **SKASOWANE:** `ServerExecutor.js`(+test) + `templates/`(+test) + `checkSandboxSafety`. Grep `ServerExecutor|checkSandboxSafety|buildTemplate|TEMPLATES` = 0 w źródłach (poza wpisami historycznymi).
- **`ServerManager`/`ServerLoader` odchudzone do built-in:** gałąź user-JS w `connectServer` + DI serverExecutora + standalone tools + `_toolActionTypes`/`_toolBasePaths`/`_sessionConnected` + skan `.pkm-assistant/mcp-servers/` i `mcp-tools/` (`SERVERS_BASE`/`TOOLS_BASE`) + built-in name protection — OUT. Zostaje ładowanie built-in manifestów. `MCPClient` stracił gałąź `serverManager.getServerToolActionType`/`getServerToolBasePath` (gałąź `externalMcpManager` została).
- **`connect_to_server` (`ConnectToServerTool`) OUT wszędzie:** rejestracja w `main.js`, `delegation.manifest` (4→3), `BUILTIN_TOOL_MAP`, `toolAxis` (grupa + `PERMISSION_TOOL_GATES`), `MCPClient.ACTION_TYPE_MAP` + case, `decisionTree` (`deleg_server`), `DEFAULT_SUB_AGENT_TOOLS`, i18n (`mcp.connect_to_server.*` + `mcp.action_label.connect_to_server`). **34 → 33 built-in.** ZOSTAWIONE świadomie (render starej historii / fail-closed): `ToolCallDisplay`, `ApprovalModal`, `chat_streaming` status, `classifyToolRisk` redTools + i18n `tool.connect_to_server`/`tools.label.*`/`chat.tool_status.*`/`approval.desc.*`.
- **Konektory w profilu agenta** = tylko external (`ExternalMcpManager`) — legacy user-JS lista OUT.

## Sprint 13a update (2026-05-07)
- WebSearchProvider lives in modules/web/; Web Search settings are registered by modules/web/.

## E1.4 update (2026-07-21) — semantyka ŻYWA
- `vault_semantic` ma teraz realny L3: `VaultIndexer` (modules/embedding) publikuje `plugin.oramaDb`. Wcześniej `oramaDb` był martwy → L3 cicho spadał do L2.
- Nowy `semanticNote.js` (`buildSemanticNote`) — `vault_semantic`/`memory_semantic` dokładają pole `note` z powodem degradacji (`plugin.vaultIndexer.getStatus()`: no_provider/building/mobile/error) gdy `fallback_from==='l3'`. Kontrakty narzędzi bez zmian (pole dodatkowe).
- `memory_semantic` degraduje ZAWSZE — pamięć agentów jest odizolowana od indeksu vaulta (`RetrievalEngine._canUseLayer3('memory')===false`), żeby dokumenty vaulta nie wyciekły jako „pamięć". Semantyka pamięci = osobne zadanie.
- `VaultSearchTool.js`: martwa gałąź `.lookup()` na kolekcji źródeł starego frameworka bazowego (stary framework wywalony w S02) usunięta w całości — zostaje ścieżka keyword.

## E1.6 update (2026-07-21) — brain_update out + docs-freshness
- **`brain_update` całkowicie usunięty jako narzędzie.** Wyrejestrowany w E1.1, a w E1.6 skasowane pliki `BrainUpdateTool.js` + `BrainUpdateHistory.js` (żaden nie żyje już w `modules/mcp/`). Komentarz w `index.js` przy imporcie memory tools to relikt („legacy brain_update guard") — sam kod guarda nie istnieje.
- **Liczby zaktualizowane do stanu na dysku:** 48 built-in narzędzi (nie 28/33), ~55 plików / ~7,200 LOC (nie 30 / 3,965), memory manifest = 11 tools, komunikator = 12 tools.
- `SkillListTool.js` + `SkillExecuteTool.js` **wciąż istnieją** — decyzja D17 (kasacja `skill_list`/`skill_execute`) należy do Etapu 2, nie E1.6.

## E2.5 update (2026-07-22) — konsolidacja 12 narzędzi retrieval → `search`
- **JEDNO narzędzie `search` (`SearchTool.js`) zastąpiło 12:** `vault_search` + `vault_filter_yaml/grep/links/semantic/glob` + `memory_filter_yaml/grep/links/semantic` + `memory_sessions/summaries`. Skasowane pliki: `VaultRetrievalTools.js`, `MemoryRetrievalTools.js`, `VaultSearchTool.js`, `MemorySessionsTool.js`, `MemorySummariesTool.js` (+ `modules/memory/SearchHelper.js`, `getMemoryBase`/`searchDocs` bez konsumentów). **48 → 37 built-in narzędzi.**
- **Kontrakt `search`:** `{query?, scope?('vault'|'memory'), where?{folder,glob,yaml,links_to,links_from}, mode?('auto'|'keyword'|'semantic'), limit?}`. Silnik = `RetrievalEngine.runSearch()` (modules/memory) — kandydaci wg `where`, hybryda keyword+semantic przez **RRF (k=60)**, excerpt czytany z dysku (naprawiony bug pustego `body`). scope=memory bez Oramy (izolacja) + zawsze nota degradacji; `SearchTool` robi fail-closed check uprawnienia `memory` WEWNĄTRZ execute.
- **`search` żyje w serwerze `vault`** (BUILTIN_TOOL_MAP + vault.manifest, 6 tools). memory.manifest → 5 tools. scope=memory bramkowane uprawnieniem, nie serwerem (agent bez `vault` nie dostaje vaultu tylną furtką).
- **Aliasy wstecznej kompatybilności** (`toolAliases.js`): stare nazwy → wywołanie `search` z przekształceniem argumentów. Wpięte w `MCPClient.executeToolCall` (nieznana nazwa + alias → remap + `alias_note`). Sub-agent whitelisty: `SubAgentLoader.DEPRECATED_TOOL_RENAMES` (migracja YAML) + `SubAgentRunner._resolveToolNames` (fail-safe rename).
- **Testy** (pierwsze na tej warstwie): `SearchTool.test.js`, `modules/memory/RetrievalEngine.test.js`, `toolAliases.test.js`.
- `MCPClient.parseToolCalls` przepuszcza nieznane nazwy bez zmian → alias łapie je w `executeToolCall`. `searchText` z `orama_engine` pozostaje nieużyty (decyzja o BM25-w-indeksie poza E2.5). `ACTION_TYPE_MAP` trzyma wpisy starych nazw dla spójności mapy akcji (alias i tak remapuje wcześniej).

## E2.6 update (2026-07-22) — narzędzia API-first + prymitywy plikowe bez prefixów
- **Prymitywy ze scope w parametrze (wzór `search`):** `read` (`ReadTool.js`) i `list` (`ListTool.js`) mają `scope: 'vault'|'memory'`. `read` wchłonął `vault_read` + `memory_read` + `memory_read_summary`; `list` wchłonął `vault_list` + `memory_list_summaries` (+ listing brain/ i sesji). `vault_write`/`vault_delete`/`vault_create_folder` przemianowane na `write`/`delete`/`create_folder` (vault-only). **37 → 34 built-in** (−3 wchłonięte memory readery). Skasowane pliki: `VaultReadTool.js`, `VaultListTool.js`, `MemoryReadTool.js`, `modules/memory/MemorySearchTools.js`. `memory_save`/`memory_delete` NIETKNIĘTE (create-only / archiwizacja).
- **API-first (TYLKO ścieżki vault):** `read` → `getAbstractFileByPath` + `cachedRead`; `list` → `TFolder.children`/`getFiles` (fallback adapterowy usunięty); `write` → `vault.create`/`process` (fallback `modify` dla hostów bez `Vault.process`, patrz W4 niżej) + `vault.createFolder` (folder ensure); `create_folder` → `vault.createFolder`; `delete` → `vault.trash`/`vault.delete` (bez zmiany semantyki). GenerateImage/AddTextToImage → `vault_binary_io.js` (`createBinary`/`modifyBinary`/`readBinary`). **`.pkm-assistant/` (pamięć, sandbox serwerów MCP, ukryte ścieżki) ZOSTAJE na adapterze** — Vault API tego nie widzi. Duck-typing `Array.isArray(file.children)` zamiast `instanceof TFile/TFolder` (testowalność AVA bez importu `obsidian`).
  ⚠️ **W4 (review fali 2, 2026-09-04):** dla PLIKÓW ISTNIEJĄCYCH `write` (`WriteTool.ts` — `patch`
  i replace/append/prepend, oba miejsca zapisu — oraz `vault_binary_io.ts` `writeText`) woła
  `vault.process(file, () => finalContent)`, a `vault.modify` jest tylko fallbackiem, gdy host
  nie ma metody `process`. Callback dostaje ŚWIEŻĄ treść pliku, ale świadomie ją IGNORUJE (stała
  funkcja `() => finalContent`) — `process` jest tu użyty dla atomowości TRANSPORTOWEJ (Obsidian
  gwarantuje, że zapis nie nadepnie na równoległy zapis z innego źródła), nie jako
  read-modify-write z rekoncyliacją konfliktu. Nowe pliki (`patch`/replace bez istniejącego
  targetu) dalej idą przez `vault.create`.
- **Bramka pamięci fail-closed:** `read`/`list` scope=memory sprawdzają `agent.permissions.memory` WEWNĄTRZ execute (jak `search`); żyją w serwerze `vault` (BUILTIN_TOOL_MAP + vault.manifest = read/list/write/delete/create_folder/search), memory.manifest = tylko `memory_save`/`memory_delete`. Cross-agent niemożliwy (zawsze pamięć wołającego agenta).
- **Aliasy (`toolAliases.js`):** `PRIMITIVE_ALIASES` + `resolveToolAlias` (wspólny z search). `vault_*` → prymityw 1:1; `memory_read{filename}` → `read{path, scope:memory}`; `memory_read_summary{level,filename}` → `read{path:summaries/…, scope:memory}`; `memory_list_summaries{level}` → `list{folder, scope:memory}`. `MCPClient` remapuje nieznane nazwy + dokleja `alias_note` (`mcp.alias.renamed`). `SubAgentLoader.DEPRECATED_TOOL_RENAMES` + `SubAgentRunner`/`WorkMode` defaults zaktualizowane. `PermissionSystem._getApprovalToggleKey`: `write`/`delete`/`create_folder` mapują na dawne klucze `vault_*` (zapisane przełączniki approvalu usera działają dalej).
- **RetrievalEngine app DI:** silnik `search` scope=vault dostał opcjonalne `app` (getMarkdownFiles + metadataCache: frontmatter z cache, linki z `resolvedLinks`, `getFirstLinkpathDest`). Bez `app` → dawny walker/parser/regex (testy mockowe). scope=memory bez zmian (adapter). Patrz `modules/memory/CLAUDE.md`.
- **Testy:** `ReadTool.test.js`, `ListTool.test.js`, `toolAliases.test.js` (rozszerzony), `RetrievalEngine.test.js` (app-first: getMarkdownFiles/metadataCache/resolvedLinks + fallback). Limiter `vault_read` w trybie Gadaj → `read` (`chat_streaming.js`, alias-safe) — limiter USUNIĘTY w E2.3 (patrz niżej).

## E2.3 update (2026-07-22) — model kontroli: autonomia zamiast trybów pracy (D21/F12)
- **`MCPClient.executeToolCall(toolCall, agentName, opts={})` przyjmuje `opts.autonomy`** (`yolo`/`edge`/`all`; brak → `edge` ≈ dawne defaulty). Autonomia idzie do `checkPermission`/`requiresApproval`/`_shouldRequestApproval` i decyduje TYLKO o pytaniach. `yolo` = zero pytań (approval modal + diff pominięte), ale **NIE omija** No-Go / protected paths / whitelisty / uprawnień agenta (są w `checkPermission` przed bramką approvalu). Trzecia ścieżka approval „przekieruj" (redirect) bez zmian.
- **`SkillExecuteTool` bez auto-trybu.** Dawna auto-promocja `gadaj→rob` (gdy skill wymagał write) + sygnały `_modeSwitch`/`_modeRestore`/`_modeSwitchReason` USUNIĘTE — import `WRITE_TOOLS` i `plugin.currentWorkMode` też. Skill zwraca prompt + `_requiresPlan`; narzędzia nie zależą już od trybu, o zapis pyta autonomia. i18n `mcp.skill_execute.mode_switched`/`missing_tools` skasowane.
- **`YOLO_MODE` nie jest już typem uprawnienia** (`PERMISSION_TYPES.YOLO_MODE` nie istnieje; `agent.permissions.yolo_mode` ignorowane). Read-limiter 1×/turę (tryb Gadaj) w `chat_streaming.js` usunięty. `core/WorkMode.js` skasowany.

## E2.4 update (2026-07-23) — DelegateTool: 1 generyczny worker + thin (D18/F6)
- **`delegate` BEZ `aspect` = GENERYCZNY WORKER.** `aspect` jest opcjonalny; brak → `buildGenericWorkerConfig()` (syntetyczny `{name:'worker', tools: DEFAULT_SUB_AGENT_TOOLS}`, bez `config.prompt`, bez roli). Działa **nawet gdy agent nie ma żadnych subów** (guard `delegates.length === 0` USUNIĘTY). Custom suby po nazwie działają jak dotąd. `_resolveDelegate`: exact + fuzzy PO NAZWIE; **fallback po ROLI (researcher/minion/prep, strategist/master/strateg) SKASOWANY**.
- **Model zunifikowany:** `createModelForRole(plugin, 'researcher', ...)` dla WSZYSTKICH subów (`config.model` z YAML wygrywa; slot researcher→minion). Cap kontekstu delegata = **16000 dla wszystkich** (dawniej tylko strategist). `aspect_type` = etykieta `config.role` (F6, fallback `researcher`).
- **Thin prompt suba (SubAgentRunner):** brain-injection 12k pushem OUT; sub czyta pamięć sam (`read/search/list scope=memory`, pamięć wołającego agenta — zweryfikowane: `MCPClient` przekazuje `agentName` rodzica → `_invocationAgentName` → `ReadTool.readMemory`, bramka `permissions.memory` fail-closed). `config.prompt` cap 6000. Szczegóły: `modules/sub-agents/CLAUDE.md`.
- **i18n `mcp.delegate.desc`/`param.aspect`/`param.context` przepisane** (worker domyślnie, custom po nazwie, pamięć przez pull/`context`); nowy `mcp.delegate.worker_desc`. Opisy zwięzłe (idą do API). `mcp.delegate.no_delegates` nieużywany (worker nie wymaga subów).


## E2.4 update (2026-07-23) — skille bez narzędzi (D17) + chudy kontekst (D14)
- **`skill_list` + `skill_execute` SKASOWANE (D17).** Pliki `SkillExecuteTool.js`/`SkillListTool.js` + `skills.manifest.js` usunięte; serwer `skills` wypadł z `built-in-servers/index.js` + `ToolRegistry.BUILTIN_TOOL_MAP` (**9 → 8 manifestów**, 34 → 32 narzędzia). Wyrejestrowane w `main.js`; wpisy w `MCPClient.ACTION_TYPE_MAP` + `GROUP_B_TOOLS` + case `contextExtractor`, `PermissionSystem.APPROVAL_DEFAULTS`/`_getApprovalToggleKey`, i18n `mcp.skill_*` — usunięte. UI (McpBackstageTab kategoria, AgentProfileModal lista, profile_permissions toggle) posprzątane. `ToolCallDisplay`/`ApprovalModal` **zostają** (renderują starą historię sesji, nie wołają narzędzi). Odkrywalność skilli = indeks w system promptcie, przepis przez `read` (patrz `modules/prompts/CLAUDE.md` + `modules/skills/CLAUDE.md`).
- **Wyjątek izolacji TYLKO-ODCZYT (`vault_path_validator.js`).** `validateVaultPath(path, { allowSkillsRead:true })` przepuszcza `.pkm-assistant/skills/**` — `read`/`list` (scope=vault) je przekazują, więc model wciąga przepis SKILL.md narzędziem `read`. `ListTool` listuje ten katalog przez adapter (`listSkillsViaAdapter`) — Vault API nie widzi ukrytego `.pkm-assistant/`. **Zapis/kasowanie/create_folder** NIE przekazują flagi → blokada bez zmian (`DeleteTool`/`CreateFolderTool` przez validateVaultPath; `WriteTool` ma własną walidację `sanitizePath`+`isProtectedPath`+AccessGuard — `.pkm-assistant/skills` zapis był już dozwolony przez AccessGuard shared-area PRZED E2.4, moja zmiana go nie tyka). Pamięć agentów + indeks semantyczny — dalej fail-closed. Testy: `vault_path_validator.test.js`, `ReadTool.test.js`, `ListTool.test.js`.
- **Opisy narzędzi = źródło guidance „kiedy użyć" (D14).** `agent_delegate` ma `context_summary` **REQUIRED** w `inputSchema` (twarda reguła zamiast miękkiej instrukcji promptu). `mcp.idea_review.desc` doklejka „kiedy nie". Naprawa stale nazw w opisach: `memory_save.desc`/`create_folder.desc` odwoływały się do `vault_write`/`memory_read`/`vault_list` (E2.6 rename) → `write`/`read(scope:memory)`/`list`. Większość desców (`memory_save`/`memory_delete`/`create_folder`/`connect_to_server`/`agent_delegate`/`agent_message`/`chat_todo`/`plan_review`) już niosła sekcję „KIEDY UŻYWAĆ" — drzewo je duplikowało (premisa D14). `delegate.desc` (część A) już ma multi-tasks + nie-deleguj-small-talk.

## E2.8 update (2026-07-23) — agenci v3: jedna oś narzędziowa + kasacja widm
- **`filterByAgent(agent)` na NEGATYWNEJ osi `disabled_tools[]` (C1).** Wszystkie built-in ON, chyba że nazwa w `agent.disabled_tools[]`. `core` (ask_user) nieusuwalny. Narzędzia userowych serwerów MCP (`tool.serverName` spoza built-in) gated dodatkowo pozytywną listą `mcp_servers` (opt-in per agent — konektor przypięty). Osie `mcp_servers`/`enabled_tools`/`permissions.{read_notes,edit_notes,create_files,delete_files,mcp,web_search}` **przestały filtrować narzędzia.** Źródło prawdy nazw = manifesty + `BUILTIN_TOOL_MAP`; ich pure-kopia (grupy + migracja) żyje w `modules/agents/toolAxis.js` (test pilnuje zgodności). Sub-agent: przecięcie z narzędziami rodzica po nowej osi (patrz `modules/sub-agents/CLAUDE.md`).
- **`PermissionSystem.checkPermission` uproszczony (C1).** Gałąź `if (!agent.permissions[requiredPermission])` USUNIĘTA — o „wolno" decyduje DOSTĘPNOŚĆ narzędzia (`disabled_tools`), nie pole uprawnienia. Zostaje: No-Go/protected (absolutne) → AccessGuard (whitelista/focus) → bramka approvalu wg autonomii. Nieznana akcja = fail-closed. `ACTION_PERMISSIONS` służy teraz tylko do klasyfikacji krawędzi + poziomu dostępu (read/write), nie do odmowy. Patrz `core/CLAUDE.md`.
- **`memory_save {ephemeral:true, section:'user'|'environment'}` (D2).** Jeden tool, dwie ścieżki: bez `ephemeral` = create-only notatka w `brain/` (jak dotąd); z `ephemeral:true` = dopisanie/USUNIĘCIE (`remove`) bullet-a w sekcji „Na teraz" w `brain.md` przez `agentMemory.writeNaTeraz`. To **jedyny świadomy wyjątek** od reguły create-only — dotyczy TYLKO sekcji ulotnych. Nowe parametry `ephemeral`/`section` + i18n `mcp.memory_save.param.*`/`ephemeral_*`. Odczyt/kasacja notatek `brain/` bez zmian.
- **`AgentMessageTool`: check `can_message` USUNIĘTY (A4/F7).** Każdy agent może pisać do każdego. Pole `can_message` na agencie czytane, ale ignorowane (wzór F6). i18n bloku out.
- **Zaplecze → tab „Narzędzia MCP" SKASOWANY (A4/S27).** Pliki `McpBackstageTab.js` (138 LOC) + `BackstageTab.js` (22 LOC) usunięte; `registerBackstage` wypadł z `index.js`. Jego funkcję (przegląd + on/off narzędzi) przejęły zakładki panelu agenta Uprawnienia (C7) + Umiejętności (C5). Serwer/manifesty niezmienione — to była tylko wydmuszka UI.

## E2.9 FAZA D update (2026-07-23) — artefakty żywe + todo, kasacja starych narzędzi
- **Serwer `artifacts` = `artifact_create/read/update/list` + `todo`.** Stare `chat_todo`/`idea_review`/`plan_review` SKASOWANE (pliki `ChatTodoTool`/`IdeaReviewTool`/`PlanReviewTool` + rejestracje `main.js` + wpisy `BUILTIN_TOOL_MAP`/manifest). Backward-compat: `ARTIFACT_ALIASES` w `toolAliases.js` — `chat_todo`→`todo` (mapowanie akcji, `item_index`→`blockId`), `plan_review`→`artifact_create{typ:'plan'}` (kroki ze `steps`/markdownu), `idea_review`→`artifact_create{typ:'notatka'}`. `resolveToolAlias`/`isToolAlias` rozszerzone.
- **`TodoTool.js` (gatunek 2, default ON).** `todo {action: create|check|uncheck|add|finish}` + ukryta akcja `list` (read-only, dla aliasu). Plik `.pkm-assistant/artifacts/todo/<agent>-<sessionId>.md` przez adapter (dotfolder); silnik = `parseArtifact`/`applyPatch` **przez barrel `modules/artifacts/index.js`** (jest node-safe, więc deep-import nie jest potrzebny — sprostowane w S30 Z4). `finish`/nowa sesja kasuje plik.
- **`MCPClient` odchudzony:** `ACTION_TYPE_MAP` (chat_todo/idea/plan out, `todo` in), `GROUP_B_TOOLS` (idea/plan out), cases `_extractToolContext`, gałąź modala review (6b, `IdeaReviewModal`+`_planStore`) i `ArtifactProgressModal` (6c), actionType `todo.save` — USUNIĘTE. Artefakty żywe mają approval w notatce (guziki B1) + live-widok `todo` w czacie (D2).

## A1–A4 security update (2026-07-24)

- Normalne prymitywy `read/list/search/write/delete/create_folder` obsługują
  `admin_access` po zaufanej tożsamości `_invocationAgentName` wstrzykniętej przez
  `MCPClient`. Model nie przekazuje flagi admina sam. Ukryte ścieżki idą przez
  DataAdapter, bo Vault API ich nie indeksuje.
- Admin otwiera `.pkm-assistant`, `.obsidian`, `.trash`, No-Go i protected files,
  ale **nie** omija `sanitizePath`; ścieżki pozostają vault-relative. To nie jest
  jeszcze dostęp do całego komputera.
- `vault_adapter_io.js` centralizuje recursive mkdir/list dla dotfolderów. (S30 Z3: sam
  `mkdir -p` mieszka teraz w `core/utils/vaultFs.js`, tu jest re-eksport — patrz niżej.)
  `delete` nadal odmawia kasowania folderów; admin może kasować pojedyncze ukryte
  pliki przez system/local trash.
- `MCPClient` przekazuje tryb konkretnej operacji do światła ryzyka. `write
  mode:create` = YELLOW, patch/replace/append/prepend = RED. Każde narzędzie
  serwera `source:'user'` = RED niezależnie od deklarowanej akcji. YOLO pomija
  pytania, lecz nie whitelistę serwera, disabled tools ani zakres dostępu.
- `default_roles` usunięte z 8 manifestów, template generatora, loadera i modala.
  Realna dostępność custom serwera: `agent.mcp_servers[]`.

## E3.2 update (2026-07-25) — ComfyUI/Zoja wycięte z narzędzi multimodalnych

- **`generate_image` bez ComfyUI.** Gałąź `platform === 'comfyui'` (preview flow +
  `ComfyWorkflowLoader` z `.pkm-assistant/comfy-workflows/`) SKASOWANA razem z parametrem
  `workflow` i sekcją „COMFYUI WORKFLOW" w opisie. Walidacja platformy względem
  `IMAGE_GEN_PLATFORMS` ZOSTAJE — zapisana w danych usera platforma `comfyui` odbija się
  z listą 6 dostępnych. Regresja: `GenerateImageTool.test.js` (4 testy).
- **`add_text_to_image` tylko automatyczny.** Tryb `interactive: true` (dynamic import
  `ImageTextOverlayModal` z `modules/comfy/`) + parametr `interactive` OUT; render idzie
  przez `renderTextOverlay`. Alias `renderTextOnImage` skasowany z helpera i barrela
  (jedynym konsumentem był modal z comfy). i18n `mcp.text_overlay.cancelled` usunięty.
- **`MCPClient`: gałąź `result?.type === 'comfy_preview'` OUT** (krok 6e) — wraz z
  instrukcjami tekstowymi, które kazały modelowi wołać nieistniejące `comfy_generate`.
  Wynik generowania idzie prosto do vaulta, bez modala.
- **`SettingsContent.renderImageGenSettings`:** opcja platformy `comfyui` + pola
  `comfyuiUrl`/`comfyApiKey` + placeholder modelu OUT. Dropdown ma teraz defensywny guard:
  zapisana platforma spoza listy opcji (np. osierocone `comfyui`) renderuje się jako
  pierwsza/domyślna opcja. **Bez migracji danych** — `data.json` usera nietknięty.
- `multimodal.manifest` — opis bez „Zoja + ComfyUI"; 2 narzędzia i timeout 180s bez zmian.

**Porządek po cięciu (ta sama sesja):** martwy parametr `seed` w `generate_image`
usunięty ze schematu (żaden adapter chmurowy go nie czytał — kłamał modelowi; test
regresyjny w `GenerateImageTool.test.js`). `SettingsContent.renderImageGenSettings`
buduje dropdown platform z `IMAGE_GEN_PLATFORMS` (SSOT w `modules/multimodal/`)
zamiast z lokalnej, rozjeżdżającej się kopii — jedyny lokalny wpis to `disabled`.

## E3.3 update (2026-07-25) — R-WEB: nowe kształty wyników web_search / web_read

**`web_search` — koniec iluzorycznego cięcia.** Narzędzie zwracało RÓWNOCZEŚNIE
`results` z PEŁNĄ treścią stron i przycięte `formatted`; globalny limiter pętli agenta
tnie surowy JSON, więc model i tak dostawał ucięte śmieci zanim doszedł do `formatted`.
Nowy kształt:

```js
{ success: true,
  provider: 'jina',            // kto REALNIE obsłużył
  fallback_from: 'tavily',     // tylko gdy zadziałała darmowa podłoga
  query, count,                // count PO filtrze domen
  results: [{ title, url, fragment }],   // fragment = slice(0, trimLimit); ZERO pełnej treści
  formatted }                  // czytelny tekst; nota o podłodze na górze
```

`fragment` jest zarazem formatem cytatu {tytuł, url, fragment} z L13-13 — gotowa karma
dla Pamięci v3. Po pełną treść jest `web_read`. Filtr domen działa PO pobraniu:
odfiltrowane wyniki nie wchodzą ani do `results`, ani do `urlRegistry` (czyli `web_read`
ich nie otworzy). Po sukcesie leci `bumpUsage` (licznik informacyjny, `modules/web/`).

**`web_read` — streszczenie zamiast ucięcia (DEC L13-5a).**

```js
{ success: true, url, title,
  content,                     // streszczenie ALBO treść ucięta jak dotąd
  citations: [{ fragment }],   // 3-5 DOSŁOWNYCH cytatów; [] gdy bez streszczenia
  summarized: true|false,
  charCount,
  note }                       // czemu streszczone / czemu ucięte i co z tym zrobić
```

Kolejność w `execute`: walidacja URL → **bramka provenance (NIETKNIĘTA)** → filtr domen
(odmowa PRZED requestem) → cache → `readWebPage` → streszczenie albo cięcie → cache set.

**Skąd tani model.** `createModelForRole(plugin, 'researcher', agent)` z
`modules/models/` (barrel), gdzie `agent` wynika z `_invocationAgentName` wstrzykniętego
przez `MCPClient` (model nie podrobi tożsamości). Model powstaje **leniwie** — dopiero
gdy strona faktycznie przekroczy limit, więc krótka strona i trafienie w cache nie
kosztują nic. Brak modelu / toggle `summarizeLongPages: false` / `agent.minionEnabled ===
false` / błąd LLM → twarde cięcie + `mcp.web_read.no_summarizer_note`. **Świadomie bez
fallbacku na model główny** — narzędzie nie ma prawa po cichu palić drogiego modelu.

Testy: `WebSearchTool.test.js`, `WebReadTool.test.js` (obie przez `module.registerHooks`
z atrapą `requestUrl`; WebReadTool testuje PRAWDZIWĄ ścieżkę `createModelForRole` na
atrapie klasy modelu z `env.config`). `web.manifest.js` bez zmian (permissions, timeout 60s).

## S27 update (2026-07-28) — zakładka „Konektory" + globalny sub w delegacji

**Zaplecze → Konektory (Z5, D5) — INFORMACYJNIE, zero akcji zarządzających.** Nowe pliki
`BackstageTab.js` (rejestracja, order 30) + `ConnectorsBackstageTab.js` (render, lazy-load);
`registerBackstage` wraca do barrela. To NIE jest powrót skasowanego w E2.8 A4 taba
„Narzędzia MCP" (wydmuszka sterowania) — tamten udawał on/off, ten tylko opisuje:

1. **„Twoje konektory"** — karta per serwer z `ExternalMcpManager.listServersForUi()`:
   nazwa, transport, status (`connected`/`off`/`error` + `lastError`), liczba narzędzi
   i rozwijana lista narzędzi z `getServerTools(id)`. Serwer rozłączony dostaje uczciwy
   komunikat zamiast pustej listy (bo `getServerTools` zwraca wtedy `[]`).
2. **„Wbudowane narzędzia pluginu"** — REALNA lista z `ToolRegistry.getAllTools()`
   pogrupowana przez `getBuiltinServerForTool()`. **Świadomie NIE z `TOOL_INFO`** — tam leżą
   martwe wpisy potrzebne do renderowania historii starych czatów.

Podłączanie serwera = Ustawienia → Serwery MCP. Włączanie per agent = profil →
Umiejętności → Konektory (`mcp_servers[]`). Ta zakładka niczego nie zmienia.

**`DelegateTool` — globalny sub (Z4, D2).** Syntetyczny worker nazywa się teraz **`pkm-sub`**
(stała `PKM_SUB_NAME` z `modules/sub-agents`; wcześniej bezimienny `'worker'`). Gałąź BEZ
`aspect` woła `resolveGenericWorkerConfig(plugin)`:

- `settings.pkmAssistant.globalSubTemplate` pusty → fabryczny `pkm-sub` (jak dotąd),
- ustawiony i szablon się parsuje → config z szablonu (nazwa, opis, `tools`, `model`,
  instrukcja z `KNOWLEDGE.md`, limity iteracji / długości wyniku),
- **fail-soft:** brak szablonu / brak wymaganych pól / rzucający store → `pkm-sub` + `log.warn`.
  Delegacja NIGDY nie wywala się przez złą decyzję usera.

Przecięcie narzędzi rodzic∩sub (`SubAgentRunner._getTools`) **bez zmian** — worker z szablonu
przechodzi przez tę samą bramkę co każdy sub.

## S28 update (2026-07-29) — Komunikator v3: 3 prymitywy poczty zamiast 13 narzędzi

- **`agent_message` + 12× `kom_*` (Project Hub) SKASOWANE.** Pliki `AgentMessageTool.js`(+test)
  i `KomunikatorProjectTools.js`(+test) usunięte; `agent_message` wypadł z `delegation.manifest`
  (3 → 2 narzędzia), z `ToolRegistry.BUILTIN_TOOL_MAP` i z `toolAxis`. **33 → 23 built-in.**
  ZOSTAWIONE świadomie (render starej historii / fail-safe): wpis `agent_message` w
  `MCPClient.ACTION_TYPE_MAP`, w `classifyToolRisk` redTools, w `ToolCallDisplay.TOOL_INFO`
  i klucz i18n `tool.agent_message` — dokładnie jak `connect_to_server` po E3.1 faza C.
- **Nowy `KomunikatorTools.js` — serwer `komunikator` = `kom_send` / `kom_list` / `kom_read`.**
  `kom_send` = JEDEN adresat na wywołanie (wielu = model woła w pętli), create-only. `kom_list`
  zwraca same nagłówki (bez treści — budżet tokenów), `kom_read` treść + auto-ptaszek `ai_read`.
  **Agent NIE MA narzędzia kasowania poczty** (D3/D5 — sprząta user w UI).
- **Światła A3:** `kom_send` = **YELLOW** (jawny wyjątek narzędziowy PRZED szeroką regułą
  `action === 'agent.message'`, wzór `artifact_update` vs `write`) z własnym toggle'em approvalu
  (`APPROVAL_DEFAULTS.kom_send = true`, pozycja w profilu → Uprawnienia). `kom_list`/`kom_read`
  = GREEN. Narzędzie zewnętrznego serwera o tej nazwie i tak byłoby RED (`isExternalTool` wygrywa).
- **Widoczność bez importu:** narzędzia czytają `agentManager.listKomunikatorAgents()` /
  `findKomunikatorAgent()` / `isKomunikatorVisible()` — dzięki temu `modules/tools/` nie wciąga
  obsidian-owego barrela komunikatora i zostaje node-testowalne (`KomunikatorTools.test.js`).
- **Kill-switch:** `resolveBuiltinManifests({komunikatorEnabled:false})` gasi już tylko serwer
  `komunikator` (nie ma czego wycinać z `delegation`). Flaga jest **domyślnie ON** (S28 D7).

> **W8 update (2026-09-02, AUD-wydajnosc-020/053):** `kom_list` dostał twardy sufit
> `KOM_LIST_MAX = 50` (lokalna stała w `KomunikatorTools.ts`, wzór `MAX_RESULTS` z
> `ListTool.ts`) — bez niego wynik narzędzia rósł bez ograniczenia razem ze skrzynką (brak
> ewikcji, D5/D9 w `modules/komunikator/CLAUDE.md`). Newest-first z `KomunikatorManager.
> listMessages` gwarantuje, że obcięcie zostawia najświeższe; wynik ≤ 50 pozycji jest bajt
> w bajt jak przed cięciem, > 50 dokłada `{total, truncated:true}`. `unread` liczy się z CAŁEJ
> skrzynki niezależnie od obcięcia widoku. Druga połowa naprawy (kesz nagłówków, żeby
> `getUnreadCount`/`kom_list`/`resolveHopFor` nie czytały dysku na trafienie) mieszka w
> `KomunikatorManager.ts` — patrz `modules/komunikator/CLAUDE.md`, sekcja „Fabryka napraw W8".

## S32 Z2 update (2026-07-30) — 4 wisienki external MCP

- **`normalizeMcpResult(result)` (NOWA, pure, eksportowana z `ExternalMcpManager.js`).** Wynik SDK
  (`{content:[{type:'text'|'image'|'resource'}]}`) szedł do modelu przez `JSON.stringify(raw)`
  w `AgentLoop` — czyli base64 obrazka leciał do promptu jako string. Teraz `execute` wrappera
  przepuszcza wynik przez normalizację: text → surowy tekst (join `\n\n`), image → jedna linijka
  `[image image/png, ~123 kB]` (rozmiar z długości base64, BEZ danych), resource → `[resource: uri]`
  + treść gdy `resource.text` jest stringiem, nieznany typ → `[<type>]`. `isError` → `{isError, error}`.
  Wejście bez tablicy `content` (m.in. NASZ własny kształt błędu) przechodzi bez zmian.
  ⚠️ Adnotacje są po ANGIELSKU i **świadomie bez i18n** — to treść dla MODELU, nie napis w UI
  (tłumaczenie zmieniałoby prompt razem z językiem interfejsu). `callTool` **nietknięty** —
  nadal zwraca surowy wynik SDK, normalizacja jest tylko w warstwie narzędzia.
- **`mcpServerPresets.js` (NOWY)** — `MCP_SERVER_PRESETS`: 5 gotowych serwerów (filesystem, github,
  `mcp-memory`, fetch, blender) + `getMcpServerPreset(id)`. Dane **w kodzie, zero sieci** (lista
  programów do uruchomienia na komputerze usera nie może przychodzić ze zdalnego źródła).
  `hint` = klucz i18n „co jeszcze uzupełnij". Id `mcp-memory`, **nie `memory`** — kolizja z nazwą
  serwera wbudowanego zostałaby auto-wpuszczona każdemu agentowi (default
  `mcp_servers = ['vault','memory','core']`); test pilnuje tego przez `validateServerId`.
  W `MCPServerEditorModal` dropdown „Preset" **tylko w trybie nowego serwera** — wybór wypełnia
  formularz (`_applyPreset` → przerysowanie przez `onOpen()`) i pokazuje hint; walidacja przy
  zapisie bez zmian (kolidujące id odbije normalnym komunikatem).
- **`claudeConfigImport.js` (NOWY, pure)** — `parseClaudeDesktopConfig(jsonText)` mapuje
  `{mcpServers:{nazwa:{command,args,env}}}` na nasz kształt (`transport:'stdio'`, id slugowany do
  `[a-z0-9-]` max 32, `autostart:false` — import NIGDY nie włącza autostartu); wpis z kluczem `url`
  → `{transport:'http', url, headers}`. Śmieci (zły JSON, brak `mcpServers`, wpis bez command/url,
  slug < 2 znaki) są pomijane, nigdy nie rzuca. `buildImportRows(parsed, existing)` = logika selekcji:
  istniejące id → `exists:true`, odznaczone (import nie nadpisuje konfiguracji usera, mogła nieść token).
- **Przycisk „Importuj z Claude"** w `SettingsContent.renderExternalMcpServers` obok „+ Dodaj serwer":
  najpierw próba `%APPDATA%\Claude\claude_desktop_config.json`, w razie braku ukryty
  `<input type="file" accept=".json">` (przez `createEl`, zero innerHTML). Potwierdzenie robi
  `modules/shell/ClaudeImportModal.js` (NOWY, głupi — wiersze i `onConfirm` przez konstruktor,
  podawany przez `ctx` z `_buildSectionContext`, tak jak `MCPServerEditorModal`).
  ⚠️ Odczyt pliku idzie przez **`window.require('fs')`**, nie `import('node:fs')` — esbuild
  zostawia dynamiczny import externala jako natywny `import()`, którego resolver renderera nie zna
  i bundle wybucha w runtime (ten sam bug co na `obsidian` w smoke E3.1).
- **401 (Z2.4):** `ExternalMcpManager.connect` w catchu podmienia komunikat zawierający `401`/
  `Unauthorized` (case-insensitive) na `t('settings.mcp_external_error_401')`; inne błędy jak dotąd
  przez `maskSensitiveData`. Pole na nagłówek Authorization **już było** (Headers w edytorze HTTP) —
  nie duplikowaliśmy go. **Pełny interaktywny OAuth flow świadomie NIE zaimplementowany**
  (brak testowalnego partnera; token wkleja user).
- Testy: `mcpServerPresets.test.js` + `claudeConfigImport.test.js` (NOWE) + 8 testów Z2.1/Z2.4
  w `ExternalMcpManager.test.js`. ⚠️ W testach i18n importuje się jako `t as tr` — `t` to obiekt
  asercji AVA.

## S32 Z5 update (2026-07-30) — `artifact_create` egzekwuje typy podpięte agentowi

- **`ArtifactCreateTool.execute` sprawdza `agent.artifact_types` PRZED `store.create`.** Wcześniej
  pole sterowało TYLKO widocznością typów w indeksie promptu (`modules/prompts/artifactIndex.js`) —
  model mógł podać dowolny typ z biblioteki i przechodziło. Teraz typ spoza NIEPUSTEJ listy wraca
  jako `{isError:true, error: t('mcp.artifact.type_not_allowed', {typ, allowed})}` (komunikat
  widzi model i user w chipie narzędzia, z listą dozwolonych).
- **Egzekwowanie jest OPT-IN:** pusta/nieustawiona lista = wszystkie typy wolno (zero zmian dla
  istniejących profili); agent nienaleziony w `agentManager` = przepuszczamy. Tożsamość bierze się
  z zaufanego `args._invocationAgentName` (wstrzykiwane przez `MCPClient`, model tego nie podrobi),
  więc bramki nie da się obejść podaniem cudzej nazwy.
- **Narzędzie `todo` NIETKNIĘTE** — to gatunek 2, poza biblioteką typów; bramkuje je `disabled_tools`.
- Testy: `built-in-servers/artifacts/ArtifactCreateTool.test.js` (NOWY, 5 testów na fake plugin
  z minimalnym `agentManager` + `artifactStore`).
## N1 update (2026-08-09) — `artifact_create` nie połyka już błędów sekcji

- **Wynik `artifact_create` niesie `applied` + `errors`** (wzór `artifact_update`). Silnik
  (`ArtifactStore.create`) zwraca je od tej zmiany; wcześniej brał z `applyPatch` samo
  `.markdown`, więc `set_section` z nagłówkiem spoza szablonu typu wracał jako cichy
  `not_found` — narzędzie mówiło `ok:true`, a artefakt wychodził pustym szablonem.
- **`mcp.artifact_create.param.sekcje` (pl+en) mówi wprost**, że `heading` musi DOKŁADNIE
  odpowiadać nagłówkowi `##` z szablonu typu (lista nagłówków jest przy typie w indeksie
  artefaktów promptu — patrz `modules/prompts/artifactIndex.js`).

## F2 update (2026-08-15) — `delegate` domyślnie startuje suba W TLE

> **Runda 3 (2026-08-17): tło z głównego czatu jest PRZYMUSOWE.** Parametr `background`
> WYLECIAŁ ze schematu (model wybierał `false` z przyzwyczajenia i mroził userowi czat na
> cały bieg suba); jawnie podany w args jest ignorowany (log.debug). Ścieżka blokująca żyje
> dalej TYLKO: (1) bez `plugin.subTaskRegistry` (fail-soft), (2) przy delegacji z WNĘTRZA
> suba (`depth >= 1` — sub nie ma notifiera). Opis niżej czytaj z tą poprawką.

**Zmiana kontraktu narzędzia.** Nowy argument `background?: boolean`, **default `true`**
(decyzja Kuby, wzór Claude Code). Zamiast wyniku suba tura dostaje pokwitowanie:

```js
// single-task
{ success: true, started: true, task_id: 'sub/pkm-sub#3', name: 'pkm-sub', note: '…' }
// multi-task
{ success: true, started: true, tasks: [{task_id, name}, …], queued?: 2, note: '…' }
```

`note` (i18n `subagent.background_started` / `…_many`) mówi modelowi wprost: wyniku jeszcze
nie ma, wróci osobnym powiadomieniem, **nie zgaduj** i zakończ turę informacją, co zleciłeś.
`background: false` = dokładnie dzisiejsza ścieżka blokująca, bez zmian.

- **Warunki tła (oba twarde):** istnieje `plugin.subTaskRegistry` (stamtąd bierze się `task_id`
  i tamtędy wraca wynik) **oraz** wołamy z głównego czatu (`_invocationDelegationDepth === 0`).
  Brak rejestru → **fail-soft**: leci ścieżka blokująca + jeden `log.warn` na proces. Sub
  wołający `delegate` i tak odbija się o strażnika głębokości, więc go nie komplikujemy.
- **Skąd `task_id`:** `SubAgentRunner` melduje świeżo założony byt hakiem `onTaskCreated`
  (F2 faza A w `modules/sub-agents/`). Zwrotka to wyścig „byt powstał" vs „bieg się skończył" —
  koniec przed bytem = błąd wczesny (brak modelu, nieznany `aspect`), wtedy oddajemy modelowi
  jego prawdziwy wynik, jak przed F2.
- **Multi-task w tle** czeka wyłącznie na **pierwszą falę** startów (tyle zadań, ile pula
  `_runWithConcurrency` wpuszcza od razu). Reszta jest raportowana jako `queued`. Bez tego przy
  bramce lokalnej o szerokości 1 „tło" czekałoby na przerobienie całej paczki po kolei — czyli
  nie byłoby tłem. Szerokość puli (zwis delegacji 2026-08-14) zostaje bez zmian.
- **Bramka szerokości liczy też to, co JUŻ biegnie w tle.** Moduł trzyma mapę obietnic
  z wagą (= liczba zadań); `max_parallel_delegations` porównuje `w tle + żądane`. Bez tego
  model wystrzeliłby 5 × 5 zadań w pięciu kolejnych turach i zarżnął most lokalny.
- **Timeout działa jak dotąd** — `_withTimeout` owija bieg także w tle: porzucony sub dostaje
  abort + `stop_stream`, tylko że tura już wcześniej dostała `started`.
- **Priorytet bramki:** `_executeSubAgent` zbija świeżej instancji modelu `_gatePriority = 0`
  (główny czat = 1). ⚠️ **Tylko instancji per rola** — `fallbackModel` to WSPÓŁDZIELONY
  `env.chatModel`, zbicie mu priorytetu zdegradowałoby czat na stałe. Szczegóły:
  `modules/models/CLAUDE.md` gotcha 3c.
- **`MCPClient.executeToolCall(toolCall, agentName, opts)` przyjmuje `opts.origin`**
  (`{agentName, sessionPath?, tabKey?}`) i wstrzykuje je do args jako `_invocationOrigin` —
  ten sam wzorzec zaufanego znacznika co `_invocationAgentName`. **Brak opcji = pole usuwane.**
  Klient originu NIE buduje (zrobi to czat w fazie B); `delegate` przenosi go do rejestru
  biegów i **nie wpuszcza do promptu suba** (czyta z args tylko `task`/`context`/`aspect_explicit`).

## S33 Z2 update (2026-07-30) — `kom_send` dostał dwa bezpieczniki

- **Rate-limit + licznik odbić** (szczegóły: `modules/komunikator/CLAUDE.md`). Kolejność
  w `execute`: `resolveCaller` → widoczność adresata (`unknown_recipient` NIETKNIĘTY) → self →
  **hop** (`komunikator.nextHopFor`, próg 3) → **rate-limit** (`checkSendAllowed`, limit
  z `getLimits().kom_send_rate_max`) → `sendMessage(..., { hop })` → `noteSend`.
  Nowe i18n: `mcp.kom_send.rate_limit` / `mcp.kom_send.hop_limit`.
  ⚠️ **K6 (2026-08-22)** przestawił produkcyjną drogę na ATOMOWĄ `reserveSend`/`releaseSend`;
  **K12 (2026-08-23)** dołożył DRUGI sufit — per NADAWCA, niezależnie od adresata
  (`getLimits().kom_send_rate_max_sender`, czwarty argument `reserveSend`). Odmowa niesie
  `reason: 'pair' | 'sender'`, a `kom_send` wybiera po nim komunikat: `mcp.kom_send.rate_limit`
  (adresat wyczerpany) albo `mcp.kom_send.rate_limit_sender` (cała pula agenta wyczerpana —
  świadomie BEZ rady „napisz do kogoś innego").
- Stała `HOP_LIMIT` jest **zduplikowana** w `KomunikatorTools.js` (obok `KOM_HOP_LIMIT`
  w managerze) — świadomie, żeby `modules/tools/` nie wciągało obsidian-owego barrela
  komunikatora. Zgodności pilnuje test.

## F4 update (2026-08-15) — `delegate` zna wbudowaną parę explorer/worker

**Dwa aspekty, których nie trzeba zakładać na dysku.** `_resolveDelegate` rozpoznaje je po
DOKŁADNEJ nazwie (bez wielkości liter) — ale **dopiero po custom subach usera** (exact + fuzzy).
User, który nazwał własnego suba „explorer", dostaje SWOJEGO; wbudowany jest podłogą, nie sufitem.

| `aspect` | Syntetyczny config | Narzędzia | Model |
|---|---|---|---|
| `"explorer"` | `pkm-explorer`, `role:'explorer'` | `DEFAULT_SUB_AGENT_TOOLS` (read-only) | slot sub-agentów (`researcher`→`minion`) — tani |
| `"worker"` | `pkm-worker`, `role:'worker'` | **pełna lista rodzica** z `toolRegistry.filterByAgent(rodzic)` | **model rodzica** (rola `sub_worker`) |
| brak `aspect` | `pkm-sub` albo globalny szablon (S27 D2) | jak dotąd | jak dotąd |

- ⚠️ **Listę narzędzi workera podajemy JAWNIE.** Pusty/brakujący `config.tools` NIE znaczy
  w runnerze „wszystkie" — `SubAgentRunner._resolveToolNames` spada wtedy na
  `DEFAULT_SUB_AGENT_TOOLS`, czyli read-only, i robotnik po cichu straciłby zapis.
- **Fail-soft:** brak `filterByAgent` / pusta lista / wyjątek → zestaw domyślny + `log.warn`.
  Sondowanie rejestru nie ma prawa wywrócić delegacji.
- **Przecięcie rodzic∩sub (`_getTools`) NIETKNIĘTE** — worker prosi „o tyle, ile ma rodzic",
  a granica bezpieczeństwa i tak przelicza to jeszcze raz po stronie runnera.
- **Worker widzi też `delegate`** (jest w narzędziach rodzica). Rządzi tym strażnik głębokości
  `max_delegation_depth` (default 1 = odmowa z czytelnym komunikatem; sufit 3, jeśli user
  świadomie odblokuje w Ustawieniach → Limity). Świadomie NIE wycinamy narzędzia z listy —
  od pilnowania łańcucha jest kaganiec, nie chirurgia na zestawie.
- **Odmowa `aspect_not_found` wymienia teraz także `explorer, worker`** — model po pomyłce
  ma się dowiedzieć, co w ogóle istnieje.
- **Nazwy `pkm-explorer`/`pkm-worker` są stałymi LOKALNYMI tego pliku** (a nie eksportem
  `modules/sub-agents` jak `PKM_SUB_NAME`): te byty żyją przez jedno wywołanie `delegate`,
  nie mają pliku na dysku i nikt poza `DelegateTool` ich nie zakłada. Etykieta trace bez
  zmian (`sub/pkm-worker#3`).

**Cap kontekstu delegacji: hardcode 16000 → budżet.** `_executeSubAgent` czyta
`getLimits(...).delegation_context_max_chars` (default **48000**, Ustawienia → Limity).

**Slot modelu wybiera JEDNO pole — `config.role`.** `'worker'` → `sub_worker` (model rodzica),
wszystko inne → `researcher` (dotychczasowy slot). Dotyczy też custom suba z `role: worker`
w YAML. `config.model` z YAML wygrywa w obu przypadkach. Szczegóły drabinki:
`modules/models/CLAUDE.md`.

## F5 update (2026-08-15) — `delegate` przestaje sprzedawać błąd jako sukces + grace na podsumowanie

**Zmiana kształtu zwrotki.** `SubAgentRunner.runTask` niesie od F5 `stoppedBy` i (przy
wyjątku) `failed:true` — `_executeSubAgent` czyta oba:

```js
// bieg PADŁ (wyjątek w runnerze)
{ success: false, error: '<tekst błędu>', aspect: 'pkm-sub', stopped_by: 'error', duration_ms: 1234 }
// bieg się odbył
{ success: true, result, aspect, aspect_type, aspect_explicit,
  stopped_by: 'natural' | 'backstop' | 'abort',   // NOWE
  tools_used, tool_call_details, duration_ms, usage }
```

- **Dlaczego to była wtopa:** gałąź `catch` runnera zwracała NORMALNY wynik z tekstem błędu
  w polu `result`, a `_executeSubAgent` owijał to w `{success:true}`. Agent zlecający dostawał
  `status=ok` i referował błąd użytkownikowi jako wykonane zadanie (bieg live 2026-08-15).
- **`stopped_by` mówi o JAKOŚCI wyniku, nie o powodzeniu.** `backstop` = subowi skończyły się
  iteracje, więc wynik może być niepełny albo być zaślepką — ale bieg się odbył i wraca jako
  `success:true`. Model ma na tej podstawie decydować, czy dopytać, a nie czy zgłosić awarię.
- **Runner sprzed F5** (bez `stoppedBy`) → pola po prostu NIE MA, czyli kształt jak dotąd.
- **Multi-task:** elementy `results[]` idą tą samą ścieżką, więc dziedziczą jedno i drugie.
- **Ścieżka tła BEZ ZMIAN** — pokwitowanie `{started, task_id}` nic nie wie o losie biegu
  (ten wraca powiadomieniem; `buildSubTaskNotificationText` dla statusu `error` niesie
  `task.error`, nie zaślepkę).
- **Konsumenci starego kształtu:** czat renderuje `success:false` istniejącą gałęzią błędu
  (`chat_streaming` — blok `isSubAgent && !result?.success`); scenariusz harnessa 31 faza 3
  (timeout) też wraca `{success:false}` i przechodzi bez zmian.

**Grace-okno na finalne podsumowanie (`subagent_final_grace_ms`, default 45 s).**
`delegation_timeout_ms` obejmuje CAŁY bieg suba, więc budzik potrafił strzelić dokładnie
wtedy, gdy sub pisał już podsumowanie backstopu — zadanie paliło pełny budżet na narzędzia
i oddawało zaślepkę zamiast dorobku (znalezisko nocy audytowej 2026-08-14/15).

- `_withTimeout` przyjmuje opcjonalne `grace` (`{ms, shouldDefer, onDefer}`). Gdy główny
  budzik strzela, `_isInFinalSummary` czyta kroki karty biegu z rejestru: krok `backstop`
  **bez późniejszego `loop.end`** = sub jest w finalnej iteracji.
- Jeśli tak — abortu NIE MA; uzbrajamy **jednorazowy** drugi budzik na `subagent_final_grace_ms`
  i zapisujemy `registry.step(task, 'timeout.grace', {ms})`. **Nowy TYP zdarzenia**, format
  linii trace bez zmian. Komunikat po grace podaje CAŁY przeczekany czas (`timeout after
  <budżet + grace>ms`).
- W zwykłej iteracji abort leci **natychmiast**, jak dotąd.
- Wpięte we WSZYSTKIE trzy ścieżki delegacji (multi-task, single w tle, single blokujący) —
  `task.id` zbierany z istniejącego haka `onTaskCreated` (jedyne miejsce, gdzie id już istnieje).
- **Fail-soft na całej długości:** brak rejestru / brak `getTask` / wyjątek sondy → zero
  odroczenia. ⚠️ Sufit `maxStepsPerTask` (500) może w BARDZO długim biegu zjeść krok
  `backstop` — wtedy też brak odroczenia (brak dowodu = zachowanie sprzed F5).
- ⚠️ **`perCallTimeoutMs` pętli i przezbrajanie `gate_admitted` NIETKNIĘTE** — to osobna
  warstwa (fix zwisu 2026-08-14), z własnymi testami.

Sterowanie biegiem w trakcie (`postMessage`) mieszka po stronie `modules/sub-agents` —
`DelegateTool` nic o nim nie wie.

## Front A update (2026-08-17) — watchdog ciszy + ratowanie dorobku (inicjatywa „Suby: watchdog ciszy i szyba 2026")

**Tło (śledztwo 2026-08-17):** trzy explorery zrobiły pełne 12/12 iteracji researchu i wszystkie
zostały ubite zegarem 120 s + 45 s grace dokładnie w chwili pisania finalnej syntezy na wolnym
lokalnym moście API — delegate oddał trzy gołe `Sub-agent timeout after 165000ms`, dorobek do kosza.

- **Nowe defaulty (`config/limits.ts`):** `delegation_timeout_ms` 120000 → **480000** (zegar
  ścienny = awaryjny sufit, nie główny strażnik), `subagent_final_grace_ms` 45000 → **120000**
  (sufit 240000). **Nowe klucze:** `subagent_stall_timeout_ms` (**180000**, 0 = off) — watchdog
  ciszy per model-call suba (żyje w `AgentLoop._streamOnce`, chunk/gate przezbrajają budzik);
  `subagent_salvage_max_chars` (**12000**, 0 = off) — sufit skrótu dorobku. Wszystko w
  Ustawienia → Limity.
- **`_withTimeout` ma 7. parametr `salvage: SalvageMapper | null`.** Po strzale budzika `kill`
  NIE oddaje już goły błąd od ręki: abort leci jak dotąd, ale wyścig dostaje okno
  `SALVAGE_SETTLE_MS` (1,5 s), żeby UBITY bieg zdążył się domknąć (abort → stream reject →
  `finalize('abort')` → runner oddaje częściowy wynik). Wynik wyścigu po strzale budzika jest
  ZAWSZE mapowany mapperem: bieg z dorobkiem → `{success:false, error:'Sub-agent timeout after
  <ms>ms', stopped_by:'timeout', partial_result, tools_used?, aspect?, duration_ms?}`; realny
  błąd biegu (`success:false`) zostaje nietknięty (mapper zwraca null). `partial_result` = tekst
  biegu albo skrót z `tool_call_details` (`_digestFromToolDetails`, podglądy po 500 znaków),
  przycięty do `subagent_salvage_max_chars`. Bez mappera (limit 0) — zachowanie sprzed Frontu A
  co do milisekundy. Odrzucenie ubitego biegu PO strzale budzika wraca gołą zwrotką (guard
  `guarded`), przed strzałem — rzuca jak dotąd.
- **Sub złapany w środku długiego NARZĘDZIA** nie zdąży w oknie 1,5 s (narzędzie ma własny
  timeout 60-180 s) — wtedy goła zwrotka, świadomie. Pełny salvage z transkryptu robi pętla
  w backstopie (`_fallbackWithSalvage` w `modules/agent-loop`), więc najczęstszy przypadek
  (padła finalna synteza) i tak niesie dorobek w `result`.
- Opis parametru `timeout_ms` w schemacie mówi teraz wprost: zostaw NIEUSTAWIONY (budżet idzie
  z Ustawień) — model przycinał subom budżet z palca (incydent 2026-08-17: `timeout_ms: 120000`).

## Z2 update (2026-08-15) — budżet delegacji to czas ROBOTY, nie stania w kolejce

**FAIL 4 żywego smoke'a:** `sub/pkm-worker#3` stał **76 s** w kolejce bramki `lm_studio`
(limit 1, sub ma priorytet 0, czyli wchodzi za rozmową główną), dostał slot, zrobił trzy
narzędzia — i zginął w **120,0 s** z komunikatem „Request do lm_studio anulowany w kolejce
bramki (stop/timeout)", nie dowożąc zadania. Powód: `_withTimeout` liczył
`delegation_timeout_ms` od ZŁOŻENIA zlecenia, więc budżet obejmował czekanie w kolejce.
Per-call budzik pętli miał już przezbrajanie sygnałem `gate_admitted` — budżet zadania nie.

- **`_makeGateArm()`** (lokalny helper) + szósty parametr `_withTimeout(..., arm)`.
  `arm.signal()` woła pętla przy KAŻDYM wpuszczeniu na slot, ale liczy się **tylko pierwsze**
  — kolejki w środku biegu świadomie wliczają się do budżetu, inaczej bieg nie miałby sufitu.
- Sygnał jedzie: `runControl.onGateAdmitted` → `runTask(options.onGateAdmitted)` →
  `runAgentLoop({onGateAdmitted})` → handler `gate_admitted` w `_streamOnce`. Wpięte we
  **wszystkich trzech** ścieżkach delegacji (multi-task, single w tle, single blokujący).
- ⚠️ **Świadome odstępstwo od literalnego zlecenia** („uzbrój dopiero przy pierwszym
  sygnale"): budzik jest uzbrojony OD RAZU i przy pierwszej admisji liczony **od nowa**.
  Powód: sub, który slotu nigdy nie dostanie — albo model, który sygnału nie emituje (atrapy
  w testach, obca implementacja `LoopModelLike`) — zostałby bez żadnego sufitu. To ten sam
  wzorzec, którym `AgentLoop` obsługuje per-call budzik, więc obie warstwy liczą tak samo.
  **Skutek dla przypadku granicznego:** gdy czekanie w kolejce przekroczy CAŁY budżet, sub
  nadal ginie w kolejce (tak samo zrobiłby zresztą per-call budzik pętli). Zadanie
  z incydentu (76 s kolejki, 120 s budżetu) jest tym fixem naprawione.
- **Wyciek przy okazji:** `_withTimeout` dostał flagę `settled` — spóźniony sygnał bramki po
  rozstrzygniętym wyścigu nie może już uzbroić NOWEGO budzika (`finally` zdążył posprzątać).
  Bez tego proces testowy nie kończył się (AVA: „Failed to exit").

Testy (`DelegateTool.test.ts`, na PRAWDZIWEJ pętli `runAgentLoop`): „FAIL 4: budżet zadania
liczy się od WJAZDU na slot bramki", „Z2: bez sygnału bramki budzik działa jak dotąd"
oraz „FAIL 3: Stop na biegu stojącym W ŚRODKU wywołania modelu kończy go NATYCHMIAST".

## K6 update (2026-08-22) — jedna droga do skrzynki + bramki poczty atomowe

Naprawa AUD-security-011/046/044/006/013. Szczegóły mechaniki: `modules/komunikator/CLAUDE.md`.

- **`sendAgentMail(plugin, {from, to, subject, content})` — NOWY eksport `KomunikatorTools.ts`
  i JEDYNA droga, którą poczta agenta trafia do cudzej skrzynki.** Wołają ją `kom_send`
  i `agent_delegate`. Kolejność kontroli bez zmian (tożsamość → widoczność NADAWCY → widoczność
  ADRESATA → self → hop → rate-limit → zapis), ale teraz liczona w JEDNYM miejscu.
  ⚠️ Funkcja **nie jest w barrelu** — to bebech modułu, `AgentDelegateTool` importuje ją wprost.
- **`agent_delegate` przestał wołać `KomunikatorManager.sendMessage`.** Do K6 był drugą drogą
  do skrzynki: bez rate-limitu, bez licznika odbić i bez filtra ducha po stronie NADAWCY (agent
  `komunikator_visible:false` przemycał tędy list, a jego nazwa lądowała adresatowi w `od:`
  i w pingu sesji). Odmowa bramki **nie wywraca samej propozycji delegacji** — kontekst niesie
  `context_summary` w wyniku (zachowanie z S28 D6), leci tylko `log.warn`.
- **Lista „dostępni" w błędzie `agent_delegate` idzie z `listKomunikatorAgents()`**, nie
  `getAllAgents()` — błąd narzędzia był darmową enumeracją agentów-duchów.
- **`kom_send`/`kom_read` chodzą po wspólnym łańcuchu `komunikator.withAgentLock(agent)`.**
  Bez tego `Promise.all` z jednej odpowiedzi modelu przepuszczał cały wsad przez bramki
  (10 wysyłek przy limicie 2) i wysyłał listy z wyzerowanym licznikiem odbić.
- **Event `communicator:message_sent` emituje TYLKO `sendAgentMail`** — delegacja przestała
  wypychać własną kopię (odbiorcy i tak czytają samą nazwę zdarzenia).

## K11 update (2026-08-22) — przecięcie przy delegacji, zgoda `web_read`, autostart MCP

Naprawa AUD-security-008/072/020/069/005/051 (+ weryfikacja 028). Dwa nowe gotcha do zapamiętania:

- ⚠️ **K11: dziecko delegacji dostaje PRZECIĘCIE, nie config własny.** `MCPClient` wstrzykuje
  do args dwa kolejne zaufane znaczniki — `_invocationScopeFolders` (zakres wołającego)
  i `_invocationToolNames` (jego whitelista) — tym samym wzorcem co `_invocationDelegationDepth`
  i `_invocationAutonomy: wartość podaje runtime, a **poza delegacją pole jest USUWANE**.
  `delegate` liczy z nich przecięcie z configiem odpalanego suba: zakres przez
  `AccessGuard.intersectScopeFolders` (zostaje węższy wpis; **rozłączne = odmowa**,
  `mcp.delegate.scope_disjoint`), narzędzia przez `SubAgentRunner._getTools` (trzeci składnik
  koniunkcji) oraz `buildBuiltinWorkerConfig`, który przy zleceniu z piętra ≥1 bierze listę suba,
  nie agenta głównego. Do K11 wnuk startował z zakresem policzonym WYŁĄCZNIE z własnego configu
  (`pkm-sub` go nie ma → `null` → pełny zasięg agenta) i z whitelistą liczoną względem
  `activeAgent`. **Dokładasz cokolwiek, co dziecko dziedziczy — przekaż to znacznikiem, nie
  odczytem stanu pluginu** (ta sama zasada co K4).
- ⚠️ **K11: ryzyko `write` liczy się z `mode`, nie z `action`.** `WriteTool` bierze
  `args.mode || 'replace'` i pola `action` NIE CZYTA, więc klasyfikator też nie może go czytać —
  `write {action:'create'}` bez `mode` był YELLOW (wyciszany przełącznikiem `vault_write`),
  a narzędzie nadpisywało plik. `_shouldRequestApproval` ma dla `write`/`vault_write` osobną
  gałąź; fallback na `action` zostaje narzędziom, które go realnie używają (`todo`, `artifact_*`,
  `kom_*`). Świadomie NIE normalizujemy `action`→`mode` — to zmieniłoby zachowanie narzędzia,
  a naprawa dotyczy klasyfikacji.
- ⚠️ **K11: `web_read` ma WŁASNĄ tożsamość approvalu** — akcja `web.read` (nie `web.search`),
  klucz `web_read` w `APPROVAL_DEFAULTS` (domyślnie **pytaj**) i `_getApprovalToggleKey`, własny
  wiersz w profilu → Uprawnienia, własny opis i etykieta w `ApprovalModal`. Wyciszenie
  wyszukiwarki NIE otwiera pobierania stron, a trwała reguła „Zawsze zezwalaj" zapada osobno
  (`web.read::<url>`). Bramka proweniencji (`isUrlKnown` w `WebReadTool`) stoi niezależnie.
- ⚠️ **K11: `ExternalMcpManager.autostart()` NIE BLOKUJE.** Łączy serwery równolegle i wraca od
  razu (`main.ts` woła ją przez `void`, wzór `vaultIndexer.initialize()`), bo `plugin._ready`
  bramkuje czat i sidebar. Na rozstrzygnięcie prób czeka `whenAutostartSettled()` — dla testów
  i harnessa, nie dla produkcji. `connect` ma teraz JEDEN budżet na handshake + `listTools`
  (wspólny `deadline`), a nie dwa pełne okna. `previewTools` zostaje przy dwóch — to świadoma
  akcja usera ze spinnerem, nie ścieżka startu.
- ⚠️ **K11: nazwa notatki w modalu `memory_save` idzie z `makeMemoryNoteFilename`** (import
  z `../memory/index.js`), a nie z lokalnej, uproszczonej kopii reguły. Dwie normalizacje
  rozjeżdżały się na polskich nazwach: modal pokazywał `..._wa_ne_has_o...`, na dysk szło
  `..._wazne_haslo...`. **Nie odtwarzaj reguł nazewniczych narzędzia w kliencie** — zawołaj tę
  samą funkcję.

## K16 update (2026-08-23) — obraz źródłowy `add_text_to_image` przez pełną bramkę

Naprawa AUD-security-102/126 (drugi bieg audytu security, zgłoszone w obu rundach).

- **`AddTextToImageTool.execute` woła `PermissionSystem.checkPermission(agent, 'vault.read',
  <źródło>, { scopeFolders })` PRZED `readBinary`** — i przed sprawdzeniem, czy plik w ogóle
  istnieje (odmowa nie ma prawa zdradzić nawet tego). Do K16 źródło szło wyłącznie przez
  `validateVaultPath`, a bramka `MCPClienta` dostawała sam CEL (K2), więc agent z whitelistą
  `Publiczne` i No-Go `Prywatne` wołał `{path:'Prywatne/skan_dowodu.png',
  output_path:'Publiczne/kopia.png'}` i przepisywał plik z zakazanej strefy tam, gdzie sięga.
- **Tożsamość i zakres z ZAUFANYCH znaczników** `_invocationAgentName` / `_invocationScopeFolders`
  (wstrzykuje je `MCPClient`, model ich nie podrabia) + `plugin.agentManager.getAgent(name)`.
  Rozwiązanie agenta jest DOKŁADNIE takie samo jak w `MCPClient` (nazwa, a w jej braku aktywny
  agent) — dwie bramki muszą oceniać tę samą tożsamość, inaczej rozjazd wraca inną furtką.
- **Brak agenta albo brak `plugin.permissionSystem` = ODMOWA fail-closed** (i18n
  `mcp.text_overlay.source_denied` + `…no_permission_gate`), nie cichy odczyt. Bieg poza
  `MCPClient` nie jest zwolnieniem z kontroli.
- **Świadomie `checkPermission`, nie goły `AccessGuard`** — No-Go, pliki chronione, whitelista,
  zakres suba i `admin_access` mają być liczone w jednym miejscu (wzór K2/K13).
- **Okno zgody pokazuje ŹRÓDŁO.** `approvalContext.sourcePath` istniał od K2, ale nikt go nie
  renderował: `ApprovalModal` nie ma generycznego wypisu kontekstu, więc doszedł jeden wiersz
  („Źródło: <ścieżka>", i18n `approval.source_label`) obok istniejącego celu. Pole jest
  opcjonalne — narzędzia jednościeżkowe go nie podają i nic się dla nich nie zmienia.
- **Brakujący klucz `mcp.text_overlay.invalid_path` dopisany** (pl+en). Kod wołał go od dawna,
  a `t()` oddawało gołą nazwę klucza — user i model widzieli `mcp.text_overlay.invalid_path`
  zamiast komunikatu.
- Sprawdzone przy okazji: `generate_image` nie ma DRUGIEJ ścieżki wejściowej (bierze sam prompt,
  cel to folder z ustawień — K2), a `modules/multimodal/` czyta pliki wyłącznie z aktywnej
  notatki usera (`buildActiveNoteContext`), nie ze ścieżki podanej przez model.
- Testy: `AddTextToImageTool.test.ts` (+5) — źródło w No-Go/poza whitelistą, źródło legalne,
  zakres suba (poza/wewnątrz), brak tożsamości/bramki, `.pkm-assistant` jako źródło.
  „Przeszło" mierzy LICZNIK odczytów vaulta, bo render i tak pada bez canvasu.

## K3-E update (2026-08-23) - meldunek ze stanu, nie z zamiaru

Naprawa AUD-bledy-026/028/020 (klaster E biegu `bledy`).

- ⚠️ **`ask_user` bez UI = `{success:false, error:'ask_user.no_ui'}`, nigdy odpowiedź.** Gdy
  `plugin._askUserPromise` nie istnieje (tura leci w zakładce W TLE, blok pytania powstaje tylko
  pod `isActiveTab` w `chat_streaming._chatOnToolCallsParsed`), narzędzie ODMAWIA i dokłada
  `message` (i18n `mcp.ask_user.no_ui`) z instrukcją "nie zgaduj". Dawny fallback oddawał modelowi
  PIERWSZĄ OPCJĘ jako zgodę usera (`success:true, auto:true`) - sfabrykowana zgoda człowieka.
  **Nie przywracaj auto-odpowiedzi w tej gałęzi**; jeśli pytanie ma przeżyć tło, ma trafić do
  kolejki jak wyniki subów, a nie zostać zmyślone. (Budzik 5 min czyszczony teraz w `finally`.)
- ⚠️ **AUD-code-review-002 (2026-08-30): budzik 5 min dostał TĘ SAMĄ naprawę co gałąź „brak
  UI" wyżej.** Do naprawy `ask_user` po 5 minutach bez odpowiedzi usera zwracał
  `{success:true, answer:<pierwsza opcja>, auto:true}` — dokładnie ta klasa bugu (sfabrykowana
  zgoda), którą AUD-bledy-026 zamknął w sąsiedniej gałęzi, ale nie w tej. Dziś timeout oddaje
  `{success:false, error:'ask_user.timeout', message: t('mcp.ask_user.timeout'), question}` —
  ten sam kształt co `ask_user.no_ui`. **Nie przywracaj auto-odpowiedzi tu ani gdziekolwiek
  indziej w tym pliku** — flaga `auto` nie ma dziś żadnego czytelnika poza sufiksem UI w
  `ToolCallDisplay.ts`, więc nic jej nie odróżnia od prawdziwej odpowiedzi człowieka.
  `createAskUserTool(options)` ma opcjonalny parametr `{timeoutMs}` — WYŁĄCZNIE do testów
  (budzik produkcyjny zawsze dostaje `ASK_USER_TIMEOUT_MS`, bez niego test na tę gałąź musiałby
  czekać naprawdę 5 minut). Do AUD-dead-code-020/089 (2026-09-02) sygnatura brała jeszcze
  nieczytany pierwszy parametr `app`, dziś zdjęty.
- ⚠️ **`delegate` multi-task w tle rozróżnia `tasks` / `queued` / `rejected`.** Zadania odbite od
  ręki (puste `task`, nietrafiony `aspect`) NIE wchodzą do rejestru, więc powiadomienie o nich nie
  przyjdzie - liczymy je RAZ, przed pulą (`precheck`), i oddajemy modelowi w polu `rejected`
  (`{task, aspect, error}`). `queued`, `count` w nocie i pierwsza fala bramek liczą się WYŁĄCZNIE
  z zadań przyjętych; sama paczka odmów = `success:false`. Ścieżka blokująca ma je jak dotąd
  w `results` (kolejność wejścia bez zmian).
- ⚠️ **Ustawienia → Narzędzia: zapis ma własny meldunek, a kill-switch nie czeka na zapis.**
  Decyzje siedzą w czystym `settingsPersist.ts` (`persistOrRollback`, `applyServerKillSwitch`) -
  DOM zostaje w `SettingsContent`. Reguła: mutacja w pamięci → `close()` (przy wyłączaniu,
  NIEZALEŻNIE od zapisu) → zapis; pad zapisu = COFNIĘCIE mutacji + `Notice`
  (`settings.save_failed`) + przerysowanie ze stanu prawdziwego. Bez tego `await persist()` bez
  `catch` zjadał odrzucenie, a wiersz malował "wyłączony" nad serwerem, który dalej dostarczał
  narzędzia agentom.

## K3-J update (2026-08-23) - MCP i narzędzia meldują ze stanu

Naprawa AUD-bledy-029/021/022/023/034/024 + AUD-security-128 (klaster J biegu `bledy`).

- ⚠️ **`memory_save` / `memory_delete`: „zmiana zatwierdzona" ≠ „indeks odświeżony".**
  `rebuildBrainIndex()` siedzi w WŁASNYM `try` — po zapisie notatki (albo po jej kasacji),
  które są już nieodwracalne. Jej pad NIE zamienia operacji w porażkę: zwrotka zostaje
  `success:true` i dostaje dwa pola — `index_stale:true` + `warning` (i18n
  `mcp.memory_save.index_stale` / `mcp.memory_delete.index_stale`) — plus `log.error`.
  Powód: od K4 `rebuildBrainIndex` jest FAIL-CLOSED i **RZUCA** przy niepewnym odczycie
  brain.md (gotcha 9 w `modules/memory/CLAUDE.md`), a dopóki siedziała w tym samym `try`,
  jej wyjątek meldował `{success:false}` po udanej zmianie: model ponawiał `memory_save`
  i odbijał się o create-only (`note_already_exists`), a przy kasacji dostawał
  `note_not_found` o pliku, którego sam przed chwilą pozbył się z dysku. **Nie zwijaj tego
  z powrotem do jednego `try`** i nie nazywaj tego pola `error` — `toolResultStatus`
  policzyłby wynik jako porażkę (krok 8b).
- ⚠️ **Pamięć odmów w `MCPClient` WYGASA (`DENIAL_TTL_MS`, 15 min).** `_deniedActions` to
  teraz `Map<agent, Map<klucz, moment wygaśnięcia>>`, a `_isDenied` po drodze usuwa wpisy
  przeterminowane. Do tej naprawy `clearDenials()` nie miało w produkcji ANI JEDNEGO wołacza,
  a `MCPClient` powstaje raz na cały cykl życia pluginu — jedno kliknięcie „Odmów" na
  narzędziu bez ścieżki (klucz `<narzędzie>::*` = CAŁE narzędzie: external MCP, `delegate`)
  odbijało każde następne wywołanie bez modala, w każdej zakładce, aż do restartu pluginu.
  Model dostawał przy tym instrukcję „NIE ponawiaj", więc temat umierał. `clearDenials()`
  ZOSTAJE jako droga natychmiastowa (przełączenie sesji/agenta, gdyby czat kiedyś chciał ją
  wołać jawnie); TTL jest siatką na to, że nikt jej nie woła. Testy nadpisują okno przez
  `new MCPClient(..., { denialTtlMs })`.
- ⚠️ **`ExternalMcpManager` NASŁUCHUJE śmierci serwera — `transport.onclose` / `onerror`.**
  Haki idą na TRANSPORT i **PRZED** `client.connect()`: `Protocol.connect` zachowuje wcześniej
  ustawiony hak i woła oba (`shared/protocol.js`), więc obsługa SDK zostaje nietknięta.
  Oba prowadzą do `_reap(serverId, powód)`: wpis z `_connections`, wyrejestrowanie narzędzi
  z `ToolRegistry` + `_toolIndex`, `status:'error'` z `lastError`. Do tej naprawy po padzie
  procesu stdio status dalej mówił `connected`, Ustawienia i Konektory rysowały zieloną
  kropkę z guzikiem „Rozłącz", a martwe narzędzia szły modelowi w definicjach. **UI nie
  dostało nic nowego** — `renderExternalRow` i `listServersForUi` czytają `getStatus()`
  przy każdym renderze, więc widzą to same z siebie.
  ⚠️ `close(id)` zdejmuje wpis z `_connections` **jako pierwszy** — to zamknięcie ZAMIERZONE,
  więc `onclose`, który zaraz padnie z `client.close()`, przechodzi przez `_reap` bez skutku
  i nie przemalowuje `off` na `error`. Nie przestawiaj tej kolejności.
- ⚠️ **`closeAll(timeoutMsPerServer = 5000)` = `Promise.allSettled` + sufit per serwer +
  flaga `_unloaded`.** Sekwencyjna pętla z `await` dawała jednemu wiszącemu serwerowi stdio
  do ~4 s budżetu SDK (stdin.end → SIGTERM → SIGKILL), więc trzeci na liście dostawał `close()`
  dopiero po ~8 s od `onunload` — którego Obsidian nie czeka. Po suficie porzucamy obietnicę
  z logiem (rejestr i mapa są wtedy i tak posprzątane). Flaga `_unloaded` wstaje NA POCZĄTKU
  `closeAll` i bramkuje `autostart()` oraz `connect()` — w tym DRUGI raz, już PO handshake'u
  i przed `_connections.set`, bo `npx` przy pierwszym starcie ciągnie paczkę kilkanaście
  sekund i potrafi wstać po demontażu (świeży klient jest wtedy zamykany od ręki).
  **`src/main.ts` bez zmian** — `closeAll()` zostaje fire-and-forget i po tej zmianie
  nie odrzuca już nigdy (`allSettled` połyka wszystko), więc brak `.catch` u wołacza jest
  nieszkodliwy. Flaga nie jest resetowana i nie musi: `onunload` to jedyny wołacz `closeAll`,
  a `onload` buduje NOWĄ instancję managera.
- ⚠️ **Błąd połączenia ma DWÓCH odbiorców: człowieka i log.** `_explainConnectError(raw, cfg)`
  rozpoznaje błąd po KSZTAŁCIE i oddaje zdanie i18n — 401 (jak w Z2.4), `ENOENT` („nie
  znalazłem programu {{cmd}}"), `EACCES`/`EPERM`, `ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/
  `ECONNRESET`, timeout. Nierozpoznany kształt = **stara ścieżka** (surowy tekst przez
  `maskSensitiveData`). Do logu leci ZAWSZE pełny surowy tekst (zamaskowany), do UI zdanie.
  Wstawki (`command`/`url` usera) też idą przez maskę — `url` potrafi nieść token w query
  stringu, a to zdanie ląduje w `Notice` i w wierszu serwera. `SettingsContent` **nietknięty**:
  czyta `res.error` i `status.lastError`, czyli dostaje przetłumaczone zdanie za darmo.
  Dokładasz nowy kształt → dokładasz klucz do **pl.ts I en.ts** (parytet pilnuje
  `core/i18n/parity.test.ts`, a `ExternalMcpManager.test.ts` sprawdza, że `t()` nie oddaje
  gołej nazwy klucza).
- ⚠️ **Zewnętrzne `catch` narzędzi maskują tak samo jak K8/K20.** `MCPClient.executeToolCall`,
  `DelegateTool` i `AgentDelegateTool` przepuszczają komunikat wyjątku przez
  `maskSensitiveData` z `core/index.js`, zanim oddadzą go MODELOWI i transkryptowi tury.
  K8 (AUD-security-055) postawił tę granicę tylko wewnątrz `SubAgentRunner.runTask`, a te
  trzy miały WŁASNE catch-e, które jej nie dziedziczyły — komunikat pada strumienia bywa
  całym `JSON.stringify(event)` razem z nagłówkiem `Authorization`, a błąd I/O adaptera
  niesie pełną ścieżkę systemową. **Każdy nowy catch, którego treść wraca do modelu, ma iść
  tą samą maską** — nie pisz drugiej.

## AUD-code-review-2026-08-30 update — kaseta F05 (uczciwość narzędzi + rezerwacja id + blokada handshake'u)

Cztery znaleziska z pierwszego pełnego biegu `/code-review` (klaster K1/K8 audytu), naprawa w
`fix/cr-F05-tools-uczciwosc`. Wspólny mianownik pierwszych trzech: narzędzie miało dwie ścieżki
(zdrową i błędną/zakolejkowaną), naprawiono jedną, druga zostawała nietknięta.

- ⚠️ **AUD-code-review-001: `stopAllDelegations` ma DRUGĄ, wcześniejszą bramkę — `_moduleUnloaded`.**
  `_liveAborts` (Z7 wyżej) dostaje kontrolkę abortu dopiero WEWNĄTRZ thunka puli multi-task
  (`_runWithConcurrency`) — zadanie stojące jeszcze w kolejce (bramka platformy lokalnej = 1,
  `queued > 0`) było dla niego niewidzialne. `stopAllDelegations` podnosi dziś flagę modułu
  `_moduleUnloaded` PIERWSZA, przed pętlą po `_liveAborts`; `_runWithConcurrency` sprawdza ją
  PRZED startem KAŻDEGO kolejnego thunka i odmawia bez wołania `_executeSubAgent` (bez budowy
  modelu, bez promptu z dysku). Flaga jest stanem PROCESU jak `_liveAborts`/`_backgroundRuns` —
  raz podniesiona zostaje do końca życia pluginu; testy zerują ją `__test__._resetModuleUnloaded()`.
  Nowy kod błędu dla pominiętych zadań: `mcp.delegate.plugin_unloaded`.
- ⚠️ **AUD-code-review-002: `ask_user` po timeoucie (5 min) NIE zmyśla zgody** — ta sama klasa
  bugu co AUD-bledy-026, tylko w sąsiedniej gałęzi tej samej funkcji. Pełny opis + kontrakt
  DI (`createAskUserTool(options)` z `{timeoutMs}`) w sekcji „K3-E update" wyżej.
- ⚠️ **AUD-code-review-061: `ExternalMcpManager.connect()` ma blokadę współbieżności PER
  SERVERID — `_connecting`.** Był check-then-act na `_connections` bez żadnej rezerwacji „w
  trakcie łączenia": dwa równoczesne `connect()` dla TEGO SAMEGO serwera (typowo: `autostart()`
  bez await + klik „Połącz" w Ustawieniach w oknie wolnego handshake'u `npx`) oba przechodziły
  test pustej mapy, oba stawiały OSOBNY klient/proces, a późniejszy `_connections.set()` po
  cichu nadpisywał wcześniejszy — pierwszy proces potomny nigdy nie dostawał `close()` (zombie
  do końca sesji). Ciało handshake'u wyjechało do `_doConnect(serverConfig, serverId)`; `connect()`
  trzyma teraz `Map<serverId, Promise<...>>` — drugie i każde kolejne wywołanie w oknie
  handshake'u dostaje TĘ SAMĄ obietnicę zamiast startować własną, a wpis znika z mapy w `finally`
  po rozstrzygnięciu (kolejne wywołanie PO nim idzie normalną ścieżką, `alreadyConnected` albo
  świeży handshake). **Dokładasz nowe wczesne `return` w `connect()`?** Wstaw je PRZED blokadą
  `_connecting`, nie w `_doConnect` — inaczej druga strona wyścigu dalej zdąży wystartować
  własny proces, zanim pierwsza zdąży zarezerwować slot.
- ⚠️ **AUD-code-review-050: import z Claude Desktop ma TĘ SAMĄ walidację id co ręczne dodawanie
  serwera.** `buildImportRows` (`claudeConfigImport.ts`) liczyła kolizję WYŁĄCZNIE z
  `existing` (ustawieniami) — ani kolizji z nazwą WBUDOWANĄ (`ExternalMcpManager.validateServerId`,
  R3), ani duplikatu WEWNĄTRZ importowanej paczki (dwie różne nazwy z Claude Desktop, które
  `slugifyServerId` sprowadza do tego samego id, np. `"Filesystem"`/`"filesystem"`). Dziś
  `buildImportRows(parsed, existing, builtinNames)` liczy oba dodatkowe powody blokady —
  `exists:true` (pole, które modal, celowo GŁUPI, jedyne czyta) + `blockedReason:
  'duplicate'|'reserved'|'format'` dla wołacza, który chce zdanie dokładniejsze niż „już
  istnieje". **Druga warstwa (obrona w głąb) siedzi w `SettingsContent.ts` `onConfirm`** —
  liczy `validateServerId` + zbiór `takenIds` (rosnący W TRAKCIE pętli po `configs`) tuż przed
  `servers.push`, więc nawet gdyby modal kiedyś przestał czytać `exists` poprawnie, zapis do
  `data.json` i tak zostaje czysty. `builtinNames()` w obu miejscach czyta
  `plugin.toolRegistry.getBuiltinServerMap()` (ta sama SSOT co `MCPServerEditorModal
  ._builtinNames()`), fail-soft na `[]`, gdy `toolRegistry` niedostępny (stary/testowy host —
  wtedy kontrola formatu/duplikatu wewnątrz paczki dalej działa, tylko rezerwacja nazw wbudowanych
  nie).

## AUD-dead-code klaster D5 update (2026-09-02) — higiena powierzchni publicznej, zero zmian zachowania

Fabryka kasacji martwego kodu, bieg `2026-09-02_dead-code`, klaster D5 (`modules/tools/`).
**Zero zmian zachowania** — sam wynik narzędzi, żaden agent nie czytał tego kodu. Zamknięte:
AUD-dead-code-016, 017, 019, 020, 021, 022, 023, 089, 108, 109, 165, 166, 209, 210, 211, 258.

- **16 fabryk narzędzi straciło nieczytany parametr `app`** (020/089) — patrz komentarz przy
  „Fabryki narzędzi" wyżej. `src/main.ts` woła je dziś bezargumentowo; dwa rzutowania
  `as PluginDynamic` (`createReadTool`/`createListTool`) skasowane jako zbędne. `DelegateTool.ts`
  prywatny helper `_executeSubAgent` stracił analogiczny martwy piąty parametr `app` (258) —
  sub-agent i tak dostaje uchwyt `app` z domknięcia fabryki (`new SubAgentRunner({...})`), nie
  z tego parametru.
- **`ServerLoader` zdjęty z barrela** (016/209) — klasa żyje (deep-import w `ServerManager.ts`
  + w teście), tylko nie przez `index.ts`. **8 aliasów re-eksportu manifestów** skasowane
  z `built-in-servers/index.ts` (017/210) — realni konsumenci chodzą przez `BUILTIN_MANIFESTS`
  / `getBuiltinManifest`.
- **`DEFAULT_TIMEOUT_MS`/`MAX_TIMEOUT_MS`** przestały być exportowane (019) — czysto prywatne
  stałe `server_timeout.ts`, czytane wyłącznie przez `resolveTimeoutMs` u siebie.
- **Trzy funkcje straciły `export`** (021): `ensureFolder` (`vault_binary_io.ts` — kolizja nazwy
  z metodą `KomunikatorManager.ensureFolder()`, ale to inny byt), `groupBuiltinTools`
  (`ConnectorsBackstageTab.ts`), `resolveKomSendTarget` (`KomunikatorTools.ts` — mechanizm K1
  ŻYWY, tylko wołany wewnątrz pliku przez `contextExtractor` i `execute`).
- **`TextOverlayPosition`** (`text_overlay_helper.ts`, 022/211) i **`TodoState`**
  (`built-in-servers/artifacts/TodoTool.ts`, 165) straciły `export` — homonimy/typy bez
  konsumenta poza plikiem. **`SearchWhere`** (`SearchTool.ts`, homonim z `modules/memory/
  RetrievalEngine.ts:120`) tak samo, z census 166.
- **`AdapterEntry` — martwy IMPORT** w `ListTool.ts` skasowany (023/109); sam typ zostaje
  exportowany w `vault_adapter_io.ts` (żyje u siebie), tylko `ListTool.ts` go nie potrzebował.
- **39 typów/interfejsów w bebechach straciło `export`** (108) — jednolita reguła: knip ich nie
  widział, bo żyją wyłącznie w sygnaturze `execute`/`contextExtractor` WŁASNEGO pliku, a poza nim
  zero importerów. Rozrzucone po ~20 plikach (`*ToolArgs`, `*Plugin` gdy bez zewnętrznego
  konsumenta, `ResolvedDelegate`, `DelegateToolDeps`, `ToolContext`, `ToolAxisDecision`,
  `ListAdapterOptions`/`AdapterListing`, `BinaryData`, `VaultPathValidation`/`VaultPathOptions`/
  `PathValidatorAgentManager`/`InvocationArgs`, `PersistOutcome`/`KillSwitchOutcome`,
  `ToolArgs`/`ToolAliasResult`, `TimeoutCarryingConfig`, `SemanticNoteParams`, `ArtifactStoreLike`
  — pełna lista w `AUD-dead-code-108`). Typy z realnym konsumentem poza plikiem (np.
  `AskUserPlugin`, `MemorySavePlugin`/`MemoryDeletePlugin` — czytane przez testy;
  `SemanticNotePlugin`, `WebToolSettings`/`WebSearchPlugin`, `ArtifactToolPlugin`/
  `ArtifactToolAgent`, `TodoToolPlugin`, `VaultPathErrorCode`, `AgentIdentityLike`,
  `PathValidatorPlugin`) **zostają exportowane bez zmian** — to nie jest przycinka wszystkiego,
  tylko dokładnie tych 39 nazw, dla których census potwierdził zero konsumentów.
- **193 (poza D5, dla kontekstu):** dropdown STT w `modules/tools/SettingsContent.ts:595` żyje
  na własnej, ręcznie wpisanej liście — `STT_PLATFORMS` (martwy, `modules/multimodal/
  SttAdapter.ts`) jest poza moim zakresem plików; nietknięty.
- Bramki: `tsc --noEmit -p .` (całe repo) 0 błędów, `modules/tools/**/*.test.ts` 475/475,
  `core/security/{path_canonical,path_canonical_image,tool_axis_guard}.test.ts` 24/24 (te trzy
  pliki spoza modułu też wołały fabryki, którym zdjęto `app` — poprawione w tym samym biegu, bo
  inaczej `tsc -p .` całego repo by czerwienił), `eslint` na zmienionych plikach — exit 0.

## Fabryka wydajność W9 update (2026-09-02) — mniej I/O, te same wyniki

Naprawy z karty wydajność (baseline `fbff1d38`), zero zmian granic bezpieczeństwa
(AccessGuard/approval/sanitizePath nietknięte — tylko ILE razy, nie KTO co czyta).

- ⚠️ **AUD-wydajnosc-023 świadomie NIE naprawione.** Próba (commit `963851f4`, revert
  `3937b6dd`) cachowała treść przeczytaną w kroku 6b (podgląd diffa) w zaufanym znaczniku
  `_invocationOldContent`, żeby `WriteTool.execute` nie czytał pliku drugi raz — ODRZUCONA
  review'em (02.09): (1) przebicie granicy zaufania — znacznik był ustawiany, ale nigdy nie
  kasowany z argumentów modelu (canon w `MCPClient.ts` to „ustaw ALBO usuń", jak
  `_invocationDelegationDepth`), więc model mógł sam podać `_invocationOldContent` przy
  `mode:"append"` (6b go nie liczy) albo w `yolo`/„zawsze zezwalaj" (6b w ogóle nie biegnie) i
  `patch` policzyłby finalną treść na PODROBIONYM `old_text`, zapisując dowolną treść modelu
  jako „zatwierdzoną przez usera" edycję; (2) TOCTOU — znacznik powstaje PRZED
  `_requestDiffApproval`, które czeka na człowieka bez limitu czasu, więc nawet uczciwy cache
  mógłby się zestarzeć względem realnego stanu pliku w chwili zapisu. Zysk (jeden odczyt małej
  notatki) nie uzasadniał kosztu (eskalacja uprawnień + cicha utrata pracy usera). Cache treści
  przez granicę approvalu = zły wzorzec — jeśli ktoś wróci do tego znaleziska, rozwiązanie musi
  albo czytać RAZ tuż przed zapisem (bez cache), albo weryfikować hash/mtime pliku między 6b a
  `execute`, nie ufać samej zgodności `path`.
- ⚠️ **AUD-wydajnosc-074: `list folder:"/" recursive:true` u admina nie dobija już do
  `maxScanned` (5000) tylko po to, żeby oddać pierwsze `MAX_RESULTS` (100).** Gałąź adapterowa
  (`listViaAdapter`, dla `admin_access && folder==='/'` lub ukrytych ścieżek, plus wyjątek
  skilli) ZOSTAJE — to jedyna droga do dot-folderów, których Vault API (`getFiles()`) w ogóle
  nie widzi (`.pkm-assistant`, `.obsidian`, `.trash`); nie zastępujemy jej indeksem
  pamięciowym, bo straciłaby swój jedyny powód istnienia. Zamiast tego `listAdapterFolder`
  (`vault_adapter_io.ts`) dostała opcjonalny `maxFiles` — `walk` zatrzymuje się, jak tylko
  `files.length` go osiągnie, BEZ rekursji w kolejne podfoldery i bez kolejnych
  `adapter.list()`. `listViaAdapter` woła ją z `maxFiles: MAX_RESULTS`. Kolejność PIERWSZYCH
  N wpisów jest identyczna jak przy pełnym przebiegu (walk nie zmienia kolejności odwiedzin,
  tylko przestaje odwiedzać dalej) — cięcie wcześniej nie zmienia WYNIKU, tylko liczbę operacji
  dyskowych. Skutek uboczny: `totalCount` przy obcięciu przestaje być realną liczbą wpisów w
  drzewie (był nią wcześniej, kosztem pełnego skanu) — `truncated:true` sygnalizuje to wprost,
  tak jak przy `maxScanned`. Domyślne wywołanie `listAdapterFolder` (bez `maxFiles`,
  `Infinity`) ma zachowanie DOKŁADNIE jak przed naprawą — jedyny inny konsument (skille) nie
  jest dotknięty.
- ⚠️ **AUD-wydajnosc-098: transkrypt suba nie niesie base64 obrazu.** `generate_image` zwraca w
  sukcesie pełny base64 zapisanego obrazu (obok `path`/`note_path` — obraz JEST już w vaulcie).
  Czat go wycina przed wstawieniem do transkryptu (`chat_streaming.ts` — `delete copy.base64`);
  ścieżka SUBA (`modules/sub-agents/SubAgentRunner.ts`, `asTranscript` w `_executeTool`) tej
  normalizacji nie miała — medianowy obraz realny (~594 000 znaków base64) zjadał 99% sufitu
  `max_tool_result_length` transkryptu suba (domyślnie 15000), wypychając `format`/
  `revised_prompt`/`message` poza limit, i był budowany od nowa przy każdej kolejnej iteracji
  pętli. Naprawa żyje w `modules/sub-agents/` (osobny commit, poza tym modułem) —
  `stripImageBase64ForTranscript(toolName, result)` tnie WYŁĄCZNIE `base64` z wyniku
  `generate_image`, dokłada jednolinijkową adnotację rozmiaru (wzór `normalizeMcpResult` w
  `ExternalMcpManager.ts` — `[image ...kB]`), inne narzędzia i `generate_image` bez `base64`
  (błąd) przechodzą bez zmian. `GenerateImageTool.ts` **nietknięty** — pole `base64` w jego
  wyniku nadal istnieje, bo ścieżka czatu z modelem vision go czyta (`chat_streaming.ts:975`).
- ⚠️ **AUD-wydajnosc-024 follow-up: `search` przekazuje `scan` dalej do modelu.** `RetrievalEngine.
  runSearch` (`modules/memory/`, W3 tej samej fabryki) dokłada opcjonalne `scan:
  {candidates, scanned, truncated}` wyłącznie gdy skan keyword był obcięty sufitem 300
  kandydatów — bez przekazania dalej agent nie wiedział, że nie widział całego vaulta.
  `SearchTool.execute` dokłada `...(scan ? { scan } : {})` do wyniku, odczytany przez bezpieczny
  rzut `(r as { scan?: {...} }).scan` — jeśli `SearchOutcome` (w `modules/memory/
  RetrievalEngine.ts`) już niesie pole `scan` w typie, ten rzut staje się zwykłym odczytem i
  można go uprościć; do tego czasu jest to świadomy pomost między dwoma gałęziami tej samej
  fabryki. Brak `scan` w silniku (skan nieobcięty) → brak `scan` w wyniku narzędzia, bajtowo
  jak przed naprawą.
- Testy: `vault_adapter_io.test.ts` (NOWY, 6 testów), `ListTool.test.ts` (+2 — atrapa
  adaptera z 5000 wpisów, licznik `adapter.list()` wywołań), `SearchTool.test.ts` (+2 —
  `RetrievalEngine.prototype.runSearch` podmieniony na atrapę, bo kontrakt `scan` w tym
  worktree jeszcze nie istnieje w typie silnika). AUD-wydajnosc-023 nie ma naprawy → nie ma
  testów (`WriteTool.test.ts` i +2 w `MCPClient.test.ts` z próby 023 zniknęły z revertem
  `3937b6dd`).
