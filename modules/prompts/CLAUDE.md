# modules/prompts/

Buduje system prompt agenta. Sekcja „JAK PRACUJĘ" to **chudy rdzeń**: kilka reguł
cross-tool i sądów modelu, zawsze włączonych (`CORE_RULES`), plus **indeks skilli** i dane
dynamiczne. Guidance „kiedy użyć KONKRETNEGO narzędzia" siedzi w opisach narzędzi (i18n
`mcp.*.desc`, idą do API razem z definicją narzędzia), nie w drzewie decyzyjnym; twarde
reguły (approval na delete, nudge do todo po skillu, anti-loop) żyją w kodzie/hookach.
Furtka `extendedPromptRules` (default OFF) dokłada ROZSZERZONE REGUŁY (`EXTENDED_RULES`) dla
słabszych modeli, które gorzej czytają opisy narzędzi. Instrukcja przypięta do narzędzia
renderuje się TYLKO gdy to narzędzie jest realnie dostępne agentowi
(`ctx.availableToolNames`). Każda instrukcja ma override na poziomie global i agent
(`decisionTreeInstructions[id]`).

---

## Co tu jest

```
modules/prompts/
├── index.js            # publiczne drzwi
├── CLAUDE.md            # ten plik
├── PromptBuilder.js     # builder + _buildDecisionTree (chudy rdzeń) + _buildSkillIndex + _addArtifactContext
├── decisionTree.js      # CORE_RULES / EXTENDED_RULES / DECISION_TREE_* (treści z i18n, leniwie) + resolve/split (pure, testowalne)
├── skillIndex.js        # buildSkillIndex - indeks skilli z budżetem (pure, testowalne)
└── artifactIndex.js     # indeks typów artefaktów (opis + nagłówki sekcji szablonu) + aktywny artefakt (pure, testowalne)
```

`decisionTree.js`, `skillIndex.js` i `artifactIndex.js` żyją jako **moduły pure** (zależności:
i18n + barrel `modules/artifacts`, sam bez `obsidian`; node-testowalne), bo `PromptBuilder`
przez łańcuch importów wciąga `obsidian`
i nie da się go testować node'em - logika rdzenia/indeksów żyje osobno i ma własne pokrycie
(`decisionTree.test.ts`, `skillIndex.test.ts`, `artifactIndex.test.ts`).

---

## Drzewo decyzyjne - chudy rdzeń

`_buildDecisionTree` renderuje płasko (nie po grupach):

1. **RDZEŃ** (`CORE_RULES`, always-on) - reguły cross-tool i sądy modelu: eskalacja
   (wiesz→odpowiadaj, brakuje danych→zbierz, brak wyniku→ask_user, user odmówił→STOP),
   delegacja (jedna linia: dużo danych do zebrania → `delegate`, drobiazgi rób sam), artefakty
   (todo domyślnie od 3+ kroków, hierarchia planu, patch na istniejący zamiast nowego), pamięć
   (`mem_proactive` - proaktywny zapis pod koniec tury wg bramki istotności, plus zapis/czyszczenie
   ulotnego stanu „Na teraz"; `mem_dedup` - sprawdź katalog `##` sekcji w `brain.md` przed
   zapisem), skille (wskazówka do indeksu niżej, gate'owana `requiresSkills`), komunikator
   (`kom_inbox` - reakcja na ping nieprzeczytanej poczty: `kom_list` po nagłówki, `kom_read`
   tylko dla istotnych, poczty się nie kasuje). Instrukcja z `tool:` renderuje się TYLKO gdy
   narzędzie jest w `ctx.availableToolNames`; reguła `requiresSkills` - tylko gdy agent ma
   skille.
2. **INDEKS SKILLI** (`_buildSkillIndex`) - `⚡ nazwa: opis → read("ścieżka SKILL.md")`,
   manual-only (`disable-model-invocation`) osobno na krótkiej liście „tylko na wyraźne
   życzenie usera", budżet **8000 zn** (nadmiar → `…i N kolejnych - list(".pkm-assistant/skills")`).
3. **DANE DYNAMICZNE** - sub-agenty / artefakty w toku / agenci / skrzynka (gate'owane
   dostępnością narzędzia albo obecnością danych).
4. **FURTKA** (`extendedPromptRules` ON) - sekcja ROZSZERZONE REGUŁY (`EXTENDED_RULES`):
   pełne, verbose instrukcje „kiedy użyć narzędzia" (pamięć, foldery, delegacja do innego
   agenta, plan do zatwierdzenia, wysyłka poczty), filtrowane po dostępności jak rdzeń.
   Default OFF = prompt zostaje chudy.

**Grupy** (`DECISION_TREE_GROUPS`) służą **tylko** do grupowania w UI overridów
(`profile_prompt`, pola `label`+`order`) - render drzewa jest płaski i gatuje po
`ctx.availableToolNames` / `ctx.skills`, nie po grupach. Override per-instrukcja
(`decisionTreeInstructions[id]`: `false` = wyłącz, `string` = podmień tekst) działa dla
rdzenia i furtki, na poziomie global i agent. Klucze `custom_*` w overridach to instrukcje
dopisane przez usera - traktowane jak rdzeń (always-on).

---

## Skład promptu - kolejność sekcji

```
A: KIM JESTEM (identity, personality)
B: GDZIE PRACUJĘ (environment, folders, permissions + agent_rules)
C: JAK PRACUJĘ (decision_tree, delegate_guide, rules)
D: KONTEKST (artifacts, current_date, memory, oczko) - dane, nie reguły
   `artifacts` i `memory` idą przez `addDynamicSection` → `fenceUntrusted` (ogrodzenie);
   Oczko (aktywna notatka) dokleja się już ogrodzone przez `modules/multimodal/active_note.ts`
```

Kolejność A→B→C→D nie jest dowolna: identity (A) i środowisko/uprawnienia (B) definiują
kontekst zanim drzewo decyzyjne (C) opisze „kiedy". `_buildIdentity()` (blok A) NIE generuje
daty - data żyje osobno w sekcji `current_date` (blok D), żeby A zostawał stabilny
byte-for-byte między dniami i providerzy prompt cache nie tracili prefiksu przez samą zmianę
daty. Guard test: `PromptBuilder.cache.test.ts` pilnuje, żeby `new Date()` nie wróciło do
`_buildIdentity()`.

**Filozofia:**
- Opis → Instrukcja (nie mów czym jest, mów co robić)
- 1 info = 1 miejsce (zero duplikacji)
- JSON tools mówią same za siebie (nie powtarzamy opisów narzędzi w drzewie)
- Wszystko edytowalne: agent override > global override > factory default

---

## Public API (`index.js`)

| Eksport | Po co |
|---|---|
| `PromptBuilder` (klasa) | Główny builder - `new PromptBuilder().build(agent, ctx)` |
| `FACTORY_DEFAULTS` | Default texts dla każdej sekcji prompta - podstawa łańcucha override |
| `DECISION_TREE_GROUPS` | Grupy (delegacja/pamięć/pliki/artefakty/skille/komunikacja/komunikator) - **tylko** grupowanie w UI overridów, render ich nie używa |
| `DECISION_TREE_DEFAULTS` | `CORE_RULES` (tier core) + `EXTENDED_RULES` (tier extended), re-eksport z `decisionTree.js`. Źródło UI overridów i resolvera |
| typy `PromptSkill`, `DecisionTreeOverride`, `DecisionTreeOverrides`, `DecisionTreeRule` | Kształty danych dla konsumentów UI |

Pure helpery `resolveDecisionTreeInstructions` / `splitDecisionTreeRules` / `buildSkillIndex` /
`ruleTextKey` NIE są w barrelu - wewnętrzne, importowane wprost przez `PromptBuilder` i przez testy.

---

## Zależności

**Moduł zależy od:**

| Co | Skąd | Po co |
|---|---|---|
| `getTokenCount` | `core/utils/tokenCounter.js` | Estymata tokenów prompta |
| `fenceUntrusted` | `core/security/promptFence.js` (barrel `core/index.js`) | Ogrodzenie niezaufanej treści w bloku D - patrz Gotcha niżej |
| Dane agenta | `modules/agents` przez `AgentManager` | `_buildIdentity` = tylko `name`+`vault`; `personality` wchodzi wprost; `agent.language` steruje regułą językową w `_buildRules` |
| `t`, `getDateLocale` | `core/i18n/index.js` | i18n PL/EN dla wszystkich instrukcji (w tym TREŚCI reguł drzewa: `prompt.dt.rule.<id>`) + format daty + `t(key, params, forcedLocale)` dla reguły językowej per agent |
| `parseArtifact` | `modules/artifacts` (barrel, node-safe) | `artifactIndex.js` liczy nagłówki sekcji szablonu TYM SAMYM parserem, którego patcher używa w `findSection` - własny regex rozjechałby się z silnikiem |
| `artifactSection`, `ARTIFACT_SECTION_NAMES` | `modules/artifacts` (barrel, node-safe) | Nazwy sekcji wbudowanych typów są PL albo EN (język interfejsu). `decisionTree.js` wypełnia nimi placeholdery `{{user_notes}}`/`{{steps}}`/… w regułach, `artifactIndex.js` - w `prompt.dt.active_artifact` |

**Kto importuje `modules/prompts`:**

| Skąd | Co bierze | Po co |
|---|---|---|
| `modules/agents/Agent.js` | `PromptBuilder` | `getSystemPrompt()` per agent |
| `modules/agents/profile/profile_prompt.js` | `FACTORY_DEFAULTS`, `DECISION_TREE_GROUPS`, `DECISION_TREE_DEFAULTS` | Sidebar Ustawień - UI overridów prompta per agent |
| `modules/shell/prompt_settings.js` | `FACTORY_DEFAULTS` | Sidebar Ustawień - overridy globalne |

---

## Gotchas

- ⚠️ **Każda niezaufana treść wchodzi do promptu przez `fenceUntrusted`, jedną funkcję.**
  `fenceUntrusted(content, source)` (`core/security/promptFence.js`) zwraca
  `<vault_content source="…">…</vault_content>` i escapuje `<vault_content` /
  `</vault_content` z wnętrza treści (`&lt;…`), więc ogrodzenia nie da się zamknąć od środka.
  Nie sklejaj znacznika ręcznie, nie rób drugiego mechanizmu. Kanały, które dziś przez nie
  przechodzą: pamięć agenta (`brain.md` + indeks `brain/`, przez `addDynamicSection` w
  `Agent.getSystemPrompt`), indeks artefaktów + aktywny artefakt (`_addArtifactContext`, blok
  D), Oczko - aktywna notatka (nazwa, frontmatter, body - `modules/multimodal/active_note.js`
  jest producentem), podsumowanie rozmowy (`RollingWindow.systemPrompt`, rolling summary -
  streszcza też wyniki narzędzi `role:'tool'` i wraca na wejście kolejnych sumaryzacji, więc
  bez ogrodzenia treść z `read`/`web_read` utrwalałaby się w kontekście jako polecenie).
  **Co NIE jest niezaufane** (i celowo zostaje regułą, nie danymi): `agent.agentRules` z
  YAML-a agenta w `.pkm-assistant/agents/` oraz opisy folderów z mapy vaulta
  (`.pkm-assistant/agents/vault_map.md`) - oba pisze operator, a `.pkm-assistant/**` jest poza
  zasięgiem narzędzi agenta. Modelowi mówi o ogrodzeniu **jedno** zdanie w sekcji
  `content_security` - nie dubluj preambuły „to są dane" przy każdym bloku.
  Ogrodzenie idzie WYŁĄCZNIE w część dynamiczną promptu (blok D), nigdy w bloki A-C -
  wciągnięcie go tam zepsułoby stabilny prefiks cache (dlatego indeks artefaktów stoi w D,
  nie w drzewie decyzyjnym: niósłby surowy `status`/`typ` z frontmattera notatek vaulta w
  sekcji REGUŁ).
- ⚠️ **`requiredGroups` na grupach drzewa nie istnieje.** Render (`_buildDecisionTree`) gatuje
  WYŁĄCZNIE po `ctx.availableToolNames` (dostępność narzędzia) i `ctx.skills` (skille) -
  grupy niosą tylko `label`+`order` dla UI overridów w `profile_prompt`.
- ⚠️ **Treści reguł drzewa idą przez i18n i są LENIWE.** Od 2.2.5 `CORE_RULES` /
  `EXTENDED_RULES` (`decisionTree.js`) nie niosą napisów: definicja to `{id, group, tool,
  requiresSkills?}`, a treść mieszka w słownikach pod kluczem **`prompt.dt.rule.<id>`**
  (`ruleTextKey(id)`, pl + en). Pole `text` na regule jest **getterem** - woła
  `fillSectionNames(t(...))` dopiero W CHWILI ODCZYTU. Musi tak być: `DECISION_TREE_DEFAULTS`
  powstaje na poziomie modułu, a `setLocale()` leci dopiero z `src/main.ts`, więc napis
  policzony przy imporcie zamroziłby angielski dla wszystkich.
  **⛔ Nie rób `{ ...rule }` na tych obiektach i nie wkładaj `rule.text` do stałej modułowej** -
  spread liczy getter na miejscu. Kopiowanie jest legalne tylko w funkcji wołanej przy renderze
  (`resolveDecisionTreeInstructions`) albo przy rysowaniu UI (`profile_prompt`).
  Klucz jest SKŁADANY, więc skaner literałów `t('...')` z `core/i18n/parity.test.ts` go nie
  widzi - parytetu pilnuje test „każda reguła ma treść w OBU słownikach"
  (`decisionTree.test.ts`), tam też stoi pin liczby reguł. **Dokładasz regułę → dopisz klucz do
  pl.ts I en.ts.** Guidance „kiedy użyć narzędzia" nadal pisz w `mcp.<tool>.desc`, nie w drzewie.
- ⚠️ **NAZWY SEKCJI ARTEFAKTU zostają placeholderem także w słowniku.** Nagłówek sekcji to ADRES patcha
  (`set_section`/`add_item` trafiają po nazwie), a szablon typu na dysku jest od 2.2.5 polski
  albo angielski. Napis wpisany na sztywno kazałby modelowi chronić/wypełniać sekcję,
  której w notatce nie ma. Dlatego **wartość słownikowa** `prompt.dt.rule.art_existing` niesie
  `{{user_notes}}` (analogicznie `{{steps}}`, `{{goal}}`, … - klucze rejestru
  `ARTIFACT_SECTION_NAMES`), a `fillSectionNames()` wypełnia je z `artifactSection()` -
  **przy każdym odczycie**: raz w getterze `text` (tekst fabryczny) i raz w
  `resolveDecisionTreeInstructions` (teksty NADPISANE przez usera i reguły `custom_*`;
  wypełnianie jest idempotentne). Nieznany placeholder przechodzi nietknięty - to nie jest
  silnik szablonów. `t()` bez `params` nie rusza `{{…}}`, więc placeholder dojeżdża z i18n cały.
  Ten sam mechanizm w `artifactIndex.js` dla `prompt.dt.active_artifact`
  (słownik trzyma `{{user_notes}}`, wołacz podaje wartość). **Nazywasz sekcję w regule albo
  w kluczu `prompt.dt.*` - użyj placeholdera, nie napisu.**
- ⚠️ **Playbook (onboarding) nie jest częścią tego modułu.** `PlaybookManager` (compile
  playbook + vault map per agent) mieszka w `modules/onboarding/` - konceptualnie inny
  koncern, choć historycznie bywał tu wymieniany.

---

## Powiązane

- `modules/agents/CLAUDE.md` - `Agent.getSystemPrompt()`, wstrzykiwanie pamięci
  (`agent.permissions.memory`), `AgentManager.filterByAgent` (źródło `ctx.availableToolNames`)
- `modules/artifacts/CLAUDE.md` - silnik artefaktów, `parseArtifact`/`findSection`, którego
  format czyta `artifactIndex.js`
- `core/security/promptFence.js` - implementacja `fenceUntrusted`
