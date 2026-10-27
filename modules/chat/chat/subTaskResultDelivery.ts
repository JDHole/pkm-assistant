import { machineMeta } from '../../../core/index.js';
import type { SubTask, SubTaskRegistry } from '../../sub-agents/index.js';
import { buildSubTaskNotificationText } from './subTaskNotification.js';

/** The same model text and renderer metadata for automatic and user-turn delivery. */
export function buildSubTaskResultDelivery(task: SubTask, registry: SubTaskRegistry | undefined, maxResultChars: number) {
    const deliveryTask = task.error && task.partial ? { ...task, error: task.error + '\n\n' + task.partial.text } : task;
    const reusableThread = task.threadId ? registry?.getThread?.(task.threadId) : undefined;
    const reusableSubId = reusableThread?.phase === 'idle' && reusableThread.reusable === true ? task.threadId : undefined;
    const text = buildSubTaskNotificationText(deliveryTask, {
        maxResultChars,
        ...(reusableSubId ? { subId: reusableSubId } : {}),
    });
    const outcome = task.outcome || task.result?.outcome;
    const effects = (outcome?.effects || []).map((effect) => {
        const recorded = reusableThread?.effects.find(candidate => candidate.tool === effect.tool
            && candidate.action === effect.action && candidate.check === effect.check
            && JSON.stringify(candidate.targets) === JSON.stringify(effect.targets));
        return { ...effect, ...(recorded?.expectedCheck ? { expectedCheck: recorded.expectedCheck } : {}) };
    });
    const thread = reusableSubId
        ? { kind: 'reusable' as const, sub_id: reusableSubId }
        : !deliveryTask.threadId && deliveryTask.background === true
            ? { kind: 'single' as const }
            : { kind: 'unknown' as const };
    const subTaskResult = {
        outcome,
        result: task.result ? { text: task.result.text, handoff: task.result.handoff } : undefined,
        partial: task.partial,
        error: task.error,
        effects,
        thread,
    };
    return { text, meta: machineMeta({ _subTaskNotification: true, subTaskId: task.id, _subTaskResult: subTaskResult }) };
}
