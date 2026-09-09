# modules/models/

**Modele czatu - jedna klasa modelu + dziewięciu bezstanowych dostawców.** Uniwersalna warstwa
nad dziewięcioma platformami: Anthropic, OpenAI, DeepSeek, Gemini, Groq, Ollama, OpenRouter,
xAI, LM Studio. `ChatModel` to JEDYNY obiekt, jaki reszta pluginu trzyma w ręku;
`modelResolver` jest fabryką instancji per rola (main / researcher / sub_worker; `minion` =
legacy alias przyjmowany jeszcze jeden release).

> ✅ **Moduł kompletny.** `ChatModel`, `registry`, `capabilities` i wszystkich dziewięciu
> dostawców (baza kształtu OpenAI + openai, deepseek, groq, lm_studio, anthropic, gemini,
> ollama, open_router, xai) mają REALNE implementacje. Zero `not implemented` w źródłach
> modułu poza jednym komentarzem opisowym w `testing/harness.ts`, dotyczącym atrap testowych,
> nie kodu produkcyjnego. Pokryty testami (`npx ava "modules/models/**/*.test.ts"`).

**Status:** 🚀 **ACTIVE**.

---

## Co tu jest

```
modules/models/
├── index.ts                     # publiczne drzwi (barrel)
├── contracts.ts                 # KONTRAKT modułu: typy, interfejsy, stałe pinowane testami
├── CLAUDE.md                    # ten plik
├── ChatModel.ts                 # klasa modelu: bramka, trzy wyjścia streamu, polityka 429, Stop
├── registry.ts                  # PROVIDER_INFO (metryczki) + CHAT_PROVIDERS + resolveProvider
├── modelResolver.ts             # fabryka per rola - pięciostopniowa drabinka (logika WŁASNA)
├── requestGate.ts               # bramka równoległości per platforma (logika WŁASNA, 1:1)
├── ReasoningTagFilter.ts        # maszyna stanów `<think>…</think>` + rezerwa + rollback
├── capabilities.ts              # isVisionModel - czy model umie w obraz
├── cache_utils.ts               # limity wyjścia + metadane cache promptu (logika WŁASNA)
├── semanticStatusText.ts        # status indeksu semantycznego jako czysta funkcja (bez obsidian)
├── SettingsContent.ts           # render sekcji „Modele" w Ustawieniach
├── SettingsSection.ts           # rejestracja sekcji w rejestrze shella
├── testing/harness.ts           # atrapy testów modułu (NIE kod produkcyjny, AVA go nie odpala)
└── providers/                   # dziewięciu dostawców, jeden plik = jedna platforma
    ├── OpenAiCompatibleProvider.ts   # baza sześciu dostawców kształtu OpenAI
    ├── openai.ts  deepseek.ts  groq.ts  lm_studio.ts  open_router.ts  xai.ts
    ├── anthropic.ts                  # Messages API (własny kształt)
    ├── gemini.ts                     # generateContent (własny kształt, strumień = TABLICA JSON)
    └── ollama.ts                     # /api/chat, NDJSON (własny kształt)
```

**Czego tu NIE MA:** transportu HTTP. `HttpClient`, `StreamTransport`, parsery ramek
(`SseFrames`, `NdjsonFrames`) i `STREAM_TRANSPORT_TIMEOUT_MS` mieszkają w **`core/http/`** -
potrzebują ich DWA moduły (`models` i `embedding`), a moduły nie importują się nawzajem po
bebechach. Ten moduł je KONSUMUJE przez `core/index.js` (wstrzykiwane w `ChatModelDeps`).

---

## Public API (`index.ts`)

**Wartości:**

| Eksport | Po co |
|---|---|
| `createModelForRole(plugin, role, agent?, delegateConfig?, callerSkipCache?)` | Fabryka modelu per rola - pięciostopniowa drabinka + cache instancji |
| `getModelsForRole(pkmSettings, role)` | Lista modeli dla roli z biblioteki modeli |
| `isLocalPlatform(platform)` | `true` dla `ollama`/`lm_studio` (dane zostają na maszynie usera) |
| `clearModelCache()` | Czyści cache instancji (zmiana ustawień, przełączenie agenta) |
| `createChatModel(deps)` / `ChatModel` | Model z zależności - jedyna droga jego powstania |
| `CHAT_PROVIDERS` / `PROVIDER_INFO` | Rejestr dostawców + ich metryczki (dla `config/runtimeConfig.ts`) |
| `buildCacheMetadata(usage)` | Metadane cache promptu składane przez konsumentów |
| `isVisionModel(model)` | Czy model obsługuje obraz (decyzja o stripie multimodalnym) |
| `registerSettings(registry)` | Rejestracja sekcji „Modele" w Ustawieniach |

**Typy** wychodzą tym samym barrelem przez `export type` - wszystkie z `contracts.ts`.

⚠️ **Barrel NIE re-eksportuje transportu ani `NormalizedError`/`ChatSettingsSlice`** - te
wychodzą z `core/index.js`. Druga droga do tego samego typu to pierwszy krok do rozjazdu.

---

## Zależności

| Co używa models | Po co |
|---|---|
| `config/runtimeConfig.ts` | Składa `RuntimeConfig.chat = { providers, http, transport }` |
| `modules/chat/chat/chat_model.ts` | `createModelForRole` + slot runtime `env.chatModel` |
| `modules/chat/chat/chat_streaming.ts` | `isLocalPlatform` + Stop przez `stopStream()` |
| `modules/tools/DelegateTool.ts` | Model per sub-agent + `_gatePriority` / `_streamGateLimit` |
| `modules/tools/WebReadTool.ts` | Model roli `researcher` do streszczania stron |
| `modules/agents/AgentManager.ts` | `clearModelCache` przy zmianie agenta |
| `modules/shell/pkm_settings_tab.ts` | `getModelsForRole`, `isLocalPlatform` w UI Ustawień |
| `modules/agents/profile/profile_advanced.ts`, `modules/sub-agents/SubAgentEditorModal.ts` | `getModelsForRole` w pickerach |
| harness (osobne repo, https://github.com/JDHole/pkm-assistant-harness) | Podmiana dostawców na harnessowe (adres fake-serwera) |

**Models zależy od:** `core/index.js` (transport HTTP, `normalizeError`, typy ustawień,
rejestr sekcji), `core/i18n`, `core/utils/Logger`. **Zero `obsidian`** - cały moduł wstaje
w gołym Node.

---

## Gotchas (CZYTAJ ZANIM COKOLWIEK ZMIENISZ)

### 🔴 1. `ChatModel.stream()` NIE jest concurrent-safe

Stan tury (bilet bramki, uchwyt odrzucenia, dekoder) żyje NA INSTANCJI. Dwa równoległe
`stream()` na jednej instancji to wyścig. Mitygacja: `modelResolver` pomija cache dla ról
sub (`skipCache = (effectiveRole !== 'main') || isSubWorker || callerSkipCache`).

⚠️ **Rola `main` też potrafi się zderzyć** - dwa taby tego samego agenta albo tura +
konsolidacja pamięci w tle. Dlatego `createModelForRole` ma PIĄTY parametr `callerSkipCache`:
wymusza świeżą instancję TEŻ dla `main`, bez kasowania istniejącego wpisu w cache.

### 🔴 1b. `complete()` ma WŁASNY bilet bramki - nie dotyka tury strumienia

Instancja nie jest concurrent-safe (gotcha 1), ale nikt wołaczom nie zabrania odpalić
`complete()` na modelu, na którym akurat leci `stream()`. Do integracji fali 1 `complete()`
zerowało wtedy `_gateTicket` biegnącej tury - a tura zwalnia slot WŁAŚNIE przez to pole, więc
na platformie lokalnej (pojemność 1) slot zostawał zajęty na zawsze i kolejka stawała.

Dziś tor bez strumienia rozlicza się polem `_completeTicket` i lokalną zmienną „wjechał", nie
rusza ani `_gateTicket`, ani `_admitted`, ani `_gateReleaseScheduled`. `stopStream()` anuluje
też ten bilet, ale `cancel()` z kontraktu bramki rusza WYŁĄCZNIE bilet czekający w kolejce -
żądanie już lecące po sieci dokończy i zwolni slot samo. Strażnik: `ChatModel.concurrent.test.ts`
(„complete() nie zabiera biletu biegnącej turze strumienia").

### 🔴 1c. Host z ogonem `/v1` nie może dać `/v1/v1/...`

User wpisuje w Ustawieniach adres tak, jak go widzi w dokumentacji - a dokumentacja LM Studio
pokazuje `http://localhost:1234/v1`. `joinUrl` w `OpenAiCompatibleProvider` zdejmuje więc
wspólny kawałek między ogonem hosta a początkiem ścieżki, licząc CAŁYMI SEGMENTAMI
(`https://v1.example.com` nie ma nic wspólnego ze ścieżką `/v1/…`, choć kończy się tymi samymi
znakami). Bez tego jedyną informacją zwrotną dla usera było 404 „model nie odpowiada".
Strażnik: `providers/openAiCompatibleRequest.test.ts` (cztery testy adresu czatu).

### 🔴 2. Bramka platform lokalnych ma PRIORYTET: główny czat przed sub-agentem

`_gatePriority` - wyższa liczba wchodzi z kolejki pierwsza; **brak pola = 1** („to główny
czat"), nie 0. `DelegateTool` zbija ŚWIEŻEJ instancji suba `_gatePriority = 0`. Bramki
chmurowe (limit 0) priorytet ignorują - tam nie ma kolejki.

Pojemność: `pkmAssistant.limits.local_platform_max_concurrent` (default 1, min 1, sufit 10).

### 🔴 3. `stopStream()` ROZSTRZYGA promisę streamu (znacznik `_aborted`)

Przerwanie transportu NIE emituje żadnego zdarzenia - ani końca, ani błędu. Bez tego promisa
`stream()` wisiałaby do budzika pętli, a bieg kończył się jako „błąd / Model timeout" zamiast
„Przerwany".

- Uchwyt odrzucenia jest **jednorazowy**, przerwanie transportu **bezwarunkowe**.
- Błąd niesie `_aborted === true` + komunikat z i18n (`model.stream_aborted`).
- Slot bramki zwalnia się także wtedy, gdy dostawca nigdy nie settluje.
- Bilet CZEKAJĄCY w kolejce rozstrzyga się osobno - `GateCancelledError`, fraza
  „anulowany w kolejce", BEZ `_aborted`.
- **Kolejność jest kontraktem:** odrzucenie ze `stopStream` idzie łańcuchem mikrozadań, więc
  synchroniczny budzik pętli dalej wygrywa swój wyścig (parytet, pinowane w `AgentLoop`).
- Najpierw budzi okno backoffu 429, dopiero potem przerywa transport - po Stopie NIE wolno
  polecieć kolejnemu, PŁATNEMU żądaniu.

### 🔴 4. `stream()` ma TRZY wyjścia

1. **sentinel platformy** (zdarzenie `done` dekodera) - pełna treść, zero ostrzeżeń;
2. **domknięcie transportu przy HTTP 200 BEZ sentinela** - `log.warn('stream.closed_without_sentinel')`
   + `handlers.done` + resolve tym, co przyszło; przy ZEROWEJ treści reject zdaniem;
3. **błąd** - `handlers.error` **oraz** odrzucenie promisy TYM SAMYM obiektem (obie drogi).

Sentinel przybyły RAZEM z domknięciem połączenia **wygrywa** - decyzja o „zamknięciu bez
sentinela" musi być odroczona o jedno makrozadanie, a flaga „zdecydowano" zapada przy WEJŚCIU
w ścieżkę, nie przy `resolve`.

### 🔴 4b. `stream.chunk_parse_failed` leci TYLKO z licznika `droppedFrames`

Ostrzeżenie o nieczytelnej porcji zapadało dawniej z heurystyki „porcja miała domkniętą linię,
a zdarzeń zero". W kształcie OpenAI to opis DWÓCH całkiem poprawnych ramek KAŻDEJ tury -
pierwszej (`delta:{role:"assistant",content:""}`) i przedostatniej (`delta:{}` +
`finish_reason`) - więc user dostawał 2 fałszywe alarmy na każdą odpowiedź modelu.

Dziś śmiecia zgłasza ten, kto go widzi: dekoder zlicza wyrzucone ramki w `droppedFrames`
(opcjonalne pole {@link StreamDecoder}), a `ChatModel` porównuje licznik przed i po `feed()`.
Warn leci, gdy dekoder RZUCIŁ albo licznik urósł. Sama pustka po `feed()` nie znaczy nic -
ramka mogła jeszcze nie dojechać albo po prostu nic nie nieść.

Nowy dostawca ze WŁASNYM koszem (`catch` przy `JSON.parse`, pominięta linia) musi ten licznik
podbijać, inaczej jego zepsute ramki znikną po cichu. Strażnicy: dwa testy „008/052"
w `ChatModel.streamExits.test.ts` - jeden pilnuje, że śmieć zostawia log, drugi, że poprawna
ramka bez zdarzeń go NIE zostawia.

### 🔴 5. Sentinele rozpoznaje się STRUKTURALNIE, nie podciągiem

- DeepSeek / LM Studio: `data: [DONE]` dopasowaniem DOKŁADNYM - model piszący „[DONE]"
  w treści NIE kończy strumienia.
- Ollama: `done_reason` LUB `done === true` z WYPARSOWANEJ ostatniej linii NDJSON.
- Gemini: `finishReason` z wyparsowanego kandydata; strumień to TABLICA JSON, nie linie SSE,
  a dwa obiekty zlepione w jednej porcji → liczy się OSTATNI.

### 🔴 6. `tool_calls` akumuluje się PO INDEKSIE, nie po kolejności

Slot wybiera `delta.tool_calls[].index` (OpenAI) albo `chunk.index` bloku (Anthropic). Bramka
zakresu `[0, TOOL_CALL_MAX_INDEX)`: indeks ujemny, ułamkowy i ≥ 64 lądują w slocie 0 i NIE mogą
rzucić ani pchać pustych slotów pętlą.

**NAZWA W SLOCIE SKLEJA SIĘ, nie nadpisuje** (`mergeToolName` w `ChatModel.ts`).
DeepSeek Reasoner potrafi wypchnąć DWA wywołania na TYM SAMYM indeksie (`read` z własnymi
argumentami, zaraz po nim `list` z własnymi). Nadpisanie zostawiało jedno wywołanie o nazwie
DRUGIEGO i ciele `{…}{…}` - pierwsze narzędzie znikało po cichu, a to, które zostało, dostawało
cudze argumenty. Sklejanie daje `readlist` + `{…}{…}`, czyli kształt, który rozkleja kanon pętli
(`splitConcatenatedToolCalls` + `_decomposeToolName` w `modules/agent-loop`). Powtórzenie TEJ
SAMEJ nazwy w kolejnej delcie NIE dokleja się drugi raz (`read` + `read` ≠ `readread`).
Strażnicy: `ChatModel.toolCallNames.test.ts` + scenariusz testowy `10_sklejone_tool_calls`.

### 🔴 7. Sekrety w błędach

Gdy strumień pada BEZ CIAŁA, do normalizacji NIE wolno podać obiektu żądania ani zdarzenia
transportu. Buduj własny krótki komunikat (`Stream error (HTTP 503)` / `(no response)`)
i zachowaj `http_status`. Klucz API nie może pojawić się w `handlers.error`, w odrzuceniu
promisy ani w logu; słowo `bearer` też nie.

### 🔴 8. `stream_options: { include_usage: true }` jest OPT-IN

Włączone dla `openai` i `deepseek` (`ChatProviderInfo.streamUsage`). Wysłanie go do Groqa,
OpenRoutera czy LM Studio kończy się 400. Anthropic/Gemini/Ollama mają własny kształt żądania
i nie dostają go w ogóle.

`usage` bez danych zostaje **PUSTYM OBIEKTEM** (nie `undefined`, nie zera) - pusty obiekt jest
sygnałem dla pętli „estymuj".

### 🔴 9. Anthropic: `usage` jest w DWÓCH miejscach, a trzy liczniki są ROZŁĄCZNE

`message_start` niesie `message.usage` (input + oba liczniki cache + PLACEHOLDER
`output_tokens` - POMIJAĆ), `message_delta` niesie `usage` na poziomie głównym. Merge, nie
nadpisanie. `prompt_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- u Anthropica te trzy są rozłączne, a konwencja OpenAI zakłada, że cache jest PODZBIOREM.

### 🔴 10. `<think>` - dwie reguły i rezerwa

1. Tag uzbraja parser **TYLKO na początku wiadomości** (przed nim wyłącznie biel). Tag po
   widocznej treści zostaje TEKSTEM - model PISZĄCY o znaczniku nie może stracić zdania.
2. Znacznik **niedomknięty** do końca strumienia NIE był myśleniem: treść wraca do `content`,
   a `reasoning_content` jest KASOWANE (`undefined`), nie zerowane pustym stringiem.
3. Rezerwa ≤ 8 znaków na tag rozcięty między porcje; `finish()` MUSI ją dopchnąć.
4. Natywne myślenie dostawcy (`delta.reasoning`, `delta.reasoning_content`, `message.thinking`)
   przechodzi nietknięte i WYŁĄCZA parser tagów od pierwszej porcji.

Zwrotka `stream()` jest **kopią** snapshotu - `finish()` nie może zmutować obiektu, który
poszedł już do `handlers.chunk`.

### 🔴 11. xAI nie streamuje - `streamMode: 'complete'`

`app://obsidian.md` nie dostaje nagłówków CORS od api.x.ai, więc transport strumieniowy jest
blokowany. `stream()` emuluje strumień JEDNYM wywołaniem `complete()`: `chunk` z całą treścią →
AWAITOWANE `done` → resolve. To WŁAŚCIWOŚĆ DOSTAWCY, nie podmiana klasy w composition roocie
(dawna podklasa w `src/main.ts` zniknęła).

### 🟠 12. Multimodal strip respektuje i18n

Wiadomość user złożona z samego obrazu na modelu bez vision idzie jako
`t('model.image_stripped')` - nie blokuje wysyłki. Wiadomość MIESZANA traci TYLKO blok obrazu.
Klucze modułu: `model.stream_aborted`, `model.image_stripped`.

### 🟠 13. Step 4b (fallback ról sub) musi znać `agent.models.main`, nie tylko legacy `agent.model`

`models` NIE MOŻE importować z `agents` (`agents` już importuje `models`; odwrotny kierunek
zapętliłby moduły), więc normalizacja `"platforma/model"` żyje tu jako świadoma, jednorazowa
kopia tej samej normalizacji, którą po swojej stronie ma `modelFieldSync.ts`.

⚠️ Jeśli kiedyś dojdzie kolejne „kanoniczne" pole per-agenta, musi wejść do Step 4b tą samą
drogą - inaczej role sub cicho tracą model dla configów, które go faktycznie mają.

### 🟠 14. Nieznana platforma NIE rzuca

`azure`, `custom`, `google` mogą wciąż leżeć w starym `settings.json` - te platformy nigdy nie
zostały automatycznie zmigrowane. `resolveProvider` spada na PIERWSZY wpis rejestru, a
`modelResolver` bez wpisu w `DEFAULT_MODELS` zwraca cicho `null` + `log.debug`.

### 🟡 15. Sekcja „Modele" nie ma już guzika migracji starego indeksu

Cały podsystem migracji danych indeksu v1.x jest **skasowany, nie przemianowany**. Nie
dochodzą też żadne nowe klucze i18n.

---

## Testy modułu

| Plik | Co pilnuje |
|---|---|
| `ChatModel.streamExits.test.ts` | Trzy wyjścia streamu, błąd w paśmie, zepsuta porcja, sufit 429, twardy timeout |
| `ChatModel.stopStream.test.ts` | Semantyka Stopu (`_aborted`, idempotencja, slot bramki, kolejka) |
| `ChatModel.concurrent.test.ts` | Bramka lokalna, cooldown zwolnienia slotu (seam czasu, zero pomiarów zegara) |
| `ChatModel.retry.test.ts` | Backoff wykładniczy + `Retry-After` (seam `scheduleRetry`) |
| `ChatModel.gate.test.ts` | Co model PODAJE bramce: klucz, pojemność, priorytet |
| `ChatModel.complete.test.ts` | Tor bez strumienia + normalizacja błędu dostawcy |
| `ChatModel.errors.test.ts` | Sekrety nie wychodzą do konsumenta ani do logu |
| `ChatModel.notifications.test.ts` | Moduł NIE pokazuje notek |
| `ReasoningTagFilter.test.ts` | Rezerwa i rollback jednostkowo, bez dostawcy |
| `registry.test.ts` | Metryczki dziewięciu dostawców + fail-safe nieznanej platformy |
| `modelResolver.test.ts` | Pięciostopniowa drabinka, cache, role sub |
| `cache_utils.test.ts` | Limity wyjścia (6 gałęzi) + metadane cache |
| `capabilities.test.ts` | `isVisionModel` - trzy warstwy decyzji |
| `requestGate.test.ts`, `semanticStatusText.test.ts` | Logika WŁASNA, przeniesiona 1:1 |
| `providers/*.test.ts` | Kaprysy per dostawca: endpointy, nagłówki, sentinele, parser myślenia |

`testing/harness.ts` daje atrapy: `collect`/`collectEvents` (dekoder → snapshot),
`ScriptedTransport`, `HangingTransport`, `CapturingHttpClient`, `makeCtx`/`makeModel`,
`makeSpyGate`.
