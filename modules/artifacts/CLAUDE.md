# modules/artifacts/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Artefakty żywe (E2.9).** Obiekty współtworzone user↔agent, gdzie **notatka vaulta JEST źródłem prawdy** (frontmatter + treść). Agent nigdy nie czyta surowego markdownu (dostaje sparsowany chudy JSON) ani go nie pisze (patch strukturalny na świeżym stanie). Plus **gatunek 2 — `todo`**: prymitywna jednorazówka agenta w `.pkm-assistant/`, live-widok w czacie.

**Status:** 🚀 ACTIVE. Przebudowa E2.9 (2026-07-23): stary świat (JSON `ArtifactManager` + `PlanReviewModal`/`ProgressModal`) SKASOWANY, silnik wymieniony na notatki.

## Dwa gatunki (A1/A13)

| Gatunek | Co to | Gdzie żyje | Narzędzia |
|---|---|---|---|
| **1 — artefakt żywy** | notatka współtworzona z userem (plan, notatka) z approval flow (guziki w notatce) | widoczny folder vaulta (`settings.pkmAssistant.artifactsFolder`, default `PKM Assistant/Artefakty/<agent>/`) | `artifact_create/read/update/list` |
| **2 — todo** | prywatna lista zadań agenta, jednorazówka „na oczach" | ukryty `.pkm-assistant/artifacts/todo/<agent>-<sessionId>.md` | `todo` (create/check/uncheck/add/finish) |

Wspólny silnik (parser/patcher), osobne interfejsy — „wspólna mechanika, nie sklejanie gatunków" (F4).

## Co tu jest

```
modules/artifacts/
├── artifactParser.js         # PURE parser + patcher (parseArtifact/applyPatch) + `validateArtifactBodyText` — JEDYNA bramka treści agenta (code-fence/HTML/nagłówki) + protected keys
├── ArtifactTypeLoader.js     # biblioteka TYPÓW (.pkm-assistant/artifacts/types/*.md); seed plan + notatka
├── ArtifactStore.js          # CRUD instancji jako notatek vaulta (create/read/update/list/move/remove/archive/importInstance)
├── artifactButtons.js        # computeArtifactButtons (guziki wg statusu instancji + statusy typu)
├── artifactSummon.js         # przywołanie agenta (buildSummonMessage + summonAgentForArtifact) + ciche przypięcie (activateArtifactInChat)
├── artifactBlocks.js         # registerMarkdownCodeBlockProcessor('pkm-artefakt') — render guzików w notatce + `isBlockBoundToNote` (blok żyje tylko w swojej notatce)
├── artifactViewHelpers.js    # PURE helpery UI (sort/picker/typy) dla panelu + slim bara
├── basesView.js              # S32 Z7 — PURE generator pliku `.base` (Obsidian Bases): 2 widoki table
├── migrate_json_to_notes.js  # D4 — jednorazowy migrator starych JSONów → notatki (idempotentny)
├── types.js                  # tylko typy (ArtifactFrontmatter/ArtifactItem/ArtifactSection/ParsedArtifact/ArtifactType/...) — zero runtime, re-eksportowane przez barrel jako `export type`
├── index.js                  # barrel
└── *.test.js
```

## Public API (`index.js`) — 16 eksportów (po przycince S30 Z4 + Bases z S32 + N2; zmierzone 2026-08-27 z bloków `export { ... } from` w index.ts, bez `export type`)

- `parseArtifact`, `applyPatch` — silnik (pure)
- `ArtifactTypeLoader` — biblioteka typów
- `ArtifactStore`, `DEFAULT_ARTIFACTS_FOLDER` — CRUD instancji jako notatek vaulta + domyślny folder
- `summonAgentForArtifact` — przywołanie agenta po interakcji z notatką (ustawia aktywny + WYSYŁA stan)
- `activateArtifactInChat` — ciche przypięcie artefaktu do rozmowy (ustawia aktywny, **zero wysyłki**); wołacz: klik w pickerze slim bara
- `registerArtifactBlocks` — rejestracja code-blocku `pkm-artefakt` (guziki w notatce)
- `sortArtifactsForView`, `buildArtifactPickerItems`, `toggleTypeName`, `buildTypeCheckboxRows` — pure helpery widoku
- `buildArtifactsBaseContent`, `buildArtifactsBasePath`, `ARTIFACTS_BASE_FILENAME` — S32 Z7, widok Bases
- `migrateJsonArtifactsToNotes` — jednorazowy migrator (D4)

> **S30 Z4 — 18 eksportów WYCIĘTYCH z barrela** (zero konsumentów spoza modułu):
> `PROTECTED_FIELDS`, `ARTIFACT_CONTEXT_MAX_CHARS`, `ARTIFACT_TYPES_PATH`, `DEFAULT_STATUSY`,
> `BUILTIN_PLAN_TYPE_NAME`/`BUILTIN_NOTATKA_TYPE_NAME`/`BUILTIN_RAPORT_TYPE_NAME`/
> `BUILTIN_TYPE_NAMES`, `PLAN_TYPE_CONTENT`/`NOTATKA_TYPE_CONTENT`/`RAPORT_TYPE_CONTENT`,
> `DEFAULT_ARTIFACTS_FOLDER`, `ARCHIVE_SUBFOLDER`, `computeArtifactButtons`, `isClosedStatus`,
> `CLOSED_STATUS`, `buildSummonMessage`, `parseArtifactBlockId`.
> **Definicje ŻYJĄ w bebechach** — stałe typów czyta `ArtifactTypeLoader` przy seedowaniu,
> guziki liczy `artifactBlocks.js` przy renderze code-blocku, `buildSummonMessage` woła
> `summonAgentForArtifact` u siebie, a testy deep-importują pliki wprost.
>
> **Wyjątek — `BUILTIN_TYPE_NAMES`.** Zdanie „testy deep-importują pliki wprost" nie było dla
> tej jednej nazwy prawdziwe: `ArtifactTypeLoader.test.ts` importuje `ARTIFACT_TYPES_PATH`,
> `DEFAULT_STATUSY`, `PLAN_/NOTATKA_/RAPORT_TYPE_CONTENT`, ale żadnego `BUILTIN_*`. Fabryka
> dead-code D7 (2026-09-02, AUD-dead-code-077) zdjęła z niej sam `export` — jedyny czytelnik
> zostaje `ArtifactTypeLoader.ts` u siebie (seedowanie flagi `builtin` na wpisie typu).

> **Narzędzie `todo`** żyje w `modules/tools/built-in-servers/artifacts/TodoTool.js` (nie tutaj) — jest MCP toolem, nie częścią silnika. **Sprostowanie (S30 Z4): NIE deep-importuje** `artifactParser.js` — bierze `parseArtifact`/`applyPatch` przez TEN barrel (`../../../artifacts/index.js`). Dlatego oba zostają w powierzchni publicznej.

## Typy artefaktów (A4/A5)

Typ = plik `.pkm-assistant/artifacts/types/<nazwa>.md`: frontmatter meta (`nazwa`, `opis`, `pola{opis[,domyslne]}`, `statusy[]`, `sprzatanie` dni) + body = szablon ciała (placeholdery `{{pole}}`). Body szablonu jest **nieprzezroczysty** — user może w nim mieć dataviewjs (A3). **Trzy typy wbudowane** seedowane przy starcie: **`plan`** (Cel/Kroki/Ryzyka/Uwagi usera) + **`notatka`** (Treść/Uwagi usera — pokrywa dawny idea_review) + **`raport`** (E3.5 Deep Research: TL;DR/Ustalenia/**Białe plamy**/Źródła/Uwagi usera — sekcja
„Białe plamy" dołożona po biegu live Poligonu F2, bo przepis deep-research jej żądał, a typ jej
nie miał; ISTNIEJĄCE vaulty jej NIE dostaną (`ensureBuiltinTypes` nie nadpisuje plików usera),
dlatego przepisy mają fallback na podsekcję `### Białe plamy` w „Ustaleniach"; pola `pytanie`+`tryb`; statusy `[w-trakcie, gotowy, zamkniety]` — bez approval flow, raport się CZYTA; `sprzatanie: 0` — raporty się nie przedawniają; `w-trakcie`/`gotowy` dostają generyczny guzik „Przywołaj agenta" = żywy raport). Podpinane per agent przez `artifact_types:` w YAML. **Lista działa na dwie strony (S32 Z5):** widoczność w indeksie promptu (brak/pusta = agent widzi tylko `plan`) ORAZ egzekwowanie przy tworzeniu — `artifact_create` z typem spoza NIEPUSTEJ listy dostaje odmowę (`mcp.artifact.type_not_allowed`). **Pusta/nieustawiona lista = wszystkie typy z biblioteki wolno** (egzekwowanie jest opt-in, zero regresji dla istniejących profili) — dzięki temu przepisy deep-research nadal podają `typ:"raport"` explicite u agenta bez podpięć.

## Kluczowe decyzje

- **Notatka = źródło prawdy (A2).** Zero „osobny YAML + kopiowanie". Frontmatter (to JEST YAML) + treść w jednym pliku. Śledzenie po frontmatterze `pkm-artefakt`, NIE po ścieżce (A16 — przenosiny notatki nic nie psują).
- **Agent NIGDY nie pisze bloków kodu w artefaktach (A3).** Egzekwowane W SILNIKU, nie tylko w prompcie — jednym predykatem `validateArtifactBodyText` (K10), który obsługuje `applyPatch` (`code_forbidden`) ORAZ wartości `pola` przy `create`. Liczy grawisy, tyldy i surowy HTML (`<pre>`/`<code>`/`<script>`). Kod pochodzi wyłącznie z szablonów typów autorstwa usera. Zamyka wektor prompt-injection → wykonanie JS. **Wyjątek:** `ArtifactStore.importInstance` (migrator D4) wstawia body verbatim — to zachowanie ISTNIEJĄCEJ treści usera, nie pisanie przez agenta.
- **Agent NIGDY nie pisze nagłówków poziomu 1-2 w treści (`heading_forbidden`, Poligon F2).**
  `set_section` i `add_item` odrzucają tekst z linią `# `/`## `, bo te poziomy tworzą sekcje:
  wpisane do TREŚCI robią drugi nagłówek o tej samej nazwie, a `findSection` zwraca PIERWSZE
  trafienie → oryginalna sekcja zostaje osierocona na zawsze (kolejne patche trafiają
  w podrobioną). **`###` i głębsze są DOZWOLONE** — model legalnie używa ich jako podtytułów
  wewnątrz sekcji. Bramka i zlew liczą nagłówki JEDNĄ funkcją `scanSectionHeadings` (M — patrz
  gotcha niżej); rozjazd tych dwóch stron = dziura.
- **`create` raportuje wynik patcha tak samo jak `update`.** Zwraca `{created, id, path, applied, errors, artifact}` (`created:false` = K10, odmowa bramki pól JESZCZE PRZED zapisem, pusty `id`) — początkowe `sekcje` idą przez `applyPatch` i jego `applied`/`errors` jadą do wołacza. Wcześniej `create` brał z patcha samo `.markdown`, więc `set_section` z nagłówkiem spoza szablonu typu wracał jako cichy `not_found`: narzędzie mówiło `ok:true`, a artefakt wychodził pustym szablonem. Bez sekcji → `applied: 0`, `errors: []`.
- **Klucze frontmattera PO POLSKU (A6):** `pkm-artefakt`/`typ`/`agent`/`status`/`utworzono`/`zaktualizowano` + pola typu. Klucze bazowe NIEZMIENIALNE (`protected_key`).
- **Block-idy jako stabilne adresy (A15):** checkboxy dostają `^k1` — patch po block-idzie, nie po kruchym indeksie.
- **Todo default ON (D1):** `todo` to wyjątek z grupy `artifacts` w `toolAxis` (`DEFAULT_ENABLED_EXCEPTIONS`) — pisze tylko do ukrytego `.pkm-assistant/`, nie do widocznego vaulta usera. `artifact_*` zostają OFF konserwatywnie.

## S32 Z7: widok Bases

Komenda **„Wygeneruj widok Bases artefaktów"** (`generate-artifacts-base`, handler `generate_artifacts_base()` w `src/main.ts`) tworzy plik `<folder artefaktów>/Artefakty.base` z **dwoma widokami `type: table`**:

- **„Wszystkie"** — filtry `file.inFolder("<folder>")` + `!note["pkm-artefakt"].isEmpty()` (drugi filtr odsiewa cudze notatki i sam plik `.base`); kolumny `file.name, typ, agent, status, utworzono, zaktualizowano`; sort `zaktualizowano DESC`.
- **„Otwarte"** — jak wyżej + `note["status"] != "zamkniety"`.

Generator to pure `basesView.js` (`buildArtifactsBaseContent(folder)` + `buildArtifactsBasePath(folder)`), YAML składany **ręcznie jako template string, NIE przez `stringifyYaml`** — kolejność kluczy i styl mają być czytelne dla usera, który potem klika ten plik w GUI Bases. Pełna treść jest zamrożona snapshotem w `basesView.test.js` (kontrakt formatu).

**Decyzje:**
- **Sesje poza zasięgiem.** Archiwum sesji żyje w ukrytym `.pkm-assistant/`, którego Obsidian nie indeksuje → Bases go fizycznie nie widzi. Widok obejmuje TYLKO artefakty (gatunek 1, widoczny folder vaulta). Żadnego dashboardu-notatki jako fallbacku nie ma — Bases jest dostępne.
- **Nie nadpisujemy.** Jeżeli plik już istnieje → Notice „usuń go, żeby wygenerować od nowa" i STOP; user mógł widok dostosować w GUI.
- **Archiwum artefaktów wpada do widoku** — `file.inFolder` łapie podfoldery per agent ORAZ `_archiwum`. Świadomie: archiwalny artefakt to nadal artefakt (i ma status `zamkniety`, więc w „Otwartych" go nie ma).
- **`properties: file.name → displayName: Notatka`** — jedyny displayName, bo pozostałe klucze frontmattera są już po polsku (A6).

## Gotchas

- ⚠️ **K10 (2026-08-22): JEDEN walidator dla KAŻDEGO wejścia treści agenta.**
  `validateArtifactBodyText` (`artifactParser.js`) to jedyne miejsce, w którym stoi reguła
  „co agent może wpisać do ciała artefaktu" (fence kodu ``` / `~~~` / `<pre>`/`<code>`/`<script>`
  + nagłówki `#`/`##`). Wołają go OBA wejścia: opsy patcha (`set_section`/`add_item`) **oraz**
  wartości `pola` przy `create` — przez `ArtifactStore.applyFieldsValidated`. Przed K10 `pola`
  szły surowym `String(v)` do `substitutePlaceholders`, więc `artifact_create` był drugą,
  niepilnowaną drogą zapisu treści (AUD-security-061). **Dokładając NOWĄ drogę pisania do ciała
  instancji, przepuść ją przez ten sam predykat — nie dopisuj drugiego regexa.**
  Odmowa pola jest **fail-closed**: `create` zwraca `created:false` i NIE tworzy pliku (odmowa
  `sekcje` działa inaczej — nota powstaje, a błąd wraca w `errors`, bo opsy są niezależne).
  Treść USERA (szablon typu, `domyslne` pól, `importInstance` migratora) bramce NIE podlega (A3).
  Świadomie NIE liczymy wciętego bloku kodu (4 spacje/tab) — tak wygląda zagnieżdżona lista.
- ⚠️ **K10 (2026-08-22): blok `pkm-artefakt` działa TYLKO w swojej notatce.**
  Procesor jest zarejestrowany globalnie (`src/main.js`) i bierze `id` z TREŚCI bloku, więc bez
  tego warunku blok podłożony w cudzej notatce dawał działające guziki cudzego artefaktu
  (AUD-security-063). `isBlockBoundToNote(id, ctx.sourcePath, store)` porównuje ścieżkę
  renderowanego pliku ze ścieżką artefaktu z **jednego** źródła prawdy (`store.pathById`, to samo,
  którego używa bramka uprawnień), po ścieżce kanonicznej. Niezwiązany blok = render martwy
  z `artifact.block.foreign`, **przed** `store.read` (żeby nie wyciekł nawet status). Brak
  `sourcePath` / store'a / nieznane id = też martwy (fail-closed).
- ⚠️ **K2 (2026-08-22): artefakt ŻYJE W FOLDERZE ARTEFAKTÓW — inaczej dla silnika nie istnieje.**
  `_findFileById` i `list()` filtrują OBA przejścia do roota (wcześniej filtr miał tylko fallback,
  więc `artifact_read`/`artifact_update` sięgały do dowolnej notatki z kluczem `pkm-artefakt`, także
  w No-Go), a `move()` odmawia przenosin poza root. A16 („przenosiny nic nie psują") obowiązuje
  dalej WEWNĄTRZ folderu — tropimy po frontmatterze, nie po dokładnej ścieżce.
- ⚠️ **AUD-wydajnosc-059/030/021/051/060/031/104/106 (2026-09-02, fabryka W2): `list()`/`pathById()`
  NIE skanują `vault.getMarkdownFiles()` na każde wywołanie — czytają REJESTR.**
  Do tej naprawy `list()` przechodziło CAŁY vault (`getMarkdownFiles()` + `_isUnderRoot` per plik,
  a ten liczył `sanitizePath(root)` OD NOWA per plik — 106) na KAŻDĄ turę czatu (`_buildBaseContext`
  woła `store.list()`), przy każdym `artifact_list`, przy chipie artefaktu w czacie i przy każdym
  renderze pickera; `pathById`/`_findFileById` dla NIEISTNIEJĄCEGO id (halucynacja modelu, artefakt
  skasowany) robiły to samo od nowa PRZY KAŻDYM PYTANIU — zero pamięci negatywnej.
  Dziś: `_registry` (`Map<id, wpis list()>`) budowany **leniwie** (jeden pełny skan przy
  pierwszym `list()`/`pathById()`, root liczony RAZ na skan — nie per plik) i odtąd:
  1. **utrzymywany bezpośrednio** przez `create`/`move`/`remove`/`update` (znają wszystkie pola
     od razu — nie czekają na `metadataCache`, który bywa zimny tuż po zapisie);
  2. **utrzymywany zdarzeniami** `vault.on('create'|'delete'|'rename')` +
     `metadataCache.on('changed')` (rejestrowane raz, leniwie, w `_registerVaultEvents` — łapią
     zmiany zrobione SPOZA store'a: sync, ręczna edycja frontmattera w Obsidianie,
     `app.fileManager.processFrontMatter` wołane wprost). Handler `create`/`changed` indeksuje
     TYLKO ten jeden plik (`_indexSingleFile`, z fallbackiem na odczyt z dysku, gdy
     `metadataCache` jeszcze nie zna pliku) — nigdy nie skanuje całego vaulta.
  `pathById(id)` dla id, którego rejestr NIGDY nie znał, wraca `null` **bez skanu** — rejestr
  jest kompletną wyrocznią (to jest efektywna „pamięć negatywna" bez osobnej struktury i bez TTL).
  Jedyny wciąż-skanujący fallback to **samoleczenie** w `_rescanForId`: wpis BYŁ znany
  (`_pathIndex` albo rejestr), ale `_pathIndexEntryValid` go unieważniła (np. user przeniósł plik
  w Obsidianie zanim event `rename` zdążył dojść) — root i wtedy liczony RAZ na cały przelot.
  **Dokładając metodę, która tworzy/przenosi/kasuje/zmienia frontmatter instancji poza tymi
  czterema (`create`/`move`/`remove`/`update`), zaktualizuj `_registry` (i `_pathIndex`, jeśli
  dotyczy) tak samo — inaczej `list()` zacznie kłamać, dopóki nie przyjdzie pasujący event.**
  Test-mock w `ArtifactStore.test.ts` ma PRAWDZIWY event bus (`makeEmitter` + `vault.on`/
  `metadataCache.on` odpalane przez `create`/`trash`/`renameFile`/`processFrontMatter`) — bez
  tego test „archive moves closed artifacts…" (mutuje frontmatter WPROST przez
  `app.fileManager.processFrontMatter`, z pominięciem `store.update()`) nie wykryłby regresji.
- ⚠️ **P1a/P1b (2026-09-02, review opusa fabryki W2): rejestr wyżej ma DWIE pułapki „zimnego
  `metadataCache`", osobne od zwykłego `create`.**
  1. **Pierwsza budowa rejestru może wypaść ZANIM Obsidian rozgrzał cache** (np. `archive()`
     wołane z `initialize()` na `onLayoutReady`, zanim vault w ogóle skończył się indeksować).
     Plik pod rootem z ZUPEŁNIE zimnym `getFileCache` (zwraca `null`/`undefined` — nie: cache
     istnieje, ale bez `pkm-artefakt`) NIE wchodzi do rejestru w TYM przelocie — ale
     `_ensureRegistry` w takim razie NIE stempluje `_registryRoot` (flaga `allWarm`), więc
     kolejne `list()`/`pathById()` przebuduje rejestr OD ZERA, aż cache się rozgrzeje. Bez tego
     artefakt zimny w momencie budowy zostawałby niewidoczny **do końca sesji** (rejestr jest
     inaczej wyrocznią — patrz wyżej). Drugie zabezpieczenie: `metadataCache.on('resolved')`
     (Obsidian: koniec PIERWSZEGO pełnego rozwiązania metadanych całego vaulta, zdarzenie
     JEDNORAZOWE) bezwarunkowo unieważnia rejestr (`_registry = null`), więc leniwa przebudowa
     łapie wszystko od razu, nie czekając na przypadkowe kolejne pytanie.
  2. **Samoleczenie (`pathById` → `_rescanForId`) NIE kasuje starego wpisu, jeśli rescan
     zawiedzie.** Rescan jest synchroniczny i patrzy TYLKO w `metadataCache` (bramka nie ma
     prawa czekać na dysk) — jeśli artefakt przeniesiono bez eventu `rename` do lokalizacji,
     której cache jeszcze nie rozgrzał, sam rescan nie znajdzie nowej ścieżki. Kasując wpis od
     razu, samoleczenie z M123 (patrz gotcha `AUD-security-123` wyżej) regresowałoby dokładnie
     w tym momencie: id wyglądałoby jak „nigdy nieznane" na stałe. Zamiast tego stary wpis
     ZOSTAJE, a `_findFileById` (asynchroniczny — NIE jest ścieżką bramki, koszt jednorazowego
     odczytu z dysku po plikach folderu jest akceptowalny) dostaje jednorazowy fallback z dysku
     (`_diskFallbackForId`) — ale WYŁĄCZNIE gdy `_wasEverKnown(id)` (id BYŁO kiedyś w indeksie
     sesji albo rejestrze). **Ta bramka jest kluczowa**: bez niej `_findFileById` wracałby do
     pełnego skanu + odczytu z dysku na KAŻDE halucynowane id od modelu — dokładnie regresja,
     którą naprawia 060/031/104. `pathById` sama (synchroniczna, ścieżka bramki) fallbacku z
     dysku nigdy nie dostaje — dla id BYŁO-znane-ale-zimne wraca `null`, PermissionSystem
     odmawia fail-closed (bezpieczne), a operacja i tak przejdzie przez `_findFileById` z jego
     fallbackiem, gdy woła ją coś, co bramki nie ma (np. `archive()`/`move()` wewnętrznie, testy).
  Testy `ArtifactStore.test.ts` (`P1a`/`P1b` w nazwie) reprodukują dokładnie scenariusz z reviewa:
  3 artefakty + zimny cache przy budowie → `list()`/`pathById()` puste, potem rozgrzanie/`resolved`
  odzyskuje wszystkie trzy; artefakt przeniesiony bez eventu do zimnej lokalizacji → `pathById`
  (sync) nadal `null`, `_findFileById` (async) go znajduje przez dysk.
- ⚠️ **Bramka uprawnień pyta o ścieżkę SYNCHRONICZNIE** — stąd `pathById(id)` / `instancePathFor(agent, tytul)`
  / `artifactsRoot()` (woła je `contextExtractor` narzędzi `artifact_*`). `pathById` czyta indeks
  `_pathIndex` (instancje z TEJ sesji — `metadataCache` bywa zimny tuż po `create`), potem rejestr
  (wyżej); nie znalazł = `null` → pusty cel → odmowa fail-closed w `PermissionSystem`. **Dokładając
  metodę, która tworzy/przenosi/kasuje instancję, zaktualizuj `_pathIndex` (i `_registry`).**
- ⚠️ **M (AUD-security-122/124): `scanSectionHeadings` to JEDYNA reguła „co jest nagłówkiem sekcji".**
  Czytają ją WSZYSCY trzej: `parseArtifact` (struktura), `findSection` (adresowanie patcha)
  i `hasSectionHeading` (bramka `heading_forbidden`). Do fali M każdy mierzył co innego: bramka
  `#`/`##`, a `findSection` `#`…`######` — więc legalny `### Uwagi usera` w treści przechwytywał
  patch adresowany do prawdziwej sekcji `## Uwagi usera` i kasował cudzą treść aż do niej
  (`applied:1, errors:[]`). Skaner zna OBA warianty CommonMarka — ATX i **setext** (`Tytul` +
  linia `===`/`---`) — i łamie linie także po **samotnym ``**, bo renderer tak robi; `splitLines`
  dzieli po `
||
`, a `add_item` liczy `multiline_forbidden` po `[
]`. Kreska po pustej
  linii / po nagłówku / pod elementem listy to `hr`, nie setext. **Nie dopisuj drugiego regexa
  na nagłówki — bramka i zlew mają widzieć TO SAMO.**
  ⚠️ **AUD-code-review-104 (2026-08-30): „element listy" = bullet ORAZ numerowana.** `LIST_ITEM_RE`
  łapał do 2026-08-30 tylko myślnik, więc `1. Krok\n---` (numerowana lista zakończona separatorem,
  np. sekcja „Kroki" wbudowanego typu `plan`) czytał się jako podrobiony nagłówek setext H2 —
  fałszywy `heading_forbidden` na legalnej treści. Regex dziś `/^\s*(?:-\s+|\d+[.)]\s+)/` — TA SAMA
  stała, której `add_item` używa do znalezienia końca listy przy wstawianiu checkboxa, więc naprawa
  objęła obie role za jednym razem.
- ⚠️ **M (AUD-security-123): id → ścieżka rozstrzyga JEDNO miejsce (`pathById`), także dla zlewu.**
  `_pathIndex` to pamięć podręczna, a notatkę user przenosi w Obsidianie bez wiedzy pluginu —
  nieświeży wpis rozjeżdżał bramkę (stara ścieżka, whitelista liczona na niej) ze zlewem
  (`_findFileById` skanował dysk i pisał pod nową). Dziś wpis idzie przez `_pathIndexEntryValid`
  (plik istnieje pod tą ścieżką i nadal niesie to `id`; **zimny `metadataCache` NIE unieważnia
  wpisu** — po to on jest), a `_findFileById` STARTUJE od `pathById` i odświeża indeks po każdym
  skanie. Ubocznie zamyka to nawrót AUD-security-063: `isBlockBoundToNote` przestaje wiązać cudzą
  notatkę stojącą pod starym adresem.
- ⚠️ **M (AUD-security-125): `pola` przy `create` mają TEN SAM kontrakt co `set_field` — tylko skalary.**
  `applyFieldsValidated` sprawdza najpierw `isArtifactScalar` (jeden predykat z `artifactParser`),
  a dopiero potem puszcza wartość przez `validateArtifactBodyText`. Wcześniej walidował
  `String(value)`, więc zagnieżdżony obiekt dawał `"[object Object]"`, przechodził bramkę,
  a `create` zapisywał do frontmattera notatki SUROWĄ mapę (razem z blokiem kodu, którego
  `set_field` nie dopuszcza). **Walidator ma oglądać dokładnie to, co pójdzie do zapisu.**
- ⚠️ **K8 (AUD-code-review-047/102, 2026-08-30): `ArtifactStore.update()` waliduje `set_field`
  TĄ SAMĄ kolejnością co `applyOne` w `artifactParser.ts` — string `key` → klucz chroniony →
  `isArtifactScalar`/`INVALID_VALUE_MSG` kanoniczne, nie własna kopia predykatu/komunikatu.
  `update` NIE woła `applyPatch` dla `set_field` (ma równoległą reimplementację, bo body i
  frontmatter idą dwoma różnymi API — `vault.process` vs `processFrontMatter`), więc brak
  walidacji `key` był trzecim, niepilnowanym wejściem: `{op:'set_field', value:'x'}` bez `key`
  mijał `PROTECTED_FIELDS.includes(undefined)===false` i pisał `front['undefined']='x'` do YAML,
  meldując `applied:1, errors:[]`. **Dokładając czwartą drogę zapisu `set_field`, powtórz
  DOKŁADNIE tę trójkę sprawdzeń w tej kolejności — nie tylko import kanonicznych stałych.**
- ⚠️ **`todo` w dotfolderze** = Vault API go NIE widzi → adapter (`TodoFileStore`, wzór AgentMemory). To konieczność, nie dług.
- ⚠️ **metadataCache asynchroniczny** — po `create` cache może nie znać pliku przez chwilę; `read`/`list`/`_findFileById` mają fallback parse z dysku.
- ⚠️ **`vault.process` (body) + `processFrontMatter` (set_field)** = dwa zapisy w `update`; kolejność body→frontmatter. Parser nie zjada cudzych block-idów.
- ⚠️ **Migrator jednorazowy** — marker `.pkm-assistant/artifacts/.migrated-v2`; idempotentny (drugi przebieg = no-op). `context-session`/nieznane/uszkodzone → backup, nie kasacja na ślepo.
- ⚠️ **AUD-code-review-105 (2026-08-30): JEDEN helper daty `YYYY-MM-DD` dla modułu.**
  `formatYmd(d: Date)` w `artifactParser.ts` — `ArtifactStore._today()`/`_genId()` i
  `migrate_json_to_notes.ts` (`today()`) go wołają zamiast każdy niezależnie przepisywać
  `getFullYear/getMonth/getDate + padStart`. Świadomie NIE `toISOString().slice(0,10)` — to UTC,
  a data instancji/backupu ma być LOKALNA. **Sygnał, bez naprawy (poza zakresem tego modułu):**
  ten sam kształt YYYY-MM-DD żyje trzeci raz w `modules/komunikator/KomunikatorManager.ts`
  (`formatMessageDate`) — osobny moduł, nie ruszany tutaj.

## Powiązane

- `modules/tools/CLAUDE.md` — serwer `artifacts` (artifact_* + todo); aliasy chat_todo/idea_review/plan_review w `toolAliases.js`.
- `modules/chat/CLAUDE.md` — chip aktywnego artefaktu (B4) + segment slim bara (C2) + live-widok `todo` (D2, `todoPanel.js`).
- `modules/agents/CLAUDE.md` — `AgentManager` owner `ArtifactTypeLoader` + `artifact_types` per agent.
- Sesja projektowa: `Nauka/2026-07-23_sesja_projektowa_E2.9.md`; spec: `Refaktor/Sprinty/E2_9_Artefakty_SPEC.md`.
