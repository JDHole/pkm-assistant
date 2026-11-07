import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import { parseChangeId, parseDraftId, parseRevision } from '../vault-drafts/index.js';
import type { DraftReview } from '../vault-drafts/index.js';
import type { ToolDefinition, BuiltinToolExecutionContext } from './ToolRegistry.js';

type Input = { action: 'list'; scope?: 'session' | 'agent'; draft_id?: string; change_id?: string; cursor?: string }
    | { action: 'accept' | 'reject'; draft_id: string; change_id: string; revision: number };
function schema(): Schema {
    const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } satisfies Schema;
    const common = { draft_id: { ...id, description: t('mcp.subagent_changes.param.draft_id') },
        change_id: { ...id, description: t('mcp.subagent_changes.param.change_id') } };
    return { oneOf: [
        { type: 'object', additionalProperties: false, required: ['action'],
            properties: { action: { const: 'list', description: t('mcp.subagent_changes.param.action') }, ...common,
                scope: { enum: ['session', 'agent'], description: t('mcp.subagent_changes.param.scope') },
                cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}$', description: t('mcp.subagent_changes.param.cursor') } },
            if: { required: ['change_id'] }, then: { required: ['draft_id'] } },
        ...(['accept', 'reject'] as const).map(action => ({ type: 'object', additionalProperties: false,
            required: ['action', 'draft_id', 'change_id', 'revision'], properties: { ...common,
                action: { const: action, description: t('mcp.subagent_changes.param.action') },
                revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: t('mcp.subagent_changes.param.revision') } } } satisfies Schema)),
    ] };
}
/** P4 exports the factory; P5 registers it only after store restore. Arguments are NEVER authority. */
export function createSubagentChangesTool(review: DraftReview): ToolDefinition {
    const inputSchema = schema();
    const validator = new Validator(inputSchema);
    return {
        name: 'subagent_changes', source: 'built-in', description: t('mcp.subagent_changes.desc'), inputSchema,
        async execute(raw: unknown, _app?: unknown, _plugin?: unknown, context?: BuiltinToolExecutionContext) {
            const denied = { kind: 'denied', isError: true, message: t('mcp.subagent_changes.denied') };
            if (!context?.draftReview || context.shouldAbort()) return denied;
            if (!validator.validate(raw).valid) return { ...denied, message: t('mcp.subagent_changes.invalid_args') };
            const input = raw as Input; // Complete oneOf validation above, no invocation fields admitted.
            try {
                const result = input.action === 'list'
                    ? await review.list(context.draftReview, { scope: input.scope,
                        draftId: input.draft_id ? parseDraftId(input.draft_id) : undefined,
                        changeId: input.change_id ? parseChangeId(input.change_id) : undefined, cursor: input.cursor })
                    : await review.decide(context.draftReview, { action: input.action,
                        draftId: parseDraftId(input.draft_id), changeId: parseChangeId(input.change_id), revision: parseRevision(input.revision) });
                switch (result.kind) {
                    case 'listed': case 'accepted': case 'rejected': return result;
                    case 'conflict': {
                        const listed = await review.list(context.draftReview, { scope: 'agent', draftId: parseDraftId(input.draft_id), changeId: parseChangeId(input.change_id), includePreview: false });
                        const path = listed.kind === 'listed' ? listed.changes.find(item => item.change_id === input.change_id)?.path ?? '' : '';
                        return { ...result, isError: true, message: t('mcp.subagent_changes.conflict', { path }) };
                    }
                    case 'stale-revision': return { ...result, isError: true, message: t('mcp.subagent_changes.stale_revision') };
                    case 'not-sealed': return { ...result, isError: true, message: t('mcp.subagent_changes.not_sealed') };
                    case 'recovery-required': return { ...result, isError: true, message: t('mcp.subagent_changes.recovery_required') };
                    case 'denied': return denied;
                    default: { const exhaustive: never = result; return exhaustive; }
                }
            } catch (error) {
                log.warn('SubagentChangesTool', 'Draft review failed closed', error);
                return { ...denied, message: t('mcp.subagent_changes.read_error') };
            }
        },
    };
}
