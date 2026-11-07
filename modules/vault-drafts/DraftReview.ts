import { DraftStore } from './DraftStore.js';
import { DraftPersistence } from './DraftPersistence.js';
import { DraftError } from './types.js';
import { parseVaultPath } from './schema.js';
import type { Change, ChangeId, DraftId, DraftIdentity, DraftManifest, DraftVaultIO, FileVersion, Revision, VaultPath } from './types.js';

/** Host uses vault.process (adapter.process for hidden text). Throwing in the callback
 * must leave the file unchanged. No modify fallback. Create operations are create-only. */
export interface DraftReviewIO extends DraftVaultIO {
    processText(path: VaultPath, transform: (current: string, mtime: number) => string): Promise<void>;
    createText(path: VaultPath, text: string): Promise<void>;
    createBinary(path: VaultPath, bytes: Uint8Array): Promise<void>;
    modifyBinary(path: VaultPath, bytes: Uint8Array): Promise<void>;
    createFolder(path: VaultPath): Promise<void>;
    deleteFile(path: VaultPath, disposition: 'trash' | 'permanent'): Promise<void>;
}
export type DraftPreview =
    | { kind: 'text'; oldContent: string; newContent: string }
    | { kind: 'deleted'; oldContent: string; newContent: '' }
    | { kind: 'binary'; operation: 'create' | 'replace' | 'delete'; oldBytes: number; newBytes: number; image?: Uint8Array }
    | { kind: 'folder' };
export interface DraftReviewContext {
    kind: 'main';
    owner: DraftIdentity['owner'];
    /** Re-evaluated before and after approval, including the source tool axis. */
    authorize(path: VaultPath, operation: 'read' | 'accept' | 'folder', change: Change): boolean;
    approve(change: Change, preview: DraftPreview): Promise<boolean>;
}
export type ReviewDecision =
    | { kind: 'accepted'; attemptId: string; applied: FileVersion }
    | { kind: 'rejected' }
    | { kind: 'conflict'; reason: 'base-changed' | 'dependency-changed' | 'ambiguous-input'; actual: FileVersion }
    | { kind: 'stale-revision' | 'not-sealed' | 'denied' }
    | { kind: 'recovery-required'; attemptId: string };
export type ChangeSummary = {
    draft_id: DraftId; change_id: ChangeId; path: VaultPath; kind: Change['proposed']['kind'];
    run_id: string; revision: Revision; status: Change['review']['kind'];
    old_bytes: number; new_bytes: number; source: Change['source'];
    preview?: Exclude<DraftPreview, { kind: 'binary' }> | Omit<Extract<DraftPreview, { kind: 'binary' }>, 'image'>;
    truncated?: boolean;
};
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function sameVersion(a: FileVersion, b: FileVersion): boolean {
    return a.kind === b.kind && (a.kind !== 'file' || b.kind === 'file'
        && a.hash === b.hash && a.bytes === b.bytes && a.mtime === b.mtime);
}
class ProcessConflict extends Error {}
export class DraftReview {
    constructor(private readonly store: DraftStore, private readonly persistence: DraftPersistence,
        private readonly vault: DraftReviewIO) {}
    private owns(context: DraftReviewContext | undefined, manifest: DraftManifest): context is DraftReviewContext {
        return context?.kind === 'main' && context.owner.agentName === manifest.owner.agentName;
    }
    async list(context: DraftReviewContext | undefined, input: {
        scope?: 'session' | 'agent'; draftId?: DraftId; changeId?: ChangeId; cursor?: string; includePreview?: boolean;
    }): Promise<{ kind: 'listed'; changes: ChangeSummary[]; next_cursor: string | null } | { kind: 'denied' }> {
        if (!context || context.kind !== 'main') return { kind: 'denied' };
        const rows: { manifest: DraftManifest; change: Change }[] = [];
        for (const manifest of this.store.list()) {
            if (!this.owns(context, manifest) || input.draftId && manifest.draftId !== input.draftId) continue;
            if (input.scope !== 'agent' && (manifest.owner.sessionPath !== context.owner.sessionPath
                || manifest.owner.sessionEpoch !== context.owner.sessionEpoch)) continue;
            for (const change of manifest.changes) {
                if ((!input.changeId || change.id === input.changeId) && context.authorize(change.path, 'read', change))
                    rows.push({ manifest, change });
            }
        }
        rows.sort((a, b) => (`${a.manifest.draftId}/${a.change.id}` < `${b.manifest.draftId}/${b.change.id}` ? -1 : 1));
        const start = input.cursor ? rows.findIndex(row => `${row.manifest.draftId}/${row.change.id}` > input.cursor!) : 0;
        const page = start < 0 ? [] : rows.slice(start, start + 50);
        const changes: ChangeSummary[] = [];
        for (const { manifest, change } of page) {
            const item: ChangeSummary = { draft_id: manifest.draftId, change_id: change.id, path: change.path,
                kind: change.proposed.kind, run_id: manifest.runId, revision: change.revision, status: change.review.kind,
                old_bytes: change.base.kind === 'file' ? change.base.version.bytes : 0,
                new_bytes: 'bytes' in change.proposed ? change.proposed.bytes : 0, source: change.source };
            if (input.changeId && input.includePreview !== false) {
                const preview = await this.preview(manifest.draftId, change);
                if (preview.kind === 'text' || preview.kind === 'deleted') {
                    item.truncated = preview.oldContent.length > 2000 || preview.newContent.length > 2000;
                    item.preview = preview.kind === 'text'
                        ? { ...preview, oldContent: preview.oldContent.slice(0, 2000), newContent: preview.newContent.slice(0, 2000) }
                        : { ...preview, oldContent: preview.oldContent.slice(0, 2000) };
                } else {
                    item.preview = preview.kind === 'binary' ? { kind: 'binary', operation: preview.operation,
                        oldBytes: preview.oldBytes, newBytes: preview.newBytes } : preview;
                    item.truncated = false;
                }
            }
            // No data escapes if permission was revoked during blob I/O.
            if (context.authorize(change.path, 'read', change)) changes.push(item);
        }
        const last = page.at(-1);
        return { kind: 'listed', changes, next_cursor: last && start + page.length < rows.length
            ? `${last.manifest.draftId}/${last.change.id}` : null };
    }
    private async preview(id: DraftId, change: Change): Promise<DraftPreview> {
        const value = change.proposed;
        if (value.kind === 'folder') return { kind: 'folder' };
        const oldBytes = change.base.kind === 'file' ? change.base.version.bytes : 0;
        const before = change.base.kind === 'file'
            ? await this.persistence.readBlob(id, change.base.blob, change.base.version.hash, oldBytes) : new Uint8Array();
        if (value.kind === 'binary') return { kind: 'binary', operation: change.base.kind === 'missing' ? 'create' : 'replace',
            oldBytes, newBytes: value.bytes, image: await this.persistence.readBlob(id, value.blob, value.hash, value.bytes) };
        if (value.kind === 'deleted') {
            // UTF-8 binary payloads are not necessarily text; only known textual extensions get a diff.
            if (!/\.(md|txt|json|js|ts|css|html|csv|yaml|yml|xml)$/i.test(change.path))
                return { kind: 'binary', operation: 'delete', oldBytes, newBytes: 0, image: before };
            return { kind: 'deleted', oldContent: decode(before), newContent: '' };
        }
        return { kind: 'text', oldContent: decode(before),
            newContent: decode(await this.persistence.readBlob(id, value.blob, value.hash, value.bytes)) };
    }
    private async version(path: VaultPath): Promise<FileVersion> {
        for (let n = 0; n < 3; n++) {
            const before = await this.vault.stat(path);
            const bytes = before.kind === 'file' ? await this.vault.read(path) : null;
            const after = await this.vault.stat(path);
            if (before.kind !== after.kind || before.kind === 'file' && (after.kind !== 'file'
                || before.mtime !== after.mtime || before.bytes !== after.bytes || bytes?.length !== before.bytes)) continue;
            if (before.kind !== 'file') return before;
            if (bytes) return { ...before, hash: await this.persistence.hash(bytes) };
        }
        throw new DraftError('base-unstable', 'Vault changed during review');
    }
    private async conflict(change: Change): Promise<Extract<ReviewDecision, { kind: 'conflict' }> | null> {
        const actual = await this.version(change.path);
        const expected = change.base.kind === 'file' ? change.base.version : change.base;
        return sameVersion(actual, expected) ? null : { kind: 'conflict',
            reason: change.inheritedFrom.length ? 'dependency-changed' : 'base-changed', actual };
    }
    decide(context: DraftReviewContext | undefined, input: {
        action: 'accept' | 'reject'; draftId: DraftId; changeId: ChangeId; revision: Revision;
    }): Promise<ReviewDecision> {
        const manifest = this.store.list().find(item => item.draftId === input.draftId);
        if (!manifest || !this.owns(context, manifest)) return Promise.resolve({ kind: 'denied' });
        const initial = manifest.changes.find(item => item.id === input.changeId);
        if (!initial) return Promise.resolve({ kind: 'denied' });
        return this.store.withReviewLock(initial.path, async () => {
            const fresh = this.store.snapshot(input.draftId);
            const change = fresh.changes.find(item => item.id === input.changeId)!;
            const operation = input.action === 'accept' ? 'accept' : 'read';
            if (!this.owns(context, fresh) || !context.authorize(change.path, operation, change)) return { kind: 'denied' };
            if (fresh.phase.kind !== 'sealed') return { kind: 'not-sealed' };
            if (change.revision !== input.revision) return { kind: 'stale-revision' };
            const save = async (state: Change['review']) => this.store.setReview(input.draftId, change.id, change.revision, state);
            switch (change.review.kind) {
                case 'accepted': case 'rejected': case 'recovery-required': return change.review;
                case 'applying': return { kind: 'recovery-required', attemptId: change.review.attemptId };
                case 'conflict': if (input.action === 'accept') return change.review; break;
                case 'pending': break;
                default: { const exhaustive: never = change.review; return exhaustive; }
            }
            if (input.action === 'reject') { await save({ kind: 'rejected' }); return { kind: 'rejected' }; }
            let conflict = await this.conflict(change);
            if (conflict) { await save(conflict); return conflict; }
            const parents: VaultPath[] = [];
            const parts = change.path.split('/');
            for (let i = 1; i < parts.length; i++) parents.push(parseVaultPath(parts.slice(0, i).join('/')));
            const allowed = async () => {
                if (!context.authorize(change.path, 'accept', change)) return false;
                for (const path of parents) {
                    const stat = await this.vault.stat(path);
                    if (stat.kind === 'file' || stat.kind === 'missing' && !context.authorize(path, 'folder', change)) return false;
                }
                return true;
            };
            if (!await allowed()) return { kind: 'denied' };
            const preview = await this.preview(input.draftId, change); // read failures deny closed, even in yolo
            if (!await context.approve(change, preview)) return { kind: 'denied' };
            if (!await allowed()) return { kind: 'denied' };
            if (this.store.snapshot(input.draftId).changes.find(item => item.id === change.id)?.revision !== input.revision)
                return { kind: 'stale-revision' };
            conflict = await this.conflict(change);
            if (conflict) { await save(conflict); return conflict; }
            // Applying + immutable intent are durable before any vault mutation.
            const attemptId = `${change.id}-${fresh.generation + 1}`;
            await save({ kind: 'applying', attemptId, approvedRevision: change.revision });
            try {
                for (const path of parents) if ((await this.vault.stat(path)).kind === 'missing') {
                    if (!context.authorize(path, 'folder', change)) throw new Error('Permission revoked');
                    try { await this.vault.createFolder(path); }
                    catch (error) { if ((await this.vault.stat(path)).kind !== 'folder') throw error; }
                }
                if (!context.authorize(change.path, 'accept', change)) throw new Error('Permission revoked');
                // All asynchronous preparation is complete before the final hash check.
                const value = change.proposed;
                const bytes = value.kind === 'binary' ? await this.persistence.readBlob(input.draftId, value.blob, value.hash, value.bytes) : null;
                conflict = await this.conflict(change);
                if (conflict) { await save(conflict); return conflict; }
                if (!context.authorize(change.path, 'accept', change)) throw new Error('Permission revoked');
                switch (value.kind) {
                    case 'text': {
                        if (preview.kind !== 'text') throw new Error('Invalid text preview');
                        if (change.base.kind === 'missing') await this.vault.createText(change.path, preview.newContent);
                        else {
                            const base = change.base;
                            await this.vault.processText(change.path, (current, mtime) => {
                                // Exact comparison to verified SHA-256 base bytes is stronger than a hash-only check.
                                if (base.kind !== 'file' || current !== preview.oldContent || mtime !== base.version.mtime)
                                    throw new ProcessConflict();
                                if (!context.authorize(change.path, 'accept', change)) throw new Error('Permission revoked');
                                return preview.newContent;
                            });
                        }
                        break;
                    }
                    case 'binary':
                        if (!bytes) throw new Error('Missing binary proposal');
                        if (change.base.kind === 'missing') await this.vault.createBinary(change.path, bytes);
                        else await this.vault.modifyBinary(change.path, bytes);
                        break;
                    case 'deleted':
                        if (change.base.kind !== 'missing') await this.vault.deleteFile(change.path, value.disposition);
                        break;
                    case 'folder': await this.vault.createFolder(change.path); break;
                    default: { const exhaustive: never = value; return exhaustive; }
                }
                const applied = await this.version(change.path);
                const matches = value.kind === 'folder' ? applied.kind === 'folder'
                    : value.kind === 'deleted' ? applied.kind === 'missing'
                    : applied.kind === 'file' && applied.hash === value.hash && applied.bytes === value.bytes;
                if (!matches) throw new Error('Applied result differs from the approved proposal');
                const accepted = { kind: 'accepted' as const, attemptId, applied };
                await save(accepted);
                return accepted;
            } catch (error) {
                if (error instanceof ProcessConflict) {
                    const actual = await this.version(change.path);
                    const result = { kind: 'conflict' as const, reason: 'base-changed' as const, actual };
                    await save(result); return result;
                }
                // A failed write/acknowledgement is uncertain. NEVER retry the vault operation.
                const result = { kind: 'recovery-required' as const, attemptId };
                try { await save(result); } catch { /* durable applying still forces recovery on restart */ }
                return result;
            }
        });
    }
}
