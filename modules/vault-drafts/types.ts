declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };
export type DraftId = Brand<string, 'DraftId'>;
export type ChangeId = Brand<string, 'ChangeId'>;
export type VaultPath = Brand<string, 'VaultPath'>;
export type BlobId = Brand<string, 'BlobId'>;
export type ContentHash = Brand<string, 'ContentHash'>;
export type Revision = Brand<number, 'Revision'>;
export type FileVersion = Readonly<
    | { kind: 'missing' } | { kind: 'folder' }
    | { kind: 'file'; hash: ContentHash; bytes: number; mtime: number }>;
export type BaseSnapshot = Readonly<
    | { kind: 'missing' } | { kind: 'folder' }
    | { kind: 'file'; version: Extract<FileVersion, { kind: 'file' }>; blob: BlobId }>;
export type ProposedValue = Readonly<
    | { kind: 'text' | 'binary'; blob: BlobId; hash: ContentHash; bytes: number }
    | { kind: 'folder' } | { kind: 'deleted'; disposition: 'trash' | 'permanent' }>;
export type ReviewState = Readonly<
    | { kind: 'pending' }
    | { kind: 'conflict'; reason: 'base-changed' | 'dependency-changed' | 'ambiguous-input'; actual: FileVersion }
    | { kind: 'applying'; attemptId: string; approvedRevision: Revision }
    | { kind: 'accepted'; attemptId: string; applied: FileVersion }
    | { kind: 'rejected' } | { kind: 'recovery-required'; attemptId: string }>;
export type DraftPhase = Readonly<
    | { kind: 'open' }
    | { kind: 'sealed'; reason: 'finished' | 'stopped' | 'timeout' | 'failed' | 'restart' }>;
export type DraftRef = Readonly<{ draftId: DraftId; revision: Revision }>;
export type FirstTouch = Readonly<{ id: ChangeId; path: VaultPath; base: BaseSnapshot }>;
export type Change = FirstTouch & Readonly<{
    proposed: ProposedValue; revision: Revision; review: ReviewState;
    inheritedFrom: readonly DraftRef[];
    source: Readonly<{ tool: string; callId: string }>;
}>;
export type DraftIdentity = Readonly<{
    draftId: DraftId;
    owner: Readonly<{ agentName: string; sessionPath: string; sessionEpoch: string }>;
    runId: string; threadId: string;
    plan?: Readonly<{ planId: string; nodeId: string }>;
}>;
export type DraftManifest = DraftIdentity & Readonly<{
    version: 1; generation: number; revision: Revision; createdAt: number; updatedAt: number;
    phase: DraftPhase; changes: readonly Change[];
    /** Retained even when create + delete removes the net change. */
    firstTouches: readonly FirstTouch[];
}>;
export type DraftMutation = Readonly<{
    path: VaultPath; source: Change['source'];
    value: { kind: 'text'; text: string } | { kind: 'binary'; bytes: Uint8Array }
        | { kind: 'folder' } | { kind: 'deleted'; disposition: 'trash' | 'permanent' };
}>;
export type DraftErrorCode = 'invalid-id' | 'invalid-path' | 'invalid-hash' | 'invalid-revision'
    | 'invalid-manifest' | 'invalid-mutation' | 'invalid-version' | 'integrity-error' | 'io-error'
    | 'draft-closed' | 'draft-not-found' | 'draft-exists' | 'invalid-transition' | 'base-unstable';
export class DraftError extends Error {
    constructor(readonly code: DraftErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DraftError';
    }
}
export type VaultStat = Readonly<
    | { kind: 'missing' } | { kind: 'folder' } | { kind: 'file'; bytes: number; mtime: number }>;
/** Read-only vault boundary. A failed read MUST reject, never return empty bytes. */
export interface DraftVaultIO {
    stat(path: VaultPath): Promise<VaultStat>;
    read(path: VaultPath): Promise<Uint8Array>;
}
/** All paths belong to the private draft namespace, never logical vault paths. */
export interface DraftStorageIO {
    /** Immediate child names only; missing directory returns []. Other errors reject. */
    list(path: string): Promise<readonly string[]>;
    read(path: string): Promise<Uint8Array>;
    /** Creates parents; immutable blobs, durable before resolving. */
    writeBlob(path: string, bytes: Uint8Array): Promise<void>;
    /**
     * Create-only, durable atomic publication. Evaluate mayPublish at the publication
     * linearization point, with no asynchronous gap. False leaves no visible manifest.
     * Rejection MUST mean no publication. A normal asynchronous write is NOT this port.
     */
    publish(path: string, bytes: Uint8Array, mayPublish: () => boolean): Promise<'published' | 'cancelled'>;
}
export interface DraftClock { now(): number }
/** SHA-256, lowercase 64 hex characters; validated by persistence. */
export interface DraftHasher { sha256(bytes: Uint8Array): Promise<string> }
export type RecoveryIssue = Readonly<{ path: string; code: DraftErrorCode; message: string }>;
