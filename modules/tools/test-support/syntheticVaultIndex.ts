/** Synthetic in-memory Obsidian index, independent of adapter operation counters. */
export function syntheticVaultIndex(files: Map<string, Uint8Array>, folders: Set<string>, mtime = 7) {
    type Entry = { path: string; name: string; basename: string; extension: string;
        stat: { size: number; mtime: number; ctime: number }; children?: Entry[] };
    const visible = (path: string) => !path.split('/').some(part => part.startsWith('.'));
    const file = (path: string): Entry => ({ path, name: path.split('/').pop()!,
        basename: path.split('/').pop()!.replace(/\.[^.]*$/, ''), extension: path.includes('.') ? path.split('.').pop()! : '',
        stat: { size: files.get(path)?.length ?? 0, mtime, ctime: mtime } });
    const get = (path: string): Entry | null => {
        if (!visible(path)) return null;
        if (files.has(path)) return file(path);
        const prefix = path ? `${path}/` : '';
        if (path && !folders.has(path) && ![...files.keys(), ...folders].some(key => key.startsWith(prefix))) return null;
        return { ...file(path), get children() {
            const paths = new Set<string>();
            for (const key of [...files.keys(), ...folders]) if (visible(key) && key.startsWith(prefix) && key !== path)
                paths.add(prefix + key.slice(prefix.length).split('/')[0]);
            return [...paths].map(child => get(child)!);
        } };
    };
    return { getAbstractFileByPath: get, getRoot: () => get('')!,
        getFiles: () => [...files.keys()].filter(visible).map(file),
        getMarkdownFiles: () => [...files.keys()].filter(path => visible(path) && path.endsWith('.md')).map(file) };
}
