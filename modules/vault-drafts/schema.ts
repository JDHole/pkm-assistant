import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';
import { DraftError } from './types.js';
import type { BlobId, ChangeId, ContentHash, DraftId, DraftManifest, DraftMutation, Revision, VaultPath, DraftErrorCode, BaseSnapshot, FileVersion } from './types.js';

const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
    ({ type: 'object', properties, required, additionalProperties: false });
const choice = (...values: string[]): Schema => ({ enum: values });
const text: Schema = { type: 'string', minLength: 1 };
const id: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const hash: Schema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const integer: Schema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const revision: Schema = { ...integer, minimum: 1 };
const time: Schema = { type: 'number', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const path: Schema = { type: 'string', minLength: 1, maxLength: 4096,
    not: { pattern: '^\\.pkm-assistant/subagent-drafts(?:/|$)'.replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`) },
    pattern: '^(?![A-Za-z]:)(?!.*[\\\\\u0000-\u001f\u007f])(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?!.* /)(?!.*[ .]$)(?!.*[ .]/)(?!\\.pkm-assistant/subagent-drafts(?:/|$)).*[^/]$' };
const file: Schema = object({ kind: { const: 'file' }, hash, bytes: integer, mtime: time });
const absent: Schema[] = [object({ kind: { const: 'missing' } }), object({ kind: { const: 'folder' } })];
const version: Schema = { oneOf: [...absent, file] };
const base: Schema = { oneOf: [...absent, object({ kind: { const: 'file' }, version: file, blob: hash })] };
const proposed: Schema = { oneOf: [
    object({ kind: choice('text', 'binary'), blob: hash, hash, bytes: integer }),
    object({ kind: { const: 'folder' } }),
    object({ kind: { const: 'deleted' }, disposition: choice('trash', 'permanent') }),
] };
const review: Schema = { oneOf: [
    object({ kind: choice('pending', 'rejected') }),
    object({ kind: { const: 'conflict' }, reason: choice('base-changed', 'dependency-changed', 'ambiguous-input'), actual: version }),
    object({ kind: { const: 'applying' }, attemptId: id, approvedRevision: revision }),
    object({ kind: { const: 'accepted' }, attemptId: id, applied: version }),
    object({ kind: { const: 'recovery-required' }, attemptId: id }),
] };
const source: Schema = object({ tool: text, callId: text });
const touch = { id, path, base };
const manifestValidator = new Validator(object({
    version: { const: 1 }, draftId: id, generation: revision, revision,
    owner: object({ agentName: text, sessionPath: text, sessionEpoch: { type: 'string', pattern: '^[0-9a-f]{32}$' } }),
    runId: text, threadId: text, plan: object({ planId: id, nodeId: id }),
    createdAt: time, updatedAt: time,
    phase: { oneOf: [object({ kind: { const: 'open' } }), object({ kind: { const: 'sealed' }, reason: choice('finished', 'stopped', 'timeout', 'failed', 'restart') })] },
    firstTouches: { type: 'array', items: object(touch) },
    changes: { type: 'array', items: object({ ...touch, proposed, revision, review, source,
        inheritedFrom: { type: 'array', uniqueItems: true, items: object({ draftId: id, revision }) },
    }) },
}, ['version', 'draftId', 'generation', 'revision', 'owner', 'runId', 'threadId', 'createdAt', 'updatedAt', 'phase', 'firstTouches', 'changes']));
function validated<T>(value: unknown, schema: Schema, code: DraftErrorCode): T {
    if (!new Validator(schema).validate(value).valid) throw new DraftError(code, code);
    return value as T; // The complete external value was validated above.
}
export const parseDraftId = (value: unknown): DraftId => validated(value, id, 'invalid-id');
export const parseChangeId = (value: unknown): ChangeId => validated(value, id, 'invalid-id');
export const parseBlobId = (value: unknown): BlobId => validated(value, hash, 'invalid-hash');
export const parseContentHash = (value: unknown): ContentHash => validated(value, hash, 'invalid-hash');
export const parseRevision = (value: unknown): Revision => validated(value, revision, 'invalid-revision');
export const parseVaultPath = (value: unknown): VaultPath => validated(value, path, 'invalid-path');
export function parseDraftManifest(value: unknown): DraftManifest {
    if (typeof value === 'object' && value !== null && 'version' in value && value.version !== 1)
        throw new DraftError('invalid-version', 'Unsupported draft manifest version');
    if (!manifestValidator.validate(value).valid) throw new DraftError('invalid-manifest', 'Invalid draft manifest');
    const manifest = value as DraftManifest;
    const paths = new Set<string>(), ids = new Set<string>(), changed = new Set<string>();
    for (const entry of manifest.firstTouches) {
        if (paths.has(entry.path) || ids.has(entry.id) || (entry.base.kind === 'file' && (entry.base.blob !== String(entry.base.version.hash) || !finiteVersion(entry.base.version))))
            throw new DraftError('invalid-manifest', 'Duplicate touch or inconsistent base hash');
        paths.add(entry.path); ids.add(entry.id);
    }
    for (const change of manifest.changes) {
        const original = manifest.firstTouches.find(entry => entry.path === change.path);
        if (!original || original.id !== change.id || !sameBase(original.base, change.base)
            || changed.has(change.path) || change.revision > manifest.revision
            || (change.proposed.kind === 'text' || change.proposed.kind === 'binary') && change.proposed.blob !== String(change.proposed.hash)
            || change.base.kind === 'folder' || change.proposed.kind === 'folder' && change.base.kind !== 'missing'
            || change.proposed.kind === 'deleted' && change.base.kind === 'missing' && !change.inheritedFrom.length
            || change.review.kind === 'applying' && change.review.approvedRevision !== change.revision
            || change.review.kind === 'conflict' && !finiteVersion(change.review.actual)
            || change.review.kind === 'accepted' && !finiteVersion(change.review.applied))
            throw new DraftError('invalid-manifest', 'Inconsistent change');
        changed.add(change.path);
    }
    if (!Number.isFinite(manifest.createdAt) || !Number.isFinite(manifest.updatedAt) || manifest.updatedAt < manifest.createdAt) throw new DraftError('invalid-manifest', 'Invalid timestamp order');
    return structuredClone(manifest);
}
function finiteVersion(value: FileVersion): boolean {
    return value.kind !== 'file' || Number.isFinite(value.mtime);
}
function sameBase(a: BaseSnapshot, b: BaseSnapshot): boolean {
    switch (a.kind) {
        case 'missing': case 'folder': return a.kind === b.kind;
        case 'file': return b.kind === 'file' && a.blob === b.blob && a.version.hash === b.version.hash
            && a.version.bytes === b.version.bytes && a.version.mtime === b.version.mtime;
        default: { const exhaustive: never = a; return exhaustive; }
    }
}
export function parseDraftMutation(value: unknown): DraftMutation {
    // Binary arrays are not JSON; validate metadata and the binary boundary separately.
    const input = validated<{ path: VaultPath; source: DraftMutation['source']; value: unknown }>(value,
        object({ path, source, value: {} }), 'invalid-mutation');
    const content = input.value;
    if (typeof content === 'object' && content !== null && 'kind' in content && content.kind === 'binary'
        && 'bytes' in content && content.bytes instanceof Uint8Array && Object.keys(content).length === 2)
        return { path: input.path, source: structuredClone(input.source), value: { kind: 'binary', bytes: content.bytes.slice() } };
    validated(content, { oneOf: [object({ kind: { const: 'text' }, text: { type: 'string' } }),
        object({ kind: { const: 'folder' } }), object({ kind: { const: 'deleted' }, disposition: choice('trash', 'permanent') })] }, 'invalid-mutation');
    return structuredClone(input) as DraftMutation; // Metadata and the entire value have been validated.
}
