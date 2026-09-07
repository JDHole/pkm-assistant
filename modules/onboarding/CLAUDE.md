# modules/onboarding/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Pierwsze uruchomienie pluginu — wizard MINIMUM (dziś wyłączony w runtime) + vault_map per agent.**

`OnboardingModal` (4-krokowy wizard) miał wykonywać **MINIMUM** konfiguracji (API key + embed model + język). **Od Sprint 01 Z7 (2026-04-27) runtime go nie otwiera** — nowy user dostaje 10-sekundowe Notice z instrukcją ręcznej konfiguracji (`src/main.ts`), a resztę (jak używać agentów, jak tworzyć skille, jak działa pamięć) prowadzi rozmowa z **Jaskierem**, hardcoded systemowym agentem (`HumanVibe.js`). Kod modala ZOSTAJE w pliku jako szkielet pod v3 (0 wołaczy w repo) — patrz „DECYZJA PRODUKTOWA" niżej.

`PlaybookManager` dziś kompiluje WYŁĄCZNIE **vault_map.md** per agent (mapa terenu vaulta: strefy user/agent + whitelist folderów z `agent.focusFolders`). **Playbook Builder (playbook.md + generatory sekcji Rola/Narzędzia/Skille/Delegowanie/Procedury) SKASOWANY w E2.8 A4 (S12/S29)** — był wydmuszką: prompt nigdy nie czytał skompilowanej ściągi. Ideę „agent ma indeks tego co potrafi" przejął chudy rdzeń promptu (E2.4, `modules/prompts`). Sub-agent prep dziś NIE czyta playbook.md (nie istnieje) — patrz `modules/sub-agents/CLAUDE.md` dla realnego mechanizmu. **Tematycznie PlaybookManager należy do onboarding**, mimo że historycznie żył w `src/core/`.

**Status:** 🚀 **ACTIVE.** Przeniesione w Mapa-8 (2026-04-26).

**Sprint Refaktoru — który mnie dotyka:**
- [Sprint 01 Quick Wins + Security](../../Refaktor/Sprinty/SPRINT_01_Quick_Wins_Security.md) ✅ **DONE** (2026-04-27) — Z7 wizard dezaktywacja (PROD-1 🔴 → ✅ commit `d28c97f`): main.js Notice info zamiast modala + banner z Skip button w settings + OnboardingModal kod zostaje jako szkielet do v3
- [Sprint 08 Komunikator v2 + Agora wywałka](../../Refaktor/Sprinty/SPRINT_08_Komunikator_v2_Agora_Wywalka.md) — Z8 PlaybookManager hardcoded polskie agora sekcje fix + Z9 SHADOW-1 + I18N-1
- [Sprint 13b Polish + Decyzje](../../Refaktor/Sprinty/SPRINT_13b_Polish_Decyzje.md) — ON-13..31 drobnice (PLAYBOOK znaleziska, onboarding nadal deferred v3)
- 🗑️ **DEFER v3:** wizard 4-krokowy + 18 znalezisk WIZARD odłożone do v3.0 release

---

## ⚠️ DECYZJA PRODUKTOWA (Kuba, Mapa-8 wieczór 2026-04-26)

**`OnboardingModal` (wizard) jest ODSUNIĘTY.** Plugin obecnie żyje na GitHub jako BRAT install — ściągają go **zajawkowicze** którzy nie potrzebują wizard'a (umieją sobie ustawić API key sami). Wizard ma sens dopiero gdy Kuba **na serio wychodzi z pluginem** (Obsidian Community Plugins / publiczny release).

**Co to znaczy konkretnie:**
- **[Stan z wieczoru 26.04 — HISTORYCZNE, nieaktualne od następnego dnia]** Wizard w tym momencie NADAL DZIAŁAŁ w runtime (kod nie usunięty) — przy first install się otwierał. Nikt go jeszcze nie ruszał (Mapa-8 to była tylko **decyzja**, nie implementacja). **Prawda od [Sprint 01 Z7](../../Refaktor/Sprinty/SPRINT_01_Quick_Wins_Security.md) (2026-04-27, dzień później):** wizard jest wyłączony w runtime — `main.ts` dla nowego usera pokazuje Notice zamiast otwierać modal, `OnboardingModal` zostaje w kodzie jako martwy szkielet (0 wołaczy w repo). Onboarding realnie prowadzi rozmowa z systemowym agentem **Jaskierem** + Notice kierujący do ręcznej konfiguracji w Settings. (AUD-docs-036)
- Faktyczne **disable runtime** (wycięcie z `main.js` first-run flow + auto-set `onboardingCompleted: true`) — odłożone do **Refaktoru** (Faza 2 trylogii). Zrealizowane już następnego dnia w Sprint 01 Z7 (patrz punkt wyżej) — Refaktor zaczął się dokładnie od tego sprintu.
- **PlaybookManager w tamtym momencie NIE był dotknięty tą decyzją** — kompilował playbook.md per agent, fundament agent system. **Od E2.8 A4 (2026-07-23) to też nieaktualne:** Playbook Builder skasowany w całości (wydmuszka, patrz intro modułu wyżej), zostaje tylko `vault_map.md`.
- **Wszystkie 31 znalezisk w TODO modułu zostają** — ale priorytety naprawy OnboardingModal-related (HACK-1, API-1, SETTINGS-1, TIMING-1, PROMISE-1 itp.) **degradowane** — naprawimy je dopiero przed szerokim releasem.
- **PlaybookManager-related znaleziska (I18N-1, LOG-1, AGORA-LANG-1, SHADOW-1, DRY-1, DRY-2, REVERSE-DEP-1)** zostają **z pełnym priorytetem** — to fundament runtime'u.

**Powód:** plugin jest w produkcji **dla zajawkowiczów**, nie dla mas. OnboardingModal to UX dla nowego usera "z ulicy" — obecnie nie ma takich userów, więc czas spędzony na polerowaniu wizard'a = stracony. Lepiej skupić się na fundamencie (memory v2, retrieval v2, persona drift, agents).

**Kiedy wracamy do OnboardingModal:** gdy Kuba jest gotowy na **Obsidian Community Plugins submission** + szeroki marketing. Wtedy:
1. Disable runtime można odwołać
2. Naprawić wszystkie HACK-1/API-1/SETTINGS-1/TIMING-1/PROMISE-1 znaleziska
3. Re-test wizard end-to-end na świeżym vault
4. Może dorobić "Re-run onboarding" w settings (TODO 🟡)
5. Może dodać Jaskier onboarding skill "Naucz mnie tworzyć custom sub-agentów" (TODO 🟠)

**Cross-link:** `Moduly/onboarding/TODO.md` ma wpis 🔴 PROD-1 z tą decyzją na górze.

---

## Co tu jest (kod)

```
modules/onboarding/
├── index.js                  # Public API barrel (1 eksport — zmierzone 2026-08-27)
├── OnboardingModal.js        # 588 LOC — 4-krokowy wizard (Modal subclass); kod ZOSTAJE, 0 wołaczy w repo
└── PlaybookManager.js        # 237 LOC — kompilacja WYŁĄCZNIE vault_map.md per agent (Playbook Builder skasowany E2.8 A4)
```

Razem **~844 LOC** (zmierzone 2026-08-27; spadek z historycznych ~1094 LOC to głównie kasacja Playbook Buildera w E2.8 A4 — `PlaybookManager.js` z 579 → 237 LOC).

---

## Public API (`modules/onboarding/index.js`)

**TYLKO 1 eksport (S30 Z4: było 2):**
- `PlaybookManager` klasa — `new (vault)`

> **S30 Z4 — `OnboardingModal` WYCIĘTY z barrela.** Wizard jest wyłączony od **S01 Z7**
> (`main.js` pokazuje Notice zamiast otwierać modal) i nie miał **ANI JEDNEGO wołacza**
> w całym repo. Plik `OnboardingModal.js` (588 LOC) **ZOSTAJE** jako szkielet pod v3 —
> zgodnie z decyzją produktową wyżej. Wracasz do wizarda → wracasz z eksportem razem
> z konsumentem w `main.js`.

**`getStarterVaultMaps`** to **wewnętrzna funkcja** (nieeksportowana) w `PlaybookManager.js` —
templates `vault_map.md` dla 3 wbudowanych agentów, patrz sekcja „STARTER vault maps" niżej.

### Klasa `PlaybookManager` — 4 metody publiczne (zmierzone 2026-08-27 w `PlaybookManager.ts`)

**Wszystko dotyczy WYŁĄCZNIE `vault_map.md`** — to jedyny byt, który ta klasa dziś zarządza:
- `getVaultMapPath(agentName)` → `string` — `.pkm-assistant/agents/{safeName}/vault_map.md`
- `ensureStarterFiles(agents)` async — tworzy starter `vault_map.md` dla każdego agenta jeśli nie ma
- `readVaultMap(agentName)` async → `string` (lub `''`)
- `compileVaultMap(agent, plugin)` async → składa `vault_map.md` z global vault map
  (`AgentManager.getVaultMapDescriptions()`) + `agent.focusFolders` (whitelist), zapisuje do
  vaulta i zwraca markdown

Prywatne helpery (nie eksportowane, wołane tylko przez metody wyżej): `_ensureVaultMap`,
`_genericVaultMap` (fallback gdy agent nie ma startera), `_extractVaultMapSection` (wycina
sekcję z markdownu globalnej mapy vaulta).

> **E2.8 A4 (S12/S29): Playbook Builder SKASOWANY W CAŁOŚCI.** Te metody/funkcje **nie istnieją**:
> `getPlaybookPath`, `readPlaybook`, `generateRolaSection`, `generateNarzedziaSection`,
> `generateSkilleSection`, `generateSystemGuideSection`, `generateDelegowanieSection`,
> `generateCustomRulesSection`, `compilePlaybook`, `getSystemGuideContent`, `getStarterPlaybooks`.
> Cytat z nagłówka `PlaybookManager.ts`: „wydmuszka — prompt nie czytał skompilowanej ściągi;
> ideę indeksu przejął chudy rdzeń E2.4" (`modules/prompts`, Decision Tree). (AUD-docs-035/079)

### Klasa `OnboardingModal` — wizard (kod ZOSTAJE, 0 wołaczy w repo)

`new OnboardingModal(app, plugin).open()` otwiera modal — ale nic w repo tego dziś nie woła
(patrz „DECYZJA PRODUKTOWA" wyżej: `main.ts` pokazuje Notice zamiast tego). Gdyby ktoś go
wywołał, modal ma 4 kroki:

1. **Welcome** — Cloud vs Local vs Skip
2. **Cloud (step=2)** — wybór providera (DeepSeek/OpenRouter/Anthropic/OpenAI/Gemini/Groq/xAI) + API key + test (`Promise.race` 15s timeout)
3. **Local (step=3)** — Ollama / LM Studio + auto-detection (5s timeout) + lista modeli
4. **Done (step=4)** — zapis (`plugin.env.settingsStore.save()`) + open chat z 300ms delay

Po Skip lub Submit: `pkmAssistant.onboardingCompleted = Date.now()` w settings, modal się zamyka.

---

## Zależności

**Importuje z (zmierzone 2026-08-27 grepem po `^import` w `OnboardingModal.ts` + `PlaybookManager.ts`):**
- `obsidian` — `Modal`/`Notice`/`requestUrl` + typy `App`/`RequestUrlParam` (OnboardingModal); typ `Vault` (PlaybookManager)
- `modules/crystal-soul/index.js` (`UiIcons`, `setSvg` — OnboardingModal)
- `core/i18n/index.js` (`t` — oba pliki)
- `core/utils/Logger.js` (`log` — PlaybookManager)

> **NIEAKTUALNE (AUD-docs-042), zniknęło z importów:** `modules/prompts/index.js` (`TOOL_GROUPS`)
> i `src/agents/archetypes/Archetypes` (`getArchetype`) żyły wyłącznie w skasowanym
> `generateNarzedziaSection`/`generateRolaSection` Playbook Buildera (E2.8 A4). `src/components/ToolCallDisplay`
> (`TOOL_INFO`) miało ten sam los, a ścieżka `src/components/` w ogóle już nie istnieje (przeniesiona
> do `modules/ui-components/` w S10 Z12). Zero z tych trzech importów istnieje dziś w module.

**Importowany przez (zmierzone grepem `from '.*onboarding` po repo, 2026-08-27):**
- `modules/agents/AgentManager.ts` — jedyny statyczny importer. Instancjuje `PlaybookManager`
  w konstruktorze jako `this.playbookManager`, woła `ensureStarterFiles(...)` (bootstrap +
  nowy agent + guard Jaskra).
- `modules/agents/profile/profile_advanced.ts`, `modules/agents/profile/profile_permissions.ts`
  — przez DI `plugin.agentManager.playbookManager`, po jednym wywołaniu `compileVaultMap(...)`
  każdy. `profile_skills.ts` **dziś NIE woła** playbookManagera wcale — historyczne „6 wywołań,
  najwięcej methods" opisywało generatory sekcji playbooka, skasowane w E2.8 A4.
- `OnboardingModal` — **zero importerów** (kod nieosiągalny, patrz „DECYZJA PRODUKTOWA").

---

## Playbook Builder — SKASOWANY (E2.8 A4, S12/S29)

Format „playbook.md" (6 sekcji: Rola/System Guide/Narzędzia/Skille/Delegowanie/Procedury,
`compilePlaybook` + generator per sekcja + wrapper `_safe()`) **nie istnieje od E2.8 A4**.
Był wydmuszką — `Agent.getSystemPrompt()` nigdy nie czytał skompilowanego playbooka. Ideę
„agent ma ściągę tego co potrafi" przejął **chudy rdzeń promptu** (`modules/prompts`, Decision
Tree E2.4 D14) + **indeks skilli** (`_buildSkillIndex`) — oba budowane na żywo przy KAŻDYM
wywołaniu promptu, nie kompilowane raz do pliku. Jedyne co ten moduł dziś kompiluje do pliku
to `vault_map.md` (sekcja „Public API" wyżej). (AUD-docs-035/079)

---

## STARTER vault maps (pierwsze uruchomienie)

Funkcja `getStarterVaultMaps()` (wewnętrzna, nieeksportowana) zwraca słownik szablonów
`vault_map.md` dla 3 wbudowanych agentów: `jaskier`, `borys`, `nika`. Wszystkie tłumaczone
via `t('starter.vault_map.<agent_name>')`. Zwykła funkcja wołana z `_ensureVaultMap` — `t()`
odpala się przy każdym wywołaniu, już po ustawieniu locale.

`ensureStarterFiles(agents)` przy pierwszym uruchomieniu pluginu (i przy tworzeniu nowego
agenta) tworzy `vault_map.md` dla każdego, jeśli go jeszcze nie ma.

Custom agenci bez startera dostają **generic vault map** (fallback `_genericVaultMap(agent)` —
lista `focusFolders` albo „pełny dostęp" gdy pusta).

> **Historyczne (sprzed E2.8 A4):** ta sekcja opisywała `getStarterPlaybooks()` — 3 playbook
> templates + fallback `_genericPlaybook()`. Skasowane razem z Playbook Builderem.

---

## Kluczowe decyzje

- **Wizard MINIMUM, Jaskier reszta** (sesja 105-106): user wjeżdża szybko (1-2 minuty), zamiast 10-stronnego wizard'u. Jaskier prowadzi przez resztę naturalną rozmową.
- **`requestUrl` zamiast `fetch`** (sesja 106): pierwsze uruchomienia pluginu wywoływały test API key z `fetch` — CORS issues z niektórymi providerami (np. Anthropic). Naprawione na `requestUrl` (Obsidian API).
- **`_safe()` wrapper na generatorach playbook** (sesja 106): playbook generators mogą rzucić error → wrapped w try/catch żeby plugin nie crash'ował. Fallback `''` + log.warn.
- **`STARTER_PLAYBOOKS` jako getter funkcja**, nie const (refactor i18n): `t()` musi być wywołane runtime po `setLocale()`, nie przy module load.
- **`PlaybookManager` w onboarding/, nie w core/**: tematycznie należy do onboarding (kompiluje playbooks). Core to fundament (security, utils, i18n).

---

## Gotchas

- ⚠️ **Wizard tylko raz** — flag `pkmAssistant.onboardingCompleted` w `data.json`. Re-run musi być explicit (przycisk w settings).
- ⚠️ **Test API key musi być z `requestUrl`** (sesja 106) — `fetch` w pluginach Obsidian ma problemy z CORS dla niektórych providers (np. Anthropic).
- ⚠️ **Anthropic test "400 = OK" hack** (`OnboardingModal.js:370-372`) — celowo wysyła bad request (`max_tokens: 1`) bo Anthropic wymaga `messages` nawet dla testu API key. Status 400 traktowany jako sukces. Ukryta logika.
- ⚠️ **Hardcoded URL endpoints 7 platform** (OnboardingModal `:345` i sąsiednie) — mogą się zdezaktualizować, brak fallback / retry. Jeśli endpoint padnie wszyscy userzy mają failed test.
- ⚠️ **`onboardingCompleted` ustawiany 2×** (`OnboardingModal:452, 507`) — Cloud finish + skip path, drugi set redundant.
- ✅ **Trzy gotchas Playbook Buildera USUNIĘTE stąd (2026-08-27, AUD-docs-035).** „Hardcoded
  polskie sekcje agora" (`_extractAgoraSection`), „`_safe()` loguje `e.message`" i „Param `t`
  shaduje import `t`" opisywały `generateNarzedziaSection`/generatory sekcji playbooka —
  skasowane w E2.8 A4 razem z całym Playbook Builderem. `_extractVaultMapSection`
  (następca do vault_map) używa polskich nazw sekcji `Strefy użytkownika`/`Strefy agentowe`
  TAK SAMO (patrz `compileVaultMap` w kodzie) — to nie jest nowa luka, tylko przeniesiony wzorzec.
- ⚠️ **Reverse deps NIE MA — sprostowane (AUD-docs-042).** Stara nota mówiła o `src/core/PromptBuilder`
  + `src/agents/archetypes/Archetypes` + `src/components/ToolCallDisplay`; wszystkie trzy ścieżki
  są martwe (moduły dawno zmigrowane, a importy żyły wyłącznie w skasowanym Playbook Builderze).
  Dziś moduł importuje tylko `obsidian`, `modules/crystal-soul`, `core/i18n`, `core/utils/Logger`
  — patrz „Zależności" wyżej.

---

## TODO (per-modułowe)

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md).

Krytyczne (wybrane, ~31 znalezisk total):
- 🔴 **HACK-1** Anthropic "400 = OK" celowy bad request (OnboardingModal:370-372)
- 🔴 **API-1** hardcoded URL endpoints 7 platform (OnboardingModal:345)
- 🔴 **SETTINGS-1** fallback chain `plugin.env?.settingsStore?.settings || plugin.settings` może maskować bugi
- ✅ **I18N-1 i LOG-1 MOOT (2026-08-27)** — celowały w `generateNarzedziaSection`/`_safe()`
  Playbook Buildera, skasowane w E2.8 A4 razem z resztą generatorów sekcji. Kod, którego dotyczyły,
  nie istnieje.
- 🟠 8 wysokich z listy oryginalnej (2026-04-26) dotyczyły w większości OnboardingModal (timing,
  Promise.race, hardcoded settings, fragile placeholder detection) — nadal potencjalnie aktualne,
  bo ten plik nie był kasowany, tylko odłączony od runtime. Część (hardcoded polskie sekcje agora)
  dotyczyła Playbook Buildera i jest tak samo MOOT jak wyżej.
- 🟡 11 średnich (DRY, guards, REVERSE-DEP-1 — REVERSE-DEP-1 zamknięty, patrz Gotcha wyżej)
- 🟢 7 niepilnych
- 🟠 **Jaskier onboarding skill** "Naucz mnie tworzyć custom sub-agentów" — nowy skill prowadzący przez modal tworzenia custom sub-agenta
- 🟡 Wizard "Rerun onboarding" w settings (post-MAX) — opcja resetu

---

## Powiązane

- `modules/agents/CLAUDE.md` — Jaskier hardcoded factory (HumanVibe.js); jedyny importer tego
  modułu (`AgentManager` instancjuje `PlaybookManager`, `profile_advanced`/`profile_permissions`
  wołają `compileVaultMap` przez DI)
- `modules/prompts/CLAUDE.md` — **NIEAKTUALNE, usunięte:** `TOOL_GROUPS` żył wyłącznie w
  skasowanym generatorze Narzędzia (Playbook Builder, E2.8 A4) — dziś zero relacji
- `modules/skills/CLAUDE.md`, `modules/sub-agents/CLAUDE.md` — **NIEAKTUALNE, usunięte:**
  `generateSkilleSection`/`generateDelegowanieSection` skasowane razem z Playbook Builderem —
  dziś zero relacji
- (Agora removed in S08 Z7 — `compileVaultMap` używa `plugin.agentManager.getVaultMapDescriptions()` które deleguje do `VaultMap` w `modules/agents/`)
- `modules/crystal-soul/CLAUDE.md` — `UiIcons` w OnboardingModal (1 import)
- `Tydzień MAX/Wizja/MEMORY_v2_RETRIEVAL_v2.md` — Blok 4 (Jaskier onboarding skill dla custom sub-agentów)

---

## Historia

- **Sesja 21** — pierwszy playbook system
- **Sesja 61** — STARTER_PLAYBOOKS rozbudowane
- **Sesja 105-106** — Onboarding wizard (4 kroki) + decyzja "wizard MINIMUM, Jaskier reszta" + fix `fetch` → `requestUrl` + `_safe()` wrapper
- **Sesja ~i18n refactor** — `STARTER_PLAYBOOKS` const → `getStarterPlaybooks()` getter (runtime dispatch po setLocale)
- **Sesja 128 D6** (2026-04-25) — placeholder rozbudowany do wzorca
- **Mapa-8** (2026-04-26) — przenosiny `src/views/OnboardingModal.js` + `src/core/PlaybookManager.js` → `modules/onboarding/`. Naprawione zmyślone API placeholdera (`STARTER_PLAYBOOKS` const → faktycznie getter funkcja, `getSystemGuideContent`/`getStarterPlaybooks`/`getStarterVaultMaps` NIE są exported — wewnętrzne). 31 znalezisk → TODO + 3 Nauka cards.
- **Sprint 01 Z7** (2026-04-27, dzień po Mapa-8) — decyzja produktowa z wieczoru Mapy-8 zrealizowana: `main.js` first-run flow przestaje otwierać `OnboardingModal`, pokazuje Notice zamiast tego. `OnboardingModal.js` zostaje w kodzie jako szkielet (commit `d28c97f`).
- **E2.8 A4** (2026-07-23, S12/S29) — **Playbook Builder skasowany w całości.** `compilePlaybook` + wszystkie generatory sekcji (Rola/Narzędzia/Skille/System Guide/Delegowanie/Procedury) + `getPlaybookPath`/`readPlaybook`/`getSystemGuideContent`/`getStarterPlaybooks` usunięte — były wydmuszką (prompt nigdy nie czytał skompilowanej ściągi). `PlaybookManager.js` z 579 → 237 LOC, zostaje wyłącznie kompilacja `vault_map.md`. Ideę indeksu przejął chudy rdzeń promptu (E2.4 D14, `modules/prompts`).
- **2026-08-27 (AUD-docs-035/036/042/079/032)** — dokument dogonił stan po E2.8 A4: opis PlaybookManagera, lista metod, sekcja formatu playbooka, starter templates, mapa zależności i licznik eksportów przepisane na rzeczywistość (vault_map-only, wizard wyłączony od S01 Z7). Zero zmian w kodzie.
