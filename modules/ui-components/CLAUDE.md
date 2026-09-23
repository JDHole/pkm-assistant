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
├── SubAgentBlock.ts         # rozwijalny wiersz wyniku sub-agenta (zapytanie, odpowiedź, narzędzia, tokeny) - dziś jeszcze na `.cs-action-row`, nie na Tile (A2/A3)
├── ThinkingBlock.ts         # rozwijalny wiersz „Myślenie" (reasoning modelu + czas + status), kafelek przez `createTile`
├── PluginItemView.ts        # bazowa klasa widoków (extends Obsidian `ItemView`); rejestracja rozbita na `register` (typ widoku, przed odtworzeniem zakładek) i `registerOpenCommand` (komenda palety, PO `setLocale()` - Obsidian zapamiętuje nazwę w chwili `addCommand`)
├── DiffModal.ts             # podgląd diffa przed `vault_write`
├── diffLines.ts             # silnik diffa linia-po-linii dla DiffModal, bez importu `obsidian` (testowalny w AVA)
├── ConfirmModal.ts          # zamiennik natywnego `confirm()` (wytyczne katalogu: no-alert)
├── textPreview.ts           # `truncatePreview(text, maxLength=500)` - wspólne obcinanie podglądu (InlineCommentModal, SendToAgentModal)
└── backstage_helpers.ts     # prymitywy kart Zaplecza
```

Dwie rodziny CSS żyją naraz (2.3.0): `ThinkingBlock`/`ToolCallDisplay` renderują się jako kafelek
`.cs-tile` przez `createTile` (patrz sekcja "Tile" niżej); `SubAgentBlock` i wszystko, czego
jeszcze A1 nie dotknęło, zostaje na dawnym Crystal Soul `.cs-action-row` - wygląd i CSS OBU
rodzin (`.cs-tile` i `.cs-action-row`) żyją w `modules/chat/chat_view.css`, tu jest tylko
struktura DOM (poprawka nieścisłości z recenzji A1-fix: `.cs-action-row` CSS nie jest w
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
  `agent-muted`) - oba A1. Jedynym pozostałym producentem `.cs-action-row` jest dziś
  `SubAgentBlock.ts` (A2/A3 przepnie go na Tile osobno) - poprawka nieścisłości z recenzji
  A1-fix: `ask_user`/lista zadań/bloki systemowe mają WŁASNĄ markupę poza tą dwójką (np.
  `.cs-ask-user` w `modules/chat/chat_view.css`), nigdy nie stały na `.cs-action-row`.
- **Dwa różne wzorce aktualizacji "w locie" - świadomy wybór, nie przypadek.**
  `ToolCallDisplay.ts` NIE trzyma `TileHandle` po zwróceniu elementu: `chat_streaming.ts`
  aktualizuje status narzędzia (pending → ok/error) przez `toolDisplay.replaceWith(createCompactToolChip({...nowyStatus}))` - PEŁNE przebudowanie, bo tak już działało PRZED Tile (i tak
  działa dziś dla `SubAgentBlock`). `ThinkingBlock.ts` INACZEJ - w trakcie streamingu tekst
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

---

## Public API (`modules/ui-components/index.ts`)

| Export | Rola |
|---|---|
| `createTile(spec)` | Komponent kafelka `.cs-tile` - fundament "Czat bez ścian" (2.3.0). Patrz sekcja "Tile" wyżej. |
| `TOOL_INFO` | Katalog `{ nazwa_narzędzia: { icon, label } }`. `label` jest **getterem** wołającym `t()` w momencie odczytu - dzięki temu respektuje aktualny język bez przebudowy katalogu. |
| `getToolIcon(toolName)` | Ikona dla narzędzia; nieznane narzędzie dostaje fallback (nie wybucha). |
| `describeToolCall(name, input)` | Tytuł kafelka narzędzia po ludzku (i18n `chat.tile.tool.*`, pl+en) - `read`/`search`/`write`/`list`/`web_search`/`web_read`/`todo`/`ask_user` mają własny szablon, reszta dostaje `chat.tile.tool.generic` (surowa nazwa narzędzia - jedyna dostępna informacja). Zero JSON-a, zero id w wyniku. **Totalna - nigdy nie rzuca** (B1 fix, recenzja A1-fix): pole złego typu od modelu (`path` jako tablica, `url` jako liczba, cały input jako string `"null"`) jest pomijane (`typeof === 'string'`), nie wywala tury/renderu historii. |
| `createToolCallDisplay(opts)` | Pełna karta wywołania narzędzia - kafelek `agent-muted` przez `createTile`. Surowe argumenty wejścia (techniczne) idą jako zwinięta sekcja "Szczegóły techniczne" w natywnym `<details>` na końcu ciała. Ciało (`details` kafelka) ZAWSZE zaczyna się od pełnego (nieuciętego) `formatToolOutput(...).summary`, potem `.detail` jeśli jest (B5 fix, recenzja A1-fix) - nagłówek tnie summary do 80 zn., więc bez tego dłuższa treść (odpowiedź `ask_user`, wynik zewnętrznego narzędzia MCP) była nieosiągalna. Błąd bez pola `error` (np. `{success:false}`): nagłówek zostaje przy summary z wyniku, a ciało - gdy nie ma nawet `detail` - dostaje literalny tekst i18n `chat.tile.tool.error_no_details`. |
| `createCompactToolChip(opts)` | TEN SAM kafelek co `createToolCallDisplay`, bez sekcji technicznej, opakowany w `span.cs-tool-chip-wrap` (zgodność wsteczna: TYLKO jego test, `render_messages.emptyAssistant.test.ts`, szuka tej klasy - `chat_messages.ts` sam jej nie czyta) - tryb `pkmAssistant.compactToolChips` w historii czatu. |
| `AttachmentManager` | Klasa. `new AttachmentManager(container, plugin, { onChange })` → `buildMessageContent()` / `hasAttachments()` / `clear()`. |
| `MentionAutocomplete` | Klasa. `new MentionAutocomplete(textarea, plugin, { onChange })` → `getMentions()` / `hasMentions()` / `clear()` / `destroy()`. |
| `createSubAgentBlock(opts)` | Wiersz zakończonego zadania sub-agenta. `opts.pending === true` przełącza kryształ statusu na pulsujący („trwa") zamiast zielonego („gotowe") - używa tego pokwitowanie delegacji w tle, gdzie w `response` siedzi informacja o starcie, a nie wynik. |
| `createPendingSubAgentBlock(opts)` | Wiersz „w toku" - podmieniany na finalny po powrocie suba. |
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
- ⚠️ **`formatToolInputHint` (dawniej `formatToolInput`) nigdy nie zwraca surowego JSON-a** (B2 fix, recenzja A1-fix). Nierozpoznane narzędzie w stanie `pending` (`generate_image`, `kom_list`, KAŻDE narzędzie z zewnętrznego serwera MCP) dostaje pustą podpowiedź (`''`), nie `JSON.stringify(input)` - nagłówek kafelka (`.cs-tile__summary`) nie ma prawa nigdy pokazać `{`. Dokładasz nowy `case` do `formatToolInputHint`? Rób to też w `formatToolInputDetail` i `formatToolOutput`, jeśli narzędzie ma sensowny skrót/wynik - trzy switche w tym pliku rozjeżdżają się łatwo (patrz `ToolCallDisplay.searchCase.test.ts`).
- ⚠️ **`.cs-tile__title` ma `min-width:0` + `text-overflow:ellipsis`, `.cs-tile__summary` dzieli z nim flex** (B4 fix, recenzja A1-fix). Bez tego długi tytuł (zapytanie, URL, ścieżka z `describeToolCall`, nieobcięte przez i18n) wypychał kropkę statusu (`.cs-tile__dot`) poza widoczny obszar czatu w wąskim sidebarze. Dokładasz pole do nagłówka `.cs-tile__head`? Dopisz `flex-shrink: 0`, inaczej ten sam bug wróci dla nowego pola.
- ⚠️ **`MentionAutocomplete` i `AttachmentManager` trzymają nasłuchy na DOM** - czat woła `destroy()` / `clear()` przy zamknięciu zakładki. Jak wpinasz je w nowe miejsce, zadbaj o sprzątanie, inaczej zostają wiszące listenery per otwarta zakładka.
- ⚠️ **Wynik `@` to chip nad inputem, nie tekst w textarei.** Świadome: ścieżki ze spacjami rozwalały wariant inline.
- ⚠️ **Testy DOM modali (`extends Modal`) DZIAŁAJĄ w AVA** dzięki atrapie `obsidian` z repo harnessu (`test-support/register-obsidian-for-ava.mjs` w tym repo tylko ją lokalizuje) - `Modal.open()` w tej atrapie jest jednak NO-OPEM, więc test woła `onOpen()` wprost (tak jak realny Obsidian robi to za kulisami `open()`). Guziki dostają napis przez `setSvgLabel` → `el.appendText(...)` (rozszerzenie DOM Obsidiana), którego atrapa DOM-u (`dom-shim.ts`) NIE implementuje - nieznana metoda jest łańcuchowalnym no-opem, więc `textContent` guzika zostaje pusty. Odróżniaj guziki po klasie CSS (`mod-cta`/`mod-warning`/`mod-muted`), nie po tekście - patrz `DiffModal.test.ts`.
