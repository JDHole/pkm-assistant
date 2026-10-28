import { machineMeta } from '../../../core/index.js';
import { t } from '../../../core/i18n/index.js';
import type { Owner, ParentQuestion } from '../../sub-agents/index.js';

export type AutoTurnReservation =
    | { kind: 'idle' }
    | { kind: 'reserved'; token: object; owner: Owner; accepted?: boolean };

export function buildSubTaskQuestionDelivery(question: ParentQuestion) {
    return {
        text: t('chat.subagent_question.notification', {
            name: question.name, task_id: question.taskId, sub_id: question.subId,
            question_id: question.id, text: question.text,
        }),
        meta: machineMeta({
            questionId: question.id, taskId: question.taskId, subId: question.subId,
            owner: question.owner, name: question.name, question: question.text,
        }),
    };
}
