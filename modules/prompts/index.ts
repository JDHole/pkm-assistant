/**
 * modules/prompts — publiczne API budowania system prompta agenta.
 *
 * To są JEDYNE drzwi na zewnątrz modułu. Reszta pluginu importuje stąd, nie z bebechów.
 * Szczegóły: CLAUDE.md w tym folderze.
 *
 * Decision Tree v2.1: 7 grup × 25 instrukcji, 3-warstwowe override (factory < global < agent).
 * Skład promptu: A → B → C → D (E2.3 D21: sekcja ★TRYB PRACY usunięta wraz z trybami Gadaj/Rób).
 */

// Klasa główna — buduje system prompt dla agenta + sub-agenta
export { PromptBuilder } from './PromptBuilder.js';
export type { PromptSkill } from './skillIndex.js';
export type { DecisionTreeOverride, DecisionTreeOverrides, DecisionTreeRule } from './decisionTree.js';

// Stałe (factory defaults + decision tree) — źródło UI overridów w profilu agenta.
// S30 Z4: `TOOL_GROUPS` OUT z barrela — jedyny dawny konsument
// (`modules/onboarding/PlaybookManager.js`, sekcja „Narzędzia") zniknął razem
// z kasacją Playbook Buildera w E2.8 A4. Fabryka dead-code D7 (AUD-dead-code-076):
// `TOOL_GROUPS` w ogóle SKASOWANY z `PromptBuilder.ts` — nie miał już żadnego czytelnika
// (nawet wewnątrz modułu) i rozjechał się z żywą `BUILTIN_TOOL_GROUPS`
// (`modules/agents/toolAxis.ts`, SSOT osi uprawnień).
export {
  FACTORY_DEFAULTS,
  DECISION_TREE_GROUPS,
  DECISION_TREE_DEFAULTS,
} from './PromptBuilder.js';
