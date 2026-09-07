# modules/ui-components/

**Współdzielone klocki UI.** Kawałki interfejsu, których używa więcej niż jeden moduł: bloki akcji w czacie (narzędzie / myślenie / sub-agent), załączniki w polu wpisywania i autouzupełnianie `@`.

Zasada wstępu jak w `core/`, tylko dla UI: trafia tu klocek, którego potrzebuje **≥2 moduły**. Klocek używany przez jeden moduł zostaje u niego. Tu nie ma logiki biznesowej — same funkcje budujące DOM + klasy sterujące widgetem.

**Status:** 🚀 **ACTIVE.** Kod fizycznie w `modules/ui-components/` (S10 Z12, 2026-05-02).

---

## Co tu jest

```
modules/ui-components/
├── index.ts                 # 43 LOC — jedyne drzwi publiczne (barrel, 21 eksportów: 10 po S30 Z4 + 7 z S31 + 4 release 2.2.0 — zmierzone 2026-09-04)
├── CLAUDE.md                # ten plik
├── ToolCallDisplay.ts       # 637 LOC — katalog TOOL_INFO (ikona + etykieta i18n per narzędzie) + pełny blok wywołania narzędzia + kompaktowy chip
├── AttachmentManager.ts     # 612 LOC — załączniki w czacie: 📎 picker, drag & drop, wklejenie z schowka (obrazy → base64, tekst → kontekst, PDF → ekstrakcja)
├── MentionAutocomplete.ts   # 334 LOC — dropdown `@` nad polem czatu: notatki i foldery vaulta, wynik jako chip nad inputem (nie tekst inline)
├── SubAgentBlock.ts         # 172 LOC — rozwijalny wiersz wyniku sub-agenta (zapytanie, odpowiedź, narzędzia, tokeny)
├── ThinkingBlock.ts         #  76 LOC — rozwijalny wiersz „Myślenie" (reasoning modelu + czas + status)
├── PluginItemView.ts        # clean-room/F2: bazowa klasa widoków (extends Obsidian `ItemView`) — zaimplementowana, scalona 2026-09-06
├── DiffModal.ts             # 201 LOC — S31: podgląd diffa przed `vault_write` (był `modules/shell/`)
├── diffLines.ts             # silnik diffa linia-po-linii dla DiffModal, bez importu `obsidian` (testowalny w AVA)
├── ConfirmModal.ts          #  71 LOC — release 2.2.0: zamiennik natywnego `confirm()` (wytyczne katalogu: no-alert)
├── textPreview.ts           # `truncatePreview(text, maxLength=500)` — wspólne obcinanie podglądu (InlineCommentModal, SendToAgentModal)
└── backstage_helpers.ts     # 126 LOC — S31: prymitywy kart Zaplecza (był `modules/shell/sidebar/`)
```

Razem **~2178 LOC** produkcji (stan 2026-07-30, po S31).

Wszystkie bloki renderują się jako Crystal Soul `.cs-action-row` — wygląd i CSS należą do `modules/crystal-soul/`, tu jest tylko struktura DOM.

---

## Public API (`modules/ui-components/index.ts`)

| Export | Rola |
|---|---|
| `TOOL_INFO` | Katalog `{ nazwa_narzędzia: { icon, label } }`. `label` jest **getterem** wołającym `t()` w momencie odczytu — dzięki temu respektuje aktualny język bez przebudowy katalogu. |
| `getToolIcon(toolName)` | Ikona dla narzędzia; nieznane narzędzie dostaje fallback (nie wybucha). |
| `createToolCallDisplay(opts)` | Pełny rozwijalny blok wywołania narzędzia: nagłówek (ikona + etykieta + status) → body (argumenty + wynik). |
| `createCompactToolChip(opts)` | Jednolinijkowy chip zamiast pełnego bloku — tryb `pkmAssistant.compactToolChips` w historii czatu. |
| `AttachmentManager` | Klasa. `new AttachmentManager(container, plugin, { onChange })` → `buildMessageContent()` / `hasAttachments()` / `clear()`. (`getAttachments()` skasowana AUD-dead-code-247, 2026-09-02 — zero wołaczy w repo.) |
| `MentionAutocomplete` | Klasa. `new MentionAutocomplete(textarea, plugin, { onChange })` → `getMentions()` / `hasMentions()` / `clear()` / `destroy()`. |
| `createSubAgentBlock(opts)` | Wiersz zakończonego zadania sub-agenta. **F2:** `opts.pending === true` przełącza kryształ statusu na pulsujący („trwa") zamiast zielonego („gotowe") — używa tego pokwitowanie delegacji w tle, gdzie w `response` siedzi informacja o starcie, a nie wynik. |
| `createPendingSubAgentBlock(opts)` | Wiersz „w toku" — podmieniany na finalny po powrocie suba. |
| `createThinkingBlock(text, isStreaming, startTime)` | Wiersz myślenia modelu. |
| `updateThinkingBlock(el, text, ...)` | Dolewa treść do istniejącego wiersza w trakcie streamingu (bez przebudowy DOM). **AUD-wydajnosc-096 (2026-09-02):** `text` to ślad ZAKUMULOWANY, więc funkcja pamięta ostatnio wpisaną treść NA ELEMENCIE (`_pkmThinkingText`) i dopisuje samą deltę; identyczny tekst = zero zapisów i zero odczytów `scrollHeight` (wymuszony layout przy rozwiniętym bloku). Nie czytaj `textContent`, żeby to porównać — jego getter jest O(n). |
| `renderFilterBar` / `getCategoryLabel` / `renderUseAtAgentButton` / `renderTemplateVersionBadge` / `renderCardAction` | **S31.** Prymitywy kart Zaplecza (pasek filtrów, etykieta kategorii, guzik „Użyj u agenta…", plakietka `vN`, akcja na karcie) z `backstage_helpers.js`. Wołają je zakładki Zaplecza z `modules/skills` i `modules/sub-agents` — dwa moduły, więc dom klocka jest tutaj, nie w shellu. (`backstage_helpers.js` miał 7 eksportów; `agentHasSubAgent`/`renderAgentLinks` skasowane AUD-dead-code-079/145/199/250, 2026-09-02 — zero wołaczy nawet POZA barrelem, logika `agentHasSubAgent` była wklejona inline w `SubAgentDetailView.ts` zamiast wołania helpera. Razem z nimi poszły 3 martwe reguły CSS w `modules/shell/sidebar/SidebarViews.css` [`.cs-item-card__agents`, `.cs-agent-link`, `.cs-agent-link:hover`] — zlecone modułowi shell.) |
| `DiffModal` | **S31.** Przyjazny diff przed `vault_write` (przekreślenia / podświetlenia zamiast surowego patcha) + `waitForApproval()`. Jedyny wołacz: `modules/tools/MCPClient.js` leniwym `import()`. |
| `ConfirmModal` / `confirmModal(app, opts)` | **Release 2.2.0.** Zamiennik natywnego `confirm()` (wytyczne katalogu: no-alert). Kontrakt: rozstrzyga się raz — klik guzika potwierdzenia = `true`, Anuluj / Esc / klik poza modalem = `false`. `opts: ConfirmModalOptions`, w tym `destructive: true` → guzik potwierdzenia dostaje klasę `mod-warning` (zamiast `mod-cta`) i fokus startowy leci na Anuluj, żeby przypadkowy Enter/Spacja zaraz po otwarciu nie potwierdziły akcji niszczącej. |
| `PluginItemView` | **clean-room / F2 (zaimplementowane, scalone 2026-09-06).** Baza widokow workspace'u — `extends` Obsidian `ItemView`. Statyki `viewType` / `displayText` / `iconName`, `register(plugin)` (widok + komenda otwarcia), JEDNA sygnatura `open(workspace, state?, active?)`, `whenRuntimeLoaded()` i **opcjonalna** `renderView` (widok czatu dostaje ja miksinem, wiec `abstract` daloby TS2515). Kontrakt: `core/runtime/contracts.ts`. Dziedzicza: `ChatView` (`modules/chat`) i `ReleaseNotesView` (`modules/shell`). Testy `PluginItemView.test.ts` sa zielone. |

> **S30 Z4 — `TOOL_DESCRIPTIONS` OUT z barrela, a przy okazji MARTWY KOD z pliku.**
> Eksport nie miał ani jednego konsumenta (nota w `modules/shell/CLAUDE.md`, że shell go
> importuje, była nieprawdziwa). Razem z nim skasowana mechanika w `ToolCallDisplay.js`:
> funkcja `getToolDescription()` + `TOOL_DESCRIPTIONS` jako `Proxy` nad kluczami i18n
> `tool.desc.*`. Zero wołaczy potwierdzone **dwoma niezależnymi zwiadami**, a same klucze
> `tool.desc.*` poszły do kosza już w **S30 Z2** — proxy zwracało więc tylko surowe nazwy
> kluczy („tool.desc.read"). Opisy narzędzi, które REALNIE widzi user i model, żyją
> w i18n `mcp.<tool>.desc` (idą do API razem z definicją narzędzia; D14).

---

## Zależności

**Importuje z:**
- `modules/crystal-soul/` (`UiIcons`, `setSvg`, `IconGenerator`) — ikony i wygląd
- `core/i18n` (`t`, `getDateLocale`), `core/utils/Logger`
- `obsidian` (`ItemView` — tylko `PluginItemView`; `TFile` import w `AttachmentManager` skasowany AUD-dead-code-147/259, 2026-09-02 — zero użyć)

**Importowany przez:**
- `modules/chat/chat/chat_streaming.js` — bloki narzędzi / myślenia / subów w trakcie streamingu
- `modules/chat/chat/chat_messages.js` — te same bloki przy renderze historii
- `modules/chat/chat/chat_ui.js` — `MentionAutocomplete` + `AttachmentManager` przy polu wpisywania
- `modules/chat/chat/chat_popovers.js` — `TOOL_INFO`
- `modules/sub-agents/SubAgentDetailView.js`, `modules/sub-agents/SubAgentsBackstageTab.js` — `TOOL_INFO` + `getToolIcon`
- `modules/sub-agents/SubAgentEditorModal.js` — `TOOL_INFO` (⚠️ **nie** `TOOL_DESCRIPTIONS` — nota w `shell/CLAUDE.md` była nieprawdziwa, sprostowana w S30 Z4)
- `modules/skills/SkillsBackstageTab.js` — prymitywy kart Zaplecza (S31)
- `modules/tools/MCPClient.js` — `DiffModal` leniwym `import()` przed `vault_write` (S31)
- `modules/chat/chat_view.js` (`ChatView extends PluginItemView`) + `modules/shell/ReleaseNotesView.ts` (`ReleaseNotesView extends PluginItemView`) — S31. **S35: re-export kompatybilnościowy w `modules/shell/index.js` SKASOWANY** (0 konsumentów) — oba widoki importują wprost stąd

**Zero importów z `modules/chat`, `modules/sub-agents`, `modules/tools`, `modules/shell`** — kierunek jest jednostronny (konsumenci → ui-components). Nie odwracaj go: klocek UI nie może wiedzieć, kto go rysuje.

> **S31 — dlaczego `DiffModal` i `backstage_helpers` wylądowały akurat tu.** Oba miały wołaczy
> wyłącznie w modułach NIŻSZYCH niż shell (`modules/tools` / `modules/skills` + `modules/sub-agents`),
> więc mieszkanie w shellu zmuszało te moduły do importu „w górę", z barrela shella. `backstage_helpers`
> spełnia regułę wstępu wprost (≥2 moduły), `DiffModal` ma jednego wołacza, ale to modal generyczny
> (podgląd zmiany pliku) — nie należy ani do narzędzi, ani do widoków. Barrel ui-components i tak
> nie jest obsidian-free (`PluginItemView`), więc dołożenie modalu niczego nie psuje.

---

## Gotchas

- ⚠️ **Prawie ZERO testów w tym module** (stan 2026-09-02) — jedyny plik z pokryciem to `ThinkingBlock.test.ts` (5 testów na atrapie węzła, dopisane przy AUD-wydajnosc-096). Reszta ~1800 LOC nieosłonięta. Powód historyczny: kod przyszedł z `src/components/` w S10 Z12 jako czysta przenoska, bez pokrycia. **Dotykasz czegokolwiek tutaj → dopisz test przy okazji** (pure helpery `getToolIcon` / `TOOL_INFO` / parsery są najłatwiejszym wejściem; klasy widgetów wymagają mocka DOM).
- ⚠️ **`ToolCallDisplay.ts` 649 LOC to prawie monolit** — próg >800 LOC jeszcze nie przekroczony, ale plik rośnie z każdym nowym narzędziem (katalog `TOOL_INFO` = jeden wpis per narzędzie). Zanim dorzucisz kolejną porcję, rozważ wyniesienie katalogu do osobnego pliku (`toolCatalog.ts`) — sam render bloku jest wtedy krótki.
- ⚠️ **`TOOL_INFO[x].label` to getter, nie string.** Nie cache'uj go do zmiennej przy starcie ani nie serializuj katalogu — po zmianie języka odczytana wcześniej wartość zostanie stara. Czytaj przy renderze.
- ⚠️ **Nieznane narzędzie musi się rysować.** `getToolIcon` ma fallback, bo agent może wywołać narzędzie z userowego serwera MCP, którego nie ma w katalogu. Nie dodawaj tu twardego throw. **Etykieta ma go od S30 Z3** — `getToolCallLabel` (d. `getToolLabel`; rename, bo `modules/agents/toolAxis.js` miał funkcję o tej samej nazwie i innej semantyce) zwraca surową nazwę narzędzia, gdy w i18n nie ma klucza `tool.<name>`. Wcześniej czat renderował dosłowne `tool.serwer__tool` dla narzędzi z zewnętrznych serwerów MCP.
- ⚠️ **`MentionAutocomplete` i `AttachmentManager` trzymają nasłuchy na DOM** — czat woła `destroy()` / `clear()` przy zamknięciu zakładki. Jak wpinasz je w nowe miejsce, zadbaj o sprzątanie, inaczej zostają wiszące listenery per otwarta zakładka.
- ⚠️ **Wynik `@` to chip nad inputem, nie tekst w textarei** (v2). Świadome: ścieżki ze spacjami rozwalały wariant inline.

---

## Historia

- **S10 Z12 (2026-05-02)** — moduł powstał przez przeniesienie `src/components/` → `modules/ui-components/` (ostatni „bezdomny" katalog UI z ery `src/`). Barrel z 11 eksportami; importerzy przepięci na `../ui-components/index.js`.
- **E2.6** — katalog `TOOL_INFO` przestawiony na prymitywy (`read`/`list` ze `scope`), stare nazwy (`memory_read` itd.) obsłużone aliasami u konsumentów.
- **S30 (2026-07-30)** — ten `CLAUDE.md` utworzony. Był to jedyny moduł bez dokumentacji; przy okazji odnotowany brak testów.
- **S31 (2026-07-30)** — przyjęcie `ObsekItemView.js` z `modules/shell/` (topologia importów). Dziedziczą z niej dwa moduły, więc pasuje do reguły wstępu „klocek dla ≥2 modułów". Efekt uboczny: `modules/chat` przestał importować barrel shella — padła jedna z krawędzi cyklu shell↔chat i hotfix `da5b675` (wymuszona kolejność eksportów w `shell/index.js`).
