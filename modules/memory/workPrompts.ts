/**
 * Factory work-prompts owned by the memory module.
 *
 * These are the built-in defaults for the memory workflows. They are resolved through the
 * agent > global (Settings→Prompt) > factory chain via `resolveWorkPrompt` (core), so a fresh
 * agent (empty per-agent prompt) still gets a working LLM path.
 *
 * - `save_session` — /save session (transcript → new brain/ notes; brain.md is rebuilt as an index)
 * - `archive`      — ArchiveWorkflow Phase 1 dedup (notes list → merges + deletions)
 * - `summary`      — ArchiveWorkflow Phase 2/3/4 (L1/L2/L3 docs → 1 synthetic summary; {{LEVEL}} token)
 *
 * ⚠️ JĘZYK INTERFEJSU, LICZONY LENIWIE. Od 2.2.5 każdy prompt ma wersję PL i EN, a wołacz
 * bierze je przez `factoryWorkPrompt(kind)` — NIGDY przez stałą modułową. `setLocale()` leci
 * z `src/main.ts` PO załadowaniu modułów, więc tekst wybrany przy imporcie zamroziłby angielski
 * dla wszystkich. Domyślna wartość parametru `locale` liczy się przy wywołaniu, nie przy
 * definicji funkcji — dlatego to jest bezpieczne, a `export const … = FACTORY[locale]` nie byłoby.
 *
 * CONTRACT: workflows parse the shape these produce, and the shape MUST be identical in both
 * languages. Nietykalne w tłumaczeniu (to ADRESY, nie proza):
 *  - klucze JSON (`brain_updates`, `new_notes`, `na_teraz.user/environment.add/remove`,
 *    `merges`, `deletions`, `sources`, `target_*`, `merged_content`, `lessons_extracted`),
 *  - wartości `type` (`user` / `agent_rule` / `skill_hint` / `project_context` / `reference`),
 *  - token `{{LEVEL}}`,
 *  - nagłówki sekcji brain.md (`## Bieżące`, `## User`, `## Preferencje`, `## Workflow`,
 *    `## Projekty i referencje`, „Na teraz: User", „Na teraz: Środowisko") — te napisy są
 *    wpisane na sztywno w `BrainIndex.ts` / `SaveSessionWorkflow.ts` i NIE idą za językiem.
 * Overrides (global/agent) MUST keep the same output structure — Settings→Prompt warns about
 * this next to each field.
 * (Moved here from modules/agents/archetypes/savePrompts.js so the workflows own their defaults
 * without a memory→agents import cycle.)
 */
import { getLocale } from '../../core/i18n/index.js';

/** Który prompt roboczy pamięci. Nazwy 1:1 z kluczami `WORK_PROMPT_KEYS` bez sufiksu `_prompt`. */
export type WorkPromptKind = 'save_session' | 'archive' | 'summary';

const SAVE_SESSION_PL = `Analizujesz transcript rozmowy i bieżący brain.md agenta. Twoje zadanie: zaproponować nowe/ważne notatki do brain/*.md. brain.md NIE przechowuje już faktów — workflow przebuduje go automatycznie jako kategoryzowany indeks linków do plików.

ZASADY brain.md:
- brain.md to spis treści do brain/, nie magazyn faktów.
- Stałe sekcje indeksu:
  - ## Bieżące — max 2-3 aktywne projekty/tematy, jako link do konkretnej notatki project_context + 1 krótkie zdanie opisu.
  - ## User — linki do notatek z faktami o userze.
  - ## Preferencje — linki do reguł/preferencji pracy.
  - ## Workflow — linki do notatek "jak używać / jak robić".
  - ## Projekty i referencje — linki do pozostałych kontekstów projektowych i referencji.
- NIE proponuj dopisywania faktów bezpośrednio do brain.md.
- Jeśli bieżąca sesja dotyczy aktywnego projektu, zaproponuj notatkę typu project_context z opisem, który dobrze wygląda jako jedna linia indeksu.
- Jeśli z sesji wynika trwała nauka, zaproponuj notatkę właściwego typu: user, agent_rule, skill_hint, project_context albo reference.
- Pełna historia rozmowy idzie do sessions/ + L1/L2/L3 — NIE kopiuj jej do brain.md.

SEKCJE „NA TERAZ" (pamięć krótkotrwała na początku brain.md):
- brain.md ma dwie sekcje stanu bieżącego: „Na teraz: User" (nad czym user pracuje DZIŚ, jego bieżący stan) i „Na teraz: Środowisko" (aktualny stan projektu/vaulta/otoczenia).
- To KRÓTKIE, ZMIENNE zdania (bullety zwykłej treści, NIE linki, NIE trwałe fakty). Trwałe rzeczy dalej idą do new_notes — „na teraz" to tylko chwilowy stan.
- Zaproponuj aktualizacje na bazie sesji: add[] = nowe bieżące zdania; remove[] = zdania które się ZDEZAKTUALIZOWAŁY (podaj tekst istniejącego wpisu z brain.md do usunięcia).
- Jeśli nic się nie zmieniło w danej sekcji → zostaw puste tablice. Nie duplikuj tego, co już jest w „Na teraz".

WYMAGANY OUTPUT (czysty JSON, bez markdown code-fence):
{
  "brain_updates": [],
  "new_notes": [
    {
      "name": "memory_v3_index_rework",
      "description": "Przebudowa systemu zapisywania i indeksowania faktów w brain.md i brain/.",
      "type": "project_context",
      "content": "Projekt dotyczy zmiany Memory v3 tak, żeby brain.md był indeksem kategorii, a trwałe fakty mieszkały w osobnych notatkach brain/*.md.",
      "why": "To aktywny temat sesji i powinien trafić do Bieżących przez indeks brain.md.",
      "how_to_apply": "Wczytaj tę notatkę, gdy rozmowa wraca do Memory v3, /save session, archiwizacji projektów lub indeksu brain.md."
    }
  ],
  "na_teraz": {
    "user": { "add": ["User testuje dziś zakładkę Pamięć w panelu agenta"], "remove": [] },
    "environment": { "add": [], "remove": ["Stary stan projektu, który już nieaktualny"] }
  }
}

Pola wymagane:
- ZAWSZE zwracaj "brain_updates": [].
- new_notes[].type ∈ { "user", "agent_rule", "skill_hint", "project_context", "reference" }.
- new_notes[].description ma być jedną, konkretną linią do indeksu brain.md.
- "na_teraz" jest opcjonalne — pomiń albo zwróć puste tablice, jeśli stan bieżący się nie zmienił.

ZASADY DECYZYJNE:
- Jeśli user mówi explicitnie "zapamiętaj X" → new_notes.
- Fakt o userze → type "user".
- Preferencja / zasada stylu pracy → type "agent_rule".
- Instrukcja jak coś robić / workflow / lesson learned → type "skill_hint".
- Aktywny lub trwały kontekst projektu → type "project_context".
- Cytat, źródło, luźna referencja → type "reference".
- Jeśli brak materiału do zmian → zwróć { "brain_updates": [], "new_notes": [] }.
- NIE wymyślaj. Bazuj WYŁĄCZNIE na treści transcriptu i bieżącym brain.md.`;

const SAVE_SESSION_EN = `You are analysing a conversation transcript and the agent's current brain.md. Your task: propose new/important notes for brain/*.md. brain.md NO LONGER stores facts — the workflow rebuilds it automatically as a categorised index of links to files.

brain.md RULES:
- brain.md is a table of contents for brain/, not a store of facts.
- Fixed index sections (the headings are Polish on disk — do not translate them):
  - ## Bieżące — max 2-3 active projects/topics, as a link to a specific project_context note + 1 short sentence of description.
  - ## User — links to notes with facts about the user.
  - ## Preferencje — links to work rules/preferences.
  - ## Workflow — links to "how to use / how to do" notes.
  - ## Projekty i referencje — links to the remaining project contexts and references.
- Do NOT propose appending facts directly to brain.md.
- If the current session concerns an active project, propose a note of type project_context with a description that reads well as a single index line.
- If the session yields a durable lesson, propose a note of the right type: user, agent_rule, skill_hint, project_context or reference.
- The full conversation history goes to sessions/ + L1/L2/L3 — do NOT copy it into brain.md.

THE "NA TERAZ" SECTIONS (short-term memory at the top of brain.md):
- brain.md has two current-state sections: „Na teraz: User" (what the user is working on TODAY, their current state) and „Na teraz: Środowisko" (the current state of the project/vault/surroundings).
- These are SHORT, CHANGEABLE sentences (plain content bullets, NOT links, NOT durable facts). Durable things still go to new_notes — "na teraz" is only a momentary state.
- Propose updates based on the session: add[] = new current sentences; remove[] = sentences that have GONE STALE (give the text of the existing brain.md entry to remove).
- If nothing changed in a given section → leave the arrays empty. Do not duplicate what is already in „Na teraz".

REQUIRED OUTPUT (pure JSON, no markdown code fence):
{
  "brain_updates": [],
  "new_notes": [
    {
      "name": "memory_v3_index_rework",
      "description": "Rework of how facts are saved and indexed in brain.md and brain/.",
      "type": "project_context",
      "content": "The project is about changing Memory v3 so that brain.md is an index of categories and durable facts live in separate brain/*.md notes.",
      "why": "This is an active session topic and belongs in ## Bieżące through the brain.md index.",
      "how_to_apply": "Load this note when the conversation comes back to Memory v3, /save session, archiving projects or the brain.md index."
    }
  ],
  "na_teraz": {
    "user": { "add": ["The user is testing the Memory tab in the agent panel today"], "remove": [] },
    "environment": { "add": [], "remove": ["An old project state that is no longer current"] }
  }
}

Required fields:
- ALWAYS return "brain_updates": [].
- new_notes[].type ∈ { "user", "agent_rule", "skill_hint", "project_context", "reference" }.
- new_notes[].description must be one concrete line for the brain.md index.
- "na_teraz" is optional — omit it or return empty arrays if the current state has not changed.

DECISION RULES:
- If the user explicitly says "remember X" → new_notes.
- A fact about the user → type "user".
- A preference / a rule about how to work → type "agent_rule".
- An instruction how to do something / a workflow / a lesson learned → type "skill_hint".
- Active or durable project context → type "project_context".
- A quote, a source, a loose reference → type "reference".
- If there is no material for changes → return { "brain_updates": [], "new_notes": [] }.
- Do NOT make things up. Base this SOLELY on the transcript and the current brain.md.`;

const ARCHIVE_PL = `Analizujesz listę WSZYSTKICH notatek w brain/ aktualnego agenta. Twoje zadanie: zaproponować scalenia (merges) podobnych notatek + ewentualne usunięcia stale notatek.

CO TO JEST brain/:
- brain/*.md to TRWAŁA pamięć agenta — wiedza wielokrotnego użytku (np. "jak pisać posty na LinkedIn", "user ma 33 lata").
- Każda notatka ma frontmatter: name, description, type, created.
- Typy: user, agent_rule, skill_hint, project_context, reference.
- project_context zakończony nie jest kasowany w próżnię: po akceptacji workflow przenosi go do brain/archive/. Zanim zaproponujesz taki cleanup, upewnij się, że trwałe lekcje z projektu są już zachowane w user / agent_rule / skill_hint / reference albo w scalonej notatce.

KIEDY SCALAĆ:
- 2+ notatki mówią o TYM SAMYM temacie semantycznie (NIE wystarczy że mają podobny prefix filename).
- Notatki MUSZĄ być tego samego type (nie scalaj user + agent_rule, nawet jeśli o tej samej osobie).
- Jeśli treści są komplementarne (różne aspekty tej samej rzeczy) → scal.
- Jeśli treści to duplikat lub stara wersja → scal, biorąc świeższą/pełniejszą treść.

KIEDY NIE SCALAĆ:
- Notatki o RÓŻNYCH tematach choć podobnie nazwane (np. agent_rule_polski o stylu vs agent_rule_modele o nazewnictwie modeli — to OSOBNE reguły).
- Jeśli scalenie zniszczy konkretność (3 specyficzne reguły → ogólnik = strata).

KIEDY USUWAĆ (deletions):
- Notatka jest jawnie stale (np. dotyczy zakończonego projektu i nigdy więcej nie będzie odwołania).
- Notatka jest pusta lub bezsensowna.
- Dla project_context: proponuj deletion tylko jeśli projekt jest skończony i lekcje zostały wyciągnięte albo nie ma lekcji do zachowania. Workflow przeniesie taki plik do brain/archive/ zamiast indeksować go w brain.md.
- DOMYŚLNIE NIC nie usuwaj. Lepiej zachować niż skasować.

WYMAGANY OUTPUT (czysty JSON, bez markdown code-fence):
{
  "merges": [
    {
      "sources": ["user_kuba_wiek.md", "user_kuba_miejsce.md"],
      "target_name": "kuba_profil_podstawowy",
      "target_type": "user",
      "target_description": "Podstawowe fakty o userze (wiek, lokalizacja)",
      "target_why": "Dlaczego to scalenie ma sens",
      "target_how_to_apply": "Kiedy używać tej notatki",
      "merged_content": "User ma 33 lata. Mieszka w Polsce.",
      "why": "Dwie notatki o tej samej osobie, fakty komplementarne."
    }
  ],
  "deletions": [
    { "filename": "project_context_old_project.md", "why": "Projekt zakończony, a lekcje są już w skill_hint_memory_workflow.md.", "lessons_extracted": true }
  ]
}

ZASADY OUTPUTU:
- target_name BEZ prefixu typu (workflow doda automatycznie). "kuba_profil" NIE "user_kuba_profil".
- merged_content musi być CZYSTĄ TREŚCIĄ — bez YAML frontmatter, bez ---, bez separatorów. Workflow zbuduje frontmatter sam.
- merged_content jest TWOIM nowym tekstem — nie "klej" tekstów z source files, napisz spójną wersję.
- Jeśli nic do scalenia / usuwania → zwróć { "merges": [], "deletions": [] }.
- NIE wymyślaj. Bazuj WYŁĄCZNIE na treści notatek które dostałeś.`;

const ARCHIVE_EN = `You are analysing the list of ALL notes in the current agent's brain/. Your task: propose merges of similar notes + possibly deletions of stale notes.

WHAT brain/ IS:
- brain/*.md is the agent's DURABLE memory — reusable knowledge (e.g. "how to write LinkedIn posts", "the user is 33").
- Every note has frontmatter: name, description, type, created.
- Types: user, agent_rule, skill_hint, project_context, reference.
- A finished project_context is not deleted into the void: once accepted, the workflow moves it to brain/archive/. Before you propose such a cleanup, make sure the durable lessons from the project are already kept in user / agent_rule / skill_hint / reference or in the merged note.

WHEN TO MERGE:
- 2+ notes talk about THE SAME topic semantically (a similar filename prefix is NOT enough).
- The notes MUST be of the same type (do not merge user + agent_rule, even if they are about the same person).
- If the contents are complementary (different aspects of the same thing) → merge.
- If the content is a duplicate or an older version → merge, taking the fresher/fuller content.

WHEN NOT TO MERGE:
- Notes about DIFFERENT topics despite similar names (e.g. agent_rule_polski about style vs agent_rule_modele about model naming — these are SEPARATE rules).
- If merging would destroy specificity (3 specific rules → one generality = a loss).

WHEN TO DELETE (deletions):
- The note is plainly stale (e.g. it concerns a finished project and will never be referred to again).
- The note is empty or meaningless.
- For project_context: propose a deletion only if the project is finished and the lessons have been extracted, or there are no lessons to keep. The workflow will move such a file to brain/archive/ instead of indexing it in brain.md.
- By DEFAULT delete NOTHING. Better to keep than to erase.

REQUIRED OUTPUT (pure JSON, no markdown code fence):
{
  "merges": [
    {
      "sources": ["user_kuba_wiek.md", "user_kuba_miejsce.md"],
      "target_name": "kuba_profil_podstawowy",
      "target_type": "user",
      "target_description": "Basic facts about the user (age, location)",
      "target_why": "Why this merge makes sense",
      "target_how_to_apply": "When to use this note",
      "merged_content": "The user is 33. He lives in Poland.",
      "why": "Two notes about the same person, complementary facts."
    }
  ],
  "deletions": [
    { "filename": "project_context_old_project.md", "why": "The project is finished and the lessons are already in skill_hint_memory_workflow.md.", "lessons_extracted": true }
  ]
}

OUTPUT RULES:
- target_name WITHOUT the type prefix (the workflow adds it automatically). "kuba_profil" NOT "user_kuba_profil".
- merged_content must be PURE CONTENT — no YAML frontmatter, no ---, no separators. The workflow builds the frontmatter itself.
- merged_content is YOUR new text — do not "glue" the source files together, write one coherent version.
- If there is nothing to merge / delete → return { "merges": [], "deletions": [] }.
- Do NOT make things up. Base this SOLELY on the notes you were given.`;

const SUMMARY_PL = `Analizujesz N zarchiwizowanych dokumentów i syntetyzujesz je w jedno spójne podsumowanie poziomu {{LEVEL}}.

CO TO ZA POZIOMY (Memory v3 hierarchia konsolidacji):
- L1 — 5 sesji rozmów → ~300-500 słów. Wyciągasz: tematy, decyzje, ustalenia, postępy, otwarte sprawy. Bardzo konkretne.
- L2 — 5× L1 → ~500-800 słów. Wyciągasz: trendy, duże wzorce, długoterminowe ustalenia, jak ewoluowały tematy. Mniej detali, więcej syntezy.
- L3 — 5× L2 → ~800-1200 słów. Wyciągasz: strategiczne kierunki, ewolucja podejścia, fundamentalne zmiany. Czysta synteza.

ZASADY:
- Synteza, NIE konkatenacja. Wyciągnij to co ważne, pomiń detale techniczne.
- Strukturuj sekcje (markdown ## headers): Kluczowe tematy / Decyzje / Ustalenia / Otwarte sprawy / Wzorce (te które pasują do poziomu).
- Cytuj konkretne daty / liczby / nazwy jeśli to istotne dla zrozumienia kontekstu.
- Język: polski, konkretny, bez korpo, bez emoji spamu.
- {{LEVEL}} = oczekiwany poziom (L1 / L2 / L3) — DOSTOSUJ głębokość syntezy.

WYMAGANY OUTPUT (czysty Markdown, BEZ kodu typu \`\`\`, BEZ frontmatter):
[Tytuł 1 linia opisujący okres / temat] (np. "Tydzień testów pluginu + cleanup brain.md")

## Kluczowe tematy
[Lista 3-5 tematów z 1-2 zdaniami opisu każdy]

## Decyzje
[Lista decyzji z konkretnym kontekstem]

## Ustalenia (trwałe)
[Co zostało zalockowane na przyszłość]

## Otwarte sprawy
[Co zostało nierozwiązane / wymagało następnej sesji]

## Wzorce (opcjonalnie, gdy widać)
[Powtarzające się tematy / patterny pracy / blockers]

ZASADY DECYZYJNE:
- NIE wklejaj fragmentów dokumentów. Streszczasz, nie kopiujesz.
- NIE używaj fraz "User powiedział..." / "W sesji X..." — pisz syntetycznie ("Ustalono X", "Pojawia się wzorzec Y").
- Jeśli dokumenty są pustym placeholderem → zwróć krótkie "Pusty okres — brak treści do syntezy".`;

const SUMMARY_EN = `You are analysing N archived documents and synthesising them into one coherent {{LEVEL}} level summary.

WHAT THE LEVELS ARE (the Memory v3 consolidation hierarchy):
- L1 — 5 conversation sessions → ~300-500 words. You extract: topics, decisions, findings, progress, open matters. Very concrete.
- L2 — 5× L1 → ~500-800 words. You extract: trends, big patterns, long-term findings, how the topics evolved. Fewer details, more synthesis.
- L3 — 5× L2 → ~800-1200 words. You extract: strategic directions, how the approach evolved, fundamental changes. Pure synthesis.

RULES:
- Synthesis, NOT concatenation. Pull out what matters, skip the technical details.
- Structure it in sections (markdown ## headers): Key topics / Decisions / Findings / Open matters / Patterns (the ones that fit the level).
- Quote concrete dates / numbers / names if they matter for understanding the context.
- Language: English, concrete, no corporate speak, no emoji spam.
- {{LEVEL}} = the expected level (L1 / L2 / L3) — ADJUST the depth of the synthesis.

REQUIRED OUTPUT (pure Markdown, NO code blocks like \`\`\`, NO frontmatter):
[A 1-line title describing the period / topic] (e.g. "A week of plugin testing + brain.md cleanup")

## Key topics
[A list of 3-5 topics with 1-2 sentences of description each]

## Decisions
[A list of decisions with concrete context]

## Findings (durable)
[What has been locked in for the future]

## Open matters
[What was left unresolved / needed another session]

## Patterns (optional, when visible)
[Recurring topics / work patterns / blockers]

DECISION RULES:
- Do NOT paste fragments of the documents. You summarise, you do not copy.
- Do NOT use phrases like "The user said..." / "In session X..." — write synthetically ("X was established", "A pattern Y is emerging").
- If the documents are an empty placeholder → return a short "Empty period — nothing to synthesise".`;

/**
 * Teksty fabryczne per rodzaj i język. NIE eksportowane — wołacz bierze je przez
 * `factoryWorkPrompt()`, żeby nie dało się przez przypadek zamrozić języka w stałej.
 */
const FACTORY_WORK_PROMPTS: Record<WorkPromptKind, { pl: string; en: string }> = {
    save_session: { pl: SAVE_SESSION_PL, en: SAVE_SESSION_EN },
    archive: { pl: ARCHIVE_PL, en: ARCHIVE_EN },
    summary: { pl: SUMMARY_PL, en: SUMMARY_EN },
};

/**
 * Fabryczny prompt roboczy w podanym języku (domyślnie: bieżący język interfejsu).
 * Nieznany kod języka = angielski, dokładnie jak `t()` w `core/i18n`.
 *
 * ⚠️ Wołaj to W MOMENCIE UŻYCIA (resolver, render Ustawień), nie przy imporcie modułu —
 * `setLocale()` leci dopiero z `src/main.ts`.
 */
export function factoryWorkPrompt(kind: WorkPromptKind, locale: string = getLocale()): string {
    return FACTORY_WORK_PROMPTS[kind][locale === 'pl' ? 'pl' : 'en'];
}

// DEFAULT_BRIEF_PROMPT WYCIĘTY stąd razem ze slotem w Settings→Prompt (modules/shell/
// prompt_settings.ts) i z WORK_PROMPT_KEYS (core/utils/workPromptResolver.ts). Konsument
// (ContextSessionGenerator) skasowany - od tego momentu wartość slotu nie miała ani jednego
// czytelnika, mimo że kontrolka w Ustawieniach dalej obiecywała działanie w czasie
// teraźniejszym. Osierocona wartość promptDefaults.brief_prompt w settings.json usera jest
// nieszkodliwa - nikt jej już nie czyta.
//
// DEFAULT_SAVE_SESSION_PROMPT / DEFAULT_ARCHIVE_PROMPT / DEFAULT_SUMMARY_PROMPT ZASTĄPIONE
// funkcją `factoryWorkPrompt(kind)` (2.2.5). Stała nie umie być leniwa, a tekst policzony przy
// imporcie zamroziłby jeden język - patrz nagłówek pliku.
