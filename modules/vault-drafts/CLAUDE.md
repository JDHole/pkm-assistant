# modules/vault-drafts/

P1–P5 wersji 2.4.7: trwały magazyn, warstwowy widok i przegląd kopii roboczych.
Runtime odtwarza magazyn przed rejestracją delegacji. Nie importuje Obsidiana, runnera, czatu ani MCPClient.
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
- `DraftStore.test.ts`: AVA, odczyty faktycznie zapisanych bajtów przez nową instancję,
  awarie i bariery sterujące wyścigami; bez Obsidiana i rzeczywistych timerów.

## Publiczne API (`index.ts`)

`DraftStore(persistence, vaultIO, clock)`:

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
- `restore()`: na świeżym magazynie, przed dopuszczeniem biegów. Zwraca `{drafts, issues}`.
  Zamyka `open` jako `sealed/restart`, zmienia `applying` na `recovery-required`.
  Nie uruchamia pracy, zgód ani zapisów do vaulta. Błąd utrwalenia restore odrzuca Promise.

`DraftPersistence(storageIO, hasher)` udostępnia `putBlob`, `readBlob`, `hash`,
`hasDraft`, `save`, `writeIntent`, `loadAll`. `save` jest niskopoziomowym API dla zaufanego store/review;
nie udostępniać go narzędziom modelu. `readBlob` sprawdza długość i SHA-256.
Barrel eksportuje też typy, `DraftError` z `code`, `DRAFT_ROOT` i fabryki
`parseDraftId/ChangeId/BlobId/ContentHash/Revision/VaultPath/DraftManifest/DraftMutation`.

## Trwałość i granica adaptera

Zapis wyłącznie pod `.pkm-assistant/subagent-drafts/v1/<draftId>/`:
`blobs/<sha256>`, `manifests/000001.json`, `000002.json`, itd., oraz `decisions/<attemptId>.json`. Nazwa bloba nie zawiera
ścieżki użytkownika; runId/threadId są tylko metadanymi. Rewizja treści rośnie przy
mutacji; generacja manifestu również przy seal/restore. Manifest jest opakowany jako
`{payload: string, checksum: SHA256(payload)}`. Starsze generacje są zachowane.

Port `DraftStorageIO.publish` jest **atomową, create-only publikacją**, nie zwykłym
`adapter.write`: musi ocenić `mayPublish` w punkcie publikacji bez asynchronicznej
przerwy i zwrócić `cancelled` bez widocznej generacji, jeżeli zamknięto kopię.
Odrzucenie oznacza brak publikacji, sukces — trwałe, odczytywalne bajty. Przygotowanie
pliku tymczasowego może być asynchroniczne; punkt publikacji musi spełniać ten kontrakt.
Adapter desktopowy P5 realizuje ten kontrakt synchroniczną publikacją przez hard link. Nie wolno zastąpić tego
portu sekwencją „sprawdź flagę → await write”; zgubiłaby ochronę przed późnym zapisem.
P1 testuje oba momenty Stopu: podczas bloba oraz przed atomową publikacją manifestu.
Jeden aktywny store jest właścicielem namespace; równoległe procesy zapisujące ten sam
DraftId wymagają blokady po stronie adaptera. `publish` nie nadpisuje istniejącej nazwy.

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
Obsidiana desktop (plugin ma `isDesktopOnly`). Node jest wstrzykiwany jako wąska
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
