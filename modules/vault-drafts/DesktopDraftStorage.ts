import { DRAFT_ROOT } from './DraftPersistence.js';
import { DraftError } from './types.js';
import type { DraftStorageIO } from './types.js';

/** Desktop-only host capability. No Node runtime import in the plugin bundle. */
export type DraftFileSystem = Pick<typeof import('node:fs'), 'mkdirSync' | 'lstatSync' | 'readdirSync' |
    'readFileSync' | 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'linkSync' | 'unlinkSync'>;
const missing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/** fsync staging + synchronous create-only hard-link publication. Stop cannot run
 * between mayPublish and linkSync. Only the private namespace is ever writable. */
export class DesktopDraftStorage implements DraftStorageIO {
    constructor(private readonly fs: DraftFileSystem, private readonly basePath: string) {}
    private path(relative: string, parents = false): string {
        if (!(relative === DRAFT_ROOT || relative.startsWith(`${DRAFT_ROOT}/`))
            || relative.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..'))
            throw new DraftError('invalid-path', 'Outside draft storage');
        const parts = relative.split('/');
        let path = this.basePath;
        for (let i = 0; i < parts.length; i++) {
            path += `/${parts[i]}`;
            try {
                if (this.fs.lstatSync(path).isSymbolicLink()) throw new DraftError('invalid-path', 'Symlink in draft storage');
            } catch (error) {
                if (!missing(error)) throw error;
                if (parents && i < parts.length - 1) this.fs.mkdirSync(path);
            }
        }
        return path;
    }
    list(path: string): Promise<readonly string[]> {
        try { return Promise.resolve(this.fs.readdirSync(this.path(path))); }
        catch (error) { if (missing(error)) return Promise.resolve([]); return Promise.reject(error instanceof Error ? error : new DraftError('io-error', String(error))); }
    }
    read(path: string): Promise<Uint8Array> { return Promise.resolve(new Uint8Array(this.fs.readFileSync(this.path(path)))); }
    remove(path: string): Promise<void> {
        try { this.fs.unlinkSync(this.path(path)); }
        catch (error) { if (!missing(error)) return Promise.reject(error instanceof Error ? error : new DraftError('io-error', String(error))); }
        return Promise.resolve();
    }
    async writeBlob(path: string, bytes: Uint8Array): Promise<void> {
        const target = this.path(path, true);
        try {
            const current = this.fs.readFileSync(target);
            if (current.length !== bytes.length || current.some((byte, i) => byte !== bytes[i]))
                throw new DraftError('integrity-error', 'Immutable blob mismatch');
        } catch (error) {
            if (!missing(error)) throw error;
            await this.publish(path, bytes, () => true);
        }
    }
    publish(path: string, bytes: Uint8Array, mayPublish: () => boolean): Promise<'published' | 'cancelled'> {
        const target = this.path(path, true);
        const temporary = `${target}.tmp-${crypto.randomUUID()}`;
        let fd: number | undefined;
        try {
            fd = this.fs.openSync(temporary, 'wx', 0o600);
            this.fs.writeFileSync(fd, bytes);
            this.fs.fsyncSync(fd);
            this.fs.closeSync(fd); fd = undefined;
            if (!mayPublish()) return Promise.resolve('cancelled');
            this.fs.linkSync(temporary, target);
            return Promise.resolve('published');
        } catch (error) { return Promise.reject(error instanceof Error ? error : new DraftError('io-error', String(error))); }
        finally {
            if (fd !== undefined) this.fs.closeSync(fd);
            try { this.fs.unlinkSync(temporary); } catch { /* Unpublished staging is never restored. */ }
        }
    }
}
