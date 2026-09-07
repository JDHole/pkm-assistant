# modules/skills/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Skill engine v2.** Skille to **przepisy** dla agenta — instrukcje krok-po-kroku zapisane jako pliki `SKILL.md` w vaulcie usera. Każdy skill może mieć `pre-questions` (pytania do usera przed wykonaniem) + `{{placeholders}}` (zmienne podstawiane w runtime). Użytkownik klika skill w UI lub model sam go wywołuje (jeśli nie ma `disable-model-invocation`).

**Status:** 🚀 **ACTIVE.** Przeniesione w Mapa-6 (2026-04-26). Strukturalna migracja gotowa, zmiany funkcjonalne odkładane do Refaktoru.

**Sprint Refaktoru — który mnie dotyka:**
- ✅ [Sprint 05 Sub-agents v2 + Inline Triggers UI](../../Refaktor/Sprinty/SPRINT_05_Sub_Agents_v2_Inline_Triggers.md) **DONE 2026-04-28** — Z13 SK-1 BUG-1 dead code (FIXED, supporting files check przed return) + SK-2 DRY-1 substituteVariables (FIXED, import z `modules/skills/index.js`) + slim bar 3 sekcje (skille + MCP + sub-agenty)
- ✅ [Sprint 05.5 Hotfix](../../Refaktor/Decyzje_Sesji/2026-04-29_post_sprint_05_HOTFIX.md) **DONE 2026-04-29** — popup `/`/`@` (Z8) + sidebar tab "Triggery" (Z9) + Z12 pre-questions modal accept (Plan B; inline expand DEFER v2.1)
- [Sprint 13b Polish + Decyzje](../../Refaktor/Sprinty/SPRINT_13b_Polish_Decyzje.md) — SK-3..10 drobnice (8 znalezisk)

---

## Co tu jest (kod)

```
modules/skills/
├── index.js                        # Public API barrel
├── types.js                        # typy współdzielone: SkillData/SkillInput/SkillQuestion/VaultLike
├── SkillLoader.js                  # 522 LOC — scan vaulta, parse SKILL.md, CRUD, cache, starter skills
├── SkillLoader.test.js             # testy SkillLoader (CRUD, cache, starter skills, migracja legacy)
├── SkillVariables.js               # 43 LOC — substitute / extract {{placeholders}}
├── skillFrontmatter.js             # S27 Z1 — wspólny parse/serialize SKILL.md (SkillLoader + SkillTemplateStore, pure)
├── SkillTemplateStore.js           # S27 Z1 — magazyn szablonów skilli (Zaplecze): loadAll/list/get/instantiate/save/delete
├── SkillTemplateStore.test.js      # testy magazynu szablonów
├── BackstageTab.js                 # ~22 LOC (S10 hotfix) — register tab + lazy-load renderSkillsTab
├── SkillsBackstageTab.js           # ~115 LOC (S10 hotfix) — render Skills tab w Backstage sidebar
├── SkillDetailView.js              # ~165 LOC (S10 hotfix) — render single skill detail view
├── SkillEditorModal.js             # 418 LOC (S31, z modules/shell/) — edytor skilla (tryby żywy/szablon)
├── CLAUDE.md                       # ten plik
└── SPRINT_05_NOTES.md              # notatki historyczne Sprint 05
```

Razem **~870 LOC** (po S10: +~300 LOC z migracji Backstage tab+detail z `modules/shell/sidebar/`).

**Skille NIE MAJĄ już narzędzi (E2.4 D17).** `skill_list` + `skill_execute` (pliki `SkillExecuteTool.js`/`SkillListTool.js` w `modules/mcp/`) **SKASOWANE**. Model odkrywa skille przez **cienki indeks w system promptcie** (nazwa + opis + ścieżka SKILL.md), a **pełny przepis wciąga narzędziem `read`** (`.pkm-assistant/skills/<slug>/SKILL.md`). Silnik (`SkillLoader`/`SkillVariables`/`resolveSkillConfig`) bez zmian.

**Skille jako pliki** żyją w vaulcie usera: `.pkm-assistant/skills/{slug}/SKILL.md`. Kuratorska kolekcja JDHole (`jdhole-skills/`) została **wyniesiona z repo pluginu** jako osobny zasób — NIE jest już częścią pluginu.

---

## Public API (`modules/skills/index.js`)

**Klasa `SkillLoader`:**
- `new SkillLoader(vault)` — konstruktor, vault z Obsidiana
- `loadAllSkills()` — async, czyta wszystkie skille z `.pkm-assistant/skills/`, zapełnia cache
- `getSkill(skillName)` — zwraca skill po slugu (cache.get) lub po name (fallback przez `Array.from`)
- `getAllSkills()` — wszystkie skille z cache jako tablica
- `getSkillsForAgent(skillNames)` — mapuje listę slugów/nazw na obiekty skilli (dla agentu)
- `reloadSkills()` — alias dla `loadAllSkills()`
- `saveSkill(skillData)` — zapisuje skill na dysk (create lub update), zapisuje jako `SKILL.md`
- `deleteSkill(skillName)` — kasuje folder skilla REKURENCYJNIE (references/, examples/ też), czyści cache; przyjmuje nazwę wyświetlaną LUB slug (fix smoke-04 finding 01, przepisany 2026-07-29 — zwrot `false` = nic nie skasowano, modal to raportuje)
- `ensureStarterSkills()` — przy pierwszym uruchomieniu tworzy 8 starter skilli (welcome-tour, daily-review, etc.)

**Funkcje `SkillVariables`:**
- `substituteVariables(prompt, values)` — zamienia `{{key}}` na `values[key]`. Niezmapowane zostają jak są.

> **S30 Z4 — 3 eksporty WYCIĘTE z barrela** (zero konsumentów spoza modułu):
> `SKILL_TEMPLATES_PATH`, `parseSkillMarkdown`, `serializeSkillFile`.
> **Definicje ŻYJĄ w bebechach** — format `SKILL.md` czytają/piszą `SkillLoader`
> i `SkillTemplateStore` przez lokalny `./skillFrontmatter.js`, ścieżkę magazynu zna store.
> Testy deep-importują pliki wprost.
>
> **Fabryka dead-code D7 (2026-09-02, AUD-dead-code-075/137):** `extractVariables`
> (`SkillVariables.ts`) SKASOWANA w całości, nie tylko wycięta z barrela — w odróżnieniu
> od trójki wyżej nie miała ŻADNEGO wołacza (nawet lokalnego, nawet testowego); podstawianie
> robi wyłącznie `substituteVariables`. Jeśli UI edytora skilli ma kiedyś podpowiadać
> zmienne z treści przepisu, funkcja jest do odtworzenia od zera (7 linii, `matchAll`).

**Brak metody `watch()`** — file watching nie jest zaimplementowane. Jeśli user edytuje skill ręcznie w vaulcie, trzeba wywołać `reloadSkills()`.

---

## Zależności

**Importuje z:**
- `core/utils/yamlParser` (parseFrontmatter, stringifyYaml)
- `core/utils/slugify`
- `core/i18n` (t)

**Importowany przez** (ścieżki sprzed migracji `src/` → `modules/`; semantyka aktualna):
- `modules/agents/AgentManager` — single source of truth dla `skillLoader` w pluginie
- `modules/agents/profile/profile_skills.js` — „+ nowy skill" bierze `loadSkillEditorModal()`
  z barrela (leniwy `import()` w handlerze kliknięcia)

> **S31 — `SkillEditorModal.js` (418 LOC) PRZYSZEDŁ tu z `modules/shell/`.** Edytor skilla to
> sprawa skilli; trzymanie go w shellu zmuszało `SkillDetailView` i `SkillsBackstageTab` do
> importu z barrela shella. Wewnątrz modułu wołany wprost (`./SkillEditorModal.js`), a na
> zewnątrz wydaje go **`loadSkillEditorModal()`** — bo plik statycznie importuje `obsidian`,
> a barrel skilli musi zostać obsidian-free (tak samo jak `renderSkillDetailView`).

**Zero importów cyklicznych.** Moduł nie importuje z modułów wyższych (shell); z sąsiadów
bierze tylko `modules/crystal-soul` (ikony) w plikach UI.

---

## Format skilla (SKILL.md)

```markdown
---
name: daily-review
description: "Krótki przegląd dnia z pytaniami refleksyjnymi"
category: productivity
version: 2
enabled: true
icon: "📋"
tags: [daily, review, productivity]
user-invocable: true
disable-model-invocation: false
pre-questions:
  - key: dzien
    question: "Który dzień podsumować?"
    default: "dzisiaj"
---

# Body skilla

Przeanalizuj dzień {{dzien}} i przygotuj refleksję...
```

**Frontmatter pola** (wszystkie opcjonalne poza `name` + `description`):
- `category` — grupowanie wizualne (productivity / writing / system / ...)
- `tags` — lista tagów
- `icon` — emoji wyświetlane w UI
- ~~`allowed-tools`~~ — **WYCIĘTE w S27 (D6)**; stare pliki z tym polem są po prostu ignorowane przez parser
- `user-invocable: false` — ukrywa skill z UI usera (tylko model może wywołać)
- `disable-model-invocation: true` — model NIE może sam wywołać, tylko user
- `pre-questions` — lista pytań do usera przed wykonaniem (każde z `key`, `question`, opcjonalnie `default`, `type`, `options`, `depends_on`, `placeholder`, `rows`)
- `model` — override modelu dla tego skilla
- `version`, `enabled`, `slug` — metadata

**Backward compat:** loader czyta też v1 `skill.md` (lowercase).

---

## Kluczowe decyzje

- **Skille jako pliki .md** zamiast YAML — bo user pisze treść skilla w naturalnym Markdown, łatwo edytować w Obsidianie. Frontmatter ma metadata.
- **Centralna lokalizacja** `.pkm-assistant/skills/` — wcześniejsza wersja miała per-agent foldery (sesja 48-50 zmieniła na centralną z agent referencing).
- **`{{placeholders}}` zamiast funkcji szablonowych** — prostota. User pisze `Witaj {{user_name}}, dziś masz {{tasks_count}} taski`. Skill engine podstawia w runtime.
- **DI zamiast bezpośrednich importów u konsumentów** — MCP tools i Modal UI dostają `skillLoader` przez `plugin.agentManager.skillLoader`. Tylko AgentManager bezpośrednio instancjonuje SkillLoader. Jednolite ownership.
- **Skill nie przełącza już trybu (E2.3 D21)** — tryby pracy Gadaj/Rób usunięte, więc dawna auto-promocja `gadaj → rob` (gdy skill ma write tools) + `_modeRestore` w `SkillExecuteTool` zniknęły. Skill zwraca prompt + `_requiresPlan`; narzędzia nie zależą od trybu, a o zapis pyta autonomia (approval).

---

## Gotchas

- ✅ **Dead code w `_loadSkillFromFolder` — FIXED Sprint 05 Z13** (commit `8605878`). `_loadSkillFromFolder` teraz: `const skill = {...}` (linia 285) → `// Check supporting files` (linie 310-315, REACHABLE) → `return skill` (linia 317). Pola `hasTemplate` / `hasReferences` / `hasExamples` ustawiane poprawnie z `vault.adapter.exists(...)`. Pokryte testem [SkillLoader.test.ts](SkillLoader.test.ts).
- ⚠️ **Cache klucz to slug, ale `getSkill(skillName)` próbuje najpierw cache.get(skillName)** — działa tylko gdy `skillName === slug`. W innym przypadku fallback przez `Array.from(...).find()`. Niespójność semantyki klucza, do uporządkowania w Refaktorze (osobne TODO, nie część Z13).
- ✅ **`substituteVariables` duplikat — FIXED Sprint 05 Z13** (commit `8605878`). [`modules/chat/chat/chat_ui.ts:15`](../chat/chat/chat_ui.ts#L15) importuje `substituteVariables` z `modules/skills/index.js` (kanon w [SkillVariables.ts:21-28](SkillVariables.ts#L21)). Brak duplikatu inline.
- ⚠️ **i18n race condition** w starter skills — `getStarterSkills()` woła `t('starter.skill...')` w runtime. Wymaga zainicjalizowanego locale ZANIM `ensureStarterSkills()` się wywoła. Sprawdzić w sesji audytu init flow.
- ⚠️ **Skan pełny, nie watcher — koszt rośnie z liczbą skilli, nie z rozmiarem vaulta.** Skoro nie ma `watch()` (gotcha wyżej), nie ma co „lagować" w tle. `loadAllSkills()` robi `list('.pkm-assistant/skills/')`, po czym dla KAŻDEGO folderu osobno sprawdza istnienie i czyta `SKILL.md` (`_loadSkillFromFolder`) — zakres na twardo ograniczony do folderu skilli, nie cały vault. Ten pełny skan odpala się tylko w dwóch momentach: raz przy boot pluginu (`AgentManager.initialize`) i raz po KAŻDYM zapisie narzędziem `write`/`vault_write` pod `.pkm-assistant/skills/**` (`chat_streaming.ts` → `agentManager.reloadSkills()`, D6d). User z bardzo dużą liczbą skilli poczuje krótkie zamrożenie przy KAŻDYM takim zapisie (skan jest `await`-owany), nie ciągłe obciążenie w tle.
- ⚠️ **Skill bez frontmatter `agent:`** = core skill, dostępny dla wszystkich. (Faktycznie obecne API: każdy skill jest globalny — przypisywanie do agenta dzieje się przez `skills:[]` w yaml agenta, nie przez `agent:` field w skillu.)
- ⚠️ **`{{nested.path}}`** nie obsługiwane (regex `\{\{(\w+)\}\}` matchuje tylko `\w+`). Jak chcesz głębokie path → flatten w args.

---

## TODO (per-modułowe)

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md).

Krytyczne (wybrane):
- ✅ **BUG-1** dead code w `_loadSkillFromFolder` — **FIXED Sprint 05 Z13** (commit `8605878`)
- ✅ **DRY-1** chat_ui.js duplikuje substituteVariables — **FIXED Sprint 05 Z13** (commit `8605878`, import z `modules/skills/index.js`)
- ✅ **Mechanizm "ikonek inline"** — **DONE Sprint 05 + S05.5 hotfix**: slim bar `cs-skillbar` 3 sekcje + popup `/`/`@` z 3 sekcjami ([modules/chat/chat/TriggerPopup.ts](../chat/chat/TriggerPopup.ts)) + sidebar tab "Triggery" ([modules/shell/sidebar/TriggersView.ts](../shell/sidebar/TriggersView.ts)). Wizja `INLINE_TRIGGERS_UI.md` zrealizowana.
- 🟡 **Jaskier onboarding skill** "Naucz mnie tworzyć custom sub-agentów"
- 🟡 Wydzielenie `jdhole-skills/` do osobnego repo (post-refaktor)

---

## Powiązane

- Materiał planistyczny w vaulcie właściciela: Wizja przekrojowa „INLINE_TRIGGERS_UI" (skills + sub-agents + mcp + chat + agents)
- Materiał planistyczny w vaulcie właściciela: Wizja „MEMORY_v2_RETRIEVAL_v2", Blok 4 (oryginał inline triggers, krótki — szczegóły idą do INLINE_TRIGGERS_UI)
- `modules/agents/CLAUDE.md` — agenci mają swoje skille (przez `skills:[]` w yamlu)
- `jdhole-skills/` — kuratorska kolekcja JDHole, **wyniesiona z repo pluginu** (osobny zasób, nie część pluginu)

---

## Historia

- **Sesja 15** — pierwszy SkillLoader
- **Sesja 48-50** — Skill v2 (SKILL.md format, SkillEditorModal, allowed-tools, pre-questions)
- **Sesja 117** — Skill Mode Guard (auto-switch trybu Gadaj/Rób)
- **Sesja ~v3.0** — Dispatcher Model: Mode Guard usunięty, zamiast auto-promote z gadaj→rob w SkillExecuteTool
- **Sesja 119** — 3 nowe skille Tola (napisz / popraw / styl)
- **Sesja 128 D5** (2026-04-25) — placeholder rozbudowany do wzorca (z błędnym API)
- **Mapa-6** (2026-04-26) — przenosiny `src/skills/` → `modules/skills/`, naprawione zmyślone API w placeholderze, dopisany dead code gotcha, ~10 znalezisk → TODO, Wizja INLINE_TRIGGERS_UI
- **E1.6 docs-freshness** (2026-07-21) — sprostowano ścieżki: `SkillExecuteTool`/`SkillListTool` w `modules/mcp/` (nie `src/mcp/`); `jdhole-skills/` wyniesione z repo (nie „~180 skilli w roocie"); importerzy na ścieżki `modules/`. Kod modułu bez zmian.

## E2.4 update (2026-07-23) — model odkrywania: indeks → read (D17)

**Skille bez narzędzi.** `skill_list`/`skill_execute` skasowane. Nowy przepływ:

1. **Odkrywalność = indeks w system promptcie** (`modules/prompts/skillIndex.js` → `buildSkillIndex`). Per skill: `⚡ nazwa: opis → read("ścieżka SKILL.md")`. Skille manual-only (`disable-model-invocation: true`) → osobna lista „tylko na wyraźne życzenie usera". Budżet 8000 zn (nadmiar → `…i N kolejnych — list(".pkm-assistant/skills")`). Źródło danych: `AgentManager._buildBaseContext` przenosi `name/slug/description/category/icon/disableModelInvocation/path` (naprawiony bug: dawniej gubił `icon` i `disableModelInvocation`, więc manual-only trafiały do listy „użyj bez pytania", a `hiddenSkills` było puste).
2. **Przepis = `read`** pod `.pkm-assistant/skills/**`. Centralna blokada `.pkm-assistant/**` (`modules/tools/vault_path_validator.js`, E1.8) dostała **jeden wyjątek TYLKO-ODCZYT**: `read`/`list` (scope=vault) przekazują `allowSkillsRead:true`, więc wolno CZYTAĆ przepisy. Zapis/kasowanie/create_folder — bez zmian (BLOKADA). Pamięć agentów + indeks semantyczny — dalej fail-closed.
3. **Płot przypisania = indeks per agent.** Indeks pokazuje tylko skille przypisane agentowi (`getSkillsForAgent`). ⚠️ **Świadome:** czytanie CUDZEGO przepisu `read`em jest możliwe i akceptowalne — przepis to zwykły markdown, twardy płot to whitelisty narzędzi + izolacja pamięci, nie ukrywanie treści skilli.
4. **Ścieżka UI (marker `@@skill:`) — przepis inline.** Klik w slim barze / TriggerPopup wstawia marker; `chat_streaming` resolwuje skill przez `resolveSkillConfig` (overrides `prompt_append` DZIAŁAJĄ — doczepki nie giną) i wstrzykuje PEŁNY przepis do instrukcji tury (`buildInlineTriggerInstruction`, `modules/chat/`). `pre-questions` (frontmatter) obsługuje `_showSkillPreQuestions` w `chat_ui.js` (ścieżka guzika slim baru — podstawia `{{key}}` i wrzuca prompt do inputu); marker `pre-questions` NIE nosi (jak dawniej). Schemat `pre-questions` bez zmian.
5. **Nudge todo po skillu** — kodowy hook w `chat_streaming` (dawny trigger `skill_execute` OUT): marker → `turn.skillActiveAt=0`; `read` pod `.pkm-assistant/skills/**` → `turn.skillActiveAt=i`. `planHint` doklejka umarła z narzędziem — nudge kodowy jest jedynym enforcementem.

Starter skille (`SkillLoader.getStarterSkills`) + treści playbooków w i18n zaktualizowane (brak `allowed-tools: [skill_list]`, brak „Sprawdź skill_list / skill_execute").

## E2.8 update (2026-07-23) — badge „📎 dodatki" + SkillDetailView wzorcem panelu

- **Badge „📎 dodatki" w zakładce Umiejętności panelu agenta (C5/S30).** `SkillLoader._loadSkillFromFolder` ustawia `hasTemplate`/`hasReferences`/`hasExamples` (istnienie `template.md` / katalogu `references` / `examples` obok `SKILL.md` — mechanika sprzed E2.8, Sprint 05). E2.8 **wystawia je jako badge**: `profile_skills.js` renderuje `📎 {t('profile.skills.attachments')}` (i18n `dodatki` / `extras`) gdy `hasTemplate || hasReferences || hasExamples`. Grid skilli grupowany per KATEGORIA (frontmatter `category`).
- **`SkillDetailView` = wzorzec „detal na cały sidebar" reużywany przez panel (C5).** Barrel eksportuje `renderSkillDetailView(...)` (lazy-load — `SkillDetailView.js` statycznie importuje `obsidian`, więc dynamic import trzyma barrel obsidian-free). Panel agenta (klik skilla) i sidebar Zaplecze wchodzą tą samą ścieżką detalu (frontmatter + pełny przepis edytowalny przez `SkillEditorModal`). Silnik (`SkillLoader`/`SkillVariables`/`resolveSkillConfig`) bez zmian względem E2.4.

## A4 update (2026-07-24) — Nika tworzy agenta prymitywami

- Fabryczny starter `create-agent` ma wersję 3. To przepis używający wyłącznie
  `list`, `read`, `create_folder` i `write`; **nie istnieje `agent_create`**.
- Przepis wymaga admin access u agenta wykonującego, zbiera świadomą decyzję usera,
  zapisuje create-only `.pkm-assistant/agents/<slug>.yaml` z
  `access_policy_version:2`, bezpieczną negatywną listą `disabled_tools` i
  `admin_access:false`, a potem weryfikuje plik przez `read`.
- Aktualizacja istniejącego profilu = `read` + precyzyjny `write mode:patch`, nie
  pełne nadpisanie.
- `SkillLoader._migrateLegacyCreateAgentStarter()` podmienia wyłącznie rozpoznaną
  fabryczną wersję v2 (mocne sygnatury), zachowując `SKILL.v2-backup.md`.
  Własny/przerobiony skill usera jest nietykalny.

## S27 update (2026-07-28) — szablony skilli w Zapleczu + wywałka `allowed-tools`

- **Nowy magazyn: `SkillTemplateStore.js`** (`.pkm-assistant/templates/skills/<slug>/SKILL.md`
  + pole `version: N`). Zaplecze → zakładka „Szablony skilli" pokazuje **wyłącznie szablony**
  (D4); żywe skille żyją u agentów (profil → Umiejętności). API: `loadAll / list / get / count /
  createFromData / save (bump vN) / delete / instantiate`. Eksport przez barrel; owner =
  `AgentManager.skillTemplateStore` (wzór `skillLoader`). AUD-dead-code-060/235 (2026-09-02):
  `AgentManager.reloadTemplates()` skasowana — nie miała żadnego wołacza (magazyny są
  przeładowywane wyłącznie przy `initialize()`, przy starcie/reload managera).
- **D3 „kopia, nie link":** `instantiate()` odlewa NIEZALEŻNĄ kopię do `.pkm-assistant/skills/`.
  Edycja szablonu nie rusza kopii. Kopia niesie `from_template: "<nazwa> vN"` (w modelu skilla
  jako `fromTemplate`) i startuje od `version: 1`. Kolizja slugu → sufiks doklejany do NAZWY
  (`Plan` → `Plan 2` → slug `plan-2`), żeby `slugify(name)` zgadzał się z folderem.
- **Nowy plik `skillFrontmatter.js`** — wspólny parse/serialize `SKILL.md` dla `SkillLoader`
  (żywe) i `SkillTemplateStore` (szablony). Jedno miejsce = format formy odlewniczej nie może
  się rozjechać z formatem odlewu. Pure, bez `obsidian`.
- **D6 — `allowed-tools` WYCIĘTE z całego łańcucha:** parser, zapis, cache, siatka w
  `SkillEditorModal`, chipy w `SkillDetailView`, pole w 7/8 starterach, fragment składni w treści
  startera `create-skill` (pl+en), klucze i18n. Pole nigdy nie było egzekwowane (fasada) — o tym,
  co agent może zrobić, decyduje oś `disabled_tools` + `ToolRegistry.filterByAgent`.
  **Stare pliki usera z tym polem: parser ignoruje nieznane pola → ZERO migracji.**
- **`SkillEditorModal` ma dwa tryby** (5. argument `options`): `{template:true}` = zapis do
  magazynu szablonów (wersja read-only, podbija ją store), `{alsoTemplate:true}` = checkbox
  „Zapisz też jako szablon w Zapleczu" przy tworzeniu żywego skilla u agenta (Z6).
  `SkillDetailView` obsługuje `params.template` (ten sam widok dla szablonu i żywego skilla).
- **Miejsce narodzin żywego skilla przeniesione do profilu agenta** (`profile_skills.js`:
  „+ nowy skill od zera" i „+ z szablonu"). W Zapleczu tworzy się już tylko szablony.

## E3.5 update (2026-07-29) — fabryczne szablony Deep Research + fix regresji pre-questions

- **Zaplecze przestało startować puste:** `ensureFactoryTemplates()` (`modules/agents/factoryTemplates.js`,
  wołane z `AgentManager.initialize` po `loadAll`) seeduje fabryczne szablony skilli
  `deep-research-web` (🔎) i `deep-research-vault` (🧠) + szablon suba `researcher`.
  Seed RAZ — marker `.pkm-assistant/templates/.factory-seeded-v1`; kasacja usera SZANOWANA
  (szablon nie wraca po restarcie); userowy szablon pod fabryczną nazwą wygrywa (zero sufiksów).
  Treści przez i18n (`factory.template.*`, pl+en) — wzór starter skills.
- **Przepisy deep-research (7 kroków):** wymagania (delegate + artifact_* + web) → pytanie
  badawcze → `artifact_create typ:"raport"` → podpytania wg pre-question głębokości
  (szybki 2-3 / głęboki 4-5) → `delegate` tasks równolegle (`aspect:"researcher"`,
  `timeout_ms: 300000`; fallback bez aspect) → synteza z dosłownymi cytatami → dogrywka
  (max 2 rundy, tylko głęboki) → status `gotowy`. Vault-wariant: wikilinki + sekcja
  „Białe plamy" (czego w vaulcie NIE MA). Worker read-only; raport składa agent główny.
- **🔴 FIX regresji S27:** `parseSkillMarkdown` liczył `preQuestions`, ale NIE zwracał ich
  w obiekcie (zgubione z returna przy unifikacji S27 Z1) — każdy skill wczytany z dysku
  tracił pre-questions, modal pytań przed skillem był martwy, placeholdery `{{...}}`
  zostawały niepodstawione. Fix: `preQuestions` w return + test regresyjny load-z-dysku
  w `SkillLoader.test.js`.
