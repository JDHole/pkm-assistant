# modules/vault-drafts/

P1 wersji 2.4.7: kontrakt i trwały magazyn kopii roboczych. Moduł nie jest jeszcze
podłączony do runtime. Nie importuje Obsidiana, runnera, czatu ani MCPClient.
Nie ma żadnego portu zapisu treści do bazowego vaulta.

Pięć plików produkcyjnych ma jawne, tymczasowe wpisy w `ZNANE_SIEROTY` w
`core/dead_code_zasieg.test.ts`: architektura §11 wymaga braku aktywacji P1–P4.
Przy podłączeniu do grafu runtime (P5) usunąć odpowiadające wpisy; strażnik nadal
porównuje dokładny zestaw sierot i wykrywa zarówno nowe, jak i nieaktualne wpisy.

## Co tu mieszka

- `types.ts`: brandy, rozłączne stany plików/propozycji/przeglądu/fazy, manifest,
  błędy domenowe i porty I/O, zegara oraz SHA-256.
- `schema.ts`: walidacja przez `@cfworker/json-schema`, fabryki brandów,
  walidacja manifestu i mutacji na granicy `unknown`.
- `DraftPersistence.ts`: bloby adresowane hashem oraz kolejne generacje manifestów,
  suma SHA-256 manifestu, odczyt kontrolny, skan odzyskiwania.
- `DraftStore.ts`: leniwe kopie, pierwsza baza, kolejki ścieżek, serializacja publikacji
  całego manifestu, `open → sealed`, odtworzenie po restarcie.
- `DraftStore.test.ts`: AVA, odczyty faktycznie zapisanych bajtów przez nową instancję,
  awarie i bariery sterujące wyścigami; bez Obsidiana i rzeczywistych timerów.

## Publiczne API (`index.ts`)

`DraftStore(persistence, vaultIO, clock)`:

- `create(identity: unknown)`: waliduje właściciela (agentName, sessionPath,
  sessionEpoch), draftId, runId, threadId i opcjonalny planId/nodeId. Nie tworzy plików.
  ID dostarcza zaufany runtime; nie wolno używać do tego argumentów modelu.
- `mutate(draftId, {path, source: {tool, callId}, value})`: tekst, bajty, folder albo
  tombstone z dyspozycją trash/permanent. Zwraca trwały snapshot manifestu.
- `snapshot(draftId)`, `list()`: niezależne kopie danych; to wewnętrzne API, nie
  autoryzowane narzędzie prowadzącego. Własność i zakres dostępu egzekwuje przyszłe P4.
- `seal(draftId, reason)`: synchronicznie odbiera prawo mutacji/publikacji; Promise
  potwierdza trwałe zamknięcie. Powtórzenie zachowuje pierwszą utrwaloną przyczynę.
  Po błędzie zapisu kopia pozostaje zablokowana w RAM; `seal` można ponowić.
- `restore()`: na świeżym magazynie, przed dopuszczeniem biegów. Zwraca `{drafts, issues}`.
  Zamyka `open` jako `sealed/restart`, zmienia `applying` na `recovery-required`.
  Nie uruchamia pracy, zgód ani zapisów do vaulta. Błąd utrwalenia restore odrzuca Promise.

`DraftPersistence(storageIO, hasher)` udostępnia `putBlob`, `readBlob`, `hash`,
`hasDraft`, `save`, `loadAll`. `save` jest niskopoziomowym API dla zaufanego store/review;
nie udostępniać go narzędziom modelu. `readBlob` sprawdza długość i SHA-256.
Barrel eksportuje też typy, `DraftError` z `code`, `DRAFT_ROOT` i fabryki
`parseDraftId/ChangeId/BlobId/ContentHash/Revision/VaultPath/DraftManifest/DraftMutation`.

## Trwałość i granica adaptera

Zapis wyłącznie pod `.pkm-assistant/subagent-drafts/v1/<draftId>/`:
`blobs/<sha256>` i `manifests/000001.json`, `000002.json`, itd. Nazwa bloba nie zawiera
ścieżki użytkownika; runId/threadId są tylko metadanymi. Rewizja treści rośnie przy
mutacji; generacja manifestu również przy seal/restore. Manifest jest opakowany jako
`{payload: string, checksum: SHA256(payload)}`. Starsze generacje są zachowane.

Port `DraftStorageIO.publish` jest **atomową, create-only publikacją**, nie zwykłym
`adapter.write`: musi ocenić `mayPublish` w punkcie publikacji bez asynchronicznej
przerwy i zwrócić `cancelled` bez widocznej generacji, jeżeli zamknięto kopię.
Odrzucenie oznacza brak publikacji, sukces — trwałe, odczytywalne bajty. Przygotowanie
pliku tymczasowego może być asynchroniczne; punkt publikacji musi spełniać ten kontrakt.
Adapter hosta zostanie dostarczony w następnych paczkach. Nie wolno zastąpić tego
portu sekwencją „sprawdź flagę → await write”; zgubiłaby ochronę przed późnym zapisem.
P1 testuje oba momenty Stopu: podczas bloba oraz przed atomową publikacją manifestu.
Jeden aktywny store jest właścicielem namespace; równoległe procesy zapisujące ten sam
DraftId wymagają blokady po stronie adaptera. `publish` nie nadpisuje istniejącej nazwy.

Port vaulta ma tylko `stat/read`. Baza powstaje przy pierwszej mutacji przez
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
Nie ma GC ani TTL; dane i referencje zachowujemy dla następnych paczek.

## Następne paczki

P2 dostarczy widok, warstwy i pochodzenie odziedziczonych zmian (`inheritedFrom` jest
na razie puste). Musi zachować bazę poprzednika przy pierwszej mutacji pochodnej;
nie może zastąpić jej świeżą bazą vaulta. Techniczne katalogi nadrzędne tworzy adapter
przy przyjęciu, jawny folder jest osobną zmianą. `source` łączy pliki jednego wywołania
oraz zachowuje narzędzie źródłowe dla kontroli uprawnień P4.

P3 wiąże store z biegiem i Stopem; P4 implementuje decyzje, blokady logicznych ścieżek,
kontrolę konfliktu, intencje i idempotencję. Same typy stanów przeglądu nie oznaczają
implementacji przyjęcia. P5 dostarczy adaptery, rejestrację, zdarzenia i retencję.
Przed aktywacją konieczna jest weryfikacja kontraktu atomowej publikacji na hoście.
