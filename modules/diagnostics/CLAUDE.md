# modules/diagnostics

Lokalna diagnostyka urządzenia na desktopie i telefonie (M1 P3, kontrakt D1/D2).
Osobny moduł, bo to samodzielna funkcja, nie infrastruktura core ani część rozmowy.

## Struktura i publiczne API

- `index.ts`: jedyne drzwi. `runDeviceDiagnostics`, `probeConnection`, `BUILD_MARKER`,
  `DiagnosticsConsentModal`, `showDiagnosticReport`, typy `DiagnosticInput`,
  `DiagnosticReport`, `ConnectionResult`.
- `diagnostics.ts`: sprawdzenia przez wstrzyknięty adapter i migawkę platformy,
  zapis raportu, status/czas/szczegół oraz liczniki. Bez Obsidiana i Node w logice.
- `values.ts`: zamknięty słownik nazw faktów/możliwości i walidacja ich wartości.
- `report.ts`: stałe objaśnienia i18n, składanie Markdown, dokładne usuwanie znanych
  sekretów z ustawień. Nie jest publicznym API ani redaktorem dowolnego tekstu.
- `connection.ts`: jedno `buildRequest(..., true)` przez transport runtimeConfig,
  limit 30 s, bez ponowień, narzędzi, promptu agenta i historii. Zwraca strukturę,
  nigdy komunikat wyjątku/odpowiedzi. Mierzy surowe porcje (również ciało błędu HTTP),
  pierwszą porcję i całkowity czas, nie tokeny modelu.
- `ui.ts`: zgoda z dwoma przyciskami 48 px; zamknięcie/abort to odmowa. Po zapisie
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
