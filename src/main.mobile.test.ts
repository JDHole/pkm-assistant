import test from 'ava';
import { register } from 'node:module';
import * as fs from 'node:fs';
import { mock } from 'node:test';
import Obsidian, { Platform, Notice } from 'obsidian';
import { ToolRegistry } from '../modules/tools/index.js';
import { SubTaskRegistry } from '../modules/sub-agents/index.js';
import { log } from '../core/utils/Logger.js';
import { setLocale } from '../core/i18n/index.js';

// Replace only browser assets; execute the actual composition root against host ports.
register('data:text/javascript,' + encodeURIComponent(`
import { readFile } from 'node:fs/promises';
export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    if (url.endsWith('.md')) return { format: 'module', source: 'export default ' + JSON.stringify(await readFile(new URL(url), 'utf8')), shortCircuit: true };
    return next(url, context);
}`));
const notices: unknown[] = [];
Obsidian.Notice = class extends Notice {
    constructor(message: string | DocumentFragment, timeout?: number) { super(message, timeout); notices.push(message); }
};
const { default: Plugin } = await import('./main.js');
test.after(() => { Obsidian.Notice = Notice; });
test.beforeEach(() => { notices.length = 0; setLocale('en'); });
test.afterEach.always(() => { Platform.isMobile = false; mock.restoreAll(); });

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
function workspaceFixture(existing: boolean, noRight = false) {
    const ready = deferred(), events: string[] = [];
    let state = existing ? 'pkm-assistant-chat' : 'empty';
    let visible = 'backlinks';
    const leaf = { view: {}, async setViewState(next: { type: string; active: boolean }) {
        events.push('loading'); await ready.promise; state = next.type; events.push('ready');
    } };
    const workspace = {
        getLeavesOfType: () => existing || state !== 'empty' ? [leaf] : [],
        getRightLeaf: () => noRight ? null : leaf,
        getLeaf: (mode: string) => { events.push(mode); return leaf; },
        revealLeaf: async (target: typeof leaf) => { tSameLeaf(target); visible = state; events.push('revealed'); },
        rightSplit: { collapsed: true, toggle() { this.collapsed = !this.collapsed; } },
    };
    function tSameLeaf(target: typeof leaf) { if (target !== leaf) throw new Error('Wrong leaf'); }
    const host = { app: { workspace }, openChatView: Plugin.prototype.openChatView };
    return { host, leaf, ready, events, workspace, state: () => state, visible: () => visible };
}

for (const mobile of [true, false]) for (const mode of ['new', 'existing', 'no-right'] as const) {
    test.serial(`openChatView: ${mobile ? 'mobile' : 'desktop'}, ${mode}`, async t => {
        Platform.isMobile = mobile;
        const f = workspaceFixture(mode === 'existing', mode === 'no-right');
        const opening = f.host.openChatView.call(f.host as never);
        if (mode !== 'existing') {
            t.is(f.visible(), 'backlinks', 'must wait for setViewState');
            f.ready.resolve();
        }
        await opening;
        t.is(f.visible(), 'pkm-assistant-chat');
        t.false(f.workspace.rightSplit.collapsed);
        t.deepEqual(f.events, mode === 'existing' ? ['revealed'] : mode === 'no-right' ? ['tab', 'loading', 'ready', 'revealed'] : ['loading', 'ready', 'revealed']);
        t.deepEqual(notices, []);
    });
}

test.serial('inline comment waits for first chat view and preserves formatted message', async t => {
    const f = workspaceFixture(false);
    const sent: unknown[] = [];
    const input = { value: '' };
    f.leaf.view = { input_area: input, send_message(options: unknown) { sent.push([input.value, options]); } };
    const timers: Array<() => void> = [];
    mock.method(window, 'setTimeout', (callback: () => void) => { timers.push(callback); return 1; });
    const host = { ...f.host, registerInterval() {} };
    const sending = Plugin.prototype.sendInlineComment.call(host as never, 'Notes/A.md', 'Fragment', 'Popraw');
    t.is(timers.length, 0);
    f.ready.resolve(); await sending;
    t.is(f.visible(), 'pkm-assistant-chat');
    timers[0]();
    t.deepEqual(sent, [[
        'INLINE COMMENT\nFile: `Notes/A.md`\nFragment:\n```\nFragment\n```\nWhat to change: Popraw',
        { meta: { origin: 'machine' } },
    ]]);
});

test.serial('openChatView reports failed host operation without rejecting command callback', async t => {
    mock.method(log, 'error', () => {});
    const host = { app: { workspace: { getLeavesOfType() { throw new Error('Host failed'); } } } };
    await Plugin.prototype.openChatView.call(host as never);
    t.deepEqual(notices, ['Could not open chat. Please try again.']);
});

test.serial('unloading during first chat opening does not reveal a disposed view or schedule an inline send', async t => {
    const f = workspaceFixture(false);
    const env = { state: 'loaded' };
    const timers: unknown[] = [];
    mock.method(window, 'setTimeout', (callback: unknown) => { timers.push(callback); return 1; });
    const host = { ...f.host, env, registerInterval() {} };
    const sending = Plugin.prototype.sendInlineComment.call(host as never, 'Notes/A.md', 'Fragment', 'Popraw');
    env.state = 'disposed';
    f.ready.resolve(); await sending;
    t.is(f.state(), 'pkm-assistant-chat', 'the pending host operation actually completed');
    t.is(f.visible(), 'backlinks');
    t.deepEqual(timers, []);
});

test.serial('mobile draft startup registers delegation quietly without reading desktop capabilities', async t => {
    Platform.isMobile = true;
    const errors: unknown[] = [];
    mock.method(log, 'error', (...args: unknown[]) => { errors.push(args); });
    let desktopReads = 0;
    const host = { app: { get vault() { desktopReads++; throw new Error('Desktop port reached'); } }, toolRegistry: new ToolRegistry() };
    await Plugin.prototype.initializeVaultDraftRuntime.call(host as never, host.toolRegistry);
    t.deepEqual(host.toolRegistry.getAllTools().map(tool => tool.name), ['delegate', 'sub_agent']);
    t.deepEqual([desktopReads, notices, errors], [0, [], []]);
});

test.serial('desktop draft startup restores real storage and registers review alongside delegation', async t => {
    const root = fs.mkdtempSync(new URL('../.mobile-test-', import.meta.url).pathname);
    const oldRequire = Object.getOwnPropertyDescriptor(window, 'require');
    Object.defineProperty(window, 'require', { configurable: true, value: () => fs });
    const registry = new SubTaskRegistry();
    const host = { app: { vault: { adapter: { getBasePath: () => root } } }, subTaskRegistry: registry, toolRegistry: new ToolRegistry(),
        vaultDraftRuntime: undefined as { flush(): Promise<void>; dispose(): void } | undefined };
    t.teardown(async () => {
        await host.vaultDraftRuntime?.flush(); host.vaultDraftRuntime?.dispose(); registry.dispose();
        if (oldRequire) Object.defineProperty(window, 'require', oldRequire); else Reflect.deleteProperty(window, 'require');
        fs.rmSync(root, { recursive: true, force: true });
    });
    await Plugin.prototype.initializeVaultDraftRuntime.call(host as never, host.toolRegistry);
    t.deepEqual(host.toolRegistry.getAllTools().map(tool => tool.name), ['subagent_changes', 'delegate', 'sub_agent']);
    t.deepEqual(notices, []);
});

test.serial('mobile Obsidian App registers state/open with no Electron and reports disabled screenshot', async t => {
    Platform.isMobile = true;
    const oldRequire = Object.getOwnPropertyDescriptor(window, 'require');
    let nodeReads = 0;
    Object.defineProperty(window, 'require', { configurable: true, get() { nodeReads++; throw new Error('No Node'); } });
    t.teardown(() => { if (oldRequire) Object.defineProperty(window, 'require', oldRequire); else Reflect.deleteProperty(window, 'require'); });
    const host = { settings: { pkmAssistant: { obsidianAppEnabled: true } }, toolRegistry: new ToolRegistry(),
        app: { workspace: { iterateAllLeaves() {}, getActiveFile: () => null } } };
    t.true(Plugin.prototype.registerObsidianAppTool.call(host as never, host.toolRegistry));
    const tool = host.toolRegistry.getTool('obsidian_app')!;
    t.deepEqual(await tool.execute({ action: 'state' }, host.app as never, {} as never), {
        ok: true, success: true, verified: true, effect: 'unchanged', data: { active_path: null, active_file: null, tabs: [] },
    });
    const result = await tool.execute({ action: 'screenshot' }, host.app as never, {} as never);
    t.deepEqual(result, { ok: false, success: false, error: { code: 'screenshot_disabled', message: 'Screenshots are not available on mobile. Use workspace state or open a note instead.' } });
    t.is(nodeReads, 0);
});

for (const { mobile, missingAbort } of [{ mobile: false, missingAbort: false }, { mobile: true, missingAbort: false }, { mobile: true, missingAbort: true }]) test.serial(`device diagnostics composition: ${mobile ? 'mobile' : 'desktop'}, missing AbortController=${missingAbort}`, async t => {
    Platform.isMobile = mobile;
    const { DiagnosticsConsentModal } = await import('../modules/diagnostics/index.js');
    // The host modal stub does not run lifecycle hooks. Simulate closing the real consent UI.
    mock.method(DiagnosticsConsentModal.prototype, 'open', function(this: InstanceType<typeof DiagnosticsConsentModal>) { this.onOpen(); this.onClose(); });
    let reportSummary = '';
    mock.method(Obsidian.Modal.prototype, 'open', function(this: Obsidian.Modal) {
        reportSummary = this.contentEl.children[0]?.textContent ?? '';
    });
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const adapter = {
        exists: async (path: string) => dirs.has(path) || files.has(path),
        mkdir: async (path: string) => { dirs.add(path); },
        write: async (path: string, text: string) => { files.set(path, text); },
        read: async (path: string) => files.get(path) ?? '',
        append: async (path: string, text: string) => { files.set(path, (files.get(path) ?? '') + text); },
        stat: async (path: string) => ({ type: 'file', size: files.get(path)?.length ?? 0 }),
        rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
        list: async (path: string) => ({ files: [...files.keys()].filter(p => p.startsWith(path + '/')), folders: [] }),
        remove: async (path: string) => { files.delete(path); },
        rmdir: async (path: string) => { for (const dir of dirs) if (dir.startsWith(path)) dirs.delete(dir); },
    };
    const { buildRuntimeConfig } = await import('../config/runtimeConfig.js');
    const runtimeConfig = buildRuntimeConfig({ app: { vault: { adapter } } as never });
    let requests = 0;
    runtimeConfig.chat.transport = { open: async () => { requests++; throw new Error('Unexpected request'); } };
    runtimeConfig.chat.http = { send: async () => { requests++; throw new Error('Unexpected request'); } };
    const settings = { pkmAssistant: {
        chat: { apiKeys: { openai: 'composition-secret-123456' } },
        modelLibrary: { main: [{ platform: 'openai', model: 'test-model', isDefault: true }] }, useDeviceModels: true,
    } };
    const host = {
        app: { vault: { adapter, configDir: '.custom-config', getMarkdownFiles: () => [{}, {}, {}] } },
        manifest: { version: '2.4.1' }, runtimeConfig,
        env: { settings, config: runtimeConfig },
        _ready: true, diagnosticStartupMs: 1234, diagnosticController: null,
        agentManager: { agents: new Map([['one', {}], ['two', {}]]) },
        toolRegistry: { getAllTools: () => [{}, {}, {}, {}] },
        externalMcpManager: { listServersForUi: () => [{ transport: 'stdio' }, { transport: 'http' }] },
        vaultIndexer: { getStatus: () => ({ status: mobile ? 'disabled_mobile' : 'ready' }) },
        vaultDraftRuntime: mobile ? undefined : {},
    };
    const abortDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AbortController')!;
    try {
        if (missingAbort) Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: undefined });
        await Plugin.prototype.runDeviceDiagnostics.call(host as never);
    } finally { Object.defineProperty(globalThis, 'AbortController', abortDescriptor); }
    const reports = [...files.entries()].filter(([path]) => path.endsWith('.md'));
    t.is(reports.length, 1);
    const [path, content] = reports[0];
    t.true(path.endsWith(mobile ? '-mobile.md' : '-desktop.md'));
    for (const fragment of [
        `| isMobile | OK |`, '| .custom-config |', '| plugin.startupMs | OK |', '| 1234 |',
        '| agents.count | OK |', '| tools.count | OK |', '| mcp.stdio | OK |', '| mcp.http | OK |',
        `| ${mobile ? 'disabled_mobile' : 'ready'} |`, '| openai/test-model |', '| Key set: Yes |',
        '| model.useDeviceModels | OK |', '| model.connection | SKIPPED | 0 | No consent; no request sent |',
    ]) t.true(content.includes(fragment), fragment);
    t.regex(content, mobile ? /\| isMobile \| OK \| \d+ \| true \|/ : /\| isMobile \| OK \| \d+ \| false \|/);
    t.false(content.includes('composition-secret-123456'));
    t.is(requests, 0);
    t.is(host.diagnosticController, null);
    t.regex(reportSummary, missingAbort
        ? /Diagnostics: \d+ OK, 1 errors\. File: \.pkm-assistant\/diagnostics\//
        : /Diagnostics: \d+ OK, 0 errors\. File: \.pkm-assistant\/diagnostics\//);
    if (missingAbort) t.true(content.includes('| AbortController | ERROR | 0 | Unavailable |'));
});
