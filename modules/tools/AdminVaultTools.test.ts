import test from 'ava';
import { createCreateFolderTool } from './CreateFolderTool.js';
import { createDeleteTool } from './DeleteTool.js';
import { createListTool } from './ListTool.js';
import { createReadTool } from './ReadTool.js';
import { createWriteTool } from './WriteTool.js';

/**
 * Kontrakt `App`, jakiego oczekują prymitywy vaultowe — przecięcie ich lokalnych wycinków.
 * Test karmi narzędzia KACZKĄ (adapter w pamięci), więc rzutujemy raz, na atrapie,
 * zamiast przy każdym wywołaniu.
 */
type ToolApp =
    Parameters<ReturnType<typeof createWriteTool>['execute']>[1]
    & Parameters<ReturnType<typeof createReadTool>['execute']>[1]
    & Parameters<ReturnType<typeof createListTool>['execute']>[1]
    & Parameters<ReturnType<typeof createDeleteTool>['execute']>[1]
    & Parameters<ReturnType<typeof createCreateFolderTool>['execute']>[1];

/** Wynik narzędzia czytany w asercjach — kształt zależy od gałęzi, więc pola opcjonalne. */
type ToolRes = {
    success?: boolean;
    error?: string;
    content?: string;
    files?: Array<{ path?: string }>;
};

function makeApp() {
    const files: Record<string, string> = {};
    const folders = new Set(['.pkm-assistant', '.pkm-assistant/agents']);
    const adapter = {
        async exists(path: string) { return Object.hasOwn(files, path) || folders.has(path); },
        async mkdir(path: string) { folders.add(path); },
        async read(path: string) {
            if (!Object.hasOwn(files, path)) throw new Error(`ENOENT ${path}`);
            return files[path];
        },
        async write(path: string, content: string) { files[path] = content; },
        async remove(path: string) { delete files[path]; },
        async stat(path: string) {
            if (Object.hasOwn(files, path)) return { type: 'file' };
            if (folders.has(path)) return { type: 'folder' };
            return null;
        },
        async trashSystem(path: string) { delete files[path]; return true; },
        async trashLocal(path: string) { delete files[path]; },
        async list(folder: string) {
            const prefix = folder ? `${folder}/` : '';
            const direct = (path: string) => {
                if (!path.startsWith(prefix)) return false;
                return !path.slice(prefix.length).includes('/');
            };
            return {
                files: Object.keys(files).filter(direct),
                folders: [...folders].filter(p => p !== folder && direct(p)),
            };
        },
    };
    return {
        files,
        folders,
        vault: {
            adapter,
            getAbstractFileByPath: () => null,
            getRoot: () => ({ path: '/', name: '/', children: [] }),
            getFiles: () => [],
            createFolder: async (path: string) => folders.add(path),
        }
    };
}

function plugin(adminAccess: boolean) {
    const agent = { name: 'Nika', admin_access: adminAccess };
    return {
        agentManager: {
            getAgent: (name: string) => name === 'Nika' ? agent : null,
            getActiveAgent: () => agent,
        }
    };
}

const ctx = (args: Record<string, unknown>) => ({ ...args, _invocationAgentName: 'Nika' });

test('A1 admin: normalne prymitywy create_folder/write/read/list/delete działają w .pkm-assistant', async t => {
    const app = makeApp();
    const vaultApp = app as unknown as ToolApp;
    const adminPlugin = plugin(true);
    const dir = '.pkm-assistant/agents/nika-kit';
    const path = `${dir}/agent.yaml`;

    const made = await createCreateFolderTool(vaultApp).execute(ctx({ path: dir }), vaultApp, adminPlugin);
    t.true(made.success);

    const written = await createWriteTool().execute(ctx({
        path,
        mode: 'create',
        content: 'name: Test\naccess_policy_version: 2\n'
    }), vaultApp, adminPlugin) as ToolRes;
    t.true(written.success);

    const read = await createReadTool().execute(ctx({ path }), vaultApp, adminPlugin) as ToolRes;
    t.true(read.success);
    t.true(read.content!.includes('name: Test'));

    const listed = await createListTool().execute(ctx({ folder: dir }), vaultApp, adminPlugin) as ToolRes;
    t.true(listed.success);
    t.true(listed.files!.some(file => file.path === path));

    const deleted = await createDeleteTool().execute(ctx({ path, trash: false }), vaultApp, adminPlugin);
    t.true(deleted.success);
    t.false(Object.hasOwn(app.files, path));
});

test('A1 zwykły agent nie zapisze w .pkm-assistant; admin nadal nie przejdzie traversal', async t => {
    const app = makeApp();
    const vaultApp = app as unknown as ToolApp;
    const nonAdmin = await createWriteTool().execute(ctx({
        path: '.pkm-assistant/agents/hack.yaml',
        mode: 'create',
        content: 'x'
    }), vaultApp, plugin(false)) as ToolRes;
    t.false(nonAdmin.success);

    const traversal = await createWriteTool().execute(ctx({
        path: '../../outside.txt',
        mode: 'create',
        content: 'x'
    }), vaultApp, plugin(true)) as ToolRes;
    t.false(traversal.success);
});
