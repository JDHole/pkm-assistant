import { fenceUntrusted } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import type { SubTaskPlanRuntime } from './SubTaskPlanRuntime.js';
import type { PlanResult, PlanNodeState } from './SubTaskPlan.js';
import type { RuntimeSequence } from './SubTaskRegistry.js';
import { redactExport, excerpt } from './DependencyResults.js';

export type PlanResultNotice = { kind: 'plan-result'; owner: SubTaskPlanRuntime['owner']; parentRunId?: string;
    result: PlanResult; completedSeq: RuntimeSequence; userStopped: boolean };

function isTerminal(state: PlanNodeState): state is PlanResult['nodes'][number]['state'] {
    return state.kind !== 'waiting_dependencies' && state.kind !== 'queued' && state.kind !== 'running';
}

/** Keep the complete state table; budget only material, never slice serialized JSON. */
export function buildPlanResult(plan: Pick<SubTaskPlanRuntime, 'nodes' | 'status' | 'planId'>, maxChars = 0, secrets: readonly string[] = []): PlanResult {
    if (plan.status === 'active') throw new Error('plan_not_finished');
    const counts: PlanResult['counts'] = { done: 0, error: 0, blocked: 0, stopped: 0, not_executed: 0, interrupted: 0 };
    const nodes: PlanResult['nodes'][number][] = plan.nodes.map(node => {
        const state = node.state;
        if (!isTerminal(state)) throw new Error('plan_not_finished');
        counts[state.kind]++;
        return { ...node, state: { ...state, ...('material' in state ? { material: redactExport(state.material ?? '', secrets) } : {}),
            ...(state.kind === 'error' ? { error: redactExport(state.error, secrets) } : {}),
            ...(state.question ? { question: { ...state.question, text: redactExport(state.question.text, secrets),
                ...(state.question.note ? { note: redactExport(state.question.note, secrets) } : {}),
                resolution: state.question.resolution.kind === 'answered'
                    ? { ...state.question.resolution, text: redactExport(state.question.resolution.text, secrets) }
                    : state.question.resolution,
            } } : {}) } };
    });
    const result: PlanResult = { kind: 'plan_result', plan_id: plan.planId, nodes, counts,
        result: nodes.map(node => `${node.id}: ${node.state.kind}`).join('; '),
        blocked: nodes.flatMap(node => node.state.kind === 'blocked' ? [{ id: node.id, blocked_by: node.state.blocked_by }] : []),
        ...(plan.status === 'completed' ? { success: true, status: 'completed' }
            : { success: false, status: plan.status, error: t('subagent.plan.partial') }),
    };
    return limitPlanResult(result, maxChars);
}

export function limitPlanResult(result: PlanResult, maxChars: number): PlanResult {
    if (maxChars <= 0 || JSON.stringify(result).length <= maxChars) return result;
    const fit = (cap: number): PlanResult => ({ ...result, nodes: result.nodes.map(node => {
        const state = node.state;
        return { ...node, state: 'material' in state && (state.material?.length ?? 0) > cap
            ? { ...state, material: state.material!.slice(0, cap) + t('subagent.dependencies.truncated'), truncated: true } : state };
    }) });
    let low = 0, high = Math.max(0, ...result.nodes.map(node => node.state.material?.length ?? 0));
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (JSON.stringify(fit(mid)).length <= maxChars) low = mid; else high = mid - 1;
    }
    return fit(low);
}

/** Readable machine notification; the source suffix preserves status across locale changes. */
export function formatPlanResult(source: PlanResult, maxChars: number): string {
    const result = limitPlanResult({ ...source, nodes: source.nodes.map(node => ({ ...node,
        state: 'material' in node.state && node.dependency_results === 'summary'
            ? { ...node.state, material: excerpt(node.state.material ?? '', 240) } : node.state,
    })) }, maxChars);
    const line = (text: string) => text.replace(/\s+/g, ' ').trim();
    const rows = result.nodes.map(node => {
        const state = node.state;
        const material = state.material || '-';
        return `${node.id}: ${t(`chat.plan.node.${state.kind}`)}`
            + (state.kind === 'error' ? ` (${line(state.error)})` : '')
            + ` | ${t(node.dependency_results === 'full' ? 'subagent.dependencies.full' : 'subagent.dependencies.summary', { id: node.id })}: ${line(material)}`
            + (state.question && state.question.resolution.kind !== 'answered'
                ? ` | ${line(t(state.question.resolution.kind === 'no-answer' ? 'subagent.question_no_answer' : 'subagent.question_cancelled', { question: state.question.text }))}` : '')
            + ` | blocked_by: ${state.kind === 'blocked' ? state.blocked_by.join(', ') : '-'}`;
    });
    return t('chat.plan_result.header', { id: result.plan_id }) + '\n'
        + fenceUntrusted([t(`chat.plan.status.${result.status}`), ...rows].join('\n'), `plan_result:${result.status}`)
        + '\n' + t('chat.subagent_notification.footer');
}
