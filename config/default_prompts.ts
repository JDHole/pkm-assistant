/**
 * config/default_prompts.js — fabryczne szkielety promptów (S31, 2026-07-30)
 *
 * Czyste stałe tekstowe promptów, których potrzebuje więcej niż jeden moduł. Mieszkają tu,
 * bo `modules/shell` (Settings→Prompt) musi je pokazać, a nie ma powodu, żeby ciągnąć w tym
 * celu cały barrel modułu, który je konsumuje (krawędź shell→chat przecięta w S31).
 *
 * ZERO importów z `obsidian` ani z modułów — czysty config, w pełni testowalny node'em.
 * Importowany BEZPOŚREDNIO (jak `config/default_settings.js` / `config/limits.js`).
 */

// Kontraktowy sentinel bloku kandydatów pamięci. Kanoniczna definicja (i parser) żyje
// w `modules/chat/chat/memoryCandidates.js` — tutaj powtórzona świadomie, żeby config
// został liściem grafu importów. Przed rozjazdem broni test
// `modules/chat/chat/compressionPrompt.test.js` (sprawdza, że szkielet zawiera sentinel
// zaimportowany z parsera).
const MEMORY_CANDIDATES_SENTINEL = '===MEMORY_CANDIDATES===';

/**
 * Factory compression prompt skeleton (E2.8 B3) — chat domain.
 *
 * This is the STATIC instruction skeleton for context-window compaction (Summarizer). The dynamic
 * pieces (previous summary, brain index, user messages, tool names, task context, the conversation
 * itself, the emergency section, the session-path footer) are composed in code and injected into
 * the placeholders below. Only the fixed instructions live here so the whole skeleton can be
 * overridden globally (Settings→Prompt) or per-agent without re-implementing the assembly.
 *
 * CONTRACT: the `===MEMORY_CANDIDATES===` sentinel + fenced ```json block MUST survive any override
 * — `parseMemoryCandidates` (memoryCandidates.js) splits the durable-memory rescue block off the
 * summary. Settings→Prompt warns the user about this next to the field.
 *
 * Placeholders (filled by Summarizer.getSummaryPrompt):
 *  - {{DYNAMIC_HEADER}}    — emergency warning + previous summary + brain index + user messages + tools + task context
 *  - {{CONVERSATION}}      — the transcript to compress
 *  - {{EMERGENCY_SECTION}} — the extra "## 9 zadanie w toku" section (empty on a normal soft compaction)
 *  - {{SESSION_PATH}}      — footer pointing to the saved session file (empty when unknown)
 */
export const DEFAULT_COMPRESSION_PROMPT = `Jesteś systemem kompresji kontekstu rozmowy AI asystenta. Twoim celem jest stworzenie STRUKTURALNEGO podsumowania, które pozwoli agentowi kontynuować pracę bez utraty kontekstu.
{{DYNAMIC_HEADER}}
ROZMOWA DO SKOMPRESOWANIA:
{{CONVERSATION}}

STWÓRZ STRUKTURALNE PODSUMOWANIE w poniższym formacie. Każda sekcja jest opcjonalna — pomiń jeśli nie dotyczy.

## 1. Cel rozmowy
Co user chce osiągnąć? Główny temat/zadanie. (1-2 zdania)

## 2. Przebieg (chronologicznie)
Co się wydarzyło krok po kroku. Kluczowe momenty, decyzje, zwroty akcji. (punkty)

## 3. Wiadomości usera
Zachowaj TREŚĆ kluczowych wiadomości usera (parafrazuj lub cytuj). User może się do nich odwoływać. (numerowane)

## 4. Pliki i narzędzia
Jakie pliki czytano/tworzono/edytowano? Jakie narzędzia użyto i z jakim skutkiem? (punkty)

## 5. Problemy i rozwiązania
Co nie działało? Jakie errory? Jak je naprawiono? (punkty, tylko jeśli były)

## 6. Ustalenia i decyzje
Kluczowe decyzje podjęte w rozmowie. "Postanowiliśmy że...", "User chce...", "Wybraliśmy..." (punkty)

## 7. Aktualny stan pracy
Co zostało zrobione? Co jest w toku? Co agent robił tuż przed kompresją? (opis stanu)

## 8. Otwarte wątki
Co jeszcze do zrobienia? Nierozwiązane kwestie? Następne kroki? (punkty, tylko jeśli są)
{{EMERGENCY_SECTION}}
ZASADY:
- Po polsku
- Maks ~800 słów (proporcjonalnie do ilości treści — krótka rozmowa = krótsze podsumowanie)
- ZACHOWAJ konkretne nazwy plików, zmiennych, funkcji — agent ich potrzebuje
- ZACHOWAJ treść wiadomości usera (agent musi wiedzieć co user powiedział)
- Jeśli jest POPRZEDNIE PODSUMOWANIE — rozszerzaj je o nowe informacje, nie powtarzaj tego samego
- Pomiń: pozdrowienia, small talk, powtórzenia, parametry tool calli (zachowaj WYNIK)

═══ PAMIĘĆ DŁUGOTERMINOWA (opcjonalnie) ═══
Rozmowa zaraz zniknie z kontekstu. Jeśli pojawiło się w niej COŚ TRWAŁEGO wartego zapamiętania na przyszłość, dopisz na SAMYM KOŃCU odpowiedzi (po podsumowaniu) blok kandydatów. Bramka istotności — zapisuj TYLKO:
- trwałe fakty/preferencje usera,
- reguły współpracy,
- korekty od usera ("nie tak, rób X"),
- kontekst projektu wart >1 sesji.
NIE zapisuj: jednorazowych detali tego zadania, rzeczy które już są w PAMIĘCI DŁUGOTERMINOWEJ powyżej (nie duplikuj), spekulacji. Zero kandydatów to normalne — nie wymyślaj na siłę. Maks 3.

Format bloku (DOKŁADNIE tak, tylko jeśli masz kandydatów; pomiń całość jeśli zero):
${MEMORY_CANDIDATES_SENTINEL}
\`\`\`json
{"memory_candidates": [{"name": "krótka nazwa", "description": "jedno zdanie", "type": "user|agent_rule|skill_hint|project_context|reference", "content": "co zapamiętać", "why": "dlaczego trwałe", "how_to_apply": "kiedy użyć"}]}
\`\`\`

PODSUMOWANIE:{{SESSION_PATH}}`;
