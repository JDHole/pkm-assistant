# modules/komunikator/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Prosta poczta między agentami.** Jeden filar: **skrzynka per agent, plik per wiadomość** w vaulcie. Agent może wysłać wiadomość (`kom_send`), przejrzeć nagłówki swojej skrzynki (`kom_list`) i przeczytać jedną (`kom_read`). Nic więcej — projekty, wątki, briefy i embedy zostały skasowane w S28.

**Status:** 🚀 **ACTIVE** (od S28, 2026-07-29). Flaga `pkmAssistant.komunikatorEnabled` **domyślnie ON**, z przełącznikiem w Settings → Zaawansowane.

> **Model „skrzynka pull", nie czat.** Agenci NIE gadają ze sobą autonomicznie — wiadomość leży w skrzynce, dopóki adresat sam do niej nie zajrzy przy swojej następnej sesji. To cecha, nie brak (F7, 2026-07-22).

---

## Komunikator v3 (S28) — co się zmieniło

| Było (v2, Sprint 08) | Jest (v3, S28) |
|---|---|
| Skrzynka = JEDEN plik `inbox_<agent>.md` z blokami HTML-komentarzy | Folder per agent, **plik per wiadomość** |
| Status w `**Status:** NOWA` + regexy na całym pliku | `user_read` / `ai_read` we **frontmatterze każdej wiadomości** |
| Limit 500 KB + twarda archiwizacja-reset | Brak limitu, brak archiwizacji |
| 13 narzędzi (`agent_message` + 12× `kom_*` Project Hub) | **3 prymitywy**: `kom_send` / `kom_list` / `kom_read` |
| Project Hub: projekty, wątki, briefy, embed, migrator Agory | **SKASOWANE** (D1 — projekt ogarniasz artefaktami E2.9 na poziomie vaulta) |
| Ping = 3 linijki + ścieżka pliku inbox | **Jedna linijka**: „masz N nieprzeczytanych (od: X, Y)" |
| Szlaban `can_message[]` (skasowany w E2.8) | **Niewidzialność per agent** (`komunikator_visible`) |
| Kasowanie poczty ręczne w UI | Modal po drugim ptaszku + guzik hurtowy (D5) |

**Dlaczego:** lekcja 11 + DEC L11-2 — jednoplikowa skrzynka była krucha (regex na całości, twardy reset przy 500 KB, „**Status:**" zacytowany w treści psuł parser). Zwiad 2026-07-29 pokazał też, że folder `projects/` w vaulcie Kuby był **pusty** — Project Hub nigdy nie wszedł do użycia.

---

## Model danych

```
.pkm-assistant/komunikator/inbox/<safeName>/msg-<timestamp>.md
```

```markdown
---
type: kom-message
od: "Tola"
do: "Sonny"
temat: "Brief tygodniowy"
data: "2026-07-29 14:30"
user_read: false
ai_read: false
---
<treść wiadomości>
```

- **Klucze po polsku** (`od`/`do`/`temat`/`data`) — spójnie z artefaktami E2.9. Flagi statusu techniczne (`user_read`/`ai_read`).
- **`ALL_READ` = `user_read && ai_read`** — **liczone, nigdy zapisywane** (jedno źródło prawdy).
- „Ile nowych?" = policz pliki z `ai_read: false` w folderze. Zero regexów na treści.
- `safeName` = `name.toLowerCase().replace(/[^a-z0-9]/g,'_')` (jak w v2).
- Wartości nagłówka przechodzą przez `JSON.stringify` — cudzysłów/dwukropek/nowa linia w temacie nie rozwali frontmattera.
- **Brak outboxów** — informacja o nadawcy żyje w polu `od` u adresata.

---

## Co tu jest

```
modules/komunikator/
├── CLAUDE.md                     # ten plik
├── index.js                      # public API
├── types.js                      # kontrakty współdzielone: MessageHeader/Message/MessageFrontmatter/VaultLike
├── KomunikatorManager.js         # ~400 LOC — store skrzynki (v3) + pure helpery parsera
├── KomunikatorManager.test.js    # 41 testów: CRUD, statusy, kolizja ts, traversal, liczniki, sygnał ALL_READ
├── visibility.js                 # PURE — kto uczestniczy w komunikatorze (D6)
├── visibility.test.js
├── cleanupQueue.js               # PURE — kolejka modali sprzątania (jeden na raz)
├── cleanupQueue.test.js
├── KomunikatorCleanupModal.js    # modal podglądu + hurtowe potwierdzenie + registerKomunikatorCleanup
├── KomunikatorCleanupModal.css   # style modali sprzątania (AUD-dead-code-072, patrz Gotchas)
├── KomunikatorCleanupModal.css.test.js  # strażnik KL-09: klasa malowana w .ts ⇒ reguła w .css
├── css.d.ts                      # deklaracja modułu `*.css` (import jako CSSStyleSheet)
└── CommunicatorView.js           # ~320 LOC — sidebar Crystal Soul (chipy agentów + akordeon + compose)
```

> **AUD-dead-code-073 (2026-09-02):** `KomunikatorModal.js` (~300 LOC, modal pełnoekranowy
> lista agentów + skrzynka + compose) **SKASOWANY** — zero importerów w całym repo (nie w
> kodzie, nie w teście, nie w barrelu; komentarz w `index.js` twierdzący że `CommunicatorView`
> go otwiera był po prostu nieprawdziwy). Sidebar Crystal Soul (`CommunicatorView`) jest dziś
> **jedynym** UI komunikatora poza modalami sprzątania.

---

## Public API (`index.js`)

```js
import {
  KomunikatorManager,
  renderCommunicatorView,
  // S28 D5 — sprzątanie (rejestracja nasłuchu; modale otwiera moduł sam)
  registerKomunikatorCleanup,
  // S28 D6 — niewidzialność (PURE, bez obsidian)
  isKomunikatorVisible, listKomunikatorAgents, findKomunikatorAgent,
  // wyłącznik globalny (D7)
  isKomunikatorEnabled,
} from 'modules/komunikator/index.js';
```

> **S30 Z4 — eksporty WYCIĘTE z barrela** (zero konsumentów spoza modułu):
> `KomunikatorCleanupModal`/`KomunikatorBulkDeleteModal`, `CleanupQueue`,
> `listKomunikatorAgentNames`. **Definicje ŻYJĄ w bebechach** — modale sprzątania
> i kolejkę wpina `registerKomunikatorCleanup` (event `communicator:message_all_read`),
> `CommunicatorView` otwiera `KomunikatorBulkDeleteModal` (guzik hurtowy), a listy nazw
> wołacze składają sobie z `listKomunikatorAgents()`. Testy deep-importują pliki wprost.
> **AUD-dead-code-073 (2026-09-02):** `KomunikatorModal`/`openKomunikatorModal` (modal
> pełnoekranowy) był tu wymieniony jako „wycięty z barrela, definicja żyje dalej" — to
> było mylące, bo definicja była SIEROTĄ (zero wołaczy nigdzie), nie tylko poza barrelem.
> Plik skasowany w całości, wpis usunięty.

### `KomunikatorManager` (instancja w `agentManager.komunikatorManager`)

| Metoda | Po co |
|---|---|
| `sendMessage(from, to, subject, content, {hop})` | create-only POD LOCKIEM skrzynki; kolizja timestampu → sufiks `-1`, `-2`… → `{success, id, path}` |
| `withLock(key, fn)` / `withAgentLock(agent, fn)` | K6 — serializacja operacji poczty (FIFO, wywrotka nie zatyka kolejki) |
| `reserveSend` / `releaseSend` | K6 — ATOMOWA rezerwacja slotu rate-limitu i jej zwrot przy padnietym zapisie |
| `resolveHopFor(agent)` | K6 — hop ze stanu Z CHWILI WYSYLKI (pamiec + swiezy odczyt skrzynki), fail-closed |
| `listMessages(agentName)` | nagłówki, **najnowsze pierwsze** (`{id, from, to, subject, date, userRead, aiRead, allRead}`); **W8: keszowane per skrzynka**, zero odczytu dysku na trafienie (patrz Gotchas) |
| `getMessage(agentName, id)` | podgląd treści **BEZ zmiany statusów** — ścieżka UI |
| `readMessage(agentName, id)` | treść + **auto `ai_read: true`** — ścieżka agenta (`kom_read`) |
| `markUserRead` / `markAiRead` | pojedynczy ptaszek (jedna edycja jednego pliku) |
| `deleteMessage(agentName, id)` | **twarde** usunięcie; woła WYŁĄCZNIE UI (D5) |
| `getUnreadCount` / `getAiUnreadCount` / `getUnreadCounts` | badge UI (user-unread) / ping (ai-unread) / batch |
| `getInboxPing(agentName)` | `{count, senders[]}` — dane pingu sesji, **zero treści** |
| `listAllRead(agentName)` | kandydaci guzika „Usuń przeczytane" |

Pure helpery eksportowane z pliku (dla testów): `buildMessageMarkdown`, `parseMessage`, `setFrontmatterFlag`.
`formatMessageDate` i `MAX_MESSAGE_BYTES` **nie są eksportowane** — AUD-dead-code-077
(2026-09-02) zdjął `export`, bo żaden test ani konsument spoza pliku po nie nie sięgał
(to zdanie wcześniej twierdziło inaczej, dokumentacja się myliła).

**Eventy** (przez `agentManager._emit`): `communicator:message_updated` po każdej mutacji + `communicator:message_all_read` gdy wiadomość dostanie DRUGI ptaszek (na tym siedzi modal sprzątania). UI słucha też `communicator:message_sent` / `message_read`.

---

## Trzy narzędzia agenta (`modules/tools/KomunikatorTools.js`)

| Narzędzie | Światło | Co robi |
|---|---|---|
| `kom_send(to, subject, content)` | **YELLOW** (toggle approvalu, default „pytaj") | JEDEN adresat na wywołanie; wielu = model woła w pętli |
| `kom_list()` | GREEN | nagłówki WŁASNEJ skrzynki, bez treści |
| `kom_read(id)` | GREEN | treść jednej wiadomości + auto-ptaszek `ai_read` |

- **Create-only:** agent NIE MA narzędzia kasowania poczty. Sprząta user.
- **Tożsamość z `_invocationAgentName`** (wstrzykuje `MCPClient`) — model nie podrobi nadawcy ani właściciela skrzynki.
- `kom_send` jest YELLOW mimo akcji `agent.message` (która ogólnie jest RED): jawny wyjątek narzędziowy w `classifyToolRisk` **musi** stać PRZED szeroką regułą — wzór `artifact_update` vs `write`.
- **Czwarte narzędzie poczty nazywa się `agent_delegate`** i mieszka w grupie `delegation`, ale
  wysyła list tym samym `sendAgentMail` — więc od K17 ma akcję `agent.message`, żółte światło
  i **ten sam przełącznik zgody co `kom_send`** (user, który wyciszył pocztę, wycisza obie drogi).
  Podlega też osi poczty wołającego: bez `kom_send` w profilu nie zostawi listu w cudzej skrzynce.

---

## Niewidzialność per agent (D6)

Pole agenta **`komunikator_visible`** (default `true`, serializowane tylko gdy `false` — wzór `admin_access`). Toggle: profil → **Uprawnienia** → grupa Komunikator → „Uczestniczy w komunikatorze".

Wyłączony agent jest **duchem w obie strony**:
- nie ma go na liście adresatów (UI compose, `SendToAgentModal`) ani w błędzie „dostępni: …",
- jego skrzynka znika z pasków agentów (`CommunicatorView`) i z chipów Home,
- `kom_send` do niego zwraca **dokładnie ten sam błąd co literówka** w nazwie („nieznany adresat") — zero przecieku, że istnieje,
- sam też nie wysyła i nie czyta: jego `kom_*` zwracają uczciwy powód, który widzi **tylko on**,
- ping o jego skrzynce milczy.

**Jedno źródło prawdy:** pure `visibility.js`. Narzędzia i UI **nie importują go wprost** — czytają przez `AgentManager` (`isKomunikatorVisible` / `listKomunikatorAgents` / `findKomunikatorAgent`), żeby `modules/tools/` nie wciągnęło obsidian-owego barrela.

---

## Ping sesji (D4)

`AgentManager.getInboxPing(agent)` → `{count, senders}` albo `null`. Trafia do promptu jako `ctx.inboxPing` i renderuje się jako **JEDNA linijka** na dole drzewa decyzyjnego (`PromptBuilder._injectInboxNotification`):

> `SKRZYNKA: masz 3 nieprzeczytanych wiadomości (od: Klara, Sonny). Zajrzyj, kiedy uznasz to za istotne.`

Zero treści, zero ścieżek do plików, zero „przeczytaj to teraz". `count === 0` → **żadnej linijki** (nie zaśmiecamy promptu ani prefiksu cache). Reakcję na ping opisuje reguła rdzenia `kom_inbox` (`decisionTree.js`).

---

## Sprzątanie pół-automatem (D5)

**Bez kosza — usuwanie twarde.**

1. Mutacja statusu sprawia, że wiadomość ma OBA ptaszki → `communicator:message_all_read` → modal z **pełnym podglądem** (od/do/temat/data/treść) + „Usuń" / „Zostaw". Esc/krzyżyk = „Zostaw" (nic nie znika bez jawnej decyzji).
2. Kilka naraz → **kolejka** (`cleanupQueue.js`), jeden modal na raz, dedupe po `agent+id`, wywrotka modala nie zatyka kolejki.
3. „Zostaw" → wiadomość leży jako przeczytana; sprzątnie ją **guzik hurtowy** „Usuń przeczytane" w sidebarze (kasuje wszystkie ALL_READ bez podglądu, z jednym zbiorczym potwierdzeniem).

Podpięcie: `registerKomunikatorCleanup(plugin)` w `src/main.js` za flagą; `onunload` odpina nasłuch i porzuca kolejkę.

---

## Wyłącznik globalny (D7)

`settings.pkmAssistant.komunikatorEnabled` — **default `true`**, przełącznik w **Settings → Zaawansowane**. Helper `isKomunikatorEnabled(settings)` = `settings?.pkmAssistant?.komunikatorEnabled !== false` (brak pola w starym `data.json` = włączone).

Gdy `false`:
- `AgentManager.komunikatorManager === null` (wszystkie callsite'y są `?.`-safe),
- `kom_send`/`kom_list`/`kom_read` niezarejestrowane w `main.js` (agent ich nie widzi),
- serwer `komunikator` znika z katalogu (`resolveBuiltinManifests({komunikatorEnabled:false})`),
- sekcja „Komunikator" w `HomeView` schowana, `CommunicatorView` pokazuje uczciwy komunikat,
- **dane usera NIETKNIĘTE.**

Flaga czytana **przy starcie** → zmiana wymaga przeładowania pluginu (nota przy przełączniku). Strażnicy: `modules/tools/built-in-servers.test.js` + `core/selftest.js` (przeciek w obie strony: OFF z `kom_*` = ERROR, ON bez kompletu poczty = ERROR).

---

## Zależności

**Importuje z:** `core/utils/Logger.js`, `core/i18n/index.js`, `core/security/keySanitizer.js` (`sanitizePath`), `core/utils/yamlParser.js` (`parseFrontmatter`), `modules/crystal-soul/index.js` (UI), `obsidian` (Modal, Notice).

**Importowany przez:**
- `modules/agents/AgentManager.js` — tworzy `KomunikatorManager` (za flagą) + deleguje helpery widoczności
- `src/main.js` — `isKomunikatorEnabled` + `registerKomunikatorCleanup`
- `modules/shell/AgentSidebar.js` — rejestruje `renderCommunicatorView`
- `modules/shell/sidebar/HomeView.js` — sekcja Komunikator za flagą
- `modules/shell/SendToAgentModal.js` — `sendMessage` przez `agentManager.komunikatorManager`
- `modules/tools/KomunikatorTools.js` — **bez importu**, wszystko przez `agentManager`

**Brak deep imports.** Wszystko przez `index.js` (wyjątek: testy, które celowo sięgają po pure helpery).

---

## Gotchas

- ⚠️ **Pola wiadomości NA STAŁE po polsku** (`od`/`do`/`temat`/`data`) — to format pliku, nie UI. Język interfejsu (i18n) się zmienia, klucze frontmattera NIE.
- ⚠️ **`ALL_READ` nigdy nie jest zapisywane** — liczysz je z dwóch flag. Nie dodawaj pola do frontmattera.
- ⚠️ **Chip agenta ma TRZY stany, nie dwa** (AUD-bledy-048). Badge z liczbą = są nieprzeczytane, brak
  badge'a = potwierdzone zero, `?` = licznika NIE POLICZONO (błąd leci do `log.warn`). Dawny `catch {}`
  w `CommunicatorView.renderAgentStrip` robił z awarii odczytu skrzynki wygląd „brak nowych".
- ⚠️ **Widok Komunikatora w sidebarze odpina się przez `nav.dispose()`** (AUD-bledy-045). Sprzątanie
  (`unsub` + `clearTimeout` budzika 150 ms) wisi na `nav._currentCleanup`, a wołacz przy zamknięciu
  panelu żyje w `AgentSidebar.onClose()` — patrz `modules/shell/CLAUDE.md`, gotcha 9.
- ⚠️ **`readMessage` odhacza `ai_read`, `getMessage` NIE.** UI musi wołać `getMessage` — inaczej samo otwarcie karty w sidebarze udawałoby, że agent przeczytał wiadomość.
- ⚠️ **`deleteMessage` woła TYLKO UI.** Gdyby kiedyś kusiło dołożyć `kom_delete` — to jest świadoma decyzja D3/D5, nie przeoczenie.
- ⚠️ **`id` przychodzi od LLM** (`kom_read`) — `_getMessagePath` odrzuca wszystko spoza wzorca `msg-<ts>[-n]` i przepuszcza ścieżkę przez `sanitizePath` PIERWSZY (core/CLAUDE.md gotcha #4).
- ⚠️ **Zero kodu migracji ze starego formatu** (D8). Stare `inbox_*.md` i `projects/` po prostu leżą w vaulcie i są niewidoczne dla v3 — user kasuje je ręcznie.
- ⚠️ **Bramki poczty musza byc ATOMOWE — jedna odpowiedz modelu leci przez `Promise.all`** (K6).
  `withLock(key, fn)` w managerze serializuje operacje: `agent:<safeName>` (poczta jednego agenta:
  `kom_send` i `kom_read` tej samej tury po kolei) i `inbox:<dir>` (dobor nazwy pliku + zapis).
  Rate-limit rezerwuje slot **synchronicznie** (`reserveSend`, zero `await` w srodku) PRZED zapisem,
  a nieudany zapis oddaje go przez `releaseSend`. **Nie wracaj do wzorca „sprawdz → await → zapisz"** —
  tak wygladal kod przed K6 i dziesiec rownoleglych `kom_send` przechodzilo bramke kompletem.
- ⚠️ **CREATE-ONLY jest asercja, nie zalozeniem.** `adapter.write` nadpisuje bez pytania, wiec
  `sendMessage` sprawdza `_probe` jeszcze raz tuz przed zapisem — pod lockiem skrzynki. Kolizja
  `Date.now()` przy wsadzie jest realna (mierzona), a nadpisany list znikal razem z potwierdzeniem
  `success: true` dla obu nadawcow.
- ⚠️ **`_probe` ma TRZY stany, nie dwa** (K4, AUD-bledy-063). Dawne `_exists` robilo
  `try { exists() } catch { return false }` — kazdy wyjatek I/O stawal sie cichym „nazwa wolna",
  bez linii w logu, i ta sama wartosc zasilala pętle doboru sufiksu ORAZ bramke tuz przed zapisem.
  Teraz idzie to przez `probeFile` (`core/index.js`): zapis przepuszcza **wylacznie potwierdzone
  `'missing'`**, a `'unknown'` (sprawdzenie padlo) to **odmowa fail-closed** — nadawca dostaje
  `success: false` i moze ponowic (stempel sie zmieni). Nie „upraszczaj" tego z powrotem do boola.
- ⚠️ **Hop liczy `resolveHopFor`, nie `nextHopFor`.** `nextHopFor` to sam rejestr w pamieci, ktory
  zapisuje sie dopiero dwa `await` w glab `readMessage`. `resolveHopFor` bierze maksimum z rejestru
  i ze SWIEZEGO odczytu wlasnej skrzynki (listy `ai_read` doreczone w oknie `KOM_HOP_TTL_MS`),
  a przy braku danych zwraca `KOM_HOP_LIMIT` — **fail-closed**.
- ⚠️ **Jedna droga do skrzynki: `sendAgentMail` z `modules/tools/KomunikatorTools.ts`.** `kom_send`
  I `agent_delegate` wolaja te sama funkcje, wiec filtr ducha (nadawca I adresat), rate-limit
  i licznik odbic sa liczone raz. Gdyby doszla trzecia droga wysylki — ma isc tamtedy, a nie wprost
  do `KomunikatorManager.sendMessage` (tak wygladala delegacja przed K6 i omijala komplet bramek).
  `sendMessage` wprost woła TYLKO UI (user z panelu), ktory swiadomie nie podlega limitom agenta.
- ⚠️ **K17 (AUD-security-110/109): kontrakt KAŻDEJ drogi do skrzynki to komplet czterech rzeczy** —
  (1) **oś poczty WOŁAJĄCEGO** (`toolRegistry.checkToolAxis(<agent z runtime>, 'kom_send')` jako
  pierwszy warunek w `sendAgentMail`), (2) **widoczność** obu stron (filtr ducha), (3) **limity**
  (hop + rate-limit), (4) **zgoda usera jak przy `kom_send`** (akcja `agent.message`, żółte światło,
  przełącznik `kom_send`). Do K17 `agent_delegate` miał (2) i (3), ale nie (1) i nie (4): oś
  narzędziowa oceniała jego własną nazwę z grupy `delegation`, więc agent z WŁĄCZONĄ delegacją
  i WYŁĄCZONĄ pocztą (domyślny stan świeżego profilu) deponował tekst modelu w cudzej skrzynce
  bez pytania. **Nowa droga do skrzynki dziedziczy komplet za darmo — o ile idzie przez
  `sendAgentMail` i ma wpis w `ACTION_TYPE_MAP` mówiący `agent.message`.**
- ⚠️ **`KomunikatorManager` przyjmuje `agentManager` jako 2. opcjonalny arg** (default `null`) — w testach emit jest no-op.
- ⚠️ **Duplikat renderu karty wiadomości** — historyczny stan (TODO #5) był między `KomunikatorModal`
  i `CommunicatorView`; po kasacji `KomunikatorModal.ts` (AUD-dead-code-073, 2026-09-02) duplikatu
  już nie ma, `CommunicatorView` jest jedynym rendererem. Pozycja zostawiona jako historia w TODO niżej.
- ⚠️ **Komunikaty managera żyją w namespace `komunikator.*`, NIE `communicator.*`** (K18,
  AUD-bledy-041). `communicator.*` to warstwa UI (sidebar, modale sprzątania), a `komunikator.*`
  to zdania samego store'u — widzi je I user w `Notice` (przez `res.error` w `CommunicatorView`),
  I model w polu `error` narzędzi `kom_send`/`kom_read`. Do K18 czterech kluczy (`invalid_recipient`,
  `message_too_large`, `send_failed`, `message_not_found`) **nie było w ŻADNYM słowniku**, więc
  `t()` oddawało sam klucz i na ekranie stał napis „komunikator.invalid_recipient". Parytet pl↔en
  tego nie łapał (brak w OBU plikach jest „zgodny") — od K18 pilnuje tego **skan źródeł**
  w `core/i18n/parity.test.ts` („każdy `t('literał')` w `modules/komunikator/` ma klucz w pl i en").
  `modules/tools/KomunikatorTools.ts` też woła `komunikator.message_not_found` — przy zmianie
  nazwy klucza pamiętaj o tamtym pliku.
- ⚠️ **`readMessage` melduje ze STANU DYSKU, nie z zamiaru** (K18, AUD-bledy-042). Pad zapisu
  ptaszka `ai_read` (`_setFlag` → `false`) kończy się `{success: false, error: komunikator.mark_read_failed}`
  i `log.warn` — **treść listu NIE wraca**, bo `kom_read` i tak zrzuca wynik przy `success:false`,
  a nieoznaczona wiadomość to nie jest wiadomość odebrana. Do naprawy zwrotka `_setFlag` była
  ignorowana: model dostawał „przeczytane" + treść, a na dysku zostawało `ai_read: false`, więc
  `getAiUnreadCount` dalej liczył 1 i ping wracał w KAŻDEJ turze — agent czytał ten sam list w kółko.
  **Nie „upraszczaj" tego z powrotem do `await this._setFlag(...)` bez czytania wyniku.**
- ⚠️ **W8 (2026-09-02, AUD-wydajnosc-028/058/101): `_listMessagesStrict` keszuje nagłówki
  per skrzynka (`_headerCache: Map<dir, {headers, at}>`) — NIE czyta dysku na trafienie.**
  Do naprawy KAŻDE wywołanie (`getUnreadCount`, `kom_list`, `resolveHopFor`, sidebar Home)
  czytało z dysku CAŁĄ skrzynkę, plik po pliku, sekwencyjnym `for`+`await`, nawet gdy nic
  się nie zmieniło od poprzedniego renderu — na realnym vaulcie Kuby (569 wiadomości/14
  skrzynek) to 1166 operacji fs na JEDEN render sidebara. Kesz buduje się RAZ przez
  `Promise.all` (nie sekwencyjnie) i żyje, dopóki `_invalidateInboxCache(agentName)` go nie
  zdejmie — wołane po KAŻDEJ udanej mutacji tej skrzynki (`sendMessage` → adresat,
  `readMessage`/`markUserRead`/`markAiRead`/`deleteMessage` → właściciel). **Kontrakt: KAŻDA
  nowa mutacja skrzynki PRZEZ TEN MANAGER musi inwalidować kesz po udanym zapisie.**
  > ⚠️ **KOREKTA (2026-09-02, review koordynatora):** zdanie „poczta jest create-only i
  > WSZYSTKIE zapisy idą przez metody managera, nie ma kanału mutacji, którego kesz by nie
  > widział" (pierwsza wersja tej notki) było **FAŁSZYWE**. Sesje Claude Code piszą do
  > skrzynek WPROST na dysk (nowy plik `msg-{epoch}.md`, edycja `ai_read` — kontrakt
  > `/agent`), vault bywa synchronizowany Google Drive między laptopem a telefonem (pliki
  > pojawiają się/zmieniają bez udziału pluginu), `obsidian-git pull` też potrafi podmienić
  > pliki. Jawna inwalidacja łapie TYLKO mutacje przez ten manager — bez dodatkowej ochrony
  > kesz zamrażałby liczniki do najbliższej takiej mutacji: **realna regresja funkcjonalna**,
  > nie tylko wydajnościowa. Naprawa: dwie NIEZALEŻNE siatki bezpieczeństwa, patrz gotcha
  > niżej (`attachVaultEvents` + `HEADER_CACHE_TTL_MS`).
- ⚠️ **W8 follow-up: `attachVaultEvents(registerEvent?)` — nasłuch `create`/`modify`/
  `delete`/`rename` na `this.vault` dla ścieżek pod `INBOX_PATH`, PLUS `HEADER_CACHE_TTL_MS
  = 5000` jako siatka niezależna od zdarzeń.** Dwa kanały ochrony przed zapisami Z ZEWNĄTRZ
  (patrz korekta wyżej): (1) zdarzenie vaulta inwaliduje kesz NATYCHMIAST, gdy `this.vault`
  ma realny event API (`.on`/`.offref` — Obsidian `Vault` ma; atrapy testowe zwykle nie);
  (2) TTL ≤5s gwarantuje, że NAWET BEZ zdarzenia (nasłuch niepodpięty, klient sync nie budzi
  `vault.on`) kesz nie żyje wiecznie. `_listMessagesStrict` traktuje wpis starszy niż TTL
  jako pudło, nie hit. **Kto wywołuje `attachVaultEvents`:** `KomunikatorManager` sam NIE MA
  dostępu do `plugin.registerEvent` (Obsidian `Component`, potrzebny do właściwego sprzątania
  nasłuchu przy unload) — woła go `AgentManager` w konstruktorze, zaraz po utworzeniu
  `komunikatorManager`, wzorem `VaultIndexer._registerHooks`
  (`modules/embedding/VaultIndexer.ts`). Bez `registerEvent` (np. w harnessie/testach bez
  pełnego cyklu życia pluginu) referencje trzyma sam manager — odepnij ręcznie przez
  `detachVaultEvents()`. Atrapa vaulta bez `.on` → `attachVaultEvents` zwraca `false`,
  no-op, BEZ wyjątku — TTL zostaje jedyną ochroną (dokładnie tak wygląda większość testów
  w `KomunikatorManager.test.ts`, gdzie `fakeVault()` celowo nie ma event API).
- ⚠️ **W8: `_readMessageFile` NIE robi już `exists()` przed `read()`** — ten sam wzorzec co
  przy innych odczytach plików w tym repo (S30: `exists()` kłamie na dyskach sieciowych/Google Drive).
  Brakujący plik i padnięty odczyt dają identyczny skutek (`null` + `log.warn`), więc jedno
  `try/catch` na `read()` wystarcza. **Dir-level `exists()` w `_listMessagesStrict` ZOSTAJE**
  (sprawdza czy skrzynka w ogóle istnieje, jedno wywołanie na render, nie na plik).
- ⚠️ **W8: `kom_list` (`modules/tools/KomunikatorTools.ts`) ma twardy sufit `KOM_LIST_MAX =
  50`** (AUD-wydajnosc-020/053) — skrzynka bez ewikcji rosła bez ograniczenia razem z kosztem
  tokenów tury. Newest-first z `listMessages` gwarantuje, że obcięcie zostawia zawsze
  najświeższe. Wynik ≤ 50 wiadomości jest BAJT W BAJT jak przed cięciem (bez nowych pól);
  > 50 dokłada `{total, truncated:true}`. `unread` liczy się z CAŁEJ skrzynki, nie z widoku —
  to jedna liczba, tania nawet bez cięcia. **Manager (`listMessages`) sam NIE tnie** — sufit
  żyje w warstwie narzędzia, bo inne wołacze managera (`listAllRead`, `getInboxPing`,
  `getAiUnreadCount`) potrzebują KOMPLETU do poprawnego liczenia.
- ⚠️ **`_ensureInboxDir` ma DWA powody porażki, nie jeden** (K18, AUD-bledy-046). Zwraca
  `{dir}` albo `{dir: null, reason: 'invalid_recipient' | 'inbox_unavailable'}`. Pierwszy to
  walidacja nazwy (`_getInboxDir` → `null`), drugi to pad `mkdir`. `sendMessage` mapuje je na
  RÓŻNE komunikaty: do naprawy awaria dysku szła jako „nieznany adresat" — czyli diagnoza
  nieprawdziwa (w drodze przez `sendAgentMail` adresat był już rozwiązany jako istniejący
  i widoczny), więc model wnioskował, że agenta nie ma, i rezygnował.

---

## TODO

- ✅ shared `renderMessageCard` (Modal × CommunicatorView duplikat) — rozwiązane samo przez
  kasację `KomunikatorModal.ts` (AUD-dead-code-073, 2026-09-02); `CommunicatorView` jest jedynym rendererem
- 🟡 limity ilościowe skrzynki (F7) — **świadomie odłożone** (D9)

## Powiązane

- [`modules/agents/CLAUDE.md`](../agents/CLAUDE.md) — `komunikator_visible`, helpery widoczności, ping w prompcie
- [`modules/tools/CLAUDE.md`](../tools/CLAUDE.md) — 3 narzędzia poczty + światła ryzyka
- [`modules/prompts/CLAUDE.md`](../prompts/CLAUDE.md) — reguła `kom_inbox` + ping
- Spec sprintu: [`Refaktor/Sprinty/S28_Komunikator_v3_SPEC.md`](../../Refaktor/Sprinty/S28_Komunikator_v3_SPEC.md)

## Historia

- **Sesja 23** — pierwszy KomunikatorManager (skrzynki jako bloki w jednym pliku)
- **Sesja 47, 73, 110** — Crystal Soul UI (sidebar + modal + chipy na Home)
- **Mapa-2** (2026-04-25) — przenosiny do `modules/`, 16 znalezisk, 3 Nauka cards
- **Sprint 04 Z5** (2026-04-28) — whitelist `can_message[]` w `AgentMessageTool`
- **Sprint 08** (2026-04-30) — Komunikator v2 = **Project Hub** (projekty/wątki/briefy z wywalonej Agory, 12 narzędzi `kom_*`, embed, migrator)
- **E1.2 kill-switch** (2026-07-21) — moduł wyłączony na czas refaktoru v2.1 flagą `komunikatorEnabled` (default `false`)
- **E2.8 A4/F7** (2026-07-23) — `can_message` skasowane jako byt (każdy pisze do każdego)
- **E3.4** (2026-07-25) — `sanitizePath`-first w `getBrief`/`updateBrief`
- **S28 „Komunikator v3 — prosta poczta"** (2026-07-29) — **Project Hub skasowany w całości** (D1); skrzynka przepisana na plik-per-wiadomość z frontmatterem (D2); 13 narzędzi → 3 prymitywy create-only (D3); ping ścięty do jednej linijki (D4); sprzątanie pół-automatem bez kosza (D5); niewidzialność per agent zamiast szlabanu (D6); wyłącznik globalny default ON z przełącznikiem w Settings (D7); zero kodu migracyjnego (D8); UI bez liftingu, tylko minus Projects plus guzik hurtowy (D9).

## S33 Z2 update (2026-07-30) — strażnicy poczty agentów

Poczta agentów nie miała żadnego bezpiecznika przed pętlą „agent odpisuje agentowi". Doszły
dwa, oba **w warstwie narzędzia** (`kom_send`), ze stanem w managerze — **user piszący
z panelu komunikatora nie podlega żadnemu z nich.**

- **Rate-limit (B1).** `checkSendAllowed(from, to, limit)` + `noteSend(from, to)` — okno
  `KOM_RATE_WINDOW_MS` (10 min), licznik **per para nadawca→adresat** (klucz przez
  `_getSafeName`, więc „Tola" i „TOLA" to jeden nadawca). Limit: `config/limits.js` →
  `kom_send_rate_max` (default 20, min 1, sufit 500), edytowalny w Settings → Limity.
  Stan żyje **wyłącznie w pamięci** — restart pluginu = czyste konto. Świadomie: to bezpiecznik
  rozpędzonej sesji, nie kwota dzienna.
- **Licznik odbić / hop (B2).** Nowe pole frontmattera **`hop`** (liczba, default 0; stare
  wiadomości bez pola = 0). `readMessage` (czyli `kom_read` — ścieżka AGENTA, **nie**
  `getMessage` z UI) odnotowuje `noteRead(agent, hop)`; `nextHopFor(agent)` daje
  `maxPrzeczytany + 1`. Przy `hop >= KOM_HOP_LIMIT` (3) `kom_send` odmawia i każe oddać sprawę
  userowi. Łańcuch: A→B(0) → B→C(1) → C→A(2) → STOP.
- ⚠️ **Granica „sesji" to TTL, nie hook.** Z warstwy narzędzia nie ma czym uczciwie zmierzyć
  „nowej rozmowy": `kom_read` woła też sub-agent i harness, a `chat_session.handleNewSession`
  nie emituje żadnego zdarzenia (woła tylko `AgentMemory.startNewSession`). Zamiast wiązać pocztę
  z chatem i pamięcią liczymy odczyty **świeże** — starsze niż `KOM_HOP_TTL_MS` (30 min) nie
  budują łańcucha. Gdyby chat kiedyś zaczął emitować „nowa rozmowa", reset `_readHops` per agent
  jest jednolinijkową podmianą.
- **Zegar jest wstrzykiwalny:** `new KomunikatorManager(vault, agentManager, { now })` — testy
  rate-limitu i TTL nie czekają realnych minut.
- **Kolejność kontroli w `kom_send`:** tożsamość → widoczność adresata (błąd „nieznany adresat"
  **bez zmian**, ma pierwszeństwo) → self → hop → rate-limit → wysyłka. Limity liczą się dopiero
  dla ROZWIĄZANYCH adresatów, więc odmowa nigdy nie zdradza, że jakiś duch istnieje.
- **`sendMessage(from, to, subject, content, { hop })`** — piąty argument opcjonalny; brak = 0.

## K12 update (2026-08-23) — DRUGI sufit poczty: pula wysyłkowa NADAWCY (ogon K6)

Limit per para nadawca→adresat nie domykał sprawy: zepsuty agent rozsyłał
`kom_send_rate_max` × liczba adresatów, mieszcząc się w każdej parze z osobna
(20 × 12 agentów = 240 listów w 10 minut). Doszedł drugi sufit na to samo okno.

- **Dwa liczniki, jedno okno (`KOM_RATE_WINDOW_MS`, 10 min):** `_sendLog` per PARA
  (S33 B1) i `_senderLog` per NADAWCA, bez względu na adresata (K12). Klucz nadawcy
  idzie przez ten sam `_getSafeName`, więc „Tola" i „tola" to nadal jeden agent.
- **`checkSendAllowed(from, to, limit, senderLimit)`** zwraca
  `{allowed, count, limit, senderCount, senderLimit, reason?}`. `reason` mówi, KTÓRY
  sufit odmówił: `'pair'` (wąska para sprawdzana pierwsza) albo `'sender'`.
  `reserveSend` dopisuje do OBU map, `releaseSend` oddaje slot w OBU (błąd dysku nie
  zjada sufitu), `noteSend` też.
- **Limit:** `config/limits.js` → `kom_send_rate_max_sender` (default 40, min 1,
  sufit 2000), edytowalny w Settings → Limity obok limitu pary.
- **Komunikat odmowy rozróżnia oba przypadki** (`mcp.kom_send.rate_limit` vs
  `mcp.kom_send.rate_limit_sender`). Sufit nadawcy świadomie NIE radzi „napisz do kogoś
  innego" — wyczerpana jest cała pula agenta, więc taka rada byłaby zaproszeniem do obejścia.
- **User z panelu nadal bez limitu** — jego droga (`sendMessage('User', ...)` z
  `CommunicatorView`/`SendToAgentModal`) w ogóle nie przechodzi przez
  `reserveSend`. Nic tu nie zmienialiśmy; to własność strukturalna, nie wyjątek w kodzie.

Strażnicy: `modules/komunikator/KomunikatorManager.test.ts` (6 testów K12: 12 adresatów
poniżej limitu pary, wielkość liter, wygaszenie okna nadawcy, niezależność limitu pary,
zwrot slotu w obu licznikach, śmieciowy sufit → default) + `modules/tools/KomunikatorTools.test.ts`
(odmowa z innym komunikatem) + `config/limits.test.ts`.

## Fabryka napraw F5 (2026-09-01) — AUD-testy-022: kanał dyskowy `resolveHopFor` bez testu

Gotcha „Hop liczy `resolveHopFor`, nie `nextHopFor`" wyżej opisywała kontrakt (maksimum z rejestru
w pamięci i ŚWIEŻEGO odczytu własnej skrzynki z dysku — ten drugi kanał przeżywa restart pluginu),
ale sam kanał dyskowy (pętla po `_listMessagesStrict`, `KomunikatorManager.ts:349-355`) nie miał
ani jednej asercji: wszystkie ówczesne testy karmiły albo padnięty I/O (fail-closed na
`KOM_HOP_LIMIT`), albo skrzynkę bez folderu, a testy hopa w `KomunikatorTools.test.ts` budowały
łańcuch wyłącznie przez kanał PAMIĘCIOWY (`kom_read` w tej samej turze ustawia `noteRead` przed
`kom_send`). Bez pokrycia dyskowej połowy regresja w liczeniu `fromDisk` (np. zgubienie `+1` albo
złe porównanie `stamp`/`cutoff`) zostawiała cały pakiet testów zielonym, mimo że łańcuch odbić
przestawał przeżywać przeładowanie Obsidiana.

Dwa nowe testy w `KomunikatorManager.test.ts` (sekcja „AUD-testy-022"): świeża wiadomość na dysku
(`ai_read: true`, `hop: 2`, id `msg-<aktualny epoch>`, BEZ wołania `noteRead` — dokładna symulacja
stanu po restarcie) → `resolveHopFor` zwraca 3; ta sama wiadomość, ale zegar przesunięty poza
`KOM_HOP_TTL_MS` → 0. Zero zmian produkcyjnych — czysto dopisane pokrycie.

## Fabryka napraw B1 (2026-09-02) — AUD-dead-code-072/073/077/078/143

**072 (MEDIUM, bug funkcjonalny za maską dead-code):** `KomunikatorModal.css` importował
wyłącznie osierocony `KomunikatorModal.ts`, więc nie wchodził do `dist/main.js` — a ŻYWY
`KomunikatorCleanupModal` malował klasy `.komunikator-cleanup-*` bez ani jednej reguły w
zbudowanym pluginie (user widział zlepiony tekst listu w oknie „usuń/zostaw"). Naprawa:
arkusz przeniesiony i przycięty do WYŁĄCZNIE żywych reguł (`komunikator-cleanup-meta*`,
`-body`, `-buttons`), zaimportowany + `adoptSheet()`-owany w `KomunikatorCleanupModal.ts`
(jedyny plik, który tę część DOM-u rysuje — `CommunicatorView` używa zupełnie innej rodziny
klas, `cs-comm-*`, ze `SidebarViews.css`). Plik przemianowany na `KomunikatorCleanupModal.css`
(konwencja repo: nazwa arkusza = nazwa właściciela, wzór `AgentSidebar.ts`/`.css`).
Strażnik: `KomunikatorCleanupModal.css.test.ts` (KL-09 — pinuje import, `adoptSheet` i
1:1 klasa→reguła po źródle, nie po `dist/`).

**073 (LOW):** `KomunikatorModal.ts` (pełnoekranowy modal — lista agentów + skrzynka +
compose) potwierdzony jako sierota (zero importerów w kodzie/testach/barrelu; komentarz w
`index.ts` twierdzący że go zastąpił `CommunicatorView` był fałszywy) — **skasowany** razem
z arkuszem. `CommunicatorView` (sidebar) jest dziś jedynym UI komunikatora poza modalami
sprzątania.

**077 (LOW, tylko część komunikatorowa):** `MAX_MESSAGE_BYTES` i `formatMessageDate` w
`KomunikatorManager.ts` straciły `export` — test importuje tylko `buildMessageMarkdown`/
`parseMessage`/`setFrontmatterFlag`, tamte dwie miały czytelnika wyłącznie we własnym pliku.

**078/143 (INFO):** JSDoc w `CommunicatorView.ts:18` wskazywał `import('./SidebarNav.js')` —
pliku o tej nazwie w module nie ma. `SidebarNav` mieszka w `modules/shell/sidebar/`; ścieżka
poprawiona na `../shell/sidebar/SidebarNav.js` (wzór z `SkillDetailView.ts`/`SubAgentDetailView.ts`).

**142/240 (INFO, NIE naprawione tu — decyzja świadoma):** cztery martwe klucze i18n
(`communicator.new`, `communicator.subject_label`, `communicator.body_label`,
`communicator.send_error`) zostały po skasowanym `KomunikatorModal.ts`. Kasacja par pl/en w
`core/i18n/{pl,en}.ts` NIE jest zrobiona w tej sesji (poza zakresem — te pliki są cudzą
własnością), zgłoszona osobno.

**244 (INFO, bez zmian):** `css.d.ts` (jedyna w repo ambientowa deklaracja `*.css`) miała
przy tej czystce ryzyko wyjścia poza zasięg modułu, gdyby moduł stracił WSZYSTKIE własne
importy CSS. Nie stracił — `KomunikatorCleanupModal.ts` dalej importuje arkusz (przejął go
po `KomunikatorModal.ts`), więc `css.d.ts` ma nadal lokalnego konsumenta niezależnie od
czterech obcych modułów (`AgentSidebar.ts` ×2, `chat_ui.ts`, `HiddenFileEditorModal.ts`),
które i tak by go potrzebowały. `npm run typecheck` zielony po zmianach — deklaracja działa.

## Fabryka napraw W8 (2026-09-02) — AUD-wydajnosc-028/058/101/020/053

Audyt wydajności: odświeżenie sidebara (i `kom_send`/`kom_list`) czytało z dysku CAŁĄ
skrzynkę KAŻDEGO agenta, plik po pliku, sekwencyjnie — na realnym vaulcie Kuby (569
wiadomości/14 skrzynek) 1166 operacji fs na JEDEN render, powtarzane przy każdym zdarzeniu
(`communicator:message_sent`, `agent:updated`, ...), nawet gdy żadna skrzynka się nie
zmieniła. Naprawa w `KomunikatorManager.ts` (szczegóły mechaniki w Gotchas wyżej):

1. **Kesz nagłówków per skrzynka** (`_headerCache`), inwalidowany jawnie po każdej mutacji
   (`sendMessage`/`readMessage`/`markUserRead`/`markAiRead`/`deleteMessage`) — drugi i kolejny
   render NIEZMIENIONEJ skrzynki kosztuje ZERO operacji na dysku (zmierzone testem, nie tylko
   twierdzone).
2. **Zimny kesz buduje się przez `Promise.all`**, nie sekwencyjny `for`+`await`.
3. **`_readMessageFile` stracił zbędny `exists()` przed `read()`** — połowa operacji na plik.
4. **`kom_list` dostał twardy sufit `KOM_LIST_MAX = 50`** w `modules/tools/KomunikatorTools.ts`
   (osobny commit, moduł `tools` — reguła „nie dotykaj dwóch modułów w jednym commicie").

**Świadomie NIE zaimplementowane:** czytanie nagłówków przez `metadataCache.getFileCache()`
(jeden z trzech wariantów zaproponowanych w audycie, obok kesza w pamięci i `Promise.all`) —
wymagałoby przekazania `app`/`metadataCache` do konstruktora `KomunikatorManager` (dziś bierze
tylko `vault: VaultLike`), a to zmienia wołanie `new KomunikatorManager(...)` w
`modules/agents/AgentManager.ts`, spoza zakresu tej naprawy (właściciel: `modules/komunikator/`
+ wołacze `AgentSidebar`/`HomeView`/`KomunikatorTools`). Kesz w pamięci daje TĘ SAMĄ własność
(zero pełnych odczytów treści na trafienie) bez dotykania wiring'u AgentManagera — audyt sam
dopuszczał ten wariant jako „albo".

Testy (dowód mutacyjny, `KomunikatorManager.test.ts`, sekcja „AUD-wydajnosc-*"): atrapa vaulta
liczy realne wywołania `read`/`exists`/`list` przez `countingVault`; 5 skrzynek × 40 wiadomości
(200 plików) — drugi render niezmienionej skrzynki = 0/0/0 operacji; mutacja jednej skrzynki
inwaliduje TYLKO jej wpis (pozostałe 4 zostają darmowe); zimny kesz = 1 `read` na plik (bez
zdublowanego `exists()`). Bench przed/po (liczby operacji, nie czas zegarowy — sandbox bez
dostępu do realnego vaulta Kuby) w `scratchpad/fab/W8_bench.md` sesji roboczej.

### Follow-up tego samego dnia — review koordynatora obalił „wszystkie zapisy idą przez managera"

Pierwsza wersja tej naprawy zakładała, że jawna inwalidacja (punkt 1 wyżej) wystarcza, bo
„poczta jest create-only i WSZYSTKIE zapisy idą przez metody managera". **Założenie fałszywe**
(pełna korekta w gotcha „W8 follow-up" wyżej) — trzy realne kanały piszą do skrzynek Z
POMINIĘCIEM managera: sesje Claude Code przez kontrakt `/agent` (plik `msg-{epoch}.md` wprost
na dysk), synchronizacja Google Drive między urządzeniami Kuby, `obsidian-git pull`. Bez
dodatkowej ochrony kesz zamrażałby liczniki nieprzeczytanych do najbliższej mutacji PRZEZ
PLUGIN — regresja funkcjonalna (user nie widzi nowej poczty), nie tylko wydajnościowa.

Domknięcie w tym samym worktree (`fab-W8`), dwa commity:

5. **`KomunikatorManager.attachVaultEvents(registerEvent?)`** — nasłuch `create`/`modify`/
   `delete`/`rename` na `this.vault` (realny Obsidian `Vault` ma `.on`/`.offref`; atrapy
   testowe bez nich dostają no-op, `false`, zero wyjątku), inwaliduje kesz PO ŚCIEŻCE z
   eventu (`_invalidateInboxCacheByPath`), nie po nazwie agenta — handler dostaje surową
   ścieżkę z Obsidiana. `detachVaultEvents()` dla trybu bez `registerEvent` (harness/testy
   poza cyklem życia pluginu).
6. **`HEADER_CACHE_TTL_MS = 5000`** — druga, NIEZALEŻNA siatka: wpis w keszu starszy niż 5s
   liczy się jako pudło przy odczycie (`_listMessagesStrict`), niezależnie od tego, czy
   zdarzenie w ogóle przyszło. Chroni scenariusz, w którym klient synchronizacji podmienia
   plik BEZ budzenia `vault.on` (zależnie od implementacji — nie wszystkie narzędzia
   synchronizacji odpalają zdarzenia Obsidiana).
7. **`AgentManager` (osobny commit, moduł `agents`)** — jedyne miejsce z dostępem do
   `plugin.registerEvent` (Obsidian `Component`, auto-cleanup przy unload; `KomunikatorManager`
   sam go nie ma). Konstruktor woła `this.komunikatorManager?.attachVaultEvents?.(...)` zaraz
   po utworzeniu managera, wzorem `VaultIndexer._registerHooks`
   (`modules/embedding/VaultIndexer.ts`, ten sam kształt: `plugin`/`vault` jako zależności,
   leniwe podpięcie, `registerEvent` na każdy ref).

Testy follow-upu (`KomunikatorManager.test.ts`, prefiks „W8:"): TTL — zapis z zewnątrz na
atrapie BEZ `.on` staje się widoczny dopiero po `clock.advance(5001)`, nie wcześniej (dowód, że
przed TTL regresja BY WYSTĄPIŁA, gdyby nie ta naprawa); `attachVaultEvents` — zdarzenie
`create` inwaliduje kesz NATYCHMIAST, zegar nieprzesunięty (dowód, że to event, nie TTL);
`rename` inwaliduje OBIE ścieżki (starą i nową); atrapa bez `.on` nie wybucha; idempotencja
(drugie wołanie nie dubluje nasłuchu); tryb `registerEvent` vs tryb wewnętrznych refów +
`detachVaultEvents`. W `AgentManager.test.ts` (strażnik po źródle — plik importuje `obsidian`,
AVA nie wstawi klasy) — jeden test pilnuje, że konstruktor faktycznie woła
`komunikatorManager?.attachVaultEvents?.(...)` z `plugin?.registerEvent`, PO przypisaniu
`this.komunikatorManager` (kolejność).
