# modules/skills/

> Fizyczne pliki modułu mają rozszerzenie `.ts`. Nazwy `.js` w tym dokumencie oznaczają albo
> specyfikatory importów, albo zapisy sprzed konwersji na TypeScript, celowo pozostawione bez
> zmian.

**Skill engine v2.** Skille to **przepisy** dla agenta - instrukcje krok-po-kroku zapisane jako pliki `SKILL.md` w vaulcie usera. Każdy skill może mieć `pre-questions` (pytania do usera przed wykonaniem) + `{{placeholders}}` (zmienne podstawiane w runtime). Użytkownik klika skill w UI lub model sam go wywołuje (jeśli nie ma `disable-model-invocation`).

**Status:** ACTIVE.

---

## Co tu jest (kod)

```
modules/skills/
├── index.js                        # Public API barrel
├── types.js                        # typy współdzielone: SkillData/SkillInput/SkillQuestion/VaultLike
├── SkillLoader.js                  # 522 LOC - scan vaulta, parse SKILL.md, CRUD, cache, starter skills
├── SkillLoader.test.js             # testy SkillLoader (CRUD, cache, starter skills, migracja legacy)
├── SkillVariables.js               # 43 LOC - substitute / extract {{placeholders}}
├── skillFrontmatter.js             # wspólny parse/serialize SKILL.md (SkillLoader + SkillTemplateStore, pure)
├── SkillTemplateStore.js           # magazyn szablonów skilli (Zaplecze): loadAll/list/get/instantiate/save/delete
├── SkillTemplateStore.test.js      # testy magazynu szablonów
├── BackstageTab.js                 # ~22 LOC - register tab + lazy-load renderSkillsTab
├── SkillsBackstageTab.js           # ~115 LOC - render Skills tab w Backstage sidebar
├── SkillDetailView.js              # ~165 LOC - render single skill detail view
├── SkillEditorModal.js             # 418 LOC (przeniesiony z modules/shell/) - edytor skilla (tryby żywy/szablon)
├── CLAUDE.md                       # ten plik
```

Razem **~870 LOC** (obejmuje ~300 LOC przeniesione z `modules/shell/sidebar/` - zakładka Backstage + widok szczegółu skilla).

**Skille NIE MAJĄ już narzędzi.** `skill_list` + `skill_execute` (pliki `SkillExecuteTool.js`/`SkillListTool.js` w `modules/mcp/`) **SKASOWANE**. Model odkrywa skille przez **cienki indeks w system promptcie** (nazwa + opis + ścieżka SKILL.md), a **pełny przepis wciąga narzędziem `read`** (`.pkm-assistant/skills/<slug>/SKILL.md`). Silnik (`SkillLoader`/`SkillVariables`/`resolveSkillConfig`) bez zmian.

**Skille jako pliki** żyją w vaulcie usera: `.pkm-assistant/skills/{slug}/SKILL.md`. Kuratorska kolekcja JDHole (`jdhole-skills/`) jest osobnym zasobem, wyniesionym z repo pluginu - NIE jest częścią pluginu.

---

## Public API (`modules/skills/index.js`)

**Klasa `SkillLoader`:**
- `new SkillLoader(vault)` - konstruktor, vault z Obsidiana
- `loadAllSkills()` - async, czyta wszystkie skille z `.pkm-assistant/skills/`, zapełnia cache
- `getSkill(skillName)` - zwraca skill po slugu (cache.get) lub po name (fallback przez `Array.from`)
- `getAllSkills()` - wszystkie skille z cache jako tablica
- `getSkillsForAgent(skillNames)` - mapuje listę slugów/nazw na obiekty skilli (dla agentu)
- `reloadSkills()` - alias dla `loadAllSkills()`
- `saveSkill(skillData)` - zapisuje skill na dysk (create lub update), zapisuje jako `SKILL.md`
- `deleteSkill(skillName)` - kasuje folder skilla REKURENCYJNIE (references/, examples/ też), czyści cache; przyjmuje nazwę wyświetlaną LUB slug (zwrot `false` = nic nie skasowano, modal to raportuje)
- `ensureStarterSkills()` - przy pierwszym uruchomieniu tworzy 8 starter skilli (welcome-tour, daily-review, etc.)

**Funkcje `SkillVariables`:**
- `substituteVariables(prompt, values)` - zamienia `{{key}}` na `values[key]`. Niezmapowane zostają jak są.

> **3 eksporty WYCIĘTE z barrela** (zero konsumentów spoza modułu):
> `SKILL_TEMPLATES_PATH`, `parseSkillMarkdown`, `serializeSkillFile`.
> **Definicje ŻYJĄ w bebechach** - format `SKILL.md` czytają/piszą `SkillLoader`
> i `SkillTemplateStore` przez lokalny `./skillFrontmatter.js`, ścieżkę magazynu zna store.
> Testy deep-importują pliki wprost.
>
> `extractVariables` (`SkillVariables.ts`) SKASOWANA w całości, nie tylko wycięta z barrela -
> w odróżnieniu od trójki wyżej nie miała ŻADNEGO wołacza (nawet lokalnego, nawet testowego);
> podstawianie robi wyłącznie `substituteVariables`. Jeśli UI edytora skilli ma kiedyś
> podpowiadać zmienne z treści przepisu, funkcja jest do odtworzenia od zera (7 linii, `matchAll`).

**Brak metody `watch()`** - file watching nie jest zaimplementowane. Jeśli user edytuje skill ręcznie w vaulcie, trzeba wywołać `reloadSkills()`.

---

## Zależności

**Importuje z:**
- `core/utils/yamlParser` (parseFrontmatter, stringifyYaml)
- `core/utils/slugify`
- `core/i18n` (t)

**Importowany przez:**
- `modules/agents/AgentManager` - single source of truth dla `skillLoader` w pluginie
- `modules/agents/profile/profile_skills.js` - „+ nowy skill" bierze `loadSkillEditorModal()`
  z barrela (leniwy `import()` w handlerze kliknięcia)

> **`SkillEditorModal.js` (418 LOC) mieszka tu, nie w `modules/shell/`.** Edytor skilla to
> sprawa skilli; trzymanie go w shellu zmuszało `SkillDetailView` i `SkillsBackstageTab` do
> importu z barrela shella. Wewnątrz modułu wołany wprost (`./SkillEditorModal.js`), a na
> zewnątrz wydaje go **`loadSkillEditorModal()`** - bo plik statycznie importuje `obsidian`,
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
- `category` - grupowanie wizualne (productivity / writing / system / ...)
- `tags` - lista tagów
- `icon` - emoji wyświetlane w UI
- ~~`allowed-tools`~~ - **WYCIĘTE**; stare pliki z tym polem są po prostu ignorowane przez parser
- `user-invocable: false` - ukrywa skill z UI usera (tylko model może wywołać)
- `disable-model-invocation: true` - model NIE może sam wywołać, tylko user
- `pre-questions` - lista pytań do usera przed wykonaniem (każde z `key`, `question`, opcjonalnie `default`, `type`, `options`, `depends_on`, `placeholder`, `rows`)
- `model` - override modelu dla tego skilla
- `version`, `enabled`, `slug` - metadata

**Backward compat:** loader czyta też v1 `skill.md` (lowercase).

---

## Odkrywanie i wywoływanie skilli przez model

1. **Odkrywalność = indeks w system promptcie** (`modules/prompts/skillIndex.js` → `buildSkillIndex`). Per skill: `⚡ nazwa: opis → read("ścieżka SKILL.md")`. Skille manual-only (`disable-model-invocation: true`) trafiają na osobną listę „tylko na wyraźne życzenie usera". Budżet 8000 znaków (nadmiar → `…i N kolejnych - list(".pkm-assistant/skills")`). Źródło danych: `AgentManager._buildBaseContext` przenosi `name/slug/description/category/icon/disableModelInvocation/path`.
2. **Przepis = `read`** pod `.pkm-assistant/skills/**`. Centralna blokada `.pkm-assistant/**` (`modules/tools/vault_path_validator.js`) ma jeden wyjątek TYLKO-ODCZYT: `read`/`list` (scope=vault) przekazują `allowSkillsRead:true`, więc wolno CZYTAĆ przepisy. Zapis/kasowanie/create_folder - bez zmian (BLOKADA). Pamięć agentów + indeks semantyczny - dalej fail-closed.
3. **Płot przypisania = indeks per agent.** Indeks pokazuje tylko skille przypisane agentowi (`getSkillsForAgent`). ⚠️ **Świadome:** czytanie CUDZEGO przepisu `read`em jest możliwe i akceptowalne - przepis to zwykły markdown, twardy płot to whitelisty narzędzi + izolacja pamięci, nie ukrywanie treści skilli.
4. **Ścieżka UI (marker `@@skill:`) - przepis inline.** Klik w slim barze / TriggerPopup wstawia marker; `chat_streaming` resolwuje skill przez `resolveSkillConfig` (overrides `prompt_append` DZIAŁAJĄ - doczepki nie giną) i wstrzykuje PEŁNY przepis do instrukcji tury (`buildInlineTriggerInstruction`, `modules/chat/`). `pre-questions` (frontmatter) obsługuje `_showSkillPreQuestions` w `chat_ui.js` (ścieżka guzika slim baru - podstawia `{{key}}` i wrzuca prompt do inputu); marker `pre-questions` NIE nosi. Schemat `pre-questions` bez zmian.
5. **Nudge todo po skillu** - kodowy hook w `chat_streaming`: marker → `turn.skillActiveAt=0`; `read` pod `.pkm-assistant/skills/**` → `turn.skillActiveAt=i`. Nudge kodowy jest jedynym enforcementem.

Starter skille (`SkillLoader.getStarterSkills`) i treści playbooków w i18n nie zawierają
`allowed-tools` ani odniesień do `skill_list`/`skill_execute`.

**Badge „📎 dodatki" w zakładce Umiejętności panelu agenta.** `SkillLoader._loadSkillFromFolder`
ustawia `hasTemplate`/`hasReferences`/`hasExamples` (istnienie `template.md` / katalogu
`references` / `examples` obok `SKILL.md`). `profile_skills.js` renderuje `📎 {t('profile.skills.attachments')}`
gdy którekolwiek z nich jest `true`. Grid skilli grupowany per kategoria (frontmatter `category`).

**`SkillDetailView` to wzorzec „detal na cały sidebar" reużywany przez panel agenta i Zaplecze.**
Barrel eksportuje `renderSkillDetailView(...)` (lazy-load - `SkillDetailView.js` statycznie
importuje `obsidian`, więc dynamic import trzyma barrel obsidian-free). Panel agenta (klik
skilla) i sidebar Zaplecze wchodzą tą samą ścieżką detalu (frontmatter + pełny przepis
edytowalny przez `SkillEditorModal`).

---

## Szablony skilli (SkillTemplateStore)

**`SkillTemplateStore`** (`.pkm-assistant/templates/skills/<slug>/SKILL.md` + pole `version: N`)
- magazyn szablonów skilli. Zaplecze → zakładka „Szablony skilli" pokazuje wyłącznie szablony;
żywe skille żyją u agentów (profil → Umiejętności). API: `loadAll / list / get / count /
createFromData / save (bump vN) / delete / instantiate`. Eksport przez barrel; owner =
`AgentManager.skillTemplateStore` (wzór `skillLoader`).

**„Kopia, nie link":** `instantiate()` odlewa NIEZALEŻNĄ kopię do `.pkm-assistant/skills/`.
Edycja szablonu nie rusza kopii. Kopia niesie `from_template: "<nazwa> vN"` (w modelu skilla
jako `fromTemplate`) i startuje od `version: 1`. Kolizja slugu → sufiks doklejany do NAZWY
(`Plan` → `Plan 2` → slug `plan-2`), żeby `slugify(name)` zgadzał się z folderem.

**`skillFrontmatter.js`** - wspólny parse/serialize `SKILL.md` dla `SkillLoader` (żywe) i
`SkillTemplateStore` (szablony). Jedno miejsce = format formy odlewniczej nie może się
rozjechać z formatem odlewu. Pure, bez `obsidian`.

**`allowed-tools` wycięte z całego łańcucha:** parser, zapis, cache, siatka w `SkillEditorModal`,
chipy w `SkillDetailView`, pole w starterach, klucze i18n. Pole nigdy nie było egzekwowane
(fasada) - o tym, co agent może zrobić, decyduje oś `disabled_tools` + `ToolRegistry.filterByAgent`.
Stare pliki usera z tym polem: parser ignoruje nieznane pola.

**`SkillEditorModal` ma dwa tryby** (5. argument `options`): `{template:true}` = zapis do
magazynu szablonów (wersja read-only, podbija ją store), `{alsoTemplate:true}` = checkbox
„Zapisz też jako szablon w Zapleczu" przy tworzeniu żywego skilla u agenta. `SkillDetailView`
obsługuje `params.template` (ten sam widok dla szablonu i żywego skilla).

Żywy skill powstaje w profilu agenta (`profile_skills.js`: „+ nowy skill od zera" i „+ z
szablonu"). W Zapleczu tworzy się już tylko szablony.

---

## Starter skill: create-agent

Fabryczny starter `create-agent` (wersja 3) to przepis używający wyłącznie `list`, `read`,
`create_folder` i `write`; nie istnieje narzędzie `agent_create`.

Przepis wymaga admin access u agenta wykonującego, zbiera świadomą decyzję usera, zapisuje
create-only `.pkm-assistant/agents/<slug>.yaml` z `access_policy_version:2`, bezpieczną
negatywną listą `disabled_tools` i `admin_access:false`, a potem weryfikuje plik przez `read`.

Aktualizacja istniejącego profilu = `read` + precyzyjny `write mode:patch`, nie pełne
nadpisanie.

`SkillLoader._migrateLegacyCreateAgentStarter()` podmienia wyłącznie rozpoznaną fabryczną
wersję v2 (mocne sygnatury), zachowując `SKILL.v2-backup.md`. Własny/przerobiony skill usera
jest nietykalny.

---

## Szablony fabryczne (Deep Research)

`ensureFactoryTemplates()` (`modules/agents/factoryTemplates.js`, wołane z `AgentManager.initialize`
po `loadAll`) seeduje fabryczne szablony skilli `deep-research-web` (🔎) i `deep-research-vault`
(🧠) + szablon suba `researcher`. Seed następuje RAZ - marker `.pkm-assistant/templates/.factory-seeded-v1`;
kasacja usera jest szanowana (szablon nie wraca po restarcie); userowy szablon pod fabryczną
nazwą wygrywa (zero sufiksów). Treści przez i18n (`factory.template.*`, pl+en) - wzór starter
skills.

**Przepisy deep-research (7 kroków):** wymagania (`delegate` + `artifact_*` + `web`) → pytanie
badawcze → `artifact_create typ:"raport"` → podpytania wg pre-question głębokości (szybki 2-3 /
głęboki 4-5) → `delegate` tasks równolegle (`aspect:"researcher"`, `timeout_ms: 300000`;
fallback bez aspect) → synteza z dosłownymi cytatami → dogrywka (max 2 rundy, tylko głęboki) →
status `gotowy`. Wariant „vault" dodaje wikilinki + sekcję „Białe plamy" (czego w vaulcie NIE
MA). Worker jest read-only; raport składa agent główny.

---

## Kluczowe decyzje

- **Skille jako pliki .md** zamiast YAML - bo user pisze treść skilla w naturalnym Markdown, łatwo edytować w Obsidianie. Frontmatter ma metadata.
- **Centralna lokalizacja `.pkm-assistant/skills/`, nie per-agent foldery** - jeden magazyn, przypisanie do agenta przez referencing (`skills:[]` w yamlu), nie fizyczne rozbicie po folderach.
- **`{{placeholders}}` zamiast funkcji szablonowych** - prostota. User pisze `Witaj {{user_name}}, dziś masz {{tasks_count}} taski`. Skill engine podstawia w runtime.
- **DI zamiast bezpośrednich importów u konsumentów** - MCP tools i Modal UI dostają `skillLoader` przez `plugin.agentManager.skillLoader`. Tylko AgentManager bezpośrednio instancjonuje SkillLoader. Jednolite ownership.
- **Skill nie przełącza trybu** - tryby pracy Gadaj/Rób nie istnieją, więc nie ma auto-promocji gadaj→rób ani przywracania trybu po skillu. Skill zwraca prompt + `_requiresPlan`; narzędzia nie zależą od trybu, a o zapis pyta autonomia (approval).

---

## Gotchas

- ⚠️ **Cache klucz to slug, ale `getSkill(skillName)` próbuje najpierw cache.get(skillName)** - działa tylko gdy `skillName === slug`. W innym przypadku fallback przez `Array.from(...).find()`. Niespójność semantyki klucza.
- ⚠️ **`substituteVariables` ma jedno źródło** - `modules/chat/chat/chat_ui.ts` importuje ją z `modules/skills/index.js` (kanon `SkillVariables.ts`). Nie duplikować lokalnie.
- ⚠️ **i18n race condition** w starter skills - `getStarterSkills()` woła `t('starter.skill...')` w runtime. Wymaga zainicjalizowanego locale ZANIM `ensureStarterSkills()` się wywoła.
- ⚠️ **Skan pełny, nie watcher - koszt rośnie z liczbą skilli, nie z rozmiarem vaulta.** Skoro nie ma `watch()` (gotcha wyżej), nie ma co „lagować" w tle. `loadAllSkills()` robi `list('.pkm-assistant/skills/')`, po czym dla KAŻDEGO folderu osobno sprawdza istnienie i czyta `SKILL.md` (`_loadSkillFromFolder`) - zakres na twardo ograniczony do folderu skilli, nie cały vault. Ten pełny skan odpala się tylko w dwóch momentach: raz przy boot pluginu (`AgentManager.initialize`) i raz po KAŻDYM zapisie narzędziem `write`/`vault_write` pod `.pkm-assistant/skills/**` (`chat_streaming.ts` → `agentManager.reloadSkills()`). User z bardzo dużą liczbą skilli poczuje krótkie zamrożenie przy KAŻDYM takim zapisie (skan jest `await`-owany), nie ciągłe obciążenie w tle.
- ⚠️ **Skill bez frontmatter `agent:`** = core skill, dostępny dla wszystkich. (Faktycznie obecne API: każdy skill jest globalny - przypisywanie do agenta dzieje się przez `skills:[]` w yaml agenta, nie przez `agent:` field w skillu.)
- ⚠️ **`{{nested.path}}`** nie obsługiwane (regex `\{\{(\w+)\}\}` matchuje tylko `\w+`). Jak chcesz głębokie path → flatten w args.
- ⚠️ **`parseSkillMarkdown` musi zwracać `preQuestions`** w wynikowym obiekcie - bez tego pre-questions każdego skilla wczytanego z dysku giną, modal pytań przed skillem jest martwy, a placeholdery `{{...}}` zostają niepodstawione.

---

## Powiązane

- `modules/agents/CLAUDE.md` - agenci mają swoje skille (przez `skills:[]` w yamlu)
- `jdhole-skills/` - kuratorska kolekcja JDHole, osobny zasób, nie część pluginu
