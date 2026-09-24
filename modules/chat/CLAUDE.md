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
├── chat_view.js                   # ChatView (Obsidian ItemView), koordynator. `displayText` to getter przez `t('chat.view_title')` („Czat"/„Chat") - napis „PKM Assistant" powtarzał się z widokiem notatek wydania i dawał w palecie dwa identyczne wpisy (paleta dokleja nazwę pluginu sama)
├── consolidationRunner.js         # kontroler przebiegu konsolidacji pamięci (klej memory ↔ modal/pasek/notice)
├── SaveSessionModal.js            # `/save session` - review propozycji notatek brain/
├── saveSessionSectionLabel.js     # etykieta sekcji brain.md w oknie review w JĘZYKU UI (adres w PLIKU zostaje - `sectionKeyOf` z `modules/memory` rozpoznaje OBA zestawy nagłówków, PL i EN, więc agent z brain.md w dowolnym z dwóch języków dostaje etykietę w bieżącym języku interfejsu; tu tylko nazwa dla oczu usera); pure, test obok
├── naTerazUpdate.js               # normalizacja sekcji `BrainUpdate` ("Na teraz") do klucza API 'user'/'environment' + etykieta w oknie review - patrz gotcha niżej; pure, test obok
├── SessionCloseModal.js           # zamknięcie sesji - archive / discard
├── OpenSessionModal.js            # otwórz starą sesję - continue / compress / fresh
├── ConsolidationProgressModal.js  # nieblokujące okno PRZEBIEGU konsolidacji
├── archiveReviewRenders.js        # rendery review (dedup + L1/L2/L3) pod modal przebiegu; badge typu notatki (kolumna scaleń) idzie przez `memoryNoteTypeLabel` (etykieta TYLKO do wyświetlenia - `merge.target_type` w danych zostaje surowym adresem dla `modules/memory`)
├── memoryNoteTypeLabel.js         # etykieta UI dla typu notatki pamięci (user/agent_rule/skill_hint/project_context/reference) w JĘZYKU UI; pure, test obok
├── consolidationRunState.js       # czyste decyzje modalu (isRunStuck/resolveStepDraft) + test
├── slash-commands/                # definicje komend slash (save_session.js)
└── chat/                          # mixiny (prototype) + helpery/rejestry
    ├── chat_streaming.js          # streaming tokenów + force-trigger injection + twardy backstop pętli
    ├── chat_ui.js                 # render UI elementów + popup `/`
    ├── chat_messages.js           # render messages, history + compact tool chips
    ├── chat_artifacts.js          # panel Artefaktów v2 + guzik delegacji
    ├── chat_model.js              # model selection, multimodal handling
    ├── chat_session.js            # session save/load/restore (z `modules/memory/`) + _createRollingWindow
    ├── chat_tabs.js                # multiple chat tabs, tożsamość zakładki (`_tabKey`)
    ├── chat_popovers.js            # agent popovers, context menus
    ├── chatViewShape.js            # TYP złożonego widoku (`ChatViewLike`) + kształty pluginu/zakładek; plik type-only
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
    ├── compressionPrompt.js        # czysty re-export z `config/default_prompts.js` (tam mieszka `defaultCompressionPrompt()`) - lokalne drzwi dla wnętrza czatu
    ├── memoryCandidates.js         # parser bloku MEMORY_CANDIDATES z odpowiedzi Summarizera
    ├── subTaskNotification.js      # treść powiadomienia o wyniku suba z tła + matchTabForOrigin (pure, testowalny)
    ├── machineMessage.js           # klasyfikator wiadomości maszynowych (spec A3) - classifyMachineMessage + buildMachineView; pure, zero obsidian, testowalny
    ├── machineTile.js               # render współdzielony kafelka wiadomości maszynowej (renderMachineTile) - wołany przez chat_messages.js I chat_streaming.js; obsidian przechodnio przez barrel ui-components, testowalny w AVA z atrapą harnessu
    ├── agentCrystal.js              # `agentCrystalCssVar(agent, color)` - wartość CSS `--cs-agent-crystal` (data URL SVG kryształu), jeden producent dla append_message/render_messages I `_ensureAgentMessageContainer` (kolumna dymków, 2.3.0); trzeci plik jak machineTile.js, żeby nie zamknąć cyklu między dwoma mixinami
    ├── connectorActivity.js         # `_scheduleConnectorRedraw`/`_cancelConnectorRedraw` (przeniesione z chat_ui.js) + `onMessagesContainerActivity`/`installMessagesContainerActivity` (nasłuch rozwinięcia kafelka → przerysowanie łącznika); czwarty plik mixina chat_ui.js, poza jego importem `chat_view.css` (moduł CSS, którego Node/AVA nie ładuje) - stąd testowalny bezpośrednim importem
    ├── subTaskStrip.js             # pasek biegów subów POD zakładkami czatu; obsidian-free DOM, model z modules/sub-agents
    ├── selectionMenu.js            # menu na zaznaczeniu tekstu (2.3.0, spec D) - Kopiuj / Dodaj jako kontekst / Cytuj; quoteText/insertAtCursor pure+testowalne, installSelectionMenu montuje nasłuchy na messages_container
    ├── SlashCommandsRegistry.js    # rejestr komend `/`
    ├── ToolReactorRegistry.js      # plug-in reaktory na tool results
    ├── TokenViewerWidget.js        # donut + pop-over Token Context Viewer
    ├── TokenViewerUtils.js         # helpery obliczeń dla Token Viewera
    ├── ToolTokenCache.js           # cache countTokens(JSON.stringify(tools)) per agent
    └── TriggerPopup.js             # popup WYŁĄCZNIE `/`, sekcje Slash / Skille / Sub-Agenty / MCP (zewnętrzne)
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
`defaultCompressionPrompt()` NIE jest w barrelu - mieszka w `config/default_prompts.js`,
Settings→Prompt bierze ją wprost stamtąd; lokalne drzwi `chat/compressionPrompt.js` zostają
dla wnętrza modułu (Summarizer, turnOwner). Singleton `StreamingManager` i `RollingWindow`
też nie wychodzą przez barrel - żyją i są używane wewnątrz `chat/`.

---

## Wyzwalacze pola czatu: `/` i `@` to DWA NIEZALEŻNE mechanizmy (2.3.0)

Pole wpisywania miało kiedyś dwa popupy otwierające się razem po `@` (`TriggerPopup` i
`MentionAutocomplete`) - naprawione, dziś każdy znak ma DOKŁADNIE jednego właściciela (wyjątek
`/@` opisany niżej - tam TriggerPopup świadomie oddaje pole, zamiast dwóch popupów naraz):

- **`/`** → `TriggerPopup` (`chat/TriggerPopup.ts`, otwierany z `chat_ui.ts`'s
  `_handleTriggerKeyDown`/`_handleTriggerInput`/`_openTriggerPopup`). Cztery sekcje: Slash-komendy
  (`this.slashCommands`), Skille (`agent.allowed_skills`), Sub-agenty (custom suby usera dla
  aktywnego agenta, `getVisibleSubAgentsForAgent`) i MCP - WYŁĄCZNIE narzędzia serwerów
  ZEWNĘTRZNYCH, JEDEN WPIS PER NARZĘDZIE (nie per serwer - naprawa 2.3.0, patrz niżej).
  Dyskryminator MCP jest `tool.source === 'user'` (kanoniczne pole `ToolDefinition.source`,
  `modules/tools/ToolRegistry.ts` - built-in narzędzia mają `source` puste/`'built-in'`, external
  MCP dostaje `'user'` w `ExternalMcpManager._wrapTool`; ten sam dyskryminator, ten sam wzorzec co
  `modules/tools/ConnectorsBackstageTab.ts`'s `groupBuiltinTools`).
- **`@`** → wyłącznie `MentionAutocomplete` (`modules/ui-components/MentionAutocomplete.ts`) -
  notatki i foldery vaulta, własny nasłuch `input`, tag `@[Nazwa]` wstawiany w tekst pola plus chip
  w pasku CHIPÓW POD polem (`_chipBar`, `chat_ui.ts` ok. 212 - powstaje po wierszu textarea, nie
  jest to popup nad polem). `TriggerPopup` w ogóle nie reaguje na `@` jako WYZWALACZ:
  `_handleTriggerKeyDown` otwiera się tylko dla `e.key === '/'`, a `_handleTriggerInput` zamyka
  popup, jeśli znak na pozycji wyzwalacza przestał być `/`. **`/@`** (user otworzył popup `/`,
  potem wpisał `@` jako pierwszy znak FILTRA - trigger sam zostaje `/`): `_handleTriggerInput`
  zamyka TriggerPopup, gdy filtr zawiera `@`, zamiast filtrować pustką - bez tej bramki oba popupy
  stały otwarte naraz (naprawa 2.3.0, niżej opisana razem z resztą).

### Naprawy 2.3.0 (recenzja niezależna commitu 1bb2a846)

- **Enter w otwartym popupie `/` nie wysyła już wiadomości.** `input_area` ma DWA nasłuchy
  `keydown` (`_handleTriggerKeyDown` PIERWSZY, `handle_input_keydown` DRUGI - ten wysyła na Enter
  bez Shift). Gdy popup skonsumuje klawisz, `_handleTriggerKeyDown` woła
  `e.stopImmediatePropagation()`, NIE `e.stopPropagation()` - druga zatrzymuje tylko bąbelkowanie
  do przodków, nie inne nasłuchy NA TYM SAMYM elemencie, więc Enter wybierający pozycję w popupie
  (np. slash-komendę) wysyłał od razu wiadomość zamiast tylko wstawić marker. Wzór:
  `modules/ui-components/MentionAutocomplete.ts`'s `_handleKeyDown` (ten sam problem, ta sama
  naprawa, komentarz przy Enter/Tab).
- **Sekcja MCP listuje NARZĘDZIA, nie serwery.** Wybór serwera dawniej wstawiał
  `@@tool:<serverId>` - żadne narzędzie nie nazywa się samą nazwą serwera, więc marker wskazywał
  narzędzie, którego rejestr nie zna, i model dostawał instrukcję wołania czegoś nieistniejącego.
  `buildItems()` (`TriggerPopup.ts`) dziś dodaje jeden wpis PER NARZĘDZIE zewnętrznego serwera:
  `name` = pełna nazwa z rejestru (`<serverId>__<tool>`, ta sama, którą marker `@@tool:<name>`
  niesie do egzekucji), `label` = czytelna część PO `__` (kosmetyka listy), `description` =
  opis narzędzia (dla external tools już niesie prefiks `[serverLabel] ...` z
  `ExternalMcpManager._wrapTool`, więc serwer zostaje widoczny bez dublowania). Ten sam wzór co
  picker narzędzi serwera w pasku bocznym (`chat_ui.ts`'s `_showMcpToolPicker` - wstawia PEŁNĄ
  nazwę narzędzia jako marker, nigdy samą nazwę serwera). Filtr popupu (`_applyFilter`, szuka w
  `name`+`label`) łapie wpisywanie i nazwy serwera (prefiks w `name`), i nazwy narzędzia bez
  dodatkowej zmiany.
- **Markery wstawiane przez `onSelect` bez zmian**: `@@skill:nazwa`, `@@tool:nazwa`,
  `@sub-agent:nazwa` (`InlineChipPlugin.ts`'s `makeInlineTriggerMarker`) - `@` w tych markerach
  jest częścią SKŁADNI markera wstawianego do tekstu, nie triggerem otwierającym popup; parser
  markerów (`parseInlineTriggers`) i cała reszta pętli tury czytają je bez zmian.

---

## Pattern: prototype mixin

ChatView jest **koordynatorem**, ale logika rozsiana jest po submodułach. Łączenie przez:

```js
import * as messages from './chat/chat_messages.js';
import * as streaming from './chat/chat_streaming.js';
// ... pozostałe

Object.assign(ChatView.prototype, messages, streaming, ...);
```

**Typ `this` mixina to `ChatViewLike` (`chat/chatViewShape.ts`), nie sama klasa.**
`ChatViewLike = ChatView & ChatViewMixins` — klasa (pola z konstruktora, deklarowane jako
`declare x: T`, zero emitu) plus wszystko, co dokładają mixiny (metody ośmiu modułów +
pola budowane w `renderView`). Kształt mieszka w OSOBNYM pliku i jest w całości type-only
z dwóch powodów: deklaracja scalona z klasą tej samej nazwy jest błędem lintera
(`@typescript-eslint/no-unsafe-declaration-merging`), a plik importowany wyłącznie przez
`import type` nie wchodzi do bundla. Nowe pole widoku dopisujesz w JEDNYM z dwóch miejsc:
ustawiane w konstruktorze → `declare` w `chat_view.ts`; dokładane przez mixin → `ChatViewMixins`.

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
- `config/default_prompts.js` (`defaultCompressionPrompt()`, przez `chat/compressionPrompt.js`)
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

### Fallback sekcji "Na teraz" musi być KLUCZEM API, nie nagłówkiem pliku

`SaveSessionModal._normalizeUpdate` domyślał `BrainUpdate.section` na `'## Bieżące'` (nagłówek
`brain.md`), zamiast na klucz API (`'user'`/`'environment'`). To było utwardzenie kontraktu, nie
naprawa żywej utraty danych: jedyny producent `BrainUpdate` to
`SaveSessionWorkflow._parseNaTerazUpdates` (`modules/memory/`), który iteruje literalną tablicę
`['user', 'environment']`, więc `section` zawsze przychodzi jako jeden z tych dwóch kluczy -
stary fallback był w praktyce martwą gałęzią, u userów nic się nie gubiło. Ale gdyby kiedyś
dotarła inna wartość, stary fallback rozjeżdżałby etykietę z zapisem: `_naTerazLabel` i tak
pokazywałby taki wpis jako „Na teraz: User" (fallback = wszystko poza `'environment'`), a zapis
szedłby przez `applyNaTerazOps` (`modules/memory/BrainIndex.ts`), której
`naTerazSectionKey('## Bieżące')` zwraca `null` (nie pasuje do wzorców user/environment) -
`if (!key) continue;` cicho odrzuciłby operację, mimo że etykieta obiecywała zapis pod „User".
Fix: `naTerazUpdate.ts` (`normalizeNaTerazSection`/`naTerazLabel`, pure) jest JEDYNYM miejscem
tej reguły - etykieta i zapis czytają dokładnie tę samą funkcję, więc nie mogą się już rozjechać,
niezależnie od tego, co kiedyś doda kolejny producent; modal jest cienkim wołaczem obu.

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
- **`regenerateLastResponse` wkłada do `input_area.value` TEKST, nigdy surową `content`.**
  `RollingMessage.content` bywa `ContentBlock[]` (wiadomość Z ZAŁĄCZNIKIEM), nie tylko `string`
  - wsadzenie tablicy wprost do pola wpisywania dawało `[object Object]` (BUG C2). Fix to lokalny
  `_joinTextBlocksForInput(content)` (`chat_messages.ts`) - łączy TYLKO bloki `type === 'text'`
  znakiem NOWEJ LINII, string zostaje bez zmian. Świadomie NIE reużywa
  `RollingWindow._contentToTokenText` (silnik liczenia tokenów, kod review #8) - ten łączy
  bloki BEZ separatora (liczy się długość, nie czytelność dla usera), a `RollingWindow.ts` jest
  świadomym monolitem, więc zmiana jego zachowania wymagałaby przeczytania całego pliku i
  ruszyłaby też liczenie tokenów/podgląd wiadomości gdzie indziej. Test:
  `chat/regenerateLastResponse.test.ts`.

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

`startConsolidationRun({plugin, app, agentMemory, agent, model, settings, source, include})` (
`consolidationRunner.ts`) jest jedyną drogą uruchomienia konsolidacji - klej między silnikiem
(`modules/memory`, `runWithRun`/`applyStepDecision`) i widokami (modal, pasek statusu, notice).
Rejestruje przebieg w `memoryOpsCenter`, otwiera modal leniwym `import()` (statyczny import
ciągnąłby `obsidian` do kontrolera, który musi być testowalny node'em -
`consolidationRunner.test.ts` jest w całości `test.serial`, bo centrum operacji to singleton
modułowy). `registerConsolidationModalOpener(app)` jest idempotentne dla tej samej instancji
`app` - inna instancja (dev-reload) odpina starą subskrypcję i zakłada świeżą. Próg dedupu i
`batchSize` liczą się PRZEZ `resolveConsolidationThresholds(state, settings)` (`modules/memory`,
przez barrel) - jedno liczydło zamiast osobnej formuły ad hoc w tym pliku.

- `source: 'auto' | 'manual'` (default `'manual'`) rozróżnia trigger progowy
  (`/save session` i idle-scheduler -> `'auto'`) od guzika w profilu agenta (-> `'manual'`).
  Przy PUSTYM planie `manual` mówi userowi "nie ma czego konsolidować"; `auto` milczy (tylko
  log) - licznik sesji-do-konsolidacji zeruje dopiero realny zapis paczki L1, więc przy mniej
  niż `batchSize` niepokrytych sesji próg jest przebijany przy każdym kolejnym zapisie sesji, a
  głośny notice po każdym `/save session` byłby spamem.
  Guzik "Podsumuj rozmowy" w profilu agenta jest jedynym pozostałym wejściem manualnym -
  drugi, dublujący guzik został wycięty.
- **`include?: {sessions, dedup}` (auto-konsolidacja opcjonalna, 2.2.9)** - które gałęzie planu
  budować, przekazane 1:1 do `buildConsolidationPlan(counts, {include})`
  (`modules/memory/ConsolidationRun.ts`, typ `BuildPlanInclude` = alias `AutoConsolidationInclude`
  z `consolidationStatus.ts`, jeden kształt). Brak (guzik ręczny, `source:'manual'`) = pełny plan,
  zachowanie sprzed tej opcji. `/save session` (`save_session.ts`) podaje
  `include: result.consolidationInclude` - policzone przez `SaveSessionWorkflow.applyDecision`
  → `planAutoConsolidation` (`modules/memory/consolidationStatus.ts`) z DWÓCH wyłączników usera
  w Ustawieniach, oba domyślnie WYŁĄCZONE. `include:{sessions:false, dedup:false}` (domyślna
  instalacja) daje ZAWSZE pusty plan, niezależnie od liczników - `startConsolidationRun` milczy
  jak przy każdym innym pustym planie (`source:'auto'`).
  ⚠️ **Gałąź wchodzi do `include` TYLKO gdy jest i włączona, i „due"** (DECYZJA recenzji
  niezależnej 2026-09-22 - `planAutoConsolidation` w `modules/memory/CLAUDE.md`, sekcja
  „Auto-konsolidacja opcjonalna"): wcześniejsza wersja wpuszczała gałąź do `include` na samej
  polityce, więc odrzucona propozycja L1 (licznik wyzerowany) wracała do planu, gdy tylko próg
  DRUGIEJ gałęzi (brain) się przebił - łamiąc obietnicę „odrzucona propozycja nie wraca".
  **Obrona w głąb**: `source:'auto'` bez jawnego `include` (wołacz zapomniał go przekazać) każe
  `startConsolidationRun` policzyć politykę SAM przez `planAutoConsolidation` - ten sam wynik co
  `SaveSessionWorkflow`, zamiast cicho spaść na pełny plan.
- Plan liczy `archiveCount` z `listUncoveredArchiveSessions()` (sesje BEZ stempla
  `covered_by_l1`) - tym samym źródłem, z którego generator bierze materiał, więc plan nie
  obiecuje paczek, które generator potem odrzuci jako "za mało sesji".
- Koszt (`usage` strzału propozycji, `null` na ścieżce regexowego fallbacku) idzie do `CostLog`
  (`role: 'save-session'` dla `/save session`, `role: 'memory-consolidation'` dla przebiegu) -
  zaraz po udanej analizie, niezależnie od tego, czy user zaakceptuje notatki.
- "Anuluj" w fazie propozycji realnie anuluje: decyzja usera ściga się ze strzałem do modelu
  (`Promise.race`), przegrany strzał dostaje `AbortController.abort()`; pad/zwis nie spada po
  cichu na fallback regexowy - modal pokazuje przyczynę i guzik "Ponów analizę".
- **Wyciszenie po jawnej decyzji usera „nie teraz" dla całego kroku** (auto-konsolidacja
  opcjonalna) - `RunController.skip(stepId)` (guzik „Pomiń") i `RunController.onModalClosed()`
  (krok L1 wciąż `awaiting_review`, gdy user zamyka okno przebiegu bez decyzji) wołają
  `ArchiveWorkflow.onStepRejected(kind, run?)` - ta sama funkcja, którą woła
  `ArchiveWorkflow.applyStepDecision` przy `decision.accepted === false` z modalu review. L1 →
  zeruje `archived_since_last_consolidation` i znaczy `run.meta.consolidationSilenced = true`
  (propozycja nie wraca przy KOLEJNYM zapisie sesji); DEDUP → podbija limit notatek `brain/` PO
  PROGU EFEKTYWNYM (nie po gołym `state.brain_notes_limit` - patrz `modules/memory/CLAUDE.md`,
  `_autoBumpBrainNoteLimit`). `ConsolidationProgressModal.onClose()` woła
  `controller.onModalClosed?.()` fire-and-forget, best-effort, PO `_releaseIfStuck()` - patrz
  `modules/memory/CLAUDE.md`, sekcja „Auto-konsolidacja opcjonalna", po pełne uzasadnienie.
  Test okablowania: `ConsolidationProgressModal.test.ts`.
  - ⚠️ **Podwójny reset (naprawiony).** `run.meta.consolidationSilenced` zapobiega temu, żeby
    zaakceptowanie TEJ SAMEJ paczki L1 PO wyciszeniu (user wraca do żywego przebiegu i mimo
    wszystko klika "Zaakceptuj") zerowało licznik DRUGI RAZ - inaczej sesje zarchiwizowane W
    MIĘDZYCZASIE (spoza tej paczki) by przepadały.
  - ⚠️ **Okno zamknięte W TRAKCIE generowania L1 (nie po fakcie), nie wyciszało NICZEGO.**
    `RunController._windowClosed` pamięta zamknięcie nawet gdy żaden L1 nie jest jeszcze
    `awaiting_review` - `advance()` (ogon KAŻDEJ mutacji: `generate`/`retry`/`applyDecision`/
    `skip`) sprawdza flagę ponownie i wycisza, gdy L1 NAPRAWDĘ dojdzie do `awaiting_review`.
    `RunController.onModalOpened()` (wołane z `ConsolidationProgressModal.onOpen()`) rozbraja
    flagę - user, który wrócił i PATRZY na okno, ma normalną szansę zdecydować.

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

**Reset panelu jest JEDNĄ funkcją, wołaną z DWÓCH miejsc.** `_resetTodoPanelState()`
(`chat_tabs.ts`, eksportowana - nie w barrelu, wewnętrzna dla modułu jak reszta mixinów) zeruje
`_activeTodoState`/`_prevTodoModel`/`_bottomBarMode` i przemalowuje pasek. Wołają ją `_switchTab`
(zmiana agenta - lista jest per agent) i `handleNewSession` (`chat_session.ts`, KAŻDE wyjście
funkcji, nie tylko po modalu - BUG C3: `handleNewSession` kiedyś w ogóle nie czyścił panelu,
więc nowa rozmowa TEGO SAMEGO agenta pokazywała listę zadań sesji, która już poszła do
archiwum/`.discarded/`). Drugi ogon tego samego buga: jednorazowy plik
`.pkm-assistant/artifacts/todo/<agent>-<sessionId>.md` (silnik: `modules/tools`,
`TodoTool.ts`) żyje w OSOBNYM drzewie od `sessions/active/*.md` - przeniesienie sesji do
`.discarded/` go nie dotyka. Gałąź `discard` w `handleNewSession` woła
`retireTodoFile(adapter, agentName, sessionId)` (publiczna furtka `modules/tools/index.js` -
patrz `modules/tools/CLAUDE.md`) z `sessionId` liczonym DOKŁADNIE jak `TodoTool.resolveSessionId`
(basename ścieżki sesji bez `.md`), best-effort (pad sprzątania nie blokuje odrzucenia sesji).
Testy: `chat/handleNewSessionTodoCleanup.test.ts`, `tools/.../TodoTool.test.ts` (`retireTodoFile`).

⚠️ **Wskaźnik zakolejkowanej wiadomości wisi POZA slotem input/todo (2.3.0, spec E "Czat bez
ścian" - werdykt właściciela: "Nie widzę tego").** `_showQueuedIndicator`/`_hideQueuedIndicator`
(`chat_streaming.ts`) montowały wskaźnik jako `input_area.parentElement.appendChild(...)`, czyli
DO ŚRODKA `_inputRow` - gdy pasek jest w trybie `'todo'`, `_applyBottomBarMode` (wyżej) dokłada
`_inputRow`-owi `is-hidden`, więc wskaźnik znikał razem z polem. Fix: `_showQueuedIndicator`
wstawia wskaźnik do `_chipBar.parentElement` (`bottomPanel`, ten sam kontener co `_chipBar`
sam - NIGDY nie dostaje `is-hidden` z `_applyBottomBarMode`), tuż PRZED `_chipBar`
(`insertBefore`) - widoczny w OBU trybach slotu. `_hideQueuedIndicator` bez zmian semantyki
(`.remove()` + zerowanie uchwytu). Test: `chat/todoPanel.test.ts` (real DOM przez fabrykowany
`this`, z lokalną atrapą globalnego `createDiv`/`createSpan` - atrapa z preloadu harnessu NIE
śledzi `parentElement`/kolejności `insertBefore`, patrz komentarz w teście).

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
- ⚠️ **DWIE drogi kończą sesję i OBIE gasi `SessionWriteConsent` dla ścieżki, która WŁAŚNIE się
  kończy** - `handleNewSession` (ten plik) łapie `activeMemory.activeSessionPath` PRZED
  archive/discard/`startNewSession()` i woła
  `plugin.mcpClient?.sessionWriteConsent.clearSession(tamtaŚcieżka)` tuż przed wymianą tożsamości;
  `modules/chat/slash-commands/save_session.ts`'s `applyPostArchiveAction()` (`/save session`)
  robi TO SAMO dla WSZYSTKICH trzech wariantów (`archive`/`archive_new`/`archive_close`) - jedno
  wołanie na wejściu funkcji, ze ścieżką złapaną PRZED `workflow.applyDecision()` (czyli przed
  `archiveActiveSession`, które dla plain `archive` samo zeruje `activeSessionPath` - odczyt PO
  fakcie dawałby już `null`). Powód obu: nazwa pliku sesji ma rozdzielczość MINUTOWĄ i po
  archive/discard WRACA DO PULI - bez czyszczenia druga „nowa rozmowa" tego samego agenta w tej
  samej minucie mogłaby dostać tę samą nazwę i odziedziczyć cudzą zgodę „nie pytaj więcej".
  `_closeActiveTab` świadomie tego NIE robi (nie przenosi pliku, więc ścieżka nie wraca do puli).
  Pełne uzasadnienie: `modules/tools/CLAUDE.md`, gotcha "Zgoda na zapis". Testy:
  `chat/chat_session.test.ts`, `slash-commands/save_session.archiveNewConsent.test.ts`.
- ⚠️ **`_restoreActiveSession` MUSI przekazać `tool_call_id`/`tool_calls` jako TRZECI argument
  `RollingWindow.addMessage()`.** Bug (2026-08-09): po restarcie Obsidiana odtworzona sesja
  gubiła `tool_call_id` KAŻDEGO wyniku narzędzia sprzed restartu - `sanitizeToolTranscript`
  (`modules/agent-loop`) widział `tool` message bez id i kasował go jako sierotę (log
  `drop orphan tool message (tool_call_id="undefined")`). Root cause był DWUCZĘŚCIOWY:
  (1) `activeSessionFormat.ts` (format v2, `modules/memory`) nie miało gdzie zapisać
  `tool_call_id`/`tool_calls` w ogóle - naprawione formatem v3 (pola `**tool_call_id:**`/
  `**tool_calls:**`, patrz `modules/memory/CLAUDE.md`, "Sesje aktywne"); (2) NAWET po naprawie
  czytnika, `_restoreActiveSession` wołało `addMessage(msg.role, msg.content)` bez trzeciego
  argumentu - `parsed.messages[i].toolCallId`/`toolCalls` (kiedy obecne) muszą jechać dalej do
  `RollingWindow`, inaczej odczytane dane i tak giną na ostatnim kroku. Test:
  `chat/chat_session.test.ts` (`BUG C1`).
- ⚠️ **`render_messages` pomija `assistant` bez treści DO POKAZANIA, nie bez treści.**
  Wiadomość z pustym `content` renderuje się jak dotąd, gdy niesie `tool_calls` (chip
  narzędzia) albo `reasoning_content` (blok myślenia) - dopiero brak WSZYSTKICH trzech
  (content/tool_calls/reasoning_content) pomija render całego bubla. Bez tej bramki
  restore po naprawie `BUG C1` potrafił namalować pusty `.cs-message--agent` (sam rząd akcji
  kopiuj/usuń/kciuki na pustej treści) dla wiadomości, której plik miał `**tool_calls:**`, ale
  JSON się nie sparsował (`parseSessionToolCalls` → `null`, kod review MINOR #4). Test:
  `chat/render_messages.emptyAssistant.test.ts` (mierzy realne dzieci DOM-u atrapy harnessu,
  nie sam fakt wywołania).

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
(`defaultCompressionPrompt()`, `config/default_prompts.js`, placeholdery
`{{DYNAMIC_HEADER}}`/`{{CONVERSATION}}`/`{{EMERGENCY_SECTION}}`/`{{SESSION_PATH}}`) idzie przez
`resolveWorkPrompt(activeAgent, 'compression_prompt', settings, defaultCompressionPrompt())`
(łańcuch agent>global>factory). Sentinel bloku kandydatów MUSI przeżyć override - Settings→Prompt
ostrzega przy polu.

⚠️ **Szkielet ORAZ dynamiczna główka idą za JĘZYKIEM INTERFEJSU (2.2.5) i liczą się leniwie.**
Szkielet ma wersję PL i EN w `config/default_prompts.ts` (stała nie umie być leniwa, dlatego to
funkcja), a kawałki sklejane w `Summarizer.getSummaryPrompt` (poprzednie podsumowanie, indeks
brain.md, wiadomości usera, użyte narzędzia, kontekst zadania, ostrzeżenie awaryjne, stopka
ścieżki sesji) idą przez klucze `summarizer.*` w i18n. `Summarizer` trzyma pusty
`compressionPrompt` gdy nie dostał override'u i sięga po fabrykę DOPIERO w `getSummaryPrompt` -
wybór przy konstrukcji obiektu zamroziłby język na czas życia okna. **Numeracja sekcji musi się
zgadzać w obu językach**: szkielet daje `## 1`-`## 8`, a sekcja awaryjna
(`summarizer.emergency_section`) wpina się jako `## 9`. Strażnik:
`modules/chat/chat/compressionPrompt.test.ts` (parytet placeholderów z listą literalną, sentinel
w obu językach, `## 8` + `## 9` w obu językach).

### Reload skilli po zapisie pliku skilla

`_chatOnToolResults` reaguje na `toolCall.name === 'write' || 'vault_write'` (obie nazwy -
aliasy narzędzi rebindują lokalną zmienną w `MCPClient.executeToolCall`, więc obiekt widziany
przez hooki czatu może dalej nieść starą nazwę, jeśli model jej użył) z `path` zaczynającym się
od `.pkm-assistant/skills/**`: odpala `agentManager.reloadSkills()` i odświeża render guzików
skilli. Ta sama zasada dotyczy KAŻDEGO hooka czatu porównującego `toolCall.name` z nazwą
narzędzia, które ma alias.

### Watchdog vs test bez `ChatView`

`chat_streaming.ts`, `chat_ui.ts`, `chat_model.ts`, `chat_popovers.ts`, `chat_session.ts` i
`chat_tabs.ts` importują `obsidian`. Historycznie żaden z nich nie dawał się zaimportować w AVA
(node), bo AVA nie miało dla `obsidian` atrapy. **Od atrapy `obsidian` w harnessie (2026-09-11,
`test-support/register-obsidian-for-ava.mjs`) to już nieprawda dla `chat_session.ts`** -
`chat/chat_session.test.ts` go importuje wprost i woła `_restoreActiveSession` na sfabrykowanym
`this` (patrz gotcha "Cykl życia sesji w zakładce" wyżej, `BUG C1`). Reszta listy nie została
ponownie sprawdzona po tej zmianie w atrapie - traktuj ich niedostępność jako niepotwierdzoną,
nie jako pewnik, zanim ktoś realnie spróbuje. Cała logika decyzyjna
wymieniona wyżej i tak żyje w czystych plikach obok (patrz sekcja "Pattern: prototype mixin") -
ten wzorzec zostaje niezależnie od tego, co dziś da się zaimportować wprost.
Strażnik "po źródle" (regex nad plikiem z `obsidian`) pilnuje wyłącznie OKABLOWANIA - że dana
funkcja jest wołana, z odpowiednim kształtem warunku (`if (!x.allowed)` z negacją, który
argument leci gdzie) - nie samej obecności identyfikatora, bo taki test nie odróżnia poprawnej
gałęzi od takiej, która zachowuje napis, a kasuje skutek.

Harness end-to-end (`lib/runTurn.ts` w repo harnessu) składa produkcyjne kawałki BEZ
`ChatView` - nie pokrywa więc mechanizmów, które wymagają realnego widoku i wielu zakładek
(np. zamrożenie właściciela tury czatu przy przełączeniu zakładki); pokrywa sąsiednią warstwę,
własność BIEGU SUBA.

---

### Kafelki Tile w streamie i w historii (2.3.0, "Czat bez ścian")

`ThinkingBlock`/`ToolCallDisplay`/`SubAgentBlock` (`modules/ui-components/`) i bloki systemowe
błędu streamu (ten moduł) renderują się WSZYSTKIE jako kafelek `.cs-tile` przez `createTile` (A1
+ A2 komplet - zero DOM-u `.cs-action-row` produkowanego gdziekolwiek w repo od A2) - patrz
`modules/ui-components/CLAUDE.md`, sekcja "Tile", dla kształtu i decyzji projektowych. Kilka
miejsc w TYM module dotyka to bezpośrednio:

- **Finalizacja bloku myśli.** `chat_streaming.ts` woła `finalizeThinkingBlock(this._currentThinkingBlock)` w CZTERECH miejscach (koniec naturalny w `_finalizeTurn`, backstop przed
  kontynuacją w `_chatBeforeContinue`, Stop w `stop_generation`, błąd w `handle_error`) zamiast
  dawnego gołego `classList.remove('streaming')` - kolejność względem `this._currentThinkingBlock = null` i `_resetPaintTargets()` zostaje bez zmian (strażnik po źródle:
  `chat/renderThrottle.test.ts`, test "bonus: handle_error zeruje blok myśli...").
- **Aktualizacja chipa narzędzia I bloku sub-agenta w trakcie streamingu idzie PRZEZ PEŁNE
  PRZEBUDOWANIE**, tak jak przed Tile: `_chatOnToolResults` (`chat_streaming.ts`) woła
  `toolDisplay.replaceWith(createCompactToolChip({...nowyStatus}))` (albo
  `createToolCallDisplay`, zależnie od `compactToolChips`) dla narzędzi, i analogicznie
  `toolDisplay.replaceWith(createSubAgentBlock({...}))` dla delegacji (cztery gałęzie: błąd
  transportu, pokwitowanie w tle, sukces, `!result.success`) - ani `ToolCallDisplay.ts`, ani
  `SubAgentBlock.ts` NIE trzymają `TileHandle` po zwróceniu elementu, więc nie ma tu mutacji w
  locie do zachowania. Strażnik po źródle (okablowanie, nie zachowanie): `subAgentBlockStatus.test.ts`.
- **Błąd streamu i cisza modelu (A2) renderują kafelek `system` zamiast dymka agenta.**
  `handle_error`/`_onStreamStall` budują go przez lokalny `_buildStreamErrorTile(titleKey, safeText)`
  (`role:'system'`, `status:'error'` - kolor DARMO przez `Tile.ts`, jedna zmienna CSS koloruje
  ikonę i kropkę na czerwono, zero osobnej logiki koloru tutaj). `handle_error`: gdy
  `current_message_container` istnieje (tura miała już zaczęty strumień) - kafelek ląduje W NIM,
  po wyczyszczeniu `current_message_text` (żeby nie zostawić martwego, pustego dymka OBOK); bez
  niego (błąd przed pierwszym chunkiem) - kafelek idzie prosto do `messages_container`, tak jak
  dziś dymek. Logika `ownerTabKey`/karta w tle/`set_generating(false)`/`_cleanupAskUser`
  NIETKNIĘTA - zmienił się TYLKO render. **Regula nadrzedna szczegolow kafelka (A2-fix):**
  `_buildStreamErrorTile` daje `details` TYLKO gdy `safeText` jest DŁUŻSZY niż to, co mieści
  nagłówek (`truncatePreview`, 80 zn.) - krótki błąd (typowy dla obu testowych fixture'ów w
  `handleError.tile.test.ts`) zostaje bez `details`/`is-toggleable`, cała treść już widoczna w
  nagłówku. Behawioralny test: `handleError.tile.test.ts` (patrz gotcha "`handle_error` DA SIĘ
  zaimportować i wywołać w AVA" niżej), pokrywa oba warianty (krótki i długi tekst).
- **Pokwitowanie delegacji zleconej w tle ma JEDNĄ funkcję receipt, żywą i historyczną.**
  `buildBackgroundReceiptText(startedList, queued)` (eksport z `chat_streaming.ts`, uwaga 5
  spec A2-fix) skleja linie details POD skrótem zadania: ewentualne "W kolejce: N" (tylko gdy
  `queued > 0`), potem identyfikator KAŻDEGO wystartowanego zadania, ZAWSZE jako linie OSTATNIE
  (werdykt właściciela: identyfikator nigdy w nagłówku). Wołana z DWÓCH miejsc: `_chatOnToolResults`
  (żywa gałąź `result.started === true`) ORAZ `chat_messages.ts`'s `render_messages` (uwaga 10,
  spec A2-fix - delegacja w tle odtworzona z HISTORII, `tcOutput.started === true`, dawniej
  renderowała się jak zielony wynik z samym "Zadanie", bo ta gałąź w ogóle nie istniała). Test
  czysty na samej funkcji: `chat/backgroundReceipt.test.ts`; okablowanie obu wołaczy:
  `subAgentBlockStatus.test.ts` (2 wywołania `createSubAgentBlock` w `chat_messages.ts` - wynik
  + pokwitowanie w tle, każde z własnym `status:`).
- **`_drawConnectorLines` (`chat_messages.ts`) zostaje na PODWÓJNYM selektorze `.cs-action-row,
  .cs-tile`, mimo że pierwsza rodzina nie ma już żadnego producenta.** Świadomie NIEUSUNIĘTY -
  obrona, nie martwy kod: gdyby coś kiedyś znów wystawiło `.cs-action-row`, łącznik dalej by go
  złapał. Dokładasz kolejny blok na Tile → nic tu nie trzeba zmieniać, selektor już łapie
  `.cs-tile`; dokładasz NOWĄ rodzinę DOM-u (żadną z tych dwóch) → dopisz ją tu też.

**⚠️ `handle_error` DA SIĘ zaimportować i wywołać w AVA** (zweryfikowane empirycznie przy A2, patrz
`handleError.tile.test.ts`) - poprawka nieścisłości do gotchy "Pattern: prototype mixin" wyżej,
która mówi o `chat_streaming.ts` jako CAŁOŚCI jako niemożliwym do zaimportowania w AVA. Ta gotcha
zostaje prawdziwa dla ścieżek, które REALNIE dotykają `MarkdownRenderer`/`Notice` w trakcie
wykonania (streaming markdown, powiadomienia) - `handle_error` żadnego z nich nie woła, więc
atrapa `obsidian` z repo harnessu wystarcza, żeby zaimportować CAŁY moduł (import statyczny
`MarkdownRenderer`/`Notice` na górze pliku sam w sobie nie wybucha) i wywołać tę jedną, gołą
funkcję `.call(fakeThis, ...)` - dokładnie jak `render_messages` z `chat_messages.ts`. Atrapa
`document` globalna z harnessu (`dom-shim.ts`) ma `classList` jako CAŁKOWITY no-op
(`contains()` zawsze `false`) - do weryfikacji KLAS wyrenderowanego kafelka trzeba, jak w
`modules/ui-components/*.test.ts`, podstawić WŁASNĄ, minimalną atrapę `document` (patrz
`handleError.tile.test.ts` dla wzorca). Inne funkcje tego pliku (np. te dotykające
`MarkdownRenderer.render` w trakcie renderu) mogą dalej wymagać strażnika po źródle - nie
zakładaj automatycznie, że KAŻDA funkcja stąd jest testowalna bez sprawdzenia.

### Notatki klikalne wszędzie (2.3.0, spec C "Czat bez ścian")

Kafelek odczytu/wyszukiwania/listy (`ToolCallDisplay.ts`), link po zapisie
(`chat_streaming.ts`, ok. linii 1433) i mencje `@[Nazwa]` w dymku usera (`chat_messages.ts`'s
`_renderUserText`) otwierają notatki JEDNYM mechanizmem: `createNoteLink`
(`modules/ui-components/noteLink.ts`) + rejestr openera. `chat_ui.ts`'s `renderView` rejestruje
opener (`setNoteOpener`) na START renderu - `_openNoteInMain` otwiera ZAWSZE w nowej karcie w
głównym obszarze przez `this.app.workspace.openLinkText(path, '', true)`, nigdy nie podmienia
zawartości panelu czatu. Sprzątania openera w `onClose` NIE ma - decyzja (recenzja C): jeden
rejestr na plugin, opener zależy tylko od globalnego `app`, dwa widoki czatu dzielą slot;
patrz `modules/ui-components/CLAUDE.md`, sekcja "Linki do notatek", dla uzasadnienia
decyzji o tym, dlaczego ten plik nie deep-importuje `core/utils/obsidianNav.ts` mimo
że ma tam równoważną funkcję (`openNoteInMainTab`). Mencje bez odpowiednika notatki w vaultcie
(agent, osoba) zostają zwykłym, nieklikalnym tekstem badge'a - rozwiązanie idzie przez
`this.app.metadataCache.getFirstLinkpathDest(name, '')`, wołane W WIDOKU (ma `app`), nie w
`noteLink.ts` (nie zna `app`).

### Wiadomości maszynowe jako kafelek systemowy (2.3.0, A3 "Czat bez ścian")

Powiadomienie o wyniku suba z tła (`buildSubTaskNotificationText`, `subTaskNotification.ts`) i
przywołanie agenta po interakcji z artefaktem (`buildSummonMessage`, `modules/artifacts/artifactSummon.ts`)
docierają do rozmowy jako `role: 'user'` - werdykt właściciela: "wszystkie powiadomienia
systemowe mają się różnić wyglądem od wiadomości usera, muszą być zwijalne, i nie mogą pokazywać
żadnych technicznych kwestii". **Zasada nadrzędna: treść dla MODELU zostaje identyczna** (obie
funkcje budujące treść - bez zmian, testy przechodzą bez zmian treści) - zmienia się WYŁĄCZNIE
render w oknie czatu: zamiast dymka `.cs-message--user` doklejany jest kafelek `.cs-tile`
(`role:'system'`) przez `createTile`.

- **Klasyfikator** (`chat/machineMessage.ts`, czysty, zero `obsidian`): `classifyMachineMessage`
  + `buildMachineView`. Kolejność **meta-first, treść-fallback**:
  1. Meta na żywo - `addMessage()`/`RollingWindow.addMessage` rozlewa meta na wierzch wiadomości,
     więc `msg._subTaskNotification === true` / `msg._artifactSummon === true` (ten drugi
     znacznik dokłada `artifactSummon.ts` przez `machineMeta({_artifactSummon:true})`, ten sam
     wzorzec co `_subTaskNotification` w `chat_streaming.ts`) rozstrzygają natychmiast. **Meta
     wygrywa w OBIE strony (uwaga 1, spec A3-fix):** `msg.origin === 'human'` zapisany na żywo
     (`HUMAN_MESSAGE_META`) zwraca `null` PRZED fallbackiem po treści, więc człowiek piszący
     tekst, który przypadkiem zaczyna się od tego samego stałego prefiksu nagłówka co
     powiadomienie maszynowe, dostaje zwykły dymek, nie kafelek systemowy.
  2. Treść (fallback) - meta NIE przeżywa zapisu sesji na dysk (`chat_session.ts`'s
     `_restoredMessageMeta` niesie dalej WYŁĄCZNIE `tool_call_id`/`tool_calls`), więc po
     restarcie Obsidiana jedynym dowodem jest STAŁY fragment nagłówka treści, przed pierwszym
     placeholderem - liczony Z i18n (obu języków), nie z zahardkodowanego literału, żeby zmiana
     tekstu nagłówka w `pl.ts`/`en.ts` nie rozjechała się cicho z klasyfikatorem. Po restarcie
     `origin` nie ma jak przeżyć, więc dla tej ścieżki ryzyko fałszywej klasyfikacji po treści
     zostaje (znana, zaakceptowana granica - prawdopodobieństwo niskie).
  Zwykła wiadomość usera (bez meta, bez znanego nagłówka) zawsze daje `null` - `classifyMachineMessage`
  sprawdza `role === 'user'` jako pierwszy warunek.
  ⚠️ **Status suba (`ok`/`error`, tytuł "padł"/"przerwany") czyta WYŁĄCZNIE linię stanu nagłówka**
  (ta, którą `buildSubTaskNotificationText` buduje z `status` przez `meta`/`meta_with_time` -
  `chat.subagent_notification.status_error`/`status_aborted`), NIGDY treść wyniku (B3 fix,
  recenzja A3-fix: stare `.includes()` na CAŁEJ treści dawało fałszywy "padł w tle" i czerwony
  kafelek dla sukcesu, którego wynik tylko CYTOWAŁ frazę błędu, opisując wcześniejszą, już
  naprawioną awarię). `aborted` ma WŁASNY tytuł (`chat.tile.machine.subtask_aborted`), nie dzieli
  "padł w tle" z `error` - oba nadal kolorują kafelek na czerwono.
- **Trzy miejsca renderują, JEDNĄ implementacją** (`renderMachineTile`, `chat/machineTile.ts` -
  trzeci plik w module, uwaga 5 spec A3-fix): `chat_messages.ts`'s `append_message` (żywa
  wysyłka) i `render_messages` (historia), oraz `chat_streaming.ts`'s `_chatBeforeContinue` (dren
  kolejki wiadomości - QUEUE INJECT renderuje bez przechodzenia przez `append_message`, więc musi
  klasyfikować osobno przez `buildMachineView`). Do A3-fix każde z trzech miejsc miało WŁASNĄ
  kopię tej logiki ("argument cyklu importu jest słaby - trzeci plik importowany przez oba
  mixiny nie tworzy cyklu", recenzja A3); `machineTile.ts` jest importowany PRZEZ oba mixiny
  (`chat_messages.ts` ORAZ `chat_streaming.ts`), więc `chat_messages.ts`'s istniejący import
  `buildBackgroundReceiptText` z `chat_streaming.ts` (patrz sekcja "Kafelki Tile w streamie i w
  historii" wyżej) nie tworzy z nim cyklu - `machineTile.ts` sam nie importuje ŻADNEGO z tych
  dwóch mixinów. `machineTile.ts` sam nie importuje `obsidian`, ale ciągnie go przechodnio przez barrel `ui-components`; w AVA działa dzięki atrapie z preloadu harnessu (`machineMessage.ts` jest naprawdę czysty).
  Dokładasz CZWARTE miejsce, które renderuje wiadomość `role:'user'` z pominięciem
  `append_message`? Sprawdź klasyfikację tam też i wołaj `renderMachineTile` stamtąd - inaczej
  wiadomość maszynowa wraca jako goły dymek z surowym JSON-em.
- **Uwaga 7 (spec A3-fix): `...queued.meta` w `_chatBeforeContinue` (QUEUE INJECT) zostaje
  celowo.** `rw.addMessage('user', injectedText, {timestamp, ...queued.meta})` rozlewa CAŁĄ
  meta zapamiętaną przy kolejkowaniu (`chat/queuedMessage.ts`), nie tylko `origin` - powiadomienie
  suba / przywołanie artefaktu wysłane W TRAKCIE trwającej tury trafiają do TEJ SAMEJ kolejki
  (jeden slot, patrz "Kolejka wiadomości" wyżej), więc wiadomość zakolejkowana niesie
  `_subTaskNotification`/`subTaskId`/`_artifactSummon` DOKŁADNIE tak samo jak ścieżka żywa
  (`append_message`). Bez pełnej meta na wierzchu okno traciłoby te znaczniki, a
  `machineMessage.ts` musiałby zgadywać kafelek WYŁĄCZNIE po treści - nawet w TEJ SAMEJ sesji,
  zanim ktokolwiek zapisał ją na dysk (fallback po treści jest pomyślany jako ratunek PO
  restarcie, nie jako droga główna). Tekst dla modelu bez zmian - dotyczy wyłącznie kształtu
  wiadomości w OKNIE.
- **Akcja "Otwórz" na kafelku przywołania artefaktu** (B2 + uwaga 4, spec A3-fix): ścieżka
  notatki jest rozwiązywana PRZY RENDERZE, PRZED budową kafelka (`plugin.artifactStore.read(id)` -
  `renderMachineTile` jest `async`, wołacze już są funkcjami `async`, więc `await` przed
  `createTile` jest tani i deterministyczny - zero migotania przycisku). Sklep zna ścieżkę ->
  przycisk aktywny, klik idzie przez wspólny opener notatek (`openNoteWithRegistry`, jednostka C,
  fallback `plugin.openNote`) i nic więcej (uwaga 4 - **żadnych** skutków
  ubocznych `activateArtifactInChat`, którą stara wersja wołała: bez przypinania artefaktu jako
  aktywnego, bez odsłaniania prawego panelu, bez przełączania widoku czatu - "Otwórz" ma
  otworzyć notatkę, nic więcej). Sklep NIE zna ścieżki (JSON bez `id`, artefakt skasowany między
  wysłaniem powiadomienia a renderem) -> przycisk zostaje WIDOCZNY, ale `disabled`, z tooltipem
  i18n `chat.tile.machine.open_unavailable` (`Tile.ts`'s `TileAction.disabled`/`title`, dodane w
  A3-fix - **poprawka nieścisłości**: wcześniejsza wersja tej notatki twierdziła, że `TileAction`
  nie ma pola `disabled` i jedynym sposobem jest nie renderować przycisku wcale; to było
  nieprawdziwe - `Tile.ts`'s `.cs-tile__actions` jest w `tile.el` od razu, więc wołacz mógł
  ustawić `disabled` bez zmiany `Tile.ts` samego, co A3-fix właśnie zrobił).
- **Details budowane z REALNEJ treści wiadomości**, nie odbudowywane z metadanych - dla
  powiadomienia: wszystko OPRÓCZ pierwszego akapitu (nagłówek, staje się `title`) i OPRÓCZ
  ostatniego akapitu (stopka-instrukcja dla modelu, `chat.subagent_notification.footer` - tekst
  STAŁY bez placeholderów, więc `.endsWith()` jest dokładny w obu językach), OPRÓCZ powtórzonej
  linii stanu na starcie (uwaga 8 - `summary` już ją pokazuje w nagłówku Tile), PLUS identyfikator
  suba jako OSTATNIA linia (uwaga 2 - `chat.tile.sub.background_id`, ten sam klucz i18n co
  pokwitowanie w tle, z meta `msg.subTaskId` albo z drugiej zmiennej nagłówka treści); dla
  artefaktu: sekcje z bloku ```` ```json ```` sparsowane na "✓ tekst"/"○ tekst", BEZ samego bloku
  JSON w widoku. Parsowanie JSON-a zawiedzie ALBO sekcje wypadną puste (uwaga 3, spec A3-fix) =
  details składa się PO LUDZKU z tego, co da się ustalić - `"{tytuł}, {typ}, {status}"`, BEZ `id`
  artefaktu i BEZ frazy akcji DLA MODELU (`"user: {akcja}"` z nagłówka - stary fallback zwracał
  surowy nagłówek w całości, czyli obie te rzeczy user nie ma prawa zobaczyć); brak danych poza
  tytułem -> details to sam tytuł. `id` artefaktu (gdy sklep go zna z samego JSON-a) zostaje
  dostępny OSOBNO w `view.open.artifactId` - fallback details nigdy nie blokuje akcji "Otwórz".

### Dymki 2.3.0 (B, "Czat bez ścian") -> kolumna dymków

Werdykt właściciela: dymek usera ma kolor usera z Ustawień (nie kolor agenta), rozciąga się na
całą szerokość tak jak dymek agenta, a jedyne różnice zostają kolor i margines (rynna po
przeciwnej stronie). Front B (poniżej) wprowadził to jako pierwsze - nazwa agenta zniknęła z
nagłówka, kryształ na starcie zostawał jedynym znacznikiem CAŁEJ SERII, w nagłówku nad pierwszą
wiadomością. Kolejna faza (ten sam spec, "kolumna") poszła dalej i usunęła nagłówek CAŁKOWICIE:
odpowiedź agenta jest dziś kolumną OSOBNYCH boxów (kontener `.cs-message--agent` przezroczysty,
bez tła/ramki/paddingu, tylko `margin-left: var(--cs-bubble-gutter)`), a kryształ siedzi PRZY
KAŻDYM elemencie agenta - każdym kafelku narzędzia/myślenia/sub-agenta i każdym dymku tekstu -
nie tylko raz na serię.

- **Rynna jedną zmienną, po obu stronach.** `--cs-bubble-gutter` (`src/styles.css`, `.cs-root`,
  `22px`) jest zmierzona z dawnego wcięcia agenta i używana identycznie po obu stronach:
  `margin-left` kontenera agenta (kryształ siedzi w tej rynnie, przez `::after` z ujemnym
  `left`) i `margin-right` dymka usera od prawej (mirror). Wartość liczbowa nie zmieniła się
  od frontu B - zmieniło się tylko to, CO ją używa (margines kontenera, nie `padding-left`
  nieistniejącego już nagłówka).
- **Dymek usera używa `var(--cs-user-color, var(--interactive-accent))`**, nie
  `--cs-agent-color-rgb` jak dawniej (`.cs-message--user`, `chat_view.css`): tło
  `color-mix(... 12%, transparent)`, obramowanie 1px `color-mix(... 30%, transparent)`, pasek
  po prawej 3px pełnym `var(--cs-user-color)` (lustro paska `.cs-tile::before`, który stoi po
  LEWEJ tej samej szerokości). `max-width: none`/`width: auto`/`align-self: stretch` zastępują
  dawne `max-width: 72%`/`align-self: flex-start` - dymek usera dziś zajmuje tyle samo miejsca
  co dymek agenta, mniej rynny po przeciwnej stronie.
  Poświata (`box-shadow`), notka kryształu (`::after`) i górny gradient (`::before`) dymka usera
  też liczą kolor z `--cs-user-color` (recenzja B: zielony dymek z czerwoną poświatą agenta był
  regresją wizualną); blok obcięcia kontekstu (`.cs-trim-bubble`) ma osobne reguły dla tych
  trzech, które przywracają kolor agenta.
- **Wyjątek: `.cs-message--user.cs-trim-bubble`** (blok obcięcia kontekstu, ulubiony kafelek
  właściciela, `_renderTrimBlock` w `chat_messages.ts`) nadpisuje tło/obramowanie/marginesy z
  powrotem do stanu sprzed 2.3.0 (agent-color-rgb, `align-self: flex-start`, `margin-right: 0`) -
  specyficzność dwóch klas bije bazową regułę jednej klasy. `.theme-light` ma osobną, trzecio-
  klasową restaurację (`border-color`) z tego samego powodu - bez niej jasny motyw nadpisywałby
  kolor z powrotem na `--cs-user-color` (specyficzność dwóch klas, remis kolejnością w pliku).
  `.cs-tile` (Tile, A1-A3) nie ma klasy `.cs-message--user` [measured, grep], więc nie koliduje.
- **Dymek odpowiedzi agenta (`.cs-message--agent > .cs-message__text`) ma DOKŁADNIE styl,
  jaki miał `.cs-message--user.cs-trim-bubble`** (tło/obramowanie/`border-left`/`box-shadow`
  identyczne, tylko kolor agenta zamiast usera), plus `position: relative; margin: 8px 0;
  padding: 5px 12px` - nadpisuje bazowe `padding: 6px 0 6px var(--cs-bubble-gutter)` z
  `.cs-message__text` (specyficzność dwóch klas bije jedną; NIE zmieniaj bazowej reguły, używa
  jej też dymek usera), plus `::before` z górnym gradientem w kolorze agenta (lustro
  `.cs-message--user::before`). Tekst pusty (`:empty`, streaming tworzy `.cs-message__text`
  ZANIM chunki spłyną; tury z samymi tool callami) dostaje `display: none` - bez tego pusty
  box zostawiałby widoczną ramkę/tło bez treści.
- **Nagłówek serii ZNIKNĄŁ CAŁKOWICIE** (jeden mixin, ten sam wzorzec x3, usunięty z trzech
  producentów): `chat_messages.ts`'s `append_message` i `render_messages`, oraz
  `chat_streaming.ts`'s `_ensureAgentMessageContainer`. Zniknęło razem z nim całe pole stanu
  `_agentHeaderShown` (`chatViewShape.ts` + wszystkie pięć miejsc, które je czytały/pisały:
  `append_message`, `render_messages`, `send_message`, `_ensureAgentMessageContainer`,
  `_chatBeforeContinue` - poprawka nieścisłości, poprzednia wersja tej notatki liczyła cztery;
  dowód: `git grep _agentHeaderShown 3d3b5fdd^`) -
  bez nagłówka to był martwy stan, nic już nie pyta "czy to pierwsza wiadomość serii". Reguły
  CSS `.cs-message__agent-head`/`.cs-message__agent-crystal`/`.cs-message__agent-crystal svg`/
  `.cs-message__agent-name` usunięte (zero producentów, sprawdzone grepem po `modules/`) -
  inaczej niż `.cs-action-row` (sekcja "Kafelki Tile..." wyżej), TEN martwy CSS naprawdę
  wyleciał, bo cała koncepcja nagłówka odeszła, nie tylko jeden markup wariant.
- **Kryształ PRZY KAŻDYM elemencie agenta, przez CSS `::after`, bez zmian w producentach
  kafelków.** Nowa zmienna `--cs-agent-crystal` (`url("data:image/svg+xml,<SVG>")`) jest
  ustawiana INLINE na kontenerze `.cs-message--agent`, w TYCH SAMYCH trzech miejscach co
  `--cs-agent-color-rgb` (`append_message`/`render_messages` w `chat_messages.ts`,
  `_ensureAgentMessageContainer` w `chat_streaming.ts`), przez jedną małą funkcję pomocniczą,
  `agentCrystalCssVar(agent, color)` w NOWYM czwartym pliku mixina, `chat/agentCrystal.ts`
  (ten sam wzorzec co `machineTile.ts` - trzeci plik importowany przez OBA mixiny bez cyklu:
  `chat_messages.ts` już importuje `buildBackgroundReceiptText` z `chat_streaming.ts`, więc
  odwrotny import zamknąłby cykl; `agentCrystal.ts` nie importuje żadnego z dwóch mixinów).
  CSS maluje kryształ pseudo-elementem `::after` na kafelkach (`.cs-tile--agent`,
  `.cs-tile--agent-muted`), na bloku `.cs-ask-user` (naprawa recenzji niezależnej, patrz gotcha
  "Kryształ przy `.cs-ask-user`" niżej) i na dymku tekstu (`.cs-message--agent > .cs-message__text`) -
  `background: var(--cs-agent-crystal) center / contain no-repeat`, `18×18px`, `opacity: 0.8`.
  **Pozioma pozycja (`left`) kompensuje różnicę grubości obramowania**: `calc(-1 * rynna - 1px)`
  dla kafelka (`border: 1px` dokoła) i `calc(-1 * rynna - 3px)` dla dymka/`.cs-ask-user`
  (`border-left: 3px`, nadpisujący TYLKO lewą krawędź bazowego `border: 1px`) -
  `position: absolute` liczy offset od PADDING BOX rodzica (nie od jego zewnętrznej krawędzi z
  obramowaniem), więc grubszy `border-left` przesuwa padding box głębiej i wymaga większego
  ujemnego `left`, żeby WSZYSTKIE trzy kryształy trafiły w TEN SAM x: lewa krawędź kontenera
  agenta minus rynna (22px) [inferred z modelu pudełkowego CSS - offset absolutny liczy się od
  padding edge, nie od border edge].
  **Pionowa pozycja (`top: 9px` kafelek / `top: 7px` dymek / `top: 12px` `.cs-ask-user`) NIE
  wynika z tej samej różnicy `border-left`** (poprawka nieścisłości - poprzednia wersja tej
  notatki twierdziła, że różnica 9 vs 7 wynika z grubości obramowania; `border-left` zmienia
  WYŁĄCZNIE `left`, nigdy pozycję pionową). W pionie liczy się `border-TOP`, ten sam 1px dla
  wszystkich trzech elementów (kafelek ma go dokoła, dymek i `.cs-ask-user` dostają go z
  bazowego `border: 1px`) - różnice `top` to osobno dobrane wartości wizualne (środek kryształu
  na wysokości pierwszego wiersza KAŻDEGO bloku, różny padding-top: dymek 5px, `.cs-ask-user`
  10px), nie wzór z grubości `border-left`. Kafelki systemowe (`.cs-tile--system`) i dymek usera
  NIE dostają kryształu - selektor ich nie łapie.
- **Łącznik (`_drawConnectorLines`, `chat_messages.ts`) kotwiczy dziś na PIERWSZYM i OSTATNIM
  elemencie serii, nie na nagłówku i ostatniej ikonie.** Grupowanie serii (ciąg
  `.cs-message--agent` bez przerwy w DOM) bez zmian. Elementy serii, W KOLEJNOŚCI DOM: każdy
  `.cs-tile--agent`/`.cs-tile--agent-muted`/`.cs-ask-user` (gdziekolwiek zagnieżdżony -
  `querySelectorAll` łapie je niezależnie od opakowania, `.cs-tool-chip-wrap`/
  `.cs-tool-calls-wrapper` przy streamingu) oraz każdy `.cs-message__text` BEZPOŚREDNI dzieckiem
  kontenera agenta; element z `offsetHeight === 0` (pusty dymek, ukryty przez `:empty`) pomijany.
  Jeden element w serii (albo zero) = brak linii. Linia idzie od środka kryształu PIERWSZEGO do
  środka kryształu OSTATNIEGO elementu: x liczony RAZ z pierwszego kontenera agenta
  (`getBoundingClientRect().left` minus realny `marginLeft` z `getComputedStyle`, fallback 22,
  plus 9 - połowa 18px kryształu) - ten sam x wychodzi RÓWNY "lewa krawędź kontenera WIADOMOŚCI
  (`messages_container`) + 25px" (padding kontenera wiadomości, 16px, plus połowa kryształu, 9px
  - rynna KASUJE SIĘ algebraicznie w tej formule, bo wchodzi raz przy pozycji kontenera agenta
  względem `messages_container` i raz jako odjęta wartość w samej formule JS, więc `25px` NIE
  jest pochodną wartości rynny, mimo że rynna bierze udział w wyprowadzeniu); y środka kryształu
  per element = `getBoundingClientRect().top` + 19 dla kafelka (border-top 1 + top 9 + połowa 18)
  albo + 17 dla dymka tekstu (border-top 1 + top 7 + połowa 18, `top: 7px` w CSS) albo + 22 dla
  `.cs-ask-user` (border-top 1 + top 12 + połowa 18). Kolor linii dziedziczony z grupy bez zmian.
- Test behawioralny: `chat/render_messages.bubbles.test.ts` - PRZEPISANY na nowy kontrakt (atrapa
  DOM harnessu, `dom-shim.ts`, ma `style.setProperty`/`getPropertyValue` jako CELOWY no-op dla
  custom properties - `createStyleProxy` - więc test buduje WŁASNĄ, minimalną atrapę elementu z
  prawdziwym `style` Map-em, wzór `render_messages.delegateError.test.ts`). Sprawdza: (1) ZERO
  węzłów `.cs-message__agent-head`/`.cs-message__agent-crystal` w całym drzewie, (2) KAŻDY
  kontener `.cs-message--agent` (nie tylko pierwszy w serii) ma inline `--cs-agent-crystal`
  zaczynające się od `url("data:image/svg+xml,`, zawierające zakodowany `%3Csvg` i dekodujące
  się (`decodeURIComponent`) do stringa z `<svg`; (3) to samo dla dwóch wywołań
  `_ensureAgentMessageContainer` pod rząd (streaming). `chatStreamingDedup.test.ts`'s dedup-guard
  zmienił cel z `cs-message__agent-crystal` (usunięty string) na `--cs-agent-crystal` (ciało
  `handle_chunk` nie ma prawa ustawiać tej zmiennej samo - jedyny producent to
  `_ensureAgentMessageContainer`).
  ⚠️ **Naprawa recenzji niezależnej (3d3b5fdd, punkt 2): powyższe (2)/(3) sprawdzały tylko KSZTAŁT
  wartości, nie CZYJ to kryształ** - mutacja podstawiająca cudzego/stałego agenta
  (`agentCrystalCssVar('Inny', '#000000')`) przechodziła bez zgrzytu. `assertCrystalColor`
  (nowy helper w tym samym pliku) dekoduje SVG i sprawdza literalny `stroke="{hex agenta}"`
  (`CrystalGenerator.generate` maluje nim kontur/linie) - dopisana do WSZYSTKICH istniejących
  asercji kryształu plus dwa nowe przypadki: `_ensureAgentMessageContainer` wywołane dla DWÓCH
  różnych agentów pod rząd (każdy kontener niesie kolor SWOJEGO, nie poprzedniego) i `append_message`
  (TRZECI producent `--cs-agent-crystal`, dotąd bez własnego testu w tym pliku).

### Gotcha: łącznik przerysowuje się po zmianie wysokości, nie tylko przy scrollu/finalizacji (naprawa recenzji niezależnej 3d3b5fdd)

Recenzja punktu "Dymki 2.3.0" wyżej znalazła: `_scheduleConnectorRedraw` był wołany tylko przy
scrollu (`scrollToBottom`) i finalizacji tury (`_finalizeTurn`) - rozwinięcie/zwinięcie kafelka
(`.cs-tile__head`) zmienia wysokość SYNCHRONICZNIE w tym samym zdarzeniu, a łącznik zostawał ze
starą geometrią (kończył się w połowie kafelka albo wystawał w dół); w streamingu linia nie
dociągała do dymka, który właśnie przestał być `:empty`, ani po wstawieniu bloku myślenia/kafelka
narzędzia, aż do końca tury.

- **`chat/connectorActivity.ts` (NOWY, czwarty plik mixina `chat_ui.ts` - ten sam wzorzec co
  `agentCrystal.ts`/`machineTile.ts`) trzyma `_scheduleConnectorRedraw`/`_cancelConnectorRedraw`
  (przeniesione z `chat_ui.ts` bez zmiany zachowania) + dwie nowe funkcje.** Powód przeniesienia:
  `chat_ui.ts` importuje `chat_view.css` jako moduł (`with { type: 'css' }`) - Node/AVA nie
  potrafi tego załadować (`ERR_UNKNOWN_FILE_EXTENSION`), więc NIC importowanego wprost z
  `chat_ui.ts` nie dawało się dotąd przetestować bezpośrednim importem (żaden test tego nie
  robił). ⚠️ **Poprawka (naprawa recenzji niezależnej commitu `caa7affa`): `chat_ui.ts`
  re-eksportuje WYŁĄCZNIE `_scheduleConnectorRedraw`/`_cancelConnectorRedraw`** (te dwie UŻYWAJĄ
  `this`, mają sens jako metody na `ChatView.prototype`) - `onMessagesContainerActivity`/
  `installMessagesContainerActivity` biorą `view` jako jawny argument, nie `this`, więc re-eksport
  całej czwórki (poprzednia wersja tej notatki) lądował dwiema martwymi "metodami" na
  `ChatView.prototype` i w typie `ChatViewLike` (`UiMethods` w `chatViewShape.ts` = `typeof
  uiMethods`, czyli WSZYSTKIE nazwane eksporty `chat_ui.ts`, re-eksporty też) - nikt nie wołał
  `this.installMessagesContainerActivity(...)`. Instalacja w `renderView` woła
  `installMessagesContainerActivity(this)` przez ZWYKŁY import z `connectorActivity.js`, nie przez
  `this.`.
- **`onMessagesContainerActivity(view, ev)`** - decyzja JEDNEGO delegowanego nasłuchu (`click` +
  `keydown` + `animationend`, trzeci typ dopisany w tej samej naprawie, patrz niżej) na
  `messages_container`: zdarzenie z celem wewnątrz `.cs-tile__head` (klik albo Enter/Spacja)
  planuje przerysowanie. Nasłuch kafelka (`Tile.ts`'s `expand()`) odpala się PIERWSZY (bubbling),
  więc samo zaplanowanie PO fakcie wystarcza - `expand()` już zmienił layout zanim ten handler
  dostanie zdarzenie.
- **`installMessagesContainerActivity(view)`** montuje trzy nasłuchy na `view.messages_container`
  i zwraca funkcję odpinającą - wołane w `chat_ui.ts`'s `renderView`, TUŻ PO stworzeniu
  `messages_container`, ten sam wzorzec sprzątania co `installSelectionMenu`/
  `_selectionMenuDetach` (odepnij POPRZEDNI egzemplarz przed zamontowaniem nowego - `renderView`
  potrafi się powtórzyć, `messages_container` powstaje na nowo za każdym razem; pole
  `_connectorActivityDetach` w `ChatViewMixins`, odpięcie też w `onClose`).
- **Streaming (`chat_streaming.ts`'s `_paintStreamFrame`): dwa NOWE, wąskie wyzwalacze**, oba
  strzelają RAZ na RUNDĘ narzędzi (poprawka nieścisłości - poprzednia wersja tej notatki mówiła
  "raz na turę"; `_chatBeforeContinue` zeruje `_currentThinkingBlock`/`_lastPaintedContent` przed
  KAŻDĄ kolejną rundą tej samej tury, więc druga/trzecia runda z własnym blokiem myślenia albo
  własną pierwszą treścią trafia tu ponownie jako "wstawienie"), nie w gorącej pętli
  throttlowanych klatek (throttle i tak woła tę funkcję dziesiątki razy na sekundę):
  1. **Wstawienie NOWEGO bloku myślenia** (gałąź `if (!this._currentThinkingBlock)`) - nowa
     kotwica łącznika, planuje przerysowanie od razu. `updateThinkingBlock` (gałąź istniejącego
     bloku, dopisywanie treści W RAMACH jednej rundy) NIE planuje ponownie - zbiór kotwic się nie
     zmienia.
  2. **Pierwsza niepusta treść dymka** (`!hadTextBefore && frame.text`, `hadTextBefore` liczone Z
     `_lastPaintedContent` SPRZED nadpisania) - dymek traci `:empty` (`display:none`) dopiero
     TERAZ, więc dopiero teraz staje się kotwicą. Rosnący tekst w KOLEJNYCH klatkach tej samej
     rundy NIE planuje ponownie - stały offset od GÓRY dymka (`_crystalCenterY`) się nie
     przesuwa, dlatego `scrollToBottom` niżej i tak dostaje `drawConnectors: false`.
- **`_chatOnToolCallsParsed` (Faza 1, placeholdery kafelków narzędzi)** planuje przerysowanie
  RAZ na rundę (nie w pętli per `tool_call`), TYLKO na aktywnej zakładce (`isActiveTab`) - tura w
  tle nie rusza łącznika widoku, którego user i tak nie widzi.
- ⚠️ **Cztery brakujące wyzwalacze (ważne, naprawa recenzji niezależnej commitu
  `caa7affa`) - zwinięcie bloku myślenia i podmiana kafelka zmieniają wysokość TEŻ poza
  streamingiem.** `finalizeThinkingBlock` (`ThinkingBlock.ts`) woła `expand(false)` - ciało kafelka
  myślenia znika SYNCHRONICZNIE, kafelki niżej podskakują. Poprzednia runda planowała przerysowanie
  tylko w `_finalizeTurn` (koniec naturalny) - trzy INNE ścieżki, które też finalizują blok
  myślenia, zostawały bez przerysowania: `_chatBeforeContinue` (reset kontenera przed kontynuacją
  pętli, w środku rundy), `handle_error` (błąd streamu), `stop_generation` (ręczny Stop - ta
  funkcja NIE liczy `isActiveTab` wcale, więc wywołanie jest tu bezwarunkowe, jak reszta kodu w
  tej gałęzi). Czwarty brak: `_chatOnToolResults` - `toolDisplay.replaceWith(...)` (kafelek błędu
  startuje ROZWINIĘTY, `Tile.ts`, `status:'error'`; bloki sub-agenta mają inną wysokość niż
  placeholder "w toku"; obrazek wygenerowany dokłada własny blok) ZMIENIA wysokość PO KAŻDYM
  wyniku w rundzie - przerysowanie na końcu funkcji (`if (isActiveTab) this._scheduleConnectorRedraw()`),
  raz na całą rundę, nie w pętli per wynik.
- ⚠️ **`handle_error`: przerysowanie w za wąskim warunku (naprawa recenzji niezależnej, dogrywka).**
  Runda opisana w punkcie wyżej wstawiła `_scheduleConnectorRedraw()` TYLKO wewnątrz
  `if (this._currentThinkingBlock)` w `handle_error` - ta sama gałąź `isActiveTab` robi jednak
  ZAWSZE też `current_message_text.empty()` (dymek wraca do `:empty`, znika przez CSS) i wstawia
  kafelek błędu, niezależnie od tego, czy tura miała żywy blok myślenia w locie. Bez bloku
  myślenia łącznik więc nadal kończył się obok nowego kafelka do następnej tury. Wywołanie
  przeniesione na KONIEC całej gałęzi `if (isActiveTab)` (po zwinięciu bloku myślenia, przed
  `_resetPaintTargets()`), bezwarunkowo - ten sam wzorzec co `stop_generation` (już dziś
  bezwarunkowy w swojej gałęzi, patrz wyżej).
- ⚠️ **Animacja wejścia (niskie, naprawa recenzji niezależnej commitu `caa7affa`).**
  `.cs-message--agent`/`.cs-ask-user` wjeżdżają animacją `cs-message-enter` (`translateY(6px) ->
  0`, `chat_view.css`) - nowy wyzwalacz (klik kafelka, pierwsza treść dymka…) strzela w PIERWSZEJ
  klatce animacji, gdy `getBoundingClientRect` liczy jeszcze transform w trakcie, nie pozycję
  końcową, więc kotwica wychodziła do 6px za nisko aż do NASTĘPNEGO przerysowania.
  `onMessagesContainerActivity` dostał trzeci typ zdarzenia, `animationend` (bąbelkuje z
  elementu animowanego do `messages_container` z definicji CSS Animations) - cel wewnątrz
  `.cs-message--agent` albo `.cs-ask-user` planuje przerysowanie.
- Test: `chat/connectorRedraw.activity.test.ts`. `onMessagesContainerActivity` - atrapa DOM
  harnessu (`dom-shim.ts`) ma `addEventListener`/`dispatchEvent`/`closest`/`matches` jako CELOWE
  no-opy [measured, grep w repo harnessu], więc testy wołają funkcję-handler wprost (`ev.target` =
  fake obiekt z WŁASNYM, działającym `closest()`), przez PRAWDZIWY `_scheduleConnectorRedraw` (nie
  mock). ⚠️ **Poprawka (BLOKER-adjacent, naprawa recenzji niezależnej commitu `caa7affa`): mock
  `requestAnimationFrame` musi mieć KOLEJKĘ i ręczny `flush()`, nie wołać callback synchronicznie
  wewnątrz `requestAnimationFrame(cb)`.** Stary, synchroniczny mock (`useSyncRaf`) wołał `run()`
  W ŚRODKU wywołania `window.requestAnimationFrame(run)` - `_scheduleConnectorRedraw` przypisuje
  `this._connectorRedrawCancel` PO tym wywołaniu, więc z synchronicznym mockiem ta linia
  NADPISYWAŁA z powrotem na niepustą wartość to, co `run()` przed chwilą wyzerował -
  `_connectorRedrawCancel` zostawał trwale niepusty po PIERWSZYM udanym zaplanowaniu, więc każde
  KOLEJNE planowanie w tym samym teście było dławione niezależnie od tego, czy kod pod testem
  faktycznie działał (test rozpoznawania klawisza Spacja przechodził, nawet gdyby produkcyjny kod
  Spacji w ogóle nie rozpoznawał - zweryfikowane [measured] tymczasowym sabotażem selektora klawisza
  w trakcie tej naprawy). Atrapa z kolejką odzwierciedla PRAWDZIWY async rAF: `requestAnimationFrame`
  tylko rejestruje callback, `flush()` odpala zakolejkowane na żądanie testu - kolejność w
  `connectorActivity.ts` (przypisanie `_connectorRedrawCancel` PO wywołaniu rAF) NIE jest wyścigiem
  w runtime, bo prawdziwy rAF jest zawsze asynchroniczny (wyścig istniał WYŁĄCZNIE w starym mocku
  testowym). Grupa 2 (`_paintStreamFrame`/`_chatOnToolCallsParsed`) TĄ SAMĄ techniką - PRAWDZIWY
  `_scheduleConnectorRedraw` + `_drawConnectorLines` jako licznik (poprzednia wersja stubowała
  `_scheduleConnectorRedraw` samo wywołanie, co dowodziło tylko, że produkcyjny kod ZAWOŁAŁ
  schedulera, nie że cokolwiek się przerysowało - regresja w samym schedulerze przeszłaby bez
  zgrzytu). Testy negatywne dostały krok pozytywny w TEJ SAMEJ fixturze (klik poza nagłówkiem →
  potem na nagłówku; pusta klatka → potem z tekstem; zakładka w tle → potem aktywna) - sam pusty
  test negatywny przechodzi też wtedy, gdy funkcja pod testem nic nie robi (kontrola z `CLAUDE.md`
  głównego repo, "Testy: zachowanie, nie implementacja"). Osobny test koalescencji: dwa planowania
  PRZED jednym `flush()` → jedno przerysowanie.
  Geometria linii (pozycje x/y) weryfikuje wyłącznie pomiar na żywo w Obsidianie - atrapa DOM nie
  ma silnika layoutu (`getBoundingClientRect` zwraca zera).

### Gotcha: kryształ przy `.cs-ask-user` (naprawa recenzji niezależnej 3d3b5fdd, dokończona po recenzji `caa7affa`)

`.cs-ask-user` (blok pytania `ask_user`) siedział w `.cs-tool-calls-wrapper` kontenera agenta jako
JEDYNY element kolumny bez kryształu i bez bycia kotwicą łącznika - werdykt właściciela ("każda
rzecz od agenta" ma kryształ) go pomijał. O ZAGNIEŻDŻENIU `.cs-ask-user` W `.cs-message--agent`
(kluczowe dla całej reszty tej notatki) decyduje `chat_streaming.ts`'s `_chatOnToolCallsParsed`
(dokleja blok zwrócony przez `_renderAskUserBlock` do `toolCallsContainer` wewnątrz kontenera
agenta) - **poprawka nieścisłości (dogrywka recenzji niezależnej)**: poprzednia wersja tej
notatki przypisywała tę decyzję `chat_popovers.ts` - błędnie. Błędnie przypisujący komentarz
siedział w `chat_view.css` (commit `caa7affa`, ówczesne linie ok. 1027-1029: "`.cs-ask-user`
renderuje się ZAWSZE zagnieżdżony w `.cs-message--agent` (patrz `chat_popovers.ts`)"), NIE w
samym `chat_popovers.ts` - `git grep caa7affa` na tym pliku daje ZERO trafień, plik nigdy nie
był tym commitem dotknięty. `chat_popovers.ts`'s `_renderAskUserBlock`
buduje WYŁĄCZNIE ODPIĘTY div, bez rodzica - o miejscu w drzewie nie wie nic. Naprawa jest czysto
CSS (plus jedna linijka w `_drawConnectorLines`, patrz niżej), ZERO zmian w `chat_popovers.ts`
(zmienna `--cs-agent-crystal` już jest ustawiona na kontenerze `.cs-message--agent` - custom
properties dziedziczą się w dół DOM-u automatycznie).

- `.cs-ask-user::after` MIAŁ kiedyś własny, starszy wygląd (romb-dekoracja: `border`, `transform:
  rotate(45deg)`, `background` stałym kolorem) - USUNIĘTY (poprawka nieścisłości: poprzednia
  wersja tej notatki mówiła "nowa reguła zeruje border/transform", czyli że stara reguła
  ZOSTAJE; naprawa recenzji `caa7affa` ją usunęła zamiast zerować drugi raz - selektor kryształu
  (`.cs-message--agent .cs-ask-user::after`, DWIE klasy) jest bardziej specyficzny niż był stary
  (`.cs-ask-user::after`, JEDNA klasa) i WYGRYWAŁ go zawsze, bo `.cs-ask-user` renderuje się
  ZAWSZE zagnieżdżony w `.cs-message--agent`). **Poprawka nieścisłości (dogrywka recenzji
  niezależnej):** poprzednia wersja tego zdania twierdziła, że romb "nigdy nie był faktycznie
  widoczny, więc to był martwy kod, nie dekoracja do zachowania" - nieprawda. Do commitu
  `caa7affa` `.cs-ask-user::after` miał TYLKO tę jedną, starą regułę (jedna klasa, nic jej nie
  przebijało specyficznością) - romb BYŁ widoczny. `caa7affa` dopiero dołożył bardziej
  specyficzny selektor kryształu na tym samym pseudo-elemencie - od tego commitu romb przestał
  wygrywać kaskadę. To zmiana WYGLĄDU (romb zastąpiony kryształem agenta), nie martwy kod od
  początku - sam kryształ był wtedy jeszcze niewidoczny z INNEGO powodu (BLOKER
  `overflow: hidden`, patrz niżej), naprawionego dopiero commitem kończącym tę rundę recenzji.
- ⚠️ **BLOKER (naprawa recenzji niezależnej commitu `caa7affa`): kryształ był CAŁKOWICIE
  przycięty.** `.cs-ask-user` ma bazowo `overflow: hidden` (powód nieudokumentowany w historii
  repo śledzonej tym repozytorium - poprzedza commit startowy `287301c`; [inferred z geometrii]:
  jedyny inny bezpośredni potomek na `position: absolute` był stary romb `::after` przy
  `left: -2px`, usunięty wyżej - `overflow: hidden` chował jego 2px wystający skrawek pod
  krawędzią; `::before`, gradient na górze, mieści się w całości w pudełku, więc nie potrzebował
  clippingu), a krysztal (`::after`, pozycja niżej) siedzi w UJEMNYM `left` POZA własnym
  pudełkiem `.cs-ask-user` - bez nadpisania `overflow` był więc przycięty do zera, niewidoczny.
  Naprawa: `.cs-message--agent .cs-ask-user { overflow: visible; overflow-wrap: anywhere; }`
  (`chat_view.css`) - nadpisanie ścisłe w kontekście kolumny agenta (ta sama wygrana
  specyficzności jak wyżej), nie zmiana bazowej reguły `.cs-ask-user` samej (`.cs-ask-user` poza
  kontekstem `.cs-message--agent` teoretycznie nadal miałby `overflow: hidden` - dziś
  nieosiągalne w praktyce, bo blok renderuje się ZAWSZE zagnieżdżony).
  ⚠️ **Poprawka nieścisłości (dogrywka recenzji niezależnej):** poprzednia wersja tego akapitu
  twierdziła, że "żadne dziecko `.cs-ask-user` nie polega na obcinaniu przez rodzica" - fałsz.
  `overflow: hidden` do tej pory przycinał TEŻ długi tekst (`__question`/`__context`/`__answer`,
  etykiety opcji) bez żadnego łamania - żaden element w tym łańcuchu nie miał
  `overflow-wrap`/`word-break`, więc długa ścieżka albo URL w pytaniu wychodziłby za prawą
  krawędź i dawał poziomy pasek na liście wiadomości. Stąd `overflow-wrap: anywhere` w TEJ SAMEJ
  regule, obok `overflow: visible`. `.cs-ask-user__input` (`width:100%` + padding + border)
  zostaje bezpieczny bez własnej poprawki, bo Obsidian ma globalnie
  `* { box-sizing: border-box }` [measured na żywo 24.09 przez właściciela projektu] - reszta
  dzieci (`__head`/`__options`/`__opt` itd.) ma własny, wewnętrzny układ bez przekraczania
  bazowego `border-radius: 2px`, teraz też bez polegania na obcinaniu tekstu przez rodzica.
- Pozycja: `.cs-ask-user` ma TEN SAM wzorzec obramowania co dymek tekstu (`border: 1px` bazowo,
  `border-left: 3px` nadpisujące tylko lewą krawędź) - ta sama korekta `left` co dymek
  (`calc(-1 * rynna - 3px)`). `top: 12px` (zamiast dymka `7px`) to hand-tuned wartość pod
  większy padding-top bloku (10px vs 5px dymka) - `_crystalCenterY` liczy dla niego offset 22
  (border-top 1 + top 12 + połowa 18).
- `_drawConnectorLines`'s selektor kotwic rozszerzony o `.cs-ask-user` (obok
  `.cs-tile--agent`/`.cs-tile--agent-muted`) - blok pytania jest dziś pełnoprawną kotwicą
  łącznika, tak jak kafelek.

### Gotcha: arkusz czatu wchodzi przez `adoptedStyleSheets`, bije `<style>` w `<head>`

`chat_view.css` trafia do dokumentu przez `import chat_view_styles from '../chat_view.css' with
{ type: 'css' }` (`chat_ui.ts`) + `adoptSheet(chat_view_styles)` (`modules/crystal-soul/`) -
czyli `CSSStyleSheet` w `document.adoptedStyleSheets`, nie zwykły `<style>`/`<link>` w `<head>`.
Przy RÓWNEJ specyficzności arkusz adoptowany bije arkusz z `<head>` (adopted stylesheets liczą
się jako ostatnie w kaskadzie) - to odkryto empirycznie przy podglądzie na żywo tej jednostki:
reguła w `<style>` o tej samej specyficzności, którą normalnie kolejność w pliku by wygrała,
przegrywała z regułą stąd. Dopisujesz regułę, która ma konkurować z czymś wstrzykniętym przez
Obsidian albo inny plugin jako `<style>`? Licz się z tym, że wygrywasz przy remisie
specyficzności niezależnie od kolejności w pliku - podnieś specyficzność selektora, jeśli
naprawdę potrzebujesz przegrać.

### Zaznaczanie i menu cytatu (2.3.0, spec D "Czat bez ścian")

Werdykt właściciela (dosłownie): "Nie mogę zaznaczyć tekstu i go np. skopiować, a jak już przy
tym jesteśmy to możesz przy okazji zrobić 'dodaj jako kontekst': czyli dodaje się jako
załącznik, a druga opcja to cytuj i kopiuje się to do chatu jako cytat."

- **Diagnoza (zrobiona na żywo w Obsidianie właściciela, [measured]):** łańcuch przodków
  `.cs-message__text` dziedziczył `user-select: none` od samego `body` (Obsidian ustawia to
  domyślnie). Naprawa jest CSS, nie JS - `.cs-message__text`, `.cs-tile__body`, `.cs-ask-user`,
  `.pkm-compression-text`, `.cs-trim-details` (`modules/chat/chat_view.css`) dostają
  `user-select: text` / `-webkit-user-select: text`. Nagłówki (`.cs-tile__head`,
  `.cs-message__meta`, kryształy/etykiety serii) zostają bez zmian - kryteria akceptacji
  dotyczą wyłącznie TREŚCI, nie etykiet. Jedyny WŁASNY `user-select: none` w CSS czatu sprzed
  tej zmiany siedzi na `.cs-action-row__head` (rodzina martwa od A2, patrz sekcja "Kafelki Tile
  w streamie i w historii" wyżej) - nietknięty.
- **Menu na zaznaczeniu** (`chat/selectionMenu.ts`, nowy plik): nasłuch `mouseup` i `keyup`
  (Shift+strzałki) na `messages_container`; gdy `window.getSelection()` jest niepuste i
  zakotwiczone wewnątrz `.cs-message__text` lub `.cs-tile__body` - pokazuje `div.cs-selection-menu`
  (`position: absolute` w `messages_container`, nad ostatnim `range` przez
  `getBoundingClientRect`) z trzema przyciskami: `chat.selection.copy` ("Kopiuj"),
  `chat.selection.context` ("Dodaj jako kontekst"), `chat.selection.quote` ("Cytuj"). Menu
  znika: klik poza (`document.mousedown`, capture), `Escape` (`document.keydown`), scroll
  kontenera, albo po samej akcji (kopiuj/kontekst/cytuj sprzątają po sobie i czyszczą
  `window.getSelection()`).
  - **Kopiuj:** `navigator.clipboard.writeText(text)` + potwierdzenie `showCrystalNotice`
    (`chat.selection.copied`, `type:'success'`, 2 s).
  - **Dodaj jako kontekst:** `attachmentManager.addTextAttachment({ name: 'Cytat z czatu ' +
    HH:MM + '.md', text })` - patrz `modules/ui-components/CLAUDE.md`.
  - **Cytuj:** `quoteText(sel)` (pure - każda linia dostaje prefiks `> `, plus jedna pusta
    linia na końcu) wstawiony przez `insertAtCursor(textarea, text)` (pure) w pozycji kursora
    `input_area`, potem `handleInputResize()` + fokus na pole.
  - Obie funkcje pure (`quoteText`/`insertAtCursor`) są testowane literalnie w
    `chat/selectionMenu.test.ts`. `installSelectionMenu` (montaż nasłuchów, `window.getSelection`)
    NIE ma testu DOM - atrapa harnessu (`test-support/dom-shim.ts`) nie implementuje
    `window.getSelection`/`Selection` [measured, grep "getSelection" w repo harnessu - zero
    trafień w `test-support/`], więc show/hide menu jest `skip: brak atrapy getSelection w
    harnessie`.
- **Montaż w `renderView`, odpięcie w `onClose` (`chat_view.ts`).** `chat_ui.ts`'s
  `renderView` woła `this._selectionMenuDetach?.(); this._selectionMenuDetach =
  installSelectionMenu(this);` - odpina POPRZEDNI egzemplarz przed montażem nowego (`renderView`
  potrafi się powtórzyć w cyklu życia jednego widoku, patrz wołacze w `chat_view.ts`, a
  `messages_container` powstaje na nowo za każdym razem - bez tego odpięcia nasłuchy na
  `document` by się mnożyły przy każdym kolejnym renderze). Pole `_selectionMenuDetach`
  (`(() => void) | null`) żyje w `ChatViewMixins` (`chat/chatViewShape.ts`). Odpięcie przy
  ZAMKNIĘCIU widoku jest wpięte w `onClose` (`modules/chat/chat_view.ts`): bez tego każda
  zamknięta instancja widoku zostawiałaby parę nasłuchów na `document` trzymającą cały widok
  w pamięci (recenzja D). Po "Cytuj" zaznaczenie jest czyszczone PRZED fokusem pola - odwrotna
  kolejność cofała kursor na pozycję 0 (recenzja D, zmierzone w Chromium).

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
