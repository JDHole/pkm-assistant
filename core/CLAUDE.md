# core/

> ## ✅ clean-room — podłoga runtime'u przepisana od zera (scalone 2026-09-06)
>
> Ten dokument opisuje stan PO wywałce. Tabela niżej zostaje jako krótka notatka
> historyczna — mapa starych nazw na nowe, przydatna, gdy trafisz na wzmiankę o `PKMEnv`
> albo `PKMPlugin` w starszej dokumentacji czy w historii gita:
>
> | Było | Jest | Uwaga |
> |---|---|---|
> | `core/PKMEnv.ts` | `core/runtime/PluginRuntime.ts` (+ `SettingsStore`, `settingsArmor`, `NoticeCenter`, `StatusBar`, `configMerge`) | kontrakt: `core/runtime/contracts.ts` |
> | `core/PKMPlugin.ts` | `core/PluginBase.ts` | wszystkie metody i pola w `camelCase` |
> | `core/utils/SettingsManager.ts` | `core/runtime/SettingsStore.ts` | `settings` (proxy, planuje zapis) vs `raw` (surowy worek, nie planuje) |
> | `core/utils/EventBus.ts` | `core/utils/EventEmitter.ts` | jedna szyna, dwa klucze: `loaded` i `unloading` |
> | `core/utils/env_utils.ts` | `core/runtime/configMerge.ts` | `compare_versions` zginęło razem z plikiem |
> | `core/utils/http_request.ts` | `core/http/**` | nowy podklaster transportu (klienci + transport strumienia + parsery ramek) |
> | `core/utils/obsidian_helpers.ts` | `core/utils/obsidianNav.ts` | `openNote` / `openSource` |
> | `core/PluginView.ts`, `core/utils/envStartWait.ts` | — | kasacja (zero konsumentów / okno startu nie istnieje) |
> | `settings.smart_*` | `settings.pkmAssistant.{chat,embedding,notices}` | mapa migracji: `core/runtime/legacySettingsMigration.ts` (KWARANTANNA — jedyne miejsce ze starymi nazwami kluczy) |
>
> **Stan (scalone 2026-09-06):** `core/runtime/**`, `core/http/**`, `core/ui/**` i
> `core/PluginBase.ts` mają REALNE implementacje — zero `not implemented` w źródłach, testy
> tych podklastrów są zielone. `core/layoutReady.ts` jest wpięty i żywy (`PluginRuntime.boot()`
> go woła). `core/ui/safeHtml.ts`, `core/waitForLoaded.ts` i `core/utils/httpLogSummary.ts` są
> RÓWNIEŻ zaimplementowane i przetestowane, ale nadal POZA GRAFEM importów z `src/main.ts` —
> nic ich dziś nie woła w produkcji (lista w `core/dead_code_zasieg.test.ts`); to świadomy,
> udokumentowany stan „czeka na wpięcie", nie stub. Klaster `modules/models/` (w tym
> wszystkich dziewięciu dostawców, `ollama`/`open_router`/`xai` włącznie) jest też w pełni
> zaimplementowany — szczegóły w `modules/models/CLAUDE.md`. `npm run typecheck` jest zielony.
>
> **F7 (harness, 2026-09-06):** `config/runtimeConfig.ts` i `config/defaultSettings.ts` mają
> realne ciała — bez nich plugin nie wstawał w ogóle (`buildRuntimeConfig` rzucał w KONSTRUKTORZE
> pluginu). Fabryczne ustawienia prowizjonują WYŁĄCZNIE kontenery `pkmAssistant.chat`
> i `pkmAssistant.embedding` (spec §4), więc klucze w rodzaju `defaultAutonomy` NIE mają już
> fabrycznej wartości w worku — czytelnicy spadają na własne defaulty (`DEFAULT_AUTONOMY`).
> Rejestr embeddingu (`EmbeddingRegistry`) wstawia do slotu runtime'u composition root
> w `src/main.ts`, zaraz po `new PluginRuntime(...)`, a przed `boot()`.
>
> Sekcje niżej opisują stan PO clean-room i są aktualne; gdziekolwiek natrafisz w nich (albo
> gdzie indziej w repo) na wzmiankę o `PKMEnv`, `PKMPlugin`, `SettingsManager`, `EventBus`,
> `env_utils` czy `http_request` — to **zapis historyczny** (projekt nie fałszuje historii),
> czytaj go przez tabelę wyżej.


**Fundament pluginu.** Wszystko co KAŻDY moduł potrzebuje żeby w ogóle wystartować: klasa pluginu, środowisko, tryby pracy, security, i18n, utilities.

Jak moduł = pojedyncza funkcjonalność (memory, chat, mcp…), to `core/` jest podłogą na której te moduły stoją. Nie ma tu żadnej "feature" — sama infrastruktura.

**Sprint Refaktoru — który mnie dotyka:**
- [Sprint 01 Quick Wins + Security](../Refaktor/Sprinty/SPRINT_01_Quick_Wins_Security.md) — security-critical fixy używają `core/security/sanitizePath`
- [Sprint 04 MCP_PORZADEK_v1](../Refaktor/Sprinty/SPRINT_04_MCP_Porzadek_v1.md) — Z11 nowe testy ServerExecutor/Manager/Registry (15+ unit testów)
- [Sprint 10 Settings v2 + Backstage v2](../Refaktor/Sprinty/SPRINT_10_Settings_v2_Backstage_v2.md) DONE (2026-05-02 hotfix) — `core/SettingsContent.js` renderuje No-Go, Zaawansowane, Klucze API i Informacje; `SettingsSection.js` rejestruje sekcje core.
- [Sprint 13b Polish + Decyzje](../Refaktor/Sprinty/SPRINT_13b_Polish_Decyzje.md) — core polish/docs po audycie S13a.
- [Sprint 13a Security + Architecture](../Refaktor/Sprinty/SPRINT_13a_Security_Architecture.md) - `core/SECURITY.md` STRIDE threat model + nowe testy, `SecretsStorage`, persistent approval rules, PermissionSystem fail-closed i Logger masking.

---

## Threat model

Pełny opis jest w [`core/SECURITY.md`](SECURITY.md). Skrót dla agenta:

- **Spoofing:** agent/tool nie może udawać innego kontekstu uprawnień; publiczne wejścia przechodzą przez jawny mapping akcji.
- **Tampering:** vault path idzie przez `sanitizePath`, `isProtectedPath`, `AccessGuard` i approval flow zanim dotknie pliku.
- **Repudiation:** `ApprovalManager` zapisuje decyzje i always-approved rules, żeby user widział co jest zapamiętane.
- **Information disclosure:** `SensitiveDataGuard`, `SecretsStorage` i `Logger` maskują albo chowają API keys.
- **Denial of service / Elevation of privilege:** MCP ma timeouts, unknown actions fail-closed, a tryb autonomii `yolo` znosi tylko pytania — nie omija No-Go, protected paths, whitelisty ani uprawnień agenta.

---

## Kryterium wstępu (ADR 003)

Do `core/` trafia TYLKO plik który spełnia **wszystkie 3 warunki**:

1. **Używany przez ≥3 moduły** (1-2 → idzie do modułu który go najbardziej używa)
2. **Nie jest samodzielną funkcjonalnością** (to infrastruktura, nie feature)
3. **Zmienia się rzadko** (zmiana `core/` dotyka wszystkich modułów = self-enforcing brake na pokusę ciągłego dolewania)

Jak coś nie spełnia — idzie do odpowiedniego `modules/<nazwa>/`.

---

## Publiczne API — `core/index.js`

Poza `core/` wolno importować TYLKO z `core/index.js` (zasada jedynych drzwi, tak jak dla każdego modułu). Bebechy `core/utils/…` / `core/security/…` — prywatne. **Od S31 (2026-07-30) pilnuje tego ESLint** (`no-restricted-imports` na `modules/**`, `src/**`, `config/**`, `utils/**`), nie sama konwencja.

### Barrel jest NODE-SAFE (kontrakt S31)

`core/index.js` musi wstawać w Node bez Obsidiana. Od TS-1 (2026-07-30) cały `core/` jest w TypeScripcie (pliki `.ts`, specifiery importów zostają `.js` — kontrakt kampanii TS), więc dawny jednolinijkowiec z gołym `node --input-type=module` JUŻ NIE DZIAŁA: goły Node strippuje typy, ale nie podmienia `.js`→`.ts` w specifierach. Sprawdzianem node-safe jest `npm test` (AVA biegnie przez tsx, bez mocka `obsidian`) albo ręcznie:

```bash
node --import=tsx --input-type=module -e "await import('./core/index.js').then(()=>console.log('OK'))"
```

Powód: AVA nie ma mocka `obsidian` (`"ava".require: []`), a testuje pliki produkcyjne, które importują ten barrel. Wciągnięcie `obsidian` do barrela wywala pół zestawu testów. **Dlatego cztery obsidianowe pliki core NIE są eksportowane z barrela** — `PluginBase.js`, `runtime/PluginRuntime.js`, `utils/obsidianNav.js`, `security/MasterPasswordModal.js`. Deep-importuje je wyłącznie `src/main.js` jako **composition root** (ma na to per-file wyjątek w `eslint.config.js`). Konsekwencja: `SettingsContent.js` ładuje `MasterPasswordModal` leniwie (`await import(...)` w handlerze), bo wisi na barrelu przez `registerSettings`.

**Oficjalne wyjątki deep-importu (globalne narzędzia, wolno wszędzie):** `core/i18n/index.js` (~140 importów) i `core/utils/Logger.js` (~88). Wyłącznie te dwa — S31 przepiął resztę (~55 linii w 41 plikach) na barrel.

**Eksportowane:**

**Entry point:** ⛔ `PluginBase`, `runtime/PluginRuntime` — **NIE przez barrel** (obsidian), tylko deep z `src/main.js`

**Autonomia (E2.3 D21 / F12):** `AUTONOMY_MODES`, `DEFAULT_AUTONOMY`, `normalizeAutonomy`, `classifyToolRisk` (z `security/autonomy.js`). Autonomia = własność CZATU (czy PYTAĆ), niezależna od uprawnień (co WOLNO). Tryby pracy Gadaj/Rób (`WorkMode.js`) usunięte w E2.3 — narzędzia = uprawnienia agenta, nie tryb. ⚠️ AUD-dead-code-116/177 (2026-09-02): `isEdgePermissionType`, `TOOL_RISK_LEVELS`, `PERMISSION_TYPES`, `ACTION_PERMISSIONS`, `maskKey`, `containsSensitiveData`, `escapeUntrusted`, `VAULT_CONTENT_TAG` zdjęte z barrela (zero konsumentów poza `core/` — same implementacje ZOSTAJĄ, żywe przez deep-import wewnątrz `core/`, np. `maskKey` w `core/SettingsContent.ts`).

**Security:**
- `AccessGuard` — sanityzacja ścieżek, No-Go zones, focusFolders, whitelist
- `PermissionSystem`, `APPROVAL_DEFAULTS`
- `ApprovalManager` — modal do zatwierdzania akcji, "always approve" rules
- `SecretsStorage` (S13a) — sejf na klucze API
- `sanitizePath`, `isProtectedPath`, `VAULT_GITIGNORE_ENTRIES`
- `maskSensitiveData`, `warnIfSensitive`
- `expandFocusEntries` (S31 — grupy folderów vaulta; konsument: `modules/prompts/PromptBuilder.js`)
- `globPatternToRegex` (AUD-code-review-033) — konwersja glob→regex; jedyny żywy wołacz `AccessGuard` (dawniej dzielona też z `VaultZones`, src/ — podsystem wycięty 2026-09-03, AUD-dead-code-031/115/172/216)
- `fenceUntrusted` (K9) — JEDNO ogrodzenie niezaufanej treści w system prompcie dla wszystkich kanałów
- `HUMAN_MESSAGE_META`, `MACHINE_MESSAGE_META`, `machineMeta`, `resolveMessageOrigin`, `isHumanMessage` (K7, `security/messageOrigin.js`) — proweniencja wiadomości czatu

**i18n:** `t`, `setLocale`, `getLocale`, `getDateLocale`

**Utils:**
- `log` — centralny logger (debug/info/warn/error/tool/model/timing)
- `resolveWorkPrompt`, `WORK_PROMPT_KEYS` (E2.8 B3) — resolver promptów roboczych agent>global>factory (pure, node-safe). Dawny „node-owe konsumenty deep-importują ten plik" — NIEAKTUALNE od S31: barrel jest node-safe, wszyscy idą przez `core/index.js`.
- `normalizeError` (S30 Z3; rename w clean-room/F2) — normalizacja błędów API modeli do `{message, code, details, http_status}`. Pure, zero importów; 5 adapterów w `modules/models/` bierze go z barrela. ⚠️ NIE mieszać z celowo odrębną wersją w `modules/embedding/embed_adapter_base.js`.
- `toolResultStatus`, `shouldLinkWrittenFile` (AUD-bledy-027/058/025/013) — JEDNA reguła „co jest porażką narzędzia", czytana przez tools, chat i sub-agents
- `ensureAdapterFolder` (S30 Z3) — adapterowy `mkdir -p` po segmentach ścieżki. Pure, duck-typuje adapter `{exists, mkdir}` (brak metod = no-op). Wariant **app-aware** (Vault API dla zwykłych ścieżek, adapter dla dot-folderów) zostaje osobno w `modules/tools/vault_binary_io.js`.
- `probeFile` (K4, AUD-bledy-061) — „czy plik jest?" w trzech stanach (`'exists'|'missing'|'unknown'`), bo `exists()` kłamie na dyskach sieciowych (gotcha 6b niżej)
- `readIfExists` (K4 self-append) — odczyt-najpierw WŁASNEGO pliku przed dopisaniem nowego wpisu; siostrzana wada `probeFile`
- `migrateOldPluginFolder` (S35 „Wielki Rename") — migrator plikowy, czysty/node-safe. ⚠️ AUD-dead-code-116/177 (2026-09-02): `migrateObsekNamespace` (migrator namespace'u ustawień) zdjęty z barrela — jedyny wołacz to `core/PKMEnv.ts` (deep-import wewnątrz core/), nic spoza core/ po niego nie sięga.
- `registerSettings` (`SettingsSection.js`) — rejestracja sekcji ustawień core
- `parseYaml`, `stringifyYaml`, `parseFrontmatter`, `validateAgentSchema`, `setYamlEngine` + typ `YamlEngine` (TS-4, 2026-09-07 — silnik YAML wstrzykiwany, patrz notka w sekcji „Zależności" wyżej)
- `slugify`, `getAgentSafeName` (AUD-code-review-029 — slug tożsamości agenta, format zamrożony, 20 kopii w 8 modułach ujednolicone na ten helper), `countTokens`, `countTokensSimple`, `getTokenCount`, `calibrate` (estymator tokenów; `resolveEncodingName`/`getEncodingForPlatform` usunięte w E1.7)
- `EventEmitter`, `StreamWatchdog` (S31 — dołożony do barrela; konsumenci: `modules/chat`, `modules/memory`), `TraceLog`, `LogFileSink`
- `TokenTracker` (S31 Z4 — przyszedł z wchłoniętego `src/utils/`; konsumenci: `modules/chat` × 3 — `chat_view.js`, `chat/chat_session.js`, `chat/chat_tabs.js`). Test obok pliku (`utils/TokenTracker.test.js`).
- `arrayBufferToBase64`, `blobToBase64` (S31 Z4 — z `src/utils/binaryUtils.js`; konsumenci: `modules/multimodal` × 3 — `SttAdapter.js`, `ImageGenAdapter.js`, `active_note.js`)
- Transport HTTP (`core/http/`): `ObsidianHttpClient`, `FetchHttpClient`, `FetchStreamTransport`, `SseFrames`, `NdjsonFrames`, `STREAM_TRANSPORT_TIMEOUT_MS` — **W barrelu**, bo korzystają z niego DWA moduły (`models` i `embedding`), a moduł nie sięga po bebechy drugiego modułu. `ObsidianHttpClient` dostaje `requestUrl` KONSTRUKTOREM, więc cały podklaster wstaje w gołym Node (harness podstawia własny router).
- ⛔ Nawigacja obsidianowa (`openNote`, `openSource` — `core/utils/obsidianNav.ts`) — **poza barrelem** (plik wciąga `obsidian`). Jedyny konsument, `src/main.ts`, deep-importuje ją jako composition root. ⚠️ AUD-dead-code-032/102 (2026-09-02): poprzednik tego pliku miał 8 eksportów, siedem SKASOWANYCH (zero wołaczy w repo) — m.in. schowek, wikilinki, popovery i drag na elementach listy oraz dwie ikony wstążki po starym panelu podobieństw. Kasacja schowka zabrała ze sobą jedynego konsumenta `require('electron')`, więc external `'electron'` w `esbuild.js` też jest martwy (AUD-dead-code-002/101/157).

**Silnik ustawień + zdarzeń (własny, w całości):** `SettingsStore` (`core/runtime/SettingsStore.ts` — worek ustawień: `settings` przez proxy, `raw` bez proxy, `save()`, `scheduleSave()` z debounce, `onChange()`) + `EventEmitter` (`core/utils/EventEmitter.ts` — on/once/off/emit). Scalanie konfiguracji (`deepMergeMissing`, `cloneConfig`, `isPlainObject`) mieszka wewnątrz `core/runtime/configMerge.ts` i NIE wychodzi na barrel — konsument jest jeden (runtime).

⚠️ 2026-09-07 (lint:obsidian, ostatnie `obsidianmd/hardcoded-config-path` w `core/runtime/`): `DEFAULT_CONFIG_DIR` (`'.obsidian'`, `runtime/contracts.ts`) **SKASOWANY** razem z re-eksportem z barrela. Stała urodziła się w clean-room (plan A1) jako nazwany dom dla zachowania P-11 („brak `configDir` → domyślnie `.obsidian`"), ale nigdy nie dostała konsumenta — P-11 realnie żyje w `utils/pluginFolderMigration.ts` (fallback `configDir || '.obsidian'` + test), a dwa pozostałe lokalne fallbacki (`security/AccessGuard.ts` `_configDir`/`SYSTEM_NO_GO`, `modules/embedding/VaultIndexer.ts` `HARD_EXCLUDES`) są celowo lokalne i mają udokumentowany wyjątek (4) w `eslint.obsidian.config.js`. Świadomie NIE zbieramy ich pod wspólny eksport: literał i tak musiałby gdzieś zostać (ostrzeżenie tylko przeprowadziłoby się do `contracts.ts` i wymagało własnego wyjątku), a przepięcie dotyka trzech plików w dwóch modułach przy zerowej zmianie zachowania. Siostrzana `DEFAULT_UI_LANGUAGE` zostaje — ma żywego konsumenta (`runtime/settingsArmor.ts`).

---

## Struktura fizyczna

```
core/
├── index.js                    ← jedyne drzwi publiczne (barrel)
├── CLAUDE.md                   ← ten plik
├── SettingsContent.js          ← render No-Go / Zaawansowane / Klucze API / Informacje (S10 hotfix)
├── SettingsSection.js          ← rejestracja sekcji core w SettingsRegistry
├── PluginBase.js               ← klasa główna (extends Obsidian.Plugin); poza barrelem
├── runtime/                    ← podłoga runtime'u (clean-room / F2)
│   ├── contracts.js            ← JEDYNE źródło nazw i sygnatur runtime'u
│   ├── PluginRuntime.js        ← cykl życia: boot / whenLoaded / reload / dispose
│   ├── SettingsStore.js        ← worek ustawień: `settings` (proxy) vs `raw`
│   ├── settingsArmor.js        ← pancerz + `readUiLanguage` (NIGDY `exists()`)
│   ├── legacySettingsMigration.js ← KWARANTANNA starych nazw kluczy
│   ├── NoticeCenter.js         ← powiadomienia (wyciszanie per id, guziki akcji)
│   ├── StatusBar.js            ← pasek statusu
│   └── configMerge.js          ← deepMergeMissing / cloneConfig / isPlainObject
├── http/                       ← transport HTTP wspólny dla models i embedding
│   ├── contracts.js            ← HttpClient / StreamTransport / FrameParser
│   ├── ObsidianHttpClient.js   ← `requestUrl` WSTRZYKIWANY konstruktorem (node-safe)
│   ├── FetchHttpClient.js · FetchStreamTransport.js
│   └── SseFrames.js · NdjsonFrames.js
├── ui/safeHtml.js              ← fragmentFromHtml (sanityzacja) + clearElement
├── layoutReady.js              ← 2026-08-23 — czysta `waitForLayoutReady(workspace?)` (zero importów,
│                                 node-safe); woła ją `PluginRuntime.boot()`
├── waitForLoaded.js            ← 2026-09-02 (AUD-wydajnosc-001/062) — czysta `waitForLoaded(getEnv, pollMs?)`
│                                 (zero importów, node-safe); woła ją `PluginRuntime.whenLoaded()`
├── layoutReady.test.js · waitForLoaded.test.js ← behawioralne testy startu (dawny strażnik po źródle skasowany razem ze środowiskiem)
├── security/
│   ├── AccessGuard.js          ← główny strażnik dostępu (E2.8 B1: setVaultGroups + rozwijanie {group} w focus)
│   ├── autonomy.js             ← 3 tryby autonomii (yolo/edge/all) + definicja krawędzi (E2.3 D21)
│   ├── vaultGroups.js          ← E2.8 B1 — pure expandFocusEntries({group} → foldery); vaultGroups.test.js obok
│   ├── PermissionSystem.js     ← permissions model + ACTION_PERMISSIONS mapa + gate autonomii (E2.8 A5/C1: 5 pól-widm out, brak bramki na polach uprawnień)
│   ├── ApprovalManager.js      ← approval flow (modal + always-approved + ścieżka „przekieruj")
│   ├── SecretsStorage.js       ← S13a — sejf na klucze API (SECRET_FIELD_PATHS)
│   ├── SensitiveDataGuard.js   ← wykrywanie/maskowanie API keys
│   ├── SensitiveDataGuard.test.js
│   ├── keySanitizer.js         ← sanitizePath, isProtectedPath, maskKey
│   ├── keySanitizer.test.js
│   ├── messageOrigin.js        ← K7 2026-08-22 — proweniencja wiadomości czatu (`meta.origin`:
│   │                             'human' | 'machine'; brak = machine, fail-closed). Bramkuje
│   │                             rejestr URL dla `web_read`, markery `@@skill:` i komendy `/`.
│   │                             NIE mylić z `_invocationOrigin` (adres zwrotny delegacji).
│   └── messageOrigin.test.js
├── utils/
│   ├── Logger.js               ← log.debug/info/warn/error/tool/model/timing; maska na KAŻDYM
│   │                             poziomie argumentu (K20 — `cause`/pola błędu też); test obok
│   ├── workPromptResolver.js   ← E2.8 B3 — resolveWorkPrompt (agent>global>factory) + WORK_PROMPT_KEYS; test obok
│   ├── errorUtils.js           ← S30 Z3 — normalize_error (pure, zero importów); K20: gałąź
│   │                             JSON.stringify bez pól-sekretów + limit 4000 zn.; test obok
│   ├── vaultFs.js              ← S30 Z3 — ensureAdapterFolder (mkdir -p na DataAdapterze); test obok
│   ├── TokenTracker.js         ← S31 Z4 (d. src/utils/) — licznik tokenów per rola; test obok
│   ├── binaryUtils.js          ← S31 Z4 (d. src/utils/) — arrayBufferToBase64 / blobToBase64
│   ├── httpLogSummary.js       ← K8 — bezpieczna linia logu żądania (bez `request_params`); test obok
│   ├── obsidianNav.js          ← openNote / openSource; ⛔ importuje `obsidian`, poza barrelem
│   ├── yamlParser.js           ← parseYaml/stringifyYaml/parseFrontmatter
│   ├── slugify.js              ← filename-safe slug generator
│   ├── tokenCounter.js         ← lekki estymator tokenów + kalibracja (bez zależności; E1.7 tiktoken RIP)
│   ├── EventEmitter.js         ← własny emiter zdarzeń (on/once/off/emit); test obok
│   └── settingsNamespaceMigration.js ← migracja nazw przestrzeni ustawień; test obok
└── i18n/
    ├── index.js                ← t(), setLocale(), getLocale(), getDateLocale()
    ├── en.js                   ← EN translations (~185 KB)
    └── pl.js                   ← PL translations (~195 KB)
```

✅ **Brak monolitu >800 LOC w logice core** (stan 2026-09-06): po rozbiciu środowiska na
`core/runtime/` największy plik logiki to `runtime/contracts.ts` (~700 linii, same typy).
Słowniki `i18n/pl.ts` i `i18n/en.ts` (po ~3000 linii) to tabele tłumaczeń, nie logika —
nie liczą się do tej reguły.

---

## Zależności

**`core/` importuje z:**
- `obsidian` (API pluginu, zewnętrzne)
- `../config/default_env_config.js` (PKMEnv — config pluginu)

> **TS-4 (2026-09-07):** `yamlParser.ts` NIE importuje już żadnego silnika YAML statycznie —
> `js-yaml` WYLECIAŁ z `package.json` w całości (katalog Obsidiana go wytykał). Silnik jest
> wstrzykiwany przez `setYamlEngine()` (eksport barrela): composition root (`src/main.ts`)
> wstawia wbudowany `parseYaml`/`stringifyYaml` z modułu `obsidian`, testy AVA i harness
> wstawiają pakiet `yaml` (devDependency) przez preload/atrapę. Patrz nagłówek
> `core/utils/yamlParser.ts`.

**`core/` NIE importuje z żadnego modułu** — poza dwoma udokumentowanymi wyjątkami, oba **przez
barrel** (`index.js`), nigdy w bebechy:
1. `security/ApprovalManager.js` → `modules/shell/index.js` (modal approvalu; wyjątek sprzed ADR 003),
2. **S29 (2026-07-29):** `PKMEnv.js` → `modules/memory/index.js` — pasek statusu ma drugi kanał
   („Puls pamięci": `memoryOpsCenter`, `OPS_EVENT`, `statusBarLine`). Bezpieczne, bo `modules/memory`
   nie importuje ani `obsidian`, ani `core/index.js` — nie ma jak zrobić cyklu. Wersja przez
   `modules/shell` byłaby cyklem (shell → chat → core).

Reguła bez zmian dla nowego kodu: core jest u podłogi, moduły stoją na nim.

**Kto importuje z `core/`:** wszystko inne (`main.js` + 116 plików w `src/`).

---

## Gotchas (miny)

### 1. Dependency injection obowiązuje

`log`, `AccessGuard`, `PermissionSystem` to singletony (lub quasi-singletony). Nie instancjonuj ich ponownie w modułach. Importuj z `core/index.js` i używaj tego samego obiektu.

### 2. Kolejność ładowania i18n

`t()` czyta aktualny język z `setLocale()`. Trzeba wywołać `setLocale('pl')` albo `setLocale('en')` ZANIM cokolwiek innego wywoła `t()`. W `main.js` dzieje się to w `onload()` — nie ruszaj kolejności.

### 3. Autonomia to nie uprawnienie

`security/autonomy.js` (E2.3 D21) trzyma 3 tryby autonomii (`yolo`/`edge`/`all`) — polityka CZATU „czy pytać", NIE uprawnienie agenta. `PermissionSystem.requiresApproval` bierze tryb i decyduje o pytaniu; `checkPermission` egzekwuje No-Go/protected/whitelistę/uprawnienia **przed** bramką approvalu, więc `yolo` znosi tylko pytania. Definicja krawędzi jest **fail-closed**: bezpieczne są tylko `read_notes` i `thinking`, każde inne (także przyszłe) uprawnienie = krawędź (pyta w `edge`).

### 4. `sanitizePath` musi iść pierwszy w każdej vault-operacji

KAŻDY MCP tool który dotyka vault (`VaultReadTool`, `VaultWriteTool`, etc.) ma wzór: `sanitizePath(path)` → `isProtectedPath(path)` → `AccessGuard` → operacja. Nie wolno przestawić kolejności — sanitizePath dekoduje `%2e%2e` i zero-width unicode, i jak tego nie zrobisz PIERWSZE, reszta guardów można oszukać. (Sesja 104 + 106 hardening.)

**K1 (2026-08-22) — bramka i zlew oglądają JEDEN ciąg.** `sanitizePath` zwraca dziś FORMĘ
KANONICZNĄ (bez `./`, `..`, wiodącego/końcowego `/`, `\`, `%XX`).
Kanonizacja dzieje się **raz, u wołacza** — `MCPClient._extractToolContext` sprowadza ścieżkę
do postaci kanonicznej i **podmienia ją w argumentach**, więc `execute` dostaje dokładnie to,
co oceniła bramka. `PermissionSystem.checkPermission` powtarza to jako
obrona w głąb (wołaczy jest więcej niż jeden); ścieżka nie do uratowania = `Invalid path`,
fail-closed, bez pytania usera. `AccessGuard._normalizeForCompare` trzyma wpisy No-Go i cel
w tej samej lekkiej normalizacji. **Nie dokładaj własnej normalizacji w narzędziach** — druga
warstwa „poprawek" to znowu dwa różne ciągi.

**K12 (2026-08-23) — kontrakt warstw kanonizacji.** Obrona w głąb w `checkPermission` obejmuje
**`vault.*` ORAZ `image.*`**. Wcześniej stało tam samo `vault.`, bo komentarz zakładał, że
`image.*` niesie prompt — nieprawda od K2: `generate_image` oddaje bramce FOLDER ZAPISU,
a `add_text_to_image` CEL ZAPISU (`output_path` albo WYLICZONE `<źródło>_text.<ext>`). Cel
wyliczany nie jest dosłownie wartością żadnego pola argumentów, więc `_canonicalizeToolContext`
u wołacza go pomija — bramka jest dla niego JEDYNĄ warstwą. Przed naprawą ta sama ścieżka
dostawała dwa różne werdykty (`vault.write` + `./.pkm-assistant/x.png` → DENY,
`image.generate` + ten sam ciąg → ALLOW). **Dokładasz akcję dotykającą pliku → sprawdź, czy
łapie ją ten warunek.**

**K13 (2026-08-23) — kanonizacja liczona do PUNKTU STAŁEGO, warstwy są trzy.** K12 wykrył,
że `sanitizePath` NIE była idempotentna, choć cały kontrakt K1 na tym stał: `trim()` działał
raz na całym ciągu, a `decodeURIComponent` zdejmował jedną warstwę kodowania, więc drugi
przebieg oddawał inny tekst (`'./ A/B.md'` → `' A/B.md'` → `'A/B.md'`; `'a%252e%252e/x'` →
`'a%2e%2e/x'` → `'a../x'`). Wołacz podmieniał w argumentach formę po JEDNYM przebiegu,
a bramka oceniała formę po DWÓCH — w oknie zgody user widział `' A/B.md'` (folder ze spacją
z przodu, SĄSIAD folderu `A`), a bramka wpuszczała `'A/B.md'` na whiteliście `A/`.
Dziś `sanitizePath` iteruje aż wynik przestanie się zmieniać (maks. 5 przebiegów, potem
`null` — fail-closed), więc `sanitizePath(sanitizePath(x)) === sanitizePath(x)`
Z KONSTRUKCJI. Zmiana semantyczna: `'%252e%252e/x'` → `null` (dawniej przechodziło jako plik
`%2e%2e`), `'a%252e%252e/x'` → `'a../x'` (segment `a..` to legalna nazwa, nie traversal).

Dzięki temu **`AccessGuard.checkAccess` kanonizuje cel SAM, na wejściu** (przed barierą suba),
a cel bez formy kanonicznej odbija się jako `Invalid path`. Wcześniej było to niemożliwe —
trzecia warstwa „poprawek" oddałaby inny ciąg i otworzyła z powrotem dziurę zamkniętą przez K1.
**K22 (2026-08-23) — `*` nie jest nazwą pliku.** `sanitizePath` odrzuca ścieżkę z gwiazdką
(`'*'`, `'Notes/*.md'`, także zakodowaną `'%2A'`): to w tym kodzie znak STERUJĄCY —
`AccessGuard._matchesEntry` czyta go jako globa whitelisty, a klucz reguły „Zawsze zezwalaj"
jako „dowolny cel". Cel od modelu ma znaczyć JEDEN plik. Windows i Obsidian i tak zabraniają
`*` w nazwach. ⚠️ Świadomie **wyłącznie** `*`: `?`, `[`, `]`, `%` nie mają tu znaczenia
sterującego, a w tytułach notatek („Czy to działa?.md") są pospolite na macOS i Linuksie —
odrzucanie ich byłoby regresją, nie obroną.

Ma to znaczenie, bo granica `.pkm-assistant/` w strażniku stoi na `startsWith`: jedno wiodące
`./` wystarczało, żeby ją minąć, gdy wołacz zapomniał skanonizować. **Wyjątek:**
`opts.targetIsVaultPath: false` — `PermissionSystem` podaje je dla akcji nie-vaultowych
(`web.search`, `web.read`, `agent.message`, `delegate`, `external.call`), których „cel" to
zapytanie, adres albo adresat. Przepuszczenie ich przez `sanitizePath` odrzuciłoby frazę
zaczynającą się od `C:\...`, adres z długim query (segment > 255 znaków) albo zapytanie
mieszające alfabety — agent straciłby wyszukiwarkę. Kontraktu pilnują
`core/security/path_canonical.test.ts` i `core/security/path_canonical_image.test.ts`.

**K14 (2026-08-23) — whitelista folderów mierzy WYŁĄCZNIE cele-ścieżki.** K13 wyłączało tą
flagą samą kanonizację, a No-Go, pliki chronione, whitelista `focusFolders` i bariera
`scope.folders` suba dalej mierzyły zapytanie jak ścieżkę. Agent w trybie „Tylko przypisane"
(`guidance_mode:false`) z whitelistą `['A/']` dostawał więc na `web_search „jak dziala X"`
odmowę `Path „…" is outside the agent's workspace` — czyli tracił wyszukiwarkę, pobieranie
stron, pocztę i delegację W CAŁOŚCI (zaszłość, nie regresja: objaw istniał także przed
naprawami z 22.08). Dziś `AccessGuard.checkAccess` przy `targetIsVaultPath === false` wraca
NATYCHMIAST z `{ allowed: true, reason: 'non-vault-target' }`, przed każdą bramką ścieżkową.
`PermissionSystem` nie zmienia przez to niczego dalej — ryzyko, zgody i `disabled_tools`
bramkują te akcje jak dotąd, a ich realne granice pilnują właściwe im warstwy: rejestr
znanych adresów + zgoda usera (`web.*`), widoczność adresata i limity skrzynki
(`agent.message`), przecięcie zakresów + głębokość z runtime (`delegate`), RED + opt-in
serwera (`external.call`). Domyślka `targetIsVaultPath: true` zostaje (fail-closed dla nowych
wołaczy); strażnik: `core/security/non_vault_targets.test.ts`.

**K15 (2026-08-23) — ZAKAZ składa litery, ZEZWOLENIE nie.** Jedna reguła, dwa kierunki:

| bramka | co robi | wielkość liter | dlaczego |
|---|---|---|---|
| No-Go, `SYSTEM_NO_GO`, `isProtectedPath` | ZAKAZUJE | **składa** (`toLowerCase`) | ma łapać za dużo, nie za mało |
| whitelista `focusFolders`, `scope.folders` suba | ZEZWALA | **rozróżnia** | ma wpuszczać za mało, nie za dużo |

Do K15 No-Go porównywało bajt w bajt, z komentarzem „vault bywa case-sensitive". Na Windows
i macOS system plików wielkości liter NIE rozróżnia, więc `Projekty/prywatne/tajne.md`
przechodził bramkę na zielono (bez okna zgody), choć `Projekty/Prywatne/tajne.md` był
odrzucany — a to JEDEN I TEN SAM PLIK. Tak samo uciekały `.Obsidian/workspace.json`
i `.TRASH/x.md` (`SYSTEM_NO_GO`). No-Go było **jedyną bramką ścieżkową fail-OPEN** na
wielkość liter; `isProtectedPath` składa litery od zawsze i dlatego luki nie miało.

Dziś obie strony są fail-CLOSED, tylko „bezpiecznie" znaczy dla nich co innego. Normalizacja
zakazu mieszka w `AccessGuard._normalizeForDenyCompare` (`\`→`/`, `NFC`, `toLowerCase`,
puste segmenty i `.` won) i jest wołana z `_isNoGo` ORAZ z `setNoGoFolders` — wpisy lądują
w `_noGoFolders` złożone, więc `Prywatne/` i `prywatne` to jeden wpis. `_normalizeForCompare`
zostaje jako czysta normalizacja KSZTAŁTU (baza tamtej, bez ruszania liter).

**Cena, świadomie zaakceptowana:** na vaultcie naprawdę case-sensitive (Linux) zakaz obejmie
też „sąsiada" różniącego się literą — `prywatne/` obok zakazanego `Prywatne/` przestanie być
dostępny. Lepiej zakazać za dużo niż wypuścić plik, który miał być zakazany.

**Dokładasz bramkę ZAKAZU dotyczącą ścieżek → składaj litery.** Ta sama reguła obowiązuje
poza `core/`: wykluczenia indeksu semantycznego (`modules/embedding/VaultIndexer._isExcluded`)
liczą ją u siebie lokalnie, bo indekser trzyma zero zależności od `core/`.
Strażnik: `core/security/nogo_case.test.ts`.

### 4b. Maska sekretów ma DWA filtry: kształt i NAZWĘ pola (K8, 2026-08-22)

`maskSensitiveData` maskuje nie tylko znane prefiksy kluczy (`sk-`, `gsk_`, `xai-`, `AIza`…),
ale też **wartość pola o wrażliwej nazwie** (`Authorization`, `api_key`, `apiKey`, `x-api-key`,
`*_key`, `token`, `secret`, `password`) — w JSON-ie, w nagłówku i w gołym tekście. Filtr po
kształcie zawsze będzie spóźniony o kolejnego dostawcę; filtr po nazwie łapie także tych,
których nie znamy. Próg 8 znaków chroni zwykły tekst notatek (`RetrievalEngine` też przepuszcza
snippety przez maskę). Nie loguj obiektów żądań w całości — od K8 `core/utils/http_request.ts`
wypisuje jedną linię z `httpLogSummary.ts` (metoda, adres bez query, status, czas, NAZWY
nagłówków), a nie `JSON.stringify(request_params)`.

### 4d. Klucz API nie ma prawa wejść do `message` — TRZY warstwy (K20, 2026-08-23)

K8 zamknął drogę „obiekt → jedna stringifikacja". Audyt (AUD-security-120/132/133) pokazał
drogę o jedno piętro dłuższą: obiekt błędu wpadał jako TEKST do pola `message`, a to pole
przechodziło przez `JSON.stringify` w Loggerze. Wtedy nazwa nagłówka jest zaescapowana
(`\"api-key\":\"…\"`) i ŻADEN filtr K8 się nie dopasowywał — klucz Azure/LM Studio/Custom
lądował jawny w `.pkm-assistant/logs/pkm-assistant.log` i w komunikacie na ekranie usera.

Naprawa stoi na trzech niezależnych warstwach — **każda musi zostać**:

1. **Źródło (`modules/models/adapters/chat_adapter_base.ts`).** Zdarzenie streamera nie niesie
   już streamera. `event.source` to od K20 sam OPIS (`{url, method, readyState}`), bez `headers`
   i bez ciała rozmowy, a słuchacz błędu podaje do `normalize_error` wyłącznie bezpieczny
   wycinek — nigdy całe zdarzenie. Szczegóły w `modules/models/CLAUDE.md` (gotcha 10).
2. **`core/utils/errorUtils.ts`.** Gałąź `JSON.stringify` budująca `message` wycina pola, które
   z definicji niosą kontekst żądania (`SECRET_BEARING_FIELDS`: `headers`, `source`, `request`,
   `request_params`, `xhr`, `config`, `options`), radzi sobie z cyklami i tnie wynik do 4000
   znaków. Plik ZOSTAJE czysty (zero importów) — filtr jest po nazwie pola, bez maski.
   ⚠️ `details` celowo zostaje surowym obiektem: to kontrakt adapterów 12 platform, a obiekt
   i tak idzie do logu przez maskę.
3. **`core/security/SensitiveDataGuard.ts`.** Trzeci przebieg `ESCAPED_FIELD_RE` łapie tę samą
   parę `pole: wartość` w JSON-ie zaescapowanym raz albo dwa razy. Świadomie OSOBNY regex, nie
   rozluźnienie dwóch poprzednich — tamte trzymają 9+ testów K8. Przed przebiegiem stoi tani
   pre-check (`\"` w tekście), więc gorąca ścieżka logu nic nie traci. Maska jest idempotentna
   (maska maski = maska) także w tej formie.

Do kompletu `core/utils/Logger.ts` przepuszcza przez maskę KAŻDY poziom argumentu: klon `Error`
zabiera ze sobą `cause` (ES2022) i pola doklejone przez adaptery (`response`, `data`, `details`)
— zamaskowane, zamiast po cichu znikać, jak było wcześniej. Rekurencja ma limit głębokości
(`MASK_MAX_DEPTH`), a `.map()` woła maskę przez lambdę: goły `.map(maskLogValue)` podawałby
INDEKS tablicy jako głębokość.

**Dokładasz nowe pole niosące transport (klient HTTP, socket, kolejka)?** Dopisz jego nazwę do
`SECRET_BEARING_FIELDS` — inaczej pierwszy błąd bez ciała odpowiedzi powtórzy tę samą drogę.

### 4c. K2 (2026-08-22) — brak celu to ODMOWA, nie przepustka

Wszystkie bramki w `checkPermission` (No-Go, pliki chronione, whitelista `focusFolders`,
`scope.folders` suba) stoją za `if (targetPath)`. Akcja z pustym celem przeskakiwała je
wszystkie — tak `artifact_*` pisały do vaulta bez ani jednego strażnika. Nowy zestaw
`TARGET_REQUIRED_ACTIONS` (`vault.write/create/create_folder/delete`, `artifact.create/
update/read`, `image.generate`) wymaga celu i odmawia fail-closed; `admin_access` NIE zwalnia.
`vault.read` jest poza zestawem **świadomie**: tą samą akcją chodzą `ask_user`, `todo`,
`kom_list`/`kom_read` i `scope:'memory'`, które celu nie mają z definicji (root listingu to `'/'`).
**Dodajesz akcję, która dotyka pliku → dopisz ją do zestawu**, inaczej pierwsze narzędzie bez
pola `path` powtórzy tę samą lukę.

W `ApprovalManager` „brak celu" ma własny token (`akcja::<bez-celu>`) i nie zapada już
w wieloznacznik `akcja::*` — jedno kliknięcie „Zawsze zezwalaj" na akcji bez ścieżki nie otwiera
wszystkich przyszłych zapisów agenta.

### 4d. K22 (2026-08-23) — cel od WOŁACZA nigdy nie jest wieloznacznikiem

K2 zamknął drogę „pusty cel → wildcard", ale została druga: DOSŁOWNA gwiazdka z argumentu
pisanego przez model. `delete {path:"*"}` przechodziło (`sanitizePath('*')` oddawało `'*'`),
modal pokazywał kasowanie „*", wywołanie i tak odbijało się o walidację narzędzia („File *
not found") — więc user klikał „Zawsze zezwalaj" spokojnie i zapisywał TRWAŁĄ regułę
`vault.delete::*`. Od tej chwili każde kasowanie tego agenta, pod dowolną ścieżką, szło bez
modala. To samo dla `vault.write`, `agent.message` (`to:"*"`) i `web.*`.

Dziś `createPatternKey` przepuszcza cel przez `literalTarget()`: podwaja `<` (żeby cel nie udawał
tokenów `<bez-celu>` / `<gwiazdka>`) i zamienia każdą gwiazdkę na `<gwiazdka>`.
**`akcja::*` nie ma jak powstać z celu podanego przez wołacza** — a innej drogi zapisu reguły
nie ma, bo ekran reguł (Ustawienia → Bezpieczeństwo → „Approved actions") tylko listuje i kasuje.
Gałąź wieloznaczna w `isAlwaysApproved` ZOSTAJE dla reguł zastanych (nie kasujemy po cichu cudzych
decyzji), a `loadApprovals` zgłasza je jednym `log.warn` z listą. Kasowanie sięga po obie formy
klucza (przeliczoną i surową), żeby ekran reguł umiał usunąć dokładnie to, o czym ostrzega.

**Dokładasz JAWNĄ drogę „zezwalaj na wszystko"?** Ma prowadzić z ekranu reguł, nigdy z modala —
modal opisuje JEDNO konkretne wywołanie i user ocenia właśnie je.

Druga warstwa: `sanitizePath` odrzuca `*` w ścieżce (gotcha #4 niżej), więc `path:"*"` nie
dochodzi nawet do okna zgody. Ale to TYLKO warstwa — cele nie-vaultowe (`web.*`,
`agent.message`) przez `sanitizePath` nie idą (K14), naprawa siedzi w `ApprovalManager`.
Strażnicy: `ApprovalManager.test.ts` (6 testów K22) + `keySanitizer.test.ts`.

### 5. `SensitiveDataGuard.lastIndex`

`maskSensitiveData()` używa regex globalnego (`/.../g`). Regexy globalne w JS trzymają stan `lastIndex` między wywołaniami — jak nie zresetujesz, drugie wywołanie na tym samym tekście zwróci `null`. Wewnątrz funkcji jest reset, ale jeśli wyciągasz regex gdzie indziej — pamiętaj. (Sesja 106 fix.)

### 6. `Logger` jest blisko-bezszumny gdy `debugMode=false`

Domyślnie tylko `warn`/`error` lecą do konsoli. Jak chcesz zobaczyć `log.debug()` / `log.tool()` / `log.model()` — włącz `pkmAssistant.debugMode` w settings. To nie bug, to by default silent.

### 6a. Sink plikowy Loggera zamyka się przez `log.disposeFileSink()` (AUD-bledy-059/038, 2026-08-23)

`initFileSink()` (z `src/main.ts`) trzyma prywatny `LogFileSink` na `.pkm-assistant/logs/pkm-assistant.log`,
a hot-path tylko buforuje i planuje flush (debounce 1000 ms). Do naprawy `dispose()` tego sinka wołał
WYŁĄCZNIE sam `initFileSink` przy ponownej inicjalizacji — `onunload` domykał tylko sink trace'u, więc
ogon logu z demontażu ginął przy zamknięciu Obsidiana, a budzik flusha zostawał na martwym pluginie.
Dziś `disposeFileSink()` (flush + dispose + wyzerowanie, fail-soft) leci **na samym końcu `onunload`** —
kroki wyżej jeszcze logują, więc nie przestawiaj go wyżej. To OSOBNY obiekt niż `plugin.traceLog`.

### 6b. Boot NIE PISZE ustawień — provisioning idzie do SUROWEGO worka (2026-07-31)

`env.settings` to **obserwowane proxy** (`SettingsManager`): każda mutacja planuje zapis CAŁEGO
pliku `.pkm-assistant/settings.json` (debounce ~1 s) — a tam mieszkają klucze API. Gdyby
`load_settings` kiedykolwiek zdegradował się do defaultów (dysk sieciowy potrafi skłamać
o istnieniu pliku), taki bootowy zapis utrwaliłby defaulty i skasował plik usera. To jest
dokładnie incydent 2026-07-28.

**Reguła:** stan, który nie jest decyzją usera (dosztukowanie pustych kontenerów, migracje
w RAM, klucze efemeryczne), zapisuj w `env.settingsStore.raw` — SUROWYM worku
z pominięciem proxy. Na dysk trafi przy pierwszym REALNYM zapisie. Wzorce w `load()`
i `init_collections`. Domknięci pisarze bootowi: bezwarunkowy `save()` w `load`, migracja
`modelLibrary`, provisioning defaultów/kolekcji, `pkmAssistant.security` dla `ApprovalManager`
(`src/main.ts`), wyciszenia powiadomień (`pkmAssistant.notices.muted`, `core/runtime/NoticeCenter.ts`)
oraz domyślny model embeddingu (`modules/embedding/`).

**Ta sama lekcja dla PLIKÓW: `probeFile` (`core/utils/vaultFs.ts`, eksport z barrela, K4 /
AUD-bledy-061).** `adapter.exists()` odpowiada boolem, więc wołacz MUSI wybrać jedną z dwóch
odpowiedzi — a jedno skłamane `false` nadpisywało `brain.md` / plik sesji / `.state.json`
domyślną treścią. `probeFile(adapter, path)` daje `'exists' | 'missing' | 'unknown'`
(`false` potwierdzane próbą `read`). Piszemy WYŁĄCZNIE na `'missing'`; `'unknown'` jest
fail-closed. Wołaj to na ścieżkach zapisu, nie w pętlach listujących (kosztuje jeden `read`).

⚠️ `PKMNotices.settings` **prowizjonuje w worku, ale zwraca gałąź Z PROXY** — wyciszenie
notice'a przez usera (`settings.muted[id] = true`) to prawdziwa decyzja i MA planować zapis.
Ta sama zasada dotyczy każdego podobnego gettera: nie kasuj obserwowania, przenieś sam
provisioning.

Strażnik: scenariusz harnessa `39_boot_nie_pisze` (zdrowy `settings.json` przeżywa boot co do
bajta, `settingsManager.save_timeout` nie wisi po turze) obok `26_settings_pancerz`
i `27_settings_lastgood`.

### 6c. Sekwencja startu: ZDARZENIA, nie zegary (2026-08-23)

Ścieżka bootu wygląda dziś tak i ma tak zostać:

```
src/main.ts onload()
  ├─ app.workspace.onLayoutReady(initialize)   ← initialize czeka na env: wait_for({loaded:true}), poll 100 ms
  ├─ PKMEnv.create()
  │     └─ setTimeout(…, env_start_wait_time = 0)   ← debounce jednej tury, nie okno czekania
  │           └─ PKMEnv.load()
  │                 ├─ gałąź mobile-defer (bez zmian)
  │                 ├─ await wait_for_layout_ready()      ← ZDARZENIE workspace.onLayoutReady
  │                 ├─ register_status_bar()
  │                 ├─ fs.load_files() + settings.json + init_collections()   ← cały realny I/O
  │                 ├─ await ready_to_load_collections()  ← JUŻ TYLKO wait_for_obsidian_sync()
  │                 ├─ await load_collections()
  │                 └─ state = 'loaded'
  └─ await read_ui_language() → setLocale() → register_commands() + register_ribbon_icons()
        ↑ review W5-01/W5-04 (2026-09-04): JEDYNY `await` w `onload()` — odczyt jednego pola
          z `.pkm-assistant/settings.json`. Komendy i wstążka NIE MOGĄ zależeć od bootu env
          (F2.16 trzymało je w `initialize()`: pad `PKMEnv.load()` = zero komend u usera),
          ale język musi być znany przed `addCommand` — Obsidian zapamiętuje nazwę w chwili
          rejestracji. `initialize()` woła `setLocale()` powtórnie, już z pełnych ustawień.
```

**Dwa odziedziczone okna czekania wycięte 2026-08-23** — start spadł z 8,09 s do ~0,2 s
(dry-boot harnessa: 3,20 s → 0,15 s przy override 50 ms):

- Konfigurowalny sen startowy miał fallback **5000 ms**. Był to debounce z czasów, gdy KILKA
  siostrzanych pluginów rejestrowało się w jednym globalnym rejestrze środowiska i start czekał,
  aż wszystkie zdążą. U nas środowisko jest modułowe i ma jednego wołacza (`src/main.ts`) —
  nie było na kogo czekać. Cały mechanizm zniknął razem ze starym środowiskiem.
- Drugie okno to ślepy sen **3000 ms** przed ładowaniem danych („poczekaj, aż inne procesy
  skończą"). Niczego nie sprawdzał, a prawdziwy warunek stał linijkę niżej (czekanie na sync
  Obsidiana, u usera bez Obsidian Sync wraca natychmiast).

⚠️ **Gotcha:** jeśli ktoś kiedyś doda kolekcję z `process_load_queue`, która potrzebuje gotowego
indeksu Obsidiana — **ta kolekcja ma zadbać o własną gotowość** (np. `metadataCache.on('resolved')`),
a nie przywracać tu zegar. Start jest dziś sprawdzany behawioralnie (`core/layoutReady.test.ts`,
`core/waitForLoaded.test.ts`), nie regexem po źródle.

**Domknięcie 2026-09-02 (AUD-wydajnosc-001/062):** `PluginRuntime.whenLoaded()` (wołacz drugiej strony —
`initialize()` na starcie ORAZ `pkm_settings_tab.ts` przy KAŻDYM otwarciu zakładki Ustawień)
czekał wyłącznie ślepą siatką `setInterval` 100 ms, bez sprawdzenia warunku na wejściu — to samo
uchybienie co dwa okna wyżej, tylko o piętro dalej i bez configu. Dziś sprawdza stan NATYCHMIAST,
a jak nie jest gotowy — rozwiązuje się na zdarzenie `'loaded'` (emitowane przez `boot()` zaraz po
`state = 'loaded'`), z siatką 250 ms jako czystą asekuracją (re-oceniana na każdym ticku — łapie
też env powstały PO wywołaniu i podmianę instancji przy `reload()`, nie tylko
tę widoczną w chwili startu). Logika mieszka w czystym `core/waitForLoaded.ts` (ten sam wzór
co `layoutReady.ts` — testowalne bez mocka `obsidian`), `whenLoaded()` jest cienką otoczką.
⚠️ **`'unloading'` (emitowane przez `dispose()`) nie tylko kasuje siatkę — PORZUCA oczekujący
`whenLoaded` na zawsze: zwrócona promise już się NIE rozwiąże**, nawet jeśli env później zostanie
załadowany ponownie. Celowo: po demontażu (`restart_plugin`) nie ma na co dalej czekać —
kontynuacja byłaby zombie-`initialize()` na cudzym, kolejnym środowisku. Wołacz, który
naprawdę potrzebuje gotowego env po restarcie, ma wywołać `whenLoaded()` PONOWNIE.

### 7. Odziedziczone pliki środowiska ✅ ZNIKNĘŁY

Trzy pliki starego frameworka bazowego (event bus, proxy ustawień, helpery środowiska) siedziały w `core/utils/` tylko dlatego, że stało na nich środowisko. Zostały wymienione na własne implementacje, a przy clean-room środowisko rozjechało się na `core/runtime/`. Gotcha zostaje jako znacznik: jak trafisz na kod sięgający po dawny worek ustawień środowiska, to zaszłość — dziś jest `env.settingsStore` (`core/runtime/SettingsStore.ts`).

### 8. Updater wycięty (D1, 2026-09-04)

Updater wycięty 2026-09-04 przed katalogiem (D1) — aktualizacje przez katalog / BRAT.

---

## Testy

- `core/security/SensitiveDataGuard.test.js` — wykrywanie/maskowanie API keys (OpenAI/Anthropic/Google/etc.)
- `core/security/ApprovalManager.test.js` — R4 (reguła per narzędzie external) + **K22**: cel `*`
  od wołacza nie daje wieloznacznika (`vault.delete`, `agent.message`, gwiazdka wewnątrz celu),
  reguła zastana `akcja::*` działa jak dotąd ale ostrzega przy wczytaniu, ekran reguł ją kasuje,
  reguła dla konkretnego celu bez zmian
- `core/security/keySanitizer.test.js` — `sanitizePath` (`../`, `%2e%2e`, null byte, zero-width unicode, UNC,
  **K22: `*` odrzucone, `?`/`[`/`%` nadal legalne**,
  ścieżki absolutne + **K13: idempotencja do punktu stałego**, w tym test własnościowy na 3000
  wygenerowanych ciągach z deterministycznego LCG) i `isProtectedPath` (`.pkm-assistant/settings.json`,
  `settings.last-good.json`, kopie, logi, sesje pamięci agenta, `.env`, `data.json`)
- `core/security/path_canonical.test.js` — K1/K13: równoważność zapisu ścieżki + pełny łańcuch
  wołacz→bramka→zlew (`MCPClient` + `WriteTool` + `PermissionSystem`, bez mocka `obsidian`)
- `core/security/path_canonical_image.test.js` — K12/K13: kanonizacja dla akcji `image.*` i to,
  że `AccessGuard` prostuje cel sam z siebie
- `core/security/non_vault_targets.test.js` — K14: cele nie-vaultowe (`web.*`, `agent.message`,
  `delegate`) omijają whitelistę folderów i zakres suba, a whitelista NADAL tnie prawdziwe
  ścieżki; brak flagi `targetIsVaultPath` = pełna ocena ścieżkowa (fail-closed)
- `core/security/nogo_case.test.js` — K15: No-Go i `SYSTEM_NO_GO` łapią mimo innej wielkości
  liter (`checkPermission` + `checkAccess` + `filterResults`), wpisy z ustawień zwijają się
  do jednego, a whitelista i zakres suba NADAL rozróżniają wielkość liter

- `core/security/SensitiveDataGuard.test.js` — K20: zaescapowany JSON (`\"api-key\":\"…\"`),
  dwie warstwy zaescapowania, `Bearer <token bez znanego kształtu>`, idempotencja maski

**214 security tests** (stan 2026-08-23, K15-K22) — odpalane przez `npm test` (AVA pattern
`core/security/*.test.js` w `package.json`).

Rdzeń `core/` (pattern `core/*.test.js`): `PKMEnv.boot_timing.test.js` — 7 testów strażnika startu
(2026-08-23). Cztery czytają **źródło** `PKMEnv.ts` regexami, bo plik importuje `obsidian` i nie wstaje
w AVA (ten sam wzór co `modules/prompts/PromptBuilder.cache.test.js`): brak ślepego zegara
w `ready_to_load_collections`, fallback `env_start_wait_time` = 0 przy żywej drodze przez config,
kolejność `ready_to_load_collections` → `load_collections`, oraz `await wait_for_layout_ready()`
przed `state = 'loading'`. Trzy pozostałe testują **naprawdę** `waitForLayoutReady` z `layoutReady.js`
(brak workspace / callback synchroniczny / callback po 20 ms).

Utils (pattern `core/utils/*.test.js`): `errorUtils.test.js` — 11 testów (S30 Z3: null/string/`error.code`/zagnieżdżony `error.error.type`/`http_status`/JSON.stringify; **K20**: pola-sekrety poza `message`, limit długości, cykle, `details` bez zmian) · `Logger.test.js` — 7 testów (**K20**: maska na każdym poziomie — zaescapowany JSON w polu `message`, `cause`/`response` błędu, `debug`/`info`/`warn` do sinku, zwykły log nietknięty) · `vaultFs.test.js` — 6 testów (S30 Z3: kolejność mkdir rodziców, istniejące = zero mkdir, brak metod adaptera = no-op, pusta ścieżka, normalizacja backslashy) · `workPromptResolver.test.js` · `TokenTracker.test.js` (S31 Z4 — przyjechał razem z plikiem z `src/utils/`; łapie go ten sam wzorzec AVA, wpis `src/utils/*.test.js` w `package.json` skasowany).

---

## Kluczowe decyzje

- **`core/index.js` barrel zamiast deep imports** — konsystentne z regułą "jedyne drzwi" dla modułów. ✅ **ZROBIONE w S31 (2026-07-30):** ESLint `no-restricted-imports` wymusza "poza core importuj tylko z `core/index.js`" (wyjątki: `i18n/index.js`, `utils/Logger.js`, oraz composition root `src/main.js` na cztery obsidianowe pliki).
- **Trzy odziedziczone pliki środowiska wpuszczone do core/** — decyzja świadoma, udokumentowana w nagłówkach tych plików. Alternatywa ("niech środowisko importuje z `src/utils/`") łamała zasadę "core nie zależy od src/". ✅ Domknięte w E3.7 (2026-07-28): pliki zastąpione własnymi `EventBus`/`SettingsManager`/`env_utils`.
- **Test pliki razem z kodem** (`core/security/keySanitizer.test.js` obok `keySanitizer.js`) — nie w `__tests__/` ani `test/`. Konsystencja z dotychczasowym stylem projektu (było `src/utils/X.test.js` obok `src/utils/X.js`).

---

## TODO / Rezerwa

> **Centralny backlog:** [`Refaktor/01_Surowizna_TODO_Wizje.md`](../Refaktor/01_Surowizna_TODO_Wizje.md) — matryca 264 znalezisk × sprinty.
> (Do 2026-08-02 wskazywało to na `TODO_Post_MAX.md` w vaultcie; folder skasowany, patrz nota w root `CLAUDE.md`.)
>
> Poniżej tylko krótki spis dotyczący `core/`. Szczegóły + kontekst + priorytety w matrycy.

**Core-specific:**

- ✅ Wywałka roli `master` — **ZROBIONE 2026-09-02** w fabryce dead-code, klaster S1 (merge `c0c558f9`, AUD-dead-code-038/173): slot `modelLibrary.master` naprawdę zamknięty (`ModelRole` bez `strategist`/`master`/`sub_agent`, migracja `src/main.ts`, zerowanie w Ustawieniach). Uwaga historyczna: audyt dead-code 2026-09-02 (AUD-dead-code-038) OBALIŁ tę linię jako fałszywe TODO — w chwili audytu rola była żywą warstwą aliasów w ~153 miejscach, nie martwym kodem w ~40; S1 ją zamknął naprawdę, więc TODO jest dziś prawdziwe z zupełnie innego powodu niż zakładało.
- ✅ `tokenCounter.js` precyzja per-platform — ROZWIĄZANE w E1.7 (D23) inaczej niż tu zakładano: js-tiktoken wywalony, lekki estymator z kalibracją EMA per-platforma z realnego API usage (nie `o200k_base`/`@xenova`); wyświetlanie tokenów z API usage.
- 🟡 Obsidian helpers rozwinięcie + potencjalne wydzielenie do osobnej biblioteki (JDHole WIZJA + trend Obsidian CLI)
- ✅ Wymiana trzech odziedziczonych plików środowiska (event bus, proxy ustawień, helpery) na własne — ZROBIONE w E3.7 (2026-07-28); przy clean-room środowisko rozbite na `core/runtime/`
- ✅ `ApprovalManager` → modal UI — ZROBIONE (migracja shell, Mapa-15, 2026-04-26): stary docelowy zapis `../src/views/ApprovalModal.js` już nie istnieje. `core/` nie importuje modala wcale — `ApprovalManager.setApprovalHandler()` przyjmuje go przez DI. `src/main.ts` importuje `requestApproval` z barrela `modules/shell/index.ts` i wstrzykuje: `this.approvalManager.setApprovalHandler(requestApproval)`. Fizyczny modal mieszka w `modules/shell/ApprovalModal.ts`.
- ✅ Nieużywana ikona wstążki — ROZWIĄZANE (AUD-dead-code-086, 2026-09-02): potwierdzony dead code, funkcja skasowana z `modules/crystal-soul/add_icons.ts` razem z wywołaniem w `src/main.ts`.
- 🟢 `TokenTracker` + `tokenCounter` razem do `modules/chat/` albo `modules/models/` — docelowo. **Stan po S31 Z4:** oba są w `core/utils/` (TokenTracker przyjechał tu z kasowanego `src/utils/`, bo musiał gdzieś zamieszkać). Pomysł „do modułu" nadal otwarty — TokenTracker ma dziś 3 konsumentów, wszystkich w `modules/chat`, więc kryterium ADR 003 („≥3 moduły") formalnie nie spełnia.

**Architektura globalna (dotyczy też core):**

- ✅ ZROBIONE (S31, 2026-07-30): ESLint rule `no-restricted-imports` zabrania deep-importów do `core/utils/…`, `core/security/…` i `modules/<nazwa>/bebechy` — na `modules/**`, `src/**`, `config/**`, `utils/**`

---

## E2.8 update (2026-07-23) — agenci v3: czystka uprawnień-widm + grupy vaulta + resolver promptów

- **`PERMISSION_TYPES` / `ACTION_PERMISSIONS` odchudzone (A5).** Z katalogu `PERMISSION_TYPES` usunięte 5 martwych kategorii (`access_outside_vault`/`execute_commands`/`building_agents`/`system_settings`/`skills_crud` — 0 dispatchu w runtime; `thinking` ZOSTAJE jako kategoria akcji, bezpieczna krawędź w autonomy). `ACTION_PERMISSIONS` bez martwych akcji `command.execute`/`agent.create`/`skill.create`/`settings.write`. **Uwaga:** to katalog akcji dla `checkPermission`, osobny od `Agent.DEFAULT_PERMISSIONS` (pola agenta — po C1 tylko `memory` + `guidance_mode`).
- **`PermissionSystem.checkPermission` nie bramkuje już na polach uprawnień (C1).** Dawna gałąź `if (!agent.permissions[requiredPermission])` USUNIĘTA — o „wolno" decyduje DOSTĘPNOŚĆ narzędzia (`agent.disabled_tools` + `ToolRegistry.filterByAgent`, patrz `modules/mcp`). `checkPermission` robi teraz: No-Go/protected (absolutne) → AccessGuard (whitelista/focus, poziom read/write z akcji) → bramka approvalu wg autonomii. Nieznana akcja = fail-closed. Krawędź (`autonomy.js` `SAFE_PERMISSION_TYPES = {read_notes, thinking}`) NIETKNIĘTA — gotcha #3 nadal aktualna.
- **Grupy folderów vaulta (B1).** Nowy pure `security/vaultGroups.js` (`expandFocusEntries(entries, groups)` — rozwija string / `{path,access}` / `{group}`; brakująca grupa = pominięta z logiem, nigdy crash). `AccessGuard` trzyma `_vaultGroups` (static) + `setVaultGroups(groups)` wołane przy init i po edycji w Settings→Vault; `_normalizeEntries` rozwiązuje `{group}` live. Grupy definiuje user w Settings→Vault (`settings.pkmAssistant.vaultGroups`, shell-owned).
- **Resolver promptów roboczych (B3).** Nowy pure `utils/workPromptResolver.js` (`resolveWorkPrompt(agent, key, settings, factory)` — łańcuch per-agent > global `settings.pkmAssistant.promptDefaults` > factory; `settings` przyjmowane defensywnie jako pełny obiekt albo slice `pkmAssistant`) + `WORK_PROMPT_KEYS` (**5 kluczy**: compression/save_session/archive/summary/subagent_frame — **`brief` skreślony 2026-09-02 w fabryce dead-code, klaster B5 (merge `f7c70da2`)**: slot był nieczytany od skasowania jedynego konsumenta `ContextSessionGenerator` w E2.9 fazie D, a Settings→Prompt mimo to renderował go jako żywą kontrolkę; `DEFAULT_BRIEF_PROMPT` i sam slot Ustawień skasowane w tym samym cięciu, patrz `modules/memory/CLAUDE.md`). Fabryczne treści żyją przy konsumentach (memory/chat/sub-agents), nie w core. Eksport w barrelu (dawna uwaga „node-owe konsumenty deep-importują plik, bo barrel wciąga obsidian" — nieaktualna od S31: barrel jest node-safe).
- **Autonomia per-agent (A6/S5).** `Agent.default_autonomy` (nowe pole; `null` = użyj globalnego `settings.pkmAssistant.defaultAutonomy`) — punkt startowy nowej rozmowy. `chat_model._getDefaultAutonomy(agent)` czyta `agent?.default_autonomy || settings.pkmAssistant.defaultAutonomy || DEFAULT_AUTONOMY`. Autonomia to nadal polityka CZATU (czy pytać), nie uprawnienie — per-czat override w locie działa dalej (patrz `modules/chat`).

---

## Historia

- **Sesja 100** — wyciągnięcie zależności zewnętrznych do repo: kod wylądował w `src/`
- **Sesja 126 (Dzień 1 MAX)** — placeholder `core/CLAUDE.md`, foldery `core/security/`, `core/utils/`, `core/i18n/` stworzone, kod jeszcze w `src/core/` + `src/utils/` + `src/i18n/`
- **Sesja 127 (Dzień 2 MAX)** — **TA MIGRACJA**. 17 plików przeniesione do `core/` (git mv, historia zachowana), `core/index.js` barrel, 187 importów zaktualizowane w 116 plikach src/, AVA config update (`core/security/*.test.js` + `core/utils/*.test.js`), build 8.0mb, 58/58 tests PASS

---

## Dla Claude Code

Otwieraj `core/` jako kontekst gdy pracujesz nad:
- Entry pointem pluginu (`PluginBase`, `runtime/PluginRuntime`)
- Security (AccessGuard, permissions, approval flow)
- Utils używanymi wszędzie (logger, yaml, hash, slugify, tokens, i18n)

NIE otwieraj gdy pracujesz nad konkretnym modułem — wtedy otwórz `modules/<nazwa>/`. Core jest cicho w tle, jego publiczne API siedzi w `index.js` i to wystarczy zobaczyć.

---

## E3.7 update (2026-07-28) — wymiana odziedziczonych plików środowiska + nowy dom ustawień

- **Odziedziczone proxy ustawień i event bus SKASOWANE** → własne implementacje (worek ustawień
  z tym samym API obserwacji przez proxy + emiter on/once/off/emit, bez adapter-pattern).
  Dziś ich potomkami są `core/runtime/SettingsStore.ts` i `core/utils/EventEmitter.ts`.
- **Środowisko i klasa pluginu przemianowane** (bez aliasów po starej nazwie); `main.js`
  (klasa `PKMAssistantPlugin`, d. ObsekPlugin) przepięty. Dzisiejsze nazwy: `core/PluginBase.ts`
  i `core/runtime/PluginRuntime.ts`.
- **Ustawienia mieszkają w `.pkm-assistant/settings.json`** (koniec starego domu w folderze
  środowiska): pancerz z incydentu 2026-07-28 (load NIGDY nie pisze; corrupt-odkładka; fallback
  `settings.last-good.json`) + backup dzienny rotacyjny `.pkm-assistant/backups/` (7).
  `isProtectedPath` chroni te ścieżki; `src/main.ts` dopisuje je do `.gitignore` vaulta przy
  starcie (klucze API nie mogą trafić do repo usera). Import ze starego domu został wycięty
  przy clean-room — dziś w pamięci działa wyłącznie migrator nazw kluczy
  (`core/runtime/legacySettingsMigration.ts`).
- Gotcha #7 („odziedziczone pliki znikną") — WYKONANE.

## A1–A3 security update (2026-07-24)

- **Jedyny escape hatch = `agent.admin_access === true`.** `AccessGuard` i
  `PermissionSystem` przepuszczają wtedy No-Go, protected files, `.pkm-assistant`,
  `.obsidian` i `.trash`, ale wyłącznie wewnątrz vaulta. `sanitizePath` nadal
  odrzuca ścieżki absolutne, UNC i traversal. Admin nie włącza narzędzi i nie
  zmienia autonomii.
- **Workspace v2:** `guidance_mode:true` = cały zwykły vault;
  `guidance_mode:false` + puste `focusFolders` = zero zwykłego vaulta. Jednorazowa
  migracja zachowująca zachowanie starych agentów żyje w `modules/agents/accessPolicy.js`.
- **Światła approvalu:** `classifyToolRisk()` jest publiczne przez `core/index.js`
  (⚠️ AUD-dead-code-116/177, 2026-09-02: `TOOL_RISK_LEVELS` zdjęte z barrela — zero
  konsumentów poza `core/`, żywe wewnątrz `security/autonomy.ts` i `PermissionSystem.ts`
  przez deep-import). GREEN = odczyt/myślenie/pytanie; YELLOW = kontrolowane
  lub odwracalne akcje z toggle; RED = nadpisanie/kasowanie/wysyłka/zewnętrzny
  serwer, obowiązkowe w `edge`. Nieznane narzędzie = RED.
- **`create_folder` wymaga poziomu write.** AccessGuard wylicza poziom z
  `ACTION_PERMISSIONS` (wewnętrzna mapa `PermissionSystem.ts`), nie ze starego
  wyjątku tylko dla write/delete.
- Pełna swoboda to przecięcie trzech osi: narzędzie włączone + `admin_access` +
  autonomia `yolo`. Żadna z nich sama nie zastępuje pozostałych.

## S33 A1 update (2026-07-30) — scope sub-agenta tnie też WYNIKI

`AccessGuard.filterResults(agent, results, pathExtractor, opts)` ma czwarty parametr
`opts.scopeFolders`. Bez niego bariera z fali 1 miała dziurę: sub ze `scope.folders`
nie otworzył pliku spoza swojego kąta, ale `search`/`list` i tak oddawały mu ścieżki
i excerpty z całego obszaru rodzica.

- Wspólny predykat `AccessGuard._isInSubScope(path, scopeFolders)` obsługuje teraz oba
  wejścia: pojedyncze `checkAccess` i hurtowe `filterResults`. Ta sama semantyka —
  koniunkcja z regułami rodzica, `.pkm-assistant/**` poza zasięgiem, `admin_access`
  NIE zwalnia (fail-closed, sprawdzenie idzie przed skrótem admina).
- Wołacz: `MCPClient.executeToolCall` krok 7 (post-filtr `list`/`search`, scope=vault).
- Brak / pusta lista `scopeFolders` = zachowanie identyczne jak dotąd.

## K11 update (2026-08-22) — przecięcie zakresów suba i whitelisty dziecka

- **`AccessGuard.intersectScopeFolders(caller, child)` (NOWE, publiczne).** Reguła „zakres
  dziecka delegacji nie może być szerszy niż zakres tego, kto je zleca" mieszka tam, gdzie
  reszta reguł ścieżek. Z pary wpisów zostaje **węższy** (dopasowanie liczone tym samym
  `_matchesEntry`, którym chodzi bramka `scope.folders`). Kontrakt zwrotki jest trzystanowy:
  `null` = żadna strona nie zawęża, niepusta lista = przecięcie, **pusta lista = zakresy
  ROZŁĄCZNE** i wołacz ma odmówić fail-closed (`DelegateTool` odmawia delegacji). Konsument:
  `modules/tools/DelegateTool` — patrz AUD-security-008.

## K11 update (2026-08-22) — `web.read` jako osobna akcja

- **`ACTION_PERMISSIONS` ma `web.read` obok `web.search`**, a `APPROVAL_DEFAULTS` — klucz
  `web_read: true` (domyślnie PYTAJ). `_getApprovalToggleKey('web_read')` oddaje `'web_read'`,
  nie `'web_search'`. Powód: `web_read` to jedyne narzędzie, które wyprowadza na sieć adres
  WYBRANY PRZEZ MODEL, a dzieliło przełącznik z wyszukiwarką — jedno odklikanie „Wyszukiwanie
  w internecie" zdejmowało pytanie z obu. Typ uprawnienia zostaje wspólny (`WEB_SEARCH`), bo
  po E2.8 C1 i tak nie bramkuje. Reguły „Zawsze zezwalaj" zapadają osobno per akcja, więc stara
  zgoda na `web.search::…` nie otwiera `web.read`.

## K3-E update (2026-08-23) - `SettingsStore.scheduleSave` łapie pad zapisu

- ⚠️ **Callback debounce'u woła `save()` przez `void … .catch(log.error)`.** `save()` jest ASYNC,
  a timer nie ma komu oddać odrzucenia: pad zapisu (dysk sieciowy, pełny dysk, plik zajęty)
  wychodził jako unhandled rejection i nikt się o nim nie dowiadywał. **Nie wołaj tu `save()`
  gołym wywołaniem** - to druga, cicha droga tej samej klasy co handlery Ustawień
  (AUD-bledy-028). Testy: `core/utils/SettingsManager.test.ts`.
