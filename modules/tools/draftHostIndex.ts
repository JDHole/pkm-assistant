import { sanitizePath } from '../../core/index.js';
import { DraftError, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftFileIndex, DraftRef, DraftView, VaultStat } from '../vault-drafts/index.js';
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
/** A snapshot of the legacy walk, rebuilt from memory at the legacy refresh points. */
export class DraftHostIndex {
    private snapshot = new Map<string, LocalFile>();
    private descendants = new Map<string, LocalFile[]>();
    // Only explicitly requested hidden paths use adapter I/O. Never enumerate hidden trees.
    private readonly hidden = new Map<string, VaultStat>();
    constructor(private readonly view: DraftView, private readonly base: DraftFileIndex,
        private readonly technicalFolders: Set<string>) {}

    async refresh(): Promise<void> {
        // Re-read only prepared base paths. An overlay result must never become a cached base.
        for (const path of this.hidden.keys()) this.hidden.set(path, await this.view.statBase(path));
        const changed = this.view.resolvedChanges();
        const candidates = new Map<string, Set<string>>();
        const liveAncestors = new Set<string>();
        const add = (path: string, live: boolean): void => {
            for (let child = path; child; child = parentOf(child)) {
                const parent = parentOf(child);
                if (!candidates.has(parent)) candidates.set(parent, new Set());
                candidates.get(parent)!.add(child);
                if (live) liveAncestors.add(parent);
            }
        };
        for (const [path, resolved] of changed) add(path,
            resolved.kind !== 'proposal' || resolved.sources[0].change.proposed.kind !== 'deleted');
        for (const path of this.hidden.keys()) add(path, false);
        const stat = (path: string): LocalFile | null => {
            const resolved = changed.get(parseVaultPath(path));
            if (resolved?.kind === 'ambiguous-input') return { ...localFile(path, false),
                status: 'ambiguous-input', sources: resolved.sources.map(source => source.ref) };
            if (resolved?.kind === 'proposal') {
                const { proposed, revision } = resolved.sources[0].change;
                return proposed.kind === 'deleted' ? null : proposed.kind === 'folder' ? localFile(path, true)
                    : localFile(path, false, proposed.bytes, revision);
            }
            const entry = this.base.get(path);
            if (entry) return entry.kind === 'folder' ? localFile(path, true) : localFile(path, false, entry.bytes, entry.mtime);
            const hidden = this.hidden.get(path);
            if (hidden?.kind === 'file') return localFile(path, false, hidden.bytes, hidden.mtime);
            if (hidden?.kind === 'folder') return localFile(path, true);
            return liveAncestors.has(path) ? localFile(path, true) : null;
        };
        const files = new Map<string, LocalFile>([['', localFile('', true)]]);
        const walk = (path: string): void => {
            const names = new Set(candidates.get(path));
            const base = this.base.get(path);
            if (base?.kind === 'folder') for (const child of base.children()) names.add(child.path);
            // Same list/stat rules and ordering as the adapter walker: ambiguity, files, folders.
            const ambiguous: LocalFile[] = [], regular: LocalFile[] = [], folders: LocalFile[] = [];
            for (const name of [...names].sort()) {
                const entry = stat(name);
                if (entry) (entry.status ? ambiguous : 'children' in entry ? folders : regular).push(entry);
            }
            for (const entry of [...ambiguous, ...regular]) files.set(entry.path, entry);
            for (const entry of folders) { files.set(entry.path, entry); walk(entry.path); }
        };
        walk('');
        for (const path of this.technicalFolders) if (!files.has(path)) files.set(path, localFile(path, true));
        for (const entry of files.values()) if (entry.path && !isHiddenVaultPath(entry.path))
            files.get(parentOf(entry.path))?.children?.push(entry);
        this.snapshot = files;
        this.descendants = new Map();
        for (const entry of files.values()) if (entry.path) {
            const parent = parentOf(entry.path);
            if (!this.descendants.has(parent)) this.descendants.set(parent, []);
            this.descendants.get(parent)!.push(entry);
        }
    }
    get(path: string): LocalFile | null { return this.snapshot.get(path) ?? null; }
    files(): LocalFile[] { return [...this.snapshot.values()].filter(entry => !('children' in entry) && !isHiddenVaultPath(entry.path)); }
    /** Includes prepared hidden entries without scanning unrelated snapshot paths. */
    filesUnder(path: string): LocalFile[] {
        const result: LocalFile[] = [];
        const walk = (parent: string): void => {
            for (const entry of this.descendants.get(parent) ?? []) {
                if ('children' in entry) walk(entry.path);
                else result.push(entry);
            }
        };
        walk(path);
        return result;
    }

    /** Hidden targets are prepared before synchronous tools run; no unrelated directory is visited. */
    prepareHidden(input: string): void {
        const path = sanitizePath(input);
        if (!path || !isHiddenVaultPath(path)) return;
        // Malformed/private arguments still belong to the tool's existing validation.
        try { parseVaultPath(path); }
        catch (error) { if (error instanceof DraftError && error.code === 'invalid-path') return; throw error; }
        if (this.view.resolve(path).kind === 'ambiguous-input') return;
        for (let target = path; target; target = parentOf(target)) {
            if (!isHiddenVaultPath(target) || this.view.resolve(target).kind === 'ambiguous-input') continue;
            if (!this.hidden.has(target)) this.hidden.set(target, { kind: 'missing' });
        }
    }
}
