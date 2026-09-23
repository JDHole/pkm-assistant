/**
 * config/default_prompts.js — fabryczne szkielety promptów
 *
 * Czyste stałe tekstowe promptów, których potrzebuje więcej niż jeden moduł. Mieszkają tu,
 * bo `modules/shell` (Settings→Prompt) musi je pokazać, a nie ma powodu, żeby ciągnąć w tym
 * celu cały barrel modułu, który je konsumuje.
 *
 * ZERO importów z `obsidian` ani z modułów — czysty config, w pełni testowalny node'em.
 * Jedyny import to `core/i18n` (oficjalny wyjątek deep-importu, node-safe) po to, żeby szkielet
 * szedł za językiem interfejsu. Importowany BEZPOŚREDNIO (jak `config/default_settings.js` /
 * `config/limits.js`).
 */
import { getLocale } from '../core/i18n/index.js';

// Kontraktowy sentinel bloku kandydatów pamięci. Kanoniczna definicja (i parser) żyje
// w `modules/chat/chat/memoryCandidates.js` — tutaj powtórzona świadomie, żeby config
// został liściem grafu importów. Przed rozjazdem broni test
// `modules/chat/chat/compressionPrompt.test.js` (sprawdza, że szkielet zawiera sentinel
// zaimportowany z parsera).
const MEMORY_CANDIDATES_SENTINEL = '===MEMORY_CANDIDATES===';

/**
 * Factory compression prompt skeleton — chat domain.
 *
 * This is the STATIC instruction skeleton for context-window compaction (Summarizer). The dynamic
 * pieces (previous summary, brain index, user messages, tool names, task context, the conversation
 * itself, the emergency section, the session-path footer) are composed in code and injected into
 * the placeholders below. Only the fixed instructions live here so the whole skeleton can be
 * overridden globally (Settings→Prompt) or per-agent without re-implementing the assembly.
 *
 * ⚠️ JĘZYK INTERFEJSU, LICZONY LENIWIE (2.2.5). Wołacz bierze tekst przez
 * `defaultCompressionPrompt()`, NIGDY ze stałej — `setLocale()` leci z `src/main.ts` PO
 * załadowaniu modułów, więc stała wybrana przy imporcie zamroziłaby jeden język. Dynamiczna
 * główka wstrzykiwana w `{{DYNAMIC_HEADER}}` idzie przez `summarizer.*` w i18n, a numeracja
 * sekcji (1-8 tutaj, „## 9." w sekcji awaryjnej) musi zgadzać się w OBU językach.
 *
 * CONTRACT: the `===MEMORY_CANDIDATES===` sentinel + fenced ```json block MUST survive any override
 * AND any translation — `parseMemoryCandidates` (memoryCandidates.js) splits the durable-memory
 * rescue block off the summary. Settings→Prompt warns the user about this next to the field.
 *
 * Placeholders (filled by Summarizer.getSummaryPrompt):
 *  - {{DYNAMIC_HEADER}}    — emergency warning + previous summary + brain index + user messages + tools + task context
 *  - {{CONVERSATION}}      — the transcript to compress
 *  - {{EMERGENCY_SECTION}} — the extra "## 9" task-in-progress section (empty on a normal soft compaction)
 *  - {{SESSION_PATH}}      — footer pointing to the saved session file (empty when unknown)
 */
const COMPRESSION_PL = `Jesteś systemem kompresji kontekstu rozmowy AI asystenta. Twoim celem jest stworzenie STRUKTURALNEGO podsumowania, które pozwoli agentowi kontynuować pracę bez utraty kontekstu.
{{DYNAMIC_HEADER}}
ROZMOWA DO SKOMPRESOWANIA:
{{CONVERSATION}}

STWÓRZ STRUKTURALNE PODSUMOWANIE w poniższym formacie. Każda sekcja jest opcjonalna - pomiń jeśli nie dotyczy.

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
- Maks ~800 słów (proporcjonalnie do ilości treści - krótka rozmowa = krótsze podsumowanie)
- ZACHOWAJ konkretne nazwy plików, zmiennych, funkcji - agent ich potrzebuje
- ZACHOWAJ treść wiadomości usera (agent musi wiedzieć co user powiedział)
- Jeśli jest POPRZEDNIE PODSUMOWANIE - rozszerzaj je o nowe informacje, nie powtarzaj tego samego
- Pomiń: pozdrowienia, small talk, powtórzenia, parametry tool calli (zachowaj WYNIK)

═══ PAMIĘĆ DŁUGOTERMINOWA (opcjonalnie) ═══
Rozmowa zaraz zniknie z kontekstu. Jeśli pojawiło się w niej COŚ TRWAŁEGO wartego zapamiętania na przyszłość, dopisz na SAMYM KOŃCU odpowiedzi (po podsumowaniu) blok kandydatów. Bramka istotności - zapisuj TYLKO:
- trwałe fakty/preferencje usera,
- reguły współpracy,
- korekty od usera ("nie tak, rób X"),
- kontekst projektu wart >1 sesji.
NIE zapisuj: jednorazowych detali tego zadania, rzeczy które już są w PAMIĘCI DŁUGOTERMINOWEJ powyżej (nie duplikuj), spekulacji. Zero kandydatów to normalne - nie wymyślaj na siłę. Maks 3.

Format bloku (DOKŁADNIE tak, tylko jeśli masz kandydatów; pomiń całość jeśli zero):
${MEMORY_CANDIDATES_SENTINEL}
\`\`\`json
{"memory_candidates": [{"name": "krótka nazwa", "description": "jedno zdanie", "type": "user|agent_rule|skill_hint|project_context|reference", "content": "co zapamiętać", "why": "dlaczego trwałe", "how_to_apply": "kiedy użyć"}]}
\`\`\`

PODSUMOWANIE:{{SESSION_PATH}}`;

const COMPRESSION_EN = `You are a context-compression system for an AI assistant's conversation. Your goal is to produce a STRUCTURAL summary that lets the agent carry on working without losing context.
{{DYNAMIC_HEADER}}
CONVERSATION TO COMPRESS:
{{CONVERSATION}}

CREATE A STRUCTURAL SUMMARY in the format below. Every section is optional - skip it if it does not apply.

## 1. Goal of the conversation
What does the user want to achieve? The main topic/task. (1-2 sentences)

## 2. Course of events (chronologically)
What happened step by step. Key moments, decisions, turning points. (bullets)

## 3. User messages
Keep the CONTENT of the user's key messages (paraphrase or quote). The user may refer back to them. (numbered)

## 4. Files and tools
Which files were read/created/edited? Which tools were used and with what result? (bullets)

## 5. Problems and solutions
What did not work? What errors? How were they fixed? (bullets, only if there were any)

## 6. Findings and decisions
Key decisions taken in the conversation. "We decided that...", "The user wants...", "We chose..." (bullets)

## 7. Current state of the work
What has been done? What is in progress? What was the agent doing right before the compression? (a description of the state)

## 8. Open threads
What is still to be done? Unresolved questions? Next steps? (bullets, only if there are any)
{{EMERGENCY_SECTION}}
RULES:
- In English
- Max ~800 words (proportional to the amount of content - a short conversation = a shorter summary)
- KEEP concrete names of files, variables, functions - the agent needs them
- KEEP the content of the user's messages (the agent has to know what the user said)
- If there is a PREVIOUS SUMMARY - extend it with the new information, do not repeat the same things
- Skip: greetings, small talk, repetitions, tool-call parameters (keep the RESULT)

═══ LONG-TERM MEMORY (optional) ═══
The conversation is about to disappear from the context. If anything DURABLE worth remembering for the future came up in it, append a block of candidates at the VERY END of your answer (after the summary). Relevance gate - save ONLY:
- durable facts/preferences of the user,
- rules of cooperation,
- corrections from the user ("no, do X instead"),
- project context worth >1 session.
Do NOT save: one-off details of this task, things already in the LONG-TERM MEMORY above (do not duplicate), speculation. Zero candidates is normal - do not force it. Max 3.

Block format (EXACTLY like this, only if you have candidates; skip the whole thing if zero):
${MEMORY_CANDIDATES_SENTINEL}
\`\`\`json
{"memory_candidates": [{"name": "short name", "description": "one sentence", "type": "user|agent_rule|skill_hint|project_context|reference", "content": "what to remember", "why": "why it is durable", "how_to_apply": "when to use it"}]}
\`\`\`

SUMMARY:{{SESSION_PATH}}`;

const COMPRESSION_PROMPTS = { pl: COMPRESSION_PL, en: COMPRESSION_EN };

/**
 * Fabryczny szkielet kompresji w podanym języku (domyślnie: bieżący język interfejsu).
 * Nieznany kod języka = angielski, dokładnie jak `t()` w `core/i18n`.
 *
 * ⚠️ Wołaj W MOMENCIE UŻYCIA (`Summarizer.getSummaryPrompt`, resolver w `turnOwner`, render
 * Ustawień), nie przy imporcie modułu — patrz komentarz przy szkieletach wyżej.
 */
export function defaultCompressionPrompt(locale: string = getLocale()): string {
    return COMPRESSION_PROMPTS[locale === 'pl' ? 'pl' : 'en'];
}
