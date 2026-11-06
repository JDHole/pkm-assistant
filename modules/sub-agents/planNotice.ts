import { t } from '../../core/i18n/index.js';
import type { PlanTaskState } from './DelegationPlan.js';
import type { SubTask } from './SubTaskRegistry.js';

function stateLabel(state: PlanTaskState): string {
    switch (state.kind) {
        case 'waiting': return t('chat.substrip.plan_waiting', { ids: state.pending.map(d => d.nodeId).join(', ') });
        case 'blocked': return t('chat.substrip.plan_blocked', { ids: state.causes.map(d => d.nodeId).join(', ') });
        case 'queued': return t('chat.substrip.state_queued');
        case 'running': return t('chat.substrip.state_running');
        case 'finished': return t('chat.substrip.state_done');
        case 'failed': {
            switch (state.reason) {
                case 'error': return t('chat.substrip.state_partial_error');
                case 'timeout': return t('chat.substrip.state_partial_timeout');
                case 'aborted': return t('chat.subagent_notification.status_aborted');
                case 'no-answer': return t('chat.subagent_notification.question_no_answer');
                case 'incomplete': return t('chat.substrip.state_partial_incomplete');
                default: { const exhaustive: never = state.reason; return exhaustive; }
            }
        }
        default: { const exhaustive: never = state; return exhaustive; }
    }
}

/** Shared by lead delivery and the parent's inbox. Never truncate the state table with material. */
export function buildPlanNotice(task: SubTask) {
    if (!task.plan || !task.planReport) return undefined;
    const report = task.planReport;
    const lines = [t('chat.subagent_notification.plan_heading', { id: report.planId }),
        t('chat.subagent_notification.plan_columns'), '| --- | --- |',
        ...report.nodes.map(node => `| ${node.nodeId} | ${stateLabel(node.state)} |`)];
    if (report.complete) lines.push(t('chat.subagent_notification.plan_complete'));
    return { plan: task.plan, plan_report: report, plan_complete: report.complete, plan_summary: lines.join('\n') };
}
