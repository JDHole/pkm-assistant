import { Validator } from '@cfworker/json-schema';
import { getPlanNodeLabel } from '../../sub-agents/index.js';
import type { PlanNode, PlanStatus, StripPlan } from '../../sub-agents/index.js';
import { t } from '../../../core/i18n/index.js';
import { toolResultStatus } from '../../../core/index.js';
import type { SubAgentToolCallDetail, SubAgentUsage } from '../../ui-components/index.js';
import type { RunOutcome } from '../../sub-agents/index.js';
import { buildParentConversationView } from './parentConversationView.js';
import { buildSubAgentResultView } from './subAgentResultView.js';

interface DelegateResult {
    parentConversation?: import('../../sub-agents/index.js').ParentConversationMetadata;
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
    question?: unknown;
    questionState?: import('../../sub-agents/index.js').QuestionState;
}

export interface DelegateBlockOptions {
    conversation?: import('../../ui-components/index.js').SubAgentConversationView;
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
        ...(result.parentConversation ? { conversation: buildParentConversationView(result.parentConversation) } : {}),
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
            question: result.question,
            questionState: result.questionState,
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

const planViewSchema = new Validator({
    type: 'object', required: ['plan_id', 'nodes'],
    anyOf: [{ required: ['started'], properties: { started: { const: true } } },
        { required: ['kind', 'status'], properties: { kind: { const: 'plan_result' } } }],
    properties: {
        plan_id: { type: 'string', minLength: 1 },
        status: { enum: ['active', 'completed', 'partial', 'stopped', 'interrupted'] },
        nodes: { type: 'array', minItems: 1, items: {
            type: 'object', required: ['id', 'depends_on', 'state'], properties: {
                id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' },
                depends_on: { type: 'array', items: { type: 'string' } },
                state: { type: 'object', required: ['kind'], properties: {
                    kind: { enum: ['waiting_dependencies', 'queued', 'running', 'done', 'error', 'blocked', 'stopped', 'not_executed', 'interrupted'] },
                    material: { type: 'string' }, error: { type: 'string' },
                    blocked_by: { type: 'array', items: { type: 'string' } },
                }, allOf: [{ if: { properties: { kind: { const: 'blocked' } } }, then: { required: ['blocked_by'] } }] },
            },
        } },
    },
});

/** Validate saved tool/notification data before producing presentation-only text. */
export function buildPlanView(raw: unknown, getPlan?: (id: string) => StripPlan | undefined, restored = false, translate = t) {
    if (!planViewSchema.validate(raw).valid) return undefined;
    const saved = raw as { plan_id: string; nodes: PlanNode[]; status?: PlanStatus; started?: boolean };
    const current = getPlan?.(saved.plan_id);
    const status = current?.status ?? saved.status ?? (restored ? 'interrupted' : 'active');
    const nodes = current?.nodes ?? saved.nodes.map(node => restored && saved.started ? { ...node,
        state: node.state.kind === 'running' ? { kind: 'interrupted' as const }
            : ['waiting_dependencies', 'queued'].includes(node.state.kind) ? { kind: 'not_executed' as const } : node.state,
    } : node);
    const summary = translate(`chat.plan.status.${status}`);
    const details = nodes.map(node => {
        const label = getPlanNodeLabel(node, nodes);
        return [`${node.id}: ${translate(label.key, label.params)}`, 'error' in node.state ? node.state.error : '',
            'material' in node.state ? node.state.material : ''].filter(Boolean).join('\n');
    }).join('\n\n');
    return { title: translate('chat.plan.name'), summary, details,
        status: status === 'active' ? 'attention' as const : status === 'completed' ? 'ok' as const : 'error' as const };
}

export function buildPlanBlockOptions(raw: unknown, getPlan?: (id: string) => StripPlan | undefined, restored = false): DelegateBlockOptions | undefined {
    const view = buildPlanView(raw, getPlan, restored);
    if (!view) return undefined;
    return { type: 'delegate', status: view.status === 'error' ? 'error' : 'success',
        resultView: { title: `${view.title} · ${view.summary}`, status: view.status,
            material: view.details, effects: [], missingTargets: [], notes: [] } };
}
