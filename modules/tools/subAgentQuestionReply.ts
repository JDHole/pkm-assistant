import type { SubRunContext, SubTaskRegistry } from '../sub-agents/index.js';

/** Runtime-only exception to the tool gate, never a capability supplied by the model. */
export function isOwnChildQuestionReply(
    call: { name: string; arguments: unknown },
    context: SubRunContext | undefined,
    agentName: string,
    registry: Pick<SubTaskRegistry, 'getDelegationAncestors' | 'getThread' | 'getTask' | 'getQuestionState'> | null | undefined,
): boolean {
    if (call.name !== 'sub_agent' || !context || !registry?.getDelegationAncestors?.(context, agentName)) return false;
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
    if (!thread || thread.phase !== 'running' || thread.parentId !== context.runId) return false;
    const runId = thread.runIds.at(-1);
    const child = runId ? registry.getTask(runId) : undefined;
    if (!child || child.status !== 'running' || child.stopRequested || child.parentId !== context.runId) return false;
    const state = registry.getQuestionState(child.id);
    if (state.kind !== 'waiting') return false;
    const { question } = state;
    return question.id === args.question_id && question.subId === args.sub_id
        && question.recipient.kind === 'sub' && question.recipient.runId === context.runId
        && question.owner.agentName === context.origin.agentName
        && question.owner.sessionPath === context.origin.sessionPath
        && question.owner.sessionEpoch === context.origin.sessionEpoch;
}
