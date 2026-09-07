/**
 * Generator promptu startowego (S32 Z1a — wisienka faza E z E2.8).
 *
 * Świeży agent ma PUSTE pole Osobowość i nie wiadomo od czego zacząć. Ten plik składa
 * z trzech prostych odpowiedzi (kim jest / jak mówi / czego unika) gotowy akapitowy tekst
 * do wklejenia w Personę. Zero magii, zero LLM-a — czysta składanka szablonów z i18n.
 *
 * Plik jest CZYSTY (bez `obsidian`, bez DOM) i dlatego testowalny w AVA. Modal, który go
 * używa, żyje obok w `StartPromptGeneratorModal.js`.
 *
 * ⚠️ Wynik to markdown-light: same akapity + lista zasad. ŻADNYCH nagłówków `#` — tekst
 * ląduje w `personality`, a PromptBuilder wkłada go w sekcję „KIM JESTEM" i własne nagłówki
 * by się z nim pobiły.
 */

/**
 * Pięć tonów wypowiedzi. `labelKey` = etykieta w dropdownie, `phraseKey` = FRAZA OPISOWA
 * wstawiana do składanego tekstu (nie nazwa tonu — model ma dostać opis zachowania,
 * nie kategorię z UI).
 */
export const TONE_OPTIONS = [
    { id: 'matter_of_fact', labelKey: 'profile.start_prompt.tone_matter_of_fact', phraseKey: 'profile.start_prompt.tone_matter_of_fact_phrase' },
    { id: 'friendly',       labelKey: 'profile.start_prompt.tone_friendly',       phraseKey: 'profile.start_prompt.tone_friendly_phrase' },
    { id: 'mentor',         labelKey: 'profile.start_prompt.tone_mentor',         phraseKey: 'profile.start_prompt.tone_mentor_phrase' },
    { id: 'concise',        labelKey: 'profile.start_prompt.tone_concise',        phraseKey: 'profile.start_prompt.tone_concise_phrase' },
    { id: 'enthusiastic',   labelKey: 'profile.start_prompt.tone_enthusiastic',   phraseKey: 'profile.start_prompt.tone_enthusiastic_phrase' },
];

export interface StartPromptAnswers {
    role?: string;
    tone?: string;
    rules?: string;
}

export type StartPromptTranslate = (key: string, params?: Record<string, string>) => string;

/** Znajdź definicję tonu po id (nieznany/pusty → null, sekcja tonu wypada z tekstu). */
export function getToneOption(id: string | undefined) {
    return TONE_OPTIONS.find(opt => opt.id === id) || null;
}

/**
 * Złóż tekst Osobowości z trzech pól. Puste pole = sekcja pomijana (bez pustych zdań
 * typu „Jesteś .").
 *
 * @param {{role?: string, tone?: string, rules?: string}} answers
 *   `role` — kim jest agent (jedno zdanie), `tone` — id z `TONE_OPTIONS`,
 *   `rules` — zasady, jedna na linię (myślniki na początku są tolerowane i zdejmowane).
 * @param {(key: string, params?: Object) => string} [translate] - funkcja `t` (wstrzykiwana,
 *   żeby plik nie zależał od i18n i dał się testować bez ładowania słowników).
 * @returns {string} gotowy tekst (pusty string, gdy wszystkie pola puste)
 */
export function buildStartPrompt(answers: StartPromptAnswers = {}, translate?: StartPromptTranslate) {
    const tr: StartPromptTranslate = typeof translate === 'function' ? translate : (key: string) => key;
    const parts: string[] = [];

    const role = String(answers.role || '').replace(/\s+/g, ' ').trim();
    if (role) parts.push(tr('profile.start_prompt.tpl_who', { role: stripTrailingDot(role) }));

    const tone = getToneOption(answers.tone);
    if (tone) parts.push(tr('profile.start_prompt.tpl_tone', { tone: tr(tone.phraseKey) }));

    const ruleLines = parseRuleLines(answers.rules);
    if (ruleLines.length > 0) {
        parts.push([tr('profile.start_prompt.tpl_rules'), ...ruleLines.map(line => `- ${line}`)].join('\n'));
    }

    return parts.join('\n\n');
}

/** Zasady: jedna na linię, bez pustych, bez wiodących myślników/gwiazdek/kropek listy. */
function parseRuleLines(rules: string | undefined) {
    return String(rules || '')
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

/** „Jesteś archiwistą." — nie „Jesteś archiwistą.." gdy user sam postawił kropkę. */
function stripTrailingDot(text: string) {
    return text.replace(/[.。]+$/, '');
}
