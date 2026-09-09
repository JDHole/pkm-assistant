# core/

**Fundament pluginu.** Wszystko co KAŻDY moduł potrzebuje żeby w ogóle wystartować: klasa pluginu, runtime, tryby pracy, security, i18n, utilities.

Jak moduł = pojedyncza funkcjonalność (memory, chat, mcp…), to `core/` jest podłogą na której te moduły stoją. Nie ma tu żadnej "feature" - sama infrastruktura.

---

## Threat model

Pełny opis jest w [`core/SECURITY.md`](SECURITY.md). Skrót dla agenta:

- **Spoofing:** agent/tool nie może udawać innego kontekstu uprawnień; publiczne wejścia przechodzą przez jawny mapping akcji.
- **Tampering:** vault path idzie przez `sanitizePath`, `isProtectedPath`, `AccessGuard` i approval flow zanim dotknie pliku.
- **Repudiation:** `ApprovalManager` zapisuje decyzje i always-approved rules, żeby user widział co jest zapamiętane.
- **Information disclosure:** `SensitiveDataGuard`, `SecretsStorage` i `Logger` maskują albo chowają API keys.
- **Denial of service / Elevation of privilege:** MCP ma timeouts, unknown actions fail-closed, a tryb autonomii `yolo` znosi tylko pytania - nie omija No-Go, protected paths, whitelisty ani uprawnień agenta.

---

## Kryterium wstępu

Do `core/` trafia TYLKO plik który spełnia **wszystkie 3 warunki**:

1. **Używany przez ≥3 moduły** (1-2 → idzie do modułu który go najbardziej używa)
2. **Nie jest samodzielną funkcjonalnością** (to infrastruktura, nie feature)
3. **Zmienia się rzadko** (zmiana `core/` dotyka wszystkich modułów = self-enforcing brake na pokusę ciągłego dolewania)

Jak coś nie spełnia - idzie do odpowiedniego `modules/<nazwa>/`.

---

## Publiczne API - `core/index.js`

Poza `core/` wolno importować TYLKO z `core/index.js` (zasada jedynych drzwi, tak jak dla każdego modułu). Bebechy `core/utils/…` / `core/security/…` - prywatne. Pilnuje tego ESLint (`no-restricted-imports` na `modules/**`, `src/**`, `config/**`, `utils/**`), nie sama konwencja.

### Barrel jest NODE-SAFE

`core/index.js` musi wstawać w Node bez Obsidiana. Cały `core/` jest w TypeScripcie (pliki `.ts`, specifiery importów kończą się na `.js` i wskazują fizyczne pliki `.ts`), więc goły `node --input-type=module` nie wystarcza: strippuje typy, ale nie podmienia `.js`→`.ts` w specifierach. Sprawdzianem node-safe jest `npm test` (AVA biegnie przez tsx, bez mocka `obsidian`) albo ręcznie:

```bash
node --import=tsx --input-type=module -e "await import('./core/index.js').then(()=>console.log('OK'))"
```

Powód: AVA nie ma mocka `obsidian` (`"ava".require: []`), a testuje pliki produkcyjne, które importują ten barrel. Wciągnięcie `obsidian` do barrela wywala pół zestawu testów. **Dlatego cztery obsidianowe pliki core NIE są eksportowane z barrela** - `PluginBase.js`, `runtime/PluginRuntime.js`, `utils/obsidianNav.js`, `security/MasterPasswordModal.js`. Deep-importuje je wyłącznie `src/main.js` jako **composition root** (ma na to per-file wyjątek w `eslint.config.js`). Konsekwencja: `SettingsContent.js` ładuje `MasterPasswordModal` leniwie (`await import(...)` w handlerze), bo wisi na barrelu przez `registerSettings`.

**Oficjalne wyjątki deep-importu (globalne narzędzia, wolno wszędzie):** `core/i18n/index.js` i `core/utils/Logger.js` - wyłącznie te dwa, reszta idzie przez barrel.

**Entry point:** ⛔ `PluginBase`, `runtime/PluginRuntime` - **NIE przez barrel** (obsidian), tylko deep z `src/main.js`

**Autonomia:** `AUTONOMY_MODES`, `DEFAULT_AUTONOMY`, `normalizeAutonomy`, `classifyToolRisk` (z `security/autonomy.js`). Autonomia = własność CZATU (czy PYTAĆ), niezależna od uprawnień (co WOLNO). Narzędzia = uprawnienia agenta, nie osobny "tryb pracy".

**Security:**
- `AccessGuard` - sanityzacja ścieżek, No-Go zones, focusFolders, whitelist
- `PermissionSystem`, `APPROVAL_DEFAULTS`
- `ApprovalManager` - modal do zatwierdzania akcji, "always approve" rules
- `SecretsStorage` - sejf na klucze API
- `sanitizePath`, `isProtectedPath`, `VAULT_GITIGNORE_ENTRIES`
- `maskSensitiveData`, `warnIfSensitive`
- `expandFocusEntries` - grupy folderów vaulta; konsument: `modules/prompts/PromptBuilder.js`
- `globPatternToRegex` - konwersja glob→regex, jedyny żywy wołacz `AccessGuard`
- `fenceUntrusted` - jedno ogrodzenie niezaufanej treści w system prompcie dla wszystkich kanałów
- `HUMAN_MESSAGE_META`, `MACHINE_MESSAGE_META`, `machineMeta`, `resolveMessageOrigin`, `isHumanMessage` (`security/messageOrigin.js`) - proweniencja wiadomości czatu

**i18n:** `t`, `setLocale`, `getLocale`, `getDateLocale`

**Utils:**
- `log` - centralny logger (debug/info/warn/error/tool/model/timing)
- `resolveWorkPrompt`, `WORK_PROMPT_KEYS` - resolver promptów roboczych agent>global>factory (pure, node-safe)
- `normalizeError` - normalizacja błędów API modeli do `{message, code, details, http_status}`. Pure, zero importów; 5 adapterów w `modules/models/` bierze go z barrela. Nie mylić z celowo odrębną wersją w `modules/embedding/embed_adapter_base.js`.
- `toolResultStatus`, `shouldLinkWrittenFile` - jedna reguła "co jest porażką narzędzia", czytana przez tools, chat i sub-agents
- `ensureAdapterFolder` - adapterowy `mkdir -p` po segmentach ścieżki. Pure, duck-typuje adapter `{exists, mkdir}` (brak metod = no-op). Wariant **app-aware** (Vault API dla zwykłych ścieżek, adapter dla dot-folderów) zostaje osobno w `modules/tools/vault_binary_io.js`.
- `probeFile` - "czy plik jest?" w trzech stanach (`'exists'|'missing'|'unknown'`), bo `exists()` kłamie na dyskach sieciowych (gotcha "boot nie pisze ustawień" niżej)
- `readIfExists` - odczyt-najpierw WŁASNEGO pliku przed dopisaniem nowego wpisu; siostrzana wada `probeFile`
- `migrateOldPluginFolder` - migrator plikowy, czysty/node-safe
- `registerSettings` (`SettingsSection.js`) - rejestracja sekcji ustawień core
- `parseYaml`, `stringifyYaml`, `parseFrontmatter`, `validateAgentSchema`, `setYamlEngine` + typ `YamlEngine` - silnik YAML wstrzykiwany (patrz sekcja "Zależności" niżej)
- `slugify`, `getAgentSafeName` (slug tożsamości agenta, format zamrożony, jeden wspólny helper zamiast wielu kopii), `countTokens`, `countTokensSimple`, `getTokenCount`, `calibrate` (lekki estymator tokenów, bez zależności zewnętrznych)
- `EventEmitter`, `StreamWatchdog`, `TraceLog`, `LogFileSink`
- `TokenTracker` - licznik tokenów per rola. Test obok pliku (`utils/TokenTracker.test.js`).
- `arrayBufferToBase64`, `blobToBase64`
- Transport HTTP (`core/http/`): `ObsidianHttpClient`, `FetchHttpClient`, `FetchStreamTransport`, `SseFrames`, `NdjsonFrames`, `STREAM_TRANSPORT_TIMEOUT_MS` - **w barrelu**, bo korzystają z niego DWA moduły (`models` i `embedding`), a moduł nie sięga po bebechy drugiego modułu. `ObsidianHttpClient` dostaje `requestUrl` KONSTRUKTOREM, więc cały ten transport wstaje w gołym Node (harness podstawia własny router).
- ⛔ Nawigacja obsidianowa (`openNote`, `openSource` - `core/utils/obsidianNav.ts`) - **poza barrelem** (plik wciąga `obsidian`). Jedyny konsument, `src/main.ts`, deep-importuje ją jako composition root.

**Silnik ustawień + zdarzeń (własny, w całości):** `SettingsStore` (`core/runtime/SettingsStore.ts` - worek ustawień: `settings` przez proxy, `raw` bez proxy, `save()`, `scheduleSave()` z debounce, `onChange()`) + `EventEmitter` (`core/utils/EventEmitter.ts` - on/once/off/emit). Scalanie konfiguracji (`deepMergeMissing`, `cloneConfig`, `isPlainObject`) mieszka wewnątrz `core/runtime/configMerge.ts` i NIE wychodzi na barrel - konsument jest jeden (runtime).

---

## Struktura fizyczna

```
core/
├── index.js                    ← jedyne drzwi publiczne (barrel)
├── CLAUDE.md                   ← ten plik
├── SettingsContent.js          ← render No-Go / Zaawansowane / Klucze API / Informacje
├── SettingsSection.js          ← rejestracja sekcji core w SettingsRegistry
├── PluginBase.js               ← klasa główna (extends Obsidian.Plugin); poza barrelem
├── runtime/                    ← podłoga runtime'u
│   ├── contracts.js            ← JEDYNE źródło nazw i sygnatur runtime'u
│   ├── PluginRuntime.js        ← cykl życia: boot / whenLoaded / reload / dispose
│   ├── SettingsStore.js        ← worek ustawień: `settings` (proxy) vs `raw`
│   ├── settingsArmor.js        ← pancerz + `readUiLanguage` (NIGDY `exists()`)
│   ├── legacySettingsMigration.js ← KWARANTANNA starych nazw kluczy (migrator ustawień z poprzedniej wersji namespace'u)
│   ├── NoticeCenter.js         ← powiadomienia (wyciszanie per id, guziki akcji)
│   ├── StatusBar.js            ← pasek statusu
│   └── configMerge.js          ← deepMergeMissing / cloneConfig / isPlainObject
├── http/                       ← transport HTTP wspólny dla models i embedding
│   ├── contracts.js            ← HttpClient / StreamTransport / FrameParser
│   ├── ObsidianHttpClient.js   ← `requestUrl` WSTRZYKIWANY konstruktorem (node-safe)
│   ├── FetchHttpClient.js · FetchStreamTransport.js
│   └── SseFrames.js · NdjsonFrames.js
├── ui/safeHtml.js              ← fragmentFromHtml (sanityzacja) + clearElement
├── layoutReady.js               ← czysta `waitForLayoutReady(workspace?)` (zero importów, node-safe); woła ją `PluginRuntime.boot()`
├── waitForLoaded.js              ← czysta `waitForLoaded(getEnv, pollMs?)` (zero importów, node-safe); woła ją `PluginRuntime.whenLoaded()`
├── layoutReady.test.js · waitForLoaded.test.js ← behawioralne testy startu
├── security/
│   ├── AccessGuard.js          ← główny strażnik dostępu (`setVaultGroups` + rozwijanie `{group}` w focus)
│   ├── autonomy.js             ← 3 tryby autonomii (yolo/edge/all) + definicja krawędzi
│   ├── vaultGroups.js          ← pure `expandFocusEntries({group} → foldery)`; `vaultGroups.test.js` obok
│   ├── PermissionSystem.js     ← permissions model + `ACTION_PERMISSIONS` mapa + gate autonomii
│   ├── ApprovalManager.js      ← approval flow (modal + always-approved + ścieżka "przekieruj")
│   ├── SecretsStorage.js       ← sejf na klucze API (`SECRET_FIELD_PATHS`)
│   ├── SensitiveDataGuard.js   ← wykrywanie/maskowanie API keys
│   ├── SensitiveDataGuard.test.js
│   ├── keySanitizer.js         ← sanitizePath, isProtectedPath, maskKey
│   ├── keySanitizer.test.js
│   ├── messageOrigin.js        ← proweniencja wiadomości czatu (`meta.origin`: 'human' | 'machine'; brak = machine, fail-closed). Bramkuje rejestr URL dla `web_read`, markery `@@skill:` i komendy `/`. Nie mylić z `_invocationOrigin` (adres zwrotny delegacji).
│   └── messageOrigin.test.js
├── utils/
│   ├── Logger.js               ← log.debug/info/warn/error/tool/model/timing; maska na KAŻDYM poziomie argumentu (`cause`/pola błędu też); test obok
│   ├── workPromptResolver.js   ← resolveWorkPrompt (agent>global>factory) + WORK_PROMPT_KEYS; test obok
│   ├── errorUtils.js           ← normalize_error (pure, zero importów); gałąź JSON.stringify bez pól-sekretów + limit 4000 zn.; test obok
│   ├── vaultFs.js              ← ensureAdapterFolder (mkdir -p na DataAdapterze); test obok
│   ├── TokenTracker.js         ← licznik tokenów per rola; test obok
│   ├── binaryUtils.js          ← arrayBufferToBase64 / blobToBase64
│   ├── httpLogSummary.js       ← bezpieczna linia logu żądania (bez `request_params`); test obok
│   ├── obsidianNav.js          ← openNote / openSource; ⛔ importuje `obsidian`, poza barrelem
│   ├── yamlParser.js           ← parseYaml/stringifyYaml/parseFrontmatter
│   ├── slugify.js              ← filename-safe slug generator
│   ├── tokenCounter.js         ← lekki estymator tokenów + kalibracja (bez zależności)
│   ├── EventEmitter.js         ← własny emiter zdarzeń (on/once/off/emit); test obok
│   └── settingsNamespaceMigration.js ← migracja nazw przestrzeni ustawień; test obok
└── i18n/
    ├── index.js                ← t(), setLocale(), getLocale(), getDateLocale()
    ├── en.js                   ← EN translations
    └── pl.js                   ← PL translations
```

✅ **Brak monolitu >800 LOC w logice core.** Największy plik logiki to `runtime/contracts.ts` (typy). Słowniki `i18n/pl.ts` i `i18n/en.ts` to tabele tłumaczeń, nie logika - nie liczą się do tej reguły.

---

## Zależności

**`core/` importuje z:**
- `obsidian` (API pluginu, zewnętrzne)
- `../config/default_env_config.js` (config pluginu)

> `yamlParser.ts` nie importuje żadnego silnika YAML statycznie. Silnik jest wstrzykiwany przez `setYamlEngine()` (eksport barrela): composition root (`src/main.ts`) wstawia wbudowany `parseYaml`/`stringifyYaml` z modułu `obsidian`, testy AVA i harness wstawiają pakiet `yaml` (devDependency) przez preload/atrapę. Patrz nagłówek `core/utils/yamlParser.ts`.

**`core/` NIE importuje z żadnego modułu** - poza dwoma udokumentowanymi wyjątkami, oba **przez barrel** (`index.js`), nigdy w bebechy:
1. `security/ApprovalManager.js` → `modules/shell/index.js` (modal approvalu),
2. `PKMEnv.js` → `modules/memory/index.js` - pasek statusu ma drugi kanał ("Puls pamięci": `memoryOpsCenter`, `OPS_EVENT`, `statusBarLine`). Bezpieczne, bo `modules/memory` nie importuje ani `obsidian`, ani `core/index.js` - nie ma jak zrobić cyklu. Wersja przez `modules/shell` byłaby cyklem (shell → chat → core).

Reguła bez zmian dla nowego kodu: core jest u podłogi, moduły stoją na nim.

**Kto importuje z `core/`:** wszystko inne w `modules/` i `src/`.

---

## Gotchas (miny)

### 1. Dependency injection obowiązuje

`log`, `AccessGuard`, `PermissionSystem` to singletony (lub quasi-singletony). Nie instancjonuj ich ponownie w modułach. Importuj z `core/index.js` i używaj tego samego obiektu.

### 2. Kolejność ładowania i18n

`t()` czyta aktualny język z `setLocale()`. Trzeba wywołać `setLocale('pl')` albo `setLocale('en')` ZANIM cokolwiek innego wywoła `t()`. W `main.js` dzieje się to w `onload()` - nie ruszaj kolejności.

### 3. Autonomia to nie uprawnienie

`security/autonomy.js` trzyma 3 tryby autonomii (`yolo`/`edge`/`all`) - polityka CZATU "czy pytać", NIE uprawnienie agenta. `PermissionSystem.requiresApproval` bierze tryb i decyduje o pytaniu; `checkPermission` egzekwuje No-Go/protected/whitelistę/uprawnienia **przed** bramką approvalu, więc `yolo` znosi tylko pytania. Definicja krawędzi jest **fail-closed**: bezpieczne są tylko `read_notes` i `thinking`, każde inne (także przyszłe) uprawnienie = krawędź (pyta w `edge`).

### 4. Kanonizacja ścieżek - jedna forma dla bramki i dla zlewu

KAŻDY MCP tool który dotyka vault (`VaultReadTool`, `VaultWriteTool`, etc.) ma wzór: `sanitizePath(path)` → `isProtectedPath(path)` → `AccessGuard` → operacja. Nie wolno przestawić kolejności - `sanitizePath` dekoduje `%2e%2e` i zero-width unicode, i jak tego nie zrobisz PIERWSZE, reszta guardów da się oszukać.

**Bramka i zlew oglądają JEDEN ciąg.** `sanitizePath` zwraca dziś FORMĘ KANONICZNĄ (bez `./`, `..`, wiodącego/końcowego `/`, `\`, `%XX`). Kanonizacja dzieje się **raz, u wołacza** - `MCPClient._extractToolContext` sprowadza ścieżkę do postaci kanonicznej i **podmienia ją w argumentach**, więc `execute` dostaje dokładnie to, co oceniła bramka. `PermissionSystem.checkPermission` powtarza to jako obrona w głąb (wołaczy jest więcej niż jeden); ścieżka nie do uratowania = `Invalid path`, fail-closed, bez pytania usera. `AccessGuard._normalizeForCompare` trzyma wpisy No-Go i cel w tej samej lekkiej normalizacji. **Nie dokładaj własnej normalizacji w narzędziach** - druga warstwa "poprawek" to znowu dwa różne ciągi.

**Obrona w głąb obejmuje `vault.*` ORAZ `image.*`.** `generate_image` oddaje bramce FOLDER ZAPISU, a `add_text_to_image` CEL ZAPISU (`output_path` albo WYLICZONE `<źródło>_text.<ext>`). Cel wyliczany nie jest dosłownie wartością żadnego pola argumentów, więc kanonizacja u wołacza go pomija - bramka jest dla niego JEDYNĄ warstwą. **Dokładasz akcję dotykającą pliku → sprawdź, czy łapie ją ten warunek**, inaczej ta sama ścieżka może dostać dwie różne decyzje w zależności od akcji, która ją niesie.

**Kanonizacja jest liczona do PUNKTU STAŁEGO, warstwy są trzy.** Jeden przebieg kanonizacji nie jest z natury idempotentny: `trim()` na całym ciągu i `decodeURIComponent` zdejmujący jedną warstwę kodowania mogłyby oddać inny tekst przy drugim przebiegu (`'./ A/B.md'` → `' A/B.md'` → `'A/B.md'`; `'a%252e%252e/x'` → `'a%2e%2e/x'` → `'a../x'`) - a to łamie kontrakt "jeden ciąg dla bramki i zlewu": wołacz podmienia w argumentach formę po JEDNYM przebiegu, bramka mogłaby ocenić formę po DWÓCH, i user w oknie zgody widziałby inną ścieżkę niż tę, którą faktycznie oceniła bramka. Dziś `sanitizePath` iteruje aż wynik przestanie się zmieniać (maks. 5 przebiegów, potem `null` - fail-closed), więc `sanitizePath(sanitizePath(x)) === sanitizePath(x)` Z KONSTRUKCJI. Semantyka: `'%252e%252e/x'` → `null` (nie przechodzi jako plik `%2e%2e`), `'a%252e%252e/x'` → `'a../x'` (segment `a..` to legalna nazwa, nie traversal).

Dzięki temu **`AccessGuard.checkAccess` kanonizuje cel SAM, na wejściu** (przed barierą suba), a cel bez formy kanonicznej odbija się jako `Invalid path`. Trzecia warstwa "poprawek" nie może już oddać innego ciągu.

**`*` nie jest nazwą pliku.** `sanitizePath` odrzuca ścieżkę z gwiazdką (`'*'`, `'Notes/*.md'`, także zakodowaną `'%2A'`): to w tym kodzie znak STERUJĄCY - `AccessGuard._matchesEntry` czyta go jako globa whitelisty, a klucz reguły "Zawsze zezwalaj" jako "dowolny cel". Cel od modelu ma znaczyć JEDEN plik. Windows i Obsidian i tak zabraniają `*` w nazwach. ⚠️ Świadomie **wyłącznie** `*`: `?`, `[`, `]`, `%` nie mają tu znaczenia sterującego, a w tytułach notatek ("Czy to działa?.md") są pospolite na macOS i Linuksie - odrzucanie ich byłoby regresją, nie obroną.

Ma to znaczenie, bo granica `.pkm-assistant/` w strażniku stoi na `startsWith`: jedno wiodące `./` wystarczało, żeby ją minąć, gdy wołacz zapomniał skanonizować. **Wyjątek:** `opts.targetIsVaultPath: false` - `PermissionSystem` podaje je dla akcji nie-vaultowych (`web.search`, `web.read`, `agent.message`, `delegate`, `external.call`), których "cel" to zapytanie, adres albo adresat. Przepuszczenie ich przez `sanitizePath` odrzuciłoby frazę zaczynającą się od `C:\...`, adres z długim query (segment > 255 znaków) albo zapytanie mieszające alfabety - agent straciłby wyszukiwarkę. Kontraktu pilnują `core/security/path_canonical.test.ts` i `core/security/path_canonical_image.test.ts`.

**Whitelista folderów mierzy WYŁĄCZNIE cele-ścieżki.** No-Go, pliki chronione, whitelista `focusFolders` i bariera `scope.folders` suba muszą mierzyć wyłącznie ścieżki, nigdy zapytanie do wyszukiwarki, adres strony czy adresata wiadomości - inaczej agent w trybie "Tylko przypisane" (`guidance_mode:false`) z whitelistą `['A/']` traciłby wyszukiwarkę, pobieranie stron, pocztę i delegację W CAŁOŚCI (odmowa "poza obszarem roboczym agenta"). `AccessGuard.checkAccess` przy `targetIsVaultPath === false` wraca NATYCHMIAST z `{ allowed: true, reason: 'non-vault-target' }`, przed każdą bramką ścieżkową. `PermissionSystem` nie zmienia przez to niczego dalej - ryzyko, zgody i `disabled_tools` bramkują te akcje jak dotąd, a ich realne granice pilnują właściwe im warstwy: rejestr znanych adresów + zgoda usera (`web.*`), widoczność adresata i limity skrzynki (`agent.message`), przecięcie zakresów + głębokość z runtime (`delegate`), RED + opt-in serwera (`external.call`). Domyślka `targetIsVaultPath: true` zostaje (fail-closed dla nowych wołaczy); strażnik: `core/security/non_vault_targets.test.ts`.

**ZAKAZ składa litery, ZEZWOLENIE nie.** Jedna reguła, dwa kierunki:

| bramka | co robi | wielkość liter | dlaczego |
|---|---|---|---|
| No-Go, `SYSTEM_NO_GO`, `isProtectedPath` | ZAKAZUJE | **składa** (`toLowerCase`) | ma łapać za dużo, nie za mało |
| whitelista `focusFolders`, `scope.folders` suba | ZEZWALA | **rozróżnia** | ma wpuszczać za mało, nie za dużo |

Na Windows i macOS system plików wielkości liter NIE rozróżnia - porównanie bajt w bajt przepuszczałoby `Projekty/prywatne/tajne.md` na zielono, choć `Projekty/Prywatne/tajne.md` byłby odrzucany, a to JEDEN I TEN SAM PLIK; tak samo dla `.Obsidian/workspace.json` i `.TRASH/x.md` wobec `SYSTEM_NO_GO`. Normalizacja zakazu mieszka w `AccessGuard._normalizeForDenyCompare` (`\`→`/`, `NFC`, `toLowerCase`, puste segmenty i `.` won) i jest wołana z `_isNoGo` ORAZ z `setNoGoFolders` - wpisy lądują w `_noGoFolders` złożone, więc `Prywatne/` i `prywatne` to jeden wpis. `_normalizeForCompare` zostaje jako czysta normalizacja KSZTAŁTU (baza tamtej, bez ruszania liter).

**Cena, świadomie zaakceptowana:** na vaultcie naprawdę case-sensitive (Linux) zakaz obejmie też "sąsiada" różniącego się literą - `prywatne/` obok zakazanego `Prywatne/` przestanie być dostępny. Lepiej zakazać za dużo niż wypuścić plik, który miał być zakazany.

**Dokładasz bramkę ZAKAZU dotyczącą ścieżek → składaj litery.** Ta sama reguła obowiązuje poza `core/`: wykluczenia indeksu semantycznego (`modules/embedding/VaultIndexer._isExcluded`) liczą ją u siebie lokalnie, bo indekser trzyma zero zależności od `core/`. Strażnik: `core/security/nogo_case.test.ts`.

### 4b. Maska sekretów ma DWA filtry: kształt i NAZWĘ pola

`maskSensitiveData` maskuje nie tylko znane prefiksy kluczy (`sk-`, `gsk_`, `xai-`, `AIza`…), ale też **wartość pola o wrażliwej nazwie** (`Authorization`, `api_key`, `apiKey`, `x-api-key`, `*_key`, `token`, `secret`, `password`) - w JSON-ie, w nagłówku i w gołym tekście. Filtr po kształcie zawsze będzie spóźniony o kolejnego dostawcę; filtr po nazwie łapie także tych, których nie znamy. Próg 8 znaków chroni zwykły tekst notatek (`RetrievalEngine` też przepuszcza snippety przez maskę). Nie loguj obiektów żądań w całości - `core/utils/http_request.ts` wypisuje jedną linię z `httpLogSummary.ts` (metoda, adres bez query, status, czas, NAZWY nagłówków), a nie `JSON.stringify(request_params)`.

### 4c. Klucz API nie ma prawa wejść do `message` - trzy warstwy

Obiekt błędu potrafi wpaść jako TEKST do pola `message`, a to pole przechodzi przez `JSON.stringify` w Loggerze - wtedy nazwa nagłówka jest zaescapowana (`\"api-key\":\"…\"`) i filtr po nazwie pola się nie dopasuje, jeśli patrzy tylko na strukturę obiektu. Klucz mógłby wtedy wylądować jawny w `.pkm-assistant/logs/pkm-assistant.log` i w komunikacie na ekranie usera. Naprawa stoi na trzech niezależnych warstwach - **każda musi zostać**:

1. **Źródło (`modules/models/adapters/chat_adapter_base.ts`).** Zdarzenie streamera nie niesie streamera. `event.source` to sam OPIS (`{url, method, readyState}`), bez `headers` i bez ciała rozmowy, a słuchacz błędu podaje do `normalize_error` wyłącznie bezpieczny wycinek - nigdy całe zdarzenie. Szczegóły w `modules/models/CLAUDE.md`.
2. **`core/utils/errorUtils.ts`.** Gałąź `JSON.stringify` budująca `message` wycina pola, które z definicji niosą kontekst żądania (`SECRET_BEARING_FIELDS`: `headers`, `source`, `request`, `request_params`, `xhr`, `config`, `options`), radzi sobie z cyklami i tnie wynik do 4000 znaków. Plik ZOSTAJE czysty (zero importów) - filtr jest po nazwie pola, bez maski. ⚠️ `details` celowo zostaje surowym obiektem: to kontrakt adapterów wielu platform, a obiekt i tak idzie do logu przez maskę.
3. **`core/security/SensitiveDataGuard.ts`.** Trzeci przebieg `ESCAPED_FIELD_RE` łapie tę samą parę `pole: wartość` w JSON-ie zaescapowanym raz albo dwa razy. Świadomie OSOBNY regex, nie rozluźnienie dwóch poprzednich. Przed przebiegiem stoi tani pre-check (`\"` w tekście), więc gorąca ścieżka logu nic nie traci. Maska jest idempotentna (maska maski = maska) także w tej formie.

Do kompletu `core/utils/Logger.ts` przepuszcza przez maskę KAŻDY poziom argumentu: klon `Error` zabiera ze sobą `cause` (ES2022) i pola doklejone przez adaptery (`response`, `data`, `details`) - zamaskowane, zamiast po cichu znikać. Rekurencja ma limit głębokości (`MASK_MAX_DEPTH`), a `.map()` woła maskę przez lambdę: goły `.map(maskLogValue)` podawałby INDEKS tablicy jako głębokość.

**Dokładasz nowe pole niosące transport (klient HTTP, socket, kolejka)?** Dopisz jego nazwę do `SECRET_BEARING_FIELDS` - inaczej pierwszy błąd bez ciała odpowiedzi powtórzy tę samą drogę.

### 4d. Brak celu to ODMOWA, nie przepustka

Wszystkie bramki w `checkPermission` (No-Go, pliki chronione, whitelista `focusFolders`, `scope.folders` suba) stoją za `if (targetPath)`. Akcja z pustym celem przeskakiwałaby je wszystkie - tak `artifact_*` mogłyby pisać do vaulta bez ani jednego strażnika. Zestaw `TARGET_REQUIRED_ACTIONS` (`vault.write/create/create_folder/delete`, `artifact.create/update/read`, `image.generate`) wymaga celu i odmawia fail-closed; `admin_access` NIE zwalnia. `vault.read` jest poza zestawem **świadomie**: tą samą akcją chodzą `ask_user`, `todo`, `kom_list`/`kom_read` i `scope:'memory'`, które celu nie mają z definicji (root listingu to `'/'`). **Dodajesz akcję, która dotyka pliku → dopisz ją do zestawu**, inaczej pierwsze narzędzie bez pola `path` powtórzy tę samą lukę.

W `ApprovalManager` "brak celu" ma własny token (`akcja::<bez-celu>`) i nie zapada w wieloznacznik `akcja::*` - jedno kliknięcie "Zawsze zezwalaj" na akcji bez ścieżki nie otwiera wszystkich przyszłych zapisów agenta.

**Cel od WOŁACZA nigdy nie jest wieloznacznikiem.** Dosłowna gwiazdka z argumentu pisanego przez model (`delete {path:"*"}`, `kom_send {to:"*"}`) nie ma prawa zapisać się jako trwała reguła `akcja::*`. `createPatternKey` przepuszcza cel przez `literalTarget()`: podwaja `<` (żeby cel nie udawał tokenów `<bez-celu>` / `<gwiazdka>`) i zamienia każdą gwiazdkę na `<gwiazdka>`. **`akcja::*` nie ma jak powstać z celu podanego przez wołacza** - a innej drogi zapisu reguły nie ma, bo ekran reguł (Ustawienia → Bezpieczeństwo → "Approved actions") tylko listuje i kasuje. Gałąź wieloznaczna w `isAlwaysApproved` ZOSTAJE dla reguł zastanych z ustawień usera sprzed tej naprawy (nie kasujemy po cichu cudzych decyzji), a `loadApprovals` zgłasza je jednym `log.warn` z listą.

**Dokładasz JAWNĄ drogę "zezwalaj na wszystko"?** Ma prowadzić z ekranu reguł, nigdy z modala - modal opisuje JEDNO konkretne wywołanie i user ocenia właśnie je.

Druga warstwa: `sanitizePath` odrzuca `*` w ścieżce (gotcha #4 wyżej), więc `path:"*"` nie dochodzi nawet do okna zgody. Ale to TYLKO warstwa - cele nie-vaultowe (`web.*`, `agent.message`) przez `sanitizePath` nie idą, naprawa siedzi w `ApprovalManager`. Strażnicy: `ApprovalManager.test.ts` + `keySanitizer.test.ts`.

### 5. `SensitiveDataGuard.lastIndex`

`maskSensitiveData()` używa regex globalnego (`/.../g`). Regexy globalne w JS trzymają stan `lastIndex` między wywołaniami - jak nie zresetujesz, drugie wywołanie na tym samym tekście zwróci `null`. Wewnątrz funkcji jest reset, ale jeśli wyciągasz regex gdzie indziej - pamiętaj.

### 6. `Logger` jest blisko-bezszumny gdy `debugMode=false`

Domyślnie tylko `warn`/`error` lecą do konsoli. Jak chcesz zobaczyć `log.debug()` / `log.tool()` / `log.model()` - włącz `pkmAssistant.debugMode` w settings. To nie bug, to by default silent.

### 6a. Sink plikowy Loggera zamyka się przez `log.disposeFileSink()`

`initFileSink()` (z `src/main.ts`) trzyma prywatny `LogFileSink` na `.pkm-assistant/logs/pkm-assistant.log`, a hot-path tylko buforuje i planuje flush (debounce 1000 ms). `disposeFileSink()` (flush + dispose + wyzerowanie, fail-soft) leci **na samym końcu `onunload`** - kroki wyżej jeszcze logują, więc nie przestawiaj go wyżej. To OSOBNY obiekt niż `plugin.traceLog`.

### 6b. Boot NIE PISZE ustawień - provisioning idzie do SUROWEGO worka

`env.settings` to **obserwowane proxy** (`SettingsStore`): każda mutacja planuje zapis CAŁEGO pliku `.pkm-assistant/settings.json` (debounce ~1 s) - a tam mieszkają klucze API. Gdyby `load_settings` kiedykolwiek zdegradował się do defaultów (dysk sieciowy potrafi skłamać o istnieniu pliku), taki bootowy zapis utrwaliłby defaulty i skasował plik usera.

**Reguła:** stan, który nie jest decyzją usera (dosztukowanie pustych kontenerów, migracje w RAM, klucze efemeryczne), zapisuj w `env.settingsStore.raw` - SUROWYM worku z pominięciem proxy. Na dysk trafi przy pierwszym REALNYM zapisie. Wzorce w `load()` i `init_collections`. Domknięci pisarze bootowi: bezwarunkowy `save()` w `load`, migracja `modelLibrary`, provisioning defaultów/kolekcji, `pkmAssistant.security` dla `ApprovalManager` (`src/main.ts`), wyciszenia powiadomień (`pkmAssistant.notices.muted`, `core/runtime/NoticeCenter.ts`) oraz domyślny model embeddingu (`modules/embedding/`).

**Ta sama lekcja dla PLIKÓW: `probeFile` (`core/utils/vaultFs.ts`, eksport z barrela).** `adapter.exists()` odpowiada boolem, więc wołacz MUSI wybrać jedną z dwóch odpowiedzi - a jedno skłamane `false` mogłoby nadpisać `brain.md` / plik sesji / `.state.json` domyślną treścią. `probeFile(adapter, path)` daje `'exists' | 'missing' | 'unknown'` (`false` potwierdzane próbą `read`). Piszemy WYŁĄCZNIE na `'missing'`; `'unknown'` jest fail-closed. Wołaj to na ścieżkach zapisu, nie w pętlach listujących (kosztuje jeden `read`).

⚠️ `PKMNotices.settings` **prowizjonuje w worku, ale zwraca gałąź Z PROXY** - wyciszenie notice'a przez usera (`settings.muted[id] = true`) to prawdziwa decyzja i MA planować zapis. Ta sama zasada dotyczy każdego podobnego gettera: nie kasuj obserwowania, przenieś sam provisioning.

Strażnik: scenariusz harnessa `boot_nie_pisze` (zdrowy `settings.json` przeżywa boot co do bajta, `settingsManager.save_timeout` nie wisi po turze).

### 6c. Sekwencja startu: ZDARZENIA, nie zegary

Ścieżka bootu wygląda tak i ma tak zostać:

```
src/main.ts onload()
  ├─ app.workspace.onLayoutReady(initialize)   ← initialize czeka na env: wait_for({loaded:true}), poll 100 ms
  ├─ PluginRuntime.create()
  │     └─ setTimeout(…, env_start_wait_time = 0)   ← debounce jednej tury, nie okno czekania
  │           └─ PluginRuntime.load()
  │                 ├─ gałąź mobile-defer (bez zmian)
  │                 ├─ await wait_for_layout_ready()      ← ZDARZENIE workspace.onLayoutReady
  │                 ├─ register_status_bar()
  │                 ├─ fs.load_files() + settings.json + init_collections()   ← cały realny I/O
  │                 ├─ await ready_to_load_collections()  ← JUŻ TYLKO wait_for_obsidian_sync()
  │                 ├─ await load_collections()
  │                 └─ state = 'loaded'
  └─ await read_ui_language() → setLocale() → register_commands() + register_ribbon_icons()
        ↑ JEDYNY `await` w `onload()` - odczyt jednego pola z `.pkm-assistant/settings.json`.
          Komendy i wstążka NIE MOGĄ zależeć od bootu env (pad `PluginRuntime.load()` = zero
          komend u usera), ale język musi być znany przed `addCommand` - Obsidian zapamiętuje
          nazwę w chwili rejestracji. `initialize()` woła `setLocale()` powtórnie, już z pełnych
          ustawień.
```

Start jest lekki: żadnego stałego opóźnienia startowego, żadnego ślepego snu przed ładowaniem danych - każdy krok czeka na konkretne zdarzenie (layout ready, sync Obsidiana jeśli jest aktywny), nie na zegar.

⚠️ **Gotcha:** jeśli ktoś kiedyś doda kolekcję z `process_load_queue`, która potrzebuje gotowego indeksu Obsidiana - **ta kolekcja ma zadbać o własną gotowość** (np. `metadataCache.on('resolved')`), a nie przywracać tu zegar. Start jest sprawdzany behawioralnie (`core/layoutReady.test.ts`, `core/waitForLoaded.test.ts`), nie regexem po źródle.

`PluginRuntime.whenLoaded()` (wołacz drugiej strony - `initialize()` na starcie ORAZ zakładka Ustawień przy KAŻDYM otwarciu) sprawdza stan NATYCHMIAST, a jak nie jest gotowy - rozwiązuje się na zdarzenie `'loaded'` (emitowane przez `boot()` zaraz po `state = 'loaded'`), z siatką 250 ms jako czystą asekuracją (re-oceniana na każdym ticku - łapie też env powstały PO wywołaniu i podmianę instancji przy `reload()`). Logika mieszka w czystym `core/waitForLoaded.ts` (testowalne bez mocka `obsidian`), `whenLoaded()` jest cienką otoczką.

⚠️ **`'unloading'` (emitowane przez `dispose()`) nie tylko kasuje siatkę - PORZUCA oczekujący `whenLoaded` na zawsze: zwrócona promise już się NIE rozwiąże**, nawet jeśli env później zostanie załadowany ponownie. Celowo: po demontażu (`restart_plugin`) nie ma na co dalej czekać - kontynuacja byłaby zombie-`initialize()` na cudzym, kolejnym środowisku. Wołacz, który naprawdę potrzebuje gotowego env po restarcie, ma wywołać `whenLoaded()` PONOWNIE.

### 7. Autonomia per-agent

`Agent.default_autonomy` (`null` = użyj globalnego `settings.pkmAssistant.defaultAutonomy`) jest punktem startowym nowej rozmowy. `chat_model._getDefaultAutonomy(agent)` czyta `agent?.default_autonomy || settings.pkmAssistant.defaultAutonomy || DEFAULT_AUTONOMY`. Autonomia to polityka CZATU (czy pytać), nie uprawnienie - per-czat override w locie działa dalej (patrz `modules/chat`).

### 8. Jedyny escape hatch chronionych ścieżek to `agent.admin_access === true`

`AccessGuard` i `PermissionSystem` przepuszczają wtedy No-Go, protected files, `.pkm-assistant`, `.obsidian` i `.trash`, ale wyłącznie wewnątrz vaulta. `sanitizePath` nadal odrzuca ścieżki absolutne, UNC i traversal. Admin nie włącza narzędzi i nie zmienia autonomii.

**Workspace v2:** `guidance_mode:true` = cały zwykły vault; `guidance_mode:false` + puste `focusFolders` = zero zwykłego vaulta. Jednorazowa migracja zachowująca zachowanie starych agentów żyje w `modules/agents/accessPolicy.js`.

**Światła approvalu:** `classifyToolRisk()` jest publiczne przez `core/index.js`. GREEN = odczyt/myślenie/pytanie; YELLOW = kontrolowane lub odwracalne akcje z toggle; RED = nadpisanie/kasowanie/wysyłka/zewnętrzny serwer, obowiązkowe w `edge`. Nieznane narzędzie = RED.

**`create_folder` wymaga poziomu write.** AccessGuard wylicza poziom z `ACTION_PERMISSIONS` (wewnętrzna mapa `PermissionSystem.ts`).

Pełna swoboda to przecięcie trzech osi: narzędzie włączone + `admin_access` + autonomia `yolo`. Żadna z nich sama nie zastępuje pozostałych.

### 9. Scope sub-agenta tnie też WYNIKI, nie tylko dostęp

`AccessGuard.filterResults(agent, results, pathExtractor, opts)` ma parametr `opts.scopeFolders`. Bez niego sub ze `scope.folders` nie otworzy pliku spoza swojego kąta, ale `search`/`list` i tak oddawałyby mu ścieżki i excerpty z całego obszaru rodzica - istnienie pliku i jego fragment mogłyby wyciec, nawet gdy sam plik jest nieotwieralny.

- Wspólny predykat `AccessGuard._isInSubScope(path, scopeFolders)` obsługuje oba wejścia: pojedyncze `checkAccess` i hurtowe `filterResults`. Ta sama semantyka - koniunkcja z regułami rodzica, `.pkm-assistant/**` poza zasięgiem, `admin_access` NIE zwalnia (fail-closed, sprawdzenie idzie przed skrótem admina).
- Wołacz: `MCPClient.executeToolCall` (post-filtr `list`/`search`, scope=vault).
- Brak / pusta lista `scopeFolders` = zachowanie identyczne jak dla agenta bez zawężenia.

### 10. Przecięcie zakresów suba i whitelisty dziecka delegacji

`AccessGuard.intersectScopeFolders(caller, child)` trzyma regułę "zakres dziecka delegacji nie może być szerszy niż zakres tego, kto je zleca" tam, gdzie reszta reguł ścieżek. Z pary wpisów zostaje **węższy** (dopasowanie liczone tym samym `_matchesEntry`, którym chodzi bramka `scope.folders`). Kontrakt zwrotki jest trzystanowy: `null` = żadna strona nie zawęża, niepusta lista = przecięcie, **pusta lista = zakresy ROZŁĄCZNE** i wołacz ma odmówić fail-closed (`DelegateTool` odmawia delegacji). Reguła obowiązuje też piętro niżej: gdy sub zleca dalej (`max_delegation_depth` ≥ 2), wnuk dostaje przecięcie zakresu i whitelisty z tym, co ma sub ZLECAJĄCY - nigdy z tym, co ma agent główny.

### 11. `web.read` jako osobna akcja od `web.search`

`ACTION_PERMISSIONS` ma `web.read` obok `web.search`, a `APPROVAL_DEFAULTS` - klucz `web_read: true` (domyślnie PYTAJ). `_getApprovalToggleKey('web_read')` oddaje `'web_read'`, nie `'web_search'`. Powód: `web_read` to jedyne narzędzie, które wyprowadza na sieć adres WYBRANY PRZEZ MODEL - dzielenie przełącznika z wyszukiwarką znaczyłoby, że jedno odklikanie "Wyszukiwanie w internecie" zdejmuje pytanie z obu. Typ uprawnienia zostaje wspólny (`WEB_SEARCH`), bo `checkPermission` o niego nie bramkuje (o dostępności narzędzia decyduje `disabled_tools`). Reguły "Zawsze zezwalaj" zapadają osobno per akcja, więc zgoda na `web.search::…` nie otwiera `web.read`.

### 12. `SettingsStore.scheduleSave` łapie pad zapisu

⚠️ Callback debounce'u woła `save()` przez `void … .catch(log.error)`. `save()` jest ASYNC, a timer nie ma komu oddać odrzucenia: pad zapisu (dysk sieciowy, pełny dysk, plik zajęty) wychodziłby jako unhandled rejection, którego nikt się nie dowie. **Nie wołaj tu `save()` gołym wywołaniem** - to druga, cicha droga tej samej klasy błędu co gołe handlery Ustawień. Testy: `core/utils/SettingsManager.test.ts`.

---

## Testy

- `core/security/SensitiveDataGuard.test.js` - wykrywanie/maskowanie API keys (OpenAI/Anthropic/Google/etc.), w tym zaescapowany JSON, dwie warstwy zaescapowania, `Bearer <token bez znanego kształtu>`, idempotencja maski
- `core/security/ApprovalManager.test.js` - reguła per narzędzie external, cel `*` od wołacza nie daje wieloznacznika (`vault.delete`, `agent.message`, gwiazdka wewnątrz celu), reguła zastana `akcja::*` działa jak dotąd ale ostrzega przy wczytaniu, ekran reguł ją kasuje, reguła dla konkretnego celu bez zmian
- `core/security/keySanitizer.test.js` - `sanitizePath` (`../`, `%2e%2e`, null byte, zero-width unicode, UNC, `*` odrzucone, `?`/`[`/`%` nadal legalne, ścieżki absolutne, idempotencja do punktu stałego z testem własnościowym na wielu wygenerowanych ciągach z deterministycznego LCG) i `isProtectedPath` (`.pkm-assistant/settings.json`, `settings.last-good.json`, kopie, logi, `.env`, `data.json`)
- `core/security/path_canonical.test.js` - równoważność zapisu ścieżki + pełny łańcuch wołacz→bramka→zlew (`MCPClient` + `WriteTool` + `PermissionSystem`, bez mocka `obsidian`)
- `core/security/path_canonical_image.test.js` - kanonizacja dla akcji `image.*` i to, że `AccessGuard` prostuje cel sam z siebie
- `core/security/non_vault_targets.test.js` - cele nie-vaultowe (`web.*`, `agent.message`, `delegate`) omijają whitelistę folderów i zakres suba, a whitelista NADAL tnie prawdziwe ścieżki; brak flagi `targetIsVaultPath` = pełna ocena ścieżkowa (fail-closed)
- `core/security/nogo_case.test.js` - No-Go i `SYSTEM_NO_GO` łapią mimo innej wielkości liter (`checkPermission` + `checkAccess` + `filterResults`), wpisy z ustawień zwijają się do jednego, a whitelista i zakres suba NADAL rozróżniają wielkość liter

Odpalane przez `npm test` (AVA pattern `core/security/*.test.js` w `package.json`).

Rdzeń `core/` (pattern `core/*.test.js`): strażnik startu czyta zarówno źródło `PluginRuntime.ts` regexami (bo plik importuje `obsidian` i nie wstaje w AVA), jak i testuje naprawdę `waitForLayoutReady` z `layoutReady.js` (brak workspace / callback synchroniczny / callback z opóźnieniem).

Utils (pattern `core/utils/*.test.js`): `errorUtils.test.js` (null/string/`error.code`/zagnieżdżony `error.error.type`/`http_status`/JSON.stringify; pola-sekrety poza `message`, limit długości, cykle, `details` bez zmian) · `Logger.test.js` (maska na każdym poziomie - zaescapowany JSON w polu `message`, `cause`/`response` błędu, `debug`/`info`/`warn` do sinku, zwykły log nietknięty) · `vaultFs.test.js` (kolejność mkdir rodziców, istniejące = zero mkdir, brak metod adaptera = no-op, pusta ścieżka, normalizacja backslashy) · `workPromptResolver.test.js` · `TokenTracker.test.js`.

---

## Kluczowe decyzje

- **`core/index.js` barrel zamiast deep imports** - konsystentne z regułą "jedyne drzwi" dla modułów. ESLint `no-restricted-imports` wymusza "poza core importuj tylko z `core/index.js`" (wyjątki: `i18n/index.js`, `utils/Logger.js`, oraz composition root `src/main.js` na cztery obsidianowe pliki).
- **Test pliki razem z kodem** (`core/security/keySanitizer.test.js` obok `keySanitizer.js`) - nie w `__tests__/` ani `test/`.

---

## Dla Claude Code

Otwieraj `core/` jako kontekst gdy pracujesz nad:
- Entry pointem pluginu (`PluginBase`, `runtime/PluginRuntime`)
- Security (AccessGuard, permissions, approval flow)
- Utils używanymi wszędzie (logger, yaml, hash, slugify, tokens, i18n)

NIE otwieraj gdy pracujesz nad konkretnym modułem - wtedy otwórz `modules/<nazwa>/`. Core jest cicho w tle, jego publiczne API siedzi w `index.js` i to wystarczy zobaczyć.
