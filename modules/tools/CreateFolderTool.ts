import { validateVaultPath, invocationHasAdminAccess } from './vault_path_validator.js';
import type { PathValidatorPlugin } from './vault_path_validator.js';
import { t } from '../../core/i18n/index.js';
import { ensureAdapterFolder, isHiddenVaultPath } from './vault_adapter_io.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `create_folder` wg `inputSchema`. */
interface CreateFolderToolArgs {
    path?: string;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Minimalny widok `App`: Vault API + adapter (foldery ukryte poza indeksem Obsidiana). */
interface CreateFolderToolApp {
    vault: {
        adapter: { exists: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void> };
        getAbstractFileByPath: (path: string) => unknown;
        createFolder: (path: string) => Promise<unknown>;
    };
}

export function createCreateFolderTool(app: CreateFolderToolApp) {
    return {
        name: 'create_folder',
        description: t('mcp.create_folder.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: t('mcp.create_folder.param.path')
                }
            },
            required: ['path']
        },
        // Sprint 04 Z10 (DRY-2): contextExtractor
        contextExtractor: (args: CreateFolderToolArgs) => ({ targetPath: args.path || '' }),
        execute: async (args: CreateFolderToolArgs, runtimeApp: CreateFolderToolApp, plugin: PathValidatorPlugin) => {
            try {
                const appRef = runtimeApp || app;
                // Sprint 04 Z8 (DRY-1): centralized vault path validation
                const adminAccess = invocationHasAdminAccess(args, plugin);
                const validation = validateVaultPath(args.path, { adminAccess });
                if (!validation.ok) {
                    const errorKey = validation.code === 'protected'
                        ? 'mcp.create_folder.protected_path'
                        : 'mcp.create_folder.invalid_path';
                    throw new Error(t(errorKey));
                }
                const cleanPath = validation.safePath;

                if (adminAccess && isHiddenVaultPath(cleanPath)) {
                    const alreadyExisted = await appRef.vault.adapter.exists(cleanPath);
                    if (!alreadyExisted) {
                        await ensureAdapterFolder(appRef.vault.adapter, cleanPath);
                    }
                    return {
                        success: true,
                        path: cleanPath,
                        already_existed: alreadyExisted,
                        message: t(alreadyExisted
                            ? 'mcp.create_folder.already_exists'
                            : 'mcp.create_folder.created', { path: cleanPath })
                    };
                }

                // Check if already exists
                const existing = appRef.vault.getAbstractFileByPath(cleanPath);
                if (existing) {
                    return {
                        success: true,
                        path: cleanPath,
                        already_existed: true,
                        message: t('mcp.create_folder.already_exists', { path: cleanPath })
                    };
                }

                // Create folder (E2.6 API-first — vault.createFolder tworzy też foldery nadrzędne)
                await appRef.vault.createFolder(cleanPath);

                return {
                    success: true,
                    path: cleanPath,
                    already_existed: false,
                    message: t('mcp.create_folder.created', { path: cleanPath })
                };
            } catch (error) {
                log.error('CreateFolderTool', 'Error:', error);
                return {
                    success: false,
                    error: (error as Error).message
                };
            }
        }
    };
}
