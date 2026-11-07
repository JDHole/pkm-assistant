import { DraftStore } from './DraftStore.js';
import { DraftPersistence } from './DraftPersistence.js';
import { parseVaultPath } from './schema.js';
import { DraftError } from './types.js';
import type { Change, DraftId, DraftManifest, DraftMutation, DraftRef, DraftVaultIO, VaultPath, VaultStat } from './types.js';

export interface DraftViewIO extends DraftVaultIO {
    /** Immediate logical children, including hidden files. Root is ''. */
    list(path: string): Promise<{ files: readonly string[]; folders: readonly string[] }>;
}
type Source = { ref: DraftRef; change: Change };
export type DraftResolution =
    | { kind: 'vault' }
    | { kind: 'proposal'; sources: readonly Source[] }
    | { kind: 'ambiguous-input'; sources: readonly Source[] };
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
/** Constructed only by freeze(); snapshots never follow later review decisions. */
export class FrozenDraftView {
    private constructor(readonly manifest: DraftManifest, readonly predecessors: readonly FrozenDraftView[]) {}
    static from(view: DraftView): FrozenDraftView {
        if (!view.draftId) throw new DraftError('invalid-transition', 'No own draft to freeze');
        const manifest = view.store.snapshot(view.draftId);
        if (manifest.phase.kind !== 'sealed') throw new DraftError('invalid-transition', 'Predecessor must be sealed');
        return freeze(new FrozenDraftView(manifest, [...view.predecessors]));
    }
}
function candidates(layer: FrozenDraftView, path: VaultPath): Source[] {
    const change = layer.manifest.changes.find(item => item.path === path);
    return change ? [{ ref: { draftId: layer.manifest.draftId, revision: layer.manifest.revision }, change }]
        : layer.predecessors.flatMap(parent => candidates(parent, path));
}
function contains(layer: FrozenDraftView, id: DraftId): boolean {
    return layer.manifest.draftId === id || layer.predecessors.some(parent => contains(parent, id));
}
function equivalent(a: Change['proposed'], b: Change['proposed']): boolean {
    if ((a.kind === 'text' || a.kind === 'binary') && (b.kind === 'text' || b.kind === 'binary')) return a.hash === b.hash;
    return a.kind === b.kind;
}
export class DraftView {
    private readonly queues = new Map<VaultPath, Promise<unknown>>();
    constructor(readonly store: DraftStore, private readonly persistence: DraftPersistence,
        private readonly vault: DraftViewIO, readonly draftId: DraftId | null,
        readonly predecessors: readonly FrozenDraftView[] = []) { this.predecessors = Object.freeze([...predecessors]); }
    freeze(): FrozenDraftView { return FrozenDraftView.from(this); }
    resolve(input: string): DraftResolution {
        const path = parseVaultPath(input);
        const own = this.draftId ? this.store.snapshot(this.draftId) : null;
        const change = own?.changes.find(item => item.path === path);
        if (own && change) return { kind: 'proposal', sources: [{ ref: { draftId: own.draftId, revision: own.revision }, change }] };
        const all = this.predecessors.flatMap(layer => candidates(layer, path));
        const layers = (nodes: readonly FrozenDraftView[]): FrozenDraftView[] => nodes.flatMap(node => [node, ...layers(node.predecessors)]);
        const graph = layers(this.predecessors);
        const sources = all.filter((source, index) => all.findIndex(other => other.ref.draftId === source.ref.draftId) === index
            && !all.some(other => other.ref.draftId !== source.ref.draftId
                && graph.some(layer => layer.manifest.draftId === other.ref.draftId && contains(layer, source.ref.draftId))));
        if (!sources.length) return { kind: 'vault' };
        return { kind: sources.every(source => equivalent(source.change.proposed, sources[0].change.proposed)) ? 'proposal' : 'ambiguous-input', sources };
    }
    private unambiguous(path: string): Exclude<DraftResolution, { kind: 'ambiguous-input' }> {
        const result = this.resolve(path);
        if (result.kind === 'ambiguous-input') throw new DraftError('ambiguous-input', `Ambiguous input ${path}: ${result.sources.map(source => source.ref.draftId).join(', ')}`);
        return result;
    }
    async stat(input: string): Promise<VaultStat> {
        if (input === '' || input === '/') return { kind: 'folder' };
        const path = parseVaultPath(input), result = this.unambiguous(path);
        if (result.kind === 'vault') {
            const stat = await this.vault.stat(path);
            if (stat.kind !== 'missing') return stat;
            return this.changedPaths().some(child => child.startsWith(`${path}/`) && this.proposedKind(child) !== 'deleted') ? { kind: 'folder' } : stat;
        }
        const value = result.sources[0].change.proposed;
        switch (value.kind) {
            case 'deleted': return { kind: 'missing' };
            case 'folder': return { kind: 'folder' };
            case 'text': case 'binary': return { kind: 'file', bytes: value.bytes, mtime: result.sources[0].change.revision };
            default: { const exhaustive: never = value; return exhaustive; }
        }
    }
    private proposedKind(path: string): Change['proposed']['kind'] | undefined {
        const result = this.resolve(path);
        return result.kind === 'proposal' ? result.sources[0].change.proposed.kind : undefined;
    }
    changedPaths(): VaultPath[] {
        const paths = (nodes: readonly FrozenDraftView[]): VaultPath[] => nodes.flatMap(node => [...node.manifest.changes.map(change => change.path), ...paths(node.predecessors)]);
        return [...new Set([...(this.draftId ? this.store.snapshot(this.draftId).changes.map(change => change.path) : []), ...paths(this.predecessors)])];
    }
    async readBinary(input: string): Promise<Uint8Array> {
        const path = parseVaultPath(input), result = this.unambiguous(path);
        if (result.kind === 'vault') return this.vault.read(path);
        const { ref, change } = result.sources[0], value = change.proposed;
        if (value.kind !== 'text' && value.kind !== 'binary') throw new DraftError('file-missing', `Not a file: ${path}`);
        return this.persistence.readBlob(ref.draftId, value.blob, value.hash, value.bytes);
    }
    async read(path: string): Promise<string> { return new TextDecoder('utf-8', { fatal: true }).decode(await this.readBinary(path)); }
    async list(input = ''): Promise<{ files: string[]; folders: string[]; ambiguous: string[] }> {
        const path = input === '/' ? '' : input;
        if (path) parseVaultPath(path);
        const base = !path || (await this.vault.stat(parseVaultPath(path))).kind === 'folder'
            ? await this.vault.list(path) : { files: [], folders: [] };
        const prefix = path ? `${path}/` : '';
        const names = new Set([...base.files, ...base.folders]);
        for (const changed of this.changedPaths()) if (changed.startsWith(prefix)) names.add(prefix + changed.slice(prefix.length).split('/')[0]);
        const result = { files: [] as string[], folders: [] as string[], ambiguous: [] as string[] };
        for (const name of [...names].sort()) {
            // Private storage never enters the logical view, even for an admin.
            if (/^\.pkm-assistant\/subagent-drafts(?:\/|$)/i.test(name)) continue;
            parseVaultPath(name);
            if (!name.startsWith(prefix) || name.slice(prefix.length).includes('/')) throw new DraftError('invalid-path', 'Listing returned a non-child path');
            if (this.resolve(name).kind === 'ambiguous-input') { result.ambiguous.push(name); continue; }
            const stat = await this.stat(name);
            if (stat.kind === 'file') result.files.push(name);
            if (stat.kind === 'folder') result.folders.push(name);
        }
        return result;
    }
    /** Shared by all per-call hosts of this run; process reads INSIDE the path queue. */
    mutate(pathInput: string, source: Change['source'], value: DraftMutation['value'] | ((text: string) => string | null),
        expectation: 'create' | 'file' | 'any' = 'any'): Promise<void> {
        if (!this.draftId) return Promise.reject(new DraftError('mutation-denied', 'Read-only draft view'));
        const id = this.draftId, path = parseVaultPath(pathInput);
        const captured = typeof value === 'function' ? value : structuredClone(value);
        const pending = (this.queues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const resolved = this.unambiguous(path), stat = await this.stat(path);
            if (expectation === 'create' && stat.kind !== 'missing' || expectation === 'file' && stat.kind !== 'file')
                throw new DraftError('invalid-transition', `Unexpected file state: ${path}`);
            for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
                const parent = await this.stat(path.slice(0, slash));
                if (parent.kind === 'file') throw new DraftError('invalid-transition', 'Parent is a file');
            }
            const text = typeof captured === 'function' ? captured(await this.read(path)) : undefined;
            if (text === null) return;
            let next: DraftMutation['value'];
            if (typeof captured === 'function') {
                if (typeof text !== 'string') throw new DraftError('invalid-mutation', 'Process must return text or null');
                next = { kind: 'text', text };
            } else next = captured;
            const inherited = resolved.kind === 'proposal' ? resolved.sources.filter(item => item.ref.draftId !== id).map(item => item.ref) : [];
            await this.store.mutate(id, { path, source, value: next }, inherited);
        });
        this.queues.set(path, pending);
        void pending.finally(() => { if (this.queues.get(path) === pending) this.queues.delete(path); }).catch(() => {});
        return pending;
    }
}
