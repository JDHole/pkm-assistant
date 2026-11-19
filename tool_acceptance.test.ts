import test from 'ava';
import { createHash } from 'node:crypto';
import { DraftStore, DraftPersistence, parseDraftId } from './modules/vault-drafts/index.js';
import type { DraftStorageIO, DraftViewIO } from './modules/vault-drafts/index.js';
import { __test__ as delegate, createDelegateTool, createSubAgentTool, stopAllDelegations } from './modules/tools/DelegateTool.js';
import { __test__ as modelsTest } from './modules/models/index.js';
import { createMoveTool } from './modules/tools/MoveTool.js';
import { createViewImageTool } from './modules/tools/ViewImageTool.js';
import { createReadTool } from './modules/tools/ReadTool.js';
import { createDeleteTool } from './modules/tools/DeleteTool.js';
import { createWriteTool } from './modules/tools/WriteTool.js';
import { createCreateFolderTool } from './modules/tools/CreateFolderTool.js';
import { ToolRegistry } from './modules/tools/ToolRegistry.js';
import { MCPClient } from './modules/tools/MCPClient.js';
import { PermissionSystem, ApprovalManager, AccessGuard } from './core/index.js';
import { log } from './core/utils/Logger.js';
import { SubAgentRunner } from './modules/sub-agents/SubAgentRunner.js';
import { SubTaskRegistry } from './modules/sub-agents/SubTaskRegistry.js';
import { SubRunDrafts } from './modules/sub-agents/SubRunDrafts.js';
import { formatSessionEvent } from './modules/memory/activeSessionFormat.js';
import { _chatExecuteToolCall } from './modules/chat/chat/chat_streaming.js';
import { mediaTextPart } from './modules/tools/toolMedia.js';
import { getToolCallLabel, describeToolCall, TOOL_INFO } from './modules/ui-components/ToolCallDisplay.js';
import { getPermissionToolLabel, applyPermissionSwitch } from './modules/agents/toolAxis.js';
import { getLocale, setLocale } from './core/i18n/index.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const bytes = Uint8Array.from(Buffer.from(png, 'base64')).buffer;
function fixture(agentExtra: any = {}) {
  const files = new Map<string, any>();
  const source = { path: 'in/a.png', name: 'a.png', extension: 'png', stat: { size: bytes.byteLength }, bytes };
  files.set(source.path, source);
  const calls: string[] = [];
  const app: any = {
    vault: {
      adapter: { exists: async (path: string) => files.has(path), readBinary: async (path: string) => { calls.push(`adapter:${path}`); return files.get(path).bytes; } },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      readBinary: async (file: any) => { calls.push(`read:${file.path}`); return file.bytes; },
      cachedRead: async (file: any) => new TextDecoder().decode(file.bytes),
      createFolder: async (path: string) => { calls.push(`mkdir:${path}`); files.set(path, { path, name: path, children: [] }); },
      copy: async (file: any, path: string) => { calls.push(`copy:${file.path}:${path}`); const copy = { ...file, path, name: path.split('/').pop() }; files.set(path, copy); return copy; },
    },
    fileManager: { renameFile: async (file: any, path: string) => { calls.push(`move:${file.path}:${path}`); files.delete(file.path); files.set(path, { ...file, path, name: path.split('/').pop() }); } },
  };
  const agent: any = { name: 'A', permissions: { guidance_mode: true }, disabled_tools: [], ...agentExtra };
  const approvals: any[] = [];
  const manager = new ApprovalManager(null);
  manager.setApprovalHandler(async (_app, action) => { approvals.push(action); return 'approve'; });
  const plugin: any = { agentManager: { getAgent: () => agent, getActiveAgent: () => agent }, permissionSystem: new PermissionSystem(null, {}), approvalManager: manager };
  const registry = new ToolRegistry();
  for (const tool of [createMoveTool(), createViewImageTool(), createReadTool(), createDeleteTool(), createWriteTool(), createCreateFolderTool(app)]) registry.registerTool(tool as any);
  const client = new MCPClient(app, plugin, registry);
  plugin.mcpClient = client;
  return { app, files, calls, agent, plugin, registry, client, approvals, manager,
    call: (name: string, args: any, opts: any = { autonomy: 'yolo' }) => client.executeToolCall({ name, arguments: args }, 'A', opts),
  };
}
function decoder(t: any, width = 1, height = 1) {
  const original = globalThis.createImageBitmap;
  const seen: number[] = [];
  globalThis.createImageBitmap = async (blob: any) => { seen.push(blob.size); return { width, height, close() {} } as any; };
  t.teardown(() => { globalThis.createImageBitmap = original; });
  return seen;
}

test.serial('F1: view_image must not put image bytes into debug logs', async t => {
  decoder(t);
  const f = fixture();
  const originalDebug = console.debug, wasDebug = log._debug;
  const logged: any[] = [];
  console.debug = (...args) => logged.push(args);
  log._debug = true;
  t.teardown(() => { console.debug = originalDebug; log._debug = wasDebug; });
  const result: any = await f.call('view_image', { path: 'in/a.png' });
  t.is(result.kind, 'media');
  t.false(JSON.stringify(logged).includes(png), 'Full image base64 was emitted by log.tool to console.debug');
});

for (const vision of [false, true]) test.serial(`F2: sub-agent vision=${vision} must not receive/store image base64 as text`, async t => {
  decoder(t);
  const f = fixture();
  const registry = new SubTaskRegistry();
  f.plugin.subTaskRegistry = registry;
  const runner = new SubAgentRunner({ app: f.app, plugin: f.plugin, toolRegistry: f.registry } as any);
  let iteration = 0;
  const payloads: any[] = [];
  const model = { modelId: vision ? 'vision' : 'text-only', supportsVision: vision, providerId: 'test', stream(payload: any, handlers: any) {
    payloads.push(structuredClone(payload));
    handlers.done({ choices: [{ message: iteration++ === 0 ? { role: 'assistant', content: null,
      tool_calls: [{ id: 'v1', type: 'function', function: { name: 'view_image', arguments: JSON.stringify({ path: 'in/a.png' }) } }] }
      : { role: 'assistant', content: 'done' } }] });
  } };
  const result = await runner.runTask('look', f.agent, { name: 'viewer', role: 'researcher', tools: ['view_image'] } as any, model as any,
    { autonomy: 'yolo', origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' } });
  t.deepEqual(result.toolsUsed, ['view_image']);
  const delegateResult = { success: true, tool_call_details: result.toolCallDetails };
  const session = formatSessionEvent('mcp_call', { tool: 'delegate', result: delegateResult }, 'now');
  t.deepEqual({
    modelTextLeak: JSON.stringify(payloads).includes(png),
    threadLeak: JSON.stringify(registry.listThreads({ agentName: 'A', sessionPath: 's', sessionEpoch: 'e' })).includes(png),
    parentSessionLeak: session.includes(png),
  }, { modelTextLeak: false, threadLeak: false, parentSessionLeak: false });
});

for (const mode of ['move', 'copy']) test.serial(`F3: create_files disabled must block ${mode} creating a destination and parent`, async t => {
  const f = fixture({ disabled_tools: applyPermissionSwitch([], 'create_files', false) });
  const result: any = await f.call('move', { from: 'in/a.png', to: 'new/sub/b.png', mode });
  t.false(result.success === true, JSON.stringify({ result, calls: f.calls }));
});

test.serial('clean: agent edit/delete/read switches, focus/scope, protected and malformed paths deny before mutation', async t => {
  const cases = [
    { agent: { disabled_tools: ['delete'] }, from: 'in/a.png', to: 'out/b.png', mode: 'move' },
    { agent: { disabled_tools: ['write'] }, from: 'in/a.png', to: 'out/b.png', mode: 'copy' },
    { agent: { disabled_tools: ['read'] }, from: 'in/a.png', to: 'out/b.png', mode: 'copy' },
    ...['.obsidian/x.png', '.ObSiDiAn/x.png', '.pkm-assistant/x.png', '.env', 'data.json', '../x.png', '%252e%252e/x.png', 'out/\u200bx.png'].flatMap(path => [
      { from: path, to: 'out/b.png', mode: 'copy' }, { from: 'in/a.png', to: path, mode: 'copy' },
    ]),
    { agent: { permissions: { guidance_mode: false }, focusFolders: [{ path: 'out', access: 'write' }] }, from: 'in/a.png', to: 'out/b.png', mode: 'copy' },
    { agent: { permissions: { guidance_mode: false }, focusFolders: [{ path: 'in', access: 'write' }] }, from: 'in/a.png', to: 'out/b.png', mode: 'copy' },
    { from: 'in/a.png', to: 'out/b.png', mode: 'copy', opts: { autonomy: 'yolo', scopeFolders: ['out'] } },
    { from: 'in/a.png', to: 'out/b.png', mode: 'copy', opts: { autonomy: 'yolo', scopeFolders: ['in'] } },
  ];
  for (const c of cases) {
    const f = fixture(c.agent);
    const result: any = await f.call('move', { from: c.from, to: c.to, mode: c.mode }, c.opts ?? { autonomy: 'yolo' });
    t.false(result.success === true, JSON.stringify(c));
    t.deepEqual(f.calls, [], JSON.stringify(c));
  }
});

test.serial('clean: remembered write/session/other move pairs do not authorize this operation; modal shows both paths', async t => {
  const f = fixture();
  f.manager.addToAlwaysApproved('A', 'vault.write', 'out/b.png');
  f.manager.addToAlwaysApproved('A', 'vault.move', '["copy","in/a.png","out/a.png"]');
  f.client.sessionWriteConsent.grant('s', 'out/b.png');
  const result: any = await f.call('move', { from: 'in/a.png', to: 'out/b.png', mode: 'copy' }, { autonomy: 'edge', origin: { agentName: 'A', sessionPath: 's' } });
  t.true(result.success);
  t.is(f.approvals.length, 1);
  t.is(f.approvals[0].type, 'vault.move');
  t.is(f.approvals[0].approvalTarget, '["copy","in/a.png","out/b.png"]');
  t.regex(f.approvals[0].preview, /in\/a\.png[\s\S]*out\/b\.png/);
  t.false(f.approvals[0].rememberAvailable);
});

test.serial('clean: scoped sub-agent cannot call move/view_image omitted from tools', async t => {
  const f = fixture();
  const runner = new SubAgentRunner({ app: f.app, plugin: f.plugin, toolRegistry: f.registry } as any);
  for (const name of ['move', 'view_image']) {
    const result = await runner._executeTool({ name, arguments: { from: 'in/a.png', to: 'out/b.png', path: 'in/a.png' } } as any, 'A', new Set(['read']));
    t.regex(result, /not allowed|niedozwolone|allowed|permitted/i);
  }
  t.deepEqual(f.calls, []);
});

test.serial('clean: view_image authorization precedes bytes, no-stat/adapter fallback cannot bypass final 10 MiB cap', async t => {
  const seen = decoder(t);
  const f = fixture();
  f.agent.permissions = { guidance_mode: false };
  const denied: any = await f.call('view_image', { path: 'in/a.png' });
  t.true(denied.isError);
  t.deepEqual(f.calls, []);
  f.agent.permissions = { guidance_mode: true };
  const file = { path: 'in/.hidden/a.png', name: 'a.png', extension: 'png', bytes: new Uint8Array(10 * 1024 * 1024 + 1).buffer };
  f.files.set(file.path, file);
  const large: any = await f.call('view_image', { path: file.path });
  t.true(large.isError);
  t.regex(large.error, /10 MiB/);
  t.deepEqual(f.calls, [`adapter:${file.path}`]);
  t.deepEqual(seen, []);
});

test.serial('F4: header pixel limit rejects before decoding', async t => {
  const seen = decoder(t);
  const f = fixture();
  const huge = bytes.slice(0);
  const header = new DataView(huge);
  header.setUint32(16, 30000); header.setUint32(20, 30000);
  f.files.get('in/a.png').bytes = huge;
  const result: any = await f.call('view_image', { path: 'in/a.png' });
  t.true(result.isError);
  t.regex(result.error, /40/);
  t.deepEqual(seen, []);
});

test.serial('clean: missing browser decoder yields controlled error, main chat text model and raw-object session redact bytes', async t => {
  const original = globalThis.createImageBitmap;
  (globalThis as any).createImageBitmap = undefined;
  t.teardown(() => { globalThis.createImageBitmap = original; });
  const f = fixture();
  const result: any = await f.call('view_image', { path: 'in/a.png' });
  t.true(result.isError);
  t.is(result.error, 'Could not read or decode the image.');
  const raw = { kind: 'media', summary: 'a.png', images: [{ mime: 'image/png', base64: png }] };
  const turn = { origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'e' }, agentName: 'A', rawResults: new Map() };
  const view = { plugin: { toolRegistry: f.registry, mcpClient: { executeToolCall: async () => raw } }, _isCurrentModelVision: () => false };
  const content = await _chatExecuteToolCall.call(view as any, turn as any, { id: 'v', name: 'view_image', arguments: {} });
  t.false(JSON.stringify(content).includes(png));
  t.regex(String(content), /model without vision/);
  t.false(formatSessionEvent('mcp_call', { tool: 'view_image', result: raw }, 'now').includes(png));
});

for (const mode of ['move', 'copy']) test.serial(`F5: ${mode} checks destination again after mkdir`, async t => {
  const f = fixture();
  f.app.vault.createFolder = async (path: string) => {
    f.files.set(path, { path, children: [] });
    f.files.set('out/b.png', { path: 'out/b.png', bytes: new TextEncoder().encode('racing content').buffer });
  };
  const result: any = await f.call('move', { from: 'in/a.png', to: 'out/b.png', mode });
  t.true(result.isError);
  t.regex(result.error, /already exists/);
  t.is(new TextDecoder().decode(f.files.get('out/b.png').bytes), 'racing content');
  t.deepEqual(f.calls, []);
});

for (const locale of ['en', 'pl'] as const) for (const state of ['ready', 'unavailable']) for (const mode of ['move', 'copy'])
for (const writer of state === 'ready' ? [false, true] : [false])
test.serial(`F6: ${locale}/${state}/writer=${writer} drafts refuse only the ${mode} call and continue without live mutation`, async t => {
  const previousLocale = getLocale();
  setLocale(locale);
  t.teardown(() => setLocale(previousLocale));
  const f = fixture();
  const before = structuredClone([...f.files]);
  const drafts = state === 'unavailable' ? { kind: 'unavailable' } : readyDrafts(f);
  const runner = new SubAgentRunner({ app: f.app, plugin: f.plugin, toolRegistry: f.registry, drafts } as any);
  let iteration = 0;
  const payloads: any[] = [];
  const model = { stream(payload: any, handlers: any) {
    payloads.push(structuredClone(payload));
    handlers.done({ choices: [{ message: iteration++ === 0 ? { role: 'assistant', content: null,
      tool_calls: [{ id: 'm1', type: 'function', function: { name: 'move', arguments: JSON.stringify({ from: 'in/a.png', to: 'out/b.png', mode }) } }] }
      : { role: 'assistant', content: 'done' } }] });
  } };
  const result = await runner.runTask('relocate', f.agent, { name: 'mover', role: 'worker', tools: writer ? ['move', 'write'] : ['move'] } as any, model as any,
    { autonomy: 'yolo', origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'a'.repeat(32) } });
  t.deepEqual({ liveMutation: f.files.has('out/b.png'), sourceExists: f.files.has('in/a.png'), draft: result.draft },
    { liveMutation: false, sourceExists: true, draft: undefined });
  t.is(result.stoppedBy, 'natural');
  t.is(result.result, 'done');
  t.deepEqual(result.toolsUsed, ['move']);
  t.is(iteration, 2);
  for (const payload of payloads) t.deepEqual(payload.tools.map((tool: any) => tool.function.name), writer ? ['write', 'ask_parent'] : ['ask_parent']);
  const refusal = payloads[1].messages.find((message: any) => message.role === 'tool');
  t.true(refusal.content.includes(locale === 'pl'
    ? 'Przenoszenie i kopiowanie plików jest niedostępne w szkicu.'
    : 'Moving or copying files is unavailable in a draft.'));
  t.deepEqual([...f.files], before);
  t.deepEqual(f.calls, []);
});

function readyDrafts(f: ReturnType<typeof fixture>) {
  const disk = new Map<string, Uint8Array>();
  const storage: DraftStorageIO = {
    list: async path => [...new Set([...disk.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1).split('/')[0]))],
    read: async path => { const value = disk.get(path); if (!value) throw new Error('missing'); return value.slice(); },
    writeBlob: async (path, value) => { disk.set(path, value.slice()); },
    publish: async (path, value, allowed) => { if (!allowed()) return 'cancelled'; disk.set(path, value.slice()); return 'published'; },
  };
  const io: DraftViewIO = {
    stat: async path => { const file = f.files.get(path); return file ? file.children ? { kind: 'folder' } : { kind: 'file', bytes: file.bytes.byteLength, mtime: 1 } : { kind: 'missing' }; },
    read: async path => { const file = f.files.get(path); if (!file) throw new Error('missing'); return new Uint8Array(file.bytes).slice(); },
    list: async path => ({ files: [...f.files.keys()].filter(key => !f.files.get(key).children && key.startsWith(path ? `${path}/` : '') && !key.slice(path ? path.length + 1 : 0).includes('/')), folders: [] }),
  };
  const persistence = new DraftPersistence(storage, { sha256: async value => createHash('sha256').update(value).digest('hex') });
  const store = new DraftStore(persistence, io, { now: () => 1 });
  let sequence = 0;
  return new SubRunDrafts(store, persistence, io, () => parseDraftId(`acceptance-${++sequence}`));
}

test.serial('R2: default broad worker calls the model and completes an ordinary task with real drafts', async t => {
  const f = fixture();
  f.plugin.toolRegistry = f.registry;
  f.plugin.subTaskRegistry = new SubTaskRegistry();
  const config = delegate.buildBuiltinWorkerConfig(f.plugin, f.agent);
  t.true(config.tools.includes('move'));
  t.true(config.tools.includes('write'));
  const payloads: any[] = [];
  const model = { providerId: 'test', modelId: 'test', stream(payload: any, handlers: any) {
    payloads.push(structuredClone(payload));
    handlers.done({ choices: [{ message: { role: 'assistant', content: 'One sentence.' } }] });
  } };
  const runner = new SubAgentRunner({ app: f.app, plugin: f.plugin, toolRegistry: f.registry, drafts: readyDrafts(f) });
  const result = await runner.runTask('Give a one sentence answer', f.agent, config, model as any,
    { autonomy: 'yolo', origin: { agentName: 'A', sessionPath: 's', sessionEpoch: 'a'.repeat(32) } });
  t.is(result.stoppedBy, 'natural');
  t.is(result.result, 'One sentence.');
  t.deepEqual(result.toolsUsed, []);
  t.is(payloads.length, 1);
  t.deepEqual(payloads[0].tools.map((tool: any) => tool.function.name), ['view_image', 'read', 'delete', 'write', 'create_folder', 'ask_parent']);
  t.deepEqual(f.calls, []);
  t.is(Buffer.from(f.files.get('in/a.png').bytes).toString('base64'), png);
});

test.serial('R2: public worker, stale continuation and dependent plan retain normal draft execution', async t => {
  const f = fixture();
  const before = structuredClone([...f.files]);
  const drafts = readyDrafts(f);
  const registry = new SubTaskRegistry();
  Object.assign(f.plugin, { toolRegistry: f.registry, subTaskRegistry: registry,
    env: { settings: { pkmAssistant: { chat: { platform: 'openai', models: { openai: 'model' }, apiKeys: { openai: 'test' } } } },
      config: { chat: { providers: { openai: { info: { id: 'openai' } } },
        http: { send: async () => { throw new Error('Unexpected HTTP'); } },
        transport: { open: async () => { throw new Error('Unexpected transport'); } },
      } } },
  });
  f.registry.registerTool(createDelegateTool(f.app, { drafts }));
  f.registry.registerTool(createSubAgentTool(f.app, { drafts }));
  type Reply = string | { name: string; arguments: object };
  const scripts: Reply[][] = [
    ['Ordinary answer.'], ['Continued answer.'],
    [{ name: 'write', arguments: { path: 'note.md', mode: 'create', content: 'Draft material' } }, 'Predecessor answer.'],
    [{ name: 'read', arguments: { path: 'note.md', scope: 'vault' } }, 'Dependent answer.'],
  ];
  const payloads: any[] = [];
  modelsTest.setChatModelFactory(() => {
    const script = scripts.shift()!;
    let iteration = 0;
    return { providerId: 'openai', modelId: 'model', stream(payload: any, handlers: any) {
      payloads.push(structuredClone(payload));
      const reply = script[iteration++];
      handlers.done({ choices: [{ message: typeof reply === 'string' ? { role: 'assistant', content: reply }
        : { role: 'assistant', content: '', tool_calls: [{ id: `call-${iteration}`, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }] } }] });
    } } as never;
  });
  t.teardown(async () => { stopAllDelegations('test'); await delegate._settleBackground(true); modelsTest.reset(); registry.dispose(); });
  const origin = { agentName: 'A', sessionPath: 's', sessionEpoch: 'a'.repeat(32) };
  const opts = { autonomy: 'yolo', origin, delegationDepth: 1 };
  const first: any = await f.call('delegate', { aspect: 'worker', task: 'Answer one sentence' }, opts);
  t.like(first, { success: true, result: 'Ordinary answer.' }, JSON.stringify(first));
  const thread = registry.getThread(first.sub_id)!;
  t.is(thread.phase, 'idle');
  // Simulate a frozen configuration created before move was hidden.
  (thread.config.toolNames as string[]).push('move');
  const continued: any = await f.call('sub_agent', { action: 'task', sub_id: first.sub_id, task: 'Answer again', background: false }, opts);
  t.like(continued, { success: true, result: 'Continued answer.', sub_id: first.sub_id });
  const plan: any = await f.call('delegate', { tasks: [
    { id: 'A', aspect: 'worker', task: 'Write draft material' },
    { id: 'B', depends_on: ['A'], aspect: 'worker', task: 'Read predecessor draft' },
  ] }, opts);
  t.like(plan, { success: true, counts: { finished: 2, partial: 0, failed: 0, blocked: 0 } });
  t.deepEqual(plan.results.map((result: any) => result.result), ['Predecessor answer.', 'Dependent answer.']);
  t.is(payloads.length, 6);
  for (const payload of payloads) {
    t.false(payload.tools.some((tool: any) => tool.function.name === 'move'));
    t.true(payload.tools.some((tool: any) => tool.function.name === 'write'));
  }
  const written = JSON.parse(payloads[3].messages.find((message: any) => message.role === 'tool').content);
  t.like(written, { success: true, path: 'note.md', vault_effect: { kind: 'draft' } });
  const read = JSON.parse(payloads[5].messages.find((message: any) => message.role === 'tool').content);
  t.like(read, { content: 'Draft material' });
  t.true(JSON.stringify(payloads[4].messages).includes('Predecessor answer.'));
  t.deepEqual([...f.files], before);
  t.deepEqual(f.calls, []);
});

for (const state of ['ready', 'unavailable'] as const) test.serial(`R2: ${state} runtime still permits read with move listed`, async t => {
  const f = fixture();
  f.files.set('note.md', { path: 'note.md', name: 'note.md', extension: 'md', bytes: new TextEncoder().encode('Live read').buffer });
  const runner = new SubAgentRunner({ app: f.app, plugin: f.plugin, toolRegistry: f.registry,
    drafts: state === 'ready' ? readyDrafts(f) : { kind: 'unavailable' } });
  let calls = 0;
  const payloads: any[] = [];
  const model = { stream(payload: any, handlers: any) {
    payloads.push(structuredClone(payload));
    handlers.done({ choices: [{ message: calls++ === 0
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: '{"path":"note.md","scope":"vault"}' } }] }
      : { role: 'assistant', content: 'Read completed.' } }] });
  } };
  const result = await runner.runTask('Read', f.agent, { name: 'reader', tools: ['read', 'move'] }, model as never);
  t.is(result.stoppedBy, 'natural');
  t.is(result.result, 'Read completed.');
  t.is(calls, 2);
  t.like(JSON.parse(payloads[1].messages.find((message: any) => message.role === 'tool').content), { content: 'Live read' });
  t.deepEqual(payloads[0].tools.map((tool: any) => tool.function.name), ['read', 'ask_parent']);
});

for (const mode of ['move', 'copy']) test.serial(`R2: runner without draft DI preserves live ${mode}`, async t => {
  const f = fixture();
  const runner = new SubAgentRunner({ app: f.app, plugin: f.plugin, toolRegistry: f.registry });
  const payloads: any[] = [];
  const model = { stream(payload: any, handlers: any) {
    payloads.push(structuredClone(payload));
    handlers.done({ choices: [{ message: payloads.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'move', type: 'function', function: { name: 'move', arguments: JSON.stringify({ from: 'in/a.png', to: 'out/b.png', mode }) } }] }
      : { role: 'assistant', content: 'Live operation completed.' } }] });
  } };
  const result = await runner.runTask('Relocate', f.agent, { name: 'mover', tools: ['move'] }, model as never, { autonomy: 'yolo' });
  t.is(result.stoppedBy, 'natural');
  t.is(result.result, 'Live operation completed.');
  t.deepEqual(payloads[0].tools.map((tool: any) => tool.function.name), ['move', 'ask_parent']);
  t.like(JSON.parse(payloads[1].messages.find((message: any) => message.role === 'tool').content), { success: true });
  t.is(Buffer.from(f.files.get('out/b.png').bytes).toString('base64'), png);
  t.is(f.files.has('in/a.png'), mode === 'copy');
  t.deepEqual(f.calls, ['mkdir:out', `${mode}:in/a.png:out/b.png`]);
});

test.serial('F7: SVG is rejected as text before decoding', async t => {
  const seen = decoder(t);
  const f = fixture();
  f.files.set('in/a.svg', { path: 'in/a.svg', name: 'a.svg', bytes: new TextEncoder().encode('<svg/>').buffer });
  const result: any = await f.call('view_image', { path: 'in/a.svg' });
  t.true(result.isError);
  t.regex(result.error, /text.*read/);
  t.deepEqual(seen, []);
});

test.serial('clean: GIF keeps image/gif, and its data remains outside text on main vision path', async t => {
  decoder(t);
  const f = fixture();
  const gif = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')).buffer;
  f.files.set('in/a.gif', { path: 'in/a.gif', name: 'a.gif', extension: 'gif', stat: { size: gif.byteLength }, bytes: gif });
  const result: any = await f.call('view_image', { path: 'in/a.gif' });
  t.is(result.kind, 'media');
  t.is(result.images[0].mime, 'image/gif');
  t.false(JSON.stringify(mediaTextPart('view_image', result)).includes(Buffer.from(gif).toString('base64')));
});

test.serial('F8: view_image must be read-only in production runner outcome', async t => {
  decoder(t);
  const f = fixture();
  const runner = new SubAgentRunner({ app: f.app, plugin: f.plugin, toolRegistry: f.registry } as any);
  let iteration = 0;
  const model = { stream(_payload: any, handlers: any) {
    handlers.done({ choices: [{ message: iteration++ === 0 ? { role: 'assistant', content: null,
      tool_calls: [{ id: 'v1', type: 'function', function: { name: 'view_image', arguments: JSON.stringify({ path: 'in/a.png' }) } }] }
      : { role: 'assistant', content: 'done' } }] });
  } };
  const result = await runner.runTask('look', f.agent, { name: 'viewer', role: 'researcher', tools: ['view_image'] } as any, model as any, { autonomy: 'yolo' });
  t.deepEqual(result.outcome.effects, []);
});

test.serial('F9: localized tool/permission labels and catalog entries exist for move/view_image', t => {
  t.teardown(() => setLocale('en'));
  const labels: any = {};
  for (const locale of ['pl', 'en'] as const) {
    setLocale(locale);
    labels[locale] = ['move', 'view_image'].map(name => ({ name, ui: getToolCallLabel(name), permission: getPermissionToolLabel(name), registered: name in TOOL_INFO,
      summary: describeToolCall(name, { from: 'in/a.png', to: 'out/b.png', path: 'in/a.png' }) }));
  }
  t.false(Object.values(labels).some((entries: any) => entries.some((entry: any) => !entry.registered || entry.ui === entry.name || entry.permission === entry.name)), JSON.stringify(labels));
});

test.serial('clean: configurable No-Go holds for both move/copy paths in yolo; changing extension does not bypass destination No-Go', async t => {
  const previous = AccessGuard._noGoFolders.slice();
  AccessGuard.setNoGoFolders(['Secret']);
  t.teardown(() => { AccessGuard._noGoFolders = previous; });
  for (const mode of ['move', 'copy']) for (const side of ['from', 'to']) {
    const f = fixture();
    f.files.set('secret/a.png', { ...f.files.get('in/a.png'), path: 'secret/a.png' });
    const args = side === 'from' ? { from: 'secret/a.png', to: 'out/b.md', mode } : { from: 'in/a.png', to: 'SECRET/b.js', mode };
    const result: any = await f.call('move', args);
    t.true(result.isError, JSON.stringify(args));
    t.deepEqual(f.calls, [], JSON.stringify(args));
  }
});

test.serial('clean: existing destination with different case is rejected when adapter uses case-insensitive existence', async t => {
  const f = fixture();
  f.files.set('out/B.png', { path: 'out/B.png', name: 'B.png', bytes: new TextEncoder().encode('untouched').buffer });
  f.app.vault.adapter.exists = async (path: string) => [...f.files.keys()].some(key => key.toLowerCase() === path.toLowerCase());
  for (const mode of ['move', 'copy']) {
    const result: any = await f.call('move', { from: 'in/a.png', to: 'out/b.png', mode });
    t.true(result.isError);
    t.regex(result.error, /already exists/);
  }
  t.deepEqual(f.calls, []);
  t.is(new TextDecoder().decode(f.files.get('out/B.png').bytes), 'untouched');
});

for (const mode of ['move', 'copy']) test.serial(`A2: ${mode} uses write(create) file permissions and separate folder permissions`, async t => {
  // create_files disables create_folder only. Existing parent: write(create) and move both remain allowed.
  for (const operation of ['write', 'move']) {
    const f = fixture({ disabled_tools: applyPermissionSwitch([], 'create_files', false) });
    f.files.set('out', { path: 'out', children: [] });
    f.app.vault.create = async (path: string, content: string) => {
      const file = { path, name: path, bytes: new TextEncoder().encode(content).buffer };
      f.files.set(path, file); return file;
    };
    const result: any = await f.call(operation, operation === 'write'
      ? { path: 'out/b.md', mode: 'create', content: 'hello' }
      : { from: 'in/a.png', to: 'out/b.md', mode });
    t.true(result.success, JSON.stringify(result));
    t.true(f.files.has('out/b.md'));
  }
  // File inside focus scope, but parent outside it: create_folder must deny.
  const f = fixture({ permissions: { guidance_mode: false }, focusFolders: [
    { path: 'in', access: 'write' }, { path: 'out/allowed', access: 'write' },
  ] });
  const result: any = await f.call('move', { from: 'in/a.png', to: 'out/allowed', mode });
  t.true(result.isError);
  t.deepEqual(f.calls, []);
});

test.serial('A3: host case-insensitive lookup protects differently cased destination', async t => {
  const f = fixture();
  f.files.set('out/B.png', { path: 'out/B.png', bytes });
  f.app.vault.getAbstractFileByPathInsensitive = (path: string) => [...f.files.values()].find(file => file.path.toLowerCase() === path.toLowerCase());
  for (const mode of ['move', 'copy']) {
    const result: any = await f.call('move', { from: 'in/a.png', to: 'out/b.png', mode });
    t.true(result.isError);
    t.regex(result.error, /already exists/);
  }
  t.deepEqual(f.calls, []);
});

test.serial('B1: arbitrary media-contract name is textual in sub-agent fallback', async t => {
  const f = fixture();
  const raw = { kind: 'media', summary: 'look', images: [{ mime: 'image/png', base64: png }], url: `data:image/png;base64,${png}` };
  f.registry.registerTool({ name: 'future_media', description: 'Future media', source: 'built-in', inputSchema: { type: 'object' }, execute: async () => raw } as any);
  const runner = new SubAgentRunner({ app: f.app, plugin: { ...f.plugin, mcpClient: undefined }, toolRegistry: f.registry } as any);
  const text = await runner._executeTool({ name: 'future_media', arguments: {} } as any, 'A', new Set(['future_media']));
  t.false(text.includes(png));
  t.regex(text, /cannot see the image/);
  t.regex(text, /look/);
});

test.serial('B5: read_notes switch prevents view_image execution before binary I/O', async t => {
  const f = fixture({ disabled_tools: applyPermissionSwitch([], 'read_notes', false) });
  const result: any = await f.call('view_image', { path: 'in/a.png' });
  t.true(result.isError);
  t.regex(result.error, /disabled/);
  t.deepEqual(f.calls, []);
});

for (const mode of ['move', 'copy']) test.serial(`A2: ${mode} rechecks missing-parent permissions after approval`, async t => {
  const f = fixture({ disabled_tools: applyPermissionSwitch([], 'create_files', false) });
  f.files.set('out', { path: 'out', children: [] });
  f.manager.setApprovalHandler(async () => { f.files.delete('out'); return 'approve'; });
  const result: any = await f.call('move', { from: 'in/a.png', to: 'out/b.png', mode }, { autonomy: 'edge' });
  t.true(result.isError);
  t.regex(result.error, /disabled/);
  t.deepEqual(f.calls, []);
  t.true(f.files.has('in/a.png'));
});

test('C2: both new tools classify the sub-agent in the vault category', async t => {
  const { deriveDelegateCategory } = await import('./modules/crystal-soul/category_colors.js');
  t.is(deriveDelegateCategory(['view_image']), 'vault');
  t.is(deriveDelegateCategory(['move']), 'vault');
});
