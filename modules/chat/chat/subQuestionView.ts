import type { Owner, ParentQuestion, SubTaskRegistry } from '../../sub-agents/index.js';
import { createTile } from '../../ui-components/index.js';
import { t } from '../../../core/i18n/index.js';

/** Resolve only a currently open question belonging to this exact conversation. */
export function findOpenSubQuestion(registry: SubTaskRegistry | undefined, id: unknown, owner: Owner): { question: ParentQuestion; task: string } | undefined {
    if (typeof id !== 'string' || !id || !owner.agentName || !owner.sessionPath || !owner.sessionEpoch) return;
    for (const task of registry?.list() ?? []) {
        const state = registry!.getQuestionState(task.id);
        if (state.kind !== 'waiting' || state.question.id !== id) continue;
        const o = state.question.owner;
        if (o.agentName === owner.agentName && o.sessionPath === owner.sessionPath && o.sessionEpoch === owner.sessionEpoch) {
            return { question: state.question, task: task.taskPreview ?? '' };
        }
    }
    return;
}

export interface AnsweredSubQuestion { name: string; question: string; answer: string }

export function answeredSubQuestion(value: unknown): AnsweredSubQuestion | undefined {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (typeof v.name !== 'string' || typeof v.question !== 'string' || typeof v.answer !== 'string') return;
    return { name: v.name, question: v.question, answer: v.answer };
}

export function renderAnsweredSubQuestion(value: AnsweredSubQuestion): HTMLElement {
    const tile = createTile({
        role: 'agent', status: 'ok',
        iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l1.5-3A8.5 8.5 0 1 1 21 11.5Z"/><path d="m12 8-3 3 3 3M9 11h6"/></svg>',
        title: t('chat.sub_question.answered', { name: value.name }),
        meta: t('chat.sub_question.expand'),
        details: `${value.question}\n\n${value.answer}`,
    });
    tile.el.classList.add('cs-sub-question-answer');
    return tile.el;
}
