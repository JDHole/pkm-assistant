import test from 'ava';
import type { ExecutionContext } from 'ava';
import { createHash } from 'node:crypto';
import { DraftStore, DraftPersistence, DraftView, parseDraftId, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftStorageIO, DraftViewIO, VaultStat } from '../vault-drafts/index.js';
import { ArtifactStore, parseArtifact } from '../artifacts/index.js';
import { SubAgentRunner, SubRunDrafts, SubTaskRegistry, SubTaskNotifier } from '../sub-agents/index.js';
import type { SubTask, SubRunResult } from '../sub-agents/index.js';
import { KomunikatorManager } from '../komunikator/KomunikatorManager.js';
import { __test__ as modelsTest } from '../models/index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';
import { MCPClient } from './MCPClient.js';
import { ToolRegistry } from './ToolRegistry.js';
import { createWriteTool } from './WriteTool.js';
import { createReadTool } from './ReadTool.js';
import { createDeleteTool } from './DeleteTool.js';
import { createCreateFolderTool } from './CreateFolderTool.js';
import { createArtifactCreateTool } from './built-in-servers/artifacts/ArtifactCreateTool.js';
import { createArtifactUpdateTool } from './built-in-servers/artifacts/ArtifactUpdateTool.js';
import { createGenerateImageTool } from './GenerateImageTool.js';
import { createAddTextToImageTool } from './AddTextToImageTool.js';
import { createMemorySaveTool } from './MemorySaveTool.js';
import { createTodoTool } from './built-in-servers/artifacts/TodoTool.js';
import { createKomunikatorTools } from './KomunikatorTools.js';
import { createDelegateTool, stopAllDelegations, __test__ } from './DelegateTool.js';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function storage(): DraftStorageIO {
    const files = new Map<string, Uint8Array>();
    return {
        list: async path => [...new Set([...files.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1).split('/')[0]))],
        read: async path => { const bytes = files.get(path); if (!bytes) throw new Error('missing'); return bytes.slice(); },
        writeBlob: async (path, bytes) => { files.set(path, bytes.slice()); },
        publish: async (path, bytes, allowed) => { if (!allowed()) return 'cancelled'; files.set(path, bytes.slice()); return 'published'; },
    };
}
async function fixture(initial: Record<string, string> = { 'a.md': 'Baza' }) {
    const files = new Map(Object.entries(initial).map(([path, text]) => [path, encode(text)]));
    const folders = new Set<string>();
    const io: DraftViewIO = {
        async stat(path): Promise<VaultStat> {
            const bytes = files.get(path);
            return bytes ? { kind: 'file', bytes: bytes.length, mtime: 7 }
                : folders.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`)) ? { kind: 'folder' } : { kind: 'missing' };
        },
        async read(path) { const bytes = files.get(path); if (!bytes) throw new Error('ENOENT'); return bytes.slice(); },
        async list(path) {
            const prefix = path ? `${path}/` : '', children = new Set<string>(), dirs = new Set<string>();
            for (const name of [...files.keys(), ...folders]) if (name.startsWith(prefix)) {
                const rest = name.slice(prefix.length), slash = rest.indexOf('/');
                if (slash >= 0) dirs.add(prefix + rest.slice(0, slash));
                else if (folders.has(name)) dirs.add(name); else children.add(name);
            }
            return { files: [...children], folders: [...dirs] };
        },
    };
    const entry = (path: string) => ({ path, name: path.split('/').pop()!, basename: path.split('/').pop()!.replace(/\.md$/, ''), extension: path.split('.').pop()! });
    const read = async (file: { path: string }) => decode(await io.read(parseVaultPath(file.path)));
    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => files.has(path) ? entry(path) : folders.has(path) ? { ...entry(path), children: [] } : null,
            getMarkdownFiles: () => [...files.keys()].filter(path => path.endsWith('.md')).map(entry),
            read, cachedRead: read,
            create: async (path: string, text: string) => { files.set(path, encode(text)); return entry(path); },
            createFolder: async (path: string) => { folders.add(path); },
            process: async (file: { path: string }, fn: (text: string) => string | null) => {
                const old = await read(file), next = fn(old); if (next !== null) files.set(file.path, encode(next)); return next ?? old;
            },
            trash: async (file: { path: string }) => { files.delete(file.path); },
            adapter: {
                write: async (path: string, text: string) => { files.set(path, encode(text)); },
                remove: async (path: string) => { files.delete(path); },
                mkdir: async (path: string) => { folders.add(path); },
                read: (path: string) => read({ path }), list: async (path: string) => { const listed = await io.list(path === '/' ? '' : path); return { files: [...listed.files], folders: [...listed.folders] }; },
                exists: async (path: string) => (await io.stat(parseVaultPath(path))).kind !== 'missing',
            },
        },
        metadataCache: { getFileCache: (file: { path: string }) => {
            const text = decode(files.get(file.path) ?? new Uint8Array());
            return { frontmatter: parseArtifact(text).frontmatter };
        } },
        fileManager: {
            processFrontMatter: async () => { throw new Error('Live frontmatter mutation forbidden in this fixture'); },
            renameFile: async () => { throw new Error('Live rename forbidden'); },
        },
    };
    const disk = storage();
    const persistence = new DraftPersistence(disk, { sha256: async bytes => createHash('sha256').update(bytes).digest('hex') });
    const store = new DraftStore(persistence, io, { now: () => 100 });
    const artifactStore = new ArtifactStore({ app, getArtifactsFolder: () => 'Artifacts', now: () => new Date('2026-11-07T12:00:00Z'),
        typeLoader: { getType: () => ({ name: 'plan', statusy: ['draft', 'closed'], pola: { cel: {} }, template: '## Cel\n{{cel}}\n' }) } });
    const plugin = { app, artifactStore, agentManager: { getActiveAgent: () => ({ name: 'Tester' }), getAgent: () => ({ name: 'Tester' }) } };
    return { files, folders, io, app, plugin, persistence, store, disk };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class Mailbox<T> {
    private values: T[] = [];
    private readers: Array<(value: T) => void> = [];
    push(value: T) { const read = this.readers.shift(); if (read) read(value); else this.values.push(value); }
    next(): Promise<T> { return this.values.length ? Promise.resolve(this.values.shift()!) : new Promise(resolve => this.readers.push(resolve)); }
}
type Payload = { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> };
type Request = { payload: Payload; done(text: string): void; call(name: string, args: object): void; fail(): void };
const origin = { agentName: 'Tester', sessionPath: 'session.md', sessionEpoch: 'a'.repeat(32) };
async function runtime(t: ExecutionContext) {
    const f = await fixture({ 'a.md': 'Baza', 'b.md': 'Baza-B', 'source.png': 'IMG' });
    const registry = new SubTaskRegistry();
    const tools = new ToolRegistry();
    for (const tool of [createWriteTool(), createReadTool(), createDeleteTool(), createCreateFolderTool(f.app as never),
        createArtifactCreateTool(), createArtifactUpdateTool(), createGenerateImageTool(), createAddTextToImageTool(),
        createMemorySaveTool(), createTodoTool(), ...createKomunikatorTools()]) tools.registerTool(tool);
    const agent = { name: 'Tester', permissions: { memory: true, guidance_mode: false }, mcp_servers: ['*'], activeSubAgents: [{ name: 'child' }] };
    const memory = { agentName: 'Tester', activeSessionPath: 'session.md', basePath: '.pkm-assistant/agents/tester',
        paths: { brainNotes: '.pkm-assistant/agents/tester/brain' }, vault: f.app.vault,
        appendSessionEvent: async (_path: string, event: unknown) => { journal.push(event); return 'saved'; } };
    const journal: unknown[] = [];
    const config = { name: 'child', description: 'child', role: 'worker', model: 'openai/model', tools: ['write', 'read'], prompt: 'METHOD', scope: null, max_iterations: 25, min_iterations: 1, max_tool_result_length: 15000, enabled: true };
    const manager = new KomunikatorManager(f.app.vault, null, { now: () => 42 });
    let approvals = 0;
    const permissions: string[] = [];
    const plugin = { ...f.plugin, subTaskRegistry: registry, toolRegistry: tools,
        agentManager: { ...f.plugin.agentManager, getAgent: () => agent, getActiveAgent: () => agent,
            getAgentMemory: () => memory, resolveSubAgentConfig: () => config, komunikatorManager: manager,
            findKomunikatorAgent: (name: string) => ({ name }), listKomunikatorAgents: () => [agent, { name: 'Other' }] },
        permissionSystem: { checkPermission: (_agent: unknown, action: string, target?: string | null) => {
            permissions.push(`${action}:${target ?? ''}`); return { allowed: true, requiresApproval: true, reason: 'fixture' };
        }, requiresApproval: () => true },
        approvalManager: { requestApproval: async () => { approvals++; return { result: 'approve' }; } },
        env: { settings: { pkmAssistant: { imageGen: { platform: 'openai', saveFolder: 'Images' },
            limits: { subagent_stall_timeout_ms: 0, model_synthesis_timeout_ms: 0, subagent_final_grace_ms: 0 },
            chat: { platform: 'openai', models: { openai: 'model' }, apiKeys: { openai: 'fixture-key' } } } },
            config: { chat: { providers: { openai: { info: { id: 'openai' } } }, http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) }, transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } } },
    };
    const client = new MCPClient(f.app as never, plugin, tools);
    const fullPlugin = { ...plugin, mcpClient: client };
    let sequence = 0;
    const drafts = new SubRunDrafts(f.store, f.persistence, f.io, () => parseDraftId(`run-draft-${++sequence}`));
    const runner = new SubAgentRunner({ app: f.app, plugin: fullPlugin, toolRegistry: tools, drafts });
    const requests = new Mailbox<Request>();
    class Model {
        providerId = 'openai'; modelId = 'model';
        stream(payload: Payload, handlers: { done(value: unknown): void; error(error: Error): void }) {
            const done = (message: unknown) => handlers.done({ choices: [{ message }] });
            requests.push({ payload: structuredClone(payload), done: text => done({ role: 'assistant', content: text }),
                call: (name, args) => done({ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }),
                fail: () => handlers.error(new Error('Controlled failure')) });
        }
        stopStream() { /* Provider can return late. */ }
    }
    const run = (names = ['write', 'read'], options: Parameters<typeof runner.runTask>[4] = {}) =>
        runner.runTask('TASK', agent, { ...config, tools: names }, new Model() as never, { origin, autonomy: 'yolo', ...options });
    const ownView = (result: SubRunResult) => {
        if (!result.draft) throw new Error('Missing draft reference');
        return new DraftView(f.store, f.persistence, f.io, result.draft.draftId);
    };
    const restored = async () => { const store = new DraftStore(f.persistence, f.io, { now: () => 200 }); await store.restore(); return store; };
    t.teardown(() => { registry.stopAll(); registry.dispose(); });
    return { ...f, registry, tools, plugin: fullPlugin, runner, client, drafts, run, ownView, restored, requests, Model,
        agent, config, memory, journal, permissions, approvals: () => approvals };
}
function lastTool(request: Request): Record<string, unknown> {
    const message = request.payload.messages.filter(message => message.role === 'tool').at(-1);
    if (!message) throw new Error('No tool result');
    return JSON.parse(message.content);
}

for (const family of ['write', 'delete', 'create_folder', 'artifact', 'generate_image', 'add_text_to_image'] as const)
test.serial(`P3 runner isolates writer family ${family} and checks the draft effect`, async t => {
    const f = await runtime(t);
    // External rendering/provider boundaries only; real tool, MCP, host, store and runner run below.
    const obsidian = await import('obsidian') as unknown as { setHarnessRequestUrlRoutes(routes: unknown[]): void; clearHarnessRequestUrlRoutes(): void };
    obsidian.setHarnessRequestUrlRoutes([{ match: 'https://api.openai.com/v1/images/generations', handler: () => ({ json: { data: [{ b64_json: 'AQID', revised_prompt: 'fixture' }] } }) }]);
    t.teardown(() => obsidian.clearHarnessRequestUrlRoutes());
    const bitmap = globalThis.createImageBitmap, canvas = globalThis.OffscreenCanvas;
    const imageInputs: number[][] = [];
    globalThis.createImageBitmap = (async (blob: Blob) => { imageInputs.push([...new Uint8Array(await blob.arrayBuffer())]); return { width: 20, height: 20, close() {} }; }) as never;
    globalThis.OffscreenCanvas = class {
        getContext() { return { drawImage() {}, measureText: () => ({ width: 5 }), fillText() {} }; }
        async convertToBlob() { return new Blob([new Uint8Array([9, 8, 7])]); }
    } as never;
    t.teardown(() => { globalThis.createImageBitmap = bitmap; globalThis.OffscreenCanvas = canvas; });
    const names = family === 'artifact' ? ['artifact_create', 'artifact_update'] : family === 'add_text_to_image' ? ['write', family] : [family];
    const run = f.run(names, { autonomy: 'all' });
    const request = await f.requests.next();
    const args = family === 'write' ? { path: 'a.md', content: 'Gotowe', mode: 'replace' }
        : family === 'delete' ? { path: 'a.md' }
        : family === 'create_folder' ? { path: 'NewFolder' }
        : family === 'artifact' ? { typ: 'plan', tytul: 'Plan', pola: { cel: 'Pierwszy' } }
        : family === 'generate_image' ? { prompt: 'fixture' }
        : { path: 'source.png', output_path: 'output.png', text: 'Hi' };
    if (family === 'add_text_to_image') {
        request.call('write', { path: 'source.png', content: 'COPY' });
        const copied = await f.requests.next(); t.like(lastTool(copied), { success: true, path: 'source.png' });
        copied.call('add_text_to_image', args);
    } else request.call(names[0], args);
    let next = await f.requests.next();
    let result = lastTool(next);
    if (family === 'artifact') t.is(result.type, 'artifact');
    else t.is(result.success, true, JSON.stringify(result));
    t.deepEqual(result.vault_effect, { kind: 'draft', draftId: 'run-draft-1' });
    if (family === 'artifact') {
        next.call('artifact_update', { id: result.id, ops: [{ op: 'set_field', key: 'cel', value: 'Gotowe' }] });
        next = await f.requests.next(); result = lastTool(next);
        t.like(result, { type: 'artifact_update', applied: 1, errors: [] });
    }
    next.done('Prepared');
    const outcome = await run, view = f.ownView(outcome);
    t.is(outcome.result, 'Prepared');
    t.deepEqual(f.store.snapshot(view.draftId!).phase, { kind: 'sealed', reason: 'finished' });
    t.is(decode(f.files.get('a.md')!), 'Baza');
    t.deepEqual([...f.files.keys()].sort(), ['a.md', 'b.md', 'source.png']);
    t.is(f.approvals(), 0);
    t.deepEqual(outcome.outcome.effects.map(effect => [effect.tool, effect.location?.kind, effect.check]),
        names.map(name => [name, 'draft', 'matches']));
    switch (family) {
        case 'write': t.is(await view.read('a.md'), 'Gotowe'); break;
        case 'delete': t.deepEqual(await view.stat('a.md'), { kind: 'missing' }); break;
        case 'create_folder': t.deepEqual(await view.list(), { files: ['a.md', 'b.md', 'source.png'], folders: ['NewFolder'], ambiguous: [] }); break;
        case 'artifact': {
            const change = f.store.snapshot(view.draftId!).changes[0];
            t.is(parseArtifact(await view.read(change.path)).frontmatter.cel, 'Gotowe');
            t.true(f.permissions.some(target => target === `artifact.update:${change.path}`));
            break;
        }
        case 'generate_image': {
            const changes = f.store.snapshot(view.draftId!).changes;
            t.is(changes.length, 2);
            const image = changes.find(change => change.path.endsWith('.png'))!, note = changes.find(change => change.path.endsWith('.md'))!;
            t.deepEqual([...await view.readBinary(image.path)], [1, 2, 3]);
            t.true((await view.read(note.path)).includes(`![[${image.path.split('/').pop()}]]`));
            t.deepEqual(changes.map(change => change.source.callId), ['call-1', 'call-1']);
            break;
        }
        case 'add_text_to_image':
            t.deepEqual(imageInputs, [[67, 79, 80, 89]]);
            t.deepEqual([...f.files.get('source.png')!], [73, 77, 71]);
            t.deepEqual([...await view.readBinary('output.png')], [9, 8, 7]); break;
        default: { const exhaustive: never = family; throw new Error(exhaustive); }
    }
});

for (const ambiguous of [false, true]) test.serial(`P3 A/B -> C receives sealed inputs; ambiguous=${ambiguous}`, async t => {
    const f = await runtime(t);
    modelsTest.setChatModelFactory(() => new f.Model() as never);
    const delegate = createDelegateTool(f.app, { drafts: f.drafts });
    t.teardown(async () => { stopAllDelegations('test'); await __test__._settleBackground(true); modelsTest.reset(); });
    const finishes: string[] = [];
    f.registry.events.on('task:finished', raw => {
        const task = raw as SubTask; finishes.push(task.plan!.nodeId);
        if (task.result?.draft) t.is(f.store.snapshot(task.result.draft.draftId).phase.kind, 'sealed');
    });
    const receipt = await delegate.execute({ tasks: [
        { id: 'C', depends_on: ['A', 'B'], task: 'TASK C', aspect: 'child' },
        { id: 'A', task: 'TASK A', aspect: 'child' }, { id: 'B', task: 'TASK B', aspect: 'child' },
    ], _invocationAgentName: 'Tester', _invocationOrigin: origin }, f.app, f.plugin as never);
    t.like(receipt, { started: true });
    const a = await f.requests.next(), b = await f.requests.next();
    a.call('write', { path: 'a.md', content: 'A' }); const ar = await f.requests.next();
    t.like(lastTool(ar), { success: true, path: 'a.md' });
    b.call('write', { path: ambiguous ? 'a.md' : 'b.md', content: 'B' }); const br = await f.requests.next();
    t.like(lastTool(br), { success: true, path: ambiguous ? 'a.md' : 'b.md' });
    ar.done('Answer A'); br.done('Answer B');
    const c = await f.requests.next();
    t.true(c.payload.messages.some(message => message.content.includes('TASK C')));
    c.call('read', { path: 'a.md', scope: 'vault' }); const cr = await f.requests.next();
    if (ambiguous) {
        const text = cr.payload.messages.filter(message => message.role === 'tool').at(-1)!.content;
        t.deepEqual(JSON.parse(text.slice(text.indexOf('{'))), { isError: true, code: 'ambiguous-input', path: 'a.md',
            sources: [{ draftId: 'run-draft-1', revision: 1 }, { draftId: 'run-draft-2', revision: 1 }],
            error: 'Ambiguous input a.md: run-draft-1, run-draft-2' });
        cr.call('write', { path: 'c.md', content: 'C' });
    } else {
        t.deepEqual(lastTool(cr), { success: true, path: 'a.md', content: 'A' });
        cr.call('read', { path: 'b.md', scope: 'vault' }); const readB = await f.requests.next();
        t.deepEqual(lastTool(readB), { success: true, path: 'b.md', content: 'B' });
        readB.call('write', { path: 'c.md', content: 'C' });
    }
    const saved = await f.requests.next(); t.like(lastTool(saved), { success: true, path: 'c.md' }); saved.done('Answer C');
    await __test__._settleBackground(true);
    t.deepEqual(finishes, ['A', 'B', 'C']);
    const cTask = f.registry.list().find(task => task.plan?.nodeId === 'C')!;
    const view = new DraftView(f.store, f.persistence, f.io, cTask.result!.draft!.draftId);
    t.is(await view.read('c.md'), 'C');
    t.deepEqual([...f.files.keys()].sort(), ['a.md', 'b.md', 'source.png']);
    t.is(decode(f.files.get('a.md')!), 'Baza');
    t.is(decode(f.files.get('b.md')!), 'Baza-B');
});

for (const reason of ['stopped', 'timeout', 'failed'] as const)
test.serial(`P3 ${reason} after confirmed write preserves Gotowe on restart`, async t => {
    const f = await runtime(t), controller = new AbortController();
    let taskId = '';
    const run = f.run(['write'], { abortSignal: controller.signal, abortReason: () => reason === 'timeout' ? 'task-timeout' : 'manual-stop',
        onTaskCreated: task => { taskId = task.id; f.registry.attachAbort(task.id, () => controller.abort()); } });
    (await f.requests.next()).call('write', { path: 'a.md', content: 'Gotowe' });
    const next = await f.requests.next(); t.like(lastTool(next), { success: true, path: 'a.md' });
    if (reason === 'failed') next.fail();
    else f.registry.requestStop(taskId);
    const result = await run;
    t.is(result.outcome.end.kind, reason);
    const restored = await f.restored();
    const manifest = restored.snapshot(result.draft!.draftId);
    t.deepEqual(manifest.phase, { kind: 'sealed', reason });
    t.is(await new DraftView(restored, f.persistence, f.io, manifest.draftId).read('a.md'), 'Gotowe');
    t.is(decode(f.files.get('a.md')!), 'Baza');
});

test.serial('P3 late tool after Stop cannot publish over restored Gotowe', async t => {
    const f = await runtime(t), controller = new AbortController();
    const entered = deferred<void>(), release = deferred<void>(), completed = deferred<void>();
    const write = createWriteTool();
    f.tools.registerTool({ ...write, execute: async (args, app, plugin) => {
        if (args.content === 'Late') { entered.resolve(); await release.promise; }
        try { return await write.execute(args, app as never, plugin as never); }
        finally { if (args.content === 'Late') completed.resolve(); }
    } });
    const run = f.run(['write'], { abortSignal: controller.signal });
    (await f.requests.next()).call('write', { path: 'a.md', content: 'Gotowe' });
    const next = await f.requests.next(); t.like(lastTool(next), { success: true, path: 'a.md' });
    next.call('write', { path: 'a.md', content: 'Late' }); await entered.promise;
    controller.abort(); const result = await run;
    release.resolve(); await completed.promise;
    const restored = await f.restored();
    t.is(await new DraftView(restored, f.persistence, f.io, result.draft!.draftId).read('a.md'), 'Gotowe');
    t.deepEqual(restored.snapshot(result.draft!.draftId).phase, { kind: 'sealed', reason: 'stopped' });
    t.is(decode(f.files.get('a.md')!), 'Baza');
});

test.serial('P3 continuation receives previous sealed draft and writes a fresh draft', async t => {
    const f = await runtime(t);
    let threadId = '';
    const first = f.run(['write', 'read'], { onTaskCreated: task => { threadId = task.threadId!; } });
    (await f.requests.next()).call('write', { path: 'a.md', content: 'A' });
    const saved = await f.requests.next(); t.like(lastTool(saved), { success: true }); saved.done('First');
    const previous = await first;
    const second = f.run(['write', 'read'], { threadId });
    (await f.requests.next()).call('read', { path: 'a.md' });
    const read = await f.requests.next(); t.deepEqual(lastTool(read), { success: true, path: 'a.md', content: 'A' });
    read.call('write', { path: 'a.md', content: 'C' });
    const updated = await f.requests.next(); t.like(lastTool(updated), { success: true }); updated.done('Second');
    const result = await second;
    t.is(await f.ownView(result).read('a.md'), 'C');
    t.is(await f.ownView(previous).read('a.md'), 'A');
    t.not(result.draft!.draftId, previous.draft!.draftId);
    t.deepEqual(f.store.snapshot(result.draft!.draftId).changes[0].inheritedFrom, [previous.draft!]);
    t.is(decode(f.files.get('a.md')!), 'Baza');
});

test.serial('P3 external definitions, known-name execution and forged draft context are refused', async t => {
    const f = await runtime(t);
    f.tools.registerTool({ name: 'outside', source: 'user', serverName: 'remote', inputSchema: {}, description: 'external',
        execute: async () => { await f.app.vault.create('escaped.md', 'Escaped'); return { success: true }; } });
    const run = f.run(['write', 'read', 'outside']);
    const request = await f.requests.next();
    t.deepEqual(request.payload.tools.map(tool => tool.function.name), ['write', 'read', 'ask_parent']);
    request.call('write', { path: 'a.md', content: 'Wrong', _draft_id: 'someone-else' });
    const refused = await f.requests.next();
    const refusal = refused.payload.messages.at(-1)!.content;
    t.deepEqual(JSON.parse(refusal.slice(refusal.indexOf('{'))), { isError: true, code: 'mutation-denied',
        error: 'Draft context cannot be supplied in tool arguments' });
    refused.call('write', { path: 'a.md', content: 'Gotowe' });
    const saved = await f.requests.next(); t.like(lastTool(saved), { success: true }); saved.done('Done');
    const result = await run;
    const external = await f.client.executeToolCall({ name: 'outside', arguments: {} }, 'Tester',
        { vaultExecution: { kind: 'overlay-write', workspace: f.ownView(result) }, autonomy: 'yolo' });
    t.deepEqual(external, { isError: true, code: 'mutation-denied', error: 'External tools are unavailable in a draft' });
    t.is(await f.ownView(result).read('a.md'), 'Gotowe');
    t.deepEqual([...f.files.keys()].sort(), ['a.md', 'b.md', 'source.png']);
});

for (const client of ['missing', 'legacy'] as const) test.serial(`P3 ${client} MCP refuses draft fallback`, async t => {
    const f = await runtime(t);
    const runner = new SubAgentRunner({ app: f.app, toolRegistry: f.tools, drafts: f.drafts,
        plugin: { ...f.plugin, mcpClient: client === 'missing' ? null : { executeToolCall: f.client.executeToolCall.bind(f.client) } } });
    const result = await runner.runTask('Write', f.agent, f.config, new f.Model() as never, { origin });
    t.is(result.failed, true);
    t.true(result.result.includes('Draft execution requires a compatible MCPClient'));
    t.is(decode(f.files.get('a.md')!), 'Baza');
    t.deepEqual(f.store.list().map(item => item.phase), [{ kind: 'sealed', reason: 'failed' }]);
});

test.serial('P3 ordinary read-only sub keeps literal legacy result and creates no draft', async t => {
    const f = await runtime(t), run = f.run(['read']);
    (await f.requests.next()).call('read', { path: 'a.md' });
    const read = await f.requests.next();
    t.deepEqual(lastTool(read), { success: true, path: 'a.md', content: 'Baza' }); read.done('Read Baza');
    const result = await run;
    t.is(result.result, 'Read Baza');
    t.deepEqual(result.outcome, { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] });
    t.deepEqual(f.store.list(), []);
    t.false(Object.hasOwn(result, 'draft'));
});

test.serial('P3 memory scope, memory_save, todo and mail retain live state in a draft run', async t => {
    const f = await runtime(t);
    const run = f.run(['write', 'read', 'memory_save', 'todo', 'kom_send']);
    (await f.requests.next()).call('memory_save', { name: 'Preference', type: 'user', description: 'A preference', content: 'Tea' });
    const memory = await f.requests.next(), saved = lastTool(memory);
    t.like(saved, { success: true, agent: 'Tester', type: 'user' });
    const memoryPath = String(saved.path);
    t.true(decode(f.files.get(memoryPath)!).includes('\nTea\n'));
    memory.call('read', { scope: 'memory', path: saved.filename });
    const read = await f.requests.next();
    t.like(lastTool(read), { success: true, agent: 'Tester', filename: saved.filename, path: memoryPath, content: decode(f.files.get(memoryPath)!) });
    read.call('todo', { action: 'create', items: ['Prepare draft'], title: 'Work' });
    const todo = await f.requests.next();
    t.like(lastTool(todo), { type: 'todo', title: 'Work', items: [{ text: 'Prepare draft', checked: false }], done: 0, total: 1 });
    t.true(decode(f.files.get('.pkm-assistant/artifacts/todo/tester-session.md')!).includes('Prepare draft'));
    todo.call('kom_send', { to: 'Other', subject: 'Ready', content: 'Prepared material' });
    const mail = await f.requests.next();
    t.like(lastTool(mail), { success: true, id: 'msg-42' });
    const received = await f.plugin.agentManager.komunikatorManager.readMessage('Other', 'msg-42');
    t.like(received, { success: true, message: { from: 'Tester', subject: 'Ready', body: 'Prepared material' } });
    mail.call('write', { path: 'a.md', content: 'Gotowe' });
    const write = await f.requests.next(); t.like(lastTool(write), { success: true }); write.done('Finished');
    const result = await run;
    t.deepEqual(f.store.snapshot(result.draft!.draftId).changes.map(change => change.path), ['a.md']);
    t.deepEqual(result.outcome.effects.map(effect => [effect.tool, effect.location?.kind ?? 'live']),
        [['memory_save', 'live'], ['todo', 'live'], ['kom_send', 'live'], ['write', 'draft']]);
    t.is(await f.ownView(result).read('a.md'), 'Gotowe');
    t.is(decode(f.files.get('a.md')!), 'Baza');
    t.true(f.journal.length > 0);
});

test.serial('P3 main agent retains approval, diff and live write', async t => {
    const f = await runtime(t);
    const diffs: unknown[] = [];
    const client = new MCPClient(f.app as never, f.plugin, f.tools, { diffModalFactory: (_app, diff) => {
        diffs.push([diff.path, diff.oldContent, diff.newContent]); return { waitForApproval: async () => 'approve' };
    } });
    const result = await client.executeToolCall({ name: 'write', arguments: { path: 'a.md', content: 'Main' } }, 'Tester', { autonomy: 'all', origin });
    t.like(result, { success: true, path: 'a.md' });
    t.is(decode(f.files.get('a.md')!), 'Main');
    t.is(f.approvals(), 1);
    t.deepEqual(diffs, [['a.md', 'Baza', 'Main']]);
    t.deepEqual(f.store.list(), []);
});

for (const [reason, background] of [['stop', true], ['timeout', true], ['error', true], ['timeout', false]] as const)
test.serial(`P3 plan ${reason}${background ? '' : ' blocking'} preserves draft, delivers once and blocks successor`, async t => {
    const f = await runtime(t);
    const clock = new QuestionTestClock();
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalNow = performance.now;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: unknown) => clock.clearTimeout(id)) as typeof clearTimeout;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock.now() });
    modelsTest.setChatModelFactory(() => new f.Model() as never);
    const notifier = new SubTaskNotifier({ registry: f.registry });
    const delegate = createDelegateTool(f.app, { drafts: f.drafts });
    t.teardown(async () => {
        stopAllDelegations('test'); await __test__._settleBackground(true); modelsTest.reset(); notifier.dispose();
        globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
        Object.defineProperty(performance, 'now', { configurable: true, value: originalNow });
    });
    const finished: string[] = [];
    f.registry.events.on('task:finished', raw => finished.push((raw as SubTask).plan!.nodeId));
    const delegated = delegate.execute({ background, _invocationDelegationDepth: background ? 0 : 1, tasks: [
        { id: 'A', task: 'TASK A', aspect: 'child', timeout_ms: 1000 },
        { id: 'C', task: 'TASK C', aspect: 'child', depends_on: ['A'] },
    ], _invocationAgentName: 'Tester', _invocationOrigin: origin }, f.app, f.plugin as never);
    if (background) await delegated;
    (await f.requests.next()).call('write', { path: 'a.md', content: 'Gotowe' });
    const next = await f.requests.next(); t.like(lastTool(next), { success: true, path: 'a.md' });
    const a = f.registry.list().find(task => task.plan?.nodeId === 'A')!;
    if (reason === 'stop') f.registry.requestStop(a.id);
    else if (reason === 'timeout') clock.advance(1000);
    else next.fail();
    await __test__._settleBackground(true);
    const response = await delegated;
    t.is(a.outcome!.end.kind, reason === 'stop' ? 'stopped' : reason === 'error' ? 'failed' : 'timeout');
    t.deepEqual(finished.sort(), ['A', 'C']);
    t.deepEqual(notifier.pending().map(task => task.plan!.nodeId).sort(), background ? ['A', 'C'] : []);
    if (!background) t.like(response, { success: false, results: [{ draft: a.result!.draft }, { blocked: true }] });
    t.is(f.registry.list().find(task => task.plan?.nodeId === 'C')!.status, 'blocked');
    const restored = await f.restored();
    t.is(await new DraftView(restored, f.persistence, f.io, a.result!.draft!.draftId).read('a.md'), 'Gotowe');
    t.is(decode(f.files.get('a.md')!), 'Baza');
    t.deepEqual(f.store.list().map(manifest => manifest.changes.map(change => change.path)), [['a.md']]);
});

test.serial('P3 read-only successor forwards ancestor view through A -> B -> C', async t => {
    const f = await runtime(t);
    let aId = '', bId = '';
    const a = f.run(['write'], { onTaskCreated: task => { aId = task.id; } });
    (await f.requests.next()).call('write', { path: 'a.md', content: 'A' });
    const saved = await f.requests.next(); t.like(lastTool(saved), { success: true }); saved.done('Answer A');
    const aResult = await a;
    const b = f.run(['read'], { draftDependencies: [aId], onTaskCreated: task => { bId = task.id; } });
    (await f.requests.next()).call('read', { path: 'a.md' });
    const readB = await f.requests.next(); t.deepEqual(lastTool(readB), { success: true, path: 'a.md', content: 'A' }); readB.done('Answer B');
    const bResult = await b;
    t.is(bResult.result, 'Answer B'); t.false(Object.hasOwn(bResult, 'draft'));
    const c = f.run(['read', 'write'], { draftDependencies: [bId] });
    (await f.requests.next()).call('read', { path: 'a.md' });
    const readC = await f.requests.next(); t.deepEqual(lastTool(readC), { success: true, path: 'a.md', content: 'A' });
    readC.call('write', { path: 'a.md', mode: 'patch', old_text: 'A', new_text: 'C' });
    const patch = await f.requests.next(); t.like(lastTool(patch), { success: true }); patch.done('Answer C');
    const result = await c;
    t.is(await f.ownView(result).read('a.md'), 'C');
    t.is(await f.ownView(aResult).read('a.md'), 'A');
    t.deepEqual(f.store.snapshot(result.draft!.draftId).changes[0].inheritedFrom, [aResult.draft!]);
    t.is(decode(f.files.get('a.md')!), 'Baza');
});

test.serial('P3 sealing failure cannot publish a successful plan result or write live', async t => {
    const f = await runtime(t);
    modelsTest.setChatModelFactory(() => new f.Model() as never);
    const delegate = createDelegateTool(f.app, { drafts: f.drafts });
    t.teardown(async () => { stopAllDelegations('test'); await __test__._settleBackground(true); modelsTest.reset(); });
    const publish = f.disk.publish.bind(f.disk);
    f.disk.publish = async (path, bytes, allowed) => {
        const envelope = JSON.parse(decode(bytes)) as { payload: string };
        if (JSON.parse(envelope.payload).phase.kind === 'sealed') throw new Error('Seal storage failure');
        return publish(path, bytes, allowed);
    };
    await delegate.execute({ tasks: [
        { id: 'A', task: 'TASK A', aspect: 'child' }, { id: 'C', task: 'TASK C', aspect: 'child', depends_on: ['A'] },
    ], _invocationAgentName: 'Tester', _invocationOrigin: origin }, f.app, f.plugin as never);
    (await f.requests.next()).call('write', { path: 'a.md', content: 'Gotowe' });
    const saved = await f.requests.next(); t.like(lastTool(saved), { success: true }); saved.done('Ready');
    await __test__._settleBackground(true);
    t.deepEqual(f.registry.list().map(task => [task.plan!.nodeId, task.status]), [['A', 'error'], ['C', 'blocked']]);
    f.disk.publish = publish;
    const restored = await f.restored();
    t.deepEqual(restored.list()[0].phase, { kind: 'sealed', reason: 'restart' });
    t.is(await new DraftView(restored, f.persistence, f.io, restored.list()[0].draftId).read('a.md'), 'Gotowe');
    t.is(decode(f.files.get('a.md')!), 'Baza');
});
