import { MCPClient } from './MCPClient.js';
import { ToolRegistry } from './ToolRegistry.js';
import { PermissionSystem } from '../../core/index.js';
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

test('B06 write: administrator może zapisać chroniony plik .env', async t => {
    const app = makeApp();
    const vaultApp = app as unknown as ToolApp;
    const args = ctx({ path: '.env', mode: 'create', content: 'test=value' });

    const denied = await createWriteTool().execute(args, vaultApp, plugin(false)) as ToolRes;
    t.false(denied.success);
    t.false(Object.hasOwn(app.files, '.env'));

    const written = await createWriteTool().execute(args, vaultApp, plugin(true)) as ToolRes;
    t.true(written.success);
    t.is(app.files['.env'], 'test=value');
});

for (const name of ['list', 'read', 'write', 'delete', 'create_folder'] as const)
test(`F4 private drafts deny admin ${name} and preserve manifest`, async t => {
    const app = makeApp(), host = app as unknown as ToolApp, admin = plugin(true);
    const root = '.pkm-assistant/subagent-drafts';
    const path = `${root}/v1/draft/manifests/000002.json`;
    app.files[path] = 'MANIFEST';
    for (const dir of [root, `${root}/v1`, `${root}/v1/draft`, `${root}/v1/draft/manifests`]) app.folders.add(dir);
    const tool = { list: createListTool(), read: createReadTool(), write: createWriteTool(),
        delete: createDeleteTool(), create_folder: createCreateFolderTool(host) }[name];
    const result = await tool.execute(ctx({ path: name === 'create_folder' ? `${root}/extra` : path,
        folder: root, content: 'CORRUPTED', mode: 'replace' }), host, admin) as ToolRes;
    t.is(result.success, false);
    t.is(app.files[path], 'MANIFEST');
    const listed = await createListTool().execute(ctx({ folder: '.pkm-assistant' }), host, admin) as ToolRes;
    t.deepEqual(listed.files?.map(f => f.path), ['.pkm-assistant/agents']);
    const recursive = await createListTool().execute(ctx({ folder: '/', recursive: true }), host, admin) as ToolRes;
    t.deepEqual(recursive.files, []);
});

test('F4 public MCP admin cannot read or corrupt a private manifest', async t => {
    const app = makeApp(), host = app as unknown as ToolApp;
    const admin = { name: 'Nika', admin_access: true, mcp_servers: ['*'] };
    const path = '.pkm-assistant/subagent-drafts/v1/draft/manifests/000002.json';
    app.files[path] = 'MANIFEST';
    const registry = new ToolRegistry();
    for (const tool of [createReadTool(), createWriteTool(), createListTool()]) registry.registerTool(tool);
    const client = new MCPClient(host, { agentManager: { getAgent: () => admin, getActiveAgent: () => admin },
        permissionSystem: new PermissionSystem(host.vault, {}),
        approvalManager: { requestApproval: async () => ({ result: 'approve' }) } }, registry);
    for (const [name, args] of [['list', { folder: path.split('/').slice(0, -1).join('/') }],
        ['read', { path }], ['write', { path, content: 'CORRUPTED', mode: 'replace' }]] as const) {
        const result = await client.executeToolCall({ name, arguments: args }, 'Nika', { autonomy: 'yolo' }) as { isError: boolean; error: string };
        t.is(result.isError, true);
        t.regex(result.error, /Private draft storage/);
        t.is(await app.vault.adapter.read(path), 'MANIFEST');
    }
});
