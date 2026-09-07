/**
 * Factory work-prompts owned by the memory module (E2.8 B3).
 *
 * These are the built-in defaults for the memory workflows. They are resolved through the
 * agent > global (Settings→Prompt) > factory chain via `resolveWorkPrompt` (core), so a fresh
 * agent (empty per-agent prompt) still gets a working LLM path.
 *
 * - DEFAULT_SAVE_SESSION_PROMPT — /save session (transcript → new brain/ notes; brain.md is rebuilt as an index)
 * - DEFAULT_ARCHIVE_PROMPT      — ArchiveWorkflow Phase 1 dedup (notes list → merges + deletions)
 * - DEFAULT_SUMMARY_PROMPT      — ArchiveWorkflow Phase 2/3/4 (L1/L2/L3 docs → 1 synthetic summary; {{LEVEL}} token)
 *
 * AUD-dead-code-124 (2026-09-02): DEFAULT_BRIEF_PROMPT WYCIĘTY (zero czytelników od skasowania
 * ContextSessionGenerator w E2.9 D) — patrz komentarz przy dawnym miejscu stałej na końcu pliku.
 *
 * CONTRACT: workflows parse the shape these produce. Overrides (global/agent) MUST keep the same
 * output structure — DEFAULT_ARCHIVE_PROMPT's JSON keys, DEFAULT_SUMMARY_PROMPT's {{LEVEL}} token,
 * DEFAULT_SAVE_SESSION_PROMPT's new_notes JSON. Settings→Prompt warns about this next to each field.
 * (Moved here from modules/agents/archetypes/savePrompts.js so the workflows own their defaults
 * without a memory→agents import cycle.)
 */
export const DEFAULT_SAVE_SESSION_PROMPT = `Analizujesz transcript rozmowy i bieżący brain.md agenta. Twoje zadanie: zaproponować nowe/ważne notatki do brain/*.md. brain.md NIE przechowuje już faktów — workflow przebuduje go automatycznie jako kategoryzowany indeks linków do plików.

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
    "user": { "add": ["Kuba testuje dziś zakładkę Pamięć w panelu agenta"], "remove": [] },
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

export const DEFAULT_ARCHIVE_PROMPT = `Analizujesz listę WSZYSTKICH notatek w brain/ aktualnego agenta. Twoje zadanie: zaproponować scalenia (merges) podobnych notatek + ewentualne usunięcia stale notatek.

CO TO JEST brain/:
- brain/*.md to TRWAŁA pamięć agenta — wiedza wielokrotnego użytku (np. "jak pisać posty na LinkedIn", "Kuba ma 33 lata").
- Każda notatka ma frontmatter: name, description, type, created.
- Typy: user, agent_rule, skill_hint, project_context, reference.
- project_context zakończony nie jest kasowany w próżnię: po akceptacji workflow przenosi go do brain/archive/. Zanim zaproponujesz taki cleanup, upewnij się, że trwałe lekcje z projektu są już zachowane w user / agent_rule / skill_hint / reference albo w scalonej notatce.

KIEDY SCALAĆ:
- 2+ notatki mówią o TYM SAMYM temacie semantycznie (NIE wystarczy że mają podobny prefix filename).
- Notatki MUSZĄ być tego samego type (nie scalaj user + agent_rule, nawet jeśli o "Kubie").
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
      "target_description": "Podstawowe fakty o Kubie (wiek, lokalizacja)",
      "target_why": "Dlaczego to scalenie ma sens",
      "target_how_to_apply": "Kiedy używać tej notatki",
      "merged_content": "Kuba ma 33 lata. Mieszka w Polsce.",
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

export const DEFAULT_SUMMARY_PROMPT = `Analizujesz N zarchiwizowanych dokumentów i syntetyzujesz je w jedno spójne podsumowanie poziomu {{LEVEL}}.

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

// AUD-dead-code-124 (2026-09-02): DEFAULT_BRIEF_PROMPT WYCIĘTY stąd razem ze slotem w
// Settings→Prompt (modules/shell/prompt_settings.ts) i z WORK_PROMPT_KEYS (core/utils/
// workPromptResolver.ts). Konsument (ContextSessionGenerator) skasowany w E2.9 fazie D — od tego
// momentu wartość slotu nie miała ani jednego czytelnika, mimo że kontrolka w Ustawieniach dalej
// obiecywała działanie w czasie teraźniejszym. Wzór kasacji: keepRecentSessions/l3Threshold
// (S32 Z6/Z1b). Osierocona wartość promptDefaults.brief_prompt w settings.json usera jest
// nieszkodliwa — nikt jej już nie czyta.
