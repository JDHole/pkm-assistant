import { DraftError, DraftView } from '../vault-drafts/index.js';
import type { DraftStore, DraftPersistence, DraftViewIO, DraftId, DraftRef, DraftPhase, DraftIdentity, FrozenDraftView } from '../vault-drafts/index.js';
import type { VaultExecution } from '../tools/index.js';
import type { SubTaskOrigin } from './SubTaskRegistry.js';

type SealReason = Extract<DraftPhase, { kind: 'sealed' }>['reason'];
type ClosedRun = { owner: DraftIdentity['owner']; layers: readonly FrozenDraftView[] };

/** Shared by runners, injected explicitly; production composition remains disconnected.
 * Frozen inputs live independently of registry retention. No input comes from tool args.
 */
export class SubRunDrafts {
    private readonly runs = new Map<string, ClosedRun>();
    private readonly threads = new Map<string, ClosedRun>();
    constructor(private readonly store: DraftStore, private readonly persistence: DraftPersistence,
        private readonly vault: DraftViewIO, private readonly allocateId: () => DraftId) {}

    async open(input: { runId: string; threadId: string; origin?: SubTaskOrigin; writable: boolean;
        dependencies?: readonly string[]; continuation: boolean; plan?: DraftIdentity['plan'] }): Promise<RunDraft | undefined> {
        const previous = input.continuation ? this.threads.get(input.threadId) : undefined;
        const parents = (input.dependencies ?? []).map(id => {
            const parent = this.runs.get(id);
            if (!parent) throw new DraftError('invalid-transition', 'Predecessor draft view is not sealed');
            return parent;
        });
        if (previous) parents.push(previous);
        const layers = parents.flatMap(parent => parent.layers);
        if (!input.writable && !layers.length) return undefined;
        const origin = input.origin;
        if (!origin?.agentName || !origin.sessionPath || !origin.sessionEpoch)
            throw new DraftError('mutation-denied', 'Draft execution requires a complete owner');
        const owner = { agentName: origin.agentName, sessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch };
        for (const parent of parents) if (parent.owner.agentName !== owner.agentName || parent.owner.sessionPath !== owner.sessionPath || parent.owner.sessionEpoch !== owner.sessionEpoch)
            throw new DraftError('mutation-denied', 'Foreign predecessor draft');
        const id = input.writable ? this.allocateId() : null;
        if (id) await this.store.create({ draftId: id, owner, runId: input.runId, threadId: input.threadId, ...(input.plan ? { plan: input.plan } : {}) });
        const view = new DraftView(this.store, this.persistence, this.vault, id, layers);
        return new RunDraft(view, closed => {
            const record = { owner, layers: closed };
            this.runs.set(input.runId, record);
            this.threads.set(input.threadId, record);
        });
    }

    /** Read-only runs still pass their (empty) view through a dependency graph. */
    recordLive(runId: string, origin?: SubTaskOrigin): void {
        if (origin?.sessionPath && origin.sessionEpoch) this.runs.set(runId, {
            owner: { agentName: origin.agentName, sessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch }, layers: [],
        });
    }
}

export class RunDraft {
    readonly execution: VaultExecution;
    private closing?: Promise<void>;
    private reason?: SealReason;
    constructor(readonly view: DraftView, private readonly publish: (layers: readonly FrozenDraftView[]) => void) {
        this.execution = view.draftId ? { kind: 'overlay-write', workspace: view } : { kind: 'overlay-read', view };
    }
    /** seal() revokes publication synchronously, even if the caller cannot await. */
    close(reason: SealReason): Promise<void> {
        this.reason ??= reason;
        if (!this.closing) {
            const sealed = this.view.draftId ? this.view.store.seal(this.view.draftId, this.reason) : Promise.resolve();
            this.closing = sealed.then(() => {
                this.publish(this.reference() ? [this.view.freeze()] : this.view.predecessors);
            });
            // Abort listeners must not create unhandled rejections. Awaiters still see failure.
            void this.closing.catch(() => { this.closing = undefined; });
        }
        return this.closing;
    }
    reference(): DraftRef | undefined {
        if (!this.view.draftId) return undefined;
        const manifest = this.view.store.snapshot(this.view.draftId);
        return manifest.changes.length ? { draftId: manifest.draftId, revision: manifest.revision } : undefined;
    }
}
