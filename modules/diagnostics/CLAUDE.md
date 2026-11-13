# modules/diagnostics

M1 P3: lokalna diagnostyka urządzenia na desktopie i telefonie. Osobny moduł,
bo to samodzielna funkcja, a nie infrastruktura core ani część rozmowy.

## Struktura i publiczne API

- `index.ts`: jedyne drzwi. `runDeviceDiagnostics`, `diagnosticRedactor`,
  `probeConnection`, `BUILD_MARKER`, `DiagnosticsConsentModal`, `showDiagnosticReport`
  oraz typy `DiagnosticInput`, `DiagnosticReport`.
- `diagnostics.ts`: logika bez Obsidiana/Node, adapter i migawka platformy wstrzykiwane.
  Wynik zawiera status, czas i szczegół każdego sprawdzenia, Markdown oraz liczniki.
- `connection.ts`: jedno żądanie `buildRequest(..., true)` dostawcy przez transport
  z runtimeConfig. Limit 30 s, bez ponowień, narzędzi, promptu agenta i historii.
  Mierzy surowe porcje transportu (także ciało błędu HTTP), a nie tokeny modelu.
  Dekoder dostawcy rozpoznaje błędy w strumieniu HTTP 200. Treści odpowiedzi nie zapisuje.
- `ui.ts`: zgoda z dwoma przyciskami 48 px, zamknięcie/abort oznacza odmowę;
  po zapisie Notice i modal z kopiowaniem gotowego, zamaskowanego raportu.
- `buildInfo.ts`: define `__PKM_BUILD__` z esbuild (hash + UTC), bez builda `dev`.

## Decyzje i granice

Composition root zbiera stan oraz flagi wyłącznie z Obsidian `Platform`, rejestruje
komendę po ustawieniu języka i mierzy start od wejścia w `onload` do `_ready`.
`navigator.userAgent` jest wyłącznie informacją o silniku, nigdy detektorem platformy.
Sekcja Informacje w core dostaje build i callback przez plugin; core nie importuje modułu.
Przycisk i komenda są dostępne również przed pełną gotowością (braki oznaczone).
Jeden aktywny bieg na instancję; unload odmawia oczekującej zgody i przerywa transport.

Kryptografia używa świeżego `SecretsStorage(null)`, testowego hasła/próbki oraz `lock`
w finally. Nigdy nie operuje na sejfie użytkownika. Test plików wykonuje odczyt
kontrolny, sprawdza rename/list/remove i sprząta wyłącznie własny `tmp-<id>` w finally.
Rekurencyjny rmdir jest wymagany przez adapter Obsidiana także dla pustego folderu.
Awaria sprzątania pozostaje czerwona w raporcie. Przy braku dostępu do katalogu
raport nie może zostać zapisany, a UI pokazuje stały komunikat błędu.
Pliki mają datę UTC, losowy sufiks i platformę, żeby nie nadpisywać poprzednich biegów.

Raport jest allowlistą faktów, nie zrzutem ustawień/logów. Ustawienia służą tylko
jako słownik sekretów (także nieenumerowalne klucze po odblokowaniu). Redakcja po
wartości z core idzie przed maską wzorców z core; dodatkowo usuwa krótkie sekrety,
URL i ścieżki absolutne. Maskowanie obejmuje również cały Markdown przed zapisem.
Nie zapisujemy wartości kluczy, nagłówków, próbek szyfru, notatek, rozmów ani nazw plików.
Brak możliwości opcjonalnych jest pominięciem, nie awarią. Brak wymaganych API
(structuredClone, at, WebCrypto, strumienie, dekoder, AbortController) jest błędem.
Diagnostyka lokalna zapisuje raport także bez AbortController; wtedy sieć jest pomijana. Samo istnienie `require`
jest informacją; diagnostyka nigdy go nie wywołuje.

Test połączenia świadomie wymusza stream także dla xAI, którego zwykły czat używa
`complete` z powodu historycznej decyzji CORS. To tylko jawnie zatwierdzony pomiar,
nie zmiana zachowania czatu. Bez zgody żadna ścieżka dostawcy nie wysyła żądania.
Raport zostaje w `.pkm-assistant/diagnostics/`; jego synchronizacja zależy od
konfiguracji użytkownika. Nie zmieniamy gitignore vaulta.

## Testy

`diagnostics.test.ts`: odczyt raportu z adaptera RAM, kryptografia, awarie rename,
mkdir, rmdir, brak append, cichy błąd dopisania, izolacja sprzątania, prywatność
z kluczami nieenumerowalnymi i odmowa bez żądania.
`connection.test.ts`: prawdziwy FetchStreamTransport z atrapą fetch, dwie porcje,
jedno krótkie żądanie, 429 bez retry, błąd w HTTP 200, abort.
`ui.test.ts`: przyciski, zgoda, odmowa, zamknięcie, abort i spóźnione kliknięcie.
Testy nie rozstrzygają działania CapacitorAdapter, CORS, WebView ani schowka Androida.

Dodatkowe testy integracji: `src/main.mobile.test.ts` uruchamia metodę composition
root na desktopie/mobile i bez AbortController; `core/diagnosticsSettings.test.ts`
weryfikuje wersję/build i wywołanie przez przycisk; `utils/buildMarker.test.ts`
sprawdza hash/czas, brak git i rzeczywisty transform esbuild define bez builda pluginu.
