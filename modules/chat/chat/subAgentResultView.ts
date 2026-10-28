import { t } from '../../../core/i18n/index.js';
import { stripRunnerQuestion } from './stripRunnerQuestion.js';
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
    const model = buildSubTaskResultModel(input.outcome?.completeness === 'empty'
        ? { ...input, text: undefined, handoff: undefined, partialResult: undefined, partialText: undefined }
        : input);
    const name = input.name.trim() || translate('subagent.label');
    const title = model.openQuestion !== undefined ? translate('chat.subresult.question_result_title', { name }) : `${name} ${translate(model.endLabelKey)}`;
    const badge = model.openQuestion !== undefined ? translate('chat.substrip.question_no_answer') : model.completenessLabelKey ? translate(model.completenessLabelKey) : undefined;
    const question = input.question && typeof input.question === 'object' ? input.question : undefined;
    const note = question && 'text' in question && typeof question.text === 'string'
        && 'resolution' in question && question.resolution && typeof question.resolution === 'object'
        && 'kind' in question.resolution && (question.resolution.kind === 'no-answer' || question.resolution.kind === 'cancelled')
        && 'note' in question && typeof question.note === 'string' ? question.note : undefined;
    const candidates = input.outcome?.completeness === 'partial'
        ? [input.handoff, input.partialResult, input.partialText, input.text]
        : [input.text, input.handoff, input.partialResult, input.partialText];
    const rawMaterial = candidates.find(value => typeof value === 'string' && value.trim().length > 0);
    const material = input.outcome?.completeness === 'empty' ? '' : stripRunnerQuestion(rawMaterial ?? '', note).trim();
    const notes: string[] = [];
    if (model.thread.kind === 'reusable' && model.thread.sub_id.trim()) notes.push(translate('chat.subresult.continue_same_thread'));
    if (model.userStopped) {
        if (model.material) notes.push(translate('chat.subresult.user_stopped_material'));
        notes.push(translate('chat.subresult.user_stopped_next'));
    }
    return {
        title,
        badge,
        status: model.openQuestion !== undefined ? 'attention' : model.state.kind === 'done' ? 'ok' : 'error',
        material: material || undefined,
        openQuestion: model.openQuestion,
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
