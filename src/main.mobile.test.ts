import test from 'ava';
import { register } from 'node:module';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import Obsidian, { Platform, Notice } from 'obsidian';
import { ToolRegistry, ServerManager, createWriteTool } from '../modules/tools/index.js';
import { SubAgentRunner, SubTaskRegistry } from '../modules/sub-agents/index.js';
import { MemoryAdapter } from '../modules/vault-drafts/test-support/MemoryAdapter.js';
import { log } from '../core/utils/Logger.js';
import { setLocale } from '../core/i18n/index.js';
import { CHAT_PROVIDERS } from '../modules/models/index.js';
import type { ExecutionContext } from 'ava';

// Complete the deferred storage lifecycle where older tests assert the final state.
function draftTask(host: object): import('../modules/tools/index.js').DraftStartupTask | undefined {
    return Reflect.get(host, 'draftStartupTask');
}
async function finishDraftStartup(host: object) {
    draftTask(host)?.start();
    await draftTask(host)?.ready;
}

// Capture the named host Notice used by diagnostics, without changing the harness stub.
const diagnosticNoticeModule = 'data:text/javascript,' + encodeURIComponent(`
import { Notice as HostNotice } from 'obsidian';
export * from 'obsidian';
export const notices = [];
export class Notice extends HostNotice {
    constructor(message, timeout) { super(message, timeout); notices.push(message); }
}
`);
// Supply browser assets and Notice capture; execute the actual composition root against host ports.
register('data:text/javascript,' + encodeURIComponent(`
import { readFile } from 'node:fs/promises';
export async function resolve(specifier, context, next) {
    if (specifier === 'obsidian' && context.parentURL?.endsWith('/modules/diagnostics/ui.ts'))
        return { url: ${JSON.stringify(diagnosticNoticeModule)}, shortCircuit: true };
    if (specifier.startsWith('@plugin/')) return next(new URL(specifier.slice(8), ${JSON.stringify(new URL('../', import.meta.url).href)}).href, context);
    return next(specifier, context);
}
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
const { SkinManager } = await import('../modules/crystal-soul/index.js');
const { AgentManager } = await import('../modules/agents/index.js');
test.after(() => { Obsidian.Notice = Notice; });
test.beforeEach(() => { notices.length = 0; setLocale('en'); });
test.afterEach.always(() => { Platform.isMobile = false; mock.restoreAll(); });

function diagnosticButtons(modal: Obsidian.Modal) {
    type ButtonNode = { tagName: string; children: ButtonNode[]; onclick?: () => void };
    const find = (node: ButtonNode): ButtonNode[] => node.tagName === 'BUTTON'
        ? [node] : node.children.flatMap(find);
    return find(modal.contentEl as unknown as ButtonNode);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

/** Full production registration, including the two optional built-in modules. */
async function bootToolRegistry(t: ExecutionContext, mobile: boolean, setup?: (plugin: InstanceType<typeof Plugin>) => Promise<void>) {
    Platform.isMobile = mobile;
    const supportDir = process.env.PKM_TEST_SUPPORT_DIR;
    if (!supportDir) throw new Error('AVA harness preload is required');
    const supportUrl = pathToFileURL(`${supportDir}/`);
    const { createMockApp } = await import(new URL('../mock/app.ts', supportUrl).href);
    const { shutdownHarnessRuntime } = await import(new URL('obsidian.ts', supportUrl).href);
    const root = fs.mkdtempSync(new URL('../.mobile-test-', import.meta.url).pathname);
    const app: Obsidian.App = createMockApp(root);
    await app.vault.adapter.mkdir('.pkm-assistant');
    await app.vault.adapter.write('.pkm-assistant/settings.json', JSON.stringify({
        pkmAssistant: { obsidianAppEnabled: true, komunikatorEnabled: true },
    }));
    const plugin = new Plugin(app, {
        id: 'pkm-assistant', name: 'PKM Assistant', version: '2.4.1',
        minAppVersion: '1.11.0', author: 'Tester', description: 'Tool schema test',
    });
    const layouts: Array<() => unknown> = [];
    mock.method(app.workspace, 'onLayoutReady', (callback: () => unknown) => { layouts.push(callback); });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'require');
    Object.defineProperty(window, 'require', mobile
        ? { configurable: true, get() { throw new Error('Node reached on mobile'); } }
        : { configurable: true, value: () => fs });
    t.teardown(async () => {
        plugin.onunload();
        await plugin.env?.dispose();
        await plugin.traceLog?.dispose();
        await log.disposeFileSink();
        shutdownHarnessRuntime();
        if (descriptor) Object.defineProperty(window, 'require', descriptor);
        else Reflect.deleteProperty(window, 'require');
        fs.rmSync(root, { recursive: true, force: true });
    });
    await setup?.(plugin);
    await plugin.onload();
    await Promise.all(layouts.map(callback => callback()));
    t.is(plugin._ready, true);
    const registry = plugin.toolRegistry!;
    // Sentinel checks prevent a broken boot or disabled optional modules from passing vacuously.
    for (const name of ['subagent_changes', 'obsidian_app', 'kom_send']) t.is(registry.getTool(name)?.name, name);
    return registry;
}

for (const mobile of [false, true]) {
    test.serial(`F2d provider schema guard: ${mobile ? 'mobile' : 'desktop'} production registry`, async t => {
        const registry = await bootToolRegistry(t, mobile);
        for (const { function: tool } of registry.getToolDefinitions()) {
            const schema = tool.parameters;
            t.is(typeof schema, 'object', tool.name);
            t.not(schema, null, tool.name);
            t.false(Array.isArray(schema), tool.name);
            t.is(schema.type, 'object', tool.name);
            for (const key of ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$ref']) {
                t.false(key in schema, `${tool.name}: top-level ${key}`);
            }
            t.is(typeof schema.properties, 'object', tool.name);
            t.not(schema.properties, null, tool.name);
            t.false(Array.isArray(schema.properties), tool.name);
            if (schema.required !== undefined) {
                t.true(Array.isArray(schema.required), tool.name);
                for (const key of schema.required as unknown[]) {
                    t.is(typeof key, 'string', tool.name);
                    t.true(Object.hasOwn(schema.properties as object, key as string), `${tool.name}: required ${String(key)}`);
                }
            }
        }
    });

    test.serial(`F2d provider boundary: ${mobile ? 'mobile' : 'desktop'} subagent_changes`, async t => {
        const registry = await bootToolRegistry(t, mobile);
        const tool = registry.getToolDefinitions().find(item => item.function.name === 'subagent_changes')!;
        const providers = [CHAT_PROVIDERS.anthropic, ...Object.values(CHAT_PROVIDERS).filter(provider => provider.info.id !== 'anthropic')];
        for (const provider of providers) for (const stream of [false, true]) {
            const request = provider.buildRequest({ messages: [{ role: 'user', content: 'Test' }], tools: [{ ...tool, type: 'function' }] }, {
                modelId: 'test-model', apiKey: 'test-key', maxOutputTokens: 1024, log,
            }, stream);
            const body = JSON.parse(request.body!) as {
                tools: Array<{ name?: string; input_schema?: Record<string, unknown>;
                    function?: { name: string; parameters: Record<string, unknown> };
                    function_declarations?: Array<{ name: string; parameters: Record<string, unknown> }> }>;
            };
            const sent = body.tools[0];
            const declaration = provider.info.id === 'anthropic' ? { name: sent.name, parameters: sent.input_schema }
                : provider.info.id === 'gemini' ? sent.function_declarations![0] : sent.function!;
            t.is(declaration.name, 'subagent_changes', provider.info.id);
            t.is(declaration.parameters!.type, 'object', provider.info.id);
            t.deepEqual(Object.keys(declaration.parameters!.properties as object).sort(),
                ['action', 'change_id', 'cursor', 'draft_id', 'revision', 'scope'], provider.info.id);
            t.deepEqual(declaration.parameters, tool.function.parameters, `${provider.info.id}: all constraints and descriptions survive`);
        }
    });
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

for (const mobile of [false, true]) for (const failure of ['none', 'skin', 'agents', 'mcp', 'ports', ...(mobile ? ['drafts' as const, 'restore' as const] : [])] as const) {
    const skinFails = failure === 'skin';
    const scenario = failure === 'agents' || failure === 'mcp' || failure === 'drafts' || failure === 'ports' || failure === 'restore'
        ? `U13 production startup: ${mobile ? 'mobile' : 'desktop'}, ${failure} failure`
        : `U12 production startup: ${mobile ? 'mobile' : 'desktop'}, skin failure=${skinFails}`;
    test.serial(scenario, async t => {
        Platform.isMobile = mobile;
        // Reuse the host fixture located by the AVA preload, without changing the harness.
        const supportDir = process.env.PKM_TEST_SUPPORT_DIR;
        if (!supportDir) throw new Error('AVA harness preload is required');
        const supportUrl = pathToFileURL(`${supportDir}/`);
        const { createMockApp } = await import(new URL('../mock/app.ts', supportUrl).href);
        const { shutdownHarnessRuntime } = await import(new URL('obsidian.ts', supportUrl).href);
        const root = fs.mkdtempSync(new URL('../.mobile-test-', import.meta.url).pathname);
        const app: Obsidian.App = createMockApp(root);
        const diagnosticProbe = '.pkm-assistant/agents/diagnostic-probe/memory/.state.json';
        const costProbe = '.pkm-assistant/cost_log.jsonl';
        const diagnosticReads: string[] = [];
        if (failure === 'none') {
            for (const dir of ['.pkm-assistant', '.pkm-assistant/agents', '.pkm-assistant/agents/diagnostic-probe', '.pkm-assistant/agents/diagnostic-probe/memory']) {
                await app.vault.adapter.mkdir(dir);
            }
            await app.vault.adapter.write(diagnosticProbe, '<<<<<<< left\n{}\n=======\n{}\n>>>>>>> right\n');
            await app.vault.adapter.write(costProbe, '<<<<<<< left\n{}\n=======\n{}\n>>>>>>> right\n');
            const read = app.vault.adapter.read.bind(app.vault.adapter);
            mock.method(app.vault.adapter, 'read', async (path: string) => {
                if (path === diagnosticProbe || path === costProbe) diagnosticReads.push(path);
                return read(path);
            });
        }
        const draftOperations: Array<[string, string]> = [];
        for (const method of ['stat', 'list', 'readBinary', 'writeBinary', 'rename', 'remove', 'mkdir'] as const) {
            const original = app.vault.adapter[method].bind(app.vault.adapter);
            mock.method(app.vault.adapter, method, (...args: [string, ...unknown[]]) => {
                if (args[0].startsWith('.pkm-assistant/subagent-drafts')) {
                    draftOperations.push([method, args[0]]);
                    if (failure === 'drafts') throw Object.assign(new Error('sekret-probny-F2e'), { code: 'EACCES' });
                    if (failure === 'restore' && method === 'list') throw new Error('sekret-probny-F2e');
                }
                return Reflect.apply(original, app.vault.adapter, args);
            });
        }
        if (failure === 'ports' && mobile) Object.defineProperty(app.vault.adapter, 'writeBinary', { value: undefined });
        if (failure === 'restore') {
            for (const path of ['.pkm-assistant', '.pkm-assistant/subagent-drafts', '.pkm-assistant/subagent-drafts/v1'])
                if (!await app.vault.adapter.exists(path)) await app.vault.adapter.mkdir(path);
            draftOperations.length = 0;
        }
        await app.vault.adapter.write('.gitignore', '# Synthetic vault\n');
        let localReads = 0, localWrites = 0;
        if (failure === 'none') {
            app.loadLocalStorage = key => { localReads++; return key === 'pkm-assistant.device-id' ? '0123456789abcdef' : null; };
            app.saveLocalStorage = () => { localWrites++; };
        }

        const draftErrors: unknown[][] = [];
        const originalError = log.error.bind(log);
        mock.method(log, 'error', (...args: Parameters<typeof log.error>) => {
            if (args[0] === 'VaultDrafts') draftErrors.push(args);
            else originalError(...args);
        });
        const plugin = new Plugin(app, {
            id: 'pkm-assistant', name: 'PKM Assistant', version: '2.4.1',
            minAppVersion: '1.11.0', author: 'Test', description: 'Startup test',
        });
        const layouts: Array<() => unknown> = [];
        mock.method(app.workspace, 'onLayoutReady', (callback: () => unknown) => { layouts.push(callback); });
        let now = 100;
        const clock = mock.method(performance, 'now', () => now);
        const requireDescriptor = Object.getOwnPropertyDescriptor(window, 'require');
        let nodeReads = 0;
        Object.defineProperty(window, 'require', mobile
            ? { configurable: true, get() { nodeReads++; throw new Error('Node reached on mobile'); } }
            : { configurable: true, value: failure === 'ports' ? undefined : () => fs });
        t.teardown(async () => {
            clock.mock.restore();
            plugin.onunload();
            await plugin.env?.dispose();
            await plugin.traceLog?.dispose();
            await log.disposeFileSink();
            shutdownHarnessRuntime();
            if (requireDescriptor) Object.defineProperty(window, 'require', requireDescriptor);
            else Reflect.deleteProperty(window, 'require');
            fs.rmSync(root, { recursive: true, force: true });
        });
        // Time advances in actual work, never in StartupTimer or a test-owned mark().
        const gitignore = plugin.ensureGitignoreEntries.bind(plugin);
        mock.method(plugin, 'ensureGitignoreEntries', async (...args: Parameters<typeof gitignore>) => {
            await gitignore(...args); now += 20;
        });
        const unlock = plugin._unlockSecureStorageAtStartup.bind(plugin);
        mock.method(plugin, '_unlockSecureStorageAtStartup', async () => { await unlock(); now += 30; });
        const skin = SkinManager.initialize.bind(SkinManager);
        mock.method(SkinManager, 'initialize', async (...args: Parameters<typeof skin>) => {
            if (skinFails) { now += 10000; throw new Error('Controlled skin failure'); }
            await skin(...args); now += 40;
        });
        const agents = AgentManager.prototype.initialize;
        mock.method(AgentManager.prototype, 'initialize', async function(this: InstanceType<typeof AgentManager>) {
            if (failure === 'agents') { now += 10000; throw new Error('Controlled agents failure'); }
            await agents.call(this); now += 50;
        });
        const servers = ServerManager.prototype.initialize;
        mock.method(ServerManager.prototype, 'initialize', async function(this: ServerManager) {
            if (failure === 'mcp') { now += 10000; throw new Error('Controlled MCP failure'); }
            await servers.call(this); now += 60;
        });
        const theme = plugin._loadCrystalSoulTheme.bind(plugin);
        mock.method(plugin, '_loadCrystalSoulTheme', async () => { await theme(); now += 34; });
        const { DiagnosticsConsentModal } = await import('../modules/diagnostics/index.js');
        mock.method(DiagnosticsConsentModal.prototype, 'open', function(this: InstanceType<typeof DiagnosticsConsentModal>) {
            this.onOpen();
            // Startup timing tests explicitly choose the local report in the real UI.
            diagnosticButtons(this)[0].onclick!();
            this.onClose();
        });

        await plugin.onload();
        now = 1100;
        await Promise.all(layouts.map(callback => callback()));
        t.true(plugin._ready);
        await draftTask(plugin)?.ready;
        if (failure !== 'mcp') {
            t.deepEqual(draftOperations, failure === 'restore' ? [
                ['stat', '.pkm-assistant/subagent-drafts/v1'],
                ['stat', '.pkm-assistant/subagent-drafts/v1/.staging'],
                ['stat', '.pkm-assistant/subagent-drafts/v1'],
                ['list', '.pkm-assistant/subagent-drafts/v1'],
            ] : mobile && failure !== 'ports' ? [['stat', '.pkm-assistant/subagent-drafts/v1']] : []);
            if (failure === 'drafts' || failure === 'restore' || failure === 'ports') {
                t.is(draftErrors.length, 1);
                t.is(plugin.toolRegistry?.getTool('delegate')?.name, 'delegate');
                t.is(plugin.toolRegistry?.getTool('sub_agent')?.name, 'sub_agent');
                t.is(plugin.toolRegistry?.getTool('subagent_changes'), null);
                const runner = new SubAgentRunner({ app, plugin, toolRegistry: plugin.toolRegistry,
                    drafts: { kind: 'unavailable' }, isMobile: true });
                const answer = await runner.runTask('Read only', { name: 'Tester' }, { name: 'child', tools: ['read'], description: 'Test', role: 'worker', model: 'openai/model',
                        scope: null, prompt: 'Test', enabled: true, max_iterations: 5, min_iterations: 1, max_tool_result_length: 1000 },
                    { stream(_payload: unknown, handlers: { done(value: unknown): void }) {
                        handlers.done({ choices: [{ message: { role: 'assistant', content: 'Conversation remains available' } }] });
                    } } as never);
                t.is(answer.result, 'Conversation remains available');
            } else {
                t.is(plugin.toolRegistry?.getTool('subagent_changes')?.name, 'subagent_changes');
                t.deepEqual(draftErrors, []);
            }
            t.is(nodeReads, 0);
        }
        t.is(await app.vault.adapter.read('.gitignore'), '# Synthetic vault\n' +
            '.pkm-assistant/settings.json\n.pkm-assistant/settings.last-good.json\n' +
            '.pkm-assistant/backups/\n.pkm-assistant/logs/\n' +
            '.pkm-assistant/agents/*/memory/brain.md.bak\n.pkm-assistant/subagent-drafts/\n');
        if (failure === 'none') {
            t.deepEqual([localReads, localWrites], [1, 0]);
            t.is<string | null | undefined, string>(plugin.agentManager?.getActiveMemory()?.deviceId, '0123456789abcdef');
            t.deepEqual(diagnosticReads, [], 'startup must not scan memory conflict traces');
        }

        await plugin.runDeviceDiagnostics();
        const reports = (await app.vault.adapter.list('.pkm-assistant/diagnostics')).files.filter(path => path.endsWith('.md'));
        t.is(reports.length, 1);
        const content = await app.vault.adapter.read(reports[0]);
        const draftRows = content.split('\n').filter(line => line.startsWith('| drafts.'))
            .map(line => line.replace(/\| (OK|ERROR|SKIPPED) \| \d+ \|/, '| $1 | 0 |'));
        const failed = failure === 'drafts' || failure === 'restore' || failure === 'ports';
        t.deepEqual(draftRows, [
            failed ? '| drafts.available | OK | 0 | false |' : '| drafts.available | OK | 0 | true |',
            failure === 'drafts' ? '| drafts.stage | ERROR | 0 | presence |'
                : failure === 'restore' ? '| drafts.stage | ERROR | 0 | restore |'
                : failure === 'ports' ? '| drafts.stage | ERROR | 0 | ports |' : '| drafts.stage | OK | 0 | ready |',
            failed ? '| drafts.error.name | OK | 0 | Error |' : '| drafts.error.name | SKIPPED | 0 | Unavailable |',
            failure === 'drafts' ? '| drafts.error.code | OK | 0 | EACCES |' : '| drafts.error.code | SKIPPED | 0 | Unavailable |',
            failure === 'restore' ? '| drafts.present | OK | 0 | true |'
                : mobile && !failed ? '| drafts.present | OK | 0 | false |' : '| drafts.present | SKIPPED | 0 | Unavailable |',
            failed ? '| drafts.recoveryIssues | SKIPPED | 0 | Unavailable |' : '| drafts.recoveryIssues | OK | 0 | 0 |',
        ]);
        t.false(content.includes('sekret-probny-F2e'));
        if (failure === 'ports' && !mobile) t.true(notices.includes('Draft storage is unavailable. The sub-agent cannot prepare changes; check the recovery log.'));
        if (failure === 'none') {
            t.deepEqual(diagnosticReads, [diagnosticProbe, costProbe], 'one scan after the local report consent');
            t.true(content.includes('| memory.conflict.state | OK | 0 | 1 |'));
            t.true(content.includes('| memory.conflict.costLog | OK | 0 | 1 |'));
            t.true(content.includes('Files with synchronization conflict traces: 2.'));
            t.false(content.includes('diagnostic-probe'));
        }
        t.deepEqual(content.split('\n').filter(line => /^\| (startup\.|plugin.startupMs)/.test(line))
            .map(line => line.replace(/\| OK \| \d+ \|/, '| OK | <collection-ms> |')), [
            {
                none: '| plugin.startupMs | OK | <collection-ms> | 1234 |',
                drafts: '| plugin.startupMs | OK | <collection-ms> | 1234 |',
                ports: '| plugin.startupMs | OK | <collection-ms> | 1234 |',
                restore: '| plugin.startupMs | OK | <collection-ms> | 1234 |',
                skin: '| plugin.startupMs | OK | <collection-ms> | 11194 |',
                agents: '| plugin.startupMs | OK | <collection-ms> | 11184 |',
                mcp: '| plugin.startupMs | OK | <collection-ms> | 11174 |',
            }[failure],
            '| startup.layoutWaitMs | OK | <collection-ms> | 1000 |',
            '| startup.runtimeMs | OK | <collection-ms> | 20 |',
            '| startup.secretsMs | OK | <collection-ms> | 30 |',
            skinFails ? '| startup.skinMs | OK | <collection-ms> | 10000 |' : '| startup.skinMs | OK | <collection-ms> | 40 |',
            failure === 'agents' ? '| startup.agentsMs | OK | <collection-ms> | 10000 |' : '| startup.agentsMs | OK | <collection-ms> | 50 |',
            ...(failure === 'agents' ? [
                '| startup.agents.loadMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.memoryMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.memoryMaxMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.memoryCount | SKIPPED | 0 | Unavailable |',
                '| startup.agents.memoryFailed | SKIPPED | 0 | Unavailable |',
                '| startup.agents.resourcesMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.skillsMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.subAgentsMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.templatesMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.artifactTypesMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.komunikatorMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.vaultMapMs | SKIPPED | 0 | Unavailable |',
                '| startup.agents.playbooksMs | SKIPPED | 0 | Unavailable |',
            ] : [
                '| startup.agents.loadMs | OK | <collection-ms> | 0 |',
                '| startup.agents.memoryMs | OK | <collection-ms> | 0 |',
                '| startup.agents.memoryMaxMs | OK | <collection-ms> | 0 |',
                '| startup.agents.memoryCount | OK | <collection-ms> | 1 |',
                '| startup.agents.memoryFailed | OK | <collection-ms> | 0 |',
                '| startup.agents.resourcesMs | OK | <collection-ms> | 0 |',
                '| startup.agents.skillsMs | OK | <collection-ms> | 0 |',
                '| startup.agents.subAgentsMs | OK | <collection-ms> | 0 |',
                '| startup.agents.templatesMs | OK | <collection-ms> | 0 |',
                '| startup.agents.artifactTypesMs | OK | <collection-ms> | 0 |',
                '| startup.agents.komunikatorMs | OK | <collection-ms> | 0 |',
                '| startup.agents.vaultMapMs | OK | <collection-ms> | 0 |',
                '| startup.agents.playbooksMs | OK | <collection-ms> | 0 |',
            ]),
            failure === 'mcp' ? '| startup.toolsMs | OK | <collection-ms> | 10000 |' : '| startup.toolsMs | OK | <collection-ms> | 60 |',
            '| startup.finishMs | OK | <collection-ms> | 34 |',
        ]);
    });
}

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

for (const failure of ['none', 'stat', 'missing-stat', 'restore', 'list', 'readBinary', 'writeBinary', 'rename', 'remove', 'mkdir'] as const) {
    test.serial(`F2b mobile draft startup: ${failure}`, async t => {
        Platform.isMobile = true;
        const adapter = new MemoryAdapter();
        if (failure === 'stat') adapter.fault = { operation: 'stat', moment: 'before' };
        else if (failure === 'restore') {
            adapter.folders.add('.pkm-assistant/subagent-drafts/v1');
            adapter.fault = { operation: 'list', moment: 'before' };
        } else if (failure !== 'none') Reflect.deleteProperty(adapter, failure === 'missing-stat' ? 'stat' : failure);
        const errors: unknown[][] = [];
        mock.method(log, 'error', (...args: unknown[]) => { errors.push(args); });
        const oldRequire = Object.getOwnPropertyDescriptor(window, 'require');
        let nodeReads = 0;
        Object.defineProperty(window, 'require', { configurable: true, get() { nodeReads++; throw new Error('Node reached'); } });
        Object.defineProperty(adapter, 'getBasePath', { get() { nodeReads++; throw new Error('Desktop adapter reached'); } });
        const registry = new SubTaskRegistry();
        const host = { app: { vault: { adapter } }, subTaskRegistry: registry, toolRegistry: new ToolRegistry(),
            vaultDraftRuntime: undefined as Awaited<ReturnType<typeof import('../modules/tools/index.js').initializeVaultDrafts>> | undefined };
        t.teardown(async () => {
            await host.vaultDraftRuntime?.flush(); host.vaultDraftRuntime?.dispose(); registry.dispose();
            if (oldRequire) Object.defineProperty(window, 'require', oldRequire); else Reflect.deleteProperty(window, 'require');
        });
        await Plugin.prototype.initializeVaultDraftRuntime.call(host as never, host.toolRegistry);
        await finishDraftStartup(host);
        if (failure === 'none') {
            t.deepEqual(host.toolRegistry.getAllTools().map(tool => tool.name), ['subagent_changes', 'delegate', 'sub_agent']);
            t.deepEqual(adapter.calls, [{ operation: 'stat', path: '.pkm-assistant/subagent-drafts/v1' }]);
            t.deepEqual(host.vaultDraftRuntime?.store.list(), []);
            t.deepEqual(errors, []);
        } else {
            t.deepEqual(host.toolRegistry.getAllTools().map(tool => tool.name), ['delegate', 'sub_agent']);
            t.is(errors.length, 1);
            t.deepEqual(errors[0].slice(0, 2), ['VaultDrafts', 'Draft runtime unavailable:']);
            host.toolRegistry.registerTool(createWriteTool());
            const runner = new SubAgentRunner({ app: host.app, plugin: {}, toolRegistry: host.toolRegistry,
                drafts: host.vaultDraftRuntime?.drafts ?? { kind: 'unavailable' }, isMobile: true });
            const result = await runner.runTask('Write', { name: 'Tester' }, { name: 'child', tools: ['write'],
                prompt: 'Test', enabled: true, description: 'Test', role: 'worker', model: 'openai/model',
                scope: null, max_iterations: 5, min_iterations: 1, max_tool_result_length: 1000 }, {} as never, { origin: { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) } });
            t.deepEqual([result.failed, result.result], [true,
                'Sub-agent child error: Sub-agent writes through drafts did not start on this device. Run "Run device diagnostics". You can continue chatting and run read-only tasks.']);
        }
        t.deepEqual([nodeReads, notices, [...adapter.files]], [0, [], []]);
    });
}

/** Real draft startup and diagnostic command, with only the host and consent supplied. */
async function draftDiagnosticFixture(t: ExecutionContext, mobile: boolean) {
    Platform.isMobile = mobile;
    const supportDir = process.env.PKM_TEST_SUPPORT_DIR;
    if (!supportDir) throw new Error('AVA harness preload is required');
    const { createMockApp } = await import(pathToFileURL(`${supportDir}/../mock/app.ts`).href);
    const root = fs.mkdtempSync(new URL('../.mobile-test-', import.meta.url).pathname);
    const app: Obsidian.App = createMockApp(root);
    const descriptor = Object.getOwnPropertyDescriptor(window, 'require');
    Object.defineProperty(window, 'require', mobile
        ? { configurable: true, get() { throw new Error('Node reached on mobile'); } }
        : { configurable: true, value: () => fs });
    const { buildRuntimeConfig } = await import('../config/runtimeConfig.js');
    const { DiagnosticsConsentModal } = await import('../modules/diagnostics/index.js');
    mock.method(DiagnosticsConsentModal.prototype, 'open', function(this: Obsidian.Modal) {
        this.onOpen(); diagnosticButtons(this)[0].onclick!();
    });
    const host = {
        // Same host boundary as the production constructor: App lacks AppLike's index signatures.
        app, manifest: { version: '2.4.1' }, runtimeConfig: buildRuntimeConfig({ app: app as unknown as Parameters<typeof buildRuntimeConfig>[0]['app'] }),
        subTaskRegistry: new SubTaskRegistry(), toolRegistry: new ToolRegistry(),
        vaultDraftRuntime: undefined as Awaited<ReturnType<typeof import('../modules/tools/index.js').initializeVaultDrafts>> | undefined,
    };
    t.teardown(async () => {
        await host.vaultDraftRuntime?.flush(); host.vaultDraftRuntime?.dispose(); host.subTaskRegistry?.dispose();
        if (descriptor) Object.defineProperty(window, 'require', descriptor); else Reflect.deleteProperty(window, 'require');
        fs.rmSync(root, { recursive: true, force: true });
    });
    return {
        host,
        prepare: () => Plugin.prototype.initializeVaultDraftRuntime.call(host as never, host.toolRegistry),
        start: async () => {
            try { await Plugin.prototype.initializeVaultDraftRuntime.call(host as never, host.toolRegistry); }
            finally { await finishDraftStartup(host); }
        },
        report: async () => {
            await Plugin.prototype.runDeviceDiagnostics.call(host as never);
            const paths = (await app.vault.adapter.list('.pkm-assistant/diagnostics')).files.filter(path => path.endsWith('.md'));
            t.is(paths.length, 1);
            return app.vault.adapter.read(paths[0]);
        },
    };
}

test.serial('F2f presence adds exactly one error to report counts and the notification', async t => {
    const f = await draftDiagnosticFixture(t, true);
    const { runDeviceDiagnostics, showDiagnosticReport } = await import('../modules/diagnostics/index.js');
    const { notices: diagnosticNotices } = await import(diagnosticNoticeModule);
    for (const stage of ['ready', 'presence']) {
        const report = await runDeviceDiagnostics({
            adapter: f.host.app.vault.adapter, platform: 'android', settings: {},
            facts: { 'drafts.available': true, 'drafts.stage': stage },
            capabilities: { structuredClone: true, MediaRecorder: false }, consent: async () => false,
            connection: async () => { throw new Error('Unexpected connection'); }, now: () => 10,
        });
        t.deepEqual([report.ok, report.errors], stage === 'ready' ? [18, 0] : [17, 1]);
        showDiagnosticReport(f.host.app, report);
        t.is(diagnosticNotices.at(-1), stage === 'ready'
            ? `Diagnostics: 18 OK, 0 errors. File: ${report.path}`
            : `Diagnostics: 17 OK, 1 errors. File: ${report.path}`);
        t.true((await f.host.app.vault.adapter.read(report.path)).includes(stage === 'ready'
            ? '| drafts.stage | OK | 0 | ready |' : '| drafts.stage | ERROR | 0 | presence |'));
    }
});

for (const mobile of [true, false]) for (const throwing of [true, false]) {
    test.serial(`F2f error getters are deferred until diagnostics: mobile=${mobile}, throwing=${throwing}`, async t => {
        const f = await draftDiagnosticFixture(t, mobile);
        const reads = { name: 0, code: 0 };
        // Non-enumerable getters are untouched by the existing production logger.
        const failure = Object.defineProperties({}, {
            name: { get() { reads.name++; if (throwing) throw new Error('Synthetic getter'); return 'TypeError'; } },
            code: { get() { reads.code++; if (throwing) throw new Error('Synthetic getter'); return 'EACCES'; } },
        });
        if (mobile) {
            const stat = f.host.app.vault.adapter.stat.bind(f.host.app.vault.adapter);
            mock.method(f.host.app.vault.adapter, 'stat', async (path: string) => {
                if (path === '.pkm-assistant/subagent-drafts/v1') throw failure;
                return stat(path);
            });
        } else Object.defineProperty(f.host.app.vault.adapter, 'getBasePath', { value: () => { throw failure; } });
        await f.start();
        t.deepEqual(reads, { name: 0, code: 0 });
        t.deepEqual(f.host.toolRegistry.getAllTools().map(tool => tool.name), ['delegate', 'sub_agent']);
        const saved = await f.report();
        t.deepEqual(reads, { name: 1, code: 1 });
        t.deepEqual(saved.split('\n').filter(line => line.startsWith('| drafts.error.'))
            .map(line => line.replace(/\| OK \| \d+ \|/, '| OK | 0 |')), throwing ? [
                '| drafts.error.name | OK | 0 | unknown |', '| drafts.error.code | OK | 0 | unknown |',
            ] : ['| drafts.error.name | OK | 0 | TypeError |', '| drafts.error.code | OK | 0 | EACCES |']);
        t.regex(saved, mobile ? /\| drafts.stage \| ERROR \| \d+ \| presence \|/ : /\| drafts.stage \| ERROR \| \d+ \| ports \|/);
    });
}

for (const mobile of [true, false]) for (const failingTool of ['subagent_changes', 'delegate', 'sub_agent']) {
    test.serial(`F2f registration rejection propagates and reports register: mobile=${mobile}, tool=${failingTool}`, async t => {
        const f = await draftDiagnosticFixture(t, mobile);
        const failure = { name: 'TypeError', code: 'EACCES' };
        const register = f.host.toolRegistry.registerTool.bind(f.host.toolRegistry);
        mock.method(f.host.toolRegistry, 'registerTool', (tool: Parameters<ToolRegistry['registerTool']>[0]) => {
            if (tool.name === failingTool) throw failure;
            return register(tool);
        });
        await f.start().then(() => t.fail('Registration must reject'), error => t.is(error, failure));
        t.deepEqual(f.host.toolRegistry.getAllTools().map(tool => tool.name), failingTool === 'subagent_changes' ? []
            : failingTool === 'delegate' ? ['subagent_changes'] : ['subagent_changes', 'delegate']);
        const saved = await f.report();
        t.regex(saved, /\| drafts.stage \| ERROR \| \d+ \| register \|/);
        t.regex(saved, /\| drafts.error.name \| OK \| \d+ \| TypeError \|/);
        t.regex(saved, /\| drafts.error.code \| OK \| \d+ \| EACCES \|/);
        t.true(saved.includes('The draft storage result is inconsistent or incomplete; sub-agent write availability cannot be confirmed.'));
    });
}

test.serial('F2f failed second startup reports the last attempt without denying the retained runtime', async t => {
    const f = await draftDiagnosticFixture(t, true);
    await f.start();
    const runtime = f.host.vaultDraftRuntime;
    Object.defineProperty(f.host.app.vault.adapter, 'writeBinary', { value: undefined });
    await f.start();
    t.is(f.host.vaultDraftRuntime, runtime);
    t.deepEqual(f.host.toolRegistry.getAllTools().map(tool => tool.name), ['subagent_changes', 'delegate', 'sub_agent']);
    const saved = await f.report();
    t.regex(saved, /\| drafts.available \| OK \| \d+ \| true \|/);
    t.regex(saved, /\| drafts.stage \| ERROR \| \d+ \| ports \|/);
    t.true(saved.includes('The draft storage result is inconsistent or incomplete; sub-agent write availability cannot be confirmed.'));
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
    await finishDraftStartup(host);
    t.deepEqual(host.toolRegistry.getAllTools().map(tool => tool.name), ['subagent_changes', 'delegate', 'sub_agent']);
    t.deepEqual(notices, []);
});

test.serial('F2b desktop without Node never falls back to the mobile adapter', async t => {
    const adapter = new MemoryAdapter();
    const oldRequire = Object.getOwnPropertyDescriptor(window, 'require');
    Object.defineProperty(window, 'require', { configurable: true, value: undefined });
    const registry = new SubTaskRegistry();
    const errors: unknown[][] = [];
    mock.method(log, 'error', (...args: unknown[]) => { errors.push(args); });
    const host = { app: { vault: { adapter: Object.assign(adapter, { getBasePath: () => '/synthetic-vault' }) } },
        subTaskRegistry: registry, toolRegistry: new ToolRegistry() };
    t.teardown(() => {
        registry.dispose();
        if (oldRequire) Object.defineProperty(window, 'require', oldRequire); else Reflect.deleteProperty(window, 'require');
    });
    await Plugin.prototype.initializeVaultDraftRuntime.call(host as never, host.toolRegistry);
    await finishDraftStartup(host);
    t.deepEqual(host.toolRegistry.getAllTools().map(tool => tool.name), ['delegate', 'sub_agent']);
    t.deepEqual(notices, ['Draft storage is unavailable. The sub-agent cannot prepare changes; check the recovery log.']);
    t.is(errors.length, 1);
    t.deepEqual(adapter.calls, []);
});

test.serial('mobile Obsidian App registers state/open with no Electron and reports disabled screenshot', async t => {
    Platform.isMobile = true;
    const oldRequire = Object.getOwnPropertyDescriptor(window, 'require');
    let nodeReads = 0;
    Object.defineProperty(window, 'require', { configurable: true, get() { nodeReads++; throw new Error('No Node'); } });
    t.teardown(() => { if (oldRequire) Object.defineProperty(window, 'require', oldRequire); else Reflect.deleteProperty(window, 'require'); });
    const host = { register: (_callback: () => void) => {}, settings: { pkmAssistant: { obsidianAppEnabled: true } }, toolRegistry: new ToolRegistry(),
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

for (const { mobile, missingAbort } of [{ mobile: false, missingAbort: false }, { mobile: true, missingAbort: false }, { mobile: true, missingAbort: true }]) for (const choice of ['local', 'connection', 'close', 'unload'] as const) test.serial(`device diagnostics composition: ${mobile ? 'mobile' : 'desktop'}, missing AbortController=${missingAbort}, ${choice}`, async t => {
    Platform.isMobile = mobile;
    const { DiagnosticsConsentModal, StartupTimer } = await import('../modules/diagnostics/index.js');
    let action = choice;
    let dialogs = 0;
    mock.method(DiagnosticsConsentModal.prototype, 'open', function(this: InstanceType<typeof DiagnosticsConsentModal>) {
        this.onOpen();
        dialogs++;
        const choices = diagnosticButtons(this);
        t.deepEqual(choices.map(button => button.tagName), ['BUTTON', 'BUTTON']);
        if (action === 'close' || action === 'unload') {
            if (action === 'unload') host.diagnosticController?.abort();
            this.onClose();
            // A detached button must not revive a cancelled report.
            choices[0].onclick!(); choices[1].onclick!();
        } else {
            choices[action === 'local' ? 0 : 1].onclick!();
            this.onClose();
        }
    });
    let reportSummary = '';
    mock.method(Obsidian.Modal.prototype, 'open', function(this: Obsidian.Modal) {
        reportSummary = this.contentEl.children[0]?.textContent ?? '';
    });
    const costProbe = '.pkm-assistant/cost_log.jsonl';
    const costContent = '<<<<<<< left\n{}\n=======\n{}\n>>>>>>> right\n';
    const files = new Map<string, string>([[costProbe, costContent]]);
    const dirs = new Set<string>();
    let scans = 0;
    const reportWrites: string[] = [];
    const adapter = {
        exists: async (path: string) => dirs.has(path) || files.has(path),
        mkdir: async (path: string) => { dirs.add(path); },
        write: async (path: string, text: string) => { files.set(path, text); if (path.endsWith('.md')) reportWrites.push(path); },
        read: async (path: string) => { if (path === costProbe) scans++; return files.get(path) ?? ''; },
        append: async (path: string, text: string) => { files.set(path, (files.get(path) ?? '') + text); },
        stat: async (path: string) => files.has(path) ? { type: 'file', size: files.get(path)!.length }
            : dirs.has(path) ? { type: 'folder', size: 0 } : null,
        rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
        list: async (path: string) => ({ files: [...files.keys()].filter(p => p.slice(0, p.lastIndexOf('/')) === path),
            folders: [...dirs].filter(p => p.slice(0, p.lastIndexOf('/')) === path) }),
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
    let startupNow = 100;
    const diagnosticStartupPhases = new StartupTimer(() => startupNow);
    startupNow = 1100; diagnosticStartupPhases.mark('layoutWaitMs');
    startupNow = 1120; diagnosticStartupPhases.mark('runtimeMs');
    startupNow = 1150; diagnosticStartupPhases.mark('secretsMs');
    startupNow = 1190; diagnosticStartupPhases.mark('skinMs');
    startupNow = 1240; diagnosticStartupPhases.mark('agentsMs');
    startupNow = 1300; diagnosticStartupPhases.mark('toolsMs');
    startupNow = 1334; diagnosticStartupPhases.mark('finishMs');
    const host = {
        app: { vault: { adapter, configDir: '.custom-config', getMarkdownFiles: () => [{}, {}, {}] } },
        manifest: { version: '2.4.1' }, runtimeConfig,
        env: { settings, config: runtimeConfig },
        _ready: true, diagnosticStartupMs: 1234, diagnosticStartupPhases, diagnosticController: null as { abort(): void } | null,
        agentManager: { agents: new Map([['one', {}], ['two', {}]]), startupTimings: {
            loadMs: 10, memoryMs: 40, memoryMaxMs: 39, memoryCount: 2, memoryFailed: 1,
            resourcesMs: 35, skillsMs: 20, subAgentsMs: 30, templatesMs: 35,
            artifactTypesMs: 25, komunikatorMs: 10, vaultMapMs: 15, playbooksMs: 7,
        } },
        toolRegistry: { getAllTools: () => [{}, {}, {}, {}] },
        externalMcpManager: { listServersForUi: () => [{ transport: 'stdio' }, { transport: 'http' }] },
        vaultIndexer: { getStatus: () => ({ status: mobile ? 'disabled_mobile' : 'ready' }) },
        vaultDraftRuntime: mobile ? undefined : {},
    };
    const abortDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AbortController')!;
    try {
        if (missingAbort) Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: undefined });
        await Plugin.prototype.runDeviceDiagnostics.call(host as never);
        if (choice === 'close' || choice === 'unload') {
            t.is(dialogs, 1);
            t.deepEqual([scans, reportWrites, requests, reportSummary, notices], [0, [], 0, '', []]);
            t.is(host.diagnosticController, null);
            // Cancellation releases the command; a subsequent explicit save succeeds.
            action = 'local';
            await Plugin.prototype.runDeviceDiagnostics.call(host as never);
            t.is(dialogs, 2);
        }
    } finally { Object.defineProperty(globalThis, 'AbortController', abortDescriptor); }
    const reports = [...files.entries()].filter(([path]) => path.endsWith('.md'));
    t.is(reports.length, 1);
    const [path, content] = reports[0];
    t.is(scans, 1, 'each saved report scans memory exactly once');
    t.deepEqual(reportWrites, [path]);
    t.is(files.get(costProbe), costContent, 'the scan is read-only');
    t.regex(content, /\| memory.conflict.costLog \| OK \| \d+ \| 1 \|/);
    t.true(content.includes('Files with synchronization conflict traces: 1.'));
    t.true(path.endsWith(mobile ? '-mobile.md' : '-desktop.md'));
    for (const fragment of [
        `| isMobile | OK |`, '| .custom-config |', '| plugin.startupMs | OK |', '| 1234 |',
        '| agents.count | OK |', '| tools.count | OK |', '| mcp.stdio | OK |', '| mcp.http | OK |',
        `| ${mobile ? 'disabled_mobile' : 'ready'} |`, '| openai/test-model |', '| Key set: Yes |',
        '| model.useDeviceModels | OK |',
        action === 'connection' ? (missingAbort ? '| model.connection | SKIPPED |' : '| model.connection | ERROR |')
            : '| model.connection | SKIPPED | 0 | No consent; no request sent |',
    ]) t.true(content.includes(fragment), fragment);
    // Fact duration is in the last column; the third measures collecting the fact.
    t.deepEqual(content.split('\n').filter(line => /^\| (startup\.|plugin.startupMs)/.test(line))
        .map(line => line.replace(/\| OK \| \d+ \|/, '| OK | <collection-ms> |')), [
        '| plugin.startupMs | OK | <collection-ms> | 1234 |',
        '| startup.layoutWaitMs | OK | <collection-ms> | 1000 |',
        '| startup.runtimeMs | OK | <collection-ms> | 20 |',
        '| startup.secretsMs | OK | <collection-ms> | 30 |',
        '| startup.skinMs | OK | <collection-ms> | 40 |',
        '| startup.agentsMs | OK | <collection-ms> | 50 |',
        '| startup.agents.loadMs | OK | <collection-ms> | 10 |',
        '| startup.agents.memoryMs | OK | <collection-ms> | 40 |',
        '| startup.agents.memoryMaxMs | OK | <collection-ms> | 39 |',
        '| startup.agents.memoryCount | OK | <collection-ms> | 2 |',
        '| startup.agents.memoryFailed | OK | <collection-ms> | 1 |',
        '| startup.agents.resourcesMs | OK | <collection-ms> | 35 |',
        '| startup.agents.skillsMs | OK | <collection-ms> | 20 |',
        '| startup.agents.subAgentsMs | OK | <collection-ms> | 30 |',
        '| startup.agents.templatesMs | OK | <collection-ms> | 35 |',
        '| startup.agents.artifactTypesMs | OK | <collection-ms> | 25 |',
        '| startup.agents.komunikatorMs | OK | <collection-ms> | 10 |',
        '| startup.agents.vaultMapMs | OK | <collection-ms> | 15 |',
        '| startup.agents.playbooksMs | OK | <collection-ms> | 7 |',
        '| startup.toolsMs | OK | <collection-ms> | 60 |',
        '| startup.finishMs | OK | <collection-ms> | 34 |',
    ]);
    t.regex(content, mobile ? /\| isMobile \| OK \| \d+ \| true \|/ : /\| isMobile \| OK \| \d+ \| false \|/);
    t.false(content.includes('composition-secret-123456'));
    t.is(requests, action === 'connection' && !missingAbort ? 1 : 0);
    t.is(host.diagnosticController, null);
    t.regex(reportSummary, missingAbort || action === 'connection'
        ? /Diagnostics: \d+ OK, 2 errors\. File: \.pkm-assistant\/diagnostics\//
        : /Diagnostics: \d+ OK, 1 errors\. File: \.pkm-assistant\/diagnostics\//);
    if (missingAbort) t.true(content.includes('| AbortController | ERROR | 0 | Unavailable |'));
});

for (const locale of ['en', 'pl']) test.serial(`U1 embedding startup notice: mobile quiet, desktop unchanged (${locale})`, t => {
    setLocale(locale);
    const host = { env: { settings: { pkmAssistant: { embedding: { provider: '' } } } } };
    Platform.isMobile = true;
    Plugin.prototype._checkEmbeddingProviderConfigured.call(host as never);
    t.deepEqual(notices, []);
    Platform.isMobile = false;
    Plugin.prototype._checkEmbeddingProviderConfigured.call(host as never);
    t.deepEqual(notices, [locale === 'pl'
        ? 'Embedding niedostępny.\nWybierz dostawcę w Ustawienia → Modele → Embedding\n(Ollama / OpenAI / Gemini / LM Studio).'
        : 'Embedding is not configured.\nPick a provider in Settings → Models → Embedding\n(Ollama / OpenAI / Gemini / LM Studio).']);
    host.env.settings.pkmAssistant.embedding.provider = 'openai';
    Plugin.prototype._checkEmbeddingProviderConfigured.call(host as never);
    t.is(notices.length, 1);
});

test.serial('D2 composition root: local cryptographic id survives restart; invalid storage is replaced, never written to vault', t => {
    let generated = 0;
    mock.method(crypto, 'getRandomValues', (bytes: Uint8Array) => {
        generated++; bytes.set([0, 1, 2, 3, 250, 251, 252, 253]); return bytes;
    });
    const storage = new Map<string, unknown>();
    const writes: unknown[] = [];
    let reads = 0;
    const app = {
        loadLocalStorage(key: string) { reads++; return storage.get(key); },
        saveLocalStorage(key: string, value: unknown) { storage.set(key, value); writes.push([key, value]); },
        get vault(): never { throw new Error('Device id must never use vault files'); },
    };
    const start = () => Plugin.prototype._loadDeviceId.call({ app } as never);
    t.is<string | null, string>(start(), '00010203fafbfcfd');
    t.is<string | null, string>(start(), '00010203fafbfcfd');
    t.deepEqual([reads, generated], [2, 1]);
    t.deepEqual(writes, [['pkm-assistant.device-id', '00010203fafbfcfd']]);
    for (const invalid of ['ABCDEF0123456789', 'aaaaaaaaaaaaaaaa\n', {}, 17]) {
        storage.set('pkm-assistant.device-id', invalid);
        t.is<string | null, string>(start(), '00010203fafbfcfd');
        t.is(storage.get('pkm-assistant.device-id'), '00010203fafbfcfd');
    }
    t.is(generated, 5);
});

test.serial('D2 composition root: absent or failed host storage falls back to null without throwing', t => {
    for (const app of [
        {}, { loadLocalStorage: () => '0123456789abcdef' }, { saveLocalStorage() {} },
        { loadLocalStorage() { throw new Error('read failed'); }, saveLocalStorage() {} },
        { loadLocalStorage: () => null, saveLocalStorage() { throw new Error('write failed'); } },
    ]) t.is(Plugin.prototype._loadDeviceId.call({ app } as never), null);
});

// F2n: synthetic receipts and proposals through the production composition root.
const { mobileDraftPorts, desktopDraftPorts, MCPClient, createReadTool } = await import('../modules/tools/index.js');
const { AdapterDraftStorage, DesktopDraftStorage, DraftStore, DraftPersistence, DRAFT_ROOT, parseVaultPath } = await import('../modules/vault-drafts/index.js');
const { seedReceipts } = await import('../modules/tools/test-support/draftGCFixture.js');
const { __test__: delegationTest, stopAllDelegations } = await import('../modules/tools/DelegateTool.js');
const { __test__: modelTest } = await import('../modules/models/index.js');
const draftOwner = { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) };
const portsFor = (app: Obsidian.App, mobile: boolean) => mobile ? mobileDraftPorts(app) : desktopDraftPorts(app);

async function seedPending(app: Obsidian.App, mobile: boolean, open = false) {
    const ports = portsFor(app, mobile);
    const store = new DraftStore(new DraftPersistence(ports.storage, ports.hasher), ports.vault, { now: () => Date.now() });
    const draft = await store.create({ draftId: 'previous', runId: 'previous', threadId: 'previous', owner: draftOwner });
    await store.mutate(draft.draftId, { path: parseVaultPath('Previous.md'), source: { tool: 'write', callId: 'sample' }, value: { kind: 'text', text: 'Previous proposal' } });
    if (!open) await store.seal(draft.draftId, 'finished');
}
function holdScan(app: Obsidian.App, mobile: boolean) {
    const entered = deferred(), release = deferred(), returned = deferred();
    if (mobile) {
        const stat = app.vault.adapter.stat.bind(app.vault.adapter);
        mock.method(app.vault.adapter, 'stat', async (path: string) => {
            if (path === `${DRAFT_ROOT}/.staging`) { entered.resolve(); await release.promise; returned.resolve(); }
            return stat(path);
        });
    } else {
        const list = DesktopDraftStorage.prototype.list;
        mock.method(DesktopDraftStorage.prototype, 'list', async function(this: InstanceType<typeof DesktopDraftStorage>, path: string) {
            if (path === DRAFT_ROOT) { entered.resolve(); await release.promise; returned.resolve(); }
            return list.call(this, path);
        });
    }
    return { entered: entered.promise, release: release.resolve, returned: returned.promise };
}
function reviewContext() {
    return { draftReview: { kind: 'main' as const, owner: draftOwner, authorize: () => true, approve: async () => true },
        shouldAbort: () => false, resultBudgetChars: 0, effectiveResultBudgetChars: 12000,
        authorizeFileRead: () => ({ allowed: true }), serializeFinalResult: JSON.stringify };
}
function writerHost(host: Awaited<ReturnType<typeof draftDiagnosticFixture>>['host']) {
    const agent = { name: 'Tester', activeSubAgents: [{ name: 'child' }] };
    const config = { name: 'child', description: 'Test', role: 'worker', model: 'openai/model', tools: ['write'],
        prompt: 'Prepare a proposal', scope: null, max_iterations: 5, min_iterations: 1, max_tool_result_length: 15000, enabled: true };
    const plugin = Object.assign(host, {
        agentManager: { agents: new Map([[agent.name, agent]]), getAgent: () => agent, getActiveAgent: () => agent, resolveSubAgentConfig: () => config,
            getAgentMemory: () => ({ paths: { brainFolder: '.pkm-assistant/agents/tester/brain' }, vault: host.app.vault,
                appendSessionEvent: async () => 'saved' }) },
        permissionSystem: { checkPermission: () => ({ allowed: true }), requiresApproval: () => false },
        approvalManager: { requestApproval: async () => ({ result: 'approve' }) },
        env: { settings: { pkmAssistant: { limits: { subagent_stall_timeout_ms: 0, model_synthesis_timeout_ms: 0 },
            chat: { platform: 'openai', models: { openai: 'model' }, apiKeys: { openai: 'synthetic-key' } } } },
            config: { chat: { providers: { openai: { info: { id: 'openai' } } }, http: { send: async () => ({ status: 200 }) }, transport: { open: async () => ({ status: 200, body: '' }) } } } },
    });
    host.toolRegistry.registerTool(createWriteTool());
    host.toolRegistry.registerTool(createReadTool());
    const client = new MCPClient(host.app, plugin as never, host.toolRegistry);
    Object.assign(plugin, { mcpClient: client });
    return { plugin, client, config };
}

for (const mobile of [false, true]) for (const count of [0, 1, 20]) {
    test.serial(`F2n startup cost ${mobile ? 'mobile' : 'desktop'} ${count}`, async t => {
        const f = await draftDiagnosticFixture(t, mobile);
        if (count) await seedReceipts(portsFor(f.host.app, mobile), count);
        let portCalls = 0, adapterCalls = 0;
        const prototype = mobile ? AdapterDraftStorage.prototype : DesktopDraftStorage.prototype;
        for (const name of ['list', 'read', 'writeBlob', 'publish', 'remove'] as const) {
            const original = prototype[name];
            mock.method(prototype, name, function(this: unknown, ...args: unknown[]) {
                portCalls++; return Reflect.apply(original, this, args);
            });
        }
        for (const name of ['stat', 'list', 'readBinary', 'writeBinary', 'rename', 'remove', 'mkdir', 'rmdir'] as const) {
            const original = f.host.app.vault.adapter[name];
            mock.method(f.host.app.vault.adapter, name, function(this: unknown, ...args: unknown[]) {
                adapterCalls++; return Reflect.apply(original, this, args);
            });
        }
        await f.prepare();
        t.deepEqual([portCalls, adapterCalls], mobile ? [0, 1] : [0, 0]);
        await finishDraftStartup(f.host);
        t.deepEqual([portCalls, adapterCalls], mobile
            ? count === 0 ? [0, 1] : count === 1 ? [5, 12] : [81, 145]
            : count === 0 ? [1, 0] : count === 1 ? [5, 0] : [81, 0]);
        const result = await f.host.toolRegistry.getTool('subagent_changes')!.execute({ action: 'list' }, undefined, undefined, reviewContext());
        t.like(result, { kind: 'listed', changes: Array.from({ length: count }, () => ({ path: 'new.md', status: 'rejected' })) });
        t.is(f.host.vaultDraftRuntime?.store.list().length, count);
    });
}

for (const mobile of [false, true]) for (const action of ['list', 'accept', 'reject'] as const) test.serial(`F2n full plugin ready with held scan: mobile=${mobile}, ${action}`, async t => {
    let plugin!: InstanceType<typeof Plugin>;
    let held!: ReturnType<typeof holdScan>;
    const tools = await bootToolRegistry(t, mobile, async current => {
        plugin = current;
        await seedPending(current.app, mobile);
        held = holdScan(current.app, mobile);
    });
    await held.entered;
    t.is(plugin._ready, true);
    let completed = false;
    const listing = tools.getTool('subagent_changes')!.execute(action === 'list' ? { action } : { action, draft_id: 'previous', change_id: 'change-1', revision: 1 }, undefined, undefined, reviewContext()).then(value => { completed = true; return value; });
    await Promise.resolve();
    t.is(completed, false);
    held.release();
    const result = await listing;
    if (action === 'list') t.like(result, { kind: 'listed', changes: [{ draft_id: 'previous', path: 'Previous.md', status: 'pending' }] });
    else {
        if (action === 'accept') t.like(result, { kind: 'accepted', attemptId: 'change-1-3', applied: { kind: 'file', bytes: 17,
            hash: '4bd42b8f2fafac218f06d9ad4ec43228c19bd91b50a536f04b56eb35df7d0ab8' } });
        else t.deepEqual(result, { kind: 'rejected' });
        t.is(await plugin.app.vault.adapter.exists('Previous.md'), action === 'accept');
        if (action === 'accept') t.is(await plugin.app.vault.adapter.read('Previous.md'), 'Previous proposal');
    }
});

for (const mobile of [false, true]) test.serial(`F2n writer, review, diagnostics wait; live vault and chat projection proceed: mobile=${mobile}`, async t => {
    const f = await draftDiagnosticFixture(t, mobile);
    await f.host.app.vault.create('Live.md', 'Live content');
    await seedPending(f.host.app, mobile);
    const held = holdScan(f.host.app, mobile);
    await f.prepare();
    draftTask(f.host)!.start(); await held.entered;
    const { plugin, client, config } = writerHost(f.host);
    plugin.subTaskRegistry.createThread({ threadId: 'existing', name: 'child', owner: draftOwner, origin: draftOwner,
        config: { subConfig: config, providerId: 'openai', modelId: 'model', options: { autonomy: 'yolo' }, limits: {}, toolNames: ['write'] } });
    plugin.subTaskRegistry.endRun('existing', { successful: true, answer: 'Earlier answer' });
    let modelCalls = 0;
    modelTest.setChatModelFactory(() => { let calls = 0; return { providerId: 'openai', modelId: 'model', stopStream() {},
        stream(_payload: unknown, handlers: { done(value: unknown): void }) {
            modelCalls++; calls++;
            handlers.done({ choices: [{ message: calls % 2 === 1 ? { role: 'assistant', content: '', tool_calls: [
                { id: 'write-test', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'New.md', content: 'New proposal' }) } },
            ] } : { role: 'assistant', content: 'Prepared' } }] });
        },
    } as never; });
    t.teardown(async () => { stopAllDelegations('test'); await delegationTest._settleBackground(true); modelTest.reset(); });
    const finished: string[] = [];
    const writing = client.executeToolCall({ name: 'delegate', arguments: { task: 'Prepare', aspect: 'child', background: false } }, 'Tester',
        { origin: draftOwner, autonomy: 'yolo' }).then(value => { finished.push('write'); return value; });
    const resuming = client.executeToolCall({ name: 'sub_agent', arguments: { action: 'task', sub_id: 'existing', task: 'Continue', background: false } }, 'Tester',
        { origin: draftOwner, autonomy: 'yolo' }).then(value => { finished.push('resume'); return value; });
    const listing = client.executeToolCall({ name: 'subagent_changes', arguments: { action: 'list' } }, 'Tester',
        { origin: draftOwner, autonomy: 'yolo' }).then(value => { finished.push('list'); return value; });
    const report = f.report().then(value => { finished.push('report'); return value; });
    t.like(await client.executeToolCall({ name: 'read', arguments: { path: 'Live.md', scope: 'vault' } }, 'Tester',
        { origin: draftOwner, autonomy: 'yolo' }), { content: 'Live content' });
    // This synchronous projection is used on the live chat render path, not as review authority.
    t.deepEqual(plugin.subTaskRegistry.draftSummaries(draftOwner), []);
    t.deepEqual([finished, modelCalls], [[], 0]);
    held.release();
    t.like(await listing, { kind: 'listed', changes: [{ draft_id: 'previous', path: 'Previous.md', status: 'pending' }] });
    t.like(await writing, { success: true, started: true });
    t.like(await resuming, { success: true, result: 'Prepared' });
    await delegationTest._settleBackground(true);
    t.deepEqual(plugin.subTaskRegistry.list().map(task => [task.status, task.result?.text]), [['done', 'Prepared'], ['done', 'Prepared']]);
    t.is(modelCalls, 4);
    t.is(await f.host.app.vault.adapter.exists('New.md'), false);
    const runtime = f.host.vaultDraftRuntime!;
    const created = runtime.store.list().find(draft => draft.draftId !== 'previous')!;
    t.deepEqual(created.changes.map(change => [change.path, change.review.kind]), [['New.md', 'pending']]);
    t.regex(await report, /\| drafts.stage \| OK \| \d+ \| ready \|/);
    t.deepEqual(plugin.subTaskRegistry.draftSummaries(draftOwner).map(summary => summary.pending), [1, 1, 1]);
    const continued = await client.executeToolCall({ name: 'sub_agent', arguments: { action: 'task', task: 'Revise', background: false,
        sub_id: plugin.subTaskRegistry.listThreads(draftOwner)[0].threadId } }, 'Tester', { origin: draftOwner, autonomy: 'yolo' });
    t.like(continued, { success: true, result: 'Prepared' });
    t.is(modelCalls, 6);
});

for (const mobile of [false, true]) test.serial(`F2n background scan failure preserves refusals and diagnostic error: mobile=${mobile}`, async t => {
    const f = await draftDiagnosticFixture(t, mobile);
    await seedPending(f.host.app, mobile);
    const held = holdScan(f.host.app, mobile);
    const prototype = mobile ? AdapterDraftStorage.prototype : DesktopDraftStorage.prototype;
    const list = prototype.list;
    mock.method(prototype, 'list', async function(this: unknown, path: string) {
        if (path === DRAFT_ROOT) {
            // Desktop's existing hold lives in the port; mobile's lives in staging stat.
            if (!mobile) await Reflect.apply(list, this, [path]);
            throw Object.assign(new TypeError('Synthetic scan failure'), { code: 'EACCES' });
        }
        return Reflect.apply(list, this, [path]);
    });
    const errors: unknown[][] = [];
    mock.method(log, 'error', (...args: unknown[]) => errors.push(args));
    await f.prepare(); draftTask(f.host)!.start(); await held.entered;
    writerHost(f.host);
    modelTest.setChatModelFactory(() => ({ providerId: 'openai', modelId: 'model', stream() { throw new Error('Writer must not start'); } }) as never);
    t.teardown(async () => { stopAllDelegations('test'); await delegationTest._settleBackground(true); modelTest.reset(); });
    const writing = f.host.toolRegistry.getTool('delegate')!.execute({ task: 'Prepare', aspect: 'child', background: false,
        _invocationAgentName: 'Tester', _invocationOrigin: draftOwner, _invocationDelegationDepth: 1 }, f.host.app, f.host);
    const review = f.host.toolRegistry.getTool('subagent_changes')!.execute({ action: 'list' }, undefined, undefined, reviewContext());
    const reporting = f.report();
    held.release();
    t.like(await writing, { success: false, error: mobile
        ? 'Sub-agent child error: Sub-agent writes through drafts did not start on this device. Run "Run device diagnostics". You can continue chatting and run read-only tasks.'
        : 'Sub-agent child error: Draft storage is unavailable. The sub-agent cannot prepare changes; check the recovery log.' });
    t.like(await review, { kind: 'denied', isError: true });
    const report = await reporting;
    t.regex(report, /\| drafts.stage \| ERROR \| \d+ \| restore \|/);
    t.regex(report, /\| drafts.error.name \| OK \| \d+ \| TypeError \|/);
    t.regex(report, /\| drafts.error.code \| OK \| \d+ \| EACCES \|/);
    t.regex(report, /\| drafts.available \| OK \| \d+ \| false \|/);
    t.deepEqual(errors.filter(args => args[0] === 'VaultDrafts').map(args => args.slice(0, 2)), [['VaultDrafts', 'Draft runtime unavailable:']]);
    t.deepEqual(notices, mobile ? [] : ['Draft storage is unavailable. The sub-agent cannot prepare changes; check the recovery log.']);
    t.deepEqual(f.host.toolRegistry.getAllTools().map(tool => tool.name), ['delegate', 'sub_agent', 'write', 'read']);
});

for (const mobile of [false, true]) test.serial(`F2n recovery issues notify and block GC for runtime: mobile=${mobile}`, async t => {
    const f = await draftDiagnosticFixture(t, mobile);
    await seedPending(f.host.app, mobile);
    await seedReceipts(portsFor(f.host.app, mobile), 1, Date.now() - 31 * 86400000);
    await f.host.app.vault.adapter.writeBinary(`${DRAFT_ROOT}/previous/manifests/000003.json`, new TextEncoder().encode('invalid synthetic manifest').buffer);
    await f.start();
    t.is(f.host.vaultDraftRuntime!.issues.length, 1);
    t.deepEqual(notices, ['Some drafts could not be restored (1). See the log; files were preserved.']);
    for (let i = 0; i < 3; i++) {
        f.host.subTaskRegistry.events.emit('draft:changed');
        await f.host.vaultDraftRuntime!.flush();
    }
    t.deepEqual(await portsFor(f.host.app, mobile).storage.list(`${DRAFT_ROOT}/receipt-0/manifests`), ['000004.json']);
    t.like(await f.host.toolRegistry.getTool('subagent_changes')!.execute({ action: 'list' }, undefined, undefined, reviewContext()),
        { kind: 'listed', changes: [{ path: 'Previous.md', status: 'pending' }, { path: 'new.md', status: 'rejected' }] });
    const report = await f.report();
    t.regex(report, /\| drafts.stage \| OK \| \d+ \| ready \|/);
    t.regex(report, /\| drafts.recoveryIssues \| OK \| \d+ \| 1 \|/);
});

for (const mobile of [false, true]) test.serial(`F2n unload during scan cancels waiters, stops writes, reload restores: mobile=${mobile}`, async t => {
    let plugin!: InstanceType<typeof Plugin>;
    let held!: ReturnType<typeof holdScan>;
    const tools = await bootToolRegistry(t, mobile, async current => {
        plugin = current;
        // Supply the host's non-recursive empty-directory contract; the harness mock uses fs.rm for rmdir(false).
        if (mobile) mock.method(current.app.vault.adapter, 'rmdir', async (path: string, recursive: boolean) => {
            t.is(recursive, false);
            const adapter = current.app.vault.adapter as Obsidian.FileSystemAdapter;
            fs.rmdirSync(`${adapter.getBasePath()}/${path}`);
        });
        await seedPending(current.app, mobile, true); // Requires a repair publication if allowed to finish.
        await seedReceipts(portsFor(current.app, mobile), 1, Date.now() - 31 * 86400000);
        held = holdScan(current.app, mobile);
    });
    await held.entered;
    const pending = tools.getTool('delegate')!.execute({ task: 'Prepare', aspect: 'child' }, plugin.app, plugin);
    const reviewing = tools.getTool('subagent_changes')!.execute({ action: 'list' }, undefined, undefined, reviewContext());
    const warnings: unknown[][] = [];
    mock.method(log, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const registry = plugin.subTaskRegistry!;
    let writes = 0, registrations = 0;
    const prototype = mobile ? AdapterDraftStorage.prototype : DesktopDraftStorage.prototype;
    for (const name of ['writeBlob', 'publish', 'remove'] as const) {
        const original = prototype[name];
        mock.method(prototype, name, function(this: unknown, ...args: unknown[]) { writes++; return Reflect.apply(original, this, args); });
    }
    const register = tools.registerTool.bind(tools);
    mock.method(tools, 'registerTool', (tool: Parameters<ToolRegistry['registerTool']>[0]) => { registrations++; return register(tool); });
    notices.length = 0;
    plugin.onunload();
    t.like(await pending, { success: false, error: 'Delegation with parent conversation cancelled. The sub-agent was not started.' });
    t.deepEqual(await reviewing, { kind: 'denied', isError: true, message: 'Permission or approval to review this change was denied.' });
    await draftTask(plugin)!.ready; // Does not wait for the stuck host I/O.
    held.release(); await held.returned;
    await new Promise<void>(resolve => setImmediate(resolve));
    t.deepEqual({ writes, registrations, notices, warnings, summaries: registry.draftSummaries(draftOwner) },
        { writes: 0, registrations: 0, notices: [], warnings: [], summaries: [] });
    const reloaded = { app: plugin.app, subTaskRegistry: new SubTaskRegistry(), toolRegistry: new ToolRegistry(),
        vaultDraftRuntime: undefined as Awaited<ReturnType<typeof import('../modules/tools/index.js').initializeVaultDrafts>> | undefined };
    t.teardown(() => { reloaded.vaultDraftRuntime?.dispose(); reloaded.subTaskRegistry.dispose(); });
    await Plugin.prototype.initializeVaultDraftRuntime.call(reloaded as never, reloaded.toolRegistry);
    await finishDraftStartup(reloaded);
    t.deepEqual(reloaded.vaultDraftRuntime!.store.list().map(draft => [draft.draftId, draft.phase]),
        [['previous', { kind: 'sealed', reason: 'restart' }]]);
    t.like(await reloaded.toolRegistry.getTool('subagent_changes')!.execute({ action: 'list' }, undefined, undefined, reviewContext()),
        { kind: 'listed', changes: [{ path: 'Previous.md', status: 'pending' }] });
});

for (const mobile of [false, true]) test.serial(`F2n unload releases flush during event GC: mobile=${mobile}`, async t => {
    let plugin!: InstanceType<typeof Plugin>;
    await bootToolRegistry(t, mobile, async current => { plugin = current; await seedPending(current.app, mobile); });
    await draftTask(plugin)!.ready;
    const runtime: Awaited<ReturnType<typeof import('../modules/tools/index.js').initializeVaultDrafts>> = Reflect.get(plugin, 'vaultDraftRuntime');
    const reached = deferred(), release = deferred();
    const prototype = mobile ? AdapterDraftStorage.prototype : DesktopDraftStorage.prototype;
    const list = prototype.list;
    mock.method(prototype, 'list', async function(this: unknown, path: string) {
        if (path === DRAFT_ROOT) { reached.resolve(); await release.promise; }
        return Reflect.apply(list, this, [path]);
    });
    const result = await plugin.toolRegistry!.getTool('subagent_changes')!.execute(
        { action: 'reject', draft_id: 'previous', change_id: 'change-1', revision: 1 }, undefined, undefined, reviewContext());
    t.deepEqual(result, { kind: 'rejected' });
    await reached.promise;
    let flushed = false, removals = 0;
    const flushing = runtime.flush().then(() => { flushed = true; });
    await Promise.resolve();
    t.is(flushed, false);
    const remove = prototype.remove;
    mock.method(prototype, 'remove', function(this: unknown, path: string) { removals++; return Reflect.apply(remove, this, [path]); });
    notices.length = 0;
    plugin.onunload(); await flushing;
    t.is(flushed, true);
    release.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    t.deepEqual([removals, notices], [0, []]);
    t.deepEqual(await portsFor(plugin.app, mobile).storage.list(`${DRAFT_ROOT}/previous/manifests`), ['000001.json', '000002.json', '000003.json']);
});

// F2o: only the diagnostic admission timer is controlled; file probes stay real.
function diagnosticWaitClock() {
    const scheduled: number[] = [], cleared: number[] = [];
    const callbacks = new Map<number, () => void>();
    const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    let id = 1000000;
    mock.method(window, 'setTimeout', (callback: () => void, ms: number, ...args: unknown[]) => {
        if (ms !== 5000) return set(callback, ms, ...args);
        scheduled.push(ms); callbacks.set(++id, callback); return id;
    });
    mock.method(window, 'clearTimeout', (timer: number) => {
        if (timer > 1000000 && timer <= id) { cleared.push(timer); callbacks.delete(timer); }
        else clear(timer);
    });
    return { scheduled, cleared, callbacks, expire: () => { for (const callback of [...callbacks.values()]) callback(); } };
}
async function savedDiagnosticReports(app: Obsidian.App) {
    if (!await app.vault.adapter.exists('.pkm-assistant/diagnostics')) return [];
    const files = (await app.vault.adapter.list('.pkm-assistant/diagnostics')).files.filter(path => path.endsWith('.md'));
    return Promise.all(files.map(path => app.vault.adapter.read(path)));
}

for (const mobile of [false, true]) for (const outcome of ['unstarted', 'timeout', 'success', 'abort', 'unload', 'abort-no-controller'] as const) {
    test.serial(`F2o diagnostics bounded wait: mobile=${mobile}, ${outcome}`, async t => {
        t.timeout(5000);
        const f = await draftDiagnosticFixture(t, mobile);
        await seedPending(f.host.app, mobile);
        const held = holdScan(f.host.app, mobile);
        t.teardown(held.release);
        await f.prepare();
        if (outcome !== 'unstarted') { draftTask(f.host)!.start(); await held.entered; }
        if (outcome === 'abort-no-controller') {
            const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'AbortController')!;
            Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: undefined });
            t.teardown(() => Object.defineProperty(globalThis, 'AbortController', descriptor));
        }
        let reviewed = false;
        const reviewing = f.host.toolRegistry.getTool('subagent_changes')!.execute({ action: 'list' }, undefined, undefined, reviewContext())
            .then(value => { reviewed = true; return value; });
        const clock = diagnosticWaitClock();
        const reporting = Plugin.prototype.runDeviceDiagnostics.call(f.host as never);
        if (outcome === 'unstarted') {
            await reporting;
            t.deepEqual(clock.scheduled, []);
        } else {
            t.deepEqual(clock.scheduled, [5000]);
            if (outcome === 'timeout') clock.expire();
            if (outcome === 'success') held.release();
            if (outcome === 'abort' || outcome === 'abort-no-controller') Reflect.get(f.host, 'diagnosticController').abort();
            if (outcome === 'unload') Plugin.prototype.onunload.call(f.host as never);
            await reporting;
            t.is(clock.callbacks.size, 0);
            t.is(clock.cleared.length, 1);
        }
        const reports = await savedDiagnosticReports(f.host.app);
        if (outcome === 'abort' || outcome === 'abort-no-controller' || outcome === 'unload') {
            clock.expire();
            t.deepEqual(reports, []);
            t.is(Reflect.get(f.host, 'diagnosticController'), null);
        } else {
            t.is(reports.length, 1);
            t.regex(reports[0], outcome === 'success' ? /\| drafts.stage \| OK \| \d+ \| ready \|/
                : outcome === 'unstarted' ? /\| drafts.stage \| ERROR \| \d+ \| presence \|/
                : /\| drafts.stage \| ERROR \| \d+ \| restore \|/);
            t.regex(reports[0], outcome === 'success' ? /\| drafts.available \| OK \| \d+ \| true \|/
                : /\| drafts.available \| OK \| \d+ \| false \|/);
        }
        if (outcome === 'unstarted' || outcome === 'timeout') t.is(reviewed, false);
        held.release();
        if (outcome !== 'unload') {
            await finishDraftStartup(f.host);
            t.like(await reviewing, { kind: 'listed', changes: [{ draft_id: 'previous', path: 'Previous.md' }] });
            await Plugin.prototype.runDeviceDiagnostics.call(f.host as never);
            const next = await savedDiagnosticReports(f.host.app);
            t.is(next.length, reports.length + 1);
            t.is(next.filter(report => /\| drafts.stage \| OK \| \d+ \| ready \|/.test(report)).length,
                outcome === 'success' ? 2 : 1);
            t.is(clock.callbacks.size, 0);
        } else {
            await draftTask(f.host)!.drained();
            t.like(await reviewing, { kind: 'denied', isError: true });
            t.deepEqual(await savedDiagnosticReports(f.host.app), []);
        }
    });
}

for (const mobile of [false, true]) test.serial(`F2o ready reinitialization replaces runtime and admits tools: mobile=${mobile}`, async t => {
    t.timeout(5000);
    const f = await draftDiagnosticFixture(t, mobile);
    await seedPending(f.host.app, mobile);
    await f.start();
    const old = f.host.vaultDraftRuntime!, oldTask = draftTask(f.host)!;
    Object.assign(f.host, { _ready: true });
    await f.prepare();
    t.is(oldTask.closed, true);
    await draftTask(f.host)!.ready;
    const { client } = writerHost(f.host);
    let calls = 0;
    modelTest.setChatModelFactory(() => ({ providerId: 'openai', modelId: 'model', stopStream() {},
        stream(_payload: unknown, handlers: { done(value: unknown): void }) {
            calls++; handlers.done({ choices: [{ message: { role: 'assistant', content: 'Completed' } }] });
        },
    }) as never);
    t.teardown(async () => { stopAllDelegations('test'); await delegationTest._settleBackground(true); modelTest.reset(); });
    t.like(await client.executeToolCall({ name: 'delegate', arguments: { task: 'Prepare', aspect: 'child', background: false } },
        'Tester', { origin: draftOwner, autonomy: 'yolo' }), { success: true, started: true });
    await delegationTest._settleBackground(true);
    t.deepEqual(f.host.subTaskRegistry.list().map(task => [task.status, task.result?.text]), [['done', 'Completed']]);
    t.is(calls, 1);
    t.like(await client.executeToolCall({ name: 'sub_agent', arguments: { action: 'list' } },
        'Tester', { origin: draftOwner, autonomy: 'yolo' }), { success: true });
    t.like(await client.executeToolCall({ name: 'subagent_changes', arguments: { action: 'list' } },
        'Tester', { origin: draftOwner, autonomy: 'yolo' }), { kind: 'listed', changes: [{ draft_id: 'previous', path: 'Previous.md' }] });
    // A late disposal must not detach the new projection.
    old.dispose();
    t.deepEqual(f.host.subTaskRegistry.draftSummaries(draftOwner).map(summary => summary.pending), [1]);
    t.regex(await f.report(), /\| drafts.stage \| OK \| \d+ \| ready \|/);
    let oldCollections = 0;
    mock.method(old.store, 'collectResolved', async () => { oldCollections++; });
    t.deepEqual(await f.host.toolRegistry.getTool('subagent_changes')!.execute(
        { action: 'reject', draft_id: 'previous', change_id: 'change-1', revision: 1 }, undefined, undefined, reviewContext()), { kind: 'rejected' });
    await f.host.vaultDraftRuntime!.flush();
    t.is(oldCollections, 0);
    t.deepEqual(f.host.subTaskRegistry.draftSummaries(draftOwner).map(summary => summary.pending), [0]);
});

for (const mobile of [false, true]) for (const unload of [false, true]) {
    test.serial(`F2o replacement serializes namespace and closes old scan: mobile=${mobile}, unload=${unload}`, async t => {
        t.timeout(5000);
        const f = await draftDiagnosticFixture(t, mobile);
        await seedPending(f.host.app, mobile, true);
        const held = holdScan(f.host.app, mobile);
        t.teardown(held.release);
        Object.assign(f.host, { _ready: true });
        await f.prepare(); await held.entered;
        const old = draftTask(f.host)!;
        await f.prepare();
        // A third owner must not bypass the still-running first owner.
        const middle = draftTask(f.host)!;
        let calls = 0, writes = 0;
        const prototype = mobile ? AdapterDraftStorage.prototype : DesktopDraftStorage.prototype;
        for (const name of ['list', 'read', 'writeBlob', 'publish', 'remove'] as const) {
            const original = prototype[name];
            mock.method(prototype, name, function(this: unknown, ...args: unknown[]) {
                calls++; if (name === 'publish' || name === 'writeBlob' || name === 'remove') writes++;
                return Reflect.apply(original, this, args);
            });
        }
        await f.prepare();
        await new Promise<void>(resolve => setImmediate(resolve));
        t.deepEqual([old.closed, middle.closed, calls], [true, true, 0]);
        const stage = Reflect.get(f.host, 'draftStartup');
        const tools = f.host.toolRegistry;
        let registryChanges = 0;
        for (const name of ['registerTool', 'unregisterTool'] as const) {
            const original = tools[name];
            mock.method(tools, name, function(this: unknown, ...args: unknown[]) {
                registryChanges++; return Reflect.apply(original, this, args);
            });
        }
        notices.length = 0;
        if (unload) Plugin.prototype.onunload.call(f.host as never);
        held.release(); await old.drained(); await middle.drained();
        await draftTask(f.host)!.ready;
        await draftTask(f.host)!.drained();
        if (unload) {
            t.deepEqual({ calls, writes, notices, registryChanges, runtime: f.host.vaultDraftRuntime, stage: Reflect.get(f.host, 'draftStartup') },
                { calls: 0, writes: 0, notices: [], registryChanges: 0, runtime: undefined, stage });
        } else {
            t.is(writes, 1, 'only the final owner publishes the restart repair');
            t.deepEqual(f.host.vaultDraftRuntime!.store.list().map(draft => [draft.draftId, draft.phase]),
                [['previous', { kind: 'sealed', reason: 'restart' }]]);
            t.regex(await f.report(), /\| drafts.stage \| OK \| \d+ \| ready \|/);
        }
    });
}

for (const mobile of [false, true]) test.serial(`F2o thread closure during initial GC collects earlier protected payload: mobile=${mobile}`, async t => {
    const f = await draftDiagnosticFixture(t, mobile);
    const ports = portsFor(f.host.app, mobile);
    const seed = new DraftStore(new DraftPersistence(ports.storage, ports.hasher), ports.vault, { now: () => Date.now() });
    for (const id of ['a', 'b']) {
        const draft = await seed.create({ draftId: id, runId: id, threadId: id, owner: draftOwner });
        const changed = await seed.mutate(draft.draftId, { path: parseVaultPath('Notatki/Przyklad.md'),
            source: { tool: 'write', callId: id }, value: { kind: 'text', text: 'Proposal' } });
        await seed.seal(draft.draftId, 'finished');
        await seed.setReview(draft.draftId, changed.changes[0].id, changed.changes[0].revision, { kind: 'rejected' });
    }
    const registry = f.host.subTaskRegistry;
    registry.createThread({ threadId: 'a', name: 'child', owner: draftOwner, origin: draftOwner, config: {} });
    registry.endRun('a', { successful: true, answer: 'Completed' });
    const prototype = mobile ? AdapterDraftStorage.prototype : DesktopDraftStorage.prototype;
    const remove = prototype.remove;
    let closed = false;
    mock.method(prototype, 'remove', function(this: unknown, path: string) {
        if (!closed && path.startsWith(`${DRAFT_ROOT}/b/blobs/`)) {
            closed = true; registry.closeThread('a');
        }
        return Reflect.apply(remove, this, [path]);
    });
    await f.start(); await f.host.vaultDraftRuntime!.flush();
    t.is(registry.getThread('a')?.phase, 'closed');
    t.deepEqual(f.host.vaultDraftRuntime!.store.list().map(draft => [draft.draftId, draft.payloadCollected]), [['a', true], ['b', true]]);
    t.deepEqual(await ports.storage.list(`${DRAFT_ROOT}/a/blobs`), []);
});

for (const mobile of [false, true]) test.serial(`F2o replacement waits for old runtime event GC I/O: mobile=${mobile}`, async t => {
    t.timeout(5000);
    const f = await draftDiagnosticFixture(t, mobile);
    await seedPending(f.host.app, mobile); await f.start();
    Object.assign(f.host, { _ready: true });
    const old = f.host.vaultDraftRuntime!;
    const entered = deferred(), release = deferred();
    t.teardown(release.resolve);
    const prototype = mobile ? AdapterDraftStorage.prototype : DesktopDraftStorage.prototype;
    const list = prototype.list;
    let scans = 0;
    mock.method(prototype, 'list', async function(this: unknown, path: string) {
        if (path === DRAFT_ROOT && ++scans === 1) { entered.resolve(); await release.promise; }
        return Reflect.apply(list, this, [path]);
    });
    t.deepEqual(await f.host.toolRegistry.getTool('subagent_changes')!.execute(
        { action: 'reject', draft_id: 'previous', change_id: 'change-1', revision: 1 }, undefined, undefined, reviewContext()), { kind: 'rejected' });
    await entered.promise;
    await f.prepare();
    await old.flush(); // Waiters are released, but ownership still waits for physical I/O.
    await new Promise<void>(resolve => setImmediate(resolve));
    t.is(scans, 1);
    release.resolve(); await draftTask(f.host)!.ready;
    t.deepEqual(f.host.vaultDraftRuntime!.store.list().map(draft => [draft.draftId, draft.payloadCollected]), [['previous', true]]);
    t.deepEqual(await portsFor(f.host.app, mobile).storage.list(`${DRAFT_ROOT}/previous/blobs`), []);
    t.regex(await f.report(), /\| drafts.stage \| OK \| \d+ \| ready \|/);
});
