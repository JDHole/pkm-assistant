/**
 * Factory sub-agent task frame — sub-agents domain.
 *
 * The FIXED scaffolding of a sub-agent's system prompt (thin template): header, the
 * "pull memory" hint, and the shared rules. The mechanical, per-task sections (the custom method
 * from KNOWLEDGE.md, SCOPE from config, BUDGET from limits) are still composed in code and injected
 * into the placeholders. Resolved via the agent>global>factory chain (`resolveWorkPrompt`), so a
 * user can reshape the frame globally (Settings→Prompt) or per parent agent.
 *
 * ⚠️ JĘZYK INTERFEJSU, LICZONY LENIWIE (2.2.5). Wołacz bierze tekst przez
 * `defaultSubAgentFramePrompt()`, NIGDY ze stałej — `setLocale()` leci z `src/main.ts` PO
 * załadowaniu modułów, więc stała wybrana przy imporcie zamroziłaby jeden język. Bloki
 * wstrzykiwane w `{{METHOD}}`/`{{SCOPE}}`/`{{BUDGET}}` idą przez klucze `subagent.frame.*`
 * w i18n (skleja je `SubAgentRunner._buildTaskPrompt`, raz na bieg).
 *
 * ADRESY, które NIE tłumaczą się razem z prozą (identyczne w obu językach):
 *  - nazwy narzędzi `search`/`read`/`list`, `delegate`/`agent_delegate`,
 *  - literal argumentu `scope="memory"`,
 *  - nagłówek `SCOPE:` (już angielski) — `BUDŻET:`/`BUDGET:` NIE jest adresem, nic go nie parsuje.
 * Nic w kodzie nie parsuje treści tej ramy ani odpowiedzi suba po tekście: status biegu liczy
 * `toolResultStatus` (flagi `isError`/`success`, `core/utils/toolResultStatus.ts`), nie napisy.
 *
 * Placeholders (filled by SubAgentRunner._buildTaskPrompt):
 *  - {{SUB_NAME}}    — config.name
 *  - {{AGENT_NAME}}  — parent agent name
 *  - {{DESCRIPTION}} — config.description (albo `subagent.frame.default_description`)
 *  - {{METHOD}}      — config.prompt (custom method, soft-capped) or empty
 *  - {{SCOPE}}       — SCOPE block when config.scope is set, else empty
 *  - {{BUDGET}}      — BUDGET block (iterations + max tool result size)
 */
import { getLocale } from '../../core/i18n/index.js';

const FRAME_PL = `Jesteś sub-agentem "{{SUB_NAME}}" agenta {{AGENT_NAME}} — wyspecjalizowana wersja agenta na dedykowanym modelu AI. Wykonaj zadanie i zwróć zwięzły wynik dla agenta.
Twoja specjalizacja: {{DESCRIPTION}}
{{METHOD}}
PAMIĘĆ AGENTA: jeśli potrzebujesz wiedzy swojego agenta, użyj search/read/list ze scope="memory" (czytasz pamięć własnego agenta). Istotny fragment możesz też dostać w treści zadania.
{{SCOPE}}{{BUDGET}}
ZASADY:
1. Wykonaj zadanie DOKŁADNIE — nie wymyślaj faktów.
2. Zwróć zwięzły, konkretny wynik; jeśli czegoś nie znalazłeś, napisz wprost.
3. Cytuj ścieżki źródeł, z których korzystałeś.
4. Twoim zleceniodawcą jest agent, nie user.`;

const FRAME_EN = `You are the sub-agent "{{SUB_NAME}}" of agent {{AGENT_NAME}} — a specialised version of the agent running on a dedicated AI model. Carry out the task and return a concise result for the agent.
Your speciality: {{DESCRIPTION}}
{{METHOD}}
AGENT MEMORY: if you need your agent's knowledge, use search/read/list with scope="memory" (you read your own agent's memory). A relevant excerpt can also reach you in the task content.
{{SCOPE}}{{BUDGET}}
RULES:
1. Carry out the task EXACTLY — do not invent facts.
2. Return a concise, concrete result; if you did not find something, say so plainly.
3. Quote the paths of the sources you used.
4. Your client is the agent, not the user.`;

const SUBAGENT_FRAME_PROMPTS = { pl: FRAME_PL, en: FRAME_EN };

/**
 * Fabryczna rama zadania sub-agenta w podanym języku (domyślnie: bieżący język interfejsu).
 * Nieznany kod języka = angielski, dokładnie jak `t()` w `core/i18n`.
 *
 * ⚠️ Wołaj W MOMENCIE UŻYCIA (`SubAgentRunner._buildTaskPrompt` - raz na bieg, render
 * Ustawień → Prompt), nie przy imporcie modułu. `DEFAULT_SUBAGENT_FRAME_PROMPT` skasowany:
 * stała nie umie być leniwa.
 */
export function defaultSubAgentFramePrompt(locale: string = getLocale()): string {
    return SUBAGENT_FRAME_PROMPTS[locale === 'pl' ? 'pl' : 'en'];
}
