import type { ApprovalManager } from '../../core/index.js';
import { redactParentConversationSnapshot } from '../sub-agents/index.js';
import { t } from '../../core/i18n/index.js';
import type { ParentConversationContext } from '../sub-agents/index.js';
import type { prepareDelegateExecution } from './DelegateTool.js';

type Preparation = Extract<ReturnType<typeof prepareDelegateExecution>, { success: true }>;
export type PreparedParentDelegation = Readonly<Preparation & {
    parentConversation: ParentConversationContext;
    modelId: string | undefined;
    providerId: string | undefined;
}>;
type Refusal = { success: false; error: string; instruction?: string };
type ParentRequest = {
    mode: 'parent_conversation';
    parentConversation: ParentConversationContext | undefined;
    parentName: string;
    signal: AbortSignal;
    knownSecrets?: readonly string[];
    approvalManager: Pick<ApprovalManager, 'requestApproval'> | null | undefined;
    prepare: () => ReturnType<typeof prepareDelegateExecution>;
    /** Recheck owner/epoch, ancestry and permissions, without consulting the active tab. */
    validate: () => boolean;
};
type Request = { mode?: 'clean' } | ParentRequest;
export type ParentConsentResult = Refusal | { success: true; mode: 'clean' }
    | { success: true; mode: 'parent_conversation'; prepared: PreparedParentDelegation };

function freezeCopy<T>(value: T): T {
    const copy = structuredClone(value);
    const freeze = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        for (const child of Object.values(node)) freeze(child);
        Object.freeze(node);
    };
    freeze(copy);
    return copy;
}

/** May also be called after admission: a changed provider/model invalidates the consent. */
export function isPreparedParentDelegationCurrent(prepared: PreparedParentDelegation, signal: AbortSignal, validate: () => boolean): boolean {
    return !signal.aborted && validate()
        && prepared.finalModel.providerId === prepared.providerId && prepared.finalModel.modelId === prepared.modelId;
}

/** Internal P3 seam. The caller may reserve ONLY a successful, still-current preparation.
 * No timeout/slot is owned here. Stop/close/unload must abort the invocation's signal.
 * The default path does not even read preparation or consent dependencies.
 */
export async function prepareParentConversationDelegation(request: Request): Promise<ParentConsentResult> {
    if (request.mode !== 'parent_conversation') return { success: true, mode: 'clean' };
    const refuse = (key: string): Refusal => ({ success: false, error: t(`mcp.delegate.share.${key}`) });
    if (request.signal.aborted) return refuse('cancelled');
    if (!request.parentConversation || !request.validate()) return refuse('invalid_source');
    // Capture synchronously, before preparation or the first await can change the source.
    const parentConversation = freezeCopy({ ...request.parentConversation,
        snapshot: redactParentConversationSnapshot(request.parentConversation.snapshot, request.knownSecrets),
    });
    const result = request.prepare();
    if (!result.success) return result;
    const prepared: PreparedParentDelegation = Object.freeze({
        ...result, subAgentConfig: freezeCopy(result.subAgentConfig), parentConversation,
        providerId: result.finalModel.providerId, modelId: result.finalModel.modelId,
    });
    const current = () => isPreparedParentDelegationCurrent(prepared, request.signal, request.validate);
    if (!current()) return refuse('cancelled');
    const parentProvider = parentConversation.providerId;
    const childProvider = prepared.providerId;
    // Unknown providers, including two missing IDs, require an explicit one-time decision.
    if (!parentProvider?.trim() || !childProvider?.trim() || parentProvider !== childProvider) {
        if (!request.approvalManager) return refuse('unavailable');
        const snapshot = parentConversation.snapshot;
        const text = [snapshot.summary, ...snapshot.messages.map(entry => `[${entry.sequence} ${entry.role}] ${entry.text}`)]
            .filter(Boolean).join('\n');
        let decision;
        try {
            decision = await request.approvalManager.requestApproval({
                type: 'delegate.share_conversation', agentName: parentConversation.owner.agentName,
                signal: request.signal,
                description: t('approval.share.description', {
                    parent: request.parentName, child: prepared.subAgentConfig.name,
                    source: parentProvider || t('approval.share.unknown'),
                    target: childProvider || t('approval.share.unknown'),
                }),
                preview: text.length > 4000 ? text.slice(0, 4000) + '\n' + t('approval.preview.truncated') : text,
            });
        } catch { return refuse('unavailable'); }
        if (!current() || decision.reason === 'cancelled') return refuse('cancelled');
        if (decision.result === 'redirect') return { ...refuse('redirected'), instruction: decision.instruction || '' };
        if (decision.result !== 'approve') return refuse(decision.reason === 'handler_unavailable' ? 'unavailable' : 'denied');
    }
    return { success: true, mode: 'parent_conversation', prepared };
}
