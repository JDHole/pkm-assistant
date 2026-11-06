import { machineMeta, fenceUntrusted } from '../../../core/index.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import { getLimits } from '../../../config/limits.js';
import { limitPlanResult } from '../../sub-agents/index.js';
import type { PlanResultNotice, SubTaskNotifier, SubTaskOrigin } from '../../sub-agents/index.js';
import type { ChatViewLike } from './chatViewShape.js';
import { evaluateSubTaskDelivery } from './subTaskDelivery.js';
import { evaluateAutoTurnChain } from './autoTurnChain.js';
import { matchTabForOrigin } from './subTaskNotification.js';
import { freezeTurnOwner } from './turnOwner.js';
import { _tabKey } from './chat_tabs.js';

export function buildSubTaskPlanDelivery(notice: PlanResultNotice, maxChars: number) {
    const result = limitPlanResult(notice.result, maxChars);
    return { text: t('chat.plan_result.header', { id: result.plan_id }) + '\n'
        + fenceUntrusted(JSON.stringify(result), 'plan_result'),
    meta: machineMeta({ subTaskPlanId: result.plan_id }) };
}

/** Claim after synchronous notifier dispatch; recheck Stop and owner before starting a turn. */
export function deliverSubTaskPlan(view: ChatViewLike, notice: PlanResultNotice): boolean {
    const notifier = view.plugin?.subTaskNotifier;
    const limits = getLimits(view.env?.settings);
    const tab = matchTabForOrigin(view.chatTabs, notice.owner, _tabKey);
    const window = view.rollingWindow;
    const owner = freezeTurnOwner(view);
    const chain = evaluateAutoTurnChain(view._autoTurnChainCounts?.get(notice.owner.agentName) || 0, limits.max_consecutive_auto_turns);
    const allowed = (pending = view._subTaskTurnPending) => evaluateSubTaskDelivery({ tab,
        isGenerating: view.is_generating, subTaskTurnPending: pending, drainSuppressed: view._drainSuppressed,
        userStopped: notice.userStopped, chainAllowed: chain.allowed }).allowed;
    if (!notifier || !tab || !window || owner.tab !== tab || owner.sessionPath !== notice.owner.sessionPath
        || owner.sessionEpoch !== notice.owner.sessionEpoch || !allowed()) return false;
    view._subTaskTurnPending = true;
    void Promise.resolve().then(async () => {
        if (!allowed(false) || view.rollingWindow !== window
            || matchTabForOrigin(view.chatTabs, notice.owner, _tabKey) !== tab) return;
        const [claim] = notifier.claimNotices(value => value.kind === 'plan-result' && value.result.plan_id === notice.result.plan_id);
        if (!claim) return;
        try {
            const { text, meta } = buildSubTaskPlanDelivery(notice, limits.subagent_result_max_chars);
            await view.send_message({ injectedText: text, meta, planDelivery: { notice, claim, window, tab, owner } });
        } finally {
            if (window.messages.some(message => message.subTaskPlanId === notice.result.plan_id)) claim.ack();
            else claim.release();
        }
    }).catch(error => log.warn('Chat', 'Plan result delivery failed', error))
        .finally(() => { if (view._questionAutoTurn?.kind !== 'reserved') view._subTaskTurnPending = false; });
    return false;
}

/** All ready plan results can join the next human turn, including those parked by Stop. */
export async function consumeSubTaskPlans(notifier: SubTaskNotifier | undefined, owner: SubTaskOrigin, startedSeq: number,
    hasResult: (id: string) => boolean, append: (delivery: ReturnType<typeof buildSubTaskPlanDelivery>) => Promise<void>, maxChars: number,
): Promise<void> {
    const claims = notifier?.claimNotices(notice => notice.kind === 'plan-result' && notice.completedSeq < startedSeq
        && notice.owner.agentName === owner.agentName && notice.owner.sessionPath === owner.sessionPath
        && notice.owner.sessionEpoch === owner.sessionEpoch) ?? [];
    for (const claim of claims) {
        if (claim.notice.kind !== 'plan-result') { claim.release(); continue; }
        const notice = claim.notice;
        try {
            if (!hasResult(notice.result.plan_id)) await append(buildSubTaskPlanDelivery(notice, maxChars));
        } catch (error) {
            log.warn('Chat', 'Plan result acceptance failed', error);
        } finally {
            if (hasResult(notice.result.plan_id)) claim.ack(); else claim.release();
        }
    }
}
