# PKM Assistant — Known Security Issues

> Znane problemy bezpieczeństwa — dokumentacja dla deweloperów.
> Aktualizacja: 2026-07-30 (S33: zaufanie do zewnętrznych serwerów MCP, strażnicy delegacji i poczty)

---

## Przechowywanie kluczy API

Klucze API mieszkają w ustawieniach pluginu: **`.pkm-assistant/settings.json`** w vaulcie
(od E3.7, 2026-07-28 — wcześniej Obsidianowy `data.json` w folderze pluginu).
- NIE są zapisywane w kodzie pluginu
- NIE są wysyłane nigdzie poza wybranym dostawcą AI
- `isProtectedPath` blokuje agentom `.pkm-assistant/settings.json`,
  `.pkm-assistant/settings.last-good.json`, `.pkm-assistant/backups/`,
  `.pkm-assistant/logs/` i `.pkm-assistant/agents/*/memory/sessions/` (K8, 2026-08-22),
  a także `data.json` i `.env`
- `main.js` dopisuje te ścieżki do `.gitignore` vaulta przy starcie (klucze nie trafią do
  repo usera). Lista wpisów: `VAULT_GITIGNORE_ENTRIES` w `core/security/keySanitizer.ts`
- ⚠️ **Pliki sesji są WYJĄTKIEM od `.gitignore` (K12, 2026-08-23).** K8 dopisał
  `.pkm-assistant/agents/*/memory/sessions/` do listy; decyzją właściciela wpis został zdjęty,
  bo pliki sesji to pamięć agentów podróżująca między urządzeniami przez repo vaulta.
  Ryzyko sekretu (treść błędu przy padniętym strumieniu) jest dziś zdejmowane **u źródła**:
  każdy zapis pliku sesji idzie przez `maskSensitiveData`. Narzędzia agenta nadal ich nie
  widzą — `isProtectedPath` zostaje bez zmian. **Plugin nie usuwa wpisu, który już dopisał** —
  kto ma go w `.gitignore` po K8, kasuje linię ręcznie.
- Tylko jawny, domyślnie wyłączony `admin_access` na konkretnym agencie otwiera
  chronione ścieżki wewnątrz vaulta
- Logger maskuje klucze w logach (`core/security/SensitiveDataGuard.ts`)

### Jak działa maskowanie (K8, 2026-08-22)

Maska ma **dwa niezależne filtry** — do K8 był tylko pierwszy:

1. **Po kształcie wartości** — znane prefiksy dostawców: `sk-` (OpenAI, w tym `sk-proj-`),
   `sk-ant-` (Anthropic), `sk-or-v1-` (OpenRouter), `gsk_` (Groq), `xai-` (xAI), `AIza`
   (Google), `AKIA` (AWS). Filtr z definicji zna tylko to, co ktoś wpisał do listy.
2. **Po nazwie pola/nagłówka** — wartość pola nazwanego `Authorization`, `api_key`,
   `apiKey`, `x-api-key`, `*_key`, `token`, `secret`, `password`, `passphrase`
   (bez względu na wielkość liter) jest maskowana **niezależnie od kształtu**. Działa
   w JSON-ie (`"api_key":"…"`), w nagłówku (`Authorization: Bearer …`) i w gołym
   tekście (`api_key=…`). To ten filtr chroni przed dostawcą, którego jeszcze nie znamy.

Maska zostawia rozpoznawalny ślad (`abcd***wxyz`) i schemat autoryzacji (`Bearer`), żeby
log dalej nadawał się do diagnostyki. Jest idempotentna — dwukrotne przepuszczenie tego
samego tekstu nic nie zmienia. Wartości krótsze niż 8 znaków nie są traktowane jak sekret
(inaczej maska zjadałaby zwykły tekst notatek w `RetrievalEngine`).

Osobno: `core/utils/http_request.ts` **nie loguje** parametrów żądania — w gałęzi błędu
idzie jedna linia z metodą, adresem bez query, statusem, czasem i samymi NAZWAMI nagłówków
(`core/utils/httpLogSummary.ts`).

## Known Issues (do naprawy w przyszłych wersjach)

### 1. MCP Server Sandbox NIE był granicą bezpieczeństwa — ROZWIĄZANE (E3.1, 2026-07-24)

**Opis (historyczny):** sandbox w `ServerExecutor.js` uruchamiał kod JS usera z vaulta
przez `new Function()` z shadowanymi globalnymi. To była izolacja przed **przypadkowymi**
błędami, **nie** zabezpieczenie przed złośliwym kodem — ucieczka jedną linijką przez
prototype chain (`({}).constructor.constructor('return this')()`) dawała dowolny kod
w procesie Obsidiana.

**Stan:** cała ścieżka custom-JS **wyburzona w E3.1 faza C** — `ServerExecutor.js`,
szablony serwerów, `checkSandboxSafety` i narzędzie `connect_to_server` nie istnieją;
plugin nie ładuje już `.js` z vaulta. Zewnętrzne serwery obsługuje prawdziwy klient
protokołu MCP (`modules/tools/ExternalMcpManager.js`): stdio = osobny **proces systemowy**,
http = **zdalna usługa**. Nic z tego nie dzieli sterty JS z Obsidianem, więc nie ma czego
„sandboxować" — granicą jest system operacyjny, a po naszej stronie: klasyfikacja RED +
obowiązkowy approval. Zaufanie do serwera jest jawną decyzją usera — patrz sekcja
„Zewnętrzne serwery MCP — model zaufania" niżej.

### 2. Path Traversal w MCP Server Tools — ROZWIĄZANE

**Opis:** Narzędzia serwerów MCP (np. read_component) nie normalizują `../` w argumentach.
ServerExecutor._checkServerAccess() blokuje dostęp do `.obsidian`, `.trash`, `.git` —
ale ścieżki mogą wyjść poza zadeklarowane paths[] serwera.

**Ryzyko realne:** NISKIE — serwery MCP to pliki w Twoim vaultcie, nie zewnętrzny kod.

**Stan:** argumenty ścieżek prymitywów vaulta przechodzą przez centralny
`validateVaultPath()` + `sanitizePath()`. `../`, warianty URL-encoded, ścieżki
absolutne, UNC i null-byte są odrzucane przed dotknięciem adaptera.

### 3. AccessGuard — Brak Normalizacji `..` — ROZWIĄZANE

**Opis:** AccessGuard._matchesEntry() zamienia backslashe ale nie rozwiązuje `..` segmentów.
Obsidian adapter prawdopodobnie normalizuje ścieżki wewnętrznie.

**Stan:** `sanitizePath()` jest niezależną warstwą przed `AccessGuard`. Nawet
agent z `admin_access:true` pozostaje vault-relative i nie przechodzi przez `../`.

**Domknięcie K1 (2026-08-22):** do tej pory ta warstwa działała, ale NIE PIERWSZA —
bramka uprawnień dostawała surowy `args.path` od modelu, a formę kanoniczną robiło
dopiero samo narzędzie. Przez tę szczelinę `./Sekrety/./tajne.md` i `/Sekrety/tajne.md`
omijały No-Go, a `./.pkm-assistant/./settings.json` listę plików chronionych.
Dziś kanonizacja dzieje się **raz, przed bramką**: `MCPClient._extractToolContext`
sprowadza ścieżkę do formy kanonicznej i podmienia ją w argumentach wywołania, więc
narzędzie w `execute` dostaje DOKŁADNIE ten ciąg, który oceniły No-Go, lista plików
chronionych i whitelista. `PermissionSystem.checkPermission` powtarza kanonizację dla
akcji `vault.*` i `image.*` jako obrona w głąb (wołaczy jest więcej niż jeden), a ścieżka,
której nie da się sprowadzić do formy kanonicznej, kończy się twardą odmową `Invalid path` —
fail-closed, bez pytania usera. `sanitizePath()` wycina segmenty `.`, kolapsuje `//`, tnie
wiodące i końcowe `/`, zamienia `\` na `/` i dekoduje `%XX` — a `..` nadal ODRZUCA
(nie rozwiązuje).

**Domknięcie K13 (2026-08-23):** ta warstwa NIE była w pełni idempotentna, choć cały
kontrakt K1 na tym stał. `trim()` działał raz na całym ciągu, a `decodeURIComponent`
zdejmował jedną warstwę kodowania, więc drugi przebieg potrafił oddać INNY tekst:
`'./ A/B.md'` → `' A/B.md'` → `'A/B.md'`, `'a%252e%252e/x'` → `'a%2e%2e/x'` → `'a../x'`.
Skutek: wołacz podmieniał w argumentach narzędzia formę po JEDNYM przebiegu, a bramka
oceniała formę po DWÓCH — user widział w oknie zgody ścieżkę w folderze „ A" (ze spacją
z przodu, sąsiad folderu `A`), a bramka przepuszczała `A/B.md` na whiteliście `A/`.
Dziś `sanitizePath()` liczy wynik **do punktu stałego** (maks. 5 przebiegów, potem `null`),
więc `sanitizePath(sanitizePath(x)) === sanitizePath(x)` z konstrukcji i każda warstwa
widzi ten sam ciąg. Zmiana semantyczna: podwójnie zakodowane wejście dekoduje się do końca
albo odpada — `'%252e%252e/x'` → `null` (wcześniej przechodziło jako niewinny plik
`%2e%2e`), `'a%252e%252e/x'` → `'a../x'` (segment `a..` to legalna nazwa, nie traversal).
Skoro kanonizacja jest idempotentna, **`AccessGuard.checkAccess` prostuje cel sam na
wejściu** — trzecia warstwa nie może już oddać innego ciągu. Wyjątek: akcje nie-vaultowe
(`web.search`, `web.read`, `agent.message`, `delegate`, `external.call`), których celem
jest zapytanie, adres albo adresat — ich `PermissionSystem` jawnie zwalnia z kanonizacji.

## Model kontroli agenta (2026-07-24)

- `disabled_tools[]` mówi, jakie narzędzia built-in są wyłączone. **Od K3 (2026-08-22) jest to
  bramka WYKONANIA, nie tylko filtr listy narzędzi w prompcie:** `MCPClient.executeToolCall`
  pyta o zgodę tę samą metodę (`ToolRegistry.checkToolAxis`), którą liczona jest widoczność,
  zanim pobierze narzędzie z rejestru. Wywołanie wyłączonego narzędzia po nazwie — także po
  starej nazwie (aliasie) — kończy się odmową fail-closed, bez pytania usera.
- `mcp_servers[]` jest realnym opt-inem zewnętrznych serwerów per agent — od K3 egzekwowanym
  także przy wykonaniu. **Brak listy = brak opt-inu = odmowa** (nie „wszystkie serwery").
- `guidance_mode:true` oznacza cały zwykły vault; `false` + puste
  `focus_folders` oznacza zero dostępu do zwykłego vaulta.
  **Whitelista folderów i No-Go mierzą wyłącznie CELE-ŚCIEŻKI (K14, 2026-08-23).** Zapytanie
  do wyszukiwarki, adres strony, adresat wiadomości i nazwa roli w delegacji nie są ścieżkami
  i nie są z nią porównywane — do K14 były, więc agent „Tylko przypisane" z whitelistą
  `['A/']` tracił wyszukiwarkę, pobieranie stron, pocztę i delegację w całości (odmowa
  „poza obszarem roboczym agenta"). Te akcje mają WŁASNE granice: rejestr znanych adresów
  + zgoda usera (`web_search`/`web_read`), widoczność adresata i limity skrzynki
  (`kom_send`), przecięcie zakresów rodzic∩dziecko i głębokość delegacji, obowiązkowa
  zgoda RED + opt-in serwera (`external.call`).
  ⚠️ Reguła ta obowiązuje dla profili **polityki dostępu v2**, czyli takich, które mają
  w YAML-u `access_policy_version: 2`. Profil BEZ tego pola jest traktowany jak stary (v1),
  gdzie puste `focus_folders` znaczyło „cały vault" — jednorazowa migracja podnosi mu wtedy
  `guidance_mode` na `true` i zapisuje plik z `access_policy_version: 2`. Piszesz profil
  ręcznie i chcesz „zero dostępu"? **Dopisz `access_policy_version: 2`**, inaczej migracja
  nadpisze Twoje jawne `false`. Szczegóły: `core/SECURITY.md` i `modules/agents/CLAUDE.md`.
- `admin_access:true` jest osobnym, świadomym przełącznikiem do bebechów vaulta
  (`.pkm-assistant`, `.obsidian`, `.trash`, No-Go, pliki chronione).
- Autonomia reguluje pytania, nie możliwości. Pełna swoboda wymaga jednocześnie:
  włączonych narzędzi, `admin_access:true` i autonomii `yolo`.
- W trybie `edge`: zielone akcje nie pytają, żółte respektują przełączniki,
  czerwone zawsze pytają. Nieznane i zewnętrzne narzędzia są czerwone.

---

## Zewnętrzne serwery MCP — model zaufania

Zewnętrzny serwer MCP to **cudzy program** (transport `stdio` — proces na Twoim komputerze)
albo **cudza usługa w sieci** (transport `http`). Plugin nie ma jak go ograniczyć od środka —
może tylko pilnować granicy między nim a Tobą. Poniżej uczciwy podział: co gwarantuje plugin,
a co zostaje na Twojej głowie.

### Co GWARANTUJE plugin

- **Każde narzędzie zewnętrznego serwera jest RED — zawsze.** Rejestrujemy je z
  `source:'user'`, a `classifyToolRisk` daje wtedy czerwone światło niezależnie od tego, co
  serwer o sobie deklaruje. Czerwone = **pierwsze użycie zawsze pyta**.
- **„Zawsze zezwalaj" działa per KONKRETNE narzędzie**, nie hurtem na serwer. Reguła zapisuje
  się jako `external.call::<serwer>__<narzędzie>` — zgoda na „pokaż scenę" nie jest zgodą na
  „uruchom kod".
- **Modal approvalu pokazuje PEŁNE argumenty wywołania** (sformatowany JSON, przycinany przy
  ~1500 znakach). Zatwierdzasz konkretne dane, nie samą nazwę narzędzia.
- **Tożsamość i wewnętrzne znaczniki nie wychodzą na zewnątrz.** Wszystko z prefiksem
  `_invocation` (nazwa agenta, głębokość delegacji, przyszłe znaczniki) jest odcinane przed
  wysyłką — cudzy serwer nie dowiaduje się, kto i z którego poziomu go woła.
- **Timeouty per wywołanie** — 60 s domyślnie, sufit 180 s. Zawieszony serwer nie zawiesza
  pluginu.
- **Statusy połączeń żyją w pamięci, nie w `data.json`** — plik konfiguracji trzyma wyłącznie
  to, co ustawił user (`stripRuntimeFields` sprząta po starszych wersjach).
- **Kill-switch per serwer.** Przełącznik w Ustawieniach → Serwery MCP wyłącza serwer bez
  kasowania konfiguracji: narzędzia natychmiast znikają z rejestru (rozłączenie), „Połącz"
  jest zablokowane, autostart go pomija.
- **Podgląd narzędzi przed zapisem.** W oknie dodawania serwera guzik „Sprawdź połączenie
  i pokaż narzędzia" łączy się jednorazowo, listuje narzędzia i **zamyka połączenie** — widzisz,
  co dokładnie dostanie agent, zanim cokolwiek trafi do konfiguracji. Nic nie jest przy tym
  rejestrowane.
- **Opt-in per agent.** Serwer działa tylko dla agentów, którym go przypniesz
  (profil → Umiejętności → Konektory, pole `mcp_servers[]`). Domyślnie: żaden.
  Od K3 (2026-08-22) sprawdza to także punkt wykonania — do tej pory opt-in był wyłącznie
  filtrem widoczności i narzędzie niepodpiętego serwera dawało się wywołać po nazwie.

### Co jest NA GŁOWIE USERA

- **`stdio` = proces z Twoimi prawami, na Twoim komputerze.** Może czytać i kasować pliki poza
  vaultem, sięgać do sieci, robić co chce — dokładnie jak każdy program, który sam uruchomisz.
  Żaden approval w pluginie tego nie ogranicza; approval decyduje tylko o tym, czy agent go
  **zawoła**.
- **`http` = dane Twoich rozmów lecą do zdalnej usługi.** Wszystko, co agent wstawi w argumenty
  (fragmenty notatek, treść pytania), zobaczy właściciel tego serwera.
- **Sekrety w konfiguracji.** Komenda + `env` (stdio) oraz URL + nagłówki (http) potrafią nieść
  tokeny. Trzymamy je w ustawieniach pluginu (`data.json`), **nie** w vaulcie — świadomie, żeby
  nie synchronizowały się przez chmurę razem z notatkami. Kopia zapasowa `data.json` to kopia
  Twoich sekretów.
- **Instaluj tylko z zaufanych źródeł.** Serwer MCP to nie wtyczka w piaskownicy — to
  pełnoprawny program. Nie dodawaj serwera, którego autora i kodu nie umiesz wskazać.

## Strażnicy delegacji i poczty agentów (S33, 2026-07-30)

Agent może wołać innych agentów (delegacja) i pisać do nich (poczta). Bez bezpieczników obie
drogi potrafią się rozpędzić w pętlę — kosztowną i trudną do zatrzymania. Doszły limity:

**Delegacja (`delegate`)**
- **Limit głębi:** domyślnie **1** poziom (sufit ustawienia: 3). Sub-agent nie deleguje dalej —
  odmowa jest twarda, w narzędziu. Głębokość jedzie w zaufanym znaczniku wstrzykiwanym przez
  runtime (`_invocationDelegationDepth`), model nie ma jak jej podrobić.
- **Limit równoległości:** domyślnie **5** zadań w jednym wywołaniu (`max_parallel_delegations`).
- **Zakres sub-agenta = PRZECIĘCIE z dostępem rodzica.** `scope.folders` sub-agenta nigdy nie
  poszerza uprawnień — tylko je zawęża. Od S33 przecięcie tnie także **wyniki**: `search`/`list`
  nie oddają subowi ścieżek ani fragmentów spoza jego kąta (wcześniej plik był nieotwieralny, ale
  jego istnienie i excerpt wyciekały). `.pkm-assistant/**` zostaje poza zasięgiem, a
  `admin_access` rodzica **nie** zwalnia z tej bariery (fail-closed).
- **Przecięcie obowiązuje też PIĘTRO NIŻEJ (K11, 2026-08-22).** Gdy sub zleca dalej
  (`max_delegation_depth` ≥ 2), wnuk dostaje **przecięcie** zakresu foldera i whitelisty
  narzędzi z tym, co ma sub ZLECAJĄCY — nigdy z tym, co ma agent główny. Zakresy rozłączne =
  odmowa delegacji. Do K11 wnuk startował z zakresem policzonym wyłącznie z własnego configu
  (często pustego → pełny zasięg rodzica), a `delegate {aspect:"worker"}` wystawiał mu pełną
  listę narzędzi agenta głównego.

**Wyjście na sieć (`web_search` / `web_read`)**
- **Osobna zgoda dla każdego (K11, 2026-08-22).** `web_read` ma własny typ akcji (`web.read`),
  własny przełącznik w profilu agenta i własny opis w oknie zgody — wcześniej dzielił wszystko
  z `web_search`, więc jedno odkliknięcie „Wyszukiwanie w internecie" zdejmowało pytanie także
  z pobierania adresu wskazanego przez model, a modal ogłaszał to jako wyszukiwanie.
  Domyślnie **oba pytaj**; wyciszenie jednego nie wycisza drugiego, a trwała reguła
  „Zawsze zezwalaj" zapada osobno dla każdego.
- **Bramka proweniencji adresu** (`isUrlKnown`) stoi niezależnie od zgody: `web_read` otworzy
  wyłącznie adres, który wpisał człowiek albo który wrócił z `web_search` w tym uruchomieniu.

**Poczta agentów (`kom_send`)**
- **Rate-limit:** domyślnie **20 wiadomości / 10 min per para nadawca→adresat**
  (`kom_send_rate_max`, edytowalne w Ustawieniach → Limity). Licznik żyje w pamięci —
  restart pluginu czyści konto, bo to bezpiecznik rozpędzonej sesji, nie kwota dzienna.
- **Licznik odbić (hop):** wiadomość niesie licznik przeskoków; przy **3** `kom_send` odmawia
  i każe oddać sprawę userowi. Łańcuch A→B→C→A zatrzymuje się sam.
- **Niewidzialność duchów nienaruszona.** Limity liczą się dopiero dla adresatów, których agent
  i tak widzi — odmowa nigdy nie zdradza, że istnieje agent ukryty przed nadawcą.
- **User nie podlega żadnemu z tych limitów** — dotyczą wyłącznie narzędzia agenta, nie
  panelu komunikatora.

---

## Granica dane/instrukcje w prompcie — ogrodzenie treści (K9, 2026-08-22)

Agent czyta pliki vaulta, strony WWW i odpowiedzi serwerów MCP. Nic z tego nie pisał operator,
więc nic z tego nie może być instrukcją. Granicę trzyma **jedna funkcja** —
`fenceUntrusted(content, source)` z `core/security/promptFence.ts`:

- Treść wchodzi do system promptu w bloku `<vault_content source="…">…</vault_content>`.
- **Znacznika nie da się zamknąć od środka** — `<vault_content` i `</vault_content` z wnętrza
  treści są escapowane do `&lt;…`. Wcześniej ogrodzenie było sklejane stringiem bez escapowania,
  więc wpis w pamięci zaczynający się od `</vault_content>` kończył je przedwcześnie, a reszta
  ładunku stała w prompcie jako zwykły tekst systemowy — trwale, bo siedziała w `brain.md`.
- **Trzy kanały idą przez to samo ogrodzenie:** pamięć agenta (`brain.md` + indeks `brain/`),
  indeks artefaktów (`status`/`typ` z frontmattera notatek vaulta) i Oczko (aktywna notatka:
  nazwa, frontmatter, do 2000 znaków treści).
- **Model wie, że ogrodzenie istnieje** — mówi mu o tym sekcja „Bezpieczeństwo treści" w prompcie.

**Co NIE jest ogradzane, bo jest zaufane:** reguły domenowe z yamla agenta
(`.pkm-assistant/agents/*.yaml`) i opisy folderów z mapy vaulta — pisze je operator, a katalog
`.pkm-assistant/**` jest poza zasięgiem narzędzi agenta.

⚠️ **Czego to NIE gwarantuje:** ogrodzenie jest deklaracją dla modelu, nie sandboxem. Model może
je zignorować. Realną granicą pozostają uprawnienia narzędzi, approval i whitelisty folderów —
ogrodzenie ma sprawić, że wstrzyknięta treść nie wygląda jak polecenie systemowe, a nie że model
na pewno jej nie posłucha.

---

## `npm audit` a to, co naprawdę jedzie do usera (D11, 2026-09-04; przeliczone 2026-09-07)

`npm audit` zgłasza dziś **1 podatność (high)**. Trzy z czterech pozycji z 2026-09-04 zamknął
`npm audit fix` z 2026-09-07 (w `package-lock.json`: `hono` 4.13.7, `ip-address` 10.7.0, `qs` 6.16.0 —
wersje mieszczą się w zakresach, jakich żąda SDK, więc to podbicie locka, nie fork cudzego drzewa).
Żadna z pozycji, ani dawna, ani obecna, nie trafia
do pliku, który dostaje użytkownik (`dist/main.js`). Rozbicie:

| Pakiet | Ocena | Skąd się bierze | Czy jest w bundlu |
|---|---|---|---|
| `brace-expansion` | high | narzędzia DEV: `ava`, `eslint`/`glob` (dawniej też `archiver`, wycięty 2026-09-07) | **nie** |
| `hono` | ~~moderate~~ zamknięte 07.09 | `@modelcontextprotocol/sdk` → `@hono/node-server` | **nie** |
| `qs` | ~~moderate~~ zamknięte 07.09 | `@modelcontextprotocol/sdk` → `express` → `body-parser` | **nie** |
| `ip-address` | ~~high~~ zamknięte 07.09 | `@modelcontextprotocol/sdk` → `express-rate-limit` | **nie** |

**Dlaczego ich tam nie ma.** `brace-expansion` żyje wyłącznie w łańcuchu narzędzi budowania
i testów — nic z tego nie wchodzi do bundla. Pozostałe trzy to zależności **serwerowej**
strony `@modelcontextprotocol/sdk`: plugin używa wyłącznie strony **klienckiej**
(`ExternalMcpManager` importuje `client/index.js`, `client/stdio.js`,
`client/streamableHttp.js`), więc esbuild nie wciąga modułów serwera i całe `express`/`hono`
wypada z drzewa przy budowaniu.

**Jak to sprawdzić samemu** (po `npm run build`):

```bash
for p in hono ip-address Address4 express-rate-limit brace-expansion body-parser express; do
  printf '%-20s %s\n' "$p" "$(grep -c -F "$p" dist/main.js)"
done
# stan na 2026-09-04 i 2026-09-07: każda linia = 0
```

Sam kliencki kod SDK **jest** w bundlu (widać w nim m.in. stałe protokołu MCP) — to on
rozmawia z zewnętrznymi serwerami. Podatne moduły serwerowe zostają poza nim.

**Status:** zostaje `brace-expansion` w narzędziach deweloperskich (`ava`, `eslint`) — poza
bundlem, czeka na wydania tych narzędzi. Tabelę przeliczyć przy każdej aktualizacji SDK
i przed każdym zgłoszeniem do katalogu (walidator katalogu liczy `npm audit` osobno).

⚠️ Osobna sprawa, NIE objęta tym wpisem: serwer MCP uruchomiony przez usera na transporcie
`stdio` to samodzielny proces systemowy z własnymi zależnościami. Jego podatności nie widzi
ani `npm audit` tego repo, ani ten plik — patrz sekcja „Zewnętrzne serwery MCP — model zaufania".

---

## Co jest bezpieczne

- Klucze API nie w kodzie, nie w repo
- AccessGuard chroni .obsidian i .trash (SYSTEM_NO_GO; wyjątek tylko dla jawnego admina)
- Zewnętrzne serwery MCP: RED bezwarunkowo + approval per narzędzie + pełne argumenty
  w modalu + kill-switch per serwer + opt-in per agent (szczegóły w sekcji „model zaufania")
- keySanitizer maskuje klucze w logach
- Agenci nie mogą czytać plików poza vaultem Obsidiana **wbudowanymi narzędziami** (także
  z `admin_access` — `sanitizePath` trzyma je vault-relative)
- Wbudowane narzędzia nie dają dostępu do systemu plików OS ani do uruchamiania programów;
  sieć tylko przez jawne API (modele, web search). ⚠️ **Wyjątek świadomy:** zewnętrzny serwer
  MCP na transporcie `stdio` to osobny proces systemowy uruchomiony przez usera — jego
  możliwości ogranicza system operacyjny, nie plugin
