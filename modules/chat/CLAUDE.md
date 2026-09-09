# modules/chat/

**Interfejs czatu.** Główny widok pluginu - okno czatu w sidebarze Obsidiana. `ChatView` jest
koordynatorem, logika jest rozsiana po submodułach zaimplementowanych jako mixiny na
`ChatView.prototype`.

---

## Co tu jest

```
modules/chat/
├── index.js                       # publiczne drzwi
├── CLAUDE.md                      # ten plik
├── chat_view.js                   # ChatView (Obsidian ItemView), koordynator
├── consolidationRunner.js         # kontroler przebiegu konsolidacji pamięci (klej memory ↔ modal/pasek/notice)
├── SaveSessionModal.js            # `/save session` - review propozycji notatek brain/
├── SessionCloseModal.js           # zamknięcie sesji - archive / discard
├── OpenSessionModal.js            # otwórz starą sesję - continue / compress / fresh
├── ConsolidationProgressModal.js  # nieblokujące okno PRZEBIEGU konsolidacji
├── archiveReviewRenders.js        # rendery review (dedup + L1/L2/L3) pod modal przebiegu
├── consolidationRunState.js       # czyste decyzje modalu (isRunStuck/resolveStepDraft) + test
├── slash-commands/                # definicje komend slash (save_session.js)
└── chat/                          # mixiny (prototype) + helpery/rejestry
    ├── chat_streaming.js          # streaming tokenów + force-trigger injection + twardy backstop pętli
    ├── chat_ui.js                 # render UI elementów + popup `/@`
    ├── chat_messages.js           # render messages, history + compact tool chips
    ├── chat_artifacts.js          # panel Artefaktów v2 + guzik delegacji
    ├── chat_model.js              # model selection, multimodal handling
    ├── chat_session.js            # session save/load/restore (z `modules/memory/`) + _createRollingWindow
    ├── chat_tabs.js                # multiple chat tabs, tożsamość zakładki (`_tabKey`)
    ├── chat_popovers.js            # agent popovers, context menus
    ├── InlineChipPlugin.js         # marker parser: @@skill:, @sub-agent:, @@tool:
    ├── messagePrivileges.js        # bramki przywilejów tury (rejestr URL / markery / komendy `/`) - wszystkie pytają `meta.origin` z core/security/messageOrigin
    ├── queuedMessage.js            # slot kolejki wiadomości (tekst + proweniencja + WŁAŚCICIEL zakładki) + decyzje drenu i Stopu; pure, testowalny
    ├── subTaskDelivery.js          # komplet bramek dostarczenia wyniku suba (zakładka → aktywność → trwająca tura → Stop → sufit łańcucha); pure, testowalny
    ├── vaultReadGate.js            # bramka `vault.read` dla Oczka i @-wzmianek; pure
    ├── toolPopoverEntries.js       # lista popovera narzędzi = rejestr minus disabled_tools, TOOL_INFO tylko za ikonę/etykietę; pure, testowalny
    ├── safeErrorText.js            # normalizacja → maskSensitiveData → sufit; pure, testowalny
    ├── StreamingManager.js         # singleton multi-tab streaming tracking + `shouldUseFreshModel`
    ├── renderThrottle.js           # koalescencja malowania strumienia (pure, bez obsidian/DOM)
    ├── RollingWindowMessageStore.js # adapter MessageStore na RollingWindow dla runAgentLoop
    ├── RollingWindow.js            # token window
    ├── Summarizer.js               # kompresja starych tur + sekcja MEMORY_CANDIDATES
    ├── turnOwner.js                # kto jest WŁAŚCICIELEM okna/tury: resolvery + providery RollingWindow + `freezeTurnOwner(view)`; pure, testowalny
    ├── turnAbort.js                # uchwyt przerwania tury (zatrzask); pure, testowalny
    ├── compressionPrompt.js        # czysty re-export z `config/default_prompts.js` (tam mieszka DEFAULT_COMPRESSION_PROMPT) - lokalne drzwi dla wnętrza czatu
    ├── memoryCandidates.js         # parser bloku MEMORY_CANDIDATES z odpowiedzi Summarizera
    ├── subTaskNotification.js      # treść powiadomienia o wyniku suba z tła + matchTabForOrigin (pure, testowalny)
    ├── subTaskStrip.js             # pasek biegów subów POD zakładkami czatu; obsidian-free DOM, model z modules/sub-agents
    ├── SlashCommandsRegistry.js    # rejestr komend `/`
    ├── ToolReactorRegistry.js      # plug-in reaktory na tool results
    ├── TokenViewerWidget.js        # donut + pop-over Token Context Viewer
    ├── TokenViewerUtils.js         # helpery obliczeń dla Token Viewera
    ├── ToolTokenCache.js           # cache countTokens(JSON.stringify(tools)) per agent
    └── TriggerPopup.js             # popup `/@` z sekcjami SUB / SKILLS / MCP
```

CSS: `modules/chat/chat_view.css` (osobny plik styli).

`chat/chat_streaming.ts`, `chat/chat_ui.ts` i `chat/RollingWindow.ts` są świadomie
nierozbitymi monolitami (grubo ponad 800 LOC każdy) - zmiana w którymkolwiek wymaga
przeczytania całości przed edycją.

---

## Public API

`modules/chat/index.js` - 4 eksporty:

- `ChatView` - klasa (rozszerza Obsidian `ItemView`)
- `CHAT_VIEW_TYPE` - kanoniczny typ widoku czatu, obsidian-free re-export (`chatViewType.js` ->
  `core/index.js`)
- `insertInlineTriggerMarker(textarea, type, name)` - helper z `InlineChipPlugin.js`, wołany
  przez `modules/shell/sidebar/TriggersView.js` leniwym `import()`
- `startConsolidationRun(...)` - trigger konsolidacji pamięci; poza czatem woła go profil
  agenta (`modules/agents/profile/profile_memory.js`) leniwym `import()`, żeby nie dokładać
  statycznej krawędzi agents→chat

Mixinów `chat_*` NIE eksportujemy - to wewnętrzna struktura (prototype mixin pattern).
`TriggerPopup` jest wewnętrzną klasą, nie w barrelu (używana tylko przez `chat_ui.js`).
`DEFAULT_COMPRESSION_PROMPT` NIE jest w barrelu - mieszka w `config/default_prompts.js`,
Settings→Prompt bierze ją wprost stamtąd; lokalne drzwi `chat/compressionPrompt.js` zostają
dla wnętrza modułu (Summarizer, turnOwner). Singleton `StreamingManager` i `RollingWindow`
też nie wychodzą przez barrel - żyją i są używane wewnątrz `chat/`.

---

## Pattern: prototype mixin

ChatView jest **koordynatorem**, ale logika rozsiana jest po submodułach. Łączenie przez:

```js
import * as messages from './chat/chat_messages.js';
import * as streaming from './chat/chat_streaming.js';
// ... pozostałe

Object.assign(ChatView.prototype, messages, streaming, ...);
```

Mixin pattern daje: separację konceptualną + zachowanie `this` (każdy submoduł jest
`ChatView`-em) + brak breaking change przy dalszym dzieleniu. Wymaga `this` consistency -
funkcja w submodule nie może być stripowana przez bundler ani zamieniona na arrow function
(gubi `this`).

**Dlaczego tyle logiki jest w czystych plikach obok mixinów, nie w samych mixinach:**
`chat_streaming.ts`, `chat_ui.ts`, `chat_model.ts`, `chat_popovers.ts`, `chat_session.ts` i
`chat_tabs.ts` importują `obsidian` (Notice, MarkdownRenderer, ItemView…), więc AVA (node) nie
potrafi ich zaimportować - test, który mierzy tylko REGEX po źródle, nie odróżnia poprawnej
gałęzi od takiej, która zachowuje napis, ale kasuje skutek. Dlatego decyzja w tym module NIGDY
nie zostaje jako logika wewnątrz mixina wiszącego na `obsidian`: idzie do czystej funkcji obok
(`turnOwner.ts`, `turnAbort.ts`, `queuedMessage.ts`, `subTaskDelivery.ts`, `vaultReadGate.ts`,
`toolPopoverEntries.ts`, `safeErrorText.ts`, `renderThrottle.ts`, `subTaskNotification.ts`,
`memoryCandidates.ts`, `todoPanel.ts`, `StreamingManager.ts`) z testami obu stron każdej
gałęzi, a mixin jest cienkim wołaczem. Strażnik po źródle (regex na plikach z `obsidian`)
zostaje wyłącznie na OKABLOWANIE - kształt użycia (`if (!x.allowed)`, który argument leci
gdzie), nigdy na samą obecność identyfikatora.

---

## Zależności

**Importuje z:**
- `core` (Logger, i18n, sanitizePath, autonomy: `AUTONOMY_MODES`/`DEFAULT_AUTONOMY`/`normalizeAutonomy`, `core/security/messageOrigin`, `maskSensitiveData`)
- `modules/memory/` (AgentMemory przez agentManager, `streamToComplete`, workflowy) - `RollingWindow` i `Summarizer` są lokalne w chat; ich importy z `modules/agent-loop` (`sanitizeToolTranscript`) idą wprost z domu, nie przez barrel memory
- `modules/agent-loop/` (`runAgentLoop`, `ArrayMessageStore`, `parseToolCalls`, `sanitizeToolTranscript`)
- `modules/tools/` (ToolRegistry - narzędzia dla agenta)
- `modules/models/` (ChatModel, modelResolver, isLocalPlatform)
- `modules/artifacts/` (`artifact_create`/`artifact_read`/`artifact_update`/`artifact_list` + `todo` progress)
- `modules/agents/` (AgentManager dla aktywnego agenta)
- `modules/sub-agents/` (DelegateTool integration)
- `modules/ui-components/` (bloki narzędzi/myślenia/subów + `PluginItemView` - baza `ChatView`)
- `config/default_prompts.js` (`DEFAULT_COMPRESSION_PROMPT`, przez `chat/compressionPrompt.js`)
- `obsidian` (ItemView, Notice, TFile)

Moduł **nie importuje z `modules/shell/`** - modale sesji (`SaveSessionModal`,
`SessionCloseModal`, `OpenSessionModal`) i trio konsolidacji (`ConsolidationProgressModal`,
`archiveReviewRenders.js`, `consolidationRunState.js`) mieszkają w korzeniu tego modułu,
świadomie nie w barrelu chatu.

`consolidationRunner.js` leży w korzeniu `modules/chat/`, nie w `chat/`, bo
`slash-commands/save_session.js` musi go importować - specyfikator `../chat/...` wyglądałby
dla lintera importów jak deep import w cudzy moduł.

**Importowany przez:** `src/main.js` (rejestracja view: `registerView(VIEW_TYPE_CHAT, ...)`).

---

## Kontrakty i gotchas

### Właściciel tury i okna - stan tury żyje w OBIEKCIE TURY, nigdy w polu widoku

Okno rozmowy (`RollingWindow`) i tura potrafią przeżyć przełączenie zakładki przez usera -
kompresja końca tury, finalizacja strumienia i sprzątanie po Stopie muszą wtedy trafić do
WŁAŚCIWEGO agenta/zakładki, nie do tego, co akurat widać na ekranie.

- **`freezeTurnOwner(view)`** (`chat/turnOwner.ts`, pure, testowalny) czyta widok RAZ,
  synchronicznie, na samym starcie `send_message` (obok `createTurnAbort()`, razem z
  zapaleniem guzika Stop, PRZED pierwszym awaitem przygotowania) i oddaje `FrozenTurnOwner`:
  `agentName`, `agent`, `rollingWindow`, `tokenTracker`, `memory` (po nazwie, fail-closed),
  `sessionPath`, `tab`, `autonomy`, `artifactId`. Od tej linii `send_message` NIE pyta już
  widoku "kto jest teraz aktywny" - prompt, resolucja skilli z markerów, Oczko, model
  (`get_chat_model({agent})`), autonomia i adres zwrotny delegacji w tle idą z `owner`, nie z
  `getActiveAgent()`.
- **Klucz tożsamości zakładki (`tabKey`) liczy się RAZ**, zaraz po `freezeTurnOwner`, i jedzie
  dalej jako `turn.origin.tabKey` (dla kroków z dostępem do `turn`) albo jako goły string do
  callbacków bez dostępu do `turn` (np. `handle_error`). Przeliczanie klucza PÓŹNIEJ, z żywego
  pola widoku, jest błędem klasy "czyta już nową wartość" - np. akcja `/save session` potrafi
  podmienić `sessionPath` zakładki NA MIEJSCU w trakcie trwania tury.
- **`_agentStates` (stan per zakładka: rolling window, token tracker, autonomia) jest
  kluczowana WYŁĄCZNIE `_tabKey(tab)`, nigdy nazwą agenta.** Dla zakładki odtworzonej z dysku
  `_tabKey` daje ścieżkę sesji, nie nazwę agenta - klucz nazwą agenta zostawiał zakładkę na
  wiecznym "generuję". Formuła `_tabKey` (`sessionId || sessionPath || sessionName ||
  agentName`) ma JEDNO źródło (`chat_tabs.js`, eksportowana) - druga kopia formuły gdziekolwiek
  indziej (popover autonomii, restore wielu zakładek) to zawsze bug w czekaniu.
- **`_streamCtxMap` (uchwyt streamu per agent) zwalnia tylko właściciel.** Mapa jest kluczowana
  nazwą agenta, a pod jedną nazwą potrafią chwilowo żyć dwie tury (zakładka dodana ponownie z
  pickera, wyścig z przygotowaniem promptu) - bezwarunkowy `delete` przy finalizacji STAREJ
  tury kasowałby uchwyt przerwania ŻYWEJ. `_releaseStreamCtx(agentName, turnId)` porównuje
  `turnId` przed `delete` (ten sam wzór co watchdog w `_onStreamStall`). Znana, świadoma
  granica: "Stop bez argumentu zatrzaskuje WSZYSTKIE żywe tury zakładki" wymagałoby kolekcji
  tur per `turnId` zamiast mapy per nazwa agenta - nie jest zrobione; `_isTurnActiveTab` (która
  gałąź tło/aktywna leci w finalizacji) rozstrzyga po nazwie agenta, nie po `_tabKey`/`turnId`,
  ta sama, znana granica.
- **Callbacki OKNA (kompresja end-of-turn, ratunek pamięci) malują UI TYLKO gdy zakładka
  właściciela jest na wierzchu.** Zapis do dysku/pamięci leci bezwarunkowo także dla zakładki w
  tle (to reguła o DANYCH), ale `messages_container` jest JEDEN na cały widok - malowanie bloku
  "skompresowano" agenta A w rozmowie, którą user czyta u agenta B, byłoby artefaktem cudzej
  tury. `turnOwner.isOwnerTabActive(view, ownerName)` (fail-open gdy widok nie zna modelu
  zakładek) bramkuje te trzy callbacki. Rozstrzyga po NAZWIE AGENTA, nie po `_tabKey` - dwie
  otwarte zakładki tego samego agenta naraz nadal malowałyby sobie nawzajem te bloki (nie
  zrobione, bo dziś nie da się otworzyć dwóch zakładek jednego agenta).
- **Estymata wejścia tokenów (`lastInputTokens`/`lastInputChars`) żyje w `turn`, nie na
  widoku.** Przy dwóch turach naraz w jednym `ChatView` (patrz "świeża instancja modelu"
  niżej) tura A czytałaby estymatę nadpisaną przez turę B.
- **Decyzja "czy bieżący model jest wizyjny" pyta o WŁAŚCICIELA tury, nie o globalnie
  aktywnego agenta.** `_isCurrentModelVision(agent?)` przyjmuje opcjonalnego agenta; wybór
  kształtu wyniku `generate_image` (`_chatExecuteToolCall`) podaje `turn.agent`. Dwa wywołania
  czysto UI-owe (ostrzeżenie przed wysyłką, jeszcze przed zamrożeniem właściciela) zostają bez
  argumentu celowo - tam pytanie o aktywnego agenta jest właściwym pytaniem.
- **Mid-loop compression ustawia `rollingWindow.sessionPath` tak samo jak end-of-turn** (czyta
  ją `Summarizer` do stopki "pełna rozmowa zapisana w: ...") - obie ścieżki kompresji muszą
  czytać `activeSessionPath` właściciela PRZED kompresją, nie tylko end-of-turn.
- ⚠️ **Zostaje wąskie okno PRZED zamrożeniem:** między kliknięciem Wyślij a `createTurnAbort()`
  są jeszcze awaity zapisu przy bezczynności, komendy `/`, rozwiązywanie wzmianek i
  `append_message` (wiadomość użytkownika idzie przez `this.rollingWindow` widoku, nie przez
  okno tury). Nowy await w tym odcinku - rozważ przesunięcie zamrożenia w górę.
- ⚠️ **`_switchTab` NIE jest blokowany w trakcie generowania i nie będzie** - user ma prawo
  czytać inną zakładkę, gdy agent pracuje. Bezpieczeństwo stoi na tym, że żywa tura trzyma
  WŁASNE referencje (zamrożone), nie na tym, że nikt nic nie przełączy.
- **`appendToActiveSession` adresuje pamięć po `event.agentName`** - czyli po turze, która
  zdarzenie wyprodukowała, nie po agencie akurat wybranym w UI. Nowe zdarzenie do event-logu
  musi nieść `agentName` jawnie.
- **`handleSaveSession(agentName?, rollingWindow?)`** przyjmuje właściciela i okno tury -
  kompresja z tła podaje oba; wołania z aktywnej zakładki wołają bez argumentów.
- Znana granica: gdy właściciel ma `minionEnabled === false`, `modelProvider` spada na
  `get_chat_model()` bez agenta, czyli na aktywnego agenta w UI.

### Proweniencja wiadomości: `meta.origin`, nie rola dymka

Rola dymka (`'user'`) nie oznacza, że tekst napisał człowiek - guziki i auto-tury też
wypełniają pole wpisywania i wołają `send_message()`. Trzy mechanizmy w turze traktują tekst
jak POLECENIE, nie jak dane, więc muszą wiedzieć, kto go napisał: rejestr adresów URL (bramka
`web_read`), markery inline (`@@skill:` wstrzykuje pełny przepis do promptu systemowego) i
komendy `/`.

- `meta.origin: 'human' | 'machine'` (`core/security/messageOrigin.ts`) jest jedynym źródłem
  prawdy o przywilejach wiadomości. **Brak znacznika = maszyna** (fail-closed) - dotyczy też
  `MouseEvent`, który wpada jako `opts`, gdy `send_message` jest wpięty wprost jako listener
  kliknięcia (`send_button.addEventListener('click', this.send_message.bind(this))` - z `opts`
  czyta się dlatego tylko `injectedText`, jawnie `typeof === 'string'`, i `meta`).
- `'human'` nadają dokładnie DWIE ścieżki: guzik Wyślij i Enter w polu tekstowym (`chat_ui.ts`,
  stała `HUMAN_MESSAGE_META`). Wysyłki z kodu (przywołanie agenta na artefakcie, propozycja
  delegacji, komentarz inline, auto-tura po wyniku suba) niosą `MACHINE_MESSAGE_META` albo
  `machineMeta({...})`, gdy dokładają pola (np. `_subTaskNotification`/`subTaskId`).
- Bramki żyją w jednym miejscu: `modules/chat/chat/messagePrivileges.ts`
  (`parseTriggersIfHuman`, `mayRunSlashCommand`, `registerUrlsIfHuman`).
- **Dwie osie, nie jedna.** `injectedText`/`isInjected` mówi tylko "tekst NIE pochodzi z pola
  wpisywania" i rządzi mechaniką inputu (historia, załączniki, czyszczenie pola, szkic).
  `origin` mówi "kto pisał" i rządzi przywilejami bezpieczeństwa. Wysyłki, które pole
  wpisywania WYPEŁNIAJĄ, mają `isInjected === false`, a mimo to są maszynowe - dlatego jedna oś
  nie wystarcza.
- **Kolejka wiadomości (`_queuedMessage`) wozi własną pieczątkę, nie dziedziczy `human` z
  faktu bycia w kolejce.** `chat/queuedMessage.ts` (pure): `QueuedChatMessage {text, meta,
  owner}`, `queueChatMessage(text, meta)` (pieczątka fail-closed przez `resolveMessageOrigin`)
  i `readQueuedMessage(slot)` (pusty slot -> `null`; goły string, legacy kształt -> MASZYNA, nie
  awansuje do przywilejów człowieka). Slot jest JEDEN - nowsza wiadomość zastępuje starszą w
  całości, więc pieczątki nigdy się nie sklejają. Gdyby kolejka miała urosnąć do listy, reguła
  jest fail-closed: paczka z choćby jednym tekstem maszynowym jedzie jako `machine`.
- **Czego to NIE jest.** `_invocationOrigin` (`MCPClient` -> `DelegateTool`) to adres ZWROTNY
  zlecenia (zakładka + agent, gdzie wrócić z wynikiem suba) - inny wymiar, inny kształt, nie
  łączyć z `meta.origin`.
- `regenerateLastResponse` (ponów odpowiedź) NIE nadaje znacznika od siebie - czyta go z
  ponawianej wiadomości, więc powtórka ma dokładnie te same prawa co oryginał. Wiadomości
  odtwarzane z zapisanej sesji omijają `append_message` i nie zasilają rejestru adresów.
  Komendy `/` z tekstu maszynowego nie działają - żadna ze ścieżek maszynowych ich nie używa.

### Stop i przerwanie tury

Uchwyt przerwania (`createTurnAbort()`, `chat/turnAbort.ts` - zatrzask: raz podniesiona flaga
nie gaśnie, `abort()` idempotentne) leży w DWÓCH miejscach naraz, ten sam obiekt: w `turn.abort`
(czyta go pętla i watchdog ciszy) oraz we wpisie `_streamCtxMap` (sięga po niego
`stop_generation(agentName)` i zamknięcie widoku). Pętla dostaje `shouldAbort: () =>
turn.abort.isAborted()`.

- Uchwyt powstaje razem z zapaleniem guzika Stop (`set_generating(true)`), nie dopiero przy
  rejestracji wpisu w `_streamCtxMap` - budowa promptu z pamięcią potrafi trwać sekundy. Na ten
  czas uchwyt leży w `_preparingTurns` (agentName -> uchwyt); wpis znika przy rejestracji ctx.
- **`stop_generation` musi dostać `agentName` jako string** - wpięty jako listener kliknięcia
  bez wrappera dostawałby `MouseEvent`, a mapa tur jest kluczowana nazwą agenta. Guzik jest
  dziś `() => this.stop_generation()`, z pasem zapasowym w funkcji (argument nie-string =
  aktywny agent).
- **`stop_all_turns(reason)`** zatrzymuje KAŻDĄ turę z `_streamCtxMap` (kopia nazw przed
  iteracją, bo `stop_generation` kasuje wpisy w trakcie), kasuje `_queuedMessage` i prosi
  `subTaskRegistry.requestStop` o zatrzymanie subów zleconych z zakładek tego widoku
  (dopasowanie po `origin.tabKey`, fallback po `origin.agentName`; biegi bez `origin` - zlecone
  spoza czatu - zostają nietknięte). `onClose` woła to PRZED rozbrojeniem watchdogów.
  Zamknięcie JEDNEJ zakładki (`_closeActiveTab`) robi to samo w zakresie tej zakładki, tylko
  gdy ma turę w locie - Stop na cichej zakładce podniósłby `_drainSuppressed` i wyczyściłby
  stan streamingu niepotrzebnie.
- **Bramka "po Stopie/watchdogu nie startujemy tury sami"** żyje jako `_drainSuppressed` -
  podnosi ją Stop i watchdog ciszy, gasi start następnej tury. Sprawdzana przez WSZYSTKIE
  mechanizmy, które domykają turę "po fakcie" (z timera, z powiadomienia, z `finally`): dren
  kolejki wiadomości, dostawca wyniku suba (`_deliverSubTaskResult`, bramka stoi obok trzech
  innych: zakładka / aktywność / trwająca tura / sufit łańcucha). Sam fakt, że coś zostało
  zaplanowane (timer, callback), nie jest zgodą na wykonanie - trzeba sprawdzić też, czy adresat
  to nadal ta sama zakładka/tura (`queuedOwnerMatches`, `turnId`).
- **Kolejka wiadomości ma WŁAŚCICIELA i uchwyt timera.** `_queuedMessage` wozi `{text, meta,
  owner}` (`owner = {agentName, tabKey}` z chwili kolejkowania). Dren w `set_generating(false)`
  trzyma uchwyt timera (nie goły `setTimeout` bez możliwości anulowania), opróżnia slot dopiero
  W CALLBACKU po bramkach (anulowanie nigdy nie gubi wiadomości) i pyta
  `queuedOwnerMatches(queued, aktualnyWłaściciel)` - user mógł w międzyczasie przełączyć
  zakładkę, wybudzony timer bez tej bramki wkleiłby cudzy tekst w pole i wystartował turę
  złym modelem/promptem/pamięcią/uprawnieniami. Przy rozjeździe wiadomość ZOSTAJE w slocie i
  czeka na swoją zakładkę. `_switchTab` rozbraja timer na wejściu, `stop_all_turns` przed
  kasowaniem slotu. **Stop anuluje zakolejkowaną wiadomość** - kasuje slot, gasi wskaźnik,
  rozbraja timer; tekst wraca do pola wpisywania, jeśli ono jest puste (szkic usera się nie
  gubi).
- **`_resetPaintTargets()` jest jedynym miejscem prawdy o wskaźnikach malowania**
  (`current_message_container`/`bubble`/`text`/`_lastPaintedContent`) - wołają go
  `handle_error`, `_finalizeTurn`, `stop_generation` i `_chatBeforeContinue`. Bez zerowania po
  błędzie kolejna odpowiedź malowałaby się do dymka poprzedniej wiadomości. Działa WYŁĄCZNIE na
  ścieżce aktywnej zakładki - pola są per-WIDOK, nie per-zakładka, więc zerowanie z tury
  kończącej się w tle wyrwałoby dymek żywej turze na wierzchu (świadomie nie zrobione dla
  gałęzi tła).

### Malowanie strumienia jest za throttlem

`handle_chunk` NIE maluje bezpośrednio - zgłasza klatkę `{text, reasoning}` do
`chat/renderThrottle.ts`, a ten woła `_paintStreamFrame` najwyżej raz na ~80 ms, zawsze
OSTATNIĄ treścią. Powód: callback `chunk` adaptera niesie treść ZAKUMULOWANĄ i leci raz na
ramkę SSE, więc malowanie per chunk jest kosztem kwadratowym względem długości odpowiedzi, a
chunki z samą deltą `tool_calls` bywają identyczne bajt-w-bajt (renderowanie ich ponownie to
czysta strata).

- **Każde nowe wyjście z tury musi domknąć klatkę**: `flush()` PRZED zerowaniem celów malowania
  (tak robią `_finalizeTurn`, `stop_generation`, `_chatBeforeContinue` - inaczej ginie ogon
  odpowiedzi), albo świadomy `reset()`/`cancel()`, gdy dymek jest i tak nadpisywany (ścieżka
  błędu).
- **Nie wołaj `MarkdownRenderer` z `handle_chunk`** - to złamie throttling.
- Malowanie zostaje SYNCHRONICZNE (żaden async render) - throttle capuje częstotliwość, nie
  kolejność.
- **Klatka należy do ZAKŁADKI, nie do widoku.** Timer uzbrojony tuż przed przełączeniem
  zakładki wystrzeliłby PO przerysowaniu listy i PO przywróceniu pozycji scrolla - tekst
  poszedłby w wypięte węzły starej zakładki, a scroll przewinąłby nową. `_switchTab` rozbraja
  throttle na wejściu, a `_paintStreamFrame` dodatkowo pyta `shouldPaintFrame(frame, aktywna
  zakładka)` - klatka wozi `owner` (nazwę agenta tury). Nowa ścieżka, która przerysowuje listę
  wiadomości, musi rozbroić throttle.
- **Łączniki (`_drawConnectorLines`) rysują się raz na klatkę, nie na każde wywołanie.**
  `scrollToBottom(smooth, {drawConnectors: false})` to tryb "tylko przewiń" (używa go
  malowanie strumienia - rosnący tekst ostatniej wiadomości nie przesuwa kryształu ani wierszy
  akcji); reszta wołaczy dostaje `_scheduleConnectorRedraw()` (rAF, fallback `setTimeout`).
  Funkcja skanuje CAŁĄ listę wiadomości i przeplata `getBoundingClientRect` z wstawianiem
  węzłów - nie wołaj jej w pętli.
- **Licznik tokenów okna liczy PRZYROSTOWO.** `RollingWindow` trzyma statystyki tekstu
  (długość + liczba znaków spoza ASCII) per wiadomość (`_messageStats`, WeakMap) i dla promptu
  (`_promptStats`), a tokeny składa `countTokensFromStats` z `core`. Dokładasz pole wiadomości,
  które jedzie do modelu? Dopisz je do `_messageStats` i do odcisków ważności - inaczej okno
  przestanie je widzieć. Ważność liczy TOŻSAMOŚĆ pól + długość tablic (Oczko dokłada blok
  obrazu przez `push` w miejscu).
- **Obrazy w oknie liczone są z SUFITEM, nie proporcją do długości base64.**
  `estimateImageTokens(url)` = `min(ceil(url.length/4/1.2), 1600)` - realny koszt wizji u
  providerów to ~85-1600 tokenów/obraz. `_contentToTokenText` NIE wkłada base64 obrazu do
  wspólnego stringa liczonego przez `getTokenCount` (tylko tekst); `_contentImageTokens`
  liczy sumę sufitów per obraz osobno. Bez tego pojedynczy duży obraz w wyniku narzędzia potrafi
  wybić estymatę tokenów o rzędy wielkości ponad realny koszt, wywalając hard limit okna w
  jednym wywołaniu i wywalając całą grupę wiadomości z okna, zanim model ją zobaczy.
  Trim/przycinanie treści (`_contentSize`) liczy REALNY rozmiar treści (string -> `.length`,
  tablica z obrazem -> suma długości tekstu + długość `image_url.url`), nie liczbę bloków
  tablicy - `content.length` na tablicy `[{type:'text'},{type:'image_url'}]` to zawsze 2,
  niezależnie od rozmiaru obrazu, więc taka wiadomość jest strukturalnie nietrimowalna, jeśli
  liczy się `.length` wprost.
- `MarkdownRenderer.render(app, …)` (następca deprecated `renderMarkdown`) jest wołany
  fire-and-forget (`void`, bez await) w `_paintStreamFrame` i `_finalizeTurn` - obie funkcje
  zwracały `Promise<void>` bez await już w starym API, więc migracja nie zmienia ryzyka
  out-of-order ponad to, co throttle i tak capuje.

### Watchdog ciszy modelu i timeout per-call

`StreamWatchdog` (`core/utils/StreamWatchdog.ts` - pure, node-testowalny; mieszka w `core/`, nie
w `chat/`, bo potrzebuje go też `modules/memory/streamHelper.js`, a memory nie może importować z
chat) przerywa turę, gdy model milczy zbyt długo - zarówno brak pierwszego chunka, jak i stall
mid-stream.

- Timer zbroi się na `onGateAdmitted` (wejście requestu na slot bramki platformy lokalnej), nie
  na starcie iteracji - inaczej czas spędzony w kolejce bramki liczyłby się jako cisza modelu.
  Chmura emituje ten sygnał natychmiast (zero zmian tam); na platformie lokalnej faza kolejki
  nie jest liczona. Resetowany każdym chunkiem, rozbrajany gdy model skończy mówić.
- Limit: `chat_stream_stall_timeout_ms` (`config/limits.ts`, default 120 s, 0 = wyłączony,
  sufit 600 s), nadpisywalny w Settings → Limity. Platforma bez prawdziwego streamingu
  (odpowiedź w jednym kawałku po pełnym `complete()`) jest wyłączona z watchdoga - cisza
  mid-flight jest tam normalna.
- Pas ostateczny na klasę "sygnał nigdy nie przyszedł" (np. request utknął przed samą bramką) to
  osobny `chat_model_call_timeout_ms` (default 600 s, 0 = off) - budzik per-call z JEDNYM
  przezbrojeniem na admisji.
- `_onStreamStall(turn, silentMs)` przerywa turę TĄ SAMĄ ścieżką co ręczny Stop: aktywna
  zakładka -> `stop_generation(agentName)` + komunikat w czacie; zakładka w tle -> cleanup stanu
  jak `handle_error`. Wyrejestrowuje stream ze `StreamingManager` (wiszący XHR po abort nie
  rozstrzyga promisy pętli, więc `finally` w `send_message` mógłby nigdy nie ruszyć bez tego).
- **Watchdog celuje w TURĘ (`turnId`), nie w agenta.** Porzucona tura (user wystartował nową
  sesję tego samego agenta, zostawiając starą wiszącą w tle) ma własny `turnId` w
  `_streamCtxMap` - watchdog porzuconej tury sprząta po sobie i NIE woła `stop_generation`,
  żeby nie ubić świeżej, żywej tury tego samego agenta (współdzieloną instancję modelu i wpis
  mapy per nazwa). `handleNewSession` dodatkowo ubija trwającą turę na wejściu, żeby nowa sesja
  nie zostawiała zombie z uzbrojonym watchdogiem.
- Czas pracy narzędzi się NIE liczy do watchdoga streamu - to osobna warstwa timeoutów w
  `modules/tools/`.
- Zero wycieków timera: disarm w `finally` pętli + w `stop_generation` + `chat_view.onClose`
  (który NAJPIERW zatrzymuje tury przez `stop_all_turns`, a DOPIERO POTEM rozbraja resztki
  timerów - odwrotna kolejność zdejmowałaby strażnika turze, której nikt jeszcze nie zatrzymał).

### Backstop pętli narzędzi

Limit rund narzędzi w turze czatu = `chat_max_iterations` (`config/limits.ts`, default 8),
nadpisywalny w Settings → Limity. Gdy licznik osiągnie limit, pętla wysyła ostatnie zapytanie
BEZ narzędzi (`tools: undefined`) - model nie ma jak wywołać narzędzia, więc musi odpowiedzieć
tekstem i tura kończy się czysto (backstop jest twardy, nie tylko tekstową sugestią "przestań
wołać narzędzia").

Mechanika iteracji, backstop, sanityzacja transkryptu i obcinanie wyników narzędzi żyją w
`modules/agent-loop` (`runAgentLoop`) - `chat_streaming.ts` jest TWARZĄ tury: przygotowanie
(`send_message`), rendering (`handle_chunk`), placeholdery/UI narzędzi (hooki) i finalizacja
(`_finalizeTurn`). Hooki pętli (`_chatResolveTools`, `_chatOnIterationStart`,
`_chatExecuteToolCall`, `_chatOnIterationStart`, `_chatOnToolCallsParsed`, `_chatOnToolResults`,
`_chatOnUsage`, `_chatOnBackstop`, `_chatBeforeContinue`, `_finalizeTurn`) są punktami
zaczepienia w tej pętli. `RollingWindowMessageStore.ts` adaptuje kontrakt `MessageStore`
(agent-loop) na `RollingWindow` - kierunek zależności chat -> agent-loop.

### Oś autonomii per zakładka

`ChatView.currentAutonomy` (`yolo`/`edge`/`all`, default `edge`) jest trzymana per zakładka
(obok rolling window/token trackera), zwierciadło w `plugin.currentAutonomy` służy dziedziczeniu
przez suby. **Autonomia to polityka UI "czy pytać", nie własność agenta** - nie ma per-agent
override. Zmiana autonomii NIE wstrzykuje wiadomości do rozmowy - model o niej nie wie.
Przekazanie: `turn.autonomy` -> `_chatExecuteToolCall` -> `mcpClient.executeToolCall(toolCall,
agent, {autonomy})`; suby dziedziczą przez `SubAgentRunner._executeTool`. Narzędzia dostępne
agentowi zależą wyłącznie od whitelisty serwerów agenta (`filterByAgent`), nie od trybu.

### Popover uprawnień (tarcza)

Cztery wiersze popovera ("Odczyt notatek" / "Modyfikacja notatek" / "Tworzenie plików" /
"Usuwanie plików") piszą do `agent.disabled_tools` (helpery `isPermissionSwitchOn` /
`applyPermissionSwitch` z barrela `modules/agents`) - to jest oś realnie egzekwowana przy
wywołaniu narzędzia (`ToolRegistry.checkToolAxis` w `MCPClient`). Wiersze "Pamięć" i "Miejsce
pracy" (`guidance_mode`) zostają na `default_permissions` - to jedyne dwa pola tej rodziny,
które są realnie czytane. Zapis idzie przez `agentManager.updateAgent` (nie przez
`loader.saveAgent` wprost) - inaczej zmiana ląduje w pliku YAML, który loader odrzuca, i znika
po restarcie Obsidiana.

### Bramka `vault.read` dla Oczka i @-wzmianek

Oczko (aktywna notatka wciągana do promptu) i @-wzmianki wciągają pliki vaulta do promptu bez
wywołania narzędzia `read` - `chat_model.ts` buduje jeden predykat
(`evaluateVaultRead`/`createVaultReadPredicate`, `chat/vaultReadGate.ts`, pure) wołający
`permissionSystem.checkPermission(agent, 'vault.read', path)` (agent = właściciel tury) i podaje
go zarówno producentowi Oczka jako `canReadImage`, jak i sprawdzaniu wzmianek. Agenta rozwiązuje
się dopiero PO sprawdzeniu, że bramka w ogóle stoi. Cały `permissionSystem` jest przekazywany
jako obiekt (nie sama metoda) - `checkPermission` jest wołane NA NIM.

### Bezpieczny tekst błędu w oknie czatu

`handle_error` NIE wstawia `error.message` wprost do DOM-u ani nie loguje surowego obiektu -
ścieżka sieciowego padu strumienia bywa `JSON.stringify` całego zdarzenia streamera, co
potrafi nieść nagłówki żądania (w tym klucz API). `chat/safeErrorText.ts` (pure):
`safeErrorText(error, {limit})` = normalizacja (Error / string / obiekt bez `message` /
obiekt cykliczny, nigdy nie rzuca) -> `maskSensitiveData` (`core/index.js`) -> sufit
(`CHAT_ERROR_TEXT_LIMIT`, dalej `…`). Trzy zlewy w `chat_streaming.ts`: dymek błędu (obie
gałęzie), `log.error` w `handle_error` i w `catch` `send_message`. Do logu idzie tekst, nie
obiekt - świadoma cena maskowania. To jest ZLEW, nie źródło - normalizacja błędu po stronie
modelu (`modules/models/`) jest osobną warstwą; obrona w głąb działa nawet gdy źródło znów
wpuści nagłówek. Nie objęte: teksty błędów narzędzi/subów w blokach wyniku
(`_chatOnToolResults`) - inny zlew, inna warstwa.

### Popover narzędzi czyta rejestr, nie mapę ikon historii

`TOOL_INFO` (`modules/ui-components/ToolCallDisplay.ts`) to katalog ikon/etykiet DLA RENDERU
STAREJ HISTORII - celowo ma wpisy narzędzi, które już nie istnieją (żeby stare transkrypty
dalej wyrenderowały nazwę). Lista popovera narzędzi w pasku inputu MUSI więc brać źródło z
`ToolRegistry.getAllToolNames()` (żywy rejestr), nie z `Object.keys(TOOL_INFO)` - inaczej user
widzi narzędzia-widma (klik wkleja model podpowiedź na coś, czego `ToolRegistry` nie zna) i nie
widzi realnie zarejestrowanych narzędzi bez wpisu w katalogu ikon. `chat/toolPopoverEntries.ts`
(`buildToolPopoverEntries(registryNames, disabledTools, toolInfo)`, pure): rejestr minus
`disabled_tools`, w kolejności rejestru; nazwa z rejestru bez wpisu w `TOOL_INFO` dostaje
fallback (etykieta = surowa nazwa, ikona domyślna). Ten sam wzór (rejestr, nie katalog ikon) jak
w `modules/tools/ConnectorsBackstageTab.ts`.

### Konsolidacja pamięci: jedna droga triggera

`startConsolidationRun({plugin, app, agentMemory, agent, model, settings, source})` (
`consolidationRunner.ts`) jest jedyną drogą uruchomienia konsolidacji - klej między silnikiem
(`modules/memory`, `runWithRun`/`applyStepDecision`) i widokami (modal, pasek statusu, notice).
Rejestruje przebieg w `memoryOpsCenter`, otwiera modal leniwym `import()` (statyczny import
ciągnąłby `obsidian` do kontrolera, który musi być testowalny node'em -
`consolidationRunner.test.ts` jest w całości `test.serial`, bo centrum operacji to singleton
modułowy). `registerConsolidationModalOpener(app)` jest idempotentne dla tej samej instancji
`app` - inna instancja (dev-reload) odpina starą subskrypcję i zakłada świeżą.

- `source: 'auto' | 'manual'` (default `'manual'`) rozróżnia trigger progowy
  (`/save session` i idle-scheduler -> `'auto'`) od guzika w profilu agenta (-> `'manual'`).
  Przy PUSTYM planie `manual` mówi userowi "nie ma czego konsolidować"; `auto` milczy (tylko
  log) - licznik sesji-do-konsolidacji zeruje dopiero realny zapis paczki L1, więc przy mniej
  niż `batchSize` niepokrytych sesji próg jest przebijany przy każdym kolejnym zapisie sesji, a
  głośny notice po każdym `/save session` byłby spamem.
  Guzik "Podsumuj rozmowy" w profilu agenta jest jedynym pozostałym wejściem manualnym -
  drugi, dublujący guzik został wycięty.
- Plan liczy `archiveCount` z `listUncoveredArchiveSessions()` (sesje BEZ stempla
  `covered_by_l1`) - tym samym źródłem, z którego generator bierze materiał, więc plan nie
  obiecuje paczek, które generator potem odrzuci jako "za mało sesji".
- Koszt (`usage` strzału propozycji, `null` na ścieżce regexowego fallbacku) idzie do `CostLog`
  (`role: 'save-session'` dla `/save session`, `role: 'memory-consolidation'` dla przebiegu) -
  zaraz po udanej analizie, niezależnie od tego, czy user zaakceptuje notatki.
- "Anuluj" w fazie propozycji realnie anuluje: decyzja usera ściga się ze strzałem do modelu
  (`Promise.race`), przegrany strzał dostaje `AbortController.abort()`; pad/zwis nie spada po
  cichu na fallback regexowy - modal pokazuje przyczynę i guzik "Ponów analizę".

### Dostarczenie wyniku sub-agenta zleconego w tle

`delegate` domyślnie nie blokuje tury - model dostaje pokwitowanie `{started, task_id}`, a bieg
suba kończy się długo po zamknięciu tury. Czat jest nadawcą adresu zwrotnego i odbiorcą wyniku.

- **Origin liczony RAZ na turę**, przed pętlą (`turn.origin = {agentName, sessionPath,
  tabKey}`), podawany do KAŻDEGO wywołania narzędzia w tej turze - nie per tool call, bo user
  może przełączyć zakładkę w trakcie, a wynik ma wrócić tam, skąd wyszło zlecenie. `tabKey`
  liczy `chat_tabs._tabKey` - ta sama tożsamość, której używa `_switchTab`.
- **Pokwitowanie ma własny render.** `_chatOnToolResults` ma gałąź `result.started === true`
  PRZED gałęzią `success`: pulsujący blok sub-agenta, lista wystartowanych zadań, licznik
  `queued`, nota "wynik wróci powiadomieniem" - bez tej gałęzi user dostawałby pustą ramkę z
  zielonym "gotowe" (zwrotka z tła nie niesie `result`/`tools_used`/`duration_ms`).
  Token tracker pomija pokwitowanie - prawdziwe zużycie przychodzi dopiero z wynikiem.
- **Czat jest dostawcą wyników** dla `plugin.subTaskNotifier`. `ChatView.onOpen` wpina dostawcę
  PO `initSessionManager()` (dopiero wtedy stoją zakładki, do których dopasowuje się origin) i
  odpala od razu `drain()` (wyniki, które skończyły się przy zamkniętym czacie, wjeżdżają na
  wejściu); `onClose` odpina dostawcę.
- **Auto-tura tylko na aktywnej i bezczynnej zakładce, pod sufitem łańcucha.**
  `evaluateSubTaskDelivery` (`chat/subTaskDelivery.ts`, pure) sprawdza w kolejności: zakładka
  adresata istnieje, jest aktywna, jest bezczynna (nie trwa tura), bramka "po Stopie/watchdogu
  nie startujemy sami" (`_drainSuppressed`) jest wyłączona, i łańcuch kolejnych auto-tur po
  subach dla tego agenta nie osiągnął sufitu (`max_consecutive_auto_turns`, `config/limits.ts`).
  Każdy warunek niespełniony = `false`, wynik zostaje w kolejce notifiera i wraca przy
  najbliższym `drain()` (koniec tury / przełączenie zakładki / otwarcie czatu). Zakładkę
  wskazuje pure `matchTabForOrigin` (`tabKey` -> fallback po agencie -> `null`).
- **Pierwszeństwo ma user.** W `set_generating(false)` najpierw leci istniejąca kolejka
  wiadomości usera, a dren wyniku suba odpala się TYLKO, gdy kolejki nie było. Po Stopie/
  watchdogu drenu nie ma - wynik czeka do końca następnej tury albo do przełączenia zakładki.
- **`send_message({injectedText, meta})`** przy `injectedText` NIE rusza pola wpisywania (user
  może mieć własny szkic), nie zjada załączników ani wzmianek, nie parsuje markerów
  `@@skill:` (treść wyniku suba to nie polecenie) i nie wchodzi w komendy `/`. Powiadomienie
  jest trwałe - leci przez `appendToActiveSession` jak każda wiadomość usera, więc przeżywa
  restart Obsidiana. Treść składa `chat/subTaskNotification.ts`
  (`buildSubTaskNotificationText`): nagłówek, stan po ludzku + czas, wynik przycięty do
  `subagent_result_max_chars` (default 60000, `0` = bez limitu) ALBO błąd, stopka każąca modelowi
  podjąć wątek.
- ⚠️ **Kolejka `pending` notifiera żyje w RAM** (`modules/sub-agents/SubTaskNotifier.js`) - nie
  przeżywa restartu Obsidiana. Zamknięcie czatu jest bezpieczne (wyniki czekają do ponownego
  otwarcia); restart aplikacji gubi niedostarczone wyniki (i same biegi - suby nie są
  wznawialne).
- ⚠️ **Notifier trzyma JEDNEGO dostawcę.** Przy dwóch otwartych widokach czatu wygrywa otwarty
  jako ostatni; zamknięcie któregokolwiek robi `setDeliverer(null)` dla obu (wyniki nie giną,
  zostają w kolejce).
- ⚠️ **Serializacja stoi na `_subTaskTurnPending`.** `drain()` woła dostawcę w pętli, a
  `send_message` dochodzi do `set_generating(true)` dopiero po kilku `await` - bez tej flagi
  drugi czekający wynik wystartowałby równoległą turę na tej samej zakładce.
- Auto-tura może zlecić kolejne suby (zamierzone - "podejmij wątek"), więc łańcuch
  tło→powiadomienie→tura→tło może się ciągnąć; hamulcem jest bramka `max_parallel_delegations`
  (patrz `modules/tools/CLAUDE.md`) obok sufitu łańcucha wyżej.

### Pasek biegów subów w oknie czatu

Biegi subów lecą per agent i per sesja, więc podgląd nie należy do globalnego sidebara, tylko
do okna czatu, z którego user je zlecił.

- `chat_ui.render_view` montuje kontener zaraz po pasku zakładek, nad ciałem wiadomości.
  Render: `chat/subTaskStrip.ts` (obsidian-free DOM), model: `buildStripModel` z barrela
  `modules/sub-agents`.
- Chipy (kryształ statusu z pulsem dla biegnących, nazwa, czas trwania) dla biegów TEJ
  zakładki. Klik rozwija jeden szczegół: status po ludzku, liczniki kroków/narzędzi, ostatnie
  kroki, skrót wyniku/błędu, dla biegu w toku guzik Stop (`registry.requestStop`). Nie ma pola
  "wiadomość do suba" - komunikacja z subem należy do agenta.
- Filtr per zakładka: bieg z `origin.tabKey` trafia do swojej zakładki, bieg bez adresu (spoza
  czatu) - do zakładki tego samego agenta. Pusty model = zero wysokości.
- Live: subskrypcja `plugin.subTaskRegistry.events` z debounce ~250 ms, wpięcie w `onOpen`
  obok dostawcy wyników, odpięcie w `onClose`. `_switchTab` przerysowuje pasek i zwija
  szczegół (biegi są per zakładka).
- ⚠️ **Stan rozwinięcia musi żyć poza DOM-em** (pole na `ChatView`, nie klasa CSS) - pasek
  przerysowuje się na każdym kroku suba, więc szczegół trzymany tylko w DOM-ie znikałby co
  kilka sekund. Rozwinięcie biegu, który wypadł z listy, jest gaszone; pole tekstowe czatu i
  jego focus NIE są dotykane przez przerysowanie paska.

### Pasek dolny: input vs todo, zachowanie szkicu

Slot paska ma DWA widoki w jednym obrysie: `'input'` (textarea) albo `'todo'` (lista zadań w
miejscu textarea). Dolny rząd guzików (wyślij/stop, spinacz, mikrofon, autonomia) widoczny w
OBU. Decyzję "który widok" podejmuje pure `resolveBottomBarMode(prev, next, current, hasDraft)`
(`chat/todoPanel.ts`): pojawienie się listy = auto-przeskok na `'todo'`, ale **nie**, gdy w polu
siedzi nieukończony szkic usera (auto-przeskok chowałby cały wiersz inputu i szkic znikałby z
oczu, mimo że wartość textarea była nietknięta); zniknięcie listy = powrót na `'input'`; update
itemów w trakcie życia listy nie rusza widoku - ręczny wybór usera (chip `📋 done/total`)
zostaje. `ResizeObserver` na pasku (który jest `position:absolute` nad wiadomościami) rezerwuje
pod niego miejsce (`paddingBottom`), z CSS fallbackiem dla środowisk bez `ResizeObserver`.

Kolejka wiadomości ma osobną ochronę szkicu: `set_generating(false)` odkłada szkic napisany PO
zakolejkowaniu (`_draftAfterSend`) i oddaje go w `send_message` zaraz po zresetowaniu pola -
restore musi być tam, nie w oddzielnym `setTimeout`, bo `resetInputArea` leci dopiero po
awaitach `send_message` i zjadłby wcześniejszy restore.

### Cykl życia sesji w zakładce

- **Zamknięcie zakładki czeka na zapis.** `_closeActiveTab` jest `async` i `await`-uje
  `handleSaveSession()` przed usunięciem stanu zakładki i przełączeniem - fire-and-forget
  zapis równolegle z przełączeniem potrafił trafić do pliku już przełączonego agenta albo
  zgubić ostatnie wiadomości. Pad zapisu jest łapany (`log.warn`) - zakładka zamyka się mimo
  wszystko.
- **Gałąź "odrzuć" w modalu zamknięcia sesji** sprząta starą sesję przez
  `AgentMemory.discardActiveSession()`: plik idzie do `sessions/active/.discarded/`, wpis znika
  z aktywnych sesji. Bez twardej kasacji. `handleNewSession` ma dziś dwie gałęzie: `archive`
  (-> konsolidacja) i `discard`.
- **Akcja `archive` (bez sufiksu) czyści WSZYSTKIE cztery pola tożsamości sesji zakładki**
  (`sessionPath`/`sessionId`/`sessionName`/`sessionLabel`), nie tylko `sessionPath` - bo
  `_tabKey` sprawdza `sessionId || sessionPath || sessionName || agentName` i wiszące pole
  inne niż `sessionPath` zostawiałoby zakładkę wskazującą na już-zarchiwizowany plik przy
  każdym powrocie na nią. Nowa sesja powstaje leniwie, przy pierwszym kolejnym zdarzeniu, jak
  dla świeżej zakładki. Warianty `archive_new` (od razu nowa sesja) i `archive_close` (zamknij
  zakładkę) mają własną, jawną obsługę tych samych pól.

### Rozliczanie tokenów: estymaty oznaczone jako przybliżone

Fallback zliczania tokenów (gdy API nie oddało `usage` - dotyczy zarówno subów bez zwrotki
kosztu, jak i głównej pętli w gałęziach, które nigdy nie widziały prawdziwej odpowiedzi API)
zawsze niesie `estimated: true` do `tokenTracker.record(role, in, out, {estimated})`. Token
Viewer pokazuje wtedy prefiks `~`/"przybliżone" zamiast udawać pomiar z API. `TokenTracker` ma
flagę `estimated` per rola + `hasEstimates(role)`.

`RollingWindow.getBreakdown()` liczy koszt pamięci/skilli jako część `system_prompt` (nie ma
osobnych warstw dla nich) - `TokenViewerWidget` pokazuje tylko `system_tools` +
`mcp_tools_active`, jedyne warstwy realnie zasilane danymi.

### Ratunek pamięci przy kompresji okna

Kompresja kontekstu może uratować trwałe fakty jednym wywołaniem LLM. `Summarizer.getSummaryPrompt`
prosi model o opcjonalny blok kandydatów (0-3, z dedupem względem indeksu `brain.md`) obok
streszczenia; `chat/memoryCandidates.ts` (pure) odcina ten blok od streszczenia i waliduje typy.
Zapis idzie do POCZEKALNI (`brain/pending_rescue/` w `modules/memory`, patrz
`modules/memory/CLAUDE.md`) przez `turnOwner.saveMemoryCandidatesFor` (`AgentMemory.writePendingRescue`)
- review i accept/reject dzieją się w modalu zapisu sesji, nie automatycznie. Fail-soft: pad
zapisu poczekalni spada na bezpośredni zapis notatki (lepszy niezreview'owany zapis niż utrata
faktu). Bramka per agent: `activeAgent.memory_rescue === false` wyłącza cały mechanizm (default
ON). `RollingWindow` sama NIE pisze do pamięci - `onMemoryCandidates` to fire-and-forget
callback wstrzykiwany z `chat_session._createRollingWindow`, nie blokuje kompresji.

Prompt kompresji jest per-agent, override'owalny: stały szkielet
(`DEFAULT_COMPRESSION_PROMPT`, `config/default_prompts.js`, placeholdery
`{{DYNAMIC_HEADER}}`/`{{CONVERSATION}}`/`{{EMERGENCY_SECTION}}`/`{{SESSION_PATH}}`) idzie przez
`resolveWorkPrompt(activeAgent, 'compression_prompt', settings, DEFAULT_COMPRESSION_PROMPT)`
(łańcuch agent>global>factory). Sentinel bloku kandydatów MUSI przeżyć override - Settings→Prompt
ostrzega przy polu.

### Reload skilli po zapisie pliku skilla

`_chatOnToolResults` reaguje na `toolCall.name === 'write' || 'vault_write'` (obie nazwy -
aliasy narzędzi rebindują lokalną zmienną w `MCPClient.executeToolCall`, więc obiekt widziany
przez hooki czatu może dalej nieść starą nazwę, jeśli model jej użył) z `path` zaczynającym się
od `.pkm-assistant/skills/**`: odpala `agentManager.reloadSkills()` i odświeża render guzików
skilli. Ta sama zasada dotyczy KAŻDEGO hooka czatu porównującego `toolCall.name` z nazwą
narzędzia, które ma alias.

### Watchdog vs test bez `ChatView`

`chat_streaming.ts`, `chat_ui.ts`, `chat_model.ts`, `chat_popovers.ts`, `chat_session.ts` i
`chat_tabs.ts` importują `obsidian` i nie są importowalne w AVA (node). Cała logika decyzyjna
wymieniona wyżej dlatego żyje w czystych plikach obok (patrz sekcja "Pattern: prototype mixin").
Strażnik "po źródle" (regex nad plikiem z `obsidian`) pilnuje wyłącznie OKABLOWANIA - że dana
funkcja jest wołana, z odpowiednim kształtem warunku (`if (!x.allowed)` z negacją, który
argument leci gdzie) - nie samej obecności identyfikatora, bo taki test nie odróżnia poprawnej
gałęzi od takiej, która zachowuje napis, a kasuje skutek.

Harness end-to-end (`lib/runTurn.ts` w repo harnessu) składa produkcyjne kawałki BEZ
`ChatView` - nie pokrywa więc mechanizmów, które wymagają realnego widoku i wielu zakładek
(np. zamrożenie właściciela tury czatu przy przełączeniu zakładki); pokrywa sąsiednią warstwę,
własność BIEGU SUBA.

---

## Powiązane

- [`modules/memory/CLAUDE.md`](../memory/CLAUDE.md) - `AgentMemory` (przez agentManager),
  `RollingWindow`/`Summarizer` są lokalne w chat mimo że koncepcyjnie żyły kiedyś w memory;
  format pliku aktywnej sesji, `brain/pending_rescue/`
- [`modules/artifacts/CLAUDE.md`](../artifacts/CLAUDE.md) - chat renderuje Plan + Todo z
  artefaktów
- [`modules/agent-loop/CLAUDE.md`](../agent-loop/CLAUDE.md) - `runAgentLoop`, backstop, Stop w
  trakcie finalnego strzału
- [`modules/sub-agents/CLAUDE.md`](../sub-agents/CLAUDE.md) - `SubTaskRegistry`,
  `SubTaskNotifier`, `postMessage`/`requestStop`
- [`modules/tools/CLAUDE.md`](../tools/CLAUDE.md) - `DelegateTool`, `max_parallel_delegations`,
  timeouty narzędzi
