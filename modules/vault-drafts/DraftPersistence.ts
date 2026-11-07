import { Validator } from '@cfworker/json-schema';
import { DraftError } from './types.js';
import type { BaseSnapshot, BlobId, Change, ContentHash, DraftHasher, DraftId, DraftManifest, DraftStorageIO, RecoveryIssue } from './types.js';
import { parseBlobId, parseChangeId, parseContentHash, parseDraftId, parseDraftManifest } from './schema.js';

export const DRAFT_ROOT = '.pkm-assistant/subagent-drafts/v1';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const envelopeValidator = new Validator({ type: 'object', additionalProperties: false,
    required: ['payload', 'checksum'], properties: { payload: { type: 'string' }, checksum: { type: 'string', pattern: '^[0-9a-f]{64}$' } } });
function parseJSON(bytes: Uint8Array): unknown {
    try { return JSON.parse(decode(bytes)); }
    catch (cause) { throw new DraftError('invalid-manifest', 'Invalid manifest JSON or UTF-8', { cause }); }
}
const generationName = /^(\d{6,16})\.json$/;
export class DraftPersistence {
    constructor(private readonly io: DraftStorageIO, private readonly hasher: DraftHasher) {}
    private directory(id: DraftId): string { return `${DRAFT_ROOT}/${parseDraftId(id)}`; }
    async hash(bytes: Uint8Array): Promise<ContentHash> { return parseContentHash(await this.hasher.sha256(bytes)); }
    async putBlob(id: DraftId, bytes: Uint8Array): Promise<{ blob: BlobId; hash: ContentHash; bytes: number }> {
        const owned = bytes.slice();
        const hash = await this.hash(owned), blob = parseBlobId(hash);
        try {
            await this.io.writeBlob(`${this.directory(id)}/blobs/${blob}`, owned);
            await this.readBlob(id, blob, hash, owned.byteLength);
            return { blob, hash, bytes: owned.byteLength };
        } catch (cause) { throw new DraftError('io-error', 'Cannot persist draft blob', { cause }); }
    }
    async readBlob(id: DraftId, blob: BlobId, hash: ContentHash, bytes: number): Promise<Uint8Array> {
        const value = await this.io.read(`${this.directory(id)}/blobs/${parseBlobId(blob)}`);
        if (value.byteLength !== bytes || await this.hash(value) !== hash)
            throw new DraftError('integrity-error', 'Draft blob checksum mismatch');
        return value.slice();
    }
    private async verifyBase(id: DraftId, base: BaseSnapshot): Promise<void> {
        if (base.kind === 'file') await this.readBlob(id, base.blob, base.version.hash, base.version.bytes);
    }
    private async verifyBlobs(manifest: DraftManifest): Promise<void> {
        for (const touch of manifest.firstTouches) await this.verifyBase(manifest.draftId, touch.base);
        for (const change of manifest.changes) {
            const value = change.proposed;
            if (value.kind === 'text' || value.kind === 'binary')
                await this.readBlob(manifest.draftId, value.blob, value.hash, value.bytes);
        }
    }
    async hasDraft(id: DraftId): Promise<boolean> { return (await this.io.list(this.directory(id))).length > 0; }
    /** Immutable intent record. The applying manifest is published FIRST, so a crash at
     * either boundary is recoverable without guessing whether the vault was changed. */
    async writeIntent(manifest: DraftManifest, change: Change, attemptId: string): Promise<void> {
        const payload = JSON.stringify({ version: 1, draftId: manifest.draftId,
            attemptId: parseChangeId(attemptId), changeId: change.id, revision: change.revision,
            path: change.path, base: change.base, proposed: change.proposed });
        const bytes = encode(JSON.stringify({ payload, checksum: await this.hash(encode(payload)) }));
        const path = `${this.directory(manifest.draftId)}/decisions/${attemptId}.json`;
        if (await this.io.publish(path, bytes, () => true) !== 'published'
            || decode(await this.io.read(path)) !== decode(bytes))
            throw new DraftError('io-error', 'Cannot persist acceptance intent');
    }
    async save(input: DraftManifest, mayPublish: () => boolean): Promise<DraftManifest> {
        try {
            const directory = `${this.directory(input.draftId)}/manifests`;
            const names = await this.io.list(directory);
            const generations = names.filter(name => generationName.test(name)).map(name => Number(name.slice(0, -5)));
            const generation = generations.reduce((highest, value) => Math.max(highest, value), Math.max(input.generation, 0)) + 1;
            const manifest = parseDraftManifest({ ...input, generation });
            await this.verifyBlobs(manifest);
            const payload = JSON.stringify(manifest);
            const bytes = encode(JSON.stringify({ payload, checksum: await this.hash(encode(payload)) }));
            const path = `${directory}/${String(generation).padStart(6, '0')}.json`;
            if (await this.io.publish(path, bytes, mayPublish) === 'cancelled')
                throw new DraftError('draft-closed', 'Draft publication was revoked');
            // Success includes a readback; an adapter cannot silently acknowledge truncated data.
            const stored = await this.io.read(path);
            if (decode(stored) !== decode(bytes)) throw new DraftError('integrity-error', 'Manifest readback mismatch');
            return manifest;
        } catch (cause) {
            if (cause instanceof DraftError) throw cause;
            throw new DraftError('io-error', 'Cannot publish draft manifest', { cause });
        }
    }
    async loadAll(): Promise<{ manifests: DraftManifest[]; issues: RecoveryIssue[] }> {
        const manifests: DraftManifest[] = [], issues: RecoveryIssue[] = [];
        for (const name of await this.io.list(DRAFT_ROOT)) {
            try {
                const id = parseDraftId(name);
                const directory = `${this.directory(id)}/manifests`;
                const names = await this.io.list(directory);
                for (const entry of names.filter(value => !generationName.test(value)))
                    issues.push({ path: `${directory}/${entry}`, code: 'invalid-manifest', message: 'Unrecognized manifest filename' });
                const generations = names.filter(value => generationName.test(value))
                    .sort((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)));
                for (const entry of generations) {
                    const path = `${directory}/${entry}`;
                    try {
                        const value: unknown = parseJSON(await this.io.read(path));
                        if (!envelopeValidator.validate(value).valid) throw new DraftError('invalid-manifest', 'Invalid manifest envelope');
                        const envelope = value as { payload: string; checksum: string };
                        if (await this.hash(encode(envelope.payload)) !== envelope.checksum)
                            throw new DraftError('integrity-error', 'Manifest checksum mismatch');
                        const payload: unknown = parseJSON(encode(envelope.payload));
                        const manifest = parseDraftManifest(payload);
                        if (manifest.draftId !== id || manifest.generation !== Number(entry.slice(0, -5)))
                            throw new DraftError('invalid-manifest', 'Manifest location mismatch');
                        await this.verifyBlobs(manifest);
                        manifests.push(manifest);
                        break;
                    } catch (cause) {
                        issues.push(this.issue(path, cause));
                        // Do not overwrite an unrecognized future format with an older generation.
                        if (cause instanceof DraftError && cause.code === 'invalid-version') break;
                    }
                }
            } catch (cause) { issues.push(this.issue(`${DRAFT_ROOT}/${name}`, cause)); }
        }
        return { manifests, issues };
    }
    private issue(path: string, cause: unknown): RecoveryIssue {
        return { path, code: cause instanceof DraftError ? cause.code : 'io-error',
            message: cause instanceof Error ? cause.message : 'Draft recovery failed' };
    }
}
