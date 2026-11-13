# M3 U1 - ekran rozmowy w szufladzie telefonu

Baza: `084756d`. Zakres: `modules/chat/chat_view.css`, `chat/chat_ui.ts`,
`src/main.ts`, słowniki `core/i18n/{en,pl}.ts`, testy mobilne czatu i composition root,
dokumentacja główna, core i chat. Bez buildu, commitu, zmiany gałęzi i zmian harnessu.

## Decyzje

- [inferred, CSS] Wyłącznie telefon: `body.is-phone` i istniejący `Platform.isPhone`.
  Panel ma normalny przepływ flex i margines 4 px. Wysokość textarea/todo, chipów
  i kolejki zmniejsza dostępną wysokość listy, zamiast ją zasłaniać. Stały padding
  6 px jest odstępem listy, nie rezerwą pod panel.
- [measured, kod i próba Chrome] Stary obserwator rezerwuje pełne `offsetHeight + 24`.
  W atrapie po ręcznym przewinięciu na sam dół błąd już przed zmianą był nad panelem.
  Nie odtworzono więc wszystkich warunków zgłoszenia z żywego Obsidiana.
  `handle_error` dopisuje kafelek bez `scrollToBottom`, a wzrost paddingu po callbacku
  obserwatora nie koryguje scrolla. Nowy układ usuwa samo nakładanie panelu na listę;
  nie wymusza automatycznego przewijania po błędzie. Desktop/tablet zachowują obserwator.
- [measured, Chrome] Cele 44 px i opcjonalne todo/mikrofon nie mieszczą się naraz
  w 300 px. Jeden poziomo przewijany rząd zachowuje wszystkie kontrolki; Wyślij/Stop
  są stale widoczne poza scrollerem. Popovery kotwiczą w panelu, nie w przycisku
  wewnątrz obszaru obcinania. Test trafienia sprawdza ich widoczność i tekst.
- [inferred, CSS] Akcje wiadomości są stale widoczne, opacity 0.7, w normalnym
  przepływie. Nie wprowadzono dodatkowej interakcji tapnięcia dymka.
- [measured, kod i Chrome] `_renderUserText` zapisuje LF w tekstowych dzieciach `p`;
  tylko telefon dostaje `white-space: pre-wrap`. Desktopowe Shift+Enter zachowuje
  LF w danych, ale nadal wizualnie skleja linie. Nie zmieniono parsera ani wzmianek.
- [measured, kod] Notice embeddingu pomijany przez `Platform.isMobile`, tak samo jak
  VaultIndexer bezwarunkowo ustawia `disabled_mobile`. Desktop pozostaje bez zmian.

## Selektory i wymiary

Wartości przed z bazy, po wyłącznie pod `body.is-phone`; rozmiary w px.

| Selektor | Przed | Po |
|---|---|---|
| `.pkm-chat-messages` | padding 20 / 16 / dynamiczny, gap 2 | padding 10 / 6 / 6, gap 6 |
| `.pkm-chat-messages.cs-root` | rynna 22 | rynna 20 |
| `.cs-message__text` | font 12.16 | font 15.5 |
| `.cs-input-textarea` | font 12.8, min-height 40 | font 16, min-height 48 |
| `.cs-tab`, `.cs-tab--add` | wysokość 36 | min. 44 x 44 |
| `.cs-tile__head` | min-height 20, font 12 | min-height 44, font 14 |
| `.cs-input-ctrl` | zmierzona wysokość 20 | min. 44 x 44 |
| `.cs-input-send` | 36 x 36, romb | 48 x 48, koło z akcentem |
| `.cs-input-panel` | absolute, dół 8, boki 12 | relative we flex, margines 4 |
| `.cs-message__meta` | ukryte, absolute, hover | stale flex, static |
| `.cs-message--user .cs-message__text` | white-space normal | pre-wrap |

Rynna musi być ustawiona na liście `.cs-root`, ponieważ jej lokalna zmienna
przesłania zmienną ustawioną na rodzicu w makiecie. Oś łącznika i kryształu:
`(6 + 20) - 20 + 9 = 15 px` od lewej listy; przed zmianą `16 + 9 = 25 px`.
JS czyta faktyczny margin-left, pseudo-elementy kompensują border-left 1/3 px.

## Weryfikacja

[measured] Chrome 153.0.8010.12, DOM odwzorowujący czat, viewport 412 x 880,
kontener o wysokości 800 px. Arkusz czatu załadowany przez `adoptedStyleSheets`,
arkusz główny przez `style`; te same uproszczone style hosta dla obu wersji.
16 wariantów: 300/346 px x is-phone/brak x baza/zmiana x zwykły pasek/todo+mikrofon.
Wykonywane są rzeczywiste `_renderUserText`, `_drawConnectorLines` i instalacja
obserwatora wycięte z funkcji produkcyjnych; pozostały DOM jest atrapą struktury.
Baza i zmiana bez is-phone mają identyczne wszystkie zmierzone wymiary i stany.

| Kontener | Klasa | Szerokość dymka przed -> po | Rzędy paska przed -> po | Wyślij wysokość przed -> po |
|---|---|---|---|---|
| 346 | bez is-phone | 292 -> 292 | 1 -> 1 | 36 -> 35.9996 |
| 346 | is-phone | 292 -> 314 | 1 -> 1 | 36 -> 48 |
| 300 | bez is-phone | 246 -> 246 | 2 -> 2 | 36 -> 35.9996 |
| 300 | is-phone | 246 -> 268 | 2 -> 1 | 36 -> 48 |

[measured] Z todo+mikrofonem telefon nadal ma jeden rząd. Poziome przewinięcie
kontrolek wynosi 0/32 px dla zwykłego paska (346/300 px), 86/132 px z todo+mikrofonem.
Wyślij pozostaje w całości widoczny. Wszystkie kontrolki mają co najmniej 44 x 44 px,
Wyślij 48 x 48 px; tab i plus co najmniej 44 x 44 px; nagłówek kafelka 44 px wysokości.

[measured] W 7 stanach (błąd bezpośrednio w liście, błąd zagnieżdżony w wiadomości,
kolejka, chipy, textarea 160 px, todo, powrót do małego inputu) najniższy odstęp
kafelka błędu od panelu po przewinięciu wyniósł 17.875 px. Kolejka pozostaje wewnątrz
panelu także przy todo. To wynik układu, nie sztywny zapas pod panel.

[measured] Środek kryształu i x łącznika: 15/15 px po zmianie, 25/25 px przed.
Dwie krótkie linie użytkownika: wysokość tekstu 46.5 px na telefonie (dwa wiersze),
18.234375 px na desktopie (jeden wiersz), na obu szerokościach.
Popovery autonomii/uprawnień/narzędzi przechodzą test `elementFromPoint`, mieszczą
się między bokami panelu i mają widoczne etykiety.

Lokalne surowe dowody (katalog ignorowany przez git):
[browser.log](biegi/m3-u1/surowe/browser.log),
[measurements.json](biegi/m3-u1/surowe/measurements.json),
[skrypt pomiaru](biegi/m3-u1/surowe/measure.mjs),
[zrzut 300 px](biegi/m3-u1/surowe/phone-300.png),
[zrzut 346 px](biegi/m3-u1/surowe/phone-346.png).

[measured] Wszystkie cztery bramki uruchomione, exit 0:
- `npm test`: 6353 zaliczone, 1 istniejący skip w `typingIndicator.test.ts:61`
  (taki sam w `git show 084756d:modules/chat/chat/typingIndicator.test.ts`).
  Nie dodano skipów ani nie osłabiono istniejących asercji. Parzystość i18n i zakaz
  długich myślników przechodzą w tej bramce.
- `npm run typecheck`: 0 błędów (bramka statyczna, nie liczy testów).
- `npm run lint`: 0 błędów i ostrzeżeń (bramka statyczna).
- `npm run lint:obsidian`: 0 błędów, 9 ostrzeżeń w liniach niezmienianych przez U1
  (bramka statyczna, ostrzeżenia poza zakresem paczki).

Logi lokalne: [AVA](biegi/m3-u1/surowe/npm-test.log),
[TypeScript](biegi/m3-u1/surowe/typecheck.log),
[lint](biegi/m3-u1/surowe/lint.log),
[Obsidian](biegi/m3-u1/surowe/lint-obsidian.log).
Wcześniejszy przebieg celowany obu plików testowych: 32 zaliczone.


Dodano 9 testów zachowania:
- 6 w `chat_ui.mobile.test.ts`: rzeczywisty render na telefonie, tablecie i desktopie
  w PL/EN, literalne aria-label Wyślij/Stop/autonomii, położenie kontrolek i wysyłka LF.
- 1 tamże: produkcyjny obserwator rezerwuje 204 px dla panelu 180 px na desktopie
  oraz 284 px dla 260 px na tablecie; re-render na telefon odłącza go i nie zostawia rezerwy.
- 2 w `main.mobile.test.ts`: mobile bez notice, ten sam host na desktopie pokazuje
  dokładny dawny komunikat PL/EN; ustawiony provider nie tworzy kolejnego notice.

## Granice i następne paczki

- Bez prawdziwego Androida: klawiatura ekranowa, visualViewport, menu systemowego
  zaznaczenia, trafianie palcem i popovery w WebView pozostają do sprawdzenia.
- `selectionMenu.ts` nasłuchuje tylko `mouseup` i `keyup`, bez `touchend` ani
  `selectionchange`. Dedykowane wsparcie zaznaczenia dotykiem zostawiono następnej
  paczce zgodnie z dopuszczeniem U1; stale widoczny przycisk kopiuje cały dymek.
- Reguła ukrywająca `.cs-skillbar` do 600 px pozostaje dla U2. U2 powinna uwzględnić
  nowy scroller kontrolek. Obsługa klawiatury musi uwzględnić panel w przepływie flex.
- Atrapa nie zawiera pełnego CSS hosta ani dodatków użytkownika. Końcowy pomiar
  na żywym Obsidianie wykonuje odbiorca. Nie zmieniano harnessu i nie potrzeba patcha.
