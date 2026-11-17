import test from 'ava';
import { MCPClient } from './MCPClient.js';
import { ToolRegistry } from './ToolRegistry.js';
import { AccessGuard, PermissionSystem } from '../../core/index.js';
import { checkSyntax } from './syntaxValidator.js';
import { createCheckSyntaxTool } from './CheckSyntaxTool.js';

test('JavaScript: script, module and async function body', t => {
    t.like(checkSyntax('const x = 1;', 'js'), { ok: true, mode: 'script' });
    t.like(checkSyntax('export const x = 1;', 'js'), { ok: true, mode: 'module' });
    t.like(checkSyntax('await work(); return 1;', 'js'), { ok: true, mode: 'async_function' });
    t.like(checkSyntax('const x = 1;\nconst y = ;', 'js'), { ok: false, problems: [{ line: 2, column: 11, type: 'syntax' }] });
});

test('JSON and YAML report nested duplicates and syntax errors', t => {
    t.like(checkSyntax('{"outer": {\n"x": 1,\n"x": 2}}', 'json'), { ok: false, problems: [{ line: 3, column: 1, firstLine: 2, path: 'outer.x', type: 'duplicate_key' }] });
    t.like(checkSyntax('{"x": }', 'json'), { ok: false, problems: [{ line: 1, column: 7, type: 'syntax' }] });
    t.like(checkSyntax('outer:\n  x: 1\n  x: 2', 'yaml'), { ok: false, problems: [{ line: 3, column: 3, firstLine: 2, path: 'outer.x', type: 'duplicate_key' }] });
    t.is(checkSyntax('1: a\n"1": b', 'yaml').ok, true);
    t.like(checkSyntax('? [a, b]\n: 1\n? [a, b]\n: 2', 'yaml'), { ok: false, problems: [{ type: 'duplicate_key', firstLine: 1, line: 3 }] });
    t.like(checkSyntax('a:\n  x: 1\n y: 2', 'yaml'), { ok: false, problems: [{ type: 'syntax' }] });
});

test('Markdown locations include the full file', t => {
    const input = '---\na: 1\na: 2\n---\n```dataviewjs\nreturn 1;\n```\n```dataviewjs\nconst x = ;\n```';
    t.like(checkSyntax(input, 'markdown'), { ok: false, problems: [{ line: 3, column: 1, firstLine: 2, path: 'a' }, { line: 9, column: 11, type: 'syntax' }] });
});

test('tool reads without executing code and rejects unsupported files', async t => {
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => 'globalThis.__syntaxSideEffect = 1;' } } };
    const result = await createCheckSyntaxTool().execute({ path: 'x.js' }, app, {});
    t.like(result, { ok: true, kind: 'js', mode: 'script' });
    t.false(Object.hasOwn(globalThis, '__syntaxSideEffect'));
    t.like(await createCheckSyntaxTool().execute({ path: 'x.txt' }, app, {}), { success: false, error: 'Supported extensions: .js, .mjs, .cjs, .json, .yaml, .yml, .md.' });
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
    t.like(checkSyntax(' '.repeat(2097153), 'json'), { problems: [{ message: 'Input exceeds 2 MB limit', type: 'limit' }] });
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

test('YAML aliases, multiple documents and merge keys', t => {
    t.like(checkSyntax('one: 1\n---\nkey: *missing', 'yaml'), { problems: [{ line: 3, column: 6, message: 'Unresolved alias' }] });
    t.true(checkSyntax('base: &base {x: 1}\nobj:\n  <<: *base\n  <<: *base', 'yaml').ok);
});

test('Markdown validates container fences and unclosed fences with original columns', t => {
    t.like(checkSyntax('- item\n    ```js\n    const a = ;\n    ```\n> > ~~~javascript\n> > const b = ;\n> > ~~~', 'markdown'), { problems: [{ line: 3, column: 15 }, { line: 6, column: 15 }] });
    t.like(checkSyntax('```js\nconst a = ;', 'markdown'), { problems: [{ line: 2, column: 11 }, { line: 1, message: 'Unclosed code block' }] });
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
    t.like(await createCheckSyntaxTool().execute({ path: 'a.json' }, app, {}, noAbort), { success: false, error: 'Input exceeds 2 MB limit' });
    t.is(reads, 1);
});
