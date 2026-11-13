# M3 U2 - menu rozmowy na telefonie

Baza: `c6ac413`, gałąź `ccr-07240b39-tu8q43`. Bez buildu, commitu, pushowania,
zmiany gałęzi i zapisów w repo harnessu.

## Zmiany i decyzje

- [measured, diff] `chat/chat_tabs.ts`: przycisk z `chat.session_menu` tylko pod
  istniejącym `Platform.isPhone`. Zakładki przewijają się we własnym kontenerze;
  przycisk pozostaje po prawej, wewnątrz `.cs-chat-topbar`.
- [measured, kod + AVA] `chat/sessionActions.ts`: jedna lista pięciu akcji z ID,
  i18n, ikonami, handlerami i stanem zajętości, używana przez `_renderSlimBar`
  i `chat/phoneSessionMenu.ts`. Zachowano DOM, tooltipy, kolejność oraz SVG paska.
  Menu ma uzgodnioną kolejność i separatory. Błędy Nowej/Zamknij, komunikaty
  konsolidacji i ręczna kompresja zachowują poprzednią logikę.
- [measured, AVA] Zajętość konsolidacji/podsumowania nie była blokadą przycisku;
  pozostaje wskaźnikiem, bez dodania blokady podczas generowania. Menu ponownie
  otwarte podczas pracy pokazuje ikonę loader. Artefakty zachowują istniejącą
  blokadę generowania.
- [measured, kod + AVA] Artefakty otwierają istniejący `_showArtifactPicker`.
  Token Viewer też jest dostępny: liczniki w górnym pasku są nieklikalne, a widget
  otwierający podgląd mieszka w ukrytym pasku. Nie skopiowano ich logiki.
- [measured, kod + AVA + Chrome] `/` udostępnia skille, subagentów i narzędzia
  zewnętrznego MCP. `mousedown` wybiera indeks dotkniętego wiersza, nie indeks
  poprzedniego hovera. Nie zmieniano TriggerPopup. Próba touchStart/touchEnd
  w Chrome wygenerowała mousedown, wpisała `@@tool:docs__search` i zamknęła popup.
- [inferred, kod] Natywny `Menu` wybiera wygląd arkusza po stronie Obsidiana.
  Nie dodano własnego modalu menu. Bramka platformy i style nie zmieniają tabletów.
- [measured, diff] Słowniki `core/i18n/en.ts` i `pl.ts` mają jeden nowy klucz;
  pozostałe napisy są istniejącymi etykietami. Zaktualizowano CLAUDE modułów chat/core.

## Okna i style

[measured, odczyt kodu] SessionCloseModal i OpenSessionModal używają wspólnej
szerokości 460 px (max 90vw). SaveSessionModal ma 720 px, a ConsolidationProgressModal
760 px (oba max 94vw). Close/Open już miały pionowe akcje, lecz bez minimum 44 px;
anulowanie miało osobny wiersz wyrównany do prawej. Zapis ma rząd czterech decyzji,
loading rząd Ponów/Anuluj, konsolidacja drobne przyciski w poziomym nagłówku kroku
(padding 2x8 px, font 11 px). Bieżący SaveSessionModal układa grupy pionowo;
komentarz o czterech kolumnach nie odpowiada obecnemu rendererowi.

[measured, diff] `src/styles.css` i `modules/chat/chat_view.css` dodają wyłącznie
`body.is-phone`: ograniczenie szerokości/wysokości, przewijanie treści, decyzje
pionowo na pełną szerokość, minimum 44 px i zawijanie długich nazw. Reguła szerokości
konsolidacji sprawdza `.cs-consolidation-modal`, ponieważ klasa szerokiego archiwum
jest współdzielona z innym modułem. Token Viewer i picker artefaktów mają cele
minimum 44 px; podgląd kontekstu mieści się między bokami czatu.

## Testy zachowania

[measured] Dodano 35 przypadków w `chat/phoneSessionMenu.test.ts`:

- 6: telefon/tablet/desktop x PL/EN - literalne tagi, klasy, data-tip i kolejność
  przycisków paska; na telefonie nazwa, położenie, ikony, kolejność i separatory menu;
  na pozostałych platformach poprzednie dzieci topbara i brak nowego przycisku.
- 6: oba wejścia x Zapisz/Nowa/Zamknij - rzeczywisty AgentMemory zapisuje transkrypt,
  rzeczywisty modal oferuje archiwizację/odrzucenie/anulowanie, Cancel zachowuje
  wiadomość, zamknięcie zapisuje rozmowę i czyści ostatnie okno. Ostatnia karta
  agenta zostaje zgodnie z dotychczasowym kontraktem.
- 8: oba wejścia x Podsumowanie/Konsolidacja x generowanie włączone/wyłączone -
  wynik kompresji w oknie, dokładne powiadomienia, otwarcie review i zdjęcie busy.
  Granica modelu/konsolidacji jest zastąpiona kontrolowanym wynikiem.
- 4: oba wejścia x brak/obecność sesji na dysku przy pustej rozmowie - komunikat
  o braku materiału albo uruchomienie review i komunikaty powodzenia.
- 6: oba wejścia x błąd Nowej/Konsolidacji/Podsumowania - dokładny komunikat,
  zachowanie transkryptu, usunięcie stanu zajętości.
- 1: odroczona kompresja - busy w pasku i ponownie otwartym menu, bez nowej blokady;
  po zakończeniu powrót do pierwotnej ikony i klasy.
- 1: rzeczywisty pusty picker artefaktów i Token Viewer z menu, blokada artefaktów
  podczas generowania oraz dostępność pozostałych pozycji.
- 3: bez hovera wybrany wiersz skilla/subagenta/MCP wpisuje literalny marker do
  pola i zamyka popup.

[measured] Istniejące `manualCompression.test.ts` i `chat_streaming.sendTab.test.ts`
śledzą nowe położenie funkcji/rejestracji, z zachowanymi asercjami. Test komentarza
inline potrzebuje lokalnego eksportu Menu przy bundlowaniu z dawną atrapą harnessu;
nie otwiera go, a próba otwarcia jawnie rzuca. Asercje komentarza pozostają bez zmian.

## Pomiar przeglądarkowy

[measured] Chrome headless, viewport 360x800, kontener topbara 300 px, 20 wariantów:
4 okna + topbar, przed/po, z/bez is-phone. Uruchomiono produkcyjne klasy/renderer
z zastąpioną granicą hosta, ikonami i pomocniczymi danymi; prawdziwe arkusze, chat CSS
jako adoptedStyleSheets. To nie był żywy Obsidian. Wszystkie zmierzone wymiary
desktopu przed i po są identyczne. Telefon: brak przepełnienia poziomego,
przyciski minimum 44 px, menu 44x44 px przy pięciu długich nazwach zakładek.
Zapis i konsolidacja mają przewijanie wewnątrz okna. Wyniki liczbowe w JSON.

Dowody lokalne (katalog ignorowany przez git):
[skrypt](biegi/m3-u2/surowe/measure.mjs),
[pomiary](biegi/m3-u2/surowe/measurements.json),
[dotyk](biegi/m3-u2/surowe/touch.json),
[zrzut 360 px](biegi/m3-u2/surowe/save-360.png).

## Bramki

[measured] Końcowy przebieg: cztery bramki zakończone kodem 0.

- `npm test`: 6388 zaliczonych, 1 istniejący skip w `typingIndicator.test.ts:61`.
  U2 nie dodaje skipów ani nie osłabia istniejących asercji. Parzystość i18n i zakaz
  długich myślników przechodzą w tej bramce.
- `npm run typecheck`: 0 błędów, bramka statyczna (bez liczby testów).
- `npm run lint`: 0 błędów i ostrzeżeń, bramka statyczna.
- `npm run lint:obsidian`: 0 błędów, 9 istniejących ostrzeżeń w niezmienianych liniach
  innych plików, bramka statyczna.

Logi:
[npm test](biegi/m3-u2/surowe/npm-test.log),
[typecheck](biegi/m3-u2/surowe/typecheck.log),
[lint](biegi/m3-u2/surowe/lint.log),
[lint Obsidiana](biegi/m3-u2/surowe/lint-obsidian.log).
Pierwszy pełny przebieg wykrył dwa błędy bundlowania dawnej atrapy bez Menu;
po uzupełnieniu lokalnej granicy oba testy i 35 nowych przypadków przeszły (37/37).

## Ograniczenia i następne paczki

- [measured] Nie uruchamiano na fizycznym Androidzie ani w żywym Obsidianie.
  Do odbioru: natywny arkusz, klawiatura WebView, focus, dotyk palcem i style hosta.
- [measured] Nie zmieniano harnessu. Patch `/tmp/u2-harness-menu.patch` dodaje Menu
  i MenuItem do jego atrapy; `git apply --check` przeszedł, patch nie został nałożony.
  AVA ma lokalną granicę Menu; mobilne scenariusze samego harnessu będą potrzebować
  jego eksportu przed użyciem nowego wejścia.
- [inferred] Kolejna przebudowa paska musi korzystać z `getSessionActions`, a prace
  nad klawiaturą uwzględnić panel U1 w przepływie flex oraz przewijanie modali.
  Popup `/` nadal otwiera się istniejącą ścieżką wpisania `/`; U2 nie zmienia
  rozpoznawania klawiszy wirtualnych ani cyklu blur. Potwierdzono wybór wiersza.
