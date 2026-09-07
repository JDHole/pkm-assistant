import { validateVaultPath, invocationHasAdminAccess } from './vault_path_validator.js';
import type { PathValidatorPlugin } from './vault_path_validator.js';
import { t } from '../../core/i18n/index.js';
import { isHiddenVaultPath } from './vault_adapter_io.js';
import { isFolderLike } from './vault_binary_io.js';
import type { VaultFileLike } from './vault_binary_io.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `delete` wg `inputSchema`. */
export interface DeleteToolArgs {
    path?: string;
    trash?: boolean;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Minimalny widok `App`: Vault API + adapter (kasowanie ukrytych plików przez admina). */
interface DeleteToolApp {
    vault: {
        adapter: {
            stat?: (path: string) => Promise<{ type?: string } | null | undefined>;
            trashSystem: (path: string) => Promise<boolean>;
            trashLocal: (path: string) => Promise<void>;
            remove: (path: string) => Promise<void>;
        };
        getAbstractFileByPath: (path: string) => VaultFileLike | null;
        trash: (file: VaultFileLike, system: boolean) => Promise<void>;
        delete: (file: VaultFileLike) => Promise<void>;
    };
}

export function createDeleteTool() {
    return {
        name: 'delete',
        description: t('mcp.delete.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: t('mcp.delete.param.path')
                },
                trash: {
                    type: 'boolean',
                    description: t('mcp.delete.param.trash')
                }
            },
            required: ['path']
        },
        // Sprint 04 Z10 (DRY-2): contextExtractor
        contextExtractor: (args: DeleteToolArgs) => ({ targetPath: args.path || '' }),
        execute: async (args: DeleteToolArgs, app: DeleteToolApp, plugin: PathValidatorPlugin) => {
            try {
                // Sprint 04 Z8 (DRY-1): centralized vault path validation
                const adminAccess = invocationHasAdminAccess(args, plugin);
                const validation = validateVaultPath(args.path, { adminAccess });
                if (!validation.ok) {
                    const errorKey = validation.code === 'protected'
                        ? 'mcp.delete.protected_path'
                        : 'mcp.delete.invalid_path';
                    throw new Error(t(errorKey));
                }
                const path = validation.safePath;

                // Default trash to true if undefined
                const trash = args.trash !== false;

                const file = app.vault.getAbstractFileByPath(path);

                // Ukryte pliki nie istnieją w indeksie Vault API. Admin usuwa je przez
                // DataAdapter, nadal z domyślnym koszem i bez kasowania folderów.
                if (adminAccess && (isHiddenVaultPath(path) || !file)) {
                    const adapter = app.vault.adapter;
                    const stat = await adapter.stat?.(path);
                    if (!stat) throw new Error(t('mcp.delete.not_found', { path }));
                    if (stat.type === 'folder') throw new Error(t('mcp.delete.not_a_file', { path }));

                    let trashedToSystem = false;
                    if (trash) {
                        trashedToSystem = await adapter.trashSystem(path);
                        if (!trashedToSystem) await adapter.trashLocal(path);
                    } else {
                        await adapter.remove(path);
                    }
                    return { success: true, path, trashedToSystem };
                }

                if (!file) {
                    throw new Error(t('mcp.delete.not_found', { path }));
                }

                if (isFolderLike(file)) {
                    throw new Error(t('mcp.delete.not_a_file', { path }));
                }

                if (trash) {
                    // trash(file, system: boolean)
                    // Prompt says: "true = system trash" for usage: app.vault.trash(file, true)
                    await app.vault.trash(file, true);
                } else {
                    await app.vault.delete(file);
                }

                return {
                    success: true,
                    path: file.path,
                    trashedToSystem: trash
                };

            } catch (error) {
                log.error('DeleteTool', 'Error:', error);
                return {
                    success: false,
                    error: (error as Error).message
                };
            }
        }
    };
}
