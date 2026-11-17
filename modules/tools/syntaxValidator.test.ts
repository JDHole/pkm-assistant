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
    t.like(await createCheckSyntaxTool().execute({ path: 'x.txt' }, app, {}), { ok: false, error: 'Supported extensions: .js, .mjs, .cjs, .json, .yaml, .yml, .md.' });
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
