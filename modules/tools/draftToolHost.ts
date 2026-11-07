import { parseYaml, stringifyYaml } from '../../core/index.js';
import { DraftError, parseVaultPath } from '../vault-drafts/index.js';
import type { Change, DraftRef, DraftView } from '../vault-drafts/index.js';
import type { SearchToolPlugin } from './SearchTool.js';
import type { ArtifactFrontmatter } from '../artifacts/index.js';

const searchBases = new WeakMap<object, SearchToolPlugin>();
export function bindDraftSearchPlugin(local: object, base: SearchToolPlugin): void { searchBases.set(local, base); }
export function draftSearchBase(local: object): SearchToolPlugin | undefined { return searchBases.get(local); }

interface LocalFile { status?: 'ambiguous-input'; sources?: readonly DraftRef[]; path: string; name: string; basename: string; extension: string; stat: { size: number; mtime: number; ctime: number }; children?: LocalFile[]; }
const denied = (): never => { throw new DraftError('mutation-denied', 'Unsupported draft host operation'); };
/** No prototype/global fallthrough: an unknown method is an explicit refusal. */
function closed<T extends object>(surface: T): T {
    return new Proxy(Object.freeze(surface), { get(target, key, receiver) {
        if (key === 'then') return undefined;
        return Object.hasOwn(target, key) ? Reflect.get(target, key, receiver) : denied;
    }, set: denied, defineProperty: denied, deleteProperty: denied });
}
const frontmatterPattern = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
function frontmatter(text: string): { front: ArtifactFrontmatter; body: string } {
    const match = frontmatterPattern.exec(text);
    const parsed = match ? parseYaml(match[1]) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DraftError('invalid-transition', 'Invalid frontmatter');
    return { front: parsed as ArtifactFrontmatter, body: match ? text.slice(match[0].length) : text };
}

/** A new host per invocation gives keyword scans a distinct identity for every revision. */
export async function createDraftToolHost(view: DraftView, options: {
    writable: boolean; source: Change['source']; explicitFolderPath?: string; metadataFolder?: string; configDir?: string;
}) {
    const files = new Map<string, LocalFile>();
    const metadata = new Map<string, { frontmatter: ArtifactFrontmatter }>();
    const technicalFolders = new Set<string>();
    const file = (path: string, folder: boolean, size = 0, mtime = 0): LocalFile => {
        const name = path.split('/').pop() ?? '', dot = name.lastIndexOf('.');
        return { path, name, basename: dot < 0 ? name : name.slice(0, dot), extension: dot < 0 ? '' : name.slice(dot + 1),
            stat: { size, mtime, ctime: mtime }, ...(folder ? { children: [] } : {}) };
    };
    const refresh = async (): Promise<void> => {
        files.clear(); metadata.clear(); files.set('', file('', true));
        const walk = async (path: string): Promise<void> => {
            const listed = await view.list(path);
            for (const p of listed.ambiguous) {
                const resolved = view.resolve(p);
                if (resolved.kind === 'ambiguous-input') files.set(p, { ...file(p, false),
                    status: 'ambiguous-input', sources: resolved.sources.map(source => source.ref) });
            }
            for (const p of listed.files) {
                const stat = await view.stat(p);
                if (stat.kind !== 'file') continue;
                files.set(p, file(p, false, stat.bytes, stat.mtime));
                if (p.endsWith('.md') && options.metadataFolder && p.startsWith(`${options.metadataFolder}/`)) metadata.set(p, { frontmatter: frontmatter(await view.read(p)).front });
            }
            for (const p of listed.folders) { files.set(p, file(p, true)); await walk(p); }
        };
        await walk('');
        for (const path of technicalFolders) if (!files.has(path)) files.set(path, file(path, true));
        for (const entry of files.values()) if (entry.path) {
            const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
            if (!entry.path.split('/').some(part => part.startsWith('.'))) files.get(parent)?.children?.push(entry);
        }
    };
    await refresh();
    const get = (path: string): LocalFile | null => {
        if (!path || path === '/') return files.get('')!;
        parseVaultPath(path);
        const resolved = view.resolve(path);
        if (resolved.kind === 'ambiguous-input') throw new DraftError('ambiguous-input', `Ambiguous input ${path}: ${resolved.sources.map(source => source.ref.draftId).join(', ')}`);
        return files.get(path) ?? null;
    };
    const write = async (path: string, value: Parameters<DraftView['mutate']>[2], expectation: 'create' | 'file' | 'any' = 'any'): Promise<void> => {
        if (!options.writable) denied();
        await view.mutate(path, options.source, value, expectation);
        await refresh();
    };
    const mkdir = async (path: string): Promise<void> => {
        if (!options.writable) denied();
        parseVaultPath(path);
        const segments = path.split('/');
        for (let i = 1; i <= segments.length; i++) {
            const parent = segments.slice(0, i).join('/'), stat = await view.stat(parent);
            if (stat.kind === 'file') throw new DraftError('invalid-transition', 'Folder collides with file');
            if (stat.kind === 'missing') technicalFolders.add(parent);
        }
        if (path === options.explicitFolderPath && (await view.stat(path)).kind === 'missing') await write(path, { kind: 'folder' }, 'create');
        else await refresh();
    };
    const binary = async (path: string): Promise<ArrayBuffer> => (await view.readBinary(path)).slice().buffer;
    const remove = (path: string, disposition: 'trash' | 'permanent') => write(path, { kind: 'deleted', disposition }, 'file');
    const process = async (entry: { path: string }, fn: (text: string) => string | null): Promise<string> => {
        let output = '';
        await write(entry.path, text => { const next = fn(text); output = next ?? text; return next; }, 'file');
        return output;
    };
    const visible = (entry: LocalFile) => !entry.path.split('/').some(part => part.startsWith('.'));
    const adapter = closed({
        read: (path: string) => view.read(path), readBinary: binary,
        exists: async (path: string) => technicalFolders.has(path) || (await view.stat(path)).kind !== 'missing',
        stat: async (path: string) => {
            const stat = technicalFolders.has(path) ? { kind: 'folder' as const } : await view.stat(path);
            return stat.kind === 'missing' ? null : { type: stat.kind, size: stat.kind === 'file' ? stat.bytes : 0, mtime: stat.kind === 'file' ? stat.mtime : 0, ctime: 0 };
        },
        list: async (path: string) => {
            const listed = await view.list(path);
            if (!listed.ambiguous.length) return listed;
            const ambiguities: Record<string, { status: 'ambiguous-input'; sources: readonly DraftRef[] }> = {};
            for (const p of listed.ambiguous) {
                const resolved = view.resolve(p);
                if (resolved.kind === 'ambiguous-input') ambiguities[p] = {
                    status: 'ambiguous-input', sources: resolved.sources.map(source => source.ref) };
            }
            return { ...listed, files: [...listed.files, ...listed.ambiguous], ambiguities };
        }, mkdir,
        write: (path: string, text: string) => write(path, { kind: 'text', text }),
        writeBinary: (path: string, bytes: ArrayBuffer) => write(path, { kind: 'binary', bytes: new Uint8Array(bytes) }),
        remove: (path: string) => remove(path, 'permanent'),
        trashSystem: async (path: string) => { await remove(path, 'trash'); return true; },
        trashLocal: (path: string) => remove(path, 'trash'),
    });
    const vault = closed({
        adapter, configDir: options.configDir, getAbstractFileByPath: get, getRoot: () => files.get('')!,
        getFiles: () => [...files.values()].filter(entry => !entry.children && visible(entry)),
        getMarkdownFiles: () => [...files.values()].filter(entry => !entry.children && entry.extension === 'md' && visible(entry)),
        read: (entry: { path: string }) => view.read(entry.path), cachedRead: (entry: { path: string }) => view.read(entry.path),
        readBinary: (entry: { path: string }) => binary(entry.path),
        create: async (path: string, text: string) => { await write(path, { kind: 'text', text }, 'create'); return get(path)!; },
        modify: (entry: { path: string }, text: string) => write(entry.path, { kind: 'text', text }, 'file'), process,
        createBinary: async (path: string, bytes: ArrayBuffer) => { await write(path, { kind: 'binary', bytes: new Uint8Array(bytes) }, 'create'); return get(path)!; },
        modifyBinary: (entry: { path: string }, bytes: ArrayBuffer) => write(entry.path, { kind: 'binary', bytes: new Uint8Array(bytes) }, 'file'),
        createFolder: mkdir, trash: (entry: { path: string }, _system: boolean) => remove(entry.path, 'trash'),
        delete: (entry: { path: string }) => remove(entry.path, 'permanent'),
    });
    return closed({ vault,
        metadataCache: closed({ resolvedLinks: undefined, getFirstLinkpathDest: undefined, getFileCache: (entry: { path: string }) => metadata.get(entry.path) ?? null }),
        fileManager: closed({
            processFrontMatter: async (entry: { path: string }, fn: (front: ArtifactFrontmatter) => void) => {
                await process(entry, text => { const { front, body } = frontmatter(text); fn(front); const yaml = stringifyYaml(front).trimEnd(); if (!yaml) throw new DraftError('io-error', 'Cannot serialize frontmatter'); return `---\n${yaml}\n---\n${body}`; });
            },
            renameFile: denied, trashFile: (entry: { path: string }) => remove(entry.path, 'trash'),
        }),
    });
}
