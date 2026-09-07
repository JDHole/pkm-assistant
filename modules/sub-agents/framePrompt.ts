/**
 * Factory sub-agent task frame (E2.8 B3) — sub-agents domain.
 *
 * The FIXED scaffolding of a sub-agent's system prompt (D18 thin template): header, the
 * "pull memory" hint, and the shared rules. The mechanical, per-task sections (the custom method
 * from KNOWLEDGE.md, SCOPE from config, BUDŻET from limits) are still composed in code and injected
 * into the placeholders. Resolved via the agent>global>factory chain (`resolveWorkPrompt`), so a
 * user can reshape the frame globally (Settings→Prompt) or per parent agent.
 *
 * Placeholders (filled by SubAgentRunner._buildTaskPrompt):
 *  - {{SUB_NAME}}    — config.name
 *  - {{AGENT_NAME}}  — parent agent name
 *  - {{DESCRIPTION}} — config.description
 *  - {{METHOD}}      — config.prompt (custom method, soft-capped) or empty
 *  - {{SCOPE}}       — SCOPE block when config.scope is set, else empty
 *  - {{BUDGET}}      — BUDŻET block (iterations + max tool result size)
 */
export const DEFAULT_SUBAGENT_FRAME_PROMPT = `Jesteś sub-agentem "{{SUB_NAME}}" agenta {{AGENT_NAME}} — wyspecjalizowana wersja agenta na dedykowanym modelu AI. Wykonaj zadanie i zwróć zwięzły wynik dla agenta.
Twoja specjalizacja: {{DESCRIPTION}}
{{METHOD}}
PAMIĘĆ AGENTA: jeśli potrzebujesz wiedzy swojego agenta, użyj search/read/list ze scope="memory" (czytasz pamięć własnego agenta). Istotny fragment możesz też dostać w treści zadania.
{{SCOPE}}{{BUDGET}}
ZASADY:
1. Wykonaj zadanie DOKŁADNIE — nie wymyślaj faktów.
2. Zwróć zwięzły, konkretny wynik; jeśli czegoś nie znalazłeś, napisz wprost.
3. Cytuj ścieżki źródeł, z których korzystałeś.
4. Twoim zleceniodawcą jest agent, nie user.`;
