import { t } from '../../../core/i18n/index.js';
import { buildSubTaskResultModel } from '../../sub-agents/index.js';
import type { BuildSubTaskResultModelInput, SubTaskResultThread } from '../../sub-agents/index.js';
import type { SubAgentResultView } from '../../ui-components/index.js';

export interface BuildSubAgentResultViewInput extends Omit<BuildSubTaskResultModelInput, 'thread'> {
    name: string;
    thread: SubTaskResultThread;
    taskId?: string;
    threadId?: string;
}

export function buildSubAgentResultView(input: BuildSubAgentResultViewInput, translate: typeof t = t): SubAgentResultView {
    const model = buildSubTaskResultModel(input);
    const name = input.name.trim() || translate('subagent.label');
    const title = `${name} ${translate(model.endLabelKey)}`;
    const badge = model.completenessLabelKey ? translate(model.completenessLabelKey) : undefined;
    const notes: string[] = [];
    if (model.thread.kind === 'reusable' && model.thread.sub_id.trim()) notes.push(translate('chat.subresult.continue_same_thread'));
    if (model.userStopped) {
        if (model.material) notes.push(translate('chat.subresult.user_stopped_material'));
        notes.push(translate('chat.subresult.user_stopped_next'));
    }
    return {
        title,
        badge,
        status: model.state.kind === 'done' ? 'ok' : 'error',
        material: model.material || undefined,
        error: model.error || undefined,
        missingTargets: model.missingTargets,
        effects: model.effects.map(effect => ({
            tool: effect.tool,
            target: effect.targets.map(target => target.path || target.id || '').filter(Boolean).join(', ') || effect.action,
            statusLabel: translate(`chat.subresult.effect_${effect.state}`),
        })),
        notes,
    };
}
