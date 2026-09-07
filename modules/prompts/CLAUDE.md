# modules/prompts/

> **TS-4 (2026-07-31):** fizyczne źródła modułu mają rozszerzenie `.ts`. Zapisy `.js` poniżej oznaczają historyczne nazwy albo specyfikatory importów, które zgodnie z konwencją TS-0 celowo pozostają `.js`.

**Budowanie system prompta agenta.** Sekcja „JAK PRACUJĘ" to od E2.4 (D14) **chudy rdzeń** — 9 reguł cross-tool i sądów modelu (CORE_RULES, always-on) + **indeks skilli** + dane dynamiczne. Guidance „kiedy użyć KONKRETNEGO narzędzia" siedzi w opisach narzędzi (i18n `mcp.*.desc`, idą do API), a twarde reguły w kodzie/hookach. **Furtka** `extendedPromptRules` (default OFF) dokłada ROZSZERZONE REGUŁY (EXTENDED_RULES) dla słabszych modeli. Instrukcja per-tool renderuje się TYLKO gdy narzędzie realnie dostępne (`ctx.availableToolNames`). Override per-instrukcja (`decisionTreeInstructions[id]`) + skład **A → B → C → D** bez zmian (★TRYB PRACY usunięty w E2.3 D21).

**Status:** 🚀 **ACTIVE** — przeniesiony w Mapa-10 (2026-04-26).

**Sprint Refaktoru — który mnie dotyka:**
- 🚦 [Sprint 06 Prompt Caching v1 + PROMPTS_AUDIT setup](../../Refaktor/Sprinty/SPRINT_06_Prompt_Caching_v1.md) — Z1 CACHE-PREFIX-1 fix (date z A1 → D, fundament dla wszystkich CACHE-* na 4 platformach) + Z7 PROMPTS_AUDIT_v1 telemetria setup (zbiera dane przez S07-S12)
- [Sprint 13b Polish + Decyzje](../../Refaktor/Sprinty/SPRINT_13b_Polish_Decyzje.md) — PROMPTS_AUDIT_v1 finalne decyzje (A2 snapshot + A3 survey UI + A4 wybór wariantu refaktoru, default Wariant E "Quick win")

---

## Co tu jest (kod)

```
modules/prompts/
├── index.js                    # Public API (4 eksporty — zmierzone 2026-08-27; S30 Z4 wyciął `TOOL_GROUPS`, było 5)
├── CLAUDE.md                   # ten plik
├── PromptBuilder.js            # builder + _buildDecisionTree (chudy rdzeń) + _buildSkillIndex
├── decisionTree.js             # E2.4 (D14) — CORE_RULES/EXTENDED_RULES/DECISION_TREE_* + resolve/split (pure, testowalne)
├── skillIndex.js               # E2.4 (D17) — buildSkillIndex (indeks skilli z budżetem, pure, testowalne)
└── artifactIndex.js            # E2.9 (B3) — indeks typów artefaktów (opis + nagłówki sekcji szablonu) + aktywny artefakt (pure, testowalne)
```

Razem **~950 LOC**. (PROMPTS_AUDIT wywalony 2026-07-28: `PromptTelemetry.js` + `PromptAuditSurveyModal.js` skasowane — patrz update na dole.) `decisionTree.js` + `skillIndex.js` wyniesione jako **pure moduły** (zależność tylko od i18n), bo PromptBuilder przez łańcuch importów wciąga `obsidian` i nie da się go testować node'em — logika rdzenia/indeksu żyje osobno i ma pokrycie (`decisionTree.test.js`, `skillIndex.test.js`).

> ⚠️ **Sprostowanie placeholdera D5:** poprzedni CLAUDE.md mówił że `PlaybookManager.js` (578 LOC) "tematycznie należy do prompts" — **nieprawda**. PlaybookManager został przeniesiony do `modules/onboarding/` w Mapa-8 (2026-04-26) gdzie pasuje konceptualnie (compile playbook + vault_map per agent). Ten moduł to TYLKO PromptBuilder.

---

## Drzewo decyzyjne — chudy rdzeń (E2.4 D14)

**Model po D14:** `_buildDecisionTree` renderuje płasko (nie po grupach):
1. **RDZEŃ** (`CORE_RULES`, 9 reguł, always-on) — reguły cross-tool i sądy modelu: eskalacja,
   delegacja (1 linia), artefakty (todo/hierarchia/istniejący ID), pamięć (`mem_proactive` E2.7
   BEZ ZMIAN + dedup), skille (wskazówka do indeksu), komunikator (`kom_inbox` — reakcja na ping
   skrzynki, S28). Instrukcja z `tool:` renderuje się TYLKO gdy
   narzędzie w `ctx.availableToolNames`; reguła `requiresSkills` — gdy agent ma skille.
2. **INDEKS SKILLI** (`_buildSkillIndex`) — `⚡ nazwa: opis → read("ścieżka SKILL.md")`, manual-only
   osobno, budżet 8000 zn (nadmiar → `…i N kolejnych — list(".pkm-assistant/skills")`).
3. **DANE DYNAMICZNE** — sub-agenty / artefakty w toku / agenci / skrzynka (gatowane dostępnością).
4. **FURTKA** (`extendedPromptRules` ON) — sekcja ROZSZERZONE REGUŁY (`EXTENDED_RULES`, 8 verbose
   „kiedy użyć narzędzia", filtrowane po dostępności). Default OFF = chudo.

**Razem 17 instrukcji** (9 core + 8 extended — zmierzone 2026-08-27 z `CORE_RULES`/`EXTENDED_RULES`
w `decisionTree.ts`; `DECISION_TREE_DEFAULTS` jest ich sumą).

**POMIAR (D14, 2026-07-23, sprzed S28):** ówczesny always-on rdzeń **~1319 zn** (8 reguł, przed
dołożeniem `kom_inbox` w S28) vs stare verbose drzewo **~3726 zn** (~28 instr) —
**~65% mniej** zanim jeszcze zadziała filtr per-tool (dla wąskiego agenta rdzeń tnie się dalej).
Pomiar znakowy nie był powtórzony po S28 — dziewiąta reguła rdzenia dokłada się do tej liczby.

**Grupy** (`DECISION_TREE_GROUPS`, 7 z `skille`) służą teraz **tylko** do grupowania w UI overridów
(`profile_prompt`, pola `label`+`order`) — render ich nie używa. Override per-instrukcja
(`decisionTreeInstructions[id]`: `false`=wyłącz, `string`=podmień tekst) działa dla rdzenia i furtki.
⚠️ **Stare id** (`deleg_mandatory`, `skill_use`, `file_write`, `mem_read`…) częściowo zniknęły/zmieniły
tier — overridy na nieistniejące id przestają matchować (świadome, D14).

---

## Skład promptu — kolejność sekcji

```
A: KIM JESTEM (identity, personality)  — E2.8: archetype + role skasowane; drift out (personality wprost)
   ⚠️ A1 identity NIE ma już DATY (przeniesiona do current_date, CACHE-PREFIX-1 fixed)
B: GDZIE PRACUJĘ (environment, folders, permissions + agent_rules)
C: JAK PRACUJĘ (decision_tree, delegate_guide, rules)  — E2.3: sekcja ★TRYB PRACY usunięta; E2.8: reguła językowa per agent
D: KONTEKST (artifacts, current_date, memory, oczko) — dane, nie reguly
   K9: `artifacts` i `memory` ida przez `addDynamicSection` -> `fenceUntrusted` (ogrodzenie);
   Oczko dokleja `chat_streaming` juz ogrodzone przez `modules/multimodal/active_note.ts`
```

**Filozofia:**
- Opis → Instrukcja (nie mów czym jest, mów co robić)
- 1 info = 1 miejsce (zero duplikacji)
- JSON tools mówią same za siebie (nie powtarzamy opisów narzędzi)
- Wszystko edytowalne: agent override > global override > factory default

---

## Public API (`index.js`) — 4 eksporty (S30 Z4: było 5)

| Eksport | Po co |
|---|---|
| `PromptBuilder` (klasa) | Główny builder — `new PromptBuilder().build(agent, ctx)` |
| `FACTORY_DEFAULTS` | Default texts dla każdej sekcji prompta — fallback override chain |
| `DECISION_TREE_GROUPS` | 7 grup (z `skille`) — E2.4: **tylko** grupowanie w UI overridów (render ich nie używa) |
| `DECISION_TREE_DEFAULTS` | E2.4: `CORE_RULES` (tier core) + `EXTENDED_RULES` (tier extended), re-eksport z `decisionTree.js`. Źródło UI overridów + resolvera. |

> **S30 Z4 — `TOOL_GROUPS` WYCIĘTY z barrela.** Sekcja „Zależności" niżej wskazywała
> `modules/onboarding/PlaybookManager.js` jako konsumenta — **to już nieprawda**: sekcja
> „Narzędzia" playbooka zniknęła razem z kasacją Playbook Buildera w **E2.8 A4**, więc
> `TOOL_GROUPS` od tamtej pory nie miał żadnego wołacza spoza modułu.
> **Fabryka dead-code D7 (2026-09-02, AUD-dead-code-076):** mapa grup już nie żyje NIGDZIE —
> `TOOL_GROUPS` skasowany z `PromptBuilder.ts` w całości. Rozjechał się z żywą
> `BUILTIN_TOOL_GROUPS` (`modules/agents/toolAxis.js`, SSOT osi uprawnień, pilnowany
> `toolAxis.test.js`) i od S30 Z4 nie miał ani jednego czytelnika, nawet wewnątrz modułu.

> **Uwaga:** `CORE_RULES` / `EXTENDED_RULES` żyją w `decisionTree.js` i nie są już re-eksportowane
> z `PromptBuilder.js` (D7: hop bez czytelnika — jedyny konsument, `decisionTree.test.js`, i tak
> importował je wprost z `./decisionTree.js`). Pure helpery `resolveDecisionTreeInstructions` /
> `splitDecisionTreeRules` / `buildSkillIndex` NIE są w barrelu (wewnętrzne, importowane
> bezpośrednio przez PromptBuilder + testy).

---

## Zależności

> ⚠️ **Uwaga o ścieżkach (freshness):** tabela poniżej wskazuje callsite'y **sprzed migracji `src/` → `modules/`** (np. `src/agents/Agent.js` żyje dziś jako `modules/agents/Agent.js`, `src/views/chat/*` jako `modules/chat/chat/*`, `src/views/sidebar/profile/*` w `modules/shell/`). Semantyka zależności aktualna; ścieżki historyczne.

| Co używa modules/prompts | Skąd | Po co |
|---|---|---|
| `src/agents/Agent.js:22` | `PromptBuilder` (klasa) | `getSystemPrompt()` per agent |
| `src/views/sidebar/profile/profile_team.js:5` | `DECISION_TREE_GROUPS` | Settings sidebar — agent customization |
| `src/views/sidebar/profile/profile_prompt.js:5` | `FACTORY_DEFAULTS, DECISION_TREE_GROUPS, DECISION_TREE_DEFAULTS` | Settings sidebar — prompt overrides UI |
| ~~`modules/onboarding/PlaybookManager.js:14`~~ | ~~`TOOL_GROUPS`~~ | ❌ **NIEAKTUALNE** — sekcja „Narzędzia" playbooka skasowana w E2.8 A4; ten import nie istnieje (S30 Z4) |
| ~~`profile_skills.js`~~ | ~~`TOOL_GROUPS`~~ | ❌ **NIEAKTUALNE** — po E2.8 C1 zakładka Uprawnienia stoi na `modules/agents/toolAxis.js` (`BUILTIN_TOOL_GROUPS`), nie na tej mapie |

**Module zależy od:**

| Co | Skąd | Dlaczego |
|---|---|---|
| `getTokenCount` | `core/utils/tokenCounter.js` | Estymata tokenów prompta |
| Agent data | `modules/agents` przez `AgentManager` | E2.8: archetype/role/persona_drift SKASOWANE — nie wstrzykują sekcji prompta. `_buildIdentity` = tylko name+vault; `personality` wprost; `agent.language` steruje regułą językową (`_buildRules`) |
| `t, getDateLocale` | `core/i18n/index.js` | i18n PL/EN dla wszystkich instrukcji + format daty + `t(key, params, forcedLocale)` dla reguły językowej per agent |
| `parseArtifact` | `modules/artifacts` (barrel, node-safe) | `artifactIndex.js` liczy nagłówki sekcji szablonu typu TYM SAMYM parserem, którego patcher używa w `findSection` — własny regex rozjechałby się z silnikiem |

---

## Gotchas (CZYTAJ ZANIM COKOLWIEK ZMIENIASZ)

### ✅ 1. CACHE-PREFIX-1: `_buildIdentity()` nie generuje już daty

Sprint 06 przeniósł datę z A1 identity do końcowej sekcji `current_date` w kontekście. A1 zostaje stabilne byte-for-byte między dniami, więc providerzy prompt cache nie tracą prefiksu przez samą zmianę daty.

Guard test: `modules/prompts/PromptBuilder.cache.test.js` pilnuje, żeby `new Date()` nie wróciło do `_buildIdentity()`.

### 🟠 2. Kolejność A→B→C→D nie jest dowolna

Sekcje muszą iść w tej kolejności — identity (A) i środowisko/uprawnienia (B) definiują kontekst zanim drzewo decyzyjne (C) opisze „kiedy". (E2.3 D21: dawna sekcja ★TRYB PRACY między B a C usunięta wraz z trybami Gadaj/Rób — `buildModePromptSection`/`_getModeBehaviors` skasowane, `context.workMode` już nie wpływa na build.)

### ✅ 3. `requiredGroups` w `DECISION_TREE_GROUPS` był martwym metadanem (E2.4) — SKASOWANY w D7

Po D14 render (`_buildDecisionTree`) NIE używał `requiredGroups` — gatuje po `ctx.availableToolNames`
(dostępność narzędzia) i `ctx.skills` (skille). Pole zostawało tylko jako komentarz-nagrobek;
fabryka dead-code D7 (2026-09-02, AUD-dead-code-076/139/242) skasowała je z każdej z 7 pozycji
`DECISION_TREE_GROUPS` — grupy niosą dziś TYLKO `label`+`order` (UI overridów w `profile_prompt`).
Ta sama fabryka zdjęła trzeci parametr `enabledGroups` z `_buildRules` (jedyny wołacz podawał
dwa argumenty od E2.8 C1 — parametr był kikutem po skasowanym `_getEnabledGroups`).
Ładowanie brain do prompta zależy od `agent.permissions.memory` (AgentManager `injectMemory` +
gatowanie reguł pamięci przez dostępność `memory_save`), NIE od grup drzewa.

### 🔴 4. KAŻDA niezaufana treść wchodzi do promptu przez `fenceUntrusted` (K9, 2026-08-22)

Ogrodzenie to **jedna funkcja**: `fenceUntrusted(content, source)` z `core/security/promptFence.ts`
(w barrelu `core/index.js`). Zwraca `<vault_content source="…">…</vault_content>` i **escapuje**
`<vault_content` / `</vault_content` z wnętrza treści (`&lt;…`), więc ogrodzenia nie da się zamknąć
od środka. Nie sklejaj znacznika ręcznie, nie rób drugiego mechanizmu.

Miejsca, które dziś przez nie przechodzą:

| Kanał | Gdzie | `source` |
|---|---|---|
| Pamięć agenta (`brain.md` + indeks `brain/`) | `PromptBuilder.addDynamicSection` ← `Agent.getSystemPrompt` | `memory` |
| Indeks artefaktów + aktywny artefakt | `PromptBuilder._addArtifactContext` (blok D) | `artifacts` |
| Oczko — aktywna notatka (nazwa, frontmatter, body) | `modules/multimodal/active_note.ts` (producent) | `active_note` |
| Podsumowanie rozmowy (rolling summary) | `RollingWindow.systemPrompt` (getter) | `conversation_summary` |

> ⚠️ **M (AUD-security-118): czwarty kanał dołożony po fakcie.** `Summarizer` streszcza CAŁĄ
> rozmowę razem z wiadomościami `role:'tool'` (wyniki `read`/`web_read`), a wynik stoi potem
> w `role:'system'` **do końca sesji** i wraca na wejście kolejnych sumaryzacji — czyli utrwala
> się. Do fali M szedł tam gołym stringiem, bez znacznika, o którym `prompt.content_security`
> mówi modelowi „to są DANE". Nagłówek sekcji (`memory.soft_summary_header` /
> `memory.emergency_context_header`) zostaje NA ZEWNĄTRZ ogrodzenia, jak
> „## Długoterminowa pamięć" przy pamięci.

**Co NIE jest niezaufane** (i celowo zostaje regułą, nie danymi): `agent.agentRules` z yamla agenta
w `.pkm-assistant/agents/` oraz opisy folderów z mapy vaulta (`.pkm-assistant/agents/vault_map.md`)
— oba pisze operator, a `.pkm-assistant/**` jest poza zasięgiem narzędzi agenta.

Modelowi mówi o ogrodzeniu **jedno** zdanie w sekcji `content_security` (`prompt.content_security`,
pl+en) — nie dubluj preambuły „to są dane" przy każdym bloku.

> ⚠️ Ogrodzenie idzie w **część dynamiczną** promptu (blok D). Nie wciągaj go do bloków A–C —
> zepsułoby stabilny prefiks cache. Dlatego indeks artefaktów wyjechał z `decision_tree`
> (AUD-security-060): niósł surowy `status`/`typ` z frontmattera notatek vaulta w sekcji REGUŁ.

### 🟡 5. Teksty instrukcji drzewa są INLINE PL (nie i18n) — gotcha aspiracyjna

`CORE_RULES` / `EXTENDED_RULES` (`decisionTree.js`) mają `text` jako twarde polskie stringi — drzewo
to polski korpus promptu, `def.text` NIE przechodzi przez `t()`. Przez i18n idą tylko **etykiety
strukturalne**: `dt.group.*`, `prompt.dt.*` (nagłówki, indeks skilli: `prompt.dt.your_skills`/
`skill_recipe`/`skill_index_more`/`manual_skills`, furtka: `prompt.dt.extended_header`) oraz opisy
narzędzi `mcp.*.desc`. Dodając regułę do rdzenia/furtki — pisz `text` po polsku inline; i18n dotyka
tylko nagłówków. **Guidance „kiedy użyć narzędzia" pisz w `mcp.<tool>.desc` (pl+en), nie w drzewie.**

---

## TODO

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md) — pełna lista z sesji Mapa-10.

- ✅ **PREFIX-1 ZAMKNIĘTY (Sprint 06).** Data w A1 identity psuła cache prefix — przeniesiona do
  osobnej sekcji `current_date` w kontekście (blok D). Szczegóły i guard test: Gotcha ✅ 1 wyżej
  („CACHE-PREFIX-1: `_buildIdentity()` nie generuje już daty"). Nie jest to już otwarte zadanie.

---

## Co nadchodzi (Sprint 1 + Sprint 2)

**Sprint 1 (Memory v2 + Retrieval v2):**
- 4 role rdzeniowe sub-agentów (historycznie prep-archivist, prep-whitelist, strateg-planer, strateg-sumarizer; Removed 2026-05-16 cleanup: prep-archivist -> prep-memory) potrzebują **własnych prompt templates** per role — extension PromptBuilder
- Prompt Caching v1 Faza 2: refaktor `_buildIdentity` żeby wyciągnąć `date` z prefix

**Sprint 2 (Persona drift):**
- Persona drift wymaga sekcji core+drift w prompt (rozbudowa A4 personality)
- Drift entries lazy load — może być cachowane jako separate prefix (advanced cache strategy)

---

## Historia

- **Sesja 44-45** — Decision Tree v2 + Prompt System v2.1 (PromptBuilder rewrite)
- **Sesja 91** — `activeTodoId` w PromptBuilder
- **Sesja 120-121** — Refaktor dispatcher (4 tryby → 2: Gadaj / Rób), SwitchModeTool usunięty
- **Sesja 128 D5** (2026-04-25) — placeholder rozbudowany do wzorca (z błędem: PlaybookManager mylnie wymieniony jako część prompts — w rzeczywistości należy do onboarding, naprawione w Mapa-10)
- **Sesja Mapa-10** (2026-04-26) — przenosiny `src/core/PromptBuilder.js` → `modules/prompts/`. `index.js` z 6 eksportami. 7 importerów na barrel (6 src/* + modules/onboarding/PlaybookManager.js — REVERSE DEP naprawiony tym samym ruchem). Build 8.0MB + 58/58 PASS. **Krytyczne odkrycie sesji: CACHE-PREFIX-1** (date w A1 identity psuje cache prefix wszystkich providerów auto-cachingu — bug zidentyfikowany jako KONKRETNY przypadek B1 z Wizji PROMPT_CACHING_v1, naprawa w Sprint 1).
- **E1.6 docs-freshness** (2026-07-21) — dopisane realnie istniejące pliki `PromptTelemetry.js` + `PromptAuditSurveyModal.js` (PROMPTS_AUDIT z S06/S13b, wcześniej nieudokumentowane); 6 → 7 eksportów; instrukcje 25 → 27 (zweryfikowane w `DECISION_TREE_DEFAULTS`); LOC ~918 → ~1,090; caveat o ścieżkach `src/` w Zależnościach. E1.6 nie zmieniało kodu tego modułu.
- **E2.7 W1 (K2)** (2026-07-22) — nowa instrukcja `mem_proactive` w grupie `pamiec` (27 → 28): model pod koniec tury sam decyduje o `memory_save` wg bramki istotności (wzór OpenClaw, decyzja D3). Tekst instrukcji inline PL — jak pozostałe 27 (drzewo decyzyjne to polski korpus promptu, `def.text` nie przechodzi przez `t()`; gotcha #4 o i18n jest aspiracyjna, nie odzwierciedla stanu kodu). Wyłączalna per agent przez istniejący mechanizm override (`agentVal === false`). Zero zmian w pętli — model woła istniejące `memory_save` (create-only + kolejka K1 chronią przed wyścigiem/nadpisaniem).
- **E2.4 K3 (D17)** (2026-07-23) — grupa `skille` + instrukcje `skill_use`/`skill_known` usunięte z drzewa; **indeks skilli** (`_buildSkillIndex` → pure `skillIndex.js`) renderuje się osobno: `⚡ nazwa: opis → read("ścieżka")`, manual-only osobno, budżet 8000 zn. `_buildBaseContext` niesie `icon`/`disableModelInvocation`/`path`/`slug` (naprawiony hiddenSkills + brak ikony). `TOOL_GROUPS.skills` skasowane. Nowy test `skillIndex.test.js`.
- **E2.4 K4 (D14)** (2026-07-23) — **chudy rdzeń.** `DECISION_TREE_DEFAULTS` = `CORE_RULES` (8, tier core) + `EXTENDED_RULES` (12, tier extended), wyniesione do pure `decisionTree.js` (+ `resolveDecisionTreeInstructions`/`splitDecisionTreeRules`, test `decisionTree.test.js`). `_buildDecisionTree` renderuje płasko, gatuje po `ctx.availableToolNames` (nowe pole z `AgentManager.filterByAgent`) i `ctx.skills`; `_isToolEnabled` usunięty. Furtka `extendedPromptRules` (default OFF) → sekcja ROZSZERZONE REGUŁY. `covering`/`dt_covered_groups` (delegat pokrywa grupę DT) już nie renderowane (grupy poza renderem). POMIAR: always-on ~3726 → ~1319 zn (-65%) przed filtrem per-tool. Guidance „kiedy użyć" żyje w `mcp.*.desc`.

## E2.8 update (2026-07-23) — agenci v3: rola OUT z promptu, język per agent
- **Archetyp i rola NIE wstrzykują już sekcji prompta (A1/A3).** `_buildRoleBehavior` (sekcja `## Rola`) skasowany; `build()` nie dokłada bloków archetype/role. `_buildIdentity` = tylko `name` + `vault` (żadnego archetype-flavour). Blok A to teraz **identity + personality** (jeśli ustawiona). Rola Jaskra (behavior mentora) wtopiona w jego `personality` (HumanVibe.js).
- **personaDrift OUT (A4).** `getEffectivePersonality`/drift skasowane w `Agent.js` — `PromptBuilder` czyta `agent.personality` **wprost** (dawniej przez drift-merge). YAML z `persona_drift:` ignorowany.
- **Reguła językowa per agent (A6/S9, reguła #1 w `rules`).** `_buildRules` czyta `agent.language`: `'auto'` → globalny locale (jak dotąd, `t('prompt.rule.language')`), `'pl'`/`'en'` → wymuszona treść reguły przez `t('prompt.rule.language', undefined, lang)` (i18n z parametrem locale). Reguła językowa nadal pierwsza w `FACTORY_DEFAULTS.rules`.
- **`mem_proactive` rozszerzone o ulotne „Na teraz" (D2).** Instrukcja rdzenia `mem_proactive` (grupa `pamiec`, `decisionTree.js`) obok trwałego `memory_save` opisuje teraz ULOTNY stan: `memory_save({ephemeral:true, section:"user"|"environment", content, remove?})` dopisuje/czyści bullet w sekcji „Na teraz" brain.md (nie tworzy notatki). Tekst inline PL (jak reszta drzewa). Wyłączalne per agent istniejącym override.
- **Playbook pointer OUT (A4).** `_buildPlaybookPointer` (zwracał null po kasacji Playbook Buildera) usunięty z `build()` — zero wołaczy w PromptBuilder. `PlaybookManager` odchudzony (compile playbook/generateRolaSection OUT; `compileVaultMap`/`ensureStarterFiles` zostają — patrz modules/onboarding). `TOOL_GROUPS` bez zmian względem E2.4 (nadal bez `skills`).

## E2.9 FAZA D update (2026-07-23) — TOOL_GROUPS + reguły artefaktów
- **`TOOL_GROUPS.artifacts` = `artifact_create/read/update/list/todo`** (było `chat_todo/idea_review/plan_review`). `_injectGroupDynamics('artefakty')` już od B3 czyta indeks TYPÓW + aktywny artefakt (`artifactIndex.js`), nie `_planStore`. Reguły rdzenia `art_todo_default` (tool `todo`) + `art_hierarchy`/`art_existing` (tool `artifact_create`/`artifact_update`) renderują się teraz realnie (narzędzia zarejestrowane). Martwy `@param context.artifacts` usunięty z docstringu `build()`.

## v2.2 update (2026-07-28) — PROMPTS_AUDIT wywałka (ankieta + telemetria)
- **`PromptAuditSurveyModal.js` SKASOWANY** — jednorazowa ankieta z S13b nie ma już czego badać:
  audyt promptów zamknięty (S13b Wariant E), chudy rdzeń wdrożony w E2.4 D14. Z `main.js` wycięte
  `_maybeShowPromptAuditSurvey()` + import. Pola `promptAuditSurveyShown`/`promptAuditSurveyShownAt`
  w ustawieniach userów zostają jako nieszkodliwe sieroty (bez migracji).
- **`PromptTelemetry.js` SKASOWANY razem z ankietą** — technicznie się wykonywał (append JSONL do
  `.pkm-assistant/audit/prompts_telemetry.jsonl` przy każdym buildzie prompta), ale był martwy celowo:
  jedynym konsumentem miała być analiza A2 w S13b, a ta poszła fallbackiem (Wariant E) właśnie przez
  brak danych. Zero czytelników JSONL-a w kodzie + koszt I/O (pełny read+write pliku per instrukcja
  rdzenia). Wycięte: `_getTelemetry` z PromptBuildera, toggle w `core/SettingsContent.js`, klucze i18n
  `settings.prompt_audit_telemetry*` (pl+en), default `promptAuditTelemetryEnabled` z
  `config/default_settings.js`, pole ctx w `AgentManager._buildBaseContext`, klucze w harness fixture.
  `cacheTelemetryEnabled` (telemetria cache promptów) to OSOBNY mechanizm — żyje dalej.
- Barrel z 6 → **5 eksportów**. Historyczne artefakty audytu (`releases/v2.0/prompts_audit_snapshot.md`,
  wpisy w Refaktor/ i DEVLOG) zostają jako archiwum.

## S28 update (2026-07-29) — poczta w prompcie: jedna linijka pingu

- **Ping skrzynki ścięty z 3 linijek do JEDNEJ (D4).** `_injectInboxNotification` czyta
  `ctx.inboxPing` (`{count, senders}` z `AgentManager.getInboxPing`) i renderuje
  `prompt.dt.inbox_ping` — ile nieprzeczytanych i od kogo. **Zero treści, zero ścieżki do
  pliku skrzynki, zero „przeczytaj to teraz"** — agent sam decyduje, kiedy zajrzeć.
  `count === 0` → żadnej linijki. Klucze `prompt.dt.inbox_unread`/`inbox_read_cmd`/
  `inbox_inform` oraz sekcja `agent.section.inbox`/`agent.inbox_prompt` — skasowane.
- **Drzewo:** rdzeń dostał `kom_inbox` (reakcja na ping: `kom_list` → `kom_read` tylko dla
  istotnych, poczty nie kasujesz), furtka `EXTENDED_RULES` dostała `kom_send`. Guidance
  „kiedy wysłać pocztę vs zdelegować rozmowę" siedzi w `mcp.kom_send.desc` (D14), nie w drzewie.
  Wpisy projektowe (`kom_project_*`) i `comms_message` (`agent_message`) — OUT.
- **`TOOL_GROUPS`:** `communication` = `['agent_delegate']`, `komunikator` =
  `['kom_send','kom_list','kom_read']`. Blok dynamiczny „agenci + skrzynka" gatuje się teraz
  na `kom_send` albo `agent_delegate`.
- **`projectContext` OUT** z docstringu `build()` i z renderu (Project Hub skasowany, D1).
