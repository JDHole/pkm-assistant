import { warnIfSensitive } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { validateVaultPath, invocationHasAdminAccess } from './vault_path_validator.js';
import type { PathValidatorPlugin } from './vault_path_validator.js';
import { ensureAdapterFolder, isHiddenVaultPath } from './vault_adapter_io.js';
import { isFolderLike } from './vault_binary_io.js';
import type { VaultFileLike } from './vault_binary_io.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `write` wg `inputSchema`. */
interface WriteToolArgs {
    path?: string;
    content?: unknown;
    mode?: string;
    old_text?: unknown;
    new_text?: unknown;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Minimalny widok `App`: Vault API + adapter (ukryte ścieżki poza indeksem Obsidiana). */
interface WriteToolApp {
    vault: {
        adapter: {
            exists: (path: string) => Promise<boolean>;
            read: (path: string) => Promise<string>;
            write: (path: string, content: string) => Promise<void>;
            mkdir?: (path: string) => Promise<void>;
        };
        getAbstractFileByPath: (path: string) => VaultFileLike | null;
        createFolder: (path: string) => Promise<unknown>;
        create: (path: string, content: string) => Promise<VaultFileLike>;
        read: (file: VaultFileLike) => Promise<string>;
        modify: (file: VaultFileLike, content: string) => Promise<void>;
        /** Zapis atomowy (wytyczna Obsidiana). Opcjonalny — starsze/atrapowe hosty go nie mają. */
        process?: (file: VaultFileLike, fn: (data: string) => string) => Promise<string>;
    };
}

/**
 * `Vault.modify` → `Vault.process` (wytyczna Obsidiana: zapis atomowy zamiast read-then-write).
 * `process` bierze funkcję transformującą, ale nasz `finalContent` jest już policzony —
 * `() => finalContent` przenosi go przez tę samą bramkę bez zmiany kontraktu wołacza.
 * Fallback na `modify` dla hostów bez `process` (harness mock je ma; atrapy testowe bywają
 * węższe — patrz `AdminVaultTools.test.ts`, gdzie ścieżki ukryte i tak idą przez `adapter.write`).
 */
async function writeFileContent(vault: WriteToolApp['vault'], file: VaultFileLike, finalContent: string): Promise<void> {
    if (typeof vault.process === 'function') {
        await vault.process(file, () => finalContent);
    } else {
        await vault.modify(file, finalContent);
    }
}

/** Wynik zapisu — `warnings` dochodzi tylko, gdy `warnIfSensitive` coś złapał. */
interface WriteResult {
    success: true;
    path: string;
    mode: string;
    bytesWritten: number;
    patchApplied?: boolean;
    warnings?: string[];
}

/** Zapewnia istnienie folderu nadrzędnego dla ścieżki vaulta (API-first). */
async function ensureParentFolder(app: WriteToolApp, path: string): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (!parent) return;
    if (app.vault.getAbstractFileByPath(parent)) return;
    try { await app.vault.createFolder(parent); } catch { /* wyścig / już istnieje */ }
}

export function createWriteTool() {
    return {
        name: 'write',
        description: t('mcp.write.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: t('mcp.write.param.path')
                },
                content: {
                    type: 'string',
                    description: t('mcp.write.param.content')
                },
                mode: {
                    type: 'string',
                    enum: ['create', 'append', 'prepend', 'replace', 'patch'],
                    description: t('mcp.write.param.mode')
                },
                old_text: {
                    type: 'string',
                    description: t('mcp.write.param.old_text')
                },
                new_text: {
                    type: 'string',
                    description: t('mcp.write.param.new_text')
                }
            },
            required: ['path']
        },
        contextExtractor: (args: WriteToolArgs) => ({ targetPath: args.path || '' }),
        execute: async (args: WriteToolArgs, app: WriteToolApp, plugin: PathValidatorPlugin) => {
            try {
                const mode = args.mode || 'replace';
                const adminAccess = invocationHasAdminAccess(args, plugin);
                const validation = validateVaultPath(args.path, { adminAccess });
                if (!validation.ok) {
                    const errorKey = validation.code === 'protected'
                        ? 'mcp.write.protected_path'
                        : 'mcp.write.invalid_path';
                    throw new Error(t(errorKey));
                }
                const path = validation.safePath;

                // Patch mode: old_text + new_text instead of content
                if (mode === 'patch') {
                    const { old_text, new_text } = args;
                    if (typeof old_text !== 'string' || old_text.length === 0) {
                        throw new Error(t('mcp.write.patch_requires_old_text'));
                    }
                    if (typeof new_text !== 'string') {
                        throw new Error(t('mcp.write.patch_requires_new_text'));
                    }
                    if (old_text === new_text) {
                        throw new Error(t('mcp.write.patch_identical'));
                    }

                    const sensitiveCheck = warnIfSensitive(new_text);

                    // Read existing file
                    const isHiddenPath = isHiddenVaultPath(path);
                    let oldContent: string;
                    if (isHiddenPath) {
                        if (!(await app.vault.adapter.exists(path))) {
                            throw new Error(t('mcp.write.file_not_found_patch', { path }));
                        }
                        oldContent = await app.vault.adapter.read(path);
                    } else {
                        const file = app.vault.getAbstractFileByPath(path);
                        if (!file || isFolderLike(file)) {
                            throw new Error(t('mcp.write.file_not_found_patch', { path }));
                        }
                        oldContent = await app.vault.read(file);
                    }

                    // Find old_text — must be unique
                    const firstIndex = oldContent.indexOf(old_text);
                    if (firstIndex === -1) {
                        throw new Error(t('mcp.write.old_text_not_found', { path }));
                    }
                    const secondIndex = oldContent.indexOf(old_text, firstIndex + 1);
                    if (secondIndex !== -1) {
                        throw new Error(t('mcp.write.old_text_multiple', { path }));
                    }

                    // Apply patch
                    const finalContent = oldContent.substring(0, firstIndex) + new_text + oldContent.substring(firstIndex + old_text.length);

                    // Write
                    if (isHiddenPath) {
                        await app.vault.adapter.write(path, finalContent);
                    } else {
                        const file = app.vault.getAbstractFileByPath(path);
                        await writeFileContent(app.vault, file as VaultFileLike, finalContent);
                    }

                    const res: WriteResult = { success: true, path, mode: 'patch', bytesWritten: new_text.length, patchApplied: true };
                    if (sensitiveCheck.hasSensitive) res.warnings = sensitiveCheck.warnings;
                    return res;
                }

                // Non-patch modes require content
                const { content } = args;
                if (typeof content !== 'string') { // Allow empty string content
                    throw new Error(t('mcp.write.content_not_string'));
                }

                // Check for sensitive data in content (warning, not blocking)
                const sensitiveCheck = warnIfSensitive(content);
                let file = app.vault.getAbstractFileByPath(path);

                if (file && isFolderLike(file)) {
                    throw new Error(t('mcp.write.path_not_file', { path }));
                }

                // Check if path is in a hidden/unindexed folder (e.g. .pkm-assistant)
                const isHiddenPath = isHiddenVaultPath(path);

                let finalContent = content;
                let bytesWritten = 0;

                // For hidden paths, use adapter directly (Obsidian doesn't index these)
                if (isHiddenPath) {
                    const fileExists = await app.vault.adapter.exists(path);
                    if (mode === 'create' && fileExists) {
                        throw new Error(t('mcp.write.file_exists', { path }));
                    }
                    if (mode === 'append' || mode === 'prepend') {
                        if (!fileExists) throw new Error(t('mcp.write.file_not_found', { path, mode }));
                        const oldContent = await app.vault.adapter.read(path);
                        finalContent = mode === 'append' ? oldContent + content : content + oldContent;
                    }
                    // Ensure parent folders exist (adapter.write doesn't auto-create)
                    const parentDir = path.substring(0, path.lastIndexOf('/'));
                    if (parentDir) await ensureAdapterFolder(app.vault.adapter, parentDir);
                    await app.vault.adapter.write(path, finalContent);
                    const res: WriteResult = { success: true, path, mode, bytesWritten: finalContent.length };
                    if (sensitiveCheck.hasSensitive) res.warnings = sensitiveCheck.warnings;
                    return res;
                }

                if (mode === 'create') {
                    if (file) {
                        throw new Error(t('mcp.write.file_exists', { path }));
                    }
                    await ensureParentFolder(app, path);
                    const createdFile = await app.vault.create(path, finalContent);
                    bytesWritten = content.length;
                    const res: WriteResult = { success: true, path: createdFile.path, mode: 'create', bytesWritten };
                    if (sensitiveCheck.hasSensitive) res.warnings = sensitiveCheck.warnings;
                    return res;
                }

                if (!file) {
                    if (mode === 'replace') {
                        // Treat as create
                        await ensureParentFolder(app, path);
                        const createdFile = await app.vault.create(path, finalContent);
                        const res: WriteResult = { success: true, path: createdFile.path, mode: 'replace (created)', bytesWritten: finalContent.length };
                        if (sensitiveCheck.hasSensitive) res.warnings = sensitiveCheck.warnings;
                        return res;
                    } else {
                        throw new Error(t('mcp.write.file_not_found', { path, mode }));
                    }
                }

                // File exists, proceed with modify
                const oldContent = await app.vault.read(file);

                if (mode === 'replace') {
                    finalContent = content;
                } else if (mode === 'append') {
                    finalContent = oldContent + content;
                } else if (mode === 'prepend') {
                    finalContent = content + oldContent;
                } else {
                    throw new Error(t('mcp.write.unknown_mode', { mode }));
                }

                await writeFileContent(app.vault, file, finalContent);
                bytesWritten = content.length;

                const res: WriteResult = { success: true, path: file.path, mode, bytesWritten };
                if (sensitiveCheck.hasSensitive) res.warnings = sensitiveCheck.warnings;
                return res;

            } catch (error) {
                log.error('WriteTool', 'Error:', error);
                return {
                    success: false,
                    error: (error as Error).message
                };
            }
        }
    };
}
