import type { DataAdapter } from 'obsidian';

type Operation = 'stat' | 'list' | 'readBinary' | 'writeBinary' | 'mkdir' | 'rename' | 'remove';
type Fault = { operation: Operation; moment: 'before' | 'after'; occurrence?: number };
/** Synthetic adapter. Faults occur at the real I/O boundary, not in the storage port. */
export class MemoryAdapter implements Pick<DataAdapter, Operation> {
    readonly files = new Map<string, Uint8Array>();
    readonly folders = new Set<string>();
    readonly calls: { operation: Operation; path: string }[] = [];
    fault?: Fault;
    fullPaths = true;
    truncate?: number;
    renameMode: 'move' | 'noop' | 'partial' = 'move';
    before?: (operation: Operation, path: string) => Promise<void>;
    after?: (operation: Operation, path: string) => Promise<void>;
    private async run<T>(operation: Operation, path: string, action: () => T): Promise<T> {
        this.calls.push({ operation, path });
        const fault = this.fault;
        const applies = fault?.operation === operation
            && this.calls.filter(call => call.operation === operation).length === (fault.occurrence ?? 1);
        await this.before?.(operation, path);
        if (applies && fault?.moment === 'before') throw new Error(`Injected ${operation} before`);
        const result = action();
        await this.after?.(operation, path);
        if (applies && fault?.moment === 'after') throw new Error(`Injected ${operation} after`);
        return result;
    }
    private isFolder(path: string): boolean {
        return this.folders.has(path) || [...this.files.keys()].some(key => key.startsWith(`${path}/`));
    }
    stat: DataAdapter['stat'] = path => this.run('stat', path, () => {
        const bytes = this.files.get(path);
        return bytes ? { type: 'file', size: bytes.length, mtime: 1, ctime: 1 }
            : this.isFolder(path) ? { type: 'folder', size: 0, mtime: 1, ctime: 1 } : null;
    });
    list: DataAdapter['list'] = path => this.run('list', path, () => {
        if (!this.isFolder(path)) throw new Error('Missing folder');
        const files: string[] = [], folders: string[] = [];
        for (const key of new Set([...this.folders, ...this.files.keys()])) {
            if (!key.startsWith(`${path}/`)) continue;
            const name = key.slice(path.length + 1).split('/')[0];
            const child = `${path}/${name}`;
            const target = this.files.has(child) ? files : folders;
            const entry = this.fullPaths ? child : name;
            if (!target.includes(entry)) target.push(entry);
        }
        return { files, folders };
    });
    readBinary: DataAdapter['readBinary'] = path => this.run('readBinary', path, () => {
        const bytes = this.files.get(path);
        if (!bytes) throw new Error('Missing file');
        return bytes.slice().buffer;
    });
    writeBinary: DataAdapter['writeBinary'] = (path, data) => this.run('writeBinary', path, () => {
        this.requireParent(path);
        this.files.set(path, new Uint8Array(data).slice(0, this.truncate));
    });
    mkdir: DataAdapter['mkdir'] = path => this.run('mkdir', path, () => {
        this.requireParent(path);
        if (this.files.has(path) || this.folders.has(path)) throw new Error('Already exists');
        this.folders.add(path);
    });
    rename: DataAdapter['rename'] = (from, to) => this.run('rename', from, () => {
        this.requireParent(to);
        const bytes = this.files.get(from);
        if (!bytes) throw new Error('Missing source');
        if (this.renameMode === 'noop') return;
        this.files.set(to, this.renameMode === 'partial' ? bytes.slice(0, 1) : bytes.slice());
        this.files.delete(from);
    });
    remove: DataAdapter['remove'] = path => this.run('remove', path, () => {
        if (!this.files.delete(path)) throw new Error('Missing file');
    });
    private requireParent(path: string): void {
        const index = path.lastIndexOf('/');
        if (index !== -1 && !this.isFolder(path.slice(0, index))) throw new Error('Missing parent');
    }
}
