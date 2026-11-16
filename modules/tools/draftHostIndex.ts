import { sanitizePath } from '../../core/index.js';
import { DraftError, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftFileIndex, DraftIndexEntry, DraftRef, DraftResolution, DraftView } from '../vault-drafts/index.js';
import { isHiddenVaultPath } from './vault_adapter_io.js';

export interface LocalFile {
    status?: 'ambiguous-input'; sources?: readonly DraftRef[];
    path: string; name: string; basename: string; extension: string;
    stat: { size: number; mtime: number; ctime: number }; children?: LocalFile[];
}
export function localFile(path: string, folder: boolean, size = 0, mtime = 0): LocalFile {
    const name = path.split('/').pop() ?? '', dot = name.lastIndexOf('.');
    return { path, name, basename: dot < 0 ? name : name.slice(0, dot), extension: dot < 0 ? '' : name.slice(dot + 1),
        stat: { size, mtime, ctime: mtime }, ...(folder ? { children: [] } : {}) };
}
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const rank = (file: LocalFile) => file.status ? 0 : 'children' in file ? 2 : 1;

/** Sparse per-call projection. Base enumeration happens only when the caller requests it. */
export class DraftHostIndex {
    private readonly entries = new Map<string, LocalFile | null>();
    private readonly children = new Map<string, Set<string>>();
    private readonly liveChildren = new Map<string, number>();
    private readonly blockedParents = new Set<string>();
    private readonly proposed = new Set<string>();
    private readonly implicit = new Set<string>();
    constructor(private readonly view: DraftView, private readonly base: DraftFileIndex,
        private readonly technicalFolders: Set<string>) {
        for (const [path, resolved] of view.resolvedChanges()) this.update(path, resolved);
    }
    private makeFolder(path: string): LocalFile {
        const children = () => this.list(path);
        return { ...localFile(path, true), get children() { return children(); } };
    }
    private fromBase(entry: DraftIndexEntry): LocalFile {
        return entry.kind === 'folder' ? this.makeFolder(entry.path) : localFile(entry.path, false, entry.bytes, entry.mtime);
    }
    private reachable(path: string): boolean {
        for (let parent = parentOf(path); parent; parent = parentOf(parent)) {
            if (this.blockedParents.has(parent)) return false;
            if (!this.entries.has(parent)) continue;
            const entry = this.entries.get(parent);
            if (!entry || !('children' in entry)) return false;
        }
        return true;
    }
    get(path: string): LocalFile | null {
        if (!this.reachable(path)) return null;
        if (!path) return this.makeFolder('');
        if (this.entries.has(path)) return this.entries.get(path) ?? null;
        const entry = this.base.get(path);
        return entry ? this.fromBase(entry) : null;
    }
    private set(path: string, value: LocalFile | null): void {
        const parent = parentOf(path);
        const delta = Number(value !== null) - Number(!!this.entries.get(path));
        this.liveChildren.set(parent, (this.liveChildren.get(parent) ?? 0) + delta);
        this.entries.set(path, value);
        if (!this.children.has(parent)) this.children.set(parent, new Set());
        this.children.get(parent)!.add(path);
    }
    private unset(path: string): void {
        const parent = parentOf(path);
        if (this.entries.get(path)) this.liveChildren.set(parent, (this.liveChildren.get(parent) ?? 0) - 1);
        this.entries.delete(path);
        this.children.get(parent)?.delete(path);
    }
    update(path: string, resolved: DraftResolution = this.view.resolve(path)): void {
        this.implicit.delete(path);
        if (resolved.kind === 'ambiguous-input' || resolved.kind === 'proposal' && resolved.sources[0].change.proposed.kind !== 'folder')
            this.blockedParents.add(path);
        else this.blockedParents.delete(path);
        if (resolved.kind === 'ambiguous-input' || resolved.kind === 'proposal' && resolved.sources[0].change.proposed.kind !== 'deleted')
            this.proposed.add(path);
        else this.proposed.delete(path);
        if (resolved.kind === 'ambiguous-input') this.set(path, { ...localFile(path, false),
            status: 'ambiguous-input', sources: resolved.sources.map(source => source.ref) });
        else if (resolved.kind === 'proposal') {
            const { proposed, revision } = resolved.sources[0].change;
            this.set(path, proposed.kind === 'deleted' ? this.technicalFolders.has(path) ? this.makeFolder(path) : null : proposed.kind === 'folder' ? this.makeFolder(path)
                : localFile(path, false, proposed.bytes, revision));
        } else {
            this.unset(path);
            if (this.technicalFolders.has(path)) this.set(path, this.makeFolder(path));
        }
        this.parents(path);
    }
    private parents(path: string): void {
        for (let parent = parentOf(path); parent; parent = parentOf(parent)) {
            if (this.implicit.has(parent)) { this.unset(parent); this.implicit.delete(parent); }
            if (this.entries.has(parent) || this.base.get(parent)) continue;
            const hasChild = (this.liveChildren.get(parent) ?? 0) > 0;
            if (hasChild || this.technicalFolders.has(parent)) {
                this.set(parent, this.makeFolder(parent)); this.implicit.add(parent);
            } else this.children.get(parentOf(parent))?.delete(parent);
        }
    }
    /** Hidden targets are prepared before synchronous tools run; no unrelated directory is visited. */
    async prepareHidden(input: string): Promise<void> {
        const path = sanitizePath(input);
        if (!path || !isHiddenVaultPath(path)) return;
        // Malformed/private arguments still belong to the tool's existing validation.
        try { parseVaultPath(path); }
        catch (error) { if (error instanceof DraftError && error.code === 'invalid-path') return; throw error; }
        if (this.view.resolve(path).kind === 'ambiguous-input') { this.update(path); return; }
        const stat = await this.view.stat(path);
        if (stat.kind === 'file') this.set(path, localFile(path, false, stat.bytes, stat.mtime));
        else if (stat.kind === 'folder') this.set(path, this.makeFolder(path));
        else if (!this.technicalFolders.has(path)) this.set(path, null);
        for (let parent = parentOf(path); parent; parent = parentOf(parent)) {
            if (!isHiddenVaultPath(parent)) continue;
            if (this.view.resolve(parent).kind === 'ambiguous-input') { this.update(parent); continue; }
            const stat = await this.view.stat(parent);
            if (stat.kind === 'folder') this.set(parent, this.makeFolder(parent));
            else if (stat.kind === 'missing' && !this.technicalFolders.has(parent)) this.set(parent, null);
        }
    }
    list(path: string): LocalFile[] {
        // Historical host excludes hidden entries even from a hidden folder's children.
        if (isHiddenVaultPath(path) || this.blockedParents.has(path)) return [];
        const base = this.base.get(path), values = new Map<string, LocalFile>();
        if (base?.kind === 'folder') for (const child of base.children()) {
            if (!isHiddenVaultPath(child.path)) values.set(child.path, this.fromBase(child));
        }
        for (const child of this.children.get(path) ?? []) {
            if (isHiddenVaultPath(child)) continue;
            const entry = this.entries.get(child);
            if (entry) values.set(child, entry); else values.delete(child);
        }
        const technicalOrder = new Map([...this.technicalFolders].map((folder, i) => [folder, i]));
        const technicalOnly = (entry: LocalFile): boolean => technicalOrder.has(entry.path)
            && ![...this.proposed].some(path => path === entry.path || path.startsWith(`${entry.path}/`));
        const normal: LocalFile[] = [], technical: LocalFile[] = [];
        for (const entry of values.values()) (technicalOnly(entry) ? technical : normal).push(entry);
        return [...normal.sort((a, b) => rank(a) - rank(b) || compare(a.path, b.path)),
            ...technical.sort((a, b) => technicalOrder.get(a.path)! - technicalOrder.get(b.path)!)];
    }
    files(): LocalFile[] {
        const values = new Map(this.base.files().map(entry => [entry.path, this.fromBase(entry)]));
        for (const [path, entry] of this.entries) {
            if (entry && !('children' in entry) && !isHiddenVaultPath(path)) values.set(path, entry);
            else values.delete(path);
        }
        // Match the legacy walker: files (ambiguities first), then sorted subtrees.
        return [...values.values()].filter(entry => this.reachable(entry.path)).sort((a, b) => {
            const left = a.path.split('/'), right = b.path.split('/');
            let i = 0;
            while (left[i] === right[i] && i < Math.min(left.length, right.length) - 1) i++;
            const leftFolder = i < left.length - 1, rightFolder = i < right.length - 1;
            return leftFolder !== rightFolder ? leftFolder ? 1 : -1
                : !leftFolder ? rank(a) - rank(b) || compare(left[i], right[i]) : compare(left[i], right[i]);
        });
    }
}
