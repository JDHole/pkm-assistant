# modules/komunikator/

> Fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej to specyfikatory
> importów, które celowo zostają `.js`.

**Prosta poczta między agentami.** Jeden filar: **skrzynka per agent, plik per wiadomość** w vaulcie. Agent może wysłać wiadomość (`kom_send`), przejrzeć nagłówki swojej skrzynki (`kom_list`) i przeczytać jedną (`kom_read`). Nic więcej - moduł nie obsługuje projektów, wątków, briefów ani embedów.

**Status:** 🚀 **ACTIVE**. Flaga `pkmAssistant.komunikatorEnabled` **domyślnie ON**, z przełącznikiem w Settings → Zaawansowane.

> **Model „skrzynka pull", nie czat.** Agenci NIE gadają ze sobą autonomicznie - wiadomość leży w skrzynce, dopóki adresat sam do niej nie zajrzy przy swojej następnej sesji. To cecha, nie brak.

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

- **Klucze po polsku** (`od`/`do`/`temat`/`data`) - spójnie z artefaktami vaulta. Flagi statusu techniczne (`user_read`/`ai_read`).
- **`ALL_READ` = `user_read && ai_read`** - **liczone, nigdy zapisywane** (jedno źródło prawdy).
- „Ile nowych?" = policz pliki z `ai_read: false` w folderze. Zero regexów na treści.
- `safeName` = `name.toLowerCase().replace(/[^a-z0-9]/g,'_')`.
- Wartości nagłówka przechodzą przez `JSON.stringify` - cudzysłów/dwukropek/nowa linia w temacie nie rozwali frontmattera.
- **Brak outboxów** - informacja o nadawcy żyje w polu `od` u adresata.
- **Plik per wiadomość, nie jeden plik skrzynki** - jednoplikowa skrzynka jest krucha: regex na całej treści, twardy reset przy przekroczeniu rozmiaru, a status zacytowany w treści wiadomości potrafi zmylić parser.

---

## Co tu jest

```
modules/komunikator/
├── CLAUDE.md                     # ten plik
├── index.js                      # public API
├── types.js                      # kontrakty współdzielone: MessageHeader/Message/MessageFrontmatter/VaultLike
├── KomunikatorManager.js         # store skrzynki + pure helpery parsera
├── KomunikatorManager.test.js    # CRUD, statusy, kolizja ts, traversal, liczniki, sygnał ALL_READ
├── visibility.js                 # PURE - kto uczestniczy w komunikatorze
├── visibility.test.js
├── cleanupQueue.js               # PURE - kolejka modali sprzątania (jeden na raz)
├── cleanupQueue.test.js
├── KomunikatorCleanupModal.js    # modal podglądu + hurtowe potwierdzenie + registerKomunikatorCleanup
├── KomunikatorCleanupModal.css   # style modali sprzątania
├── KomunikatorCleanupModal.css.test.js  # strażnik: klasa malowana w .ts ⇒ reguła w .css
├── css.d.ts                      # deklaracja modułu `*.css` (import jako CSSStyleSheet)
└── CommunicatorView.js           # sidebar Crystal Soul (chipy agentów + akordeon + compose) - jedyny widok komunikatora poza modalami sprzątania
```

---

## Public API (`index.js`)

```js
import {
  KomunikatorManager,
  renderCommunicatorView,
  // sprzątanie (rejestracja nasłuchu; modale otwiera moduł sam)
  registerKomunikatorCleanup,
  // niewidzialność (PURE, bez obsidian)
  isKomunikatorVisible, listKomunikatorAgents, findKomunikatorAgent,
  // wyłącznik globalny
  isKomunikatorEnabled,
} from 'modules/komunikator/index.js';
```

> Kilka eksportów nie wchodzi do barrela (zero konsumentów spoza modułu):
> `KomunikatorCleanupModal`/`KomunikatorBulkDeleteModal`, `CleanupQueue`,
> `listKomunikatorAgentNames`. **Definicje ŻYJĄ w bebechach** - modale sprzątania
> i kolejkę wpina `registerKomunikatorCleanup` (event `communicator:message_all_read`),
> `CommunicatorView` otwiera `KomunikatorBulkDeleteModal` (guzik hurtowy), a listy nazw
> wołacze składają sobie z `listKomunikatorAgents()`. Testy deep-importują pliki wprost.

### `KomunikatorManager` (instancja w `agentManager.komunikatorManager`)

| Metoda | Po co |
|---|---|
| `sendMessage(from, to, subject, content, {hop})` | create-only POD LOCKIEM skrzynki; kolizja timestampu → sufiks `-1`, `-2`… → `{success, id, path}` |
| `withLock(key, fn)` / `withAgentLock(agent, fn)` | serializacja operacji poczty (FIFO, wywrotka nie zatyka kolejki) |
| `reserveSend` / `releaseSend` | ATOMOWA rezerwacja slotu rate-limitu i jej zwrot przy padnietym zapisie |
| `resolveHopFor(agent)` | hop ze stanu Z CHWILI WYSYLKI (pamiec + swiezy odczyt skrzynki), fail-closed |
| `listMessages(agentName)` | nagłówki, **najnowsze pierwsze** (`{id, from, to, subject, date, userRead, aiRead, allRead}`); **keszowane per skrzynka**, zero odczytu dysku na trafienie (patrz Gotchas) |
| `getMessage(agentName, id)` | podgląd treści **BEZ zmiany statusów** - ścieżka UI |
| `readMessage(agentName, id)` | treść + **auto `ai_read: true`** - ścieżka agenta (`kom_read`) |
| `markUserRead` / `markAiRead` | pojedynczy ptaszek (jedna edycja jednego pliku) |
| `deleteMessage(agentName, id)` | **twarde** usunięcie; woła WYŁĄCZNIE UI |
| `getUnreadCount` / `getAiUnreadCount` / `getUnreadCounts` | badge UI (user-unread) / ping (ai-unread) / batch |
| `getInboxPing(agentName)` | `{count, senders[]}` - dane pingu sesji, **zero treści** |
| `listAllRead(agentName)` | kandydaci guzika „Usuń przeczytane" |

Pure helpery eksportowane z pliku (dla testów): `buildMessageMarkdown`, `parseMessage`, `setFrontmatterFlag`.
`formatMessageDate` i `MAX_MESSAGE_BYTES` **nie są eksportowane** - żaden test ani konsument spoza pliku po nie nie sięga.

**Eventy** (przez `agentManager._emit`): `communicator:message_updated` po każdej mutacji + `communicator:message_all_read` gdy wiadomość dostanie DRUGI ptaszek (na tym siedzi modal sprzątania). UI słucha też `communicator:message_sent` / `message_read`.

---

## Trzy narzędzia agenta (`modules/tools/KomunikatorTools.js`)

| Narzędzie | Światło | Co robi |
|---|---|---|
| `kom_send(to, subject, content)` | **YELLOW** (toggle approvalu, default „pytaj") | JEDEN adresat na wywołanie; wielu = model woła w pętli |
| `kom_list()` | GREEN | nagłówki WŁASNEJ skrzynki, bez treści |
| `kom_read(id)` | GREEN | treść jednej wiadomości + auto-ptaszek `ai_read` |

- **Create-only:** agent NIE MA narzędzia kasowania poczty. Sprząta user.
- **Tożsamość z `_invocationAgentName`** (wstrzykuje `MCPClient`) - model nie podrobi nadawcy ani właściciela skrzynki.
- `kom_send` jest YELLOW mimo akcji `agent.message` (która ogólnie jest RED): jawny wyjątek narzędziowy w `classifyToolRisk` **musi** stać PRZED szeroką regułą - wzór `artifact_update` vs `write`.
- **Czwarte narzędzie poczty nazywa się `agent_delegate`** i mieszka w grupie `delegation`, ale
  wysyła list tym samym `sendAgentMail` - więc ma akcję `agent.message`, żółte światło
  i **ten sam przełącznik zgody co `kom_send`** (user, który wyciszył pocztę, wycisza obie drogi).
  Podlega też osi poczty wołającego: bez `kom_send` w profilu nie zostawi listu w cudzej skrzynce.

---

## Niewidzialność per agent

Pole agenta **`komunikator_visible`** (default `true`, serializowane tylko gdy `false` - wzór `admin_access`). Toggle: profil → **Uprawnienia** → grupa Komunikator → „Uczestniczy w komunikatorze".

Wyłączony agent jest **duchem w obie strony**:
- nie ma go na liście adresatów (UI compose, `SendToAgentModal`) ani w błędzie „dostępni: …",
- jego skrzynka znika z pasków agentów (`CommunicatorView`) i z chipów Home,
- `kom_send` do niego zwraca **dokładnie ten sam błąd co literówka** w nazwie („nieznany adresat") - zero przecieku, że istnieje,
- sam też nie wysyła i nie czyta: jego `kom_*` zwracają uczciwy powód, który widzi **tylko on**,
- ping o jego skrzynce milczy.

**Jedno źródło prawdy:** pure `visibility.js`. Narzędzia i UI **nie importują go wprost** - czytają przez `AgentManager` (`isKomunikatorVisible` / `listKomunikatorAgents` / `findKomunikatorAgent`), żeby `modules/tools/` nie wciągnęło obsidian-owego barrela.

---

## Ping sesji

`AgentManager.getInboxPing(agent)` → `{count, senders}` albo `null`. Trafia do promptu jako `ctx.inboxPing` i renderuje się jako **JEDNA linijka** na dole drzewa decyzyjnego (`PromptBuilder._injectInboxNotification`):

> `SKRZYNKA: masz 3 nieprzeczytanych wiadomości (od: Klara, Sonny). Zajrzyj, kiedy uznasz to za istotne.`

Zero treści, zero ścieżek do plików, zero „przeczytaj to teraz". `count === 0` → **żadnej linijki** (nie zaśmiecamy promptu ani prefiksu cache). Reakcję na ping opisuje reguła rdzenia `kom_inbox` (`decisionTree.js`).

---

## Sprzątanie pół-automatem

**Bez kosza - usuwanie twarde.**

1. Mutacja statusu sprawia, że wiadomość ma OBA ptaszki → `communicator:message_all_read` → modal z **pełnym podglądem** (od/do/temat/data/treść) + „Usuń" / „Zostaw". Esc/krzyżyk = „Zostaw" (nic nie znika bez jawnej decyzji).
2. Kilka naraz → **kolejka** (`cleanupQueue.js`), jeden modal na raz, dedupe po `agent+id`, wywrotka modala nie zatyka kolejki.
3. „Zostaw" → wiadomość leży jako przeczytana; sprzątnie ją **guzik hurtowy** „Usuń przeczytane" w sidebarze (kasuje wszystkie ALL_READ bez podglądu, z jednym zbiorczym potwierdzeniem).

Podpięcie: `registerKomunikatorCleanup(plugin)` w `src/main.js` za flagą; `onunload` odpina nasłuch i porzuca kolejkę.

---

## Wyłącznik globalny

`settings.pkmAssistant.komunikatorEnabled` - **default `true`**, przełącznik w **Settings → Zaawansowane**. Helper `isKomunikatorEnabled(settings)` = `settings?.pkmAssistant?.komunikatorEnabled !== false` (brak pola w starym `data.json` = włączone).

Gdy `false`:
- `AgentManager.komunikatorManager === null` (wszystkie callsite'y są `?.`-safe),
- `kom_send`/`kom_list`/`kom_read` niezarejestrowane w `main.js` (agent ich nie widzi),
- serwer `komunikator` znika z katalogu (`resolveBuiltinManifests({komunikatorEnabled:false})`),
- sekcja „Komunikator" w `HomeView` schowana, `CommunicatorView` pokazuje uczciwy komunikat,
- **dane usera NIETKNIĘTE.**

Flaga czytana **przy starcie** → zmiana wymaga przeładowania pluginu (nota przy przełączniku). Strażnicy: `modules/tools/built-in-servers.test.js` + `core/selftest.js` (przeciek w obie strony: OFF z `kom_*` = ERROR, ON bez kompletu poczty = ERROR).

---

## Limity i bezpieczniki wysyłki

Poczta agentów ma dwa niezależne bezpieczniki przeciw pętli „agent odpisuje agentowi", oba
**w warstwie narzędzia** (`kom_send`), ze stanem w managerze - **user piszący z panelu
komunikatora nie podlega żadnemu z nich.**

### Rate-limit

`checkSendAllowed(from, to, limit, senderLimit)` + `noteSend(from, to)` - okno
`KOM_RATE_WINDOW_MS` (10 min), z **dwoma liczącymi na to samo okno**:

- `_sendLog` - licznik **per para nadawca→adresat** (klucz przez `_getSafeName`, więc „Tola" i
  „TOLA" to jeden nadawca). Limit: `config/limits.js` → `kom_send_rate_max` (default 20, min 1,
  sufit 500).
- `_senderLog` - drugi sufit, licznik **per NADAWCA bez względu na adresata**. Limit per para sam
  nie wystarcza: agent może rozesłać `kom_send_rate_max` × liczbę adresatów, mieszcząc się w
  każdej parze z osobna (np. 20 × 12 agentów = 240 listów w 10 minut). Limit: `config/limits.js` →
  `kom_send_rate_max_sender` (default 40, min 1, sufit 2000).

Oba limity edytowalne w Settings → Limity. `checkSendAllowed` zwraca
`{allowed, count, limit, senderCount, senderLimit, reason?}` - `reason` mówi, KTÓRY sufit odmówił:
`'pair'` (wąska para sprawdzana pierwsza) albo `'sender'`, z różnymi komunikatami
(`mcp.kom_send.rate_limit` vs `mcp.kom_send.rate_limit_sender`). `reserveSend` dopisuje do OBU map,
`releaseSend` oddaje slot w OBU (błąd dysku nie zjada sufitu), `noteSend` też. Sufit nadawcy
świadomie NIE radzi „napisz do kogoś innego" - wyczerpana jest cała pula agenta, taka rada byłaby
zaproszeniem do obejścia.

Stan żyje **wyłącznie w pamięci** - restart pluginu = czyste konto. Świadomie: to bezpiecznik
rozpędzonej sesji, nie kwota dzienna. **User z panelu nadal bez limitu** - jego droga
(`sendMessage('User', ...)` z `CommunicatorView`/`SendToAgentModal`) w ogóle nie przechodzi przez
`reserveSend`; to własność strukturalna, nie wyjątek w kodzie.

### Licznik odbić (hop)

Pole frontmattera **`hop`** (liczba, default 0; stare wiadomości bez pola = 0). `readMessage`
(czyli `kom_read` - ścieżka AGENTA, **nie** `getMessage` z UI) odnotowuje `noteRead(agent, hop)`;
`nextHopFor(agent)` daje `maxPrzeczytany + 1`. Przy `hop >= KOM_HOP_LIMIT` (3) `kom_send` odmawia
i każe oddać sprawę userowi. Łańcuch: A→B(0) → B→C(1) → C→A(2) → STOP.

- **Granica „sesji" to TTL, nie hook.** Z warstwy narzędzia nie ma czym uczciwie zmierzyć „nowej
  rozmowy" - zamiast wiązać pocztę z chatem i pamięcią liczymy odczyty **świeże**: starsze niż
  `KOM_HOP_TTL_MS` (30 min) nie budują łańcucha.
- **Zegar jest wstrzykiwalny:** `new KomunikatorManager(vault, agentManager, { now })` - testy
  rate-limitu i TTL nie czekają realnych minut.
- **Kolejność kontroli w `kom_send`:** tożsamość → widoczność adresata (błąd „nieznany adresat"
  **bez zmian**, ma pierwszeństwo) → self → hop → rate-limit → wysyłka. Limity liczą się dopiero
  dla ROZWIĄZANYCH adresatów, więc odmowa nigdy nie zdradza, że jakiś duch istnieje.
- `sendMessage(from, to, subject, content, { hop })` - piąty argument opcjonalny; brak = 0.

Strażnicy: testy w `KomunikatorManager.test.ts` i `KomunikatorTools.test.ts` (rate-limit pary i
nadawcy, zwrot slotu w obu licznikach, wygaszenie okna, śmieciowy sufit → default) oraz
`config/limits.test.ts`.

---

## Zależności

**Importuje z:** `core/utils/Logger.js`, `core/i18n/index.js`, `core/security/keySanitizer.js` (`sanitizePath`), `core/utils/yamlParser.js` (`parseFrontmatter`), `modules/crystal-soul/index.js` (UI), `obsidian` (Modal, Notice).

**Importowany przez:**
- `modules/agents/AgentManager.js` - tworzy `KomunikatorManager` (za flagą) + deleguje helpery widoczności
- `src/main.js` - `isKomunikatorEnabled` + `registerKomunikatorCleanup`
- `modules/shell/AgentSidebar.js` - rejestruje `renderCommunicatorView`
- `modules/shell/sidebar/HomeView.js` - sekcja Komunikator za flagą
- `modules/shell/SendToAgentModal.js` - `sendMessage` przez `agentManager.komunikatorManager`
- `modules/tools/KomunikatorTools.js` - **bez importu**, wszystko przez `agentManager`

**Brak deep imports.** Wszystko przez `index.js` (wyjątek: testy, które celowo sięgają po pure helpery).

---

## Gotchas

- ⚠️ **Pola wiadomości NA STAŁE po polsku** (`od`/`do`/`temat`/`data`) - to format pliku, nie UI. Język interfejsu (i18n) się zmienia, klucze frontmattera NIE.
- ⚠️ **`ALL_READ` nigdy nie jest zapisywane** - liczysz je z dwóch flag. Nie dodawaj pola do frontmattera.
- ⚠️ **Chip agenta ma TRZY stany, nie dwa.** Badge z liczbą = są nieprzeczytane, brak
  badge'a = potwierdzone zero, `?` = licznika NIE POLICZONO (błąd leci do `log.warn`). Naiwny
  `catch {}` w `CommunicatorView.renderAgentStrip` zamieniłby awarię odczytu skrzynki w wygląd
  „brak nowych" - stąd trzeci stan.
- ⚠️ **Widok Komunikatora w sidebarze odpina się przez `nav.dispose()`.** Sprzątanie
  (`unsub` + `clearTimeout` budzika 150 ms) wisi na `nav._currentCleanup`, a wołacz przy zamknięciu
  panelu żyje w `AgentSidebar.onClose()` - patrz `modules/shell/CLAUDE.md`, gotcha 9.
- ⚠️ **`readMessage` odhacza `ai_read`, `getMessage` NIE.** UI musi wołać `getMessage` - inaczej samo otwarcie karty w sidebarze udawałoby, że agent przeczytał wiadomość.
- ⚠️ **`deleteMessage` woła TYLKO UI.** Gdyby kiedyś kusiło dołożyć `kom_delete` - to jest świadoma decyzja, nie przeoczenie.
- ⚠️ **`id` przychodzi od LLM** (`kom_read`) - `_getMessagePath` odrzuca wszystko spoza wzorca `msg-<ts>[-n]` i przepuszcza ścieżkę przez `sanitizePath` PIERWSZY (core/CLAUDE.md gotcha #4).
- ⚠️ **Zero kodu migracji ze starego formatu.** Stare `inbox_*.md` i `projects/` po prostu leżą w vaulcie i są niewidoczne dla bieżącego formatu - user kasuje je ręcznie.
- ⚠️ **Bramki poczty musza byc ATOMOWE - jedna odpowiedz modelu leci przez `Promise.all`.**
  `withLock(key, fn)` w managerze serializuje operacje: `agent:<safeName>` (poczta jednego agenta:
  `kom_send` i `kom_read` tej samej tury po kolei) i `inbox:<dir>` (dobor nazwy pliku + zapis).
  Rate-limit rezerwuje slot **synchronicznie** (`reserveSend`, zero `await` w srodku) PRZED zapisem,
  a nieudany zapis oddaje go przez `releaseSend`. **Nie wracaj do wzorca „sprawdz → await → zapisz"** -
  przy równoległych `kom_send` ten wzorzec przepuszcza bramkę kompletem (dziesięć równoległych
  wywołań mieści się w limicie z osobna).
- ⚠️ **CREATE-ONLY jest asercja, nie zalozeniem.** `adapter.write` nadpisuje bez pytania, wiec
  `sendMessage` sprawdza `_probe` jeszcze raz tuz przed zapisem - pod lockiem skrzynki. Kolizja
  `Date.now()` przy wsadzie jest realna (mierzona), a nadpisany list znikal razem z potwierdzeniem
  `success: true` dla obu nadawcow.
- ⚠️ **`_probe` ma TRZY stany, nie dwa.** Naiwne `try { exists() } catch { return false }`
  zamienia każdy wyjątek I/O w ciche „nazwa wolna", bez linii w logu, i ta sama wartość zasilałaby
  pętlę doboru sufiksu ORAZ bramkę tuz przed zapisem. Zamiast tego idzie to przez `probeFile`
  (`core/index.js`): zapis przepuszcza **wylacznie potwierdzone `'missing'`**, a `'unknown'`
  (sprawdzenie padlo) to **odmowa fail-closed** - nadawca dostaje `success: false` i moze ponowic
  (stempel sie zmieni). Nie „upraszczaj" tego z powrotem do boola.
- ⚠️ **Hop liczy `resolveHopFor`, nie `nextHopFor`.** `nextHopFor` to sam rejestr w pamieci, ktory
  zapisuje sie dopiero dwa `await` w glab `readMessage`. `resolveHopFor` bierze maksimum z rejestru
  i ze SWIEZEGO odczytu wlasnej skrzynki (listy `ai_read` doreczone w oknie `KOM_HOP_TTL_MS`),
  a przy braku danych zwraca `KOM_HOP_LIMIT` - **fail-closed**.
- ⚠️ **Jedna droga do skrzynki: `sendAgentMail` z `modules/tools/KomunikatorTools.ts`.** `kom_send`
  I `agent_delegate` wolaja te sama funkcje, wiec filtr ducha (nadawca I adresat), rate-limit
  i licznik odbic sa liczone raz. Gdyby doszla trzecia droga wysylki - ma isc tamtedy, a nie wprost
  do `KomunikatorManager.sendMessage` - inaczej ominie komplet bramek. `sendMessage` wprost woła
  TYLKO UI (user z panelu), ktory swiadomie nie podlega limitom agenta.
- ⚠️ **Kontrakt KAŻDEJ drogi do skrzynki to komplet czterech rzeczy** - (1) **oś poczty
  WOŁAJĄCEGO** (`toolRegistry.checkToolAxis(<agent z runtime>, 'kom_send')` jako pierwszy warunek
  w `sendAgentMail`), (2) **widoczność** obu stron (filtr ducha), (3) **limity** (hop +
  rate-limit), (4) **zgoda usera jak przy `kom_send`** (akcja `agent.message`, żółte światło,
  przełącznik `kom_send`). Pominięcie (1) i (4) pozwala agentowi z WŁĄCZONĄ delegacją i
  WYŁĄCZONĄ pocztą (domyślny stan świeżego profilu) deponować tekst modelu w cudzej skrzynce bez
  pytania. **Nowa droga do skrzynki dziedziczy komplet za darmo - o ile idzie przez
  `sendAgentMail` i ma wpis w `ACTION_TYPE_MAP` mówiący `agent.message`.**
- ⚠️ **`KomunikatorManager` przyjmuje `agentManager` jako 2. opcjonalny arg** (default `null`) - w testach emit jest no-op.
- ⚠️ **Komunikaty managera żyją w namespace `komunikator.*`, NIE `communicator.*`.**
  `communicator.*` to warstwa UI (sidebar, modale sprzątania), a `komunikator.*` to zdania samego
  store'u - widzi je I user w `Notice` (przez `res.error` w `CommunicatorView`), I model w polu
  `error` narzędzi `kom_send`/`kom_read`. Bez klucza w słowniku `t()` oddaje sam klucz i na ekranie
  stoi napis „komunikator.invalid_recipient" - parytet pl↔en tego nie łapie (brak w OBU plikach
  jest „zgodny"), więc pilnuje tego **skan źródeł** w `core/i18n/parity.test.ts` („każdy
  `t('literał')` w `modules/komunikator/` ma klucz w pl i en"). `modules/tools/KomunikatorTools.ts`
  też woła `komunikator.message_not_found` - przy zmianie nazwy klucza pamiętaj o tamtym pliku.
- ⚠️ **`readMessage` melduje ze STANU DYSKU, nie z zamiaru.** Pad zapisu ptaszka `ai_read`
  (`_setFlag` → `false`) kończy się `{success: false, error: komunikator.mark_read_failed}` i
  `log.warn` - **treść listu NIE wraca**, bo `kom_read` i tak zrzuca wynik przy `success:false`, a
  nieoznaczona wiadomość to nie jest wiadomość odebrana. Gdyby wynik `_setFlag` był ignorowany,
  model dostawałby „przeczytane" + treść, a na dysku zostawałoby `ai_read: false` - `getAiUnreadCount`
  dalej liczyłby 1 i ping wracałby w KAŻDEJ turze, agent czytałby ten sam list w kółko. **Nie
  „upraszczaj" tego z powrotem do `await this._setFlag(...)` bez czytania wyniku.**
- ⚠️ **`_listMessagesStrict` keszuje nagłówki per skrzynka** (`_headerCache: Map<dir, {headers, at}>`)
  **- nie czyta dysku na trafienie.** Bez kesza każde wywołanie (`getUnreadCount`, `kom_list`,
  `resolveHopFor`, sidebar Home) czytałoby z dysku CAŁĄ skrzynkę, plik po pliku, sekwencyjnym
  `for`+`await`, nawet gdy nic się nie zmieniło od poprzedniego renderu - na dużym vaultcie (setki
  wiadomości w kilkunastu skrzynkach) to grozi tysiącem+ operacji fs na JEDEN render sidebara. Kesz
  buduje się RAZ przez `Promise.all` (nie sekwencyjnie) i żyje, dopóki `_invalidateInboxCache(agentName)`
  go nie zdejmie - wołane po KAŻDEJ udanej mutacji tej skrzynki (`sendMessage` → adresat,
  `readMessage`/`markUserRead`/`markAiRead`/`deleteMessage` → właściciel). **Kontrakt: KAŻDA nowa
  mutacja skrzynki PRZEZ TEN MANAGER musi inwalidować kesz po udanym zapisie.**
  > ⚠️ Jawna inwalidacja łapie TYLKO mutacje przez ten manager. Skrzynki bywają zapisywane też z
  > pominięciem managera: sesje Claude Code piszą do skrzynek wprost na dysk (nowy plik
  > `msg-{epoch}.md`, edycja `ai_read` - kontrakt `/agent`), vault bywa synchronizowany między
  > urządzeniami (pliki pojawiają się/zmieniają bez udziału pluginu), `git pull` też potrafi
  > podmienić pliki. Bez dodatkowej ochrony kesz zamrażałby liczniki do najbliższej mutacji PRZEZ
  > PLUGIN - realna regresja funkcjonalna (user nie widzi nowej poczty), nie tylko wydajnościowa.
  > Dlatego są dwie NIEZALEŻNE siatki bezpieczeństwa, patrz gotcha niżej.
- ⚠️ **`attachVaultEvents(registerEvent?)` - nasłuch `create`/`modify`/`delete`/`rename` na
  `this.vault` dla ścieżek pod `INBOX_PATH`, PLUS `HEADER_CACHE_TTL_MS = 5000` jako siatka
  niezależna od zdarzeń.** Dwa kanały ochrony przed zapisami Z ZEWNĄTRZ: (1) zdarzenie vaulta
  inwaliduje kesz NATYCHMIAST, gdy `this.vault` ma realny event API (`.on`/`.offref` - Obsidian
  `Vault` ma; atrapy testowe zwykle nie); (2) TTL ≤5s gwarantuje, że NAWET BEZ zdarzenia (nasłuch
  niepodpięty, klient sync nie budzi `vault.on`) kesz nie żyje wiecznie. `_listMessagesStrict`
  traktuje wpis starszy niż TTL jako pudło, nie hit. **Kto wywołuje `attachVaultEvents`:**
  `KomunikatorManager` sam NIE MA dostępu do `plugin.registerEvent` (Obsidian `Component`,
  potrzebny do właściwego sprzątania nasłuchu przy unload) - woła go `AgentManager` w
  konstruktorze, zaraz po utworzeniu `komunikatorManager`, wzorem `VaultIndexer._registerHooks`
  (`modules/embedding/VaultIndexer.ts`). Bez `registerEvent` (np. w harnessie/testach bez pełnego
  cyklu życia pluginu) referencje trzyma sam manager - odepnij ręcznie przez
  `detachVaultEvents()`. Atrapa vaulta bez `.on` → `attachVaultEvents` zwraca `false`, no-op, BEZ
  wyjątku - TTL zostaje jedyną ochroną (dokładnie tak wygląda większość testów w
  `KomunikatorManager.test.ts`, gdzie `fakeVault()` celowo nie ma event API).
- ⚠️ **`_readMessageFile` NIE robi `exists()` przed `read()`** - ten sam wzorzec co przy innych
  odczytach plików w tym repo (dyski sieciowe/synchronizowane potrafią kłamać w `exists()`).
  Brakujący plik i padnięty odczyt dają identyczny skutek (`null` + `log.warn`), więc jedno
  `try/catch` na `read()` wystarcza. **Dir-level `exists()` w `_listMessagesStrict` ZOSTAJE**
  (sprawdza czy skrzynka w ogóle istnieje, jedno wywołanie na render, nie na plik).
- ⚠️ **`kom_list` (`modules/tools/KomunikatorTools.ts`) ma twardy sufit `KOM_LIST_MAX = 50`** -
  skrzynka bez ewikcji rosłaby bez ograniczenia razem z kosztem tokenów tury. Newest-first z
  `listMessages` gwarantuje, że obcięcie zostawia zawsze najświeższe. Wynik ≤ 50 wiadomości jest
  BAJT W BAJT jak bez cięcia (bez nowych pól); > 50 dokłada `{total, truncated:true}`. `unread`
  liczy się z CAŁEJ skrzynki, nie z widoku - to jedna liczba, tania nawet bez cięcia. **Manager
  (`listMessages`) sam NIE tnie** - sufit żyje w warstwie narzędzia, bo inne wołacze managera
  (`listAllRead`, `getInboxPing`, `getAiUnreadCount`) potrzebują KOMPLETU do poprawnego liczenia.
- ⚠️ **`_ensureInboxDir` ma DWA powody porażki, nie jeden.** Zwraca `{dir}` albo `{dir: null,
  reason: 'invalid_recipient' | 'inbox_unavailable'}`. Pierwszy to walidacja nazwy (`_getInboxDir`
  → `null`), drugi to pad `mkdir`. `sendMessage` mapuje je na RÓŻNE komunikaty - awaria dysku
  zgłoszona jako „nieznany adresat" byłaby diagnozą nieprawdziwą (w drodze przez `sendAgentMail`
  adresat jest już rozwiązany jako istniejący i widoczny), model wnioskowałby, że agenta nie ma, i
  rezygnował.

---

## TODO

- 🟡 limity ilościowe skrzynki - świadomie odłożone

## Powiązane

- [`modules/agents/CLAUDE.md`](../agents/CLAUDE.md) - `komunikator_visible`, helpery widoczności, ping w prompcie
- [`modules/tools/CLAUDE.md`](../tools/CLAUDE.md) - 3 narzędzia poczty + światła ryzyka
- [`modules/prompts/CLAUDE.md`](../prompts/CLAUDE.md) - reguła `kom_inbox` + ping
