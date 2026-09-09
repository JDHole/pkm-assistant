# PKM Assistant - Known Security Issues

> Znane problemy bezpieczeństwa - dokumentacja dla deweloperów.

---

## Przechowywanie kluczy API

Klucze API mieszkają w ustawieniach pluginu: **`.pkm-assistant/settings.json`** w vaulcie.
- NIE są zapisywane w kodzie pluginu
- NIE są wysyłane nigdzie poza wybranym dostawcą AI
- `isProtectedPath` blokuje agentom `.pkm-assistant/settings.json`,
  `.pkm-assistant/settings.last-good.json`, `.pkm-assistant/backups/`,
  `.pkm-assistant/logs/`, a także `data.json` i `.env`
- `main.js` dopisuje te ścieżki do `.gitignore` vaulta przy starcie (klucze nie trafią do
  repo usera). Lista wpisów: `VAULT_GITIGNORE_ENTRIES` w `core/security/keySanitizer.ts`
- ⚠️ **Pliki sesji pamięci agenta są WYJĄTKIEM od `.gitignore`** - to pamięć agentów
  podróżująca między urządzeniami przez repo vaulta. Ryzyko sekretu (treść błędu przy padniętym
  strumieniu) jest zdejmowane **u źródła**: każdy zapis pliku sesji idzie przez
  `maskSensitiveData`. Narzędzia agenta nadal ich nie widzą - `isProtectedPath` zostaje bez
  zmian.
- Tylko jawny, domyślnie wyłączony `admin_access` na konkretnym agencie otwiera
  chronione ścieżki wewnątrz vaulta
- Logger maskuje klucze w logach (`core/security/SensitiveDataGuard.ts`)

### Jak działa maskowanie

Maska ma **dwa niezależne filtry**:

1. **Po kształcie wartości** - znane prefiksy dostawców: `sk-` (OpenAI, w tym `sk-proj-`),
   `sk-ant-` (Anthropic), `sk-or-v1-` (OpenRouter), `gsk_` (Groq), `xai-` (xAI), `AIza`
   (Google), `AKIA` (AWS). Filtr z definicji zna tylko to, co ktoś wpisał do listy.
2. **Po nazwie pola/nagłówka** - wartość pola nazwanego `Authorization`, `api_key`,
   `apiKey`, `x-api-key`, `*_key`, `token`, `secret`, `password`, `passphrase`
   (bez względu na wielkość liter) jest maskowana **niezależnie od kształtu**. Działa
   w JSON-ie (`"api_key":"…"`), w nagłówku (`Authorization: Bearer …`) i w gołym
   tekście (`api_key=…`). To ten filtr chroni przed dostawcą, którego jeszcze nie znamy.

Maska zostawia rozpoznawalny ślad (`abcd***wxyz`) i schemat autoryzacji (`Bearer`), żeby
log dalej nadawał się do diagnostyki. Jest idempotentna - dwukrotne przepuszczenie tego
samego tekstu nic nie zmienia. Wartości krótsze niż 8 znaków nie są traktowane jak sekret
(inaczej maska zjadałaby zwykły tekst notatek w `RetrievalEngine`).

Osobno: `core/utils/http_request.ts` **nie loguje** parametrów żądania - w gałęzi błędu
idzie jedna linia z metodą, adresem bez query, statusem, czasem i samymi NAZWAMI nagłówków
(`core/utils/httpLogSummary.ts`).

## Model zagrożeń - kluczowe naprawy

### Ścieżki wewnątrz vaulta - jedna kanonizacja dla bramki i zlewu

Argumenty ścieżek prymitywów vaulta przechodzą przez centralny `sanitizePath()` +
`AccessGuard`. `../`, warianty URL-encoded, ścieżki absolutne, UNC i null-byte są odrzucane
przed dotknięciem adaptera. Kanonizacja dzieje się **raz, przed bramką**:
`MCPClient._extractToolContext` sprowadza ścieżkę do formy kanonicznej i podmienia ją
w argumentach wywołania, więc narzędzie w `execute` dostaje DOKŁADNIE ten ciąg, który
oceniły No-Go, lista plików chronionych i whitelista. `PermissionSystem.checkPermission`
powtarza kanonizację dla akcji `vault.*` i `image.*` jako obrona w głąb (wołaczy jest
więcej niż jeden), a ścieżka, której nie da się sprowadzić do formy kanonicznej, kończy się
twardą odmową `Invalid path` - fail-closed, bez pytania usera. `sanitizePath()` wycina
segmenty `.`, kolapsuje `//`, tnie wiodące i końcowe `/`, zamienia `\` na `/` i dekoduje
`%XX` - a `..` nadal ODRZUCA (nie rozwiązuje).

**Idempotencja do punktu stałego.** Pojedynczy przebieg kanonizacji nie jest z natury
idempotentny: `trim()` działający raz na całym ciągu, albo `decodeURIComponent` zdejmujący
jedną warstwę kodowania, potrafiłyby oddać inny tekst przy drugim przebiegu
(`'./ A/B.md'` → `' A/B.md'` → `'A/B.md'`; `'a%252e%252e/x'` → `'a%2e%2e/x'` → `'a../x'`) -
a to łamie kontrakt "jeden ciąg dla bramki i zlewu" w praktyce: wołacz kanonizujący raz
i bramka kanonizująca drugi raz mogłyby ocenić dwa różne ciągi, więc user w oknie zgody
widziałby inną ścieżkę niż tę, którą faktycznie oceniła bramka. Dlatego `sanitizePath()`
liczy wynik **do punktu stałego** (maks. 5 przebiegów, potem `null`), więc
`sanitizePath(sanitizePath(x)) === sanitizePath(x)` z konstrukcji i każda warstwa widzi ten
sam ciąg. Konsekwencja: podwójnie zakodowane wejście dekoduje się do końca albo odpada -
`'%252e%252e/x'` → `null` (a nie niewinny plik `%2e%2e`), `'a%252e%252e/x'` → `'a../x'`
(segment `a..` to legalna nazwa, nie traversal). Skoro kanonizacja jest idempotentna,
`AccessGuard.checkAccess` prostuje cel sam na wejściu - dzięki temu żadna kolejna warstwa
nie może już oddać innego ciągu. Wyjątek: akcje nie-vaultowe (`web.search`, `web.read`,
`agent.message`, `delegate`, `external.call`), których celem jest zapytanie, adres albo
adresat - ich `PermissionSystem` jawnie zwalnia z kanonizacji.

## Model kontroli agenta

- `disabled_tools[]` mówi, jakie narzędzia built-in są wyłączone. To jest bramka
  WYKONANIA, nie tylko filtr listy narzędzi w prompcie: `MCPClient.executeToolCall` pyta
  o zgodę tę samą metodę (`ToolRegistry.checkToolAxis`), którą liczona jest widoczność,
  zanim pobierze narzędzie z rejestru. Wywołanie wyłączonego narzędzia po nazwie - także po
  starej nazwie (aliasie) - kończy się odmową fail-closed, bez pytania usera.
- `mcp_servers[]` jest realnym opt-inem zewnętrznych serwerów per agent, egzekwowanym
  także przy wykonaniu. **Brak listy = brak opt-inu = odmowa** (nie "wszystkie serwery").
- `guidance_mode:true` oznacza cały zwykły vault; `false` + puste
  `focus_folders` oznacza zero dostępu do zwykłego vaulta.
  **Whitelista folderów i No-Go mierzą wyłącznie CELE-ŚCIEŻKI.** Zapytanie
  do wyszukiwarki, adres strony, adresat wiadomości i nazwa roli w delegacji nie są ścieżkami
  i nie są z nimi porównywane - inaczej agent "Tylko przypisane" z whitelistą
  `['A/']` traciłby wyszukiwarkę, pobieranie stron, pocztę i delegację w całości (odmowa
  "poza obszarem roboczym agenta"). Te akcje mają WŁASNE granice: rejestr znanych adresów
  + zgoda usera (`web_search`/`web_read`), widoczność adresata i limity skrzynki
  (`kom_send`), przecięcie zakresów rodzic∩dziecko i głębokość delegacji, obowiązkowa
  zgoda RED + opt-in serwera (`external.call`).
  ⚠️ Reguła ta obowiązuje dla profili **polityki dostępu v2**, czyli takich, które mają
  w YAML-u `access_policy_version: 2`. Profil BEZ tego pola jest traktowany jak stary (v1),
  gdzie puste `focus_folders` znaczyło "cały vault" - jednorazowa migracja podnosi mu wtedy
  `guidance_mode` na `true` i zapisuje plik z `access_policy_version: 2`. Piszesz profil
  ręcznie i chcesz "zero dostępu"? **Dopisz `access_policy_version: 2`**, inaczej migracja
  nadpisze jawne `false`. Szczegóły: `core/SECURITY.md` i `modules/agents/CLAUDE.md`.
- `admin_access:true` jest osobnym, świadomym przełącznikiem do bebechów vaulta
  (`.pkm-assistant`, `.obsidian`, `.trash`, No-Go, pliki chronione).
- Autonomia reguluje pytania, nie możliwości. Pełna swoboda wymaga jednocześnie:
  włączonych narzędzi, `admin_access:true` i autonomii `yolo`.
- W trybie `edge`: zielone akcje nie pytają, żółte respektują przełączniki,
  czerwone zawsze pytają. Nieznane i zewnętrzne narzędzia są czerwone.

---

## Zewnętrzne serwery MCP - model zaufania

Zewnętrzny serwer MCP to **cudzy program** (transport `stdio` - proces na komputerze usera)
albo **cudza usługa w sieci** (transport `http`). Plugin nie ma jak go ograniczyć od środka -
może tylko pilnować granicy między nim a userem. Poniżej podział: co gwarantuje plugin,
a co zostaje na głowie usera.

### Co GWARANTUJE plugin

- **Każde narzędzie zewnętrznego serwera jest RED - zawsze.** Rejestrujemy je z
  `source:'user'`, a `classifyToolRisk` daje wtedy czerwone światło niezależnie od tego, co
  serwer o sobie deklaruje. Czerwone = **pierwsze użycie zawsze pyta**.
- **"Zawsze zezwalaj" działa per KONKRETNE narzędzie**, nie hurtem na serwer. Reguła zapisuje
  się jako `external.call::<serwer>__<narzędzie>` - zgoda na "pokaż scenę" nie jest zgodą na
  "uruchom kod".
- **Modal approvalu pokazuje PEŁNE argumenty wywołania** (sformatowany JSON, przycinany przy
  ~1500 znakach). User zatwierdza konkretne dane, nie samą nazwę narzędzia.
- **Tożsamość i wewnętrzne znaczniki nie wychodzą na zewnątrz.** Wszystko z prefiksem
  `_invocation` (nazwa agenta, głębokość delegacji, przyszłe znaczniki) jest odcinane przed
  wysyłką - cudzy serwer nie dowiaduje się, kto i z którego poziomu go woła.
- **Timeouty per wywołanie** - 60 s domyślnie, sufit 180 s. Zawieszony serwer nie zawiesza
  pluginu.
- **Statusy połączeń żyją w pamięci, nie w `data.json`** - plik konfiguracji trzyma wyłącznie
  to, co ustawił user.
- **Kill-switch per serwer.** Przełącznik w Ustawieniach → Serwery MCP wyłącza serwer bez
  kasowania konfiguracji: narzędzia natychmiast znikają z rejestru (rozłączenie), "Połącz"
  jest zablokowane, autostart go pomija.
- **Podgląd narzędzi przed zapisem.** W oknie dodawania serwera guzik "Sprawdź połączenie
  i pokaż narzędzia" łączy się jednorazowo, listuje narzędzia i **zamyka połączenie** - user
  widzi, co dokładnie dostanie agent, zanim cokolwiek trafi do konfiguracji. Nic nie jest przy
  tym rejestrowane.
- **Opt-in per agent.** Serwer działa tylko dla agentów, którym go przypniesz
  (profil → Umiejętności → Konektory, pole `mcp_servers[]`). Domyślnie: żaden. Sprawdza to
  również punkt wykonania - opt-in nie jest wyłącznie filtrem widoczności, narzędzie
  niepodpiętego serwera nie da się wywołać po nazwie.

### Co jest NA GŁOWIE USERA

- **`stdio` = proces z uprawnieniami usera, na jego komputerze.** Może czytać i kasować pliki
  poza vaultem, sięgać do sieci, robić co chce - dokładnie jak każdy program, który sam
  uruchomisz. Żaden approval w pluginie tego nie ogranicza; approval decyduje tylko o tym, czy
  agent go **zawoła**.
- **`http` = dane rozmów lecą do zdalnej usługi.** Wszystko, co agent wstawi w argumenty
  (fragmenty notatek, treść pytania), zobaczy właściciel tego serwera.
- **Sekrety w konfiguracji.** Komenda + `env` (stdio) oraz URL + nagłówki (http) potrafią nieść
  tokeny. Trzymamy je w ustawieniach pluginu (`data.json`), **nie** w vaulcie - świadomie, żeby
  nie synchronizowały się przez chmurę razem z notatkami. Kopia zapasowa `data.json` to kopia
  sekretów.
- **Instaluj tylko z zaufanych źródeł.** Serwer MCP to nie wtyczka w piaskownicy - to
  pełnoprawny program. Nie dodawaj serwera, którego autora i kodu nie umiesz wskazać.

## Strażnicy delegacji i poczty agentów

Agent może wołać innych agentów (delegacja) i pisać do nich (poczta). Bez bezpieczników obie
drogi potrafią się rozpędzić w pętlę - kosztowną i trudną do zatrzymania. Stąd limity:

**Delegacja (`delegate`)**
- **Limit głębi:** domyślnie **1** poziom (sufit ustawienia: 3). Sub-agent nie deleguje dalej -
  odmowa jest twarda, w narzędziu. Głębokość jedzie w zaufanym znaczniku wstrzykiwanym przez
  runtime (`_invocationDelegationDepth`), model nie ma jak jej podrobić.
- **Limit równoległości:** domyślnie **5** zadań w jednym wywołaniu (`max_parallel_delegations`).
- **Zakres sub-agenta = PRZECIĘCIE z dostępem rodzica.** `scope.folders` sub-agenta nigdy nie
  poszerza uprawnień - tylko je zawęża. Przecięcie tnie także **wyniki**: `search`/`list`
  nie oddają subowi ścieżek ani fragmentów spoza jego kąta (bez tego plik byłby nieotwieralny,
  ale jego istnienie i excerpt mogłyby wyciekać). `.pkm-assistant/**` zostaje poza zasięgiem, a
  `admin_access` rodzica **nie** zwalnia z tej bariery (fail-closed).
- **Przecięcie obowiązuje też PIĘTRO NIŻEJ.** Gdy sub zleca dalej (`max_delegation_depth` ≥ 2),
  wnuk dostaje **przecięcie** zakresu foldera i whitelisty narzędzi z tym, co ma sub
  ZLECAJĄCY - nigdy z tym, co ma agent główny. Zakresy rozłączne = odmowa delegacji.

**Wyjście na sieć (`web_search` / `web_read`)**
- **Osobna zgoda dla każdego.** `web_read` ma własny typ akcji (`web.read`), własny
  przełącznik w profilu agenta i własny opis w oknie zgody - nie dzieli ich z `web_search`,
  więc odklikanie "Wyszukiwanie w internecie" nie zdejmuje pytania z pobierania adresu
  wskazanego przez model. Domyślnie **oba pytaj**; wyciszenie jednego nie wycisza drugiego,
  a trwała reguła "Zawsze zezwalaj" zapada osobno dla każdego.
- **Bramka proweniencji adresu** (`isUrlKnown`) stoi niezależnie od zgody: `web_read` otworzy
  wyłącznie adres, który wpisał człowiek albo który wrócił z `web_search` w tym uruchomieniu.

**Poczta agentów (`kom_send`)**
- **Rate-limit:** domyślnie **20 wiadomości / 10 min per para nadawca→adresat**
  (`kom_send_rate_max`, edytowalne w Ustawieniach → Limity). Licznik żyje w pamięci -
  restart pluginu czyści konto, bo to bezpiecznik rozpędzonej sesji, nie kwota dzienna.
- **Licznik odbić (hop):** wiadomość niesie licznik przeskoków; przy **3** `kom_send` odmawia
  i każe oddać sprawę userowi. Łańcuch A→B→C→A zatrzymuje się sam.
- **Niewidzialność duchów nienaruszona.** Limity liczą się dopiero dla adresatów, których agent
  i tak widzi - odmowa nigdy nie zdradza, że istnieje agent ukryty przed nadawcą.
- **User nie podlega żadnemu z tych limitów** - dotyczą wyłącznie narzędzia agenta, nie
  panelu komunikatora.

---

## Granica dane/instrukcje w prompcie - ogrodzenie treści

Agent czyta pliki vaulta, strony WWW i odpowiedzi serwerów MCP. Nic z tego nie pisał operator,
więc nic z tego nie może być instrukcją. Granicę trzyma **jedna funkcja** -
`fenceUntrusted(content, source)` z `core/security/promptFence.ts`:

- Treść wchodzi do system promptu w bloku `<vault_content source="…">…</vault_content>`.
- **Znacznika nie da się zamknąć od środka** - `<vault_content` i `</vault_content` z wnętrza
  treści są escapowane do `&lt;…`. Bez tego wpis w pamięci zaczynający się od
  `</vault_content>` kończyłby ogrodzenie przedwcześnie, a reszta ładunku stałaby w prompcie
  jako zwykły tekst systemowy.
- **Trzy kanały idą przez to samo ogrodzenie:** pamięć agenta (`brain.md` + indeks `brain/`),
  indeks artefaktów (`status`/`typ` z frontmattera notatek vaulta) i Oczko (aktywna notatka:
  nazwa, frontmatter, do 2000 znaków treści).
- **Model wie, że ogrodzenie istnieje** - mówi mu o tym sekcja "Bezpieczeństwo treści" w prompcie.

**Co NIE jest ogradzane, bo jest zaufane:** reguły domenowe z yamla agenta
(`.pkm-assistant/agents/*.yaml`) i opisy folderów z mapy vaulta - pisze je operator, a katalog
`.pkm-assistant/**` jest poza zasięgiem narzędzi agenta.

⚠️ **Czego to NIE gwarantuje:** ogrodzenie jest deklaracją dla modelu, nie sandboxem. Model może
je zignorować. Realną granicą pozostają uprawnienia narzędzi, approval i whitelisty folderów -
ogrodzenie ma sprawić, że wstrzyknięta treść nie wygląda jak polecenie systemowe, a nie że model
na pewno jej nie posłucha.

---

## `npm audit` a to, co naprawdę jedzie do usera

`npm audit` bywa zgłasza podatności w zależnościach - żadna z nich nie musi trafić do pliku,
który dostaje użytkownik (`dist/main.js`). Rozbicie ryzyka wg pochodzenia zależności:

| Pochodzenie | Czy jest w bundlu |
|---|---|
| Narzędzia DEV (`ava`, `eslint`/`glob` i podobne) | **nie** - nic z łańcucha budowania/testów wchodzi do `dist/` |
| Zależności **serwerowej** strony `@modelcontextprotocol/sdk` (`express`, `hono`, zależności `express-rate-limit`) | **nie** - plugin używa wyłącznie strony **klienckiej** SDK (`ExternalMcpManager` importuje `client/index.js`, `client/stdio.js`, `client/streamableHttp.js`), więc esbuild nie wciąga modułów serwera i całe `express`/`hono` wypada z drzewa przy budowaniu |

**Jak to sprawdzić samemu** (po `npm run build`) - dla każdego pakietu z gałęzi serwerowej SDK
sprawdź, czy jego nazwa w ogóle występuje w bundlu:

```bash
for p in hono ip-address Address4 express-rate-limit brace-expansion body-parser express; do
  printf '%-20s %s\n' "$p" "$(grep -c -F "$p" dist/main.js)"
done
# oczekiwany wynik: każda linia = 0
```

Sam kliencki kod SDK **jest** w bundlu (widać w nim m.in. stałe protokołu MCP) - to on
rozmawia z zewnętrznymi serwerami. Podatne moduły serwerowe zostają poza nim.

Tabelę realnego ryzyka warto przeliczyć przy każdej aktualizacji SDK i przed każdym
zgłoszeniem do katalogu (walidator katalogu liczy `npm audit` osobno).

⚠️ Osobna sprawa, NIE objęta tym wpisem: serwer MCP uruchomiony przez usera na transporcie
`stdio` to samodzielny proces systemowy z własnymi zależnościami. Jego podatności nie widzi
ani `npm audit` tego repo, ani ten plik - patrz sekcja "Zewnętrzne serwery MCP - model zaufania".

---

## Co jest bezpieczne

- Klucze API nie w kodzie, nie w repo
- AccessGuard chroni .obsidian i .trash (SYSTEM_NO_GO; wyjątek tylko dla jawnego admina)
- Zewnętrzne serwery MCP: RED bezwarunkowo + approval per narzędzie + pełne argumenty
  w modalu + kill-switch per serwer + opt-in per agent (szczegóły w sekcji "model zaufania")
- keySanitizer maskuje klucze w logach
- Agenci nie mogą czytać plików poza vaultem Obsidiana **wbudowanymi narzędziami** (także
  z `admin_access` - `sanitizePath` trzyma je vault-relative)
- Wbudowane narzędzia nie dają dostępu do systemu plików OS ani do uruchamiania programów;
  sieć tylko przez jawne API (modele, web search). ⚠️ **Wyjątek świadomy:** zewnętrzny serwer
  MCP na transporcie `stdio` to osobny proces systemowy uruchomiony przez usera - jego
  możliwości ogranicza system operacyjny, nie plugin
