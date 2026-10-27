import { t } from '../../../core/i18n/index.js';
import { toolResultStatus } from '../../../core/index.js';
import type { SubAgentToolCallDetail, SubAgentUsage } from '../../ui-components/index.js';
import type { RunOutcome } from '../../sub-agents/index.js';
import { buildSubAgentResultView } from './subAgentResultView.js';

interface DelegateResult {
    isError?: boolean;
    success?: boolean;
    error?: string;
    partial_result?: string;
    aspect?: string;
    aspect_type?: string;
    result?: string | { text?: string; handoff?: string };
    tools_used?: string[];
    tool_call_details?: SubAgentToolCallDetail[];
    duration_ms?: number;
    usage?: SubAgentUsage | null;
    outcome?: Omit<RunOutcome, 'effects'> & { effects?: RunOutcome['effects'] };
    handoff?: string;
    partial?: { text?: string };
    sub_id?: string;
    task_id?: string;
    threadId?: string;
    thread?: { kind: 'reusable'; sub_id: string } | { kind: 'single' } | { kind: 'unknown' };
    effects?: Array<{ tool: string; action: string; targets: Array<{ path?: string; id?: string; kind?: string }>; outcome: string; check: 'matches' | 'mismatch' | 'not-checked'; expectedCheck?: 'exists' | 'absent' | 'none' }>;
}

export interface DelegateBlockOptions {
    type: string;
    status: 'success' | 'error';
    aspectType?: string;
    agentName?: string;
    query?: string;
    response?: string;
    toolsUsed?: string[];
    toolCallDetails?: SubAgentToolCallDetail[];
    duration?: number;
    usage?: SubAgentUsage | null;
    resultView?: import('../../ui-components/index.js').SubAgentResultView;
}

function hasStructuredOutcome(value: DelegateResult['outcome']): value is NonNullable<DelegateResult['outcome']> {
    if (!value || !value.end || typeof value.end !== 'object') return false;
    if (!['unconfirmed', 'partial', 'empty'].includes(value.completeness)) return false;
    return ['finished', 'limit', 'uncertain', 'stopped', 'timeout', 'failed'].includes(value.end.kind);
}

export function buildDelegateBlockOptions(
    rawResult: DelegateResult | string,
    identity: { type: string; agentName?: string; query?: string },
): DelegateBlockOptions {
    const result = typeof rawResult === 'string' ? { result: rawResult } : rawResult;
    const outcome = hasStructuredOutcome(result.outcome) && (Array.isArray(result.effects) || Array.isArray(result.outcome.effects))
        ? { ...result.outcome, effects: Array.isArray(result.outcome.effects) ? result.outcome.effects : result.effects ?? [] } as RunOutcome
        : undefined;
    const thread = result.thread ?? (result.sub_id?.trim()
        ? { kind: 'reusable' as const, sub_id: result.sub_id }
        : { kind: 'unknown' as const });
    const common = {
        type: identity.type,
        agentName: identity.agentName || result.aspect || '',
        query: identity.query || '',
        toolsUsed: Array.isArray(result.tools_used) ? result.tools_used : [],
        toolCallDetails: Array.isArray(result.tool_call_details) ? result.tool_call_details : [],
        duration: typeof result.duration_ms === 'number' ? result.duration_ms : 0,
        usage: result.usage,
        ...(outcome ? { resultView: buildSubAgentResultView({
            name: identity.agentName || result.aspect || '',
            outcome,
            text: typeof result.result === 'string' ? result.result : result.result?.text,
            handoff: result.handoff || (typeof result.result === 'object' ? result.result.handoff : undefined),
            partialResult: result.partial_result,
            partialText: result.partial?.text,
            error: result.error,
            effects: result.effects,
            thread,
        }) } : {}),
    };
    if (toolResultStatus(result) === 'error') {
        const error = t('chat.streaming.error_prefix', { message: result.error || t('chat.subagent_notification.unknown_error') });
        const partial = typeof result.partial_result === 'string' && result.partial_result.trim() ? result.partial_result.trim() : '';
        return {
            ...common,
            status: 'error',
            response: partial ? `${error}\n\n${t('chat.subagent_notification.partial_heading')}\n${partial}` : error,
        };
    }
    return {
        ...common,
        status: 'success',
        aspectType: result.aspect_type || 'researcher',
        response: typeof result.result === 'string' ? result.result : '',
    };
}
