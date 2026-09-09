# modules/tools/

**MCP runtime + built-in narzędzia agenta.** Plugin uruchamia:
1. **Built-in tools** - wbudowane narzędzia agenta (read, list, write, memory_save, delegate, web_search, ...), skompilowane w bundlu.
2. **External MCP servers** - zewnętrzne serwery przez prawdziwy klient MCP (`ExternalMcpManager`, stdio/HTTP przez `@modelcontextprotocol/sdk`), konfigurowane w ustawieniach pluginu (`data.json`), NIE w vaulcie.

Built-in narzędzia żyją w **8 manifestach** (`built-in-servers/`): `core`, `vault`, `memory`, `web`, `multimodal`, `delegation`, `artifacts`, `komunikator`. Skille NIE są osobnym serwerem MCP - są przepisami czytanymi przez prymityw `read` (indeks skilli idzie w system promptcie).

---

## Co tu jest

```
modules/tools/
├── ServerManager.ts        # lifecycle built-in serwerów + ToolRegistry rejestr
├── ServerLoader.ts         # ładowanie built-in manifestów
├── ExternalMcpManager.ts   # prawdziwy klient MCP (stdio/HTTP przez SDK); external tools → source:'user' RED
├── ToolRegistry.ts         # registry + filterByAgent() + checkToolAxis() + BUILTIN_TOOL_MAP
├── MCPClient.ts            # egzekucja wywołań narzędzi: kanonizacja, bramki, approval, normalizeArgsAliases
├── SettingsContent.ts      # Web Search / Image Gen / STT / MCP Servers settings
├── SettingsSection.ts      # rejestracja sekcji Settings
├── BackstageTab.ts / ConnectorsBackstageTab.ts  # zakładka Zaplecza „Konektory" (informacyjna)
├── DelegateTool.ts         # delegacja do sub-agentów (worker generyczny / custom / explorer)
├── AgentDelegateTool.ts    # delegacja jako wiadomość do innego AGENTA (nie suba)
│
├── Prymitywy plikowe:
│   ├── ReadTool.ts, ListTool.ts                       # read/list - scope vault|memory (bramka pamięci fail-closed)
│   ├── WriteTool.ts, DeleteTool.ts, CreateFolderTool.ts  # write/delete/create_folder - vault-only
│   └── SearchTool.ts                                   # search - hybryda keyword+semantic (RRF); silnik RetrievalEngine (modules/memory)
│
├── Pamięć: MemorySaveTool.ts (create-only + ephemeral „Na teraz"), MemoryDeleteTool.ts
│   # Odczyt / streszczenia / sesje pamięci = read/list/search scope=memory (nie osobne narzędzia)
│
├── Web (2): WebSearchTool.ts, WebReadTool.ts
├── Multimodal (2): GenerateImageTool.ts, AddTextToImageTool.ts
├── Komunikacja: KomunikatorTools.ts (kom_send/kom_list/kom_read), AskUserTool.ts
│
├── built-in-servers/                   # 8 manifestów + index.ts + podfolder artifacts/
│   ├── core.manifest.ts                # ask_user - always-on, removable=false
│   ├── vault.manifest.ts               # read/list/write/delete/create_folder/search
│   ├── memory.manifest.ts              # memory_save/memory_delete - odczyt scope=memory bramkowany uprawnieniem
│   ├── web.manifest.ts                 # web_search/web_read
│   ├── multimodal.manifest.ts          # generate_image/add_text_to_image
│   ├── delegation.manifest.ts          # delegate/agent_delegate
│   ├── artifacts.manifest.ts           # artifact_create/read/update/list + todo
│   ├── komunikator.manifest.ts         # kom_send/kom_list/kom_read
│   ├── artifacts/                      # ArtifactCreate/Read/Update/ListTool.ts + TodoTool.ts + index.ts
│   └── index.ts                        # resolveBuiltinManifests({pluginVersion}) + getBuiltinManifest(name)
│
├── Helpery (bez obsidian / testowalne AVA):
│   ├── server_timeout.ts               # resolveTimeoutMs (60s default, 180s ceiling)
│   ├── text_overlay_helper.ts          # renderTextOverlay() Canvas2D
│   ├── vault_path_validator.ts         # validateVaultPath/Folder() + wyjątek allowSkillsRead
│   ├── vault_adapter_io.ts             # listAdapterFolder + isHiddenVaultPath dla dotfolderów .pkm-assistant
│   ├── vault_binary_io.ts              # createBinary/modifyBinary/readBinary (obrazy) + app-aware ensureFolder
│   ├── toolAliases.ts                  # stare nazwy → nowe prymitywy/serwer (backward-compat; remap w MCPClient)
│   ├── settingsPersist.ts              # zapis/rollback ustawień serwerów MCP + kill-switch
│   ├── mcpServerPresets.ts             # gotowe presety zewnętrznych serwerów (dane w kodzie, zero sieci)
│   ├── claudeConfigImport.ts           # parser configu Claude Desktop → nasz kształt serwera
│   └── semanticNote.ts                 # buildSemanticNote - nota degradacji L3→L2
│
└── *.test.ts (siblings)
```

---

## Public API (`index.ts`)

**30 eksportów RUNTIME, wszystkie wypisane z nazwy** - `index.ts` nie używa `export *`: gwiazdka wynosiłaby na zewnątrz wszystko dany plik eksportuje, w tym rzeczy, które nigdy nie miały być publiczne. Dopisujesz narzędzie → dopisujesz fabrykę TUTAJ; bez tego `src/main.ts` jej nie zobaczy, a build wywali się na nieistniejącym eksporcie.

**Runtime + registry:**
- `ServerManager` - runtime built-in serwerów
- `ExternalMcpManager` - klient external MCP (stdio/HTTP)
- `ToolRegistry` (+ `filterByAgent(agent)` + `getBuiltinServerForTool(name)` + `getBuiltinServerMap()`)
- `MCPClient` (+ static `MCPClient.normalizeArgsAliases(args, toolName)`)

`ServerLoader` NIE jest w barrelu - zero konsumentów poza modułem; klasa dalej żyje, `ServerManager` ją deep-importuje u siebie, testy też idą deep-importem.

**Presety + import external MCP:** `MCP_SERVER_PRESETS`, `getMcpServerPreset` - gotowe serwery zaszyte w kodzie, konsumuje `modules/shell/MCPServerEditorModal`.

**Fabryki narzędzi (21):** `createDelegateTool`, `createAgentDelegateTool`, `createReadTool`, `createListTool`, `createWriteTool`, `createDeleteTool`, `createCreateFolderTool`, `createSearchTool`, `createMemorySaveTool`, `createMemoryDeleteTool`, `createArtifactCreateTool`, `createArtifactReadTool`, `createArtifactUpdateTool`, `createArtifactListTool`, `createTodoTool`, `createWebSearchTool`, `createWebReadTool`, `createAskUserTool`, `createKomunikatorTools`, `createGenerateImageTool`, `createAddTextToImageTool`.

Realny `app` dociera do narzędzia jako 2. argument `execute(args, app, plugin)` (kontrakt w `ToolRegistry.ts`) - fabryki go nie potrzebują w sygnaturze i większość go nie bierze. Wyjątki, które realnie czytają `app` we własnej sygnaturze: `createDelegateTool`, `createCreateFolderTool`.

**Settings + Zaplecze:** `registerSettings`, `registerBackstage`.

**Cykl życia:** `stopAllDelegations(reason)` - wołane z `PluginBase.onunload` (patrz Gotchas).

### Co świadomie NIE jest w barrelu (deep-import wewnątrz modułu + w testach)

- `validateVaultPath` / `validateVaultFolder` - `vault_path_validator.ts` (tam też `invocationHasAdminAccess` + `getInvocationAgentName` - jedna kopia dla całego modułu)
- `resolveTimeoutMs` - `server_timeout.ts`
- `BUILTIN_MANIFESTS` / `resolveBuiltinManifests` / `getBuiltinManifest` - `built-in-servers/index.ts`
- `buildSemanticNote` - `semanticNote.ts`; `resolveToolAlias` / `isToolAlias` - `toolAliases.ts`; `listAdapterFolder` / `isHiddenVaultPath` / `ensureAdapterFolder` - `vault_adapter_io.ts`; I/O binarne - `vault_binary_io.ts`
- `TodoFileStore` / `TODO_FOLDER` - `built-in-servers/artifacts/index.ts` (żyją w `TodoTool.ts`, wołane u siebie + w teście)
- `renderTextOverlay` - `text_overlay_helper.ts` (używa jej `AddTextToImageTool`)

---

## External MCP - prawdziwy klient MCP

Nie ma sandboxa custom-JS - user nie ładuje `.js` z vaulta. Zewnętrzne serwery obsługuje `ExternalMcpManager`:

- **Transport:** `stdio` (lokalny proces, TYLKO desktop - gate `Platform.isMobile`) albo `http` (`StreamableHTTPClientTransport`, też mobile). SDK + `child_process` importowane leniwie.
- **Rejestracja:** narzędzia serwera wchodzą do `ToolRegistry` jako `<serverId>__<toolName>` z `source:'user'` + `serverName` → `MCPClient` liczy `isExternalTool` → `classifyToolRisk` daje **RED bezwarunkowo**.
- **Zaufanie:** RED = obowiązkowy PIERWSZY approval; modal ma „Zawsze zezwalaj (to narzędzie)" → trwała reguła `external.call::<prefixedToolName>` w `ApprovalManager`.
- **Akcja:** `external.call` w `ACTION_PERMISSIONS` (nie-vault, bez path-checków, wzór web).
- **Konfiguracja:** `settings.pkmAssistant.externalMcpServers[]` w `data.json` (komenda+env / URL+headers mogą nieść sekrety - NIE synchronizują się z vaultem). Opt-in per agent = `mcp_servers[]`.
- **Wynik → tekst:** `normalizeMcpResult` (pure, eksportowana) skleja `content[]` na czysty string; obrazek zostaje jedną adnotacją `[image image/png, ~123 kB]` zamiast base64. Adnotacje są po ANGIELSKU i świadomie bez i18n - to treść dla MODELU, nie napis w UI. Wpięta w `execute` wrappera - `callTool` nadal zwraca surowy wynik SDK.
- **Presety + import:** `mcpServerPresets.ts` (kilka gotowych serwerów, dane w kodzie, zero sieci - lista programów do uruchomienia na komputerze usera nie może przychodzić ze zdalnego źródła); `claudeConfigImport.ts` przenosi serwery z konfiguracji Claude Desktop, bez włączania autostartu i bez nadpisywania istniejącej konfiguracji usera.
- **Błąd połączenia** dostaje czytelne zdanie i18n rozpoznane po kształcie (401, `ENOENT`, `EACCES`/`EPERM`, `ECONNREFUSED`/`ENOTFOUND`/timeout); nierozpoznany kształt wraca surowym tekstem zamaskowanym przez `maskSensitiveData`. Do logu leci zawsze pełny zamaskowany tekst, do UI samo zdanie. Interaktywnego OAuth NIE MA - token wpisuje się ręcznie w Nagłówkach.
- **Podgląd przed zapisem:** `previewTools(serverConfig)` - efemeryczna próba (własny klient + transport → `connect` → `listTools` → `close`), zwraca listę narzędzi albo błąd. NICZEGO nie rejestruje w `ToolRegistry` i nie dotyka stanu połączeń - podgląd nie jest „połączeniem". Wołacz: `MCPServerEditorModal`.
- **Kill-switch per serwer:** `cfg.enabled === false` = serwer nie dostarcza narzędzi. Przełącznik w Ustawieniach → Serwery MCP zapisuje ustawienia i zamyka połączenie od razu (narzędzia znikają z rejestru), blokuje guzik „Połącz" i pokazuje stan „WYŁĄCZONY". `MCPServerEditorModal` zachowuje istniejące `enabled` przy edycji - domyślne `true` tylko dla NOWEGO serwera, żeby edycja nie odwracała po cichu wyłączenia usera.
- **Argumenty w approvalu:** `MCPClient._extractToolContext` dokłada do `approvalContext` pole `externalArgs` (kopia argumentów bez znaczników wewnętrznych), a `ApprovalModal` renderuje je jako JSON - user widzi, co dokładnie leci do cudzego serwera.
- **Filtr znaczników wewnętrznych** (`ExternalMcpManager.stripInternalArgs`) jest jedną, wspólną funkcją - używają jej i wysyłka, i podgląd w approvalu.

Bramka `.pkm-assistant/**` + No-Go + `sanitizePath` w prymitywach vaultowych działa niezależnie od tego wszystkiego.

---

## Zależności

**Importuje z:**
- `core` (AccessGuard, SensitiveDataGuard, sanitizePath, isProtectedPath, Logger, i18n)
- `modules/memory/` (memorySearchHelper potrzebuje EmbeddingHelper; RetrievalEngine)
- `modules/sub-agents/` (DelegateTool wywołuje SubAgentRunner)
- `modules/skills/` (indeks skilli w prompcie; skille czytane przez `read`)

**Importowany przez:**
- `src/main.ts` (rejestracja built-in tools)
- `SubAgentRunner` (filter tools per sub-agent)
- `ChatView` (gdy agent woła tool)
- Większość widoków (UI dostępu do tooli przez `ToolRegistry.get()`)

---

## Kluczowe decyzje

- **Built-in vs external MCP servers** - built-in kompilowane w bundlu; zewnętrzne przez `ExternalMcpManager` (prawdziwy protokół MCP, stdio/HTTP). Identyczny shape rejestracji w `ToolRegistry` (`{name, description, inputSchema, serverName, source, execute}`).
- **Zero sandboxa custom-JS.** `new Function()` + shadowed globals jako granica bezpieczeństwa nigdy nie był szczelny (prototype-chain escape) - zastąpiony prawdziwym klientem MCP + kontraktem `source:'user'` → RED.
- **`sanitizePath` w każdym prymitywie vaultowym**, który dotyka path - blokuje `../`, URL-decoded traversal, null bytes, zero-width unicode.
- **`SensitiveDataGuard`** - maskuje API keys w logach + w wynikach (gdyby narzędzie zwróciło je przez błąd).
- **Jedno narzędzie `search`** zastępuje osobne narzędzia retrieval per typ zapytania (keyword/semantic/filter/links/glob) - kontrakt `{query?, scope?('vault'|'memory'), where?{folder,glob,yaml,links_to,links_from}, mode?('auto'|'keyword'|'semantic'), limit?}`, silnik `RetrievalEngine.runSearch()` (modules/memory), hybryda keyword+semantic przez RRF.
- **Prymitywy plikowe bez prefiksów, ze scope w parametrze** (wzór `search`): `read`/`list` mają `scope: 'vault'|'memory'`; `write`/`delete`/`create_folder` są vault-only. API-first: `read` → `getAbstractFileByPath`+`cachedRead`, `list` → `TFolder.children`/`getFiles`, `write` → `vault.process`/`vault.create` (fallback `modify` dla hostów bez `Vault.process`), `delete` → `vault.trash`/`vault.delete`. `.pkm-assistant/` (pamięć, dotfoldery) zostaje na adapterze - Vault API tego nie widzi.
- **Skille bez własnych narzędzi.** Odkrywalność = indeks w system promptcie (nazwa + opis + ścieżka), pełny przepis SKILL.md czytany przez `read` (wyjątek izolacji `allowSkillsRead` w `vault_path_validator`, TYLKO odczyt - zapis/kasowanie/create_folder dalej blokowane).
- **Model kontroli = autonomia, nie tryby pracy.** `MCPClient.executeToolCall` przyjmuje `opts.autonomy` (`yolo`/`edge`/`all`), który decyduje TYLKO o pytaniach (approval modal, diff). `yolo` = zero pytań, ale **NIE omija** No-Go / protected paths / whitelisty / uprawnień agenta - te są sprawdzane wcześniej, w `checkPermission`, przed bramką approvalu.

---

## Gotchas

### Cykl życia i przerwanie

- ⚠️ **Bieg delegacji ma DWÓCH właścicieli - rejestr i moduł.** Uchwyt biegu trafia do `SubTaskRegistry` dopiero PO rozwiązaniu configu, budowie modelu i promptu (czyli po odczytach z dysku) - więc `DelegateTool` trzyma WŁASNY zbiór żywych kontrolek abortu i wystawia `stopAllDelegations(reason)`. `onunload` woła najpierw `subTaskRegistry.stopAll()`, potem to - inaczej bieg złapany w tym oknie startowałby pętlę już po wyładowaniu pluginu. Każda ścieżka delegacji musi zdjąć swoją kontrolkę w `finally`.
- ⚠️ **`stopAllDelegations` ma DRUGĄ, wcześniejszą bramkę dla zadań jeszcze w kolejce.** Zadanie stojące w kolejce bramki (jeszcze nie wystartowane) jest niewidzialne dla zbioru żywych kontrolek. Dlatego moduł trzyma osobną flagę „wyładowany", podnoszoną PRZED pętlą po kontrolkach; pula wykonawcza sprawdza tę flagę przed startem KAŻDEGO kolejnego zadania i odmawia bez budowy modelu i bez odczytu promptu z dysku. Flaga raz podniesiona zostaje do końca życia pluginu.
- ⚠️ **Budzik `ask_user` ma DWÓCH właścicieli - `finally` i cykl życia pluginu.** `clearTimeout` w `finally` zdejmuje go po rozstrzygnięciu wyścigu, ale w oknie oczekiwania (user jeszcze nie odpowiedział) obietnica nigdy się nie rozstrzyga - przy wyładowaniu budzik tykałby dalej na martwym pluginie. Uchwyt idzie więc dodatkowo przez rejestrację interwału pluginu (opcjonalna - host bez tej metody, np. testy, działa jak dotąd).

### Widoczność i egzekucja narzędzi

- ⚠️ **`ToolRegistry.filterByAgent(agent)` to JEDNA oś: wszystkie built-in ON minus `agent.disabled_tools[]`** (negatywna lista). Narzędzia zewnętrznych serwerów MCP dodatkowo bramkowane pozytywną listą `mcp_servers`. Sub-agent = przecięcie z narzędziami rodzica.
- ⚠️ **WIDOCZNOŚĆ i EGZEKUCJA to JEDNA funkcja - `ToolRegistry.checkToolAxis(agent, toolName)`.** `filterByAgent` to jej przelot po rejestrze (co model dostaje w definicjach narzędzi), a `MCPClient.executeToolCall` woła ją jako BRAMKĘ, zanim pobierze narzędzie z rejestru i zanim ruszy `checkPermission` - bez tego model, który zna nazwę wyłączonego narzędzia (stara sesja, cudzy transkrypt), mógłby je wywołać bez oporu. **Nie dokładaj drugiego miejsca liczenia tej reguły** - dwie kopie rozjadą się przy pierwszej zmianie. Trzy konsekwencje: (1) sprawdzenie idzie na nazwie KANONICZNEJ, czyli po `resolveToolAlias` - stara nazwa nie może być obejściem wyłączenia; (2) odmowa jest fail-closed i **nie pyta usera** - to nie ryzyko do zaakceptowania, tylko narzędzie, którego user agentowi nie dał; (3) dla serwerów zewnętrznych brak listy `mcp_servers` = brak opt-inu = odmowa. Sub-agenci chodzą pod tożsamością rodzica, więc dostają tę bramkę za darmo; ich własna whitelista (przecięcie rodzic∩sub) odbija wywołanie jeszcze wcześniej.
- ⚠️ **Zewnętrzne serwery MCP = kod, który uruchamiasz u siebie.** stdio spawnuje proces z Twoimi prawami, http wysyła dane rozmów do zdalnej usługi. Żaden sandbox ich nie ogranicza. Instaluj tylko z zaufanych źródeł; `source:'user'` → RED wymusza pierwszy approval.
- ⚠️ **Oś narzędziowa mierzy nazwę WYWOŁANEGO narzędzia, więc skutek trzeba bramkować tam, gdzie się dzieje.** `agent_delegate` (grupa `delegation`) i `kom_send` (grupa `komunikator`) robią to samo - zostawiają tekst modelu w cudzej skrzynce - więc agent z włączoną delegacją i wyłączoną pocztą mógł by inaczej ominąć wyłączenie. Bramka poczty jest w chokepoincie: `sendAgentMail` jako pierwszy warunek pyta `checkToolAxis(agent, 'kom_send')`, niezależnie skąd przyszło wywołanie. Druga połowa: akcja `agent_delegate` mapuje się na `agent.message`, nie na `delegate` - przełącznik zgody ma odpowiadać SKUTKOWI, nie nazwie narzędzia.

### Ścieżki plików i cele operacji

- ⚠️ **Bramka i zlew oglądają JEDEN ciąg.** `MCPClient._extractToolContext` kanonizuje ścieżkę vaultową i **podmienia ją w argumentach**, zanim `checkPermission` cokolwiek oceni. Ścieżka nie do uratowania = odmowa bez pytania usera i bez `execute`. **Nie dokładaj własnej normalizacji ścieżek w narzędziach** - `validateVaultPath` w `execute` ma być idempotentnym powtórzeniem, nie drugą, inną interpretacją.
- ⚠️ **Narzędzie dotykające pliku MUSI podać bramce cel.** `PermissionSystem` odmawia fail-closed, gdy akcja wymagająca celu (write/create/create_folder/delete, artifact create/update/read, image generate) przyjdzie z pustym `targetPath` - pusty cel przeskakiwałby No-Go, pliki chronione, whitelistę i zakres suba. Narzędzie bez wprost podanego pola `path` liczy cel w `contextExtractor` (wzór: `artifact_*` → ścieżka instancji; `generate_image` → folder zapisu z ustawień; `add_text_to_image` → `output_path`). **Prompt/zapytanie NIE jest celem** - takie rzeczy jadą do `approvalContext`, inaczej strażnik ocenia tekst pisany przez model.
- ⚠️ **`add_text_to_image` dotyka DWÓCH ścieżek - obie muszą być fail-closed.** CEL ZAPISU idzie przez bramkę `MCPClienta` (`output_path`), a OBRAZ ŹRÓDŁOWY przez pełny `PermissionSystem.checkPermission(agent, 'vault.read', ...)` WEWNĄTRZ narzędzia, przed odczytem. Sama walidacja składni ścieżki nie wystarcza - nie zna No-Go, whitelisty ani zakresu suba. **Narzędzie, które CZYTA jeden plik i PISZE drugi, musi oddać bramce oba** - inaczej `{path:'Prywatne/skan.png', output_path:'Publiczne/kopia.png'}` przepisuje cudzy plik tam, gdzie agent sięga. Tożsamość i zakres brane są z ZAUFANYCH znaczników wstrzykiwanych przez `MCPClient`, tą samą drogą co gdzie indziej - dwie bramki muszą oceniać tę samą tożsamość. Brak agenta albo brak systemu uprawnień = odmowa, nigdy cichy odczyt. Okno zgody pokazuje też ŹRÓDŁO, nie tylko cel.
- ⚠️ **Adresat poczty ma JEDEN kanon, liczony przed bramką.** `kom_send` toleruje kilka nazw tego samego pola (`to`/`to_agent`/`agent`/`target`) - jeśli klient je interpretuje osobno od narzędzia, dwie strony mogą się rozjechać (np. modal pokazuje literał pola zamiast realnego adresata, a reguła „Zawsze zezwalaj" zapisuje się pod złym kluczem - auto-zgoda na dowolnego adresata). Kanon liczy jedna funkcja w `KomunikatorTools.ts` i wołają ją OBIE strony: kontekst bramki (cel, opis w modalu, klucz reguły zgody) oraz `execute` (to, co realnie leci do skrzynki). Kanonem jest nazwa z rejestru agentów; nierozpoznany adresat zostaje dosłowny - cel od wołacza nigdy nie ma prawa zamienić się w wieloznacznik.

### Dziedziczenie kontekstu przy delegacji

- ⚠️ **Dziecko delegacji dostaje PRZECIĘCIE, nie własny config.** `MCPClient` wstrzykuje do argumentów zaufane znaczniki: zakres folderów wołającego, jego whitelistę narzędzi, głębokość delegacji, tryb autonomii - podawane przez runtime, a POZA delegacją usuwane. `delegate` liczy z nich przecięcie z configiem odpalanego suba: zakres jako część wspólna (rozłączne = odmowa), narzędzia jako iloczyn whitelisty rodzica i suba. Bez tego wnuk delegacji startowałby z zakresem policzonym wyłącznie z własnego (pustego) configu, czyli z pełnym zasięgiem agenta głównego. **Dokładasz cokolwiek, co dziecko dziedziczy - przekaż to znacznikiem, nie odczytem globalnego stanu pluginu.**
- ⚠️ **`_invocationAutonomy` to zamrożony tryb pytań TURY.** `MCPClient` wstrzykuje do args znormalizowaną autonomię przy każdym wywołaniu; `delegate` ją czyta i zamraża w biegu suba, bo bieg z czatu leci w tle i przeżywa przełączenie zakładki. Nie czytaj globalnego stanu autonomii pluginu w kodzie, który wykonuje się po zakończeniu tury - może już mówić o innej turze.
- ⚠️ **Zaufane znaczniki `_invocation*` - bramka ogląda worek PO nadpisaniu, execute PRZED.** `contextExtractor` bierze tożsamość z kontekstu runtime'u, NIGDY z worka argumentów - worek może co najwyżej nieść tę samą wartość, więc nie ma czego z niego brać (inaczej model mógłby sam podać cudzą tożsamość i bramka policzyłaby cel dla jednej ścieżki, a zapis poszedłby pod drugą). `execute` MOŻE czytać `_invocation*` z argumentów, bo tam worek jest już nadpisany przez runtime. Cel policzony przez bramkę i ścieżka zapisu mają być tym samym ciągiem.

### Pamięć i skrzynka pocztowa

- ⚠️ **Rozwiązywanie pamięci jest FAIL-CLOSED.** `memory_save`, `memory_delete` oraz `read`/`list`/`search` ze `scope: memory` biorą pamięć TOŻSAMOŚCI Z RUNTIME'U i nie mają zjazdu na „aktywnego agenta", gdy tożsamość jest znana - nietrafiona nazwa kończy się błędem `no_agent`, nie cudzym katalogiem pamięci. Fallback na aktywnego agenta zostaje TYLKO gdy żadnej tożsamości nie da się ustalić.
- ⚠️ **„Zmiana zatwierdzona" ≠ „indeks pamięci odświeżony".** Przebudowa indeksu pamięci po zapisie/kasacji notatki siedzi w WŁASNYM bloku obsługi błędów, osobno od samego zapisu (który jest już nieodwracalny). Jej pad NIE zamienia udanej operacji w porażkę - zwrotka zostaje sukcesem i dostaje dodatkowe pole `index_stale` + ostrzeżenie, plus wpis do logu. Powód: przebudowa indeksu jest fail-closed i RZUCA przy niepewnym odczycie, a gdyby siedziała w tym samym bloku co zapis, jej wyjątek zamieniałby udaną zmianę w zgłoszoną porażkę - model próbowałby ponowić operację i odbijał się o „już istnieje"/„nie znaleziono".
- ⚠️ **`TodoFileStore` pisze przez KOLEJKĘ per ścieżka.** Pętla agenta puszcza wywołania narzędzi jednej tury równolegle, więc dwa `todo` w tej samej turze bez kolejki kasowałyby sobie nawzajem zmiany. Klucz kolejki to dokładnie ten string ścieżki, który leci do adaptera. Nie wołaj operacji zapisu z wnętrza już zakolejkowanej operacji (zakleszczenie); odczyt jest świadomie POZA kolejką.
- ⚠️ **`TodoFileStore.patch` czyta przez bezpieczny „odczytaj jeśli istnieje", nie przez osobne `exists()+read()`.** Na niektórych backendach synchronizacji `exists()` potrafi zwrócić fałsz dla pliku, który realnie istnieje - dwuetapowe sprawdzenie traktowałoby wtedy istniejącą listę zadań jako świeżą i nadpisywałoby ją pustym szkieletem, kasując resztę zadań agenta. Bezpieczny odczyt czyta NAJPIERW, więc `exists()` nie ma szans skłamać; stan sprzeczny jest fail-closed (plik nie jest dotykany, narzędzie zwraca błąd modelowi).
- ⚠️ **`kom_send` ma dwa niezależne sufity: PARA nadawca-adresat i sam NADAWCA.** Wyczerpanie limitu pary daje inny komunikat niż wyczerpanie całej puli nadawcy (druga wersja świadomie bez rady „napisz do kogoś innego" - user i tak nie ma dokąd pisać więcej). Produkcyjna droga rezerwuje i zwalnia limit atomowo, żeby równoległe wywołania z jednej tury nie ominęły bramki.
- ⚠️ **`ExternalMcpManager` nasłuchuje śmierci serwera** (zamknięcie/błąd transportu), a nie tylko własnych akcji `close()`. Bez tego po padzie procesu stdio status dalej pokazywałby „połączony", a martwe narzędzia szłyby modelowi w definicjach. Zamknięcie ZAMIERZONE (`close(id)`) zdejmuje wpis z rejestru POŁĄCZEŃ jako pierwsze, więc nasłuch, który zaraz i tak dostanie sygnał zamknięcia, nie przemalowuje stanu z powrotem na błąd.
- ⚠️ **Zamykanie wszystkich zewnętrznych serwerów przy wyładowaniu pluginu nie czeka sekwencyjnie na każdy z osobna** - równoległe zamykanie z sufitem czasu per serwer, bo Obsidian nie czeka na `onunload`. Po przekroczeniu sufitu porzucamy obietnicę zamknięcia z logiem zamiast wisieć. Flaga „wyładowany" bramkuje też autostart i nowe połączenia w tym oknie.

### Wynik narzędzia i błędy

- ⚠️ **Porażka narzędzia ma JEDEN kształt, ustawiany w JEDNYM miejscu.** Na wyjściu egzekucji narzędzia dopisywana jest flaga błędu każdemu wynikowi, który reguła klasyfikacji uzna za porażkę - bez kasowania pozostałych pól wyniku. Regułę „co jest porażką" czyta czat (status chipa, link do zapisanego pliku, odtwarzanie historii) i runner subów. **Nie licz statusu drugi raz po swojemu w narzędziu.** W narzędziach dalej wolno zwracać jawny obiekt błędu; PUSTY wynik to sukces z pustymi danymi, NIGDY porażka.
- ⚠️ **`ask_user` bez interfejsu w danej zakładce ODMAWIA, nigdy nie zmyśla odpowiedzi.** Gdy tura leci w zakładce w tle (bez aktywnego UI pytania), narzędzie zwraca błąd z instrukcją „nie zgaduj" zamiast fabrykować zgodę użytkownika z pierwszej opcji. To samo dotyczy timeoutu oczekiwania (kilka minut bez odpowiedzi usera) - timeout też zwraca błąd, nie sfabrykowaną odpowiedź. **Nie przywracaj auto-odpowiedzi w żadnej z tych gałęzi** - nic w UI nie odróżnia sfabrykowanej zgody od prawdziwej odpowiedzi człowieka.
- ⚠️ **`delegate` w trybie wielozadaniowym w tle rozróżnia zadania przyjęte, zakolejkowane i odrzucone.** Zadania odbite od razu (pusty task, nietrafiony aspekt) nie wchodzą do rejestru biegów, więc powiadomienie o nich nigdy nie przyjdzie - liczone są osobno, PRZED pulą wykonawczą, i oddawane modelowi w osobnym polu wyniku. Sama paczka samych odrzuceń to porażka całego wywołania.
- ⚠️ **Zapis ustawień serwerów MCP ma własny meldunek, a kill-switch nie czeka na zapis.** Kolejność: zmiana w pamięci → zamknięcie połączenia (przy wyłączaniu, NIEZALEŻNIE od wyniku zapisu) → zapis na dysk; pad zapisu cofa zmianę w pamięci, pokazuje komunikat i przerysowuje UI ze stanu faktycznego. Bez tego nieudany zapis mógłby zostawić UI pokazujące „wyłączony" nad serwerem, który dalej dostarcza narzędzia.
- ⚠️ **Pamięć odmów approvalu w kliencie WYGASA.** Odmowa całego narzędzia (bez konkretnej ścieżki - np. external MCP, `delegate`) jest zapamiętywana, żeby nie pytać drugi raz od razu, ale wpis ma czas życia - klient żyje przez cały cykl pluginu, więc bez wygasania jedno kliknięcie „Odmów" odbijałoby każde następne wywołanie bez modala, w każdej zakładce, aż do restartu. Model dostaje przy odmowie instrukcję „nie ponawiaj", więc bez wygasania temat umierałby na stałe.
- ⚠️ **Błąd wyjątku, który wraca do modelu, zawsze idzie przez tę samą maskę sekretów** (`maskSensitiveData`) - niezamaskowany komunikat streamu potrafi nieść całe surowe zdarzenie razem z nagłówkiem autoryzacji, a błąd I/O adaptera pełną ścieżkę systemową. **Każdy nowy `catch`, którego treść wraca do modelu, ma iść tą samą maską - nie pisz drugiej.**
- ⚠️ **Import serwerów z Claude Desktop ma TĘ SAMĄ walidację id co ręczne dodawanie serwera** - kolizję z nazwą wbudowaną i duplikat WEWNĄTRZ importowanej paczki (dwie różne nazwy, które po slugifikacji dają to samo id), nie tylko kolizję z istniejącymi ustawieniami. Druga warstwa kontroli siedzi też w miejscu zapisu do ustawień, więc nawet gdyby UI kiedyś przestał czytać poprawnie flagę kolizji, zapis i tak zostaje czysty.
- ⚠️ **Równoczesne łączenie z TYM SAMYM zewnętrznym serwerem jest serializowane.** Bez blokady per-serwer dwa równoczesne żądania połączenia (np. autostart plus klik „Połącz" w oknie wolnego handshake'u) mogłyby oba przejść test pustego stanu i wystawić dwa osobne procesy/klienty, z których jeden nigdy nie dostałby zamknięcia (proces-zombie do końca sesji). Drugie i kolejne żądanie w oknie trwającego łączenia dostaje TĘ SAMĄ obietnicę zamiast startować własną.

### Bezpieczne skróty, których świadomie NIE zrobiliśmy

- ⚠️ **Nie cache'uj treści pliku przez granicę approvalu.** Próba cache'owania odczytanej treści (żeby narzędzie zapisu nie czytało pliku drugi raz po podglądzie diffa) została odrzucona: znacznik z cache'owaną treścią byłby ustawiany, ale nie zawsze kasowany, więc model mógłby sam podać podrobioną „starą treść" w trybach, które pomijają podgląd diffa (np. append, albo autonomia bez pytań) - narzędzie policzyłoby wtedy finalną treść na sfałszowanym punkcie odniesienia, zapisując dowolną treść modelu jako „zatwierdzoną przez usera" edycję. Do tego dochodzi wyścig: podgląd czeka na człowieka bez limitu czasu, więc nawet uczciwy cache mógłby się zestarzeć względem realnego stanu pliku. Jeśli temat wróci, rozwiązanie musi albo czytać RAZ tuż przed zapisem bez cache, albo weryfikować hash/mtime między podglądem a zapisem - nie ufać samej zgodności ścieżki.

### Wydajność (bez zmiany granic bezpieczeństwa)

- ⚠️ **Listing dotfolderów przez adapter ma sufit liczby plików, nie tylko sufit wyniku.** Gałąź adapterowa (jedyna droga do dot-folderów, których Vault API w ogóle nie widzi - `.pkm-assistant`, `.obsidian`, `.trash`) potrafiła przejść cały drzewostan tylko po to, żeby oddać pierwsze kilkadziesiąt wyników. Walker dziś zatrzymuje się, jak tylko zbierze potrzebną liczbę plików, bez rekursji w kolejne podfoldery. Kolejność pierwszych wyników jest identyczna jak przy pełnym przebiegu - cięcie wcześniej nie zmienia WYNIKU, tylko liczbę operacji dyskowych.
- ⚠️ **`web_read` kanonizuje adres RAZ** (na wejściu) - provenance, filtr domen, klucz cache i reader dostają ten sam ciąg. Dodatkowy strażnik pilnuje, żeby sklejka adresu z URL-em readera nie pozwoliła segmentom `..` zwinąć się PO sklejce i wysłać żądanie na inną domenę niż ta, którą sprawdził filtr.

---

## Powiązane

- `modules/sub-agents/CLAUDE.md` - `DelegateTool` używa `SubAgentRunner`
- `modules/memory/CLAUDE.md` - `RetrievalEngine` (silnik `search`), pamięć agentów
- `modules/komunikator/CLAUDE.md` - mechanika skrzynki, którą woła `KomunikatorTools`
- `modules/web/CLAUDE.md` - silnik wyszukiwania/czytania stron pod `web_search`/`web_read`
- `modules/multimodal/CLAUDE.md` - adaptery generowania obrazu/STT pod narzędziami multimodalnymi
