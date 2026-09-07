/**
 * SkillVariables
 * Substitutes {{key}} placeholders in skill prompts with actual values.
 * Used when skill has pre-questions — user answers fill the variables.
 *
 * Sesja 48: Skills v2 variable substitution.
 */

/**
 * Replace {{key}} placeholders in prompt with values from the map.
 * Unmatched placeholders are left as-is (agent can still see them).
 *
 * @param {string} prompt - Skill prompt with {{key}} placeholders
 * @param {Object<string, string>} values - Map of key → value
 * @returns {string} Prompt with substituted values
 *
 * @example
 * substituteVariables("Okres: {{okres}}, Format: {{format}}", {okres: "ostatni tydzień", format: "krótki"})
 * // → "Okres: ostatni tydzień, Format: krótki"
 */
export function substituteVariables(prompt: string, values: Record<string, string> = {}) {
    if (!prompt || typeof prompt !== 'string') return prompt || '';
    if (!values || Object.keys(values).length === 0) return prompt;

    return prompt.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return values[key] !== undefined ? String(values[key]) : match;
    });
}
