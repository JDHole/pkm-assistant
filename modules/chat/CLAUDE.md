# modules/chat/

> **TS-5 (2026-07-31):** fizyczne źródła i testy tego modułu mają rozszerzenie `.ts`. Wzmianki `.js` niżej są historyczne albo pokazują celowo zachowane specifiery importów.

**Interfejs czatu.** Główny view pluginu — okno chat'u w sidebar Obsidiana. Od sesji 107 zmodularyzowany: `ChatView` jako koordynator (~129 LOC) + 8 submodułów które są mixinami do `ChatView.prototype`.

**Status:** 🚀 **ACTIVE.** Kod fizycznie w `modules/chat/` (Mapa-14, 2026-04-26). Łącznie **~7,000 LOC** (po S05/S05.5 + przyrost S09/S11/S12 + E1.6 B4 — RollingWindow/Summarizer wprowadzone).

**Sprint Refaktoru — który mnie dotyka:**
- ✅ [Sprint 01 Quick Wins + Security](../../Refaktor/Sprinty/SPRINT_01_Quick_Wins_Security.md) **DONE** (2026-04-27) — Z5 copy-plan-do-vault sanitize+overwrite gate (BLOCK-1 🔴 → ✅ commit `d40c516`) + Z6 MarkdownRenderer.render+await 2/3 miejsc (CH-2 BUG-1 🔴 → ✅ commit `77789e5`; streaming 1/3 defer v2.1 race condition)
- ✅ [Sprint 03 Memory v2 GIGANT](../../Refaktor/Sprinty/SPRINT_03_Memory_v2_Retrieval_v2.md) **DONE** — Z7 multi-tab `StreamingManager` singleton (`chat/StreamingManager.js`)
- ✅ [Sprint 05 Sub-agents v2 + Inline Triggers UI](../../Refaktor/Sprinty/SPRINT_05_Sub_Agents_v2_Inline_Triggers.md) **DONE** (2026-04-28) — slim bar 3 sekcje (SUB / SKILLS / MCP) + `chat/InlineChipPlugin.js` marker parser (`@@skill:`, `@sub-agent:`, `@@tool:`) + Z14 compact tool chips w historii (toggle `pkmAssistant.compactToolChips`) + force-trigger instruction injection w `chat_streaming.js`
- ✅ [Sprint 05.5 Hotfix](../../Refaktor/Decyzje_Sesji/2026-04-29_post_sprint_05_HOTFIX.md) **DONE** (2026-04-29) — `chat/TriggerPopup.js` popup `/`/`@` z fuzzy filter, klawiatura ↑↓ Enter Esc, intersection security; integracja w `chat_ui.js` (keydown + input + blur listenery)
- ✅ [Sprint 09 Artefakty v2 + chat housekeeping](../../Refaktor/Sprinty/SPRINT_09_Artefakty_v2_Chat_Housekeeping.md) — Artefakty v2 integration, `ToolReactorRegistry`, `SlashCommandsRegistry`, re-toggle anti-pattern fix
- ✅ [Sprint 11 Token Context Viewer](../../Refaktor/Sprinty/SPRINT_11_Token_Context_Viewer.md) **DONE** (2026-05-05) — `chat/TokenViewerWidget.js` donut + pop-over breakdown w slim barze; `chat/ToolTokenCache.js` cache tokenów tools per agent
- ✅ [Sprint 12 Skiny pluginu](../../Refaktor/Sprinty/SPRINT_12_Skiny_Pluginu.md) — migracja crystal/avatar/color callsite'ow na SkinManager API.
- [Sprint 13b Polish + Decyzje](../../Refaktor/Sprinty/SPRINT_13b_Polish_Decyzje.md) — ~25 chat drobnic (CH-7..31)

---

## Co tu jest (kod w `modules/chat/`)

```
modules/chat/
├── index.js                        # publiczne drzwi (4 eksporty: ChatView, CHAT_VIEW_TYPE, insertInlineTriggerMarker, startConsolidationRun)
├── CLAUDE.md                       # ten plik
├── chat_view.js                    # ChatView (Obsidian ItemView), koordynator
├── consolidationRunner.js          # S29: kontroler przebiegu konsolidacji pamięci (klej memory ↔ modal/pasek/notice)
├── SaveSessionModal.js             # S31 (był shell): `/save session` — review propozycji notatek brain/
├── SessionCloseModal.js            # S31 (był shell): zamknięcie sesji — archive / draft / discard
├── OpenSessionModal.js             # S31 (był shell): otwórz starą sesję — continue / compress / fresh
├── ConsolidationProgressModal.js   # S31 (był shell): nieblokujące okno PRZEBIEGU konsolidacji (S29 Z4)
├── archiveReviewRenders.js         # S31 (był shell): rendery review (dedup + L1/L2/L3) pod modal przebiegu
├── consolidationRunState.js        # S31 (był shell): czyste decyzje modalu (isRunStuck/resolveStepDraft) + test
├── slash-commands/                 # definicje komend slash (save_session.js)
└── chat/                           # 8 mixinów (prototype) + helpery/rejestry
    ├── chat_streaming.js           # streaming tokenów + force-trigger injection (S05) + twardy backstop pętli (E1.5)
    │                               #   S30 Z7: `_lastPaintedContent` — pamięć ostatnio NAMALOWANEJ treści;
    │                               #   `_finalizeTurn` przerysowuje wiadomość, gdy finalna treść z `done`
    │                               #   różni się od namalowanej (rollback niedomkniętego `<think>` odzyskuje
    │                               #   tekst, który wcześniej zostawał wizualnie w bloku myślenia)
    ├── chat_ui.js                  # render UI elementów + popup `/@` integration (S05.5)
    ├── chat_messages.js            # render messages, history + compact tool chips (S05 Z14)
    ├── chat_artifacts.js           # Artefakty v2 panel + ProgressModal integration
    ├── chat_model.js               # model selection, multimodal handling
    ├── chat_session.js             # session save/load/restore (z `modules/memory/`) + _createRollingWindow
    ├── chat_tabs.js                # multiple chat tabs
    ├── chat_popovers.js            # agent popovers, context menus
    ├── InlineChipPlugin.js         # marker parser (S05): @@skill:, @sub-agent:, @@tool:
    ├── messagePrivileges.js        # K7: bramki przywilejów tury (rejestr URL / markery / komendy `/`)
    │                               #   — wszystkie pytają `meta.origin` z core/security/messageOrigin
    ├── queuedMessage.js            # K19: slot kolejki wiadomości (tekst + proweniencja + WŁAŚCICIEL
    │                               #   zakładki, Klaster I) + `queuedOwnerMatches`; od AUD-testy-024
    │                               #   także DECYZJE drenu i Stopu (`evaluateQueuedDrain`,
    │                               #   `evaluateStopQueueCancel`); pure, testowalny
    ├── subTaskDelivery.js          # AUD-testy-024: komplet bramek dostarczenia wyniku suba
    │                               #   (`evaluateSubTaskDelivery`) — zakładka → aktywność → trwająca
    │                               #   tura → Stop → sufit łańcucha; pure, testowalny
    ├── vaultReadGate.js            # K23 / AUD-testy-025: bramka `vault.read` dla Oczka i @-wzmianek
    │                               #   (`evaluateVaultRead` + `createVaultReadPredicate`); pure
    ├── toolPopoverEntries.js        # AUD-dead-code-205: `buildToolPopoverEntries` — lista popovera
    │                               #   narzędzi = rejestr minus disabled_tools, TOOL_INFO tylko za
    │                               #   ikonę/etykietę (fallback gdy brak wpisu); pure, testowalny
    ├── safeErrorText.js            # K20b: normalizacja → maskSensitiveData → sufit; pure, testowalny
    ├── StreamingManager.js         # singleton multi-tab streaming tracking (S03) + `shouldUseFreshModel`
    │                               #   (AUD-testy-027: decyzja „świeża instancja modelu czy z cache")
    ├── renderThrottle.js           # AUD-wydajnosc-071: koalescencja malowania strumienia (pure,
    │                               #   bez obsidian/DOM) — klatka `{text, reasoning}` malowana
    │                               #   najwyżej raz na 80 ms, identyczna klatka = zero malowań
    ├── RollingWindowMessageStore.js # adapter MessageStore na RollingWindow dla runAgentLoop (E2.1 krok B)
    ├── RollingWindow.js            # token window (przyszedl z memory w E1.6 B4) + callback W2 (E2.7)
    ├── Summarizer.js               # kompresja starych tur (przyszedl z memory w E1.6 B4) + sekcja MEMORY_CANDIDATES (E2.7) + szkielet z compressionPrompt (E2.8)
    ├── turnOwner.js                # K4 + K18 — kto jest WŁAŚCICIELEM okna/tury: resolvery + providery RollingWindow
    │                               #   + `freezeTurnOwner(view)` (zamrożenie tury przed awaitami); pure, testowalny
    ├── compressionPrompt.js        # S31 — CZYSTY re-export z `config/default_prompts.js` (tam mieszka sam DEFAULT_COMPRESSION_PROMPT, E2.8 B3); zostaje jako lokalne drzwi dla wnętrza czatu
    ├── memoryCandidates.js         # parser bloku MEMORY_CANDIDATES z odpowiedzi Summarizera (E2.7 W2)
    ├── subTaskNotification.js      # F2: treść powiadomienia o wyniku suba z tła + matchTabForOrigin (pure, testowalny)
    ├── subTaskStrip.js             # pasek biegów subów POD zakładkami czatu (2026-08-15); obsidian-free DOM, model z modules/sub-agents
    ├── SlashCommandsRegistry.js    # rejestr komend `/` (S09)
    ├── ToolReactorRegistry.js      # plug-in reaktory na tool results (S09)
    ├── TokenViewerWidget.js        # donut + pop-over Token Context Viewer (S11)
    ├── TokenViewerUtils.js         # helpery obliczeń dla Token Viewera (S11)
    ├── ToolTokenCache.js           # cache countTokens(JSON.stringify(tools)) per agent (S11)
    └── TriggerPopup.js             # popup `/@` z 3 sekcjami (S05.5 hotfix)
```

CSS: `modules/chat/chat_view.css` (osobny plik styles)

Razem **~7,000 LOC**.

⚠️ **Monolit >800 LOC** (stan 2026-09-02, po fabryce wydajności): `chat/chat_streaming.ts` — 2091 linii (rosło z 1393 mimo kasacji dead-code w D4 — inne dopisy w tym samym oknie czasu przybyły szybciej). Świadomie nierozbity; zmiana w nim = przeczytaj całość przed edycją.

⚠️ **Monolit >800 LOC** (stan 2026-09-02): `chat/chat_ui.ts` — 1408 linii. Świadomie nierozbity; zmiana w nim = przeczytaj całość przed edycją.

⚠️ **`chat/RollingWindow.ts` — 1003 linie** (przekroczył próg 800 w fabryce wydajności 2026-09-02). Ta sama zasada.

---

## Public API

`modules/chat/index.js` — **4 eksporty**:

- `ChatView` — klasa (rozszerza Obsidian `ItemView`)
- `CHAT_VIEW_TYPE` — kanoniczny typ widoku czatu, obsidian-free re-export (`chatViewType.js` → `core/index.js`) — AUD-dead-code-182
- `insertInlineTriggerMarker(textarea, type, name)` — helper z `InlineChipPlugin.js`, wołany przez `modules/shell/sidebar/TriggersView.js` leniwym `import()` (S05.5 H2)
- `startConsolidationRun(...)` — S29: trigger konsolidacji pamięci; poza czatem woła go profil agenta (`modules/agents/profile/profile_memory.js`) leniwym `import()`
- mixinów `chat_*` NIE eksportujemy — to wewnętrzna struktura (prototype mixin pattern)
- `TriggerPopup` — wewnętrzna klasa, NIE w barrel (używana tylko przez `chat_ui.js`)

> **AUD-dead-code-052 (2026-09-02) — `DEFAULT_COMPRESSION_PROMPT` OUT z barrela** (zero
> konsumentów spoza modułu; kandydat od S30 Z4 nigdy nie doczyszczony). Stała mieszka w
> `config/default_prompts.js`; Settings→Prompt (`modules/shell/prompt_settings.js`) bierze ją
> wprost stamtąd. Lokalne drzwi `chat/compressionPrompt.js` zostają dla wnętrza modułu
> (Summarizer, turnOwner).

> **S30 Z4 — 4 eksporty WYCIĘTE z barrela** (zero konsumentów spoza modułu):
> `streamingManager` (default export), `StreamingManager`, `RollingWindow`,
> `makeInlineTriggerMarker`. **Definicje ŻYJĄ w `chat/`** — singleton streamingu wołają
> `chat_streaming`/`chat_view`, `RollingWindow` tworzy `chat_session._createRollingWindow`,
> a `makeInlineTriggerMarker` jest wewnętrznym helperem `insertInlineTriggerMarker`.
> Przy okazji: `RollingWindow.js` importuje `sanitizeToolTranscript` **wprost z
> `modules/agent-loop/index.js`** (dawniej przez pass-through w barrelu memory, skasowany)
> — chat/RollingWindow nie ma już statycznej krawędzi na `modules/memory`.

---

## Pattern: prototype mixin

ChatView jest **koordynatorem**, ale logika rozsiana w 8 submodułach. Łączenie przez:

```js
import * as messages from './chat/chat_messages.js';
import * as streaming from './chat/chat_streaming.js';
// ... pozostałe

Object.assign(ChatView.prototype, messages, streaming, ...);
```

**Czemu tak (sesja 107):** ChatView miał ~4500 LOC w jednym pliku — nie do utrzymania. Mixin pattern dał: separacja konceptualna + utrzymanie `this` (jest ChatView'em w każdym submoduł'u) + bez breaking change.

---

## Zależności

**Importuje z:**
- `core` (Logger, i18n, sanitizePath, autonomy: `AUTONOMY_MODES`/`DEFAULT_AUTONOMY`/`normalizeAutonomy`)
- `modules/memory/` (AgentMemory przez agentManager, `streamToComplete`, workflowy) — `RollingWindow` + `Summarizer` są teraz LOKALNE w chat (E1.6 B4); `MemoryExtractor` skasowany (E1.1)
- `modules/agent-loop/` (`runAgentLoop`, `ArrayMessageStore`, `parseToolCalls`, `sanitizeToolTranscript` — od S30 Z4 wprost z domu sanitizera, nie przez barrel memory)
- `modules/tools/` (ToolRegistry — tools dla agenta)
- `modules/models/` (ChatModel, modelResolver, isLocalPlatform)
- `modules/artifacts/` (`artifact_create`/`artifact_read`/`artifact_update`/`artifact_list` + `todo` progress — `idea_review`/`plan_review`/`chat_todo` to dziś tylko aliasy kompatybilności, `modules/tools/toolAliases.ts`)
- `modules/agents/` (AgentManager dla active agent)
- `modules/sub-agents/` (DelegateTool integration)
- `modules/ui-components/` (bloki narzędzi/myślenia/subów + **`PluginItemView`** — od S31 baza `ChatView` idzie stąd, nie z barrela shella)
- ~~`modules/shell/`~~ — **S31: zero importów z shella.** Modale sesji (`SaveSessionModal`,
  `SessionCloseModal`, `OpenSessionModal`) i trio konsolidacji (`ConsolidationProgressModal`,
  `archiveReviewRenders.js`, `consolidationRunState.js` + test) mieszkają teraz w korzeniu
  tego modułu — wewnętrzne, świadomie NIE w barrelu chatu
- `config/default_prompts.js` (`DEFAULT_COMPRESSION_PROMPT`, przez `chat/compressionPrompt.js` — S31)
- `obsidian` (ItemView, Notice, TFile)

**Importowany przez:**
- `src/main.js` (rejestracja view: `registerView(VIEW_TYPE_CHAT, ...)`)

---

## Kluczowe decyzje

- **Modularyzacja przez prototype mixin** (sesja 107): zamiast klasy z 4.5k LOC, koordynator ~129 LOC + 8 submodułów po 200-1200 LOC. Każdy submoduł testowalny osobno.
- **`chat_streaming.ts` to grubas** (2031 LOC, stan 2026-09-02 — patrz marker monolitu wyżej) — kandydat do dalszego splitu w **Sprint 03 Z7** (StreamingManager singleton dla multi-tab) + **Sprint 13 polish**.

---

## Gotchas

- ⚠️ **K4 (2026-08-22): ZASADA ZAMROŻENIA STANU TURY — okno rozmowy ma WŁAŚCICIELA.**
  Tura potrafi skończyć się na zakładce, której user już nie ogląda (`chat_streaming`: gałąź
  „Background tab finished"), a kompresja końca tury leci wtedy BEZWARUNKOWO. Do K4 jej providery
  rozstrzygały się po `getActiveAgent()` / `getActiveMemory()` w chwili wywołania, więc transkrypt
  agenta X jechał modelem agenta Y i dostawał w tym samym strzale jego `brain.md`, a wyłuskane
  fakty lądowały na stałe w `brain/` Y (AUD-security-065/066). Dziś:
  - **`_createRollingWindow(agentName)`** zamraża nazwę właściciela przy zakładaniu okna
    (zakładka zna swojego agenta), a cała paczka zależna od tożsamości — prompt kompresji, model,
    indeks pamięci, ratunek pamięci, kontekst awaryjny — powstaje w
    **`chat/turnOwner.ts`** (`buildOwnerWindowOptions`). To osobny plik, bo `chat_session.ts`
    importuje `obsidian` i nie da się go odpalić w AVA; `turnOwner` jest pure i ma testy.
  - **`appendToActiveSession`** adresuje pamięć po `event.agentName` — czyli po TURZE, która
    zdarzenie wyprodukowała (AUD-security-064). Dokładasz nowe zdarzenie do event-logu? **Podaj
    `agentName`**, inaczej trafi do agenta akurat wybranego w UI.
  - **`handleSaveSession(agentName?, rollingWindow?)`** przyjmuje właściciela i okno tury —
    kompresja z tła podaje oba; wołacze z aktywnej zakładki wołają bez argumentów, jak dotąd.
  Znana granica (świadomie zostawiona): gdy właściciel ma `minionEnabled === false`,
  `modelProvider` spada na `get_chat_model()`, który nadal czyta aktywnego agenta.
- ⚠️ **`meta.origin` to źródło prawdy o przywilejach wiadomości — BRAK znacznika znaczy „maszyna"** (K7, 2026-08-22). Rola dymka (`'user'`) NIE oznacza już, że tekst napisał człowiek. Dodajesz nowe wywołanie `send_message`? Ustaw `meta` jawnie: z pola wpisywania → `HUMAN_MESSAGE_META`, z kodu (guzik, przywołanie, auto-tura) → `MACHINE_MESSAGE_META` / `machineMeta({...})`. Szczegóły niżej w sekcji „K7 update". **K19:** pieczątka przeżywa też kolejkę — slot `_queuedMessage` wozi `{text, meta}`, a dreny ją tylko oddają; nigdy nie nadawaj tam `human` na sztywno.
- ⚠️ **K23 (2026-08-23): Oczko i @-wzmianki pytają o dostęp TĄ SAMĄ bramką, co narzędzie `read`.** Oba kanały wciągają pliki vaulta do promptu bez wywołania narzędzia, więc `chat_model.ts` buduje jeden predykat (`_vaultReadPredicate` → `permissionSystem.checkPermission(agent, 'vault.read', path)`, agent = właściciel tury) i podaje go producentowi Oczka jako `canReadImage` oraz sprawdza nim wzmianki; do K23 osadzone `![[…]]` obrazy nie miały żadnej bramki (AUD-security-119), a wzmianki tylko No-Go.
- ⚠️ **Mixin pattern wymaga `this` consistency** — funkcja w submodule nie może być stripowana przez bundler ani arrow function (gubi `this`)
- ⚠️ **Auto-save sesji w `chat_session.js`** (timer co X minut) — może lagować przy bardzo długich sesjach (>500 wiadomości). Mitygacja: incremental save (save tylko delta) — w **Sprint 03 Z6** (refactor chat_session ↔ memory)
- ⚠️ **`chat_streaming.js` parsuje tokens streaming** — różne providers (OpenAI/Anthropic/Gemini/Ollama) mają różne format event chunks. Logika tu siedzi, NIE w `modules/models/`. Ostrożnie z refaktorem
- ⚠️ **Wskaźnik na aktywną sesję** w `agentMemory.activeSessionPath` musi być persistowany na dysku (`.active_session.json`) — inaczej restart Obsidian = utrata kontekstu
- ⚠️ **MALOWANIE STRUMIENIA JEST ZA THROTTLEM (fabryka wydajności, 2026-09-02).** `handle_chunk`
  NIE maluje — zgłasza klatkę `{text, reasoning}` do `chat/renderThrottle.ts`, a ten woła
  `_paintStreamFrame` najwyżej raz na 80 ms, zawsze OSTATNIĄ treścią. Powód (AUD-wydajnosc-071/015/070):
  callback `chunk` adaptera niesie treść ZAKUMULOWANĄ i leci raz na ramkę SSE, więc malowanie
  per chunk dawało koszt KWADRATOWY względem długości odpowiedzi (8 000 znaków = 2 000 malowań,
  8 mln znaków markdownu), a chunki z samą deltą `tool_calls` przemalowywały bajt-w-bajt to samo
  (95% wywołań w turze z 12 KB argumentów). Konsekwencje dla Ciebie:
  - **każde nowe wyjście z tury musi domknąć klatkę**: `flush()` PRZED `_resetPaintTargets()`
    (tak robią `_finalizeTurn`, `stop_generation`, `_chatBeforeContinue` — inaczej ginie ogon
    odpowiedzi), albo świadomy `reset()`/`cancel()`, gdy dymek i tak jest nadpisywany
    (ścieżka błędu). `_resetPaintTargets` woła `reset()` sam;
  - **nie wołaj `MarkdownRenderer` z `handle_chunk`** — pilnuje tego strażnik po źródle
    w `chat/renderThrottle.test.ts`;
  - malowanie zostaje SYNCHRONICZNE (żadnego async renderu — out-of-order z TODO niżej nadal
    nam grozi, zmieniła się tylko CZĘSTOTLIWOŚĆ);
  - ⚠️ **klatka należy do ZAKŁADKI, nie do widoku** (review 2026-09-02). Timer uzbrojony ≤80 ms
    przed `_switchTab` wystrzeliłby PO przerysowaniu listy i PO przywróceniu `scrollTop`:
    tekst poszedłby w wypięte węzły starej zakładki, ale `scrollToBottom` przewinąłby NOWĄ.
    Dlatego `_switchTab` rozbraja throttle na wejściu (krok 0b, `cancel()`), a `_paintStreamFrame`
    dodatkowo pyta `shouldPaintFrame(frame, aktywnaZakładka)` — klatka wozi `owner` (nazwę agenta
    tury). Dokładasz nową ścieżkę, która przerysowuje listę wiadomości? Rozbrój throttle.
- ⚠️ **Łączniki (`_drawConnectorLines`) rysują się RAZ NA KLATKĘ, nie na każde wywołanie**
  (AUD-wydajnosc-072/014). `scrollToBottom(smooth, { drawConnectors: false })` to tryb „tylko
  przewiń" — używa go malowanie strumienia, bo rosnący tekst ostatniej wiadomości nie przesuwa
  ani kryształu, ani wierszy akcji. Reszta wołaczy dostaje `_scheduleConnectorRedraw()` (rAF,
  fallback `setTimeout`), a koniec tury przerysowuje jawnie. Funkcja skanuje CAŁĄ listę wiadomości
  i przeplata `getBoundingClientRect` z wstawianiem węzłów — nie wołaj jej w pętli.
- ⚠️ **Licznik tokenów okna liczy PRZYROSTOWO** (AUD-wydajnosc-017/048/049). `RollingWindow`
  trzyma statystyki tekstu (długość + liczba znaków spoza ASCII) per wiadomość (`_messageStats`,
  WeakMap) i dla promptu (`_promptStats`), a tokeny składa `countTokensFromStats` z `core`.
  Wynik jest identyczny co do tokena z dawnym „sklej wszystko i policz raz" (strażnik: property
  test w `chat/RollingWindow.perf.test.ts`). **Dokładasz pole wiadomości, które jedzie do modelu?
  Dopisz je do `_messageStats` i do odcisków ważności** — inaczej okno przestanie je widzieć.
  Ważność liczy TOŻSAMOŚĆ pól + długość tablic (Oczko dokłada blok obrazu przez `push` W MIEJSCU).
- ✅ **`MarkdownRenderer.renderMarkdown` deprecated** (Obsidian 1.5+) — **FIXED Sprint 01 Z6 — 2/4 miejsc** (chat_messages.js:61+170 → render+await); **release 2.2.0/W2 domyka pozostałe 2/4** w `chat_streaming.ts` (`_paintStreamFrame` + `_finalizeTurn`) → `MarkdownRenderer.render(app, …)`, fire-and-forget (`void`, bez await) — dawny TODO v2.1 zakładał, że przejście na `.render()` WPROWADZA asynchroniczność, której dotąd nie było; nieprawda, `renderMarkdown` też zwraca `Promise<void>` (obsidian.d.ts) i był wołany bez await w tych dwóch miejscach — więc migracja API nie zmienia ryzyka out-of-order ponad to, co już istniało (throttle capuje częstotliwość, patrz gotcha wyżej). ⚠️ **Sprostowanie 2026-09-02:** dawna nota mówiła „render per streaming chunk" i wskazywała `handle_chunk ~L644` — od fabryki wydajności render leci za throttlem (patrz gotcha wyżej), więc CZĘSTOTLIWOŚĆ nie jest już problemem; zostaje sam dług deprecated API — **domknięty**.

---

## TODO

**Aktywne znaleziska** (40 z sesji Mapa-14):

- ✅ **CH-1 BLOCK-1** — `chat_artifacts.js` copy-plan-do-vault → **FIXED Sprint 01 Z5** (sanitizePath + overwrite gate timestamp suffix Plan B; folder picker defer S09)
- ✅ **CH-2 BUG-1** — `MarkdownRenderer.renderMarkdown` × 4 → **FIXED Sprint 01 Z6 — 2/4** (chat_messages.js:61+170 render+await); **release 2.2.0/W2 domknęło pozostałe 2/4** (chat_streaming.ts — `_paintStreamFrame` + `_finalizeTurn`, patrz gotcha wyżej)
- 🟠 **CH-3 ARCH-1** — hidden coupling chat_session ↔ memory private API + L1/L2/L3 logika ~80 LOC powinna być w memory/ → **Sprint 03 Z6**
- 🟠 **CH-4 ARCH-2** — tool reactor pattern hardcoded ~150 LOC → **Sprint 09 Z7** (ToolReactorRegistry plug-in)
- 🟠 **CH-5 ARCH-3** — multi-tab streaming → osobny StreamingManager → **Sprint 03 Z7**
- 🟠 **CH-6 ARCH-4** — slash commands inline 50 LOC → **Sprint 09 Z8** (SlashCommandsRegistry)
- + 13 🟡 + 7 🟢 → głównie **Sprint 13 polish** Z9

**Pełna lista:** [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md) — matryca 264 znalezisk × sprinty.

---

## Powiązane

> **Wizje z ery Mapy** (zrealizowane w Refaktorze v2.0) leżą dziś w archiwum vaulta: `90_Archiwum/DevDesktop_Era2_2026-08-02/Projekty/PKM Assistant - Mapa/Wizje/` oraz `.../PKM Assistant - Tydzień MAX/Wizja/`. Ścieżka zmieniona 2026-08-02 przy przebudowie pracowni.

- **Wizja MEMORY_v2_RETRIEVAL_v2** — Bloki 1, 4 (3 typy sesji + UI ikonki inline). Uwaga: Memory v2 zastąpione przez Memory v3 w Sprincie M3
- **Wizja INLINE_TRIGGERS_UI** — sekcja 11 (kompaktowy chip render)
- **Wizja TOKEN_CONTEXT_VIEWER_v1** — donut + pop-over per kategoria
- [`modules/memory/CLAUDE.md`](../memory/CLAUDE.md) — chat używa AgentMemory (przez agentManager); `RollingWindow` + `Summarizer` są teraz lokalne w chat (E1.6 B4)
- [`modules/artifacts/CLAUDE.md`](../artifacts/CLAUDE.md) — chat renderuje Plan + Todo z artefaktów

---

## Historia

- **Sesja 47-54** — Crystal Soul v2 integration (kryształy agentów w UI chatu)
- **Sesja 107** — Modularyzacja: ChatView 4519 LOC → 129 LOC koordynator + 8 submodułów
- **Sesja 120-121** — Refaktor dispatcher (Gadaj/Rób tryby), uproszczenie UI
- **Mapa-14 (2026-04-26)** — przenosiny 9 plików do `modules/chat/` + 29 znalezisk + 2 Wizje (TOKEN_CONTEXT_VIEWER_v1 + INLINE_TRIGGERS_UI rozszerzone)

## Sprint 13a update (2026-05-07)
- WebSearchProvider lives in modules/web/; Web Search settings are registered by modules/web/.
- Oczko active-note context now lives in modules/multimodal/active_note.js; chat calls the multimodal public API.

## E1.5 update (2026-07-21) — twardy backstop pętli narzędzi
- **Limit rund narzędzi czatu = `config/limits.js` `chat_max_iterations` (default 8).** Wcześniej hardcoded `MAX_TOOL_ITERATIONS = 10` w `chat_streaming.js`. Teraz z `getLimits(this.env?.settings)` — user może nadpisać przez Settings → Limity (`settings.pkmAssistant.limits.chat_max_iterations`). Wyrównane z domyślnym budżetem researcher-a (8) — E1.5 P4.
- **Backstop jest teraz TWARDY (E1.5 P2).** Gdy `toolIterationCount >= chat_max_iterations`, `continueWithToolResults` wysyła zapytanie BEZ narzędzi (`tools: undefined`) + wiadomość „HARD STOP". Model nie ma jak wywołać toola → MUSI odpowiedzieć tekstem → `handle_done` widzi 0 tool calls → tura kończy się czysto. Wcześniej wysyłaliśmy „HARD STOP" ale NADAL z narzędziami — model mógł ją ignorować w nieskończoność. Wzór skopiowany z `modules/memory/streamHelper.js` (który robił to dobrze). Pełna ekstrakcja pętli = Etap 2.
- ⚠️ **`chat_streaming.js` nie jest testowalny node'em** — importuje `obsidian` (MarkdownRenderer, Notice) na górze modułu, a `obsidian` to build-time-external stub bez wejścia rozwiązywalnego przez node ESM. AVA crashuje przy imporcie. Dlatego wszystkie testy chat celują tylko w submoduły bez `obsidian` (ToolTokenCache, InlineChipPlugin logic). Backstop zweryfikowany budem (`npm run build`) + ręcznym prześledzeniem gałęzi; logika „finalny call bez narzędzi" ma pokrycie w `modules/memory/streamHelper.test.js`.

## E1.6 update (2026-07-21) — docs-freshness + przyjęcie RollingWindow/Summarizer
- **`RollingWindow.js` + `Summarizer.js` przeniesione z `modules/memory/` → tutaj (B4).** Token window to domena chatu; `chat_session.js` importuje `./RollingWindow.js` lokalnie, a `index.js` re-eksportuje `RollingWindow`. `Summarizer` używany wewnętrznie przez RollingWindow.
- **`MemoryExtractor` już NIE istnieje** (skasowany w E1.1) — usunięto go z opisu zależności.
- Docs-freshness: „Co tu jest", Public API i sekcja Zależności zsynchronizowane ze stanem na dysku (dodane SlashCommandsRegistry, ToolReactorRegistry, TokenViewerUtils, RollingWindow, Summarizer; poprawione LOC z ~5,2k → ~7k).

## E2.1 krok B update (2026-07-22) — pętla czatu przepięta na runAgentLoop
- **Mechanika iteracji narzędziowej czatu przeniesiona do `modules/agent-loop` (`runAgentLoop`).** `chat_streaming.js` jest teraz TWARZĄ tury: przygotowanie (send_message), rendering (handle_chunk), placeholdery/UI narzędzi (hooki) i finalizacja (`_finalizeTurn`). Iteracje, backstop, sanityzacja transkryptu i obcinanie wyników robi pętla. **ZERO zmian widocznych dla usera** (drobne odstępstwa: patrz raport E2.1 krok B).
- **Usunięte:** `handle_done` (callback re-entry), `continueWithToolResults` (kontynuacja z tym samym handlerem), `ctx.toolIterationCount` i większość `_streamCtxMap` — kontekst tury żyje w zamknięciu `turn` w `send_message`. `_streamCtxMap` trzyma tylko minimalny wpis dla `handle_chunk` (ctx.agent → nagłówek) i `needsFreshModel` (size > 1).
- **Nowy `RollingWindowMessageStore.js`** — adapter kontraktu `MessageStore` (agent-loop) na `RollingWindow`. Kierunek chat → agent-loop.
- **Hooki pętli** (`_chatResolveTools`, `_chatOnIterationStart`, `_chatExecuteToolCall`, `_chatOnToolCallsParsed`, `_chatOnToolResults`, `_chatOnUsage`, `_chatOnBackstop`, `_chatBeforeContinue`, `_finalizeTurn`) — cała dawna logika `handle_done`/`continueWithToolResults` rozbita na punkty zaczepienia pętli.
- **Backstop** ujednolicony na `agentLoop.backstop_hardstop` (dawny bespoke „[SYSTEM — HARD STOP]" tekst czatu → wspólny klucz i18n, treść równoważna).
- ⚠️ **`chat_streaming.js` nadal nie jest testowalny node'em** (import `obsidian`). Pokrycie: `AgentLoop.test.js` (mechanika pętli) + `RollingWindowMessageStore.test.js` (adapter) + build + smoke hybrydowy. Ręczny smoke: patrz lista scenariuszy w raporcie krok B.

## E2.7 W2 (K3) update (2026-07-22) — ratunek pamięci przed kompaktowaniem
- **Kompresja kontekstu ratuje trwałe fakty jednym wywołaniem LLM.** `Summarizer.getSummaryPrompt` ma nową sekcję: model po streszczeniu dopisuje (opcjonalnie) blok `===MEMORY_CANDIDATES===` + fence ```json z 0-3 kandydatami wg bramki istotności. Do dedupu dostaje indeks `brain.md` (sam indeks, nie treści notatek — budżet tokenów).
- **`memoryCandidates.js`** — pure parser (`parseMemoryCandidates(text) → {summary, candidates}`): odcina blok kandydatów od streszczenia (`conversationSummary` zostaje czyste), waliduje typy (`isValidNoteType`, zły typ → odrzucony), cap 3. Node-testowalny (`memoryCandidates.test.js`).
- **`RollingWindow.performSummarization`** parsuje kandydatów po `summarize()`, ustawia czyste `conversationSummary`, i **fire-and-forget** woła `onMemoryCandidates(candidates)` (NIE blokuje kompresji). Dwa nowe callbacki wstrzykiwane z `chat_session._createRollingWindow`: `memoryIndexProvider` (czyta `brain.md`) i `onMemoryCandidates` (zapis). **RollingWindow nie pisze do pamięci — kierunek zależności jak dziś.**
- **Zapis w `turnOwner.saveMemoryCandidatesFor`** (AUD-dead-code-227/246, 2026-09-02: osierocony wrapper `chat_session._saveMemoryCandidates` skasowany — nikt go nie wołał, żywa ścieżka szła zawsze przez `turnOwner`) przez `AgentMemory.writeBrainNote` (create-with-suffix, kolejka K1) + jeden batch `rebuildBrainIndex`. Dotyczy OBU ścieżek kompresji (mid-loop i end-of-turn) + awaryjnej — wszystkie idą przez `performSummarization`.
- **UI:** `_renderMemorySavedNote(N)` dokleja „🕒 N kandydatów pamięci czeka na Twój przegląd (zapis sesji)" do bloku kompresji. i18n `chat.msg.memory_candidates_pending` (pl+en; stary `chat.msg.memories_saved` SKASOWANY z obu słowników). Od D8 (2026-08-27, AUD-docs-065) to zapowiedź review, nie pokwitowanie zapisu — kandydaci czekają w `brain/pending_rescue/` na akcept w modalu zapisu sesji.

## E2.7 W3 (K4) update (2026-07-22) — kanoniczna ścieżka + detektor bezczynności
- **`consolidateSession()` to teraz cienki wrapper na `runSaveSessionFlow`** (wyniesiony z `slash-commands/save_session.js` jako reużywalna funkcja). Trzy wołacze — przycisk 🧠 (`chat_ui`), `/memory` (`SlashCommandsRegistry`), SessionCloseModal „archive" (`handleNewSession`) — przechodzą teraz przez flow `/save session` (SaveSessionModal review → archiwizacja → próg → ArchiveWorkflow). Skasowana cicha ścieżka `AgentMemory.consolidateAll` (L1/L2/L3). ⚠️ **Zmiana widoczna dla usera:** te wejścia otwierają modal przeglądu zamiast cichej konsolidacji; SessionCloseModal „archive" pokazuje teraz DWA modale po sobie (patrz raport E2.7, ryzyko #1).
- **Detektor bezczynności (`_idleTick`, wpięty w `initSessionManager`):** co 60s sprawdza `IdleScheduler` (modules/memory, pure); po `settings.pkmAssistant.idleConsolidationMinutes` (default 20, 0=off) ciszy + ≥2 nowych wpisach → `handleSaveSession()` (W3-lite, bez LLM w tle). Live-read ustawienia (zmiana w Settings działa bez reloadu).
- **Fix `sessionTimeoutMinutes`:** `chat_streaming.js` czyta teraz `settings.pkmAssistant.sessionTimeoutMinutes` (był `settings.sessionTimeoutMinutes` — zły poziom, zawsze fallback 30) + kontrolka w Settings → Pamięć.
- Usunięte z `chat_session.js` importy: `AuditLog`, `createModelForRole` (były tylko w starym `consolidateSession`). `_findCoveringL1Summary`/`_buildFreshAgentContext` zostają (używa ich `handleLoadSession`).

## E2.2 (K4) update (2026-07-22) — Token Viewer wiarygodny (L07-6)
- **Wiersze zawsze-0 out.** `RollingWindow.getBreakdown()` nie zwraca już `layer2.memory_files`, `layer2.skills`, ani całej warstwy `layer3` (`mcp_tools_deferred`/`system_tools_deferred`) + `deferred_total` — koszt pamięci/skilli siedzi w `system_prompt`, a *_deferred nigdy nie były zasilane. `setContextTokenSources` przyjmuje tylko `system_tools` + `mcp_tools_active` (jedyne, które `getCachedToolTokenBreakdown` zwraca). `TokenViewerWidget.renderMainBreakdown` bez sekcji „Odroczone"; martwy i18n `chat.token_viewer.deferred` (pl+en) usunięty.
- **Martwy stary donut out.** `_updateContextCircle` (`chat_ui.js`) skasowany — `.token-wrapper` nigdy nie powstawał w DOM (zawsze early-return). Call-site'y (`chat_ui.js` + 3× `chat_session.js` w callbackach RollingWindow) przepięte na `_updateTokenPanel()`. CSS `.token-wrapper` + `.pkm-context-circle`/`.pkm-donut*` (`chat_view.css`) usunięte. Aktywny wskaźnik = `TokenViewerWidget`.
- **Estymaty subów oznaczane.** Fallback w `chat_streaming.js` (gdy sub bez `usage`) liczy tokeny oficjalnym `getTokenCount` (nie ad-hoc znaki/4) i woła `tokenTracker.record(role, in, out, { estimated: true })`. `TokenTracker` ma flagę `estimated` per rola + `hasEstimates(role)`; `TokenViewerWidget` pokazuje prefiks `~` + „przybliżone" dla minion/master gdy dane z fallbacku.

## E2.3 (K4/K5) update (2026-07-22) — oś autonomii per-tab zamiast trybów Gadaj/Rób (D21/F12)
- **Nowa oś: `ChatView.currentAutonomy`** (`yolo`/`edge`/`all`, default `edge`) — trzymana per-tab w `_agentStates` **obok** rollingWindow/tokenTracker (dokładnie tak jak dawny `mode`), zwierciadło `plugin.currentAutonomy` dla dziedziczenia przez suby. Default z `_getDefaultAutonomy()` (`settings.pkmAssistant.defaultAutonomy || DEFAULT_AUTONOMY`). **Autonomia to polityka UI „czy pytać", nie własność agenta** — nie ma per-agent override (w przeciwieństwie do dawnego `agent.defaultMode`).
- **UI:** przycisk autonomii w pasku inputu (`chat_ui.js`, zastąpił przycisk trybu) + popover 3 stanów z opisami 1-zdaniowymi (`_toggleAutonomyPopover`/`_applyAutonomyChange`/`_getAutonomyIcon`/`_updateAutonomyButton` w `chat_popovers.js`). Ikony: rakieta (yolo) / tarcza (edge) / lupa (all). **Zmiana autonomii NIE wstrzykuje wiadomości do rozmowy** — model o niej nie wie (inaczej niż stary tryb, który dopisywał `[System] Tryb zmieniony…`).
- **Przekazanie:** `turn.autonomy = this.currentAutonomy` → `_chatExecuteToolCall` → `mcpClient.executeToolCall(toolCall, agent, { autonomy })`. Suby: `SubAgentRunner._executeTool` → `{ autonomy: plugin.currentAutonomy }`.
- **Tryby Gadaj/Rób SKASOWANE (K5, D21):** `_chatResolveTools` nie przecina już narzędzi z `getToolsForAgent(mode)` — baza = `filterByAgent(agent)` (whitelista serwerów agenta). **Narzędzia = uprawnienia agenta, nie tryb.** Usunięte: `currentMode`, `_DEFAULT_MODE`, `_getDefaultMode`, `_applyModeChange`, `_toggleModePopover`, `_getModeIcon`, `_renderModeChangeButton`, `_pendingModeChange`, read-limiter 1×/turę, `turn.mode`/`turn.modeRestore`/`turn.vaultReadCount`, `plugin.currentWorkMode`, `core/WorkMode.js`. Skill nie przełącza już trybu (auto-promocja gadaj→rob out).


## Czystka E3.6 update (2026-07-28) — Token Viewer: 2 zakładki
- Dropdown ról Token Viewera = `['main','researcher']` (etykiety „Główny"/„Sub-agent"); zakładka
  Strateg OUT (slot martwy w runtime od E2.4). `LEGACY_ROLES` składa stare stany widoku
  (minion/master/strategist) do `researcher`. Klucz i18n `chat.token_viewer.role.strategist` skasowany.

## E2.4 update (2026-07-23) — marker @@skill: wstrzykuje przepis + nowe triggery nudge (D17)
- **`@@skill:` = przepis inline, nie wywołanie narzędzia.** `skill_execute` skasowany (D17), więc `buildInlineTriggerInstruction` (`chat/InlineChipPlugin.js`) dla markera skilla nie każe już wołać `skill_execute` — wstrzykuje **PEŁNY przepis** zresolwowanego skilla (nagłówek „UŻYTKOWNIK URUCHOMIŁ SKILL … — wykonaj poniższy przepis"). Resolucja jest async/plugin-zależna, więc `send_message` (`chat_streaming.js`) robi `agentManager.resolveSkillConfig(name, activeAgent)` (overrides `prompt_append` działają) i podaje gotową mapę `resolvedSkills` do czystej funkcji. Nieznany skill → krótka nota (bez wybuchu). Sub-agent/tool markery bez zmian. Test: `InlineChipPlugin.test.js`.
- **Nowe triggery nudge todo-po-skillu** (`_chatOnToolResults`/`turn`): stary `toolCall.name === 'skill_execute'` OUT. Nowe: (a) tura z markerem `@@skill:` → `turn.skillActiveAt = 0` na starcie; (b) udany `read` którego `path` zaczyna się od `.pkm-assistant/skills/` → `turn.skillActiveAt = i`. Nudge (`chat.streaming.skill_todo_nudge`) + `skillArtifactCreated` (idea_review/plan_review/chat_todo) bez zmian.
- ⚠️ ~~**Zauważone, nietknięte (rozjazd E2.6):** reload skilli po zapisie sprawdza starą nazwę `vault_write`, więc gałąź jest martwa.~~ ✅ **NAPRAWIONE w D6d (2026-07-30)** — patrz sekcja niżej.

## E2.8 update (2026-07-23) — prompt kompresji per agent + bramka ratunku pamięci
- **Prompt kompresji odhardcodowany (B3).** Stały szkielet instrukcji kompresji wyniesiony z `Summarizer.getSummaryPrompt` do fabryki `compressionPrompt.js` (`DEFAULT_COMPRESSION_PROMPT`, placeholdery `{{DYNAMIC_HEADER}}`/`{{CONVERSATION}}`/`{{EMERGENCY_SECTION}}`/`{{SESSION_PATH}}` składane w kodzie). `Summarizer` przyjmuje `options.compressionPrompt` (fallback = factory); dynamiczne kawałki nadal składa w kodzie. **Przewód:** `chat_session._createRollingWindow` woła `resolveWorkPrompt(activeAgent, 'compression_prompt', settings, DEFAULT_COMPRESSION_PROMPT)` (łańcuch agent>global>factory) i wstrzykuje wynik do RollingWindow→Summarizer (Summarizer nie zna agenta — chat_session zna). Nowe pole agenta `compression_prompt` (default ''). KONTRAKT: sentinel `===MEMORY_CANDIDATES===` + fenced ```json MUSI przeżyć override (parser `memoryCandidates.js`) — Settings→Prompt ostrzega przy polu.
- **Bramka `memory_rescue` per agent (C9/S23).** `turnOwner.saveMemoryCandidatesFor` na starcie: `if (activeAgent.memory_rescue === false) return 0` — agent z wyłączonym ratunkiem nie zapisuje kandydatów wyłuskanych przy kompresji okna (E2.7 W2). Default ON. Ścieżka ratunku od D8 (2026-08-27): parser bez zmian, ale zapis idzie do POCZEKALNI — `turnOwner.saveMemoryCandidatesFor` → `AgentMemory.writePendingRescue` (`brain/pending_rescue/`, poza indeksem); review i accept/reject w modalu zapisu sesji (`SaveSessionWorkflow.prepareProposals` dokłada kandydatów do listy). Fail-soft: pad zapisu poczekalni → dawny `writeBrainNote` wprost (lepszy niezreview'owany zapis niż utrata), z wąskim catchem przeciw duplikatom przy torn-write.

## E2.9 FAZA D update (2026-07-23) — live-widok todo + kasacja panelu artefaktów
- **Live-widok `todo` NAD inputem (D2).** `todoPanel.js` (pure `buildTodoPanelModel`) + `chat_ui._renderTodoPanel` + kontener `_todoPanelBar`; reactor `todo` w `ToolReactorRegistry` aktualizuje `this._activeTodoState` po każdym tool-callu i re-renderuje (active tab). Czyszczony przy switchu agenta (`chat_tabs`). Zastąpił `ArtifactProgressModal` (polling 1s).
- **`chat_artifacts.js` odchudzony do przycisku delegacji.** Panel `_toggleArtifactPanel`/`_refreshArtifactPanel`, `openProgressModal`/`_progressModal`, `_autoSaveArtifact` SKASOWANE (stary świat `_planStore`/`_chatTodoStore` + `ArtifactProgressModal`/`IdeaReviewModal`). Został tylko `_renderDelegationButton` (wołany z `chat_streaming`), oczyszczony z `_planStore`. Stary przycisk „Artefakty" (`_artifactBtn`) usunięty z `chat_ui` (duplikat labelu segmentu C2).
- **`chat_session`:** `_refreshSystemPrompt` (martwy) + hook context-session (`ContextSessionGenerator`, A18) usunięte; `_buildEmergencyTaskContext` czyta `_activeTodoState`. `chat_streaming`: martwy `artifacts:{todos,plans}` + `TOOL_STATUS`/nudge na nowe nazwy.

## Watchdog streamu update (2026-07-29) — przerwanie tury gdy model milczy
- **Problem (log vaulta 2026-07-29):** lokalne proxy zgodne z API LM Studio, z modelem reasoning, przyjmował request i nie oddawał ANI JEDNEGO chunka (`[ChatAdapter] no chunk`) — tura wisiała w nieskończoność (twardy timeout XHR w adapterze to dopiero 600 s), aż user ręcznie kliknął Stop.
- **`StreamWatchdog`** (pure, node-testowalny, `StreamWatchdog.test.js` — 8 testów z fake-timerami; ⚠️ od S29 Z1 mieszka w **`core/utils/StreamWatchdog.js`**, nie w `chat/` — potrzebuje go też `modules/memory/streamHelper.js`, a memory nie może importować z chat): jeden timer zbrojony na start KAŻDEGO wywołania modelu (`_chatOnIterationStart` + `_chatOnBackstop`), resetowany każdym chunkiem (`callbacks.chunk` w `send_message`), rozbrajany gdy model skończy mówić (`_chatOnToolCallsParsed`, `_chatBeforeContinue`, finally pętli). Łapie brak pierwszego chunka ORAZ stall mid-stream. **Czas pracy narzędzi się NIE liczy** — to osobna warstwa timeoutów (`modules/tools/server_timeout.js` 60/180 s, nietknięta).
- **Limit: `config/limits.js` `chat_stream_stall_timeout_ms` (default 120 s, 0 = wyłączony, sufit 600 s).** Nadpisywalny w Settings → Limity (wiersz „Watchdog streamu czatu", wpisywany w sekundach). Platforma **xai wyłączona z watchdoga** — `PKMXaiAdapter` nie streamuje (chunk raz, po pełnym `complete()`), cisza mid-flight jest tam normalna.
- **`_onStreamStall(turn, silentMs)`** przerywa turę TĄ SAMĄ ścieżką co ręczny Stop: aktywna zakładka → `stop_generation(agentName)` + uczciwy komunikat w czacie (`chat.streaming.stall_aborted`, pl+en); zakładka w tle → cleanup stanu jak `handle_error` + crystal notice. Wyrejestrowuje też stream ze StreamingManagera (wiszący XHR po abort NIE rozstrzyga promisy pętli — dawny transport strumienia nie emitował zdarzenia na abort — więc `finally` w `send_message` może nigdy nie ruszyć).
- **`stop_generation` przyjmuje teraz opcjonalny `agentName`** (watchdog celuje w agenta swojej tury; przycisk Stop bez argumentu = aktywny agent, bez zmian; od K5 drugi argument to `reason`) i **przerywa XHR WŁAŚCIWEJ instancji modelu** (`_streamCtxMap.get(agent).chatModel` — równoległa tura z `needsFreshModel` używa świeżej instancji, której `env.chatModel` nie znał; fallback na `env.chatModel` zachowany). Rozbraja też watchdog tury.
- **Zero wycieków timera:** disarm w finally pętli + w `stop_generation` + `chat_view.onClose` rozbraja watchdogi wszystkich tur (także na zakładkach w tle). ⚠️ **Od K5 `onClose` NAJPIERW zatrzymuje tury (`stop_all_turns`), a dopiero potem rozbraja resztki timerów** — dawna kolejność zdejmowała strażnika turze, której nikt nie zatrzymywał (AUD-security-068).

## S29 update (2026-07-29) — trigger konsolidacji przepięty na „Puls pamięci"

- **`consolidationRunner.js` (NOWY, korzeń modułu — nie mixin).** Klej między silnikiem
  konsolidacji (`modules/memory`) a widokami (modal w `modules/shell`, pasek statusu w
  `core/runtime/PluginRuntime.ts`, crystal notices z `main.js`). Mieszka w chacie, bo to chat jest właścicielem
  triggera i jedynym miejscem, które importuje OBA barrele. Leży w korzeniu `modules/chat/`, a nie
  w `chat/`, bo `slash-commands/save_session.js` musi go zaimportować — specyfikator `../chat/...`
  wyglądałby dla ESLinta jak deep import w cudzy moduł.
  API: `startConsolidationRun({plugin, app, agentMemory, agent, model, settings})`,
  `openConsolidationModal(app, run)`. `registerConsolidationModalOpener(app)` (idempotentna
  subskrypcja `open_modal_requested` — obsługuje klik w 🧠 na pasku statusu) jest od
  AUD-dead-code-231 (2026-09-02) **wewnętrzna** (bez `export`) — jedyny wołacz siedzi w tym samym
  pliku (`startConsolidationRun`), poza modułem nikt jej nie importował.
  **`startConsolidationRun` jest w barrelu** (`modules/chat/index.js`) — poza czatem woła go profil
  agenta (guziki „Podsumuj rozmowy" / „Sumaryzuj streszczenia") leniwym `import()`.
- **`slash-commands/save_session.js`: próg konsolidacji NIE odpala już starego
  `ArchiveWorkflow.run()`.** `SaveSessionWorkflow` dostaje teraz konstruktor **bez**
  `archiveWorkflow` (nadal zwraca `shouldTriggerArchive`), a handler po archiwizacji woła
  `startConsolidationRun(...)` — nieblokująco. Dotyczy WSZYSTKICH wejść przez `runSaveSessionFlow`:
  `/save session`, 🧠, `/memory`, SessionCloseModal „archive", idle-scheduler.
  Notice „Czas na konsolidację pamięci" (`modal.save_session.archive_due`) **usunięty** —
  zastąpiony notice'em startowym PRZED kaskadą (`memory.consolidation.notice_start`).
- **„Anuluj" w fazie propozycji wreszcie anuluje (`prepareWithCancel`).** Decyzja usera ściga się
  ze strzałem do modelu (`Promise.race`), przegrany strzał dostaje `AbortController.abort()`
  (ta sama droga co Stop w czacie), a pad/zwis nie spada po cichu na regexy — modal pokazuje
  przyczynę i guzik „Ponów analizę". Watchdog zwisu z tego samego źródła co czat
  (`config/limits.js` → `chat_stream_stall_timeout_ms`).
- ✅ **Stary tor SKASOWANY (D6, 2026-07-30).** Guzik „Podsumuj rozmowy" w profilu agenta przeszedł
  na `startConsolidationRun` w kubełku 2, a w D6 poszły do kosza `ArchiveWorkflow.run()`,
  `createLevel1/2/3`, `ArchiveModal` i `ConsolidationSnapshot.create/restore`. **Konsolidacja ma
  dziś JEDNĄ drogę** — `startConsolidationRun` → `runWithRun` → `applyStepDecision`.

## Z4.3 + Z4.4 update (2026-07-30) — automat nie spamuje, `/save session` widoczny w koszcie

- **`startConsolidationRun({..., source})`** — nowa opcja `'auto' | 'manual'` (default `'manual'`).
  Przy PUSTYM planie `manual` (guzik „Podsumuj rozmowy" w profilu, `/memory`) nadal mówi „nie ma czego
  konsolidować", a `auto` **milczy** (tylko `log.debug`). Powód: licznik
  `archived_since_last_consolidation` zeruje dopiero realny zapis paczki L1, więc gdy niepokrytych
  sesji jest mniej niż `batchSize`, próg jest przebity przy KAŻDYM kolejnym zapisie sesji — user
  dostawał ten notice po każdym `/save session`, bez końca. Licznika świadomie NIE zerujemy
  (materiał wciąż rośnie do pełnej paczki). Call-site'y: `slash-commands/save_session.js` (próg +
  idle-scheduler, wszystkie wejścia `runSaveSessionFlow`) → `'auto'`;
  `modules/agents/profile/profile_memory.js` → `'manual'`.
- **Koszt `/save session` idzie do `CostLog`** (`role: 'save-session'`). `prepareProposals` zwraca
  teraz `usage` strzału propozycji (`null` na ścieżce regexowej), a handler dopisuje JEDEN wpis
  zaraz po udanej analizie — przed oknem przeglądu, bo tokeny spaliły się niezależnie od decyzji
  usera. Bez delty (jedno wywołanie ≠ przebieg konsolidacji, który domyka się kilka razy).

## Kubełek 2 update (2026-07-29) — kontroler konsolidacji wreszcie testowalny

- **Modal ładowany LENIWIE.** `consolidationRunner.js` nie importuje go statycznie — robi to
  `await import(...)` w `openConsolidationModal` (funkcja jest teraz **async**; wołacz
  w subskrypcji openera ma `.catch()`). Powód: statyczny import ciągnął `obsidian`, więc CAŁY
  kontroler — najbardziej stanowy kawałek S29 — nie dawał się zaimportować w AVA i miał
  **zero testów**. *(S31: cel importu to dziś sąsiedni `./ConsolidationProgressModal.js`,
  nie barrel shella — leniwość zostaje, bo `obsidian` w modalu nie zniknął.)*
  Nowy `_setModalClassForTests(cls)` wstrzykuje atrapę okna; produkcyjne API bez zmian.
- **`consolidationRunner.test.js` (NOWY, 15 testów)** — integracyjne: prawdziwe `AgentMemory`,
  `ArchiveWorkflow`, `ConsolidationRun`, `memoryOpsCenter`; atrapy tylko dla modelu, modalu
  i notice'ów. ⚠️ Wszystkie `test.serial` — centrum operacji to singleton modułowy, a `openModal`
  i subskrypcja openera to stan modułu.
- **Licznik planu zgodny z generatorem.** `startConsolidationRun` liczy `archiveCount`
  z `listUncoveredArchiveSessions()` (sesje BEZ stempla `covered_by_l1`), a nie z surowego listingu
  archiwum. Wcześniej plan obiecywał paczki, które generator odrzucał jako `not_enough_sessions`
  (modal z krokami, z których nic nie wynika). Rzut listowania → 0 paczek L1.
- **Opener nie zostaje z martwym `app` po dev-reloadzie.** `registerConsolidationModalOpener`
  jest idempotentne dla TEJ SAMEJ instancji `app`; inna instancja odpina starą subskrypcję
  i zakłada świeżą (wcześniej pierwsza wygrywała na zawsze i modal celował w martwy workspace).

## Sieroty sesji update (2026-07-29) — zamknięcie zakładki czeka na zapis + draft/discard sprzątają
- **`_closeActiveTab` jest teraz `async` i `await`-uje `handleSaveSession()`** przed `_agentStates.delete`/`splice`/`_switchTab`. Wcześniej zapis i przełączenie agenta leciały fire-and-forget równolegle — zapis mógł trafić do pliku już przełączonego agenta albo zgubić ostatnie wiadomości. Pad zapisu jest łapany (`log.warn`), zakładka zamyka się mimo wszystko. Caller (`closeBtn` w `chat_ui.js`) jest async i łyka błąd, żeby nie zostawić unhandled rejection.
- **`handleNewSession` gałąź „odrzuć" sprząta starą sesję** przez `_retireActiveSession` → `AgentMemory.discardActiveSession()`: plik idzie do `sessions/active/.discarded/`, wpis znika z `active_sessions`. Bez twardej kasacji. ⚠️ **Do S36b wchodziła tędy też gałąź „draft"** (dopiero PO udanym `saveDraft`) — cała rodzina draftów skasowana, patrz sekcja „S36b update" na końcu pliku.
- **`_pruneEmptyActiveSessionFromState` bez zmian** — po naprawie czytnika w `modules/memory` (`_parseActiveSessionFile` rozumie też transkrypt `## User`/`## Assistant`) strzela już tylko przy naprawdę pustych plikach. O to chodziło.

## D6d update (2026-07-30) — reload skilli po zapisie znowu żyje (dług E2.6 spłacony)

- **`_chatOnToolResults`: warunek `toolCall.name === 'vault_write'` → `'write' || 'vault_write'`.**
  E2.6 przemianowało narzędzie na `write`, a warunek został na starej nazwie — od tamtej pory
  po zapisaniu przepisu do `.pkm-assistant/skills/**` **nie odpalał się** ani
  `agentManager.reloadSkills()`, ani `renderSkillButtons()`, ani link do zapisanego pliku
  w chacie. User musiał przeładować plugin, żeby zobaczyć świeżo napisany skill.
- ⚠️ **Dlaczego OBIE nazwy, skoro są aliasy.** `results[].toolCall` (z `runAgentLoop`) niesie nazwę,
  którą wypisał MODEL. Alias `vault_write → write` żyje w `MCPClient.executeToolCall` i działa przez
  **rebind lokalnej zmiennej** (`toolCall = { ...toolCall, name: mapped.name }`), a nie mutację —
  obiekt widziany przez hooki czatu zostaje z oryginalną nazwą. Model z nawykiem starej nazwy
  nadal tu dociera, więc warunek sprawdza obie. Ta sama zasada dotyczy każdego hooka czatu
  porównującego `toolCall.name` z nazwą narzędzia.
- **`toolCall.arguments` parsowane defensywnie** (bywa stringiem JSON — jak w gałęzi `read` obok).
  Stare `toolCall.arguments?.path` dawało `undefined` dla stringa, czyli druga cicha awaria.
- **Dwie martwe gałęzie wycięte przy okazji** (obie w tym samym bloku):
  `/minions/` → `agentManager.reloadMinions()` — **metody nie ma w repo**, a `?.` stoi na
  `agentManager`, nie na metodzie, więc po ożywieniu gałęzi rzucałaby `TypeError` w środku
  `_chatOnToolResults`; „minions" to nazwa sprzed E2.4, sub-agenci żyją w `.pkm-assistant/sub-agents/`
  i nie mają hot-reloadu. Oraz `playbook.md`/`vault_map.md` → `this._playbookDirty = true` — flaga
  **write-only**, zero czytelników (Playbook Builder skasowany w E2.8 A4).

## N2-N4 update (2026-08-09) — pasek dolny: dwa widoki, dynamiczna rezerwa miejsca, picker bez dumpu

- **N4: slot paska ma DWA widoki w jednym obrysie** — `'input'` (textarea, `this._inputRow`)
  albo `'todo'` (lista zadań W MIEJSCU textarea, `this._todoPanelBar`). Dolny rząd guzików
  (wyślij/stop, spinacz, mikrofon, autonomia…) widoczny w OBU. Przełącza chip `📋 done/total`
  (`this._todoToggleBtn`, pierwszy w `barLeft`, widoczny tylko gdy lista żyje).
  Decyzję „który widok" podejmuje **pure `resolveBottomBarMode(prev, next, current)`**
  (`chat/todoPanel.js`, testy w `todoPanel.test.js`): pojawienie się listy = auto-przeskok na
  `'todo'`, zniknięcie (finish/pusta) = powrót na `'input'`, a update itemów w trakcie życia
  listy NIE rusza widoku — ręczny wybór usera zostaje. Stan (`_bottomBarMode`, `_prevTodoModel`)
  startuje w konstruktorze `ChatView` i zeruje się przy przełączeniu zakładki (`chat_tabs.js`),
  razem z `_activeTodoState`. `_buildEmergencyTaskContext` (chat_session) czyta ten sam
  `_activeTodoState` — nietknięte.
- **N3: `ResizeObserver` rezerwuje miejsce pod pływającym paskiem.** `.cs-input-panel` jest
  `position:absolute` nad wiadomościami, a `.pkm-chat-messages` miało sztywne
  `padding-bottom: 120px` — rosnący pasek (todo, chip artefaktu) zasłaniał treść. Obserwator
  (zakładany na końcu `render_view`, `feature-detect` + rozbrajany w `chat_view.onClose`)
  ustawia `paddingBottom = wysokość paska + 24`. CSS 120px ZOSTAJE jako fallback dla środowisk
  bez `ResizeObserver`.
- **N2: klik w wiersz pickera artefaktów NIE wysyła już dumpu stanu.** Woła
  `activateArtifactInChat` (`modules/artifacts`) = przypnij artefakt + odśwież chip, po czym
  otwiera notatkę w nowej karcie (`vault.getAbstractFileByPath` → `workspace.getLeaf('tab').openFile`).
  Wysyłkę stanu robią dalej **guziki w notatce** (`artifactBlocks`) i **🔄 na chipie** — oba
  celowo zostają na `summonAgentForArtifact`.

## S36b update (2026-07-30) — gałąź „draft" w `handleNewSession` SKASOWANA

Modal zamknięcia sesji miał trzecią opcję — **„Zostaw jako draft"** — która wołała
`AgentMemory.saveDraft(...)`, pokazywała notice „Sesja zapisana jako draft" i odkładała starą sesję
do `.discarded/`. Problem: **drafty nie miały czytnika od Memory v3** (obiecane wejścia
`_checkRecoverableDrafts` i slash `/drafts` nigdy nie powstały), więc user dostawał potwierdzenie
zapisu rozmowy, do której nie miał jak wrócić. Cała rodzina draftów poszła do kosza — szczegóły
w [`modules/memory/CLAUDE.md`](../memory/CLAUDE.md) i [`modules/shell/CLAUDE.md`](../shell/CLAUDE.md).

- **`handleNewSession` ma dziś dwie gałęzie:** `archive` (→ `consolidateSession`) i `discard`
  (→ `_retireActiveSession`, plik do `.discarded/`). `cancel` bez zmian.
- **`_retireActiveSession` NIETKNIĘTY** — stracił jednego z dwóch wołaczy, drugi (`discard`) żyje.
- **Kontrakt `SessionCloseModal.prompt()` bez zmian** (`{choice, options}`), więc zmiana jest
  wyłącznie ujęciem jednej gałęzi `else if`, nie przeróbką przewodu.
- i18n `chat.session.draft_saved` skasowany (pl+en).

## F2 faza B update (2026-08-15) — delegacja w tle: adres zwrotny, pokwitowanie, auto-tura

Od F2 `delegate` domyślnie **nie blokuje tury** (`modules/tools/CLAUDE.md`): model dostaje
pokwitowanie `{started, task_id}`, a bieg suba kończy się długo po zamknięciu tury. Czat jest
w tym układzie **nadawcą adresu zwrotnego i odbiorcą wyniku**.

- **Origin liczony RAZ na turę.** `send_message` składa `turn.origin =
  {agentName, sessionPath, tabKey}` przed pętlą i podaje go do KAŻDEGO wywołania narzędzia
  (`_chatExecuteToolCall` → `mcpClient.executeToolCall(..., {autonomy, origin})`). Nie per tool
  call, bo user może w trakcie tury przełączyć zakładkę — a wynik ma wrócić tam, SKĄD wyszło
  zlecenie. `sessionPath` to `activeSessionPath` pamięci agenta z momentu STARTU tury (ta sama
  wartość zasila etykietę trace). `tabKey` liczy **`chat_tabs._tabKey`** — od tej zmiany
  eksportowany, bo origin i dopasowanie wyniku muszą używać dokładnie tej samej tożsamości
  zakładki co `_switchTab`.
- **Pokwitowanie zamiast pustej ramki.** `_chatOnToolResults` ma gałąź `result.started === true`
  PRZED gałęzią `success`: rysuje blok sub-agenta z pulsującym statusem
  (`createSubAgentBlock({pending:true})` — wariant dodany w `modules/ui-components`), listą
  wystartowanych zadań (nazwa + `task_id`), liczbą `queued` i notą „wynik wróci powiadomieniem".
  Bez tej gałęzi leciała gałąź `success`, a w zwrotce tła nie ma `result`/`tools_used`/
  `duration_ms` — user dostawał PUSTĄ ramkę z zielonym „gotowe".
- **Token tracker pomija `started`.** Fallback estymaty (gdy sub nie zwrócił `usage`) policzyłby
  tokeny samego pokwitowania i wpisał je jako pracę suba. Prawdziwe zużycie przychodzi z wynikiem.
- **Czat jest DOSTAWCĄ wyników** (`plugin.subTaskNotifier`). `ChatView.onOpen` woła
  `_wireSubTaskDeliverer()` **po `initSessionManager()`** — dopiero wtedy stoją zakładki, do
  których dopasowuje się origin; wpięcie robi od razu pierwszy `drain()` (wyniki, które
  skończyły się przy zamkniętym czacie, wjeżdżają na wejściu). `onClose` odpina dostawcę.
- **Auto-tura tylko na AKTYWNEJ i bezczynnej zakładce, pod sufitem łańcucha.**
  `_deliverSubTaskResult` zwraca `false` (= „zostaw w kolejce”), gdy: nie ma zakładki adresata,
  zakładka jest w tle (auto-tura za plecami usera to robota, której nie widzi), trwa tura, albo
  (werdykt Kuby 16.08) łańcuch auto-tur po subach dla tego agenta osiągnął sufit
  `max_consecutive_auto_turns` (`config/limits.ts`, default 5) — patrz update niżej. Dopiero
  aktywna + idle + pod sufitem dostaje `send_message({injectedText})`. Zakładkę wskazuje pure
  `matchTabForOrigin` (`tabKey` → fallback po agencie → `null`).
- **Pierwszeństwo ma user.** W `set_generating(false)` najpierw leci istniejąca ścieżka
  `_queuedMessage`, a `drain()` odpala się TYLKO wtedy, gdy kolejki nie było (oba przez
  `setTimeout(…, 100)`, żeby rozwinął się stos tury). Drugie wejście: `_switchTab` (krok 11).
  **Po przerwaniu (`_drainSuppressed`, do K5: `_abortedStream`) drenu NIE MA** — ręczny Stop i watchdog przechodzą tą samą
  ścieżką, a „nacisnąłem Stop i po 100 ms samo zaczęło gadać" łamałoby obietnicę guzika (przy
  watchdogu doszłaby jeszcze tura w martwy serwer). Wynik czeka do końca następnej tury albo
  do przełączenia zakładki; bezpiecznik gasi start następnej tury (`set_generating(true)`).
- **`send_message(opts)`** przyjmuje `{injectedText, meta}`. Przy `injectedText` **nie rusza
  `input_area`** (user może mieć szkic!), nie zjada załączników ani wzmianek `@`, nie dopisuje
  do historii inputu, nie parsuje markerów `@@skill:` (treść wyniku suba to nie polecenie) i nie
  wchodzi w komendy `/`. Reszta tury jest identyczna. `meta` (`{_subTaskNotification:true,
  subTaskId}`) idzie na wiadomość w oknie kontekstu — `append_message` ma na to czwarty parametr.
- **Powiadomienie jest TRWAŁE:** leci przez `appendToActiveSession` jak każda wiadomość usera,
  więc przeżywa restart Obsidiana (replay event-logu). Treść składa pure
  `chat/subTaskNotification.js` (`buildSubTaskNotificationText`) — nagłówek (nazwa + `task_id`),
  stan po ludzku + czas, wynik przycięty do `max_tool_result_length` ALBO błąd, i stopka
  każąca modelowi podjąć wątek. Cały tekst przez `t()` (pl+en), bo czyta go i model, i user.

**Gotchas:**

- ⚠️ **Kolejka `pending` w notifierze NIE przeżywa restartu Obsidiana** — żyje w RAM
  (`modules/sub-agents/SubTaskNotifier.js`). Zamknięcie czatu jest bezpieczne (wyniki czekają
  do ponownego otwarcia), ale reload pluginu / restart aplikacji **gubi niedostarczone wyniki**;
  gubi też same biegi, bo suby nie są wznawialne. Trwałość dotyczy dostarczonych powiadomień
  (event-log sesji), nie kolejki.
- ⚠️ **Notifier trzyma JEDNEGO dostawcę.** Przy dwóch otwartych widokach czatu wygrywa otwarty
  jako ostatni, a zamknięcie któregokolwiek robi `setDeliverer(null)` dla obu. Wyniki nie giną
  (zostają w kolejce), ale do najbliższego otwarcia czatu nikt ich nie odbierze.
- ⚠️ **Serializacja stoi na `_subTaskTurnPending`.** `drain()` woła dostawcę w PĘTLI, a
  `send_message` dochodzi do `set_generating(true)` dopiero po kilku `await` — bez tej flagi
  drugi czekający wynik wystartowałby równoległą turę na tej samej zakładce. Flaga gaśnie
  na `set_generating(true)` (dalej pilnuje `is_generating`) oraz w `finally` auto-tury.
- ⚠️ **`send_message` bywa wpięte wprost jako listener kliknięcia** (`chat_ui.js`:
  `send_button.addEventListener('click', this.send_message.bind(this))`), więc pierwszym
  argumentem potrafi być `MouseEvent`. Z `opts` czytamy dlatego tylko `injectedText`
  (z jawnym `typeof === 'string'`) i `meta`.
- ⚠️ **Auto-tura może zlecić kolejne suby** — to zamierzone („podejmij wątek"), ale oznacza, że
  łańcuch tło → powiadomienie → tura → tło potrafi się ciągnąć. Hamulcem jest bramka
  `max_parallel_delegations` (liczy też biegi już w tle, patrz `modules/tools/CLAUDE.md`).

## Z3 update (2026-08-15) — szkic usera w polu czatu przestaje znikać

Śledztwo FAIL 6 żywego smoke'a („główny szkic czatu resetuje się przy kolejnych toolach", 18:05):
**żadna ścieżka czatu nie czyści `input_area` przy wynikach narzędzi.** Pełny spis zapisów do pola
(wysyłka usera, kolejka wiadomości, komendy `/`, pre-pytania skilla, popup `/@`, STT, edycja
wiadomości, przywołanie artefaktu, komentarz inline) plus korelacja z `trace.log`/`pkm-assistant.log`
z okna 16:01:31–16:05:19Z (tylko `ask_user` i `delegate`, zero `todo`, zero kolejki, zero zmiany
zakładki, zero `render_view`) zamykają temat: to nie było kasowanie wartości. Naprawione zostały
za to DWA realne zjadacze szkicu, oba pasujące do opisu objawu:

- **Auto-przeskok paska dolnego (N4).** Pojawienie się listy `todo` przełączało slot na widok
  listy i chowało CAŁY wiersz inputu (`display:none`) — niewysłany tekst znikał userowi z oczu
  przy tool-callu, mimo że wartość textarea była nietknięta. `resolveBottomBarMode` dostał
  czwarty argument `hasDraft`: **auto**-przeskok nie odbywa się, gdy w polu siedzi szkic.
  Ręczne przełączenie chipem `📋` i powrót po zniknięciu listy — bez zmian.
- **Kolejka wiadomości.** `set_generating(false)` robiło `input_area.value = queued`, kasując bez
  śladu szkic, który user napisał PO zakolejkowaniu. Teraz taki szkic jest odkładany
  (`_draftAfterSend`) i oddawany w `send_message` zaraz po `resetInputArea()`. ⚠️ Restore MUSI być
  tam, bo `resetInputArea` leci dopiero po awaitach `send_message` — oddanie szkicu „od ręki"
  w `setTimeout` zostałoby przez nie zjedzone.

⚠️ **To, co Kuba realnie zobaczył o 18:05, siedziało w panelu biegów subów**, nie w czacie —
patrz `modules/sub-agents/CLAUDE.md` (retencja szkicu wiadomości do biegu).

## Runda 2 update (2026-08-17) — kolejka mostu ≠ cisza modelu + wynik suba bez rzeźni

Żywy smoke inicjatywy „Suby: watchdog ciszy i szyba 2026" (incydent 09:15Z): user pisał
w trakcie 5:39-minutowej syntezy suba na jednopasmowym moście — jego tura stała w kolejce
bramki i watchdog ciszy ubił ją równo po 120 s, bo zbrojenie w `_chatOnIterationStart`
liczyło czekanie w kolejce jako ciszę modelu. Trzy zmiany:

- **Watchdog ciszy czatu zbroi się na `onGateAdmitted`** (wejście requestu na slot bramki),
  nie w `onIterationStart`/`onBackstop`. Chmura emituje sygnał natychmiast (kontrakt
  `ChatModel`) — tam zero zmian; na platformie lokalnej faza kolejki jest nieliczona.
  Pas ostateczny na „sygnał nigdy nie przyszedł" = `chat_model_call_timeout_ms`
  (runda 2: 300 s → **600 s**, bo kolejka za syntezą suba trwa realnie minuty, a budzik
  per-call ma JEDNO przezbrojenie na admisji).
- **`buildSubTaskNotificationText` tnie wynik suba do `subagent_result_max_chars`**
  (default 60000, **0 = bez limitu**; śmieciowa opcja spada na ten default) zamiast
  wspólnego `max_tool_result_length` (15k) — deep-research suba wracał ucięty w połowie.
  Ta sama zasada w pętli tury: `limits.maxToolResultLengthPerTool = { delegate, agent_delegate }`
  (per-tool override w `runAgentLoop`).

## Friendly fire update (2026-08-15 wieczór) — watchdog celuje w turę, nie w agenta

Incydent 17:13 (pierwszy żywy test F1-F5): user porzucił wiszącą turę i wystartował NOWĄ SESJĘ
tego samego agenta; porzucona tura została w tle z uzbrojonym watchdogiem. Po 120 s watchdog
strzelił „po nazwie agenta": `stop_generation` ubił świeży request ŻYWEJ tury (wspólna cache'owana
instancja modelu) i rozbroił jej watchdog (wspólny wpis `_streamCtxMap` per agent). Żywa tura
została z promisą, która nigdy się nie rozstrzygnie (xhr.abort nie emituje zdarzenia) i bez
żadnego strażnika — czat wisiał w nieskończoność. Trzy fixy:

1. **`turn.turnId`** (licznik modułowy) + `turnId` we wpisie `_streamCtxMap`; `_onStreamStall`
   porównuje tożsamość: watchdog PORZUCONEJ tury sprząta po sobie (wyrejestrowanie streamu,
   log.warn) i NIE woła `stop_generation` — żywa tura nietknięta.
2. **`handleNewSession` ubija trwającą turę** (`stop_generation()` na wejściu) — nowa sesja nie
   zostawia już zombie z uzbrojonym watchdogiem.
3. **Czat ma per-call budzik** — `chat_model_call_timeout_ms` (default 300 s, 0 = off,
   Settings→Limity) jako `limits.perCallTimeoutMs` pętli. Pas ostateczny na klasę „promisa nigdy
   się nie rozstrzygnie"; kolejka bramki mostu się nie liczy (`gate_admitted` przezbraja budzik).

## Pasek biegów subów update (2026-08-15) — podgląd delegacji w OKNIE CZATU

Decyzja Kuby: biegi subów lecą **per agent i per sesja**, więc podgląd nie należy do
globalnego sidebara (tam wisiał od F3, jeden dzień), tylko do okna, z którego user je zlecił.

- **Gdzie:** `chat_ui.render_view` montuje kontener zaraz PO pasku zakładek
  (`this._tabBarContainer`), NAD `pkm-chat-body` — czyli pasek biegów jest drugim rzędem
  nagłówka czatu. Render: `chat/subTaskStrip.ts` (obsidian-free, strukturalnie typowany DOM
  jak dawny `SubTaskRunsView`), model: `buildStripModel` z **barrela `modules/sub-agents`**.
- **Co pokazuje:** chipy (kryształ statusu z pulsem dla biegnących, nazwa, czas trwania)
  dla biegów TEJ zakładki. Klik = jeden rozwinięty szczegół pod paskiem: status po ludzku,
  liczniki kroków/narzędzi, ostatnie ≤20 kroków (godzina + typ + narzędzie), skrót
  wyniku/błędu, a dla biegu w toku guzik **Stop** (`registry.requestStop`).
  **Pola „Wiadomość do suba" NIE MA** — komunikacja z subem należy do agenta
  (kanał `postMessage` żyje dalej w `modules/sub-agents`, ale bez UI).
- **Filtr per zakładka:** `buildStripModel({tabKey: _tabKey(aktywna), agentName})`.
  Bieg z `origin.tabKey` trafia do swojej zakładki; bieg bez adresu (zlecenie spoza czatu) —
  do zakładki tego samego agenta. Pusty model = klasa `pkm-substrip--empty` (zero wysokości).
- **Live:** `_wireSubTaskStrip` (chat_ui) subskrybuje `plugin.subTaskRegistry.events`
  (`task:created`/`task:step`/`task:finished`) z **debounce 250 ms**; wpięcie w `ChatView.onOpen`
  obok `_wireSubTaskDeliverer`, odpięcie w `onClose` (`_unwireSubTaskStrip`).
  `_switchTab` przerysowuje pasek i zwija szczegół (biegi są per zakładka).
- ⚠️ **Stan rozwinięcia MUSI żyć poza DOM-em** (`this._subStripExpandedId`, inicjowany
  w konstruktorze `ChatView`) — pasek przerysowuje się na każdym kroku suba, więc szczegół
  trzymany tylko w klasie CSS znikałby userowi co kilka sekund. Ta sama mina zjadała
  w sidebarze wpisywaną wiadomość (FAIL 5 smoke'a 2026-08-15). Rozwinięcie biegu, który
  wypadł z listy, jest gaszone; **pole tekstowe czatu i jego focus nie są dotykane** —
  pasek to osobny kontener, przerysowanie go nie rusza inputu.
- CSS: blok `pkm-substrip-*` na końcu `chat_view.css` (chip 28 px, poziomy scroll przy wielu
  biegach, kolory statusu i akcent przez zmienne `cs-*`). i18n: `chat.substrip.*` (pl+en).

---

## K7 update (2026-08-22) — proweniencja wiadomości: `meta.origin` zamiast roli dymka

**Problem (AUD-security-062 / 088 / 003).** Trzy rzeczy w turze traktowały tekst jak POLECENIE,
a nie jak dane: rejestr proweniencji adresów (`registerUrlsFromText` → `isUrlKnown` → bramka
`web_read`), markery inline (`@@skill:` wstrzykuje pełny przepis do promptu SYSTEMOWEGO w ramce
„użytkownik uruchomił skill") i komendy `/`. O tym, czy tekst je dostaje, decydowało to, którą
funkcją narysowano dymek — `append_message('user', …)`. Każda wysyłka inicjowana przez KOD
(guzik „Przywołaj agenta" na artefakcie, guzik propozycji delegacji, komentarz inline z notatki,
auto-tura po wyniku suba) wkłada tekst do pola wpisywania i woła `send_message()`, więc dostawała
pieczątkę człowieka — mimo że treść pisze model albo przyszła ze strony/notatki.

**Kontrakt teraz** (`core/security/messageOrigin.ts`, wystawiony z `core/index.js`):

- `meta.origin: 'human' | 'machine'` — jedyne źródło prawdy o przywilejach wiadomości.
- `'human'` nadają **dwie i tylko dwie** ścieżki: guzik Wyślij i Enter (`chat_ui`).
  Stała: `HUMAN_MESSAGE_META`.
  ⚠️ **Korekta K19:** dawniej stała tu trzecia — wysyłka wiadomości zakolejkowanej
  (`set_generating`) — z uzasadnieniem „jej treść też wpisał user". **To była nieprawda**
  i luka (AUD-security-117/131): do slotu kolejki wpada też tekst maszynowy. Dziś kolejka
  wozi własną pieczątkę i dren ją tylko oddaje — patrz sekcja „K19 update" na końcu pliku.
- **Brak znacznika = maszyna** (fail-closed). Dotyczy też `MouseEvent`, który wpada jako `opts`,
  gdy ktoś wepnie `send_message` wprost jako listener.
- Wysyłki z kodu niosą `MACHINE_MESSAGE_META` (lub `machineMeta({…})`, gdy dokładają pola —
  auto-tura po subie dokłada `_subTaskNotification`/`subTaskId`).
- Bramki żyją w jednym miejscu: `modules/chat/chat/messagePrivileges.ts`
  (`parseTriggersIfHuman`, `mayRunSlashCommand`, `registerUrlsIfHuman`).

**Dwie osie, nie jedna.** `injectedText`/`isInjected` mówi tylko „tekst NIE pochodzi z pola
wpisywania" i rządzi mechaniką inputu (historia strzałki w górę, załączniki, czyszczenie pola,
szkic). `origin` mówi „kto pisał" i rządzi przywilejami bezpieczeństwa. Wysyłki, które pole
wpisywania WYPEŁNIAJĄ, mają `isInjected === false`, a są maszynowe — dlatego jedna oś nie
wystarczała.

**Czego to NIE jest.** `_invocationOrigin` (`MCPClient` → `DelegateTool`) to adres ZWROTNY
zlecenia (zakładka + agent, gdzie wrócić z wynikiem suba). Inny wymiar, inny kształt — nie łączyć.

**Świadome konsekwencje:**

- `regenerateLastResponse` (ponów odpowiedź) NIE nadaje znacznika od siebie — czyta go
  z ponawianej wiadomości (`resolveMessageOrigin(msg)`), więc powtórka ma dokładnie te same
  prawa co oryginał. Ponowienie powiadomienia o wyniku suba zostaje maszyną.
- Wiadomości odtwarzane z zapisanej sesji (`chat_session` → `rollingWindow.addMessage` +
  `render_messages`) omijają `append_message` i rejestru adresów nie zasilały ani przedtem,
  ani teraz — bez zmian.
- Komendy `/` z tekstu maszynowego przestały działać (dotąd działały, gdy tekst trafiał do pola
  wpisywania). Żadna ze ścieżek maszynowych ich nie używa.

## K3 update (2026-08-22) — popover uprawnień (tarcza) pisze na ŻYWEJ osi

`_togglePermPopover` (`chat/chat_popovers.ts`) przestał obiecywać rzeczy, których nikt nie
egzekwował (AUD-security-024 / 025):

- **Cztery wiersze — „Odczyt notatek / Modyfikacja notatek / Tworzenie plików / Usuwanie
  plików" — piszą teraz do `agent.disabled_tools`** (helpery `isPermissionSwitchOn` /
  `applyPermissionSwitch` z barrela `modules/agents`), a nie do `default_permissions`, gdzie
  `Agent._normalizePermissions` i tak je kasowało. Ta oś jest od K3 egzekwowana także przy
  WYWOŁANIU narzędzia (`ToolRegistry.checkToolAxis` w `MCPClient`), więc kropka w popoverze
  wreszcie coś znaczy.
- **Wiersz „Narzędzia MCP" WYCIĘTY** — po E3.1 konektor przypina się per serwer w profilu
  agenta (`mcp_servers[]`), jeden boolean nie miał czego włączać.
- **Wiersze „Pamięć" i „Miejsce pracy" (`guidance_mode`) zostają na `default_permissions`** —
  to jedyne dwa ŻYWE pola uprawnień. Stąd pole `axis: 'tools' | 'perm'` w `PERM_ROWS`.
- **Presety ruszają wyłącznie oś narzędzi vaultowych.** Dotąd każdy z trzech ustawiał
  `guidance_mode:false`, więc „Pełny" zawężał agenta do whitelisty folderów.
- **Zapis idzie przez `agentManager.updateAgent`** (helper `_persistAgentChange`), nie przez
  `loader.saveAgent` — inaczej zmiana uprawnień Jaskra lądowała w `jaskier.yaml`, który loader
  odrzuca, i znikała po restarcie Obsidiana.


## K5 update (2026-08-22) — PRZERWANIE JEST STANEM TURY, nie stanem widoku

Klaster K5 audytu (**AUD-security-037 / 038 / 068**): Stop nie zatrzaskiwał przerwania, a
zamknięcie panelu nie zatrzymywało tury z zakładki w tle.

**Gotcha (najważniejsze zdanie tej sekcji):** przerwanie tury trzymamy w OBIEKCIE TURY, nigdy
w polu widoku. Każda tura dostaje w `send_message` własny uchwyt `createTurnAbort()`
(`chat/turnAbort.ts` — zatrzask: raz podniesiona flaga nie gaśnie, `abort()` idempotentne),
który leży w DWÓCH miejscach naraz (ten sam obiekt, nie kopia): w `turn.abort` (czyta go pętla
i `_onStreamStall`) oraz we wpisie `_streamCtxMap` (sięga po niego `stop_generation(agentName)`
i zamknięcie widoku). Pętla dostaje `shouldAbort: () => turn.abort.isAborted()`.

- **Co było zepsute (037):** `send_message` zaczynało od `this._abortedStream = null`
  („nowa wiadomość = świeży start"). Pętla zaparkowana w długim narzędziu w chwili Stopu
  nie widziała flagi, bo gasiła ją albo następna wiadomość usera, albo AUTO-tura z wynikiem
  suba, albo drain przy przełączeniu zakładki — i wznawiała iteracje wraz z egzekucją narzędzi.
  Pola `_abortedStream` **już nie ma**; bezpiecznik „po Stopie nie drenujemy wyników subów"
  żyje osobno jako `_drainSuppressed` (podnosi go Stop/watchdog, gasi start następnej tury).
- **Guzik Stop trafiał w próżnię.** `stop_button` był wpięty przez `stop_generation.bind(this)`,
  więc jako `agentName` dostawał **MouseEvent** — mapa tur jest kluczowana nazwą agenta, więc
  Stop nie znajdował ani watchdoga, ani właściwej instancji modelu (zostawało ubicie XHR
  instancji współdzielonej). Ten sam błąd naprawiono dla guzika Wyślij w K7. Dziś:
  `() => this.stop_generation()` + pas zapasowy w funkcji (argument nie-string = aktywny agent).
- **Okno przygotowania tury też jest pod Stopem.** Uchwyt powstaje razem z zapaleniem guzika
  (`set_generating(true)`), a nie dopiero przy rejestracji wpisu w `_streamCtxMap` — między
  jednym a drugim buduje się prompt z pamięcią, co potrafi trwać sekundy. Na ten czas uchwyt
  leży w `_preparingTurns` (agentName → uchwyt) i stamtąd bierze go `stop_generation`, gdy mapa
  tur jeszcze nic o turze nie wie. Wpis znika przy rejestracji ctx.
- **`stop_all_turns(reason = 'close')`** (nowy, `chat_streaming.ts`) — zatrzymuje KAŻDĄ turę
  z `_streamCtxMap` (kopia nazw przez `collectTurnsToStop`, bo `stop_generation` kasuje wpisy
  w trakcie), kasuje `_queuedMessage` (inaczej `set_generating(false)` wystrzeliłby ją po
  100 ms w zamykany widok) i prosi `subTaskRegistry.requestStop` o zatrzymanie subów zleconych
  z zakładek TEGO widoku (`collectSubTaskIdsForOwners`: dopasowanie po `origin.tabKey`, a przy
  jego braku po `origin.agentName`; biegi bez `origin` — zlecone spoza czatu — zostają nietknięte).
  `onClose` woła to PRZED rozbrojeniem watchdogów.
- ⚠️ **AUD-security-114: „Zamknij chat" robi to samo, tylko w zakresie JEDNEJ zakładki.**
  `_closeActiveTab` woła lokalny `_stopTabWork` (`chat_tabs.ts`) PRZED `handleSaveSession` /
  `_agentStates.delete`: `stop_generation(agentName, 'close_tab')` — ale **tylko gdy ta zakładka
  ma turę w locie** (`_streamCtxMap` / `_preparingTurns`), bo Stop na cichej zakładce podniósłby
  `_drainSuppressed` i wyczyścił stan streamingu — plus `requestStop` dla jej subów po tym samym
  `collectSubTaskIdsForOwners`. Kolejność jest krytyczna: po `splice` zakładki jej `origin.tabKey`
  nie ma już do czego pasować, więc suby przeżywały nawet późniejsze `stop_all_turns`.
- **Backstop pętli pod bramką abortu (038)** — patrz `modules/agent-loop/CLAUDE.md` gotcha 9.

**Strażnicy:** `chat/turnAbort.test.ts` (8 testów — plik jest CELOWO wolny od `obsidian` i DOM-u,
wzorem `turnOwner.ts`, żeby dało się go testować w AVA) + scenariusz harnessa `44_stop_zatrzask`
+ dwa testy w `modules/agent-loop/AgentLoop.abort.test.ts`. Samych mixinów `chat_streaming.ts` /
`chat_view.ts` AVA nie zaimportuje (importują `obsidian`) — dlatego cała logika decyzyjna
przerwania siedzi w pure helperach.

## K18 update (2026-08-23) — WŁAŚCICIEL TURY zamrożony PRZED awaitami (AUD-security-112)

K4 zamroził właściciela **okna** (`RollingWindow`). K18 domyka to samo dla **tury**: do tej pory
`send_message` zapalał Stop, wchodził w `getActiveSystemPromptWithMemory` (okno „potrafi trwać
sekundy") i **dopiero potem** czytał `getActiveAgent()`, `this.rollingWindow`,
`getActiveMemory().activeSessionPath`. `_switchTab` nie jest w trakcie generowania blokowany,
więc jedno kliknięcie w drugą zakładkę w tym oknie sprawiało, że tura zaczęta u agenta A —
z promptem z JEGO pamięci — kończyła jako tura agenta B: **jego modelem, jego uprawnieniami
narzędzi, jego plikiem sesji**, a prompt A lądował w oknie B.

- **`freezeTurnOwner(view)` w `chat/turnOwner.ts`** (pure, testowalny) czyta widok RAZ,
  synchronicznie, i oddaje `FrozenTurnOwner`: `agentName`, `agent`, `rollingWindow`,
  `tokenTracker`, `memory` (po nazwie, fail-closed), `sessionPath`, `tab`, `autonomy`,
  `artifactId`. Wołany w `send_message` **obok `createTurnAbort()`**, czyli razem z zapaleniem
  guzika Stop i przed pierwszym awaitem przygotowania.
- **Od tej linii `send_message` nie pyta już widoku „kto jest teraz aktywny".** Z `owner` idą:
  prompt (`getActiveSystemPromptWithMemory(ctx, owner.agent)` — patrz `modules/agents/CLAUDE.md`),
  resolucja skilli z markerów, Oczko, snapshot „Pokaż prompt", `_streamCtxMap`, `turn.rw`/`turn.tt`,
  **model** (`get_chat_model({ agent })`), **autonomia** (`turn.autonomy`) i **adres zwrotny**
  delegacji w tle (`turn.origin` = sessionPath + tabKey właściciela).
- **`get_chat_model({ skipCache, agent })`** (`chat_model.ts`) — nowa opcja `agent`. Bez niej
  funkcja czyta `getActiveAgent()`, więc tura zaczęta u A jechałaby modelem i kluczem B.
  Przy okazji domyka **znaną granicę K4**: `buildOwnerWindowOptions.modelProvider` przy
  `minionEnabled === false` spadał na `get_chat_model()` bez agenta — dziś podaje właściciela.
- ⚠️ **`_switchTab` NIE jest blokowany i nie będzie** (user ma prawo czytać inną zakładkę, gdy
  agent pracuje). Bezpieczeństwo stoi na tym, że żywa tura trzyma WŁASNE referencje — nie na
  tym, że nikt nic nie przełączy.
- ⚠️ **Zostaje wąskie okno PRZED zamrożeniem**: między kliknięciem Wyślij a `createTurnAbort()`
  są jeszcze awaity `handleSaveSession` (tylko po 30 min ciszy), komendy `/`, `_resolveMentions`
  i `append_message`. Sama wiadomość użytkownika idzie tam przez `this.rollingWindow`, więc
  wcześniejsze zamrożenie wymagałoby przepięcia `append_message` na okno tury — świadomie poza
  zakresem K18. Dokładasz w tym odcinku nowy await? Rozważ przesunięcie zamrożenia w górę.
- **Strażnicy:** `chat/turnOwner.test.ts` — 4 testy zachowania `freezeTurnOwner` (przełączenie
  zakładki w trakcie tury nie podmienia właściciela; ścieżka sesji; fail-closed dla agenta bez
  pamięci; pusty widok) + 4 **po źródle** (zamrożenie stoi PRZED `getActiveSystemPromptWithMemory`;
  prompt budowany dla `owner.agent`; `AgentManager` ma argument; po zamrożeniu w `send_message`
  nie ma już `getActiveAgent(` / `this.rollingWindow` / `getActiveMemory` — komentarze są
  odfiltrowane, liczą się wywołania). Testy po źródle, bo `chat_streaming.ts` importuje `obsidian`
  i w AVA nie wstaje. **Harness tego nie łapie** — jego `lib/runTurn.ts` składa produkcyjne
  kawałki bez `ChatView`, więc nie ma tam czego przełączać (scenariusz `43_tlo_po_turze` pilnuje
  sąsiedniej warstwy: właściciela BIEGU SUBA, nie tury czatu).

## K19 update (2026-08-23) — kolejka wiadomości wozi proweniencję (AUD-security-117 / 131)

`_queuedMessage` był **gołym stringiem**, a oba miejsca opróżniające kolejkę nadawały mu twardo
`HUMAN_MESSAGE_META` — z komentarzem „kolejka bierze się wyłącznie z pola wpisywania". To była
nieprawda: ścieżki, które WYPEŁNIAJĄ pole wpisywania z kodu (`artifactSummon` → treść artefaktu,
propozycja delegacji w `chat_artifacts`, komentarz inline z `src/main.ts`), trafiają do tego
samego slotu, gdy akurat trwa tura. Tekst maszynowy wracał więc z przywilejami człowieka:
rejestrował adresy w whiteliście `web_read`, jego `@@skill:` wstrzykiwał pełny przepis do
promptu systemowego, a `/` uruchamiało komendę. Czyli dokładnie to, co zamknął K7.

- **`chat/queuedMessage.ts`** (pure, testowalny — bez `obsidian`): `QueuedChatMessage {text, meta}`,
  `queueChatMessage(text, meta)` (pieczątka fail-closed przez `resolveMessageOrigin`, `origin`
  doklejany JAKO OSTATNI) i `readQueuedMessage(slot)` (pusty slot → `null`; **goły string →
  MASZYNA**, żeby stary kształt nigdy nie awansował do przywilejów człowieka).
- **Dren mid-loop** (`_chatBeforeContinue`) oddaje `queued.meta` do `registerUrlsIfHuman`
  i wpisuje `origin: queued.meta.origin` na wiadomości w oknie. **Dren po turze**
  (`set_generating(false)`) woła `send_message({ meta: queued.meta })`.
- **Slot jest JEDEN i nowsza wiadomość zastępuje starszą w całości** — tak było przed K19 i tak
  zostaje. Dlatego pieczątki nie mają jak się skleić: nie ma doklejania, więc nie ma wpisu
  „maszynowy + ludzki". Gdyby kolejka miała kiedyś urosnąć do listy, regułą jest fail-closed:
  paczka z choćby jednym tekstem maszynowym jedzie jako `machine`.
- **Poprawiony nieprawdziwy komentarz** przy drenie mid-loop oraz bullet w sekcji „K7 update"
  (wyliczał kolejkę jako trzecią ścieżkę „human").
- **Strażnicy:** `chat/queuedMessage.test.ts` — 9 testów logiki (pieczątki, fail-closed, goły
  string, skutek dla `registerUrlsIfHuman`) + 3 po źródle: w `chat_streaming.ts` **nie ma już
  `HUMAN_MESSAGE_META` w kodzie** (komentarze odfiltrowane), oba dreny używają `queued.meta`,
  a do slotu wchodzi się wyłącznie przez `queueChatMessage`. W `messagePrivileges.test.ts`
  asercja o `HUMAN_MESSAGE_META` w `chat_streaming.ts` **usunięta** (utrwalała starą wadę);
  para z `chat_ui.ts` (Wyślij + Enter) zostaje.

## K20b update (2026-08-23) — okno rozmowy pokazuje zamaskowany tekst błędu (AUD-security-132, zlew)

`handle_error` wstawiał `error.message` **wprost do DOM-u** czatu i podawał surowy obiekt błędu
do `log.error` (a Logger pisze też do pliku w vaultcie). Na ścieżce sieciowego padu strumienia
ta wiadomość bywa `JSON.stringify` całego zdarzenia streamera — razem z
`source.headers.Authorization`, czyli **surowym kluczem API**. Wystarczy zrzut ekranu albo
wklejenie „błędu" do zgłoszenia, żeby klucz wyszedł z maszyny.

- **`chat/safeErrorText.ts`** (pure): `safeErrorText(error, {limit})` = **normalizacja →
  `maskSensitiveData` (z `core/index.js`) → sufit `CHAT_ERROR_TEXT_LIMIT` (800 znaków, dalej `…`)**.
  Normalizacja radzi sobie z `Error`, stringiem, obiektem bez `message` (`JSON.stringify`)
  i cyklicznym obiektem (nie rzuca). Brak treści → pusty string, fallback daje wołający
  (`|| 'Unknown error occurred'`, jak dotąd).
- **Trzy zlewy w `chat_streaming.ts`**: dymek błędu (obie gałęzie — z kontenerem i bez),
  `log.error('Chat', 'Chat error:', …)` w `handle_error` oraz `log.error` w `catch`
  `send_message`. ⚠️ Do logu idzie dziś **tekst, nie obiekt** — konsola nie rozwinie już stacka
  z tego wywołania; to świadoma cena maskowania (stack i tak zawierał tę samą wiadomość).
- ⚠️ **To jest ZLEW, nie źródło.** Adapter / normalizacja błędu / maska po stronie modelu to
  osobna naprawa (`modules/models`, inny agent). Obrona w głąb: nawet gdy źródło znów wpuści
  nagłówek, okno pokaże `Bear***3f8a`.
- ⚠️ **Nie objęte K20b:** `Błąd: ${error.message}` w blokach narzędzi i sub-agentów
  (`_chatOnToolResults`) — inny zlew, inna warstwa (błędy narzędzi/MCP). Kandydat na osobne
  zadanie, jeśli audyt to podniesie.
- **Strażnicy:** `chat/safeErrorText.test.ts` — 9 testów maski i normalizacji (Authorization,
  `api_key`, goły klucz, obiekt bez `message`, cykl, sufit) + 2 po źródle (`handle_error` nie ma
  już `error.message`; oba `log.error('Chat', …)` idą przez `safeErrorText`).

## Klaster I update (2026-08-24) — STOP I ZMIANA ZAKŁADKI mają pierwszeństwo przed „domknij turę"

Pięć znalezisk (AUD-bledy-055 / 015 / 016 / 018, AUD-security-115 / 116) o jednym mianowniku:
mechanizmy domykające turę „po fakcie" — dren kolejki na `setTimeout`, dostawca wyniku suba,
kasowanie wpisu mapy tur, wskaźniki malowania — nie pytały, czy user w międzyczasie nie kliknął
Stopu i czy nadal patrzy na TĘ zakładkę.

**Gotcha (najważniejsze zdanie tej sekcji):** wszystko, co odpala się PO zakończeniu tury —
z timera, z powiadomienia, z `finally` — musi przed działaniem sprawdzić DWIE rzeczy: czy nie
było Stopu (`_drainSuppressed`) i czy adresat to nadal ta sama zakładka/tura (`queuedOwnerMatches`,
`turnId`). Sam fakt, że coś zostało zaplanowane, nie jest zgodą na wykonanie.

- **Kolejka wiadomości ma WŁAŚCICIELA i uchwyt timera** (AUD-bledy-055 / 015). `_queuedMessage`
  wozi teraz `{text, meta, owner}` (`owner` = `{agentName, tabKey}` z chwili kolejkowania,
  `tabKey` liczy `chat_tabs._tabKey` — to samo źródło prawdy, co adres zwrotny suba). Dren
  w `set_generating(false)`:
  - trzyma uchwyt `this._queuedDrainTimer` (dawniej goły `setTimeout`, którego nikt nie umiał
    anulować — `stop_all_turns` czyścił SLOT, ale nie timer, więc tura kończąca się do 100 ms
    przed zamknięciem panelu budziła się w zamkniętym widoku i odpalała pełną turę: model,
    narzędzia, zapis do pliku sesji);
  - **opróżnia slot dopiero w callbacku**, po bramkach — dzięki temu anulowanie timera nigdy
    nie gubi wiadomości;
  - pyta `queuedOwnerMatches(queued, this._queueOwner())`. `set_generating(false)` woła też
    `_switchTab` (krok 5) przy KAŻDYM przejściu na niegenerującą zakładkę, więc wybudzony timer
    wklejał tekst pisany do Jaskra w pole Borysa i startował turę JEGO modelem, promptem,
    pamięcią i `disabled_tools` (`freezeTurnOwner` zamrażał już cudzego właściciela). Przy
    rozjeździe wiadomość ZOSTAJE w slocie, wraca wskaźnik ⏳ i czeka na swoją zakładkę.
  - `_switchTab` rozbraja timer na wejściu (krok 0), `stop_all_turns` przed kasowaniem slotu.
- **Stop anuluje zakolejkowaną wiadomość** (AUD-bledy-055). `stop_generation` kasuje slot, gasi
  wskaźnik i rozbraja timer. Do tej zmiany gałąź `if (queued)` w `set_generating(false)` była
  jedyną, która NIE pytała o `_drainSuppressed` (sąsiednia gałąź drenu subów pytała): 100 ms po
  kliknięciu Stop leciała pełna tura, a przy autonomii `yolo` razem z zapisami i delegacjami,
  na które user nie miał jak się zgodzić — bo w jego przekonaniu przerwał WSZYSTKO. Tekst nie
  ginie: jeśli pole wpisywania jest puste, wraca do niego (duch Z3 — szkic usera nie znika).
- **Bramka „po Stopie nie startujemy tury sami" przeniesiona do `_deliverSubTaskResult`**
  (AUD-security-115). `_drainSuppressed` miał JEDEN odczyt — w `set_generating` — a to nie jest
  wąskie gardło dostarczania: `SubTaskNotifier._onFinished` woła dostawcę WPROST na
  `task:finished` (sub kończy bieg pół minuty po Stopie), a `_switchTab` drenuje w kroku 11.
  Czat startował wtedy auto-turę z raportem suba. Dziś bramka stoi obok trzech istniejących
  pytań dostawcy (zakładka / aktywność / trwająca tura) — czwarta w kolejności. Wynik NIE ginie —
  `false` zostawia go w kolejce notifiera (kontrakt `SubTaskNotifier`, pokryty jego testem),
  a odbierze go najbliższy `drain()` po następnej turze usera. Odczyt w `set_generating` zostaje
  jako obrona w głąb. **Werdykt Kuby 16.08 dołożył PIĄTE pytanie** — sufit łańcucha auto-tur po
  subach z rzędu (`max_consecutive_auto_turns`, `config/limits.ts`) — patrz punkt „Auto-tura
  tylko na AKTYWNEJ i bezczynnej zakładce, pod sufitem łańcucha" wyżej.
- **Wpis `_streamCtxMap` zwalnia tylko właściciel** (AUD-security-116). Mapa jest kluczowana
  NAZWĄ agenta, a pod jedną nazwą potrafią żyć dwie tury (zakładka dodana ponownie z pickera,
  wyścig z przygotowaniem promptu). Bezwarunkowy `delete` przy finalizacji STAREJ tury wyrzucał
  uchwyt przerwania ŻYWEJ: od tej chwili Stop robił sam UI-cleanup i `set_generating(false)`,
  ale `abort()` nie leciało wcale — pętla dalej wołała model, wykonywała narzędzia i finalizowała
  turę do pliku sesji. Guzik wyglądał na skuteczny i nie był. Dziś jedno wspólne
  **`_releaseStreamCtx(agentName, turnId)`** porównuje tożsamość przed `delete` (wzór watchdoga
  z `_onStreamStall`); `handle_error` dostał opcjonalny trzeci argument `turnId`.
  ⚠️ Świadomie NIE zrobione: „Stop bez argumentu zatrzaskuje WSZYSTKIE żywe tury zakładki" —
  wymaga kolekcji tur per `turnId` zamiast mapy per nazwa. Fix domyka utratę uchwytu, nie
  wielokrotność wpisów.
- **`_resetPaintTargets()` — jedno miejsce prawdy o wskaźnikach malowania** (AUD-bledy-016).
  `handle_error` kończył bez zerowania `current_message_container`/`bubble`/`text`/
  `_lastPaintedContent`, a `handle_chunk` maluje do ISTNIEJĄCEGO kontenera: następna odpowiedź
  szła do dymka poprzedniej wiadomości — fizycznie NAD nowym pytaniem, bez nagłówka agenta,
  z chipami narzędzi w starym wrapperze; a po przerysowaniu listy do węzła wypiętego z drzewa
  (`_finalizeTurn` pomijał wtedy dorysowanie, bo `content === _lastPaintedContent` — user widział
  pytanie i pustkę). Helper wołają dziś `handle_error`, `_finalizeTurn`, `stop_generation`
  i `_chatBeforeContinue`.
  ⚠️ **Wyłącznie na ścieżce AKTYWNEJ zakładki.** Pola są per-WIDOK, nie per-zakładka, więc
  zerowanie z tury kończącej się w tle wyrwałoby dymek żywej turze na wierzchu. Kierunek
  znaleziska („bezwarunkowo na obu gałęziach `_finalizeTurn`") jest w tym punkcie NIEBEZPIECZNY
  i nie został wykonany — wariant B (tura kończąca się w tle) należy do `render_messages`,
  bo to ona wypina węzły; osobne zadanie.
- **Zero pustych `catch {}`** (AUD-bledy-018). Odczyt propozycji `agent_delegate` — jedyne
  wejście do `_renderDelegationButton` — łykał wyjątek bez śladu. Dziś `log.warn` przez
  `safeErrorText` (w wyniku narzędzia potrafi siedzieć cudza treść).

**Strażnicy:** `chat/stopSemantics.test.ts` (11 testów PO ŹRÓDLE — `chat_streaming.ts` ciągnie
`obsidian` i w AVA nie wstaje) + 6 testów logiki właściciela w `chat/queuedMessage.test.ts`.
Po stronie pętli: 5 testów w `modules/agent-loop/AgentLoop.abort.test.ts` (Stop w trakcie
finalnego strzału backstopu, `beforeContinue` pominięty po Stopie, `loop.end stop=error`,
hardstop poza transkryptem) — patrz `modules/agent-loop/CLAUDE.md`, gotchy 10 i 11.

## F04 update (2026-08-30) — fabryka napraw code-review: tożsamość zakładki, stan per tura, wizja właściciela

Klaster F04 audytu code-review (2026-08-30) — sześć znalezisk o tym samym wzorcu: stan tury/okna
żyje w OBIEKCIE TURY albo jest adresowany przez tożsamość ZAKŁADKI (`_tabKey`), nigdy przez pole
widoku ani przez samą nazwę agenta.

- **AUD-code-review-012 (HIGH): `_agentStates` kluczowana WYŁĄCZNIE `_tabKey(tab)`.** Trzy miejsca
  w `chat_streaming.ts` (`_finalizeTurn`, `handle_error`, `_onStreamStall`, gałęzie „tura w tle")
  czytały `this._agentStates.get(streamAgentName)` — kluczem-NAZWĄ agenta. Dla zakładki
  odtworzonej z dysku (`_restoreActiveSession`) `_tabKey` daje ścieżkę sesji, nie nazwę agenta
  (`_switchTab` konsekwentnie pisze/czyta przez `_tabKey`), więc `isGenerating` zostawało `true`
  na zawsze — zakładka wisiała na „generuję", nowe wiadomości szły do kolejki i nigdy nie
  startowały.
  ⚠️ **Druga runda (2026-08-30, po blokadzie mergem pierwszej wersji tej naprawy):** pierwsza
  wersja czytała `_tabKey(turn.owner?.tab)` na miejscu sprzątania (finalize/error/watchdog) —
  czyli PRZELICZAŁA klucz z ŻYWEGO pola `tab.sessionPath` GODZINY (albo choćby sekundy) po
  starcie tury. `/save session` → „Archiwizuj i nowa sesja" (`archive_new`,
  `slash-commands/save_session.ts`) podmienia `activeTab.sessionPath` NA MIEJSCU, bez
  re-keyowania `_agentStates` — więc przeliczony klucz czytał JUŻ nową wartość i chybiał wpis
  zapisany pod starą. Dziś klucz jest liczony RAZ: `const ownerTabKey = _tabKey(owner.tab)`
  zaraz po `freezeTurnOwner`, PRZED pierwszym awaitem `send_message`. Wożony dalej jako
  `turn.origin.tabKey` (dla `_finalizeTurn`/`_onStreamStall`, które mają dostęp do `turn`) i jako
  goły string do `handle_error` (nie ma dostępu do `turn` — sygnatura zmieniona z `ownerTab`
  obiektu na `ownerTabKey: string`). **Ten sam wzorzec dotyczył `chat_session.ts`
  (`_restoreActiveSession`)** — czwarty writer `_agentStates` liczył klucz ręczną kopią
  (`item.session.path`) zamiast importować `_tabKey` z `chat_tabs.js`; działało przypadkiem
  (te same wartości przy budowie `chatTabs`), ale to czwarta kopia formuły, przed którą ostrzega
  JSDoc `_tabKey`. Naprawiono razem. Strażnik PO ŹRÓDLE: `chat/ownerScopedState.test.ts` — w tym
  test file-wide (`_agentStates.get(...)` w CAŁYM pliku, allowlist na dwa dozwolone kształty
  klucza, nie punktowe `notRegex`).
- **AUD-code-review-013 (MEDIUM): callbacki okna malują TYLKO gdy zakładka właściciela jest na
  wierzchu.** K4 mówi że kompresja end-of-turn LECI bezwarunkowo także dla zakładki w tle — to
  zasada o DANYCH (transkrypt, plik sesji), nie o DOM-ie. `messages_container` jest JEDEN na cały
  widok, więc `onSummarized`/`onToolsTrimmed` (`chat_session._createRollingWindow`) i
  `onMemoryCandidates` (`turnOwner.buildOwnerWindowOptions`) malowały blok „skompresowano" / notę
  ratunku pamięci agenta A fizycznie w rozmowie agenta B, którą user akurat czyta (z licznikami
  policzonymi z okna A) — bloki nie należą do modelu okna B, więc znikały przy najbliższym
  `render_messages()`, czysty artefakt cudzej tury. Nowy eksport **`turnOwner.isOwnerTabActive(view,
  ownerName)`** (fail-open gdy widok nie zna modelu zakładek — atrapy bez `chatTabs`) bramkuje
  wszystkie trzy callbacki. Dotyczy OBU ścieżek kompresji (mid-loop i end-of-turn), bo callback
  jest jeden, rejestrowany raz przy zakładaniu okna. Strażnicy: `turnOwner.test.ts` (pure) +
  strażnik po źródle w tym samym pliku (blok `onSummarized`/`onToolsTrimmed` w `chat_session.ts`).
  ⚠️ **Sprostowanie (2026-08-30, F04 druga runda):** `isOwnerTabActive` rozstrzyga po NAZWIE
  AGENTA (`tab.agentName === ownerName`), nie po tożsamości zakładki (`_tabKey`). 013 jest więc
  domknięte **per-agent**, nie per-zakładka: gdyby kiedyś powstała możliwość otwarcia DWÓCH
  zakładek TEGO SAMEGO agenta naraz, callbacki okna nadal malowałyby sobie nawzajem bloki
  „skompresowano" między nimi — bramka widzi je jako jedną i tę samą „aktywną zakładkę
  właściciela". Podobnie **`_isTurnActiveTab`** (`chat_streaming.ts`, decyduje która gałąź
  tło/aktywna leci w `_finalizeTurn`/`_onStreamStall`) wybiera po nazwie agenta, nie po
  `_tabKey`/`turnId` — to samo, znane ograniczenie co AUD-security-116 (**poza zakresem tego
  klastra**, nietknięte).
- **AUD-code-review-014 (MEDIUM): estymata wejścia (`_lastInputTokens`/`_lastInputChars`) żyje w
  `turn`, nie na widoku.** Ostatni wyjątek od kontraktu E2.1 („per-response stash w zamknięciu
  `turn`") — przy dwóch turach naraz w jednym `ChatView` (`needsFreshModel`) tura A czytała
  estymatę nadpisaną przez turę B, psując zarówno TokenTracker agenta A, jak i globalną
  kalibrację chars→token (`calibrate`). Dziś `turn.lastInputTokens`/`turn.lastInputChars`, obok
  `lastApiInput`/`lastApiOutput` w tym samym obiekcie. Strażnik po źródle pilnuje, że
  `this._lastInputTokens`/`Chars` nie wróciły nigdzie w pliku.
- **AUD-code-review-073 (MEDIUM): decyzja o wizji dla WŁAŚCICIELA tury, nie globalnie aktywnego.**
  `_isCurrentModelVision()` w `chat_model.ts` wołało `get_chat_model()` bez `agent` → spadało na
  `getActiveAgent()`. `_chatExecuteToolCall` używa tego do wyboru kształtu wyniku `generate_image`
  (tablica multimodalna z `image_url` dla modelu wizyjnego vs JSON bez base64) — przy przełączeniu
  zakładki w trakcie tury w tle decyzja szła dla CUDZEGO modelu. `_isCurrentModelVision(agent?)`
  ma teraz opcjonalny parametr; `_chatExecuteToolCall` podaje `turn.agent`. Dwa wywołania czysto
  UI-owe (ostrzeżenie przed wysyłką, `chat_streaming.ts:193`/`:333`, jeszcze przed zamrożeniem
  właściciela) zostają bez argumentu celowo — tam „aktywny agent" jest właściwym pytaniem.
- **AUD-code-review-052 (LOW): mid-loop compression ustawia `rw.sessionPath` jak end-of-turn.**
  `RollingWindow.sessionPath` (czytane przez `Summarizer` do stopki „📂 Pełna rozmowa zapisana
  w: …") miało w całym module JEDEN writer — `_finalizeTurn` (end-of-turn). Gałąź „Opcja 4:
  Mid-loop compression" w `_chatBeforeContinue` woła TEN SAM próg (`getCompressionNeeded()`), ale
  nie ustawiała ścieżki — pierwsze przekroczenie progu 90% wypadające W ŚRODKU pętli (przed
  jakąkolwiek kompresją end-of-turn w tym oknie) traciło podpowiedź `{{SESSION_PATH}}` (dokumentnie
  dopuszczalny pusty stan, `config/default_prompts.ts`, więc nie wybucha — tylko uboższy prompt).
  Dziś mid-loop też czyta `activeSessionPath` właściciela tury przed `performTwoPhaseCompression`
  (zdarzenia tury są już dopisane na bieżąco przez `appendToActiveSession`, więc nie trzeba
  dodatkowego `handleSaveSession`).
- **AUD-code-review-071 (HIGH→MEDIUM po korekcie obalacza, potem ZABLOKOWANE mergem — druga
  naprawa 2026-08-30): trim liczy REALNY rozmiar treści, wycena tokenów liczy obraz z SUFITEM.**
  Wynik `generate_image` + model wizyjny to `[{type:'text'},{type:'image_url'}]` — dwa bloki.
  `trimOldToolResults`/`_trimToolResultsAggressive` pytały `msg.content.length` wprost, co dla
  tablicy to LICZBA BLOKÓW (zawsze 2), więc taka wiadomość NIGDY nie przekraczała progu 200/50
  znaków i była strukturalnie nietrimowalna — wielomegabajtowy base64 zostawał w oknie na zawsze.
  Naprawa tej części (**`_contentSize(content)`**, string → `.length`, tablica → suma długości
  tekstu + długość `image_url.url`) jest OK i ZOSTAJE bez zmian.
  ⚠️ **Pierwsza wersja `getCurrentTokenCount`/`_contentToTokenText` (ta sama naprawa, ten sam
  commit) zastąpiła stały placeholder `'[image:85tokens]'` REALNĄ długością `image_url.url` w
  tym samym stringu, który potem liczy `getTokenCount` (znaki/token) — czyli poszła w drugą
  skrajność.** Na `maxTokens` produkcyjnym (100 000, nie testowym `1_000_000`, którego użyły
  testy v1 — maskując dokładnie ten próg) obraz 1,5 MB base64 dawał ~450 000 „tokenów": hard
  limit w `addMessage()` wybuchał w JEDNYM wywołaniu, `_trimToolResultsAggressive` nie zdążała
  (recentKeep dla tylu wiadomości), `performSummarization(true)` strzelała sztucznym wywołaniem
  LLM (bez skonfigurowanego summarizera zwracała `null`), a `_trimOldestMessages()` kasowała
  CAŁĄ grupę user→assistant(tool_calls)→tool — obraz i cała rozmowa znikały, ZANIM model je
  zobaczył. Recenzent zmierzył to na produkcyjnym `maxTokens` i zablokował merge. Naprawa v2:
  **`estimateImageTokens(url)`** (góra `RollingWindow.ts`) liczy obraz z SUFITEM
  `Math.min(Math.ceil(url.length/4/1.2), 1600)` — realny koszt wizji u providerów to
  ~85-1600 tokenów/obraz, nie proporcja do długości base64. `_contentToTokenText` NIE wkłada już
  base64 obrazu do wspólnego stringa (tylko tekst); nowy `_contentImageTokens(content)` liczy
  sumę sufitów per obraz i jest dodawana OSOBNO w `getCurrentTokenCount`/`_countMessageTokens`
  (`getTokenCount(tekst) + imageTokens`, nie jeden wspólny string). Strażnicy:
  `RollingWindow.test.ts` — test na `.length===2` pułapkę (bez zmian) + test na SUFIT (obraz 1,5 MB
  dodaje >0 ale ≤1600 tokenów) + dwa testy regresji z `maxTokens: 100_000` (wynik narzędzia
  z obrazem 1,5 MB ORAZ załącznik usera/Oczko w trwającej rozmowie — oba: transkrypt i obraz
  ZOSTAJĄ w oknie, zero wejścia w hard limit, `_summarizationCount`/`_toolTrimCount` = 0).
- **AUD-code-review-016 (LOW→MEDIUM po korekcie obalacza): `chat_popovers.ts` woła kanoniczny
  `_tabKey`.** `_applyAutonomyChange` liczyło klucz zakładki własną kopią formuły
  (`sessionId || sessionPath || sessionName || agentName`) zamiast importować eksportowany
  `_tabKey` z `chat_tabs.js` — dokładnie druga kopia, przed którą ostrzega JSDoc `_tabKey`
  („druga kopia tej logiki = wynik suba trafiałby do złej zakładki"). Dziś import + wywołanie.

**Strażnicy F04:** `chat/ownerScopedState.test.ts` (012/014/073/052/016, PO ŹRÓDLE — `chat_streaming.ts`,
`chat_popovers.ts` i `chat_session.ts` ciągną `obsidian`; od drugiej rundy 2026-08-30 dołożony
strażnik file-wide na WSZYSTKIE `_agentStates.get(...)` w `chat_streaming.ts` oraz strażnik na
writer `_agentStates.set(...)` w `chat_session.ts`) + `chat/turnOwner.test.ts` (013, `isOwnerTabActive`
+ gating `onMemoryCandidates` + strażnik po źródle na blok `_createRollingWindow`) + `chat/RollingWindow.test.ts`
(071, testy bezpośrednie — `RollingWindow.ts` jest `obsidian`-free — w tym dwa testy regresji hard-limit
z `maxTokens` produkcyjnym, dodane w drugiej rundzie po blokadzie mergem).

## Klaster C1 update (2026-09-02) — decyzje czatu przestają być pilnowane NAPISEM

Fabryka napraw po audycie testów (AUD-testy-024/025/026/027/045/046). Wspólny mianownik:
sześć rzeczy w `modules/chat/chat/` pilnował wyłącznie regex po TEKŚCIE źródła, bo
`chat_streaming.ts` i `chat_model.ts` ciągną `obsidian` i AVA ich nie zaimportuje. Taki strażnik
nie odróżnia `if (x) return false;` od `if (x) { }` — mutacja kasująca SKUTEK przy zachowaniu
NAPISU zostawiała pakiet zielony (dowód audytu: 259/259 pass po zneutralizowaniu trzech bramek).

**Gotcha (najważniejsze zdanie tej sekcji):** w tym module decyzja NIGDY nie zostaje w mixinie
wiszącym na `obsidian`. Idzie do czystego pliku obok jako funkcja `→ {allowed|action, reason}`
z testami OBU stron każdej gałęzi, a mixin jest cienkim wołaczem. Strażnik po źródle zostaje
wyłącznie na OKABLOWANIE i pilnuje KSZTAŁTU użycia (`if (!x.allowed)` z bangiem, `return false`
w gałęzi), nie samej obecności identyfikatora.

- **AUD-testy-024 — trzy decyzje z napisu do czystych funkcji.**
  - **`chat/subTaskDelivery.ts` (NOWY): `evaluateSubTaskDelivery`** — KOMPLET bramek dostarczenia
    wyniku suba w kolejności zakładka → aktywność → trwająca tura → Stop (AUD-security-115) →
    sufit łańcucha; zwraca `{allowed, reason}`, a `reason` decyduje, czy user zobaczy `Notice`
    (`chain_limit`) czy odmowa jest cicha. Bramka „zadanie bez `id`" ZOSTAJE w monolicie — chroni
    samo wyliczenie `origin`/`matchTabForOrigin` przed wywrotką, więc jej przesunięcie zmieniłoby
    kolejność efektów (log w `catch`).
  - **`chat/queuedMessage.ts`: `evaluateQueuedDrain` + `evaluateStopQueueCancel`** — trzy pytania
    timera drenu (`empty` / `wait_owner` / `wait_generating` / `send`) i decyzja Stopu o slocie
    (kasować? oddać tekst do pola?). Efekty uboczne (wskaźnik ⏳, log, podmiana pola) zostają
    u wołacza.
  - ⚠️ **Ekstrakcja zachowała kolejność co do bita.** `getLimits(this.env?.settings)` liczy się
    dalej RAZ na doręczenie, a `evaluateAutoTurnChain` przesunęło się PRZED bramki — wolno,
    bo obie są czyste; za to odczyt licznika idzie przez `this._autoTurnChainCounts?.get(...)`,
    więc mapa powstaje dopiero przy ZAPISIE, czyli tylko na ścieżce startującej auto-turę.
- **AUD-testy-025 — `chat/vaultReadGate.ts` (NOWY): bramka K23 `vault.read`.**
  `evaluateVaultRead` + `createVaultReadPredicate`; `chat_model.ts` podaje jej tylko trzy rzeczy
  z pluginu (system uprawnień, `resolveAgent`, `onError`). ⚠️ Przekazujemy CAŁY
  `permissionSystem`, nie samą metodę — `checkPermission` jest wołane NA NIM (`this`). Agenta
  rozwiązujemy dopiero PO sprawdzeniu, że bramka w ogóle stoi (kolejność jak w dawnym predykacie).
  Testy: ścieżka dozwolona przechodzi, No-Go odmowa, spoza whitelisty agenta odmowa, brak
  systemu = fail-closed, werdykt bez `allowed === true` = odmowa, rzut bramki = odmowa + log.
- **AUD-testy-026 — zatrzask Stopu ma wreszcie strażnika okablowania.**
  `shouldAbort: () => turnAbort.isAborted()` to JEDYNY przewód, którym Stop wchodzi z czatu do
  `runAgentLoop`, i nie miał żadnej asercji (harness podaje własny `shouldAbort` — nie stawia
  `ChatView`). Strażnik w `chat/chat_streaming.limits.test.ts` pilnuje kształtu wywołania oraz
  tego, że ten sam uchwyt leży w `_preparingTurns` i we wpisie `_streamCtxMap`.
- **AUD-testy-027 — `StreamingManager.test.ts` (NOWY) + `shouldUseFreshModel`.**
  Plik nie ma ANI JEDNEGO importu, a nie był importowany przez żaden test; decyzja „świeża
  instancja modelu czy z cache" mieszka teraz obok stanu, na którym stoi (oba człony pokryte).
- **AUD-testy-045/046 — regexy strażników.** `\b` przed nazwą narzędzia w
  `chat_streaming.limits.test.ts` (bez niej wzorzec `delegate:` łapał się WEWNĄTRZ
  `agent_delegate:`, więc kasacja jednej z dwóch pilnowanych linii nie dawała czerwieni),
  a w `autoTurnChain.test.ts` doszła asercja na KIERUNEK bramki (`chainAllowed: chain.allowed`
  bez negacji + `if (!delivery.allowed)` z negacją).

**Strażnicy C1:** `chat/subTaskDelivery.test.ts` (12), `chat/vaultReadGate.test.ts` (11),
`chat/StreamingManager.test.ts` (15), rozszerzone `chat/queuedMessage.test.ts` (+10 decyzji drenu
i Stopu) oraz przepięte na kształt okablowania `chat/stopSemantics.test.ts`,
`chat/autoTurnChain.test.ts`, `chat/oczkoAccessGate.test.ts`, `chat/chat_streaming.limits.test.ts`.
Każda nowa asercja ma dowód mutacyjny (celowy błąd → czerwony → cofnięty → zielony) spisany
w commitach `fix(testy-f6): …`.

## AUD-dead-code-205 update (2026-09-02) — popover narzędzi pyta rejestr, nie mapę ikon historii

**Bug (fabryka napraw, klaster B4 popover-tools).** `_toggleToolsPopover` (`chat/chat_popovers.ts`)
budował listę narzędzi z `Object.keys(TOOL_INFO)` — mapy ikon/etykiet z `modules/ui-components/
ToolCallDisplay.ts`, trzymanej DLA RENDERU STAREJ HISTORII (celowo ma martwe wpisy: `skill_list`,
`skill_execute` — serwer `skills` skasowany E2.4 D17; `connect_to_server` — sandbox custom-JS
wyburzony E3.1 fazą C; `minion_task`/`master_task`/`agent_message` — relikty ról minion/master i
starej poczty, S28). Filtr był tylko jeden: `disabled_tools`. Efekt: user klikający ikonę narzędzi
widział 6 nazw, których `ToolRegistry` w ogóle nie zna (klik wklejał nazwę do pola — model dostawał
podpowiedź na narzędzie-widmo), a 6 REALNIE zarejestrowanych (`todo`, `artifact_create/read/
update/list`, `add_text_to_image`) nigdy się nie pokazywało, bo nie mają wpisu w TOOL_INFO.
Wzór poprawny już istniał w repo: `modules/tools/ConnectorsBackstageTab.ts` bierze listę wprost
z `ToolRegistry` z komentarzem wprost „nie z TOOL_INFO, gdzie świadomie leżą martwe wpisy".

**Naprawa — rozdzielenie dwóch ról tej samej mapy.** `TOOL_INFO` ZOSTAJE jak było (katalog ikon/
etykiet, martwe wpisy nietknięte — potrzebne, bo stare transkrypty i tak muszą wyrenderować nazwę
narzędzia, którego już nie ma). Nowe źródło LISTY to `ToolRegistry.getAllToolNames()` (żywy rejestr,
kolejność rejestracji) — logika składania popovera wyniesiona do czystej funkcji
**`chat/toolPopoverEntries.ts`: `buildToolPopoverEntries(registryNames, disabledTools, toolInfo)`**
(bez importu `obsidian`, więc AVA ją testuje wprost, w przeciwieństwie do reszty tego pliku —
`chat_popovers.ts` importuje `Notice`). Reguła: rejestr minus `disabled_tools` (Set, jak dotąd),
w kolejności rejestru; nazwa z TOOL_INFO nieobecna w rejestrze NIGDY nie trafia do wyniku (martwe
wpisy przestają wyciekać); nazwa z rejestru nieobecna w TOOL_INFO (nowe narzędzie bez wpisu w
katalogu, albo narzędzie zewnętrznego serwera MCP) dostaje wpis z fallbackiem — etykieta = surowa
nazwa, `icon: undefined` → `_toggleToolsPopover` maluje wtedy `UiIcons.tool(14)` (ta sama ikona co
na samym guziku „narzędzia" w pasku inputu).

**Dowód czerwony/zielony (opisany też w raporcie sesji).** `toolPopoverEntries.test.ts` (6 testów)
uruchomiony na TYMCZASOWEJ implementacji odtwarzającej stare zachowanie (`Object.keys(toolInfo)`
jako źródło) dał 5/6 czerwonych — martwy `minion_task` wyciekał, żywy `todo` znikał. Po przywróceniu
docelowej implementacji (źródło = `registryNames`) — 6/6 zielone.

**Zlecenie poza zakresem (znalezisko AUD-dead-code-118, nie ruszane w tym klastrze):** 6 kluczy
i18n `tool.*` w `core/i18n/pl.ts`/`en.ts` (`skill_list`, `skill_execute`, `connect_to_server`,
`minion_task`, `master_task`, `agent_message`) opisuje te same martwe narzędzia — potwierdzone tym
samym audytem, ale to osobna decyzja Kuby (zostawić jako etykiety historii / skasować), nie kod tego
klastra. Osobno: `add_text_to_image` ma `tools.label.add_text_to_image`, ale wciąż BRAK
`tool.add_text_to_image` — asymetria nie naprawiona (poza zakresem B4).

## AUD-dead-code-255 (2026-09-02) — `OpenSessionModal` dostał brakującą rodzinę CSS

`OpenSessionModal.js` (bliźniak `SessionCloseModal.js`, otwiera starą sesję — continue/compress/
fresh) malował 8 z 9 klas `cs-open-session*` (`-modal`, `__header`, `__title`, `__info`,
`__actions`, `__btn`, `__btn--primary`, `__btn--cancel`) bez ani jednej reguły CSS w żadnym z
sześciu arkuszy repo — jedyna stylowana klasa była `__cancel-row` (dzielona z `SessionCloseModal`
w `src/styles.css:778-780`). Skutek: przyciski modala spadały na domyślny wygląd Obsidiana,
podczas gdy strukturalnie identyczny bliźniak (`chat_view.css:2566-2629`) ma pełną rodzinę
reguł + warianty primary/cancel + stany `:hover`.

Naprawa: `chat_view.css` dostał rodzinę `.cs-open-session__*` LUSTRZANĄ do `.cs-session-close__*`
— **wspólne selektory** (`.cs-session-close__x, .cs-open-session__x { ... }`) zamiast duplikatu,
więc wygląd obu modali sesji zostaje sprzężony na przyszłość (zmiana jednego stylu zmienia oba,
zamiast po cichu się rozjechać jak dotąd). `src/styles.css` NIETKNIĘTY (poza zakresem — modał
nie jest jego modułem).

Strażnik: `modules/chat/OpenSessionModal.css_coverage.test.ts` — wyciąga wszystkie malowane klasy
`cs-open-session*` regexem ze źródła (`OpenSessionModal.ts` importuje `obsidian`, więc AVA go nie
zaimportuje) i sprawdza, że każda ma regułę w `chat_view.css` LUB `src/styles.css`. Czerwony przed
naprawą (9 asercji nie przechodziło), zielony po.

## Fabryka napraw W13 (2026-09-02, follow-up po review W4) — `/save_session` akcja `archive` czyściła połowicznie

`applyPostArchiveAction` (`slash-commands/save_session.ts`) obsługiwało jawnie tylko `archive_new`
(nowa sesja od razu) i `archive_close` (zamknij zakładkę) — plain `archive` (bez sufiksu, TAKŻE
`result.action` domyślny) nie robiło NIC z zakładką, mimo że `SaveSessionWorkflow.applyDecision`
(`modules/memory`) już zarchiwizowało plik i wyzerowało `AgentMemory.activeSessionPath`
(`archiveActiveSession`, dla KAŻDEJ akcji). `activeTab.sessionPath` zostawało wskazywać na TEN
SAM, teraz zarchiwizowany plik. `chat_tabs._switchTab` czyta `targetTab.sessionPath` i przy
KAŻDYM powrocie na tę zakładkę wpisywało tę wiszącą ścieżkę z powrotem do
`memory.activeSessionPath` — sesja „zmartwychwstawała" jako wskaźnik na plik w
`sessions/archive/`, którego już nie ma pod aktywną ścieżką.

Naprawa: gałąź plain `archive` czyści teraz WSZYSTKIE cztery pola tożsamości sesji zakładki
(`sessionPath`/`sessionId`/`sessionName`/`sessionLabel`) — analogicznie do `archive_new`, ale BEZ
wpisywania nowej wartości (nowa sesja powstaje leniwie, przy pierwszym kolejnym zdarzeniu, tak
jak dla świeżej zakładki w `chat_tabs._initTabs`). Tożsamość zakładki (`chat_tabs._tabKey`, który
sprawdza `sessionId || sessionPath || sessionName || agentName`) spada z powrotem na `agentName`.
Przy okazji dołożony explicit `return` w gałęzi `archive_close` — bez niego egzekucja spadała w
sprzątanie plain `archive` i próbowała je wykonać na już USUNIĘTEJ (`splice`) zakładce.

Strażnik: `slash-commands/save_session.archiveTabCleanup.test.ts` — po źródle
(`save_session.ts` importuje `obsidian`), z dowodem mutacyjnym (usunięcie czyszczenia
`sessionId`/`sessionName`/`sessionLabel` dało czerwony test przed przywróceniem fixu).

## Klaster C4 update (2026-09-03) — fallback tokenów w `_chatOnUsage`/`_chatBeforeContinue`/`_finalizeTurn` oznaczony `estimated:true`

Trzy wywołania `turn.tt.record('main', …)` w `chat_streaming.ts` zapisywały fallback (input z
`turn.lastInputTokens`, output z lokalnego `countTokens`, gdy API nie oddało `usage`) BEZ meta —
Token Viewer pokazywał estymatę jako pomiar realny z API zamiast prefiksu `~`/„przybliżone"
(ta sama flaga co estymaty subów, patrz „E2.2 (K4) update" wyżej). Naprawione: `_chatOnUsage`
liczy `estimated = apiInput === 0 && inputTokens > 0`; `_chatBeforeContinue`/`_finalizeTurn`
(gałąź `!turn.responseRecorded` jest ZAWSZE fallbackiem) niosą `{ estimated: true }` na stałe.
Strażnik po źródle: `chat/tokenTrackerEstimated.test.ts`.
