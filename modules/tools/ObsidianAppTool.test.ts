import test from 'ava';
import { createObsidianAppTool } from './ObsidianAppTool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { MCPClient } from './MCPClient.js';
import { toolResultStatus } from '../../core/utils/toolResultStatus.js';
import { PermissionSystem } from '../../core/security/PermissionSystem.js';
import { AccessGuard } from '../../core/security/AccessGuard.js';
import { classifyToolRisk } from '../../core/security/autonomy.js';
import { defaultDisabledTools } from '../agents/toolAxis.js';
import { createAppExecutor, isObsidianAppEnabled } from '../obsidian-app/index.js';
import { resolveBuiltinManifests } from './built-in-servers/index.js';

function chain() {
    let active = 'Notes/B.md';
    const calls: string[] = [];
    const port = {
        listLeaves: () => [
            { title: 'A', viewType: 'markdown', path: 'Notes/A.md', active: active === 'Notes/A.md' },
            { title: 'Secret', viewType: 'markdown', path: 'Secret/S.md', active: active === 'Secret/S.md' },
            { title: 'Graph view', viewType: 'graph', path: null, active: false },
        ],
        getActivePath: () => active,
        fileExists: (path: string) => ['Notes/A.md', 'Notes/B.md', 'Secret/S.md'].includes(path),
        openPath: async (path: string) => { calls.push(`start:${path}`); await Promise.resolve(); active = path; calls.push(`end:${path}`); },
    };
    const registry = new ToolRegistry(); registry.registerTool(createObsidianAppTool(port));
    const agent = { name: 'Tola', disabled_tools: [], permissions: { guidance_mode: true, read_notes: true } };
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
        t.deepEqual(await c.call({ action: 'state' }), { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: 'Notes/A.md', tabs: [
            { title: 'A', view_type: 'markdown', path: 'Notes/A.md', active: true }, { restricted: true, active: false }, { title: 'Graph view', view_type: 'graph', path: null, active: false },
        ] } });
        c.setActive('Secret/S.md');
        const hidden = await c.call({ action: 'state' });
        t.deepEqual(hidden, { ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, tabs: [
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
