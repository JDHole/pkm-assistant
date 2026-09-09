# modules/agent-loop/

**Jedna wspólna pętla narzędziowa agenta - bez UI.** Wzorzec Anthropic z widocznym `for`: zapytaj model → jeśli są `tool_calls` wykonaj je i dopisz wyniki → powtórz; a na końcu twardy backstop (finalne zapytanie BEZ narzędzi).

**Po co jedna pętla:** czat i sub-agenci wołali kiedyś dwie osobne implementacje tool-callingu, które się rozjeżdżały zachowaniem. Dziś oba konsumenci (sub-agenci i czat) wołają `runAgentLoop`.

---

## Co tu jest

```
modules/agent-loop/
├── index.ts                     # publiczne drzwi (barrel) + eksport typów publicznych
├── CLAUDE.md                    # ten plik
├── AgentLoop.ts                 # runAgentLoop(opts) - widoczny for + backstop + estymacja usage
├── MessageStore.ts              # ArrayMessageStore - cienki interfejs transkryptu (kopia dla API / append*)
├── toolCallParser.ts            # parseToolCalls + splitConcatenatedToolCalls (kanon; 3 kształty + anty-sklejanie DeepSeek)
├── toolTranscriptSanitizer.ts   # pure sanitizer transkryptu
├── AgentLoop.test.ts               # testy pętli (mock model odgrywa scenariusze)
├── AgentLoop.abort.test.ts         # testy przerwania z zewnątrz
├── AgentLoop.streamRejection.test.ts # promisa zwrócona przez model.stream() jest obserwowana
├── toolCallParser.test.ts       # testy parsera (3 kształty + odsklejanie)
└── toolTranscriptSanitizer.test.ts # testy sanitizera strony „odsiewa" (filtr id/function.name, mieszanki, puste wiadomości)
```

Razem kilkadziesiąt testów w 5 plikach `*.test.ts`.

---

## Public API (`index.ts`)

| Export | Rola |
|---|---|
| `runAgentLoop(opts)` | Główna pętla. Zwraca `{finalText, toolsUsed, toolCallDetails, usage, iterations, stoppedBy}`. `stoppedBy`: `'natural'` \| `'backstop'` \| `'abort'`. |
| `ArrayMessageStore` | Domyślna implementacja `MessageStore` (tablica w pamięci). Sub-agenci jej używają. |
| `parseToolCalls(response, opts)` | Parser `tool_calls` z odpowiedzi modelu → płaskie `{id, name, arguments}`. 3 kształty: Anthropic content-blocks, root `tool_calls`, `choices[0].message.tool_calls`. Odsklejanie DeepSeek robi w środku. |
| `sanitizeToolTranscript(messages, opts)` | Pure sanitizer: usuwa osierocone `tool` messages i puste `tool_calls` przed wysyłką do API. |

`splitConcatenatedToolCalls` świadomie **nie jest** w barrelu - to szczegół implementacyjny `parseToolCalls` (anty-sklejanie DeepSeek: `"vault_readvault_read"` → 2 wywołania, `'{}{}'` → 2 argumenty), zero konsumentów spoza modułu. Funkcja żyje w `toolCallParser.ts`, jej testy deep-importują plik wprost.

### Sygnatura `runAgentLoop`

```js
runAgentLoop({
  model,            // { stream(payload, {chunk, done, error}) } - ChatModel; promisyfikowany wewnątrz
  store,            // MessageStore
  resolveTools,     // () => toolDefs[] - wołane NA START KAŻDEJ iteracji (świeża whitelista)
  executeToolCall,  // async (toolCall) => any - egzekutor; approval/permission żyje TU, nie w pętli
  limits,           // { maxIterations, minIterations=0, perCallTimeoutMs=0, maxToolResultLength=0,
                    //   stallTimeoutMs=0, salvageMaxChars=0 } - 0 = wyłączone
                    //   (stall = watchdog ciszy per call, chunk/gate przezbrajają budzik;
                    //   salvage = skrót dorobku narzędzi doklejany do zaślepki backstopu)
  modelOptions,     // { thinking, maxTokens, agentName, ...reszta } - dokładane do payloadu (agentName tylko do logów)
  hooks,            // punkty zaczepienia (niżej)
  callbacks,        // { chunk(resp) } - streaming do UI; default no-op
  shouldAbort,      // () => boolean - start iteracji, po powrocie modelu przed egzekucją ORAZ przed backstopem
  onGateAdmitted,   // () => void - „request wszedł na slot bramki"; fire-and-forget, przy KAŻDYM admicie
  log,              // opcjonalny logger zgodny z `core/utils/Logger.js`
})
```

### `MessageStore` - kontrakt

```js
getMessagesForAPI()                   // → wiadomości do wysyłki (kopia; kształt OpenAI)
appendAssistant(content, meta = {})   // meta: { tool_calls, reasoning_content }
appendToolResult(content, toolCallId) // rola 'tool'
appendUser(content, meta = {})        // nudge (min_iterations). ⚠️ hardstop backstopu tu NIE trafia
get messages()                        // surowa referencja (inspekcja/testy)
```

Adapter na `RollingWindow` (czat) istnieje: `RollingWindowMessageStore` w `modules/chat/chat/RollingWindowMessageStore.ts` implementuje ten sam kontrakt strukturalnie (`MessageStoreLike` - bez dziedziczenia po `ArrayMessageStore`) i `chat_streaming.ts` go realnie wstrzykuje do `runAgentLoop`. `ArrayMessageStore` (ten moduł) zostaje domyślną implementacją dla sub-agentów.

---

## TypeScript

Moduł jest w TypeScripcie. Co z tego wynika dla wołaczy:

- **Specyfikatory importów zostają z `.js`** (`from './MessageStore.js'`) - esbuild i tsx podstawiają rozszerzenie same. To konwencja całego repo, nie wyjątek tego modułu.
- **Barrel eksportuje też TYPY** (`export type`): `ModelResponse`, `ParsedToolCall`, `LoopMessage`, `MessageStoreLike`, `RunAgentLoopOptions`, `RunAgentLoopResult`, `Usage`. Konsumenci w TS mogą je zaimportować; w runtime `export type` znika przy transpilacji.
- **`store` jest typowany STRUKTURALNIE** (`MessageStoreLike`), nie klasą - czatowy `RollingWindowMessageStore` (dalej `.js`) pasuje bez żadnej deklaracji dziedziczenia.
- **Pola klas bez inicjalizatora deklarujemy `declare`** (patrz `ArrayMessageStore._messages`). Bez tego, przy `useDefineForClassFields: true` z `tsconfig.json`, esbuild wyemitowałby dodatkowe puste pole klasy - czyli zmianę emitowanego kodu.
- `splitConcatenatedToolCalls` dalej poza barrelem - testy deep-importują plik wprost.

---

## Kontrakt hooków

Wszystkie opcjonalne. To punkty zaczepienia dla przyszłych polityk PreToolUse/PostToolUse - pętla je TYLKO woła, NIE implementuje żadnych polityk.

**Każdy hook jest AWAITOWANY** (`await hooks.x?.(...)`) - może być sync albo async. Czat używa async `beforeContinue` (kompresja mid-loop przez `RollingWindow.performTwoPhaseCompression`). `await` na sync funkcji nic nie psuje.

| Hook | Kiedy | Uwaga |
|---|---|---|
| `onIterationStart(i)` | na starcie iteracji (po abort-check, przed modelem) | |
| `onToolCallsParsed(toolCalls, i)` | po parsowaniu, **PRZED egzekucją** (await sekwencyjny przed `Promise.all` - placeholdery i tak powstają przed egzekucją) | Czat tworzy tu placeholdery UI (kontrakt `ask_user`). Jeśli zwróci tablicę → użyta zamiast oryginalnej (forward-compat filtracja). Zwrot `[]` → tura kończy się czysto bez egzekucji. |
| `onToolResults(results, i)` | po `Promise.all`, **PO zapisie assistant+tool do store** | `results` w kolejności `tool_calls`: `[{toolCall, result, error?}]`. |
| `beforeContinue(i)` | przed kolejnym wywołaniem modelu, **pod bramką abortu** | Czat robi tu async kompresję + dopisuje nudges/queued message przez store. **Po Stopie NIE jest wołany.** |
| `onUsage(usage, i)` | po każdej odpowiedzi modelu z `usage` | Czat wepnie TokenTracker + cache badge. |
| `onBackstop()` | gdy wchodzi finalna iteracja bez narzędzi | |

### Wynik narzędzia: string vs tablica multimodalna

`executeToolCall` może zwrócić:
- **string** - zapisany jako `content` wiadomości `tool`, obcinany do `maxToolResultLength`.
- **inny typ** (obiekt) - `JSON.stringify` + obcinanie.
- **tablicę** (bloki content OpenAI, np. `[{type:'text'},{type:'image_url'}]`) - przechodzi BEZ stringifikacji i BEZ obcinania. Czat zwraca taką tablicę dla `generate_image`+model vision, żeby model „widział" wygenerowany obraz w kolejnej iteracji. Sub-agenci nigdy nie zwracają tablicy - dla nich zachowanie bez zmian.

---

## Trace (obserwowalność pętli)

`opts.trace` (opcjonalny) to funkcja z `TraceLog.scope(label)` (core). Pętla woła `trace?.(type, fields)` przy kluczowych zdarzeniach - **fire-and-forget**: NIGDY nie awaituje i nie owija w try (`TraceLog` sam jest fail-soft, a `!active` → no-op zero-kosztowy). Trace pisze po jednej suchej linii na zdarzenie do `.pkm-assistant/logs/trace.log`, żeby dało się prześledzić turę bez debuggera (agent testujący plugin z zewnątrz czyta pliki z dysku, nie konsolę).

**Dlaczego trace siedzi w PĘTLI, a nie w hookach:** hooki (`onToolCallsParsed`/`onToolResults`/…) to punkty polityk - podpina je konkretny konsument (czat w całości; sub-agenci TYLKO `beforeContinue`, patrz gotcha niżej). Gdyby trace jechał przez hooki, sub-agenci bez zarejestrowanego zadania (`SubTaskRegistry` - testy jednostkowe, stary bootstrap) nie mieliby żadnej obserwowalności, bo dla nich `hooks` bywa całkiem pominięte. Trace to infrastruktura obserwowalności, nie polityka - leży w pętli, więc czat i sub-agenci dostają go za darmo tą samą drogą, niezależnie od tego, ile hooków akurat podpięli.

| Zdarzenie | Kiedy | Pola |
|---|---|---|
| `loop.start` | wejście `runAgentLoop` | `max_iter`, `model` (gdy tani id dostępny) |
| `model.done` | po każdej odpowiedzi modelu (główna pętla + backstop) | `i`, `in`, `out` (albo `usage:'none'` gdy brak usage) |
| `tool.pre` | per narzędzie, po filtracji hooka, PRZED `Promise.all` | `i`, `tool`, `args` (surowe, przycinane do 200) |
| `tool.blocked` | gdy `onToolCallsParsed` coś odfiltrował | `i`, `dropped` (nazwy po przecinku) |
| `tool.post` | per narzędzie, po `Promise.all` | `i`, `tool`, `status` (`ok`/`error`), `chars` (lub `blocks` dla multimodal), `batch_ms` |
| `model.timeout` | per-call budzik strzelił (stop_stream + reject) | `timeout_ms` |
| `model.stall` | watchdog ciszy strzelił - PEŁNA cisza modelu przez `stallTimeoutMs` (stop_stream + reject) | `stall_ms` |
| `backstop` | wejście finalnej iteracji bez narzędzi | `after` (= `maxIterations`) |
| `loop.end` | każde wyjście pętli (`finalize()` + oba wyjścia backstopu + strażnik awarii trasy głównej) | `stop` (`natural`/`backstop`/`abort`/`error`), `iters`, `total_ms`, `fallback=1` (TYLKO gdy backstop oddał zaślepkę) |

> **`fallback=1` na `loop.end`.** Backstop ma DWA zejścia: model oddał podsumowanie albo finalny strzał padł i pętla zwraca 36-znakową zaślepkę `agentLoop.backstop_fallback`. Bez tego pola obie gałęzie zostawiały w trace identyczną linię `stop=backstop iters=N` i nie dało się policzyć, ile backstopów kończy się zaślepką. Pole dokładane jest **tylko przy zaślepce** - obie gałęzie backstopu (pusty `finalText` oraz `catch` po błędzie finalnego strzału) - więc linia UDANEGO backstopu zostaje bit w bit taka jak wcześniej.

> Uwaga: backstop OMIJA `finalize()`, więc `loop.end` jest emitowany osobno w obu gałęziach backstopu (sukces + catch) - inaczej wyjście przez backstop nie miałoby `loop.end`.

Konsumenci wstrzykują `trace`: czat (`modules/chat/chat/chat_streaming.js`, label `chat/<agent>#<8 znaków id sesji>`), sub-agenci (`modules/sub-agents/SubAgentRunner.js`, label `sub/<nazwa|rola>`). Sink pochodzi z `plugin.traceLog` (`TraceLog` + `LogFileSink`, init w `src/main.js`, toggle `pkmAssistant.traceEnabled`).

---

## Zachowania pętli

- **Sanityzacja transkryptu** (`sanitizeToolTranscript`) przed KAŻDYM wywołaniem modelu.
- **`resolveTools` na start każdej iteracji** - świeża whitelista (np. gdy uprawnienia się zmieniły).
- **`minIterations`** - model kończy bez `tool_calls`, a `i < minIterations` → wstrzykuje `assistant` + `user` „kontynuuj" i iteruje dalej.
- **Backstop pod bramką abortu** - przed wejściem w backstop pętla pyta `shouldAbort()`. Bez tego backstop był jedynym punktem trasy bez tego pytania: Stop kliknięty w trakcie narzędzi ostatniej iteracji przepuszczał jeszcze jedno pełne wywołanie modelu, a tura schodziła jako `backstop` - czyli u wołacza szła gałęzią finalizacji (wpis w oknie kontekstu + dziennik sesji), nie gałęzią abortu.
- **Backstop pod bramką abortu z obu stron** - samo domknięcie wejścia nie wystarczało. Stop kliknięty, gdy finalny strzał JUŻ LECI (trwa dziesiątki sekund - naturalny moment, bo user właśnie widzi, że agent kręci się w kółko), wpadał do `catch` backstopu, a ten - inaczej niż `catch` pętli głównej - nie pytał o abort. Dziś obie gałęzie backstopu pytają: po powrocie modelu (`abort()`) i w `catch` (`abort() || err._aborted`), i schodzą przez `finalize(lastText,'abort')`.
- **Hardstop backstopu NIE trafia do transkryptu** - instrukcja „NIE wywołuj żadnych narzędzi" jedzie doklejona do `apiMessages` finalnego strzału, a nie przez `store.appendUser`. Gdyby trafiała do store'a, zostawałaby w oknie rozmowy NA STAŁE: czat rysuje rolę `user` jako dymek usera (polecenie, którego nie napisał), a `getMessagesForAPI()` wiozłoby ją w każdym kolejnym żądaniu tej sesji. Dokładasz nowy dopisek „tylko dla modelu"? **Payload, nie store.**
- **Backstop** - po wyczerpaniu `maxIterations` finalne zapytanie BEZ pola `tools`; model MUSI odpowiedzieć tekstem. Czyszczenie halucynowanych tagów (`DSML`/`function_calls`/`invoke`). Własny timeout + fallback text. Gdy backstop oddaje zaślepkę (pusty tekst / błąd finalnego strzału), a `limits.salvageMaxChars > 0`, zaślepka niesie skrót dorobku narzędzi z transkryptu (`_fallbackWithSalvage`: per wynik nagłówek `### <nazwa> <args≤200>` + treść, budżet dzielony po równo, podłoga 400 znaków/wpis). Trace `fallback=1` bez zmian - salvage to nadal fallback, nie synteza.
- **Watchdog ciszy** - `limits.stallTimeoutMs > 0` uzbraja w `_streamOnce` trzeci budzik: strzela po PEŁNEJ ciszy modelu (zero chunków przez `stallTimeoutMs`), każdy chunk i sygnał `gate_admitted` przezbrajają go. Strzał = `stop_stream` + trace `model.stall` + reject (komunikat `agentLoop.model_stall`). Odróżnia trupa (martwy socket mostu) od myśliciela (wolny model reasoning, który streamuje choćby podsumowania rozumowania) - zegar ścienny zadania zostaje AWARYJNYM sufitem. Suby dostają go z `subagent_stall_timeout_ms` (default 180 s); czat ma własny, starszy watchdog w `chat_streaming`.
- **Orphan guard** - rekonstrukcja `tool_calls` do store z przefiltrowanych wywołań (`id` + `name`); jeśli po filtracji 0 poprawnych a były wyniki → koniec tury czysto (nie wysyłamy malformed sekwencji).
- **Obcinanie wyniku narzędzia** do `maxToolResultLength` PRZED `appendToolResult` (wspólny punkt).
- **Estymacja `usage`** - fallback gdy API nie zwraca `usage` w streaming (znaki → tokeny).
- **`reasoning_content`** - jeśli odpowiedź go ma, trafia w meta do `store.appendAssistant` (DeepSeek Reasoner tego wymaga).

---

## Gotchas

1. **Kierunek zależności twardy:** agent-loop **NIE** importuje z `modules/chat`, `modules/sub-agents`, `modules/tools`. Dozwolone tylko `core/`, `config/` i lokalne pliki. Konsumenci: `sub-agents → agent-loop`, `tools → agent-loop`, `chat → agent-loop`.
2. **`ask_user` wymaga synchronicznego `onToolCallsParsed` PRZED egzekucją** - czat musi zdążyć utworzyć placeholder pytania w UI zanim egzekutor zablokuje się na odpowiedzi usera. Nie przenoś tego hooka za `Promise.all`.
3. **Approval/permission NIE w pętli** - żyje w `executeToolCall` (egzekutorze). Pętla nie zna uprawnień; sub-agent robi fail-closed whitelist check w swoim `_executeTool`.
4. **Sanitizer wylądował TUTAJ, nie w memory** - bo docelowo `chat/sub-agents/tools → agent-loop`, a `agent-loop → memory` byłoby odwróceniem kierunku. `modules/chat/chat/RollingWindow.js`, jedyny wołacz, importuje `sanitizeToolTranscript` wprost z TEGO barrela. Efekt uboczny: `RollingWindow` nie ma statycznej krawędzi na `modules/memory`.
5. **`stoppedBy`** rozróżnia trzy wyjścia: `natural` (model skończył sam / orphan-clean-end), `backstop` (wyczerpano iteracje), `abort` (`shouldAbort` albo przerwanie streamu z zewnątrz - patrz gotcha 7). **Czwartej wartości pętla NIE ZNA** - przy wyjątku po prostu rzuca dalej. `'error'` dokłada dopiero `SubAgentRunner` w swoim `catch`, bo to on jest właścicielem zwrotki suba.
6. **Sub-agenci podpinają NAJWYŻEJ JEDEN hook** - `beforeContinue` (doręczanie wiadomości od usera między iteracjami) - i TYLKO gdy `SubAgentRunner` ma `registry` ORAZ `subTask` (bieg zarejestrowany w `SubTaskRegistry`, czyli normalny bootstrap produkcyjny przez panel biegów). Bez rejestru (testy jednostkowe, stary bootstrap) `SubAgentRunner` w ogóle nie przekazuje `hooks` do `runAgentLoop`. Reszta hooków dalej należy wyłącznie do czatu. Sekcja „Trace" wyżej uzasadnia, czemu trace siedzi w pętli a nie w hookach właśnie tym: obserwowalność musi działać także dla wołacza, który akurat nie podpiął żadnego hooka.
7. **Przerwanie ≠ awaria.** Gdy `_streamOnce` odrzuca, pętla najpierw pyta o dwa dowody przerwania: `shouldAbort()` ORAZ znacznik `_aborted` na błędzie (dokłada go `ChatModel.stop_stream`, patrz `modules/models/CLAUDE.md` gotcha o strumieniach). Jeśli którykolwiek jest prawdą - pętla kończy `finalize(lastText, 'abort')`, czyli `loop.end stop=abort` w trace i **bez rzucania**. Dzięki temu runner domyka bieg jako `aborted` („Przerwany"), a nie jako błąd. Dwa dowody, bo `shouldAbort` bywa niedostępne (nie każdy wołacz go podaje), a znacznik jest zawsze. ⚠️ Kontrola negatywna jest równie ważna: zwykły błąd modelu (502, socket) dalej leci w górę jako wyjątek z `loop.end stop=error`, a per-call timeout dalej wygrywa swój wyścig i kończy turę błędem - oba przypadki mają testy w `AgentLoop.abort.test.ts`.
8. **`onGateAdmitted` to PRZELOT sygnału, nie polityka.** Handler `gate_admitted` robi dwie rzeczy: przezbraja per-call budzik (jak dotąd) i woła `onGateAdmitted` wołacza. Pętla nie wie, po co komu ten sygnał - `DelegateTool` przezbraja nim budżet CAŁEGO zadania, żeby czekanie w kolejce bramki nie zjadało czasu na robotę. Wołanie jest fire-and-forget: wyjątek wołacza ląduje w `log.warn` i nie wywraca streamu. Modele bez bramki wołają `gate_admitted` natychmiast (kontrakt `ChatModel`), więc chmura zachowuje się tak samo jak platforma lokalna.
9. **`shouldAbort` ma czytać stan TURY, nie stan widoku.** Pętla pyta go w PIĘCIU punktach (start iteracji, po powrocie modelu, po narzędziach - przed `beforeContinue`, przed backstopem, po finalnym strzale backstopu + w obu `catch`), ale sama nie ma jak sprawdzić, czy predykat mówi o TEJ turze. Gdy czat trzymał przerwanie w jednym polu, które każda kolejna wiadomość zerowała - zatrzymana pętla po powrocie z długiego narzędzia widziała „brak przerwania" i wznawiała iteracje. Kontrakt dla każdego wołacza: jedna tura = jeden uchwyt przerwania (`modules/chat/chat/turnAbort.ts` po stronie czatu, `AbortController` w `DelegateTool` po stronie subów), zatrzaskiwany i nigdy nie zerowany z zewnątrz.
10. **Stop blokuje KONTYNUACJĘ tury, nie księgowanie dorobku.** Po `Promise.all` pętla najpierw dopisuje assistant+tool do store i woła `onToolResults` (u czatu: dziennik `mcp_call`, aktualizacja chipów narzędzi), a DOPIERO POTEM pyta `abort()` przed `beforeContinue`. Dlaczego tak: `beforeContinue` czatu potrafi odpalić `performTwoPhaseCompression` - OSOBNE wywołanie modelu (inna instancja niż ta ubita przez `stop_stream`) plus fire-and-forget zapis notatek do `agent/brain/`. Tego po Stopie być nie może. Ale wynik narzędzia, które JUŻ zmieniło vault, musi zostać w transkrypcie - inaczej model przy następnej turze go nie widzi i potrafi zapis powtórzyć (ten sam kontrakt, co salvage wyżej).
11. **Korpus iteracji jest pod JEDNYM `try`.** Wyjątek z hooka, `resolveTools` albo store'a emituje `loop.end stop=error` + `logger.groupEnd()` i leci dalej w górę. Wewnętrzny `catch` wokół modelu już nie emituje `loop.end` sam - oddaje błąd zewnętrznemu strażnikowi, żeby nie było dwóch linii domknięcia na jeden bieg. `stoppedBy:'error'` dalej nie istnieje (gotcha 5) - `stop=error` żyje wyłącznie w trace. ⚠️ Ciało pętli świadomie NIE jest przewcięte o poziom.
12. **`_stripHallucinatedToolTags` wymaga SPÓJNEGO wariantu otwarcia/zamknięcia dla `invoke`.** Regex miał kiedyś otwarcie `<invoke` bez przestrzeni nazw, ale zamknięcie zaszyte na sztywno jako `</invoke>` - żaden realny wariant halucynacji (model emituje ALBO oba tagi bez namespace'u, ALBO oba z nim) nie dopasowywał się do CAŁOŚCI wzorca, więc gałąź nigdy nie czyściła bloku mimo komentarza funkcji, który to obiecywał. Dziś backreferencja (`<((?:antml:)?invoke)\b[\s\S]*?<\/\1>`) wymusza TEN SAM wariant po obu stronach. **Dokładasz kolejny halucynowany kształt tagu do tej funkcji?** Sprawdź testem oba warianty namespace'u (`AgentLoop.test.ts`, testy „backstop: halucynowany <invoke>…") - sama obecność komentarza „usuwa X" nie jest dowodem, że regex to robi.

---

## Testy

- `AgentLoop.test.ts` - mock model odgrywa scenariusze: natural end, 2 iteracje z narzędziami, backstop, minIterations, orphan guard (hook `[]` + malformed id), abort (start + po modelu), timeout, agregacja/estymacja usage, obcinanie wyniku, filtracja `onToolCallsParsed`, `reasoning_content`. Rekonstrukcja `apiToolCalls` sprawdzana na obie strony filtra `tc.id && (tc.name || tc.function?.name)` - wpis z id ale bez OBU nazw odpada, wpis z SAMĄ `function.name` (kształt niespłaszczony z hooka) zostaje.
- `AgentLoop.abort.test.ts` - przerwanie z zewnątrz: znacznik `_aborted` → `stoppedBy:'abort'`, `shouldAbort` przykrywa błąd bez znacznika, kontrola negatywna (zwykły błąd rzuca, per-call timeout wygrywa wyścig) + przelot `onGateAdmitted`. Stop w trakcie narzędzi ostatniej iteracji nie przepuszcza backstopu (zero dodatkowych wywołań modelu, `stop=abort` w trace) i narzędzia następnej iteracji się nie wykonują. Pokryte też: Stop w trakcie FINALNEGO strzału backstopu, zarówno gdy strzał ODRZUCA jak i gdy WRACA SUKCESEM tuż po Stopie, `beforeContinue` pominięty po Stopie przy zachowanym dorobku, `loop.end stop=error` przy wyjątku z hooka i z `resolveTools`, hardstop backstopu w payloadzie zamiast w transkrypcie.
- `AgentLoop.streamRejection.test.ts` - promisa zwrócona przez `model.stream()` (adapter produkcyjny jest `async`, kontrakt `LoopModelLike.stream()` deklaruje `: void`). Pilnuje, żeby `_streamOnce` dalej obserwował tę promisę (`Promise.resolve(...).catch(reject)`) - bez tego odrzucenie ląduje jako `ERR_UNHANDLED_REJECTION` w Node. Sama flaga `wasObserved()` na atrapie nie wystarczała - asymilacja JS (`Promise.resolve(thenable)`) woła `.then()` atrapy NIEZALEŻNIE od tego, czy ktoś doczepił `.catch` do wyniku, więc test przechodził nawet z wyciętym `.catch(reject)`. Drugi test jest `test.serial` i pinuje SKUTEK wprost: `process.on('unhandledRejection')` wokół wywołania, asercja `t.deepEqual(unhandled, [])`.
- `toolCallParser.test.ts` - 3 kształty odpowiedzi + odsklejanie DeepSeek. Fallback id w kształcie 3 (`choices[0].message.tool_calls`) niesie suffiks indeksu pozycji (`call_<ts>_<i>`) - dwa `tool_calls` bez `id` w JEDNEJ odpowiedzi (pętla synchroniczna, ta sama milisekunda) dostają RÓŻNE id zamiast kolidować.
- `toolTranscriptSanitizer.test.ts` - sanitizer, jedyna bramka przed KAŻDYM wywołaniem modelu. Strona „odsiewa": wpis `tool_calls` bez `id`, wpis bez `function.name`, MIESZANKA poprawny+niepoprawny w jednej wiadomości (poprawny zostaje, sierota po odrzuconym wpisie wypada kaskadowo z gałęzi orphan-tool), pusta wiadomość, kontrola pozytywna.

`npm test` (AVA). Build: `npm run build`.
