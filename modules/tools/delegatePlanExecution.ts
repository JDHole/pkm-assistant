import { SubTaskRegistry } from '../sub-agents/index.js';
import type { PlanHandle, SubTask } from '../sub-agents/index.js';
import { t } from '../../core/i18n/index.js';

/** Blocking callers without a public registry have no recipient for questions. */
export function createBlockingPlanRegistry(): SubTaskRegistry {
    return new class extends SubTaskRegistry {
        override openParentQuestion(): ReturnType<SubTaskRegistry['openParentQuestion']> {
            return { kind: 'rejected', reason: 'unavailable' };
        }
    }();
}

export function planReceipt(plan: PlanHandle, tasks: readonly SubTask[]) {
    const report = plan.getReport();
    return {
        success: true, started: true, plan_id: plan.planId,
        tasks: report.nodes.map((node, i) => ({ id: node.nodeId, task_id: node.runId,
            name: tasks[i].name, ...(tasks[i].threadId ? { sub_id: tasks[i].threadId } : {}),
            state: node.state, ...(tasks[i].parentConversation ? { parentConversation: tasks[i].parentConversation } : {}) })),
        waiting: report.counts.waiting, queued: report.counts.queued,
        plan_complete: report.complete,
        note: t('mcp.delegate.plan_started'),
    };
}

/** Tool responses keep material/hand-off from the existing thunk; blocked never inherits it. */
export function aggregatePlanResults(plan: PlanHandle, tasks: readonly SubTask[], values: unknown[], salvageCap: number) {
    const report = plan.getReport();
    const counts = { finished: 0, partial: 0, failed: 0, blocked: 0 };
    const results = report.nodes.map((node, i) => {
        const identity = { id: node.nodeId, task_id: node.runId, state: node.state };
        const value = values[i];
        const response = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        switch (node.state.kind) {
            case 'blocked':
                counts.blocked++;
                return { ...identity, success: false, blocked: true, causes: node.state.causes,
                    error: t('chat.substrip.plan_not_started') };
            case 'finished':
                counts.finished++;
                return { ...response, ...identity, success: true };
            case 'failed': {
                const task = tasks[i];
                const material = typeof response.partial_result === 'string' ? response.partial_result
                    : task.outcome?.hasMaterial ? task.result?.handoff?.trim() || task.result?.text?.trim() || task.partial?.text?.trim() || '' : '';
                const partial = material.slice(0, salvageCap);
                const hasMaterial = partial.length > 0;
                if (hasMaterial || task.outcome?.completeness === 'partial') counts.partial++;
                else counts.failed++;
                return { ...response, ...identity, success: false,
                    error: response.error ?? task.error ?? t('mcp.delegate.plan_failed', { reason: node.state.reason }),
                    ...(hasMaterial ? { partial_result: partial } : {}) };
            }
            case 'waiting': case 'queued': case 'running':
                throw new Error('Cannot aggregate an unfinished delegation plan.');
            default: { const exhaustive: never = node.state; return exhaustive; }
        }
    });
    return { success: counts.finished === results.length, plan_id: plan.planId,
        plan_complete: report.complete, counts, results };
}
