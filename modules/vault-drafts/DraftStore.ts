import { EventEmitter } from '../../core/index.js';
import { DraftPersistence } from './DraftPersistence.js';
import { parseChangeId, parseDraftId, parseDraftManifest, parseDraftMutation, parseRevision } from './schema.js';
import { DraftError } from './types.js';
import type { BaseSnapshot, ChangeId, ReviewState, Revision, DraftClock, DraftId, DraftManifest, DraftMutation, DraftPhase, DraftRef, DraftVaultIO, FirstTouch, ProposedValue, RecoveryIssue, VaultPath, VaultStat } from './types.js';

type Entry = { manifest: DraftManifest; persisted: boolean; closed: boolean; publication: Promise<void>; paths: Map<VaultPath, Promise<void>> };
type SealReason = Extract<DraftPhase, { kind: 'sealed' }>['reason'];
export class DraftStore {
    readonly events = new EventEmitter();
    private readonly references = new Map<DraftId, number>();
    private readonly collecting = new Set<DraftId>();
    private recoveryIssues = false;
    /** A view holds every layer it can read, including transitive predecessors. */
    retain(ids: readonly DraftId[]): () => void {
        const unique = [...new Set(ids)];
        for (const id of unique) {
            if (this.collecting.has(id) || this.get(id).manifest.payloadCollected) throw new DraftError('invalid-transition', 'Draft payload was collected');
        }
        for (const id of unique) this.references.set(id, (this.references.get(id) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const id of unique) {
                const count = (this.references.get(id) ?? 1) - 1;
                if (count) this.references.set(id, count); else this.references.delete(id);
            }
        };
    }
    async collectResolved(): Promise<void> {
        // Incomplete/future-format scans cannot prove that a blob is unreferenced.
        if (this.recoveryIssues) return;
        for (const [id, entry] of this.entries) await this.publish(entry, async () => {
            const old = entry.manifest;
            if (this.references.has(id) || old.phase.kind !== 'sealed'
                || old.changes.some(c => c.review.kind !== 'accepted' && c.review.kind !== 'rejected')) return;
            if (!entry.persisted) return; // Runner finalization may still read its empty reference.
            this.collecting.add(id);
            try {
                if (!old.payloadCollected) entry.manifest = await this.persistence.save({ ...old, payloadCollected: true }, () => !this.references.has(id));
                await this.persistence.collect(entry.manifest);
            } finally { this.collecting.delete(id); }
        });
    }
    private changed(entry: Entry): void { this.events.emit('draft:changed', structuredClone(entry.manifest)); }
    private readonly entries = new Map<DraftId, Entry>();
    private readonly decisions = new Map<VaultPath, Promise<void>>();
    constructor(private readonly persistence: DraftPersistence, private readonly vault: DraftVaultIO, private readonly clock: DraftClock) {}
    /** Validates untrusted identity; no files or directories until the first net mutation. */
    async create(identity: unknown): Promise<DraftManifest> {
        if (typeof identity !== 'object' || identity === null) throw new DraftError('invalid-manifest', 'Invalid draft identity');
        const now = this.clock.now();
        const manifest = parseDraftManifest({ ...identity, version: 1, generation: 1, revision: 1,
            createdAt: now, updatedAt: now, phase: { kind: 'open' }, changes: [], firstTouches: [] });
        parseDraftId(manifest.draftId);
        if (this.entries.has(manifest.draftId) || await this.persistence.hasDraft(manifest.draftId))
            throw new DraftError('draft-exists', 'Draft ID already exists');
        // Recheck after the asynchronous storage boundary.
        if (this.entries.has(manifest.draftId)) throw new DraftError('draft-exists', 'Draft ID already exists');
        this.entries.set(manifest.draftId, this.entry(manifest, false));
        return structuredClone(manifest);
    }
    private entry(manifest: DraftManifest, persisted: boolean): Entry {
        return { manifest, persisted, closed: manifest.phase.kind === 'sealed', publication: Promise.resolve(), paths: new Map() };
    }
    private get(id: DraftId): Entry {
        const entry = this.entries.get(parseDraftId(id));
        if (!entry) throw new DraftError('draft-not-found', 'Unknown draft');
        return entry;
    }
    snapshot(id: DraftId): DraftManifest { return structuredClone(this.get(id).manifest); }
    list(): readonly DraftManifest[] { return [...this.entries.values()].map(entry => structuredClone(entry.manifest)); }
    /** Shared by ALL reviewers/sessions of this store, including different draft IDs. */
    withReviewLock<T>(path: VaultPath, operation: () => Promise<T>): Promise<T> {
        const result = (this.decisions.get(path) ?? Promise.resolve()).then(operation);
        const tail = result.then(() => {}, () => {});
        this.decisions.set(path, tail);
        void tail.then(() => { if (this.decisions.get(path) === tail) this.decisions.delete(path); });
        return result;
    }
    /** Trusted review journal. Content revision is immutable; only generation advances.
     * Applying is published before the separate intent record. Restore never replays it. */
    setReview(id: DraftId, changeId: ChangeId, revision: Revision, review: ReviewState): Promise<void> {
        const entry = this.get(id);
        return this.publish(entry, async () => {
            const old = entry.manifest;
            const change = old.changes.find(item => item.id === changeId);
            if (old.phase.kind !== 'sealed' || !change || change.revision !== revision)
                throw new DraftError('invalid-transition', 'Review requires a sealed, current change');
            const from = change.review.kind, to = review.kind;
            if (!(from === 'pending' && ['rejected', 'conflict', 'applying'].includes(to)
                || from === 'conflict' && to === 'rejected'
                || from === 'applying' && ['accepted', 'conflict', 'recovery-required'].includes(to)))
                throw new DraftError('invalid-transition', 'Invalid review transition');
            entry.manifest = await this.persistence.save({ ...old,
                changes: old.changes.map(item => item.id === changeId ? { ...item, review } : item),
                updatedAt: this.clock.now(),
            }, () => true);
            this.changed(entry);
            if (review.kind === 'applying') await this.persistence.writeIntent(entry.manifest, change, review.attemptId);
        });
    }
    private requireOpen(entry: Entry): void {
        if (entry.closed) throw new DraftError('draft-closed', 'Draft is sealed');
    }
    private publish<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
        const result = entry.publication.then(operation);
        entry.publication = result.then(() => {}, () => {});
        return result;
    }
    mutate(id: DraftId, input: DraftMutation, inheritedFrom: readonly DraftRef[] = []): Promise<DraftManifest> {
        const entry = this.get(id);
        this.requireOpen(entry);
        const mutation = parseDraftMutation(input);
        const inherited = inheritedFrom.map(ref => {
            const manifest = this.snapshot(ref.draftId);
            const change = manifest.changes.find(item => item.path === mutation.path);
            if (manifest.phase.kind !== 'sealed' || manifest.revision !== ref.revision || !change)
                throw new DraftError('invalid-transition', 'Invalid predecessor reference');
            return { ref: { ...ref }, change };
        });
        const previous = entry.paths.get(mutation.path) ?? Promise.resolve();
        const result = previous.then(async () => {
            this.requireOpen(entry);
            const first = entry.manifest.firstTouches.find(item => item.path === mutation.path);
            let base = first?.base;
            if (!base && inherited.length) {
                const inheritedBase = inherited[0].change.base;
                if (inherited.some(item => JSON.stringify(item.change.base) !== JSON.stringify(inheritedBase)))
                    throw new DraftError('ambiguous-input', 'Predecessors have different conflict bases');
                if (inheritedBase.kind === 'file') {
                    const bytes = await this.persistence.readBlob(inherited[0].ref.draftId, inheritedBase.blob, inheritedBase.version.hash, inheritedBase.version.bytes);
                    await this.persistence.putBlob(id, bytes);
                }
                base = inheritedBase;
            }
            base ??= await this.captureBase(id, mutation.path);
            const current = entry.manifest.changes.find(item => item.path === mutation.path)?.proposed ?? inherited[0]?.change.proposed;
            const kind = current?.kind === 'deleted' ? 'missing' : current?.kind ?? base.kind;
            if (kind === 'folder' || mutation.value.kind === 'folder' && (kind !== 'missing' || base.kind !== 'missing')
                || mutation.value.kind === 'deleted' && kind === 'missing')
                throw new DraftError('invalid-transition', 'Cannot replace a folder, delete a missing file, or create a folder over a file');
            const proposed = await this.propose(id, mutation.value);
            return this.publish(entry, async () => {
                this.requireOpen(entry);
                const old = entry.manifest;
                const revision = parseRevision(entry.persisted ? old.revision + 1 : 1);
                const touch: FirstTouch = first ?? { id: parseChangeId(`change-${revision}`), path: mutation.path, base };
                const changes = old.changes.filter(item => item.path !== mutation.path);
                const origins = old.changes.find(item => item.path === mutation.path)?.inheritedFrom ?? inherited.map(item => item.ref);
                if (!(base.kind === 'missing' && proposed.kind === 'deleted' && !origins.length)) changes.push({ ...touch, proposed, revision,
                    review: { kind: 'pending' }, inheritedFrom: origins, source: mutation.source });
                const manifest = await this.persistence.save({ ...old, revision,
                    generation: entry.persisted ? old.generation : 0,
                    updatedAt: this.clock.now(), changes,
                    firstTouches: first ? old.firstTouches : [...old.firstTouches, touch],
                }, () => !entry.closed);
                entry.manifest = manifest;
                entry.persisted = true;
                this.changed(entry);
                return structuredClone(manifest);
            });
        });
        const tail = result.then(() => {}, () => {});
        entry.paths.set(mutation.path, tail);
        void tail.then(() => { if (entry.paths.get(mutation.path) === tail) entry.paths.delete(mutation.path); });
        return result;
    }
    private async captureBase(id: DraftId, path: VaultPath): Promise<BaseSnapshot> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const before = await this.readIO(() => this.vault.stat(path));
            const bytes = before.kind === 'file' ? await this.readIO(() => this.vault.read(path)) : undefined;
            const after = await this.readIO(() => this.vault.stat(path));
            if (!this.sameStat(before, after) || before.kind === 'file' && bytes?.byteLength !== before.bytes) continue;
            switch (before.kind) {
                case 'missing': return { kind: 'missing' };
                case 'folder': return { kind: 'folder' };
                case 'file': {
                    if (!bytes) throw new DraftError('io-error', 'Missing base bytes');
                    const blob = await this.persistence.putBlob(id, bytes);
                    return { kind: 'file', blob: blob.blob, version: { kind: 'file', hash: blob.hash, bytes: blob.bytes, mtime: before.mtime } };
                }
                default: { const exhaustive: never = before; return exhaustive; }
            }
        }
        throw new DraftError('base-unstable', 'Vault changed during base capture');
    }
    private async readIO<T>(operation: () => Promise<T>): Promise<T> {
        try { return await operation(); }
        catch (cause) { throw new DraftError('io-error', 'Cannot read draft base', { cause }); }
    }
    private sameStat(a: VaultStat, b: VaultStat): boolean {
        return a.kind === b.kind && (a.kind !== 'file' || b.kind === 'file' && a.mtime === b.mtime && a.bytes === b.bytes);
    }
    private async propose(id: DraftId, value: DraftMutation['value']): Promise<ProposedValue> {
        switch (value.kind) {
            case 'text': return { kind: 'text', ...await this.persistence.putBlob(id, new TextEncoder().encode(value.text)) };
            case 'binary': return { kind: 'binary', ...await this.persistence.putBlob(id, value.bytes) };
            case 'folder': return { kind: 'folder' };
            case 'deleted': return { kind: 'deleted', disposition: value.disposition };
            default: { const exhaustive: never = value; return exhaustive; }
        }
    }
    /** Revokes publication synchronously, even if base/blob I/O is still pending. */
    seal(id: DraftId, reason: SealReason): Promise<DraftManifest> {
        const entry = this.get(id);
        entry.closed = true;
        return this.publish(entry, async () => {
            if (entry.manifest.phase.kind === 'sealed') return structuredClone(entry.manifest);
            const manifest = parseDraftManifest({ ...entry.manifest, phase: { kind: 'sealed', reason }, updatedAt: this.clock.now() });
            entry.manifest = entry.persisted ? await this.persistence.save(manifest, () => true) : manifest;
            this.changed(entry);
            return structuredClone(entry.manifest);
        });
    }
    /** Call on a fresh store before admitting runs. Never resumes execution. */
    async restore(): Promise<{ drafts: readonly DraftManifest[]; issues: readonly RecoveryIssue[] }> {
        if (this.entries.size) throw new DraftError('draft-exists', 'Restore requires an empty store');
        const recovered = await this.persistence.loadAll();
        this.recoveryIssues = recovered.issues.length > 0;
        const restored: DraftManifest[] = [];
        for (const input of recovered.manifests) {
            const changes = input.changes.map(change => change.review.kind === 'applying'
                ? { ...change, review: { kind: 'recovery-required', attemptId: change.review.attemptId } as const } : change);
            const needsSave = input.phase.kind === 'open' || input.changes.some(change => change.review.kind === 'applying');
            const manifest = needsSave ? await this.persistence.save({ ...input, changes,
                phase: input.phase.kind === 'open' ? { kind: 'sealed', reason: 'restart' } : input.phase,
                updatedAt: Math.max(input.updatedAt, this.clock.now()),
            }, () => true) : input;
            restored.push(manifest);
        }
        if (this.entries.size) throw new DraftError('draft-exists', 'Store changed during restore');
        for (const manifest of restored) this.entries.set(manifest.draftId, this.entry(manifest, true));
        return { drafts: this.list(), issues: recovered.issues };
    }
}
