import type { DataAdapter } from 'obsidian';
import { DRAFT_ROOT } from './DraftPersistence.js';
import { DraftError } from './types.js';
import type { DraftStorageIO, RecoveryIssue } from './types.js';

type Adapter = Pick<DataAdapter, 'list' | 'readBinary' | 'writeBinary' | 'rename' | 'remove' | 'stat' | 'mkdir'>;
const STAGING = `${DRAFT_ROOT}/.staging`;
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Mobile integrity, NOT desktop durability: no fsync, hard links, atomic rename or
 * inter-process/device lock. Share one instance per running plugin/namespace.
 * Stop gates rename admission; an admitted rename can finish after Stop.
 * An unreadable/unremovable target may survive rejection. Recovery validates it. */
export class AdapterDraftStorage implements DraftStorageIO {
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly published = new Set<string>();
    constructor(private readonly adapter: Adapter) {}

    private path(path: string, internal = false): string {
        if (!(path === DRAFT_ROOT || path.startsWith(`${DRAFT_ROOT}/`))
            || path.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
            || (!internal && (path === STAGING || path.startsWith(`${STAGING}/`))))
            throw new DraftError('invalid-path', 'Outside draft storage');
        return path;
    }
    private queued<T>(path: string, operation: () => Promise<T>): Promise<T> {
        const pending = (this.queues.get(path) ?? Promise.resolve()).catch(() => {}).then(operation);
        this.queues.set(path, pending);
        const clear = () => { if (this.queues.get(path) === pending) this.queues.delete(path); };
        void pending.then(clear, clear);
        return pending;
    }
    private async parents(path: string): Promise<void> {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            const folder = parts.slice(0, i).join('/');
            await this.queued(`mkdir:${folder}`, async () => {
                const stat = await this.adapter.stat(folder);
                if (stat?.type === 'folder') return;
                if (stat) throw new DraftError('io-error', 'Draft parent is not a folder');
                await this.adapter.mkdir(folder);
            });
        }
    }
    private async children(path: string): Promise<string[]> {
        const stat = await this.adapter.stat(path);
        if (!stat) return [];
        if (stat.type !== 'folder') throw new DraftError('io-error', 'Draft directory is not a folder');
        const listing = await this.adapter.list(path);
        return [...new Set([...listing.files, ...listing.folders].map(entry => {
            const name = entry.startsWith(`${path}/`) ? entry.slice(path.length + 1) : entry;
            if (name.includes('/')) throw new DraftError('invalid-path', 'Invalid draft listing');
            this.path(`${path}/${name}`, true);
            return name;
        }))];
    }
    async list(path: string): Promise<readonly string[]> {
        const names = await this.children(this.path(path));
        return path === DRAFT_ROOT ? names.filter(name => name !== '.staging') : names;
    }
    async read(path: string): Promise<Uint8Array> {
        return new Uint8Array(await this.adapter.readBinary(this.path(path)));
    }
    async remove(path: string): Promise<void> {
        this.path(path);
        await this.queued(path, async () => {
            if (await this.adapter.stat(path)) await this.adapter.remove(path);
            this.published.delete(path);
        });
    }
    private async discard(path: string): Promise<void> {
        try { if (await this.adapter.stat(path)) await this.adapter.remove(path); }
        catch { /* Best effort: staging is hidden, corrupt targets are reported by restore. */ }
    }
    async writeBlob(path: string, bytes: Uint8Array): Promise<void> {
        this.path(path);
        const owned = bytes.slice();
        await this.queued(path, async () => {
            if (await this.adapter.stat(path)) {
                if (!equal(await this.read(path), owned)) throw new DraftError('integrity-error', 'Immutable blob mismatch');
                return;
            }
            await this.parents(path);
            try {
                await this.adapter.writeBinary(path, owned.buffer);
                if (!equal(await this.read(path), owned)) throw new DraftError('integrity-error', 'Blob readback mismatch');
            } catch (cause) { await this.discard(path); throw cause; }
        });
    }
    async publish(path: string, bytes: Uint8Array, mayPublish: () => boolean): Promise<'published' | 'cancelled'> {
        this.path(path);
        const owned = bytes.slice();
        return this.queued(path, async () => {
            const existing = await this.adapter.stat(path);
            if (existing || this.published.has(path)) throw new DraftError('io-error', 'Generation already exists');
            const temporary = `${STAGING}/${crypto.randomUUID()}.tmp`;
            try {
                await this.parents(path);
                await this.parents(temporary);
                await this.adapter.writeBinary(temporary, owned.buffer);
                if (!equal(new Uint8Array(await this.adapter.readBinary(temporary)), owned))
                    throw new DraftError('integrity-error', 'Staging readback mismatch');
                // No await between create-only check, revocation check and rename admission.
                if (existing || this.published.has(path)) throw new DraftError('io-error', 'Generation already exists');
                if (!mayPublish()) return 'cancelled';
                this.published.add(path);
                try { await this.adapter.rename(temporary, path); }
                catch { /* Rename can throw AFTER moving: settle from target bytes below. */ }
                const target = await this.adapter.stat(path);
                if (!target) {
                    this.published.delete(path);
                    throw new DraftError('io-error', 'Nothing was published');
                }
                if (equal(await this.read(path), owned)) return 'published';
                // Failure here deliberately propagates: a corrupt visible generation may
                // remain, so the mobile contract cannot promise rejection == no target.
                await this.adapter.remove(path);
                this.published.delete(path);
                throw new DraftError('integrity-error', 'Published manifest readback mismatch');
            } finally { await this.discard(temporary); }
        });
    }
    /** Call only during restore before admitting writers. Never treat staging as a draft. */
    async cleanupTemporary(): Promise<readonly RecoveryIssue[]> {
        const issues: RecoveryIssue[] = [];
        try {
            for (const name of await this.children(STAGING)) {
                const path = `${STAGING}/${name}`;
                issues.push({ path, code: 'io-error', message: 'Interrupted draft staging found' });
                await this.discard(path);
            }
        } catch {
            issues.push({ path: STAGING, code: 'io-error', message: 'Cannot inspect draft staging' });
        }
        return issues;
    }
}
