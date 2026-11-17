import type { SubAgentData } from './types.js';
import type { ModelLibraryEntry } from '../models/index.js';
import { DEFAULT_LIMITS, LIMIT_SPECS } from '../../config/limits.js';

/** Narzędzia nowego suba w edytorze. Jedno źródło dla formularza i dla decyzji o "Zaawansowanych". */
export const EDITOR_DEFAULT_TOOLS: readonly string[] = ['search', 'read', 'list'];
/** Domyślna minimalna liczba kroków nowego suba (ta sama co w SubAgentLoader). */
export const EDITOR_DEFAULT_MIN_ITERATIONS = 1;
// Widełki pola "Max iteracji" i walidacji biorą się z LIMIT_SPECS, nie z lokalnego literału:
// inaczej zmiana sufitu w config/limits.ts rozjechałaby pole, walidację i komunikat.
const MAX_ITERATIONS_SPEC = LIMIT_SPECS.subagent_max_iterations_worker;

export function modelListRoleForEditorRole(role: string): 'sub_worker' | 'researcher' {
    return role === 'worker' ? 'sub_worker' : 'researcher';
}

export function templateSaveNotice(saved: { name: string; version?: number }): {
    messageKey: 'modal.sub_agent.template_saved' | 'modal.sub_agent.template_saved_bumped';
    params: { name: string; version?: number };
} {
    return saved.version
        ? { messageKey: 'modal.sub_agent.template_saved_bumped', params: { name: saved.name, version: saved.version } }
        : { messageKey: 'modal.sub_agent.template_saved', params: { name: saved.name } };
}

export function editorModelOptions(models: readonly ModelLibraryEntry[], selected: string): ModelLibraryEntry[] {
    return selected && !models.some(model => model.model === selected)
        ? [...models, { platform: '', model: selected }]
        : [...models];
}

export type MaxIterationsValidation =
    | { ok: true; value: number }
    | { ok: false; errorKey: 'modal.sub_agent.max_iter_invalid'; params: { min: number; max: number } };

/** Widełki pola "Max iteracji" (atrybuty min/max inputu). */
export function maxIterationsBounds(): { min: number; max: number } {
    return { min: MAX_ITERATIONS_SPEC.min, max: MAX_ITERATIONS_SPEC.ceiling };
}

export function validateMaxIterations(raw: string): MaxIterationsValidation {
    const bounds = maxIterationsBounds();
    const invalid: MaxIterationsValidation = { ok: false, errorKey: 'modal.sub_agent.max_iter_invalid', params: bounds };
    if (!/^\d+$/.test(raw.trim())) return invalid;
    const value = Number(raw);
    return Number.isInteger(value) && value >= bounds.min && value <= bounds.max
        ? { ok: true, value }
        : invalid;
}

export function initialAdvancedOpen(existing: Pick<SubAgentData, 'tools' | 'scope' | 'max_iterations' | 'min_iterations' | 'max_tool_result_length' | 'enabled'> | null): boolean {
    if (!existing) return false;
    const toolsMatch = existing.tools.length === EDITOR_DEFAULT_TOOLS.length
        && EDITOR_DEFAULT_TOOLS.every(tool => existing.tools.includes(tool));
    const scopeEmpty = !existing.scope
        || (existing.scope.folders.length === 0
            && Object.keys(existing.scope.frontmatter).length === 0
            && existing.scope.sections.length === 0
            && existing.scope.pinned_notes.length === 0);
    return !toolsMatch || !scopeEmpty || existing.enabled === false
        || (existing.max_iterations != null && existing.max_iterations !== DEFAULT_LIMITS.subagent_max_iterations_worker)
        || (existing.min_iterations != null && existing.min_iterations !== EDITOR_DEFAULT_MIN_ITERATIONS)
        || (existing.max_tool_result_length != null && existing.max_tool_result_length !== DEFAULT_LIMITS.max_tool_result_length);
}
