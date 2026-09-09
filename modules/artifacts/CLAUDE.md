# modules/artifacts/

**Artefakty żywe.** Obiekty współtworzone user↔agent, gdzie **notatka vaulta JEST źródłem prawdy** (frontmatter + treść). Agent nigdy nie czyta surowego markdownu (dostaje sparsowany chudy JSON) ani go nie pisze (patch strukturalny na świeżym stanie). Plus **gatunek 2 - `todo`**: prymitywna jednorazówka agenta w `.pkm-assistant/`, live-widok w czacie.

## Dwa gatunki

| Gatunek | Co to | Gdzie żyje | Narzędzia |
|---|---|---|---|
| **1 - artefakt żywy** | notatka współtworzona z userem (plan, notatka) z approval flow (guziki w notatce) | widoczny folder vaulta (`settings.pkmAssistant.artifactsFolder`, default `PKM Assistant/Artefakty/<agent>/`) | `artifact_create/read/update/list` |
| **2 - todo** | prywatna lista zadań agenta, jednorazówka „na oczach" | ukryty `.pkm-assistant/artifacts/todo/<agent>-<sessionId>.md` | `todo` (create/check/uncheck/add/finish) |

Wspólny silnik (parser/patcher), osobne interfejsy - wspólna mechanika, nie sklejanie gatunków.

## Co tu jest

```
modules/artifacts/
├── artifactParser.ts         # PURE parser + patcher (parseArtifact/applyPatch) + `validateArtifactBodyText` - JEDYNA bramka treści agenta (code-fence/HTML/nagłówki) + protected keys
├── ArtifactTypeLoader.ts     # biblioteka TYPÓW (.pkm-assistant/artifacts/types/*.md); seed plan + notatka
├── ArtifactStore.ts          # CRUD instancji jako notatek vaulta (create/read/update/list/move/remove/archive/importInstance)
├── artifactButtons.ts        # computeArtifactButtons (guziki wg statusu instancji + statusy typu)
├── artifactSummon.ts         # przywołanie agenta (buildSummonMessage + summonAgentForArtifact) + ciche przypięcie (activateArtifactInChat)
├── artifactBlocks.ts         # registerMarkdownCodeBlockProcessor('pkm-artefakt') - render guzików w notatce + `isBlockBoundToNote` (blok żyje tylko w swojej notatce)
├── artifactViewHelpers.ts    # PURE helpery UI (sort/picker/typy) dla panelu + slim bara
├── basesView.ts              # PURE generator pliku `.base` (Obsidian Bases): 2 widoki table
├── migrate_json_to_notes.ts  # jednorazowy migrator starych JSONów → notatki (idempotentny)
├── types.ts                  # tylko typy (ArtifactFrontmatter/ArtifactItem/ArtifactSection/ParsedArtifact/ArtifactType/...) - zero runtime, re-eksportowane przez barrel jako `export type`
├── index.ts                  # barrel
└── *.test.ts
```

Specifiery importów w kodzie zostają z `.js` (konwencja repo dla plików TypeScript) - żaden konsument spoza modułu nie zmienia importów przez to.

## Public API (`index.ts`)

- `parseArtifact`, `applyPatch` - silnik (pure)
- `ArtifactTypeLoader` - biblioteka typów
- `ArtifactStore`, `DEFAULT_ARTIFACTS_FOLDER` - CRUD instancji jako notatek vaulta + domyślny folder
- `summonAgentForArtifact` - przywołanie agenta po interakcji z notatką (ustawia aktywny + WYSYŁA stan)
- `activateArtifactInChat` - ciche przypięcie artefaktu do rozmowy (ustawia aktywny, **zero wysyłki**); wołacz: klik w pickerze slim bara
- `registerArtifactBlocks` - rejestracja code-blocku `pkm-artefakt` (guziki w notatce)
- `sortArtifactsForView`, `buildArtifactPickerItems`, `toggleTypeName`, `buildTypeCheckboxRows` - pure helpery widoku
- `buildArtifactsBaseContent`, `buildArtifactsBasePath`, `ARTIFACTS_BASE_FILENAME` - widok Bases
- `migrateJsonArtifactsToNotes` - jednorazowy migrator

Reszta symboli modułu świadomie NIE jest w barrelu - zero konsumentów spoza modułu. Stałe typów czyta `ArtifactTypeLoader` przy seedowaniu, guziki liczy `artifactBlocks.ts` przy renderze code-blocku, `buildSummonMessage` woła `summonAgentForArtifact` u siebie, a testy deep-importują pliki wprost. Wyjątek jest `BUILTIN_TYPE_NAMES` - mimo że testy deep-importują inne stałe typów wprost, tej jednej żaden test nie potrzebuje; jedyny czytelnik zostaje `ArtifactTypeLoader.ts` u siebie (seedowanie flagi `builtin` na wpisie typu).

Narzędzie `todo` żyje w `modules/tools/built-in-servers/artifacts/TodoTool.ts` (nie tutaj) - jest MCP toolem, nie częścią silnika. Nie deep-importuje `artifactParser.ts` - bierze `parseArtifact`/`applyPatch` przez TEN barrel (`../../../artifacts/index.js`). Dlatego oba zostają w powierzchni publicznej.

## Typy artefaktów

Typ = plik `.pkm-assistant/artifacts/types/<nazwa>.md`: frontmatter meta (`nazwa`, `opis`, `pola{opis[,domyslne]}`, `statusy[]`, `sprzatanie` dni) + body = szablon ciała (placeholdery `{{pole}}`). Body szablonu jest **nieprzezroczysty** - user może w nim mieć dataviewjs. **Trzy typy wbudowane** seedowane przy starcie: **`plan`** (Cel/Kroki/Ryzyka/Uwagi usera) + **`notatka`** (Treść/Uwagi usera) + **`raport`** (Deep Research: TL;DR/Ustalenia/**Białe plamy**/Źródła/Uwagi usera - istniejące vaulty, w których typ `raport` już był utworzony ze starszym szablonem, sekcji „Białe plamy" nie dostaną automatycznie, bo `ensureBuiltinTypes` nie nadpisuje plików usera, dlatego przepisy mają fallback na podsekcję `### Białe plamy` w „Ustaleniach"; pola `pytanie`+`tryb`; statusy `[w-trakcie, gotowy, zamkniety]` - bez approval flow, raport się CZYTA; `sprzatanie: 0` - raporty się nie przedawniają; `w-trakcie`/`gotowy` dostają generyczny guzik „Przywołaj agenta" = żywy raport). Podpinane per agent przez `artifact_types:` w YAML. **Lista działa na dwie strony:** widoczność w indeksie promptu (brak/pusta = agent widzi tylko `plan`) ORAZ egzekwowanie przy tworzeniu - `artifact_create` z typem spoza NIEPUSTEJ listy dostaje odmowę (`mcp.artifact.type_not_allowed`). **Pusta/nieustawiona lista = wszystkie typy z biblioteki wolno** (egzekwowanie jest opt-in, zero regresji dla istniejących profili) - dzięki temu przepisy deep-research nadal podają `typ:"raport"` explicite u agenta bez podpięć.

## Kluczowe decyzje

- **Notatka = źródło prawdy.** Zero „osobny YAML + kopiowanie". Frontmatter (to JEST YAML) + treść w jednym pliku. Śledzenie po frontmatterze `pkm-artefakt`, NIE po ścieżce (przenosiny notatki nic nie psują).
- **Agent NIGDY nie pisze bloków kodu w artefaktach.** Egzekwowane W SILNIKU, nie tylko w prompcie - jednym predykatem `validateArtifactBodyText`, który obsługuje `applyPatch` (`code_forbidden`) ORAZ wartości `pola` przy `create`. Liczy grawisy, tyldy i surowy HTML (`<pre>`/`<code>`/`<script>`). Kod pochodzi wyłącznie z szablonów typów autorstwa usera. Zamyka wektor prompt-injection → wykonanie JS. **Wyjątek:** `ArtifactStore.importInstance` (migrator) wstawia body verbatim - to zachowanie ISTNIEJĄCEJ treści usera, nie pisanie przez agenta.
- **Agent NIGDY nie pisze nagłówków poziomu 1-2 w treści (`heading_forbidden`).** `set_section` i `add_item` odrzucają tekst z linią `# `/`## `, bo te poziomy tworzą sekcje: wpisane do TREŚCI robią drugi nagłówek o tej samej nazwie, a `findSection` zwraca PIERWSZE trafienie → oryginalna sekcja zostaje osierocona na zawsze (kolejne patche trafiają w podrobioną). **`###` i głębsze są DOZWOLONE** - model legalnie używa ich jako podtytułów wewnątrz sekcji. Bramka i zlew liczą nagłówki JEDNĄ funkcją `scanSectionHeadings` (patrz gotcha niżej); rozjazd tych dwóch stron = dziura.
- **`create` raportuje wynik patcha tak samo jak `update`.** Zwraca `{created, id, path, applied, errors, artifact}` (`created:false` = odmowa bramki pól JESZCZE PRZED zapisem, pusty `id`) - początkowe `sekcje` idą przez `applyPatch` i jego `applied`/`errors` jadą do wołacza. Wcześniej `create` brał z patcha samo `.markdown`, więc `set_section` z nagłówkiem spoza szablonu typu wracał jako cichy `not_found`: narzędzie mówiło `ok:true`, a artefakt wychodził pustym szablonem. Bez sekcji → `applied: 0`, `errors: []`.
- **Klucze frontmattera PO POLSKU:** `pkm-artefakt`/`typ`/`agent`/`status`/`utworzono`/`zaktualizowano` + pola typu. Klucze bazowe NIEZMIENIALNE (`protected_key`).
- **Block-idy jako stabilne adresy:** checkboxy dostają `^k1` - patch po block-idzie, nie po kruchym indeksie.
- **Todo default ON:** `todo` to wyjątek z grupy `artifacts` w `toolAxis` (`DEFAULT_ENABLED_EXCEPTIONS`) - pisze tylko do ukrytego `.pkm-assistant/`, nie do widocznego vaulta usera. `artifact_*` zostają OFF konserwatywnie.

## Widok Bases

Komenda **„Wygeneruj widok Bases artefaktów"** (`generate-artifacts-base`, handler `generate_artifacts_base()` w `src/main.ts`) tworzy plik `<folder artefaktów>/Artefakty.base` z **dwoma widokami `type: table`**:

- **„Wszystkie"** - filtry `file.inFolder("<folder>")` + `!note["pkm-artefakt"].isEmpty()` (drugi filtr odsiewa cudze notatki i sam plik `.base`); kolumny `file.name, typ, agent, status, utworzono, zaktualizowano`; sort `zaktualizowano DESC`.
- **„Otwarte"** - jak wyżej + `note["status"] != "zamkniety"`.

Generator to pure `basesView.ts` (`buildArtifactsBaseContent(folder)` + `buildArtifactsBasePath(folder)`), YAML składany **ręcznie jako template string, NIE przez `stringifyYaml`** - kolejność kluczy i styl mają być czytelne dla usera, który potem klika ten plik w GUI Bases. Pełna treść jest zamrożona snapshotem w `basesView.test.ts` (kontrakt formatu).

**Decyzje:**
- **Sesje poza zasięgiem.** Archiwum sesji żyje w ukrytym `.pkm-assistant/`, którego Obsidian nie indeksuje → Bases go fizycznie nie widzi. Widok obejmuje TYLKO artefakty (gatunek 1, widoczny folder vaulta). Żadnego dashboardu-notatki jako fallbacku nie ma - Bases jest dostępne.
- **Nie nadpisujemy.** Jeżeli plik już istnieje → Notice „usuń go, żeby wygenerować od nowa" i STOP; user mógł widok dostosować w GUI.
- **Archiwum artefaktów wpada do widoku** - `file.inFolder` łapie podfoldery per agent ORAZ `_archiwum`. Świadomie: archiwalny artefakt to nadal artefakt (i ma status `zamkniety`, więc w „Otwartych" go nie ma).
- **`properties: file.name → displayName: Notatka`** - jedyny displayName, bo pozostałe klucze frontmattera są już po polsku.

## Gotchas

- ⚠️ **JEDEN walidator dla KAŻDEGO wejścia treści agenta.** `validateArtifactBodyText` (`artifactParser.ts`) to jedyne miejsce, w którym stoi reguła „co agent może wpisać do ciała artefaktu" (fence kodu ``` / `~~~` / `<pre>`/`<code>`/`<script>` + nagłówki `#`/`##`). Wołają go OBA wejścia: opsy patcha (`set_section`/`add_item`) **oraz** wartości `pola` przy `create` - przez `ArtifactStore.applyFieldsValidated`. Wcześniej `pola` szły surowym `String(v)` do `substitutePlaceholders`, więc `artifact_create` był drugą, niepilnowaną drogą zapisu treści. **Dokładając NOWĄ drogę pisania do ciała instancji, przepuść ją przez ten sam predykat - nie dopisuj drugiego regexa.** Odmowa pola jest **fail-closed**: `create` zwraca `created:false` i NIE tworzy pliku (odmowa `sekcje` działa inaczej - nota powstaje, a błąd wraca w `errors`, bo opsy są niezależne). Treść USERA (szablon typu, `domyslne` pól, `importInstance` migratora) bramce NIE podlega.
  Świadomie NIE liczymy wciętego bloku kodu (4 spacje/tab) - tak wygląda zagnieżdżona lista.
- ⚠️ **Blok `pkm-artefakt` działa TYLKO w swojej notatce.** Procesor jest zarejestrowany globalnie (`src/main.ts`) i bierze `id` z TREŚCI bloku, więc bez tego warunku blok podłożony w cudzej notatce dawał działające guziki cudzego artefaktu. `isBlockBoundToNote(id, ctx.sourcePath, store)` porównuje ścieżkę renderowanego pliku ze ścieżką artefaktu z **jednego** źródła prawdy (`store.pathById`, to samo, którego używa bramka uprawnień), po ścieżce kanonicznej. Niezwiązany blok = render martwy z `artifact.block.foreign`, **przed** `store.read` (żeby nie wyciekł nawet status). Brak `sourcePath` / store'a / nieznane id = też martwy (fail-closed).
- ⚠️ **Artefakt ŻYJE W FOLDERZE ARTEFAKTÓW - inaczej dla silnika nie istnieje.** `_findFileById` i `list()` filtrują OBA przejścia do roota, a `move()` odmawia przenosin poza root. Reguła „przenosiny nic nie psują" obowiązuje dalej WEWNĄTRZ folderu - tropimy po frontmatterze, nie po dokładnej ścieżce.
- ⚠️ **`list()`/`pathById()` NIE skanują `vault.getMarkdownFiles()` na każde wywołanie - czytają REJESTR.** Bez tego `list()` przechodziłoby CAŁY vault na KAŻDĄ turę czatu (`_buildBaseContext` woła `store.list()`), przy każdym `artifact_list`, przy chipie artefaktu w czacie i przy każdym renderze pickera; `pathById`/`_findFileById` dla NIEISTNIEJĄCEGO id (halucynacja modelu, artefakt skasowany) robiłyby to samo od nowa PRZY KAŻDYM PYTANIU - zero pamięci negatywnej.
  Dziś: `_registry` (`Map<id, wpis list()>`) budowany **leniwie** (jeden pełny skan przy pierwszym `list()`/`pathById()`, root liczony RAZ na skan - nie per plik) i odtąd:
  1. **utrzymywany bezpośrednio** przez `create`/`move`/`remove`/`update` (znają wszystkie pola od razu - nie czekają na `metadataCache`, który bywa zimny tuż po zapisie);
  2. **utrzymywany zdarzeniami** `vault.on('create'|'delete'|'rename')` + `metadataCache.on('changed')` (rejestrowane raz, leniwie, w `_registerVaultEvents` - łapią zmiany zrobione SPOZA store'a: sync, ręczna edycja frontmattera w Obsidianie, `app.fileManager.processFrontMatter` wołane wprost). Handler `create`/`changed` indeksuje TYLKO ten jeden plik (`_indexSingleFile`, z fallbackiem na odczyt z dysku, gdy `metadataCache` jeszcze nie zna pliku) - nigdy nie skanuje całego vaulta.
  `pathById(id)` dla id, którego rejestr NIGDY nie znał, wraca `null` **bez skanu** - rejestr jest kompletną wyrocznią (to jest efektywna „pamięć negatywna" bez osobnej struktury i bez TTL). Jedyny wciąż-skanujący fallback to **samoleczenie** w `_rescanForId`: wpis BYŁ znany (`_pathIndex` albo rejestr), ale `_pathIndexEntryValid` go unieważniła (np. user przeniósł plik w Obsidianie zanim event `rename` zdążył dojść) - root i wtedy liczony RAZ na cały przelot.
  **Dokładając metodę, która tworzy/przenosi/kasuje/zmienia frontmatter instancji poza tymi czterema (`create`/`move`/`remove`/`update`), zaktualizuj `_registry` (i `_pathIndex`, jeśli dotyczy) tak samo - inaczej `list()` zacznie kłamać, dopóki nie przyjdzie pasujący event.**
  Test-mock w `ArtifactStore.test.ts` ma PRAWDZIWY event bus (`makeEmitter` + `vault.on`/`metadataCache.on` odpalane przez `create`/`trash`/`renameFile`/`processFrontMatter`) - bez tego test „archive moves closed artifacts…" (mutuje frontmatter WPROST przez `app.fileManager.processFrontMatter`, z pominięciem `store.update()`) nie wykryłby regresji.
- ⚠️ **Rejestr wyżej ma DWIE pułapki „zimnego `metadataCache`", osobne od zwykłego `create`.**
  1. **Pierwsza budowa rejestru może wypaść ZANIM Obsidian rozgrzał cache** (np. `archive()` wołane z `initialize()` na `onLayoutReady`, zanim vault w ogóle skończył się indeksować). Plik pod rootem z ZUPEŁNIE zimnym `getFileCache` (zwraca `null`/`undefined` - nie: cache istnieje, ale bez `pkm-artefakt`) NIE wchodzi do rejestru w TYM przelocie - ale `_ensureRegistry` w takim razie NIE stempluje `_registryRoot` (flaga `allWarm`), więc kolejne `list()`/`pathById()` przebuduje rejestr OD ZERA, aż cache się rozgrzeje. Bez tego artefakt zimny w momencie budowy zostawałby niewidoczny **do końca sesji**. Drugie zabezpieczenie: `metadataCache.on('resolved')` (Obsidian: koniec PIERWSZEGO pełnego rozwiązania metadanych całego vaulta, zdarzenie JEDNORAZOWE) bezwarunkowo unieważnia rejestr (`_registry = null`), więc leniwa przebudowa łapie wszystko od razu, nie czekając na przypadkowe kolejne pytanie.
  2. **Samoleczenie (`pathById` → `_rescanForId`) NIE kasuje starego wpisu, jeśli rescan zawiedzie.** Rescan jest synchroniczny i patrzy TYLKO w `metadataCache` (bramka nie ma prawa czekać na dysk) - jeśli artefakt przeniesiono bez eventu `rename` do lokalizacji, której cache jeszcze nie rozgrzał, sam rescan nie znajdzie nowej ścieżki. Kasując wpis od razu, samoleczenie regresowałoby dokładnie w tym momencie: id wyglądałoby jak „nigdy nieznane" na stałe. Zamiast tego stary wpis ZOSTAJE, a `_findFileById` (asynchroniczny - NIE jest ścieżką bramki, koszt jednorazowego odczytu z dysku po plikach folderu jest akceptowalny) dostaje jednorazowy fallback z dysku (`_diskFallbackForId`) - ale WYŁĄCZNIE gdy `_wasEverKnown(id)` (id BYŁO kiedyś w indeksie sesji albo rejestrze). **Ta bramka jest kluczowa**: bez niej `_findFileById` wracałby do pełnego skanu + odczytu z dysku na KAŻDE halucynowane id od modelu. `pathById` sama (synchroniczna, ścieżka bramki) fallbacku z dysku nigdy nie dostaje - dla id BYŁO-znane-ale-zimne wraca `null`, `PermissionSystem` odmawia fail-closed (bezpieczne), a operacja i tak przejdzie przez `_findFileById` z jego fallbackiem, gdy woła ją coś, co bramki nie ma (np. `archive()`/`move()` wewnętrznie, testy).
  Testy w `ArtifactStore.test.ts` reprodukują dokładnie ten scenariusz: 3 artefakty + zimny cache przy budowie → `list()`/`pathById()` puste, potem rozgrzanie/`resolved` odzyskuje wszystkie trzy; artefakt przeniesiony bez eventu do zimnej lokalizacji → `pathById` (sync) nadal `null`, `_findFileById` (async) go znajduje przez dysk.
- ⚠️ **Bramka uprawnień pyta o ścieżkę SYNCHRONICZNIE** - stąd `pathById(id)` / `instancePathFor(agent, tytul)` / `artifactsRoot()` (woła je `contextExtractor` narzędzi `artifact_*`). `pathById` czyta indeks `_pathIndex` (instancje z TEJ sesji - `metadataCache` bywa zimny tuż po `create`), potem rejestr (wyżej); nie znalazł = `null` → pusty cel → odmowa fail-closed w `PermissionSystem`. **Dokładając metodę, która tworzy/przenosi/kasuje instancję, zaktualizuj `_pathIndex` (i `_registry`).**
- ⚠️ **`scanSectionHeadings` to JEDYNA reguła „co jest nagłówkiem sekcji".** Czytają ją WSZYSCY trzej: `parseArtifact` (struktura), `findSection` (adresowanie patcha) i `hasSectionHeading` (bramka `heading_forbidden`). Wcześniej każdy mierzył co innego: bramka `#`/`##`, a `findSection` `#`…`######` - więc legalny `### Uwagi usera` w treści przechwytywał patch adresowany do prawdziwej sekcji `## Uwagi usera` i kasował cudzą treść aż do niej (`applied:1, errors:[]`). Skaner zna OBA warianty CommonMarka - ATX i **setext** (`Tytul` + linia `===`/`---`) - i łamie linie także po **samotnym CR**, bo renderer tak robi. Kreska po pustej linii / po nagłówku / pod elementem listy to `hr`, nie setext. **Nie dopisuj drugiego regexa na nagłówki - bramka i zlew mają widzieć TO SAMO.**
  ⚠️ **„Element listy" = bullet ORAZ numerowana.** `LIST_ITEM_RE` łapał kiedyś tylko myślnik, więc `1. Krok\n---` (numerowana lista zakończona separatorem, np. sekcja „Kroki" wbudowanego typu `plan`) czytał się jako podrobiony nagłówek setext H2 - fałszywy `heading_forbidden` na legalnej treści. Regex dziś `/^\s*(?:-\s+|\d+[.)]\s+)/` - TA SAMA stała, której `add_item` używa do znalezienia końca listy przy wstawianiu checkboxa, więc naprawa objęła obie role za jednym razem.
- ⚠️ **Id → ścieżka rozstrzyga JEDNO miejsce (`pathById`), także dla zlewu.** `_pathIndex` to pamięć podręczna, a notatkę user przenosi w Obsidianie bez wiedzy pluginu - nieświeży wpis rozjeżdżał bramkę (stara ścieżka, whitelista liczona na niej) ze zlewem (`_findFileById` skanował dysk i pisał pod nową). Dziś wpis idzie przez `_pathIndexEntryValid` (plik istnieje pod tą ścieżką i nadal niesie to `id`; **zimny `metadataCache` NIE unieważnia wpisu** - po to on jest), a `_findFileById` STARTUJE od `pathById` i odświeża indeks po każdym skanie. Ubocznie zamyka to sytuację, w której `isBlockBoundToNote` wiązałby cudzą notatkę stojącą pod starym adresem.
- ⚠️ **`pola` przy `create` mają TEN SAM kontrakt co `set_field` - tylko skalary.** `applyFieldsValidated` sprawdza najpierw `isArtifactScalar` (jeden predykat z `artifactParser`), a dopiero potem puszcza wartość przez `validateArtifactBodyText`. Wcześniej walidował `String(value)`, więc zagnieżdżony obiekt dawał `"[object Object]"`, przechodził bramkę, a `create` zapisywał do frontmattera notatki SUROWĄ mapę (razem z blokiem kodu, którego `set_field` nie dopuszcza). **Walidator ma oglądać dokładnie to, co pójdzie do zapisu.**
- ⚠️ **`ArtifactStore.update()` waliduje `set_field` TĄ SAMĄ kolejnością co `applyOne` w `artifactParser.ts`** - string `key` → klucz chroniony → `isArtifactScalar`/`INVALID_VALUE_MSG` kanoniczne, nie własna kopia predykatu/komunikatu. `update` NIE woła `applyPatch` dla `set_field` (ma równoległą reimplementację, bo body i frontmatter idą dwoma różnymi API - `vault.process` vs `processFrontMatter`), więc brak walidacji `key` był trzecim, niepilnowanym wejściem: `{op:'set_field', value:'x'}` bez `key` mijał `PROTECTED_FIELDS.includes(undefined)===false` i pisał `front['undefined']='x'` do YAML, meldując `applied:1, errors:[]`. **Dokładając czwartą drogę zapisu `set_field`, powtórz DOKŁADNIE tę trójkę sprawdzeń w tej kolejności - nie tylko import kanonicznych stałych.**
- ⚠️ **`todo` w dotfolderze** = Vault API go NIE widzi → adapter (`TodoFileStore`, wzór AgentMemory). To konieczność, nie dług.
- ⚠️ **metadataCache asynchroniczny** - po `create` cache może nie znać pliku przez chwilę; `read`/`list`/`_findFileById` mają fallback parse z dysku.
- ⚠️ **`vault.process` (body) + `processFrontMatter` (set_field)** = dwa zapisy w `update`; kolejność body→frontmatter. Parser nie zjada cudzych block-idów.
- ⚠️ **Migrator jednorazowy** - marker `.pkm-assistant/artifacts/.migrated-v2`; idempotentny (drugi przebieg = no-op). `context-session`/nieznane/uszkodzone → backup, nie kasacja na ślepo.
- ⚠️ **JEDEN helper daty `YYYY-MM-DD` dla modułu.** `formatYmd(d: Date)` w `artifactParser.ts` - `ArtifactStore._today()`/`_genId()` i `migrate_json_to_notes.ts` (`today()`) go wołają zamiast każdy niezależnie przepisywać `getFullYear/getMonth/getDate + padStart`. Świadomie NIE `toISOString().slice(0,10)` - to UTC, a data instancji/backupu ma być LOKALNA. Ten sam kształt YYYY-MM-DD żyje też w `modules/komunikator/KomunikatorManager.ts` (`formatMessageDate`) - osobny moduł, nie ruszany tutaj.

## Powiązane

- `modules/tools/CLAUDE.md` - serwer `artifacts` (artifact_* + todo); aliasy chat_todo/idea_review/plan_review w `toolAliases.ts`.
- `modules/chat/CLAUDE.md` - chip aktywnego artefaktu + segment slim bara + live-widok `todo` (`todoPanel.ts`).
- `modules/agents/CLAUDE.md` - `AgentManager` owner `ArtifactTypeLoader` + `artifact_types` per agent.
