# PKM Assistant

**Co to jest:** plugin do Obsidian. Agenci AI wewnątrz Twojego vaulta z hierarchiczną pamięcią, skillami i narzędziami (MCP). GPL-3.0.

**Dla kogo:** osoby chcące własnego asystenta AI w Obsidianie — lokalnego (Ollama), chmurowego (OpenAI/Anthropic/xAI) lub mieszanego. User nie-programista zarządza agentami przez UI, nie kod.

**Wersja:** 2.1.0 (stable, tag `v2.1.0`, 2026-07-21). W toku: v2.2 — Etap 3 + sprinty S26-S29. Refaktor v2.0 zamknięty: 16 sprintów wykonawczych (S01-S13c + Sprint M3) + 5/5 smoke v2 GREEN + 14 findings post-smoke closed. Faza 3 (Nauka) odblokowana.

> ✅ **Memory v3 stable (Sprint M3, 2026-05-15)** — Smoke Test 01 ujawnił 4 objawy FIND-01 w Memory v2 (broken-by-design), więc Sprint M3 zrobił redesign PRZED stable release. Memory v3: `brain.md` krótki index + `brain/` trwałe notatki + `sessions/active` live + `sessions/archive` archiwum + create-only `memory_save` + LLM-driven konsolidacja (analogiczna do `save_session`). Smoke 01 retake (2026-05-15) — 4 objawy RESOLVED. Pełny kontekst: `Refaktor/Decyzje_Sesji/2026-05-14_smoke_01_finding_01.md`, `Refaktor/Sprinty/SPRINT_M3_Memory_v3.md`, `Refaktor/Decyzje_Sesji/2026-05-15_memory_v3_save_session_archive_rewrite.md`.
> 🚧 **REFAKTOR v2.1 „Prawda i Bezpieczeństwo" — AKTYWNY (od 2026-07-21).** Nauka zakończona (14 lekcji + synteza). **Centrum dowodzenia: [`Nauka/PLAN_REFAKTORU_v2.1.html`](Nauka/PLAN_REFAKTORU_v2.1.html)** — żywy dokument z decyzjami (23+), frontami i checkboxami postępu; **każda sesja zaczyna od przeczytania go** (sekcje: Dashboard, Fronty, Plan) i ODZNACZA postęp edytując plik (atrybut `checked` + wpis w Changelogu) + commit na main. Konstytucją pozostaje `Refaktor/RAPORT_Review_Fable_2026-07-07.md` (zmiany tylko ANEKSEM). **Tryb pracy „dwa tory"** (decyzja F1): tor 1 = implementacja Etapu 1 (zadania E1.1→E1.8 z planu, sekwencyjnie; robota na branchach `refactor/v2.1-*`, NIGDY na main); tor 2 = równoległe przegadywanie z Kubą frontów F4-F12 (planowanie Etapu 2). Rozstrzygnięte: F1 (v2.1=Etap 1, v2.2 natychmiast po checkpoincie), F2 (semantyka Z INDEKSEREM w E1.4 — rdzeń pluginu; aneks A1 odrzucony), F3 (R0 = minimalne domknięcie WIP wg checklisty 7a). ⚠️ Na main wisi niezacommitowany WIP Memory (+804/−621) — jego domknięcie to E1.1, nie ruszać go poza tym zadaniem. Żelazne zasady bez zmian: Kuba nie dotyka terminala (komendy robisz sam); research subagentami (sonnet/opus — oszczędzaj tokeny); testy pass przed commitem; tłumacz po polsku, prosto, metaforami — Kuba podejmuje decyzje, Ty pilnujesz żeby rozumiał co klepie.
> **Update 2026-07-29 (health check):** Etap 1 zamknięty (v2.1.0), Etap 2 9/9 DONE, trwa Etap 3 (v2.2); fronty F1-F12 rozstrzygnięte 12/12; WIP Memory domknięty w E1.1 (ostrzeżenie wyżej nieaktualne). Konwencja branchy: `refactor/v2.2-*` → merge `--no-ff` na main.
> 📋 **Backlog health checku 2026-07-29:** [`Refaktor/Decyzje_Sesji/2026-07-29_health_check_backlog.md`](Refaktor/Decyzje_Sesji/2026-07-29_health_check_backlog.md) — kubełki 0-5 (otwarte P1 w kodzie: utrata transkryptu przy pliku mieszanym, snapshot S29, duplikaty L1, zaginiony fix smoke-04 `deleteSkill`) z instrukcjami wykonania per zadanie. Sesje robocze biorą stamtąd zadania i odhaczają. Pełny raport obok: `2026-07-29_health_check_raport.html`.
> **Update 2026-09-04 (droga do katalogu, fala 2):** fala 2 release-packu scalona na `refactor/v2.2-release-2.2.0` (3023 testów, bundle 2 152 954 B, lint:obsidian 11 950→11 722 ostrzeżeń); decyzje Kuby D1 (updater z GitHuba WYCIĘTY), D5 (miesiąc testów = GO) i D6 (`minAppVersion` = 1.11.0) rozstrzygnięte. **Inicjatywa „clean-room" blokuje tag/release/zgłoszenie do katalogu** — powód licencyjny: w repo nie może zostać ani jeden ślad starego frameworka bazowego (kod, nazwy plików i symboli, komentarze, dokumentacja). **Stan: ZAKOŃCZONA (2026-09-06)** — przepisanie metodą clean-room wg specyfikacji [`Refaktor/Decyzje_Sesji/2026-09-05_clean_room_F1_architektura.md`](Refaktor/Decyzje_Sesji/2026-09-05_clean_room_F1_architektura.md) jest domknięte; bramkę „grep zero" nadal pilnuje test `core/clean_room_guard.test.ts` (jedyny dozwolony wyjątek: migrator starych ustawień `core/runtime/legacySettingsMigration.ts` + jego fixture'y).
> 🏁 **Update 2026-09-06 (nowe repo, release 2.2.0, nowy model pracy):** to repozytorium (`JDHole/pkm-assistant`) zaczyna się od jednego czystego commita z 2026-09-06 (kod clean-room, bez historii forka) i od tej chwili jest **jedynym** repo projektu; release **2.2.0** (tag `2.2.0`, pięć assetów) poszedł stąd. Dawne repo z pełną historią jest prywatnym, zarchiwizowanym (read-only) `JDHole/PKM-Assistant-archive` — **nie bierzemy go pod uwagę w pracy**. **Decyzja Kuby: repo to działający kod, plany i archiwa żyją w jego vaulcie.** Foldery `Refaktor/`, `Nauka/` (w tym plan `PLAN_REFAKTORU_v2.1.html`), `audyt/` i notatki `releases/v2.0` **nie są w tym repo** — leżą w vaulcie właściciela, w folderze projektu (README opisuje zawartość). **Każde odwołanie do `Refaktor/...`, `Nauka/...`, `audyt/...` niżej w tym pliku i w `CLAUDE.md` modułów czytaj jako ścieżkę w tym folderze vaulta** (linki względne w repo nie zadziałają — to zapis historyczny, celowo niepodmieniany). Raporty sesji i plany pisze się od teraz do vaulta, nie do repo; w repo zostają kod, testy, `CLAUDE.md` per moduł, `CHANGELOG.md`, `releases/<wersja>.md` i `RELEASE_PROCESS.md`. **Od 2026-09-07 harness „Szklane Pudło" też jest poza tym repo** — ma własne, publiczne https://github.com/JDHole/pkm-assistant-harness (walidator katalogu lintuje CAŁE repo pluginu, a narzędzie testowe nie jest jego częścią); w pluginie została po nim `test-support/`, bez której `npm test` nie wstaje.

**Branże (model v2.2, stan 2026-07-30):**

- **`main`** — jedyny długożyjący branch. Tu żyje stable. Bezpośrednie commity **TYLKO drobne docs** (odznaczenie postępu w planie, literówka w CLAUDE.md). Kod — nigdy.
- **`refactor/v2.2-<nazwa>`** — branch roboczy per zadanie/sprint, odbijany od `main`. Bramki przed merge: **`npm test` → `npm run typecheck` → `npm run lint` → `npm run lint:obsidian` → `npm run build`** plus bramka harnessu z osobnego repo (https://github.com/JDHole/pkm-assistant-harness: `npm run selftest` + `npm run scenarios`). Wszystko zielone → merge `--no-ff` do `main`.
- **Kotwice historyczne ery v2.0** (`refactor/v2.0`, `refactor/modules-foundation`, `refactor/sprint-*` na origin) — zostają jako znaczniki historii. **Nie odbijamy od nich i nie mergujemy do nich.**

> **Historia (era v2.0):** do release'u v2.0.0 (2026-05-17) obowiązywał model trzypoziomowy — `main` (tylko PR na release) ← `refactor/v2.0` (główny working branch) ← `refactor/sprint-NN-*` (branch per sprint, 15 branchy po splicie S13 na 13a/b/c). Model spłaszczony po v2.1.0: `refactor/v2.0` przestał być potrzebny, bo sprinty wpadają wprost na `main`. Szczegóły w git history tych branchy.

**Rozmiar:** ~67,8k LOC źródeł (`core/` + `modules/` + `src/` + `config/` + `utils/`, bez testów), **3023 testów (stan 2026-09-04, po fali 2 release-packu), bundle **2,15 MB (2 152 954 B, po fali 2, 2026-09-04)** (E1.7 tiktoken RIP: 8,35→3,0 MB, dalsze chudnięcie w Etapie 2-3). Uwaga: stary framework bazowy/Connections/Agora/plan_action/roles legacy wycięte (~14k LOC), ale Memory v2, MCP, Komunikator, Settings v2, Skiny i Token Viewer dodały nową warstwę v2.
**Lokalizacja lokalna:** klon repo na maszynie właściciela (folder `PKM Assistant`; dawna lokalizacja `Obsek Plugin` nieaktualna).

---

## Priorytety pracy (w tej kolejności)

1. **`ma mi kurwa działać`** — zero regresji akceptowalne. Coś się psuje → STOP, naprawa, potem dalej. Plugin jest w produkcji (v1.2.1), user używa go codziennie.
2. **Git hygiene** — commity po każdej sensownej zmianie, `testy pass` przed commitem, porządek na GitHub żeby ktoś mógł wejść z ulicy i dojść co się dzieje.
3. **Edukacja JDHole** — prawdziwy produkt tej trylogii. Każdy moduł = lekcja. Jak JDHole nie rozumie zmiany → nie wchodzi. Jak rozumie → zostaje mu to na zawsze.

**Nowe feature'y ZAKAZANE** dopóki refaktor nie skończony. Stare = tylko doprowadzenie do porządku.

---

## Gdzie jesteśmy w drodze

**Trylogia projektu:** Mapa (FAZA 1, ZAMKNIĘTA 2026-04-26) → **Refaktor (FAZA 2, Memory v3 domyka blocker release)** → Nauka (FAZA 3, odblokowana ale wciąż czeka).

### Faza 1 — Mapa (zamknięta) ✅
16 sesji Mapa (Mapa-1 do Mapa-16) zmigrowały 17 z 18 modułów do `modules/<nazwa>/` + zebrały **264 znaleziska** + spisały **13 Wizji** przekrojowych. Wszystko w branchu `refactor/modules-foundation` (~53 commitów).

### Faza 2 — Refaktor ✅ ZAMKNIĘTA (2026-05-17, v2.0.0 stable)
**13 sprintów S01-S13** (S13 rozbity na 13a/13b/13c od 2026-05-07 = **15 branchy wykonawczych**) + **Sprint M3 Memory v3** (reopen 2026-05-14 po Smoke 01 FIND-01) = **16 tasków wykonawczych**. v2.0.0-rc.1 wypchnięty 2026-05-09 → smoke v2 (5/5 GREEN, 14 findings closed) → v2.0.0 stable 2026-05-17. Plan w pluginie: **`Refaktor/`** folder. Lekcje: `Refaktor/Materialy_poboczne/Lessons_z_Refaktoru.md` (16 lekcji w 4 sekcjach).

**Master plan:** [`Refaktor/00_Wielki_Plan_Refaktoru.md`](Refaktor/00_Wielki_Plan_Refaktoru.md)
**Matryca 264 znalezisk × 13 sprintów:** [`Refaktor/01_Surowizna_TODO_Wizje.md`](Refaktor/01_Surowizna_TODO_Wizje.md)
**Sprint Notki:** [`Refaktor/Sprinty/SPRINT_NN_*.md`](Refaktor/Sprinty/) — każda self-contained dla agent-agnostic
**Decyzje sesyjne:** [`Refaktor/Decyzje_Sesji/`](Refaktor/Decyzje_Sesji/) (założenia + audyt 2026-04-27 + per-sprint placeholders)

**Sekwencja sprintów (po reorderze + audycie 2026-04-27):**

```
S01 Quick Wins + Security ✅     → S02 Embedding Reset + legacy bazowy ✅
S02 → S03 Memory v2 GIGANT ✅    (blocks S04, S05, S11)
S03 → S04 MCP_PORZADEK_v1 ✅     → S05 Sub-agents v2 + Inline Triggers ✅
                                   (S05.5 hotfix 2026-04-29: Z8 popup `/`/`@` + Z9 sidebar tab Triggery + Z12 modal accept + dokumentacja sync)
S05 → S06 Prompt Caching v1      → S07 Archetypes & Roles v2
S07 → S08 Komunikator + Agora wywałka 🚦 STOP & REVIEW przed Z7
S04 → S09 Artefakty v2           → S10 Settings v2 + Backstage v2
S10 → S12 Skiny pluginu          → S13a Security + Architecture moves
S13a → S13b Polish hurtowy + Decyzje (Connections + PROMPTS_AUDIT)
S13b → S13c Release prep ✅ (technical artifacts done)
S03 → S11 Token Context Viewer ✅
S13c → Memory v3 (architectural redesign) ✅ → smoke 01-05 (5/5 GREEN) ✅ → release v2.0.0 ✅ 2026-05-17 🎉
```

> **Note 2026-05-07:** Sprint 13 oryginalnie monolityczny rozbity na 3 fazy. Powód: 4 niezwiązane grupy (security, decyzje strategiczne, ~80 polish drobnic, release prep) + release na `main` osobno = mniejsze ryzyko błędu. Stary plan: `Refaktor/Materialy_poboczne/SPRINT_13_Polish_v2_Release_OLD.md`.

### Faza 3 — Nauka ✅ ZAMKNIĘTA (2026-07-20)
Edukacja JDHole moduł po module: **14 lekcji + synteza** (2026-07-07 → 2026-07-20), z raportem `Refaktor/RAPORT_Review_Fable_2026-07-07.md` jako konstytucją. Deliverable syntezy: **`Nauka/PLAN_REFAKTORU_v2.1.html`** — od tego momentu centrum dowodzenia projektu. Materiał lekcji: `Nauka/Notatki/LEKCJA_*.md` + `Nauka/PLAN_LEKCJI.md`.

**Po Refaktorze zrealizowane:** Orama w S02 / S03; pełna kampania TypeScript domknięta w TS-5 (2026-07-31).

---

## REGUŁA GŁÓWNA — jak ten projekt jest zorganizowany

**Każdy moduł to fizyczny folder** w `modules/<nazwa>/` z:
- `index.ts` — **jedyne drzwi publiczne**, plik fizyczny (specifiery importu w kodzie zostają `.js` — kontrakt TS-0 — i trafiają w ten sam plik); eksportuje to, co moduł udostępnia reszcie
- `CLAUDE.md` — dokumentacja modułu: co robi, jak, gotchas
- Reszta plików — bebechy, prywatne

**ZŁOTA ZASADA:** poza modułem wolno importować TYLKO z `modules/<nazwa>/index.js`. **Nigdy** z bebechów. Wewnątrz modułu pliki importują się swobodnie.

**Złota zasada obejmuje też `core/`** — jego drzwiami jest `core/index.ts`. Oficjalne wyjątki (wolno deep-importować wszędzie): `core/i18n/index.ts` i `core/utils/Logger.ts` — globalne narzędzia z ~230 importerami razem. Drugi wyjątek jest jednoosobowy: `src/main.ts` jako **composition root** deep-importuje obsidianowe pliki core (`PluginBase.ts`, `runtime/PluginRuntime.ts`, `runtime/settingsArmor.ts`, `utils/obsidianNav.ts`, `security/MasterPasswordModal.ts`) — nie mogą wejść do barrela, bo `core/index.ts` musi wstawać w gołym Node (testy AVA nie mają mocka `obsidian`). Specifiery w kodzie nadal celowo kończą się na `.js` zgodnie z kontraktem TS-0.

> **Od S31 (2026-07-30) egzekwuje to ESLint**, nie „konwencja + review": `no-restricted-imports` w `eslint.config.js` obejmuje `modules/**`, `src/**`, `config/**`, `utils/**` oraz `test-support/**` (testy pominięte), a `npm run lint` przechodzi po wszystkich pięciu drzewach. Deep-import = błąd lintu, nie uwaga na review. Harness (pierwszy konsument pluginu „z zewnątrz") mieszkał tu do 2026-09-07 — dziś jest osobnym repo (https://github.com/JDHole/pkm-assistant-harness) i pilnuje tej samej zasady u siebie; w pluginie została po nim `test-support/` (atrapa `obsidian` + shim DOM + preload AVA), objęta i `lint`, i `lint:obsidian`.

**Dlaczego:** (a) Claude Code pracuje w kontekście JEDNEGO folderu → oszczędność tokenów, (b) JDHole uczy się moduł po module, nie całości na raz, (c) zmiany w bebechach nie wywalają pluginu.

---

## Mapa modułów (18 + core)

**Stan po Mapie (zamknięta 2026-04-26) i sprintach v2:** **cały kod modułowy siedzi w `modules/<nazwa>/`.** Historia domknięcia:
- `modules/embedding/` — kod przeniesiony z `src/embeddings/` (reset w **Sprincie 02**, dokończony w S31)
- `src/components/`, `src/utils/`, `src/embeddings/` ✅ **już nie istnieją** — wchłonięte do `modules/` (components → `modules/ui-components/` w S10 Z12; utils + embeddings → `core/` i `modules/embedding/` w S31). `src/core/AgoraManager.js` ✅ wywalone w **Sprint 08 Z7** (2026-04-30). `src/core/WebSearchProvider.js` → `modules/web/` w **S13a Z5**.

> **Stan `src/` na dziś (2026-09-03):** dwa pliki — `src/main.ts` (composition root), `src/styles.css`. Nic więcej tam nie mieszka. (`src/core/VaultZones.ts` wycięty 2026-09-03 — martwy podsystem stref, zero konsumentów; AUD-dead-code-031/115/172/216.)

**Plan wykonania: 13 sprintów Refaktoru** (S13 rozbity na 3 fazy = 15 branchy). Każdy moduł jest dotykany w 1+ sprincie — szczegóły w [`Refaktor/01_Surowizna_TODO_Wizje.md`](Refaktor/01_Surowizna_TODO_Wizje.md) (matryca 264 znalezisk × 13 sprintów, S13 split per fase).

| # | Moduł | LOC | Rola | Status | Migracja kodu |
|---|-------|-----|------|--------|---------------|
| - | `core/` | ~10,000 | Fundament: `PluginBase`, runtime (`runtime/PluginRuntime` + `SettingsStore` + `NoticeCenter` + `StatusBar`), transport HTTP (`core/http/`), security, i18n, utils | 🚀 ACTIVE | ✅ Dzień 2 |
| 1 | `modules/memory/` | ~5,600 | Pamięć agenta Memory v3: brain.md index, brain/ notes, sessions active/archive, summaries L1-L3 | ✅ **Memory v3 stable path** (Sprint M3 2026-05-15) — FIND-01 rozwiązany architektonicznie: brain.md niedestrukcyjny, memory_save create-only, konsolidacja user-reviewed, strict cross-agent isolation | ✅ Dzień 3 PILOT + S03 + Sprint M3 Memory v3 |
| 2 | `modules/embedding/` | ~1,800 | Wektoryzacja Orama: `EmbeddingModel` + `EmbeddingRegistry` + `providers/` (OpenAI/Ollama/Gemini/LM Studio) + `VaultIndexer` | 🚀 ACTIVE | ✅ S02 (2026-04-27) reset + Orama; ✅ E1.4 (2026-07-21) VaultIndexer żywy (`plugin.oramaDb`) |
| 3 | `modules/prompts/` | ~1,090 | PromptBuilder + Decision Tree v2.1 (7 grup × 27 instr.) | 🚀 ACTIVE | ✅ Mapa-10 (2026-04-26) — audit Fazy 2 PROMPT_CACHING_v1 = znaleziony bug PREFIX-1 |
| 4 | `modules/sub-agents/` | ~1,310 | SubAgentLoader + Runner (delegation) + 4 role systemowe (S05) | 🚀 ACTIVE | ✅ Mapa-11 (2026-04-26) + ✅ S05 (2026-04-28) — 4 role rdzeniowe (prep-archivist, prep-whitelist, strateg-planer, strateg-sumarizer) ładowane przez `loadSystemRoles()` + custom YAML scope (folders / frontmatter / sections / pinned_notes) + DelegateTool DI + parallel execution + timeout 60s per task. Wizja SUB_AGENTS_v2_PER_AKCJA zrealizowana w S05+S05.5 (klikalne sub-agenty: slim bar + popup `/@` + sidebar Triggery). |
| 5 | `modules/tools/` (d. `modules/mcp/`) | ~6,000 | Narzędzia agenta: 23 built-in + klient MCP external (stdio/HTTP) | 🚀 ACTIVE | ✅ Mapa-12 (2026-04-26) — 30 plików (27 z `src/mcp/` + 3 z `src/core/Server*.js`) → `modules/mcp/`, 2 importerów (main.js 33 deep imports → 1 barrel + comfy reverse dep), 16 znalezisk (1×🔴 SEC-1 brak sanitizePath na image_path, 1×🔴 DOC-1 timeout 60s↔180s mismatch, 7×🟠 ARCH-1..6+SEC-2, 6×🟡, 1×🟢), 3 Nauka cards. **NOWA Wizja `MCP_PORZADEK_v1.md`** (3 filary: built-in vs user-added separation, permissions per rola, UI extensibility jak skille/sub-agenci). **E3.1 (2026-07-24): klient MCP external (`ExternalMcpManager`, stdio/HTTP) + sandbox custom-JS wyburzony + rename `modules/mcp`→`modules/tools` (faza D).** |
| 6 | `modules/skills/` | ~890 | Skill engine (przepisy dla agentów) | 🚀 ACTIVE | ✅ Mapa-7 (2026-04-26) — SkillLoader+SkillVariables+index.js, 1 importer (DI dla reszty), Wizja INLINE_TRIGGERS_UI |
| 7 | `modules/chat/` | ~7,000 | ChatView + 8 mixinów (sesja 107) + InlineChipPlugin + StreamingManager + RollingWindow/Summarizer (E1.6 B4) + TriggerPopup (S05/S05.5) | 🚀 ACTIVE | ✅ Mapa-14 (2026-04-26) + ✅ S05 (2026-04-28: slim bar 3 sekcje [SUB/SKILLS/MCP] + InlineChipPlugin marker parser `@@skill:` / `@sub-agent:` / `@@tool:` + compact tool chips toggle + StreamingManager singleton z S03) + ✅ S05.5 (2026-04-29: TriggerPopup `/`/`@` z fuzzy filter + intersection security). Mapa-14 znalezisk 29 — w S03/S09/S13 (CH-3..6 ARCH 🟠, BUG-1 MarkdownRenderer.renderMarkdown ✅ FIXED Sprint 01). |
| 8 | `modules/models/` | ~4,600 | `ChatModel` + dostawcy w `providers/` (9 platform, Cohere skasowany E1.6, Azure/Custom + osobny klucz google skasowane 2026-09-03) + rejestr `registry.ts`; DI z `config/runtimeConfig.ts` | 🚀 ACTIVE | ✅ Mapa-6 (2026-04-26) — 11 importerów + Models hygiene v2 w Wizji MEMORY_v2_RETRIEVAL_v2 |
| 9 | ~~`modules/agora/`~~ | 0 | ✅ **REMOVED** w **Sprint 08 Z7** (2026-04-30) — projekty/threads/briefy → `modules/komunikator/`, vault map + buildPromptContext → `modules/agents/`. -2818 LOC kasacji. Migrator userów (`migrate_agora_to_komunikator`) istniał przejściowo i został później skasowany — dziś BRAK automatycznej migracji Agory (ręczny backup: MIGRATION_v2.md) | 🗑️ REMOVED | ✅ S08 (2026-04-30) |
| 10 | `modules/artifacts/` | ~1,549 | Plany (user-facing z approval flow) — todo agent-internal w tools/ | 🚀 ACTIVE | ✅ Mapa-3 (2026-04-26) + **Sprint 1** Kontekst sesji jako 3-ci typ artefaktu |
| 11 | `modules/agents/` | ~8,100 | AgentManager, AgentProfile, Jaskier, archetypy v2 | 🚀 ACTIVE | ✅ Mapa-13 (2026-04-26) — 23 pliki (Agent+AgentLoader+AgentManager+archetypes+roles+AgentProfileModal+View+9 profile/), 6 importerów + reverse dep PromptBuilder, 10 znalezisk (5×🟠: backward compat balast minions/masters ~100 LOC + Tryby v1-v2 dead path + watchAgents NO-OP + AgentCreatorModal DEPRECATED + profile_skills 815 LOC monolit), 3 Nauka cards. **NOWA Wizja `ARCHETYPES_ROLES_v2`** (3 warstwy z czystą separacją: archetype=bucket uprawnień + Singleton, role=user-defined zawód+narzędzia framework, personality=czysto charakter; sync z MCP_PORZADEK_v1) |
| 12 | `modules/multimodal/` | ~1,080 | Audio STT + image gen + vision + Oczko active-note (neutralne) | 🚀 ACTIVE | ✅ Mapa-4 (2026-04-26) |
| 13 | ~~`modules/comfy/`~~ | 0 | ✅ **REMOVED** w **E3.2** (2026-07-25) — ComfyUI Preview + Zoja Command Center + ImageTextOverlay + WorkflowLoader + presety skasowane w całości. **-4534 LOC kasacji.** Decyzja Kuby: wywałka zamiast wydzielania osobnego pluginu; ewentualny powrót = od zera. Zostaje generyczne generowanie obrazów przez platformy chmurowe (`modules/multimodal/`) + `add_text_to_image` w trybie automatycznym. Bez migratora — osierocona wartość `'comfyui'` w danych usera jest nieszkodliwa (dropdown wraca na domyślną opcję). Po S35 klucz nazywa się `pkmAssistant.imageGen.platform` (migrator M1 przemianował cały namespace `obsek` → `pkmAssistant`) — dalej bez znaczenia, bo nikt go nie czyta. | 🗑️ REMOVED | ✅ E3.2 (2026-07-25) |
| 14 | `modules/onboarding/` | ~1,094 | Wizard 4-krokowy + PlaybookManager | 🚀 ACTIVE | ✅ Mapa-8 (2026-04-26) — OnboardingModal+PlaybookManager+index.js, 2 importerów + 3 DI-only, 31 znalezisk (5×🔴) |
| 15 | `modules/komunikator/` | ~1,150 | **Komunikator v3 (S28)** — prosta poczta: skrzynka plik-per-wiadomość, 3 prymitywy `kom_send`/`kom_list`/`kom_read`, niewidzialność per agent, sprzątanie pół-automatem. Project Hub skasowany | 🚀 ACTIVE | ✅ Mapa-2 (2026-04-25) → S08 v2 → **S28 v3 (2026-07-29)** |
| 16 | `modules/crystal-soul/` | ~2,200 | UI generators (ikony, kryształy, kolory) + SkinManager (S12) | 🚀 ACTIVE | ✅ Mapa-1 (2026-04-25) — 89 importów na barrel |
| 17 | `modules/shell/` | ~4,900 | Settings tab, sidebar, misc modale | 🚀 ACTIVE | ✅ Mapa-15 (2026-04-26) — 21 plików z src/views/ + 5 z src/views/sidebar/ → modules/shell/, barrel z 22 eksportami, 4 importerów (main.js 8 importów, ApprovalManager deep→barrel zamknięcie TODO core/, chat_view + chat_session). 11 znalezisk (1×🔴 MCPClient broken dynamic import po Mapie-12 do TODO mcp/, 4×🟠: CLAUDE.md placeholder rozjazd z reality + AgoraView 1302 LOC DEPRECATED ale ŻYWY + settings_tab.js martwy kod 0 callerów + AgentCreatorModal stub deprecated, 4×🟡, 2×🟢), 4 Nauka cards. **CHECKPOINT** Część A + B do Kuby — kandydat Wizja `SETTINGS_v2_PROPER` (S10 hotfix DONE: per-module `SettingsContent.js` + `SettingsSection.js`, shell bez DOM cutting). |
| + | `modules/agent-loop/` | ~785 | **Serce pętli narzędziowej — bez UI.** `runAgentLoop()` (widoczny `for` + backstop bez narzędzi + estymacja usage), `ArrayMessageStore`, kanon `parseToolCalls()` (3 kształty odpowiedzi) + `splitConcatenatedToolCalls()` (anty-sklejanie DeepSeek), `sanitizeToolTranscript()`. Konsumenci: sub-agents, chat, tools/MCPClient | 🚀 ACTIVE | ✅ E2.1 (2026-07-22, D11) — JEDNA pętla wyciągnięta z chat + sub-agents (krok A suby, krok B czat) |
| + | `modules/ui-components/` | ~1,854 | Współdzielone UI primitives: ToolCallDisplay, ThinkingBlock, SubAgentBlock, AttachmentManager, MentionAutocomplete | 🚀 ACTIVE | ✅ S10 Z12 (2026-05-02) — przeniesione z `src/components/` |
| + | `modules/web/` | ~500 | Web access layer: WebSearchProvider (5 dostawców), urlRegistry (E1.3 URL-provenance), Web Search settings | 🚀 ACTIVE | ✅ S13a Z5 (2026-05-07) — z `src/core/WebSearchProvider.js`; E1.3 dodał urlRegistry |
| S10 settings split hotfix | `SettingsContent.js` | - | Per-module ustawienia | DONE | Core/models/memory/mcp/agents/crystal-soul posiadają realne render functions; shell bez DOM cutting. |

**Łączny LOC kodu w `src/` + `core/` + `modules/`:** ~70,000 (netto kod ~64k, i18n ~6k). Po Sprincie 02 (wywałka starego frameworka bazowego + Transformers): **~60,500** (-9,400 LOC). Po Sprint 08 (Agora): **~57,800** (-2,700 LOC).

⚠️ **7 monolitów >800 LOC** (stan 2026-09-06) oznaczonych markerem w CLAUDE.md swoich modułów: `AgentMemory.ts` 2777 · `chat_streaming.ts` 2122 · `chat_ui.ts` 1411 · `ArchiveWorkflow.ts` 1341 · `AgentManager.ts` 1147 · `RollingWindow.ts` 1003. Siódmy — **`src/main.ts` 1087** — nie ma modułowego CLAUDE.md, więc odnotowany tutaj. (Dawny `core/PKMEnv.ts` zniknął z listy razem z rozbiciem środowiska na `core/runtime/`.) Świadomie nierozbite; zmiana w którymkolwiek = przeczytaj całość przed edycją.

**Który sprint dotyka którego modułu** — pełna matryca: [`Refaktor/01_Surowizna_TODO_Wizje.md`](Refaktor/01_Surowizna_TODO_Wizje.md). Skrót:

| Moduł | Główny(e) sprint(y) |
|-------|---------------------|
| memory + retrieval | **S03 GIGANT** (+ S11 Token Viewer dependsy) |
| embedding | **S02** (Reset + Orama) |
| tools (d. mcp) | **S04** (PORZADEK_v1) + S03 (nowe tools) + S08 (kom_*) + **E3.1** (klient MCP external + rename mcp→tools) |
| sub-agents | **S05** (v2 + Inline Triggers) |
| prompts + models | **S06** (Prompt Caching + max_tokens) |
| agents | **S07** (Archetypes + Roles v2) |
| agora 🗑️ + komunikator | **S08** (Agora wywałka + Komunikator v2) |
| artifacts + chat | **S09** (Artefakty v2 + housekeeping) |
| shell + crystal-soul | **S10** (Settings v2 + Backstage v2) + **S12** (Skiny) |
| onboarding | **S01** (wizard wyłączony, defer v3) |
| comfy 🗑️ + multimodal | **S01** quick fixy + **S13b** polish + **E3.2** (comfy wywalony w całości) |
| core (security/i18n) | **S01** + **S13a** (security audit + sanitizePath ext + secrets storage) |

---

## Agenci — gdzie żyją

**W pluginie jest TYLKO Jaskier** (hardcoded w `modules/agents/archetypes/HumanVibe.js` jako systemowy onboarding agent — bez niego nowy user nie wie od czego zacząć).

**Pozostali agenci to agenci użytkownika (własne pliki YAML w `.pkm-assistant/agents/`)** — żyją TYLKO w vaulcie użytkownika. Plugin daje:
- **Runtime** (ChatView, SubAgentRunner, ServerExecutor, AccessGuard)
- **UI do produkcji agentów** (agent użytkownika jako asystent tworzenia, AgentProfileModal)
- **Monitoring i diagnostykę**

Jak szukasz "gdzie jest zdefiniowany konkretny agent użytkownika" — nie w kodzie pluginu. W vaulcie usera.

---

## Stos

- Runtime: Obsidian API + ES Modules. **Kampania TS domknięta w TS-5 (2026-07-31):** 100% źródeł w `core/`, `modules/`, `src/`, `config/`, `utils/` i `test-support/` jest w TypeScript strict (`npm run typecheck` = `tsc --noEmit`; transpilacja: esbuild w buildzie, tsx w testach). **Kontrakt kampanii: `Refaktor/Decyzje_Sesji/2026-07-30_ts0_raport.md`** — specifiery importów ZOSTAJĄ z `.js` i wskazują fizyczne pliki `.ts`.
- Build: esbuild (`npm run build` → `dist/main.js`, ~2,2MB)
- Tests: AVA framework (3023 testów (stan 2026-09-04, po fali 2 release-packu)
- Licencja: **GPL-3.0**
- Repo: https://github.com/JDHole/pkm-assistant

---

## Komendy

```bash
npm run dev              # Build z watch mode (dla developmentu)
npm run build            # Production build → dist/main.js
npm test                 # AVA — testy unit (3023, stan 2026-09-04; darmowe, offline)
npm run typecheck        # tsc --noEmit — bramka od TS-0 (kampania TS), ~3 s; od 2026-09-02 pilnuje też nieużywanych lokalnych/parametrów (KL-04, noUnusedLocals+noUnusedParameters)
```

> **Weryfikacja zmian (od S26, 2026-07-24):** testy → typecheck → lint → build → **harness**
> (`selftest` + `scenarios`, przy zmianach w pętli/narzędziach/security też bieg eksploracyjny).
> Harness odpala PRAWDZIWY plugin w Node bez Obsidiana; od 2026-09-07 mieszka w OSOBNYM repo —
> https://github.com/JDHole/pkm-assistant-harness (walidator katalogu lintuje CAŁE repo pluginu, a narzędzie
> testowe nie jest jego częścią). Klonuj je OBOK katalogu pluginu; szczegóły w jego README.
> Zastępuje ad-hoc „load-smoke z mockiem obsidiana" i większość smoke'ów klikanych w Obsidianie
> (computer-use tylko na wyraźne życzenie Kuby / release / serce UI czatu). Biegi z żywym DeepSeekiem
> (`--live`, bieg eksploracyjny bez `--offline`) wymagają klucza w `.env.local` TAMTEGO repo i kosztują
> grosze — świadomie, nigdy w `npm test`.
> **Od 2026-09-03 te same bramki jadą automatycznie w CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) na każdy push i pull request do `main` — sieć bezpieczeństwa, nie zamiennik lokalnego przebiegu przed commitem.

---

## Git flow — TYLKO repo plugina (`PKM-Assistant`)

> **Uwaga:** ta sekcja dotyczy WYŁĄCZNIE repo plugina (`https://github.com/JDHole/pkm-assistant`, lokalnie `Desktop/PKM Assistant/`). Vault właściciela to **osobne repo** — nie ruszać go z poziomu plugina. Setup obu repo opisany w CLAUDE.md vaulta, sekcja 0.5.

### Hierarchia branchy (model v2.2)

```
main (stable, jedyny długożyjący branch)
  ├── refactor/v2.2-<nazwa>   ← branch roboczy per zadanie/sprint, po bramkach merge --no-ff → main
  └── refactor/v2.2-<inne>    ← równoległa sesja = własny branch (worktree)
```

### Workflow per zadanie/sprint

```bash
git checkout main
git pull origin main
git checkout -b refactor/v2.2-<nazwa>
# ... klepiesz Z1..ZN, commity na tym branchu ...

# Bramki (wszystkie zielone):
npm test && npm run typecheck && npm run lint && npm run lint:obsidian && npm run build
cd ../pkm-assistant-harness && npm run selftest && npm run scenarios && cd -   # osobne repo harnessu

# Merge do main:
git checkout main
git merge --no-ff refactor/v2.2-<nazwa>
git push origin main
```

### Commit message format

```
refactor(s30): <co zrobione>      # zadanie/sprint w kodzie
docs(s30): <co zrobione>          # sama dokumentacja
fix(memory): <co zrobione>        # punktowa naprawa w module
```

### Twarde reguły

- **Testy pass przed commitem.** Komplet zielony (2026-07-30: 1398/1398) → commit. Red → STOP, naprawiamy, potem commit.
- **NIGDY nie commituj kodu bezpośrednio na `main`.** Kod wchodzi tylko przez `refactor/v2.2-*` + merge `--no-ff`. Wyjątek dla samego `main`: drobne docs (odznaczenie postępu w planie, literówka w CLAUDE.md).
- **Równoległe sesje = przed KAŻDYM commitem sprawdź `git branch --show-current`.** Snapshot gitStatus z początku sesji kłamie — druga sesja mogła przełączyć branch pod tobą.
- **Jedno zadanie = jeden branch** (czystsze history + łatwiejsze cofnięcie jak coś się sypnie). Branch zostaje na origin jako historical marker.
- **Nie dotykaj dwóch modułów w jednym commicie** — patrz „Co NIE-WOLNO".

> **Historia (era v2.0):** do release'u v2.0.0 obowiązywał model trzypoziomowy: sprint branch (`refactor/sprint-NN-*`) → merge `--no-ff` do `refactor/v2.0` → PR do `main` dopiero na release + tag. Commity szły wyłącznie na sprint branch, `main` był nietykalny poza release'em. Format commitów: `refactor(sprint-NN): <nazwa>` + stopka `Sprint NN/13`. Zniesione po v2.1.0 — środkowy poziom (`refactor/v2.0`) był zbędny, gdy sprinty i tak lądują na `main`. Pełny przebieg: git history branchy `refactor/v2.0` i `refactor/sprint-*`.

---

## Projekt w vaultcie Kuby + plan Refaktoru w pluginie

**Opiekun projektu od 2026-08-02:** agent-opiekun projektu w vaultcie właściciela. Prowadzi projekt, przyjmuje zgłoszenia, pisze rejestr i zleca sesje robocze w tym repo.

**Podział między dwoma repo:**

- **Plugin (TO repo, `JDHole/pkm-assistant`) = kod + `CLAUDE.md` per moduł + `Refaktor/` (archiwum planów + Sprint Notki + raporty sesji) + `Nauka/` (żywy plan v2.1, handoffy, lekcje).** To jest **źródło prawdy dla każdej sesji, która klepie kod**.
- **Vault właściciela, pracownia projektu w jego strukturze folderów** = byt projektu po stronie właściciela: oś czasu (fazy → etapy → inicjatywy), dokumentacja pisana dla niego, wrzutnia bugów, rejestr zmian. Tam Kuba widzi projekt bez wchodzenia do repo.
- **`Refaktor/` w pluginie** = archiwum ery v2.0 (kwiecień-maj 2026). Historia, nie instrukcja. `Refaktor/_state.json` jest zamrożony na 2026-05-14.

> **Vault to osobne repo i Kuba commituje go sam.** Sesja pracująca w tym repo nie wersjonuje vaulta, nie inicjuje tam repozytoriów i nie proponuje osobnych repo na dokumentację.

> **Nota historyczna (2026-08-02):** do tej daty część wiedzy o projekcie żyła w vaultcie właściciela, w dawnym folderze projektu, i nazywała się „Hogwart" (karty Nauki per moduł, historyczne TODO z ery Mapy, dziennik sesji, ADR-y). Zawartość była snapshotem na v2.0.0 z 2026-05-17 i po Etapach 1-3 przestała opisywać rzeczywistość — wymieniała pliki `.js`, `modules/mcp/` sprzed rename'u na `tools` i moduł `comfy`, który został wycięty. **Folder skasowany decyzją Kuby.** ADR-y i przekazanie projektu przeniesione do `Dokumentacja/_Zrodla/` w pracowni; reszta jest w historii gita vaulta. Odwołania do Hogwartu, które nadal widać w `Refaktor/`, to **zapis historyczny z kwietnia i maja** — nie poprawiamy ich, bo sfałszowałoby to historię.

---

## Root-level (NIE moduły)

Oprócz `core/` + `modules/`, w roocie są:

- ~~**`Refaktor/`**~~ — **od 2026-09-06 NIE w repo**: razem z `Nauka/` i `audyt/` leży w vaulcie Kuby (`Projekty/PKM Assistant/Plany i archiwum repo/`). Opis historyczny: plan Refaktoru: `00_Wielki_Plan_Refaktoru.md` + `01_Surowizna_TODO_Wizje.md` (matryca) + `_state.json` (status) + `Sprinty/SPRINT_01..12_*.md` + `SPRINT_13a/13b/13c_*.md` (15 Sprint Notek wykonawczych po split S13 z 2026-05-07) + `Decyzje_Sesji/` (założenia + audyt + per-sprint placeholders) + `Materialy_poboczne/Lessons_z_Mapy.md` + `Materialy_poboczne/SPRINT_13_Polish_v2_Release_OLD.md` (archiwum starego monolitycznego S13)
- **`config/`** (5 plików `.ts`) — `runtimeConfig.ts` (`buildRuntimeConfig` — jawna rejestracja dostawców czatu i embeddingu, HTTP, transportu), `defaultSettings.ts` (domyślne ustawienia), `default_prompts.ts` (fabryczne szkielety promptów, S31), `limits.ts` + `limits.test.ts` (twarde limity pętli agenta, E1.5/R3)
- **`utils/`** (root-level, 4 pliki `.ts` + testy) — `releaseNotes.ts` (notatki wydania: `compareSemver`, `latestReleaseFile`, `priorNotes`, `resolveNotesTarget`), `releasePrep.ts` (walidacja wersji + nazwa taga dla `release.js` — **od 2026-09-07 tylko przygotowanie**, publikację robi `.github/workflows/release.yml` po pushu taga; dawniej `releaseGithub.ts`, wystawiał release przez API GitHuba), `buildManifest.ts` (wersja z `package.json` do manifestu), `banner.ts` (copyright banner do bundla, użyty w `esbuild.js`). Workflow release: `RELEASE_PROCESS.md`
- **`assets/`** — screenshoty do README
- **`releases/`** — release notes archiwum + `RELEASE_PROCESS_v2.0_ARCHIWUM.md` (stary runbook epoki v2.0)

> **Note:** `jdhole-mcp-servers/` + `jdhole-skills/` (kuratorskie kolekcje JDHole) zostały wyniesione z repo pluginu jako osobne zasoby. NIE są częścią pluginu.

---

## Co NIE-WOLNO

- ❌ **Nowych feature'ów podczas refaktoru** — WIELKI OGAR ma priorytet
- ❌ **Deep imports** (z bebechów innego modułu) — tylko przez jego `index.js`
- ❌ Commitować `dist/` ani kluczy API
- ❌ Mockować testów. Integracyjne > jednostkowe
- ❌ Dotykać dwóch modułów w jednym commicie
- ❌ Usuwać kodu bez zrozumienia — JDHole się uczy, każda zmiana to lekcja
- ❌ **`git init` w podfolderze vaulta właściciela** — vault to JEDNO repo, nested git = chaos. Dokumentacja, ADR-y, wiedza dev — wszystko żyje w vault repo, NIE w osobnych repach. Plugin (TEN folder) i vault to dwa osobne światy
- ❌ Sugerować Kubie tworzenia osobnych repo dla dokumentacji / ADR-ów / wiedzy — to wszystko jest częścią vault repo
- ❌ **Dotykać agentów w `.pkm-assistant/agents/` w vaultcie** — prywatna strefa Kuby (decyzja 2026-08-01). Sesje pluginowe ich nie recenzują, nie naprawiają i nie raportują

---

## Backlog Refaktoru — gdzie żyje co

Po Mapie i audycie 2026-04-27 backlog refaktoru żyje w **dwóch miejscach** (świadomy split):

### 1. Plan Refaktoru — w pluginie (`Refaktor/`)
**Bieżące źródło prawdy dla agenta klepiącego sprint:**
- [`Refaktor/00_Wielki_Plan_Refaktoru.md`](Refaktor/00_Wielki_Plan_Refaktoru.md) — high-level + sprint index + dependencies
- [`Refaktor/01_Surowizna_TODO_Wizje.md`](Refaktor/01_Surowizna_TODO_Wizje.md) — matryca 264 znalezisk × 13 sprintów (z 27 świadomie odłożonych: DONE/OBSERWACJA/DEFER v3); S13 split na 13a/13b/13c od 2026-05-07
- [`Refaktor/Sprinty/SPRINT_NN_*.md`](Refaktor/Sprinty/) — 15 Sprint Notek wykonawczych (S01..S12 + S13a + S13b + S13c, każda self-contained, agent-agnostic, z Pre-flight Kuby + Z0 pre-check + Pytania do Kuby + KONIEC SPRINTU)
- [`Refaktor/Decyzje_Sesji/`](Refaktor/Decyzje_Sesji/) — założenia + audyt 2026-04-27 + per-sprint placeholders (np. `2026-04-27_post_sprint_02_PLACEHOLDER.md` z 3 opcjami Connections decision)
- [`Refaktor/_state.json`](Refaktor/_state.json) — task status (in_progress/done) per sprint

### 2. Per-modułowe TODO — już nie istnieje osobno

Historyczne źródło znalezisk (Mapa-1 do Mapa-15) leżało w vaultcie jako `Moduly/<moduł>/TODO.md`. Folder skasowany 2026-08-02 (patrz nota historyczna wyżej) — te **same 264 znaleziska** żyją w matrycy w tym repo:

[`Refaktor/01_Surowizna_TODO_Wizje.md`](Refaktor/01_Surowizna_TODO_Wizje.md) — 264 znaleziska × 13 sprintów (S13 split na 13a/13b/13c), wszystkie skreślone albo świadomie odłożone.

### Workflow agenta klepiącego sprint

1. **Otwiera Claude Code w `Desktop/PKM Assistant/`** (NIE w starym Obsek folderze)
2. **Czyta odpowiednią Sprint Notkę** `Refaktor/Sprinty/SPRINT_NN_*.md` — to jest start pack
3. **Wykonuje Pre-flight Kuby** (jeśli sprint go ma — np. S01 wymaga revoke ComfyUI key)
4. **Robi Z0 pre-check** (verify dependencies, build, tests)
5. **Iteruje Z1, Z2, ..., ZN** z DoD checkboxów
6. **Jeśli STOP & REVIEW** (S03 po Z9, S08 po Z2) — czeka na Kuba approval w DEVLOG przed kontynuacją
7. **Update `Refaktor/_state.json`** + commit + tworzy `Decyzje_Sesji/2026-04-27_post_sprint_NN.md`

### Per-moduł CLAUDE.md w pluginie

Zachowuje:
- **Co tu jest** (struktura modułu + LOC)
- **Public API** (eksporty index.js)
- **Gotchas / decyzje historyczne**
- **Sprint Refaktoru który mnie dotyka** (link do Sprint Notki)
- Link do znalezisk modułu w matrycy [`Refaktor/01_Surowizna_TODO_Wizje.md`](Refaktor/01_Surowizna_TODO_Wizje.md) (history)

---

## Źródła prawdy

### W pluginie (TEN folder)
- **`Refaktor/00_Wielki_Plan_Refaktoru.md`** — master plan Refaktoru (13 sprintów, S13 split na 3 fazy, sequencing, mapa zależności)
- **`Refaktor/01_Surowizna_TODO_Wizje.md`** — matryca 264 znalezisk × 13 sprintów (kanon scope per sprint, S13 znaleziska przepinkowane do 13a/13b/13c)
- **`Refaktor/Sprinty/SPRINT_NN_*.md`** — Sprint Notki (start pack dla agenta klepiącego)
- **`Refaktor/Decyzje_Sesji/`** — decyzje sesyjne (założenia + audyt 2026-04-27 + per-sprint)
- **`Refaktor/_state.json`** — bieżący status sprintów (in_progress / done)
- **`README.md`** / **`QUICK_START.md`** — dla nowych userów
- **`SECURITY.md`** — bieżący stan bezpieczeństwa (security policy GitHub)
- **Per-module `CLAUDE.md`** — deep dive modułu

### W vaultcie właściciela (pracownia projektu)
- **`Projekty/PKM Assistant/Dokumentacja/`** — dokumentacja projektu pisana dla właściciela (architektura, proces, stan, ogony, historia, protokół miesiąca testów, baseline bezpieczeństwa)
- **`Projekty/PKM Assistant/Dokumentacja/_Zrodla/ADR/`** — 5 ADR-ów (Architecture Decision Records) z kwietnia 2026
- **`Projekty/PKM Assistant/Dokumentacja/_Zrodla/Przekazanie_2026-08-01/`** — pełne przekazanie projektu agentowi-opiekunowi (architektura, metodologia, lekcje techniczne, współpraca z Kubą, plan miesiąca testów, stan i ogony)
- **`Projekty/PKM Assistant/Rejestr.md`** — changelog techniczny projektu
- **`Projekty/PKM Assistant/Bugi/`** — wrzutnia zgłoszeń Kuby, 1 plik = 1 bug
- **`Nauka/Lekcje/`, `Patterns/`** — wiedza dev ponad projektami, wyciągnięta z tego projektu

### Konflikt faktów (kolejność aktualności)
1. `Refaktor/_state.json` (⚠️ ARCHIWUM fazy v2.0, zamrożony 2026-05-14 — bieżący stan: `Nauka/PLAN_REFAKTORU_v2.1.html`)
2. `Refaktor/Decyzje_Sesji/2026-04-27_post_sprint_NN.md` (decyzje per sprint)
3. `Refaktor/Sprinty/SPRINT_NN_*.md` (plan post-audit)
4. Per-module CLAUDE.md (kontekst lokalny)
5. ADR-y w vault (architektoniczne podstawy, niezmienne)

**Bugi:** NIE wpisuj bugów do planu refaktoru — zgłaszaj je Kubie w sesji.

---

## Dla agenta (Claude Code / Kimi / Codex / Ollama / własny PKM Assistant) — jak pracować

### Klepanie zadania (model v2.2, stan 2026-07-30)

0. **Otwórz sesję agenta w root pluginu:** `Desktop\PKM Assistant\` (NIE w pojedynczym module). Agent ma w cwd = root pluginu, dostęp do wszystkich `modules/`, `core/`, `Refaktor/`.
1. **Start od `main`:** `git checkout main && git pull origin main` → `git checkout -b refactor/v2.2-<nazwa>`. Przy równoległych sesjach — osobny worktree (`git worktree add .claude/worktrees/<nazwa> -b refactor/v2.2-<nazwa> origin/main`), NIE przełączaj brancha pod cudzą sesją.
2. **Źródło zadania:** handoff sesji, [`Refaktor/Decyzje_Sesji/2026-07-29_health_check_backlog.md`](Refaktor/Decyzje_Sesji/2026-07-29_health_check_backlog.md) (kubełki) albo plan `Nauka/PLAN_REFAKTORU_v2.1.html`. Zanim spytasz Kubę — grepnij kod: pytania tylko o decyzje, nie o fakty.
3. **Iteruj zadania; commity na branchu roboczym.** Testy pass przed każdym commitem (stan 2026-07-30: 1398/1398). Przed commitem `git branch --show-current` (równoległe sesje!).
4. **Bramki przed merge:** `npm test` → `npm run typecheck` → `npm run lint` → `npm run lint:obsidian` → `npm run build`, a potem w sklonowanym obok repo harnessu (https://github.com/JDHole/pkm-assistant-harness) `npm run selftest` + `npm run scenarios` (34/34).
5. **Koniec zadania:** raport do `Refaktor/Decyzje_Sesji/<data>_<nazwa>.md` (co zrobione, LOC, niespodzianki) + push brancha + merge `--no-ff` do `main` (albo zgłoszenie Kubie/bazie, jeśli sesja nie merguje sama) + odznaczenie postępu w backlogu/planie.

> **Historia (era v2.0):** sprinty S01-S13c szły wg Sprint Notek (`Refaktor/Sprinty/SPRINT_NN_*.md`, self-contained, z Pre-flight Kuby + Z0 pre-check + STOP & REVIEW) na branchach `refactor/sprint-NN-*` odbijanych od `refactor/v2.0`; uniwersalny prompt startowy: `Refaktor/PROMPT_STARTOWY_SPRINTU.md`. Ten workflow zakończył się wraz z release v2.0.0 — Sprint Notki i `_state.json` to dziś archiwum, nie instrukcja.

### Reguły ogólne

1. **Otwieraj root pluginu** (`Desktop\PKM Assistant\`), NIE pojedynczy moduł. Sprinty Refaktoru są **cross-module** (S03 Memory v2 dotyka 6 modułów, S10 Settings v2 dotyka 16). Agent potrzebuje dostępu do wszystkich.
   - **Wyjątek z Mapy:** w fazie Mapy (zamknięta 2026-04-26) reguła była "1 sesja = 1 moduł" — bo każda sesja Mapy przenosiła JEDEN moduł. Refaktor nie pasuje do tego wzorca.
   - **Deep dive per moduł** (gdy potrzeba research) → Explore subagent z poziomu root, nie osobna sesja.
2. **Sprint Notka jest start packiem** — `Refaktor/Sprinty/SPRINT_NN_*.md` ma sekcję "Co przeczytać na start" wskazującą konkretne CLAUDE.md modułowe potrzebne dla sprintu. Czytaj **te** moduły, nie wszystkie 19.
3. **Stan dzisiejszy:** **cały kod modułowy siedzi w `modules/<nazwa>/`** — `src/` to już tylko `main.ts` (composition root) i `styles.css`. Historia domknięcia: stary framework bazowy + `src/embeddings/` (S02 → S31), `src/components/` → `modules/ui-components/` (S10 Z12), `src/utils/` → `core/` (S31), `src/core/WebSearchProvider.js` → `modules/web/` (S13a Z5), `src/core/VaultZones.ts` → wycięty 2026-09-03 (martwy podsystem stref, AUD-dead-code-031/115/172/216).
4. Przed zmianą w module → przeczytaj jego `CLAUDE.md`. Tam są gotchas, decyzje historyczne i link do Sprint Notki która dotyka tego modułu.
5. **JDHole jest nie-programistą** — tłumacz po polsku, prostymi słowami, metaforami. Bez żargonu bez wyjaśnienia.
6. Po zmianie → zaktualizuj per-moduł `CLAUDE.md` jeśli zmieniło się public API, doszło gotcha, lub skreślono TODO. **Dokumentacja, która kłamie, jest w tym projekcie traktowana jak błąd.**
7. **Token economy matters** — user płaci za tokeny, oszczędzaj gdzie się da. Przed dużym refactorem rozważ czy nie da się tego zrobić mniejszym diff'em.

---

## Drabina modeli (delegacja w CC)

Default main: Fable; drobne sprawy ad hoc: Opus (`/model opus`). Main myśli,
planuje, decyduje i gada z Kubą - wykonawstwo idzie w dół przez Agent tool
(parametry `model` + `effort`).

| Model | Rola | Effort |
|---|---|---|
| haiku | masówka: skan wielu plików, inwentaryzacje, parsing, triage | - (nie wspiera) |
| sonnet | DOMYŚLNY wykonawca: implementacja wg specy, search z oceną, naprawy z bramkami | medium-high |
| opus | weryfikator roboty sonneta, ciężkie refaktory, krytyczne miejsca | high-xhigh |
| fable | tylko main sesji - nigdy subagent | - |

1. Pierwszy strzał najtańszym modelem, który ma szansę; eskalacja po
   oblanej bramce, nie na zapas.
2. Delegacja pisząca kod MUSI mieć bramkę (test / build / walidacja składni).
3. Weryfikacja o szczebel wyżej niż wykonawca (sonnet pisze → opus sprawdza).
4. Niezależne delegacje równolegle, w jednym bloku; prompt delegacji zawsze:
   cel, pliki startowe, format odpowiedzi, czego NIE robić (subagent
   startuje na zimno).
5. Małe zadania main robi sam - delegacja jednej edycji kosztuje więcej
   niż robota.

Gdy main = Fable (budżet ≤50% tygodniówki):
- Nie czytaj hurtowo: 3+ plików albo search po repo → Explore
  (haiku/sonnet); do kontekstu bierzesz wnioski, nie treść plików.
- Nie pisz długiego kodu: Fable pisze specyfikację (co, gdzie, przypadki
  brzegowe, jak zweryfikować), sonnet/opus implementuje, Fable robi review
  krytycznych miejsc.
- Wyniki subagentów = signal, nie evidence: kluczowe twierdzenia sprawdzasz
  punktowo sam (jeden Read/Grep w decydującym miejscu).
- Zostało czyste wykonawstwo → zaproponuj Kubie `/model opus` na resztę
  sesji; Fable wraca przy następnej decyzji.

Bliźniacze kopie: `~/.claude/CLAUDE.md` (laptop, wszystkie projekty) +
CLAUDE.md vaulta; ta kopia jest dla sesji chmurowych w tym repo.
Zmieniasz jedną → zmieniasz wszystkie trzy.
