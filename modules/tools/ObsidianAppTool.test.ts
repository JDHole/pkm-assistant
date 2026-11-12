import test from 'ava';
import { createObsidianAppTool } from './ObsidianAppTool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { MCPClient } from './MCPClient.js';
import { toolResultStatus } from '../../core/utils/toolResultStatus.js';
import { PermissionSystem } from '../../core/security/PermissionSystem.js';
import { AccessGuard } from '../../core/security/AccessGuard.js';
import { classifyToolRisk } from '../../core/security/autonomy.js';
import { defaultDisabledTools } from '../agents/toolAxis.js';
import { createAppExecutor, createWorkspacePort, discloseLeaf, isObsidianAppEnabled } from '../obsidian-app/index.js';
import { resolveBuiltinManifests } from './built-in-servers/index.js';

function chain(customPort?: Parameters<typeof createObsidianAppTool>[0], restricted = false) {
    let active = 'Notes/B.md';
    const calls: string[] = [];
    const port = {
        listLeaves: () => [
            { title: 'A', viewType: 'markdown', identity: { kind: 'file' as const, path: 'Notes/A.md' }, active: active === 'Notes/A.md' },
            { title: 'Secret', viewType: 'markdown', identity: { kind: 'file' as const, path: 'Secret/S.md' }, active: active === 'Secret/S.md' },
            { title: 'Graph view', viewType: 'graph', identity: { kind: 'none' as const }, active: false },
        ],
        getActivePath: () => active,
        fileExists: (path: string) => ['Notes/A.md', 'Notes/B.md', 'Secret/S.md'].includes(path),
        openPath: async (path: string) => { calls.push(`start:${path}`); await Promise.resolve(); active = path; calls.push(`end:${path}`); },
    };
    const registry = new ToolRegistry(); registry.registerTool(createObsidianAppTool(customPort ?? port));
    const agent = { name: 'Tola', disabled_tools: [], focusFolders: ['Notes'], permissions: { guidance_mode: !restricted, read_notes: true } };
    const plugin = { agentManager: { getAgent: () => agent, getActiveAgent: () => agent }, permissionSystem: new PermissionSystem(null, {}), approvalManager: { requestApproval: async () => ({ result: 'approve' }) } };
    const client = new MCPClient({ vault: {} } as never, plugin as never, registry);
    const call = (args: Record<string, unknown>, opts: Parameters<typeof client.executeToolCall>[2] = {}) => client.executeToolCall({ name: 'obsidian_app', arguments: args }, 'Tola', opts);
    return { call, calls, active: () => active, setActive: (path: string) => { active = path; } };
}

test.serial('open, missing, No-Go and trusted sub marker through MCP', async t => {
    const previous = AccessGuard._noGoFolders; AccessGuard._noGoFolders = ['secret'];
    try {
        const c = chain();
        t.deepEqual(await c.call({ action: 'open', path: 'Notes/A.md' }), { ok: true, success: true, verified: true, effect: 'changed', data: { path: 'Notes/A.md' } });
        t.is(c.active(), 'Notes/A.md');
        t.deepEqual(await c.call({ action: 'open', path: 'Notes/X.md' }), { ok: false, success: false, error: { code: 'not_found', message: 'not_found' }, isError: true });
        const denied = await c.call({ action: 'open', path: 'Secret/S.md' });
        t.is(toolResultStatus(denied), 'error'); t.is(c.active(), 'Notes/A.md');
        t.deepEqual(await c.call({ action: 'open', path: 'Notes/B.md' }, { callerToolNames: ['obsidian_app'] }), { ok: false, success: false, error: { code: 'sub_agent_denied', message: 'sub_agent_denied' }, isError: true });
        t.deepEqual(c.calls, ['start:Notes/A.md', 'end:Notes/A.md']);
    } finally { AccessGuard._noGoFolders = previous; }
});

test.serial('state masks restricted leaves and active path through MCP', async t => {
    const previous = AccessGuard._noGoFolders; AccessGuard._noGoFolders = ['secret'];
    try {
        const c = chain(); await c.call({ action: 'open', path: 'Notes/A.md' });
        t.deepEqual(await c.call({ action: 'state' }), { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: 'Notes/A.md', active_file: 'Notes/A.md', tabs: [
            { title: 'A', view_type: 'markdown', path: 'Notes/A.md', active: true }, { restricted: true, active: false }, { title: 'Graph view', view_type: 'graph', path: null, active: false },
        ] } });
        c.setActive('Secret/S.md');
        const hidden = await c.call({ action: 'state' });
        t.deepEqual(hidden, { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, active_file: null, tabs: [
            { title: 'A', view_type: 'markdown', path: 'Notes/A.md', active: false }, { restricted: true, active: true }, { title: 'Graph view', view_type: 'graph', path: null, active: false },
        ] } });
        t.false(JSON.stringify(hidden).includes('Secret'));
    } finally { AccessGuard._noGoFolders = previous; }
});

test('switch, risk and fresh agent defaults', t => {
    t.false(isObsidianAppEnabled({})); t.true(isObsidianAppEnabled({ pkmAssistant: { obsidianAppEnabled: true } }));
    t.false(resolveBuiltinManifests({ obsidianAppEnabled: false }).some(m => m.name === 'app'));
    t.true(resolveBuiltinManifests({ obsidianAppEnabled: true }).some(m => m.name === 'app'));
    t.true(defaultDisabledTools().includes('obsidian_app'));
    t.is(classifyToolRisk({ toolName: 'obsidian_app', action: 'app.state' }), 'green');
    t.is(classifyToolRisk({ toolName: 'obsidian_app', action: 'app.open' }), 'green');
});

test('parallel opens are serialized', async t => {
    const c = chain(); await Promise.all([c.call({ action: 'open', path: 'Notes/A.md' }), c.call({ action: 'open', path: 'Notes/B.md' })]);
    t.deepEqual(c.calls, ['start:Notes/A.md', 'end:Notes/A.md', 'start:Notes/B.md', 'end:Notes/B.md']);
});

test('abort before open leaves workspace unchanged', async t => {
    const c = chain(); const controller = new AbortController(); controller.abort();
    const result = await c.call({ action: 'open', path: 'Notes/A.md' }, { abortSignal: controller.signal });
    t.deepEqual(result, { success: false, error: 'Stopped' });
    t.is(c.active(), 'Notes/B.md'); t.deepEqual(c.calls, []);
});


test('queued open observes abort immediately before its effect', async t => {
    let active = 'Notes/B.md'; const calls: string[] = [];
    let release = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const execute = createAppExecutor({
        listLeaves: () => [], getActivePath: () => active, fileExists: () => true,
        openPath: async path => { calls.push(path); await blocked; active = path; },
    });
    const first = execute({ action: 'open', path: 'Notes/A.md' });
    const controller = new AbortController();
    const second = execute({ action: 'open', path: 'Notes/C.md' }, { abortSignal: controller.signal });
    await Promise.resolve(); controller.abort(); release();
    t.deepEqual(await first, { ok: true, success: true, verified: true, effect: 'changed', data: { path: 'Notes/A.md' } });
    t.deepEqual(await second, { ok: false, success: false, error: { code: 'aborted', message: 'aborted' } });
    t.deepEqual(calls, ['Notes/A.md']); t.is(active, 'Notes/A.md');
});


test.serial('workspace adapter masks deferred, side, invalid and noncanonical file identities through MCP', async t => {
    const previous = AccessGuard._noGoFolders; AccessGuard._noGoFolders = ['secret', 'secret%20data'];
    try {
        const leaf = (type: string, title: string, state: unknown) => ({
            view: { getDisplayText: () => title, getViewType: () => type },
            getViewState: () => ({ type, state }),
        });
        const leaves = [leaf('markdown', 'Wynagrodzenia 2026', { file: 'Secret/Wynagrodzenia 2026.md' }),
            { ...leaf('markdown', 'Wynagrodzenia 2026', undefined), isDeferred: true },
            leaf('backlink', 'Secret backlink', { file: 'Secret/S.md' }),
            leaf('graph', 'Graph view', {}), leaf('markdown', 'Invalid', { file: 42 }),
            leaf('markdown', 'Salary', { file: 'Secret%20Data/Salary.md' }),
            leaf('markdown', 'RootSecret', { file: 'Notes%2FRootSecret.md' }),
            { view: { getDisplayText: () => { throw new Error('bad view'); }, getViewType: () => 'markdown' }, getViewState: () => ({ state: {} }) }];
        const app = { workspace: { getMostRecentLeaf: () => leaves[3], getActiveFile: () => null, iterateAllLeaves: (fn: (value: unknown) => void) => leaves.forEach(fn) }, vault: {} };
        const port = createWorkspacePort(app as never, (_value): _value is never => false);
        const result = await chain(port).call({ action: 'state' });
        t.deepEqual(result, { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, active_file: null, tabs: [
            { restricted: true, active: false }, { restricted: true, active: false }, { restricted: true, active: false },
            { title: 'Graph view', view_type: 'graph', path: null, active: true },
            { restricted: true, active: false }, { restricted: true, active: false },
            { restricted: true, active: false }, { restricted: true, active: false },
        ] } });
        t.false(JSON.stringify(result).includes('Wynagrodzenia'));
        t.false(JSON.stringify(result).includes('Salary'));
        t.false(JSON.stringify(result).includes('RootSecret'));
        const scoped = await chain(port, true).call({ action: 'state' });
        t.deepEqual(scoped, result);
    } finally { AccessGuard._noGoFolders = previous; }
});

test('timeout releases queue and waiting calls reject sub and Stop immediately', async t => {
    let release = () => {}; const pending = new Promise<void>(resolve => { release = resolve; });
    const execute = createAppExecutor({ listLeaves: () => [], getActivePath: () => null, fileExists: () => true, openPath: () => pending }, 40);
    const first = execute({ action: 'open', path: 'Notes/A.md' });
    const controller = new AbortController();
    const waiting = execute({ action: 'state' }, { abortSignal: controller.signal });
    controller.abort();
    t.deepEqual(await waiting, { ok: false, success: false, error: { code: 'aborted', message: 'aborted' } });
    t.deepEqual(await execute({ action: 'state', _invocationToolNames: [] }), { ok: false, success: false, error: { code: 'sub_agent_denied', message: 'sub_agent_denied' } });
    t.deepEqual(await first, { ok: false, success: false, error: { code: 'timeout', message: 'timeout' } });
    t.deepEqual(await execute({ action: 'state' }), { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, active_file: null, tabs: [] } });
    release();
});

test('Stop during open reports Stop through MCP while the effect completes', async t => {
    let active = 'Notes/B.md'; let release = () => {}; let started = () => {};
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const port = { listLeaves: () => [], getActivePath: () => active, fileExists: () => true,
        openPath: async (path: string) => { started(); await pending; active = path; } };
    const c = chain(port); const controller = new AbortController();
    const call = c.call({ action: 'open', path: 'Notes/A.md' }, { abortSignal: controller.signal });
    await entered; controller.abort(); release();
    t.deepEqual(await call, { success: false, error: 'Stopped' });
    t.is(active, 'Notes/A.md');
});

test('MCP denies sub and stopped calls while an open is pending', async t => {
    let release = () => {}; let started = () => {};
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const port = { listLeaves: () => [], getActivePath: () => 'Notes/A.md', fileExists: () => true,
        openPath: async () => { started(); await pending; } };
    const c = chain(port);
    const first = c.call({ action: 'open', path: 'Notes/A.md' });
    await entered;
    t.deepEqual(await c.call({ action: 'state' }, { callerToolNames: ['obsidian_app'] }), { ok: false, success: false, error: { code: 'sub_agent_denied', message: 'sub_agent_denied' }, isError: true });
    const controller = new AbortController();
    const waiting = c.call({ action: 'state' }, { abortSignal: controller.signal });
    controller.abort();
    t.deepEqual(await waiting, { success: false, error: 'Stopped' });
    release();
    t.deepEqual(await first, { ok: true, success: true, verified: true, effect: 'unchanged', data: { path: 'Notes/A.md' } });
});


test('discloseLeaf requires evidence for file and fileless views', t => {
    const auth = (path: string) => ({ allowed: !path.startsWith('Secret') });
    const cases = [
        [{ active: false, identity: { kind: 'none' }, viewType: 'markdown', title: 'Wynagrodzenia 2026' }, { restricted: true, active: false }],
        [{ active: false, identity: { kind: 'none' }, viewType: 'mystery', title: 'Sekret' }, { restricted: true, active: false }],
        [{ active: false, identity: { kind: 'none' }, viewType: 'graph', title: 'Graph' }, { title: 'Graph', view_type: 'graph', path: null, active: false }],
        [{ active: false, identity: { kind: 'file', path: 'Secret/S.md' }, viewType: 'graph', title: 'Secret' }, { restricted: true, active: false }],
        [{ active: false, identity: { kind: 'file', path: 'Notes/A.md' }, viewType: 'markdown', title: 'Coś innego' }, { title: 'A', view_type: 'markdown', path: 'Notes/A.md', active: false }],
        [{ active: false, identity: { kind: 'file', path: 'Secret%20Data/Salary.md' }, viewType: 'markdown', title: 'Salary' }, { restricted: true, active: false }],
    ] as const;
    for (const [leaf, expected] of cases) t.deepEqual(discloseLeaf(leaf, auth), expected);
});

test.serial('active_file retains authorized note while chat has focus', async t => {
    const previous = AccessGuard._noGoFolders; AccessGuard._noGoFolders = ['secret'];
    try {
        let activeFile = 'Notes/A.md';
        const port = { listLeaves: () => [{ active: true, identity: { kind: 'none' as const }, viewType: 'pkm-assistant-chat', title: 'Chat' }],
            getActivePath: () => activeFile, fileExists: () => false, openPath: async () => {} };
        const c = chain(port);
        t.deepEqual(await c.call({ action: 'state' }), { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, active_file: 'Notes/A.md', tabs: [{ title: 'Chat', view_type: 'pkm-assistant-chat', path: null, active: true }] } });
        activeFile = 'Secret/S.md';
        t.deepEqual(await c.call({ action: 'state' }), { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, active_file: null, tabs: [{ title: 'Chat', view_type: 'pkm-assistant-chat', path: null, active: true }] } });
    } finally { AccessGuard._noGoFolders = previous; }
});

test('timed out open blocks later opens until its effect settles', async t => {
    let release = () => {}; let active: string | null = null;
    const pending = new Promise<void>(resolve => { release = resolve; }); const calls: string[] = [];
    const execute = createAppExecutor({ listLeaves: () => [], getActivePath: () => active, fileExists: () => true,
        openPath: async path => { calls.push(`start:${path}`); if (path === 'A') await pending; active = path; calls.push(`end:${path}`); } }, 40);
    t.deepEqual(await execute({ action: 'open', path: 'A' }), { ok: false, success: false, error: { code: 'timeout', message: 'timeout' } });
    t.deepEqual(await execute({ action: 'open', path: 'C' }), { ok: false, success: false, error: { code: 'busy', message: 'busy' } });
    t.deepEqual(await execute({ action: 'state' }), { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, active_file: null, tabs: [] } });
    release(); await pending; await new Promise(resolve => window.setTimeout(resolve, 0));
    t.deepEqual(await execute({ action: 'open', path: 'C' }), { ok: true, success: true, verified: true, effect: 'changed', data: { path: 'C' } });
    t.deepEqual(calls, ['start:A', 'end:A', 'start:C', 'end:C']); t.deepEqual({ active }, { active: 'C' });
});
