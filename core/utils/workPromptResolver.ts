/**
 * Work-prompt resolver (E2.8 B3) — pure, node-safe, zero imports.
 *
 * @see resolveWorkPrompt
 */

/** Either the full settings object or the `pkmAssistant` slice — see the resolver's doc. */
export interface WorkPromptSettings {
    pkmAssistant?: { promptDefaults?: Record<string, unknown> };
    promptDefaults?: Record<string, unknown>;
}

/**
 * resolveWorkPrompt
 *
 * "Work prompts" are the instructional prompts used by workflows/tools that ask an LLM to
 * think/propose in a constrained role (NOT regular chat): save-session, archive dedup, summary
 * synthesis, context-window compression, and the sub-agent task frame.
 *
 * Resolution chain (S24): per-agent override > global default > factory default.
 *   - per-agent: agent[key] (e.g. agent.compression_prompt) — empty string = "not set".
 *   - global:    settings.pkmAssistant.promptDefaults[key] — edited in Settings→Prompt.
 *   - factory:   the code default passed by the caller (lives next to its consumer).
 *
 * `settings` is accepted defensively as either the full settings object ({pkmAssistant:{promptDefaults}})
 * or the pkmAssistant object directly ({promptDefaults}) — call sites pass different shapes.
 *
 * Both branches are optional in the type below precisely because BOTH shapes are legal input.
 *
 * @param agent
 * @param key - one of WORK_PROMPT_KEYS
 * @param settings - full settings OR the pkmAssistant slice
 * @param factoryDefault
 */
export function resolveWorkPrompt(
    agent: Record<string, unknown> | null | undefined,
    key: string,
    settings: WorkPromptSettings | null | undefined,
    factoryDefault: string = '',
): string {
    const agentVal = agent && agent[key];
    if (typeof agentVal === 'string' && agentVal.trim()) return agentVal;

    const promptDefaults: Record<string, unknown> = (settings && (settings.pkmAssistant?.promptDefaults || settings.promptDefaults)) || {};
    const globalVal = promptDefaults[key];
    if (typeof globalVal === 'string' && globalVal.trim()) return globalVal;

    return factoryDefault;
}

/**
 * Keys the resolver understands.
 *
 * AUD-dead-code-124 (2026-09-02): `brief_prompt` REMOVED — its value had zero production
 * readers (the only consumer, `ContextSessionGenerator`, was deleted in E2.9 phase D), yet
 * Settings→Prompt kept rendering it as a live control with a present-tense description. The
 * Settings slot and the factory constant (`DEFAULT_BRIEF_PROMPT`, `modules/memory/workPrompts.ts`)
 * were cut in the same sweep — see `modules/memory/CLAUDE.md`.
 */
export const WORK_PROMPT_KEYS = [
    'compression_prompt',
    'save_session_prompt',
    'archive_prompt',
    'summary_prompt',
    'subagent_frame_prompt',
];
