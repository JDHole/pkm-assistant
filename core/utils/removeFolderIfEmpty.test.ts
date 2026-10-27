import test from 'ava';
import { removeFolderIfEmpty } from '../index.js';

function makeAdapter() {
    const folders = new Set(['root', 'root/sub']);
    const files = new Map([['root/notatki.md', 'treść'], ['root/sub/plik.md', 'dane']]);
    return {
        folders, files,
        exists: async (path: string) => folders.has(path) || files.has(path),
        list: async (path: string) => ({
            files: [...files.keys()].filter(f => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/')),
            folders: [...folders].filter(f => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/')),
        }),
        rmdir: async (path: string, recursive: boolean) => {
            if (!recursive) throw Object.assign(new Error('is a directory'), { code: 'ERR_FS_EISDIR' });
            for (const file of files.keys()) if (file.startsWith(`${path}/`)) files.delete(file);
            for (const folder of folders) if (folder === path || folder.startsWith(`${path}/`)) folders.delete(folder);
        },
    };
}

test('missing nie zmienia istniejących danych', async t => {
    const adapter = makeAdapter();
    t.deepEqual(await removeFolderIfEmpty(adapter, 'brak'), { kind: 'missing' });
    t.is(adapter.files.get('root/notatki.md'), 'treść');
});

test('not-empty zwraca wpisy i zachowuje całą zawartość', async t => {
    const adapter = makeAdapter();
    t.deepEqual(await removeFolderIfEmpty(adapter, 'root'), {
        kind: 'not-empty', remaining: ['root/notatki.md', 'root/sub'],
    });
    t.deepEqual([...adapter.folders], ['root', 'root/sub']);
    t.deepEqual([...adapter.files], [['root/notatki.md', 'treść'], ['root/sub/plik.md', 'dane']]);
});

test('removed usuwa pusty folder', async t => {
    const adapter = makeAdapter();
    adapter.folders.add('pusty');
    t.deepEqual(await removeFolderIfEmpty(adapter, 'pusty'), { kind: 'removed' });
    t.false(await adapter.exists('pusty'));
});
