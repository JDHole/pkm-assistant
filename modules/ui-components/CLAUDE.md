# modules/ui-components/

**Współdzielone klocki UI.** Kawałki interfejsu, których używa więcej niż jeden moduł: bloki akcji w czacie (narzędzie / myślenie / sub-agent), załączniki w polu wpisywania i autouzupełnianie `@`.

Zasada wstępu jak w `core/`, tylko dla UI: trafia tu klocek, którego potrzebuje **≥2 moduły**. Klocek używany przez jeden moduł zostaje u niego. Tu nie ma logiki biznesowej - same funkcje budujące DOM + klasy sterujące widgetem.

---

## Co tu jest

```
modules/ui-components/
├── index.ts                 # jedyne drzwi publiczne (barrel)
├── CLAUDE.md                # ten plik
├── ToolCallDisplay.ts       # katalog TOOL_INFO (ikona + etykieta i18n per narzędzie) + pełny blok wywołania narzędzia + kompaktowy chip
├── AttachmentManager.ts     # załączniki w czacie: 📎 picker, drag & drop, wklejenie z schowka (obrazy → base64, tekst → kontekst, PDF → ekstrakcja)
├── MentionAutocomplete.ts   # dropdown `@` nad polem czatu: notatki i foldery vaulta, wynik jako chip nad inputem (nie tekst inline)
├── SubAgentBlock.ts         # rozwijalny wiersz wyniku sub-agenta (zapytanie, odpowiedź, narzędzia, tokeny)
├── ThinkingBlock.ts         # rozwijalny wiersz „Myślenie" (reasoning modelu + czas + status)
├── PluginItemView.ts        # bazowa klasa widoków (extends Obsidian `ItemView`)
├── DiffModal.ts             # podgląd diffa przed `vault_write`
├── diffLines.ts             # silnik diffa linia-po-linii dla DiffModal, bez importu `obsidian` (testowalny w AVA)
├── ConfirmModal.ts          # zamiennik natywnego `confirm()` (wytyczne katalogu: no-alert)
├── textPreview.ts           # `truncatePreview(text, maxLength=500)` - wspólne obcinanie podglądu (InlineCommentModal, SendToAgentModal)
└── backstage_helpers.ts     # prymitywy kart Zaplecza
```

Wszystkie bloki renderują się jako Crystal Soul `.cs-action-row` - wygląd i CSS należą do `modules/crystal-soul/`, tu jest tylko struktura DOM.

---

## Public API (`modules/ui-components/index.ts`)

| Export | Rola |
|---|---|
| `TOOL_INFO` | Katalog `{ nazwa_narzędzia: { icon, label } }`. `label` jest **getterem** wołającym `t()` w momencie odczytu - dzięki temu respektuje aktualny język bez przebudowy katalogu. |
| `getToolIcon(toolName)` | Ikona dla narzędzia; nieznane narzędzie dostaje fallback (nie wybucha). |
| `createToolCallDisplay(opts)` | Pełny rozwijalny blok wywołania narzędzia: nagłówek (ikona + etykieta + status) → body (argumenty + wynik). |
| `createCompactToolChip(opts)` | Jednolinijkowy chip zamiast pełnego bloku - tryb `pkmAssistant.compactToolChips` w historii czatu. |
| `AttachmentManager` | Klasa. `new AttachmentManager(container, plugin, { onChange })` → `buildMessageContent()` / `hasAttachments()` / `clear()`. |
| `MentionAutocomplete` | Klasa. `new MentionAutocomplete(textarea, plugin, { onChange })` → `getMentions()` / `hasMentions()` / `clear()` / `destroy()`. |
| `createSubAgentBlock(opts)` | Wiersz zakończonego zadania sub-agenta. `opts.pending === true` przełącza kryształ statusu na pulsujący („trwa") zamiast zielonego („gotowe") - używa tego pokwitowanie delegacji w tle, gdzie w `response` siedzi informacja o starcie, a nie wynik. |
| `createPendingSubAgentBlock(opts)` | Wiersz „w toku" - podmieniany na finalny po powrocie suba. |
| `createThinkingBlock(text, isStreaming, startTime)` | Wiersz myślenia modelu. |
| `updateThinkingBlock(el, text, ...)` | Dolewa treść do istniejącego wiersza w trakcie streamingu (bez przebudowy DOM). `text` to ślad ZAKUMULOWANY, więc funkcja pamięta ostatnio wpisaną treść NA ELEMENCIE (`_pkmThinkingText`) i dopisuje samą deltę; identyczny tekst = zero zapisów i zero odczytów `scrollHeight` (wymuszony layout przy rozwiniętym bloku). Nie czytaj `textContent`, żeby to porównać - jego getter jest O(n). |
| `renderFilterBar` / `getCategoryLabel` / `renderUseAtAgentButton` / `renderTemplateVersionBadge` / `renderCardAction` | Prymitywy kart Zaplecza (pasek filtrów, etykieta kategorii, guzik „Użyj u agenta…", plakietka `vN`, akcja na karcie) z `backstage_helpers.js`. Wołają je zakładki Zaplecza z `modules/skills` i `modules/sub-agents` - dwa moduły, więc dom klocka jest tutaj, nie w shellu. |
| `DiffModal` | Przyjazny diff przed `vault_write` (przekreślenia / podświetlenia zamiast surowego patcha) + `waitForApproval()`. Jedyny wołacz: `modules/tools/MCPClient.js` leniwym `import()`. |
| `ConfirmModal` / `confirmModal(app, opts)` | Zamiennik natywnego `confirm()` (wytyczne katalogu: no-alert). Kontrakt: rozstrzyga się raz - klik guzika potwierdzenia = `true`, Anuluj / Esc / klik poza modalem = `false`. `opts: ConfirmModalOptions`, w tym `destructive: true` → guzik potwierdzenia dostaje klasę `mod-warning` (zamiast `mod-cta`) i fokus startowy leci na Anuluj, żeby przypadkowy Enter/Spacja zaraz po otwarciu nie potwierdziły akcji niszczącej. |
| `PluginItemView` | Baza widoków workspace'u - `extends` Obsidian `ItemView`. Statyki `viewType` / `displayText` / `iconName`, `register(plugin)` (widok + komenda otwarcia), JEDNA sygnatura `open(workspace, state?, active?)`, `whenRuntimeLoaded()` i **opcjonalna** `renderView` (widok czatu dostaje ją miksinem, więc `abstract` dałoby TS2515). Kontrakt: `core/runtime/contracts.ts`. Dziedziczą: `ChatView` (`modules/chat`) i `ReleaseNotesView` (`modules/shell`). |

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
- ⚠️ **`MentionAutocomplete` i `AttachmentManager` trzymają nasłuchy na DOM** - czat woła `destroy()` / `clear()` przy zamknięciu zakładki. Jak wpinasz je w nowe miejsce, zadbaj o sprzątanie, inaczej zostają wiszące listenery per otwarta zakładka.
- ⚠️ **Wynik `@` to chip nad inputem, nie tekst w textarei.** Świadome: ścieżki ze spacjami rozwalały wariant inline.
