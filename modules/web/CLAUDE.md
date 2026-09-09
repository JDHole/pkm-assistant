# modules/web/

**Warstwa dostępu do sieci.** Dostawcy wyszukiwania, czytnik stron, rejestr pochodzenia URL-i, licznik zużycia, filtr domen, cache odczytów, streszczanie tanim modelem + ustawienia Web Search.

Narzędzia agenta (`web_search`, `web_read`) żyją w `modules/tools/` - tu jest silnik, tam kontrakt narzędzia.

## Co tu jest

```
modules/web/
├── index.ts               # jedyne drzwi publiczne
├── WebSearchProvider.ts   # 5 dostawców + warstwy (fallback na Jinę) + cache search (5 min/50) + reader
├── urlRegistry.ts         # rejestr znanych URL-i (bramka provenance dla web_read)
├── usageCounter.ts        # licznik dzienny/miesięczny (INFORMACYJNY)
├── domainFilter.ts        # blocked/allowed z subdomenami
├── readCache.ts           # cache WYNIKU KOŃCOWEGO web_read (30 min/20)
├── summarize.ts           # streszczenie + dosłowne cytaty tanim modelem
├── SettingsContent.ts     # render sekcji Web Search
└── SettingsSection.ts     # rejestracja sekcji
```

Testy jako siblings: `urlRegistry.test.ts`, `usageCounter.test.ts`, `domainFilter.test.ts`, `summarize.test.ts`, `WebSearchProvider.test.ts`.

Cały moduł jest w TypeScripcie. **Specifiery importów zostają z `.js`** (`./urlRegistry.js` wskazuje `urlRegistry.ts`) - żaden konsument spoza modułu nie zmienia importów. Barrel dokłada `export type` (typy publiczne, patrz niżej); `export type` znika przy transpilacji, więc powierzchnia runtime'u jest bez zmian.

## Public API

`modules/web/index.ts` eksportuje:

- `executeWebSearch(query, settings, limit)` · `readWebPage(url, settings)`
- `registerKnownUrl` · `registerUrlsFromText` · `isUrlKnown` · `normalizeUrl`
- `bumpUsage`
- `checkDomain`
- `makeReadCacheKey` · `getCachedRead` · `setCachedRead`
- `summarizeWebContent`
- `registerSettings`

Plus **typy** (`export type` - zero emitu): `WebSearchResult`, `WebSearchResponse`,
`WebPageRead`, `WebSearchProviderSettings`, `WebSearchProviderInfo`, `DomainListInput`,
`DomainVerdict`, `DomainFilterSettings`, `ProviderTotals`, `UsageState`, `UsageSettingsSlice`,
`CachedReadValue`, `WebCitation`, `WebSummary`, `SummarizerModelLike`, `SummarizeWebParams`,
`WebSearchSettings`, `WebSettingsSectionCtx`.

Kilka symboli świadomie NIE jest w barrelu, bo nie mają konsumenta spoza modułu: `resolveProviderKey`,
`WEB_SEARCH_PROVIDERS`, `PROVIDER_SIGNUP_URLS` (czyta je `SettingsContent.ts` tego samego modułu),
`readUsage`/`sumUsage`/`COUNTED_PROVIDERS` (licznik renderuje własna sekcja Settings; narzędzia wołają
tylko `bumpUsage`), `parseDomainList` (woła go `checkDomain`) i `_clearReadCache` (hak testowy -
`modules/tools/WebReadTool.test.js` deep-importuje `../web/readCache.js` wprost; specifier zostaje
z `.js` mimo pliku `.ts`). Definicje ŻYJĄ w bebechach - nie dodawaj ich z powrotem do publicznej
powierzchni „na wypadek testów".

`normalizeUrl` jest w barrelu, bo `web_read` kanonizuje adres RAZ, na wejściu, żeby provenance,
filtr domen, klucz cache i reader oglądały ten sam ciąg - symbol ma realnego konsumenta spoza
modułu (`modules/tools/WebReadTool.ts`).

## Decyzje

1. **Warstwy, nie „wybierz jednego".** Dropdown zostaje (jeden aktywny dostawca), ale wybrany siedzi NA darmowej podłodze: gdy płatny rzuci błędem, `executeWebSearch` strzela drugi raz przez Jinę i oznacza wynik `fallback_from`. Padnie też podłoga → leci ORYGINALNY błąd wybranego dostawcy (user ma wiedzieć, co realnie skonfigurował).
2. **Klucze per dostawca.** `ws.apiKeys = {jina, tavily, brave, serper}`. Legacy `ws.apiKey` czytany jako fallback **tylko dla aktualnie wybranego** dostawcy i **nie kasowany** - zero migracji danych na dysku.
3. **Keyless Jina.** Rejestr ma `requiresKey: false` + `keyOptional: true` (flaga sterująca widocznością pola w Ustawieniach) - bez tego bramka rzucałaby zanim cokolwiek poleciało, a obiecany w UI tryb bezkluczowy byłby nieosiągalny.
4. **Licznik = informacja, nie limit.** Dzień + miesiąc, tylko Tavily/Brave/Serper. Jina i SearXNG nie mają progu do pokazania. Zero twardych blokad - plugin nigdy nie odcina wyszukiwania.
5. **Streszczanie tylko w `web_read`.** `web_search` NIE woła LLM (5 wyników × pełne strony = za drogo i za wolno); tam problem cięcia rozwiązany strukturalnie - narzędzie zwraca `fragment`, nie pełną treść.
6. **PDF przez reader, bez nowej biblioteki.** r.jina.ai sam ekstrahuje tekst z PDF-ów. Binaria, których nie umie przerobić, dają uczciwy komunikat (`websearch.unreadable_binary`), nie pustkę ani wyjątek parsera. Strona, która oddała poprawną odpowiedź bez treści, dostaje osobny komunikat (`websearch.no_content`) - to inna diagnoza niż binarka.

## Gotchas

- ⚠️ **Cache jest rozdzielony i to jest celowe.** Search: 5 min / 50 wpisów, w `WebSearchProvider`. Read: 30 min / 20 wpisów, w `readCache.js`, i trzyma **wynik końcowy narzędzia** (po streszczeniu) - gdyby siedział w `readWebPage`, każdy hit płaciłby jeszcze raz za LLM. Klucz odczytu niesie limit i tryb streszczania, bo to część tożsamości wyniku.
- ⚠️ **Cache search oznacza trafienia flagą `cached: true`.** Licznik zużycia jej pilnuje - trafienie w cache nic nie zjadło u dostawcy, więc nie jest liczone.
- ⚠️ **`readWebPage` używa klucza JINY, nie klucza wybranego dostawcy.** Reader zawsze jest Jiny - inny klucz przy wybranym Tavily/Brave odbijałby 401.
- ⚠️ **Filtr domen jest fail-closed, ale tylko gdy jest włączony.** Obie listy puste → `checkDomain` zwraca `allowed` bez parsowania adresu. Gdy filtr jest skonfigurowany, adres nieparsowalny = `blocked`.
- ⚠️ **`urlRegistry` (provenance) i filtr domen to dwie osobne, dodatkowe bramki.** Kolejność w `web_read`: walidacja URL → **kanonizacja (`normalizeUrl`)** → provenance → domena → cache → sieć. Wszystkie te bramki dostają FORMĘ KANONICZNĄ, nie surowy ciąg od modelu.
- ⚠️ **`readWebPage` ma strażnika kanoniczności sklejki.** Reader dostaje adres doklejony do własnej ścieżki (`https://r.jina.ai/<url>`), więc segmenty `..` zwijałyby się PO sklejce: filtr domen widziałby `good.com`, a request leciałby na `evil.com`. Jeśli `new URL(readerUrl).href !== readerUrl` - nic nie leci. Nie próbuj tego „naprawiać" przez `encodeURIComponent` na całym adresie: to zmienia zachowanie readera.
- ⚠️ **`summarize.js` rzuca wyjątkiem przy każdym problemie** (brak modelu, błąd API, pusta odpowiedź). Decyzja o fallbacku na twarde cięcie należy do narzędzia, nie do tego pliku.
- ⚠️ **Dwa RÓŻNE błędy pustki w `readWebPage`.** Reader oddał coś, co nie jest JSON-em → `websearch.unreadable_binary` (praktycznie zawsze binarka). Reader oddał POPRAWNY JSON, ale bez treści → `websearch.no_content` (paywall / login / strona rysowana skryptem). To dwie różne diagnozy, obie mają rację bytu.
- ⚠️ **`_clearReadCache` nie jest w barrelu.** Hak testowy: `modules/tools/WebReadTool.test.js` deep-importuje `../web/readCache.js`. Nie dodawaj go z powrotem do publicznej powierzchni „na wypadek testów".
- ⚠️ **`urlRegistry` ma sufit `MAX_KNOWN_URLS = 2000`.** Singleton modułowy żyje cały czas życia runtime'u pluginu - bez sufitu rósłby bez ograniczeń (wolny wyciek pamięci). Po przekroczeniu sufitu leci NAJSTARSZY wpis - `Set` zachowuje kolejność wstawiania, więc destrukturyzacja `const [oldest] = _knownUrls` daje pierwszy (najstarszy) element; **nie** `.values().next().value` - ten typuje się jako `any` i łapie eslint:obsidian na `no-unsafe-assignment`/`no-unsafe-argument` (typed linting), mimo że `tsc --noEmit` przechodzi czysto. Ponowna rejestracja ZNANEGO URL-a NIE odświeża jego pozycji (`Set.add` na istniejącej wartości nie rusza kolejności) - to FIFO po pierwszym wystąpieniu, nie LRU. Świadomy kompromis: URL wyewiktowany mimo aktywnego użycia po prostu wraca do stanu „nieznany" i `web_read` go odrzuca (fail-closed), nigdy fail-open. Test na sufit sprawdza rozmiar wprost przez hak testowy `_knownUrlCount()` - dowód indirekcyjny (tylko „najnowszy URL jest znany") przechodziłby równie dobrze przy suficie-atrapie, który nic nie evictuje.
