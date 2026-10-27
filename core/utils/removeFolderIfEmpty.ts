type FolderAdapter = {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files?: string[]; folders?: string[] } | null | undefined>;
    rmdir(path: string, recursive: boolean): Promise<void>;
};

export type RemoveFolderResult =
    | { kind: 'missing' }
    | { kind: 'not-empty'; remaining: string[] }
    | { kind: 'removed' };

export async function removeFolderIfEmpty(adapter: FolderAdapter, path: string): Promise<RemoveFolderResult> {
    if (!await adapter.exists(path)) return { kind: 'missing' };
    const listing = await adapter.list(path);
    if (!listing || !Array.isArray(listing.files) || !Array.isArray(listing.folders)) {
        throw new Error(`Cannot inspect folder: ${path}`);
    }
    const remaining = [...listing.files, ...listing.folders];
    if (remaining.length) return { kind: 'not-empty', remaining };
    // Obsidian 1.14.5 non-recursive rmdir fails even for empty folders. Recursive
    // removal is safe only after checking that the folder is empty.
    await adapter.rmdir(path, true);
    return { kind: 'removed' };
}
