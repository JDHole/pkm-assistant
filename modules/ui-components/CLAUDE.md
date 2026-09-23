# modules/ui-components/

**Współdzielone klocki UI.** Kawałki interfejsu, których używa więcej niż jeden moduł: bloki akcji w czacie (narzędzie / myślenie / sub-agent), załączniki w polu wpisywania i autouzupełnianie `@`.

Zasada wstępu jak w `core/`, tylko dla UI: trafia tu klocek, którego potrzebuje **≥2 moduły**. Klocek używany przez jeden moduł zostaje u niego. Tu nie ma logiki biznesowej - same funkcje budujące DOM + klasy sterujące widgetem.

---

## Co tu jest

```
modules/ui-components/
├── index.ts                 # jedyne drzwi publiczne (barrel)
├── CLAUDE.md                # ten plik
├── Tile.ts                  # `createTile` - komponent kafelka `.cs-tile`, wspólny fundament rzędów akcji (2.3.0, "Czat bez ścian"). Szczegóły: sekcja "Tile" niżej
├── ToolCallDisplay.ts       # katalog TOOL_INFO (ikona + etykieta i18n per narzędzie) + `describeToolCall` (tytuł kafelka po ludzku) + pełny blok wywołania narzędzia + kompaktowy chip, oba przez `createTile`
├── AttachmentManager.ts     # załączniki w czacie: 📎 picker, drag & drop, wklejenie z schowka (obrazy → base64, tekst → kontekst, PDF → ekstrakcja)
├── MentionAutocomplete.ts   # dropdown `@` nad polem czatu: notatki i foldery vaulta, wynik jako chip nad inputem (nie tekst inline)
├── SubAgentBlock.ts         # kafelek wyniku/błędu/pokwitowania w tle sub-agenta, przez `createTile` (rola `agent`) - przepięte z `.cs-action-row` na Tile w A2 (2.3.0, "Czat bez ścian")
├── ThinkingBlock.ts         # rozwijalny wiersz „Myślenie" (reasoning modelu + czas + status), kafelek przez `createTile`
├── PluginItemView.ts        # bazowa klasa widoków (extends Obsidian `ItemView`); rejestracja rozbita na `register` (typ widoku, przed odtworzeniem zakładek) i `registerOpenCommand` (komenda palety, PO `setLocale()` - Obsidian zapamiętuje nazwę w chwili `addCommand`)
├── DiffModal.ts             # podgląd diffa przed `vault_write`
├── diffLines.ts             # silnik diffa linia-po-linii dla DiffModal, bez importu `obsidian` (testowalny w AVA)
├── ConfirmModal.ts          # zamiennik natywnego `confirm()` (wytyczne katalogu: no-alert)
├── textPreview.ts           # `truncatePreview(text, maxLength=500)` - wspólne obcinanie podglądu (InlineCommentModal, SendToAgentModal)
└── backstage_helpers.ts     # prymitywy kart Zaplecza
```

Od A2 (2.3.0) WSZYSTKIE bloki akcji w czacie (`ThinkingBlock`, `ToolCallDisplay`, `SubAgentBlock`,
bloki systemowe błędu streamu w `modules/chat/chat/chat_streaming.ts`) renderują się jako kafelek
`.cs-tile` przez `createTile` (patrz sekcja "Tile" niżej) - stara rodzina `.cs-action-row` (dawny
Crystal Soul) nie ma już ŻADNEGO producenta w kodzie. Jej CSS zostaje w `modules/chat/chat_view.css`
świadomie NIEUSUNIĘTY (poza zakresem A2 - usunięcie martwego CSS to osobna, niekrytyczna porządkowa
robota), tak samo jak selektor `.cs-action-row, .cs-tile` w `_drawConnectorLines`
(`modules/chat/chat/chat_messages.ts`) - obronny, na wypadek gdyby coś kiedyś znów wystawiło tę
rodzinę DOM-u. Wygląd i CSS obu rodzin żyją w `modules/chat/chat_view.css`, tu jest tylko struktura
DOM (poprawka nieścisłości z recenzji A1-fix: `.cs-action-row` CSS nie jest w
`modules/crystal-soul/`, mimo nazwy "Crystal Soul").

---

## Tile (2.3.0)

`createTile(spec): TileHandle` (`Tile.ts`) jest fundamentem inicjatywy "Czat bez ścian": jeden
komponent kafelka zamiast osobnej struktury DOM per typ bloku. DOM: `div.cs-tile.cs-tile--{role}.cs-tile--{status}` z `.cs-tile__head` (ikona + tytuł + skrót? + meta? + kropka statusu) i
`.cs-tile__body` (leniwie renderowane `.cs-tile__details` + `.cs-tile__actions`?). Pełny kształt
`TileSpec`/`TileHandle` i klasy DOM - patrz JSDoc w `Tile.ts`, jest tam jedyne źródło prawdy.

- **Kolor przez rolę** (`TileRole`): `system`/`error` → czerwony (`--color-red`), `user` →
  kolor usera, `agent`/`agent-muted` → kolor agenta (`--cs-agent-color-rgb`, `agent-muted` ma
  wygaszoną (3%/12%) wersję tła/obwódki - to jest kolor "przymglony" dla list/wyszukiwań/odczytów
  z briefu właściciela). Jedna zmienna CSS `--cs-tile-color` przełącza cały kafelek.
- **Zero technikaliów w nagłówku** - `title`/`summary` to zawsze tekst po ludzku (i18n), NIGDY
  surowa nazwa narzędzia, id wywołania ani JSON. Odpowiedzialność za to leży u WOŁACZA
  (`describeToolCall` w `ToolCallDisplay.ts` jest tego przykładem), nie u `Tile.ts` samego -
  komponent nie wie nic o narzędziach/agentach, tylko renderuje to, co dostał.
- **`details` renderują się LENIWIE, RAZ** - string/`HTMLElement`/funkcja `(body) => void`
  budująca się dopiero przy PIERWSZYM przejściu w stan rozwinięty (albo od razu przy konstrukcji,
  jeśli kafelek startuje rozwinięty - np. `status:'error'` bez jawnego `expanded:false`). Kolejne
  rozwinięcia/zwinięcia NIE wołają funkcji ponownie. `setDetails(nowyDetails)` podmienia treść
  do wyrenderowania: jeśli szczegóły jeszcze się nie zdarzyły - czeka na pierwsze rozwinięcie z
  NOWĄ treścią; jeśli już się zdarzyły - renderuje nową treść OD RAZU (czyści i buduje ponownie).
  Kafelek bez `details` i bez `actions` nie jest "toggleable" wcale (`is-toggleable` na `.cs-tile`
  decyduje o kursorze; `aria-expanded` nieobecny; klik nic nie robi) - `.cs-tile__body` i
  `.cs-tile__details` istnieją strukturalnie ZAWSZE (puste, `hidden`), to tylko interaktywność
  jest wyłączona.
- **Kto na nim stoi:** `ThinkingBlock.ts` (`createThinkingBlock`/`updateThinkingBlock`, rola
  `agent`) i `ToolCallDisplay.ts` (`createToolCallDisplay`/`createCompactToolChip`, rola
  `agent-muted`) - oba A1. `SubAgentBlock.ts` (rola `agent`) przepięty na Tile w A2 - wynik/błąd
  delegacji i pokwitowanie delegacji w tle (`opts.pending`) to WSZYSTKIE dziś kafelki `.cs-tile`,
  zero DOM-u `.cs-action-row` produkowanego gdziekolwiek w repo (poprawka nieścisłości z recenzji
  A1-fix: `ask_user`/lista zadań szły przez `ToolCallDisplay.ts`'s chip narzędzia, czyli TEŻ przez
  `createTile` już od A1 - `.cs-action-row` nigdy nie było ich domem; bloki systemowe błędu streamu
  (rola `system`, `modules/chat/chat/chat_streaming.ts`'s `handle_error`/`_onStreamStall`) doszły
  w A2). `.cs-ask-user` w `modules/chat/chat_view.css` to osobna, WCZEŚNIEJSZA markupa - poza
  zakresem A2, nie została ruszona.
- **Dwa różne wzorce aktualizacji "w locie" - świadomy wybór, nie przypadek.**
  `ToolCallDisplay.ts` NIE trzyma `TileHandle` po zwróceniu elementu: `chat_streaming.ts`
  aktualizuje status narzędzia (pending → ok/error) przez `toolDisplay.replaceWith(createCompactToolChip({...nowyStatus}))` - PEŁNE przebudowanie, bo tak już działało PRZED Tile (i tak
  działa dziś dla `SubAgentBlock` - `replaceWith(createSubAgentBlock({...}))`, ten sam wzorzec,
  ŚWIADOMIE niezmieniony w A2: `SubAgentBlock.ts` też NIE trzyma `TileHandle` między wywołaniami).
  `ThinkingBlock.ts` INACZEJ - w trakcie streamingu tekst
  rozumowania dopisuje się dziesiątki razy na sekundę, więc pełna przebudowa DOM-u za każdym
  razem byłaby zbyt kosztowna (dopisuje deltę zamiast podmieniać całość - test kosztu liniowego,
  nie kwadratowego: `ThinkingBlock.test.ts`). `createThinkingBlock` trzyma więc PRYWATNY
  `WeakMap<HTMLElement, TileHandle>` (klucz = element `.cs-tile` zwrócony wołającemu - publiczna
  sygnatura zostaje gołym `HTMLElement`, nie `TileHandle`), a `updateThinkingBlock` OMIJA nawet
  ten uchwyt dla samego tekstu (bezpośrednia mutacja `.cs-tile__details` przez `querySelector`,
  dokładnie jak przed Tile) - uchwyt służy WYŁĄCZNIE `finalizeThinkingBlock` (nowy eksport) do
  finalizacji końca streamingu: `setStatus('ok')` + `setTitle(t('thinking.done'))` +
  `expand(false)`. Auto-scroll w trakcie streamingu przewija `.cs-tile__body` (kontener z
  regułą `overflow` w `chat_view.css`), NIE `.cs-tile__details` (goły tekst, bez `overflow`) -
  naprawione B3 (recenzja A1-fix): przed poprawką `scrollTop` lądował na elemencie, który nigdy
  się nie przewijał, więc rosnący tekst myślenia znikał pod dolną krawędzią bloku.

### Reguła nadrzędna szczegółów kafelka (2.3.0, A2-fix)

Decyzja prowadzącego (spec A2-fix), zastępuje "details zawsze zaczynają się od summary": jak
`ToolCallDisplay.ts`'s `_buildToolDetails` skleja ciało kafelka narzędzia z `summary`/`detail`
zwróconych przez `formatToolOutput`. Dwa kroki, oba czyste funkcje w `ToolCallDisplay.ts`:

1. **`_coerceToText(value)`** - `summaryText`/`detailText` NAJPIERW przechodzą przez
   `typeof === 'string'` (inaczej: tablica -> KAŻDY element rekurencyjnie przez `_coerceToText`,
   potem `join('\n')`; obiekt -> `_safeStringify` (niżej); reszta -> `String(x)`). Bez
   `[object Object]` i bez wyjątku dla danych, które przyszły z JSON-a; poza zasięgiem zostają tablica
   zawierająca samą siebie (RangeError) i obiekt z `toJSON` zwracającym `undefined` (`[object Object]`),
   oba nieosiągalne z odpowiedzi narzędzia [measured, druga recenzja A3-fix] (B2 fix, A2-fix - regresja zmierzona względem HEAD: `kom_send`
   z `message` obiektem, `idea_review` z `comments` tablicą, `todo` z polem-obiektem rzucały
   `TypeError`/`appendChild` na obiekcie zamiast Node).
   ⚠️ **B1 fix (recenzja A3-fix, 2026-09-24): pierwsza wersja obiecywała "nigdy wyjątek" i tego
   nie dotrzymywała.** Gołe `value.join('\n')` na tablicy OBIEKTÓW wołało `String(obj)` na każdym
   elemencie - czyli dosłownie `[object Object]` (realny wejście: `idea_review`/`plan_review`
   `comments` jako tablica obiektów z zewnętrznego serwera MCP albo modelu - pole jest
   zadeklarowane jako `string`, ale nic tego nie waliduje). Gołe `JSON.stringify(value)` na
   obiekcie z cyklem rzucało `TypeError: Converting circular structure to JSON`, a na obiekcie z
   BigIntem `TypeError: Do not know how to serialize a BigInt` - `JSON` nie zna tego typu.
   Naprawa: tablica koercjuje KAŻDY element rekurencyjnie (element-obiekt trafia do
   `_safeStringify`, nie do gołego `String()`); obiekt idzie przez `_safeStringify(value, limit)`
   - `JSON.stringify` z replacerem (`bigint` -> `String(v)`, cykl wykryty `WeakSet` ->
   `'[cykl]'`), całość w `try/catch` z fallbackiem na listę kluczy obiektu (drugi, wewnętrzny
   `try/catch` na wypadek gdyby nawet `Object.keys` rzucił). Testy przez PUBLICZNE
   `createCompactToolChip`, dokładnie wejścia z sondy recenzenta:
   `ToolCallDisplay.coerce.test.ts`.
2. **`_composeTileBody(summaryText, detailText)`** - `detailText` w całości, gdy ZAWIERA
   `summaryText` (`.includes()`, **nie** `.startsWith()` - `ask_user`'s `detailText` zawsze
   niesie pytanie WEWNĄTRZ szablonu "Pytanie: {q}\n...", więc ten jeden generyczny check usuwa
   podwójne pytanie bez kodu specyficznego dla `ask_user`, B1 fix) albo gdy `summaryText` jest
   puste; inaczej oba, oddzielone pustą linią; gdy `detailText` puste: samo `summaryText`.

Ta sama reguła (osobna implementacja, ten sam kształt) dla kafelka systemowego błędu streamu
(`_buildStreamErrorTile` w `modules/chat/chat/chat_streaming.ts`): `details` TYLKO gdy tekst
DŁUŻSZY niż to, co mieści nagłówek (`truncatePreview`, 80 zn.) - inaczej bez `details` i bez
`is-toggleable` (nagłówek już pokazuje całą treść).

⚠️ **Pułapka `.includes()` na treści z JEDNEGO powtarzającego się znaku.** Fixture zbudowany z
jednego znaku, obcięty do dwóch różnych sufitów tym samym sufiksem `"..."` (np. 5000×`"x"`
ucięte do 120 zn. w summary i do 2000 zn. w detail), sprawia że KOŃCÓWKA dłuższego pola
dosłownie odpowiada krótszemu - `.includes()` wtedy wraca `true`, a ciało to sam `detailText`
(bez powtórzenia). To świadoma, zaakceptowana konsekwencja decyzji prowadzącego, nie regresja -
patrz test w `ToolCallDisplay.truncate.test.ts` ("regula nadrzedna" w nazwie testu).

Błąd narzędzia BEZ pola `toolCall.error` (np. `{success:false}`) ma OSOBNĄ, węższą regułę
(`_buildToolDetails`'s gałąź `isError`): `detailText` w całości, jeśli jest; inaczej
`summaryText` W CAŁOŚCI, ale TYLKO gdy dłuższy niż 80 zn. - krótki, GENERYCZNY label bez realnej
treści (np. `"Send error"` z `kom_send`, gdzie `data.message`/`data.error` są oba puste) zostaje
przy `chat.tile.tool.error_no_details`. Krótka, ale REALNA treść (np. `"Plik nie istnieje"` z
zewnętrznego narzędzia, złapana w `formatToolOutput`'s catch branch) trafia jako `detailText` już
od źródła - ten branch populuje `detail` ZAWSZE, gdy jest jakikolwiek tekst, niezależnie od
długości (B3 pkt 1, spec A2-fix - dawniej tylko gdy `s.length > 120`, więc krótka REALNA treść
dostawała mylące `error_no_details` zamiast echa własnego opisu).

---

## Public API (`modules/ui-components/index.ts`)

| Export | Rola |
|---|---|
| `createTile(spec)` | Komponent kafelka `.cs-tile` - fundament "Czat bez ścian" (2.3.0). Patrz sekcja "Tile" wyżej. |
| `TOOL_INFO` | Katalog `{ nazwa_narzędzia: { icon, label } }`. `label` jest **getterem** wołającym `t()` w momencie odczytu - dzięki temu respektuje aktualny język bez przebudowy katalogu. |
| `getToolIcon(toolName)` | Ikona dla narzędzia; nieznane narzędzie dostaje fallback (nie wybucha). |
| `describeToolCall(name, input)` | Tytuł kafelka narzędzia po ludzku (i18n `chat.tile.tool.*`, pl+en) - `read`/`search`/`write`/`list`/`web_search`/`web_read`/`todo`/`ask_user` mają własny szablon, reszta dostaje `chat.tile.tool.generic` (surowa nazwa narzędzia - jedyna dostępna informacja). Zero JSON-a, zero id w wyniku. **Totalna - nigdy nie rzuca** (B1 fix, recenzja A1-fix): pole złego typu od modelu (`path` jako tablica, `url` jako liczba, cały input jako string `"null"`) jest pomijane (`typeof === 'string'`), nie wywala tury/renderu historii. |
| `createToolCallDisplay(opts)` | Pełna karta wywołania narzędzia - kafelek `agent-muted` przez `createTile`. Surowe argumenty wejścia (techniczne) idą jako zwinięta sekcja "Szczegóły techniczne" w natywnym `<details>` na końcu ciała, WYŁĄCZNIE gdy `toolCall.input != null` (puste `{}` jako input DOSTAJE sekcję - to niepusty argument, po prostu bez pól; sekcja znika tylko przy braku pola `input` w ogóle). Ciało kafelka (sukces/pending) skleja **regułą nadrzędną szczegółów kafelka** (spec A2-fix, decyzja prowadzącego - patrz sekcja "Tile" niżej): `_composeTileBody(summaryText, detailText)`. Błąd bez pola `error` (np. `{success:false}`): `detailText` w całości, jeśli jest; inaczej `summaryText` W CAŁOŚCI, ale TYLKO gdy DŁUŻSZY niż 80 zn. (nagłówek go i tak ucina) - krótki, generyczny label bez realnej treści zostaje przy literalnym i18n `chat.tile.tool.error_no_details`; krótka, ale REALNA treść (np. "Plik nie istnieje" z zewnętrznego narzędzia) trafia do ciała, bo `formatToolOutput`'s catch branch populuje `detail` ZAWSZE, gdy jest jakikolwiek tekst (B3 pkt 1, spec A2-fix). `todo`/`chat_todo`: nagłówek = `"{done}/{total}"` (+ tytuł listy, jeśli agent go podał), ciało = CAŁA lista `"✓ tekst"`/`"○ tekst"` (spec A2, sekcja 2); po `TodoTool.finish()` (lista PUSTA + `finished:true`) nagłówek i ciało = `chat.tile.todo.finished` ("zamknięta"/"closed"), nie "0/0" (uwaga 2, spec A2-fix). `ask_user`: nagłówek = PYTANIE (nie odpowiedź), ciało `t('chat.tile.ask.body', {question, answer})` = `"Question: {question}\nAnswer: {answer}"` niezależnie od długości pytania - regułę nadrzędną (`.includes()`) wystarcza to zawrzeć raz, bez kodu specyficznego dla `ask_user` (B1 fix, spec A2-fix: dawniej pytanie potrafiło się powtórzyć - raz jako summary, raz w szablonie). Nieudane `ask_user` odtworzone z HISTORII (`chat_messages.ts` podaje `error: tcOutput.error`, kod typu `"ask_user.timeout"`) dostaje TEN SAM szablon z kodem błędu zmapowanym przez i18n na tekst po ludzku (`chat.tile.ask.timeout`/`chat.tile.ask.failed`), nie surowy kod (B1 fix). |
| `createCompactToolChip(opts)` | TEN SAM kafelek co `createToolCallDisplay`, bez sekcji technicznej, opakowany w `span.cs-tool-chip-wrap` (zgodność wsteczna: TYLKO jego test, `render_messages.emptyAssistant.test.ts`, szuka tej klasy - `chat_messages.ts` sam jej nie czyta) - tryb `pkmAssistant.compactToolChips` w historii czatu. |
| `AttachmentManager` | Klasa. `new AttachmentManager(container, plugin, { onChange })` → `buildMessageContent()` / `hasAttachments()` / `clear()`. |
| `MentionAutocomplete` | Klasa. `new MentionAutocomplete(textarea, plugin, { onChange })` → `getMentions()` / `hasMentions()` / `clear()` / `destroy()`. |
| `createSubAgentBlock(opts)` | Kafelek `agent` (A2, przez `createTile`) wyniku/błędu delegacji ALBO pokwitowania w tle (`opts.pending === true` - status `pending` zamiast `ok`/`error`, `opts.response` niesie w tym trybie linie pokwitowania, nie wynik). Nagłówek = tytuł po ludzku (`"Sub-agent {name}"` / `"Zlecono w tle: {name}"`) + skrót zadania (`opts.query`, TYLKO gdy `typeof === 'string'` - uwaga 3, spec A2-fix: `query` odtworzone z historii bywa obiektem, bez tej bramki naglówek pokazywał `[object Object]`; ucięty przez Tile) + czas trwania w `meta` - ZERO nazw narzędzi i ZERO liczby tokenów (werdykt właściciela: "żadne techniczne sprawy"). `details` (leniwie): akapit "Task"/akapit "Result" + stopka `"Used: {narzędzia unikalne} ({N calls})"` (`{N calls}` już w pełni odmienione przez `pluralCalls(n, locale)` - uwaga 1, spec A2-fix: pl 1 "wywołanie", 2-4 poza 12-14 "wywołania", reszta "wywołań"; en 1 "call", reszta "calls" - i18n interpoluje TYLKO gotowy tekst, szablon sam nie odmienia) przy sukcesie; komunikat błędu (albo `chat.tile.sub.error_no_details` = "Sub-agent zgłosił błąd bez opisu"/"Sub-agent reported an error without details", gdy `opts.response` puste - uwaga 7, WŁASNY klucz, nie tekst narzędzia) + akapit "Task" przy błędzie (bez stopki); skrót zadania + linie od wołacza (ostatnia ZAWSZE `"Identyfikator: {id}"`, pl - `"Id: {id}"`, en) przy pokwitowaniu w tle - identyfikator NIGDY w nagłówku, linie budowane przez `buildBackgroundReceiptText` w `modules/chat/chat/chat_streaming.ts` (uwaga 5, spec A2-fix - ta sama funkcja renderuje pokwitowanie odtworzone z HISTORII, `chat_messages.ts`, uwaga 10). |
| `createPendingSubAgentBlock(type, agentName)` | Kafelek „w toku" (A2, rola `agent`, status `pending`, BEZ `details`/`actions` - nie jest jeszcze toggleable) - podmieniany PRZEZ WOŁACZA na finalny `createSubAgentBlock(...)` po powrocie suba (`toolDisplay.replaceWith(...)`, pełne przebudowanie, ten sam wzorzec co `ToolCallDisplay.ts`). |
| `createThinkingBlock(text, isStreaming, startTime)` | Wiersz myślenia modelu - kafelek `agent` przez `createTile`, rozwinięty (`is-streaming`) w trakcie streamingu. |
| `updateThinkingBlock(el, text, ...)` | Dolewa treść do istniejącego wiersza w trakcie streamingu (bez przebudowy DOM). `text` to ślad ZAKUMULOWANY, więc funkcja pamięta ostatnio wpisaną treść NA ELEMENCIE (`_pkmThinkingText`) i dopisuje samą deltę; identyczny tekst = zero zapisów i zero odczytów `scrollHeight` (wymuszony layout przy rozwiniętym bloku). Nie czytaj `textContent`, żeby to porównać - jego getter jest O(n). |
| `finalizeThinkingBlock(el)` | Koniec streamingu: zdejmuje `is-streaming`, `setStatus('ok')`, `setTitle(t('thinking.done'))`, zwija kafelek. Wołane z czterech miejsc w `chat_streaming.ts` (naturalny koniec, backstop przed kontynuacją, Stop, błąd) zamiast dawnego gołego `classList.remove('streaming')`. `block` nieznany uchwytowi (`WeakMap`) albo `null`/`undefined` - no-op, nie rzuca. |
| `renderFilterBar` / `getCategoryLabel` / `renderUseAtAgentButton` / `renderTemplateVersionBadge` / `renderCardAction` | Prymitywy kart Zaplecza (pasek filtrów, etykieta kategorii, guzik „Użyj u agenta…", plakietka `vN`, akcja na karcie) z `backstage_helpers.js`. Wołają je zakładki Zaplecza z `modules/skills` i `modules/sub-agents` - dwa moduły, więc dom klocka jest tutaj, nie w shellu. |
| `DiffModal` | Przyjazny diff przed `vault_write` (przekreślenia / podświetlenia zamiast surowego patcha) + `waitForApproval()`. Jedyny wołacz: `modules/tools/MCPClient.js` leniwym `import()`. Gdy wołacz poda `opts.rememberAvailable:true`, renderuje checkbox „Nie pytaj więcej w tej sesji" - stan w chwili Zatwierdź trafia do PUBLICZNEGO pola instancji `rememberForSession` (zawsze `false` po Odrzuć), czytanego PO rozstrzygnięciu `waitForApproval()` - jej kontrakt `Promise<'approve'\|'deny'>` się nie zmienił. |
| `ConfirmModal` / `confirmModal(app, opts)` | Zamiennik natywnego `confirm()` (wytyczne katalogu: no-alert). Kontrakt: rozstrzyga się raz - klik guzika potwierdzenia = `true`, Anuluj / Esc / klik poza modalem = `false`. `opts: ConfirmModalOptions`, w tym `destructive: true` → guzik potwierdzenia dostaje klasę `mod-warning` (zamiast `mod-cta`) i fokus startowy leci na Anuluj, żeby przypadkowy Enter/Spacja zaraz po otwarciu nie potwierdziły akcji niszczącej. |
| `PluginItemView` | Baza widoków workspace'u - `extends` Obsidian `ItemView`. Statyki `viewType` / `displayText` / `iconName`, `register(plugin)` (**sam typ widoku**) + `registerOpenCommand(plugin)` (komenda palety „otwórz"), JEDNA sygnatura `open(workspace, state?, active?)`, `whenRuntimeLoaded()` i **opcjonalna** `renderView` (widok czatu dostaje ją miksinem, więc `abstract` dałoby TS2515). Kontrakt: `core/runtime/contracts.ts`. Dziedziczą: `ChatView` (`modules/chat`) i `ReleaseNotesView` (`modules/shell`). |

`TOOL_DESCRIPTIONS` świadomie NIE jest w barrelu - zero konsumentów. Opisy narzędzi, które REALNIE widzi user i model, żyją w i18n `mcp.<tool>.desc` (idą do API razem z definicją narzędzia).

---

## Zależności

**Importuje z:**
- `modules/crystal-soul/` (`UiIcons`, `setSvg`, `IconGenerator`) - ikony i wygląd
- `core/i18n` (`t`, `getDateLocale`), `core/utils/Logger`
- `obsidian` (`ItemView` - tylko `PluginItemView`)

**Importowany przez:**
- `modules/chat/chat/chat_streaming.js` - bloki narzędzi / myślenia / subów w trakcie streamingu
- `modules/chat/chat/chat_messages.js` - te same bloki przy renderze historii
- `modules/chat/chat/chat_ui.js` - `MentionAutocomplete` + `AttachmentManager` przy polu wpisywania
- `modules/chat/chat/chat_popovers.js` - `TOOL_INFO`
- `modules/sub-agents/SubAgentDetailView.js`, `modules/sub-agents/SubAgentsBackstageTab.js` - `TOOL_INFO` + `getToolIcon`
- `modules/sub-agents/SubAgentEditorModal.js` - `TOOL_INFO`
- `modules/skills/SkillsBackstageTab.js` - prymitywy kart Zaplecza
- `modules/tools/MCPClient.js` - `DiffModal` leniwym `import()` przed `vault_write`
- `modules/chat/chat_view.js` (`ChatView extends PluginItemView`) + `modules/shell/ReleaseNotesView.ts` (`ReleaseNotesView extends PluginItemView`) - oba widoki importują wprost stąd

**Zero importów z `modules/chat`, `modules/sub-agents`, `modules/tools`, `modules/shell`** - kierunek jest jednostronny (konsumenci → ui-components). Nie odwracaj go: klocek UI nie może wiedzieć, kto go rysuje.

**Dlaczego `DiffModal` i `backstage_helpers` mieszkają akurat tu.** Oba mają wołaczy wyłącznie w modułach NIŻSZYCH niż shell (`modules/tools` / `modules/skills` + `modules/sub-agents`), więc mieszkanie w shellu zmuszałoby te moduły do importu „w górę", z barrela shella. `backstage_helpers` spełnia regułę wstępu wprost (≥2 moduły), `DiffModal` ma jednego wołacza, ale to modal generyczny (podgląd zmiany pliku) - nie należy ani do narzędzi, ani do widoków. Barrel ui-components i tak nie jest obsidian-free (`PluginItemView`), więc dołożenie modalu niczego nie psuje.

---

## Gotchas

- ⚠️ **`ToolCallDisplay.ts` jest blisko monolitu** - próg czytelności jeszcze nie przekroczony, ale plik rośnie z każdym nowym narzędziem (katalog `TOOL_INFO` = jeden wpis per narzędzie). Zanim dorzucisz kolejną porcję, rozważ wyniesienie katalogu do osobnego pliku (`toolCatalog.ts`) - sam render bloku jest wtedy krótki.
- ⚠️ **`TOOL_INFO[x].label` to getter, nie string.** Nie cache'uj go do zmiennej przy starcie ani nie serializuj katalogu - po zmianie języka odczytana wcześniej wartość zostanie stara. Czytaj przy renderze.
- ⚠️ **Nieznane narzędzie musi się rysować.** `getToolIcon` ma fallback, bo agent może wywołać narzędzie z userowego serwera MCP, którego nie ma w katalogu. Nie dodawaj tu twardego throw. `getToolCallLabel` zwraca surową nazwę narzędzia, gdy w i18n nie ma klucza `tool.<name>` - inaczej czat renderowałby dosłowne `tool.serwer__tool` dla narzędzi z zewnętrznych serwerów MCP.
- ⚠️ **`formatToolInputHint` (dawniej `formatToolInput`) nigdy nie zwraca surowego JSON-a** (B2 fix, recenzja A1-fix). Nierozpoznane narzędzie w stanie `pending` (`generate_image`, `kom_list`, KAŻDE narzędzie z zewnętrznego serwera MCP) dostaje pustą podpowiedź (`''`), nie `JSON.stringify(input)`. Dokładasz nowy `case` do `formatToolInputHint`? Rób to też w `formatToolInputDetail` i `formatToolOutput`, jeśli narzędzie ma sensowny skrót/wynik - trzy switche w tym pliku rozjeżdżają się łatwo (patrz `ToolCallDisplay.searchCase.test.ts`).
- ⚠️ **Nagłówek kafelka (`.cs-tile__summary`) nie pokazuje surowego JSON-a w praktyce, ale NIE dlatego, że każda gałąź `formatToolInputHint`/`formatToolOutput` jest utwardzona z osobna** (poprawka nieścisłości z Porządków po A1, punkt 4/3 - poprzednia wersja tej notatki twierdziła "nigdy nie ma prawa pokazać `{`" jako właściwość TYCH funkcji; nieprawda, kilka gałęzi oddaje pole wprost jako `data.xxx || ''` bez `typeof`, np. `search`'s `data.query || ''` - narzędzie z zewnętrznego serwera MCP może podać `query` jako obiekt). Gwarancję daje JEDNA bramka niżej w łańcuchu: `_buildToolTile` (`ToolCallDisplay.ts`) rzutuje wynik obu funkcji przez `typeof rawSummary === 'string' ? rawSummary : undefined` TUŻ PRZED przekazaniem do `createTile` - jeden `typeof` chroniący WSZYSTKIE gałęzie naraz, zamiast utwardzania każdego `case` z osobna. Dokładasz nową ścieżkę budowania `summary` w tym module (poza `_buildToolTile`)? Dodaj tam TAKĄ SAMĄ bramkę - `Tile.ts`'s `truncatePreview`/`textContent` zamienia obiekt w dosłowne `[object Object]`, nie rzuca.
- ⚠️ **`.cs-tile__title` ma `min-width:0` + `text-overflow:ellipsis`, `.cs-tile__summary` dzieli z nim flex** (B4 fix, recenzja A1-fix). Bez tego długi tytuł (zapytanie, URL, ścieżka z `describeToolCall`, nieobcięte przez i18n) wypychał kropkę statusu (`.cs-tile__dot`) poza widoczny obszar czatu w wąskim sidebarze. Dokładasz pole do nagłówka `.cs-tile__head`? Dopisz `flex-shrink: 0`, inaczej ten sam bug wróci dla nowego pola.
- ⚠️ **`MentionAutocomplete` i `AttachmentManager` trzymają nasłuchy na DOM** - czat woła `destroy()` / `clear()` przy zamknięciu zakładki. Jak wpinasz je w nowe miejsce, zadbaj o sprzątanie, inaczej zostają wiszące listenery per otwarta zakładka.
- ⚠️ **Wynik `@` to chip nad inputem, nie tekst w textarei.** Świadome: ścieżki ze spacjami rozwalały wariant inline.
- ⚠️ **Testy DOM modali (`extends Modal`) DZIAŁAJĄ w AVA** dzięki atrapie `obsidian` z repo harnessu (`test-support/register-obsidian-for-ava.mjs` w tym repo tylko ją lokalizuje) - `Modal.open()` w tej atrapie jest jednak NO-OPEM, więc test woła `onOpen()` wprost (tak jak realny Obsidian robi to za kulisami `open()`). Guziki dostają napis przez `setSvgLabel` → `el.appendText(...)` (rozszerzenie DOM Obsidiana), którego atrapa DOM-u (`dom-shim.ts`) NIE implementuje - nieznana metoda jest łańcuchowalnym no-opem, więc `textContent` guzika zostaje pusty. Odróżniaj guziki po klasie CSS (`mod-cta`/`mod-warning`/`mod-muted`), nie po tekście - patrz `DiffModal.test.ts`.
