import { t } from '../../../core/i18n/index.js';
import { toolResultStatus } from '../../../core/index.js';
import type { SubAgentToolCallDetail, SubAgentUsage } from '../../ui-components/index.js';

interface DelegateResult {
    isError?: boolean;
    success?: boolean;
    error?: string;
    partial_result?: string;
    aspect?: string;
    aspect_type?: string;
    result?: string;
    tools_used?: string[];
    tool_call_details?: SubAgentToolCallDetail[];
    duration_ms?: number;
    usage?: SubAgentUsage | null;
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
}

export function buildDelegateBlockOptions(
    rawResult: DelegateResult | string,
    identity: { type: string; agentName?: string; query?: string },
): DelegateBlockOptions {
    const result = typeof rawResult === 'string' ? { result: rawResult } : rawResult;
    const common = {
        type: identity.type,
        agentName: identity.agentName || result.aspect || '',
        query: identity.query || '',
        toolsUsed: Array.isArray(result.tools_used) ? result.tools_used : [],
        toolCallDetails: Array.isArray(result.tool_call_details) ? result.tool_call_details : [],
        duration: typeof result.duration_ms === 'number' ? result.duration_ms : 0,
        usage: result.usage,
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
