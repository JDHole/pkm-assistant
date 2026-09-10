# PKM Assistant

**Co to jest:** plugin do Obsidian. Agenci AI wewnątrz vaulta z hierarchiczną pamięcią, skillami i narzędziami (MCP). GPL-3.0.

**Dla kogo:** osoby chcące własnego asystenta AI w Obsidianie - lokalnego (Ollama), chmurowego (OpenAI/Anthropic/xAI/inne) lub mieszanego. User nie-programista zarządza agentami przez UI, nie kod.

**Rozmiar:** kod modułowy siedzi w `modules/<nazwa>/` + `core/` (fundament) + `src/` (dwa pliki: composition root i style) + `config/` + `utils/` (root-level). Build: esbuild → `dist/main.js` (~2 MB). Testy: AVA. Licencja: GPL-3.0. Repo: https://github.com/JDHole/pkm-assistant.

**Autorstwo:** projekt jest w całości napisany z pomocą Claude Code (JDHole - wizja, prompt engineering, testowanie; sesje Claude Code - implementacja). Zobacz `QUICK_START.md`.

---

## Priorytety pracy (w tej kolejności)

1. **Zero regresji.** Coś się psuje → STOP, naprawa, potem dalej. Plugin jest w produkcji, użytkownicy go używają codziennie.
2. **Git hygiene** - commity po każdej sensownej zmianie, testy pass przed commitem, porządek na GitHub żeby ktoś mógł wejść z ulicy i dojść co się dzieje.
3. **Edukacja właściciela projektu** - JDHole nie jest programistą. Każda zmiana to okazja do zrozumienia, nie tylko wykonania. Jak nie rozumie zmiany → nie wchodzi. Jak rozumie → zostaje mu to na zawsze.

Stabilność ma pierwszeństwo przed nowymi funkcjami - plugin idzie do publicznego katalogu Obsidiana i musi być przewidywalny.

---

## REGUŁA GŁÓWNA - jak ten projekt jest zorganizowany

**Każdy moduł to fizyczny folder** w `modules/<nazwa>/` z:
- `index.ts` - **jedyne drzwi publiczne**, plik fizyczny (specifiery importu w kodzie kończą się na `.js`, ale wskazują ten sam fizyczny plik `.ts`); eksportuje to, co moduł udostępnia reszcie
- `CLAUDE.md` - dokumentacja modułu: co robi, jak, gotchas
- Reszta plików - bebechy, prywatne

**ZŁOTA ZASADA:** poza modułem wolno importować TYLKO z `modules/<nazwa>/index.js`. **Nigdy** z bebechów. Wewnątrz modułu pliki importują się swobodnie.

**Złota zasada obejmuje też `core/`** - jego drzwiami jest `core/index.ts`. Oficjalne wyjątki (wolno deep-importować wszędzie): `core/i18n/index.ts` i `core/utils/Logger.ts` - globalne narzędzia z bardzo dużą liczbą importerów. Drugi wyjątek jest jednoosobowy: `src/main.ts` jako **composition root** deep-importuje obsidianowe pliki core (`PluginBase.ts`, `runtime/PluginRuntime.ts`, `runtime/settingsArmor.ts`, `utils/obsidianNav.ts`, `security/MasterPasswordModal.ts`) - nie mogą wejść do barrela, bo `core/index.ts` musi wstawać w gołym Node (testy AVA nie mają mocka `obsidian`). Specifiery w kodzie nadal celowo kończą się na `.js` i wskazują fizyczne pliki `.ts`.

**Egzekwuje to ESLint**, nie "konwencja + review": `no-restricted-imports` w `eslint.config.js` obejmuje `modules/**`, `src/**`, `config/**`, `utils/**` oraz `test-support/**` (testy pominięte), a `npm run lint` przechodzi po wszystkich pięciu drzewach. Deep-import = błąd lintu, nie uwaga na review.

**Dlaczego:** (a) sesja pracująca w kontekście JEDNEGO folderu = oszczędność tokenów, (b) właściciel projektu uczy się moduł po module, nie całości na raz, (c) zmiany w bebechach nie wywalają pluginu.

---

## Mapa modułów

**Cały kod modułowy siedzi w `modules/<nazwa>/`.** Stan `src/`: dwa pliki - `src/main.ts` (composition root) i `src/styles.css`. Nic więcej tam nie mieszka.

| Moduł | Rola |
|---|---|
| `core/` | Fundament: `PluginBase`, runtime (`runtime/PluginRuntime` + `SettingsStore` + `NoticeCenter` + `StatusBar`), transport HTTP (`core/http/`), security, i18n, utils. Szczegóły: [`core/CLAUDE.md`](core/CLAUDE.md) |
| `modules/memory/` | Pamięć agenta: `brain.md` krótki index + `brain/` trwałe notatki + `sessions/active` + `sessions/archive` + summaries L1-L3, create-only `memory_save`, konsolidacja LLM-driven, izolacja między agentami |
| `modules/embedding/` | Wektoryzacja (Orama): `EmbeddingModel` + `EmbeddingRegistry` + `providers/` (OpenAI/Ollama/Gemini/LM Studio i inne) + `VaultIndexer` |
| `modules/prompts/` | `PromptBuilder` + Decision Tree - instrukcje zachowania agenta, grupowane i przełączalne |
| `modules/sub-agents/` | `SubAgentLoader` + `Runner` (delegacja) + role systemowe ładowane przez `loadSystemRoles()` + custom YAML scope (folders / frontmatter / sections / pinned_notes) + DelegateTool DI + parallel execution + timeout per zadanie |
| `modules/tools/` | Narzędzia agenta: built-in (vault, artefakty, komunikacja, media…) + klient MCP external (stdio/HTTP) |
| `modules/skills/` | Skill engine (przepisy dla agentów) |
| `modules/chat/` | `ChatView` + mixiny + `InlineChipPlugin` + `StreamingManager` + `RollingWindow`/`Summarizer` + `TriggerPopup` (inline triggers `/` i `@`) |
| `modules/models/` | `ChatModel` + dostawcy w `providers/` (wiele platform: DeepSeek, Anthropic, OpenAI, Google, Groq, OpenRouter, Ollama, LM Studio, xAI…) + rejestr `registry.ts`; DI z `config/runtimeConfig.ts` |
| `modules/artifacts/` | Plany i notatki (user-facing z approval flow) - todo agent-internal w `tools/` |
| `modules/agents/` | `AgentManager`, `AgentProfile`, Jaskier (agent systemowy), model osobowości agenta (Persona + Umiejętności + Uprawnienia + Ekipa + Pamięć) |
| `modules/multimodal/` | Audio STT + generowanie obrazu + vision + Oczko (świadomość aktywnej notatki) |
| `modules/onboarding/` | Wizard + `PlaybookManager` |
| `modules/komunikator/` | Poczta międzyagentowa: skrzynka plik-per-wiadomość, prymitywy `kom_send`/`kom_list`/`kom_read`, niewidzialność per agent, sprzątanie pół-automatem |
| `modules/crystal-soul/` | UI generators (ikony, kryształy, kolory) + `SkinManager` |
| `modules/shell/` | Settings tab, sidebar, modale |
| `modules/agent-loop/` | **Serce pętli narzędziowej - bez UI.** `runAgentLoop()`, `ArrayMessageStore`, kanon `parseToolCalls()` (kilka kształtów odpowiedzi) + `splitConcatenatedToolCalls()` (anty-sklejanie odpowiedzi modelu) + `sanitizeToolTranscript()`. Konsumenci: sub-agents, chat, `tools/MCPClient` |
| `modules/ui-components/` | Współdzielone UI primitives: `ToolCallDisplay`, `ThinkingBlock`, `SubAgentBlock`, `AttachmentManager`, `MentionAutocomplete` |
| `modules/web/` | Web access layer: `WebSearchProvider` (kilku dostawców), `urlRegistry` (proweniencja adresów), ustawienia wyszukiwania |

⚠️ Kilka plików logiki przekracza 800 LOC (oznaczone markerem w `CLAUDE.md` swoich modułów) - świadomie nierozbite; zmiana w którymkolwiek wymaga przeczytania całości przed edycją. `src/main.ts` nie ma modułowego `CLAUDE.md`, więc jego status monolitu odnotowany jest tutaj.

---

## Agenci - gdzie żyją

**W pluginie jest TYLKO Jaskier** (hardcoded w `modules/agents/archetypes/HumanVibe.js` jako systemowy onboarding agent - bez niego nowy user nie wie od czego zacząć).

**Pozostali agenci to agenci użytkownika (własne pliki YAML w `.pkm-assistant/agents/`)** - żyją TYLKO w vaulcie użytkownika. Plugin daje:
- **Runtime** (ChatView, SubAgentRunner, ServerExecutor, AccessGuard)
- **UI do produkcji agentów** (agent użytkownika jako asystent tworzenia, AgentProfileModal)
- **Monitoring i diagnostykę**

Jak szukasz "gdzie jest zdefiniowany konkretny agent użytkownika" - nie w kodzie pluginu. W vaulcie usera.

---

## Stos

- Runtime: Obsidian API + ES Modules. 100% źródeł w `core/`, `modules/`, `src/`, `config/`, `utils/` i `test-support/` jest w TypeScript strict (`npm run typecheck` = `tsc --noEmit`; transpilacja: esbuild w buildzie, tsx w testach). Specifiery importów zostają z `.js` i wskazują fizyczne pliki `.ts`.
- Build: esbuild (`npm run build` → `dist/main.js`)
- Tests: AVA framework
- Licencja: **GPL-3.0**
- Repo: https://github.com/JDHole/pkm-assistant

---

## Komendy

```bash
npm run dev              # Build z watch mode (dla developmentu)
npm run build            # Production build → dist/main.js
npm test                 # AVA - testy unit, darmowe, offline
npm run typecheck        # tsc --noEmit - bramka TypeScript strict (noUnusedLocals + noUnusedParameters)
npm run lint              # ESLint na modules/ + src/ + config/ + utils/ + test-support/
npm run lint:obsidian     # ESLint z regułami katalogu społeczności Obsidiana, na core + modules + src + config + utils + test-support
npm run release           # Przygotowanie release'u (patrz RELEASE_PROCESS.md) - publikację robi CI po pushu taga
```

> **Weryfikacja zmian:** testy → typecheck → lint → lint:obsidian → build → **harness** (`selftest` + `scenarios`).
> Harness odpala prawdziwy plugin w Node bez Obsidiana; mieszka w OSOBNYM repo
> (https://github.com/JDHole/pkm-assistant-harness), bo walidator katalogu Obsidiana lintuje CAŁE
> repo pluginu, a narzędzie testowe nie jest jego częścią. Klonuj je OBOK katalogu pluginu;
> szczegóły w jego README. Zastępuje ad-hoc smoke testy klikane ręcznie w Obsidianie.
> Biegi z żywym modelem (`--live`, bez `--offline`) wymagają klucza w `.env.local` tamtego repo
> i kosztują - świadomie, nigdy w `npm test`.
> **Te same bramki jadą automatycznie w CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) na każdy push i pull request do `main` - sieć bezpieczeństwa, nie zamiennik lokalnego przebiegu przed commitem.

---

## Git flow

### Hierarchia branchy

```
main (stable, jedyny długożyjący branch)
  ├── refactor/v2.2-<nazwa>   ← branch roboczy per zadanie, po bramkach merge --no-ff → main
  └── refactor/v2.2-<inne>    ← równoległa sesja = własny branch (worktree)
```

Bezpośrednie commity na `main` **TYLKO drobne docs** (literówka w CLAUDE.md, odznaczenie checkboxa). Kod - nigdy.

### Workflow per zadanie

```bash
git checkout main
git pull origin main
git checkout -b refactor/v2.2-<nazwa>
# ... commity na tym branchu ...

# Bramki (wszystkie zielone):
npm test && npm run typecheck && npm run lint && npm run lint:obsidian && npm run build
cd ../pkm-assistant-harness && npm run selftest && npm run scenarios && cd -   # osobne repo harnessu

# Merge do main:
git checkout main
git merge --no-ff refactor/v2.2-<nazwa>
git push origin main
```

Przy równoległych sesjach - osobny worktree (`git worktree add .claude/worktrees/<nazwa> -b refactor/v2.2-<nazwa> origin/main`), nie przełączaj brancha pod cudzą sesją. Przed KAŻDYM commitem sprawdź `git branch --show-current` - drugi worktree/sesja mógł przełączyć branch pod tobą.

### Commit message format

```
refactor(<moduł>): <co zrobione>
docs(<obszar>): <co zrobione>
fix(<moduł>): <co zrobione>
```

### Twarde reguły

- **Testy pass przed commitem.** Komplet zielony → commit. Czerwony → STOP, naprawiamy, potem commit.
- **NIGDY nie commituj kodu bezpośrednio na `main`.** Kod wchodzi tylko przez `refactor/v2.2-*` + merge `--no-ff`.
- **Jedno zadanie = jeden branch** (czystsze history + łatwiejsze cofnięcie jak coś się sypnie). Branch zostaje na origin jako historical marker.
- **Nie dotykaj dwóch modułów w jednym commicie** - patrz "Co NIE-WOLNO".

---

## Root-level (NIE moduły)

Oprócz `core/` + `modules/`, w roocie są:

- **`config/`** (kilka plików `.ts`) - `runtimeConfig.ts` (`buildRuntimeConfig` - jawna rejestracja dostawców czatu i embeddingu, HTTP, transportu), `defaultSettings.ts` (domyślne ustawienia), `default_prompts.ts` (fabryczne szkielety promptów), `limits.ts` + `limits.test.ts` (twarde limity pętli agenta)
- **`utils/`** (root-level, kilka plików `.ts` + testy) - `releaseNotes.ts` (notatki wydania: `compareSemver`, `latestReleaseFile`, `priorNotes`, `resolveNotesTarget`), `releasePrep.ts` (walidacja wersji + nazwa taga dla `release.js` - publikację robi `.github/workflows/release.yml` po pushu taga), `buildManifest.ts` (wersja z `package.json` do manifestu), `banner.ts` (copyright banner do bundla, użyty w `esbuild.js`). Workflow release: `RELEASE_PROCESS.md`
- **`assets/`** - screenshoty do README
- **`releases/`** - notatki wydania: `{wersja}.md` dla każdej wersji z `versions.json` (kontrakt `build_kontrakt.test.ts`; `release.yml` czyta je jako treść release'u), `latest_release.md` czyta widok "Co nowego" w pluginie
- **`test-support/`** - atrapa `obsidian` + shim DOM + preload AVA; pierwszy zewnętrzny konsument pluginu to harness (osobne repo), a `test-support/` to jego most na ten checkout - objęte i `lint`, i `lint:obsidian`

---

## Co NIE-WOLNO

- ❌ **Nowych feature'ów kosztem stabilności** przed zgłoszeniem do katalogu - priorytet ma domykanie, nie rozbudowa
- ❌ **Deep imports** (z bebechów innego modułu) - tylko przez jego `index.js`
- ❌ Commitować `dist/` ani kluczy API
- ❌ Mockować testów. Integracyjne > jednostkowe
- ❌ Dotykać dwóch modułów w jednym commicie
- ❌ Usuwać kodu bez zrozumienia - właściciel projektu się uczy, każda zmiana to lekcja
- ❌ Sugerować tworzenie osobnych repo dla dokumentacji / ADR-ów / wiedzy deweloperskiej - dokumentacja per moduł żyje w plikach `CLAUDE.md` tego repo

---

## Dla agenta (Claude Code / inny agent pracujący na kodzie) - jak pracować

### Klepanie zadania

0. **Otwórz sesję agenta w root pluginu** (NIE w pojedynczym module). Agent ma w cwd root pluginu, dostęp do wszystkich `modules/`, `core/`.
1. **Start od `main`:** `git checkout main && git pull origin main` → `git checkout -b refactor/v2.2-<nazwa>`. Przy równoległych sesjach - osobny worktree, NIE przełączaj brancha pod cudzą sesją.
2. **Źródło zadania:** przekazane w handoffie sesji. Zanim spytasz o coś, co da się sprawdzić - grepnij kod: pytania tylko o decyzje, nie o fakty.
3. **Iteruj zadania; commity na branchu roboczym.** Testy pass przed każdym commitem. Przed commitem `git branch --show-current` (równoległe sesje!).
4. **Bramki przed merge:** `npm test` → `npm run typecheck` → `npm run lint` → `npm run lint:obsidian` → `npm run build`, a potem w sklonowanym obok repo harnessu `npm run selftest` + `npm run scenarios`.
5. **Koniec zadania:** push brancha + merge `--no-ff` do `main` (albo zgłoszenie do przeglądu, jeśli sesja nie merguje sama) + aktualizacja dokumentacji, której dotknęła zmiana.

### Reguły ogólne

1. **Otwieraj root pluginu**, NIE pojedynczy moduł. Zmiany bywają cross-module (np. zmiana w pamięci dotyka kilku modułów naraz). Agent potrzebuje dostępu do wszystkich.
   - **Deep dive per moduł** (gdy potrzeba research) → subagent do przeszukiwania z poziomu root, nie osobna sesja.
2. **Stan dzisiejszy:** cały kod modułowy siedzi w `modules/<nazwa>/` - `src/` to już tylko `main.ts` (composition root) i `styles.css`.
3. Przed zmianą w module → przeczytaj jego `CLAUDE.md`. Tam są gotchas i decyzje historyczne istotne dziś.
4. **Właściciel projektu jest nie-programistą** - tłumacz po polsku, prostymi słowami, metaforami. Bez żargonu bez wyjaśnienia.
5. Po zmianie → zaktualizuj per-moduł `CLAUDE.md` jeśli zmieniło się public API, doszło gotcha, lub skreślono TODO. **Dokumentacja, która kłamie, jest w tym projekcie traktowana jak błąd.**
6. **Token economy matters** - oszczędzaj gdzie się da. Przed dużym refactorem rozważ czy nie da się tego zrobić mniejszym diff'em.

### Per-moduł CLAUDE.md w pluginie

Zachowuje:
- **Co tu jest** (struktura modułu)
- **Public API** (eksporty index.js)
- **Gotchas / decyzje historyczne** istotne dla dzisiejszego zachowania
- Link do znalezisk/testów modułu, jeśli dotyczy

---

## Dowód, nie deklaracja

1. Każde twierdzenie w raporcie z roboty niesie w tym samym zdaniu dowód albo etykietę: `[measured]` - odpalone albo odczytane, `[inferred]` - wynika z kodu lub logów, ale nieodpalone, `[guess]` - domysł (przewidywanie i niewidziana przyczyna to zawsze guess). Nigdy nie oddawaj właścicielowi projektu checka, który możesz odpalić sam.
2. Dowód to realny artefakt: odpalona funkcja, odczytana wartość, output komendy wklejony verbatim, diff. "Kompiluje się", zielony build i zielone CI to NIE dowód. Typ dowodu dopasowany do zmiany: CLI - realna komenda, UI - przejście zmienionego flow w Obsidianie, parser/migracja - replay realnego wejścia, storage - odczyt zapisanej wartości.
3. "Niejednoznaczne" jest poprawną odpowiedzią; pewność bez dowodu to czerwona flaga. Weryfikuje agent inny niż autor (drabina modeli w globalnym CLAUDE.md: sonnet pisze, opus sprawdza).

### Opis PR

Tytuł (rozszerza format commitów z Git flow wyżej): Conventional Commits `type(scope): subject`, tryb rozkazujący, bez kropki na końcu. Opis to briefing, nie dziennik pokładowy - sekcje w kolejności Why / Scope / Tradeoffs / Blast Radius / Verification, tylko niepuste, maks ok. 40 linii. Verification = co odpalono i co to pokazało, z etykietami z punktu 1. Pięć wąskich PR-ów zamiast jednego dużego.

---

## TypeScript i testy

| Reguła | Zamiast czego |
|---|---|
| Discriminated unions (`kind` jako literal dyskryminator) | worka pól opcjonalnych |
| Branded types dla semantycznych prymitywów, walidacja raz na granicy | gołych `string` / `number` wszędzie |
| Kształt typu czyni nielegalny stan niereprezentowalnym | runtime guarda, który go pilnuje w locie |
| `unknown` dla danych zewnętrznych | `any` |
| Parsowanie na granicy schematem | ręcznego type guarda pole po polu |
| Cast `as` dopiero po walidacji | castu `as` na wiarę |
| Zawężanie w kolejności: discriminant switch, `in`, typeof/instanceof, guard, `as` na końcu | `as` jako pierwszego wyboru |
| `satisfies` | `as` (poszerza typ i go ukrywa) |
| Walidacja na granicy (Obsidian API, pliki vaulta, sieć, provider LLM), zaufanie wewnątrz | guardów porozrzucanych po całym kodzie |
| `Pick` / `Omit` / `Parameters` / `ReturnType` | nowego interfejsu od zera |
| Switch wyczerpujący z `never` w gałęzi default | switcha bez kontroli wyczerpania |
| Logowanie przez `core/utils/Logger.ts` | `console.log` |

### Testy: zachowanie, nie implementacja

Test wywołuje kod tak, jak jego użytkownik, i sprawdza obserwowalny wynik wobec literalnej wartości oczekiwanej. Test kontrolny: czy test przejdzie, gdy każda importowana funkcja zwróci undefined? Jeśli tak - przepisz asercję albo skasuj test. Pięć wzorców fałszywych testów:

- Słaba albo żadna asercja - samo `t.pass()`, `t.truthy()` czy `t.notThrows()` bez sprawdzenia konkretnej wartości.
- Sprawdzasz tylko wywołanie mocka albo brak czegoś - pusta tablica, `undefined`, porównanie z "złą wartością" zamiast realnego wyniku.
- Test samoodnoszący się - oczekiwana wartość liczona tą samą funkcją, którą testujesz.
- Pinowanie stałej - asercja powtarza ręcznie utrzymywaną stałą, domyślny config albo tekst promptu.
- Fixture sprawdza fixture - asercja czyta dane zbudowane przez sam test, kod pod testem nigdy realnie nie odpala się w środku.
