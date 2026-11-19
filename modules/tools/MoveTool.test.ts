import test from 'ava';
import { createMoveTool } from './MoveTool.js';
import { MCPClient } from './MCPClient.js';
import type { MCPClientApp, MCPClientPlugin, MCPToolRegistryLike } from './MCPClient.js';

function fixture() {
    const files = new Map<string, { path: string; name: string; bytes: Uint8Array; stat: { size: number }; children?: unknown[] }>();
    const data = new Uint8Array([0, 255, 128, 42]);
    files.set('in/a.png', { path: 'in/a.png', name: 'a.png', bytes: data, stat: { size: 4 } });
    files.set('in/folder', { path: 'in/folder', name: 'folder', bytes: data, stat: { size: 0 }, children: [] });
    const app = { vault: {
        adapter: { exists: async (path: string) => files.has(path) },
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        createFolder: async (_path: string) => {},
        copy: async (file: { path: string }, path: string) => {
            const source = files.get(file.path)!;
            files.set(path, { ...source, path, bytes: source.bytes.slice() });
        },
    }, fileManager: { renameFile: async (file: { path: string }, path: string) => {
        const source = files.get(file.path)!; files.delete(file.path); files.set(path, { ...source, path });
    } } };
    return { app, files };
}

test('copy preserves every binary byte and creates parent folders', async t => {
    const { app, files } = fixture();
    let created = '';
    app.vault.createFolder = async path => { created = path; };
    const result = await createMoveTool().execute({ from: 'in/a.png', to: 'photos/a.png', mode: 'copy' }, app, {});
    t.deepEqual(result, { success: true, mode: 'copy', from: 'in/a.png', to: 'photos/a.png', bytes: 4 });
    t.deepEqual([...files.get('photos/a.png')!.bytes], [0, 255, 128, 42]);
    t.is(created, 'photos');
    t.true(files.has('in/a.png'));
});

test('move uses file manager and rejects existing targets and folders', async t => {
    const { app, files } = fixture();
    const tool = createMoveTool();
    t.false((await tool.execute({ from: 'in/a.png', to: 'in/folder' }, app, {})).success);
    t.false((await tool.execute({ from: 'in/folder', to: 'out/folder' }, app, {})).success);
    t.deepEqual(await tool.execute({ from: 'in/a.png', to: 'out/a.png' }, app, {}),
        { success: true, mode: 'move', from: 'in/a.png', to: 'out/a.png', bytes: 4 });
    t.false(files.has('in/a.png'));
    t.deepEqual([...files.get('out/a.png')!.bytes], [0, 255, 128, 42]);
});

test('MCP checks source and destination separately and scopes approvals to both', async t => {
    const { app, files } = fixture();
    const tool = { ...createMoveTool(), source: 'built-in' };
    let denied = '';
    const checks: string[] = [];
    const approvals: Array<Record<string, unknown>> = [];
    const plugin = {
        agentManager: { getAgent: () => ({ name: 'A' }) },
        permissionSystem: {
            checkPermission: (_agent: unknown, action: string, path: string) => {
                checks.push(`${action}:${path}`);
                return { allowed: path !== denied, requiresApproval: false, reason: 'denied' };
            },
            requiresApproval: () => true,
        },
        approvalManager: { requestApproval: async (request: Record<string, unknown>) => { approvals.push(request); return { result: 'approve' }; } },
    };
    const client = new MCPClient(app as unknown as MCPClientApp, plugin as unknown as MCPClientPlugin,
        { getTool: () => tool } as unknown as MCPToolRegistryLike);
    const call = (from: string, to: string, mode = 'move') => client.executeToolCall({ name: 'move', arguments: { from, to, mode } }, 'A');
    denied = 'in/a.png';
    t.regex(JSON.stringify(await call('in/a.png', 'out/a.png')), /denied/i);
    denied = 'out/a.png';
    t.regex(JSON.stringify(await call('in/a.png', 'out/a.png')), /denied/i);
    t.true(files.has('in/a.png'));
    denied = '';
    t.deepEqual(await call('in/a.png', 'out/a.png', 'copy'), { success: true, mode: 'copy', from: 'in/a.png', to: 'out/a.png', bytes: 4 });
    t.true(checks.includes('vault.delete:in/a.png'));
    t.true(checks.includes('vault.read:in/a.png'));
    t.true(checks.includes('vault.write:out/a.png'));
    t.is(approvals[0].approvalTarget, '["copy","in/a.png","out/a.png"]');
    t.regex(String(approvals[0].preview), /in\/a\.png[\s\S]*out\/a\.png/);
});

test('real path guard denies a read-only source for move and a read-only destination for copy', async t => {
    const { PermissionSystem } = await import('../../core/index.js');
    const { app, files } = fixture();
    const agent = { name: 'A', focusFolders: [
        { path: 'in', access: 'read' }, { path: 'out', access: 'write' },
    ] };
    const plugin = { agentManager: { getAgent: () => agent }, permissionSystem: new PermissionSystem(null, {}) };
    const tool = { ...createMoveTool(), source: 'built-in' };
    const client = new MCPClient(app as unknown as MCPClientApp, plugin as unknown as MCPClientPlugin,
        { getTool: () => tool } as unknown as MCPToolRegistryLike);
    const call = (from: string, to: string, mode: string) => client.executeToolCall({ name: 'move', arguments: { from, to, mode } }, 'A', { autonomy: 'yolo' });
    t.regex(JSON.stringify(await call('in/a.png', 'out/a.png', 'move')), /Permission denied/);
    t.regex(JSON.stringify(await call('out/a.png', 'in/b.png', 'copy')), /Permission denied/);
    t.true(files.has('in/a.png'));
    t.false(files.has('out/a.png'));
});

test('disabled write or delete tools cannot be bypassed through move', async t => {
    const { app, files } = fixture();
    const tool = { ...createMoveTool(), source: 'built-in' };
    let disabled = 'delete';
    const plugin = { agentManager: { getAgent: () => ({ name: 'A' }) },
        permissionSystem: { checkPermission: () => ({ allowed: true }), requiresApproval: () => false } };
    const registry = { getTool: () => tool, checkToolAxis: (_agent: unknown, name: string) => ({ allowed: name !== disabled }) };
    const client = new MCPClient(app as unknown as MCPClientApp, plugin as unknown as MCPClientPlugin, registry as unknown as MCPToolRegistryLike);
    const call = () => client.executeToolCall({ name: 'move', arguments: { from: 'in/a.png', to: 'out/a.png' } }, 'A');
    t.regex(JSON.stringify(await call()), /Permission denied/);
    disabled = 'write';
    t.regex(JSON.stringify(await call()), /Permission denied/);
    t.true(files.has('in/a.png'));
});

test('draft execution refuses before any vault mutation', async t => {
    const { app, files } = fixture();
    const tool = { ...createMoveTool(), source: 'built-in' };
    const plugin = { agentManager: { getAgent: () => ({ name: 'A' }) }, permissionSystem: {} };
    const client = new MCPClient(app as unknown as MCPClientApp, plugin as unknown as MCPClientPlugin,
        { getTool: () => tool } as unknown as MCPToolRegistryLike);
    const options = { vaultExecution: { kind: 'overlay-write', workspace: {} } } as unknown as Parameters<typeof client.executeToolCall>[2];
    const result = await client.executeToolCall({ name: 'move', arguments: { from: 'in/a.png', to: 'out/a.png' } }, 'A', options);
    t.regex(JSON.stringify(result), /draft|szkic/i);
    t.true(files.has('in/a.png'));
    t.false(files.has('out/a.png'));
});

test('persistent approval is specific to the mode and both paths', async t => {
    const { ApprovalManager } = await import('../../core/index.js');
    const { app } = fixture();
    const manager = new ApprovalManager(null);
    let prompts = 0;
    manager.setApprovalHandler(async () => { prompts++; return 'always'; });
    const tool = { ...createMoveTool(), source: 'built-in' };
    const plugin = { agentManager: { getAgent: () => ({ name: 'A' }) }, approvalManager: manager,
        permissionSystem: { checkPermission: () => ({ allowed: true }), requiresApproval: () => true } };
    const client = new MCPClient(app as unknown as MCPClientApp, plugin as unknown as MCPClientPlugin,
        { getTool: () => tool } as unknown as MCPToolRegistryLike);
    const call = (to: string, mode: string) => client.executeToolCall({ name: 'move', arguments: { from: 'in/a.png', to, mode } }, 'A');
    await call('out/a.png', 'copy');
    await call('out/b.png', 'copy');
    await call('out/c.png', 'move');
    t.is(prompts, 3);
    t.true(manager.isAlwaysApproved('A', 'vault.move', '["copy","in/a.png","out/a.png"]'));
    t.false(manager.isAlwaysApproved('A', 'vault.move', '["copy","in/other.png","out/a.png"]'));
});
