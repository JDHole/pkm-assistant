import type { SubRunContext, SubTaskRegistry } from '../sub-agents/index.js';

/** Runtime-only exception to the tool gate, never a capability supplied by the model. */
export function isOwnChildQuestionReply(
    call: { name: string; arguments: unknown },
    context: SubRunContext | undefined,
    agentName: string,
    registry: Pick<SubTaskRegistry, 'getDelegationAncestors' | 'getThread' | 'getTask' | 'getQuestionState'> | null | undefined,
    leadOrigin?: { agentName: string; sessionPath?: string; sessionEpoch?: string | null } | null,
): boolean {
    if (call.name !== 'sub_agent' || !registry) return false;
    if (context && !registry.getDelegationAncestors(context, agentName)) return false;
    const owner = context?.origin ?? leadOrigin;
    if (!owner || owner.agentName !== agentName || !owner.sessionPath || !owner.sessionEpoch) return false;
    let args: unknown = call.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { return false; }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)
        || !('action' in args) || args.action !== 'message'
        || !('sub_id' in args) || typeof args.sub_id !== 'string'
        || !('question_id' in args) || typeof args.question_id !== 'string'
        || !('text' in args) || typeof args.text !== 'string' || !args.text.trim()) return false;
    const thread = registry.getThread(args.sub_id);
    if (!thread || thread.phase !== 'running' || thread.parentId !== context?.runId
        || thread.owner.agentName !== owner.agentName || thread.owner.sessionPath !== owner.sessionPath
        || thread.owner.sessionEpoch !== owner.sessionEpoch) return false;
    const runId = thread.runIds.at(-1);
    const child = runId ? registry.getTask(runId) : undefined;
    if (!child || child.status !== 'running' || child.stopRequested || child.parentId !== context?.runId) return false;
    const state = registry.getQuestionState(child.id);
    if (state.kind !== 'waiting') return false;
    const { question } = state;
    return question.id === args.question_id && question.subId === args.sub_id
        && (context ? question.recipient.kind === 'sub' && question.recipient.runId === context.runId : question.recipient.kind === 'lead')
        && question.owner.agentName === owner.agentName
        && question.owner.sessionPath === owner.sessionPath
        && question.owner.sessionEpoch === owner.sessionEpoch;
}
