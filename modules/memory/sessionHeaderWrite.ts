import type { MemoryVaultAdapterLike } from './AgentMemory.js';
import { probeFile } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

/** Recognizable failure; the existing send admission restores the unsent draft. */
export class SessionHeaderWriteError extends Error {
    constructor() {
        super(t('chat.session.autosave_failed'));
        this.name = 'SessionHeaderWriteError';
    }
}

/** Caller holds the session queue. False means the original is safe to append to.
 * Like D1/settingsArmor, keep a verbatim local copy, outside settings rotation. */
export async function writeSessionHeader(
    adapter: MemoryVaultAdapterLike, agent: string, path: string, original: string, output: string,
): Promise<boolean> {
    let backupPath: string | null = null;
    try {
        const dir = '.pkm-assistant/backups';
        if (!await adapter.exists(dir)) await adapter.mkdir(dir);
        const filename = path.split('/').pop()!.replace(/\.md$/, '');
        const stem = `session-${agent}-${filename}-${Date.now()}`;
        for (let suffix = 0; suffix < 50; suffix++) {
            const candidate = `${dir}/${stem}${suffix ? `-${suffix}` : ''}.md.bak`;
            if (await probeFile(adapter, candidate) === 'missing') { backupPath = candidate; break; }
        }
        if (!backupPath) throw new Error('No free backup path');
        await adapter.write(backupPath, original);
        if (await adapter.read(backupPath) !== original) throw new Error('Backup verification failed');
    } catch {
        log.warn('AgentMemory', 'Session header unchanged: backup unavailable', { path });
        return false;
    }
    // Do not overwrite a pull that arrived while the backup was being written.
    if (await adapter.read(path) !== original) throw new SessionHeaderWriteError();
    try {
        await adapter.write(path, output);
        if (await adapter.read(path) === output) return true;
    } catch { /* One restoration attempt, including when write partially succeeded. */ }
    try {
        await adapter.write(path, original);
        if (await adapter.read(path) === original) {
            log.warn('AgentMemory', 'Session header write failed; original restored', { path, backupPath });
            return false;
        }
    } catch { /* Keep the verified backup and refuse any append. */ }
    log.error('AgentMemory', 'Session header restoration failed; recover from backup', { path, backupPath });
    throw new SessionHeaderWriteError();
}
