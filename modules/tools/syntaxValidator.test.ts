import { build } from 'esbuild';
import { parse } from 'acorn';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'ava';
import { MCPClient } from './MCPClient.js';
import { ToolRegistry } from './ToolRegistry.js';
import { AccessGuard, PermissionSystem } from '../../core/index.js';
import { checkSyntax } from './syntaxValidator.js';
import { createCheckSyntaxTool, registerCheckSyntaxTool } from './CheckSyntaxTool.js';

test('JavaScript: script, module and async function body', t => {
    t.like(checkSyntax('const x = 1;', 'js'), { ok: true, mode: 'async_function' });
    t.like(checkSyntax('export const x = 1;', 'js'), { ok: true, mode: 'module' });
    t.like(checkSyntax('await work(); return 1;', 'js'), { ok: true, mode: 'async_function' });
    t.like(checkSyntax('const x = 1;\nconst y = ;', 'js'), { ok: false, problems: [{ line: 2, column: 11, type: 'syntax' }] });
});

test('JSON reports nested duplicates and syntax errors', t => {
    t.like(checkSyntax('{"outer": {\n"x": 1,\n"x": 2}}', 'json'), { ok: false, problems: [{ line: 3, column: 1, firstLine: 2, path: 'outer.x', type: 'duplicate_key' }] });
    t.like(checkSyntax('{"x": }', 'json'), { ok: false, problems: [{ line: 1, column: 7, type: 'syntax' }] });
});


test('tool reads without executing code and rejects unsupported files', async t => {
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => 'globalThis.__syntaxSideEffect = 1;' } } };
    const result = await createCheckSyntaxTool().execute({ path: 'x.js' }, app, {});
    t.like(result, { ok: true, kind: 'js', mode: 'async_function' });
    t.false(Object.hasOwn(globalThis, '__syntaxSideEffect'));
    t.like(await createCheckSyntaxTool().execute({ path: 'x.txt' }, app, {}), { success: false, error: 'Unsupported file kind. Supported extensions: .js, .mjs, .cjs, .json.' });
});

test('MCP refuses a No-Go file before reading it', async t => {
    AccessGuard.setNoGoFolders(['Private']);
    try {
        let reads = 0;
        const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => { reads++; return '{}'; } } } };
        const agent = { name: 'Tester', mcp_servers: ['*'], permissions: { guidance_mode: true } };
        const registry = new ToolRegistry(); registry.registerTool(createCheckSyntaxTool());
        const client = new MCPClient(app as never, { agentManager: { getAgent: () => agent, getActiveAgent: () => agent }, permissionSystem: new PermissionSystem(app.vault as never, {}) } as never, registry);
        const result = await client.executeToolCall({ name: 'check_syntax', arguments: { path: 'Private/secret.json' } }, 'Tester', { autonomy: 'yolo' });
        t.like(result, { isError: true });
        t.is(reads, 0);
    } finally { AccessGuard.setNoGoFolders([]); }
});


test('JSON diagnostics, depth, decoded duplicate names and CRLF positions', t => {
    t.like(checkSyntax('{"a":1,"\\u0061":2}', 'json'), { ok: false, problems: [{ type: 'duplicate_key', path: 'a', firstLine: 1 }] });
    t.like(checkSyntax('\r\n'.repeat(9) + '"bad\n"', 'json'), { problems: [{ line: 10, column: 5, message: 'Control character in string' }] });
    t.like(checkSyntax('"\\q"', 'json'), { problems: [{ line: 1, column: 3, message: 'Invalid escape' }] });
    t.like(checkSyntax('[1,]', 'json'), { problems: [{ message: 'Trailing comma' }] });
    t.like(checkSyntax('['.repeat(257) + '0' + ']'.repeat(257), 'json'), { problems: [{ message: 'JSON nesting depth limit exceeded', type: 'limit' }] });
    t.like(checkSyntax(' '.repeat(2097153), 'json'), { problems: [{ message: 'Input exceeds 2 MiB JSON limit', type: 'limit' }] });
});

test('large JSON remains responsive', t => {
    const input = '{' + Array.from({ length: 80000 }, (_, i) => `"key${i}":${i}`).join(',') + '}';
    const start = performance.now();
    t.true(checkSyntax(input, 'json').ok);
    t.true(performance.now() - start < 5000);
});

test('JS rejects wrapper escape, chooses furthest error and accepts hashbang', t => {
    t.false(checkSyntax('return 1;\n}\nasync function other(){', 'js').ok);
    t.like(checkSyntax('export const one=1;\nexport const two=2;\nexport const bad=;', 'js'), { problems: [{ line: 3, column: 18 }] });
    t.true(checkSyntax('\ufeff#!/usr/bin/env node\nreturn 1;', 'js').ok);
});



test('tool failure and syntax results have distinct status', async t => {
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async (path: string) => { if (path === 'missing.js') throw new Error('missing'); return 'const a = ;'; } } } };
    t.like(await createCheckSyntaxTool().execute({ path: 'missing.js' }, app, {}), { success: false, error: 'File not found: missing.js' });
    t.like(await createCheckSyntaxTool().execute({ path: 'bad.js' }, app, {}), { success: true, ok: false, problems: [{ line: 1, column: 11 }] });
});

test('tool stops between pages and refuses an oversized source after one read', async t => {
    let reads = 0;
    let source = ' '.repeat(30000);
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => { reads++; return source; } } } };
    const context = { resultBudgetChars: 12000, effectiveResultBudgetChars: 12000, shouldAbort: () => reads > 0, authorizeFileRead: () => ({ allowed: true }), serializeFinalResult: JSON.stringify };
    t.like(await createCheckSyntaxTool().execute({ path: 'a.json' }, app, {}, context), { success: false, error: 'Operation cancelled' });
    t.is(reads, 1);
    reads = 0; source = ' '.repeat(2097153);
    const noAbort = { ...context, shouldAbort: () => false };
    t.like(await createCheckSyntaxTool().execute({ path: 'a.json' }, app, {}, noAbort), { success: false, error: 'Input exceeds 2 MiB JSON limit' });
    t.is(reads, 1);
});


test('regressions: parser boundaries and bounded diagnostics', t => {
    t.like(checkSyntax('var await = 1; return 2;', 'js'), { ok: false, problems: [{ line: 1, column: 5, message: "Cannot use 'await' as identifier inside an async function" }] });
    t.true(checkSyntax('return new.target;', 'js').ok);
    const key = 'x'.repeat(170000);
    const result = checkSyntax(`{"${key}":1,"${key}":2}`, 'json');
    t.like(result, { ok: false, problems: [{ path_truncated: true }] });
    t.true(JSON.stringify(result).length < 16000);
});

test('tool checks metadata before reading and Stop interrupts a pending read', async t => {
    let reads = 0;
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: {
        stat: async () => ({ size: 10 * 1024 * 1024 }), read: async () => { reads++; return '{}'; },
    } } };
    t.like(await createCheckSyntaxTool().execute({ path: 'large.json' }, app, {}), { success: false, error: 'Input exceeds 2 MiB JSON limit' });
    t.is(reads, 0);
    const controller = new AbortController();
    let rejectRead: (reason: Error) => void = () => {};
    const pendingApp = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: {
        read: () => new Promise<string>((_resolve, reject) => { rejectRead = reject; }),
    } } };
    const task = createCheckSyntaxTool().execute({ path: 'a.json' }, pendingApp, {}, { abortSignal: controller.signal, authorizeFileRead: () => ({ allowed: true }) } as never);
    await Promise.resolve(); controller.abort();
    t.like(await task, { success: false, error: 'Operation cancelled' });
    rejectRead(new Error('late failure'));
});







test('deep JavaScript is accepted or reported as a limit', t => {
    const result = checkSyntax('('.repeat(1000) + '1' + ')'.repeat(1000) + ';', 'js');
    t.true(result.ok || result.problems.some(p => p.type === 'limit'));
    t.false(result.problems.some(p => p.type === 'syntax'));
});

test('unsupported extensions including inherited object keys are rejected', async t => {
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => { throw new Error('unexpected read'); } } } };
    for (const ext of ['md', 'yaml', 'yml', 'constructor', '__proto__', 'toString']) {
        t.like(await createCheckSyntaxTool().execute({ path: `x.${ext}` }, app, {}), { success: false, error: 'Unsupported file kind. Supported extensions: .js, .mjs, .cjs, .json.' });
    }
    t.like(await createCheckSyntaxTool().execute({ path: 'x.md', kind: 'js' }, app, {}), { success: false, error: 'Unsupported file kind. Supported extensions: .js, .mjs, .cjs, .json.' });
});

test('Stop interrupts pending metadata', async t => {
    const controller = new AbortController();
    let rejectStat: (error: Error) => void = () => {};
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { stat: () => new Promise<{ size: number }>((_, reject) => { rejectStat = reject; }), read: async () => '{}' } } };
    const task = createCheckSyntaxTool().execute({ path: 'a.json' }, app, {}, { abortSignal: controller.signal, authorizeFileRead: () => ({ allowed: true }) } as never);
    controller.abort();
    t.like(await task, { success: false, error: 'Operation cancelled' });
    rejectStat(new Error('late failure'));
});

test('browser bundle works without Node globals', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'syntax-browser-'));
    try {
        const outfile = join(dir, 'validator.js');
        await build({ entryPoints: ['modules/tools/syntaxValidator.ts'], outfile, bundle: true, platform: 'browser', format: 'iife', globalName: 'SyntaxValidator', logLevel: 'silent' });
        const code = await readFile(outfile, 'utf8');
        t.false(/\brequire\s*\(/.test(code));
        t.false(/\bprocess\s*\./.test(code));
        t.false(/\bBuffer\b/.test(code));
        const results: boolean[] = runInNewContext(`${code}\n[SyntaxValidator.checkSyntax('const x = 1;', 'js').ok, SyntaxValidator.checkSyntax('const x = ;', 'js').ok, SyntaxValidator.checkSyntax('{"x":1}', 'json').ok, SyntaxValidator.checkSyntax('{"x":}', 'json').ok]`, {});
        t.deepEqual(Array.from(results), [true, false, true, false]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('default registration exposes the tool to the agent and executes it', async t => {
    const registry = new ToolRegistry();
    registry.registerTool({ name: 'read', description: 'Read', inputSchema: {}, execute: async () => ({ success: true }) });
    registerCheckSyntaxTool(registry);
    t.deepEqual(registry.filterByAgent({ mcp_servers: ['*'] }).map(tool => tool.name), ['read', 'check_syntax']);
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => '{}' } } };
    const agent = { name: 'Tester', mcp_servers: ['*'], permissions: { guidance_mode: true } };
    const client = new MCPClient(app as never, { agentManager: { getAgent: () => agent, getActiveAgent: () => agent }, permissionSystem: new PermissionSystem(app.vault as never, {}) } as never, registry);
    const response = await client.executeToolCall({ name: 'check_syntax', arguments: { path: 'x.json' } }, 'Tester', { autonomy: 'yolo' });
    t.true(JSON.stringify(response).includes('"ok":true'));
});

test('near limit JS parses once and cancellation prevents parsing', t => {
    let calls = 0;
    const counted: typeof parse = (...args) => { calls++; return parse(...args); };
    const input = '0;'.repeat(262139) + 'return;';
    const start = performance.now();
    t.like(checkSyntax(input, 'js', { parse: counted }), { ok: true, mode: 'async_function' });
    t.is(calls, 1);
    t.true(performance.now() - start < 3000);
    calls = 0;
    t.throws(() => checkSyntax(input, 'js', { parse: counted, shouldAbort: () => true }), { message: 'Operation cancelled' });
    t.is(calls, 0);
});

test('Stop between JS modes prevents another parser call', t => {
    let calls = 0;
    const counted: typeof parse = (...args) => { calls++; return parse(...args); };
    t.throws(() => checkSyntax('export const x = 1;', 'js', { parse: counted, shouldAbort: () => calls === 1 }), { message: 'Operation cancelled' });
    t.is(calls, 1);
});

test('JS metadata limit rejects before reading while JSON permits the same size', async t => {
    let reads = 0;
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: {
        stat: async () => ({ size: 512 * 1024 + 1 }), read: async () => { reads++; return '{}'; },
    } } };
    t.like(await createCheckSyntaxTool().execute({ path: 'large.js' }, app, {}), { success: false, error: 'Input exceeds 512 KiB JS limit' });
    t.is(reads, 0);
    t.like(await createCheckSyntaxTool().execute({ path: 'large.json' }, app, {}), { success: true, ok: true });
    t.is(reads, 1);
});

test('rejects an unsupported syntax kind', t => {
    t.like(checkSyntax('MARKER_A: [', 'yaml' as never), { ok: false, kind: 'yaml', problems: [{ line: 1, column: 1, type: 'limit', message: 'Unsupported syntax kind' }], truncated: false });
});
