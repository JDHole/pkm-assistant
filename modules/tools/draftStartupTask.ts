import type { DataAdapter } from 'obsidian';
import type { DraftStorageIO } from '../vault-drafts/index.js';

/** One admission gate. Closing releases waiters even if the host never finishes I/O. */
export class DraftStartupTask {
    readonly ready: Promise<void>;
    readonly stopped: Promise<void>;
    private stop!: () => void;
    private settle!: () => void;
    private started = false;
    get hasStarted(): boolean { return this.started; }
    private readonly workFinished: Promise<void>;
    private finish!: () => void;
    private activeIO = 0;
    private idle: Promise<void> = Promise.resolve();
    private becameIdle?: () => void;
    /** Unlike ready/stopped, waits for the host operation to actually return. */
    async drained(): Promise<void> {
        await this.previous?.drained();
        await this.workFinished;
        await this.idle;
    }
    closed = false;
    constructor(private readonly work: () => Promise<void>, private readonly previous?: DraftStartupTask) {
        this.workFinished = new Promise(resolve => { this.finish = resolve; });
        this.stopped = new Promise(resolve => { this.stop = resolve; });
        this.ready = new Promise(resolve => { this.settle = resolve; });
    }
    start(): void {
        if (this.started || this.closed) return;
        this.started = true;
        // The composition root handles/report errors; still observe every rejection.
        void (async () => {
            await this.previous?.drained();
            if (!this.closed) await this.work();
        })().then(() => { this.finish(); this.settle(); }, () => { this.finish(); this.settle(); });
    }
    dispose(): void { this.closed = true; this.stop(); this.settle(); if (!this.started) this.finish(); }
    check(): void { if (this.closed) throw new Error('Draft runtime closed'); }
    async io<T>(operation: () => Promise<T>): Promise<T> {
        this.check();
        if (this.activeIO++ === 0) this.idle = new Promise(resolve => { this.becameIdle = resolve; });
        try {
            const value = await operation();
            this.check();
            return value;
        } finally {
            if (--this.activeIO === 0) this.becameIdle?.();
        }
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
