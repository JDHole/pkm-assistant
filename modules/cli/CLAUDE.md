# modules/cli/

**Komendy CLI Obsidiana dla agentów zewnętrznych.** Od Obsidian 1.12.2 plugin może
zarejestrować własne komendy w `Plugin#registerCliHandler(command, description, flags,
handler)`. Agent zewnętrzny (Claude Code i inni) woła `Obsidian.com pkm-assistant:<akcja>
klucz=wartosc` i dostaje JSON na stdout - to jest maszynowy interfejs do stanu pluginu, bez
otwierania Obsidiana w przeglądarce ani klikania w UI.

**Fala 1 = WYŁĄCZNIE odczyt.** Żadna z czterech komend nie zapisuje na dysk, nie woła modelu
i nie zmienia aktywnego agenta. Kontrakt zostawia miejsce na komendy piszące później
(`CliEffect` ma już `'changed'`/`'created'`), ale dziś ich nikt nie produkuje.

## Co tu jest

```
modules/cli/
├── index.ts             # publiczne drzwi (barrel)
├── response.ts           # koperta CliResponse<T> + okResponse/errorResponse/serializeCliResponse
├── commands.ts            # buildCliCommands(deps): CliCommandSpec[] - CZYSTE, zero Obsidiana
├── register.ts            # registerCliCommands(host, deps) - wiąże specyfikacje z hostem Obsidiana
├── commands.test.ts
└── register.test.ts
```

## Public API

`modules/cli/index.ts` eksportuje:

- `registerCliCommands(host, deps)` - jedyna funkcja, którą woła `src/main.ts` w `onload()`.
- Typy: `CliHost`, `RegisterCliCommandsResult`, `CliDeps`, `CliAgentManager`, `CliIndexStatus`,
  `CliCommandSpec`, `StatusData`, `AgentPromptData`, `MemoryStatusData`, `CliEffect`,
  `CliErrorCode`, `CliResponse`.

`buildCliCommands` (z `commands.ts`) świadomie NIE jest w barrelu - jedyny konsument spoza
`register.ts` to testy tego samego modułu (`commands.test.ts` importuje go wprost jako sibling).

## Kontrakt koperty (`response.ts`)

```ts
type CliResponse<T> =
    | { ok: true; command: string; verified: true; effect: CliEffect; data: T }
    | { ok: false; command: string; verified: false; effect: 'unchanged'; error: { code: CliErrorCode; message: string } };
```

Wyjście na stdout to zawsze `JSON.stringify(response, null, 2)` - kod wyjścia procesu CLI bywa
`0` nawet przy błędzie, więc wołający musi czytać `ok`/`error.code` z TREŚCI, nie z exit code.

Kody błędów (`CliErrorCode`): `not_ready`, `bad_flag`, `agent_not_found`, `agent_ambiguous`,
`section_not_found`, `internal`.

## Komendy

Prefiks id = id pluginu z manifestu (`pkm-assistant`).

| Komenda | Flagi | Dane (`data`) | Gotowość |
|---|---|---|---|
| `pkm-assistant:status` | `format` | `StatusData` | działa ZAWSZE, nawet przed końcem `initialize()` |
| `pkm-assistant:selftest` | `format` | raport `buildSelfTestReport` (opaque payload) - BEZ zapisu pliku i BEZ Notice | wymaga gotowości |
| `pkm-assistant:agent-prompt` | `agent` (wymagana, `<name>`), `section` (`<key>`), `format` | `AgentPromptData` | wymaga gotowości |
| `pkm-assistant:memory-status` | `agent` (wymagana, `<name\|all>`), `format` | `MemoryStatusData` | wymaga gotowości |

Wspólne zasady wszystkich czterech: handler NIGDY nie rzuca (każdy wyjątek -> `ok:false`,
`error.code:'internal'`); `format` dopuszcza wyłącznie `json` (domyślna, inna wartość ->
`bad_flag`); nieznane klucze w `params` są IGNOROWANE (Obsidian potrafi dorzucać własne, np.
`vault`); poza `status` brak gotowości (`isReady()===false`) LUB brak agent managera -> `not_ready`.

### Rozwiązywanie imienia agenta (`agent=`)

Kolejność: (1) dokładne dopasowanie, (2) dopasowanie bez wielkości liter, JEŚLI JEDNOZNACZNE.
Brak dopasowania -> `agent_not_found`; wiele trafień w kroku 2 -> `agent_ambiguous`. Obie
gałęzie wymieniają w `error.message` dostępne imiona (`AgentManager.getAgent(name)` jest
case-sensitive, a `getPromptInspectorDataForAgent` dla nieznanego imienia oddaje CICHO pusty
wynik - `getAgentManager.ts:736-740` - dlatego istnienie agenta sprawdzamy TU, zanim cokolwiek
wołamy). Dla `memory-status` wartość `all` pomija resolver i bierze wszystkich agentów z
`getAllAgents()`.

## Gotchas

- ⚠️ **Straż wersji, `manifest.json` NIE jest podbijany.** `minAppVersion` zostaje `1.11.0` -
  rejestracja idzie za `typeof host.registerCliHandler === 'function'`. Obsidian starszy niż
  1.12.2 dostaje zero komend CLI, plugin wstaje normalnie (`register.ts`:
  `skipped:'unsupported'`, bez rzucania).
- ⚠️ **Z innych modułów i z `obsidian` WYŁĄCZNIE `import type`.** `modules/agents/index.ts`
  ciągnie transytywnie import CSS (`AgentProfileView.js` -> ... -> `profile_advanced.ts` ->
  `HiddenFileEditorModal.css`) i NIE wstaje pod AVA (patrz `modules/agents/CLAUDE.md`) -
  runtime'owy import z niego (albo z `modules/memory/index.js`) wywaliłby WSZYSTKIE testy tego
  modułu na starcie, zanim doszłyby do jednego `test()`. Dlatego każda zależność (agent
  manager, indeks wektorowy, self-test, status konsolidacji) wchodzi przez `CliDeps` (DI z
  `src/main.ts`) - jedyny runtime'owy import spoza modułu to `core/utils/Logger.js` (oficjalny
  wyjątek deep-importu, jak w całym repo). Testy z tego samego powodu NIE importują `Agent`/
  `AgentMemory` jako wartości - fejkowe `CliDeps` są pisane ręcznie, z minimalnymi obiektami
  rzutowanymi na granicy (`fakeAgent`/`fakeMemory` w `commands.test.ts`).
- ⚠️ **Nieznane klucze w `params` są ignorowane, nie odrzucane.** Obsidian potrafi dorzucić
  własne pola (np. `vault`) do `CliData` przekazywanego handlerowi - żadna z czterech komend
  nie waliduje kompletu kluczy, tylko czyta te, które zna.
- ⚠️ **Polskie znaki w argumentach CLI na Windows bywają kaleczone przez rurę.** Dopasowanie
  imienia agenta bez wielkości liter (`resolveAgentName` w `commands.ts`) jest więc praktyczną
  siatką bezpieczeństwa, nie tylko wygodą - `agent=jaskier` ma trafić w `Jaskier` nawet gdy
  powłoka rozjedzie się z wielkością liter przy przekazywaniu argumentu.
- ⚠️ **`loadedAt` w `StatusData` liczy się RAZ, przy rejestracji, nie przy każdym wywołaniu.**
  `buildCliCommands(deps)` zamraża `(deps.now?.() ?? new Date()).toISOString()` w domknięciu
  współdzielonym przez wszystkie cztery specyfikacje - to jest znacznik "kiedy ta instancja
  pluginu zarejestrowała komendy", używany do wykrycia martwej instancji po
  `plugin:reload` (nowy `loadedAt` = nowa rejestracja). Gdyby liczył się przy każdym
  wywołaniu `status`, znacznik byłby bezużyteczny (zawsze "teraz").
- ⚠️ **Przyszłe komendy z treścią (piszące) mają brać ją z PLIKU, nie z argumentu.** CLI
  Obsidiana i powłoki mają limity długości argumentu i własne reguły escapowania - notatka,
  treść wiadomości czy jakikolwiek wieloliniowy ładunek nie powinny nigdy jechać jako wartość
  flagi. Fala 1 tego nie potrzebuje (czysty odczyt), ale kontrakt `CliCommandSpec.run(params:
  CliData)` (`CliData = Record<string, string | 'true'>`) i tak nie ma jak unieść więcej niż
  jedną linię bezpiecznie - kolejna fala powinna dodać flagę `<path>` (plik do przeczytania),
  nie `<content>`.
- ⚠️ **`selftest` jest celowo nieprzezroczyste.** `deps.selfTest()` woła tę samą funkcję
  składającą raport co komenda `run_self_test` w `src/main.ts` (wydzieloną w Jednostce C), ale
  BEZ zapisu pliku w `logs/` i BEZ `Notice` - `data` w odpowiedzi to dokładnie to, co
  `buildSelfTestReport()` zwróci, bez kształtowania przez ten moduł.

## Powiązane

- `src/main.ts` - `onload()` woła `registerCliCommands(this, {...})` zaraz po
  `registerCommands()`, w try/catch (awaria rejestracji CLI nie ma prawa wywrócić startu
  pluginu); `run_self_test()` i `registerCliCommands` dzielą jedną prywatną metodę składania
  raportu self-testu.
- `modules/memory/CLAUDE.md` - `getConsolidationStatus`/`resolveConsolidationThresholds`/
  `shouldTriggerConsolidation`, których `memory-status` używa przez `CliDeps.consolidationStatus`.
- `modules/agents/CLAUDE.md` - `AgentManager.getPromptInspectorDataForAgent`, którego
  `agent-prompt` używa przez `CliDeps.agentManager()`.
