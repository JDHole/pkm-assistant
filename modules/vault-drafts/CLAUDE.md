# modules/vault-drafts/

P1–P2 wersji 2.4.7: trwały magazyn i warstwowy widok kopii roboczych. Moduł nie jest jeszcze
podłączony do runtime. Nie importuje Obsidiana, runnera, czatu ani MCPClient.
Nie ma żadnego portu zapisu treści do bazowego vaulta.

Pliki są osiągalne statycznie przez barrel `tools/index.ts` (P2), a od P3 runner tworzy widok/host wyłącznie po jawnym wstrzyknięciu
`SubRunDrafts`. Produkcyjny runtime nadal go nie tworzy. Dlatego usunięto pięć nieaktualnych
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

P3 wiąże store z biegiem i Stopem przez opcjonalny `SubRunDrafts` w module sub-agents; P4 implementuje decyzje, blokady logicznych ścieżek,
kontrolę konfliktu, intencje i idempotencję. Same typy stanów przeglądu nie oznaczają
implementacji przyjęcia. P5 dostarczy adaptery, rejestrację, zdarzenia i retencję.
Przed aktywacją konieczna jest weryfikacja kontraktu atomowej publikacji na hoście.
