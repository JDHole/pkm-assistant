import type { DataAdapter } from 'obsidian';
import type { DraftStorageIO } from '../vault-drafts/index.js';

/** One admission gate. Closing releases waiters even if the host never finishes I/O. */
export class DraftStartupTask {
    readonly ready: Promise<void>;
    readonly stopped: Promise<void>;
    private stop!: () => void;
    private settle!: () => void;
    private started = false;
    closed = false;
    constructor(private readonly work: () => Promise<void>) {
        this.stopped = new Promise(resolve => { this.stop = resolve; });
        this.ready = new Promise(resolve => { this.settle = resolve; });
    }
    start(): void {
        if (this.started || this.closed) return;
        this.started = true;
        // The composition root handles/report errors; still observe every rejection.
        void this.work().then(this.settle, this.settle);
    }
    dispose(): void { this.closed = true; this.stop(); this.settle(); }
    check(): void { if (this.closed) throw new Error('Draft runtime closed'); }
    async io<T>(operation: () => Promise<T>): Promise<T> {
        this.check();
        const value = await operation();
        this.check();
        return value;
    }
}

/** Guard inside adapter multi-step operations too (staging cleanup, rename, GC). */
type StorageAdapter = Pick<DataAdapter, 'stat' | 'list' | 'readBinary' | 'writeBinary' | 'mkdir' | 'rename' | 'remove'> & Partial<Pick<DataAdapter, 'rmdir'>>;
export function startupAdapter(adapter: StorageAdapter, task?: DraftStartupTask): StorageAdapter {
    if (!task) return adapter;
    return {
        stat: (path: string) => task.io(() => adapter.stat(path)),
        list: (path: string) => task.io(() => adapter.list(path)),
        readBinary: (path: string) => task.io(() => adapter.readBinary(path)),
        writeBinary: (path: string, bytes: ArrayBuffer) => task.io(() => adapter.writeBinary(path, bytes)),
        mkdir: (path: string) => task.io(() => adapter.mkdir(path)),
        rename: (from: string, to: string) => task.io(() => adapter.rename(from, to)),
        remove: (path: string) => task.io(() => adapter.remove(path)),
        ...(adapter.rmdir ? { rmdir: (path: string, recursive: boolean) => task.io(() => adapter.rmdir!(path, recursive)) } : {}),
    };
}

export function startupStorage(storage: DraftStorageIO, task?: DraftStartupTask): DraftStorageIO {
    if (!task) return storage;
    return {
        list: path => task.io(() => storage.list(path)),
        read: path => task.io(() => storage.read(path)),
        writeBlob: (path, bytes) => task.io(() => storage.writeBlob(path, bytes)),
        publish: (path, bytes, allowed) => task.io(() => storage.publish(path, bytes, () => !task.closed && allowed())),
        ...(storage.remove ? { remove: (path: string) => task.io(() => storage.remove!(path)) } : {}),
        ...(storage.cleanupTemporary ? { cleanupTemporary: () => task.io(() => storage.cleanupTemporary!()) } : {}),
    };
}
