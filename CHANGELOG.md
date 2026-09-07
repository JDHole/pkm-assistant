# Changelog

Format wzorowany na [Keep a Changelog](https://keepachangelog.com/), wersjonowanie zgodne z [Semantic Versioning](https://semver.org/).

## [2.2.x] - v2.2 (2.2.0 wydane 2026-09-06, 2.2.1 wydane 2026-09-07)

### Podsumowanie dla użytkownika

To, co widać z fotela użytkownika — bez chronologii i bez nazw sprintów. Zapis dewelopera
(z datami i numerami znalezisk) leży niżej, pod „Szczegóły techniczne".

#### Added

- **Klient zewnętrznych serwerów MCP.** Prawdziwy protokół (stdio i HTTP) zamiast dawnego
  uruchamiania kodu JS z vaulta. W Ustawieniach: podgląd listy narzędzi serwera przed
  zapisem konfiguracji, przełącznik włącz/wyłącz per serwer, gotowe presety pięciu
  popularnych serwerów (filesystem, github, pamięć, fetch, blender), okno „Importuj
  z Claude Desktop" (wczytuje serwery z konfiguracji Claude Desktop, z odznaczaniem już
  istniejących) i czytelny komunikat przy odpowiedzi 401 zamiast niejasnego wywrotu.
- **Komunikator v3 — prosta poczta między agentami.** Każda wiadomość to osobny plik
  w skrzynce (zamiast jednego wspólnego pliku), trzy proste działania (wyślij / lista /
  czytaj), możliwość ukrycia agenta z komunikatora, sprzątanie przeczytanych wiadomości
  pojedynczo lub hurtem, globalny przełącznik w Ustawienia → Zaawansowane (domyślnie
  włączony).
- **Deep Research.** Dwa nowe skille budujące pogłębiony raport z researchu; wynik zapisuje
  się jako nowy typ dokumentu „raport" w vaultcie.
- **Panel „Biegi subów".** Zakładka w bocznym pasku (plus kafelek na Home z licznikiem)
  pokazuje trwające, oczekujące na dostarczenie do czatu i zakończone zlecenia dla
  sub-agentów — z rozwijanymi krokami i przyciskiem Stop dla każdego z osobna. W trakcie
  pracy suba można wysłać mu dodatkową wiadomość (guzik „Wiadomość") — dotrze przy
  najbliższym kroku, choć w ostatniej iteracji może nie zdążyć jej przeczytać.
- **Zaplecze agenta o trzy zakładki bogatsze:** Skille, Suby i Konektory — magazyn własnych
  szablonów umiejętności i sub-agentów, z możliwością wyboru globalnego sub-agenta do
  delegacji zadań.
- **Puls pamięci** — modal pokazujący na żywo postęp konsolidacji pamięci agenta (pasek
  stanu, zabezpieczenie na wypadek zawieszenia procesu) plus odświeżony wskaźnik przy
  sesjach w archiwum.
- **Wyszukiwanie w sieci mocniejsze:** streszczanie odczytanych stron tańszym modelem
  z dosłownymi cytatami źródłowymi, licznik dziennego i miesięcznego zużycia wyszukiwania,
  filtr dozwolonych i zablokowanych domen, obsługa PDF przy odczycie stron.
- **Nowe okna w profilu agenta:** generator promptu startowego persony (wybór roli, tonu
  i zasad, podgląd na żywo, wstawienie wyniku do pola Osobowość), karta „Log wpisów Brain"
  (kronika ostatnich 50 realnych zmian w trwałej pamięci) oraz panel aktywnych sesji
  z szybkim otwarciem pliku rozmowy.
- **Modal „Zużycie limitu ChatGPT"** w Ustawieniach, obok „Koszty LLM" — realne wykorzystanie
  limitów tygodniowych (paski %, czas do resetu), gdy plik z danymi jest dostępny.
- **Retencja archiwum sesji pamięci** — liczba dni i maksymalna liczba plików (domyślnie
  brak limitu). Sesje niepokryte jeszcze podsumowaniem nie są kasowane nigdy, niezależnie
  od ustawień.
- **Komenda „Wygeneruj widok Bases artefaktów"** — tworzy plik `.base` z gotowymi widokami
  tabelarycznymi (Wszystkie / Otwarte) dla folderu artefaktów, zgodny z natywną funkcją
  Bases w Obsidianie.
- **Poczekalnia „ratowania pamięci"** — fragmenty wycięte przy kompresji rozmowy trafiają
  do trwałej poczekalni i są pokazywane do przeglądu w oknie zapisu sesji, zamiast
  bezpowrotnie znikać.
- **Globalny limit czasu na pojedyncze wywołanie modelu w czacie** (Ustawienia → Limity,
  do wyłączenia) jako ostateczne zabezpieczenie przed rozmową wiszącą bez końca.
- **Typy artefaktów przypisane agentowi są egzekwowane** przy tworzeniu nowego artefaktu —
  próba utworzenia niedozwolonego typu kończy się czytelną odmową zamiast cichego
  zignorowania ograniczenia.

#### Changed

- **Warstwa bazowa napisana od nowa (clean-room, 2026-09).** Transport HTTP i strumieni
  (fetch + SSE/NDJSON, bez XMLHttpRequest), runtime wtyczki (start, ustawienia z pancerzem,
  powiadomienia, pasek statusu), 9 dostawców modeli czatu i 4 dostawców embeddingu powstały od
  zera według spisanych zachowań i testów, bez zaglądania w kod odziedziczony po dawnym frameworku
  bazowym; w repozytorium nie ma już żadnego pliku, symbolu ani komentarza z tamtego świata
  (pilnuje tego test-strażnik `core/clean_room_guard.test.ts`). Klucze ustawień odziedziczone po
  tamtym frameworku są przepisywane automatycznie na `pkmAssistant.chat.*` /
  `pkmAssistant.embedding.*` / `pkmAssistant.notices.*`, z kopią starego pliku jako
  `.pkm-assistant/settings.pre-clean-room.json` przed pierwszym zapisem.
- **Komendy w palecie bez podwójnej nazwy pluginu.** Nazwy komend (Otwórz czat, Losowa notatka,
  Otwórz panel agentów, Autotest, Wygeneruj widok Bases artefaktów) nie zaczynają się już od
  „PKM Assistant:" — Obsidian dokleja nazwę pluginu sam. Skróty klawiszowe zostają (id komend bez zmian).
- **Minimalna wymagana wersja Obsidiana to teraz 1.11.0** (dawniej deklarowane 1.2.3, mimo że
  plugin korzystał z nowszego API) — uczciwsza deklaracja zamiast cichego ryzyka na starszych
  wersjach.
- **Plugin nazywa się wszędzie „pkm-assistant"** (dawniej „obsek") — folder wtyczki,
  ustawienia, logi, klasy CSS. Dane, klucze API i ustawienia przenoszą się automatycznie
  przy pierwszym uruchomieniu; szczegóły w sekcji „Migracja" niżej.
- **Ustawienia pluginu mieszkają w vaultcie** (`.pkm-assistant/settings.json`) zamiast
  w dawnym miejscu odziedziczonym po starym frameworku bazowym.
- **ComfyUI odchodzi** — Zoja, podgląd generowania obrazów i gotowe workflow zostały
  usunięte; generowanie obrazów działa przez dostawców chmurowych.
- **Jedno nazewnictwo pomocnika:** wszędzie w interfejsie „Sub-agent" (koniec dawnego
  rozróżnienia ról).
- **Delegacja zadania do sub-agenta zawsze w tle** — czat od razu dostaje potwierdzenie
  startu zamiast czekać zamrożony na koniec biegu, a rezultat wraca automatyczną turą,
  gdy tylko jest gotowy. Domyślny limit kolejnych automatycznych tur po zadaniach subów
  podniesiony z 5 do 10 (rozesłanie kilku zadań naraz nie wyczerpuje od razu budżetu).
- **Wyższe limity dla sub-agentów, żeby nie ucinały pracy w połowie:** budżet promptu,
  kontekst delegacji, liczba iteracji (worker 12 → 25), czas na cały bieg (do 900 s), czas
  na dopisanie finalnego podsumowania (45 s → 120 s) i długość zwracanego wyniku
  (15 tys. → 60 tys. znaków, konfigurowalne, można wyłączyć). Wszystko w Ustawienia → Limity.
- **Dwa wbudowane profile sub-agenta** w narzędziu delegacji: szybki i tani „explorer"
  (tylko odczyt) oraz „worker" (pełne uprawnienia i model klasy głównego agenta). Własny
  zdefiniowany sub-agent o tej samej nazwie ma pierwszeństwo.
- **Krok narzędzia w podglądzie biegu suba pokazuje konkretny szczegół** (jaki plik, jakie
  zapytanie), a po rozwinięciu wiersza widać zlecone zadanie i ramkę z wynikiem (błąd
  na czerwono) — koniec „widać, że coś robi, ale nie wiadomo co".
- **Blok „Myślenie" jednym mechanizmem** dla LM Studio, Groq, custom-OpenAI i OpenRouter —
  mniej niespójności między platformami.
- **Dolny pasek czatu ma dwa widoki w jednym miejscu:** pole wpisywania i listę zadań
  agenta. Przełącza się automatycznie, gdy lista się pojawia lub znika, przełącznik pokazuje
  licznik ukończonych zadań, a pasek rezerwuje dynamicznie tyle miejsca, ile faktycznie
  zajmuje (koniec zasłaniania treści wiadomości).
- **Kliknięcie wiersza artefaktu na liście nie wysyła już zrzutu stanu do agenta** — po
  prostu przypina artefakt i otwiera notatkę w nowej karcie. Ręczne wysłanie stanu nadal
  działa przez przycisk w notatce albo ikonę odświeżenia na chipie.
- **Pliki sesji pamięci agentów znów są wersjonowane w repozytorium git vaulta**
  (podróżują między laptopem, chmurą i telefonem) — ewentualne sekrety w treści sesji są
  maskowane już przy zapisie, więc ryzyko wycieku jest usunięte u źródła.
- **Ucięte streszczenia „myślenia" przez lokalny most API to ograniczenie dostawcy, nie błąd
  pluginu** — OpenAI oddaje przez API tylko nagłówki podsumowań rozumowania. Gdy dostawca
  zacznie oddawać więcej, plugin pokaże to automatycznie.
- **Porządki wewnętrzne bez zmiany działania:** cały kod źródłowy przeszedł na TypeScript
  w trybie strict, uporządkowano importy między modułami (koniec cykli zależności), wycięto
  martwy kod i nieużywane reguły CSS (ok. 5,5 tys. linii w pierwszej fali plus ok. 216
  fragmentów w drugiej), style inline zamieniono na klasy CSS, uporządkowano tłumaczenia
  (usunięto ok. 287 nieużywanych kluczy, dotłumaczono 26 brakujących), poprawiono ok. 79
  nieścisłości w dokumentacji projektu i dołożono testy regresyjne po audytach.

#### Fixed

- **Mikrofon (mowa na tekst) znów widzi klucz Groq/OpenAI/Gemini.** Po wpisaniu klucza
  w Ustawieniach nagranie kończyło się komunikatem „Brak klucza API", bo przycisk mikrofonu
  szukał klucza w starym miejscu (sprzed migracji ustawień), a nie w tej samej puli kluczy,
  z której korzysta czat. Komunikat o brakującym kluczu mówi teraz wprost, żeby wpisać go
  w Ustawieniach, zamiast podawać wewnętrzną nazwę pola (2026-09-06).
- **Koniec fałszywego „dostępna nowa wersja".** Najpierw (03.09) naprawiono porównanie wersji
  (tag „v2.1.0" kontra „2.1.0" ogłaszał nową wersję po każdym starcie), a dzień później (04.09,
  decyzja D1) cały mechanizm sprawdzania aktualizacji z GitHuba wycięto — patrz „Removed".
- **Rozmowa nie wisi już bez końca.** Naprawiono zawieszanie tury, gdy model przestawał
  odpowiadać w trakcie generowania; sub-agent utknięty na martwym strumieniu ma osobny
  „watchdog ciszy" (nie mylony z modelem, który po prostu wolno myśli); otwarcie nowej sesji
  czatu nie ubija już trwającej rozmowy w innej karcie („friendly fire" watchdoga, który
  potrafił zostawić kartę zawieszoną na dziesiątki minut bez błędu).
- **Przycisk Stop naprawdę przerywa generację** — także w trakcie działania narzędzia
  i przy zamknięciu panelu czatu. Wcześniej przerwana tura mogła „wrócić do życia" albo
  dokończyć się mimo zamknięcia okna.
- **Finalna wiadomość agenta odświeża się poprawnie** po zakończeniu odpowiedzi — koniec
  widocznego rollbacku bloku „Myślenie" i resztek halucynowanych znaczników narzędzi.
- **Myślenie modelu wraca tam, gdzie go brakowało:** Ollama (qwen3, deepseek-r1) traciła
  treść wewnętrznego myślenia, a parser znaczników `<think>` w LM Studio i Ollamie kasował
  resztę odpowiedzi, gdy znacznik był ucięty na końcu.
- **DeepSeek nie ucina już własnej odpowiedzi** na fragmencie treści przypominającym
  znacznik końca strumienia. Naprawiono też rzadką kolizję identyfikatorów wywołań narzędzi
  (kilka wywołań w tej samej milisekundzie).
- **Aktywne sesje pamięci przestały ginąć.** Zamknięcie karty czatu czeka na dokończenie
  zapisu, autozapis dokleja tylko brakujący ogon zamiast nadpisywać cały plik (wcześniej po
  skompresowaniu okna kontekstu potrafił bezpowrotnie ściąć historię do samego streszczenia),
  a awaryjne przywracanie po zamknięciu Obsidiana czyta nowy format pliku poprawnie.
- **Archiwum pamięci mówi prawdę:** poprawiona data zapisania sesji, przywrócona odznaka
  statusu streszczenia, licznik sesji do konsolidacji nie pokazuje już fałszywie progu przy
  archiwum mniejszym niż paczka, a `/save_session` nie zostawia nieprawidłowej ścieżki sesji
  przypisanej do zakładki.
- **Konsolidacja pamięci szanuje Twoje ręczne zmiany.** Sekcje dopisane ręcznie do `brain.md`
  przestały znikać przy zapisie (zostają w pliku, przesunięte pod automatycznie generowaną
  treść), edycje użytkownika przeżywają konsolidację, modal przebiegu nie zostawia po sobie
  śladu po zamknięciu, stan „w toku" jest rozpoznawany jako wciąż aktywny przebieg,
  a kliknięcie „Anuluj" po prostu przerywa operację zamiast udawać zawieszony strumień.
  „Awaryjny zrzut" pamięci zapisuje realną treść notatki, nie pustkę.
- **Migrator pamięci z formatu v2 do v3 przepisany:** liczy każdą sekcję i każdy akapit
  starego pliku (koniec urywania zdań w połowie i gubienia fragmentów), notatki o kolidujących
  nazwach dostają unikalny sufiks zamiast nadpisywać istniejący plik, a przycisk Anuluj
  w oknie migracji naprawdę anuluje migrację.
- **Ustawienia i klucze API są bezpieczne przy zdegradowanym odczycie dysku.** Plugin nie
  nadpisze kopii zapasowej ustawień uszkodzoną treścią (co przy restarcie kończyło się utratą
  ustawień i kluczy), a sam start pluginu nie zapisze domyślnych ustawień na plik użytkownika.
  Odczyt plików pamięci i sesji na dyskach synchronizowanych w chmurze (np. Dysk Google) nie
  jest już mylnie brany za „plik nie istnieje".
- **Uprawnienia w profilu agenta wreszcie działają:** cztery przełączniki (odczyt i edycja
  notatek, tworzenie i kasowanie plików) były zapisywane, ale system ich nie sprawdzał;
  presety Bezpieczny/Standard/Pełny nie zmieniają już trybu „Tylko przypisane foldery"
  (wybranie „Pełny" potrafiło paradoksalnie zawęzić agenta do whitelisty).
- **Artefakty trzymają swoją strukturę:** wstawienie przez model dodatkowego nagłówka sekcji
  (np. „## Źródła") w treści nie osierocy już oryginalnej sekcji — taka próba jest odrzucana
  z czytelnym błędem; rozpoznawanie nagłówków działa dla obu stylów zapisu Markdown;
  interaktywny blok artefaktu (Zatwierdź/Odrzuć) działa wyłącznie we własnej notatce
  artefaktu, nie w podłożonej kopii; brakująca sekcja „Białe plamy" dodana do szablonu typu
  „raport" (przepis „Głęboki research" generował niepełne raporty).
- **Awaria narzędzia jest widoczna i spójna:** status w dymku, link „otwórz zapisany plik"
  i historia rozmowy zgadzają się z tym, czy operacja faktycznie się powiodła. Awaria zadania
  sub-agenta nie znika już z odtworzonej historii rozmowy, a błąd modelu u suba (np. zły klucz
  API) daje czerwoną ramkę błędu zamiast fałszywego zielonego „gotowe".
- **Sub-agenci nie tracą dorobku, gdy zabraknie im czasu** tuż przed napisaniem podsumowania:
  dostają jednorazowe dodatkowe okno na dokończenie, a przy przerwaniu do czatu wraca skrócony
  skrót zebranych wyników zamiast pustej zaślepki. Ślad równoległych subów pod tą samą etykietą
  jest rozróżnialny (każdy ma unikalny numer).
- **Wyłączenie lub aktualizacja pluginu zatrzymuje działające zadania sub-agentów** —
  wcześniej sub potrafił „mielić" jeszcze do 30 minut po wyłączeniu pluginu.
- **Skille:** kasowanie umiejętności po nazwie i po technicznym identyfikatorze usuwa cały
  folder (koniec resztek na dysku), a pytania wstępne skilla nie gubią się przy ponownym
  wczytaniu z dysku.
- **Poczta między agentami:** uzupełnione brakujące tłumaczenia (zamiast gołego klucza
  widać właściwy komunikat), a nieudany odczyt poczty jest zgłaszany jako błąd zamiast
  fałszywie oznaczać wiadomość jako przeczytaną.
- **Liczniki wreszcie liczą to, co trzeba.** Podgląd tokenów pokazuje jedną, spójną liczbę
  zużycia okna kontekstu (zgodną ze wskaźnikiem pod polem wpisywania i licznikiem kompresji),
  tokeny odzyskane z cache modelu są pokazane osobno zamiast ukrywane, zakładka „Sub-agent"
  nie pokazuje już zera mimo realnego zużycia, etykiety są po polsku, a dane zużycia
  z modeli Anthropic nie giną. Koszty LLM obejmują teraz pojedynczy strzał przy komendzie
  „/save session" i realne zużycie tokenów DeepSeek oraz platform w stylu OpenAI (plugin prosi
  API o dokładne dane w trybie strumieniowym).
- **Semantyczne wyszukiwanie w notatkach jest odporniejsze:** status indeksu pokazuje
  rzeczywistą liczbę dokumentów i odróżnia pusty indeks od błędu, indeks nie blokuje się na
  całą sesję pluginu po awarii dostawcy embeddingów, a notatki odrzucone przez limit (429)
  są automatycznie ponawiane zamiast oznaczane jako trwale nieprzetworzone.
- **Polskie nazwy komend wreszcie trafiają do palety poleceń** — komendy rejestrowały się,
  zanim plugin ustawiał język, więc paleta pokazywała angielskie nazwy nawet przy polskim
  interfejsie; teraz rejestracja czeka na ustawiony język.
- **Okna potwierdzenia wyglądają jak reszta Obsidiana**, nie jak systemowy popup przeglądarki —
  zamknięcie sesji, kasowanie umiejętności i sub-agenta oraz usuwanie zewnętrznego serwera MCP
  pytają teraz przez to samo okno modalne co reszta interfejsu.
- **Drobiazgi interfejsu:** okno sprzątania poczty i okno otwierania sesji dostały brakujące
  style, zakładka Triggery w panelu bocznym znów znajduje otwarty czat, podpowiedzi narzędzi
  w czacie pokazują rzeczywiście dostępne narzędzia, zapis profilu agenta nie nadpisuje pola
  modelu ani nie gubi wybranego języka, teksty ze znakiem dolara w podstawianej wartości nie
  wyświetlają się uszkodzone, notatki pamięci nie mają już angielskich zdań-etykiet, a pusta
  (ale poprawna) odpowiedź wyszukiwarki nie jest brana za nieczytelny plik binarny.
- **Równoległe zapisy list zadań (todo) i innych plików w tej samej turze** nie nadpisują się
  już nawzajem.
- **Martwe odwołania do dawno skasowanego modułu Agora** zniknęły z promptów agenta
  i z kontroli dostępu.
- **Podgląd tokenów oznacza szacunki jako przybliżone**, gdy dostawca modelu nie oddał w
  odpowiedzi realnego zużycia (usage) — liczby nie są już pokazywane jako pewnik, którym
  nie są.
- **Nadpisania wbudowanego agenta Jaskier zapisują tylko realną różnicę** względem
  fabrycznego szablonu, nie cały jego config — plik nadpisań w vaultcie zostaje mały
  i czytelny nawet po drobnej zmianie.

#### Removed

- **Sprawdzanie aktualizacji z GitHuba** — plugin już nie odpytuje sam api.github.com co
  3 godziny w poszukiwaniu nowej wersji; aktualizacje idą przez katalog wtyczek Obsidiana
  (po zaakceptowaniu) albo przez BRAT, tak jak wcześniej instalacja. Po podniesieniu wersji
  zostaje lokalne okno „co nowego" z notatkami wydania — bez żadnego ruchu sieciowego.
- **ComfyUI w całości** — Zoja, podgląd generowania obrazów, gotowe workflow. Generowanie
  obrazów zostaje przez dostawców chmurowych.
- **Sandbox uruchamiający własny kod JavaScript dla serwerów MCP** — zastąpiony prawdziwym
  protokołem MCP przez zewnętrzne procesy i usługi.
- **Project Hub w Komunikatorze** (projekty, wątki, briefy i 12 towarzyszących narzędzi) —
  zastąpiony trzema prostymi narzędziami poczty.
- **Pole „Kto może pisać" (can_message)** z definicji agenta — każdy agent może napisać do
  każdego; to ograniczenie i tak nie działało jak lista dostępu.
- **Ogólny przełącznik „Narzędzia MCP" w profilu agenta** — dostęp do zewnętrznych serwerów
  ustawia się per serwer.
- **Opcja „Zostaw jako draft" przy zamykaniu sesji czatu** — od dawna nie było jak wrócić do
  zapisanego draftu, więc zapisywała pliki, do których nic nie wracało. Zostają „Zarchiwizuj"
  i „Odrzuć".
- **Drugi guzik „Sumaryzuj streszczenia" w profilu agenta** — zostaje jeden „Podsumuj
  rozmowy" (oba robiły to samo), z opisem poprawionym tak, by opisywał całą piramidkę
  konsolidacji L1→L2→L3.
- **Martwe pola i ustawienia bez żadnego działania:** „Nadpisz instrukcje master/minion"
  w profilu agenta, „Zachowaj ostatnich sesji po L1", „Próg L3", `brief_prompt` oraz
  pozostałości starego panelu ustawień v2.

#### Security

- **Zewnętrzne serwery MCP pod kontrolą:** nowy serwer wymaga jawnej pierwszej zgody przed
  pierwszym użyciem narzędzia (z opcją „zawsze zezwalaj" per narzędzie), modal zgody pokazuje
  pełne argumenty wywołania, przed zapisem konfiguracji można podejrzeć listę narzędzi
  serwera, a wyłącznik (kill-switch) per serwer ukrywa jego narzędzia bez usuwania
  konfiguracji.
- **Ścieżki plików są porównywane w jednej, spójnej formie na każdym etapie sprawdzania
  uprawnień** — zamyka obejścia stref zakazanych i plików chronionych przez różne zapisy tej
  samej ścieżki („./", podwójne kodowanie znaków, różnice wielkości liter na Windows/macOS).
- **Wyłączone narzędzie jest naprawdę zablokowane** przy próbie użycia, nie tylko ukryte
  na liście; akcje zapisu, kasowania i tworzenia notatek z pustym polem „cel" są odrzucane
  zamiast przechodzić bez pytania o zgodę.
- **Treści z notatek, pamięci agenta i wyników narzędzi są jednolicie oznaczane w prompcie
  jako dane, nie polecenia** — modelu nie da się oszukać nagłówkiem ani komendą podszytą pod
  tekst notatki. Tekst wygenerowany przez samego agenta nie dostaje przywilejów wiadomości
  napisanej przez człowieka (nie uruchomi komendy „/" ani triggera skilla bez pytania),
  a adres internetowy podsunięty przez model nie jest traktowany jak link zaufany przez
  użytkownika.
- **Odczyt stron internetowych (web_read) ma własne, osobne okno zgody** — wcześniej dzielił
  je z wyszukiwarką, więc jedno odklikane zezwolenie po cichu odblokowywało pobieranie
  dowolnych adresów.
- **Zadania działające w tle po przełączeniu zakładki czatu korzystają z pamięci, modelu
  i trybu autonomii agenta, KTÓRY je zlecił**, a nie agenta widocznego akurat na ekranie —
  zamyka wyciek danych i uprawnień między agentami.
- **Delegacja twardo ograniczona:** limity głębokości dalszego delegowania (domyślnie brak
  dalszej delegacji, do 3 poziomów w Ustawieniach), maksymalnie 5 równoległych zadań na jedno
  wywołanie, egzekwowane ograniczenie folderów sub-agenta (`scope.folders`) oraz dziedziczenie
  przecięcia uprawnień rodzica i dziecka (wcześniej sub z ograniczonym zakresem mógł wystawić
  wnukowi delegacji pełny dostęp do vaulta).
- **Komunikator odporny na pętle spamu:** limit 20 wiadomości na 10 minut między tą samą parą
  agentów oraz licznik „odbić" w łańcuchu odpowiedzi (po 3 przekazaniach agent dostaje
  instrukcję przerwania pętli i oddania sprawy użytkownikowi). Wysyłka i limity działają
  poprawnie także przy wielu równoległych wysyłkach naraz.
- **Klucze API są maskowane w logach po nazwie pola, nie tylko po rozpoznanym formacie** —
  obejmuje OpenRouter, Groq, xAI i nowy format kluczy OpenAI. Maskowane są też błędy wracające
  od sub-agentów oraz nieudany strumień odpowiedzi modelu (np. błąd DNS/proxy), który potrafił
  wpisać klucz do komunikatu błędu.
- **Zapis ustawień zabezpieczony** przed sytuacją, w której nieudany zapis kasuje dotychczasową
  zawartość pliku ustawień.
- **Generowanie obrazu i dodawanie tekstu do obrazu przechodzi pełne sprawdzenie uprawnień
  także dla pliku źródłowego** — wcześniej agent z dostępem do folderu publicznego mógł tą
  drogą skopiować plik z folderu zakazanego. Zawartość pól artefaktu przechodzi przez ten sam
  filtr treści co reszta artefaktu.
- **Agent w trybie „Tylko przypisane" odzyskał wyszukiwarkę internetową, pobieranie stron,
  pocztę i delegację** — błąd odrzucał każde takie wywołanie jako „poza obszarem roboczym",
  mimo że nie dotyczyło żadnej ścieżki w vaultcie.
- **Fail-closed tam, gdzie działało „na pół gwizdka":** przebudowa indeksu wyszukiwania, cykl
  zmiany skórki, odczyt skrzynki Komunikatora i inspektor pamięci jawnie odmawiają działania
  zamiast cicho kontynuować przy niepełnych danych. Zmiana nazwy agenta jest odporna na błędy
  w trakcie operacji — nie kasuje pamięci pod starą nazwą ani nie przejmuje cudzej skrzynki.
- **Wdrożono politykę dostępu agenta** ograniczającą, do czego agent realnie sięga w vaultcie.
- **Naprawiono 13 luk XSS w interfejsie**, w tym wstrzyknięcie kodu przez nazwę narzędzia
  pochodzącą z zewnętrznego serwera MCP.
- **Zależności:** załatane podatności w `js-yaml` (stara wersja z niebezpiecznym domyślnym
  trybem wczytywania — potencjalne wykonanie kodu przez spreparowany nagłówek notatki)
  i `fast-uri`. Skrypt wydawania wersji nie wypisuje już tokenu GitHub do konsoli przy błędzie.

#### Performance

- **Start pluginu z ok. 8 sekund do ułamka sekundy.** Najpierw wycięcie dwóch sztywnych,
  nieuzasadnionych opóźnień startowych odziedziczonych po dawnym kodzie bazowym
  (ok. 8 s → ok. 0,2 s), potem dalsze szlifowanie startu (176 ms → 52 ms w warunkach
  produkcyjnych).
- **Plugin schudł z 3,0 MB do 2,16 MB** (w tym ok. 140 KB w ostatniej fali optymalizacji).
- **Podpowiedzi po wpisaniu `@`** (wzmianka notatki) działają znacznie szybciej — wcześniej
  każdy wpisany znak przeszukiwał cały vault od nowa.
- **Lista artefaktów w czacie** nie jest budowana od zera skanem całego vaulta przy każdej
  turze rozmowy.
- **Wyszukiwanie w pamięci agenta** jest zauważalnie szybsze (ograniczona liczba
  przeszukiwanych kandydatów w jednym zapytaniu), a konsolidacja pamięci (L1/L2/L3) odpytuje
  dysk jednorazowo zamiast wielokrotnie przy większej liczbie sesji.
- **Zapis pliku sesji jest dopisywany na końcu** zamiast przepisywany w całości przy każdej
  zmianie.
- **Odświeżanie tekstu odpowiedzi podczas strumieniowania jest ograniczone (throttling)**
  zamiast malowane przy każdej ramce — płynniejsze przewijanie przy długich odpowiedziach.
- **Sidebar Komunikatora** odświeża nagłówki skrzynki ze zbuforowanych danych zamiast czytać
  wszystkie pliki poczty przy każdym renderze.
- **Rejestr adresów odczytanych przez wyszukiwarkę internetową (`web_read`) ma sufit**
  (2000 wpisów) — po jego przekroczeniu najstarszy adres jest usuwany, więc lista nie rośnie
  bez końca przy długich sesjach.

#### Migracja

- **Zmiana identyfikatora pluginu z `obsek` na `pkm-assistant`.** Ustawienia, klucze API
  i dane przenoszą się automatycznie przy pierwszym uruchomieniu nowej wersji (dwa migratory:
  namespace ustawień wraz z odwołaniami sejfu kluczy oraz kopia `data.json` do nowego folderu
  wtyczki). Po aktualizacji:
  - **Skróty klawiszowe (hotkeys) trzeba przypisać na nowo** — Obsidian trzyma je jako
    `<id-pluginu>:<id-komendy>`, a zmieniły się obie części.
  - **Lista wtyczek może pokazywać dwa wpisy „PKM Assistant"** (stary, nieaktywny `obsek`
    i nowy `pkm-assistant`) — to nieszkodliwe.
  - **Stary folder `.obsidian/plugins/obsek/` kasujesz ręcznie**, po sprawdzeniu, że nowy
    działa poprawnie. Plugin go nie usuwa.
- **Ustawienia przenoszą się do `.pkm-assistant/settings.json`** w vaultcie — nic nie trzeba
  robić ręcznie.
- **Po usunięciu Project Hub stare pliki Komunikatora** (projekty, wątki, briefy oraz stary
  format skrzynek `inbox_<agent>.md`) zostają w vaultcie jako nieużywane — plugin ich nie
  widzi i nie kasuje. Kto chce, usuwa je ręcznie.

### Szczegóły techniczne (zapis dewelopera)

### refactor(core): YAML przez wbudowane parseYaml/stringifyYaml Obsidiana, js-yaml out (2026-09-07)

Walidator katalogu społeczności wytykał pakiet `js-yaml` w `package.json` (module-replacements:
zamiennik zalecany), a Obsidian i tak wozi WŁASNY parser YAML (`parseYaml`/`stringifyYaml`
z modułu `obsidian`) — dublowanie biblioteki tylko napychało bundle. `core/utils/yamlParser.ts`
NIE importuje już żadnego silnika YAML statycznie: trzyma slot wstrzykiwany
(`setYamlEngine({parse, stringify})`, eksport barrela razem z typem `YamlEngine`), bo barrel
`core/index.ts` musi wstawać w gołym Node bez `obsidian`. Composition root (`src/main.ts`)
wstrzykuje wbudowany silnik Obsidiana NATYCHMIAST po imporcie (przed klasą pluginu, żeby żaden
loader agentów/subów/skilli nie ruszył bez ustawionego silnika); testy AVA (preload
`harness/mock/register-obsidian-for-ava.mjs`) i harness (atrapa `harness/mock/obsidian.ts`)
wstawiają zamiennik `yaml` (eemeli/yaml, **devDependency**) z opcjami dumpu odpowiadającymi
dawnemu js-yaml (`indent:2`, zero zawijania długich linii, zero kotwic `&`/`*` na
referencjach). Publiczne API (`parseYaml`/`stringifyYaml`/`parseFrontmatter`/
`validateAgentSchema`) bez zmian sygnatur poza jednym wyjątkiem: `stringifyYaml` straciło
martwy parametr `options` (zero wołających w repo przekazywało cokolwiek poza obiektem do
zserializowania). `js-yaml` wyleciał z `package.json` w CAŁOŚCI (`dependencies` i
`core/utils/js-yaml.d.ts`), `THIRD-PARTY-LICENSES.md` odchudzony o jego wpis (lista opisuje
zawartość `dist/main.js`, a `yaml` tam nie trafia — jest devDependency, produkcyjny kod bierze
silnik z `'obsidian'`, już na liście `external` esbuilda). Bramki: 3681 testów, typecheck, lint,
lint:obsidian, build (`grep -c js-yaml dist/main.js` = 0), harness:selftest + harness:scenarios
(34/34 — harness bootuje prawdziwy `src/main.ts` i ładuje agentów z YAML, więc to jest właściwy
test silnika, nie atrapa).

### refactor(katalog): odpowiedź na raport walidatora katalogu społeczności Obsidiana (2026-09-07)

Zgłoszenie 2.2.0 do katalogu wróciło z raportem automatycznego walidatora. Ta fala zamyka
wszystko, co dało się zamknąć bez zmiany zachowania pluginu; wynik per sekcja raportu:

- **Behavior / Error (jedyny twardy bloker):** wycięta martwa metoda `restartPlugin`
  (`core/PluginBase.ts`, `src/main.ts`), która wyłączała i włączała plugin przez
  `app.plugins` — zakazane w Developer policies. Zero wołających; kampania dead-code z 02.09
  nie złapała jej, bo liczyła odwołania do eksportów, a metoda klasy z własnym testem wyglądała
  na używaną. Nowy strażnik `core/catalog_policy_guard.test.ts` pilnuje ZASADY: brak
  `disablePlugin`/`enablePlugin`, `eval`/`new Function` i `globalThis` w kodzie pluginu.
- **License:** `LICENSE` to czysty tekst GPL-3.0 (nota copyright w README) — GitHub rozpoznaje licencję.
- **Releases:** wydanie buduje od teraz GitHub Actions z taga (`.github/workflows/release.yml`):
  te same bramki co CI, atestacja provenance (`actions/attest-build-provenance`), wyłącznie
  `main.js`/`manifest.json`/`styles.css`. Zip i `THIRD-PARTY-LICENSES.md` zniknęły z assetów
  (także z istniejącego wydania 2.2.0). `release.js` tylko przygotowuje notatki i rebuild
  (`utils/releasePrep.ts`); `archiver` i `dotenv` poza `package.json` (`.env` czyta
  `process.loadEnvFile`). `esbuild.js` normalizuje końce linii osadzanych tekstów (md/css) —
  bundle jest identyczny na Windows i Linuksie (walidator: „build nie zgadza się z assetem").
- **Source code:** nowy most `core/utils/hostWindow.ts` (Obsidian: `window`, Node: okno
  dostarcza preload AVA / dom-shim harnessu) zamiast `globalThis` i gołych timerów; wyjątek
  „node-safe" w `eslint.obsidian.config.js` usunięty, lokalny `lint:obsidian` pokazuje to, co
  walidator. Fala lintu w `core/`, `modules/`, `src/`: zamknięte `no-global-this`,
  `prefer-window-timers`, `no-floating-promises`, `no-misused-promises`, `no-unused-vars`
  (poza 1 świadomym), `no-unnecessary-type-assertion`, `restrict-template-expressions`,
  `no-redundant-type-constituents`, `await-thenable`, `no-this-alias`. Źródła pluginu: 11 201 → 10 863
  ostrzeżeń; reszta to celowe granice `TS-any` (`no-unsafe-*`, `no-explicit-any`),
  `no-base-to-string` (stringifikacja wartości z YAML/argumentów narzędzi) i udokumentowane
  wyjątki (`hardcoded-config-path` jako twarde dno bezpieczeństwa, `only-throw-error` dla
  `NormalizedError`).
- **Dependencies:** `npm audit fix` — `hono` 4.13.7, `ip-address` 10.7.0, `qs` 6.16.0
  (serwerowa strona MCP SDK, nie w bundlu); `SECURITY.md` przeliczone.
- **Prywatność repo:** nazwy prywatnych agentów właściciela, nazwa jego vaulta i prywatne
  ścieżki (w tym lokalne ścieżki Windows) zastąpione neutralnymi przykładami w kodzie, testach,
  i18n i dokumentacji.

### ci(release): publikację wydania robi teraz GitHub Actions z atestacją provenance, nie lokalny `release.js` (2026-09-07)

`.github/workflows/release.yml` po pushu taga buduje, atestuje (`actions/attest-build-provenance`) i publikuje wydanie z DOKŁADNIE trzema plikami (`main.js`, `manifest.json`, `styles.css`); `release.js` (`npm run release`) zostaje skryptem przygotowania (wersja, notatki, rebuild kontrolny) — szczegóły w `RELEASE_PROCESS.md`.
### refactor(core): `DEFAULT_CONFIG_DIR` — martwy eksport barrela skasowany, ostatnie `hardcoded-config-path` w `core/runtime/` (2026-09-07)

Stała `DEFAULT_CONFIG_DIR = '.obsidian'` w `core/runtime/contracts.ts` (komentarz „P-11: fallback nazwy
folderu konfiguracji Obsidiana") i jej re-eksport z barrela `core/index.ts` miały ZERO konsumentów —
ani w kodzie produkcyjnym, ani w testach. Pochodzenie: plan clean-room (A1, 2026-09-05) wpisał ją do
kontraktu jako nazwany dom dla zachowania P-11 („brak `configDir` → domyślnie `.obsidian`"), ale samo
zachowanie żyje w `core/utils/pluginFolderMigration.ts` (fallback `configDir || '.obsidian'` + test),
a dwa pozostałe lokalne fallbacki (`AccessGuard.ts` `_configDir`/`SYSTEM_NO_GO`, `VaultIndexer.ts`
`HARD_EXCLUDES`) są celowo lokalne z wyjątkiem (4) w `eslint.obsidian.config.js`. Nikt nie planował
zbierać ich pod wspólny eksport — przepięcie dotykałoby trzech plików w dwóch modułach przy zerowej
zmianie zachowania, a literał i tak zostałby w jednym pliku (ostrzeżenie tylko by się przeprowadziło).
Kasacja: −3 linie w `contracts.ts`, −1 w `core/index.ts`, notka w `core/CLAUDE.md`. `lint:obsidian`
`obsidianmd/hardcoded-config-path`: 2 → 1 (zostaje `utils/buildManifest.ts:88` — skrypt buildowy
liczący lokalną ścieżkę deployu do vaulta, poza runtime pluginu). Bramki: typecheck, 3679 testów,
lint, lint:obsidian.

### fix(chat): STT czyta klucze z puli `chat.apiKeys`, nie z płaskich pól sprzed migracji (2026-09-06)

Zgłoszenie Kuby: Groq Whisper melduje „Brak klucza API" mimo wpisanego klucza. Warstwa: kod
(nie config, nie dane). `_toggleRecording` w `modules/chat/chat/chat_model.ts` składał klucze
z `chat.openai_api_key` / `chat.groq_api_key` / `chat.gemini_api_key` — kształtu, który migrator
(`core/runtime/legacySettingsMigration.ts`) przenosi do puli `pkmAssistant.chat.apiKeys.<platforma>`;
pole płaskie było więc zawsze puste. Naprawa: STT czyta z tej samej puli co `modelResolver`
i `GenerateImageTool`. Strażnik po źródle w `chat_model.test.ts` (pada na starym kształcie).
Przy okazji: etykiety w `stt.no_api_key` / `image.no_api_key` przestały podawać nieistniejące
nazwy pól (`groq_api_key`, `xai_api_key`…) — etykieta to nazwa platformy, a i18n (pl/en) dopowiada,
żeby klucz wpisać w Ustawieniach pluginu; test `GenerateImageTool.test.ts` i scenariusz harnessu
`38_multimodal_fake` dopasowane do nowego komunikatu. Branch `fix/stt-klucze-z-puli-apikeys`.

### release-pack fala 2 — wytyczne katalogu, updater OUT, minAppVersion 1.11.0, F2.13 (2026-09-04)

Siedem klastrow (W1-W7) na branchu `refactor/v2.2-release-2.2.0`, kazdy z pelnymi bramkami;
merge fali 1 (branch chmurowy, 35 commitow) na poczatku brancha — 3 konflikty rozstrzygniete na
korzysc `main` (status `NO_ATTEMPT` w runnerze scenariuszy zamiast rownoleglej implementacji
`emptyLiveRun.ts`, blok lintu harnessu wg `main`, `CLAUDE.md` wg `main`). Testy 2998 → 3023 (po review 3013 → 3023),
`lint:obsidian` 11 950 → 11 707 ostrzezen (0 bledow), build 2 153 969 B, harness selftest GREEN +
scenariusze 34/34.

`refactor(W1)` — shell + core pod wytyczne katalogu Obsidiana: `prefer-create-el` 36→0,
`prefer-window-timers` 24→9 (reszta node-safe, jawny wyjatek w `eslint.obsidian.config.js`),
naglowki ustawien przez `setHeading()`, sentence-case, `no-global-this`.
`refactor(W2)` — chat + ui-components: `prefer-create-el` 112→0, timery 39→0, `confirm()` →
`ConfirmModal` (SessionCloseModal), `MarkdownRenderer.renderMarkdown` (deprecated) →
`MarkdownRenderer.render()`, sentence-case.
`refactor(W3)` — agents/skills/sub-agents/onboarding/crystal-soul/multimodal/komunikator/
artifacts/memory/web pod te same wytyczne (`createEl` 44→0, timery 18→0, `no-alert` 4→0) +
**F2.13: znalezisko bezpieczenstwa** — sciezka awaryjna `SubAgentRunner._executeTool` bez
`mcpClient` wolala `tool.execute()` wprost, omijajac PermissionSystem (No-Go, admin_access,
scopeFolders); jedyna ochrona byla whitelista nazw narzedzi. Teraz fail-closed z komunikatem
i18n `subagent.tool_scope_unenforceable` + 2 nowe testy. Plus F2.22 (dedupe `log.warn` w
`saveBuiltInOverrides`, stala `ACCESS_POLICY_VERSION` w testach zamiast literalu `2`,
`MAX_KNOWN_URLS` eksportowana zamiast duplikowana w teście).
`refactor(W4)` — tools/models/embedding/agent-loop pod te same wytyczne + F2.14 (`is_end_of_stream`
po polu JSON zamiast substringu w tresci, `google.ts`/`ollama.ts`, +5 testow) + F2.8 (flaky
`DelegateTool.test.ts` F5: seam zegara zamiast realnego timera, 5 biegow pod obciazeniem
zielone) + F2.6 (`Vault.modify` → `Vault.process` w `WriteTool.ts` i `vault_binary_io.ts`, z
feature-detect i fallbackiem dla hostow bez `process`; nowe testy `WriteTool.test.ts` (6),
`vault_binary_io.test.ts` (4)).
`refactor(W5)` — **D1: sprawdzanie aktualizacji z GitHuba WYCIETE calkowicie** (zero ruchu
sieciowego bez akcji usera; `core/utils/versionCompare.ts` skasowany, −180 linii; zostaje
lokalny modal „co nowego" po podbiciu wersji). **D6: `minAppVersion` podbity do 1.11.0**
(`manifest.json` + `versions.json` `"2.2.0": "1.11.0"` — realnie uzywane API: `SettingTab.icon`).
F2.16 (komendy rejestrowane po `setLocale()` — koniec angielskich nazw w polskiej palecie),
F2.17 (straznik `core/i18n/commands_no_prefix.test.ts`), F2.18 (bezprzedmiotowe po D1),
F2.19 (tooltip ikony czatu przez i18n `main.ribbon_chat`), F2.20 (CI: `git diff --exit-code
manifest.json versions.json` zamiast porownania z package.json PO nadpisaniu przez esbuild),
F2.21 (lockfile: 596 z 668 wpisow dostalo `resolved`/`integrity`, 0 zmian wersji, `npm ci` OK).
Nota D11 w `SECURITY.md` (`npm audit`: podatnosci wewnatrz `@modelcontextprotocol/sdk` i
dev-deps, zero w bundlu; czekamy na upstream).
`refactor(W6)` — harness: DoD FAZY B zaostrzony (F2.9) — bramka „finalText niepusty" zastapiona
progiem ≥40 znakow ALBO co najmniej jedna proba narzedzia, zeby jeden token nie przechodzil
jako dowod wykonanej roboty.
**Naprawy po review fali 2 (04.09).** `fix(main)` — F2.16 przenioslo `register_commands()`
i `register_ribbon_icons()` do `initialize()`, czyli za `wait_for({loaded:true})`: wywrotka bootu
srodowiska zostawiala usera bez ani jednej komendy w palecie i bez ikon wstazki, a same ikony
zmienialy pozycje na pasku (W5-01/W5-04). Rejestracja wraca do `onload()`, ale jezyk jest znany
wczesniej — nowe `read_ui_language()` czyta JEDNO pole (`pkmAssistant.language`) prosto
z `.pkm-assistant/settings.json`, bez czekania na env; `setLocale()` w `initialize()` zostaje jako
idempotentne domkniecie. 4 nowe strazniki w `src/main.test.ts`, harness dry-boot raportuje odtad
liczbe komend i ikon wstazki (dwie nowe pozycje DoD). `docs(readme)` — „10 AI Platforms + custom
endpoints" → 9 platform bez Azure/custom (adaptery skasowane 2026-09-03, W7-01) i koniec
absolutnego „no automatic network requests at all": ruch w tle robi indekser vaulta przy chmurowym
providerze embeddingow oraz autostart serwerow MCP (W5-02).
`chore(W7)` — ogony po D1/D12: `core/CLAUDE.md` bez wzmianek o updaterze, noty licencyjne
zbibliotek zbundlowanych w `main.js` uzupelnione, martwe klucze i18n usuniete, zaslepki sprawdzania GitHuba wyciete z harnessu, README bez
adapterow azure/custom (parking dead-code 03.09).

Decyzje Kuby zamkniete w tej fali: D1 (wyciac), D5 (miesiac testow = **GO**), D6 (minAppVersion
1.11.0), D11 (odnotowac w SECURITY.md), D12 (noty licencyjne pelne), D13 (`releases/2.1.0.md` jako
trwala kopia notatek 2.1.0, zamiast linkowania GitHub Release).

**Nowy bloker odkryty przy D12:** licencja starego frameworka bazowego, na ktorym repo
wystartowalo, przestala pasowac do planu dystrybucji pluginu. Decyzja Kuby: po tamtym kodzie
nie ma zostac nic (kod, nazwy, historia) zanim plugin trafi do katalogu. Tag `2.2.0`, release i zgloszenie do katalogu **WSTRZYMANE** do zamkniecia
inicjatywy „clean-room" — plan w `Refaktor/Decyzje_Sesji/2026-09-04_clean_room_PLAN.md`.

### release-pack fala 1 — fixy priorytetowe, dokumentacja, harness pod lint (2026-09-03)

Siedem klastrow release-packu (fala 1a rownolegle na worktree, fala 1b sekwencyjnie na branchu
sesji po bledzie srodowiska w dwoch worktree): fixy priorytetowe, komendy, updater, wersja, CI,
harness, dokumentacja. Kazdy klaster przeszedl pelne bramki i adwersaryjny review.

`fix(main)` — pięć komend bez prefiksu "PKM Assistant:" w nazwie (Obsidian dokleja nazwę pluginu
sam; paleta pokazywała ją podwójnie), nazwy przez klucze i18n `command.*` (pl/en; id komend bez
zmian). Gotcha: `register_commands()` biegnie w `onload()` przed `setLocale()`, więc paleta
dostaje wersję EN — polskie nazwy wymagają re-rejestracji po ustawieniu języka (fala 2).
`fix(core)` + `fix(main)` — `isNewerVersion()` w `core/utils/versionCompare.ts` (semver-lite,
obcina `v`, pre-release niżej od pełnej wersji, śmieć → false; 8 testów); `check_for_update`
sygnalizuje tylko wersję NOWSZĄ — wcześniej porównanie `"v2.1.0" !== "2.1.0"` było zawsze
prawdziwe i każda kontrola (3 s po starcie i co 3 h) ogłaszała „nową wersję".
(Dzień później, 04.09, decyzja D1: cały updater wycięty razem z `versionCompare.ts` — patrz
fala 2. Do wydania 2.2.0 ten kod NIE wchodzi; wpis zostaje jako zapis historii, nie opis stanu.)
`chore(lint)` — glob `harness/**/*.ts` w `npm run lint` (werdykt Kuby 02.09). `chore(release)` —
wersja 2.2.0 w `package.json`/`manifest.json`/`versions.json` (tag bije Kuba). `ci` — nowy
`.github/workflows/ci.yml`: te same bramki co lokalnie na push/PR do main, build bez deployu.
`chore(deps)` — `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0; `npm audit` bez zmiany (hono, qs,
ip-address zafiksowane wewnątrz SDK; brace-expansion z narzędzi dev) — decyzja D11.
`fix(agents)`/`test(web)` po review: meta-pole `access_policy_version` zawsze w pliku nadpisań
(bez tego migracja polityki odpalała po każdym zapisie profilu), baseline diffu per built-in
z fallbackiem, test sufitu rejestru URL sprawdza rozmiar (`_knownUrlCount()`).

Zrobione: `fix(chat)` — `_chatOnUsage` liczy `estimated = apiInput === 0 && inputTokens > 0`
i przekazuje flage do `TokenTracker`, dwa dalsze zawsze-fallbackowe wolania dostaly `estimated:
true` na stale (4 nowe testy). `fix(web)` — `MAX_KNOWN_URLS = 2000` w `urlRegistry.ts`
z evikcja najstarszego wpisu (FIFO, `Set` zachowuje kolejnosc wstawiania), plus poprawka
`no-unsafe-assignment` (`Set.values().next().value` typuje sie jako `any`) wykryta dopiero przez
`lint:obsidian` (4 nowe testy). `fix(agents)` — `AgentLoader.saveBuiltInOverrides` pisze DIFF
wzgledem `createJaskier().serialize()` zamiast pelnego configu (dokleja B6 Runde 3 punkt 5), nowa
flaga `Agent._modelFromSource` bramkuje legacy zapis pola `model` w `serialize()` (persystuje
tylko gdy pochodzi z yamla albo z jawnego `update()`) — 14 nowych testow. Werdykt Kuby o
generycznym passthrough nieznanych pol yamla swiadomie NIE wdrozony (koliduje z udokumentowanym
kontraktem pol-widm z B6 R3; open point w `modules/agents/CLAUDE.md`).

`test(harness)` — runner scenariuszy rozpoznaje pusty bieg live (zywy model bez ANI JEDNEJ proby
narzedzia) osobnym statusem `NO_ATTEMPT` — nie RED (to nie znalezisko w pluginie) i nie GREEN
(niczego nie sprawdzilismy); bramka fail-closed liczy go jak `EMPTY`. Jedno miejsce
(`scenarios/_runner.ts` + `isNoAttemptRun` w `_asserts.ts`) dla wszystkich 13 scenariuszy live,
zamiast rzemiosla w kazdym z osobna (offline bez zmiany). Rownolegla implementacja z sesji
chmurowej (`harness/lib/emptyLiveRun.ts`) odrzucona przy merge 04.09 — dwa strazniki tej samej rzeczy.
`chore(harness)` — `harness/**` wchodzi pod `npm run lint` z ta sama zlota zasada barreli (per-plikowa
lista wyjatkow dla scenariuszy 33 i 35, ktore testuja czyste helpery bebechow) plus jedna realna
naprawa u zrodla (`harness/mock/app.ts` bral yaml-helpery przez bebechy `core/utils/yamlParser.js`
zamiast przez `core/index.js`).

Dokumentacja (`docs`): sekcja `[2.1.0]` dopisana do CHANGELOG-a (brakowala), `releases/2.2.0.md`
jako nowe notatki wydania, poprawki w `README.md`/`RELEASE_PROCESS.md` usuwajace
twierdzenia bez pokrycia w repo (m.in. falszywe "zgloszenie do katalogu Obsidiana zlozone" —
zamienione na "planowane"), `Nauka/PLAN_REFAKTORU_v2.1.html` zaktualizowany o realny stan wersji
manifestu i luki w changelogu kampanii audytowej.

Przy okazji (wszedlo na branch przed fala): naprawiona bramka `lint:obsidian` na czystym
`npm ci` (override `ajv` dla `@eslint/eslintrc` w `package.json` — bez tego lint:obsidian nie
wstawal wcale po swiezym klonie).

### fix(memory): migrator v2->v3 liczy kazda sekcje i kazdy akapit (2026-08-28)

Naprawa znalezisk #1-#2 nocy audytowej 27/28.08 (odpowiedz na Bug 1 briefu Niki: "migrator tnie
zdania na pol", gubione sekcje). Plan migracji liczy KAZDA sekcje starego brain.md (notatka /
keepInBrain / deletedSections) - user nie zatwierdza juz planu, w ktorym czegos nie widac;
`keepInBrain` przestalo byc martwe (sekcje nierozpoznane przezywaja verbatim jako sekcje obce
nowego brain.md); jednostka migracji to akapit/bullet, nie linia (koniec notatek-fragmentow zdan
i nazw urwanych w pol slowa); `needsMigration` rozpoznaje brain.md juz w formacie v3 (round-trip
na wlasnym wyjsciu zamkniety), a heurystyka wymaga korroboracji sygnalow i ma backup takze na
sciezce skip (werdykt adwersaryjnej weryfikacji: pojedynczy slaby sygnal wygaszalby migracje bez
odwrotu). Kolizje nazw notatek dostaja sufiks zamiast cichego zjadania tresci. Workflow: sonnet
-> opus FAIL (bloker CRITICAL) -> runda 2 + korekty lidera. Testy 2280 -> 2300 (20 straznikow
naprawy, w tym pierwsze na false-positive detekcji), bramki komplet, scenariusze 34/34.

### fix(bledy): naprawy po audycie bledy - fala 2, klastry H-M (MEDIUM/LOW obu biegow) (2026-08-24)

Druga fala tej samej fabryki (wariant B, spec + straznik czerwony przed fixem, Opus per klaster
w worktree, review i proba straznika przez lidera przed merge): wszystkie otwarte MEDIUM/LOW
biegu `bledy` ORAZ 13 otwartych MEDIUM/LOW biegu `security` (kolejka q_sec2_medium_low - decyzja
Kuby 23.08: naprawa, nie odkladanie). Po obu falach WSZYSTKIE 55 potwierdzonych biegu `bledy`
naprawione (jedyny wyjatek: AUD-bledy-009 INFO zostaje swiadomie). Bramki po fali 2:
2158 testow (z 2064), typecheck, lint, lint:obsidian 88 (bylo 90 - dwa errory mniej, zero
nowych), build, selftest GREEN, scenariusze 34/34, dry-boot czysci 2 timery registerInterval.
Klastry przekrojone wg wlasnosci plikow (dawna litera K rozpuszczona w H/I/J/L) - zero
wspolnych plikow miedzy rownoleglymi wykonawcami.

- **H - demontaz, reszta (AUD-bledy-035, 037, 045, 048, 059, 038, 036, 060, 040, 030;
  merge 579627b3).** `AgentManager.dispose()` odpina watcher yamli agentow; arkusze CSS
  wchodza WYLACZNIE przez rejestr `modules/crystal-soul/styleSheets.ts` (`adoptSheet`/
  `removeAdoptedSheets` - 7 miejsc, koniec dokladania arkuszy przy kazdym wlacz/wylacz);
  `SidebarNav.dispose()` w `onClose` panelu; sink `pkm-assistant.log` domykany
  `disposeFileSink()` jako OSTATNI krok `onunload` (flush ogona); gole budziki
  `check_for_update` i `ask_user` w `registerInterval`; migracja ada-002 pokazuje Notice
  dopiero po potwierdzonym zapisie; pusty catch licznika poczty = `log.warn` + chip `?`.
  AUD-bledy-009 (INFO, brak drzwi demontazu modules/models) zostaje swiadomie.
- **I - Stop i zmiana zakladki maja pierwszenstwo przed "domknij ture" (AUD-security-113
  = Z10, 115, 116, 129 oraz AUD-bledy-055, 015, 002, 003, 016, 018; merge 5905ae90).**
  Bramki abortu z OBU stron finalnego strzalu backstopu (Stop w trakcie = `stoppedBy:'abort'`,
  zaslepka nie laduje w oknie) i przed `beforeContinue` (dorobek narzedzi zostaje w sesji -
  kontrakt salvage nietkniety); wyjatek z hooka/`resolveTools`/store domyka `loop.end
  stop=error` zamiast urywac slad; hardstop backstopu leci w payloadzie modelu, nie jako
  wiadomosc usera w transkrypcie; uchwyt tury kasowany tylko po zgodnosci `turnId`
  (finalizacja starej tury nie zrzuca zywej); dren kolejki 100 ms ma uchwyt i wlasciciela
  `{agentName, tabKey}` - Stop kasuje zakolejkowana wiadomosc (tekst wraca do pola),
  przelaczenie zakladki rozbraja timer; `handle_error` zeruje wskazniki malowania.
- **J - MCP i narzedzia melduja ze stanu (AUD-bledy-029, 021, 022, 023, 034, 024,
  AUD-security-128 = Z9; merge 6527e45c).** `ExternalMcpManager` widzi smierc procesu
  serwera (haki `onclose`/`onerror` transportu przed handshakiem: status "rozlaczony" +
  wyrejestrowanie narzedzi); `closeAll()` rownolegle `allSettled` z sufitem 5 s per serwer,
  flaga `_unloaded` gasi `autostart`/`connect` po demontazu; blad polaczenia tlumaczony po
  KSZTALCIE (ENOENT/EACCES/ECONNREFUSED/timeout) na zdanie i18n - koniec "spawn npx ENOENT"
  w Ustawieniach; pamiec odmow w MCPClient wygasa po 15 min (jedno "Odmow" przestalo
  blokowac narzedzie do konca zycia pluginu); `memory_save`/`memory_delete`: pad przebudowy
  indeksu nie cofa udanego zapisu (`success:true` + `index_stale` + warning); maska sekretow
  w catchach `executeToolCall`, `delegate` i `agent_delegate`.
- **L - poczta, pamiec i suby melduja ze stanu (AUD-bledy-041, 042, 046, 047, 011, 014;
  merge 7d7efeab).** 6 kluczy i18n poczty (4 wolane, ale nieistniejace - user widzial goly
  klucz) + straznik parytetu SKANUJACY ZRODLA (`t('...')` w kodzie musi istniec w pl i en);
  `kom_read` przy padzie zapisu ptaszka `ai_read` melduje blad, nie "przeczytane" (koniec
  cichej petli pingow); pad zalozenia folderu skrzynki to komunikat o skrzynce, nie
  "nieznany adresat"; stemplowanie sesji po L1 z lista nieostemplowanych w wyniku kroku
  ("zapisane, nie ostemplowane"); `subagent_error` w tym samym ksztalcie co `subagent_call`
  i rozpoznawany przez parser sesji (padniety bieg suba nie znika z odtworzonej rozmowy);
  "Uzyj u agenta" w Zapleczu z try/catch + Notice.
- **M - ogony security z kolejki q_sec2_medium_low (AUD-security-105, 111, 118, 122, 123,
  124, 125; merge 57f8b2fc).** Jedna funkcja rozpoznawania naglowkow (ATX + setext,
  CR/CRLF) dla bramki `heading_forbidden` i zlewu `findSection` - patch w `## Sekcja` nie
  trafia w podrobiony `### Sekcja`, setext nie omija zakazu; `pathById` jedynym
  rozstrzygnieciem id->sciezka dla bramki i zlewu artefaktow (koniec rozjazdu na nieswiezym
  indeksie); `pola` przyjmuja wylacznie skalary (walidator sprawdza dokladnie to, co idzie
  na dysk); `kom_send` kanonizuje synonimy adresata (`agent`/`target`/`to`/`to_agent`)
  PRZED oknem zgody, "Zawsze zezwalaj" zapisuje regule per kanoniczny adresat;
  podsumowanie rozmowy wchodzi do promptu systemowego za plotem K9 (`fenceUntrusted`);
  etykieta popovera mowi "Tworzenie folderow" - tyle, ile przelacznik naprawde gasi
  (decyzja Kuby: popover bez nowych funkcji).

Zamkniete pozycje ZNANE rejestru ryzyka: Z7 (fala 1/B), Z9 (J), Z10 (I). `status naprawy`
pod kazdym znaleziskiem w `audyt/biegi/2026-08-23_bledy/RAPORT.md` (55/55) oraz pod
wszystkimi 13 pozycjami kolejki q_sec2_medium_low i 11 HIGH z K15-K23 w
`2026-08-23_security/RAPORT.md`. Ogony i lekcje:
`Refaktor/Decyzje_Sesji/2026-08-23_naprawy_bledy.md`.

### fix(bledy): naprawy po audycie bledy - klastry A-G, wszystkie HIGH (2026-08-23)

Pierwszy pelny gauntlet karty `bledy` (moduł 10: obsluga awarii; 98 agentow, 15,7 mln tokenow,
HEAD a77339dd) dal 55 potwierdzonych znalezisk (15 HIGH po kalibracji = 12 zjawisk) w 7 klastrach
przyczyn; raport `audyt/biegi/2026-08-23_bledy/RAPORT.md`. Fala 1 naprawia WSZYSTKIE HIGH tego
samego wieczora: 7 klastrow A-G, kazdy z testem-straznikiem czerwonym przed fixem (czerwien
weryfikowana przez lidera na kodzie z main), osobne galezie `fix/bledy-A..G`; bramki po fali:
2064 testy (z 1981), typecheck, lint, lint:obsidian 90 (baseline), build, harness selftest GREEN
i 34/34 scenariuszy. Wspolne wzorce (synteza): narzedzia zglaszaja porazke inaczej niz czyta ja
czat; sukces meldowany z zamiaru, nie ze stanu; nieudany odczyt brany za "pusto"; demontaz nie
ubija tego, co uruchomil start; czujnik (harness) sam klamal.

- **A - jeden ksztalt porazki narzedzia (AUD-bledy-027 HIGH, 058, 025, 013; merge ff2e6434).**
  `executeToolCall` normalizuje: `success:false`/`error` bez `success:true` dostaje `isError:true`
  BEZ kasowania oryginalnych pol. Status chipa, link "otworz zapisany plik", odtwarzanie historii
  i status kroku `tool.post` suba licza JEDNA czysta regula `core/utils/toolResultStatus.ts`
  (`shouldLinkWrittenFile`: link tylko przy sukcesie). Padniete narzedzie suba wraca do transkryptu
  linia "Blad narzedzia ..." przez maske sekretow K8. Kształt `{success:false}` w narzedziach
  zostaje - dochodzi wylacznie znacznik.
- **B - demontaz najpierw zatrzymuje, potem odpina (AUD-bledy-056 HIGH, 054 = Z7 z 16.08,
  AUD-security-114; merge 9583f835).** `SubTaskRegistry.stopAll(reason)` wola KAZDY uchwyt abortu
  (kazdy w try/catch, slad `stop.requested` w trace); `onunload` wola `stopAll('unload')` +
  `stopAllDelegations('unload')` (kontrolki biegow, ktore nie zdazyly wejsc do rejestru - okno
  przed `onTaskCreated`) PRZED zamknieciem MCP i `dispose()`. "Zamknij chat" zatrzymuje ture
  zakladki i jej suby tymi samymi funkcjami co Stop (`stop_generation`, `requestStop` po
  wlascicielach). Straznik: bieg w tle + `plugin.onunload()` => model NIE dostaje kolejnego
  zadania. Zamyka pozycje Z7 rejestru ryzyka (sub mielil po wyladowaniu do 30 min).
- **C - odczyt, ktory zawiodl, nie jest podstawa zapisu (AUD-bledy-061 HIGH, 063 HIGH, 043, 044;
  merge 303e953d).** Nowy `core/utils/probeFile`: trzy stany `exists/missing/unknown`, `false`
  z `exists()` POTWIERDZANE odczytem (na Dysku Google `exists()` klamie - incydent 2026-07-28).
  `getBrain`/`rebuildBrainIndex`/`startActiveSession`/`StateManager` nie nadpisuja plikow przy
  `unknown`; `.bak` brain.md powstaje takze przy niepewnym stanie; `StateManager` nie utrwala
  defaultow po nieudanym odczycie; komunikator odmawia zapisu zamiast wchodzic w cudza wiadomosc;
  padniety odczyt pamieci melduje sie w prompcie ("NIE UDALO SIE WCZYTAC...") zamiast udawac
  brak pamieci.
- **D - todo przez kolejke per sciezka (AUD-bledy-057 HIGH, 031; merge f925129e).** Kazdy
  read-modify-write listy w lancuchu promis per sciezka pliku (wzor `AgentMemory._writeQueues`) -
  rownolegle tool_calle jednej tury (`Promise.all` w petli) nie kasuja sobie zmian; zwrotka =
  stan ODCZYTANY z dysku po zapisie; `finish` z padem kasowania oddaje blad zamiast "zakonczono".
- **E - meldunek ze stanu, nie z zamiaru (AUD-bledy-026 HIGH, 028 HIGH, 020, 010, 012;
  merge 9e60a7fa).** `ask_user` bez UI (zakladka w tle) zwraca `{success:false, error:
  'ask_user.no_ui'}` zamiast zmyslac zgode z pierwszej opcji. Ustawienia MCP: `persistOrRollback`
  (pad zapisu = Notice + cofniecie mutacji w pamieci + rerender ze stanu prawdziwego),
  kill-switch zamyka serwer NIEZALEZNIE od zapisu, `schedule_save` lapie pad (koniec unhandled
  rejection z timera). `delegate` multi-task oddaje liste `rejected` z powodami (same odmowy =
  `success:false`). Pusta instrukcja subagenta kasuje `KNOWLEDGE.md` (nie zostaje stara tresc);
  `deleteSubAgent === false` daje komunikat porazki, modal sie nie zamyka.
- **F - strumien zna trzy wyjscia (AUD-bledy-004 HIGH, 005/051 HIGH, 006, 007, 008/052;
  merge f25a76b7).** Transport domkniety bez sentinela platformy (XHR DONE, decyzja odlozona
  o tick, sentinel w ostatniej porcji wygrywa; 12 platform sprawdzonych) rozstrzyga promise
  trescia, ktora przyszla, albo odrzuca z powodem - `Summarizer` i `web/summarize` przestaja
  wisiec, slot bramki sie zwalnia. Pole `error` w chunku przy HTTP 200 dochodzi ZDANIEM przez
  `handlers.error` (naprawiony tez spread stringa porcji na `{0:'d',1:'a',...}`). Zepsuta porcja
  SSE zostawia `log.warn` z maska zamiast znikac. `get_models` ma wlasciciela odrzucenia, brak
  sieci przy models.dev = pusty indeks zamiast TypeError. Stop w oknie backoffu 429 budzi budzik
  i NIE wysyla nowego zadania (`stop_stream()` = Stop z zewnatrz vs `_endStream()` = wewnetrzne
  domkniecie).
- **G - czujnik mowi prawde (AUD-bledy-033 HIGH, 039; merge 7ad58815).** `harness:selftest`
  konczy sie kodem z werdyktu DoD (`buildDod` + `dodToExitCode` - jedna mapa dla raportu,
  `--json.ok` i kodu wyjscia procesu; wczesniej bezwarunkowe `hardExit(0)` i `ok:true` na
  sztywno). Pozycje DoD czytane z trace przy jego braku sa FAIL z powodem "trace niedostepny",
  a raport przestaje twierdzic "model nie uzyl narzedzi", gdy nie ma z czego tego wiedziec.
  Selftest na main po zmianie: GREEN 4/4 - poprzeczka realna, main ja trzyma.

Szczegoly per znalezisko: `- **status naprawy:**` pod kazda pozycja w
`audyt/biegi/2026-08-23_bledy/RAPORT.md`. MEDIUM/LOW obu biegow: fala 2 (klastry H-M), osobny wpis.

### fix(security): naprawy po DRUGIM biegu audytu security — klastry K15-K23 (2026-08-23)

Drugi bieg `/audyt security` (tryb oszczedny: 8 kawalkow, 2 rundy, 59 agentow, 63 min,
HEAD 53c75da9) dal 28 potwierdzonych znalezisk (11 HIGH po kalibracji syntezy, 13 MEDIUM,
4 LOW, 1 INFO) i 5 obalonych; raport `audyt/biegi/2026-08-23_security/RAPORT.md`. Wszystkie
HIGH (po sklejeniu duplikatow 9 klastrow) naprawione tego samego dnia, kazde z testem-straznikiem
czerwonym przed naprawa, na osobnych galeziach `fix/security-K15..K23`; bramki po merge'u:
1981 testow, lint:obsidian 90 (baseline), harness 34/34. Wspolny wzorzec znalezisk (synteza):
bramke wpinano w wyliczone miejsca zamiast w waskie gardlo, wiec blizniacza droga do tego samego
skutku zostawala bez bramki. MEDIUM/LOW czekaja na decyzje wlasciciela.

- **K15 — strefa No-Go porownywana bez rozrozniania wielkosci liter (AUD-security-101).**
  `AccessGuard._isNoGo` porownywal bajt w bajt, wiec na Windows/macOS (system plikow bez
  rozrozniania liter) `Projekty/prywatne/tajne.md` przechodzil bez okna zgody, choc
  `Projekty/Prywatne/tajne.md` byl odrzucany — ten sam plik; tak samo `.Obsidian/`, `.TRASH/`.
  Zasada po naprawie: bramka ZAKAZU sklada litery (`_normalizeForDenyCompare`, ta sama receptura
  co `isProtectedPath`), bramka ZEZWOLENIA (whitelista, `scope.folders` suba) zostaje doslowna —
  oba kierunki fail-closed; wpisy No-Go normalizowane przy zapisie. Ta sama luka domknieta w
  wykluczeniach indeksu semantycznego (`VaultIndexer._isExcluded`) — przy rozjezdzie liter do
  indeksu wchodzila nawet pamiec agentow. 9 testow (`core/security/nogo_case.test.ts`,
  `VaultIndexer.test.ts`).
- **K16 — `add_text_to_image` przepisywal pliki spoza zasiegu agenta (AUD-security-102/126).**
  Bramka widziala tylko CEL zapisu, a obraz ZRODLOWY szedl przez sama walidacje sciezki (bez
  No-Go, whitelisty i zakresu suba): agent z dostepem do `Publiczne` i zakazem `Prywatne` mogl
  skopiowac plik z `Prywatne` do `Publiczne`. Od teraz zrodlo przechodzi przez pelna bramke
  `checkPermission('vault.read')` ZANIM plik zostanie dotkniety (tozsamosc i zakres ze znacznikow
  runtime `_invocation*`; brak bramki = odmowa). Okno zgody pokazuje takze ZRODLO operacji.
  Brakujacy klucz i18n `mcp.text_overlay.invalid_path` dopisany. 5 testow.
- **K17 — `agent_delegate` podlega osi i zgodzie poczty jak `kom_send` (AUD-security-110/109).**
  Delegacja deponowala list w cudzej skrzynce mimo WYLACZONEJ grupy komunikator (os K3 oceniala
  nazwe `agent_delegate`, grupa delegation) i bez pytania (akcja `delegate`, przelacznik cichy).
  Jedna bramka na jednej drodze: `sendAgentMail` pyta jako pierwszy warunek
  `checkToolAxis(<agent z runtime>, 'kom_send')`; `agent_delegate` -> akcja `agent.message`
  (YELLOW jak `kom_send`, ten sam przelacznik zgody), modal pokazuje adresata i tresc. Akcja
  `delegate` (bieg suba) nietknieta. 10 testow, atrapy obu plikow z prawdziwym `ToolRegistry`.
- **K18 — wlasciciel tury zamrozony PRZED budowa promptu (AUD-security-112).** `send_message`
  czytal `getActiveAgent()`, `rollingWindow` i sciezke sesji dopiero po awaitach przygotowania
  (brain.md, sesja, mapa vaulta — sekundy), a `_switchTab` nie jest blokowany: jedno klikniecie
  w druga zakladke przepinalo ture agenta A (prompt z JEGO pamieci) na model, uprawnienia i sesje
  agenta B. Nowe `freezeTurnOwner(view)` (`turnOwner.ts`) czyta widok RAZ, synchronicznie, obok
  `createTurnAbort()`; od tej linii wszystko idzie z `FrozenTurnOwner` (agent, okno, licznik,
  pamiec po nazwie, sesja, zakladka, autonomia). `getActiveSystemPromptWithMemory(context, agent?)`
  i `get_chat_model({agent})` przyjmuja agenta argumentem. Przelaczanie zakladek NIE jest
  blokowane. 8 testow (4 zachowania + 4 po zrodle). Swiadoma granica: awaity przed zamrozeniem
  (zapis sesji po ciszy, komendy `/`, wzmianki) — opisana w gotchy modulu.
- **K19 — kolejka wiadomosci wozi proweniencje (AUD-security-117/131).** `_queuedMessage` byl
  golym stringiem, a oba dreny nadawaly mu `human` — tekst maszynowy (guzik artefaktu, propozycja
  delegacji, komentarz inline) wyslany w trakcie tury odzyskiwal przywileje czlowieka (rejestr
  adresow `web_read`, markery `@@skill:`, komendy `/`). Nowy `queuedMessage.ts`: slot to
  `{text, meta}`, pieczatka z `resolveMessageOrigin` (fail-closed), oba dreny oddaja ZAPAMIETANA
  proweniencje; goly string = maszyna. 12 testow; asercja utrwalajaca stara wade usunieta.
- **K20 — klucz API nie wchodzi do komunikatu bledu ani do logu, trzy warstwy
  (AUD-security-120/132/133).** Przy padzie strumienia BEZ CIALA (DNS, proxy, status != 200 przed
  body) `dispatchEvent` doklejal `event.source = this` (streamer z `headers` i `body`), a
  `normalize_error(e?.data || e)` wpisywal cale zdarzenie do `message` — reprodukcja obu biegow
  audytu dawala „KLUCZ JAWNY: true" (Azure `api-key`, Custom/LM Studio `Bearer`); maska K8 nie
  lapala zaescapowanego JSON-a. Naprawa: (1) `event.source` to sam opis (`url`, `method`,
  `readyState`), sluchacz bledu podaje wycinek; (2) `normalize_error` wycina pola-sekrety
  (`headers`, `source`, `request`, `request_params`, `xhr`, `config`, `options`), odporny na
  cykle, limit 4000 znakow; (3) `maskSensitiveData` lapie pare pole:wartosc w JSON-ie
  zaescapowanym raz i dwa razy, Logger maskuje kazdy poziom (`cause`, `response`, `data`).
  Zlew czatu (K20b): `handle_error` i `log.error('Chat', ...)` ida przez `safeErrorText`
  (normalizacja -> maska -> 800 znakow). Tresc bledu od dostawcy („Incorrect API key") dociera
  jak dotad. 22 + 11 testow (`stream_error_secrets.test.ts`, `errorUtils.test.ts`,
  `Logger.test.ts`, `SensitiveDataGuard.test.ts`, `safeErrorText.test.ts`).
- **K21 — bramka artefaktow ocenia cel z tozsamosci runtime (AUD-security-121/103).**
  `_extractToolContext` dostawal worek argumentow SPRZED nadpisania zaufanych `_invocation*`,
  wiec `artifact_create` z `_invocationAgentName:'Wspolne'` od modelu byl oceniany pod cudzym
  folderem, a zapisywany pod wlasnym — whitelista i zakres suba liczone na zlej wartosci. Teraz
  ekstraktor dostaje `argsWithContext`, a `ArtifactCreateTool.contextExtractor` bierze tozsamosc
  wylacznie z `ctx.agentName`. 5 testow (pelny lancuch z podsluchem celu ocenianego przez bramke).
- **K22 — „Zawsze zezwalaj" nie zapisuje wieloznacznika z celu od modelu (AUD-security-104).**
  `delete {path:"*"}` przechodzilo do okna zgody (wywolanie i tak padalo na narzedziu), a klik
  „zawsze" zapisywal TRWALA regule `vault.delete::*` — kazde kasowanie tego agenta bez modala,
  takze po restarcie. `createPatternKey` traktuje cel doslownie (`literalTarget`: `<` podwojone,
  `*` -> token `<gwiazdka>`); `akcja::*` nie ma juz jak powstac z argumentu narzedzia, a innej
  drogi zapisu reguly nie ma (ekran regul tylko listuje i kasuje). Reguly zastane ZOSTAJA
  honorowane, ale `loadApprovals` zglasza je ostrzezeniem z lista — do przejrzenia w Ustawienia ->
  Bezpieczenstwo -> Approved actions. Obrona w glab: `sanitizePath` odrzuca `*` (takze `%2A`),
  swiadomie TYLKO `*` (`?`, `[`, `%` sa legalne w nazwach notatek). 8 testow.
- **K23 — Oczko i @-wzmianki przez pelna bramke agenta tury (AUD-security-119).**
  `buildActiveNoteContext` wczytywal osadzenia `![[...]]` z aktywnej notatki bez No-Go i whitelisty
  — notatka z zewnatrz z `![[Prywatne/skan.png]]` wysylala bajty pliku ze strefy No-Go do
  dostawcy modelu po jednej niewinnej akcji usera. Nowa opcja `canReadImage` (predykat
  wstrzykiwany; `modules/multimodal` dalej bez importu `core/security`); brak predykatu = brak
  obrazow (fail-closed); wolacz w `chat_model.ts` buduje go z `checkPermission(agent, 'vault.read')`
  wlasciciela tury. @-wzmianki przepiete na ten sam predykat (dotad gole `_isNoGo`). Zakres
  swiadomie waski: osadzenia, nie sam otwarty plik. 8 testow.

Poza zakresem napraw (do decyzji wlasciciela, kierunki w raporcie): 13 MEDIUM + 4 LOW + 1 INFO,
m.in. ogony K5 (Stop w trakcie finalnego strzalu backstopu, „Zamknij chat" bez zatrzymania subow,
auto-tura po Stopie, jeden slot uchwytu na nazwe agenta, hooki po narzedziach po Stopie),
podsumowanie rozmowy w prompcie systemowym bez ogrodzenia, `###` w artefaktach przekierowuje
patch, `pathById` vs `_findFileById` po przeniesieniu notatki, wiersz „Tworzenie plikow"
w popoverze wylacza tylko `create_folder`.

### fix(security): whitelista folderow mierzy tylko sciezki — agent "Tylko przypisane" odzyskuje web_search, web_read, kom_send i delegate (K14, 2026-08-23)

Zaszlosc, nie regresja: objaw zmierzony probem takze w drzewie sprzed napraw z 22.08
(`962908d2`). Nie wprowadzila go zadna z napraw K1-K13 — K13 tylko przeszlo obok niego,
opisujac `targetIsVaultPath` jako flage "nie kanonizuj" i zostawiajac reszte bez zmian.

- **Objaw.** Agent w trybie "Tylko przypisane" (`guidance_mode: false`) z whitelista folderow,
  np. `focusFolders: ['A/']`, dostawal odmowe `Path "..." is outside the agent's workspace` dla
  KAZDEGO wywolania `web_search`, `web_read`, `kom_send` i `delegate`. Nie chodzilo o zadna
  konkretna sciezke — odbijalo sie samo zapytanie ("jak dziala X"), adres strony, imie adresata
  i nazwa roli suba. W praktyce: taki agent w ogole nie mial wyszukiwarki, pobierania stron,
  poczty do innych agentow ani delegacji. Dotykalo to tez subow ze `scope.folders` (bariera
  zakresu mierzyla zapytanie tak samo jak whitelista).
- **Skad sie to bralo.** `PermissionSystem.checkPermission` wola
  `AccessGuard.checkAccess(agent, targetPath, level, { scopeFolders, targetIsVaultPath })` dla
  KAZDEJ akcji z niepustym `targetPath`. Dla akcji z `NON_VAULT_TARGET_ACTIONS` (`web.search` →
  zapytanie, `web.read` → URL, `agent.message` → adresat, `delegate` → nazwa roli,
  `external.call` → nazwa narzedzia) flaga `targetIsVaultPath: false` wylaczala TYLKO
  kanonizacje. No-Go, pliki chronione, whitelista `focusFolders` i bariera `scope.folders`
  nadal mierzyly ten ciag jak sciezke — a zapytanie z definicji nie lezy w zadnym folderze
  vaulta, wiec zawsze wypadalo "poza obszarem roboczym".
- **Naprawa.** `AccessGuard.checkAccess` przy `opts.targetIsVaultPath === false` wraca
  NATYCHMIAST `{ allowed: true, reason: 'non-vault-target' }` — przed kanonizacja, bariera suba,
  `admin_access`, No-Go, plikami chronionymi i whitelista. Whitelista folderow pilnuje SCIEZEK
  i tylko sciezek; porownywanie z nia frazy wyszukiwania to kategoria bledu, nie ostroznosc.
  Domyslka `targetIsVaultPath: true` zostaje — nowy wolacz bez flagi dalej dostaje pelna ocene
  sciezkowa (fail-closed).
- **Czego naprawa NIE rozluznia.** `PermissionSystem` nie zmienia przeplywu dalej: klasyfikacja
  ryzyka, bramka zgody i `disabled_tools` dzialaja dokladnie jak dotad (odmowa dla wylaczonego
  narzedzia i RED dla `external.call` potwierdzone `core/security/tool_axis_guard.test.ts`,
  przeszedl bez zmian). Realne granice tych akcji zawsze staly we wlasciwych im warstwach
  i stoja tam nadal: rejestr znanych adresow + zgoda usera (`web_search` / `web_read`, osobne
  klucze od K11), widocznosc adresata i limity skrzynki (`kom_send`), przeciecie zakresow
  rodzic∩dziecko (`intersectScopeFolders`) i glebokosc delegacji z runtime (`delegate`),
  obowiazkowa zgoda RED + opt-in serwera w `mcp_servers` (`external.call`).
- **Straznicy.** Nowy `core/security/non_vault_targets.test.ts` (4 testy, przed naprawa czerwone
  3 z 4): web/poczta/delegacja przechodza mimo whitelisty; whitelista NADAL odbija `B/x.md`
  i przepuszcza `A/x.md`; `scope.folders` suba tnie sciezki, ale nie zapytania; sam
  `checkAccess` oddaje `non-vault-target` z flaga, a bez flagi zostaje przy odmowie.
  Bez zmian w istniejacych testach — zaden nie utrwalal starego zachowania.

### fix(security): sanitizePath do punktu stalego, AccessGuard kanonizuje na wejsciu (K13, 2026-08-23)

Domkniecie znaleziska, ktore K12 tylko OPISAL i obszedl: `sanitizePath()` nie byla
idempotentna, choc caly kontrakt K1 ("bramka i zlew ogladaja JEDEN ciag") na tym stoi.
`trim()` dzialal raz na CALYM ciagu, a `decodeURIComponent` zdejmowal jedna warstwe
kodowania, wiec drugi przebieg potrafil oddac INNY tekst:

```
'./ A/B.md'        -> ' A/B.md'       -> 'A/B.md'
'x.md%20'          -> 'x.md '         -> 'x.md'
'a%252e%252e/x.md' -> 'a%2e%2e/x.md'  -> 'a../x.md'
'%252e%252e/x.md'  -> '%2e%2e/x.md'   -> null
```

- **Na czym polegal rozjazd.** K1 kanonizuje w DWOCH warstwach. Wolacz
  (`MCPClient._canonicalizeToolContext`) liczy `sanitizePath(raw)` i PODMIENIA te wartosc
  w argumentach narzedzia. Bramka (`PermissionSystem.checkPermission`) liczy kanonizacje
  DRUGI raz i wydaje werdykt o tym, co jej wyszlo. Przy nie-idempotentnej funkcji to sa dwa
  rozne teksty. Zmierzone na zywym lancuchu (agent `guidance_mode:false`, whitelista `A/`,
  narzedzie `write`, `path: './ A/B.md'`): w argumentach ladowalo `' A/B.md'` — plik w folderze
  ze spacja z przodu, czyli SASIEDNIM wobec `A` — a bramka wydawala zgode na `'A/B.md'`,
  bo whitelista `A/` je obejmuje.
- **Uczciwie o zasiegu.** Plik NIE wyladowal w sasiednim folderze: kazde wbudowane narzedzie
  vaultowe przepuszcza sciezke przez wlasny `validateVaultPath` (kolejny przebieg
  `sanitizePath`), wiec zlew dochodzil do tego samego punktu stalego co bramka i zapisal
  `A/B.md`. Realny skutek byl inny i tez niedobry: **user w oknie zgody widzial `' A/B.md'`,
  czyli sciezke w INNYM folderze niz ta, ktora bramka przepuscila i pod ktora zapisalo
  narzedzie** — a pod ta sama, nigdy nie wystepujaca forma zapadaly reguly "Zawsze zezwalaj",
  pamiec odmow i linie logu. Do tego kruchosc konstrukcyjna: kazdy zlew, ktory zaufa
  podmienionemu argumentowi BEZ wlasnego `sanitizePath` (nowe narzedzie, narzedzie zewnetrznego
  serwera), pisalby pod forma po jednym przebiegu, podczas gdy bramka orzekala o formie po
  dwoch. Bez odczytu danych chronionych i bez zapisu poza werdyktem bramki dla dzisiejszych
  narzedzi. Aktywne od K1 (2026-08-22).
- **Naprawa 1 — punkt staly.** Dawne cialo funkcji to dzis prywatna `sanitizeOnce()`, a publiczna
  `sanitizePath()` wola ja w petli, az wynik przestanie sie zmieniac (maks. 5 przebiegow —
  jeden przebieg zdejmuje jedna warstwe `%XX`; brak stabilizacji = `null`, fail-closed). Dzieki
  temu `sanitizePath(sanitizePath(x)) === sanitizePath(x)` Z KONSTRUKCJI i obie warstwy K1
  ogladaja ten sam ciag. Zmiana semantyczna: podwojnie zakodowane wejscie dekoduje sie DO KONCA
  albo odpada — `'%252e%252e/x'` daje dzis `null` (wczesniej przechodzilo przez bramke jako
  niewinnie wygladajacy plik `%2e%2e`), a `'a%252e%252e/x'` daje `'a../x'`, bo segment `a..`
  to legalna nazwa pliku, nie wyjscie w gore. Biale znaki z brzegow calego ciagu gina na dobre:
  `' A/B.md'` i `'./ A/B.md'` to ten sam `A/B.md` (spacja WEWNATRZ segmentu, `'A/ B.md'`,
  zostaje — to legalna nazwa).
- **Naprawa 2 — straznik prostuje cel sam.** `AccessGuard.checkAccess` kanonizuje `targetPath`
  jako pierwsza instrukcje (przed bariera `scope.folders` suba), a cel bez formy kanonicznej
  odbija sie jako `Invalid path`. W K12 bylo to niemozliwe wlasnie przez brak idempotencji;
  teraz trzecia warstwa nie ma prawa oddac innego ciagu. Zamyka to obejscie granicy
  `.pkm-assistant/`, ktora w strazniku stoi na golym `startsWith` (jedno wiodace `./`
  wystarczalo), dla KAZDEGO wolacza, ktory zapomni skanonizowac — i jest jedyna warstwa
  prostujaca cel dla akcji `artifact.*`, ktorych bramka nie kanonizuje.
- **Wyjatek, zeby nic nie zepsuc.** Nowa opcja `AccessCheckOptions.targetIsVaultPath`
  (domyslnie `true`, fail-closed). `PermissionSystem` podaje `false` dla pieciu akcji
  nie-vaultowych (`web.search`, `web.read`, `agent.message`, `delegate`, `external.call`),
  ktorych "cel" to zapytanie, adres albo adresat. Bez tego `sanitizePath` odrzucilby fraze
  zaczynajaca sie od `C:\...`, adres z dlugim query (segment > 255 znakow) albo zapytanie
  mieszajace alfabety — i agent stracilby wyszukiwarke. Zmierzone przed zmiana: 4 z 8
  typowych celow nie-vaultowych dawaly `null`.
- **Straznicy.** `core/security/keySanitizer.test.ts` — test K12 o NIE-idempotencji zastapiony
  testem idempotencji na tych samych kontrprzykladach, plus test wartosci po ustabilizowaniu
  i test wlasnosciowy na 3000 ciagach z DETERMINISTYCZNEGO generatora (LCG z ziarnem, starsze
  bity — na niskich bitach LCG chodzilby w kolko po 16 wartosciach i nie tknalby
  kontrprzykladow). `core/security/path_canonical.test.ts` — trzy nowe testy lancucha
  wolacz->bramka->zlew na prawdziwym `MCPClient` + `WriteTool` + `PermissionSystem` (wartosc
  podmieniona w argumentach, inwariant `sanitizePath(cel) === cel`, sciezka w oknie zgody
  i sciezka zapisana). `core/security/path_canonical_image.test.ts` — test "AccessGuard NIE
  kanonizuje sam z siebie" przepisany na "kanonizuje sam". Razem 1879 testow (bylo 1874),
  harness 34/34 GREEN (w tym `42_sciezka_kanoniczna`), `lint:obsidian` 90 bledow = baseline.

### fix(security): ogony po audycie — decyzje Kuby z 2026-08-23 (K12)

Cztery male, niezalezne paczki: jedno znalezisko z nocy audytowej 2026-08-23 (modul 20, code
review CTO) i trzy ogony po naprawach K4 / K6 / K8 / K9 z 2026-08-22, w tym dwie decyzje
wlasciciela, ktore COFAJA fragment poprzedniej naprawy.

- **Bramka kanonizuje sciezke takze dla akcji `image.*`** (noc 2026-08-23). K1 sprowadza sciezke
  do formy kanonicznej w dwoch warstwach — u wolacza (`MCPClient._canonicalizeToolContext`)
  i w bramce (`PermissionSystem.checkPermission`) — ale bramka robila to wylacznie dla
  `action.startsWith('vault.')`, a komentarz obok wymienial `image.*` jako akcje "niosaca prompt,
  nie sciezke". To bylo prawda WYLACZNIE przed K2: K2 (AUD-security-048/016) przestawil oba
  narzedzia obrazkowe na prawdziwe cele vaultowe — `generate_image` oddaje FOLDER ZAPISU,
  a `add_text_to_image` CEL ZAPISU (`output_path` albo WYLICZONE `<zrodlo>_text.<ext>`). Cel
  wyliczany nie jest doslownie wartoscia zadnego pola argumentow, wiec kanonizacja u wolacza go
  pomija — bramka byla dla niego jedyna warstwa i tej warstwy nie bylo. Skutek (zreprodukowany):
  `vault.write` + `./.pkm-assistant/x.png` → DENY, `image.generate` + ten sam ciag → ALLOW.
  Zapisu nie bylo (narzedzie ma wlasny `validateVaultPath`), zly byl werdykt bramki — i to on
  ladowal w oknie zgody. **`AccessGuard.checkAccess` SWIADOMIE nie dostal wlasnej kanonizacji:**
  pomiar pokazal, ze `sanitizePath` NIE jest w pelni idempotentna (`'x.md%20'` → `'x.md '` →
  `'x.md'`; `'a%252e%252e/x'` → `'a%2e%2e/x'` → `'a../x'`), wiec trzecia warstwa "poprawek"
  otworzylaby z powrotem rozjazd bramki ze zlewem, ktory zamknal K1. Klamliwy komentarz
  "funkcja jest idempotentna" poprawiony. Straznicy: `core/security/path_canonical_image.test.ts`
  (5 testow, w tym pelny lancuch MCPClient→PermissionSystem dla celu wyliczanego; pin z nocy
  zdjety) + kontrprzyklad idempotencji w `keySanitizer.test.ts`.
- **Jedno ogrodzenie pamieci zamiast dwoch + martwa metoda out** (ogony K4 i K9).
  `AgentManager.saveActiveSession()` nie miala ani jednego wolacza — czat zapisuje sesje wprost
  przez `memory.saveSession` — wiec zostala wycieta. `Agent.getSystemPrompt` i `getPromptSections`
  owijaly tresc pamieci we wlasne markery `=== PAMIEC DLUGOTERMINOWA (z brain.md) ===` /
  `=== KONIEC PAMIECI ===`. Od K9 sekcja `memory` i tak jedzie przez `fenceUntrusted` →
  `<vault_content source="memory">`, ktore ESCAPUJE tresc i nie da sie go zamknac od srodka —
  stare markery byly drugim, PODRABIALNYM plotem wewnatrz prawdziwego, dokladnie tym ksztaltem,
  ktorym ladunek z AUD-035 udawal koniec sekcji. Naglowek `## Dlugoterminowa pamiec` zostaje
  (etykieta, nie granica). Klucze i18n `agent.memory_start`/`agent.memory_end` skasowane (pl+en).
  Straznik: `modules/agents/Agent.test.ts` — asercja KSZTALTOWA (linia `---`/`===`/`═══`
  wewnatrz ogrodzenia), nie tekstowa: pierwsza, tekstowa wersja przechodzila ze starym plotem,
  bo testy biegna po angielsku.
- **Sufit poczty per NADAWCA, obok limitu per para** (ogon K6). `kom_send` mial rate-limit
  liczony PER PARA nadawca→adresat (`kom_send_rate_max`, default 20 / 10 min), wiec zepsuty agent
  rozsylal 20 × liczba adresatow, miesczac sie w kazdej parze z osobna. Doszedl DRUGI sufit na to
  samo okno: `kom_send_rate_max_sender` (default 40, min 1, sufit 2000, edytowalny w Ustawieniach
  → Limity). `KomunikatorManager` trzyma drugi licznik z ta sama normalizacja klucza ("Tola"
  i "tola" to jeden nadawca); `reserveSend`/`noteSend` dopisuja do OBU map, `releaseSend` oddaje
  slot w OBU (blad dysku nie zjada sufitu). Odmowa niesie `reason: 'pair' | 'sender'`, a komunikat
  dla modelu jest inny w kazdym przypadku — sufit nadawcy swiadomie NIE radzi "napisz do kogos
  innego", bo to byloby zaproszenie do obejscia. **User piszacy z panelu komunikatora nadal bez
  limitu** (jego droga w ogole nie wola `reserveSend`). Straznicy: 6 testow w
  `KomunikatorManager.test.ts` + 1 w `KomunikatorTools.test.ts` + 1 w `config/limits.test.ts`;
  scenariusz harnessa `12_poczta_petla` bez zmian, dalej GREEN.
- **Sesje agentow WRACAJA do gita, sekrety maskowane przy zapisie** (decyzja Kuby, cofa fragment
  K8). K8 (AUD-security-029) dopisal `.pkm-assistant/agents/*/memory/sessions/` do wpisow, ktore
  plugin doklada do `.gitignore` vaulta — bo transkrypt potrafi niesc sekret wpleciony w tresc
  bledu (padniety strumien wypisuje naglowki zadania). Skutek uboczny okazal sie wiekszy niz
  ryzyko: pliki sesji to pamiec agentow wozona miedzy urzadzeniami (laptop ↔ chmura ↔ telefon,
  przez repo vaulta) i przestaly podrozowac. Wpis zdjety z `VAULT_GITIGNORE_ENTRIES`, a ryzyko
  zdjete U ZRODLA: nowy prywatny `AgentMemory._writeSessionFile(path, content)` jest JEDYNYM
  pisarzem plikow sesji i przepuszcza kazdy bajt przez `maskSensitiveData` — przepiete wszystkie
  szesc zapisow (start aktywnej, dopisek do event-logu, `saveSession`, archiwizacja, odlozenie do
  `.discarded/`, migracja plaskiego `sessions/`). Maskujemy WYLACZNIE string idacy na dysk:
  obiekty wiadomosci w pamieci zostaja nietkniete, bo maska ma zmieniac ZAPIS rozmowy, a nie jej
  przebieg. Zakres swiadomie waski — `brain*`, `summaries/L*` i `.state.json` maja wlasnych
  pisarzy. `PROTECTED_PATHS` NIETKNIETE: sesje dalej sa poza zasiegiem narzedzi agenta (osobna os:
  "czy narzedzie moze to otworzyc" ≠ "czy to wolno wersjonowac").
  ⚠️ **Plugin NIE usuwa wpisu `.gitignore`, ktory juz dopisal.** Kto chce, zeby sesje wrocily do
  gita, kasuje linie `.pkm-assistant/agents/*/memory/sessions/` recznie.
  Straznicy: 4 testy w `AgentMemory.test.ts` + przepisany test listy w `keySanitizer.test.ts`.

### perf(core): start pluginu 8 s -> ~0,2 s — odziedziczone okna czekania wyciete (2026-08-23)

Plugin wstawal **8,09 s**, z czego realna robota bylo **~90 ms**. Reszta to dwa szeregowe,
slepe zegary odziedziczone po starym frameworku bazowym — zadnego z nich nie dalo sie niczym
uzasadnic w tym kodzie. Zmierzone dry-bootem harnessa (audyt nocny 2026-08-22, karta
wydajnosc): 5000 ms + 3000 ms + ~90 ms.

**Pomiary (dry-boot harnessa, `npm run harness`, trzy biegi):**

| | przed | po |
|---|---|---|
| harness (override `env_start_wait_time` = 50 ms) | 3,22 / 3,20 / 3,21 s | **0,15 / 0,15 / 0,15 s** |
| produkcja (bez override'u) | 8,09 s | **~0,2 s** |

- **`env_start_wait_time`: fallback 5000 -> 0.** `PKMEnv.create()` planuje `load()` przez
  `setTimeout(…, env_start_wait_time)`. Piec sekund to byl **debounce starego frameworka**: tam
  KILKA siostrzanych pluginow rejestrowalo sie w JEDNYM globalnym rejestrze srodowiska, wiec start
  czekal, az wszystkie zdaza sie zglosic. U nas `PKM_SCOPE` jest modulowy, a
  `PKMEnv.create()` ma **jednego wolacza** (`src/main.ts`) — nie bylo na kogo czekac, i nikt
  w produkcji tej wartosci nie ustawial (brak klucza w `config/default_env_config.ts`, brak UI).
  Getter i nadpisanie z configu **zostaja** (korzystaja z nich harness i testy), a `setTimeout(…, 0)`
  dalej pelni role debounce'u: powtorne `create()` w tej samej turze zbija sie do jednego `load()`.
- **Slepy sen 3000 ms w `ready_to_load_collections()` — wyciety.** Byl przepisany zywcem
  ze starej warstwy srodowiska („poczekaj 3 sekundy, az inne procesy skoncza") i **niczego nie
  sprawdzal**: prawdziwy warunek stoi linijke nizej (`wait_for_obsidian_sync()`, petla po
  `obsidian_is_syncing`, u usera bez Obsidian Sync wraca natychmiast), caly realny I/O startu
  (`fs.load_files()`, `settings.json`) konczyl sie PRZED tym oknem, a `load_collections()`
  jest dzis no-opem, bo zadna kolekcja nie ma `process_load_queue`. Zostaje samo czekanie na Sync.
- **Zamiast zegara — ZDARZENIE.** `load()` wola teraz `await this.wait_for_layout_ready()` jako
  pierwsza instrukcje po galezi mobile-defer. Metoda opiera sie o `workspace.onLayoutReady`:
  Obsidian wola callback natychmiast, gdy layout juz stoi, a w przeciwnym razie dokladnie wtedy,
  gdy stanie. Plugin czeka wiec tyle, ile trzeba, i ani milisekundy dluzej. Sama logika mieszka
  w nowym **`core/layoutReady.ts`** (czysta `waitForLayoutReady(workspace?)`, zero importow),
  bo `PKMEnv.ts` importuje `obsidian` i nie wstaje w AVA. Poza Obsidianem (harness, testy,
  dry-boot w Node) funkcja rozwiazuje sie od razu — bez tej galezi boot by zawisl.
- **Straznik:** `core/PKMEnv.boot_timing.test.ts` przepisany z pinu znaleziska na nowy kontrakt
  (7 testow). Cztery czytaja **zrodlo** `PKMEnv.ts` regexami: brak `setTimeout` z literalem
  liczbowym w `ready_to_load_collections`, fallback `env_start_wait_time` = 0 przy zywej drodze
  przez config, kolejnosc `ready_to_load_collections` -> `load_collections`, oraz
  `await wait_for_layout_ready()` przed `state = 'loading'`. Trzy testuja **naprawde**
  `waitForLayoutReady` (brak workspace / callback synchroniczny / callback po 20 ms).
- **Gotcha na przyszlosc** (opisana w `core/CLAUDE.md`): gdy ktos dolozy kolekcje
  z `process_load_queue`, ktora potrzebuje gotowego indeksu Obsidiana — ta kolekcja ma zadbac
  o **wlasne** zdarzenie (np. `metadataCache.on('resolved')`), a nie przywracac tu zegar.

Nietkniete swiadomie: galaz mobile-defer, `wait_for_obsidian_sync()`, `load_collections()`,
interwal 100 ms w `wait_for()` oraz override 50 ms w `harness/lib/boot.ts` (zmierzony: kosztuje
~5 ms, bo ginie w ziarnie tego samego pollingu — a dowodzi, ze droga przez config nadal zyje).

### fix(security): reszta po audycie — przecięcie przy delegacji, zgoda web_read, autostart MCP (K11, 2026-08-22)

Ostatnia paczka po audycie 2026-08-22. Znaleziska: **AUD-security-008, 072, 020, 069, 005, 047,
051** (naprawione), **AUD-security-028** (zweryfikowane jako zamknięte przez K8) oraz
**AUD-security-077 / 080 / 090** (uwagi twardnieniowe).

- **Dziecko delegacji NIGDY szerzej niż sub, który je zleca** (AUD-security-008 + 072, MEDIUM).
  `delegate` liczył zakres folderów wyłącznie z configu ODPALANEGO suba, a whitelistę narzędzi
  względem agenta GŁÓWNEGO. Skutek przy `max_delegation_depth ≥ 2`: sub ze `scope.folders:
  ['Publiczne']` i `tools: [read, delegate]` wystawiał wnukowi pełny vault (generyczny worker nie
  ma pola `scope` → zakres `null` → uprawnienia rodzica) i pełny zestaw 23 narzędzi agenta
  (`aspect: "worker"` bierze „klasę rodzica" z `filterByAgent(activeAgent)`). `MCPClient`
  wstrzykuje teraz do argumentów dwa zaufane znaczniki — `_invocationScopeFolders`
  i `_invocationToolNames` (ten sam wzorzec co `_invocationDelegationDepth`/`_invocationAutonomy`:
  wartość od runtime'u, poza delegacją pole USUWANE) — a `delegate` robi z nich **przecięcie**
  z configiem dziecka. Reguła przecięcia zakresów mieszka w `AccessGuard.intersectScopeFolders`
  (zostaje węższy wpis, liczone tym samym `_matchesEntry` co bramka ścieżek); **zakresy rozłączne
  = odmowa delegacji** (`mcp.delegate.scope_disjoint`, fail-closed). `SubAgentRunner._getTools`
  dostał trzeci składnik przecięcia (whitelista wołającego), a `buildBuiltinWorkerConfig` przy
  zleceniu z piętra ≥1 bierze listę suba, nie agenta.
- **`action` nie obniża już ryzyka `write`** (AUD-security-020, MEDIUM). Klasyfikator czytał
  `args.mode || args.action`, a `WriteTool` — `args.mode || 'replace'`. `write {path, content,
  action:'create'}` bez pola `mode` wychodziło więc YELLOW (wyciszane żółtym przełącznikiem
  `vault_write`), a narzędzie NADPISYWAŁO istniejący plik — czyli operację, którą tryb `edge`
  deklaruje jako RED nie do wyłączenia przełącznikiem. Znikał też podgląd diffa (wisi na tej
  samej fladze). Dla `write`/`vault_write` ryzyko liczy się teraz **wyłącznie z `mode`**, czyli
  z pola, z którego narzędzie wyprowadza skutek. **Świadomie NIE normalizujemy `action`→`mode`**
  (druga opcja z raportu): to zmieniłoby ZACHOWANIE `WriteTool` (dziś `action` jest po prostu
  ignorowane), a naprawa ma dotyczyć klasyfikacji. Fallback na `action` zostaje narzędziom,
  które go realnie używają (`todo`, `artifact_*`, `kom_*`).
- **`web_read` ma własną bramkę zgody** (AUD-security-069, MEDIUM). Dzielił z `web_search` typ
  akcji, przełącznik w profilu i opis w modalu, więc jedno odklikanie „Wyszukiwanie w internecie"
  zdejmowało pytanie także z jedynego narzędzia, które wyprowadza na sieć adres wybrany przez
  model — a modal, gdy się pokazywał, ogłaszał to jako wyszukiwanie. Nowy typ akcji `web.read`
  (`MCPClient.ACTION_TYPE_MAP` + `ACTION_PERMISSIONS`), własny klucz `web_read`
  w `APPROVAL_DEFAULTS` (**domyślnie PYTAJ**) i w `_getApprovalToggleKey`, własny wiersz
  w profilu → Uprawnienia, własny opis + etykieta + waga `warning` w `ApprovalModal`
  (`approval.desc.web_read` / `approval.type.web_read`, pl+en). **Zgodność wstecz jest
  bezpieczna:** istniejące ustawienie usera dla `web_search` NIE dotyczy `web_read` (osobny
  klucz → default „pytaj"), a trwała reguła „Zawsze zezwalaj" zapada osobno (`web.read::<url>`).
  Bramka proweniencji adresu (`isUrlKnown`) bez zmian.
- **Autostart zewnętrznych serwerów MCP nie bramkuje startu pluginu** (AUD-security-005, MEDIUM).
  `ExternalMcpManager.autostart()` łączyła serwery po kolei (`await` w pętli), a `main.ts` czekał
  na nią przed ustawieniem `plugin._ready` — czyli jeden serwer, który przyjmuje transport
  i milczy, trzymał czat i sidebar na spinnerze przez cały swój budżet (a trzy takie serwery
  sumowały budżety). Teraz: łączenie **równoległe**, `autostart()` wraca od razu, `main.ts`
  woła ją przez `void` (wzór `vaultIndexer.initialize()`), a na rozstrzygnięcie prób czeka
  `whenAutostartSettled()` (testy/harness). Do tego `connect` ma **jeden budżet** na handshake
  + `listTools` (wspólny `deadline`), a nie dwa pełne okna — SECURITY.md obiecuje wprost, że
  zawieszony serwer nie zawiesza pluginu. Serwery dołączają, kiedy wstaną; do tego czasu ich
  narzędzi po prostu nie ma w rejestrze (fail-closed).
- **Agent-duch nie trafia do promptu** (AUD-security-047, LOW). Lista agentów wstrzykiwana do
  bloku `komunikacja` szła z `getAllAgents()`, więc agent z `komunikator_visible: false`
  pokazywał każdemu agentowi z pocztą swoją nazwę I OPIS — mimo że `kom_send` do niego odbija
  się jak od literówki. `AgentManager._buildBaseContext` używa teraz `listKomunikatorAgents()`,
  czyli tego samego filtra, którym chodzi poczta.
- **Modal `memory_save` pokazuje nazwę pliku, która realnie powstanie** (AUD-security-051, INFO).
  `MCPClient._extractToolContext` miał własną, uproszczoną normalizację nazwy, a `MemorySaveTool`
  liczył ją przez `makeMemoryNoteFilename` (NFKD + zdjęcie diakrytyków + cięcie do 80 znaków).
  Dla polskich nazw user zatwierdzał inny plik, niż powstawał. Druga kopia reguły skasowana.
- **AUD-security-028 (INFO) — ZAMKNIĘTE WCZEŚNIEJ przez K8, bez nowej implementacji.** Znalezisko
  mówiło, że ogólne wzorce `api_key`/`password` nie łapią JSON-a (`"api_key":"…"` — cudzysłów
  między nazwą a dwukropkiem), czyli są martwe tam, gdzie Logger serializuje obiekty. K8 dołożył
  **drugi, niezależny filtr — po NAZWIE pola** (`QUOTED_FIELD_RE` + `BARE_FIELD_RE`), który tę
  wartość maskuje niezależnie od kształtu. Dopisane tylko testy potwierdzające
  (`SensitiveDataGuard.test.ts`): JSON z `api_key`/`password`/`apiKey`/`x-api-key`/`Authorization`
  maskowany, `monkey`/`max_tokens` nietknięte.
- **Twardnienie AUD-security-080** — `Agent.update()` normalizuje `admin_access` tym samym
  `normalizeAdminAccess`, co konstruktor (dotąd szło przez `this[key] = value`, więc po
  `update()` pole mogło trzymać wartość nie-boolowską). Luki nie było — każdy konsument
  porównuje ściśle `=== true` — ale dwa kształty jednego pola to mina pod pierwszy nie-ścisły
  odczyt.
- **Twardnienie AUD-security-090** — nowa pure `sanitizeSvgColor` (`modules/crystal-soul`,
  w barrelu): kolor z profilu agenta wchodzi do markupu SVG tylko jako `#rgb`/`#rrggbb`/
  `#rrggbbaa`, `rgb()`/`rgba()`/`hsl()`/`hsla()`, `var(--x)` albo nazwa CSS; cokolwiek innego →
  `currentColor`. Bramka stoi w `CrystalGenerator.generate` **i** `generateInner` (bywa wołane
  wprost). Do tego `SvgHelper._scrub` wycina teraz wszystkie elementy ściągające cudze zasoby
  (`image`, `use`, `iframe`, `object`, `embed`, SMIL `animate*`/`set` — obok `script`
  i `foreignObject`) i zdejmuje KAŻDY zdalny `href`/`xlink:href`/`src`, zostawiając lokalne
  `#id` (filtry glow działają dalej). Źródło `color` jest dziś zamknięte (`.pkm-assistant/**`
  fail-closed dla narzędzi bez `admin_access`, UI zapisuje hex z palety), więc to twardnienie,
  nie łata dziury.
- 🚦 **AUD-security-077 — DO DECYZJI KUBY, kod NIETKNIĘTY.** Migracja polityki dostępu podnosi
  `guidance_mode` na `true` profilom BEZ pola `access_policy_version` — także wtedy, gdy autor
  wpisał `guidance_mode: false` jawnie — i zapisuje to na dysk. To **udokumentowana, zamierzona
  migracja v1→v2** (`core/SECURITY.md`, `modules/agents/CLAUDE.md`), więc zmiana warunku na
  „migruj tylko, gdy pole nie jest ustawione jawnie" jest decyzją produktową, nie łatką.
  Naprawiony został sam **rozjazd dokumentów**: root `SECURITY.md` podawał regułę „`false` +
  puste `focus_folders` = zero dostępu" bez zastrzeżenia o wersji polityki — teraz mówi wprost,
  że profil pisany ręcznie musi nieść `access_policy_version: 2`.
- **Strażnicy (wszystkie najpierw CZERWONE):** `modules/tools/DelegateTool.test.ts` (5 —
  dziedziczenie zakresu, przecięcie, rozłączność, whitelista wnuka, brak regresji na piętrze 0),
  `modules/sub-agents/SubAgentRunner.test.ts` (2 — trzeci składnik `_getTools`, przelot
  `callerToolNames`), `core/security/sub_scope_guard.test.ts` (6 — `intersectScopeFolders`),
  `modules/tools/MCPClient.test.ts` (6 — znaczniki, `action:create` = RED, dwa przełączniki web,
  nazwa notatki), `modules/tools/ExternalMcpManager.test.ts` (3 — natychmiastowy powrót,
  równoległość, jeden budżet), `core/security/SensitiveDataGuard.test.ts` (2 — JSON),
  `modules/agents/Agent.test.ts` (1 — `admin_access`), nowy `modules/crystal-soul/svgSafety.test.ts`
  (5 — kolor + `_scrub`) oraz asercja w scenariuszu harnessa `12_poczta_petla` (duch w prompcie
  systemowym, zweryfikowana jako RED bez naprawy).

### fix(security): jeden walidator tresci artefaktu, blok zwiazany ze swoja notatka (K10, 2026-08-22)

Naprawa trzech znalezisk z audytu bezpieczenstwa: **AUD-security-061, AUD-security-063,
AUD-security-089**.

- **`pola` w `artifact_create` przechodza przez TEN SAM walidator co patch** (AUD-security-061,
  HIGH). Wartosci pol podane przez model sa podstawiane do CIALA notatki przez `{{pole}}`
  w szablonie typu, wiec byly druga, niepilnowana droga zapisu tresci: `pola:{cel:"```dataviewjs
  …```"}` ladowalo verbatim w widocznym folderze vaulta, a narzedzie raportowalo `ok:true`,
  `errors: []`. Ten sam ladunek przez `sekcje`/`set_section` byl odrzucany kodem `code_forbidden`.
  Teraz obie drogi wchodza przez jeden predykat `validateArtifactBodyText` (`artifactParser.ts`),
  a wejsciem pol jest jedna metoda `ArtifactStore.applyFieldsValidated`. Odmowa jest **fail-closed**:
  zaden plik nie powstaje, a model dostaje ten sam kod bledu co przy patchu (`created: false`
  w wyniku silnika → `isError` + `errors` w narzedziu). Szablon typu i wartosci domyslne pol
  pozostaja trescia USERA i nie sa sprawdzane (A3).
- **Blok `pkm-artefakt` dziala wylacznie w SWOJEJ notatce** (AUD-security-063, MEDIUM). Procesor
  jest zarejestrowany globalnie i bral `id` z tresci bloku, wiec blok podlozony w dowolnej notatce
  rysowal dzialajace guziki cudzego artefaktu: user widzial „✅ Zatwierdz" w kontekscie swojej
  notatki, a klik przestawial status cudzego planu i przywolywal jego agenta. Handler przyjmuje
  teraz trzeci parametr (`ctx`) i porownuje `ctx.sourcePath` ze sciezka artefaktu z jednego zrodla
  prawdy (`ArtifactStore.pathById` — to samo, ktorego uzywa bramka uprawnien), po sciezce
  KANONICZNEJ. Blok bez zwiazku renderuje sie martwy z komunikatem i18n
  (`artifact.block.foreign`) — i to PRZED odczytem artefaktu, wiec nie wycieka nawet status.
  Fail-closed: brak `sourcePath`, brak store'a albo nieznane id = blok nieaktywny.
- **`code_forbidden` liczy wszystkie nosniki kodu, nie sam grawis** (AUD-security-089, LOW).
  Do bramki doszedl fence tyldowy (`~~~`) oraz surowy HTML (`<pre>`, `<code>`, `<script>`,
  `<iframe>`, `<object>`, `<embed>`) — wczesniej `~~~dataviewjs` przechodzil. Detektor guzikow
  w `parseArtifact` liczy te same fence'y, wiec chudy JSON nie raportuje juz `buttons: false`
  dla pliku, w ktorym blok jest. **Swiadome odstepstwo od kierunku z raportu:** NIE liczymy
  wcietego bloku kodu (4 spacje / tab) — w tresci artefaktu tak wyglada zagniezdzony punkt listy,
  wiec bramka odrzucalaby normalna prace modelu, a wciecie bez fence'a nie odpala procesorow
  blokow Obsidiana.
- **Straznicy:** 6 nowych testow w `modules/artifacts/artifactParser.test.ts` (tylda w
  `set_section`/`add_item`, HTML, brak falszywek na `~~` i wcieciu, detektor guzikow), 6 w
  `modules/tools/built-in-servers/artifacts/artifactTools.test.ts` (4 ladunki w `pola` → odmowa
  i ZERO plikow, rownowaznosc kodu bledu z `sekcje`, czyste pola dalej tworza artefakt) i nowy
  plik `modules/artifacts/artifactBlocks.test.ts` (7 testow: `isBlockBoundToNote` wlasna/cudza/
  nieznana/kanoniczna sciezka + render bloku z cudzym id = zero guzikow i zero wywolan store).

### fix(security): Stop zatrzaskuje przerwanie tury (K5, 2026-08-22)

Naprawa trzech znalezisk z audytu bezpieczenstwa: **AUD-security-037, AUD-security-038,
AUD-security-068**.

Wspolny mianownik: przerwanie tury bylo stanem WIDOKU (jedno pole `ChatView._abortedStream`
z nazwa agenta + pole `is_generating`), a nie stanem TURY. Skutek: zatrzymana petla wracala
do zycia, a przy zamknieciu panelu nikt jej nie zatrzymywal.

- **Przerwanie zamieszkalo w turze** (AUD-security-037). Nowy `modules/chat/chat/turnAbort.ts`:
  kazda tura dostaje wlasny uchwyt (`createTurnAbort()`, zatrzask — raz podniesiona flaga nie
  gasnie), petla pyta `shouldAbort: () => turn.abort.isAborted()`. Zniklo zerowanie
  `_abortedStream = null` na wejsciu `send_message` — to ono gasilo przerwanie tury, ktora
  WCIAZ biegla w dlugim narzedziu (a robila to takze auto-tura z wynikiem suba i drain przy
  przelaczeniu zakladki, czyli bez udzialu usera). Bezpiecznik „po Stopie nie drenujemy
  zaleglych wynikow subow" zostal jako osobne, jawne pole `_drainSuppressed`.
- **Stop dziala takze w oknie PRZYGOTOWANIA tury** (przy okazji 037). Uchwyt przerwania powstaje
  razem z zapaleniem guzika (`set_generating(true)`), a nie dopiero przy rejestracji tury
  w `_streamCtxMap` — miedzy jednym a drugim buduje sie prompt z pamiecia (sekundy). Na ten czas
  uchwyt lezy w `_preparingTurns` i stamtad bierze go `stop_generation`.
- **Guzik Stop trafia w kontekst tury** (przy okazji 037). `stop_button` byl wpiety przez
  `this.stop_generation.bind(this)`, wiec jako `agentName` dostawal **MouseEvent** — mapa tur
  jest kluczowana nazwa agenta, wiec Stop nie znajdowal ani watchdoga, ani wlasciwej instancji
  modelu i konczyl sie na ubiciu XHR wspolnej instancji. Ten sam blad naprawiono dla guzika
  Wyslij w K7. Teraz `() => this.stop_generation()` + pas zapasowy w samej funkcji
  (argument nie-string = „tura aktywnego agenta").
- **Backstop petli pod bramka abortu** (AUD-security-038). `runAgentLoop` pytal `shouldAbort()`
  na starcie iteracji i po powrocie modelu, ale NIE przed backstopem — Stop kliknięty w trakcie
  narzedzi OSTATNIEJ iteracji przepuszczal jeszcze jedno pelne wywolanie modelu, a tura schodzila
  jako `backstop`, czyli z finalizacja (wpis w oknie kontekstu i w dzienniku sesji). Bramka stoi
  teraz PRZED dopiskiem hardstopu do transkryptu.
- **Zamkniecie panelu zatrzymuje kazda ture, takze z zakladki w tle** (AUD-security-068).
  `onClose` warunkowal zatrzymanie polem `is_generating`, ktore przelaczenie zakladek nadpisuje
  stanem zakladki DOCELOWEJ — a linia wyzej rozbrajala watchdogi WSZYSTKICH tur, czyli ostatniego
  straznika. Nowy `stop_all_turns(reason)` idzie po WLASCICIELACH tur z `_streamCtxMap` (wzor K4),
  woła dla kazdej to samo `stop_generation` co guzik, kasuje zakolejkowana wiadomosc i prosi
  `subTaskRegistry.requestStop` o zatrzymanie subow zleconych z zakladek tego widoku (dopasowanie
  po `origin.tabKey` / `origin.agentName`, biegi spoza czatu nietkniete). Watchdogi rozbrajamy
  DOPIERO po zatrzymaniu tur.

Straznicy: `modules/chat/chat/turnAbort.test.ts` (8 testow — zatrzask, „nowa tura nie odkreca
starej", zbieranie tur i subow), dwa nowe testy w `modules/agent-loop/AgentLoop.abort.test.ts`
(backstop pod abortem + brak narzedzi kolejnej iteracji po Stopie) oraz scenariusz harnessa
`44_stop_zatrzask` (Stop w trakcie narzedzia ostatniej iteracji: zero kolejnych wywolan modelu,
zero narzedzi, `stop=abort` w trace). Harness dostal przelot `shouldAbort` do
`runExploratoryTurn`, zeby scenariusz mial czym odegrac klikniecie.

### fix(security): poczta agentow trzyma bramki takze pod rownoleglosc (K6, 2026-08-22)

Naprawa pieciu znalezisk z audytu bezpieczenstwa: **AUD-security-011, AUD-security-046,
AUD-security-044, AUD-security-006, AUD-security-013**.

Wspolny mianownik: wszystkie bramki poczty byly „sprawdz, potem zapisz" z `await` w srodku,
a JEDNA odpowiedz modelu leci przez `Promise.all` (`AgentLoop`). Dziesiec rownoleglych
`kom_send` widzialo licznik na zerze, te sama wolna nazwe pliku i nieaktualny licznik odbic.

- **Rate-limit przestal przegrywac wyscig** (AUD-security-011). Nowe `KomunikatorManager.
  reserveSend(from, to, limit)` — sprawdzenie i inkrement w JEDNYM kroku synchronicznym, bez
  `await` w srodku, wiec Node nie ma gdzie wpuscic kolegi. Licznik rosnie PRZED zapisem pliku
  (rezerwacja); nieudany zapis oddaje slot przez `releaseSend`. Sufit wsadu w jednej turze =
  ten sam `kom_send_rate_max` z `config/limits.ts`. Stare `checkSendAllowed` + `noteSend`
  zostaja jako podglad i zapis dla UI/testow.
- **CREATE-ONLY skrzynki naprawdę trzyma** (AUD-security-044). Dobor nazwy pliku i zapis ida
  pod jednym lancuchem `withLock('inbox:<dir>')`, plus asercja `exists` tuz przed `write`.
  Wczesniej dwie wysylki w tej samej milisekundzie dostawaly to samo id i druga KASOWALA tresc
  pierwszej — takze gdy nadawcy byli rozni — a obie melowaly `success: true`.
- **Licznik odbic czyta stan Z CHWILI WYSYLKI** (AUD-security-046). Nowe `resolveHopFor(agent)`
  bierze MAKSIMUM z rejestru w pamieci i ze SWIEZEGO odczytu wlasnej skrzynki z dysku (listy
  odhaczone `ai_read`, doreczone w oknie `KOM_HOP_TTL_MS`). `kom_read` i `kom_send` jednego
  agenta chodza po tym samym lancuchu `withAgentLock`, wiec „sprawdz poczte i odpisz" w jednej
  turze nie wyzeruje juz lancucha. Brak danych (zla nazwa agenta, padniety odczyt) = fail-closed,
  czyli odmowa.
- **`agent_delegate` przestal byc druga droga do skrzynki** (AUD-security-006). Delegacja wolala
  `KomunikatorManager.sendMessage` wprost, omijajac komplet bramek. Teraz obie drogi wchodza przez
  JEDNA funkcje `sendAgentMail` (`modules/tools/KomunikatorTools.ts`) — ten sam filtr ducha,
  ten sam rate-limit, ten sam licznik odbic. Odmowa bramki NIE wywraca samej propozycji delegacji
  (kontekst niesie `context_summary` w wyniku — zachowanie z S28 D6).
- **Filtr duchow dziala w obie strony takze w delegacji** (AUD-security-013). Agent
  z `komunikator_visible:false` nie przemyci juz listu przez `agent_delegate` (jego nazwa
  ladowala adresatowi we frontmatterze `od:` i w pingu sesji), a blad „nie znaleziono" wylicza
  agentow z `listKomunikatorAgents()` zamiast `getAllAgents()` — duch nie wycieka jako pozycja
  na liscie dostepnych.
- **Straznicy:** 7 nowych testow w `modules/tools/KomunikatorTools.test.ts` (10x `Promise.all`
  przy limicie 5 → dokladnie 5 zapisow; wsad na stojacym zegarze → 6 roznych nazw plikow; dwaj
  rozni nadawcy → 10 plikow; `kom_read`+`kom_send` w jednej turze → hop+1 oraz odmowa na
  HOP_LIMIT; duch jako nadawca; `kom_read` nie przepisuje tresci) i 4 w
  `modules/tools/AgentDelegateTool.test.ts` (limit sekwencyjnie i przez `Promise.all`, duch jako
  nadawca, brak duchow w bledzie). Atrapa delegacji dostala PRAWDZIWY `KomunikatorManager`
  zamiast obiektu z jedna metoda.

### fix(security): jedno ogrodzenie niezaufanej tresci w prompcie (K9, 2026-08-22)

Naprawa czterech znalezisk z audytu bezpieczenstwa: **AUD-security-002, AUD-security-030,
AUD-security-035, AUD-security-060**.

- **Jedna funkcja ogradzajaca** (`core/security/promptFence.ts`, w barrelu `core/index.ts`):
  `fenceUntrusted(content, source)` zwraca blok `<vault_content source="…">…</vault_content>`
  z **trescia zescapowana** — `<vault_content` i `</vault_content` z wnetrza zamieniaja sie na
  `&lt;…`, wiec ogrodzenia NIE da sie zamknac od srodka. Wczesniej znacznik byl sklejany
  stringiem bez escapowania (AUD-security-030): wpis pamieci zaczynajacy sie od
  `</vault_content>` konczyl ogrodzenie, a reszta ladunku stala w prompcie systemowym jako
  zwykly, nieoznaczony tekst — TRWALE, bo siedziala w `brain.md` i wracala w kazdej sesji.
- **Oczko wchodzi przez to samo ogrodzenie** (AUD-security-002). `buildActiveNoteContext`
  (`modules/multimodal/active_note.ts`) oddaje `text` ZAWSZE opakowany w
  `<vault_content source="active_note">`. Do tej pory nazwa pliku, frontmatter i do 2000 znakow
  body aktywnej notatki byly doklejane goloslownie na koniec promptu systemowego — naglowek `## …`
  z notatki byl naglowkiem promptu.
- **Indeks artefaktow to DANE, nie reguly** (AUD-security-060). `status`/`typ`/`id`/`tytul` z
  frontmattera **zwyklych notatek vaulta** interpolowaly sie do bloku `decision_tree`, czyli do
  sekcji „JAK PRACUJE" — obok prawdziwych regul. Teraz indeks typow + lista artefaktow w toku +
  aktywny artefakt renderuja sie jako osobna sekcja bloku D (`artifacts`) przez
  `addDynamicSection`, czyli w ogrodzeniu. Bramka bez zmian (`artifact_create`). Skutek uboczny
  na plus: `decision_tree` przestal niesc dane zmienne, wiec stabilny prefiks cache promptow
  jest dluzszy. **Rozroznienie zrodel zostaje:** `agent_rules` z yamla agenta w
  `.pkm-assistant/agents/` to nadal REGULY (pisze je operator, `.pkm-assistant` jest poza
  zasiegiem narzedzi) — ogrodzenie dotyczy tresci z plikow vaulta.
- **Opis notatki `brain/` sklejony do jednej linii** (AUD-security-035). `description` wraca z
  frontmattera przez `JSON.parse` z PRAWDZIWYMI znakami nowej linii; `getMemoryContext` wstawial
  go do indeksu niesklejonego, wiec ladunek typu `\n=== KONIEC PAMIECI ===\n\n## INSTRUKCJE`
  otwieral w prompcie wlasny naglowek. Teraz kazdy opis przechodzi przez `oneLineDescription`
  (ten sam, ktorego uzywa juz `BrainIndex.formatIndexLine`): biale znaki → spacja, przyciecie do
  220 znakow.
- **Model wie, co znaczy ogrodzenie.** Sekcja „Bezpieczenstwo tresci" (`prompt.content_security`,
  pl+en) mowi teraz wprost, ze wszystko miedzy `<vault_content source="…">` a `</vault_content>`
  to dane — nawet gdy wyglada na naglowek albo polecenie systemowe — i ze znacznik w srodku bloku
  jest czescia cudzej tresci. Preambula stoi w JEDNYM miejscu, nie przy kazdym bloku.
- **Straznicy:** 6 testow w `core/security/promptFence.test.ts` (jedno otwarcie/jedno zamkniecie,
  warianty z bialymi znakami i wielkoscia liter, idempotencja), 4 w
  `modules/prompts/PromptBuilder.fence.test.ts` (pamiec i artefakt zamykajace ogrodzenie, indeks
  artefaktow poza sekcja regul, brak pustych blokow), 3 w `modules/multimodal/active_note.test.ts`
  (Oczko: md, zatruta notatka, plik nie-markdown) i 1 w `modules/memory/AgentMemory.test.ts`
  (`description` z nowymi liniami nie tworzy sekcji promptu).

### fix(security): bieg w tle czyta stan TURY, ktora go zlecila, nie globalnych luster (K4, 2026-08-22)

Naprawa szesciu znalezisk z audytu bezpieczenstwa: **AUD-security-064, AUD-security-065,
AUD-security-091, AUD-security-066, AUD-security-050, AUD-security-036**.

Wspolna przyczyna: delegacja z glownego czatu jest od rundy 3 ZAWSZE w tle, a kompresja konca
tury leci takze dla zakladki, ktorej user juz nie oglada. Oba te biegi rozstrzygaly „czyje to
jest" po globalnych lustrach pluginu (`agentManager.activeAgent`, `getActiveMemory()`,
`plugin.currentAutonomy`), czyli po tym, kto byl aktywny W CHWILI ZAPISU. Jedno klikniecie
w druga zakladke w trakcie tury przenosilo cudze dane do pamieci innego agenta.

Zasada po naprawie: **wszystko, czego bieg potrzebuje, jest zamrozone w chwili ZLECENIA
(SubTask / kontekst tury / okno zakladki) i odczytywane STAMTAD.**

- **Event-log tury nie ladowal juz w cudzej sesji** (AUD-security-064). `appendToActiveSession`
  w czacie adresuje pamiec po `event.agentName` (podaje go tura), nie po `getActiveMemory()`.
  Do tej pory wiadomosci, wywolania narzedzi i ich WYNIKI z tury agenta X dopisywaly sie do
  `sessions/active/` agenta Y — razem z trescia plikow, do ktorych Y nie ma dostepu.
- **Trwale notatki `brain/` z kompresji okna wracaja do wlasciciela** (AUD-security-065).
  Ratunek pamieci przed kompresja (`memory_rescue` + `writeBrainNote`) rozstrzyga sie po
  agencie ZAKLADKI. Wczesniej fakty z rozmowy X ladowaly na stale w `brain/` agenta Y i wchodzily
  do KAZDEGO jego promptu — czyli byla to tez droga trwalego wstrzykniecia miedzy agentami.
- **Dziennik biegu suba wraca do wlasciciela biegu** (AUD-security-091). `SubAgentRunner`
  bierze `getAgentMemory(<agent zlecenia>)`; nazwa jest argumentem `runTask` i ta sama trafia
  do `SubTask.agentName`. Brak pamieci dla nazwanej tozsamosci = ODMOWA zapisu, nie podstawienie
  cudzego katalogu.
- **Kompresja jedzie modelem i `brain.md` wlasciciela okna** (AUD-security-066). Providery
  `RollingWindow` (model, indeks pamieci, kontekst awaryjny) domykaja nazwe agenta zakladki.
  Wczesniej transkrypt agenta trzymanego swiadomie na lokalnym modelu mogl pojechac do dostawcy
  w chmurze skonfigurowanego dla innego agenta — razem z jego `brain.md` w tym samym wywolaniu.
- **Tryb autonomii zamrozony przy zleceniu** (AUD-security-050). `MCPClient` wstrzykuje
  znormalizowany tryb tury do argumentow jako `_invocationAutonomy` (ten sam wzorzec zaufanego
  znacznika co `_invocationAgentName`), `delegate` przenosi go do `runTask`, a `SubAgentRunner`
  uzywa go przy KAZDYM wywolaniu narzedzia. Do tej pory sub odpalony w czacie `all` („pytaj
  o wszystko") dokanczal prace w `yolo`, jesli user przeskoczyl na zakladke z `yolo` — czyli bez
  pytania nadpisywal pliki, kasowal i wolal narzedzia cudzych serwerow MCP. Lustro na pluginie
  zostaje wylacznie jako fallback dla wolaczy, ktorzy trybu nie przekazuja.
- **Rozwiazywanie pamieci jest FAIL-CLOSED** (AUD-security-036). W `memory_save`, `memory_delete`,
  `read`/`list`/`search` ze `scope: memory` znikl `|| getActiveMemory()` po nietrafionym
  `getAgentMemory(<tozsamosc z runtime>)`. Agent bez wpisu w `agentMemories` (pad inicjalizacji,
  skasowany w trakcie biegu w tle) dostaje odmowe `no_agent`, a nie cudzy katalog `brain/`.
  Fallback zostaje TYLKO na przypadek „nie da sie ustalic zadnej tozsamosci".
- **Przy okazji, ten sam wzorzec:** zapis transkryptu przy kompresji konca tury
  (`handleSaveSession`) bierze agenta i okno TEJ tury, a `todo` kluczuje plik sesja wolajacego
  agenta (`_invocationAgentName`), nie aktywnego.
- **Straznicy:** 9 testow w `modules/chat/chat/turnOwner.test.ts` (nowy, pure — `chat_session`
  importuje `obsidian`, wiec logika wlasciciela mieszka obok), 6 w `modules/sub-agents/
  SubAgentRunner.test.ts`, 3 w `modules/tools/MemoryV3Tools.test.ts` i `ReadTool.test.ts`
  oraz scenariusz harnessa **`43_tlo_po_turze`** — przelacza agenta i lustro autonomii dokladnie
  w chwili `task:created` i sprawdza, ze dziennik biegu zostal u wlasciciela, pamiec drugiego
  agenta jest nietknieta, a sub nadal PYTAL o zgode na zapis (czyli jechal `edge` ze zlecenia).

### fix(security): proweniencja wiadomosci czatu — tekst maszyny nie dostaje przywilejow czlowieka (K7, 2026-08-22)

Naprawa trzech znalezisk z audytu bezpieczenstwa: **AUD-security-062, AUD-security-088,
AUD-security-003**.

- **Jeden jawny znacznik pochodzenia** (`core/security/messageOrigin.ts`). Do tej pory o tym,
  czy tekst ma przywileje czlowieka, decydowalo to, KTORA funkcja UI narysowala dymek
  (`append_message('user', …)`). Kazda wysylka inicjowana przez KOD — guzik „Przywolaj agenta"
  na artefakcie, guzik propozycji delegacji, komentarz inline z notatki, auto-tura po wyniku
  sub-agenta — wkladala tekst do pola wpisywania i wolala `send_message()`, wiec dostawala
  pieczatke „to pisal czlowiek". Teraz proweniencja jest polem `meta.origin`
  (`'human'` | `'machine'`), nadawanym JAWNIE. Brak znacznika = maszyna (fail-closed).
- **Adres z tresci artefaktu nie odblokowuje `web_read`** (AUD-security-062). Rejestr
  proweniencji URL (`isUrlKnown`) zasila wylacznie tekst z `origin: 'human'`. Wczesniej model
  mogl wpisac adres do sekcji „Zrodla" artefaktu, a klikniecie guzika przez usera czynilo ten
  adres „znanym" i przepuszczalo pozniejszy `web_read` (kanal wycieku notatek w query stringu).
- **Marker `@@skill:` od modelu nie udaje polecenia usera** (AUD-security-088). `parseInlineTriggers`
  (i komendy `/`) dzialaja tylko dla `origin: 'human'`. Wczesniej `context_summary` napisany przez
  model wstrzykiwal pelny przepis skilla do promptu SYSTEMOWEGO tury w ramce
  „UZYTKOWNIK URUCHOMIL SKILL — wykonaj bez pytania".
- **Zakolejkowana wiadomosc usera odzyskuje proweniencje** (AUD-security-003, druga strona wady).
  Tekst wpisany w trakcie generowania szedl do okna kontekstu z pominieciem `append_message`, wiec
  adres wklejony przez czlowieka NIE trafial do rejestru i `web_read` go odrzucal. Teraz ta sciezka
  nadaje `origin: 'human'` i rejestruje adresy.
- **Uwaga terminologiczna:** `meta.origin` to NIE jest `_invocationOrigin` z `MCPClient`/`DelegateTool`
  — tamto jest adresem ZWROTNYM zlecenia (zakladka + agent), inny wymiar. Oba pola zostaja osobno.
- **Straznicy:** 5 nowych testow w `core/security/messageOrigin.test.ts` (fail-closed, MouseEvent
  jako `opts`, zamrozone stale) i 13 w `modules/chat/chat/messagePrivileges.test.ts` (rejestr URL
  na prawdziwym `urlRegistry`, markery inline, komendy `/` + straznicy zrodlowi pilnujacy, ze
  cztery wysylki z kodu niosa znacznik maszynowy, a dwie sciezki z pola wpisywania — ludzki).

### fix(security): wylaczone narzedzie ma egzekucje, nie tylko brak w liscie (K3, 2026-08-22)

Naprawa czterech znalezisk z audytu bezpieczenstwa: **AUD-security-052, AUD-security-004,
AUD-security-024, AUD-security-025**.

- **Os `disabled_tools` bramkuje WYWOLANIE, nie tylko widocznosc** (AUD-security-052).
  Do K3 os zyla wylacznie w filtrze `ToolRegistry.filterByAgent` (co model dostaje
  w definicjach narzedzi), a `MCPClient.executeToolCall` bral narzedzie z GLOBALNEGO
  rejestru. Model, ktory znal nazwe wylaczonego narzedzia (stara sesja, notatka, transkrypt
  innego agenta), wolal je po nazwie i nikt go nie zatrzymywal. Teraz decyzje podejmuje
  JEDNA metoda `ToolRegistry.checkToolAxis(agent, toolName)` — wola ja i `filterByAgent`,
  i klient przed pobraniem narzedzia z rejestru. Odmowa jest fail-closed i NIE pyta usera.
  Sprawdzenie idzie na nazwie KANONICZNEJ (po rozwiazaniu aliasow), wiec `vault_write` nie
  jest obejsciem wylaczonego `write`.
- **Opt-in `mcp_servers[]` na serwer zewnetrzny egzekwowany przy wykonaniu** (AUD-security-004).
  Narzedzie serwera, ktorego agent nie ma przypietego, konczy sie odmowa zamiast wywolaniem.
  Zmiana towarzyszaca: **brak listy `mcp_servers` znaczy teraz BRAK opt-inu** (dawniej
  `'*'`, czyli przepustka na wszystkie serwery zewnetrzne). Built-inow to nie dotyczy.
- **Popover uprawnien w czacie zapisuje agenta wbudowanego tam, gdzie loader czyta**
  (AUD-security-024). Zapis szedl przez `loader.saveAgent`, czyli do `jaskier.yaml` —
  pliku, ktory `loadAllAgents` odfiltrowuje, wiec ograniczenie znikalo po restarcie
  Obsidiana bez slowa ostrzezenia. Popover chodzi teraz przez `agentManager.updateAgent`
  (poprawna galaz built-ina: `jaskier_overrides.yaml`), a `AgentLoader.saveAgent` ma twardy
  guard: `agent.isBuiltIn` -> plik nadpisan, kto by nie wolal.
- **Martwe przelaczniki popovera zaczely dzialac (albo znikly)** (AUD-security-025).
  Cztery — „Odczyt notatek" / „Modyfikacja notatek" / „Tworzenie plikow" / „Usuwanie plikow" —
  pisaly w `default_permissions`, czyli w klucze, ktore `Agent._normalizePermissions` cicho
  kasuje, a `checkPermission` i tak nigdy nie czytal. Teraz mapuja sie na `disabled_tools`
  (`read`/`list`/`search`, `write`, `create_folder`, `delete`) — os, ktora od tego wydania
  jest egzekwowana. Piaty, „Narzedzia MCP", zostal WYCIETY: po E3.1 dostep do serwera
  zewnetrznego to opt-in per serwer w profilu agenta, wiec jeden boolean nie mial czego
  wlaczac. Presety (Bezpieczny/Standard/Pelny) rusza teraz WYLACZNIE te cztery przelaczniki
  i nie zmieniaja juz `guidance_mode` — dotad kazdy preset ustawial `guidance_mode:false`,
  wiec klikniecie „Pelny" zawezalo agenta do whitelisty folderow.
- **Straznicy:** 9 nowych testow w nowym `core/security/tool_axis_guard.test.ts` (pelny lancuch
  MCPClient + ToolRegistry + PermissionSystem: wylaczone `write` i jego alias nie dotykaja
  atrapy vaulta i nie pokazuja modala; serwer zewnetrzny bez opt-inu odmawia, z opt-inem
  przechodzi; zbior „widoczne" == zbior „wykonywalne") oraz 11 w nowym
  `modules/agents/permission_switches.test.ts` (mapa przelacznikow, presety, zapis built-ina
  do pliku nadpisan i przezycie restartu).


### fix(security): sekrety maskowane po NAZWIE pola, nie tylko po ksztalcie (K8, 2026-08-22)

Naprawa czterech znalezisk z audytu bezpieczenstwa: **AUD-security-027, AUD-security-055,
AUD-security-057, AUD-security-029**.

- **Maska rozpoznaje sekret po nazwie pola/naglowka** (AUD-security-027). `maskSensitiveData`
  dostala drugi, niezalezny filtr: wartosc pola o nazwie `Authorization`, `api_key`, `apiKey`,
  `x-api-key`, `*_key`, `token`, `secret`, `password` (bez wzgledu na wielkosc liter) jest
  maskowana NIEZALEZNIE od tego, jak wyglada - w JSON-ie (`"api_key":"..."`), w naglowku
  (`Authorization: Bearer ...`) i w gołym tekscie (`api_key=...`). Do K8 maska znala tylko
  KSZTALTY pieciu dostawcow, wiec klucz OpenRoutera, Groqa czy xAI szedl do
  `.pkm-assistant/logs/pkm-assistant.log` w czystej postaci. Dolozone tez kształty:
  OpenRouter (`sk-or-v1-`), Groq (`gsk_`), xAI (`xai-`) i nowy OpenAI (`sk-proj-`).
  Schemat autoryzacji (`Bearer`) zostaje czytelny, wartosc dostaje `abcd***wxyz`.
- **Blad sub-agenta wychodzi zamaskowany do WSZYSTKICH odbiorcow** (AUD-security-055).
  `SubAgentRunner._extractSafeErrorMessage` przepuszcza komunikat przez maske, wiec klucz
  nie wraca juz do modelu rodzica (wynik narzedzia `delegate`) ani nie laduje w pliku
  aktywnej sesji agenta w vaulcie. Do K8 maskowal tylko rejestr biegow.
- **`http_request` nie zrzuca calych `request_params`** (AUD-security-057). W galezi bledu
  do logu idzie jedna linia: metoda, adres BEZ query, status, czas i same NAZWY naglowkow
  (`core/utils/httpLogSummary.ts`). Wczesniej leciał `JSON.stringify(request_params)`, czyli
  komplet z naglowkiem `Authorization` / `x-api-key`.
- **`.gitignore` i lista plikow chronionych obejmuja logi i sesje pamieci** (AUD-security-029).
  Plugin dopisuje do `.gitignore` vaulta `.pkm-assistant/logs/` oraz
  `.pkm-assistant/agents/*/memory/sessions/`; te same sciezki sa w `PROTECTED_PATHS`, wiec
  `isProtectedPath` i `validateVaultPath` odbijaja je kodem `protected`. Wpisy `.gitignore`
  zyja teraz w jednej stalej `VAULT_GITIGNORE_ENTRIES` (testowalnej bez Obsidiana), a
  dopasowanie sciezek chronionych jest segmentowe i przyjmuje `*` jako jeden segment.
- **Straznicy:** 9 nowych testow w `core/security/SensitiveDataGuard.test.ts`, 4 w
  `core/security/keySanitizer.test.ts`, 3 w nowym `core/utils/httpLogSummary.test.ts`,
  2 w `modules/tools/vault_path_validator.test.ts` i 1 w
  `modules/sub-agents/SubAgentRunner.test.ts` (klucz z bledu suba nie wraca do rodzica
  ani nie laduje w pliku sesji).

### fix(security): pusty cel nie wylacza bramki (K2, 2026-08-22)

Naprawa pieciu znalezisk z audytu bezpieczenstwa: **AUD-security-075, AUD-security-076,
AUD-security-016, AUD-security-048, AUD-security-021**.

- **Akcja dotykajaca pliku BEZ celu = odmowa fail-closed** (AUD-security-075).
  Cala reszta `PermissionSystem.checkPermission` (No-Go, pliki chronione, whitelista
  `focusFolders`, `scope.folders` suba) stala za `if (targetPath)`, wiec pusty cel
  przeskakiwal WSZYSTKO. Nowy zestaw `TARGET_REQUIRED_ACTIONS` (`vault.write/create/
  create_folder/delete`, `artifact.create/update/read`, `image.generate`) wymaga celu;
  `vault.read` zostaje POZA nim swiadomie (ta sama akcja obsluguje `ask_user`, `todo`,
  `kom_list`/`kom_read` i `scope:'memory'`, ktore celu nie maja z definicji).
- **`artifact_*` podaje bramce prawdziwa sciezke** (AUD-security-075). Cztery narzedzia
  dostaly `contextExtractor`: `create` liczy sciezke, pod ktora notatka powstanie
  (`ArtifactStore.instancePathFor`), `read`/`update` - sciezke istniejacego artefaktu
  (`ArtifactStore.pathById`, synchronicznie, tylko folder artefaktow), `list` - folder
  artefaktow. Wynik `artifact_list` przechodzi przez `AccessGuard.filterResults` tym samym
  post-filtrem co `list`/`search`. **Skutek dla usera:** agent w trybie „Tylko przypisane"
  potrzebuje folderu artefaktow na swojej liscie - wczesniej pisal tam mimo pustej whitelisty.
- **`_findFileById` i `list()` trzymaja sie folderu artefaktow** (AUD-security-076).
  Pierwsze przejscie skanowalo CALY vault po frontmatterze `pkm-artefakt`, wiec
  `artifact_read`/`artifact_update` siegaly do kazdej notatki z tym kluczem - takze
  przeniesionej do folderu No-Go. `ArtifactStore.move` odmawia teraz przenosin POZA folder
  artefaktow (zamiast po cichu osierocic artefakt); przenosiny wewnatrz dzialaja jak dotad.
- **`add_text_to_image` waliduje CEL ZAPISU** (AUD-security-016). `output_path` szedl tylko
  przez `sanitizePath` + `isProtectedPath` (bez blokady `.pkm-assistant/`), a bramka ogladala
  sciezke ZRODLOWA. Teraz obie sciezki ida przez `validateVaultPath`, a `contextExtractor`
  oddaje bramce cel zapisu. `output_path` dolaczyl do pol kanonizowanych w `MCPClient`.
- **`generate_image` nie oddaje bramce promptu** (AUD-security-048). `targetPath` to od teraz
  folder zapisu z ustawien (`saveFolder`, walidowany przez `validateVaultPath`), a prompt
  jedzie osobnym polem do okna zgody. Wczesniej AccessGuard i koniunkcyjna bariera
  `scope.folders` suba ocenialy tekst pisany przez model - wystarczylo zaczac prompt od nazwy
  wlasnego folderu, zeby straznik powiedzial „whitelist".
- **„Brak celu" to nie „dowolny cel"** (AUD-security-021). `ApprovalManager.createPatternKey`
  zapisuje pusty cel jako jawny token `akcja::<bez-celu>`, nie jako wieloznacznik `akcja::*`;
  wywolanie bez celu nie laduje juz tez w regule `akcja::*`. Jedno kliknieciie „Zawsze zezwalaj"
  na akcji bez sciezki nie otwiera wiecej wszystkich przyszlych zapisow agenta. **Skutek dla
  usera:** stara regula `akcja::*` zapisana z pustego celu (np. `delegate`) przestaje pasowac -
  modal pyta raz jeszcze i zapisuje regule o wlasciwym znaczeniu.
- **Straznicy:** nowy `core/security/no_target_gate.test.ts` (odmowa dla kazdej akcji z listy +
  brak falszywych alarmow + reguly „zawsze"), nowy `modules/tools/AddTextToImageTool.test.ts`,
  testy `contextExtractor` i pelnego lancucha w
  `modules/tools/built-in-servers/artifacts/artifactTools.test.ts`, testy folderu zapisu
  w `modules/tools/GenerateImageTool.test.ts` oraz granicy przenosin w
  `modules/artifacts/ArtifactStore.test.ts`.

### fix(security): kanoniczna sciezka - bramka i narzedzie ogladaja JEDEN ciag (K1, 2026-08-22)

Naprawa czterech znalezisk z audytu bezpieczenstwa: **AUD-security-014, AUD-security-015,
AUD-security-018, AUD-security-001**.

- **`sanitizePath()` zwraca forme KANONICZNA** (AUD-security-014). Segmenty `.` i puste
  sa wycinane, wiec `./Sekrety/./tajne.md` i `Sekrety/tajne.md` to od teraz ten sam ciag.
  Funkcja jest idempotentna. `..` nadal ODRZUCAMY (nie rozwiazujemy).
- **Bramka dostaje sciezke kanoniczna, nie surowa** (AUD-security-015). `MCPClient`
  kanonizuje sciezke z argumentow narzedzia PRZED `checkPermission` i **podmienia ja
  w argumentach**, wiec `execute` dostaje dokladnie to, co ocenily No-Go, lista plikow
  chronionych i whitelista. Wczesniej narzedzie robilo swoja normalizacje dopiero po
  bramce - `./Sekrety/./tajne.md` i `/Sekrety/tajne.md` omijaly strefe No-Go, a
  `./.pkm-assistant/./settings.json` liste plikow chronionych (scenariusz harnessa
  potwierdzil realny wyciek tresci z folderu No-Go).
- **Obrona w glab + fail-closed** (AUD-security-018). `PermissionSystem.checkPermission`
  powtarza kanonizacje dla akcji `vault.*`; sciezka, ktorej nie da sie sprowadzic do formy
  kanonicznej, konczy sie twarda odmowa `Invalid path` - bez pytania usera i bez wywolania
  narzedzia. `AccessGuard` trzyma wpisy No-Go i porownywana sciezke w tej samej normalizacji
  (backslash -> `/`, kolaps `//`, ucieciu koncowek, wyciecie segmentow `.`).
- **`web_read`: adres kanonizowany raz, plus straznik sklejki z readerem** (AUD-security-001).
  Provenance, filtr domen, klucz cache i reader dostaja ten sam ciag. `readWebPage` odmawia,
  gdy `new URL('https://r.jina.ai/' + url).href` rozni sie od sklejki - segmenty `..`
  zwijaly sie PO sklejce i wysylaly reader na inna domene niz ta, ktora sprawdzil filtr.
- **Straznicy:** nowy `core/security/path_canonical.test.ts` (rownowaznosc decyzji dla
  wszystkich wariantow zapisu tej samej sciezki), testy lancucha w
  `core/security/security_integration.test.ts`, testy straznika w
  `modules/web/WebSearchProvider.test.ts` oraz scenariusz harnessa
  `42_sciezka_kanoniczna` (No-Go trzyma mimo przebran zapisu).

### Komunikator v3 „prosta poczta" (S28, 2026-07-29)

- **Project Hub skasowany w calosci** (D1): projekty, watki, briefy, embed w notatce i migrator
  Agory. Zwiad pokazal, ze folder `projects/` byl pusty - hub nigdy nie wszedl do uzycia.
  Projekt ogarniasz artefaktami zywymi (E2.9) na poziomie vaulta.
- **Nowa skrzynka: folder per agent, plik per wiadomosc** (D2) -
  `.pkm-assistant/komunikator/inbox/<agent>/msg-<timestamp>.md` z frontmatterem
  `od`/`do`/`temat`/`data` + `user_read`/`ai_read`. Koniec z jednym plikiem, regexami statusow
  na calej tresci i twardym limitem 500 KB z archiwizacja-resetem.
- **13 narzedzi -> 3 prymitywy** (D3): `kom_send` (YELLOW, jeden adresat na wywolanie) /
  `kom_list` (GREEN, same naglowki) / `kom_read` (GREEN, tresc + auto-ptaszek AI).
  **Create-only** - agent nie ma narzedzia kasowania poczty. `agent_message` skasowany.
- **Ping sesji to jedna linijka** (D4): „masz N nieprzeczytanych (od: X, Y)". Zero tresci,
  zero sciezki do pliku. Brak nieprzeczytanych = brak linijki w prompcie.
- **Sprzatanie pol-automatem, bez kosza** (D5): drugi ptaszek na wiadomosci otwiera modal
  z pelnym podgladem i pytaniem „usun / zostaw" (kilka naraz = kolejka, jeden modal na raz).
  W sidebarze guzik „Usun przeczytane" kasuje hurtem wszystkie obustronnie przeczytane.
- **Niewidzialnosc per agent zamiast szlabanu** (D6): przelacznik „Uczestniczy w komunikatorze"
  w profilu -> Uprawnienia. Wylaczony agent znika z list adresatow, paneli i pingu, a wysylka
  do niego zwraca ten sam blad co literowka w nazwie.
- **Komunikator wlaczony domyslnie** (D7) z przelacznikiem w Ustawienia -> Zaawansowane
  (zmiana wymaga przeladowania pluginu). Wylacznik to ten sam przewod co kill-switch z E1.2.

### Breaking changes

- Narzedzia `agent_message` i 12x `kom_*` (Project Hub) nie istnieja. Agenci uzywaja
  `kom_send` / `kom_list` / `kom_read`.
- Stary format skrzynek (`inbox_<agent>.md`) i folder `projects/` NIE sa migrowane (D8) -
  plugin ich nie widzi, pliki zostaja w vaulcie do recznego skasowania.
- Blok ```obsek-komunikator-project``` w notatkach przestal byc renderowany.

## [2.1.0] - 2026-07-21

Release notes: [releases/2.1.0.md](releases/2.1.0.md)

Etap 1 refaktoru v2.1 „Prawda i Bezpieczeństwo" (E1.1–E1.8). Zero nowych feature'ów poza
rdzeniem — za to plugin przestaje udawać: to, co obiecuje, naprawdę robi. (Plugin nazywał się
wtedy jeszcze „Obsek"; rename na `pkm-assistant` przyszedł w v2.2.)

### Added

- **Wyszukiwanie semantyczne, które naprawdę działa.** Nowy `VaultIndexer` buduje indeks
  znaczeniowy vaulta (Orama) przy starcie, łapie zmiany na bieżąco i trzyma indeks na dysku
  (restart nie przelicza od nowa). Status i przycisk „Re-indeksuj" w Ustawieniach.
  Desktop-first — telefon dostaje uczciwy komunikat zamiast cichej porażki.
- **Wszystkie limity agentów w jednym miejscu**, edytowalne w Ustawienia → „Limity".
- **Diagnostyka:** log pluginu do pliku (`.pkm-assistant/logs/obsek.log`) plus komenda
  „Self-test" z raportem stanu zdrowia.

### Changed

- **Plugin schudł z 8,35 MB do 3,0 MB** (wywałka `js-tiktoken`). Liczniki tokenów pokazują
  realne zużycie z API, a szacunki są uczciwie oznaczone jako „przybliżone" i kalibrują się
  same.
- **Pętla narzędzi ma prawdziwy hard-stop** — ostatnia runda bez narzędzi, model musi
  odpowiedzieć tekstem. Wyniki narzędzi są przycinane, zanim wysadzą kontekst.
- **Komunikator uśpiony kill-switchem** na czas refaktoru (dane nietknięte, powrót = jedna
  flaga).
- **ESLint pilnuje granic modułów**, a dokumentacja przeszła przegląd świeżości — mówi
  prawdę o stanie kodu.

### Removed

- **Martwy kod:** Cohere, stare narzędzia, legacy formaty.

### Security

- **Fail-closed w kluczowych miejscach:** agent z brakującą lub zepsutą whitelistą dostaje
  minimalny zestaw narzędzi (nie wszystkie), a sub-agent nie wykona narzędzia spoza
  przecięcia uprawnień żadną ścieżką.
- **`web_read` pobiera tylko adresy znanego pochodzenia** (wynik `web_search` albo link
  od użytkownika).
- **`.pkm-assistant/` jest poza zasięgiem narzędzi vaulta.**
- **Równoległe zapisy pamięci nie nadpisują się** (kolejka per plik).
- **XSS w ustawieniach modeli naprawiony**; dochodzi ostrzeżenie, gdy klucze API leżą
  niezaszyfrowane.

Pełne rozliczenie zmian: `Refaktor/RAPORT_Review_Fable_2026-07-07.md` → ANEKS A.

Plan Etapu 1 i decyzje: `Nauka/PLAN_REFAKTORU_v2.1.html`

---

## 2.0.0 - 2026-05-17

Stabilny release zamykajacy Refaktor Obsek v2.0. Po RC1 (2026-05-09) doszedl Sprint M3 (Memory v3) oraz seria 5 smoke testow v2 z 14 zamknietymi findingami.

### Co doszlo od RC1

- **Sprint M3 - Memory v3 (2026-05-15):** Memory v2 broken-by-design (Smoke 01 FIND-01: archivist destrukcyjny, konsolidacja nie odpala sie, L1 dane loss, memory_save scope) -> redesign architektoniczny PRZED stable release. `brain.md` jako krotki indeks + `brain/` trwale notatki + `sessions/active` live + `sessions/archive` + create-only `memory_save` + LLM-driven konsolidacja (analogiczna do `save_session`).
- **Smoke v2 (2026-05-14 -> 2026-05-17):** 5/5 GREEN. 14 findingow post-smoke zamknietych:
  - Smoke 01 retake po Memory v3 - 4 objawy FIND-01 RESOLVED
  - Smoke 02 (MCP E2E) - 9 findings: vault_write CREATE approval flow, web serwer connect_to_server + UI single-source, generalized approval override Group A, malformed transcript guard, sub-agent cleanup + filter UI per agent, _extractSafeErrorMessage wire + sanitize wrapper, Memory v3 follow-up UI sesje split + sub-agent brain context, auto-migrate per-agent prep yaml na Memory v3 tools, snapshot invocation agent name
  - Smoke 04 - DELETE skill silent fail (SkillLoader 3-level lookup fallback + folderPath resolver + rmdir recursive + cache cleanup)
  - Smoke 05 - 22 built-in tools blokowane przez PermissionSystem Unknown action (mapping naprawiony dla ask_user, brain_update, add_text_to_image, retrieval, kom_*)
  - Post-smoke - agent.model fallback dla wszystkich rol sub-agentow + LEGACY-1 closure

### Najwazniejsze zmiany (od v1.x)

- Sprint 01: quick wins security, usuniecie hardcoded ComfyUI key, path sanitization dla MCP image tools, bezpieczniejszy copy-plan-do-vault, deaktivacja wizardu do v3.
- Sprint 02: Embedding Reset, Orama integration, wywalka starego frameworka bazowego, dead Transformers i Connections panelu.
- Sprint 03: Memory v2 + Retrieval v2 (PoC - zastapione przez Memory v3 w Sprint M3).
- Sprint 04: MCP_PORZADEK_v1, built-in/user MCP separation, permissions per agent/role, MCP templates i Settings UI.
- Sprint 05: Sub-agents v2, cztery role rdzeniowe, inline triggers, popup `@`/`/`, sidebar trigger tab.
- Sprint 06: prompt caching dla Anthropic, OpenAI, xAI i Ollama, cache telemetry UI, PROMPTS_AUDIT telemetry.
- Sprint 07: Archetypes & Roles v2, role YAML, migracja `minion/master`, AgentCreatorModal removal.
- Sprint 08: Komunikator v2, migracja Agora projects, project tools `kom_*`, Agora removal.
- Sprint 09: Artefakty v2, `plan_action` removal, tool reactor registry, slash commands registry.
- Sprint 10: Settings v2 + Backstage v2, registry per module, profile skills split.
- Sprint 11: Token Context Viewer, token breakdown per category and model, modern tokenCounter mapping.
- Sprint 12: Skiny pluginu, SkinManager, Default / Crystal Soul / Custom skins.
- Sprint 13a: security audit STRIDE, stronger `sanitizePath`, master-password secrets storage, logger masking, WebSearchProvider moved to `modules/web/`, Oczko moved to multimodal.
- Sprint 13b: Connections decision final, PROMPTS_AUDIT snapshot, prompt survey UI, targeted polish chat/models/skills.
- Sprint 13c: migration guide, release notes, version bump.
- Sprint M3: Memory v3 architectural redesign (LLM-driven flow).

### Breaking changes

- The old base framework runtime and the Connections panel are removed.
- Agora is removed; Komunikator is the replacement.
- `plan_action` is removed; use `plan_review`, `idea_review` or `chat_todo`.
- `minion/master` are legacy names; use `researcher/strategist`.
- Onboarding wizard remains deferred to v3.
- Memory v2 format -> Memory v3 (auto-migration: backup `memory.v2.backup/`, brain.md split na brain/*.md, krotki indeks).

### Stats

- 16 sprintow wykonawczych (S01-S13c + M3)
- 5/5 smoke testow GREEN
- 14 findingow post-smoke closed (1 LOW open + 1 MEDIUM defer v2.1)
- 362/362 tests PASS
- Bundle 8.3MB
- ~14k LOC legacy wycięte (stary framework bazowy + Transformers + Agora + plan_action + minions/masters)

Migration guide: [MIGRATION_v2.md](MIGRATION_v2.md)

Release notes: notatki wydania v2.0.0 (archiwum repozytorium, poza publicznym drzewem)

---

## 2.0.0-rc.1 - 2026-05-09

Release candidate zamykajacy Refaktor Obsek v2.0. Po tygodniu testow RC pojawil sie Sprint M3 (Memory v3) i seria smoke testow v2 - patrz sekcja 2.0.0 powyzej.

### Najwazniejsze zmiany

- Sprint 01-13c: patrz sekcja 2.0.0.

### Breaking changes

- Patrz sekcja 2.0.0.

Migration guide: [MIGRATION_v2.md](MIGRATION_v2.md)

Release notes: notatki wydania v2.0.0 (archiwum repozytorium, poza publicznym drzewem)

---

## [1.2.1] — 2026-03-25 (pierwszy publiczny release)

### Added
- **Pierwszy publiczny release** — GitHub Release + BRAT (instalacja)
- **Multi-modal**: Vision INPUT (3-layer detection), Image Gen OUTPUT (7 platform: OpenRouter/OpenAI/Stability/Replicate/Gemini/xAI/ComfyUI), Audio STT (6 platform: Groq/OpenAI/Google/Deepgram/AssemblyAI/Ollama)
- **i18n** (PL + EN) — pełna dwujęzyczność, ~1000 kluczy, language picker w settings
- **Onboarding** — 3-krokowy wizard + Jaskier playbook z wiedzą o systemie
- **Security hardening COMPLETE** — sanitizePath, SensitiveDataGuard, isProtectedPath, ServerExecutor sandbox, 31 testów
- **MCP Serwery** — 4 produkcyjne (agent-builder/Nika, bug-tracker, agora, vault-builder/Borys)
- **Sub-Agent System** — 2 universal (prep, strateg) + per-agent (nika-prep, nika-krytyk)
- **Tryby pracy v3** (Dispatcher) — 2 tryby: Gadaj / Rób
- **Memory v2.9** — 4 toole (memory_brain/sessions/summaries/save), Plan 2.9 COMPLETE
- **Skills v2** — SKILL.md format, Skill Mode Guard
- **Crystal Soul v2** — IconGenerator, CrystalGenerator, 40+ SVG ikon
- **Agora MCP** — globalny serwer (4 toole: profile/projects/zones/update)
- **Universal Extended Thinking** — wszystkie 9 platform
- **Plan/TODO UX overhaul** — PlanReviewModal, PlanActionBar, todo agent-internal
- **ComfyUI Preview Modal** — code review + integracja + ComfyWorkflowLoader
- **Web Search + Read** — Jina Reader, cache 5 min

### Changed
- **Wyciągnięcie zależności zewnętrznych, faza 3 COMPLETE** — `external-deps/` usunięte (sesja 100). Wszystko w `src/`
- **Licencja** — GPL-3.0-or-later

### Tests
- `npm test` → 58/58 PASS
- Manual: 14/14 PASS

---

## [1.1.0] i wcześniejsze

> Historia sprzed pierwszego publicznego release w `DEVLOG.md` (sesje 0-115).

---

## Linki

- Repo: https://github.com/JDHole/pkm-assistant
- Release notes v2.2.0: `releases/2.2.0.md`
- Release notes v2.0.0: w archiwum repozytorium (poza publicznym drzewem)
- Branch refaktoru: `refactor/modules-foundation`
- Plan Refaktoru v2.0 (archiwum): `Refaktor/00_Wielki_Plan_Refaktoru.md`
- Żywy plan i changelog projektu: `Nauka/PLAN_REFAKTORU_v2.1.html`
- ADR-y: w vaulcie właściciela, w folderze dokumentacji projektu
