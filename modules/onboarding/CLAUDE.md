# modules/onboarding/

> Fizyczne pliki modułu mają rozszerzenie `.ts`. Nazwy `.js` w tym dokumencie oznaczają albo
> specyfikatory importów, albo zapisy sprzed konwersji na TypeScript, celowo pozostawione bez
> zmian.

**Pierwsze uruchomienie pluginu - wizard MINIMUM (dziś wyłączony w runtime) + vault_map per agent.**

`OnboardingModal` (4-krokowy wizard) miał wykonywać **MINIMUM** konfiguracji (API key + embed model + język). Runtime go dziś nie otwiera - nowy user dostaje krótkie Notice z instrukcją ręcznej konfiguracji (`src/main.ts`), a resztę (jak używać agentów, jak tworzyć skille, jak działa pamięć) prowadzi rozmowa z **Jaskierem**, hardcoded systemowym agentem (`HumanVibe.js`). Kod modala zostaje w pliku jako szkielet pod przyszłą wersję (0 wołaczy w repo) - plugin jest dziś instalowany ręcznie przez userów, którzy sami umieją sobie ustawić klucz API, więc czas spędzony na polerowaniu wizarda byłby stracony. Wizard ma sens dopiero przy szerszej dystrybucji (np. Obsidian Community Plugins) - wtedy warto go odblokować, dokończyć znaleziska i przetestować end-to-end na świeżym vaulcie.

`PlaybookManager` dziś kompiluje wyłącznie **vault_map.md** per agent (mapa terenu vaulta: strefy user/agent + whitelist folderów z `agent.focusFolders`). Playbook Builder (playbook.md + generatory sekcji Rola/Narzędzia/Skille/Delegowanie/Procedury) skasowany w całości - był wydmuszką: prompt nigdy nie czytał skompilowanej ściągi. Ideę „agent ma indeks tego co potrafi" przejął chudy rdzeń promptu (`modules/prompts`). Sub-agent prep dziś NIE czyta playbook.md (nie istnieje) - patrz `modules/sub-agents/CLAUDE.md` dla realnego mechanizmu. Tematycznie `PlaybookManager` należy do onboarding, nie do core (core to fundament: security, utils, i18n).

**Status:** ACTIVE.

---

## Co tu jest (kod)

```
modules/onboarding/
├── index.js                  # Public API barrel (1 eksport)
├── OnboardingModal.js        # 588 LOC - 4-krokowy wizard (Modal subclass); kod zostaje, 0 wołaczy w repo
└── PlaybookManager.js        # 237 LOC - kompilacja WYŁĄCZNIE vault_map.md per agent
```

Razem **~844 LOC**.

---

## Public API (`modules/onboarding/index.js`)

**1 eksport:**
- `PlaybookManager` klasa - `new (vault)`

> **`OnboardingModal` WYCIĘTY z barrela.** Wizard jest wyłączony (`main.js` pokazuje Notice
> zamiast otwierać modal) i nie ma ani jednego wołacza w całym repo. Plik `OnboardingModal.js`
> (588 LOC) zostaje jako szkielet - zgodnie z opisem wyżej. Wracasz do wizarda → wracasz
> z eksportem razem z konsumentem w `main.js`.

`getStarterVaultMaps` to **wewnętrzna funkcja** (nieeksportowana) w `PlaybookManager.js` -
templates `vault_map.md` dla 3 wbudowanych agentów, patrz sekcja „STARTER vault maps" niżej.

### Klasa `PlaybookManager` - 4 metody publiczne

**Wszystko dotyczy WYŁĄCZNIE `vault_map.md`** - to jedyny byt, który ta klasa dziś zarządza:
- `getVaultMapPath(agentName)` → `string` - `.pkm-assistant/agents/{safeName}/vault_map.md`
- `ensureStarterFiles(agents)` async - tworzy starter `vault_map.md` dla każdego agenta jeśli nie ma
- `readVaultMap(agentName)` async → `string` (lub `''`)
- `compileVaultMap(agent, plugin)` async → składa `vault_map.md` z global vault map
  (`AgentManager.getVaultMapDescriptions()`) + `agent.focusFolders` (whitelist), zapisuje do
  vaulta i zwraca markdown

Prywatne helpery (nie eksportowane, wołane tylko przez metody wyżej): `_ensureVaultMap`,
`_genericVaultMap` (fallback gdy agent nie ma startera), `_extractVaultMapSection` (wycina
sekcję z markdownu globalnej mapy vaulta).

> **Playbook Builder skasowany w całości.** Te metody/funkcje **nie istnieją**:
> `getPlaybookPath`, `readPlaybook`, `generateRolaSection`, `generateNarzedziaSection`,
> `generateSkilleSection`, `generateSystemGuideSection`, `generateDelegowanieSection`,
> `generateCustomRulesSection`, `compilePlaybook`, `getSystemGuideContent`, `getStarterPlaybooks`.
> Cytat z nagłówka `PlaybookManager.ts`: „wydmuszka - prompt nie czytał skompilowanej ściągi;
> ideę indeksu przejął chudy rdzeń" (`modules/prompts`, Decision Tree).

### Klasa `OnboardingModal` - wizard (kod zostaje, 0 wołaczy w repo)

`new OnboardingModal(app, plugin).open()` otwiera modal - ale nic w repo tego dziś nie woła
(`main.ts` pokazuje Notice zamiast tego). Gdyby ktoś go wywołał, modal ma 4 kroki:

1. **Welcome** - Cloud vs Local vs Skip
2. **Cloud (step=2)** - wybór providera (DeepSeek/OpenRouter/Anthropic/OpenAI/Gemini/Groq/xAI) + API key + test (`Promise.race` 15s timeout)
3. **Local (step=3)** - Ollama / LM Studio + auto-detection (5s timeout) + lista modeli
4. **Done (step=4)** - zapis (`plugin.env.settingsStore.save()`) + open chat z 300ms delay

Po Skip lub Submit: `pkmAssistant.onboardingCompleted = Date.now()` w settings, modal się zamyka.

---

## Zależności

**Importuje z:**
- `obsidian` - `Modal`/`Notice`/`requestUrl` + typy `App`/`RequestUrlParam` (OnboardingModal); typ `Vault` (PlaybookManager)
- `modules/crystal-soul/index.js` (`UiIcons`, `setSvg` - OnboardingModal)
- `core/i18n/index.js` (`t` - oba pliki)
- `core/utils/Logger.js` (`log` - PlaybookManager)

**Importowany przez:**
- `modules/agents/AgentManager.ts` - jedyny statyczny importer. Instancjuje `PlaybookManager`
  w konstruktorze jako `this.playbookManager`, woła `ensureStarterFiles(...)` (bootstrap +
  nowy agent + guard Jaskra).
- `modules/agents/profile/profile_advanced.ts`, `modules/agents/profile/profile_permissions.ts`
  - przez DI `plugin.agentManager.playbookManager`, po jednym wywołaniu `compileVaultMap(...)`
  każdy. `profile_skills.ts` dziś NIE woła playbookManagera wcale.
- `OnboardingModal` - zero importerów (kod nieosiągalny, wizard wyłączony w runtime).

---

## Playbook Builder - usunięty

Format „playbook.md" (6 sekcji: Rola/System Guide/Narzędzia/Skille/Delegowanie/Procedury,
`compilePlaybook` + generator per sekcja + wrapper `_safe()`) nie istnieje. Był wydmuszką -
`Agent.getSystemPrompt()` nigdy nie czytał skompilowanego playbooka. Ideę „agent ma ściągę
tego co potrafi" przejął **chudy rdzeń promptu** (`modules/prompts`, Decision Tree) + **indeks
skilli** (`_buildSkillIndex`) - oba budowane na żywo przy KAŻDYM wywołaniu promptu, nie
kompilowane raz do pliku. Jedyne co ten moduł dziś kompiluje do pliku to `vault_map.md`
(sekcja „Public API" wyżej).

---

## STARTER vault maps (pierwsze uruchomienie)

Funkcja `getStarterVaultMaps()` (wewnętrzna, nieeksportowana) zwraca słownik szablonów
`vault_map.md` dla 3 wbudowanych agentów: `jaskier`, `borys`, `nika`. Wszystkie tłumaczone
via `t('starter.vault_map.<agent_name>')`. Zwykła funkcja wołana z `_ensureVaultMap` - `t()`
odpala się przy każdym wywołaniu, już po ustawieniu locale.

`ensureStarterFiles(agents)` przy pierwszym uruchomieniu pluginu (i przy tworzeniu nowego
agenta) tworzy `vault_map.md` dla każdego, jeśli go jeszcze nie ma.

Custom agenci bez startera dostają **generic vault map** (fallback `_genericVaultMap(agent)` -
lista `focusFolders` albo „pełny dostęp" gdy pusta).

---

## Kluczowe decyzje

- **Wizard MINIMUM, resztę prowadzi Jaskier**: user wjeżdża szybko (1-2 minuty), zamiast
  długiego wizarda. Jaskier prowadzi dalej naturalną rozmową.
- **`requestUrl` zamiast `fetch`**: test klucza API przy pierwszym uruchomieniu robiony przez
  `fetch` miał problemy CORS z niektórymi providerami (np. Anthropic). Naprawione na
  `requestUrl` (Obsidian API).
- **`PlaybookManager` mieszka w onboarding/, nie w core/**: tematycznie należy tutaj (kompiluje
  dane per agent - `vault_map.md`). Core to fundament (security, utils, i18n).

---

## Gotchas

- ⚠️ **Wizard tylko raz** - flaga `pkmAssistant.onboardingCompleted` w `data.json`. Re-run musi
  być explicit (przycisk w settings).
- ⚠️ **Test API key musi być z `requestUrl`** - `fetch` w pluginach Obsidian ma problemy z CORS
  dla niektórych providerów (np. Anthropic).
- ⚠️ **Anthropic test "400 = OK" hack** (`OnboardingModal.js:370-372`) - celowo wysyła bad
  request (`max_tokens: 1`) bo Anthropic wymaga `messages` nawet dla testu API key. Status 400
  traktowany jako sukces. Ukryta logika.
- ⚠️ **Hardcoded URL endpoints 7 platform** (OnboardingModal `:345` i sąsiednie) - mogą się
  zdezaktualizować, brak fallback / retry. Jeśli endpoint padnie wszyscy userzy mają failed test.
- ⚠️ **`onboardingCompleted` ustawiany 2×** (`OnboardingModal:452, 507`) - Cloud finish + skip
  path, drugi set redundant.
- ⚠️ **Fallback chain `plugin.env?.settingsStore?.settings || plugin.settings`** może maskować
  bugi (rozjazd źródeł ustawień) - do uporządkowania.
- ⚠️ **`_extractVaultMapSection` używa polskich nazw sekcji** `Strefy użytkownika`/`Strefy
  agentowe` (patrz `compileVaultMap` w kodzie) - zmiana nazw sekcji w i18n źródle złamie
  parsowanie.
- Moduł importuje tylko `obsidian`, `modules/crystal-soul`, `core/i18n`, `core/utils/Logger` -
  patrz „Zależności" wyżej.

---

## Powiązane

- `modules/agents/CLAUDE.md` - Jaskier hardcoded factory (HumanVibe.js); jedyny importer tego
  modułu (`AgentManager` instancjuje `PlaybookManager`, `profile_advanced`/`profile_permissions`
  wołają `compileVaultMap` przez DI)
- `modules/crystal-soul/CLAUDE.md` - `UiIcons` w OnboardingModal (1 import)
