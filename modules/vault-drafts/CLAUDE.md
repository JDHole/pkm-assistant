# modules/vault-drafts/

P1–P5 wersji 2.4.7: trwały magazyn, warstwowy widok i przegląd kopii roboczych.
Runtime odtwarza magazyn przed rejestracją delegacji. Nie importuje runtime Obsidiana, runnera, czatu ani MCPClient; port adaptera używa wyłącznie typu DataAdapter.
Jedyny port zapisu do bazowego vaulta należy do jawnego DraftReview; magazyn i widok pozostają odizolowane.

Pliki są osiągalne statycznie przez barrel `tools/index.ts` (P2), a od P3 runner tworzy widok/host wyłącznie po jawnym wstrzyknięciu
`SubRunDrafts`. Od P5 tworzy go produkcyjny runtime po odtworzeniu magazynu. Dlatego usunięto pięć nieaktualnych
wpisów P1 w `ZNANE_SIEROTY`; asercje strażnika pozostają bez zmian.

## Co tu mieszka

- `types.ts`: brandy, rozłączne stany plików/propozycji/przeglądu/fazy, manifest,
  błędy domenowe i porty I/O, zegara oraz SHA-256.
- `schema.ts`: walidacja przez `@cfworker/json-schema`, fabryki brandów,
  walidacja manifestu i mutacji na granicy `unknown`.
- `DraftPersistence.ts`: bloby adresowane hashem oraz kolejne generacje manifestów,
  suma SHA-256 manifestu, odczyt kontrolny, skan odzyskiwania.
- `DraftStore.ts`: leniwe kopie, pierwsza baza, kolejki ścieżek, serializacja publikacji
  całego manifestu, `open → sealed`, odtworzenie po restarcie.
- `DraftView.ts`: własna kopia → zamrożeni poprzednicy → vault; listing, tombstones,
  tekst/binary, pochodzenie i kolejka read-modify-write współdzielona przez hosty biegu.
- `AdapterDraftStorage.ts`: port mobilny nad wąskim `Pick<DataAdapter, ...>`, bez Node,
  z kontrolą bajtów, kolejkami i sprzątaniem stagingu przed restore (F2a, podłączony przez F2b).
- `DraftStore.test.ts`: AVA, odczyty faktycznie zapisanych bajtów przez nową instancję,
  awarie i bariery sterujące wyścigami; bez Obsidiana i rzeczywistych timerów.

## Publiczne API (`index.ts`)

`DraftStore(persistence, vaultIO, clock, isProtected?)`:

- `create(identity: unknown)`: waliduje właściciela (agentName, sessionPath,
  sessionEpoch), draftId, runId, threadId i opcjonalny planId/nodeId. Nie tworzy plików.
  ID dostarcza zaufany runtime; nie wolno używać do tego argumentów modelu.
- `mutate(draftId, {path, source: {tool, callId}, value}, inheritedFrom?)`: tekst, bajty, folder albo
  tombstone z dyspozycją trash/permanent. Zwraca trwały snapshot manifestu.
- `snapshot(draftId)`, `list()`: niezależne kopie danych; to wewnętrzne API, nie
  autoryzowane narzędzie prowadzącego. Własność i zakres dostępu egzekwuje DraftReview z zaufanym kontekstem prowadzącego.
- `seal(draftId, reason)`: synchronicznie odbiera prawo mutacji/publikacji; Promise
  potwierdza trwałe zamknięcie. Powtórzenie zachowuje pierwszą utrwaloną przyczynę.
  Po błędzie zapisu kopia pozostaje zablokowana w RAM; `seal` można ponowić.
- `restore()`: na świeżym magazynie, przed dopuszczeniem biegów. Zwraca `{drafts, issues}` i zachowuje kompletny skan do pierwszego GC.
  Zamyka `open` jako `sealed/restart`, zmienia `applying` na `recovery-required`.
  Nie uruchamia pracy, zgód ani zapisów do vaulta. Błąd utrwalenia restore odrzuca Promise.

`DraftPersistence(storageIO, hasher)` udostępnia `putBlob`, `readBlob`, `hash`,
`hasDraft`, `save`, `writeIntent`, `loadAll`. Wynik loadAll zawiera także zwalidowane
inwentarze pokwitowań i sierot, używane przez GC bez kolejnego skanu. `save` jest niskopoziomowym API dla zaufanego store/review;
nie udostępniać go narzędziom modelu. `readBlob` sprawdza długość i SHA-256.
Barrel eksportuje też typy, `DraftError` z `code`, `DRAFT_ROOT` i fabryki
`parseDraftId/ChangeId/BlobId/ContentHash/Revision/VaultPath/DraftManifest/DraftMutation`.

## Trwałość i granica adaptera

Zapis wyłącznie pod `.pkm-assistant/subagent-drafts/v1/<draftId>/`:
`blobs/<sha256>`, `manifests/000001.json`, `000002.json`, itd., oraz `decisions/<attemptId>.json`. Nazwa bloba nie zawiera
ścieżki użytkownika; runId/threadId są tylko metadanymi. Rewizja treści rośnie przy
mutacji; generacja manifestu również przy seal/restore. Manifest jest opakowany jako
`{payload: string, checksum: SHA256(payload)}`. Starsze generacje są zachowane.

Desktopowy kontrakt `DraftStorageIO.publish` jest **atomową, create-only publikacją**, nie zwykłym
`adapter.write`: musi ocenić `mayPublish` w punkcie publikacji bez asynchronicznej
przerwy i zwrócić `cancelled` bez widocznej generacji, jeżeli zamknięto kopię.
Odrzucenie oznacza brak publikacji, sukces — trwałe, odczytywalne bajty. Przygotowanie
pliku tymczasowego może być asynchroniczne; punkt publikacji musi spełniać ten kontrakt.
Adapter desktopowy P5 realizuje ten kontrakt synchroniczną publikacją przez hard link. Nie wolno zastąpić tego
portu sekwencją „sprawdź flagę → await write”; zgubiłaby ochronę przed późnym zapisem.
P1 testuje oba momenty Stopu: podczas bloba oraz przed atomową publikacją manifestu.
Jeden aktywny store jest właścicielem namespace; równoległe procesy zapisujące ten sam
DraftId wymagają blokady po stronie adaptera. `publish` nie nadpisuje istniejącej nazwy. Jawny wyjątek mobilny i jego ograniczenia opisuje sekcja F2a poniżej.

Port magazynu/widoku vaulta ma tylko `stat/read` (widok dodatkowo list). Baza powstaje przy pierwszej mutacji przez
stat → bajty → stat, maksymalnie trzy próby. Błąd odczytu daje `io-error`, nie pustą
bazę. SHA-256, rozmiar, mtime i oryginalne bajty są zachowane. Port zegara podaje
nieujemne milisekundy; mtime i czas mogą zawierać część ułamkową. SHA-256 dostarcza host, a wynik jest walidowany.

Ścieżka ma własną kolejkę; publikacje różnych ścieżek tej samej kopii mają dodatkową
kolejkę, żeby nie utracić wpisów manifestu. Niepowodzenie nie zatruwa kolejki.
Pierwsza baza i identyfikator pozostają w `firstTouches` również po create → delete,
które usuwa wpis z `changes`. Późniejsza ponowna mutacja nie przesuwa bazy.
Zapis pliku na folderze, usuwanie folderu, tworzenie folderu na pliku i usunięcie
nieistniejącego pliku dają `invalid-transition`. Rename/move nie istnieją.

Odtworzenie wybiera ostatnią kompletną generację ze sprawdzonymi blobami. Uszkodzenie
jest zwracane w `issues`, plik pozostaje na dysku. Nierozpoznana wersja manifestu
blokuje fallback i zapis do tego katalogu. Osierocone bloby nie tworzą propozycji.
Nie ma TTL nierozstrzygniętych kopii. GC P5 opisano poniżej.

## Warstwowy widok

`DraftView(store, persistence, vaultIO, draftId | null, predecessors = [])`:
- `resolve(path)` zwraca vault/proposal/ambiguous-input i źródła; `read/readBinary/stat`
  nie wybierają zwycięzcy przy różnych niezależnych propozycjach.
- `list(folder = '')` zwraca `{files, folders, ambiguous}` pod logicznymi ścieżkami;
  ukrywa tombstones i prywatny katalog magazynu, scala foldery jawne i rodziców plików.
- `freeze()` wymaga zamkniętej własnej kopii; daje głęboko zamrożony `FrozenDraftView`
  z odziedziczonym grafem. Bliższy potomek przesłania przodka, identyczne niezależne
  propozycje zachowują oba źródła. Decyzje review nie zmieniają zamrożonych danych.
- `mutate(path, source, value | transform, expectation)` czyta wewnątrz kolejki ścieżki;
  jeden obiekt widoku należy współdzielić między wywołaniami danego biegu.
  `draftId: null` pozwala tylko czytać poprzedników. Bez poprzedników i potrzeby
  pisania runtime ma wybierać istniejące wykonanie `live`, nie tworzyć hosta kopii.

Port `DraftViewIO` rozszerza odczyt vaulta o `list` bezpośrednich dzieci (root `''`).
`DraftStore.mutate` przyjmuje zaufane referencje poprzedników od widoku, waliduje seal
oraz rewizję i kopiuje blob pierwotnej bazy do namespace następcy. Kolejne patche
zachowują bazę i źródła. Identyczna propozycja z różnymi bazami pozwala czytać, ale
odmawia pochodnego zapisu (`ambiguous-input`), żeby nie zgubić konfliktu.
Tombstone odziedziczonego NOWEGO pliku z bazą missing musi pozostać w manifeście:
usunięcie go z zestawu netto odsłoniłoby plik poprzednika. Walidator dopuszcza go
wyłącznie z niepustym `inheritedFrom`; własne create → delete nadal znika netto.

Testy P2: `modules/tools/subToolExecution.test.ts` (narzędzia, widok, izolacja,
artefakty/frontmatter, Orama, adapter, odtworzenie pochodnego tombstone i paginacja).

P3 wiąże store z biegiem i Stopem przez opcjonalny `SubRunDrafts` w module sub-agents.
P5 dostarcza adapter trwałej publikacji magazynu, rejestrację, zdarzenia i retencję.
Test adaptera sprawdza rzeczywisty zapis, anulowanie i create-only publikację.

## P4 — przegląd, decyzje i granica atomowości

`DraftReview(store, persistence, reviewIO)` eksportuje `list(context, filter)` i
`decide(context, {action, draftId, changeId, revision})`. Publiczne typy:
`DraftReviewIO`, `DraftReviewContext`, `DraftPreview`, `ReviewDecision`, `ChangeSummary`.
Kontekst `main` i callbacki uprawnień/zgody pochodzą z runtime, nigdy z argumentów
modelu. Właścicielem jest agent; domyślna lista dodatkowo wymaga tej samej ścieżki
sesji i epoki. Jawne `scope: agent` pozwala odnaleźć wcześniejsze sesje. Decyzja
wskazująca konkretną kopię własnego agenta jest możliwa również po archiwizacji sesji.
Każdy wpis listy podlega aktualnemu prawu odczytu. Strona ma najwyżej 50 wpisów,
stabilny kursor draft/change; szczegół ogranicza każdą stronę tekstu do 2000 znaków
z `truncated`. Binary zwraca rozmiary i operację, nigdy bajty/base64 w wyniku narzędzia.

`DraftStore.withReviewLock` serializuje decyzje po logicznej ścieżce w CAŁYM magazynie,
również między reviewerami, sesjami i kopiami. Niezależne pliki nie czekają na cudzy
modal. `setReview` jest niskopoziomowym, zaufanym API z walidacją przejść; wymaga seal,
rewizji zmiany i aktualizuje wyłącznie generację manifestu. Nie zmienia rewizji treści
ani zamrożonych wejść następników. Accepted/rejected są terminalne; ponowienie
przyjętej rewizji zwraca zachowane pokwitowanie bez nowego zapisu lub okna.

Kontrola bazy obejmuje SHA-256, bajty i mtime, przez stat → odczyt → stat. Powtarza się
przed zgodą, po zgodzie i po utrwaleniu intencji, tuż przed operacją. Baza odziedziczona
pozostaje bazą poprzednika. Konflikt blokuje wyłącznie tę ścieżkę; nie istnieje force
ani merge. Odmowa okna pozostawia pending, reject jest osobną trwałą decyzją.
Po zgodzie ponownie sprawdzamy rewizję, narzędzia, uprawnienia i brakujące katalogi
nadrzędne. Tworzenie technicznych rodziców nie przyjmuje innych pozycji przeglądu.

Dziennik: najpierw trwała generacja `applying`, potem create-only, sprawdzony odczytem
plik `decisions/<attemptId>.json` z sumą SHA-256, bazą, propozycją i zatwierdzoną rewizją.
Dopiero potem wolno dotknąć vaulta. To eliminuje okno, w którym intencja byłaby na
dysku, ale restore widziałby tylko pending. Odczyt rzeczywistego wyniku musi zgadzać
się z propozycją przed publikacją accepted. Błąd zapisu/odczytu/pokwitowania daje
recovery-required; gdy dysk nadal nie działa, applying w RAM i na dysku blokuje
ponowienie. Restore nigdy nie odtwarza operacji i nie wnioskuje o autorstwie po
zgodnych bajtach. Decyzja końcowa mieszka w manifeście; plik intencji pozostaje niezmienny.

**Granica atomowości:** `DraftReviewIO.processText` MUSI wywołać `vault.process`
(dla ukrytego tekstu host ma `adapter.process`), bez fallbacku modify/write.
Callback porównuje świeży tekst z oryginalnymi bajtami wcześniej sprawdzonymi SHA-256
oraz mtime. Porównanie całego tekstu jest dokładniejsze niż sam hash i nie wymaga
asynchronicznego hashowania w synchronicznym callbacku Obsidiana. Host indexed podaje
mtime z TFile; adapter ukrytych plików podaje ostatni stat bezpośrednio przed process,
ponieważ callback adaptera udostępnia tylko tekst. Atomowość process dotyczy treści;
metadata-only zmiana ukrytego pliku w samym callbacku nie ma warunkowej operacji hosta.
Tworzenie plików używa create-only Vault API. Brak potrzebnej metody kończy się
odmową/niepewną decyzją, nigdy niezabezpieczonym fallbackiem.

**Decyzja Kuby 07.11.2026: „Okno + siatka asekuracyjna”.** Obsidian nie oferuje
warunkowego modifyBinary/trash. Przyjęte usunięcie ZAWSZE trafia do kosza, nawet gdy
propozycja zawiera permanent; host nie ma tu ścieżki delete/remove. Reguła katalogu Obsidiana
zgłasza tu ostrzeżenie, które świadomie zostaje: `FileManager.trashFile` przy ustawieniu
„trwale usuń” pomija kosz. Przed nadpisaniem
binarium (także przed usunięciem) host odczytuje bieżące bajty i woła checkpoint.
Ten zapisuje blob trwale i publikuje `applying.recoveryBlob` przed operacją. Manifest
jest dziennikiem decyzji; pierwotna intencja pozostaje niezmienna. Pokwitowanie accepted
lub recovery-required oraz restore zachowują recoveryBlob (blob/hash/bytes). GC nie
usuwa tego bloba nawet po zebraniu pozostałego payloadu zaakceptowanej kopii.

Host ponownie sprawdza bajty/metadane po utrwaleniu checkpointu i obserwuje zdarzenia
modify/delete podczas operacji. Po tych awaitach synchronicznie ponawia autoryzację
przed wejściem do operacji hosta. Zmiana na granicy hosta, obserwowalny wyścig, błąd
operacji albo wynik różny od zatwierdzonego daje recovery-required ze wskazaniem
zachowanych bajtów; operacja nie jest ponawiana. Po udanej operacji DraftReview
odczytuje stan i wymaga dokładnej zgodności rodzaju, SHA-256 i długości z propozycją.

**To nie jest compare-and-swap.** Niezależny pisarz, który zmieni bajty po ostatnim
odczycie, a przed operacją i nie dostarczy obserwowalnego zdarzenia, nadal może zostać
nadpisany bez wykrycia, jeśli wynik końcowy odpowiada propozycji. Blob chroni ostatnie
odczytane bajty, nie niezaobserwowaną edycję z tego okna. Kosz przechowuje faktycznie
usunięty plik. Kolejka magazynu serializuje przyjęcia, ale nie blokuje innych pisarzy.
Testy F5 `SubagentChangesTool.test.ts` zatrzymują prawdziwy host na barierze operacji,
wprowadzają konkurencyjną zmianę i odczytują recoveryBlob oraz zawartość kosza po
recovery-required. Osobne testy sprawdzają rozbieżny wynik, restart, GC pokwitowania
i cofnięcie uprawnień podczas trwałego checkpointu.

Host review `createDraftReviewHost(app)` jest w tools (barrel). Nie uruchamia się
samodzielnie. Runtime P5 współdzieli jeden store i wykonuje restore przed rejestracją
narzędzia. GC zachowuje pokwitowania i bloby używane przez następników.
Testy: `modules/tools/SubagentChangesTool.test.ts` (publiczne MCP, rzeczywisty system
uprawnień, host review, trwałe bajty i restart, kontrolowane bariery),
`modules/ui-components/DiffModal.test.ts` (nowe warianty DOM obok starych asercji).


## 2.4.7 P5 — runtime, zdarzenia i sprzątanie

`DesktopDraftStorage(fs, basePath)` jest implementacją portu prywatnego magazynu dla
Obsidiana desktop. Na mobile composition root pomija ten port i od F2b wybiera
AdapterDraftStorage, bez fallbacku do zapisu live. Node jest wstrzykiwany jako wąska
zdolność; moduł nie importuje runtime'u Node ani Obsidiana. Adapter odrzuca traversal,
ścieżki spoza namespace i symlinki. Zapisuje staging create-only, wykonuje fsync
zawartości, następnie sprawdza mayPublish i synchronicznie publikuje przez linkSync.
Nie ma await między sprawdzeniem a publikacją. Hard link nigdy nie nadpisuje
istniejącej generacji. Brak tej zdolności hosta odmawia zapisu kopii; brak fallbacku
adapter.write/live. To publikacja w jednym procesie, nie blokada wielu instancji
pluginu ani gwarancja przetrwania utraty zasilania wszystkich metadanych filesystemu.

`DraftStore.events` emituje `draft:changed` po trwałej mutacji, seal i decyzji.
`retain(ids)` zwraca idempotentny release; następnik i kontynuacja trzymają wszystkie
tranzytywne warstwy. `collectResolved()` usuwa payload wyłącznie sealed i w całości
accepted/rejected, bez aktywnych referencji. Najpierw publikuje małe pokwitowanie
`payloadCollected:true`, potem usuwa stare generacje, bloby i intencje. Pokwitowanie
zachowuje ID, ścieżki, rewizje, hashe i decyzje, więc ponowienie decyzji po restarcie
nadal działa; lista zebranej kopii nie próbuje czytać usuniętego podglądu. Walidator
odrzuca payloadCollected dla nierozstrzygniętych zmian. Awaria usuwania pozwala
ponowić GC po restarcie. Jakikolwiek problem pełnego skanu odzyskiwania blokuje GC;
nie usuwamy nieznanego formatu. Zamknięcie sesji ani retencja RAM nie usuwa propozycji.

`summarizeDraft` i walidujący `parseDraftSummary` dają opcjonalną projekcję właściciela,
referencji, czterech liczników oraz ścieżek/statusów. Brak zmian daje undefined.
Źródłem decyzji pozostaje store; historia przechowuje tylko referencję.
Testy P5: `../tools/vaultDraftRuntime.test.ts`, `../tools/runnerDrafts.test.ts`,
`../chat/chat/subTaskStrip.test.ts`, `../ui-components/SubAgentBlock.test.ts`.


### 2.4.7 — osierocone bloby

Po poprawnym skanie `collectResolved` wywołuje konserwatywne `collectOrphans`.
Usuwa poprawne bloby v1 z katalogów bez żadnego manifestu (np. Stop przed pierwszą
publikacją), dopiero po pełnym skanie i sprawdzeniu hashy wszystkich kandydatów.
Żaden katalog znany bieżącemu store, z manifestem lub decyzją nie jest kandydatem;
żywych ID sprawdza także przed usuwaniem, aby nowy bieg nie wpadł pod stary skan.
Nierozpoznany układ/nazwa pozostaje nietknięty, a błąd odzyskiwania blokuje sprzątanie.
Referencje wejść nadal blokują zwykły GC rozstrzygniętych kopii. Testy F8 w
`DraftStore.test.ts` odtwarzają Stop przed manifestem, restart, aktywną referencję
i nieznany format; test P5 w `tools/vaultDraftRuntime.test.ts` sprawdza referencję C.


## Mobile M4 F2a - magazyn na adapterze vaulta

Barrel eksportuje `AdapterDraftStorage(adapter, nextTemporaryId?)`. Konstruktor przyjmuje
`Pick<DataAdapter, 'list' | 'readBinary' | 'writeBinary' | 'rename' | 'remove' | 'stat' | 'mkdir'>`
oraz opcjonalny generator UUID v4 (domyślnie `crypto.randomUUID`, wstrzykiwany w testach kolizji).
Od F2k adapter może dodatkowo udostępniać rmdir do usuwania pustych katalogów.
Nie wykrywa platformy i nie importuje Node ani runtime Obsidiana. F2a dostarczyło
port, a F2b wybiera go przez istniejący `Platform.isMobile`, współdzieli jedną
instancję na namespace i kończy restore przed dopuszczeniem pisarzy.
Runner i DesktopDraftStorage pozostają bez zmian.

Format i korzeń pozostają wspólne: `.pkm-assistant/subagent-drafts/v1`.
Walidacja nazw zachowuje desktopowe ASCII, odrzuca `..`, `.`, puste segmenty,
ścieżki absolutne i wyjście poza korzeń. Dodatkowo rezerwuje `.staging` bez dostępu
przez publiczne read/write/list/remove. Rodzice korzenia są tylko tworzeni w razie
braku. Adapter nie udostępnia lstat, więc nie obiecujemy wykrycia dowiązań symbolicznych.
Listowanie normalizuje pełne ścieżki i same nazwy do bezpośrednich dzieci,
bez ukrywania błędów I/O jako pustego magazynu. Brak katalogu daje pustą listę.

`writeBlob` kopiuje wejściowe bajty, serializuje ścieżkę, czyta istniejący blob i
akceptuje tylko identyczną zawartość bez ponownego zapisu. Nowy zapis jest odczytywany
bajt w bajt; błąd powoduje próbę usunięcia. Gdy usunięcie nie działa, uszkodzony blob
pozostaje do wykrycia przez SHA-256 i długość w DraftPersistence.

`publish` najpierw odmawia istniejącego celu, następnie zapisuje unikalny plik w
`.staging`, odczytuje bajty kontrolnie i w jednym synchronicznym kroku sprawdza
wcześniejszy stat oraz rejestr publikacji, wywołuje `mayPublish`, rezerwuje nazwę i
rozpoczyna rename. Kolejka per ścieżka uniemożliwia dwóm wywołaniom wygranie tej samej
nazwy. Inne ścieżki nie czekają na tę publikację; tworzenie wspólnych rodziców ma
osobną serializację. Błąd nie zatruwa kolejki. Rejestr zachowuje także niepewny cel,
żeby brak potwierdzenia nie pozwolił nadpisać go w tym runtime.

F2c: nazwa stagingu to dokładnie 40 znaków: małe szesnastkowe UUID v4
`xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx.tmp` (nawias oznacza jeden z czterech
znaków wariantu). Funkcje `temporaryName` i `isTemporaryName` wspólnie definiują
tworzenie i ścisłe rozpoznawanie całej nazwy, bez dodatkowego prefiksu/sufiksu.
Instancja rezerwuje nazwę przed pierwszym await, sprawdza jej istnienie przez stat
i trzyma rezerwację do końca sprzątania publikacji. Kolizja w RAM lub na adapterze
powoduje kolejną próbę, maksymalnie osiem; wyczerpanie prób daje io-error bez zapisu
i bez usuwania zastanego wpisu. Błąd stat zwalnia rezerwację i odmawia publikacji.
Nie jest to blokada zewnętrznego pisarza między stat a writeBinary.

Po rename, także odrzuconym, odczyt celu rozstrzyga wynik: brak oznacza błąd,
identyczne bajty oznaczają sukces, inne bajty powodują próbę usunięcia i błąd.
Rename, który nic nie zrobił mimo resolve, również kończy się błędem.
Staging jest sprzątany best-effort w finally; jego pozostałości nigdy nie są
manifestami ani blobami. `cancelled` nie tworzy celu, choć awaria sprzątania może
pozostawić ukryty staging.

| Gwarancja | Desktop | Telefon |
|---|---|---|
| Integralność blobów i manifestów | SHA-256, długość, readback w persistence | Ten sam format i walidacja, dodatkowy readback portu |
| Niezmienność bloba | Porównanie istniejących bajtów, publikacja hard link | Porównanie bajtów i kolejka jednej instancji |
| Create-only manifestu | Synchroniczny linkSync nie nadpisuje celu | Wcześniejszy stat, rejestr i kolejka jednej instancji |
| Stop przed publikacją | mayPublish bez przerwy przed linkSync | mayPublish bez przerwy przed rozpoczęciem rename |
| Stop po rozpoczęciu rename | Nie dotyczy synchronicznego linkSync | Nie odwołuje operacji już dopuszczonej; może ona zakończyć się po Stop |
| Trwałość zawartości | fsync stagingu, bez pełnej gwarancji metadanych po utracie zasilania | Brak fsync; nawet potwierdzona generacja może zniknąć po ubiciu procesu lub utracie zasilania |
| Atomowość publikacji | Hard link | Brak udokumentowanej atomowości rename i brak hard linków |
| Odrzucenie publikacji | Brak nowej publikacji | Niepewny cel może pozostać przy błędzie odczytu lub usunięcia |
| Blokada procesów/urządzeń | Brak | Brak |
| Dowiązania symboliczne | Odrzucane przez lstat | Brak takiej zdolności w wąskim API adaptera |
| Restart po uszkodzeniu | Ostatnia kompletna generacja, issues | Ten sam skan, plus diagnostyka i sprzątanie stagingu |

Opcjonalne `DraftStorageIO.cleanupTemporary()` zwraca `RecoveryIssue[]`.
DraftStore.restore wywołuje je przez persistence wyłącznie przed odtwarzaniem,
na pustym store, przed przyjęciem pracy. Zwykły skan/GC nie sprząta stagingu aktywnego
pisarza. Desktop nie implementuje hooka, zatem nie dostaje dodatkowego I/O.
Sprzątanie rozpoznaje wyłącznie zwykłe pliki o powyższej nazwie (stat.type=file).
Obce nazwy, również ze spacjami lub dodatkowymi znakami, oraz podfoldery pozostają
nietknięte i nie są zgłaszane jako przerwana publikacja. Cały `.staging` jest ukryty
przed publicznym listowaniem magazynu, więc jego obce wpisy nie trafiają do skanu
manifestów ani blobów. Rozpoznane pozostałości są raportowane nawet po skutecznym usunięciu; błąd skanu lub sprzątania
nie blokuje startu. Jak inne issues, blokują GC w tym store.

Po przerwanym stagingu restore zwraca poprzednią kompletną generację i issue.
Po uciętym manifeście zachowuje uszkodzony plik, zgłasza issue i wraca do poprzedniej
kompletnej generacji. Nie stosuje zmian do vaulta. Pełna generacja pozostawiona po
nieudanym potwierdzeniu jest nieodróżnialna od poprawnej publikacji i może być
odtworzona. Całkowicie zaginionej generacji nie da się wykryć, więc powrót do starszej
może nie mieć issue. To świadome ograniczenia mobilne, nie desktopowy kontrakt.

Testy:
- `DraftStorage.contract.test.ts`: jedna rejestracja kontraktu dla nowego portu i
  niezmienionej klasy desktopowej na prawdziwym katalogu tymczasowym; pusty listing,
  binaria, niezmienność, create-only, cancellation, odmowa, GC i walidacja ścieżek.
- `AdapterDraftStorage.test.ts` oraz `test-support/MemoryAdapter.ts`: awarie przed i
  po operacjach, ucięte zapisy, rename po wykonaniu/bez efektu/częściowy, błędy
  readback i cleanup, obie postacie listingu, współbieżność i granice Stopu.
  Snapshot plików na granicy I/O pozwala odtworzyć nowy store po symulowanym ubiciu.
  F2c dodaje restore mieszanego stagingu dla obu postaci listingu, ponowny restore
  bez fałszywych issues, kolizje nazw w RAM (także podczas stat) i na adapterze,
  ponowienie/odmowę bez nadpisania oraz test mikrozadania odbierającego prawo
  publikacji: rename musi rozpocząć się przed jego wykonaniem.
- `DraftStore.test.ts`: wszystkie dotychczasowe 26 scenariuszy uruchamiane dodatkowo
  na nowym porcie, z tymi samymi asercjami i nową instancją portu przy restarcie.

Testy pamięciowe nie dowodzą zachowania CapacitorAdapter na Androidzie/iOS:
pozostają próby ukrytych katalogów, rename przy ubiciu procesu, zaniku zasilania,
wydajności i pamięci dla dużych blobów oraz synchronizacji między urządzeniami.
F2b zachowuje te ograniczenia również przy dopuszczeniu review i dodaje regułę
gitignore dla lokalnego namespace; inne mechanizmy synchronizacji vaulta mogą
nadal przenosić te dane i muszą je wykluczyć po stronie użytkownika.


## Mobile M4 F2 - podłączenie, koszt startu i próby na urządzeniu

`tools/mobileDraftPorts` buduje AdapterDraftStorage, wspólny host review bez Node
oraz SHA-256 przez Web Crypto. Tylko potwierdzony brak korzenia pozwala runtime
pominąć restore i początkowe GC: jeden stat, zero zapisów (licznik w
`src/main.mobile.test.ts`). Każdy istniejący katalog przechodzi dotychczasowy
pełny skan; błędy nie oznaczają pustego magazynu. F2k zmniejsza koszt skanów
na obu platformach, zachowując desktopową trwałość publikacji.

F2k: koszt dla poprawnych zamkniętych pending kopii, bez napraw i GC payloadu,
to jeden skan: `3 + B` wywołań adaptera na kopię (stat/list manifestów, readBinary
najnowszego manifestu, B odczytów blobów), plus 4 stałe operacje albo 5 z pustym
stagingiem. Zastępuje dawny wzór `9 + 3B` plus 10/11 operacji stałych.
B obejmuje firstTouches, propozycje i recoveryBlob. Dwie kopie zmieniające tekst
(B=2 każda) kosztują teraz 15 zamiast 41 operacji, a jedna propozycja nowego pliku
9 zamiast 23. Pusty mobilny namespace nadal kosztuje jeden stat.
Pokwitowania dodatkowo wymagają rozpoznania układu i inwentarza do bezpiecznego GC
po przerwaniu; wszystko należy do tego samego skanu. Dla jednego manifestu,
pustych blobs i braku decisions koszt marginalny wynosi 7 operacji adaptera
(4 wywołania portu). 1/20 pokwitowań: 12/145 zamiast 25/291 operacji adaptera,
5/81 zamiast 13/184 wywołań portu obu platform. Więcej zachowanego payloadu,
recoveryBlob i napraw zwiększa koszt. SHA-256 nadal czyta pełne bajty w RAM.

Do prób wyłącznie na fizycznym telefonie pozostają:

- ubicie aplikacji w trakcie writeBinary/rename i przyjęcia zmiany, potem restart;
- rename na Androidzie: awaria przed/po przeniesieniu i widoczność ukrytych katalogów;
- duże pliki i magazyny: czas startu, pamięć WebView, odzyskiwanie po przerwaniu;
- rzeczywista obsługa dotykiem okien decyzji i wyłączenie innych synchronizatorów.
Test adaptera pamięciowego nie potwierdza trwałości CapacitorAdapter ani fsync.

## Mobile M4 F2g - synchroniczny indeks hosta i tani listing

Barrel eksportuje typy `DraftFileIndex` oraz `DraftIndexEntry` (unia file/folder).
Opcjonalne `DraftViewIO.index` jest przekazywane przez getter `DraftView.index`;
moduł nie importuje runtime Obsidiana. Port get/files oraz leniwe children dostarcza
moduł tools z indeksu app.vault na obu platformach. Host bez tego portu zachowuje
historyczne skanowanie jako fallback wyłącznie dla starszego DI.

`resolvedChanges()` buduje jedną projekcję grafu zmian z jednego snapshotu własnej
kopii i indeksów zamrożonych poprzedników. Od F2i host odtwarza z niej i całego
indeksu bazowego migawkę przez historyczny algorytm list/stat/walk w pamięci,
bez enumeracji adaptera. Odświeża ją przy utworzeniu i po udanym write/mkdir,
a błędna operacja zachowuje poprzednią migawkę. Bliższe warstwy, identyczne
propozycje, niejednoznaczności i tombstones zachowują reguły resolve.

`DraftView.list(folder)` bierze rodzaj bazowych dzieci z portu list, bez stat dla
każdego dziecka. Dla istniejącego folderu wykonuje jeden stat i jeden list, dla
roota sam list, dla nieistniejącego folderu sam stat. Potem nakłada zmiany i sortuje
jak wcześniej; prywatny namespace nigdy nie trafia do widoku. Kontrakt DraftViewIO
wymaga pełnych ścieżek logicznych bezpośrednich dzieci, nie samych nazw (inaczej niż
DraftStorageIO). Niepoprawny wpis nadal daje invalid-path. Nie weryfikujemy ponownie
rodzaju każdego dziecka osobnym stat: od F2g rodzaj wpisu pochodzi z listingu portu,
również gdy listing i stat adaptera podają sprzeczne rodzaje.

Synchroniczne istnienie i metadane hosta mogą minimalnie odbiegać od dysku przed
odświeżeniem indeksu Obsidiana. Zwykły odczyt bajtów bazowego pliku wykonuje jeden
read portu vaulta, bez stat. Przechwycenie bazy przy pierwszym dotknięciu oraz
kontrole integralności bazy podczas przeglądu zachowują adapterowe stat -> bajty -> stat.
Nie zmienia się format, trwałość, DraftStore, host review ani decyzje przeglądu.
Leniwe przygotowanie ukrytych celów i ograniczenie metadanych artefaktów opisuje
`../tools/CLAUDE.md`. Testy: F2g w subToolExecution.test.ts i runnerDrafts.test.ts.

Testy offline mierzą liczbę wywołań, nie opóźnienia CapacitorAdapter. Nadal potrzebna
jest próba pełnej delegacji i przyjęcia na Androidzie oraz kontrola desktopowa
w rzeczywistym Obsidianie; iOS, ubicie procesu i trwałość adaptera pozostają ograniczeniami F2a.

F2i usuwa przyrostowe księgowanie hosta w tools. CPU/RAM projekcji zależy od
rozmiaru indeksu, ale liczba wywołań adaptera pozostaje niezależna od niego.
`tools/draftHostProjection.test.ts` porównuje 500 sekwencji z niezależnym listingiem
f5f13b6 ze stat per dziecko, również po odmowach i ponownym utworzeniu hosta.
Pięć literalnych reprodukcji, test granic migawki i pomiar indeksu 20000/3700
uzupełniają niezmienione liczniki i zachowania F2g/F2h.

F2j dodaje `DraftView.statBase(path): Promise<VaultStat>`: waliduje logiczną
ścieżkę przez parseVaultPath i wywołuje wyłącznie stat portu vaulta. Wynik nie
zawiera propozycji ani rodziców implicit. Host używa tej metody przy każdym
odświeżeniu wyłącznie dla zarejestrowanych ukrytych celów i ich ukrytych rodziców,
a następnie nakłada bieżące resolvedChanges. Zapobiega traktowaniu anulowanej
propozycji jako bazy i odświeża stat po zewnętrznej zmianie ukrytego pliku.
Nie zmienia stat/read/mutate, przechwycenia first-touch ani formatu magazynu.
Testy dwóch hostów, metadanych oraz kosztu przygotowanych celów opisuje
`../tools/CLAUDE.md`, sekcja F2j. Ograniczenia prób na urządzeniu pozostają aktualne.


## Mobile M4 F2k - jeden skan, zdarzenia i wygaśnięcie pokwitowań

Zmiana obejmuje obie platformy. `collectResolved` wykonuje najwyżej jeden
`loadAll`; skan zawiera też inwentarz i zweryfikowane hashe kandydatów na sieroty.
Dopiero zakończony, czysty skan dopuszcza usuwanie. Problemy restore blokują GC
przez cały runtime; problemy późniejszego skanu blokują jego przebieg.
Nieznany układ pozostaje nietknięty. Skan restore jest jednorazowo przekazywany
do początkowego GC. Licznik zapisów persistence unieważnia go po zapisie wykonanym między
skanem a GC; własne naprawy restore są zaufane, a ich ID pozostają chronione.
Namespace ma jednego właściciela, jak dotąd: nie gwarantujemy ochrony przed
zewnętrznym procesem zapisującym poza portem.

Przed usuwaniem każdej kopii ponownie sprawdzamy stan w kolejce publikacji,
referencje oraz opcjonalny `isProtected(manifest)` dostarczony przez runtime
(dla biegu waiting/running, planu z takim biegiem lub niezamkniętego wątku).
Runtime współdzieli reguły planu i wątku z retencją payloadu. `collecting` blokuje nową retencję
w trakcie usuwania. Sieroty sprawdzają żywe ID przy każdej operacji; katalog
bez manifestu powstały w bieżącym store pozostaje chroniony jego wpisem aż do
restartu. Persistence pamięta możliwe sieroty po próbach zapisu blobów.
Bez kandydata w RAM, ponowienia nieudanego GC ani niechronionej sieroty nie ma I/O.
Udane GC nie przegląda ponownie zebranych pokwitowań po każdym zdarzeniu.

**Decyzja Kuby z 16.11.2026:** stała `RECEIPT_RETENTION_MS` to 30 dni.
Tylko pierwsze sprzątanie po restore może wygasić pokwitowanie: musi mieć
payloadCollected, sealed, wyłącznie accepted/rejected, brak referencji w RAM,
żywego biegu/planu oraz niezamkniętego wątku, rozpoznany układ, czysty skan
oraz updatedAt starsze niż 30 dni. F2l dodatkowo chroni trwałe referencje:
każde inheritedFrom w pozostającym manifeście chroni poprzednika i jego przodków.
Graf powstaje w RAM ze wszystkich manifestów tego samego skanu, bez dodatkowego I/O.
Usuwamy najpierw kopie bez wskazujących je następników; dopiero skuteczne usunięcie
zwalnia ich krawędzie. Stary rozstrzygnięty łańcuch może zniknąć w jednym przebiegu,
ale pending, świeża kopia, nierozpoznany układ lub inna ochrona następników zachowuje
cały wskazywany łańcuch. Cykl referencji pozostaje chroniony. Awaria przerywa przebieg
przed usunięciem poprzedników pozostającego manifestu. Start nadal poprzedza admisję biegów.
Dokładnie 30 dni, czas z przyszłości i zegar wcześniejszy od createdAt/updatedAt
nie kwalifikują kopii. Nie ma TTL nierozstrzygniętych zmian ani applying/recovery-required.
Accepted po operacji destrukcyjnej zachowuje recoveryBlob: taki katalog nie wygasa
nigdy, nawet po zebraniu reszty payloadu. Nie zmieniamy manifestów ani blobów.
Po wygaśnięciu list pomija kopię, a accept/reject zwracają dawną odmowę nieznanego ID.

Usuwanie jest sekwencyjne przez istniejące `DraftStorageIO.remove`, teraz również
dla pustego katalogu. Desktop używa rmdirSync, mobile opcjonalnego adapter.rmdir
z recursive=false i wcześniejszą kontrolą pustki; brak zdolności odmawia usuwiania
katalogu. Nie ma rekursywnego kasowania. Najpierw usuwamy payload, decyzje i starsze
manifesty, potem puste blobs/decisions, najnowsze pokwitowanie jako ostatni plik,
a na końcu puste manifests i katalog kopii. Przerwanie przed pokwitowaniem zostawia
je do ponowienia; po nim zostają tylko puste, rozpoznane katalogi, kończone przez
orphan GC. Błąd odczytu lub nieznany układ daje issue albo zachowanie katalogu.

Testy `DraftStore.gc.test.ts` uruchamiają obie implementacje portu: 29/30/31 dni,
100-dniowe pending/applying/recovery-required, ochronę referencji i recoveryBlob,
cofnięty zegar, nieznany układ i błędy skanu, unieważnienie skanu po zapisie,
żywy zapis podczas GC oraz restart po każdej z 7 operacji usuwania pliku i 4
usuwania katalogu. Lista plików po accept/release została odtworzona na 39e588b:
zostaje wyłącznie manifests/000005.json. `DraftStorage.contract.test.ts` sprawdza
odmowę usunięcia niepustego katalogu i idempotentne usunięcie pustego na obu portach.
Testy runtime i runnera z licznikami opisuje `../tools/CLAUDE.md`.
F2l w `DraftStore.gc.test.ts` sprawdza na obu portach dwa restarty parent/child,
łańcuch A <- B <- C (C pending, wszystkie stare, B świeże), przerwanie usuwania
łańcucha oraz createdAt=60/updatedAt=90 przy dniu 100. Odwrotne znaczniki
createdAt=90/updatedAt=69 naruszają istniejący walidator: zapis odmawia, a obcy
manifest z takim układem powoduje issue i blokuje GC. Nie osłabiamy walidacji czasu.
Liczniki F2k pozostają bez zmian: start 1/20 pokwitowań to 5/81 operacji portu
oraz 12/145 adaptera mobile; delegacja 11/11 portu i 54/54 adaptera mobile.
Testy offline nie dowodzą trwałości rmdir/rename ani czasu I/O na Androidzie/iOS.
