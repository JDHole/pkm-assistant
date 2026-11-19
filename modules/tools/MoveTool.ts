import { t } from '../../core/i18n/index.js';
import { validateVaultPath } from './vault_path_validator.js';
import { isFolderLike } from './vault_binary_io.js';
import type { VaultFileLike } from './vault_binary_io.js';

interface MoveArgs {
    from?: string;
    to?: string;
    mode?: string;
}
interface MoveApp {
    vault: {
        adapter: { exists(path: string): Promise<boolean> };
        getAbstractFileByPath(path: string): (VaultFileLike & { stat?: { size: number } }) | null;
        createFolder(path: string): Promise<unknown>;
        copy(file: VaultFileLike, path: string): Promise<unknown>;
    };
    fileManager: { renameFile(file: VaultFileLike, path: string): Promise<void> };
}

export function createMoveTool() {
    return {
        name: 'move',
        description: t('mcp.move.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: t('mcp.move.from') },
                to: { type: 'string', description: t('mcp.move.to') },
                mode: { type: 'string', enum: ['move', 'copy'], description: t('mcp.move.mode') },
            },
            required: ['from', 'to'],
        },
        contextExtractor: (args: MoveArgs) => ({ targetPath: args.to || '' }),
        execute: async (args: MoveArgs, app: MoveApp, _plugin: unknown, context?: { shouldAbort(): boolean }) => {
            try {
                const from = validateVaultPath(args.from);
                const to = validateVaultPath(args.to);
                if (!from.ok || !to.ok || !from.safePath || !to.safePath) throw new Error(t('mcp.move.invalid_path'));
                const mode = args.mode ?? 'move';
                if (mode !== 'move' && mode !== 'copy') throw new Error(t('mcp.move.invalid_mode'));
                const file = app.vault.getAbstractFileByPath(from.safePath);
                if (!file) throw new Error(t('mcp.move.not_found', { path: from.safePath }));
                if (isFolderLike(file)) throw new Error(t('mcp.move.not_file', { path: from.safePath }));
                if (await app.vault.adapter.exists(to.safePath)) throw new Error(t('mcp.move.exists', { path: to.safePath }));
                if (context?.shouldAbort()) throw new Error(t('chat.substrip.status_aborted'));
                const parent = to.safePath.substring(0, to.safePath.lastIndexOf('/'));
                if (parent && !app.vault.getAbstractFileByPath(parent)) {
                    try { await app.vault.createFolder(parent); } catch { /* race or invalid parent: operation reports failure */ }
                }
                if (context?.shouldAbort()) throw new Error(t('chat.substrip.status_aborted'));
                if (mode === 'copy') await app.vault.copy(file, to.safePath);
                else await app.fileManager.renameFile(file, to.safePath);
                return { success: true, mode, from: from.safePath, to: to.safePath, ...(file.stat ? { bytes: file.stat.size } : {}) };
            } catch (error) {
                return { success: false, error: (error as Error).message };
            }
        },
    };
}
