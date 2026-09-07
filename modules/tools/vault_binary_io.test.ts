import test from 'ava';
import { writeText } from './vault_binary_io.js';
import type { BinaryIoApp, VaultFileLike } from './vault_binary_io.js';

/**
 * obsidianmd (release 2.2.0 / W4): `writeText` na plik ISTNIEJĄCY w vaulcie robi
 * `Vault.modify` → `Vault.process` (zapis atomowy, wytyczna katalogu Obsidiana), z fallbackiem
 * na `modify` dla hostów bez `process` (feature-detect — ten sam wzorzec, który plik już
 * stosuje dla `getAbstractFileByPath`/inne opcjonalne metody Vault API).
 */

function makeApp(existing: Record<string, string> = {}, withProcess = true) {
    const files = { ...existing };
    const calls: string[] = [];
    const fileObj = (path: string): VaultFileLike => ({ path, name: path.split('/').pop() as string });

    const base = {
        adapter: {
            async exists() { return false; },
            async mkdir() { /* noop */ },
            async write() { throw new Error('not a hidden path in this test'); },
            async readBinary(): Promise<ArrayBuffer> { throw new Error('unused'); },
            async writeBinary(): Promise<void> { throw new Error('unused'); },
        },
        getAbstractFileByPath: (path: string) =>
            Object.prototype.hasOwnProperty.call(files, path) ? fileObj(path) : null,
        createFolder: async () => { /* noop */ },
        readBinary: async (): Promise<ArrayBuffer> => { throw new Error('unused'); },
        createBinary: async (): Promise<unknown> => { throw new Error('unused'); },
        modifyBinary: async (): Promise<unknown> => { throw new Error('unused'); },
        create: async (path: string, content: string) => { files[path] = content; return fileObj(path); },
        modify: async (file: VaultFileLike, content: string) => { calls.push('modify'); files[file.path] = content; },
    };
    const vault = withProcess
        ? {
            ...base,
            process: async (file: VaultFileLike, fn: (data: string) => string) => {
                calls.push('process');
                const next = fn(files[file.path]);
                files[file.path] = next;
                return next;
            },
        }
        : base;

    return { app: { vault } as unknown as BinaryIoApp, files, calls };
}

test('plik istniejący: gdy vault.process dostępny, writeText idzie przez process (nie modify)', async t => {
    const { app, files, calls } = makeApp({ 'Attachments/note.md': 'stara' });
    await writeText(app, 'Attachments/note.md', 'nowa');
    t.is(files['Attachments/note.md'], 'nowa');
    t.deepEqual(calls, ['process']);
});

test('plik istniejący: bez vault.process spada na modify (zachowanie sprzed zmiany)', async t => {
    const { app, files, calls } = makeApp({ 'Attachments/note.md': 'stara' }, false);
    await writeText(app, 'Attachments/note.md', 'nowa');
    t.is(files['Attachments/note.md'], 'nowa');
    t.deepEqual(calls, ['modify']);
});

test('plik nowy: writeText woła vault.create, nie modify/process', async t => {
    const { app, files, calls } = makeApp({});
    await writeText(app, 'Attachments/nowy.md', 'świeża treść');
    t.is(files['Attachments/nowy.md'], 'świeża treść');
    t.deepEqual(calls, []);
});

test('ścieżka ukryta (.pkm-assistant): writeText idzie przez adapter, process/modify nietknięte', async t => {
    const written: Record<string, string> = {};
    const app: BinaryIoApp = {
        vault: {
            adapter: {
                async exists() { return true; },
                async mkdir() { /* noop */ },
                async write(path: string, content: string) { written[path] = content; },
                async readBinary(): Promise<ArrayBuffer> { throw new Error('unused'); },
                async writeBinary(): Promise<void> { throw new Error('unused'); },
            },
            createFolder: async () => { throw new Error('nie powinno być wołane dla ścieżki ukrytej'); },
            readBinary: async (): Promise<ArrayBuffer> => { throw new Error('unused'); },
            createBinary: async (): Promise<unknown> => { throw new Error('unused'); },
            modifyBinary: async (): Promise<unknown> => { throw new Error('unused'); },
            create: async (): Promise<unknown> => { throw new Error('nie powinno być wołane'); },
            modify: async (): Promise<unknown> => { throw new Error('nie powinno być wołane'); },
            process: async (): Promise<string> => { throw new Error('nie powinno być wołane'); },
        },
    };
    await writeText(app, '.pkm-assistant/skrzynka.md', 'tresc');
    t.is(written['.pkm-assistant/skrzynka.md'], 'tresc');
});
