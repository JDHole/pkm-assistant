import { Validator } from '@cfworker/json-schema';
import type { DraftManifest, DraftRef, Change } from './types.js';
export interface DraftSummary {
    owner: DraftManifest['owner'];
    ref: DraftRef;
    pending: number; conflicts: number; accepted: number; rejected: number;
    changes: Array<{ path: string; status: Change['review']['kind'] }>;
}
export function summarizeDraft(manifest: DraftManifest): DraftSummary | undefined {
    if (!manifest.changes.length) return undefined;
    const summary: DraftSummary = { owner: manifest.owner, ref: { draftId: manifest.draftId, revision: manifest.revision },
        pending: 0, conflicts: 0, accepted: 0, rejected: 0, changes: [] };
    for (const change of manifest.changes) {
        const status = change.review.kind;
        summary.changes.push({ path: change.path, status });
        switch (status) {
            case 'pending': case 'applying': summary.pending++; break;
            case 'conflict': case 'recovery-required': summary.conflicts++; break;
            case 'accepted': summary.accepted++; break;
            case 'rejected': summary.rejected++; break;
            default: { const exhaustive: never = status; return exhaustive; }
        }
    }
    return summary;
}

const validator = new Validator({ type: 'object', additionalProperties: false,
    required: ['owner', 'ref', 'pending', 'conflicts', 'accepted', 'rejected', 'changes'], properties: {
        owner: { type: 'object', additionalProperties: false, required: ['agentName', 'sessionPath', 'sessionEpoch'], properties: {
            agentName: { type: 'string', minLength: 1 }, sessionPath: { type: 'string', minLength: 1 }, sessionEpoch: { type: 'string', pattern: '^[0-9a-f]{32}$' } } },
        ref: { type: 'object', additionalProperties: false, required: ['draftId', 'revision'], properties: {
            draftId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' }, revision: { type: 'integer', minimum: 1 } } },
        ...Object.fromEntries(['pending', 'conflicts', 'accepted', 'rejected'].map(key => [key, { type: 'integer', minimum: 0 }])),
        changes: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['path', 'status'], properties: {
            path: { type: 'string', minLength: 1 }, status: { enum: ['pending', 'applying', 'conflict', 'recovery-required', 'accepted', 'rejected'] } } } },
    } });
export function parseDraftSummary(input: unknown): DraftSummary | undefined {
    if (input === undefined || typeof input !== 'object' || input === null) return undefined;
    return validator.validate(input).valid ? structuredClone(input) as DraftSummary : undefined;
}
