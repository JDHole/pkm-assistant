import { probeFile, ensureAdapterFolder } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

interface BrainAdapter {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir?(path: string): Promise<void>;
}

/** The caller has already read and merged original. Healthy writes keep their exact I/O.
 * A repaired write keeps a verified, collision-safe copy using the D1/D7 pattern. */
export async function writeBrainContent(
    adapter: BrainAdapter, path: string, original: string, output: string, repaired: boolean,
): Promise<void> {
    if (!repaired) { await adapter.write(path, output); return; }
    const dir = '.pkm-assistant/backups';
    const agent = path.split('/').slice(-3, -2)[0] || 'agent';
    const stem = `${dir}/brain-${agent}-${Date.now()}`;
    let backupPath = '';
    try {
        await ensureAdapterFolder(adapter, dir);
        for (let suffix = 0; suffix < 50; suffix++) {
            const candidate = `${stem}${suffix ? `-${suffix}` : ''}.md.bak`;
            if (await probeFile(adapter, candidate) === 'missing') { backupPath = candidate; break; }
        }
        if (!backupPath) throw new Error('No free brain backup path');
        await adapter.write(backupPath, original);
        if (await adapter.read(backupPath) !== original) throw new Error('Brain backup verification failed');
    } catch {
        log.warn('AgentMemory', 'Brain unchanged: backup unavailable', { path, backupPath });
        throw new BrainWriteError('backup-unavailable');
    }
    if (await adapter.read(path) !== original) {
        log.warn('AgentMemory', 'Brain changed during backup; write refused', { path, backupPath });
        throw new BrainWriteError('source-changed');
    }
    try {
        await adapter.write(path, output);
        if (await adapter.read(path) === output) {
            log.warn('AgentMemory', 'Brain synchronization conflict repaired', { path, backupPath });
            return;
        }
    } catch { /* One restoration attempt, as in D7. */ }
    try {
        await adapter.write(path, original);
        if (await adapter.read(path) === original) {
            log.warn('AgentMemory', 'Brain write failed; original restored', { path, backupPath });
            throw new BrainWriteError('write-restored');
        }
    } catch (error) {
        if (error instanceof BrainWriteError && error.reason === 'write-restored') throw error;
    }
    log.error('AgentMemory', 'Brain restoration failed; recover from backup', { path, backupPath });
    throw new BrainWriteError('restore-failed');
}
export class BrainWriteError extends Error {
    constructor(readonly reason: 'backup-unavailable' | 'source-changed' | 'write-restored' | 'restore-failed') {
        super(t('chat.session.autosave_failed'));
        this.name = 'BrainWriteError';
    }
}
