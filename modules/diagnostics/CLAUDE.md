# modules/diagnostics

Lokalna diagnostyka urządzenia na desktopie i telefonie (M1 P3, kontrakt D1/D2).
Osobny moduł, bo to samodzielna funkcja, nie infrastruktura core ani część rozmowy.

## Struktura i publiczne API

- `index.ts`: jedyne drzwi. `runDeviceDiagnostics`, `probeConnection`, `BUILD_MARKER`,
  `DiagnosticsConsentModal`, `showDiagnosticReport`, typy `DiagnosticInput`,
  `DiagnosticReport`, `ConnectionResult`.
- `StartupTimer.ts`: czysty licznik, eksporty `StartupTimer` i zamknięty typ
  `StartupPhase`. Konstruktor `(now, startedAt = now())` rozpoczyna pomiar;
  `mark(phase, at?)` zamyka przedział, `snapshot()` zwraca niezależną migawkę
  częściowych czasów w ms. Opcjonalne `at` pozwala współdzielić końcową próbkę
  zegara z dotychczasowym `plugin.startupMs`. Brak Obsidiana, Node oraz I/O.
- `diagnostics.ts`: sprawdzenia przez wstrzyknięty adapter i migawkę platformy,
  zapis raportu, status/czas/szczegół oraz liczniki. Bez Obsidiana i Node w logice.
- `values.ts`: zamknięty słownik nazw faktów/możliwości i walidacja ich wartości.
- `report.ts`: stałe objaśnienia i18n, składanie Markdown, dokładne usuwanie znanych
  sekretów z ustawień. Nie jest publicznym API ani redaktorem dowolnego tekstu.
- `connection.ts`: jedno `buildRequest(..., true)` przez transport runtimeConfig,
  limit 30 s, bez ponowień, narzędzi, promptu agenta i historii. Zwraca strukturę,
  nigdy komunikat wyjątku/odpowiedzi. Mierzy surowe porcje (również ciało błędu HTTP),
  pierwszą porcję i całkowity czas, nie tokeny modelu.
- `ui.ts`: zgoda na test połączenia z dwoma przyciskami 48 px; zamknięcie/abort anuluje raport.
  `decision`: true = test i zapis, false = zapis lokalny, null = anulowanie. Po zapisie
  Notice i modal pokazują liczniki i ścieżkę raportu; przycisk kopiuje gotowy Markdown.
- `buildInfo.ts`: define `__PKM_BUILD__` z esbuild (hash + UTC), bez builda `dev`.
  Watch dopisuje `watch`, ponieważ hash i czas opisują start kontekstu.

## Zamknięty słownik - granica prywatności D1

Raport nie przyjmuje wolnego tekstu błędów adaptera, treści odpowiedzi/błędów
modelu, nagłówków ani adresów żądań. Nie próbuje rozpoznawać w nich sekretów regexem.
Dopuszcza wyłącznie poniższe źródła i kształty; nieznane nazwy w `facts` oraz
`capabilities` są pomijane, brak/niewłaściwy kształt faktu daje `Unavailable` i skip.

- Stałe nazwy sprawdzeń, etykiety i teksty i18n pluginu, status `ok/error/skipped`.
- Flagi wyłącznie boolean; czasy/liczniki wyłącznie skończone nieujemne liczby
  zaokrąglane do całkowitych. Rozmiar okna: dwie liczby do 6 cyfr rozdzielone `x`.
  Wzorzec rozmiaru pozostaje celowo: composition root składa go z liczbowych
  `innerWidth/innerHeight`, a granica odrzuca wszelkie dopiski i wolny tekst.
  To ograniczony pomiar wymiarów, nie identyfikator ani pole błędu.
- Czas całkowity `plugin.startupMs` oraz siedem liczbowych faktów U11:
  `startup.layoutWaitMs`, `startup.runtimeMs`, `startup.secretsMs`, `startup.skinMs`,
  `startup.agentsMs`, `startup.toolsMs`, `startup.finishMs`. Ten sam format liczby;
  brak, string, Infinity i liczba ujemna dają `Unavailable`, obce nazwy są pomijane.
- Wersje pluginu i API Obsidiana: trzy człony po 1-5 cyfr, opcjonalny sufiks
  `-`/`+` i 1-32 znaków `[A-Za-z0-9.-]`, łącznie do 64 znaków.
- Build: `dev` albo 7-40 małych cyfr hex, opcjonalnie spacja i czas UTC
  `YYYY-MM-DDTHH:mm:ss.sssZ`, opcjonalnie ` watch` po czasie.
- `navigator.userAgent`: pierwsze 300 znaków, z tego tylko drukowalne ASCII.
  To wyjątek dla identyfikacji silnika, nigdy detektor platformy ani miejsce na log.
- `vault.configDir`: jedna nazwa do 64 znaków `[A-Za-z0-9._ -]`. Ścieżki i inne
  kształty dają brak wartości; nie wyciągamy z nich prywatnej nazwy końcowej.
- Status embeddingu: `idle/disabled_mobile/no_provider/building/ready/error`.
- Dostawca: wyłącznie identyfikator z `PROVIDER_INFO` modułu models. `provider.<id>`
  przyjmuje boolean obecności klucza; tekst `Key set` powstaje dopiero w module.
- Model: po oddzieleniu dostawcy pełne dopasowanie do
  `^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$`; inaczej stały tekst i18n
  `niestandardowy identyfikator`. Nieznany dostawca też daje ten zamiennik.
- Błąd lokalny: tylko `name` i `code`, dwa osobne, jawne zbiory literałów
  w `values.ts`. Klasy JS/DOM oraz `HttpTransportError`; kody errno i trzy kody
  transportu pluginu (`aborted/timeout/transport`). Dokładne dopasowanie zachowuje
  wielkość liter, bez wzorców, prefiksów i podciągów; reszta daje `unknown`.
  Liczbowy `code` dopuszcza wyłącznie liczby całkowite 0-999 (nie string liczby).
  Nie zgadujemy kodów Filesystem Capacitora: nieznane pozostają `unknown` do
  sprawdzenia literałów adaptera używanego na prawdziwym telefonie.
  Wewnętrzna niezgodność odczytu ma własny typ i stałe objaśnienie;
  cudzy `message` nigdy nie jest odczytywany.
- Połączenie: rodzaj z wyniku transportu (`transport/timeout/aborted/http`),
  status HTTP i liczniki. Rozpoznany błąd dekodera to `provider`; brak porcji lub
  zdarzeń modelu to odpowiednio `empty_stream/invalid_stream`. Kod/typ dostawcy
  z pól `type/code` dekodera (także jego `details`) albo JSON odpowiedzi HTTP musi
  należeć do jawnego słownika typów Anthropic, OpenAI/zgodnych i Gemini w
  `values.ts`, z dokładną wielkością liter. Nieznana wartość daje wewnętrzne
  `unknown`, a w raporcie stałe i18n `inny` / `other`; brak obu pól pomija etykietę.
  `type` ma pierwszeństwo przed `code`. Dla dekoderów pierwszeństwo ma zachowany
  obiekt źródłowy `details`, aby syntetyczne `code: UNKNOWN` z normalizacji nie
  zasłaniało oryginalnego typu ani nie udawało obecności typu w odpowiedzi.
  Ogólny `type:error` koperty nie zastępuje odrzuconego typu z pola `error`.
  Status/rodzaj dobiera stałe objaśnienie (401/403, 404, 429, 5xx, sieć/CORS,
  timeout, abort, błędny strumień). Żadnego wnioskowania z treści komunikatu.

Walidacja odrzuca też końcowy newline (samo `$` w JavaScript mogłoby go dopuścić).
Zgodny kształt to nie dowód, że identyfikator jest publiczny: np. niestandardowa
nazwa modelu nadal może mieć znaczenie dla użytkownika. Nie obiecujemy anonimizacji
wszystkich poprawnych identyfikatorów ani nazwy folderu konfiguracji.

Druga warstwa usuwa dokładne wystąpienia sekretów z ustawień o długości >= 8
(klucze, tokeny, hasła, autoryzacja, cookies, headers/env, także nieenumerowalne
klucze po odblokowaniu). Krótszych wartości nie wyszukuje, nie koduje wariantów,
nie stosuje wzorców do tekstu. Słownik powstaje raz na przebieg; obiekty cykliczne
nie powodują rekurencji bez końca. Znacznik `[REDACTED]` jest stałym zamiennikiem.
Filtrowanie obejmuje szczegóły i końcowy Markdown, także przed escapowaniem tabeli.

**Rozszerzenie raportu wymaga nowej jawnej nazwy/źródła, wzorca pełnego kształtu
lub zamkniętego słownika i testu literalnych wartości poprawnych oraz odrzuconych
w zapisanym raporcie.** Nie dodawaj `message`, `String(error)`, serializacji błędu,
URL-a ani ogólnego pola `detail` do kontraktu połączenia. **Trzy pola błędów D2
rozszerzamy wyłącznie przez nowy literał w odpowiednim zbiorze `values.ts` oraz
test literalnego wyniku w zapisanym raporcie (także odrzucenia wariantu spoza
słownika).** Literał musi mieć potwierdzenie w dokumentacji API albo kodzie
adaptera/transportu; nie wystarcza jego kształt. Nowy kod błędu musi pochodzić
z pola struktury, nigdy z regexu nad komunikatem. Dostawca dostaje logger
zamieniający jego wpisy na stałe zdarzenie diagnostyczne; główny catch loguje tylko
stałą informację o braku zapisu. Nie zmieniamy logowania zwykłej rozmowy.

## Zachowane decyzje i granice

D1/D2 świadomie zmienia zawartość diagnostyki na obu platformach. Zwykła rozmowa,
transport core i dekodery dostawców pozostają bez zmian. Composition root zbiera
flagi wyłącznie z Obsidian `Platform`, rejestruje komendę po ustawieniu języka
oraz mierzy start od `onload` do `_ready`. Informacje w core dostają build i callback
przez plugin. Komenda działa także przed pełną gotowością (braki są oznaczone).
Jeden aktywny bieg na instancję; unload zamyka zgodę i przerywa transport.

U11 mierzy oba urządzenia tym samym zegarem `performance.now()`. `layoutWaitMs`
biegnie od pierwszej linii `onload` do wejścia w `initialize`: to oczekiwanie na
Obsidiana, nie czas samej inicjalizacji pluginu (obejmuje też rejestracje w onload
i ewentualny boot runtime w tle). Kolejne granice następują po:
`runtimeMs` - migracji folderu, `env.whenLoaded()` i `ensureGitignoreEntries`;
`secretsMs` - logach, trace, rejestrze subów i odblokowaniu sejfu;
`skinMs` - kolorze użytkownika i SkinManager;
`agentsMs` - migracji modeli, sprawdzeniu embeddingu i AgentManager;
`toolsMs` - ArtifactStore, AccessGuard, uruchomieniu indeksatora bez await,
narzędziach, draft runtime i całym bloku MCP (w tym await ServerManager);
`finishMs` - menu, release notes i motywie, przed `_ready`.
Prace uruchomione w tle nadal nie są oczekiwane przez start. Nie zmieniono
kolejności wywołań ani obliczenia czasu całkowitego. Suma kompletnych faz jest
równa `plugin.startupMs` z dokładnością niezależnych zaokrągleń do ms.
Pierwszy `mark` danej fazy wygrywa: duplikat jest idempotentny i nie przesuwa
granicy kolejnej fazy. U12 zamyka fazy SkinManager, AgentManager i MCP pierwszą
instrukcją po ich try/catch, również po złapanym wyjątku: czas nieudanej próby
należy do jej fazy, a nie do następnej. Liczba mierzy czas, nie sukces inicjalizacji.
Brak znacznika oznacza brak wartości, nigdy zero. W produkcyjnym starcie oznacza
to, że wykonanie nie doszło do granicy fazy ani do kolejnych granic. Sam licznik
nadal liczy każdy przedział od ostatniej zapisanej granicy.
PL/EN dodają stałe objaśnienie rozdziału oczekiwania na Obsidiana i pracy pluginu.

Kryptografia używa świeżego `SecretsStorage(null)`, testowego hasła/próbki i `lock`
w finally, bez sejfu użytkownika. Test plików weryfikuje odczyt, append, stat,
rename/list/remove i sprząta wyłącznie własny `tmp-<id>` w finally. Rekurencyjny
rmdir jest wymagany przez adapter Obsidiana także dla pustego folderu. Awaria
sprzątania jest błędem. Awaria zapisu raportu daje stały komunikat UI/logu.
Raport trafia do `.pkm-assistant/diagnostics/`, z datą UTC, losowym sufiksem i
platformą. Synchronizacja zależy od użytkownika; nie zmieniamy gitignore vaulta.

Sukces połączenia wymaga zdarzenia treści/rozumowania albo poprawnego końca,
również z `finish()`. HTML 200, keepalive i obcy JSON są błędem. Test świadomie
wymusza stream także dla xAI (zwykły czat celowo używa complete z powodu CORS).
Bez zgody nie wykonuje się ścieżka dostawcy. Brak AbortController pomija sieć,
a diagnostyka lokalna może zapisać raport. Istnienie `require` jest wyłącznie
flagą, nigdy go nie wywołujemy.

## Testy

- `StartupTimer.test.ts`: literalne czasy i suma, pominięte fazy, duplikaty,
  zaokrąglenia i nieujemność, wspólne próbki początku/końca oraz izolacja migawki.
- U11 w `diagnostics.test.ts`: siedem liczb w zapisanym raporcie, odrzucenie
  string/Infinity/ujemnej/braku, pomijanie obcej nazwy i objaśnienie PL/EN.
  `src/main.mobile.test.ts`: kontrolowany zegar licznika i literalne wiersze faz
  przez produkcyjną komendę raportu na desktopie, mobile i bez AbortController.
- U12 w `src/main.mobile.test.ts`: produkcyjne `onload()` i `initialize()` przez
  callback layoutu na atrapie hosta z harnessu; czas przesuwany przez pracę
  zależności, bez oznaczania faz w teście. Na desktopie i mobile zapisany raport
  musi zawierać siedem literalnych czasów i czas całkowity, zarówno po udanym
  starcie, jak i po SkinManager rzucającym po 10000 ms (AgentManager nadal 50 ms).
  Zegar `performance.now` jest przywracany po każdym przypadku.
  U13 dodaje na obu platformach awarie AgentManager i MCP po 10000 ms, sprawdzając
  w zapisanym raporcie siedem literalnych faz i czas całkowity oraz brak
  przeniesienia czasu awarii do następnej fazy.
- `diagnostics.test.ts`: odczyt pliku z adaptera RAM, kolejność i liczniki,
  kryptografia, awarie rename/mkdir/rmdir, brak append i cichy błąd dopisania,
  izolowane sprzątanie i odmowa bez żądania. D1: prywatny komunikat EACCES znika
  w całości, 401 z produkcyjnego transportu, walidacja faktów/modelu/configDir,
  odrzucenie klas/kodów, stałe objaśnienia, krótkie i nieenumerowalne sekrety,
  długie komunikaty oraz mediana kosztu składania raportu z 30 sekretami < 50 ms
  (bez kryptografii/I/O, rozgrzane serie ograniczają wpływ planisty/GC).
  D2: `reviewsession849201` w `name/code` i getterach, osobne słowniki klas/kodów,
  granice liczbowego kodu, wielkość liter, kody transportu pluginu, token `sk-ant`
  w `type/code` przez produkcyjny transport i dekoder Anthropic (401 i SSE 200).
  W zapisanym pliku i Markdown sprawdzane są brak sekretu i dodatni, stały wynik
  PL/EN `inny/other`; poprawne `Error/EACCES/authentication_error` pozostają.
- `connection.test.ts`: prawdziwy FetchStreamTransport i dekodery, dwie porcje,
  jedno krótkie żądanie, brak retry na 429, błędy HTTP i HTTP 200, typy poprawne
  i odrzucone, HTML/keepalive/obcy JSON, EOF NDJSON, abort, timeout, izolacja loggera.
  D2: zachowanie wielkich liter w `RESOURCE_EXHAUSTED` i odrzucenie
  `Authentication_Error`; odrzucony typ daje `unknown`, brak typu nadal `null`.
- `ui.test.ts`: zgoda, odmowa, zamknięcie, abort i spóźnione kliknięcie.
- `src/main.mobile.test.ts`: composition root desktop/mobile i brak AbortController.
  `core/diagnosticsSettings.test.ts`: wersja/build i przycisk. `utils/buildMarker.test.ts`:
  hash/czas, brak git i transform esbuild define bez builda pluginu.

AVA nie rozstrzyga działania CapacitorAdapter, CORS, WebCrypto/strumienia w WebView,
schowka ani wydajności prawdziwego telefonu.

## Mobile M2 D6 - ślady konfliktu pamięci

Zamknięty słownik przyjmuje sześć nowych faktów: `memory.conflict.state`,
`memory.conflict.brain`, `memory.conflict.sessions`, `memory.conflict.costLog`,
`memory.conflict.unreadable`, `memory.conflict.skipped`. Wyłącznie skończone
nieujemne liczby, z dotychczasowym zaokrągleniem liczników; stringi, null, booleany,
Infinity i ujemne wartości dają Unavailable, nieznane nazwy są pomijane.
Źródłem jest `scanMemoryConflicts` modułu memory, mapowany w composition root.
Nie przekazujemy nazw agentów, ścieżek, treści plików ani błędów adaptera.

Opcjonalny callback `DiagnosticInput.memoryFacts` jest wywołany raz po wyborze
zapisu raportu. D6b: lokalny przegląd tylko do odczytu jest zwykłą częścią raportu,
bez osobnej zgody ani ścieżki pominięcia. Oba przyciski uruchamiają przegląd;
wyłącznie przycisk połączenia zatwierdza sieć. Pierwszy akapit PL/EN pyta o test
połączenia (tekst sprzed D6), drugi, osobny `diagnostics.memory_notice`, krótko
informuje o liczbach z pamięci. Istniejący układ i przyciski 48 px pozostają bez
zmian CSS; akapity używają zwykłego przepływu treści modala.

Zamknięcie/abort daje null, odróżniony od false przy zapisie bez sieci. Composition
root przerywa wtedy callback zgody i cały bieg przed przeglądem i zapisem raportu,
bez powiadomienia o błędzie. Spóźnione kliknięcie nie zmienia decyzji. Przed oknem
nadal wykonują się dotychczasowe lokalne próby diagnostyczne i sprzątanie plików
próbnych. Usunięto osobną flagę `memoryScanApproved`. Wyjątek przeglądu daje
unavailable dla unreadable, bez treści błędu; reszta raportu i test połączenia
działają dalej. Nie ma skanu na starcie ani przy imporcie modułu.

Nowa sekcja PL/EN jest ZA dotychczasową tabelą, z niezmienioną kolejnością jej
wierszy. Ma własną tabelę liczników, opis zakresu i jedno podsumowanie. Wszystkie
sześć zer daje zdanie o braku śladów w sprawdzonej pamięci. Brak faktu, błąd albo
pominięcia bez znalezionych śladów daje jawnie niepełny wynik, nigdy zapewnienie
o czystej pamięci. Wynik dodatni podaje sumę czterech grup i objaśnia naprawę
obsługiwanych konfliktów przy użyciu po kopii do stałego `.pkm-assistant/backups/`;
koszty są tylko tolerancyjnie czytane, nierozwiązywalne konflikty wymagają uwagi.
Stały tekst odróżnia przykłady w wiadomościach od rzeczywistych konfliktów oraz
podaje limit 50 sesji i próg 1 MiB; unreadable obejmuje pliki i foldery, skipped
pliki poza limitami. Szczegóły kosztu i wyścigów metadanych: dokumentacja memory.

Testy D6 w `diagnostics.test.ts` sprawdzają literalne sekcje PL/EN (zera i wartości
dodatnie), odrzucenie nieznanej nazwy i nieliczbowych wartości, niepełny pomiar,
kolejność zgoda -> callback oraz zapis raportu mimo awarii callbacku, bez wycieku.
`ui.test.ts` sprawdza literalne teksty PL/EN w dwóch osobnych akapitach, decyzję
obu przycisków, anulowanie przez zamknięcie/abort i ignorowanie spóźnionych kliknięć.
D6b w `src/main.mobile.test.ts` wykonuje prawdziwą komendę dla obu przycisków,
zamknięcia i unload na desktopie, mobile oraz bez AbortController: jeden przegląd
na zapis, literalny licznik w raporcie, nienaruszone bajty źródła, brak przeglądu,
zapisu i sieci po anulowaniu oraz skuteczny kolejny zapis po anulowaniu.
Test produkcyjnego startu w `src/main.mobile.test.ts` mierzy odczyty plików kontrolnych
na obu platformach: zero przy starcie, po jednym po wyborze lokalnego raportu.

## Mobile M4 F2e - wynik startu kopii roboczych

Composition root przekazuje migawkę istniejącej pracy startowej, bez nowych I/O.
`drafts.available` pozostaje w dotychczasowym miejscu. Nowe fakty mają osobną
sekcję ZA sekcją pamięci, żeby zachować kolejność wszystkich starszych wierszy
oraz sekcji. Sekcja pojawia się, gdy wejście zawiera nowe fakty kopii (produkcyjna
komenda zawsze je przekazuje). Stałe objaśnienie PL/EN odróżnia gotowy magazyn od
wyłączonych zapisów na podstawie pary `drafts.available` i `drafts.stage`.
F2f: tylko true + ready potwierdza zapisy; false + poprawny etap inny niż ready
potwierdza wyłączenie i podaje etap ostatniej próby startu. Sprzeczność lub brak
którejkolwiek wartości daje stałe zdanie o niespójnym/niepełnym wyniku, również
po nieudanej ponownej próbie z zachowanym runtime.

- `drafts.stage`: wyłącznie `not-started/registry/ports/presence/restore/cleanup/register/ready`,
  dokładne dopasowanie całego tekstu; reszta daje `Unavailable` i skipped.
  F2f: ready ma status ok, każdy inny poprawny etap error i zwiększa licznik
  błędów raportu oraz Notice. Status i treść `drafts.available` są bez zmian.
- `drafts.error.name/code`: istniejące funkcje i zbiory D2 `errorName/errorCode`,
  bez drugiego słownika. Nieznana obecna wartość daje `unknown`, brak pola
  `Unavailable`. Liczbowy code zachowuje granice D2 (0-999, liczba całkowita).
- `drafts.recoveryIssues`: dotychczasowy format nieujemnego licznika, dopiero po
  zakończeniu restore (lub potwierdzonym pustym magazynie). To liczba issues,
  nigdy ich ścieżki ani komunikaty.
- `drafts.present`: boolean z istniejącego mobilnego `storagePresent`; brak wiedzy
  daje `Unavailable`, także na desktopie, gdzie nie dokładamy sondy istnienia.
- Barrel eksportuje `localErrorFields(error)` do odczytu surowych `name/code`
  dopiero przy składaniu faktów w komendzie diagnostyki. Start przechowuje w RAM
  referencję `unknown` do złapanej wartości, bez odczytu jej pól; dotychczasowe
  przekazanie do loggera pozostaje bez zmian. Bezpieczny odczyt daje `unknown`
  dla rzucającego gettera, brak pola nadal daje `Unavailable`. Nie czyta `message`.
  Synchroniczny getter, który nigdy nie wraca, może zatrzymać komendę diagnostyki,
  ale obserwacja diagnostyczna nie uruchamia go podczas startu.

Nowe próby są częścią dotychczasowego `try/finally` we własnym `tmp-<id>`, na obu
platformach, bez dostępu do namespace magazynu ani uruchamiania DraftStore.
Brak `readBinary` lub `writeBinary` daje skipped dla zależnych prób. Niepowodzenie
próby nie blokuje niezależnych prób; sprzątanie zawsze jest sprawdzane i jego
awaria nadal oznacza błąd. Nowe wiersze fs są po `fs.remove`, przed `fs.rmdir`.

Założenia portu adapterowego i pokrycie:

| Założenie | Sprawdzenie |
| --- | --- |
| Brak ścieżki to `stat === null`, bez wyjątku | `fs.statMissing` |
| Ukryci i zagnieżdżeni rodzice dają się utworzyć | istniejące `fs.mkdir`, nowe `fs.directory` (ukryty podfolder) |
| `stat.type` rozróżnia folder/plik; listing pokazuje bezpośrednie dzieci | `fs.directory`, `fs.binary`, `fs.renameNested`, istniejące `fs.list` |
| Binary read/write zachowują bajty i dokładny `stat.size` | `fs.binary`: 00 FF C3 28 80 41, także niepoprawny UTF-8 |
| Rename między folderami przenosi pełne bajty i usuwa źródło | `fs.renameNested`: readback, stat obu stron i listing celu |
| Remove usuwa binarium, listing od razu odzwierciedla usunięcie | `fs.binaryRemove`; tekst pokrywa istniejące `fs.remove` |
| Sprzątanie własnego katalogu działa rekurencyjnie | istniejące `fs.rmdir`, także po awariach |

Listingi nowych prób dopuszczają pełną ścieżkę albo samą nazwę, tak jak port
magazynu. SHA-256/Web Crypto pokrywa częściowo istniejące `crypto.roundtrip`
(PBKDF2/SHA-256 i AES-GCM); próby plików nie potwierdzają osobno digest/randomUUID.
Nie mierzymy zachowania rename po wyjątku, atomowości, trwałości po ubiciu procesu,
wyścigów z synchronizatorem, symlinków ani wydajności dużych plików. Port sam
weryfikuje wynik zapisu, lecz adapter nie zapewnia fsync ani blokady urządzeń.
Te ograniczenia F2 pozostają bez zmian i wymagają prób na fizycznym telefonie.

Testy F2e/F2f w `diagnostics.test.ts`: osiem etapów, poprawne i odrzucone pola w
zapisanym raporcie/Markdown, objaśnienia PL/EN, próbki binarne, przekłamane bajty
lub rozmiar, stat rzucający prywatny komunikat, brak metod binarnych, rename/remove
bez efektu, błędny typ folderu i pełne sprzątanie w każdym przypadku.
`src/main.mobile.test.ts` wykonuje produkcyjny start i komendę: ready obu platform,
ports obu platform, presence/EACCES oraz restore na mobile, literalne fakty,
brak prywatnego komunikatu, niezmienione I/O i desktopowy Notice.

F2f rozszerza testy objaśnień PL/EN o cztery kombinacje dostępności i gotowości
oraz brak każdej wartości. `src/main.mobile.test.ts` sprawdza produkcyjny start
z prawdziwym loggerem i getterami (zero odczytów przy starcie, po jednym przy
komendzie, literalne unknown lub TypeError/EACCES), propagację tej samej wartości
wyjątku każdego z trzech registerTool na obu platformach oraz raport po ponownej
nieudanej próbie. Test liczników wykonuje zapis i showDiagnosticReport:
ready = 18 OK / 0 errors, presence = 17 OK / 1 errors, także w treści Notice.
Dotychczasowe literalne ślady I/O pozostają bez zmian.

## Mobile M4 F2n - oczekiwanie na magazyn kopii (korekta F2o)

Komenda w src/main nie czeka na niewystartowany DraftStartupTask, także gdy start
pluginu zatrzymał się przed _ready. Dla rozpoczętego zadania czeka na ready najwyżej
DRAFT_DIAGNOSTIC_WAIT_MS = 5000 ms, przez hostWindow.setTimeout. Po sukcesie pobiera
stan końcowy, po limicie aktualną migawkę presence/restore/cleanup. Nie ma nowych
pól, statusów ani I/O na ścieżce startu; niegotowy etap zwiększa błędy według F2f.
Limit dotyczy bramki kopii, nie czasu własnych prób adaptera wykonywanych w raporcie.

Finally usuwa timer po sukcesie, limicie i anulowaniu; diagnosticController.abort
oraz unload od razu zwalniają oczekiwanie, również bez AbortController. Anulowana
komenda nie zapisuje raportu, a kontroler jest zwalniany dla kolejnego wywołania.
Delegate/sub_agent/subagent_changes celowo nadal czekają bez limitu na odzyskanie
magazynu; przy zawieszonym starcie diagnostyka pozwala zobaczyć jego etap.

Testy F2o w src/main.mobile.test.ts wywołują produkcyjną komendę na desktopie i
mobile, sterują wyłącznie timerem 5 s, odczytują raport z adaptera i sprawdzają
kolejny zapis, usunięcie timera oraz brak raportu po abort/unload. Nie mierzą
fizycznego WebView ani systemowego wstrzymywania timerów w tle.

## Mobile M4 S1a - podetapy fazy agentów

Composition root przekazuje migawkę `AgentManager.startupTimings` na obu platformach
bez pracy dyskowej przy starcie. Zamknięty słownik dodaje, w tej kolejności tuż po
`startup.agentsMs`:
`startup.agents.loadMs`, `startup.agents.memoryMs`, `startup.agents.memoryMaxMs`,
`startup.agents.memoryCount`, `startup.agents.memoryFailed`, `startup.agents.resourcesMs`,
`startup.agents.skillsMs`, `startup.agents.subAgentsMs`, `startup.agents.templatesMs`,
`startup.agents.artifactTypesMs`, `startup.agents.komunikatorMs`, `startup.agents.vaultMapMs`,
`startup.agents.playbooksMs`.

Te nowe fakty dopuszczają wyłącznie nieujemne liczby całkowite (integerFact):
ułamek, tekst, null, boolean, NaN, Infinity, liczba ujemna i undefined dają
skipped/Unavailable, bez interpolowania odrzuconej wartości. Nieobecny klucz jest
pomijany jak dotąd; komenda przekazuje wszystkie 13 kluczy także przed gotowością.
Stare fakty zachowują zaokrąglenia i bajty wierszy. Żadnych nazw agentów, ścieżek
ani treści błędów. Dodatkowe zdanie i18n PL/EN na górze raportu wyjaśnia, że
podetapy zasobów biegną równolegle i ich suma może przekraczać resourcesMs.

Źródło opisuje ostatnią próbę initialize, także po reload, podczas gdy agentsMs
nadal opisuje pierwszy start pluginu. Podetapy nie muszą sumować się do agentsMs:
ta faza obejmuje dodatkowo pracę composition root, a sam manager również watcher
oraz logowanie. Brak czasu gałęzi nie oznacza 0 ms. memoryMaxMs obejmuje tylko
pamięci zakończone powodzeniem; memoryFailed ujawnia częściowe niepowodzenie.
Obsługa wyjątków pozostaje własnością agents i nie zmienia się.

Testy S1a w diagnostics.test.ts sprawdzają zapisane literalne wiersze PL/EN,
komplet, częściowy pomiar, zerowe wartości, obce nazwy i odrzucenie niepoprawnych
kształtów dla każdego nowego faktu. main.mobile.test.ts rozszerza literalny raport
produkcyjnego startu i komendy o nowe wiersze, zachowując wszystkie stare wiersze,
czasy i asercje I/O. Zegar w testach nie mierzy wydajności Androida ani iOS;
wybór optymalizacji startu wymaga raportu z fizycznego telefonu.
